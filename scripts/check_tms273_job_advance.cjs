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
//      **2b：外部前置必须真的接得到**——它的接取 NPC 得被摆在某张已装配的图上
//      （1404 挂在未装配的墮落城市 NPC 上，拿它当前置会让职业链静默锁死）；
//      **2c：二转分支没挂外部前置必须逐条登记理由**（漏写前置 = 玩家绕过剧情直接转职）；
//      **2d：可达性**——外部前置必须**真的做得完**（`executable` 为假的任务永远变不成
//      `completed`），且每条转职的 `fromJob` 必须**真的拿得到**（表内 toJob，或
//      「選擇岔道」菜单/1402 完成发放这类一转发放入口）。形状判据（NPC 摆位、怪有
//      刷新点、道具在表里）**证明不了这条路走得通**，这两条才是。
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
// 转职奖励里的技能必须真的在装配出来的技能表里（下表由 assemble 从导出树派生）。
// 少了这一条，`reward.skills` 会滑向「发一个玩家看不见也用不了的技能」——只有交付后才发现。
const mageSkills = readJson('shared/mage-skills.json').skills;

// 1) 形状 --------------------------------------------------------------------
assert.ok(typeof table.ruleVersion === 'string' && table.ruleVersion, 'job-advance.json ruleVersion');
assert.ok(Array.isArray(quests) && quests.length > 0, 'job-advance.json quests must be a non-empty array');

const seenIds = new Set();
// 同一职业可以挂多条（二转的火毒／冰雷／主教分支，由玩家在菜单里选），
// 但**一个职业只能由一条任务转出**，否则「转到哪」取决于配置顺序。
const seenToJobs = new Set();
const dialogueKeys = ['offer', 'locked', 'accept', 'progress', 'ready', 'complete'];

for (const quest of quests) {
  const where = `job-advance.json ${quest && quest.questId}`;
  assert.ok(typeof quest.questId === 'string' && quest.questId, `${where}: questId`);
  assert.ok(!seenIds.has(quest.questId), `${where}: questId 重复`);
  seenIds.add(quest.questId);

  assert.ok(Number.isInteger(quest.fromJob) && Number.isInteger(quest.toJob), `${where}: fromJob/toJob`);
  assert.notEqual(quest.fromJob, quest.toJob, `${where}: fromJob 不得等于 toJob`);
  assert.ok(!seenToJobs.has(quest.toJob),
    `${where}: toJob ${quest.toJob} 已被另一条任务占用（一个职业只能由一条任务转出）`);
  seenToJobs.add(quest.toJob);

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
    const granted = mageSkills[String(skill.skillId)];
    assert.ok(granted, `${where}: reward.skills[].skillId ${skill.skillId} 不在 shared/mage-skills.json 里`);
    assert.ok(skill.level <= granted.maxLevel, `${where}: reward.skills[].level ${skill.level} 超过源 maxLevel ${granted.maxLevel}`);
  }

  const dialogue = quest.dialogue || {};
  for (const key of dialogueKeys) {
    assert.ok(dialogue[key] && typeof dialogue[key].zh === 'string' && dialogue[key].zh, `${where}: dialogue.${key}.zh`);
    assert.ok(typeof dialogue[key].en === 'string' && dialogue[key].en, `${where}: dialogue.${key}.en`);
  }
}

// 2) 职业链 + **分支必须选得全、分得清** -------------------------------------
// 同一 fromJob 的多条＝二转分支。原版是站在同一位转职官面前挑路线，因此这些候选
// 必须挂在**同一位 NPC 的同一组地图**上：否则玩家要跑两张图各说一次话才能选完。
// 标题也必须互不相同——选项长得一样，玩家没法选。
const byFromJob = new Map();
for (const quest of quests) {
  if (!byFromJob.has(quest.fromJob)) byFromJob.set(quest.fromJob, []);
  byFromJob.get(quest.fromJob).push(quest);
}
for (const [fromJob, group] of byFromJob) {
  if (group.length === 1) continue;
  const npcIds = new Set(group.map(quest => String(quest.npc.templateId)));
  const places = new Set(group.map(quest => [...quest.npc.maps].sort().join('|')));
  const titles = new Set(group.map(quest => `${quest.title.zh}|${quest.title.en}`));
  assert.equal(npcIds.size, 1,
    `fromJob ${fromJob} 的 ${group.length} 条分支挂在不同 NPC 上（玩家一次会话选不全）`);
  assert.equal(places.size, 1,
    `fromJob ${fromJob} 的 ${group.length} 条分支挂在不同地图上（玩家一次会话选不全）`);
  assert.equal(titles.size, group.length,
    `fromJob ${fromJob} 的分支标题重复，菜单里分辨不出来`);
}
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

// 2b) 外部前置必须**真的接得到**：它的接取 NPC 得被摆在某张已装配的图上 ------------
// 只看「id 在通用任务目录里」是不够的。1404（盜賊之路）就挂在 `1052001`（墮落城市）：
// 那张图不在装配的 211 张图内、那个 NPC 连模板都不在 `gameplay.npcs` 里。拿它当飞侠
// 二转的前置，玩家到了 30 级点達克魯只会一直听到「你還不夠資格」——失败形态是**静默**的
// （和「还没接」长得一模一样），所以在这里把它变成一条会响的断言。
const generalQuestStartNpc = new Map(
  gameplay.quests.map(entry => [String(entry.questId), String((entry.start || {}).npcId || '')]),
);
const npcHasAnyPlacement = npcId =>
  [...npcPlacements].some(placement => placement.startsWith(`${npcId}@`));
for (const quest of quests) {
  for (const prerequisite of (quest.require && quest.require.quests) || []) {
    const id = String(prerequisite.questId);
    if (byId.has(id)) continue; // 表内前置由上面那条断言负责（toJob == fromJob）
    const npcId = generalQuestStartNpc.get(id);
    assert.ok(npcId, `${quest.questId}: 前置 ${id} 不是通用任务目录 shared/gameplay.json 里的一条任务`);
    assert.ok(
      npcHasAnyPlacement(npcId),
      `${quest.questId}: 前置 ${id} 的接取 NPC ${npcId} 没有被摆在任何已装配的图上——`
        + '这条前置永远接不到，整条职业链会静默锁死（换一条能接的前置，或把这条任务登记进 PREREQ_LESS_ALLOWED）',
    );
  }
}

// 2c) 「没有外部前置」必须逐条登记理由，否则漏写前置是看不出来的 ------------------
// 一转职业（100/200/300/400）转出去的那几条（＝二转分支）本来都该挂「本线的一转剧情
// 任务」。允许例外，但**只允许登记过的**——新增一条忘了写前置，这里就会红。
//
// 登记的三组理由其实是同一种失败的两个形态：**源里的一转剧情任务在本包跑不起来**。
//   * 1404（盜賊之路）：NPC 与地图都不在装配内容里（根本没得挂）；
//   * 1401（劍士之路）／1403（弓箭手之路）：NPC 与地图都在，但任务本身是
//     `executable:false`（`other-job-route` + `script-counter`）——它永远进不了
//     任务菜单、永远变不成 `completed`，挂了就是永久锁死（§2d 会把这类拦住）。
// 三条物理线的一转因此改由「選擇岔道」漢斯的四职业菜单发放（等级 10 = 源
// 1401/1403/1404 的 `Check.0.lvmin`），二转只按等级与上一段试炼判定。
const PREREQ_LESS_ALLOWED = new Map([
  ['job-110', '战士二转：一转剧情 1401（劍士之路）在装配内容里是 executable=false（other-job-route + script-counter），永远不可能 completed ⇒ 无可用的外部前置，改由「選擇岔道」漢斯的一转菜单发放职业'],
  ['job-120', '同上：战士二转的三条分支共用这一条理由'],
  ['job-130', '同上：战士二转的三条分支共用这一条理由'],
  ['job-310', '弓箭手二转：一转剧情 1403（弓箭手之路）在装配内容里是 executable=false（other-job-route + script-counter），永远不可能 completed ⇒ 无可用的外部前置，改由「選擇岔道」漢斯的一转菜单发放职业'],
  ['job-320', '同上：弓箭手二转的两条分支共用这一条理由'],
  ['job-410', '飞侠一转剧情 1404（盜賊之路）的接取 NPC 1052001 在墮落城市，该图与 NPC 都不在装配内容里 ⇒ 无可用的外部前置，改由「選擇岔道」漢斯的一转菜单发放职业'],
  ['job-420', '同上：飞侠二转的两条分支共用这一条理由'],
]);
for (const quest of quests) {
  if (![100, 200, 300, 400].includes(quest.fromJob)) continue;
  const external = ((quest.require && quest.require.quests) || [])
    .some(prerequisite => !byId.has(String(prerequisite.questId)));
  if (external) {
    assert.ok(
      !PREREQ_LESS_ALLOWED.has(quest.questId),
      `${quest.questId} 已经挂了外部前置，却仍登记在 PREREQ_LESS_ALLOWED 里——把这条登记删掉`,
    );
    continue;
  }
  assert.ok(
    PREREQ_LESS_ALLOWED.has(quest.questId),
    `${quest.questId}（${quest.fromJob} → ${quest.toJob}）没有外部前置，也没登记理由——`
      + '二转分支应当挂本线的一转剧情任务，漏写会让玩家绕过剧情直接转职',
  );
}

// 2d) 可达性：**形状判据证明不了这条路走得通** ------------------------------------
// 上面三组查的是「NPC 摆位 / 目标怪有刷新点 / 道具在表里」——都只是**形状**。
// 2026-09-22 核查发现它们漏掉两种「配置看起来毫无问题、玩家永远走不到」的静默失败：
//   * 前置任务本身**做不完**：1401/1403 的 NPC 摆位齐全（§2b 因此放行），可它们在
//     运行期是 `executable:false`（原版脚本计数器未复刻）⇒ 永远进不了任务菜单、
//     永远变不成 `completed`，挂着它们等于把战士/弓箭手线从二转起永久锁死；
//   * 起点**根本不存在**：转职的判据是「当前职业 == fromJob」，而三条物理线的一转
//     此前没有任何发放路径 ⇒ 二/三/四转全是够不着的死代码，配置却完全自洽。
// 两条都从 `shared/gameplay.json` 与 `shared/job-advance.json` 独立重算。
let reachability = null;
{
  const runtimeQuestById = new Map(
    gameplay.quests.map(entry => [String(entry.questId), entry]),
  );
  let checkedExternalPrerequisites = 0;
  for (const quest of quests) {
    for (const prerequisite of (quest.require && quest.require.quests) || []) {
      const id = String(prerequisite.questId);
      if (byId.has(id)) continue; // 表内前置由 §2 的 toJob / 等级断言负责
      const spec = runtimeQuestById.get(id);
      assert.ok(
        spec && spec.executable,
        `${quest.questId}: 外部前置 ${id} 在 shared/gameplay.json 里不是可执行任务`
          + `（blockedBy=${JSON.stringify(spec ? spec.blockedBy : null)}）——`
          + '它永远变不成 completed，挂上去只会让整条转职链静默锁死',
      );
      checkedExternalPrerequisites += 1;
    }
  }

  // 一转发放入口：装配内容里 NPC 对话节点的 `jobAdvance{fromJob:0}`（「選擇岔道」漢斯），
  // 加代码侧的源任务通道（1402 完成即转职，`server/src/quest.rs::first_mage_transfer`）。
  const scriptNodeExists = (script, name) => Boolean(script && script.nodes && script.nodes[name]);
  const scriptFirstJobs = new Set();
  let checkedScriptTransfers = 0;
  for (const npc of gameplay.npcs) {
    const script = npc.script;
    for (const node of Object.values((script && script.nodes) || {})) {
      const act = node && node.act;
      if (!act || act.kind !== 'jobAdvance') continue;
      checkedScriptTransfers += 1;
      assert.ok(
        Number.isInteger(act.job) && act.job > 0,
        `${npc.templateId}: NPC 脚本的 jobAdvance 必须带正整数 job`,
      );
      // 一转过后的成功对话是本脚本自己的节点：断掉它，转职会「生效了但对话没了」。
      assert.ok(
        !act.next || scriptNodeExists(script, act.next),
        `${npc.templateId}: jobAdvance 的 next 指向不存在的节点 ${act.next}`,
      );
      if (Number(act.fromJob) === 0) scriptFirstJobs.add(Number(act.job));
    }
  }
  const codeFirstJobs = new Set(
    readRepo('server/src/quest.rs').includes('first_mage_transfer') ? [200] : [],
  );
  const firstJobRoutes = new Set([...scriptFirstJobs, ...codeFirstJobs]);

  // 一转职业集**从目录派生**：有出边、却没有任何入边的那些 fromJob。
  // 手写一份名单会在同一条链新增分支时悄悄过期，这里让它自己长出来。
  const roots = [...byFromJob.keys()].filter(job => !seenToJobs.has(job));
  assert.deepEqual(
    roots.slice().sort((left, right) => left - right),
    [100, 200, 300, 400],
    '没有任何入边的职业必须正好是四条探险家线的一转职业（100/200/300/400）',
  );
  const reachableJobs = new Set([...seenToJobs, ...firstJobRoutes]);
  for (const quest of quests) {
    assert.ok(
      reachableJobs.has(quest.fromJob),
      `${quest.questId}: fromJob ${quest.fromJob} 没有任何可达路径——既不是本目录里`
        + '某条的 toJob，也没有一转发放入口，这条转职永远触发不了',
    );
  }
  for (const root of roots) {
    assert.ok(
      firstJobRoutes.has(root),
      `一转职业 ${root} 没有任何发放入口（装配的 NPC 脚本或 1402 的完成发放）——`
        + '它的整条分支链都是够不着的死代码',
    );
  }
  // 反向断言：解析真的看到了东西；且三条物理线**只有**脚本这一条通道
  // （1401/1403/1404 都不可执行），所以它们必须真的出现在脚本发放集里。
  assert.ok(
    scriptFirstJobs.size > 0 && checkedScriptTransfers > 0,
    '装配内容里没有任何由 NPC 脚本发放的转职（一转没有入口）',
  );
  for (const job of roots.filter(root => !codeFirstJobs.has(root))) {
    assert.ok(
      scriptFirstJobs.has(job),
      `一转职业 ${job} 没有源任务通道，必须由装配的 NPC 脚本发放`,
    );
  }
  reachability = {
    checkedExternalPrerequisites,
    checkedScriptTransfers,
    roots: roots.slice().sort((left, right) => left - right),
    scriptFirstJobs: [...scriptFirstJobs].sort((left, right) => left - right),
  };
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
// 至少要有一个职业是多分支的，否则服务端那段分支菜单是死代码。
assert.ok([...byFromJob.values()].some(group => group.length > 1),
  '目录必须含至少一个多分支职业（法师二转的火毒／冰雷／主教），否则分支菜单是死代码');
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
// 多分支要靠它才有入口：玩家在转职官面前挑路线，不是由配置顺序替他挑。
const jobAdvanceRs = readRepo('server/src/job_advance.rs');
assert.ok(jobAdvanceRs.includes('fn send_job_advance_branch_menu'),
  'server/src/job_advance.rs 没有分支菜单（多分支职业将无法选择路线）');
assert.ok(jobAdvanceRs.includes('fn candidates(') && jobAdvanceRs.includes('fn active_quest'),
  'server/src/job_advance.rs 缺 candidates/active_quest（分支解析）');
assert.ok(windowsCheck.includes("'shared/job-advance.json'"),
  'scripts/check_windows_resources.cjs 的 REQUIRED_JSON 缺 shared/job-advance.json（Windows 包漏表＝启动硬失败）');
assert.ok(runner.includes('check_tms273_job_advance.cjs'),
  'client/scripts/run-checks.mjs 没有登记 check_tms273_job_advance.cjs');

function main() {
  console.log(
    `Job advance catalog: ${quests.length} quests, ${checkedPlacements} npc placements, `
    + `${checkedMonsters} kill targets and ${checkedItems} collect targets verified against shared/*.json; `
    + `reachability: ${reachability.checkedExternalPrerequisites} executable prerequisites, `
    + `roots [${reachability.roots.join(', ')}] granted by [${reachability.scriptFirstJobs.join(', ')}]; wiring OK.`,
  );
  return {
    quests: quests.length,
    checkedPlacements,
    checkedMonsters,
    checkedItems,
    reachability,
  };
}

if (require.main === module) main();

module.exports = { main };
