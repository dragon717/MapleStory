// Extend the existing item catalogue with the source's Explorer creation outfits.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createReader } = require('./tms273_wz.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'resources/tms273-export');
const reader = createReader(path.join(root, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data'));
const ids = [1050286,1050287,1050288,1051353,1051354,1051355,1072833,1072834,1302000,1312004,1322005];
async function main() {
  const items = JSON.parse(fs.readFileSync(path.join(output, 'items.json'), 'utf8'));
  const images = JSON.parse(fs.readFileSync(path.join(output, 'item-images.json'), 'utf8'));
  for (const id of ids) {
    const group = Math.floor(id/10000) === 105 ? 'Longcoat' : Math.floor(id/10000) === 107 ? 'Shoes' : 'Weapon';
    const source = `Character/${group}/${String(id).padStart(8,'0')}.img`;
    const node = await reader.get(`${source}/info`);
    assert(node, `Missing source item ${id}`);
    const info = Object.fromEntries([...(node.wzProperties ?? [])].flatMap(property => {
      const value = property.wzValue;
      return typeof value === 'string' || typeof value === 'number' ? [[property.name, value]] : [];
    }));
    const nameNode = await reader.get(`String/Eqp.img/Eqp/${group}/${id}/name`);
    assert(typeof nameNode?.wzValue === 'string', `Missing item name ${id}`);
    const frame = await reader.frame(`${source}/info/icon`, path.join(output, 'assets/tms273'));
    items[id] = { inventoryType:1, slotMax:1, info, spec:{}, source, sourceItemId:String(id).padStart(8,'0'), spriteSource:`${source}/info/icon`, spriteSourceStatus:'wz-verified', name:nameNode.wzValue, defaultsApplied:['slotMax'] };
    images[id] = { ...frame, url:'/assets/tms273/'+frame.url };
    assert(info.reqLevel === 0 && info.reqJob === 0, `Creation equipment unexpectedly gated ${id}`);
  }
  const creation = { source: 'TMS273.7 Etc/MakeCharInfo.img/000', skin:[0], genders:[], names:{} };
  const values = node => [...(node?.wzProperties ?? [])].filter(child => /^\d+$/.test(child.name)).sort((a,b)=>Number(a.name)-Number(b.name)).map(child=>Number(child.wzValue));
  for (const [gender, label] of [[0,'male'],[1,'female']]) {
    const base = `Etc/MakeCharInfo.img/000/${label}`;
    const parts = await Promise.all([0,1,2,3,4].map(index=>reader.get(`${base}/${index}`)));
    const [face,hair,coat,shoes,weapon] = parts.map(values);
    const hairColors = {};
    for (const id of hair) hairColors[id] = values(await reader.get(`${base}/1/color/${id}`));
    creation.genders.push({ gender,face,hair,hairColors,coat,pants:[0],shoes,weapon });
    for (const [group, list] of [['Face',face],['Hair',hair],['Longcoat',coat],['Shoes',shoes],['Weapon',weapon]]) for (const id of list) {
      try { const name = await reader.get(`String/Eqp.img/Eqp/${group}/${id}/name`); if (typeof name?.wzValue === 'string') creation.names[id] = name.wzValue; } catch { /* Source names are optional; the UI uses a numbered option label. */ }
    }
    assert(face.length && hair.length && coat.length === 3 && shoes.length === 2 && weapon.length === 3);
    assert(Object.values(hairColors).every(colors=>colors.length===8));
  }
  for(const target of ['shared/character-creation.json','client/public-tms273/assets/entry/creation.json']) {
    const file = path.join(root,target); fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,JSON.stringify(creation,null,2)+'\n','utf8');
  }
  for (const [name,value] of [['items',items],['item-images',images]]) fs.writeFileSync(path.join(output, name+'.json'), JSON.stringify(value)+'\n','utf8');
  // Mirror the items list into the two consumers that are not the export
  // pipeline itself.  The server binary compiles `shared/items.json` via
  // `include_str!`, and the browser bundle copies
  // `client/public-tms273/assets/items.json` to `/assets/items.json` at
  // build time.  Without these mirrors `inventory::equipment_slot()` cannot
  // resolve the explorer creation outfit IDs and every login fails with
  // `equipment slot mismatch for 1051353`, leaving the player sprite
  // invisible.  Follow the backfill scripts' "only fill missing keys" rule
  // so a downstream price/slotMax/spec backfill on the same file still wins
  // over us.
  for (const target of ['shared/items.json', 'client/public-tms273/assets/items.json']) {
    const file = path.join(root, target);
    let existing;
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`Failed to read ${file}: ${error.message}`);
    }
    for (const [id, entry] of Object.entries(items)) {
      if (!existing[id]) existing[id] = entry;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(existing) + '\n', 'utf8');
  }
  console.log(`Verified and exported ${ids.length} Explorer creation items from TMS273 WZ.`);
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>reader.close());
