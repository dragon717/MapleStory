import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function checkVoyageDetails(page, output, errors) {
  const english=process.argv.includes('--english-only');
  await page.locator('#username').fill('entry_check');await page.locator('#password').fill('entry-check-password');await page.locator('#submit').click();
  await page.locator('.entry-stage-channel').waitFor();await page.evaluate(()=>window.__entry.go('characters'));
  await page.waitForFunction(()=>{const v=window.__entry.voyage;return v.cabinShown&&!v.transition;});
  await page.waitForTimeout(300);
  const labels=await page.locator('.entry-character:not(.entry-empty) strong').evaluateAll(nodes=>nodes.map(n=>{const s=getComputedStyle(n),r=document.createRange();r.selectNodeContents(n);return{text:n.textContent,font:s.fontSize,border:s.borderTopWidth,background:s.backgroundColor,nowrap:s.whiteSpace,lines:r.getClientRects().length,width:n.getBoundingClientRect().width};}));
  assert(labels.some(l=>l.text==='muniao'));assert(labels.some(l=>l.text==='乘风破浪冒险家'));
  assert(labels.every(l=>l.border==='0px'&&l.nowrap==='nowrap'&&l.lines===1&&parseFloat(l.font)<=11),'English name and seven Chinese characters are compact, unframed, single-line text');
  assert.equal(await page.locator('.voyage-space-hint kbd').textContent(),english?'Space':'空格');
  const state=await page.evaluate(()=>{const v=window.__entry.voyage;const cookie=v.windowLight.lights[0].map.image,ctx=cookie.getContext('2d'),corner=Array.from(ctx.getImageData(0,0,1,1).data);const routeRoot=v.model.getObjectByName('SV3_VoyageRouteStructure');return{count:v.floorCount.position.toArray(),camera:v.camera.position.toArray(),aim:v.aim.toArray(),cookies:v.windowLight.lights.map(l=>({name:l.map.name,penumbra:l.penumbra,flipY:l.map.flipY})),corner,piers:v.model.getObjectByName('SV3_CabinInterior').children.filter(o=>o.name.startsWith('SV3_CabinPierDetail_')).map(o=>o.name),routeObjects:routeRoot?.children.flatMap(child=>child.children.map(o=>o.name))??[]};});
  assert(state.count[0]>0,'role count is on the right');assert.deepEqual(state.piers,[],'retired bridge-dependent pier trim is absent from the cabin');
  assert(['SV3_RouteInteriorStructure','SV3_RouteExteriorStructure'].every(name=>state.routeObjects.includes(name)),'fused route structures are present in the real GLB');
  assert.deepEqual(state.corner,[0,0,0,255],'opaque cookie excludes the white cone outside the arch');assert(state.cookies.every(c=>c.penumbra>=.35&&!c.flipY));
  await page.screenshot({path:path.join(output,`cabin-details-${english?'en':'zh'}.png`)});
  // Verify the sleeping paper dolls through the real render path. The avatar
  // image cache alone is insufficient: the closed face must be handed to the
  // passenger canvas and actually drawn into the texture used by the mesh.
  const sleepers=await page.evaluate(()=>{
    const entry=window.__entry,v=entry.voyage,characters=Array.isArray(entry.characters)?entry.characters:[];
    const slots=characters.filter(character=>character?.id&&v.passengerSleeping(character.id));
    if(!slots.length)throw new Error('cabin has at least one sleeping passenger');
    const capture={frames:[],draws:[]};
    window.__sleepCapture=capture;
    const originalSet=v.setPassengerFrame;
    v.setPassengerFrame=function(id,parts,bounds){capture.frames.push({id,parts:parts.map(part=>({name:part.key,part:part.part,url:part.url,x:part.x,y:part.y,width:part.width,height:part.height}))});return originalSet.call(this,id,parts,bounds);};
    window.__sleepOriginalSet=originalSet;
    const context=window.CanvasRenderingContext2D?.prototype;
    if(context?.drawImage){
      const originalDraw=context.drawImage;
      window.__sleepOriginalDraw=originalDraw;
      context.drawImage=function(image,...args){
        const hit=slots.find(character=>v.passengers.dolls.get(character.id)?.canvas===this.canvas);
        if(hit)capture.draws.push({id:hit.id,src:String(image?.src??'')});
        return originalDraw.apply(this,[image,...args]);
      };
    }
    entry.renderPreviews();
    return slots.map(character=>{const closed=entry.closedFaces?.[String(character.appearance?.face)];return{id:character.id,index:characters.indexOf(character),face:character.appearance?.face,closedUrl:closed?.url??''};});
  });
  assert(sleepers.length>0,'sleeping passengers are present in the actual cabin');
  assert(sleepers.every(s=>s.closedUrl),'every sleeping passenger has a closed-face source');
  await page.waitForFunction(expected=>{
    const pathOf=value=>{try{return new URL(value,location.href).pathname;}catch{return value;}};
    const c=window.__sleepCapture;
    return Boolean(c)&&expected.every(item=>c.frames.some(frame=>frame.id===item.id&&frame.parts.some(part=>part.part==='face'&&pathOf(part.url)===pathOf(item.closedUrl)))&&c.draws.some(draw=>draw.id===item.id&&pathOf(draw.src)===pathOf(item.closedUrl)));
  },sleepers,{timeout:15000});
  const sleeperEvidence=await page.evaluate(expected=>{
    const entry=window.__entry,v=entry.voyage,T=window.__three,c=window.__sleepCapture;
    const require=(condition,message)=>{if(!condition)throw new Error(message);};
    const pathOf=value=>{try{return new URL(value,location.href).pathname;}catch{return value;}};
    const project=(point,width,height)=>{const p=point.clone().project(v.camera);return{x:(p.x+1)*width/2,y:(1-p.y)*height/2,z:p.z};};
    const boxCorners=box=>{const result=[];for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z])result.push(new T.Vector3(x,y,z));return result;};
    const projectBox=(box,width,height)=>{const points=boxCorners(box).map(point=>project(point,width,height));return{left:Math.min(...points.map(point=>point.x)),right:Math.max(...points.map(point=>point.x)),top:Math.min(...points.map(point=>point.y)),bottom:Math.max(...points.map(point=>point.y)),points};};
    const localRange=(object,root)=>{if(!object)return undefined;const box=new T.Box3().setFromObject(object),points=boxCorners(box).map(point=>root.worldToLocal(point.clone()));return{min:[Math.min(...points.map(point=>point.x)),Math.min(...points.map(point=>point.y)),Math.min(...points.map(point=>point.z))],max:[Math.max(...points.map(point=>point.x)),Math.max(...points.map(point=>point.y)),Math.max(...points.map(point=>point.z))]};};
    const materialInfo=object=>{const entries=[];object?.traverse(node=>{const materials=node.material?(Array.isArray(node.material)?node.material:[node.material]):[];for(const material of materials)entries.push({object:node.name,visible:node.visible,renderOrder:node.renderOrder,material:{name:material.name,type:material.type,transparent:material.transparent,opacity:material.opacity,depthTest:material.depthTest,depthWrite:material.depthWrite,side:material.side,alphaTest:material.alphaTest,blending:material.blending,polygonOffset:material.polygonOffset,polygonOffsetFactor:material.polygonOffsetFactor,polygonOffsetUnits:material.polygonOffsetUnits}});});return entries;};
    const width=v.canvas.clientWidth||v.canvas.width,height=v.canvas.clientHeight||v.canvas.height;
    v.camera.updateMatrixWorld(true);v.model.updateWorldMatrix(true,true);v.passengers.root.updateWorldMatrix(true,true);
    const records=expected.map(item=>{
      const doll=v.passengers.dolls.get(item.id),mesh=doll?.mesh,geometry=mesh?.geometry,position=geometry?.attributes.position;
      require(doll&&mesh&&position,'sleeping passenger has a rendered mesh');
      mesh.updateWorldMatrix(true,true);
      const headPoints=[];
      for(let index=0;index<position.count;index++)if((doll.restY?.[index]??position.getY(index))>=.2)headPoints.push(new T.Vector3().fromBufferAttribute(position,index).applyMatrix4(mesh.matrixWorld));
      require(headPoints.length>0,'sleeping passenger head rows exist');
      const headBox=new T.Box3().setFromPoints(headPoints),headCenter=headBox.getCenter(new T.Vector3());
      const quilt=v.model.getObjectByName(`SV3_Berth_${item.index}_Quilt`);
      require(quilt,'sleeping passenger target berth has its authored quilt');quilt.updateWorldMatrix(true,true);
      const quiltBox=new T.Box3().setFromObject(quilt),quiltCenter=quiltBox.getCenter(new T.Vector3()),quiltSize=quiltBox.getSize(new T.Vector3());
      const headScreen=projectBox(headBox,width,height),quiltScreen=projectBox(quiltBox,width,height),screenCenter=project(headCenter,width,height),quiltSpan=Math.max(quiltScreen.right-quiltScreen.left,quiltScreen.bottom-quiltScreen.top),screenMargin=Math.max(8,quiltSpan*.2),horizontalDistance=Math.hypot(headCenter.x-quiltCenter.x,headCenter.z-quiltCenter.z),horizontalLimit=Math.max(quiltSize.x,quiltSize.z)*.75,verticalMargin=Math.max(quiltSize.y,quiltSize.length()*.08),alpha=Array.from(doll.canvas.getContext('2d').getImageData(0,0,doll.canvas.width,doll.canvas.height).data).filter((value,index)=>index%4===3&&value>32).length;
      const frameParts=c.frames.filter(frame=>frame.id===item.id).at(-1)?.parts??[],faceParts=frameParts.filter(part=>part.part==='face'&&pathOf(part.url)===pathOf(item.closedUrl)),faceTop=Math.min(...faceParts.map(part=>part.y)),faceBottom=Math.max(...faceParts.map(part=>part.y+(part.height??0))),faceRestY=[.5-(faceTop-(doll.bounds?.top??0))/doll.canvas.height,.5-(faceBottom-(doll.bounds?.top??0))/doll.canvas.height],restY=Array.from(doll.restY??[]),currentY=Array.from({length:position.count},(_,index)=>position.getY(index)),bedRoot=v.model.getObjectByName(`SV2_Bed_${item.index}`),berthBed=v.model.getObjectByName(`SV3_Berth_${item.index}_Bed`),frame=v.model.getObjectByName(`SV3_Berth_${item.index}_Frame`),sleepAnchor=v.model.getObjectByName(`SV2_Bed_${item.index}_SleepAnchor`);
      const bodySourceY=-16,bodyTargetRestY=.5-(bodySourceY-(doll.bounds?.top??0))/doll.canvas.height,bodyRowRestY=restY.reduce((closest,value)=>Math.abs(value-bodyTargetRestY)<Math.abs(closest-bodyTargetRestY)?value:closest,restY[0]),bodyRowIndices=restY.map((value,index)=>Math.abs(value-bodyRowRestY)<1e-6?index:-1).filter(index=>index>=0),bodyWorldPoints=bodyRowIndices.map(index=>new T.Vector3().fromBufferAttribute(position,index).applyMatrix4(mesh.matrixWorld)),bodyBedLocalPoints=bedRoot?bodyWorldPoints.map(point=>bedRoot.worldToLocal(point.clone())):[],bodyPoint=bodyWorldPoints.reduce((sum,point)=>sum.add(point.clone()),new T.Vector3()).multiplyScalar(1/bodyWorldPoints.length),bodyNdc=bodyPoint.clone().project(v.camera),bodyRaycaster=new T.Raycaster();bodyRaycaster.setFromCamera({x:bodyNdc.x,y:bodyNdc.y},v.camera);const bodyHits=bodyRaycaster.intersectObject(quilt,true),bodyDistance=bodyRaycaster.ray.origin.distanceTo(bodyPoint),renderProbe=[],originalRenderBufferDirect=v.renderer.renderBufferDirect;
      if(originalRenderBufferDirect){const gl=v.renderer.getContext();v.renderer.renderBufferDirect=function(camera,scene,geometry,material,object,...args){if(object===quilt||object===mesh)renderProbe.push({object:object.name,material:material.name,transparent:material.transparent,renderOrder:object.renderOrder,gl:{depthTest:gl.isEnabled(gl.DEPTH_TEST),depthWrite:gl.getParameter(gl.DEPTH_WRITEMASK),depthFunc:gl.getParameter(gl.DEPTH_FUNC),colorMask:gl.getParameter(gl.COLOR_WRITEMASK)}});return originalRenderBufferDirect.call(this,camera,scene,geometry,material,object,...args);};v.renderer.render(v.scene,v.camera);v.renderer.renderBufferDirect=originalRenderBufferDirect;}
      const bodyRay={sourceY:bodySourceY,bodyTargetRestY,bodyRowRestY,indices:bodyRowIndices,world:bodyWorldPoints.map(point=>point.toArray()),bedLocal:bodyBedLocalPoints.map(point=>point.toArray()),point:bodyPoint.toArray(),ndc:{x:bodyNdc.x,y:bodyNdc.y,z:bodyNdc.z},distance:bodyDistance,quiltHits:bodyHits.slice(0,5).map(hit=>({distance:hit.distance,object:hit.object.name,point:hit.point.toArray(),local:bedRoot?.worldToLocal(hit.point.clone()).toArray()})),renderProbe};
      require(alpha>0,'sleeping passenger canvas contains visible ink');
      require(headScreen.right>0&&headScreen.left<width&&headScreen.bottom>0&&headScreen.top<height&&screenCenter.z>=-1&&screenCenter.z<=1,'sleeping passenger head is visible in the camera projection');
      require(screenCenter.x>=quiltScreen.left-screenMargin&&screenCenter.x<=quiltScreen.right+screenMargin&&screenCenter.y>=quiltScreen.top-screenMargin&&screenCenter.y<=quiltScreen.bottom+screenMargin,`sleeping passenger head projects over its actual quilt: ${JSON.stringify({id:item.id,index:item.index,screenCenter,quiltScreen,screenMargin,headScreen,bounds:doll.bounds,bodyCenter:doll.bodyCenter?.toArray(),meshScale:mesh.scale.toArray(),meshPosition:mesh.position.toArray(),faceParts,faceRestY,restY,currentY})}`);
      require(horizontalDistance<=horizontalLimit,'sleeping passenger head remains over its actual berth footprint');
      require(headCenter.y>=quiltBox.min.y-verticalMargin&&headCenter.y<=quiltBox.max.y+verticalMargin,'sleeping passenger head remains at the quilt height');
      const sleepIndex=doll.sleepIndex,headBottom=doll.headBottom??0,neckRows=doll.neckRows??0,sleepTriangles=[];
      if(sleepIndex)for(let index=0;index<sleepIndex.count;index+=3){const indices=[sleepIndex.getX(index),sleepIndex.getX(index+1),sleepIndex.getX(index+2)],rows=indices.map(vertex=>doll.restY?.[vertex]??0),min=Math.min(...rows),max=Math.max(...rows);sleepTriangles.push({indices,rows,min,max,valid:min>=headBottom||max<=headBottom-neckRows});}
      return{...item,sleeping:v.passengerSleeping(item.id),canvas:{width:doll.canvas.width,height:doll.canvas.height,alpha},parts:frameParts,headBottom:doll.headBottom,neckRows:doll.neckRows,faceRestY,restY,currentY,sleepTopology:{indexCount:sleepIndex?.count??0,triangleCount:sleepTriangles.length,crossing:sleepTriangles.filter(triangle=>!triangle.valid),triangles:sleepTriangles},head:{worldMin:headBox.min.toArray(),worldMax:headBox.max.toArray(),screen:{left:headScreen.left,top:headScreen.top,right:headScreen.right,bottom:headScreen.bottom,center:screenCenter}},quilt:{name:quilt.name,worldMin:quiltBox.min.toArray(),worldMax:quiltBox.max.toArray(),local:localRange(quilt,bedRoot),screen:{left:quiltScreen.left,top:quiltScreen.top,right:quiltScreen.right,bottom:quiltScreen.bottom},size:quiltSize.toArray(),materials:materialInfo(quilt)},bedLocal:localRange(berthBed,bedRoot),frameLocal:localRange(frame,bedRoot),sleepAnchorLocal:sleepAnchor&&bedRoot.worldToLocal(sleepAnchor.getWorldPosition(new T.Vector3())).toArray(),pillowNode:null,pillowNote:'The authored GLB has no separate pillow node; the quilt and berth ranges above are the actual bed geometry.',bodyMid:bodyRay,passengerMesh:{renderOrder:mesh.renderOrder,materials:materialInfo(mesh)},renderer:{sortObjects:v.renderer.sortObjects,autoClear:v.renderer.autoClear},drawnFace:c.draws.filter(draw=>draw.id===item.id&&pathOf(draw.src)===pathOf(item.closedUrl)).length,framedFace:c.frames.filter(frame=>frame.id===item.id).flatMap(frame=>frame.parts).filter(part=>part.part==='face'&&pathOf(part.url)===pathOf(item.closedUrl)).length};
    });
    const savedPassengerStage=v.passengers.stage,savedPassengerSelected=v.passengers.selected,savedPassengerPage=v.passengers.page,passengerIds=entry.characters.map(character=>character.id),awakeProbeId=expected[0].id;
    v.passengers.setSlots(passengerIds,awakeProbeId,'characters',savedPassengerPage);v.passengers.finishWake();v.passengers.update(0,true,v.model,v.camera,performance.now());
    const awakeProbe=v.passengers.dolls.get(awakeProbeId),awakeRestored=Boolean(awakeProbe?.standingIndex&&awakeProbe.mesh.geometry.index===awakeProbe.standingIndex);
    v.passengers.setSlots(passengerIds,savedPassengerSelected,savedPassengerStage,savedPassengerPage);v.passengers.finishWake();v.passengers.update(0,true,v.model,v.camera,performance.now());
    for(const record of records)record.sleepTopology.awakeRestored=awakeRestored;
    if(!awakeRestored)throw new Error('awake passenger update did not restore the standing index');
    if(records.some(record=>record.sleepTopology.crossing.length))throw new Error('sleep index contains a triangle crossing the head/neck boundary');
    if(window.__sleepOriginalDraw)window.CanvasRenderingContext2D.prototype.drawImage=window.__sleepOriginalDraw;
    if(window.__sleepOriginalSet){v.setPassengerFrame=window.__sleepOriginalSet;delete window.__sleepOriginalSet;}
    delete window.__sleepOriginalDraw;
    return records;
  },sleepers);
  assert(sleeperEvidence.every(item=>item.drawnFace>0&&item.framedFace>0),'closed-face pixels were drawn into every sleeping passenger canvas');
  await page.screenshot({path:path.join(output,`cabin-sleepers-${english?'en':'zh'}.png`)});
  // Use the first real sleeper's own projected head/quilt pair for a close
  // inspection, then restore every camera and scene field before the rest of
  // the lifecycle check continues.
  const nearSleeper=sleeperEvidence[0];
  try {
    await page.evaluate(item=>{
      const v=window.__entry.voyage,T=window.__three,doll=v.passengers.dolls.get(item.id),mesh=doll.mesh,position=mesh.geometry.attributes.position,points=[];
      mesh.updateWorldMatrix(true,true);for(let index=0;index<position.count;index++)if((doll.restY?.[index]??position.getY(index))>=.2)points.push(new T.Vector3().fromBufferAttribute(position,index).applyMatrix4(mesh.matrixWorld));
      const head=new T.Box3().setFromPoints(points),quilt=v.model.getObjectByName(`SV3_Berth_${item.index}_Quilt`),quiltBox=new T.Box3().setFromObject(quilt),target=head.getCenter(new T.Vector3()),direction=v.camera.position.clone().sub(quiltBox.getCenter(new T.Vector3())).normalize(),distance=Math.max(quiltBox.getSize(new T.Vector3()).length()*2.5,3);
      window.__sleepViewState={cameraPosition:v.camera.position.toArray(),cameraQuaternion:v.camera.quaternion.toArray(),aim:v.aim.toArray(),yaw:v.yaw,pitch:v.pitch,zoom:v.zoom,inspection:v.inspection,draw:v.draw,frame:v.frame,background:v.scene.background,fog:v.scene.fog,visible:v.scene.children.map(child=>[child.id,child.visible])};
      cancelAnimationFrame(v.frame);v.frame=0;v.draw=()=>{};v.camera.position.copy(target).add(direction.multiplyScalar(distance));v.camera.lookAt(target);v.camera.updateMatrixWorld(true);v.renderer.render(v.scene,v.camera);
    },nearSleeper);
    await page.locator('.voyage-canvas').screenshot({path:path.join(output,`cabin-sleeper-head-${english?'en':'zh'}.png`)});
  } finally {
    await page.evaluate(()=>{const v=window.__entry.voyage,s=window.__sleepViewState;if(!s)return;v.camera.position.fromArray(s.cameraPosition);v.camera.quaternion.fromArray(s.cameraQuaternion);v.aim.fromArray(s.aim);v.yaw=s.yaw;v.pitch=s.pitch;v.zoom=s.zoom;v.inspection=s.inspection;v.scene.background=s.background;v.scene.fog=s.fog;for(const [id,visible] of s.visible){const child=v.scene.getObjectById(id);if(child)child.visible=visible;}v.draw=s.draw;v.frame=0;v.updateActivity();delete window.__sleepViewState;});
  }
  // Move close enough to display an actual contextual interaction label.
  await page.evaluate(()=>{const v=window.__entry.voyage,T=window.__three,a=v.model.getObjectByName('SV2_Bed_7_FootAnchor');const p=v.ship.worldToLocal(a.getWorldPosition(new T.Vector3())).add(new T.Vector3(0,0,.6));p.y=.025;v.cabinDeck.place(p);v.passengers.finishWake();v.updateActivity();});
  await page.waitForFunction(()=>{const v=window.__entry.voyage;return v.nearInteraction==='create-character'&&!document.querySelector('.voyage-space-hint').hidden;});
  assert.equal(await page.locator('[data-role="space-label"]').textContent(),english?'Create character':'创建角色');
  await page.screenshot({path:path.join(output,`cabin-interaction-${english?'en':'zh'}.png`)});
  if(!english) await captureMastLinks(page,output);
  assert.deepEqual(errors,[]);await fs.writeFile(path.join(output,`details-${english?'en':'zh'}.json`),JSON.stringify({labels,state,sleepers:sleeperEvidence,errors},null,2),'utf8');
  console.log(`PASS retained mast detail, cabin columns/count/light aperture, compact seven-character/English names and ${english?'English':'Chinese'} Space interaction`);
}

export async function captureMastLinks(page,output) {
  await page.evaluate(()=>window.__entry.go('channel'));
  await page.waitForFunction(()=>!window.__entry.voyage.transition);
  await page.waitForTimeout(150);
  await page.evaluate(()=>{const v=window.__entry.voyage;cancelAnimationFrame(v.frame);v.draw=()=>{};v.reveal.strength.value=0;for(const m of v.reveal.hidden.keys())m.visible=true;for(const e of document.querySelectorAll('body *'))e.style.visibility=e===v.canvas?'visible':'hidden';for(const c of v.scene.children)if(c!==v.model&&!c.isLight)c.visible=false;v.model.visible=true;for(const c of v.model.children)c.visible=c===v.ship||c.getObjectById(v.ship.id)!==undefined;v.ship.visible=true;v.scene.background=new window.__three.Color('#aaa89e');v.scene.fog=null;});
  for(const sail of [1,.35,0]) {
    await page.evaluate(sail=>{const v=window.__entry.voyage,T=window.__three;cancelAnimationFrame(v.frame);v.flight.setControls({sail,wind:0});v.flight.update(0,true);v.ship.updateWorldMatrix(true,true);v.updateSails(0,v.flight.time);const centre=v.ship.localToWorld(new T.Vector3(0,40,3));const camera=new T.OrthographicCamera(-90,90,56.25,-56.25,.1,2000);camera.position.copy(centre).add(new T.Vector3(220,80,180));camera.lookAt(centre);camera.updateMatrixWorld(true);v.renderer.render(v.scene,camera);},sail);
    await page.locator('.voyage-canvas').screenshot({path:path.join(output,`mast-links-sail-${sail}.png`)});
  }
}
