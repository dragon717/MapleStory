import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('./view.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const animation = ts.transpileModule(await readFile(new URL('./animation.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } });
globalThis.frameAt = (await import(`data:text/javascript;base64,${Buffer.from(animation.outputText).toString('base64')}`)).frameAt;
globalThis.assetFrameAlpha = () => 1;
const { PlayerView } = await import(`data:text/javascript;base64,${Buffer.from(outputText.replace(/^import .*;\r?\n/gm, '')).toString('base64')}`);
const images = [], sounds = [];
const scene = { time: { now: 0 }, cache: { audio: { exists: () => true } }, add: { image() {
  const image = { destroyed: false, setOrigin() { return this; }, setDepth() { return this; }, setTexture(url) { this.url = url; return this; }, setPosition(x, y) { this.x = x; this.y = y; return this; }, setAlpha() { return this; }, destroy() { this.destroyed = true; } };
  images.push(image); return image;
} }, sound: { add() { const sound = { destroyed: false, once(event, fn) { this.complete = fn; }, play() { return true; }, destroy() { this.destroyed = true; } }; sounds.push(sound); return sound; } } };
const frames = [{ url: 'a', delay: 20, origin: { x: 5, y: 7 } }, { url: 'b', delay: 30, origin: { x: 6, y: 8 } }];
function makeView() {
  return Object.assign(Object.create(PlayerView.prototype), { scene, body: { depth: 0, destroy() {} }, name: { destroy() {} }, manifest: { levelUp: { layers: [frames], sound: { url: 'sound' } } }, levelUpImages: [], levelUpStartedAt: 0 });
}
const view = makeView();
const update = (level, x = 10) => view.updateLevelFeedback({ level, x, y: 20 });
update(5); assert.equal(images.length, 0, 'initial login does not play');
update(7); assert.equal(images.length, 1, 'multi-level gain plays once');
assert.equal(sounds.length, 1);
update(7); update(6); update(7); assert.equal(images.length, 1, 'repeated/stale snapshots do not replay');
scene.time.now = 20; update(7, 30);
assert.equal(images[0].url, 'b'); assert.equal(images[0].x, 24); assert.equal(images[0].y, 12);
scene.time.now = 50; update(7); assert(images[0].destroyed, 'source duration expires');
sounds[0].complete(); assert(sounds[0].destroyed); assert.equal(view.levelUpSound, undefined);
update(8); view.destroy(); assert(images[1].destroyed && sounds[1].destroyed, 'leaving destroys both resources');
makeView().updateLevelFeedback({ level: 8, x: 0, y: 0 }); assert.equal(images.length, 2, 'rejoin starts a fresh baseline');
update(NaN); update(-1); assert.equal(images.length, 2, 'invalid levels ignored');
console.log('Level-up source timing, following, replay protection, initial/rejoin baseline and cleanup passed.');
