// 后续章节复刻的 T 字段不变式：shared/gameplay.json 里的 55 条后续章节任务
// 必须与 TMS273.7 `Quest.wz/QuestData` 源逐字段一致；不可执行的必须写明原因。
// 只做只读核对，不改任何产物。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { display, decode } = require('./tms273_chapter.cjs');

const root = path.resolve(__dirname, '..');
const gameplay = JSON.parse(fs.readFileSync(path.join(root, 'shared/gameplay.json'), 'utf8'));
const source = JSON.parse(fs.readFileSync(path.join(root, 'references/tms273-data/quests.json'), 'utf8'));

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

  assert.deepEqual(quest.sourceInfoex, nodes(c1.infoex).map(entry => ({
    value: String(entry.value ?? ''), exVariable: String(entry.exVariable ?? ''),
  })), `${quest.questId} infoex`);
  assert.equal(quest.sourceScripts.start, c0.startscript ? String(c0.startscript) : null, `${quest.questId} start script`);
  assert.equal(quest.sourceScripts.end, c1.endscript ? String(c1.endscript) : null, `${quest.questId} end script`);
  assert.deepEqual(quest.sourceFieldEnter, nodes(c0.fieldEnter).map(String), `${quest.questId} fieldEnter`);

  // 可执行性分类必须与源机制自洽：可执行的不允许带任何边界，不可执行必须写明。
  if (quest.executable) {
    assert.deepEqual(quest.blockedBy, [], `${quest.questId} must have no block reason`);
    assert.equal(quest.blockedReason, null, `${quest.questId} blockedReason`);
    assert(quest.start.conditions.job.length > 0, `${quest.questId} must restrict the job route`);
    assert.equal(quest.sourceMobRequirements.length, 0, `${quest.questId} must not need kill progress`);
    assert.equal(quest.sourceInfoex.length, 0, `${quest.questId} must not need a script counter`);
    assert.equal(quest.complete.conditions.items.length, 0, `${quest.questId} must not need script-granted items`);
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
  assert(['tms273-opening-p1', 'tms273-continuation-p1'].includes(quest.ruleVersion), `${quest.questId} ruleVersion`);
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
