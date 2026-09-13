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
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const IMAGE_ROOT = path.join(ROOT, 'resources/tms273-export/ms');
const OUTPUT = path.join(ROOT, 'resources/tms273-export');
const ASSETS = path.join(OUTPUT, 'assets/tms273');
const CASHSHOP = 'UI/CashShop.img';
const COMMODITY = 'Etc/Commodity.img';

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
  if (itemId < 2000000) return Math.floor(itemId / 10000);
  if (itemId >= 3000000 && itemId < 4000000) return Math.floor(itemId / 10000);
  return Math.floor(itemId / 100000);
}

// ------------------------------------------------------------------- icons

/** Client WZ `info/icon` path candidates for one item id, in priority order.
 *  Equip node names are the 8-digit padded id; the Item packs (Cash, Pet,
 *  Special, Install) name their nodes without leading zeros. */
function iconCandidates(itemId) {
  const id = String(itemId).padStart(8, '0');
  const raw = String(itemId);
  const p3 = Math.floor(Number(id.slice(0, 3)));
  const paths = [];
  if (itemId < 2000000) {
    const dirs = {
      100: 'Character/Cap', 101: 'Character/Accessory', 102: 'Character/Accessory',
      103: 'Character/Accessory', 104: 'Character/Coat', 105: 'Character/Longcoat',
      106: 'Character/Pants', 107: 'Character/Shoes', 108: 'Character/Glove',
      109: 'Character/Shield', 110: 'Character/Cape', 111: 'Character/Accessory',
      112: 'Character/Accessory', 113: 'Character/Accessory', 116: 'Character/Accessory',
      118: 'Character/Accessory', 120: 'Character/Accessory', 160: 'Character/Cape',
      170: 'Character/Weapon', 180: 'Character/PetEquip', 190: 'Character/PetEquip',
      194: 'Character/PetEquip',
    };
    const dir = dirs[p3] ?? dirs[Math.floor(Number(id.slice(0, 4)))];
    if (dir) {
      paths.push(`${dir}/${id}.img/info/icon`, `${dir}/${id}.img/info/iconRaw`);
    }
  } else if (itemId >= 5000000 && itemId < 5100000 && Math.floor(itemId / 10000) === 500) {
    // 真正的寵物 (500xxxx) live in Item/Pet/0500.img.  The Item packs mix
    // conventions: Cash images key the 8-digit padded id while Special keys
    // the raw one, so both spellings are tried.
    for (const key of new Set([raw, id])) {
      paths.push(`Item/Pet/0500.img/${key}/info/icon`, `Item/Pet/0500.img/${key}/icon`);
    }
  } else if (itemId >= 5000000 && itemId < 6000000) {
    // 现金消耗/兑换道具 live in Item/Cash/<0501..05xx>.img.
    const pack = id.slice(0, 4);
    for (const key of new Set([id, raw])) {
      paths.push(`Item/Cash/${pack}.img/${key}/info/icon`, `Item/Cash/${pack}.img/${key}/icon`);
    }
  } else if (itemId >= 3000000 && itemId < 4000000) {
    // 傷害皮膚 / 安裝類 in Item/Special or Item/Install.
    const pack = id.slice(0, 4);
    for (const key of new Set([raw, id])) {
      paths.push(`Item/Special/${pack}.img/${key}/info/icon`, `Item/Special/${pack}.img/${key}/icon`, `Item/Install/${pack}.img/${key}/icon`);
    }
  } else if (itemId >= 9000000) {
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
  118: 'Accessory', 120: 'Accessory', 160: 'Cape', 170: 'Weapon', 180: 'PetEquip',
  190: 'TamingMob', 194: 'PetEquip',
};

/** Resolve the zh display name through the String tables.  The Eqp table
 *  nests its rows under per-family folders and keys the 8-digit padded id;
 *  every other table keys the plain unpadded id. */
function nameOf(tables, itemId) {
  const id = String(itemId).padStart(8, '0');
  const raw = String(itemId);
  const p3 = Math.floor(Number(id.slice(0, 3)));
  const order = [];
  if (itemId < 2000000 && EQUIP_STRING_DIRS[p3]) order.push(['Eqp', `${EQUIP_STRING_DIRS[p3]}/${id}`]);
  order.push(['Cash', raw], ['Consume', raw], ['Ins', raw], ['Pet', raw], ['Eqp', id]);
  for (const [table, key] of order) {
    const entry = tables[table]?.at(key);
    const name = entry?.at?.('name')?.wzValue;
    if (typeof name === 'string' && name.length) return name;
  }
  return null;
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
    const onSaleByGroup = new Map();
    for (const row of rows) {
      const get = key => row.at(key)?.wzValue;
      const onSale = Number(get('OnSale') ?? 0) === 1;
      if (!onSale) continue;
      const sn = Number(get('SN'));
      const itemId = Number(get('ItemId'));
      assert(Number.isSafeInteger(sn) && sn > 0, `bad SN at ${row.name}`);
      // SN 900 (楓點充值) / SN 910 (楓幣兌換) rows carry no ItemId at all; an
      // on-sale row without one can never be bought, so refuse it here.
      assert(Number.isSafeInteger(itemId) && itemId > 0, `on-sale SN ${sn} has no ItemId`);
      const entry = {
        sn: String(sn),
        itemId: String(itemId).padStart(8, '0'),
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
      entry.tab = mainTabFor(sn, itemId);
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
          if (typeof name === 'string' && name.length) itemNames[id] = name;
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
    const excluded = [];
    for (const entry of commodities) {
      const id = entry.itemId;
      let frame = null;
      let resolvedBase = null;
      for (const candidate of iconCandidates(Number(id))) {
        try {
          frame = await reader.frame(candidate, ASSETS);
          resolvedBase = candidate.replace(/\/info\/icon(Raw)?$/, '').replace(/\/icon$/, '');
          break;
        } catch {
          // try the next family candidate
        }
      }
      if (!frame) {
        excluded.push({ sn: entry.sn, itemId: id, reason: 'no-icon-art' });
        continue;
      }
      itemIcons[id] = frame;
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
    const shippable = commodities.filter(entry => itemIcons[entry.itemId]);
    // A mass exclusion would mean the icon families regressed, not that the
    // source table retired a handful of pets.
    assert(excluded.length < 60, `too many commodities without icon art: ${excluded.length}`);

    // ----------------------------------------------------------------- ui
    const ui = {};
    ui.backgrnd = await reader.frame(`${CASHSHOP}/Base/backgrnd`, ASSETS);
    ui.backgrnd2 = await reader.frame(`${CASHSHOP}/Base/backgrnd2`, ASSETS);
    ui.noItem = await reader.frame(`${CASHSHOP}/Base/noItem`, ASSETS);
    for (const tab of TABS) {
      const frame = await reader.frame(`${CASHSHOP}/CSTab/Tab/${tab.sprite}`, ASSETS);
      ui[`tab:${tab.id}`] = frame;
    }
    for (const name of ['BtExit']) {
      for (const state of ['normal', 'pressed', 'disabled', 'mouseOver']) {
        try {
          ui[`${name}/${state}`] = await reader.frame(`${CASHSHOP}/CSTab/${name}/${state}/0`, ASSETS);
        } catch {
          // Unauthored state; the client falls back to normal.
        }
      }
    }
    for (const name of ['BtBuy', 'Bt_magnifier']) {
      for (const state of ['normal', 'pressed', 'disabled', 'mouseOver']) {
        try {
          ui[`${name}/${state}`] = await reader.frame(`${CASHSHOP}/CSList/${name}/${state}/0`, ASSETS);
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
        ui[`effect:${label}`] = await reader.frame(source, ASSETS);
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
