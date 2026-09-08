import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const transpile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const moduleFrom = text => import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`);
globalThis.frameAt = (await moduleFrom(transpile(await readFile(new URL('../player/animation.ts', import.meta.url), 'utf8')))).frameAt;
const { MonsterView } = await moduleFrom(transpile(await readFile(new URL('./view.ts', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, ''));
const manifest = JSON.parse(await readFile(new URL('../../../public-tms273/assets/manifest.json', import.meta.url), 'utf8'));
const images = [];
const scene = { add: { image(x, y, url) {
  const image = {
    x, y, url, destroyed: false,
    setOrigin() { return this; }, setVisible() { return this; }, setFlipX() { return this; },
    setDepth(depth) { this.depth = depth; return this; },
    setTexture(value) { this.url = value; return this; },
    setPosition(x, y) { this.x = x; this.y = y; return this; },
    destroy() { this.destroyed = true; },
  };
  images.push(image); return image;
} } };
const view = new MonsterView(scene, manifest.monsters['3220000'], 100, [], manifest.bossEffects);
const boss = { id: 'boss', templateId: '3220000', x: 400, y: 800, facing: 1, hp: 7500, maxHp: 7500, action: 'stand', actionStartedTick: 0 };
const guard = { skillId: 112, elapsedMs: 0, remainingMs: 30000 };
view.update(boss, 0);
view.updateBossEffects(boss, [guard], 0);
assert.equal(images.length, 3, 'one mob, one cast effect and one defense icon');
const cast = images[1], icon = images[2];
view.updateBossEffects(boss, [guard], 100);
assert.equal(images.length, 3, 'snapshot replay reuses sprites');
const iconX = icon.x;
view.updateBossEffects({ ...boss, x: boss.x + 20 }, [guard], 200);
assert.equal(icon.x, iconX + 20, 'status follows the authoritative Boss');
view.updateBossEffects(boss, [guard], 800);
assert(cast.destroyed && !icon.destroyed, 'cast ends once while defense remains');
view.updateBossEffects(boss, [guard], 30000);
assert(icon.destroyed, 'status expires without another packet');
view.updateBossEffects(boss, [{ skillId: 114, elapsedMs: 0, remainingMs: 2060 }], 0);
const heal = images.at(-1), frames = manifest.bossEffects['114'].mob0;
assert.equal(images.length, 4, 'healing skips the empty mob icon');
assert.equal(heal.url, frames[0].url, 'source opening delay is retained');
view.updateBossEffects(boss, [{ skillId: 114, elapsedMs: 0, remainingMs: 2060 }], 1100);
assert.equal(heal.url, frames[1].url);
view.updateBossEffects(boss, [{ skillId: 114, elapsedMs: 0, remainingMs: 2060 }], 2060);
assert(heal.destroyed);
view.updateBossEffects(boss, [guard], 0);
view.updateBossEffects({ ...boss, hp: 0 }, [guard], 100);
assert(images.slice(1).every(image => image.destroyed), 'death clears all effects');
view.updateBossEffects(boss, [guard], 0);
view.updateBossEffects(boss, undefined, 0);
assert(images.slice(1).every(image => image.destroyed), 'absent snapshot status clears effects');
view.updateBossEffects(boss, [guard], 0);
view.destroy();
assert(images.every(image => image.destroyed), 'map removal destroys the mob and effects');
console.log('Boss source timing, replay reuse, following, expiry, death and map cleanup passed.');
