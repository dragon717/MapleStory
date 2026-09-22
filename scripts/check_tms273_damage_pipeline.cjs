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

/**
 * `const NAME: [u32; N] = [SKILL_A, SKILL_B];` → 成员常量名。
 *
 * 火毒 / 僧侶两条分支上线后，「同一格」来源从 1 本变成 2~3 本。逐本 `skill_id: SKILL_…`
 * 硬编码会写成重复代码块、且新增分支时容易漏掉某一段；所以消费统一写成
 * `for skill_id in NAME`，**成员清单留在 `world.rs` 的数据表里**，门禁按成员逐个重算。
 */
const skillArrays = new Map();
for (const match of worldSrc.matchAll(
  /const ([A-Z][A-Z0-9_]*): \[u32; (\d+)\] = \[([\s\S]*?)\];/g,
)) {
  skillArrays.set(match[1], {
    declared: Number(match[2]),
    members: [...match[3].matchAll(/(SKILL_[A-Z0-9_]+)/g)].map(hit => hit[1]),
  });
}
const idsForArray = name => {
  const entry = skillArrays.get(name);
  assert.ok(entry, `world.rs 里没有数组常量 ${name}`);
  assert.equal(
    entry.declared, entry.members.length,
    `${name} 的长度标注是 ${entry.declared}，实际条目 ${entry.members.length} 个`,
  );
  return entry.members.map(idForConst).sort();
};
/** 「逐本消费」的形状：循环头绑定这张表，体内按同一个 `DamageSource` 变体声明。 */
const assertLoopedSource = (array, kind, extra = '') => {
  const looped = new RegExp(`for (?:amp|reset|critical)_skill in ${array} \\{`).test(skillsSrc);
  assert.ok(looped, `skills.rs 没有按 \`for … in ${array}\` 逐本消费——新增分支会静默漏掉`);
  const shape = new RegExp(
    `DamageSource::${kind} \\{\\s*skill_id: [a-z_]+${extra},?\\s*\\}`,
  );
  assert.ok(
    shape.test(skillsSrc),
    `skills.rs 的 ${array} 消费没有按 DamageSource::${kind} 声明来源`,
  );
};

const catalogDamR = catalogIdsWith('damR');
assert.ok(catalogDamR.length > 0, '源技能表里一个 damR 都没有？形状变了');

/**
 * 「源里有这个字段、但本包**明确不**接入伤害管线」的技能 —— 逐条登记，并写清理由。
 *
 * 共同根因：212 火毒 / 232 主教 这两本**四转**在本包是**目录型**内容——它们的攻击技能
 * 在 `handle_cast_skill` 的主分发里落到 `_ => {}`（没有施法分支），伤害管线永远不会以
 * 这些 skill_id 被调用。凡是**依附于施法/增益窗**的字段因此消费不了：不是漏接线，
 * 是它所依附的那条路径还不存在。
 *
 * 反向断言：每条登记都要求「被依附的技能在 world.rs 里**没有**常量」（= 确实没接路径）。
 * 哪天有人给它起了常量、接了施法分支，这条立刻红，要求同时把消费补上——而不是静默跳过。
 */
const NOT_CONSUMED = {
  // Hyper 强化被动：damR 只在「被强化的那一招打出去」时才生效。
  // 三本四转书的强化被动现**全部接通**：冰雷 2220043/2220046/2220049 与火毒
  // 2120043/2120046/2120049 都在 `skills.rs::magic_damage_breakdown` 的
  // 「被强化技能 → 强化被动」配对表里（`hyperPairs` 会逐条从源码解出并断言）。
  // 2026-09-22 目录并入四条职业线后，物理线四转书的 Hyper 强化被动（17 本）也带
  // damR，但它们依附于**物理四转主动技能**的施放——物理执行链未接（如实登记），
  // 所以逐本登记为不消费；物理执行链落地时这里会红，要求同时补上配对消费。
  damR: Object.fromEntries(
    Object.entries(mageSkills.skills)
      .filter(([, skill]) => skill.hyper === 1 && skill.levels.some(level => level.damR !== undefined))
      .filter(([id]) => { const book = Math.floor(Number(id) / 10000); return book < 200 || book >= 300; })
      .map(([id]) => [id, {
        why: '物理线四转书的 Hyper 强化被动：damR 只在「被强化的那一招打出去」时生效，依附于一条**被强化技能 → 强化被动**的配对表；本包物理分支只接了直接伤害（`PHYSICAL_AREA_ATTACKS`），没有这张配对表 ⇒ 消费不了。接 Hyper 配对消费时必须同时删掉这条登记。',
      }]),
  ),
  // Hyper 主动增益：indieDamR / mdR 是「窗口内」的值，必须先有施法与增益窗。
  // 2026-09-22 起物理线的 傳說冒險（7 本）与 專注弱點/翻轉硬幣 也带窗口内 indieDamR，
  // 依附于物理四转主动的施放（未接执行链）⇒ 按源表动态登记。
  indieDamR: {
    '2121053': { boosted: '2121053', why: '傳說冒險（火毒）' },
    '2321053': { boosted: '2321053', why: '傳說冒險（主教）' },
    ...Object.fromEntries(
      Object.entries(mageSkills.skills)
        .filter(([, skill]) => skill.hyper === 2 && skill.levels.some(level => level.indieDamR !== undefined))
        .filter(([id]) => { const book = Math.floor(Number(id) / 10000); return book < 200 || book >= 300; })
        .map(([id, skill]) => [id, {
          boosted: id,
          why: `${skill.name}（物理线 Hyper 主动）：indieDamR 是施放窗口内的值，必须先有增益窗；本包物理分支只接了直接伤害（PHYSICAL_AREA_ATTACKS），没有窗口状态 ⇒ 消费不了。接增益窗时必须同时补上独立乘算声明。`,
        }]),
    ),
  },
  // `criticaldamage`（暴击伤害）的消费管线只在魔法路径（skills.rs 的暴击组，
  // MAGIC_CRITICAL_SKILLS）。物理线 14 本来源（武器精通族 / 鬥氣爆發 / 轉生 等）的
  // 暴击伤害没有物理暴击管线 ⇒ 逐本登记不消费；其中若干本（武器精通族）的 mastery
  // 已由 MASTERY_SKILLS 消费，用 hasConstant 豁免常量反向断言。物理暴击路径落地时
  // 这里会红，要求重新决定分组。
  criticaldamage: Object.fromEntries(
    Object.entries(mageSkills.skills)
      .filter(([, skill]) => skill.levels.some(level => level.criticaldamage !== undefined))
      .filter(([id]) => { const book = Math.floor(Number(id) / 10000); return book < 200 || book >= 300; })
      .map(([id, skill]) => [id, {
        hasConstant: constFor(Number(id)) !== null,
        why: `${skill.name}：criticaldamage 是暴击伤害组，消费点只存在于魔法路径（MAGIC_CRITICAL_SKILLS 循环）；物理攻击路径没有暴击管线 ⇒ 这一个字段消费不了。物理暴击路径落地时必须重新决定。`,
      }]),
  ),
  mdR: {
    '2321054': { boosted: '2321054', why: '復仇天使' },
  },
};
/** 某个字段里「登记不消费」的 id 集合。 */
const excusedIds = field => Object.keys(NOT_CONSUMED[field] ?? {}).sort();
/** 某个字段里真正要被消费的 id 集合（源表重算 − 登记表）。 */
const consumedIds = field =>
  catalogIdsWith(field).filter(id => !excusedIds(field).includes(id));
/** 反向断言：登记表里的每一条都必须「真的没接路径」，且理由非空。
 *  `hasConstant: true` 的条目豁免常量反向断言——用于「部分字段消费」的技能
 *  （其它字段已由别的槽位消费，这一个字段的管线不存在）。 */
const assertExcused = field => {
  for (const [id, entry] of Object.entries(NOT_CONSUMED[field] ?? {})) {
    assert.ok(entry.why, `${field} 的 ${id} 登记为「不消费」却没写理由`);
    if (entry.hasConstant) continue;
    for (const id2 of new Set([id, entry.boosted])) {
      assert.equal(
        constFor(Number(id2)), null,
        `${field} 的 ${id} 登记为「不消费」，但 world.rs 已经给 ${id2} 起了常量 `
          + `${constFor(Number(id2))}——接了路径就必须同时补上消费，或把这条登记删掉`,
      );
    }
  }
};

// 3a. `damR` 分两段被消费：非 Hyper 的常驻段（魔力激發）走 `is_magic_attack_skill` 闸门，
//     Hyper=1 的强化段（三本 Hyper 被动）走「配对 Hyper 强化」分支。两段都由内容独立重算。
//     2026-09-22 目录并入四条职业线后，常驻段多出三本**物理线**来源：物理攻击路径
//     （attacks.rs 的普攻区间 + 等级差 + PDD）没有伤害率组，这三本的 damR 消费不了，
//     逐条登记理由（其中 1120003 的 mastery 已由 MASTERY_SKILLS 消费——「部分字段
//     消费」用 hasConstant 豁免常量反向断言）。物理伤害率组随物理技能执行链落地时，
//     这里会要求把消费补上。
const PERSISTENT_DAMR_NOT_CONSUMED = {
  '1110013': {
    why: '英雄三转 鬥氣綜合 的 damR 依附斗气（combo）系统：prop/subProp 是发动几率与叠加层数，damR 是「斗气攒满那一击」的加成；本包未实现斗气 ⇒ 消费不了。',
  },
  '1120003': {
    hasConstant: true,
    why: '進階鬥氣 的 damR 依附斗气系统（同 1110013），本包未实现 ⇒ 这一个字段消费不了；它的 mastery 已由 MASTERY_SKILLS 消费（world.rs 有常量 SKILL_ADVANCED_COMBO），属于「部分字段消费」——常量反向断言对它豁免。',
  },
  '3210015': {
    why: '弩弓手二转 射擊術 的 damR 是常驻物理攻击伤害率；本包物理攻击路径没有伤害率组（加算组只在魔法路径 magic_damage_breakdown）⇒ 消费不了。它的 ar / ignoreMobpdpR 同样只在魔法路径有消费点。物理技能执行链落地时必须重新决定。',
  },
};
const ampIds = catalogDamR.filter(id => mageSkills.skills[id].hyper === 0);
const hyperDamRIds = catalogDamR.filter(id => mageSkills.skills[id].hyper === 1);
for (const [id, entry] of Object.entries(PERSISTENT_DAMR_NOT_CONSUMED)) {
  assert.ok(entry.why, `damR 常驻段的 ${id} 登记为「不消费」却没写理由`);
  if (!entry.hasConstant) {
    assert.equal(
      constFor(Number(id)), null,
      `damR 常驻段的 ${id} 登记为「不消费」，但 world.rs 已给它起常量 ${constFor(Number(id))}——接了路径就必须同时补消费`,
    );
  }
}
assert.deepEqual(
  ampIds, ['2110001', '2210001', ...Object.keys(PERSISTENT_DAMR_NOT_CONSUMED)].sort(),
  `源里 damR 的常驻段是 ${ampIds.join('/')}：与 skills.rs 的「常驻被动」分支 + 登记表必须一一对应`,
);
// 常驻段被消费的两本（冰雷 2210001 / 火毒 2110001）绑在 `ELEMENT_AMP_SKILLS` 上，
// 由「成员 == 源表重算结果 − 登记表」+「循环头绑定这张表」+「体内按统一变体声明」
// 三件一起钉住。
assert.deepEqual(
  idsForArray('ELEMENT_AMP_SKILLS'),
  ampIds.filter(id => !PERSISTENT_DAMR_NOT_CONSUMED[id]),
  `world.rs 的 ELEMENT_AMP_SKILLS 成员是 ${idsForArray('ELEMENT_AMP_SKILLS').join('/')}，`
  + `源里 damR 的常驻段（扣除登记表）是 ${ampIds.filter(id => !PERSISTENT_DAMR_NOT_CONSUMED[id]).join('/')}——新增一本分支就必须同时改这张表`,
);
assertLoopedSource('ELEMENT_AMP_SKILLS', 'DamageRate');
assert.ok(hyperDamRIds.length > 0, '源里一个 Hyper 强化段的 damR 都没有？形状变了');
// Hyper 强化段：`match skill_id { SKILL_A => SKILL_HYPER_B, ... }`，逐条要求
// 「被强化的技能」与「提供 damR 的那本被动」都能在源表里对上。
const hyperPairs = [...skillsSrc.matchAll(
  /(SKILL_[A-Z0-9_]+) => (SKILL_HYPER_[A-Z0-9_]+),/g,
)].map(match => [match[1], match[2]]);
const hyperPassiveIds = hyperPairs.map(([, passive]) => idForConst(passive)).sort();
assertExcused('damR');
assert.deepEqual(
  [...hyperPassiveIds, ...excusedIds('damR')].sort(), [...hyperDamRIds].sort(),
  `skills.rs 的 Hyper 强化分支覆盖 ${hyperPassiveIds.join('/')}，`
  + `登记「不消费」的是 ${excusedIds('damR').join('/') || '（无）'}，`
  + `源表里带 damR 的 Hyper 被动是 ${hyperDamRIds.join('/')}——源里新增一本就必须有人做决定`,
);
for (const [boosted, passive] of hyperPairs) {
  assert.ok(
    skillConst.has(boosted) && skillConst.has(passive),
    `Hyper 强化分支引用了不存在的常量 ${boosted} / ${passive}`,
  );
}

// 3b. `indieDamR`：唯一来源必须在**两条**伤害路径上都被声明为独立乘算。
//     三个四转分支各有一本 傳說冒險，另两本登记在 `NOT_CONSUMED.indieDamR`。
assertExcused('indieDamR');
const catalogIndie = consumedIds('indieDamR');
assert.deepEqual(
  catalogIndie.length, 1,
  `源里要消费的 indieDamR 从 1 个变成了 ${catalogIndie.length} 个：需要有人重新决定分组`,
);
const indieId = catalogIndie[0];
assert.ok(
  damageSourceMentions(indieId, 'IndependentDamageRate', skillsSrc)
  && damageSourceMentions(indieId, 'IndependentDamageRate', attacksSrc),
  `源里唯一的 indieDamR 来源 ${indieId} 必须在普通攻击与魔法技能两条路径上都声明为 IndependentDamageRate`,
);

// 3c. `criticaldamage`：只走暴击组。被消费的是法师三本 魔法爆擊（冰雷 2210009 /
//     火毒 2110009 / 僧侶 2310010）；物理线来源登记在 `NOT_CONSUMED.criticaldamage`。
assertExcused('criticaldamage');
const catalogCritConsumed = consumedIds('criticaldamage');
assert.ok(catalogCritConsumed.length > 0, '源技能表里一个要消费的 criticaldamage 都没有？形状变了');
assert.deepEqual(
  idsForArray('MAGIC_CRITICAL_SKILLS'), catalogCritConsumed,
  `world.rs 的 MAGIC_CRITICAL_SKILLS 成员是 ${idsForArray('MAGIC_CRITICAL_SKILLS').join('/')}，`
  + `源里要消费的 criticaldamage 是 ${catalogCritConsumed.join('/')}`,
);
assertLoopedSource('MAGIC_CRITICAL_SKILLS', 'CriticalDamage');

// 3d. `mdR`：源里没有分组标记 ⇒ 必须报成 UnmarkedField，且 `field` 逐字写源字段名。
//     三本「最终伤害」段：冰雷 2210016 / 火毒 2110015 两本自然力重置，外加主教四转
//     2320012 大師魔法（源文案同样是「永久增加最終傷害」，与前者同一格）。
//     復仇天使 2321054 的 mdR 是窗口值，登记在 `NOT_CONSUMED.mdR`。
assertExcused('mdR');
const catalogMdR = consumedIds('mdR');
assert.ok(catalogMdR.length > 0, '源技能表里一个 mdR 都没有？形状变了');
assert.deepEqual(
  idsForArray('ELEMENTAL_RESET_SKILLS'), catalogMdR,
  `world.rs 的 ELEMENTAL_RESET_SKILLS 成员是 ${idsForArray('ELEMENTAL_RESET_SKILLS').join('/')}，`
  + `源里要消费的 mdR 是 ${catalogMdR.join('/')}`,
);
assertLoopedSource('ELEMENTAL_RESET_SKILLS', 'UnmarkedField', ',\\s*field: "mdR"');

// 3e. 物理线（战士 / 弓箭手 / 飞侠）**二转以上**的攻击技能：准入是**规则派生**的。
//     判据与 `world.rs::PHYSICAL_AREA_ATTACKS` 的注释同源，且**不读那张表**：
//       源里 `damage ∧ mobCount ∧ attackCount ∧ lt ∧ rb` 齐备
//       ∧ 不是 `hidden` 节点（玩家点不到，`handle_cast_skill` 在施法前就拒了）
//       ∧ 不含任何「本包还没有这条机制」的字段（下表逐字段写明是哪条机制）。
//     三条物理线的分支书 = 十位 ∈ {11,12,13,31,32,41,42}（即 `book / 10`），
//     不含四条**一转**书（它们的 6 条单独列在表里，且不在本段的重算范围内）。
const PHYSICAL_BRANCHES = new Set([11, 12, 13, 31, 32, 41, 42]);
/** 字段 → 「这条机制本包还没有」的理由。删掉一行 = 宣布该机制已实现，
 *  届时对应技能会自动要求进 `PHYSICAL_AREA_ATTACKS`（而不是继续被静默跳过）。 */
const PHYSICAL_MECHANISM_FIELDS = {
  time: '增益 / 召唤窗口：物理分支只接了**直接伤害**，没有施放窗与召唤实体',
  dot: '持续伤害场：本包没有 DoT 结算',
  dotInterval: '持续伤害场：本包没有 DoT 结算',
  dotTime: '持续伤害场：本包没有 DoT 结算',
  prop: '按几率触发（斗气 / 印记 / 挑衅 / 追加）：本包没有触发骰',
  subTime: '子窗口计时：本包没有窗口状态',
  updatableTime: '可刷新窗口计时：本包没有窗口状态',
  ballDelay: '多段投射物的逐段时序：本包按段数一次性结算，不建模飞行时序',
  ballDelay1: '多段投射物的逐段时序：本包按段数一次性结算，不建模飞行时序',
  ballDelay2: '多段投射物的逐段时序：本包按段数一次性结算，不建模飞行时序',
  ballDelay3: '多段投射物的逐段时序：本包按段数一次性结算，不建模飞行时序',
  lt2: '第二命中盒：本包的范围选择只读 `common/lt|rb` 一对',
  rb2: '第二命中盒：本包的范围选择只读 `common/lt|rb` 一对',
  maxUseCountInOneJump: '跳跃使用次数限制：本包不建模该计数器',
  basicStatUp: '属性增益：走 attribute 槽位，不是攻击',
  mastery: '熟练度被动：走 `MASTERY_SKILLS` 槽位，不是攻击',
  hcHp: 'HP 消耗 / 上限类字段：本包不建模',
  hp: 'HP 消耗类字段：本包不建模',
  fixdamage: '固定伤害：新手技能路径专用',
};
const physicalBranchSkillIds = Object.entries(mageSkills.skills)
  .filter(([id]) => PHYSICAL_BRANCHES.has(Math.floor(Number(id) / 10000 / 10)))
  .map(([id]) => id);
const physicalAttackExpected = [];
const physicalAttackExcused = {};
for (const id of physicalBranchSkillIds) {
  const skill = mageSkills.skills[id];
  const fields = new Set(skill.levels.flatMap(level => Object.keys(level)));
  if (!['damage', 'mobCount', 'attackCount', 'lt', 'rb'].every(field => fields.has(field))) {
    continue; // 不是「带贴身框的直接攻击」，不在本段的判据范围内（另有 53/55/162 条分类统计）
  }
  if (skill.hidden) {
    physicalAttackExcused[id] = { why: `${skill.name}：源里是 \`hidden\` 节点（由职业规则自动启用），玩家点不到 —— 施法入口在 \`skill_hidden\` 就拒了，接进范围表没有意义。` };
    continue;
  }
  const marker = Object.keys(PHYSICAL_MECHANISM_FIELDS).find(field => fields.has(field));
  if (marker) {
    physicalAttackExcused[id] = { why: `${skill.name}：带源字段 \`${marker}\` ⇒ ${PHYSICAL_MECHANISM_FIELDS[marker]}。` };
    continue;
  }
  physicalAttackExpected.push(id);
}
physicalAttackExpected.sort();
// 反向断言：登记为「进不了表」的每一条都必须**真的没有** `world.rs` 常量——
// 哪天有人给它起了常量、接了施法分支，这里立刻红，要求同时把它放进范围表。
for (const [id, entry] of Object.entries(physicalAttackExcused)) {
  assert.ok(entry.why, `物理线攻击技能的 ${id} 登记为「不接」却没写理由`);
  assert.equal(
    constFor(Number(id)), null,
    `物理线 ${id} 登记为「不接执行链」，但 world.rs 已给它起常量 ${constFor(Number(id))}——`
      + '接了路径就必须把它放进 PHYSICAL_AREA_ATTACKS，或把这条登记删掉',
  );
}
// 双向：分支书里的每一条期望成员都必须在表里，且表里**分支书**的成员恰好就是期望集合
// （一转 6 条是另一段历史，单独豁免给 `PHYSICAL_ONE_TURN_ATTACKS`）。
const PHYSICAL_ONE_TURN_ATTACKS = ['1001005', '1001010', '1001011', '4001334', '4001344', '4001013'];
const physicalWired = idsForArray('PHYSICAL_AREA_ATTACKS');
assert.deepEqual(
  physicalWired.filter(id => !PHYSICAL_ONE_TURN_ATTACKS.includes(id)), physicalAttackExpected,
  `world.rs 的 PHYSICAL_AREA_ATTACKS 里（除一转 6 条外）是 `
    + `${physicalWired.filter(id => !PHYSICAL_ONE_TURN_ATTACKS.includes(id)).join('/')}，`
    + `源表按「damage+mobCount+attackCount+lt+rb ∧ 非 hidden ∧ 无机制标记」重算出来的是 `
    + `${physicalAttackExpected.join('/')}`,
);
assert.deepEqual(
  physicalWired.filter(id => PHYSICAL_ONE_TURN_ATTACKS.includes(id))
    .sort(), [...PHYSICAL_ONE_TURN_ATTACKS].sort(),
  'PHYSICAL_AREA_ATTACKS 的一转 6 条被改动了',
);
// 上界自证：本表成员的 `mobCount` / `attackCount` 必须落在范围管线的既有上界里
// （目标 15 / 段数 12）。超了要改上界，不是悄悄截断。
for (const id of physicalWired) {
  for (const level of mageSkills.skills[id].levels) {
    assert.ok(
      (level.mobCount ?? 1) <= 15,
      `${id} 的 mobCount ${level.mobCount} 超过 area_targets_at 的上界 15`,
    );
    assert.ok(
      (level.attackCount ?? 1) <= 12,
      `${id} 的 attackCount ${level.attackCount} 超过 cast_elemental_area_at_filtered 的上界 12`,
    );
  }
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
// skills.rs 有**两处**区域系数，且 `magic` 参数必须跟着伤害种类走：
//   ① 魔法路径（`magic_damage_breakdown`）⇒ `true`，吃源 `MagicGuard` 113 的魔法护盾；
//   ② 物理线一转攻击技能（`cast_elemental_area_at_filtered` 的 `if physical` 分支）
//      ⇒ `false`，与 `attacks.rs` 的普攻同口径，吃源 `PhysicalGuard` 112 的物理护盾。
// 计数钉死（防止哪天再加第三条伤害路径而忘了带这个系数），并且**逐处钉 `true`/`false`**
// ——2026-09-22 物理分支初版就写成 `true`，是「物理技能吃魔法护盾、又无视物理护盾」的
// 双向错误；只钉「写成 `.. - 100`」这种形状是抓不到的（两处的形状一模一样）。
{
  const calls = [...skillsSrc.matchAll(/boss_damage_multiplier\(([^)]*)\)\s*- 100/g)];
  assert.equal(
    calls.length, 2,
    `skills.rs 的区域系数出现 ${calls.length} 处，应当是 2 处（魔法路径 + 物理线攻击技能）`,
  );
  const flags = calls.map(match => /,\s*(true|false)\s*$/.exec(match[1])?.[1]);
  assert.deepEqual(
    flags.slice().sort(), ['false', 'true'],
    `skills.rs 两处区域系数的伤害种类判据是 ${flags.join('/')}，应当恰好一处 true（魔法）`
      + '一处 false（物理）——伤害种类写错会让技能吃错护盾，且两个方向都错',
  );
  const physicalBranch = /let damage = if physical \{([\s\S]*?)\} else \{/.exec(skillsSrc);
  assert.ok(
    physicalBranch,
    'skills.rs 里读不到 `if physical { … } else {` 这条伤害分野——物理/魔法分支的判据脱钩了',
  );
  assert.match(
    physicalBranch[1], /boss_damage_multiplier\([^)]*,\s*false\)\s*- 100/,
    '物理分支的区域系数必须取 `false`（物理护盾，与 attacks.rs 的普攻同口径）；'
      + '写 `true` 会让物理技能去吃魔法护盾',
  );
}

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
  + `criticaldamage（消费）=${catalogCritConsumed.join('/')}`,
);
console.log(
  `  旧式乘算：0 处（玩家受伤侧按边界正向登记，未纳入管线）`,
);
