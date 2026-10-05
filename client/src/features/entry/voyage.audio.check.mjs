import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function checkAudioOpening(page, output, requests, errors, gestureRequired) {
  const shipRequests = () => requests.filter(r => r.url.endsWith('.glb'));
  await page.waitForFunction(() => window.__entryAudio.entry.url);
  assert.equal(shipRequests().length, 0, 'no GLB may compete with the initial BGM download');
  const before = await page.evaluate(() => { const background = getComputedStyle(document.querySelector('.entry-background')); return { backgroundColor: background.backgroundColor, backgroundImage: background.backgroundImage, hidden: getComputedStyle(document.querySelector('.entry-scene')).visibility, credit: (()=>{const s=getComputedStyle(document.querySelector('.entry-edition'));return{border:s.borderTopWidth,image:s.borderImageSource,background:s.backgroundColor};})() }; });
  assert.notEqual(before.backgroundColor, 'rgb(8, 11, 14)', 'the audio gate must keep the entry sky visible');
  assert.match(before.backgroundImage, /linear-gradient/i, 'the audio gate must use the sky gradient'); assert.equal(before.hidden, 'hidden');
  assert.equal(before.credit.border, '0px'); assert.equal(before.credit.image, 'none'); assert.equal(before.credit.background, 'rgba(0, 0, 0, 0)');
  if (gestureRequired) {
    await page.locator('[data-action="begin-voyage"]').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => window.__entryAudio.context().state), 'suspended');
    assert.equal(await page.evaluate(() => window.__entryAudio.entry.needsGesture), true, 'the opening prompt is shown only for a suspended audible context');
    assert.equal(shipRequests().length, 0, 'blocked autoplay keeps scenery unloaded');
    await page.screenshot({ path: path.join(output, 'opening-before-gesture.png') });
    await page.locator('[data-action="begin-voyage"]').click();
  }
  await page.waitForFunction(() => window.__entryAudio.entry.playing);
  await page.waitForFunction(() => Boolean(window.__entry.voyage));
  const starts = await page.evaluate(() => window.__audioStarts);
  assert.equal(starts.length, 1, 'opening starts one looping BGM');
  assert(shipRequests().length > 0);
  assert(shipRequests().every(r => r.at >= starts[0]), 'all three GLB downloads follow actual source.start');
  assert.equal(await page.locator('.voyage-audio-opening').isVisible(), false);
  const peak = await page.evaluate(async () => {
    const music = window.__entryAudio.entry, context = window.__entryAudio.context(), analyser = context.createAnalyser(), data = new Float32Array(analyser.fftSize);
    music.gain.connect(analyser);
    let peak = 0;
    for (let i=0;i<8;i++) { await new Promise(resolve=>setTimeout(resolve,50)); analyser.getFloatTimeDomainData(data); for (const value of data) peak=Math.max(peak,Math.abs(value)); }
    music.gain.disconnect(analyser); return peak;
  });
  assert(peak > .005, 'the original MP3 produces real Web Audio samples');
  await page.locator('.entry-voyage-ready').waitFor({ timeout: 60000 });
  await page.screenshot({ path: path.join(output, 'opening-with-plain-credit.png') });
  const openingRequests = requests.filter(r=>/voyage-music|\.mp3$|\.glb$/.test(r.url));
  await page.locator('[data-action="entry-music"]').click();
  assert.equal(await page.evaluate(()=>window.__entryAudio.entry.gain.gain.value),0);
  await page.locator('[data-action="entry-music"]').click();
  assert.equal(await page.evaluate(()=>window.__audioStarts.length),1,'mute toggles reuse the same source');
  await page.locator('#username').fill('entry_check');
  await page.locator('#password').fill('entry-check-password');
  await page.locator('#submit').click();
  await page.locator('.entry-stage-channel').waitFor();
  await page.evaluate(()=>window.__entry.action('quick'));
  await page.waitForFunction(()=>Boolean(document.getElementById('entered').textContent));
  assert.equal(await page.evaluate(()=>window.__entryAudio.entry.playing),false,'world readiness stops lobby BGM');
  assert(await page.evaluate(()=>window.__createAudioGame()),'real Phaser uses the shared WebAudioSoundManager');
  await page.evaluate(()=>window.__entryAudio.context().resume());
  await page.evaluate(()=>window.__destroyAudioGame());
  await page.waitForFunction(()=>window.__entryAudio.context().state==='suspended');
  await page.evaluate(()=>window.__entry.returnTo('channel'));
  await page.waitForFunction(()=>window.__entryAudio.entry.playing);
  assert.equal(await page.evaluate(()=>window.__audioStarts.length),2,'returning to the lobby starts exactly one replacement loop');
  // Cover the opposite ordering: Phaser's next-frame destroy suspends audio
  // after the lobby has already become active again.
  assert(await page.evaluate(()=>window.__createAudioGame()));
  await page.evaluate(()=>window.__destroyAudioGame());
  await page.waitForFunction(()=>window.__entryAudio.entry.playing);
  assert.equal(await page.evaluate(()=>window.__audioStarts.length),2,'late destruction resumes the existing loop');
  await page.evaluate(async()=>{await window.__entryAudio.context().close();});
  assert(await page.evaluate(()=>window.__entryAudio.entry.openingReady),'a closed AudioContext must release the opening gate');
  // A metadata failure must keep the existing login and scene available.
  await page.route('http://entry.test/assets/entry/voyage-music.json', route=>route.fulfill({status:404,body:'missing metadata'}));
  requests.length = 0;
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__entry.voyage));
  assert(!await page.locator('#welcome').evaluate(node=>node.classList.contains('voyage-awaiting-audio')));
  assert(shipRequests().length > 0, 'missing BGM metadata does not block model loading');
  await page.emulateMedia({reducedMotion:'no-preference'});
  let releaseMetadata;
  const heldMetadata = new Promise(resolve=>{releaseMetadata=resolve;});
  await page.route('http://entry.test/assets/entry/voyage-music.json', async route=>{await heldMetadata;await route.abort();});
  requests.length = 0;
  await page.reload();
  await page.waitForFunction(()=>Boolean(window.__entry));
  await page.locator('[data-action="skip-voyage"]').click();
  assert(await page.evaluate(()=>window.__entry.skipOpening),'skip before music loads is retained');
  await page.locator('[data-action="entry-music"]').click();
  assert.equal(await page.evaluate(()=>window.__entry.musicPrepared),false,'explicit mute bypasses the pending metadata immediately');
  await page.waitForFunction(()=>Boolean(window.__entry.voyage),null,{timeout:10000});
  releaseMetadata();
  await page.waitForFunction(()=>Boolean(window.__entry.voyage?.model),null,{timeout:60000});
  assert(await page.evaluate(()=>{const e=window.__entry;return e.music.muted&&e.voyage.elapsed>=e.voyage.duration&&!e.host.classList.contains('voyage-awaiting-audio');}),'explicit mute bypasses a pending request and applies the queued skip');
  assert.deepEqual(errors, []);
  const result = { gestureRequired, before, starts, openingRequests, peak, metadataFailureAccessible: true, muteAndWorldReturn: true, realPhaserDestroyRecovery: true, closedContextFallback: true, pendingMuteAndSkip: true, errors };
  await fs.writeFile(path.join(output, 'audio-opening.json'), JSON.stringify(result,null,2), 'utf8');
  console.log('PASS BGM priority/download/decode, actual audio before GLB requests, gesture gate, sky opening, closed-context fallback, plain credits and unavailable-metadata fallback',JSON.stringify(result));
}
