// One targeted check: actual Web Audio output, production World/Combat, no server/account writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
(async()=>{
 const browser=await chromium.launch({headless:false,executablePath:process.env.PLAYWRIGHT_EXECUTABLE||path.join(os.homedir(),'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),args:['--use-angle=metal']});
 try{
  const context=await browser.newContext({viewport:{width:1100,height:750}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});page.on('console',m=>{if(m.type()==='error')console.error(m.text());});page.on('response',r=>{if(r.status()>=400)console.error(r.status(),r.url());});
  await page.goto((process.env.HENESYS_URL||'http://127.0.0.1:5187')+'/henesys-preview.html?audio=1');
  await page.locator('#activities').click();
  await page.waitForFunction(()=>window.henesysPreview?.world.henesys&&window.henesysPreview.world.players.size,null,{timeout:60000});
  await page.locator('#activities').click();
  await page.locator('.henesys-view').click({position:{x:950,y:600}});
  await page.waitForFunction(()=>window.henesysPreview.game.sound.context.state==='running');
  await page.waitForFunction(()=>window.henesysPreview.world.bgm.isPlaying);
  const result=await page.evaluate(async()=>{
   const {VillageAudio,FOOT_SOUNDS}=await import('/src/features/henesys/audio.ts'),{MUSIC_SPOTS,point3d,segmentAt}=await import('/src/features/henesys/coordinates.ts');
   const p=window.henesysPreview,w=p.world,a=w.villageAudio;clearInterval(p.timer);
   const player={...p.snapshot.players[0]},bgm=w.bgm;
   const sample=async()=>{const s=p.game.sound,node=s.context.createAnalyser(),data=new Float32Array(node.fftSize);s.masterVolumeNode.connect(node);let peak=0;for(let i=0;i<12;i++){await new Promise(r=>setTimeout(r,50));node.getFloatTimeDomainData(data);for(const v of data)peak=Math.max(peak,Math.abs(v));}s.masterVolumeNode.disconnect(node);return peak;};
   p.sampleAudio=sample;const output=await sample();
   p.game.events.emit('blur');await new Promise(r=>setTimeout(r,100));
   const visibleBlur={hidden:document.hidden,state:p.game.sound.context.state,output:await sample()};p.game.events.emit('focus');
   const original=a.play.bind(a),cues=[];let clock=1000;
   a.play=(key,volume,owner)=>cues.push({key,volume,owner,at:clock});
   // Drive production distance/cadence logic with actual authored ground heights.
   const update=(elapsed=16)=>{clock+=elapsed;a.update([player],player.id,{yaw:0,pitch:0},clock);};
   const ground=()=>{const {a,b}=segmentAt(player.x);player.y=a.y+(b.y-a.y)*(player.x-a.x)/(b.x-a.x);};
   const reset=x=>{a.steps.clear();cues.length=0;player.x=x;ground();player.grounded=true;player.action='walk';update();};
   const travel=(speed,frames)=>{for(let i=0;i<frames;i++){player.x+=speed*45*.016;ground();update();}};
   const cadence=[];
   for(const speed of [1.5,3,5]){reset(100500);travel(speed,375);cadence.push({speed,count:cues.length,keys:cues.map(c=>c.key),gaps:cues.slice(1).map((c,i)=>c.at-cues[i].at)});}
   const walk=cues.length;
   player.action='stand';for(let i=0;i<30;i++)update();const stand=cues.length;
   player.grounded=false;player.action='jump';travel(3,30);const air=cues.length;
   player.grounded=true;player.action='stand';ground();update();const land=cues.length;
   player.x+=400;ground();player.action='walk';update();const teleport=cues.length;
   player.x+=10;ground();update(1000);update();const stalled=cues.length;
   const surfaces=[];
   for(const [name,x] of [['wood',254622.15467420357],['grass',279151.6496429971]]){reset(x);travel(3,180);surfaces.push({name,keys:cues.map(c=>c.key),volumes:cues.map(c=>c.volume)});}
   const decoded=FOOT_SOUNDS.map(key=>{const buffer=p.game.cache.audio.get(key);return {key,duration:buffer?.duration,decoded:buffer instanceof AudioBuffer};});
   a.play=original;
   // Solo a real downloaded recording through the production sound graph, not the BGM.
   bgm.pause();await new Promise(r=>setTimeout(r,900));
   a.play('/assets/chuxian/audio/wood-3.ogg',.21,player.id);const footOutput=await sample();bgm.resume();
   const sound=p.game.sound.add(p.manifest.skillSounds['2001009'].use.url);a.attach(sound,player.id);sound.play({volume:0});
   update();const sourcePosition=sound.spatialNode.positionX.value;const size=a.sources.size;sound.destroy();const removed=a.sources.size===size-1;
   const source=bgm.source;a.setSpatial(false);await new Promise(r=>setTimeout(r,800));const rollback={dry:a.dry.gain.value,space:a.spatial.gain.value,sameSource:bgm.source===source};a.setSpatial(true);
   w.setMuted(true);await new Promise(r=>setTimeout(r,60));const mute=p.game.sound.masterMuteNode.gain.value;w.setMuted(false);
   w.setSoundVolume(.4);await new Promise(r=>setTimeout(r,60));const volume=p.game.sound.masterVolumeNode.gain.value;w.setSoundVolume(1);
   const props=MUSIC_SPOTS.map(s=>{const g=w.henesys.model.getObjectByName(s.name);return {name:s.name,position:g?.position.toArray(),meshes:g?.children.length};});
   // Render the production spatial graph offline; measure the actual stereo samples.
   const render=async(dx,distance,spatial=true)=>{
    const c=new OfflineAudioContext(2,44100,44100),gain=c.createGain(),native=c.createPanner();
    gain.connect(native);native.connect(c.destination);
    const scene={sound:{context:c,destination:c.destination,mute:false},cache:{audio:{exists:()=>false}}};
    const offline=new VillageAudio(scene,{volumeNode:gain,spatialNode:native});offline.setSpatial(spatial);
    const base=point3d(player.x,player.y),spot=MUSIC_SPOTS[0];
    offline.listener=[spot.position[0]-dx,spot.position[1]+1,spot.position[2]+distance];
    offline.yaw=0;offline.pitch=0;
    // Solo one music-colour bus to distinguish panning/attenuation from full-mix stereo.
    offline.dry.gain.cancelScheduledValues(0);offline.dry.gain.value=0;
    offline.music.forEach((pan,i)=>{if(i)pan.disconnect();else offline.place(pan,[spot.position[0],spot.position[1]+1,spot.position[2]],true);});
    const osc=c.createOscillator();osc.frequency.value=330;osc.connect(gain);osc.start(0);osc.stop(.8);
    const b=await c.startRendering();const energy=[0,1].map(channel=>{const d=b.getChannelData(channel);let sum=0;for(let i=6000;i<30000;i++)sum+=d[i]*d[i];return sum;});offline.destroy();return energy;
   };
   const left=await render(-5,4),right=await render(5,4),far=await render(5,50);
   const summary={cadence,surfaces,decoded,footOutput,stalled,output,visibleBlur,track:bgm.key,duration:bgm.duration,loop:bgm.loop,contextSame:a.context===p.game.sound.context,walk,stand,air,land,teleport,removed,rollback,mute,volume,props,left,right,far};
   return summary;
  });
  assert(!result.visibleBlur.hidden&&result.visibleBlur.state==='running'&&result.visibleBlur.output>.001,'visible window blur must not silence BGM');
  assert(result.output>.001,'original BGM must reach the actual master output');
  // Drive the real document listeners; the automation browser keeps its tabs visible.
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForFunction(()=>window.henesysPreview.game.sound.context.state==='suspended');
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForFunction(()=>window.henesysPreview.game.sound.context.state==='running');
  const returnedOutput=await page.evaluate(async()=>{
    const show=value=>{Object.defineProperty(document,'hidden',{configurable:true,value});document.dispatchEvent(new Event('visibilitychange'));};
    // A fast visible→hidden transition must defeat Phaser's old delayed resume.
    show(true);show(false);await new Promise(r=>setTimeout(r,30));show(true);await new Promise(r=>setTimeout(r,180));
    if(window.henesysPreview.game.sound.context.state!=='suspended')throw new Error('hidden tab resumed after a fast switch');
    show(false);await new Promise(r=>setTimeout(r,100));const output=await window.henesysPreview.sampleAudio();delete document.hidden;return output;
  });assert(returnedOutput>.001,'returning to visible page must restore BGM output without another click');
  assert(result.track.includes('FloralLife')&&result.duration>130&&result.loop&&result.contextSame);
  assert(result.cadence[0].count>0&&result.cadence[0].count<result.cadence[1].count&&result.cadence[1].count<result.cadence[2].count,'actual speed must increase cadence');
  for(const c of result.cadence){assert(c.gaps.every(g=>g>=180));assert(c.keys.every(k=>k.startsWith('/assets/chuxian/audio/stone-')));assert(c.keys.every((k,i)=>!i||k!==c.keys[i-1]),'adjacent footfalls must vary');}
  assert.equal(result.stand,result.walk);assert.equal(result.air,result.walk);assert.equal(result.land,result.walk+1);assert.equal(result.teleport,result.land);assert.equal(result.stalled,result.land);
  for(const s of result.surfaces){assert(s.keys.length>2&&s.keys.every(k=>k.startsWith('/assets/chuxian/audio/'+s.name+'-')));assert(s.volumes.every(v=>v>0&&v<=1));}
  assert(result.decoded.length===11&&result.decoded.every(s=>s.decoded&&s.duration>.1&&s.duration<.6),'all original OGG recordings must decode');
  assert(result.footOutput>.005,'recorded footstep must reach actual master output');
  assert(result.removed);assert(result.rollback.sameSource&&result.rollback.dry>.99&&result.rollback.space<.01);
  assert.equal(result.mute,0);assert(Math.abs(result.volume-.4)<.001);
  assert(result.props.every(p=>p.position&&p.meshes>=10));
  assert(result.left[0]>result.left[1]*1.1&&result.right[1]>result.right[0]*1.1,'actual stereo output follows source side');
  assert(result.far[0]+result.far[1]<(result.right[0]+result.right[1])*.1,'physical distance attenuates audio');
  await page.evaluate(()=>{const p=window.henesysPreview,w=p.world;p.activities.close(false);const self={...p.snapshot.players[0],x:102431.66838016416,y:-225};w.selfMotion.snap(self.id);w.receive({...p.snapshot,serverTick:p.snapshot.serverTick+1,players:[self]});});
  await page.waitForTimeout(250);
  await page.screenshot({path:path.resolve(__dirname,'../artifacts/henesys/east-village/audio-scene.png')});
  // Real login gesture first, asynchronous game creation later: no diagnostic resume().
  await page.evaluate(async()=>{
    const {installGameAudio}=await import('/src/features/world/game-audio.ts');
    const button=document.createElement('button');button.id='audio-login-check';button.textContent='音频入口检查';button.style.cssText='position:fixed;top:80px;right:10px;z-index:99999';document.body.append(button);
    const check={game:undefined,gate:undefined};check.gate=installGameAudio(button,()=>check.game);window.audioEntryCheck=check;
    button.onclick=async()=>{await new Promise(r=>setTimeout(r,150));check.game=new window.henesysPreview.game.constructor({type:3,width:1,height:1,banner:false,audio:{context:check.gate.context()}});check.gate.bind(check.game);};
    button.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));check.syntheticIgnored=!check.gate.context();
  });
  await page.locator('#audio-login-check').click();
  await page.waitForFunction(()=>window.audioEntryCheck.game?.sound?.context?.state==='running');
  const entry=await page.evaluate(async()=>{const c=window.audioEntryCheck;const result={syntheticIgnored:c.syntheticIgnored,prepared:c.gate.context()===c.game.sound.context,running:c.game.sound.context.state==='running'};const destroyed=new Promise(r=>c.game.events.once('destroy',r));c.game.destroy(true);await destroyed;c.gate.dispose();await c.gate.context().close();document.querySelector('#audio-login-check').remove();return result;});
  assert.deepEqual(entry,{syntheticIgnored:true,prepared:true,running:true});
  const lifecycle=await page.evaluate(async()=>{
   const p=window.henesysPreview,w=p.world,old=w.villageAudio;w.setThreeEnabled(false);
   const wait=()=>new Promise(r=>setTimeout(r,50));for(let i=0;i<400&&!w.isLoaded;i++)await wait();
   const sample=async()=>{const s=p.game.sound,node=s.context.createAnalyser(),d=new Float32Array(node.fftSize);s.masterVolumeNode.connect(node);let peak=0;for(let i=0;i<12;i++){await new Promise(r=>setTimeout(r,50));node.getFloatTimeDomainData(d);for(const v of d)peak=Math.max(peak,Math.abs(v));}s.masterVolumeNode.disconnect(node);return peak;};
   const original=!w.villageAudio&&w.bgm.isPlaying,originalOutput=await sample();
   w.setThreeEnabled(true);for(let i=0;i<400&&(!w.isLoaded||!w.villageAudio);i++)await wait();
   const reentered=!!w.villageAudio&&w.bgm.isPlaying,reenteredOutput=await sample();
   // Formal entry starts on the birth map and receives the saved map via snapshot.
   const birth=p.manifest.mapCatalog.maps.find(m=>m.id==='000010000');w.switchMap(birth.id,birth);
   for(let i=0;i<400&&!w.isLoaded;i++)await wait();
   w.receive(p.snapshot);for(let i=0;i<400&&(!w.isLoaded||!w.villageAudio);i++)await wait();
   const savedMapOutput=await sample();
   return {originalOutput,reenteredOutput,savedMapOutput,cleared:old.disposed&&old.sources.size===0,original,reentered,tracks:p.game.sound.sounds.filter(s=>!s.pendingRemove&&s.loop&&s.isPlaying).length};
  });
  assert(lifecycle.originalOutput>.001&&lifecycle.reenteredOutput>.001&&lifecycle.savedMapOutput>.001,'BGM output survives 2D, 3D and birth→saved-map restart');assert(lifecycle.cleared&&lifecycle.original&&lifecycle.reentered&&lifecycle.tracks===1);assert.deepEqual(errors,[]);
  fs.writeFileSync(path.resolve(__dirname,'../artifacts/henesys/east-village/audio-check.json'),JSON.stringify({result,returnedOutput,entry,lifecycle,errors},null,2)+'\n','utf8');
  console.log('PASS: original BGM, single context/track, visible blur, hidden/return/rapid visibility, real BGM output across map restarts, physical props, stereo samples, distance, recorded surface variants/speed cadence/landing/teleport/stall suppression, rollback/mute/volume and 3D→2D→3D cleanup. '+JSON.stringify({left:result.left,right:result.right,far:result.far,lifecycle}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
