import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
const east = JSON.parse(await readFile(new URL('../../../../shared/chuxian-east.json', import.meta.url), 'utf8'));
const skyCity = JSON.parse(await readFile(new URL('../../../../shared/sky-city.json', import.meta.url), 'utf8'));
const source = await readFile(new URL('./coordinates.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const js = outputText.replace(/import east from '[^']+';/, `const east = ${JSON.stringify(east)};`).replace(/import skyCity from '[^']+';/, `const skyCity = ${JSON.stringify(skyCity)};`);
const { junctionDirections } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
// Compare the actual Rust turn function, including range edges, current-road winners and ties.
const rust = spawnSync(process.env.CARGO_BIN || path.join(os.homedir(), '.cargo/bin/cargo'), ['test', 'east_junction_hint_parity', '--', '--nocapture'], { cwd: new URL('../../../../server/', import.meta.url), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
assert.equal(rust.status, 0, rust.stderr);
const samples = JSON.parse(/^JUNCTION_CHOICES=(.+)$/m.exec(rust.stdout)?.[1] ?? 'null');
assert.ok(samples?.length > 100);
const modes = new Set();
for (const {x, view, choices} of samples) { assert.deepEqual(new Set(junctionDirections(x,view ?? undefined)), new Set(choices), `authority mismatch at ${x}`); choices.forEach(choice=>modes.add(choice)); if(!choices.length)modes.add('none'); }
for(const key of ['up','down','left','right','none'])assert.ok(modes.has(key),`cover ${key}`);
assert.deepEqual(junctionDirections(Number.NaN), []);
console.log(`PASS: ${samples.length} positions match Rust branch choices, including camera projection, four-arrow exits and +/-55px boundaries.`);

// Exercise the actual presentation method without a GPU or an account.
const viewSource = await readFile(new URL('../player/view.ts', import.meta.url), 'utf8');
const viewJs = ts.transpileModule(viewSource, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/^import .*;\r?\n/gm, '');
const {PlayerView} = await import(`data:text/javascript;base64,${Buffer.from(viewJs).toString('base64')}`);
globalThis.ensureTextures = () => true;
const object = () => ({list:[],visible:true,x:0,y:0,setVisible(v){this.visible=v;return this;},setPosition(x,y){this.x=x;this.y=y;return this;},setDepth(){return this;},setOrigin(){return this;},add(images){this.list.push(...images);return this;}});
const view = Object.create(PlayerView.prototype);
Object.assign(view,{self:true,headOffsetY:-45,body:{depth:1},manifest:{miniMap:{icons:{direction:{n:{url:'up'},s:{url:'down'},w:{url:'left'},e:{url:'right'},nw:{url:'upLeft'},ne:{url:'upRight'},sw:{url:'downLeft'},se:{url:'downRight'}}}}},scene:{time:{now:0},textures:{exists:()=>true},add:{container:object,image:object}}});
const player={x:10.25,y:100.5,grounded:true,hp:100,action:'stand'};
for(const directions of [['up'],['down'],['left'],['right'],['up','down'],['up','left','right'],['up','down','left','right']]){
  view.updateJunctionHint(player,directions);
  assert.equal(view.junctionHint.visible,true);
  assert.deepEqual(view.junctionHint.list.map(image=>image.visible),['up','down','left','right'].map(d=>directions.includes(d)));
  assert.equal(view.junctionHint.x,player.x,'same fractional actor anchor');
  const visible=view.junctionHint.list.filter(image=>image.visible);
  assert.equal(visible.reduce((sum,image)=>sum+image.x,0),0,'single and dual hints centered');
}
const hint=view.junctionHint,oldY=hint.y;
view.scene.time.now=180;view.updateJunctionHint(player,['up','down']);
assert.equal(view.junctionHint,hint,'reuse the root and original textures');assert.notEqual(hint.y,oldY,'floating animation');
for(const state of [{grounded:false},{chair:{}},{hp:0},{action:'dead'}]){view.updateJunctionHint({...player,...state},['up']);assert.equal(hint.visible,false);}
view.updateJunctionHint(player,[]);assert.equal(hint.visible,false);
view.self=false;view.updateJunctionHint(player,['up']);assert.equal(hint.visible,false,'no remote hints');
view.self=true;view.scene.textures.exists=()=>false;view.updateJunctionHint(player,['up']);assert.equal(hint.visible,false,'missing textures do not draw placeholders');
console.log('PASS: local four-direction hints, centering, animation, reuse, hidden states and missing art.');

// Check the real view getter, including zoom, target height, without creating a GPU.
const henesysSource = await readFile(new URL('./view.ts',import.meta.url),'utf8');
const henesysJs=ts.transpileModule(henesysSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/^import .*;\r?\n/gm,'');
const {HenesysView}=await import(`data:text/javascript;base64,${Buffer.from(henesysJs).toString('base64')}`);
globalThis.T={MathUtils:{degToRad:degrees=>degrees*Math.PI/180}};
globalThis.PIXELS_PER_METRE=east.pixelsPerMetre;
const cameraView=Object.create(HenesysView.prototype);
for(const height of [200,480,1080])for(const yaw of [-.45,0,.45])for(const pitch of [.08,.24,.46])for(const zoom of [.9,1.7]){
  Object.assign(cameraView,{world:{cameras:{main:{height}}},yaw,pitch,zoom});
  const view=cameraView.movementView();
  assert.equal(view.yaw,yaw);
  assert.ok(view.pitch>pitch&&view.pitch<1.4,'foot viewing angle is valid and includes target height');
}
console.log('PASS: current camera intent includes target height, zoom at all allowed view limits.');
