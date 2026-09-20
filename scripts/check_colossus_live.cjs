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
assert.equal(expectedProtocol,33,'shared protocol must be 33');
assert.equal(expectedContent,'tms273-33','shared content must be tms273-33');
const catalog=JSON.parse(readFileSync(root+'/shared/character-creation.json','utf8')),g=catalog.genders[0];
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
const config=JSON.parse(readFileSync(root+'/shared/colossus.json','utf8'));
const climbEnd=config.tracks.climb.points.slice(1).reduce((s,p,i)=>s+Math.hypot(...p.map((n,j)=>n-config.tracks.climb.points[i][j])),0);
(async()=>{
 let a,b;
 try {
  const sa=await create('A'),sb=await create('B');a=await connect(sa);b=await connect(sb);a.action('enter');b.action('enter');await until(()=>a.latest.colossus&&b.latest.colossus);
  await until(()=>a.latest.colossus.actors.length>=2);a.action('skip');b.action('skip');await until(()=>self(a).s>110&&self(b).s>110);
  assert(a.latest.colossus.seconds>=65,'Use an awakened isolated fixture for the climbing test');
  // The wire action remains `board`; its authoritative destination is now the climb track.
  a.action('board');b.action('board');await until(()=>self(a).track==='climb'&&self(b).track==='climb');
  const input=(c,seq,direction=0,vertical=0,jump=false)=>c.send({type:'input',seq,direction,vertical,jump});
  // Reordered client input: the late older ↑ must never restart climbing.
  input(a,2);await sleep(180);input(a,1,0,-1);await sleep(300);assert(self(a).s<.01);
  let aInput=3,bInput=1;
  for(let i=0;i<80&&(self(a).s<climbEnd-.01||self(b).s<climbEnd-.01);i++){input(a,aInput++,0,-1);input(b,bInput++,0,-1);await sleep(150);}
  assert(self(a).track==='climb'&&self(b).track==='climb');assert(self(a).s>6&&self(b).s>6);assert(self(a).grounded&&self(b).grounded);
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
  a.action('travel');await until(()=>self(a).track==='climb'&&self(a).s>30);
  for(let i=0;i<80&&self(a).track==='climb';i++){input(a,aInput++,0,1);await sleep(150);}
  await until(()=>self(a).track==='harbor');assert(self(a).s>110);
  console.log(JSON.stringify({passed:'protocol33, two authenticated riders, climb/↑/↓ harbor return, reordered input, jump/landing, shared frame, idle attachment, reconnect, explicit resume',secondClient:{frames:b.frames,bytes:b.bytes,maxSnapshotGapMs:b.maxGap},localS:[self(a).s,self(b).s]}));
 }finally{for(const c of [a,b])if(c&&c.ws.readyState===WebSocket.OPEN){c.send({type:'logout'});c.ws.close();}}
})().catch(e=>{console.error(e);process.exitCode=1;});
