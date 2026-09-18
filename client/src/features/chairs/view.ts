//! 坐姿状态标记（第 31 项）。
//!
//! ## 只读，不提供开关按钮
//! 坐下／起立都走**既有的背包双击**：设置栏（页签 3）双击椅子 → `useItem(3, +槽, id)`
//! → 服务端 `chair_toggle`。方向由服务端点名（`chair_sit` / `chair_stand`），
//! 客户端不猜。移动输入、跳跃、普攻、技能、受击、死亡、换图也都会起身（服务端收口），
//! 因此这里**不需要**再放一个「起身」按钮——多一个入口就多一处要和权威状态对齐。
//!
//! 这块标记回答的是另一个问题：**坐下了之后还剩几秒恢复**。
//! 间隔未核定的椅子（源文案没写「每N秒」）不显示倒计时，写明「不会恢复」，
//! 而不是套一个默认秒数——套了就是编规则。

import type { PlayerState } from '../../../../shared/protocol';
import { uiLocale } from '../../app/i18n';
import { chairIntervalVerified, chairRecoveryLabel, type ChairReadout } from './model';
import { ChairStore } from './store';

export class ChairStatusView {
  private readonly root: HTMLDivElement;
  private readonly store = new ChairStore();
  /** 只在投影真的变了才重写 DOM：`#notices` 是 `aria-live="assertive"`，
   *  倒计时每秒变一次就够了，不必每拍重写。 */
  private signature = '';

  constructor(host: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'chair-status-host';
    this.root.hidden = true;
    host.append(this.root);
  }

  update(self: PlayerState | undefined) {
    this.store.update(self);
    const readout = this.store.current();
    const signature = readout ? `${readout.itemId}:${readout.recoveryHp}:${readout.recoveryMp}:${readout.secondsToRecovery ?? 'none'}` : '';
    if (signature === this.signature) return;
    this.signature = signature;
    if (!readout) {
      this.root.hidden = true;
      this.root.replaceChildren();
      return;
    }
    this.render(readout);
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

  private render(readout: ChairReadout) {
    this.root.replaceChildren();
    this.root.hidden = false;
    const t = (zh: string, en: string) => (uiLocale() === 'en' ? en : zh);

    const card = document.createElement('div');
    card.className = 'chair-status';
    card.setAttribute('role', 'status');

    const title = document.createElement('strong');
    title.textContent = `${t('坐下中', 'Seated')}：${readout.name}`;
    card.append(title);

    const recovery = chairRecoveryLabel(readout);
    if (recovery) {
      const line = document.createElement('span');
      line.className = 'chair-status-recovery';
      line.textContent = recovery;
      card.append(line);
    }

    if (chairIntervalVerified(readout)) {
      const line = document.createElement('span');
      line.className = 'chair-status-countdown';
      const interval = readout.intervalSeconds ?? 0;
      const left = readout.secondsToRecovery ?? 0;
      line.textContent = t(
        `每 ${interval} 秒恢复一次，还剩 ${left} 秒`,
        `Recovers every ${interval}s — ${left}s left`,
      );
      card.append(line);
    } else {
      // 未核定：说清"不会恢复"，而不是留空让人以为 0 秒后就来。
      const line = document.createElement('span');
      line.className = 'chair-status-unverified';
      line.textContent = t('该椅子的恢复间隔未核定，坐下不会恢复', 'No verified recovery interval: this chair restores nothing');
      card.append(line);
    }

    const hint = document.createElement('span');
    hint.className = 'chair-status-hint';
    hint.textContent = t('移动、跳跃或攻击即起身', 'Move, jump, or attack to stand up');
    card.append(hint);

    this.root.append(card);
  }
}
