import * as T from 'three';

type PageEdge = { a: number; b: number; length: number; stiffness: number };

export type VoyageBookPageClothOptions = {
  side?: -1 | 1;
  pageIndex?: number;
  columns?: number;
  rows?: number;
  width?: number;
  height?: number;
  frontDepth?: number;
  pageSpacing?: number;
};

const clamp = (value: number, min = 0, max = 1) => T.MathUtils.clamp(value, min, max);
const smooth = (value: number) => {
  value = clamp(value);
  return value * value * (3 - 2 * value);
};

/**
 * A small fixed-step Verlet sheet used by the departure book.
 *
 * The spine column is the only pinned edge.  A page is released from the
 * inside of the stack and settles onto a curved open-spread rest pose.  The
 * target pose is only a guide: the sheet is still integrated with gravity and
 * structural, shear and bending links, so the edge keeps a soft fold while it
 * turns.  Coordinates are local glTF book coordinates: X is width, Y is page
 * height and Z points toward the readable page face.
 */
export class VoyageBookPageCloth {
  readonly side: -1 | 1;
  readonly pageIndex: number;
  readonly columns: number;
  readonly rows: number;
  readonly width: number;
  readonly height: number;
  /** Runtime glTF depth of the page's readable face. */
  readonly frontDepth: number;
  readonly pageSpacing: number;
  readonly hinge: number;
  readonly closedAngle = 1.45;
  readonly rest: Float32Array;
  readonly closed: Float32Array;
  readonly positions: Float32Array;
  readonly previous: Float32Array;
  private readonly dynamic: Float32Array;
  private readonly edges: PageEdge[] = [];
  private pending = 0;

  constructor(options: VoyageBookPageClothOptions = {}) {
    this.side = options.side ?? 1;
    this.pageIndex = options.pageIndex ?? 0;
    this.columns = Math.max(4, options.columns ?? 8);
    this.rows = Math.max(6, options.rows ?? 12);
    this.width = options.width ?? .60;
    this.height = options.height ?? 1.0;
    // The opened cover now folds away toward runtime -Z. Keep the readable
    // page face in the positive-Z render layer so the cover cannot sit in
    // front of the paper when the book is viewed from +Z.
    this.frontDepth = options.frontDepth ?? .105;
    this.pageSpacing = options.pageSpacing ?? .004;
    this.hinge = this.side * .075;
    const count = (this.columns + 1) * (this.rows + 1) * 3;
    this.rest = new Float32Array(count);
    this.closed = new Float32Array(count);

    for (let row = 0; row <= this.rows; row++) for (let column = 0; column <= this.columns; column++) {
      const offset = (row * (this.columns + 1) + column) * 3;
      const across = column / this.columns;
      const y = (.5 - row / this.rows) * this.height;
      // A squared sine eases out of the spine with zero slope.  That lets the
      // rotated curve keep every vertex on its own side even at ±1.45 rad.
      const curve = Math.sin(Math.PI * across) ** 2 * .030 * (1 - .10 * Math.abs(y / this.height));
      const depth = this.frontDepth + this.pageIndex * this.pageSpacing + curve;
      this.rest[offset] = this.hinge + this.side * this.width * across;
      this.rest[offset + 1] = y;
      this.rest[offset + 2] = depth;

      // Rotate the complete rest path around the spine.  The curve is part of
      // the local path before rotation, so every horizontal edge keeps its
      // authored length while the page is folded into the inner paper stack.
      // `closedAngle` is a positive magnitude; the side sign belongs only to
      // X, leaving both halves on the readable (+Z) face of the book.
      const angle = this.closedAngle;
      const u = this.width * across;
      const rotatedX = this.side * (u * Math.cos(angle) - curve * Math.sin(angle));
      const rotatedZ = u * Math.sin(angle) + curve * Math.cos(angle);
      this.closed[offset] = this.hinge + rotatedX;
      this.closed[offset + 1] = y;
      this.closed[offset + 2] = this.frontDepth + this.pageIndex * this.pageSpacing + rotatedZ;
    }
    this.positions = this.closed.slice();
    this.previous = this.closed.slice();
    this.dynamic = new Float32Array(this.positions.length / 3);
    const add = (a: number, b: number, stiffness: number) => {
      const ax = this.rest[a * 3], ay = this.rest[a * 3 + 1], az = this.rest[a * 3 + 2];
      const bx = this.rest[b * 3], by = this.rest[b * 3 + 1], bz = this.rest[b * 3 + 2];
      const length = Math.hypot(ax - bx, ay - by, az - bz);
      if (length > 1e-7) this.edges.push({ a, b, length, stiffness });
    };
    for (let row = 0; row <= this.rows; row++) for (let column = 0; column <= this.columns; column++) {
      const index = row * (this.columns + 1) + column;
      if (column < this.columns) add(index, index + 1, 1);
      if (row < this.rows) add(index, index + this.columns + 1, 1);
      if (column < this.columns && row < this.rows) {
        add(index, index + this.columns + 2, .86);
        add(index + 1, index + this.columns + 1, .86);
      }
      if (column + 2 <= this.columns) add(index, index + 2, .34);
      if (row + 2 <= this.rows) add(index, index + 2 * (this.columns + 1), .34);
    }
  }

  private target(index: number, progress: number, out = new T.Vector3()) {
    const column = index % (this.columns + 1);
    const row = Math.floor(index / (this.columns + 1));
    const across = column / this.columns;
    const released = this.release(progress);
    const angle = this.closedAngle * (1 - released);
    const y = (.5 - row / this.rows) * this.height;
    const curve = Math.sin(Math.PI * across) ** 2 * .030 * (1 - .10 * Math.abs(y / this.height));
    const u = this.width * across;
    // Rotate a page-width path about the inner spine.  This preserves the
    // sheet's width at every frame; only its direction changes.  Both sides
    // use the same positive readable-face depth, while X stays on its half.
    out.x = this.hinge + this.side * (u * Math.cos(angle) - curve * Math.sin(angle));
    out.y = y;
    out.z = this.frontDepth + this.pageIndex * this.pageSpacing + u * Math.sin(angle) + curve * Math.cos(angle);
    // The free edge lags behind the hinge, then relaxes as the page settles.
    // This depth-only fold keeps the visible page face away from the cover.
    const bendRelease = smooth(clamp((released - .16) / .84));
    out.z += Math.sin(Math.PI * bendRelease) * .10 * across * across;
    out.y += Math.sin(Math.PI * bendRelease) * .045 * across * Math.sin(Math.PI * row / this.rows);
    return out;
  }

  private release(progress: number) {
    return smooth(clamp(progress * 1.08 - this.pageIndex * .045));
  }

  private weight(index: number, progress: number) {
    const column = index % (this.columns + 1);
    if (column === 0) return 0;
    return this.release(progress);
  }

  private setPose(pose: Float32Array) {
    this.positions.set(pose);
    this.previous.set(pose);
  }

  private enforceBounds(index: number) {
    const offset = index * 3;
    const column = index % (this.columns + 1);
    const floor = this.frontDepth + this.pageIndex * this.pageSpacing + .006;
    if (!Number.isFinite(this.positions[offset]) || !Number.isFinite(this.positions[offset + 1]) || !Number.isFinite(this.positions[offset + 2])) {
      const goal = this.target(index, 0, new T.Vector3());
      this.positions[offset] = this.previous[offset] = goal.x;
      this.positions[offset + 1] = this.previous[offset + 1] = goal.y;
      this.positions[offset + 2] = this.previous[offset + 2] = Math.max(goal.z, floor);
      return;
    }
    if (column === 0) {
      this.positions[offset] = this.previous[offset] = this.hinge;
      return;
    }
    // Keep released vertices in their authored half of the spread.  The
    // spine is fixed separately above, so this is a strict one-sided guard.
    const sideX = this.hinge + this.side * .0005;
    if (this.side < 0 ? this.positions[offset] > sideX : this.positions[offset] < sideX) {
      this.positions[offset] = this.previous[offset] = sideX;
    }
    if (this.positions[offset + 2] < floor) {
      this.positions[offset + 2] = this.previous[offset + 2] = floor;
    }
  }

  reset() {
    this.pending = 0;
    this.setPose(this.closed);
  }

  /** Advance the page at a deterministic 60 Hz fixed step. */
  advance(delta: number, progress: number, reduced = false) {
    progress = clamp(progress);
    if (progress <= .001) { this.reset(); return; }
    if (progress >= .998 || reduced) { this.pending = 0; this.setPose(this.rest); return; }
    if (!Number.isFinite(delta) || delta <= 0) return;
    this.pending += Math.min(delta, .05);
    const target = new T.Vector3();
    const dt = 1 / 60;
    while (this.pending >= dt) {
      this.pending -= dt;
      for (let index = 0; index < this.dynamic.length; index++) {
        const weight = this.dynamic[index] = this.weight(index, progress);
        const goal = this.target(index, progress, target);
        const offset = index * 3;
        if (weight <= 0) {
          this.positions[offset] = this.previous[offset] = goal.x;
          this.positions[offset + 1] = this.previous[offset + 1] = goal.y;
          this.positions[offset + 2] = this.previous[offset + 2] = goal.z;
          this.enforceBounds(index);
          continue;
        }
        const x = this.positions[offset], y = this.positions[offset + 1], z = this.positions[offset + 2];
        this.positions[offset] += (x - this.previous[offset]) * .988;
        this.positions[offset + 1] += (y - this.previous[offset + 1]) * .988 - 2.6 * dt * dt;
        this.positions[offset + 2] += (z - this.previous[offset + 2]) * .988;
        this.previous[offset] = x; this.previous[offset + 1] = y; this.previous[offset + 2] = z;
        // Keep a light target spring after release.  It prevents a fully free
        // sheet from slowly rotating away from the open spread while leaving
        // most of the motion to Verlet and the edge constraints.
        const targetBlend = Math.max(.08, 1 - weight);
        this.positions[offset] = T.MathUtils.lerp(goal.x, this.positions[offset], 1 - targetBlend);
        this.positions[offset + 1] = T.MathUtils.lerp(goal.y, this.positions[offset + 1], 1 - targetBlend);
        this.positions[offset + 2] = T.MathUtils.lerp(goal.z, this.positions[offset + 2], 1 - targetBlend);
        this.enforceBounds(index);
      }
      for (let pass = 0; pass < 12; pass++) {
        for (const edge of this.edges) {
          const wa = this.dynamic[edge.a], wb = this.dynamic[edge.b], total = wa + wb;
          if (total <= 1e-6) continue;
          const a = edge.a * 3, b = edge.b * 3;
          const dx = this.positions[b] - this.positions[a];
          const dy = this.positions[b + 1] - this.positions[a + 1];
          const dz = this.positions[b + 2] - this.positions[a + 2];
          const distance = Math.hypot(dx, dy, dz);
          if (distance <= 1e-7) continue;
          const correction = (distance - edge.length) / distance * edge.stiffness;
          this.positions[a] += dx * correction * wa / total;
          this.positions[a + 1] += dy * correction * wa / total;
          this.positions[a + 2] += dz * correction * wa / total;
          this.positions[b] -= dx * correction * wb / total;
          this.positions[b + 1] -= dy * correction * wb / total;
          this.positions[b + 2] -= dz * correction * wb / total;
        }
        // The spring target is applied once before this projection block.
        // Reapplying it after every edge would stretch the sheet toward the
        // kinematic pose and undo the cloth constraint we just solved.
        for (let index = 0; index < this.dynamic.length; index++) this.enforceBounds(index);
      }
    }
  }
}

type PageSurface = { cloth: VoyageBookPageCloth; mesh: T.Mesh; material: T.Material };

export type VoyageBookPageRig = {
  readonly pages: readonly PageSurface[];
  update(delta: number, progress: number, reduced?: boolean): void;
  reset(): void;
  dispose(): void;
};

const RIG_KEY = '__sv3VoyageBookPageRig';

function pageGeometry(cloth: VoyageBookPageCloth) {
  const geometry = new T.BufferGeometry();
  geometry.setAttribute('position', new T.BufferAttribute(cloth.positions, 3));
  const uv = new Float32Array((cloth.columns + 1) * (cloth.rows + 1) * 2);
  for (let row = 0; row <= cloth.rows; row++) for (let column = 0; column <= cloth.columns; column++) {
    const index = (row * (cloth.columns + 1) + column) * 2;
    uv[index] = column / cloth.columns;
    uv[index + 1] = 1 - row / cloth.rows;
  }
  geometry.setAttribute('uv', new T.BufferAttribute(uv, 2));
  const indices: number[] = [];
  for (let row = 0; row < cloth.rows; row++) for (let column = 0; column < cloth.columns; column++) {
    const a = row * (cloth.columns + 1) + column, b = a + 1, c = a + cloth.columns + 1, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function sourceMaterial(root: T.Object3D, side: -1 | 1, page: number) {
  const source = root.getObjectByName(`SV3_Page_${side < 0 ? 'L' : 'R'}_${page.toString().padStart(2, '0')}_S00`);
  const material = source instanceof T.Mesh
    ? (Array.isArray(source.material) ? source.material[0] : source.material)
    : undefined;
  const copy = material?.clone() ?? new T.MeshStandardMaterial({ color: page % 2 ? '#f8e9bd' : '#e7d3a1' });
  if ('side' in copy) (copy as T.MeshStandardMaterial).side = T.DoubleSide;
  if ('roughness' in copy) (copy as T.MeshStandardMaterial).roughness = .86;
  return copy;
}

/**
 * Bind the physical pages to an authored departure-book GLB.
 *
 * The authored segmented page nodes remain in the GLB as editable fallback
 * geometry and animation.  Once this helper is bound they are hidden and the
 * higher-resolution page surfaces below take over; covers, spine and glow keep
 * using the authored animation clip.
 */
export function createVoyageBookPageRig(source: T.Object3D): VoyageBookPageRig {
  const existing = source.userData[RIG_KEY] as VoyageBookPageRig | undefined;
  if (existing) return existing;
  const book = source.getObjectByName('SV3_DepartureBook') ?? source;
  const surfaces: PageSurface[] = [];
  book.traverse(node => {
    if (node.name.startsWith('SV3_Page_') || node.name.startsWith('SV3_PageInk_')) node.visible = false;
  });
  for (const side of [-1, 1] as const) for (let page = 0; page < 6; page++) {
    const cloth = new VoyageBookPageCloth({ side, pageIndex: page });
    const material = sourceMaterial(book, side, page);
    const mesh = new T.Mesh(pageGeometry(cloth), material);
    mesh.name = `SV3_PhysicalPage_${side < 0 ? 'L' : 'R'}_${page.toString().padStart(2, '0')}`;
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData.book_page_cloth = true;
    mesh.userData.book_page_side = side;
    mesh.userData.book_page_index = page;
    book.add(mesh);
    surfaces.push({ cloth, mesh, material });
  }
  const rig: VoyageBookPageRig = {
    pages: surfaces,
    update(delta, progress, reduced = false) {
      for (const surface of surfaces) {
        surface.cloth.advance(delta, progress, reduced);
        const position = surface.mesh.geometry.getAttribute('position') as T.BufferAttribute;
        position.needsUpdate = true;
        surface.mesh.geometry.computeVertexNormals();
        surface.mesh.geometry.computeBoundingSphere();
      }
    },
    reset() { for (const surface of surfaces) surface.cloth.reset(); },
    dispose() {
      for (const surface of surfaces) {
        surface.mesh.removeFromParent();
        surface.mesh.geometry.dispose();
        surface.material.dispose();
      }
      delete source.userData[RIG_KEY];
    },
  };
  source.userData[RIG_KEY] = rig;
  return rig;
}
