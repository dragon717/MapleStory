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
const skillsSrc = read('skills.rs');
const elementalsSrc = read('elemental.rs');
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
  // `mastery+x` 复合形状在 2026-09-22 目录扩到四条职业线后不再唯一指向 咒語精通：
  // 法师线（书 200..232）的 `x` 是**魔攻**，物理线（战/弓/侠）的 `x` 是**命中率**。
  // 这条规则 `scope` 到法师书；物理线 12 本的决策（x 不消费 + 理由）钉在下面的
  // 「物理线武器精通决策块」。
  {
    field: ['mastery', 'x'], array: 'SPELL_MASTERY_X_SKILLS', loop: true, layer: 'PassiveSkill', op: 'Flat', key: 'MagicAttack',
    scope: id => { const book = Math.floor(Number(id) / 10000); return book >= 200 && book < 300; },
  },
  // 楓葉祝福：三个四转分支各一本（2221000 / 2121000 / 2321000），与 `intX` 同一格
  // —— 逐本求和、各记各的，成员清单由 `world.rs` 的数组持有。
  { field: 'basicStatUp', array: 'MAPLE_WARRIOR_SKILLS', loop: true, layer: 'PassiveSkill', op: 'AdditivePercent', key: null },
  // `pddX`（物理防御加成百分点）的语义跨线一致：法师 魔力之盾 + 物理线三本
  // （自身強化 1000003 / 聖騎士精通 1220018 / 禦魔陣 1300016），同一槽位逐本求和。
  // 物理线这几本的 `mddX` / `damAbsorbShieldR` / `mhpR` / `pdR` / `cr` /
  // `criticaldamage` / `ignoreMobpdpR` 不进聚合：mddX 无对应属性键，其余的消费管线
  // 只存在于法师魔法路径（见文件尾「物理线武器精通决策块」的理由登记）。
  { field: 'pddX', array: 'PDDX_SKILLS', loop: true, layer: 'PassiveSkill', op: 'Flat', key: 'WeaponDefense' },
  // 大師魔法 `madX`：三个四转分支各一本（2220013 / 2120012 / 2320012），与 `intX` 同格。
  // `2321054 復仇天使` 也带 `madX`，源 `perLevel` 把它写在 `#c[被動效果]#` 一组里
  // （「#c[被動效果]#魔法攻擊力增加#madX、最終傷害增加#mdR%、無視怪物防禦率增加
  // #ignoreMobpdpR%、攻擊屬性耐性減少#u%」），而源里**没有 `time`** ⇒ 它开不出窗口，
  // 只能按本仓既有口径「學得即生效」当被动消费。2026-09-24 本包接上这本技能
  // （技能轉換：施放＝把四本復仇技能按慈愛对应等级授予进技能存档）后，
  // `2321054` 进 `MASTER_MAGIC_SKILLS` ⇒ 从本规则的 `except` 移出（旧登记已删）。
  {
    field: 'madX',
    array: 'MASTER_MAGIC_SKILLS',
    loop: true,
    layer: 'PassiveSkill',
    op: 'Flat',
    key: 'MagicAttack',
  },
  { field: 'mmpR', consts: ['SKILL_MAGIC_BOOST'], layer: 'PassiveSkill', op: 'AdditivePercent', key: 'MaxMp' },
  { field: 'lv2mmp', consts: ['SKILL_MAGIC_BOOST'], layer: 'PassiveSkill', op: 'Flat', key: 'MaxMp' },
  // `psdSpeed`（被动移速加成）语义跨线一致：法师 瞬間移動 + 战士 戰鬥技能 `1000009`
  // + 飞侠 速度激發 `4000005`，同一槽位逐本求和（角色最多持有一本）。黑骑士四转
  // 轉生 `1320016` 也带 psdSpeed，但它带 `time`/`cooltime`、是施放窗口内的增益
  // 且本包没接它的施放分支 ⇒ 登记为不消费。物理线两本的 `psdJump` / `stanceProp` /
  // `lv2mhp` 无对应属性键，不进聚合（本条注释即决策登记）。
  {
    field: 'psdSpeed',
    array: 'PSD_SPEED_SKILLS',
    loop: true,
    layer: 'PassiveSkill',
    op: 'Flat',
    key: 'MoveSpeed',
    except: ['1320016'],
    exceptReasons: {
      1320016: '黑骑士四转 轉生 是带 `time`/`cooltime` 的主动增益技能，它的 psdSpeed 只在施放窗口内生效（第 3 层 ActiveBuff 语义）；本包没有黑骑士 buff 的施放分支 ⇒ 无法构成增益窗，也不能当成学得即生效的被动。哪天接了它的施放路径，必须改归 ActiveBuff 层并同时补 buff 时长。',
    },
  },  // 神聖祈禱-抗性提升 `2320047` 也带 asrR / terR，但它强化的是 **2311003 神聖祈禱 的增益窗**
  // 里的抗性（源里那本带 `time`），本包没有神聖祈禱的施法/增益实现 ⇒ 消费不了，登记在案。
  {
    field: 'asrR',
    array: 'ELEMENTAL_ADAPTING_SKILLS',
    loop: true,
    fieldVar: true,
    layer: 'PassiveSkill',
    op: 'Flat',
    key: 'StatusResistance',
    except: ['1210001', '2320047', '3110012', '3211011'],
    exceptReasons: {
      2320047: '神聖祈禱-抗性提升是 Hyper 被动，它加的抗性**依附于 2311003 神聖祈禱 的增益窗**（源里那本带 `time`）；本包没有神聖祈禱的施法与增益实现，也没有 2320047 自己的常量 ⇒ 它不属于「学得即生效」的那一格。哪天接了神聖祈禱，必须按增益窗改归 ActiveBuff 层。',
      1210001: '聖騎士二转 盾牌技能 的 common 带 `time`（1+u(x/4)）——源把它做成带时长的状态，抗性加成只在窗口内生效（ActiveBuff 语义）；本包没有聖騎士 buff 的施放分支 ⇒ 不按学得即生效读。哪天接了它的施放路径，必须改归 ActiveBuff 层并同时补 buff 时长。',
      3110012: '獵人二转 集中專注 的 common 带 `time`（30+3*x）——主动增益技能（第 3 层）；本包没有弓手 buff 的施放分支 ⇒ 不按学得即生效读。哪天接了施放路径，必须改归 ActiveBuff 层。',
      3211011: '弩弓手三转 止痛藥 的 common 带 `mpCon`+`cooltime`+`time` —— 明确的主动增益技能；本包没有弩手 buff 的施放分支 ⇒ 不按学得即生效读。哪天接了施放路径，必须改归 ActiveBuff 层。',
    },
  },
  {
    field: 'terR',
    array: 'ELEMENTAL_ADAPTING_SKILLS',
    loop: true,
    fieldVar: true,
    layer: 'PassiveSkill',
    op: 'Flat',
    key: 'ElementResistance',
    except: ['1210001', '2320047', '3110012', '3211011'],
    exceptReasons: {
      2320047: '同上：神聖祈禱-抗性提升的 terR 依附于神聖祈禱的增益窗，不是学得即生效的被动。',
      1210001: '同上：盾牌技能 的 common 带 `time`，terR 只在增益窗内生效，不是学得即生效的被动。',
      3110012: '同上：集中專注 是主动增益技能，terR 只在增益窗内生效。',
      3211011: '同上：止痛藥 是主动增益技能，terR 只在增益窗内生效。',
    },
  },
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
  const scoped = rule.scope ? catalogIds.filter(rule.scope) : catalogIds;
  const label = (rule.scope ? `${fields.join('+')}（scope 内）` : fields.join('+'));
  assert.ok(catalogIds.length > 0, `源技能表里一个 ${label} 都没有？形状变了`);
  const declared = declaredIds(rule);
  // `except` = 「源里有这个字段、但**明确不**进聚合」的技能，逐条登记（见 CONTENT_RULES
  // 里的 `exceptReasons`）。它必须被说出来，不能靠改断言静默跳过；反向断言再钉一层：
  // 一旦 world.rs 给它起了常量（= 有人接了消费路径），这里立刻红，要求重新决定。
  // 带 `scope` 的规则只对 scope 内的技能作这个「消费/不消费」二选一，
  // scope 外的成员必须被**别的规则或决策块**接住（不能凭空消失）。
  const excused = (rule.except ?? []).slice().sort();
  assert.deepEqual(
    scoped, [...declared, ...excused].sort(),
    `源里带 ${label} 的技能是 ${scoped.join('/')}，聚合模块声明消费的是 ${declared.join('/')}，`
      + `登记「不消费」的是 ${excused.join('/') || '（无）'}`
      + `——源里新增一个带该字段的技能而没人做决定，这里就会红`,
  );
  for (const id of excused) {
    assert.ok(
      rule.exceptReasons?.[id],
      `${id} 的 ${label} 登记为「不消费」却没写理由——登记表必须能回答「为什么」`,
    );
    assert.equal(
      constFor(Number(id)), null,
      `${id} 的 ${label} 登记为「不消费」，但 world.rs 已经给它起了常量 `
        + `${constFor(Number(id))}——要么把它补进消费表，要么把这条登记删掉`,
    );
  }
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
    // `key: null` 表示「对四维逐键留痕」，循环体里那一格就是循环变量 `key`
    // （`basicStatUp` 是唯一这种形状：外层逐本、内层逐键）。
    const loopKeySlot = rule.fieldVar || !rule.key
      ? '[A-Za-z_]+'
      : `AttributeKey::${rule.key}`;
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

// ── 物理线「武器精通」决策块（2026-09-22，目录并入四条职业线）─────────────
// `mastery+x` 复合形状在物理线（战/弓/侠）是「武器精通」族。它们的**决策**：
//   - `mastery`（武器熟练度，二转 14→50、四转 56→70）⇒ **消费**，进 `MASTERY_SKILLS`
//     （与法师 6 本同一格，`Highest`）——熟练度语义跨线一致，直接抬物理伤害区间下限；
//   - `x` = **命中率** ⇒ 不消费：本包战斗未建模命中/miss；
//   - `cr` / `criticaldamage` / `pdR` ⇒ 不消费：暴击率、暴击伤害与伤害率组的消费
//     只存在于法师魔法路径（`skills.rs::magic_critical_chance` / `magic_damage_breakdown`），
//     物理攻击路径没有这条管线；
//   - `actionSpeed`（1100000/1200000 的 -1）⇒ 不消费：攻速消费只接了法师 booster
//     （`psdWeaponBooster` 通道），这两本的攻速在 `levels` 里、通道不同；
//   - `1120003 進階鬥氣` 的 `damR`/`prop`/`v` ⇒ 不消费：斗气（combo）系统未实现。
// 这个块把「谁在名单里」钉死：物理 12 本必须**恰好**等于源里 mastery+x 且书不在
// 法师线的技能，且必须全部出现在 MASTERY_SKILLS 里。哪天物理路径接了暴击/伤害率
// 管线，这里会红，逼人把 x/cr/criticaldamage/pdR/actionSpeed 逐字段重新决定。
{
  const mageScope = id => {
    const book = Math.floor(Number(id) / 10000);
    return book >= 200 && book < 300;
  };
  const compositeIds = catalogIdsWithAll(['mastery', 'x']);
  // 物理线的 `mastery` 来源 = mastery+x 复合 12 本（战 4 + 弓 4 + 侠 4）
  // + 聖騎士精通 `1220018` 与黑骑士 進階武器精通 `1320018`（带 mastery 无 x，
  // 四转精通熟练度）= 14 本。
  const physicalMasteryIds = [
    ...compositeIds.filter(id => !mageScope(id)),
    '1220018',
    '1320018',
  ].sort();
  const mageMasteryIds = catalogIdsWith('mastery').filter(mageScope).sort();
  const masteryArray = idsForArray('MASTERY_SKILLS');
  assert.equal(
    physicalMasteryIds.length, 14,
    `物理线 mastery 来源应为 14 本（战 5 + 弓 4 + 侠 4 + 聖騎士精通），实际 ${physicalMasteryIds.length}`,
  );
  assert.deepEqual(
    [...new Set([...physicalMasteryIds, ...mageMasteryIds])].sort(), masteryArray,
    `MASTERY_SKILLS（${masteryArray.length} 本）必须恰好覆盖 `
      + `物理线 13 本（${physicalMasteryIds.join('/')}）+ 法师线 mastery 来源（${mageMasteryIds.join('/')}），`
      + '多一项少一项都要重新决定',
  );
  for (const id of physicalMasteryIds) {
    assert.ok(
      constFor(Number(id)) !== null,
      `物理线 mastery 技能 ${id} 没有 world.rs 常量——MASTERY_SKILLS 的成员必须以常量登记`,
    );
  }
}


// ── 進階祝福决策块（2026-09-23，缺口 C：主教四转 `2321005`）─────────────────
// 源形状（独立重算）：`time ∧ x ∧ y ∧ z ∧ indieMhp ∧ indieMmp ∧ mpConReduce`，
// `info` = `type=10 + massSpell=1 + magicSteal=1`（**队伍增益窗**：不是攻击，
// 也不是開關技能——開關那批的源 `common` 里没有 `time`）。
// 决策（逐字段写明，不许靠「没写」蒙过去）：
//   * `x` 攻击力 / `y` 魔力 / `z` 防御力 ⇒ **消费**，ActiveBuff 层 Flat 三格；
//   * `indieMhp` / `indieMmp` ⇒ **不消费**：源文案是「窗口内抬高最大 HP/MP」，
//     本包的 `max_hp` / `max_mp` 只由持久化基线与装备折叠算出，**没有**窗口内上限
//     这条管线（冥想同样只消费了 `indieMad`）；
//   * `mpConReduce` ⇒ **不消费**：本包没有「施法耗蓝按百分比折减」的消费点
//     （`mp_con` 是逐级绝对值）；
//   * `u` / `v` / `w` ⇒ 源 `perLevel` 文案里没有出现（源内部配方系数），不建模。
const ADVANCED_BLESSING_SHAPE = ['time', 'x', 'y', 'z', 'indieMhp', 'indieMmp', 'mpConReduce'];
const ADVANCED_BLESSING_NOT_CONSUMED = {
  indieMhp: '窗口内的最大 HP：本包的 max_hp 由持久化基线 + 装备 incMHP 算出，没有「窗口内抬高上限」这条管线（与冥想只消费 indieMad 同一口径）⇒ 这一个字段消费不了。哪天接了窗口内上限，必须改归 ActiveBuff 层的 MaxHp。',
  indieMmp: '窗口内的最大 MP：同上，没有「窗口内抬高上限」的管线 ⇒ 消费不了。',
  mpConReduce: '施法耗蓝的百分比折减：本包没有这个消费点（`mp_con` 是逐级绝对值，`costmpR` 那一路只被 2001002 魔心防禦用过）⇒ 消费不了。哪天接了耗蓝折减，必须在此登记处删掉。',
};
{
  const shapeIds = Object.entries(mageSkills.skills)
    .filter(([, skill]) =>
      ADVANCED_BLESSING_SHAPE.every(field => skill.levels.some(level => level[field] !== undefined)))
    .map(([id]) => id)
    .sort();
  const table = idsForArray('ADVANCED_BLESSING_SKILLS');
  assert.deepEqual(
    table, shapeIds,
    `world.rs 的 ADVANCED_BLESSING_SKILLS 是 ${table.join('/')}，`
      + `源里「${ADVANCED_BLESSING_SHAPE.join('∧')}」这个形状的技能是 ${shapeIds.join('/') || '（无）'}`
      + '——源里新增一本就必须有人做决定',
  );
  assert.ok(shapeIds.length > 0, '源技能表里找不到進階祝福这个形状？形状变了');
  const constant = 'SKILL_ADVANCED_BLESSING';
  // ① 三格留痕：层 / 技能 / 源字段名 / 属性键 / 作用方式逐字。
  for (const [field, key] of [['x', 'WeaponAttack'], ['y', 'MagicAttack'], ['z', 'WeaponDefense']]) {
    assert.ok(
      new RegExp(
        `AttributeLayer::ActiveBuff,\\s*Some\\(${constant}\\),\\s*"${field}",\\s*`
          + `AttributeKey::${key},\\s*AttributeOp::Flat,`,
      ).test(codeOnly(attributeSrc)),
      `進階祝福的 ${field} 没有按 ActiveBuff + AttributeKey::${key} + Flat 留痕`
        + '（这条声明就是口径，改了必须有人重新决定）',
    );
  }
  // ② 三格都要真的进各自的总量——只留痕不加进去，面板会好看但打不出来。
  for (const variable of ['blessing_pad', 'blessing_mad', 'blessing_pdd']) {
    assert.ok(
      new RegExp(`saturating_add\\(${variable}\\)`).test(codeOnly(attributeSrc)),
      `進階祝福的 ${variable} 没有进任何总量（只留痕不加 ⇒ 与实际数值分叉）`,
    );
  }
  // ③ 施法臂：时长从源 `time` 派生（不许写死 240 秒），且真的挂到队伍身上。
  const arm = /pub\(super\) fn activate_advanced_blessing\(&mut self[\s\S]*?\n {4}\}/.exec(elementalsSrc);
  assert.ok(arm, 'elemental.rs 里读不到 activate_advanced_blessing——施法臂被删了');
  assert.ok(
    /level\.time\.unwrap_or\(0\)/.test(arm[0]),
    'activate_advanced_blessing 没有从源 `time` 取窗口时长',
  );
  assert.ok(
    !/240_?000/.test(arm[0]),
    'activate_advanced_blessing 把 240 秒写死了：源 `time` 一变就会静默漂移',
  );
  assert.ok(
    /party_members_on_map\(id\)/.test(arm[0]),
    'activate_advanced_blessing 没有走队伍分发（源 `massSpell=1` 是队伍增益）',
  );
  assert.ok(
    /apply_buff\(\s*skill_id,\s*duration_ms,\s*self\.tick,\s*Release::AdvancedBlessing,\s*\)/
      .test(arm[0]),
    'activate_advanced_blessing 没有带 Release::AdvancedBlessing——窗口到期不会收回那三格加算',
  );
  // ④ 准入与清理。**逐处**钉，不钉「文件里出现过这个字符串」——
  //    `ADVANCED_BLESSING_SKILLS.contains(&skill_id)` 在 `skills.rs` 里有两处
  //    （施法白名单与施法动作时长），`player.advanced_blessing = None` 在 `world.rs`
  //    里也有两处（到期清理与会话清理入口）；只按「出现过」判会**另一处顶替**，
  //    删掉真正要钉的那一处门禁照样绿（实测踩到过）。
  const castableExpr = /let castable = ([^;]*);/.exec(codeOnly(skillsSrc));
  assert.ok(castableExpr, 'skills.rs 里读不到施法白名单 `let castable = …`——形状变了');
  assert.ok(
    /ADVANCED_BLESSING_SKILLS\.contains\(&skill_id\)/.test(castableExpr[1]),
    'skills.rs 的**施法白名单**没有读 ADVANCED_BLESSING_SKILLS——接了施法臂却仍会回「尚未开放施放」',
  );
  assert.ok(
    /ADVANCED_BLESSING_SKILLS\.contains\(&\w+\)\s*=>\s*\{[\s\S]{0,200}?activate_advanced_blessing\(/
      .test(codeOnly(skillsSrc)),
    'skills.rs 的施法分发没有把接纳表接到 activate_advanced_blessing',
  );
  const clearFn = /fn clear_beginner_buffs\(player: &mut Player\) \{([\s\S]*?)\n\}/.exec(worldSrc);
  assert.ok(clearFn, 'world.rs 里读不到会话清理入口 clear_beginner_buffs');
  assert.ok(
    /player\.advanced_blessing = None;/.test(clearFn[1]),
    'world.rs 的**会话清理入口**没有收回 advanced_blessing（死亡 / 换图 / 重连会残留）',
  );
  const releaseArm = /Release::AdvancedBlessing\s*=>\s*\{([\s\S]*?)\n {24}\}/.exec(worldSrc);
  assert.ok(releaseArm, 'world.rs 的清理 match 里没有 Release::AdvancedBlessing 分支');
  assert.ok(
    /player\.advanced_blessing = None;/.test(releaseArm[1]),
    'Release::AdvancedBlessing 分支没有收回 advanced_blessing（窗口到期会残留）',
  );
  assert.ok(
    /blessing: player\.advanced_blessing,/.test(attributeSrc),
    'AttributeInput::of 没有把 advanced_blessing 带进聚合——属性层看不到这条增益',
  );
  // ⑤ 登记「不消费」的三个字段：理由必须写出来，而且它们**确实不在运行期投影里**
  //    （不是「有人忘了接」，是投影边界没有这一格）。
  const mageSrc = read('mage.rs');
  for (const [field, why] of Object.entries(ADVANCED_BLESSING_NOT_CONSUMED)) {
    assert.ok(why, `${field} 登记为「不消费」却没写理由`);
    for (const id of shapeIds) {
      const value = mageSkills.skills[id].levels[0][field];
      assert.ok(
        Number(value) > 0,
        `${id} 的 ${field} 是 ${value}：登记「不消费」的前提是它**有取值**`
          + '（整级为 0 才叫空参数，那是另一条结论）',
      );
    }
    const snake = field.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
    assert.ok(
      !new RegExp(`pub ${snake}:`).test(mageSrc),
      `MageLevel 已经投影了 ${field}（${snake}）：`
        + '它现在是运行期模型里的一格，「不消费」的登记必须重新决定',
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
// 上限：被动移速用源 speedMax（已学来源的最小非零）夹，并入初学者速度后再 clamp(0,100)。
assert.ok(
  /passive_speed_max\.min\(100\)/.test(attributeCode),
  '被动移速的源上限（speedMax）不见了',
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
