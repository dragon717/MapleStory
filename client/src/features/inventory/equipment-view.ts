import type { InventoryItem } from '../../../../shared/protocol';
import type { AssetFrame, EquipmentLayout, Manifest } from '../../assets/manifest';
import { isMountItem, itemDetails, itemName } from './names';
import { MOUNT_BODY_SLOTS } from '../mounts/model';
import type { TooltipController } from './tooltip-view';
import type { DragController } from './drag-controller';

type AssetSet = Record<string, AssetFrame>;

/** 装备窗底部骑宠／鞍具行的高度。  源 `UI/Equip` 的装备画布没有 Tm/Sd 两格，
 *  所以这一行是界面扩展（P）：高度在这里定一次，窗口总高与样式表都取它。
 *  导出是为了让离线检查对着这一个数核对窗口总高，不在测试里再抄一个魔数。 */
export const MOUNT_FOOTER_HEIGHT = 52;

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
  /** 骑乘入口（審計第 30 项）：双击**已装备**的骑宠走既有的 `useItem` 通道
   *  （负槽号＝已装备），而不是卸下。道具与装备都不动，只切换骑乘状态。 */
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
  /** 底部骑宠／鞍具行的标签（键＝身体槽号）。`render()` 会改写骑宠格的文案，
   *  因为「装着骑宠」与「正在骑」是两件事，而这个区别只有标签说得清。 */
  private readonly mountLabels = new Map<number, HTMLSpanElement>();
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
    for (const slotNumber of Object.keys(this.layout.slots).map(Number)) {
      this.createSlot(equipmentWindow, slotNumber);
    }
    // TMS273's main equip canvas omits Tm/Sd. Keep equipped items reachable
    // in a web footer, using the same slot interactions as the source canvas.
    const extraSlots = MOUNT_BODY_SLOTS.filter(slot => !this.layout.slots[String(slot)]);
    if (extraSlots.length) {
      const mounts = document.createElement('div');
      mounts.className = 'equipment-mount-slots';
      // 行高与窗口总高只有**一处**数字（`MOUNT_FOOTER_HEIGHT`）：窗口高度加它，
      // 行的内部布局也从同一个自定义属性取，样式表里不再写第二个 60。
      equipmentWindow.style.setProperty('--equipment-mount-footer-height', `${MOUNT_FOOTER_HEIGHT}px`);
      for (const slot of extraSlots) {
        const group = document.createElement('div');
        group.className = 'equipment-mount-group';
        group.dataset.slot = String(slot);
        const label = document.createElement('span');
        label.className = 'equipment-mount-label';
        label.textContent = this.mountSlotLabel(slot, false);
        // 鞍具在这套数据里没有任何战斗属性（`info` 只有 tuc/reqLevel），而且它
        // 不带 `tamingMob` —— 骑乘判定只看骑宠本身。这句话是**本构建**的事实，
        // 不是对别的版本（那些版本里马鞍可能另有作用）的断言。
        if (slot !== 18) group.title = t('鞍具：装饰件，骑乘状态由骑宠决定', 'Saddle: cosmetic; riding is decided by the mount');
        group.append(label);
        this.mountLabels.set(slot, label);
        this.createSlot(group, slot);
        mounts.append(group);
      }
      equipmentWindow.append(mounts);
      equipmentWindow.style.height = `${this.layout.height + MOUNT_FOOTER_HEIGHT}px`;
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
    // 是否在骑**不从这里推**：服务器快照里的 `mount.itemId` 是唯一口径，
    // 装备里装着骑宠与真在骑是两件事（同 `mounts/model.ts` 的判据）。
    const mountedId = this.host.mountedItemId();
    equipmentWindow.classList.toggle('equipment-selecting-target', selecting);
    for (const [slot, label] of this.mountLabels) {
      const riding = mountedId !== undefined && this.host.equippedItemAt(slot)?.itemId === mountedId;
      label.textContent = this.mountSlotLabel(slot, riding);
      label.classList.toggle('is-riding', riding);
    }
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
              ? t('已装备 ' + itemName(item.itemId) + '（骑乘中，双击下马，右键卸下）', itemName(item.itemId) + ' (riding; double-click to dismount, right-click to unequip)')
              : t('已装备 ' + itemName(item.itemId) + '（双击骑乘，右键卸下）', itemName(item.itemId) + ' (double-click to ride, right-click to unequip)')
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

  /** 底部行的标签：骑宠格还要说清「现在是不是骑着」——源 UI 里没有 Tm/Sd 两格，
   *  这一行是界面扩展（P），所以这句话得由这里补上。 */
  private mountSlotLabel(slot: number, riding: boolean): string {
    const t = (zh: string, en: string) => this.host.translate(zh, en);
    if (slot !== 18) return t('鞍具', 'Saddle');
    return riding ? t('骑宠 · 骑乘中', 'Mount · riding') : t('骑宠', 'Mount');
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
      const slot = slotNumber;
      // `sourceTab` 0 = 装备页签（`TAB_INVENTORY_TYPE[0] === 1`）；负槽号＝已装备。
      this.host.useItem(0, -slot, item);
      return;
    }
    this.host.unequip(item);
  }
}
