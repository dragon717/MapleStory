//! 坐姿投影的存放处：**只**缓存最近一次快照算出来的读数。
//! 与 `mounts/store.ts` 同一分工——推导全在 `model.ts`，store 只负责让视图
//! 不必自己持有 `PlayerState`。

import type { PlayerState } from '../../../../shared/protocol';
import { chairReadout, type ChairReadout } from './model';

export class ChairStore {
  private readout?: ChairReadout;

  update(player: PlayerState | undefined) {
    this.readout = chairReadout(player);
  }

  clear() {
    this.readout = undefined;
  }

  /** 当前坐姿读数（缺席＝未坐下）。 */
  current(): ChairReadout | undefined {
    return this.readout;
  }
}
