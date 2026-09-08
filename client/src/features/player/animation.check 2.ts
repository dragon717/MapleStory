import { frameAt } from './animation.ts';
function check(actual: number, expected: number) { if (actual !== expected) throw new Error(`${actual} !== ${expected}`); }
check(frameAt([100, 250, 80], 99, true), 0);
check(frameAt([100, 250, 80], 100, true), 1);
check(frameAt([100, 250, 80], 350, true), 2);
check(frameAt([100, 250, 80], 430, true), 0);
check(frameAt([100, 250, 80], 999, false), 2);
console.log('Animation delay boundaries and non-looping attacks passed.');
import { consumeAction } from './action-events.ts';
const seen = new Map<string, { actionId: string; tick: number }>();
check(Number(consumeAction(seen, 'player-a', 'action-1', 10)), 1);
check(Number(consumeAction(seen, 'player-a', 'action-1', 10)), 0);
check(Number(consumeAction(seen, 'player-a', 'action-2', 20)), 1);
check(Number(consumeAction(seen, 'player-a', 'action-1', 10)), 0);
check(Number(consumeAction(seen, 'player-b', 'action-3', 10)), 1);
console.log('Repeated and stale action acknowledgements do not replay sound.');
