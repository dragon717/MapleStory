#!/usr/bin/env node

// 门禁：伤害修正必须是**一条权威管线**——分组按源字段名唯一判定、取整只在末端一次、
// 上限只在声明处，且旧式手写乘算不许在任何伤害路径上复活。
//
// 背景（2026-09-17「伤害修正管线」）：改前「把百分比变成伤害数字」在服务端手写了 16 处，
// 散在四条路径上（`attacks.rs` 普通攻击 4 处、`skills.rs::magic_damage_with_passives` 9 处、
// 两个技能施放点的前置修正 3 处）。三件事没有任何一处说得清：
//
//   * **哪些加算、哪些独立乘算**：源 `damR`（伤害率）与源 `indieDamR`（独立伤害率）
//     被写进同一个百分比、乘在同一步里，而同一个 `indieDamR` 来源在普通攻击路径上
//     又是自己单独乘一次 ⇒ 同一个增益，两条路径两种口径；
//   * **取整在哪一层**：每一步 `.floor().max(1.0)`，只有区域系数用 `i128` 截断除法
//     ⇒ 结果与修正项的施加顺序有关（改前魔力無限在两条路径上的位置就不同）；
//   * **上限在哪一层**：`ignoreMobpdpR` 在调用点 clamp，`mdR`/`z`/`damR` 完全不 clamp。
//
// 断言分六组：
//   1. **解析自检**：分组表、组基准、防负数守卫必须能被本脚本解出来，且形状就是设计时
//      的那几种（解析不到就失败——门禁不许因为源码被改写而静默不检查）；
//   2. **分组按源字段名独立判定**：对每个 `DamageSource` 变体，按它对应的**源字段名**
//      推出期望分组，再与源码里 `group()` 的臂逐条比对（`damR`→加算、`indieDamR`→独立、
//      `criticaldamage`→暴击、无标记字段→独立）；
//   3. **内容 → 表**：对着真实 `shared/mage-skills.json` 重算「带 `damR` / `indieDamR` /
//      `criticaldamage` / `mdR` 的技能」各是哪些，逐条要求服务端把它们声明成对应来源
//      ——源里新增一个带分组的字段而没人做决定，这里就会红；
//   4. **旧式乘算不许复活**：全仓扫描，四类「把百分比乘进 damage」的形状只允许出现在
//      `damage.rs`（豁免 `monsters.rs` 的**玩家受伤**侧，带反向断言：豁免过期要失败）；
//   5. **取整与上限的位置**：`damage.rs` 里 `f64` 取整恰好一次（逐字保留的目标减免公式）、
//      有理数终点取整恰好两处、防负数守卫在、`resolve()` 没有逐项 floor；
//   6. **接线与协议**：`world.rs` 挂上模块、两条伤害路径都真的在用管线、两条路径用的是
//      同一个 `indieDamR` 访问器、区域系数都写成 `… - 100`；协议两处硬编码仍然一致。
//
// 本脚本从源码里读表，用的是窄正则 + 形状断言，不是「解析 Rust」。源码改写导致解不出来时，
// 第 1 组会失败，而不是让门禁悄悄地什么都不检查。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SERVER_SRC = path.join(ROOT, 'server/src');

const read = name => fs.readFileSync(path.join(SERVER_SRC, name), 'utf8');
/**
 * 去掉整行注释。门禁要数的是**代码里**出现过几次，不是文档里提过几次——
 * `damage.rs` 的模块头本身就写着「改前每一步都 `.floor().max(1.0)`」。
 */
const codeOnly = source =>
  source
    .split('\n')
    .filter(line => !line.trimStart().startsWith('//'))
    .join('\n');
const damageSrc = read('damage.rs');
const skillsSrc = read('skills.rs');
const attacksSrc = read('attacks.rs');
const combatRulesSrc = read('combat_rules.rs');
const worldSrc = read('world.rs');
const elementalsSrc = read('elemental.rs');
const monstersSrc = read('monsters.rs');
const protocolSrc = read('protocol.rs');
const sharedProtocol = fs.readFileSync(path.join(ROOT, 'shared/protocol.ts'), 'utf8');
const mageSkills = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/mage-skills.json'), 'utf8'));

// ---------------------------------------------------------------------------
// 1. 解析自检
// ---------------------------------------------------------------------------

/** `DamageSource::X { .. }` 的全部变体，按 enum 定义顺序。 */
const enumBody = /pub\(super\) enum DamageSource \{([\s\S]*?)\n\}/.exec(damageSrc);
assert.ok(enumBody, 'damage.rs 里读不到 DamageSource 的定义——形状变了，门禁不再有效');
const variants = [...enumBody[1].matchAll(/^\s{4}([A-Z]\w+)/gm)].map(match => match[1]);
assert.ok(
  variants.length >= 5,
  `DamageSource 只解出 ${variants.length} 个变体，形状变了`,
);

/** `DamageSource::group` 的臂：变体名 → 分组名。 */
const groupBody = /fn group\(self\) -> ModifierGroup \{([\s\S]*?)\n    \}/.exec(damageSrc);
assert.ok(groupBody, 'damage.rs 里读不到 DamageSource::group——两个方向的唯一定义处丢了');
const groupArms = new Map();
{
  const parts = groupBody[1].split('=>');
  for (let index = 0; index < parts.length - 1; index += 1) {
    const groupMatch = /ModifierGroup::(\w+)/.exec(parts[index + 1]);
    if (!groupMatch) continue;
    const named = [...parts[index].matchAll(/DamageSource::(\w+)/g)].map(match => match[1]);
    for (const name of named) groupArms.set(name, groupMatch[1]);
  }
}
assert.equal(
  groupArms.size, variants.length,
  `group() 覆盖了 ${groupArms.size} 个变体、enum 有 ${variants.length} 个——有变体没分组`,
);

/** `ModifierGroup::base_percent`：组基准。 */
const basePercentBody = /fn base_percent\(self\) -> i64 \{([\s\S]*?)\n    \}/.exec(damageSrc);
assert.ok(basePercentBody, 'damage.rs 里读不到 ModifierGroup::base_percent——组基准丢了');
const criticalBase = /ModifierGroup::Critical => (\d+)/.exec(basePercentBody[1]);
const plainBase = /ModifierGroup::AdditivePercent \| ModifierGroup::IndependentPercent => (\d+)/.exec(
  basePercentBody[1],
);
assert.ok(criticalBase && plainBase, 'ModifierGroup::base_percent 的臂形状变了');
assert.equal(
  Number(criticalBase[1]), 200,
  '暴击组的基准必须是 200（源 criticaldamage 是「在 200 之上再加」）',
);
assert.equal(Number(plainBase[1]), 100, '加算组 / 独立乘算组的基准必须是 100');

const floorGuard = /const MODIFIER_FLOOR_PERCENT: i64 = (-?\d+);/.exec(damageSrc);
assert.ok(floorGuard, 'damage.rs 里读不到防负数因子的守卫 MODIFIER_FLOOR_PERCENT');
assert.equal(Number(floorGuard[1]), -99, '防负数守卫应是 −99（因子 ≥ 1/100）');

// ---------------------------------------------------------------------------
// 2. 分组按源字段名独立判定
// ---------------------------------------------------------------------------

/**
 * 变体 → 它对应的**源字段名**。`null` = 源里没有分组标记的字段，
 * 以及不是玩家属性的区域系数。
 */
const SOURCE_FIELD = {
  DamageRate: 'damR',
  IndependentDamageRate: 'indieDamR',
  CriticalDamage: 'criticaldamage',
  UnmarkedField: null,
  FreezeLayerBonus: null,
  RegionGuard: null,
};
assert.deepEqual(
  [...groupArms.keys()].sort(), Object.keys(SOURCE_FIELD).sort(),
  'DamageSource 的变体集合变了：新增 / 删除变体必须同步这张「变体 → 源字段名」表',
);

/** 源字段名 → 期望分组。**这张表就是「哪些加算、哪些独立乘算」的口径**。 */
const groupForField = field => {
  if (field === 'damR') return 'AdditivePercent';
  if (field === 'criticaldamage') return 'Critical';
  // 源 `indieDamR`（独立伤害率）与**源里没有分组标记**的字段（`x`/`z`/`damage`/`mdR`）
  // 一律独立乘算：没有标记就不猜，沿用改前语义。
  return 'IndependentPercent';
};
for (const [variant, field] of Object.entries(SOURCE_FIELD)) {
  assert.equal(
    groupArms.get(variant), groupForField(field),
    `DamageSource::${variant}（源字段 ${field ?? '（无标记）'}）的分组不是 ${groupForField(field)}`,
  );
}

// ---------------------------------------------------------------------------
// 3. 内容 → 表（独立重算，不共用服务端任何代码）
// ---------------------------------------------------------------------------

/** 源技能表里带某字段的技能 id。 */
const catalogIdsWith = field =>
  Object.entries(mageSkills.skills)
    .filter(([, skill]) => skill.levels.some(level => level[field] !== undefined))
    .map(([id]) => id)
    .sort();

/** `const SKILL_X: u32 = 123;` → { X: 123 }。 */
const skillConst = new Map();
for (const match of worldSrc.matchAll(/const (SKILL_[A-Z0-9_]+): u32 = (\d+);/g)) {
  skillConst.set(match[1], Number(match[2]));
}
const constFor = id => {
  for (const [name, value] of skillConst) if (value === id) return name;
  return null;
};
/** 源码里的 `SKILL_X` 常量名 → id。解不出来就失败，绝不静默跳过。 */
const idForConst = name => {
  const id = skillConst.get(name);
  assert.ok(id !== undefined, `world.rs 里没有常量 ${name}`);
  return String(id);
};

const catalogDamR = catalogIdsWith('damR');
assert.ok(catalogDamR.length > 0, '源技能表里一个 damR 都没有？形状变了');

// 3a. `damR` 分两段被消费：非 Hyper 的常驻段（魔力激發）走 `is_magic_attack_skill` 闸门，
//     Hyper=1 的强化段（三本 Hyper 被动）走「配对 Hyper 强化」分支。两段都由内容独立重算。
const ampIds = catalogDamR.filter(id => mageSkills.skills[id].hyper === 0);
const hyperDamRIds = catalogDamR.filter(id => mageSkills.skills[id].hyper === 1);
assert.deepEqual(
  ampIds, ['2210001'],
  `源里 damR 的常驻段是 ${ampIds.join('/')}：这一段与 skills.rs 的「常驻被动」分支必须一一对应`,
);
for (const id of ampIds) {
  assert.ok(
    damageSourceMentions(id, 'DamageRate', skillsSrc),
    `源里 damR 的常驻段 ${id} 在 skills.rs 里没有 DamageRate 声明`,
  );
}
assert.ok(hyperDamRIds.length > 0, '源里一个 Hyper 强化段的 damR 都没有？形状变了');
// Hyper 强化段：`match skill_id { SKILL_A => SKILL_HYPER_B, ... }`，逐条要求
// 「被强化的技能」与「提供 damR 的那本被动」都能在源表里对上。
const hyperPairs = [...skillsSrc.matchAll(
  /(SKILL_[A-Z0-9_]+) => (SKILL_HYPER_[A-Z0-9_]+),/g,
)].map(match => [match[1], match[2]]);
const hyperPassiveIds = hyperPairs.map(([, passive]) => idForConst(passive)).sort();
assert.deepEqual(
  hyperPassiveIds, [...hyperDamRIds].sort(),
  `skills.rs 的 Hyper 强化分支覆盖 ${hyperPassiveIds.join('/')}，`
  + `源表里带 damR 的 Hyper 被动是 ${hyperDamRIds.join('/')}——源里新增一本就必须有人做决定`,
);
for (const [boosted, passive] of hyperPairs) {
  assert.ok(
    skillConst.has(boosted) && skillConst.has(passive),
    `Hyper 强化分支引用了不存在的常量 ${boosted} / ${passive}`,
  );
}

// 3b. `indieDamR`：唯一来源必须在**两条**伤害路径上都被声明为独立乘算。
const catalogIndie = catalogIdsWith('indieDamR');
assert.deepEqual(
  catalogIndie.length, 1,
  `源里 indieDamR 的来源从 1 个变成了 ${catalogIndie.length} 个：需要有人重新决定分组`,
);
const indieId = catalogIndie[0];
assert.ok(
  damageSourceMentions(indieId, 'IndependentDamageRate', skillsSrc)
  && damageSourceMentions(indieId, 'IndependentDamageRate', attacksSrc),
  `源里唯一的 indieDamR 来源 ${indieId} 必须在普通攻击与魔法技能两条路径上都声明为 IndependentDamageRate`,
);

// 3c. `criticaldamage`：只走暴击组。
const catalogCrit = catalogIdsWith('criticaldamage');
assert.ok(catalogCrit.length > 0, '源技能表里一个 criticaldamage 都没有？形状变了');
for (const id of catalogCrit) {
  assert.ok(
    damageSourceMentions(id, 'CriticalDamage', skillsSrc),
    `源里的 criticaldamage 技能 ${id} 在 skills.rs 里没有 CriticalDamage 声明`,
  );
}

// 3d. `mdR`：源里没有分组标记 ⇒ 必须报成 UnmarkedField，且 `field` 逐字写源字段名。
const catalogMdR = catalogIdsWith('mdR');
assert.ok(catalogMdR.length > 0, '源技能表里一个 mdR 都没有？形状变了');
for (const id of catalogMdR) {
  const constant = constFor(Number(id));
  assert.ok(constant, `源里的 mdR 技能 ${id} 在 world.rs 里没有常量`);
  assert.ok(
    new RegExp(
      `DamageSource::UnmarkedField \\{\\s*skill_id: ${constant},\\s*field: "mdR"`,
    ).test(skillsSrc),
    `源里的 mdR 技能 ${id} 必须声明为 UnmarkedField { field: "mdR" }（没有分组标记就不猜）`,
  );
}

/** 源里带分组标记的三个字段名——它们是「哪些加算、哪些独立乘算」的全部依据。 */
assert.deepEqual(
  ['damR', 'indieDamR', 'criticaldamage'].every(field => catalogIdsWith(field).length > 0),
  true,
  '源表里三个分组标记字段必须都真的存在，否则「按字段名判定」这条规则没有依据',
);

/**
 * 某技能 id 是否被声明成某类来源：先把它解析成 `world.rs` 里的常量名，
 * 再要求同一行附近出现 `DamageSource::<kind>` 与 `skill_id: SKILL_…`。
 */
function damageSourceMentions(id, kind, source) {
  const constant = constFor(Number(id));
  if (!constant) return false;
  const pattern = new RegExp(
    `DamageSource::${kind}\\s*\\{[\\s\\S]{0,120}?skill_id:\\s*${constant}`,
  );
  return pattern.test(source);
}

// ---------------------------------------------------------------------------
// 4. 旧式乘算不许复活
// ---------------------------------------------------------------------------

const MODIFIER_SHAPES = [
  { name: 'damR 类百分比乘算', re: /(?<![A-Za-z0-9_])damage as f64 \* \(100 \+/g },
  { name: '独立类百分比乘算', re: /(?<![A-Za-z0-9_])damage as f64 \* \(1\.0 \+/g },
  { name: '暴击乘算', re: /(?<![A-Za-z0-9_])damage as f64 \* \(200 \+/g },
  { name: '区域系数乘算', re: /(?<![A-Za-z0-9_])damage as i128 \* i128::from/g },
];

/**
 * 边界（正向登记，不是豁免）：**玩家受伤**侧不在本模块范围内。
 * `monsters.rs` 的护盾 / 魔心防禦抵偿是另一条通道，统一它需要先核定 TMS273 的受伤公式，
 * 源里没有 ⇒ 本轮不碰。这条断言把「确实没被顺手改掉」钉住，也把边界写进可执行的地方。
 */
assert.ok(
  /reduced_damage as i128 \* i128::from\(MAGIC_GUARD_COVERED_PERCENT\)/.test(monstersSrc),
  '玩家受伤侧的护盾抵偿公式不该在本轮被改（damage.rs 模块头登记为边界）',
);

const rustFiles = fs
  .readdirSync(SERVER_SRC)
  .filter(name => name.endsWith('.rs') && !name.includes(' '));
for (const dir of ['auth', 'lobby']) {
  const nested = path.join(SERVER_SRC, dir);
  if (!fs.existsSync(nested)) continue;
  for (const name of fs.readdirSync(nested)) {
    if (name.endsWith('.rs') && !name.includes(' ')) rustFiles.push(`${dir}/${name}`);
  }
}

const offenders = [];
for (const name of rustFiles) {
  // 验收文件与测试夹具不算伤害路径（它们会故意构造旧形状做反例）。
  if (name === 'damage.rs') continue;
  if (name.includes('acceptance') || name === 'world_tests.rs') continue;
  const source = read(name);
  for (const shape of MODIFIER_SHAPES) {
    const hits = source.match(shape.re);
    if (hits) offenders.push(`${name}: ${shape.name} × ${hits.length}`);
  }
}
assert.deepEqual(
  offenders, [],
  `伤害乘算只允许出现在 damage.rs：\n  ${offenders.join('\n  ')}`,
);

// 反向：管线必须真的被两条路径用上，否则第 4 组是空转。
for (const [name, source] of [['attacks.rs', attacksSrc], ['skills.rs', skillsSrc]]) {
  assert.ok(
    /DamagePipeline::new\(/.test(source),
    `${name} 没有构造伤害管线——第 4 组会空转`,
  );
  assert.ok(
    /DamageSource::/.test(source),
    `${name} 没有声明任何修正来源——第 4 组会空转`,
  );
}
assert.ok(
  /DamagePipeline::new\(/.test(combatRulesSrc) === false,
  'combat_rules.rs 不该构造管线：普通攻击的基准（区间 + 等级差 + PDD）留在那里',
);
assert.ok(
  /magic_damage_(with_passives|breakdown)\(/.test(elementalsSrc),
  'elemental.rs 的元素场也必须走同一条魔法管线（经 magic_damage_* 入口）',
);

// ---------------------------------------------------------------------------
// 5. 取整与上限的位置
// ---------------------------------------------------------------------------

const damageCode = codeOnly(damageSrc);
const floorCount = (damageCode.match(/\.floor\(\)/g) ?? []).length;
assert.equal(
  floorCount, 1,
  `damage.rs 里 f64 取整出现 ${floorCount} 次，应当恰好 1 次（逐字保留的目标减免公式）`,
);
const terminalCount = (damageCode.match(/\(\*?num \/ \*?den\)/g) ?? []).length;
assert.equal(
  terminalCount, 2,
  `damage.rs 里有理数终点取整出现 ${terminalCount} 次，应当恰好 2 次（诊断投影 + 权威 total）`,
);
assert.ok(
  /fn resolve\(self\) -> DamageBreakdown/.test(damageSrc)
  && !/for \(source, percent\) in self\.independent \{[^}]*floor/.test(damageSrc),
  'resolve() 里不允许逐项取整',
);
assert.ok(
  /fn apply_target_mitigation/.test(damageSrc),
  'damage.rs 必须显式承担目标侧减免，否则「取整在哪一层」没有完整答案',
);

// ---------------------------------------------------------------------------
// 6. 接线与协议
// ---------------------------------------------------------------------------

assert.ok(
  /#\[path = "damage\.rs"\]\nmod damage;/.test(worldSrc),
  'world.rs 没有挂上 damage 模块',
);
assert.ok(/use self::damage::\*;/.test(worldSrc), 'world.rs 没有 glob 导入 damage 的内容');
assert.ok(
  /fn magic_damage_with_passives\([\s\S]{0,800}?\.total\(\)/.test(skillsSrc),
  'magic_damage_with_passives 必须是 magic_damage_breakdown(...).total() 的取值包装，不是第二套实现',
);
assert.ok(
  (skillsSrc.match(/fn magic_damage_breakdown\(/g) ?? []).length === 1,
  'magic_damage_breakdown 只能有一处定义',
);
const accessorDefs = [...rustFiles].filter(name => {
  const source = read(name);
  return /fn hyper_adventurer_damage_percent\(/.test(source);
});
assert.deepEqual(
  accessorDefs, ['damage.rs'],
  `indieDamR 的取值访问器必须只在 damage.rs 定义一处，实际出现在 ${accessorDefs.join('/')}`,
);
for (const [name, source] of [['attacks.rs', attacksSrc], ['skills.rs', skillsSrc]]) {
  assert.ok(
    /hyper_adventurer_damage_percent\(/.test(source),
    `${name} 必须通过同一个访问器取 indieDamR，否则两条路径会静默分叉`,
  );
}
assert.equal(
  (attacksSrc.match(/boss_damage_multiplier\([^)]*\)\s*- 100/g) ?? []).length, 1,
  'attacks.rs 的区域系数必须写成 `boss_damage_multiplier(..) - 100`（百分点，负数表示减伤）',
);
assert.equal(
  (skillsSrc.match(/boss_damage_multiplier\([^)]*\)\s*- 100/g) ?? []).length, 1,
  'skills.rs 的区域系数必须写成 `boss_damage_multiplier(..) - 100`',
);

const protocolVersion = /pub const PROTOCOL_VERSION: u32 = (\d+);/.exec(protocolSrc);
const sharedVersion = /PROTOCOL_VERSION\s*=\s*(\d+)/.exec(sharedProtocol);
assert.ok(protocolVersion && sharedVersion, '读不到协议版本常量——两处硬编码的规则被改写了');
assert.equal(
  protocolVersion[1], sharedVersion[1],
  `协议版本两处硬编码不一致：server/src/protocol.rs=${protocolVersion[1]}、shared/protocol.ts=${sharedVersion[1]}`,
);
// 解释串只在开发态往 stderr 写，**不许**沾到 wire：协议两侧连它的名字都不该出现。
// 这里按大小写不敏感扫「管线 / 留痕 / 追踪开关」三族名字——只认一个驼峰写法的话，
// `_DamageEvent { damageBreakdown }` 这种改个大小写就能绕过（扰动验证实测过）。
for (const [name, source] of [['server/src/protocol.rs', protocolSrc], ['shared/protocol.ts', sharedProtocol]]) {
  assert.ok(
    !/breakdown|explain\s*\(|MAPLE_DAMAGE_TRACE|DamagePipeline/i.test(source),
    `${name} 里出现了伤害解释/管线的名字：留痕只走 stderr，不许进协议`,
  );
}

console.log('[damage-pipeline] ok');
console.log(
  `  分组：${[...groupArms.entries()].map(([v, g]) => `${v}→${g}`).join('、')}`,
);
console.log(
  `  源表重算：damR=${catalogDamR.join('/')}、indieDamR=${catalogIndie.join('/')}、`
  + `criticaldamage=${catalogCrit.join('/')}`,
);
console.log(
  `  旧式乘算：0 处（玩家受伤侧按边界正向登记，未纳入管线）`,
);
