//! 坐骑二级管理窗。
//!
//! 骑乘与否、骑的是哪只、快多少，全部是服务端事实：本视图只显示最近的
//! `PlayerState`，并沿用既有 `useItem` + 负槽号意图。一级装备窗只负责
//! 打开这里，骑乘/解除骑乘由本管理窗执行。

import type { ClientMessage, InventoryItem, PlayerState } from '../../../../shared/protocol';
import type { AssetFrame, Manifest } from '../../assets/manifest';
import { resolveAssetUrl } from '../../assets/resource-url';
import { bringToFront, installWindowDrag } from '../ui/window-shell.ts';
import { uiLocale } from '../../app/i18n';
import { itemName } from '../inventory/names';
import { MOUNT_BODY_SLOTS, mountSpeedLabel, type MountReadout, type MountToggleTarget } from './model';
import { MountStore } from './store';
import './style.css';

export class MountStatusView {
  private readonly managerRoot: HTMLDivElement;
  private readonly managerWindow: HTMLDivElement;
  private readonly managerClose: HTMLButtonElement;
  private readonly managerStatus: HTMLParagraphElement;
  private readonly managerEquipment: HTMLDivElement;
  private readonly managerAction: HTMLButtonElement;
  private readonly managerHint: HTMLParagraphElement;
  private readonly managerDragDispose: () => void;
  private readonly store = new MountStore();
  private readonly manifest: Manifest;
  private readonly status: (message: string) => void;
  private readonly send: (message: ClientMessage) => boolean;
  private readonly unequip?: (item: InventoryItem) => void;
  private signature = '';
  private requestSequence = 0;
  private managerOpen = false;
  private equipped: InventoryItem[] = [];
  private destroyed = false;

  private readonly handleKeyDown = (event: KeyboardEvent) => {
    if (this.destroyed || !this.managerOpen || event.defaultPrevented || event.isComposing) return;
    if (event.key !== 'Escape' && event.code !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  };

  constructor(
    host: HTMLElement,
    manifest: Manifest,
    status: (message: string) => void,
    send: (message: ClientMessage) => boolean,
    unequip?: (item: InventoryItem) => void,
  ) {
    this.manifest = manifest;
    this.status = status;
    this.send = send;
    this.unequip = unequip;

    this.managerRoot = document.createElement('div');
    this.managerRoot.className = 'ui-windows tms273-mount-host';
    this.managerRoot.hidden = true;
    this.managerRoot.dataset.open = 'false';
    host.append(this.managerRoot);

    this.managerWindow = document.createElement('div');
    this.managerWindow.className = 'mount-window';
    this.managerWindow.setAttribute('role', 'dialog');
    this.managerWindow.setAttribute('aria-modal', 'false');
    this.managerWindow.setAttribute('aria-label', '坐骑管理');
    this.managerWindow.tabIndex = -1;
    this.managerWindow.hidden = true;

    const titlebar = document.createElement('div');
    titlebar.className = 'mount-titlebar';
    titlebar.setAttribute('aria-hidden', 'true');
    this.managerWindow.append(titlebar);

    const title = document.createElement('h2');
    title.className = 'mount-window-title';
    title.textContent = '坐骑管理';
    this.managerWindow.append(title);

    this.managerClose = this.createCloseButton();
    this.managerWindow.append(this.managerClose);

    const content = document.createElement('div');
    content.className = 'mount-window-content';
    const mountHeading = document.createElement('h3');
    mountHeading.className = 'mount-section-title';
    mountHeading.textContent = '骑宠';
    content.append(mountHeading);

    this.managerStatus = document.createElement('p');
    this.managerStatus.className = 'mount-manager-status';
    content.append(this.managerStatus);

    const equipmentHeading = document.createElement('h3');
    equipmentHeading.className = 'mount-section-title';
    equipmentHeading.textContent = '骑宠装备';
    content.append(equipmentHeading);

    this.managerEquipment = document.createElement('div');
    this.managerEquipment.className = 'mount-equipment-list';
    this.managerEquipment.setAttribute('aria-label', '骑宠装备');
    content.append(this.managerEquipment);

    this.managerAction = document.createElement('button');
    this.managerAction.type = 'button';
    this.managerAction.className = 'mount-window-toggle';
    this.managerAction.addEventListener('click', () => {
      const target = this.store.toggleTarget();
      if (target) this.toggle(target);
      else this.status(this.t('现在没有可骑乘的骑宠。', 'No rideable mount is equipped.'));
    });
    content.append(this.managerAction);

    this.managerHint = document.createElement('p');
    this.managerHint.className = 'mount-window-hint';
    content.append(this.managerHint);
    this.managerWindow.append(content);
    this.managerRoot.append(this.managerWindow);

    this.managerClose.addEventListener('click', () => this.close());
    this.managerDragDispose = installWindowDrag(this.managerRoot, this.managerWindow, {
      titleHeight: 30,
      isOpen: () => this.managerOpen,
      onActivate: () => bringToFront(this.managerRoot, this.managerWindow),
    });
    document.addEventListener('keydown', this.handleKeyDown, true);
    this.renderManager();
  }

  update(self: PlayerState | undefined) {
    if (this.destroyed) return;
    this.store.update(self);
    this.equipped = (self?.equipped ?? []).filter(item => MOUNT_BODY_SLOTS.includes(Math.abs(item.slot)));
    const readout = this.store.current();
    const target = this.store.toggleTarget();
    const equipmentSignature = this.equipped.map(item => `${item.slot}:${item.itemId}:${item.quantity}`).join('|');
    const signature = `${target ? `${target.itemId}:${target.slot}:${target.riding}` : ''}:${readout ? `${readout.speed}:${readout.jump}:${readout.fs}:${readout.fatigue}` : ''}:${equipmentSignature}`;
    if (signature === this.signature) return;
    this.signature = signature;
    if (this.managerOpen) this.renderManager();
  }

  clear() {
    this.store.clear();
    this.equipped = [];
    this.signature = '';
    this.close(false);
  }

  /** Open the second-level manager from the equipment window. */
  open(): boolean {
    if (this.destroyed) return false;
    this.managerOpen = true;
    this.managerRoot.hidden = false;
    this.managerRoot.dataset.open = 'true';
    this.managerWindow.hidden = false;
    bringToFront(this.managerRoot, this.managerWindow);
    this.renderManager();
    this.managerAction.focus({ preventScroll: true });
    return true;
  }

  close(restoreFocus = true) {
    const wasOpen = this.managerOpen;
    this.managerOpen = false;
    this.managerRoot.hidden = true;
    this.managerRoot.dataset.open = 'false';
    this.managerWindow.hidden = true;
    if (wasOpen && restoreFocus) document.querySelector<HTMLElement>('#game')?.focus({ preventScroll: true });
  }

  isOpen() {
    return this.managerOpen;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clear();
    this.managerDragDispose();
    document.removeEventListener('keydown', this.handleKeyDown, true);
    this.managerRoot.remove();
  }

  private renderManager() {
    const target = this.store.toggleTarget();
    const readout = this.store.current();
    if (!target) {
      this.managerStatus.textContent = this.t('尚未装备可骑乘的骑宠。', 'No rideable mount is equipped.');
      this.managerAction.hidden = true;
    } else {
      const name = itemName(target.itemId);
      const speed = target.riding && readout ? ` · ${mountSpeedLabel(readout)}` : '';
      this.managerStatus.textContent = target.riding
        ? `${this.t('骑乘中', 'Riding')}：${name}${speed}`
        : `${this.t('已装备', 'Equipped')}：${name}`;
      this.managerAction.hidden = false;
      this.managerAction.textContent = target.riding ? this.t('解除骑乘', 'Dismount') : this.t('骑乘', 'Ride');
      this.managerAction.setAttribute('aria-label', this.managerAction.textContent);
    }
    this.managerEquipment.replaceChildren();
    if (!this.equipped.length) {
      const empty = document.createElement('p');
      empty.className = 'mount-equipment-empty';
      empty.textContent = this.t('装备窗中没有骑宠或鞍具。', 'No mount or saddle is equipped.');
      this.managerEquipment.append(empty);
    } else {
      for (const item of this.equipped) this.renderEquipmentRow(item, target);
    }
    this.managerHint.textContent = target
      ? this.t('骑乘和解除骑乘在此管理，装备变化会同步角色状态。', 'Ride and dismount here; equipment changes stay in sync with the character.')
      : this.t('请先在装备窗装备可骑乘的骑宠。', 'Equip a rideable mount in the equipment window first.');
  }

  private renderEquipmentRow(item: InventoryItem, target: MountToggleTarget | undefined) {
    const row = document.createElement('div');
    row.className = 'mount-equipment-row';
    row.dataset.slot = String(Math.abs(item.slot));
    const iconFrame = this.manifest.mounts?.[item.itemId];
    if (iconFrame) {
      const icon = document.createElement('img');
      icon.className = 'mount-equipment-icon';
      this.setFrame(icon, iconFrame);
      icon.alt = '';
      icon.setAttribute('aria-hidden', 'true');
      row.append(icon);
    }
    const details = document.createElement('div');
    details.className = 'mount-equipment-details';
    const name = document.createElement('strong');
    name.textContent = Math.abs(item.slot) === 19 ? this.t('鞍具：' + itemName(item.itemId), 'Saddle: ' + itemName(item.itemId)) : itemName(item.itemId);
    const state = document.createElement('span');
    state.textContent = target?.itemId === item.itemId && target.riding
      ? this.t('骑乘中', 'Riding')
      : Math.abs(item.slot) === 19
        ? this.t('装饰装备', 'Cosmetic equipment')
        : this.t('可在此窗骑乘', 'Ready to ride here');
    details.append(name, state);
    row.append(details);
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'mount-equipment-unequip';
    action.textContent = this.t('卸下', 'Unequip');
    action.setAttribute('aria-label', `${action.textContent}${itemName(item.itemId)}`);
    action.addEventListener('click', () => {
      if (this.unequip) {
        this.unequip(item);
        return;
      }
      this.status(this.t('请从装备窗卸下这件骑宠装备。', 'Use the equipment window to unequip this mount item.'));
    });
    row.append(action);
    this.managerEquipment.append(row);
  }

  private createCloseButton() {
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'mount-window-close';
    close.title = this.t('关闭坐骑管理', 'Close Mount Manager');
    close.setAttribute('aria-label', close.title);
    const frame = this.manifest.equipmentUi?.['main/button:close/normal/0'];
    if (frame) {
      const image = document.createElement('img');
      image.className = 'mount-window-close-image';
      this.setFrame(image, frame);
      image.alt = '';
      image.setAttribute('aria-hidden', 'true');
      close.append(image);
      const setCloseState = (state: 'normal' | 'pressed' | 'mouseOver') => {
        const next = this.manifest.equipmentUi?.[`main/button:close/${state}/0`] ?? frame;
        this.setFrame(image, next);
      };
      close.addEventListener('pointerover', () => setCloseState('mouseOver'));
      close.addEventListener('pointerout', () => setCloseState('normal'));
      close.addEventListener('pointerdown', () => setCloseState('pressed'));
      close.addEventListener('pointerup', () => setCloseState('normal'));
      close.addEventListener('pointercancel', () => setCloseState('normal'));
    } else {
      close.textContent = '×';
    }
    return close;
  }

  private setFrame(element: HTMLImageElement, frame: AssetFrame) {
    element.src = resolveAssetUrl(frame.url);
    element.width = frame.width;
    element.height = frame.height;
    element.style.width = `${frame.width}px`;
    element.style.height = `${frame.height}px`;
  }

  /** 骑宠键入口：保留既有 KeyR 调用的权威 useItem 通道。 */
  toggleCurrent(): boolean {
    const target = this.store.toggleTarget();
    if (!target) {
      this.status(this.t(
        '现在没有可骑乘的骑宠：先在装备栏的坐骑管理中装备骑宠，再按这个键。',
        'No rideable mount right now: equip one in the Mount Manager first.',
      ));
      return false;
    }
    return this.toggle(target);
  }

  /** 骑乘/解除骑乘：与 KeyR 和管理窗按钮共用既有 `useItem` + 负槽号。 */
  private toggle(target: MountToggleTarget): boolean {
    const requestId = this.requestId();
    if (!this.send({
      type: 'useItem',
      requestId,
      inventoryType: 1,
      sourceSlot: -target.slot,
      itemId: target.itemId,
    })) {
      this.status(this.t('骑乘操作需要保持在线。', 'Riding actions require an online connection.'));
      return false;
    }
    this.status(this.t('正在' + (target.riding ? '解除骑乘' : '骑乘') + '…', (target.riding ? 'Dismounting' : 'Mounting') + '…'));
    return true;
  }

  private t(zh: string, en: string) {
    return uiLocale() === 'en' ? en : zh;
  }

  private requestId() {
    const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Date.now().toString(36) + '-' + (++this.requestSequence);
    return ('mount-' + random).slice(0, 64);
  }
}
