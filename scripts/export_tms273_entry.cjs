// Login/selection artwork from TMS273.7. DOM controls stay independently responsive.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createReader } = require('./tms273_wz.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'client/public-tms273/assets/entry');
const reader = createReader(path.join(root, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data'));
const sourceScenes = {
  login: 'UI/LoginBack.img/Title/0',
  channel: 'UI/LoginBack.img/WorldSelect/default/0/0',
  characters: 'UI/customLoginTheme.img/0/image/back/0/0',
  create: 'UI/LoginBack.img/CustomizeChar/000/0/0',
};
async function frame(source) {
  const result = await reader.frame(source, output);
  return { ...result, url:'/assets/entry/'+result.url };
}
async function main() {
  fs.mkdirSync(output,{recursive:true});
  const manifest = { sourceVersion:'TMS273.7', scenes:{}, reference:{ gallery:'tms273_research_pack/MapleStory273_Online_Gallery.html', cards:['B01','B02','B03','B05'], note:'B01/B03/B05 structures match local 273 art. B02 blue-dragon event background differs; use the verified local WorldSelect/default instead.' }, effects:{} };
  for(const [stage,source] of Object.entries(sourceScenes)) {
    const layer = await frame(source);
    assert(layer.width===1366 && layer.height===768);
    manifest.scenes[stage]={width:1366,height:768,layers:[{...layer,x:683+layer.x,y:384+layer.y}]};
  }
  for(const [name,source] of [['empty','UI/Login.img/CharSelect/character/0'],['selected','UI/Login.img/CharSelect/effect/0']]) {
    const node=await reader.get(source);
    const children=[...(node.wzProperties??[])].filter(child=>/^\d+$/.test(child.name));
    manifest.effects[name]=[];
    for(const child of children)manifest.effects[name].push(await frame(source+'/'+child.name));
  }
  const bgmNode=await reader.get('UI/LoginBack.img/info/bgm');
  if(typeof bgmNode?.wzValue==='string') {
    const soundSource='Sound/'+bgmNode.wzValue.replace('/', '.img/');
    const audio = await reader.get(soundSource);
    assert(typeof audio?.getBytes === 'function', soundSource);
    const bytes = Buffer.from(await audio.getBytes(false)); assert(bytes.length>0);
    fs.writeFileSync(path.join(output,'login.mp3'),bytes); manifest.bgm='/assets/entry/login.mp3'; manifest.bgmSource=soundSource;
  }
  fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n','utf8');
  console.log('Exported four verified 1366x768 entry scenes and original selection effects.');
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>reader.close());
