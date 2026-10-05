import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
export async function checkVoyagePolish(page, output, errors) {
  await page.locator('#username').fill('entry_check'); await page.locator('#password').fill('entry-check-password'); await page.locator('#submit').click();
  await page.locator('.entry-stage-channel').waitFor();
  const samples=[];
  if (!process.argv.includes('--cabin-polish-only')) for(const viewport of [{width:1440,height:900},{width:960,height:640},{width:390,height:844}]) {
    await page.setViewportSize(viewport); await page.mouse.move(viewport.width/2, viewport.height/2);
    for(let i=0;i<15;i++){await page.mouse.wheel(0,100);await page.waitForTimeout(25);}
    await page.waitForFunction(()=>window.__entry.voyage.zoom===6.2);
    await page.waitForTimeout(200);
    const bounds=await page.evaluate(()=>{const v=window.__entry.voyage,T=window.__three,b=v.shipBounds,c=b.center,r=b.radius;const points=[];for(const x of [-r,r])for(const y of [-r,r])for(const z of [-r,r]){const p=v.ship.localToWorld(new T.Vector3(c.x+x,c.y+y,c.z+z)).project(v.camera);points.push(p.toArray());}return {zoom:v.zoom,inspection:v.inspection,points,yaw:v.inspectionYaw,aim:v.aim.toArray(),shipCenter:v.ship.localToWorld(c.clone()).toArray()};});
    assert(bounds.inspection); assert(bounds.points.every(p=>p[2]>-1&&p[2]<1));
    // The bounding sphere covers each real point; check the actual meshes too,
    // since an axis-aligned cube around that sphere is deliberately larger.
    const extent=await page.evaluate(()=>{const v=window.__entry.voyage,T=window.__three;let max=0,count=0;v.model.getObjectByName('SV3_Exterior').traverse(o=>{if(!o.isMesh)return;for(let p=o;p;p=p.parent)if(!p.visible)return;const a=o.geometry.attributes.position;for(let i=0;i<a.count;i+=Math.max(1,Math.floor(a.count/600))){const p=new T.Vector3().fromBufferAttribute(a,i).applyMatrix4(o.matrixWorld).project(v.camera);max=Math.max(max,Math.abs(p.x),Math.abs(p.y));count++;}});return{max,count};});
    assert(extent.max<.98,`whole ship fits ${viewport.width} viewport: ${extent.max}`);assert(extent.count>500);
    await page.screenshot({path:path.join(output,`full-ship-${viewport.width}.png`)});
    await page.mouse.down();await page.mouse.move(viewport.width/2+160,viewport.height/2,{steps:6});await page.mouse.up();
    const rotated=await page.evaluate(()=>window.__entry.voyage.inspectionYaw);
    assert(Math.abs(rotated-bounds.yaw)>.7,'left drag freely rotates the full ship beyond the old yaw clamp');
    for(let i=0;i<18;i++){await page.mouse.wheel(0,-100);await page.waitForTimeout(25);}
    await page.waitForFunction(()=>!window.__entry.voyage.inspection);
    const near=await page.evaluate(()=>{const v=window.__entry.voyage,p=v.ship.localToWorld(v.deck.position.clone());p.y+=1.65;return{zoom:v.zoom,yaw:v.yaw,targetError:v.aim.distanceTo(p)};});
    assert(near.zoom<2.2&&near.yaw===0&&near.targetError<.01,'zooming in restores the character follow target');samples.push({viewport,extent,near});
  }
  await page.setViewportSize({width:1440,height:900});await page.evaluate(()=>window.__entry.go('characters'));
  await page.waitForFunction(()=>{const v=window.__entry.voyage;return v.cabinShown&&!v.transition;});
  await page.waitForTimeout(200);
  const light=await page.evaluate(()=>{const v=window.__entry.voyage;return v.windowLight.lights.map(l=>({range:l.distance,near:l.shadow.camera.near,compare:l.shadow.map?.depthTexture?.compareFunction,far:l.shadow.camera.far,position:l.getWorldPosition(v.camera.position.clone()).toArray()}));});
  assert(light.every(l=>l.range>=180&&l.near===60&&l.compare!==null&&l.compare!==undefined&&l.far>=180),'four native depth-comparison projectors reach the doubled cabin floor');
  const route=await page.evaluate(()=>{const v=window.__entry.voyage;return v.cabinDeck.route.map(p=>p.toArray());});
  assert(route.length>=18,'the cabin route includes stern, transfer, all twelve bed-side points, door, slope and platforms');
  assert(route.some(p=>p[1]>5),'the cabin route reaches the authored upper platform height');
  assert(route.some(p=>p[1]<.2&&Math.abs(p[2]-45.4)<.1),'the cabin route keeps one horizontal door-facing bed aisle');
  assert(route.some(p=>p[2]>55),'the cabin route reaches section 09 before returning through transfer 18');
  const putAtChoices=()=>page.evaluate(()=>{const v=window.__entry.voyage,T=window.__three,p=v.ship.worldToLocal(v.model.getObjectByName('SV3_CabinDeckPortal').getWorldPosition(new T.Vector3()));p.x+=.6;p.y=.025;v.cabinDeck.place(p);v.passengers.finishWake();v.updateActivity();});
  await putAtChoices();await page.waitForFunction(()=>window.__entry.voyage.interactions.length>1);
  const before=await page.evaluate(()=>window.__entry.voyage.cabinDeck.position.toArray());
  await page.keyboard.press('Space');await page.locator('.voyage-interaction-choices').waitFor({timeout:5000});
  await page.keyboard.press('ArrowRight');assert.equal(await page.evaluate(()=>window.__entry.voyage.interactionIndex),1);
  assert.deepEqual(await page.evaluate(()=>window.__entry.voyage.cabinDeck.position.toArray()),before,'chooser arrows cannot move the passenger');
  await page.keyboard.press('Escape');assert.equal(await page.locator('.voyage-interaction-choices').count(),0);
  assert(await page.locator('.voyage-space-hint').isVisible(),'Escape immediately restores the hint even when reduced motion schedules no further frame');
  await page.keyboard.press('Space');await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  assert.equal(await page.locator('.voyage-interaction-choices').count(),0);assert(await page.locator('.voyage-space-hint').isVisible(),'blur closes choices and restores the hint');
  const immediate=await page.evaluate(()=>{const v=window.__entry.voyage;window.__entry.go('channel');const count=v.interactions.length;window.dispatchEvent(new KeyboardEvent('keydown',{code:'Space',bubbles:true}));const stale=Boolean(v.host.querySelector('.voyage-interaction-choices'));window.__entry.go('characters');return{count,stale};});
  assert.deepEqual(immediate,{count:0,stale:false},'a second Space before the next frame cannot reuse cabin choices on the deck');
  await putAtChoices();await page.waitForFunction(()=>window.__entry.voyage.interactions.length>1);
  await page.keyboard.press('Space');await page.keyboard.press('ArrowRight');await page.keyboard.press('Space');await page.locator('.entry-stage-create').waitFor();
  await page.locator('[data-action="cancel-create"]').click();await page.locator('.entry-stage-characters').waitFor();
  await putAtChoices();await page.waitForFunction(()=>window.__entry.voyage.interactions.length>1);await page.keyboard.press('Space');
  await page.locator('.voyage-interaction-choices button').filter({hasText:'返回甲板'}).click();await page.locator('.entry-stage-channel').waitFor();
  assert.equal(await page.locator('.voyage-interaction-choices').count(),0,'stage changes remove the chooser');
  await page.evaluate(()=>window.__entry.go('characters'));
  // Controlled fixture: put the return interaction on an occupied bed to
  // exercise the same overlap rule for role details as for empty-bed creation.
  await page.evaluate(()=>{const v=window.__entry.voyage,T=window.__three,portal=v.model.getObjectByName('SV3_CabinDeckPortal');window.__portalPosition=portal.position.clone();const p=v.ship.worldToLocal(v.model.getObjectByName('SV2_Bed_1_FootAnchor').getWorldPosition(new T.Vector3())).add(new T.Vector3(0,0,.6));portal.position.copy(p);p.y=.025;v.cabinDeck.place(p);v.passengers.finishWake();v.updateActivity();});
  await page.waitForFunction(()=>window.__entry.voyage.interactions.length===2);
  await page.keyboard.press('Space');await page.keyboard.press('ArrowRight');await page.keyboard.press('Space');
  await page.locator('.voyage-role-details').waitFor({state:'visible'});await page.waitForTimeout(250);
  assert(await page.evaluate(()=>window.__entry.voyage.roleDetailOpen),'chosen role remains open even when return-deck is the first nearby interaction');
  assert.deepEqual(await page.locator('.voyage-role-details dt').allTextContents(),['等级','职业']);
  await page.screenshot({path:path.join(output,'role-paper-refined.png')});
  await page.locator('[data-action="close-role"]').click();
  await page.evaluate(()=>{const v=window.__entry.voyage;v.model.getObjectByName('SV3_CabinDeckPortal').position.copy(window.__portalPosition);v.cabinDeck.reset();v.passengers.finishWake();v.updateActivity();});
  await page.waitForTimeout(200);await page.screenshot({path:path.join(output,'cabin-polished.png')});
  assert.deepEqual(errors,[]);await fs.writeFile(path.join(output,'polish-result.json'),JSON.stringify({passed:true,samples,light,route,errors},null,2),'utf8');
  console.log('PASS full ship framing/orbit/near follow, native scaled window shadows, horizontal cabin route and keyboard/mouse interaction chooser');
}
