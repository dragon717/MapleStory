import type { ClientMessage, InventoryItem, ServerMessage } from '../../../../shared/protocol';
import type { AssetFrame, EquipmentLayout, InventoryLayout, Manifest } from '../../assets/manifest';
import { protocolText, uiLocale, uiText } from '../../app/i18n';
import { itemCategoryTab, itemDetails, itemName } from './names';
import { TooltipController, tooltipSkin } from './tooltip-view';
import { DragController } from './drag-controller';
import { InventoryIntents, type SendClientMessage } from './intents';
import { EquipmentView } from './equipment-view';
import {
  TAB_COUNT,
  TAB_LABEL_KEYS,
  comparisonTarget as comparisonTargetFor,
  equippedAtSlot,
  itemAtSlot,
  slotLimit as slotLimitFor,
  slotsDataset,
  slotsSignature,
  type InventoryPlayer,
} from './view-model';
import './style.css';

type AssetSet = Record<string, AssetFrame>;

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
  private readonly tooltips: TooltipController;
  private readonly drag: DragController;
  private readonly equipment?: EquipmentView;
  private readonly targetPrompt?: HTMLDivElement;
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
  private windowPositioned = false;
  private equipmentWindowPositioned = false;
  private draggingWindow?: { pointerId: number; offsetX: number; offsetY: number; window: HTMLDivElement };
  private keepGatherResultMode = false;
  private sortMode = false;
  private destroyed = false;
  private readonly intents: InventoryIntents;

  private readonly handleKeyDown = (event: KeyboardEvent) => this.onKeyDown(event);
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

    this.tooltips = new TooltipController(this.root, tooltipSkin(this.ui), {
      assetImage: (frame, className) => this.assetImage(frame, className),
      detailsFor: (item, comparison) => itemDetails(item.itemId, item, comparison),
    });

    this.intents = new InventoryIntents(this.send, {
      status: message => this.status(message),
      t: (zh, en) => this.t(zh, en),
      itemAt: (slot, tab) => this.itemAt(slot, tab),
      slotLimit: tab => this.slotLimit(tab),
      itemLabel: item => this.itemLabel(item),
      practice: () => this.practice,
      selectedTab: () => this.selectedTab,
      mesos: () => this.mesos,
      onTargetModeChange: selecting => this.applyTargetMode(selecting),
    });

    this.drag = new DragController({
      selectedTab: () => this.selectedTab,
      scrollPending: () => this.intents.hasScrollTarget(),
      windowOpen: () => this.openState || Boolean(this.equipment?.isOpen()),
      containsTarget: node => Boolean(this.window?.contains(node) || this.equipment?.window?.contains(node)),
      inventoryItemAt: (slot, tab) => this.itemAt(slot, tab),
      equippedItemAt: slot => this.equippedAt(slot),
      isScroll: item => this.isScroll(item),
      moveItem: (sourceTab, sourceSlot, targetSlot) => this.moveSlot(sourceTab, sourceSlot, targetSlot),
      dropItem: (sourceTab, sourceSlot) => this.dropSlot(sourceTab, sourceSlot),
      unequip: item => this.unequip(item),
      useScrollOnEquipment: (sourceTab, sourceSlot, item, targetSlot, target) => this.submitUseItem(sourceTab, sourceSlot, item, targetSlot, target),
      useItem: (sourceTab, sourceSlot, item) => this.submitUseItem(sourceTab, sourceSlot, item),
      clearDragMarks: () => {
        this.grid?.querySelectorAll('.inventory-slot-dragging,.inventory-slot-drag-target').forEach(slot => {
          slot.classList.remove('inventory-slot-dragging', 'inventory-slot-drag-target');
        });
        this.equipment?.window?.querySelectorAll('.equipment-slot-dragging,.equipment-slot-drag-target').forEach(slot => {
          slot.classList.remove('equipment-slot-dragging', 'equipment-slot-drag-target');
        });
      },
    });

    document.addEventListener('keydown', this.handleKeyDown, true);
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

    const targetPrompt = document.createElement('div');
    targetPrompt.className = 'inventory-target-prompt';
    targetPrompt.hidden = true;
    targetPrompt.textContent = this.t('请选择要使用卷轴的装备。', 'Choose the equipment to use this scroll on.');
    targetPrompt.setAttribute('role', 'status');
    inventoryWindow.append(targetPrompt);
    this.targetPrompt = targetPrompt;

    const equipment = new EquipmentView(this.root, manifest, this.equipmentLayout, {
      equippedItemAt: slot => this.equippedAt(slot),
      selectingTarget: () => this.intents.hasScrollTarget(),
      itemFrame: itemId => this.manifest.items?.[itemId],
      assetImage: (frame, className) => this.assetImage(frame, className),
      translate: (zh, en) => this.t(zh, en),
      status: message => this.status(message),
      createWindowButton: (parent, kind, assets, normalKey, action) => this.createWindowButton(parent, kind, assets, normalKey, action),
      positionWindowButton: (button, position) => this.positionWindowButton(button, position),
      syncRootVisibility: () => {
        if (!this.openState) {
          this.root.hidden = true;
          this.root.dataset.open = 'false';
        }
      },
      chooseScrollTarget: (slotNumber, item) => {
        const pending = this.intents.scrollTarget();
        if (pending && item) this.submitUseItem(pending.sourceTab, pending.sourceSlot, pending.item, -slotNumber, item);
      },
      announceSelection: item => this.status(this.t('已选择装备 ' + this.itemLabel(item), 'Selected equipment ' + this.itemLabel(item))),
      unequip: item => this.unequip(item),
      onCloseRequest: () => this.closeEquipment(),
      drag: this.drag,
      tooltips: this.tooltips,
    });
    this.equipment = equipment;
    if (equipment.window) {
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
    this.equipment?.render();
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
    this.root.dataset.inventory = slotsDataset(this.inventory);
    this.root.dataset.mesos = String(this.mesos);
    this.root.dataset.tab = String(this.selectedTab);
    this.renderMesos();
    const signature = slotsSignature({
      inventory: this.inventory,
      equipped: this.equipped,
      potionCooldowns: this.potionCooldowns,
      inventorySlots: this.inventorySlots,
    });
    if (signature !== this.slotsSignature) {
      if (!this.keepGatherResultMode) this.sortMode = false;
      this.keepGatherResultMode = false;
      this.slotsSignature = signature;
      this.renderSlots();
      this.refreshGatherButton();
      this.refreshTooltip();
    }
    const pending = this.intents.scrollTarget();
    if (pending && !this.itemAt(pending.sourceSlot, pending.sourceTab)) {
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
    if (this.destroyed) return;
    this.equipment?.open();
    this.layout();
  }

  close() {
    const wasOpen = this.openState;
    this.openState = false;
    this.cancelScrollTarget(false);
    this.intents.resetPending();
    this.drag.clear();
    if (this.window) this.window.hidden = true;
    if (!this.equipment?.isOpen()) {
      this.root.hidden = true;
      this.root.dataset.open = 'false';
    }
    this.hideTooltip();
    if (wasOpen) this.focusGame();
  }

  private closeEquipment(restoreFocus = true) {
    const wasOpen = this.equipment?.isOpen();
    const hadPendingScroll = this.intents.hasScrollTarget();
    this.intents.resetPending();
    this.equipment?.close();
    this.updateTargetMode();
    if (hadPendingScroll && restoreFocus) this.status(this.t('已取消卷轴使用。', 'Scroll use cancelled.'));
    if (wasOpen && restoreFocus) this.focusGame();
  }

  /** Toggles the source-backed Equip window (the original E shortcut). */
  toggleEquipment() {
    if (this.equipment?.isOpen()) this.closeEquipment();
    else this.openEquipment();
  }

  toggle() {
    if (this.openState) this.close();
    else this.open();
  }

  /** True while the inventory or the source-backed equip window is showing. */
  isOpen() {
    return this.openState || this.equipment?.isOpen();
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
    this.equipment?.render();
    this.renderSlots();
    this.close();
    this.closeEquipment(false);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.tooltips.destroy();
    this.drag.destroy();
    this.observer?.disconnect();
    document.removeEventListener('keydown', this.handleKeyDown, true);
    this.window?.removeEventListener('pointerdown', this.handleWindowPointerDown);
    this.window?.removeEventListener('pointermove', this.handleWindowPointerMove);
    this.window?.removeEventListener('pointerup', this.handleWindowPointerUp);
    this.window?.removeEventListener('pointercancel', this.handleWindowPointerUp);
    this.equipment?.window?.removeEventListener('pointerdown', this.handleWindowPointerDown);
    this.equipment?.window?.removeEventListener('pointermove', this.handleWindowPointerMove);
    this.equipment?.window?.removeEventListener('pointerup', this.handleWindowPointerUp);
    this.equipment?.window?.removeEventListener('pointercancel', this.handleWindowPointerUp);
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
      this.intents.resetPendingOperation();
      this.hideTooltip();
      this.refreshGatherButton();
      this.root.dataset.tab = String(index);
      this.updateTabs();
      this.renderSlots();
      this.equipment?.render();
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
    // `.inventory-tabs` lives inside `.inventory-tabs-viewport`, which
    // `updateTabMetrics()` already positions at `(tabs.left, tabs.top)` in
    // window-local coordinates.  The exported source frames still carry
    // their window-absolute `(x, y)`, so each tab has to be offset back to
    // viewport-relative space — otherwise the source-authored tab rail
    // double-applies the viewport origin and drops below the row reserved
    // for the tab strip (where the sort button sits on top of it).
    const offsetX = mode.tabs.left;
    const offsetY = mode.tabs.top;
    const frame = this.inventoryFrame(`tab:category/${state}/${index}`);
    if (frame) {
      button.style.left = `${frame.x - offsetX}px`;
      button.style.top = `${frame.y - offsetY}px`;
      button.style.width = `${frame.width}px`;
      button.style.height = `${frame.height}px`;
      button.append(this.assetImage(frame, 'inventory-tab-frame'));
      return;
    }
    button.style.left = `${index * mode.tabs.stepX}px`;
    button.style.top = '0px';
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
      if (this.intents.hasScrollTarget()) {
        this.status(this.t('请在装备栏中选择目标装备。', 'Choose the target equipment in the Equip window.'));
        return;
      }
      if (this.itemAt(slotNumber)) this.dropSlot(this.selectedTab, slotNumber);
    });
    slot.addEventListener('pointerenter', () => {
      this.tooltips.noteAnchorEnter();
      this.showSlotTooltip(slotNumber);
    });
    slot.addEventListener('pointermove', () => this.tooltips.position(slot));
    slot.addEventListener('pointerleave', () => this.tooltips.noteAnchorLeave());
    slot.addEventListener('focus', () => {
      this.tooltips.noteAnchorFocus();
      this.showSlotTooltip(slotNumber);
    });
    slot.addEventListener('blur', () => this.tooltips.noteAnchorBlur());
    this.drag.bindInventorySlot(slot, slotNumber);
    parent.append(slot);
  }

  private handleSlotClick(slotNumber: number) {
    if (this.intents.hasScrollTarget()) {
      this.status(this.t('请在装备栏中选择目标装备。', 'Choose the target equipment in the Equip window.'));
      return;
    }
    const item = this.itemAt(slotNumber);
    if (item) this.status(this.t('已选择道具 ', 'Selected ') + this.itemLabel(item));
  }

  private handleDoubleClick(slotNumber: number) {
    if (this.intents.hasScrollTarget()) {
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
    this.equipment?.render();
  }

  private receiveInventoryResult(message: Extract<ServerMessage, { type: 'inventoryResult' | 'inventoryDropResult' }>) {
    if (!message.success) {
      if (this.intents.completeUseRequest(message.requestId)) {
        this.cancelScrollTarget(false);
      }
      this.status(this.localizedError(message.code));
      return;
    }
    if (this.intents.completeUseRequest(message.requestId)) {
      this.cancelScrollTarget(false);
    }
    if (message.operation === 'gather' || message.operation === 'sort') {
      this.intents.resetPendingOperation();
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
    return itemAtSlot(this.inventory, slot, tab);
  }

  /** The current server-owned slot capacity for the visible tab. */
  private slotLimit(tab: number) {
    return slotLimitFor(this.inventorySlots, tab, this.inventoryLayout.backendSlotLimit);
  }

  private visibleItemAt(slot: number) {
    return this.itemAt(slot, this.selectedTab);
  }

  private moveSlot(sourceTab: number, sourceSlot: number, targetSlot: number) {
    this.intents.moveSlot(sourceTab, sourceSlot, targetSlot);
  }

  private dropSlot(sourceTab: number, sourceSlot: number) {
    this.intents.dropSlot(sourceTab, sourceSlot);
  }

  private inventoryAction(operation: 'gather' | 'sort') {
    this.intents.inventoryAction(operation);
  }

  private submitUseItem(sourceTab: number, sourceSlot: number, item: InventoryItem, targetSlot?: number, targetItem?: InventoryItem) {
    this.intents.submitUseItem(sourceTab, sourceSlot, item, targetSlot, targetItem);
  }

  private beginScrollTarget(sourceTab: number, sourceSlot: number, item: InventoryItem) {
    this.intents.beginScrollTarget(sourceTab, sourceSlot, item);
  }

  private cancelScrollTarget(notify: boolean) {
    this.intents.cancelScrollTarget(notify);
  }

  private updateTargetMode() {
    this.applyTargetMode(this.intents.hasScrollTarget());
  }

  private applyTargetMode(selecting: boolean) {
    this.window?.classList.toggle('inventory-selecting-target', selecting);
    if (this.targetPrompt) this.targetPrompt.hidden = !selecting;
    if (selecting) this.openEquipment();
    this.equipment?.render();
  }

  private dropMesos() {
    this.intents.dropMesos();
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

  private equippedAt(slotNumber: number) {
    return equippedAtSlot(this.equipped, slotNumber);
  }

  private unequip(item: InventoryItem) {
    const sourceSlot = -Math.abs(item.slot);
    this.submitUseItem(0, sourceSlot, item);
  }

  private showSlotTooltip(slotNumber: number) {
    const item = this.visibleItemAt(slotNumber);
    if (item) {
      const slot = this.grid?.querySelector<HTMLButtonElement>('[data-slot="' + slotNumber + '"]');
      if (slot) this.tooltips.showForItem(item, slot, this.comparisonTarget(item));
    }
  }

  private comparisonTarget(item: InventoryItem): InventoryItem | null | undefined {
    return comparisonTargetFor(item, this.equipped);
  }

  private refreshTooltip() {
    this.tooltips.refresh(anchor => {
      if (anchor.classList.contains('inventory-slot')) {
        const slot = anchor as HTMLButtonElement;
        const item = this.itemAt(Number(anchor.dataset.slot));
        if (item && !slot.hidden && !slot.disabled) {
          this.tooltips.showForItem(item, anchor, this.comparisonTarget(item));
          return true;
        }
        return false;
      }
      if (anchor.classList.contains('equipment-slot')) {
        const item = this.equippedAt(Number(anchor.dataset.slot));
        if (item) {
          this.tooltips.showForItem(item, anchor);
          return true;
        }
      }
      return false;
    });
  }

  private hideTooltip() {
    this.tooltips.hide();
  }

  private onWindowPointerDown(event: PointerEvent) {
    const window = event.currentTarget instanceof HTMLDivElement ? event.currentTarget : undefined;
    if (!window || event.button !== 0 || (window === this.window ? !this.openState : !this.equipment?.isOpen())) return;
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
      if (!this.openState && !this.equipment?.isOpen()) return;
      event.preventDefault();
      if (this.openState) this.close();
      if (this.equipment?.isOpen()) this.closeEquipment();
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
    const equipmentWindow = this.equipment?.window;
    if (equipmentWindow && this.equipmentWindowPositioned) {
      const rect = equipmentWindow.getBoundingClientRect();
      const maxLeft = Math.max(0, hostRect.width - rect.width);
      const maxTop = Math.max(0, hostRect.height - rect.height);
      const currentLeft = Number.parseFloat(equipmentWindow.style.left) || 0;
      const currentTop = Number.parseFloat(equipmentWindow.style.top) || 0;
      equipmentWindow.style.left = Math.min(maxLeft, Math.max(0, currentLeft)) + 'px';
      equipmentWindow.style.top = Math.min(maxTop, Math.max(0, currentTop)) + 'px';
    }
    this.tooltips.reposition();
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
