const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'build/.checks/voyage-login.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
createRequire(path.join(root, 'client/package.json'))('esbuild').buildSync({ stdin: { contents: "export * from './voyage-deck'; export * from './voyage-login'; export * from './voyage-passengers'; export { voyageOpeningPose } from './voyage'; export * as Three from 'three';", resolveDir: path.join(root, 'client/src/features/entry'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: output, logLevel: 'silent' });
const { Three: T, projectLoginSurface, loginSurfaceOccluded, VoyageLogin, voyageOpeningPose, VoyagePassengers, wakePose, VoyageDeck } = require(output);
// The lobby follows visible floor support and real rails, without invisible lane restrictions.
const deckShip=new T.Group(),hull=new T.Group();hull.name='SV3_Hull';deckShip.add(hull);
const floor=new T.Mesh(new T.BoxGeometry(20,.2,50),new T.MeshBasicMaterial());floor.position.set(0,6,0);hull.add(floor);
const rail=new T.Mesh(new T.BoxGeometry(4,2,.2),new T.MeshBasicMaterial());rail.position.set(6.5,7,16);hull.add(rail);
const walkCamera=new T.PerspectiveCamera();walkCamera.position.set(6.5,12,30);walkCamera.lookAt(6.5,6,0);
const deck=new VoyageDeck(deckShip);assert(Math.abs(deck.position.y-6.125)<.00001);
deck.update(.05,1,0,walkCamera,deckShip);assert(deck.position.x>deck.spawn.x,'visible sideways deck floor is walkable');
deck.reset();for(let i=0;i<100;i++)deck.update(.05,0,1,walkCamera,deckShip);assert(deck.position.z<15.7,'torso cannot cross a rail');
deck.reset();for(let i=0;i<130;i++)deck.update(.05,1,0,walkCamera,deckShip);assert(deck.position.x<9.8,'all five foot samples must remain on actual floor');
deck.reset();deck.update(.05,1,1,walkCamera,deckShip);assert(Math.abs(deck.position.distanceTo(deck.spawn)-.15)<.00001,'diagonal movement cannot speed up');
const landing=deck.position.y;deck.jump();deck.update(.05,0,0,walkCamera,deckShip);assert(deck.jumping&&deck.position.y>landing);const velocity=deck.jumpVelocity;deck.jump();assert.equal(deck.jumpVelocity,velocity,'airborne repeat cannot restart a jump');
for(let i=0;i<60;i++)deck.update(.05,0,0,walkCamera,deckShip);assert.equal(deck.position.y,landing);assert(!deck.jumping,'jump lands on the same actual deck');
deck.reset();walkCamera.position.set(20,12,30);walkCamera.lookAt(0,6,0);walkCamera.updateMatrixWorld(true);deck.update(.05,1,0,walkCamera,deckShip);const face=deck.facing;deck.update(.05,-1,0,walkCamera,deckShip);assert.equal(deck.facing,-face,'body reverses with actual projected movement');
deckShip.position.set(40,10,90);deckShip.rotation.y=.7;deckShip.updateMatrixWorld(true);deck.reset();deck.update(.05,0,-1,walkCamera,deckShip);assert(deck.moving,'ship movement cannot detach local collision');
deck.reset();deck.update(NaN,1,0,walkCamera,deckShip);assert.deepEqual(deck.position.toArray(),deck.spawn.toArray());
deck.destroy();floor.geometry.dispose();floor.material.dispose();rail.geometry.dispose();rail.material.dispose();
// Dense samples catch a hard cut; settling must reach the exact final pose with near-zero speed.
let previousPose = voyageOpeningPose(0);
for (let i = 1; i <= 2400; i++) {
  const pose = voyageOpeningPose(i / 2400);
  assert(pose.eye.toArray().concat(pose.aim.toArray()).every(Number.isFinite));
  assert(pose.eye.distanceTo(previousPose.eye) < 1.2 && pose.aim.distanceTo(previousPose.aim) < .7, 'continuous one-take path cannot jump');
  previousPose = pose;
}
assert(previousPose.eye.distanceTo(new T.Vector3(.1,7.2,9))<1e-10);
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
  const context={clearRect(){},drawImage(){},fillText(){}};
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
  passengers.finishWake();passengers.deckPosition.set(-10,0,35);passengers.update(.1,false,model,camera,0);
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
  const destroyed = passengers.depart(); passengers.destroy();
  assert.equal(await destroyed, false); assert.equal(model.children.length, 0);
  delete global.document;delete global.Image;
  console.log('Wake variants, stable selection, departure cancellation/reduced motion/disposal passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
