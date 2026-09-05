import type { AssetFrame, Manifest } from '../../assets/manifest';

type MenuKind = 'game' | 'shortcut';
type MenuAssets = Record<string, AssetFrame>;

const GAME_MENU_KEYS = ['BtChannel', 'BtSkin', 'BtGameOpt', 'BtSysOpt', 'BtQuit'] as const;
const SHORTCUT_KEYS = ['BtItem', 'BtEquip', 'BtStat', 'BtSkill', 'BtParty', 'BtQuest', 'BtMessenger', 'BtGuild', 'BtComm', 'BtMobbook', 'BtRanking'] as const;
const LABELS: Record<string, string> = {
  BtChannel: '频道切换', BtSkin: '外观设置', BtGameOpt: '游戏设置', BtSysOpt: '系统设置', BtQuit: '退出游戏',
  BtItem: '物品栏', BtEquip: '装备栏', BtStat: '属性', BtSkill: '技能', BtParty: '组队', BtQuest: '任务',
  BtMessenger: '信使', BtGuild: '公会', BtComm: '社区', BtMobbook: '怪物图鉴', BtRanking: '排行榜',
};

/** Renders the source UIWindow.img menu layers without adding menu business. */
export class MenuView {
  private readonly root: HTMLDivElement;
  private active?: MenuKind;
  private readonly onDocumentPointerDown = (event: PointerEvent) => {
    if (!this.active || !(event.target instanceof Node) || this.root.contains(event.target)) return;
    this.close();
  };
  private readonly onDocumentKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !this.active) return;
    event.preventDefault();
    this.close();
  };

  constructor(private host: HTMLElement, private manifest: Manifest, private status: (message: string) => void, private onInventory?: () => void, private onQuit?: () => void) {
    this.root = document.createElement('div');
    this.root.className = 'maple-menu-layer';
    this.root.hidden = true;
    host.replaceChildren(this.root);
    document.addEventListener('pointerdown', this.onDocumentPointerDown, true);
    document.addEventListener('keydown', this.onDocumentKeyDown, true);
  }

  toggle(kind: MenuKind): boolean {
    if (this.active === kind) {
      this.close();
      return true;
    }
    return this.open(kind);
  }

  open(kind: MenuKind): boolean {
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
    menu.querySelector<HTMLButtonElement>('.maple-menu-item')?.focus({ preventScroll: true });
    return true;
  }

  close() {
    this.active = undefined;
    this.root.hidden = true;
    this.root.replaceChildren();
  }

  destroy() {
    document.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
    document.removeEventListener('keydown', this.onDocumentKeyDown, true);
    this.root.remove();
    this.host.replaceChildren();
    this.host.hidden = true;
    this.active = undefined;
  }

  private assets(kind: MenuKind): MenuAssets | undefined {
    return kind === 'game' ? this.manifest.gameMenuUi : this.manifest.shortcutUi;
  }

  private createMenu(kind: MenuKind, assets: MenuAssets) {
    const background = assets.backgrnd;
    const menu = document.createElement('div');
    menu.className = `maple-menu maple-menu-${kind}`;
    menu.dataset.menuKind = kind;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', kind === 'game' ? '菜单' : '快捷栏');
    menu.style.width = `${background.width}px`;
    menu.style.height = `${background.height}px`;
    menu.append(this.createImage(background, 'maple-menu-background'));

    const keys = kind === 'game' ? GAME_MENU_KEYS : SHORTCUT_KEYS;
    let offsetY = 28;
    for (const key of keys) {
      const normal = assets[`${key}/normal/0`];
      if (!normal) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'maple-menu-item';
      button.dataset.menuItem = key;
      button.setAttribute('role', 'menuitem');
      button.setAttribute('aria-label', LABELS[key] ?? key);
      button.title = LABELS[key] ?? key;
      button.style.left = `${Math.round(background.width / 2 - 4 - normal.width / 2)}px`;
      button.style.top = `${Math.round(offsetY - normal.height / 2)}px`;
      button.style.width = `${normal.width}px`;
      button.style.height = `${normal.height}px`;
      const image = this.createImage(normal, 'maple-menu-item-image');
      button.append(image);
      this.bindButton(button, image, assets, key, normal);
      button.addEventListener('click', () => this.activate(key));
      menu.append(button);
      offsetY += normal.height - 6;
    }
    return menu;
  }

  private activate(key: string) {
    if (key === 'BtItem' && this.onInventory) {
      this.close();
      this.onInventory();
      return;
    }
    if (key === 'BtQuit' && this.onQuit) {
      this.close();
      this.onQuit();
      return;
    }
    this.status(`${LABELS[key] ?? '此功能'}暂未开放。`);
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
