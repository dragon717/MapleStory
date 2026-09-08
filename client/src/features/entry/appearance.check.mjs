import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { build } from 'esbuild';
const result = await build({ entryPoints: [fileURLToPath(new URL('./appearance.ts', import.meta.url))], bundle: true, write: false, format: 'esm' });
const { composeAppearance, initialEquipment } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
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
