import './style.css';

import type { AssetFrame, Manifest } from '../../assets/manifest';
import { displayText, uiText } from '../../app/i18n';

export type MenuKind = 'game' | 'shortcut';
type MenuAssets = Record<string, AssetFrame>;
type MenuEntry = NonNullable<Manifest['totalMenuEntries']>[number];

const SOURCE_MENU_WIDTH = 1022;
const SOURCE_MENU_CENTER = SOURCE_MENU_WIDTH / 2;
const WIDE_MENU_HEIGHT = 569;
const WIDE_MENU_HEIGHT_MIN = 560;
const CATEGORY_X = [23, 163, 303, 443, 583, 723, 863] as const;
const CATEGORY_LABELS = ['角色', '道具', '戰鬥', '冒險', '社群', '活動・里程', '其他'] as const;

const OPERATIONS = [
  { key: 'cashShop', label: '現金商店', icon: '▣', className: 'cash' },
  { key: 'auction', label: '楓之谷拍賣', icon: '⚖', className: 'auction' },
  { key: 'channel', label: 'CH. 頻道變更', icon: 'CH.', className: 'channel' },
  { key: 'characters', label: '角色變更', icon: '♣', className: 'characters' },
  { key: 'keybind', label: '快捷鍵變更', icon: '▦', className: 'keybind' },
  { key: 'settings', label: '遊戲設定', icon: '⚙', className: 'settings' },
  { key: 'quit', label: '遊戲結束', icon: '⏻', className: 'quit' },
] as const;

/** Group source entries by their UITotalMenu column for the responsive layout. */
export function groupMenuEntries(entries: readonly MenuEntry[]): MenuEntry[][] {
  const groups = Array.from({ length: CATEGORY_X.length }, () => [] as MenuEntry[]);
  for (const entry of entries) {
    const keyColumn = Number(entry.key.split('/')[2]);
    const sourceColumn = Number.isFinite(entry.x) ? Math.round((entry.x - CATEGORY_X[0]) / 140) : 0;
    const column = Number.isInteger(keyColumn) && keyColumn >= 0 && keyColumn < groups.length
      ? keyColumn
      : Math.max(0, Math.min(groups.length - 1, sourceColumn));
    groups[column].push(entry);
  }
  return groups;
}

/** TMS273 UITotalMenu: source coordinates on wide screens, category cards on narrow screens. */
export class MenuView {
  private readonly root: HTMLDivElement;
  private active?: MenuKind;
  private anchor?: HTMLElement;
  private readonly onWindowChange = () => {
    if (!this.active) return;
    const menu = this.root.querySelector<HTMLElement>('.maple-menu');
    if (menu) this.positionMenu(menu);
  };
  private readonly onDocumentPointerDown = (event: PointerEvent) => {
    if (!this.active || !(event.target instanceof Node) || this.root.contains(event.target) || this.anchor?.contains(event.target)) return;
    this.close();
  };
  private readonly onDocumentKeyDown = (event: KeyboardEvent) => {
    if (!this.active || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  };

  constructor(
    private host: HTMLElement,
    private manifest: Manifest,
    private status: (message: string) => void,
    private onInventory?: () => void,
    private onQuit?: () => void,
    private onEquipment?: () => void,
    private onQuest?: () => void,
    private onSkills?: () => void,
    private onCharacterInfo?: () => void,
    private onChannel?: () => void,
    private onCharacters?: () => void,
    private onSettings?: () => void,
    private onNews?: () => void,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'maple-menu-layer';
    this.root.hidden = true;
    this.host.replaceChildren(this.root);
    document.addEventListener('pointerdown', this.onDocumentPointerDown, true);
    document.addEventListener('keydown', this.onDocumentKeyDown, true);
    window.addEventListener('resize', this.onWindowChange);
    window.addEventListener('scroll', this.onWindowChange, true);
  }

  isOpen() { return Boolean(this.active); }

  toggle(kind: MenuKind, anchor?: HTMLElement): boolean {
    if (this.active === kind) {
      this.close();
      return true;
    }
    return this.open(kind, anchor);
  }

  open(kind: MenuKind, anchor?: HTMLElement): boolean {
    const assets = this.assets(kind);
    if (!assets?.backgrnd) {
      this.status(kind === 'game' ? '菜单暂未开放。' : '快捷栏暂未开放。');
      return false;
    }
    const menu = this.createMenu(kind, assets);
    this.root.replaceChildren(menu);
    this.root.hidden = false;
    this.host.hidden = false;
    this.active = kind;
    this.anchor = anchor;
    this.positionMenu(menu);
    menu.querySelector<HTMLButtonElement>('.maple-menu-item')?.focus({ preventScroll: true });
    return true;
  }

  close() {
    const returnFocus = this.anchor;
    this.active = undefined;
    this.anchor = undefined;
    this.root.hidden = true;
    this.root.replaceChildren();
    if (returnFocus && document.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
  }

  destroy() {
    document.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
    document.removeEventListener('keydown', this.onDocumentKeyDown, true);
    window.removeEventListener('resize', this.onWindowChange);
    window.removeEventListener('scroll', this.onWindowChange, true);
    this.root.remove();
    this.host.replaceChildren();
    this.host.hidden = true;
    this.active = undefined;
    this.anchor = undefined;
  }

  private assets(_kind: MenuKind): MenuAssets | undefined { return this.manifest.totalMenuUi; }

  private createMenu(kind: MenuKind, assets: MenuAssets) {
    const menu = document.createElement('div');
    menu.className = `maple-menu maple-menu-${kind}`;
    menu.dataset.menuKind = kind;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', uiText(kind === 'game' ? 'menu' : 'shortcut', kind === 'game' ? '菜单' : '快捷栏'));
    menu.addEventListener('keydown', event => this.handleMenuKeyDown(event, menu));

    menu.append(this.createImage(assets.backgrnd, 'maple-menu-background'));

    const heading = document.createElement('h2');
    heading.className = 'maple-menu-heading';
    heading.textContent = uiText(kind === 'game' ? 'menu' : 'shortcut', kind === 'game' ? 'MENU' : '快捷栏');
    menu.append(heading);

    const channel = document.createElement('button');
    channel.type = 'button';
    channel.className = 'maple-menu-channel';
    channel.textContent = '主頻道';
    channel.title = displayText('頻道變更');
    channel.setAttribute('aria-label', displayText('頻道變更'));
    channel.addEventListener('click', () => this.activateOperation('channel'));
    menu.append(channel);

    const closeFrame = assets['button:close/normal/0'];
    if (closeFrame) {
      const close = this.createAssetButton('button:close', displayText('關閉'), assets, 'maple-menu-close', closeFrame);
      close.addEventListener('click', () => this.close());
      menu.append(close);
    }

    const categories = document.createElement('div');
    categories.className = 'maple-menu-categories';
    const groups = groupMenuEntries(this.manifest.totalMenuEntries ?? []);
    for (const [column, entries] of groups.entries()) {
      const category = document.createElement('section');
      category.className = 'maple-menu-category';
      category.dataset.column = String(column);
      category.style.setProperty('--menu-column-x', `${CATEGORY_X[column]}px`);

      const title = document.createElement('h3');
      title.className = 'maple-menu-category-title';
      title.textContent = displayText(CATEGORY_LABELS[column]);
      category.append(title);

      const items = document.createElement('div');
      items.className = 'maple-menu-category-items';
      for (const entry of entries) {
        const normal = assets[`${entry.key}/normal/0`];
        if (!normal) continue;
        const button = this.createAssetButton(entry.key, displayText(entry.label), assets, 'maple-menu-item', normal);
        button.dataset.menuItem = entry.key;
        button.setAttribute('role', 'menuitem');
        button.style.setProperty('--menu-entry-y', `${entry.y}px`);
        button.addEventListener('click', () => this.activateEntry(entry));
        items.append(button);
      }
      category.append(items);
      categories.append(category);
    }
    menu.append(categories);

    const hint = document.createElement('p');
    hint.className = 'maple-menu-hint';
    const hintIcon = document.createElement('span');
    hintIcon.className = 'maple-menu-hint-icon';
    hintIcon.textContent = '!';
    hintIcon.setAttribute('aria-hidden', 'true');
    hint.append(hintIcon, document.createTextNode('使用TAB鍵與方向鍵可在選單間移動。'));
    menu.append(hint);

    const operations = document.createElement('nav');
    operations.className = 'maple-menu-operations';
    operations.setAttribute('aria-label', displayText('遊戲操作'));
    for (const operation of OPERATIONS) operations.append(this.createOperation(operation, assets));
    menu.append(operations);
    return menu;
  }

  private createOperation(operation: typeof OPERATIONS[number], assets: MenuAssets) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `maple-menu-operation maple-menu-operation-${operation.className}`;
    button.dataset.menuOperation = operation.key;
    button.setAttribute('role', 'menuitem');
    button.setAttribute('aria-label', displayText(operation.label));
    button.title = displayText(operation.label);
    if (operation.key === 'quit') {
      const frame = assets['button:gameQuit/normal/0'];
      if (frame) {
        const image = this.createImage(frame, 'maple-menu-operation-image');
        button.append(image);
        this.bindButton(button, image, assets, 'button:gameQuit', frame);
      }
    }
    if (!button.childElementCount) {
      const icon = document.createElement('span');
      icon.className = 'maple-menu-operation-icon';
      icon.textContent = operation.icon;
      icon.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'maple-menu-operation-label';
      label.textContent = displayText(operation.label);
      button.append(icon, label);
    }
    button.addEventListener('click', () => this.activateOperation(operation.key));
    return button;
  }

  private activateOperation(key: string) {
    const action = key === 'channel' ? this.onChannel
      : key === 'characters' ? this.onCharacters
        : key === 'settings' ? this.onSettings
          : key === 'quit' ? this.onQuit : undefined;
    if (action) {
      this.close();
      action();
      return;
    }
    const operation = OPERATIONS.find(item => item.key === key);
    this.status(displayText(`${operation?.label ?? key}尚未实装。`));
  }

  private activateEntry(entry: MenuEntry) {
    const action = entry.type === 6 ? this.onInventory
      : entry.type === 4 ? this.onEquipment
        : entry.type === 17 ? this.onQuest
          : entry.type === 11 ? this.onSkills
            : entry.type === 0 ? this.onCharacterInfo
              : entry.type === 36 ? this.onNews : undefined;
    if (action) {
      this.close();
      action();
    } else {
      this.status(displayText(`${entry.label}尚未实装。`));
    }
  }

  private positionMenu(menu: HTMLElement) {
    const rect = this.host.getBoundingClientRect();
    const hostWidth = Math.max(0, Math.round(rect.width || this.host.clientWidth));
    const hostHeight = Math.max(0, Math.round(rect.height || this.host.clientHeight));
    const narrow = hostWidth < 1000 || hostHeight < WIDE_MENU_HEIGHT_MIN;
    const width = narrow ? hostWidth : Math.min(hostWidth, SOURCE_MENU_WIDTH);
    const height = narrow ? hostHeight : Math.min(hostHeight, WIDE_MENU_HEIGHT);
    menu.style.width = `${width}px`;
    menu.style.height = `${height}px`;
    menu.classList.toggle('maple-menu-narrow', narrow);
    menu.style.left = `${Math.max(0, Math.round((hostWidth - width) / 2))}px`;
    menu.style.top = '0';
  }

  private handleMenuKeyDown(event: KeyboardEvent, menu: HTMLElement) {
    const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
    const current = document.activeElement;
    const index = buttons.indexOf(current as HTMLButtonElement);
    if (index < 0) return;
    if (event.key === 'Tab') {
      if ((!event.shiftKey && index === buttons.length - 1) || (event.shiftKey && index === 0)) {
        event.preventDefault();
        buttons[event.shiftKey ? buttons.length - 1 : 0].focus({ preventScroll: true });
      }
      return;
    }
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as const;
    const direction = directions[event.key as keyof typeof directions];
    if (!direction) return;
    const currentRect = (current as HTMLElement).getBoundingClientRect();
    const candidates = buttons.filter(button => {
      const rect = button.getBoundingClientRect();
      const dx = rect.left + rect.width / 2 - (currentRect.left + currentRect.width / 2);
      const dy = rect.top + rect.height / 2 - (currentRect.top + currentRect.height / 2);
      return direction[0] * dx > 2 || direction[1] * dy > 2;
    });
    if (!candidates.length) return;
    event.preventDefault();
    candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
      const ax = ar.left + ar.width / 2 - (currentRect.left + currentRect.width / 2);
      const ay = ar.top + ar.height / 2 - (currentRect.top + currentRect.height / 2);
      const bx = br.left + br.width / 2 - (currentRect.left + currentRect.width / 2);
      const by = br.top + br.height / 2 - (currentRect.top + currentRect.height / 2);
      const primaryA = direction[0] ? Math.abs(ax) : Math.abs(ay);
      const primaryB = direction[0] ? Math.abs(bx) : Math.abs(by);
      const crossA = direction[0] ? Math.abs(ay) : Math.abs(ax);
      const crossB = direction[0] ? Math.abs(by) : Math.abs(bx);
      return primaryA - primaryB || crossA - crossB;
    });
    candidates[0].focus({ preventScroll: true });
  }

  private createAssetButton(key: string, label: string, assets: MenuAssets, className: string, normal: AssetFrame) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.append(this.createImage(normal, `${className}-image`));
    this.bindButton(button, button.firstElementChild as HTMLImageElement, assets, key, normal);
    return button;
  }

  private bindButton(button: HTMLButtonElement, image: HTMLImageElement, assets: MenuAssets, key: string, normal: AssetFrame) {
    const setState = (state: 'normal' | 'pressed' | 'mouseOver') => {
      image.src = (assets[`${key}/${state}/0`] ?? normal).url;
    };
    button.addEventListener('pointerover', () => setState('mouseOver'));
    button.addEventListener('pointerout', () => setState('normal'));
    button.addEventListener('pointerdown', () => setState('pressed'));
    button.addEventListener('pointerup', () => setState('normal'));
    button.addEventListener('pointercancel', () => setState('normal'));
  }

  private createImage(frame: AssetFrame, className: string) {
    const image = document.createElement('img');
    image.className = className;
    image.src = frame.url;
    image.width = frame.width;
    image.height = frame.height;
    image.alt = '';
    image.draggable = false;
    image.setAttribute('aria-hidden', 'true');
    return image;
  }
}

export const menuSourceLayout = { width: SOURCE_MENU_WIDTH, center: SOURCE_MENU_CENTER } as const;
