import { pickupMotion, PICKUP_DURATION_MS } from './pickup-motion.ts';

const start = { x: 0, y: 0 };
const target = { x: 32, y: -24 };
const first = pickupMotion(start, target, 0);
const middle = pickupMotion(start, target, PICKUP_DURATION_MS / 2);
const last = pickupMotion(start, target, PICKUP_DURATION_MS);
if (first.x !== 0 || first.y !== 0 || first.alpha !== 1 || first.done) throw new Error('Pickup must start at the item');
if (middle.x !== 16 || middle.y >= Math.min(start.y, target.y) || middle.alpha !== 0.5) throw new Error('Pickup must jump and fade');
if (last.x !== target.x || last.y !== target.y || last.alpha !== 0 || !last.done) throw new Error('Pickup must end at the looter');
if (pickupMotion(start, { x: 64, y: -24 }, PICKUP_DURATION_MS / 2).x !== 32) throw new Error('Pickup must follow the moving looter');
if (pickupMotion(start, target, PICKUP_DURATION_MS * 2).alpha !== 0) throw new Error('Late frames must finish');
console.log('PASS: pickup arc, moving target, fade and completion.');
