// Explicitly point at an isolated server. This creates two disposable test accounts.
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const root=require('node:path').resolve(__dirname,'..');
const base=process.env.COLOSSUS_TEST_URL;
assert(base&&/^http:\/\/127\.0\.0\.1:\d+$/.test(base)&&!base.endsWith(':3010'),'Set COLOSSUS_TEST_URL to an isolated loopback server (never 3010).');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const post=async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const result=await r.json();assert(r.ok,JSON.stringify(result));return result;};
const catalog=JSON.parse(readFileSync(root+'/shared/character-creation.json','utf8')),g=catalog.genders[0];
async function create(letter){
 const stamp=Date.now().toString(36),credentials={username:'harbor_'+letter+'_'+stamp,password:'Isolated_Harbor_2026'};await post('/api/register',credentials);const account=await post('/api/login',credentials);
 const appearance={gender:g.gender,skin:catalog.skin[0]};for(const k of ['face','hair','coat','pants','shoes','weapon'])appearance[k]=g[k][0];
 await post('/api/lobby',{token:account.token,action:'create',requestId:'harbor-'+stamp,name:'渡客'+letter+stamp.slice(-5),appearance});
 const list=await post('/api/lobby',{token:account.token,action:'list',channelId:1});
 return post('/api/lobby',{token:account.token,action:'select',characterId:list.characters[0].id,channelId:1});
}
async function connect(session){
 const ws=new WebSocket(base.replace('http','ws')+'/ws'),client={ws,latest:null,bytes:0,frames:0,maxGap:0,lastAt:0,seq:0,actionSeq:0};
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);client.bytes+=e.data.length;if(m.type==='snapshot'){const now=Date.now();if(client.lastAt)client.maxGap=Math.max(client.maxGap,now-client.lastAt);client.lastAt=now;client.frames++;client.latest=m;client.actionSeq=Math.max(client.actionSeq,m.colossusSequence??0);}else if(m.type==='rejected')client.rejected=m;});
 await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
 client.send=m=>ws.send(JSON.stringify(m));client.action=action=>client.send({type:'colossus',requestId:crypto.randomUUID(),sequence:++client.actionSeq,action});
 client.send({type:'hello',token:session.token,protocolVersion:session.protocolVersion,contentVersion:session.contentVersion});
 await until(()=>client.latest);return client;
}
async function until(test){for(let i=0;i<100;i++){if(test())return;await sleep(50);}throw Error('Timed out waiting for authoritative state');}
const self=c=>c.latest.colossus.actors.find(a=>a.id===c.latest.selfId).body;
(async()=>{
 let a,b;
 try {
  const sa=await create('A'),sb=await create('B');a=await connect(sa);b=await connect(sb);a.action('enter');b.action('enter');await until(()=>a.latest.colossus&&b.latest.colossus);
  await until(()=>a.latest.colossus.actors.length>=2);a.action('skip');b.action('skip');await until(()=>self(a).s>110&&self(b).s>110);
  assert(a.latest.colossus.seconds>=65,'Use an awakened isolated fixture for the boarding test');a.action('board');b.action('board');await until(()=>self(a).track==='shoulder'&&self(b).track==='shoulder');
  const input=(c,seq,direction,jump=false)=>c.send({type:'input',seq,direction,vertical:0,jump});
  // Reordered client input: the late older direction must never restart movement.
  input(a,2,0);await sleep(180);input(a,1,1);await sleep(300);assert(self(a).s<.01);
  for(let i=0;i<14;i++){input(a,3+i,1,i===6);input(b,1+i,1);await sleep(150);}input(a,17,0);input(b,15,0);await sleep(800);
  assert(self(a).s>6&&self(b).s>6);assert(self(a).grounded&&self(b).grounded);assert(Math.abs(a.latest.colossus.frame.revision-b.latest.colossus.frame.revision)<=2);
  const before=self(a).s,frame=a.latest.colossus.frame.position;
  await sleep(700);assert(Math.abs(self(a).s-before)<.01);assert.notDeepEqual(frame,a.latest.colossus.frame.position);
  a.ws.close();await sleep(200);a=await connect(sa);await until(()=>a.latest.colossus);assert(Math.abs(self(a).s-before)<.01);assert.equal(a.latest.colossus.actors.filter(p=>p.id===a.latest.selfId).length,1);
  a.send({type:'lifecycle',hidden:true,away:true});await until(()=>a.latest.players.find(p=>p.id===a.latest.selfId)?.away);
  a.send({type:'lifecycle',hidden:false,away:false});await until(()=>!a.latest.players.find(p=>p.id===a.latest.selfId)?.away);
  console.log(JSON.stringify({passed:'two authenticated riders, reordered input, jump/landing, shared frame, idle attachment, reconnect, explicit resume',secondClient:{frames:b.frames,bytes:b.bytes,maxSnapshotGapMs:b.maxGap},localS:[self(a).s,self(b).s]}));
 }finally{for(const c of [a,b])if(c&&c.ws.readyState===WebSocket.OPEN){c.send({type:'logout'});c.ws.close();}}
})().catch(e=>{console.error(e);process.exitCode=1;});
