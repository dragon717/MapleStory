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

function applyRemaster(gameplay, items, manifest, questText) {
  const source = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
  const assembled = new Set(manifest.mapCatalog.maps.map(map => String(map.id)));
  const placed = new Set(
    gameplay.npcSpawns
      .filter(spawn => assembled.has(String(spawn.mapId)))
      .map(spawn => String(spawn.templateId)),
  );
  const templates = new Set(gameplay.npcs.map(npc => String(npc.templateId)));

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

    // 阻塞原因按源机制逐条登记；可执行要求一条都不命中。
    const blockedBy = [];
    if (DEV_QUESTS.has(id)) blockedBy.push('dev-quest');
    if (OTHER_JOB_ROUTE.has(id)) blockedBy.push('other-job-route');
    if (!jobs.length) blockedBy.push('job-route-unmapped');
    const npcIds = [startNpc, completeNpc].filter(Boolean);
    if (npcIds.length && npcIds.every(npcId => !templates.has(npcId))) blockedBy.push('missing-region');
    if (!startNpc || !placed.has(startNpc)) blockedBy.push('missing-start-npc');
    if (!completeNpc || !placed.has(completeNpc)) blockedBy.push('missing-complete-npc');
    if (infoex.length) blockedBy.push('script-counter');
    if (mobs.length) blockedBy.push('mob-progress');
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
      objectives: items1.map(requirement => ({
        kind: 'collect',
        itemId: requirement.itemId,
        required: requirement.quantity,
        text: items[requirement.itemId]?.name || requirement.itemId,
      })),
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

  gameplay.compatibility.adventurerRemaster = {
    ruleVersion: 'tms273-remaster-p1',
    sourceQuests: remaining.map(quest => String(quest.id)),
    sourceRecord: 'references/tms273-data/quests.json',
    executableQuests: gameplay.quests.filter(quest => quest.ruleVersion === 'tms273-remaster-p1' && quest.executable).map(quest => quest.questId),
    blockedCounts: blocked,
    temporaryRules: 'P: 源 Act 全空，奖励按等级×30 分档且转职支线/内部任务为 0；源 job 只映射法師系到 200/220/221/222，其他职业保留数据不开放；击杀目标只登记不判定。',
    unknown: 'q36315–q36334、q36341–q36367 与 q1401/q1403/q1404/q1405/q2570/q2684 的可执行脚本体在本地源中不存在；自动开场、场景触发、infoex 计数器与奖励均为未恢复的原作行为。艾靈森林（area 39）地图与 NPC 均未装配，相关 27 条任务只有源数据，没有可达入口。',
  };

  return { total: remaining.length, executable, blocked };
}

module.exports = { applyRemaster };

if (require.main === module) {
  const gameplay = JSON.parse(fs.readFileSync(path.join(root, 'shared/gameplay.json'), 'utf8'));
  const items = JSON.parse(fs.readFileSync(path.join(root, 'shared/items.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'client/public-tms273/assets/manifest.json'), 'utf8'));
  const questText = JSON.parse(fs.readFileSync(path.join(root, 'shared/quest-text.json'), 'utf8'));
  console.log(JSON.stringify(applyRemaster(gameplay, items, manifest, questText), null, 2));
}
