#!/usr/bin/env node

// Export the source-backed 怪物收藏 / 物品圖鑑 window (TMS273.7
// `UI/UIWindow4.img/monsterCollection` and `UI/UIWindow4.img/itemCollection`)
// plus the two data trees the collection itself is authored in:
//
//   Etc/mobCollection.img   category -> group -> mob slots, with each group's
//                           own recordID / rewardID / exploration cycle
//   String/MonsterBook.img  per-monster episode text, spawn map ids, rewards
//   Item/**, String/*.json  the definition and the name every authored
//                           `rewardID` resolves to, or the fact that the
//                           client ships no definition for it
//
// Everything is read from the same-version client.  Nothing here invents a
// node name, a probability, a slot count, an item definition or a pixel: an
// element that the source does not author simply does not appear in the
// output, and a reward key with no stat JSON is reported as missing instead of
// being filled in with a default.
//
// Two independent halves are produced, because they have different owners:
//
//   ui      the window shell, its buttons/states, the grade marks, the
//           collection grid furniture and every authored vector the client
//           anchors against.  Owned by the client.
//   source  the normalized collection catalogue (categories, groups, slots,
//           rewards, exploration cycles) plus the per-monster text.  Owned by
//           whoever generates `shared/notebook-catalog.json`, which is why it
//           is written here as raw, unclassified source and never as a
//           display model.
//
// See docs/plan/topics/MapleStory_冒险笔记图鉴_复刻与扩展计划.md §5.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const WZ_JSON = path.join(ROOT, '参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW');
const OUTPUT = path.join(ROOT, 'resources/tms273-export');
const ASSETS = path.join(OUTPUT, 'assets/tms273/notebook');

/// The two source windows.  `monsterCollection` is the original collection
/// window itself (background, tabs, grid, medal/exploration navigation);
/// `itemCollection` is the source's own item encyclopedia, which is where the
/// three new item pages take their category strip from.
const PANELS = {
  monster: 'UI/UIWindow4.img/monsterCollection',
  item: 'UI/UIWindow4.img/itemCollection',
};
/// The button states the source authors.  `notAvailable` is a collection-only
/// fifth state (`button:finalReward` / `btReward`); it is kept because the
/// source really draws it and the reward page must be able to show it.
const STATES = ['normal', 'pressed', 'disabled', 'mouseOver', 'notAvailable'];
/// The menu entry this feature reuses.  `key`/`type` are the machine identity
/// — never the Chinese label, which the localisation layer replaces.
const MENU_KEY = 'menu/buttonInfo/3/6';
const MENU_TYPE = 22;

const reader = createReader(DATA, path.join(OUTPUT, 'ms'));
const exported = new Map();

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/// `_value`-carrying leaves of the unpacked JSON tree, as a plain JS value.
/// Vectors come back as `{x, y}` because that is what the client anchors on.
function jsonValue(node) {
  if (node === null || typeof node !== 'object') return node;
  const type = node._dirType;
  if (type === 'int') return Number(node._value);
  if (type === 'float') return Number(node._value);
  if (type === 'string') return String(node._value);
  if (type === 'vector') return { x: Number(node._x ?? 0), y: Number(node._y ?? 0) };
  return undefined;
}

function jsonChildren(node) {
  return Object.entries(node ?? {}).filter(([key]) => !key.startsWith('_'));
}

/// Flatten a `_dirType`-tagged JSON subtree into `{path: value}` for every
/// leaf that carries a value.  Used for the collection's own data tree, whose
/// numbers are what the rules file is built from.
function flattenJson(node, prefix, out = {}) {
  const value = jsonValue(node);
  if (value !== undefined) {
    out[prefix] = value;
    return out;
  }
  for (const [key, child] of jsonChildren(node)) flattenJson(child, prefix ? `${prefix}/${key}` : key, out);
  return out;
}

function resolved(node) {
  const seen = new Set();
  let current = node;
  while (current instanceof wz.WzUOLProperty) {
    assert(!seen.has(current), `UOL cycle at ${node?.name || '<unnamed>'}`);
    seen.add(current);
    current = current.linkValue;
  }
  return current;
}

async function get(source) {
  try {
    const node = await reader.get(source);
    if (node instanceof wz.WzImage) assert(await node.parseImage(), source);
    return node;
  } catch (error) {
    throw new Error(`${source}: ${error.message}`, { cause: error });
  }
}

async function frame(source) {
  if (!exported.has(source)) {
    const result = await reader.frame(source, ASSETS);
    assert(result.url && result.width > 0 && result.height > 0, `invalid Canvas: ${source}`);
    exported.set(source, { ...result, url: `/assets/tms273/notebook/${result.url}` });
  }
  return exported.get(source);
}

/// Manifest key for one canvas.
///
/// The existing windows key a state frame by `<element>/<state>` and an
/// authored sequence by `<element>/<index>`.  Apply the same rule from the
/// node's own name instead of a per-window table, so a node the source adds
/// later is exported rather than silently dropped: a frame directly under a
/// state directory loses its `0`, everything else keeps its path.
function frameKey(relative) {
  const parts = relative.split('/');
  const parent = parts.at(-2);
  if (parts.at(-1) === '0' && STATES.includes(parent)) return parts.slice(0, -1).join('/');
  return relative;
}

/// Walk one panel and split it into `frames` (every Canvas) and `values`
/// (every int/string/vector leaf).  A node that is neither — a plain
/// structural sub — only contributes its children.
async function exportPanel(source, ui, values) {
  let frames = 0;
  let leaves = 0;
  const walk = async (node, relative) => {
    for (const child of [...(node?.wzProperties ?? [])]) {
      const key = relative ? `${relative}/${child.name}` : child.name;
      if (child instanceof wz.WzCanvasProperty) {
        ui[frameKey(key)] = await frame(`${source}/${key}`);
        frames += 1;
        continue;
      }
      if (child instanceof wz.WzUOLProperty) {
        // A UOL is an authored alias to another node; resolve it and treat the
        // target exactly like a directly authored child.
        await walk(resolved(child), key);
        continue;
      }
      if (child instanceof wz.WzSubProperty) {
        await walk(child, key);
        continue;
      }
      const value = child.wzValue;
      if (value === undefined || value === null) continue;
      values[key] = value instanceof Object && 'x' in value ? { x: Number(value.x), y: Number(value.y) } : value;
      leaves += 1;
    }
  };
  await walk(resolved(await get(source)), '');
  return { frames, leaves };
}

/// `Etc/mobCollection.json` -> the collection's own region/page/row/slot tree.
///
/// The source is authored in four nested levels and each level carries its own
/// reward key:
///
///   <region>            `info.name` 地區, `info.recordID`, `info.rewardID`
///     <page>            `info.name` 分頁 (一般場地 / …), record + reward key
///       group/<row>     `name`, recordID, rewardID, exploraionCycle,
///                       exploraionReward, mob/<slot>
///         mob/<slot>    `type`, `id` (monster template), `tooltip`
///
/// The source authors no entry key of its own, so the stable identity comes
/// from the position an entry already has: `mc-<region>-<page>-<row>-<slot>`.
/// Nothing here interprets a field: `sourceType`, `recordId`, `rewardItemId`
/// and the exploration columns are copied verbatim, and `decl` (present on a
/// few pages only) is kept whole.  The rules generator decides what any of it
/// means; this function never does.
function normalizeCollection() {
  const file = path.join(WZ_JSON, 'Etc/mobCollection.json');
  const raw = readJson(file);
  const meta = {};
  for (const [key, node] of jsonChildren(raw)) {
    const value = jsonValue(node);
    if (value !== undefined) meta[key] = value;
  }
  const number = value => (value === undefined ? null : Number(value));
  const regions = [];
  for (const [regionKey, regionNode] of jsonChildren(raw)) {
    if (!/^\d+$/.test(regionKey)) continue;
    const regionInfo = flattenJson(regionNode.info ?? {}, '');
    const pages = [];
    for (const [pageKey, pageNode] of jsonChildren(regionNode)) {
      if (!/^\d+$/.test(pageKey)) continue;
      const pageInfo = flattenJson(pageNode.info ?? {}, '');
      const rows = [];
      for (const [rowKey, rowNode] of jsonChildren(pageNode.group ?? {})) {
        if (!/^\d+$/.test(rowKey)) continue;
        const rowInfo = flattenJson(rowNode, '');
        const slots = [];
        for (const [slotKey, slotNode] of jsonChildren(rowNode.mob ?? {})) {
          if (!/^\d+$/.test(slotKey)) continue;
          const slot = flattenJson(slotNode, '');
          assert(slot.id !== undefined, `mobCollection slot without an id: ${regionKey}/${pageKey}/${rowKey}/${slotKey}`);
          slots.push({
            entryId: `mc-${regionKey}-${pageKey}-${rowKey}-${slotKey}`,
            slot: Number(slotKey),
            monsterTemplateId: String(Number(slot.id)),
            sourceType: Number(slot.type ?? 0),
            tooltip: slot.tooltip ?? '',
          });
        }
        assert(slots.length > 0, `mobCollection row without slots: ${regionKey}/${pageKey}/${rowKey}`);
        rows.push({
          row: Number(rowKey),
          name: rowInfo.name ?? '',
          recordId: String(rowInfo.recordID ?? ''),
          rewardItemId: number(rowInfo.rewardID) === null ? null : String(number(rowInfo.rewardID)),
          explorationCycleMinutes: number(rowInfo.exploraionCycle),
          explorationRewardSelector: number(rowInfo.exploraionReward),
          slots,
        });
      }
      assert(rows.length > 0, `mobCollection page without rows: ${regionKey}/${pageKey}`);
      pages.push({
        page: Number(pageKey),
        name: pageInfo.name ?? '',
        recordId: String(pageInfo.recordID ?? ''),
        rewardItemId: number(pageInfo.rewardID) === null ? null : String(number(pageInfo.rewardID)),
        // `decl` appears on a minority of pages and is kept verbatim rather
        // than folded into a field of its own.
        decl: pageNode.decl === undefined ? null : flattenJson(pageNode.decl, ''),
        rows,
      });
    }
    assert(pages.length > 0, `mobCollection region without pages: ${regionKey}`);
    regions.push({
      region: Number(regionKey),
      name: regionInfo.name ?? '',
      recordId: String(regionInfo.recordID ?? ''),
      rewardItemId: number(regionInfo.rewardID) === null ? null : String(number(regionInfo.rewardID)),
      pages,
    });
  }
  assert(regions.length > 0, 'mobCollection export is empty');
  return { file: 'Etc/mobCollection.json', meta, regions };
}

/// Same-version `String/*.json` tables consulted for a reward item's text.
///
/// The table belonging to the item's own category is tried first; the rest are
/// fallbacks, because the client ships the same template under several
/// categories and a reward key does not say which table names it.
const STRING_TABLES = ['Consume.json', 'Ins.json', 'Etc.json', 'Cash.json', 'Eqp.json', 'Pet.json'];
const STRING_TABLE_BY_CATEGORY = {
  Consume: 'Consume.json',
  Install: 'Ins.json',
  Etc: 'Etc.json',
  Cash: 'Cash.json',
  Pet: 'Pet.json',
};
/// 7-digit item id family (the first digit of the 8-digit spelling) -> the
/// unpacked tree that holds its stat JSON.  Equipment (family 1) lives under
/// `Character/<group>.img`, every other family under `Item/<category>.img`.
/// Used only to *look for* a reward item's definition; a family that yields
/// nothing is reported as missing rather than guessed at.
const STAT_ROOTS = { 1: ['Character'], 2: ['Item'], 3: ['Item'], 4: ['Item'], 5: ['Item'] };

const statIndexCache = new Map();
const stringTableCache = new Map();

/// `Map<zero-padded file stem, absolute path>` for one unpacked tree.  Built
/// once per root: the reward lookup asks "does the client ship a definition for
/// this id" for a few dozen ids and must not walk 36k files per id.
function statIndex(root) {
  if (!statIndexCache.has(root)) {
    const index = new Map();
    const walk = directory => {
      let entries;
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.name.endsWith('.json') && /^\d+$/.test(entry.name.slice(0, -5))) index.set(entry.name.slice(0, -5), file);
      }
    };
    walk(path.join(WZ_JSON, root));
    statIndexCache.set(root, index);
  }
  return statIndexCache.get(root);
}

function stringTable(file) {
  if (!stringTableCache.has(file)) {
    const target = path.join(WZ_JSON, 'String', file);
    stringTableCache.set(file, fs.existsSync(target) ? readJson(target) : null);
  }
  return stringTableCache.get(file);
}

/// Depth-limited search for an id-keyed node that owns a `name`.
///
/// `String/Consume.json` and `String/Ins.json` key items at the top level,
/// `String/Etc.json` nests them under `Etc` and `String/Eqp.json` under
/// `Eqp/<group>`, so the lookup has to tolerate both shapes.  The depth limit
/// keeps it from wandering into an unrelated record's subtree, and the caller
/// records the exact path so the match stays auditable.
function findItemText(node, keys, depth) {
  if (!node || typeof node !== 'object' || depth < 0) return null;
  for (const key of keys) {
    const hit = node[key];
    if (hit && typeof hit === 'object' && typeof jsonValue(hit.name) === 'string') return { key, node: hit };
  }
  for (const [childKey, child] of Object.entries(node)) {
    if (childKey.startsWith('_') || !child || typeof child !== 'object') continue;
    const hit = findItemText(child, keys, depth - 1);
    if (hit) return { key: `${childKey}/${hit.key}`, node: hit.node };
  }
  return null;
}

/// One reward item's source facts: the stat JSON the client ships (if any),
/// its category, and the name/description the matching `String` table carries.
///
/// This is a *lookup*, not an interpretation: an id the client ships no
/// definition for comes back with `statSource: null` and is never given a
/// default stat block, because the plan forbids fabricating an item.
function resolveRewardItem(itemId) {
  const padded = String(itemId).padStart(8, '0');
  const family = Math.floor(Number(itemId) / 1_000_000);
  let statFile = null;
  for (const root of STAT_ROOTS[family] ?? []) {
    statFile = statIndex(root).get(padded) ?? null;
    if (statFile) break;
  }
  const statSource = statFile ? path.relative(WZ_JSON, statFile).split(path.sep).join('/') : null;
  const category = statSource ? statSource.split('/')[1] : null;
  const keys = [String(itemId), padded];
  const preferred = STRING_TABLE_BY_CATEGORY[category];
  const order = preferred ? [preferred, ...STRING_TABLES.filter(file => file !== preferred)] : STRING_TABLES;
  for (const file of order) {
    const table = stringTable(file);
    if (!table) continue;
    const hit = findItemText(table, keys, 3);
    if (!hit) continue;
    const name = jsonValue(hit.node.name);
    if (typeof name !== 'string' || !name) continue;
    const description = jsonValue(hit.node.desc);
    return {
      itemId: String(itemId),
      category,
      statSource,
      statStatus: statSource ? 'json-present' : 'json-missing',
      name,
      description: typeof description === 'string' && description ? description : null,
      nameSource: `String/${file}#${hit.key}`,
    };
  }
  return {
    itemId: String(itemId),
    category,
    statSource,
    statStatus: statSource ? 'json-present' : 'json-missing',
    name: null,
    description: null,
    nameSource: null,
  };
}

/// Every reward key the collection tree authors, resolved against the client.
///
/// All three levels carry their own `rewardID` and the source never says
/// whether the item is deliverable in *this* build.  Two facts decide that and
/// both are recorded with their exact source: does the client ship a stat JSON,
/// and what does the name say.  `referenceCounts` keeps the reverse mapping
/// (how many rows/pages/regions hand this item out) without copying every key.
function resolveRewardItems(regions) {
  const referenced = new Map();
  const note = (itemId, role) => {
    if (itemId === null || itemId === undefined) return;
    const id = String(Number(itemId));
    if (!referenced.has(id)) referenced.set(id, { row: 0, page: 0, region: 0 });
    referenced.get(id)[role] += 1;
  };
  for (const region of regions) {
    note(region.rewardItemId, 'region');
    for (const page of region.pages) {
      note(page.rewardItemId, 'page');
      for (const row of page.rows) note(row.rewardItemId, 'row');
    }
  }
  const rewards = {};
  for (const id of [...referenced.keys()].sort((a, b) => Number(a) - Number(b))) {
    const counts = referenced.get(id);
    rewards[id] = {
      ...resolveRewardItem(id),
      roles: ['row', 'page', 'region'].filter(role => counts[role] > 0),
      referenceCounts: counts,
    };
  }
  return rewards;
}

/// `String/MonsterBook.json` -> the per-monster text the collection shows.
///
/// Only three fields are facts the server needs: the episode blurb (display
/// only, but it is the source's own wording), the authored spawn maps and the
/// authored reward items.  The raw tree is 1.4 MB, so the normalized form is
/// kept alongside its own count assertion.
function normalizeMonsterText() {
  const file = path.join(WZ_JSON, 'String/MonsterBook.json');
  const raw = readJson(file);
  const monsters = {};
  for (const [id, node] of jsonChildren(raw)) {
    if (!/^\d+$/.test(id)) continue;
    const maps = [];
    for (const [, valueNode] of jsonChildren(node.map ?? {})) {
      const value = jsonValue(valueNode);
      if (value !== undefined) maps.push(String(Number(value)));
    }
    const rewards = [];
    for (const [, valueNode] of jsonChildren(node.reward ?? {})) {
      const value = jsonValue(valueNode);
      if (value !== undefined) rewards.push(String(Number(value)));
    }
    monsters[String(Number(id))] = {
      episode: String(jsonValue(node.episode) ?? ''),
      spawnMapIds: maps,
      rewardItemIds: rewards,
    };
  }
  assert(Object.keys(monsters).length > 400, 'MonsterBook export is stale');
  return { file: 'String/MonsterBook.json', monsters };
}

/// The reused menu entry, re-derived from the source and then checked against
/// the already-assembled menu export.  Re-deriving here would be enough for a
/// config file, but a silent drift between "what the notebook thinks the menu
/// entry is" and "what the menu really renders" is exactly the failure this
/// feature must not have, so the two are compared.
function resolveMenuEntry() {
  const menuFile = path.join(WZ_JSON, 'UI/UITotalMenu.json');
  const menu = readJson(menuFile);
  const columns = menu?.main?.menu?.buttonInfo;
  assert(columns, 'UITotalMenu source has no menu/buttonInfo');
  const [columnKey, rowKey] = MENU_KEY.split('/').slice(-2);
  const node = columns[columnKey]?.[rowKey];
  assert(node, `${MENU_KEY} is absent from the source menu`);
  const type = Number(jsonValue(node.type));
  const label = String(jsonValue(node.info) ?? '');
  assert.equal(type, MENU_TYPE, `${MENU_KEY} type drifted: source ${type}`);
  const windowsFile = path.join(OUTPUT, 'windows.json');
  const windows = readJson(windowsFile);
  const assembled = (windows.totalMenuEntries ?? []).find(entry => entry.key === MENU_KEY);
  assert(assembled, `${MENU_KEY} is absent from the assembled menu export`);
  assert.equal(assembled.type, type, `menu export type mismatch for ${MENU_KEY}`);
  assert.equal(assembled.label, label, `menu export label mismatch for ${MENU_KEY}`);
  return { key: MENU_KEY, type, label, x: assembled.x, y: assembled.y, source: 'UI/UITotalMenu.img/main/menu/buttonInfo' };
}

async function main() {
  fs.mkdirSync(ASSETS, { recursive: true });
  try {
    const frames = {};
    const values = {};
    const counts = {};
    for (const [panel, source] of Object.entries(PANELS)) {
      frames[panel] = {};
      values[panel] = {};
      counts[panel] = await exportPanel(source, frames[panel], values[panel]);
      assert(counts[panel].frames > 0, `${source} exported no Canvas`);
    }
    // The window shell has to be there, or the notebook has nothing to paint.
    for (const required of ['backgrnd', 'button:Close/normal']) {
      assert(frames.monster[required], `monsterCollection is missing ${required}`);
    }
    assert(frames.item.backgrnd, 'itemCollection is missing backgrnd');

    const collection = normalizeCollection();
    const monsterText = normalizeMonsterText();
    const menu = resolveMenuEntry();
    // The three authored reward levels, resolved to the definition and the name
    // the same-version client ships for each key.  The 方塊椅子 family is the
    // bulk of them, and the client's `Item/Install` tree carries no stat JSON
    // for those ids at all; they stay recorded as missing rather than being
    // given a default block.
    const rewardItems = resolveRewardItems(collection.regions);
    collection.rewardItems = rewardItems;

    const slots = collection.regions.reduce((sum, region) => sum + region.pages.reduce((inner, page) => inner + page.rows.reduce((deep, row) => deep + row.slots.length, 0), 0), 0);
    const rows = collection.regions.reduce((sum, region) => sum + region.pages.reduce((inner, page) => inner + page.rows.length, 0), 0);
    const pages = collection.regions.reduce((sum, region) => sum + region.pages.length, 0);
    const sourceAudit = {
      gameVersion: 'TMS273.7',
      menuEntry: menu,
      panels: Object.fromEntries(Object.entries(PANELS).map(([panel, source]) => [panel, {
        source,
        frames: counts[panel].frames,
        values: counts[panel].leaves,
        // The source authors no background for `itemCollection` sub-panels;
        // record what was actually found instead of assuming a full window.
        background: Boolean(frames[panel].backgrnd),
      }])),
      files: {
        'Etc/mobCollection.json': sha256(path.join(WZ_JSON, 'Etc/mobCollection.json')),
        'String/MonsterBook.json': sha256(path.join(WZ_JSON, 'String/MonsterBook.json')),
        'UI/UIWindow4.json': sha256(path.join(WZ_JSON, 'UI/UIWindow4.json')),
        'UI/UITotalMenu.json': sha256(path.join(WZ_JSON, 'UI/UITotalMenu.json')),
      },
      // Evidence grading, spelled out because the rest of the pipeline depends
      // on which half of this file is authoritative (see the plan §3.3).
      evidence: {
        windowNodes: 'T: node names, vectors and every Canvas come from UI/UIWindow4.img in the same client version.',
        menuIdentity: 'T: key/type/label/coords are re-derived from UI/UITotalMenu.img and cross-checked against the assembled menu export.',
        collectionTree: 'T: region/page/row/slot identity, recordID, rewardID, exploration cycle and its reward selector come from Etc/mobCollection.img.',
        monsterText: 'T: episode text, authored spawn maps and authored reward items come from String/MonsterBook.img.',
        rewardResolution: 'T: every authored region/page/row `rewardID` is resolved against the same-version client — the stat JSON found under Item/** or Character/** and the name/description found in String/*.json are recorded together with the exact file each came from, and a key with no stat JSON is recorded as `json-missing` rather than given a default block. U: the source authors no completion condition, quantity or delivery rule for any of the three levels.',
        registrationProbability: 'U: the source ships no registration probability or level/party gate for any slot; nothing is filled in.',
        slotUnlock: 'U: the source ships no exploration slot count, unlock threshold or daily limit.',
        sourceType: 'P: the per-slot `type` field exists in the source and is copied verbatim; its meaning is not established, so it is never used as a condition.',
      },
    };

    const output = {
      contentVersion: 'tms273-notebook',
      source: 'TMS273.7 client WZ / UI/UIWindow4.img (monsterCollection + itemCollection)',
      panels: PANELS,
      states: STATES,
      menu,
      frames,
      values,
      collection,
      monsterText,
      sourceAudit,
    };
    const outputPath = path.join(OUTPUT, 'notebook.json');
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      output: outputPath,
      assets: ASSETS,
      menu: `${menu.key} type ${menu.type}`,
      frames: { monster: counts.monster.frames, item: counts.item.frames },
      values: { monster: counts.monster.leaves, item: counts.item.leaves },
      categories: collection.regions.length,
      pages,
      rows,
      slots,
      monsters: Object.keys(monsterText.monsters).length,
      rewards: {
        total: Object.keys(rewardItems).length,
        withDefinition: Object.values(rewardItems).filter(reward => reward.statStatus === 'json-present').length,
        definitionMissing: Object.values(rewardItems).filter(reward => reward.statStatus === 'json-missing').length,
      },
      pngs: exported.size,
    }, null, 2));
  } finally {
    reader.close();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { DATA, WZ_JSON, OUTPUT, ASSETS, PANELS, STATES, MENU_KEY, MENU_TYPE, main };
