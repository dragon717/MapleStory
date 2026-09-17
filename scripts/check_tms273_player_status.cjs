#!/usr/bin/env node

// 门禁：玩家限时状态（技能增益 / 怪物疾病 / 異常狀態免疫窗）必须是**一处权威**，
// 且源 MobSkill id 的处置登记表不许过期。
//
// 背景（2026-09-17「玩家限时状态权威模块」）：改前这批状态散在 `Player` 的八个裸字段上，
// 同一件事有两套表示（`skill_buffs` 存剩余毫秒逐 tick 相减、五个疾病存世界 tick 截止点），
// 长出三套生效判据（`contains_key` / `>0` / `>tick`），到期清理又按**写死的技能名单**逐条
// 手写在 `world.rs` 的 tick 块里。收口之后，「哪些 id 会被放出来」「没接的那几个为什么没接」
// 从一段会腐烂的注释变成了一张会被重算的表。
//
// 断言分七组：
//   1. **解析自检**：登记表与常量必须能被本脚本解出来，且形状就是设计时的那几种
//      （解析不到就失败——门禁不许因为源码被改写而静默不检查）；
//   2. **两个方向只有一个定义处**：`mob_skill_id`（疾病→id）是唯一权威，
//      `from_mob_skill_id` 由它派生；不存在第二张反向 match；
//   3. **内容 → 表**：`shared/gameplay.json` 里出现的每一个 MobSkill id 都必须在表里
//      有**显式结论**（`Disease` / `Unmodelled` / 显式 `NotADisease`）——落入兜底
//      `_ => NotADisease` 不算结论，新 id 进内容必须有人做决定；
//   4. **源侧独立分类**：`Skill/MobSkill/<id>.json` 里带 `affected` 节点的技能是**打玩家**的，
//      只带 `mob`/`mob0` 的是打怪的。内容里被登记为疾病的 id 必须 `affected`，
//      被登记为 `NotADisease` 的必须不是（否则就是「把打玩家的减益静默丢掉」）；
//   5. **反向断言（名单过期要失败）**：表里声明已建模但本版内容没投放的 id、
//      以及登记为未建模但没投放的 id，都必须逐条列名；一旦某个 id 真的进了内容，
//      豁免名单必须同步删掉，否则这条断言会红；
//   6. **唯一权威的接线**：`world.rs` 只有一处推进点、清理块覆盖 `Release` 全部变体、
//      `monsters.rs` 真的消费这张表、`player_status.rs` 内部不再用 `contains_key` 判生效、
//      全仓不再出现被删掉的裸字段；
//   7. **协议没动**：`derivedStats.skillBuffs` 与 `abnormalStatus` 的 wire 形状逐字未变
//      （这次是零风险的内部重构，协议 24 不该被动过）。
//
// 本脚本从源码里读表，用的是窄正则 + 形状断言，不是「解析 Rust」。源码改写导致解不出来时，
// 第 1 组会失败，而不是让门禁悄悄地什么都不检查。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SERVER_SRC = path.join(ROOT, 'server/src');
const WZ_JSON = path.join(ROOT, '参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW');
const MOB_SKILL_DIR = path.join(WZ_JSON, 'Skill/MobSkill');

const statusSrc = fs.readFileSync(path.join(SERVER_SRC, 'player_status.rs'), 'utf8');
const worldSrc = fs.readFileSync(path.join(SERVER_SRC, 'world.rs'), 'utf8');
const monstersSrc = fs.readFileSync(path.join(SERVER_SRC, 'monsters.rs'), 'utf8');
const skillsSrc = fs.readFileSync(path.join(SERVER_SRC, 'skills.rs'), 'utf8');
const protocolSrc = fs.readFileSync(path.join(SERVER_SRC, 'protocol.rs'), 'utf8');
const gameplay = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/gameplay.json'), 'utf8'));

// ---------------------------------------------------------------------------
// 1. 把登记表从源码里解出来
// ---------------------------------------------------------------------------

/**
 * `const MOB_SKILL_SEAL: u32 = 120;` → { SEAL: 120, ... }
 *
 * 常量本身留在 `world.rs`（导入器与既有的双向断言都按它取值），疾病 → id 的**映射**
 * 才在 `player_status.rs`。两边都要读，所以这里不把它当同一份文件。
 */
const mobSkillConst = new Map();
for (const match of worldSrc.matchAll(/const MOB_SKILL_([A-Z_]+): u32 = (\d+);/g)) {
  mobSkillConst.set(match[1], Number(match[2]));
}
assert.ok(
  mobSkillConst.size >= 5,
  `world.rs 里只解出 ${mobSkillConst.size} 个 MOB_SKILL_* 常量，形状变了`,
);

/** `Disease::Seal => MOB_SKILL_SEAL,` —— 疾病 → 源 id 的唯一定义处。 */
const diseaseToId = new Map();
for (const match of statusSrc.matchAll(/Disease::(\w+) => MOB_SKILL_([A-Z_]+),/g)) {
  assert.ok(
    mobSkillConst.has(match[2]),
    `Disease::mob_skill_id 引用了不存在的常量 MOB_SKILL_${match[2]}`,
  );
  diseaseToId.set(match[1], mobSkillConst.get(match[2]));
}
assert.equal(
  diseaseToId.size, 5,
  'Disease::mob_skill_id 不再是 5 个臂：要么漏了疾病，要么表被拆成了两处',
);

/** `const ALL: [Disease; 5] = [Disease::Seal, ...];` */
const allMatch = /const ALL: \[Disease; (\d+)\] = \[([\s\S]*?)\];/.exec(statusSrc);
assert.ok(allMatch, 'player_status.rs 里读不到 Disease::ALL——遍历顺序权威丢了');
const allDiseases = [...allMatch[2].matchAll(/Disease::(\w+)/g)].map(match => match[1]);
assert.equal(
  Number(allMatch[1]), allDiseases.length,
  `Disease::ALL 声明的长度 ${allMatch[1]} 与实际列出的 ${allDiseases.length} 项不一致`,
);
assert.deepEqual(
  [...allDiseases].sort(), [...diseaseToId.keys()].sort(),
  'Disease::ALL 与 Disease::mob_skill_id 覆盖的疾病集合不一致',
);

/**
 * `mob_skill_effect` 的函数体。它是一个顶层函数，所以收口在下一个行首 `}`。
 * 表里已建模的那五个不再各写一行（由 `Disease::from_mob_skill_id` 决定），
 * 因此这里解出来的只有「未建模」与「不是疾病」两类。
 */
const effectStart = statusSrc.indexOf('pub(super) fn mob_skill_effect(');
assert.ok(effectStart >= 0, 'player_status.rs 里找不到 mob_skill_effect——登记表没了');
const effectEnd = statusSrc.indexOf('\n}', effectStart);
assert.ok(effectEnd > effectStart, 'mob_skill_effect 的函数体收不了口，形状变了');
const effectBody = statusSrc.slice(effectStart, effectEnd);

/** 去掉字符串字面量后的臂，便于逐行匹配 `1 | 2 => SkillEffect::X`。 */
const effectWithoutStrings = effectBody.replace(/"(?:[^"\\]|\\.|\\\n)*"/g, '""');
const unmodelledIds = [];
const notADiseaseIds = [];
for (const match of effectWithoutStrings.matchAll(
  /((?:\d+\s*\|\s*)*\d+)\s*=>\s*SkillEffect::(\w+)/g,
)) {
  const ids = match[1].split('|').map(text => Number(text.trim()));
  if (match[2] === 'Unmodelled') unmodelledIds.push(...ids);
  else if (match[2] === 'NotADisease') notADiseaseIds.push(...ids);
  else assert.fail(`mob_skill_effect 出现了未知处置 SkillEffect::${match[2]}`);
}
assert.ok(
  unmodelledIds.length > 0,
  'mob_skill_effect 里解不出任何 Unmodelled 臂：登记表被清空了？',
);
assert.ok(
  notADiseaseIds.length > 0,
  'mob_skill_effect 里解不出任何显式 NotADisease 臂：内容里那几个打怪的技能成了兜底',
);
assert.ok(
  /_ => SkillEffect::NotADisease/.test(effectWithoutStrings),
  'mob_skill_effect 的兜底臂不在预期形状上（解析会失真）',
);
assert.ok(
  /if let Some\(disease\) = Disease::from_mob_skill_id\(id\)/.test(effectWithoutStrings),
  'mob_skill_effect 不再用 Disease::from_mob_skill_id 取已建模的五个：两处表会各自漂移',
);

/** 未建模条目必须带理由。 */
const reasons = new Map();
for (const match of effectBody.matchAll(
  /(\d+)\s*=>\s*SkillEffect::Unmodelled\(\s*"([\s\S]*?)"\s*[),]/g,
)) {
  reasons.set(Number(match[1]), match[2]);
}

const modelledIds = new Set(diseaseToId.values());
const unmodelledIdSet = new Set(unmodelledIds);
const notADiseaseIdSet = new Set(notADiseaseIds);

// ---------------------------------------------------------------------------
// 2. 两个方向只有一个定义处
// ---------------------------------------------------------------------------
{
  const ids = [...modelledIds];
  assert.equal(
    new Set(ids).size, ids.length,
    '两个疾病映射到同一个源 MobSkill id：施加时会互相冒充',
  );
  const reverse = /pub\(super\) fn from_mob_skill_id[\s\S]*?\n    \}/.exec(statusSrc);
  assert.ok(reverse, 'player_status.rs 里读不到 from_mob_skill_id');
  assert.ok(
    /Disease::ALL/.test(reverse[0]) && /mob_skill_id\(\)/.test(reverse[0]),
    'from_mob_skill_id 不再由 mob_skill_id 派生——反向表又被写成第二张手抄名单',
  );
  assert.ok(
    !/MOB_SKILL_/.test(reverse[0]),
    'from_mob_skill_id 里又出现了 MOB_SKILL_* 常量：两个方向各自成表了',
  );
}

// ---------------------------------------------------------------------------
// 3. 内容 → 表：每个出现的 id 都必须有显式结论
// ---------------------------------------------------------------------------
const templateSkillIds = new Set();
for (const monster of gameplay.monsters) {
  for (const skill of monster.skills || []) {
    const id = skill.skillId ?? skill.id;
    assert.ok(Number.isInteger(id), `${monster.templateId} 的技能条目没有 skillId`);
    templateSkillIds.add(id);
  }
}
assert.ok(templateSkillIds.size > 0, 'gameplay.json 里一个带技能的怪都没有：内容侧断了');

/** 真的会被部署到地图上的模板（只有它们才会在运行时把技能放出来）。 */
const placedTemplateIds = new Set(gameplay.spawns.map(spawn => spawn.templateId));
const placedSkillIds = new Set();
for (const monster of gameplay.monsters) {
  if (!placedTemplateIds.has(monster.templateId)) continue;
  for (const skill of monster.skills || []) placedSkillIds.add(skill.skillId ?? skill.id);
}

const dispositionOf = id => {
  if (modelledIds.has(id)) return 'modelled';
  if (unmodelledIdSet.has(id)) return 'unmodelled';
  if (notADiseaseIdSet.has(id)) return 'not-a-disease';
  return 'unclassified';
};
for (const id of [...templateSkillIds].sort((a, b) => a - b)) {
  assert.notEqual(
    dispositionOf(id), 'unclassified',
    `内容里的 MobSkill ${id} 在登记表里没有显式结论（落进了兜底臂）：`
    + '要么把它建模成疾病，要么登记成未建模并写明理由',
  );
}

// ---------------------------------------------------------------------------
// 4. 源侧独立分类：`affected` == 打玩家
// ---------------------------------------------------------------------------
/** 一条 MobSkill 是打玩家还是打怪，只能从源的两个子节点看：`affected` / `mob`。 */
function sourceShape(id) {
  const file = path.join(MOB_SKILL_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return undefined;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const keys = new Set();
  for (const level of Object.values(raw.level || {})) {
    if (level && typeof level === 'object') for (const key of Object.keys(level)) keys.add(key);
  }
  return { affected: keys.has('affected'), mob: keys.has('mob') || keys.has('mob0') };
}

const affectedInContent = [];
const notAffectedInContent = [];
for (const id of [...templateSkillIds].sort((a, b) => a - b)) {
  const shape = sourceShape(id);
  assert.ok(shape, `内容里的 MobSkill ${id} 在源 Skill/MobSkill/ 里没有对应文件`);
  const disposition = dispositionOf(id);
  if (disposition === 'not-a-disease') {
    assert.ok(
      !shape.affected,
      `MobSkill ${id} 被登记为 NotADisease，但源里它带 affected（打玩家）：`
      + '这条玩家的减益会被静默丢掉',
    );
    notAffectedInContent.push(id);
  } else {
    assert.ok(
      shape.affected,
      `MobSkill ${id} 被登记为疾病（${disposition}），但源里它没有 affected 节点（不是打玩家的）：`
      + '把打怪的技能当成玩家减益了',
    );
    affectedInContent.push(id);
  }
}

// ---------------------------------------------------------------------------
// 5. 反向断言：名单过期要失败
// ---------------------------------------------------------------------------
// 这四张名单是「本版内容与登记表之间的差额」。任何一个 id 的归属变了，这里就会红——
// 逼着改动者回来把名单和结论一起更新，而不是让豁免悄悄留下来。
const MODELLED_NOT_PLACED = [123, 126];
const UNMODELLED_PLACED = [128];
const UNMODELLED_NOT_PLACED = [121, 122, 133, 134, 137];
const NOT_A_DISEASE_PLACED = [112, 113, 114, 170, 200];

const sorted = values => [...values].sort((a, b) => a - b);
const placedModelled = sorted([...modelledIds].filter(id => placedSkillIds.has(id)));
const unplacedModelled = sorted([...modelledIds].filter(id => !placedSkillIds.has(id)));
const placedUnmodelled = sorted([...unmodelledIdSet].filter(id => placedSkillIds.has(id)));
const unplacedUnmodelled = sorted([...unmodelledIdSet].filter(id => !placedSkillIds.has(id)));
const placedNotADisease = sorted(
  [...templateSkillIds].filter(id => dispositionOf(id) === 'not-a-disease'),
);

assert.deepEqual(
  placedModelled, [120, 124, 125],
  '已建模且本版有投放的疾病 id 变了：内容或表有一侧动了，请同步本脚本的名单',
);
assert.deepEqual(
  unplacedModelled, MODELLED_NOT_PLACED,
  '已建模但没有投放怪的疾病 id 变了（123 封印 / 126 緩速 是刻意的保留）。'
  + '若某个 id 现在真的进了内容，请从 MODELLED_NOT_PLACED 里删掉它；'
  + '若新增了未投放的疾病，改名册而不是删断言',
);
assert.deepEqual(
  placedUnmodelled, UNMODELLED_PLACED,
  '登记为「未建模」但本版有投放的 id 变了：这批 id 的玩家减益是**知道不做**，不是漏做',
);
assert.deepEqual(
  unplacedUnmodelled, UNMODELLED_NOT_PLACED,
  '登记为未建模且本版没投放的 id 变了：名单过期，请同步（豁免不许留着不用的条目）',
);
assert.deepEqual(
  placedNotADisease, NOT_A_DISEASE_PLACED,
  '内容里被判为 NotADisease 的 id 集合变了：请确认新 id 是怪物自身增益/召唤，再同步名单',
);

// 未建模的每一条都必须给出**可用**的理由。
for (const id of unmodelledIdSet) {
  const reason = reasons.get(id);
  assert.ok(reason, `未建模的 MobSkill ${id} 没有解出理由文本`);
  assert.ok(
    reason.replace(/\\\s*\n\s*/g, '').trim().length >= 12,
    `未建模的 MobSkill ${id} 的理由太短：${reason}`,
  );
  assert.ok(!reason.includes('未知'), `未建模的 MobSkill ${id} 用「未知」搪塞`);
}
{
  const texts = [...reasons.values()].map(text => text.replace(/\s+/g, ''));
  assert.equal(
    new Set(texts).size, texts.length,
    '两条未建模的理由逐字相同：多半是复制粘贴，没有真的说明为什么不做',
  );
}

// ---------------------------------------------------------------------------
// 6. 唯一权威的接线
// ---------------------------------------------------------------------------
// 唯一推进点：本拍由状态自己盖章，读取侧不传 tick。
assert.ok(
  /player\.status\.advance\(self\.tick\)/.test(worldSrc),
  'world.rs 的 tick 块不再调用 player.status.advance(self.tick)：限时状态没有推进点',
);
// 到期清理必须穷尽 `Release`——编译器已经保证，这里再钉一次「没有人把清理块删成 _ => {}」。
for (const variant of ['None', 'BeginnerRecovery', 'BeginnerSpeed', 'Infinity', 'StatusImmunity']) {
  assert.ok(
    new RegExp(`Release::${variant}\\b`).test(worldSrc),
    `world.rs 的清理 match 里没有 Release::${variant}：到期时它的附属状态会留在身上`,
  );
}
// 疾病脉冲也要走到。
assert.ok(
  /player\.status\.due_dots\(\)/.test(worldSrc),
  'world.rs 不再消费 due_dots()：中毒/詛咒的周期伤害断了',
);
// 表必须驱动**生产**路径，不能只给测试用。
assert.ok(
  /mob_skill_effect\(/.test(monstersSrc) && /SkillEffect::Unmodelled/.test(monstersSrc),
  'monsters.rs 不再消费 mob_skill_effect：登记表退回成「只有测试读的注释」',
);
// 生效判据只有 `*_active` 一族：`contains_key` 不许再当判据用。
assert.ok(
  !/\.(buffs|diseases)\.contains_key|contains_key\(&/.test(statusSrc),
  'player_status.rs 内部又出现了 contains_key 判生效：三套判据会重新长出来',
);
// 验收专用的两个访问器必须留在 `#[cfg(test)]` 里，免得变成第二个判据源。
for (const name of ['disease_deadline', 'disease_next_tick']) {
  assert.ok(
    new RegExp(`#\\[cfg\\(test\\)\\]\\s*\\n\\s*pub\\(super\\) fn ${name}\\(`).test(statusSrc),
    `${name} 不再是 #[cfg(test)] 访问器：它会被当成生产判据用`,
  );
}
// 被删掉的裸字段不许复活（`Monster.stun_until` 是怪物的，不在此列）。
const removedFields = [
  'skill_buffs', 'seal_until', 'stun_until', 'curse_until', 'poison_until', 'slow_until',
  'poison_next_tick', 'curse_next_tick', 'status_immune_until',
];
for (const file of walk(SERVER_SRC)) {
  if (file.endsWith('player_status.rs')) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const field of removedFields) {
    const hit = new RegExp(`\\bplayer\\.${field}\\b`).exec(text);
    assert.ok(
      !hit,
      `${path.relative(ROOT, file)} 里又出现了 player.${field}：`
      + '限定状态必须只有 PlayerStatus 一处，加回裸字段就是第二条权威',
    );
  }
  assert.ok(
    !/\bPlayerDisease\b/.test(text),
    `${path.relative(ROOT, file)} 里又出现了 PlayerDisease：疾病类型已经收进 player_status::Disease`,
  );
}
// 快照只报仍在生效的五个疾病，一个都不能少。
for (const disease of allDiseases) {
  assert.ok(
    new RegExp(`remaining\\(Disease::${disease}\\)`).test(statusSrc),
    `快照投影里没有 Disease::${disease}：客户端会看到一条永远为 None 的减益`,
  );
}
// 会话清理只有一个入口。
assert.ok(
  /player\.status\.clear\(\)/.test(worldSrc),
  'world.rs 不再调用 PlayerStatus::clear()：死亡/换图/重连没有统一的清理点',
);
// 接触疾病（`info/bodyDisease`）入口没被顺手删掉——本版内容暂时没有怪带它，
// 但删了它就成了「源里有、代码里没有」的静默缺失。
assert.ok(
  /MOB_DISEASE_CONTACT_BASE_MS/.test(monstersSrc) && /body_disease/.test(monstersSrc),
  'monsters.rs 的接触疾病入口不见了：bodyDisease 这条源入口被静默删掉',
);

// ---------------------------------------------------------------------------
// 7. 协议没动
// ---------------------------------------------------------------------------
assert.ok(
  /pub skill_buffs: Option<BTreeMap<u32, u64>>/.test(protocolSrc),
  'derivedStats.skillBuffs 的 wire 形状变了：这次重构不该动协议',
);
assert.ok(
  /struct AbnormalStatus \{[\s\S]*?seal_ms: Option<u64>[\s\S]*?stun_ms: Option<u64>[\s\S]*?curse_ms: Option<u64>[\s\S]*?poison_ms: Option<u64>[\s\S]*?slow_ms: Option<u64>/.test(protocolSrc),
  'abnormalStatus 的五个字段形状变了：这次重构不该动协议',
);
// 客户端零改动：它只按字段名读，服务端不许改口径（这里只断言技能栏的读入口仍在）。
assert.ok(
  /skillBuffs/.test(fs.readFileSync(path.join(ROOT, 'shared/protocol.ts'), 'utf8')),
  'shared/protocol.ts 里没有 skillBuffs：客户端状态栏会读不到增益',
);

// 施法路径的封印/眩晕判据也收敛到同一族，不再直接比 tick。
assert.ok(
  /player\.status\.suppresses_skill_cast\(\)/.test(skillsSrc),
  'skills.rs 的施法前检查不再用 suppresses_skill_cast()：判据又分叉了',
);

console.log(
  `player timed status: ${modelledIds.size} modelled disease ids `
  + `(${placedModelled.join('/')} placed, ${unplacedModelled.join('/')} modelled-but-unplaced), `
  + `${unmodelledIdSet.size} unmodelled (${placedUnmodelled.join('/')} placed, every one with a reason), `
  + `${placedNotADisease.length} content ids are mob-self skills; `
  + `content skill ids ${sorted(templateSkillIds).join('/')}, `
  + `${placedSkillIds.size} of them on placed spawns; `
  + 'one authoritative advance(), one exhaustive Release match, protocol untouched.',
);

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith('.rs')) yield full;
  }
}
