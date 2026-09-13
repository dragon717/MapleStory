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
