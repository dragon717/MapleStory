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
  private ray = new T.Raycaster();
  constructor(ship: T.Object3D, interior = false) {
    ship.updateWorldMatrix(true, true);
    const inverse = ship.matrixWorld.clone().invert(), tiles = new Map<string, number[]>();
    // ponytail: static hull collision only; moving machinery needs separate colliders if made walkable.
    const roots = interior ? ['SV3_CabinInterior'] : ['SV3_Hull', 'SV3_CaptainRoom'];
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
      geometry.computeBoundingBox(); geometry.computeBoundingSphere(); this.mesh.add(new T.Mesh(geometry, this.material));
    }
    if (interior) this.position.set(0, 0, 47);
    else { const room=ship.getObjectByName('SV3_CaptainPortal'); if(room)this.position.copy(ship.worldToLocal(room.getWorldPosition(new T.Vector3()))).add(new T.Vector3(-1.65,0,-3.25)); }
    const height = this.ground(this.position.x, this.position.z, this.position.y > 0 ? this.position.y + .4 : 10, 10);
    if (height !== undefined) this.position.y = height + .025;
    this.spawn.copy(this.position);
  }
  private ground(x: number, z: number, ceiling: number, distance: number) {
    this.ray.set(new T.Vector3(x, ceiling, z), new T.Vector3(0, -1, 0)); this.ray.far = distance;
    return this.ray.intersectObject(this.mesh, true).find(hit => hit.face && hit.face.normal.y > .65)?.point.y;
  }
  reset() { this.place(this.spawn); this.facing = 1; }
  place(point: T.Vector3) { this.position.copy(point); this.moving = false; this.jumpHeight = 0; this.jumpVelocity = 0; }
  jump() { if (!this.jumping) this.jumpVelocity = 7; }
  /** Authored junction markers remain useful while the feet follow the visible floor. */
  hints(camera:T.Camera, ship:T.Object3D) {
    if (!Object.values(layout.nodes).some(p => Math.hypot(p[0]-this.position.x,p[1]-this.position.z)<.65)) return [];
    const inverse=ship.getWorldQuaternion(new T.Quaternion()).invert();
    const forward=camera.getWorldDirection(new T.Vector3()).applyQuaternion(inverse);forward.y=0;forward.normalize();
    const right=forward.clone().cross(new T.Vector3(0,1,0));
    return (['up','down','left','right'] as const).filter(direction=> {
      const wish=direction==='up'?forward:direction==='down'?forward.clone().negate():direction==='left'?right.clone().negate():right;
      return this.ground(this.position.x+wish.x*.5,this.position.z+wish.z*.5,this.position.y+.4,.8)!==undefined;
    });
  }
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
    const next=this.position.clone().addScaledVector(wish,3*delta),offset=next.clone().sub(this.position);
    if(offset.lengthSq()<1e-10)return;
    this.ray.set(this.position.clone().add(new T.Vector3(0, .8, 0)), offset.clone().normalize()); this.ray.far = offset.length() + .3;
    if (this.ray.intersectObject(this.mesh, true).length) return;
    const heights: number[] = [];
    for (const [x, z] of [[0, 0], [.25, 0], [-.25, 0], [0, .25], [0, -.25]]) {
      const height = this.ground(next.x + x, next.z + z, this.position.y + .4, .8);
      if (height === undefined || Math.abs(height + .025 - this.position.y) > .4) return;
      heights.push(height);
    }
    next.y = heights[0] + .025;
    // The lane may bend away from the key's screen direction at a junction.
    this.facing = voyageScreenFacing(this.position, next, ship, camera, this.facing);
    this.position.copy(next); this.moving = true;
  }
  destroy() { this.mesh.children.forEach(node => (node as T.Mesh).geometry.dispose()); this.material.dispose(); }
}
