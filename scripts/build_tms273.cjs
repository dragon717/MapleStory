// Rebuild the TMS273 resource pipeline without touching accounts or processes.
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
function run(command,args) {
  console.log(`273: ${path.basename(command)} ${args.join(' ')}`);
  const result=spawnSync(command,args,{cwd:root,stdio:'inherit',encoding:'utf8'});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
}
run('python3',['scripts/import_tms273.py']);
const maps=JSON.parse(fs.readFileSync(path.join(root,'references/tms273-data/maps.json'),'utf8')).maps;
const mobIds=new Set(maps.flatMap(map=>map.life.filter(life=>life.type==='m').map(life=>String(life.id).padStart(7,'0'))));
const wzRoot=path.join(root,'参考/273/TMS273少爷一键端/手工服务端/tms273/WZ_JSON_TW');
for(const id of mobIds) {
  const json=JSON.parse(fs.readFileSync(path.join(wzRoot,'Mob',id+'.json'),'utf8'));
  const link=json.info?.link?._value;
  if(link)mobIds.add(String(link).padStart(7,'0'));
}
run(path.join(require('node:os').homedir(),'.cargo/bin/cargo'),['run','--quiet','--manifest-path','scripts/unpack_tms273_ms/Cargo.toml','--',...[...mobIds].flatMap(id=>['--image',`Mob/${id}.img`])]);
for(const mode of ['maps','entities','ui','windows','portals','effects'])run(process.execPath,['scripts/export_tms273.cjs',mode]);
run('python3',['scripts/generate_tms273_gameplay.py']);
run(process.execPath,['scripts/export_tms273.cjs','items']);
run(process.execPath,['scripts/export_tms273_avatar.cjs','--mage-actions']);
for(const script of ['export_tms273_avatar','export_tms273_inventory','export_tms273_combat','export_tms273_chat','export_tms273_skills','export_tms273_skill_ui','export_tms273_npc_marker','export_tms273_mage_effects','export_tms273_character_ui','export_tms273_creation_items','export_tms273_entry','export_tms273_avatar_parts','export_tms273_skill_sounds','assemble_tms273'])run(process.execPath,[`scripts/${script}.cjs`]);
