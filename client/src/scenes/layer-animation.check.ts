import { assetFrameAlpha, mapFrameAt, mapFramePosition, type AssetFrame } from '../assets/manifest.ts';

if (assetFrameAlpha({delay:200,a1:0},100)!==0.5 || assetFrameAlpha({delay:200,a1:0},200)!==0) throw new Error('273 source fade endpoint failed');

const frames = [
  { url: 'a', width: 10, height: 20, origin: { x: 2, y: 18 }, x: -2, y: -18, delay: 40 },
  { url: 'b', width: 14, height: 24, origin: { x: 5, y: 21 }, x: -5, y: -21, delay: 90 },
  { url: 'c', width: 12, height: 28, origin: { x: 3, y: 26 }, x: -3, y: -26, delay: 20 },
] satisfies AssetFrame[];

if (mapFrameAt(frames, 0) !== 0 || mapFrameAt(frames, 39) !== 0 || mapFrameAt(frames, 40) !== 1) throw new Error('Unequal frame delays failed');
if (mapFrameAt(frames, 129) !== 1 || mapFrameAt(frames, 130) !== 2 || mapFrameAt(frames, 150) !== 0) throw new Error('Animation loop failed');

const layer = { x: 100, y: 200, origin: frames[0].origin, frames };
const first = mapFramePosition(layer, frames[0]);
const second = mapFramePosition(layer, frames[1]);
if (first.x + frames[0].origin.x !== second.x + frames[1].origin.x || first.y + frames[0].origin.y !== second.y + frames[1].origin.y) {
  throw new Error('Changing frame origins moved the world anchor');
}
const mirrored = mapFramePosition({ ...layer, flip: true }, frames[1]);
if (mirrored.x + frames[1].width - frames[1].origin.x !== layer.x + frames[0].origin.x) throw new Error('Flipped frame anchor failed');

let rejected = false;
try { mapFrameAt([{ delay: 0 }], 0); } catch (_) { rejected = true; }
if (!rejected) throw new Error('Non-positive frame delay was accepted');
console.log('PASS: map frame timing, looping, origin anchoring, flip and delay validation.');
