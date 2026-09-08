import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const animation = compile(await readFile(new URL('../player/animation.ts', import.meta.url), 'utf8'));
const animationUrl = `data:text/javascript;base64,${Buffer.from(animation).toString('base64')}`;
const code = compile(await readFile(new URL('./view.ts', import.meta.url), 'utf8'))
  .replace(/^import Phaser from 'phaser';\n/m, '')
  .replace("'../player/animation'", JSON.stringify(animationUrl))
  .replace(/import .* from '..\/..\/app\/i18n';/, "const uiLocale = () => 'zh', displayText = x => x;");
const { NpcView } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const images = [];
const scene = { add: { image: (x, y, texture) => {
  const image = { x, y, texture, visible: true, destroyed: false,
    setOrigin() { return this; }, setDepth(depth) { this.depth = depth; return this; },
    setTexture(texture) { this.texture = texture; return this; },
    setVisible(visible) { this.visible = visible; return this; },
    setPosition(x, y) { this.x = x; this.y = y; return this; },
    getBounds() { return { contains: (x, y) => x === this.x && y === this.y }; },
    setFlipX() { return this; }, destroy() { this.destroyed = true; },
  };
  images.push(image); return image;
} } };
const stand = { url: 'npc', x: -10, y: -50, width: 20, height: 50, delay: 100 };
const marker = [{ url: 'marker0', x: -8, y: -20, width: 16, height: 20, delay: 100 },
  { url: 'marker1', x: -9, y: -22, width: 18, height: 22, delay: 200 }];
const npc = { id: 'hans', templateId: '10201', name: '', x: 100, y: 200, facing: -1 };
const view = new NpcView(scene, { stand: [stand] }, 5, marker);
view.update(npc, 0);
assert.equal(images.length, 1, 'No marker without server eligibility');
assert.equal(view.containsMarker(91, 100), false);
view.update({ ...npc, jobAdvancementAvailable: true }, 100);
assert.equal(images.length, 2);
assert.equal(images[1].texture, 'marker1');
assert.deepEqual([images[1].x, images[1].y], [91, 100]);
assert.equal(view.containsMarker(91, 100), true, 'Visible marker can open the same NPC dialogue');
assert.equal(view.containsMarker(0, 0), false);
view.update({ ...npc, facing: 1, jobAdvancementAvailable: true }, 300);
assert.equal(images.length, 2, 'Animation must reuse the image');
assert.equal(images[1].texture, 'marker0');
view.update(npc, 350);
assert.equal(images[1].visible, false, 'Transferred player loses the marker');
assert.equal(view.containsMarker(images[1].x, images[1].y), false);
view.destroy();
assert(images.every(image => image.destroyed), 'Scene cleanup releases both sprites');
const staticView = new NpcView(scene, { stand: [stand] }, 5, [{ ...marker[0], delay: 0 }]);
staticView.update({ ...npc, jobAdvancementAvailable: true }, 9000);
assert.equal(images.at(-1).texture, 'marker0', 'Source without delay is a static original frame');
staticView.destroy();
console.log('PASS: NPC marker eligibility, source timing/origin, sprite reuse and cleanup.');
