import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { build } from 'esbuild';
const result = await build({ entryPoints: [fileURLToPath(new URL('./appearance.ts', import.meta.url))], bundle: true, write: false, format: 'esm' });
const { appearanceWeaponType, composeAppearance, initialEquipment, loadAppearanceLayer } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const catalog = JSON.parse(await fs.readFile(new URL('../../../public-tms273/assets/entry/appearance.json', import.meta.url), 'utf8'));
const creation = JSON.parse(await fs.readFile(new URL('../../../public-tms273/assets/entry/creation.json', import.meta.url), 'utf8'));
let count = 0;
for (const options of creation.genders) for (const hair of Object.values(options.hairColors).flat()) {
  const look = { gender: options.gender, skin: 0, face: options.face[0], hair, coat: options.coat[0], pants: 0, shoes: options.shoes[0], weapon: options.weapon[0] };
  const equipped = initialEquipment(look);
  const composed = composeAppearance(catalog, look, equipped);
  assert(composed.stand.length && composed.walk.length && composed.skill2201008.length);
  assert(composed.stand[0].parts.some(part => part.part === 'hair'));
  assert(composed.stand[0].parts.some(part => String(part.itemId) === String(look.coat)));
  const unequipped = composeAppearance(catalog, look, []);
  assert(!unequipped.stand[0].parts.some(part => String(part.itemId) === String(look.coat)));
  assert.equal(composeAppearance(catalog, { ...look, face: -1 }, equipped), undefined);
  count++;
}
console.log(`Appearance composition: ${count} gender/hair variants, equipment removal and legacy fallback passed.`);

// Regression for the lazy cash-weapon path: the same item has different
// authored hand anchors while walking, and its mage skill frame must remain
// present for the selected source branch. An unsupported branch must not
// borrow the stand frame to make the weapon appear.
const cashEntry = catalog.cashAppearance?.items['01702087'];
assert(cashEntry, 'cash appearance index lost the weapon fixture');
const cashLayer = JSON.parse(await fs.readFile(new URL(`../../../public-tms273${cashEntry.url}`, import.meta.url), 'utf8'));
await loadAppearanceLayer(catalog, '1702087', async url => {
  assert.equal(url, cashEntry.url);
  return { ok: true, status: 200, json: async () => cashLayer };
});
const male = creation.genders[0];
const weaponLook = { gender: male.gender, skin: 0, face: male.face[0], hair: male.hair[0], coat: male.coat[0], pants: 0, shoes: male.shoes[0], weapon: male.weapon[0] };
const weaponEquipment = [...initialEquipment(weaponLook), { itemId: '1702087', slot: 11 }];
const weaponType = appearanceWeaponType(catalog, weaponEquipment, weaponLook.weapon);
assert.equal(weaponType, '30', 'weapon context must come from the ordinary creation weapon');
const loadedItemIds = weaponEquipment.map(item => item.itemId);
const weaponAppearance = composeAppearance(catalog, weaponLook, weaponEquipment, { loadedItemIds, weaponType });
const cashPart = (action) => weaponAppearance?.[action]?.[0]?.parts.find(part => part.itemId === '01702087');
const standPart = cashPart('stand');
const walkPart = cashPart('walk');
const skillPart = cashPart('skill2201008');
assert(standPart && walkPart && skillPart, 'cash weapon disappeared from an authored action');
assert.notDeepEqual([standPart.x, standPart.y], [walkPart.x, walkPart.y], 'walk reused the stand hand anchor');
for (const part of [standPart, walkPart, skillPart]) {
  await fs.access(new URL(`../../../public-tms273${part.url}`, import.meta.url));
}
const unsupportedSkill = composeAppearance(catalog, weaponLook, weaponEquipment, { loadedItemIds, weaponType: '49' });
assert(!unsupportedSkill?.skill2201008?.[0]?.parts.some(part => part.itemId === '01702087'), 'missing skill frame fell back to stand');
console.log(`Lazy cash weapon composition: branch ${weaponType}, action-specific anchors, PNG paths and strict skill fallback passed.`);

// Ordinary equipment uses the same lazy appearance directory as cash items.
// These three ids were present in the persisted character but absent from the
// old eager catalogue, so composeAppearance silently omitted those gear layers.
const ordinaryLook = { gender: male.gender, skin: 0, face: 20000, hair: 30020, coat: male.coat[0], pants: 0, shoes: male.shoes[0], weapon: male.weapon[0] };
const ordinaryBase = initialEquipment(ordinaryLook).map((item, index) => ({ ...item, slot: [5, 7, 11][index] }));
const ordinarySlots = { '1212000': 11, '1040017': 5, '1002017': 1 };
for (const rawId of Object.keys(ordinarySlots)) {
  const key = rawId.padStart(8, '0');
  const entry = catalog.cashAppearance?.items[key];
  assert(entry && entry.cash === false && entry.lazy === true, `ordinary appearance index missing ${rawId}`);
  const layer = JSON.parse(await fs.readFile(new URL(`../../../public-tms273${entry.url}`, import.meta.url), 'utf8'));
  let requests = 0;
  await loadAppearanceLayer(catalog, rawId, async url => {
    requests++;
    assert.equal(url, entry.url);
    return { ok: true, status: 200, json: async () => layer };
  });
  await loadAppearanceLayer(catalog, rawId, async () => {
    requests++;
    throw new Error(`ordinary appearance ${rawId} was fetched twice`);
  });
  assert.equal(requests, 1, `ordinary appearance ${rawId} was not cached after loading`);
}
const wingEntry = catalog.cashAppearance?.items['01102273'];
assert(wingEntry?.cash === true && wingEntry.lazy === true, 'cash wing missing from shared appearance index');
const wingLayer = JSON.parse(await fs.readFile(new URL(`../../../public-tms273${wingEntry.url}`, import.meta.url), 'utf8'));
await loadAppearanceLayer(catalog, '1102273', async () => ({ ok: true, status: 200, json: async () => wingLayer }));
const completeEquipment = ordinaryBase
  .filter(item => item.slot !== 5 && item.slot !== 11)
  .concat(Object.entries(ordinarySlots).map(([itemId, slot]) => ({ itemId, slot })), { itemId: '1102273', slot: 9 });
const completeOptions = { loadedItemIds: completeEquipment.map(item => item.itemId), weaponType: appearanceWeaponType(catalog, completeEquipment, ordinaryLook.weapon) };
const complete = composeAppearance(catalog, ordinaryLook, completeEquipment, completeOptions);
for (const [rawId] of Object.entries(ordinarySlots)) {
  for (const action of ['stand', 'walk', 'skill2201008']) {
    const parts = complete?.[action]?.[0]?.parts ?? [];
    assert(parts.some(part => Number(part.itemId) === Number(rawId)), `${rawId} disappeared from ${action}`);
    assert(parts.length, `${rawId} has no ${action} parts`);
  }
}
assert(complete?.stand?.[0]?.parts.some(part => Number(part.itemId) === Number(wingEntry.itemId)), 'cash wing disappeared beside ordinary equipment');
for (const [rawId] of Object.entries(ordinarySlots)) {
  const without = completeEquipment.filter(item => Number(item.itemId) !== Number(rawId));
  const unequipped = composeAppearance(catalog, ordinaryLook, without, {
    loadedItemIds: without.map(item => item.itemId),
    weaponType: appearanceWeaponType(catalog, without, ordinaryLook.weapon),
  });
  assert(!unequipped?.stand?.[0]?.parts.some(part => Number(part.itemId) === Number(rawId)), `${rawId} survived unequip`);
}
console.log('Lazy ordinary equipment composition: 1212000/1040017/1002017 stand, walk, skill, cash wing and unequip passed.');

// A cash id is never used to infer the actor's ordinary weapon branch, while
// an indexed ordinary weapon still is. This prevents a cash branch from
// silently changing the character's authored hand pose.
assert.equal(appearanceWeaponType(catalog, [{ itemId: '01702087', slot: 11 }], '01702087'), undefined);
assert.equal(appearanceWeaponType(catalog, [{ itemId: '1212000', slot: -11 }], '1302000'), '21', 'ordinary 1212000 must select the source weapon branch');
const ordinaryWeaponEntry = Object.values(catalog.cashAppearance?.items ?? {}).find(entry => !entry.cash && entry.part === 'weapon' && entry.vslot && Number(entry.id) >= 1300000 && Number(entry.id) < 1600000);
assert(ordinaryWeaponEntry, 'ordinary weapon missing from shared lazy appearance index');
assert.equal(appearanceWeaponType(catalog, [{ itemId: ordinaryWeaponEntry.itemId, slot: 11 }], ordinaryWeaponEntry.itemId), String(Math.floor(ordinaryWeaponEntry.id / 10000) % 100));
console.log('Appearance weapon context: true cash excluded, ordinary indexed weapon retained.');

// A source-authored two-handed weapon can use stand2/walk2; the composed
// body must come from that same base variant instead of copying stand1/walk1.
const alternateEntry = catalog.cashAppearance?.items['01402009'];
assert(alternateEntry && alternateEntry.cash === false && alternateEntry.lazy === true, 'ordinary stand2 weapon missing from shared index');
const alternateLayer = JSON.parse(await fs.readFile(new URL(`../../../public-tms273${alternateEntry.url}`, import.meta.url), 'utf8'));
assert.equal(alternateLayer.standAction, 'stand2', '01402009 lost its source-authored stand2 marker');
await loadAppearanceLayer(catalog, alternateEntry.itemId, async () => ({ ok: true, status: 200, json: async () => alternateLayer }));
const alternateEquipment = [{ itemId: alternateEntry.itemId, slot: 11 }];
const alternate = composeAppearance(catalog, ordinaryLook, alternateEquipment, { loadedItemIds: alternateEquipment.map(item => item.itemId), weaponType: appearanceWeaponType(catalog, alternateEquipment, alternateEntry.itemId) });
assert(alternate?.stand?.[0]?.parts.some(part => Number(part.itemId) === Number(alternateEntry.itemId)));
assert.deepEqual(alternate?.stand?.[0]?.parts.find(part => part.part === 'body'), catalog.base[String(ordinaryLook.gender)].actions.stand2[0].parts.find(part => part.part === 'body'));
assert.deepEqual(alternate?.stand1?.[0]?.parts.find(part => part.part === 'body'), catalog.base[String(ordinaryLook.gender)].actions.stand[0].parts.find(part => part.part === 'body'), 'stand1 must retain source stand after stand2 replacement');
console.log(`Alternate ordinary weapon pose: ${alternateEntry.itemId} selects stand2 body.`);

// A layer may omit a source pose entirely.  Sitting/riding keeps that layer
// visible by translating its standing canvas between the authored base
// anchors; skills remain strict and do not borrow stand art.
const fallbackItemId = '09999999';
catalog.layers[fallbackItemId] = {
  id: Number(fallbackItemId), itemId: fallbackItemId, part: 'cap', islot: 'Cp', vslot: '',
  actions: {
    stand: [{ delay: 500, parts: [{
      key: 'fallback-cap', url: '/assets/tms273/fallback-cap.png', x: 10, y: 20,
      origin: { x: 0, y: 0 }, z: 100, part: 'cap', zName: 'cap', itemId: fallbackItemId, anchor: 'brow',
    }] }],
  },
};
const fallbackLook = { ...ordinaryLook, weapon: 1302000 };
const fallback = composeAppearance(catalog, fallbackLook, [{ itemId: fallbackItemId }]);
const fallbackSit = fallback?.sit?.[0]?.parts.find(part => part.itemId === fallbackItemId);
const fallbackStand = fallback?.stand?.[0]?.parts.find(part => part.itemId === fallbackItemId);
assert(fallbackSit && fallbackStand, 'missing sit layer must retain its standing canvas');
assert.deepEqual([fallbackSit.x, fallbackSit.y], [fallbackStand.x + 3, fallbackStand.y + 4], 'sit fallback did not use brow anchor delta');
assert(!fallback?.skill2201008?.[0]?.parts.some(part => part.itemId === fallbackItemId), 'skill unexpectedly borrowed stand fallback');
delete catalog.layers[fallbackItemId];
console.log('Missing sit layer: standing fallback translated by authored brow anchors; skill fallback remains strict.');

// Persisted starter looks predate today's MakeCharInfo choices. They must
// remain composable, including trial cash layers, after a full resource export.
const starterLook = { gender: 0, face: 20000, hair: 30020, skin: 0, coat: 1040002, pants: 1060003, shoes: 1070000, weapon: 1302000 };
const starterGear = initialEquipment(starterLook);
const starter = composeAppearance(catalog, starterLook, starterGear);
assert(starter?.stand[0].parts.some(part => part.part === 'face'), 'persisted starter face disappeared from the appearance catalogue');
const starterTrialGear = [...starterGear, { itemId: '01702087' }];
const starterTrial = composeAppearance(catalog, starterLook, starterTrialGear, {
  loadedItemIds: starterTrialGear.map(item => item.itemId),
  weaponType: appearanceWeaponType(catalog, starterTrialGear, starterLook.weapon),
});
assert(starterTrial?.stand[0].parts.some(part => part.itemId === '01702087'), 'persisted starter cannot try on cash equipment');
console.log('Persisted starter face 20000 / hair 30020 and cash trial composition passed.');
