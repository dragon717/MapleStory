/**
 * 首页右下角的客户端操作区（v3 §6.1 / §10.1）：`强制更新` 与 `下载桌面客户端`。
 *
 * 设计约束（来自计划，逐条对应代码）：
 *
 * - **不依赖 manifest / 外观 / Phaser**：这里只向 `/api/client-release` 要一份
 *   小型发布描述，地图资源坏掉时恢复按钮仍在（v3 §6.1）。因此本文件不导入
 *   `assets/manifest`，也不引用任何场景对象。
 * - **不被页面装配搬走**：节点挂在宿主（`#app`）下，与 `PageShell` 会在
 *   游戏模式下搬进消息窗的 header / footer / `#message` 是**兄弟**关系。
 * - **真 `<button>`**：支持 Tab / Enter / 焦点返回；状态区 `aria-live`。
 * - **只给出真实已发布的包**：`desktop` 为空或地址不是 http(s) 时显示
 *   「桌面版准备中」，不产生占位链接。
 *
 * 不负责：更新流程本身（`update-service.ts`）、业务会话与登录。
 */

import { uiText, uiLocale } from '../../app/i18n';
import { fetchClientRelease, type ClientRelease } from '../../platform/runtime-config';
import {
  detectPlatform, normalizeDesktopReleases, releaseFor,
  type DesktopPlatform, type DesktopRelease,
} from './desktop-downloads';
import { UpdateService, type UpdateState } from './update-service';
import './style.css';

const PLATFORM_LABEL: Record<DesktopPlatform, { zh: string; en: string }> = {
  windows: { zh: 'Windows', en: 'Windows' },
  macos: { zh: 'macOS', en: 'macOS' },
  linux: { zh: 'Linux', en: 'Linux' },
  unknown: { zh: '未知', en: 'Unknown' },
};

/** 摘要短到多少才原样显示；再长就保留首尾。 */
const REVISION_SHORT_LIMIT = 16;
/** 短形态保留的首、尾字符数（合计 14 + 省略号，正好 ≤ 上面那个上限）。 */
const REVISION_HEAD = 8;
const REVISION_TAIL = 6;

/**
 * 角标里的资源修订。
 *
 * 内容寻址的 revision 是 64 位十六进制摘要，整串放进右下角会把面板顶出边界
 * （2026-09-18 实拍：文字溢出到圆角框外，同时把中文标签挤成「当前发 布：」）。
 * 折行能让它塞进去，但三行十六进制既难看也没人读；这里只显示首尾，**完整值留在
 * `title`**——来回报障要用的仍然是整串。
 */
function displayRevision(revision: string): string {
  if (revision.length <= REVISION_SHORT_LIMIT) return revision;
  return `${revision.slice(0, REVISION_HEAD)}…${revision.slice(-REVISION_TAIL)}`;
}

export interface ClientActionsOptions {
  /** 当前页面地址；默认 `window.location.href`。 */
  href?: () => string;
  /** 导航；默认 `window.location.assign`。 */
  navigate?: (url: string) => void;
  /** 取发布描述；默认 `fetchClientRelease`。 */
  fetchRelease?: (noStore: boolean) => Promise<ClientRelease>;
  /** 平台自述；默认读 `navigator`。 */
  platformHint?: () => { source: string; platform: string };
}

export class ClientActionsView {
  private readonly root: HTMLElement;
  private readonly status: HTMLElement;
  private readonly version: HTMLElement;
  private readonly updateButton: HTMLButtonElement;
  private readonly downloadButton: HTMLButtonElement;
  private readonly confirm: HTMLElement;
  private readonly repair: HTMLInputElement;
  private readonly downloads: HTMLElement;
  private readonly service: UpdateService;
  private releases: DesktopRelease[] = [];
  private platform: DesktopPlatform = 'unknown';
  private release?: ClientRelease;
  private readonly fetchRelease?: (noStore: boolean) => Promise<ClientRelease>;

  constructor(host: HTMLElement, options: ClientActionsOptions = {}) {
    const english = uiLocale() === 'en';
    this.fetchRelease = options.fetchRelease;
    this.root = document.createElement('div');
    this.root.className = 'client-actions';
    this.root.id = 'client-actions';
    this.root.hidden = false;
    this.root.innerHTML = `
<p class="client-actions-version"><span class="client-actions-label">${uiText('clientVersion')}</span><strong data-role="version">—</strong><span class="client-actions-resource"><span class="client-actions-label">${uiText('clientResource')}</span><em data-role="resource">${uiText('clientResourceNone')}</em></span></p>
<div class="client-actions-row">
  <button type="button" data-role="update" title="${uiText('clientUpdateHint')}">${uiText('clientUpdate')}</button>
  <button type="button" data-role="download">${uiText('clientDownload')}</button>
</div>
<p class="client-actions-status" role="status" aria-live="polite" data-role="status"></p>
<div class="client-actions-confirm" data-role="confirm" hidden>
  <label><input type="checkbox" data-role="repair"> ${uiText('clientRepair')}</label>
  <div class="client-actions-row">
    <button type="button" data-role="apply">${uiText('clientApply')}</button>
    <button type="button" data-role="cancel">${uiText('clientCancel')}</button>
  </div>
</div>
<div class="client-actions-downloads" data-role="downloads" hidden aria-label="${uiText('clientDownloadTitle')}"></div>`;
    host.append(this.root);

    const pick = <T extends HTMLElement>(role: string): T =>
      this.root.querySelector<T>(`[data-role="${role}"]`)!;
    this.version = pick('version');
    this.status = pick('status');
    this.confirm = pick('confirm');
    this.downloads = pick('downloads');
    this.updateButton = pick<HTMLButtonElement>('update');
    this.downloadButton = pick<HTMLButtonElement>('download');
    this.repair = pick<HTMLInputElement>('repair');

    this.service = new UpdateService({
      navigate: options.navigate ?? (url => window.location.assign(url)),
      fetchRelease: options.fetchRelease,
      href: options.href,
    });
    this.service.onStateChange = state => this.renderState(state);

    this.updateButton.onclick = () => { void this.startUpdate(); };
    pick<HTMLButtonElement>('apply').onclick = () => {
      this.confirm.hidden = true;
      void this.service.apply(this.repair.checked);
    };
    pick<HTMLButtonElement>('cancel').onclick = () => {
      this.confirm.hidden = true;
      this.updateButton.disabled = false;
      this.setStatus('');
    };
    this.downloadButton.onclick = () => { this.downloads.hidden = !this.downloads.hidden; };

    const hint = options.platformHint?.()
      ?? (typeof navigator === 'object'
        ? { source: navigator.userAgent ?? '', platform: (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? '' }
        : { source: '', platform: '' });
    this.platform = detectPlatform(hint.source, hint.platform);
    void english;
    void this.refresh();
  }

  /** 进入频道 / 创角 / 游戏时隐藏；回到登录首页再显示（v3 §6.1）。 */
  setVisible(visible: boolean) {
    this.root.hidden = !visible;
    if (!visible) { this.confirm.hidden = true; this.downloads.hidden = true; }
  }

  destroy() {
    this.root.remove();
  }

  private async refresh() {
    try {
      const load = this.fetchRelease ?? ((noStore: boolean) => fetchClientRelease(noStore));
      const release = await load(false);
      this.release = release;
      this.releases = normalizeDesktopReleases(release.desktop);
      this.version.textContent = release.releaseId;
      const resource = this.root.querySelector<HTMLElement>('[data-role="resource"]');
      if (resource) {
        const revision = release.assetRevision;
        resource.textContent = revision ? displayRevision(revision) : uiText('clientResourceNone');
        // 完整摘要留在 title：面板只放得下首尾，报障要用的仍是整串。
        resource.title = revision ?? '';
      }
      this.renderDownloads();
    } catch {
      // 版本显示失败不影响按钮可用：强制更新本身就是要重新检查（v3 §6.1）。
      this.version.textContent = '—';
    }
  }

  private async startUpdate() {
    this.updateButton.disabled = true;
    this.confirm.hidden = true;
    this.setStatus(uiText('clientChecking'));
    const state = await this.service.check();
    // **拿到发布描述就有路可走**：确认面板里的「重新装载页面」把本页换到那份发布上。
    // `blocked`（协议 / 内容与本页不一致）也必须给这条路——它正是页面陈旧、或服务端
    // 在页面脚下换了一代的现场。此前只在 `verified` 时才给，于是「强制更新」恰好在
    // 唯一需要它的场景里失效：用户点完只看到「请更新客户端后再登录」，
    // 而按钮自己的提示写着「重新装载页面」（2026-09-22 用户实测正是如此）。
    // 状态区仍照实说明不一致的原因，只是不再扣着补救手段。
    if (state.release) this.confirm.hidden = false;
    else this.updateButton.disabled = false;
  }

  private renderState(state: UpdateState) {
    if (state.release) this.release = state.release;
    switch (state.reason) {
      case 'checking': this.setStatus(uiText('clientChecking')); break;
      case 'verified': this.setStatus(uiText('clientVerified')); break;
      case 'applying': this.setStatus(uiText('clientApplying')); break;
      case 'network': this.setStatus(uiText('clientFailed'), true); break;
      case 'bad-response': this.setStatus(uiText('clientBadResponse'), true); break;
      case 'incompatible-protocol': this.setStatus(uiText('clientBlockedProtocol'), true); break;
      case 'incompatible-content': this.setStatus(uiText('clientBlockedContent'), true); break;
      default: break;
    }
    if (state.phase !== 'checking' && state.phase !== 'applying') this.updateButton.disabled = false;
  }

  private setStatus(text: string, error = false) {
    this.status.textContent = text;
    this.status.classList.toggle('error', error);
  }

  private renderDownloads() {
    if (this.releases.length === 0) {
      // 未发布就是未发布：给原因，不给链接（v3 §10.1）。
      this.downloads.innerHTML = `<p class="client-actions-note">${uiText('clientDownloadPreparing')}</p>`;
      return;
    }
    const recommended = releaseFor(this.releases, this.platform);
    const english = uiLocale() === 'en';
    const rows = this.releases.map(release => {
      const label = PLATFORM_LABEL[release.platform];
      const name = english ? label.en : label.zh;
      const details = [
        release.arch ? `${uiText('clientDownloadArch')} ${release.arch}` : '',
        release.size ? `${uiText('clientDownloadSize')} ${release.size}` : '',
        release.publishedAt ? `${uiText('clientDownloadPublished')} ${release.publishedAt}` : '',
        release.sha256 ? `${uiText('clientDownloadSha')} ${release.sha256.slice(0, 16)}…` : '',
      ].filter(Boolean).join(' · ');
      const badge = recommended?.url === release.url ? `<span class="client-actions-badge">${uiText('clientDownloadRecommended')}</span>` : '';
      // 普通链接：大文件交给浏览器下载，不 fetch 进 JS 内存（v3 §10.1）。
      return `<li><a href="${release.url}" rel="noopener noreferrer" download><strong>${name} ${release.version}</strong>${badge}</a>${details ? `<span class="client-actions-meta">${details}</span>` : ''}</li>`;
    }).join('');
    const unknown = this.platform === 'unknown' ? `<p class="client-actions-note">${uiText('clientDownloadUnknown')}</p>` : '';
    this.downloads.innerHTML = `${unknown}<ul>${rows}</ul>`;
  }
}
