import Phaser from 'phaser';
import type { PlayerState, SummonState, ServerMessage } from '../../../../shared/protocol';
import type { AssetFrame, CombatAssets, DamageNumberSet, Manifest } from '../../assets/manifest';
import { assetFrameAlpha } from '../../assets/manifest';
import { ensureTextures } from '../../assets/lazy-texture';
import { damageNumberAdvances, damageNumberLayers } from './damage-number';
import { frameAt } from '../player/animation';
// 火毒／主教四转「同一格副本」的镜像名单（与服务端 `world.rs` 的几张表同源）。
import { CASTER_ANCHORED_BUFFS, HYPER_ADVENTURER_SKILLS, INFINITY_SKILLS, SUMMON_SKILLS } from '../player/input';

export type Facing = -1 | 1;

/** The server accepted an attack. It starts presentation only; it never implies a hit. */
export interface CombatActionStartedEvent {
  type: 'actionStarted';
  eventId?: string;
  playerId: string;
  actionId: string;
  serverTick: number;
  x: number;
  y: number;
  facing: Facing;
  /** Local receive time for deterministic late-event handling. */
  startedAtMs?: number;
}

/**
 * A damage result produced by the authoritative server.
 * The client only validates, deduplicates, and presents this value.
 */
export interface AuthoritativeDamageEvent {
  type: 'damageEvent';
  eventId: string;
  serverTick: number;
  attackerId?: string;
  targetId: string;
  x: number;
  y: number;
  damage: number;
  killed?: boolean;
  critical?: boolean;
  skillId?: number;
  skillLevel?: number;
  segment?: number;
  targetCount?: number;
  /** 魔心防禦：这一击里由 MP 承受的那一份（`server/src/monsters.rs` 的权威拆分）。 */
  mpDamage?: number;
}

/**
 * 一次**只发给当事人**的权威资源恢复。`hp`／`mp` 是实际增加量；同一次恢复可以
 * 两者都有（坐椅子、魔力激发），也可以只有一边（喝红药、只回复 HP 的技能）。
 */
export interface RecoveryEvent {
  type: 'recoveryEvent';
  eventId: string;
  serverTick: number;
  playerId: string;
  x: number;
  y: number;
  hp?: number;
  mp?: number;
  source?: Extract<ServerMessage, { type: 'recoveryEvent' }>['source'];
}

export interface SkillCastEvent {
  phase?: 'prepare' | 'sustain' | 'final';
  type: 'skillCast';
  eventId: string;
  serverTick: number;
  playerId: string;
  skillId: number;
  skillLevel?: number;
  requestId: string;
  x: number;
  y: number;
  facing: Facing;
  durationMs: number;
  targetId?: string;
  targetX?: number;
  targetY?: number;
}

export type CombatEvent = CombatActionStartedEvent | AuthoritativeDamageEvent | SkillCastEvent;

type SummonVisual = {
  state: SummonState; startedAt: number; updatedAt: number;
  expiresAt: number; fromX: number; fromY: number; x: number; y: number; attackAt?: number;
  /** 见 `spriteFor()`：纹理没进缓存前不建对象，所以可能是空的。 */
  sprite?: Phaser.GameObjects.Image;
};

type Slash = {
  event: CombatActionStartedEvent;
  startedAtMs: number;
  /** 同 `SummonVisual.sprite`。 */
  sprite?: Phaser.GameObjects.Image;
};

type SkillVisual = {
  event: SkillCastEvent | AuthoritativeDamageEvent;
  frames: AssetFrame[];
  startedAtMs: number;
  /** 同 `SummonVisual.sprite`。 */
  sprite?: Phaser.GameObjects.Image;
  loopMs?: number;
  buffSkillId?: number;
  sourceSummonId?: string;
  travel?: { fromX: number; fromY: number; toX: number; toY: number };
};

type SourceSummon = { playerId: string; skillId: number; expiresAt: number };
type HyperThunderPhase = { requestId: string; phase: NonNullable<SkillCastEvent['phase']>; serverTick: number; cancelled: boolean };

function nowMs() {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function validFacing(facing: number): facing is Facing {
  return facing === -1 || facing === 1;
}

function validPoint(x: number, y: number) {
  return Number.isFinite(x) && Number.isFinite(y);
}

function validFrame(frame: AssetFrame | undefined) {
  return Boolean(frame?.url && frame.width > 0 && frame.height > 0 && frame.delay > 0);
}

function sourceVariants(frames: AssetFrame[], group: string): AssetFrame[][] {
  const variants = new Map<string, AssetFrame[]>();
  for (const frame of frames) {
    const tail = frame.source?.split(`/${group}/`)[1]?.split('/');
    if (!tail || tail.length < 2 || !/^\d+$/.test(tail[0])) continue;
    const entries = variants.get(tail[0]) ?? [];
    entries.push(frame); variants.set(tail[0], entries);
  }
  return variants.size ? [...variants].sort(([a], [b]) => Number(a) - Number(b)).map(([, entries]) => entries) : [frames];
}

/** Renders source-backed combat presentation driven by server events. */
export class CombatView {
  private readonly slashes: Slash[] = [];
  private readonly summons = new Map<string, SummonVisual>();
  private readonly sourceSummons = new Map<string, SourceSummon>();
  private summonSnapshot?: SummonState[];
  private playerSnapshot?: PlayerState[];
  private playerStates = new Map<string, PlayerState>();
  private readonly skillVisuals: SkillVisual[] = [];
  private readonly hyperThunderPhases = new Map<string, HyperThunderPhase>();
  private readonly hyperBarrierCancelled = new Map<string, string>();
  private readonly pendingBarrierStarts = new Set<string>();
  private readonly damageNumbers = new Set<Phaser.GameObjects.Container>();
  private readonly seen = new Set<string>();
  private readonly skillAudio = new Map<Phaser.Sound.BaseSound, string>();
  private readonly auraAudio = new Map<string, Phaser.Sound.BaseSound>();
  private readonly channelAudio = new Map<string, { skillId?: number; requestId: string; startAt: number; expiresAt: number; sound?: Phaser.Sound.BaseSound }>();

  /** `hitSoundKey` must be the key used by World.preload for manifest.combat.hit.sound. */
  constructor(
    private readonly scene: Phaser.Scene,
    private readonly assets: CombatAssets | undefined,
    private readonly depth: number,
    private readonly clock: () => number = nowMs,
    private readonly hitSoundKey = 'combat-hit',
    private readonly skillEffects: Manifest['skillEffects'],
    private readonly skillSounds?: Manifest['skillSounds'],
  ) {}

  /** Feed an already accepted action from the server's actionStarted message. */
  receiveActionStarted(event: CombatActionStartedEvent) {
    if (!event.playerId || !event.actionId || !Number.isFinite(event.serverTick) || !validPoint(event.x, event.y) || !validFacing(event.facing)) return;
    const id = `action:${event.eventId ?? `${event.playerId}:${event.actionId}:${event.serverTick}`}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);

    // 「没有刀光素材就整段不记」这条判据留在入口：`update()` 的刀光循环整块挂在
    // `if (afterimage)` 下，素材缺失时在这里放行会让 `slashes` 只进不出（永远不画、
    // 也永远不清）。
    const afterimage = this.assets?.attack?.afterimage;
    if (!afterimage?.frames.length || !afterimage.frames.every(validFrame)) return;
    // 贴图交给 `update()` 在纹理就绪后补建（见 `spriteFor()`）：这里若直接
    // `add.image(…, afterimage.frames[0].url)`，首屏还没装载完的那一帧就是绿黑格子。
    this.slashes.push({ event, startedAtMs: event.startedAtMs ?? this.clock() });
  }

  /**
   * Feed one authoritative damage result. `damage` is displayed verbatim;
   * this class never chooses a target or derives a damage amount.
   */
  receiveDamageEvent(event: AuthoritativeDamageEvent, hitSoundKey: string | null = this.hitSoundKey) {
    if (!event.eventId || !event.targetId || !Number.isFinite(event.serverTick) || !validPoint(event.x, event.y) || !Number.isFinite(event.damage) || event.damage < 0) return;
    // 魔心防禦：HP 那一份可能是 0（未接下的 1% 做整数除法，伤害 < 100 时正好取整成 0），
    // 而这一击仍要画蓝字。判据因此是**「两根都为 0 才整条丢弃」**，不是「HP 为 0 就丢」
    // ——后者会让「MP 在掉、一根数字都没有」（2026-09-19 实玩实锤）。
    if (damageNumberLayers(event.damage, Math.round(event.mpDamage ?? 0)).length === 0) return;
    const id = `damage:${event.eventId}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.spawnSkillHit(event);
    // A null hitSoundKey silences the cue: players taking monster contact
    // damage have no source-backed hit cue, so do not reuse the mob-hit cue.
    if (hitSoundKey && this.scene.sound && this.scene.cache.audio.exists(hitSoundKey)) this.scene.sound.play(hitSoundKey, { volume: 0.28 });
    // P: one source Hit cue per target's first authoritative damage segment.
    if ((event.segment ?? 1) === 1 && event.skillId !== undefined) this.playSkillSound(event.attackerId, this.skillSounds?.[String(event.skillId)]?.hit?.url);
    this.spawnDamageNumber(event);
    if ([2211011, 2211015, ...SUMMON_SKILLS].includes(event.skillId ?? 0) && (event.segment ?? 1) === 1) {
      for (const summon of this.summons.values()) if (summon.state.playerId === event.attackerId && summon.state.skillId === event.skillId) summon.attackAt = this.clock();
      const soundId = `summon:${event.attackerId}:${event.skillId}:${event.serverTick}`;
      if (!this.seen.has(soundId)) {
        this.seen.add(soundId);
        this.playSkillSound(event.attackerId, this.skillSounds?.[String(event.skillId)]?.summonAttack?.url);
      }
    }
  }

  receive(event: CombatEvent) {
    // 技能特效改按需装载：整本 `skillEffects` 实测 1,327 张 / 115.6MB，占首屏集
    // 字节的 **90%**，而本视图真正用到的只是事件里那几个技能。在**事件入口**入队，
    // 让纹理在要画之前就上路；返回值故意忽略——特效该照常播，不能因为纹理晚到
    // 就整段不画（首帧若有极短暂的占位，下一帧纹理落地后自愈）。
    const skillId = event.type === 'actionStarted' ? undefined : event.skillId;
    if (typeof skillId === 'number' && Number.isFinite(skillId)) {
      this.ensureEffectTextures(skillId, event.type === 'skillCast' ? undefined : (event as AuthoritativeDamageEvent).skillLevel);
    }
    if (event.type === 'actionStarted') this.receiveActionStarted(event);
    else if (event.type === 'skillCast') this.receiveSkillCast(event);
    else this.receiveDamageEvent(event);
  }

  /**
   * 把某条技能用到的特效帧全部入队（含 `<id>:<等级>` 这一组变体）。
   * 只入队、不判就绪：调用方按原节奏播效果。
   */
  private ensureEffectTextures(skillId: number, skillLevel?: number) {
    const urls: string[] = [];
    for (const key of [`${skillId}:${skillLevel}`, String(skillId)]) {
      const set = this.skillEffects?.[key];
      if (!set) continue;
      for (const frames of Object.values(set)) for (const frame of frames ?? []) if (frame?.url) urls.push(frame.url);
    }
    if (urls.length) ensureTextures(this.scene, urls);
  }

  /** Start source-backed skill VFX only after the server accepts the cast. */
  receiveSkillCast(event: SkillCastEvent): boolean {
    if (!event.eventId || !event.playerId || !Number.isFinite(event.serverTick) || !Number.isFinite(event.skillId)
      || !validPoint(event.x, event.y) || !validFacing(event.facing) || !Number.isFinite(event.durationMs) || event.durationMs < 0) return false;
    const id = `skill:${event.eventId}`;
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (event.skillId === 2221052) {
      const set = this.skillEffects?.['2221052'];
      // A legacy envelope can omit phase. Treat it as the held/sustain stage
      // so the player pose and world VFX choose the same source group.
      const phase = event.phase ?? 'sustain';
      const phaseKey = `${event.playerId}:2221052`;
      const phaseRank = phase === 'prepare' ? 0 : phase === 'sustain' ? 1 : 2;
      const prior = this.hyperThunderPhases.get(phaseKey);
      if (prior && event.serverTick < prior.serverTick) return false;
      // The release envelope is deliberately a zero-duration sustain with
      // the same requestId. It must pass through once to cancel the held
      // visual; only positive-duration duplicate phases are ignored.
      if (prior && prior.requestId === event.requestId && event.durationMs > 0
        && phaseRank <= (prior.phase === 'prepare' ? 0 : prior.phase === 'sustain' ? 1 : 2)) return false;
      this.hyperThunderPhases.set(phaseKey, { requestId: event.requestId, phase, serverTick: event.serverTick, cancelled: event.durationMs === 0 });
      for (let i = this.skillVisuals.length - 1; i >= 0; i--) {
        const visual = this.skillVisuals[i];
        if (visual.event.type === 'skillCast' && visual.event.playerId === event.playerId && visual.event.skillId === event.skillId) {
          visual.sprite?.destroy(); this.skillVisuals.splice(i, 1);
        }
      }
      this.stopChannelAudio(event.playerId);
      const frames = phase === 'final' ? set?.keydownend : phase === 'prepare' ? set?.prepare : set?.keydown;
      if (event.durationMs > 0 && frames?.length && frames.every(validFrame)) {
        const visual = this.spawnSkillVisual(event, frames, undefined, event.durationMs);
        if (visual && phase !== 'final') visual.buffSkillId = 2221052;
      }
      if (phase === 'sustain' && event.durationMs > 0) this.channelAudio.set(event.playerId, {
        skillId: 2221052, requestId: event.requestId, startAt: this.clock(), expiresAt: this.clock() + event.durationMs,
      });
      if (event.durationMs > 0 && (phase !== 'sustain' || event.phase === undefined)) {
        this.playSkillSound(event.playerId, phase === 'final' ? this.skillSounds?.['2221052']?.end?.url : this.skillSounds?.['2221052']?.use?.url);
      }
      return true;
    }
    if (event.skillId === 2221054) {
      const set = this.skillEffects?.['2221054'];
      for (let i = this.skillVisuals.length - 1; i >= 0; i--) {
        const visual = this.skillVisuals[i];
        if (visual.event.type === 'skillCast' && visual.event.playerId === event.playerId && visual.event.skillId === event.skillId) {
          visual.sprite?.destroy(); this.skillVisuals.splice(i, 1);
        }
      }
      if (event.durationMs <= 0) {
        this.hyperBarrierCancelled.set(event.playerId, event.requestId);
        this.stopAuraAudio(event.playerId);
        const end = set?.end;
        if (end?.length && end.every(validFrame)) this.spawnSkillVisual(event, end);
        this.playSkillSound(event.playerId, this.skillSounds?.['2221054']?.end?.url);
        return true;
      }
      this.hyperBarrierCancelled.delete(event.playerId);
      // The server emits the same positive cast envelope when the toggle is
      // turned off. Wait for the authoritative player snapshot before playing
      // Use, so a rejected/off transition cannot sound like activation.
      this.pendingBarrierStarts.add(event.playerId);
      const start = set?.start;
      if (start?.length && start.every(validFrame)) {
        const visual = this.spawnSkillVisual(event, start);
        if (visual) visual.buffSkillId = 2221054;
      }
      const repeat = set?.repeat;
      if (repeat?.length && repeat.every(validFrame)) {
        const visual = this.spawnSkillVisual(event, repeat, undefined, event.durationMs);
        if (visual) visual.buffSkillId = 2221054;
      }
      return true;
    }
    // 2221055 is a hidden snapshot summon. Its tiles are created from the
    // authoritative summon entry below; a separate cast envelope must not
    // replay the public vortex's Use cue.
    if (event.skillId === 2221055) return true;
    if (event.skillId === 2221011 && event.durationMs === 0) {
      const audio = this.channelAudio.get(event.playerId);
      if (!audio || !audio.requestId || audio.requestId === event.requestId) this.stopChannelAudio(event.playerId);
      this.playSkillSound(event.playerId, this.skillSounds?.['2221011']?.end?.url);
      for (let i = this.skillVisuals.length - 1; i >= 0; i--) {
        const visual = this.skillVisuals[i];
        if (visual.event.type === 'skillCast' && visual.event.playerId === event.playerId
          && (!visual.event.requestId || visual.event.requestId === event.requestId) && visual.event.skillId === event.skillId) {
          visual.sprite?.destroy(); this.skillVisuals.splice(i, 1);
        }
      }
      const end = this.skillEffects?.[String(event.skillId)]?.keydownend;
      if (end?.length && end.every(validFrame)) this.spawnSkillVisual(event, end);
      return true;
    }
    // A generated ice field reuses skillCast but is not another player cast.
    if (!(event.skillId === 2201009 && event.targetX !== undefined)) this.playSkillSound(event.playerId, this.skillSounds?.[String(event.skillId)]?.use?.url);
    const set = this.skillEffects?.[String(event.skillId)];
    if (event.skillId === 2221011) {
      const prepare = set?.prepare;
      const preparingMs = prepare?.every(validFrame) ? prepare.reduce((sum, frame) => sum + frame.delay, 0) : 0;
      this.stopChannelAudio(event.playerId);
      this.channelAudio.set(event.playerId, { requestId: event.requestId, startAt: this.clock() + preparingMs, expiresAt: this.clock() + event.durationMs });
      if (prepare?.length && preparingMs > 0) this.spawnSkillVisual(event, prepare);
      for (const frames of [set?.keydown, set?.keydown0]) if (frames?.length && frames.every(validFrame) && event.durationMs > preparingMs) {
        const held = this.spawnSkillVisual(event, frames, undefined, event.durationMs - preparingMs);
        if (held) held.startedAtMs += preparingMs;
      }
    }
    if (event.skillId === 2201009 && set?.tile?.length && event.durationMs > 0
      && validPoint(event.targetX ?? NaN, event.targetY ?? NaN)) {
      const frames = set.tile.filter(frame => frame.source?.includes('/tile/1/'));
      if (frames.length && frames.every(validFrame)) {
        // P: repeat source tiles along the server's temporary field segment.
        const count = Math.min(64, Math.max(1, Math.ceil(Math.hypot(event.targetX! - event.x, event.targetY! - event.y) / frames[0].width)));
        for (let i = 0; i <= count; i++) this.spawnSkillVisual({ ...event,
          x: event.x + (event.targetX! - event.x) * i / count,
          y: event.y + (event.targetY! - event.y) * i / count,
        }, frames, undefined, event.durationMs);
      }
    }
    if (event.skillId >= 2220000 && set?.effect0?.length && set.effect0.every(validFrame)) this.spawnSkillVisual(event, set.effect0);
    if (set?.effect?.length && set.effect.every(validFrame)) this.spawnSkillVisual(event, set.effect);
    if (event.skillId === 2221007 && set?.tile?.length) {
      const variants = sourceVariants(set.tile, 'tile');
      // P: cover the source 800px area at tile.effectDistance=260 spacing.
      // Each source variant is a separate falling ice animation, not 213 frames in sequence.
      for (let i = 0; i < 4; i++) {
        const frames = variants[i % variants.length];
        if (frames.length && frames.every(validFrame)) this.spawnSkillVisual({ ...event, x: event.x - 390 + i * 260 }, frames);
      }
    }
    // The server may provide the authoritative destination for a projectile.
    // Without it, keep the source cast aura and do not invent a hit location.
    const rawBall = this.skillEffects?.[`${event.skillId}:${event.skillLevel}`]?.ball ?? set?.ball;
    const ball = event.skillId === 2221006 && rawBall ? sourceVariants(rawBall, 'ball')[0] : rawBall;
    if (ball?.length && ball.every(validFrame) && validPoint(event.targetX ?? NaN, event.targetY ?? NaN)) {
      this.spawnSkillVisual(event, ball, {
        fromX: event.x, fromY: event.y, toX: event.targetX!, toY: event.targetY!,
      });
    }
    return true;
  }

  syncSummons(entries?: SummonState[]) {
    if (this.summonSnapshot === entries) return;
    this.summonSnapshot = entries;
    const now = this.clock();
    const present = new Set<string>();
    for (const state of entries ?? []) {
      const set = this.skillEffects?.[String(state.skillId)];
      if (state.skillId === 2221055 && state.id && validPoint(state.x, state.y) && validFacing(state.facing) && Number.isFinite(state.expiresInMs) && state.expiresInMs > 0) {
        present.add(state.id);
        this.sourceSummons.set(state.id, { playerId: state.playerId, skillId: state.skillId, expiresAt: now + state.expiresInMs });
        for (const visual of this.skillVisuals) if (visual.sourceSummonId === state.id && visual.event.type === 'skillCast') {
          visual.event.x = state.x; visual.event.y = state.y; visual.event.facing = state.facing;
        }
        if (!this.skillVisuals.some(visual => visual.sourceSummonId === state.id)) {
          for (const group of ['tile0', 'tile'] as const) for (const frames of sourceVariants(set?.[group] ?? [], group)) {
            if (!frames.length || !frames.every(validFrame)) continue;
            const visual = this.spawnSkillVisual({ type: 'skillCast', eventId: state.id, requestId: '', playerId: state.playerId,
              skillId: state.skillId, serverTick: 0, x: state.x, y: state.y, facing: state.facing, durationMs: state.expiresInMs }, frames, undefined, state.expiresInMs);
            if (visual) visual.sourceSummonId = state.id;
          }
        }
        continue;
      }
      const frames = set?.summonStand ?? (state.skillId === 2221012 ? set?.ball : undefined);
      if (!state.id || !validPoint(state.x, state.y) || !validFacing(state.facing)
        || !Number.isFinite(state.expiresInMs) || state.expiresInMs <= 0 || !frames?.length || !frames.every(validFrame)) continue;
      present.add(state.id);
      const current = this.summons.get(state.id);
      if (current) {
        current.fromX = current.x; current.fromY = current.y;
        current.updatedAt = now; current.expiresAt = now + state.expiresInMs;
        if (current.state.skillId !== state.skillId) current.startedAt = now;
        current.state = state;
      } else {
        this.summons.set(state.id, { state, startedAt: now, updatedAt: now, expiresAt: now + state.expiresInMs,
          fromX: state.x, fromY: state.y, x: state.x, y: state.y });
      }
    }
    for (const id of this.sourceSummons.keys()) if (!present.has(id)) this.finishSourceSummon(id, true);
    for (let i = this.skillVisuals.length - 1; i >= 0; i--) {
      const visual = this.skillVisuals[i];
      if (visual.sourceSummonId && !present.has(visual.sourceSummonId)) { visual.sprite?.destroy(); this.skillVisuals.splice(i, 1); }
    }
    for (const [id, summon] of this.summons) if (!present.has(id)) { summon.sprite?.destroy(); this.summons.delete(id); }
  }

  syncPlayers(players?: PlayerState[]) {
    if (this.playerSnapshot === players) return;
    this.playerSnapshot = players;
    this.playerStates = new Map((players ?? []).map(player => [player.id, player]));
    const endingAuraOwners = new Set<string>();
    for (const [owner, sound] of this.auraAudio) {
      const player = this.playerStates.get(owner);
      if (player && player.hp > 0 && !player.derivedStats?.hyperBarrierActive) endingAuraOwners.add(owner);
      if (!player || player.hp <= 0 || !player.derivedStats?.hyperBarrierActive) {
        sound.destroy(); this.auraAudio.delete(owner);
      }
    }
    const auraKey = this.skillSounds?.['2221054']?.loop?.url;
    if (auraKey && this.scene.cache.audio.exists(auraKey)) for (const player of players ?? []) {
      if (player.hp <= 0 || !player.derivedStats?.hyperBarrierActive || this.hyperBarrierCancelled.has(player.id) || this.auraAudio.has(player.id)) continue;
      if (this.pendingBarrierStarts.delete(player.id)) this.playSkillSound(player.id, this.skillSounds?.['2221054']?.use?.url);
      const sound = this.scene.sound.add(auraKey);
      if (sound.play({ loop: true, volume: 0.2 })) this.auraAudio.set(player.id, sound); else sound.destroy();
    }
    for (const player of players ?? []) if (player.hp <= 0 || !player.derivedStats?.hyperBarrierActive) this.pendingBarrierStarts.delete(player.id);
    for (const owner of this.channelAudio.keys()) {
      const player = this.playerStates.get(owner);
      if (!player || player.hp <= 0 || (player.derivedStats?.skillBuffs?.[String(this.channelAudio.get(owner)?.skillId ?? 2221011)] ?? 0) <= 0) this.stopChannelAudio(owner);
    }
    for (let i = this.skillVisuals.length - 1; i >= 0; i--) {
      const visual = this.skillVisuals[i];
      if (!visual.buffSkillId || visual.event.type !== 'skillCast') continue;
      const player = this.playerStates.get(visual.event.playerId);
      if (!player || player.hp <= 0 || (visual.buffSkillId === 2221054 ? !player.derivedStats?.hyperBarrierActive : (player.derivedStats?.skillBuffs?.[String(visual.buffSkillId)] ?? 0) <= 0)
        || (INFINITY_SKILLS.includes(visual.buffSkillId) && !player.derivedStats?.infinityEnhanced)) {
        if (visual.buffSkillId === 2221054 && player && player.hp > 0 && !player.derivedStats?.hyperBarrierActive) endingAuraOwners.add(player.id);
        visual.sprite?.destroy(); this.skillVisuals.splice(i, 1);
      }
    }
    for (const owner of endingAuraOwners) {
      const player = this.playerStates.get(owner);
      const end = this.skillEffects?.['2221054']?.end;
      if (player && end?.length && end.every(validFrame)) this.spawnSkillVisual({ type: 'skillCast', eventId: `hyper-barrier-end-${owner}-${this.clock()}`, requestId: '',
        playerId: owner, skillId: 2221054, serverTick: 0, x: player.x, y: player.y, facing: player.facing, durationMs: 0 }, end);
      this.playSkillSound(owner, this.skillSounds?.['2221054']?.end?.url);
    }
    for (const player of players ?? []) for (const skillId of [2221052, 2221054]) {
      const remaining = skillId === 2221054 ? (player.derivedStats?.hyperBarrierActive ? 60_000 : 0) : player.derivedStats?.skillBuffs?.['2221052'] ?? 0;
      const frames = skillId === 2221054 ? this.skillEffects?.['2221054']?.repeat : this.skillEffects?.['2221052']?.keydown;
      const phase = skillId === 2221052 ? this.hyperThunderPhases.get(`${player.id}:2221052`) : undefined;
      if (player.hp <= 0 || remaining <= 0 || !frames?.length || !frames.every(validFrame)
        || (skillId === 2221054 && this.hyperBarrierCancelled.has(player.id))
        || phase?.cancelled || phase?.phase === 'prepare' || phase?.phase === 'final'
        || this.skillVisuals.some(visual => visual.buffSkillId === skillId && visual.event.type === 'skillCast' && visual.event.playerId === player.id)) continue;
      const visual = this.spawnSkillVisual({ type: 'skillCast', eventId: `hyper-${player.id}-${skillId}`, requestId: '',
        playerId: player.id, skillId, serverTick: 0, x: player.x, y: player.y, facing: player.facing, durationMs: remaining }, frames, undefined, remaining);
      if (visual) visual.buffSkillId = skillId;
      if (skillId === 2221052 && !this.channelAudio.has(player.id)) this.channelAudio.set(player.id, {
        skillId, requestId: '', startAt: this.clock(), expiresAt: this.clock() + remaining,
      });
    }
    const channelFrames = this.skillEffects?.['2221011']?.keydown;
    if (channelFrames?.length && channelFrames.every(validFrame)) for (const player of players ?? []) {
      const remaining = player.derivedStats?.skillBuffs?.['2221011'] ?? 0;
      if (player.hp <= 0 || remaining <= 0 || this.skillVisuals.some(visual => visual.event.type === 'skillCast'
        && visual.event.playerId === player.id && visual.event.skillId === 2221011)) continue;
      // A newly joined observer receives the ongoing hold in the snapshot.
      for (const heldFrames of [channelFrames, this.skillEffects?.['2221011']?.keydown0]) {
        if (!heldFrames?.length || !heldFrames.every(validFrame)) continue;
        const visual = this.spawnSkillVisual({ type: 'skillCast', eventId: `hold-${player.id}`, requestId: '',
          playerId: player.id, skillId: 2221011, serverTick: 0, x: player.x, y: player.y, facing: player.facing,
          durationMs: remaining }, heldFrames, undefined, remaining);
        if (visual) visual.buffSkillId = 2221011;
      }
      if (!this.channelAudio.has(player.id)) this.channelAudio.set(player.id, {
        requestId: '', startAt: this.clock(), expiresAt: this.clock() + remaining,
      });
    }
    // 無限的持续特效逐本查：三条分支各有一本（2221004 / 2121004 / 2321004），
    // 一个角色只可能有一本在计时，所以「哪一本的 `special` 有帧、且它的增益在册」
    // 就是唯一判据。改前写死 2221004 ⇒ 火毒／主教玩家的無限完全没有持续特效。
    for (const infinitySkillId of INFINITY_SKILLS) {
      const frames = this.skillEffects?.[String(infinitySkillId)]?.special;
      if (!frames?.length || !frames.every(validFrame)) continue;
      for (const player of players ?? []) {
        const remaining = player.derivedStats?.skillBuffs?.[String(infinitySkillId)] ?? 0;
        if (player.hp <= 0 || !player.derivedStats?.infinityEnhanced || remaining <= 0
          || this.skillVisuals.some(visual => visual.buffSkillId === infinitySkillId && visual.event.type === 'skillCast' && visual.event.playerId === player.id)) continue;
        const visual = this.spawnSkillVisual({ type: 'skillCast', eventId: `infinity-${player.id}`, requestId: '',
          playerId: player.id, skillId: infinitySkillId, serverTick: 0, x: player.x, y: player.y, facing: player.facing,
          durationMs: remaining }, frames, undefined, remaining);
        if (visual) visual.buffSkillId = infinitySkillId;
      }
    }
  }

  /** Advance source afterimage timing, opacity and per-frame origins. */
  update(time = this.clock()) {
    for (const [id, summon] of this.sourceSummons) if (time >= summon.expiresAt) this.finishSourceSummon(id, true);
    for (const [owner, audio] of this.channelAudio) {
      if (time >= audio.expiresAt) { this.stopChannelAudio(owner); continue; }
      const key = this.skillSounds?.[String(audio.skillId ?? 2221011)]?.loop?.url;
      if (!audio.sound && time >= audio.startAt && key && this.scene.cache.audio.exists(key)) {
        audio.sound = this.scene.sound.add(key);
        if (!audio.sound.play({ loop: true, volume: 0.28 })) this.stopChannelAudio(owner);
      }
    }
    for (const [id, summon] of this.summons) {
      if (time >= summon.expiresAt) { summon.sprite?.destroy(); this.summons.delete(id); continue; }
      const set = this.skillEffects?.[String(summon.state.skillId)];
      const attacking = summon.attackAt !== undefined && time - summon.attackAt < (set?.summonAttack?.reduce((sum, frame) => sum + frame.delay, 0) ?? 0);
      const moving = !summon.state.stationary && Math.hypot(summon.state.x - summon.fromX, summon.state.y - summon.fromY) > 1;
      const frames = (attacking ? set?.summonAttack : moving ? set?.summonMove : undefined) ?? set?.summonStand ?? (summon.state.skillId === 2221012 ? set?.ball : undefined);
      if (!frames?.length || !frames.every(validFrame)) continue;
      const elapsed = Math.max(0, time - (attacking ? summon.attackAt! : summon.startedAt));
      const frame = frames[frameAt(frames.map(frame => frame.delay), elapsed, true)];
      if (!frame) continue;
      // P: interpolate the server's positions over its existing 50ms snapshot cadence.
      const progress = Math.min(1, Math.max(0, time - summon.updatedAt) / 50);
      summon.x = summon.fromX + (summon.state.x - summon.fromX) * progress;
      summon.y = summon.fromY + (summon.state.y - summon.fromY) * progress;
      const left = summon.state.facing === 1 ? summon.x - frame.x - frame.width : summon.x + frame.x;
      // 纹理没进缓存 ⇒ 这一帧连贴图都不建（`spriteFor` 返回 undefined）。召唤物是
      // 快照驱动、每帧都会走到这里，所以「晚一两帧出现」是自愈的。
      const sprite = this.spriteFor(frame.url, summon.sprite);
      if (!sprite) continue;
      summon.sprite = sprite;
      sprite.setTexture(frame.url).setVisible(true).setPosition(Math.round(left), Math.round(summon.y + frame.y)).setFlipX(summon.state.facing === 1);
    }
    const afterimage = this.assets?.attack?.afterimage;
    if (afterimage) {
      for (let i = this.slashes.length - 1; i >= 0; i--) {
        const slash = this.slashes[i];
        const elapsed = time - slash.startedAtMs - afterimage.startMs;
        if (elapsed < 0) {
          slash.sprite?.setVisible(false);
          continue;
        }
        const duration = afterimage.frames.reduce((sum, frame) => sum + frame.delay, 0);
        if (elapsed >= duration) {
          slash.sprite?.destroy();
          this.slashes.splice(i, 1);
          continue;
        }
        const index = frameAt(afterimage.frames.map(frame => frame.delay), elapsed, false);
        const frame = afterimage.frames[index];
        if (!frame) continue;
        const sprite = this.spriteFor(frame.url, slash.sprite);
        if (!sprite) continue;
        slash.sprite = sprite;
        sprite.setTexture(frame.url);
        const frameElapsed = elapsed - afterimage.frames.slice(0,index).reduce((sum,frame)=>sum+frame.delay,0);
        sprite.setAlpha(assetFrameAlpha(frame, frameElapsed));
        const left = slash.event.facing === 1 ? slash.event.x - frame.x - frame.width : slash.event.x + frame.x;
        sprite.setVisible(true)
          .setPosition(Math.round(left), Math.round(slash.event.y + frame.y))
          .setFlipX(slash.event.facing === 1);
      }
    }
    for (let i = this.skillVisuals.length - 1; i >= 0; i--) {
      const visual = this.skillVisuals[i];
      const elapsed = time - visual.startedAtMs;
      if (elapsed < 0) continue;
      const duration = visual.frames.reduce((sum, frame) => sum + frame.delay, 0);
      if (elapsed >= (visual.loopMs ?? duration)) {
        visual.sprite?.destroy();
        this.skillVisuals.splice(i, 1);
        continue;
      }
      const frameTime = visual.loopMs ? Math.max(0, elapsed) % duration : Math.max(0, elapsed);
      const index = frameAt(visual.frames.map(frame => frame.delay), frameTime, false);
      const frame = visual.frames[index];
      if (!frame) continue;
      const frameElapsed = frameTime - visual.frames.slice(0, index).reduce((sum, current) => sum + current.delay, 0);
      // 傳說冒險三本（2221053 / 2121053 / 2321053）的施法视觉都跟施法者走，
      // 判据从写死 2221053 收口成表；2221054 冰雪结界是另一条技能，留在表外。
      const owner = visual.event.type === 'skillCast' && (visual.buffSkillId || [...CASTER_ANCHORED_BUFFS, ...HYPER_ADVENTURER_SKILLS, 2221054].includes(visual.event.skillId))
        ? this.playerStates.get(visual.event.playerId) : undefined;
      const base = owner ? { x: owner.x, y: owner.y } : visual.travel
        ? {
          x: visual.travel.fromX + (visual.travel.toX - visual.travel.fromX) * Math.min(1, elapsed / duration),
          y: visual.travel.fromY + (visual.travel.toY - visual.travel.fromY) * Math.min(1, elapsed / duration),
        }
        : { x: visual.event.x, y: visual.event.y };
      const facing = owner?.facing ?? ('facing' in visual.event && validFacing(visual.event.facing) ? visual.event.facing : 1);
      const left = facing === 1 ? base.x - frame.x - frame.width : base.x + frame.x;
      // 首次施法的绿黑格子就出在这里：纹理还在路上时不能把 key 交给 Phaser。
      const sprite = this.spriteFor(frame.url, visual.sprite);
      if (!sprite) continue;
      visual.sprite = sprite;
      sprite.setTexture(frame.url).setAlpha(assetFrameAlpha(frame, frameElapsed)).setVisible(true)
        .setPosition(Math.round(left), Math.round(base.y + frame.y))
        .setFlipX(facing === 1);
    }
  }

  clear() {
    for (const sound of this.auraAudio.values()) sound.destroy();
    this.auraAudio.clear();
    for (const owner of this.channelAudio.keys()) this.stopChannelAudio(owner);
    for (const id of this.sourceSummons.keys()) this.finishSourceSummon(id, false);
    this.sourceSummons.clear();
    for (const summon of this.summons.values()) summon.sprite?.destroy();
    this.summons.clear(); this.summonSnapshot = undefined;
    this.playerStates.clear(); this.playerSnapshot = undefined;
    this.hyperThunderPhases.clear();
    this.hyperBarrierCancelled.clear();
    this.pendingBarrierStarts.clear();
    for (const sound of this.skillAudio.keys()) sound.destroy();
    this.skillAudio.clear();
    for (const slash of this.slashes) slash.sprite?.destroy();
    this.slashes.length = 0;
    for (const visual of this.skillVisuals) visual.sprite?.destroy();
    this.skillVisuals.length = 0;
    for (const number of this.damageNumbers) {
      this.scene.tweens.killTweensOf(number);
      number.destroy();
    }
    this.damageNumbers.clear();
    this.seen.clear();
  }

  /** Remove only one player's pending spell presentation on death/despawn. */
  clearSkillPlayer(playerId: string) {
    if (!playerId) return;
    this.stopChannelAudio(playerId);
    this.stopAuraAudio(playerId);
    this.hyperThunderPhases.delete(`${playerId}:2221052`);
    this.hyperBarrierCancelled.delete(playerId);
    this.pendingBarrierStarts.delete(playerId);
    for (const [id, summon] of this.sourceSummons) if (summon.playerId === playerId) this.finishSourceSummon(id, false);
    for (const [id, summon] of this.summons) if (summon.state.playerId === playerId) { summon.sprite?.destroy(); this.summons.delete(id); }
    for (const [sound, owner] of this.skillAudio) if (owner === playerId) { sound.destroy(); this.skillAudio.delete(sound); }
    for (let i = this.skillVisuals.length - 1; i >= 0; i--) {
      const visual = this.skillVisuals[i];
      const owner = 'playerId' in visual.event ? visual.event.playerId : visual.event.attackerId;
      if (owner !== playerId) continue;
      visual.sprite?.destroy();
      this.skillVisuals.splice(i, 1);
    }
  }

  destroy() { this.clear(); }

  private stopChannelAudio(owner: string) {
    this.channelAudio.get(owner)?.sound?.destroy();
    this.channelAudio.delete(owner);
  }

  private stopAuraAudio(owner: string) {
    this.auraAudio.get(owner)?.destroy();
    this.auraAudio.delete(owner);
  }

  private finishSourceSummon(id: string, playEnd: boolean) {
    const summon = this.sourceSummons.get(id);
    if (!summon) return;
    this.sourceSummons.delete(id);
    for (let i = this.skillVisuals.length - 1; i >= 0; i--) {
      if (this.skillVisuals[i].sourceSummonId !== id) continue;
      this.skillVisuals[i].sprite?.destroy();
      this.skillVisuals.splice(i, 1);
    }
    const owner = this.playerStates.get(summon.playerId);
    if (playEnd && summon.skillId === 2221055 && owner && owner.hp > 0 && owner.action !== 'dead') {
      this.playSkillSound(summon.playerId, this.skillSounds?.['2221055']?.end?.url);
    }
  }

  private playSkillSound(owner: string | undefined, key: string | undefined) {
    if (!owner || !key || !this.scene.cache.audio.exists(key)) return;
    const sound = this.scene.sound.add(key);
    this.skillAudio.set(sound, owner);
    const remove = () => { this.skillAudio.delete(sound); sound.destroy(); };
    sound.once('complete', remove);
    if (!sound.play({ volume: 0.28 })) remove();
  }

  private spawnDamageNumber(event: AuthoritativeDamageEvent) {
    const sets = this.assets?.damageNumbers;
    const critical = Boolean(event.critical && sets?.critical);
    // 魔心防禦：被护罩接下、由 MP 承受的那一份是**同一击的第二根数字**，走蓝字。
    // 取舍口径与事件入口共用 `damageNumberLayers`（HP 为 0 时蓝字上移到红字那一行，
    // 免得头顶空出一截）；服务端没开魔心时这个字段是 0，不画。
    for (const layer of damageNumberLayers(event.damage, Math.round(event.mpDamage ?? 0))) {
      if (layer.kind === 'damage') {
        const set = critical ? sets?.critical : sets?.normal;
        if (set) this.spawnNumber(event.x, event.y, layer.value, set, Boolean(event.critical), Boolean(sets?.critical));
      } else if (sets?.recoverMp) {
        this.spawnNumber(event.x, event.y + layer.offsetY, layer.value, sets.recoverMp, false, false);
      }
    }
  }

  /**
   * 一次权威恢复：绿字回血、蓝字回魔，两者可以同时出现（坐椅子、魔力激发）。
   *
   * 触发时机与数值全部来自服务端：这里只在收到事件时画，并且画的是事件里那个
   * **实际增加量**——顶到上限时它小于技能/道具声明值，跳字要跟实际一致。
   */
  receiveRecoveryEvent(event: RecoveryEvent) {
    if (!event.eventId || !event.playerId || !Number.isFinite(event.serverTick) || !validPoint(event.x, event.y)) return;
    const id = `recovery:${event.eventId}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    const sets = this.assets?.damageNumbers;
    const hp = Math.round(event.hp ?? 0);
    const mp = Math.round(event.mp ?? 0);
    if (hp > 0 && sets?.recoverHp) this.spawnNumber(event.x, event.y, hp, sets.recoverHp, false, false);
    if (mp > 0 && sets?.recoverMp) {
      this.spawnNumber(event.x, event.y + (hp > 0 ? 20 : 0), mp, sets.recoverMp, false, false);
    }
  }

  /**
   * 画一串源数字。`set` 决定花色（红=伤害/暴击、绿=回血、蓝=回魔/扣魔）；`critical`
   * 只参与字距计算——暴击的基线是源里加宽过的那一档，与花色无关。
   *
   * 全部数字共用同一个容器集合（`damageNumbers`），它们同生共死，清理时一起销毁。
   */
  private spawnNumber(x: number, y: number, value: number, set: DamageNumberSet, critical: boolean, hasCriticalSet: boolean) {
    const digits = String(value);
    if (!/^\d+$/.test(digits) || value <= 0) return;

    const frames = [...digits].map((digit, index) => set[index === 0 ? 'first' : 'rest'][digit]);
    if (frames.some(frame => !validFrame(frame))) return;
    const advances = damageNumberAdvances(digits, critical, hasCriticalSet);
    const container = this.scene.add.container(Math.round(x), Math.round(y - 8)).setDepth(this.depth + 1);
    let cursor = -advances.reduce((sum, advance) => sum + advance, 0) / 2;
    frames.forEach((frame, index) => {
      const image = this.scene.add.image(0, 0, frame.url).setOrigin(0);
      const restIndex = index - 1;
      image.setPosition(Math.round(cursor + frame.x), Math.round(frame.y + (index > 0 ? (restIndex % 2 ? -2 : 2) : 0)));
      container.add(image);
      cursor += advances[index];
    });
    this.damageNumbers.add(container);
    this.scene.tweens.add({
      targets: container,
      y: container.y - 35,
      alpha: 0,
      duration: 650,
      ease: 'Sine.easeOut',
      onComplete: () => {
        this.damageNumbers.delete(container);
        container.destroy();
      },
    });
  }

  private spawnSkillHit(event: AuthoritativeDamageEvent) {
    if (event.skillId === undefined || !validPoint(event.x, event.y)) return;
    const effects = this.skillEffects?.[String(event.skillId)];
    // 2221052.special is a separate source-backed terminal tree, but the
    // protocol has no selector distinguishing it from a normal pulse hit.
    // Keep it exported/preloaded and wait for an authoritative event marker;
    // do not guess from caster or target coordinates.
    let frames = this.skillEffects?.[`${event.skillId}:${event.skillLevel}`]?.hit ?? effects?.hit;
    if (event.skillId === 2220014 && frames?.length) {
      const variants = sourceVariants(frames, 'hit');
      const variant = [...event.targetId].reduce((sum, char) => sum + char.charCodeAt(0), 0) % variants.length;
      frames = variants[variant];
    }
    if (!frames?.length || !frames.every(validFrame)) return;
    this.spawnSkillVisual(event, frames);
  }

  /**
   * 贴图工厂：**key 不在纹理缓存里就不建对象**。
   *
   * `add.image(0, 0, key)` 与 `setTexture(key)` 拿到一个不存在的 key 时会落到
   * Phaser 的 `__MISSING` 占位图——那正是「魔灵弹」「首次释放必有奇怪的黑色 绿色框」
   * 的来源（控制台同时打一条 `Texture key not found: /assets/…png`）。
   *
   * 全仓其它按需装载的地方都是**先判就绪再建对象**（`player/view.ts` 的部件过滤、
   * `notice/tombstone.ts`、`windbell/scene.ts`、`world.ts` 的预装载跳过），只有战斗表现
   * 这一处漏了。所以判据必须**先于**建对象：拿不到就返回 `undefined`，调用方跳过这一帧
   * ——这正是 `assets/lazy-texture.ts` 的约定（`false` ＝「这一帧先别画」，下一帧自然重试）。
   *
   * 时间轴不受影响：`startedAtMs` 在入队那一刻就定了，纹理晚到只是少画开头几帧，
   * 不会把整段动画推后，也不会像「整段不画」那样把这次施法吞掉。
   */
  private spriteFor(url: string, existing?: Phaser.GameObjects.Image): Phaser.GameObjects.Image | undefined {
    if (existing) return existing;
    if (!this.scene.textures.exists(url)) return undefined;
    return this.scene.add.image(0, 0, url).setOrigin(0).setDepth(this.depth).setVisible(false);
  }

  private spawnSkillVisual(event: SkillCastEvent | AuthoritativeDamageEvent, frames: AssetFrame[], travel?: SkillVisual['travel'], loopMs?: number) {
    const first = frames[0];
    if (!first) return;
    // 兜底：召唤物/硬编码分支直接走到这里，未必经过 `receive()` 的入口入队。
    // 同一条 URL 重复请求是幂等的（lazy-texture 自去重），所以这里可以放心冗余。
    ensureTextures(this.scene, frames.map(frame => frame.url));
    // 这里**不建贴图**：纹理可能还在路上（`ensureTextures` 刚返回 `false`），
    // 见 `spriteFor()`。贴图由 `update()` 在纹理落地后的第一帧补建。
    const visual: SkillVisual = { event, frames, startedAtMs: this.clock(), travel, loopMs };
    this.skillVisuals.push(visual);
    return visual;
  }
}
