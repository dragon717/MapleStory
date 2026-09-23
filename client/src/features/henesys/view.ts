import * as T from 'three';
import type Phaser from 'phaser';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { MapDefinition } from '../../assets/manifest';
import { resolveAssetUrl } from '../../assets/resource-url';
import { PAPER_DEPTH, PIXELS_PER_METRE, point3d } from './coordinates';
import './style.css';

/**
 * A 3D environment around the existing transparent Phaser world layer.
 * Player/NPC/quest/combat/pet/drop views, animation clocks, audio and hit testing
 * stay owned by World. This bridge never interprets or sends gameplay messages.
 */
export class HenesysView {
  private root = document.createElement('div');
  private renderer: T.WebGLRenderer;
  private scene = new T.Scene();
  private camera = new T.PerspectiveCamera(38, 1, .1, 700);
  private texture: T.CanvasTexture;
  private paper: T.Mesh<T.PlaneGeometry, T.MeshBasicMaterial>;
  private ray = new T.Raycaster();
  private groups: T.Object3D[] = [];
  private faded = new Set<T.Object3D>();
  private occlusionAt = 0;
  private yaw = 0;
  private pitch = .24;
  private zoom = 1;
  private drag?: { id: number; x: number; y: number };
  private disposed = false;
  private sourceMaterials = new Set<T.Material>();
  private width = 0;
  private height = 0;

  static async create(world: Phaser.Scene, map: MapDefinition, self: () => { x: number; y: number } | undefined, current: () => boolean) {
    const model = (await new GLTFLoader().loadAsync(resolveAssetUrl('/assets/henesys/henesys.glb'))).scene;
    if (!current()) { HenesysView.disposeModel(model); return undefined; }
    try { return new HenesysView(world, map, model, self); }
    catch (error) { HenesysView.disposeModel(model); throw error; }
  }
  constructor(private world: Phaser.Scene, map: MapDefinition, model: T.Group, private self: () => { x: number; y: number } | undefined) {
    this.root.className = 'henesys-view';
    this.root.setAttribute('aria-label', '三维射手村，沿用原版移动、任务与战斗操作');
    this.renderer = new T.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = T.PCFSoftShadowMap;
    this.root.append(this.renderer.domElement);
    this.scene.background = new T.Color(0xb6d5df);
    this.scene.fog = new T.Fog(0xb6d5df, 75, 240);
    this.scene.add(new T.HemisphereLight(0xfff4df, 0x849471, 2));
    const sun = new T.DirectionalLight(0xffe2b0, 3);
    sun.position.set(-30, 65, 45); sun.castShadow = true;
    Object.assign(sun.shadow.camera, { left: -76, right: 76, top: 40, bottom: -40, near: 1, far: 180 });
    sun.shadow.mapSize.set(2048, 2048); sun.shadow.normalBias = .035;
    this.scene.add(sun, sun.target, model);
    model.traverse(o => {
      if (o instanceof T.Mesh) {
        o.castShadow = !o.name.includes('Terrain'); o.receiveShadow = true;
        // Keep Blender's PBR textures/roughness. The colossus Toon conversion is not used here.
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          this.sourceMaterials.add(m);
          const material = m as T.MeshStandardMaterial;
          if (material.map) material.map.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
        }
        if (/HN_(West|Market|East|Windmill|Hall|Park)/.test(o.name)) {
          // Each district owns fade state even when the GLB shares materials.
          o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone();
          this.groups.push(o);
        }
      }
    });
    this.addSourcePaths(map);
    this.texture = new T.CanvasTexture(world.game.canvas);
    this.texture.colorSpace = T.SRGBColorSpace;
    this.texture.minFilter = T.LinearFilter;
    this.texture.magFilter = T.LinearFilter;
    this.texture.generateMipmaps = false;
    this.paper = new T.Mesh(new T.PlaneGeometry(1, 1), new T.MeshBasicMaterial({ map: this.texture, transparent: true, alphaTest: .005, depthWrite: false, depthTest: false, side: T.DoubleSide, toneMapped: false }));
    // ponytail: actors share the original XY plane; keep orbit bounded until maps have authored depth lanes.
    // Nameplates and quest markers must remain readable over decorative terrain.
    this.paper.renderOrder = 10;
    this.scene.add(this.paper);
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this.down);
    canvas.addEventListener('pointermove', this.move);
    canvas.addEventListener('pointerup', this.up);
    canvas.addEventListener('pointercancel', this.up);
    canvas.addEventListener('contextmenu', this.context);
    canvas.addEventListener('wheel', this.wheel, { passive: false });
    world.game.canvas.parentElement!.append(this.root);
    world.game.canvas.parentElement!.classList.add('show-henesys');
    // Upload directly after Phaser renders; its WebGL drawing buffer is still valid.
    world.game.events.on('postrender', this.draw);
  }
  private addSourcePaths(map: MapDefinition) {
    const parts: T.BufferGeometry[] = [];
    const seen = new Set<string>();
    for (const f of map.footholds ?? []) {
      if (f.x2 <= f.x1) continue;
      const key = [f.x1, f.y1, f.x2, f.y2].join(':');
      if (seen.has(key)) continue;
      seen.add(key);
      const a = new T.Vector3(...point3d(f.x1, f.y1)), b = new T.Vector3(...point3d(f.x2, f.y2));
      const geometry = new T.BoxGeometry(a.distanceTo(b), .10, 1.3);
      geometry.rotateZ(Math.atan2(b.y - a.y, b.x - a.x));
      geometry.translate((a.x + b.x) / 2, (a.y + b.y) / 2 - .055, PAPER_DEPTH);
      parts.push(geometry);
    }
    const add = (geometry: T.BufferGeometry, color: number) => {
      const mesh = new T.Mesh(geometry, new T.MeshStandardMaterial({ color, roughness: .92 }));
      mesh.receiveShadow = true; this.scene.add(mesh);
    };
    if (parts.length) { add(mergeGeometries(parts)!, 0x9b9d66); parts.forEach(g => g.dispose()); }
    const ladderParts: T.BufferGeometry[] = [];
    for (const ladder of map.ladders ?? []) {
      const a = new T.Vector3(...point3d(ladder.x, ladder.y1)), b = new T.Vector3(...point3d(ladder.x, ladder.y2));
      for (const dx of [-.24, .24]) {
        const g = new T.BoxGeometry(.075, Math.abs(a.y - b.y) + .12, .09); g.translate(a.x + dx, (a.y + b.y) / 2, PAPER_DEPTH - .08); ladderParts.push(g);
      }
      for (let y = b.y; y <= a.y; y += .28) { const g = new T.BoxGeometry(.55, .065, .09); g.translate(a.x, y, PAPER_DEPTH); ladderParts.push(g); }
    }
    if (ladderParts.length) { add(mergeGeometries(ladderParts)!, 0x865e32); ladderParts.forEach(g => g.dispose()); }
  }
  resetCamera() { this.yaw = 0; this.pitch = .24; this.zoom = 1; }
  private draw = () => {
    if (this.disposed || !this.world.sys.isActive() || !this.world.sys.isVisible()) return;
    const source = this.world.cameras.main, parent = this.root.parentElement!;
    if (!parent.clientWidth || !parent.clientHeight) return;
    if (this.width !== parent.clientWidth || this.height !== parent.clientHeight) {
      this.width = parent.clientWidth; this.height = parent.clientHeight;
      this.renderer.setSize(this.width, this.height, false); this.camera.aspect = this.width / this.height; this.camera.updateProjectionMatrix();
    }
    const view = source.worldView;
    const target = new T.Vector3(...point3d(view.centerX, view.centerY));
    this.paper.position.copy(target); this.paper.scale.set(view.width / PIXELS_PER_METRE, view.height / PIXELS_PER_METRE, 1);
    // Phaser renders an overscan area at .75 zoom. Keep original on-screen character scale.
    const distance = (source.height / PIXELS_PER_METRE) / (2 * Math.tan(T.MathUtils.degToRad(this.camera.fov / 2))) * this.zoom;
    this.camera.position.copy(target).add(new T.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch)).multiplyScalar(distance));
    this.camera.lookAt(target); this.camera.updateMatrixWorld();
    this.texture.needsUpdate = true;
    const actor = this.self(), now = performance.now();
    if (actor && now - this.occlusionAt > 180) {
      this.occlusionAt = now;
      const head = new T.Vector3(...point3d(actor.x, actor.y - 45));
      this.ray.set(this.camera.position, head.clone().sub(this.camera.position).normalize());
      this.ray.far = head.distanceTo(this.camera.position) - .08;
      const blocked = new Set(this.ray.intersectObjects(this.groups, false).map(hit => hit.object));
      for (const group of new Set([...this.faded, ...blocked])) {
        const mesh = group as T.Mesh;
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          material.transparent = blocked.has(group); material.opacity = blocked.has(group) ? .22 : 1; material.depthWrite = !blocked.has(group); material.needsUpdate = true;
        }
      }
      this.faded = blocked;
    }
    this.renderer.render(this.scene, this.camera);
    this.renderer.domElement.style.cursor = this.world.game.canvas.style.cursor;
  };
  /** Reproject the ray into Phaser canvas pixels, preserving its real object hit tests. */
  private forward(event: PointerEvent, type: string) {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    this.ray.far = Infinity;
    this.ray.setFromCamera(new T.Vector2((event.clientX - bounds.left) / bounds.width * 2 - 1, 1 - (event.clientY - bounds.top) / bounds.height * 2), this.camera);
    const uv = this.ray.intersectObject(this.paper, false)[0]?.uv;
    if (!uv && type !== 'mouseup') return;
    const canvas = this.world.game.canvas, source = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new MouseEvent(type, { clientX: uv ? source.left + uv.x * source.width : source.left - 1, clientY: uv ? source.top + (1 - uv.y) * source.height : source.top - 1, button: 0, buttons: event.buttons & 1, bubbles: true, cancelable: true, view: window }));
  }
  private down = (e: PointerEvent) => {
    // Prevent compatibility mouse events reaching Phaser's window listener a second time.
    e.preventDefault();
    this.renderer.domElement.setPointerCapture(e.pointerId);
    if (e.button === 2) { this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };  }
    else if (e.button === 0) this.forward(e, 'mousedown');
  };
  private move = (e: PointerEvent) => {
    if (this.drag?.id === e.pointerId) {
      this.yaw = T.MathUtils.clamp(this.yaw - (e.clientX - this.drag.x) * .004, -.45, .45);
      this.pitch = T.MathUtils.clamp(this.pitch + (e.clientY - this.drag.y) * .003, .08, .46);
      this.drag.x = e.clientX; this.drag.y = e.clientY;
    } else this.forward(e, 'mousemove');
  };
  private up = (e: PointerEvent) => { if (this.drag?.id === e.pointerId) this.drag = undefined; else if (e.button === 0) this.forward(e, 'mouseup'); };
  private context = (e: Event) => e.preventDefault();
  private wheel = (e: WheelEvent) => { e.preventDefault(); this.zoom = T.MathUtils.clamp(this.zoom * Math.exp(T.MathUtils.clamp(e.deltaY, -100, 100) * .002), .75, 1.4); };
  private static disposeModel(root: T.Object3D) {
    const textures = new Set<T.Texture>(), materials = new Set<T.Material>(), geometries = new Set<T.BufferGeometry>();
    root.traverse(o => { if (o instanceof T.Mesh) {
      geometries.add(o.geometry);
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) { materials.add(m); for (const value of Object.values(m)) if (value instanceof T.Texture) textures.add(value); }
    } });
    geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose());
  }
  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.world.game.events.off('postrender', this.draw);
    this.root.parentElement?.classList.remove('show-henesys');
    this.root.remove();
    HenesysView.disposeModel(this.scene);
    this.sourceMaterials.forEach(m => m.dispose()); this.sourceMaterials.clear();
    this.renderer.dispose(); this.renderer.forceContextLoss();
  }
}
