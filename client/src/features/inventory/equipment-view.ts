import type { InventoryItem } from '../../../../shared/protocol';
import type { AssetFrame, EquipmentLayout, Manifest } from '../../assets/manifest';
import { isMountItem, itemDetails, itemName } from './names';
import { MOUNT_BODY_SLOTS } from '../mounts/model';
import type { TooltipController } from './tooltip-view';
import type { DragController } from './drag-controller';

type AssetSet = Record<string, AssetFrame>;

/**
 * 旧版离线检查曾从这里读取底部骑宠行的高度。骑宠和鞍具已经移到坐骑
 * 二级窗，保留导出以免外部检查在切换期间失效；一级装备窗不再使用它。
 */
export const MOUNT_FOOTER_HEIGHT = 0;

/**
 * 装备窗口宿主回调（plan §8.2：装备窗口 DOM 与受控交互）。
 * 只收窄到装备窗需要的少量查询与意图出口；requestId、协议发送、
 * 卷轴阶段状态、窗口拖动状态都不在这里。
 */
export interface EquipmentHost {
  equippedItemAt(slot: number): InventoryItem | undefined;
  /** **正在骑乘**的那件骑宠（服务器快照 `PlayerState.mount` 的 `itemId`）。
   *  缺席＝没在骑。  装备里装着骑宠**不等于**在骑，所以这是第二个查询，
   *  不是从 `equippedItemAt` 推出来的。 */
  mountedItemId(): string | undefined;
  /** 卷轴目标选择进行中（影响槽位渲染与点击分支）。 */
  selectingTarget(): boolean;
  /** 物品图标帧（manifest.items 的只读查询）。 */
  itemFrame(itemId: string): AssetFrame | undefined;
  assetImage(frame: AssetFrame, className: string): HTMLImageElement;
  translate(zh: string, en: string): string;
  status(message: string): void;
  /** view 的通用源图窗控按钮工厂（装备窗 close 按钮复用）。 */
  createWindowButton(parent: HTMLDivElement, kind: 'close', assets: AssetSet, normalKey: string, action: () => void): HTMLButtonElement | undefined;
  positionWindowButton(button: HTMLButtonElement | undefined, position: { x: number; y: number }): void;
  /** 根容器显隐同步（装备窗关闭后若物品栏也关着则整组隐藏）。 */
  syncRootVisibility(): void;
  /** 卷轴目标：把已装备槽选为卷轴作用对象（提交 useItem 意图）。 */
  chooseScrollTarget(slotNumber: number, item: InventoryItem | undefined): void;
  /** 非卷轴阶段点击已装备槽的状态提示。 */
  announceSelection(item: InventoryItem): void;
  unequip(item: InventoryItem): void;
  /** 打开装备窗里的二级宠物管理。 */
  openPet?: () => void;
  /** 打开装备窗里的二级坐骑管理；坐骑窗负责骑乘/下马。 */
  openMount?: () => void;
  /** 二级坐骑窗尚未接线时的兼容出口，生产接线后骑乘统一走管理窗。 */
  useItem(sourceTab: number, sourceSlot: number, item: InventoryItem): void;
  /** close 按钮请求（view 负责 pendingScroll 清理与焦点归还）。 */
  onCloseRequest(): void;
  drag: DragController;
  tooltips: TooltipController;
}

/**
 * Source-backed TMS273 UIEquip window（R7 从 `view.ts` 拆出）。
 *
 * 拥有：装备窗口 DOM（背景/canvas/槽位/close 按钮）、开合状态、
 * 槽位渲染与点击/双击/右键交互。
 * 不拥有：装备数据真值（经 `equippedItemAt` 只读）、requestId、
 * 卷轴目标状态、窗口拖动状态。
 * 槽位几何来自 WZ 导出的 equipmentLayout，交互语义逐行来自
 * 原 `view.ts`（R7 拆分，无行为变化）。
 */
export class EquipmentView {
  private readonly windowEl?: HTMLDivElement;
  private readonly closeButton?: HTMLButtonElement;
  private openState = false;

  constructor(private readonly root: HTMLElement, manifest: Manifest, private readonly layout: EquipmentLayout, private readonly host: EquipmentHost) {
    const ui = manifest.equipmentUi;
    const backgroundFrame = ui?.backgrnd;
    const closeFrame = ui?.['main/button:close/normal/0'];
    if (!backgroundFrame || !closeFrame) return;
    const t = (zh: string, en: string) => this.host.translate(zh, en);
    const equipmentWindow = document.createElement('div');
    equipmentWindow.className = 'equipment-window';
    equipmentWindow.style.width = `${this.layout.width}px`;
    equipmentWindow.style.height = `${this.layout.height}px`;
    equipmentWindow.setAttribute('role', 'dialog');
    equipmentWindow.setAttribute('aria-modal', 'false');
    equipmentWindow.setAttribute('aria-label', t('装备栏', 'Equip Inventory'));
    equipmentWindow.tabIndex = -1;
    equipmentWindow.hidden = true;

    const background = this.host.assetImage(backgroundFrame, 'equipment-window-background');
    background.alt = '';
    background.setAttribute('aria-hidden', 'true');
    equipmentWindow.append(background);
    const equipCanvasFrame = ui?.['EquipTab/canvas:equip'];
    if (equipCanvasFrame) {
      const equipCanvas = this.host.assetImage(equipCanvasFrame, 'equipment-tab-canvas');
      equipCanvas.style.left = `${equipCanvasFrame.x}px`;
      equipCanvas.style.top = `${equipCanvasFrame.y}px`;
      equipCanvas.style.zIndex = '1';
      equipCanvas.setAttribute('aria-hidden', 'true');
      equipmentWindow.append(equipCanvas);
    }
    const title = document.createElement('span');
    title.className = 'equipment-window-title';
    title.textContent = t('装备栏', 'Equip Inventory');
    title.setAttribute('aria-hidden', 'true');
    equipmentWindow.append(title);
    equipmentWindow.append(this.createManagerEntries(ui, t));
    for (const slotNumber of Object.keys(this.layout.slots).map(Number)) {
      this.createSlot(equipmentWindow, slotNumber);
    }
    const close = this.host.createWindowButton(equipmentWindow, 'close', ui, 'main/button:close/normal/0', () => this.host.onCloseRequest());
    close?.setAttribute('aria-label', t('关闭装备栏', 'Close equip inventory'));
    if (close) close.title = t('关闭装备栏', 'Close equip inventory');
    if (close) {
      close.title = t('关闭装备栏', 'Close equipment inventory');
      close.setAttribute('aria-label', close.title);
    }
    this.host.positionWindowButton(close, this.layout.close);
    this.closeButton = close;
    this.windowEl = equipmentWindow;
    this.root.append(equipmentWindow);
  }

  get window(): HTMLDivElement | undefined {
    return this.windowEl;
  }

  isOpen() {
    return this.openState;
  }

  /** 打开窗口并重渲染（原 `openEquipment` 的窗口部分；layout 由门面负责）。 */
  open() {
    if (!this.windowEl) return;
    this.openState = true;
    this.root.hidden = false;
    this.root.dataset.open = 'true';
    this.windowEl.hidden = false;
    this.render();
    requestAnimationFrame(() => this.closeButton?.focus({ preventScroll: true }));
  }

  /** 关闭窗口并同步根容器显隐（原 `closeEquipment` 的窗口部分）。 */
  close() {
    this.openState = false;
    if (this.windowEl) this.windowEl.hidden = true;
    this.host.syncRootVisibility();
    this.host.tooltips.hide();
  }

  /** 全量重渲染装备槽（原 `renderEquipment`，逐行一致）。 */
  render() {
    const equipmentWindow = this.windowEl;
    if (!equipmentWindow) return;
    const t = (zh: string, en: string) => this.host.translate(zh, en);
    const selecting = this.host.selectingTarget();
    // 骑宠和鞍具现在由二级坐骑窗管理；一级装备窗只渲染其源画布槽位。
    const mountedId = this.host.mountedItemId();
    equipmentWindow.classList.toggle('equipment-selecting-target', selecting);
    equipmentWindow.querySelectorAll<HTMLButtonElement>('.equipment-slot').forEach(button => {
      const slotNumber = Number(button.dataset.slot);
      const item = this.host.equippedItemAt(slotNumber);
      const riding = mountedId !== undefined && item?.itemId === mountedId;
      button.replaceChildren();
      button.disabled = false;
      button.draggable = Boolean(item);
      button.classList.toggle('equipment-slot-occupied', Boolean(item));
      button.classList.toggle('equipment-slot-riding', riding);
      button.classList.toggle('equipment-slot-targetable', selecting && Boolean(item));
      if (item) {
        button.dataset.itemId = item.itemId;
        button.title = itemDetails(item.itemId, item);
        button.setAttribute('aria-label', selecting
          ? t('对 ' + itemName(item.itemId) + ' 使用卷轴', 'Use the scroll on ' + itemName(item.itemId))
            : isMountItem(item.itemId)
            ? riding
              ? t('已装备 ' + itemName(item.itemId) + '（打开坐骑管理窗下马，右键卸下）', itemName(item.itemId) + ' (open Mount Manager to dismount, right-click to unequip)')
              : t('已装备 ' + itemName(item.itemId) + '（打开坐骑管理窗骑乘，右键卸下）', itemName(item.itemId) + ' (open Mount Manager to ride, right-click to unequip)')
            : t('已装备 ' + itemName(item.itemId) + '（双击卸下）', itemName(item.itemId) + ' equipped (double-click to unequip)'));
        const frame = this.host.itemFrame(item.itemId);
        if (frame) {
          const icon = this.host.assetImage(frame, 'inventory-item-icon');
          icon.alt = itemName(item.itemId);
          icon.setAttribute('aria-hidden', 'true');
          if (this.layout.itemOffset) {
            icon.style.left = `${this.layout.itemOffset.x}px`;
            icon.style.top = `${this.layout.itemOffset.y}px`;
            icon.style.transform = 'none';
          }
          button.append(icon);
        }
      } else {
        delete button.dataset.itemId;
        button.title = selecting
          ? t('将装备拖到此槽位', 'Drop equipment here')
          : t('空装备槽', 'Empty equipment slot');
        button.setAttribute('aria-label', button.title);
      }
    });
  }

  private createSlot(parent: HTMLDivElement, slotNumber: number) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'equipment-slot';
    button.dataset.slot = String(slotNumber);
    const position = this.layout.slots[String(slotNumber)];
    if (position) {
      button.style.left = position.x + 'px';
      button.style.top = position.y + 'px';
      button.style.width = position.width + 'px';
      button.style.height = position.height + 'px';
    }
    const t = (zh: string, en: string) => this.host.translate(zh, en);
    button.addEventListener('click', () => {
      const item = this.host.equippedItemAt(slotNumber);
      const pending = this.host.selectingTarget();
      if (pending) {
        if (item) this.host.chooseScrollTarget(slotNumber, item);
        else this.host.status(t('请选择一个已装备的目标。', 'Choose an occupied equipment slot.'));
      } else if (item) {
        this.host.announceSelection(item);
      }
    });
    button.addEventListener('dblclick', () => {
      if (!this.host.selectingTarget()) {
        const item = this.host.equippedItemAt(slotNumber);
        if (item) this.onSlotActivate(slotNumber, item);
      }
    });
    button.addEventListener('contextmenu', event => {
      event.preventDefault();
      const item = this.host.equippedItemAt(slotNumber);
      const pending = this.host.selectingTarget();
      if (pending) {
        if (item) this.host.chooseScrollTarget(slotNumber, item);
      } else if (item) {
        this.host.unequip(item);
      }
    });
    button.addEventListener('pointerenter', () => {
      this.host.tooltips.noteAnchorEnter();
      const item = this.host.equippedItemAt(slotNumber);
      if (item) this.host.tooltips.showForItem(item, button);
      else this.host.tooltips.hide();
    });
    button.addEventListener('pointermove', () => this.host.tooltips.position(button));
    button.addEventListener('pointerleave', () => this.host.tooltips.noteAnchorLeave());
    button.addEventListener('focus', () => {
      this.host.tooltips.noteAnchorFocus();
      const item = this.host.equippedItemAt(slotNumber);
      if (item) this.host.tooltips.showForItem(item, button);
      else this.host.tooltips.hide();
    });
    button.addEventListener('blur', () => this.host.tooltips.noteAnchorBlur());
    this.host.drag.bindEquipmentSlot(button, slotNumber);
    parent.append(button);
  }

  /** Only a source-declared mount toggles riding; saddles remain removable. */
  private onSlotActivate(slotNumber: number, item: InventoryItem) {
    if (MOUNT_BODY_SLOTS.includes(slotNumber) && isMountItem(item.itemId)) {
      if (this.host.openMount) {
        this.host.openMount();
        return;
      }
      const slot = slotNumber;
      // `sourceTab` 0 = 装备页签（`TAB_INVENTORY_TYPE[0] === 1`）；负槽号＝已装备。
      this.host.useItem(0, -slot, item);
      return;
    }
    this.host.unequip(item);
  }

  /**
   * 一级装备窗只保留两个原版入口；骑宠、鞍具以及宠物操作都由各自的
   * 二级窗承载；宠物入口只使用 UIEquip 已导出的第二个 detailTab 帧。
   */
  private createManagerEntries(assets: AssetSet, t: (zh: string, en: string) => string) {
    const bar = document.createElement('div');
    bar.className = 'equipment-manager-entries';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', t('宠物与坐骑管理', 'Pet and mount managers'));
    bar.append(
      this.createManagerEntry('pet', t('宠物', 'Pets'), assets, t),
      this.createManagerEntry('mount', t('坐骑', 'Mounts'), assets, t),
    );
    return bar;
  }

  private createManagerEntry(
    kind: 'pet' | 'mount',
    label: string,
    assets: AssetSet,
    t: (zh: string, en: string) => string,
  ) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `equipment-manager-entry equipment-manager-entry-${kind}`;
    button.dataset.manager = kind;
    button.setAttribute('aria-label', label);
    button.title = label;
    const frame = this.managerFrame(kind, assets);
    if (frame) {
      button.dataset.sourceArt = 'true';
      const image = this.host.assetImage(frame, 'equipment-manager-entry-image');
      image.alt = '';
      image.setAttribute('aria-hidden', 'true');
      image.draggable = false;
      button.append(image);
    }
    const text = document.createElement('span');
    text.className = 'equipment-manager-entry-label';
    text.textContent = label;
    button.append(text);
    button.addEventListener('click', () => {
      const action = kind === 'pet' ? this.host.openPet : this.host.openMount;
      if (action) {
        action();
        return;
      }
      this.host.status(t(
        kind === 'pet' ? '宠物管理窗尚未接入。' : '坐骑管理窗尚未接入。',
        kind === 'pet' ? 'Pet Manager is not connected.' : 'Mount Manager is not connected.',
      ));
    });
    return button;
  }

  private managerFrame(kind: 'pet' | 'mount', assets: AssetSet) {
    const candidates = kind === 'pet'
      // UIEquip's authored second tab is the pet page.  It is a tab frame,
      // not a guessed button from another WZ family.
      ? ['main/tab:detailTab/normal/1', 'main/tab:detailTab/selected/1']
      : [];
    for (const key of candidates) {
      const frame = assets[key];
      if (frame) return frame;
    }
    // This TMS273 source has no authored TamingMob tab/button.  The mount
    // manager intentionally remains a same-shell P entry with its own label;
    // never borrow Pet/HUD/menu art and present it as a source mount control.
    return undefined;
  }
}
