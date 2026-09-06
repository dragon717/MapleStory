import Phaser from 'phaser';
import { randomDropId } from '../features/player/pickup';
import type { NpcState, ServerMessage } from '../../../shared/protocol';
import type { Background, MapCatalogEntry, MapDefinition, MapLayer, MapPortal, Manifest } from '../assets/manifest';
import { PlayerView } from '../features/player/view';
import { DropView, MonsterView, type DropSnapshot, type MonsterSnapshot } from '../features/mob/view';
import { NpcView, type NpcSnapshot } from '../features/npc/view';
import { PortalView } from '../features/world/portal-view';
import { CombatView } from '../features/combat/view';
import { consumeAction } from '../features/player/action-events';
type Snapshot = Extract<ServerMessage, { type: 'snapshot' }>;
type GameplaySnapshot = Snapshot & { monsters?: MonsterSnapshot[]; drops?: DropSnapshot[]; npcs?: NpcSnapshot[] };
type BackgroundView = { layer: MapLayer; images: Phaser.GameObjects.Image[]; motionX: number; motionY: number };
export interface PortalRequest {
  sourceMapId: string; portalName: string; targetMapId: string; targetPortalName: string | null;
}
type PortalHandler = (request: PortalRequest) => void;
export class World extends Phaser.Scene {
  private players = new Map<string, PlayerView>();
  private monsters = new Map<string, MonsterView>();
  private npcs = new Map<string, NpcView>();
  private drops = new Map<string, DropView>();
  private portals = new Map<string, PortalView>();
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
  constructor(
    private manifest: Manifest,
    private status: (message: string, error?: boolean) => void,
    private onPortal?: PortalHandler,
    private onNpcTalk?: (npc: NpcState) => void,
  ) { super('world'); }
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
  // Thresholds mirror the server-side guard in `world.rs::handle_portal`
  // (48 × 64).  The old 36 px ceiling was too tight — a player standing one
  // step away from `out00` (e.g. at x≈930 on a 975 px gate) had Δx in 37..48
  // and the client silently dropped the request, so ↑ produced no feedback.
  private static readonly PORTAL_RANGE_X = 48;
  private static readonly PORTAL_RANGE_Y = 64;
  private tryPortal(player: Snapshot['players'][number], touchOnly: boolean) {
    if (player.hp <= 0 || player.action === 'attack' || performance.now() < this.portalCooldownUntil) return;
    const rangeX = World.PORTAL_RANGE_X;
    const rangeY = World.PORTAL_RANGE_Y;
    // Pick the closest interactive portal whose target map is known — JSON
    // order is not a meaningful priority, and a map with two nearby gates
    // (e.g. 小森林's `east00` and `out00`) must route the player to whichever
    // they are physically nearest to, not whichever appears first in the file.
    const candidates = (this.manifest.map.portals ?? [])
      .filter(candidate => candidate.targetMapId && candidate.name !== 'sp'
        && (touchOnly ? candidate.type === 3 : [1, 2, 7, 8, 10, 11].includes(candidate.type))
        && Math.abs(candidate.x - player.x) <= rangeX
        && Math.abs(candidate.y - player.y) <= rangeY)
      .map(candidate => ({ portal: candidate, dx: candidate.x - player.x, dy: candidate.y - player.y }))
      .sort((a, b) => (a.dx * a.dx + a.dy * a.dy) - (b.dx * b.dx + b.dy * b.dy));
    const nearest = candidates[0]?.portal;
    if (!nearest || !this.requestPortal(nearest.name)) return;
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
    for (const npc of Object.values(this.manifest.npcs ?? {})) for (const frame of npc.stand) images.set(frame.url, frame.url);
    for (const portal of Object.values(this.manifest.portals ?? {})) {
      for (const frame of portal.frames ?? []) images.set(frame.url, frame.url);
    }
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
    // Mouse-click / touch-tap NPC conversation: replicate v83 behaviour where
    // tapping an NPC sprite opens the dialogue the same way pressing ↑ would.
    // Phaser clears input listeners on `shutdown`, so a fresh attach here is
    // safe across `scene.restart()` triggered by map switches.
    this.input.on('pointerdown', this.handlePointerDown);
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
    // Place portal sprites between backdrops and the actors; the editor sprites
    // are wide (≈ 530 px) and need depth above tiles but below entities.
    const portalDepth = Math.max(...this.manifest.map.layers.map(layer => layer.depth)) + 2;
    for (const portal of this.manifest.map.portals ?? []) {
      // Only render the animated beam for *real* visible gates: a target
      // portal on another map.  Map.wz mixes several kinds under the same
      // `portal` slot — spawn anchors (type 0 `sp`), script triggers
      // (`script: ...` payload) and the actual doorways — and rendering any
      // non-gate slot duplicates the glow at neighbouring positions.
      if (!portal.targetMapId) continue;
      if (portal.script) continue;
      const asset = this.manifest.portals?.[`${this.manifest.map.id}/${portal.name}`];
      if (!asset?.frames?.length) continue;
      // WZ portal sprites carry an `origin` pixel inside the canvas (e.g. pv
      // is 87×182 with origin (43, 173)), and `portal.y` is the WZ anchor's
      // world y — not the sprite's bottom.  Anchoring at (origin.x, origin.y)
      // leaves the bottom (height − origin.y) px floating below the gate and
      // pushes the top (origin.y) px into the sky, so the beam visibly hovers
      // above the ground (visible on 小森林 out00, where ground is y=155 and
      // the beam would otherwise span y∈[−22, 160]).  Shift the anchor down
      // by exactly that offset so the sprite's foot sits flush on portal.y.
      const firstFrame = asset.frames[0];
      const footOffset = firstFrame.height - (firstFrame.origin?.y ?? firstFrame.height);
      // 仅小森林（000040000）右侧的 out00（通往危险森林）需要把渲染位置右移
      // 精灵锚点列 origin.x 来贴合门的显示中心，其余地图传送阵保持在 portal.x。
      // 只作用于显示，不改数据，后端判定/落点仍以 portal.x 为准。
      const shiftX = this.manifest.map.id === '000040000' && portal.name === 'out00'
        ? (firstFrame.origin?.x ?? 0)
        : 0;
      const anchorX = portal.x + shiftX;
      const anchorY = portal.y + footOffset;
      const view = new PortalView(this, asset.frames, asset.frameDelay ?? 100, anchorX, anchorY, portalDepth);
      this.portals.set(`${this.manifest.map.id}/${portal.name}`, view);
    }
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
      if (target) {
        const view = this.monsters.get(target.id);
        const anchor = view?.hitAnchor({ ...target, x: message.x, y: message.y });
        this.combat?.receiveDamageEvent(anchor ? { ...message, ...anchor } : message, `mob-hit-${target.templateId}`);
      } else {
        // A player took authoritative damage (monster contact hit). The
        // knockback slide and new position arrive with the next snapshot, so
        // only the white hurt flash is triggered locally; the damage number
        // floats above the target's head.
        const player = this.players.get(message.targetId);
        if (player) {
          player.hitFeedback();
          this.combat?.receiveDamageEvent({ ...message, y: message.y + player.headAnchorYOffset() }, null);
        }
      }
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
    for (const npc of this.npcs.values()) npc.destroy();
    for (const drop of this.drops.values()) drop.destroy();
    for (const portal of this.portals.values()) portal.destroy();
    this.players.clear(); this.monsters.clear(); this.npcs.clear(); this.drops.clear(); this.portals.clear(); this.actions.clear(); this.sound?.stopAll();
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

  nearestNpc(): NpcState | null {
    const snapshot = this.snapshot as GameplaySnapshot | undefined;
    if (!snapshot) return null;
    const player = snapshot.players.find(candidate => candidate.id === snapshot.selfId);
    if (!player || !snapshot.npcs?.length) return null;
    const reachable = snapshot.npcs
      .filter(npc => Math.abs(npc.x - player.x) <= 100 && Math.abs(npc.y - player.y) <= 80)
      .sort((a, b) => {
        const distA = (a.x - player.x) ** 2 + (a.y - player.y) ** 2;
        const distB = (b.x - player.x) ** 2 + (b.y - player.y) ** 2;
        return distA - distB;
      });
    return reachable[0] ?? null;
  }

  /** v83 left-click NPC dialogue: open conversation with the nearest NPC whose
   *  sprite the pointer landed on (x within the body, y within head+ground). */
  private handlePointerDown = (pointer: Phaser.Input.Pointer) => {
    if (!this.loaded) return;
    const callback = this.onNpcTalk;
    if (!callback) return;
    // Ignore the secondary / right / middle mouse buttons; v83 uses only LMB.
    if (pointer.button !== undefined && pointer.button !== 0) return;
    const snapshot = this.snapshot as GameplaySnapshot | undefined;
    const npcs = snapshot?.npcs ?? [];
    if (!npcs.length) return;
    // pointer.worldX/Y are absolute map-space coordinates (camera scroll handled
    // by Phaser).  Use the per-NPC stand frame to estimate the click box so the
    // hit area matches the on-screen sprite.
    const worldX = pointer.worldX;
    const worldY = pointer.worldY;
    let best: { npc: NpcState; dist: number } | null = null;
    for (const npc of npcs) {
      const asset = this.manifest.npcs?.[npc.templateId];
      const frames = asset?.stand ?? [];
      const frame = frames[0];
      if (!frame) continue;
      // NpcView applies origin(0) and offsets `frame.x`/`frame.y` from
      // `(npc.x, npc.y)` plus a horizontal flip when `npc.facing === 1`.  We
      // bound the click area to the visible sprite body so a click far away
      // does not start a conversation.
      const left = npc.facing === 1 ? npc.x - frame.x - frame.width : npc.x + frame.x;
      const top = npc.y + frame.y;
      const right = left + frame.width;
      const bottom = top + frame.height;
      if (worldX < left - 8 || worldX > right + 8) continue;
      if (worldY < top - 16 || worldY > bottom + 24) continue;
      const dx = npc.x - worldX;
      const dy = npc.y - worldY;
      const dist = dx * dx + dy * dy;
      if (!best || dist < best.dist) best = { npc, dist };
    }
    if (best) callback(best.npc);
  };

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

    const npcs = snapshot.npcs ?? [];
    const npcIds = new Set(npcs.map(npc => npc.id));
    for (const [id, view] of this.npcs) {
      if (!npcIds.has(id)) { view.destroy(); this.npcs.delete(id); }
    }
    for (const npc of npcs) {
      const asset = this.manifest.npcs?.[npc.templateId];
      if (!asset || !asset.stand.length) continue;
      let view = this.npcs.get(npc.id);
      if (!view) { view = new NpcView(this, asset, actorDepth); this.npcs.set(npc.id, view); }
      const elapsed = (snapshot.serverTick - (npc.actionStartedTick ?? 0)) * snapshot.tickMs + Math.min(performance.now() - this.receivedAt, 250);
      view.update(npc, elapsed);
    }
  }
}
