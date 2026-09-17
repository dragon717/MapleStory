#!/usr/bin/env node

// 门禁：`shared/npc-dialogue.json`（NPC 台词表）必须能从源逐字复现，且接线到位。
//
// 阶段二（2026-09-17「地图 NPC 点击对话」）让无脚本的 NPC 说出源里的话。这条链路上
// 任何一环断掉都会**静默降级**成全地图铺占位提示，而服务端验收是对自带的 JSON 断言
// 的——它证明「表里的台词能被说出来」，证明不了「表里的台词确实来自源」。这一条补上
// 后半段：把整张表按导出脚本的同一套规则从源重算一遍，逐字比对。
//
// 断言分五组：
//   1. 表本身的结构与内容（每个条目非空、无重复行、没有未解析的引用标记）；
//   2. **逐条重算**：`Npc.wz/<id>.img/info/speak` 的顺序 + `String/Npc.json` 的文本
//      （`#p#`/`#m#`/`#t#` 按同版表还原），去重规则与导出脚本一致；
//   3. 反向断言：源里确实有一批模板没有说话内容（否则这张表就是"全给默认值"），
//      且表里的 id 全部是已摆放模板（不许多余条目）；
//   4. 接线：服务端真的读它、注入它、在无脚本分支用它；装配链会产出它；Windows
//      资源清单带它（少了它服务端会硬失败起不来）。
//   5. 占位链路成对：`placeholder` 是「服务端标记 + 客户端消费者」的一对，且两侧
//      文案与 `shared/protocol.ts` 的声明互相对得上。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WZ_JSON = path.join(ROOT, '参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW');

const table = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/npc-dialogue.json'), 'utf8'));
const gameplay = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/gameplay.json'), 'utf8'));
const npcStrings = JSON.parse(fs.readFileSync(path.join(WZ_JSON, 'String/Npc.json'), 'utf8'));
const mapStrings = JSON.parse(fs.readFileSync(path.join(WZ_JSON, 'String/Map.json'), 'utf8'));
const items = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/items.json'), 'utf8'));

/** `_value` of a `_dirType`-tagged leaf, or undefined when it carries none. */
function value(node) {
  if (!node || typeof node !== 'object') return undefined;
  return Object.prototype.hasOwnProperty.call(node, '_value') ? node._value : undefined;
}

function keyOrder(key) {
  const digits = /(\d+)$/.exec(key);
  return digits ? Number(digits[1]) : Number.MAX_SAFE_INTEGER;
}

// 与 `scripts/export_tms273_npc_dialogue.cjs` 逐字相同的还原规则。
const mapNames = new Map();
for (const group of Object.values(mapStrings)) {
  if (!group || typeof group !== 'object') continue;
  for (const [mapId, entry] of Object.entries(group)) {
    if (!/^\d+$/.test(mapId)) continue;
    const name = value(entry && entry.mapName);
    if (typeof name === 'string' && name.trim()) mapNames.set(String(Number(mapId)), name.trim());
  }
}
const nameOfNpc = id => value(npcStrings[String(Number(id))]?.name);
const nameOfItem = id => {
  const entry = items[String(Number(id))];
  const name = typeof entry?.name === 'string' ? entry.name : value(entry?.name);
  return typeof name === 'string' && name.trim() ? name.trim() : undefined;
};
function resolveMarkers(text) {
  return text
    .replace(/#p(\d+)#/g, (whole, id) => nameOfNpc(id) ?? '')
    .replace(/#m(\d+)#/g, (whole, id) => mapNames.get(String(Number(id))) ?? '')
    .replace(/#t(\d+)#/g, (whole, id) => nameOfItem(id) ?? '');
}
function linesOf(id) {
  const entry = npcStrings[String(Number(id))];
  if (!entry || typeof entry !== 'object') return [];
  return Object.keys(entry)
    .filter(key => /^[dns]\d+$/.test(key))
    .sort((a, b) => keyOrder(a) - keyOrder(b));
}

/** 按导出脚本的规则从源重算一个模板的台词（`lines` 为空＝源里没有说话内容）。 */
function recompute(id) {
  const imagePath = path.join(WZ_JSON, 'Npc', `${id.padStart(7, '0')}.json`);
  let declared = [];
  if (fs.existsSync(imagePath)) {
    const image = JSON.parse(fs.readFileSync(imagePath, 'utf8'));
    const speak = image.info?.speak;
    if (speak && typeof speak === 'object') {
      declared = Object.entries(speak)
        .filter(([key]) => key !== '_dirType')
        .sort((a, b) => keyOrder(a[0]) - keyOrder(b[0]))
        .map(([, node]) => String(value(node)))
        .filter(key => key && key !== 'undefined');
    }
  }
  const entryStrings = npcStrings[String(Number(id))];
  const keys = declared.length
    ? declared
    : linesOf(id).filter(key => key.startsWith('d')).concat(linesOf(id).filter(key => key.startsWith('n')));
  const lines = [];
  for (const key of keys) {
    const raw = value(entryStrings?.[key]);
    if (typeof raw !== 'string') continue;
    const text = resolveMarkers(raw).trim();
    if (!text || lines.includes(text)) continue;
    lines.push(text);
  }
  return { origin: declared.length ? 'speak' : 'strings', lines };
}

// 1) 表结构 + 2) 逐条重算。
assert.equal(table.schemaVersion, 1, 'npc-dialogue.json schemaVersion');
assert.equal(table.kind, 'npc-dialogue-zh', 'npc-dialogue.json kind');
assert.ok(table.npcs && typeof table.npcs === 'object', 'npc-dialogue.json must carry an npcs map');

const templates = (gameplay.npcs ?? []).map(template => String(template.templateId));
for (const id of Object.keys(table.npcs)) {
  assert.ok(
    templates.includes(id),
    `npc ${id} 在台词表里，但不是已摆放的 NPC 模板（多余的条目）`,
  );
}

let fromSpeak = 0, fromStrings = 0, withDialogue = 0, totalLines = 0;
const withoutDialogue = [];
// 遍历**全部模板**而不是只遍历表里的条目：这样「源里有台词但导出漏了」也会失败
// （只遍历表的话，漏掉的模板会被当成『源里没有说话内容』静默放过，而服务端那边
// 的表现正好是退回占位提示——与真的没有说话内容长得一模一样）。
for (const id of templates) {
  const where = `npc ${id}`;
  const expected = recompute(id);
  const entry = table.npcs[id];
  if (expected.lines.length === 0) {
    assert.equal(
      entry, undefined,
      `${where} 源里没有说话内容，台词表里却有条目（导出在补默认值）`,
    );
    withoutDialogue.push(id);
    continue;
  }
  assert.ok(
    entry,
    `${where} 源里有 ${expected.lines.length} 句台词，台词表里却没有：导出漏了模板`
      + `（服务端上表现为退回占位提示）`,
  );
  assert.ok(Array.isArray(entry.lines) && entry.lines.length > 0, `${where} 的台词不能为空`);
  assert.equal(
    new Set(entry.lines).size, entry.lines.length,
    `${where} 有重复台词：导出侧的去重规则失效`,
  );
  for (const line of entry.lines) {
    assert.equal(typeof line, 'string', `${where} 的台词必须是字符串`);
    assert.ok(line.trim().length > 0, `${where} 有空台词行`);
    assert.ok(
      !/#[a-zA-Z]\d+#/.test(line),
      `${where} 还有没被还原的引用标记：${JSON.stringify(line.slice(0, 60))}`,
    );
  }
  assert.deepEqual(entry.lines, expected.lines, `${where} 的台词与源不一致（逐字重算失败）`);
  assert.equal(entry.origin, expected.origin, `${where} 的 origin 与源声明的来源不一致`);
  if (expected.origin === 'speak') fromSpeak += 1; else fromStrings += 1;
  withDialogue += 1;
  totalLines += entry.lines.length;
}

// 3) 反向断言。
assert.ok(
  withoutDialogue.length > 0,
  '每个已摆放模板都有台词：源里不是这样，导出一定在补默认值',
);
assert.ok(
  withDialogue > templates.length / 2,
  `有台词的模板只有 ${withDialogue}/${templates.length}：导出可能被截断`,
);
assert.ok(
  fromSpeak > 0 && fromStrings > 0,
  `两种来源都要有实例（speak=${fromSpeak} strings=${fromStrings}），否则一条分支是死代码`,
);

// 4) 接线：任何一环断掉都会让整张表回到占位提示而门禁其它段全绿。
const readRepo = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const mainRs = readRepo('server/src/main.rs');
assert.ok(
  mainRs.includes('shared/npc-dialogue.json'),
  'server/src/main.rs 没有加载 shared/npc-dialogue.json：表不会被读到',
);
assert.ok(
  mainRs.includes('.with_npc_dialogue('),
  'server/src/main.rs 没有把台词表注入 World：服务端仍会铺占位提示',
);
const dialogueRs = readRepo('server/src/dialogue.rs');
assert.ok(
  dialogueRs.includes('open_npc_lines') && dialogueRs.includes('advance_npc_lines'),
  'server/src/dialogue.rs 不再推进源台词页：接进来的表成了死数据',
);
const npcRs = readRepo('server/src/npc.rs');
assert.ok(
  npcRs.includes('shared/npc-dialogue.json'),
  'server/src/npc.rs 的 NpcDialogue 没有写明它来自哪个文件：溯源信息丢失',
);
assert.ok(
  readRepo('scripts/build_tms273.cjs').includes('export_tms273_npc_dialogue.cjs'),
  'scripts/build_tms273.cjs 没有跑台词导出：装配后这张表会过期',
);
assert.ok(
  readRepo('scripts/check_windows_resources.cjs').includes('shared/npc-dialogue.json'),
  'scripts/check_windows_resources.cjs 没带这张表：Windows 包里的服务端会因为读不到它而启动失败',
);

// 5) 占位链路成对。`placeholder` 是「服务端发标记 + 客户端消费标记」的一对，而它只
//    影响样式与门禁分类——删掉任何一侧都不会让任何一条测试失败（服务端照旧发标记、
//    客户端静默不标记；或者反过来），表现上却是「源里没话说的 NPC 被当成本人台词」
//    或「服务端发了客户端不认的字段」。阶段二**没有**删它（含义从「还没接」收窄成
//    「源里没有说话内容」），所以这一对必须继续成对存在。
assert.ok(
  npcRs.includes('pub const PLACEHOLDER_DIALOGUE'),
  'server/src/npc.rs 不再发占位标记：源里没有说话内容的 NPC 会被当成本人台词',
);
assert.ok(
  readRepo('shared/protocol.ts').includes("source?: 'placeholder'"),
  'shared/protocol.ts 不再声明 dialog.source：服务端发的占位标记超出协议',
);
assert.ok(
  readRepo('client/src/features/npc/dialogue.ts').includes("is-placeholder"),
  'client/src/features/npc/dialogue.ts 不再消费占位标记：占位提示会被当成本人台词渲染',
);

// 文案本身也要钉：`placeholder_view` 里有个 `lang == LANG_EN` 分支，两条都空或者两条
// 同值的话英文客户端会看到中文（或什么都看不到），而单侧测试照样全绿。
const placeholderZh = /const PLACEHOLDER_TEXT_ZH: &str = "([^"]*)"/.exec(npcRs)?.[1];
const placeholderEn = /const PLACEHOLDER_TEXT_EN: &str = "([^"]*)"/.exec(npcRs)?.[1];
assert.ok(
  placeholderZh && placeholderZh.trim().length > 0,
  'server/src/npc.rs 的 PLACEHOLDER_TEXT_ZH 读不到或为空',
);
assert.ok(
  placeholderEn && placeholderEn.trim().length > 0,
  'server/src/npc.rs 的 PLACEHOLDER_TEXT_EN 读不到或为空',
);
assert.notEqual(
  placeholderZh, placeholderEn,
  '占位文案的简/英两条同值：`lang=en` 分支成了摆设',
);
assert.ok(
  /PLACEHOLDER_TEXT_EN/.test(npcRs.slice(npcRs.indexOf('pub fn placeholder_view'))),
  'placeholder_view 不再引用 PLACEHOLDER_TEXT_EN：英文常量成了死代码',
);

console.log(
  `NPC dialogue table: ${withDialogue}/${templates.length} templates carry source lines `
  + `(${fromSpeak} from info/speak, ${fromStrings} from String/Npc.json), ${totalLines} lines, `
  + `${withoutDialogue.length} templates have no dialogue in the source; every entry recomputed verbatim.`,
);
