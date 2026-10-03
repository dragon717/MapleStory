import * as T from 'three';
import { projectLoginSurface, type LoginSurface } from './voyage-login';

export type VoyagePaperSurface = LoginSurface & {
  group: T.Group;
  mesh: T.Mesh<T.PlaneGeometry, T.MeshStandardMaterial>;
  rest: Float32Array;
  progress: number;
  open: boolean;
};

function paperTexture() {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 768;
  const context = canvas.getContext('2d')!;
  const gradient = context.createLinearGradient(0, 0, canvas.width, 0); gradient.addColorStop(0, '#a8814f'); gradient.addColorStop(.07, '#f4dfad'); gradient.addColorStop(.93, '#f7e7bf'); gradient.addColorStop(1, '#9c7446');
  context.fillStyle = gradient; context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#79552f'; context.lineWidth = 10; context.strokeRect(20, 20, canvas.width - 40, canvas.height - 40);
  context.globalAlpha = .16; for (let y = 34; y < canvas.height; y += 19) { context.fillStyle = y % 38 ? '#fff8d9' : '#8f693e'; context.fillRect(28, y, canvas.width - 56, 2); }
  const texture = new T.CanvasTexture(canvas); texture.colorSpace = T.SRGBColorSpace; texture.wrapS = texture.wrapT = T.ClampToEdgeWrapping; texture.minFilter = T.LinearMipmapLinearFilter; return texture;
}

export function createVoyagePaper(parent: T.Object3D, name: string, position: T.Vector3, width: number, height: number): VoyagePaperSurface {
  const group = new T.Group(); group.name = name; group.position.copy(position);
  const anchor = new T.Object3D(); anchor.name = `${name}_Surface`; anchor.userData.width = width; anchor.userData.height = height; group.add(anchor);
  const material = new T.MeshStandardMaterial({ map: paperTexture(), color: '#fff0c9', emissive: '#f4dfad', emissiveIntensity: .45, roughness: .88, metalness: 0, side: T.DoubleSide });
  const geometry = new T.PlaneGeometry(width, height, 8, 24);
  const mesh = new T.Mesh(geometry, material); mesh.name = `${name}_Sheet`; mesh.castShadow = true; mesh.receiveShadow = true; anchor.add(mesh); group.visible = false; parent.add(group);
  return { anchor, width, height, group, mesh, rest: (geometry.attributes.position.array as Float32Array).slice(), progress: 0, open: false };
}

/** A small authored paper motion: the lower edge unfurls from the top roll,
 * with a shallow curl that settles into the final flat sheet. It is deliberately
 * geometry-only so the projected DOM keeps its natural aspect ratio. */
function shapePaper(surface: VoyagePaperSurface) {
  const position = surface.mesh.geometry.attributes.position as T.BufferAttribute;
  const { width, height, progress } = surface;
  const curl = (1 - progress) * Math.min(width, height) * .08;
  for (let i = 0; i < position.count; i++) {
    const x = surface.rest[i * 3], baseY = surface.rest[i * 3 + 1];
    const v = T.MathUtils.clamp((baseY + height / 2) / height, 0, 1);
    const y = height / 2 - (1 - v) * height * progress;
    const z = Math.sin((1 - v) * Math.PI) * curl;
    position.setXYZ(i, x, y, z);
  }
  position.needsUpdate = true;
  surface.mesh.geometry.computeVertexNormals();
  surface.mesh.geometry.computeBoundingSphere();
}

export class VoyagePaperProjector {
  private original = new Map<HTMLElement, { style: string; inert: boolean }>();
  private element?: HTMLElement;
  private surface?: VoyagePaperSurface;
  set(element: HTMLElement | undefined, surface: VoyagePaperSurface | undefined, open: boolean) {
    if (element !== this.element) {
      if (this.element && this.original.has(this.element)) { const saved = this.original.get(this.element)!; this.element.style.cssText = saved.style; this.element.inert = saved.inert; }
      this.element = element; this.surface = surface;
      if (element) { this.original.set(element, { style: element.style.cssText, inert: element.inert }); Object.assign(element.style, { position: 'absolute', left: '0', top: '0', right: 'auto', bottom: 'auto', margin: '0', transformOrigin: '0 0', transition: 'none', maxWidth: 'none' }); }
    } else this.surface = surface;
    if (surface) surface.open = open;
    // Stage changes remove the DOM form. Close its physical sheet immediately
    // too, so an orphaned creation paper cannot remain over the next scene.
    if (!element && surface) { surface.open = false; surface.progress = 0; surface.group.visible = false; }
  }
  update(camera: T.Camera, viewport: { width: number; height: number }) {
    if (!this.element || !this.surface) return false;
    const surface = this.surface;
    surface.progress = matchMedia('(prefers-reduced-motion: reduce)').matches
      ? surface.open ? 1 : 0
      : T.MathUtils.lerp(surface.progress, surface.open ? 1 : 0, surface.open ? .18 : .24);
    surface.group.visible = surface.progress > .01;
    shapePaper(surface);
    const projection = projectLoginSurface(surface, camera, viewport, { width: this.element.offsetWidth, height: this.element.offsetHeight });
    const visible = Boolean(surface.open && surface.progress > .92 && projection);
    if (projection) this.element.style.transform = `matrix3d(${projection.matrix.elements.join(',')})`;
    this.element.style.visibility = visible ? 'visible' : 'hidden'; this.element.style.pointerEvents = visible ? 'auto' : 'none'; this.element.inert = !visible || this.original.get(this.element)!.inert;
    return visible;
  }
  destroy() {
    if (this.element && this.original.has(this.element)) { const saved = this.original.get(this.element)!; this.element.style.cssText = saved.style; this.element.inert = saved.inert; }
    this.element = undefined; this.surface = undefined; this.original.clear();
  }
}
