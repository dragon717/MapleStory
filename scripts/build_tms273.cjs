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
const wzRoot=path.join(root,'参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW');
for(const id of mobIds) {
  const json=JSON.parse(fs.readFileSync(path.join(wzRoot,'Mob',id+'.json'),'utf8'));
  const link=json.info?.link?._value;
  if(link)mobIds.add(String(link).padStart(7,'0'));
}
// P-only monster templates have no map life row either, so they never enter
// `mobIds` above.  They still need a real WZ image: `export_tms273.cjs` resolves
// every mob through the shared `resources/tms273-export/ms` dump, which is what
// this unpacker writes.  8645261 藍色蘑菇王 is 36315's verified kill target
// (placed by scripts/tms273_calamity.cjs); 8150000 地獄巴洛古 is the 航行中襲擊
// 事件的怪 (placed by server/src/ship_event.rs) and the eight source airship
// maps all ship an empty `life` node.  Without their images the entities export
// aborts with "找不到 273 WZ 节点: Mob/<id>.img".
// 3220000 is unpacked separately to its own scratch root below, because the
// practice Boss was only ever dumped through that route.
for(const id of ['8645261','8150000']) mobIds.add(id.padStart(7,'0'));
run(path.join(require('node:os').homedir(),'.cargo/bin/cargo'),['run','--quiet','--manifest-path','scripts/unpack_tms273_ms/Cargo.toml','--',...[...mobIds].flatMap(id=>['--image',`Mob/${id}.img`])]);
// The first Victoria Boss (3220000 菇菇王) is not placed in any map life record,
// so it never enters `mobIds`.  `export_tms273.cjs` reads it through a second
// reader rooted at `/tmp/tms273-inspect-boss`; rebuild that image here so a
// wiped scratch dir cannot silently abort the entities export.
run(path.join(root,'scripts/unpack_tms273_ms/target/debug/unpack_tms273_ms'),['--out','/tmp/tms273-inspect-boss','--image','Mob/3220000.img']);
for(const mode of ['maps','entities','ui','windows','portals','effects'])run(process.execPath,['scripts/export_tms273.cjs',mode]);
// 冒险笔记（图鉴）的窗口素材与收藏源数据。  It must run after
// `export_tms273.cjs windows` because it re-derives the reused menu entry and
// compares it against that export, and it must run *here* — before the item
// pipeline below — because the reward backfill reads the collection source it
// writes.  The catalogue half is still generated at the very end (inside
// `assemble_tms273`), where the item tree is final.
run(process.execPath,['scripts/export_tms273_collection.cjs']);
// The collection's 1550 slots have to be named, and `String/Mob.json` is the
// only same-version table that names a monster.  It reads no other export, so
// it can run straight after the collection dump; it must run before
// `assemble_tms273` because both the server and the client compile it in.
run(process.execPath,['scripts/export_tms273_mob_names.cjs']);
run('python3',['scripts/generate_tms273_gameplay.py']);
// NPC 源台词表。它读 `gameplay.json` 的已摆放模板集合（表只覆盖真正会出场的 NPC）
// 与 `items.json` 的物品名（还原台词里的 `#t<id>#`），所以必须跑在 gameplay 重建
// 之后；又因为它按模板集合取交集，装配了新图就必须重跑，否则新图上的 NPC 会退回
// 占位提示。详见 scripts/check_tms273_npc_dialogue.cjs。
run(process.execPath,['scripts/export_tms273_npc_dialogue.cjs']);
// 源 NPC 脚本（`参考/.../TMS273/script/npc/*.js`）→ 对话 DSL。放在台词表之后：
// 两者都按「已摆放模板集合」取交集，装配新图后必须重跑。它同时吃 `shared/maps.json`
// 的已装配目录（目的地取交集），所以在候选地图产出之后跑最稳。
// 详见 scripts/check_tms273_npc_scripts.cjs。
run(process.execPath,['scripts/export_tms273_npc_scripts.cjs']);
// The four slot-expansion coupons are sourced through an NPC script in TMS273,
// so `generate_tms273_gameplay.py` only authors their shop rows; the item
// definitions come from this backfill.  It must run *after* the gameplay
// rebuild (which rewrites `items.json` without them) and *before* the item
// image export (which derives one PNG per item definition) — otherwise the
// coupons stay in the shops with no icon and `check_tms273_runtime` fails.
run('python3',['scripts/backfill_tms273_slot_expand.py']);
// The 怪物收藏 region/page/row rewards (`Etc/mobCollection.img`) that the
// same-version client really ships a definition for.  Same two constraints as
// the coupon backfill above: after the gameplay rebuild, before the item image
// export — and after the collection export, which is what resolves each
// rewardID to its source definition and name.
run('python3',['scripts/backfill_tms273_notebook_rewards.py']);
run(process.execPath,['scripts/export_tms273.cjs','items']);
run(process.execPath,['scripts/export_tms273_cashshop.cjs']);
run(process.execPath,['scripts/export_tms273_avatar.cjs','--mage-actions']);
for(const script of ['export_tms273_avatar','export_tms273_inventory','export_tms273_combat','export_tms273_chat','export_tms273_balloon','export_tms273_skills','export_tms273_skill_ui','export_tms273_keybindings','export_tms273_npc_marker','export_tms273_mage_effects','export_tms273_character_ui','export_tms273_creation_items','export_tms273_entry','export_tms273_avatar_parts','export_tms273_skill_sounds','export_tms273_levelup','export_tms273_reactor','export_tms273_chapter','export_tms273_storage','export_tms273_party','export_tms273_friend','export_tms273_minimap','export_tms273_worldmap','export_tms273_mount_icons','export_tms273_mounts_chairs','export_tms273_mount_scenes','assemble_tms273','index_client_assets','check_tms273_ride_scenes','check_tms273_notebook'])run(process.execPath,[`scripts/${script}.cjs`]);
for(const script of ['export_tms273_avatar','export_tms273_inventory','export_tms273_combat','export_tms273_chat','export_tms273_balloon','export_tms273_skills','export_tms273_skill_ui','export_tms273_keybindings','export_tms273_npc_marker','export_tms273_mage_effects','export_tms273_character_ui','export_tms273_creation_items','export_tms273_entry','export_tms273_avatar_parts','export_tms273_skill_sounds','export_tms273_levelup','export_tms273_reactor','export_tms273_chapter','export_tms273_storage','export_tms273_party','export_tms273_friend','export_tms273_minimap','export_tms273_worldmap','export_tms273_mount_icons','export_tms273_mounts_chairs','export_tms273_mount_scenes'])run(process.execPath,[`scripts/${script}.cjs`]);
run(process.execPath,['scripts/patch_tms273_pose_actions.cjs','--apply']);
for(const script of ['assemble_tms273','index_client_assets','check_tms273_ride_scenes','check_tms273_notebook'])run(process.execPath,[`scripts/${script}.cjs`]);
