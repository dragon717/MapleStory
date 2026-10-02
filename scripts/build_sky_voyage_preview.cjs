// Single-file scene/entry preview. All requests are local fixtures; no real accounts or persistence.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const sceneRoot = path.join(root, 'resources/scenes', process.argv[2] ?? 'sky-voyage-v3');
const { build } = createRequire(path.join(root, 'client/package.json'))('esbuild');
const publicRoot = path.join(root, 'client/public-tms273');
const read = name => JSON.parse(fs.readFileSync(path.join(publicRoot, name), 'utf8'));
const creation = read('assets/entry/creation.json');
const sourceAppearance = read('assets/entry/appearance.json');
const sourceManifest = read('assets/manifest.json');
const sleep = JSON.parse(fs.readFileSync(path.join(root, 'resources/tms273-export/voyage-sleep.json'), 'utf8'));
const wanted = new Set(creation.genders.flatMap(g => [
  ...g.face.map(id => `face:${id}`), ...g.hair.map(id => `hair:${id}`),
  ...Object.values(g.hairColors).flat().map(id => `hair:${id}`),
  ...g.coat, ...g.pants, ...g.shoes, ...g.weapon,
]).map(String));
const actions = object => Object.fromEntries(Object.entries(object ?? {}).filter(([key]) => /^(stand|walk|sit|jump)/.test(key)));
const appearance = {
  sourceVersion: sourceAppearance.sourceVersion, smap: sourceAppearance.smap,
  base: Object.fromEntries(Object.entries(sourceAppearance.base).map(([key, value]) => [key, { actions: actions(value.actions) }])),
  layers: Object.fromEntries(Object.entries(sourceAppearance.layers).filter(([key]) => wanted.has(key)).map(([key, layer]) => [key, {
    ...layer, actions: actions(layer.actions),
    actionsByGender: layer.actionsByGender && Object.fromEntries(Object.entries(layer.actionsByGender).map(([gender, value]) => [gender, actions(value)])),
  }])),
};
const manifest = { npcs: Object.fromEntries([1022000, 1032001, 1012100, 10203].map(id => [id, sourceManifest.npcs[id]])) };
const orbis = sourceManifest.mapCatalog.maps.find(map => map.id === '200000000');
manifest.mapCatalog = { maps: [{ id: orbis.id, bgm: 'data:audio/mpeg;base64,' + fs.readFileSync(path.join(publicRoot, orbis.bgm)).toString('base64') }] };
const dataImages = new Map();
function embedImages(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'url' && typeof child === 'string' && child.startsWith('/assets/')) {
      if (!dataImages.has(child)) dataImages.set(child, 'data:image/png;base64,' + fs.readFileSync(path.join(publicRoot, child)).toString('base64'));
      value[key] = dataImages.get(child);
    } else embedImages(child);
  }
}
embedImages(appearance); embedImages(manifest); embedImages(sleep);
const model = fs.readFileSync(path.join(sceneRoot, 'models/sky-voyage.glb')).toString('base64');
const city = fs.readFileSync(path.join(root,'resources/scenes/sky-voyage-v3/prototypes/sky-city-spatial-prototype.glb')).toString('base64');
const payload = JSON.stringify({ creation, appearance, manifest, sleep, model, city });
const entry = `
import { EntryView } from './src/features/entry/view';
import { installGameAudio } from './src/features/world/game-audio';
import { PROTOCOL_VERSION, CONTENT_VERSION } from '../shared/protocol';
const data = ${payload};
const initialLook = g => ({gender:g.gender,skin:data.creation.skin[0],face:g.face[0],hair:g.hair[0],coat:g.coat[0],pants:g.pants[0],shoes:g.shoes[0],weapon:g.weapon[0]});
let passengers = [], nextId = 1;
const session = {token:'offline-preview',playerId:'preview-account',username:'预览账号',protocolVersion:PROTOCOL_VERSION,contentVersion:CONTENT_VERSION};
const json = value => new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const resource = typeof input === 'string' ? input : input.url;
  if (/^(blob:|data:)/.test(resource)) return nativeFetch(input, init);
  const url = new URL(typeof input === 'string' ? input : input.url, 'https://offline.preview');
  if(url.pathname === '/assets/entry/sky-voyage.glb') return new Response(Uint8Array.from(atob(data.model), c=>c.charCodeAt(0)));
  if(url.pathname === '/assets/entry/sky-city.glb') return new Response(Uint8Array.from(atob(data.city), c=>c.charCodeAt(0)));
  if(url.pathname === '/assets/entry/manifest.json') return json({scenes:{}});
  if(url.pathname === '/assets/entry/voyage-sleep.json') return json(data.sleep);
  if(url.pathname === '/assets/manifest.json') return json(data.manifest);
  if(url.pathname === '/assets/entry/creation.json') return json(data.creation);
  if(url.pathname === '/assets/entry/appearance.json') return json(data.appearance);
  if(url.pathname === '/api/register') return json({ok:true});
  if(url.pathname === '/api/login') {
    passengers = document.getElementById('returning').checked ? Array.from({length:5},(_,i)=>({id:'passenger-'+i,name:['云海旅人','星月旅人','枫叶旅人','晨光旅人','晚霞旅人'][i],level:i+1,job:0,appearance:initialLook(data.creation.genders[i%2])})) : [];
    return json(session);
  }
  if(url.pathname === '/api/lobby') {
    const request = JSON.parse(init.body);
    if(request.action==='list') return json({characters:passengers,slotLimit:12,channelId:1});
    if(request.action==='logout') return json({ok:true});
    if(request.action==='checkName') return json({available: !passengers.some(p=>p.name===request.name)});
    if(request.action==='create') {
      if(passengers.some(p=>p.name===request.name)) return new Response(JSON.stringify({error:'name already exists'}),{status:409});
      const character={id:'created-'+nextId++,name:request.name,level:1,job:0,appearance:request.appearance}; passengers.push(character);return json({character});
    }
    if(request.action==='select') return json({...session,playerId:request.characterId});
  }
  return new Response('{}',{status:404});
};
const audio = installGameAudio(document.getElementById('welcome'),()=>undefined);
const entry = new EntryView(document.getElementById('welcome'),async()=>{alert('流程预览完成；此HTML不会连接正式游戏或写入存档。');throw new Error('这是离线预览，请用正式游戏入口实玩。');},audio.entry);
window.__entryAudio = audio;
window.__voyagePreview = entry;
const fill = () => {const id=document.getElementById('username'),password=document.getElementById('password');if(id){id.value='voyage_preview';id.readOnly=true;}if(password){password.value='offline-preview';password.readOnly=true;}};
new MutationObserver(fill).observe(document.getElementById('welcome'),{childList:true,subtree:true});fill();
document.querySelectorAll('[data-shot]').forEach(b=>b.onclick=()=>{entry.voyage?.showShot(b.dataset.shot);});
document.getElementById('reset').onclick=()=>entry.showLogin();
document.getElementById('disturb-water').onclick=()=>entry.voyage?.disturbWater();
document.querySelectorAll('[data-ship-control]').forEach(input=>input.oninput=()=>{
  entry.voyage?.setShipControls({[input.dataset.shipControl]: Number(input.value)});
  input.nextElementSibling.textContent = input.value;
});
document.getElementById('trial').onchange=event=>entry.voyage?.setShipTrial(event.target.checked);
document.getElementById('clean-view').onchange=event=>document.querySelector('.entry-scene').style.visibility=event.target.checked?'hidden':'';
setInterval(()=>{const state=entry.voyage?.shipStatus();if(state)document.getElementById('ship-status').textContent='展开 '+Math.round(state.sail*100)+'% · 推力 '+state.thrust.toFixed(1)+' · 速度 '+state.speed.toFixed(1)+' m/s';},250);
window.addEventListener('pagehide',()=>{entry.voyage?.destroy();audio.dispose();},{once:true});
`;
async function main() {
  const bundle = await build({stdin:{contents:entry,resolveDir:path.join(root,'client'),loader:'ts'},bundle:true,external:['/assets/*'],format:'iife',write:false,outfile:'preview.js',minify:true,define:{__RELEASE_VERSION__:'"preview"',__RELEASE_TIME__:'"offline"',__CODE_MODE__:'"DEV_SOURCE"'},logLevel:'silent'});
  let js = bundle.outputFiles.find(file=>file.path.endsWith('.js')).text.replace(/<\/script/gi,'<\\/script');
  for (const name of ['warrior','mage','archer','rogue']) {
    const data = 'data:image/png;base64,'+fs.readFileSync(path.join(sceneRoot,'textures','stained-glass-'+name+'.png')).toString('base64');
    dataImages.set('/assets/entry/stained-glass-'+name+'.png', data);
  }
  let css = bundle.outputFiles.find(file=>file.path.endsWith('.css')).text;
  for (const [name, source] of [['panel','entry-panel'],['button','entry-button'],['crest','maple-crest']]) {
    const image = fs.readFileSync(path.join(sceneRoot, 'textures', source+'.png'));
    css = css.replaceAll('/assets/entry/voyage-'+name+'.png', 'data:image/png;base64,'+image.toString('base64'));
  }
  const html = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>冒险岛 · 天空航船3D流程预览</title><style>html,body{margin:0} ${css} .preview-tools{position:fixed;right:12px;top:10px;z-index:20;max-width:60vw;color:#fff;background:#183448d9;border:1px solid #ddcf9a;padding:9px;border-radius:8px;font:12px/1.5 sans-serif}.preview-tools button{margin:2px;padding:5px 9px;cursor:pointer}.preview-tools label{display:block}@media(max-width:700px){.preview-tools{top:auto;bottom:65px;max-width:calc(100vw - 30px);font-size:10px}}</style><section id="welcome"></section><details class="preview-tools"><summary>离线3D与流程预览 · 不连接账号服务器，不写存档</summary><button data-shot="overview">船与群岛整体</button><button data-shot="far">远景</button><button data-shot="mid">中景</button><button data-shot="deck">甲板</button><button data-shot="city">群岛全景</button><button data-shot="ship">船体全景</button><button data-shot="water">程序水近景</button><button id="disturb-water">水面扰动</button><button id="reset">返回登录</button><label><input id="clean-view" type="checkbox">隐藏登录面板，看船体</label><label>帆展开 <input data-ship-control="sail" aria-label="帆展开" type="range" min="0" max="1" step=".01" value="1"><output>1</output></label><label>风速 <input data-ship-control="wind" aria-label="风速" type="range" min="0" max="16" step=".5" value="8"><output>8</output></label><label>推进 <input data-ship-control="throttle" aria-label="推进" type="range" min="0" max="1" step=".01" value=".5"><output>.5</output></label><label>转向 <input data-ship-control="steering" aria-label="转向" type="range" min="-1" max="1" step=".01" value="0"><output>0</output></label><label><input id="trial" type="checkbox">本机试航（P 模拟）</label><p id="ship-status" aria-live="off"></p><label><input type="checkbox" id="returning">演示已有五名乘客（重新点击开始游戏）</label></details><script>window.__previewGlass=${JSON.stringify(Object.fromEntries([...dataImages].filter(([url])=>url.includes('stained-glass'))))};new MutationObserver(()=>document.querySelectorAll('.voyage-window-portrait img').forEach(img=>{const src=img.getAttribute('src');if(window.__previewGlass[src])img.src=window.__previewGlass[src];})).observe(document.getElementById('welcome'),{childList:true,subtree:true});${js}</script></html>`;
  const output = path.join(sceneRoot,'preview/index.html');
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,html,'utf8');
  console.log(`Built offline preview: ${output} (${fs.statSync(output).size} bytes; ${dataImages.size} embedded source images)`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
