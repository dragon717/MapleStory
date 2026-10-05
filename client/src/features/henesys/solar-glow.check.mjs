import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as T from 'three';
const js = ts.transpileModule(fs.readFileSync(new URL('./solar-glow.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/^import .*;\r?\n/gm, '').replace('export class', 'class');
const SolarGlow = new Function('T', `${js};return SolarGlow;`)(T);
const scene = new T.Scene(), glow = new SolarGlow(490), center = new T.Vector3(12, 3, -4), direction = new T.Vector3(.6, .5, -.4).normalize();
scene.add(glow); glow.update(center, direction, new T.Color('#ffe3bc'), 3);
glow.updateMatrixWorld(true);
const ray = new T.Raycaster(center, direction), hits = ray.intersectObject(glow);
assert.equal(hits.length, 1, 'sun-facing plane is visible from its lit direction');
assert(Math.abs(hits[0].distance - 490) < 1e-6);
assert(glow.getWorldDirection(new T.Vector3()).dot(direction) < -.999999);
const moved = center.clone().add(new T.Vector3(30, 2, 40)); glow.update(moved, direction, new T.Color('#ffa26a'), 1.2);
assert(glow.position.clone().sub(moved).normalize().distanceTo(direction) < 1e-8, 'camera translation cannot change the solar angle');
assert.equal(glow.material.depthTest, true); assert.equal(glow.material.depthWrite, false);
assert.equal(glow.material.blending, T.AdditiveBlending);
glow.update(center, direction, new T.Color(), 0); assert.equal(glow.visible, false);
glow.update(center, direction.clone().negate(), new T.Color(), 3); assert.equal(glow.visible, false, 'sunset hides the solar glow below the horizon');
let geometry = 0, material = 0; glow.geometry.addEventListener('dispose', () => geometry++); glow.material.addEventListener('dispose', () => material++);
glow.destroy(); assert.equal(scene.children.length, 0); assert.equal(geometry, 1); assert.equal(material, 1);
console.log('PASS solar direction, camera translation, depth occlusion contract, day/night and GPU resource disposal');

const viewSource=fs.readFileSync(new URL('./view.ts',import.meta.url),'utf8');
// Sky inspection can legitimately have no visible paper actors; it must still draw 3D.
const drawBody=/private draw=.*?=>\{([\s\S]*?)\n };\n private forward/.exec(viewSource)?.[1];
assert.ok(drawBody,'render callback exists');
const draw=new Function(drawBody),calls=[];
const renderView={saved:[],rasterCamera:{},capturing:true,actors:{unbind:()=>calls.push('unbind'),texture:{webGLTexture:{}}},texture:{},
  phaser:{resetProjectionMatrix(){},pipelines:{clear(){},rebind(){}}},
  renderer:{resetState(){},setRenderTarget(){},setClearColor(){},render:()=>calls.push('render')},
  sunlight:{render:()=>calls.push('sunlight')},restore:()=>calls.push('restore')};
draw.call(renderView);
assert.deepEqual(calls,['unbind','render','sunlight','render','restore'],'empty actor pass still renders depth, sky and scene');
assert.equal(renderView.capturing,false);
calls.length=0;renderView.disposed=true;draw.call(renderView);
assert.deepEqual(calls,['restore'],'destroyed view does not render');
calls.length=0;renderView.disposed=false;delete renderView.rasterCamera;draw.call(renderView);
assert.deepEqual(calls,['restore'],'unprepared inactive frame does not render stale scenery');
console.log('PASS empty-actor sky rendering and disposed/unprepared-view guards');
