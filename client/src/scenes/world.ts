import Phaser from 'phaser';
import { randomDropId } from '../features/player/pickup';
import type { NpcState, ServerMessage } from '../../../shared/protocol';
import { actorDepthForLayers, mapFrameAt, mapFramePosition } from '../assets/manifest';
import { buildPreloadPlan } from '../assets/preload-plan';
import type { AssetFrame, Background, MapCatalogEntry, MapDefinition, MapLayer, MapPortal, Manifest } from '../assets/manifest';
import { PlayerView } from '../features/player/view';
import { DropView, MonsterView, type DropSnapshot, type MonsterSnapshot } from '../features/mob/view';
import { NpcView, type NpcSnapshot } from '../features/npc/view';
import { PortalView } from '../features/world/portal-view';
import { ReactorView, reactorStateAsset } from '../features/world/reactor-view';
import { WaterView } from '../features/world/water';
import { CombatView, type SkillCastEvent } from '../features/combat/view';
import { consumeAction } from '../features/player/action-events';
import { WindbellScene } from '../features/windbell/scene';
type Snapshot = Extract<ServerMessage, { type: 'snapshot' }>;
type GameplaySnapshot = Snapshot & { monsters?: MonsterSnapshot[]; drops?: DropSnapshot[]; npcs?: NpcSnapshot[] };
type ReactorSnapshot = NonNullable<Snapshot['reactors']>[number];
type MapLayerView = { layer: MapLayer; frames: AssetFrame[]; images: Phaser.GameObjects.Image[]; elapsed: number; frameIndex: number };
type BackgroundView = MapLayerView & { motionX: number; motionY: number };
export interface PortalRequest {
  sourceMapId: string; portalName: string; targetMapId: string; targetPortalName: string | null;
}
type PortalHandler = (request: PortalRequest) => void;
export class World extends Phaser.Scene {
  private players = new Map<string, PlayerView>();
  private monsters = new Map<string, MonsterView>();
  private npcs = new Map<string, NpcView>();
  private questTargets = new Map<string, Phaser.GameObjects.Container>();
  private drops = new Map<string, DropView>();
  private portals = new Map<string, PortalView>();
  private actions = new Map<string, { actionId: string; tick: number }>();
  private pendingSkillCasts = new Map<string, SkillCastEvent>();
  private waters: WaterView[] = [];
  private reactors = new Map<string, ReactorView>();
  private animatedLayers: MapLayerView[] = [];
  private backgrounds: BackgroundView[] = [];
  private snapshot?: Snapshot;
  private pendingSnapshot?: Snapshot;
  private receivedAt = 0;
  private loaded = false;
  private failed = false;
  private bgm?: Phaser.Sound.BaseSound;
  private bossWarning?: Phaser.GameObjects.Graphics;
  private windbellScene?: WindbellScene;
  private combat?: CombatView;
  private portalCooldownUntil = 0;
  constructor(
    private manifest: Manifest,
    private status: (message: string, error?: boolean) => void,
    private onPortal?: PortalHandler,
    private onNpcTalk?: (npc: NpcState) => void,
    private onQuestInteract?: (questId: string) => void,
    private onReactorHit?: (reactorId: string) => void,
  ) { super('world'); }
  get mapId() { return this.manifest.map.id; }
  /** True once `create()` finished for the current map; `switchMap` flips it
   *  back to false while a map switch rebuilds the scene.  The boot overlay
   *  in `main.ts` waits for this alongside the first snapshot, because the
   *  server starts pushing snapshots while Phaser is still preloading. */
  get isLoaded() { return this.loaded; }
  getMap(mapId = this.mapId, sourceMapId?: string): MapDefinition | MapCatalogEntry | undefined {
    if (mapId === this.mapId) return this.manifest.map;
    const source = this.manifest.mapCatalog?.maps.find(map => map.id === (sourceMapId ?? mapId));
    if (source && sourceMapId?.startsWith('windbell-') && mapId.startsWith('windbell:')) return { ...source, id: mapId };
    if (source && sourceMapId && mapId.startsWith(`practice:${sourceMapId}:`)) {
      return { ...source, id: mapId, name: `${source.name} · P练习`, portals: [] };
    }
    return source?.id === mapId ? source : undefined;
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
    // R8：收集逻辑纯函数化到 assets/preload-plan.ts；Scene 只执行 loader。
    // 顺序与去重语义逐行保留：图片先全部入队，音频按 原顺序（升级→技能→
    // BGM→普攻→受击→怪物受击）；BGM 的 cache.audio.exists 短路留在 Scene。
    const plan = buildPreloadPlan(this.manifest);
    for (const { key, url } of plan.images) this.load.image(key, url);
    for (const entry of plan.audio) {
      if (entry.skipIfCached && this.cache.audio.exists(entry.url)) continue;
      this.load.audio(entry.key, entry.url);
    }
    if(this.manifest.map.source?.includes('windbell.json'))for(const name of WindbellScene.sounds){
      const url=`/assets/windbell/sfx/${name}.ogg`;if(!this.cache.audio.exists(url))this.load.audio(url,url);
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
    this.combat = new CombatView(this, this.manifest.combat, Math.max(...this.manifest.map.layers.map(layer => layer.depth)) + 3, undefined, 'combat-hit', this.manifest.skillEffects, this.manifest.skillSounds);
    const b = this.manifest.map.bounds;
    for (const layer of this.manifest.map.layers) {
      if (layer.background) this.createBackground(layer);
      else if (layer.frames?.length) this.createAnimatedLayer(layer);
      else {
        const point = layer.flip && layer.width && layer.height
          ? mapFramePosition(layer, { origin: layer.origin ?? {x:0,y:0}, width: layer.width, height: layer.height }) : layer;
        const image = this.add.image(point.x, point.y, layer.url).setOrigin(0).setDepth(layer.depth).setFlipX(layer.flip ?? false).setAlpha((layer.alpha ?? 255) / 255);
        if (layer.crop) image.setCrop(layer.crop.x, layer.crop.y, layer.crop.width, layer.crop.height);
      }
    }
    this.createWater();
    const windbellKind = this.manifest.map.source?.includes('windbell.json') ? (this.manifest.map.id.includes('island') ? 'island' : 'bridge') : undefined;
    if (windbellKind) this.windbellScene = new WindbellScene(this, windbellKind);
    this.cameras.main.setBounds(b.xMin, b.yMin, b.xMax - b.xMin, b.yMax - b.yMin);
    this.updateBackgrounds(0);
    // Place portal effects above regular map layers while keeping foreground
    // backdrops in front of actors and portals.
    const portalDepth = actorDepthForLayers(this.manifest.map.layers) + 1;
    for (const portal of this.manifest.map.portals ?? []) {
      // Only render the animated beam for *real* visible gates: a target
      // portal on another map.  Map.wz mixes several kinds under the same
      // `portal` slot — spawn anchors (type 0 `sp`) and same-map links (type
      // 10 `bottom0`/`top0`) — and rendering a non-gate slot duplicates the
      // glow at neighbouring positions.
      // A `script` payload no longer disqualifies a gate: TMS273 ships several
      // story doorways (楓之港 `east00` → 碼頭 with `pt_southperry`, 弓箭手村
      // `Achter00` → 培訓中心 with `enterAchter`, …) whose WZ `tm` is
      // 999999999 and whose route is assigned by the chapter adapter, so
      // skipping them hid beams that players must be able to see and enter.
      if (!portal.targetMapId || portal.targetMapId === this.manifest.map.id) continue;
      const asset = this.manifest.portals?.[`${this.manifest.map.id}/${portal.name}`];
      if (!asset?.frames?.length) continue;
      // The exporter keeps the WZ portal origin in every frame; PortalView
      // applies that origin while using the authoritative portal coordinates.
      const view = new PortalView(this, asset.frames, asset.frameDelay ?? 100, portal.x, portal.y, portalDepth);
      this.portals.set(`${this.manifest.map.id}/${portal.name}`, view);
    }
    if (this.manifest.map.bgm) { this.bgm = this.sound.add(this.manifest.map.bgm, { loop: true, volume: 0.25 }); this.bgm.play(); }
    this.status('地图已就绪，等待服务器快照…');
    this.events.once('shutdown', () => { this.clear(); this.bgm?.destroy(); });
  }
  private createWater() {
    const depth = actorDepthForLayers(this.manifest.map.layers);
    this.waters = (this.manifest.map.water ?? []).map(zone => new WaterView(this, zone, depth));
  }
  receive(message: ServerMessage) {
    if (message.type === 'chatMessage') {
      // Every same-map member sees the head bubble, including the speaker:
      // the server echoes the sender's own chatMessage (tagged with requestId)
      // and 273 shows the bubble above your own character as well.  Messages
      // never replay history and the PlayerView is destroyed on map switches,
      // so a bubble cannot leak into another map instance.
      this.players.get(message.authorId)?.showBubble(message.authorName, message.text);
      return;
    }
    if (message.type === 'emoticonMessage') {
      // The sticker is resolved through the *exported catalogue*, not through
      // any geometry the sender supplied, so a message that names an id this
      // build does not know simply renders nothing — the server is the only
      // thing that decides whether an id exists at all.  Same room rules as
      // map chat: only same-map members are ever told, and the sender sees its
      // own sticker because the server echoes it.
      const frames = this.manifest.emoticon?.stickers.find(sticker => sticker.id === message.emoticonId)?.frames ?? [];
      this.players.get(message.authorId)?.showEmoticon(frames);
      return;
    }
    if (message.type === 'snapshot') {
      if (message.mapId !== this.mapId) {
        const map = this.getMap(message.mapId, message.sourceMapId);
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
    if (message.type === 'skillCast' && this.loaded) {
      const event: SkillCastEvent = message;
      const accepted = this.combat?.receiveSkillCast(event) ?? true;
      if (!accepted) return;
      const view = this.players.get(event.playerId);
      if (view) view.startSkill(event.skillId, event.durationMs, event.phase);
      else this.pendingSkillCasts.set(event.playerId, event);
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
    if (message.type === 'monsterSkill' && this.loaded) {
      // A mob cast an abnormal-status skill against a player. The disease
      // itself rides the next snapshot as `abnormalStatus`; here we only
      // flash the target so the hit reads immediately, and the mob's cast
      // pose arrives through its own action in the snapshot.
      this.players.get(message.targetId)?.hitFeedback(300);
    }
    if (message.type === 'reactorState' && message.mapId === this.mapId) {
      // The authoritative result: play the one-shot impact animation for the
      // exact window the server locked, so the prop becomes interactive again
      // precisely when the server says it does.
      this.reactors.get(message.reactorId)?.playHit(message.hitDurationMs);
      return;
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
    this.windbellScene?.destroy(); this.windbellScene = undefined;
    this.bossWarning?.destroy(); this.bossWarning = undefined;
    this.snapshot = undefined;
    for (const player of this.players.values()) player.destroy();
    for (const monster of this.monsters.values()) monster.destroy();
    for (const npc of this.npcs.values()) npc.destroy();
    for (const target of this.questTargets.values()) target.destroy();
    this.questTargets.clear();
    for (const drop of this.drops.values()) drop.destroy();
    for (const reactor of this.reactors.values()) reactor.destroy();
    for (const portal of this.portals.values()) portal.destroy();
    for (const view of this.animatedLayers) for (const image of view.images) image.destroy();
    for (const view of this.backgrounds) for (const image of view.images) image.destroy();
    for (const water of this.waters) water.destroy();
    this.players.clear(); this.monsters.clear(); this.npcs.clear(); this.drops.clear(); this.portals.clear(); this.reactors.clear(); this.actions.clear(); this.pendingSkillCasts.clear(); this.sound?.stopAll();
    this.animatedLayers = []; this.backgrounds = []; this.waters = [];
    this.combat?.clear();
  }
  setMuted(muted: boolean) { this.sound.mute = muted; }
  private createAnimatedLayer(layer: MapLayer) {
    const frames = layer.frames ?? [];
    const view: MapLayerView = { layer, frames, images: [], elapsed: 0, frameIndex: 0 };
    const first = frames[0];
    if (!first) return;
    view.images.push(this.add.image(0, 0, first.url).setOrigin(0).setDepth(layer.depth));
    this.animatedLayers.push(view);
    this.applyLayerFrame(view, first);
  }
  private applyLayerFrame(view: MapLayerView, frame: AssetFrame) {
    const image = view.images[0];
    if (!image) return;
    const position = mapFramePosition(view.layer, frame);
    image.setTexture(frame.url).setOrigin(0)
      .setPosition(Math.round(position.x), Math.round(position.y))
      .setFlipX(view.layer.flip ?? false)
      .setAlpha((frame.alpha ?? view.layer.alpha ?? 255) / 255);
  }
  private applyBackgroundFrame(view: BackgroundView, frame: AssetFrame) {
    const layer = view.layer;
    const flip = layer.flip ?? Boolean(layer.background?.f);
    const alpha = (frame.alpha ?? layer.alpha ?? 255) / 255;
    for (const image of view.images) image.setTexture(frame.url).setOrigin(0).setFlipX(flip).setAlpha(alpha);
  }
  private advanceMapAnimations(delta: number) {
    const step = Number.isFinite(delta) && delta > 0 ? delta : 0;
    for (const view of this.animatedLayers) {
      if (view.frames.length < 2) continue;
      view.elapsed += step;
      const index = mapFrameAt(view.frames, view.elapsed);
      if (index !== view.frameIndex) {
        view.frameIndex = index;
        this.applyLayerFrame(view, view.frames[index]);
      }
    }
    for (const view of this.backgrounds) {
      if (view.frames.length < 2) continue;
      view.elapsed += step;
      const index = mapFrameAt(view.frames, view.elapsed);
      if (index !== view.frameIndex) {
        view.frameIndex = index;
        this.applyBackgroundFrame(view, view.frames[index]);
      }
    }
  }
  private createBackground(layer: MapLayer) {
    this.backgrounds.push({ layer, frames: layer.frames ?? [], images: [], elapsed: 0, frameIndex: 0, motionX: 0, motionY: 0 });
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
      const frame = view.frames[view.frameIndex];
      const url = frame?.url ?? layer.url;
      const source = this.textures.get(url).getSourceImage();
      const frameWidth = frame?.width ?? layer.width ?? source.width;
      const frameHeight = frame?.height ?? layer.height ?? source.height;
      const originX = frame?.origin.x ?? layer.origin?.x ?? frameWidth / 2;
      const originY = frame?.origin.y ?? layer.origin?.y ?? frameHeight / 2;
      const flip = layer.flip ?? Boolean(bg.f);
      const tileWidth = Math.max(1, bg.cx || frameWidth);
      const tileHeight = Math.max(1, bg.cy || frameHeight);
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
      // Only the verified 273 sky/water color strips adapt vertically. Keep
      // scenery, parallax anchors, actors and collision geometry at source scale.
      const sourceTop = y - originY;
      const top = layer.source === 'Map/Back/grassySoil_new.img/back/0' ? Math.min(0, sourceTop) : sourceTop;
      const bottom = layer.source === 'Map/Back/grassySoil_new.img/back/12' ? Math.max(height, sourceTop + frameHeight) : sourceTop + frameHeight;
      const scaleY = (bottom - top) / frameHeight;
      const columns = repeatX ? Math.ceil(width / tileWidth) + 2 : 1;
      const rows = repeatY ? Math.ceil(height / tileHeight) + 2 : 1;
      const needed = columns * rows;
      const alpha = (frame?.alpha ?? layer.alpha ?? 255) / 255;
      while (images.length < needed) images.push(this.add.image(0, 0, url).setOrigin(0).setDepth(layer.depth).setFlipX(flip).setAlpha(alpha).setScrollFactor(0));
      let i = 0;
      const left = flip ? x + originX - frameWidth : x - originX;
      for (let tx = 0; tx < columns; tx++) for (let ty = 0; ty < rows; ty++) images[i++].setVisible(true).setPosition(left + tx * tileWidth, top + ty * tileHeight).setScale(1, scaleY).setFlipX(flip).setAlpha(alpha);
      for (; i < images.length; i++) images[i].setVisible(false);
    }
  }
  private drawBossWarning() {
    this.bossWarning?.clear();
    const warning = this.snapshot?.bossPractice?.telegraph;
    if (!warning || ![warning.x, warning.y, warning.remainingMs].every(Number.isFinite)) return;
    const remaining = warning.remainingMs - Math.max(0, performance.now() - this.receivedAt);
    if (remaining <= 0) return;
    // P: explicit server hit geometry, drawn in the same world coordinates as source footholds.
    const shape = this.bossWarning ??= this.add.graphics().setDepth(8_000);
    shape.fillStyle(0xe65a36, 0.2).lineStyle(3, 0xffdb78, 0.95);
    if (warning.kind === 'circle' && Number.isFinite(warning.radius) && warning.radius! > 0 && warning.radius! <= 2000) {
      shape.fillCircle(warning.x, warning.y, warning.radius!);
      shape.strokeCircle(warning.x, warning.y, warning.radius!);
    } else if (warning.kind === 'rect' && Number.isFinite(warning.width) && Number.isFinite(warning.height)
      && warning.width! > 0 && warning.width! <= 4000 && warning.height! > 0 && warning.height! <= 4000) {
      shape.fillRect(warning.x, warning.y, warning.width!, warning.height!);
      shape.strokeRect(warning.x, warning.y, warning.width!, warning.height!);
    }
  }
  update(_time?: number, delta = 8) {
    this.windbellScene?.update(this.snapshot?.windbell, this.snapshot?.players.find(p => p.id === this.snapshot?.selfId), delta, this.snapshot?.tickMs);
    if (!this.loaded) return;
    this.advanceMapAnimations(delta);
    this.updateBackgrounds(delta);
    for (const water of this.waters) water.update(delta);
    this.combat?.syncPlayers(this.snapshot?.players);
    this.combat?.syncSummons(this.snapshot?.summons);
    this.combat?.update();
    this.drawBossWarning();
    if (!this.snapshot) return;
    const snapshot = this.snapshot;
    const ids = new Set(snapshot.players.map(player => player.id));
    for (const [id, view] of this.players) if (!ids.has(id)) { this.combat?.clearSkillPlayer(id); view.destroy(); this.players.delete(id); this.actions.delete(id); }
    for (const player of snapshot.players) {
      let view = this.players.get(player.id);
      if (!view) {
        view = new PlayerView(this, this.manifest, player.username, player.id === snapshot.selfId);
        this.players.set(player.id, view);
        const pending = this.pendingSkillCasts.get(player.id);
        if (pending) { view.startSkill(pending.skillId, pending.durationMs, pending.phase); this.pendingSkillCasts.delete(player.id); }
      }
      if (player.hp <= 0 || player.action === 'dead') this.combat?.clearSkillPlayer(player.id);
      const elapsed = (snapshot.serverTick - player.actionStartedTick) * snapshot.tickMs + Math.min(performance.now() - this.receivedAt, 250);
      view.update(player, elapsed);
      // P: ripples and the entry splash are display-only; the server owns the
      // swim position and the water column the player is actually inside.
      for (const water of this.waters) water.noteActor(player.id, player.x, player.y, player.vx, performance.now());
      if (player.id === snapshot.selfId) {
        // Keep the player and name above the HUD in short browser viewports.
        this.cameras.main.centerOn(Math.round(player.x), Math.round(player.y - Math.min(120, this.cameras.main.height * 0.1)));
        this.tryPortal(player, true);
      }
    }
    this.updateGameplayEntities(snapshot as GameplaySnapshot, delta);
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
    if (!npcs.length && (!snapshot?.reactors?.length || !this.onReactorHit)) return;
    const worldX = pointer.worldX;
    const worldY = pointer.worldY;

    // 1) Try NPC interaction first, matching the existing desktop v83 order.
    {
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
        const markerHit = this.npcs.get(npc.id)?.containsMarker(worldX, worldY);
        if (!markerHit && (worldX < left - 8 || worldX > right + 8 || worldY < top - 16 || worldY > bottom + 24)) continue;
        const dx = npc.x - worldX;
        const dy = npc.y - worldY;
        const dist = dx * dx + dy * dy;
        if (!best || dist < best.dist) best = { npc, dist };
      }
      if (best) {
        callback?.(best.npc);
        return;
      }
    }

    // 2) Fallback to the nearest reactor hotspot for click-based interaction
    // (the server still validates final range/state, this only selects intent).
    const reactor = this.nearestReactorAt(worldX, worldY);
    if (reactor) {
      this.onReactorHit?.(reactor.id);
    }
  };

  private nearestReactorAt(worldX: number, worldY: number): ReactorSnapshot | null {
    const snapshot = this.snapshot as (GameplaySnapshot & { reactors?: ReactorSnapshot[] }) | undefined;
    if (!snapshot) return null;
    const candidates = (snapshot.reactors ?? [])
      // 点击道具入口仅用于 type 9（原始踩区/碰撞触发）反应器；其余交互由攻击键处理。
      .filter(reactor => (reactor.hitType ?? 0) === 9 && !reactor.spent)
      .map(reactor => ({ reactor, dx: reactor.x - worldX, dy: reactor.y - worldY }))
      .filter(({ dx, dy }) => Math.abs(dx) <= World.REACTOR_CLICK_RANGE_X && Math.abs(dy) <= World.REACTOR_CLICK_RANGE_Y)
      .sort((a, b) => (a.dx * a.dx + a.dy * a.dy) - (b.dx * b.dx + b.dy * b.dy));
    return candidates[0]?.reactor ?? null;
  }

  private playerHasStarterSword(playerId: string) {
    const player = this.snapshot?.players.find(candidate => candidate.id === playerId);
    const equipped = player?.equipped;
    // Legacy snapshots and unsupported-only equipment use the original
    // starter appearance, which includes the source-backed sword.
    if (!player || equipped === undefined || (equipped.length > 0 && !equipped.some(item => ['1002067', '1040002', '1052095', '1302000'].includes(item.itemId)))) return true;
    return equipped.some(item => item.itemId === '1302000');
  }

  /**
   * Client-side buoyancy for one drop icon: the server already parks a drop
   * that fell into the pool at its floating anchor, so this only adds the
   * spring settling, the wave bob and the tilt (P display layer).
   */
  private dropFloat(id: string, dropX: number, dropY: number, frame: AssetFrame, delta: number) {
    if (!this.waters.length) return undefined;
    const centerX = dropX + frame.x + frame.width / 2;
    const bottom = dropY + frame.y + frame.height;
    for (const water of this.waters) {
      const float = water.floatFor(id, centerX, frame.height, bottom, delta / 1000);
      if (float) return { y: float.bottom - frame.y - frame.height, tilt: float.tilt };
    }
    return undefined;
  }

  /**
   * Sync the placed map reactors with the authoritative snapshot.
   *
   * State always wins over local animation: if the server says a prop moved on
   * (or came back), the local frame cursor is reset to that state instead of
   * continuing whatever was playing.  Two clients therefore agree on whether
   * the flower is still there even if one of them only just arrived.
   */
  private updateReactors(snapshot: GameplaySnapshot, actorDepth: number, delta: number) {
    const reactors = (snapshot as { reactors?: ReactorSnapshot[] }).reactors ?? [];
    const ids = new Set(reactors.map(reactor => reactor.id));
    for (const [id, view] of this.reactors) {
      if (!ids.has(id)) { view.destroy(); this.reactors.delete(id); }
    }
    const templates = this.manifest.reactors?.templates;
    for (const reactor of reactors) {
      const asset = reactorStateAsset(templates, reactor.templateId, reactor.state);
      if (!asset) continue;
      let view = this.reactors.get(reactor.id);
      if (!view) {
        view = new ReactorView(this, asset, reactor.x, reactor.y, reactor.flip, actorDepth + 1);
        this.reactors.set(reactor.id, view);
      }
      // A state change re-anchors the prop; an unchanged one keeps animating.
      if (view.currentState !== reactor.state || view.isSpent !== reactor.spent) {
        view.setState(asset, reactor.state, reactor.spent);
      }
      view.update(delta);
    }
  }

  /** The nearest reactor the local player can actually interact with. */
  nearestReactor(): ReactorSnapshot | null {
    const snapshot = this.snapshot as (GameplaySnapshot & { reactors?: ReactorSnapshot[] }) | undefined;
    if (!snapshot) return null;
    const player = snapshot.players.find(candidate => candidate.id === snapshot.selfId);
    if (!player) return null;
    const candidates = (snapshot.reactors ?? [])
      // 攻击键互动沿用原始敲击语义：跳过 type 9（区域/点击型）反应器，避免重复触发。
      .filter(reactor => (reactor.hitType ?? 0) !== 9 && !reactor.spent)
      .map(reactor => ({ reactor, dx: reactor.x - player.x, dy: reactor.y - player.y }))
      .filter(({ dx, dy }) => Math.abs(dx) <= World.REACTOR_RANGE_X && Math.abs(dy) <= World.REACTOR_RANGE_Y)
      .sort((a, b) => (a.dx * a.dx + a.dy * a.dy) - (b.dx * b.dx + b.dy * b.dy));
    return candidates[0]?.reactor ?? null;
  }

  /** Client-side reach hint only; the server re-checks range authoritatively. */
  private static readonly REACTOR_RANGE_X = 96;
  private static readonly REACTOR_RANGE_Y = 72;
  private static readonly REACTOR_CLICK_RANGE_X = 56;
  private static readonly REACTOR_CLICK_RANGE_Y = 80;

  private updateGameplayEntities(snapshot: GameplaySnapshot, delta = 8) {
    const actorDepth = actorDepthForLayers(this.manifest.map.layers);
    const monsters = snapshot.monsters ?? [];
    const monsterIds = new Set(monsters.map(monster => monster.id));
    for (const [id, view] of this.monsters) {
      if (!monsterIds.has(id)) { view.destroy(); this.monsters.delete(id); }
    }
    for (const monster of monsters) {
      const asset = this.manifest.monsters?.[monster.templateId];
      if (!asset) continue;
      let view = this.monsters.get(monster.id);
      if (!view) { view = new MonsterView(this, asset, actorDepth, this.manifest.skillEffects?.['2200011']?.mob, this.manifest.bossEffects); this.monsters.set(monster.id, view); }
      const elapsed = (snapshot.serverTick - monster.actionStartedTick) * snapshot.tickMs + Math.min(performance.now() - this.receivedAt, 250);
      view.update(monster, elapsed);
      view.updateBossEffects(monster, monster.templateId === snapshot.bossPractice?.bossId ? snapshot.bossPractice.effects : undefined, Math.max(0, performance.now() - this.receivedAt));
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
      const float = this.dropFloat(drop.id, drop.x, drop.y, asset, delta);
      // A floating icon belongs under the translucent surface layer, a grounded
      // one stays above the actors so it keeps its pickup readability.
      view.setDepth(float ? actorDepth + WaterView.OVERLAY_OFFSET - 0.01 : actorDepth + 1);
      view.update(drop, float);
    }
    for (const water of this.waters) water.pruneFloats(dropIds);

    const interactions = snapshot.questInteractions ?? [];
    const interactionIds = new Set(interactions.map(entry => entry.questId));
    for (const [id, target] of this.questTargets) {
      if (!interactionIds.has(id)) { target.destroy(); this.questTargets.delete(id); }
    }
    for (const entry of interactions) {
      let target = this.questTargets.get(entry.questId);
      if (!target) {
        target = this.add.container(entry.x, entry.y).setDepth(actorDepth + 12);
        const label = this.add.text(0, -40, `点击${entry.label} ▸`, {
          fontFamily: 'sans-serif', fontSize: '13px', color: '#fff4a3',
          stroke: '#273138', strokeThickness: 4, backgroundColor: '#273138cc', padding: { x: 8, y: 6 },
        }).setOrigin(0.5, 1).setInteractive({ useHandCursor: true });
        const click = (pointer: Phaser.Input.Pointer, _x: number, _y: number, event: Phaser.Types.Input.EventData) => {
          event.stopPropagation();
          if (pointer.button === 0) this.onQuestInteract?.(entry.questId);
        };
        label.on('pointerdown', click);
        target.add(label);
        const layer = this.manifest.map.layers.find(layer => layer.key === entry.mapLayerKey);
        if (layer?.width && layer.height) {
          const zone = this.add.zone(layer.x - entry.x, layer.y - entry.y, layer.width, layer.height)
            .setOrigin(0).setInteractive({ useHandCursor: true });
          zone.on('pointerdown', click);
          target.add(zone);
        }
        this.questTargets.set(entry.questId, target);
      }
      target.setPosition(entry.x, entry.y);
    }
    this.updateReactors(snapshot, actorDepth, delta);

    const npcs = snapshot.npcs ?? [];
    const npcIds = new Set(npcs.map(npc => npc.id));
    for (const [id, view] of this.npcs) {
      if (!npcIds.has(id)) { view.destroy(); this.npcs.delete(id); }
    }
    for (const npc of npcs) {
      const asset = this.manifest.npcs?.[npc.templateId];
      if (!asset || !asset.stand.length) continue;
      let view = this.npcs.get(npc.id);
      if (!view) { view = new NpcView(this, asset, actorDepth, this.manifest.npcQuestAvailable?.frames); this.npcs.set(npc.id, view); }
      const elapsed = (snapshot.serverTick - (npc.actionStartedTick ?? 0)) * snapshot.tickMs + Math.min(performance.now() - this.receivedAt, 250);
      view.update(npc, elapsed);
    }
  }
}
