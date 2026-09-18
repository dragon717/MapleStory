//! 坐姿的客户端**只读**投影（第 31 项）。
//!
//! 关键诚实边界：`recoveryIntervalMs` 缺席表示**该椅子的恢复间隔未核定**
//! （源 `String/Ins.json` 的描述文案里没写「每N秒」，`info` 里本来就没有间隔字段），
//! 此时**不得**显示倒计时、也不得按默认 10 秒推算——那正是「编规则」。
//! 服务端在同一判据下也不恢复（`chairs.rs` 只在两个字段都有值时才推进）。

import type { ChairState, PlayerState } from '../../../../shared/protocol';
import { itemName } from '../inventory/names';

export interface ChairReadout {
  itemId: string;
  name: string;
  /** 源 `info.recoveryHP` / `info.recoveryMP`（缺席即 0，与服务端同一口径）。 */
  recoveryHp: number;
  recoveryMp: number;
  /** 已核定的恢复间隔整秒（源文案里的 N）。与 `secondsToRecovery` 同生共死。 */
  intervalSeconds?: number;
  /** 距下一次恢复的整秒（向上取整）。**`undefined` ＝ 间隔未核定，不是 0。** */
  secondsToRecovery?: number;
}

/** 快照投影。缺席即未坐下。 */
export function chairReadout(player: PlayerState | undefined): ChairReadout | undefined {
  const chair: ChairState | undefined = player?.chair;
  if (!chair) return undefined;
  const verified = chair.recoveryIntervalMs !== undefined && chair.nextRecoveryInMs !== undefined;
  return {
    itemId: chair.itemId,
    name: itemName(chair.itemId),
    recoveryHp: chair.recoveryHp,
    recoveryMp: chair.recoveryMp,
    intervalSeconds: verified ? Math.round((chair.recoveryIntervalMs ?? 0) / 1000) : undefined,
    secondsToRecovery: verified ? Math.max(0, Math.ceil((chair.nextRecoveryInMs ?? 0) / 1000)) : undefined,
  };
}

/** 这把椅子的恢复间隔是否已核定。`false` ⇒ 只坐、不恢复、不给倒计时。 */
export function chairIntervalVerified(readout: ChairReadout): boolean {
  return readout.secondsToRecovery !== undefined;
}

/** 恢复量的显示串（源值原样，不换算成百分比）。两样都是 0 时返回 `undefined`。 */
export function chairRecoveryLabel(readout: ChairReadout): string | undefined {
  const parts: string[] = [];
  if (readout.recoveryHp > 0) parts.push(`HP +${readout.recoveryHp}`);
  if (readout.recoveryMp > 0) parts.push(`MP +${readout.recoveryMp}`);
  return parts.length ? parts.join(' · ') : undefined;
}
