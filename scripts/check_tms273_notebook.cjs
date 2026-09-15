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
const { MENU_KEY, MENU_TYPE, INITIAL_GRANT_IDS, WZ_JSON, canonical } = (() => {
  const exported = require('./export_tms273_collection.cjs');
  const generated = require('./generate_tms273_notebook_catalog.cjs');
  return { ...exported, ...generated };
})();

const ROOT = path.resolve(__dirname, '..');
const INPUT = path.join(ROOT, 'resources/tms273-export');
const read = file => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const serverSource = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

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
const finalCanonical = new Set(Object.keys(finalItems).map(canonical).filter(Boolean));
const catalogCanonical = new Set(Object.keys(catalog.items));
assert.deepEqual([...catalogCanonical].sort(), [...finalCanonical].sort(), '图鉴物品定义与最终物品目录不一致');
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
const sectionMembers = new Set();
for (const [name, ids] of Object.entries(catalog.sections)) {
  for (const id of ids) {
    assert(catalog.items[id], `分区 ${name} 引用了不存在的物品 ${id}`);
    assert(!sectionMembers.has(id), `物品 ${id} 同时出现在多个分区`);
    sectionMembers.add(id);
  }
  assert.deepEqual(ids, [...ids].sort((a, b) => Number(a) - Number(b)), `分区 ${name} 未排序`);
}
assert.deepEqual([...sectionMembers].sort(), [...catalogCanonical].sort(), '分区没有覆盖全部物品定义');
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
for (const [id, definition] of Object.entries(catalog.items)) {
  const open = definition.obtainEvidence.filter(evidence => !evidence.startsWith('collectionReward:'));
  assert.equal(
    definition.availability,
    open.length ? 'obtainable' : 'unverified',
    `物品 ${id} 的可获得性把未核定的收藏奖励算成了已开放链路`);
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
  assert(world.includes('notebook_fact_summary'), '查询没有读事实层');
  assert(world.includes('notebook_revision'), '查询没有读已提交的 revision');
  assert(world.includes('"revision": revision'), '查询必须把读到的 revision 发出去');
  for (const symbol of ['SCOPE_ACCOUNT', 'SCOPE_CHARACTER']) {
    assert(world.includes(`facts::${symbol}`), `查询缺少 ${symbol}`);
  }
  // 阻塞原因逐分区说清楚**缺的是哪一环**，而不是一句笼统的"尚未开放"，且一律简体。
  for (const name of ['ITEMS_BLOCKED', 'MONSTER_BLOCKED', 'CLAIM_BLOCKED', 'EXPLORATION_BLOCKED']) {
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
  const sectionIds = Object.values(catalog.sections).flat();
  assert.equal(sectionIds.length, catalog.itemDefinitionCount, '页签必须覆盖整份目录');
  assert.equal(new Set(sectionIds).size, catalog.itemDefinitionCount, '页签不得重叠');
  for (const id of sectionIds) {
    assert(catalog.items[id], `页签里的 ${id} 不在物品目录里`);
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

console.log(JSON.stringify({
  ok: true,
  menu: `${MENU_KEY} type ${MENU_TYPE}`,
  notebookFrames: Object.fromEntries(Object.entries(manifest.notebook.frames).map(([panel, frames]) => [panel, Object.keys(frames).length])),
  itemDefinitions: catalog.itemDefinitionCount,
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
