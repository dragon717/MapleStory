import type { PlayerState } from '../../../../shared/protocol';

/**
 * Away residency notice.
 *
 * The server owns the away window: it decides when residency starts, when it
 * ends, and what the current facts are.  This view only presents that state
 * and reports the player's intent.  Choosing "继续冒险" does not itself reopen
 * input — the next authoritative snapshot does.
 *
 * In dangerous maps the notice is a non-blocking banner so it never hides the
 * character the player is still responsible for.
 */
export class AwayNoticeView {
  private readonly root: HTMLDivElement;
  private showing = false;
  /** Set once the player acts on the current residency window.  Snapshots
   *  that still carry the same residency (the server has not yet confirmed
   *  the wake-up) must not re-pop the notice; only a fresh episode may. */
  private dismissed = false;

  constructor(
    private host: HTMLElement,
    private onContinue: () => void,
    private onStayAway: () => void,
    private status: (message: string) => void,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'away-notice-host';
    this.root.hidden = true;
    host.append(this.root);
  }

  /**
   * Show the residency notice once per residency episode.  Repeating
   * snapshots, reconnects, or duplicate state packets must not pop the same
   * notice again, and a player dismissal holds until the server actually
   * clears residency; only a genuinely new episode may notify again.
   */
  update(self: PlayerState | undefined) {
    if (!self?.away?.residency) {
      if (this.showing) this.dismiss();
      this.dismissed = false;
      return;
    }
    if (this.showing || this.dismissed) return;
    this.showing = true;
    this.render(self);
  }

  private render(self: PlayerState) {
    // The client has no reliable signal for whether the current map is
    // dangerous, so it always uses the non-blocking banner.  A full-screen
    // modal would hide a character that is still subject to normal world
    // rules, and inventing a "safe map" guess would be worse than not
    // guessing.  Death is the one state the server does report exactly.
    const dead = self.hp <= 0 || self.action === 'dead';
    this.root.replaceChildren();
    this.root.hidden = false;

    const card = document.createElement('div');
    card.className = 'away-notice';
    card.setAttribute('role', 'status');
    card.setAttribute('aria-label', '暂离驻留');

    const title = document.createElement('strong');
    title.textContent = '你已离开超过 10 分钟';
    card.append(title);

    const body = document.createElement('p');
    body.textContent = dead
      ? '暂离期间角色已死亡，请按当前场景规则处理。'
      : '角色已进入暂离驻留，其他玩家仍可看见你。世界继续运行，角色状态已同步。危险地图中仍可能受到伤害，点击继续冒险后恢复正常交互。';
    card.append(body);

    const remaining = self.away?.remainingMs ?? 0;
    if (remaining > 0) {
      const hint = document.createElement('span');
      hint.className = 'away-notice-remaining';
      hint.textContent = `预计驻留剩余约 ${Math.max(1, Math.round(remaining / 60000))} 分钟（以服务器为准）`;
      card.append(hint);
    }

    const actions = document.createElement('div');
    actions.className = 'away-notice-actions';
    const resume = document.createElement('button');
    resume.type = 'button';
    resume.className = 'away-notice-continue';
    resume.textContent = '继续冒险';
    resume.onclick = () => {
      this.dismissed = true;
      this.dismiss();
      this.onContinue();
    };
    const stay = document.createElement('button');
    stay.type = 'button';
    stay.className = 'away-notice-stay';
    stay.textContent = '回到选角界面';
    stay.onclick = () => {
      this.dismissed = true;
      this.dismiss();
      this.status('正在登出并回到选角界面…');
      this.onStayAway();
    };
    actions.append(resume, stay);
    card.append(actions);
    this.root.append(card);
  }

  private dismiss() {
    this.showing = false;
    this.root.hidden = true;
    this.root.replaceChildren();
  }

  clear() {
    this.dismissed = false;
    this.dismiss();
  }

  destroy() {
    this.clear();
    this.root.remove();
  }
}
