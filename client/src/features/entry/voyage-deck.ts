import * as T from 'three';

/** Lobby-only walking on the supplied hull, in ship-local metres. */
export class VoyageDeck {
  readonly position = new T.Vector3(6.5, 0, 12);
  readonly spawn = new T.Vector3();
  moving = false;
  facing = 1;
  private mesh = new T.Group();
  private material = new T.MeshBasicMaterial({ side: T.DoubleSide });
  private ray = new T.Raycaster();
  constructor(ship: T.Object3D) {
    ship.updateWorldMatrix(true, true);
    const inverse = ship.matrixWorld.clone().invert(), tiles = new Map<string, number[]>();
    // ponytail: static hull collision only; moving machinery needs separate colliders if made walkable.
    ship.getObjectByName('SV3_Hull')?.traverse(node => {
      if (!(node instanceof T.Mesh)) return;
      const matrix = inverse.clone().multiply(node.matrixWorld), p = node.geometry.attributes.position, index = node.geometry.index;
      for (let i = 0; i < (index?.count ?? p.count); i += 3) {
        const triangle = [0, 1, 2].map(j => new T.Vector3().fromBufferAttribute(p, index ? index.getX(i + j) : i + j).applyMatrix4(matrix));
        // Main deck and its rails; roof galleries are outside this lobby walking surface.
        if (triangle.every(v => v.y < 0) || triangle.every(v => v.y > 10)) continue;
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
    const height = this.ground(this.position.x, this.position.z, 10, 10);
    if (height !== undefined) this.position.y = height + .025;
    this.spawn.copy(this.position);
  }
  private ground(x: number, z: number, ceiling: number, distance: number) {
    this.ray.set(new T.Vector3(x, ceiling, z), new T.Vector3(0, -1, 0)); this.ray.far = distance;
    return this.ray.intersectObject(this.mesh, true).find(hit => hit.face && hit.face.normal.y > .65)?.point.y;
  }
  reset() { this.position.copy(this.spawn); this.moving = false; this.facing = 1; }
  update(delta: number, horizontal: number, vertical: number, camera: T.Camera, ship: T.Object3D) {
    this.moving = false;
    if (!Number.isFinite(delta) || delta <= 0 || (!horizontal && !vertical)) return;
    const inverse = ship.getWorldQuaternion(new T.Quaternion()).invert();
    const forward = camera.getWorldDirection(new T.Vector3()).applyQuaternion(inverse); forward.y = 0; forward.normalize();
    const right = forward.clone().cross(new T.Vector3(0, 1, 0));
    const offset = right.multiplyScalar(horizontal).addScaledVector(forward, -vertical).normalize().multiplyScalar(3 * Math.min(delta, .05));
    this.ray.set(this.position.clone().add(new T.Vector3(0, .8, 0)), offset.clone().normalize()); this.ray.far = offset.length() + .3;
    if (this.ray.intersectObject(this.mesh, true).length) return;
    const next = this.position.clone().add(offset), heights: number[] = [];
    for (const [x, z] of [[0, 0], [.25, 0], [-.25, 0], [0, .25], [0, -.25]]) {
      const height = this.ground(next.x + x, next.z + z, this.position.y + .4, .8);
      if (height === undefined || Math.abs(height + .025 - this.position.y) > .4) return;
      heights.push(height);
    }
    next.y = heights[0] + .025; this.position.copy(next); this.moving = true;
    if (horizontal) this.facing = horizontal > 0 ? -1 : 1;
  }
  destroy() { this.mesh.children.forEach(node => (node as T.Mesh).geometry.dispose()); this.material.dispose(); }
}
