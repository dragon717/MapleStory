import Phaser from 'phaser';
import type { Point } from '../../assets/manifest';

/**
 * Planar (side-view) interactive water for the Phaser client.
 *
 * Scope follows `docs/plan/topics/Web_TS_2D_Water_Development_Plan.md` sections 5-9 while
 * staying inside this project's own stack: the plan's demo targets
 * Three.js + Rapier, but this game already renders with Phaser and keeps
 * every gameplay position on the authoritative Rust server. So only the
 * simulation core is ported — `WaterSurface` (one height field, the single
 * source of truth for the water line), submerged-draft buoyancy
 * (`FloatingBodies`) and pooled splash droplets. Players and drop anchors
 * stay server-owned; the client only adds waves, splashes, bobbing and tilt.
 *
 * P adaptation: the pool itself, the fixed resting draft, the tuning numbers
 * and the waterline visuals are user-approved project rules, not verified
 * TMS273 data. Nothing here changes authoritative positions.
 */

export interface WaterZone {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  floor?: Point[];
}

export interface AmbientWave {
  /** Peak displacement in pixels. */
  amplitude: number;
  /** Spatial wavelength in pixels. */
  wavelength: number;
  /** Phase speed in px/s. */
  speed: number;
  phase?: number;
}

export interface WaterTuning {
  /** Target width of one surface cell in pixels. */
  cellWidth: number;
  minCells: number;
  maxCells: number;
  /** Propagation speed of the height field, px/s. */
  waveSpeed: number;
  /** Restoring rate pulling the surface back to the base level, 1/s. */
  restoringOmega: number;
  /** Velocity damping, 1/s. */
  damping: number;
  /** Safety clamp for the interactive displacement, pixels. */
  maxDisplacement: number;
  /** Equivalent participating depth used to convert an impulse into velocity. */
  effectiveDepth: number;
  /** Converts `entry speed × contact width` into surface momentum. */
  splashGain: number;
  /** Hard clamp on the velocity a single splash may add to one node, px/s. */
  maxSplashSpeed: number;
  ambient: AmbientWave[];
  /** Icon pixels below the surface at rest (P: fixed draft, not a density solve). */
  floatDraft: number;
  /** Buoyancy spring rate towards the resting draft, 1/s². */
  floatStiffness: number;
  /** Buoyancy damping, 1/s. */
  floatDamping: number;
  /** How strongly a floating icon follows the local surface slope, 0..1. */
  tiltGain: number;
}

export const WATER_TUNING: WaterTuning = {
  cellWidth: 12,
  minCells: 16,
  maxCells: 96,
  waveSpeed: 210,
  restoringOmega: 5.5,
  damping: 1.6,
  maxDisplacement: 9,
  effectiveDepth: 26,
  splashGain: 1.2,
  maxSplashSpeed: 90,
  ambient: [
    { amplitude: 1.1, wavelength: 96, speed: 38 },
    { amplitude: 0.6, wavelength: 47, speed: 26, phase: 1.7 },
  ],
  floatDraft: 12,
  floatStiffness: 46,
  floatDamping: 9,
  tiltGain: 0.55,
};

const FIXED_DT = 1 / 120;
const MAX_STEPS = 8;

function floorAtZone(zone: WaterZone, x: number): number {
  const floor = zone.floor;
  if (!floor?.length) return zone.yMax;
  if (x <= floor[0].x) return floor[0].y;
  const last = floor[floor.length - 1];
  if (x >= last.x) return last.y;
  for (let i = 0; i < floor.length - 1; i++) {
    const a = floor[i];
    const b = floor[i + 1];
    if (x >= a.x && x <= b.x) {
      const span = b.x - a.x;
      return span <= 0 ? b.y : a.y + ((b.y - a.y) * (x - a.x)) / span;
    }
  }
  return zone.yMax;
}

/**
 * One-dimensional height field over `[xMin, xMax]`.
 *
 * `H(x, t) = yMin + ambient(x, t) + eta(x, t)`, with `eta` positive pointing
 * down (larger world y), matching the server's "y grows downwards" foothold
 * space. Buoyancy, splash detection and rendering all read this one field —
 * no consumer keeps its own water line.
 */
export class WaterSurface {
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly cellCount: number;
  readonly dx: number;
  private readonly zone: WaterZone;
  private readonly eta: Float32Array;
  private readonly velocity: Float32Array;
  private readonly acceleration: Float32Array;
  private readonly floorSamples: Float32Array;
  private readonly bed: Point[];
  private readonly tuning: WaterTuning;
  private time = 0;
  private accumulator = 0;

  constructor(zone: WaterZone, tuning: WaterTuning = WATER_TUNING, cellCount = 0) {
    const width = Math.max(1, zone.xMax - zone.xMin);
    this.tuning = tuning;
    this.zone = zone;
    this.xMin = zone.xMin;
    this.xMax = zone.xMax;
    this.yMin = zone.yMin;
    this.yMax = zone.yMax;
    const requested = cellCount > 0
      ? cellCount
      : Math.round(width / Math.max(1, tuning.cellWidth));
    this.cellCount = Math.max(tuning.minCells, Math.min(tuning.maxCells, requested));
    this.dx = width / this.cellCount;
    const nodes = this.cellCount + 1;
    this.eta = new Float32Array(nodes);
    this.velocity = new Float32Array(nodes);
    this.acceleration = new Float32Array(nodes);
    this.floorSamples = new Float32Array(nodes);
    this.bed = [];
    for (let i = 0; i < nodes; i++) {
      const x = this.nodeX(i);
      this.floorSamples[i] = floorAtZone(zone, x);
      this.bed.push({ x, y: this.floorSamples[i] });
    }
  }

  get elapsed() { return this.time; }

  nodeX(index: number): number { return this.xMin + index * this.dx; }

  nodeEta(index: number): number { return this.eta[index] ?? 0; }

  /** Absolute world y of the surface at one node, ambient included. */
  nodeHeight(index: number): number {
    const x = this.nodeX(index);
    return this.yMin + this.ambientAt(x) + (this.eta[index] ?? 0);
  }

  floorAt(x: number): number { return floorAtZone(this.zone, x); }

  /** Bed samples from left to right, one per node; the shape never changes. */
  floorPoints(): readonly Point[] { return this.bed; }

  private ambientAt(x: number): number {
    let sum = 0;
    for (const wave of this.tuning.ambient) {
      if (wave.wavelength <= 0) continue;
      const k = (Math.PI * 2) / wave.wavelength;
      sum += wave.amplitude * Math.sin(k * x - k * wave.speed * this.time + (wave.phase ?? 0));
    }
    return sum;
  }

  private ambientSlopeAt(x: number): number {
    let sum = 0;
    for (const wave of this.tuning.ambient) {
      if (wave.wavelength <= 0) continue;
      const k = (Math.PI * 2) / wave.wavelength;
      sum += wave.amplitude * k * Math.cos(k * x - k * wave.speed * this.time + (wave.phase ?? 0));
    }
    return sum;
  }

  /** Surface y in world space, or `null` outside the zone (never a fake edge value). */
  surfaceAt(x: number): number | null {
    if (!Number.isFinite(x) || x < this.xMin || x > this.xMax) return null;
    const t = (x - this.xMin) / this.dx;
    const index = Math.min(this.cellCount - 1, Math.max(0, Math.floor(t)));
    const frac = Math.min(1, Math.max(0, t - index));
    const eta = this.eta[index] * (1 - frac) + this.eta[index + 1] * frac;
    return this.yMin + this.ambientAt(x) + eta;
  }

  /** dH/dx at `x`; positive means the surface falls towards +x. */
  slopeAt(x: number): number {
    if (!Number.isFinite(x) || x < this.xMin || x > this.xMax) return 0;
    const t = (x - this.xMin) / this.dx;
    const index = Math.min(this.cellCount - 1, Math.max(0, Math.floor(t)));
    const etaSlope = (this.eta[index + 1] - this.eta[index]) / this.dx;
    return etaSlope + this.ambientSlopeAt(x);
  }

  contains(x: number, y: number): boolean {
    const surface = this.surfaceAt(x);
    return surface !== null && y >= surface - 1 && y <= this.floorAt(x) + 1;
  }

  /**
   * Distributes one vertical impulse over the nodes covered by `width`.
   * `alpha` weights sum to 1 and the per-node mass is `effectiveDepth * dx`,
   * so the injected momentum does not grow when the grid gets finer.
   */
  splash(x: number, speed: number, width: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(speed) || !Number.isFinite(width)) return;
    const magnitude = Math.max(0, speed) * Math.max(1, width) * this.tuning.splashGain;
    if (magnitude <= 0) return;
    const half = Math.max(this.dx, width) / 2;
    const first = Math.max(0, Math.ceil((x - half - this.xMin) / this.dx));
    const last = Math.min(this.cellCount, Math.floor((x + half - this.xMin) / this.dx));
    let total = 0;
    const weights: number[] = [];
    for (let i = first; i <= last; i++) {
      const distance = Math.abs(this.nodeX(i) - x) / half;
      const weight = distance >= 1 ? 0 : Math.cos((distance * Math.PI) / 2);
      weights.push(weight);
      total += weight;
    }
    if (total <= 0) return;
    const mass = this.tuning.effectiveDepth * this.dx;
    for (let i = first, w = 0; i <= last; i++, w++) {
      const delta = (weights[w] / total) * (magnitude / mass);
      const next = this.velocity[i] + Math.min(this.tuning.maxSplashSpeed, delta);
      this.velocity[i] = Number.isFinite(next) ? next : this.velocity[i];
    }
  }

  /** Total surface momentum `∫ v dx`, used to verify grid-independent impulses. */
  momentumIntegral(): number {
    let sum = 0;
    for (let i = 0; i <= this.cellCount; i++) sum += this.velocity[i] * this.dx;
    return sum;
  }

  maxDisplacementNow(): number {
    let peak = 0;
    for (let i = 0; i <= this.cellCount; i++) peak = Math.max(peak, Math.abs(this.eta[i]));
    return peak;
  }

  update(dtSeconds: number): void {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return;
    // Clamp the backlog instead of chasing it: a hidden tab must not replay
    // minutes of simulation on return (plan section 9.3).
    this.accumulator = Math.min(this.accumulator + dtSeconds, FIXED_DT * MAX_STEPS);
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS) {
      this.step(FIXED_DT);
      this.accumulator -= FIXED_DT;
      steps++;
    }
  }

  private step(dt: number): void {
    this.time += dt;
    const { waveSpeed, restoringOmega, damping, maxDisplacement } = this.tuning;
    const c2 = waveSpeed * waveSpeed;
    const w2 = restoringOmega * restoringOmega;
    const dx2 = this.dx * this.dx;
    for (let i = 0; i <= this.cellCount; i++) {
      // Reflective boundaries: the ghost node mirrors its neighbour, so the
      // surface slope at the bank stays zero instead of leaking energy.
      const left = i === 0 ? this.eta[1] : this.eta[i - 1];
      const right = i === this.cellCount ? this.eta[this.cellCount - 1] : this.eta[i + 1];
      this.acceleration[i] = (c2 * (left - 2 * this.eta[i] + right)) / dx2 - w2 * this.eta[i];
    }
    const decay = Math.exp(-damping * dt);
    for (let i = 0; i <= this.cellCount; i++) {
      const v = (this.velocity[i] + this.acceleration[i] * dt) * decay;
      let h = this.eta[i] + v * dt;
      let kept = v;
      if (!Number.isFinite(h) || Math.abs(h) > maxDisplacement) {
        h = Math.max(-maxDisplacement, Math.min(maxDisplacement, Number.isFinite(h) ? h : 0));
        kept = 0;
      }
      this.velocity[i] = kept;
      this.eta[i] = h;
    }
  }
}

export interface FloatingState {
  bottom: number;
  velocity: number;
  tilt: number;
  wet: boolean;
}

export interface FloatResult {
  /** Icon bottom edge in world space after this step. */
  bottom: number;
  /** Radians, positive rotates the icon clockwise on screen. */
  tilt: number;
  /** True on the single frame where a dry body actually crosses the surface. */
  entered: boolean;
}

/**
 * Buoyancy for client-rendered icons (drops).
 *
 * Equilibrium keeps a fixed draft below the surface — the same constant the
 * server uses for the authoritative drop anchor — and approaches it with a
 * damped spring so an item that pops into the pool settles instead of
 * snapping. Heavier-than-water cases (draft deeper than the basin) rest on
 * the floor instead of hovering.
 */
export class FloatingBodies {
  private readonly states = new Map<string, FloatingState>();

  constructor(private readonly tuning: WaterTuning = WATER_TUNING) {}

  get size() { return this.states.size; }

  has(id: string) { return this.states.has(id); }

  forget(id: string) { this.states.delete(id); }

  prune(liveIds: Iterable<string>) {
    const live = liveIds instanceof Set ? liveIds : new Set(liveIds);
    for (const id of [...this.states.keys()]) if (!live.has(id)) this.states.delete(id);
  }

  clear() { this.states.clear(); }

  update(
    id: string,
    centerX: number,
    height: number,
    bottom: number,
    surface: number | null,
    floor: number,
    slope: number,
    dt: number,
    /**
     * True when the body is already floating when we first see it (map load):
     * per plan section 8.2 that must not fabricate an entry splash.
     */
    wetOnRegister = false,
  ): FloatResult | null {
    if (surface === null) {
      this.states.delete(id);
      return null;
    }
    const step = Math.min(0.05, Math.max(0, Number.isFinite(dt) ? dt : 0));
    // Dry: the icon sits above the water line, so no buoyancy is applied.
    if (bottom < surface - 2) {
      this.states.delete(id);
      return null;
    }
    const draft = Math.min(this.tuning.floatDraft, Math.max(2, height * 0.7));
    const target = Math.min(surface + draft, floor);
    const state = this.states.get(id) ?? { bottom, velocity: 0, tilt: 0, wet: wetOnRegister };
    let entered = false;
    if (!state.wet && bottom >= surface + 4) {
      state.wet = true;
      entered = true;
    }
    const { floatStiffness, floatDamping, tiltGain } = this.tuning;
    state.velocity += ((target - state.bottom) * floatStiffness - state.velocity * floatDamping) * step;
    state.bottom += state.velocity * step;
    if (!Number.isFinite(state.bottom)) {
      state.bottom = target;
      state.velocity = 0;
    }
    const tiltTarget = Math.atan(slope) * tiltGain;
    state.tilt += (tiltTarget - state.tilt) * Math.min(1, step * 6);
    this.states.set(id, state);
    return { bottom: state.bottom, tilt: state.tilt, entered };
  }
}

interface Droplet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  ttl: number;
  size: number;
}

const MAX_DROPLETS = 160;
const DROPLET_GRAVITY = 900;
/** Icons seen this soon after the map opens count as already floating. */
const MAP_LOAD_GRACE_SECONDS = 1.2;

/** Phaser renderer + interaction glue for one authored water rectangle. */
export class WaterView {
  readonly surface: WaterSurface;
  private readonly buoyancy: FloatingBodies;
  private readonly body: Phaser.GameObjects.Graphics;
  private readonly overlay: Phaser.GameObjects.Graphics;
  private readonly droplets: Droplet[] = [];
  private readonly inWater = new Set<string>();
  private readonly surfaceBuffer: Phaser.Geom.Point[] = [];
  private readonly basinBuffer: Phaser.Geom.Point[] = [];
  private readonly deepBuffer: Phaser.Geom.Point[] = [];
  private readonly tuning: WaterTuning;
  private nextRippleAt = 0;
  private age = 0;

  /** Depth of the translucent front layer; floating icons sit just under it. */
  static readonly OVERLAY_OFFSET = 0.3;
  constructor(
    private readonly scene: Phaser.Scene,
    zone: WaterZone,
    depth: number,
    tuning: WaterTuning = WATER_TUNING,
    cellCount = 0,
  ) {
    this.tuning = tuning;
    this.surface = new WaterSurface(zone, tuning, cellCount);
    this.buoyancy = new FloatingBodies(tuning);
    // Two passes: an opaque body behind the actors and a translucent one in
    // front, so a swimming avatar reads as being under the water line.
    this.body = scene.add.graphics().setDepth(depth - 0.25);
    this.overlay = scene.add.graphics().setDepth(depth + WaterView.OVERLAY_OFFSET);
    this.draw();
  }

  update(deltaMs: number): void {
    const dt = Math.min(100, Math.max(0, deltaMs)) / 1000;
    this.age += dt;
    this.surface.update(dt);
    this.updateDroplets(dt);
    this.draw();
  }

  surfaceAt(x: number): number | null { return this.surface.surfaceAt(x); }

  floorAt(x: number): number { return this.surface.floorAt(x); }

  contains(x: number, y: number): boolean { return this.surface.contains(x, y); }

  /** Wave impulse plus visible droplets for one entry event. */
  splash(x: number, speed: number, width: number): void {
    this.surface.splash(x, speed, width);
    const count = Math.min(14, Math.max(2, Math.round((Math.abs(speed) / 70) * (Math.max(8, width) / 16))));
    const power = Math.min(1, Math.abs(speed) / 420);
    for (let i = 0; i < count; i++) {
      if (this.droplets.length >= MAX_DROPLETS) break;
      const side = i % 2 === 0 ? -1 : 1;
      const spread = 0.35 + Math.random() * 0.65;
      this.droplets.push({
        x: x + side * (Math.random() * Math.max(4, width * 0.35)),
        y: (this.surface.surfaceAt(x) ?? this.surface.yMin) - 1,
        vx: side * (40 + 130 * power) * spread,
        vy: -(70 + 240 * power) * spread,
        life: 0,
        ttl: 0.32 + Math.random() * 0.42,
        size: 1.2 + Math.random() * 1.8,
      });
    }
  }

  /**
   * Buoyancy for one drop icon.
   * `bottom` is the icon's authoritative bottom edge in world space; the
   * returned value is where it should be drawn this frame.
   */
  floatFor(id: string, centerX: number, height: number, bottom: number, dt: number): FloatResult | null {
    const surface = this.surface.surfaceAt(centerX);
    const result = this.buoyancy.update(
      id,
      centerX,
      height,
      bottom,
      surface,
      this.surface.floorAt(centerX),
      this.surface.slopeAt(centerX),
      dt,
      // Icons already in the pool when the map opens are wet from the start.
      this.age < MAP_LOAD_GRACE_SECONDS,
    );
    if (result?.entered) {
      this.splash(centerX, 200 + Math.min(260, Math.abs(result.bottom - surface!) * 6), Math.max(12, height));
    }
    return result;
  }

  pruneFloats(liveIds: Iterable<string>) { this.buoyancy.prune(liveIds); }

  /**
   * Tracks one actor against the water column: emits an entry splash and
   * periodic ripples while it moves through the pool. Returns whether the
   * actor is currently in the water.
   */
  noteActor(id: string, x: number, y: number, vx: number, nowMs: number): boolean {
    const surface = this.surface.surfaceAt(x);
    const inside = surface !== null && y >= surface - 6 && y <= this.surface.floorAt(x);
    const was = this.inWater.has(id);
    if (inside && !was) {
      this.splash(x, 420, 46);
    } else if (inside && Math.abs(vx) > 20 && nowMs >= this.nextRippleAt) {
      this.splash(x, 95, 30);
      this.nextRippleAt = nowMs + 170;
    }
    if (inside) this.inWater.add(id);
    else this.inWater.delete(id);
    return inside;
  }

  destroy() {
    this.body.destroy();
    this.overlay.destroy();
    this.droplets.length = 0;
    this.surfaceBuffer.length = 0;
    this.basinBuffer.length = 0;
    this.deepBuffer.length = 0;
    this.buoyancy.clear();
    this.inWater.clear();
  }

  private updateDroplets(dt: number) {
    for (let i = this.droplets.length - 1; i >= 0; i--) {
      const drop = this.droplets[i];
      drop.life += dt;
      drop.vy += DROPLET_GRAVITY * dt;
      drop.x += drop.vx * dt;
      drop.y += drop.vy * dt;
      const surface = this.surface.surfaceAt(drop.x);
      // Droplets die on the shared surface snapshot; they never spawn the
      // next generation of splashes (plan section 8.5).
      if (drop.life >= drop.ttl || (surface !== null && drop.vy > 0 && drop.y >= surface)) {
        this.droplets.splice(i, 1);
      }
    }
  }

  private surfacePoints(): Phaser.Geom.Point[] {
    const required = this.surface.cellCount + 1;
    while (this.surfaceBuffer.length < required) this.surfaceBuffer.push(new Phaser.Geom.Point());
    for (let i = 0; i < required; i++) {
      this.surfaceBuffer[i].setTo(this.surface.nodeX(i), this.surface.nodeHeight(i));
    }
    return this.surfaceBuffer;
  }

  private draw() {
    const nodes = this.surface.cellCount + 1;
    const surface = this.surfacePoints();
    // Reused polygon buffers: the basin polygon is the surface followed by the
    // reversed bed, so the graphics objects never rebuild their input arrays.
    while (this.basinBuffer.length < nodes * 2) this.basinBuffer.push(new Phaser.Geom.Point());
    const floor = this.surface.floorPoints();
    for (let i = 0; i < nodes; i++) {
      this.basinBuffer[i].setTo(surface[i].x, surface[i].y);
      const bed = floor[nodes - 1 - i];
      this.basinBuffer[nodes + i].setTo(bed.x, bed.y);
    }
    const basin = this.basinBuffer;

    this.body.clear();
    this.body.fillStyle(0x2f7f9e, 0.94);
    this.body.fillPoints(basin, true, true);
    // Cheap depth cue: the lower part of the basin is darker.
    const deepY = this.surface.yMin + (this.surface.yMax - this.surface.yMin) * 0.45;
    while (this.deepBuffer.length < nodes + 2) this.deepBuffer.push(new Phaser.Geom.Point());
    this.deepBuffer[0].setTo(this.surface.xMin, deepY);
    this.deepBuffer[1].setTo(this.surface.xMax, deepY);
    for (let i = 0; i < nodes; i++) {
      const bed = floor[nodes - 1 - i];
      this.deepBuffer[i + 2].setTo(bed.x, bed.y);
    }
    this.body.fillStyle(0x1d5f7a, 0.35);
    this.body.fillPoints(this.deepBuffer, true, true);

    this.overlay.clear();
    this.overlay.fillStyle(0x6fd3e8, 0.28);
    this.overlay.fillPoints(basin, true, true);
    this.overlay.lineStyle(2, 0xd9f7ff, 0.75);
    this.overlay.strokePoints(surface);
    // Crest shimmer is display-only: it never feeds back into the physics.
    this.overlay.lineStyle(2, 0xffffff, 0.22);
    for (let i = 1; i < nodes - 1; i += 2) {
      if (surface[i].y > this.surface.yMin - 0.45) continue;
      this.overlay.lineBetween(surface[i].x - 3, surface[i].y - 2, surface[i].x + 3, surface[i].y - 2);
    }
    for (const drop of this.droplets) {
      const alpha = Math.max(0, 1 - drop.life / drop.ttl);
      this.overlay.fillStyle(0xe8fbff, 0.35 + 0.5 * alpha);
      this.overlay.fillCircle(drop.x, drop.y, drop.size);
    }
  }
}
