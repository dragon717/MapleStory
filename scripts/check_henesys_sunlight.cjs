// Targeted render check; no backend, accounts or persistent gameplay state.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1000,height:700},deviceScaleFactor:1});
  const errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error'&&/THREE|shader|WebGL/i.test(m.text()))errors.push(m.text());});
  try {
    await page.goto((process.env.HENESYS_URL||'http://127.0.0.1:5187')+'/henesys-preview.html');
    await page.waitForFunction(()=>window.henesysPreview?.world.isLoaded&&window.henesysPreview.world.henesys?.sunlight.material.uniforms.shadow.value,null,{timeout:90000});
    const result=await page.evaluate(()=>{
      const v=window.henesysPreview.world.henesys;
      clearInterval(window.henesysPreview.timer);
      const t=v.sunlight.scattering, u=v.sunlight.material.uniforms;
      const read=(target=t)=>{const b=new Uint16Array(target.width*target.height*4);v.renderer.readRenderTargetPixels(target,0,0,target.width,target.height,b);let peak=0,sum=0,alphaMin=15360,alphaMax=0;for(let i=0;i<b.length;i++)if(i%4!==3){peak=Math.max(peak,b[i]);sum+=b[i];}else{alphaMin=Math.min(alphaMin,b[i]);alphaMax=Math.max(alphaMax,b[i]);}return {peak,sum,alphaMin,alphaMax};};
      v.draw();const lit=read();
      const strength=u.strength.value;u.strength.value=0;v.draw();const dark=read();
      u.strength.value=strength;v.draw();
      const bloomTarget=v.sunlight.bloom.renderTargetsHorizontal[0], bloom=read(bloomTarget);
      const bloomStrength=v.sunlight.bloom.strength;v.sunlight.bloom.strength=0;v.draw();const noBloom=read(bloomTarget);
      v.sunlight.bloom.strength=bloomStrength;v.draw();
      return {lit,dark,bloom,noBloom,environment:v.scene.environment===v.environment.texture,separateActors:v.paper.parent===v.paperScene,full:[v.sunlight.target.width,v.sunlight.target.height],scattering:[t.width,t.height]};
    });
    await page.screenshot({path:'artifacts/henesys/sunlight-final.png'});
    assert(result.lit.peak>0&&result.lit.sum>0,'scattering must actually contribute pixels');
    assert.equal(result.dark.sum,0,'zero scattering strength must yield no light');
    assert(result.lit.alphaMin>0&&result.lit.alphaMin<15360&&result.lit.alphaMax<=15360,'volume transmission must attenuate light without negative energy');
    assert(result.bloom.sum>0&&result.noBloom.sum===0,'HDR highlights must bloom with a zero-strength control: '+JSON.stringify(result));
    assert(result.environment&&result.separateActors,'sky reflections must light the environment while actors stay outside bloom');
    assert.deepEqual(result.scattering,result.full.map(x=>Math.ceil(x/2)),'only scattering is downsampled');
    assert.deepEqual(errors,[]);
    await page.getByRole('button',{name:'活动',exact:true}).click();
    assert.equal(await page.getByRole('heading',{name:'初弦地',exact:true}).count(),1);
    assert.equal(await page.title(),'初弦地 · 隔离预览');
    console.log('PASS: sky reflections, HDR bloom/scattering pixels and zero-strength controls, volume transmission, clear actors, 初弦地 name; '+JSON.stringify(result));
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
