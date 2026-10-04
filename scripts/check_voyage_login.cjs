const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'build/.checks/voyage-login.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
createRequire(path.join(root, 'client/package.json'))('esbuild').buildSync({ stdin: { contents: "export * from './voyage-deck'; export * from './voyage-login'; export * from './voyage-passengers'; export { voyageOpeningPose } from './voyage'; export * as Three from 'three';", resolveDir: path.join(root, 'client/src/features/entry'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: output, logLevel: 'silent' });
const { Three: T, projectLoginSurface, loginSurfaceOccluded, VoyageLogin, voyageOpeningPose, VoyagePassengers, wakePose, VoyageDeck } = require(output);
// Decode the real authored GLB without textures/GPU: collision, route and
// foot support still use production Three geometry and transforms.
const bytes=fs.readFileSync(path.join(root,'resources/scenes/sky-voyage-v3/models/sky-voyage.glb'));
const jsonLength=bytes.readUInt32LE(12),gltf=JSON.parse(bytes.subarray(20,20+jsonLength)),binary=bytes.subarray(28+jsonLength);
const attribute=index=>{const a=gltf.accessors[index],v=gltf.bufferViews[a.bufferView],ArrayType={5126:Float32Array,5125:Uint32Array,5123:Uint16Array,5121:Uint8Array}[a.componentType];return new T.BufferAttribute(new ArrayType(binary.buffer,binary.byteOffset+(v.byteOffset||0)+(a.byteOffset||0),a.count*({SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[a.type])),{SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[a.type]);};
const objects=gltf.nodes.map(node=>{const object=new T.Group();object.name=node.name;object.userData=node.extras||{};if(node.translation)object.position.fromArray(node.translation);if(node.rotation)object.quaternion.fromArray(node.rotation);if(node.scale)object.scale.fromArray(node.scale);if(node.matrix){object.matrix.fromArray(node.matrix);object.matrix.decompose(object.position,object.quaternion,object.scale);}if(node.mesh!==undefined)for(const primitive of gltf.meshes[node.mesh].primitives){const geometry=new T.BufferGeometry();geometry.setAttribute('position',attribute(primitive.attributes.POSITION));if(primitive.indices!==undefined)geometry.setIndex(attribute(primitive.indices));object.add(new T.Mesh(geometry,new T.MeshBasicMaterial()));}return object;});
gltf.nodes.forEach((node,index)=>(node.children||[]).forEach(child=>objects[index].add(objects[child])));
const deckShip=objects.find(object=>object.name==='SV2_Ship');deckShip.scale.setScalar(2);deckShip.updateWorldMatrix(true,true);
assert(!objects.some(o=>o.name.startsWith('SV3_Reference_')),'rejected replacement geometry is absent');
const stern=deckShip.getObjectByName('SV3_Hull_SternPlatform');
assert(stern&&stern.userData.original_part==='SternPlatform','original stern faces form a separate editable platform');
assert(deckShip.getObjectByName('SV3_Repaired_SternRoofDeck'),'retained platform roof is restored');
for(const side of ['Port','Starboard']) {
  const engine=deckShip.getObjectByName('SV3_Engine_'+side);
  for(const part of ['MetalBand','EndCap'])assert(engine.getObjectByName(engine.name+'_'+part),'original engine regions are separated');
  assert(deckShip.getObjectByName('SV3_Wheel_'+side+'_TimberSpokesAndHub'),'retained wheel ribs and hub are present');
  const wheel=deckShip.getObjectByName('SV3_Wheel_'+side);
  assert.equal(wheel.userData.wheel_contour,'centrally symmetric swept blades');
  const positions=wheel.children.find(o=>o.isMesh).geometry.getAttribute('position');
  const points=Array.from({length:positions.count},(_,i)=>new T.Vector3().fromBufferAttribute(positions,i));
  const key=p=>p.toArray().map(x=>Math.round(x*1000)).join(',');
  const pointSet=new Set(points.map(key));
  for(const p of points)assert(pointSet.has(key(new T.Vector3(p.x,-p.y,-p.z))),'opposite wheel blades retain central symmetry');
  const outer=points.map(p=>Math.hypot(p.y,p.z)).filter(r=>r>8.5);
  assert(Math.max(...outer)-Math.min(...outer)>1,'wheel outer silhouette has unequal blade lengths');
}
const sockets=deckShip.getObjectByName('SV3_Repaired_WheelHullSockets');
assert.equal(sockets.userData.removed_backing_disks,2);
const socketSize=new T.Box3().setFromObject(sockets).getSize(new T.Vector3());
assert(socketSize.y<6&&socketSize.z<6,'only narrow axles remain, without the large backing disks');
const walkCamera=new T.PerspectiveCamera();walkCamera.position.set(0,15,35);walkCamera.lookAt(0,10,0);walkCamera.updateMatrixWorld(true);
const deck=new VoyageDeck(deckShip),cabinDeck=new VoyageDeck(deckShip,true);
assert(!deckShip.getObjectByName('SV3_CaptainFloor')&&!deckShip.getObjectByName('SV3_CaptainDoorThreshold'),'obsolete walk-in room geometry is absent');
assert(deckShip.getObjectByName('SV3_CaptainDoorSeal'),'exterior opening is sealed in the actual export');
const followRoute=surface=>{surface.place(surface.route[0]);for(const target of surface.route.slice(1)){let steps=0;while(Math.hypot(target.x-surface.position.x,target.z-surface.position.z)>.03){const direction=target.clone().sub(surface.position);direction.y=0;direction.normalize();surface.update(.01,direction.x,direction.z,walkCamera,deckShip);assert(surface.moving,'fixed route must be continuously walkable');assert(Math.hypot(surface.position.x-surface.routePoint(surface.position).x,surface.position.z-surface.routePoint(surface.position).z)<1e-7,'feet stay on the authored fixed line');assert(++steps<2000,'route segment cannot stall');}}};
followRoute(cabinDeck);
assert(deckShip.getObjectByName('SV3_MainDeck_Surface'),'visible main deck is authored in the real model');
assert(!objects.some(o=>o.name.startsWith('SV3_CaptainArcWalkway')),'the narrow arc is removed from the real model');
const loopLength=86;
for(const sign of [1,-1]) {
  deck.reset();
  const direction=deck.ringChoices(walkCamera,deckShip).find(c=>c.sign===sign).direction;
  const [horizontal,vertical]={left:[-1,0],right:[1,0],up:[0,-1],down:[0,1]}[direction];
  const touched=new Set();
  for(let i=0;i<Math.ceil(loopLength*2/.03);i++) {
    deck.update(.01,horizontal,vertical,walkCamera,deckShip);
    assert(deck.moving,'held input must continue through all four corners and the closed seam');
    assert(Math.hypot(deck.position.x-deck.routePoint(deck.position).x,deck.position.z-deck.routePoint(deck.position).z)<1e-7,'feet stay on the closed main deck line');
    const support=deck.ground(deck.position.x,deck.position.z,deck.position.y+.4,.8);
    assert(Math.abs(deck.position.y-support-.025)<1e-5,'feet sit on the visible deck without embedding');
    deck.route.slice(1,-1).forEach((p,j)=>{if(p.distanceTo(deck.position)<.08)touched.add(j);});
  }
  assert.equal(touched.size,4,'both orientations visit every corner');
  assert(deck.position.distanceTo(deck.spawn)<.04,'two full circuits carry residual travel across the seam');
}
assert.equal(deck.place(new T.Vector3(0,0,10)),false,'sealed cabin cannot be entered through a wall');
assert.equal(deck.place(new T.Vector3(20,0,0)),false,'outside hull cannot become a walk position');
assert.equal(deck.place(new T.Vector3(-7.9,0,-8)),false,'outside the route cannot become a walk position');
assert.equal(deck.canStand(new T.Vector3(-7.9,5.48,-8),5.48),false,'foot disk cannot hang over the visible deck boundary');
assert.equal(deck.canStand(new T.Vector3(4.9,5.48,13.25),5.48),false,'actual cabin wall blocks the body');
for(const sign of [-1,1]) {
  cabinDeck.reset();const start=cabinDeck.position.clone();
  for(let i=0;i<100;i++)cabinDeck.update(.01,sign,0,walkCamera,deckShip);
  assert((cabinDeck.position.x-start.x)*sign>2.9,'both horizontal keys move immediately after entering the selection cabin');
  assert(Math.abs(cabinDeck.position.z-start.z)<1e-7,'horizontal movement remains in the real bed aisle');
}

for(let i=0;i<12;i++){const anchor=deckShip.getObjectByName(`SV2_Bed_${i}_FootAnchor`),point=deckShip.worldToLocal(anchor.getWorldPosition(new T.Vector3())).add(new T.Vector3(0,0,.6));point.y=0;cabinDeck.place(point);assert(cabinDeck.position.distanceTo(point)<.03,'all twelve bed interactions are reachable on the door-facing aisle');}
const left=cabinDeck.route[2];cabinDeck.place(left);for(let i=0;i<120;i++)cabinDeck.update(.05,0,-1,walkCamera,deckShip);assert(cabinDeck.position.distanceTo(left)<.03,'forward input cannot leave the aisle and cross beds');
deck.reset();const landing=deck.position.y;deck.jump();deck.update(.05,0,0,walkCamera,deckShip);assert(deck.jumping&&deck.position.y>landing);const velocity=deck.jumpVelocity;deck.jump();assert.equal(deck.jumpVelocity,velocity,'airborne repeat cannot restart a jump');for(let i=0;i<60;i++)deck.update(.05,0,0,walkCamera,deckShip);assert(Math.abs(deck.position.y-landing)<1e-7);
deck.reset();deck.update(NaN,1,0,walkCamera,deckShip);assert.deepEqual(deck.position.toArray(),deck.spawn.toArray());
deck.destroy();cabinDeck.destroy();
console.log('Actual ship export: closed main deck loop in both directions, sealed-room and rail boundaries, grounded feet, twelve bed-side positions and jump landing passed');
// Dense samples catch a hard cut; settling must reach the exact final pose with near-zero speed.
let previousPose = voyageOpeningPose(0);
for (let i = 1; i <= 2400; i++) {
  const pose = voyageOpeningPose(i / 2400);
  assert(pose.eye.toArray().concat(pose.aim.toArray()).every(Number.isFinite));
  assert(pose.eye.distanceTo(previousPose.eye) < 2.4 && pose.aim.distanceTo(previousPose.aim) < 1.4, 'continuous one-take path cannot jump');
  previousPose = pose;
}
assert(previousPose.eye.distanceTo(new T.Vector3(.2,14.4,18))<1e-10);
assert(voyageOpeningPose(.9999).eye.distanceTo(previousPose.eye) < .00001, 'the final approach settles without a snap');
const viewport = { width: 1440, height: 900 }, pixels = { width: 430, height: 360 };
const camera = new T.PerspectiveCamera(46, viewport.width / viewport.height, 1, 1000);
camera.position.set(1, 2, 14); camera.lookAt(0, 1, 0);
const ship = new T.Group(), anchor = new T.Object3D(); ship.add(anchor);
const surface = { anchor, width: 5, height: 4 };
anchor.position.set(-1, 1, 0); ship.rotation.set(.05, .4, -.08); ship.scale.set(1.2, .8, 1.1);
const close = (actual, expected) => assert(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
const at = (matrix, x, y) => new T.Vector3(x, y, 0).applyMatrix4(matrix);
const projection = projectLoginSurface(surface, camera, viewport, pixels);
assert(projection, 'authored surface must project from its front');
// Independent world-space corners prove the CSS matrix includes ship rotation/scale and camera perspective.
const scale = Math.min(5 / 430, 4 / 360);
for (const [x, y] of [[0, 0], [430, 0], [430, 360], [0, 360], [100, 90]]) {
  const world = new T.Vector3((x - 215) * scale, (180 - y) * scale, 0).applyMatrix4(anchor.matrixWorld).project(camera);
  const css = at(projection.matrix, x, y);
  close(css.x, (world.x + 1) * 720); close(css.y, (1 - world.y) * 450);
}
assert(Math.abs(projection.matrix.elements[3]) > 1e-5, 'an angled sign must have perspective division, not screen translation');
const leftHeight = at(projection.matrix, 0, 0).distanceTo(at(projection.matrix, 0, 360));
const rightHeight = at(projection.matrix, 430, 0).distanceTo(at(projection.matrix, 430, 360));
assert(Math.abs(leftHeight - rightHeight) > 1, 'the far edge must foreshorten');
ship.position.x += 2;
const moved = projectLoginSurface(surface, camera, viewport, pixels);
assert(moved && Math.abs(at(moved.matrix, 215, 180).x - at(projection.matrix, 215, 180).x) > 10, 'a moving ship moves the form');
const resized = projectLoginSurface(surface, camera, { width: 720, height: 450 }, pixels);
close(at(resized.matrix, 215, 180).x, at(moved.matrix, 215, 180).x / 2);
ship.visible = false; assert.equal(projectLoginSurface(surface, camera, viewport, pixels), undefined); ship.visible = true;
for (const width of [0, -1, NaN, Infinity]) assert.equal(projectLoginSurface({ ...surface, width }, camera, viewport, pixels), undefined);
assert.equal(projectLoginSurface(surface, camera, viewport, { ...pixels, height: 0 }), undefined);
ship.scale.x = 0; assert.equal(projectLoginSurface(surface, camera, viewport, pixels), undefined); ship.scale.set(1, 1, 1);
ship.rotation.set(0, 0, 0); ship.position.set(0, 0, 0); anchor.position.set(0, 0, -10);
camera.position.set(0, 0, 0); camera.lookAt(0, 0, -1);
const front = projectLoginSurface(surface, camera, viewport, pixels); assert(front);
anchor.rotation.y = Math.PI; assert.equal(projectLoginSurface(surface, camera, viewport, pixels), undefined); anchor.rotation.y = 0;
anchor.position.z = -.5; assert.equal(projectLoginSurface(surface, camera, viewport, pixels), undefined, 'near-plane crossing is hidden');
anchor.position.z = -1002; assert.equal(projectLoginSurface(surface, camera, viewport, pixels), undefined, 'far-plane clipping is hidden');
anchor.position.set(1000, 0, -10); assert.equal(projectLoginSurface(surface, camera, viewport, pixels), undefined, 'offscreen forms cannot intercept input');
anchor.position.set(5, 0, -10); assert(projectLoginSurface(surface, camera, viewport, pixels), 'partially visible plane stays perspective-correct');
anchor.position.set(NaN, 0, -10); assert.equal(projectLoginSurface(surface, camera, viewport, pixels), undefined);
anchor.position.set(0, 0, -10);
const blocker = new T.Mesh(new T.BoxGeometry(6, 6, .2), new T.MeshBasicMaterial()), cover = new T.Group(); cover.add(blocker);
blocker.position.z = -5;
assert(loginSurfaceOccluded(camera, front.points, [cover]), 'opaque geometry in front hides the form');
cover.visible = false; assert(!loginSurfaceOccluded(camera, front.points, [cover]), 'hidden ancestors cannot occlude'); cover.visible = true;
blocker.position.z = -12; assert(!loginSurfaceOccluded(camera, front.points, [cover]), 'backing behind the surface cannot occlude');
blocker.position.z = -.5; assert(!loginSurfaceOccluded(camera, front.points, [cover]), 'geometry clipped before camera near cannot occlude');
blocker.position.z = -5; blocker.material.transparent = true; assert(!loginSurfaceOccluded(camera, front.points, [cover]), 'glass is not an opaque blocker'); blocker.material.transparent = false;
blocker.layers.set(2); assert(!loginSurfaceOccluded(camera, front.points, [cover]), 'camera layer masks match WebGL'); blocker.layers.set(0);
blocker.position.set(1.18, .98, -5); blocker.scale.set(.1, .1, 1);
assert(loginSurfaceOccluded(camera, front.points, [cover]), 'corner obstruction cannot leave a clickable form on top of geometry');

// Minimal DOM stand-in checks lifecycle and input ownership; browser interaction is an integration check.
const makeForm = () => {
  const form = { style: { cssText: 'color:red' }, inert: false, offsetWidth: 430, offsetHeight: 360, classList: {add(){},remove(){}}, listeners: new Map(), addEventListener(type, fn) { this.listeners.set(type, fn); }, removeEventListener(type, fn) { if (this.listeners.get(type) === fn) this.listeners.delete(type); } };
  form.querySelectorAll=()=>[{offsetParent:form,offsetWidth:300,offsetHeight:52,offsetLeft:22,offsetTop:220,classList:{contains:()=>true},matches:()=>false}];return form;
};
let form = makeForm();
const submit = () => {}; form.addEventListener('submit', submit);
const host = { clientWidth: 1440, clientHeight: 900, querySelector: () => form };
const login = new VoyageLogin(host);
assert(login.update(camera, surface)); assert.equal(form.listeners.get('submit'), submit);
assert.match(form.style.transform, /^matrix3d\(/); assert.equal(form.inert, false);
const button=anchor.children.find(n=>n.name==='SV3_LoginButton_0');assert(button);
button.geometry.computeBoundingBox();assert(button.geometry.boundingBox.max.z-button.geometry.boundingBox.min.z>.09, 'native buttons have real beveled 3D depth');
assert.equal(form.listeners.has('keydown'),false,'typing cannot skip or snap the camera');
anchor.rotation.y = Math.PI; assert.equal(login.update(camera, surface), false); assert.equal(form.inert, true); assert.equal(form.style.pointerEvents, 'none'); anchor.rotation.y = 0;
assert(login.update(camera, surface)); assert.equal(form.inert, false, 'returning to the front restores native input');
const previous = form; form = makeForm(); assert(login.update(camera, surface));
assert.equal(previous.style.cssText, 'color:red'); assert(!previous.listeners.has('keydown')); assert.equal(previous.listeners.get('submit'), submit);
login.update(camera); assert.equal(form.style.cssText, 'color:red'); assert.equal(form.inert, false); assert.equal(form.listeners.size, 0);
assert.equal(anchor.children.length,0,'native button geometry is released with the form');
blocker.geometry.dispose(); blocker.material.dispose();
console.log('Voyage login perspective/ship motion/visibility/clipping/occlusion/DOM lifecycle checks passed');
(async () => {
  for (let variant = 0; variant < 3; variant++) {
    assert.equal(wakePose(variant, 0).progress, 0); assert.equal(wakePose(variant, 5).progress, 1);
    for (let i = 0; i < 100; i++) {
      const pose = wakePose(variant, i / 40);
      assert([pose.progress, pose.tilt, pose.roll, pose.lift].every(Number.isFinite));
    }
  }
  assert.equal(wakePose(1, .7).action, 'sit'); assert.equal(wakePose(2, .6).action, 'jump');
  let clockTime=0;
  const passengers = new VoyagePassengers(() => {},()=>clockTime), model = new T.Group(); passengers.attach(model);
  const deckDoll={group:new T.Group(),mesh:new T.Mesh(new T.PlaneGeometry(1,1,1,10),new T.MeshStandardMaterial()),zz:new T.Sprite()};
  deckDoll.group.add(deckDoll.mesh); passengers.root.add(deckDoll.group); passengers.dolls.set('a',deckDoll);
  passengers.setSlots(['a','b'],'a','channel',0); passengers.deckPosition.set(6,5.442377,12); passengers.deckMoving=true;
  camera.position.set(18,11,24);camera.lookAt(5,6.3,11);passengers.update(.1,false,model,camera,0);
  assert.equal(passengers.action('a'),'walk');assert.equal(passengers.action('b'),'stand');
  assert(deckDoll.group.quaternion.angleTo(camera.getWorldQuaternion(new T.Quaternion()))<1e-7,'walk sprite faces the complete game camera, preserving its screen-up foot anchor');
  assert.deepEqual(deckDoll.group.position.toArray(),passengers.deckPosition.toArray());
  for(let i=0;i<deckDoll.mesh.geometry.attributes.position.count;i++)assert(Math.abs(deckDoll.mesh.geometry.attributes.position.getZ(i))<1e-7,'deck sprite cannot retain bed deformation');
  passengers.dolls.delete('a');deckDoll.group.removeFromParent();deckDoll.mesh.geometry.dispose();deckDoll.mesh.material.dispose();deckDoll.zz.material.dispose();
  // Real setFrame must retain GPU storage dimensions across differently-sized walk frames.
  const ink=[];
  const context={clearRect(){ink.length=0;},drawImage(_image,x,y,w,h){ink.push({x,y,w,h});},fillText(){},getImageData(_x,_y,width,height){const data=new Uint8ClampedArray(width*height*4);for(const r of ink)for(let y=Math.max(0,Math.ceil(r.y));y<Math.min(height,r.y+r.h);y++)for(let x=Math.max(0,Math.ceil(r.x));x<Math.min(width,r.x+r.w);x++)data[(y*width+x)*4+3]=255;return{data};}};
  global.document={createElement:()=>({width:300,height:150,getContext:()=>context})};
  global.Image=class {width=32;height=48;set src(value){queueMicrotask(()=>this.onload());}};
  const part={key:'body',url:'/body.png',x:-16,y:-48,width:32,height:48,origin:{x:16,y:48},z:0};
  const bounds={left:-32,top:-64,right:48,bottom:4};
  await passengers.setFrame('a',[part],bounds);
  const doll=passengers.dolls.get('a'),texture=doll.texture,scale=doll.mesh.scale.clone(),offset=doll.mesh.position.clone();
  await passengers.setFrame('a',[{...part,x:-12,y:-44,width:40,height:44}],bounds);
  assert.equal(doll.texture,texture,'walk frames cannot resize immutable GPU texture storage');
  assert.deepEqual([doll.canvas.width,doll.canvas.height],[80,68]);
  assert(doll.mesh.scale.equals(scale)&&doll.mesh.position.equals(offset),'frame canvas preserves the same foot and aspect');
  let released=false;texture.addEventListener('dispose',()=>released=true);
  await passengers.setFrame('a',[{...part,x:-80,width:160}],{left:-80,top:-64,right:80,bottom:4});
  assert(released&&doll.texture!==texture,'a genuinely new appearance reallocates the texture safely');
  passengers.setSlots([],undefined,'login',0);

  passengers.setSlots(['a', 'b'], 'a', 'characters', 0);
  passengers.update(.4, false, model, camera, 0);
  const wake = { ...passengers.wake };
  passengers.setSlots(['a', 'b'], 'a', 'characters', 0);
  assert.deepEqual(passengers.wake, wake, 'rerenders cannot restart or randomize the same selection');
  // Local return animation cannot outlive selection, its 3-second deadline or the view.
  await passengers.setFrame('a',[part],bounds);await passengers.setFrame('b',[part],bounds);
  const bed=new T.Object3D();bed.name='SV2_Bed_1_SleepAnchor';bed.position.set(-4,.635,43);model.add(bed);
  passengers.finishWake();passengers.deckPosition.set(-10,0,35);passengers.update(.1,false,model,camera,0);
  const sleeper=passengers.dolls.get('b'),centre=sleeper.bodyCenter;
  const visibleCentre=new T.Vector3(centre.x,centre.y,0).applyMatrix4(sleeper.group.matrix);
  sleeper.group.updateMatrix();visibleCentre.set(centre.x,centre.y,0).applyMatrix4(sleeper.group.matrix);
  assert(Math.abs(visibleCentre.x-bed.position.x)<1e-6&&Math.abs(visibleCentre.z-bed.position.z)<1e-6,'visible sleeping body is centred on the actual bed anchor, not the foot/padded canvas');
  passengers.setSlots(['a','b'],'b','characters',0);assert(passengers.returning.has('a'));assert.equal(passengers.action('a'),'walk');
  passengers.update(2.7,false,model,camera,0);assert(passengers.returning.has('a'),'long walk stays local until requested deadline');
  clockTime=3001;passengers.update(.02,false,model,camera,0);assert(!passengers.returning.has('a')&&passengers.sleeping('a'),'3 seconds always returns the correct identity to its bed');
  passengers.finishWake();passengers.deckPosition.set(5,0,39);passengers.update(.1,false,model,camera,0);
  passengers.setSlots(['a','b'],'a','characters',0);assert(passengers.returning.has('b'));
  passengers.setSlots(['a','b'],'b','characters',0);assert(!passengers.returning.has('b'),'selecting a returning character cancels its old return');
  clockTime+=4000;passengers.update(.01,false,model,camera,0);assert(!passengers.returning.has('a'),'a clamped resume frame still enforces real elapsed deadline');
  passengers.setSlots(['a','b'],'b','channel',0);assert.equal(passengers.returning.size,0,'leaving the cabin cancels returns');
  passengers.setSlots(['a','b'],'a','characters',0);
  const departureBook = new T.Group(); departureBook.name = 'SV3_DepartureBook';
  const departurePage = new T.Group(); departurePage.name = 'SV3_BookPage'; departureBook.add(departurePage);
  const departureMesh = new T.Mesh(new T.BoxGeometry(.4, .06, .6), new T.MeshBasicMaterial()); departurePage.add(departureMesh);
  const departureClip = new T.AnimationClip('SV3_BookOpenFlipGlow', 2.1, [
    new T.VectorKeyframeTrack('SV3_BookPage.position', [0, 2.1], [0, 0, 0, 0, .2, 0]),
  ]);
  passengers.setBook(departureBook, departureClip);
  const cancelled = passengers.depart(); passengers.setSlots(['a', 'b'], 'b', 'characters', 0);
  assert.equal(await cancelled, false); assert(!model.getObjectByName('SV3_DepartureBook'));
  assert.equal(passengers.wake.seconds, 0); assert(passengers.returning.has('a') && !passengers.sleeping('b'));
  passengers.setSlots(['a', 'b'], 'a', 'characters', 0);
  const completed = passengers.depart();
  assert.equal(departureBook.parent, passengers.root, 'a cancelled book can be attached again');
  passengers.update(.5, false, model, camera, 0);
  assert(departurePage.position.y > 0, 'replayed departure drives the supplied animation clip');
  const towardDoll=passengers.dolls.get('a').group.position.clone().sub(departureBook.position);towardDoll.y=0;towardDoll.normalize();
  const pagesNormal=new T.Vector3(0,0,1).applyQuaternion(departureBook.quaternion);assert(pagesNormal.dot(towardDoll)>.98,'readable page normal faces the character while the existing animation runs');
  for (let i = 0; i < 17; i++) passengers.update(.1, false, model, camera, 0);
  assert.equal(await completed, true, 'a normal-length clip resolves departure at its authored duration');
  const destroyed = passengers.depart(); bed.removeFromParent(); passengers.destroy();
  assert.equal(await destroyed, false); assert.equal(model.children.length, 0);
  delete global.document;delete global.Image;
  console.log('Wake variants, stable selection, departure cancellation/reduced motion/disposal passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
