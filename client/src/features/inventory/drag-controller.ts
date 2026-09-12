import type { InventoryItem } from '../../../../shared/protocol';
import { itemCategoryTab } from './names';
import { TAB_INVENTORY_TYPE } from './view-model';

/**
 * 一次拖拽的来源：页签（可视顺序）+ 槽位 + 发起时的物品快照。
 * 物品是发起瞬间的只读投影；提交前以服务端权威数据为准。
 */
export interface DragSource {
  tab: number;
  slot: number;
  item: InventoryItem;
}

/**
 * 拖拽域需要的只读查询与意图出口（plan §8.2：输出用户意图）。
 * 真值——背包内容、装备栏、卷轴目标阶段——仍归 `view.ts` 所有；
 * 控制器只读快照、维护拖拽状态、把 drop 翻译成一个意图回调。
 */
export interface DragHost {
  /** 当前可视页签（0..4，源顺序 裝備/消耗/其他/裝飾/現金）。 */
  selectedTab(): number;
  /** 卷轴目标选择进行中（此时拖拽被抑制）。 */
  scrollPending(): boolean;
  /** 物品栏或装备栏窗口任一可见（document 级 drop 放行条件）。 */
  windowOpen(): boolean;
  /** drop 目标落在自己窗口内（窗口内 drop 由槽位自身处理）。 */
  containsTarget(node: Node): boolean;
  inventoryItemAt(slot: number, tab: number): InventoryItem | undefined;
  equippedItemAt(slot: number): InventoryItem | undefined;
  isScroll(item: InventoryItem): boolean;
  moveItem(sourceTab: number, sourceSlot: number, targetSlot: number): void;
  dropItem(sourceTab: number, sourceSlot: number): void;
  unequip(item: InventoryItem): void;
  useScrollOnEquipment(sourceTab: number, sourceSlot: number, item: InventoryItem, targetSlot: number, target: InventoryItem | undefined): void;
  useItem(sourceTab: number, sourceSlot: number, item: InventoryItem): void;
  /** 清除窗口内的拖拽高亮类（DOM 归 view 所有）。 */
  clearDragMarks(): void;
}

/**
 * 物品/装备拖放控制器（plan §8.2 的 `drag-controller.ts`）。
 *
 * 拥有：拖拽来源状态（来源槽/来源页签/装备槽）与拖拽高亮类的维护，
 * 以及 document 级 `dragover`/`drop`（拖出窗口即丢弃/卸下）。
 * 不拥有：服务端槽位与金币真值、requestId 生成、协议发送。
 * 交互语义逐行来自原 `view.ts`（R7 拆分），包括卷轴阶段抑制拖拽、
 * 装备→背包只允许落回装备页签、卷轴只能落在已装备槽等分支。
 */
export class DragController {
  private draggedSlot?: number;
  private draggedTab?: number;
  private draggedEquippedSlot?: number;
  private readonly handleDocumentDragOver = (event: DragEvent) => this.onDocumentDragOver(event);
  private readonly handleDocumentDrop = (event: DragEvent) => this.onDocumentDrop(event);

  constructor(private readonly host: DragHost) {
    document.addEventListener('dragover', this.handleDocumentDragOver, true);
    document.addEventListener('drop', this.handleDocumentDrop, true);
  }

  destroy() {
    document.removeEventListener('dragover', this.handleDocumentDragOver, true);
    document.removeEventListener('drop', this.handleDocumentDrop, true);
  }

  /** 当前拖拽的背包来源；物品消失（快照刷新）后自然失效。 */
  dragSource(): DragSource | undefined {
    if (this.draggedSlot === undefined || this.draggedTab === undefined) return undefined;
    const item = this.host.inventoryItemAt(this.draggedSlot, this.draggedTab);
    return item ? { tab: this.draggedTab, slot: this.draggedSlot, item } : undefined;
  }

  draggedEquipped(): InventoryItem | undefined {
    return this.draggedEquippedSlot === undefined ? undefined : this.host.equippedItemAt(this.draggedEquippedSlot);
  }

  isDragging() {
    return this.dragSource() !== undefined || this.draggedEquipped() !== undefined;
  }

  /** 绑定一个背包格的拖拽事件（dragstart/end/over/leave/drop）。 */
  bindInventorySlot(slot: HTMLButtonElement, slotNumber: number) {
    slot.addEventListener('dragstart', event => {
      const item = this.host.inventoryItemAt(slotNumber, this.host.selectedTab());
      if (!item || slot.disabled || this.host.scrollPending()) {
        event.preventDefault();
        return;
      }
      this.draggedEquippedSlot = undefined;
      this.draggedSlot = slotNumber;
      this.draggedTab = this.host.selectedTab();
      slot.classList.add('inventory-slot-dragging');
      const payload = JSON.stringify({ inventoryType: TAB_INVENTORY_TYPE[this.host.selectedTab()] ?? this.host.selectedTab() + 1, sourceSlot: slotNumber, itemId: item.itemId });
      event.dataTransfer?.setData('application/x-maple-inventory', payload);
      event.dataTransfer?.setData('text/plain', payload);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    slot.addEventListener('dragend', () => {
      slot.classList.remove('inventory-slot-dragging');
      this.clear();
    });
    slot.addEventListener('dragover', event => {
      const equippedSource = this.draggedEquipped();
      if (equippedSource) {
        // 已装备物品只能落回装备页签（卸下）。
        if (this.host.selectedTab() !== 0) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        slot.classList.add('inventory-slot-drag-target');
        return;
      }
      const source = this.dragSource();
      const target = this.host.inventoryItemAt(slotNumber, this.host.selectedTab());
      if (!source || !this.canDropOn(source)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      slot.classList.add('inventory-slot-drag-target');
    });
    slot.addEventListener('dragleave', () => slot.classList.remove('inventory-slot-drag-target'));
    slot.addEventListener('drop', event => {
      event.preventDefault();
      slot.classList.remove('inventory-slot-drag-target');
      const equippedSource = this.draggedEquipped();
      if (equippedSource && this.host.selectedTab() === 0) {
        this.host.unequip(equippedSource);
        this.clear();
        return;
      }
      const source = this.dragSource();
      const target = this.host.inventoryItemAt(slotNumber, this.host.selectedTab());
      if (source && this.canDropOn(source)) {
        this.host.moveItem(source.tab, source.slot, slotNumber);
      }
      this.clear();
    });
  }

  /** 绑定一个装备槽的拖拽事件（拖出卸下 / 接收装备与卷轴）。 */
  bindEquipmentSlot(button: HTMLButtonElement, slotNumber: number) {
    button.addEventListener('dragstart', event => {
      const item = this.host.equippedItemAt(slotNumber);
      if (!item || this.host.scrollPending()) {
        event.preventDefault();
        return;
      }
      this.draggedSlot = undefined;
      this.draggedTab = undefined;
      this.draggedEquippedSlot = slotNumber;
      button.classList.add('equipment-slot-dragging');
      const payload = JSON.stringify({ inventoryType: 1, sourceSlot: -Math.abs(item.slot), itemId: item.itemId });
      event.dataTransfer?.setData('application/x-maple-inventory', payload);
      event.dataTransfer?.setData('text/plain', payload);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    button.addEventListener('dragend', () => {
      button.classList.remove('equipment-slot-dragging', 'equipment-slot-drag-target');
      this.clear();
    });
    button.addEventListener('dragover', event => {
      const source = this.dragSource();
      const target = this.host.equippedItemAt(slotNumber);
      if (!source || !this.canDropOnEquipment(source, target)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      button.classList.add('equipment-slot-drag-target');
    });
    button.addEventListener('dragleave', () => button.classList.remove('equipment-slot-drag-target'));
    button.addEventListener('drop', event => {
      event.preventDefault();
      button.classList.remove('equipment-slot-drag-target');
      const source = this.dragSource();
      const target = this.host.equippedItemAt(slotNumber);
      if (source && this.canDropOnEquipment(source, target)) {
        if (this.host.isScroll(source.item)) {
          this.host.useScrollOnEquipment(source.tab, source.slot, source.item, -slotNumber, target);
        } else {
          // Equipment use resolves its authoritative body slot from the item
          // definition; the visual target is only the original drag affordance.
          this.host.useItem(source.tab, source.slot, source.item);
        }
      }
      this.clear();
    });
  }

  /** 同页签内移动；跨页签 drop 一律忽略（与原实现一致）。 */
  private canDropOn(source: DragSource) {
    return source.tab === this.host.selectedTab();
  }

  /** 卷轴必须落在已装备槽；其余物品只接受装备类道具作为来源。 */
  private canDropOnEquipment(source: DragSource, target: InventoryItem | undefined) {
    if (this.host.isScroll(source.item)) return Boolean(target);
    return itemCategoryTab(source.item.itemId) === 0;
  }

  private onDocumentDragOver(event: DragEvent) {
    if (!this.host.windowOpen() || !this.isDragging()) return;
    const target = event.target;
    if (target instanceof Node && this.host.containsTarget(target)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }

  private onDocumentDrop(event: DragEvent) {
    if (!this.host.windowOpen()) return;
    const source = this.dragSource();
    const equippedSource = this.draggedEquipped();
    if (!source && !equippedSource) return;
    const target = event.target;
    if (target instanceof Node && this.host.containsTarget(target)) return;
    event.preventDefault();
    if (equippedSource) this.host.unequip(equippedSource);
    else if (source) this.host.dropItem(source.tab, source.slot);
    this.clear();
  }

  /** 清空拖拽来源状态并移除全部拖拽高亮（原 `clearDragState`）。 */
  clear() {
    this.draggedSlot = undefined;
    this.draggedTab = undefined;
    this.draggedEquippedSlot = undefined;
    this.host.clearDragMarks();
  }
}
