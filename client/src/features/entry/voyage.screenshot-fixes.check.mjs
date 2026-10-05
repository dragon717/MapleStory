import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function checkScreenshotFixes(page, output, errors) {
  const states = {};
  states.login = await page.evaluate(() => {
    const v=window.__entry.voyage,root=v.model.getObjectByName('SV3_LoginRedesign_Root');
    const materials=new Set();root?.traverse(o=>{for(const m of Array.isArray(o.material)?o.material:o.material?[o.material]:[])materials.add(m.name);});
    const primary=v.model.getObjectByName('SV3_LoginButton_0');
    let details=0;root?.traverse(o=>{if(o!==root)details++;});
    return {root:!!root,details,materials:[...materials],
      controlsVisible:!document.querySelector('#login').inert,
      primaryMaterial:primary?.material?.[0]?.name,
      hiddenLegacy:v.model.getObjectByName('SV3_Board_MapleCrest')?.visible!==true};
  });
  assert(states.login.root&&states.login.details>=50&&states.login.controlsVisible&&states.login.hiddenLegacy,JSON.stringify(states.login));
  assert(states.login.materials.includes('SV3_LoginRedesign_Teal')&&states.login.materials.includes('SV3_LoginRedesign_Ivory'));
  assert.equal(states.login.primaryMaterial,'SV3_LoginRedesign_Teal');
  await page.evaluate(() => window.__entry.voyage.draw(performance.now()));
  await page.screenshot({path:path.join(output,'login-fairytale.png')});
  states.solar = await page.evaluate(() => {
    const v=window.__entry.voyage,T=window.__three,glow=v.solarGlow,parent=glow.parent;
    const saved={position:glow.position.clone(),quaternion:glow.quaternion.clone(),visible:glow.visible,power:glow.material.uniforms.power.value};
    const scene=new T.Scene(),camera=new T.PerspectiveCamera(38,1,.1,2000),target=new T.WebGLRenderTarget(128,128,{type:T.HalfFloatType});
    camera.position.set(0,0,0);camera.lookAt(0,.01,-1);camera.updateMatrixWorld(true);
    scene.background=new T.Color(0);scene.add(glow);glow.update(camera.position,new T.Vector3(0,.01,-1).normalize(),new T.Color('#ffedcb'),3);
    // Same authored sun mesh/shader, brought inside this bounded inspection camera.
    glow.position.multiplyScalar(.04);glow.scale.multiplyScalar(.04);
    const read=()=>{v.renderer.setRenderTarget(target);v.renderer.render(scene,camera);const bytes=new Uint16Array(128*128*4);v.renderer.readRenderTargetPixels(target,0,0,128,128,bytes);return bytes;};
    const energy=bytes=>{let sum=0;for(let i=0;i<bytes.length;i++)if(i%4!==3)sum+=T.DataUtils.fromHalfFloat(bytes[i]);return sum;};
    try {
      const lit=read();glow.material.uniforms.power.value=0;const dark=read();glow.material.uniforms.power.value=1;
      const blocker=new T.Mesh(new T.PlaneGeometry(3,3),new T.MeshBasicMaterial({color:0}));blocker.position.set(0,0,-10);scene.add(blocker);
      const blocked=read(),center=(64*128+64)*4;
      const result={lit:energy(lit),dark:energy(dark),blocked:energy(blocked),center:T.DataUtils.fromHalfFloat(lit[center]),blockedCenter:T.DataUtils.fromHalfFloat(blocked[center])};
      blocker.geometry.dispose();blocker.material.dispose();return result;
    } finally {
      v.renderer.setRenderTarget(null);target.dispose();parent.add(glow);glow.position.copy(saved.position);glow.quaternion.copy(saved.quaternion);glow.scale.multiplyScalar(25);glow.visible=saved.visible;glow.material.uniforms.power.value=saved.power;
      v.draw(performance.now());
    }
  });
  assert(states.solar.lit>10&&states.solar.dark===0&&states.solar.center>1,'HDR sun and corona contribute real light with a zero-power control');
  assert(states.solar.blockedCenter===0&&states.solar.blocked<states.solar.lit,'foreground geometry occludes the sun and halo');
  assert.equal(await page.locator('#username,#password,#save-id,#submit,#mode,[data-action="help"],[data-action="language"]').count(),7,'all base login controls remain available');
  await page.locator('#username').fill('entry_check');
  await page.locator('#password').fill('entry-check-password');
  await page.locator('#submit').click();
  await page.locator('.entry-stage-channel').waitFor();
  await page.waitForFunction(() => window.__entry.voyage.activeCamera.isOrthographicCamera);
  await page.waitForFunction(() => {const p=window.__entry.voyage.passengers;return p.dolls.get(p.selected)?.bounds;});
  await page.waitForFunction(() => [...document.querySelectorAll('.voyage-art-button img')].every(i => i.complete && i.naturalWidth > 0));
  const capture = async name => {
    await page.evaluate(() => window.__entry.voyage.draw(performance.now()));
    await page.screenshot({ path: path.join(output, name + '.png') });
  };
  states.near = await page.evaluate(() => {
    const v = window.__entry.voyage, c = v.activeCamera, T = window.__three;
    const forward = c.getWorldDirection(new T.Vector3());
    const left = new T.Vector3(-1,0,-2).project(c), right = new T.Vector3(1,0,-2).project(c);
    const farLeft = new T.Vector3(-1,0,-12).project(c), farRight = new T.Vector3(1,0,-12).project(c);
    return { orthographic: c.isOrthographicCamera, forward: forward.toArray(), nearSpan: left.distanceTo(right), farSpan: farLeft.distanceTo(farRight),
      shadowSize: v.sun.shadow.mapSize.toArray(), shadowExtent: v.sun.shadow.camera.right,
      portalRotations: v.portalMeshes.map(m => m.quaternion.toArray()), revealStrength: v.reveal.strength.value };
  });
  assert(states.near.orthographic);
  assert(states.near.revealStrength>.9, 'a hat above the wall cannot leave the passenger torso hidden');
  assert(states.near.forward[1]<-.15&&states.near.forward[1]>-.4, 'side walking view rises slightly to show the player above the rail');
  assert(Math.abs(states.near.nearSpan - states.near.farSpan) < 1e-6, 'orthographic assets do not shrink with depth');
  assert.equal(states.near.shadowSize[0],4096);
  assert.equal(states.near.shadowExtent,40);
  await capture('deck-side-orthographic');
  await page.evaluate(() => { const v=window.__entry.voyage; v.yaw+=.7;v.updateActivity(); });
  states.turnedPortal = await page.evaluate(() => window.__entry.voyage.portalMeshes.map(m => m.quaternion.toArray()));
  assert.deepEqual(states.turnedPortal, states.near.portalRotations, 'portal orientation stays fixed when camera turns');
  await page.evaluate(() => { const v=window.__entry.voyage;v.yaw=0;v.deck.place(v.deck.route[2]);v.updateActivity(); });
  await capture('deck-seams-and-porthole');
  for (const viewport of [{width:1440,height:900},{width:390,height:844}]) {
    await page.setViewportSize(viewport); await capture('actions-'+viewport.width);
    const bounds = await page.locator('.voyage-adventure-shortcut').evaluate(el => {
      const r=el.getBoundingClientRect(),arrow=el.querySelector('.voyage-back-arrow').getBoundingClientRect(),img=el.querySelector('.voyage-return-login img').getBoundingClientRect();
      return { left:r.left,right:r.right,bottom:r.bottom,arrowRight:arrow.right,imageLeft:img.left,visible:!el.hidden };
    });
    assert(bounds.visible && bounds.left>=0 && bounds.right<=viewport.width && bounds.bottom<=viewport.height);
    assert(bounds.arrowRight<=bounds.imageLeft, 'left arrow is left of the return label');
  }
  await page.setViewportSize({width:1440,height:900});
  states.bow = [];
  await page.evaluate(() => {
    const v=window.__entry.voyage; v.deck=v.bowDeck; v.deck.place(v.deck.route[1]);
    v.yaw=0; v.followEye=undefined; v.followAim=undefined;
  });
  for (const zoom of [1.2,2.2]) {
    await page.evaluate(zoom => {const v=window.__entry.voyage;v.zoom=zoom;v.draw(performance.now());},zoom);
    const bow=await page.evaluate(() => {
      const v=window.__entry.voyage,T=window.__three,c=v.activeCamera;
      const direction=c.getWorldDirection(new T.Vector3()).applyQuaternion(v.ship.getWorldQuaternion(new T.Quaternion()).invert());
      const foot=v.ship.localToWorld(v.deck.position.clone()),head=foot.clone().add(new T.Vector3(0,v.passengers.deckBodyHeight,0));
      const f=foot.project(c),h=head.project(c),doll=v.passengers.root.getObjectByName('SV3_Passenger_preview-swap');
      return {orthographic:c.isOrthographicCamera,direction:direction.toArray(),foot:f.toArray(),bodyPixels:Math.abs(h.y-f.y)*450,visible:doll?.visible};
    });
    assert(bow.orthographic&&Math.abs(bow.direction[0])>.9&&Math.abs(bow.direction[2])<.01,'bow ramp is viewed from its side');
    assert(bow.visible&&Math.abs(bow.foot[0])<1&&Math.abs(bow.foot[1])<1&&bow.bodyPixels>20,'bow passenger remains legible in the wider framing');
    states.bow.push({zoom,...bow});
    await capture('bow-side-'+zoom);
  }
  await page.evaluate(() => {const v=window.__entry.voyage;v.deck=v.mainDeck;v.zoom=1.2;v.followEye=undefined;v.followAim=undefined;});
  await page.evaluate(() => window.__entry.go('characters'));
  await page.waitForFunction(() => window.__entry.voyage.cabinShown);
  await capture('cabin-fairytale');
  states.cabin = await page.evaluate(() => {
    const v=window.__entry.voyage;
    return {beds:Array.from({length:12},(_,i)=>Boolean(v.model.getObjectByName('SV2_Bed_'+i))),
      windows:Array.from({length:4},(_,i)=>Boolean(v.model.getObjectByName('SV2_CabinFrontWindow_'+String(i+1).padStart(2,'0')))),
      details:['IvoryArchRibs','BrassArchStarLeafwork','WindowSideBanners','TealBedTextiles','FloorCompassInlay','FloorFineEdges'].map(name=>{
        const o=v.model.getObjectByName('SV3_CabinRedesign_'+name);
        let vertices=0;o?.traverse(m=>{vertices+=m.geometry?.attributes.position.count??0;});
        return {name,present:!!o,visible:o?.visible,parent:o?.parent?.name,vertices};
      }), actionsVisible:!document.querySelector('.voyage-adventure-shortcut').hidden};
  });
  assert(states.cabin.beds.every(Boolean) && states.cabin.windows.every(Boolean) && states.cabin.actionsVisible);
  assert(states.cabin.details.every(o=>o.present&&o.visible&&o.vertices>0&&o.parent==='SV3_CabinInterior'),JSON.stringify(states.cabin.details));
  await page.waitForFunction(()=>Boolean(window.__entry.voyage.passengers.bookPages));
  await page.evaluate(()=>{
    const v=window.__entry.voyage;cancelAnimationFrame(v.frame);v.frame=0;
    window.__restoreActivity=v.updateActivity;v.updateActivity=()=>{};
    window.__bookDeparture=v.passengers.depart();
  });
  states.book=[];
  for(const seconds of [.4,.85,1.3,1.8]) {
    states.book.push(await page.evaluate(seconds=>{
      const v=window.__entry.voyage,p=v.passengers,T=window.__three;
      while(p.departure.seconds<seconds-.001)p.update(1/60,false,v.model,v.activeCamera,performance.now());
      // Review the actual animated runtime sheets from their readable face.
      const scene=new T.Scene();scene.background=new T.Color('#172632');
      scene.add(new T.HemisphereLight('#fff5dc','#658aa1',2));
      const light=new T.DirectionalLight('#fff1cf',3);light.position.set(-2,4,5);scene.add(light);
      const book=p.book,parent=book.parent,position=book.position.clone(),quaternion=book.quaternion.clone(),scale=book.scale.clone();
      scene.add(book);book.position.set(0,0,0);book.quaternion.identity();book.scale.setScalar(1);
      const camera=new T.OrthographicCamera(-1.3,1.3,.82,-.82,.1,10);camera.position.set(0,.05,3);camera.lookAt(0,0,0);camera.updateMatrixWorld(true);
      v.renderer.render(scene,camera);
      parent.add(book);book.position.copy(position);book.quaternion.copy(quaternion);book.scale.copy(scale);book.updateWorldMatrix(true,true);
      return {seconds:p.departure.seconds,pages:p.bookPages.pages.length,finite:p.bookPages.pages.every(s=>s.cloth.positions.every(Number.isFinite)),
        freeEdge:p.bookPages.pages[0].cloth.positions.slice(-3)};
    },seconds));
    await page.screenshot({path:path.join(output,'book-interior-'+seconds+'.png')});
  }
  assert(states.book.every(s=>s.pages===12&&s.finite));
  assert(states.book.every((s,i)=>Math.abs(s.seconds-[.4,.85,1.3,1.8][i])<.02),'motion review captures the requested animation times');
  assert(Math.abs(states.book[0].freeEdge[0]-states.book.at(-1).freeEdge[0])>.2,'the interior page opens across the reviewed frames');
  await page.evaluate(()=>{const v=window.__entry.voyage;v.passengers.cancelDeparture();v.updateActivity=window.__restoreActivity;v.passengers.update(0,true,v.model,v.activeCamera,performance.now());v.draw(performance.now());});
  await page.locator('.voyage-return-login').click();
  await page.locator('#login').waitFor({state:'visible'});
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(output,'screenshot-fixes-result.json'),JSON.stringify({passed:true,states,errors},null,2),'utf8');
  console.log('PASS side orthographic projection, fixed portals, focused shadows, bilingual actions at two sizes, retained cabin elements and return login');
}
