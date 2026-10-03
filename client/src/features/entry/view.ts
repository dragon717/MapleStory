import type { LoginResponse } from '../../../../shared/protocol';
import type { AssetFrame, Manifest } from '../../assets/manifest';
import { authenticate, VersionMismatchError } from '../../network/auth-api';
import { browserHealDeps, healStalePage } from '../client-actions/version-heal';
import { uiLocale, displayText } from '../../app/i18n';
import { lobbyRequest, type Appearance, type CharacterList, type CharacterSummary } from './api';
import { appearanceLayer, appearanceWeaponType, cashAppearanceEntry, composeAppearance, initialEquipment, loadAppearanceLayers, normalizeAppearanceItemId, type AppearanceCatalog } from './appearance';
import { resolveAssetUrl } from '../../assets/resource-url';
import './style.css';
import './voyage.css';
import type { EntryVoyage } from './voyage';
import type { EntryMusic } from './music';
import type { Part } from '../../assets/avatar-types';

type Stage = 'login' | 'channel' | 'characters' | 'create';
type SceneArt = { width: number; height: number; layers: Pick<AssetFrame, 'url' | 'x' | 'y' | 'width' | 'height'>[] };
export interface EntryAssets { scenes: Partial<Record<Stage, SceneArt>>; bgm?: string; effects?: { empty: AssetFrame[] } }
interface GenderOptions { gender: number; face: number[]; hair: number[]; hairColors: Record<string, number[]>; coat: number[]; pants: number[]; shoes: number[]; weapon: number[] }
interface CreationCatalog { source: string; skin: number[]; genders: GenderOptions[]; names: Record<string, string> }
const text = (zh: string, en: string) => uiLocale() === 'en' ? en : zh;
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const jobName = (job: number) => job === 0 ? text('新手', 'Beginner') : job === 200 ? text('法师', 'Magician') : job === 220 ? text('巫师（冰、雷）', 'Wizard (Ice, Lightning)') : String(job);
const SKIP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5v14l10-7zM18 5h2v14h-2z"/></svg>';
const MUSIC_ON_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h4l5 4V6l-5 4H4zm11.5-3.2a1 1 0 0 0-1.1 1.7A4.8 4.8 0 0 1 17 12a4.8 4.8 0 0 1-2.6 3.5 1 1 0 1 0 1.1 1.7A6.8 6.8 0 0 0 19 12a6.8 6.8 0 0 0-3.5-5.2z"/></svg>';
const MUSIC_OFF_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h4l5 4V6l-5 4H4zm13.4-2.1-1.3 1.3 1.8 1.8-1.8 1.8 1.3 1.3 1.8-1.8 1.8 1.8 1.3-1.3-1.8-1.8 1.8-1.8-1.3-1.3-1.8 1.8-1.8-1.8z"/></svg>';

export class EntryView {
  /** 首页阶段通知（v3 §6.1）：进入频道 / 角色选择 / 创角后应隐藏首页右下角的
   *  客户端操作区，回到登录首页再显示。只读通知，不改变本视图任何流程。 */
  onStageChange?: (stage: Stage) => void;
  private session?: LoginResponse;
  private stage: Stage = 'login';
  private characters: CharacterSummary[] = [];
  private selected?: string;
  private slotLimit = 12;
  private register = false;
  private busy = false;
  private revision = 0;
  private assets?: EntryAssets;
  private manifest?: Manifest;
  private appearance?: Appearance;
  private catalog?: CreationCatalog;
  private avatarCatalog?: AppearanceCatalog;
  private createRequestId = '';
  private checkedName = '';
  private draftName = '';
  private page = 0;
  private note = '';
  private error = false;
  private animation?: number;
  private voyage?: EntryVoyage;
  private loadingVoyage = false;
  private profession = 0;
  private createdOnDeck = false;
  private closedFaces: Record<string, Part> = {};
  /** Cash appearance layers already requested for the equipped list. */
  private appearanceLayerRequests = new Set<string>();
  /** Cash appearance layers whose file failed; never refetched this session. */
  private appearanceLayerFailures = new Set<string>();
  constructor(private host: HTMLElement, private enter: (session: LoginResponse, ready: () => Promise<boolean>) => Promise<void>, private music?: EntryMusic) {
    if (music) music.onChange = () => this.updateMusicButton();
    this.render();
    void this.loadArt();
    // 进入首页就**静默核对一次发布**：本页若已经陈旧（服务端在发布时于本页脚下
    // 换了一代，或这次载入拿到的是被缓存的旧 HTML/旧包），立刻收敛到服务端当前
    // 发布，不必等玩家点「登录」才把「请刷新页面」摆到脸上。
    // 与本页同一版时是**空操作**（`describesThisBuild` 一致即不导航），正常加载
    // 不会多跳；`typeof` 兜底让没有 `location` 的 node 离线检查照旧能装载本模块。
    if (typeof location === 'object') void healStalePage(browserHealDeps(location.href));
  }
  private loadVoyage() {
    if (this.voyage || this.loadingVoyage || this.host.hidden) return;
    this.loadingVoyage = true;
    void import('./voyage').then(({ EntryVoyage }) => {
      if (this.host.hidden) return;
      this.voyage = new EntryVoyage(this.host, error => { if (error) this.setNote(error, true); else this.renderPreviews(); });
      this.voyage.onAdventure = () => { if (!this.busy) void this.run(() => this.startGame()); };
      this.voyage.onCabin=()=>{if(!this.busy)this.go('characters');};
      this.voyage.onDeck=()=>{if(!this.busy)this.go('channel');};
      this.voyage.onCreate=slot=>{if(!this.busy && slot>=this.characters.length && slot<this.slotLimit){this.page=Math.floor(slot/4);this.action('create');}};
      this.voyage.onCharacter=id=>{if(!this.busy && this.characters.some(character=>character.id===id)){this.selected=id;this.page=Math.floor(this.characters.findIndex(character=>character.id===id)/4);this.render();this.voyage?.openRoleDetails();}};
      this.voyage.setStage(this.stage);
      this.voyage.setPassengers(this.characters.map(c => c.id), this.selected, this.page, this.slotLimit);
      const target = this.host.querySelector<HTMLElement>('.entry-background');
      if (target) this.voyage.attach(target);
    }).catch(() => { this.host.classList.add('voyage-unavailable'); this.setNote(text('3D场景暂不可用，仍可登录。', '3D scenery is unavailable. You can still log in.'), true); })
      .finally(() => { this.loadingVoyage = false; });
  }
  private async loadArt() {
    try {
      const [artResponse, manifestResponse, catalogResponse, appearanceResponse, sleepResponse] = await Promise.all([fetch(resolveAssetUrl('/assets/entry/manifest.json')), fetch(resolveAssetUrl('/assets/manifest.json')), fetch(resolveAssetUrl('/assets/entry/creation.json')), fetch(resolveAssetUrl('/assets/entry/appearance.json')), fetch(resolveAssetUrl('/assets/entry/voyage-sleep.json'))]);
      if (!artResponse.ok || !manifestResponse.ok) throw new Error(text('登录素材加载失败，请刷新重试。', 'Unable to load entry artwork. Refresh to retry.'));
      this.assets = await artResponse.json();
      this.manifest = await manifestResponse.json();
      const bgm = this.manifest?.mapCatalog?.maps.find(map => map.id === '200000000')?.bgm;
      if (bgm) this.music?.setTrack(bgm);
      if (!catalogResponse.ok) throw new Error(text('创角配置加载失败，请刷新重试。', 'Unable to load character creation options.'));
      this.catalog = await catalogResponse.json();
      if (!appearanceResponse.ok) throw new Error("角色外观资源加载失败");
      this.avatarCatalog = await appearanceResponse.json();
      if (sleepResponse.ok) this.closedFaces = (await sleepResponse.json()).faces;
      this.chooseGender(0);
      this.renderOptions();
      this.renderBackground();
      this.renderPreviews();
    } catch (error) { this.setNote(error instanceof Error ? error.message : String(error), true); }
  }
  showLogin() {
    const session = this.session;
    if (session) void lobbyRequest(session, 'logout').catch(() => { /* Local logout also works after expiry or transport loss. */ });
    this.revision++; this.createdOnDeck = false; this.page = 0; this.session = undefined; this.characters = []; this.selected = undefined; this.host.hidden = false; this.go('login');
  }
  async returnTo(stage: 'channel' | 'characters') {
    this.revision++;
    this.host.hidden = false;
    document.body.classList.add('entry-active');
    if (!this.session) { this.setStage('login'); this.render(); return; }
    this.setStage(stage);
    await this.run(async () => { await this.refreshCharacters(); this.render(); });
  }
  private async refreshCharacters() {
    const result = await lobbyRequest<CharacterList>(this.session!, 'list');
    this.characters = result.characters;
    this.slotLimit = result.slotLimit;
    if (!this.characters.some(character => character.id === this.selected)) this.selected = this.characters[0]?.id;
  }
  private setNote(note: string, error = false) {
    this.note = note; this.error = error;
    const target = this.host.querySelector<HTMLElement>('.entry-notice');
    if (target) { target.textContent = note; target.classList.toggle('entry-error', error); target.hidden = !note; }
  }
  private async run(action: () => Promise<void>) {
    if (this.busy) return;
    this.busy = true;
    const revision = this.revision;
    this.setNote('');
    this.setBusy();
    try { await action(); }
    catch (error) {
      // 版本不一致不是「登录失败」，而是**这一页已经过期**（服务端在发布时于本页
      // 脚下换了一代）。先试着导航到服务端当前发布上，把「换一份一致的客户端」
      // 从「请用户自己按 F5」变成自动的；已经导航走就不必再显示那句文案。
      if (await this.recoverStalePage(error)) return;
      if (revision === this.revision) this.setNote(error instanceof Error ? error.message : String(error), true);
    }
    finally { this.busy = false; this.setBusy(); }
  }
  /**
   * 页面陈旧时自愈：交给 `client-actions` 既有的发布链路（发布描述 + 入口地址）。
   * 返回真表示**已经在导航**、本页即将被卸载，调用方不应再显示错误。
   * 取不到描述、或服务端发布与本页同一版时返回假，调用方照旧报原文案。
   */
  private async recoverStalePage(error: unknown): Promise<boolean> {
    if (!(error instanceof VersionMismatchError)) return false;
    return (await healStalePage(browserHealDeps(location.href))) === 'reloaded';
  }
  private setBusy() {
    this.host.setAttribute('aria-busy', String(this.busy));
    this.host.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = this.busy || button.dataset.unavailable === 'true'; });
  }
  private go(stage: Stage) { this.setStage(stage); this.setNote(''); this.render(); }
  private setStage(stage: Stage) {
    if (this.stage === stage) return;
    this.stage = stage;
    this.onStageChange?.(stage);
  }
  private render() {
    this.music?.setActive(true);
    cancelAnimationFrame(this.animation ?? 0);
    const ready = this.host.classList.contains('entry-voyage-ready');
    const unavailable = this.host.classList.contains('voyage-unavailable');
    this.voyage?.canvas.remove();
    this.host.className = `entry entry-voyage entry-stage-${this.stage}${ready ? ' entry-voyage-ready' : ''}${unavailable ? ' voyage-unavailable' : ''}${this.createdOnDeck && this.stage === 'channel' ? ' voyage-leaving-cabin' : ''}`;
    document.body.classList.add('entry-active');
    this.host.innerHTML = `<div class="entry-background" aria-hidden="true"></div><div class="entry-brand">${text('冒险岛', 'MapleStory')}<small>TMS 273.7 · ${text('天空航船', 'Sky Voyage')}</small></div><div class="entry-top-tools">${this.stage === 'login' ? `<button type="button" class="entry-icon-button" data-action="skip-voyage" aria-label="${text('跳过航程', 'Skip voyage')}" title="${text('跳过开场航程', 'Skip opening voyage')}">${SKIP_ICON}<span class="entry-sr-only">${text('跳过航程', 'Skip voyage')}</span></button>` : ''}${this.music ? `<button type="button" class="entry-icon-button entry-music-button" data-action="entry-music" aria-pressed="false">${MUSIC_ON_ICON}<span class="entry-sr-only">${text('音乐：开', 'Music: on')}</span></button>` : ''}</div><div class="entry-scene">${this.stage === 'login' ? this.loginMarkup() : this.stage === 'channel' ? this.channelMarkup() : this.stage === 'characters' ? this.charactersMarkup() : this.createMarkup()}</div><nav class="entry-navigation" aria-label="${text('大厅导航', 'Lobby navigation')}">${this.stage !== 'login' ? `<button type="button" data-action="first">‹ ${text('切换登录', 'Switch login')}</button><button type="button" data-action="back">‹ ${text('返回', 'BACK')}</button>` : ''}</nav><p class="entry-notice${this.error ? ' entry-error' : ''}" role="status"${this.note ? '' : ' hidden'}>${escape(this.note)}</p><div class="entry-edition">${text('天空之城航线', 'Route to Orbis')} · <a href="https://poly.pizza/m/dw-IMS0xk71" target="_blank" rel="noreferrer">Wings: Michael Fuchs</a> (<a href="https://creativecommons.org/licenses/by/3.0/" target="_blank" rel="noreferrer">CC BY 3.0</a>, scaled/recolored)</div>`;
    this.renderBackground();
    const background = this.host.querySelector<HTMLElement>('.entry-background');
    if (background && this.voyage) { this.voyage.attach(background); this.voyage.setStage(this.stage); }
    this.voyage?.setPassengers(this.characters.map(c => c.id), this.selected, this.page, this.slotLimit);
    this.bind();
    this.host.querySelector<HTMLButtonElement>('[data-action="entry-music"]')?.addEventListener('click', () => this.music!.setMuted(!this.music!.muted));
    this.updateMusicButton();
    this.renderOptions();
    this.renderPreviews();
    this.setBusy();
    this.loadVoyage();
    if (this.stage === 'channel') this.createdOnDeck = false;
  }
  private loginMarkup() {
    let savedId = '';
    try { savedId = localStorage.getItem('maple-saved-id') ?? ''; } catch { /* Optional preference. */ }
    return `<form id="login" class="entry-login entry-glass"><h1>${this.register ? text('创建账号', 'Create Account') : text('冒险岛', 'MapleStory')}</h1><div class="entry-login-fields"><label class="entry-sr-only" for="username">Maple ID</label><input id="username" name="username" autocomplete="username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9_\\-]{3,32}" placeholder="Maple ID" value="${escape(savedId)}"><label class="entry-save"><input type="checkbox" id="save-id"${savedId ? ' checked' : ''}> ${text('记住账号', 'Save ID')}</label><label class="entry-sr-only" for="password">${text('密码', 'Password')}</label><input id="password" name="password" type="password" autocomplete="${this.register ? 'new-password' : 'current-password'}" required minlength="8" maxlength="128" placeholder="${text('密码（至少8位）', 'Password (at least 8 characters)')}"></div><button class="entry-primary" id="submit" type="submit">${this.register ? text('注册', 'Register') : text('开始游戏', 'Start game')}</button><div class="entry-login-links"><button type="button" id="mode">${this.register ? text('返回登录', 'Back to Log In') : text('注册账号', 'Create Account')}</button><span>|</span><button type="button" data-action="help">${text('帮助', 'Help')}</button><span>|</span><button type="button" data-action="language">${uiLocale() === 'en' ? '简体中文' : 'English'}</button></div></form>`;
  }
  private worldBadge() { return `<div class="entry-world-badge entry-glass"><span class="entry-world-emblem">🍁</span><div>${text('冒险岛', 'Maple World')}<small>CH. 1 · ${text('主频道', 'Main channel')}</small></div></div>`; }
  private channelMarkup() {
    const character = this.characters.find(item => item.id === this.selected);
    const unavailable = character ? '' : ' data-unavailable="true"';
    return `${character ? `<div class="voyage-deck-avatar"><div class="entry-avatar" data-character="${character.id}"></div><span class="entry-nameplate">${escape(character.name)}</span></div>` : ''}<div class="voyage-space-hint" hidden><kbd>Space</kbd><span data-role="space-label">${text('传送至选角舱', 'Enter selection cabin')}</span></div><button class="entry-primary voyage-adventure" data-action="quick"${unavailable}>${text('开始冒险', 'Begin adventure')}</button><div class="voyage-adventure-shortcut" hidden><button type="button" class="voyage-return-login" data-action="first" aria-label="${text('返回登录', 'Return to login')}">‹<span>${text('返回登录', 'LOGIN')}</span></button><button type="button" class="voyage-start-adventure" data-action="quick"${unavailable}>${text('开始冒险', 'Begin adventure')}</button></div>`;
  }
  private charactersMarkup() {
    const slots = Array.from({ length: this.slotLimit }, (_, index) => {
      const character = this.characters[index];
      return character ? `<div class="entry-character" data-berth="${index}"><div class="entry-avatar" data-character="${character.id}"></div><strong>${escape(character.name)}</strong><span>Lv. ${character.level}</span></div>` : `<div class="entry-character entry-empty" data-berth="${index}" aria-label="${text('空床位', 'Empty berth')}"><div class="entry-avatar" data-empty="true"></div></div>`;
    }).join('');
    const active = this.characters.find(c => c.id === this.selected);
    return `${active ? `<div class="voyage-deck-avatar"><span class="entry-nameplate">${escape(active.name)}</span></div>` : ''}<aside class="voyage-role-details" data-role="role-details"><h2>${active ? escape(active.name) : ''}</h2><dl><dt>${text('等级', 'Level')}</dt><dd>${active?.level ?? ''}</dd><dt>${text('职业', 'Job')}</dt><dd>${active ? escape(jobName(active.job)) : ''}</dd><dt>${text('性别', 'Gender')}</dt><dd>${active ? text(active.appearance.gender === 0 ? '男' : '女', active.appearance.gender === 0 ? 'Male' : 'Female') : ''}</dd><dt>${text('已装备', 'Equipped')}</dt><dd>${active ? (active.equipped ?? initialEquipment(active.appearance)).length : ''}</dd></dl><div class="voyage-paper-actions"><button type="button" data-action="close-role">${text('收起', 'Close')}</button><button type="button" class="entry-primary" data-action="enter">${text('开始冒险', 'Begin adventure')}</button></div></aside><div class="voyage-space-hint" hidden><kbd>Space</kbd><span data-role="space-label">${text('查看角色', 'View character')}</span></div><section class="entry-character-stage" aria-label="${text('角色选择', 'Character selection')}"><div class="entry-character-grid">${slots}</div></section>`;
  }
  private createMarkup() {
    const classes = [['战士', 'Warrior'], ['法师', 'Magician'], ['弓手', 'Bowman'], ['盗贼', 'Thief']];
    return `<section class="voyage-cabin-windows" aria-label="${text('职业预览', 'Class previews')}">${classes.map(([zh, en], index) => `<button type="button" class="voyage-cabin-window${this.profession === index ? ' selected' : ''}" data-profession="${index}" aria-pressed="${this.profession === index}"><span class="voyage-window-portrait"><img src="${escape(resolveAssetUrl(`/assets/entry/stained-glass-${['warrior', 'mage', 'archer', 'rogue'][index]}.png`))}" alt="" draggable="false"></span><span class="voyage-window-label">${text(zh, en)}</span></button>`).join('')}<p class="voyage-profession-note">${text('职业之窗 · 只作预览；出舱仍是初心者，转职遵循游戏成长规则。', 'Class windows are previews. You begin as a Beginner and advance in the game.')}</p></section><div class="entry-create-preview"><div class="entry-avatar" data-draft="true"></div><span class="entry-nameplate">${escape(this.draftName || text('角色名称', 'Character name'))}</span></div><form id="create-character" class="entry-create-panel entry-glass"><h1>${text('创建角色', 'CHARACTER CREATION')}</h1><section class="entry-create-name"><label for="character-name">${text('角色名称', 'CHARACTER NAME')}</label><div><input id="character-name" required minlength="2" maxlength="12" autocomplete="off" placeholder="${text('2–12个中文字、字母或数字', '2–12 letters or numbers')}" value="${escape(this.draftName)}"><button type="button" class="entry-primary" data-action="check-name">${text('确认名称', 'Check Availability')}</button></div></section><section class="entry-customise"><div class="entry-customise-row"><span>${text('职业', 'CLASS')}</span><strong>${text('初心者 · 冒险家', 'Beginner · Explorer')}</strong></div><div class="entry-appearance-options"></div></section><div class="entry-create-actions"><button type="submit" class="entry-primary">${text('创建', 'OK')}</button><button type="button" data-action="cancel-create">${text('取消', 'CANCEL')}</button></div></form>`;
  }
  private bind() {
    this.host.querySelector<HTMLFormElement>('#login')?.addEventListener('submit', event => {
      event.preventDefault();
      void this.run(async () => {
        const username = this.host.querySelector<HTMLInputElement>('#username')!.value.trim();
        const password = this.host.querySelector<HTMLInputElement>('#password')!;
        const save = this.host.querySelector<HTMLInputElement>('#save-id')!.checked;
        this.session = await authenticate(username, password.value, this.register);
        password.value = '';
        try { if (save) localStorage.setItem('maple-saved-id', username); else localStorage.removeItem('maple-saved-id'); } catch { /* Optional preference. */ }
        this.register = false;
        await this.refreshCharacters();
        this.go('channel');
      });
    });
    this.host.querySelector('#mode')?.addEventListener('click', () => { this.register = !this.register; this.render(); });
    this.host.querySelectorAll<HTMLButtonElement>('[data-profession]').forEach(button => button.addEventListener('click', () => {
      this.profession = Number(button.dataset.profession);
      this.host.querySelectorAll<HTMLButtonElement>('[data-profession]').forEach(item => { const selected = Number(item.dataset.profession) === this.profession; item.classList.toggle('selected', selected); item.setAttribute('aria-pressed', String(selected)); });
    }));
    this.host.querySelector<HTMLInputElement>('#character-name')?.addEventListener('input', event => {
      this.draftName = (event.target as HTMLInputElement).value;
      this.checkedName = '';
      this.createRequestId = '';
      this.host.querySelector('.entry-nameplate')!.textContent = this.draftName || text('角色名称', 'Character name');
    });
    this.host.querySelector<HTMLFormElement>('#create-character')?.addEventListener('submit', event => { event.preventDefault(); void this.run(() => this.create()); });
    this.host.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => button.addEventListener('click', () => this.action(button.dataset.action!)));
    this.host.querySelectorAll<HTMLButtonElement>('[data-select]').forEach(button => {
      button.addEventListener('click', () => { this.selected = button.dataset.select; this.render(); });
    });
    this.host.querySelectorAll<HTMLButtonElement>('[data-page]').forEach(button => button.addEventListener('click', () => { this.page = Number(button.dataset.page); this.selected = this.characters[this.page * 4]?.id; this.render(); }));
    if (this.stage === 'login') this.focusLoginField();
  }
  private focusLoginField() {
    let savedId = '';
    try { savedId = localStorage.getItem('maple-saved-id') ?? ''; } catch { /* Optional preference. */ }
    const username = this.host.querySelector<HTMLInputElement>('#username');
    const password = this.host.querySelector<HTMLInputElement>('#password');
    if (savedId) password?.focus();
    else username?.focus();
  }
  private updateMusicButton() {
    const button = this.host.querySelector<HTMLButtonElement>('[data-action="entry-music"]');
    if (!button || !this.music) return;
    const muted = this.music.muted;
    button.innerHTML = `${muted ? MUSIC_OFF_ICON : MUSIC_ON_ICON}<span class="entry-sr-only">${text(muted ? '音乐：关' : '音乐：开', muted ? 'Music: off' : 'Music: on')}</span>`;
    button.title = muted ? text('音乐已关闭，点击开启', 'Music off; click to turn on') : this.music.playing ? text('天空之城原曲，点击关闭', 'Orbis original BGM; click to turn off') : text('首次点击页面后播放', 'Playback begins after interacting with the page');
    button.setAttribute('aria-pressed', String(!this.music.muted));
    button.dataset.state = muted ? 'off' : 'on';
  }
  private action(action: string) {
    if (action === 'close-role') return this.voyage?.closeRoleDetails();
    if (action === 'skip-voyage') return this.voyage?.skip();
    if (action === 'help') return this.setNote(text('账号：3–32位英文字母、数字、_或-。密码至少8位。首次游玩请注册，再创建冒险家角色。', 'ID: 3–32 ASCII letters, digits, _ or -. Password: at least 8 characters. Register an account, then create an Explorer.'));
    if (action === 'language') { const url = new URL(location.href); url.searchParams.set('lang', uiLocale() === 'en' ? 'zh' : 'en'); location.assign(url); return; }
    if (action === 'first') return this.showLogin();
    if (action === 'back') { if (this.stage === 'channel') return this.showLogin(); return this.go(this.stage === 'create' ? 'characters' : 'channel'); }
    if (action === 'channel') return this.go('characters');
    if (action === 'cancel-create') return this.go('characters');
    if (action === 'create') { if (this.characters.length >= this.slotLimit) return; this.draftName = ''; this.checkedName = ''; this.createRequestId = ''; this.go('create'); return; }
    if (action === 'check-name') return void this.run(async () => { const name = this.draftName.trim(); const result = await lobbyRequest<{ available: boolean }>(this.session!, 'checkName', { name }); this.checkedName = result.available ? name : ''; this.setNote(result.available ? text('此名称可以使用。', 'This name is available.') : text('此名称已被使用。', 'This name is taken.'), !result.available); });
    if (action === 'enter' || action === 'quick') void this.run(() => this.startGame());
  }
  private async create() {
    if (!this.appearance) throw new Error(text('外观素材仍在加载，请稍候。', 'Appearance assets are still loading.'));
    const name = this.draftName.trim();
    if (!this.createRequestId) this.createRequestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
    const result = await lobbyRequest<{ character: CharacterSummary }>(this.session!, 'create', { name, appearance: this.appearance, requestId: this.createRequestId });
    await this.refreshCharacters();
    this.selected = result.character.id;
    this.page = Math.floor(this.characters.findIndex(character => character.id === this.selected) / 4);
    this.createdOnDeck = false;
    this.go('characters');
    this.setNote(text('初心者已回到船舱，可走回甲板开始冒险。', 'Character created. Return to the deck to begin your adventure.'));
  }
  private async startGame() {
    if (!this.selected) return;
    const revision = this.revision;
    const session = await lobbyRequest<LoginResponse>(this.session!, 'select', { characterId: this.selected, channelId: 1 });
    if (revision !== this.revision) return;
    this.host.classList.add('voyage-loading');
    try { await this.enter(session, async () => {
      this.host.classList.remove('voyage-loading');
      this.host.classList.add('voyage-departing');
      this.music?.setActive(false);
      return revision === this.revision && (!this.voyage || await this.voyage.depart());
    }); } catch (error) { this.host.hidden = false; this.host.classList.remove('voyage-loading', 'voyage-departing'); this.voyage?.cancelDeparture(); this.music?.setActive(true); throw error; }
    this.host.hidden = true;
    this.voyage?.destroy(); this.voyage = undefined;
    document.body.classList.remove('entry-active');
  }
  private renderBackground() {
    const target = this.host.querySelector<HTMLElement>('.entry-background');
    const scene = this.assets?.scenes[this.stage];
    if (!target || !scene || this.host.classList.contains('entry-voyage-ready')) return;
    target.innerHTML = `<div class="entry-background-canvas" style="--scene-ratio:${scene.width / scene.height};width:max(100vw,${scene.width / scene.height * 100}dvh);height:max(100dvh,${scene.height / scene.width * 100}vw)">${scene.layers.map(layer => `<img src="${escape(resolveAssetUrl(layer.url))}" alt="" draggable="false" style="left:${layer.x / scene.width * 100}%;top:${layer.y / scene.height * 100}%;width:${layer.width / scene.width * 100}%;height:${layer.height / scene.height * 100}%">`).join('')}</div>`;
    this.voyage?.attach(target);
  }
  private chooseGender(gender: number) {
    const options = this.catalog?.genders.find(group => group.gender === gender);
    if (!options || !this.catalog) return;
    this.appearance = { gender, skin: this.catalog.skin[0], face: options.face[0], hair: options.hair[0], coat: options.coat[0], pants: options.pants[0], shoes: options.shoes[0], weapon: options.weapon[0] };
    this.createRequestId = '';
  }
  private renderOptions() {
    const target = this.host.querySelector<HTMLElement>('.entry-appearance-options');
    if (!target || !this.catalog || !this.appearance) return;
    const look = this.appearance;
    const options = this.catalog.genders.find(group => group.gender === look.gender)!;
    const hairBase = options.hair.find(base => base === look.hair || options.hairColors[String(base)]?.includes(look.hair))!;
    const rows: [keyof Pick<Appearance, 'skin' | 'face' | 'hair' | 'coat' | 'pants' | 'shoes' | 'weapon'>, string, string][] = [['skin', '肤色', 'SKIN'], ['face', '脸型', 'FACE'], ['hair', '发型', 'HAIR'], ['coat', '套装', 'COSTUME'], ['pants', '裤子', 'PANTS'], ['shoes', '鞋子', 'SHOES'], ['weapon', '武器', 'WEAPON']];
    const palette = ['#4b4b4b','#fa665d','#ffbe19','#ffe52c','#24c99d','#3fbbf1','#a967ef','#c3814f'];
    target.innerHTML = `<div class="entry-customise-row"><span>${text('性别', 'GENDER')}</span><div class="entry-option-controls entry-genders">${this.catalog.genders.map(group => `<button type="button" data-gender="${group.gender}" class="${look.gender === group.gender ? 'selected' : ''}" aria-pressed="${look.gender === group.gender}">${group.gender === 0 ? text('男', 'MALE') : text('女', 'FEMALE')}</button>`).join('')}</div></div>` + rows.map(([key, zh, en]) => {
      const value = key === 'hair' ? hairBase : look[key];
      const values = key === 'skin' ? this.catalog!.skin : options[key];
      const name = key === 'pants' && value === 0 ? text('随套装', 'Included in outfit') : key === 'skin' && values.length === 1 ? text('默认肤色', 'Default skin') : displayText(this.catalog!.names[String(value)] || `${text(zh, en)} ${values.indexOf(value) + 1}`);
      const fixed = values.length <= 1 ? ' data-unavailable="true" disabled' : '';
      const colors = options.hairColors[String(hairBase)] ?? [hairBase];
      return `<div class="entry-customise-row"><span>${text(zh, en)}</span><div class="entry-option-controls"><button type="button" data-option="${key}" data-direction="-1"${fixed} aria-label="${text('上一个', 'Previous ')}${text(zh, en)}">‹</button><output>${escape(name)}</output><button type="button" data-option="${key}" data-direction="1"${fixed} aria-label="${text('下一个', 'Next ')}${text(zh, en)}">›</button></div></div>${key === 'hair' ? `<div class="entry-customise-row"><span>${text('发色', 'DYE')}</span><div class="entry-colors">${colors.map((color, index) => `<button type="button" data-hair-color="${color}" style="--hair-color:${palette[index % palette.length]}" class="${look.hair === color ? 'selected' : ''}" aria-pressed="${look.hair === color}" aria-label="${text('发色', 'Hair color ')} ${index + 1}"></button>`).join('')}</div></div>` : ''}`;
    }).join('');
    target.querySelectorAll<HTMLButtonElement>('[data-gender]').forEach(button => button.addEventListener('click', () => { this.chooseGender(Number(button.dataset.gender)); this.renderOptions(); this.renderPreviews(); }));
    target.querySelectorAll<HTMLButtonElement>('[data-option]').forEach(button => button.addEventListener('click', () => {
      const key = button.dataset.option as 'skin' | 'face' | 'hair' | 'coat' | 'pants' | 'shoes' | 'weapon';
      const values = key === 'skin' ? this.catalog!.skin : options[key];
      const current = key === 'hair' ? hairBase : look[key];
      const index = (values.indexOf(current) + Number(button.dataset.direction) + values.length) % values.length;
      this.appearance![key] = values[index];
      this.createRequestId = '';
      this.renderOptions(); this.renderPreviews();
    }));
    target.querySelectorAll<HTMLButtonElement>('[data-hair-color]').forEach(button => button.addEventListener('click', () => { this.appearance!.hair = Number(button.dataset.hairColor); this.createRequestId = ''; this.renderOptions(); this.renderPreviews(); }));
  }
  private renderPreviews() {
    cancelAnimationFrame(this.animation ?? 0);
    const previews = Array.from(this.host.querySelectorAll<HTMLElement>('.entry-avatar')).map(target => {
      const character = target.dataset.character ? this.characters.find(item => item.id === target.dataset.character) : undefined;
      const look = target.dataset.draft ? this.appearance : character?.appearance;
      // The map and cash shop compose the paper doll from the character's
      // current equipped rows; the lobby list carries those same rows, so the
      // selection preview matches them instead of the frozen creation look.
      const equipped = character ? character.equipped ?? (look ? initialEquipment(look) : []) : look ? initialEquipment(look) : [];
      const weaponType = look && this.avatarCatalog ? appearanceWeaponType(this.avatarCatalog, equipped, look.weapon) : undefined;
      const actions = look && this.avatarCatalog ? composeAppearance(this.avatarCatalog, look, equipped, { weaponType }) : undefined;
      const frames = target.dataset.empty ? this.assets?.effects?.empty.map(frame => ({ delay: frame.delay, parts: [frame] })) : actions?.stand;
      const parts = ['stand','walk','sit','jump'].flatMap(action => (actions?.[action as 'stand'|'walk'|'sit'|'jump'] ?? []).flatMap(frame=>frame.parts));
      const bounds = parts.length ? { left: Math.min(...parts.map(p=>p.x)), top: Math.min(...parts.map(p=>p.y)), right: Math.max(...parts.map(p=>p.x+(p.width??0))), bottom: Math.max(...parts.map(p=>p.y+(p.height??0))) } : undefined;
      return { target, frames, actions, bounds, face: look?.face, id: target.dataset.draft ? 'draft' : character?.id, index: -1, action: '' };
    });
    for(const character of this.characters) {
      if(previews.some(p=>p.id===character.id))continue;
      const look=character.appearance,equipped=character.equipped??initialEquipment(look);
      if(!this.avatarCatalog)continue;
      const actions=composeAppearance(this.avatarCatalog,look,equipped,{weaponType:appearanceWeaponType(this.avatarCatalog,equipped,look.weapon)});
      if(!actions)continue;
      const parts=['stand','walk','sit','jump'].flatMap(a=>(actions[a as 'stand'|'walk'|'sit'|'jump']??[]).flatMap(f=>f.parts));
      const bounds=parts.length ? {left:Math.min(...parts.map(p=>p.x)),top:Math.min(...parts.map(p=>p.y)),right:Math.max(...parts.map(p=>p.x+(p.width??0))),bottom:Math.max(...parts.map(p=>p.y+(p.height??0)))} : undefined;
      previews.push({target:document.createElement('div'),frames:actions.stand,actions,bounds,face:look.face,id:character.id,index:-1,action:''});
    }
    for (const target of Array.from(this.host.querySelectorAll<HTMLElement>('[data-instructor]'))) {
      const npc = this.manifest?.npcs?.[target.dataset.instructor!];
      const frame = npc?.stand?.[0];
      if (frame) target.innerHTML = `<img src="${escape(resolveAssetUrl(frame.url))}" alt="${escape(displayText(npc.name))}" draggable="false" style="width:${frame.width}px;height:${frame.height}px">`;
    }
    this.loadPendingAppearanceLayers();
    const animate = (now: number) => {
      for (const preview of previews) {
        const action = preview.id ? this.voyage?.passengerAction(preview.id) ?? 'stand' : 'stand';
        const avatarFrames = preview.actions?.[action as 'stand' | 'walk' | 'sit' | 'jump'] ?? preview.actions?.stand;
        const frames = avatarFrames ?? preview.frames;
        if (!frames?.length) continue;
        const duration = frames.reduce((sum, frame) => sum + Math.max(1, frame.delay ?? 100), 0);
        let elapsed = matchMedia('(prefers-reduced-motion: reduce)').matches && action !== 'walk' ? 0 : (this.voyage?.passengerTime() ?? now) % duration;
        let index = 0;
        while (index < frames.length - 1 && elapsed >= Math.max(1, frames[index].delay ?? 100)) elapsed -= Math.max(1, frames[index++].delay ?? 100);
        if (preview.index === index && preview.action === action) continue;
        preview.index = index; preview.action = action;
        if (preview.id && avatarFrames) {
          const closed = preview.face && this.closedFaces[String(preview.face)];
          const parts = avatarFrames[index].parts.map(part => {
            if (!closed || !this.voyage?.passengerSleeping(preview.id!) || !('part' in part) || part.part !== 'face') return part;
            const brow = part.map?.brow, sleepBrow = closed.map?.brow;
            if (!brow || !sleepBrow) return part;
            return { ...part, ...closed, key: closed.url, x: part.x + part.origin.x + brow.x - closed.origin.x - sleepBrow.x, y: part.y + part.origin.y + brow.y - closed.origin.y - sleepBrow.y };
          });
          this.voyage?.setPassengerFrame(preview.id, parts, preview.bounds);
        }
        preview.target.innerHTML = frames[index].parts.map(part => `<img src="${escape(resolveAssetUrl(part.url))}" alt="" draggable="false" style="left:calc(50% + ${part.x}px);top:calc(100% + ${part.y}px);width:${part.width}px;height:${part.height}px">`).join('');
      }
      if (!this.host.hidden) this.animation = requestAnimationFrame(animate);
    };
    this.animation = requestAnimationFrame(animate);
  }
  /** Cash appearance layers are per-item JSON files; the world fetches the
   *  ones the actor actually wears. The selection preview mirrors that for
   *  equipped cash cosmetics and re-composes once they register. Failures
   *  stay cached so the animation loop never refetches a missing file. */
  private loadPendingAppearanceLayers() {
    const catalog = this.avatarCatalog;
    if (!catalog) return;
    const pending = [...new Set(this.characters.flatMap(character => (character.equipped ?? []).map(item => item.itemId)))]
      .filter(itemId => cashAppearanceEntry(catalog, itemId) && !appearanceLayer(catalog, itemId))
      .filter(itemId => {
        const key = normalizeAppearanceItemId(itemId);
        return !this.appearanceLayerRequests.has(key) && !this.appearanceLayerFailures.has(key);
      });
    if (!pending.length) return;
    const keys = pending.map(itemId => normalizeAppearanceItemId(itemId));
    for (const key of keys) this.appearanceLayerRequests.add(key);
    const release = (failed: boolean) => {
      for (const key of keys) {
        this.appearanceLayerRequests.delete(key);
        if (failed) this.appearanceLayerFailures.add(key);
      }
      if (!this.host.hidden) this.renderPreviews();
    };
    void loadAppearanceLayers(catalog, pending)
      .then(() => release(false))
      .catch(() => release(true));
  }
}
