export type RouteDirection = 'up' | 'down' | 'left' | 'right';
/** Assign each projected exit one distinct arrow, matching the spatial-map authority. */
export function routeDirectionSlots(exits: readonly { right: number; down: number }[]) {
  const directions = ['up', 'down', 'left', 'right'] as const;
  const vectors = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  const scores = exits.flatMap((e, i) => vectors.map((v, d) => ({
    score: Math.round((e.right * v[0] + e.down * v[1]) * 1e9), i, d,
  }))).sort((a, b) => b.score - a.score || a.i - b.i || a.d - b.d);
  const assigned = new Set<number>(), used = new Set<number>();
  const slots: { index: number; direction: RouteDirection }[] = [];
  for (const s of scores) {
    if (assigned.has(s.i) || used.has(s.d)) continue;
    assigned.add(s.i); used.add(s.d); slots.push({ index: s.i, direction: directions[s.d] });
  }
  return slots;
}
