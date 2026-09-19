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
    setDisplaySize(width, height) { this.displayWidth = width; this.displayHeight = height; return this; },
    setVisible(visible) { this.visible = visible; return this; },
    setPosition(x, y) { this.x = x; this.y = y; return this; },
    getBounds() { return { contains: (x, y) => x === this.x && y === this.y }; },
    setFlipX(value) { this.flipped = value; return this; }, destroy() { this.destroyed = true; },
  };
  images.push(image); return image;
} } };
const stand = { url: 'npc', x: -10, y: -50, width: 20, height: 50, delay: 100 };
const marker = [{ url: 'marker0', x: -8, y: -20, width: 16, height: 20, delay: 100 },
  { url: 'marker1', x: -9, y: -22, width: 18, height: 22, delay: 200 }];
const npc = { id: 'hans', templateId: '10201', name: '', x: 100, y: 200, facing: -1 };
const view = new NpcView(scene, { stand: [stand] }, 5, marker);
view.update(npc, 0);
assert.deepEqual([images[0].displayWidth, images[0].displayHeight], [stand.width, stand.height], 'Frame geometry also controls display size for high resolution original art');
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

// --- 点击选中高亮（阶段一）---
// 客户端的命中测试本来就能点到每一个模板；阶段一补的是「点下去有反馈」。NPC 的
// 精灵是源素材，客户端自己画的只有头顶名牌，所以选中反馈落在名牌上（金 + 全不透明）。
const texts = [];
scene.add.text = (x, y, text, style) => {
  const object = {
    x, y, text, style, color: style.color, alpha: 1, destroyed: false,
    setOrigin() { return this; }, setDepth(depth) { this.depth = depth; return this; },
    setAlpha(alpha) { this.alpha = alpha; return this; },
    setColor(color) { this.color = color; return this; },
    setText(next) { this.text = next; return this; },
    setPosition(x, y) { this.x = x; this.y = y; return this; },
    destroy() { this.destroyed = true; },
  };
  texts.push(object);
  return object;
};
const named = new NpcView(scene, { stand: [stand] }, 5, marker);
assert.equal(texts.length, 0, 'An unnamed npc gets no nameplate');
named.update({ ...npc, name: 'Hans' }, 0);
assert.equal(texts.length, 1);
const plate = texts.at(-1);
assert.equal(plate.color, '#ffffff');
assert.equal(plate.alpha, 0.92);
assert.equal(named.isSelected(), false, 'A fresh npc is not highlighted');
const spritesBeforeSelection = images.length;
named.setSelected(true);
assert.equal(named.isSelected(), true);
assert.equal(plate.color, '#ffe066', 'The clicked npc name turns gold');
assert.equal(plate.alpha, 1);
assert.equal(plate.destroyed, false);
assert.equal(images.length, spritesBeforeSelection, 'Selection adds no sprite of its own');
assert.equal(named.containsMarker(91, 100), false, 'Selection is not a quest marker');
named.setSelected(true);
assert.equal(texts.length, 1, 'Re-asserting the selection is a no-op');
named.setSelected(false);
assert.equal(plate.color, '#ffffff', 'Closing the window restores the nameplate');
assert.equal(plate.alpha, 0.92);
named.destroy();
// 没有 stand 帧的 NPC 连名牌都不建；选中态必须只记住状态，不能在这里炸。
const bare = new NpcView(scene, { stand: [] }, 5, marker);
bare.setSelected(true);
assert.equal(bare.isSelected(), true);
assert.equal(texts.length, 1, 'A texture-less npc never builds a nameplate');
bare.destroy();
console.log('PASS: NPC click selection highlights the clicked nameplate and reverts.');

const walk = [{ ...stand, url: 'walk-1', delay: 180 }, { ...stand, url: 'walk-2', delay: 180 }];
const walker = new NpcView(scene, { stand: [stand], move: walk }, 5);
const walkingSprite = images.at(-1);
walker.update(npc, 0);
assert.equal(walkingSprite.texture, 'npc', 'Restored position starts standing');
walker.update({ ...npc, x: 102, facing: 1 }, 100);
assert.equal(walkingSprite.texture, 'walk-1');
assert.equal(walkingSprite.flipped, true);
walker.update({ ...npc, x: 104, facing: 1 }, 280);
assert.equal(walkingSprite.texture, 'walk-2', 'Movement changes the actual pose, not just the sprite position');
walker.update({ ...npc, x: 104, facing: 1 }, 600);
assert.equal(walkingSprite.texture, 'npc', 'The NPC stops walking when the authoritative position stops');
walker.destroy();
console.log('PASS: NPC movement uses authored frames only while server positions change.');
