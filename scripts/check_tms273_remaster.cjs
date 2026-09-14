// 后续章节复刻的 T 字段不变式：shared/gameplay.json 里的 55 条后续章节任务
// 必须与 TMS273.7 `Quest.wz/QuestData` 源逐字段一致；不可执行的必须写明原因。
// 只做只读核对，不改任何产物。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { display, decode } = require('./tms273_chapter.cjs');
const remasterModule = require('./tms273_remaster.cjs');

const root = path.resolve(__dirname, '..');
const gameplay = JSON.parse(fs.readFileSync(path.join(root, 'shared/gameplay.json'), 'utf8'));
const source = JSON.parse(fs.readFileSync(path.join(root, 'references/tms273-data/quests.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'client/public-tms273/assets/manifest.json'), 'utf8'));
// 已核定的 infoex kill 目标表与适配器共用同一份读取逻辑。
const verifiedKillTargets = remasterModule.verifiedKillTargets();
// 运行时可击杀的模板 = 已被刷怪记录放在某张已装配地图上的模板。口径与适配器
// 一致：只有真的刷得出来才算击杀目标可达，否则玩家接得到却打不到。
const assembled = new Set(manifest.mapCatalog.maps.map(map => String(map.id)));
const huntable = new Set(
  gameplay.spawns
    .filter(spawn => assembled.has(String(spawn.mapId)))
    .map(spawn => String(spawn.templateId)),
);

const IMPLEMENTED = new Set([
  '36301', '36302', '36303', '36304', '36306', '36307',
  '1402', '36337', '36308', '36309', '36310', '36311', '36312', '36313', '36314',
]);

const nodes = node => Object.values(node && typeof node === 'object' ? node : {});
const integer = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
};

const remaster = gameplay.quests.filter(quest => quest.ruleVersion === 'tms273-remaster-p1');
assert.equal(remaster.length, 55, '后续章节任务数应为 55');
assert.equal(remaster.filter(quest => IMPLEMENTED.has(quest.questId)).length, 0, '不得覆盖已装配任务');

let checked = 0;
for (const quest of remaster) {
  const raw = source.quests.find(entry => String(entry.id) === String(quest.questId));
  assert(raw, `Missing source quest ${quest.questId}`);
  const check = decode(raw.Check) || {};
  const text = decode(raw.QuestInfo) || {};
  const c0 = check['0'] || {};
  const c1 = check['1'] || {};
  const startNpc = c0.npc === undefined ? '' : String(c0.npc);
  const completeNpc = String(c1.npc ?? startNpc);
  const sourceJob = nodes(c0.job).map(value => integer(value));
  const orOption = integer(c0.QuestOrOption, 0) === 1;

  assert.equal(quest.source, raw.source, `${quest.questId} source path`);
  assert.equal(quest.summary, display(text['0']), `${quest.questId} summary`);
  assert.equal(quest.summaries.active, display(text['1'] || text['0']), `${quest.questId} active text`);
  assert.equal(quest.summaries.completed, display(text['2']), `${quest.questId} completed text`);
  assert.equal(quest.start.npcId, startNpc, `${quest.questId} start npc`);
  assert.equal(quest.complete.npcId, completeNpc, `${quest.questId} complete npc`);
  assert.equal(quest.start.conditions.levelAtLeast, integer(c0.lvmin, 0), `${quest.questId} lvmin`);
  assert.deepEqual(quest.sourceJob, sourceJob, `${quest.questId} sourceJob`);
  assert.equal(quest.sourceSubJobFlags, integer(c0.subJobFlags, 0), `${quest.questId} subJobFlags`);

  const prereq = phase => nodes(phase.quest)
    .filter(entry => entry && entry.id !== undefined)
    .map(entry => ({ questId: String(entry.id), status: String(entry.state) === '1' ? 'active' : 'completed' }));
  assert.deepEqual(quest.start.conditions.quests, prereq(c0), `${quest.questId} start prerequisites`);
  assert.deepEqual(quest.complete.conditions.quests, prereq(c1), `${quest.questId} complete prerequisites`);
  // OR 只在该阶段真的写了前置时才带，否则空前置在 OR 语义下恒为假。
  assert.equal(quest.start.conditions.questOrOption ?? false, orOption && prereq(c0).length > 0, `${quest.questId} start OR`);
  assert.equal(quest.complete.conditions.questOrOption ?? false, orOption && prereq(c1).length > 0, `${quest.questId} complete OR`);

  const items = phase => nodes(phase.item)
    .filter(entry => entry && entry.id !== undefined)
    .map(entry => ({ itemId: String(entry.id), quantity: integer(entry.count, 0) }));
  assert.deepEqual(quest.complete.conditions.items, items(c1), `${quest.questId} turn-in items`);
  assert.equal(quest.complete.consumeItems, items(c1).length > 0, `${quest.questId} consumeItems`);

  const mobs = nodes(c1.mob)
    .filter(entry => entry && entry.id !== undefined)
    .map(entry => ({ mobId: String(entry.id), count: integer(entry.count, 0) }));
  assert.deepEqual(quest.sourceMobRequirements, mobs, `${quest.questId} mob requirements`);

  const sourceInfoex = nodes(c1.infoex).map(entry => ({
    value: String(entry.value ?? ''), exVariable: String(entry.exVariable ?? ''),
  }));
  assert.deepEqual(quest.sourceInfoex, sourceInfoex, `${quest.questId} infoex`);
  assert.equal(quest.sourceScripts.start, c0.startscript ? String(c0.startscript) : null, `${quest.questId} start script`);
  assert.equal(quest.sourceScripts.end, c1.endscript ? String(c1.endscript) : null, `${quest.questId} end script`);
  assert.deepEqual(quest.sourceFieldEnter, nodes(c0.fieldEnter).map(String), `${quest.questId} fieldEnter`);

  // 自助开关必须逐条对齐源 QuestInfo，且只在任务真有可判定目标时打开：完全
  // 没有目标的自助阶段是纯脚本场景，本项目不执行，不能凭一个标记就放行。
  const hasObjective = quest.objectives.length > 0;
  assert.equal(
    quest.selfStart ?? false,
    integer(text.selfStart, 0) === 1 && hasObjective,
    `${quest.questId} selfStart`,
  );
  assert.equal(
    quest.selfComplete ?? false,
    integer(text.selfComplete, 0) === 1 && hasObjective,
    `${quest.questId} selfComplete`,
  );

  // 击杀目标逐条对齐来源：源 Check.1.mob[] 全量转成 kill 目标；infoex 只在
  // "已核定来源记录 + 原始节点出现 kill 字样" 时才追加（判定与适配器共用同一
  // 份实现，避免两处规则漂移）。
  const infoexKill = remasterModule.infoexMentionsKill(sourceInfoex);
  const verified = infoexKill ? verifiedKillTargets.get(String(quest.questId)) : undefined;
  const expectedKills = mobs
    .filter(mob => mob.count > 0 && mob.mobId)
    .map(mob => ({ mobId: mob.mobId, required: mob.count }));
  if (verified) expectedKills.push({ mobId: verified.mobId, required: verified.count });
  assert.deepEqual(
    quest.objectives
      .filter(objective => objective.kind === 'kill')
      .map(objective => ({ mobId: objective.mobId, required: objective.required })),
    expectedKills,
    `${quest.questId} kill objectives`,
  );

  // 可执行性分类必须与源机制自洽：可执行的不允许带任何**未执行**的边界，
  // 不可执行必须写明原因。
  if (quest.executable) {
    assert.deepEqual(quest.blockedBy, [], `${quest.questId} must have no block reason`);
    assert.equal(quest.blockedReason, null, `${quest.questId} blockedReason`);
    // 空 job 列表 = 源 Check/0 没写 job 节点（原版不限职业，如艾靈森林章节），
    // 服务端 quest_rules.rs 的 jobs_match 对空列表放行；源写了职业列表的可执行
    // 任务必须映射到项目法师路线，不允许借机开放其他职业。
    assert(
      sourceJob.length === 0 || quest.start.conditions.job.length > 0,
      `${quest.questId} must restrict the job route when the source names jobs`,
    );
    assert.equal(quest.complete.conditions.items.length, 0, `${quest.questId} must not need script-granted items`);
    // 没有 infoex 才和计数器无关；一旦带上 infoex，它必须是已核定的击杀计数，
    // 否则这条任务的完成条件依赖一个本任务没有执行的脚本计数器。
    assert(
      sourceInfoex.length === 0 || Boolean(verified),
      `${quest.questId} executable with an unexecuted script counter`,
    );
    // 击杀目标必须真的刷得出来（与适配器同一口径：只算已装配地图上的刷怪），
    // 否则玩家接得到却打不到。
    for (const objective of quest.objectives) {
      if (objective.kind !== 'kill') continue;
      assert(huntable.has(objective.mobId), `${quest.questId} kill target ${objective.mobId} is not placed`);
    }
  } else {
    assert(quest.blockedBy.length > 0, `${quest.questId} must record a block reason`);
  }
  // 运行时职业只允许项目已有的法师路线，不能凭源数据开放其他职业。
  for (const job of quest.start.conditions.job) assert([0, 200, 220, 221, 222].includes(job), `${quest.questId} unexpected runtime job ${job}`);
  checked += 1;
}

// 已装配的 15 条不得被后续章节适配器改动。
const implemented = gameplay.quests.filter(quest => IMPLEMENTED.has(String(quest.questId)));
assert.equal(implemented.length, 15);
for (const quest of implemented) {
  assert(quest.executable, `${quest.questId} must stay executable`);
  assert(quest.blockedBy === undefined, `${quest.questId} must not gain a block reason`);
  // tms273-mage8-p1：用户指定的法师 8 级一转例外（b93b430，P 级）。
  assert(
    ['tms273-opening-p1', 'tms273-continuation-p1', 'tms273-mage8-p1'].includes(quest.ruleVersion),
    `${quest.questId} ruleVersion`,
  );
}

// 源里 70 条必须全部在运行时有对应条目，且没有源外任务混入。
const runtimeIds = new Set(gameplay.quests.map(quest => String(quest.questId)));
for (const quest of source.quests) assert(runtimeIds.has(String(quest.id)), `Missing runtime quest ${quest.id}`);
assert.equal(gameplay.quests.length, source.quests.length);

console.log(JSON.stringify({
  remaster: remaster.length,
  checked,
  executable: remaster.filter(quest => quest.executable).map(quest => quest.questId),
  blocked: gameplay.compatibility.adventurerRemaster.blockedCounts,
  implementedUntouched: implemented.length,
}, null, 2));
