import { damageNumberAdvances, damageNumberLayers } from './damage-number.ts';

function check(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

check(damageNumberAdvances('1234', false), [22, 22, 23, 24]);
check(damageNumberAdvances('1234', true), [28, 26, 27, 28]);
check(damageNumberAdvances('1234', true, false), [22, 22, 23, 24]);

// 承伤两根数字的取舍：魔心防禦下 HP 那一份常常是 0（<100 伤害的 1% 整数除法），
// 此时**仍然要画蓝字** —— 判据是「两根都为 0 才不画」，不是「HP 为 0 就整条丢弃」。
check(damageNumberLayers(0, 12), [{ kind: 'mp', value: 12, offsetY: 0 }]);
check(damageNumberLayers(30, 12), [
  { kind: 'damage', value: 30, offsetY: 0 },
  { kind: 'mp', value: 12, offsetY: 20 },
]);
check(damageNumberLayers(30, 0), [{ kind: 'damage', value: 30, offsetY: 0 }]);
check(damageNumberLayers(0, 0), []);
console.log('PASS: normal/critical damage-number advances and fallback, plus HP/MP layer split.');
