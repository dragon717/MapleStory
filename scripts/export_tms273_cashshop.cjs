#!/usr/bin/env node

// Export the TMS273 cash shop (現金商店) from the client WZ.
//
// Sources, all TMS273.7:
//   - `Etc/Commodity.img`         the commodity table (SN, ItemId, Count,
//                                 Price, Period, Gender, OnSale, …).  Only
//                                 `OnSale: 1` rows are shipped; the rest of
//                                 the 12k rows are expired SKUs, 楓點/楓幣
//                                 recharge SKUs (SN 900/910) and coupon
//                                 catalogs (SN 800) the local build cannot
//                                 honor.
//   - `UI/CashShop.img`           the window art: the 1024x768 shell, the
//                                 11 sidebar tab sprites (each bakes the
//                                 whole sidebar with one row highlighted),
//                                 the exit / buy / magnifier buttons.
//   - `String/{Cash,Pet,Consume,Eqp}.img` the zh display names.
//   - `Item/...`, `Character/...` the per-item info/icon canvases.
//
// Category assignment is *derived*, and recorded as P in
// `gameplay.compatibility.cashShop` (see assemble): the WZ does not carry a
// per-commodity tab field, so the main tab is decided from the SN group
// (9-digit prefixes) plus an item-family fallback for the mixed SN groups.
// The 10 sidebar labels themselves are source art (主頁/活動/轉蛋/強化/遊戲/
// 美容/時裝/寵物/套組/搜尋結果); tabs without shippable data are simply not
// clickable.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const wz = require('@tybys/wz');
const { PNG } = require('pngjs');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const IMAGE_ROOT = path.join(ROOT, 'resources/tms273-export/ms');
const OUTPUT = path.join(ROOT, 'resources/tms273-export');
const ASSETS = path.join(OUTPUT, 'assets/tms273');
const ASSET_PREFIX = '/assets/tms273/';
const CASHSHOP = 'UI/CashShop.img';
const COMMODITY = 'Etc/Commodity.img';

// The client advertises these 9111xxx service rows as inventory expansion
// products.  The local server already implements the corresponding 2430xxx
// coupons, so the shop sells the coupon while retaining the source SN and
// ItemId for auditability.  9110002 expands a warehouse tab that this build
// does not expose, therefore it remains in `excluded` with its source row.
const DELIVERY_MAPPINGS = Object.freeze({
  '09111001': { deliveryItemId: '02430768', deliveryRule: 'P: deliver local equipment-tab expansion coupon (8 slots)' },
  '09112001': { deliveryItemId: '02430769', deliveryRule: 'P: deliver local consume-tab expansion coupon (8 slots)' },
  '09113002': { deliveryItemId: '02430770', deliveryRule: 'P: deliver local decorate-tab expansion coupon (8 slots)' },
  '09114001': { deliveryItemId: '02430771', deliveryRule: 'P: deliver local other-tab expansion coupon (8 slots)' },
});
const UNSUPPORTED_SOURCE_ITEMS = Object.freeze({
  '09110002': {
    reason: 'unsupported-local-effect',
    detail: 'Source expands warehouse slots, but the local inventory has no warehouse tab/effect.',
  },
});

// ---------------------------------------------------------------- categories

// Main tabs, in sidebar order.  `label` is display only (the sprite carries
// the real art); `sprite` is the CashShop.img/CSTab/Tab index whose sidebar
// highlights exactly this row (verified by opening every sprite).
const TABS = [
  { id: 'home', label: '主頁', sprite: 0 },
  { id: 'event', label: '活動', sprite: 2 },
  { id: 'gacha', label: '轉蛋', sprite: 3 },
  { id: 'enhance', label: '強化', sprite: 4 },
  { id: 'game', label: '遊戲', sprite: 5 },
  { id: 'beauty', label: '美容', sprite: 6 },
  { id: 'fashion', label: '時裝', sprite: 7 },
  { id: 'pet', label: '寵物', sprite: 8 },
];
const TAB_IDS = new Set(TABS.map(tab => tab.id));

// 時裝 sub-tabs by equip family (3-digit id prefix / 10000).  Order follows
// the character's equip flow rather than the raw id order, matching how the
// original shop splits 服裝.
const FASHION_SUBS = [
  { id: 'all', label: '全部', families: null },
  { id: 'cap', label: '帽子', families: [100] },
  { id: 'face', label: '臉飾', families: [101, 102, 103] },
  { id: 'overall', label: '連身衣', families: [105] },
  { id: 'coat', label: '上衣', families: [104] },
  { id: 'pants', label: '褲／裙', families: [106] },
  { id: 'shoes', label: '鞋子', families: [107] },
  { id: 'glove', label: '手套', families: [108] },
  { id: 'cape', label: '披風／飾品', families: [109, 110, 111, 112, 113, 116, 118, 120, 160] },
  { id: 'weapon', label: '武器', families: [170] },
];

// Item-family → main tab for the mixed SN groups (180/181/920) whose rows
// span cash consumables, equips and gacha baskets.
const FAMILY_TAB = [
  { test: p => p === 553, tab: 'gacha' },
  { test: p => p === 506, tab: 'enhance' },
  { test: p => p === 500 || p === 519 || p === 524 || p === 180, tab: 'pet' },
  { test: p => p === 501 || p === 502 || p === 515 || p === 516 || p === 517, tab: 'beauty' },
  { test: p => p >= 100 && p <= 199, tab: 'fashion' },
  { test: p => p >= 300 && p <= 399 || p === 910, tab: 'game' },
  { test: p => p >= 501 && p <= 599, tab: 'game' },
];

// SN group (first 3 digits of the 9-digit SN) → main tab.  Mixed groups fall
// through to the family table above.
function mainTabFor(sn, itemId) {
  const group = Math.floor(sn / 1000000);
  if (group === 110) return 'home';
  if (group >= 120 && group <= 150) return 'event';
  if (group === 190) return 'event';
  if (group === 160 || group === 161) return 'fashion';
  if (group === 170) return 'pet';
  if (group === 800) return 'game';
  const prefix = familyOf(itemId);
  for (const rule of FAMILY_TAB) if (rule.test(prefix)) return rule.tab;
  return 'game';
}

/** 3-digit equip family, or the leading digits for the flat cash families. */
function familyOf(itemId) {
  // TMS item families are the first three digits for every catalog: 100xxx
  // equipment, 500xxx pets/cash items, 910xxx special bundles, and so on.
  // Dividing the latter by 100000 silently turned 500 into 50 and 910 into
  // 91, which sent both tab inference and icon lookup down the wrong branch.
  return Math.floor(Number(itemId) / 10000);
}

// ------------------------------------------------------------------- icons

/**
 * Normalize one `reader.frame` result the same way `export_tms273.cjs`
 * `frameFrom` does: the PNG lives under `resources/tms273-export/assets/tms273`
 * and every JSON consumer speaks the runtime URL form `/assets/tms273/…`.
 * A bare hashed filename here would fail assemble's asset audit.
 */
function withAssetUrl(frame) {
  return frame && !frame.url.startsWith(ASSET_PREFIX)
    ? { ...frame, url: ASSET_PREFIX + frame.url }
    : frame;
}

/** Client WZ `info/icon` path candidates for one item id, in priority order.
 *  Equip node names are the 8-digit padded id; the Item packs (Cash, Pet,
 *  Special, Install) name their nodes without leading zeros. */
function iconCandidates(itemId) {
  const numericId = Number(itemId);
  const id = String(numericId).padStart(8, '0');
  const raw = String(numericId);
  const p3 = familyOf(numericId);
  const paths = [];
  if (numericId < 2000000) {
    const dirs = {
      100: 'Character/Cap', 101: 'Character/Accessory', 102: 'Character/Accessory',
      103: 'Character/Accessory', 104: 'Character/Coat', 105: 'Character/Longcoat',
      106: 'Character/Pants', 107: 'Character/Shoes', 108: 'Character/Glove',
      109: 'Character/Shield', 110: 'Character/Cape', 111: 'Character/Accessory',
      112: 'Character/Accessory', 113: 'Character/Accessory', 116: 'Character/Accessory',
      118: 'Character/Accessory', 120: 'Character/Accessory', 160: 'Character/Cape',
      134: 'Character/Weapon', 170: 'Character/Weapon', 180: 'Character/PetEquip', 190: 'Character/PetEquip',
      194: 'Character/PetEquip',
    };
    const dir = dirs[p3];
    if (dir) {
      paths.push(`${dir}/${id}.img/info/icon`, `${dir}/${id}.img/info/iconRaw`);
    }
  } else if (numericId >= 2000000 && numericId < 3000000) {
    // Expansion and other consumable coupons use the four-digit Item pack and
    // an eight-digit node under it (e.g. Item/Consume/0243.img/02430768).
    const pack = id.slice(0, 4);
    for (const key of new Set([id, raw])) {
      paths.push(`Item/Consume/${pack}.img/${key}/info/icon`, `Item/Consume/${pack}.img/${key}/info/iconRaw`);
    }
  } else if (numericId >= 5000000 && numericId < 5100000 && p3 === 500) {
    // 真正的寵物 (500xxxx) live in Item/Pet/<raw>.img.  This is a separate
    // image per pet, not the Item/Pet/0500.img pack used by old exporters.
    for (const key of new Set([raw, id])) {
      paths.push(`Item/Pet/${key}.img/info/icon`, `Item/Pet/${key}.img/info/iconRaw`, `Item/Pet/${key}.img/icon`);
    }
  } else if (numericId >= 5000000 && numericId < 6000000) {
    // 现金消耗/兑换道具 live in Item/Cash/<0501..05xx>.img.
    const pack = id.slice(0, 4);
    for (const key of new Set([id, raw])) {
      paths.push(`Item/Cash/${pack}.img/${key}/info/icon`, `Item/Cash/${pack}.img/${key}/icon`);
    }
  } else if (numericId >= 3000000 && numericId < 4000000) {
    // 傷害皮膚 / 安裝類 in Item/Special or Item/Install.
    const pack = id.slice(0, 4);
    for (const key of new Set([raw, id])) {
      paths.push(`Item/Special/${pack}.img/${key}/info/icon`, `Item/Special/${pack}.img/${key}/icon`, `Item/Install/${pack}.img/${key}/icon`);
    }
  } else if (numericId >= 9000000) {
    const pack = id.slice(0, 4);
    for (const key of new Set([raw, id])) {
      paths.push(`Item/Special/${pack}.img/${key}/icon`, `Item/Special/${pack}.img/${key}/info/icon`, `Item/Cash/${pack}.img/${key}/icon`);
    }
  }
  return paths;
}

// -------------------------------------------------------------------- names

const EQUIP_STRING_DIRS = {
  100: 'Cap', 101: 'Accessory', 102: 'Accessory', 103: 'Accessory', 104: 'Coat',
  105: 'Longcoat', 106: 'Pants', 107: 'Shoes', 108: 'Glove', 109: 'Shield',
  110: 'Cape', 111: 'Accessory', 112: 'Accessory', 113: 'Accessory', 116: 'Accessory',
  118: 'Accessory', 120: 'Accessory', 134: 'Weapon', 160: 'Cape', 170: 'Weapon', 180: 'PetEquip',
  190: 'TamingMob', 194: 'PetEquip',
};
function atPath(node, source) {
  let current = node;
  for (const segment of String(source).split('/')) {
    if (!segment) continue;
    current = current?.at?.(segment) ?? null;
    if (!current) return null;
  }
  return current;
}

function itemIdForms(itemId) {
  const numericId = Number(itemId);
  return { numericId, id: String(numericId).padStart(8, '0'), raw: String(numericId) };
}

function stringPathFor(table, itemId) {
  const { numericId, raw } = itemIdForms(itemId);
  if (table === 'Eqp') {
    const family = familyOf(numericId);
    const dir = EQUIP_STRING_DIRS[family];
    return dir ? `Eqp/${dir}/${raw}` : null;
  }
  return raw;
}

function textField(tables, table, itemId, field) {
  const root = tables[table];
  const key = stringPathFor(table, itemId);
  const value = key ? atPath(root, `${key}/${field}`)?.wzValue : null;
  return typeof value === 'string' && value.length ? value : null;
}

/** Resolve the zh display name through the String tables.  The Eqp table
 *  nests its rows under Eqp/per-family folders and keys the raw id;
 *  every other table keys the plain unpadded id. */
function nameOf(tables, itemId) {
  const numericId = Number(itemId);
  if (numericId < 2000000) {
    const equipmentName = textField(tables, 'Eqp', numericId, 'name');
    if (equipmentName) return equipmentName;
  }
  for (const table of ['Cash', 'Consume', 'Ins', 'Pet']) {
    const name = textField(tables, table, numericId, 'name');
    if (name) return name;
  }
  return null;
}

function descriptionOf(tables, itemId) {
  const numericId = Number(itemId);
  if (numericId < 2000000) return textField(tables, 'Eqp', numericId, 'desc') ?? '';
  for (const table of ['Cash', 'Consume', 'Ins', 'Pet']) {
    const description = textField(tables, table, numericId, 'desc');
    if (description) return description;
  }
  return '';
}

function scalarValue(node) {
  const value = node?.wzValue;
  if (typeof value === 'bigint') {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : String(value);
  }
  if (['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (value && typeof value === 'object' && Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y))) {
    return { x: Number(value.x), y: Number(value.y) };
  }
  return undefined;
}

function childProperties(node) {
  try { return [...(node?.wzProperties ?? [])]; } catch { return []; }
}

function scalarFields(node) {
  return Object.fromEntries(childProperties(node)
    .map(child => [child.name, scalarValue(child)])
    .filter(([, value]) => value !== undefined));
}

function scalar(node, name, fallback = null) {
  const value = scalarValue(node?.at?.(name));
  return value === undefined ? fallback : value;
}

function inventoryTypeFor(itemId) {
  const numericId = Number(itemId);
  if (numericId < 2000000) return 1;
  if (numericId < 3000000) return 2;
  if (numericId < 4000000) return 3;
  if (numericId < 5000000) return 4;
  return 5;
}

function pngAudit(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  let visiblePixels = 0;
  let opaquePixels = 0;
  for (let index = 3; index < png.data.length; index += 4) {
    const alpha = png.data[index];
    if (alpha > 0) visiblePixels += 1;
    if (alpha === 255) opaquePixels += 1;
  }
  return {
    width: png.width,
    height: png.height,
    visiblePixels,
    opaquePixels,
    empty: visiblePixels === 0,
    placeholder: png.width < 2 || png.height < 2,
  };
}

function sourceBaseFromIcon(source) {
  return String(source)
    .replace(/\/info\/icon(?:Raw)?$/, '')
    .replace(/\/icon$/, '');
}

// --------------------------------------------------------------------- main

async function main() {
  const reader = createReader(DATA, IMAGE_ROOT);
  try {
    // ---------------------------------------------------------- commodity
    const commodity = await reader.get(COMMODITY);
    if (commodity instanceof wz.WzImage) assert(await commodity.parseImage(), COMMODITY);
    const rows = [...commodity.wzProperties];
    assert(rows.length > 1000, `Commodity export looks stale: ${rows.length} rows`);
    const commodities = [];
    const excluded = [];
    const onSaleByGroup = new Map();
    for (const row of rows) {
      const get = key => row.at(key)?.wzValue;
      const onSale = Number(get('OnSale') ?? 0) === 1;
      if (!onSale) continue;
      const sn = Number(get('SN'));
      const itemId = Number(get('ItemId'));
      assert(Number.isSafeInteger(sn) && sn > 0, `bad SN at ${row.name}`);
      const sourceItemId = Number.isSafeInteger(itemId) && itemId > 0
        ? String(itemId).padStart(8, '0')
        : null;
      // SN 900 (楓點充值) / SN 910 (楓幣兌換) rows carry no ItemId at all.
      // Keep such a source row in the audit trail, but never expose a
      // non-item cash/recharge operation as a purchasable commodity.
      if (!sourceItemId) {
        excluded.push({
          sn: String(sn),
          itemId: null,
          reason: 'unsupported-source-sku',
          detail: 'OnSale source row has no ItemId (cash recharge/exchange is not a local item).',
        });
        continue;
      }
      const unsupported = UNSUPPORTED_SOURCE_ITEMS[sourceItemId];
      if (unsupported) {
        excluded.push({ sn: String(sn), itemId: sourceItemId, ...unsupported });
        continue;
      }
      const delivery = DELIVERY_MAPPINGS[sourceItemId] ?? null;
      const deliveredItemId = delivery?.deliveryItemId ?? sourceItemId;
      const entry = {
        sn: String(sn),
        itemId: deliveredItemId,
        sourceItemId,
        count: Math.max(1, Math.floor(Number(get('Count') ?? 1))),
        price: Math.max(0, Math.floor(Number(get('Price') ?? 0))),
        bonus: Math.max(0, Math.floor(Number(get('Bonus') ?? 0))),
        period: Math.max(0, Math.floor(Number(get('Period') ?? 0))),
        gender: Math.max(0, Math.floor(Number(get('Gender') ?? 2))),
        reqLevel: Math.max(0, Math.floor(Number(get('ReqLEV') ?? 0))),
        reqPop: Math.max(0, Math.floor(Number(get('ReqPOP') ?? 0))),
        priority: Math.floor(Number(get('Priority') ?? 99)),
        limit: Math.max(0, Math.floor(Number(get('Limit') ?? 0))),
        refundable: Number(get('Refundable') ?? 1) === 1,
      };
      if (delivery) entry.deliveryRule = delivery.deliveryRule;
      entry.tab = mainTabFor(sn, Number(deliveredItemId));
      assert(TAB_IDS.has(entry.tab), `SN ${sn} mapped to unknown tab ${entry.tab}`);
      const group = Math.floor(sn / 1000000);
      onSaleByGroup.set(group, (onSaleByGroup.get(group) ?? 0) + 1);
      commodities.push(entry);
    }
    assert(commodities.length > 500, `too few on-sale commodities: ${commodities.length}`);
    // Duplicate SNs would break the purchase contract (one SN = one deal).
    const sns = new Set(commodities.map(entry => entry.sn));
    assert.equal(sns.size, commodities.length, 'Commodity export has duplicate SNs');

    // -------------------------------------------------------------- names
    const tables = {};
    for (const table of ['Eqp', 'Cash', 'Ins', 'Consume', 'Pet']) {
      try {
        const node = await reader.get(`String/${table}.img`);
        if (node instanceof wz.WzImage) await node.parseImage();
        tables[table] = node;
      } catch {
        // A missing String pack only costs names, not the window.
      }
    }
    const itemIds = [...new Set(commodities.map(entry => entry.itemId))];
    const itemNames = {};
    // Seed from the already-assembled gameplay/pet catalogs first — both are
    // same-version exports whose zh names were verified when they shipped.
    for (const seedFile of ['items', 'pets']) {
      try {
        const seed = JSON.parse(fs.readFileSync(path.join(OUTPUT, `${seedFile}.json`), 'utf8'));
        for (const [id, entry] of Object.entries(seed)) {
          const name = entry?.name ?? entry?.info?.name;
          if (typeof name !== 'string' || !name.length || !/^\d+$/.test(id)) continue;
          const { id: padded, raw } = itemIdForms(Number(id));
          itemNames[padded] ??= name;
          itemNames[raw] ??= name;
        }
      } catch {
        // A missing seed file just leaves the String tables in charge.
      }
    }
    let unnamed = 0;
    for (const id of itemIds) {
      if (itemNames[id]) continue;
      const name = nameOf(tables, Number(id));
      if (name) itemNames[id] = name;
      else unnamed += 1;
    }
    console.log(`cashshop names: ${Object.keys(itemNames).length}/${itemIds.length} (unnamed ${unnamed})`);

    // -------------------------------------------------------------- icons
    // Some on-sale commodities reference items whose art left the client pack
    // (retired cash pets / pendants still flagged OnSale in the source
    // table).  They are excluded from the shippable list — the source
    // boundary beats a placeholder icon — and counted in the summary.
    const itemIcons = {};
    const itemSources = {};
    const iconAudit = {};
    const iconFailures = new Map();
    const frameCache = new Map();
    const frameFrom = async source => {
      if (!frameCache.has(source)) {
        const frame = await reader.frame(source, ASSETS);
        assert(frame?.url && frame.width > 0 && frame.height > 0, `invalid frame: ${source}`);
        frameCache.set(source, withAssetUrl(frame));
      }
      return frameCache.get(source);
    };
    for (const id of itemIds) {
      let frame = null;
      let resolvedBase = null;
      let spriteSource = null;
      let pixels = null;
      const candidateFailures = [];
      for (const candidate of iconCandidates(Number(id))) {
        try {
          const rendered = await frameFrom(candidate);
          const file = path.join(ASSETS, rendered.url.slice(ASSET_PREFIX.length));
          assert(fs.existsSync(file), `PNG was not written: ${candidate}`);
          const audit = pngAudit(file);
          if (audit.empty || audit.placeholder) {
            candidateFailures.push({
              candidate,
              reason: audit.placeholder ? 'placeholder-icon-art' : 'blank-icon-art',
              audit,
            });
            continue;
          }
          frame = rendered;
          pixels = audit;
          spriteSource = candidate;
          resolvedBase = sourceBaseFromIcon(candidate);
          break;
        } catch (error) {
          candidateFailures.push({ candidate, reason: 'no-icon-art', error: error.message });
          // try the next family candidate
        }
      }
      if (!frame) {
        const reason = candidateFailures.some(failure => failure.reason === 'placeholder-icon-art')
          ? 'placeholder-icon-art'
          : candidateFailures.some(failure => failure.reason === 'blank-icon-art')
            ? 'blank-icon-art'
            : 'no-icon-art';
        iconFailures.set(id, { reason, candidates: candidateFailures.map(failure => failure.candidate) });
        continue;
      }
      itemIcons[id] = frame;
      itemSources[id] = {
        source: resolvedBase,
        spriteSource,
        resolvedSpriteSource: frame.resolvedSource ?? spriteSource,
      };
      iconAudit[id] = {
        source: resolvedBase,
        spriteSource,
        resolvedSpriteSource: frame.resolvedSource ?? spriteSource,
        width: pixels.width,
        height: pixels.height,
        visiblePixels: pixels.visiblePixels,
        opaquePixels: pixels.opaquePixels,
        status: 'wz-verified',
      };
      // The Item packs carry an inline `name` string next to the icon; use it
      // whenever the String tables had no row for this id.
      if (!itemNames[id] && resolvedBase) {
        try {
          const node = await reader.get(`${resolvedBase}/name`);
          const inline = node?.wzValue ?? node?.at?.('name')?.wzValue;
          if (typeof inline === 'string' && inline.length) itemNames[id] = inline;
        } catch {
          // Still unnamed; the client falls back to the item id.
        }
      }
    }
    for (const entry of commodities) {
      const failure = iconFailures.get(entry.itemId);
      if (!failure) continue;
      excluded.push({
        sn: entry.sn,
        itemId: entry.itemId,
        sourceItemId: entry.sourceItemId,
        reason: failure.reason,
        sourceIconCandidates: failure.candidates,
      });
    }
    // 180/190/194 are pet/taming equipment art.  The local build has no pet
    // equipment inventory or equip operation; shipping these rows would make
    // a visually valid icon purchase produce an item that cannot be used.
    // Keep every source row in the audit instead of silently dropping it, and
    // leave the actual 500xxxx pet products below intact.
    const unsupportedPetEquipmentIds = new Set();
    for (const entry of commodities) {
      const family = familyOf(Number(entry.sourceItemId ?? entry.itemId));
      if (![180, 190, 194].includes(family)) continue;
      unsupportedPetEquipmentIds.add(entry.itemId);
      excluded.push({
        sn: entry.sn,
        itemId: entry.itemId,
        sourceItemId: entry.sourceItemId,
        reason: 'unsupported-pet-equipment',
        detail: 'Source is pet/taming equipment, but the local build has no pet-equipment inventory or equip operation.',
      });
    }
    for (const id of unsupportedPetEquipmentIds) {
      delete itemIcons[id];
      delete itemSources[id];
      delete iconAudit[id];
    }
    const shippable = commodities.filter(entry => itemIcons[entry.itemId]);
    // A mass icon exclusion means the candidate family regressed.  The
    // separate unsupported-pet-equipment rows are an explicit product-boundary
    // decision and are intentionally not counted by this guard.
    const iconExcluded = excluded.filter(entry => ['no-icon-art', 'blank-icon-art', 'placeholder-icon-art'].includes(entry.reason));
    assert(iconExcluded.length < 60, `too many commodities without icon art: ${iconExcluded.length}`);

    // ------------------------------------------------------ item definitions
    // Cash items are inventory/persistence data as well as shop rows.  Export
    // the authored info/spec scalars for every item with real source art so
    // assemble can merge the same definition into the server item catalog.
    // This includes equipment (islot), pets, coupons and other cash items;
    // Special bundles without an `info` node still get a display definition
    // with an explicit default slot size.
    const itemDefinitions = {};
    const commoditySources = new Map();
    for (const entry of shippable) {
      if (!commoditySources.has(entry.itemId)) commoditySources.set(entry.itemId, new Set());
      commoditySources.get(entry.itemId).add(entry.sourceItemId);
    }
    for (const id of Object.keys(itemIcons)) {
      const sourceMeta = itemSources[id];
      assert(sourceMeta?.source, `Cash item ${id} has no source path`);
      let sourceNode = await reader.get(sourceMeta.source);
      if (sourceNode instanceof wz.WzImage) assert(await sourceNode.parseImage(), sourceMeta.source);
      const infoNode = atPath(sourceNode, 'info');
      const specNode = atPath(sourceNode, 'spec');
      const info = scalarFields(infoNode);
      const spec = scalarFields(specNode);
      const authoredSlotMax = scalar(infoNode, 'slotMax', null);
      const slotMax = Number.isSafeInteger(Number(authoredSlotMax)) && Number(authoredSlotMax) > 0
        ? Number(authoredSlotMax)
        : 1;
      const defaultsApplied = [];
      if (authoredSlotMax === null || authoredSlotMax === undefined) defaultsApplied.push('slotMax');
      const inventoryType = inventoryTypeFor(Number(id));
      if (inventoryType === 1) assert(info.islot, `Cash equipment ${id} has no authored islot: ${sourceMeta.source}`);
      const sourceItemIds = [...(commoditySources.get(id) ?? new Set([id]))];
      const definition = {
        inventoryType,
        slotMax,
        info,
        spec,
        source: sourceMeta.source,
        sourceItemId: id,
        sourceItemIds,
        spriteSource: sourceMeta.spriteSource,
        spriteSourceStatus: 'wz-verified',
        name: itemNames[id] ?? id,
        description: descriptionOf(tables, Number(id)),
      };
      if (defaultsApplied.length) definition.defaultsApplied = defaultsApplied;
      const reqLevel = scalar(infoNode, 'reqLevel', null);
      const reqJob = scalar(infoNode, 'reqJob', null);
      if (reqLevel !== null || reqJob !== null) definition.requirements = { reqLevel, reqJob };
      itemDefinitions[id] = definition;
    }
    assert(Object.keys(itemDefinitions).every(id => itemIcons[id]), 'Cash definition has no matching icon');

    // ----------------------------------------------------------------- ui
    const ui = {};
    ui.backgrnd = withAssetUrl(await reader.frame(`${CASHSHOP}/Base/backgrnd`, ASSETS));
    ui.backgrnd2 = withAssetUrl(await reader.frame(`${CASHSHOP}/Base/backgrnd2`, ASSETS));
    ui.noItem = withAssetUrl(await reader.frame(`${CASHSHOP}/Base/noItem`, ASSETS));
    for (const tab of TABS) {
      const frame = await reader.frame(`${CASHSHOP}/CSTab/Tab/${tab.sprite}`, ASSETS);
      ui[`tab:${tab.id}`] = withAssetUrl(frame);
    }
    for (const name of ['BtExit']) {
      for (const state of ['normal', 'pressed', 'disabled', 'mouseOver']) {
        try {
          ui[`${name}/${state}`] = withAssetUrl(await reader.frame(`${CASHSHOP}/CSTab/${name}/${state}/0`, ASSETS));
        } catch {
          // Unauthored state; the client falls back to normal.
        }
      }
    }
    for (const name of ['BtBuy', 'Bt_magnifier']) {
      for (const state of ['normal', 'pressed', 'disabled', 'mouseOver']) {
        try {
          ui[`${name}/${state}`] = withAssetUrl(await reader.frame(`${CASHSHOP}/CSList/${name}/${state}/0`, ASSETS));
        } catch {
          // Unauthored state; the client falls back to normal.
        }
      }
    }
    // Effect labels (熱銷/新品/特價 overlays) are authored as frame folders.
    for (const label of ['hot', 'new', 'sale', 'event', 'time']) {
      try {
        const node = await reader.get(`${CASHSHOP}/CSEffect/${label}`);
        const first = [...node.wzProperties].find(child => /^\d+$/.test(child.name)) ?? null;
        const source = first ? `${CASHSHOP}/CSEffect/${label}/${first.name}` : `${CASHSHOP}/CSEffect/${label}`;
        ui[`effect:${label}`] = withAssetUrl(await reader.frame(source, ASSETS));
      } catch {
        // Label art is optional decoration.
      }
    }

    // -------------------------------------------------------------- write
    const categories = TABS.map(tab => ({ id: tab.id, label: tab.label }));
    const output = {
      contentVersion: 'tms273-cashshop',
      source: 'TMS273.7 client WZ / Etc/Commodity.img + UI/CashShop.img',
      categories,
      commodities: shippable,
      excluded,
      itemNames,
      itemIcons,
      itemDefinitions,
      iconAudit,
      deliveryMappings: DELIVERY_MAPPINGS,
      ui,
    };
    fs.writeFileSync(path.join(OUTPUT, 'cashshop.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    const byTab = {};
    for (const entry of shippable) byTab[entry.tab] = (byTab[entry.tab] ?? 0) + 1;
    console.log(JSON.stringify({
      output: path.join(OUTPUT, 'cashshop.json'),
      commodities: shippable.length,
      excluded: excluded.length,
      items: Object.keys(itemIcons).length,
      definitions: Object.keys(itemDefinitions).length,
      names: Object.keys(itemNames).length,
      onSaleByGroup: Object.fromEntries([...onSaleByGroup.entries()].sort((a, b) => a[0] - b[0])),
      byTab,
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

module.exports = { TABS, mainTabFor, familyOf, iconCandidates, main };
