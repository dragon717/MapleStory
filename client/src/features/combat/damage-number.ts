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
