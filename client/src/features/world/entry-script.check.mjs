import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Same pattern as the other client checks: transpile the module (it has no
// imports of its own, so nothing has to be stripped) and exercise the pure
// predicate.  Then assert it against the REAL assembled catalog, so the check
// also guards the producer side (`scripts/export_tms273.cjs`): if the exporter
// ever stops emitting `entryScripts`, or the source tree's `onUserEnter`
// changes, this goes red instead of the warning silently disappearing again.
const source = await readFile(new URL('./entry-script.ts', import.meta.url), 'utf8');
const outputText = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^import .*;\r?\n/gm, '');
const { WARNING_MOB_LEVEL_SCRIPT, mapEntryWarning } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

const LEVELS = { '2230102': 55, '2230112': 55, '9999999': undefined };
const level = templateId => LEVELS[templateId];
const boars = [{ templateId: '2230102' }, { templateId: '2230112' }];

// 1. Only the authored script name can trigger anything.
assert.equal(mapEntryWarning({ scripts: { each: '' }, playerLevel: 38, monsters: boars, monsterLevel: level }), undefined, '未声明脚本的图不出提示');
assert.equal(mapEntryWarning({ scripts: { each: 'explorationPoint' }, playerLevel: 38, monsters: boars, monsterLevel: level }), undefined, '别的入口脚本不出本提示');
assert.equal(mapEntryWarning({ scripts: undefined, playerLevel: 38, monsters: boars, monsterLevel: level }), undefined, '旧清单（无 entryScripts）不出提示');
assert.equal(mapEntryWarning({ scripts: { first: WARNING_MOB_LEVEL_SCRIPT }, playerLevel: 38, monsters: boars, monsterLevel: level }), undefined, '只认 each（源把 warning_MobLevel 写在 onUserEnter）');

// 2. The warning only fires when the field really out-levels the player.
assert.deepEqual(
  mapEntryWarning({ scripts: { each: WARNING_MOB_LEVEL_SCRIPT }, playerLevel: 38, monsters: boars, monsterLevel: level }),
  { script: WARNING_MOB_LEVEL_SCRIPT, monsterLevel: 55, playerLevel: 38 },
  'Lv38 进 Lv55 图必须出提示',
);
assert.equal(mapEntryWarning({ scripts: { each: WARNING_MOB_LEVEL_SCRIPT }, playerLevel: 55, monsters: boars, monsterLevel: level }), undefined, '等级持平时不出提示');
assert.equal(mapEntryWarning({ scripts: { each: WARNING_MOB_LEVEL_SCRIPT }, playerLevel: 60, monsters: boars, monsterLevel: level }), undefined, '等级够时不出提示');

// 3. Missing data is never papered over with a default: an unknown template, an
//    empty snapshot or a snapshot without a player level all mean "stay quiet"
//    rather than "warn at level 0".
assert.equal(mapEntryWarning({ scripts: { each: WARNING_MOB_LEVEL_SCRIPT }, playerLevel: 38, monsters: [], monsterLevel: level }), undefined, '空快照不出提示');
assert.equal(mapEntryWarning({ scripts: { each: WARNING_MOB_LEVEL_SCRIPT }, playerLevel: 38, monsters: [{ templateId: '9999999' }], monsterLevel: level }), undefined, '查不到等级的模板不兜底成 0');
assert.equal(mapEntryWarning({ scripts: { each: WARNING_MOB_LEVEL_SCRIPT }, playerLevel: undefined, monsters: boars, monsterLevel: level }), undefined, '没有玩家等级就不猜');
assert.equal(mapEntryWarning({ scripts: { each: WARNING_MOB_LEVEL_SCRIPT }, playerLevel: Number.NaN, monsters: boars, monsterLevel: level }), undefined, '非有限等级不算数');

// 4. The strongest monster present wins, not the first or the last.
assert.equal(
  mapEntryWarning({ scripts: { each: WARNING_MOB_LEVEL_SCRIPT }, playerLevel: 38, monsters: [{ templateId: '2230102' }, { templateId: '2230102' }], monsterLevel: () => 55 })?.monsterLevel,
  55,
);

// --- real content -----------------------------------------------------------

const manifest = JSON.parse(await readFile(new URL('../../../public-tms273/assets/manifest.json', import.meta.url), 'utf8'));
const gameplay = JSON.parse(await readFile(new URL('../../../../shared/gameplay.json', import.meta.url), 'utf8'));
const catalog = manifest.mapCatalog.maps;

// 5. Every assembled map still carries the hooks; a missing field would make
//    the feature silently inert again, which is exactly the defect being fixed.
const missing = catalog.filter(entry => !entry.entryScripts);
assert.deepEqual(missing.map(entry => entry.id), [], '每张装配地图都必须带 entryScripts');

// 6. Exactly the two authored maps declare the warning.  Hard-coding the set
//    (rather than "the maps with high mobs") is deliberate: it is the source's
//    hand-placed list, and a change to it should be looked at by a human.
const declared = catalog.filter(entry => entry.entryScripts.each === WARNING_MOB_LEVEL_SCRIPT).map(entry => entry.id).sort();
assert.deepEqual(declared, ['102030000', '102040000'], '声明 warning_MobLevel 的图恰好是 Perion 片区那两张越级图');

// 7. The declared set is a STRICT SUBSET of the over-level set.  This is the
//    assertion that stops anyone from "simplifying" the trigger into a level
//    threshold: 59 maps reach Lv55+, but the source only warns on 2 of them,
//    so a threshold would invent 57 warnings the source never asked for.
const authoredLevel = new Map(gameplay.monsters.map(monster => [monster.templateId, monster.level]));
const maxLevelPerMap = new Map();
for (const spawn of gameplay.spawns) {
  const current = maxLevelPerMap.get(spawn.mapId) ?? 0;
  maxLevelPerMap.set(spawn.mapId, Math.max(current, authoredLevel.get(spawn.templateId) ?? 0));
}
const overLevel = new Set([...maxLevelPerMap].filter(([, max]) => max >= 55).map(([mapId]) => mapId));
assert.ok(overLevel.size > declared.length, `越级图 (${overLevel.size}) 应远多于声明警告的图 (${declared.length})`);
for (const mapId of declared) assert.ok(overLevel.has(mapId), `${mapId} 声明了警告，就该真的越级`);

// 8. End to end on the reported case: the boar field really does warn a Lv38
//    character and really does stay quiet for a Lv60 one.  Mob levels here come
//    from the same place the runtime reads them — `manifest.monsters[].info.level`
//    — not from `shared/gameplay.json`.
const monsterLevel = templateId => {
  const value = manifest.monsters?.[templateId]?.info?.level;
  if (typeof value === 'number') return value;
  return typeof value === 'string' && value.trim() !== '' ? Number(value) : undefined;
};
const fieldMonsters = gameplay.spawns.filter(spawn => spawn.mapId === '102030000').map(spawn => ({ templateId: spawn.templateId }));
const boarField = catalog.find(entry => entry.id === '102030000');
assert.equal(monsterLevel('2230102'), 55, '清单里 2230102 的等级就是源 info/level=55');
assert.deepEqual(
  mapEntryWarning({ scripts: boarField.entryScripts, playerLevel: 38, monsters: fieldMonsters, monsterLevel }),
  { script: WARNING_MOB_LEVEL_SCRIPT, monsterLevel: 55, playerLevel: 38 },
  'Lv38 走进黑肥肥領土必须被告知此地怪物到 Lv55',
);
assert.equal(
  mapEntryWarning({ scripts: boarField.entryScripts, playerLevel: 60, monsters: fieldMonsters, monsterLevel }),
  undefined,
  'Lv60（源为三转试炼设计的猎场等级）不该再被打扰',
);

console.log(`Map entry warning: ${catalog.length} maps carry entryScripts, ${declared.length} declare warning_MobLevel (${declared.join(', ')}), ${overLevel.size} maps out-level Lv55.`);
