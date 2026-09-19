//! 背包视图模型（计划 §8.2：R4 第一批拆分）。
//!
//! 服务端快照到页签/格子/装备展示的**纯转换**：只接收快照数据与布局常量，
//! 不持有 DOM、连接、金币真值，也不发协议消息。页签顺序、槽位上限与
//! 冷却展示都是服务端权威数据的投影，这里绝不发明新的游戏事实。

import type { InventoryItem, PlayerState } from '../../../../shared/protocol';
import { equipmentSlot, itemCategoryTab } from './names';

export const TAB_COUNT = 5;
// Order mirrors the source-authored tab:category/<n> frame sequence
// (裝備 / 消耗 / 其他 / 裝飾 / 現金).  Any reshuffle here must match
// `inventoryLayout.small.tabs.count` and the `tab:category/<state>/<n>`
// frames in manifest.inventoryUi.
export const TAB_LABEL_KEYS = ['inventoryEquip', 'inventoryUse', 'inventoryEtc', 'inventorySetup', 'inventoryCash'] as const;
// Server-side inventory type per visible tab index.  Mirrors the
// authoritative five-bucket catalog: 1=equip, 2=use, 3=setup, 4=etc, 5=cash.
// The tab order above is *not* a straight +1 because the source frames put
// 4 (Etc) before 3 (Setup).
export const TAB_INVENTORY_TYPE: Readonly<Record<number, number>> = {
  0: 1,
  1: 2,
  2: 4,
  3: 3,
  4: 5,
};

/** The inventory window's display projection of the server player snapshot. */
export type InventoryPlayer = Pick<PlayerState, 'inventory' | 'mesos' | 'mount'> & {
  equipped?: InventoryItem[];
  potionCooldowns?: Record<string, number>;
  inventorySlots?: Record<number, number>;
};

/** Server-side inventory type for a visible tab (with the historical fallback). */
export function inventoryTypeForTab(tab: number): number {
  return TAB_INVENTORY_TYPE[tab] ?? tab + 1;
}

/** The `data-inventory` projection used by tests and tooling to read the grid. */
export function slotsDataset(inventory: InventoryItem[]): string {
  return inventory
    .map(item => String(itemCategoryTab(item.itemId) + 1) + ':' + item.slot + ':' + item.itemId + ':' + item.quantity)
    .join(',');
}

/**
 * Render signature for the slot grid: any change in items, equipped entries,
 * cooldown seconds or tab capacities must re-render; cooldowns round to
 * seconds so ticking clocks only repaint when the displayed digit changes.
 */
export function slotsSignature(parts: {
  inventory: InventoryItem[];
  equipped: InventoryItem[];
  potionCooldowns: Record<string, number>;
  inventorySlots: Record<number, number>;
  /** 正在骑乘的骑宠 id（服务器快照）。  上/下马不改背包也不改装备，却要重画装备窗
   *  里骑宠格的高亮与文案，所以它必须进签名，否则状态变了窗口还是旧的。 */
  mounted?: string;
}): string {
  const { inventory, equipped, potionCooldowns, inventorySlots, mounted } = parts;
  return inventory
    .slice()
    .sort((left, right) => itemCategoryTab(left.itemId) - itemCategoryTab(right.itemId) || left.slot - right.slot)
    .map(item => String(itemCategoryTab(item.itemId)) + ':' + item.slot + ':' + JSON.stringify(item))
    .concat(equipped.map(item => 'equipped:' + item.slot + ':' + JSON.stringify(item)))
    .concat(Object.entries(potionCooldowns)
      .map(([itemId, ms]) => `cd:${itemId}:${cooldownSeconds(ms)}`))
    .concat(Object.entries(inventorySlots)
      .map(([type, slots]) => `cap:${type}:${slots}`))
    .concat([`mounted:${mounted ?? ''}`])
    .join('|');
}

/** The item occupying a grid slot on a tab (tab = visible index, not type). */
export function itemAtSlot(inventory: InventoryItem[], slot: number, tab: number): InventoryItem | undefined {
  return inventory.find(item => item.slot === slot && itemCategoryTab(item.itemId) === tab);
}

/** The equipped instance whose body slot matches the window slot number. */
export function equippedAtSlot(equipped: InventoryItem[], slotNumber: number): InventoryItem | undefined {
  return equipped.find(item => Math.abs(item.slot) === slotNumber);
}

/** Current server-owned slot capacity for a visible tab; falls back to layout default. */
export function slotLimit(inventorySlots: Record<number, number>, tab: number, backendSlotLimit: number): number {
  return inventorySlots[inventoryTypeForTab(tab)] ?? backendSlotLimit;
}

/** Equipment comparison target: the currently worn item in the same body slot. */
export function comparisonTarget(item: InventoryItem, equipped: InventoryItem[]): InventoryItem | null | undefined {
  const slot = equipmentSlot(item.itemId);
  if (slot === undefined) return undefined;
  return equipped.find(current => Math.abs(current.slot) === slot) ?? null;
}

/** Cooldown display seconds (ceil); server owns the remaining milliseconds. */
export function cooldownSeconds(ms: number): number {
  return Math.ceil(ms / 1000);
}
