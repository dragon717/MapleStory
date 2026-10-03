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
      if (!(object instanceof T.Mesh) || !visibleInTree(object) || !object.layers.test(camera.layers)) return;
      // The board, its physical button meshes and the paper itself are the
      // destination surface, never an occluder of their own native form.
      for (let parent: T.Object3D | null = object; parent; parent = parent.parent) {
        if (parent.name === 'SV2_LoginSign' || parent.name === 'SV3_LoginSurface' || parent.name.startsWith('SV3_LoginButton_')) return;
      }
      meshes.push(object);
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
  private controls: { button: HTMLButtonElement; mesh: T.Mesh<T.ExtrudeGeometry, T.MeshStandardMaterial> }[] = [];
  private controlSize = '';
  private occluded = false;
  private checkedAt = -Infinity;
  constructor(private host: HTMLElement) {}
  update(camera: T.Camera, surface?: LoginSurface, occluders: readonly T.Object3D[] = [], enabled = true) {
    const element = this.host.querySelector<HTMLElement>('#login');
    if (!surface || !element) { this.destroy(); return false; }
    if (element !== this.element) {
      this.destroy(); this.element = element;
      this.original = { style: element.style.cssText, inert: element.inert };
      Object.assign(element.style, { position: 'absolute', left: '0', top: '0', right: 'auto', bottom: 'auto', margin: '0', width: '430px', maxWidth: 'none', transformOrigin: '0 0', transition: 'none' });
    }
    this.updateControls(element, surface);
    const projection = projectLoginSurface(surface, camera, { width: this.host.clientWidth, height: this.host.clientHeight }, { width: element.offsetWidth, height: element.offsetHeight });
    if (projection && occluders.length && performance.now() - this.checkedAt > 100) {
      this.occluded = loginSurfaceOccluded(camera, projection.points, occluders); this.checkedAt = performance.now();
    }
    const visible = Boolean(enabled && projection && (!occluders.length || !this.occluded));
    if (projection) element.style.transform = `matrix3d(${projection.matrix.elements.join(',')})`;
    element.style.visibility = visible ? 'visible' : 'hidden';
    element.style.pointerEvents = visible ? 'auto' : 'none';
    element.inert = !visible || this.original!.inert;
    return visible;
  }
  private updateControls(element: HTMLElement, surface: LoginSurface) {
    const scale = Math.min(surface.width / element.offsetWidth, surface.height / element.offsetHeight);
    const buttons = Array.from(element.querySelectorAll<HTMLButtonElement>('button'));
    const bounds = buttons.map(button => {
      let x = 0, y = 0;
      for (let node: HTMLElement | null = button; node && node !== element; node = node.offsetParent as HTMLElement | null) { x += node.offsetLeft; y += node.offsetTop; }
      return { x, y, w: button.offsetWidth, h: button.offsetHeight };
    });
    const size = JSON.stringify([element.offsetWidth, element.offsetHeight, bounds]);
    if (this.controlSize !== size) {
      this.disposeControls(); this.controlSize = size;
      buttons.forEach((button, index) => {
        const b = bounds[index], w = b.w * scale, h = b.h * scale, r = Math.min(.06, h / 5);
        const shape = new T.Shape();
        shape.moveTo(-w / 2 + r, -h / 2); shape.lineTo(w / 2 - r, -h / 2);
        shape.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r); shape.lineTo(w / 2, h / 2 - r);
        shape.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2); shape.lineTo(-w / 2 + r, h / 2);
        shape.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r); shape.lineTo(-w / 2, -h / 2 + r);
        shape.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
        const geometry = new T.ExtrudeGeometry(shape, { depth: .07, bevelEnabled: true, bevelSize: .025, bevelThickness: .025, bevelSegments: 2, steps: 1, curveSegments: 4 });
        const material = new T.MeshStandardMaterial({ color: button.classList.contains('entry-primary') ? '#345d64' : '#c5a66c', roughness: .38, metalness: button.classList.contains('entry-primary') ? .15 : .55 });
        const mesh = new T.Mesh(geometry, material); mesh.name = `SV3_LoginButton_${index}`;
        mesh.position.set((b.x + b.w / 2 - element.offsetWidth / 2) * scale, (element.offsetHeight / 2 - b.y - b.h / 2) * scale, .025);
        mesh.castShadow = true; mesh.receiveShadow = true; surface.anchor.add(mesh);
        this.controls.push({ button, mesh });
      });
      element.classList.add('voyage-solid-controls');
    }
    for (const { button, mesh } of this.controls) {
      mesh.position.z = button.matches(':active') ? .008 : .025;
      mesh.material.emissive.set(button.matches(':hover') && !button.disabled ? '#152324' : '#000000');
      mesh.material.emissiveIntensity = .25;
    }
  }
  private disposeControls() {
    for (const { mesh } of this.controls) { mesh.removeFromParent(); mesh.geometry.dispose(); mesh.material.dispose(); }
    this.controls = []; this.controlSize = '';
  }
  destroy() {
    this.checkedAt = -Infinity; this.occluded = false;
    this.disposeControls();
    if (!this.element || !this.original) return;
    this.element.style.cssText = this.original.style; this.element.inert = this.original.inert;
    this.element.classList.remove('voyage-solid-controls');
    this.element = undefined; this.original = undefined;
  }
}
