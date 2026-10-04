import * as T from 'three';
import { resolveAssetUrl } from '../../assets/resource-url';
import { projectLoginSurface, type LoginSurface } from './voyage-login';

type PaperEdge = { a: number; b: number; length: number; stiffness: number };

/**
 * A deliberately small Verlet cloth for one hanging sheet.
 *
 * The top row is always fixed. Rows that have not been released yet are
 * kinematic and are wrapped into the top roller; released rows are integrated
 * with gravity and constrained with structural, shear and bending links. This
 * keeps the paper responsive without turning the login surface into a second
 * gameplay or physics state.
 */
export class PaperCloth {
  readonly positions: Float32Array;
  readonly previous: Float32Array;
  private readonly dynamic: Float32Array;
  private readonly edges: PaperEdge[] = [];
  private pending = 0;

  constructor(
    readonly rest: Float32Array,
    readonly columns: number,
    readonly rows: number,
    readonly radius: number,
  ) {
    const expected = (columns + 1) * (rows + 1) * 3;
    if (columns < 2 || rows < 2 || rest.length !== expected || !rest.every(Number.isFinite)) throw new Error('Invalid paper grid');
    this.positions = rest.slice();
    this.previous = rest.slice();
    this.dynamic = new Float32Array(rest.length / 3);
    const add = (a: number, b: number, stiffness: number) => {
      const dx = rest[a * 3] - rest[b * 3];
      const dy = rest[a * 3 + 1] - rest[b * 3 + 1];
      const dz = rest[a * 3 + 2] - rest[b * 3 + 2];
      const length = Math.hypot(dx, dy, dz);
      if (length > 1e-7) this.edges.push({ a, b, length, stiffness });
    };
    for (let row = 0; row <= rows; row++) for (let column = 0; column <= columns; column++) {
      const i = row * (columns + 1) + column;
      if (column < columns) add(i, i + 1, 1);
      if (row < rows) add(i, i + columns + 1, 1);
      if (column < columns && row < rows) {
        // The diagonal links keep the sheet from shearing while it is opening.
        add(i, i + columns + 2, .82);
        add(i + 1, i + columns + 1, .82);
      }
      if (column + 2 <= columns) add(i, i + 2, .32);
      if (row + 2 <= rows) add(i, i + 2 * (columns + 1), .32);
    }
    this.setKinematicPose(0);
  }

  private clampProgress(progress: number) { return T.MathUtils.clamp(progress, 0, 1); }

  /** Position of the still-rolled part. It loops once in front of the top rod. */
  private foldedTarget(index: number, progress: number, out = new T.Vector3()) {
    const row = Math.floor(index / (this.columns + 1));
    const localRow = row / this.rows;
    const topY = this.rest[1];
    const x = this.rest[index * 3];
    if (localRow <= progress) return out.set(x, this.rest[index * 3 + 1], this.rest[index * 3 + 2]);
    const remaining = Math.max(1e-4, 1 - progress);
    const around = T.MathUtils.clamp((localRow - progress) / remaining, 0, 1);
    const angle = around * Math.PI * 2;
    return out.set(x, topY + Math.sin(angle) * this.radius, this.radius * .12 + (1 - Math.cos(angle)) * this.radius * .82);
  }

  private dynamicWeight(index: number, progress: number) {
    const row = Math.floor(index / (this.columns + 1));
    if (row === 0) return 0;
    const released = progress * this.rows;
    // A one-cell transition makes newly released rows join the simulation
    // without a velocity spike at the moving release edge.
    return T.MathUtils.clamp(released - row + 1, 0, 1);
  }

  private setKinematicPose(progress: number) {
    const target = new T.Vector3();
    for (let index = 0; index < this.positions.length / 3; index++) {
      const point = this.foldedTarget(index, progress, target);
      this.positions[index * 3] = this.previous[index * 3] = point.x;
      this.positions[index * 3 + 1] = this.previous[index * 3 + 1] = point.y;
      this.positions[index * 3 + 2] = this.previous[index * 3 + 2] = point.z;
    }
  }

  advance(delta: number, progress: number) {
    progress = this.clampProgress(progress);
    // Exact end poses are part of the DOM projection contract: the actual
    // paper corners must meet the fixed anchor corners before the form appears.
    if (progress >= .985) {
      this.positions.set(this.rest); this.previous.set(this.rest); this.pending = 0;
      return;
    }
    if (progress <= .001) {
      this.setKinematicPose(0); this.pending = 0;
      return;
    }
    if (!Number.isFinite(delta) || delta <= 0) return;
    this.pending += Math.min(delta, .05);
    const dt = 1 / 60;
    const target = new T.Vector3();
    while (this.pending >= dt) {
      this.pending -= dt;
      const dynamic = this.dynamic;
      for (let index = 0; index < dynamic.length; index++) {
        const weight = dynamic[index] = this.dynamicWeight(index, progress);
        const point = this.foldedTarget(index, progress, target);
        const offset = index * 3;
        if (weight <= 0) {
          this.positions[offset] = this.previous[offset] = point.x;
          this.positions[offset + 1] = this.previous[offset + 1] = point.y;
          this.positions[offset + 2] = this.previous[offset + 2] = point.z;
          continue;
        }
        const x = this.positions[offset], y = this.positions[offset + 1], z = this.positions[offset + 2];
        this.positions[offset] += (x - this.previous[offset]) * .992;
        this.positions[offset + 1] += (y - this.previous[offset + 1]) * .992 - 9.81 * dt * dt;
        // A very small forward pull gives the curled edge depth while the
        // motion remains gravity-led and deterministic.
        this.positions[offset + 2] += (z - this.previous[offset + 2]) * .992 + .018 * dt * dt;
        this.previous[offset] = x; this.previous[offset + 1] = y; this.previous[offset + 2] = z;
        if (weight < 1) {
          this.positions[offset] = T.MathUtils.lerp(point.x, this.positions[offset], weight);
          this.positions[offset + 1] = T.MathUtils.lerp(point.y, this.positions[offset + 1], weight);
          this.positions[offset + 2] = T.MathUtils.lerp(point.z, this.positions[offset + 2], weight);
        }
      }
      // Four short projection passes are enough for the stiff paper grid and
      // keep this effect below the cost of the ship sails.
      for (let pass = 0; pass < 5; pass++) {
        for (const edge of this.edges) {
          const wa = dynamic[edge.a], wb = dynamic[edge.b], total = wa + wb;
          if (total <= 1e-5) continue;
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
        // Reapply the rolled portion and the fixed top row after every pass.
        for (let index = 0; index < dynamic.length; index++) if (dynamic[index] < 1) {
          const point = this.foldedTarget(index, progress, target), offset = index * 3;
          this.positions[offset] = T.MathUtils.lerp(point.x, this.positions[offset], dynamic[index]);
          this.positions[offset + 1] = T.MathUtils.lerp(point.y, this.positions[offset + 1], dynamic[index]);
          this.positions[offset + 2] = T.MathUtils.lerp(point.z, this.positions[offset + 2], dynamic[index]);
        }
      }
    }
  }
}

export type VoyagePaperSurface = LoginSurface & {
  group: T.Group;
  mesh: T.Mesh<T.PlaneGeometry, T.MeshStandardMaterial>;
  roll: T.Mesh<T.CylinderGeometry, T.MeshStandardMaterial>;
  rest: Float32Array;
  progress: number;
  open: boolean;
  cloth: PaperCloth;
  vertexToNode: Uint16Array;
  rollRadius: number;
};

/** The published panel is an actual high-resolution parchment surface. */
function paperTexture() {
  const texture = new T.TextureLoader().load(resolveAssetUrl('/assets/entry/voyage-panel.png'));
  texture.colorSpace = T.SRGBColorSpace;
  texture.wrapS = texture.wrapT = T.ClampToEdgeWrapping;
  texture.minFilter = T.LinearMipmapLinearFilter;
  texture.magFilter = T.LinearFilter;
  return texture;
}

function buildRestGrid(width: number, height: number, columns: number, rows: number) {
  const rest = new Float32Array((columns + 1) * (rows + 1) * 3);
  for (let row = 0; row <= rows; row++) for (let column = 0; column <= columns; column++) {
    const index = (row * (columns + 1) + column) * 3;
    rest[index] = (column / columns - .5) * width;
    rest[index + 1] = (.5 - row / rows) * height;
    rest[index + 2] = 0;
  }
  return rest;
}

export function createVoyagePaper(parent: T.Object3D, name: string, position: T.Vector3, width: number, height: number): VoyagePaperSurface {
  const group = new T.Group(); group.name = name; group.position.copy(position);
  const anchor = new T.Object3D(); anchor.name = `${name}_Surface`; anchor.userData.width = width; anchor.userData.height = height; group.add(anchor);
  const columns = Math.max(10, Math.min(18, Math.round(width * 2.2)));
  const rows = Math.max(20, Math.min(32, Math.round(height * 3.2)));
  const rollRadius = Math.max(.12, Math.min(.3, width * .075));
  const rest = buildRestGrid(width, height, columns, rows);
  const cloth = new PaperCloth(rest, columns, rows, rollRadius);
  const material = new T.MeshStandardMaterial({
    map: paperTexture(), color: '#fff0c9', emissive: '#e8c98e', emissiveIntensity: .3,
    roughness: .92, metalness: 0, side: T.DoubleSide, transparent: true, alphaTest: .03,
  });
  const geometry = new T.PlaneGeometry(width, height, columns, rows);
  const vertexToNode = new Uint16Array(geometry.attributes.position.count);
  const positionAttribute = geometry.attributes.position as T.BufferAttribute;
  for (let vertex = 0; vertex < positionAttribute.count; vertex++) {
    const column = T.MathUtils.clamp(Math.round((positionAttribute.getX(vertex) / width + .5) * columns), 0, columns);
    const row = T.MathUtils.clamp(Math.round((.5 - positionAttribute.getY(vertex) / height) * rows), 0, rows);
    vertexToNode[vertex] = row * (columns + 1) + column;
  }
  const mesh = new T.Mesh(geometry, material); mesh.name = `${name}_Sheet`; mesh.castShadow = true; mesh.receiveShadow = true; anchor.add(mesh);
  const roll = new T.Mesh(new T.CylinderGeometry(rollRadius, rollRadius, width + rollRadius * 1.4, 24, 1, false), material);
  roll.name = `${name}_TopScrollRoll`; roll.rotation.z = Math.PI / 2; roll.position.set(0, height / 2 + rollRadius * .12, rollRadius * .1); roll.castShadow = true; roll.receiveShadow = true; group.add(roll);
  group.visible = false; parent.add(group);
  return { anchor, width, height, group, mesh, roll, rest, progress: 0, open: false, cloth, vertexToNode, rollRadius };
}

function shapePaper(surface: VoyagePaperSurface) {
  const position = surface.mesh.geometry.attributes.position as T.BufferAttribute;
  const positions = surface.cloth.positions;
  for (let vertex = 0; vertex < position.count; vertex++) {
    const node = surface.vertexToNode[vertex] * 3;
    position.setXYZ(vertex, positions[node], positions[node + 1], positions[node + 2]);
  }
  position.needsUpdate = true;
  surface.mesh.geometry.computeVertexNormals();
  surface.mesh.geometry.computeBoundingSphere();
  const radiusScale = 1 - surface.progress * .33;
  surface.roll.scale.set(radiusScale, 1, radiusScale);
  surface.roll.position.y = surface.height / 2 + surface.rollRadius * (.12 + (1 - radiusScale) * .55);
  surface.roll.position.z = surface.rollRadius * (.1 + surface.progress * .06);
}

export class VoyagePaperProjector {
  private original = new Map<HTMLElement, { style: string; inert: boolean }>();
  private element?: HTMLElement;
  private surface?: VoyagePaperSurface;
  private lastTime = 0;
  set(element: HTMLElement | undefined, surface: VoyagePaperSurface | undefined, open: boolean) {
    const changedSurface = surface !== this.surface;
    if (element !== this.element) {
      if (this.element && this.original.has(this.element)) { const saved = this.original.get(this.element)!; this.element.style.cssText = saved.style; this.element.inert = saved.inert; this.original.delete(this.element); }
      this.element = element; this.surface = surface; this.lastTime = 0;
      if (element) { this.original.set(element, { style: element.style.cssText, inert: element.inert }); Object.assign(element.style, { position: 'absolute', left: '0', top: '0', right: 'auto', bottom: 'auto', margin: '0', transformOrigin: '0 0', transition: 'none', maxWidth: 'none' }); }
    } else { this.surface = surface; if (changedSurface) this.lastTime = 0; }
    if (surface) surface.open = open;
    // Stage changes remove the DOM form. Close its physical sheet immediately
    // too, so an orphaned creation paper cannot remain over the next scene.
    if (!element && surface) { surface.open = false; surface.progress = 0; surface.cloth.advance(.001, 0); surface.group.visible = false; }
  }
  update(camera: T.Camera, viewport: { width: number; height: number }) {
    if (!this.element || !this.surface) return false;
    const surface = this.surface;
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    const elapsed = this.lastTime > 0 ? Math.max(0, (now - this.lastTime) / 1000) : 0;
    const delta = Math.min(.05, elapsed);
    this.lastTime = now;
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    surface.progress = reduced ? surface.open ? 1 : 0 : T.MathUtils.lerp(surface.progress, surface.open ? 1 : 0, 1 - Math.exp(-elapsed * (surface.open ? 10.5 : 16.5)));
    surface.group.visible = surface.progress > .001;
    surface.cloth.advance(delta, surface.progress);
    shapePaper(surface);
    const projection = projectLoginSurface(surface, camera, viewport, { width: this.element.offsetWidth, height: this.element.offsetHeight });
    // Visibility waits for the exact rest pose so the DOM's four corners and
    // the real paper's four corners cannot slowly drift apart.
    const visible = Boolean(surface.open && surface.progress >= .985 && projection);
    if (projection) this.element.style.transform = `matrix3d(${projection.matrix.elements.join(',')})`;
    this.element.style.visibility = visible ? 'visible' : 'hidden'; this.element.style.pointerEvents = visible ? 'auto' : 'none'; this.element.inert = !visible || this.original.get(this.element)!.inert;
    return visible;
  }
  destroy() {
    if (this.element && this.original.has(this.element)) { const saved = this.original.get(this.element)!; this.element.style.cssText = saved.style; this.element.inert = saved.inert; }
    if (this.surface) { this.surface.open = false; this.surface.group.visible = false; }
    this.element = undefined; this.surface = undefined; this.original.clear(); this.lastTime = 0;
  }
}
