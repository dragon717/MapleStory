import type { ServerMessage, PlayerState } from '../../../../shared/protocol';
import type { AssetFrame, Manifest } from '../../assets/manifest';

type ReviveResult = Extract<ServerMessage, { type: 'reviveResult' }>;
type ServerReject = Extract<ServerMessage, { type: 'rejected' }>;

/**
 * Source-backed v83 death notice. The server owns death and recovery; this
 * view only presents the notice and sends the player's OK intent.
 */
export class DeathNoticeView {
  private readonly root: HTMLDivElement;
  private readonly dialog?: HTMLDivElement;
  private readonly okButton?: HTMLButtonElement;
  private pendingRequestId?: string;
  private requestSequence = 0;

  constructor(private host: HTMLElement, manifest: Manifest, private revive: (requestId: string) => boolean, private status: (message: string) => void) {
    this.root = document.createElement('div');
    this.root.className = 'death-notice-host';
    this.root.hidden = true;
    host.replaceChildren(this.root);
    const background = manifest.noticeUi?.backgrnd;
    const okAssets = manifest.okButton;
    const ok = okAssets?.['normal/0'];
    if (!background || !ok || !okAssets) return;

    const dialog = document.createElement('div');
    dialog.className = 'death-notice';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', '死亡确认');
    dialog.style.width = `${background.width}px`;
    dialog.style.height = `${background.height}px`;
    const backgroundImage = this.createImage(background, 'death-notice-background');
    backgroundImage.setAttribute('aria-hidden', 'true');
    dialog.append(backgroundImage);

    const message = document.createElement('p');
    message.className = 'death-notice-message';
    message.textContent = '你已经死亡。点击确定回到最近的城镇。';
    dialog.append(message);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'death-notice-ok';
    button.setAttribute('aria-label', '确定并回到最近的城镇');
    button.title = '确定并回到最近的城镇';
    const image = this.createImage(ok, 'death-notice-ok-image');
    button.append(image);
    this.bindButton(button, image, okAssets, ok);
    button.addEventListener('click', () => this.requestRevive(button));
    dialog.append(button);

    this.root.append(dialog);
    this.dialog = dialog;
    this.okButton = button;
  }

  update(player: Pick<PlayerState, 'action' | 'hp'> | undefined) {
    if (!this.dialog) return;
    const dead = Boolean(player && (player.action === 'dead' || player.hp <= 0));
    this.root.hidden = !dead;
    if (!dead) {
      this.pendingRequestId = undefined;
      this.okButton?.removeAttribute('disabled');
    }
  }

  receive(message: ReviveResult) {
    if (!this.pendingRequestId || message.requestId !== this.pendingRequestId) return;
    this.pendingRequestId = undefined;
    if (message.success) {
      this.root.hidden = true;
      this.okButton?.removeAttribute('disabled');
      this.status('正在回到最近的城镇。');
      return;
    }
    this.okButton?.removeAttribute('disabled');
    this.status('暂时无法回到城镇，请稍后再试。');
  }

  /** A closed/older server can reject the request instead of returning a
   * reviveResult.  Release the local pending state so the user can retry. */
  reject(message: ServerReject): boolean {
    if (!this.pendingRequestId || message.requestId !== this.pendingRequestId) return false;
    this.pendingRequestId = undefined;
    this.okButton?.removeAttribute('disabled');
    this.status('暂时无法回到城镇，请稍后再试。');
    return true;
  }

  isOpen(): boolean { return !this.root.hidden; }

  clear() {
    this.pendingRequestId = undefined;
    this.root.hidden = true;
    this.okButton?.removeAttribute('disabled');
  }

  destroy() {
    this.root.remove();
    this.host.replaceChildren();
    this.host.hidden = true;
  }

  private requestRevive(button: HTMLButtonElement) {
    if (this.pendingRequestId) return;
    const requestId = `revive-${Date.now()}-${++this.requestSequence}`;
    // Connection.send now reports whether the WebSocket was open.  Do not
    // lock the only source-backed OK button when the request could not leave
    // the browser; the next click can then retry after reconnecting.
    if (!this.revive(requestId)) {
      this.status('连接尚未就绪，请稍后再试。');
      return;
    }
    this.pendingRequestId = requestId;
    button.disabled = true;
    this.status('正在回到最近的城镇。');
  }

  private createImage(frame: AssetFrame, className: string) {
    const image = document.createElement('img');
    image.className = className;
    image.src = frame.url;
    image.width = frame.width;
    image.height = frame.height;
    image.alt = '';
    image.draggable = false;
    return image;
  }

  private bindButton(button: HTMLButtonElement, image: HTMLImageElement, assets: Record<string, AssetFrame>, normal: AssetFrame) {
    const setState = (state: 'normal' | 'pressed' | 'mouseOver') => {
      const frame = assets[`${state}/0`] ?? normal;
      image.src = frame.url;
    };
    button.addEventListener('pointerover', () => setState('mouseOver'));
    button.addEventListener('pointerout', () => setState('normal'));
    button.addEventListener('pointerdown', () => setState('pressed'));
    button.addEventListener('pointerup', () => setState('normal'));
  }
}
