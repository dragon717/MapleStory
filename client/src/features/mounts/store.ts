//! 坐骑投影的存放处：**只**缓存最近一次快照算出来的读数与开关目标。
//!
//! 这里没有任何推导 —— 读数与目标都由 `model.ts` 从服务端事实算出，
//! store 只负责「视图读的时候不用自己再碰 `PlayerState`」。视图不持有 `PlayerState`，
//! 因此不存在「视图用旧的自己拼的字段渲染」这条路。

import type { PlayerState } from '../../../../shared/protocol';
import { mountReadout, mountToggleTarget, type MountReadout, type MountToggleTarget } from './model';

export class MountStore {
  private readout?: MountReadout;
  private target?: MountToggleTarget;

  update(player: PlayerState | undefined) {
    this.readout = mountReadout(player);
    this.target = mountToggleTarget(player);
  }

  clear() {
    this.readout = undefined;
    this.target = undefined;
  }

  /** 当前骑乘读数（缺席＝未骑乘）。 */
  current(): MountReadout | undefined {
    return this.readout;
  }

  /** 当前可提交的骑乘开关；缺席＝现在没有可切换的坐骑。 */
  toggleTarget(): MountToggleTarget | undefined {
    return this.target;
  }
}
