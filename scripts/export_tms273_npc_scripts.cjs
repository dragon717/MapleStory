#!/usr/bin/env node

// Export the **source** npc scripts that ship with the TMS273 package
// (`TMS273/script/npc/<name>.js`) into the runtime's dialogue DSL
// (`shared/npc-scripts.json`).
//
// 为什么需要这一层（根因）
// ----------------------
// `scripts/generate_tms273_gameplay.py` 从设计上**丢弃 `info/script` 引用**（该文件
// 的 `incomplete` 段里明写 "TMS273 NPC dialogue/script references are not
// converted"）。于是哪怕源脚本实体就在包里，运行时看到的仍然只是 `template.script
// = null`，所有 NPC 都落进通用分支。对**传送类** NPC 来说，表现就是「说一句话，然后
// 什么都不发生」——計程車、次元之鏡、怪物公園公車全在这条线上。
//
// 这一层把源脚本接回去，但**只转换能证明的模式**：目的地是字面量 map id（或字面量
// 数组里的元素）、控制流是「说出场白 → 让玩家选目的地 → 确认 → 换图」这一类。不能证明
// 的一律不转换，并写上原因（`shared/npc-scripts.json` 的 `unconverted` 段）。
//
// 为什么目的地要跟目录取交集
// --------------------------
// 源計程車列出 7 个目的地，其中 `103000000 墮落城市`、`105000000 奇幻村`、
// `120000100 上層走廊` **没有装配**。而 `portals.rs::warp_player` 对不在 `self.maps`
// 的目标返回 `false` ⇒ 照抄源脚本会让玩家点了以后收到「傳送未能保存，請稍後重試。」，
// 一句和真实原因（这张图没装配）毫无关系的提示。所以目的地取「源 ∩ 已装配目录」，
// 被排掉的原样记进 `excluded`，供门禁与档案引用；装配新图后重跑本脚本即可让它们回来。
//
// 转换后的形态（见 `server/src/npc.rs` 的 `DialogueNode`）
// -------------------------------------------------------
//   greet   : say(源出场白, kind:"next") → pick
//   pick    : menu(源 prompt 逐字, options = 每个已装配目的地一项)
//             · 每项 text = 源 `#m<id>#` 解析出的地图名（客户端 `sanitize()` 会吃掉
//               `#m`，留下裸 id，所以在这里解析，和阶段二台词表同口径）
//             · 每项 `cond: { mapIsNot: <目的地 id> }` = 源里的
//               `if (taxiMaps[i] != map.getId())`，即「不把玩家脚下这张图列成目的地」
//             · `index` 沿用源数组下标（源自己就是 `"\r\n#L" + i`），所以被排掉的
//               目的地会留下编号空档，与源的行为一致
//   confirm-<i> : ask(源确认句，`#m` 已解析, yes → go-<i>, no → decline)
//   go-<i>  : act { kind: "warp", mapId: <目的地 id> }
//   decline : say(源拒绝句, kind:"ok")
//
// 文案一律**逐字**来自源脚本（含 `\r\n` 与 `#b`/`#k` 这类颜色码——那是客户端
// `sanitize()` 的职责），只有 `#p#`/`#m#` 这两个**渲染指令**按同版表解析成名字。
//
// 产物形状
// --------
//   { schemaVersion, kind, generatedFrom, encoding,
//     npcs:       { <templateId>: <DialogueScript> },   ← 加载器直接反序列化的就是这里
//     provenance: { <templateId>: { source, convertedFrom, excluded[] } },
//     unconverted:{ <templateId>: { source, reason, detail } } }
//
//   `npcs` 的每个值**就是一个脚本**，外面不许再包一层：服务端读它是
//   `BTreeMap<String, npc::DialogueScript>`，多包一层会在启动时以
//   "missing field `start`" 硬失败。产地另放 `provenance`，与 `npc-dialogue.json`
//   的「值是数据本身」保持同构。
//
// id 写法：产物里的 `mapId` / `mapIsNot` 用**目录自己的写法**（`shared/maps.json` 的
// `id` 字段，9 位零填充），因为服务端 `self.maps` 与 `player.map_id` 用的就是它；
// 而 `#m<id>#` 的解析按数值归一化（`String/Map.json` 的键不保证补零）。本项目的目的地
// 恰好都是 9 位，所以两种写法相同，但不要因此假设它们总相同。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WZ_JSON = path.join(ROOT, '参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW');
const NPC_SCRIPTS = path.join(ROOT, '参考/273/TMS273少爷一键端/TMS273/script/npc');
const OUTPUT = path.join(ROOT, 'shared/npc-scripts.json');

/** `_value` of a `_dirType`-tagged leaf, or undefined when it carries none. */
function value(node) {
  if (!node || typeof node !== 'object') return undefined;
  return Object.prototype.hasOwnProperty.call(node, '_value') ? node._value : undefined;
}

/** Turn the escapes of a JS string literal into the characters they stand for. */
function unescapeJs(text) {
  return text.replace(/\\(r|n|t|"|'|\\)/g, (_whole, code) => ({
    r: '\r', n: '\n', t: '\t', '"': '"', "'": "'", '\\': '\\',
  })[code]);
}

const gameplay = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/gameplay.json'), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/maps.json'), 'utf8'));
const npcStrings = JSON.parse(fs.readFileSync(path.join(WZ_JSON, 'String/Npc.json'), 'utf8'));
const mapStrings = JSON.parse(fs.readFileSync(path.join(WZ_JSON, 'String/Map.json'), 'utf8'));

// --- same-version name tables (for `#p#` / `#m#`) ---------------------------
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
function resolveMarkers(text) {
  return text
    .replace(/#p(\d+)#/g, (_whole, id) => nameOfNpc(id) ?? '')
    .replace(/#m(\d+)#/g, (_whole, id) => mapNames.get(String(Number(id))) ?? '');
}

/** normalized numeric id -> the catalog's own 9-digit spelling */
const catalogSpelling = new Map(catalog.maps.map(entry => [String(Number(entry.id)), entry.id]));
const isRendered = id => catalogSpelling.has(String(Number(id)));
const spellingOf = id => catalogSpelling.get(String(Number(id)));

// --- the one supported pattern ---------------------------------------------
/**
 * Convert a source npc script **only** when every piece can be quoted from it.
 *
 * Returns `{ script, excluded, source }` on success, or `{ refused }` with a
 * reason and a human-readable detail.  Deliberately narrow: a general JS
 * interpreter is out of scope, and a guessed dialogue is worse than none.
 */
function convert(source) {
  const refuse = (reason, detail) => ({ refused: { reason, detail } });

  // Every piece this conversion quotes, with its own source-order location:
  const array = /let\s+(\w+)\s*=\s*\[([0-9,\s]+)\]\s*;/.exec(source);
  const guard = /(\w+)\[i\]\s*!=\s*map\.getId\(\)/.exec(source);
  const prompt = /let\s+prompt\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(source);
  const entry = /prompt\s*\+=\s*"((?:[^"\\]|\\.)*)"\s*\+\s*i\s*\+\s*"((?:[^"\\]|\\.)*)"\s*\+\s*(\w+)\[i\]\s*\+\s*"((?:[^"\\]|\\.)*)"/.exec(source);
  const asksMenu = /askMenu\(\s*prompt\s*\)/.test(source);
  const says = [...source.matchAll(/\.say\("((?:[^"\\]|\\.)*)"\)/g)].map(match => match[1]);
  const confirm = /askYesNo\("((?:[^"\\]|\\.)*)"\s*\+\s*(\w+)\[[^\]]*\]\s*\+\s*"((?:[^"\\]|\\.)*)"\)/.exec(source);
  const warp = /changeMap\(\s*(\w+)\[[^\]]*\]/.exec(source);

  // 目的地写死、且没装配 ⇒ 转出来必然在运行时换图失败。先单独认这一类，好在
  // `unconverted` 里说清是「图没装配」而不是「模式不认识」。
  const literalWarp = /changeMap\(\s*(\d+)\s*,/.exec(source);
  if (!array && literalWarp && !isRendered(literalWarp[1])) {
    return refuse(
      'destination-not-rendered',
      `stage.changeMap(${literalWarp[1]}, …) 的目标不在已装配的地图目录里`,
    );
  }
  if (!array || !prompt || !entry || !asksMenu || says.length < 2 || !confirm || !warp || !guard) {
    return refuse(
      'unsupported-pattern',
      '缺少「目的地数组 / prompt / askMenu / 两句 say / 确认句 / 换图」中的一环',
    );
  }
  // 每一环都必须指向同一个数组：东拼西凑会把 A 的名单配到 B 的确认句上。
  const arrayName = array[1];
  if (guard[1] !== arrayName || entry[3] !== arrayName || confirm[2] !== arrayName || warp[1] !== arrayName) {
    return refuse('unsupported-pattern', `目的地数组 ${arrayName} 与别的调用点引用不一致`);
  }
  // 选项文案必须是 `#L<i>##m<id>##l` 拼出来的，否则我们不知道选项上写的是什么。
  if (!entry[1].endsWith('#L') || entry[2] !== '##m' || entry[4] !== '##l') {
    return refuse(
      'unsupported-pattern',
      `菜单项的拼装片段不是 #L<i>##m<id>##l（实测 ${JSON.stringify([entry[1], entry[2], entry[4]])}）`,
    );
  }

  const destinations = array[2].split(',').map(part => part.trim()).filter(Boolean);
  if (destinations.length === 0) return refuse('unsupported-pattern', '目的地数组是空的');
  const kept = [];
  const excluded = [];
  for (const mapId of destinations) {
    if (isRendered(mapId)) kept.push(spellingOf(mapId));
    else {
      excluded.push({
        mapId: String(Number(mapId)),
        name: mapNames.get(String(Number(mapId))) ?? null,
        reason: 'not-rendered',
      });
    }
  }
  if (kept.length === 0) {
    return refuse('destination-not-rendered', '整个目的地数组都不在已装配的地图目录里');
  }

  const confirmHead = unescapeJs(confirm[1]);
  const confirmTail = unescapeJs(confirm[3]);
  const nodes = {
    greet: { say: { text: resolveMarkers(unescapeJs(says[0])), kind: 'next', next: 'pick' } },
  };
  const options = [];
  destinations.forEach((mapId, position) => {
    if (!isRendered(mapId)) return;
    options.push({
      // 源自己用数组下标做标签（`"\r\n#L" + i`），照搬即可；被排掉的目的地因此
      // 会留下编号空档，与源里那条 `if` 的行为一致。
      index: position,
      text: resolveMarkers(`#m${String(Number(mapId))}#`),
      next: `confirm-${position}`,
      cond: { mapIsNot: spellingOf(mapId) },
    });
    nodes[`confirm-${position}`] = {
      ask: {
        text: resolveMarkers(`${confirmHead}${String(Number(mapId))}${confirmTail}`),
        yes: `go-${position}`,
        no: 'decline',
      },
    };
    nodes[`go-${position}`] = { act: { kind: 'warp', mapId: spellingOf(mapId) } };
  });
  nodes.pick = { menu: { text: resolveMarkers(unescapeJs(prompt[1])), options } };
  // 拒绝句是源里 else 分支的那一句（`says` 的最后一条）。
  nodes.decline = { say: { text: resolveMarkers(unescapeJs(says[says.length - 1])), kind: 'ok' } };
  return { script: { start: 'greet', nodes }, excluded, source: arrayName };
}

// --- walk every placed template --------------------------------------------
// `npcs` 的每一个值**就是**一个 `DialogueScript`（与姊妹表 `npc-dialogue.json` 同构），
// 加载器是 `BTreeMap<String, npc::DialogueScript>`；产地信息（源脚本名、被排掉的目的地）
// 另放 `provenance`，不要让脚本外面多包一层——多包一层时加载器会报
// "missing field `start`"，而那是**启动即失败**，不是运行期降级。
const scripts = {};
const provenance = {};
const unconverted = {};
let declared = 0, withEntity = 0, converted = 0;

for (const template of gameplay.npcs) {
  const templateId = String(template.templateId);
  const imagePath = path.join(WZ_JSON, 'Npc', `${templateId.padStart(7, '0')}.json`);
  if (!fs.existsSync(imagePath)) continue;
  const image = JSON.parse(fs.readFileSync(imagePath, 'utf8'));
  const declaration = image.info?.script;
  if (!declaration || typeof declaration !== 'object') continue;
  const names = Object.entries(declaration)
    .filter(([key]) => key !== '_dirType')
    .map(([, node]) => value(node?.script))
    .filter(name => typeof name === 'string' && name);
  if (names.length === 0) continue;
  declared += 1;

  // 源对同一个 NPC 可以声明多个脚本；只要有一个能忠实转换就采用它（顺序即源顺序）。
  let done = false;
  for (const name of names) {
    const file = path.join(NPC_SCRIPTS, `${name}.js`);
    if (!fs.existsSync(file)) continue;
    withEntity += 1;
    const result = convert(fs.readFileSync(file, 'utf8'));
    if (result.script) {
      scripts[templateId] = result.script;
      provenance[templateId] = {
        source: name,
        convertedFrom: `script/npc/${name}.js`,
        excluded: result.excluded,
      };
      converted += 1;
    } else {
      unconverted[templateId] = { source: name, ...result.refused };
    }
    done = true;
    break;
  }
  if (!done) {
    // 声明了脚本名但包里没有实体 —— 与阶段二的结论一致，不造替代。
    unconverted[templateId] = {
      source: names.join(','),
      reason: 'script-entity-missing',
      detail: '源包 script/npc 下没有同名 .js',
    };
  }
}

const sorted = {};
const sortedProvenance = {};
for (const id of Object.keys(scripts).sort((a, b) => Number(a) - Number(b))) {
  sorted[id] = scripts[id];
  sortedProvenance[id] = provenance[id];
}
const sortedRefused = {};
for (const id of Object.keys(unconverted).sort((a, b) => Number(a) - Number(b))) sortedRefused[id] = unconverted[id];

fs.writeFileSync(OUTPUT, `${JSON.stringify({
  schemaVersion: 1,
  kind: 'npc-scripts-zh',
  generatedFrom: 'TMS273/script/npc/<info/script name>.js converted into the runtime dialogue DSL; destinations intersected with shared/maps.json (rendered maps), #p#/#m# resolved from the same version tables',
  encoding: 'UTF-8',
  npcs: sorted,
  provenance: sortedProvenance,
  unconverted: sortedRefused,
}, null, 1)}\n`);

console.log(JSON.stringify({
  templatesDeclaringScript: declared,
  templatesWithScriptEntity: withEntity,
  converted: Object.keys(sorted).length,
  refused: Object.keys(sortedRefused).length,
  convertedIds: Object.keys(sorted),
  refusalReasons: Object.values(sortedRefused).reduce((acc, entry) => {
    acc[entry.reason] = (acc[entry.reason] ?? 0) + 1;
    return acc;
  }, {}),
}));
