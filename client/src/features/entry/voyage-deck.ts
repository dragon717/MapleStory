import * as T from 'three';
import layout from '../../../../shared/voyage-deck.json';

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
  private material = new T.MeshBasicMaterial({ side: T.DoubleSide });
  private visual = new T.Group();
  private visualGeometry: T.BufferGeometry[] = [];
  private visualMaterials: T.Material[] = [];
  private ray = new T.Raycaster();
  private route: T.Vector3[] = [];
  constructor(ship: T.Object3D, interior = false) {
    ship.updateWorldMatrix(true, true);
    const inverse = ship.matrixWorld.clone().invert(), tiles = new Map<string, number[]>();
    // ponytail: static hull collision only; moving machinery needs separate colliders if made walkable.
    const roots = interior
      ? ['SV2_CabinFloor']
      : ['SV3_Hull'];
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
        const key = `${Math.floor(center.x / 4)},${Math.floor(center.z / 4)}`;
        if (!tiles.has(key)) tiles.set(key, []);
        const vertices = tiles.get(key)!;
        for (const v of triangle) vertices.push(v.x, v.y, v.z);
      }
    });
    for (const vertices of tiles.values()) {
      const geometry = new T.BufferGeometry().setAttribute('position', new T.Float32BufferAttribute(vertices, 3));
      geometry.computeBoundingBox(); geometry.computeBoundingSphere(); const tile = new T.Mesh(geometry, this.material); tile.name = 'SV3_DeckCollisionTile'; this.mesh.add(tile);
    }
    if (!interior) { this.addCaptainArcWalkway(ship); this.addCaptainDoorSeal(ship); }
    else this.addCabinRoute(ship);
    if (this.visual.children.length) {
      this.visual.name = 'SV3_CaptainArcWalkway';
      ship.add(this.visual);
    }
    if (interior) this.position.copy(this.route[0]);
    else {
      // Login lands at the authored starboard boarding node.  The captain
      // room is reached through the visible arc and Space interaction.
      const spawn = layout.nodes['右舷登船位'];
      this.position.copy(this.routePoint(new T.Vector3(spawn[0], 0, spawn[1])));
    }
    const height = this.ground(this.position.x, this.position.z, this.position.y + .4, .8);
    if (height !== undefined) this.position.y = height + .025;
    this.spawn.copy(this.position);
  }
  /**
   * The authored captain room has a side door beside the main deck.  The
   * retained hull has no continuous visible floor from the starboard route to
   * that door, so add a short supported arc using the same local-space
   * contract as the triangle collider.  This is a real walk surface; it is not
   * a global collision bypass or an invisible teleport lane.
   */
  private addCaptainArcWalkway(ship: T.Object3D) {
    const points = layout.walkways?.captainArc?.points ?? [
      [6.45, 5.445, 12.0], [6.90, 5.45, 12.20], [7.30, 5.46, 12.45],
      [7.45, 5.47, 12.80], [7.10, 5.46, 13.05], [6.45, 5.44, 13.22],
      [5.65, 5.42, 13.25],
    ];
    const width = layout.walkways?.captainArc?.width ?? .8;
    const vectors = points.map(point => new T.Vector3(point[0], point[1], point[2]));
    this.route = vectors;
    const positions: number[] = [];
    for (let i = 0; i < vectors.length; i++) {
      const previous = vectors[Math.max(0, i - 1)], next = vectors[Math.min(vectors.length - 1, i + 1)];
      const tangent = next.clone().sub(previous); tangent.y = 0; tangent.normalize();
      const side = new T.Vector3(-tangent.z, 0, tangent.x).multiplyScalar(width / 2);
      const left = vectors[i].clone().add(side), right = vectors[i].clone().sub(side);
      positions.push(left.x, left.y, left.z, right.x, right.y, right.z);
    }
    const vertices: number[] = [];
    for (let i = 0; i < positions.length / 3; i++) {
      vertices.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    }
    const faces: number[] = [];
    for (let i = 0; i < vectors.length - 1; i++) {
      const base = i * 2;
      // left→right→next-left points down with this ribbon orientation.  Wind
      // the triangles upward so ground() recognises the added surface as a
      // walkable deck instead of treating it as a ceiling.
      faces.push(base, base + 3, base + 1, base, base + 2, base + 3);
    }
    const collider = new T.BufferGeometry().setAttribute('position', new T.Float32BufferAttribute(vertices, 3));
    collider.setIndex(faces); collider.computeVertexNormals(); collider.computeBoundingBox(); collider.computeBoundingSphere();
    const arcCollider = new T.Mesh(collider, this.material); arcCollider.name = 'SV3_CaptainArcWalkway_Collider'; this.mesh.add(arcCollider);
    if (ship.getObjectByName('SV3_CaptainArcWalkway_Surface')) return;
    const source = ship.getObjectByName('SV3_M_Wood');
    const material = source instanceof T.Mesh
      ? (Array.isArray(source.material) ? source.material[0] : source.material).clone()
      : new T.MeshStandardMaterial({ color: '#765033', roughness: .78, metalness: 0 });
    this.visualMaterials.push(material);
    const visual = new T.Mesh(collider.clone(), material); visual.name = 'SV3_CaptainArcWalkway_Surface';
    visual.receiveShadow = true; visual.castShadow = true; this.visual.add(visual); this.visualGeometry.push(visual.geometry);

    const railMaterial = material.clone(); railMaterial.color = new T.Color('#a47743'); railMaterial.roughness = .58;
    this.visualMaterials.push(railMaterial);
    const rails = [-1, 1].map(side => vectors.map((point, index) => {
      const previous = vectors[Math.max(0, index - 1)], next = vectors[Math.min(vectors.length - 1, index + 1)];
      const tangent = next.clone().sub(previous); tangent.y = 0; tangent.normalize();
      return point.clone().add(new T.Vector3(-tangent.z, 0, tangent.x).multiplyScalar(side * width * .46 + 0.01)).add(new T.Vector3(0, .5, 0));
    }));
    rails.forEach(path => {
      const geometry = new T.TubeGeometry(new T.CatmullRomCurve3(path), Math.max(4, path.length * 3), .08, 6, false);
      geometry.computeBoundingSphere(); const mesh = new T.Mesh(geometry, railMaterial); mesh.name = 'SV3_CaptainArcWalkway_Rail'; mesh.castShadow = true; this.visual.add(mesh); this.visualGeometry.push(geometry);
    });
    // Visible piers make the raised route read as part of the ship hull rather
    // than a floating debug plane.  They are decoration only; the top ribbon
    // above is the collision surface.
    const pierGeometry = new T.BoxGeometry(.16, 1, .16); this.visualGeometry.push(pierGeometry);
    for (let i = 1; i < vectors.length - 1; i += 2) {
      const pier = new T.Mesh(pierGeometry, railMaterial); pier.position.copy(vectors[i]).add(new T.Vector3(0, -.42, 0)); pier.scale.y = Math.max(.35, vectors[i].y + .45); pier.castShadow = true; pier.receiveShadow = true; this.visual.add(pier);
    }
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
    const portal = ship.getObjectByName('SV3_CabinDeckPortal');
    const entry = portal ? ship.worldToLocal(portal.getWorldPosition(new T.Vector3())) : new T.Vector3(0, 0, 47.1);
    entry.y = 0;
    const beds = Array.from({ length: 12 }, (_, index) => ship.getObjectByName(`SV2_Bed_${index}_FootAnchor`))
      .filter((anchor): anchor is T.Object3D => Boolean(anchor))
      .map(anchor => ship.worldToLocal(anchor.getWorldPosition(new T.Vector3())).add(new T.Vector3(0, 0, .6)));
    beds.forEach(point => point.y = 0);
    // A single aisle along the door-facing ends of the actual beds. The
    // short portal lead-in joins it without crossing any mattress.
    beds.sort((a, b) => a.x - b.x);
    const junction = new T.Vector3(entry.x, 0, beds[0]?.z ?? 45.3);
    this.route = [entry, junction, ...beds];
  }
  private routePoint(point: T.Vector3) {
    let nearest = Infinity, result = this.route[0]?.clone() ?? point.clone();
    for (let i = 0; i < this.route.length - 1; i++) {
      const start = this.route[i], end = this.route[i + 1], segment = end.clone().sub(start); segment.y = 0;
      const offset = point.clone().sub(start); offset.y = 0;
      const amount = segment.lengthSq() ? T.MathUtils.clamp(offset.dot(segment) / segment.lengthSq(), 0, 1) : 0;
      const candidate = start.clone().lerp(end, amount), distance = Math.hypot(candidate.x - point.x, candidate.z - point.z);
      if (distance < nearest) { nearest = distance; result = candidate; }
    }
    return result;
  }
  private ground(x: number, z: number, ceiling: number, distance: number) {
    this.ray.set(new T.Vector3(x, ceiling, z), new T.Vector3(0, -1, 0)); this.ray.far = distance;
    return this.ray.intersectObject(this.mesh, true).find(hit => hit.face && hit.face.normal.y > .65)?.point.y;
  }
  reset() { this.place(this.spawn); this.facing = 1; }
  place(point: T.Vector3) {
    this.position.copy(this.routePoint(point));
    const height = this.ground(this.position.x, this.position.z, this.position.y + .4, .8);
    this.position.y = (height ?? this.position.y) + .025;
    this.moving = false; this.jumpHeight = 0; this.jumpVelocity = 0;
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
    if(!horizontal&&!vertical)return;
    const inverse = ship.getWorldQuaternion(new T.Quaternion()).invert();
    const forward = camera.getWorldDirection(new T.Vector3()).applyQuaternion(inverse); forward.y = 0; forward.normalize();
    const right = forward.clone().cross(new T.Vector3(0, 1, 0));
    const wish=right.multiplyScalar(horizontal).addScaledVector(forward,-vertical).normalize();
    const next=this.routePoint(this.position.clone().addScaledVector(wish,3*delta)),offset=next.clone().sub(this.position); offset.y = 0;
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
    this.mesh.children.forEach(node => (node as T.Mesh).geometry.dispose());
    this.visualGeometry.forEach(geometry => geometry.dispose());
    this.visualMaterials.forEach(material => material.dispose());
    this.visual.removeFromParent(); this.mesh.clear(); this.material.dispose();
  }
}
