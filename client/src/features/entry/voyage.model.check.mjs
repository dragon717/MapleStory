// Actual exported GLB and production material loading, with explicit orthographic cameras.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
export async function captureVoyageModel(page,output,errors) {
  await page.locator('#username').waitFor({state:'visible'});
  const views=[['side',[1,0,0],[0,1,0]],['top',[0,1,0],[-1,0,0]],['stern',[0,0,1],[0,1,0]],['wheel',[1,0,0],[0,1,0],'SV3_Wheel_Starboard']];
  const states=[];
  for (const [name,axis,up,target] of views) {
    states.push(await page.evaluate(({name,axis,up,target})=>{
      const v=window.__entry.voyage,T=window.__three;cancelAnimationFrame(v.frame);
      for(const element of document.querySelectorAll('body *'))element.style.visibility=element===v.canvas?'visible':'hidden';
      for (const child of v.scene.children) if(child!==v.model && !(child instanceof T.Light))child.visible=false;
      v.model.visible=true;for (const child of v.model.children)child.visible=child===v.ship || child.getObjectById(v.ship.id)!==undefined;
      v.ship.visible=true;v.reveal.strength.value=0;for(const mesh of v.reveal.hidden.keys())mesh.visible=true;
      v.ship.updateWorldMatrix(true,true);
      const box=new T.Box3().setFromObject(target?v.ship.getObjectByName(target):v.ship),center=box.getCenter(new T.Vector3());
      const forward=new T.Vector3(...axis).negate(),right=forward.clone().cross(new T.Vector3(...up)).normalize(),vertical=right.clone().cross(forward).normalize();
      const corners=[];for (const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z])corners.push(new T.Vector3(x,y,z).sub(center));
      const span=d=>Math.max(...corners.map(p=>p.dot(d)))-Math.min(...corners.map(p=>p.dot(d)));
      const aspect=1440/900,height=Math.max(span(vertical),span(right)/aspect)*1.12,width=height*aspect;
      const camera=new T.OrthographicCamera(-width/2,width/2,height/2,-height/2,.1,10000);camera.up.fromArray(up);camera.position.copy(center).addScaledVector(new T.Vector3(...axis),1000);camera.lookAt(center);camera.updateMatrixWorld(true);
      v.scene.background=new T.Color('#ece8dc');v.scene.fog=null;v.renderer.setClearColor('#ece8dc');v.renderer.render(v.scene,camera);
      return{name,target,bounds:{min:box.min.toArray(),max:box.max.toArray()},camera:camera.position.toArray(),up,width,height};
    },{name,axis,up,target}));
    await page.locator('.voyage-canvas').screenshot({path:path.join(output,`model-${name}.png`)});
  }
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(output,'model-views.json'),JSON.stringify({mode:'real GLB; production WebGL material loading; explicit orthographic cameras',states,errors},null,2),'utf8');
  console.log('PASS actual GLB orthographic captures: side, top, stern and wheel detail');
}
