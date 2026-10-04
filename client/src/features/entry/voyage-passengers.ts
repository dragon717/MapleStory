import * as T from 'three';
import { voyageScreenFacing } from './voyage-deck';
import type { Part } from '../../assets/avatar-types';
import { resolveAssetUrl } from '../../assets/resource-url';
import { VOYAGE_PASSENGER_SCALE } from './voyage-scale';

const ease = (t: number) => { t = T.MathUtils.clamp(t, 0, 1); return t * t * (3 - 2 * t); };
/** Local presentation only: feet stay attached to the authored ship/bed anchors. */
export function wakePose(variant: number, seconds: number) {
  const t = T.MathUtils.clamp(seconds / [1, 1.8, 1.25][variant], 0, 1);
  const rise = ease(variant === 1 ? (t - .24) / .76 : t / .8);
  return { progress: rise, tilt: -Math.PI / 2 * (1 - rise), roll: variant === 1 ? Math.sin(t * Math.PI * 2) * .2 * (1 - rise) : 0,
    lift: variant === 2 ? Math.sin(ease((t - .35) / .65) * Math.PI) * .5 : 0,
    action: variant === 1 && t > .22 && t < .78 ? 'sit' : variant === 2 && t > .3 && t < .8 ? 'jump' : 'stand' };
}
export type DollBounds = { left: number; top: number; right: number; bottom: number };
const dollTexture = (canvas: HTMLCanvasElement) => { const texture = new T.CanvasTexture(canvas); texture.colorSpace=T.SRGBColorSpace; texture.magFilter=texture.minFilter=T.NearestFilter; texture.generateMipmaps=false; return texture; };
type Doll = { bounds?: DollBounds; bodyCenter?: T.Vector2; group: T.Group; mesh: T.Mesh<T.PlaneGeometry, T.MeshStandardMaterial>; texture: T.CanvasTexture; canvas: HTMLCanvasElement; token: number; zz: T.Sprite };

export class VoyagePassengers {
  private root = new T.Group();
  private dolls = new Map<string, Doll>();
  private images = new Map<string, Promise<HTMLImageElement>>();
  private ids: string[] = [];
  private selected?: string;
  private returning = new Map<string, { from: T.Vector3; previous: T.Vector3; seconds: number; deadline: number; facing: number }>();
  get hasReturning() { return this.returning.size > 0; }
  location(id: string) { return this.dolls.get(id)?.group.position.clone(); }
  get waking() { return wakePose(this.wake.variant, this.wake.seconds).progress < 1; }
  finishWake() { this.wake.seconds = 10; }

  private stage = 'login';
  private page = 0;
  private wake = { variant: 0, seconds: 10 };
  private book?: T.Group;
  private bookClip?: T.AnimationClip;
  private bookMixer?: T.AnimationMixer;
  private departure?: { seconds: number; resolve: (completed: boolean) => void; settled: boolean };
  private alive = true;
  deckPosition = new T.Vector3(6, 5.44, 12);
  deckMoving = false;
  deckJumping = false;
  deckFacing = 1;
  constructor(private changed: () => void, private clock: () => number = () => performance.now()) {
    this.root.name = 'SV3_Passengers';
    // Keep the carrier in ship-local coordinates.  Counter-scale each doll
    // mesh below; scaling this carrier would also halve its world position and
    // detach the character from the ×2 deck and bed anchors.
  }
  attach(ship: T.Object3D) { ship.add(this.root); }
  setSlots(ids: string[], selected: string | undefined, stage: string, page: number) {
    if (selected !== this.selected) {
      if (this.selected && this.stage === 'characters') {
        const from = this.location(this.selected);
        if (from) this.returning.set(this.selected, { from, previous: from.clone(), seconds: 0, deadline: this.clock()+3000, facing: 1 });
      }
      const returning = selected && this.returning.delete(selected);
      this.wake = { variant: Math.floor(Math.random() * 3), seconds: returning ? 10 : 0 };
    }
    if (stage !== 'characters') this.returning.clear();
    if (stage !== this.stage || selected !== this.selected) this.cancelDeparture();
    this.ids = ids; this.selected = selected; this.stage = stage; this.page = page;
    for (const [id, doll] of this.dolls) if (!ids.includes(id) && id !== 'draft') { this.disposeDoll(doll); this.dolls.delete(id); }
  }
  action(id: string) { if ((this.stage === 'channel' || this.stage === 'characters' && !this.waking) && id === this.selected) return this.deckJumping ? 'jump' : this.deckMoving ? 'walk' : 'stand'; if (this.returning.has(id)) return 'walk'; return id === this.selected ? wakePose(this.wake.variant, this.wake.seconds).action : 'stand'; }
  sleeping(id: string) { return this.stage === 'characters' && id !== this.selected && !this.returning.has(id); }
  async setFrame(id: string, parts: Part[], bounds?: DollBounds) {
    if (!parts.length || !this.alive) return;
    if (this.sleeping(id)) parts = parts.filter(p => !('part' in p) || p.part !== 'weapon');
    let doll = this.dolls.get(id);
    if (!doll) {
      const canvas = document.createElement('canvas'), texture = dollTexture(canvas);
      const material = new T.MeshStandardMaterial({ map: texture, transparent: true, alphaTest: .05, roughness: .95, side: T.DoubleSide });
      const mesh = new T.Mesh(new T.PlaneGeometry(1, 1, 1, 10), material); mesh.castShadow = true; mesh.receiveShadow = true;
      const group = new T.Group(); group.name = `SV3_Passenger_${id}`; group.add(mesh); this.root.add(group);
      const zCanvas = document.createElement('canvas'); zCanvas.width = 128; zCanvas.height = 96;
      const ctx = zCanvas.getContext('2d')!; ctx.font = 'bold 46px Georgia'; ctx.fillStyle = '#d5e9ff'; ctx.fillText('Z', 8, 81); ctx.font = 'bold 28px Georgia'; ctx.fillText('z', 60, 40);
      const zTexture = new T.CanvasTexture(zCanvas); zTexture.colorSpace = T.SRGBColorSpace;
      const zz = new T.Sprite(new T.SpriteMaterial({ map: zTexture, transparent: true, depthTest: true })); zz.scale.set(.7 * VOYAGE_PASSENGER_SCALE, .525 * VOYAGE_PASSENGER_SCALE, 1); this.root.add(zz);
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
    const previous = bounds ?? doll.bounds;
    const left = Math.min(previous?.left ?? Infinity, ...parts.map(p => p.x)), top = Math.min(previous?.top ?? Infinity, ...parts.map(p => p.y));
    const right = Math.max(previous?.right ?? -Infinity, ...parts.map((p, i) => p.x + (p.width ?? images[i].width))), bottom = Math.max(previous?.bottom ?? -Infinity, ...parts.map((p, i) => p.y + (p.height ?? images[i].height)));
    doll.bounds = { left, top, right, bottom };
    const width = Math.max(1, right-left), height = Math.max(1, bottom-top);
    if (doll.canvas.width !== width || doll.canvas.height !== height) {
      doll.canvas.width = width; doll.canvas.height = height;
      // WebGL immutable texture storage cannot resize via needsUpdate alone.
      doll.texture.dispose(); doll.texture = dollTexture(doll.canvas); doll.mesh.material.map = doll.texture;
    }
    const ctx = doll.canvas.getContext('2d')!; ctx.clearRect(0,0,width,height); ctx.imageSmoothingEnabled = false;
    parts.forEach((p, i) => ctx.drawImage(images[i], p.x - left, p.y - top, p.width ?? images[i].width, p.height ?? images[i].height));
    // Visible ink, rather than transparent animation padding, defines the
    // sleeping body's centre. The source foot is still (0,0) when walking.
    const pixels = ctx.getImageData(0, 0, width, height).data;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (pixels[(y * width + x) * 4 + 3] > 32) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    if (maxX >= 0) doll.bodyCenter = new T.Vector2((left + (minX + maxX) / 2) / 42, -(top + (minY + maxY) / 2) / 42);
    doll.texture.needsUpdate = true;
    // A stable canvas across all actions keeps the source foot and texture aspect unchanged.
    doll.mesh.scale.set(width / 42, height / 42, 1);
    doll.mesh.position.set((left + right) / 84, -(top + bottom) / 84, 0);
    this.changed();
  }
  update(delta: number, reduced: boolean, model: T.Object3D, camera: T.Camera, now: number) {
    this.bookMixer?.update(reduced ? 3 : delta);
    this.wake.seconds = reduced ? 10 : this.wake.seconds + delta;
    if (this.departure && !this.departure.settled) {
      this.departure.seconds += reduced ? 3 : delta;
      if (this.departure.seconds >= (this.bookClip?.duration ?? 2.1)) { this.departure.settled = true; this.departure.resolve(true); }
    }
    for (const [id, doll] of this.dolls) {
      const index = this.ids.indexOf(id), selected = id === this.selected;
      let sleeping = this.sleeping(id);
      const onDeck = selected && (this.stage === 'channel' || this.stage === 'characters' && !this.waking);
      let returning = this.returning.get(id);
      doll.group.visible = onDeck || (this.stage === 'characters' && index >= 0) || (this.stage === 'create' && id === 'draft');
      doll.zz.visible = doll.group.visible && sleeping;
      if (!doll.group.visible) continue;
      const anchor = model.getObjectByName(`SV2_Bed_${index}_SleepAnchor`);
      const sleep = anchor ? this.root.worldToLocal(anchor.getWorldPosition(new T.Vector3())) : new T.Vector3(-10.8 + index * 1.8, .7, 43);
      // Feet point toward the camera; local +Y (head) lies along the mattress toward -Z.
      const centre = doll.bodyCenter ?? new T.Vector2(0, .78 / VOYAGE_PASSENGER_SCALE);
      const feet = sleep.clone().add(new T.Vector3(-centre.x * VOYAGE_PASSENGER_SCALE, .025, centre.y * VOYAGE_PASSENGER_SCALE));
      const pose = wakePose(this.wake.variant, this.wake.seconds);
      doll.group.position.copy(feet); doll.group.rotation.set(-Math.PI / 2, 0, 0); doll.group.scale.setScalar(VOYAGE_PASSENGER_SCALE);
      if (!sleeping) {
        doll.group.position.lerp(this.deckPosition, pose.progress); doll.group.position.y += pose.lift;
        const facing = this.root.getWorldQuaternion(new T.Quaternion()).invert().multiply(camera.getWorldQuaternion(new T.Quaternion()));
        doll.group.quaternion.slerp(facing, pose.progress);
        doll.group.rotateZ(pose.roll);
      }
      if (returning) {
        returning.seconds += Math.max(0, delta);
        // Walk through the clear aisle; the user-requested deadline guarantees a sleeping bed by 3 s.
        const footAnchor = model.getObjectByName(`SV2_Bed_${index}_FootAnchor`);
        const aisle = footAnchor ? this.root.worldToLocal(footAnchor.getWorldPosition(new T.Vector3())).add(new T.Vector3(0, 0, .6)) : new T.Vector3(feet.x, .025, 45.2); aisle.y = .025;
        const waypoints = [returning.from, new T.Vector3(returning.from.x, .025, aisle.z), aisle, feet];
        const length=waypoints.slice(1).reduce((sum,p,i)=>sum+p.distanceTo(waypoints[i]),0);
        const elapsed=Math.max(returning.seconds,(this.clock()-(returning.deadline-3000))/1000);
        let distance = Math.min(elapsed, 3) * Math.max(3,length/3);
        doll.group.position.copy(waypoints[0]);
        for (let i=1;i<waypoints.length;i++) {
          const length=waypoints[i].distanceTo(waypoints[i-1]);
          doll.group.position.lerpVectors(waypoints[i-1],waypoints[i],length ? Math.min(1,distance/length) : 1);
          if(distance<length)break; distance-=length;
        }
        doll.group.quaternion.copy(this.root.getWorldQuaternion(new T.Quaternion()).invert().multiply(camera.getWorldQuaternion(new T.Quaternion())));
        returning.facing = voyageScreenFacing(returning.previous, doll.group.position, this.root, camera, returning.facing);
        returning.previous.copy(doll.group.position); doll.group.scale.x = VOYAGE_PASSENGER_SCALE * returning.facing;
        if (this.clock() >= returning.deadline || doll.group.position.distanceTo(waypoints[3]) < .04) {
          this.returning.delete(id); doll.group.position.copy(feet); doll.group.rotation.set(-Math.PI/2,0,0); doll.group.scale.setScalar(VOYAGE_PASSENGER_SCALE); doll.zz.visible=true; sleeping=true; returning=undefined;
        }
      }
      if (onDeck || id === 'draft') {
        if (onDeck) doll.group.position.copy(this.deckPosition); else doll.group.position.set(0, .025, 38.8);
        doll.group.quaternion.copy(this.root.getWorldQuaternion(new T.Quaternion()).invert().multiply(camera.getWorldQuaternion(new T.Quaternion())));
        if (onDeck) doll.group.scale.x = VOYAGE_PASSENGER_SCALE * this.deckFacing;
      }
      const vertices = doll.mesh.geometry.attributes.position;
      // Keep the body under the quilt's low folds while the head rests above the pillow.
      for (let i = 0; i < vertices.count; i++) vertices.setZ(i, (-.16 + ease((vertices.getY(i) + .1) / .5) * .35) * (onDeck || returning || id === 'draft' ? 0 : sleeping ? 1 : 1 - pose.progress));
      vertices.needsUpdate = true;
      doll.zz.position.copy(sleep).add(new T.Vector3(.5, .7 + Math.sin(now * .0015) * .08, -.6));
      if (selected && this.departure && this.book) {
        const t = this.departure.seconds;
        this.book.position.copy(feet).add(new T.Vector3(.7, .8, 1.8));
        if (onDeck) this.book.position.copy(this.deckPosition).add(new T.Vector3(.6, .86, 1.5));
        this.book.scale.setScalar(VOYAGE_PASSENGER_SCALE * ease(t / .4));
        // Authored readable pages face local +Z; rotate the whole book toward the passenger.
        const toward = doll.group.position.clone().sub(this.book.position);
        this.book.rotation.y = Math.atan2(toward.x, toward.z) + Math.sin(t * 1.8) * .12;
        const absorb = ease((t - .65) / 1.1);
        doll.group.position.lerp(this.book.position, absorb); doll.group.scale.setScalar(VOYAGE_PASSENGER_SCALE * (1 - absorb * .99));
        doll.zz.visible = false;
      }
    }
  }
  /** Authority is checked by EntryView before playing this local book transition. */
  depart() {
    this.cancelDeparture();
    if (!this.root.parent || !this.selected) return Promise.resolve(true);
    if (!this.book || !this.bookClip) return Promise.resolve(true);
    this.root.add(this.book);
    this.bookMixer = new T.AnimationMixer(this.book);
    this.bookMixer.clipAction(this.bookClip).setLoop(T.LoopOnce, 1).play().clampWhenFinished = true;
    this.book.scale.setScalar(0);
    return new Promise<boolean>(resolve => { this.departure = { seconds: 0, resolve, settled: false }; this.changed(); });
  }
  cancelDeparture() {
    this.departure?.resolve(false); this.departure = undefined;
    this.bookMixer?.stopAllAction(); this.bookMixer = undefined;
    this.book?.removeFromParent();
  }
  setBook(book:T.Group,clip:T.AnimationClip) { this.book=book;this.bookClip=clip; }

  private disposeDoll(doll: Doll) { doll.token++; doll.mesh.geometry.dispose(); doll.mesh.material.dispose(); doll.texture.dispose(); doll.group.removeFromParent(); (doll.zz.material as T.SpriteMaterial).map?.dispose(); (doll.zz.material as T.SpriteMaterial).dispose(); doll.zz.removeFromParent(); }
  destroy() { this.alive = false; this.cancelDeparture();
    this.returning.clear();
    this.book?.traverse(node=>{if(node instanceof T.Mesh){node.geometry.dispose();for(const m of Array.isArray(node.material)?node.material:[node.material])m.dispose();}}); this.book=undefined; this.dolls.forEach(d => this.disposeDoll(d)); this.dolls.clear(); this.images.clear(); this.root.removeFromParent(); }
}
