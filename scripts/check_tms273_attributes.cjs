#!/usr/bin/env node

// 门禁：玩家属性必须是**一条权威聚合**——层序固定、加算/加算%/取高者由来源各自声明、
// 取整只有一处、上限只在声明处，且「面板数字」与「战斗数字」必须来自同一份结果。
//
// 背景（2026-09-17「属性聚合口径」）：改前「玩家最终属性是多少」有两个入口，各算一套：
// UI 侧（`derived.rs::compute_derived_stats`）在折叠装备**之前**加被动 `intX`、乘楓葉祝福
// `basicStatUp`；战斗侧（`attacks.rs` / `monsters.rs` / `boss.rs` / world tick）直接
// `with_ability_stats(&player.state.ability_stats, …)` 用**原始**能力值。实测 D1/D2/D4
// 三处**真**分叉（intX、basicStatUp、mastery 只有面板含）；D3（魔力之盾 `pddX`）
// 被**证伪**——受伤侧在 `commit_incoming_damage` 内层减它，两侧总量本来就一致。
//
// 断言分六组：
//   1. **解析自检**：层 / 作用方式 / 属性键三张表必须能被本脚本解出来，且形状就是设计时的
//      那几种（解不出来就失败——门禁不许因为源码被改写而静默不检查）；
//   2. **聚合唯一入口**：`aggregate_attributes` 只定义一处；四条消费路径（world tick、
//      普通攻击、加入路径、状态变更后的 refresh）真的在用它；
//   3. **战斗侧口径**：普通攻击路径用聚合结果取攻击数值；受伤路径**禁止**读含 `pddX`
//      的 `defense()`（会双扣——这是 D3 误诊留下的坑，用反向断言钉死）；原始
//      `ability_stats` 不许再被任何战斗路径直接喂给 `with_ability_stats`；
//   4. **内容 → 表（独立重算，不共用服务端任何代码）**：对着真实 `shared/mage-skills.json`
//      重算「带 `intX` / `basicStatUp` / `pddX` / `mastery` / `mmpR` / `psdSpeed` / …
//      的技能」各是哪些，逐条要求 `attribute.rs` 把它们按**声明的层与作用方式**消费——
//      源里新增一个带这些字段的技能而没人做决定，这里就会红；
//   5. **源侧时长事实**：「学得即生效」的三个来源（`2200007` / `2200012` / `2000010`）
//      源 `common` 里必须仍**没有** `time`（它们构不成增益窗口）；`common` 带 `time`
//      却仍按被动读的技能必须恰好是登记表 `INTRINSIC_DURATION_SKILLS`（本版只有
//      `2221005` 冰龍吐息的技能固有 `mastery`）；
//   6. **取整 / 上限 / 接线**：`attribute.rs` 里不允许出现 `.floor()`（取整只有
//      `basicStatUp` 那一次整数截断）；`speedMax` 的上限还在；`equipment_field_sum`
//      只定义一处且 `with_equipment` 与 `attribute.rs` 共用；模块挂载与协议零改动。
//
// 本脚本从源码里读表，用的是窄正则 + 形状断言，不是「解析 Rust」。源码改写导致解不出来时，
// 第 1 组会失败，而不是让门禁悄悄地什么都不检查。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SERVER_SRC = path.join(ROOT, 'server/src');

const read = name => fs.readFileSync(path.join(SERVER_SRC, name), 'utf8');
/** 去掉整行注释——门禁数的是代码，不是文档里提过几次。 */
const codeOnly = source =>
  source
    .split('\n')
    .filter(line => !line.trimStart().startsWith('//'))
    .join('\n');

const attributeSrc = read('attribute.rs');
const derivedSrc = read('derived.rs');
const attacksSrc = read('attacks.rs');
const monstersSrc = read('monsters.rs');
const bossSrc = read('boss.rs');
const worldSrc = read('world.rs');
const commandsSrc = read('commands.rs');
const combatRulesSrc = read('combat_rules.rs');
const mageSkills = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/mage-skills.json'), 'utf8'));

// ---------------------------------------------------------------------------
// 1. 解析自检
// ---------------------------------------------------------------------------

/** 层表：枚举顺序**就是**层序。 */
const layerBody = /pub\(super\) enum AttributeLayer \{([\s\S]*?)\n\}/.exec(attributeSrc);
assert.ok(layerBody, 'attribute.rs 里读不到 AttributeLayer 的定义——层序的唯一定义处丢了');
const layers = [...layerBody[1].matchAll(/^\s{4}([A-Z]\w+),/gm)].map(match => match[1]);
assert.deepEqual(
  layers, ['PersistedAbility', 'PassiveSkill', 'ActiveBuff', 'Equipment'],
  `AttributeLayer 的变体或顺序变了（${layers.join('→')}）：枚举顺序即层序，改动必须同步模块头与门禁`,
);

/** 作用方式表：哪些加算、哪些取高，全靠这三个变体表达。 */
const opBody = /pub\(super\) enum AttributeOp \{([\s\S]*?)\n\}/.exec(attributeSrc);
assert.ok(opBody, 'attribute.rs 里读不到 AttributeOp 的定义');
const ops = [...opBody[1].matchAll(/^\s{4}([A-Z]\w+),/gm)].map(match => match[1]);
assert.deepEqual(
  ops, ['Flat', 'AdditivePercent', 'Highest'],
  `AttributeOp 的变体变了（${ops.join('/')}）：新增作用方式必须有人重新决定各来源归谁`,
);

/** 属性键登记表：门禁遍历与「新增键必须登记」的依据。 */
const allBody = /pub\(super\) const ALL: \[AttributeKey; (\d+)\] = \[([\s\S]*?)\];/.exec(attributeSrc);
assert.ok(allBody, 'attribute.rs 里读不到 AttributeKey::ALL——门禁遍历的登记表丢了');
const allKeys = [...allBody[2].matchAll(/AttributeKey::(\w+)/g)].map(match => match[1]);
assert.equal(
  Number(allBody[1]), allKeys.length,
  'ALL 的长度标注与实际条目数不一致——有人改了表没改数字',
);
assert.equal(allKeys.length, 13, `属性键从 13 个变成了 ${allKeys.length} 个：需要有人重新决定覆盖面`);

// ---------------------------------------------------------------------------
// 2. 聚合唯一入口
// ---------------------------------------------------------------------------

const aggregateDefs = [...rustFilesWith('fn aggregate_attributes\\(')];
assert.deepEqual(
  aggregateDefs, ['attribute.rs'],
  `aggregate_attributes 必须只定义一处，实际出现在 ${aggregateDefs.join('/')}`,
);
assert.equal(
  (attributeSrc.match(/fn aggregate_attributes\(/g) ?? []).length, 1,
  'attribute.rs 里 aggregate_attributes 的定义不止一处',
);

/** 四条消费路径 + refresh 入口，全部必须构造 `AttributeInput` 并调 `aggregate_attributes`。 */
const CONSUMERS = {
  'world.rs': /aggregate_attributes\(AttributeInput::of\(&self\.gameplay, &self\.mage_skills, player\)\)/,
  'attacks.rs': /aggregate_attributes\(AttributeInput::of\(\s*&self\.gameplay,\s*&self\.mage_skills,\s*player,\s*\)\)/,
  'commands.rs': /aggregate_attributes\(AttributeInput::joining\(/,
  'derived.rs': /aggregate_attributes\(AttributeInput::of\(gameplay, mage_skills, player\)\)/,
};
for (const [name, pattern] of Object.entries(CONSUMERS)) {
  assert.ok(
    pattern.test(read(name)),
    `${name} 没有走聚合入口——面板与战斗会从这里开始再次分叉`,
  );
}

// ---------------------------------------------------------------------------
// 3. 战斗侧口径
// ---------------------------------------------------------------------------

// 3a. 普通攻击的基准必须来自聚合结果（四维 + 熟练度都含改前战斗侧漏掉的三项）。
assert.ok(
  /attributes\.attack_damage_against\(/.test(attacksSrc),
  'attacks.rs 的普通攻击没有用聚合结果的 attack_damage_against',
);
assert.ok(
  !/with_ability_stats\([\s\S]{0,200}?attack_damage_against/.test(attacksSrc),
  'attacks.rs 还在用原始 ability_stats 拼普通攻击的基准——旧口径复活了',
);

// 3b. 受伤路径的边界（D3 误诊的坑）：外层减伤读装备侧 weapon_defense，
//     pddX 由 commit_incoming_damage 的 shield_bonus 在内层减。两侧相加 = 面板 defense()。
//     任何一侧改成读聚合的 `defense()` 都会把 pddX 扣两次。
for (const [name, source, anchor] of [
  ['monsters.rs', monstersSrc, 'raw_damage.saturating_sub(defense).max(1)'],
  ['boss.rs', bossSrc, 'raw_damage.saturating_sub(defense).max(1)'],
]) {
  assert.ok(
    source.includes(anchor),
    `${name} 的受伤抵偿形状变了（找不到 \`${anchor}\`），边界断言需要人来重新核对`,
  );
  assert.ok(
    /\.with_ability_stats\(/.test(source),
    `${name} 的外层减伤没有读装备侧 weapon_defense——pddX 会在这里与 commit 内层双扣`,
  );
}
assert.ok(
  !/aggregate_attributes\([\s\S]{0,120}?\)\s*\.defense\(\)/.test(monstersSrc)
    && !/aggregate_attributes\([\s\S]{0,120}?\)\s*\.defense\(\)/.test(bossSrc),
  '受伤路径读了聚合的 defense()：它含魔力之盾 pddX，而 commit_incoming_damage 会再减一次 ⇒ 双扣',
);
assert.ok(
  /\.saturating_sub\(shield_bonus\)\.max\(1\)/.test(monstersSrc),
  'monsters.rs::commit_incoming_damage 的 pddX（shield_bonus）抵偿不见了——受伤侧少了一层',
);

// 3c. 原始 ability_stats 不许再被任何战斗路径直接喂给 with_ability_stats：
//     「UI 一套、战斗一套」就是从这里开始的。
const offenders = [];
for (const name of [
  'world.rs', 'attacks.rs', 'monsters.rs', 'boss.rs', 'commands.rs',
  'skills.rs', 'elemental.rs', 'growth.rs', 'dialogue.rs', 'quest.rs',
  'portals.rs', 'revive.rs', 'inventory_ops.rs', 'windbell.rs',
]) {
  const source = codeOnly(read(name));
  for (const hit of source.matchAll(/with_ability_stats\(\s*&\w+\.state\.ability_stats/g)) {
    offenders.push(`${name}: ${hit[0].replace(/\s+/g, ' ')}`);
  }
}
// 受伤路径是**登记过的边界**（第 3b 组）：它读装备侧 weapon_defense，用的是
// `player.state.ability_stats`——这一条必须恰好是全部出现，多一处都要人来做决定。
const REGISTERED_HURT_DEFENSE = 'with_ability_stats( &player.state.ability_stats';
assert.deepEqual(
  offenders.sort(),
  [`boss.rs: ${REGISTERED_HURT_DEFENSE}`, `monsters.rs: ${REGISTERED_HURT_DEFENSE}`],
  `原始 ability_stats 只允许出现在受伤路径的两个登记点上，实际：\n  ${offenders.join('\n  ')}`,
);

// ---------------------------------------------------------------------------
// 4. 内容 → 表（独立重算）
// ---------------------------------------------------------------------------

const catalogIdsWith = field =>
  Object.entries(mageSkills.skills)
    .filter(([, skill]) => skill.levels.some(level => level[field] !== undefined))
    .map(([id]) => id)
    .sort();

/** 复合口径：**同时**带全部字段的技能（`mastery`+`x` 就是「咒語精通」这一族的形状）。 */
const catalogIdsWithAll = fields =>
  Object.entries(mageSkills.skills)
    .filter(([, skill]) => fields.every(field => skill.levels.some(level => level[field] !== undefined)))
    .map(([id]) => id)
    .sort();

const skillConst = new Map();
for (const match of worldSrc.matchAll(/const (SKILL_[A-Z0-9_]+): u32 = (\d+);/g)) {
  skillConst.set(match[1], Number(match[2]));
}
const idForConst = name => {
  const id = skillConst.get(name);
  assert.ok(id !== undefined, `world.rs 里没有常量 ${name}`);
  return String(id);
};
const constFor = id => {
  for (const [name, value] of skillConst) if (value === id) return name;
  return null;
};

/**
 * `const NAME: [u32; N] = [SKILL_A, SKILL_B];` → 成员常量名。
 *
 * 「同一格」的被动在三个分支上各有一本（冰雷 / 火毒 / 僧侶），逐本 `Some(CONST)` 留痕会
 * 写成一大片重复代码；所以消费循环统一写成 `for skill_id in NAME`，而**成员清单留在
 * `world.rs` 的数据表里**。门禁按这张表的成员逐个重算，源里新增一本而没人登记就红。
 * 长度标注与实际条目数也会在这里核对——表头写错数字是同一类漂移。
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

/**
 * 「源字段 → 聚合模块里必须出现的那条消费」。
 * `learned` = 按「学得即生效」读表（learned_level）；`layer` / `op` 是留痕里声明的
 * 层与作用方式——这张表**就是**「哪些加算、哪些取高」在内容侧的完整答案。
 * `consts` = 逐本 `Some(CONST)` 留痕（少量、单本）；`array` = 同一格多本，循环消费，
 * 成员清单取自 `world.rs` 的具名数组（两种写法都由「源表重算 == 声明集合」绑定）。
 * `fieldVar` = 源字段名以循环变量传入（asrR/terR 的元组表），由元组行单独钉住。
 */
const CONTENT_RULES = [
  { field: 'intX', array: 'INTELLIGENCE_SKILLS', loop: true, layer: 'PassiveSkill', op: 'Flat', key: 'Intelligence' },
  { field: ['mastery', 'x'], array: 'SPELL_MASTERY_X_SKILLS', loop: true, layer: 'PassiveSkill', op: 'Flat', key: 'MagicAttack' },
  { field: 'basicStatUp', consts: ['SKILL_MAPLE_WARRIOR'], layer: 'PassiveSkill', op: 'AdditivePercent', key: null },
  { field: 'pddX', consts: ['SKILL_MAGIC_SHIELD'], layer: 'PassiveSkill', op: 'Flat', key: 'WeaponDefense' },
  { field: 'madX', consts: ['SKILL_MASTER_MAGIC'], layer: 'PassiveSkill', op: 'Flat', key: 'MagicAttack' },
  { field: 'mmpR', consts: ['SKILL_MAGIC_BOOST'], layer: 'PassiveSkill', op: 'AdditivePercent', key: 'MaxMp' },
  { field: 'lv2mmp', consts: ['SKILL_MAGIC_BOOST'], layer: 'PassiveSkill', op: 'Flat', key: 'MaxMp' },
  { field: 'psdSpeed', consts: ['SKILL_TELEPORT'], layer: 'PassiveSkill', op: 'Flat', key: 'MoveSpeed' },
  { field: 'asrR', array: 'ELEMENTAL_ADAPTING_SKILLS', loop: true, fieldVar: true, layer: 'PassiveSkill', op: 'Flat', key: 'StatusResistance' },
  { field: 'terR', array: 'ELEMENTAL_ADAPTING_SKILLS', loop: true, fieldVar: true, layer: 'PassiveSkill', op: 'Flat', key: 'ElementResistance' },
  { field: 'mastery', array: 'MASTERY_SKILLS', loop: true, layer: 'PassiveSkill', op: 'Highest', key: 'Mastery' },
];

/** 一条规则声明的技能 id 集合（常量名 → id；数组 → 成员 id）。 */
const declaredIds = rule =>
  (rule.array ? idsForArray(rule.array) : rule.consts.map(idForConst)).sort();

/** 一条规则的源字段名（数组 = 复合口径）。 */
const ruleFields = rule => (Array.isArray(rule.field) ? rule.field : [rule.field]);

for (const rule of CONTENT_RULES) {
  const fields = ruleFields(rule);
  const catalogIds = fields.length === 1
    ? catalogIdsWith(fields[0])
    : catalogIdsWithAll(fields);
  const label = fields.join('+');
  assert.ok(catalogIds.length > 0, `源技能表里一个 ${label} 都没有？形状变了`);
  const declared = declaredIds(rule);
  assert.deepEqual(
    catalogIds, declared,
    `源里带 ${label} 的技能是 ${catalogIds.join('/')}，聚合模块声明消费的是 ${declared.join('/')}`
      + `——源里新增一个带该字段的技能而没人做决定，这里就会红`,
  );
  if (rule.loop) {
    // 循环消费：循环头必须恰好绑定这张表（具名数组或逐字常量清单），
    // 留痕里的层 / 键 / 作用方式是唯一的那条。
    const header = rule.array
      ? new RegExp(`for skill_id in ${rule.array} \\{`)
      : new RegExp(`for skill_id in \\[${rule.consts.join(', ')}\\]`);
    assert.ok(
      header.test(codeOnly(attributeSrc)),
      `${label} 的消费循环没有恰好绑定 ${rule.array ?? rule.consts.join('、')}`,
    );
    // fieldVar（asrR/terR）的**字段名与属性键都来自元组表**，所以这两格是循环变量；
    // 「哪个字段名配哪个键」由下面的元组行单独钉住。
    const loopFieldSlot = rule.fieldVar ? '[A-Za-z_]+' : '"[^"]+"';
    const loopKeySlot = rule.fieldVar ? '[A-Za-z_]+' : `AttributeKey::${rule.key}`;
    const shape = new RegExp(
      `AttributeLayer::${rule.layer},\\s*Some\\(skill_id\\),\\s*`
        + `${loopFieldSlot},\\s*${loopKeySlot},\\s*AttributeOp::${rule.op},`,
    );
    assert.ok(
      shape.test(codeOnly(attributeSrc)),
      `${label} 没有按 AttributeLayer::${rule.layer} + AttributeOp::${rule.op} `
        + `+ AttributeKey::${rule.key} 留痕（这条声明就是口径，改了必须有人重新决定）`,
    );
    if (rule.fieldVar) {
      // 元组表把「源字段名 → 属性键」钉住，防止循环变量让字段名漂移。
      const tuple = new RegExp(`\\([a-z_]+, "${fields[0]}", AttributeKey::${rule.key}\\)`);
      assert.ok(
        tuple.test(codeOnly(attributeSrc)),
        `${label} 的「源字段名 → 属性键」元组不见了（循环变量必须由这张表钉住）`,
      );
    }
    continue;
  }
  for (const constant of rule.consts) {
    // 同一条留痕里，层 / 字段 / 作用方式必须逐字声明。key 为 null 表示「对四维逐键
    // 留痕」（`for key in KEYS`）；fieldVar 表示字段名与键都来自元组表（asrR/terR），
    // 由下面的元组行钉住「源字段名 → 属性键」。
    const keySlot = rule.fieldVar
      ? '[A-Za-z_]+'
      : rule.key
        ? `AttributeKey::${rule.key}`
        : 'key';
    const pattern = new RegExp(
      `AttributeLayer::${rule.layer},\\s*Some\\(${constant}\\),\\s*`
        + (rule.fieldVar ? '[A-Za-z_]+' : '"[^"]+"')
        + `,\\s*${keySlot},\\s*AttributeOp::${rule.op},`,
    );
    assert.ok(
      pattern.test(codeOnly(attributeSrc)),
      `${constant} 的 ${rule.field} 没有按 AttributeLayer::${rule.layer} + AttributeOp::${rule.op} `
        + `+ ${keySlot} 留痕（这条声明就是口径，改了必须有人重新决定）`,
    );
  }
  if (!rule.key) {
    assert.ok(
      /for key in KEYS \{/.test(codeOnly(attributeSrc)),
      'basicStatUp 的「对四维逐键留痕」（for key in KEYS）不见了',
    );
  }
  if (rule.fieldVar) {
    // 元组表把「源字段名 → 属性键」钉住，防止循环变量让字段名漂移。
    const tuple = new RegExp(
      `\\([a-z_]+, "${rule.field}", AttributeKey::${rule.key}\\)`,
    );
    assert.ok(
      tuple.test(codeOnly(attributeSrc)),
      `${rule.field} 的「源字段名 → 属性键」元组不见了（循环变量必须由这张表钉住）`,
    );
  }
}

// ---------------------------------------------------------------------------
// 5. 源侧时长事实（「学得即生效」的依据 + 带时长却按被动读的登记表）
// ---------------------------------------------------------------------------

/** 源技能的 `common` 节点（内容表里被拉平到技能上；没有就当空）。 */
const commonOf = id => {
  const skill = mageSkills.skills[String(id)];
  if (!skill) return {};
  return skill.common ?? skill.levels[0] ?? {};
};

// 5a. 「学得即生效」的三个来源必须仍没有时长——源一旦补上 `time`，
//     它们就构得出增益窗口，必须有人重新决定是否改归 ActiveBuff 层。
const LEARNED_FOREVER = ['SKILL_INTELLIGENCE', 'SKILL_BOOSTER', 'SKILL_MAGIC_SHIELD', 'SKILL_MAPLE_WARRIOR'];
for (const constant of LEARNED_FOREVER) {
  const id = idForConst(constant);
  const common = commonOf(id);
  assert.ok(
    common.time === undefined,
    `源里 ${constant}(${id}) 出现了 time：它现在是施放类增益的形状，不能继续按「学得即生效」处理`,
  );
}

// 5b. `common` 带 `time` 却仍按被动读的技能，必须恰好是登记表里的那几个。
const intrinsicBody =
  /pub\(super\) const INTRINSIC_DURATION_SKILLS: \[u32; (\d+)\] = \[([\s\S]*?)\];/.exec(attributeSrc);
assert.ok(intrinsicBody, 'attribute.rs 里读不到 INTRINSIC_DURATION_SKILLS——带时长的被动没有登记处');
const intrinsicNames = [...intrinsicBody[2].matchAll(/(SKILL_[A-Z0-9_]+)/g)].map(match => match[1]);
assert.equal(
  Number(intrinsicBody[1]), intrinsicNames.length,
  'INTRINSIC_DURATION_SKILLS 的长度标注与实际条目数不一致',
);
for (const constant of intrinsicNames) {
  const id = idForConst(constant);
  const common = commonOf(id);
  assert.ok(
    common.time !== undefined,
    `${constant}(${id}) 在「带时长却按被动读」的登记表里，但源里没有 time——这是豁免不是登记`,
  );
}
// 反向：源里所有带时长且提供了第 2 层字段的技能，必须都被登记（多一个 / 少一个都失败）。
const passiveLayerIds = CONTENT_RULES
  .filter(rule => rule.layer === 'PassiveSkill')
  .flatMap(declaredIds);
const needsRegistration = [...new Set(passiveLayerIds)].filter(id => commonOf(id).time !== undefined);
assert.deepEqual(
  intrinsicNames.map(idForConst).sort(), needsRegistration.sort(),
  `源里「带时长却提供了第 2 层字段」的技能是 ${needsRegistration.join('/')}，`
    + `登记表里是 ${intrinsicNames.map(idForConst).join('/')}——需要有人重新分类`,
);

// 5c. `source_has_duration` 只看 `time`：这条判据必须还在（第 5 组的全部依据）。
assert.ok(
  /fn source_has_duration\([\s\S]{0,200}?\.get\("time"\)\.is_some\(\)/.test(attributeSrc),
  'source_has_duration 的判据变了——时长事实的核对需要人来重新核对',
);

// ---------------------------------------------------------------------------
// 6. 取整 / 上限 / 接线
// ---------------------------------------------------------------------------

const attributeCode = codeOnly(attributeSrc);
// 取整只在 basicStatUp 那一次（整数截断）。全模块不许出现浮点 floor。
assert.equal(
  (attributeCode.match(/\.floor\(\)/g) ?? []).length, 0,
  'attribute.rs 里出现了 .floor()：属性聚合不允许逐步取整（取整只有 basicStatUp 的整数截断）',
);
assert.equal(
  (attributeCode.match(/saturating_mul\(100 \+ basic_stat_up\) \/ 100/g) ?? []).length, 1,
  'basicStatUp 的「求和后只乘一次」形状丢了',
);
// 上限：传送被动移速用源 speedMax 夹，并入初学者速度后再 clamp(0,100)。
assert.ok(
  /teleport_speed_max\.min\(100\)/.test(attributeCode),
  '传送被动移速的源上限（speedMax）不见了',
);
assert.ok(
  /saturating_add\(beginner_speed\)\s*\.clamp\(0, 100\)/.test(attributeCode),
  '移速合并后的 clamp(0,100) 不见了',
);
// 装备折叠的唯一实现：with_equipment 与留痕共用同一个纯函数。
assert.deepEqual(
  rustFilesWith('fn equipment_field_sum\\('), ['combat_rules.rs'],
  'equipment_field_sum 必须只定义一处（combat_rules.rs）——否则留痕与实际折叠会分叉',
);
assert.ok(
  /use super::combat_rules::equipment_field_sum;/.test(attributeSrc),
  'attribute.rs 没有显式引入 equipment_field_sum——装备贡献的留痕会与实际折叠脱钩',
);
assert.ok(
  /let bonus = \|key: &str\| equipment_field_sum\(equipped, key\);/.test(combatRulesSrc),
  'with_equipment 没有走 equipment_field_sum——装备折叠出现了第二套实现',
);
// 接线与协议零改动。
assert.ok(
  /#\[path = "attribute\.rs"\]\nmod attribute;/.test(worldSrc)
    && /use self::attribute::\*;/.test(worldSrc),
  'world.rs 没有挂上 attribute 模块（或没 glob 导入）',
);
assert.equal(
  (derivedSrc.match(/fn compute_derived_stats\(/g) ?? []).length, 1,
  'compute_derived_stats 只能有一处定义',
);
// 协议快照必须是聚合结果的**组装**：不允许在 derived.rs 里再长出属性计算。
assert.ok(
  !/base_stat_up|int_bonus|shield_bonus|mastery_percent|MAGIC_BOOST/.test(codeOnly(derivedSrc)),
  'derived.rs 里出现了属性口径的计算痕迹——快照组装层不许算数',
);
for (const name of ['server/src/protocol.rs', 'shared/protocol.ts']) {
  const source = fs.readFileSync(path.join(ROOT, name), 'utf8');
  assert.ok(
    !/aggregate|AttributeLayer|AttributeSource|INTRINSIC_DURATION/i.test(source),
    `${name} 里出现了属性聚合的名字：留痕只留在服务端，不许进协议`,
  );
}

function rustFilesWith(pattern) {
  const files = fs
    .readdirSync(SERVER_SRC)
    .filter(name => name.endsWith('.rs') && !name.includes(' '));
  const hits = [];
  for (const name of files) {
    if (new RegExp(pattern).test(read(name))) hits.push(name);
  }
  return hits;
}

console.log('[attributes] ok');
console.log(
  `  层序：${layers.join(' → ')}；作用方式：${ops.join('/')}；属性键 ${allKeys.length} 个`,
);
console.log(
  `  源表重算：${CONTENT_RULES.map(rule => `${ruleFields(rule).join('+')}(${rule.op})`).join('、')}`,
);
console.log(
  `  时长事实：学得即生效 ${LEARNED_FOREVER.map(idForConst).join('/')} 均无 time；`
    + `带时长的被动 = ${intrinsicNames.map(idForConst).join('/') || '（无）'}`,
);
console.log(
  `  受伤边界：外层装备侧 weapon_defense + commit 内层 pddX（聚合的 defense() 只进面板）`,
);
