// Real pointer/keyboard UI check with isolated fixtures; never sends to game server or writes accounts.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
(async()=>{
 const browser=await chromium.launch({headless:false,executablePath:process.env.PLAYWRIGHT_EXECUTABLE||path.join(os.homedir(),'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')});
 const out=path.resolve(__dirname,'../artifacts/character-hold');fs.mkdirSync(out,{recursive:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto((process.env.HENESYS_URL||'http://127.0.0.1:5187')+'/henesys-preview.html');
  await page.waitForFunction(()=>window.henesysPreview?.world.isLoaded);
  await page.evaluate(async()=>{
   const p=window.henesysPreview;clearInterval(p.timer);p.game.loop.sleep();
   const {CharacterInfoView}=await import('/src/features/character/view.ts');
   const state={...p.snapshot.players[0],username:'属性自检',level:12,hp:100,maxHp:100,mp:60,maxMp:80,exp:345,expToNext:500,job:220,abilityStats:{strength:10,dexterity:10,intelligence:40,luck:10,availableAp:30},derivedStats:{magicAttack:55,defense:9,moveSpeed:150,currentMoveSpeed:225,magicGuard:true},mount:{itemId:'1902000',tamingMob:1902000,speed:150,jump:100,fs:100,fatigue:0}};
   const t=window.characterCheck={state,requests:[],reply:true,success:true,send:true,messages:[]};
   t.view=new CharacterInfoView(document.querySelector('#windows'),p.manifest,m=>t.messages.push(m),r=>{
    if(!t.send)return false;t.requests.push({...r,time:performance.now()});
    if(t.reply)setTimeout(()=>{if(t.success){t.state.abilityStats[r.stat]++;t.state.abilityStats.availableAp--;}
     t.view.receiveAbilityResult({type:'abilityResult',requestId:r.requestId,success:t.success,code:t.success?'':'not_enough_ap',abilityStats:{...t.state.abilityStats}});
     t.view.update({...t.state});},35);return true;
   });t.view.update(state);
  });
  await page.keyboard.press('c');assert.equal(await page.evaluate(()=>characterCheck.view.isOpen()),true);
  assert.equal(await page.locator('[data-field="moveSpeed"]').innerText(),'225 px/s');
  assert.match(await page.locator('[data-field="movementNote"]').innerText(),/150 px\/s.*骑乘 150%/);
  await page.evaluate(()=>{const t=characterCheck;t.view.update({...t.state,mount:undefined,derivedStats:{...t.state.derivedStats,currentMoveSpeed:150}});});
  assert.equal(await page.locator('[data-field="moveSpeed"]').innerText(),'150 px/s');
  await page.evaluate(()=>characterCheck.view.update(characterCheck.state));
  const plus=page.getByRole('button',{name:'增加力量',exact:true});
  const count=()=>page.evaluate(()=>characterCheck.requests.length);
  await plus.click();await page.waitForTimeout(80);assert.equal(await count(),1,'short click allocates once');
  const point=async()=>{const r=await plus.boundingBox();return {x:r.x+r.width/2,y:r.y+r.height/2};};
  const down=async()=>{const p=await point();await page.mouse.move(p.x,p.y);await page.mouse.down();};
  await down();await page.waitForTimeout(1450);assert.equal(await count(),1,'no allocation while charging');
  assert.equal(await page.locator('.character-hold-ring').isVisible(),true);await page.screenshot({path:path.join(out,'hold-progress.png')});
  await page.waitForTimeout(1800);assert((await count())>=2,'repeat starts after three real seconds: '+JSON.stringify(await page.evaluate(()=>({hold:characterCheck.view.hold,now:performance.now(),pending:[...characterCheck.view.pendingAllocations],open:characterCheck.view.isOpen(),ring:document.querySelector('.character-hold-ring').outerHTML,focus:document.hasFocus()}))));
  await page.waitForTimeout(350);await page.mouse.up();const released=await count();await page.waitForTimeout(250);assert.equal(await count(),released,'release neither repeats nor emits an extra click');
  const accounting=await page.evaluate(()=>({ap:characterCheck.state.abilityStats.availableAp,requests:characterCheck.requests}));
  assert.equal(accounting.ap,30-accounting.requests.length);assert.equal(new Set(accounting.requests.map(r=>r.requestId)).size,accounting.requests.length);
  await down();const beforeLeave=await count();await page.mouse.move(30,30);await page.mouse.up();await page.waitForTimeout(150);assert.equal(await count(),beforeLeave,'moving out cancels');
  await page.evaluate(()=>{characterCheck.reply=false;});await down();await page.evaluate(()=>characterCheck.view.hold.started-=3001);await page.waitForTimeout(400);const pending=await count();await page.waitForTimeout(200);assert.equal(await count(),pending,'at most one request awaiting acknowledgement');
  assert.equal(await page.getByRole('button',{name:'增加智力',exact:true}).isDisabled(),true);
  await page.mouse.up();await page.evaluate(()=>{const t=characterCheck,r=t.requests.at(-1);t.view.receiveReject(r.requestId);t.reply=true;});
  for(const reason of ['blur','close','cancel','disconnect','death']){
   await page.evaluate(()=>{const t=characterCheck;t.view.update(t.state);t.view.open();});await down();const before=await count();
   await page.evaluate(reason=>{const t=characterCheck;if(reason==='blur')dispatchEvent(new Event('blur'));else if(reason==='close')t.view.close();else if(reason==='cancel')document.dispatchEvent(new PointerEvent('pointercancel'));else t.view.update(reason==='disconnect'?undefined:{...t.state,hp:0});},reason);
   await page.mouse.up();await page.waitForTimeout(160);assert.equal(await count(),before,reason+' cancels without allocation');assert.equal(await page.locator('.character-hold-ring').isVisible(),false);
  }
  await page.evaluate(()=>{const t=characterCheck;t.view.update(t.state);t.view.open();t.success=false;});await down();await page.evaluate(()=>characterCheck.view.hold.started-=3001);await page.waitForTimeout(300);await page.mouse.up();const failed=await count();await page.waitForTimeout(150);assert.equal(await count(),failed,'rejected AP stops held gesture');
  await page.evaluate(()=>{const t=characterCheck;t.success=true;t.state.abilityStats.availableAp=1;t.view.update(t.state);});await down();await page.evaluate(()=>characterCheck.view.hold.started-=3001);await page.waitForTimeout(250);await page.mouse.up();assert.equal(await plus.isDisabled(),true);assert.equal(await page.locator('.character-hold-ring').isVisible(),false,'exhaustion stops ring');
  await page.evaluate(()=>{const t=characterCheck;t.state.abilityStats.availableAp=10;t.view.update(t.state);t.send=false;});await down();await page.evaluate(()=>characterCheck.view.hold.started-=3001);await page.waitForTimeout(150);await page.mouse.up();assert.equal(await page.locator('.character-hold-ring').isVisible(),false,'send failure stops');
  await page.evaluate(()=>{characterCheck.send=true;});await plus.focus();const keyboard=await count();await page.keyboard.press('Enter');await page.waitForTimeout(80);assert.equal(await count(),keyboard+1,'keyboard activation allocates once');
  const layouts=[];
  for(const viewport of [{width:1440,height:900},{width:844,height:390},{width:390,height:844},{width:320,height:640}]){
   await page.setViewportSize(viewport);await page.evaluate(()=>characterCheck.view.open());await plus.scrollIntoViewIfNeeded();
   const layout=await page.evaluate(()=>{const w=document.querySelector('.character-window'),r=w.getBoundingClientRect(),scroll=w.querySelector('.character-scroll');return {width:innerWidth,height:innerHeight,document:document.documentElement.scrollWidth,left:r.left,right:r.right,top:r.top,bottom:r.bottom,scrollWidth:scroll.scrollWidth,clientWidth:scroll.clientWidth,buttons:[...w.querySelectorAll('.character-ap-button')].map(b=>{const q=b.getBoundingClientRect();return q.left>=r.left&&q.right<=r.right;})};});
   assert(layout.document<=layout.width&&layout.left>=0&&layout.right<=layout.width+.5&&layout.top>=0&&layout.bottom<=layout.height+.5&&layout.scrollWidth<=layout.clientWidth&&layout.buttons.every(Boolean),JSON.stringify(layout));layouts.push(layout);await page.screenshot({path:path.join(out,'character-'+viewport.width+'.png')});
  }
  await page.evaluate(()=>{characterCheck.view.close();henesysPreview.activities.showEnvironment();});
  assert.equal(await page.locator('.environment-controls').getAttribute('open'),'');assert.equal(await page.getByLabel('时段',{exact:true}).isVisible(),true);await page.screenshot({path:path.join(out,'environment-entry.png')});
  await page.evaluate(()=>{henesysPreview.activities.close();characterCheck.view.destroy();});assert.equal(await page.locator('.character-hold-ring').count(),0);
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'check.json'),JSON.stringify({accounting,layouts,errors},null,2)+'\n','utf8');console.log('PASS: current/ride readouts, three-second pointer ring, paced acknowledged AP, cancellations, failure/exhaustion, keyboard, responsive C window, direct environment entry and cleanup.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
