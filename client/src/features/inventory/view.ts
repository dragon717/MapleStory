import type { ClientMessage, PlayerState, ServerMessage } from '../../../../shared/protocol';
import type { AssetFrame, Manifest } from '../../assets/manifest';
import { protocolText, uiText } from '../../app/i18n';
import { itemCategoryTab, itemName } from './names';

const WINDOW_SMALL = { width: 175, height: 289 } as const;
const WINDOW_FULL = { width: 603, height: 289 } as const;
const GRID = { columns: 4, rows: 6, left: 8, top: 50, cellWidth: 29, cellHeight: 29, margin: 4 } as const;
const TAB_COUNT = 5;
const TAB_LABEL_KEYS = ['inventoryEquip', 'inventoryUse', 'inventorySetup', 'inventoryEtc', 'inventoryCash'] as const;

type InventoryPlayer = Pick<PlayerState, 'inventory' | 'mesos'>;
type AssetSet = Record<string, AssetFrame>;
type SendClientMessage = (message: ClientMessage) => boolean;

/**
 * Source-backed GMS83 UIWindow.img/Item window.
 *
 * Item.gd creates a 175x289 centred window, puts its MapleGridView at (8,50)
 * with four columns and six rows, and swaps to FullBackgrnd (603x289) when
 * expanded. The DOM keeps those source dimensions and coordinates on wide
 * layouts while allowing the window to remain inside the game shell on small
 * layouts.
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
  private readonly closeButton?: HTMLButtonElement;
  private readonly gatherButton?: HTMLButtonElement;
  private readonly sizeButton?: HTMLButtonElement;
  private readonly observer?: ResizeObserver;
  private readonly manifest: Manifest;
  private full = false;
  private openState = false;
  private selectedTab = 0;
  private inventory: InventoryPlayer['inventory'] = [];
  private mesos = 0;
  private slotsSignature = '';
  private draggedSlot?: number;
  private requestSequence = 0;

  constructor(private host: HTMLElement, manifest: Manifest, private status: (message: string) => void, private send: SendClientMessage = () => false) {
    this.manifest = manifest;
    this.ui = manifest.inventoryUi;
    this.closeAssets = manifest.closeButton;
    this.root = document.createElement('div');
    this.root.className = 'ui-windows';
    this.root.hidden = true;
    host.replaceChildren(this.root);
    if (!this.ui?.backgrnd || !this.closeAssets?.['normal/0']) return;

    const window = document.createElement('div');
    window.className = 'inventory-window';
    window.setAttribute('role', 'dialog');
    window.setAttribute('aria-label', uiText('inventoryTitle', '物品栏'));
    window.hidden = true;
    this.window = window;

    const background = document.createElement('img');
    background.className = 'inventory-window-background';
    background.src = this.ui.backgrnd.url;
    background.alt = '';
    background.draggable = false;
    background.setAttribute('aria-hidden', 'true');
    window.append(background);
    this.background = background;

    const title = document.createElement('span');
    title.className = 'inventory-window-title';
    title.textContent = uiText('inventoryTitle', '物品栏');
    title.setAttribute('aria-hidden', 'true');
    window.append(title);

    const tabsViewport = document.createElement('div');
    tabsViewport.className = 'inventory-tabs-viewport';
    tabsViewport.style.left = '2px';
    tabsViewport.style.top = '21px';
    const tabs = document.createElement('div');
    tabs.className = 'inventory-tabs';
    tabs.style.position = 'relative';
    tabs.style.width = 'max-content';
    for (let index = 0; index < TAB_COUNT; index++) this.createTab(tabs, index);
    tabsViewport.append(tabs);
    window.append(tabsViewport);
    this.tabs = tabs;
    this.tabsViewport = tabsViewport;
    this.tabPrev = this.createTabArrow(window, 'prev', '上一页签', -1);
    this.tabNext = this.createTabArrow(window, 'next', '下一页签', 1);
    tabsViewport.addEventListener('scroll', () => this.updateTabOverflow());

    const grid = document.createElement('div');
    grid.className = 'inventory-grid';
    grid.style.left = `${GRID.left}px`;
    grid.style.top = `${GRID.top}px`;
    grid.style.gridTemplateColumns = `repeat(${GRID.columns}, ${GRID.cellWidth + GRID.margin}px)`;
    grid.style.gridTemplateRows = `repeat(${GRID.rows}, ${GRID.cellHeight + 1}px)`;
    for (let index = 0; index < GRID.columns * GRID.rows; index++) this.createSlot(grid, index);
    window.append(grid);
    this.grid = grid;

    const mesosLine = document.createElement('div');
    mesosLine.className = 'inventory-mesos';
    mesosLine.setAttribute('aria-label', '金币');
    window.append(mesosLine);
    this.mesosLine = mesosLine;

    this.closeButton = this.createWindowButton(window, 'close', this.closeAssets, 'normal/0', () => this.close());
    this.gatherButton = this.createWindowButton(window, 'gather', this.ui, 'BtGather/normal/0', () => this.status('整理按钮已按同版窗口保留。'));
    this.sizeButton = this.createWindowButton(window, 'size', this.ui, 'BtFull/normal/0', () => this.setFull(!this.full));

    this.root.append(window);
    this.observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => this.layout());
    this.observer?.observe(host);
    this.setFull(false);
    this.layout();
    this.updateTabOverflow();
  }

  update(player: InventoryPlayer | undefined) {
    if (!this.window) return;
    if (!player) {
      this.clear();
      return;
    }
    this.inventory = player.inventory;
    this.mesos = Math.max(0, Math.floor(player.mesos));
    this.root.dataset.inventory = this.inventory.map(item => `${item.slot}:${item.itemId}:${item.quantity}`).join(',');
    this.root.dataset.mesos = String(this.mesos);
    this.renderMesos();
    const signature = this.inventory.map(item => `${item.slot}:${item.itemId}:${item.quantity}`).join('|');
    if (signature !== this.slotsSignature) {
      this.slotsSignature = signature;
      this.renderSlots();
    }
  }

  open() {
    if (!this.window) return;
    this.openState = true;
    this.host.hidden = false;
    this.root.hidden = false;
    this.window.hidden = false;
    this.layout();
  }

  close() {
    this.openState = false;
    if (this.window) this.window.hidden = true;
    this.root.hidden = true;
  }

  toggle() {
    if (this.openState) this.close();
    else this.open();
  }

  clear() {
    this.inventory = [];
    this.mesos = 0;
    this.draggedSlot = undefined;
    this.slotsSignature = '';
    this.root.dataset.inventory = '';
    this.root.dataset.mesos = '0';
    this.renderMesos();
    this.renderSlots();
    this.close();
    this.host.hidden = true;
  }

  destroy() {
    this.observer?.disconnect();
    this.root.remove();
    this.host.replaceChildren();
    this.host.hidden = true;
  }

  private createTab(parent: HTMLDivElement, index: number) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'inventory-tab';
    button.dataset.tab = String(index);
    button.style.left = `${index * 34}px`;
    button.setAttribute('aria-label', uiText(TAB_LABEL_KEYS[index], `物品栏分页 ${index + 1}`));
    button.addEventListener('click', () => {
      this.selectedTab = index;
      this.updateTabs();
      this.renderSlots();
      this.status(uiText(TAB_LABEL_KEYS[index], `物品栏分页 ${index + 1}`));
    });
    parent.append(button);
    this.updateTab(button, index);
  }

  private updateTabs() {
    this.tabs?.querySelectorAll<HTMLButtonElement>('.inventory-tab').forEach(button => {
      const index = Number(button.dataset.tab);
      this.updateTab(button, index);
    });
  }

  private createTabArrow(parent: HTMLDivElement, direction: 'prev' | 'next', label: string, amount: number) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `inventory-tab-arrow inventory-tab-arrow-${direction}`;
    button.textContent = direction === 'prev' ? '‹' : '›';
    button.setAttribute('aria-label', label);
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
    for (const piece of ['fill', 'left', 'right'] as const) {
      const frame = tabUi?.[`${piece}${state === 'enabled' ? '1' : '0'}`];
      if (!frame) continue;
      const image = document.createElement('img');
      image.className = `inventory-tab-${piece}`;
      image.src = frame.url;
      image.width = frame.width;
      image.height = frame.height;
      image.alt = '';
      image.draggable = false;
      image.setAttribute('aria-hidden', 'true');
      button.append(image);
    }
    // MapleTab adds the middle seam to every tab except the final one. Keep
    // the same 30px button plus 4px seam advance used by the source control.
    if (index !== TAB_COUNT - 1) {
      const frame = tabUi?.[`middle${state === 'enabled' ? '1' : '0'}`];
      if (frame) {
        const image = document.createElement('img');
        image.className = 'inventory-tab-middle';
        image.src = frame.url;
        image.width = frame.width;
        image.height = frame.height;
        image.alt = '';
        image.draggable = false;
        image.setAttribute('aria-hidden', 'true');
        button.append(image);
      }
    }
    const label = document.createElement('span');
    label.className = 'inventory-tab-label-text';
    label.textContent = uiText(TAB_LABEL_KEYS[index], `Tab ${index + 1}`);
    label.setAttribute('aria-hidden', 'true');
    button.append(label);
  }

  private createSlot(parent: HTMLDivElement, index: number) {
    const slotNumber = index + 1;
    const slot = document.createElement('button');
    slot.type = 'button';
    slot.className = 'inventory-slot';
    slot.dataset.slot = String(slotNumber);
    slot.setAttribute('aria-label', `物品栏空槽 ${slotNumber}`);
    slot.addEventListener('click', () => {
      const item = this.visibleItemAt(slotNumber);
      if (item) this.status(`已选择道具 ${itemName(item.itemId)} × ${item.quantity}`);
    });
    slot.addEventListener('contextmenu', event => {
      event.preventDefault();
      if (this.visibleItemAt(slotNumber)) this.dropSlot(slotNumber);
    });
    slot.addEventListener('dragstart', event => {
      const item = this.visibleItemAt(slotNumber);
      if (!item) {
        event.preventDefault();
        return;
      }
      this.draggedSlot = slotNumber;
      slot.classList.add('inventory-slot-dragging');
      event.dataTransfer?.setData('text/plain', String(slotNumber));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    slot.addEventListener('dragend', () => {
      this.draggedSlot = undefined;
      slot.classList.remove('inventory-slot-dragging');
      this.clearDragTargets();
    });
    slot.addEventListener('dragover', event => {
      const sourceSlot = this.draggedSlot;
      if (!sourceSlot || !this.visibleItemAt(sourceSlot)) return;
      // A different category may occupy this global slot while it is hidden
      // by the current tab. Do not turn that hidden item into a swap target.
      if (this.itemAt(slotNumber) && !this.visibleItemAt(slotNumber)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      slot.classList.add('inventory-slot-drag-target');
    });
    slot.addEventListener('dragleave', () => slot.classList.remove('inventory-slot-drag-target'));
    slot.addEventListener('drop', event => {
      event.preventDefault();
      const encoded = event.dataTransfer?.getData('text/plain');
      const sourceSlot = encoded ? Number(encoded) : this.draggedSlot;
      slot.classList.remove('inventory-slot-drag-target');
      this.draggedSlot = undefined;
      if (sourceSlot && Number.isInteger(sourceSlot)
        && (!this.itemAt(slotNumber) || this.visibleItemAt(slotNumber))) this.moveSlot(sourceSlot, slotNumber);
    });
    parent.append(slot);
  }

  private renderSlots() {
    if (!this.grid) return;
    const slots = Array.from(this.grid.querySelectorAll<HTMLButtonElement>('.inventory-slot'));
    for (const [index, slot] of slots.entries()) {
      const slotNumber = index + 1;
      const item = this.visibleItemAt(slotNumber);
      slot.replaceChildren();
      // Empty slots must remain event targets so an item can be dragged into
      // them.  Keep the visual/assistive empty state without disabling the
      // button, because disabled buttons do not receive dragover/drop events.
      slot.disabled = false;
      slot.draggable = Boolean(item);
      slot.classList.toggle('inventory-slot-occupied', Boolean(item));
      slot.setAttribute('aria-disabled', item ? 'false' : 'true');
      slot.setAttribute('aria-label', item ? `道具 ${itemName(item.itemId)} × ${item.quantity}` : `物品栏空槽 ${slotNumber}`);
      if (!item) {
        delete slot.dataset.itemId;
        continue;
      }
      const frame = this.manifest.items?.[item.itemId];
      if (!frame) {
        slot.dataset.itemId = item.itemId;
        continue;
      }
      slot.dataset.itemId = item.itemId;
      const icon = document.createElement('img');
      icon.className = 'inventory-item-icon';
      icon.src = frame.url;
      icon.width = frame.width;
      icon.height = frame.height;
      icon.alt = itemName(item.itemId);
      icon.draggable = false;
      slot.append(icon);
      const quantity = document.createElement('span');
      quantity.className = 'inventory-item-quantity';
      quantity.textContent = String(Math.max(0, Math.floor(item.quantity)));
      quantity.setAttribute('aria-hidden', 'true');
      slot.append(quantity);
    }
  }

  receive(message: ServerMessage) {
    if (message.type === 'pickupResult') {
      if (message.slot) this.status(`已拾取 ${itemName(message.itemId)} × ${message.quantity}（第 ${message.slot} 格）`);
      else this.status(`已拾取 ${itemName(message.itemId)} × ${message.quantity}`);
      return;
    }
    if (message.type !== 'inventoryResult' && message.type !== 'inventoryDropResult') return;
    if (!message.success) {
      this.status(`${protocolText(message.code, '物品栏操作失败')}（${message.code}）`);
      return;
    }
    if (message.operation === 'drop') this.status(`已丢弃 ${itemName(message.itemId)} × ${message.quantity}`);
    else this.status(`已移动 ${itemName(message.itemId)} × ${message.quantity}`);
  }

  private itemAt(slot: number) {
    return this.inventory.find(item => item.slot === slot);
  }

  private visibleItemAt(slot: number) {
    const item = this.itemAt(slot);
    return item && itemCategoryTab(item.itemId) === this.selectedTab ? item : undefined;
  }

  private moveSlot(sourceSlot: number, targetSlot: number) {
    const item = this.itemAt(sourceSlot);
    if (!item || sourceSlot < 1 || sourceSlot > GRID.columns * GRID.rows || targetSlot < 1 || targetSlot > GRID.columns * GRID.rows) return;
    if (!this.send({ type: 'inventoryMove', requestId: this.requestId('move'), sourceSlot, targetSlot, quantity: item.quantity })) {
      this.status('物品栏操作需要保持在线。');
      return;
    }
    this.status(`正在移动 ${itemName(item.itemId)} × ${item.quantity}…`);
  }

  private dropSlot(sourceSlot: number) {
    const item = this.itemAt(sourceSlot);
    if (!item) return;
    let quantity = item.quantity;
    if (quantity > 1) {
      const answer = window.prompt(`丢弃 ${itemName(item.itemId)} 的数量（1-${quantity}）`, String(quantity));
      if (answer === null) return;
      quantity = Number(answer);
      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > item.quantity) {
        this.status('丢弃数量无效。');
        return;
      }
    }
    if (!this.send({ type: 'dropItem', requestId: this.requestId('drop'), sourceSlot, quantity })) {
      this.status('物品栏操作需要保持在线。');
      return;
    }
    this.status(`正在丢弃 ${itemName(item.itemId)} × ${quantity}…`);
  }

  private requestId(prefix: string) {
    const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${++this.requestSequence}`;
    return `${prefix}-${random}`.slice(0, 64);
  }

  private clearDragTargets() {
    this.grid?.querySelectorAll('.inventory-slot-drag-target').forEach(slot => slot.classList.remove('inventory-slot-drag-target'));
  }

  private renderMesos() {
    if (!this.mesosLine) return;
    this.mesosLine.replaceChildren();
    const coin = this.ui?.['BtCoin/normal/0'];
    if (coin) {
      const coinImage = document.createElement('img');
      coinImage.src = coin.url;
      coinImage.width = coin.width;
      coinImage.height = coin.height;
      coinImage.alt = '';
      coinImage.draggable = false;
      this.mesosLine.append(coinImage);
    }
    const value = document.createElement('span');
    value.className = 'inventory-mesos-value';
    value.textContent = this.mesos.toLocaleString('en-US');
    this.mesosLine.append(value);
  }

  private createWindowButton(parent: HTMLDivElement, kind: string, assets: AssetSet, normalKey: string, action: () => void) {
    const normal = assets[normalKey];
    if (!normal) return undefined;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `inventory-window-button inventory-window-button-${kind}`;
    button.dataset.state = 'normal';
    button.setAttribute('aria-label', kind === 'close' ? '关闭物品栏' : kind === 'size' ? '切换物品栏大小' : '整理物品栏');
    const image = document.createElement('img');
    image.className = 'inventory-window-button-image';
    image.src = normal.url;
    image.width = normal.width;
    image.height = normal.height;
    image.alt = '';
    image.draggable = false;
    button.append(image);
    const baseKey = normalKey.slice(0, normalKey.lastIndexOf('/'));
    const setState = (state: 'normal' | 'pressed' | 'mouseOver') => {
      const frame = assets[`${baseKey}/${state}/0`] ?? normal;
      button.dataset.state = state;
      image.src = frame.url;
    };
    button.addEventListener('pointerover', () => setState('mouseOver'));
    button.addEventListener('pointerout', () => setState('normal'));
    button.addEventListener('pointerdown', () => setState('pressed'));
    button.addEventListener('pointerup', () => setState('normal'));
    button.addEventListener('click', action);
    parent.append(button);
    return button;
  }

  private setFull(full: boolean) {
    if (!this.window || !this.background || !this.ui) return;
    const fullFrame = this.ui.FullBackgrnd;
    this.full = full && Boolean(fullFrame) && this.host.clientWidth >= WINDOW_FULL.width + 12;
    const frame = this.full && fullFrame ? fullFrame : this.ui.backgrnd;
    const dimensions = this.full ? WINDOW_FULL : WINDOW_SMALL;
    this.window.style.width = `${dimensions.width}px`;
    this.window.style.height = `${dimensions.height}px`;
    this.window.dataset.size = this.full ? 'full' : 'small';
    this.background.src = frame.url;
    this.background.width = frame.width;
    this.background.height = frame.height;
    if (this.sizeButton) {
      const sizeAssets = this.ui;
      const key = this.full ? 'BtSmall/normal/0' : 'BtFull/normal/0';
      const state = sizeAssets[key];
      const image = this.sizeButton.querySelector<HTMLImageElement>('img');
      if (state && image) {
        image.src = state.url;
        image.width = state.width;
        image.height = state.height;
      }
    }
    this.positionWindowButton(this.closeButton, dimensions.width - 18, 8);
    this.positionWindowButton(this.gatherButton, dimensions.width - 33, 8);
    this.positionWindowButton(this.sizeButton, dimensions.width - 48, 8);
    this.updateGridMetrics();
    this.updateTabOverflow();
  }

  private positionWindowButton(button: HTMLButtonElement | undefined, sourceX: number, sourceY: number) {
    if (!button) return;
    const image = button.querySelector<HTMLImageElement>('img');
    const width = image?.width ?? 12;
    const height = image?.height ?? 12;
    const padding = 4;
    button.style.left = `${sourceX - width / 2 - padding}px`;
    button.style.top = `${sourceY - height / 2 - padding}px`;
    button.style.width = `${width + padding * 2}px`;
    button.style.height = `${height + padding * 2}px`;
  }

  private updateGridMetrics() {
    if (!this.grid) return;
    this.grid.style.left = `${GRID.left}px`;
    this.grid.style.top = `${GRID.top}px`;
    this.grid.style.gridTemplateColumns = `repeat(${GRID.columns}, ${GRID.cellWidth + GRID.margin}px)`;
    this.grid.style.gridTemplateRows = `repeat(${GRID.rows}, ${GRID.cellHeight + 1}px)`;
  }

  private layout() {
    if (!this.window) return;
    if (this.full && this.host.clientWidth > 0 && this.host.clientWidth < WINDOW_FULL.width + 12) this.setFull(false);
  }
}
