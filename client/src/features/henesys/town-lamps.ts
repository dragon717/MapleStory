import * as T from 'three';
import rules from '../../../../shared/town-lamps.json';
import type { Facing, MonsterEmission, NpcTownLampState, TownLampState, Vec3 } from '../../../../shared/protocol';
import { resolveAssetUrl } from '../../assets/resource-url';

export const TOWN_LAMP_GUARD_ID = rules.guard.npcId;
export const TOWN_LAMP_TIERS = rules.tiers;
export type LampActor = { id: string; kind: 'player' | 'npc' | 'monster'; point: Vec3; facing?: Facing; townLamp?: TownLampState | NpcTownLampState; emissive?: MonsterEmission; heightMetres?: number };
/** Same linear RGB, cd and metre cutoff as the actually selected Three light. */
export type LampLightSample = { id: string; position: Vec3; intensity: number; distance: number; color: Vec3; decay: 2 };
type HeldLamp = { group: T.Group; flame: T.Object3D; art?: T.Mesh; fallback: T.Object3D[]; tier: number; kind: 'lantern' | 'torch' | 'emission'; point: T.Vector3 };

/** Lux-like point irradiance before material albedo, exposure or tone mapping.
 *  Three's cutoff is a smooth fade to zero at the maximum distance, not a diameter. */
export function lampIlluminanceAt(point: Vec3, samples: readonly LampLightSample[], blocked?: (from: Vec3, to: Vec3) => boolean): Vec3 {
  const result: Vec3 = [0, 0, 0];
  for (const light of samples) {
    const distanceSquared = (point[0] - light.position[0]) ** 2 + (point[1] - light.position[1]) ** 2 + (point[2] - light.position[2]) ** 2;
    if (distanceSquared >= light.distance ** 2 || blocked?.(light.position, point)) continue;
    // Match Three getDistanceAttenuation (inverse square, squared quartic cutoff).
    const fade = Math.max(0, 1 - (distanceSquared / light.distance ** 2) ** 2) ** 2;
    const illuminance = light.intensity * fade / Math.max(distanceSquared, .01);
    for (let i = 0; i < 3; i++) result[i] += light.color[i] * illuminance;
  }
  return result;
}

/** Hand props are visible for every authoritative holder; only near holders get real lights.
 *  Pool allocation and the paper-doll samples are the same decision. No monster name inference. */
export class TownLamps {
  private root = new T.Group();
  private holders = new Map<string, HeldLamp>();
  private pool = Array.from({ length: 8 }, () => new T.PointLight(0xffbb66, 0, 3, 2));
  private cube = new T.BoxGeometry(1, 1, 1);
  private ember = new T.SphereGeometry(.09, 8, 6);
  private plate = new T.PlaneGeometry(.42, .42 * rules.art.lantern.height / rules.art.lantern.width);
  private lanternTexture: T.Texture;
  private lanternArt: T.MeshBasicMaterial;
  private artReady = false;
  private disposed = false;
  private bronze = new T.MeshStandardMaterial({ color: 0x69523a, roughness: .55, metalness: .5 });
  private wood = new T.MeshStandardMaterial({ color: 0x4b3021, roughness: .9 });
  private glow = new T.MeshBasicMaterial({ color: 0xffc172, toneMapped: false });
  private quality = true;
  private shadowTime = -Infinity;
  private samples: LampLightSample[] = [];
  get lightSamples(): readonly LampLightSample[] { return this.samples; }
  constructor(private scene: T.Scene) {
    this.root.name = 'ChuxianHeldLamps';
    scene.add(this.root, ...this.pool);
    this.lanternTexture = new T.TextureLoader().load(resolveAssetUrl(rules.art.lantern.url), texture => {
      if (this.disposed) { texture.dispose(); return; }
      texture.colorSpace = T.SRGBColorSpace; texture.magFilter = T.NearestFilter; texture.minFilter = T.NearestFilter; texture.generateMipmaps = false; this.artReady = true;
    });
    this.lanternArt = new T.MeshBasicMaterial({ map: this.lanternTexture, transparent: true, alphaTest: .02, side: T.DoubleSide, toneMapped: false });
    this.pool.forEach((light, i) => {
      light.name = `ChuxianNearLamp${i}`;
      light.shadow.mapSize.set(512, 512); light.shadow.camera.near = .05;
      light.shadow.normalBias = .025; light.shadow.bias = -.00015; light.shadow.autoUpdate = false;
    });
  }
  setQuality(high: boolean) { this.quality = high; this.shadowTime = -Infinity; }
  private make(kind: HeldLamp['kind']): HeldLamp {
    const group = new T.Group();
    const box = (material: T.Material, size: Vec3, at: Vec3) => { const mesh = new T.Mesh(this.cube, material); mesh.scale.set(...size); mesh.position.set(...at); group.add(mesh); return mesh; };
    let flame: T.Object3D;
    if (kind === 'emission') { flame = new T.Group(); }
    else if (kind === 'torch') {
      box(this.wood, [.05, .45, .05], [0, -.13, 0]);
      box(this.bronze, [.13, .08, .13], [0, .12, 0]);
      flame = new T.Mesh(this.ember, this.glow); flame.position.y = .22; flame.scale.set(.75, 1.6, .75); group.add(flame);
    } else {
      box(this.bronze, [.24, .04, .2], [0, -.13, 0]); box(this.bronze, [.26, .045, .22], [0, .13, 0]);
      box(this.bronze, [.14, .025, .025], [0, .24, 0]);
      for (const x of [-.10, .10]) { box(this.bronze, [.025, .23, .025], [x, 0, -.08]); box(this.bronze, [.025, .23, .025], [x, 0, .08]); box(this.bronze, [.025, .10, .025], [x * .6, .20, 0]); }
      flame = box(this.glow, [.13, .18, .12], [0, 0, 0]);
    }
    const fallback = [...group.children];
    let art: T.Mesh | undefined;
    if (kind === 'lantern') { art = new T.Mesh(this.plate, this.lanternArt); art.visible = this.artReady; group.add(art); }
    this.root.add(group);
    return { group, flame, art, fallback, tier: 1, kind, point: new T.Vector3() };
  }
  update(actors: readonly LampActor[], selfId: string, seconds: number, options: { right?: Vec3; strength?: number } = {}): readonly LampLightSample[] {
    if (this.disposed) return [];
    const right = options.right ?? [1, 0, 0], strength = Number.isFinite(options.strength) ? T.MathUtils.clamp(options.strength!, 0, 2) : 1;
    const present = new Set<string>(), candidates: { id: string; holder: HeldLamp; distance: number; intensity: number; range: number; color?: Vec3 }[] = [];
    const self = actors.find(actor => actor.id === selfId)?.point;
    const nearby = self ? actors.filter(actor => (actor.kind === 'monster' ? Boolean(actor.emissive) : Boolean(actor.townLamp?.tier)) && actor.point.every(Number.isFinite)).map(actor => ({ actor, distance: (actor.point[0] - self[0]) ** 2 + (actor.point[1] - self[1]) ** 2 + (actor.point[2] - self[2]) ** 2 })).filter(row => row.distance <= 28 ** 2).sort((a, b) => Number(b.actor.id === selfId) - Number(a.actor.id === selfId) || a.distance - b.distance || a.actor.id.localeCompare(b.actor.id)).slice(0, 32) : [];
    for (const { actor } of nearby) {
      // Explicit authority only: absence and tier 0 never become a fallback lamp.
      const emission = actor.kind === 'monster' ? actor.emissive : undefined;
      if (actor.kind === 'monster' ? !emission : !actor.townLamp || actor.townLamp.tier === 0) continue;
      const data = rules.tiers.find(tier => tier.tier === actor.townLamp?.tier);
      if (!data && !emission) continue;
      if (emission && (!Number.isFinite(emission.intensityCandela) || !(emission.intensityCandela > 0 && emission.intensityCandela <= 100) || !Number.isFinite(emission.rangeMetres) || !(emission.rangeMetres > 0 && emission.rangeMetres <= 10) || !emission.color.every(c => Number.isFinite(c) && c >= 0 && c <= 1))) continue;
      const kind = emission ? 'emission' : actor.townLamp && 'kind' in actor.townLamp ? actor.townLamp.kind : 'lantern';
      let holder = this.holders.get(actor.id);
      if (holder?.kind !== kind) { holder?.group.removeFromParent(); holder = this.make(kind); this.holders.set(actor.id, holder); }
      present.add(actor.id); holder.tier = data?.tier ?? 1;
      holder.point.set(...actor.point).addScaledVector(new T.Vector3(...right), emission ? 0 : (actor.facing ?? 1) * .23);
      const height = Number.isFinite(actor.heightMetres) ? T.MathUtils.clamp(actor.heightMetres!, .5, 3) : 1.25;
      holder.point.y += height * (emission ? .45 : .52);
      holder.group.position.copy(holder.point); holder.group.scale.setScalar(.85 + (holder.tier - 1) * .15);
      if (holder.art) { holder.art.visible = this.artReady; holder.art.rotation.y = -Math.atan2(right[2], right[0]); }
      holder.fallback.forEach(object => { object.visible = !holder.art || !this.artReady; });
      holder.flame.visible = strength > 0;
      if (holder.art && this.artReady) holder.flame.visible = false;
      const distance = self ? holder.point.distanceToSquared(new T.Vector3(...self)) : Infinity;
      if (strength > 0 && distance <= 28 ** 2) candidates.push({ id: actor.id, holder, distance, intensity: emission?.intensityCandela ?? data!.intensityCandela, range: emission?.rangeMetres ?? data!.rangeMetres, color: emission?.color });
    }
    for (const [id, holder] of this.holders) if (!present.has(id)) { holder.group.removeFromParent(); this.holders.delete(id); }
    candidates.sort((a, b) => Number(b.id === selfId) - Number(a.id === selfId) || a.distance - b.distance || a.id.localeCompare(b.id));
    const selected = candidates.slice(0, this.quality ? 8 : 6);
    const refreshShadow = seconds - this.shadowTime >= .1;
    if (refreshShadow) this.shadowTime = seconds;
    this.samples = [];
    this.pool.forEach((light, i) => {
      const candidate = selected[i]; light.intensity = 0; light.castShadow = this.quality && i < 2 && Boolean(candidate);
      if (!candidate) return;
      light.position.copy(candidate.holder.point); light.intensity = candidate.intensity * strength;
      light.color.set(0xffbb66); if (candidate.color) light.color.setRGB(...candidate.color);
      light.distance = candidate.range; light.decay = 2; light.shadow.camera.far = candidate.range;
      if (refreshShadow && light.castShadow) light.shadow.needsUpdate = true;
      this.samples.push({ id: candidate.id, position: light.position.toArray() as Vec3, intensity: light.intensity, distance: light.distance, color: light.color.toArray() as Vec3, decay: 2 });
    });
    return this.samples;
  }
  destroy() {
    if (this.disposed) return; this.disposed = true;
    this.root.removeFromParent(); this.root.clear(); this.holders.clear(); this.samples = [];
    this.pool.forEach(light => { light.removeFromParent(); light.shadow.dispose(); });
    this.cube.dispose(); this.ember.dispose(); this.plate.dispose(); this.lanternTexture.dispose(); this.lanternArt.dispose(); this.bronze.dispose(); this.wood.dispose(); this.glow.dispose();
  }
}
