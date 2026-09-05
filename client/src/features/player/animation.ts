export function frameAt(delays: number[], elapsed: number, loop: boolean): number {
  const duration = delays.reduce((sum, delay) => sum + delay, 0);
  let cursor = loop ? Math.max(0, elapsed) % duration : Math.min(Math.max(0, elapsed), duration - 0.001);
  for (let index = 0; index < delays.length; index++) { cursor -= delays[index]; if (cursor < 0) return index; }
  return delays.length - 1;
}
