import Phaser from 'phaser';
import { authenticate, Connection } from '../network/session';
import { PlayerInput } from '../features/player/input';
import { loadManifest } from '../assets/manifest';
import { HudView } from '../features/hud/view';
import { InventoryView } from '../features/inventory/view';
import { ChatView } from '../features/chat/view';
import { DeathNoticeView } from '../features/notice/death';
import { MenuView } from '../features/menu/view';
import { World } from '../scenes/world';
import './style.css';
document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<header><a class="brand" href="/" aria-label="MapleStory 首页"><span class="leaf">✦</span> MapleStory <small>冒险启程</small></a><span class="connection" id="connection">尚未连接</span></header>
<main><section id="welcome" class="welcome"><div class="intro"><p class="eyebrow">MAPLE WORLD · GMS 83</p><h1>熟悉的世界，<br>新的相遇。</h1><p>踏上同一片土地，<br>与你的伙伴一起开始冒险。</p><div class="edition">局域网冒险 · 单地图首版</div></div>
<form id="login" class="panel"><div class="panel-title">冒险者入口 <span>01</span></div><h2 id="form-title">欢迎回来</h2><p id="form-description">登录账号，进入冒险世界。</p><label for="username">冒险者名称</label><input id="username" name="username" autocomplete="username" required minlength="3" maxlength="32" pattern="(?:[A-Za-z0-9_]|-){3,32}" title="3–32 位英文字母、数字、下划线或连字符" placeholder="3–32 位字母、数字、_ 或 -"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required minlength="8" maxlength="128" placeholder="至少 8 个字符"><button class="primary" type="submit" id="submit">登录并进入 <span>→</span></button><button class="text-button" type="button" id="mode">初次来到这里？创建账号</button><p class="form-note">账号保存在这台游戏服务器。</p></form></section>
<section id="play" hidden><div class="world-toolbar"><div><span class="eyebrow">当前地图</span><strong id="map-name">正在进入…</strong></div><span id="population">0 位冒险者</span><div class="actions"><button id="sound" type="button">声音：开</button><button id="reconnect" type="button" hidden>重新连接</button><button id="logout" type="button">退出</button></div></div><div id="game-shell"><div id="game" tabindex="0" aria-label="游戏画面，方向键或 A D 移动，上下键攀爬，空格跳跃，X 或 Ctrl 普攻"></div><div id="chat" aria-label="聊天框"></div><div id="hud" aria-label="角色状态栏"></div><div id="ui-windows" aria-live="polite"></div><div id="menus" aria-label="菜单"></div><div id="notices" aria-live="assertive"></div></div><div class="controls"><span><kbd>←</kbd><kbd>→</kbd> / <kbd>A</kbd><kbd>D</kbd> 移动</span><span><kbd>↑</kbd><kbd>↓</kbd> 攀爬</span><span><kbd>Space</kbd> 跳跃</span><span><kbd>X</kbd> / <kbd>Ctrl</kbd> 普攻</span><span><kbd>Z</kbd> 拾取</span><span class="hint">点击画面开始操作</span></div></section>
<p id="message" role="status" aria-live="polite"></p></main><footer>MAPLESTORY <span>同一世界 · 独立冒险者</span><span>GMS 83</span></footer>`;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let register = false;
let connection: Connection | undefined;
let input: PlayerInput | undefined;
let world: World | undefined;
let hud: HudView | undefined;
let inventory: InventoryView | undefined;
let chat: ChatView | undefined;
let deathNotice: DeathNoticeView | undefined;
let menus: MenuView | undefined;
let game: Phaser.Game | undefined;
let muted = false;
let generation = 0;
function status(message: string, error = false) { el('message').textContent = message; el('message').classList.toggle('error', error); }
function updateMode() {
  el('form-title').textContent = register ? '创建冒险者' : '欢迎回来';
  el('form-description').textContent = register ? '创建独立账号，注册后直接进入。' : '登录账号，进入冒险世界。';
  el('submit').textContent = register ? '创建账号并进入 →' : '登录并进入 →';
  el('mode').textContent = register ? '已有账号？返回登录' : '初次来到这里？创建账号';
  el<HTMLInputElement>('password').autocomplete = register ? 'new-password' : 'current-password';
}
el('mode').onclick = () => { register = !register; updateMode(); };
el('login').onsubmit = async event => {
  event.preventDefault();
  const current = ++generation;
  el<HTMLButtonElement>('submit').disabled = true;
  status(register ? '正在创建账号…' : '正在登录…');
  try {
    const session = await authenticate(el<HTMLInputElement>('username').value.trim(), el<HTMLInputElement>('password').value, register);
    el<HTMLInputElement>('password').value = '';
    register = false; updateMode();
    status('认证成功，正在读取资源清单…');
    const manifest = await loadManifest();
    if (current !== generation) return;
    el('welcome').hidden = true;
    el('play').hidden = false;
    el('map-name').textContent = manifest.map.name;
    chat?.destroy();
    chat = new ChatView(el('chat'), manifest, message => status(message));
    deathNotice?.destroy();
    deathNotice = new DeathNoticeView(el('notices'), manifest, requestId => connection?.send({ type: 'revive', requestId }) ?? false, message => status(message));
    menus?.destroy();
    menus = new MenuView(el('menus'), manifest, message => status(message), () => inventory?.toggle(), () => el('logout').click());
    inventory?.destroy();
    inventory = new InventoryView(el('ui-windows'), manifest, message => status(message));
    hud?.destroy();
    hud = new HudView(el('hud'), manifest, message => status(message), () => inventory?.toggle(), () => menus?.toggle('game'), () => menus?.toggle('shortcut') || inventory?.toggle());
    world = new World(manifest, (message, error) => {
      status(message, error);
      if (error) { input?.setReady(false); connection?.close(); chat?.clear(); hud?.clear(); inventory?.clear(); menus?.close(); deathNotice?.clear(); el('connection').textContent = '资源加载失败'; el('reconnect').hidden = true; }
    });
    game = new Phaser.Game({ type: Phaser.AUTO, parent: 'game', width: 960, height: 540, backgroundColor: '#b4dfe0', pixelArt: true, roundPixels: true, scene: [world], scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH }, input: { keyboard: false }, banner: false });
    connection = new Connection(session, message => {
      world?.receive(message);
      if (message.type === 'snapshot') {
        el('population').textContent = `${message.players.length} 位冒险者`;
        const self = message.players.find(player => player.id === message.selfId);
        hud?.update(self);
        inventory?.update(self);
        deathNotice?.update(self);
        status(`已进入 ${manifest.map.name} · ${session.username}`);
      }
      else if (message.type === 'rejected') {
        if (!deathNotice?.reject(message)) status(`${message.message} (${message.code})`, true);
      }
      else if (message.type === 'reviveResult') deathNotice?.receive(message);
    }, (state, reason) => {
      el('connection').textContent = state === 'online' ? `● 已连接 · ${session.username}` : state === 'connecting' ? '正在连接…' : '连接已断开';
      el('connection').classList.toggle('online', state === 'online');
      el('reconnect').hidden = state !== 'offline';
      input?.setReady(state === 'online');
      chat?.setAvailable(state === 'online');
      if (state !== 'online') { world?.clear(); chat?.clear(); hud?.clear(); inventory?.clear(); menus?.close(); deathNotice?.clear(); status(reason || '正在连接地图服务器…', state === 'offline'); }
    });
    input = new PlayerInput(message => connection?.send(message), () => world?.nearestDropId() ?? null);
    connection.connect();
    el('game').focus({ preventScroll: true });
  } catch (error) { status(error instanceof Error ? error.message : '进入失败，请重试。', true); }
  finally { el<HTMLButtonElement>('submit').disabled = false; }
};
el('game').onpointerdown = () => el('game').focus({ preventScroll: true });
el('reconnect').onclick = () => { connection?.connect(); el('game').focus({ preventScroll: true }); };
el('sound').onclick = () => { muted = !muted; world?.setMuted(muted); el('sound').textContent = `声音：${muted ? '关' : '开'}`; el('game').focus({ preventScroll: true }); };
el('logout').onclick = () => {
  generation++; input?.destroy(); input = undefined; connection?.close(); connection = undefined; game?.destroy(true); game = undefined; world = undefined; chat?.destroy(); chat = undefined; menus?.destroy(); menus = undefined; deathNotice?.destroy(); deathNotice = undefined; hud?.destroy(); hud = undefined; inventory?.destroy(); inventory = undefined;
  muted = false; el('sound').textContent = '声音：开';
  el('play').hidden = true; el('welcome').hidden = false; el('connection').textContent = '尚未连接'; el('connection').classList.remove('online'); status('已退出。'); el('username').focus();
};
window.addEventListener('pagehide', () => { input?.destroy(); connection?.close(); });
