import type { LoginResponse } from '../../../../shared/protocol';
import type { AssetFrame, Manifest } from '../../assets/manifest';
import { authenticate } from '../../network/auth-api';
import { uiLocale, displayText } from '../../app/i18n';
import { lobbyRequest, type Appearance, type CharacterList, type CharacterSummary } from './api';
import { appearanceLayer, appearanceWeaponType, cashAppearanceEntry, composeAppearance, initialEquipment, loadAppearanceLayers, normalizeAppearanceItemId, type AppearanceCatalog } from './appearance';
import { resolveAssetUrl } from '../../assets/resource-url';
import './style.css';

type Stage = 'login' | 'channel' | 'characters' | 'create';
type SceneArt = { width: number; height: number; layers: Pick<AssetFrame, 'url' | 'x' | 'y' | 'width' | 'height'>[] };
export interface EntryAssets { scenes: Partial<Record<Stage, SceneArt>>; bgm?: string; effects?: { empty: AssetFrame[] } }
interface GenderOptions { gender: number; face: number[]; hair: number[]; hairColors: Record<string, number[]>; coat: number[]; pants: number[]; shoes: number[]; weapon: number[] }
interface CreationCatalog { source: string; skin: number[]; genders: GenderOptions[]; names: Record<string, string> }
const text = (zh: string, en: string) => uiLocale() === 'en' ? en : zh;
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const jobName = (job: number) => job === 0 ? text('新手', 'Beginner') : job === 200 ? text('法师', 'Magician') : job === 220 ? text('巫师（冰、雷）', 'Wizard (Ice, Lightning)') : String(job);

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
  /** Cash appearance layers already requested for the equipped list. */
  private appearanceLayerRequests = new Set<string>();
  /** Cash appearance layers whose file failed; never refetched this session. */
  private appearanceLayerFailures = new Set<string>();
  constructor(private host: HTMLElement, private enter: (session: LoginResponse) => Promise<void>) {
    this.render();
    void this.loadArt();
  }
  private async loadArt() {
    try {
      const [artResponse, manifestResponse, catalogResponse, appearanceResponse] = await Promise.all([fetch(resolveAssetUrl('/assets/entry/manifest.json')), fetch(resolveAssetUrl('/assets/manifest.json')), fetch(resolveAssetUrl('/assets/entry/creation.json')), fetch(resolveAssetUrl('/assets/entry/appearance.json'))]);
      if (!artResponse.ok || !manifestResponse.ok) throw new Error(text('登录素材加载失败，请刷新重试。', 'Unable to load entry artwork. Refresh to retry.'));
      this.assets = await artResponse.json();
      this.manifest = await manifestResponse.json();
      if (!catalogResponse.ok) throw new Error(text('创角配置加载失败，请刷新重试。', 'Unable to load character creation options.'));
      this.catalog = await catalogResponse.json();
      if (!appearanceResponse.ok) throw new Error("角色外观资源加载失败");
      this.avatarCatalog = await appearanceResponse.json();
      this.chooseGender(0);
      this.renderOptions();
      this.renderBackground();
      this.renderPreviews();
    } catch (error) { this.setNote(error instanceof Error ? error.message : String(error), true); }
  }
  showLogin() {
    this.revision++; this.session = undefined; this.characters = []; this.selected = undefined; this.host.hidden = false; this.go('login');
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
    catch (error) { if (revision === this.revision) this.setNote(error instanceof Error ? error.message : String(error), true); }
    finally { this.busy = false; this.setBusy(); }
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
    cancelAnimationFrame(this.animation ?? 0);
    this.host.className = `entry entry-stage-${this.stage}`;
    document.body.classList.add('entry-active');
    this.host.innerHTML = `<div class="entry-background" aria-hidden="true"></div><div class="entry-brand">MapleStory <small>TMS 273.7</small></div><div class="entry-scene">${this.stage === 'login' ? this.loginMarkup() : this.stage === 'channel' ? this.channelMarkup() : this.stage === 'characters' ? this.charactersMarkup() : this.createMarkup()}</div><nav class="entry-navigation" aria-label="${text('大厅导航', 'Lobby navigation')}">${this.stage !== 'login' ? `<button type="button" data-action="first">‹ ${text('首页', 'FIRST')}</button><button type="button" data-action="back">‹ ${text('返回', 'BACK')}</button>` : ''}</nav><p class="entry-notice${this.error ? ' entry-error' : ''}" role="status"${this.note ? '' : ' hidden'}>${escape(this.note)}</p><div class="entry-edition">TMS 273.7 · ${text('主频道', 'Main channel')}</div>`;
    this.renderBackground();
    this.bind();
    this.renderOptions();
    this.renderPreviews();
    this.setBusy();
  }
  private loginMarkup() {
    let savedId = '';
    try { savedId = localStorage.getItem('maple-saved-id') ?? ''; } catch { /* Optional preference. */ }
    return `<form id="login" class="entry-login entry-glass"><h1>${this.register ? text('创建账号', 'Create Account') : text('账号登录', 'Log In')}</h1><div class="entry-login-fields"><label class="entry-sr-only" for="username">Maple ID</label><input id="username" name="username" autocomplete="username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9_-]{3,32}" placeholder="Maple ID" value="${escape(savedId)}"><label class="entry-save"><input type="checkbox" id="save-id"${savedId ? ' checked' : ''}> ${text('记住账号', 'Save ID')}</label><label class="entry-sr-only" for="password">${text('密码', 'Password')}</label><input id="password" name="password" type="password" autocomplete="${this.register ? 'new-password' : 'current-password'}" required minlength="8" maxlength="128" placeholder="${text('密码（至少8位）', 'Password (at least 8 characters)')}"></div><button class="entry-primary" id="submit" type="submit">${this.register ? text('注册', 'Register') : text('登录', 'Log In')}</button><div class="entry-login-links"><button type="button" id="mode">${this.register ? text('返回登录', 'Back to Log In') : text('注册账号', 'Create Account')}</button><span>|</span><button type="button" data-action="help">${text('帮助', 'Help')}</button><span>|</span><button type="button" data-action="language">${uiLocale() === 'en' ? '简体中文' : 'English'}</button></div></form>`;
  }
  private worldBadge() { return `<div class="entry-world-badge entry-glass"><span class="entry-world-emblem">🍁</span><div>${text('冒险岛', 'Maple World')}<small>CH. 1 · ${text('主频道', 'Main channel')}</small></div></div>`; }
  private channelMarkup() {
    const character = this.characters.find(item => item.id === this.selected);
    return `<aside class="entry-world-list">${this.worldBadge()}</aside>${character ? `<aside class="entry-quick entry-glass"><div class="entry-quick-level">★　Lv. ${character.level}</div><div class="entry-quick-body"><div class="entry-avatar" data-character="${character.id}"></div><strong>${escape(character.name)}</strong><span>${jobName(character.job)}</span></div><button class="entry-primary" data-action="quick">${text('快速开始', 'QUICK ACCESS')}</button></aside>` : ''}<section class="entry-channels entry-glass"><h1>${text('选择频道', 'Select Channel')}</h1><p>${text('冒险岛', 'Maple World')}</p><button class="entry-channel-button selected" data-action="channel"><strong>CH. 1</strong><span>${text('主频道', 'Main channel')}</span><i></i></button><p class="entry-hint">${text('选择主频道，查看你的角色。', 'Select the main channel to view your characters.')}</p></section>`;
  }
  private charactersMarkup() {
    const start = this.page * 12;
    const slots = Array.from({ length: Math.min(12, this.slotLimit - start) }, (_, index) => {
      const character = this.characters[start + index];
      return character ? `<button class="entry-character${character.id === this.selected ? ' selected' : ''}" data-select="${character.id}" aria-pressed="${character.id === this.selected}"><div class="entry-avatar" data-character="${character.id}"></div><strong>${escape(character.name)}</strong><span>Lv. ${character.level} · ${jobName(character.job)}</span></button>` : `<button class="entry-character entry-empty" data-action="create" aria-label="${text('创建角色', 'Create character')}"><div class="entry-avatar" data-empty="true"></div><span>＋</span></button>`;
    }).join('');
    return `<aside class="entry-selection-info">${this.worldBadge()}<p class="entry-slots">${text('角色栏位', 'CHARACTER SLOT')} <strong>${this.characters.length}/${this.slotLimit}</strong></p></aside><section class="entry-character-stage" aria-label="${text('角色选择', 'Character selection')}"><div class="entry-character-grid">${slots}</div><div class="entry-pages">${Array.from({ length: Math.ceil(this.slotLimit / 12) }, (_, index) => `<button data-page="${index}" class="${index === this.page ? 'selected' : ''}" aria-label="${text('第', 'Page ')}${index + 1}${text('页', '')}">${index + 1}</button>`).join('')}</div><div class="entry-character-actions"><button class="entry-tan" data-action="create"${this.characters.length >= this.slotLimit ? ' data-unavailable="true"' : ''}>＋ ${text('创建角色', 'Create Character')}</button><button class="entry-primary" data-action="enter"${!this.selected ? ' data-unavailable="true"' : ''}>${text('开始游戏', 'PLAY')}</button></div></section>`;
  }
  private createMarkup() {
    return `<div class="entry-create-preview"><div class="entry-avatar" data-draft="true"></div><span class="entry-nameplate">${escape(this.draftName || text('角色名称', 'Character name'))}</span></div><form id="create-character" class="entry-create-panel entry-glass"><h1>${text('创建角色', 'CHARACTER CREATION')}</h1><section class="entry-create-name"><label for="character-name">${text('角色名称', 'CHARACTER NAME')}</label><div><input id="character-name" required minlength="2" maxlength="12" autocomplete="off" placeholder="${text('2–12个中文字、字母或数字', '2–12 letters or numbers')}" value="${escape(this.draftName)}"><button type="button" class="entry-primary" data-action="check-name">${text('确认名称', 'Check Availability')}</button></div></section><section class="entry-customise"><div class="entry-customise-row"><span>${text('职业', 'CLASS')}</span><strong>${text('冒险家', 'Explorer')}</strong></div><div class="entry-appearance-options"></div></section><div class="entry-create-actions"><button type="submit" class="entry-primary">${text('创建', 'OK')}</button><button type="button" data-action="cancel-create">${text('取消', 'CANCEL')}</button></div></form>`;
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
      button.addEventListener('dblclick', () => { this.selected = button.dataset.select; void this.run(() => this.startGame()); });
    });
    this.host.querySelectorAll<HTMLButtonElement>('[data-page]').forEach(button => button.addEventListener('click', () => { this.page = Number(button.dataset.page); this.render(); }));
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
  private action(action: string) {
    if (action === 'help') return this.setNote(text('账号：3–32位英文字母、数字、_或-。密码至少8位。首次游玩请注册，再创建冒险家角色。', 'ID: 3–32 ASCII letters, digits, _ or -. Password: at least 8 characters. Register an account, then create an Explorer.'));
    if (action === 'language') { const url = new URL(location.href); url.searchParams.set('lang', uiLocale() === 'en' ? 'zh' : 'en'); location.assign(url); return; }
    if (action === 'first') return this.showLogin();
    if (action === 'back') return this.go(this.stage === 'create' ? 'characters' : this.stage === 'characters' ? 'channel' : 'login');
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
    this.page = Math.floor(this.characters.findIndex(character => character.id === this.selected) / 12);
    this.go('characters');
    this.setNote(text('角色已创建，选择“开始游戏”进入冒险。', 'Character created. Select PLAY to begin.'));
  }
  private async startGame() {
    if (!this.selected) return;
    const session = await lobbyRequest<LoginResponse>(this.session!, 'select', { characterId: this.selected, channelId: 1 });
    try { await this.enter(session); } catch (error) { this.host.hidden = false; throw error; }
    this.host.hidden = true;
    document.body.classList.remove('entry-active');
  }
  private renderBackground() {
    const target = this.host.querySelector<HTMLElement>('.entry-background');
    const scene = this.assets?.scenes[this.stage];
    if (!target || !scene) return;
    target.innerHTML = `<div class="entry-background-canvas" style="--scene-ratio:${scene.width / scene.height};width:max(100vw,${scene.width / scene.height * 100}dvh);height:max(100dvh,${scene.height / scene.width * 100}vw)">${scene.layers.map(layer => `<img src="${escape(resolveAssetUrl(layer.url))}" alt="" draggable="false" style="left:${layer.x / scene.width * 100}%;top:${layer.y / scene.height * 100}%;width:${layer.width / scene.width * 100}%;height:${layer.height / scene.height * 100}%">`).join('')}</div>`;
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
    const rows: [keyof Pick<Appearance, 'face' | 'hair' | 'coat' | 'shoes' | 'weapon'>, string, string][] = [['face', '脸型', 'FACE'], ['hair', '发型', 'HAIR'], ['coat', '服装', 'COSTUME'], ['shoes', '鞋子', 'SHOES'], ['weapon', '武器', 'WEAPON']];
    const palette = ['#4b4b4b','#fa665d','#ffbe19','#ffe52c','#24c99d','#3fbbf1','#a967ef','#c3814f'];
    target.innerHTML = `<div class="entry-customise-row"><span>${text('性别', 'GENDER')}</span><div class="entry-option-controls entry-genders">${this.catalog.genders.map(group => `<button type="button" data-gender="${group.gender}" class="${look.gender === group.gender ? 'selected' : ''}" aria-pressed="${look.gender === group.gender}">${group.gender === 0 ? text('男', 'MALE') : text('女', 'FEMALE')}</button>`).join('')}</div></div>` + rows.map(([key, zh, en]) => {
      const value = key === 'hair' ? hairBase : look[key];
      const name = displayText(this.catalog!.names[String(value)] || `${text(zh, en)} ${options[key].indexOf(value) + 1}`);
      const colors = options.hairColors[String(hairBase)] ?? [hairBase];
      return `<div class="entry-customise-row"><span>${text(zh, en)}</span><div class="entry-option-controls"><button type="button" data-option="${key}" data-direction="-1" aria-label="${text('上一个', 'Previous ')}${text(zh, en)}">‹</button><output>${escape(name)}</output><button type="button" data-option="${key}" data-direction="1" aria-label="${text('下一个', 'Next ')}${text(zh, en)}">›</button></div></div>${key === 'hair' ? `<div class="entry-customise-row"><span>${text('发色', 'DYE')}</span><div class="entry-colors">${colors.map((color, index) => `<button type="button" data-hair-color="${color}" style="--hair-color:${palette[index % palette.length]}" class="${look.hair === color ? 'selected' : ''}" aria-pressed="${look.hair === color}" aria-label="${text('发色', 'Hair color ')} ${index + 1}"></button>`).join('')}</div></div>` : ''}`;
    }).join('');
    target.querySelectorAll<HTMLButtonElement>('[data-gender]').forEach(button => button.addEventListener('click', () => { this.chooseGender(Number(button.dataset.gender)); this.renderOptions(); this.renderPreviews(); }));
    target.querySelectorAll<HTMLButtonElement>('[data-option]').forEach(button => button.addEventListener('click', () => {
      const key = button.dataset.option as 'face' | 'hair' | 'coat' | 'shoes' | 'weapon';
      const values = options[key];
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
      const frames = target.dataset.empty ? this.assets?.effects?.empty.map(frame => ({ delay: frame.delay, parts: [frame] })) : (actions ?? this.manifest?.avatar.actions)?.stand;
      return { target, frames, index: -1 };
    });
    this.loadPendingAppearanceLayers();
    const animate = (now: number) => {
      for (const preview of previews) {
        const frames = preview.frames;
        if (!frames?.length) continue;
        const duration = frames.reduce((sum, frame) => sum + Math.max(1, frame.delay ?? 100), 0);
        let elapsed = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : now % duration;
        let index = 0;
        while (index < frames.length - 1 && elapsed >= Math.max(1, frames[index].delay ?? 100)) elapsed -= Math.max(1, frames[index++].delay ?? 100);
        if (preview.index === index) continue;
        preview.index = index;
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
