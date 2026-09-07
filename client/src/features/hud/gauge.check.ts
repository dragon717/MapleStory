import { gaugeRatio } from './view.ts';
for (const [value, maximum, expected] of [[15,50,0.3],[0,0,0],[-10,50,0],[60,50,1],[NaN,50,0],[10,Infinity,0]]) {
  if (gaugeRatio(value, maximum) !== expected) throw new Error(`Invalid gauge ratio: ${value}/${maximum}`);
}
console.log('TMS273 gauge checks passed');
