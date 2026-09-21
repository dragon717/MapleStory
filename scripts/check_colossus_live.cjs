// Explicitly point at an isolated server. This creates two disposable test accounts.
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const root=require('node:path').resolve(__dirname,'..');
const base=process.env.COLOSSUS_TEST_URL;
assert(base&&/^http:\/\/127\.0\.0\.1:\d+$/.test(base)&&!base.endsWith(':3010'),'Set COLOSSUS_TEST_URL to an isolated loopback server (never 3010).');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const post=async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const result=await r.json();assert(r.ok,JSON.stringify(result));return result;};
const protocolSource=readFileSync(root+'/shared/protocol.ts','utf8');
const expectedProtocol=Number(/PROTOCOL_VERSION\s*=\s*(\d+)/.exec(protocolSource)?.[1]);
const expectedContent=/CONTENT_VERSION\s*=\s*'([^']+)'/.exec(protocolSource)?.[1];
assert.equal(expectedProtocol,34,'shared protocol must be 34');
assert.equal(expectedContent,'tms273-34','shared content must be tms273-34');
const catalog=JSON.parse(readFileSync(root+'/shared/character-creation.json','utf8')),g=catalog.genders[0];
const config=JSON.parse(readFileSync(root+'/shared/colossus.json','utf8'));
const trackLength=name=>{
 const points=config.tracks[name]?.points;
 assert(Array.isArray(points)&&points.length>1,`Missing colossus track: ${name}`);
 return points.slice(1).reduce((s,p,i)=>s+Math.hypot(...p.map((n,j)=>n-points[i][j])),0);
};
const climbGate=config.passages.find(p=>p.toTrack==='climb');
assert(climbGate,'Config must expose the climb passage');
const climbStart=climbGate.toS;
const climbEnd=trackLength('climb');
const harborSkip=trackLength('harbor')-3;
const climbProgressFloor=climbStart+(climbEnd-climbStart)*.15;
const climbReturnFloor=climbStart+(climbEnd-climbStart)*.8;
const routeAttempts=Math.max(80,Math.ceil((climbEnd-climbStart)*2));
const colossusState=c=>c.latest?.colossus;
const assertSnapshotContract=c=>{
 const state=colossusState(c);
 assert(state,'snapshot must include colossus state');
 assert(Number.isSafeInteger(state.mapStage)&&state.mapStage>=1,'snapshot mapStage must be a positive integer');
 assert(typeof state.region==='string'&&state.region.length>0,'snapshot region must be present');
 assert(Number.isFinite(state.seconds)&&Number.isSafeInteger(state.sequence),'snapshot time/sequence contract changed');
 assert(state.frame&&Number.isSafeInteger(state.frame.revision),'snapshot frame revision must be present');
 assert(Array.isArray(state.actors)&&state.actors.length>0,'snapshot actors must be present');
 assert(Array.isArray(state.people)&&Array.isArray(state.stones),'snapshot scene actors must be present');
 assert(state.bridgeAge===null||Number.isFinite(state.bridgeAge),'snapshot bridgeAge must be null or finite');
};
async function create(letter){
 const stamp=Date.now().toString(36),credentials={username:'harbor_'+letter+'_'+stamp,password:'Isolated_Harbor_2026'};await post('/api/register',credentials);const account=await post('/api/login',credentials);
 const appearance={gender:g.gender,skin:catalog.skin[0]};for(const k of ['face','hair','coat','pants','shoes','weapon'])appearance[k]=g[k][0];
 await post('/api/lobby',{token:account.token,action:'create',requestId:'harbor-'+stamp,name:'渡客'+letter+stamp.slice(-5),appearance});
 const list=await post('/api/lobby',{token:account.token,action:'list',channelId:1});
 return post('/api/lobby',{token:account.token,action:'select',characterId:list.characters[0].id,channelId:1});
}
async function connect(session){
 assert.equal(session.protocolVersion,expectedProtocol,'candidate protocol differs from shared/protocol.ts');
 assert.equal(session.contentVersion,expectedContent,'candidate content differs from shared/protocol.ts');
 const ws=new WebSocket(base.replace('http','ws')+'/ws'),client={ws,latest:null,bytes:0,frames:0,maxGap:0,lastAt:0,seq:0,actionSeq:0};
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);client.bytes+=e.data.length;if(m.type==='snapshot'){const now=Date.now();if(client.lastAt)client.maxGap=Math.max(client.maxGap,now-client.lastAt);client.lastAt=now;client.frames++;client.latest=m;client.actionSeq=Math.max(client.actionSeq,m.colossusSequence??0);}else if(m.type==='rejected')client.rejected=m;});
 await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
 client.send=m=>ws.send(JSON.stringify(m));client.action=action=>client.send({type:'colossus',requestId:crypto.randomUUID(),sequence:++client.actionSeq,action});
 client.send({type:'hello',token:session.token,protocolVersion:session.protocolVersion,contentVersion:session.contentVersion});
 await until(()=>client.latest);return client;
}
async function until(test,attempts=100){for(let i=0;i<attempts;i++){if(test())return;await sleep(50);}throw Error('Timed out waiting for authoritative state');}
const self=c=>c.latest.colossus.actors.find(a=>a.id===c.latest.selfId).body;
(async()=>{
 let a,b;
 try {
  const sa=await create('A'),sb=await create('B');a=await connect(sa);b=await connect(sb);a.action('enter');b.action('enter');await until(()=>a.latest.colossus&&b.latest.colossus);assertSnapshotContract(a);assertSnapshotContract(b);
  await until(()=>a.latest.colossus.actors.length>=2);a.action('skip');b.action('skip');await until(()=>self(a).s>harborSkip-.01&&self(b).s>harborSkip-.01);
  assert(a.latest.colossus.seconds>=65,'Use an awakened isolated fixture for the climbing test');
  // The wire action remains `board`; its authoritative destination is now the climb track.
  a.action('board');b.action('board');await until(()=>self(a).track==='climb'&&self(b).track==='climb');
  const input=(c,seq,direction=0,vertical=0,jump=false)=>c.send({type:'input',seq,direction,vertical,jump});
  // Reordered client input: the late older ↑ must never restart climbing.
  input(a,2);await sleep(180);input(a,1,0,-1);await sleep(300);assert(Math.abs(self(a).s-climbStart)<.01);
  let aInput=3,bInput=1;
  for(let i=0;i<routeAttempts&&(self(a).s<climbEnd-.01||self(b).s<climbEnd-.01);i++){input(a,aInput++,0,-1);input(b,bInput++,0,-1);await sleep(150);}
  assertSnapshotContract(a);assert(self(a).track==='climb'&&self(b).track==='climb');assert(self(a).s>climbProgressFloor&&self(b).s>climbProgressFloor);assert(self(a).grounded&&self(b).grounded);
  // ↑ reaches the shoulder passage; Travel only consumes that authored passage.
  a.action('travel');b.action('travel');await until(()=>self(a).track==='shoulder'&&self(b).track==='shoulder');
  input(a,aInput++,0,0,true);await until(()=>!self(a).grounded);await until(()=>self(a).grounded,120);
  assert(Math.abs(a.latest.colossus.frame.revision-b.latest.colossus.frame.revision)<=2);
  input(a,aInput++,0,0);input(b,bInput++,0,0);await sleep(800);
  const before=self(a).s,frame=a.latest.colossus.frame.position;
  await sleep(700);assert(Math.abs(self(a).s-before)<.01);assert.notDeepEqual(frame,a.latest.colossus.frame.position);
  a.ws.close();await sleep(200);a=await connect(sa);await until(()=>a.latest.colossus);assert(Math.abs(self(a).s-before)<.01);assert.equal(a.latest.colossus.actors.filter(p=>p.id===a.latest.selfId).length,1);
  a.send({type:'lifecycle',hidden:true,away:true});await until(()=>a.latest.players.find(p=>p.id===a.latest.selfId)?.away);
  a.send({type:'lifecycle',hidden:false,away:false});await until(()=>!a.latest.players.find(p=>p.id===a.latest.selfId)?.away);
  // ↓ leaves the climb track at its foot and returns to the harbor passage.
  a.action('travel');await until(()=>self(a).track==='climb'&&self(a).s>climbReturnFloor);
  for(let i=0;i<routeAttempts&&self(a).track==='climb';i++){input(a,aInput++,0,1);await sleep(150);}
  await until(()=>self(a).track==='harbor');assert(self(a).s>harborSkip-.01);
  console.log(JSON.stringify({passed:'protocol34, two authenticated riders, climb/↑/↓ harbor return, reordered input, jump/landing, shared frame, idle attachment, reconnect, explicit resume',secondClient:{frames:b.frames,bytes:b.bytes,maxSnapshotGapMs:b.maxGap},localS:[self(a).s,self(b).s]}));
 }finally{for(const c of [a,b])if(c&&c.ws.readyState===WebSocket.OPEN){c.send({type:'logout'});c.ws.close();}}
})().catch(e=>{console.error(e);process.exitCode=1;});
