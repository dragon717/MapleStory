//! 骑乘状态标记 + 骑乘开关（第 30 项）。
//!
//! 装备窗附栏与此快捷标记共用既有 useItem 通道；状态始终来自服务端。
//!
//! ## 边界
//! * 本视图**不推导**骑乘状态：`player.mount` 在不在由服务端决定，这里只显示。
//! * 提交的槽位来自**权威装备行**（`mountToggleTarget`），不是本地 id→槽 推算；
//!   服务端还会再复核一次（不符回 `mount_mismatch`）。
//! * 状态标记只在**有可切换的坐骑**时出现；没有坐骑时整块隐藏。

import type { ClientMessage, PlayerState } from '../../../../shared/protocol';
import { uiLocale } from '../../app/i18n';
import { itemName } from '../inventory/names';
import { mountSpeedLabel, type MountReadout, type MountToggleTarget } from './model';
import { MountStore } from './store';

export class MountStatusView {
  private readonly root: HTMLDivElement;
  private readonly store = new MountStore();
  /** 只在投影真的变了才重写 DOM：`#notices` 是 `aria-live="assertive"`，
   *  每拍（服务端每 tick 推一次快照）重写会把同一句话反复播报。 */
  private signature = '';
  private requestSequence = 0;

  constructor(
    host: HTMLElement,
    private readonly status: (message: string) => void,
    private readonly send: (message: ClientMessage) => boolean,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'mount-status-host';
    this.root.hidden = true;
    host.append(this.root);
  }

  update(self: PlayerState | undefined) {
    this.store.update(self);
    const readout = this.store.current();
    const target = this.store.toggleTarget();
    const signature = target
      ? `${target.itemId}:${target.slot}:${target.riding}:${readout ? mountSpeedLabel(readout) : ''}`
      : '';
    if (signature === this.signature) return;
    this.signature = signature;
    if (!target) {
      this.root.hidden = true;
      this.root.replaceChildren();
      return;
    }
    this.render(target, readout);
  }

  clear() {
    this.store.clear();
    this.signature = '';
    this.root.hidden = true;
    this.root.replaceChildren();
  }

  destroy() {
    this.clear();
    this.root.remove();
  }

  private render(target: MountToggleTarget, readout: MountReadout | undefined) {
    this.root.replaceChildren();
    this.root.hidden = false;
    const t = (zh: string, en: string) => (uiLocale() === 'en' ? en : zh);
    const name = itemName(target.itemId);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mount-status' + (target.riding ? ' is-riding' : '');
    button.setAttribute('aria-pressed', target.riding ? 'true' : 'false');
    button.title = target.riding ? t('点击下马', 'Click to dismount') : t('点击骑乘这只坐骑', 'Click to ride this mount');
    // 读数只有**骑乘中**才有（`PlayerState.mount` 是快照字段），所以速度串在
    // 未骑乘时是空的——不要拿"装备里的那件"去猜它的速度。
    const speed = target.riding && readout ? ` · ${mountSpeedLabel(readout)}` : '';
    button.textContent = target.riding
      ? `${t('骑乘中', 'Riding')}：${name}${speed}`
      : `${t('骑乘', 'Ride')}：${name}`;
    button.setAttribute('aria-label', `${button.textContent}（${button.title}）`);
    button.addEventListener('click', () => this.toggle(target));
    this.root.append(button);
  }

  /** 上下马：与背包双击走**同一条**既有通道（`useItem` + 负槽号）。
   *  方向不由客户端决定——服务端在回执里点名 `mount_on` / `mount_off`。 */
  private toggle(target: MountToggleTarget) {
    const requestId = this.requestId();
    if (!this.send({
      type: 'useItem',
      requestId,
      inventoryType: 1,
      sourceSlot: -target.slot,
      itemId: target.itemId,
    })) {
      this.status(this.t('骑乘操作需要保持在线。', 'Riding actions require an online connection.'));
      return;
    }
    this.status(this.t('正在' + (target.riding ? '下马' : '骑乘') + '…', (target.riding ? 'Dismounting' : 'Mounting') + '…'));
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
