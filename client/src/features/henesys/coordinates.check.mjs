import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as T from 'three';
const east=JSON.parse(fs.readFileSync(new URL('../../../../shared/chuxian-east.json',import.meta.url),'utf8'));
const load=async relative=>{
  const source=fs.readFileSync(new URL(relative,import.meta.url),'utf8');
  const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/^import .*;\r?\n/gm,'');
  return import(`data:text/javascript;base64,${Buffer.from(`const east=${JSON.stringify(east)};\n${js}`).toString('base64')}`);
};
const {eastMotionDistance,eastMotionBlend,point3d,segmentAt}=await load('./coordinates.ts');
const {MotionInterpolator}=await load('../net-motion/motion-interpolator.ts');
const ground=x=>{const {a,b}=segmentAt(x);return a.y+(b.y-a.y)*(x-a.x)/(b.x-a.x);};
const foot=x=>({id:'self',x,y:ground(x),action:'walk'});
const xyz=actor=>new T.Vector3(...point3d(actor.x,actor.y));
const normalize=(road,x)=>road.loop?road.start+((x-road.start)%(road.end-road.start)+(road.end-road.start))%(road.end-road.start):Math.max(road.start,Math.min(road.end,x));
let count=0;
for(const junction of east.junctions)for(const entry of junction.entries)for(const exit of junction.entries){
  if(entry.route===exit.route)continue;
  for(const before of [-40,40])for(const after of [-8,8]){
  const a=foot(normalize(east.routes[entry.route],entry.x+before)),b=foot(normalize(east.routes[exit.route],exit.x+after));
  assert.ok(Math.abs(a.x-b.x)>600,'real junction changes authority chart');
  assert.ok(eastMotionDistance(a,b)<100,`junction stays physically close: ${junction.name} ${entry.route}->${exit.route}, distance ${eastMotionDistance(a,b)}`);
  let old=xyz(a);
  for(let i=1;i<=24;i++){
    const rendered=eastMotionBlend(a,b,i/24),p=xyz(rendered);
    assert.ok(old.distanceTo(p)<.1,'continuous road foot through the crossing, no flying between charts');
    assert.ok(Math.abs(rendered.y-ground(rendered.x))<1e-7,'foot stays on the rendered road');
    old=p;
  }
  assert.ok(old.distanceTo(xyz(b))<1e-7);
  count++;
  }
}
// Rings wrap to the adjacent foot instead of travelling backwards around the entire ring.
for(const road of east.routes.filter(r=>r.loop))for(const direction of [-1,1]){
  const a=foot(direction>0?road.end-8:road.start+8),b=foot(direction>0?road.start+8:road.end-8);
  assert.ok(Math.abs(eastMotionDistance(a,b)-Math.hypot(16,b.y-a.y))<1e-6);
  let old=xyz(a);
  for(let i=1;i<=24;i++){const p=xyz(eastMotionBlend(a,b,i/24));assert.ok(p.distanceTo(old)<.05);old=p;}
  assert.ok(old.distanceTo(xyz(b))<1e-7);
}
const junction=east.junctions.find(j=>j.entries.some(e=>e.route===0)&&j.entries.some(e=>e.route===1));
const entry=junction.entries.find(e=>e.route===0),exit=junction.entries.find(e=>e.route===1);
const a=foot(entry.x-40),b=foot(exit.x+8);
const motion=new MotionInterpolator({delayTicks:.5,distance:eastMotionDistance,blend:eastMotionBlend});
motion.observe([a],1,50);motion.observe([b],2,50);
let initial=motion.render(b);
assert.ok(xyz(initial).distanceTo(xyz(a))<1e-7,'route change must not be mistaken for a teleport');
let changedFrames=0,old=xyz(initial);
for(let i=0;i<8;i++){
  motion.advance(50/6);
  const rendered=motion.render(b),p=xyz(rendered);
  if(p.distanceTo(old)>1e-7)changedFrames++;
  assert.ok(p.distanceTo(old)<.3,'camera and actor use continuous frames');
  assert.equal(rendered.action,'walk','discrete state remains authoritative');
  old=p;
}
assert.ok(changedFrames>=5);
// Explicit teleport, long displacement, reset and disconnected roads still snap.
motion.snap('self');motion.observe([a],3,50);assert.deepEqual(motion.render(a),a);
motion.reset();assert.equal(motion.trackCount,0);
const far=foot(east.routes[0].end);motion.observe([foot(east.routes[0].start)],4,50);motion.observe([far],5,50);assert.deepEqual(motion.render(far),far);
assert.equal(eastMotionDistance(foot(east.routes[3].start),foot(east.routes[15].start)),Infinity);
// Height above the road belongs to an existing hop, not a second ground surface.
const hop=eastMotionBlend({...a,y:a.y-30},{...b,y:b.y-10},.5);
assert.ok(Math.abs(hop.y-ground(hop.x)+20)<1e-7);

// Execute the actual camera preparation prefix with CPU Three objects: no GPU/account needed.
const viewSource=fs.readFileSync(new URL('./view.ts',import.meta.url),'utf8');
const prefix=/private prepare=.*?=>\{([\s\S]*?)  \/\/ Static scenery/.exec(viewSource)?.[1];
assert.ok(prefix,'camera prefix exists');
const prepareJs=ts.transpileModule(`function prepare(){${prefix}}`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const prepare=new Function('T','point3d','PIXELS_PER_METRE','devicePixelRatio',`${prepareJs};return prepare;`)(T,point3d,east.pixelsPerMetre,1);
const view={world:{sys:{isActive:()=>true,isVisible:()=>true},cameras:{main:{height:480}}},root:{parentElement:{clientWidth:640,clientHeight:480}},renderer:{getPixelRatio:()=>1},width:640,height:480,camera:new T.PerspectiveCamera(38,640/480,.1,700),yaw:0,pitch:.24,zoom:1.2,
  // Former terrain occlusion would raise the camera by up to six metres.
  liftAt:new T.Vector3(Infinity,Infinity,Infinity),liftDistance:0,lift:3,wantedLift:6,terrain:[],ray:{set(){},intersectObjects:()=>[{}]}};
let offset;
for(let i=0;i<=24;i++){
  const actor=eastMotionBlend(a,b,i/24);view.self=()=>actor;prepare.call(view);
  const current=view.camera.position.clone().sub(xyz(actor));
  if(offset)assert.ok(current.distanceTo(offset)<1e-7,'crossing/terrain must not automatically reframe the camera');
  offset=current;
}
view.yaw=.4;prepare.call(view);assert.ok(view.camera.position.clone().sub(xyz(view.self())).distanceTo(offset)>1,'manual camera adjustment remains available');
const worldSource=fs.readFileSync(new URL('../../scenes/world.ts',import.meta.url),'utf8');
assert.match(worldSource,/isThreeActive\s*\?\s*eastMotionDistance/,'only active east 3D uses the road chart');
assert.match(worldSource,/new MotionInterpolator<PlayerState>\(\{[^}]*playerMotionGeometry/s,'self uses chart interpolation');
assert.match(worldSource,/new MotionInterpolator<PlayerState>\(this\.playerMotionGeometry\)/,'peers use the same chart');
assert.match(worldSource,/junctionDirections\(self\.x, this\.movementView\(\)\)/,'hints still use authoritative coordinates');
console.log(`PASS: ${count} directed crossing transitions, ring seams, real camera continuity/fixed framing, jump height and teleport/reset boundaries.`);
