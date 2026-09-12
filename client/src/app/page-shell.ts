/**
 * 页面 shell（计划 §10.3：`app/page-shell.ts`，R8 拆出）。
 *
 * 拥有：页面 DOM 结构（原 `main.ts` 的注入模板）、语言切换、新闻弹窗
 * （`#maple-news`）与页面模式切换（欢迎页 ↔ 游戏布局的 `game-mode` 与
 * 信息区块搬移）。DOM ID、可访问性属性与布局语义逐行保留。
 * 不拥有：会话状态、窗口实例、消息状态行（`#message` 的内容仍由
 * `main.ts` 的 status() 驱动）。
 */

import { uiLocale } from './i18n';

declare const __RELEASE_VERSION__: string;
declare const __RELEASE_TIME__: string;

export function pageElement<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

export interface PageShellCallbacks {
  /** 新闻弹窗打开前（原 main.ts：input?.reset(); menus?.close()）。 */
  onShowNews?: () => void;
  /** 新闻弹窗关闭后（原 main.ts：游戏视图可见时归还游戏焦点）。 */
  onNewsClosed?: () => void;
}

export class PageShell {
  readonly news: HTMLDialogElement;
  readonly language: HTMLSelectElement;
  private readonly newsSections: Array<{ node: HTMLElement; marker: Comment }>;
  private readonly english: boolean;
  private readonly callbacks: PageShellCallbacks;

  constructor(app: HTMLElement, callbacks: PageShellCallbacks = {}) {
    this.callbacks = callbacks;
    const english = uiLocale() === 'en';
    this.english = english;
    document.addEventListener('contextmenu', event => event.preventDefault(), { capture: true });
    document.documentElement.lang = english ? 'en' : 'zh-CN';
    document.title = english ? 'MapleStory · Adventure Begins' : 'MapleStory · 冒险启程';
    const releaseLabel = `${__RELEASE_VERSION__} · ${__RELEASE_TIME__}`;
    app.innerHTML = pageTemplate(english, releaseLabel);
    this.language = pageElement<HTMLSelectElement>('language');
    this.language.onchange = () => {
      const next = this.language.value === 'en' ? 'en' : 'zh';
      try { localStorage.setItem('maple-ui-locale', next); } catch { /* Continue with the URL when storage is unavailable. */ }
      const url = new URL(window.location.href);
      url.searchParams.set('lang', next);
      window.location.assign(url.toString());
    };
    this.news = pageElement<HTMLDialogElement>('maple-news');
    this.newsSections = [document.querySelector<HTMLElement>('#app > header')!, pageElement('play').querySelector<HTMLElement>('.world-toolbar')!, pageElement('message'), document.querySelector<HTMLElement>('#app > footer')!].map(node => {
      const marker = document.createComment('page information');
      node.before(marker);
      return { node, marker };
    });
    pageElement('news-close').onclick = () => this.news.close();
    this.news.addEventListener('close', () => this.callbacks.onNewsClosed?.());
    pageElement('game-alert').onclick = () => this.showNews();
  }

  /** 打开新闻弹窗（游戏输入先复位、菜单先收起）。 */
  showNews() {
    this.callbacks.onShowNews?.();
    if (!this.news.open) this.news.showModal();
  }

  /** 欢迎页 ↔ 游戏布局：body.game-mode + 信息区块搬进弹窗/搬回页面。 */
  setPlayLayout(playing: boolean) {
    const english = this.english;
    document.body.classList.toggle('game-mode', playing);
    for (const { node, marker } of this.newsSections) {
      if (playing) pageElement('news-content').append(node);
      else marker.after(node);
    }
    if (!playing) {
      this.news.close();
      // 弹窗提示按钮与日志随欢迎页复位（定时器由调用方的 status() 管理）。
      pageElement('game-alert').hidden = true;
      pageElement('news-log').replaceChildren();
    }
    void english;
  }
}

function pageTemplate(english: boolean, releaseLabel: string): string {
  return `
<header><div class="header-brand"><span class="release-badge" aria-label="${english ? 'Release version' : '发布版本'}">${releaseLabel}</span><a class="brand" href="/" aria-label="${english ? 'MapleStory home' : 'MapleStory 首页'}"><span class="leaf">✦</span> MapleStory <small>${english ? 'Adventure Begins' : '冒险启程'}</small></a></div><div class="header-tools"><span class="connection" id="connection">${english ? 'Not connected' : '尚未连接'}</span><label class="locale-picker" for="language"><span>${english ? 'Language' : '语言'}</span><select id="language" aria-label="${english ? 'Language' : '语言'}"><option value="zh"${english ? '' : ' selected'}>简体中文</option><option value="en"${english ? ' selected' : ''}>English</option></select></label></div></header>
<main><section id="welcome"></section>
<section id="play" hidden><div class="world-toolbar"><div><span class="eyebrow">${english ? 'Current Map' : '当前地图'}</span><strong id="map-name">${english ? 'Entering…' : '正在进入…'}</strong><span id="map-route" class="map-route" hidden></span></div><span id="population">0 ${english ? 'adventurers' : '位冒险者'}</span><div class="actions"><button id="sound" type="button">${english ? 'Sound: On' : '声音：开'}</button><button id="reconnect" type="button" hidden>${english ? 'Reconnect' : '重新连接'}</button><button id="logout" type="button">${english ? 'Log out' : '退出'}</button></div></div><div id="game-shell"><aside id="boss-practice" hidden aria-label="Boss practice"><strong id="boss-title"></strong><span id="boss-detail" role="status"></span><progress id="boss-hp" max="1" value="1" hidden aria-label="Boss HP"></progress><div><button id="boss-enter" type="button"></button><button id="boss-leave" type="button">${english ? 'Leave practice' : '退出练习'}</button></div></aside><div id="game" tabindex="0" aria-label="${english ? 'Game view. Arrow keys or A D to move, up/down to climb, Space to jump, down + Space to drop through, X or Ctrl to attack, Z to pick up.' : '游戏画面，方向键或 A D 移动，上下键攀爬，空格跳跃，↓ + 空格下跳，X 或 Ctrl 普攻，Z 拾取'}"></div><div id="minimap" aria-label="${english ? 'Minimap' : '小地图'}"></div><div id="chat" aria-label="${english ? 'Chat' : '聊天框'}"></div><div id="hud" aria-label="${english ? 'Character status bar' : '角色状态栏'}"></div><div id="ui-windows" aria-live="polite"></div><div id="menus" aria-label="${english ? 'Menu' : '菜单'}"></div><div id="notices" aria-live="assertive"></div></div></section>
<p id="message" role="status" aria-live="polite"></p></main><footer>MAPLESTORY <span>${english ? 'One world · independent adventurers' : '同一世界 · 独立冒险者'}</span><span>TMS 273.7</span></footer>
<dialog id="maple-news" aria-labelledby="maple-news-title"><div class="news-heading"><h2 id="maple-news-title">${english ? 'MapleStory News' : '枫之谷消息'}</h2><button id="news-close" type="button" autofocus aria-label="${english ? 'Close' : '关闭'}">×</button></div><div id="news-content"></div><details><summary>${english ? 'Recent messages (30)' : '最近消息（30条）'}</summary><ol id="news-log"></ol></details></dialog>
<button id="game-alert" type="button" hidden aria-live="polite"></button>`;
}
