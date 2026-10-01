import * as T from 'three';
import east from '../../../../shared/chuxian-east.json';

export type GroundSurface = 'grass' | 'sand' | 'soil' | 'stone' | 'wood';
export type GroundActor = {
  id: string; x: number; y: number; grounded: boolean;
  hp?: number; mount?: unknown; chair?: unknown; climbing?: boolean; action?: string; teleported?: boolean;
  point?: readonly [number, number, number]; surface?: GroundSurface;
};
export type GroundClimate = {moisture: number; snow: number; daylight?: number};
export type GroundStep = {
  actorId: string; x: number; y: number; point: [number, number, number]; direction: [number, number, number];
  mount: boolean; speed: number; surface: GroundSurface; side: -1 | 1; snow: number;
};

/** The model uses stone brick on every current route except the wooden dock. */
export function surfaceForRoute(route: {kind?: string; surface?: GroundSurface; material?: string}): GroundSurface {
  if (route.surface) return route.surface;
  if (route.material === 'grass' || route.material === 'sand' || route.material === 'wood') return route.material;
  if (route.material === 'earth' || route.material === 'soil') return 'soil';
  return route.kind === 'dock' ? 'wood' : 'stone';
}

const PARTICLES = 1024, ACTORS = 48, FRAME_BUDGET = 96, RANGE = 32;
const surfaces: Record<GroundSurface, {dust: number; snow: number; color: readonly number[]}> = {
  grass: {dust: .18, snow: .75, color: [.24, .22, .15]},
  sand: {dust: 1.3, snow: 1.1, color: [.61, .47, .28]},
  soil: {dust: 1.05, snow: 1, color: [.34, .23, .14]},
  stone: {dust: .62, snow: .9, color: [.49, .43, .34]},
  wood: {dust: .12, snow: .7, color: [.31, .22, .13]},
};
const clamp = (n: number) => Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
type Track = {id: string; point: [number, number, number]; at: number; distance: number; last: number; speed: number; side: -1 | 1; eligible: boolean; mount: boolean; selected: boolean};

/** Fixed GPU pool: CPU work only finds nearby feet and writes new births. */
export class GroundFeedback {
  private tracks: Track[] = Array.from({length: ACTORS}, () => ({id: '', point: [0, 0, 0], at: 0, distance: 0, last: 0, speed: 0, side: 1, eligible: false, mount: false, selected: false}));
  private selected = new Int32Array(ACTORS);
  private selectedDistance = new Float64Array(ACTORS);
  private selectedTracks = new Int32Array(ACTORS);
  private scratch: [number, number, number] = [0, 0, 0];
  // This event and its tuples are reused. Consumers that retain a step must copy it.
  private step: GroundStep = {actorId: '', x: 0, y: 0, point: [0, 0, 0], direction: [0, 0, 0], mount: false, speed: 0, surface: 'stone', side: 1, snow: 0};
  private positions = new Float32Array(PARTICLES * 3);
  private velocities = new Float32Array(PARTICLES * 3);
  private timing = new Float32Array(PARTICLES * 2);
  private shapes = new Float32Array(PARTICLES * 3);
  private colors = new Float32Array(PARTICLES * 3);
  private attributes: T.BufferAttribute[];
  private points: T.Points<T.BufferGeometry, T.ShaderMaterial>;
  private cursor = 0;
  private seed = 273;
  private lastUpdate = -Infinity;
  private activeUntil = 0;
  private disposed = false;

  constructor(private scene: T.Scene, private onStep?: (step: GroundStep) => void) {
    const geometry = new T.BufferGeometry();
    this.attributes = [new T.BufferAttribute(this.positions, 3), new T.BufferAttribute(this.velocities, 3), new T.BufferAttribute(this.timing, 2), new T.BufferAttribute(this.shapes, 3), new T.BufferAttribute(this.colors, 3)];
    const names = ['position', 'velocity', 'timing', 'shape', 'tint'];
    for (let i = 0; i < names.length; i++) geometry.setAttribute(names[i], this.attributes[i].setUsage(T.DynamicDrawUsage));
    this.points = new T.Points(geometry, new T.ShaderMaterial({
      transparent: true, depthTest: true, depthWrite: false,
      uniforms: {time: {value: 0}, pixelRatio: {value: 1}, viewportHeight: {value: 720}, center: {value: new T.Vector3()}, daylight: {value: 1}},
      vertexShader: `
        uniform float time,pixelRatio,viewportHeight,daylight;
        uniform vec3 center;
        attribute vec3 velocity,shape,tint;
        attribute vec2 timing;
        varying float alpha,grain,flake;
        varying vec3 colour;
        void main(){
          float age=time-timing.x;
          alpha=0.;grain=fract(timing.x*.731+velocity.x*3.17+velocity.z*.81);flake=shape.z;
          colour=tint*mix(.16,1.,daylight);
          if(age<0.||age>=timing.y||shape.y<=0.){gl_Position=vec4(2.,2.,2.,1.);gl_PointSize=1.;return;}
          float life=age/timing.y;
          vec3 p=position+velocity*age;
          p.xz+=vec2(sin(age*4.+grain*13.),cos(age*3.+grain*17.))*.035*life;
          p.y=max(position.y+.012,p.y-mix(.22,.9,flake)*age*age);
          vec4 v=modelViewMatrix*vec4(p,1.);
          gl_Position=projectionMatrix*v;
          gl_PointSize=clamp(shape.x*(1.+life*.9)*pixelRatio*viewportHeight*.5*projectionMatrix[1][1]/max(-v.z,1.),1.,64.);
          alpha=shape.y*smoothstep(0.,.045,age)*(1.-smoothstep(.15,1.,life))*(1.-smoothstep(24.,32.,distance(p,center)));
        }`,
      fragmentShader: `
        varying float alpha,grain,flake;
        varying vec3 colour;
        float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
        float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
        void main(){
          vec2 p=gl_PointCoord*2.-1.;
          float edge=1.-smoothstep(.22,1.,length(p));
          float n=noise(p*3.2+grain*23.);
          float coverage=edge*mix(smoothstep(.13,.72,n),.64+.36*n,flake);
          float a=alpha*coverage;if(a<.004)discard;
          gl_FragColor=vec4(colour,a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }));
    this.points.frustumCulled = false; this.points.visible = false; scene.add(this.points);
    if (typeof window !== 'undefined') window.addEventListener('blur', this.resetTracks);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.visibility);
  }

  private resetTracks = () => {
    for (let i = 0; i < ACTORS; i++) this.tracks[i].id = '';
    this.lastUpdate = -Infinity;
  };
  private visibility = () => { if (document.hidden) this.resetTracks(); };
  private random() { this.seed = (1664525 * this.seed + 1013904223) >>> 0; return this.seed / 4294967296; }

  private sample(actor: GroundActor) {
    // Same shared chart and metre conversion as point3d, written into one reused tuple.
    let route = east.routes[0];
    for (let i = 0; i < east.routes.length; i++) {
      const r = east.routes[i]; if (actor.x >= r.start - 200 && actor.x <= r.end + 200) { route = r; break; }
    }
    if (actor.point) {
      this.scratch[0] = actor.point[0]; this.scratch[1] = actor.point[1]; this.scratch[2] = actor.point[2];
    } else {
      const nodes = route.nodes; let lo = 1, hi = nodes.length - 1;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (actor.x <= nodes[mid].x) hi = mid; else lo = mid + 1; }
      const a = nodes[lo - 1], b = nodes[lo], t = (actor.x - a.x) / (b.x - a.x);
      this.scratch[0] = a.position[0] + (b.position[0] - a.position[0]) * t;
      this.scratch[1] = -actor.y / east.pixelsPerMetre;
      this.scratch[2] = a.position[2] + (b.position[2] - a.position[2]) * t;
    }
    return route;
  }

  update(actors: readonly GroundActor[], climate: GroundClimate, nowMs: number, center: readonly number[], pixelRatio: number, viewportHeight = 720) {
    if (this.disposed || !Number.isFinite(nowMs) || !Number.isFinite(center[0]) || !Number.isFinite(center[1]) || !Number.isFinite(center[2])) return;
    const time = nowMs / 1000, uniforms = this.points.material.uniforms;
    uniforms.time.value = time; uniforms.center.value.set(center[0], center[1], center[2]);
    uniforms.pixelRatio.value = Number.isFinite(pixelRatio) ? Math.max(.5, Math.min(3, pixelRatio)) : 1;
    uniforms.viewportHeight.value = Number.isFinite(viewportHeight) ? Math.max(1, viewportHeight) : 720;
    uniforms.daylight.value = climate.daylight === undefined ? 1 : clamp(climate.daylight);
    if (typeof document !== 'undefined' && (document.hidden || !document.hasFocus())) {
      this.resetTracks(); this.points.visible = false; return;
    }
    if (nowMs - this.lastUpdate > 200 || nowMs <= this.lastUpdate) this.resetTracks();
    this.lastUpdate = nowMs;
    const moisture = clamp(climate.moisture), snow = clamp(climate.snow);
    let count = 0;
    // ponytail: keep the closest 48 actors by bounded insertion; raise this cap only after measuring a crowded village.
    for (let i = 0; i < actors.length; i++) {
      const actor = actors[i];
      if (!actor.id || !Number.isFinite(actor.x) || !Number.isFinite(actor.y)) continue;
      this.sample(actor);
      const dx = this.scratch[0] - center[0], dy = this.scratch[1] - center[1], dz = this.scratch[2] - center[2], d = dx * dx + dy * dy + dz * dz;
      if (!Number.isFinite(d) || d > RANGE * RANGE) continue;
      let slot = count;
      while (slot > 0 && (d < this.selectedDistance[slot - 1] || (d === this.selectedDistance[slot - 1] && actor.id < actors[this.selected[slot - 1]].id))) slot--;
      if (slot >= ACTORS) continue;
      const end = Math.min(count, ACTORS - 1);
      for (let j = end; j > slot; j--) { this.selected[j] = this.selected[j - 1]; this.selectedDistance[j] = this.selectedDistance[j - 1]; }
      this.selected[slot] = i; this.selectedDistance[slot] = d; count = Math.min(ACTORS, count + 1);
    }
    // Protect all retained IDs before reusing any departed actor's slot.
    this.selectedTracks.fill(-1);
    for (let t = 0; t < ACTORS; t++) {
      const track = this.tracks[t]; track.selected = false;
      for (let i = 0; i < count; i++) if (track.id === actors[this.selected[i]].id) { this.selectedTracks[i] = t; track.selected = true; break; }
      if (!track.selected) track.id = '';
    }
    let budget = FRAME_BUDGET, wrote = false;
    for (let i = 0; i < count; i++) {
      const actor = actors[this.selected[i]], route = this.sample(actor), surface = actor.surface ?? surfaceForRoute(route), mounted = Boolean(actor.mount);
      let index = this.selectedTracks[i], fresh = index < 0;
      if (fresh) { index = 0; while (this.tracks[index].id) index++; }
      const track = this.tracks[index], p = this.scratch;
      const eligible = actor.grounded && (actor.hp === undefined || actor.hp > 0) && !actor.chair && !actor.climbing && !actor.teleported && (!actor.action || actor.action === 'walk' || actor.action === 'move' || actor.action === 'run');
      const dt = nowMs - track.at, dx = p[0] - track.point[0], dy = p[1] - track.point[1], dz = p[2] - track.point[2], distance = Math.hypot(dx, dy, dz);
      // Physical metres cross chart changes/ring seams; snaps, air, stale frames and new IDs reset stride debt.
      const valid = !fresh && eligible && track.eligible && track.mount === mounted && dt > 0 && dt <= 200 && distance <= Math.max(1.8, dt * .020) && distance * 1000 / dt <= 20;
      if (valid && distance > 1e-4) {
        const speed = distance * 1000 / dt;
        track.speed = track.speed ? track.speed + (speed - track.speed) * (1 - Math.exp(-dt / 160)) : speed;
        const stride = mounted ? Math.min(2.5, Math.max(1.3, 1 + .17 * track.speed)) : Math.min(1.3, Math.max(.7, .62 + .18 * track.speed));
        track.distance += distance;
        if (track.distance >= stride && nowMs - track.last >= (mounted ? 140 : 180)) {
          // One footfall per frame; discarded distance never becomes a catch-up burst.
          track.distance %= stride; track.last = nowMs; track.side = track.side === 1 ? -1 : 1;
          const horizontal = Math.hypot(dx, dz), ux = horizontal > 1e-5 ? dx / horizontal : 0, uz = horizontal > 1e-5 ? dz / horizontal : 0;
          const offset = (mounted ? .30 : .12) * track.side, step = this.step;
          step.actorId = actor.id; step.x = actor.x; step.y = actor.y; step.mount = mounted; step.speed = track.speed; step.surface = surface; step.side = track.side; step.snow = snow;
          step.point[0] = p[0] - uz * offset; step.point[1] = p[1] + .025; step.point[2] = p[2] + ux * offset;
          step.direction[0] = ux; step.direction[1] = 0; step.direction[2] = uz;
          this.onStep?.(step);
          const material = surfaces[surface], power = (.75 + track.speed * .28) * (mounted ? 1.65 : 1);
          const dust = material.dust * (1 - moisture) * (1 - moisture) * (1 - snow), powder = material.snow * snow * 1.5, amount = dust + powder;
          const wanted = Math.min(24, Math.floor(3 * power * amount + this.random())), emitted = Math.min(budget, wanted);
          for (let n = 0; n < emitted; n++) {
            const flake = this.random() * amount < powder, birth = this.cursor, a = birth * 3, b = birth * 2;
            const lateral = (this.random() - .5) * (.26 + power * .08), rear = this.random() * (.10 + power * .05);
            this.positions[a] = step.point[0] - uz * lateral - ux * rear; this.positions[a + 1] = step.point[1]; this.positions[a + 2] = step.point[2] + ux * lateral - uz * rear;
            const scatter = (this.random() - .5) * (.50 + power * .17), trail = .12 + track.speed * .08;
            this.velocities[a] = -ux * trail - uz * scatter; this.velocities[a + 1] = (flake ? .32 : .22) + this.random() * (.20 + power * .06); this.velocities[a + 2] = -uz * trail + ux * scatter;
            const life = (flake ? .52 : .62) + this.random() * .30;
            this.timing[b] = time; this.timing[b + 1] = life;
            this.shapes[a] = (flake ? .065 : .11) + power * (flake ? .025 : .04); this.shapes[a + 1] = (flake ? .45 : .31) + this.random() * .14; this.shapes[a + 2] = flake ? 1 : 0;
            this.colors[a] = flake ? .80 : material.color[0]; this.colors[a + 1] = flake ? .90 : material.color[1]; this.colors[a + 2] = flake ? .98 : material.color[2];
            this.activeUntil = Math.max(this.activeUntil, time + life); this.cursor = (birth + 1) % PARTICLES;
          }
          budget -= emitted; wrote ||= emitted > 0;
        }
      } else { track.distance = 0; track.speed = 0; track.last = nowMs; }
      if (fresh) track.side = 1;
      track.id = actor.id; track.at = nowMs; track.eligible = eligible; track.mount = mounted;
      track.point[0] = p[0]; track.point[1] = p[1]; track.point[2] = p[2];
    }
    if (wrote) for (let i = 0; i < this.attributes.length; i++) this.attributes[i].needsUpdate = true;
    this.points.visible = time < this.activeUntil;
  }

  destroy() {
    if (this.disposed) return; this.disposed = true;
    if (typeof window !== 'undefined') window.removeEventListener('blur', this.resetTracks);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.visibility);
    this.scene.remove(this.points); this.points.geometry.dispose(); this.points.material.dispose(); this.resetTracks();
  }
}
