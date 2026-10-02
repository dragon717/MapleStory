import * as T from 'three';

type Size = { width: number; height: number };
/** Front centre of an authored XY surface; local +Z faces the reader. Sizes are metres. */
export type LoginSurface = Size & { anchor: T.Object3D };
const visibleInTree = (object: T.Object3D): boolean => {
  for (let node: T.Object3D | null = object; node; node = node.parent) if (!node.visible) return false;
  return true;
};

/** Exact plane homography, including perspective division; preserves the form's aspect ratio. */
export function projectLoginSurface(surface: LoginSurface, camera: T.Camera, viewport: Size, element: Size) {
  if (![surface.width, surface.height, viewport.width, viewport.height, element.width, element.height].every(value => Number.isFinite(value) && value > 0)
    || !visibleInTree(surface.anchor) || !surface.anchor.layers.test(camera.layers)) return;
  surface.anchor.updateWorldMatrix(true, false); camera.updateWorldMatrix(true, false);
  const frame = surface.anchor.matrixWorld;
  if (![...frame.elements, ...camera.matrixWorldInverse.elements, ...camera.projectionMatrix.elements].every(Number.isFinite) || Math.abs(frame.determinant()) < 1e-10) return;
  const centre = new T.Vector3().setFromMatrixPosition(frame), eye = camera.getWorldPosition(new T.Vector3());
  const normal = new T.Vector3(0, 0, 1).applyNormalMatrix(new T.Matrix3().getNormalMatrix(frame));
  if (normal.dot(eye.sub(centre)) <= 1e-8) return;
  const scale = Math.min(surface.width / element.width, surface.height / element.height);
  const world = frame.clone().multiply(new T.Matrix4().set(
    scale, 0, 0, -element.width * scale / 2,
    0, -scale, 0, element.height * scale / 2,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ));
  const clip = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse).multiply(world);
  const pixels = [[element.width / 2, element.height / 2], [0, 0], [element.width, 0], [element.width, element.height], [0, element.height]];
  const corners = pixels.map(([x, y]) => new T.Vector4(x, y, 0, 1).applyMatrix4(clip));
  // A plane crossing near/far is hidden instead of emitting a singular/exploding CSS transform.
  if (corners.some(p => !p.toArray().every(Number.isFinite) || p.w <= 1e-6 || p.z < -p.w || p.z > p.w)
    || [0, 1].some(axis => [-1, 1].some(side => corners.every(p => side * p.getComponent(axis) > p.w)))) return;
  const e = clip.elements, d = corners[0].w, x = viewport.width / 2, y = viewport.height / 2;
  const matrix = new T.Matrix4().fromArray([
    x * (e[0] + e[3]) / d, y * (e[3] - e[1]) / d, 0, e[3] / d,
    x * (e[4] + e[7]) / d, y * (e[7] - e[5]) / d, 0, e[7] / d,
    0, 0, 1, 0,
    x * (e[12] + e[15]) / d, y * (e[15] - e[13]) / d, 0, e[15] / d,
  ]);
  if (!matrix.elements.every(Number.isFinite) || Math.abs(matrix.determinant()) < 1e-10) return;
  return { matrix, points: pixels.map(([x, y]) => new T.Vector3(x, y, 0).applyMatrix4(world)) };
}

/** Supply opaque scene roots, excluding sky/water/glass. The surface itself lies in front of its backing. */
export function loginSurfaceOccluded(camera: T.Camera, points: readonly T.Vector3[], roots: readonly T.Object3D[]) {
  const meshes: T.Object3D[] = [];
  for (const root of roots) {
    root.updateWorldMatrix(true, true);
    root.traverse(object => {
      if (object instanceof T.Mesh && visibleInTree(object) && object.layers.test(camera.layers)) meshes.push(object);
    });
  }
  const eye = camera.getWorldPosition(new T.Vector3()), ray = new T.Raycaster();
  ray.layers.mask = camera.layers.mask;
  // ponytail: five samples can miss thin occluders and hide the whole form on hits; use a depth mask for pixel-accurate clipping.
  for (const point of points) {
    const direction = point.clone().sub(eye), distance = direction.length();
    if (!Number.isFinite(distance) || distance <= 1e-6) return true;
    ray.set(eye, direction.divideScalar(distance)); ray.far = distance - Math.max(1e-4, distance * 1e-6);
    if (ray.intersectObjects(meshes, false).some(hit => {
      const mesh = hit.object as T.Mesh;
      const material = Array.isArray(mesh.material) ? mesh.material[hit.face?.materialIndex ?? 0] : mesh.material;
      const depth = hit.point.clone().project(camera).z;
      return depth >= -1 && depth <= 1 && material?.visible && !material.transparent && material.opacity > 0;
    })) return true;
  }
  return false;
}

/** Repositions the existing native form; EntryView keeps every input, listener and authentication state. */
export class VoyageLogin {
  private element?: HTMLElement;
  private original?: { style: string; inert: boolean };
  private interact = () => this.reveal?.();
  constructor(private host: HTMLElement, private reveal?: () => void) {}
  update(camera: T.Camera, surface?: LoginSurface, occluders: readonly T.Object3D[] = []) {
    const element = this.host.querySelector<HTMLElement>('#login');
    if (!surface || !element) { this.destroy(); return false; }
    if (element !== this.element) {
      this.destroy(); this.element = element;
      this.original = { style: element.style.cssText, inert: element.inert };
      Object.assign(element.style, { position: 'absolute', left: '0', top: '0', right: 'auto', bottom: 'auto', margin: '0', width: '430px', maxWidth: 'none', transformOrigin: '0 0', transition: 'none' });
      element.addEventListener('keydown', this.interact); element.addEventListener('pointerdown', this.interact);
    }
    const projection = projectLoginSurface(surface, camera, { width: this.host.clientWidth, height: this.host.clientHeight }, { width: element.offsetWidth, height: element.offsetHeight });
    const visible = Boolean(projection && (!occluders.length || !loginSurfaceOccluded(camera, projection.points, occluders)));
    if (projection) element.style.transform = `matrix3d(${projection.matrix.elements.join(',')})`;
    element.style.visibility = visible ? 'visible' : 'hidden';
    element.style.pointerEvents = visible ? 'auto' : 'none';
    element.inert = !visible || this.original!.inert;
    return visible;
  }
  destroy() {
    if (!this.element || !this.original) return;
    this.element.style.cssText = this.original.style; this.element.inert = this.original.inert;
    this.element.removeEventListener('keydown', this.interact); this.element.removeEventListener('pointerdown', this.interact);
    this.element = undefined; this.original = undefined;
  }
}
