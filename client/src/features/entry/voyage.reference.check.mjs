// Focused visual/interaction check for the real updated model, entirely offline.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
export async function checkVoyageReference(page,output,errors) {
  const evidence=[];
  const capture=async name=>{await page.evaluate(()=>window.__entry.voyage.updateActivity());await page.waitForTimeout(350);await page.screenshot({path:path.join(output,name+'.png')});};
  await page.locator('#username').waitFor({state:'visible',timeout:60000});
  for (const [name,width,height] of [['desktop',1440,900],['landscape',960,640],['phone',390,844]]) {
    await page.setViewportSize({width,height});await page.waitForTimeout(450);
    const summary=page.locator('#client-actions summary');assert(await summary.isVisible());
    const b=await page.locator('#client-actions').boundingBox();
    assert(Math.abs(width-b.x-b.width-14)<2&&Math.abs(height-b.y-b.height-14)<2,'closed version entry stays at bottom right');
    await summary.click();const open=await page.locator('#client-actions').boundingBox();assert(open.x>=0&&open.y>=0&&open.x+open.width<=width&&open.y+open.height<=height,'expanded actions remain inside viewport');await summary.click();
    const form=await page.locator('#login').boundingBox();assert(form.x>=0&&form.y>=0&&form.x+form.width<=width&&form.y+form.height<=height,`entire login surface fits: ${JSON.stringify({name,form,width,height})}`);
    await capture('login-'+name);evidence.push({name,width,height,form,actions:b});
  }
  await page.setViewportSize({width:1440,height:900});await page.waitForTimeout(450);
  await page.locator('#username').fill('entry_check');await page.locator('#password').fill('entry-check-password');await page.locator('#submit').click();
  await page.locator('.entry-stage-channel').waitFor();await page.waitForTimeout(500);
  const state=()=>page.evaluate(()=>{const v=window.__entry.voyage,eye=v.ship.worldToLocal(v.camera.position.clone()),foot=v.deck.position.clone(),aim=v.ship.worldToLocal(v.aim.clone()),d=eye.clone().sub(aim);d.y=0;return {eye:eye.toArray(),foot:foot.toArray(),normalAlignment:d.normalize().x,adventureVisible:!document.querySelector('.voyage-adventure').hidden,route:v.deck.route.map(p=>p.toArray())};});
  const start=await state();assert(start.normalAlignment>.88,'default exterior camera faces across the starboard side');assert(start.adventureVisible,'the physical adventure sign is in view');
  await capture('deck-side-default');
  await page.keyboard.down('ArrowLeft');await page.waitForFunction(()=>window.__entry.voyage.deck.moving,undefined,{timeout:5000});
  await page.waitForFunction(p=>window.__entry.voyage.deck.position.distanceTo(window.__entry.voyage.deck.spawn.clone().fromArray(p))>.30,start.foot,{timeout:5000});await page.keyboard.up('ArrowLeft');
  const walked=await state();assert(walked.foot[2]>start.foot[2],'left key follows the side-view screen direction');
  const samples=[...start.route,[0,5.505,-8],[0,5.505,22],[5.65,5.505,13.25]];
  for (const [i,p] of samples.entries()) {
    const placed=await page.evaluate(p=>{const v=window.__entry.voyage;const ok=v.deck.place(v.deck.spawn.clone().fromArray(p));v.updateActivity();return ok;},p);
    assert(placed,`deck ${i}: actual surface is standable`);await page.waitForTimeout(150);
    const sample=await state();
    if(Math.abs(p[0])>=5)assert(sample.normalAlignment*Math.sign(p[0])>.88,`deck ${i}: camera faces the walker's exposed side`);
    const nearEye=await page.evaluate(()=>{const v=window.__entry.voyage,T=v.camera.position.constructor,eye=v.camera.position.clone(),ray=v.cameraRay;let distance=Infinity;for (const direction of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]){ray.set(eye,new T(...direction));ray.far=.30;const meshes=v.cameraObstacles.filter(m=>{for(let n=m;n;n=n.parent)if(!n.visible)return false;return true;});distance=Math.min(distance,ray.intersectObjects(meshes,false)[0]?.distance??Infinity);}return Number.isFinite(distance)?distance:null;});
    assert(nearEye===null,`deck ${i}: solid geometry intersects the camera near plane`);evidence.push({deckIndex:i,...sample,nearEye});
    await capture('deck-area-'+i);
  }
  await capture('deck-side-portal');
  await page.evaluate(()=>{const v=window.__entry.voyage;v.deck.reset();v.updateActivity();});
  await page.locator('.voyage-adventure').click();await page.locator('#entered').waitFor({state:'visible',timeout:15000});
  assert.deepEqual(errors,[]);await fs.writeFile(path.join(output,'reference-check.json'),JSON.stringify({mode:'offline WebGL and stub account; no running game server contacted',evidence,errors},null,2),'utf8');
  console.log('PASS reference login: 3 sizes, bottom-right actions, native account submission, cameras around the complete main deck, near-eye solids and adventure click');
}
