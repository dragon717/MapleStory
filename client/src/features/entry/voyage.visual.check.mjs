import fs from 'node:fs/promises';
import path from 'node:path';
export async function captureVoyageVisuals(page,output,errors){
const states={};
async function shot(name,fn){await page.locator('#show-menu').evaluate(o=>o.style.display='none');if(fn)await page.evaluate(fn);await page.waitForTimeout(250);states[name]=await page.evaluate(()=>{const v=window.__entry.voyage;const dolls=[...(v.passengers.dolls?.values?.()??[])].map(d=>{const world=d.mesh.getWorldPosition(new d.mesh.position.constructor());return {visible:d.group.visible,position:d.group.position.toArray(),scale:d.group.scale.toArray(),meshPosition:d.mesh.position.toArray(),worldPosition:world.toArray(),texture:[d.texture.image?.width,d.texture.image?.height],materialMap:Boolean(d.mesh.material.map)};});return {stage:v.stage,camera:v.camera.position.toArray(),aim:v.aim.toArray(),fov:v.camera.fov,near:v.camera.near,pitch:v.pitch,yaw:v.yaw,zoom:v.zoom,foot:v.deck.position.toArray(),dolls,cutaway:[...v.reveal.hidden.keys()].map(o=>o.name),revealStrength:v.reveal.strength.value,revealBlocked:v.reveal.blocked};});await page.screenshot({path:path.join(output,name+'.png')});}
await page.locator('#username').waitFor({state:'visible'});
await shot('login-default');
await page.locator('#username').fill('entry_check');await page.locator('#password').fill('entry-check-password');await page.locator('#submit').click();await page.locator('.entry-stage-channel').waitFor();await page.waitForTimeout(900);
await shot('captain-default');
await shot('captain-sealed-portal',()=>{const v=window.__entry.voyage;v.deck.place(v.deck.route.at(-1));v.updateActivity();});
await shot('outside-default',()=>{const v=window.__entry.voyage;v.deck.reset();v.updateActivity();});
await shot('outside-no-reveal',()=>{const v=window.__entry.voyage;v.reveal.strength.value=0;v.reveal.checkedAt=Infinity;v.reveal.blocked=false;v.updateActivity();});

for(const [name,eye,aim] of [['sapphire-context',[22,12,-15],[11,8.15,-21.2]],['jade-context',[21,7,-5],[10,3.5,-12]]]){await page.evaluate(({eye,aim})=>{const v=window.__entry.voyage;document.querySelector('.entry-scene').style.visibility='hidden';cancelAnimationFrame(v.frame);v.camera.position.fromArray(eye);v.aim.fromArray(aim);v.camera.lookAt(v.aim);v.camera.fov=46;v.camera.near=.1;v.camera.updateProjectionMatrix();v.camera.updateMatrixWorld(true);v.reveal.strength.value=0;v.clouds.render(v.renderer,v.scene,v.camera,v.sun);},{eye,aim});states[name]=await page.evaluate(()=>{const v=window.__entry.voyage;return{stage:v.stage,camera:v.camera.position.toArray(),aim:v.aim.toArray(),fov:v.camera.fov,near:v.camera.near,cutaway:[...v.reveal.hidden.keys()].map(o=>o.name),revealStrength:v.reveal.strength.value}});await page.screenshot({path:path.join(output,name+'.png')});}
await fs.writeFile(path.join(output,'states.json'),JSON.stringify({mode:'offline production WebGL; native login and default walking camera; gemstone context camera explicitly recorded',states,errors},null,2));console.log(JSON.stringify({states,errors}));

}
