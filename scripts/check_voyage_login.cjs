const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'build/.checks/voyage-login.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
createRequire(path.join(root, 'client/package.json'))('esbuild').buildSync({ stdin: { contents: "export * from './voyage-deck'; export * from './voyage-login'; export * from './voyage-passengers'; export { voyageOpeningPose } from './voyage'; export * as Three from 'three';", resolveDir: path.join(root, 'client/src/features/entry'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: output, logLevel: 'silent' });
const { Three: T, projectLoginSurface, loginSurfaceOccluded, VoyageLogin, voyageOpeningPose, VoyagePassengers, wakePose, VoyageDeck } = require(output);
// The lobby follows authored centre lines and still queries the real surface/rails.
const deckShip=new T.Group(),hull=new T.Group();hull.name='SV3_Hull';deckShip.add(hull);
const floor=new T.Mesh(new T.BoxGeometry(20,.2,50),new T.MeshBasicMaterial());floor.position.set(0,6,0);hull.add(floor);
const rail=new T.Mesh(new T.BoxGeometry(4,2,.2),new T.MeshBasicMaterial());rail.position.set(6.5,7,16);hull.add(rail);
const walkCamera=new T.PerspectiveCamera();walkCamera.position.set(6.5,12,30);walkCamera.lookAt(6.5,6,0);
const deck=new VoyageDeck(deckShip);assert(Math.abs(deck.position.y-6.125)<.00001);
deck.update(.05,1,0,walkCamera,deckShip);assert.deepEqual(deck.position.toArray(),deck.spawn.toArray(),'sideways input cannot leave the authored lane');
for(let i=0;i<100;i++)deck.update(.05,0,1,walkCamera,deckShip);assert(deck.position.z<15.7,'torso cannot cross a rail');
deck.reset();for(let i=0;i<400&&deck.position.z>-8;i++)deck.update(.05,0,-1,walkCamera,deckShip);
deck.update(.05,0,0,walkCamera,deckShip);for(let i=0;i<150;i++)deck.update(.05,-1,0,walkCamera,deckShip);assert.equal(deck.position.x,-6.5,'junction reaches the other deck lane');assert.equal(deck.position.z,-8);
deck.update(.05,0,1,walkCamera,deckShip);assert(deck.moving&&deck.position.z>-8,'release/repress chooses the left lane');
deck.reset();deck.update(.05,1,1,walkCamera,deckShip);assert(Math.abs(deck.position.distanceTo(deck.spawn)-.15)<.00001,'diagonal movement cannot speed up');
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
assert.deepEqual(previousPose.eye.toArray(), [25, 14, 11]);
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
  const passengers = new VoyagePassengers(() => {}), model = new T.Group(); passengers.attach(model);
  const deckDoll={group:new T.Group(),mesh:new T.Mesh(new T.PlaneGeometry(1,1,1,10),new T.MeshStandardMaterial()),zz:new T.Sprite()};
  deckDoll.group.add(deckDoll.mesh); passengers.root.add(deckDoll.group); passengers.dolls.set('a',deckDoll);
  passengers.setSlots(['a','b'],'a','channel',0); passengers.deckPosition.set(6,5.442377,12); passengers.deckMoving=true;
  camera.position.set(18,11,24);camera.lookAt(5,6.3,11);passengers.update(.1,false,model,camera,0);
  assert.equal(passengers.action('a'),'walk');assert.equal(passengers.action('b'),'stand');
  assert(new T.Vector3(0,1,0).applyQuaternion(deckDoll.group.quaternion).distanceTo(new T.Vector3(0,1,0))<1e-7,'standing sprite is upright despite camera pitch');
  assert.deepEqual(deckDoll.group.position.toArray(),passengers.deckPosition.toArray());
  for(let i=0;i<deckDoll.mesh.geometry.attributes.position.count;i++)assert(Math.abs(deckDoll.mesh.geometry.attributes.position.getZ(i))<1e-7,'deck sprite cannot retain bed deformation');
  passengers.dolls.delete('a');deckDoll.group.removeFromParent();deckDoll.mesh.geometry.dispose();deckDoll.mesh.material.dispose();deckDoll.zz.material.dispose();
  passengers.setSlots(['a', 'b'], 'a', 'characters', 0);
  passengers.update(.4, false, model, camera, 0);
  const wake = { ...passengers.wake };
  passengers.setSlots(['a', 'b'], 'a', 'characters', 0);
  assert.deepEqual(passengers.wake, wake, 'rerenders cannot restart or randomize the same selection');
  const cancelled = passengers.depart(); passengers.setSlots(['a', 'b'], 'b', 'characters', 0);
  assert.equal(await cancelled, false); assert(!model.getObjectByName('SV3_DepartureBook'));
  assert.equal(passengers.wake.seconds, 0); assert(passengers.sleeping('a') && !passengers.sleeping('b'));
  const completed = passengers.depart(); passengers.update(.016, true, model, camera, 0);
  assert.equal(await completed, true, 'reduced motion still resolves departure');
  const destroyed = passengers.depart(); passengers.destroy();
  assert.equal(await destroyed, false); assert.equal(model.children.length, 0);
  console.log('Wake variants, stable selection, departure cancellation/reduced motion/disposal passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
