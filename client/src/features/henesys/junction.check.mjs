import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
const east = JSON.parse(await readFile(new URL('../../../../shared/chuxian-east.json', import.meta.url), 'utf8'));
const source = await readFile(new URL('./coordinates.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const js = outputText.replace(/import east from '[^']+';/, `const east = ${JSON.stringify(east)};`);
const { junctionDirections } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
// Compare the actual Rust turn function, including range edges, current-road winners and ties.
const rust = spawnSync(process.env.CARGO_BIN || path.join(os.homedir(), '.cargo/bin/cargo'), ['test', 'east_junction_hint_parity', '--', '--nocapture'], { cwd: new URL('../../../../server/', import.meta.url), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
assert.equal(rust.status, 0, rust.stderr);
const samples = JSON.parse(/^JUNCTION_CHOICES=(.+)$/m.exec(rust.stdout)?.[1] ?? 'null');
assert.ok(samples?.length > 100);
const modes = new Set();
for (const {x, choices} of samples) { assert.deepEqual(junctionDirections(x), choices, `authority mismatch at ${x}`); modes.add(choices.join(',')); }
assert.ok(modes.has('up') && modes.has('down') && modes.has('up,down') && modes.has(''), 'cover up/down/both/no-choice');
assert.deepEqual(junctionDirections(Number.NaN), []);
console.log(`PASS: ${samples.length} positions match Rust branch choices, including up/down/both/none and +/-55px boundaries.`);

// Exercise the actual presentation method without a GPU or an account.
const viewSource = await readFile(new URL('../player/view.ts', import.meta.url), 'utf8');
const viewJs = ts.transpileModule(viewSource, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/^import .*;\r?\n/gm, '');
const {PlayerView} = await import(`data:text/javascript;base64,${Buffer.from(viewJs).toString('base64')}`);
globalThis.ensureTextures = () => true;
const object = () => ({list:[],visible:true,x:0,y:0,setVisible(v){this.visible=v;return this;},setPosition(x,y){this.x=x;this.y=y;return this;},setDepth(){return this;},setOrigin(){return this;},add(images){this.list.push(...images);return this;}});
const view = Object.create(PlayerView.prototype);
Object.assign(view,{self:true,headOffsetY:-45,body:{depth:1},manifest:{miniMap:{icons:{direction:{n:{url:'up'},s:{url:'down'}}}}},scene:{time:{now:0},textures:{exists:()=>true},add:{container:object,image:object}}});
const player={x:10.25,y:100.5,grounded:true,hp:100,action:'stand'};
for(const directions of [['up'],['down'],['up','down']]){
  view.updateJunctionHint(player,directions);
  assert.equal(view.junctionHint.visible,true);
  assert.deepEqual(view.junctionHint.list.map(image=>image.visible),['up','down'].map(d=>directions.includes(d)));
  assert.equal(view.junctionHint.x,player.x,'same fractional actor anchor');
  const visible=view.junctionHint.list.filter(image=>image.visible);
  assert.equal(visible.reduce((sum,image)=>sum+image.x,0),0,'single and dual hints centered');
}
const hint=view.junctionHint,oldY=hint.y;
view.scene.time.now=180;view.updateJunctionHint(player,['up','down']);
assert.equal(view.junctionHint,hint,'reuse the root and two textures');assert.notEqual(hint.y,oldY,'floating animation');
for(const state of [{grounded:false},{chair:{}},{hp:0},{action:'dead'}]){view.updateJunctionHint({...player,...state},['up']);assert.equal(hint.visible,false);}
view.updateJunctionHint(player,[]);assert.equal(hint.visible,false);
view.self=false;view.updateJunctionHint(player,['up']);assert.equal(hint.visible,false,'no remote hints');
view.self=true;view.scene.textures.exists=()=>false;view.updateJunctionHint(player,['up']);assert.equal(hint.visible,false,'missing textures do not draw placeholders');
console.log('PASS: local up/down/both hints, centering, animation, reuse, hidden states and missing art.');
