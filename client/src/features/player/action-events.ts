export function consumeAction(seen: Map<string, { actionId: string; tick: number }>, playerId: string, actionId: string, tick: number): boolean {
  const previous = seen.get(playerId);
  if (previous && (previous.actionId === actionId || previous.tick >= tick)) return false;
  seen.set(playerId, { actionId, tick });
  return true;
}
