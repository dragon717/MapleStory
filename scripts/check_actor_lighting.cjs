// One check for the actual pixel-art lighting math, independent of a game/account.
const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('../client/node_modules/typescript');
const m={exports:{}};new Function('module','exports',ts.transpileModule(fs.readFileSync('client/src/features/henesys/actor-lighting.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(m,m.exports);
const {sampleActorLight,multiplyArtTint}=m.exports;
const sample=(day,lamps,point=[0,0,0])=>sampleActorLight(point,day,lamps,{r:0,g:0,b:0});
const night=sample(0,[]),day=sample(1,[]),warm={position:[0,1,0],intensity:8,distance:3,color:[1,.52,.18]};
assert(day.r>.9&&night.r<.2&&night.b>night.r);
const lit=sample(0,[warm]);assert(lit.r>night.r*3&&lit.r>lit.b);
assert.deepEqual(sample(0,[warm],[3,0,0]),night,'distance cutoff cannot illuminate outside its maximum radius');
assert.deepEqual(sample(0,[]),night,'discarded lamp must have no residual personal light');
assert.equal(multiplyArtTint(0xff0000,lit)&0xffff,0,'existing colored tint must stay colored');
assert.equal(multiplyArtTint(0x123456,{r:1,g:1,b:1}),0x123456);
assert(Object.values(lit).every(v=>Number.isFinite(v)&&v>=0&&v<=1));
console.log('PASS: authored tint × world light, night/day, warm lamp and cutoff; no residual light after discard.');
