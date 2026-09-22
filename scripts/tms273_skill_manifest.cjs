// Project source exports into the small client-facing skill view contract.
// This does not grant skills or infer the still-unverified SP group mapping.
const assert = require('node:assert/strict');
const { evaluate } = require('./tms273_skill_formulas.cjs');

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENGLISH_UNITS = new Set(['MP', 'HP', 'ms']);
const BEGINNER_LEVEL_FIELDS = new Set(['mpCon', 'fixdamage', 'x', 'time', 'speed', 'cooltime']);

/**
 * 运行期契约的**标量整数字段** —— 与 `server/src/mage.rs::MageLevel` 的 `Option<i64>` /
 * `Option<u32>` 字段逐字对应（`check_tms273_skill_manifest.cjs` 从 Rust 源码重算这张表并
 * 双向比对，漏改一边就红）。
 *
 * 为什么需要这张表：源公式**可以算出小数**。参考实现 `WzComparerR2.Common/Calculator.cs`
 * 用 `decimal`，`/` 是精确除法 —— 例如 `2311003 神聖祈禱` 的 `common.x = "20+u(x*3)/2"`
 * 在奇数级算得 `21.5`。而运行期契约的标量是整数，所以「算出小数怎么办」必须在**投影边界**
 * 决定，而不是让 JSON 带小数、等到 Rust 反序列化时才炸（2026-09-21 就是这么炸的）。
 * 决定：**四舍五入（`.5` 远离零）**，源串仍原样留在 `rawCommon`；本模块之外的数值一律原样
 * 带出（例如 `t`/`ar`/`nbdR` 这些运行期未登记的字段），因为舍入它们只会丢信息。
 */
const RUNTIME_INTEGER_FIELDS = new Set([
  'mpCon', 'z', 'costmpR', 'damR', 'criticaldamage', 'subProp', 'mdR', 'cooltime',
  'cooldownMs', 'mpSubstitutePercent', 'asrR', 'terR', 'stanceProp', 'madX', 'bufftimeR',
  'basicStatUp', 'attackDelay', 'ignoreMobpdpR', 'hcHp', 'speed', 'q', 'q2', 'indieDamR',
  'targetPlus', 'w2', 'u2', 'mmpR', 'lv2mmp', 'actionSpeed', 'mastery', 'cr', 'intX',
  'indieMad', 'subTime', 's', 'pddX', 'x', 'y', 'prop', 'fixdamage', 'time', 'v', 'w', 'u',
  'psdSpeed', 'speedMax', 'range', 'mobCount', 'damage', 'attackCount',
  'maxUseCountInOneJump',
]);

/** 投影一个标量：运行期契约的整数字段四舍五入，其余字段原样带出。 */
function projectScalar(field, value) {
  if (Number.isSafeInteger(value)) return value;
  if (!RUNTIME_INTEGER_FIELDS.has(field)) return value;
  return Math.round(value);
}

// 用户指定规则（2026-09-10）——**不是 TMS273 原版数值**，替换为核定来源前请保留这条记录。
// 「瞬間移動」2001009：全等级消耗一样都是 10 MP，不同等级的区别在距离和 CD。
// 原版对照：本地 Skill/200.json#2001009 的 common 为 mpCon "30-2*x"（28/26/24/22/20）、
// x "115+15*x"、y "270+5*x"、psdSpeed/speedMax，且**没有 cooltime 字段**；
// maplestorywiki 与台服 V271/V280 攻略一致（满级 20 MP、无冷却）。
// 因此 mpCon 与 cooldownMs 只覆盖运行时数值与技能窗文案，rawCommon/sourceMetadata 仍写源记录。
// cooldownMs 是用户指定下的 P 值（2026-09-13 校准：1级800ms→满级50ms，随等级递减），只改这一处；
// cooldownMs 同时注入模板渲染，effect 里的 #cooldownMs 会按级展开成「800ms」等。
//
// 用户指定规则（2026-09-12）——**不是 TMS273 原版数值**，替换为核定来源前请保留这条记录。
// 「魔心防禦」2001002：受伤的 99%（服务端 world.rs 的 MAGIC_GUARD_COVERED_PERCENT）
// 转由 MP 承受，逐级的「MP 抵偿率」是下面的阶梯；抵偿率化不去的部分**由护盾消解**，
// 未被转走的那 1% 才落回 HP。原版对照：本地 Skill/200.json#2001002 的 common 为
// x "15+7*x"（22→85，含义是「以 MP 代替的伤害百分比」）、mpCon "8+u(x/2)"，
// info/switchDamtoMP=1。用户指定的 99% + 抵偿率阶梯与原版无关，故 rawCommon 继续写源记录，
// 投影值另起字段 mpSubstitutePercent（服务端结算读它，技能窗文案由同表驱动）。
const USER_SPECIFIED_SKILL_RULES = {
  '2001009': {
    mpCon: 10,
    cooldownMs: [800, 650, 450, 250, 50],
    effect: '消耗MP #mpCon，朝左右瞬移#x、上下瞬移#y，冷却 #cooldownMsms。\n'
      + '[被动效果：移动速度 +#psdSpeed、最大移动速度 +#speedMax]',
    description: '瞬间移动一段距离，配合方向键可朝该方向瞬移；冷却随等级缩短（800ms→50ms）。'
      + '被动永久增加移动速度、最大移动速度。\n'
      + '5级以上才能学习3转技能「瞬间移动精通」「瞬间移动爆发」。',
  },
  '2001002': {
    // 1 级 100%、每级 -2，10 级正好 80（用户指定）。
    fields: { mpSubstitutePercent: [100, 98, 96, 94, 92, 90, 88, 86, 84, 80] },
    effect: '消耗MP #mpCon。受伤的99%转由魔力承受，以#mpSubstitutePercent%抵偿率化去；'
      + '化不尽的由护盾消解，1%由生命承担。',
    description: '受伤的99%转由魔力承受：按等级抵偿率化去，化不尽的由护盾消解，仅1%落到生命；'
      + '魔力不足时欠缺部分由生命承担。抵偿率随等级递减（100%→80%），越高越省魔。'
      + '对按最大HP比例的攻击无效。开关技能。',
  },
};

// 只覆盖投影出去的数值（levels / 技能窗文案），不动 entry.common 这份源记录。
// rule.fields 的键必须与源字段区分开（如 mpSubstitutePercent），避免把用户指定的
// 数值伪装成源公式；值可以是逐级数组（长度必须等于 maxLevel）。
function runtimeCommon(entry) {
  const rule = USER_SPECIFIED_SKILL_RULES[entry.id];
  if (!rule) return entry.common;
  const common = { ...entry.common };
  if (rule.mpCon !== undefined) common.mpCon = rule.mpCon;
  // 冷却也进模板渲染上下文，供技能窗文案按级展开（mageRules 仍走专用的 cooldownMs 覆盖路径）。
  if (rule.cooldownMs !== undefined) common.cooldownMs = rule.cooldownMs;
  for (const [field, value] of Object.entries(rule.fields ?? {})) {
    assert(IDENTIFIER.test(field), `invalid user-specified field name: ${entry.id}/${field}`);
    if (Array.isArray(value)) {
      const maxLevel = Number(entry.maxLevel);
      assert(value.length === maxLevel && value.every(item => Number.isSafeInteger(item)),
        `invalid user-specified per-level field: ${entry.id}/${field}`);
    }
    common[field] = value;
  }
  return common;
}

function scalarFields(common) {
  return Object.keys(common ?? {})
    .filter(field => IDENTIFIER.test(field))
    .filter(field => typeof common[field] === 'string'
      || typeof common[field] === 'number'
      || Array.isArray(common[field]))
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function levelFieldValue(common, field, level) {
  const source = common[field];
  const value = Array.isArray(source)
    ? source[level - 1]
    : typeof source === 'string' ? evaluate(source, level) : source;
  assert(Number.isFinite(value), `non-finite description value: ${field} at level ${level}`);
  return value;
}

function renderLevelDescription(template, common, level) {
  const fields = scalarFields(common);
  return template.replace(/#([A-Za-z_][A-Za-z0-9_]*)/g, (marker, token) => {
    const field = fields.find(candidate => token === candidate
      || (token.startsWith(candidate) && ENGLISH_UNITS.has(token.slice(candidate.length))));
    if (!field) return marker;
    return `${levelFieldValue(common, field, level)}${token.slice(field.length)}`;
  });
}

function levelDescriptions(entry, maxLevel) {
  // 用户指定规则可以整体替换技能窗文案；模板仍由同一张表驱动，
  // 所以源记录、投影数值与技能窗文案之间不会各自漂移。
  const template = USER_SPECIFIED_SKILL_RULES[entry.id]?.effect ?? entry.string?.h;
  if (template !== undefined && template !== null) {
    assert(typeof template === 'string', `invalid description template: ${entry.id}`);
    const common = runtimeCommon(entry);
    return Array.from({ length: maxLevel }, (_, index) => renderLevelDescription(template, common, index + 1));
  }
  // Skill/000.img's three beginner skills already provide one source-backed
  // String row per level (h1/h2/h3). Keep the wording verbatim; these rows
  // describe fixed damage/healing/speed values and must not be interpreted as
  // the mage four-field levelValues schema.
  const explicit = Array.from({ length: maxLevel }, (_, index) => entry.string?.[`h${index + 1}`]);
  if (explicit.some(value => value !== undefined && value !== null)) {
    assert(explicit.every(value => typeof value === 'string'), `incomplete level descriptions: ${entry.id}`);
    return explicit;
  }
  return undefined;
}

// 技能窗的页签是「转职层级」，不是「技能书」：同一层级的多本书**共用同一个页签下标**，
// 实际显示哪一本由角色职业决定——门控在 `client/src/features/player/input.ts` 的
// BOOK_JOBS 表里，两处必须一起改。
// 下标上界来自源：`UI/UIWindow2.img/Skill/main/Tab` 只有 7 组页签图
// （`export_tms273_skill_ui.cjs` 的 TAB_COUNT=7），所以只允许 0..6。
// **层级由书号派生，不写死书名**（skill §15.1）：一转书是 `100/200/300/400`
// （`book % 100 === 0`，页签 1），分支书按 `book % 10` 分层——0 二转→页签 2、
// 1 三转→页签 3、2 四转→页签 4。新分支只会多一本书，不会多一个层级；
// 反过来，把新分支的下标顺延到 5/6 会超出页签图范围，退化成无美术的占位按钮。
const BEGINNER_BOOK_ID = 0;
const FIRST_JOB_BOOKS = [100, 200, 300, 400];
const BRANCH_BOOKS = [
  110, 111, 112, 120, 121, 122, 130, 131, 132, // 战士：英雄 / 圣骑士 / 黑骑士
  210, 211, 212, 220, 221, 222, 230, 231, 232, // 法师：火毒 / 冰雷 / 主教
  310, 311, 312, 320, 321, 322, // 弓箭手：猎人 / 神射手
  410, 411, 412, 420, 421, 422, // 飞侠：刺客 / 侠盗
];
const ALL_BOOKS = [BEGINNER_BOOK_ID, ...FIRST_JOB_BOOKS, ...BRANCH_BOOKS].sort((a, b) => a - b);

function skillBookTabIndex(book) {
  if (book === BEGINNER_BOOK_ID) return 0;
  if (FIRST_JOB_BOOKS.includes(book)) return 1;
  const tier = book % 10;
  assert(book % 100 >= 10 && tier >= 0 && tier <= 2, `书 ${book} 解不出转职层级（页签下标）`);
  return tier + 2;
}

const SKILL_BOOK_TABS = Object.fromEntries(ALL_BOOKS.map(book => [String(book), skillBookTabIndex(book)]));

/** 四转的十二条分支：Hyper 池、`(mobCount, attackCount)` 上界等「按层级分档」的判据都看它。
 *  按层级派生（`book % 10 === 2 && book % 100 >= 10`），与 `server/src/mage.rs` 同一口径。 */
const FOURTH_JOB_BOOKS = new Set(
  ALL_BOOKS.filter(book => book % 100 >= 10 && book % 10 === 2).map(String),
);
assert.equal(FOURTH_JOB_BOOKS.size, 10, '四转书应当是 战士3 + 法师3 + 弓箭手2 + 飞侠2 = 10 本');

// 四转书 → 源里 Hyper **主动池**（hyper=2）的条数。**源事实，不是按分支推的**：
// 被动池（hyper=1）十二条分支都是 9 条；主动池却有 3 条与 4 条两种
// （英雄/神射手/箭神/夜使者/暗影神偷/开拓者各 3，圣骑士/黑骑士/火毒/冰雷/主教各 4），
// 写成「一律 4」或「一律 3」都会在某几本上直接红。键集合必须与 FOURTH_JOB_BOOKS 完全一致。
const HYPER_ACTIVE_POOL = {
  112: 4, 122: 4, 132: 3,
  212: 3, 222: 4, 232: 4,
  312: 3, 322: 3,
  412: 3, 422: 3,
};
assert.deepEqual(
  Object.keys(HYPER_ACTIVE_POOL).sort(), [...FOURTH_JOB_BOOKS].sort(),
  'HYPER_ACTIVE_POOL 与四转书集合不一致：加了四转书必须同时登记它的主动池条数',
);

function skillManifest(windowExport, skillExport) {
  assert.equal(windowExport.sourceVersion, 'TMS273.7');
  assert.equal(skillExport.sourceVersion, 'TMS273.7');
  assert(skillExport.catalog, 'skill catalog export is missing');
  const skillBooks = {};
  // 双向闭包：表里有下标却导不出书、或导出了书却没登记下标，都在这里断掉。
  assert.deepEqual(
    Object.keys(skillExport.catalog.books).sort(),
    Object.keys(SKILL_BOOK_TABS).sort(),
    'exported skill books and the tab table disagree',
  );
  for (const [id, book] of Object.entries(skillExport.catalog.books)) {
    assert(Object.prototype.hasOwnProperty.call(SKILL_BOOK_TABS, id), `unmapped skill book: ${id}`);
    skillBooks[id] = { name: book.name, tabIndex: SKILL_BOOK_TABS[id] };
  }
  const skillCatalog = {};
  for (const [id, entry] of Object.entries(skillExport.catalog.skills)) {
    assert(skillBooks[entry.book], `unknown book for ${id}`);
    const maxLevel = Number(entry.maxLevel);
    assert(Number.isSafeInteger(maxLevel) && maxLevel > 0 && maxLevel <= 100, `invalid maxLevel: ${id}`);
    const prerequisites = {};
    for (const [requiredId, rawLevel] of Object.entries(entry.req ?? {})) {
      const level = Number(rawLevel);
      assert(/^\d+$/.test(requiredId) && Number.isSafeInteger(level) && level > 0, `invalid prerequisite: ${id}`);
      prerequisites[requiredId] = level;
    }
    const hyper = Number(entry.sourceFields?.hyper ?? 0);
    const requiredLevel = Number(entry.sourceFields?.reqLev ?? 0);
    assert([0, 1, 2].includes(hyper), `unknown Hyper pool: ${id}`);
    assert(Number.isSafeInteger(requiredLevel) && requiredLevel >= 0 && requiredLevel <= 200, `invalid skill level gate: ${id}`);
    // Hyper 池判据按**层级**：212／222／232 三条四转分支同形（源里各 12 条 Hyper，
    // 满级 1、门槛 ≥140）。写成 `book === '222'` 会在火毒／主教四转进来时把它们整本
    // 判成非法 —— 与 `mage.rs` 的同一处判据必须一起改。
    assert(!hyper || (FOURTH_JOB_BOOKS.has(entry.book) && maxLevel === 1 && requiredLevel >= 140), `invalid Hyper source: ${id}`);
    const invisible = entry.displayFlags.source.invisible;
    assert(invisible === null || ['0', '1'].includes(String(invisible)), `unknown invisible flag: ${id}`);
    const descriptions = levelDescriptions(entry, maxLevel);
    const rule = USER_SPECIFIED_SKILL_RULES[id];
    skillCatalog[id] = {
      id, bookId: entry.book, name: entry.name,
      description: rule?.description ?? entry.description ?? '',
      maxLevel, prerequisites, hidden: Number(invisible) === 1,
      hyper, requiredLevel,
      icons: Object.fromEntries(Object.entries(entry.icons).filter(([, frame]) => frame !== null)),
      ...(descriptions ? { levelDescriptions: descriptions } : {}),
      ...(skillExport.skills[id]?.levelValues ? { levelValues: skillExport.skills[id].levelValues } : {}),
    };
  }
  return { skillWindow: windowExport.window, skillBooks, skillCatalog };
}

function mageRules(skillExport) {
  assert.equal(skillExport.sourceVersion, 'TMS273.7');
  const skills = {};
  for (const entry of Object.values(skillExport.catalog.skills).filter(entry => Object.prototype.hasOwnProperty.call(SKILL_BOOK_TABS, entry.book))) {
    const maxLevel = Number(entry.maxLevel);
    assert(Number.isSafeInteger(maxLevel) && maxLevel > 0 && maxLevel <= 100);
    const common = runtimeCommon(entry);
    const levels = entry.book === '0'
      ? Array.from({ length: maxLevel }, (_, i) => {
        const row = entry.sourceFields?.level?.[String(i + 1)];
        assert(row && typeof row === 'object', `missing beginner level row ${entry.id}/${i + 1}`);
        return Object.fromEntries(Object.entries(row)
          .filter(([key]) => BEGINNER_LEVEL_FIELDS.has(key))
          .map(([key, value]) => {
          if (value && typeof value === 'object') return [key, value];
          if (typeof value === 'number') return [key, projectScalar(key, value)];
          if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return [key, projectScalar(key, Number(value))];
          return [key, value];
        }));
      })
      : Array.from({ length: maxLevel }, (_, i) => Object.fromEntries(
        Object.entries(common).filter(([key]) => key !== 'maxLevel').map(([key, value]) => {
          // 用户指定的逐级数组直接按级取用；源公式仍走 evaluate。
          if (Array.isArray(value)) {
            const result = value[i];
            assert(Number.isFinite(result), `invalid mage field ${entry.id}/${key}`);
            return [key, result];
          }
          if (typeof value === 'object') return [key, value];
          const result = typeof value === 'number' ? value : evaluate(value, i + 1);
          assert(Number.isFinite(result), `invalid mage field ${entry.id}/${key}`);
          return [key, projectScalar(key, result)];
        }),
      ));
    const userRule = USER_SPECIFIED_SKILL_RULES[entry.id];
    if (userRule?.cooldownMs) {
      assert(entry.book !== '0'
        && Array.isArray(userRule.cooldownMs)
        && userRule.cooldownMs.length === maxLevel
        && userRule.cooldownMs.every(value => Number.isSafeInteger(value) && value >= 0),
      `invalid user cooldown override: ${entry.id}`);
      levels.forEach((level, index) => { level.cooldownMs = userRule.cooldownMs[index]; });
    }
    skills[entry.id] = { name: entry.name, bookId: Number(entry.book), maxLevel,
      elemAttr: entry.sourceFields?.elemAttr ?? null,
      fixedLevel: Number(entry.displayFlags.source.fixLevel) === 1,
      boosterActionSpeed: entry.displayFlags.source.psdWeaponBooster?.actionSpeed === undefined ? null : Number(entry.displayFlags.source.psdWeaponBooster.actionSpeed),
      prerequisites: Object.fromEntries(
      Object.entries(entry.req ?? {}).map(([id, level]) => [id, Number(level)])),
      hidden: Number(entry.displayFlags.source.invisible) === 1, levels,
      hyper: Number(entry.sourceFields?.hyper ?? 0),
      requiredLevel: Number(entry.sourceFields?.reqLev ?? 0),
      source: entry.source?.skillImage ?? `Skill/${entry.book}.img/skill/${entry.id}`,
      rawCommon: entry.common,
      rawLevels: entry.sourceFields?.level ?? null,
      // Preserve source-only fields such as summon.attack1.info, changeSkill,
      // cooldown and hidden variant markers for the runtime owner.  This is
      // metadata, not an execution decision or an SP grant.
      sourceMetadata: entry.sourceFields ?? {},
    };
  }
  assert.equal(skills['2001009']?.name, '瞬間移動', 'user-specified rule 2001009 no longer maps to 瞬間移動');
  // 分书条数由 `export_tms273_skills.cjs` 的 expectedCatalogCounts 逐书钉住（唯一权威）；
  // 这里只钉总数与「书集合 == 页签表」的闭包，用来发现「整本书静默掉出投影」。
  // 总数 = 153(法师 11 本) + 351(战士 10 + 弓箭手 7 + 飞侠 7 本)，改任何一本都要重新数。
  assert.equal(Object.keys(skills).length, 504, 'explorer skill count changed');
  assert.deepEqual(
    [...new Set(Object.values(skills).map(skill => String(skill.bookId)))].sort(),
    Object.keys(SKILL_BOOK_TABS).sort(),
    '投影出去的书集合与页签表不一致',
  );
  return { sourceVersion: 'TMS273.7', bookId: 200, skills };
}

module.exports = { skillManifest, mageRules, SKILL_BOOK_TABS, FOURTH_JOB_BOOKS, HYPER_ACTIVE_POOL, RUNTIME_INTEGER_FIELDS };
