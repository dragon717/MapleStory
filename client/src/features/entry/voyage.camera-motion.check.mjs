import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
export async function checkVoyageCameraMotion(page,output,errors) {
  await page.locator('#username').fill('entry_check');await page.locator('#password').fill('entry-check-password');await page.locator('#submit').click();await page.locator('.entry-stage-channel').waitFor();
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.evaluate(()=>{const v=window.__entry.voyage;v.transition=undefined;v.deck.reset();v.followEye=undefined;v.followAim=undefined;v.zoom=1.2;v.previous=0;v.updateActivity();});
  await page.waitForTimeout(100);
  await page.keyboard.down('ArrowLeft');
  const loop=await page.evaluate(()=>{
    const v=window.__entry.voyage,d=v.deck,render=v.clouds.render;v.clouds.render=()=>{};
    const start=d.routeDistance,visited=new Set();let previous=v.camera.position.clone(),maxStep=0,maxPitch=0,stalled=0;
    let now=performance.now();v.previous=now;
    for(let i=0;i<1780;i++){
      cancelAnimationFrame(v.frame);now+=1000/60;v.draw(now);cancelAnimationFrame(v.frame);
      if(!d.moving)stalled++;maxStep=Math.max(maxStep,v.camera.position.distanceTo(previous));previous.copy(v.camera.position);
      d.route.slice(1,-1).forEach((p,j)=>{if(Math.hypot(p.x-d.position.x,p.z-d.position.z)<.08)visited.add(j);});
      const direction=v.camera.position.clone().sub(v.aim).normalize();maxPitch=Math.max(maxPitch,Math.asin(direction.y));
      if(!v.camera.position.toArray().every(Number.isFinite))throw new Error('non-finite follow camera');
    }
    v.clouds.render=render;v.previous=0;v.updateActivity();return {distance:Math.abs(d.routeDistance-start),corners:visited.size,stalled,maxStep,maxPitch};
  });
  await page.keyboard.up('ArrowLeft');
  assert(loop.distance>86&&loop.corners===4&&loop.stalled===0,'one held key crosses every corner while the real non-reduced camera follows');
  assert(loop.maxStep<3,'camera turns remain bounded rather than cutting to a new pose');assert(loop.maxPitch>.7,'turns raise the camera to reveal the deck');
  await page.evaluate(()=>{const v=window.__entry.voyage;v.deck.reset();v.followEye=undefined;v.followAim=undefined;v.updateActivity();});await page.waitForTimeout(150);
  await page.mouse.move(480,320);for(let i=0;i<12;i++){await page.mouse.wheel(0,100);await page.waitForTimeout(25);}
  await page.waitForFunction(()=>window.__entry.voyage.inspection&&window.__entry.voyage.zoom===6.2);
  await page.waitForFunction(()=>{const v=window.__entry.voyage;return v.aim.distanceTo(v.ship.localToWorld(v.shipBounds.center.clone()))<.08;},null,{timeout:10000});
  await page.screenshot({path:path.join(output,'full-ship-motion.png')});
  for(let i=0;i<12;i++){await page.mouse.wheel(0,-100);await page.waitForTimeout(25);}
  await page.waitForFunction(()=>!window.__entry.voyage.inspection);
  await page.waitForFunction(()=>{const v=window.__entry.voyage,p=v.ship.localToWorld(v.deck.position.clone());p.y+=1.65;return v.aim.distanceTo(p)<.08;},null,{timeout:10000});
  await page.evaluate(()=>window.__entry.go('characters'));
  try { await page.waitForFunction(()=>{const v=window.__entry.voyage;return v.cabinShown&&!v.transition;},null,{timeout:15000}); }
  catch(error) { const state=await page.evaluate(()=>{const v=window.__entry.voyage;return {stage:v.stage,cabinShown:v.cabinShown,transition:v.transition,previous:v.previous,now:performance.now(),hidden:v.host.hidden,documentHidden:document.hidden,reduced:v.reduced.matches};});await fs.writeFile(path.join(output,'motion-timeout.json'),JSON.stringify({loop,state},null,2),'utf8');throw error; }
  await page.evaluate(()=>{const v=window.__entry.voyage,T=window.__three,p=v.ship.worldToLocal(v.model.getObjectByName('SV2_Bed_0_FootAnchor').getWorldPosition(new T.Vector3())).add(new T.Vector3(0,0,.6));p.y=.025;v.cabinDeck.place(p);v.passengers.finishWake();v.updateActivity();});await page.waitForFunction(()=>window.__entry.voyage.nearInteraction==='role-details');await page.keyboard.press('Space');
  await page.waitForTimeout(150);await page.screenshot({path:path.join(output,'paper-cloth-opening.png')});
  await page.locator('.voyage-role-details').waitFor({state:'visible',timeout:12000});await page.screenshot({path:path.join(output,'paper-motion-final.png')});
  assert.deepEqual(errors,[]);await fs.writeFile(path.join(output,'camera-motion-result.json'),JSON.stringify({passed:true,mode:'production WebGL objects, non-reduced motion; accelerated deterministic loop clock with rendering suspended only during CPU sampling',loop,errors},null,2),'utf8');
  console.log('PASS non-reduced follow across the loop, raised/eased turns, far framing and smooth character return, physical cloth opening');
}
