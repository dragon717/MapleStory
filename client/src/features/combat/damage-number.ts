const BASE_ADVANCE = [24, 20, 22, 22, 24, 23, 24, 22, 24, 24];

/** Match the v83 DamageNumber.cpp advances, including its fallback to normal digits. */
export function damageNumberAdvances(digits: string, critical: boolean, hasCriticalSet = true) {
  if (!/^\d+$/.test(digits)) return [];
  const useCritical = critical && hasCriticalSet;
  const first = Number(digits[0]);
  const firstAdvance = BASE_ADVANCE[first] + (useCritical ? 8 : 2);
  const advances = [firstAdvance];
  for (let index = 1; index < digits.length; index++) {
    const current = BASE_ADVANCE[Number(digits[index])] + (useCritical ? 4 : 0);
    const next = index + 1 < digits.length ? BASE_ADVANCE[Number(digits[index + 1])] + (useCritical ? 4 : 0) : current;
    advances.push(index + 1 < digits.length ? Math.floor((current + next) / 2) : current);
  }
  return advances;
}

/** 一次承伤实际要画的数字：红字（HP 那一份）+ 蓝字（魔心防禦由 MP 接下那一份）。 */
export interface DamageNumberLayer {
  kind: 'damage' | 'mp';
  value: number;
  /** 相对事件 y 的下移量；两根同现时蓝字下移，免得压住红字。 */
  offsetY: number;
}

/**
 * 一次受击要画哪几根数字。**判据是「两根都为 0 才不画」**，不是「HP 为 0 就整条丢弃」。
 *
 * 魔心防禦下 HP 承担的是未被护罩接下的那 1%（`world::MAGIC_GUARD_COVERED_PERCENT = 99`），
 * 而服务端按整数向下取整 ⇒ 伤害 < 100 时 HP 那一份**正好是 0**，此时唯一有意义的数字就是
 * 蓝字。2026-09-19 实玩实锤：客户端按 `damage > 0` 整条丢弃事件，于是「MP 在掉、一根数字
 * 都没有」，而且服务端发的事件里 `mpDamage` 明明是齐的。
 */
export function damageNumberLayers(damage: number, mpDamage = 0): DamageNumberLayer[] {
  const layers: DamageNumberLayer[] = [];
  if (Number.isFinite(damage) && damage > 0) layers.push({ kind: 'damage', value: damage, offsetY: 0 });
  if (Number.isFinite(mpDamage) && mpDamage > 0) layers.push({ kind: 'mp', value: mpDamage, offsetY: damage > 0 ? 20 : 0 });
  return layers;
}
