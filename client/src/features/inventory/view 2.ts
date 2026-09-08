import type { ClientMessage, InventoryItem, PlayerState, ServerMessage } from '../../../../shared/protocol';
import type { AssetFrame, Manifest } from '../../assets/manifest';
import { protocolText, uiLocale, uiText } from '../../app/i18n';
import { itemCategoryTab, itemDetails, itemName } from './names';

const WINDOW_SMALL = { width: 175, height: 289 } as const;
const WINDOW_FULL = { width: 603, height: 289 } as const;
const SLOT_COLUMNS = 4;
const SLOT_ROWS = 6;
const SLOT_LIMIT = SLOT_COLUMNS * SLOT_ROWS;
const FULL_SLOT_COUNT = SLOT_LIMIT * 4;
const SLOT_GRID = { left: 7, top: 50, columnStep: 36, rowStep: 34, width: 32, height: 32 } as const;
const FULL_GROUP_STEP = 149;
const MIN_DROP_MESOS = 10;
const MAX_DROP_MESOS = 50_000;
const EQUIP_SLOT_POSITIONS: Readonly<Record<number, readonly [number, number]>> = Object.freeze({
  1: [38, 35],
  2: [38, 69],
  3: [70, 102],
  4: [104, 102],
  5: [38, 134],
  6: [38, 200],
  7: [70, 234],
  8: [4, 167],
  9: [4, 134],
  10: [138, 134],
  11: [104, 134],
  12: [104, 167],
  13: [138, 167],
  15: [104, 69],
  16: [138, 69],
  17: [70, 134],
  18: [104, 234],
  19: [4, 234],
  49: [4, 69],
  50: [70, 167],
});
const TAB_COUNT = 5;
const TAB_LABEL_KEYS = ['inventoryEquip', 'inventoryUse', 'inventorySetup', 'inventoryEtc', 'inventoryCash'] as const;

type InventoryPlayer = Pick<PlayerState, 'inventory' | 'mesos'> & { equipped?: InventoryItem[] };
type AssetSet = Record<string, AssetFrame>;
type SendClientMessage = (message: ClientMessage) => boolean;
type UseItemMessage = Extract<ClientMessage, { type: 'useItem' }>;

interface DragSource {
  tab: number;
  slot: number;
  item: InventoryItem;
}

interface PendingScroll {
  sourceTab: number;
  sourceSlot: number;
  item: InventoryItem;
}

/**
 * Source-backed GMS83 UIWindow.img/Item window.
 *
 * The small source background is 175x289 with a 4x6 grid. FullBackgrnd is
 * 603x289 and contains four consecutive 24-slot blocks. The grid is placed
 * from the source pixels rather than laid out with an approximate CSS grid so
 * icons continue to line up with both exported backgrounds.
 */
export class InventoryView {
  private readonly ui?: Manifest['inventoryUi'];
  private readonly closeAssets?: Manifest['closeButton'];
  private readonly root: HTMLDivElement;
  private readonly window?: HTMLDivElement;
  private readonly background?: HTMLImageElement;
  private readonly grid?: HTMLDivElement;
  private readonly tabs?: HTMLDivElement;
  private readonly tabsViewport?: HTMLDivElement;
  private readonly tabPrev?: HTMLButtonElement;
  private readonly tabNext?: HTMLButtonElement;
  private readonly mesosLine?: HTMLDivElement;
  private readonly tooltip?: HTMLDivElement;
  private readonly targetPrompt?: HTMLDivElement;
  private readonly equipmentWindow?: HTMLDivElement;
  private readonly equipmentCloseButton?: HTMLButtonElement;
  private readonly closeButton?: HTMLButtonElement;
  private readonly gatherButton?: HTMLButtonElement;
  private readonly sizeButton?: HTMLButtonElement;
  private readonly coinButton?: HTMLButtonElement;
  private readonly observer?: ResizeObserver;
  private readonly manifest: Manifest;
  private full = false;
  private openState = false;
  private selectedTab = 0;
  private inventory: InventoryPlayer['inventory'] = [];
  private equipped: InventoryItem[] = [];
  private mesos = 0;
  private slotsSignature = '';
  private draggedSlot?: number;
  private draggedTab?: number;
  private draggedEquippedSlot?: number;
  private windowPositioned = false;
  private equipmentWindowPositioned = false;
  private draggingWindow?: { pointerId: number; offsetX: number; offsetY: number; window: HTMLDivElement };
  private pendingScroll?: PendingScroll;
  private pendingUseRequestId?: string;
  private pendingInventoryOperation?: 'gather' | 'sort';
  private keepGatherResultMode = false;
  private sortMode = false;
  private requestSequence = 0;
  private destroyed = false;
  private equipmentOpenState = false;

  private readonly handleKeyDown = (event: KeyboardEvent) => this.onKeyDown(event);
  private readonly handleDocumentDragOver = (event: DragEvent) => this.onDocumentDragOver(event);
  private readonly handleDocumentDrop = (event: DragEvent) => this.onDocumentDrop(event);
  private readonly handleWindowPointerDown = (event: PointerEvent) => this.onWindowPointerDown(event);
  private readonly handleWindowPointerMove = (event: PointerEvent) => this.onWindowPointerMove(event);
  private readonly handleWindowPointerUp = (event: PointerEvent) => this.onWindowPointerUp(event);

  constructor(private host: HTMLElement, manifest: Manifest, private status: (message: string) => void, private send: SendClientMessage = () => false) {
    this.manifest = manifest;
    this.ui = manifest.inventoryUi;
    this.closeAssets = manifest.closeButton;
    this.root = document.createElement('div');
    this.root.className = 'ui-windows';
    this.root.hidden = true;
    this.root.dataset.open = 'false';
    this.host.replaceChildren(this.root);

    document.addEventListener('keydown', this.handleKeyDown, true);
    document.addEventListener('dragover', this.handleDocumentDragOver, true);
    document.addEventListener('drop', this.handleDocumentDrop, true);
    if (!this.ui?.backgrnd || !this.closeAssets?.['normal/0']) return;

    const inventoryWindow = document.createElement('div');
    inventoryWindow.className = 'inventory-window';
    inventoryWindow.setAttribute('role', 'dialog');
    inventoryWindow.setAttribute('aria-modal', 'false');
    inventoryWindow.setAttribute('aria-label', uiText('inventoryTitle', this.t('物品栏', 'Inventory')));
    inventoryWindow.tabIndex = -1;
    inventoryWindow.hidden = true;
    this.window = inventoryWindow;

    const background = document.createElement('img');
    background.className = 'inventory-window-background';
    background.src = this.ui.backgrnd.url;
    background.alt = '';
    background.draggable = false;
    background.setAttribute('aria-hidden', 'true');
    inventoryWindow.append(background);
    this.background = background;

    const title = document.createElement('span');
    title.className = 'inventory-window-title';
    title.textContent = uiText('inventoryTitle', this.t('物品栏', 'Inventory'));
    title.setAttribute('aria-hidden', 'true');
    inventoryWindow.append(title);

    const tabsViewport = document.createElement('div');
    tabsViewport.className = 'inventory-tabs-viewport';
    tabsViewport.style.left = '2px';
    tabsViewport.style.top = '21px';
    const tabs = document.createElement('div');
    tabs.className = 'inventory-tabs';
    tabs.style.position = 'relative';
    tabs.style.width = String(TAB_COUNT * 34) + 'px';
    for (let index = 0; index < TAB_COUNT; index++) this.createTab(tabs, index);
    tabsViewport.append(tabs);
    inventoryWindow.append(tabsViewport);
    this.tabs = tabs;
    this.tabsViewport = tabsViewport;
    this.tabPrev = this.createTabArrow(inventoryWindow, 'prev', this.t('上一页签', 'Previous tab'), -1);
    this.tabNext = this.createTabArrow(inventoryWindow, 'next', this.t('下一页签', 'Next tab'), 1);
    tabsViewport.addEventListener('scroll', () => this.updateTabOverflow());

    const grid = document.createElement('div');
    grid.className = 'inventory-grid';
    for (let index = 0; index < FULL_SLOT_COUNT; index++) this.createSlot(grid, index);
    inventoryWindow.append(grid);
    this.grid = grid;

    const mesosLine = document.createElement('div');
    mesosLine.className = 'inventory-mesos';
    mesosLine.setAttribute('aria-label', this.t('金币', 'Mesos'));
    inventoryWindow.append(mesosLine);
    this.mesosLine = mesosLine;

    const tooltip = document.createElement('div');
    tooltip.className = 'inventory-tooltip';
    tooltip.id = 'inventory-tooltip';
    tooltip.hidden = true;
    tooltip.setAttribute('role', 'tooltip');
    this.root.append(tooltip);
    this.tooltip = tooltip;

    const targetPrompt = document.createElement('div');
    targetPrompt.className = 'inventory-target-prompt';
    targetPrompt.hidden = true;
    targetPrompt.textContent = this.t('请选择要使用卷轴的装备。', 'Choose the equipment to use this scroll on.');
    targetPrompt.setAttribute('role', 'status');
    inventoryWindow.append(targetPrompt);
    this.targetPrompt = targetPrompt;

    const equipment = this.createEquipmentWindow();
    if (equipment) {
      this.equipmentWindow = equipment.window;
      this.equipmentCloseButton = equipment.close;
      this.root.append(equipment.window);
      equipment.window.addEventListener('pointerdown', this.handleWindowPointerDown);
      equipment.window.addEventListener('pointermove', this.handleWindowPointerMove);
      equipment.window.addEventListener('pointerup', this.handleWindowPointerUp);
      equipment.window.addEventListener('pointercancel', this.handleWindowPointerUp);
    }

    this.closeButton = this.createWindowButton(inventoryWindow, 'close', this.closeAssets, 'normal/0', () => this.close());
    this.gatherButton = this.createWindowButton(inventoryWindow, 'gather', this.ui, () => this.sortMode ? 'BtSort/normal/0' : 'BtGather/normal/0', () => this.inventoryAction(this.sortMode ? 'sort' : 'gather'));
    this.sizeButton = this.createWindowButton(inventoryWindow, 'size', this.ui, () => this.full ? 'BtSmall/normal/0' : 'BtFull/normal/0', () => this.setFull(!this.full, true));
    this.coinButton = this.createWindowButton(inventoryWindow, 'coin', this.ui, 'BtCoin/normal/0', () => this.dropMesos());

    inventoryWindow.addEventListener('pointerdown', this.handleWindowPointerDown);
    inventoryWindow.addEventListener('pointermove', this.handleWindowPointerMove);
    inventoryWindow.addEventListener('pointerup', this.handleWindowPointerUp);
    inventoryWindow.addEventListener('pointercancel', this.handleWindowPointerUp);
    this.root.append(inventoryWindow);

    this.observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => this.layout());
    this.observer?.observe(this.host);
    this.setFull(false, false);
    this.layout();
    this.updateTabOverflow();
    this.renderSlots();
    this.renderMesos();
    this.renderEquipment();
  }

  update(player: InventoryPlayer | undefined) {
    if (!this.window) return;
    if (!player) {
      this.clear();
      return;
    }
    this.inventory = player.inventory.slice();
    this.equipped = (player.equipped ?? []).slice();
    this.mesos = Math.max(0, Math.floor(player.mesos));
    this.root.dataset.inventory = this.inventory
      .map(item => String(itemCategoryTab(item.itemId) + 1) + ':' + item.slot + ':' + item.itemId + ':' + item.quantity)
      .join(',');
    this.root.dataset.mesos = String(this.mesos);
    this.root.dataset.tab = String(this.selectedTab);
    this.renderMesos();
    const signature = this.inventory
      .slice()
      .sort((left, right) => itemCategoryTab(left.itemId) - itemCategoryTab(right.itemId) || left.slot - right.slot)
      .map(item => String(itemCategoryTab(item.itemId)) + ':' + item.slot + ':' + JSON.stringify(item))
      .concat(this.equipped.map(item => 'equipped:' + item.slot + ':' + JSON.stringify(item)))
      .join('|');
    if (signature !== this.slotsSignature) {
      if (!this.keepGatherResultMode) this.sortMode = false;
      this.keepGatherResultMode = false;
      this.slotsSignature = signature;
      this.renderSlots();
      this.refreshGatherButton();
    }
    if (this.pendingScroll && !this.itemAt(this.pendingScroll.sourceSlot, this.pendingScroll.sourceTab)) {
      this.cancelScrollTarget(false);
    }
  }

  open() {
    if (!this.window || this.destroyed) return;
    this.openState = true;
    this.root.hidden = false;
    this.root.dataset.open = 'true';
    this.window.hidden = false;
    this.layout();
    const selected = this.tabs?.querySelector<HTMLButtonElement>('[data-tab="' + this.selectedTab + '"]');
    if (selected) requestAnimationFrame(() => selected.focus({ preventScroll: true }));
  }

  private openEquipment() {
    if (!this.equipmentWindow || this.destroyed) return;
    this.equipmentOpenState = true;
    this.root.hidden = false;
    this.root.dataset.open = 'true';
    this.equipmentWindow.hidden = false;
    this.renderEquipment();
    this.layout();
    requestAnimationFrame(() => this.equipmentCloseButton?.focus({ preventScroll: true }));
  }

  close() {
    const wasOpen = this.openState;
    this.openState = false;
    this.cancelScrollTarget(false);
    this.pendingUseRequestId = undefined;
    this.clearDragState();
    if (this.window) this.window.hidden = true;
    if (!this.equipmentOpenState) {
      this.root.hidden = true;
      this.root.dataset.open = 'false';
    }
    this.hideTooltip();
    if (wasOpen) this.focusGame();
  }

  private closeEquipment(restoreFocus = true) {
    const wasOpen = this.equipmentOpenState;
    this.equipmentOpenState = false;
    const hadPendingScroll = Boolean(this.pendingScroll);
    this.pendingScroll = undefined;
    this.pendingUseRequestId = undefined;
    if (this.equipmentWindow) this.equipmentWindow.hidden = true;
    this.updateTargetMode();
    if (!this.openState) {
      this.root.hidden = true;
      this.root.dataset.open = 'false';
    }
    this.hideTooltip();
    if (hadPendingScroll && restoreFocus) this.status(this.t('已取消卷轴使用。', 'Scroll use cancelled.'));
    if (wasOpen && restoreFocus) this.focusGame();
  }

  /** Toggles the source-backed Equip window (the original E shortcut). */
  toggleEquipment() {
    if (this.equipmentOpenState) this.closeEquipment();
    else this.openEquipment();
  }

  toggle() {
    if (this.openState) this.close();
    else this.open();
  }

  clear() {
    this.inventory = [];
    this.equipped = [];
    this.mesos = 0;
    this.slotsSignature = '';
    this.root.dataset.inventory = '';
    this.root.dataset.mesos = '0';
    this.hideTooltip();
    this.renderMesos();
    this.renderEquipment();
    this.renderSlots();
    this.close();
    this.closeEquipment(false);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.observer?.disconnect();
    document.removeEventListener('keydown', this.handleKeyDown, true);
    document.removeEventListener('dragover', this.handleDocumentDragOver, true);
    document.removeEventListener('drop', this.handleDocumentDrop, true);
    this.window?.removeEventListener('pointerdown', this.handleWindowPointerDown);
    this.window?.removeEventListener('pointermove', this.handleWindowPointerMove);
    this.window?.removeEventListener('pointerup', this.handleWindowPointerUp);
    this.window?.removeEventListener('pointercancel', this.handleWindowPointerUp);
    this.equipmentWindow?.removeEventListener('pointerdown', this.handleWindowPointerDown);
    this.equipmentWindow?.removeEventListener('pointermove', this.handleWindowPointerMove);
    this.equipmentWindow?.removeEventListener('pointerup', this.handleWindowPointerUp);
    this.equipmentWindow?.removeEventListener('pointercancel', this.handleWindowPointerUp);
    this.root.remove();
    this.host.replaceChildren();
  }

  private createTab(parent: HTMLDivElement, index: number) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'inventory-tab';
    button.dataset.tab = String(index);
    button.style.left = String(index * 34) + 'px';
    const label = uiText(TAB_LABEL_KEYS[index], this.t('物品栏分页 ' + (index + 1), 'Inventory tab ' + (index + 1)));
    button.setAttribute('aria-label', label);
    button.title = label;
    button.addEventListener('click', () => {
      this.selectedTab = index;
      this.sortMode = false;
      this.keepGatherResultMode = false;
      this.pendingInventoryOperation = undefined;
      this.refreshGatherButton();
      this.root.dataset.tab = String(index);
      this.updateTabs();
      this.renderSlots();
      this.renderEquipment();
      this.status(label);
    });
    parent.append(button);
    this.updateTab(button, index);
  }

  private updateTabs() {
    this.tabs?.querySelectorAll<HTMLButtonElement>('.inventory-tab').forEach(button => {
      this.updateTab(button, Number(button.dataset.tab));
    });
  }

  private createTabArrow(parent: HTMLDivElement, direction: 'prev' | 'next', label: string, amount: number) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'inventory-tab-arrow inventory-tab-arrow-' + direction;
    button.textContent = direction === 'prev' ? '‹' : '›';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.hidden = true;
    button.addEventListener('click', () => {
      this.tabsViewport?.scrollBy({ left: amount * 68, behavior: 'smooth' });
    });
    parent.append(button);
    return button;
  }

  private updateTabOverflow() {
    const viewport = this.tabsViewport;
    if (!viewport || !this.tabPrev || !this.tabNext) return;
    const overflow = viewport.scrollWidth > viewport.clientWidth + 1;
    this.tabPrev.hidden = !overflow;
    this.tabNext.hidden = !overflow;
    this.tabPrev.disabled = !overflow || viewport.scrollLeft <= 1;
    this.tabNext.disabled = !overflow || viewport.scrollLeft + viewport.clientWidth >= viewport.scrollWidth - 1;
  }

  private updateTab(button: HTMLButtonElement, index: number) {
    const state = index === this.selectedTab ? 'enabled' : 'disabled';
    button.dataset.state = state;
    button.replaceChildren();
    const tabUi = this.manifest.tabUi;
    const stateSuffix = state === 'enabled' ? '1' : '0';
    const fill = tabUi?.['fill' + stateSuffix];
    if (fill) button.append(this.assetImage(fill, 'inventory-tab-fill'));
    const left = tabUi?.['left' + stateSuffix];
    if (left) button.append(this.assetImage(left, 'inventory-tab-left'));
    const middle = index !== TAB_COUNT - 1 ? tabUi?.['middle' + stateSuffix] : undefined;
    if (middle) button.append(this.assetImage(middle, 'inventory-tab-middle'));
    const right = tabUi?.['right' + stateSuffix];
    if (right) button.append(this.assetImage(right, 'inventory-tab-right'));
    const text = document.createElement('span');
    text.className = 'inventory-tab-label-text';
    text.textContent = uiText(TAB_LABEL_KEYS[index], this.t('分页 ' + (index + 1), 'Tab ' + (index + 1)));
    text.setAttribute('aria-hidden', 'true');
    button.append(text);
  }

  private createSlot(parent: HTMLDivElement, index: number) {
    const slotNumber = index + 1;
    const slot = document.createElement('button');
    slot.type = 'button';
    slot.className = 'inventory-slot';
    slot.dataset.slot = String(slotNumber);
    slot.addEventListener('click', () => this.handleSlotClick(slotNumber));
    slot.addEventListener('dblclick', () => this.handleDoubleClick(slotNumber));
    slot.addEventListener('contextmenu', event => {
      event.preventDefault();
      if (this.pendingScroll) {
        this.status(this.t('请在装备栏中选择目标装备。', 'Choose the target equipment in the Equip window.'));
        return;
      }
      if (this.itemAt(slotNumber)) this.dropSlot(this.selectedTab, slotNumber);
    });
    slot.addEventListener('pointerenter', () => this.showSlotTooltip(slotNumber));
    slot.addEventListener('pointermove', () => this.positionTooltip(slot));
    slot.addEventListener('pointerleave', () => this.hideTooltip());
    slot.addEventListener('focus', () => this.showSlotTooltip(slotNumber));
    slot.addEventListener('blur', () => this.hideTooltip());
    slot.addEventListener('dragstart', event => {
      const item = this.itemAt(slotNumber);
      if (!item || slot.disabled || this.pendingScroll) {
        event.preventDefault();
        return;
      }
      this.draggedEquippedSlot = undefined;
      this.draggedSlot = slotNumber;
      this.draggedTab = this.selectedTab;
      slot.classList.add('inventory-slot-dragging');
      const payload = JSON.stringify({ inventoryType: this.selectedTab + 1, sourceSlot: slotNumber, itemId: item.itemId });
      event.dataTransfer?.setData('application/x-maple-inventory', payload);
      event.dataTransfer?.setData('text/plain', payload);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    slot.addEventListener('dragend', () => {
      slot.classList.remove('inventory-slot-dragging');
      this.clearDragState();
    });
    slot.addEventListener('dragover', event => {
      const equippedSource = this.draggedEquippedItem();
      if (equippedSource) {
        if (this.selectedTab !== 0) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        slot.classList.add('inventory-slot-drag-target');
        return;
      }
      const source = this.dragSource();
      const target = this.itemAt(slotNumber);
      if (!source || !this.canDropOn(source, target)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      slot.classList.add('inventory-slot-drag-target');
    });
    slot.addEventListener('dragleave', () => slot.classList.remove('inventory-slot-drag-target'));
    slot.addEventListener('drop', event => {
      event.preventDefault();
      slot.classList.remove('inventory-slot-drag-target');
      const equippedSource = this.draggedEquippedItem();
      if (equippedSource && this.selectedTab === 0) {
        this.unequip(equippedSource);
        this.clearDragState();
        return;
      }
      const source = this.dragSource();
      const target = this.itemAt(slotNumber);
      if (source && this.canDropOn(source, target)) {
        this.moveSlot(source.tab, source.slot, slotNumber);
      }
      this.clearDragState();
    });
    parent.append(slot);
  }

  private handleSlotClick(slotNumber: number) {
    if (this.pendingScroll) {
      this.status(this.t('请在装备栏中选择目标装备。', 'Choose the target equipment in the Equip window.'));
      return;
    }
    const item = this.itemAt(slotNumber);
    if (item) this.status(this.t('已选择道具 ', 'Selected ') + this.itemLabel(item));
  }

  private handleDoubleClick(slotNumber: number) {
    if (this.pendingScroll) {
      this.status(this.t('请在装备栏中选择目标装备。', 'Choose the target equipment in the Equip window.'));
      return;
    }
    const item = this.itemAt(slotNumber);
    if (!item) return;
    if (this.isScroll(item)) {
      this.beginScrollTarget(this.selectedTab, slotNumber, item);
      return;
    }
    if (this.isAmmo(item)) {
      this.status(this.t('箭矢不能直接使用。', 'Arrows cannot be used directly.'));
      return;
    }
    this.submitUseItem(this.selectedTab, slotNumber, item);
  }

  private renderSlots() {
    if (!this.grid) return;
    this.grid.dataset.tab = String(this.selectedTab);
    const slots = Array.from(this.grid.querySelectorAll<HTMLButtonElement>('.inventory-slot'));
    for (const slot of slots) {
      const slotNumber = Number(slot.dataset.slot);
      const item = this.itemAt(slotNumber);
      const fullOnly = slotNumber > SLOT_LIMIT;
      const visible = this.full || !fullOnly;
      const available = visible && (slotNumber <= SLOT_LIMIT || Boolean(item));
      const targetable = false;
      slot.hidden = !visible;
      slot.disabled = !available;
      slot.replaceChildren();
      slot.draggable = Boolean(item) && available;
      slot.classList.toggle('inventory-slot-occupied', Boolean(item));
      slot.classList.toggle('inventory-slot-disabled', !available);
      slot.classList.toggle('inventory-slot-targetable', targetable);
      slot.setAttribute('aria-disabled', available ? 'false' : 'true');
      slot.setAttribute('aria-label', item
        ? this.t('道具 ' + itemName(item.itemId) + this.itemQuantity(item), 'Item ' + itemName(item.itemId) + this.itemQuantity(item))
        : this.t('物品栏空槽 ' + slotNumber, 'Inventory slot ' + slotNumber + ' is empty'));
      if (item) slot.dataset.itemId = item.itemId;
      else delete slot.dataset.itemId;

      if (!item) {
        if (this.fullOnlyDisabled(slotNumber)) this.appendDisabled(slot);
        continue;
      }
      const frame = this.manifest.items?.[item.itemId];
      if (!frame) continue;
      const icon = this.assetImage(frame, 'inventory-item-icon');
      icon.alt = itemName(item.itemId);
      icon.setAttribute('aria-hidden', 'true');
      slot.append(icon);
      if (itemCategoryTab(item.itemId) !== 0 && item.quantity > 1) {
        const quantity = document.createElement('span');
        quantity.className = 'inventory-item-quantity';
        quantity.textContent = String(Math.max(0, Math.floor(item.quantity)));
        quantity.setAttribute('aria-hidden', 'true');
        slot.append(quantity);
      }
    }
    this.renderEquipment();
  }

  private receiveInventoryResult(message: Extract<ServerMessage, { type: 'inventoryResult' | 'inventoryDropResult' }>) {
    if (!message.success) {
      if (this.pendingUseRequestId === message.requestId) {
        this.pendingUseRequestId = undefined;
        this.cancelScrollTarget(false);
      }
      this.status(this.localizedError(message.code));
      return;
    }
    if (this.pendingUseRequestId === message.requestId) {
      this.pendingUseRequestId = undefined;
      this.cancelScrollTarget(false);
    }
    if (message.operation === 'gather' || message.operation === 'sort') {
      this.pendingInventoryOperation = undefined;
      this.sortMode = message.operation === 'gather';
      this.keepGatherResultMode = message.operation === 'gather';
      this.refreshGatherButton();
    }
    if (message.code === 'scroll_success' || message.code === 'scroll_failed') {
      this.status(protocolText(message.code, message.code));
      return;
    }
    const item = message.itemId ? itemName(message.itemId) : this.t('道具', 'item');
    const quantity = Math.max(0, Math.floor(message.quantity));
    switch (message.operation) {
      case 'drop':
        this.status(this.t('已丢弃 ' + item + ' × ' + quantity, 'Dropped ' + item + ' × ' + quantity));
        break;
      case 'move':
        this.status(this.t('已移动 ' + item + ' × ' + quantity, 'Moved ' + item + ' × ' + quantity));
        break;
      case 'gather':
        this.status(this.t('已合并相同道具。', 'Matching item stacks were merged.'));
        break;
      case 'sort':
        this.status(this.t('已整理物品栏。', 'Inventory sorted.'));
        break;
      case 'use':
        this.status(this.t('已使用 ' + item + '。', 'Used ' + item + '.'));
        break;
      case 'equip':
        this.status(this.t('已装备 ' + item + '。', 'Equipped ' + item + '.'));
        break;
      case 'unequip':
        this.status(this.t('已卸下 ' + item + '。', 'Unequipped ' + item + '.'));
        break;
      case 'dropMesos':
        this.status(this.t('已丢弃金币 × ' + quantity, 'Dropped ' + quantity + ' mesos.'));
        break;
    }
  }

  receive(message: ServerMessage) {
    if (message.type === 'pickupResult') {
      const picked = itemName(message.itemId) + ' × ' + message.quantity;
      const slot = message.slot ? this.t('（第 ' + message.slot + ' 格）', ' (slot ' + message.slot + ')') : '';
      this.status(this.t('已拾取 ' + picked + slot, 'Picked up ' + picked + slot));
      return;
    }
    if (message.type === 'inventoryResult' || message.type === 'inventoryDropResult') {
      this.receiveInventoryResult(message);
    }
  }

  private itemAt(slot: number, tab = this.selectedTab) {
    return this.inventory.find(item => item.slot === slot && itemCategoryTab(item.itemId) === tab);
  }

  private visibleItemAt(slot: number) {
    return this.itemAt(slot, this.selectedTab);
  }

  private dragSource(): DragSource | undefined {
    if (this.draggedSlot === undefined || this.draggedTab === undefined) return undefined;
    const item = this.itemAt(this.draggedSlot, this.draggedTab);
    return item ? { tab: this.draggedTab, slot: this.draggedSlot, item } : undefined;
  }

  private draggedEquippedItem() {
    return this.draggedEquippedSlot === undefined ? undefined : this.equippedAt(this.draggedEquippedSlot);
  }

  private canDropOn(source: DragSource, target: InventoryItem | undefined) {
    if (source.tab === this.selectedTab) return true;
    return false;
  }

  private moveSlot(sourceTab: number, sourceSlot: number, targetSlot: number) {
    const item = this.itemAt(sourceSlot, sourceTab);
    const maxSlot = this.full ? FULL_SLOT_COUNT : SLOT_LIMIT;
    if (!item || sourceSlot < 1 || sourceSlot > maxSlot || targetSlot < 1 || targetSlot > maxSlot) return;
    if (!this.send({
      type: 'inventoryMove',
      requestId: this.requestId('move'),
      inventoryType: sourceTab + 1,
      sourceSlot,
      targetSlot,
      quantity: item.quantity,
    })) {
      this.status(this.t('物品栏操作需要保持在线。', 'Inventory actions require an online connection.'));
      return;
    }
    this.status(this.t('正在移动 ' + this.itemLabel(item) + '…', 'Moving ' + this.itemLabel(item) + '…'));
  }

  private dropSlot(sourceTab: number, sourceSlot: number) {
    const item = this.itemAt(sourceSlot, sourceTab);
    if (!item) return;
    let quantity = Math.max(0, Math.floor(item.quantity));
    if (quantity > 1) {
      const answer = window.prompt(
        this.t('丢弃 ' + itemName(item.itemId) + ' 的数量（1-' + quantity + '）', 'How many ' + itemName(item.itemId) + ' should be dropped? (1-' + quantity + ')'),
        String(quantity),
      );
      if (answer === null) return;
      quantity = Number(answer);
      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > item.quantity) {
        this.status(this.t('丢弃数量无效。', 'Invalid drop quantity.'));
        return;
      }
    }
    if (!this.send({
      type: 'dropItem',
      requestId: this.requestId('drop'),
      inventoryType: sourceTab + 1,
      sourceSlot,
      quantity,
    })) {
      this.status(this.t('物品栏操作需要保持在线。', 'Inventory actions require an online connection.'));
      return;
    }
    this.status(this.t('正在丢弃 ' + itemName(item.itemId) + ' × ' + quantity + '…', 'Dropping ' + itemName(item.itemId) + ' × ' + quantity + '…'));
  }

  private inventoryAction(operation: 'gather' | 'sort') {
    if (this.pendingInventoryOperation) {
      this.status(this.t('正在整理物品栏，请稍候。', 'Inventory action is already in progress.'));
      return;
    }
    const message: ClientMessage = {
      type: operation === 'gather' ? 'inventoryGather' : 'inventorySort',
      requestId: this.requestId(operation),
      inventoryType: this.selectedTab + 1,
    };
    if (!this.send(message)) {
      this.status(this.t('物品栏操作需要保持在线。', 'Inventory actions require an online connection.'));
      return;
    }
    this.pendingInventoryOperation = operation;
    this.status(operation === 'gather'
      ? this.t('正在合并相同道具…', 'Merging matching item stacks…')
      : this.t('正在整理物品栏…', 'Sorting inventory…'));
  }

  private submitUseItem(sourceTab: number, sourceSlot: number, item: InventoryItem, targetSlot?: number, targetItem?: InventoryItem) {
    if (this.pendingUseRequestId) {
      this.status(this.t('正在等待上一次卷轴操作。', 'Waiting for the previous scroll action.'));
      return;
    }
    const requestId = this.requestId('use');
    const base = {
      type: 'useItem' as const,
      requestId,
      inventoryType: sourceTab + 1,
      sourceSlot,
      itemId: item.itemId,
    };
    const message: UseItemMessage = targetSlot === undefined
      ? base
      : { ...base, targetSlot, targetItemId: targetItem?.itemId ?? '' };
    if (!this.send(message)) {
      this.status(this.t('物品栏操作需要保持在线。', 'Inventory actions require an online connection.'));
      return;
    }
    if (targetSlot !== undefined && this.pendingScroll) {
      this.pendingUseRequestId = requestId;
    } else {
      this.pendingScroll = undefined;
      this.updateTargetMode();
    }
    if (targetSlot === undefined) {
      this.status(this.t('正在使用 ' + itemName(item.itemId) + '…', 'Using ' + itemName(item.itemId) + '…'));
    } else {
      this.status(this.t('正在对 ' + itemName(targetItem?.itemId ?? '') + ' 使用 ' + itemName(item.itemId) + '…', 'Using ' + itemName(item.itemId) + ' on ' + itemName(targetItem?.itemId ?? '') + '…'));
    }
  }

  private beginScrollTarget(sourceTab: number, sourceSlot: number, item: InventoryItem) {
    this.pendingScroll = { sourceTab, sourceSlot, item };
    this.updateTargetMode();
    this.status(this.t('请选择要使用卷轴的装备。', 'Choose the equipment to use this scroll on.'));
  }

  private cancelScrollTarget(notify: boolean) {
    if (!this.pendingScroll) return;
    this.pendingScroll = undefined;
    this.updateTargetMode();
    if (notify) this.status(this.t('已取消卷轴使用。', 'Scroll use cancelled.'));
  }

  private updateTargetMode() {
    const selecting = Boolean(this.pendingScroll);
    this.window?.classList.toggle('inventory-selecting-target', selecting);
    if (this.targetPrompt) this.targetPrompt.hidden = !selecting;
    if (selecting) this.openEquipment();
    this.renderEquipment();
  }

  private dropMesos() {
    if (this.mesos < MIN_DROP_MESOS) {
      this.status(this.t('至少需要 10 金币才能丢弃。', 'At least 10 mesos are required to drop mesos.'));
      return;
    }
    const answer = window.prompt(
      this.t('丢弃金币数量（10-' + Math.min(this.mesos, MAX_DROP_MESOS).toLocaleString('zh-CN') + '）', 'How many mesos should be dropped? (10-' + Math.min(this.mesos, MAX_DROP_MESOS).toLocaleString('en-US') + ')'),
      String(Math.min(this.mesos, MAX_DROP_MESOS)),
    );
    if (answer === null) return;
    const quantity = Number(answer);
    if (!Number.isSafeInteger(quantity) || quantity < MIN_DROP_MESOS || quantity > MAX_DROP_MESOS || quantity > this.mesos) {
      this.status(this.t('金币数量无效。', 'Invalid mesos quantity.'));
      return;
    }
    if (!this.send({
      type: 'dropMesos',
      requestId: this.requestId('mesos'),
      quantity,
    })) {
      this.status(this.t('物品栏操作需要保持在线。', 'Inventory actions require an online connection.'));
      return;
    }
    this.status(this.t('正在丢弃金币 × ' + quantity + '…', 'Dropping ' + quantity + ' mesos…'));
  }

  private renderMesos() {
    if (!this.mesosLine) return;
    this.mesosLine.replaceChildren();
    const value = document.createElement('span');
    value.className = 'inventory-mesos-value';
    value.textContent = this.mesos.toLocaleString(uiLocale() === 'en' ? 'en-US' : 'zh-CN');
    this.mesosLine.append(value);
  }

  private renderEquipment() {
    const equipmentWindow = this.equipmentWindow;
    if (!equipmentWindow) return;
    const selecting = Boolean(this.pendingScroll);
    equipmentWindow.classList.toggle('equipment-selecting-target', selecting);
    equipmentWindow.querySelectorAll<HTMLButtonElement>('.equipment-slot').forEach(button => {
      const slotNumber = Number(button.dataset.slot);
      const item = this.equippedAt(slotNumber);
      button.replaceChildren();
      button.disabled = false;
      button.draggable = Boolean(item);
      button.classList.toggle('equipment-slot-occupied', Boolean(item));
      button.classList.toggle('equipment-slot-targetable', selecting && Boolean(item));
      if (item) {
        button.dataset.itemId = item.itemId;
        button.title = itemDetails(item.itemId, item);
        button.setAttribute('aria-label', selecting
          ? this.t('对 ' + itemName(item.itemId) + ' 使用卷轴', 'Use the scroll on ' + itemName(item.itemId))
          : this.t('已装备 ' + itemName(item.itemId) + '（双击卸下）', itemName(item.itemId) + ' equipped (double-click to unequip)'));
        const frame = this.manifest.items?.[item.itemId];
        if (frame) {
          const icon = this.assetImage(frame, 'inventory-item-icon');
          icon.alt = itemName(item.itemId);
          icon.setAttribute('aria-hidden', 'true');
          button.append(icon);
        }
      } else {
        delete button.dataset.itemId;
        button.title = selecting
          ? this.t('将装备拖到此槽位', 'Drop equipment here')
          : this.t('空装备槽', 'Empty equipment slot');
        button.setAttribute('aria-label', button.title);
      }
    });
  }

  private createEquipmentWindow(): { window: HTMLDivElement; close: HTMLButtonElement } | undefined {
    const ui = this.manifest.equipmentUi;
    const backgroundFrame = ui?.backgrnd;
    if (!backgroundFrame || !this.closeAssets) return undefined;
    const equipmentWindow = document.createElement('div');
    equipmentWindow.className = 'equipment-window';
    equipmentWindow.setAttribute('role', 'dialog');
    equipmentWindow.setAttribute('aria-modal', 'false');
    equipmentWindow.setAttribute('aria-label', this.t('装备栏', 'Equip Inventory'));
    equipmentWindow.tabIndex = -1;
    equipmentWindow.hidden = true;

    const background = this.assetImage(backgroundFrame, 'equipment-window-background');
    background.alt = '';
    background.setAttribute('aria-hidden', 'true');
    equipmentWindow.append(background);
    const title = document.createElement('span');
    title.className = 'equipment-window-title';
    title.textContent = this.t('装备栏', 'Equip Inventory');
    title.setAttribute('aria-hidden', 'true');
    equipmentWindow.append(title);
    for (const slotNumber of Object.keys(EQUIP_SLOT_POSITIONS).map(Number)) {
      this.createEquipmentSlot(equipmentWindow, slotNumber);
    }
    const close = this.createWindowButton(equipmentWindow, 'close', this.closeAssets, 'normal/0', () => this.closeEquipment());
    close?.setAttribute('aria-label', this.t('关闭装备栏', 'Close equip inventory'));
    if (close) close.title = this.t('关闭装备栏', 'Close equip inventory');
    if (close) {
      close.title = this.t('关闭装备栏', 'Close equipment inventory');
      close.setAttribute('aria-label', close.title);
    }
    this.positionWindowButton(close, 157, 8);
    return close ? { window: equipmentWindow, close } : undefined;
  }

  private createEquipmentSlot(parent: HTMLDivElement, slotNumber: number) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'equipment-slot';
    button.dataset.slot = String(slotNumber);
    const position = EQUIP_SLOT_POSITIONS[slotNumber];
    if (position) {
      button.style.left = position[0] + 'px';
      button.style.top = position[1] + 'px';
    }
    button.addEventListener('click', () => {
      const item = this.equippedAt(slotNumber);
      const pending = this.pendingScroll;
      if (pending) {
        if (item) this.submitUseItem(pending.sourceTab, pending.sourceSlot, pending.item, -slotNumber, item);
        else this.status(this.t('请选择一个已装备的目标。', 'Choose an occupied equipment slot.'));
      } else if (item) {
        this.status(this.t('已选择装备 ' + this.itemLabel(item), 'Selected equipment ' + this.itemLabel(item)));
      }
    });
    button.addEventListener('dblclick', () => {
      if (!this.pendingScroll) {
        const item = this.equippedAt(slotNumber);
        if (item) this.unequip(item);
      }
    });
    button.addEventListener('contextmenu', event => {
      event.preventDefault();
      const item = this.equippedAt(slotNumber);
      const pending = this.pendingScroll;
      if (pending) {
        if (item) this.submitUseItem(pending.sourceTab, pending.sourceSlot, pending.item, -slotNumber, item);
      } else if (item) {
        this.unequip(item);
      }
    });
    button.addEventListener('pointerenter', () => {
      const item = this.equippedAt(slotNumber);
      if (item) this.showTooltipForItem(item, button);
    });
    button.addEventListener('pointermove', () => this.positionTooltip(button));
    button.addEventListener('pointerleave', () => this.hideTooltip());
    button.addEventListener('focus', () => {
      const item = this.equippedAt(slotNumber);
      if (item) this.showTooltipForItem(item, button);
    });
    button.addEventListener('blur', () => this.hideTooltip());
    button.addEventListener('dragstart', event => {
      const item = this.equippedAt(slotNumber);
      if (!item || this.pendingScroll) {
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
      this.clearDragState();
    });
    button.addEventListener('dragover', event => {
      const source = this.dragSource();
      const target = this.equippedAt(slotNumber);
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
      const target = this.equippedAt(slotNumber);
      if (source && this.canDropOnEquipment(source, target)) {
        if (this.isScroll(source.item)) {
          this.submitUseItem(source.tab, source.slot, source.item, -slotNumber, target);
        } else {
          // Equipment use resolves its authoritative body slot from the item
          // definition; the visual target is only the original drag affordance.
          this.submitUseItem(source.tab, source.slot, source.item);
        }
      }
      this.clearDragState();
    });
    parent.append(button);
  }

  private equippedAt(slotNumber: number) {
    return this.equipped.find(item => Math.abs(item.slot) === slotNumber);
  }

  private canDropOnEquipment(source: DragSource, target: InventoryItem | undefined) {
    if (this.isScroll(source.item)) return Boolean(target);
    return itemCategoryTab(source.item.itemId) === 0;
  }

  private unequip(item: InventoryItem) {
    const sourceSlot = -Math.abs(item.slot);
    this.submitUseItem(0, sourceSlot, item);
  }

  private showSlotTooltip(slotNumber: number) {
    const item = this.visibleItemAt(slotNumber);
    if (item) {
      const slot = this.grid?.querySelector<HTMLButtonElement>('[data-slot="' + slotNumber + '"]');
      if (slot) this.showTooltipForItem(item, slot);
    }
  }

  private showTooltipForItem(item: InventoryItem, anchor: HTMLElement) {
    if (!this.tooltip) return;
    this.tooltip.textContent = itemDetails(item.itemId, item);
    this.tooltip.hidden = false;
    this.tooltip.dataset.itemId = item.itemId;
    this.positionTooltip(anchor);
  }

  private positionTooltip(anchor: HTMLElement) {
    if (!this.tooltip || this.tooltip.hidden) return;
    const rect = anchor.getBoundingClientRect();
    const width = this.tooltip.offsetWidth || 220;
    const height = this.tooltip.offsetHeight || 60;
    const gap = 6;
    let left = rect.right + gap;
    if (left + width > window.innerWidth - 6) left = rect.left - width - gap;
    let top = rect.top;
    if (top + height > window.innerHeight - 6) top = Math.max(6, window.innerHeight - height - 6);
    this.tooltip.style.left = Math.round(Math.max(6, left)) + 'px';
    this.tooltip.style.top = Math.round(Math.max(6, top)) + 'px';
  }

  private hideTooltip() {
    if (!this.tooltip) return;
    this.tooltip.hidden = true;
    delete this.tooltip.dataset.itemId;
  }

  private requestId(prefix: string) {
    const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Date.now().toString(36) + '-' + (++this.requestSequence);
    return (prefix + '-' + random).slice(0, 64);
  }

  private clearDragState() {
    this.draggedSlot = undefined;
    this.draggedTab = undefined;
    this.draggedEquippedSlot = undefined;
    this.grid?.querySelectorAll('.inventory-slot-dragging,.inventory-slot-drag-target').forEach(slot => {
      slot.classList.remove('inventory-slot-dragging', 'inventory-slot-drag-target');
    });
    this.equipmentWindow?.querySelectorAll('.equipment-slot-dragging,.equipment-slot-drag-target').forEach(slot => {
      slot.classList.remove('equipment-slot-dragging', 'equipment-slot-drag-target');
    });
  }

  private onDocumentDragOver(event: DragEvent) {
    if ((!this.openState && !this.equipmentOpenState) || (!this.dragSource() && !this.draggedEquippedItem())) return;
    const target = event.target;
    if (target instanceof Node && (this.window?.contains(target) || this.equipmentWindow?.contains(target))) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }

  private onDocumentDrop(event: DragEvent) {
    if (!this.openState && !this.equipmentOpenState) return;
    const source = this.dragSource();
    const equippedSource = this.draggedEquippedItem();
    if (!source && !equippedSource) return;
    const target = event.target;
    if (target instanceof Node && (this.window?.contains(target) || this.equipmentWindow?.contains(target))) return;
    event.preventDefault();
    if (equippedSource) this.unequip(equippedSource);
    else if (source) this.dropSlot(source.tab, source.slot);
    this.clearDragState();
  }

  private onWindowPointerDown(event: PointerEvent) {
    const window = event.currentTarget instanceof HTMLDivElement ? event.currentTarget : undefined;
    if (!window || event.button !== 0 || (window === this.window ? !this.openState : !this.equipmentOpenState)) return;
    const target = event.target;
    if (target instanceof Element && target.closest('button')) return;
    const rect = window.getBoundingClientRect();
    if (event.clientY - rect.top > 21) return;
    const hostRect = this.host.getBoundingClientRect();
    const positioned = window === this.window ? this.windowPositioned : this.equipmentWindowPositioned;
    if (!positioned) {
      window.style.left = Math.round(rect.left - hostRect.left) + 'px';
      window.style.top = Math.round(rect.top - hostRect.top) + 'px';
      window.style.transform = 'none';
      if (window === this.window) this.windowPositioned = true;
      else this.equipmentWindowPositioned = true;
    }
    this.draggingWindow = {
      pointerId: event.pointerId,
      offsetX: event.clientX - window.getBoundingClientRect().left,
      offsetY: event.clientY - window.getBoundingClientRect().top,
      window,
    };
    window.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  private onWindowPointerMove(event: PointerEvent) {
    if (!this.draggingWindow || event.pointerId !== this.draggingWindow.pointerId) return;
    const window = this.draggingWindow.window;
    const hostRect = this.host.getBoundingClientRect();
    const width = window.getBoundingClientRect().width;
    const height = window.getBoundingClientRect().height;
    const maxLeft = Math.max(0, hostRect.width - width);
    const maxTop = Math.max(0, hostRect.height - height);
    const left = Math.min(maxLeft, Math.max(0, event.clientX - hostRect.left - this.draggingWindow.offsetX));
    const top = Math.min(maxTop, Math.max(0, event.clientY - hostRect.top - this.draggingWindow.offsetY));
    window.style.left = Math.round(left) + 'px';
    window.style.top = Math.round(top) + 'px';
  }

  private onWindowPointerUp(event: PointerEvent) {
    if (!this.draggingWindow || event.pointerId !== this.draggingWindow.pointerId) return;
    this.draggingWindow.window.releasePointerCapture?.(event.pointerId);
    this.draggingWindow = undefined;
  }

  private onKeyDown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.repeat) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof Element && target.matches('input,textarea,select,[contenteditable="true"]')) return;
    if (event.code === 'KeyI' || event.key.toLowerCase() === 'i') {
      event.preventDefault();
      this.toggle();
      return;
    }
    if (event.code === 'KeyE' || event.key.toLowerCase() === 'e') {
      event.preventDefault();
      this.toggleEquipment();
      return;
    }
    if (event.code === 'Escape' || event.key === 'Escape') {
      if (!this.openState && !this.equipmentOpenState) return;
      event.preventDefault();
      if (this.openState) this.close();
      if (this.equipmentOpenState) this.closeEquipment();
    }
  }

  private focusGame() {
    const game = document.querySelector<HTMLElement>('#game');
    if (!game) return;
    const focus = () => {
      try {
        game.focus({ preventScroll: true });
      } catch {
        game.focus();
      }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focus);
    else focus();
  }

  private createWindowButton(parent: HTMLDivElement, kind: 'close' | 'gather' | 'size' | 'coin', assets: AssetSet, normalKey: string | (() => string), action: () => void) {
    const resolveKey = () => typeof normalKey === 'function' ? normalKey() : normalKey;
    const normal = assets[resolveKey()];
    if (!normal) return undefined;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'inventory-window-button inventory-window-button-' + kind;
    button.dataset.state = 'normal';
    const labels = {
      close: this.t('关闭物品栏', 'Close inventory'),
      gather: this.sortMode ? this.t('整理物品栏', 'Sort inventory') : this.t('合并相同道具', 'Merge matching items'),
      size: this.t('切换物品栏大小', 'Toggle inventory size'),
      coin: this.t('丢弃金币', 'Drop mesos'),
    };
    button.setAttribute('aria-label', labels[kind]);
    button.title = labels[kind];
    const image = this.assetImage(normal, 'inventory-window-button-image');
    button.append(image);
    const setState = (state: 'normal' | 'pressed' | 'mouseOver') => {
      const currentKey = resolveKey();
      const currentPath = currentKey.split('/');
      const currentBase = currentPath.length > 2 ? currentPath.slice(0, -2).join('/') : '';
      const frame = assets[(currentBase ? currentBase + '/' : '') + state + '/0'] ?? assets[currentKey] ?? normal;
      button.dataset.state = state;
      image.src = frame.url;
    };
    button.addEventListener('pointerenter', () => setState('mouseOver'));
    button.addEventListener('pointerleave', () => setState('normal'));
    button.addEventListener('pointerdown', () => setState('pressed'));
    button.addEventListener('pointerup', () => setState('normal'));
    button.addEventListener('click', action);
    parent.append(button);
    return button;
  }

  private refreshGatherButton() {
    if (!this.gatherButton || !this.ui) return;
    const key = this.sortMode ? 'BtSort/normal/0' : 'BtGather/normal/0';
    const frame = this.ui[key];
    const image = this.gatherButton.querySelector<HTMLImageElement>('img');
    if (frame && image) {
      image.src = frame.url;
      image.width = frame.width;
      image.height = frame.height;
    }
    const label = this.sortMode ? this.t('整理物品栏', 'Sort inventory') : this.t('合并相同道具', 'Merge matching items');
    this.gatherButton.setAttribute('aria-label', label);
    this.gatherButton.title = label;
  }

  private setFull(full: boolean, announce: boolean) {
    if (!this.window || !this.background || !this.ui) return;
    const fullFrame = this.ui.FullBackgrnd;
    if (full && (!fullFrame || (this.host.clientWidth > 0 && this.host.clientWidth < WINDOW_FULL.width + 12))) {
      if (announce) this.status(this.t('当前窗口宽度不足以展开物品栏。', 'The current window is too narrow for the expanded inventory.'));
      return;
    }
    this.full = full && Boolean(fullFrame);
    const frame = this.full && fullFrame ? fullFrame : this.ui.backgrnd;
    const dimensions = this.full ? WINDOW_FULL : WINDOW_SMALL;
    this.window.style.width = dimensions.width + 'px';
    this.window.style.height = dimensions.height + 'px';
    this.window.dataset.size = this.full ? 'full' : 'small';
    this.background.src = frame.url;
    this.background.width = frame.width;
    this.background.height = frame.height;
    if (this.sizeButton) {
      const key = this.full ? 'BtSmall/normal/0' : 'BtFull/normal/0';
      const state = this.ui[key];
      const image = this.sizeButton.querySelector<HTMLImageElement>('img');
      if (state && image) {
        image.src = state.url;
        image.width = state.width;
        image.height = state.height;
      }
    }
    this.refreshGatherButton();
    this.positionWindowButton(this.closeButton, dimensions.width - 18, 8);
    this.positionWindowButton(this.gatherButton, dimensions.width - 33, 8);
    this.positionWindowButton(this.sizeButton, dimensions.width - 48, 8);
    this.positionWindowButton(this.coinButton, 15, 273);
    this.updateGridMetrics();
    this.renderSlots();
    this.updateTabOverflow();
    this.layout();
  }

  private positionWindowButton(button: HTMLButtonElement | undefined, sourceX: number, sourceY: number) {
    if (!button) return;
    const image = button.querySelector<HTMLImageElement>('img');
    const width = image?.width ?? 12;
    const height = image?.height ?? 12;
    const padding = 4;
    button.style.left = sourceX - width / 2 - padding + 'px';
    button.style.top = sourceY - height / 2 - padding + 'px';
    button.style.width = width + padding * 2 + 'px';
    button.style.height = height + padding * 2 + 'px';
  }

  private updateGridMetrics() {
    if (!this.grid) return;
    const slots = Array.from(this.grid.querySelectorAll<HTMLButtonElement>('.inventory-slot'));
    const columns = this.full ? SLOT_COLUMNS * 4 : SLOT_COLUMNS;
    this.grid.style.left = '0px';
    this.grid.style.top = '0px';
    this.grid.style.width = this.full ? '595px' : '147px';
    this.grid.style.height = String(SLOT_ROWS * SLOT_GRID.rowStep + SLOT_GRID.height) + 'px';
    slots.forEach(slot => {
      const slotNumber = Number(slot.dataset.slot);
      const block = Math.floor((slotNumber - 1) / SLOT_LIMIT);
      const local = (slotNumber - 1) % SLOT_LIMIT;
      const column = local % SLOT_COLUMNS;
      const row = Math.floor(local / SLOT_COLUMNS);
      const x = SLOT_GRID.left + (this.full ? block * FULL_GROUP_STEP : 0) + column * SLOT_GRID.columnStep;
      const y = SLOT_GRID.top + row * SLOT_GRID.rowStep;
      slot.style.left = x + 'px';
      slot.style.top = y + 'px';
      slot.style.width = SLOT_GRID.width + 'px';
      slot.style.height = SLOT_GRID.height + 'px';
      slot.dataset.column = String(columns === SLOT_COLUMNS ? column : block * SLOT_COLUMNS + column);
      slot.dataset.row = String(row);
    });
  }

  private layout() {
    if (this.window && this.full && this.host.clientWidth > 0 && this.host.clientWidth < WINDOW_FULL.width + 12) {
      this.setFull(false, false);
      return;
    }
    const hostRect = this.host.getBoundingClientRect();
    if (this.window && this.windowPositioned) {
      const rect = this.window.getBoundingClientRect();
      const maxLeft = Math.max(0, hostRect.width - rect.width);
      const maxTop = Math.max(0, hostRect.height - rect.height);
      const currentLeft = Number.parseFloat(this.window.style.left) || 0;
      const currentTop = Number.parseFloat(this.window.style.top) || 0;
      this.window.style.left = Math.min(maxLeft, Math.max(0, currentLeft)) + 'px';
      this.window.style.top = Math.min(maxTop, Math.max(0, currentTop)) + 'px';
    }
    if (this.equipmentWindow && this.equipmentWindowPositioned) {
      const rect = this.equipmentWindow.getBoundingClientRect();
      const maxLeft = Math.max(0, hostRect.width - rect.width);
      const maxTop = Math.max(0, hostRect.height - rect.height);
      const currentLeft = Number.parseFloat(this.equipmentWindow.style.left) || 0;
      const currentTop = Number.parseFloat(this.equipmentWindow.style.top) || 0;
      this.equipmentWindow.style.left = Math.min(maxLeft, Math.max(0, currentLeft)) + 'px';
      this.equipmentWindow.style.top = Math.min(maxTop, Math.max(0, currentTop)) + 'px';
    }
  }

  private appendDisabled(slot: HTMLButtonElement) {
    const frame = this.ui?.disabled;
    if (!frame) return;
    const image = this.assetImage(frame, 'inventory-slot-disabled-image');
    image.alt = '';
    image.setAttribute('aria-hidden', 'true');
    slot.append(image);
  }

  private fullOnlyDisabled(slot: number) {
    return this.full && slot > SLOT_LIMIT && !this.itemAt(slot);
  }

  private assetImage(frame: AssetFrame, className: string) {
    const image = document.createElement('img');
    image.className = className;
    image.src = frame.url;
    image.width = frame.width;
    image.height = frame.height;
    image.draggable = false;
    return image;
  }

  private isScroll(item: InventoryItem) {
    return item.itemId.startsWith('204');
  }

  private isAmmo(item: InventoryItem) {
    return item.itemId.startsWith('206');
  }

  private itemQuantity(item: InventoryItem) {
    return itemCategoryTab(item.itemId) === 0 ? '' : ' × ' + Math.max(0, Math.floor(item.quantity));
  }

  private itemLabel(item: InventoryItem) {
    return itemName(item.itemId) + this.itemQuantity(item);
  }

  private localizedError(code: string) {
    const zh = protocolText(code, '物品栏操作失败');
    const en = protocolText(code, 'Inventory action failed');
    return this.t(zh + '（' + code + '）', en + ' (' + code + ')');
  }

  private t(zh: string, en: string) {
    return uiLocale() === 'en' ? en : zh;
  }
}
