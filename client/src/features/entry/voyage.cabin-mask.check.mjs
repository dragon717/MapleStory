import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function checkCabinMask(page,output,errors) {
  await page.locator('#username').waitFor({state:'visible',timeout:60000});
  await page.locator('#username').fill('entry_check');await page.locator('#password').fill('entry-check-password');await page.locator('#submit').click();
  await page.locator('.entry-stage-channel').waitFor();
  const samples=[];
  for(const stage of ['characters','create','characters','channel','login']) {
    await page.evaluate(stage=>window.__entry.go(stage),stage);
    await page.waitForFunction(stage=>{const v=window.__entry.voyage;return v.stage===stage&&!v.transition;},stage,{timeout:15000});
    const state=await page.evaluate(()=>{const v=window.__entry.voyage,sky=v.scene.getObjectByName('VoyageSky');return {stage:v.stage,cabin:v.cabinShown,cityVisible:v.city.root.visible,decorVisible:v.skyDecor.visible,background:v.scene.background.getHexString(),top:sky.material.uniforms.top.value.getHexString(),bottom:sky.material.uniforms.bottom.value.getHexString(),windowsVisible:v.model.getObjectByName('SV3_CabinInterior').visible};});
    const cabin=['characters','create'].includes(stage);
    assert.equal(state.cabin,cabin);assert.equal(state.cityVisible,!cabin);assert.equal(state.decorVisible,!cabin);assert.equal(state.windowsVisible,cabin);
    assert.equal(state.background,cabin?'000000':'8ecfec');assert.equal(state.top,cabin?'000000':'62b9e8');assert.equal(state.bottom,cabin?'000000':'e4f2fb');
    if(cabin) {
      await page.waitForTimeout(250);
      const pixel=await page.evaluate(()=>{const v=window.__entry.voyage,T=window.__three,target=new T.WebGLRenderTarget(128,128),old=v.renderer.getRenderTarget();const bytes=new Uint8Array(4);try {v.renderer.setRenderTarget(target);const skyCamera=v.camera.clone();skyCamera.position.copy(v.camera.position);skyCamera.lookAt(skyCamera.position.clone().add(new T.Vector3(0,1,0)));skyCamera.updateMatrixWorld(true);v.renderer.render(v.scene,skyCamera);v.renderer.readRenderTargetPixels(target,64,64,1,1,bytes);return [...bytes];}finally {v.renderer.setRenderTarget(old);target.dispose();v.updateActivity();}});
      assert(pixel.slice(0,3).every(c=>c===0),'the sky outside cabin geometry is truly black in the GPU render');state.outsidePixel=pixel;
      await page.waitForTimeout(150);await page.screenshot({path:path.join(output,'cabin-mask-'+stage+'.png')});
    }
    samples.push(state);
  }
  assert.deepEqual(errors,[]);await fs.writeFile(path.join(output,'cabin-mask-result.json'),JSON.stringify({passed:true,mode:'offline production WebGL; in-memory account replies',samples,errors},null,2),'utf8');
  console.log('PASS cabin black mask: city/water/sky hidden in selection and creation, GPU black outside, restored on deck/login');
}
