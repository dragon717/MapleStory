import Phaser from 'phaser';
import { randomDropId } from '../features/player/pickup';
import type { ServerMessage } from '../../../shared/protocol';
import type { Background, MapCatalogEntry, MapDefinition, MapLayer, MapPortal, Manifest } from '../assets/manifest';
import { PlayerView } from '../features/player/view';
import { DropView, MonsterView, type DropSnapshot, type MonsterSnapshot } from '../features/mob/view';
import { CombatView } from '../features/combat/view';
import { consumeAction } from '../features/player/action-events';
type Snapshot = Extract<ServerMessage, { type: 'snapshot' }>;
type GameplaySnapshot = Snapshot & { monsters?: MonsterSnapshot[]; drops?: DropSnapshot[] };
type BackgroundView = { layer: MapLayer; images: Phaser.GameObjects.Image[]; motionX: number; motionY: number };
export interface PortalRequest {
  sourceMapId: string; portalName: string; targetMapId: string; targetPortalName: string | null;
}
type PortalHandler = (request: PortalRequest) => void;
export class World extends Phaser.Scene {
  private players = new Map<string, PlayerView>();
  private monsters = new Map<string, MonsterView>();
  private drops = new Map<string, DropView>();
  private actions = new Map<string, { actionId: string; tick: number }>();
  private backgrounds: BackgroundView[] = [];
  private snapshot?: Snapshot;
  private pendingSnapshot?: Snapshot;
  private receivedAt = 0;
  private loaded = false;
  private failed = false;
  private bgm?: Phaser.Sound.BaseSound;
  private combat?: CombatView;
  private portalCooldownUntil = 0;
  private tutorialOverlays: Phaser.GameObjects.GameObject[] = [];
  constructor(private manifest: Manifest, private status: (message: string, error?: boolean) => void, private onPortal?: PortalHandler) { super('world'); }
  get mapId() { return this.manifest.map.id; }
  getMap(mapId = this.mapId): MapDefinition | MapCatalogEntry | undefined {
    if (mapId === this.mapId) return this.manifest.map;
    return this.manifest.mapCatalog?.maps.find(map => map.id === mapId);
  }
  switchMap(mapId: string, map?: MapDefinition, snapshot?: Snapshot): boolean {
    if (mapId === this.mapId && !map) return true;
    const next = map ?? this.manifest.mapCatalog?.maps.find(candidate => candidate.id === mapId);
    if (!next || !next.layers?.length || next.id !== mapId) {
      this.status(`地图资源待接入：${mapId}`, true);
      return false;
    }
    this.manifest = { ...this.manifest, map: next as MapDefinition };
    this.clear();
    this.pendingSnapshot = snapshot;
    this.backgrounds = [];
    this.loaded = false;
    this.failed = false;
    this.bgm?.destroy();
    this.bgm = undefined;
    this.scene.restart();
    return true;
  }
  findPortal(portalName: string): MapPortal | undefined {
    return (this.manifest.map.portals ?? this.manifest.mapCatalog?.maps.find(map => map.id === this.mapId)?.portals ?? [])
      .find(portal => portal.name === portalName);
  }
  requestPortal(portalName: string): PortalRequest | null {
    const portal = this.findPortal(portalName);
    if (!portal?.targetMapId) return null;
    const request = { sourceMapId: this.mapId, portalName: portal.name, targetMapId: portal.targetMapId, targetPortalName: portal.targetPortalName };
    this.onPortal?.(request);
    return request;
  }
  enterPortal() {
    const player = this.snapshot?.players.find(candidate => candidate.id === this.snapshot?.selfId);
    if (this.loaded && player) this.tryPortal(player, false);
  }
  private tryPortal(player: Snapshot['players'][number], touchOnly: boolean) {
    if (player.hp <= 0 || player.action === 'attack' || performance.now() < this.portalCooldownUntil) return;
    const portal = (this.manifest.map.portals ?? [])
      .find(candidate => candidate.targetMapId && candidate.name !== 'sp'
        && (touchOnly ? candidate.type === 3 : [1, 2, 7, 8, 10, 11].includes(candidate.type))
        && Math.abs(candidate.x - player.x) <= 36
        && Math.abs(candidate.y - player.y) <= 64);
    if (!portal || !this.requestPortal(portal.name)) return;
    this.portalCooldownUntil = performance.now() + 1000;
  }
  preload() {
    const images = new Map<string, string>();
    const maps = [this.manifest.map, ...(this.manifest.mapCatalog?.maps ?? [])];
    for (const map of maps) for (const layer of map.layers ?? []) images.set(layer.url, layer.url);
    const avatarActions = [this.manifest.avatar.actions, ...Object.values(this.manifest.avatar.equipmentLoadouts ?? {}).map(loadout => loadout.actions)];
    for (const actions of avatarActions) for (const frames of Object.values(actions)) for (const frame of frames) for (const part of frame.parts) images.set(part.url, part.url);
    for (const monster of Object.values(this.manifest.monsters ?? {})) for (const frames of Object.values(monster.actions)) for (const frame of frames) images.set(frame.url, frame.url);
    for (const frame of Object.values(this.manifest.items ?? {})) images.set(frame.url, frame.url);
    const afterimage = this.manifest.combat?.attack?.afterimage;
    for (const frame of afterimage?.frames ?? []) images.set(frame.url, frame.url);
    for (const set of [this.manifest.combat?.damageNumbers?.normal, this.manifest.combat?.damageNumbers?.critical]) {
      for (const frame of [...Object.values(set?.first ?? {}), ...Object.values(set?.rest ?? {})]) images.set(frame.url, frame.url);
    }
    for (const [key, url] of images) this.load.image(key, url);
    for (const map of maps) if (map.bgm) this.load.audio(`bgm-${map.id}`, map.bgm);
    if (this.manifest.avatar.attackSound) this.load.audio('attack', this.manifest.avatar.attackSound);
    if (this.manifest.combat?.hit?.sound) this.load.audio('combat-hit', this.manifest.combat.hit.sound);
    for (const monster of Object.values(this.manifest.monsters ?? {})) {
      if (monster.damageSound) this.load.audio(`mob-hit-${monster.templateId}`, monster.damageSound.url);
    }
    this.load.on('progress', (progress: number) => { if (!this.failed) this.status(`正在装载地图与角色 · ${Math.round(progress * 100)}%`); });
    this.load.on('loaderror', (file: Phaser.Loader.File) => { this.failed = true; this.status(`资源加载失败：${file.src} · ${this.manifest.contentVersion}`, true); });
  }
  create() {
    if (this.failed) return;
    this.loaded = true;
    if (this.pendingSnapshot) {
      this.snapshot = this.pendingSnapshot;
      this.pendingSnapshot = undefined;
      this.receivedAt = performance.now();
    }
    this.combat = new CombatView(this, this.manifest.combat, Math.max(...this.manifest.map.layers.map(layer => layer.depth)) + 3);
    const b = this.manifest.map.bounds;
    for (const layer of this.manifest.map.layers) {
      if (layer.background) this.createBackground(layer);
      else {
        const tutorial = layer.mapObject;
        if (tutorial?.oS === 'guide' && tutorial.l0 === 'tutorial' && tutorial.l1 === 'key' && ['1', '2'].includes(tutorial.l2 ?? '')) {
          this.createTutorialOverride(layer);
          continue;
        }
        this.add.image(layer.x, layer.y, layer.url).setOrigin(0).setDepth(layer.depth).setFlipX(layer.flip ?? false).setAlpha((layer.alpha ?? 255) / 255);
      }
    }
    this.cameras.main.setBounds(b.xMin, b.yMin, b.xMax - b.xMin, b.yMax - b.yMin);
    this.updateBackgrounds(0);
    if (this.manifest.map.bgm) { this.bgm = this.sound.add(`bgm-${this.mapId}`, { loop: true, volume: 0.25 }); this.bgm.play(); }
    this.status('地图已就绪，等待服务器快照…');
    this.events.once('shutdown', () => { this.clear(); this.bgm?.destroy(); });
  }
  receive(message: ServerMessage) {
    if (message.type === 'snapshot') {
      if (message.mapId !== this.mapId) {
        const map = this.getMap(message.mapId);
        if (map?.layers?.length && this.switchMap(message.mapId, map as MapDefinition, message)) return;
        this.status(map ? `地图资源待接入：${map.name} (${message.mapId})` : `地图资源不匹配：${message.mapId}`, true);
        return;
      }
      this.snapshot = message;
      if (!this.loaded) this.pendingSnapshot = message;
      this.receivedAt = performance.now();
      if (this.loaded && this.bgm && !this.bgm.isPlaying) this.bgm.play();
    }
    if (message.type === 'actionStarted' && this.loaded) {
      if (this.playerHasStarterSword(message.playerId)) {
        this.combat?.receiveActionStarted({ ...message, startedAtMs: performance.now() });
        if (this.manifest.avatar.attackSound && consumeAction(this.actions, message.playerId, message.actionId, message.serverTick)) this.sound.play('attack', { volume: 0.35 });
      }
    }
    if (message.type === 'damageEvent' && this.loaded) {
      const target = this.snapshot?.monsters.find(monster => monster.id === message.targetId);
      const anchor = target && this.monsters.get(target.id)?.hitAnchor({ ...target, x: message.x, y: message.y });
      this.combat?.receiveDamageEvent(anchor ? { ...message, ...anchor } : message, target ? `mob-hit-${target.templateId}` : undefined);
    }
    if (message.type === 'dropPickedUp' && message.mapId === this.mapId) {
      this.drops.get(message.dropId)?.pickUp(() => {
        const body = this.players.get(message.playerId)?.body;
        return body ? { x: body.x, y: body.y } : { x: message.x, y: message.y };
      });
      if (this.snapshot) this.snapshot = { ...this.snapshot, drops: this.snapshot.drops.filter(drop => drop.id !== message.dropId) };
    }
    if (message.type === 'pickupResult') this.status(`已拾取 ${message.itemId} × ${message.quantity}`);
    if (message.type === 'portalResult') {
      this.portalCooldownUntil = performance.now() + (message.success ? 1200 : 300);
      // A rejected gameplay request is recoverable; the error callback tears down the resource session.
      if (!message.success) this.status(`传送失败：${message.code}`);
    }
  }
  clear() {
    this.snapshot = undefined;
    for (const overlay of this.tutorialOverlays) overlay.destroy();
    this.tutorialOverlays = [];
    for (const player of this.players.values()) player.destroy();
    for (const monster of this.monsters.values()) monster.destroy();
    for (const drop of this.drops.values()) drop.destroy();
    this.players.clear(); this.monsters.clear(); this.drops.clear(); this.actions.clear(); this.sound?.stopAll();
    this.combat?.clear();
  }
  setMuted(muted: boolean) { this.sound.mute = muted; }
  private createTutorialOverride(layer: MapLayer) {
    const tutorial = layer.mapObject;
    if (tutorial?.oS !== 'guide' || tutorial.l0 !== 'tutorial' || tutorial.l1 !== 'key' || !['1', '2'].includes(tutorial.l2 ?? '')) return;
    const downJump = tutorial.l2 === '2';
    const key = (x: number, y: number, width: number, text: string) => {
      const cap = this.add.rectangle(x, y, width, 30, 0xffffff).setOrigin(0.5).setDepth(layer.depth + 1);
      cap.setStrokeStyle(1, 0x99aacc);
      const ink = this.add.text(x, y, text, {
        color: '#003399', fontFamily: 'Arial, sans-serif', fontSize: text === 'Space' ? '8px' : '13px', fontStyle: 'bold',
        stroke: '#ccddff', strokeThickness: 1,
      }).setOrigin(0.5).setDepth(layer.depth + 2);
      this.tutorialOverlays.push(cap, ink);
    };
    const label = (x: number, y: number, text: string, width: number) => {
      const bubble = this.add.rectangle(x, y, width, 18, 0xffffff).setOrigin(0.5).setDepth(layer.depth + 3);
      bubble.setStrokeStyle(1, 0x99aacc);
      const ink = this.add.text(x, y, text, {
        color: '#003399', fontFamily: 'Arial, sans-serif', fontSize: '8px', fontStyle: 'bold',
        stroke: '#ccddff', strokeThickness: 1,
      }).setOrigin(0.5).setDepth(layer.depth + 4);
      this.tutorialOverlays.push(bubble, ink);
    };
    if (downJump) {
      const left = layer.x + 32;
      const right = layer.x + 116;
      key(left, layer.y + 45, 32, '↓');
      const plus = this.add.text(layer.x + 74, layer.y + 45, '+', {
        color: '#003399', fontFamily: 'Arial, sans-serif', fontSize: '13px', fontStyle: 'bold',
      }).setOrigin(0.5).setDepth(layer.depth + 2);
      this.tutorialOverlays.push(plus);
      key(right, layer.y + 45, 56, 'Space');
      label(layer.x + 119, layer.y + 10, 'Downward Jump', 66);
    } else {
      key(layer.x + 32, layer.y + 45, 56, 'Space');
      label(layer.x + 50, layer.y + 10, 'Jump', 30);
    }
  }
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
    this.combat?.update();
    if (!this.snapshot) return;
    const snapshot = this.snapshot;
    const ids = new Set(snapshot.players.map(player => player.id));
    for (const [id, view] of this.players) if (!ids.has(id)) { view.destroy(); this.players.delete(id); this.actions.delete(id); }
    for (const player of snapshot.players) {
      let view = this.players.get(player.id);
      if (!view) { view = new PlayerView(this, this.manifest, player.username, player.id === snapshot.selfId); this.players.set(player.id, view); }
      const elapsed = (snapshot.serverTick - player.actionStartedTick) * snapshot.tickMs + Math.min(performance.now() - this.receivedAt, 250);
      view.update(player, elapsed);
      if (player.id === snapshot.selfId) {
        this.cameras.main.centerOn(Math.round(player.x), Math.round(player.y - 120));
        this.tryPortal(player, true);
      }
    }
    this.updateGameplayEntities(snapshot as GameplaySnapshot);
  }

  nearestDropId(): string | null {
    const snapshot = this.snapshot as GameplaySnapshot | undefined;
    if (!snapshot) return null;
    const player = snapshot.players.find(candidate => candidate.id === snapshot.selfId);
    if (!player || !snapshot.drops?.length) return null;
    return randomDropId(snapshot.drops, player);
  }

  private playerHasStarterSword(playerId: string) {
    const player = this.snapshot?.players.find(candidate => candidate.id === playerId);
    const equipped = player?.equipped;
    // Legacy snapshots and unsupported-only equipment use the original
    // starter appearance, which includes the source-backed sword.
    if (!player || equipped === undefined || (equipped.length > 0 && !equipped.some(item => ['1002067', '1040002', '1052095', '1302000'].includes(item.itemId)))) return true;
    return equipped.some(item => item.itemId === '1302000');
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
      if (view.pickingUp ? view.updatePickup() : !dropIds.has(id)) { view.destroy(); this.drops.delete(id); }
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
