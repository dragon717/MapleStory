//! 坐姿的客户端**只读**投影（第 31 项）。
//!
//! 关键诚实边界：`recoveryIntervalMs` 缺席表示**源里这把椅子没有声明任何恢复量**
//! （`info` 既无 `recoveryHP` 也无 `recoveryMP`），此时**不得**显示倒计时——没有
//! 可恢复的东西，倒计时就是一句空话。凡声明了恢复量的椅子都带间隔（椅子系统的固定
//! 节拍 10 秒），服务端在同一判据下按节拍结算。

import type { ChairState, PlayerState } from '../../../../shared/protocol';
import { itemName } from '../inventory/names';

export interface ChairReadout {
  itemId: string;
  name: string;
  /** 源 `info.recoveryHP` / `info.recoveryMP`（缺席即 0，与服务端同一口径）。**可为负**：
   *  `3015014 陷入絕境!` 就是每拍各扣 1。 */
  recoveryHp: number;
  recoveryMp: number;
  /** 已核定的恢复间隔整秒（椅子系统的固定节拍）。与 `secondsToRecovery` 同生共死。 */
  intervalSeconds?: number;
  /** 距下一拍的整秒（向上取整）。**`undefined` ＝ 源没声明恢复量，不是 0。** */
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

/** 这把椅子是否有可结算的恢复量（正负都算：扣血椅也在每个节拍生效）。 */
export function chairHasRecovery(readout: ChairReadout): boolean {
  return readout.recoveryHp !== 0 || readout.recoveryMp !== 0;
}

/** 是否有扣减（负值）——倒计时文案得说「扣减」而不是「恢复」。 */
export function chairDrains(readout: ChairReadout): boolean {
  return readout.recoveryHp < 0 || readout.recoveryMp < 0;
}

/** 恢复量的显示串（源值原样，不换算成百分比）。带符号：扣血椅写 `HP -1`。
 *  两样都是 0 时返回 `undefined`。 */
export function chairRecoveryLabel(readout: ChairReadout): string | undefined {
  const parts: string[] = [];
  if (readout.recoveryHp !== 0) parts.push(`HP ${readout.recoveryHp > 0 ? '+' : ''}${readout.recoveryHp}`);
  if (readout.recoveryMp !== 0) parts.push(`MP ${readout.recoveryMp > 0 ? '+' : ''}${readout.recoveryMp}`);
  return parts.length ? parts.join(' · ') : undefined;
}
