import type { ClientMessage, InventoryItem, PlayerState, ServerMessage } from '../../../../shared/protocol';
import type { AssetFrame, EquipmentLayout, InventoryLayout, Manifest } from '../../assets/manifest';
import { protocolText, uiLocale, uiText } from '../../app/i18n';
import { equipmentSlot, itemCategoryTab, itemDetails, itemName } from './names';
import './style.css';

const MIN_DROP_MESOS = 10;
const MAX_DROP_MESOS = 50_000;
const TAB_COUNT = 5;
// Order mirrors the source-authored tab:category/<n> frame sequence
// (裝備 / 消耗 / 其他 / 裝飾 / 現金).  Any reshuffle here must match
// `inventoryLayout.small.tabs.count` and the `tab:category/<state>/<n>`
// frames in manifest.inventoryUi.
const TAB_LABEL_KEYS = ['inventoryEquip', 'inventoryUse', 'inventoryEtc', 'inventorySetup', 'inventoryCash'] as const;
// Server-side inventory type per visible tab index.  Mirrors the
// authoritative five-bucket catalog: 1=equip, 2=use, 3=setup, 4=etc, 5=cash.
// The tab order above is *not* a straight +1 because the source frames put
// 4 (Etc) before 3 (Setup).
const TAB_INVENTORY_TYPE: Readonly<Record<number, number>> = {
  0: 1,
  1: 2,
  2: 4,
  3: 3,
  4: 5,
};

/** Consumable cooldowns are server-owned; the window only renders them. */
type InventoryPlayer = Pick<PlayerState, 'inventory' | 'mesos'> & {
  equipped?: InventoryItem[];
  potionCooldowns?: Record<string, number>;
  inventorySlots?: Record<number, number>;
};
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
 * Source-backed TMS273 UIInventory/UIEquip windows.
 *
 * The window and slot geometry comes from the exported WZ `pos`/origin data;
 * the client only adds interaction layers above those source-authored frames.
 */
export class InventoryView {
  private readonly ui?: Manifest['inventoryUi'];
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
  private readonly tooltipContent?: HTMLDivElement;
  private tooltipAnchor?: HTMLElement;
  private tooltipAnchorHovered = false;
  private tooltipAnchorFocused = false;
  private tooltipHovered = false;
  private tooltipHideTimer?: number;
  private readonly targetPrompt?: HTMLDivElement;
  private readonly equipmentWindow?: HTMLDivElement;
  private readonly equipmentCloseButton?: HTMLButtonElement;
  private readonly closeButton?: HTMLButtonElement;
  private readonly gatherButton?: HTMLButtonElement;
  private readonly sizeButton?: HTMLButtonElement;
  private readonly coinButton?: HTMLButtonElement;
  private readonly observer?: ResizeObserver;
  private readonly manifest: Manifest;
  private readonly inventoryLayout: InventoryLayout;
  private readonly equipmentLayout: EquipmentLayout;
  private readonly visualSlotCount: number;
  private full = false;
  private openState = false;
  private selectedTab = 0;
  private inventory: InventoryPlayer['inventory'] = [];
  private equipped: InventoryItem[] = [];
  private mesos = 0;
  /** Server-owned consumable cooldowns (item id -> remaining ms); display only. */
  private potionCooldowns: Record<string, number> = {};
  /** Server-owned per-tab slot capacity (inventoryType 1..=5 -> slot count). */
  private inventorySlots: Record<number, number> = {};
  private practice = false;
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
    this.inventoryLayout = manifest.inventoryLayout as InventoryLayout;
    this.equipmentLayout = manifest.equipmentLayout as EquipmentLayout;
    this.visualSlotCount = Math.max(manifest.inventoryLayout?.small.slots.itemCount ?? 0, manifest.inventoryLayout?.full.slots.itemCount ?? 0);
    this.root = document.createElement('div');
    this.root.className = 'ui-windows tms273-inventory-host';
    this.root.hidden = true;
    this.root.dataset.open = 'false';
    // The shared UI host also owns NPC dialogue and the quest log.  Keep
    // those siblings mounted when inventory is recreated after login.
    this.host.append(this.root);

    document.addEventListener('keydown', this.handleKeyDown, true);
    document.addEventListener('dragover', this.handleDocumentDragOver, true);
    document.addEventListener('drop', this.handleDocumentDrop, true);
    if (!this.ui?.backgrnd || !manifest.inventoryLayout || !manifest.equipmentLayout || !this.inventoryButtonFrame('close', false)) {
      this.status(this.t('物品栏资源缺失，窗口不可用。', 'Inventory source assets are missing; the window is unavailable.'));
      return;
    }

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
    const tabs = document.createElement('div');
    tabs.className = 'inventory-tabs';
    tabs.style.position = 'relative';
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
    for (let index = 0; index < this.visualSlotCount; index++) this.createSlot(grid, index);
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
    tooltip.tabIndex = 0;
    const tooltipTop = this.ui?.['tooltip:top'];
    const tooltipMiddle = this.ui?.['tooltip:mid'];
    const tooltipBottom = this.ui?.['tooltip:btm'];
    if (tooltipTop && tooltipMiddle && tooltipBottom) {
      tooltip.dataset.skin = 'source';
      tooltip.style.setProperty('--inventory-tooltip-width', `${tooltipTop.width}px`);
      tooltip.style.setProperty('--inventory-tooltip-top-height', `${tooltipTop.height}px`);
      tooltip.style.setProperty('--inventory-tooltip-bottom-height', `${tooltipBottom.height}px`);
      const top = this.assetImage(tooltipTop, 'inventory-tooltip-top');
      const middle = document.createElement('div');
      middle.className = 'inventory-tooltip-middle';
      middle.style.backgroundImage = `url("${tooltipMiddle.url}")`;
      const bottom = this.assetImage(tooltipBottom, 'inventory-tooltip-bottom');
      tooltip.append(top, middle, bottom);
    }
    const content = document.createElement('div');
    content.className = 'inventory-tooltip-content';
    tooltip.append(content);
    this.tooltipContent = content;
    tooltip.addEventListener('pointerenter', () => {
      this.tooltipHovered = true;
      if (this.tooltipHideTimer !== undefined) window.clearTimeout(this.tooltipHideTimer);
      this.tooltipHideTimer = undefined;
    });
    tooltip.addEventListener('pointerleave', () => {
      this.tooltipHovered = false;
      this.scheduleTooltipHide();
    });
    tooltip.addEventListener('focus', () => { this.tooltipHovered = true; });
    tooltip.addEventListener('blur', () => {
      this.tooltipHovered = false;
      this.scheduleTooltipHide();
    });
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

    this.closeButton = this.createWindowButton(inventoryWindow, 'close', this.ui, () => this.inventoryButtonKey('close'), () => this.close());
    this.gatherButton = this.createWindowButton(inventoryWindow, 'gather', this.ui, () => this.inventoryButtonKey('sort'), () => this.inventoryAction(this.sortMode ? 'sort' : 'gather'));
    this.sizeButton = this.createWindowButton(inventoryWindow, 'size', this.ui, () => this.inventoryButtonKey('size'), () => this.setFull(!this.full, true));
    this.coinButton = this.createWindowButton(inventoryWindow, 'coin', this.ui, () => this.inventoryButtonKey('coin'), () => this.dropMesos());

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

  private inventoryMode(full = this.full) {
    return full ? this.inventoryLayout.full : this.inventoryLayout.small;
  }

  private inventoryFrame(key: string, full = this.full) {
    const mode = full ? 'FullAutoBuild' : 'AutoBuild';
    return this.ui?.[`${mode}/${key}`] ?? this.ui?.[key];
  }

  private inventoryButtonKey(kind: 'close' | 'size' | 'sort' | 'coin', full = this.full) {
    const sourceName = kind === 'size'
      ? (full ? 'button:min' : 'button:full')
      : ({ close: 'button:close', sort: 'button:sort', coin: 'button:meso' } as const)[kind];
    return `${full ? 'FullAutoBuild' : 'AutoBuild'}/${sourceName}/normal/0`;
  }

  private inventoryButtonFrame(kind: 'close' | 'size' | 'sort' | 'coin', full = this.full) {
    return this.inventoryFrame(`${kind === 'size'
      ? (full ? 'button:min' : 'button:full')
      : ({ close: 'button:close', sort: 'button:sort', coin: 'button:meso' } as const)[kind]}/normal/0`, full);
  }

  update(player: InventoryPlayer | undefined, practice = false) {
    this.practice = practice;
    if (this.coinButton) { this.coinButton.disabled = practice; this.coinButton.title = practice ? this.t('练习中不能丢弃金币', 'Cannot drop mesos during practice') : this.t('丢弃金币', 'Drop mesos'); }
    if (!this.window) return;
    if (!player) {
      this.clear();
      return;
    }
    this.inventory = player.inventory.slice();
    this.equipped = (player.equipped ?? []).slice();
    this.mesos = Math.max(0, Math.floor(player.mesos));
    this.potionCooldowns = { ...(player.potionCooldowns ?? {}) };
    this.inventorySlots = { ...(player.inventorySlots ?? {}) };
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
      // Cooldown seconds tick down, so they belong to the render signature:
      // without this the badge would freeze at the value it had when the
      // inventory last changed.
      .concat(Object.entries(this.potionCooldowns)
        .map(([itemId, ms]) => `cd:${itemId}:${Math.ceil(ms / 1000)}`))
      // Slot capacities change which cells are enabled, so they belong to the
      // signature: expanding a tab must re-render its grid immediately.
      .concat(Object.entries(this.inventorySlots)
        .map(([type, slots]) => `cap:${type}:${slots}`))
      .join('|');
    if (signature !== this.slotsSignature) {
      if (!this.keepGatherResultMode) this.sortMode = false;
      this.keepGatherResultMode = false;
      this.slotsSignature = signature;
      this.renderSlots();
      this.refreshGatherButton();
      this.refreshTooltip();
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
    this.potionCooldowns = {};
    this.inventorySlots = {};
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
    if (this.tooltipHideTimer !== undefined) window.clearTimeout(this.tooltipHideTimer);
    this.tooltipHideTimer = undefined;
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
  }

  private createTab(parent: HTMLDivElement, index: number) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'inventory-tab';
    button.dataset.tab = String(index);
    const label = uiText(TAB_LABEL_KEYS[index], this.t('物品栏分页 ' + (index + 1), 'Inventory tab ' + (index + 1)));
    button.setAttribute('aria-label', label);
    button.title = label;
    button.addEventListener('click', () => {
      this.selectedTab = index;
      this.sortMode = false;
      this.keepGatherResultMode = false;
      this.pendingInventoryOperation = undefined;
      this.hideTooltip();
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
    this.updateTabMetrics();
    this.tabs?.querySelectorAll<HTMLButtonElement>('.inventory-tab').forEach(button => {
      this.updateTab(button, Number(button.dataset.tab));
    });
  }

  private updateTabMetrics() {
    const mode = this.inventoryMode();
    const tabs = mode.tabs;
    if (this.tabsViewport) {
      this.tabsViewport.style.left = `${tabs.left}px`;
      this.tabsViewport.style.top = `${tabs.top}px`;
      this.tabsViewport.style.width = `${tabs.viewportWidth}px`;
      this.tabsViewport.style.height = `${tabs.viewportHeight}px`;
    }
    if (this.tabs) {
      this.tabs.style.width = `${tabs.stepX * Math.max(0, tabs.count - 1) + tabs.width}px`;
      this.tabs.style.height = `${tabs.height}px`;
    }
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
    const state = index === this.selectedTab ? 'selected' : 'normal';
    button.dataset.state = state;
    button.replaceChildren();
    const mode = this.inventoryMode();
    const frame = this.inventoryFrame(`tab:category/${state}/${index}`);
    if (frame) {
      button.style.left = `${frame.x}px`;
      button.style.top = `${frame.y}px`;
      button.style.width = `${frame.width}px`;
      button.style.height = `${frame.height}px`;
      button.append(this.assetImage(frame, 'inventory-tab-frame'));
      return;
    }
    button.style.left = `${mode.tabs.left + index * mode.tabs.stepX}px`;
    button.style.top = `${mode.tabs.top}px`;
    button.style.width = `${mode.tabs.width}px`;
    button.style.height = `${mode.tabs.height}px`;
    // Legacy manifests may still carry Basic.Tab2 pieces. Keep that fallback
    // functional while TMS273 uses the complete source-authored tab canvas.
    const tabUi = this.manifest.tabUi;
    const stateSuffix = state === 'selected' ? '1' : '0';
    for (const [key, className] of [['fill', 'inventory-tab-fill'], ['left', 'inventory-tab-left']] as const) {
      const asset = tabUi?.[key + stateSuffix];
      if (asset) button.append(this.assetImage(asset, className));
    }
    if (index !== TAB_COUNT - 1) {
      const middle = tabUi?.['middle' + stateSuffix];
      if (middle) button.append(this.assetImage(middle, 'inventory-tab-middle'));
    }
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
    slot.addEventListener('pointerenter', () => {
      this.tooltipAnchorHovered = true;
      this.showSlotTooltip(slotNumber);
    });
    slot.addEventListener('pointermove', () => this.positionTooltip(slot));
    slot.addEventListener('pointerleave', () => {
      this.tooltipAnchorHovered = false;
      this.scheduleTooltipHide();
    });
    slot.addEventListener('focus', () => {
      this.tooltipAnchorFocused = true;
      this.showSlotTooltip(slotNumber);
    });
    slot.addEventListener('blur', () => {
      this.tooltipAnchorFocused = false;
      this.scheduleTooltipHide();
    });
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
      const payload = JSON.stringify({ inventoryType: TAB_INVENTORY_TYPE[this.selectedTab] ?? this.selectedTab + 1, sourceSlot: slotNumber, itemId: item.itemId });
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
    if (slotNumber > this.slotLimit(this.selectedTab)) return;
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
    const mode = this.inventoryMode();
    const slots = Array.from(this.grid.querySelectorAll<HTMLButtonElement>('.inventory-slot'));
    for (const slot of slots) {
      const slotNumber = Number(slot.dataset.slot);
      const item = this.itemAt(slotNumber);
      const visible = slotNumber <= mode.slots.itemCount;
      const available = visible && slotNumber <= this.slotLimit(this.selectedTab);
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
        if (this.backendOnlyDisabled(slotNumber)) this.appendDisabled(slot);
        continue;
      }
      const frame = this.manifest.items?.[item.itemId];
      if (!frame) continue;
      const icon = this.assetImage(frame, 'inventory-item-icon');
      icon.alt = itemName(item.itemId);
      icon.setAttribute('aria-hidden', 'true');
      icon.style.left = `${mode.slots.itemOffset.x}px`;
      icon.style.top = `${mode.slots.itemOffset.y}px`;
      icon.style.transform = 'none';
      slot.append(icon);
      if (itemCategoryTab(item.itemId) !== 0 && item.quantity > 1) {
        const quantity = document.createElement('span');
        quantity.className = 'inventory-item-quantity';
        quantity.textContent = String(Math.max(0, Math.floor(item.quantity)));
        quantity.setAttribute('aria-hidden', 'true');
        if (mode.slots.itemCountOffset) {
          quantity.style.left = `${mode.slots.itemCountOffset.x}px`;
          quantity.style.top = `${mode.slots.itemCountOffset.y}px`;
          quantity.style.right = 'auto';
          quantity.style.bottom = 'auto';
        }
        slot.append(quantity);
      }
      // Consumable cooldown badge.  The remaining time is server-owned and
      // arrives with the snapshot; the window only renders it, so a client can
      // never shorten or clear a cooldown by not drawing it.
      const remaining = this.potionCooldowns[item.itemId] ?? 0;
      if (remaining > 0) {
        const badge = document.createElement('span');
        badge.className = 'inventory-item-cooldown';
        badge.textContent = `${Math.ceil(remaining / 1000)}s`;
        badge.setAttribute('aria-hidden', 'true');
        slot.append(badge);
        slot.classList.add('inventory-slot-cooling');
        slot.setAttribute('aria-label', this.t(
          `道具 ${itemName(item.itemId)} 冷却中，还需 ${Math.ceil(remaining / 1000)} 秒`,
          `Item ${itemName(item.itemId)} is cooling down: ${Math.ceil(remaining / 1000)}s remaining`,
        ));
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
    if (
      message.code === 'scroll_success' ||
      message.code === 'scroll_failed' ||
      // A map-move consumable reports its own outcome: the server already
      // decided where the body lands, so this is a notice, not a request for
      // the client to do anything.
      message.code === 'map_move' ||
      // A slot-expansion coupon reports its own outcome; the authoritative new
      // capacity arrives with the next snapshot, so this is a notice.
      message.code === 'slot_expand'
    ) {
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

  /** The current server-owned slot capacity for the visible tab. */
  private slotLimit(tab: number) {
    const inventoryType = TAB_INVENTORY_TYPE[tab] ?? tab + 1;
    return this.inventorySlots[inventoryType] ?? this.inventoryLayout.backendSlotLimit;
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
    const maxSlot = this.slotLimit(sourceTab);
    if (!item || sourceSlot < 1 || sourceSlot > maxSlot || targetSlot < 1 || targetSlot > maxSlot) return;
    if (!this.send({
      type: 'inventoryMove',
      requestId: this.requestId('move'),
      inventoryType: TAB_INVENTORY_TYPE[sourceTab] ?? sourceTab + 1,
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
    if (this.practice) { this.status(this.t('请退出练习后再丢弃物品。', 'Leave practice before dropping items.')); return; }
    const item = this.itemAt(sourceSlot, sourceTab);
    if (!item || sourceSlot < 1 || sourceSlot > this.slotLimit(sourceTab)) return;
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
      inventoryType: TAB_INVENTORY_TYPE[sourceTab] ?? sourceTab + 1,
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
      inventoryType: TAB_INVENTORY_TYPE[this.selectedTab] ?? this.selectedTab + 1,
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
      inventoryType: TAB_INVENTORY_TYPE[sourceTab] ?? sourceTab + 1,
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
    if (this.practice) { this.status(this.t('请退出练习后再丢弃金币。', 'Leave practice before dropping mesos.')); return; }
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
    const mesos = this.inventoryMode().mesos;
    this.mesosLine.style.left = `${mesos.x}px`;
    this.mesosLine.style.top = `${mesos.y}px`;
    this.mesosLine.style.width = `${mesos.width}px`;
    this.mesosLine.style.height = `${mesos.height}px`;
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
          if (this.equipmentLayout.itemOffset) {
            icon.style.left = `${this.equipmentLayout.itemOffset.x}px`;
            icon.style.top = `${this.equipmentLayout.itemOffset.y}px`;
            icon.style.transform = 'none';
          }
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
    const closeFrame = ui?.['main/button:close/normal/0'];
    if (!backgroundFrame || !closeFrame) return undefined;
    const equipmentWindow = document.createElement('div');
    equipmentWindow.className = 'equipment-window';
    equipmentWindow.style.width = `${this.equipmentLayout.width}px`;
    equipmentWindow.style.height = `${this.equipmentLayout.height}px`;
    equipmentWindow.setAttribute('role', 'dialog');
    equipmentWindow.setAttribute('aria-modal', 'false');
    equipmentWindow.setAttribute('aria-label', this.t('装备栏', 'Equip Inventory'));
    equipmentWindow.tabIndex = -1;
    equipmentWindow.hidden = true;

    const background = this.assetImage(backgroundFrame, 'equipment-window-background');
    background.alt = '';
    background.setAttribute('aria-hidden', 'true');
    equipmentWindow.append(background);
    const equipCanvasFrame = ui?.['EquipTab/canvas:equip'];
    if (equipCanvasFrame) {
      const equipCanvas = this.assetImage(equipCanvasFrame, 'equipment-tab-canvas');
      equipCanvas.style.left = `${equipCanvasFrame.x}px`;
      equipCanvas.style.top = `${equipCanvasFrame.y}px`;
      equipCanvas.style.zIndex = '1';
      equipCanvas.setAttribute('aria-hidden', 'true');
      equipmentWindow.append(equipCanvas);
    }
    const title = document.createElement('span');
    title.className = 'equipment-window-title';
    title.textContent = this.t('装备栏', 'Equip Inventory');
    title.setAttribute('aria-hidden', 'true');
    equipmentWindow.append(title);
    for (const slotNumber of Object.keys(this.equipmentLayout.slots).map(Number)) {
      this.createEquipmentSlot(equipmentWindow, slotNumber);
    }
    const close = this.createWindowButton(equipmentWindow, 'close', ui, 'main/button:close/normal/0', () => this.closeEquipment());
    close?.setAttribute('aria-label', this.t('关闭装备栏', 'Close equip inventory'));
    if (close) close.title = this.t('关闭装备栏', 'Close equip inventory');
    if (close) {
      close.title = this.t('关闭装备栏', 'Close equipment inventory');
      close.setAttribute('aria-label', close.title);
    }
    this.positionWindowButton(close, this.equipmentLayout.close);
    return close ? { window: equipmentWindow, close } : undefined;
  }

  private createEquipmentSlot(parent: HTMLDivElement, slotNumber: number) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'equipment-slot';
    button.dataset.slot = String(slotNumber);
    const position = this.equipmentLayout.slots[String(slotNumber)];
    if (position) {
      button.style.left = position.x + 'px';
      button.style.top = position.y + 'px';
      button.style.width = position.width + 'px';
      button.style.height = position.height + 'px';
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
      this.tooltipAnchorHovered = true;
      const item = this.equippedAt(slotNumber);
      if (item) this.showTooltipForItem(item, button);
    });
    button.addEventListener('pointermove', () => this.positionTooltip(button));
    button.addEventListener('pointerleave', () => {
      this.tooltipAnchorHovered = false;
      this.scheduleTooltipHide();
    });
    button.addEventListener('focus', () => {
      this.tooltipAnchorFocused = true;
      const item = this.equippedAt(slotNumber);
      if (item) this.showTooltipForItem(item, button);
    });
    button.addEventListener('blur', () => {
      this.tooltipAnchorFocused = false;
      this.scheduleTooltipHide();
    });
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
      if (slot) this.showTooltipForItem(item, slot, this.comparisonTarget(item));
    }
  }

  private comparisonTarget(item: InventoryItem): InventoryItem | null | undefined {
    const slot = equipmentSlot(item.itemId);
    if (slot === undefined) return undefined;
    return this.equipped.find(current => Math.abs(current.slot) === slot) ?? null;
  }

  private showTooltipForItem(item: InventoryItem, anchor: HTMLElement, comparison?: InventoryItem | null) {
    if (!this.tooltip) return;
    if (this.tooltipHideTimer !== undefined) window.clearTimeout(this.tooltipHideTimer);
    this.tooltipHideTimer = undefined;
    this.tooltipAnchor = anchor;
    if (this.tooltipContent) this.tooltipContent.textContent = itemDetails(item.itemId, item, comparison);
    else this.tooltip.textContent = itemDetails(item.itemId, item, comparison);
    this.tooltip.hidden = false;
    this.tooltip.dataset.itemId = item.itemId;
    this.positionTooltip(anchor);
  }

  private refreshTooltip() {
    const anchor = this.tooltipAnchor;
    if (!anchor || !this.tooltip || this.tooltip.hidden) return;
    if (anchor.classList.contains('inventory-slot')) {
      const slot = anchor as HTMLButtonElement;
      const item = this.itemAt(Number(anchor.dataset.slot));
      if (item && !slot.hidden && !slot.disabled) {
        this.showTooltipForItem(item, anchor, this.comparisonTarget(item));
        return;
      }
    } else if (anchor.classList.contains('equipment-slot')) {
      const item = this.equippedAt(Number(anchor.dataset.slot));
      if (item) {
        this.showTooltipForItem(item, anchor);
        return;
      }
    }
    this.hideTooltip();
  }

  private positionTooltip(anchor: HTMLElement) {
    if (!this.tooltip || this.tooltip.hidden) return;
    const rect = anchor.getBoundingClientRect();
    const viewportWidth = Math.max(1, window.innerWidth);
    const width = Math.min(this.tooltip.offsetWidth || 220, Math.max(1, viewportWidth - 12));
    const viewportHeight = Math.max(1, window.innerHeight);
    const height = Math.min(this.tooltip.offsetHeight || 60, Math.max(1, viewportHeight - 12));
    const gap = 6;
    let left = rect.right + gap;
    if (left + width > viewportWidth - 6) left = rect.left - width - gap;
    const leftGutter = Math.min(6, Math.max(0, (viewportWidth - width) / 2));
    left = Math.min(viewportWidth - width - leftGutter, Math.max(leftGutter, left));
    let top = rect.top;
    if (top + height > viewportHeight - 6) top = viewportHeight - height - 6;
    const topGutter = Math.min(6, Math.max(0, (viewportHeight - height) / 2));
    top = Math.min(viewportHeight - height - topGutter, Math.max(topGutter, top));
    this.tooltip.style.left = Math.round(left) + 'px';
    this.tooltip.style.top = Math.round(top) + 'px';
  }

  private scheduleTooltipHide() {
    if (this.tooltipHideTimer !== undefined) window.clearTimeout(this.tooltipHideTimer);
    this.tooltipHideTimer = window.setTimeout(() => {
      this.tooltipHideTimer = undefined;
      if (!this.tooltipAnchorHovered && !this.tooltipAnchorFocused && !this.tooltipHovered) this.hideTooltip();
    }, 160);
  }

  private hideTooltip() {
    if (!this.tooltip) return;
    if (this.tooltipHideTimer !== undefined) window.clearTimeout(this.tooltipHideTimer);
    this.tooltipHideTimer = undefined;
    this.tooltip.hidden = true;
    this.tooltipAnchor = undefined;
    this.tooltipAnchorHovered = false;
    this.tooltipAnchorFocused = false;
    this.tooltipHovered = false;
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
    const key = this.inventoryButtonKey('sort');
    const frame = this.ui[key] ?? this.inventoryFrame('button:sort/normal/0');
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
    const requestedMode = full ? this.inventoryLayout.full : this.inventoryLayout.small;
    if (full && (!fullFrame || (this.host.clientWidth > 0 && this.host.clientWidth < requestedMode.width + 12))) {
      if (announce) this.status(this.t('当前窗口宽度不足以展开物品栏。', 'The current window is too narrow for the expanded inventory.'));
      return;
    }
    this.full = full && Boolean(fullFrame);
    const frame = this.full && fullFrame ? fullFrame : this.ui.backgrnd;
    const dimensions = this.inventoryMode();
    this.window.style.width = dimensions.width + 'px';
    this.window.style.height = dimensions.height + 'px';
    this.window.dataset.size = this.full ? 'full' : 'small';
    this.background.src = frame.url;
    this.background.width = frame.width;
    this.background.height = frame.height;
    if (this.sizeButton) {
      const state = this.inventoryButtonFrame('size');
      const image = this.sizeButton.querySelector<HTMLImageElement>('img');
      if (state && image) {
        image.src = state.url;
        image.width = state.width;
        image.height = state.height;
      }
    }
    this.refreshGatherButton();
    this.positionWindowButton(this.closeButton, dimensions.buttons.close);
    this.positionWindowButton(this.gatherButton, dimensions.buttons.sort);
    this.positionWindowButton(this.sizeButton, dimensions.buttons.size);
    this.positionWindowButton(this.coinButton, dimensions.buttons.coin);
    this.updateGridMetrics();
    this.renderSlots();
    this.updateTabs();
    this.updateTabOverflow();
    this.layout();
  }

  private positionWindowButton(button: HTMLButtonElement | undefined, position: { x: number; y: number }) {
    if (!button) return;
    const image = button.querySelector<HTMLImageElement>('img');
    const width = image?.width ?? 12;
    const height = image?.height ?? 12;
    const padding = 4;
    button.style.left = position.x - padding + 'px';
    button.style.top = position.y - padding + 'px';
    button.style.width = width + padding * 2 + 'px';
    button.style.height = height + padding * 2 + 'px';
  }

  private updateGridMetrics() {
    if (!this.grid) return;
    const slots = Array.from(this.grid.querySelectorAll<HTMLButtonElement>('.inventory-slot'));
    const layout = this.inventoryMode().slots;
    const columns = layout.columns;
    const stepX = layout.slotWidth + layout.spacingX;
    const stepY = layout.slotHeight + layout.spacingY;
    this.grid.style.left = '0px';
    this.grid.style.top = '0px';
    this.grid.style.width = `${layout.origin.x + columns * layout.slotWidth + (columns - 1) * layout.spacingX}px`;
    this.grid.style.height = `${layout.origin.y + layout.rows * layout.slotHeight + (layout.rows - 1) * layout.spacingY}px`;
    slots.forEach(slot => {
      const slotNumber = Number(slot.dataset.slot);
      const column = (slotNumber - 1) % columns;
      const row = Math.floor((slotNumber - 1) / columns);
      const x = layout.origin.x + column * stepX;
      const y = layout.origin.y + row * stepY;
      slot.style.left = x + 'px';
      slot.style.top = y + 'px';
      slot.style.width = layout.slotWidth + 'px';
      slot.style.height = layout.slotHeight + 'px';
      slot.dataset.column = String(column);
      slot.dataset.row = String(row);
    });
  }

  private layout() {
    if (this.window && this.full && this.host.clientWidth > 0 && this.host.clientWidth < this.inventoryLayout.full.width + 12) {
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
    if (this.tooltip && !this.tooltip.hidden && this.tooltipAnchor) this.positionTooltip(this.tooltipAnchor);
  }

  private appendDisabled(slot: HTMLButtonElement) {
    const frame = this.ui?.disabled;
    if (!frame) return;
    const image = this.assetImage(frame, 'inventory-slot-disabled-image');
    image.alt = '';
    image.setAttribute('aria-hidden', 'true');
    slot.append(image);
  }

  private backendOnlyDisabled(slot: number) {
    return slot > this.slotLimit(this.selectedTab) && slot <= this.inventoryMode().slots.itemCount && !this.itemAt(slot);
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
