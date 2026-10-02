// Exercise the real boot reveal closure and lobby input guard without a browser/GPU.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const main=fs.readFileSync(path.join(root,'client/src/app/main.ts'),'utf8');
const gate=main.slice(main.indexOf('    const revealGame = () => {'),main.indexOf('    world = new World(manifest'));
assert(gate.includes('world?.isLoaded')&&gate.includes('!selfState'));
assert(main.includes("el('play').style.visibility = 'hidden'"));
assert(!main.slice(main.indexOf('async function enterGame'),main.indexOf('async function enterGame')+1100).includes("el('welcome').hidden = true"));
function scenario(){
 const state={loaded:false,self:undefined,current:1,generation:1,starts:0,hides:0,finished:0,errors:[],input:[],play:{style:{visibility:'hidden'}}};
 let complete;
 const ready=new Promise(resolve=>complete=resolve);
 const deps={world:{get isLoaded(){return state.loaded;}},get selfState(){return state.self;},get current(){return state.current;},get generation(){return state.generation;},loadingOverlay:{hide(){state.hides++;}},input:{setReady(value){state.input.push(value);}},async beforeReveal(){state.starts++;return ready;},el(){return state.play;},connectionState:'online',finishBoot(){state.finished++;},failBoot(error){state.errors.push(error);},english:false};
 // with keeps each read live, matching the mutable boot locals.
 const reveal=new Function('deps',`with(deps){let revealing=false,bootFinished=false;${gate};return revealGame;}`)(deps);
 return {state,reveal,complete};
}
(async()=>{
 const a=scenario();a.reveal();assert.equal(a.state.starts,0);
 a.state.self={id:'self'};a.reveal();assert.equal(a.state.starts,0,'authority alone cannot reveal missing scene');
 a.state.loaded=true;a.reveal();a.reveal();assert.equal(a.state.starts,1,'only one book transition');
 assert.equal(a.state.play.style.visibility,'hidden');assert.equal(a.state.finished,0);
 a.complete(true);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(a.state.play.style.visibility,'');assert.equal(a.state.finished,1);assert.deepEqual(a.state.input,[false,true]);
 const b=scenario();b.state.loaded=true;b.state.self={};b.reveal();b.complete(false);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(b.state.finished,0);assert.equal(b.state.play.style.visibility,'hidden');assert.equal(b.state.errors.length,1);
 const c=scenario();c.state.loaded=true;c.state.self={};c.reveal();c.state.generation++;c.complete(true);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(c.state.finished,0);assert.equal(c.state.play.style.visibility,'hidden');
 const voyage=fs.readFileSync(path.join(root,'client/src/features/entry/voyage.ts'),'utf8');
 const guard=voyage.slice(voyage.indexOf('  private onKey ='),voyage.indexOf('  private onVisibility =')).replace('  private onKey =','return ').replace('(event: KeyboardEvent)','(event)');
 class Element{closest(){return false;}}
 const keys=new Set(),host={hidden:false,getAttribute:()=> 'true',classList:{contains:name=>name==='voyage-loading'}};
 const fake={stage:'channel',deckCharacter:'self',keys,host,reduced:{matches:false},clearMovement(){keys.clear();}};
 const onKey=new Function('HTMLElement','document',guard).call(fake,Element,{hidden:false});
 const press={type:'keydown',code:'ArrowUp',preventDefault(){},target:new Element()};
 onKey(press);assert(keys.has('ArrowUp'),'busy loading retains lobby walking');
 host.classList.contains=()=>false;onKey(press);assert.equal(keys.size,0,'departure stops lobby input');
 console.log('PASS: authority + scene gate, one book transition, cancel/stale generation, hidden viewport and playable loading input.');
})().catch(error=>{console.error(error);process.exitCode=1;});
