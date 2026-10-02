import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as T from 'three';
const source=fs.readFileSync(new URL('./local-reveal.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/^import .*;\r?\n/gm,'').replace('export class','class');
const LocalReveal=new Function('T',`${js};return LocalReveal;`)(T);
const model=new T.Group(),shared=new T.MeshStandardMaterial();
shared.onBeforeCompile=shader=>{shader.uniforms.authoredFlow={value:1};shader.fragmentShader+='\n// authored-flow';};shared.customProgramCacheKey=()=> 'authored-flow';
const wall=new T.Mesh(new T.BoxGeometry(16,9,1),shared);wall.userData.layer='buildings';wall.position.set(0,2,5);
const ground=new T.Mesh(new T.PlaneGeometry(30,30),shared);ground.userData.layer='terrain';model.add(wall,ground);
const hidden=new T.Mesh(wall.geometry,shared);hidden.userData.layer='props';hidden.visible=false;model.add(hidden);
const trees=new T.InstancedMesh(new T.BoxGeometry(1,6,1),shared,2);trees.userData.layer='vegetation';trees.setMatrixAt(0,new T.Matrix4().makeTranslation(-4,2,4));trees.setMatrixAt(1,new T.Matrix4().makeTranslation(4,2,4));model.add(trees);
const reveal=new LocalReveal(model),camera=new T.PerspectiveCamera(38,1.4,.1,700),foot=new T.Vector3();
camera.position.set(0,6,14);camera.lookAt(0,1,0);camera.updateMatrixWorld();
assert.notEqual(wall.material,shared);assert.equal(ground.material,shared);assert.equal(hidden.material,shared);
assert.equal(trees.material,wall.material,'eligible geometry reuses one patched clone');
assert.equal(wall.material.opacity,1);assert.equal(wall.material.transparent,false);assert.equal(wall.material.depthWrite,true);
const shader={uniforms:{},fragmentShader:T.ShaderLib.standard.fragmentShader};wall.material.onBeforeCompile(shader,{});
assert.equal(shader.uniforms.authoredFlow.value,1,'preserve existing city shader hook');assert(wall.material.customProgramCacheKey().includes('authored-flow'));
assert.match(shader.fragmentShader,/gl_FragCoord.z < revealDepth/,'rear geometry remains opaque');
assert.match(shader.fragmentShader,/smoothstep\(.62, 1\./,'window has a feathered edge');
assert.equal(wall.customDepthMaterial,undefined,'shadow material stays untouched');
let old=0;
for(let i=0;i<40;i++){
  reveal.update(foot,camera,1000,700,1,1000/60,i*1000/60);
  const strength=shader.uniforms.revealStrength.value;
  assert.ok(strength>=old&&strength-old<.2,'fade in advances gradually');old=strength;
}
assert.equal(old,1);
const window=shader.uniforms.revealWindow.value.clone();
for(const p of [foot,foot.clone().add(new T.Vector3(0,2.2,0))]){
  const projected=p.clone().project(camera);
  const x=(projected.x+1)*500,y=(projected.y+1)*350;
  assert.ok(Math.hypot((x-window.x)/window.z,(y-window.y)/window.w)<.62,'body and feet stay inside the clear core');
}
reveal.update(foot,camera,1000,700,2,16,700);
assert.ok(shader.uniforms.revealWindow.value.equals(window.multiplyScalar(2)),'DPR scales physical window coordinates');
wall.visible=false;
old=1;
for(let i=0;i<40;i++){reveal.update(foot,camera,1000,700,1,1000/60,800+i*1000/60);const strength=shader.uniforms.revealStrength.value;assert.ok(strength<=old&&old-strength<.2,'fade out advances gradually');old=strength;}
assert.equal(old,0);
assert.equal(reveal.candidates.filter(o=>o.mesh===trees).length,2,'separated trees use separate boxes, not a forest-wide box');
wall.visible=true;reveal.update(foot,camera,1000,700,1,16,1600);
assert.ok(shader.uniforms.revealStrength.value>0);
reveal.update(new T.Vector3(.1,0,0),camera,1000,700,1,16,1650);
const forward=reveal.direction.clone();
assert.ok(forward.x>0&&forward.x<.2,'look-ahead turns smoothly instead of snapping');
reveal.update(new T.Vector3(.05,0,0),camera,1000,700,1,16,1666);
assert.ok(reveal.direction.distanceTo(forward)<.2,'reversing a key cannot jump the look-ahead window');
reveal.direction.set(0,0,0);reveal.update(foot,camera,1000,700,1,16,1682,6,5);
const large=shader.uniforms.revealWindow.value;
for(const p of [foot,foot.clone().add(new T.Vector3(0,6,0)),foot.clone().add(new T.Vector3(2.5,3,0))]){
  const q=p.clone().project(camera);
  assert.ok(Math.hypot(((q.x+1)*500-large.x)/large.z,((q.y+1)*350-large.y)/large.w)<.62,'large mount/body stays in the clear core');
}
reveal.update(new T.Vector3(100,0,0),camera,1000,700,1,16,1766);
assert.equal(shader.uniforms.revealStrength.value,0,'teleport must not leave the previous window active');
let scanned=0;const compute=wall.geometry.computeBoundingBox.bind(wall.geometry);wall.geometry.computeBoundingBox=()=>{scanned++;compute();};
for(let i=0;i<5;i++){wall.position.x+=.1;reveal.update(foot,camera,1000,700,1,16,1900+i*100);}
assert.equal(scanned,0,'moving a rigid object cannot rescan its unchanged vertices');
const vertices=wall.geometry.getAttribute('position');vertices.setX(0,vertices.getX(0)-2);vertices.needsUpdate=true;
reveal.update(foot,camera,1000,700,1,16,2500);assert.equal(scanned,1,'deformed geometry still refreshes its local bounds');
reveal.destroy();assert.equal(reveal.candidates.length,0);assert.equal(shader.uniforms.revealStrength.value,0);
// An authored room cuts its enclosing shell, retaining the floor and restoring visibility.
const roomModel=new T.Group(),volume=new T.Group();volume.name='Room';volume.userData.interior_bounds=[-4,-.5,-4,4,8,4];roomModel.add(volume);
const shell=new T.Mesh(new T.BoxGeometry(8,8,1),shared);shell.userData.cutaway_rooms='Room';shell.position.set(0,4,3);roomModel.add(shell);
const floor=new T.Mesh(new T.BoxGeometry(8,.2,8),shared);roomModel.add(floor);
const upper=new T.Mesh(new T.BoxGeometry(8,.2,8),shared);upper.position.y=12;upper.userData.cutaway_rooms='Room';upper.userData.cutaway_above=true;upper.userData.cutaway_level=[0,0,0];roomModel.add(upper);
const concealed=new T.Group();concealed.visible=false;concealed.userData.cutaway_rooms='Room';roomModel.add(concealed);
const cutaway=new LocalReveal(roomModel,()=>true);
assert(cutaway.update(foot,camera,1000,700,1,16,0));assert.equal(shell.visible,false);assert.equal(upper.visible,false);assert.equal(floor.visible,true);
cutaway.update(new T.Vector3(4.3,0,0),camera,1000,700,1,16,100);assert.equal(shell.visible,false,'doorway exit margin prevents flicker');
cutaway.update(new T.Vector3(5,0,0),camera,1000,700,1,16,200);assert.equal(shell.visible,true);assert.equal(upper.visible,true);assert.equal(concealed.visible,false);
volume.position.y=10;cutaway.update(new T.Vector3(0,10,0),camera,1000,700,1,16,300);assert.equal(shell.visible,false,'moving island volume follows its transform');assert.equal(upper.visible,true,'floor within body clearance remains');
cutaway.destroy();assert.equal(shell.visible,true);assert.equal(concealed.visible,false);
const railModel=new T.Group(),rail=new T.Mesh(new T.BoxGeometry(16,.8,1),shared);rail.position.set(0,.4,5);railModel.add(rail);
const railReveal=new LocalReveal(railModel,()=>true);
railReveal.update(foot,camera,1000,700,1,1000,0);assert.equal(railReveal.strength.value,0,'a low rail deliberately keeps partial occlusion');
// Joined geometry has a large box across an empty doorway; it must not count as a solid wall.
const left=new T.BoxGeometry(1,9,1).toNonIndexed().translate(-5,0,0),right=new T.BoxGeometry(1,9,1).toNonIndexed().translate(5,0,0);
rail.geometry=new T.BufferGeometry().setAttribute('position',new T.Float32BufferAttribute([...left.attributes.position.array,...right.attributes.position.array],3));rail.position.set(0,4,5);
railReveal.destroy();const hollow=new LocalReveal(railModel,()=>true);hollow.update(foot,camera,1000,700,1,1000,0);assert.equal(hollow.strength.value,0);
hollow.destroy();
console.log('PASS: isolated materials, instanced geometry, body/feet core, DPR, gradual fade, teleport/reset and unchanged shadow material.');
