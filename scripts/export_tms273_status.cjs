// P: HUD disease thumbnails use each TMS273 MobSkill's authored first affected frame.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createReader}=require('./tms273_wz.cjs'),root=path.resolve(__dirname,'..');
const output=path.join(root,'resources/tms273-export'),assets=path.join(output,'assets/tms273');
const reader=createReader(path.join(root,'参考/273/TMS273少爷一键端/客户端/TMS273.7/Data'),path.join(output,'ms'));
(async()=>{const icons={};for(const [name,id] of Object.entries({seal:120,stun:123,curse:124,poison:125,slow:126})){
 const source=`Skill/MobSkill/${id}.img/level/1/affected/0`,frame=await reader.frame(source,assets);
 assert(frame.width>0&&frame.height>0);assert(fs.statSync(path.join(assets,frame.url)).size>0);
 icons[name]={...frame,url:'/assets/tms273/'+frame.url};
}fs.writeFileSync(path.join(output,'status-icons.json'),JSON.stringify({sourceVersion:'TMS273.7',presentation:'P: first affected frame as disease thumbnail',icons},null,2)+'\n','utf8');console.log('273 disease thumbnails: 5 original MobSkill frames');})().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>reader.close());
