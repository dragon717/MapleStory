#!/usr/bin/env node

// 门禁：`shared/npc-scripts.json`（源 NPC 脚本 → 对话 DSL）必须能从**源脚本**逐字复现，
// 且每个传送目标都真的能到达。
//
// 为什么需要它
// ------------
// 服务端验收断言的是自带的 JSON：它证明「表里的计程车脚本能跑通」，证明不了「这份
// 脚本确实来自源」。这一条补后半段——按导出脚本的同一套规则从 `script/npc/*.js`
// 重算一遍，逐字比对。
//
// 更关键的是那条**只有这一层能查**的性质：`portals.rs::warp_player` 对不在
// `self.maps` 里的目标返回 `false`，玩家会收到「傳送未能保存，請稍後重試。」——一句
// 和真实原因（这张图没装配）毫无关系的提示。所以：
//   * 产物里**每一个** `warp` 目标与 `mapIsNot` 都必须是已装配目录里的图；
//   * 源目的地里被排掉的那些必须**原样**记进 `excluded`（漏记＝静默丢目的地）。
//
// 断言分六组：
//   1. 结构：`npcs` 的每个值**就是**一个 `DialogueScript`（与加载器的
//      `BTreeMap<String, DialogueScript>` 对得上）、`provenance` 与 `npcs` 一一对应、
//      `start` 指向存在的节点、所有跳转目标都在表内；
//   2. **逐条重算**：按导出脚本的同一套规则从源 JS 重算 出场白 / prompt / 确认句 /
//      拒绝句 / 目的地清单，与产物逐字比对；
//   3. **越界断言**：产物里任何地图 id 都必须在 `shared/maps.json` 里（这条是主干）；
//   4. 反向断言：源目的地里确实有目录外的（否则取交集是死代码）、也确实有目录内的
//      （否则整条转换都会失效）；`excluded` 必须**恰好**是差集，且不得出现在菜单里；
//   5. `unconverted` 如实登记：与 `npcs` 不相交、缺实体/未装配/模式不支持三类都要有实例，
//      且每条都写明 source 与 reason；
//   6. 接线：服务端真的读它、在与 `template.script` 同一个槽位消费它；装配链会产出它；
//      Windows 清单带它；本门禁已进 `run-checks.mjs`。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WZ_JSON = path.join(ROOT, '参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW');
const NPC_SCRIPTS = path.join(ROOT, '参考/273/TMS273少爷一键端/TMS273/script/npc');

const table = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/npc-scripts.json'), 'utf8'));
const gameplay = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/gameplay.json'), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/maps.json'), 'utf8'));

/** `_value` of a `_dirType`-tagged leaf, or undefined when it carries none. */
const value = node => (node && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, '_value') ? node._value : undefined);
const unescapeJs = text => text.replace(/\\(r|n|t|"|'|\\)/g, (_w, code) => ({ r: '\r', n: '\n', t: '\t', '"': '"', "'": "'", '\\': '\\' })[code]);

// --- 同版名字表（还原 `#p#` / `#m#`），与导出脚本同源但**本文件自己读一遍** --------
const npcStrings = JSON.parse(fs.readFileSync(path.join(WZ_JSON, 'String/Npc.json'), 'utf8'));
const mapStrings = JSON.parse(fs.readFileSync(path.join(WZ_JSON, 'String/Map.json'), 'utf8'));
const mapNames = new Map();
for (const group of Object.values(mapStrings)) {
  if (!group || typeof group !== 'object') continue;
  for (const [mapId, entry] of Object.entries(group)) {
    if (!/^\d+$/.test(mapId)) continue;
    const name = value(entry && entry.mapName);
    if (typeof name === 'string' && name.trim()) mapNames.set(String(Number(mapId)), name.trim());
  }
}
const resolveMarkers = text => text
  .replace(/#p(\d+)#/g, (_w, id) => value(npcStrings[String(Number(id))]?.name) ?? '')
  .replace(/#m(\d+)#/g, (_w, id) => mapNames.get(String(Number(id))) ?? '');

const catalogSpelling = new Map(catalog.maps.map(entry => [String(Number(entry.id)), entry.id]));
const isRendered = id => catalogSpelling.has(String(Number(id)));

const templates = new Set(gameplay.npcs.map(template => String(template.templateId)));

// 1) 结构 --------------------------------------------------------------------
assert.equal(table.schemaVersion, 1, 'npc-scripts.json schemaVersion');
assert.equal(table.kind, 'npc-scripts-zh', 'npc-scripts.json kind');
assert.ok(table.npcs && typeof table.npcs === 'object', 'npc-scripts.json 必须带 npcs');
assert.ok(table.unconverted && typeof table.unconverted === 'object', 'npc-scripts.json 必须带 unconverted');
assert.ok(table.provenance && typeof table.provenance === 'object', 'npc-scripts.json 必须带 provenance');
// 加载器是 `BTreeMap<String, DialogueScript>`：`npcs` 的值必须**就是脚本**，
// 不能是 `{ source, script }` 这样的包装。包一层会在启动时以
// "missing field `start`" 硬失败——不是运行期降级，是服务端起不来。
assert.deepEqual(
  Object.keys(table.provenance).sort(), Object.keys(table.npcs).sort(),
  'provenance 与 npcs 的 id 集合必须一致（产地与脚本一一对应）',
);

/** Every node id a node can jump to, mirroring `npc.rs::DialogueNode::targets`. */
function targetsOf(node) {
  if (node.say) return [node.say.next, node.say.prev].filter(Boolean);
  if (node.ask) return [node.ask.yes, node.ask.no];
  if (node.menu) return (node.menu.options ?? []).map(option => option.next);
  if (node.branch) return [node.branch.then, node.branch.else];
  return [];
}

for (const [templateId, script] of Object.entries(table.npcs)) {
  const where = `npc ${templateId}`;
  assert.ok(templates.has(templateId), `${where} 不是已摆放的模板（产物里有幽灵条目）`);
  const entry = table.provenance[templateId];
  assert.ok(entry, `${where} 缺少 provenance（溯源信息）`);
  assert.equal(typeof entry.source, 'string', `${where} 缺少 source（溯源信息）`);
  assert.equal(
    entry.convertedFrom, `script/npc/${entry.source}.js`,
    `${where} 的 convertedFrom 与 source 对不上`,
  );
  const file = path.join(NPC_SCRIPTS, `${entry.source}.js`);
  assert.ok(fs.existsSync(file), `${where} 声称来自 ${entry.source}.js，但源包里没有这个文件`);
  assert.ok(script && typeof script === 'object', `${where} 缺少 script`);
  assert.ok(script.nodes && script.nodes[script.start], `${where} 的 start 节点不存在`);
  for (const [name, node] of Object.entries(script.nodes)) {
    for (const target of targetsOf(node)) {
      assert.ok(script.nodes[target], `${where} 的节点 ${name} 跳转到不存在的节点 ${target}`);
    }
  }
  assert.ok(Array.isArray(entry.excluded), `${where} 必须带 excluded 数组（哪怕是空的）`);
}

// 2) 逐条重算 ----------------------------------------------------------------
let recomputedDestinations = 0;
for (const [templateId, script] of Object.entries(table.npcs)) {
  const where = `npc ${templateId}`;
  const entry = table.provenance[templateId];
  const source = fs.readFileSync(path.join(NPC_SCRIPTS, `${entry.source}.js`), 'utf8');

  // 目的地清单：源里那个字面量数组，按源顺序。
  const array = /let\s+(\w+)\s*=\s*\[([0-9,\s]+)\]\s*;/.exec(source);
  assert.ok(array, `${where} 的源脚本里找不到目的地数组，转换不该发生`);
  const destinations = array[2].split(',').map(part => part.trim()).filter(Boolean).map(id => String(Number(id)));
  const kept = destinations.filter(isRendered);
  const dropped = destinations.filter(id => !isRendered(id));
  recomputedDestinations += destinations.length;

  // 文案：两句 say（首＝出场白，末＝拒绝句）、prompt、确认句的前后两截。
  const says = [...source.matchAll(/\.say\("((?:[^"\\]|\\.)*)"\)/g)].map(match => match[1]);
  assert.ok(says.length >= 2, `${where} 的源脚本不足两句 say，转换不该发生`);
  const prompt = /let\s+prompt\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(source);
  const confirm = /askYesNo\("((?:[^"\\]|\\.)*)"\s*\+\s*\w+\[[^\]]*\]\s*\+\s*"((?:[^"\\]|\\.)*)"\)/.exec(source);
  assert.ok(prompt && confirm, `${where} 的源脚本没有 prompt/确认句，转换不该发生`);

  const nodes = script.nodes;
  assert.equal(
    nodes.greet.say.text, resolveMarkers(unescapeJs(says[0])),
    `${where} 的出场白与源不一致`,
  );
  assert.equal(nodes.greet.say.next, 'pick', `${where} 的出场白必须接菜单`);
  assert.equal(
    nodes.pick.menu.text, resolveMarkers(unescapeJs(prompt[1])),
    `${where} 的菜单文案与源 prompt 不一致`,
  );
  assert.equal(
    nodes.decline.say.text, resolveMarkers(unescapeJs(says[says.length - 1])),
    `${where} 的拒绝句与源不一致`,
  );

  // 菜单项 = 已装配的目的地，顺序、下标、文案、地图条件、跳转目标都要对得上。
  const options = nodes.pick.menu.options;
  assert.equal(options.length, kept.length, `${where} 的菜单项数与「源 ∩ 目录」不一致`);
  destinations.forEach((mapId, position) => {
    const option = options.find(candidate => candidate.index === position);
    if (!isRendered(mapId)) {
      assert.equal(option, undefined, `${where} 把没装配的 ${mapId} 也列进了菜单`);
      return;
    }
    assert.ok(option, `${where} 漏了目的地 ${mapId}（源数组下标 ${position}）`);
    assert.equal(option.text, resolveMarkers(`#m${mapId}#`), `${where} 的选项文案 ${mapId} 与源不一致`);
    assert.deepEqual(
      option.cond, { mapIsNot: catalogSpelling.get(mapId) },
      `${where} 的 ${mapId} 没有按源规则隐藏「玩家脚下那张图」`,
    );
    const confirmNode = nodes[option.next];
    assert.ok(confirmNode?.ask, `${where} 的选项 ${mapId} 没有指向确认节点`);
    assert.equal(
      confirmNode.ask.text,
      resolveMarkers(`${unescapeJs(confirm[1])}${mapId}${unescapeJs(confirm[2])}`),
      `${where} 的确认句 ${mapId} 与源不一致`,
    );
    assert.equal(confirmNode.ask.no, 'decline', `${where} 的确认句「否」必须回到拒绝句`);
    const go = nodes[confirmNode.ask.yes];
    assert.ok(go?.act, `${where} 的确认句「是」没有指向换图动作`);
    assert.equal(go.act.kind, 'warp', `${where} 的动作不是换图`);
    assert.equal(go.act.mapId, catalogSpelling.get(mapId), `${where} 换图目标 ${mapId} 与源不一致`);
  });

  // 4) 反向断言（逐条）：被排掉的目的地必须**恰好**记进 excluded，且不得出现在菜单里。
  assert.deepEqual(
    entry.excluded.map(item => item.mapId).sort(),
    dropped.map(id => String(Number(id))).sort(),
    `${where} 的 excluded 与「源目的地 − 已装配目录」不一致`,
  );
  for (const item of entry.excluded) {
    assert.equal(item.reason, 'not-rendered', `${where} 的 excluded 条目必须写明原因`);
    assert.ok(item.name, `${where} 的 excluded 条目 ${item.mapId} 应当带上源地图名（否则档案里只有一个裸 id）`);
    assert.ok(
      !options.some(option => option.cond?.mapIsNot === String(Number(item.mapId))),
      `${where} 把被排除的 ${item.mapId} 又做成了菜单项`,
    );
  }
}
assert.ok(
  Object.keys(table.npcs).length > 0,
  '没有任何源脚本被接上：这层存在的意义就是接上它们',
);
assert.ok(recomputedDestinations > 0, '重算出的目的地数为 0，说明解析规则已经和源对不上了');

// 3) 越界断言：产物里出现的每个地图 id 都必须已装配 -----------------------------
//    这是主干：`warp_player` 对目录外的目标返回 false，玩家会收到一句与真实原因无关的
//    「傳送未能保存，請稍後重試。」。任何新的 warp 目标都必须先装配再进这张表。
const playedIds = [];
for (const [templateId, script] of Object.entries(table.npcs)) {
  for (const [name, node] of Object.entries(script.nodes)) {
    if (node.act?.mapId) playedIds.push([templateId, name, 'act.mapId', node.act.mapId]);
    for (const option of node.menu?.options ?? []) {
      if (option.cond?.mapIsNot) playedIds.push([templateId, name, 'cond.mapIsNot', option.cond.mapIsNot]);
    }
  }
}
for (const [templateId, name, field, mapId] of playedIds) {
  assert.ok(
    catalogSpelling.get(String(Number(mapId))) === mapId,
    `npc ${templateId} 的 ${name}.${field} 指向 ${mapId}：它不在已装配的地图目录里，`
      + '玩家点下去只会收到一句「傳送未能保存」。先装配这张图（或把它记进 excluded）。',
  );
}
assert.ok(playedIds.length > 0, '产物里没有任何地图跳转：检查是不是被整段过滤掉了');

// 5) unconverted 如实登记 ------------------------------------------------------
const convertedIds = new Set(Object.keys(table.npcs));
for (const [templateId, entry] of Object.entries(table.unconverted)) {
  assert.ok(!convertedIds.has(templateId), `${templateId} 同时出现在 npcs 与 unconverted 里`);
  assert.ok(typeof entry.source === 'string' && entry.source, `${templateId} 的 unconverted 缺少 source`);
  assert.ok(typeof entry.reason === 'string' && entry.reason, `${templateId} 的 unconverted 缺少 reason`);
  assert.ok(typeof entry.detail === 'string' && entry.detail, `${templateId} 的 unconverted 缺少 detail（要能看懂为什么没接）`);
}
const reasons = Object.values(table.unconverted).reduce((acc, entry) => {
  acc[entry.reason] = (acc[entry.reason] ?? 0) + 1;
  return acc;
}, {});
for (const reason of ['script-entity-missing', 'unsupported-pattern', 'destination-not-rendered']) {
  assert.ok(
    (reasons[reason] ?? 0) > 0,
    `unconverted 里没有 ${reason} 类实例：要么这一类真的消失了（该更新门禁），要么分类逻辑坏了`,
  );
}
// 声明了脚本、且实体存在的那几个 NPC，必须**明确**落在「已转换」或「已写明原因」之一。
let declaredWithEntity = 0;
for (const template of gameplay.npcs) {
  const templateId = String(template.templateId);
  const imagePath = path.join(WZ_JSON, 'Npc', `${templateId.padStart(7, '0')}.json`);
  if (!fs.existsSync(imagePath)) continue;
  const declaration = JSON.parse(fs.readFileSync(imagePath, 'utf8')).info?.script;
  if (!declaration || typeof declaration !== 'object') continue;
  const names = Object.entries(declaration)
    .filter(([key]) => key !== '_dirType')
    .map(([, node]) => value(node?.script))
    .filter(name => typeof name === 'string' && name);
  const withEntity = names.filter(name => fs.existsSync(path.join(NPC_SCRIPTS, `${name}.js`)));
  if (withEntity.length === 0) continue;
  declaredWithEntity += 1;
  assert.ok(
    convertedIds.has(templateId) || table.unconverted[templateId],
    `npc ${templateId} 的源脚本实体（${withEntity.join(',')}）既没被转换也没写明原因：静默丢弃`,
  );
}
assert.ok(declaredWithEntity > 0, '没有任何已摆放模板的 info/script 能在源包里找到实体，门禁失去意义');

// 6) 接线 ---------------------------------------------------------------------
const readRepo = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const mainRs = readRepo('server/src/main.rs');
assert.ok(mainRs.includes('shared/npc-scripts.json'), 'server/src/main.rs 没有加载 shared/npc-scripts.json');
// 加载器把 `npcs` 的值当**脚本本身**读。这条钉住形状契约：一旦有人在 JSON 外面多包
// 一层（`{source, script}`），启动会以 "missing field `start`" 硬失败。
assert.ok(
  mainRs.includes('BTreeMap<String, npc::DialogueScript>'),
  'server/src/main.rs 的源脚本加载类型不再是 BTreeMap<String, DialogueScript>：'
    + '产物形状与加载器对不上了（包一层会让服务端起不来）',
);
assert.ok(mainRs.includes('.with_npc_scripts('), 'server/src/main.rs 没有把源脚本注入 World：表成了死数据');
const dialogueRs = readRepo('server/src/dialogue.rs');
assert.ok(
  dialogueRs.includes('self.npc_scripts.get(&template_id)'),
  'server/src/dialogue.rs 没有在与 template.script 同一个槽位读源脚本：計程車仍然只会说一句话',
);
assert.ok(
  dialogueRs.includes('template.script.clone().or(source_script)'),
  'server/src/dialogue.rs 的优先级变了：模板自带 DSL 必须优先于源脚本',
);
assert.ok(
  readRepo('scripts/build_tms273.cjs').includes('export_tms273_npc_scripts.cjs'),
  'scripts/build_tms273.cjs 没有跑源脚本导出：装配后这张表会过期',
);
assert.ok(
  readRepo('scripts/check_windows_resources.cjs').includes('shared/npc-scripts.json'),
  'scripts/check_windows_resources.cjs 没带这张表：Windows 包里的服务端会因为读不到它而启动失败',
);
assert.ok(
  readRepo('client/scripts/run-checks.mjs').includes('check_tms273_npc_scripts.cjs'),
  'client/scripts/run-checks.mjs 没挂上本门禁',
);

console.log(
  `Source npc scripts: ${Object.keys(table.npcs).length} converted `
  + `(${Object.keys(table.npcs).join(', ')}), ${playedIds.length} map references all rendered, `
  + `${Object.values(table.unconverted).length} templates refused `
  + `(${Object.entries(reasons).map(([reason, count]) => `${reason}:${count}`).join(' ')}); `
  + 'every destination recomputed verbatim from script/npc/*.js.',
);
