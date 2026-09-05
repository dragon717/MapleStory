export function randomDropId(drops: readonly { id: string; x: number; y: number }[], player: { x: number; y: number }): string | null {
  const nearby = drops.filter(drop => Math.abs(drop.x - player.x) <= 32 && Math.abs(drop.y - player.y) <= 32);
  return nearby[Math.floor(Math.random() * nearby.length)]?.id ?? null;
}
