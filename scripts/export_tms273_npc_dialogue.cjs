#!/usr/bin/env node

// Export the same-version NPC dialogue lines (`Npc.wz/<id>.img/info/speak` +
// `String/Npc.json`).
//
// 阶段二（2026-09-17「地图 NPC 点击对话」）要求把“点了只有占位提示”换成 NPC
// 真正说过的话。源里能承载这件事的只有两张同版表：
//
//   * `Npc.wz/<id>.img/info/speak` —— 一个**有序**列表，值是 `String/Npc.json`
//     里的键名（`n0`、`d0`、`s0`…）。它就是源对“这个 NPC 会说哪些话、按什么
//     顺序说”的权威声明。
//   * `String/Npc.json/<id>` —— 真正的话术文本，前缀分三类：
//       `n*` 地图上的常态台词、`d*` 对话框台词、`s*` 职能短句。
//
// 也就是说：**源的 NPC 对话台词存在，但只存在于这两张表的交叉引用里**。
// 声明在 `Npc.wz` 的 `info/script` 里的 121 个脚本名（`infoArcher`、`talk_lukas`
// …）绝大多数在本包中**没有实体**（只有 8 个能在随附服务端脚本里找到），所以
// 本导出**不碰脚本**，只搬运上面两张表能证明的那部分。
//
// 输出刻意保持最小：有几个 id 就说几句话，没有台词的 id **不出现**在输出里
// （绝不补一句默认台词来凑数），调用方据此把“源里就没台词”与“台词还没接”分开。
//
// 标记：源台词里极少数行带引用标记（实测去重前 614 行里 3 行，全在
// `1010100:d0/d1` 与 `2041022:d1`）。`#p<id>#`、`#m<id>#`、`#t<id>#` 在原版客户端会被
// 替换成对应 NPC / 地图 / 物品的名字，这里照同一语义替换（名字取自同一批源表）；同版表
// 里查不到对应条目时**整个标记删掉**（不是原样保留，也不是只删前缀——只删前缀会在客户端
// 留下一截裸 id，见 `resolveMarkers` 的说明）。颜色/样式标记（`#r`/`#k`/`#b`…）一律不动：
// 那是客户端 `sanitize()` 的职责。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WZ_JSON = path.join(ROOT, '参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW');
const GAMEPLAY = path.join(ROOT, 'shared/gameplay.json');
const OUTPUT = path.join(ROOT, 'shared/npc-dialogue.json');

/** `_value` of a `_dirType`-tagged leaf, or undefined when it carries none. */
function value(node) {
  if (!node || typeof node !== 'object') return undefined;
  return Object.prototype.hasOwnProperty.call(node, '_value') ? node._value : undefined;
}

/** Numeric order for `speak` / line keys (`n0` < `n10`), non-numeric last. */
function keyOrder(key) {
  const digits = /(\d+)$/.exec(key);
  return digits ? Number(digits[1]) : Number.MAX_SAFE_INTEGER;
}

const gameplay = JSON.parse(fs.readFileSync(GAMEPLAY, 'utf8'));
const templates = (gameplay.npcs ?? []).map(npc => String(npc.templateId));
const npcStrings = JSON.parse(fs.readFileSync(path.join(WZ_JSON, 'String/Npc.json'), 'utf8'));

// mapId -> mapName, flattened out of `String/Map.json` (77 groups of
// `{streetName, mapName}` keyed by map id).
const mapNames = new Map();
const mapStrings = JSON.parse(fs.readFileSync(path.join(WZ_JSON, 'String/Map.json'), 'utf8'));
for (const group of Object.values(mapStrings)) {
  if (!group || typeof group !== 'object') continue;
  for (const [mapId, entry] of Object.entries(group)) {
    if (!/^\d+$/.test(mapId)) continue;
    const name = value(entry && entry.mapName);
    if (typeof name === 'string' && name.trim()) mapNames.set(String(Number(mapId)), name.trim());
  }
}

const nameOfNpc = id => value(npcStrings[String(Number(id))]?.name);

// Same-version item names, for the `#t<id>#` references a few lines carry.
const items = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/items.json'), 'utf8'));
const nameOfItem = id => {
  const entry = items[String(Number(id))];
  const name = typeof entry?.name === 'string' ? entry.name : value(entry?.name);
  return typeof name === 'string' && name.trim() ? name.trim() : undefined;
};

/** Resolve the `#p#` / `#m#` / `#t#` references the original client renders as names.
 *
 *  A reference marker is a *render instruction*, not content.  When the same
 *  version tables cannot resolve one (measured: one `#t1012109#` in the whole
 *  265-template set, and that id is in no item table), the marker is dropped
 *  whole rather than left behind — keeping only `#t` stripped would print a raw
 *  id, and `sanitize()` client-side would leave a dangling `1012109#`.
 *  Colour/style markers (`#r`, `#k`, `#b`…) are deliberately untouched: the
 *  client's own `sanitize()` owns those.
 */
function resolveMarkers(text) {
  return text
    .replace(/#p(\d+)#/g, (whole, id) => nameOfNpc(id) ?? '')
    .replace(/#m(\d+)#/g, (whole, id) => mapNames.get(String(Number(id))) ?? '')
    .replace(/#t(\d+)#/g, (whole, id) => nameOfItem(id) ?? '');
}

const lines = id => {
  const entry = npcStrings[String(Number(id))];
  if (!entry || typeof entry !== 'object') return [];
  return Object.keys(entry)
    .filter(key => /^[dns]\d+$/.test(key))
    .sort((a, b) => keyOrder(a) - keyOrder(b));
};

const npcs = {};
let fromSpeak = 0, fromStrings = 0, noLines = 0, repeated = 0, unresolvedRefs = 0;
for (const templateId of templates) {
  const imagePath = path.join(WZ_JSON, 'Npc', `${templateId.padStart(7, '0')}.json`);
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
  const entry = npcStrings[String(Number(templateId))];
  // `info/speak` is the authoritative declaration; when a template has no
  // declaration at all the same table's `d*` lines are the next best evidence
  // (they are the dialogue-shaped ones), then `n*`.
  const keys = declared.length
    ? declared
    : lines(templateId).filter(key => key.startsWith('d')).concat(lines(templateId).filter(key => key.startsWith('n')));
  const origin = declared.length ? 'speak' : 'strings';
  const texts = [];
  for (const key of keys) {
    const raw = value(entry?.[key]);
    if (typeof raw !== 'string') continue;
    const text = resolveMarkers(raw).trim();
    if (!text) continue;
    // The source reuses one sentence across several slots (e.g. 1300007 declares
    // `d0 s0 d1 s1` where `d0`/`s0` and `d1`/`s1` are the same words).  Reading
    // the same line twice in one conversation carries no information, so the
    // order-preserving first occurrence wins; nothing is dropped that the source
    // said only once.
    if (texts.includes(text)) { repeated += 1; continue; }
    if (/#[a-zA-Z]\d+#/.test(text)) unresolvedRefs += 1;
    texts.push(text);
  }
  if (!texts.length) { noLines += 1; continue; }
  if (origin === 'speak') fromSpeak += 1; else fromStrings += 1;
  npcs[templateId] = { origin, lines: texts };
}

const sorted = {};
for (const id of Object.keys(npcs).sort((a, b) => Number(a) - Number(b))) sorted[id] = npcs[id];
fs.writeFileSync(OUTPUT, `${JSON.stringify({
  schemaVersion: 1,
  kind: 'npc-dialogue-zh',
  generatedFrom: 'TMS273 WZ_JSON_TW/Npc/<id>.img/info/speak (order) + WZ_JSON_TW/String/Npc.json (text); #p#/#m# resolved from the same version tables, #t# and colour markers kept verbatim',
  encoding: 'UTF-8',
  npcs: sorted,
}, null, 1)}\n`);
console.log(JSON.stringify({
  templates: templates.length,
  withDialogue: Object.keys(sorted).length,
  fromSpeak,
  fromStrings,
  withoutDialogue: noLines,
  repeatedLinesDropped: repeated,
  unresolvedReferenceMarkers: unresolvedRefs,
  totalLines: Object.values(sorted).reduce((sum, entry) => sum + entry.lines.length, 0),
}));
