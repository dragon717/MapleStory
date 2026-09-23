// Run against an isolated Vite server; no backend connection or persistent data writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = process.env.HENESYS_CDP ? await chromium.connectOverCDP(process.env.HENESYS_CDP) : await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE}:{})});
  const context = await browser.newContext({viewport:{width:1440,height:900}});
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => { errors.push(String(error)); console.error(String(error)); });
  try {
    await page.goto((process.env.HENESYS_URL || 'http://127.0.0.1:5187')+'/henesys-preview.html');
    await page.waitForFunction(() => window.henesysPreview?.world.isLoaded && document.querySelector('.henesys-view canvas'), null, {timeout:90000});
    await page.waitForFunction(() => window.henesysPreview.world.players.size === 1);
    const out = path.resolve('artifacts/henesys'); fs.mkdirSync(out,{recursive:true});
    await page.screenshot({path:path.join(out,'login-3d.png')});
    await page.evaluate(() => {
      const p=window.henesysPreview;
      p.snapshot.npcs=[{id:'npc-test',templateId:'1012000',name:'点击检查',x:790,y:297,facing:-1,questAvailable:true}];
      p.snapshot.monsters=[{id:'mob-test',templateId:'100000',x:1000,y:297,facing:-1,hp:30,maxHp:30,action:'move',actionStartedTick:0}];
    });
    await page.waitForFunction(() => window.henesysPreview.world.npcs.size===1 && window.henesysPreview.world.monsters.size===1);
    const point = await page.evaluate(() => {
      const v=window.henesysPreview.world.henesys;
      const point=v.camera.position.clone().set((790-3285)/45,(450-253)/45,4.2).project(v.camera);
      return {x:(point.x+1)*innerWidth/2,y:(1-point.y)*innerHeight/2};
    });
    await page.mouse.click(point.x,point.y);
    await page.getByText('NPC 点击：npc-test',{exact:true}).waitFor();
    await page.screenshot({path:path.join(out,'npc-monster-3d.png')});
    console.log('3D loaded', await page.evaluate(() => ({loaded:window.henesysPreview.world.isLoaded, errors:document.querySelector('output').textContent})));
    await page.getByRole('button',{name:'活动',exact:true}).click();
    await page.getByRole('button',{name:'返回原版 2D',exact:true}).click();
    await page.waitForFunction(() => window.henesysPreview.world.isLoaded && !document.querySelector('.henesys-view'));
    assert.equal(await page.evaluate(()=>window.henesysPreview.world.isThreeEnabled),false);
    assert.equal(await page.evaluate(()=>window.henesysPreview.world.snapshot.players[0].mesos),123);
    await page.evaluate(()=>{const p=window.henesysPreview;clearInterval(p.timer);p.world.pendingEmoticons=[{authorId:'preview',frames:[]}];p.world.pendingSnapshot=p.snapshot;p.world.disconnect();});
    assert.equal(await page.evaluate(()=>window.henesysPreview.world.pendingEmoticons.length),0);
    assert.equal(await page.evaluate(()=>window.henesysPreview.world.pendingSnapshot===undefined),true);
    await page.waitForFunction(()=>window.henesysPreview.world.isLoaded && window.henesysPreview.world.backgrounds.length>0 && window.henesysPreview.world.portals.size>0);
    await page.evaluate(()=>{const p=window.henesysPreview;p.world.receive(p.snapshot);});
    await page.waitForFunction(()=>window.henesysPreview.world.players.size===1);
    await page.screenshot({path:path.join(out,'original-2d.png')});
    await page.getByRole('button',{name:'活动',exact:true}).click();
    await page.getByRole('button',{name:'启用三维射手村',exact:true}).click();
    await page.waitForFunction(() => window.henesysPreview.world.isLoaded && document.querySelector('.henesys-view canvas'));
    assert.equal(await page.locator('.henesys-view').count(),1);
    await page.mouse.move(720,400); await page.mouse.down({button:'right'}); await page.mouse.move(820,440); await page.mouse.up({button:'right'});
    assert.notEqual(await page.evaluate(()=>window.henesysPreview.world.henesys.yaw),0);
    await page.setViewportSize({width:1024,height:768});
    await page.waitForFunction(()=>window.henesysPreview.world.henesys.width===1024);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),1024);
    await page.evaluate(() => {const p=window.henesysPreview; p.snapshot.players[0].x=3000;p.snapshot.players[0].y=300;p.world.receive(p.snapshot);});
    await page.waitForFunction(() => window.henesysPreview.world.snapshot.players[0].x===3000 && window.henesysPreview.world.cameras.main.worldView.centerX > 2500);
    await page.screenshot({path:path.join(out,'center-3d.png')});
    // Leave Henesys through the normal snapshot path, then return: each owns one renderer.
    await page.evaluate(()=>{const p=window.henesysPreview;const map=p.manifest.mapCatalog.maps.find(m=>m.id!==p.snapshot.mapId && m.layers?.length);p.snapshot.mapId=map.id;p.snapshot.players[0].x=map.spawn?.x??500;p.snapshot.players[0].y=map.spawn?.y??300;p.snapshot.npcs=[];p.snapshot.monsters=[];p.world.receive(p.snapshot);});
    await page.waitForFunction(()=>window.henesysPreview.world.isLoaded&&!document.querySelector('.henesys-view'));
    await page.getByRole('button',{name:'活动',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'回到射手村后可切换',exact:true}).isDisabled(),true);
    await page.evaluate(()=>window.henesysPreview.activities.close());
    await page.evaluate(()=>{const p=window.henesysPreview;p.snapshot.mapId='100000000';p.snapshot.players[0].x=698;p.snapshot.players[0].y=297;p.world.receive(p.snapshot);});
    await page.waitForFunction(()=>window.henesysPreview.world.isLoaded&&document.querySelector('.henesys-view'));
    assert.equal(await page.locator('.henesys-view').count(),1);
    await page.waitForFunction(()=>window.henesysPreview.world.players.size===1);
    await page.evaluate(()=>window.henesysPreview.activities.updateColossus(true));
    await page.getByRole('button',{name:'活动',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'回到射手村后可切换',exact:true}).isDisabled(),true);
    assert.deepEqual(errors,[]);
    console.log('PASS: real World + original avatar, activity 3D/2D/3D switch, snapshot preserved, no browser errors');
  } catch (error) {console.error(await page.locator('body').innerText());await page.screenshot({path:'/tmp/henesys-failed.png'});throw error;} finally {await context.close();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
