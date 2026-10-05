import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function checkVoyageCorrection(page, output, errors) {
  const states = {};
  const shot = async name => {
    await page.evaluate(() => window.__entry.voyage.updateActivity());
    await page.waitForTimeout(300);
    await page.screenshot({path:path.join(output, `${name}.png`)});
  };
  await page.locator('#username').fill('entry_check');
  await page.locator('#password').fill('entry-check-password');
  await page.locator('#submit').click();
  await page.locator('.entry-stage-channel').waitFor();
  states.near = await page.evaluate(() => {
    const v=window.__entry.voyage;
    return {nameHidden:document.querySelector('.voyage-player-name')?.hidden, names:[...document.querySelectorAll('.voyage-deck-avatar')].map(n=>({hidden:n.hidden,class:n.className}))};
  });
  await shot('door-near');
  states.far = await page.evaluate(() => {
    const v=window.__entry.voyage;v.zoom=6.2;v.inspection=true;v.inspectionPitch=.48;v.updateActivity();
    return {zoom:v.zoom};
  });
  await shot('whole-ship-no-name');
  states.far.names = await page.evaluate(() => [...document.querySelectorAll('.voyage-avatar-name')].map(n=>({hidden:n.hidden,class:n.className})));
  states.far.hiddenAvatarNames = await page.evaluate(() => [...document.querySelectorAll('.voyage-deck-avatar')].map(n=>n.hidden));
  assert(states.far.hiddenAvatarNames.length>0 && states.far.hiddenAvatarNames.every(Boolean), 'all player name carriers hide during ship inspection');
  await page.evaluate(() => {const v=window.__entry.voyage;v.zoom=1.2;v.inspection=false;v.reveal.setPaused(false);v.updateActivity();});
  await shot('near-name-restored');
  assert(await page.evaluate(()=>[...document.querySelectorAll('.voyage-deck-avatar')].some(n=>!n.hidden)), 'near follow view restores the selected player name');
  await page.evaluate(() => {const v=window.__entry.voyage,T=window.__three;v.deck.place(v.ship.worldToLocal(v.model.getObjectByName('SV3_CaptainPortal').getWorldPosition(new T.Vector3())));v.updateActivity();});
  await page.waitForFunction(()=>window.__entry.voyage.nearInteraction==='enter-cabin');
  await shot('door-portal-aligned');
  await page.keyboard.press('Space');
  await page.locator('.entry-stage-characters').waitFor();
  await shot('floor-count-flat');
  states.count = await page.evaluate(() => {
    const v=window.__entry.voyage,T=window.__three,m=v.floorCount;
    const normal=new T.Vector3(0,0,1).applyQuaternion(m.quaternion);
    const floor=v.model.getObjectByName('SV2_CabinFloor');floor.geometry.computeBoundingBox();
    return {normal:normal.toArray(),height:m.position.y,floorHeight:floor.position.y+floor.geometry.boundingBox.max.y*floor.scale.y,depthTest:m.material.depthTest,depthWrite:m.material.depthWrite,visible:m.visible};
  });
  assert(Math.abs(states.count.normal[1]-1)<1e-6 && Math.abs(states.count.normal[2])<1e-6, 'count lies parallel to the floor');
  assert(Math.abs(states.count.height-states.count.floorHeight)<.015, 'count sits on the actual floor with a small anti-flicker offset');
  assert(states.count.depthTest&&states.count.depthWrite, 'floor count obeys scene depth and cannot float through players');
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(output,'correction-result.json'),JSON.stringify({passed:true,states,errors},null,2),'utf8');
}
