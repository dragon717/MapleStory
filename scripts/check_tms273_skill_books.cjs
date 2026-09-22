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
// 2026-09-22 目录扩到四条职业线 35 本后，Rust 侧的准入不再用「每本书一条分支臂」
// 写死，而是从四张职业表（WARRIOR/MAGE/BOWMAN/THIEF_JOBS）**按布局切片派生**
// （`branch_jobs`：一转占第 0 项，其后每 3 个是一条分支）。门禁因此改验派生链的
// 每一环：分支臂把哪条分支映射到哪张表、基号差多少、切片公式长什么样——
// 形状对不上（表被换、顺序被重排、公式被改）都当场红，而不是静默放行。
//
// 判据是「转职层级」而不是「某一本书」，两侧都必须满足：
//   书号 = 职业号（`2201005 → 220`）；同层多条分支各自只认自己那一支；
//   低转职层级的书对同一分支的高转职职业继续有效（三转书四转照样能学）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// 1. Rust 侧：从 mage.rs 反解职业表常量与准入派生链的形状
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
const rustBeginnerJobs = constArray('BEGINNER_JOBS');
const rustJobsByTable = {
  WARRIOR_JOBS: constArray('WARRIOR_JOBS'),
  MAGE_JOBS: constArray('MAGE_JOBS'),
  BOWMAN_JOBS: constArray('BOWMAN_JOBS'),
  THIEF_JOBS: constArray('THIEF_JOBS'),
};

// `is_fourth_job_book` 的层级派生公式：`book % 100 >= 10 && book % 10 == 2`。
// 公式与常量必须互为同一张表：改公式而忘改常量（或反过来）在这里当场红。
const fourthFn = /pub fn is_fourth_job_book\(book: u32\) -> bool \{\s*([^}]*?)\n\}/.exec(rustSrc);
assert.ok(fourthFn, 'mage.rs 里读不到 is_fourth_job_book —— 层级派生没了依据');
assert.match(
  fourthFn[1], /book\s*%\s*100\s*>=\s*10\s*&&\s*book\s*%\s*10\s*==\s*2/,
  'is_fourth_job_book 的公式不再是「分支书且末位为 2」——它与 FOURTH_JOB_BOOKS 常量脱钩了',
);
const derivedFourthBooks = rustBooks.filter(book => book % 100 >= 10 && book % 10 === 2);
assert.deepEqual(
  derivedFourthBooks, [...rustFourthBooks].sort((a, b) => a - b),
  'FOURTH_JOB_BOOKS 常量与「按层级派生」的结果不一致',
);

// `book_branch` / `book_tier`：分支 = `book / 10`（仅分支书），层级 = `book % 10`。
assert.match(
  rustSrc, /pub fn book_branch\(book: u32\) -> Option<u32> \{\s*\(BOOKS\.contains\(&book\) && book % 100 >= 10\)\.then_some\(book \/ 10\)/,
  'book_branch 不再按「BOOKS 登记 && book%100>=10 → book/10」派生',
);
assert.match(
  rustSrc, /pub fn book_tier\(book: u32\) -> Option<u32> \{\s*book_branch\(book\)\.map\(\|_\| book % 10\)/,
  'book_tier 不再按「book%10」派生层级',
);

// `branch_jobs` 的分支臂：`11 | 12 | 13 => (&WARRIOR_JOBS[..], (branch - 11) as usize)`。
// 分支号 → 职业表 + 基号（该组第一条分支）。臂把分支映射到错表、或基号写错，
// 切片起点就会偏移——这里把每一臂都验死。
const branchJobsBody = /fn branch_jobs\(branch: u32, tier: u32\) -> &'static \[u32\] \{([\s\S]*?)\n\}/.exec(rustSrc);
assert.ok(branchJobsBody, 'mage.rs 里读不到 branch_jobs —— 布局切片派生没了依据');
const branchArms = new Map(); // 分支号 → { table, base }
for (const arm of branchJobsBody[1].matchAll(/(\d+(?:\s*\|\s*\d+)+)\s*=>\s*\(&(\w+)\[\.\.\],\s*\(branch\s*-\s*(\d+)\)/g)) {
  const [, list, table, base] = arm;
  for (const branch of list.split('|').map(part => Number(part.trim()))) {
    branchArms.set(branch, { table, base: Number(base) });
  }
}
assert.ok(branchArms.size === 10, `branch_jobs 的分支臂解出 ${branchArms.size} 条（应为 10：战 3 + 法 3 + 弓 2 + 侠 2）—— 正则与源码形状脱节了`);
// 每条分支的书必须都有臂接着：`11x/12x/13x → 11/12/13`，依次四条线。
for (const book of rustBooks) {
  if (book < 10 || book % 100 < 10) continue; // 初学者书与一转书不走分支臂
  const branch = Math.floor(book / 10);
  assert.ok(branchArms.has(branch), `分支 ${branch}（书 ${book}）在 branch_jobs 里没有分支臂 —— 加了书却没加准入`);
}
// 布局公式的两个下标必须还在：`start = 1 + 3*branch_index + tier`、
// 片段终点 `1 + 3*branch_index + 3`（一转占第 0 项 + 每分支 3 个转职）。
assert.match(
  branchJobsBody[1], /let start = 1 \+ 3 \* branch_index \+ tier as usize;/,
  'branch_jobs 的切片起点公式变了 —— 职业表布局被重排或公式被改，准入语义必须重验',
);
assert.match(
  branchJobsBody[1], /jobs\.get\(start\.\.1 \+ 3 \* branch_index \+ 3\)/,
  'branch_jobs 的切片终点公式变了 —— 层级切片的「本层及其后」语义必须重验',
);
// 同组三臂必须指向同一张表、基号必须是组内第一条分支（切片起点靠它对齐布局）。
const groups = new Map(); // 基号 → { branches, table }
for (const [branch, { table, base }] of branchArms) {
  const group = groups.get(base) ?? { branches: [], table };
  group.branches.push(branch);
  assert.equal(group.table, table, `分支 ${branch} 与同组分支指向了不同的职业表（${table} vs ${group.table}）`);
  groups.set(base, group);
}
for (const [base, { branches, table }] of groups) {
  // 组内分支数从职业表长度派生：一转占 1 项 + 每条分支 3 项。
  const expectedBranches = Array.from(
    { length: (rustJobsByTable[table].length - 1) / 3 },
    (_, index) => base + index,
  );
  assert.deepEqual(
    branches.sort((a, b) => a - b), expectedBranches,
    `基号 ${base} 的分支组 ${branches.join('/')} 与职业表布局不符 —— 切片按 (branch-base) 对齐，组有洞就会错位`,
  );
  const firstJob = rustJobsByTable[table][0];
  assert.equal(firstJob, (base - 1) * 10, `${table} 第 0 项应是该线的一转（${(base - 1) * 10}）—— 职业表顺序变了，切片全部错位`);
}

// `book_jobs` 的特例臂：初学者书与四条一转书各指一张表，分支书走 branch_jobs。
const bookJobsBody = /pub fn book_jobs\(book: u32\) -> &'static \[u32\] \{([\s\S]*?)\n\}/.exec(rustSrc);
assert.ok(bookJobsBody, 'mage.rs 里读不到 book_jobs —— 门禁不再知道准入表怎么算');
assert.match(
  bookJobsBody[1], /BEGINNER_BOOK\s*=>\s*&BEGINNER_JOBS/,
  'book_jobs 里初学者书不再指向 BEGINNER_JOBS',
);
for (const [book, table] of [[100, 'WARRIOR_JOBS'], [200, 'MAGE_JOBS'], [300, 'BOWMAN_JOBS'], [400, 'THIEF_JOBS']]) {
  assert.match(
    bookJobsBody[1], new RegExp(`${{100: 'WARRIOR', 200: 'MAGE', 300: 'BOWMAN', 400: 'THIEF'}[book]}_BOOK\\s*=>\\s*&${table}`),
    `book_jobs 里一转书 ${book} 不再指向 ${table}`,
  );
}
assert.match(
  bookJobsBody[1], /book_branch\(book\)\.zip\(book_tier\(book\)\)\s*\{\s*Some\(\(branch, tier\)\) => branch_jobs\(branch, tier\),\s*None => &\[\]/,
  'book_jobs 的分支臂不再走 branch_jobs(book_branch, book_tier) 派生，或未登记书不再是空集',
);

// 按反解出的派生链**执行**出每本书的职业集合。
const rustJobs = new Map();
rustJobs.set(0, rustBeginnerJobs);
for (const [book, table] of [[100, 'WARRIOR_JOBS'], [200, 'MAGE_JOBS'], [300, 'BOWMAN_JOBS'], [400, 'THIEF_JOBS']]) {
  rustJobs.set(book, rustJobsByTable[table]);
}
for (const book of rustBooks) {
  if (rustJobs.has(book)) continue;
  const branch = Math.floor(book / 10);
  const { table, base } = branchArms.get(branch);
  const jobs = rustJobsByTable[table];
  const branchIndex = branch - base;
  const tier = book % 10;
  const start = 1 + 3 * branchIndex + tier;
  rustJobs.set(book, jobs.slice(start, 1 + 3 * branchIndex + 3));
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

// 四转书清单：客户端从**已接执行链**的那些 Shift 快捷表反推（2026-09-22 只有
// 法师三条分支接了四转主动，其余七本四转书如实登记为「未接执行链」，
// 快捷表等执行链落地时再加）。反推出的书号集合必须 ⊆ Rust 的 FOURTH_JOB_BOOKS，
// 且恰好等于其中法师线（基号 21/22/23）那一部分；新分支接线后这里会红，
// 提醒人把它的快捷表也收进门禁，而不是静默扩权。
const fourthFromShortcuts = new Set();
for (const name of ['FOURTH_SHORTCUT_SKILLS', 'FIRE_FOURTH_SHORTCUT_SKILLS', 'HOLY_FOURTH_SHORTCUT_SKILLS']) {
  const table = clientModule.exports[name];
  assert.ok(table && Object.keys(table).length > 0, `input.ts 里读不到 ${name}`);
  for (const skillId of Object.values(table)) {
    const book = Number(bookIdForSkill(skillId));
    assert(rustFourthBooks.includes(book), `Shift 快捷表里的 ${skillId} 折出书号 ${book}，它不在 FOURTH_JOB_BOOKS 里`);
    fourthFromShortcuts.add(book);
  }
}
const mageFourthBooks = rustFourthBooks.filter(book => {
  const branch = Math.floor(book / 10);
  return branch >= 21 && branch <= 23;
}).sort((a, b) => a - b);
assert.deepEqual(
  [...fourthFromShortcuts].sort((a, b) => a - b), mageFourthBooks,
  '法师三线的四转书必须各有一张 Shift 快捷表，且与 Rust 的 FOURTH_JOB_BOOKS 的法师子集一致；'
  + '其它线的四转书接了执行链后，把它的快捷表加进上面的名单',
);

// 书号从技能 id 派生：`book = skillId / 10000`（两侧同一口径）。
for (const book of rustBooks) {
  assert.equal(bookIdForSkill(book * 10000 + 1), String(book), `技能 id 派生不出书号 ${book}`);
}

// 全格对：只要有一侧多一格或少一格就红。探针带上全部 35 个已登记职业号
// （BEGINNER_JOBS 就是这份全集），再加初学者 `0` 与未登记的 `500/999`，
// 确保两侧在「拒绝」这一侧也是同号的。
const probeJobs = [...new Set([...rustBeginnerJobs, 0, 500, 999])];
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

// 唯一一处**刻意的**不对称：未登记的书（如不存在的 `999`、未导出的影武者 `2112`）。
// Rust 侧只服务本包的技能目录，未登记一律 `&[]`（拒绝）；
// 客户端技能窗对表里没有的书沿用「不限制职业」的旧行为（它的门控在别处，
// 如战士书 `100` 的永久被动走 `derivedStats.regenerationPassives.bookId`）。
// 这条差异被 `scripts/check_hud_skill_ui.mjs --regeneration` 依赖，不能顺手抹平；
// 这里把它钉死：哪一侧改了口径都会红。
for (const book of [999, 2112]) {
  assert(!rustJobs.has(book), `未登记的书 ${book} 不该出现在 Rust 准入表里`);
  assert.equal(bookAllowsJob(String(book), 112), true, `未登记的 ${book} 在客户端仍是「不限制职业」`);
}

console.log(
  'PASS 技能书准入：Rust book_jobs（四张职业表 × branch_jobs 布局切片派生）与客户端 BOOK_JOBS 的 '
  + `${rustBooks.length} 本书 × ${probeJobs.length} 个职业逐格一致，`
  + `四转书 ${rustFourthBooks.join('/')} 与层级公式互证，`
  + `法师线四转快捷表钉住 ${mageFourthBooks.join('/')}，`
  + '未登记的书两侧差异（Rust 拒绝 / 客户端放行）仍被钉住。',
);
