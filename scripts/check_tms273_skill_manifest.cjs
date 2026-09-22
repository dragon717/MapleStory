const { evidencePath } = require('./evidence-path.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  skillManifest, mageRules, RUNTIME_INTEGER_FIELDS, SKILL_BOOK_TABS, FOURTH_JOB_BOOKS, HYPER_ACTIVE_POOL,
} = require('./tms273_skill_manifest.cjs');
const root = path.resolve(__dirname, '..');
const input = path.join(root, 'resources/tms273-export');
const read = name => JSON.parse(fs.readFileSync(path.join(input, `${name}.json`), 'utf8'));
const skills = read('skills');
const rules = mageRules(skills);

// ---------------------------------------------------------------------------
// 契约：投影出去的 `levels` 必须能被运行期模型直接反序列化
// ---------------------------------------------------------------------------
//
// 背景（2026-09-21）：火毒 / 僧侶 两条分支上线后，`2311003 神聖祈禱` 的源 `common.x` 是
// `20+u(x*3)/2`，参考实现（`Wcr2 Calculator.cs`，decimal）在奇数级算得 **21.5**，于是
// `shared/mage-skills.json` 里出现了小数，Rust 侧 `MageLevel` 的 `Option<i64>` 直接
// 「invalid type: floating point 21.5, expected i64」——**整个技能目录都读不进来**。
//
// 判据有两条，都必须独立成立：
//   1. 「运行期契约的整数字段」这张表 == `server/src/mage.rs::MageLevel` 的 `Option<i64>`
//      / `Option<u32>` 字段（camelCase 后）——漏登记一个字段，源里出现小数就会重演；
//   2. 产出的 `levels` 里，凡属这张表的标量**必须**是安全整数（投影边界已按四舍五入决定）。
const mageSrc = fs.readFileSync(path.join(root, 'server/src/mage.rs'), 'utf8');
const camel = name => name.replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase());
const structBody = /pub struct MageLevel \{([\s\S]*?)\n\}/.exec(mageSrc);
assert.ok(structBody, 'mage.rs 里读不到 MageLevel —— 运行期契约的字段表没了依据');
const rustRenames = new Map();
const rustIntegerFields = [];
const rustObjectFields = [];
{
  let rename = null;
  for (const raw of structBody[1].split('\n')) {
    const line = raw.trim();
    const renamed = /^#\[serde\(rename = "([^"]+)"\)\]$/.exec(line);
    if (renamed) { rename = renamed[1]; continue; }
    const field = /^pub ([a-z0-9_]+): Option<(i64|u32)>,?$/.exec(line);
    if (field) {
      rustRenames.set(field[1], rename ?? camel(field[1]));
      rustIntegerFields.push(rename ?? camel(field[1]));
      rename = null;
      continue;
    }
    // 对象字段（坐标）：`MagePoint` 内部是 `f64`，**允许**小数，不进整数契约。
    const object = /^pub ([a-z0-9_]+): Option<MagePoint>,?$/.exec(line);
    if (object) {
      rustObjectFields.push(object[1]);
      rename = null;
      continue;
    }
    if (line === '' || line.startsWith('//') || line.startsWith('#[')) continue;
    // 形状变了（例如某个标量被改成 `Option<f64>` 或加了属性）：必须有人重新决定。
    throw new Error(`MageLevel 出现了本判据解不出来的行：${line}`);
  }
}
assert.deepEqual(
  rustObjectFields.sort(), ['lt', 'lt2', 'rb', 'rb2'],
  'MageLevel 的对象字段变了：只有坐标（lt/rb 与第二命中盒 lt2/rb2）允许小数，'
  + '新增对象字段要重新决定它属不属于整数契约',
);
assert.deepEqual(
  [...RUNTIME_INTEGER_FIELDS].sort(), [...rustIntegerFields].sort(),
  '清单里的「运行期整数字段」与 mage.rs 的 MageLevel 不一致'
  + '——两边漏一边，源里出现小数就会再次冲到 Rust 反序列化',
);
assert.equal(new Set(rustIntegerFields).size, rustIntegerFields.length, 'MageLevel 里有重名字段');

const levelScalars = [];
for (const [id, skill] of Object.entries(rules.skills)) {
  for (const [index, level] of skill.levels.entries()) {
    for (const [field, value] of Object.entries(level)) {
      if (value === null || typeof value === 'object') continue;
      levelScalars.push({ id, index, field, value });
    }
  }
}
const fractional = levelScalars.filter(
  row => RUNTIME_INTEGER_FIELDS.has(row.field) && !Number.isSafeInteger(row.value),
);
assert.deepEqual(
  fractional, [],
  `投影出去的整数字段里出现了非整数：\n  ${fractional.map(r => `${r.id}/${r.index}/${r.field}=${r.value}`).join('\n  ')}`,
);

// 反向：源里确实有「算出小数」的公式，投影边界确实把它四舍五入掉了（不是这条判据空转）。
const holySymbol = rules.skills['2311003'];
assert.equal(holySymbol.rawCommon.x, '20+u(x*3)/2', '2311003 的源 x 公式变了——四舍五入的依据要重核');
assert.equal(holySymbol.levels[0].x, 22, '2311003 的 x 投影不是四舍五入（源 21.5）');
assert.deepEqual(
  holySymbol.levels.map(level => level.x),
  [22, 23, 25, 26, 28, 29, 31, 32, 34, 35, 37, 38, 40, 41, 43, 44, 46, 47, 49, 50],
  '2311003 的逐级 x 序列变了：源是 20+u(x*3)/2（奇数级 .5），投影按四舍五入',
);
// 运行期未登记的字段**原样带出**（舍入它们只会丢信息）：`2111013 劇毒領域` 的 `common.t` 是 `0.4`。
assert.equal(rules.skills['2111013'].levels[0].t, 0.4, '非契约字段必须原样带出，不许跟着一起取整');

// 2026-09-22 目录扩到四条职业线：法师 153 条 + 战士/弓/飞侠 351 条 = **504 条**。
assert.equal(Object.keys(rules.skills).length, 504);
// ── 四转十条分支对称（每本书 × Hyper 池按**源事实**钉住）────────────────────
// 书分布是源节点数（与导出器 expectedCatalogCounts 同一张表），不是按分支对称
// 推出来的——弓箭手 320 一转 8 条而飞侠 400 一转 10 条这类差异是源自己的形状。
// 主动池条数读 HYPER_ACTIVE_POOL（键集合已与 FOURTH_JOB_BOOKS 互证）。
{
  const byBook = {};
  for (const skill of Object.values(rules.skills)) byBook[skill.bookId] = (byBook[skill.bookId] ?? 0) + 1;
  assert.deepEqual(byBook, {
    0: 3, 100: 7, 110: 8, 111: 8, 112: 24, 120: 8, 121: 9, 122: 27, 130: 9, 131: 9, 132: 30,
    200: 8, 210: 10, 211: 11, 212: 24, 220: 9, 221: 12, 222: 24, 230: 10, 231: 15, 232: 27,
    300: 8, 310: 12, 311: 11, 312: 24, 320: 8, 321: 12, 322: 30, 400: 10, 410: 12, 411: 9, 412: 27, 420: 10, 421: 12, 422: 27,
  });
  for (const [bookId, count] of Object.entries(byBook)) {
    const hyper = Object.values(rules.skills).filter(skill => String(skill.bookId) === bookId && skill.hyper > 0);
    // 只有四转书带 Hyper 池。被动池（hyper=1）十条分支都是 9 条；主动池（hyper=2）
    // 逐本条数见 HYPER_ACTIVE_POOL——**源节点数就是这样**（火毒 3、冰雷 4、
    // 英雄 4、黑騎士 3……），不是按分支对称推出来的。
    const passive = hyper.filter(skill => skill.hyper === 1).length;
    const active = hyper.filter(skill => skill.hyper === 2).length;
    if (FOURTH_JOB_BOOKS.has(bookId)) {
      assert.equal(passive, 9, `${bookId} 的 Hyper 被动池不是 9 条`);
      assert.equal(active, HYPER_ACTIVE_POOL[bookId], `${bookId} 的 Hyper 主动池条数变了`);
    } else {
      assert.equal(hyper.length, 0, `${bookId} 不是四转书却带 Hyper 池`);
    }
    for (const skill of hyper) {
      assert.equal(skill.maxLevel, 1, `${skill.name} 的 Hyper 满级不是 1`);
      assert.ok(skill.requiredLevel >= 140, `${skill.name} 的 Hyper 门槛低于 140`);
    }
  }
  // 页签下标是「转职层级」：四转**共用**下标 4、三转 3、二转 2、一转 1、初学者 0
  // （源 UIWindow2 只有 7 组页签图，0..6，顺延就超界）。SKILL_BOOK_TABS 已按层级派生，
  // 这里把「同层同下标」的语义逐层钉死。
  const booksByTier = tab => Object.keys(SKILL_BOOK_TABS).filter(book => SKILL_BOOK_TABS[book] === tab).map(Number).sort((a, b) => a - b);
  assert.deepEqual(booksByTier(0), [0], '初学者书页签必须是 0');
  assert.deepEqual(booksByTier(1), [100, 200, 300, 400], '一转四本书的页签必须共用 1');
  assert.deepEqual(
    booksByTier(2), [110, 120, 130, 210, 220, 230, 310, 320, 410, 420],
    '二转十本书的页签必须共用 2',
  );
  assert.deepEqual(
    booksByTier(3), [111, 121, 131, 211, 221, 231, 311, 321, 411, 421],
    '三转十本书的页签必须共用 3',
  );
  assert.deepEqual(
    booksByTier(4), [...FOURTH_JOB_BOOKS].map(Number).sort((a, b) => a - b),
    '四转书的页签必须共用 4，顺延到 5/6 会超出源页签图范围',
  );
  assert.equal(Object.keys(SKILL_BOOK_TABS).length, 35, '页签表应恰好覆盖 35 本书');
  // fixLevel：转职任务按它发固定技能（`shared/job-advance.json` 的 reward.skills 依赖这条）。
  assert.equal(rules.skills['2120014'].fixedLevel, true, '2120014 元素強化 必须是源 fixLevel 技能');
  assert.equal(rules.skills['2320013'].fixedLevel, true, '2320013 祝福旋律 必须是源 fixLevel 技能');
  assert.equal(rules.skills['2120014'].maxLevel, 1);
  assert.equal(rules.skills['2320013'].maxLevel, 1);
  // 冷却与消耗：四转的这两条是源里**真带 cooltime/mpCon** 的，逐条钉住（数值来自源公式）。
  // 源串 `600-60*x`（秒）→ 1 级 540 秒、5 级 300 秒；两条分支同式同值。
  assert.equal(rules.skills['2121008'].levels[0].cooltime, 540, '2121008 楓葉淨化 的冷却变了');
  assert.equal(rules.skills['2121008'].levels[4].cooltime, 300, '2121008 楓葉淨化 满级冷却变了（600-60*x）');
  assert.equal(rules.skills['2121008'].levels[0].mpCon, 30);
  assert.equal(rules.skills['2321009'].levels[0].cooltime, 540);
  assert.equal(rules.skills['2321009'].levels[4].cooltime, 300);
  assert.equal(rules.skills['2321009'].levels[0].mpCon, 30);
  assert.equal(rules.skills['2121052'].levels[0].cooltime, 50, '2121052 藍焰斬 冷却变了');
  assert.equal(rules.skills['2121052'].levels[0].mpCon, 500);
}
assert.equal(rules.skills['2001008'].levels[19].damage, 78);
assert.equal(rules.skills['2201008'].bookId, 220);
assert.equal(rules.skills['2201008'].levels[19].damage, 199);
assert.equal(rules.skills['2201005'].levels[9].mobCount, 6);
assert.equal(rules.skills['2200011'].fixedLevel, true);
assert.equal(rules.skills['2200012'].boosterActionSpeed, -2);
assert.equal(rules.skills['2200006'].levels[8].cr, 5);
// 極速詠唱三本分支的源加速值都在 `psdWeaponBooster.actionSpeed`（-2），必须**逐本**成立：
// 服务端按 `BOOSTER_SKILLS` 逐本读它，只断言冰雷那一本会让另外两条分支静默丢掉攻速。
assert.deepEqual(
  ['2200012', '2100011', '2300011'].map(id => rules.skills[id].boosterActionSpeed),
  [-2, -2, -2],
  '極速詠唱三本分支的 boosterActionSpeed 必须都能被投影出来',
);

assert.equal(rules.skills['2001002'].levels[0].mpCon, 9);
assert.equal(rules.skills['2001002'].levels[9].x, 85);
// 用户指定规则（2026-09-12）：魔心防禦的结算改用逐级「MP 抵偿率」阶梯，
// 源 x（15+7*x = 22→85，含义是「以 MP 代替的伤害百分比」）继续原样留在投影与源记录里。
assert.deepEqual(rules.skills['2001002'].levels.map(level => level.mpSubstitutePercent),
  [100, 98, 96, 94, 92, 90, 88, 86, 84, 80]);
assert.equal(rules.skills['2001002'].rawCommon.x, '15+7*x');
assert.equal(rules.skills['2001009'].levels[4].y, 295);
// 用户指定规则（2026-09-10）：瞬移全等级 10 MP + 等级冷却；原版记录保留在 rawCommon。
assert.deepEqual(rules.skills['2001009'].levels.map(level => level.mpCon), [10, 10, 10, 10, 10]);
assert.deepEqual(rules.skills['2001009'].levels.map(level => level.cooldownMs), [800, 650, 450, 250, 50]);
assert.equal(rules.skills['2001009'].rawCommon.mpCon, '30-2*x');
assert.equal(rules.skills['2001009'].levels[4].x, 190);
assert.equal(rules.skills['2000006'].levels[19].lv2mmp, 120);
assert.deepEqual(rules.skills['2000010'].prerequisites, { '2001002': 3 });
assert.equal(rules.skills['2001012'].hidden, true);
assert.deepEqual(rules.skills['2001008'].levels[0].lt, skills.catalog.skills['2001008'].common.lt);
const invalidRules = structuredClone(skills);
invalidRules.catalog.skills['2000006'].common.actionSpeed = 'unknown()';
assert.throws(() => mageRules(invalidRules));
const windowExport = read('windows-skills');
const sourceDescription = skills.catalog.skills['2200011'].string.h;
const projected = skillManifest(windowExport, skills);
assert.equal(Object.keys(projected.skillCatalog).length, 504);
assert.equal(Object.keys(projected.skillBooks ?? {}).length, 35, '技能窗书目录应恰好 35 本');
assert.deepEqual(projected.skillCatalog['2000010'].prerequisites, { '2001002': 3 });
assert.deepEqual(projected.skillCatalog['2200000'].prerequisites, { '2200006': 5 });
assert.deepEqual(projected.skillCatalog['2201001'].prerequisites, { '2200000': 3 });
assert.equal(projected.skillCatalog['2001008'].levelDescriptions[19], '消耗MP24，最多對4名的敵人以78%的傷害值進行攻擊4次');
// 用户指定规则（2026-09-12）：技能窗文案同表驱动，99% 为固定比例、抵偿率逐级 100→80，
// 抵偿率化不去的差额由护盾消解（不是回落 HP），HP 只承担未被接下的那 1%。
assert.equal(projected.skillCatalog['2001002'].levelDescriptions[9],
  '消耗MP 13。受伤的99%转由魔力承受，以80%抵偿率化去；化不尽的由护盾消解，1%由生命承担。');
assert.equal(projected.skillCatalog['2001002'].levelDescriptions[0],
  '消耗MP 9。受伤的99%转由魔力承受，以100%抵偿率化去；化不尽的由护盾消解，1%由生命承担。');
assert.match(projected.skillCatalog['2001002'].description, /99%转由魔力承受/);
assert.match(projected.skillCatalog['2001002'].description, /由护盾消解/);
assert.match(projected.skillCatalog['2001002'].description, /仅1%落到生命/);
assert.doesNotMatch(projected.skillCatalog['2001002'].description, /守恒/);
// 源文案本身不得被改写（同 2200011 的源记录断言）。
assert.equal(skills.catalog.skills['2001002'].string.h, '消耗MP #mpCon，啟用期間受到的傷害的#x%以MP代替。');
assert.match(projected.skillCatalog['2001009'].levelDescriptions[4], /消耗MP 10，朝左右瞬移190、上下瞬移295，冷却 50ms/);
assert.match(projected.skillCatalog['2001009'].levelDescriptions[0], /消耗MP 10，朝左右瞬移130、上下瞬移275，冷却 800ms/);
assert.match(projected.skillCatalog['2001009'].description, /800ms→50ms/);
assert.match(projected.skillCatalog['2201008'].levelDescriptions[0], /冰凍8秒。$/);
assert.match(projected.skillCatalog['2200011'].levelDescriptions[0], /#c爆擊傷害值增加2%/);
assert.equal(Object.hasOwn(projected.skillCatalog['2001012'], 'levelDescriptions'), false);
assert.equal(skills.catalog.skills['2200011'].string.h, sourceDescription);

const unknown = structuredClone(skills);
unknown.catalog.skills['2200011'].string.h = '#c#unknown #xyz #x';
assert.equal(skillManifest(windowExport, unknown).skillCatalog['2200011'].levelDescriptions[0], '#c#unknown #xyz 2');

const invalidFormula = structuredClone(skills);
invalidFormula.catalog.skills['2001002'].common.mpCon = 'invalid()';
assert.throws(() => skillManifest(windowExport, invalidFormula), /unknown identifier 'invalid'/);

const changed = structuredClone(skills);
changed.catalog.skills['2001008'].displayFlags.source.invisible = '0';
assert.equal(skillManifest(windowExport, changed).skillCatalog['2001008'].hidden, false);
changed.catalog.skills['2001008'].displayFlags.source.invisible = '1';
assert.equal(skillManifest(windowExport, changed).skillCatalog['2001008'].hidden, true);
changed.catalog.skills['2001008'].displayFlags.source.invisible = 'unknown';
assert.throws(() => skillManifest(windowExport, changed));
console.log('PASS: 504 source skills across 35 books, level descriptions, prerequisites, level values, explicit invisible flag values, the user-specified teleport rule, and the runtime-integer contract (projection rounds fractional source formulas).');

if (process.argv.includes('--browser-fixture')) {
  const output = evidencePath('skills-check');
  fs.mkdirSync(path.join(output, 'assets'), { recursive: true });
  const assets = path.join(output, 'assets/tms273');
  if (!fs.existsSync(assets)) fs.symlinkSync(path.join(input, 'assets/tms273'), assets, 'dir');
  const current = JSON.parse(fs.readFileSync(path.join(root, 'client/public-tms273/assets/manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(output, 'assets/manifest.json'), JSON.stringify({ ...projected, closeButton: current.closeButton }), 'utf8');
  require('../client/node_modules/esbuild').build({
    entryPoints: [path.join(root, 'qa/skills_ui.ts')], bundle: true, format: 'esm',
    target: 'es2022', outfile: path.join(output, 'skills-check.js'),
  }).then(() => {
    fs.writeFileSync(path.join(output, 'skills-check.html'), '<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Skills UI check</title><link rel="stylesheet" href="/skills-check.css"><script type="module" src="/skills-check.js"></script></html>', 'utf8');
    console.log('Fixture ready in the dated evidence directory');
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
