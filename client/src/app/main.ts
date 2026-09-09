import Phaser from 'phaser';
import type { LoginResponse, NpcState, PlayerState, BossPracticeState } from '../../../shared/protocol';
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
import '../features/hud/style.css';
import { EntryView } from '../features/entry/view';

document.addEventListener('contextmenu', event => event.preventDefault(), { capture: true });

declare const __RELEASE_VERSION__: string;
declare const __RELEASE_TIME__: string;
const RELEASE_LABEL = `${__RELEASE_VERSION__} · ${__RELEASE_TIME__}`;
const english = uiLocale() === 'en';
document.documentElement.lang = english ? 'en' : 'zh-CN';
document.title = english ? 'MapleStory · Adventure Begins' : 'MapleStory · 冒险启程';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<header><div class="header-brand"><span class="release-badge" aria-label="${english ? 'Release version' : '发布版本'}">${RELEASE_LABEL}</span><a class="brand" href="/" aria-label="${english ? 'MapleStory home' : 'MapleStory 首页'}"><span class="leaf">✦</span> MapleStory <small>${english ? 'Adventure Begins' : '冒险启程'}</small></a></div><div class="header-tools"><span class="connection" id="connection">${english ? 'Not connected' : '尚未连接'}</span><label class="locale-picker" for="language"><span>${english ? 'Language' : '语言'}</span><select id="language" aria-label="${english ? 'Language' : '语言'}"><option value="zh"${english ? '' : ' selected'}>简体中文</option><option value="en"${english ? ' selected' : ''}>English</option></select></label></div></header>
<main><section id="welcome"></section>
<section id="play" hidden><div class="world-toolbar"><div><span class="eyebrow">${english ? 'Current Map' : '当前地图'}</span><strong id="map-name">${english ? 'Entering…' : '正在进入…'}</strong><span id="map-route" class="map-route" hidden></span></div><span id="population">0 ${english ? 'adventurers' : '位冒险者'}</span><div class="actions"><button id="sound" type="button">${english ? 'Sound: On' : '声音：开'}</button><button id="reconnect" type="button" hidden>${english ? 'Reconnect' : '重新连接'}</button><button id="logout" type="button">${english ? 'Log out' : '退出'}</button></div></div><div id="game-shell"><aside id="boss-practice" hidden aria-label="Boss practice"><strong id="boss-title"></strong><span id="boss-detail" role="status"></span><progress id="boss-hp" max="1" value="1" hidden aria-label="Boss HP"></progress><div><button id="boss-enter" type="button"></button><button id="boss-leave" type="button">${english ? 'Leave practice' : '退出练习'}</button></div></aside><div id="game" tabindex="0" aria-label="${english ? 'Game view. Arrow keys or A D to move, up/down to climb, Space to jump, down + Space to drop through, X or Ctrl to attack, Z to pick up.' : '游戏画面，方向键或 A D 移动，上下键攀爬，空格跳跃，↓ + 空格下跳，X 或 Ctrl 普攻，Z 拾取'}"></div><div id="chat" aria-label="${english ? 'Chat' : '聊天框'}"></div><div id="hud" aria-label="${english ? 'Character status bar' : '角色状态栏'}"></div><div id="ui-windows" aria-live="polite"></div><div id="menus" aria-label="${english ? 'Menu' : '菜单'}"></div><div id="notices" aria-live="assertive"></div></div></section>
<p id="message" role="status" aria-live="polite"></p></main><footer>MAPLESTORY <span>${english ? 'One world · independent adventurers' : '同一世界 · 独立冒险者'}</span><span>TMS 273.7</span></footer>
<dialog id="maple-news" aria-labelledby="maple-news-title"><div class="news-heading"><h2 id="maple-news-title">${english ? 'MapleStory News' : '枫之谷消息'}</h2><button id="news-close" type="button" autofocus aria-label="${english ? 'Close' : '关闭'}">×</button></div><div id="news-content"></div><details><summary>${english ? 'Recent messages (30)' : '最近消息（30条）'}</summary><ol id="news-log"></ol></details></dialog>
<button id="game-alert" type="button" hidden aria-live="polite"></button>`;
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
let layoutObserver: ResizeObserver | undefined;
let alertTimer: ReturnType<typeof setTimeout> | undefined;
const news = el<HTMLDialogElement>('maple-news');
const newsSections = [document.querySelector<HTMLElement>('#app > header')!, el('play').querySelector<HTMLElement>('.world-toolbar')!, el('message'), document.querySelector<HTMLElement>('#app > footer')!].map(node => {
  const marker = document.createComment('page information');
  node.before(marker);
  return { node, marker };
});
function showNews() {
  input?.reset();
  menus?.close();
  if (!news.open) news.showModal();
}
el('news-close').onclick = () => news.close();
news.addEventListener('close', () => { if (!el('play').hidden) focusGame(); });
el('game-alert').onclick = showNews;
function setPlayLayout(playing: boolean) {
  document.body.classList.toggle('game-mode', playing);
  for (const { node, marker } of newsSections) {
    if (playing) el('news-content').append(node);
    else marker.after(node);
  }
  if (!playing) {
    news.close();
    clearTimeout(alertTimer);
    el('game-alert').hidden = true;
    el('news-log').replaceChildren();
  }
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
}
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
let currentBossPractice: BossPracticeState | undefined;
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
  status(english ? 'Loading resources…' : '正在读取资源清单…');
  try {
    const manifest = await loadManifest();
    if (current !== generation) return;
    el('welcome').hidden = true;
    el('play').hidden = false;
    setPlayLayout(true);
    el('map-name').textContent = mapText(manifest.map.id, manifest.map.name);
    renderMapRoute(manifest);
    chat?.destroy();
    chat = new ChatView(el('chat'), manifest, message => status(message), {
      send: (requestId, text) => connection?.send({ type: 'chatSend', requestId, text }) ?? false,
      isBlocked: () => Boolean(news.open || menus?.isOpen() || npcDialogue?.isOpen() || deathNotice?.isOpen() || skills?.isOpen() || characterInfoIsOpen()),
      focusGame,
      selfId: () => selfState?.id,
    });
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
      showNews,
      showNews,
    );
    inventory?.destroy();
    inventory = new InventoryView(el('ui-windows'), manifest, message => status(message), request => connection?.send(request) ?? false);
    hud?.destroy();
    hud = new HudView(el('hud'), manifest, message => status(message), () => inventory?.toggle(), trigger => menus?.toggle('game', trigger), undefined, {
      castSkill: skillId => {
        if (!selfState || news.open || menus?.isOpen() || npcDialogue?.isOpen() || deathNotice?.isOpen() || skills?.isOpen() || characterInfoIsOpen()) return;
        return castSkill(skillId);
      },
      releaseSkill: requestId => { connection?.send({ type: 'releaseSkill', requestId }); },
    });
    world = new World(manifest, (message, error) => {
      status(message, error);
      if (error) { input?.setReady(false); connection?.close(); chat?.clear(); hud?.clear(); inventory?.clear(); skills?.clear(); characterInfo?.update(undefined); characterInfo?.close(); menus?.close(); deathNotice?.clear(); el('connection').textContent = english ? 'Resource load failed' : '资源加载失败'; el('reconnect').hidden = true; }
    }, request => {
      const requestId = `portal-${Date.now()}-${++portalSequence}`;
      if (connection?.send({ type: 'portal', requestId, portalName: request.portalName })) {
        status(english ? `Portal request: ${request.sourceMapId}/${request.portalName} → ${request.targetMapId}` : `传送请求：${request.sourceMapId}/${request.portalName} → ${request.targetMapId}`);
      }
    }, talkToNpc, questId => {
      if (news.open || npcDialogue?.isOpen() || deathNotice?.isOpen() || menus?.isOpen() || skills?.isOpen() || characterInfoIsOpen()) return;
      input?.reset();
      connection?.send({ type: 'questInteract', requestId: `quest-${Date.now()}-${++skillRequestSequence}`, questId });
    });
    game = new Phaser.Game({ type: Phaser.AUTO, parent: 'game', width: el('game').clientWidth, height: el('game').clientHeight, backgroundColor: '#b4dfe0', pixelArt: true, roundPixels: true, scene: [world], scale: { mode: Phaser.Scale.RESIZE }, input: { keyboard: false }, banner: false });
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
      if (message.type === 'snapshot') {
        el('population').textContent = `${message.players.length} ${english ? 'adventurers' : '位冒险者'}`;
        const currentMap = world?.getMap(message.mapId);
        if (currentMap && world?.mapId === message.mapId) {
          el('map-name').textContent = mapText(currentMap.id, currentMap.name);
          renderMapRoute({ ...manifest, map: currentMap as Manifest['map'] });
        }
        const self = message.players.find(player => player.id === message.selfId);
        selfState = self;
        renderBossPractice(message.bossPractice, self, message.monsters);
        hud?.update(self);
        inventory?.update(self, message.mapId.startsWith('practice:'));
        skills?.update(self);
        characterInfo?.update(self);
        deathNotice?.update(self);
        if (self) npcDialogue?.syncPlayer(self);
        if (announcedMapId !== message.mapId) {
          npcDialogue?.clear();
          skills?.releaseChannel();
          hud?.releaseChannel();
          input?.reset();
          announcedMapId = message.mapId;
          status(`${uiText('enteredMap', '已进入')} ${currentMap ? mapText(currentMap.id, currentMap.name) : mapText(manifest.map.id, manifest.map.name)} · ${session.username}`);
        }
      }
      else if (message.type === 'rejected') {
        if (message.code === 'drop_owned') chat?.appendSystem(protocolText(message.code, message.message), `pickup-rejected:${message.requestId}`);
        else if (['chat_rate_limited', 'invalid_chat_text', 'idempotency_conflict'].includes(message.code)) {
          // A rejected chat restores the draft and shows the server reason.
          chat?.failPending(message.requestId, protocolText(message.code, message.message));
        } else if (['boss_practice_cleared', 'boss_practice_left', 'boss_practice_failed'].includes(message.code)) {
          status(protocolText(message.code, message.message), message.code === 'boss_practice_failed');
        } else if (!deathNotice?.reject(message)) status(`${protocolText(message.code, message.message)} (${message.code})`, true);
      }
      else if (message.type === 'reviveResult') deathNotice?.receive(message);
    }, (state, reason) => {
      el('connection').textContent = state === 'online' ? `● ${english ? 'Connected' : '已连接'} · ${session.username}` : state === 'connecting' ? (english ? 'Connecting…' : '正在连接…') : (english ? 'Disconnected' : '连接已断开');
      el('connection').classList.toggle('online', state === 'online');
      el('reconnect').hidden = state !== 'offline';
      input?.setReady(state === 'online');
      if (state === 'online') focusGame();
      chat?.setAvailable(state === 'online');
      if (state !== 'online') { renderBossPractice(undefined, undefined); announcedMapId = undefined; selfState = undefined; world?.clear(); chat?.clear(); hud?.clear(); inventory?.clear(); skills?.clear(); characterInfo?.update(undefined); characterInfo?.close(); menus?.close(); deathNotice?.clear(); npcDialogue?.clear(); questLog?.clear(); status(reason || (english ? 'Connecting to map server…' : '正在连接地图服务器…'), state === 'offline'); }
    });
    input = new PlayerInput(message => connection?.send(message), {
      nearestDrop: () => world?.nearestDropId() ?? null,
      enterPortal: () => world?.enterPortal(),
      nearestNpc: () => world?.nearestNpc() ?? null,
      talkTo: talkToNpc,
      toggleQuestLog: () => questLog?.toggle() ?? false,
      toggleSkills,
      castSkill,
      playerState: () => selfState,
      isBlocked: () => Boolean(news.open || menus?.isOpen() || npcDialogue?.isOpen() || deathNotice?.isOpen() || skills?.isOpen() || characterInfoIsOpen()),
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
  layoutObserver?.disconnect(); layoutObserver = undefined;
  setPlayLayout(false);
  generation++; selfState = undefined; characterInfo?.update(undefined); input?.destroy(); input = undefined; connection?.close(); connection = undefined; game?.destroy(true); game = undefined; world = undefined; chat?.destroy(); chat = undefined; menus?.destroy(); menus = undefined; deathNotice?.destroy(); deathNotice = undefined; hud?.destroy(); hud = undefined; inventory?.destroy(); inventory = undefined; npcDialogue?.destroy(); npcDialogue = undefined; questLog?.destroy(); questLog = undefined; skills?.destroy(); skills = undefined; characterInfo?.destroy(); characterInfo = undefined;
  muted = false; el('sound').textContent = english ? 'Sound: On' : '声音：开';
  el('play').hidden = true; el('connection').textContent = english ? 'Not connected' : '尚未连接'; el('connection').classList.remove('online');
}
function castSkill(skillId: number, direction?: -1 | 0 | 1, vertical?: -1 | 0 | 1): string | undefined {
  const requestId = `skill-cast-${Date.now()}-${++skillRequestSequence}`;
  return connection?.send({ type: 'castSkill', requestId, skillId, direction, vertical }) ? requestId : undefined;
}

function returnToEntry(stage: 'characters' | 'channel') { leaveGame(); void entry.returnTo(stage); }
el('logout').onclick = () => returnToEntry('characters');
window.addEventListener('pagehide', () => { input?.destroy(); connection?.close(); });
