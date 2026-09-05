// Mapleweb/Journey Drop.cpp fades pickup over 48 updates of 8 ms.
// Approximate its upward launch with an arc ending at the moving looter's torso.
export const PICKUP_DURATION_MS = 384;
export function pickupMotion(start: { x: number; y: number }, target: { x: number; y: number }, elapsed: number) {
  const t = Math.max(0, Math.min(1, elapsed / PICKUP_DURATION_MS));
  return {
    x: start.x + (target.x - start.x) * t,
    y: start.y + (target.y - start.y) * t - 48 * 4 * t * (1 - t),
    alpha: 1 - t,
    done: t === 1,
  };
}
