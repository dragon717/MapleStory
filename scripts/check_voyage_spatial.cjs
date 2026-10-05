// Real exported geometry and runtime movement regression for the ship correction.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadRuntimeModule, geometryOnlyGlb, parse } = require('./check_voyage_cloth.cjs');
const root = path.resolve(__dirname, '..');

async function main() {
  const runtime = loadRuntimeModule(), T = runtime.THREE;
  const gltf = await parse(new runtime.GLTFLoader(), geometryOnlyGlb(fs.readFileSync(path.join(root, 'resources/scenes/sky-voyage-v3/models/sky-voyage.glb'))));
  const model = gltf.scene, ship = model.getObjectByName('SV2_Ship');
  ship.scale.setScalar(1); model.updateMatrixWorld(true);
  const flight = new runtime.ShipFlight(model);
  flight.setControls({ wind: 0, sail: 1, steering: 0 }); flight.update(0, true);
  const wheels = ['Port', 'Starboard'].map(side => {
    const wheel = model.getObjectByName(`SV3_Wheel_${side}`);
    const points = [];
    wheel.traverse(mesh => {
      if (!mesh.isMesh) return;
      const position = mesh.geometry.attributes.position;
      for (let index = 0; index < position.count; index += 43) points.push({ mesh, index, before: new T.Vector3().fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld) });
    });
    const centre = wheel.getWorldPosition(new T.Vector3());
    const support = model.getObjectByName(`SV3_Wheel_${side}_OutboardBrace`);
    return { wheel, rest: wheel.quaternion.clone(), centre, points, support, supportMatrix: support.matrixWorld.clone() };
  });
  // Exercise a quarter turn and a non-cardinal turn. An incorrect rod axis
  // preserves radius but moves the blades out of their actual wheel plane.
  let maxAxisDrift = 0, maxRadiusDrift = 0;
  for (const angle of [Math.PI / 2, 2.17]) {
    flight.wheelAngle = angle; flight.update(0, true); model.updateMatrixWorld(true);
    for (const { wheel, rest, centre, points, support, supportMatrix } of wheels) {
      const relative = rest.clone().invert().multiply(wheel.quaternion);
      assert(Math.abs(relative.z - Math.sin(angle / 2) * wheel.userData.spin_sign) < 1e-6, 'runtime consumes each wheel opposite spin sign');
      assert(wheel.getWorldPosition(new T.Vector3()).distanceTo(centre) < 1e-6, 'wheel hub stays fixed');
      assert(support.matrixWorld.equals(supportMatrix), 'support rod stays fixed');
      let travelled = 0;
      for (const { mesh, index, before } of points) {
        const after = new T.Vector3().fromBufferAttribute(mesh.geometry.attributes.position, index).applyMatrix4(mesh.matrixWorld);
        maxAxisDrift = Math.max(maxAxisDrift, Math.abs(after.z - before.z));
        maxRadiusDrift = Math.max(maxRadiusDrift, Math.abs(after.distanceTo(centre) - before.distanceTo(centre)));
        travelled = Math.max(travelled, after.distanceTo(before));
      }
      assert(travelled > 4, 'wheel blades actually turn');
    }
  }
  assert(maxAxisDrift < 1e-5, `wheel leaves its X/Y plane: ${maxAxisDrift}`);
  assert(maxRadiusDrift < 1e-5, `wheel radius changes: ${maxRadiusDrift}`);
  flight.wheelAngle = 0; flight.update(0, true); model.updateMatrixWorld(true);
  const cabin = model.getObjectByName('SV3_CabinInterior');
  const window = model.getObjectByName('SV2_CabinFrontWindow_01');
  const windowPosition = ship.worldToLocal(window.getWorldPosition(new T.Vector3()));
  assert(windowPosition.x < -8 && windowPosition.z > 47, 'window wall is on the port side after the quarter turn');
  const sideWalls = model.getObjectByName('SV2_CabinSideWalls'), ray = new T.Raycaster();
  for (const side of [-1, 1]) for (const height of [.5, 1.6, 3.2]) {
    const direction = new T.Vector3(side, 0, 0).transformDirection(cabin.matrixWorld);
    ray.set(cabin.localToWorld(new T.Vector3(side * 12.8, height, 45.4)), direction); ray.far = 2;
    assert.equal(ray.intersectObject(sideWalls, true).length, 0, 'bed aisle passes directly through each end wall');
    ray.set(cabin.localToWorld(new T.Vector3(side * 12.8, height, 40)), direction);
    assert(ray.intersectObject(sideWalls, true).length > 0, 'wall beside the opening remains intact');
  }
  const formerDoor = model.getObjectByName('SV3_WindowWallRestored_EndPier');
  ray.set(cabin.localToWorld(new T.Vector3(11.65, 2, 33)), new T.Vector3(0, 0, -1).transformDirection(cabin.matrixWorld)); ray.far = 3;
  assert(ray.intersectObject(formerDoor, true).length > 0, 'retired window-side doorway is closed');
  model.traverse(node => { assert(!(node.isMesh && node.name.startsWith('SV3_Route_')), 'no extra corridor floor remains'); });
  const deck = new runtime.VoyageDeck(ship), interior = new runtime.VoyageDeck(ship, true), bow = new runtime.VoyageDeck(ship, false, true);
  const infill = model.getObjectByName('SV3_CaptainFinish_DeckInfill');
  assert(infill && infill.userData.walk_surface === false, 'visual deck closes the shell without replacing the route');
  for (const [x,z] of [[0,3.3],[4.75,3.3],[5.4,3.3],[5.6,3.3],[-5.6,3.3],[0,12],[5,12],[5.6,17],[-5.6,17]]) {
    ray.set(ship.localToWorld(new T.Vector3(x,7,z)),new T.Vector3(0,-1,0));ray.far=3;
    const hit=ray.intersectObject(infill,true)[0];
    assert(hit && Math.abs(ship.worldToLocal(hit.point.clone()).y-5.425)<1e-5 && hit.face.normal.y>.9,'central cutout has an upward-facing deck surface');
  }
  assert(model.getObjectByName('SV3_CaptainFinish_Crown')?.userData.closed_perimeter,'captain crown forms a closed perimeter');
  assert(model.getObjectByName('SV3_CaptainFinish_PortholeReturn'),'wood return closes the larger hull aperture around the porthole');
  const frameBounds=new T.Box3().setFromObject(model.getObjectByName('SV3_CaptainPorthole_Frame'));
  assert(Math.abs(frameBounds.min.x-4.65)<1e-5,'brass porthole returns to the measured wall envelope');
  const counts = {};
  for (const [name, walking] of [['mainDeck', deck], ['cabin', interior], ['bow', bow]]) {
    let samples = 0;
    for (let index = 1; index < walking.route.length; index++) {
      const a = walking.route[index - 1], b = walking.route[index], steps = Math.ceil(a.distanceTo(b) / .05);
      for (let sample = 0; sample <= steps; sample++) {
        const point = a.clone().lerp(b, sample / steps);
        walking.position.copy(point);
        const detail = walking.debugStep(point);
        assert(detail.stand, `${name} has an unsupported or blocked foot disk at ${point.toArray()}: ${JSON.stringify(detail)}`);
        samples++;
      }
    }
    counts[name] = samples;
  }
  const camera = new T.PerspectiveCamera(38, 1.5, .1, 1000);
  const sideCamera = new T.OrthographicCamera(-6,6,4,-4,.1,1000);
  sideCamera.position.copy(ship.localToWorld(deck.position.clone().add(new T.Vector3(20,1,0))));
  sideCamera.lookAt(ship.localToWorld(deck.position.clone().add(new T.Vector3(0,1,0))));sideCamera.updateMatrixWorld(true);
  const from=deck.position.clone();
  for(let frame=0;frame<60;frame++)deck.update(.05,1,0,sideCamera,ship);
  assert(deck.position.distanceTo(from)>1,'held horizontal input advances on the real route under a side orthographic camera');
  camera.position.copy(cabin.localToWorld(new T.Vector3(0, 12, 64)));
  camera.lookAt(cabin.localToWorld(new T.Vector3(0, 1, 40))); camera.updateMatrixWorld(true);
  const trace = [];
  interior.reset();
  for (const sign of [1, -1]) {
    const desired = interior.openRouteTangent(interior.routeDistance, sign);
    const forward = camera.getWorldDirection(new T.Vector3()); forward.y = 0; forward.normalize();
    const right = forward.clone().cross(new T.Vector3(0, 1, 0));
    const horizontal = desired.dot(right) > 0 ? 1 : -1;
    const target = sign === 1 ? interior.route.at(-1) : interior.route[0];
    for (let frame = 0; frame < 1600 && interior.position.distanceTo(target) > .15; frame++) interior.update(.05, horizontal, 0, camera, ship);
    assert(interior.position.distanceTo(target) < .15, `held input failed to reach ${sign === 1 ? 'deck opening' : 'stern opening'}: ${interior.position.toArray()}`);
    trace.push({ destination: sign === 1 ? 'deckOpening' : 'sternOpening', position: interior.position.toArray(), horizontal });
    interior.update(.05, 0, 0, camera, ship);
  }
  assert(!deck.place(new T.Vector3(0, 5.4, -48)), 'main deck cannot place a walker at the bow');
  assert(bow.place(new T.Vector3(0, 6.8, -42.4)), 'bow transfer has supported slope entry');
  assert(bow.route.at(-1).y > bow.position.y + .8, 'bow slope rises onto the raised platform');
  deck.destroy(); interior.destroy(); bow.destroy();
  console.log(JSON.stringify({ passed: true, wheels: { maxAxisDrift, maxRadiusDrift }, supportedSamples: counts, heldInput: trace }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
