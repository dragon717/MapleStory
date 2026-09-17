// 权威快照运动插值（Net Motion）定向检查。
//
// 复用仓库既有做法：把 TS 模块用 `typescript` 转译后经 data URL 装入，
// 这样门禁和运行时跑的是同一份源码，而不是门禁里另写一份实现。
//
// 断言分三组：
//  1) 行为组——20 Hz 快照在 60 fps 下不再出现"走一步停两帧"，瞬移/断流不拉丝，
//     离开视野的轨迹被清掉，重复与乱序的快照不会把角色拽回去，路径不累积漂移；
//  2) 不变量组——时钟不倒流、不外推（渲染点永远不新于最新权威样本）；
//  3) 接线组——`scenes/world.ts` 真的接上了插值器，并在换图时 reset。

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./motion-interpolator.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^import .*;\r?\n/gm, '');
const {
  MotionInterpolator,
  SELF_DELAY_TICKS,
  PEER_DELAY_TICKS,
} = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

const TICK_MS = 50;
const FRAME_MS = 1000 / 60;
const STEP = 10; // 服务端每拍走 10 个世界单位

/** 跑一段稳态流：每拍 observe 一次，其间渲染 `framesPerTick` 帧。 */
function run(motion, { ticks = 30, framesPerTick = 3, x0 = 0 } = {}) {
  const samples = [];
  let tick = 1;
  let x = x0;
  for (let t = 0; t < ticks; t++) {
    tick = t + 1;
    x = x0 + t * STEP;
    motion.observe([{ id: 'a', x, y: 0 }], tick, TICK_MS);
    for (let f = 0; f < framesPerTick; f++) {
      motion.advance(FRAME_MS);
      samples.push(motion.render({ id: 'a', x, y: 0, }).x);
    }
  }
  return { samples, tick, x };
}

// --- 1) 行为组 ---------------------------------------------------------------

{
  const motion = new MotionInterpolator();
  const { samples, x } = run(motion);
  // 跳过开头的时钟收敛段（首次对表后约 4~5 拍）。
  const steady = samples.slice(15);
  const deltas = steady.slice(1).map((value, i) => value - steady[i]);
  const min = Math.min(...deltas);
  const max = Math.max(...deltas);
  // 改之前：一个 tick 走 10，一帧跳 10、两帧不动 ⇒ 最小位移 0。
  // 插值后每一帧都在动，且没有任何一帧跨过整拍步长。
  assert.ok(min > 0, `不应出现停顿帧（最小帧位移 ${min}）`);
  assert.ok(max < STEP, `不应出现整拍跳跃（最大帧位移 ${max} vs 拍步长 ${STEP}）`);
  // 60 fps / 20 Hz ⇒ 稳态每帧 STEP/3。
  assert.ok(Math.abs(max - STEP / 3) < 1.2, `稳态帧位移应≈${(STEP / 3).toFixed(2)}，实测 ${max.toFixed(3)}`);
  // 路径不累积漂移：终点必须收敛到最新权威点。
  assert.ok(Math.abs(samples[samples.length - 1] - x) < STEP, '终点应贴住最新权威样本');
}
{
  // 首拍不能滞后：第一条轨迹没有"上一拍"，必须直接站在自己的位置上。
  const motion = new MotionInterpolator();
  motion.observe([{ id: 'a', x: 500, y: 20 }], 10, TICK_MS);
  const drawn = motion.render({ id: 'a', x: 500, y: 20 });
  assert.equal(drawn.x, 500);
  assert.equal(drawn.y, 20);
}
{
  // 换图/传送：两拍之间跨了 900 单位 ⇒ 直接落到新点，绝不横穿地图。
  const motion = new MotionInterpolator();
  motion.observe([{ id: 'a', x: 0, y: 0 }], 1, TICK_MS);
  motion.observe([{ id: 'a', x: 900, y: 0 }], 2, TICK_MS);
  for (let f = 0; f < 6; f++) motion.advance(FRAME_MS);
  assert.equal(motion.render({ id: 'a', x: 900, y: 0 }).x, 900, '瞬移必须直接落点');
}
{
  // 断流（后台标签页）：间隔 12 拍，同样直接落点，不要滑行半秒。
  const motion = new MotionInterpolator();
  motion.observe([{ id: 'a', x: 0, y: 0 }], 1, TICK_MS);
  motion.observe([{ id: 'a', x: 90, y: 0 }], 13, TICK_MS);
  motion.advance(FRAME_MS);
  assert.equal(motion.render({ id: 'a', x: 90, y: 0 }).x, 90, '断流恢复必须直接落点');
}
{
  // 只有 x/y 被插值，其余字段一律取最新样本（动作/朝向/血量不能插值）。
  const motion = new MotionInterpolator();
  motion.observe([{ id: 'a', x: 0, y: 0 }], 1, TICK_MS);
  for (let f = 0; f < 3; f++) motion.advance(FRAME_MS); // 第一拍到第二拍之间真实过了 50ms
  motion.observe([{ id: 'a', x: 10, y: 0 }], 2, TICK_MS);
  motion.advance(FRAME_MS);
  const drawn = motion.render({ id: 'a', x: 10, y: 0, action: 'jump', hp: 42 });
  assert.equal(drawn.action, 'jump');
  assert.equal(drawn.hp, 42);
  assert.ok(drawn.x > 0 && drawn.x < 10, `x 应落在两点之间，实测 ${drawn.x}`);
}
{
  // 离开视野 ⇒ 轨迹清掉，再出现时重新从自己的位置起步。
  const motion = new MotionInterpolator();
  motion.observe([{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 5, y: 0 }], 1, TICK_MS);
  assert.equal(motion.trackCount, 2);
  motion.observe([{ id: 'a', x: 10, y: 0 }], 2, TICK_MS);
  assert.equal(motion.trackCount, 1, '不在快照里的实体必须被清掉');
  motion.observe([{ id: 'b', x: 777, y: 0 }], 3, TICK_MS);
  motion.advance(FRAME_MS);
  assert.equal(motion.render({ id: 'b', x: 777, y: 0 }).x, 777, '重新出现的实体不接旧轨迹');
}
{
  // 重复投递与乱序：都不会把角色拽回旧位置。
  const motion = new MotionInterpolator();
  motion.observe([{ id: 'a', x: 0, y: 0 }], 5, TICK_MS);
  motion.observe([{ id: 'a', x: 10, y: 0 }], 6, TICK_MS);
  motion.observe([{ id: 'a', x: 0, y: 0 }], 6, TICK_MS); // 同拍重复
  motion.observe([{ id: 'a', x: 3, y: 0 }], 4, TICK_MS); // 乱序旧拍
  motion.advance(FRAME_MS);
  const drawn = motion.render({ id: 'a', x: 10, y: 0 });
  assert.ok(drawn.x >= 0 && drawn.x <= 10, `乱序/重复不得把角色拽出区间，实测 ${drawn.x}`);
  assert.equal(motion.newestTick, 6, '旧 tick 不得回退最新拍');
}
{
  // 自角色比远端少缓冲一拍：同样的数据流下画得更靠前（更接近最新权威点）。
  const peer = new MotionInterpolator({ delayTicks: PEER_DELAY_TICKS });
  const self = new MotionInterpolator({ delayTicks: SELF_DELAY_TICKS });
  assert.ok(SELF_DELAY_TICKS < PEER_DELAY_TICKS, '自角色延迟必须小于远端');
  const peerRun = run(peer);
  const selfRun = run(self);
  const peerX = peerRun.samples[peerRun.samples.length - 1];
  const selfX = selfRun.samples[selfRun.samples.length - 1];
  assert.ok(selfX > peerX, `自角色应画得更靠前（self ${selfX} vs peer ${peerX}）`);
  assert.ok(selfX <= peerRun.x, '自角色也不得外推到最新样本之外');
}

// --- 2) 不变量组 -------------------------------------------------------------

{
  const motion = new MotionInterpolator();
  let previous = -Infinity;
  for (let t = 1; t <= 20; t++) {
    motion.observe([{ id: 'a', x: t * STEP, y: 0 }], t, TICK_MS);
    for (let f = 0; f < 3; f++) {
      motion.advance(FRAME_MS);
      // 时钟不倒流：advance 只能让渲染时钟前进（速率恒为正）。
      assert.ok(motion.renderTick >= previous, '渲染时钟不得倒流');
      previous = motion.renderTick;
      // 不外推：渲染点永远不新于最新权威样本。
      assert.ok(motion.renderTick <= motion.newestTick + 1e-9, '渲染时钟不得跑到最新样本之后');
    }
  }
}
{
  // 长时间不推快照（连接抖动）：时钟停在最新拍，不靠速度往前猜。
  const motion = new MotionInterpolator();
  motion.observe([{ id: 'a', x: 0, y: 0 }], 1, TICK_MS);
  motion.observe([{ id: 'a', x: 10, y: 0 }], 2, TICK_MS);
  for (let f = 0; f < 60; f++) motion.advance(FRAME_MS);
  assert.ok(motion.renderTick <= 2 + 1e-9, `无新样本时时钟必须停住，实测 ${motion.renderTick}`);
  assert.equal(motion.render({ id: 'a', x: 10, y: 0 }).x, 10);
}
{
  // reset 之后重新对表：换图不能带着上一张图的轨迹与时钟。
  const motion = new MotionInterpolator();
  motion.observe([{ id: 'a', x: 0, y: 0 }], 900, TICK_MS);
  motion.observe([{ id: 'a', x: 10, y: 0 }], 901, TICK_MS);
  motion.reset();
  assert.equal(motion.trackCount, 0);
  motion.observe([{ id: 'a', x: 4242, y: 0 }], 1, TICK_MS);
  motion.advance(FRAME_MS);
  assert.equal(motion.render({ id: 'a', x: 4242, y: 0 }).x, 4242);
}

// --- 3) 接线组 ---------------------------------------------------------------

{
  const world = await readFile(new URL('../../scenes/world.ts', import.meta.url), 'utf8');
  assert.ok(
    /from '\.\.\/features\/net-motion\/motion-interpolator'/.test(world),
    'world.ts 必须引入 net-motion 插值器',
  );
  for (const call of ['observe(', 'advance(', 'render(']) {
    assert.ok(new RegExp(`Motion\\w*\\.${call.replace('(', '\\(')}`).test(world), `world.ts 必须调用 ${call}`);
  }
  assert.ok(/motionReset\(\)/.test(world), '换图必须 reset 轨迹与时钟');
  // 权威边界：插值只改展示，不得反过来向服务端提交坐标。
  assert.ok(
    !/send\(\{[^}]*\bx:/.test(world),
    'world.ts 不得向服务端提交坐标（插值只是展示层）',
  );
}

console.log('net-motion: all assertions passed');
