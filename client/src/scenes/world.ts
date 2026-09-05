import Phaser from 'phaser';
import type { ServerMessage } from '../../../shared/protocol';
import type { Manifest } from '../assets/manifest';
import type { Background } from '../assets/manifest';
import { PlayerView } from '../features/player/view';
import { DropView, MonsterView, type DropSnapshot, type MonsterSnapshot } from '../features/mob/view';
import { consumeAction } from '../features/player/action-events';
type Snapshot = Extract<ServerMessage, { type: 'snapshot' }>;
type GameplaySnapshot = Snapshot & { monsters?: MonsterSnapshot[]; drops?: DropSnapshot[] };
type MapLayer = Manifest['map']['layers'][number];
type BackgroundView = { layer: MapLayer; images: Phaser.GameObjects.Image[]; motionX: number; motionY: number };
export class World extends Phaser.Scene {
  private players = new Map<string, PlayerView>();
  private monsters = new Map<string, MonsterView>();
  private drops = new Map<string, DropView>();
  private actions = new Map<string, { actionId: string; tick: number }>();
  private backgrounds: BackgroundView[] = [];
  private snapshot?: Snapshot;
  private receivedAt = 0;
  private loaded = false;
  private failed = false;
  private bgm?: Phaser.Sound.BaseSound;
  constructor(private manifest: Manifest, private status: (message: string, error?: boolean) => void) { super('world'); }
  preload() {
    const images = new Map<string, string>();
    for (const layer of this.manifest.map.layers) images.set(layer.url, layer.url);
    for (const frames of Object.values(this.manifest.avatar.actions)) for (const frame of frames) for (const part of frame.parts) images.set(part.url, part.url);
    for (const monster of Object.values(this.manifest.monsters ?? {})) for (const frames of Object.values(monster.actions)) for (const frame of frames) images.set(frame.url, frame.url);
    for (const frame of Object.values(this.manifest.items ?? {})) images.set(frame.url, frame.url);
    for (const [key, url] of images) this.load.image(key, url);
    if (this.manifest.map.bgm) this.load.audio('bgm', this.manifest.map.bgm);
    if (this.manifest.avatar.attackSound) this.load.audio('attack', this.manifest.avatar.attackSound);
    this.load.on('progress', (progress: number) => { if (!this.failed) this.status(`正在装载地图与角色 · ${Math.round(progress * 100)}%`); });
    this.load.on('loaderror', (file: Phaser.Loader.File) => { this.failed = true; this.status(`资源加载失败：${file.src} · ${this.manifest.contentVersion}`, true); });
  }
  create() {
    if (this.failed) return;
    this.loaded = true;
    const b = this.manifest.map.bounds;
    for (const layer of this.manifest.map.layers) {
      if (layer.background) this.createBackground(layer);
      else this.add.image(layer.x, layer.y, layer.url).setOrigin(0).setDepth(layer.depth).setFlipX(layer.flip ?? false).setAlpha((layer.alpha ?? 255) / 255);
    }
    this.cameras.main.setBounds(b.xMin, b.yMin, b.xMax - b.xMin, b.yMax - b.yMin);
    this.updateBackgrounds(0);
    if (this.manifest.map.bgm) { this.bgm = this.sound.add('bgm', { loop: true, volume: 0.25 }); this.bgm.play(); }
    this.status('地图已就绪，等待服务器快照…');
    this.events.once('shutdown', () => { this.clear(); this.bgm?.destroy(); });
  }
  receive(message: ServerMessage) {
    if (message.type === 'snapshot') {
      if (message.mapId !== this.manifest.map.id) { this.status(`地图资源不匹配：${message.mapId}`, true); return; }
      this.snapshot = message;
      this.receivedAt = performance.now();
      if (this.loaded && this.bgm && !this.bgm.isPlaying) this.bgm.play();
    }
    if (message.type === 'actionStarted' && this.loaded && this.manifest.avatar.attackSound && consumeAction(this.actions, message.playerId, message.actionId, message.serverTick)) this.sound.play('attack', { volume: 0.35 });
    if (message.type === 'pickupResult') this.status(`已拾取 ${message.itemId} × ${message.quantity}`);
  }
  clear() {
    this.snapshot = undefined;
    for (const player of this.players.values()) player.destroy();
    for (const monster of this.monsters.values()) monster.destroy();
    for (const drop of this.drops.values()) drop.destroy();
    this.players.clear(); this.monsters.clear(); this.drops.clear(); this.actions.clear(); this.sound?.stopAll();
  }
  setMuted(muted: boolean) { this.sound.mute = muted; }
  private createBackground(layer: MapLayer) {
    this.backgrounds.push({ layer, images: [], motionX: 0, motionY: 0 });
  }
  private updateBackgrounds(delta: number) {
    const camera = this.cameras.main;
    const width = camera.width;
    const height = camera.height;
    const centerX = width / 2;
    // The reference renderer uses hoffset = viewheight / 2 - VIEWYOFFSET (10),
    // then adds VIEWYOFFSET in its screen transform. Phaser's screen coordinates
    // already start at the visible top edge, so the two offsets cancel here.
    const centerY = height / 2;
    for (const view of this.backgrounds) {
      const { layer, images } = view;
      const bg = layer.background as Background;
      const source = this.textures.get(layer.url).getSourceImage();
      const originX = layer.origin?.x ?? source.width / 2;
      const originY = layer.origin?.y ?? source.height / 2;
      const tileWidth = bg.cx || source.width;
      const tileHeight = bg.cy || source.height;
      const repeatX = bg.type === 1 || bg.type === 3 || bg.type === 4 || bg.type === 6 || bg.type === 7;
      const repeatY = bg.type === 2 || bg.type === 3 || bg.type === 5 || bg.type === 6 || bg.type === 7;
      const mobileX = bg.type === 4 || bg.type === 6;
      const mobileY = bg.type === 5 || bg.type === 7;
      if (mobileX) view.motionX += bg.rx * delta / 128;
      if (mobileY) view.motionY += bg.ry * delta / 128;
      const offsetX = mobileX ? -camera.scrollX : centerX + bg.rx * (centerX + camera.scrollX) / 100;
      const offsetY = mobileY ? -camera.scrollY : centerY + bg.ry * (centerY + camera.scrollY) / 100;
      let x = bg.x + view.motionX + offsetX;
      let y = bg.y + view.motionY + offsetY;
      if (repeatX) x = ((x % tileWidth) + tileWidth) % tileWidth - tileWidth;
      if (repeatY) y = ((y % tileHeight) + tileHeight) % tileHeight - tileHeight;
      const columns = repeatX ? Math.ceil(width / tileWidth) + 2 : 1;
      const rows = repeatY ? Math.ceil(height / tileHeight) + 2 : 1;
      const needed = columns * rows;
      while (images.length < needed) images.push(this.add.image(0, 0, layer.url).setOrigin(0).setDepth(layer.depth).setFlipX(layer.flip ?? Boolean(bg.f)).setAlpha((layer.alpha ?? 255) / 255).setScrollFactor(0));
      let i = 0;
      for (let tx = 0; tx < columns; tx++) for (let ty = 0; ty < rows; ty++) images[i++].setVisible(true).setPosition(x + tx * tileWidth - originX, y + ty * tileHeight - originY);
      for (; i < images.length; i++) images[i].setVisible(false);
    }
  }
  update(_time?: number, delta = 8) {
    if (!this.loaded) return;
    this.updateBackgrounds(delta);
    if (!this.snapshot) return;
    const snapshot = this.snapshot;
    const ids = new Set(snapshot.players.map(player => player.id));
    for (const [id, view] of this.players) if (!ids.has(id)) { view.destroy(); this.players.delete(id); this.actions.delete(id); }
    for (const player of snapshot.players) {
      let view = this.players.get(player.id);
      if (!view) { view = new PlayerView(this, this.manifest, player.username, player.id === snapshot.selfId); this.players.set(player.id, view); }
      const elapsed = (snapshot.serverTick - player.actionStartedTick) * snapshot.tickMs + Math.min(performance.now() - this.receivedAt, 250);
      view.update(player, elapsed);
      if (player.id === snapshot.selfId) this.cameras.main.centerOn(Math.round(player.x), Math.round(player.y - 120));
    }
    this.updateGameplayEntities(snapshot as GameplaySnapshot);
  }

  nearestDropId(): string | null {
    const snapshot = this.snapshot as GameplaySnapshot | undefined;
    if (!snapshot) return null;
    const player = snapshot.players.find(candidate => candidate.id === snapshot.selfId);
    if (!player || !snapshot.drops?.length) return null;
    let nearest: DropSnapshot | undefined;
    let distance = Number.POSITIVE_INFINITY;
    for (const drop of snapshot.drops) {
      const dx = drop.x - player.x;
      const dy = drop.y - player.y;
      const next = dx * dx + dy * dy;
      if (next < distance) { distance = next; nearest = drop; }
    }
    return nearest?.id ?? null;
  }

  private updateGameplayEntities(snapshot: GameplaySnapshot) {
    const actorDepth = Math.max(...this.manifest.map.layers.map(layer => layer.depth)) + 1;
    const monsters = snapshot.monsters ?? [];
    const monsterIds = new Set(monsters.map(monster => monster.id));
    for (const [id, view] of this.monsters) {
      if (!monsterIds.has(id)) { view.destroy(); this.monsters.delete(id); }
    }
    for (const monster of monsters) {
      const asset = this.manifest.monsters?.[monster.templateId];
      if (!asset) continue;
      let view = this.monsters.get(monster.id);
      if (!view) { view = new MonsterView(this, asset, actorDepth); this.monsters.set(monster.id, view); }
      const elapsed = (snapshot.serverTick - monster.actionStartedTick) * snapshot.tickMs + Math.min(performance.now() - this.receivedAt, 250);
      view.update(monster, elapsed);
    }

    const drops = snapshot.drops ?? [];
    const dropIds = new Set(drops.map(drop => drop.id));
    for (const [id, view] of this.drops) {
      if (!dropIds.has(id)) { view.destroy(); this.drops.delete(id); }
    }
    for (const drop of drops) {
      const asset = this.manifest.items?.[drop.itemId];
      if (!asset) continue;
      let view = this.drops.get(drop.id);
      if (!view) { view = new DropView(this, asset, actorDepth + 1); this.drops.set(drop.id, view); }
      view.update(drop);
    }
  }
}
