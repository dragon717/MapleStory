const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = process.cwd();
const requireClient = createRequire(path.join(root, 'client/package.json'));
const { build } = requireClient('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
const evidence = path.join(root, 'evidence/2026-09-13/现金商店与纸娃娃修复');
const publicRoot = path.join(root, 'client/public-tms273');
(async () => {
  const compiled = await build({ stdin: { resolveDir: root, contents: `
    import { CashShopView } from './client/src/features/cashshop/view.ts';
    import Phaser from './client/node_modules/phaser/dist/phaser.js';
    import { PlayerView } from './client/src/features/player/view.ts';
    import { composeAppearance } from './client/src/features/entry/appearance.ts';
    const manifest = await (await fetch('/assets/manifest.json')).json();
    manifest.appearanceCatalog = await (await fetch('/assets/entry/appearance.json')).json();
    const creation = await (await fetch('/assets/entry/creation.json')).json();
    const options = creation.genders[0];
    const appearance = {gender:0, skin:0, face:options.face[0], hair:options.hair[0], coat:options.coat[0], pants:0, shoes:options.shoes[0], weapon:options.weapon[0]};
    window.sent = []; window.messages = []; window.acceptSend = true;
    window.manifest = manifest;
    window.shop = new CashShopView(document.querySelector('#ui-windows'), manifest, (...args) => window.messages.push(args), message => { if(!window.acceptSend) return false; window.sent.push(message); return true; });
    window.shop.syncPlayer({ id:'offline-preview', name:'預覽角色', cash:50000, appearance, equipped:[appearance.coat,appearance.shoes,appearance.weapon].map(itemId=>({itemId:String(itemId),quantity:1,slot:1})), inventory:[], level:30, job:220 });
    while (!window.shop.data) await new Promise(resolve => setTimeout(resolve,20));
    window.shop.open();
    window.checkWorldDoll = (itemId) => new Promise((resolve,reject) => {
      const catalog = manifest.appearanceCatalog;
      const baseEquipment = [{itemId:String(appearance.coat),slot:5},{itemId:String(appearance.shoes),slot:7},{itemId:String(appearance.weapon),slot:11}];
      const baseActions = composeAppearance(catalog,appearance,baseEquipment);
      const urls = new Set(Object.values(baseActions).flatMap(frames=>frames.flatMap(frame=>frame.parts.map(p=>p.url))));
      const model = {...manifest,map:{layers:[]},appearanceCatalog:catalog};
      const state = {id:'world-preview',name:'紙娃娃',appearance,equipped:baseEquipment,hp:100,action:'stand',level:1,x:150,y:150,vy:0,facing:manifest.avatar.defaultFacing,ladderId:null};
      const host=document.createElement('div');host.style.cssText='position:fixed;left:0;top:0;z-index:99999';document.body.append(host);
      let view,game;
      const timeout=setTimeout(()=>{game?.destroy(true);host.remove();reject(new Error('world cash textures did not load'));},20000);
      class PreviewScene extends Phaser.Scene {
        preload(){for(const url of urls)this.load.image(url,url);}
        create(){view=new PlayerView(this,model,'紙娃娃',true);window.worldDoll=view;window.worldScene=this;state.equipped=[...baseEquipment.filter(i=>i.slot!==5),{itemId,slot:5}];}
        update(){if(!view)return;view.update(state,0);const layer=catalog.cashLayers?.[itemId];const expected=(layer?.actionsByGender?.['0']?.stand??layer?.actions?.stand??[]).flatMap(frame=>frame.parts.map(p=>p.url));if(expected.length&&view.body.list.some(i=>expected.includes(i.texture?.key))&&view.body.list.every(i=>i.texture?.key!=='__MISSING')){clearTimeout(timeout);view.startSkill(2201008,1000);view.update(state,0);const skill=(layer.actionsByGender?.['0']?.skill2201008??layer.actions.skill2201008??[]).flatMap(frame=>frame.parts.map(p=>p.url));const skillBound=view.body.list.some(i=>skill.includes(i.texture?.key));this.scene.pause();resolve({stand:true,skill:skillBound,missing:view.body.list.some(i=>i.texture?.key==='__MISSING')});}}
      }
      game=new Phaser.Game({type:Phaser.CANVAS,width:300,height:200,parent:host,pixelArt:true,audio:{noAudio:true},scene:PreviewScene,banner:false});
    });
  ` }, bundle:true, format:'esm', write:false, target:'es2022' });
  const js = compiled.outputFiles[0].text;
  const css = fs.readFileSync(path.join(root, 'client/src/features/cashshop/style.css'));
  const server = http.createServer((req,res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<!doctype html><meta charset="UTF-8"><style>html,body{margin:0;width:100%;height:100%;background:#17242d;font:12px Arial,sans-serif}#ui-windows{position:absolute;inset:0;overflow:hidden}button,input{font:inherit}</style><link rel="stylesheet" href="/check.css"><div id="ui-windows"></div><script type="module" src="/check.js"></script>');return; }
    if(url.pathname==='/check.js'){res.setHeader('Content-Type','text/javascript');res.end(js);return;}
    if(url.pathname==='/check.css'){res.setHeader('Content-Type','text/css');res.end(css);return;}
    const file = path.resolve(publicRoot, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(publicRoot+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404);res.end();return; }
    res.setHeader('Content-Type',file.endsWith('.json')?'application/json':file.endsWith('.png')?'image/png':'application/octet-stream');fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser = await chromium.launch({headless:true, executablePath:'/Users/muniao/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
  const page = await browser.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const sizes=[];
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForSelector('.cash-shop');
    for(const [width,height] of [[1440,1000],[900,700],[844,390],[390,844],[1440,1000]]) {
      await page.setViewportSize({width,height});
      await page.waitForTimeout(120);
      await page.evaluate(async()=>Promise.all([...document.images].map(i=>i.decode().catch(()=>{}))));
      const geometry=await page.evaluate(()=>{
        const r=document.querySelector('.cash-shop'),b=r.getBoundingClientRect();
        return {layout:r.dataset.layout,x:b.x,y:b.y,width:b.width,height:b.height,overflow:document.documentElement.scrollWidth>innerWidth,broken:[...r.querySelectorAll('img')].filter(i=>i.complete&&!i.naturalWidth).length};
      });
      const balanceVisible=await page.locator('.cash-shop-balance b').evaluate(el=>{const b=el.getBoundingClientRect(), e=document.querySelector('.cash-shop-exit').getBoundingClientRect();return b.width>0&&b.y>=0&&(b.right<=e.left||b.left>=e.right||b.bottom<=e.top||b.top>=e.bottom);});
      assert(balanceVisible, 'balance must not be covered');
      assert(!geometry.overflow,`${width}: page overflow`);assert.equal(geometry.broken,0);
      assert(geometry.x>=-1&&geometry.y>=-1&&geometry.x+geometry.width<=width+1&&geometry.y+geometry.height<=height+1,JSON.stringify(geometry));
      sizes.push({viewportWidth:width,viewportHeight:height,...geometry});
      await page.screenshot({path:path.join(evidence,`cash-shop-${width}x${height}.png`)});
    }
    await page.locator('.cash-shop-cat[data-tab="fashion"]').click();
    const trial = await page.evaluate(()=>window.shop.data.commodities.find(x=>window.manifest.appearanceCatalog.cashAppearance?.items[x.itemId]?.islot==='MaPn'));
    assert(trial,'cash overall must have an indexed appearance');
    await page.locator(`.cash-card[data-sn="${trial.sn}"]`).click();
    await page.locator('.cash-detail-try-on').click();
    await page.waitForFunction(id=>{
      const layer=window.manifest.appearanceCatalog.cashLayers?.[id];
      const urls=new Set((layer?.actionsByGender?.['0']?.stand??layer?.actions?.stand??[]).flatMap(frame=>frame.parts.map(p=>p.url)));
      return [...document.querySelectorAll('.cash-preview-part')].some(img=>urls.has(new URL(img.src).pathname));
    },trial.itemId);
    await page.evaluate(async()=>Promise.all([...document.images].map(i=>i.decode().catch(()=>{}))));
    await page.screenshot({path:path.join(evidence,'cash-shop-try-on.png')});
    const card=page.locator('.cash-card').first();await card.click();
    await page.locator('.cash-detail-cart').click();
    assert.equal(await page.locator('.cash-cart-row').count(),1);
    await page.locator('.cash-shop-checkout').click();
    assert.equal(await page.locator('.cash-cart-row').count(),1,'pending purchase keeps cart');
    await page.evaluate(()=>{const r=window.sent.findLast(x=>x.type==='cashBuy');window.shop.receive({...r,type:'cashBuyResult',success:false,cash:50000,code:'cash_inventory_full',itemId:'',cashSpent:0});});
    assert.equal(await page.locator('.cash-cart-row').count(),1,'failed purchase keeps cart');
    await page.locator('.cash-shop-checkout').click();
    await page.evaluate(()=>{const r=window.sent.findLast(x=>x.type==='cashBuy');window.shop.receive({...r,type:'cashBuyResult',success:true,cash:49000,code:'',itemId:'01702087',cashSpent:1000});});
    assert.equal(await page.locator('.cash-cart-row').count(),0,'successful purchase clears row');
    await page.evaluate(()=>document.querySelector('.cash-card-icon img').src='/intentionally-missing.png');
    await page.waitForSelector('.cash-card-icon.is-missing');
    assert.equal(await page.locator('.cash-card-icon.is-missing img').count(),0,'failed image is removed');
    const worldDoll=await page.evaluate(itemId=>window.checkWorldDoll(itemId),trial.itemId);
    assert.deepEqual(worldDoll,{stand:true,skill:true,missing:false});
    await page.locator('canvas').screenshot({path:path.join(evidence,'world-equipped-paper-doll.png')});
    assert.deepEqual(errors,[]);
    const result={sizes,worldDoll,cashOverallTryOn:true,cartFailureAndSuccess:true,missingImageFallback:true,pageErrors:errors};
    fs.writeFileSync(path.join(evidence,'browser-check.json'),JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify(result));
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1});
