#!/usr/bin/env node

// 坐骑 / 椅子目录导出（第 30、31 项专题的地基）。
//
// 为什么是两张新表而不是并进 `items.json`：
// `shared/items.json` 是**可达性驱动**的目录（`generate_tms273_gameplay.py` 从掉落、
// 商店、任务与建角色装备收集），而 0190xxxx 骑宠与 0301xxxx 椅子在源里是
// `notSale:1 / only:1`、不进任何掉落或商店行。把它们塞进 items.json 会改变该文件
// 的性质（图鉴/笔记本按它算「可获得分母」），因此照 `shared/pets.json` 的先例，
// 单独成表，由 `inventory.rs` 在 items.json 未命中时回落到本表。
//
// 源事实（全部逐字段读出，无一处估算）：
//   Character/TamingMob/01902000.json  info.islot = "Tm" / info.tamingMob = 1
//   TamingMob/0001.json               info.speed = 150, jump = 120, fs = 10,
//                                     swim = 100, fatigue = 5
//   String/Eqp.json  Eqp.Taming.1902000.name = "野豬"
//   Item/Install/03010/03010001.json  info.recoveryHP = 35（3010018 另有 recoveryMP = 20）
//   String/Ins.json   3010001.name / .desc（「坐在上面每10秒可恢復HP 35」）
//
// 刻意**不**发明的东西：
//   * 椅子恢复间隔：源 `info` 没有间隔字段，只有描述文案里写「每N秒」。因此只在
//     文案确实写出「每N秒」时导出 `recoveryIntervalMs`，否则该字段缺席并进
//     `unverified`，由运行时按「无已核定恢复规则」处理，而不是套一个默认 10 秒。
//   * 缺 `TamingMob/<n>.json` 的坐骑（源引用了不存在的坐骑档）只登记引用，不给数值。
//
// 输出：`shared/mounts.json`、`shared/chairs.json`，并镜像到
// `client/public-tms273/assets/`（浏览器侧目录查询走同一份表）。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, '参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW');
const MIRRORS = ['shared', 'client/public-tms273/assets'];
// 骑宠图标帧表，由 `export_tms273_mount_icons.cjs` 产出（**先跑那个**）。
const MOUNT_ICONS = path.join(ROOT, 'resources/tms273-export/mount-images.json');

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

/** 源 JSON 的 `{_dirType,_value}` 包装 → 裸值；子目录保持原样（值为 undefined）。 */
function unwrap(node) {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    if ('_value' in node) return node._value;
    return undefined;
  }
  return node;
}

/** 一层 info 目录 → 平表（丢掉 `_dirType` 与嵌套子目录）。 */
function infoTable(node) {
  const table = {};
  for (const [key, value] of Object.entries(node ?? {})) {
    if (key === '_dirType') continue;
    const bare = unwrap(value);
    if (bare !== undefined) table[key] = bare;
  }
  return table;
}

/** 数字字符串 → number，其余原样保留；缺失返回 undefined。 */
function numberOrString(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return value;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d*\.\d+$/.test(value)) return Number(value);
  return value;
}

/** 只保留目录表里真实出现的键，且把数字型字符串转成数字。 */
function pick(table, keys) {
  const result = {};
  for (const key of keys) {
    if (table[key] === undefined) continue;
    result[key] = numberOrString(table[key]);
  }
  return result;
}

/** 8 位镜像名 → 目录 id（源目录用 8 位补零，运行时 id 不带前导零）。 */
const itemIdOf = mirror => String(Number(mirror));

function listSourceFiles(dir, pattern = /\.json$/) {
  return fs.readdirSync(dir)
    .filter(name => pattern.test(name))
    .sort()
    .map(name => path.join(dir, name));
}

/**
 * 源目录是一层 `Item/Install/<分组>/<8位id>.json`，所以这里显式只下钻一层：
 * 保留分组的目录名（它进 `source`，是可追溯的证据），不做无界递归。
 */
function listNestedSourceFiles(dir, pattern = /\.json$/) {
  const files = [];
  for (const group of fs.readdirSync(dir).sort()) {
    const groupDir = path.join(dir, group);
    if (!fs.statSync(groupDir).isDirectory()) continue;
    files.push(...listSourceFiles(groupDir, pattern));
  }
  return files;
}

// ---------------------------------------------------------------------------
// 坐骑
// ---------------------------------------------------------------------------

// 装备槽字段与穿脱/属性有关的键；其余 info 键（纯外观）不投影。
const MOUNT_INFO_KEYS = Object.freeze([
  'islot', 'vslot', 'tuc', 'reqJob', 'reqLevel',
  'tamingMob', 'tradeBlock', 'dropBlock', 'notSale', 'only', 'cash', 'price',
]);

// 坐骑源档 `TamingMob/<n>.json` 的骑行数值。全部为源作者值。
const RIDE_KEYS = Object.freeze(['speed', 'jump', 'fs', 'swim', 'fatigue']);

function buildMounts() {
  const eqpNames = readJson(path.join(SOURCE, 'String/Eqp.json')).Eqp?.Taming ?? {};
  const rideDir = path.join(SOURCE, 'TamingMob');
  const rides = {};
  for (const file of listSourceFiles(rideDir)) {
    const id = String(Number(path.basename(file, '.json')));
    const info = infoTable(readJson(file).info);
    rides[id] = {
      ...pick(info, RIDE_KEYS),
      source: `TamingMob/${path.basename(file)}`,
    };
  }

  const items = {};
  const skipped = { nonEquipment: [], unnamed: [], missingRideStats: [] };
  for (const file of listSourceFiles(path.join(SOURCE, 'Character/TamingMob'))) {
    const mirror = path.basename(file, '.json');
    // 攻击/效果用的纯图（0198xxxx 等）没有 islot，不是可穿装备。
    const info = infoTable(readJson(file).info);
    if (!info.islot) { skipped.nonEquipment.push(mirror); continue; }
    const itemId = itemIdOf(mirror);
    const entry = {
      inventoryType: 1,
      slotMax: 1,
      info: pick(info, MOUNT_INFO_KEYS),
      source: `Character/TamingMob/${path.basename(file)}`,
      spriteSource: `Character/TamingMob/${mirror}.img/info/icon`,
      // 图标存在于 WZ，但**本轮未抽取**到 assets/tms273（见专题文档「未完成项」）。
      // 不写 `wz-verified`：那是「字节已导出并校验过」的取值。
      spriteSourceStatus: 'wz-present-unextracted',
      defaultsApplied: ['slotMax'],
    };
    const name = unwrap(eqpNames[itemId]?.name);
    if (typeof name === 'string' && name.length) entry.name = name;
    else skipped.unnamed.push(itemId);
    const ride = info.tamingMob === undefined ? undefined : rides[String(info.tamingMob)];
    if (ride) entry.ride = { ...ride };
    else if (info.tamingMob !== undefined) {
      // 源引用了不存在的坐骑档：登记引用，**不**补数值。
      skipped.missingRideStats.push({ itemId, tamingMob: info.tamingMob });
    }
    items[itemId] = entry;
  }

  return {
    schemaVersion: 1,
    kind: 'mount-catalog',
    sourceVersion: 'TMS273.7',
    encoding: 'UTF-8',
    generatedFrom: 'TMS273.7 WZ_JSON_TW: Character/TamingMob/*.json (骑宠装备) + TamingMob/*.json (骑行数值) + String/Eqp.json (Eqp/Taming 名称)',
    contract: {
      items: 'itemId -> 骑宠装备行；info.islot 为 Tm(-18) / Sd(-19)，由 inventory.rs::equipment_slot 解析',
      mobs: '坐骑 id -> 骑行数值（源 TamingMob/<n>.json/info）',
      ride: '装备行上的 ride 为 mobs 的内联副本，便于运行时不查两次表；两者同源同值',
    },
    items,
    mobs: rides,
    skipped: {
      nonEquipment: skipped.nonEquipment.length,
      unnamed: skipped.unnamed.length,
      missingRideStats: skipped.missingRideStats,
    },
    unverified: [
      'P: 骑乘的开关条件、可骑地图、下马时机与禁术范围，源包未给出可执行规则；运行时的判据写在 server/src/mounts.rs 并逐条注明依据。',
      '骑宠图标未抽取到 assets/tms273（spriteSourceStatus = wz-present-unextracted），装备栏该槽位暂无可画图。',
    ],
  };
}

// ---------------------------------------------------------------------------
// 椅子
// ---------------------------------------------------------------------------

const CHAIR_INFO_KEYS = Object.freeze([
  'price', 'slotMax', 'recoveryHP', 'recoveryMP', 'reqLevel', 'tradeBlock', 'notSale', 'only', 'sitAction',
]);

// 描述里写出的恢复间隔。源 `info` 没有该字段，只有文案；只认「每N秒」这一种写法，
// 其余一律不导出（运行时按「无已核定恢复规则」处理）。
const INTERVAL_PATTERN = /每(\d+)秒/;

function buildChairs() {
  const names = readJson(path.join(SOURCE, 'String/Ins.json'));
  const items = {};
  const unverified = [];
  let withInterval = 0;

  for (const file of listNestedSourceFiles(path.join(SOURCE, 'Item/Install'), /\.json$/)) {
    const document = readJson(file);
    if (!document.info) continue;
    const info = infoTable(document.info);
    if (info.slotMax === undefined && info.price === undefined && info.recoveryHP === undefined) continue;
    const mirror = path.basename(file, '.json');
    const itemId = itemIdOf(mirror);
    // 源导出的扇出目录是 `Item/Install/<分组>/<8位id>.json`，而资源的规范地址是
    // `Item/Install/<分组>.img/<8位id>/info/icon`（与 items.json 既有行同形）。
    const group = path.basename(path.dirname(file));
    const sourcePath = `Item/Install/${group}/${mirror}.json`;
    const description = unwrap(names[itemId]?.desc);
    const name = unwrap(names[itemId]?.name);
    const entry = {
      inventoryType: 3,
      slotMax: numberOrString(info.slotMax) ?? 1,
      info: pick(info, CHAIR_INFO_KEYS),
      source: sourcePath,
      spriteSource: `Item/Install/${group}.img/${mirror}/info/icon`,
      spriteSourceStatus: 'wz-present-unextracted',
      defaultsApplied: [],
    };
    if (typeof name === 'string' && name.length) entry.name = name;
    if (typeof description === 'string' && description.length) entry.description = description;
    const interval = typeof description === 'string' ? INTERVAL_PATTERN.exec(description) : null;
    if (interval) {
      entry.recoveryIntervalMs = Number(interval[1]) * 1000;
      entry.recoveryIntervalSource = `P: String/Ins.json ${itemId}.desc「每${interval[1]}秒」；源 info 无间隔字段`;
      withInterval += 1;
    } else if (info.recoveryHP !== undefined || info.recoveryMP !== undefined) {
      unverified.push(itemId);
    }
    items[itemId] = entry;
  }

  return {
    schemaVersion: 1,
    kind: 'chair-catalog',
    sourceVersion: 'TMS273.7',
    encoding: 'UTF-8',
    generatedFrom: 'TMS273.7 WZ_JSON_TW: Item/Install/*/*.json (info) + String/Ins.json (name/desc)',
    contract: {
      items: 'itemId -> 椅子行；inventoryType 3(设置栏)，info.recoveryHP / recoveryMP 为源作者值',
      recoveryIntervalMs: '仅当描述写明「每N秒」时出现；缺席＝该椅子的恢复间隔未核定，运行时不得套默认值',
    },
    items,
    unverified: [
      `有 recoveryHP/recoveryMP 但描述未写「每N秒」的椅子 ${unverified.length} 件：其恢复间隔未核定，因此未导出 recoveryIntervalMs。`,
      '椅子自身的坐姿贴图：源 Item/Install 只带 info/icon 与 effect（无 sit 节点，584 件全查过），角色坐姿来自 Character/*/sit；椅子图未抽取到 assets。',
    ],
    counts: { total: Object.keys(items).length, withInterval, intervalUnverified: unverified.length },
  };
}

// ---------------------------------------------------------------------------

function write(relative, value) {
  const file = path.join(ROOT, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
  return file;
}

/**
 * 骑宠图标状态落定。本脚本是 `mounts.json` 的**唯一写者**，所以状态字段在这里定：
 *   * 抽到帧（帧表里有这条 id） ⇒ `wz-verified`，并把帧挂在 `icon` 上；
 *   * 帧表存在但没有这条 id ⇒ `wz-missing`（源 WZ 里就没有这件映像），逐条登记；
 *   * 帧表整体缺席（没跑图标导出） ⇒ 保持 `wz-present-unextracted` 且**留住**「未完成项」
 *     提示——绝不因为「这次没查」就把状态说成已完成。
 */
function applyMountIcons(mounts) {
  if (!fs.existsSync(MOUNT_ICONS)) return { extracted: false, verified: 0, absent: [] };
  const frames = JSON.parse(fs.readFileSync(MOUNT_ICONS, 'utf8'));
  const absent = [];
  let verified = 0;
  for (const [id, entry] of Object.entries(mounts.items)) {
    const frame = frames[id];
    if (frame) {
      entry.icon = frame;
      entry.spriteSourceStatus = 'wz-verified';
      verified++;
    } else {
      entry.spriteSourceStatus = 'wz-missing';
      absent.push(id);
    }
  }
  mounts.unverified = mounts.unverified.filter(line => !line.includes('图标未抽取'));
  if (absent.length) {
    mounts.unverified.push(`骑宠图标：源 WZ 里没有这 ${absent.length} 件对应的映像（spriteSourceStatus = wz-missing），该槽位无图可画；其余 ${verified} 件已抽取并核对（wz-verified）。`);
  }
  mounts.iconSource = 'resources/tms273-export/mount-images.json ← Character/TamingMob/<8位>.img/info/icon（外链 Canvas，像素在 TamingMob/_Canvas/_Canvas_00N.wz）';
  return { extracted: true, verified, absent };
}

function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`generate: 源目录不存在 ${SOURCE}`);
    process.exitCode = 2;
    return;
  }
  const mounts = buildMounts();
  const icons = applyMountIcons(mounts);
  const chairs = buildChairs();
  for (const mirror of MIRRORS) {
    write(path.join(mirror, 'mounts.json'), mounts);
    write(path.join(mirror, 'chairs.json'), chairs);
  }
  // 浏览器侧再要一张**瘦身索引**，不要整张表。
  //
  // 为什么不直接 import 那两张表：`shared/items.json` 已经被静态打进客户端包
  // （1.6 MB，构建产物实测 3.34 MB），再挂 1.68 MB 的整表会把包推到 ~5 MB；
  // 而客户端真正需要的只有三样东西，且 `names.ts` 在**同步渲染路径**上调用，
  // 不能改成异步取表。两张整表还带 `info`/`mobs`/`contract` 等运行期用不到的段。
  //
  // 索引里为什么必须有 `islot` 与 `tamingMob`，而不是只有名字：
  // * `islot` —— 客户端 `names.ts::equipmentSlot` 与 `B/inventory.rs::equipment_slot`
  //   必须给出**同一个**槽位答案；坐骑不在 items.json 里，只带名字的索引会让
  //   客户端对骑宠答"部位未知"，与服务端分叉成两套槽位口径。
  // * `tamingMob` —— 服务端的 `is_mount_item` 判据是 `info.tamingMob`（不是 islot：
  //   `Tm` 槽里还有 22 件非坐骑）。客户端要能识别"这件已装备的东西是坐骑"，
  //   只能看同一个字段；按 islot 猜会把機械師整套装备认成坐骑。
  //
  // 值就是数据本身（与 `pets.json` 同构）：`{ itemId: { islot, tamingMob?, name? } }`。
  // `name` 缺席＝源里没有名字（坐骑 840 件在 `String/Eqp.json/Eqp/Taming` 里就没有），
  // 客户端回落成 id，而不是编一个名字。
  const mountIndex = Object.fromEntries(
    Object.entries(mounts.items).map(([id, entry]) => {
      const row = { islot: entry.info.islot };
      if (entry.info.tamingMob !== undefined) row.tamingMob = entry.info.tamingMob;
      if (typeof entry.name === 'string' && entry.name.length) row.name = entry.name;
      return [id, row];
    }),
  );
  const chairNames = Object.fromEntries(
    Object.entries(chairs.items)
      .filter(([, entry]) => typeof entry.name === 'string' && entry.name.length)
      .map(([id, entry]) => [id, entry.name]),
  );
  for (const mirror of MIRRORS) {
    write(path.join(mirror, 'mount-index.json'), mountIndex);
    write(path.join(mirror, 'chair-names.json'), chairNames);
  }
  const mountIds = Object.keys(mounts.items);
  const withRide = mountIds.filter(id => mounts.items[id].ride).length;
  console.log(`导出坐骑 ${mountIds.length} 件（${withRide} 件带已核定骑行数值，坐骑档 ${Object.keys(mounts.mobs).length} 个）、椅子 ${chairs.counts.total} 件（${chairs.counts.withInterval} 件带已核定恢复间隔）。`);
  console.log(`未登记：非装备图 ${mounts.skipped.nonEquipment}、无名 ${mounts.skipped.unnamed}、缺坐骑档 ${mounts.skipped.missingRideStats.length}；椅子间隔未核定 ${chairs.counts.intervalUnverified}。`);
  console.log(`客户端索引：坐骑 ${Object.keys(mountIndex).length} 条（带名字 ${mountIds.filter(id => mountIndex[id].name).length}、带 tamingMob ${mountIds.filter(id => mountIndex[id].tamingMob !== undefined).length}）、椅子名 ${Object.keys(chairNames).length} 条。`);
  console.log(icons.extracted
    ? `骑宠图标：wz-verified ${icons.verified} 件、源内无映像 ${icons.absent.length} 件（帧表 ${path.relative(ROOT, MOUNT_ICONS)}）。`
    : `骑宠图标：帧表缺席（${path.relative(ROOT, MOUNT_ICONS)}），状态保持 wz-present-unextracted——先跑 scripts/export_tms273_mount_icons.cjs。`);
}

main();
