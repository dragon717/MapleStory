import type { PlayerState } from '../../../../shared/protocol';
import type { AssetFrame, Manifest } from '../../assets/manifest';

const WINDOW_SMALL = { width: 175, height: 289 } as const;
const WINDOW_FULL = { width: 603, height: 289 } as const;
const GRID = { columns: 4, rows: 6, left: 8, top: 50, cellWidth: 29, cellHeight: 29, margin: 4 } as const;
const TAB_COUNT = 5;

type InventoryPlayer = Pick<PlayerState, 'inventory' | 'mesos'>;
type AssetSet = Record<string, AssetFrame>;

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

  constructor(private host: HTMLElement, manifest: Manifest, private status: (message: string) => void) {
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
    window.setAttribute('aria-label', '物品栏');
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

    const tabs = document.createElement('div');
    tabs.className = 'inventory-tabs';
    tabs.style.left = '2px';
    tabs.style.top = '21px';
    for (let index = 0; index < TAB_COUNT; index++) this.createTab(tabs, index);
    window.append(tabs);
    this.tabs = tabs;

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
  }

  update(player: InventoryPlayer | undefined) {
    if (!this.window) return;
    if (!player) {
      this.clear();
      return;
    }
    this.inventory = player.inventory;
    this.mesos = Math.max(0, Math.floor(player.mesos));
    this.root.dataset.inventory = this.inventory.map(item => `${item.itemId}:${item.quantity}`).join(',');
    this.root.dataset.mesos = String(this.mesos);
    this.renderMesos();
    const signature = this.inventory.map(item => `${item.itemId}:${item.quantity}`).join('|');
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
    button.setAttribute('aria-label', `物品栏分页 ${index + 1}`);
    button.addEventListener('click', () => {
      this.selectedTab = index;
      this.updateTabs();
      this.status(`物品栏分页 ${index + 1}`);
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
    const label = this.ui?.[`Tab/${state}/${index}`];
    if (label) {
      const image = document.createElement('img');
      image.className = 'inventory-tab-label';
      image.src = label.url;
      image.width = label.width;
      image.height = label.height;
      image.alt = '';
      image.draggable = false;
      image.style.left = `${label.width / 8}px`;
      image.style.top = `${label.height / 8}px`;
      image.setAttribute('aria-hidden', 'true');
      button.append(image);
    }
  }

  private createSlot(parent: HTMLDivElement, index: number) {
    const slot = document.createElement('button');
    slot.type = 'button';
    slot.className = 'inventory-slot';
    slot.dataset.slot = String(index);
    slot.setAttribute('aria-label', `物品栏空槽 ${index + 1}`);
    slot.addEventListener('click', () => {
      const item = this.inventory[index];
      if (item) this.status(`已选择道具 ${item.itemId} × ${item.quantity}`);
    });
    parent.append(slot);
  }

  private renderSlots() {
    if (!this.grid) return;
    const slots = Array.from(this.grid.querySelectorAll<HTMLButtonElement>('.inventory-slot'));
    for (const [index, slot] of slots.entries()) {
      const item = this.inventory[index];
      slot.replaceChildren();
      slot.disabled = !item;
      slot.classList.toggle('inventory-slot-occupied', Boolean(item));
      slot.setAttribute('aria-label', item ? `道具 ${item.itemId} × ${item.quantity}` : `物品栏空槽 ${index + 1}`);
      if (!item) continue;
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
      icon.alt = '';
      icon.draggable = false;
      slot.append(icon);
      const quantity = document.createElement('span');
      quantity.className = 'inventory-item-quantity';
      quantity.textContent = String(Math.max(0, Math.floor(item.quantity)));
      quantity.setAttribute('aria-hidden', 'true');
      slot.append(quantity);
    }
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
    const label = document.createElement('span');
    label.className = 'inventory-mesos-label';
    label.textContent = 'mesos';
    this.mesosLine.append(label);
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
