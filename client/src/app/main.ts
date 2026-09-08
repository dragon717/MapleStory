import Phaser from 'phaser';
import type { LoginResponse, NpcState, PlayerState } from '../../../shared/protocol';
import { Connection } from '../network/session';
import { PlayerInput } from '../features/player/input';
import { loadManifest, type Manifest } from '../assets/manifest';
import { mapText, protocolText, uiText, uiLocale } from './i18n';
import { HudView } from '../features/hud/view';
import { InventoryView } from '../features/inventory/view';
import { itemName } from '../features/inventory/names';
import { ChatView } from '../features/chat/view';
import { DeathNoticeView } from '../features/notice/death';
import { MenuView } from '../features/menu/view';
import { NpcDialogueView } from '../features/npc/dialogue';
import { QuestLogView } from '../features/quest/log';
import { SkillView } from '../features/skills/view';
import { CharacterInfoView } from '../features/character/view';
import { World } from '../scenes/world';
import './style.css';
import { EntryView } from '../features/entry/view';

declare const __RELEASE_VERSION__: string;
declare const __RELEASE_TIME__: string;
const RELEASE_LABEL = `${__RELEASE_VERSION__} · ${__RELEASE_TIME__}`;
const english = uiLocale() === 'en';
document.documentElement.lang = english ? 'en' : 'zh-CN';
document.title = english ? 'MapleStory · Adventure Begins' : 'MapleStory · 冒险启程';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<header><div class="header-brand"><span class="release-badge" aria-label="${english ? 'Release version' : '发布版本'}">${RELEASE_LABEL}</span><a class="brand" href="/" aria-label="${english ? 'MapleStory home' : 'MapleStory 首页'}"><span class="leaf">✦</span> MapleStory <small>${english ? 'Adventure Begins' : '冒险启程'}</small></a></div><div class="header-tools"><span class="connection" id="connection">${english ? 'Not connected' : '尚未连接'}</span><label class="locale-picker" for="language"><span>${english ? 'Language' : '语言'}</span><select id="language" aria-label="${english ? 'Language' : '语言'}"><option value="zh"${english ? '' : ' selected'}>简体中文</option><option value="en"${english ? ' selected' : ''}>English</option></select></label></div></header>
<main><section id="welcome"></section>
<section id="play" hidden><div class="world-toolbar"><div><span class="eyebrow">${english ? 'Current Map' : '当前地图'}</span><strong id="map-name">${english ? 'Entering…' : '正在进入…'}</strong><span id="map-route" class="map-route" hidden></span></div><span id="population">0 ${english ? 'adventurers' : '位冒险者'}</span><div class="actions"><button id="sound" type="button">${english ? 'Sound: On' : '声音：开'}</button><button id="reconnect" type="button" hidden>${english ? 'Reconnect' : '重新连接'}</button><button id="logout" type="button">${english ? 'Log out' : '退出'}</button></div></div><div id="game-shell"><div id="game" tabindex="0" aria-label="${english ? 'Game view. Arrow keys or A D to move, up/down to climb, Space to jump, down + Space to drop through, X or Ctrl to attack, Z to pick up.' : '游戏画面，方向键或 A D 移动，上下键攀爬，空格跳跃，↓ + 空格下跳，X 或 Ctrl 普攻，Z 拾取'}"></div><div id="chat" aria-label="${english ? 'Chat' : '聊天框'}"></div><div id="hud" aria-label="${english ? 'Character status bar' : '角色状态栏'}"></div><div id="ui-windows" aria-live="polite"></div><div id="menus" aria-label="${english ? 'Menu' : '菜单'}"></div><div id="notices" aria-live="assertive"></div></div></section>
<p id="message" role="status" aria-live="polite"></p></main><footer>MAPLESTORY <span>${english ? 'One world · independent adventurers' : '同一世界 · 独立冒险者'}</span><span>TMS 273.7</span></footer>`;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const language = el<HTMLSelectElement>('language');
language.onchange = () => {
  const next = language.value === 'en' ? 'en' : 'zh';
  try { localStorage.setItem('maple-ui-locale', next); } catch { /* Continue with the URL when storage is unavailable. */ }
  const url = new URL(window.location.href);
  url.searchParams.set('lang', next);
  window.location.assign(url.toString());
};
let connection: Connection | undefined;
let input: PlayerInput | undefined;
let world: World | undefined;
let hud: HudView | undefined;
let inventory: InventoryView | undefined;
let chat: ChatView | undefined;
let deathNotice: DeathNoticeView | undefined;
let menus: MenuView | undefined;
let npcDialogue: NpcDialogueView | undefined;
let questLog: QuestLogView | undefined;
let skills: SkillView | undefined;
let characterInfo: CharacterInfoView | undefined;
let game: Phaser.Game | undefined;
let muted = false;
let generation = 0;
let portalSequence = 0;
let skillRequestSequence = 0;
let selfState: PlayerState | undefined;
function status(message: string, error = false) { el('message').textContent = message; el('message').classList.toggle('error', error); }
function focusGame() { requestAnimationFrame(() => el('game').focus({ preventScroll: true })); }
function characterInfoIsOpen() {
  return Boolean((characterInfo as unknown as { isOpen?: () => boolean } | undefined)?.isOpen?.());
}
function talkToNpc(npc: NpcState) {
  skills?.close();
  characterInfo?.close();
  return npcDialogue?.startTalk(npc);
}
function toggleSkills() {
  if (npcDialogue?.isOpen() || deathNotice?.isOpen()) return false;
  input?.reset();
  characterInfo?.close();
  return skills?.toggle() ?? false;
}
function toggleCharacterInfo() {
  if (npcDialogue?.isOpen() || deathNotice?.isOpen()) return false;
  input?.reset();
  skills?.close();
  return characterInfo?.toggle() ?? false;
}
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
  status(english ? 'Loading resources…' : '正在读取资源清单…');
  try {
    const manifest = await loadManifest();
    if (current !== generation) return;
    el('welcome').hidden = true;
    el('play').hidden = false;
    el('map-name').textContent = mapText(manifest.map.id, manifest.map.name);
    renderMapRoute(manifest);
    chat?.destroy();
    chat = new ChatView(el('chat'), manifest, message => status(message));
    deathNotice?.destroy();
    deathNotice = new DeathNoticeView(el('notices'), manifest, requestId => connection?.send({ type: 'revive', requestId }) ?? false, message => status(message));
    npcDialogue?.destroy();
    npcDialogue = new NpcDialogueView(el('ui-windows'), manifest, message => status(message, true), request => connection?.send(request) ?? false);
    questLog?.destroy();
    questLog = new QuestLogView(el('ui-windows'), manifest);
    skills?.destroy();
    skills = new SkillView(el('ui-windows'), manifest, {
      send: message => connection?.send(message) ?? false,
      status,
    });
    characterInfo?.destroy();
    characterInfo = new CharacterInfoView(el('ui-windows'), manifest, message => status(message), request => connection?.send(request) ?? false);
    menus?.destroy();
    menus = new MenuView(
      el('menus'),
      manifest,
      message => status(message),
      () => inventory?.toggle(),
      () => { leaveGame(); entry.showLogin(); },
      () => inventory?.toggleEquipment(),
      () => questLog?.open(),
      toggleSkills,
      toggleCharacterInfo,
      () => returnToEntry('channel'),
      () => returnToEntry('characters'),
    );
    inventory?.destroy();
    inventory = new InventoryView(el('ui-windows'), manifest, message => status(message), request => connection?.send(request) ?? false);
    hud?.destroy();
    hud = new HudView(el('hud'), manifest, message => status(message), () => inventory?.toggle(), trigger => menus?.toggle('game', trigger), trigger => menus?.toggle('shortcut', trigger) || inventory?.toggle());
    world = new World(manifest, (message, error) => {
      status(message, error);
      if (error) { input?.setReady(false); connection?.close(); chat?.clear(); hud?.clear(); inventory?.clear(); skills?.clear(); characterInfo?.update(undefined); characterInfo?.close(); menus?.close(); deathNotice?.clear(); el('connection').textContent = english ? 'Resource load failed' : '资源加载失败'; el('reconnect').hidden = true; }
    }, request => {
      const requestId = `portal-${Date.now()}-${++portalSequence}`;
      if (connection?.send({ type: 'portal', requestId, portalName: request.portalName })) {
        status(english ? `Portal request: ${request.sourceMapId}/${request.portalName} → ${request.targetMapId}` : `传送请求：${request.sourceMapId}/${request.portalName} → ${request.targetMapId}`);
      }
    }, talkToNpc);
    game = new Phaser.Game({ type: Phaser.AUTO, parent: 'game', width: 960, height: 540, backgroundColor: '#b4dfe0', pixelArt: true, roundPixels: true, scene: [world], scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH }, input: { keyboard: false }, banner: false });
    let announcedMapId: string | undefined;
    connection = new Connection(session, message => {
      world?.receive(message);
      inventory?.receive(message);
      if (message.type === 'npcResult') {
        npcDialogue?.receive(message);
        if (message.openSkills) {
          npcDialogue?.clear();
          skills?.open();
          status('技能窗口已打开。');
        }
      }
      if (message.type === 'shopResult') {
        if (message.success) {
          chat?.appendSystem(`${uiLocale() === 'en' ? 'Bought' : '购买'} ${itemName(message.itemId)} × ${message.quantity}（${message.mesosSpent} ${uiText('meso')}）`, `shop:${message.requestId}`);
        } else {
          status(`${uiLocale() === 'en' ? 'Purchase failed' : '购买失败'} (${message.code})`, true);
        }
      }
      if (message.type === 'pickupResult') {
        chat?.appendSystem(`${uiLocale() === 'en' ? 'Obtained' : '获得'} ${itemName(message.itemId)} × ${message.quantity}`, `pickup:${message.requestId}`);
      }
      if (message.type === 'skillResult') {
        status(message.success
          ? (message.operation === 'learn' ? '技能已学习。' : '技能已施放。')
          : `技能操作失败：${message.code}`, !message.success);
      }
      if (message.type === 'abilityResult') {
        characterInfo?.receiveAbilityResult(message);
        status(message.success ? '属性点已分配。' : `属性点分配失败：${message.code}`, !message.success);
      }
      if (message.type === 'questList') {
        questLog?.setList(message.quests);
      }
      if (message.type === 'questUpdate') {
        questLog?.upsert({ questId: message.questId, name: message.name, status: message.status, summary: message.summary });
        const parts: string[] = [];
        if (message.reward.exp > 0) parts.push(`${message.reward.exp} EXP`);
        if (message.reward.mesos > 0) parts.push(`${message.reward.mesos} ${uiText('meso')}`);
        for (const item of message.reward.items) parts.push(`${itemName(item.itemId)} × ${item.quantity}`);
        const reward = parts.join('、');
        if (message.status === 'active') {
          chat?.appendSystem(`${uiLocale() === 'en' ? 'Quest accepted' : '接受任务'}：${message.name}`, `quest:${message.questId}:active`);
        } else {
          chat?.appendSystem(`${uiLocale() === 'en' ? 'Quest completed' : '任务完成'}：${message.name}${reward ? ` · ${uiLocale() === 'en' ? 'Reward' : '获得'} ${reward}` : ''}`, `quest:${message.questId}:completed`);
        }
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
        hud?.update(self);
        inventory?.update(self);
        skills?.update(self);
        characterInfo?.update(self);
        deathNotice?.update(self);
        if (self) npcDialogue?.syncPlayer(self);
        if (announcedMapId !== message.mapId) {
          npcDialogue?.clear();
          input?.reset();
          announcedMapId = message.mapId;
          status(`${uiText('enteredMap', '已进入')} ${currentMap ? mapText(currentMap.id, currentMap.name) : mapText(manifest.map.id, manifest.map.name)} · ${session.username}`);
        }
      }
      else if (message.type === 'rejected') {
        if (message.code === 'drop_owned') chat?.appendSystem(protocolText(message.code, message.message), `pickup-rejected:${message.requestId}`);
        if (!deathNotice?.reject(message)) status(`${protocolText(message.code, message.message)} (${message.code})`, true);
      }
      else if (message.type === 'reviveResult') deathNotice?.receive(message);
    }, (state, reason) => {
      el('connection').textContent = state === 'online' ? `● ${english ? 'Connected' : '已连接'} · ${session.username}` : state === 'connecting' ? (english ? 'Connecting…' : '正在连接…') : (english ? 'Disconnected' : '连接已断开');
      el('connection').classList.toggle('online', state === 'online');
      el('reconnect').hidden = state !== 'offline';
      input?.setReady(state === 'online');
      if (state === 'online') focusGame();
      chat?.setAvailable(state === 'online');
      if (state !== 'online') { announcedMapId = undefined; selfState = undefined; world?.clear(); chat?.clear(); hud?.clear(); inventory?.clear(); skills?.clear(); characterInfo?.update(undefined); characterInfo?.close(); menus?.close(); deathNotice?.clear(); npcDialogue?.clear(); questLog?.close(); status(reason || (english ? 'Connecting to map server…' : '正在连接地图服务器…'), state === 'offline'); }
    });
    input = new PlayerInput(message => connection?.send(message), {
      nearestDrop: () => world?.nearestDropId() ?? null,
      enterPortal: () => world?.enterPortal(),
      nearestNpc: () => world?.nearestNpc() ?? null,
      talkTo: talkToNpc,
      toggleQuestLog: () => questLog?.toggle() ?? false,
      toggleSkills,
      castSkill: (skillId, direction, vertical) => {
        connection?.send({ type: 'castSkill', requestId: `skill-cast-${Date.now()}-${++skillRequestSequence}`, skillId, direction, vertical });
      },
      playerState: () => selfState,
      isBlocked: () => Boolean(menus?.isOpen() || npcDialogue?.isOpen() || deathNotice?.isOpen() || skills?.isOpen() || characterInfoIsOpen()),
    });
    connection.connect();
    el('game').focus({ preventScroll: true });
  } catch (error) { leaveGame(); throw error; }
}
const entry = new EntryView(el('welcome'), enterGame);
el('game').onpointerdown = () => el('game').focus({ preventScroll: true });
el('reconnect').onclick = () => { connection?.connect(); el('game').focus({ preventScroll: true }); };
el('sound').onclick = () => { muted = !muted; world?.setMuted(muted); el('sound').textContent = english ? `Sound: ${muted ? 'Off' : 'On'}` : `声音：${muted ? '关' : '开'}`; el('game').focus({ preventScroll: true }); };
function leaveGame() {
  generation++; selfState = undefined; characterInfo?.update(undefined); input?.destroy(); input = undefined; connection?.close(); connection = undefined; game?.destroy(true); game = undefined; world = undefined; chat?.destroy(); chat = undefined; menus?.destroy(); menus = undefined; deathNotice?.destroy(); deathNotice = undefined; hud?.destroy(); hud = undefined; inventory?.destroy(); inventory = undefined; npcDialogue?.destroy(); npcDialogue = undefined; questLog?.destroy(); questLog = undefined; skills?.destroy(); skills = undefined; characterInfo?.destroy(); characterInfo = undefined;
  muted = false; el('sound').textContent = english ? 'Sound: On' : '声音：开';
  el('play').hidden = true; el('connection').textContent = english ? 'Not connected' : '尚未连接'; el('connection').classList.remove('online');
}
function returnToEntry(stage: 'characters' | 'channel') { leaveGame(); void entry.returnTo(stage); }
el('logout').onclick = () => returnToEntry('characters');
window.addEventListener('pagehide', () => { input?.destroy(); connection?.close(); });
