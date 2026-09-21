#!/usr/bin/env node

// 门禁：`shared/job-advance.json`（转职任务目录）必须形状自洽、目标真的做得到、
// 转职官真的站在配置的那张图上，且服务端真的读它、Windows 包真的带它。
//
// 为什么需要它
// ------------
// `server/src/job_advance_acceptance.rs` 断言的是**自带的**那份目录：它证明「这份配置
// 能跑通」，证明不了「配置里写的怪/道具/转职官在装配出来的内容里真的存在」。转职任务
// 的失败形态又恰好全是静默的：
//   * 目标怪没有刷新点 ⇒ 击杀计数永远是 0，玩家只会一直听到「試煉還沒有完成」；
//   * 转职官没摆在那张图上 ⇒ 点了没反应（和「还没接」长得一模一样）；
//   * 收集道具不在 `items.json` ⇒ 持有量恒为 0，交付入口永远不出现；
//   * Windows 包漏了这张表 ⇒ `main.rs` 硬失败、3010 根本起不来（**启动期**才知道）。
// 这四条没有一条能被 Rust 侧的自带夹具抓到，所以单独成门禁。
//
// 断言分五组：
//   1. 形状：id 唯一、`fromJob` 在目录内唯一（保证同一时刻最多一条命中）、目标种类
//      与数量、奖励与六段台词齐备；
//   2. 职业链：前置要么是本表内上一段（`toJob == fromJob`），要么真的在通用任务目录
//      `shared/gameplay.json` 里（一转 1402 走通用任务系统），等级门槛沿链严格递增；
//   3. 内容可达（**从 shared/*.json 独立重算**）：转职官模板存在且**真的摆在**配置
//      的每张图上、目标怪存在且**真的有刷新点**、收集道具在 `items.json` 里、地图在
//      `shared/maps.json` 里；
//   4. 反向断言：两类目标（kill / collect）都要有实例、至少一条前置指向通用目录
//      （否则整条链是悬空的）、目录不得为空；
//   5. 接线：`main.rs` 加载并注入、`world.rs` 挂目录、`dialogue.rs` 在通用任务菜单
//      **之前**分发、`quest.rs` 并入击杀目标与任务日志、`check_windows_resources.cjs`
//      的 `REQUIRED_JSON` 带它、本门禁已进 `run-checks.mjs`。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const readRepo = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const readJson = relative => JSON.parse(readRepo(relative));

const table = readJson('shared/job-advance.json');
const gameplay = readJson('shared/gameplay.json');
const items = readJson('shared/items.json');
const catalog = readJson('shared/maps.json');

const quests = table.quests;

// --- 内容侧事实（**本文件自己读一遍**，不复用服务端或导出脚本的任何代码） ----------
const npcTemplates = new Set(gameplay.npcs.map(entry => String(entry.templateId)));
const npcPlacements = new Set(
  gameplay.npcSpawns.map(entry => `${String(entry.templateId)}@${String(entry.mapId)}`),
);
const monsterTemplates = new Set(gameplay.monsters.map(entry => String(entry.templateId)));
const monsterSpawnMaps = new Map();
for (const spawn of gameplay.spawns) {
  const key = String(spawn.templateId);
  if (!monsterSpawnMaps.has(key)) monsterSpawnMaps.set(key, new Set());
  monsterSpawnMaps.get(key).add(String(spawn.mapId));
}
const mapIds = new Set(catalog.maps.map(entry => String(entry.id)));
const generalQuestIds = new Set(gameplay.quests.map(entry => String(entry.questId)));
const itemIds = new Set(Object.keys(items));

// 1) 形状 --------------------------------------------------------------------
assert.ok(typeof table.ruleVersion === 'string' && table.ruleVersion, 'job-advance.json ruleVersion');
assert.ok(Array.isArray(quests) && quests.length > 0, 'job-advance.json quests must be a non-empty array');

const seenIds = new Set();
const seenFromJobs = new Set();
const dialogueKeys = ['offer', 'locked', 'accept', 'progress', 'ready', 'complete'];

for (const quest of quests) {
  const where = `job-advance.json ${quest && quest.questId}`;
  assert.ok(typeof quest.questId === 'string' && quest.questId, `${where}: questId`);
  assert.ok(!seenIds.has(quest.questId), `${where}: questId 重复`);
  seenIds.add(quest.questId);

  assert.ok(Number.isInteger(quest.fromJob) && Number.isInteger(quest.toJob), `${where}: fromJob/toJob`);
  assert.notEqual(quest.fromJob, quest.toJob, `${where}: fromJob 不得等于 toJob`);
  assert.ok(!seenFromJobs.has(quest.fromJob), `${where}: fromJob ${quest.fromJob} 在本目录内重复（同一时刻必须最多一条命中）`);
  seenFromJobs.add(quest.fromJob);

  assert.ok(quest.title && typeof quest.title.zh === 'string' && quest.title.zh, `${where}: title.zh`);
  const npc = quest.npc || {};
  assert.ok(typeof npc.templateId === 'string' && npc.templateId, `${where}: npc.templateId`);
  assert.ok(Array.isArray(npc.maps) && npc.maps.length > 0, `${where}: npc.maps 不得为空`);

  const require = quest.require || {};
  assert.ok(Number.isInteger(require.levelAtLeast) && require.levelAtLeast > 0, `${where}: require.levelAtLeast`);

  assert.ok(Array.isArray(quest.objectives) && quest.objectives.length > 0, `${where}: objectives 不得为空`);
  for (const objective of quest.objectives) {
    assert.ok(['kill', 'collect'].includes(objective.kind), `${where}: objective.kind 只支持 kill/collect`);
    assert.ok(Number.isInteger(objective.required) && objective.required > 0, `${where}: objective.required`);
    assert.ok(objective.text && typeof objective.text.zh === 'string' && objective.text.zh, `${where}: objective.text.zh`);
    if (objective.kind === 'kill') {
      assert.ok(/^\d+$/.test(String(objective.mobId)), `${where}: kill 目标必须带数字 mobId`);
    } else {
      assert.ok(/^\d+$/.test(String(objective.itemId)), `${where}: collect 目标必须带数字 itemId`);
    }
  }

  const reward = quest.reward || {};
  assert.ok(Array.isArray(reward.skillPoints), `${where}: reward.skillPoints`);
  for (const grant of reward.skillPoints) {
    assert.ok(Number.isInteger(grant.book) && grant.book > 0, `${where}: reward.skillPoints[].book`);
    assert.ok(Number.isInteger(grant.amount) && grant.amount > 0, `${where}: reward.skillPoints[].amount`);
  }
  assert.ok(Array.isArray(reward.skills), `${where}: reward.skills`);
  for (const skill of reward.skills) {
    assert.ok(Number.isInteger(skill.skillId) && skill.skillId > 0, `${where}: reward.skills[].skillId`);
    assert.ok(Number.isInteger(skill.level) && skill.level > 0, `${where}: reward.skills[].level`);
  }

  const dialogue = quest.dialogue || {};
  for (const key of dialogueKeys) {
    assert.ok(dialogue[key] && typeof dialogue[key].zh === 'string' && dialogue[key].zh, `${where}: dialogue.${key}.zh`);
    assert.ok(typeof dialogue[key].en === 'string' && dialogue[key].en, `${where}: dialogue.${key}.en`);
  }
}

// 2) 职业链 ------------------------------------------------------------------
const byId = new Map(quests.map(quest => [quest.questId, quest]));
for (const quest of quests) {
  const prerequisites = (quest.require && quest.require.quests) || [];
  assert.ok(Array.isArray(prerequisites), `${quest.questId}: require.quests`);
  for (const prerequisite of prerequisites) {
    const upstream = byId.get(prerequisite.questId);
    if (upstream) {
      // 本表内的前置必须是紧邻的上一段职业，否则链会断在中间。
      assert.equal(upstream.toJob, quest.fromJob,
        `${quest.questId}: 前置 ${prerequisite.questId} 的 toJob 必须等于本条的 fromJob`);
      assert.ok(upstream.require.levelAtLeast < quest.require.levelAtLeast,
        `${quest.questId}: 等级门槛必须沿职业链严格递增`);
    } else {
      // 表外前置必须真的在通用任务目录里（一转 1402 走通用任务系统）。
      assert.ok(generalQuestIds.has(String(prerequisite.questId)),
        `${quest.questId}: 前置 ${prerequisite.questId} 既不在本目录也不在通用任务目录`);
    }
    assert.ok(!prerequisite.status || ['completed', 'active'].includes(prerequisite.status),
      `${quest.questId}: 前置 status 只支持 completed/active`);
  }
}

// 3) 内容可达：转职官真的在、目标真的做得到 ------------------------------------
let checkedPlacements = 0;
let checkedMonsters = 0;
let checkedItems = 0;
for (const quest of quests) {
  const npc = quest.npc;
  assert.ok(npcTemplates.has(String(npc.templateId)),
    `${quest.questId}: NPC 模板 ${npc.templateId} 不在 shared/gameplay.json 里`);
  for (const mapId of npc.maps) {
    const id = String(mapId);
    assert.ok(mapIds.has(id), `${quest.questId}: 地图 ${id} 不在 shared/maps.json 里`);
    // 转职官没摆在这张图上 ⇒ 玩家点不到 ⇒ 「点了没反应」。
    assert.ok(npcPlacements.has(`${npc.templateId}@${id}`),
      `${quest.questId}: NPC ${npc.templateId} 没有摆在地图 ${id} 上（点了没反应）`);
    checkedPlacements += 1;
  }
  for (const objective of quest.objectives) {
    if (objective.kind === 'kill') {
      const mobId = String(objective.mobId);
      assert.ok(monsterTemplates.has(mobId),
        `${quest.questId}: 目标怪 ${mobId} 不在 shared/gameplay.json 的 monsters 里`);
      // 有模板但没有任何刷新点 ⇒ 击杀计数恒为 0，任务永远做不完。
      assert.ok(monsterSpawnMaps.has(mobId),
        `${quest.questId}: 目标怪 ${mobId} 在装配内容里没有任何刷新点（永远打不到）`);
      checkedMonsters += 1;
    } else {
      const itemId = String(objective.itemId);
      assert.ok(itemIds.has(itemId),
        `${quest.questId}: 收集目标 ${itemId} 不在 shared/items.json 里（持有量恒为 0）`);
      checkedItems += 1;
    }
  }
}

// 4) 反向断言：防空表、防只有一条通道有实例 ------------------------------------
const kinds = new Set(quests.flatMap(quest => quest.objectives.map(objective => objective.kind)));
assert.ok(kinds.has('kill') && kinds.has('collect'),
  '目录必须同时含 kill 与 collect 两类目标（否则另一条进度通道是死代码）');
const externalPrerequisites = quests.flatMap(quest => (quest.require.quests || []))
  .filter(prerequisite => !byId.has(prerequisite.questId));
assert.ok(externalPrerequisites.length > 0,
  '至少要有一条前置指向通用任务目录，否则整条转职链与一转脱节');
assert.ok(checkedPlacements > 0 && checkedMonsters > 0 && checkedItems > 0, '没有任何内容可达性断言被真正执行');

// 5) 接线 --------------------------------------------------------------------
const mainRs = readRepo('server/src/main.rs');
const worldRs = readRepo('server/src/world.rs');
const dialogueRs = readRepo('server/src/dialogue.rs');
const questRs = readRepo('server/src/quest.rs');
const windowsCheck = readRepo('scripts/check_windows_resources.cjs');
const runner = readRepo('client/scripts/run-checks.mjs');

assert.ok(mainRs.includes('shared/job-advance.json'), 'server/src/main.rs 没有加载 shared/job-advance.json');
assert.ok(mainRs.includes('.with_job_advance('), 'server/src/main.rs 没有把目录注入 World');
assert.ok(worldRs.includes('pub(crate) mod job_advance'), 'server/src/world.rs 没有挂 job_advance 模块');
assert.ok(worldRs.includes('pub fn with_job_advance'), 'server/src/world.rs 缺 with_job_advance');
// 分发必须在通用任务菜单之前：判据是「当前职业 == fromJob」，若排在后面会被
// 通用任务菜单先截走（新手与已转职角色各有各的入口，顺序错了两者都会错）。
const dispatchAt = dialogueRs.indexOf('handle_job_advance_talk(');
assert.ok(dispatchAt > 0, 'server/src/dialogue.rs 没有分发 handle_job_advance_talk');
assert.ok(dispatchAt < dialogueRs.indexOf('handle_quest_npc_menu('),
  'server/src/dialogue.rs：转职分发必须排在通用任务菜单之前');
assert.ok(questRs.includes('job_advance_kill_targets'), 'server/src/quest.rs 没有把转职击杀目标并入同一张表');
assert.ok(questRs.includes('job_advance_log_entries'), 'server/src/quest.rs 没有给转职任务正式日志条目');
assert.ok(windowsCheck.includes("'shared/job-advance.json'"),
  'scripts/check_windows_resources.cjs 的 REQUIRED_JSON 缺 shared/job-advance.json（Windows 包漏表＝启动硬失败）');
assert.ok(runner.includes('check_tms273_job_advance.cjs'),
  'client/scripts/run-checks.mjs 没有登记 check_tms273_job_advance.cjs');

function main() {
  console.log(
    `Job advance catalog: ${quests.length} quests, ${checkedPlacements} npc placements, `
    + `${checkedMonsters} kill targets and ${checkedItems} collect targets verified against shared/*.json; wiring OK.`,
  );
  return { quests: quests.length, checkedPlacements, checkedMonsters, checkedItems };
}

if (require.main === module) main();

module.exports = { main };
