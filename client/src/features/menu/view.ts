import type { AssetFrame, Manifest } from '../../assets/manifest';
import { uiText } from '../../app/i18n';

type MenuKind = 'game' | 'shortcut';
type MenuAssets = Record<string, AssetFrame>;

/** TMS273 UITotalMenu: source coordinates and source button labels. */
export class MenuView {
  private readonly root: HTMLDivElement;
  private active?: MenuKind;
  private anchor?: HTMLElement;
  private readonly onWindowChange = () => {
    if (!this.active) return;
    const menu = this.root.querySelector<HTMLElement>('.maple-menu');
    if (menu) this.positionMenu(menu, this.anchor);
  };
  private readonly onDocumentPointerDown = (event: PointerEvent) => {
    if (!this.active || !(event.target instanceof Node) || this.root.contains(event.target) || this.anchor?.contains(event.target)) return;
    this.close();
  };
  private readonly onDocumentKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !this.active) return;
    event.preventDefault();
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
  ) {
    this.root = document.createElement('div');
    this.root.className = 'maple-menu-layer';
    this.root.hidden = true;
    host.replaceChildren(this.root);
    document.addEventListener('pointerdown', this.onDocumentPointerDown, true);
    document.addEventListener('keydown', this.onDocumentKeyDown, true);
    window.addEventListener('resize', this.onWindowChange);
    window.addEventListener('scroll', this.onWindowChange, true);
  }

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
    this.positionMenu(menu, anchor);
    menu.querySelector<HTMLButtonElement>('.maple-menu-item')?.focus({ preventScroll: true });
    return true;
  }

  close() {
    this.active = undefined;
    this.anchor = undefined;
    this.root.hidden = true;
    this.root.replaceChildren();
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

  private assets(kind: MenuKind): MenuAssets | undefined {
    return this.manifest.totalMenuUi;
  }

  private createMenu(kind: MenuKind, assets: MenuAssets) {
    const background = assets.backgrnd;
    const menu = document.createElement('div');
    menu.className = `maple-menu maple-menu-${kind}`;
    menu.dataset.menuKind = kind;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', uiText(kind === 'game' ? 'menu' : 'shortcut', kind === 'game' ? '菜单' : '快捷栏'));
    menu.style.width = `${background.width}px`;
    menu.style.height = `${background.height}px`;
    menu.append(this.createImage(background, 'maple-menu-background'));

    const entries = [...(this.manifest.totalMenuEntries ?? [])];
    for (const key of ['button:close', 'button:gameQuit']) {
      const frame = assets[`${key}/normal/0`];
      if (frame) entries.push({ key, label: key === 'button:close' ? '關閉' : '結束遊戲', type: -1, x: frame.x, y: frame.y });
    }
    for (const entry of entries) {
      const normal = assets[`${entry.key}/normal/0`];
      if (!normal) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'maple-menu-item';
      button.dataset.menuItem = entry.key;
      button.setAttribute('role', 'menuitem');
      button.setAttribute('aria-label', entry.label);
      button.title = entry.label;
      Object.assign(button.style, { left: `${entry.x}px`, top: `${entry.y}px`, width: `${normal.width}px`, height: `${normal.height}px` });
      const image = this.createImage(normal, 'maple-menu-item-image');
      button.append(image);
      this.bindButton(button, image, assets, entry.key, normal);
      button.addEventListener('click', () => {
        if (entry.key === 'button:close') return this.close();
        const action = entry.key === 'button:gameQuit' ? this.onQuit
          : entry.type === 6 ? this.onInventory
          : entry.type === 4 ? this.onEquipment
          : entry.type === 17 ? this.onQuest : undefined;
        if (action) { this.close(); action(); }
        else this.status(`${entry.label}尚未實作。`);
      });
      menu.append(button);
    }
    return menu;
  }

  private positionMenu(menu: HTMLElement, anchor?: HTMLElement) {
    const hostRect = this.host.getBoundingClientRect();
    const background = this.manifest.totalMenuUi!.backgrnd;
    const compact = hostRect.width < background.width + 8 || hostRect.height < background.height + 8;
    menu.classList.toggle('maple-menu-compact', compact);
    const width = Math.min(background.width, hostRect.width - 8);
    const height = Math.min(background.height, hostRect.height - 8);
    menu.style.width = `${width}px`;
    menu.style.height = `${height}px`;
    const margin = 4;
    const availableWidth = hostRect.width || this.host.clientWidth || width + margin * 2;
    const availableHeight = hostRect.height || this.host.clientHeight || height + margin * 2;
    const anchorRect = anchor?.getBoundingClientRect();
    let left = availableWidth - width - margin;
    let top = availableHeight - height - 79;
    let arrowLeft = width / 2;
    if (anchorRect) {
      const desiredLeft = anchorRect.left - hostRect.left + (anchorRect.width - width) / 2;
      left = desiredLeft;
      top = anchorRect.top - hostRect.top - height - 8;
      if (top < margin) top = anchorRect.bottom - hostRect.top + 8;
      left = Math.max(margin, Math.min(left, availableWidth - width - margin));
      top = Math.max(margin, Math.min(top, availableHeight - height - margin));
      arrowLeft = Math.max(10, Math.min(width - 10, anchorRect.left - hostRect.left + anchorRect.width / 2 - left));
    } else {
      left = Math.max(margin, Math.min(left, availableWidth - width - margin));
      top = Math.max(margin, Math.min(top, availableHeight - height - margin));
    }
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.style.right = 'auto';
    menu.style.bottom = 'auto';
    menu.style.setProperty('--menu-arrow-left', `${Math.round(arrowLeft)}px`);
  }

  private bindButton(button: HTMLButtonElement, image: HTMLImageElement, assets: MenuAssets, key: string, normal: AssetFrame) {
    const setState = (state: 'normal' | 'pressed' | 'mouseOver') => {
      const frame = assets[`${key}/${state}/0`] ?? normal;
      image.src = frame.url;
    };
    button.addEventListener('pointerover', () => setState('mouseOver'));
    button.addEventListener('pointerout', () => setState('normal'));
    button.addEventListener('pointerdown', () => setState('pressed'));
    button.addEventListener('pointerup', () => setState('normal'));
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
