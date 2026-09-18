#!/usr/bin/env node

// 冒险笔记（图鉴）门禁。
//
// 断言四件不同的事，缺一件这个功能就会以「看起来能用」的方式坏掉：
//
//   1. 素材      窗口壳与按钮各态的 PNG 真的落在被复制的位置，且清单键与导出键一致。
//   2. 入口身份  复用项仍是源菜单里的那一项（key/type/坐标），可见名称的改动只发生在本地化层。
//   3. 目录      规范化物品键与最终 `shared/items.json` 的规范化键集合相等；
//                分区完整且互不重不漏；任务分区不得出现在客户端投影里。
//   4. 奖励物品  源授权的每个地区／分页／行 rewardID 都必须在奖励表里，
//                且「本版能不能发出去」要与同版客户端真正携带的定义一致：
//                源有定义 ⇒ 必须在物品目录里（否则是奖励回填漏跑）；
//                源无定义 ⇒ 必须留下可核查的缺失说明，绝不允许凭空造物。
//   5. 规则      未核定的部分必须保持 `unverified` 且数值为 null；
//                任何「正式内容里偷偷填了概率/槽位」都必须让这道门失败。
//
// 另有一条镜像检查：初始发放清单写在 Rust 里（`inventory::starter_items` /
// `starter_equipment`），生成器无法读取，因此这里重新解析那份源码，防止镜像腐烂。
//
// 用法：node scripts/check_tms273_notebook.cjs
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { MENU_KEY, MENU_TYPE, INITIAL_GRANT_IDS, WZ_JSON, canonical } = (() => {
  const exported = require('./export_tms273_collection.cjs');
  const generated = require('./generate_tms273_notebook_catalog.cjs');
  return { ...exported, ...generated };
})();

const ROOT = path.resolve(__dirname, '..');
const INPUT = path.join(ROOT, 'resources/tms273-export');
const read = file => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const serverSource = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
// 改名只发生在客户端本地化层，所以这道门禁必须同时读客户端源码。
const clientSource = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const sameColour = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
/** 极简 PNG 读取。本项目导出的按钮素材一律是 8 位 RGBA、非交错、单个 IDAT，
 *  这里只为了把「底板颜色」「图标与字形的分界」从素材本身量出来，而不是把
 *  量出来的数字抄成常量（抄下来的常量会随素材重导静默失效）。 */
function readPngPixels(file) {
  const raw = fs.readFileSync(file);
  assert.equal(raw.subarray(0, 8).toString('latin1'), '\x89PNG\r\n\x1a\n', `不是 PNG: ${file}`);
  const idat = [];
  let header = null;
  for (let off = 8; off + 8 <= raw.length;) {
    const length = raw.readUInt32BE(off);
    const type = raw.subarray(off + 4, off + 8).toString('latin1');
    const body = raw.subarray(off + 8, off + 8 + length);
    if (type === 'IHDR') header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colorType: body[9], interlace: body[12] };
    else if (type === 'IDAT') idat.push(body);
    off += 12 + length;
  }
  assert(header, `${file} 缺少 IHDR`);
  assert.equal(header.depth, 8, `${file} 不是 8 位深`);
  assert.equal(header.colorType, 6, `${file} 不是 RGBA`);
  assert.equal(header.interlace, 0, `${file} 是交错 PNG，读取器不支持`);
  const data = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = header.width * bpp;
  const previous = Buffer.alloc(stride), current = Buffer.alloc(stride);
  const out = Buffer.alloc(stride * header.height);
  let at = 0;
  for (let y = 0; y < header.height; y++) {
    const filter = data[at++];
    assert(filter >= 0 && filter <= 4, `${file} 出现未知的行过滤器 ${filter}`);
    const line = data.subarray(at, at + stride);
    at += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? current[i - bpp] : 0;
      const b = previous[i];
      const c = i >= bpp ? previous[i - bpp] : 0;
      const x = line[i];
      current[i] = (filter === 0 ? x
        : filter === 1 ? x + a
          : filter === 2 ? x + b
            : filter === 3 ? x + ((a + b) >> 1)
              : x + paeth(a, b, c)) & 0xff;
    }
    current.copy(out, y * stride);
    current.copy(previous);
  }
  return { width: header.width, height: header.height, pixels: out };
}

// ------------------------------------------------------------------ 素材 --
const notebook = read('resources/tms273-export/notebook.json');
const manifest = read('client/public-tms273/assets/manifest.json');
assert.equal(notebook.menu.key, MENU_KEY, '导出的入口 key 与常量不一致');
assert.equal(notebook.menu.type, MENU_TYPE, '导出的入口 type 与常量不一致');
assert(manifest.notebook, 'manifest 缺少 notebook 键');
assert.deepEqual(manifest.notebook.menu, notebook.menu, 'manifest 里的入口身份与导出不一致');
for (const [panel, frames] of Object.entries(manifest.notebook.frames)) {
  assert(Object.keys(frames).length > 0, `${panel} 窗口没有导出任何素材`);
  for (const [key, frame] of Object.entries(frames)) {
    assert(frame.url.startsWith('/assets/tms273/notebook/'), `图鉴素材不在可复制目录内: ${frame.url}`);
    const copied = path.join(ROOT, 'client/public-tms273', frame.url.slice(1));
    assert(fs.existsSync(copied), `图鉴素材没有被装配复制: ${frame.url}`);
    assert(fs.statSync(copied).size > 0, `图鉴素材是空文件: ${frame.url} (${key})`);
  }
}
// 窗口壳与关闭按钮是必需品：缺了它们窗口就是一个空白浮层。
for (const required of ['backgrnd', 'button:Close/normal', 'Collection/backgrnd']) {
  assert(manifest.notebook.frames.monster[required], `收藏窗口缺少必需素材 ${required}`);
}
assert(manifest.notebook.frames.item.backgrnd, '物品图鉴缺少窗口背景');
// 每个画布的像素帧也必须在源导出目录里存在（装配只复制清单引用的 URL）。
for (const frames of Object.values(notebook.frames)) {
  for (const frame of Object.values(frames)) {
    const source = path.join(INPUT, frame.url.slice(1));
    assert(fs.existsSync(source), `源导出缺少素材文件 ${frame.url}`);
  }
}

// ------------------------------------------------------------- 入口身份 --
{
  const entry = (manifest.totalMenuEntries ?? []).find(row => row.key === MENU_KEY);
  assert(entry, `菜单里没有 ${MENU_KEY}`);
  assert.equal(entry.type, MENU_TYPE, `${MENU_KEY} 的 type 变了，说明复用了别的入口`);
  // 源标签保持原样：改名只发生在本地化层，运行时不依赖中文模糊匹配。
  assert.equal(entry.label, notebook.menu.label, `${MENU_KEY} 的源标签被改动过`);
  assert.equal(entry.x, notebook.menu.x, `${MENU_KEY} 的横坐标漂移`);
  assert.equal(entry.y, notebook.menu.y, `${MENU_KEY} 的纵坐标漂移`);
  const duplicates = (manifest.totalMenuEntries ?? []).filter(row => row.type === MENU_TYPE);
  assert.equal(duplicates.length, 1, `type ${MENU_TYPE} 出现了 ${duplicates.length} 次，图鉴入口不唯一`);
  // 图标三态都要有，否则改名后会出现「悬停变回旧字」的破绽。
  for (const state of ['normal', 'pressed', 'mouseOver']) {
    assert(manifest.notebook.frames.monster[`button:Close/${state}`], `关闭按钮缺少 ${state} 态`);
  }
}

// ------------------------------------------------------------------ 目录 --
const catalog = read('shared/notebook-catalog.json');
const rules = read('shared/monster-collection-rules.json');
const finalItems = read('shared/items.json');
const gameplay = read('shared/gameplay.json');
const client = read('client/public-tms273/assets/notebook.json');

assert.equal(catalog.catalogVersion, rules.catalogVersion, '目录与规则的版本号不一致');
assert.equal(catalog.contentVersion, gameplay.contentVersion, '目录与运行时内容版本不一致');

// 规范化键必须与最终物品目录完全一致：少一个 = 图鉴漏收，多一个 = 凭空造物。
//
// 唯一的例外是椅子：源 `Item/Install/0301*`、`0302` 整族归椅子表，物品树里
// 带着的那一两件（真的进商店的）也必须跟着归椅子表，否则同一件东西会同时属于
// 「设置」与「椅子」两个分区。所以物品目录的覆盖是 `items` ∪（椅子 ∩ items.json）。
const chairsShipped = JSON.parse(fs.readFileSync('shared/chairs.json', 'utf8')).items;
const chairCanonical = new Set(Object.keys(chairsShipped).map(canonical).filter(Boolean));
const finalCanonical = new Set(Object.keys(finalItems).map(canonical).filter(Boolean));
const catalogCanonical = new Set(Object.keys(catalog.items));
const chairsFromItemTree = [...chairCanonical].filter(id => finalCanonical.has(id));
assert.deepEqual(
  [...catalogCanonical, ...chairsFromItemTree].sort(),
  [...finalCanonical].sort(),
  '图鉴定义（物品 + 归椅子页的那几件）与最终物品目录不一致');
for (const id of catalogCanonical) {
  const definition = catalog.items[id];
  assert.equal(definition.itemId, id, `物品定义的键与 itemId 不一致: ${id}`);
  assert(id === canonical(id), `物品定义没有使用规范化键: ${id}`);
  assert(['obtainable', 'unavailable', 'unverified'].includes(definition.availability), `未知的可获得性取值: ${id}`);
  assert(definition.nameRef === `items.json:${id}.name`, `名称引用不是既有目录: ${id}`);
  assert(definition.equipmentSlot === null || typeof definition.equipmentSlot === 'string', `装备部位类型错误: ${id}`);
}
for (const row of catalog.excluded) assert(row.reason, `被排除项没有原因: ${row.itemId}`);

// 分区必须恰好划分定义集合，且不重不漏。
// 「定义集合」= 物品 ∪ 骑宠 ∪ 椅子：这两族都不在 `items.json` 里（那份同时是
// 「当前可获得」分母），所以在目录里各有自己的一张表。
const mountsShipped = JSON.parse(fs.readFileSync('shared/mounts.json', 'utf8')).items;
const mountCanonical = new Set(Object.keys(mountsShipped).map(canonical).filter(Boolean));
assert.equal(mountCanonical.size, Object.keys(mountsShipped).length, '骑宠表里有非规范化 id');
assert.deepEqual([...Object.keys(catalog.mounts)].sort(), [...mountCanonical].sort(), '图鉴骑宠定义与坐骑表不一致');
for (const [id, definition] of Object.entries(catalog.mounts)) {
  assert.equal(definition.itemId, id, `骑宠定义的键与 itemId 不一致: ${id}`);
  assert(['obtainable', 'unavailable', 'unverified'].includes(definition.availability), `未知的可获得性取值（骑宠）: ${id}`);
  assert(!catalog.items[id], `骑宠 ${id} 混进了物品定义表：那张表是可获得分母`);
}
// 椅子（`Item/Install/0301*`、`0302`，`shared/chairs.json`）：与骑宠同族。
// 物品树里带着的那一两件进商店的椅子也必须归椅子页，否则同一件东西属于两个分区。
assert.equal(chairCanonical.size, Object.keys(chairsShipped).length, '椅子表里有非规范化 id');
assert.deepEqual([...Object.keys(catalog.chairs)].sort(), [...chairCanonical].sort(), '图鉴椅子定义与椅子表不一致');
for (const [id, definition] of Object.entries(catalog.chairs)) {
  assert.equal(definition.itemId, id, `椅子定义的键与 itemId 不一致: ${id}`);
  assert(['obtainable', 'unavailable', 'unverified'].includes(definition.availability), `未知的可获得性取值（椅子）: ${id}`);
  assert(!catalog.items[id], `椅子 ${id} 混进了物品定义表：那张表是可获得分母`);
  assert.equal(definition.inventoryType, 3, `椅子的栏位不是设置栏: ${id}`);
  // 间隔是源描述里写明「每 N 秒」才有的：缺席必须是 null，不许替源编一个。
  assert(definition.recoveryIntervalMs === null || Number.isInteger(definition.recoveryIntervalMs),
    `椅子的恢复间隔不是整数或 null: ${id}`);
}
const sectionMembers = new Set();
for (const [name, ids] of Object.entries(catalog.sections)) {
  for (const id of ids) {
    assert(catalog.items[id] || catalog.mounts[id] || catalog.chairs[id], `分区 ${name} 引用了不存在的条目 ${id}`);
    assert(!sectionMembers.has(id), `条目 ${id} 同时出现在多个分区`);
    sectionMembers.add(id);
  }
  assert.deepEqual(ids, [...ids].sort((a, b) => Number(a) - Number(b)), `分区 ${name} 未排序`);
}
assert.deepEqual(
  [...sectionMembers].sort(),
  [...catalogCanonical, ...mountCanonical, ...chairCanonical].sort(),
  '分区没有覆盖全部定义（物品 + 骑宠 + 椅子）');
// 骑宠分区就是整张坐骑表：本版本没有开放获取途径，所以这一页的基集合是全集，
// 少一件等于这一页少一件。
assert.deepEqual([...catalog.sections.mount].sort(), [...mountCanonical].sort(), '骑宠分区与坐骑表不一致');
// 椅子分区同理就是整张椅子表。
assert.deepEqual([...catalog.sections.chair].sort(), [...chairCanonical].sort(), '椅子分区与椅子表不一致');
// 一件东西只能属于一个页签：设置页现在必须为空（唯一的那一把椅子归椅子页了）。
assert.deepEqual(catalog.sections.setup, [], '设置分区不得再留着椅子');
// 任务专用装备可以同时在装备页；任务专用消耗品不得落进普通页。
for (const id of catalog.sections.quest) {
  const definition = catalog.items[id];
  assert(definition.questSpecific, `任务分区混入了未标记任务专用的物品 ${id}`);
  assert(definition.questClassificationEvidence.length > 0, `任务分类没有证据: ${id}`);
  if (definition.inventoryType !== 1) {
    for (const [name, ids] of Object.entries(catalog.sections)) {
      if (name === 'quest') continue;
      assert(!ids.includes(id), `任务专用消耗品出现在了 ${name} 分区: ${id}`);
    }
  }
}
// 装备页只能有装备，普通页不能混设备。
for (const id of catalog.sections.equipment) assert.equal(catalog.items[id].inventoryType, 1, `装备分区混入非装备 ${id}`);
for (const name of ['use', 'setup', 'etc']) {
  assert(catalog.sections[name].length === 0 || catalog.sections[name].every(id => catalog.items[id].inventoryType !== 1), `${name} 分区混入装备`);
}

// 怪物目录。
assert(catalog.monsterEntryCount > 1000, '怪物收藏目录明显偏小');
assert.equal(Object.keys(catalog.monsterEntries).length, catalog.monsterEntryCount, '怪物条目计数与字典不一致');
for (const entry of Object.values(catalog.monsterEntries)) {
  assert(/^mc-\d+-\d+-\d+-\d+$/.test(entry.entryId), `收藏条目键格式错误: ${entry.entryId}`);
  assert(catalog.monsterStructure.rows[entry.rowKey], `条目 ${entry.entryId} 指向不存在的行 ${entry.rowKey}`);
  assert(entry.monsterTemplateId === canonical(entry.monsterTemplateId), `条目模板 id 未规范化: ${entry.entryId}`);
  assert(Number.isInteger(entry.sourceType), `条目缺少源 type: ${entry.entryId}`);
}
for (const [rowKey, row] of Object.entries(catalog.monsterStructure.rows)) {
  assert(row.entryIds.length > 0, `行 ${rowKey} 没有任何格子`);
  for (const entryId of row.entryIds) assert(catalog.monsterEntries[entryId], `行 ${rowKey} 引用了不存在的格子 ${entryId}`);
}
// 可获得性子集只能来自已装配的怪物；源里其余条目保留原身份，只是当前不可收集。
const deployed = new Set(gameplay.monsters.map(monster => canonical(String(monster.templateId))));
for (const entry of Object.values(catalog.monsterEntries)) {
  if (entry.collectable) assert(deployed.has(entry.monsterTemplateId), `声称可收集但模板未装配: ${entry.entryId}`);
}
// 可获得性只认「本版本真的跑得起来的链路」：收藏奖励的达成条件未核定，
// 所以由它授权的物品不能因为「源里有这条奖励」而变成已可获得（§5.5）。
for (const [table, label] of [[catalog.items, '物品'], [catalog.mounts, '骑宠'], [catalog.chairs, '椅子']]) {
  for (const [id, definition] of Object.entries(table)) {
    const open = definition.obtainEvidence.filter(evidence => !evidence.startsWith('collectionReward:'));
    assert.equal(
      definition.availability,
      open.length ? 'obtainable' : 'unverified',
      `${label} ${id} 的可获得性把未核定的收藏奖励算成了已开放链路`);
  }
}

// 原版奖励物品：源在每个地區／分頁／行都授权了自己的 rewardID，本项目必须
// 逐个交代清楚，并且「本版本能不能发出去」要与同版客户端真正携带的定义一致。
const rewardKeys = new Set();
const noteReward = id => { if (id !== null && id !== undefined) rewardKeys.add(canonical(String(id))); };
for (const region of notebook.collection.regions) {
  noteReward(region.rewardItemId);
  for (const page of region.pages) {
    noteReward(page.rewardItemId);
    for (const row of page.rows) noteReward(row.rewardItemId);
  }
}
const sorted = ids => [...ids].sort((a, b) => Number(a) - Number(b));
assert.deepEqual(
  sorted(Object.keys(catalog.rewardItems)),
  sorted(rewardKeys),
  '图鉴目录没有逐个覆盖源授权的奖励物品');
assert.equal(
  catalog.rewardItemCount,
  Object.keys(catalog.rewardItems).length,
  '奖励物品计数与字典不一致');
assert.equal(
  catalog.definitionMissingRewardCount,
  Object.values(catalog.rewardItems).filter(reward => !reward.definitionAvailable).length,
  '缺失定义的奖励计数与字典不一致');

for (const [id, reward] of Object.entries(catalog.rewardItems)) {
  assert.equal(reward.itemId, id, `奖励物品的键与 itemId 不一致: ${id}`);
  assert(reward.roles.length > 0, `奖励物品没有来源层级: ${id}`);
  assert(Object.values(reward.referenceCounts).some(count => count > 0), `奖励物品没有引用计数: ${id}`);
  assert(reward.evidence.length >= 3, `奖励物品缺少证据: ${id}`);
  assert(reward.evidence.some(line => line.startsWith('T:')), `奖励物品缺少 T 级证据: ${id}`);
  assert(reward.evidence.some(line => line.startsWith('U:')), `奖励物品缺少 U 级待核项: ${id}`);
  // 「源里有没有定义」必须由源文件本身回答，而不是由本项目的导出结果自证。
  const source = reward.definitionSource ? path.join(WZ_JSON, reward.definitionSource) : null;
  const shipped = Boolean(source && fs.existsSync(source));
  assert.equal(
    reward.definitionStatus,
    shipped ? 'json-present' : 'json-missing',
    `奖励物品 ${id} 的源定义存在性与实际不符`);
  assert.equal(reward.inItemIndex, Boolean(catalog.items[id]), `奖励物品 ${id} 的目录成员标记与实际不符`);
  if (shipped) {
    // 源里有定义 ⇒ 必须已经在物品目录里；缺了说明奖励回填没跑，是构建顺序
    // 缺陷，不是源边界。
    assert(reward.inItemIndex, `奖励物品 ${id} 在源里有定义却没有进目录`);
    assert(reward.definitionAvailable, `奖励物品 ${id} 的定义存在却标为不可发放`);
    assert.equal(reward.reason, null, `奖励物品 ${id} 有定义却带了阻塞原因`);
    // 名称/描述/图标一律引用既有目录，不复制成第二份权威数据。
    assert.equal(reward.nameRef, `items.json:${id}.name`, `奖励物品 ${id} 的名称引用错误`);
    assert.equal(reward.name, null, `奖励物品 ${id} 复制了本可引用的名称`);
    assert.equal(reward.nameSource, notebook.collection.rewardItems[id].nameSource, `奖励物品 ${id} 的名称来源与导出不一致`);
  } else {
    // 源里没有定义 ⇒ 绝不能凭空出现在物品目录里，且必须留下可核查的缺失说明。
    assert(!reward.inItemIndex, `奖励物品 ${id} 没有源定义却出现在物品目录里`);
    assert(!reward.definitionAvailable, `奖励物品 ${id} 没有源定义却标为可发放`);
    assert(!catalog.items[id], `奖励物品 ${id} 没有源定义却出现在物品目录里`);
    assert(typeof reward.reason === 'string' && reward.reason.length > 0, `奖励物品 ${id} 缺少缺失原因`);
    assert(reward.reason.includes('没有物品定义'), `奖励物品 ${id} 的缺失原因没有说清楚`);
    assert(typeof reward.name === 'string' && reward.name.length > 0, `奖励物品 ${id} 缺少同版名称`);
    assert(/^String\/[A-Za-z]+\.json#/.test(String(reward.nameSource)), `奖励物品 ${id} 的名称来源不是可核查的同版 String 表`);
  }
}
// 逐怪 `reward` 节点是卡片掉落清单，不是收藏奖励；它绝不能变成可发放奖励表
// 的来源（那会把 310 行奖励替换成上千件掉落物）。
assert(notebook.collection.rewardItems, '导出缺少奖励物品表');
for (const [id, reward] of Object.entries(catalog.rewardItems)) {
  assert.deepEqual(reward.roles, [...reward.roles].sort(), `奖励物品 ${id} 的来源层级未排序`);
  assert.equal(
    Object.values(notebook.collection.rewardItems[id].referenceCounts).reduce((sum, count) => sum + count, 0),
    reward.roles.reduce((sum, role) => sum + reward.referenceCounts[role], 0),
    `奖励物品 ${id} 的引用计数与导出不一致`);
}
assert(catalog.monsterTextSemantics?.reward, '目录没有记录逐怪 reward 节点的语义');
assert(catalog.monsterTextSemantics.reward.includes('掉落'), '逐怪 reward 节点的语义说明没有指出它是掉落清单');
assert.deepEqual(catalog.monsterText, notebook.monsterText.monsters, '逐怪文本不是导出源的镜像');
// 反向：每个带奖励的行，其奖励物品都必须能在奖励表里查到。
for (const row of Object.values(catalog.monsterStructure.rows)) {
  if (row.rewardItemId === null) continue;
  assert(catalog.rewardItems[canonical(row.rewardItemId)], `行 ${row.rowKey} 的奖励物品不在奖励表里: ${row.rewardItemId}`);
}

// 客户端投影：公开目录的一半，且绝不能带任务分区。
assert.deepEqual(client.catalogVersion, catalog.catalogVersion, '客户端投影版本与目录不一致');
assert.equal(client.sections.quest, undefined, '客户端投影泄露了任务道具静态目录');
for (const [name, ids] of Object.entries(client.sections)) {
  assert.deepEqual(ids, catalog.sections[name], `客户端投影的 ${name} 分区与服务端不一致`);
}
assert.deepEqual(Object.keys(client.sections).sort(), Object.keys(catalog.sections).filter(name => name !== 'quest').sort(), '客户端投影分区表不完整');
// 椅子页的展示投影：随资源下发的那半张表必须与分区一一对应（名字归
// `chair-names.json`、图标归素材表，这里不复制第二份）。
assert.deepEqual(
  sorted(Object.keys(client.chairs ?? {})),
  sorted(catalog.sections.chair),
  '客户端投影的椅子表与椅子分区不一致');
for (const [id, chair] of Object.entries(client.chairs ?? {})) {
  assert.deepEqual(
    [chair.recoveryHP, chair.recoveryMP, chair.recoveryIntervalMs],
    [catalog.chairs[id].recoveryHP, catalog.chairs[id].recoveryMP, catalog.chairs[id].recoveryIntervalMs],
    `客户端投影的椅子恢复量与服务端不一致: ${id}`);
  assert.equal(chair.availability, catalog.chairs[id].availability, `客户端投影的椅子可获得性不一致: ${id}`);
}
// 奖励物品的展示投影：窗口必须能说出「这一行给什么」，包括本版本发不出去的
// 那些——但可发放性、名称引用必须与服务端目录逐项一致。
assert.deepEqual(sorted(Object.keys(client.rewardItems)), sorted(Object.keys(catalog.rewardItems)), '客户端投影缺少奖励物品');
for (const [id, reward] of Object.entries(catalog.rewardItems)) {
  const projected = client.rewardItems[id];
  assert(projected, `客户端投影缺少奖励物品 ${id}`);
  assert.deepEqual(projected.roles, reward.roles, `客户端投影的奖励来源层级不一致: ${id}`);
  assert.deepEqual(projected.referenceCounts, reward.referenceCounts, `客户端投影的奖励引用计数不一致: ${id}`);
  assert.equal(projected.definitionStatus, reward.definitionStatus, `客户端投影的奖励定义状态不一致: ${id}`);
  assert.equal(projected.definitionAvailable, reward.definitionAvailable, `客户端投影的可发放性不一致: ${id}`);
  assert.equal(projected.name, reward.name, `客户端投影的奖励名称与服务端不一致: ${id}`);
  assert.equal(projected.reason, reward.reason, `客户端投影的奖励阻塞原因与服务端不一致: ${id}`);
}
assert.equal(client.status.registration, 'unverified', '客户端展示的登记状态与规则不一致');
assert.equal(client.status.rewardItemAvailability, rules.rewards.itemAvailability.mode, '客户端展示的奖励物品状态与规则不一致');
assert.equal(client.status.rewardItemReason, rules.rewards.itemAvailability.blockedReason, '客户端展示的奖励物品原因与规则不一致');
assert.deepEqual(client.status.rewardItemCounts, {
  deliverable: rules.rewards.itemAvailability.deliverableCount,
  definitionMissing: rules.rewards.itemAvailability.definitionMissingCount,
}, '客户端展示的奖励物品计数与规则不一致');
for (const key of ['registrationReason', 'rewardReason', 'explorationReason']) {
  assert(typeof client.status[key] === 'string' && client.status[key].length > 0, `客户端缺少 ${key} 的阻塞说明`);
}

// ------------------------------------------------------------------ 规则 --
assert.equal(rules.registration.mode, 'unverified', '正式内容不得登记未核定的收藏规则');
assert.equal(rules.registration.probability, null, '正式内容不得携带未经核定的登记概率');
assert.equal(rules.registration.qualificationGate, null, '正式内容不得携带未经核定的资格门');
assert(rules.registration.blockedReason.includes('尚未核定'), '登记阻塞原因必须说人话');
assert.equal(rules.rewards.row.mode, 'unverified', '行奖励的达成条件未核定，不得标为可用');
assert.equal(rules.rewards.row.condition, null, '不得携带未经核定的行达成条件');
assert.equal(rules.rewards.page.mode, 'unverified', '分页奖励未核定');
assert.equal(rules.rewards.page.condition, null, '不得携带未经核定的分页达成条件');
assert.equal(rules.rewards.region.mode, 'unverified', '地区奖励未核定');
assert.equal(rules.rewards.region.condition, null, '不得携带未经核定的地区达成条件');
// 奖励物品能不能发出去，是独立于「条件核定了没有」的第二个阻塞点：两者都必须
// 各自交代，任何一个解除都不能让人误以为另一个也解除了。
assert.equal(rules.rewards.itemAvailability.mode, 'P', '奖励物品可用性必须标为 P');
assert.equal(
  rules.rewards.itemAvailability.deliverableCount,
  Object.values(catalog.rewardItems).filter(reward => reward.definitionAvailable).length,
  '规则表的可发放奖励计数与目录不一致');
assert.equal(
  rules.rewards.itemAvailability.definitionMissingCount,
  catalog.definitionMissingRewardCount,
  '规则表的缺失定义计数与目录不一致');
assert(rules.rewards.itemAvailability.evidence.startsWith('T:'), '奖励物品可用性的证据必须标明来自同版源');
assert.equal(
  rules.rewards.itemAvailability.definitionMissingCount > 0,
  typeof rules.rewards.itemAvailability.blockedReason === 'string' && rules.rewards.itemAvailability.blockedReason.length > 0,
  '奖励物品的阻塞原因必须与缺失定义计数同进同退');
if (rules.rewards.itemAvailability.definitionMissingCount > 0) {
  assert(rules.rewards.itemAvailability.blockedReason.includes('没有物品定义'), '奖励物品缺失原因必须说清楚');
}
// 玩家可见的阻塞原因一律简体（专有名词与物品名保持繁体）。
for (const level of ['row', 'page', 'region']) {
  assert(!rules.rewards[level].blockedReason.includes('該'), `${level} 奖励的阻塞原因必须用简体`);
}
assert(!String(rules.rewards.itemAvailability.blockedReason ?? '').includes('該'), '奖励物品的阻塞原因必须用简体');
assert.equal(rules.exploration.slotCount, null, '不得携带未经核定的探险槽位数');
assert.equal(rules.exploration.dailyLimit, null, '不得携带未经核定的每日上限');
assert.equal(rules.exploration.mode, 'unverified', '探险依赖未核定的登记规则，必须保持阻塞');
assert(rules.exploration.cycleMinutesFrom.startsWith('T:'), '探险时长必须标明来自同版源');
assert(rules.exploration.slotCountEvidence.startsWith('U:'), '探险槽位缺失必须标为 U');
assert.equal(rules.sourceType.mode, 'unverified', '源 type 的含义未核定，不得当作条件');
for (const value of Object.values(rules.rewards)) {
  if (typeof value === 'object' && value !== null) assert(value.delivery || value.mode, '奖励规则缺少交付说明或状态');
}
assert.equal(rules.scope.monsterCollection, 'account', '怪物收藏必须是账号级');
assert.equal(rules.scope.itemRecords, 'character', '物品记录必须是角色级');
assert(rules.scope.monsterCollectionEvidence.startsWith('P:'), '归属默认值必须标为 P');

// ------------------------------------------------- 初始发放清单的镜像检查 --
{
  const source = serverSource('server/src/inventory.rs');
  const body = name => {
    const start = source.indexOf(`pub fn ${name}(`);
    assert(start >= 0, `server/src/inventory.rs 找不到 ${name}`);
    const end = source.indexOf('\n}\n', start);
    assert(end > start, `server/src/inventory.rs 的 ${name} 结构无法解析`);
    return source.slice(start, end);
  };
  const ids = new Set();
  for (const name of ['starter_equipment', 'starter_items']) {
    for (const match of body(name).matchAll(/"(\d{7,8})"/g)) ids.add(canonical(match[1]));
  }
  for (const id of INITIAL_GRANT_IDS) assert(ids.has(id), `初始发放清单镜像过期：inventory.rs 里没有 ${id}`);
  for (const id of ids) {
    assert(catalog.items[id], `Rust 里初始发放的 ${id} 不在图鉴目录里`);
    assert.equal(catalog.items[id].availability, 'obtainable', `初始发放的 ${id} 没有被列为可获得`);
  }
}

// -------------------------------------------------------- 事实层契约（NB-03） --
{
  const schema = serverSource('server/src/auth/schema.rs');
  for (const table of [
    'notebook_item_records',
    'monster_collection_records',
    'notebook_revisions',
    'notebook_backfill_runs',
  ]) {
    assert(
      schema.includes(`CREATE TABLE IF NOT EXISTS ${table}(`),
      `server/src/auth/schema.rs 缺少事实表 ${table}`);
  }
  // 归属必须落在唯一键上：物品记录按角色、收藏按登录账号、补记标记按(角色,版本)。
  for (const [pattern, why] of [
    [/notebook_item_records\([\s\S]*?PRIMARY KEY\(character_id,item_id\)/, '物品获得事实必须按 (character_id,item_id) 唯一'],
    [/monster_collection_records\([\s\S]*?PRIMARY KEY\(owner_account_id,entry_id\)/, '怪物收藏必须按 (owner_account_id,entry_id) 唯一'],
    [/notebook_revisions\([\s\S]*?PRIMARY KEY\(scope_kind,scope_id\)/, 'revision 必须按 (scope_kind,scope_id) 唯一'],
    [/notebook_backfill_runs\([\s\S]*?PRIMARY KEY\(character_id,migration_version\)/, '补记标记必须按 (character_id,migration_version) 唯一'],
  ]) {
    assert(pattern.test(schema), why);
  }

  const facts = serverSource('server/src/auth/notebook.rs');
  for (const symbol of [
    'record_item_acquisitions_tx',
    'backfill_item_records_tx',
    'canonical_item_id',
    'classify_item',
    'resolve_owner',
    'read_item_records',
    'read_revision',
    'ITEM_BACKFILL_VERSION',
  ]) {
    assert(facts.includes(symbol), `server/src/auth/notebook.rs 缺少 ${symbol}`);
  }
  // 时间未知就如实写未知：历史补记得是 NULL + unknown，不能拿补记时间冒充获得时间。
  assert(facts.includes('TIME_QUALITY_UNKNOWN: &str = "unknown"'), '补记必须带 unknown 时间标记');
  assert(facts.includes('TIME_QUALITY_EVENT: &str = "event"'), '实时获得必须带 event 时间标记');
  assert(/VALUES \(\?1,\?2,NULL,\?3,\?4,\?5,\?6\)/.test(facts), '历史补记的获得时间必须写 NULL');
  // 事实层只记录结果：不替业务决定能否发奖，也不在事务里发网络消息。
  assert(!facts.includes('try_send'), '事实层不得在事务内发网络消息');
  assert(!facts.includes('INSERT INTO inventory'), '事实层不得替业务加物品');
  // 目录键规范化只走字符串规则：不得用浮点转换接受指数、负数或任意号段。
  const normalize = facts.slice(
    facts.indexOf('fn canonical_item_id'),
    facts.indexOf('fn classify_item'));
  assert(normalize.length > 0, '找不到 canonical_item_id');
  for (const forbidden of ['f64', 'parse::<', 'from_str_radix', 'as u64']) {
    assert(!normalize.includes(forbidden), `物品 id 规范化不得使用 ${forbidden}`);
  }

  // 查询必须读事实层**真实提交**的 revision，不能把 0 写死。
  const world = serverSource('server/src/notebook.rs');
  assert(world.includes('fn notebook_summary_for'), '查询没有读事实层');
  assert(world.includes('notebook_revision'), '查询没有读已提交的 revision');
  assert(world.includes('"revision": revision'), '查询必须把读到的 revision 发出去');
  for (const symbol of ['SCOPE_ACCOUNT', 'SCOPE_CHARACTER']) {
    assert(world.includes(`facts::${symbol}`), `查询缺少 ${symbol}`);
  }
  // 四页查询是纯函数（便于定向检查），且任务页的过滤必须落在服务器自己的集合上。
  assert(/^fn item_rows\(/m.test(world) && /^fn monster_rows\(/m.test(world), '四页查询不是模块级纯函数');
  assert(/records\.contains_key\(\*id\)/.test(world), '任务页没有按已获得集合过滤');
  // 阻塞原因逐条说清楚**缺的是哪一环**，而不是一句笼统的"尚未开放"，且一律简体。
  // NB-07 起物品页真的在出条目了，所以"物品页整页阻塞"这条豁免必须已经消失——
  // 留着它就会让真实内容被一句"尚未开放"挡住。
  assert(!/ITEMS_BLOCKED/.test(world), '物品页已经真实出条目，不该再保留整页阻塞豁免');
  for (const name of ['VERSION_MISMATCH', 'MONSTER_BLOCKED', 'CLAIM_BLOCKED', 'EXPLORATION_BLOCKED']) {
    const match = world.match(new RegExp(`const ${name}: &str =\\s*"([^"]+)"`));
    assert(match, `server/src/notebook.rs 缺少 ${name}`);
    assert(!match[1].includes('該'), `${name} 必须用简体`);
    assert(match[1].length > 8, `${name} 必须说人话`);
  }
  // 写入方（NB-05／NB-06）接入前这条 dead_code 例外才有理由存在，所以它必须写明
  // 移除条件——否则会留成一条没人敢删的静音开关。
  const allowIndex = facts.indexOf('#![allow(dead_code)]');
  if (allowIndex >= 0) {
    const context = facts.slice(Math.max(0, allowIndex - 1500), allowIndex);
    assert(context.includes('NB-05'), 'dead_code 例外必须写明移除条件（NB-05）');
  }

  // 页签必须是目录的无重叠全覆盖分区：重叠会把一件装备算两种，漏掉会永久漏记。
  // 定义集合是「物品 ∪ 骑宠」：骑宠（`Character/TamingMob`）不在 `items.json`
  // 里（那份同时是「当前可获得」分母），所以坐骑表是第二张定义表。
  const sectionIds = Object.values(catalog.sections).flat();
  const definitionCount = catalog.itemDefinitionCount + catalog.mountCount + catalog.chairCount;
  assert.equal(sectionIds.length, definitionCount, '页签必须覆盖整份目录（物品 + 骑宠 + 椅子）');
  assert.equal(new Set(sectionIds).size, definitionCount, '页签不得重叠');
  for (const id of sectionIds) {
    assert(catalog.items[id] || catalog.mounts[id] || catalog.chairs[id], `页签里的 ${id} 不在目录里`);
  }
}

// ------------------------------------------------ 商店事务化契约（NB-04） --
{
  // A 组 4 处「非事务整表写回」的缺口：先改内存再 `let _ =` 写库，持久化
  // 失败被静默吞掉。NB-04 把它们收进单事务提交 helper，调用方只在 commit
  // 成功后才改内存。这条断言盯着「不许回退」，也盯着新增写回别再落进同一坑。
  const shop = serverSource('server/src/auth/shop.rs');
  for (const helper of ['shop_buy_commit', 'shop_sell_commit', 'shop_rebuy_commit']) {
    assert(shop.includes(`pub fn ${helper}`), `auth/shop.rs 缺少 ${helper}`);
  }
  // 赎回行的入表必须有一个事务内实现供出售事务复用（否则又是两段写回）。
  assert(shop.includes('fn push_shop_rebuy_tx('), 'auth/shop.rs 缺少事务内赎回入表');

  const trade = serverSource('server/src/trade.rs');
  const cashshop = serverSource('server/src/cashshop.rs');
  // 商店资产路径不得再出现吞错写回；`record_cash_purchase` 只是内存预算
  // 缓存的 write-through，不属于资产事务，按名字精确排除。
  const swallowed = [
    ['server/src/trade.rs', trade],
    ['server/src/cashshop.rs', cashshop],
  ].flatMap(([file, source]) =>
    [...source.matchAll(/let _ = store\.(\w+)/g)]
      .filter(([, method]) => method !== 'record_cash_purchase')
      .map(([match]) => `${file}: ${match}`)
  );
  assert.equal(swallowed.length, 0, `仍有吞错的持久化写回:\n${swallowed.join('\n')}`);
  for (const call of ['shop_buy_commit', 'shop_sell_commit', 'shop_rebuy_commit']) {
    assert(
      new RegExp(`\\.${call}\\(`).test(trade),
      `trade.rs 未接入 ${call} 事务提交`
    );
  }
  // 买回不得再在校验通过后单独删行（行会在写库失败时凭空丢掉）。
  assert(
    !trade.includes('.take_shop_rebuy('),
    '买回必须与资产同事务消费赎回行，不得单独 take'
  );
}

// -------------------------------------------------------- 协议契约（双端） --
{
  const ts = fs.readFileSync(path.join(ROOT, 'shared/protocol.ts'), 'utf8');
  const rs = serverSource('server/src/protocol.rs');
  for (const type of ['notebookQuery', 'notebookState', 'notebookChanged']) {
    assert(ts.includes(`'${type}'`), `shared/protocol.ts 缺少 ${type}`);
  }
  for (const variant of ['NotebookQuery', 'CollectionClaim', 'ExplorationStart', 'ExplorationClaim']) {
    assert(rs.includes(variant), `server/src/protocol.rs 缺少 ${variant}`);
  }
  // 网络层只做解析与投递，不得直接写库。
  const commands = serverSource('server/src/commands.rs');
  assert(commands.includes('ClientMessage::NotebookQuery'), 'commands.rs 没有分发笔记查询');
  const network = serverSource('server/src/network.rs');
  for (const forbidden of ['INSERT INTO notebook', 'UPDATE notebook']) {
    assert(!network.includes(forbidden), `网络层不得直接写图鉴: ${forbidden}`);
  }
}

// ------------------------------------------- 旧菜单可见改名（NB-07 前置） --
{
  // 源标签仍是 怪物收藏（上面的入口身份断言盯着它），玩家看到的却必须是
  // 冒险笔记（图鉴）—— 改名只发生在客户端本地化层。而源按钮把标签**烘焙**在
  // 136x40 的位图里（图标、平板底板、字形都在同一张图），所以改名不能只加
  // 一行文字：必须裁掉烘焙字形、按素材自己的颜色重画底板、再自己画名字。
  // 这一段把这三件事钉在**导出素材的真实像素**上。
  const i18n = clientSource('client/src/app/i18n.ts');
  const view = clientSource('client/src/features/menu/view.ts');
  const css = clientSource('client/src/features/menu/style.css');

  // 1) 改名登记在本地化层，源标签保持原样。
  const override = i18n.match(new RegExp(`'${MENU_KEY}':\\s*\\{\\s*zh:\\s*'([^']+)'`));
  assert(override, `客户端本地化层没有登记 ${MENU_KEY} 的可见名称`);
  assert.equal(override[1], '冒險筆記（圖鑑）', `${MENU_KEY} 登记的可见名称不是计划要求的那个`);
  assert.equal(notebook.menu.label, '怪物收藏', '源标签必须保持原样：改名只发生在本地化层');
  assert(view.includes('menuEntryText('), '菜单视图没有消费本地化层的改名');
  // 英文要跟着现有本地化机制走（计划 §7.4），不能只留中文。
  const english = i18n.match(new RegExp(`'${MENU_KEY}':\\s*\\{\\s*zh:\\s*'[^']+',\\s*en:\\s*'([^']+)'`));
  assert(english, `${MENU_KEY} 缺少英文可见名称`);
  assert(english[1] !== override[1] && english[1].length > 0, `${MENU_KEY} 的英文可见名称没有实际含义`);
  // 改名表里的每个键都必须真的是清单里的入口：写错一个键不会报错，只会静默不生效。
  const table = i18n.slice(i18n.indexOf('const MENU_ENTRY_TEXT'), i18n.indexOf('export function uiLocale'));
  const renamedKeys = [...table.matchAll(/'([^']*menu\/[^']*)':/g)].map(match => match[1]);
  assert(renamedKeys.includes(MENU_KEY), `改名表里没有 ${MENU_KEY}`);
  const known = new Set((manifest.totalMenuEntries ?? []).map(row => row.key));
  for (const key of renamedKeys) assert(known.has(key), `改名表里的 ${key} 不是清单里的入口，这个改名永远不会生效`);

  // 2) 裁切边界只写一处，样式表从它推导裁切与底板。
  const clip = Number((view.match(/const ITEM_ICON_STRIP = (\d+);/) ?? [])[1]);
  assert(Number.isInteger(clip), 'view.ts 缺少 ITEM_ICON_STRIP');
  assert(view.includes("'--menu-icon-strip'"), '菜单视图没有把裁切边界交给样式表');
  assert(css.includes('clip-path:inset(0 calc(136px - var(--menu-icon-strip)) 0 0)'), '样式表没有用同一个裁切边界');
  assert(css.includes('left:var(--menu-icon-strip)'), '底板没有跟着裁切边界');
  assert(css.includes('width:calc(136px - var(--menu-icon-strip))'), '底板宽度没有跟着裁切边界');

  // 3) 边界与颜色必须与素材的真实像素一致：量出来，不抄常量。
  const artOf = state => readPngPixels(path.join(ROOT, 'client/public-tms273', manifest.totalMenuUi[`${MENU_KEY}/${state}/0`].url.slice(1)));
  const plateColour = {};
  // 三态都要量：验收要求普通／悬停／按下都只能看到新名字（没有旧字透出、没有叠字），
  // 所以每一态的底板颜色都必须被样式表的某条规则覆盖到。
  const STATES = ['normal', 'mouseOver', 'pressed'];
  let band = null;
  let sourceOrigin = null;
  let sourceSpan = null;
  for (const state of STATES) {
    const png = artOf(state);
    assert.equal(png.width, 136, `${state} 素材宽度变了`);
    assert.equal(png.height, 40, `${state} 素材高度变了`);
    const at = (x, y) => { const i = (y * png.width + x) * 4; return [png.pixels[i], png.pixels[i + 1], png.pixels[i + 2], png.pixels[i + 3]]; };
    // 右上角永远只有底板，用它自己的颜色来区分「墨迹」。
    const plate = at(png.width - 1, 0);
    plateColour[state] = plate;
    const columns = [...Array(png.width).keys()];
    const rows = [...Array(png.height).keys()];
    const ink = columns.map(x => rows.some(y => !sameColour(at(x, y), plate)));
    // 图标与字形之间那个空档：找第一段连续 ≥3 列无墨迹的地方。
    const first = ink.indexOf(true);
    assert(first >= 0, `${state} 素材没有任何墨迹`);
    let start = -1, end = -1;
    for (let x = first; x + 2 < png.width; x++) if (!ink[x] && !ink[x + 1] && !ink[x + 2]) { start = x; end = x + 2; break; }
    assert(start >= 0, `${state} 素材里图标与字形之间没有空档，改名无从下手`);
    while (end + 1 < png.width && !ink[end + 1]) end++;
    const glyphStart = ink.indexOf(true, end + 1);
    assert(glyphStart > end, `${state} 素材空档右侧没有字形，改名的前提不成立`);
    // 裁切边界必须落在这个空档里：左侧图标整段留下，右侧烘焙字形整段裁掉。
    assert(clip >= start && clip <= end, `${state} 的裁切边界 ${clip} 不在图标与字形之间的空档 [${start},${end}] 里`);
    // 底板必须是纯色，否则「重画底板」这件事本身就不成立。
    const glyphEnd = ink.lastIndexOf(true);
    for (let x = glyphEnd + 1; x < png.width; x++) {
      for (const y of rows) assert(sameColour(at(x, y), plate), `${state} 素材的底板不是纯色 (${x},${y})`);
    }
    if (state === 'normal') {
      const bandRows = rows.filter(y => columns.some(x => x >= glyphStart && !sameColour(at(x, y), plate)));
      band = { from: Math.min(...bandRows), to: Math.max(...bandRows) };
      // 源字形自己的起点与跨度：改名后的名字要落在同一个起点上，而它比源标签长，
      // 所以「能放多大」必须由这两个量算出来，不能拍脑袋。
      sourceOrigin = glyphStart;
      sourceSpan = glyphEnd - glyphStart + 1;
    }
  }

  // 4) 样式表里的底板颜色、字号与位置必须与素材/可见名称对得上。
  const plateRule = css.match(/\.maple-menu-item-plate\{([^}]*)\}/);
  const hoverRule = css.match(/\.maple-menu-item\[data-menu-state="mouseOver"\] \.maple-menu-item-plate\{([^}]*)\}/);
  assert(plateRule && hoverRule, '样式表缺少改名后的底板规则');
  // 每一态实际生效的是哪条规则：悬停态有专门规则，其余态落到基础规则。
  // 这样写出来，源素材哪天给按下态换了底板颜色，这条断言就会失败并要求补规则，
  // 而不是让按下时露出白色的错误底板。
  for (const state of STATES) {
    const rule = state === 'mouseOver' ? hoverRule[1] : plateRule[1];
    const colour = rule.match(/background:rgba\((\d+),(\d+),(\d+),([\d.]+)\)/);
    assert(colour, `${state} 底板没有背景色`);
    const written = [Number(colour[1]), Number(colour[2]), Number(colour[3]), Math.round(Number(colour[4]) * 255)];
    assert.deepEqual(written, plateColour[state], `${state} 底板颜色与素材不一致`);
  }
  const labelRule = css.match(/\.maple-menu-item-label\{([^}]*)\}/);
  assert(labelRule, '样式表缺少改名后的文字规则');
  const labelLeft = Number((labelRule[1].match(/left:(\d+)px/) ?? [])[1]);
  const labelWidth = Number((labelRule[1].match(/width:(\d+)px/) ?? [])[1]);
  const font = labelRule[1].match(/font:([\d.]+)px\/([\d.]+)px/);
  assert(Number.isInteger(labelLeft) && Number.isInteger(labelWidth) && font, '改名后的文字规则缺少定位或字号');
  const fontSize = Number(font[1]), lineHeight = Number(font[2]);
  assert(Number.isInteger(sourceOrigin) && Number.isInteger(sourceSpan), '没能从素材量出源字形的起点与跨度');
  assert(labelLeft >= clip, '改名后的文字盖住了图标');
  assert.equal(labelLeft + labelWidth, 136, '改名后的文字没有铺满底板右侧');
  // 文字要从源字形的起点开始：偏出去就会和上下相邻按钮的左边缘错开。
  assert(Math.abs(labelLeft - sourceOrigin) <= 2, `改名后的文字起点 ${labelLeft} 偏离源字形起点 ${sourceOrigin}`);
  // 可见名称比源标签长，所以字号必须自己算：从源字形起点到按钮右边缘是全部可用
  // 宽度，取放得下的**最大整数字号**——再大就会被 overflow:hidden 悄悄裁掉，
  // 再小就是没理由地比源字形小。
  const available = 136 - sourceOrigin;
  const fitted = Math.floor(available / override[1].length);
  assert.equal(fontSize, fitted, `可见名称在 ${available}px 可用宽度里应取最大整数字号 ${fitted}px，而不是 ${fontSize}px`);
  assert(override[1].length * fontSize <= labelWidth, `可见名称 ${override[1].length} 个字在 ${fontSize}px 下放不进 ${labelWidth}px 的文字框`);
  // 反向：源字号（由源字形自己量出来，不是抄来的常量）**放不下**这个更长的名字。
  // 这条断言的意义是让「为什么不用源字号」一直有据可查——哪天源素材或可见名称
  // 短到源字号也放得下，它会失败，提醒把这个缩小的理由删掉。
  const sourceAdvance = Math.round(sourceSpan / notebook.menu.label.length);
  assert(
    override[1].length * sourceAdvance > available,
    `源字号 ${sourceAdvance}px 已经放得下 ${override[1].length} 个字的可见名称，不该再缩小字号`);
  // 名字要落在源字形同一条中线上，否则会和相邻按钮错开半行。行盒从按钮顶边
  // 开始、高 lineHeight，字身盒居中于 lineHeight/2。
  assert.equal(lineHeight / 2, (band.from + band.to) / 2, '改名后的文字与源字形不在同一条中线上');

  // 5) 可见名称必须同时落到 tooltip 与 aria-label（计划 §7.4：三者一致），
  //    而且改名入口要三态都换图——否则悬停或按下时会露出旧字形。
  assert(
    /createAssetButton\(entry\.key,\s*displayText\(label\),/.test(view),
    '改名后的可见名称没有交给按钮的 tooltip／aria-label');
  assert(view.includes('button.title = label;') && view.includes("button.setAttribute('aria-label', label)"),
    '按钮没有把传入的名称同时写进 tooltip 与 aria-label');
  assert(view.includes("assets[`${key}/${state}/0`] ?? normal"), '按钮没有按状态换图，改名后会出现「悬停变回旧字」');
}

// ---------------------------------------------------------------- NB-07
// 单入口 + 四页窗口 + 私有查询。  目录／奖励／规则三件 NB-00..05 已经钉住，这里
// 只补「窗口真的接上了」这件事：接线断在哪一环，玩家看到的就是菜单点了没反应，
// 而这类断线不会被任何单元测试发现（每一半单看都是好的）。
{
  const menu = clientSource('client/src/features/menu/view.ts');
  const main = clientSource('client/src/app/main.ts');
  const directory = clientSource('client/src/features/notebook/directory.ts');
  const viewModel = clientSource('client/src/features/notebook/view-model.ts');
  const protocolRs = serverSource('server/src/protocol.rs');

  // 1) 菜单：type 22 这一项必须接到 `onNotebook`，且是唯一新增的映射。
  assert(/entry\.type === 22 \? this\.onNotebook/.test(menu), '源菜单 type 22 没有接到冒险笔记入口');
  assert(/private onNotebook\?: \(\) => void/.test(menu), 'MenuView 缺少 onNotebook 回调');
  // 2) main.ts 必须真的把回调传进去，并在打开前收起菜单（计划 §6.2 第 3 条）。
  assert(/menus\?\.close\(\); notebook\?\.open\(\)/.test(main), '菜单回调没有开冒险笔记窗口');
  // 3) 服务端推来的两路私有消息都要有人接，否则窗口永远停在"正在读取"。
  assert(/message\.type === 'notebookState'[\s\S]{0,120}notebook\?\.receiveState/.test(main), 'main.ts 没有分发 notebookState');
  assert(/message\.type === 'notebookChanged'\) notebook\?\.receiveChange/.test(main), 'main.ts 没有分发 notebookChanged');
  // 4) ESC 与登出：不进 escapeBlocked 就会连菜单一起开；不销毁就会漏监听器。
  assert(/notebook\?\.isOpen\(\)/.test(main), 'escapeBlocked 没有算上冒险笔记窗口');
  assert(/notebook\?\.destroy\(\); notebook = undefined/.test(main), 'leaveGame 没有销毁冒险笔记窗口');
  // 5) 样式表随窗口一起加载（离线检查不认 CSS，所以必须显式引入）。
  assert(main.includes("import '../features/notebook/style.css';"), 'main.ts 没有引入冒险笔记样式表');

  // 6) 四页与任务页的开关。  任务页没有「未获得」：未获得的条目从服务器的基集合
  //    里就不存在，给一个开关等于向玩家暗示它们存在。
  assert(/if \(section === 'quest'\) return \['all'\];/.test(viewModel), '任务页必须只有一种浏览方式');
  // 骑宠页同样不能给「当前可获得」：源把每件骑宠都标成 `notSale / only`，本版本没有
  // 一条开放获取途径，按它过滤只会得到空页，读起来像「本版本没有坐骑」。
  assert(/section === 'mount'\) return MOUNT_MODES;/.test(viewModel),
    '骑宠页必须用自己的浏览方式（没有「当前可获得」）');
  assert(/MOUNT_MODES = \['all', 'obtained', 'missing'\]/.test(viewModel),
    '骑宠页的浏览方式不得包含「当前可获得」');
  // 椅子页同理：2799 件里真进商店的是个位数，按「当前可获得」过滤几乎空页。
  assert(/section === 'chair' \? CHAIR_MODES : BROWSE_MODES/.test(viewModel),
    '椅子页必须用自己的浏览方式（没有「当前可获得」）');
  assert(/CHAIR_MODES = \['all', 'obtained', 'missing'\]/.test(viewModel),
    '椅子页的浏览方式不得包含「当前可获得」');
  assert(/section === 'mount' \|\| section === 'chair' \? 'all' : 'available'/.test(viewModel),
    '骑宠页与椅子页默认必须是「全部」');
  for (const tab of ['monster', 'equipment', 'use', 'mount', 'chair', 'quest']) {
    assert(viewModel.includes(`section: '${tab}'`), `六个页签缺少 ${tab}`);
  }
  // 7) 客户端目录类型里没有 quest 分区——任务条目是服务器算出来的，不是静态清单。
  assert(/Record<Exclude<NotebookSection, 'monster' \| 'quest'>, string\[\]>/.test(directory),
    '客户端目录不该声明 quest 分区');
  const projection = read('client/public-tms273/assets/notebook.json');
  assert(!('quest' in projection.sections), '客户端投影里出现了任务分区：未获得条目会被先泄后藏');
  // 骑宠页不是任务页，分区与坐骑表都要随资源下发（名字与图标另归
  // `mount-index.json` 与素材表，这里不复制第二份）。
  assert('mount' in projection.sections, '客户端投影缺少骑宠分区');
  assert.deepEqual(
    [...projection.sections.mount].sort(),
    [...Object.keys(projection.mounts)].sort(),
    '骑宠分区与随资源下发的坐骑表不一致');
  // 椅子页同骑宠页：分区与椅子表都要随资源下发（名字与图标另归
  // `chair-names.json` 与素材表，这里不复制第二份）。
  assert('chair' in projection.sections, '客户端投影缺少椅子分区');
  assert.deepEqual(
    [...projection.sections.chair].sort(),
    [...Object.keys(projection.chairs)].sort(),
    '椅子分区与随资源下发的椅子表不一致');

  // 8) 浏览方式与搜索长度：服务端只认这四个取值，未知取值退化成默认而不是第四态。
  for (const mode of ['available', 'all', 'obtained', 'missing']) {
    assert(protocolRs.includes(`NOTEBOOK_MODE_${mode.toUpperCase()}: &str = "${mode}"`), `协议缺少浏览方式 ${mode}`);
  }
  assert(/NOTEBOOK_MAX_FILTER_CHARS: usize = 32/.test(protocolRs), '搜索长度上限不是 32');
  // 客户端输入框的上限必须与服务端一致，否则玩家能打出服务器必拒的搜索词。
  const viewTs = clientSource('client/src/features/notebook/view.ts');
  assert(/search\.maxLength = 32/.test(viewTs), '搜索框上限与服务端不一致');
}

console.log(JSON.stringify({
  ok: true,
  menu: `${MENU_KEY} type ${MENU_TYPE}`,
  notebookFrames: Object.fromEntries(Object.entries(manifest.notebook.frames).map(([panel, frames]) => [panel, Object.keys(frames).length])),
  itemDefinitions: catalog.itemDefinitionCount,
  mountDefinitions: catalog.mountCount,
  chairDefinitions: catalog.chairCount,
  aliasesDeduped: catalog.aliasDedupe.deduped,
  sections: Object.fromEntries(Object.entries(catalog.sections).map(([name, ids]) => [name, ids.length])),
  monsterEntries: catalog.monsterEntryCount,
  collectableEntries: catalog.collectableEntryCount,
  rows: Object.keys(catalog.monsterStructure.rows).length,
  regions: Object.keys(catalog.monsterStructure.regions).length,
  rewardItems: catalog.rewardItemCount,
  rewardDefinitionMissing: catalog.definitionMissingRewardCount,
  registration: rules.registration.mode,
  exploration: rules.exploration.mode,
  factTables: [
    'notebook_item_records',
    'monster_collection_records',
    'notebook_revisions',
    'notebook_backfill_runs',
  ].length,
}, null, 2));
