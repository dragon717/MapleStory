import Phaser from 'phaser';
import type { LoginResponse, NpcState, PlayerState, BossPracticeState } from '../../../shared/protocol';
import { Connection } from '../network/session';
import { PlayerInput } from '../features/player/input';
import { StorageView } from '../features/world/storage-view';
import { PartyView } from '../features/world/party-view';
import { MiniMapView } from '../features/world/minimap-view';
import '../features/world/minimap.css';
import { WorldMapView } from '../features/world/worldmap-view';
import '../features/world/worldmap.css';
import { FriendView } from '../features/world/friend-view';
import { EmoticonView } from '../features/chat/emoticon-view';
import { CashShopView } from '../features/cashshop/view';
import '../features/cashshop/style.css';
import { loadManifest, type Manifest } from '../assets/manifest';
import { mapText, protocolText, uiText, uiLocale } from './i18n';
import { HudView } from '../features/hud/view';
import { InventoryView } from '../features/inventory/view';
import { itemName } from '../features/inventory/names';
import { ChatView } from '../features/chat/view';
import { DeathNoticeView } from '../features/notice/death';
import { AwayNoticeView } from '../features/notice/away';
import { MenuView } from '../features/menu/view';
import { ActivitiesView } from '../features/windbell/activities';
import { NpcDialogueView } from '../features/npc/dialogue';
import { QuestLogView } from '../features/quest/log';
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
import { installEscapeRouter } from './ui-router.ts';
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
let skills: SkillView | undefined;
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
function focusGame() { requestAnimationFrame(() => el('game').focus({ preventScroll: true })); }
function characterInfoIsOpen() {
  return Boolean((characterInfo as unknown as { isOpen?: () => boolean } | undefined)?.isOpen?.());
}
/**
 * Panels that own their own Escape handling.  While any of them is showing the
 * router leaves the key alone so that panel closes itself; when none is open,
 * Escape raises the menu bar (`docs/technical/UI_WINDOW_SYSTEM.md` R5).
 */
function escapeBlocked() {
  return Boolean(
    activities?.isOpen() ||
    news.open
    || menus?.isOpen()
    || npcDialogue?.isOpen()
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
    || worldMap?.isOpen()
    || Boolean(miniMap?.npcListShown()),
  );
}
function talkToNpc(npc: NpcState) {
  if (npc.templateId.startsWith('windbell-')) { input?.reset(); activities?.talk(); return; }
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
      isBlocked: () => Boolean(activities?.isOpen() || news.open || menus?.isOpen() || npcDialogue?.isOpen() || storage?.isOpen() || deathNotice?.isOpen() || skills?.isOpen() || characterInfoIsOpen() || petPanel?.isOpen() || party?.isOpen() || friends?.isOpen() || emoticons?.isOpen()),
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
    npcDialogue?.destroy();
    npcDialogue = new NpcDialogueView(el('ui-windows'), manifest, message => status(message, true), request => connection?.send(request) ?? false);
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
    cashShop = new CashShopView(el('ui-windows'), manifest, message => status(message, true), request => connection?.send(request) ?? false);
    miniMap?.destroy();
    miniMap = new MiniMapView(el('minimap'), manifest);
    miniMap.mount();
    // The WORLD button opens the authored world map: the root page overview
    // first, with the region the character stands in marked on it.
    worldMap?.destroy();
    worldMap = new WorldMapView(el('ui-windows'), manifest);
    worldMap.onStatus = message => status(message, true);
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
    miniMap.onWorldMap = () => worldMap?.open(world?.mapId);
    questLog?.destroy();
    questLog = new QuestLogView(el('ui-windows'), manifest);
    skills?.destroy();
    skills = new SkillView(el('ui-windows'), manifest, {
      send: message => connection?.send(message) ?? false,
      status,
    });
    characterInfo?.destroy();
    characterInfo = new CharacterInfoView(el('ui-windows'), manifest, message => status(message), request => connection?.send(request) ?? false);
    petPanel?.destroy();
    petPanel = new PetPanel(el('ui-windows'), manifest, message => status(message), request => connection?.send(request) ?? false);
    menus?.destroy();
    activities?.destroy();
    activities = new ActivitiesView(el('ui-windows'), (action, instanceId) => {
      input?.reset();
      if (!connection?.send({ type: 'windbell', action, instanceId, requestId: `windbell-${crypto.randomUUID()}` })) status('请重新连接后再进入活动。', true);
    }, focusGame);
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
      () => worldMap?.open(world?.mapId),
      // The 現金商店 operation opens the cash-shop window (source CashShop.img).
      () => { input?.reset(); cashShop?.open(); },
    );
    // The menu bar is the escape hatch: with nothing else open, Escape raises
    // it (and a second Escape lowers it).  The menu keeps its own close
    // listener, so the router only ever handles the "nothing is open" case.
    escapeRouterDispose?.();
    escapeRouterDispose = installEscapeRouter({
      blocked: escapeBlocked,
      menuOpen: () => Boolean(menus?.isOpen()),
      toggleMenu: () => { menus?.toggle('game'); },
    });
    inventory?.destroy();
    inventory = new InventoryView(el('ui-windows'), manifest, message => status(message), request => connection?.send(request) ?? false);
    hud?.destroy();
    hud = new HudView(el('hud'), manifest, message => status(message), () => inventory?.toggle(), trigger => menus?.toggle('game', trigger), undefined, {
      openActivities: () => { input?.reset(); activities?.show(); },
      openPets: () => {
        input?.reset();
        skills?.close();
        characterInfo?.close();
        petPanel?.toggle();
      },
      castSkill: skillId => {
        if (!selfState || news.open || menus?.isOpen() || npcDialogue?.isOpen() || storage?.isOpen() || deathNotice?.isOpen() || skills?.isOpen() || characterInfoIsOpen() || petPanel?.isOpen() || party?.isOpen() || friends?.isOpen() || emoticons?.isOpen()) return;
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
      if (error) { input?.setReady(false); connection?.close(); chat?.clear(); hud?.clear(); inventory?.clear(); skills?.clear(); characterInfo?.update(undefined); characterInfo?.close(); petPanel?.clear(); petPanel?.close(); menus?.close(); party?.close(); friends?.close(); emoticons?.close(); deathNotice?.clear(); awayNotice?.clear(); loadingOverlay?.hide(); loadingOverlay = undefined; el('connection').textContent = english ? 'Resource load failed' : '资源加载失败'; el('reconnect').hidden = true; }
    }, request => {
      const requestId = `portal-${Date.now()}-${++portalSequence}`;
      if (connection?.send({ type: 'portal', requestId, portalName: request.portalName })) {
        status(english ? `Portal request: ${request.sourceMapId}/${request.portalName} → ${request.targetMapId}` : `传送请求：${request.sourceMapId}/${request.portalName} → ${request.targetMapId}`);
      }
    }, talkToNpc, questId => {
      if (news.open || npcDialogue?.isOpen() || storage?.isOpen() || deathNotice?.isOpen() || menus?.isOpen() || skills?.isOpen() || characterInfoIsOpen() || petPanel?.isOpen() || party?.isOpen() || friends?.isOpen() || emoticons?.isOpen()) return;
      input?.reset();
      connection?.send({ type: 'questInteract', requestId: `quest-${Date.now()}-${++skillRequestSequence}`, questId });
    }, reactorId => {
      if (news.open || npcDialogue?.isOpen() || storage?.isOpen() || deathNotice?.isOpen() || menus?.isOpen() || skills?.isOpen() || characterInfoIsOpen() || petPanel?.isOpen() || party?.isOpen() || friends?.isOpen() || emoticons?.isOpen()) return;
      input?.reset();
      connection?.send({ type: 'reactorHit', requestId: `reactor-${Date.now()}-${++skillRequestSequence}`, reactorId });
    });
    game = new Phaser.Game({ type: Phaser.AUTO, parent: 'game', width: el('game').clientWidth, height: el('game').clientHeight, backgroundColor: '#b4dfe0', transparent: true, pixelArt: true, roundPixels: true, scene: [world], scale: { mode: Phaser.Scale.RESIZE }, input: { keyboard: false }, banner: false });
    layoutObserver = new ResizeObserver(() => {
      const { clientWidth: width, clientHeight: height } = el('game');
      if (width && height && game && (game.scale.width !== width || game.scale.height !== height)) game.scale.resize(width, height);
      el('game-shell').style.setProperty('--hud-height', `${el('hud').getBoundingClientRect().height}px`);
    });
    layoutObserver.observe(el('game'));
    layoutObserver.observe(el('hud'));
    let announcedMapId: string | undefined;
    connection = new Connection(session, message => {
      world?.receive(message);
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
          status(protocolText(message.code, `${uiLocale() === 'en' ? 'Storage action failed' : '仓库操作失败'}（${message.code}）`), true);
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
          status(protocolText(message.code, `${uiLocale() === 'en' ? 'Mesos transfer failed' : '枫币搬运失败'}（${message.code}）`), true);
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
          status(protocolText(message.code, `${uiLocale() === 'en' ? 'Party action failed' : '队伍操作失败'}（${message.code}）`), true);
        }
      }
      if (message.type === 'partyNotice') {
        party?.receiveNotice(message.code, message.playerName);
        status(protocolText(message.code, message.code), message.code !== 'party_declined');
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
          status(protocolText(message.code, `${uiLocale() === 'en' ? 'Friend action failed' : '好友操作失败'}（${message.code}）`), true);
        }
      }
      if (message.type === 'shopResult') {
        if (message.success) {
          chat?.appendSystem(`${uiLocale() === 'en' ? 'Bought' : '购买'} ${itemName(message.itemId)} × ${message.quantity}（${message.mesosSpent} ${uiText('meso')}）`, `shop:${message.requestId}`);
        } else {
          status(`${uiLocale() === 'en' ? 'Purchase failed' : '购买失败'} (${message.code})`, true);
        }
      }
      if (message.type === 'shopSold') {
        if (message.success) {
          chat?.appendSystem(`${uiLocale() === 'en' ? 'Sold' : '出售'} ${itemName(message.itemId)} × ${message.quantity}（+${message.mesosGained} ${uiText('meso')}）`, `shop:${message.requestId}`);
        } else {
          status(protocolText(message.code, `${uiLocale() === 'en' ? 'Sale failed' : '出售失败'}（${message.code}）`), true);
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
      if (message.type === 'shopRebought') {
        if (message.success) {
          chat?.appendSystem(`${uiLocale() === 'en' ? 'Bought back' : '赎回'} ${itemName(message.itemId)} × ${message.quantity}（-${message.mesosSpent} ${uiText('meso')}）`, `shop:${message.requestId}`);
        } else {
          status(protocolText(message.code, `${uiLocale() === 'en' ? 'Buy-back failed' : '赎回失败'}（${message.code}）`), true);
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
          : reason[message.code] ?? `技能操作失败：${message.code}`, !message.success);
      }
      if (message.type === 'abilityResult') {
        characterInfo?.receiveAbilityResult(message);
        status(message.success ? '属性点已分配。' : `属性点分配失败：${message.code}`, !message.success);
      }
      if (message.type === 'questList') {
        questLog?.setList(message.quests);
      }
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
        else status(`${english ? 'World map jump failed' : '世界地图跳转失败'}：${message.code}`, true);
      }
      if (message.type === 'snapshot') {
        el('population').textContent = `${message.players.length} ${english ? 'adventurers' : '位冒险者'}`;
        const currentMap = world?.getMap(message.mapId);
        if (currentMap && world?.mapId === message.mapId) {
          el('map-name').textContent = mapText(currentMap.id, currentMap.name);
          renderMapRoute({ ...manifest, map: currentMap as Manifest['map'] });
        }
        const self = message.players.find(player => player.id === message.selfId);
        selfState = self;
        activities?.update(message.windbell, self, message.npcs);
        renderBossPractice(message.bossPractice, self, message.monsters);
        // The minimap is a pure view: the server's map id, its own player list
        // and the map's authored portal list are everything it is allowed to
        // draw, and the roster (already authoritative) only tints the dots.
        miniMap?.update({
          mapId: message.mapId,
          self,
          players: message.players,
          npcs: message.npcs,
          portals: currentMap?.portals,
          partyIds: party?.memberIds(),
        });
        // The world map's `M` hotkey and menu entry open on the region the
        // character stands in, so the view tracks the authoritative map id.
        worldMap?.setMap(message.mapId);
        hud?.update(self);
        inventory?.update(self, message.mapId.startsWith('practice:'));
        skills?.update(self);
        characterInfo?.update(self);
        petPanel?.update(self);
        deathNotice?.update(self);
        awayNotice?.update(self);
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
          status(`${uiText('enteredMap', '已进入')} ${currentMap ? mapText(currentMap.id, currentMap.name) : mapText(manifest.map.id, manifest.map.name)} · ${session.username}`);
          revealGame();
        }
      }
      else       if (message.type === 'rejected') {
        if (message.code === 'drop_owned') chat?.appendSystem(protocolText(message.code, message.message), `pickup-rejected:${message.requestId}`);
        else if (['reactor_unknown', 'reactor_busy', 'reactor_spent', 'reactor_out_of_range'].includes(message.code)) {
          // A reactor rejection is a normal gameplay outcome, not an error:
          // the prop may already have been taken by someone else on the map.
          if (message.code === 'reactor_out_of_range') status(english ? 'Move closer to interact with that.' : '再靠近一些才能互动。');
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
        } else if (!deathNotice?.reject(message)) status(`${protocolText(message.code, message.message)} (${message.code})`, true);
      }
      else if (message.type === 'reviveResult') deathNotice?.receive(message);
    }, (state, reason) => {
      connectionState = state;
      el('connection').textContent = state === 'online' ? `● ${english ? 'Connected' : '已连接'} · ${session.username}` : state === 'connecting' ? (english ? 'Connecting…' : '正在连接…') : (english ? 'Disconnected' : '连接已断开');
      el('connection').classList.toggle('online', state === 'online');
      el('reconnect').hidden = state !== 'offline';
      input?.setReady(state === 'online');
      if (state === 'online') focusGame();
      chat?.setAvailable(state === 'online');
      if (state !== 'online') { renderBossPractice(undefined, undefined); announcedMapId = undefined; selfState = undefined; world?.clear(); chat?.clear(); hud?.clear(); inventory?.clear(); skills?.clear(); characterInfo?.update(undefined); characterInfo?.close(); petPanel?.clear(); petPanel?.close(); menus?.close(); party?.close(); friends?.close(); emoticons?.close(); miniMap?.clear(); deathNotice?.clear(); awayNotice?.clear(); npcDialogue?.clear(); storage?.close(); questLog?.clear(); party?.close(); friends?.close(); status(reason || (english ? 'Connecting to map server…' : '正在连接地图服务器…'), state === 'offline'); }
    });
    input = new PlayerInput(message => connection?.send(message), {
      nearestDrop: () => world?.nearestDropId() ?? null,
      enterPortal: () => world?.enterPortal(),
      nearestNpc: () => world?.nearestNpc() ?? null,
      talkTo: talkToNpc,
      nearestReactor: () => world?.nearestReactor()?.id ?? null,
      hitReactor: reactorId => {
        if (!connection?.send({ type: 'reactorHit', requestId: `reactor-${Date.now()}-${++skillRequestSequence}`, reactorId })) {
          status(english ? 'Reconnect before interacting.' : '请重新连接后再操作。', true);
        }
      },
      toggleQuestLog: () => questLog?.toggle() ?? false,
      toggleSkills,
      castSkill,
      playerState: () => selfState,
      isBlocked: () => Boolean(activities?.isOpen() || news.open || menus?.isOpen() || npcDialogue?.isOpen() || storage?.isOpen() || deathNotice?.isOpen() || skills?.isOpen() || characterInfoIsOpen() || petPanel?.isOpen() || party?.isOpen() || friends?.isOpen() || emoticons?.isOpen()),
    });
    connection.connect();
    el('game').focus({ preventScroll: true });
  } catch (error) { leaveGame(); throw error; }
}
const entry = new EntryView(el('welcome'), enterGame);
el('game').onpointerdown = () => el('game').focus({ preventScroll: true });
el('reconnect').onclick = () => { connection?.connect(); el('game').focus({ preventScroll: true }); };
el('sound').onclick = () => { muted = !muted; world?.setMuted(muted); el('sound').textContent = english ? `Sound: ${muted ? 'Off' : 'On'}` : `声音：${muted ? '关' : '开'}`; el('game').focus({ preventScroll: true }); };
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
  generation++; selfState = undefined; characterInfo?.update(undefined); petPanel?.destroy(); petPanel = undefined; input?.destroy(); input = undefined; connection?.close(); connection = undefined; game?.destroy(true); game = undefined; world = undefined; chat?.destroy(); chat = undefined; menus?.destroy(); menus = undefined; deathNotice?.destroy(); deathNotice = undefined; awayNotice?.destroy(); awayNotice = undefined; hud?.destroy(); hud = undefined; inventory?.destroy(); inventory = undefined; npcDialogue?.destroy(); npcDialogue = undefined; questLog?.destroy(); questLog = undefined; party?.destroy(); party = undefined; friends?.destroy(); friends = undefined; emoticons?.destroy(); emoticons = undefined; miniMap?.destroy(); miniMap = undefined; worldMap?.destroy(); worldMap = undefined; skills?.destroy(); skills = undefined; characterInfo?.destroy(); characterInfo = undefined;
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
