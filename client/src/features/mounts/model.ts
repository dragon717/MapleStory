//! 坐骑的客户端**只读**投影（第 30 项）。
//!
//! 骑乘与否、骑的是哪只、快多少，全部是**服务端事实**：本模块只把
//! `PlayerState.mount` 与 `PlayerState.equipped` 翻译成可显示的文字与一个开关意图，
//! 绝不推导「我在骑」。
//!
//! 两条判据各自的来源，别相互代入：
//! * **是否骑乘** —— 只有 `player.mount` 在不在。装备里有坐骑**不等于**在骑。
//! * **是否坐骑装备** —— `isMountItem`（＝源字段 `tamingMob` 在不在），与
//!   `server/src/inventory.rs::is_mount_item` 同源；**不看** `islot`。
//! * **提交时用哪个槽** —— 权威装备行自己的槽位（18/19），不是本地 id→槽 的推算。

import type { InventoryItem, MountState, PlayerState } from '../../../../shared/protocol';
import { isMountItem, itemName } from '../inventory/names';

/** 骑宠的身体槽（**正数**，与 `PlayerState.equipped[].slot`、服务端
 *  `mounts.rs::MOUNT_BODY_SLOTS` 同一口径）。提交给服务端时取负号：
 *  `useItem` 里负槽号就是「已装备的那个槽」。 */
export const MOUNT_BODY_SLOTS: readonly number[] = [18, 19];

export interface MountReadout {
  itemId: string;
  name: string;
  tamingMob: number;
  /** 源口径（100 = 常规）：显示用，不是运行时系数。像素换算只在服务端。 */
  speed: number;
  jump: number;
  fs: number;
  fatigue: number;
}

/** 快照投影。缺席即未骑乘。 */
export function mountReadout(player: PlayerState | undefined): MountReadout | undefined {
  const mount: MountState | undefined = player?.mount;
  if (!mount) return undefined;
  return {
    itemId: mount.itemId,
    name: itemName(mount.itemId),
    tamingMob: mount.tamingMob,
    speed: mount.speed,
    jump: mount.jump,
    fs: mount.fs,
    fatigue: mount.fatigue,
  };
}

/** 骑乘的源读数按「100 = 常规」显示成百分比，**不**换算成像素/秒：
 *  像素系数是服务端的事，客户端再算一遍就是第二套口径。 */
export function mountSpeedLabel(readout: MountReadout): string {
  const delta = readout.speed - 100;
  return delta === 0 ? '100%' : `${readout.speed}% (${delta > 0 ? '+' : ''}${delta})`;
}

/** 骑乘开关的目标：要提交的那件骑宠、它在权威装备里的槽位、当前是否在骑。 */
export interface MountToggleTarget {
  itemId: string;
  /** **正数**槽位（18/19）。提交时取负——负槽号＝已装备，见本文件顶端注释。 */
  slot: number;
  riding: boolean;
}

/**
 * 把「现在能不能切换骑乘、切换哪一件」算成一个意图。
 *
 * 三条落空即返回 `undefined`（**失败即不给开关**，而不是拿 `equipped` 里的
 * 第一件硬凑一个槽）：
 *  1. 快照说在骑，但 `equipped` 里找不到那一行 —— 两份数据不同步，宁可不发；
 *  2. 没在骑，但装备里也没有带 `tamingMob` 的坐骑；
 *  3. 找到的那一行不在 18/19 槽上。
 */
export function mountToggleTarget(player: PlayerState | undefined): MountToggleTarget | undefined {
  if (!player) return undefined;
  const ridingId = player.mount?.itemId;
  const equipped = player.equipped;
  const row: InventoryItem | undefined = equipped?.find(item =>
    ridingId === undefined ? isMountItem(item.itemId) : item.itemId === ridingId,
  );
  if (!row) return undefined;
  const slot = Math.abs(row.slot);
  if (!MOUNT_BODY_SLOTS.includes(slot)) return undefined;
  return { itemId: row.itemId, slot, riding: ridingId !== undefined };
}
