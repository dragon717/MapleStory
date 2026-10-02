// Exercise the generated file itself; no HTTP server or actual account is used.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium } = require('/Users/muniao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '..'), sceneName = process.argv[2] ?? 'sky-voyage-v3';
const output = path.join(root, 'evidence/2026-10-02', sceneName);
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const installed = fs.readdirSync(cache).filter(name=>name.startsWith('chromium_headless_shell-')).sort((a,b)=>Number(b.split('-').at(-1))-Number(a.split('-').at(-1)))[0];
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || path.join(cache, installed, 'chrome-headless-shell-mac-arm64/chrome-headless-shell');
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const errors = [], network = [];
  page.on('pageerror', error=>errors.push(String(error)));
  page.on('console', message=>{if(message.type()==='error' && /shader|WebGLProgram|VALIDATE_STATUS/i.test(message.text())) errors.push(message.text());});
  page.on('request', request=>{if(/^https?:/.test(request.url()))network.push(request.url());});
  const ready = () => page.waitForFunction(()=>Array.from(document.images).every(image=>image.complete && image.naturalWidth>0));
  try {
    await page.goto(pathToFileURL(path.join(root, 'resources/scenes', sceneName, 'preview/index.html')).href);
    await page.locator('.entry-voyage-ready').waitFor({ timeout: 60000 }); await ready();
    const userRig = sceneName === 'sky-voyage-v3';
    if (userRig) {
      assert(await page.evaluate(()=>window.__voyagePreview.voyage.flight.parts.filter(part=>part.kind==='fan').length===6), 'all exported fan parts must bind to runtime controls');
      assert(await page.evaluate(()=>{let mapped=0;window.__voyagePreview.voyage.model.getObjectByName('SV3_Exterior').traverse(node=>{if(node.material?.map)mapped++;});return mapped>10;}), 'generated materials must load through native blob fetch');
    } else {
      assert(await page.evaluate(()=>window.__voyagePreview.voyage.sails.length >= 2), 'sails must bind to actual cloth simulation');
      assert(await page.evaluate(()=>!!window.__voyagePreview.voyage.model.getObjectByName('SV2_Sail_Main_Gore_02_Mesh_1').material.map), 'embedded sail texture must load through native blob fetch');
    }
    assert(await page.evaluate(()=>window.__voyagePreview.voyage.water.surfaces.length >= 2 && window.__voyagePreview.voyage.water.falls.length >= 4), 'water must be generated from program domains');
    assert.equal(await page.locator('.entry-avatar').count(), 0);
    assert.equal(await page.locator('.voyage-travelling').count(),0,'reduced motion skips the journey');
    for (const shot of ['far', 'mid', 'deck', 'city', 'ship']) {
      await page.evaluate(shot=>{window.__voyagePreview.voyage.showShot(shot);document.querySelector('.entry-scene').style.visibility='hidden';},shot);
      await page.waitForFunction(shot=>window.__voyagePreview.voyage.shot===shot,shot);
      if (shot !== 'ship') assert(await page.evaluate(()=>{const v=window.__voyagePreview.voyage,p=v.model.getObjectByName('SV2_City').getWorldPosition(v.camera.position.clone()).project(v.camera);return Math.abs(p.x)<1 && Math.abs(p.y)<1;}),'destination root remains in the view');
      await page.screenshot({path:path.join(output,shot+'.png')});
    }
    if (userRig) {
      await page.evaluate(()=>window.__voyagePreview.voyage.setShipControls({sail:0,steering:0}));
      await page.waitForFunction(()=>window.__voyagePreview.voyage.shipStatus().sail===0);
      const reefed=await page.evaluate(()=>window.__voyagePreview.voyage.shipStatus().thrust);
      assert(await page.evaluate(()=>{const p=window.__voyagePreview.voyage.flight.parts.find(p=>p.node.name==='SV3_MainFan_0');return p.morphs.every(m=>m.morphTargetInfluences[m.morphTargetDictionary.DeployFold]===1);}));
      await page.screenshot({path:path.join(output,'ship-folded.png')});
      await page.evaluate(()=>window.__voyagePreview.voyage.setShipControls({sail:1,steering:-1}));
      await page.waitForFunction(()=>window.__voyagePreview.voyage.shipStatus().steering===-1);
      assert(await page.evaluate(()=>window.__voyagePreview.voyage.model.getObjectByName('SV3_BowVane_Port').quaternion.y>0), 'left turn moves the real steering part');
      assert(await page.evaluate(()=>window.__voyagePreview.voyage.shipStatus().thrust)>reefed);
      await page.screenshot({path:path.join(output,'ship-left.png')});
      await page.evaluate(()=>window.__voyagePreview.voyage.setShipControls({steering:1}));
      await page.waitForFunction(()=>window.__voyagePreview.voyage.shipStatus().steering===1);
      assert(await page.evaluate(()=>window.__voyagePreview.voyage.model.getObjectByName('SV3_BowVane_Port').quaternion.y<0));
      await page.screenshot({path:path.join(output,'ship-right.png')});
      await page.evaluate(()=>window.__voyagePreview.voyage.setShipControls({steering:0}));
    }
    await page.evaluate(()=>{document.querySelector('.entry-scene').style.visibility='';window.__voyagePreview.voyage.showShot('deck');});
    await page.screenshot({path:path.join(output,'login.png')});
    await page.locator('#submit').click(); await page.locator('[data-action="channel"]').click();
    assert.equal(await page.locator('[data-select]').count(),0);
    await page.locator('[data-action="create"]').first().click(); await ready();
    assert.equal(await page.locator('.voyage-cabin-window img').count(),4);
    assert(await page.evaluate(()=>{const panel=document.querySelector('#create-character').closest('.entry-glass').getBoundingClientRect();return Array.from(document.querySelectorAll('.voyage-cabin-window')).every(el=>{const r=el.getBoundingClientRect();return r.left>=0 && r.right<=panel.left && r.top>=0 && r.bottom<=innerHeight;});}),'four profession windows remain in view beside the panel');
    await page.locator('#character-name').fill('星月旅人');
    await page.screenshot({path:path.join(output,'create.png')});
    await page.setViewportSize({width:390,height:844});
    await page.locator('#create-character').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(output,'create-phone.png')});
    await page.locator('#create-character button[type=submit]').click();
    await page.locator('.voyage-leaving-cabin').waitFor(); await ready();
    assert.equal(await page.locator('.voyage-deck-avatar [data-character]').count(),1);
    await page.setViewportSize({width:1440,height:900});
    await page.evaluate(()=>window.__voyagePreview.showLogin());
    await page.locator('.preview-tools summary').click(); await page.locator('#returning').check(); await page.locator('.preview-tools summary').click();
    await page.locator('#submit').click(); await page.locator('[data-action="channel"]').click(); await ready();
    assert.equal(await page.locator('[data-select]').count(),4); assert.equal(await page.locator('[data-page]').count(),3);
    await page.screenshot({path:path.join(output,'berths.png')});
    await page.locator('[data-select="passenger-2"]').click();
    assert.equal(await page.locator('[data-select="passenger-2"]').getAttribute('aria-pressed'),'true');
    await page.locator('[data-page="1"]').click(); assert.equal(await page.locator('[data-select="passenger-4"]').count(),1);
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.evaluate(()=>{window.__voyagePreview.showLogin();const v=window.__voyagePreview.voyage;v.elapsed=0;v.shot=undefined;});
    await page.locator('.voyage-travelling').waitFor();
    await page.waitForFunction(()=>window.__voyagePreview.voyage.waterTime.value > .1);
    if (userRig) {
      const pressure=await page.evaluate(()=>{const m=window.__voyagePreview.voyage.flight.parts.find(p=>p.kind==='fan').morphs[0];return m.morphTargetInfluences[m.morphTargetDictionary.WindPressure];});
      await page.waitForFunction(before=>{const m=window.__voyagePreview.voyage.flight.parts.find(p=>p.kind==='fan').morphs[0];return Math.abs(m.morphTargetInfluences[m.morphTargetDictionary.WindPressure]-before)>.001;},pressure);
    } else {
      const clothState = await page.evaluate(()=>Array.from(window.__voyagePreview.voyage.sails[0].simulation.positions));
      await page.waitForFunction(before=>window.__voyagePreview.voyage.sails[0].simulation.positions.some((v,i)=>Math.abs(v-before[i])>.00001),clothState);
    }
    assert(await page.evaluate(()=>window.__voyagePreview.voyage.ship.position.z>0),'the ship actually approaches the city');
    await page.locator('[data-action="skip-voyage"]').click();
    await page.waitForFunction(()=>!document.querySelector('.voyage-travelling'));
    if (userRig) {
      await page.evaluate(()=>{const v=window.__voyagePreview.voyage;v.setShipControls({steering:1});v.setShipTrial(true);});
      await page.waitForFunction(()=>window.__voyagePreview.voyage.flight.position.length()>.02);
      assert(await page.evaluate(()=>window.__voyagePreview.voyage.ship.position.distanceTo(window.__voyagePreview.voyage.shipOrigin)>.02),'trial forces move the displayed ship');
      await page.evaluate(()=>window.__voyagePreview.voyage.setShipTrial(false));
    }
    await page.evaluate(()=>{ const v=window.__voyagePreview.voyage; v.showShot('water');document.querySelector('.entry-scene').style.visibility='hidden';v.disturbWater(); });
    const waterState = await page.evaluate(()=>Array.from(window.__voyagePreview.voyage.water.surfaces[0].solver.state));
    await page.waitForFunction(before=>window.__voyagePreview.voyage.water.surfaces[0].solver.state.some((value,i)=>i%3===0 && Math.abs(value-before[i])>.00001),waterState);
    await page.screenshot({path:path.join(output,'water.png')});
    assert.deepEqual(errors, []); assert.deepEqual(network, []);
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,mode:'single-file preview, offline fixtures, no network/account persistence',errors,network},null,2),'utf8');
    console.log('Standalone 3D preview / zero roles / class windows / create-to-deck / berth pagination passed:',output);
  } finally { await browser.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
