#!/usr/bin/env node
// 增量 4（审查 §33/§34）的门禁：把「背包原语收窄 + 整表写回外观拆除」钉在
// 源码表面上。三条断言都带反向面——名单里的调用点消失/多出、或有人把
// `pub fn` 改回去/把 `write_inventory` 外观加回来，都会让本检查失败。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// 1) 原语的可见性：inventory.rs 里的 &mut Vec 原语一律 pub(crate)，不许回到 pub。
const inventory = read('server/src/inventory.rs');
for (const name of ['move_items', 'remove_items', 'add_items', 'add_items_expiring']) {
  assert(
    inventory.includes(`pub(crate) fn ${name}(`) && !inventory.includes(`pub fn ${name}(`),
    `inventory::${name} must stay pub(crate) (增量 4 收窄原语面)`
  );
}

// 2) 整表写回的生产外观不得回来：Store 上不许再出现非测试的 write_inventory。
const auth = read('server/src/auth.rs');
assert(
  !/pub fn write_inventory\(/.test(auth),
  'Store::write_inventory must stay removed; add a single-transaction commit helper instead'
);
assert(
  auth.includes('fn seed_inventory_for_test('),
  'the test-only seeding entry point is part of the recorded surface'
);

// 3) 调用点名单：这些原语只允许出现在下面这些文件里（含测试）。
//    新增调用点 = 有意的业务动作变化 ⇒ 把文件加进名单并在交付记录里说明。
const allowed = new Set([
  'server/src/inventory.rs',            // 定义与内部互调（add_items→add_items_expiring）
  'server/src/auth/db.rs',              // add_inventory_tx（put 原语的事务半边）
  'server/src/auth/bag.rs',             // 背包动作簇（移动/消耗/丢弃）
  'server/src/auth/cash.rs',            // 现金购买候选背包（add_items_expiring）
  'server/src/auth/quests.rs',          // 任务结算发奖
  'server/src/auth/loot.rs',            // 掉落拾取（拾取侧 put）
  'server/src/auth/item_world.rs',      // 物品世界 Destination::put
  'server/src/inventory_ops.rs',        // 背包协议操作簇
  'server/src/trade.rs',                // 商店买/卖/买回的候选背包
  'server/src/cashshop.rs',             // 现金商店购买/租赁候选背包
  'server/src/quest.rs',                // 任务场景执行（add/remove）
  'server/src/gm.rs',                   // GM /add
  'server/src/chapter_acceptance.rs',   // 验收
  'server/src/pet_acceptance.rs',       // 验收
  'server/src/cashshop_acceptance.rs',  // 验收
  'server/src/inventory_persistence_acceptance.rs', // 验收（经 seed 入口）
  'server/src/storage_acceptance.rs',   // 验收（经 seed 入口）
  'server/src/quest_store_acceptance.rs', // 验收（经 seed 入口）
]);
const callers = new Set();
const call = /(?:inventory::|crate::inventory::)?\b(add_items|add_items_expiring|remove_items|move_items)\s*\(/g;
// 这里曾经有过 `skip = (rel) => / \d+\.rs$/.test(rel)`，把「xxx 2.rs」当作
// 「不参与编译的 iCloud 复制残留」放行。那等于把污染合法化：副本会一直躺在
// server/src 里，让 grep 先匹配到旧版本。现在由 check_icloud_conflict_copies.cjs
// 禁止副本进入版本库，本文件不再需要任何例外。
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!entry.name.endsWith('.rs')) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const match of text.matchAll(call)) {
      // 只算对原语的真实调用：排除定义本身与同名但无关的本地函数。
      const isDefinition = new RegExp(`fn ${match[1]}\\s*\\(`).test(text);
      if (isDefinition && rel === 'server/src/inventory.rs') continue;
      if (match[1] === 'add_items_expiring' && rel === 'server/src/inventory.rs') continue;
      callers.add(rel);
    }
  }
}
walk(path.join(root, 'server/src'));
const unexpected = [...callers].filter((rel) => !allowed.has(rel)).sort();
assert.deepEqual(
  unexpected,
  [],
  `unexpected inventory-primitive call sites (add them to check_inventory_surface.cjs with a reason): ${unexpected.join(', ')}`
);
const missing = [...allowed].filter((rel) => !fs.existsSync(path.join(root, rel))).sort();
assert.deepEqual(missing, [], `stale allowlist entries: ${missing.join(', ')}`);

// 4) 增量 3（审查 §7）：拾取的**去处**是类型，三个分支的 SQL 只住在
//    `auth/db.rs`。反向面：把任何一条分支的 SQL 写回 `loot.rs`、给
//    `PickupSink` 加变体却不管 `db.rs` 的匹配，都会让本检查失败。
const loot = read('server/src/auth/loot.rs');
const dbSource = read('server/src/auth/db.rs');
const itemWorld = read('server/src/auth/item_world.rs');
assert(
  itemWorld.includes('pub(super) enum PickupSink'),
  'PickupSink must stay the single name for a pickup destination'
);
assert(
  itemWorld.includes('pub(super) fn can_refuse(&self)'),
  'PickupSink::can_refuse is the only reason a claimed drop is put back'
);
const dbSql = dbSource;
assert(dbSql.includes('pub(super) fn apply_pickup_sink_tx('), 'pickup sink SQL belongs in auth/db.rs');
assert(dbSql.includes('pub(super) fn read_active_drop_tx('), 'the active-drop SELECT belongs in auth/db.rs');
for (const variant of ['Inventory', 'MonsterBookCard', 'Mesos']) {
  assert(
    new RegExp(`^    ${variant},$`, 'm').test(itemWorld),
    `PickupSink::${variant} must stay a variant`
  );
  assert(
    dbSql.includes(`item_world::PickupSink::${variant} =>`),
    `apply_pickup_sink_tx must handle PickupSink::${variant}`
  );
}
assert(loot.includes('apply_pickup_sink_tx('), 'Store::pickup must dispatch through the sink');
assert(
  !loot.includes('INSERT INTO monster_book_cards'),
  'the monster-book branch must not creep back into Store::pickup'
);
assert(
  !/UPDATE player_stats SET mesos/.test(loot),
  'the mesos branch must not creep back into Store::pickup'
);
assert(
  !/\badd_inventory_tx\(/.test(loot),
  'the inventory branch must not creep back into Store::pickup'
);

console.log('PASS inventory surface: primitives stay pub(crate), whole-table wrapper stays removed, call-site roster matches, pickup sinks live in auth/db.rs');
