import * as T from 'three';
import layout from '../../../../shared/voyage-deck.json';
import { routeDirectionSlots } from '../henesys/route-directions';
import { berthAislePoint } from './voyage-cabin';

type RuntimePoint = readonly number[];
const originalDeckLimits = {
  xMin: Math.min(...layout.surface.outline.map(p => p[0])), xMax: Math.max(...layout.surface.outline.map(p => p[0])),
  zMin: Math.min(...layout.surface.outline.map(p => p[1])), zMax: Math.max(...layout.surface.outline.map(p => p[1])),
};

/** Shared route JSON stores points as [x, z, y]. Three.js stores them x/y/z. */
function runtimePoint(point: RuntimePoint, fallbackY: number) {
  return new T.Vector3(point[0] ?? 0, point[2] ?? fallbackY, point[1] ?? 0);
}

function onOriginalDeck(point: T.Vector3) {
  return point.x >= originalDeckLimits.xMin && point.x <= originalDeckLimits.xMax
    && point.z >= originalDeckLimits.zMin && point.z <= originalDeckLimits.zMax;
}

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
  private bends: T.Vector3[] = [];
  get cornerLift() { return this.bends.reduce((lift, p) => Math.max(lift, 1 - Math.hypot(p.x - this.position.x, p.z - this.position.z) / 3), 0); }
  get onPlatformAccess() {
    const extent = layout.surface.outline.map(p => p[1]);
    return !this.interior && (this.position.z < Math.min(...extent) || this.position.z > Math.max(...extent));
  }
  private routeDistance = 0;
  private routeSign = 0;
  private heldHorizontal = 0;
  private heldVertical = 0;
  constructor(ship: T.Object3D, private readonly interior = false, private readonly bow = false) {
    ship.updateWorldMatrix(true, true);
    const inverse = ship.matrixWorld.clone().invert(), tiles = new Map<string, number[]>();
    // ponytail: static hull collision only; moving machinery needs separate colliders if made walkable.
    const roots = bow ? layout.bowRoute.floorRoots : interior
      ? [...layout.cabinRoute.floorRoots]
      : ['SV3_CaptainRoom', layout.surface.mesh, ...layout.surface.retainedSurfaces, 'SV3_DeckAccessRails'];
    const ceiling = bow ? Math.max(...layout.bowRoute.nodes.map(point => point[2])) + layout.surface.bodyHeight : interior
      ? Math.max(...Object.values(layout.cabinRoute.nodes).map(point => point[2] ?? layout.surface.height)) + layout.surface.bodyHeight
      : layout.surface.height + layout.surface.bodyHeight;
    const cabinBlockerRoots = bow ? layout.bowRoute.blockerRoots : interior
      ? [
        'SV2_CabinFrontCap',
        ...Array.from({ length: 4 }, (_, index) => `SV2_CabinFrontWindow_0${index + 1}`),
        'SV3_GlassWall_Pier_1', 'SV3_GlassWall_Pier_2', 'SV3_GlassWall_Pier_3', 'SV3_GlassWall_Pier_4',
        'SV3_GlassArchWall_warrior_-1', 'SV3_GlassArchWall_warrior_1',
        'SV3_GlassArchWall_mage_-1', 'SV3_GlassArchWall_mage_1',
        'SV3_GlassArchWall_archer_-1', 'SV3_GlassArchWall_archer_1',
        'SV3_GlassArchWall_rogue_-1', 'SV3_GlassArchWall_rogue_1',
        ...Array.from({ length: 4 }, (_, index) => `SV3_CabinFinish_WindowTrim_0${index + 1}`),
        'SV2_CabinSideWalls', 'SV2_CabinSideBaseTrim_Port', 'SV2_CabinSideBaseTrim_Starboard',
        'SV3_CabinFinish_WallBaseRails', 'SV3_WindowWallRestored_Base', 'SV3_WindowWallRestored_EndPier',
      ]
      : [];
    if (!interior && !bow && !ship.getObjectByName(layout.surface.mesh)) throw new Error('The original main deck floor is missing');
    const collect = (name: string, walkable: boolean) => ship.getObjectByName(name)?.traverse(node => {
      if (!(node instanceof T.Mesh)) return;
      // Account/adventure signs are stage-dependent decoration, never invisible walking walls.
      for(let parent:T.Object3D|null=node;parent;parent=parent.parent) if(['SV2_LoginSign','SV3_AdventureSign'].includes(parent.name)) return;
      const matrix = inverse.clone().multiply(node.matrixWorld), p = node.geometry.attributes.position, index = node.geometry.index;
      for (let i = 0; i < (index?.count ?? p.count); i += 3) {
        const triangle = [0, 1, 2].map(j => new T.Vector3().fromBufferAttribute(p, index ? index.getX(i + j) : i + j).applyMatrix4(matrix));
        // Include the authored upper-platform route, without pulling in buried hull faces.
        if (triangle.every(v => v.y < (interior ? -1 : 0)) || triangle.every(v => v.y > ceiling)) continue;
        const center = triangle.reduce((sum, v) => sum.add(v), new T.Vector3()).divideScalar(3);
        // Cabin route roots are authored support surfaces.  Keep them out of
        // the body-blocking mesh so a sloped strip's side faces cannot look
        // like a wall to the clearance rays while crossing a seam.
        const key = `${walkable ? `floor:${name}:` : ''}${Math.floor(center.x / 4)},${Math.floor(center.z / 4)}`;
        if (!tiles.has(key)) tiles.set(key, []);
        const vertices = tiles.get(key)!;
        for (const v of triangle) vertices.push(v.x, v.y, v.z);
      }
    });
    for (const name of roots) collect(name, bow || interior || (!interior && (name === layout.surface.mesh || (layout.surface.retainedSurfaces as string[]).includes(name))));
    for (const name of cabinBlockerRoots) collect(name, false);
    for (const [key, vertices] of tiles) {
      const geometry = new T.BufferGeometry().setAttribute('position', new T.Float32BufferAttribute(vertices, 3));
      geometry.computeBoundingBox(); geometry.computeBoundingSphere(); const tile = new T.Mesh(geometry, this.material); tile.name = 'SV3_DeckCollisionTile'; (key.startsWith('floor:') ? this.floor : this.mesh).add(tile);
      tile.userData.floorSource = key.startsWith('floor:') ? key.split(':')[1] : undefined;
    }
    if (bow) this.route = layout.bowRoute.nodes.map(point => runtimePoint(point, 0));
    else if (!interior) {
      this.route = layout.routes[0].nodes.map(name => runtimePoint(layout.nodes[name as keyof typeof layout.nodes], layout.surface.height));
      this.bends = this.route.slice(1, -1).filter((p, i) => {
        const incoming = p.clone().sub(this.route[i]), outgoing = this.route[i + 2].clone().sub(p);
        incoming.y = outgoing.y = 0;
        return incoming.normalize().dot(outgoing.normalize()) < .95;
      });
      this.addCaptainDoorSeal(ship);
    }
    else this.addCabinRoute(ship);
    if (this.visual.children.length) {
      this.visual.name = 'SV3_DeckFallbacks';
      ship.add(this.visual);
    }
    // Cabin entry lands on the longitudinal bed aisle. Its ends lead to
    // the stern and main-deck end-wall openings.
    if (bow) this.position.copy(runtimePoint(layout.bowRoute.spawn, 0));
    else if (interior) this.position.copy(runtimePoint(layout.cabinRoute.spawn, 0));
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
    // The original room shell stays on deck; entry uses its existing portal.
    for (const name of ['SV3_CaptainFloor', 'SV3_CaptainDoorThreshold']) {
      const node = ship.getObjectByName(name); if (node) node.visible = true;
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
    const beds = Array.from({ length: 12 }, (_, index) => berthAislePoint(ship, ship, index))
      .filter((point): point is T.Vector3 => Boolean(point));
    beds.forEach(point => point.y = 0);
    // A single aisle along the door-facing ends of the actual beds.  The
    // stern and deck-side opening points are authored in the
    // same shared JSON and have matching exported floor roots.
    beds.sort((a, b) => b.z - a.z);
    const nodes = layout.cabinRoute.nodes;
    const point = (name: keyof typeof nodes) => runtimePoint(nodes[name], 0);
    this.route = [point('09'), ...beds, point('17')];
  }
  private routePoint(point: T.Vector3) {
    return this.nearestRoute(point).point;
  }
  private nearestRoute(point: T.Vector3) {
    let nearest = Infinity, result = this.route[0]?.clone() ?? point.clone(), distance = 0, total = 0;
    for (let i = 0; i < this.route.length - 1; i++) {
      const start = this.route[i], end = this.route[i + 1], length = start.distanceTo(end), segment = end.clone().sub(start); segment.y = 0;
      const offset = point.clone().sub(start); offset.y = 0;
      const amount = segment.lengthSq() ? T.MathUtils.clamp(offset.dot(segment) / segment.lengthSq(), 0, 1) : 0;
      const candidate = start.clone().lerp(end, amount);
      const separation = Math.hypot(candidate.x - point.x, candidate.z - point.z);
      if (separation < nearest) { nearest = separation; result = candidate; distance = total + length * amount; }
      total += length;
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
  /** Arc-length helpers for the open interior route.  Keeping one scalar
   * distance across every knot makes a held direction carry through the bed
   * line and both end-wall openings without re-projecting to the
   * nearest segment at each frame. */
  private openRouteLength() {
    return this.route.slice(1).reduce((sum, point, index) => sum + point.distanceTo(this.route[index]), 0);
  }
  private openRoutePoint(distance: number) {
    const length = this.openRouteLength();
    let remaining = T.MathUtils.clamp(distance, 0, length);
    for (let index = 1; index < this.route.length; index++) {
      const start = this.route[index - 1], end = this.route[index], size = start.distanceTo(end);
      if (remaining <= size || index === this.route.length - 1) return start.clone().lerp(end, size ? remaining / size : 0);
      remaining -= size;
    }
    return this.route.at(-1)?.clone() ?? this.position.clone();
  }
  private openRouteTangent(distance: number, sign: 1 | -1) {
    const length = this.openRouteLength(), probe = Math.min(.35, Math.max(.05, length / 100));
    const from = this.openRoutePoint(T.MathUtils.clamp(distance - sign * probe, 0, length));
    const to = this.openRoutePoint(T.MathUtils.clamp(distance + sign * probe, 0, length));
    const tangent = to.sub(from); tangent.y = 0;
    return tangent.normalize();
  }
  private ringChoices(camera: T.Camera, ship: T.Object3D) {
    const exits = [-1, 1].map(sign => this.ringPoint(this.routeDistance + sign * .3));
    return this.projectChoices(exits, camera, ship).map(slot => ({ ...slot, sign: slot.index === 0 ? -1 : 1 }));
  }
  private projectChoices(exits: T.Vector3[], camera: T.Camera, ship: T.Object3D) {
    const start = ship.localToWorld(this.position.clone()).project(camera);
    return routeDirectionSlots(exits.map(point => {
      point.y = this.position.y;
      const end = ship.localToWorld(point.clone()).project(camera), right = end.x - start.x, down = (start.y - end.y) / (camera.projectionMatrix.elements[5] / camera.projectionMatrix.elements[0]);
      const size = Math.max(1e-9, Math.hypot(right, down));
      return { right: right / size, down: down / size };
    }));
  }
  junctionDirections(camera: T.PerspectiveCamera | T.OrthographicCamera, ship: T.Object3D) {
    if (this.interior || this.bow) return [];
    if (!this.route.slice(1, -1).some(p => Math.hypot(p.x - this.position.x, p.z - this.position.z) < .6)) return [];
    return this.ringChoices(camera, ship).map(s => s.direction);
  }
  private ground(x: number, z: number, ceiling: number, distance: number) {
    this.ray.set(new T.Vector3(x, ceiling, z), new T.Vector3(0, -1, 0)); this.ray.far = distance;
    return this.ray.intersectObject(this.floor, true).find(hit => this.floorSupport(hit))?.point.y;
  }
  private floorSupport(hit: T.Intersection) {
    return Boolean(hit.face && hit.face.normal.y > .65 && (hit.object.userData.floorSource !== layout.surface.mesh || onOriginalDeck(hit.point)));
  }
  reset() { this.place(this.spawn); this.facing = 1; }
  place(point: T.Vector3) {
    const route = this.nearestRoute(point), candidate = route.point;
    if (!this.interior && Math.hypot(candidate.x - point.x, candidate.z - point.z) > 1) return false;
    const height = this.ground(candidate.x, candidate.z, candidate.y + .4, .8);
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
    // Horizontal rings miss the inside of a low, nearly flat prow shell.
    // Walking support must also leave vertical clearance for the whole body.
    this.ray.set(new T.Vector3(point.x, height + .05, point.z), new T.Vector3(0, 1, 0));
    this.ray.far = layout.surface.bodyHeight - .05;
    if (this.ray.intersectObject(this.mesh, true).length) return false;
    for (const y of [.3, .85, layout.surface.bodyHeight - .15]) for (let angle = 0; angle < 8; angle++) {
      this.ray.set(new T.Vector3(point.x, height + y, point.z), new T.Vector3(Math.cos(angle * Math.PI / 4), 0, Math.sin(angle * Math.PI / 4)));
      this.ray.far = radius;
      if (this.ray.intersectObject(this.mesh, true).length) return false;
    }
    return true;
  }
  private tryFreeStep(next: T.Vector3) {
    const rayCeiling = Math.max(this.position.y, next.y) + .45;
    const rayDistance = Math.max(.8, Math.abs(next.y - this.position.y) + .9);
    const height = this.ground(next.x, next.z, rayCeiling, rayDistance);
    if (height === undefined || Math.abs(height + .025 - this.position.y) > .45 || !this.canStand(next, height)) return false;
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
  /** Detailed one-step diagnostics for authored route seam checks. */
  debugStep(next: T.Vector3) {
    const radius = layout.surface.bodyRadius;
    const rayCeiling = Math.max(this.position.y, next.y) + .45;
    const rayDistance = Math.max(.8, Math.abs(next.y - this.position.y) + .9);
    const hitSummary = (root: T.Object3D, origin: T.Vector3, direction: T.Vector3, far: number) => {
      this.ray.set(origin, direction); this.ray.far = far;
      return this.ray.intersectObject(root, true).filter(hit => root !== this.floor || this.floorSupport(hit)).slice(0, 8).map(hit => ({
        object: hit.object.name, distance: hit.distance, normalY: hit.face?.normal.y ?? null,
      }));
    };
    const sample = (point: T.Vector3, ceiling: number, far: number) => {
      const hits = hitSummary(this.floor, new T.Vector3(point.x, ceiling, point.z), new T.Vector3(0, -1, 0), far);
      const support = hits.find(hit => hit.normalY !== null && hit.normalY > .65);
      return { coordinate: point.toArray(), height: support ? ceiling - support.distance : null, hits };
    };
    const center = sample(next, rayCeiling, rayDistance);
    const supports = [[0, 0], [radius, 0], [-radius, 0], [0, radius], [0, -radius]].map(([x, z]) => {
      const result = sample(new T.Vector3(next.x + x, next.y, next.z + z), (center.height ?? next.y) + .4, .8);
      const height = result.height;
      return { offset: [x, z], ...result, delta: height === null || center.height === null ? null : Math.abs(height - center.height), allowedDelta: .25, ok: height !== null && center.height !== null && Math.abs(height - center.height) <= .25 };
    });
    const supportOk = supports.every(item => item.ok);
    const verticalHits = hitSummary(this.mesh, new T.Vector3(next.x, (center.height ?? next.y) + .05, next.z), new T.Vector3(0, 1, 0), layout.surface.bodyHeight - .05);
    const horizontalHits = [.3, .85, layout.surface.bodyHeight - .15].flatMap(y => {
      const offset = next.clone().sub(this.position); offset.y = 0;
      if (offset.lengthSq() < 1e-10) return [];
      return hitSummary(this.mesh, this.position.clone().add(new T.Vector3(0, y, 0)), offset.normalize(), offset.length() + radius).map(hit => ({ y, ...hit }));
    });
    const stand = center.height !== null && Math.abs(center.height + .025 - this.position.y) <= .45 && supportOk && verticalHits.length === 0 && horizontalHits.length === 0;
    const candidate = next.clone();
    const step = this.tryFreeStep(candidate);
    return {
      current: this.position.toArray(), candidate: next.toArray(), rayCeiling, rayDistance,
      center, supports, supportOk, verticalHits, horizontalHits, stand, step, steppedCandidate: candidate.toArray(),
      heightDelta: center.height === null ? null : Math.abs(center.height + .025 - this.position.y), allowedHeightDelta: .45,
      radius, bodyHeight: layout.surface.bodyHeight, blockerTiles: this.mesh.children.length,
    };
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
    if (!this.interior && !this.bow) {
      // Match spatial-map continuity: a key selects the arc sign once, then
      // held input carries that sign through bends and the closed seam.
      if (changed || !this.routeSign) {
        const direction = Math.abs(horizontal) >= Math.abs(vertical) && horizontal
          ? horizontal < 0 ? 'left' : 'right' : vertical < 0 ? 'up' : 'down';
        this.routeSign = this.ringChoices(camera, ship).find(s => s.direction === direction)?.sign ?? 0;
      }
      if (!this.routeSign) return;
      const distance = this.routeDistance + this.routeSign * 3 * delta, next = this.ringPoint(distance);
      if (!this.tryFreeStep(next)) return;
      this.facing = voyageScreenFacing(this.position, next, ship, camera, this.facing);
      this.position.copy(next); this.routeDistance = distance; this.moving = true;
      return;
    }
    const length = this.openRouteLength();
    const currentDistance = T.MathUtils.clamp(this.routeDistance, 0, length);
    if (changed || !this.routeSign) {
      const forward = this.openRouteTangent(currentDistance, 1);
      const backward = this.openRouteTangent(currentDistance, -1);
      this.routeSign = wish.dot(forward) >= wish.dot(backward) ? 1 : -1;
    }
    const nextDistance = T.MathUtils.clamp(currentDistance + this.routeSign * 3 * delta, 0, length);
    if (Math.abs(nextDistance - currentDistance) < 1e-8) return;
    const next = this.openRoutePoint(nextDistance);
    if (!this.tryFreeStep(next)) return;
    this.facing = voyageScreenFacing(this.position, next, ship, camera, this.facing);
    this.position.copy(next); this.routeDistance = nextDistance; this.moving = true;
  }
  destroy() {
    [...this.mesh.children, ...this.floor.children].forEach(node => (node as T.Mesh).geometry.dispose());
    this.visualGeometry.forEach(geometry => geometry.dispose());
    this.visualMaterials.forEach(material => material.dispose());
    this.visual.removeFromParent(); this.mesh.clear(); this.floor.clear(); this.material.dispose();
  }
}
