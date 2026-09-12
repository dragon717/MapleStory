import type { ClientMessage, InventoryItem } from '../../../../shared/protocol';
import { itemName } from './names';
import { TAB_INVENTORY_TYPE } from './view-model';

const MIN_DROP_MESOS = 10;
const MAX_DROP_MESOS = 50_000;

export type SendClientMessage = (message: ClientMessage) => boolean;
type UseItemMessage = Extract<ClientMessage, { type: 'useItem' }>;

export interface PendingScroll {
  sourceTab: number;
  sourceSlot: number;
  item: InventoryItem;
}

/**
 * Narrow view of the truth the intent layer needs (R7 discipline: callbacks
 * in, intents out; the controller owns no slot/inventory state).
 */
export interface InventoryIntentHost {
  status(message: string): void;
  t(zh: string, en: string): string;
  itemAt(slot: number, tab: number): InventoryItem | undefined;
  slotLimit(tab: number): number;
  itemLabel(item: InventoryItem): string;
  practice(): boolean;
  selectedTab(): number;
  mesos(): number;
  /** View-side effect of the scroll-target mode flip (classes, prompt, equip window). */
  onTargetModeChange(selecting: boolean): void;
}

/**
 * Intent construction + sending for the inventory windows: move/drop/gather/
 * sort/use/mesos messages, the requestId sequence, and the pending-request
 * lifecycle (scroll target, pending use confirmation, pending operation).
 * Message shapes and status wording are moved verbatim from InventoryView.
 */
export class InventoryIntents {
  private requestSequence = 0;
  private pendingScroll?: PendingScroll;
  private pendingUseRequestId?: string;
  private pendingInventoryOperation?: 'gather' | 'sort';

  constructor(private readonly send: SendClientMessage, private readonly host: InventoryIntentHost) {}

  hasScrollTarget() {
    return Boolean(this.pendingScroll);
  }

  scrollTarget() {
    return this.pendingScroll;
  }

  /** Drops every pending request marker without notifying (window close paths). */
  resetPending() {
    this.pendingScroll = undefined;
    this.pendingUseRequestId = undefined;
  }

  /** Abandons a queued gather/sort confirmation (tab switch path). */
  resetPendingOperation() {
    this.pendingInventoryOperation = undefined;
  }

  /** Marks a use request as settled; returns true when it was the pending one. */
  completeUseRequest(requestId: string) {
    if (this.pendingUseRequestId !== requestId) return false;
    this.pendingUseRequestId = undefined;
    return true;
  }

  moveSlot(sourceTab: number, sourceSlot: number, targetSlot: number) {
    const item = this.host.itemAt(sourceSlot, sourceTab);
    const maxSlot = this.host.slotLimit(sourceTab);
    if (!item || sourceSlot < 1 || sourceSlot > maxSlot || targetSlot < 1 || targetSlot > maxSlot) return;
    if (!this.send({
      type: 'inventoryMove',
      requestId: this.requestId('move'),
      inventoryType: TAB_INVENTORY_TYPE[sourceTab] ?? sourceTab + 1,
      sourceSlot,
      targetSlot,
      quantity: item.quantity,
    })) {
      this.host.status(this.host.t('物品栏操作需要保持在线。', 'Inventory actions require an online connection.'));
      return;
    }
    this.host.status(this.host.t('正在移动 ' + this.host.itemLabel(item) + '…', 'Moving ' + this.host.itemLabel(item) + '…'));
  }

  dropSlot(sourceTab: number, sourceSlot: number) {
    if (this.host.practice()) { this.host.status(this.host.t('请退出练习后再丢弃物品。', 'Leave practice before dropping items.')); return; }
    const item = this.host.itemAt(sourceSlot, sourceTab);
    if (!item || sourceSlot < 1 || sourceSlot > this.host.slotLimit(sourceTab)) return;
    let quantity = Math.max(0, Math.floor(item.quantity));
    if (quantity > 1) {
      const answer = window.prompt(
        this.host.t('丢弃 ' + itemName(item.itemId) + ' 的数量（1-' + quantity + '）', 'How many ' + itemName(item.itemId) + ' should be dropped? (1-' + quantity + ')'),
        String(quantity),
      );
      if (answer === null) return;
      quantity = Number(answer);
      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > item.quantity) {
        this.host.status(this.host.t('丢弃数量无效。', 'Invalid drop quantity.'));
        return;
      }
    }
    if (!this.send({
      type: 'dropItem',
      requestId: this.requestId('drop'),
      inventoryType: TAB_INVENTORY_TYPE[sourceTab] ?? sourceTab + 1,
      sourceSlot,
      quantity,
    })) {
      this.host.status(this.host.t('物品栏操作需要保持在线。', 'Inventory actions require an online connection.'));
      return;
    }
    this.host.status(this.host.t('正在丢弃 ' + itemName(item.itemId) + ' × ' + quantity + '…', 'Dropping ' + itemName(item.itemId) + ' × ' + quantity + '…'));
  }

  inventoryAction(operation: 'gather' | 'sort') {
    if (this.pendingInventoryOperation) {
      this.host.status(this.host.t('正在整理物品栏，请稍候。', 'Inventory action is already in progress.'));
      return;
    }
    const message: ClientMessage = {
      type: operation === 'gather' ? 'inventoryGather' : 'inventorySort',
      requestId: this.requestId(operation),
      inventoryType: TAB_INVENTORY_TYPE[this.host.selectedTab()] ?? this.host.selectedTab() + 1,
    };
    if (!this.send(message)) {
      this.host.status(this.host.t('物品栏操作需要保持在线。', 'Inventory actions require an online connection.'));
      return;
    }
    this.pendingInventoryOperation = operation;
    this.host.status(operation === 'gather'
      ? this.host.t('正在合并相同道具…', 'Merging matching item stacks…')
      : this.host.t('正在整理物品栏…', 'Sorting inventory…'));
  }

  submitUseItem(sourceTab: number, sourceSlot: number, item: InventoryItem, targetSlot?: number, targetItem?: InventoryItem) {
    if (this.pendingUseRequestId) {
      this.host.status(this.host.t('正在等待上一次卷轴操作。', 'Waiting for the previous scroll action.'));
      return;
    }
    const requestId = this.requestId('use');
    const base = {
      type: 'useItem' as const,
      requestId,
      inventoryType: TAB_INVENTORY_TYPE[sourceTab] ?? sourceTab + 1,
      sourceSlot,
      itemId: item.itemId,
    };
    const message: UseItemMessage = targetSlot === undefined
      ? base
      : { ...base, targetSlot, targetItemId: targetItem?.itemId ?? '' };
    if (!this.send(message)) {
      this.host.status(this.host.t('物品栏操作需要保持在线。', 'Inventory actions require an online connection.'));
      return;
    }
    if (targetSlot !== undefined && this.pendingScroll) {
      this.pendingUseRequestId = requestId;
    } else {
      this.pendingScroll = undefined;
      this.notifyTargetMode();
    }
    if (targetSlot === undefined) {
      this.host.status(this.host.t('正在使用 ' + itemName(item.itemId) + '…', 'Using ' + itemName(item.itemId) + '…'));
    } else {
      this.host.status(this.host.t('正在对 ' + itemName(targetItem?.itemId ?? '') + ' 使用 ' + itemName(item.itemId) + '…', 'Using ' + itemName(item.itemId) + ' on ' + itemName(targetItem?.itemId ?? '') + '…'));
    }
  }

  beginScrollTarget(sourceTab: number, sourceSlot: number, item: InventoryItem) {
    this.pendingScroll = { sourceTab, sourceSlot, item };
    this.notifyTargetMode();
    this.host.status(this.host.t('请选择要使用卷轴的装备。', 'Choose the equipment to use this scroll on.'));
  }

  cancelScrollTarget(notify: boolean) {
    if (!this.pendingScroll) return;
    this.pendingScroll = undefined;
    this.notifyTargetMode();
    if (notify) this.host.status(this.host.t('已取消卷轴使用。', 'Scroll use cancelled.'));
  }

  dropMesos() {
    if (this.host.practice()) { this.host.status(this.host.t('请退出练习后再丢弃金币。', 'Leave practice before dropping mesos.')); return; }
    if (this.host.mesos() < MIN_DROP_MESOS) {
      this.host.status(this.host.t('至少需要 10 金币才能丢弃。', 'At least 10 mesos are required to drop mesos.'));
      return;
    }
    const answer = window.prompt(
      this.host.t('丢弃金币数量（10-' + Math.min(this.host.mesos(), MAX_DROP_MESOS).toLocaleString('zh-CN') + '）', 'How many mesos should be dropped? (10-' + Math.min(this.host.mesos(), MAX_DROP_MESOS).toLocaleString('en-US') + ')'),
      String(Math.min(this.host.mesos(), MAX_DROP_MESOS)),
    );
    if (answer === null) return;
    const quantity = Number(answer);
    if (!Number.isSafeInteger(quantity) || quantity < MIN_DROP_MESOS || quantity > MAX_DROP_MESOS || quantity > this.host.mesos()) {
      this.host.status(this.host.t('金币数量无效。', 'Invalid mesos quantity.'));
      return;
    }
    if (!this.send({
      type: 'dropMesos',
      requestId: this.requestId('mesos'),
      quantity,
    })) {
      this.host.status(this.host.t('物品栏操作需要保持在线。', 'Inventory actions require an online connection.'));
      return;
    }
    this.host.status(this.host.t('正在丢弃金币 × ' + quantity + '…', 'Dropping ' + quantity + ' mesos…'));
  }

  private notifyTargetMode() {
    this.host.onTargetModeChange(Boolean(this.pendingScroll));
  }

  private requestId(prefix: string) {
    const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Date.now().toString(36) + '-' + (++this.requestSequence);
    return (prefix + '-' + random).slice(0, 64);
  }
}
