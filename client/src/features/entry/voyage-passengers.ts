import * as T from 'three';
import type { Part } from '../../assets/avatar-types';
import { resolveAssetUrl } from '../../assets/resource-url';

const ease = (t: number) => { t = T.MathUtils.clamp(t, 0, 1); return t * t * (3 - 2 * t); };
/** Local presentation only: feet stay attached to the authored ship/bed anchors. */
export function wakePose(variant: number, seconds: number) {
  const t = T.MathUtils.clamp(seconds / [1, 1.8, 1.25][variant], 0, 1);
  const rise = ease(variant === 1 ? (t - .24) / .76 : t / .8);
  return { progress: rise, tilt: -Math.PI / 2 * (1 - rise), roll: variant === 1 ? Math.sin(t * Math.PI * 2) * .2 * (1 - rise) : 0,
    lift: variant === 2 ? Math.sin(ease((t - .35) / .65) * Math.PI) * .5 : 0,
    action: variant === 1 && t > .22 && t < .78 ? 'sit' : variant === 2 && t > .3 && t < .8 ? 'jump' : 'stand' };
}
type Doll = { group: T.Group; mesh: T.Mesh<T.PlaneGeometry, T.MeshStandardMaterial>; texture: T.CanvasTexture; canvas: HTMLCanvasElement; token: number; zz: T.Sprite };

export class VoyagePassengers {
  private root = new T.Group();
  private dolls = new Map<string, Doll>();
  private images = new Map<string, Promise<HTMLImageElement>>();
  private ids: string[] = [];
  private selected?: string;
  private stage = 'login';
  private page = 0;
  private wake = { variant: 0, seconds: 10 };
  private book?: T.Group;
  private departure?: { seconds: number; resolve: (completed: boolean) => void; settled: boolean };
  private alive = true;
  deckPosition = new T.Vector3(6, 5.44, 12);
  deckMoving = false;
  deckFacing = 1;
  constructor(private changed: () => void) { this.root.name = 'SV3_Passengers'; }
  attach(ship: T.Object3D) { ship.add(this.root); }
  setSlots(ids: string[], selected: string | undefined, stage: string, page: number) {
    if (selected !== this.selected || (stage === 'characters' && this.stage !== stage)) this.wake = { variant: Math.floor(Math.random() * 3), seconds: 0 };
    if (stage !== this.stage || selected !== this.selected) this.cancelDeparture();
    this.ids = ids; this.selected = selected; this.stage = stage; this.page = page;
    for (const [id, doll] of this.dolls) if (!ids.includes(id) && id !== 'draft') { this.disposeDoll(doll); this.dolls.delete(id); }
  }
  action(id: string) { if (this.stage === 'channel' && id === this.selected) return this.deckMoving ? 'walk' : 'stand'; return id === this.selected ? wakePose(this.wake.variant, this.wake.seconds).action : 'stand'; }
  sleeping(id: string) { return this.stage === 'characters' && id !== this.selected; }
  async setFrame(id: string, parts: Part[]) {
    if (!parts.length || !this.alive) return;
    if (this.sleeping(id)) parts = parts.filter(p => !('part' in p) || p.part !== 'weapon');
    let doll = this.dolls.get(id);
    if (!doll) {
      const canvas = document.createElement('canvas'), texture = new T.CanvasTexture(canvas);
      texture.colorSpace = T.SRGBColorSpace; texture.magFilter = T.NearestFilter; texture.minFilter = T.NearestFilter;
      const material = new T.MeshStandardMaterial({ map: texture, transparent: true, alphaTest: .05, roughness: .95, side: T.DoubleSide });
      const mesh = new T.Mesh(new T.PlaneGeometry(1, 1, 1, 10), material); mesh.castShadow = true; mesh.receiveShadow = true;
      const group = new T.Group(); group.name = `SV3_Passenger_${id}`; group.add(mesh); this.root.add(group);
      const zCanvas = document.createElement('canvas'); zCanvas.width = 128; zCanvas.height = 96;
      const ctx = zCanvas.getContext('2d')!; ctx.font = 'bold 46px Georgia'; ctx.fillStyle = '#d5e9ff'; ctx.fillText('Z', 8, 81); ctx.font = 'bold 28px Georgia'; ctx.fillText('z', 60, 40);
      const zTexture = new T.CanvasTexture(zCanvas); zTexture.colorSpace = T.SRGBColorSpace;
      const zz = new T.Sprite(new T.SpriteMaterial({ map: zTexture, transparent: true, depthTest: true })); zz.scale.set(.7, .525, 1); this.root.add(zz);
      doll = { group, mesh, texture, canvas, token: 0, zz }; this.dolls.set(id, doll);
    }
    const token = ++doll.token;
    const images = await Promise.all(parts.map(part => {
      const url = resolveAssetUrl(part.url);
      if (!this.images.has(url)) this.images.set(url, new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = url;
      }));
      return this.images.get(url)!;
    })).catch(() => undefined);
    if (!images || !this.alive || doll.token !== token) return;
    const left = Math.min(...parts.map(p => p.x)), top = Math.min(...parts.map(p => p.y));
    const right = Math.max(...parts.map((p, i) => p.x + (p.width ?? images[i].width))), bottom = Math.max(...parts.map((p, i) => p.y + (p.height ?? images[i].height)));
    doll.canvas.width = Math.max(1, right - left); doll.canvas.height = Math.max(1, bottom - top);
    const ctx = doll.canvas.getContext('2d')!; ctx.imageSmoothingEnabled = false;
    parts.forEach((p, i) => ctx.drawImage(images[i], p.x - left, p.y - top, p.width ?? images[i].width, p.height ?? images[i].height));
    doll.texture.needsUpdate = true;
    // Source coordinates are relative to the foot, including equipment extending beyond the body.
    doll.mesh.scale.set(doll.canvas.width / 42, doll.canvas.height / 42, 1);
    doll.mesh.position.set((left + right) / 84, -(top + bottom) / 84, 0);
    this.changed();
  }
  update(delta: number, reduced: boolean, model: T.Object3D, camera: T.Camera, now: number) {
    this.wake.seconds = reduced ? 10 : this.wake.seconds + delta;
    if (this.departure && !this.departure.settled) {
      this.departure.seconds += reduced ? 3 : delta;
      if (this.departure.seconds >= 2.1) { this.departure.settled = true; this.departure.resolve(true); }
    }
    for (const [id, doll] of this.dolls) {
      const index = this.ids.indexOf(id), sleeping = this.sleeping(id), selected = id === this.selected;
      const onDeck = this.stage === 'channel' && selected;
      doll.group.visible = onDeck || (this.stage === 'characters' && index >= 0) || (this.stage === 'create' && id === 'draft');
      doll.zz.visible = doll.group.visible && sleeping;
      if (!doll.group.visible) continue;
      const anchor = model.getObjectByName(`SV2_Bed_${index}_SleepAnchor`);
      const sleep = anchor ? this.root.worldToLocal(anchor.getWorldPosition(new T.Vector3())) : new T.Vector3(-10.8 + index * 1.8, .7, 43);
      // Feet point toward the camera; local +Y (head) lies along the mattress toward -Z.
      const feet = sleep.clone().add(new T.Vector3(0, .025, .78));
      const pose = wakePose(this.wake.variant, this.wake.seconds);
      doll.group.position.copy(feet); doll.group.rotation.set(-Math.PI / 2, 0, 0); doll.group.scale.setScalar(1);
      if (!sleeping) {
        doll.group.position.y = T.MathUtils.lerp(feet.y, .025, pose.progress) + pose.lift;
        doll.group.position.x += .75 * pose.progress; doll.group.position.z += .2 * pose.progress;
        const facing = this.root.getWorldQuaternion(new T.Quaternion()).invert().multiply(camera.getWorldQuaternion(new T.Quaternion()));
        doll.group.quaternion.slerp(facing, pose.progress);
        doll.group.rotateZ(pose.roll);
      }
      if (onDeck || id === 'draft') {
        if (onDeck) doll.group.position.copy(this.deckPosition); else doll.group.position.set(0, .025, 38.8);
        const eye = this.root.worldToLocal(camera.getWorldPosition(new T.Vector3()));
        doll.group.rotation.set(0, Math.atan2(eye.x - doll.group.position.x, eye.z - doll.group.position.z), 0);
        if (onDeck) doll.group.scale.x = this.deckFacing;
      }
      const vertices = doll.mesh.geometry.attributes.position;
      // Keep the body under the quilt's low folds while the head rests above the pillow.
      for (let i = 0; i < vertices.count; i++) vertices.setZ(i, (-.16 + ease((vertices.getY(i) + .1) / .5) * .35) * (onDeck || id === 'draft' ? 0 : sleeping ? 1 : 1 - pose.progress));
      vertices.needsUpdate = true;
      doll.zz.position.copy(sleep).add(new T.Vector3(.5, .7 + Math.sin(now * .0015) * .08, -.6));
      if (selected && this.departure && this.book) {
        const t = this.departure.seconds;
        this.book.position.copy(feet).add(new T.Vector3(.7, .8, 1.8));
        if (onDeck) this.book.position.copy(this.deckPosition).add(new T.Vector3(.6, .86, 1.5));
        this.book.scale.setScalar(ease(t / .4)); this.book.rotation.y = Math.sin(t * 1.8) * .12;
        const absorb = ease((t - .65) / 1.1);
        doll.group.position.lerp(this.book.position, absorb); doll.group.scale.setScalar(1 - absorb * .99);
        doll.zz.visible = false;
      }
    }
  }
  /** Authority is checked by EntryView before playing this local book transition. */
  depart() {
    this.cancelDeparture();
    if (!this.root.parent || !this.selected) return Promise.resolve(true);
    const book = new T.Group(); book.name = 'SV3_DepartureBook'; this.root.add(book); this.book = book;
    const cover = new T.MeshStandardMaterial({ color: '#253f56', metalness: .2, roughness: .5 });
    const pages = new T.MeshStandardMaterial({ color: '#ffefd4', emissive: '#b9dfff', emissiveIntensity: .65, roughness: .85 });
    const gold = new T.MeshStandardMaterial({ color: '#d9ad58', metalness: .75, roughness: .3 });
    for (const side of [-1, 1]) {
      const leaf = new T.Group(); leaf.rotation.z = side * -.2; book.add(leaf);
      for (const [w, h, d, x, z, mat] of [[.6, .85, .07, side * .3, 0, cover], [.54, .77, .045, side * .28, .057, pages]] as const) {
        const mesh = new T.Mesh(new T.BoxGeometry(w, h, d), mat); mesh.position.set(x, 0, z); mesh.castShadow = true; leaf.add(mesh);
      }
      for (let line = 0; line < 5; line++) {
        const ink = new T.Mesh(new T.BoxGeometry(.36 - line % 2 * .1, .018, .004), gold); ink.position.set(side * .29, .22 - line * .095, .084); leaf.add(ink);
      }
    }
    const glow = new T.PointLight('#99d9ff', 3, 5, 2); glow.position.z = .4; book.add(glow);
    book.scale.setScalar(0);
    return new Promise<boolean>(resolve => { this.departure = { seconds: 0, resolve, settled: false }; this.changed(); });
  }
  cancelDeparture() {
    this.departure?.resolve(false); this.departure = undefined;
    if (this.book) {
      const materials = new Set<T.Material>();
      this.book.traverse(node => { if (node instanceof T.Mesh) { node.geometry.dispose(); for (const m of Array.isArray(node.material) ? node.material : [node.material]) materials.add(m); } });
      materials.forEach(m => m.dispose()); this.book.removeFromParent(); this.book = undefined;
    }
  }
  private disposeDoll(doll: Doll) { doll.token++; doll.mesh.geometry.dispose(); doll.mesh.material.dispose(); doll.texture.dispose(); doll.group.removeFromParent(); (doll.zz.material as T.SpriteMaterial).map?.dispose(); (doll.zz.material as T.SpriteMaterial).dispose(); doll.zz.removeFromParent(); }
  destroy() { this.alive = false; this.cancelDeparture(); this.dolls.forEach(d => this.disposeDoll(d)); this.dolls.clear(); this.images.clear(); this.root.removeFromParent(); }
}
