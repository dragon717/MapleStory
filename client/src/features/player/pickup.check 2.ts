import { randomDropId } from './pickup.ts';

const player = { x: 0, y: 0 };
const drops = [{ id: 'protected', x: 0, y: 0 }, { id: 'public', x: 0, y: 0 }, { id: 'edge', x: 32, y: -32 }, { id: 'far', x: 33, y: 0 }];
const originalRandom = Math.random;
try {
  for (const [roll, expected] of [[0, 'protected'], [0.5, 'public'], [0.999, 'edge']] as const) {
    Math.random = () => roll;
    if (randomDropId(drops, player) !== expected) throw new Error(`Pickup selection failed at ${roll}`);
  }
  if (randomDropId([], player) !== null || randomDropId([drops[3]], player) !== null) throw new Error('Out-of-range pickup');
} finally {
  Math.random = originalRandom;
}
console.log('Random overlapping drops, pickup range and empty selection passed.');
