import { HENESYS_MAP_ID } from '../features/henesys/coordinates';
import Phaser from 'phaser';
import type { LoginResponse, NpcState, PlayerState, BossPracticeState } from '../../../shared/protocol';
import { Connection } from '../network/session';
import { PlayerInput } from '../features/player/input';
import { KeyBindings, type KeyBinding } from '../features/keybindings/model';
import { KeybindingsView } from '../features/keybindings/view';
import { StorageView } from '../features/world/storage-view';
import { PartyView } from '../features/world/party-view';
import { MiniMapView } from '../features/world/minimap-view';
import '../features/world/minimap.css';
import { WorldMapView } from '../features/world/worldmap-view';
import '../features/world/worldmap.css';
import { mapEntryWarning } from '../features/world/entry-script';
import { FriendView } from '../features/world/friend-view';
import { EmoticonView } from '../features/chat/emoticon-view';
import { CashShopView } from '../features/cashshop/view';
import '../features/cashshop/style.css';
import { loadManifest, type Manifest } from '../assets/manifest';
import { mapText, protocolText, hasProtocolError, uiText, uiLocale } from './i18n';
import { HudView } from '../features/hud/view';
import { InventoryView } from '../features/inventory/view';
import { itemCategoryTab, itemName } from '../features/inventory/names';
import { inventoryTypeForTab } from '../features/inventory/view-model';
import { ChatView } from '../features/chat/view';
import { DeathNoticeView } from '../features/notice/death';
import { AwayNoticeView } from '../features/notice/away';
import { MountStatusView } from '../features/mounts/view';
import '../features/mounts/style.css';
import { ChairStatusView } from '../features/chairs/view';
import '../features/chairs/style.css';
import { MenuView } from '../features/menu/view';
import { ColossusView } from '../features/colossus/view';
import { ActivitiesView } from '../features/windbell/activities';
import { NpcDialogueView } from '../features/npc/dialogue';
import { QuestLogView } from '../features/quest/log';
import { NotebookView } from '../features/notebook/view';
import '../features/notebook/style.css';
import { SkillView } from '../features/skills/view';
import { CharacterInfoView } from '../features/character/view';
import { PetPanel } from '../features/pet/panel';
import { World } from '../scenes/world';
import './style.css';
import '../features/hud/style.css';
// The buff row's plate ships with the HUD line, so its sheet loads with it.
// It is imported here (not from `buff-bar.ts`) because the offline node checks
// transpile feature modules without a CSS loader.
import '../features/hud/buff.css';
import { EntryView } from '../features/entry/view';
import { LoadingOverlay } from '../features/loading/view';
import { ClientActionsView } from '../features/client-actions/view';
import { installEscapeRouter, installKeybindingRouter } from './ui-router.ts';
import { PageShell, pageElement } from './page-shell.ts';

const english = uiLocale() === 'en';

const shell = new PageShell(document.querySelector<HTMLDivElement>('#app')!, {
  onShowNews: () => { input?.reset(); menus?.close(); },
  onNewsClosed: () => { if (!el('play').hidden) focusGame(); },
});
const news = shell.news;
const el = pageElement;
let connection: Connection | undefined;
let input: PlayerInput | undefined;
let world: World | undefined;
let hud: HudView | undefined;
let inventory: InventoryView | undefined;
let chat: ChatView | undefined;
let deathNotice: DeathNoticeView | undefined;
let awayNotice: AwayNoticeView | undefined;
let mountStatus: MountStatusView | undefined;
let chairStatus: ChairStatusView | undefined;
let menus: MenuView | undefined;
let activities: ActivitiesView | undefined;
let npcDialogue: NpcDialogueView | undefined;
let storage: StorageView | undefined;
let party: PartyView | undefined;
let friends: FriendView | undefined;
let emoticons: EmoticonView | undefined;
let cashShop: CashShopView | undefined;
let miniMap: MiniMapView | undefined;
let worldMap: WorldMapView | undefined;
let questLog: QuestLogView | undefined;
// 冒险笔记（图鉴）：一个窗口四个页签（怪物／装备／道具／任务道具），私有事实
// 全部由服务器按身份算好，这里只负责构造、路由与销毁（计划 §6.4）。
let notebook: NotebookView | undefined;
let skills: SkillView | undefined;
let keybindingsView: KeybindingsView | undefined;
const keybindings = new KeyBindings({ onError: message => status(message, true) });
let keybindingsDispose: (() => void) | undefined;
let keyRouterDispose: (() => void) | undefined;
let characterInfo: CharacterInfoView | undefined;
let petPanel: PetPanel | undefined;
let game: Phaser.Game | undefined;
let layoutObserver: ResizeObserver | undefined;
let escapeRouterDispose: (() => void) | undefined;
let alertTimer: ReturnType<typeof setTimeout> | undefined;
let loadingOverlay: LoadingOverlay | undefined;
function showNews() {
  shell.showNews();
}
function setPlayLayout(playing: boolean) {
  // 布局搬移与弹窗复位在 page-shell；status() 的 4 秒提示定时器仍归本文件。
  if (!playing) clearTimeout(alertTimer);
  shell.setPlayLayout(playing);
}
let muted = false;
let generation = 0;
let portalSequence = 0;
let questSequence = 0;
let skillRequestSequence = 0;
let selfState: PlayerState | undefined;
function status(message: string, error = false) {
  el('message').textContent = message;
  el('message').classList.toggle('error', error);
  if (el('play').hidden) return;
  const log = el('news-log');
  if (log.firstElementChild?.textContent !== message) {
    const item = document.createElement('li');
    item.textContent = message;
    item.classList.toggle('error', error);
    log.prepend(item);
    while (log.children.length > 30) log.lastElementChild?.remove();
  }
  clearTimeout(alertTimer);
  const alert = el('game-alert');
  alert.textContent = `${message} · ${english ? 'View messages' : '查看消息'}`;
  alert.hidden = news.open;
  if (!error) alertTimer = setTimeout(() => { alert.hidden = true; }, 4000);
  // LoadingOverlay is mounted on demand while the game view boots.  Pipe the
  // same status text through so the overlay can advance its stage + progress
  // bar without inventing a new progress channel.  `applyStatus` is a no-op
  // once the overlay has been hidden.
  loadingOverlay?.applyStatus(message);
}
let colossusView: ColossusView | undefined;
function focusGame() { requestAnimationFrame(() => el('game').focus({ preventScroll: true })); }
function openCashShop() {
  input?.reset();
  skills?.releaseChannel();
  hud?.releaseChannel();
  if (selfState) cashShop?.syncPlayer(selfState);
  cashShop?.open();
}
function characterInfoIsOpen() {
  return Boolean((characterInfo as unknown as { isOpen?: () => boolean } | undefined)?.isOpen?.());
}
/**
 * Panels that own gameplay focus and their own Escape handling.  While any of them is showing the
 * router leaves the key alone so that panel closes itself; when none is open,
 * Escape raises the menu bar (`docs/technical/UI_WINDOW_SYSTEM.md` R5).
 */
function gameplayUiBlocked() {
  return Boolean(
    keybindingsView?.isOpen() || activities?.isOpen() ||
    news.open
    || menus?.isOpen()
    || npcDialogue?.isOpen()
    || cashShop?.isOpen()
    || storage?.isOpen()
    || deathNotice?.isOpen()
    || skills?.isOpen()
    || characterInfoIsOpen()
    || petPanel?.isOpen()
    || party?.isOpen()
    || friends?.isOpen()
    || emoticons?.isOpen()
    || inventory?.isOpen()
    || questLog?.isOpen()
    || notebook?.isOpen()
    || worldMap?.isOpen()
    || Boolean(miniMap?.npcListShown()),
  );
}
function openKeybindings(skillId?: number) {
  input?.reset(); hud?.releaseChannel(); menus?.close();
  keybindingsView?.open(skillId);
}
function activateUiAction(action: string): boolean {
  switch (action) {
    case 'skills': toggleSkills(); break;
    case 'quests': input?.reset(); questLog?.toggle(); break;
    case 'inventory': input?.reset(); inventory?.toggle(); break;
    case 'equipment': input?.reset(); inventory?.toggleEquipment(); break;
    case 'worldmap': input?.reset(); worldMap?.toggle(); break;
    case 'character': toggleCharacterInfo(); break;
    case 'pets': input?.reset(); petPanel?.toggle(); break;
    case 'keybind': openKeybindings(); break;
    default: return false;
  }
  return true;
}
function useShortcutItem(itemId: number) {
  if (!selfState || selfState.hp <= 0 || gameplayUiBlocked()) return;
  const item = selfState.inventory.find(item => Number(item.itemId) === itemId && item.quantity > 0);
  if (!item) { status('背包中没有该道具。', true); return; }
  // 快捷栏上绑的不只是消耗品：椅子（设置栏）走的是同一条 useItem 通道，服务端
  // 按**栏位号**分流（`chair_toggle` 只认 3）。因此栏位号必须由 itemId 自己的
  // 类别算出来，不能写死 2——写死会让椅子落进 InvalidInventoryType。
  const inventoryType = inventoryTypeForTab(itemCategoryTab(item.itemId));
  connection?.send({ type: 'useItem', requestId: `keyitem-${crypto.randomUUID()}`, inventoryType, sourceSlot: item.slot, itemId: item.itemId });
}
let colossusSequence = 0;
const sendColossus = (action: import('../../../shared/protocol').ColossusAction) => { if(action!=='travel')input?.reset(); connection?.send({type:'colossus',action,sequence:++colossusSequence,requestId:`colossus-${crypto.randomUUID()}`}); };
function activateBinding(binding: KeyBinding) {
  if (!binding || !selfState || keybindingsView?.isOpen() || activities?.isOpen()) return;
  if (binding.type === 'item') { useShortcutItem(binding.itemId); return; }
  if (binding.type === 'skill') { castSkill(binding.skillId); return; }
  if (activateUiAction(binding.action)) return;
  if (gameplayUiBlocked()) return;
  // 骑宠键是**世界动作**不是窗口开关：它改的是服务端的骑乘状态，所以放在
  // `gameplayUiBlocked()` 之后（有窗开着时不骑马），并复用状态标记那条 useItem 通道。
  if (binding.action === 'mount') { mountStatus?.toggleCurrent(); return; }
  if (binding.action === 'attack') {
    const reactorId = colossusView ? undefined : world?.nearestReactor()?.id;
    if (reactorId) connection?.send({ type: 'reactorHit', requestId: `keyreactor-${crypto.randomUUID()}`, reactorId });
    else connection?.send({ type: 'attack', requestId: `keyattack-${crypto.randomUUID()}` });
  } else if (binding.action === 'pickup') {
    const dropId = world?.nearestDropId();
    if (dropId) connection?.send({ type: 'pickup', requestId: `keypickup-${crypto.randomUUID()}`, dropId });
  } else if (binding.action === 'talk') {
    if (colossusView) { const npc = colossusView.nearestNpc(); if (npc) talkToNpc(npc); else sendColossus('travel'); return; }
    const npc = world?.nearestNpc(); if (npc) talkToNpc(npc); else world?.enterPortal();
  } else { status('请使用已配置的键盘按键执行此动作。'); }
}
function talkToNpc(npc: NpcState) {
  if (gameplayUiBlocked()) return;
  // 阶段一：点击/按键选中的即时反馈先落地（名牌高亮），服务端的占位或真实
  // 对话随后到达；两路入口（鼠标点击与 ↑ 键）都从这里走，所以选中态只在这一处点亮。
  if (!npc.id.startsWith('colossus-person-')) world?.selectNpc(npc.id);
  if (npc.templateId.startsWith('windbell-')) { input?.reset(); activities?.talk(); return; }
  input?.reset();
  skills?.close();
  characterInfo?.close();
  petPanel?.close();
  return npcDialogue?.startTalk(npc);
}
function toggleSkills() {
  if (npcDialogue?.isOpen() || deathNotice?.isOpen()) return false;
  input?.reset();
  characterInfo?.close();
  petPanel?.close();
  return skills?.toggle() ?? false;
}
function toggleCharacterInfo() {
  if (npcDialogue?.isOpen() || deathNotice?.isOpen()) return false;
  input?.reset();
  skills?.close();
  petPanel?.close();
  return characterInfo?.toggle() ?? false;
}
let currentBossPractice: BossPracticeState | undefined;
let connectionState: 'connecting' | 'online' | 'offline' = 'offline';
function renderBossPractice(state: BossPracticeState | undefined, player: PlayerState | undefined, monsters: { templateId: string; hp: number; maxHp: number }[] = []) {
  currentBossPractice = state;
  const panel = el('boss-practice');
  panel.hidden = !state;
  if (!state) return;
  const inside = state.status !== 'available';
  el('boss-title').textContent = english ? 'Stumpy · P practice · Lv.25' : '树妖王 · P练习 · Lv.25';
  const detail = state.phaseLabel || state.blockReason || (state.status === 'cleared' ? (english ? 'Cleared. Retry or leave.' : '挑战成功，可重试或退出。') : state.status === 'failed' ? (english ? 'Failed. Revive before retrying.' : '挑战失败，复活后可重试。') : inside ? (english ? 'Move out of the marked attack area.' : '避开标记区域，等待攻击后再接近。') : (english ? 'No EXP or drops. Original quests are preserved.' : '不获得经验和掉落；保留原版任务状态。'));
  if (el('boss-detail').textContent !== detail) el('boss-detail').textContent = detail;
  const enter = el<HTMLButtonElement>('boss-enter');
  enter.textContent = inside ? (english ? 'Retry' : '重新挑战') : (english ? 'Enter practice' : '进入练习');
  enter.disabled = inside ? !player || player.hp <= 0 || state.status === 'active' : !state.canEnter;
  enter.dataset.action = inside ? 'retry' : 'enter';
  el<HTMLButtonElement>('boss-leave').hidden = !inside;
  const boss = monsters.find(monster => monster.templateId === state.bossId);
  const hp = el<HTMLProgressElement>('boss-hp');
  hp.hidden = !boss;
  if (boss) { hp.max = Math.max(1, boss.maxHp); hp.value = Math.max(0, boss.hp); hp.title = `${boss.hp} / ${boss.maxHp}`; }
}
function sendBossPractice(action: 'enter' | 'leave' | 'retry') {
  input?.reset(); skills?.releaseChannel();
  if (!connection?.send({ type: 'bossPractice', action, ...(action === 'enter' ? {} : { encounterId: currentBossPractice?.encounterId }), requestId: `practice-${crypto.randomUUID()}` })) status(english ? 'Reconnect before entering practice.' : '请重新连接后再操作练习。', true);
  focusGame();
}
el('boss-enter').onclick = () => sendBossPractice(el('boss-enter').dataset.action === 'retry' ? 'retry' : 'enter');
el('boss-leave').onclick = () => sendBossPractice('leave');
function renderMapRoute(manifest: Manifest) {
  const route = el('map-route');
  const names = [...new Set((manifest.map.portals ?? [])
    .map(portal => portal.targetMapId)
    .filter((mapId): mapId is string => Boolean(mapId))
    .map(mapId => {
      const map = manifest.mapCatalog?.maps.find(entry => entry.id === mapId);
      return map ? mapText(map.id, map.name) : undefined;
    })
    .filter((name): name is string => Boolean(name)))];
  route.textContent = names.length ? `${english ? '↑ Enter portal: ' : '↑ 进入传送门：'}${names.join(english ? ', ' : '、')}` : '';
  route.hidden = names.length === 0;
}
async function enterGame(session: LoginResponse) {
  let windbellSequence = 0;
  const current = ++generation;
  // Switch away from the character-select screen *before* fetching the
  // manifest.  The user picks a character and the very next frame should be
  // the full-bleed loading backdrop — not the character select still lingering
  // while `loadManifest()` runs.  The overlay mounts onto `#game-shell` and,
  // once `#play` is revealed, covers the whole viewport with the authored
  // high-resolution art plus the progress card for the entire boot pipeline.
  loadingOverlay?.hide();
  loadingOverlay = new LoadingOverlay(el('game-shell'));
  el('welcome').hidden = true;
  el('play').hidden = false;
  // Switch to game-mode *before* mounting the overlay, so `#game-shell`
  // already has its full 100dvh height when the overlay's `inset:0` is
  // measured — the backdrop then fills the viewport on its first paint instead
  // of starting at zero height.  `entry-active` is deliberately left for
  // `startGame` to remove after `enter` resolves; it only hides the header/
  // footer/status line, all of which the overlay covers anyway.
  setPlayLayout(true);
  loadingOverlay.show();
  loadingOverlay.update('manifest', null);
  status(english ? 'Loading resources…' : '正在读取资源清单…');
  try {
    const manifest = await loadManifest();
    if (current !== generation) return;
    el('map-name').textContent = mapText(manifest.map.id, manifest.map.name);
    renderMapRoute(manifest);
    // The manifest has arrived; advance the overlay into the asset-loading
    // stage.  Phaser's own loader still has hundreds of textures to fetch,
    // and `World.preload` will report the real percentage through `status`.
    loadingOverlay.update('assets', null);
    chat?.destroy();
    chat = new ChatView(el('chat'), manifest, message => status(message), {
      send: (requestId, text) => connection?.send({ type: 'chatSend', requestId, text }) ?? false,
      // A whisper carries only the typed name and the body; the server resolves
      // the identity and decides whether the pair may talk at all.
      sendWhisper: (requestId, targetName, text) => connection?.send({ type: 'whisperSend', requestId, targetName, text }) ?? false,
      isBlocked: () => Boolean(worldMap?.isOpen() || keybindingsView?.isOpen() || activities?.isOpen() || news.open || menus?.isOpen() || npcDialogue?.isOpen() || cashShop?.isOpen() || storage?.isOpen() || deathNotice?.isOpen() || skills?.isOpen() || characterInfoIsOpen() || petPanel?.isOpen() || party?.isOpen() || friends?.isOpen() || emoticons?.isOpen()),
      focusGame,
      selfId: () => selfState?.id,
    });
    deathNotice?.destroy();
    deathNotice = new DeathNoticeView(el('notices'), manifest, requestId => connection?.send({ type: 'revive', requestId }) ?? false, message => status(message));
    awayNotice?.destroy();
    awayNotice = new AwayNoticeView(el('notices'), () => {
      // Resuming is an intent, not a claim: the server re-checks identity,
      // binding and the away window, and only the next authoritative snapshot
      // actually reopens input.  The wake-up click must never also fire a
      // skill, purchase, or pickup.
      connection?.send({ type: 'lifecycle', hidden: false, away: false, clientNowMs: Date.now() });
    }, () => {
      // 回到选角界面: an explicit logout removes the character instead of
      // keeping it resident, then the entry flow reopens at char select.
      returnToEntry('characters');
    }, message => status(message));
    // 骑乘与坐姿的状态标记。两者都挂在 `#notices`（死亡提示与暂离横幅的同一个容器），
    // 都是**纯文字**：骑宠与椅子的贴图本轮未抽取，源装备窗也没有坐骑槽可依，
    // 因此不发明坐标，只显示服务端事实（见 F/mounts/README.md 的入口说明）。
    mountStatus?.destroy();
    mountStatus = new MountStatusView(el('notices'), message => status(message), request => connection?.send(request) ?? false);
    chairStatus?.destroy();
    chairStatus = new ChairStatusView(el('notices'));
    npcDialogue?.destroy();
    npcDialogue = new NpcDialogueView(el('ui-windows'), manifest, message => status(message, true), request => connection?.send(request) ?? false, () => { world?.selectNpc(null); if (selfState) focusGame(); });
    storage?.destroy();
    storage = new StorageView(el('ui-windows'), manifest, message => status(message, true), request => connection?.send(request) ?? false);
    party?.destroy();
    party = new PartyView(el('ui-windows'), manifest, message => status(message, true), request => connection?.send(request) ?? false, () => selfState?.id);
    friends?.destroy();
    // The friend window is account-backed, so it asks the server for its rows
    // on open instead of waiting for a push the way the session-scoped party
    // window does.
    friends = new FriendView(el('ui-windows'), manifest, message => status(message, true), request => connection?.send(request) ?? false, () => selfState?.id);
    // The emoticon window is a picker with no state of its own: it sends one
    // `emoticonSend` intent and the server decides whether the sticker exists,
    // whether the source send budget allows it, and who in the map room sees it.
    emoticons?.destroy();
    emoticons = new EmoticonView(el('ui-windows'), manifest, message => status(message, true), request => connection?.send(request) ?? false);
    cashShop?.destroy();
    cashShop = new CashShopView(el('ui-windows'), manifest, status, request => connection?.send(request) ?? false);
    miniMap?.destroy();
    miniMap = new MiniMapView(el('minimap'), manifest);
    miniMap.mount();
    // The WORLD button opens the authored world map: the root page overview
    // first, with the region the character stands in marked on it.
    worldMap?.destroy();
    worldMap = new WorldMapView(el('ui-windows'), manifest);
    worldMap.onStatus = message => status(message, true);
    worldMap.onClose = focusGame;
    // World-map jump: the view only names the clicked spot's map id; the
    // server decides whether that map is assembled and where the body lands.
    worldMap.onJump = mapId => {
      input?.reset();
      const requestId = `worldmap-${Date.now()}-${++portalSequence}`;
      const english = uiLocale() === 'en';
      if (connection?.send({ type: 'worldMapMove', requestId, mapId })) {
        status(english ? `World map jump: ${mapId}` : `世界地图跳转：${mapId}`);
      }
    };
    worldMap.hotkeysEnabled = false;
    miniMap.onWorldMap = () => { input?.reset(); worldMap?.open(); };
    notebook?.destroy();
    notebook = new NotebookView(el('ui-windows'), manifest, {
      send: message => connection?.send(message) ?? false,
      status: message => status(message, true),
    });
    questLog?.destroy();
    questLog = new QuestLogView(el('ui-windows'), manifest);
    // 源自助任务（QuestInfo selfStart/selfComplete）没有 NPC，入口就在任务视窗；
    // 这里只发意图，服务端仍会重跑全部原作门控。
    questLog.onService = (questId, action) => {
      input?.reset();
      const requestId = `quest-${Date.now()}-${++questSequence}`;
      if (!connection?.send({ type: 'questService', requestId, questId, action })) {
        status(uiLocale() === 'en' ? 'Reconnect before acting on quests.' : '请重新连接后再操作任务。', true);
      }
    };
    skills?.destroy();
    skills = new SkillView(el('ui-windows'), manifest, {
      send: message => connection?.send(message) ?? false,
      status,
      bindSkill: skillId => { skills?.close(); openKeybindings(skillId); },
      shortcutLabel: skillId => keybindingsView?.skillKeys(skillId) ?? '',
    });
    skills.hotkeysEnabled = false;
    characterInfo?.destroy();
    characterInfo = new CharacterInfoView(el('ui-windows'), manifest, message => status(message), request => connection?.send(request) ?? false);
    characterInfo.hotkeysEnabled = false;
    petPanel?.destroy();
    petPanel = new PetPanel(el('ui-windows'), manifest, message => status(message), request => connection?.send(request) ?? false);
    menus?.destroy();
    activities?.destroy();
    activities = new ActivitiesView(el('ui-windows'), (action, instanceId) => {
      input?.reset();
      if (!connection?.send({ type: 'windbell', action, instanceId, sequence: ++windbellSequence, requestId: `windbell-${crypto.randomUUID()}` })) status('请重新连接后再进入活动。', true);
    }, focusGame, () => sendColossus('enter'), action => colossusView?.control(action), () => openKeybindings(), manifest, {
      enabled: () => world?.isThreeActive ?? false,
      available: () => Boolean(world?.isLoaded && world.mapId === HENESYS_MAP_ID && !colossusView),
      setEnabled: enabled => { if (colossusView || world?.mapId !== HENESYS_MAP_ID) return; input?.reset(); world.setThreeEnabled(enabled); },
      resetCamera: () => world?.resetThreeCamera(),
    });
    menus = new MenuView(
      el('menus'),
      manifest,
      message => status(message),
      () => inventory?.toggle(),
      () => { leaveGame(true); entry.showLogin(); },
      () => inventory?.toggleEquipment(),
      () => questLog?.open(),
      toggleSkills,
      toggleCharacterInfo,
      () => returnToEntry('channel'),
      () => returnToEntry('characters'),
      showNews,
      showNews,
      () => party?.toggle() ?? false,
      // Source UITotalMenu type 24 is the 好友&黑名單 shortcut.
      () => friends?.toggle() ?? false,
      // Source UITotalMenu type 29 is the 表情 / chat emoticon shortcut.
      () => emoticons?.toggle() ?? false,
      () => { input?.reset(); activities?.show(); },
      // Source UITotalMenu type 19 is the 世界地圖 shortcut.
      () => { input?.reset(); worldMap?.open(); },
      // The 現金商店 operation opens the cash-shop window (source CashShop.img).
      openCashShop,
      () => openKeybindings(),
      // Source UITotalMenu type 22 (怪物收藏) is the single notebook entry:
      // opening it closes the menu and shows the same window every time.
      () => { input?.reset(); menus?.close(); notebook?.open(); },
    );
    // The menu bar is the escape hatch: with nothing else open, Escape raises
    // it (and a second Escape lowers it).  The menu keeps its own close
    // listener, so the router only ever handles the "nothing is open" case.
    escapeRouterDispose?.();
    escapeRouterDispose = installEscapeRouter({
      blocked: gameplayUiBlocked,
      menuOpen: () => Boolean(menus?.isOpen()),
      toggleMenu: () => { menus?.toggle('game'); },
    });
    inventory?.destroy();
    inventory = new InventoryView(el('ui-windows'), manifest, message => status(message), request => connection?.send(request) ?? false);
    inventory.hotkeysEnabled = false;
    keybindingsView?.destroy();
    keybindingsView = new KeybindingsView(el('ui-windows'), manifest, keybindings, status);
    keybindingsDispose?.();
    keybindingsDispose = keybindings.subscribe(() => { input?.reset(); hud?.releaseChannel(); hud?.update(selfState); });
    keyRouterDispose?.();
    keyRouterDispose = installKeybindingRouter({
      resolve: (code, shift) => keybindings.resolve(code, shift),
      blocked: () => !selfState || Boolean(activities?.isOpen() || keybindingsView?.isOpen() || news.open || npcDialogue?.isOpen() || cashShop?.isOpen() || storage?.isOpen() || deathNotice?.isOpen()),
      activate: activateUiAction,
    });
    hud?.destroy();
    hud = new HudView(el('hud'), manifest, message => status(message), () => inventory?.toggle(), trigger => menus?.toggle('game', trigger), undefined, {
      openCashShop,
      keySlots: () => keybindings.slots,
      resolveBinding: (code, shift) => keybindings.resolve(code, shift),
      bindingLabel: binding => keybindingsView?.bindingLabel(binding) ?? '',
      activateBinding,
      editSlot: slot => { openKeybindings(); keybindingsView?.selectSlot(slot); },
      bindSkill: (slot, skillId) => keybindingsView?.bindSkillToSlot(slot, skillId),
      bindItem: (slot, itemId) => keybindingsView?.bindItemToSlot(slot, itemId),
      openActivities: () => { input?.reset(); activities?.show(); },
      openPets: () => {
        input?.reset();
        skills?.close();
        characterInfo?.close();
        petPanel?.toggle();
      },
      castSkill: skillId => {
        if (!selfState || keybindingsView?.isOpen() || news.open || menus?.isOpen() || npcDialogue?.isOpen() || cashShop?.isOpen() || storage?.isOpen() || deathNotice?.isOpen() || skills?.isOpen() || characterInfoIsOpen() || petPanel?.isOpen() || party?.isOpen() || friends?.isOpen() || emoticons?.isOpen()) return;
        return castSkill(skillId);
      },
      releaseSkill: requestId => { connection?.send({ type: 'releaseSkill', requestId }); },
    });
    // The loading overlay covers the whole boot window and may only come
    // down when BOTH sides are ready: the first authoritative snapshot has
    // been announced AND the world scene finished preloading.  The server
    // starts pushing snapshots the moment the WebSocket handshake lands —
    // typically while Phaser is still fetching hundreds of textures — so
    // hiding on the snapshot alone exposed the raw canvas with the top
    // "正在装载地图与角色 · NN%" line climbing for the rest of the boot.
    // Whichever side finishes last reveals the game; the gate on
    // `loadingOverlay` keeps later status lines from re-running the reveal.
    const revealGame = () => {
      if (!loadingOverlay || !world?.isLoaded) return;
      loadingOverlay.hide();
      loadingOverlay = undefined;
    };
    world = new World(manifest, (message, error) => {
      status(message, error);
      // World.create reports readiness through the status channel after
      // `isLoaded` flipped true; when the snapshot beat the textures, this
      // is the side that finishes last and performs the reveal.
      if (!error) revealGame();
      if (error) { input?.setReady(false); connection?.close(); chat?.clear(); hud?.clear(); inventory?.clear(); skills?.clear(); characterInfo?.update(undefined); characterInfo?.close(); petPanel?.clear(); petPanel?.close(); mountStatus?.clear(); chairStatus?.clear(); menus?.close(); party?.close(); friends?.close(); emoticons?.close(); deathNotice?.clear(); awayNotice?.clear(); loadingOverlay?.hide(); loadingOverlay = undefined; el('connection').textContent = english ? 'Resource load failed' : '资源加载失败'; el('reconnect').hidden = true; }
    }, request => {
      const requestId = `portal-${Date.now()}-${++portalSequence}`;
      if (connection?.send({ type: 'portal', requestId, portalName: request.portalName })) {
        status(english ? `Portal request: ${request.sourceMapId}/${request.portalName} → ${request.targetMapId}` : `传送请求：${request.sourceMapId}/${request.portalName} → ${request.targetMapId}`);
      }
    }, talkToNpc, questId => {
      if (gameplayUiBlocked()) return;
      input?.reset();
      connection?.send({ type: 'questInteract', requestId: `quest-${Date.now()}-${++skillRequestSequence}`, questId });
    }, reactorId => {
      if (gameplayUiBlocked()) return;
      input?.reset();
      connection?.send({ type: 'reactorHit', requestId: `reactor-${Date.now()}-${++skillRequestSequence}`, reactorId });
    }, tombstoneId => {
      // 原创扩展「死亡世界」：点击墓碑 = 悼念一次。服务器裁决一切（存在、
      // 距离、到期、去重），这里只上报意图。
      if (gameplayUiBlocked()) return;
      input?.reset();
      if (!connection?.send({ type: 'tombstoneMourn', requestId: `tombstone-${Date.now()}-${++skillRequestSequence}`, tombstoneId })) {
        status(english ? 'Reconnect before interacting.' : '请重新连接后再操作。', true);
      }
    });
    // loader.imageLoadType：Phaser 默认 'XHR'——每张图都要走 XHR→Blob→objectURL→Image
    // 四步，23.5k 张图时这一层开销就是「装载地图与角色」的主要成本（实测服务端能到
    // 6000 req/s、而客户端 1.1ms/张）。'HTMLImageElement' 直接 <img src>，省掉 blob
    // 中转，也让浏览器自己的解码/缓存路径生效。
    game = new Phaser.Game({ type: Phaser.AUTO, parent: 'game', width: el('game').clientWidth, height: el('game').clientHeight, backgroundColor: '#b4dfe0', transparent: true, pixelArt: true, roundPixels: true, scene: [world], scale: { mode: Phaser.Scale.RESIZE }, input: { keyboard: false }, banner: false, loader: { imageLoadType: 'HTMLImageElement' } });
    layoutObserver = new ResizeObserver(() => {
      const { clientWidth: width, clientHeight: height } = el('game');
      if (width && height && game && (game.scale.width !== width || game.scale.height !== height)) game.scale.resize(width, height);
      el('game-shell').style.setProperty('--hud-height', `${el('hud').getBoundingClientRect().height}px`);
    });
    layoutObserver.observe(el('game'));
    layoutObserver.observe(el('hud'));
    let announcedMapId: string | undefined;
    connection = new Connection(session, message => {
      if (message.type === 'snapshot' && message.colossus) {
        if (!colossusView) { input?.reset(); world?.scene?.setVisible(false); world?.scene?.pause(); game?.sound.pauseAll(); colossusView=new ColossusView(el('game'),manifest,sendColossus,text => { status(text); chat?.appendSystem(text); }, talkToNpc); colossusView.setMuted(muted); }
        colossusView.receive(message);
      } else {
        if (message.type === 'snapshot' && colossusView) {colossusView.destroy();colossusView=undefined;world?.scene?.setVisible(true);world?.scene?.resume();game?.sound.resumeAll();}
        if (colossusView && message.type === 'skillCast') colossusView.skill(message);
        else world?.receive(message);
      }
      inventory?.receive(message);
      if (message.type === 'chatMessage') {
        chat?.appendChatMessage(message);
        return;
      }
      if (message.type === 'whisperMessage') {
        chat?.appendWhisperMessage(message);
        return;
      }
      if (message.type === 'gmResult') {
        chat?.appendGmResult(message);
        return;
      }
      if (message.type === 'npcResult') {
        npcDialogue?.receive(message);
        if (message.openSkills) {
          npcDialogue?.clear();
          skills?.open();
          status('技能窗口已打开。');
        }
        // A warehouse keeper has no dialogue tree: the answer *is* the open
        // action, so ask the server for the authoritative contents and let it
        // decide whether the player really is at a keeper in range.
        if (message.openStorage) {
          npcDialogue?.clear();
          connection?.send({
            type: 'storageOpen',
            requestId: `storage-open-${Date.now().toString(36)}`,
            npcId: message.npcId,
          });
        }
      }
      if (message.type === 'storageState') {
        if (message.closed) {
          storage?.close();
        } else if (message.npcId && message.items && message.slotLimit !== undefined) {
          storage?.open({
            npcId: message.npcId,
            items: message.items,
            mesos: message.mesos ?? 0,
            slotLimit: message.slotLimit,
          });
        }
      }
      if (message.type === 'storageResult') {
        if (!message.success) {
          storage?.showResult(message.code, false);
          status(protocolText(message.code, `${uiLocale() === 'en' ? 'Storage action failed' : '仓库操作失败'}`), true);
        } else {
          storage?.showResult('', true);
        }
      }
      if (message.type === 'storageMesos') {
        if (message.success) {
          chat?.appendSystem(
            `${message.operation === 'deposit' ? (uiLocale() === 'en' ? 'Stored' : '存入') : (uiLocale() === 'en' ? 'Withdrew' : '取出')} ${message.quantity} ${uiText('meso')}`,
            `storage:${message.requestId}`,
          );
        } else {
          storage?.showResult(message.code, false);
          status(protocolText(message.code, `${uiLocale() === 'en' ? 'Mesos transfer failed' : '枫币搬运失败'}`), true);
        }
      }
      if (message.type === 'partyState') {
        // The roster is authoritative and self-contained: a closed flag closes
        // the window, otherwise the whole member list is replaced.
        party?.receiveState(message);
      }
      if (message.type === 'partyInvite') {
        party?.receiveInvite({
          invitationId: message.invitationId,
          fromId: message.fromId,
          fromName: message.fromName,
        });
        status(uiLocale() === 'en'
          ? `${message.fromName} invites you to a party.`
          : `${message.fromName} 邀请你加入队伍。`);
      }
      if (message.type === 'partyResult') {
        party?.receiveResult(message.code, message.success);
        if (!message.success) {
          status(protocolText(message.code, `${uiLocale() === 'en' ? 'Party action failed' : '队伍操作失败'}`), true);
        }
      }
      if (message.type === 'partyNotice') {
        party?.receiveNotice(message.code, message.playerName);
        status(protocolText(message.code, english ? 'Party notice' : '队伍通知'), message.code !== 'party_declined');
      }
      if (message.type === 'shipEvent') {
        // 飞行船甲板袭击播报（三期）：服务端权威事实，客户端只做展示——巴洛古
        // 本身按普通怪物走 `monsters[]` 快照，这里只是把起止那一刻提示给全甲板。
        // 怪物名是源名表里的繁体专名，句子按产品默认用简体。
        const attacking = message.event === 'balrog_attack';
        status(
          attacking
            ? (uiLocale() === 'en'
              ? `${message.monsterName} is attacking the deck!`
              : `${message.monsterName} 袭击甲板！`)
            : (uiLocale() === 'en' ? 'The deck is quiet again.' : '甲板上的袭击已经平息。'),
          attacking,
        );
      }
      if (message.type === 'friendState') {
        // Friends are an account fact, so both lists always arrive together:
        // a block also dissolves the friendship, and a half-window would let
        // the client show a row the account no longer has.
        friends?.receiveState(message);
      }
      if (message.type === 'friendResult') {
        friends?.receiveResult(message.code, message.success);
        if (!message.success) {
          status(protocolText(message.code, `${uiLocale() === 'en' ? 'Friend action failed' : '好友操作失败'}`), true);
        }
      }
      if (message.type === 'shopResult') {
        if (message.success) {
          chat?.appendSystem(`${uiLocale() === 'en' ? 'Bought' : '购买'} ${itemName(message.itemId)} × ${message.quantity}（${message.mesosSpent} ${uiText('meso')}）`, `shop:${message.requestId}`);
        } else {
          status(protocolText(message.code, english ? 'Purchase failed' : '购买失败'), true);
        }
      }
      if (message.type === 'shopSold') {
        if (message.success) {
          chat?.appendSystem(`${uiLocale() === 'en' ? 'Sold' : '出售'} ${itemName(message.itemId)} × ${message.quantity}（+${message.mesosGained} ${uiText('meso')}）`, `shop:${message.requestId}`);
        } else {
          status(protocolText(message.code, `${uiLocale() === 'en' ? 'Sale failed' : '出售失败'}`), true);
        }
      }
      if (message.type === 'shopRebuyState') {
        npcDialogue?.receiveRebuyState(message.entries);
      }
      if (message.type === 'cashState' || message.type === 'cashBuyResult') {
        cashShop?.receive(message);
        if (message.type === 'cashBuyResult' && message.success) {
          chat?.appendSystem(`${uiLocale() === 'en' ? 'Cash purchase' : '现金商店购买'}：${itemName(message.itemId)} × ${message.quantity}（-${message.cashSpent} 楓點）`, `cash:${message.requestId}`);
        }
      }
      if (message.type === 'rentalNotice') {
        const names = [...new Set(message.itemIds)].map(id => itemName(id)).join(uiLocale() === 'en' ? ', ' : '、');
        chat?.appendSystem(
          uiLocale() === 'en' ? `Rental expired: ${names}` : `租赁道具已到期收回：${names}`,
          `rental:${Date.now()}`,
        );
      }
      if (message.type === 'shopRebought') {
        if (message.success) {
          chat?.appendSystem(`${uiLocale() === 'en' ? 'Bought back' : '赎回'} ${itemName(message.itemId)} × ${message.quantity}（-${message.mesosSpent} ${uiText('meso')}）`, `shop:${message.requestId}`);
        } else {
          status(protocolText(message.code, `${uiLocale() === 'en' ? 'Buy-back failed' : '赎回失败'}`), true);
        }
      }
      if (message.type === 'pickupResult') {
        chat?.appendSystem(`${uiLocale() === 'en' ? 'Obtained' : '获得'} ${itemName(message.itemId)} × ${message.quantity}`, `pickup:${message.requestId}`);
      }
      if (message.type === 'skillResult') {
        const reason: Record<string, string> = { cost_changed: '重置报价已变化，请重新确认。', not_enough_mesos: '枫币不足。', hyper_no_investment: '尚未投资超级技能。', not_enough_hyper_points: '当前超级技能点不足，升级后可获得下一点。', level_requirement: '角色等级尚未达到要求。', not_enough_mp: '魔力不足，请补充 MP。', skill_cooldown: '技能冷却中，请查看技能窗口。',
          not_learned: '请先在技能窗口学习此技能。', not_enough_sp: '技能点不足。', prerequisite: '请先学满所需前置等级。',
          wrong_job: '完成对应转职后可使用。', skill_hidden: '此技能由主技能自动触发。', max_level: '技能已达最高等级。' };
        status(message.success
          ? (message.operation === 'hyper_reset' ? '超级技能已重置，点数已返还。' : message.operation === 'learn' ? '技能已学习。' : '技能已施放。')
          : reason[message.code] ?? protocolText(message.code, english ? 'Skill action failed' : '技能操作失败'), !message.success);
      }
      if (message.type === 'abilityResult') {
        characterInfo?.receiveAbilityResult(message);
        status(message.success ? '属性点已分配。' : protocolText(message.code, english ? 'Could not assign the point' : '属性点分配失败'), !message.success);
      }
      if (message.type === 'questList') {
        questLog?.setList(message.quests);
      }
      // 冒险笔记：一页私有事实按 requestId 对齐，过期响应由窗口自己丢弃。
      // `blockedReason` 是**这一页**的状态说明（例如怪物登记规则尚未核定，
      // 计划 §5.5），由窗口画在页内；把它抬成全局红字会把这件已知、预期的事
      // 说成一次失败，而且每次开窗都重复一次。真正的错误各有自己的通道：
      // 目录版本错配由窗口 `receiveState` 判出并报错，连接与目录失败走窗口的
      // `status` 回调。
      if (message.type === 'notebookState') notebook?.receiveState(message);
      if (message.type === 'notebookChanged') notebook?.receiveChange(message);
      if (message.type === 'questUpdate') {
        questLog?.upsert(message);
        const parts: string[] = [];
        if (message.reward.exp > 0) parts.push(`${message.reward.exp} EXP`);
        if (message.reward.mesos > 0) parts.push(`${message.reward.mesos} ${uiText('meso')}`);
        for (const item of message.reward.items) parts.push(`${itemName(item.itemId)} × ${item.quantity}`);
        const reward = parts.join('、');
        if (message.status === 'active') {
          chat?.appendSystem(`${uiLocale() === 'en' ? 'Quest accepted' : '接受任务'}：${message.name}`, `quest:${message.questId}:active`);
        } else if (message.status === 'completed') {
          chat?.appendSystem(`${uiLocale() === 'en' ? 'Quest completed' : '任务完成'}：${message.name}${reward ? ` · ${uiLocale() === 'en' ? 'Reward' : '获得'} ${reward}` : ''}`, `quest:${message.questId}:completed`);
        }
      }
      if (message.type === 'worldMapMoveResult') {
        // The window stays open either way: on success the next snapshot's
        // `setMap` moves the location plate, on failure the map is unchanged.
        const english = uiLocale() === 'en';
        if (message.success) status(english ? `Arrived at ${message.mapId}` : `已抵达 ${message.mapId}`);
        else status(`${english ? 'World map jump failed' : '世界地图跳转失败'}：${protocolText(message.code, english ? 'no route' : '没有可用路线')}`, true);
      }
      if (message.type === 'snapshot') {
        windbellSequence = Math.max(windbellSequence, message.windbellSequence ?? 0);
        colossusSequence = Math.max(colossusSequence, message.colossusSequence ?? 0);
        el('population').textContent = `${message.players.length} ${english ? 'adventurers' : '位冒险者'}`;
        const currentMap = world?.getMap(message.mapId);
        if (currentMap && world?.mapId === message.mapId) {
          el('map-name').textContent = mapText(currentMap.id, currentMap.name);
          renderMapRoute({ ...manifest, map: currentMap as Manifest['map'] });
        }
        const self = message.players.find(player => player.id === message.selfId);
        selfState = self;
        if (self) keybindings.setCharacter(self.id, self.job ?? 0);
        keybindingsView?.update(self);
        activities?.update(message.windbell, self, message.npcs);
        renderBossPractice(message.bossPractice, self, message.monsters);
        // The minimap is a pure view: the server's map id, its own player list
        // and the map's authored portal list are everything it is allowed to
        // draw, and the roster (already authoritative) only tints the dots.
        miniMap?.update(message.colossus && colossusView ? { ...colossusView.maps.input(message.colossus, message.players, message.selfId), partyIds: party?.memberIds() } : {
          mapId: message.mapId,
          self,
          players: message.players,
          npcs: message.npcs,
          portals: currentMap?.portals,
          partyIds: party?.memberIds(),
        });
        // The world map's `M` hotkey and menu entry open on the region the
        // character stands in, so the view tracks the authoritative map id.
        worldMap?.setMap(message.colossus ? `colossus:${message.colossus.region}` : message.mapId);
        worldMap?.setActivityData(message.colossus ? colossusView?.maps.world : undefined);
        activities?.updateColossus(Boolean(message.colossus));
        hud?.update(self);
        inventory?.update(self, message.mapId.startsWith('practice:'));
        skills?.update(self);
        characterInfo?.update(self);
        petPanel?.update(self);
        deathNotice?.update(self);
        awayNotice?.update(self);
        // 骑乘/坐姿标记紧邻 petPanel：两者都是「快照里有没有那个字段」的投影，
        // 不参与任何窗口生命周期，也不需要开合状态。
        mountStatus?.update(self);
        chairStatus?.update(self);
        if (self) npcDialogue?.syncPlayer(self);
        // The cash shop's readout mirrors the authoritative wallet between
        // cashState pushes.
        if (self) cashShop?.syncPlayer(self);
        // The warehouse's deposit side mirrors the live bag + purse, so a
        // pickup or a sale while the window is open is reflected at once.
        if (self) storage?.syncPlayer(self);
        if (announcedMapId !== message.mapId) {
          npcDialogue?.clear();
          storage?.close();
          cashShop?.close();
          skills?.releaseChannel();
          hud?.releaseChannel();
          input?.reset();
          announcedMapId = message.mapId;
          // First authoritative snapshot for this session: the server has
          // accepted our identity and the player is on a real map.  The
          // snapshot itself usually lands while Phaser is still preloading
          // (the WebSocket handshake takes milliseconds, the texture fetch
          // seconds), so the overlay must NOT come down here — `revealGame`
          // retires it once the world scene reports ready as well.
          status(`${uiText('enteredMap', '已进入')} ${message.colossus ? '巨石之约' : currentMap ? mapText(currentMap.id, currentMap.name) : mapText(manifest.map.id, manifest.map.name)} · ${session.username}`);
          revealGame();
          // 源地图入口脚本（`Map.wz/info/onUserEnter` → `manifest…entryScripts`）在
          // 本次改动前**没有消费者**，地图声明什么都不发生。这里落地其中语义自明的
          // 一个：`warning_MobLevel`（源的越级警告，全目录只有 `102030000 黑肥肥領土`
          // 与 `102040000 初期挖掘地區` 两张图声明，恰好是 Perion 片区唯一的越级图）。
          // 判据全在 `features/world/entry-script.ts`：脚本存在 **且** 图内已刷新的
          // 最强怪物确实高于玩家等级才出提示，所以提示永远为真。句子只报告事实。
          const entryScripts = (manifest.mapCatalog?.maps.find(entry => entry.id === message.mapId) ?? (manifest.map.id === message.mapId ? manifest.map : undefined))?.entryScripts;
          const warning = mapEntryWarning({
            scripts: entryScripts,
            playerLevel: self?.level,
            monsters: message.monsters,
            monsterLevel: templateId => {
              const level = manifest.monsters?.[templateId]?.info?.level;
              if (typeof level === 'number') return level;
              return typeof level === 'string' && level.trim() !== '' ? Number(level) : undefined;
            },
          });
          if (warning) chat?.appendSystem(english
            ? `Monsters in this field reach Lv${warning.monsterLevel} — above your Lv${warning.playerLevel}.`
            : `此地的怪物等級最高 Lv${warning.monsterLevel}，高於你的 Lv${warning.playerLevel}，請小心。`);
        }
      }
      else       if (message.type === 'rejected') {
        if (message.code === 'colossus_action' && uiLocale() !== 'en') status(message.message, true);
        else if (message.code === 'drop_owned') chat?.appendSystem(protocolText(message.code, message.message), `pickup-rejected:${message.requestId}`);
        else if (['reactor_unknown', 'reactor_busy', 'reactor_spent', 'reactor_out_of_range'].includes(message.code)) {
          // A reactor rejection is a normal gameplay outcome, not an error:
          // the prop may already have been taken by someone else on the map.
          // It still gets one line — silence is what made a lost race read as
          // "the click did nothing".
          if (message.code === 'reactor_unknown') console.debug('[protocol] reactor request was stale or forged', message.message);
          else status(protocolText(message.code, message.message), message.code !== 'reactor_spent');
        }
        else if (['tombstone_unknown', 'tombstone_gone', 'tombstone_out_of_range'].includes(message.code)) {
          // 原创扩展「死亡世界」：悼念被拒同样是一次正常结果——碑可能刚刚
          // 到期或被人先行处理，说一句就够，不升红字。
          status(protocolText(message.code, message.message));
        }
        // A rejected whisper behaves exactly like a rejected chat line: the
        // draft is restored (still addressed to the same target) and the
        // server's reason is shown.
        else if (['emoticon_unknown', 'emoticon_rate_limited'].includes(message.code)) {
          // The emoticon window is a picker, so its refusals belong in the
          // window's own caption bar where the player is looking; the status
          // line mirrors the same reason for the message log.
          emoticons?.receiveRejection(message.code, message.message);
          status(protocolText(message.code, message.message), true);
        }
        else if (['chat_rate_limited', 'invalid_chat_text', 'idempotency_conflict', 'whisper_unknown_player', 'whisper_self', 'whisper_offline', 'whisper_blocked', 'whisper_ignored'].includes(message.code)) {
          // A rejected chat restores the draft and shows the server reason.
          chat?.failPending(message.requestId, protocolText(message.code, message.message));
        } else if (['boss_practice_cleared', 'boss_practice_left', 'boss_practice_failed'].includes(message.code)) {
          status(protocolText(message.code, message.message), message.code === 'boss_practice_failed');
        } else if (!deathNotice?.reject(message)) {
          // The raw code is developer diagnostics, not player copy: it used to
          // be appended to every untranslated line.  Keep it in the console so
          // a missing translation is still findable.
          if (!hasProtocolError(message.code)) console.debug('[protocol] 未翻譯的拒絕碼', message.code, message.message);
          status(protocolText(message.code, message.message), true);
        }
      }
      else if (message.type === 'reviveResult') deathNotice?.receive(message);
      if (message.type === 'tombstoneResult') {
        // 悼念回执是**私人**结果：碑文、虚影阶段与悼念人数只发给悼念者本人，
        // 与恢复跳字同一隐私口径。alreadyMourned 是重放，措辞相应区分。
        const stage = uiLocale() === 'en' ? `echo: ${message.stageName}` : `虚影 · ${message.stageName}`;
        const mourners = uiLocale() === 'en'
          ? `${message.mourners} ${message.mourners === 1 ? 'mourner' : 'mourners'}`
          : `${message.mourners} 人悼念`;
        const summary = `${message.characterName} · ${stage} · ${mourners}`;
        chat?.appendSystem(`${uiLocale() === 'en' ? 'Mourned' : '悼念了'} ${message.characterName}：「${message.epitaph}」（${summary}）`, `tombstone:${message.requestId}`);
        status(message.alreadyMourned
          ? `${uiLocale() === 'en' ? 'You already mourned this tombstone.' : '你已经悼念过这座墓碑。'}${summary}`
          : `${uiLocale() === 'en' ? `Rest in peace, ${message.characterName}.` : `愿 ${message.characterName} 安息。`}${summary}`);
      }
    }, (state, reason) => {
      connectionState = state;
      el('connection').textContent = state === 'online' ? `● ${english ? 'Connected' : '已连接'} · ${session.username}` : state === 'connecting' ? (english ? 'Connecting…' : '正在连接…') : (english ? 'Disconnected' : '连接已断开');
      el('connection').classList.toggle('online', state === 'online');
      el('reconnect').hidden = state !== 'offline';
      input?.setReady(state === 'online');
      if (state === 'online') focusGame();
      chat?.setAvailable(state === 'online');
      if (state !== 'online') { colossusView?.destroy(); colossusView=undefined; world?.scene?.setVisible(true); world?.scene?.resume(); keybindingsView?.close(); renderBossPractice(undefined, undefined); announcedMapId = undefined; selfState = undefined; world?.disconnect(); chat?.clear(); hud?.clear(); inventory?.clear(); skills?.clear(); characterInfo?.update(undefined); characterInfo?.close(); petPanel?.clear(); petPanel?.close(); mountStatus?.clear(); chairStatus?.clear(); menus?.close(); party?.close(); friends?.close(); emoticons?.close(); miniMap?.clear(); deathNotice?.clear(); awayNotice?.clear(); npcDialogue?.clear(); storage?.close(); cashShop?.close(); questLog?.clear(); party?.close(); friends?.close(); status(reason || (english ? 'Connecting to map server…' : '正在连接地图服务器…'), state === 'offline'); }
    });
    input = new PlayerInput(message => connection?.send(message), {
      nearestDrop: () => colossusView ? null : world?.nearestDropId() ?? null,
      enterPortal: () => { if (colossusView) sendColossus('travel'); else world?.enterPortal(); },
      nearestNpc: () => colossusView ? colossusView.nearestNpc(true) : world?.nearestNpc() ?? null,
      talkTo: talkToNpc,
      nearestReactor: () => colossusView ? null : world?.nearestReactor()?.id ?? null,
      hitReactor: reactorId => {
        if (!connection?.send({ type: 'reactorHit', requestId: `reactor-${Date.now()}-${++skillRequestSequence}`, reactorId })) {
          status(english ? 'Reconnect before interacting.' : '请重新连接后再操作。', true);
        }
      },
      toggleQuestLog: () => questLog?.toggle() ?? false,
      toggleSkills,
      castSkill,
      playerState: () => selfState,
      mapDirection: raw => colossusView?.direction(raw) ?? raw,
      resolveBinding: (code, shift) => keybindings.resolve(code, shift),
      performAction: action => { activateUiAction(action); },
      useItem: useShortcutItem,
      isBlocked: () => Boolean(worldMap?.isOpen() || keybindingsView?.isOpen() || activities?.isOpen() || news.open || menus?.isOpen() || npcDialogue?.isOpen() || cashShop?.isOpen() || storage?.isOpen() || deathNotice?.isOpen() || skills?.isOpen() || characterInfoIsOpen() || petPanel?.isOpen() || party?.isOpen() || friends?.isOpen() || emoticons?.isOpen()),
    });
    connection.connect();
    el('game').focus({ preventScroll: true });
  } catch (error) { leaveGame(); throw error; }
}
const entry = new EntryView(el('welcome'), enterGame);
// 首页右下角的更新/下载区（v3 §6.1）：挂在 `#app` 下，与 PageShell 会搬进
// 消息窗的 header/footer/#message 是兄弟节点，因此不会被那段逻辑带走；
// 它只依赖 `/api/client-release`，不依赖 manifest / 外观 / Phaser 初始化。
const clientActions = new ClientActionsView(document.querySelector<HTMLElement>('#app')!);
entry.onStageChange = stage => clientActions.setVisible(stage === 'login');
el('game').onpointerdown = () => el('game').focus({ preventScroll: true });
el('reconnect').onclick = () => { connection?.connect(); el('game').focus({ preventScroll: true }); };
el('sound').onclick = () => { muted = !muted; world?.setMuted(muted); colossusView?.setMuted(muted); el('sound').textContent = english ? `Sound: ${muted ? 'Off' : 'On'}` : `声音：${muted ? '关' : '开'}`; el('game').focus({ preventScroll: true }); };
function leaveGame(logout = false) {
  // Closing the socket is not a logout: the server keeps the character
  // resident so a tab switch or reload can take it over.  Only an explicit
  // logout tells the server to remove the character, so switching to another
  // character does not leave the previous one standing in the world.
  if (logout) connection?.send({ type: 'logout' });
  layoutObserver?.disconnect(); layoutObserver = undefined;
  escapeRouterDispose?.(); escapeRouterDispose = undefined;
  // Hide the loading overlay before the game view collapses so a partially
  // bootstrapped session doesn't leave an orphaned progress card behind.
  loadingOverlay?.hide(); loadingOverlay = undefined;
  setPlayLayout(false);
  activities?.destroy(); activities = undefined;
  cashShop?.destroy(); cashShop = undefined;
  keyRouterDispose?.(); keyRouterDispose = undefined;
  keybindingsDispose?.(); keybindingsDispose = undefined;
  keybindingsView?.destroy(); keybindingsView = undefined;
  colossusView?.destroy(); colossusView=undefined;
  generation++; selfState = undefined; characterInfo?.update(undefined); petPanel?.destroy(); petPanel = undefined; mountStatus?.destroy(); mountStatus = undefined; chairStatus?.destroy(); chairStatus = undefined; input?.destroy(); input = undefined; connection?.close(); connection = undefined; game?.destroy(true); game = undefined; world = undefined; chat?.destroy(); chat = undefined; menus?.destroy(); menus = undefined; deathNotice?.destroy(); deathNotice = undefined; awayNotice?.destroy(); awayNotice = undefined; hud?.destroy(); hud = undefined; inventory?.destroy(); inventory = undefined; npcDialogue?.destroy(); npcDialogue = undefined; questLog?.destroy(); questLog = undefined; notebook?.destroy(); notebook = undefined; party?.destroy(); party = undefined; friends?.destroy(); friends = undefined; emoticons?.destroy(); emoticons = undefined; miniMap?.destroy(); miniMap = undefined; worldMap?.destroy(); worldMap = undefined; skills?.destroy(); skills = undefined; characterInfo?.destroy(); characterInfo = undefined;
  muted = false; el('sound').textContent = english ? 'Sound: On' : '声音：开';  el('play').hidden = true; el('connection').textContent = english ? 'Not connected' : '尚未连接'; el('connection').classList.remove('online');
}
function castSkill(skillId: number, direction?: -1 | 0 | 1, vertical?: -1 | 0 | 1): string | undefined {
  const requestId = `skill-cast-${Date.now()}-${++skillRequestSequence}`;
  return connection?.send({ type: 'castSkill', requestId, skillId, direction, vertical }) ? requestId : undefined;
}

function returnToEntry(stage: 'characters' | 'channel') { leaveGame(true); void entry.returnTo(stage); }
el('logout').onclick = () => returnToEntry('characters');
// Leaving or reloading the page is not a logout.  Closing the socket here used
// to be the main reason a tab switch dropped the character: the server saw a
// clean close and removed the authoritative player.  The character now stays
// resident and a later load takes it over, so only clear local input state.
window.addEventListener('pagehide', () => { input?.reset(); });
// Report visibility so the server can start an away window from the moment the
// page is hidden instead of waiting for a transport timeout.  This is only a
// hint: the server keeps the authoritative away clock and decides residency.
// Becoming visible again retries immediately, but a reconnect is never treated
// as "recovered" — only a fresh authoritative snapshot reopens input.
document.addEventListener('visibilitychange', () => {
  connection?.send({ type: 'lifecycle', hidden: document.hidden, clientNowMs: Date.now() });
  if (!document.hidden && connectionState === 'offline') connection?.connect();
});
