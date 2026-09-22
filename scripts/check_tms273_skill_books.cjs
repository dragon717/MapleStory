#!/usr/bin/env node
// 技能书 ↔ 职业的准入表：Rust 权威（server/src/mage.rs）与客户端权威
// （client/src/features/player/input.ts 的 BOOK_JOBS）**逐格双向断言**。
//
// 为什么需要这道门禁（2026-09-22）：这张表原本在三处各写了一份，而且三份都只认冰雷
// 那三本（220/221/222）。后果不是「少了个功能」，而是火毒（210/211/212）与
// 主教（230/231/232）两条分支的技能**在运行期既学不了、也拿不到升级点**——
// 目录、任务、地图全都装好了，玩家却碰不到。收口之后最大的风险是「又有人只改一侧」：
// Rust 侧说允许、客户端说不可用（按钮变灰），或者反过来（按钮能点、服务端拒绝）。
// 所以这里不比对「文档」，两份实现都**执行**出来再逐格对。
//
// 判据是「转职层级」而不是「某一本书」，两侧都必须满足：
//   书号 = 职业号（`2201005 → 220`）；同层三条分支各自只认自己那一支；
//   低转职层级的书对同一分支的高转职职业继续有效（三转书四转照样能学）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// 1. Rust 侧：从 mage.rs 反解常量与 `book_jobs` 的分支臂
// ---------------------------------------------------------------------------
const rustSrc = fs.readFileSync(path.join(root, 'server/src/mage.rs'), 'utf8');

/** 读出 `NAME: [u32; N] = [a, b, c];` 之类的整型常量数组。 */
const constArray = name => {
  const match = new RegExp(`(?:pub )?const ${name}: \\[u32; \\d+\\] = \\[([^\\]]*)\\];`).exec(rustSrc);
  assert.ok(match, `mage.rs 里读不到 ${name} —— 准入表没了依据`);
  return match[1].split(',').map(part => part.trim()).filter(Boolean).map(Number);
};

const rustBooks = constArray('BOOKS');
const rustFourthBooks = constArray('FOURTH_JOB_BOOKS');
const rustMageJobs = constArray('MAGE_JOBS');
const rustBeginnerJobs = constArray('BEGINNER_JOBS');
const branches = {
  BRANCH_FIRE: constArray('BRANCH_FIRE'),
  BRANCH_ICE: constArray('BRANCH_ICE'),
  BRANCH_HOLY: constArray('BRANCH_HOLY'),
};
const branchByPrefix = { 21: 'BRANCH_FIRE', 22: 'BRANCH_ICE', 23: 'BRANCH_HOLY' };

// `book_jobs` 的分支臂：`Some((21, 0)) => &BRANCH_FIRE,` / `Some((21, 1)) => &BRANCH_FIRE[1..],`
const body = /pub fn book_jobs\(book: u32\) -> &'static \[u32\] \{([\s\S]*?)\n\}/.exec(rustSrc);
assert.ok(body, 'mage.rs 里读不到 book_jobs —— 门禁不再知道准入表怎么算');
const arms = new Map();
for (const arm of body[1].matchAll(/Some\(\((\d+),\s*(\d+)\)\)\s*=>\s*&(\w+)(?:\[(\d+)\.\.\])?/g)) {
  const [, prefix, tier, slice, from] = arm;
  arms.set(`${prefix}${tier}`, { slice, tier: Number(tier), from: Number(from ?? 0) });
}
assert.ok(arms.size > 0, 'book_jobs 的分支臂一条都没解出来 —— 正则与源码形状脱节了');

const rustJobs = new Map();
rustJobs.set(0, rustBeginnerJobs);
rustJobs.set(200, rustMageJobs);
for (const book of rustBooks) {
  if (rustJobs.has(book)) continue;
  const prefix = String(Math.floor(book / 10));
  const tier = book % 10;
  const expected = branchByPrefix[prefix];
  const arm = arms.get(`${prefix}${tier}`);
  assert.ok(arm && expected, `书 ${book} 在 book_jobs 里没有分支臂 —— 加了书却没加准入`);
  // 臂的切片必须就是「本分支第 tier 本书及其后的转职」：切片写错一个下标就会
  // 把四转书开给二转，或者把三转书锁掉。
  assert.equal(arm.slice, expected, `书 ${book} 的臂指向 ${arm.slice}，按分支该指向 ${expected}`);
  assert.equal(
    arm.from, tier,
    `书 ${book}（层级 ${tier}）的臂从 [${arm.from}..] 起切 —— 层级与切片下标必须同号`,
  );
  rustJobs.set(book, branches[expected].slice(tier));
}

// ---------------------------------------------------------------------------
// 2. 客户端侧：transpile 后**执行** input.ts，拿到的才是真用的那张表
// ---------------------------------------------------------------------------
const ts = require(path.join(root, 'client/node_modules/typescript'));
const clientSrc = fs.readFileSync(path.join(root, 'client/src/features/player/input.ts'), 'utf8');
const clientJs = ts.transpileModule(clientSrc, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const clientModule = { exports: {} };
// input.ts 只有 `import type`（编译期擦除），所以这里不需要真的解析模块。
new Function('exports', 'module', clientJs)(clientModule.exports, clientModule);
const { BOOK_JOBS, bookAllowsJob, bookIdForSkill } = clientModule.exports;
assert.ok(BOOK_JOBS && bookAllowsJob && bookIdForSkill, 'input.ts 里读不到书准入权威（BOOK_JOBS / bookAllowsJob / bookIdForSkill）');

// ---------------------------------------------------------------------------
// 3. 双向逐格断言：书号清单、四转书清单，以及每本书 × 每个职业
// ---------------------------------------------------------------------------
const clientBookIds = Object.keys(BOOK_JOBS).map(Number).sort((a, b) => a - b);
assert.deepEqual(
  clientBookIds, [...rustBooks].sort((a, b) => a - b),
  '书号清单两份不一致：Rust 的 BOOKS 与客户端 BOOK_JOBS 的键必须完全一样',
);

// 四转书清单：客户端从三张 Shift 快捷表反推（谁有快捷行，谁就是四转书），
// 而不是再抄一份字面量 —— 抄一份就多一处能漂的。
const fourthFromShortcuts = new Set();
for (const name of ['FOURTH_SHORTCUT_SKILLS', 'FIRE_FOURTH_SHORTCUT_SKILLS', 'HOLY_FOURTH_SHORTCUT_SKILLS']) {
  const table = clientModule.exports[name];
  assert.ok(table && Object.keys(table).length > 0, `input.ts 里读不到 ${name}`);
  for (const skillId of Object.values(table)) {
    const book = Number(bookIdForSkill(skillId));
    assert(rustBooks.includes(book), `Shift 快捷表里的 ${skillId} 折出书号 ${book}，它不在 BOOKS 里`);
    fourthFromShortcuts.add(book);
  }
}
assert.deepEqual(
  [...fourthFromShortcuts].sort((a, b) => a - b), [...rustFourthBooks].sort((a, b) => a - b),
  '三条分支的四转书必须各有一张 Shift 快捷表，且与 Rust 的 FOURTH_JOB_BOOKS 一致',
);

// 书号从技能 id 派生：`book = skillId / 10000`（两侧同一口径）。
for (const book of rustBooks) {
  assert.equal(bookIdForSkill(book * 10000 + 1), String(book), `技能 id 派生不出书号 ${book}`);
}

// 全格对：只要有一侧多一格或少一格就红。探针里带上非转职法师外的职业号
// （100/112/999），确保两侧在「拒绝」这一侧也是同号的。
const probeJobs = [...new Set([...rustMageJobs, ...rustBeginnerJobs, 0, 100, 112, 999])];
const mismatched = [];
for (const book of rustBooks) {
  const rustAllowed = rustJobs.get(book) ?? [];
  for (const job of probeJobs) {
    const rust = rustAllowed.includes(job);
    const client = bookAllowsJob(String(book), job);
    if (rust !== client) mismatched.push(`书 ${book} × 职业 ${job}：Rust=${rust} 客户端=${client}`);
  }
}
assert.deepEqual(mismatched, [], `书准入两份实现不一致（共 ${mismatched.length} 格）：\n  ${mismatched.join('\n  ')}`);

// 唯一一处**刻意的**不对称：未登记的书（战士书 `100` / `112` / 不存在的 `999`）。
// Rust 侧只服务法师技能目录，未登记一律 `&[]`（拒绝）；
// 客户端技能窗还要渲染非法师书（战士的 `100` 永久被动，它的门控是
// `derivedStats.regenerationPassives.bookId` 而不是职业号），所以返回 true 放行。
// 这条差异被 `scripts/check_hud_skill_ui.mjs --regeneration` 依赖，不能顺手抹平；
// 这里把它钉死：哪一侧改了口径都会红。
for (const book of [100, 112, 999]) {
  assert(!rustJobs.has(book), `未登记的书 ${book} 不该出现在 Rust 准入表里`);
  assert.equal(bookAllowsJob(String(book), 112), true, `未登记的 ${book} 在客户端仍是「不限制职业」`);
}

console.log(
  'PASS 技能书准入：Rust book_jobs 与客户端 BOOK_JOBS 的 '
  + `${rustBooks.length} 本书 × ${probeJobs.length} 个职业逐格一致，`
  + `四转书 ${rustFourthBooks.join('/')} 各配一张 Shift 快捷表，`
  + '未登记的非法师书两侧差异（Rust 拒绝 / 客户端放行）仍被钉住。',
);
