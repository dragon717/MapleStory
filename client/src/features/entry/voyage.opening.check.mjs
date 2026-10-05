// Offline browser check for the staged opening and the independent voyage
// model lifecycles. The caller must have installed the normal view.check
// `http://entry.test/**` fixture route before invoking this module. Asset
// routes below use fallback() so the fixture remains the single file source;
// the malformed-city branch reads that same source path to avoid bypassing the
// in-memory entry.test route while rebuilding the GLB.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const ASSET_PATHS = {
  ship: '/assets/entry/sky-voyage.glb',
  city: '/assets/entry/sky-city.glb',
  book: '/assets/entry/voyage-book.glb',
};
const CITY_FIXTURE_PATH = path.resolve(import.meta.dirname, '../../../..', 'resources/scenes/sky-voyage-v3/prototypes/sky-city-spatial-prototype.glb');

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitUntil(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function emptyAssetState() {
  return { requests: 0, started: [], finished: [], failures: 0, mutations: 0 };
}

/**
 * Keep a real GLB parseable while making the city runtime metadata invalid.
 * The loader receives the same binary chunk and every JSON field except the
 * scene-level spatial layout; only the GLB header/chunk lengths and JSON
 * padding change to account for the replacement.
 */
function corruptCitySpatialLayout(body) {
  const source = Buffer.from(body);
  assert.equal(source.toString('ascii', 0, 4), 'glTF', 'city fixture must be a GLB');
  assert.equal(source.readUInt32LE(4), 2, 'city fixture must use GLB 2');
  const chunks = [];
  let offset = 12;
  while (offset < source.length) {
    assert(offset + 8 <= source.length, 'GLB chunk header is complete');
    const length = source.readUInt32LE(offset);
    const type = source.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    assert(end <= source.length, 'GLB chunk payload is complete');
    chunks.push({ type, payload: source.subarray(offset + 8, end) });
    offset = end;
  }
  const json = chunks.find(chunk => chunk.type === 0x4e4f534a);
  assert(json, 'city fixture has a JSON chunk');
  const document = JSON.parse(Buffer.from(json.payload).toString('utf8').trim());
  const scene = document.scenes?.[document.scene ?? 0];
  assert.equal(typeof scene?.extras?.spatial_layout, 'string', 'city scene carries spatial_layout metadata');
  scene.extras.spatial_layout = '{"invalid":';
  const encoded = Buffer.from(JSON.stringify(document), 'utf8');
  const paddedLength = Math.ceil(encoded.length / 4) * 4;
  const padded = Buffer.alloc(paddedLength, 0x20);
  encoded.copy(padded);
  json.payload = padded;

  const totalLength = 12 + chunks.reduce((sum, chunk) => sum + 8 + chunk.payload.length, 0);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);
  const encodedChunks = chunks.map(chunk => {
    const chunkHeader = Buffer.alloc(8);
    chunkHeader.writeUInt32LE(chunk.payload.length, 0);
    chunkHeader.writeUInt32LE(chunk.type, 4);
    return Buffer.concat([chunkHeader, chunk.payload]);
  });
  return Buffer.concat([header, ...encodedChunks]);
}

function createAssetGate(config = {}) {
  const state = { ship: emptyAssetState(), city: emptyAssetState(), book: emptyAssetState() };
  const handlers = [];
  const pending = { ship: [], city: [], book: [] };
  const held = new Set(Array.isArray(config.hold) ? config.hold : config.hold ? [config.hold] : []);
  const released = new Set();
  const failures = new Set(Array.isArray(config.fail) ? config.fail : config.fail ? [config.fail] : []);
  const corruptions = new Set(Array.isArray(config.corrupt) ? config.corrupt : config.corrupt ? [config.corrupt] : []);
  const release = kind => {
    released.add(kind);
    for (const resolve of pending[kind] ?? []) resolve();
    pending[kind]?.splice(0);
  };
  return { state, handlers, held, pending, released, failures, corruptions, release };
}

async function installAssetGate(page, config, run) {
  const gate = createAssetGate(config);
  for (const [kind, pathname] of Object.entries(ASSET_PATHS)) {
    // A RegExp keeps the test independent of the fixture host and tolerates a
    // cache-busting query if the production loader adds one later.
    const matcher = new RegExp(`${pathname.replaceAll('/', '\\/')}(?:\\?.*)?$`);
    const handler = async route => {
      const item = gate.state[kind];
      item.requests++;
      item.started.push(Date.now());
      try {
        if (gate.held.has(kind) && !gate.released.has(kind)) await new Promise(resolve => gate.pending[kind].push(resolve));
        if (gate.failures.has(kind)) {
          item.failures++;
          await route.fulfill({ status: 503, contentType: 'text/plain', body: `forced ${kind} failure` });
        } else if (gate.corruptions.has(kind)) {
          const body = await fs.readFile(CITY_FIXTURE_PATH);
          const mutated = kind === 'city' ? corruptCitySpatialLayout(body) : body;
          item.mutations++;
          await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: mutated });
        } else {
          // The existing view.check route reads the real source fixture and
          // fulfills it. Fallback preserves that one implementation.
          await route.fallback();
        }
      } finally {
        item.finished.push(Date.now());
      }
    };
    await page.route(matcher, handler);
    gate.handlers.push({ matcher, handler });
  }
  try {
    return await run(gate);
  } finally {
    for (const kind of Object.keys(ASSET_PATHS)) gate.release(kind);
    for (const { matcher, handler } of gate.handlers) await page.unroute(matcher, handler);
  }
}

async function reloadEntry(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#welcome.entry-voyage').waitFor({ state: 'attached', timeout: 30000 });
}

async function browserSnapshot(page, refreshFrame = false) {
  return page.evaluate(refreshFrame => {
    const host = document.querySelector('#welcome');
    const entry = window.__entry;
    const voyage = entry?.voyage;
    const visibleNode = node => {
      if (!node) return false;
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && box.width > 0 && box.height > 0;
    };
    const visible = selector => visibleNode(document.querySelector(selector));
    let frame = { width: 0, height: 0, nonBlack: 0, distinct: 0 };
    const canvas = voyage?.canvas;
    const renderer = voyage?.renderer;
    if (refreshFrame && canvas && renderer && canvas.width > 0 && canvas.height > 0) {
      const gl = renderer.getContext();
      // WebGL's default framebuffer is commonly discarded after the browser
      // presents it. Render the real cloud composite and sample immediately
      // in this same evaluate call; do not enable preserveDrawingBuffer just
      // for a test (that would impose a production performance cost). The
      // local check uses a small drawing buffer because SwiftShader can take
      // minutes for the full 1440px cloud composite; the screenshot above is
      // still captured at the real viewport size.
      const cssSize = new window.__three.Vector2();
      renderer.getSize(cssSize);
      const pixelRatio = renderer.getPixelRatio();
      renderer.setPixelRatio(1);
      renderer.setSize(Math.min(320, Math.max(1, cssSize.x)), Math.min(200, Math.max(1, cssSize.y)), false);
      try {
        const width = canvas.width, height = canvas.height;
        renderer.setRenderTarget(null);
        voyage.camera.updateMatrixWorld(true);
        voyage.scene.updateMatrixWorld(true, true);
        voyage.clouds.resize(width, height);
        voyage.clouds.render(renderer, voyage.scene, voyage.camera, voyage.sun, voyage.cabinShown ? voyage.windowLight : undefined);
        const pixels = [];
        const colors = new Set();
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          const pixel = new Uint8Array(4);
          gl.readPixels(Math.min(width - 1, Math.floor((x + .5) * width / 8)), Math.min(height - 1, Math.floor((y + .5) * height / 8)), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          pixels.push(pixel);
          colors.add(`${pixel[0]},${pixel[1]},${pixel[2]}`);
        }
        frame = {
          width,
          height,
          nonBlack: pixels.filter(pixel => pixel[0] + pixel[1] + pixel[2] > 18).length,
          distinct: colors.size,
        };
      } finally {
        renderer.setPixelRatio(pixelRatio);
        renderer.setSize(cssSize.x, cssSize.y, false);
        const restored = new window.__three.Vector2();
        renderer.getDrawingBufferSize(restored);
        voyage.clouds.resize(restored.x, restored.y);
      }
    }
    const sceneChildren = voyage?.scene?.children?.map(child => ({ id: child.id, name: child.name })) ?? [];
    return {
      ready: Boolean(host?.classList.contains('entry-voyage-ready')),
      unavailable: Boolean(host?.classList.contains('voyage-unavailable')),
      hostClass: host?.className ?? '',
      voyage: Boolean(voyage),
      alive: voyage?.alive,
      model: Boolean(voyage?.model),
      ship: Boolean(voyage?.ship),
      city: Boolean(voyage?.city),
      cityVisible: voyage?.city?.root?.visible,
      canvas: Boolean(canvas && canvas.isConnected),
      frame,
      sceneChildren,
      hud: {
        brand: visible('.entry-brand'),
        credit: visible('.entry-edition'),
        tools: visible('.entry-top-tools'),
        navigation: visible('.entry-navigation'),
        scene: visible('.entry-scene'),
        login: visible('#login'),
        paper: visible('.entry-scene .entry-glass'),
        begin: visible('[data-action="begin-voyage"]'),
        toolButtons: [...document.querySelectorAll('.entry-top-tools button')].map(button => {
          const style = getComputedStyle(button);
          return { visible: visibleNode(button), borderImageSource: style.borderImageSource, borderStyle: style.borderStyle };
        }),
      },
    };
  }, refreshFrame);
}

async function waitForVoyage(page, predicate, label = 'voyage', timeout = 60000) {
  await page.waitForFunction(predicate, undefined, { timeout });
  return browserSnapshot(page).then(snapshot => ({ label, snapshot }));
}

async function renderAndCapture(page, file) {
  await page.waitForTimeout(120);
  await page.screenshot({ path: file });
}

async function assertButtonStyle(page) {
  const style = await page.evaluate(() => {
    const button = document.querySelector('[data-action="begin-voyage"]');
    if (!button) return undefined;
    const computed = getComputedStyle(button);
    return {
      borderImageSource: computed.borderImageSource,
      borderStyle: computed.borderStyle,
      color: computed.color,
      backgroundImage: computed.backgroundImage,
      display: computed.display,
    };
  });
  assert(style, 'the opening gesture button remains in the DOM for the gesture policy');
  assert.equal(style.borderImageSource, 'none', 'opening gesture button must not use the parchment border image');
  const color = style.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  assert(color, `opening gesture button exposes a parseable text color: ${style.color}`);
  const luminance = Number(color[1]) * .299 + Number(color[2]) * .587 + Number(color[3]) * .114;
  assert(luminance < 180, `opening gesture button text is dark enough on the sky: ${style.color}`);
  return style;
}

/**
 * Exercise the opening before the caller's normal ready wait. The normal
 * view.check fixture route must already be installed. This intentionally uses
 * the real EntryView/EntryVoyage and the real GLTF parser; no fake model or
 * mirrored loader is inserted into the page.
 */
export async function checkVoyageOpening(page, output, errors = []) {
  await fs.mkdir(output, { recursive: true });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const evidence = { passed: false, scenarios: {}, errors };

  // The button style is a static contract, so check it on the first document
  // even when autoplay succeeds and the button is hidden by the opening state.
  await reloadEntry(page);
  evidence.gestureButton = await assertButtonStyle(page);

  evidence.scenarios.delayedShip = await installAssetGate(page, { hold: ['ship'] }, async gate => {
    await reloadEntry(page);
    await waitUntil(() => gate.state.ship.requests > 0, 'the delayed ship request');
    await waitForVoyage(page, () => Boolean(window.__entry?.voyage?.canvas), 'the sky voyage before its ship GLB');
    await renderAndCapture(page, path.join(output, 'opening-delayed-ship.png'));
    const before = await browserSnapshot(page, true);
    assert(before.voyage, 'EntryVoyage exists while the ship GLB is still pending');
    assert.equal(before.ready, false, 'entry-voyage-ready stays false before the ship model is ready');
    assert(before.canvas && before.frame.nonBlack > 0 && before.frame.distinct > 1, `the delayed opening paints the sky/cloud frame: ${JSON.stringify(before.frame)}`);
    assert.equal(before.hud.brand, false, 'brand stays hidden before the ship model is ready');
    assert.equal(before.hud.credit, false, 'credit stays hidden before the ship model is ready');
    assert.equal(before.hud.tools, true, 'skip/music tools remain available while the ship model is pending');
    assert(before.hud.toolButtons.length >= 1 && before.hud.toolButtons.every(button => button.visible && button.borderImageSource === 'none'), 'skip/music tools remain visible without a parchment button frame');
    assert.equal(before.hud.navigation, false, 'navigation stays hidden before the ship model is ready');
    assert.equal(before.hud.paper, false, 'the login paper stays hidden before the ship model is ready');
    gate.release('ship');
    await waitUntil(() => gate.state.ship.finished.length > 0, 'the delayed ship response', 10000);
    await waitForVoyage(page, () => Boolean(window.__entry?.voyage?.model && window.__entry?.voyage?.ship), 'the parsed ship model');
    return { request: gate.state.ship, before };
  });

  evidence.scenarios.shipBeforeCity = await installAssetGate(page, { hold: ['city', 'book'] }, async gate => {
    await reloadEntry(page);
    await waitUntil(() => gate.state.ship.finished.length > 0, 'the ship response before city/book');
    await waitForVoyage(page, () => Boolean(window.__entry?.voyage?.model && window.__entry?.voyage?.ship), 'the ship while city/book are delayed');
    await waitUntil(() => gate.state.city.requests > 0 && gate.state.book.requests > 0, 'the held city/book requests');
    const before = await browserSnapshot(page);
    assert(before.model && before.ship, 'the ship becomes usable independently of the delayed city/book results');
    assert.equal(before.city, false, 'city is not attached before its delayed GLB completes');
    assert.equal(gate.state.city.finished.length, 0, 'city response is still pending while the ship is usable');
    assert.equal(gate.state.book.finished.length, 0, 'book response is still pending while the ship is usable');

    const start = await page.evaluate(() => {
      const voyage = window.__entry.voyage;
      voyage.setShipTrial(true);
      voyage.setShipControls({ sail: 1, wind: 8, throttle: 1, steering: 0 });
      const initial = voyage.flight.position.toArray();
      // Advance the real flight integrator directly for a bounded, deterministic
      // browser assertion. The RAF/render path is exercised by the screenshot
      // below, while this avoids making the check depend on GPU frame cadence.
      for (let index = 0; index < 20; index++) voyage.flight.update(.05);
      voyage.updateActivity();
      return { ship: voyage.ship.position.toArray(), initial, flight: voyage.flight.position.toArray(), trial: voyage.flight.trial };
    });
    assert.equal(start.trial, true, `ship trial is available on the independently loaded ship: ${JSON.stringify(start)}`);
    assert(Math.hypot(start.flight[0] - start.initial[0], start.flight[2] - start.initial[2]) > .04, `ship flight advances while city is held: ${JSON.stringify(start)}`);
    const moving = await browserSnapshot(page);
    assert(moving.ship && moving.model, 'the independent ship keeps rendering while city is pending');
    await renderAndCapture(page, path.join(output, 'opening-ship-before-city.png'));

    gate.release('city');
    gate.release('book');
    await waitUntil(() => gate.state.city.finished.length > 0 && gate.state.book.finished.length > 0, 'the released city/book responses', 10000);
    await waitForVoyage(page, () => Boolean(window.__entry?.voyage?.city?.root), 'the late city root');
    const after = await browserSnapshot(page);
    assert.equal(after.cityVisible, true, 'late city follows the current exterior/login visibility state');
    return { ship: gate.state.ship, city: gate.state.city, book: gate.state.book, before, moving, after };
  });

  evidence.scenarios.cityFailure = await installAssetGate(page, { fail: 'city' }, async gate => {
    await reloadEntry(page);
    await waitUntil(() => gate.state.city.failures > 0, 'the forced city failure');
    await waitForVoyage(page, () => Boolean(window.__entry?.voyage?.model && window.__entry?.voyage?.ship), 'the ship after city failure');
    const state = await browserSnapshot(page);
    assert(state.model && state.ship, 'city failure leaves the independently loaded ship available');
    assert.equal(state.unavailable, false, 'city failure does not mark the whole entry voyage unavailable');
    assert.equal(state.alive, true, 'city failure does not destroy the ship renderer');
    assert(state.canvas, 'the ship canvas remains attached after city failure');
    await renderAndCapture(page, path.join(output, 'opening-city-failure-ship.png'));
    return { city: gate.state.city, state };
  });

  evidence.scenarios.shipFailureFallback = await installAssetGate(page, { fail: 'ship', hold: ['city', 'book'] }, async gate => {
    await reloadEntry(page);
    // The secondary assets are intentionally held while the ship returns a
    // real HTTP 503. Their late arrivals must be harmless after EntryVoyage
    // destroys itself and EntryView re-renders the HTML fallback.
    await waitUntil(() => gate.state.ship.failures > 0, 'the forced ship failure');
    await waitUntil(() => gate.state.city.requests > 0 && gate.state.book.requests > 0, 'the secondary requests behind the failed ship');
    await waitForVoyage(page, () => Boolean(document.querySelector('#welcome.voyage-unavailable') && !window.__entry?.voyage?.canvas?.isConnected), 'the visible ship-failure fallback');

    const failed = await browserSnapshot(page);
    assert.equal(failed.unavailable, true, 'a 503 ship response exposes the HTML fallback state');
    assert.equal(failed.alive, false, 'the failed EntryVoyage is dead before fallback interaction');
    assert.equal(failed.canvas, false, 'the failed EntryVoyage canvas is removed before fallback interaction');
    assert.equal(failed.hud.login, true, 'the login fallback is visible after ship failure');
    const fallbackStyle = await page.locator('.entry-background').evaluate(node => {
      const style = getComputedStyle(node);
      return { display: style.display, visibility: style.visibility, backgroundImage: style.backgroundImage };
    });
    assert.notEqual(fallbackStyle.display, 'none', 'the sky fallback background remains displayed after ship failure');
    assert.notEqual(fallbackStyle.visibility, 'hidden', 'the sky fallback background remains visible after ship failure');
    assert(fallbackStyle.backgroundImage.includes('gradient'), `fallback background remains a sky gradient: ${fallbackStyle.backgroundImage}`);
    assert(await page.locator('#username').isVisible(), 'the fallback login input is visible');

    // Registration toggles through EntryView.render(), the path that used to
    // append a disposed voyage canvas back into the new background element.
    await page.locator('#mode').click();
    await page.locator('#username').fill('fallback_input');
    const rerendered = await browserSnapshot(page);
    assert.equal(rerendered.alive, false, 'EntryView.render keeps the failed voyage dead');
    assert.equal(rerendered.canvas, false, 'EntryView.render does not reattach the disposed voyage canvas');
    assert.equal(rerendered.hud.login, true, 'the registration fallback remains visible after EntryView.render');
    assert.equal(await page.locator('#username').inputValue(), 'fallback_input', 'the fallback input accepts user input after the render');

    // Help is another bound fallback action. Exercise it before releasing the
    // held real GLBs so the late resources cannot mask a stale-canvas bug.
    await page.locator('[data-action="help"]').click();
    await page.waitForFunction(() => {
      const notice = document.querySelector('.entry-notice');
      return Boolean(notice && !notice.hidden && notice.textContent);
    });
    const afterHelp = await browserSnapshot(page);
    assert.equal(afterHelp.canvas, false, 'help interaction still leaves no disposed voyage canvas');

    gate.release('city');
    gate.release('book');
    await waitUntil(() => gate.state.city.finished.length > 0 && gate.state.book.finished.length > 0, 'late city/book responses after ship failure', 15000);
    await sleep(180);
    const afterLateAssets = await browserSnapshot(page);
    assert.equal(afterLateAssets.alive, false, 'late city/book arrivals do not revive the failed voyage');
    assert.equal(afterLateAssets.canvas, false, 'late city/book arrivals do not reattach a canvas');
    assert.equal(afterLateAssets.city, false, 'late city/book arrivals do not attach a city to the failed voyage');
    assert.equal(afterLateAssets.unavailable, true, 'the HTML fallback remains the unavailable state after late assets');
    assert.equal(afterLateAssets.hud.login, true, 'the HTML fallback remains usable after late assets');
    return { ship: gate.state.ship, city: gate.state.city, book: gate.state.book, failed, fallbackStyle, rerendered, afterHelp, afterLateAssets };
  });

  evidence.scenarios.invalidCityLayout = await installAssetGate(page, { hold: ['city'], corrupt: 'city' }, async gate => {
    await reloadEntry(page);
    await waitUntil(() => gate.state.city.requests > 0, 'the held city request for invalid metadata');
    await waitForVoyage(page, () => Boolean(window.__entry?.voyage?.model && window.__entry?.voyage?.ship), 'the ship before invalid city metadata');
    const before = await browserSnapshot(page);
    const warnings = [];
    const onConsole = message => {
      if (message.type() === 'warning' && message.text().includes('Voyage sky city unavailable')) warnings.push(message.text());
    };
    page.on('console', onConsole);
    try {
      gate.release('city');
      await waitUntil(() => gate.state.city.finished.length > 0, 'the malformed city response', 15000);
      await waitUntil(() => warnings.length > 0, 'the malformed city initialization warning', 15000);
    } finally {
      page.off('console', onConsole);
    }
    const after = await browserSnapshot(page);
    assert.equal(gate.state.city.mutations, 1, 'the city response was a real parseable GLB with only spatial_layout corrupted');
    assert(after.model && after.ship, 'invalid city metadata leaves the independently loaded ship available');
    assert.equal(after.city, false, 'invalid city metadata does not leave a VoyageCity instance');
    assert.equal(after.alive, true, 'invalid city metadata does not destroy the ship renderer');
    assert(after.canvas, 'the ship canvas remains attached after city initialization failure');
    assert.deepEqual(after.sceneChildren, before.sceneChildren, 'invalid city metadata removes the failed city root from the scene');
    return { city: gate.state.city, warning: warnings.at(-1), before, after };
  });

  evidence.scenarios.destroyBeforeCity = await installAssetGate(page, { hold: ['city'] }, async gate => {
    await reloadEntry(page);
    await waitUntil(() => gate.state.city.requests > 0, 'the delayed city request');
    await waitForVoyage(page, () => Boolean(window.__entry?.voyage?.model && window.__entry?.voyage?.ship), 'the ship before destroying the voyage');
    const beforeIds = await page.evaluate(() => window.__entry.voyage.scene.children.map(child => child.id));
    await page.evaluate(() => window.__entry.voyage.destroy());
    gate.release('city');
    await waitUntil(() => gate.state.city.finished.length > 0, 'the released city response after destroy', 10000);
    await sleep(150);
    const after = await browserSnapshot(page);
    assert.equal(after.alive, false, 'destroy marks the old EntryVoyage dead before the city response arrives');
    assert.equal(after.canvas, false, 'destroy removes the old canvas');
    assert.equal(after.city, false, 'a late city result does not attach a city to a destroyed voyage');
    assert(after.sceneChildren.every(child => beforeIds.includes(child.id)), 'a late city result does not add a new scene root after destroy');
    assert.equal(after.ready, false, 'destroyed voyage does not restore entry-voyage-ready');
    return { city: gate.state.city, beforeIds, after };
  });

  evidence.passed = true;
  await fs.writeFile(path.join(output, 'opening-model-lifecycle.json'), JSON.stringify(evidence, null, 2), 'utf8');
  assert.deepEqual(errors, []);
  console.log('PASS staged opening HUD gate, ship-before-city movement, city failure isolation, invalid-city cleanup, and late-city destroy cleanup');
  return evidence;
}
