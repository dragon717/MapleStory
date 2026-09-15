// TMS273 主线后续章节复刻：36314 之后的冒险家章节、各职业一转支线与艾靈森林章节。
//
// 输入：references/tms273-data/quests.json —— TMS273.7 `Quest.wz/QuestData` 的
//       原始导出，逐条保留 Check / Act / Say / QuestInfo 与它们原有的节点形态。
// 输出：gameplay.quests 里此前 executable=false 的 55 条任务补上运行时规格
//       （等级、职业源列表与 subJobFlags、前置任务与 OR、起止 NPC、交付道具、
//       击杀目标、三态显示文本），并按源机制能否判定给出 executable 与 blockedBy。
//
// 边界：TMS273 的 q*.js 脚本体在本地源中不存在。startscript / endscript、
// infoex 计数器、自动开场与脚本发放的道具一律登记为边界，不伪造完成条件，
// 不把显示文本当成可执行规则（项目规则：未知即标注，不冒充原作）。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { display, decode } = require('./tms273_chapter.cjs');

const root = path.resolve(__dirname, '..');
const SOURCE = path.join(root, 'references/tms273-data/quests.json');
// 已核定的 `infoex` kill 目标。源 QuestData 的 `Check.1.infoNumber` 只写任务 id，
// 怪物模板在 `q*.js` 脚本体里（本地缺失），所以目标只能来自已经人工核过的来源
// 记录：references/tms273-data/maple-island-calamity-source.json 的
// `classification.kill`。没有记录的 infoex 一律保持 `script-counter` 边界，
// 不从显示文本猜、不执行不受限源码。
const CALAMITY_SOURCE = path.join(
  root,
  'references/tms273-data/maple-island-calamity-source.json',
);

// applyChapter / applyContinuation 已装配的 15 条。本适配器不得改动它们。
const IMPLEMENTED = [
  '36301', '36302', '36303', '36304', '36306', '36307',
  '1402', '36337', '36308', '36309', '36310', '36311', '36312', '36313', '36314',
];

// 其他职业的转职支线。项目只开放法师→冰雷路线，保留原始分支信息但不借机
// 开放其他职业玩法（BUSINESS_DEVELOPMENT：保留兼容语义，不开放其他职业）。
const OTHER_JOB_ROUTE = new Set(['1401', '1403', '1404', '1405', '2570', '2684']);
// 冒險家Remaster 的内部物件控制任务：NPC 楓之谷GM 9010000，无等级与职业要求，
// 不是玩家剧情内容。
const DEV_QUESTS = new Set(['36335', '36336']);

function nodes(node) {
  return Object.values(node && typeof node === 'object' ? node : {});
}

function integer(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

// 源 job 是 TMS 职业码：0 初心者，100/200/300/400/500 为一转大类，x1x 二转，
// x2x 三转。运行时只认识 0/200/220/221/222，所以只把法師系映射到项目职业，
// 其余职业不借机开放。
function projectJobs(sourceJob) {
  if (!sourceJob.length) return [];
  if (sourceJob.includes(0)) return [0, 200, 220, 221, 222];
  return sourceJob.some(job => job >= 200 && job < 300) ? [200, 220, 221, 222] : [];
}

// 源 QuestData 的 Act 在 TMS273.7 里 70 条任务全部为空，奖励由脚本发放。
// 因此奖励不是原作事实，沿用项目 P 曲线并按等级分档，逐条标注来源。
function expFor(level) {
  return level > 0 ? level * 30 : 0;
}

function prerequisites(phase) {
  return nodes(phase.quest)
    .filter(entry => entry && entry.id !== undefined)
    .map(entry => ({
      questId: String(entry.id),
      // WZ state：1 進行中，2 完成。缺省按完成，与原实现一致。
      status: String(entry.state) === '1' ? 'active' : 'completed',
    }));
}

function itemRequirements(phase) {
  return nodes(phase.item)
    .filter(entry => entry && entry.id !== undefined)
    .map(entry => ({ itemId: String(entry.id), quantity: integer(entry.count, 0) }));
}

function mobRequirements(phase) {
  return nodes(phase.mob)
    .filter(entry => entry && entry.id !== undefined)
    .map(entry => ({ mobId: String(entry.id), count: integer(entry.count, 0) }));
}

function fieldEntries(phase) {
  return nodes(phase.fieldEnter).map(value => String(value));
}

// 已核定的 infoex kill 目标表：任务 id -> { mobId, count, name }。
// 只读来源记录，不在适配器里硬编码第二份。
let killTargetCache = null;
function verifiedKillTargets() {
  if (killTargetCache) return killTargetCache;
  const record = JSON.parse(fs.readFileSync(CALAMITY_SOURCE, 'utf8'));
  const targets = new Map();
  for (const quest of record.quests || []) {
    const kill = quest.classification && quest.classification.kill;
    if (!kill || !kill.mobId) continue;
    const monster = (record.monsters || {})[String(kill.mobId)];
    targets.set(String(quest.id), {
      mobId: String(kill.mobId),
      count: integer(kill.count, 1),
      name: monster && monster.name ? String(monster.name) : '',
    });
  }
  killTargetCache = targets;
  return targets;
}

// 源 `infoex` 的两个字符串子节点在任务之间取值相反：36315/36322/36328 是
// `exVariable:"kill"`，而 36319 是 `value:"kill"` / `exVariable:"1"`。Quest 数据只
// 存在于 `Quest.wz`（本地 unpack_tms273_ms 只解析 .ms 归档），无法从二进制判定
// 哪个子节点才是变量名，所以不按字段名猜它是哪一种计数器。这里只回答"原始节点
// 里出现了 kill 字样"，是否真的按击杀执行由已核定来源记录决定（见
// `verifiedKillTargets`）。
function infoexMentionsKill(infoex) {
  return infoex.some(
    entry => entry.exVariable === 'kill' || entry.value === 'kill',
  );
}

function applyRemaster(gameplay, items, manifest, questText) {
  const source = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
  const assembled = new Set(manifest.mapCatalog.maps.map(map => String(map.id)));
  const placed = new Set(
    gameplay.npcSpawns
      .filter(spawn => assembled.has(String(spawn.mapId)))
      .map(spawn => String(spawn.templateId)),
  );
  const templates = new Set(gameplay.npcs.map(npc => String(npc.templateId)));
  // 运行时可击杀的怪物模板 = 已被刷怪记录放在某张已装配地图上的模板。击杀目标
  // 必须落在这里，否则玩家接得到任务也打不到东西。
  const huntable = new Set(
    gameplay.spawns
      .filter(spawn => assembled.has(String(spawn.mapId)))
      .map(spawn => String(spawn.templateId)),
  );
  const killTargets = verifiedKillTargets();

  const remaining = source.quests.filter(quest => !IMPLEMENTED.includes(String(quest.id)));
  assert.equal(remaining.length, 55, '后续章节源任务数量发生变化，需重新盘点');

  let executable = 0;
  const blocked = {};

  for (const raw of remaining) {
    const id = String(raw.id);
    const target = gameplay.quests.find(quest => String(quest.questId) === id);
    assert(target, `Missing runtime quest ${id}`);
    assert(!target.executable, `Quest ${id} is already executable; refusing to overwrite`);

    // 源节点带 `_dirType` 外壳，先按 tms273_chapter.cjs 的同一规则解码。
    const checkSource = decode(raw.Check) || {};
    const text = decode(raw.QuestInfo) || {};
    const check = { start: checkSource['0'] || {}, complete: checkSource['1'] || {} };
    const startNpc = check.start.npc === undefined ? '' : String(check.start.npc);
    const completeNpc = String(check.complete.npc ?? startNpc);
    const sourceJob = nodes(check.start.job).map(value => integer(value));
    const jobs = projectJobs(sourceJob);
    const items0 = itemRequirements(check.start);
    const items1 = itemRequirements(check.complete);
    const mobs = mobRequirements(check.complete);
    const fields = fieldEntries(check.start);
    const infoex = nodes(check.complete.infoex).map(entry => ({
      value: String(entry.value ?? ''),
      exVariable: String(entry.exVariable ?? ''),
    }));
    const orOption = integer(check.start.QuestOrOption, 0) === 1;
    const level = integer(check.start.lvmin, 0);
    // 源 QuestInfo/selfStart | selfComplete：这一阶段没有 NPC，入口是任务视窗。
    const selfStart = integer(text.selfStart, 0) === 1;
    const selfComplete = integer(text.selfComplete, 0) === 1;

    // 击杀目标：源 Check.1.mob[] 本身就带模板与数量；infoex 只有"已核定来源
    // 记录说它是击杀计数器、且原始节点确实写着 kill"时才转成运行时目标。两者
    // 都保留来源字段（sourceMobRequirements / sourceInfoex）供追溯。
    const killObjectiveSources = mobs
      .filter(mob => mob.count > 0 && mob.mobId)
      .map(mob => ({ mobId: mob.mobId, required: mob.count, name: '' }));
    const verified = infoexMentionsKill(infoex) ? killTargets.get(id) : undefined;
    const infoexKill = Boolean(verified);
    if (verified) {
      killObjectiveSources.push({
        mobId: verified.mobId,
        required: verified.count,
        name: verified.name,
      });
    }
    const killObjectives = killObjectiveSources.map(target => ({
      kind: 'kill',
      mobId: target.mobId,
      required: target.required,
      // 没有已核定的显示名就留空，由服务端回落到源 QuestInfo 的活动文本，
      // 不在这里发明怪物名。
      text: target.name,
    }));
    // 自助阶段只有在任务真的有事可做（至少一个可判定的目标）时才算有入口：
    // 完全没有目标的自助阶段是纯脚本场景，本任务不执行。
    const hasExecutableObjective = killObjectives.length > 0 || items1.length > 0;
    const selfService = hasExecutableObjective;

    // 阻塞原因按源机制逐条登记；可执行要求一条都不命中。
    const blockedBy = [];
    if (DEV_QUESTS.has(id)) blockedBy.push('dev-quest');
    if (OTHER_JOB_ROUTE.has(id)) blockedBy.push('other-job-route');
    // 源 Check/0 不写 job 节点 = 原版不限职业（如艾靈森林章节），运行时
    // conditions.job 空列表即"不限"（quest_rules.rs jobs_match：空列表放行）。
    // 只有源写了职业列表且一个都映射不到项目职业时才算路线未映射。
    if (sourceJob.length && !jobs.length) blockedBy.push('job-route-unmapped');
    const npcIds = [startNpc, completeNpc].filter(Boolean);
    if (npcIds.length && npcIds.every(npcId => !templates.has(npcId))) blockedBy.push('missing-region');
    // 没有源 NPC 的阶段：源标了自助且任务有可判定目标时由任务视窗承接，
    // 否则它是脚本场景，本任务不执行。
    if (!startNpc) {
      if (!(selfStart && selfService)) blockedBy.push('script-scene');
    } else if (!placed.has(startNpc)) {
      blockedBy.push('missing-start-npc');
    }
    if (!completeNpc) {
      if (!(selfComplete && selfService)) blockedBy.push('script-scene');
    } else if (!placed.has(completeNpc)) {
      blockedBy.push('missing-complete-npc');
    }
    // infoex 计数器：已核定的 kill 由击杀进度执行，其余仍是边界。
    if (infoex.length && !infoexKill) blockedBy.push('script-counter');
    // 击杀目标必须在装配世界里真的刷得出来。
    if (killObjectives.some(objective => !huntable.has(objective.mobId))) {
      blockedBy.push('kill-target-missing');
    }
    if (items1.length) blockedBy.push('script-item-source');
    if (fields.some(mapId => !assembled.has(mapId))) blockedBy.push('missing-map');

    const summary = display(text['0']);
    const summaries = {
      available: summary,
      active: display(text['1'] || text['0']),
      completed: display(text['2']),
    };
    const prereqStart = prerequisites(check.start);
    const prereqComplete = prerequisites(check.complete);
    const orStart = orOption && prereqStart.length > 0;
    const orComplete = orOption && prereqComplete.length > 0;
    const isExecutable = blockedBy.length === 0;
    // 完成阶段若把 OR 作用在空前置上会恒为假（既有语义），只有该阶段真的
    // 写了前置任务时才带 questOrOption。
    Object.assign(target, {
      executable: isExecutable,
      name: raw.name || target.name,
      summary,
      summaries,
      start: {
        npcId: startNpc,
        conditions: {
          levelAtLeast: level,
          job: jobs,
          quests: prereqStart,
          items: items0,
          equippedItems: [],
          ...(orStart ? { questOrOption: true } : {}),
        },
        consumeItems: false,
      },
      complete: {
        npcId: completeNpc,
        conditions: {
          levelAtLeast: level,
          job: jobs,
          quests: prereqComplete,
          items: items1,
          equippedItems: [],
          ...(orComplete ? { questOrOption: true } : {}),
        },
        consumeItems: items1.length > 0,
      },
      // 源 Act 为空，奖励不是原作事实：转职支线与内部任务不发经验，
      // 其余沿用项目 P 分档（等级 ×30），不发金币不发物品。
      reward: { mesos: 0, exp: DEV_QUESTS.has(id) || OTHER_JOB_ROUTE.has(id) ? 0 : expFor(level), items: [] },
      startItems: [],
      // 自助阶段的运行时开关：只有源标了自助、且任务真有可判定目标时才打开，
      // 否则服务端会拒绝任务视窗入口。
      selfStart: selfStart && selfService,
      selfComplete: selfComplete && selfService,
      objectives: [
        ...killObjectives,
        ...items1.map(requirement => ({
          kind: 'collect',
          itemId: requirement.itemId,
          required: requirement.quantity,
          text: items[requirement.itemId]?.name || requirement.itemId,
        })),
      ],
      // T：源 Check.1.mob 的击杀要求。运行时尚无击杀进度，故只登记不判定。
      sourceMobRequirements: mobs,
      sourceJob,
      sourceSubJobFlags: integer(check.start.subJobFlags, 0),
      sourceInfoNumber: check.complete.infoNumber === undefined ? null : String(check.complete.infoNumber),
      sourceInfoex: infoex,
      sourceFieldEnter: fields,
      sourceScripts: {
        start: check.start.startscript ? String(check.start.startscript) : null,
        end: check.complete.endscript ? String(check.complete.endscript) : null,
      },
      source: raw.source,
      sourceJson: raw.sourceJson,
      ruleVersion: 'tms273-remaster-p1',
      rewardSource: 'P: TMS273 QuestData Act is empty for all 70 quests; no reward is claimed as original.',
      executionEvidence: 'T: QuestData Check/QuestInfo — 等级、职业源列表与 subJobFlags、前置（含 QuestOrOption OR）、起止 NPC、交付道具与击杀目标均取自 TMS273.7。P/U: q*.js 脚本体缺失，脚本计数器、自动开场与脚本发放道具按边界登记，未伪造完成条件。',
      blockedBy,
      blockedReason: isExecutable ? null : blockedBy.join(','),
    });

    if (questText.quests[id]) questText.quests[id].log = { zh: summary };
    if (isExecutable) executable += 1;
    else for (const reason of blockedBy) blocked[reason] = (blocked[reason] || 0) + 1;
  }

  // 可达性重算（87 图当前数据）。"可执行"只说明规格能跑；"正常可达"要求整条
  // 前置链自己也是可执行且可达——GM 直达和"已导出素材"都不算可玩证据。前置里
  // 标 active（进行中）的条目不是入场门槛，不参与判定；标 completed 的必须
  // 逐级成立，OR 阶段（QuestOrOption）任一成立即可。
  const specById = new Map(gameplay.quests.map(quest => [String(quest.questId), quest]));
  const reachable = new Map(
    gameplay.quests.map(quest => [String(quest.questId), Boolean(quest.executable)]),
  );
  const phaseReachable = (spec, phase) => {
    const prerequisites = (phase.conditions.quests || []).filter(
      entry => (entry.status ?? 'completed') === 'completed',
    );
    if (prerequisites.length === 0) return true;
    const satisfied = entry => reachable.get(String(entry.questId)) === true;
    return phase.conditions.questOrOption
      ? prerequisites.some(satisfied)
      : prerequisites.every(satisfied);
  };
  for (let pass = 0; pass < gameplay.quests.length + 1; pass += 1) {
    let changed = false;
    for (const [questId, isReachable] of reachable) {
      if (!isReachable) continue;
      const spec = specById.get(questId);
      if (phaseReachable(spec, spec.start) && phaseReachable(spec, spec.complete)) continue;
      reachable.set(questId, false);
      changed = true;
    }
    if (!changed) break;
  }

  const reachability = gameplay.quests.map(spec => {
    const questId = String(spec.questId);
    return {
      questId,
      specExecutable: Boolean(spec.executable),
      normallyReachable: reachable.get(questId) === true,
      blockedBy: spec.blockedBy || [],
    };
  });
  for (const spec of gameplay.quests) {
    if (spec.ruleVersion !== 'tms273-remaster-p1') continue;
    spec.reachable = reachable.get(String(spec.questId)) === true;
  }
  const unreachableReasons = {};
  for (const entry of reachability) {
    if (entry.specExecutable && !entry.normallyReachable) {
      const reason = entry.blockedBy.length ? entry.blockedBy.join(',') : 'prerequisite-unreachable';
      unreachableReasons[reason] = (unreachableReasons[reason] || 0) + 1;
    }
  }

  gameplay.compatibility.adventurerRemaster = {
    ruleVersion: 'tms273-remaster-p1',
    sourceQuests: remaining.map(quest => String(quest.id)),
    sourceRecord: 'references/tms273-data/quests.json',
    executableQuests: gameplay.quests.filter(quest => quest.ruleVersion === 'tms273-remaster-p1' && quest.executable).map(quest => quest.questId),
    blockedCounts: blocked,
    // 可达性台账：规格可执行 / 正常起点可达 / 当前阻塞逐条列出，供 87 图重算
    // 与审计对账。questReachability 覆盖全部目录任务，不只本章节。
    reachableQuests: reachability.filter(entry => entry.normallyReachable).map(entry => entry.questId),
    specExecutableButBlocked: reachability.filter(entry => entry.specExecutable && !entry.normallyReachable).map(entry => entry.questId),
    unreachableReasons,
    questReachability: reachability,
    temporaryRules: 'P: 源 Act 全空，奖励按等级×30 分档且转职支线/内部任务为 0；源 job 只映射法師系到 200/220/221/222，其他职业保留数据不开放；已核定的 infoex kill 目标（36315/36319/36322，见 maple-island-calamity-source.json）转成类型化击杀进度，其余 infoex 仍是边界；源标 selfStart/selfComplete 且任务有可判定目标时，任务视窗是这一阶段的入口。',
    unknown: 'q36315–q36334 与 q36341–q36367、q1401/q1403/q1404/q1405/q2570/q2684 的可执行脚本体在本地源中不存在：开场/交付场景、dummy/talk/lord/dir3 等非击杀计数器、脚本发放道具都按边界登记，未执行。源 infoex 的两个字符串子节点在任务间取值相反（36315/36322/36328 为 exVariable="kill"，36319 为 value="kill"），Quest 数据只在 Quest.wz 里、本地解包器仅支持 .ms 归档，故无法判定哪个子节点是变量名：适配器不按字段名判定，只认已核定来源记录并校验原始节点出现 kill 字样。艾靈森林（area 39）地图与 NPC 均未装配，相关 27 条任务只有源数据，没有可达入口；36315/36319/36322 的击杀目标（8645261/8645264/8645262）尚未放进装配世界，故仍不可达。',
  };

  exposeScriptedGateRoutes(manifest);
  return { total: remaining.length, executable, blocked };
}

// 已交付的 P 级脚本门必须把同一目标暴露给客户端，否则服务端的 P 路由是死代码。
//
// `client/src/scenes/world.ts::tryPortal` 只对带 `targetMapId` 的门受理 ↑ 键
// （第 145 行的过滤条件），而 TMS273 脚本门的源 `tm` 一律是 `999999999``
// （无静态目标）⇒ 目录里没有目标时玩家按 ↑ 根本发不出请求，`ellinel.rs` /
// `helios.rs` 里已经写好的路由永远收不到消息。本表只把服务端钩子**已经按同一
// 目标处置**的路线写进目录，让玩家能发出这个请求；真正的传送仍由服务端钩子在
// `portals.rs::handle_portal` 查表之前裁决，客户端不决定落点。
//
// T（源证据，`Map/Map/Graph.json` 逐图给出脚本门的授权目标）：
//   * `222020400` 第 2 扇门（脚本 `move_elin`，時間監控室的時間門）→ `300000100`
//     艾靈森林小森林；小森林 `out00` 的静态回门 `tm/tn` 正是
//     `222020400/in01`，两端互为源内配对。缺这一条则 36341-36367 整章
//     没有可达入口（21 图装配完成但走不进去）。
//   * `222020200` 第 5 扇门（脚本 `LudiElevator_in`）→ `222020100`；
//     `222020100` 第 4 扇门（同一脚本）→ `222020200`。赫爾奧斯塔电梯两端。
// P（有界适配）：落点沿用服务端钩子声明的目标门（`ellinel.rs` 的 `in00`、
// `helios.rs` 的 `st00`/`st01`）。原版电梯按班次运行、时间门由 `q36342s` 把
// 关；本路由不做时刻与任务状态校验，即到即走，与 `inERShip`、时间门既有口径
// 一致。只在目标图已装配时生效——没装配的目标保持「走近提示一次」。
function exposeScriptedGateRoutes(manifest) {
  const assembled = new Set(manifest.mapCatalog.maps.map(map => String(map.id)));
  for (const [mapId, portalName, targetMapId, targetPortalName] of [
    ['222020400', 'in01', '300000100', 'in00'],
    ['222020200', 'in00', '222020100', 'st00'],
    ['222020100', 'in00', '222020200', 'st01'],
  ]) {
    if (!assembled.has(targetMapId)) continue;
    const portal = manifest.mapCatalog.maps
      .find(map => String(map.id) === mapId)?.portals.find(candidate => candidate.name === portalName);
    assert(portal, `Missing source scripted portal ${mapId}/${portalName}`);
    assert.equal(portal.targetMapId, null, `${mapId}/${portalName} already carries a static target`);
    Object.assign(portal, { targetMapId, targetPortalName });
  }
}

module.exports = { applyRemaster, verifiedKillTargets, infoexMentionsKill };

if (require.main === module) {
  const gameplay = JSON.parse(fs.readFileSync(path.join(root, 'shared/gameplay.json'), 'utf8'));
  const items = JSON.parse(fs.readFileSync(path.join(root, 'shared/items.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'client/public-tms273/assets/manifest.json'), 'utf8'));
  const questText = JSON.parse(fs.readFileSync(path.join(root, 'shared/quest-text.json'), 'utf8'));
  console.log(JSON.stringify(applyRemaster(gameplay, items, manifest, questText), null, 2));
}
