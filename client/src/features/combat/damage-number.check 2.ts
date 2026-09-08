import { damageNumberAdvances } from './damage-number.ts';

function check(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

check(damageNumberAdvances('1234', false), [22, 22, 23, 24]);
check(damageNumberAdvances('1234', true), [28, 26, 27, 28]);
check(damageNumberAdvances('1234', true, false), [22, 22, 23, 24]);
console.log('PASS: normal/critical damage-number advances and fallback.');
