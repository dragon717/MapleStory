export function frameAt(delays: number[], elapsed: number, loop: boolean): number {
  const duration = delays.reduce((sum, delay) => sum + delay, 0);
  // 源里的静态单帧动作（`Character/00002000.img/sit` 只有一帧且**没有 delay**，
  // 见 `scripts/export_tms273_avatar.cjs` 的 `sit`）会让 duration 为 0，`elapsed % 0`
  // 得到 NaN。静态动作的答案就是第 0 帧，这里显式短路，而不是依赖「NaN 的比较恰好
  // 落到 length-1」这种巧合。
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  let cursor = loop ? Math.max(0, elapsed) % duration : Math.min(Math.max(0, elapsed), duration - 0.001);
  for (let index = 0; index < delays.length; index++) { cursor -= delays[index]; if (cursor < 0) return index; }
  return delays.length - 1;
}

export function assetFrameAlpha(frame: { a0?: number; a1?: number; alpha?: number; delay: number }, elapsed: number): number {
  const start = frame.a0 ?? frame.alpha ?? 255, end = frame.a1 ?? start;
  const progress = frame.delay > 0 ? Math.max(0, Math.min(1, elapsed / frame.delay)) : 0;
  return Math.max(0, Math.min(1, (start + (end - start) * progress) / 255));
}
