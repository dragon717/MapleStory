import * as T from 'three';
import layout from '../../../../shared/voyage-deck.json';
import { routeDirectionSlots } from '../henesys/route-directions';

export function voyageScreenFacing(from: T.Vector3, to: T.Vector3, ship: T.Object3D, camera: T.Camera, previous = 1) {
  const dx = ship.localToWorld(to.clone()).project(camera).x - ship.localToWorld(from.clone()).project(camera).x;
  return Math.abs(dx) > 1e-7 ? dx > 0 ? -1 : 1 : previous;
}

/** Lobby-only walking constrained by the supplied visible floor and walls. */
export class VoyageDeck {
  readonly position = new T.Vector3(6.5, 0, 12);
  readonly spawn = new T.Vector3();
  moving = false;
  facing = 1;
  private jumpHeight = 0;
  private jumpVelocity = 0;
  get jumping() { return this.jumpHeight > 0 || this.jumpVelocity > 0; }
  private mesh = new T.Group();
  private floor = new T.Group();
  private material = new T.MeshBasicMaterial({ side: T.DoubleSide });
  private visual = new T.Group();
  private visualGeometry: T.BufferGeometry[] = [];
  private visualMaterials: T.Material[] = [];
  private ray = new T.Raycaster();
  private route: T.Vector3[] = [];
  private routeDistance = 0;
  private routeSign = 0;
  private heldHorizontal = 0;
  private heldVertical = 0;
  constructor(ship: T.Object3D, private readonly interior = false) {
    ship.updateWorldMatrix(true, true);
    const inverse = ship.matrixWorld.clone().invert(), tiles = new Map<string, number[]>();
    // ponytail: static hull collision only; moving machinery needs separate colliders if made walkable.
    const roots = interior
      ? ['SV2_CabinFloor']
      : ['SV3_Hull', 'SV3_CaptainRoom', layout.surface.mesh];
    if (!interior && !ship.getObjectByName(layout.surface.mesh)) throw new Error('The authored main deck surface is missing');
    for (const name of roots) ship.getObjectByName(name)?.traverse(node => {
      if (!(node instanceof T.Mesh)) return;
      // Account/adventure signs are stage-dependent decoration, never invisible walking walls.
      for(let parent:T.Object3D|null=node;parent;parent=parent.parent) if(['SV2_LoginSign','SV3_AdventureSign'].includes(parent.name)) return;
      const matrix = inverse.clone().multiply(node.matrixWorld), p = node.geometry.attributes.position, index = node.geometry.index;
      for (let i = 0; i < (index?.count ?? p.count); i += 3) {
        const triangle = [0, 1, 2].map(j => new T.Vector3().fromBufferAttribute(p, index ? index.getX(i + j) : i + j).applyMatrix4(matrix));
        // Main deck and its rails; roof galleries are outside this lobby walking surface.
        if (triangle.every(v => v.y < (interior ? -1 : 0)) || triangle.every(v => v.y > 10)) continue;
        const center = triangle.reduce((sum, v) => sum.add(v), new T.Vector3()).divideScalar(3);
        const walkable = !interior && name === layout.surface.mesh;
        const key = `${walkable ? 'floor:' : ''}${Math.floor(center.x / 4)},${Math.floor(center.z / 4)}`;
        if (!tiles.has(key)) tiles.set(key, []);
        const vertices = tiles.get(key)!;
        for (const v of triangle) vertices.push(v.x, v.y, v.z);
      }
    });
    for (const [key, vertices] of tiles) {
      const geometry = new T.BufferGeometry().setAttribute('position', new T.Float32BufferAttribute(vertices, 3));
      geometry.computeBoundingBox(); geometry.computeBoundingSphere(); const tile = new T.Mesh(geometry, this.material); tile.name = 'SV3_DeckCollisionTile'; (key.startsWith('floor:') ? this.floor : this.mesh).add(tile);
    }
    if (!interior) {
      this.route = layout.routes[0].nodes.map(name => {
        const point = layout.nodes[name as keyof typeof layout.nodes];
        return new T.Vector3(point[0], layout.surface.height, point[1]);
      });
      this.addCaptainDoorSeal(ship);
    }
    else this.addCabinRoute(ship);
    if (this.visual.children.length) {
      this.visual.name = 'SV3_DeckFallbacks';
      ship.add(this.visual);
    }
    // Arrive on the horizontal bed aisle; the return portal shares this line.
    if (interior) this.position.set(0, 0, this.route[0].z);
    else {
      // Login lands at the authored starboard boarding node.  The captain
      // room is reached across the main deck through its Space portal.
      const spawn = layout.nodes['右舷登船位'];
      this.position.set(spawn[0], layout.surface.height, spawn[1]);
    }
    const height = this.ground(this.position.x, this.position.z, this.position.y + .4, .8);
    if (height !== undefined) this.position.y = height + .025;
    this.spawn.copy(this.position);
    this.routeDistance = this.nearestRoute(this.position).distance;
  }
  private addCaptainDoorSeal(ship: T.Object3D) {
    // The former walk-in room is removed from the exterior presentation.
    for (const name of ['SV3_CaptainFloor', 'SV3_CaptainDoorThreshold']) {
      const node = ship.getObjectByName(name); if (node) node.visible = false;
    }
    if (ship.getObjectByName('SV3_CaptainDoorSeal')) return;
    const opening = ship.getObjectByName('SV3_CaptainDoorOpening'); if (!opening) return;
    const point = ship.worldToLocal(opening.getWorldPosition(new T.Vector3()));
    const height = Number(opening.userData.height) || 2.7, width = Number(opening.userData.width) || 2.5;
    let source: T.Mesh | undefined;
    ship.getObjectByName('SV3_CaptainRoom')?.traverse(node => { if (!source && node instanceof T.Mesh && node.name.startsWith('SV3_CaptainWall_')) source = node; });
    const material = source ? (Array.isArray(source.material) ? source.material[0] : source.material).clone() : new T.MeshStandardMaterial({ color: '#67402a', roughness: .85 });
    this.visualMaterials.push(material);
    const geometry = new T.BoxGeometry(.34, height, width);
    const wall = new T.Mesh(geometry, material); wall.name = 'SV3_CaptainDoorSeal'; wall.position.set(point.x, point.y + height / 2, point.z);
    wall.castShadow = true; wall.receiveShadow = true; this.visual.add(wall); this.visualGeometry.push(geometry);
    const collisionGeometry = geometry.clone().translate(wall.position.x, wall.position.y, wall.position.z);
    const collider = new T.Mesh(collisionGeometry, this.material); collider.name = 'SV3_CaptainDoorSeal_Collider'; this.mesh.add(collider);
  }
  private addCabinRoute(ship: T.Object3D) {
    const beds = Array.from({ length: 12 }, (_, index) => ship.getObjectByName(`SV2_Bed_${index}_FootAnchor`))
      .filter((anchor): anchor is T.Object3D => Boolean(anchor))
      .map(anchor => ship.worldToLocal(anchor.getWorldPosition(new T.Vector3())).add(new T.Vector3(0, 0, .6)));
    beds.forEach(point => point.y = 0);
    // A single aisle along the door-facing ends of the actual beds.
    beds.sort((a, b) => a.x - b.x);
    this.route = beds;
  }
  private routePoint(point: T.Vector3) {
    return this.nearestRoute(point).point;
  }
  private nearestRoute(point: T.Vector3) {
    let nearest = Infinity, result = this.route[0]?.clone() ?? point.clone(), distance = 0, total = 0;
    for (let i = 0; i < this.route.length - 1; i++) {
      const start = this.route[i], end = this.route[i + 1], segment = end.clone().sub(start); segment.y = 0;
      const offset = point.clone().sub(start); offset.y = 0;
      const amount = segment.lengthSq() ? T.MathUtils.clamp(offset.dot(segment) / segment.lengthSq(), 0, 1) : 0;
      const candidate = start.clone().lerp(end, amount);
      const separation = Math.hypot(candidate.x - point.x, candidate.z - point.z);
      if (separation < nearest) { nearest = separation; result = candidate; distance = total + segment.length() * amount; }
      total += segment.length();
    }
    return { point: result, distance };
  }
  private ringPoint(distance: number) {
    const length = this.route.slice(1).reduce((sum, p, i) => sum + p.distanceTo(this.route[i]), 0);
    let remaining = (distance % length + length) % length;
    for (let i = 1; i < this.route.length; i++) {
      const start = this.route[i - 1], end = this.route[i], size = start.distanceTo(end);
      if (remaining <= size) return start.clone().lerp(end, remaining / size);
      remaining -= size;
    }
    return this.route[0].clone();
  }
  private ringChoices(camera: T.Camera, ship: T.Object3D) {
    const exits = [-1, 1].map(sign => this.ringPoint(this.routeDistance + sign * .3));
    return this.projectChoices(exits, camera, ship).map(slot => ({ ...slot, sign: slot.index === 0 ? -1 : 1 }));
  }
  private projectChoices(exits: T.Vector3[], camera: T.Camera, ship: T.Object3D) {
    const start = ship.localToWorld(this.position.clone()).project(camera);
    return routeDirectionSlots(exits.map(point => {
      point.y = this.position.y;
      const end = ship.localToWorld(point.clone()).project(camera), right = end.x - start.x, down = (start.y - end.y) / (camera as T.PerspectiveCamera).aspect;
      const size = Math.max(1e-9, Math.hypot(right, down));
      return { right: right / size, down: down / size };
    }));
  }
  junctionDirections(camera: T.PerspectiveCamera, ship: T.Object3D) {
    if (this.interior) return [];
    if (!this.route.slice(1, -1).some(p => Math.hypot(p.x - this.position.x, p.z - this.position.z) < .6)) return [];
    return this.ringChoices(camera, ship).map(s => s.direction);
  }
  private ground(x: number, z: number, ceiling: number, distance: number) {
    this.ray.set(new T.Vector3(x, ceiling, z), new T.Vector3(0, -1, 0)); this.ray.far = distance;
    return this.ray.intersectObject(this.interior ? this.mesh : this.floor, true).find(hit => hit.face && hit.face.normal.y > .65)?.point.y;
  }
  reset() { this.place(this.spawn); this.facing = 1; }
  place(point: T.Vector3) {
    const route = this.nearestRoute(point), candidate = route.point;
    if (!this.interior && Math.hypot(candidate.x - point.x, candidate.z - point.z) > 1) return false;
    const height = this.ground(candidate.x, candidate.z, (this.interior ? candidate.y : layout.surface.height) + .4, .8);
    if (height === undefined || !this.interior && !this.canStand(candidate, height)) return false;
    candidate.y = height + .025; this.position.copy(candidate);
    this.routeDistance = route.distance; this.routeSign = 0; this.heldHorizontal = 0; this.heldVertical = 0;
    this.moving = false; this.jumpHeight = 0; this.jumpVelocity = 0;
    return true;
  }
  private canStand(point: T.Vector3, height: number) {
    const radius = layout.surface.bodyRadius;
    // A foot disk must have visible support all around; centre-only probes
    // let the sprite hang over a hole or pass around a sharp rail corner.
    for (const [x, z] of [[0, 0], [radius, 0], [-radius, 0], [0, radius], [0, -radius]]) {
      const support = this.ground(point.x + x, point.z + z, height + .4, .8);
      if (support === undefined || Math.abs(support - height) > .25) return false;
    }
    for (const y of [.3, .85, layout.surface.bodyHeight - .15]) for (let angle = 0; angle < 8; angle++) {
      this.ray.set(new T.Vector3(point.x, height + y, point.z), new T.Vector3(Math.cos(angle * Math.PI / 4), 0, Math.sin(angle * Math.PI / 4)));
      this.ray.far = radius;
      if (this.ray.intersectObject(this.mesh, true).length) return false;
    }
    return true;
  }
  private tryFreeStep(next: T.Vector3) {
    const height = this.ground(next.x, next.z, this.position.y + .4, .8);
    if (height === undefined || Math.abs(height + .025 - this.position.y) > .4 || !this.canStand(next, height)) return false;
    const offset = next.clone().sub(this.position); offset.y = 0;
    if (offset.lengthSq() < 1e-10) return false;
    for (const y of [.3, .85, layout.surface.bodyHeight - .15]) {
      this.ray.set(this.position.clone().add(new T.Vector3(0, y, 0)), offset.clone().normalize());
      this.ray.far = offset.length() + layout.surface.bodyRadius;
      if (this.ray.intersectObject(this.mesh, true).length) return false;
    }
    next.y = height + .025;
    return true;
  }
  jump() { if (!this.jumping) this.jumpVelocity = 7; }
  update(delta: number, horizontal: number, vertical: number, camera: T.Camera, ship: T.Object3D) {
    if (!Number.isFinite(delta) || delta <= 0) return;
    const dt = Math.min(delta, .05);
    this.position.y -= this.jumpHeight;
    this.walk(dt, horizontal, vertical, camera, ship);
    if (this.jumping) {
      this.jumpHeight = Math.max(0, this.jumpHeight + this.jumpVelocity * dt - 9 * dt * dt);
      this.jumpVelocity = this.jumpHeight ? this.jumpVelocity - 18 * dt : 0;
    }
    this.position.y += this.jumpHeight;
  }
  private walk(delta: number, horizontal: number, vertical: number, camera: T.Camera, ship: T.Object3D) {
    this.moving = false;
    if (!Number.isFinite(delta) || delta <= 0) return;
    const changed = horizontal !== this.heldHorizontal || vertical !== this.heldVertical;
    this.heldHorizontal = horizontal; this.heldVertical = vertical;
    if(!horizontal&&!vertical) { this.routeSign = 0; return; }
    const inverse = ship.getWorldQuaternion(new T.Quaternion()).invert();
    const forward = camera.getWorldDirection(new T.Vector3()).applyQuaternion(inverse); forward.y = 0; forward.normalize();
    const right = forward.clone().cross(new T.Vector3(0, 1, 0));
    const wish=right.multiplyScalar(horizontal).addScaledVector(forward,-vertical).normalize();
    const desired = this.position.clone().addScaledVector(wish, 3 * delta);
    if (!this.interior) {
      // Match spatial-map continuity: a key selects the arc sign once, then
      // held input carries that sign through bends and the closed seam.
      if (changed || !this.routeSign) {
        const direction = Math.abs(horizontal) >= Math.abs(vertical) && horizontal
          ? horizontal < 0 ? 'left' : 'right' : vertical < 0 ? 'up' : 'down';
        this.routeSign = this.ringChoices(camera as T.PerspectiveCamera, ship).find(s => s.direction === direction)?.sign ?? 0;
      }
      if (!this.routeSign) return;
      const distance = this.routeDistance + this.routeSign * 3 * delta, next = this.ringPoint(distance);
      if (!this.tryFreeStep(next)) return;
      this.facing = voyageScreenFacing(this.position, next, ship, camera, this.facing);
      this.position.copy(next); this.routeDistance = distance; this.moving = true;
      return;
    }
    const next=this.routePoint(desired),offset=next.clone().sub(this.position); offset.y = 0;
    if(offset.lengthSq()<1e-10)return;
    this.ray.set(this.position.clone().add(new T.Vector3(0, .8, 0)), offset.clone().normalize()); this.ray.far = offset.length() + .3;
    if (this.ray.intersectObject(this.mesh, true).length) return;
    // The fixed centreline supplies the lateral boundary; sample the actual
    // feet rather than rejecting its end cap with off-route free-walk probes.
    const height = this.ground(next.x, next.z, this.position.y + .4, .8);
    if (height === undefined || Math.abs(height + .025 - this.position.y) > .4) return;
    next.y = height + .025;
    // The lane may bend away from the key's screen direction at a junction.
    this.facing = voyageScreenFacing(this.position, next, ship, camera, this.facing);
    this.position.copy(next); this.moving = true;
  }
  destroy() {
    [...this.mesh.children, ...this.floor.children].forEach(node => (node as T.Mesh).geometry.dispose());
    this.visualGeometry.forEach(geometry => geometry.dispose());
    this.visualMaterials.forEach(material => material.dispose());
    this.visual.removeFromParent(); this.mesh.clear(); this.floor.clear(); this.material.dispose();
  }
}
