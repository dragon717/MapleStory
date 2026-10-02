import * as T from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { resolveAssetUrl } from '../../assets/resource-url';
import { ClothGrid } from './voyage-physics';
import { VoyageWater, type WaterSpec } from './voyage-water';
import { ShipFlight, type ShipControls } from './voyage-ship';
import { VoyageClouds } from './voyage-clouds';
import { VoyageLogin, type LoginSurface } from './voyage-login';
import { VoyageCity } from './voyage-city';

export type VoyageStage = 'login' | 'channel' | 'characters' | 'create';
const poses = {
  far: { eye: [1500, 1100, 2000], aim: [250, 150, -1300] },
  mid: { eye: [260, 150, 370], aim: [170, 160, -700] },
  overview: { eye: [270, 190, 450], aim: [120, -10, -700] },
  deck: { eye: [2.2, 11.2, 4], aim: [.7, 5, -65] },
  cabin: { eye: [7, 6, 56], aim: [7, 3.4, 31] },
  berths: { eye: [0, 9, 51], aim: [0, .5, 43] },
  city: { eye: [1900, 1300, -600], aim: [450, 70, -2200] },
  ship: { eye: [150, 85, -145], aim: [0, 10, 0] },
  water: { eye: [165, 50, -2580], aim: [80, -19.605, -2690] },
} as const;
type Shot = keyof typeof poses;
const smooth = (v: number) => v * v * (3 - 2 * v);
const dispose = (root: T.Object3D) => {
  const materials = new Set<T.Material>(), textures = new Set<T.Texture>();
  root.traverse(object => {
    const mesh = object as T.Mesh;
    mesh.geometry?.dispose();
    for (const material of mesh.material ? Array.isArray(mesh.material) ? mesh.material : [mesh.material] : []) materials.add(material);
  });
  for (const material of materials) {
    for (const value of Object.values(material)) if (value instanceof T.Texture) textures.add(value);
    material.dispose();
  }
  for (const texture of textures) texture.dispose();
};

/** Environment and camera only. Account/character ownership stays in EntryView. */
export class EntryVoyage {
  readonly canvas: HTMLCanvasElement;
  private renderer: T.WebGLRenderer;
  private scene = new T.Scene();
  private camera = new T.PerspectiveCamera(46, 1, 1, 24000);
  private model?: T.Group;
  private ship?: T.Object3D;
  private flight?: ShipFlight;
  private shipRotation = new T.Quaternion();
  private stage: VoyageStage = 'login';
  private alive = true;
  private frame = 0;
  private elapsed = 0;
  private previous = 0;
  private duration = 12;
  private shot?: Shot;
  private reduced = matchMedia('(prefers-reduced-motion: reduce)');
  private resizeObserver: ResizeObserver;
  private hiddenObserver: MutationObserver;
  private clouds = new VoyageClouds();
  private login: VoyageLogin;
  private loginSurface?: LoginSurface;
  private city?: VoyageCity;
  private sun: T.DirectionalLight;
  private shipOrigin = new T.Vector3();
  private waterTime = { value: 0 };
  private water?: VoyageWater;
  private sails: { simulation: ClothGrid; meshes: { mesh: T.Mesh; map: number[]; offsets: Float32Array }[] }[] = [];
  private reflection: T.WebGLRenderTarget;
  private onVisibility = () => this.updateActivity();
  private onMotion = () => { if (this.reduced.matches) this.skip(); this.updateActivity(); };
  constructor(private host: HTMLElement, private ready: (error?: string) => void, bytes?: ArrayBuffer, cityBytes?: ArrayBuffer) {
    this.login = new VoyageLogin(host, () => this.skip());
    this.renderer = new T.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.renderer.toneMapping = T.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = T.PCFSoftShadowMap;
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'voyage-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.scene.background = new T.Color('#8ecfec');
    this.scene.fog = new T.Fog('#c5dfed', 4200, 15000);
    this.scene.add(new T.HemisphereLight('#d6ecff', '#687184', .5));
    const sun = new T.DirectionalLight('#fff0d5', 2.4);
    this.sun = sun;
    sun.position.set(-180, 260, 140); sun.target.position.set(0, 0, -30);
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -170, right: 170, top: 200, bottom: -200, near: 1, far: 900 });
    sun.shadow.normalBias = .06; sun.shadow.bias = -.001;
    this.scene.add(sun, sun.target);
    const sky = new T.Mesh(new T.SphereGeometry(14000, 32, 24), new T.ShaderMaterial({
      side: T.BackSide, depthWrite: false,
      uniforms: { top: { value: new T.Color('#62b9e8') }, bottom: { value: new T.Color('#e4f2fb') } },
      vertexShader: 'varying vec3 direction; void main(){direction=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: 'uniform vec3 top;uniform vec3 bottom;varying vec3 direction;void main(){float h=normalize(direction).y;gl_FragColor=vec4(mix(bottom,top,smoothstep(-.2,.6,h)),1.);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}',
    }));
    this.scene.add(sky);
    const moon = new T.Mesh(new T.SphereGeometry(130, 32, 24), new T.MeshStandardMaterial({ color: '#fff0cb', emissive: '#d2dcf2', emissiveIntensity: .2, roughness: 1 }));
    moon.position.set(-2200, 2100, -6800); this.scene.add(moon);
    const starGeometry = new T.OctahedronGeometry(7), starMaterial = new T.MeshBasicMaterial({ color: '#fff7d8' });
    for (let i = 0; i < 24; i++) {
      const star = new T.Mesh(starGeometry, starMaterial); star.position.set(Math.sin(i * 2.4) * 4800, 1500 + i % 7 * 180, -4200 - i % 5 * 430); star.scale.y = 2.2; this.scene.add(star);
    }
    const pmrem = new T.PMREMGenerator(this.renderer);
    this.reflection = pmrem.fromScene(this.scene, .04, .1, 16000);
    this.scene.environment = this.reflection.texture;
    this.scene.environmentIntensity = .65;
    pmrem.dispose();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.hiddenObserver = new MutationObserver(() => this.updateActivity());
    this.hiddenObserver.observe(host, { attributes: true, attributeFilter: ['hidden'] });
    document.addEventListener('visibilitychange', this.onVisibility);
    this.reduced.addEventListener('change', this.onMotion);
    try { if (sessionStorage.getItem('maple-voyage-seen') === '1') this.elapsed = this.duration; } catch { /* Optional display preference. */ }
    if (this.reduced.matches) this.elapsed = this.duration;
    const loader = new GLTFLoader();
    const loaded = (gltf: { scene: T.Group }) => {
      if (!this.alive) { dispose(gltf.scene); return; }
      this.model = gltf.scene; this.scene.add(gltf.scene);
      const city = gltf.scene.getObjectByName('SV2_City');
      if (city) city.visible = false;
      gltf.scene.traverse(object => {
        if (!(object instanceof T.Mesh)) return;
        object.castShadow = true; object.receiveShadow = true;
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          if (material instanceof T.MeshStandardMaterial) {
            if (material.map) material.map.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
          }
          if (material.name !== 'SV2_M_CrestDecal') continue;
          material.polygonOffset = true; material.polygonOffsetFactor = -2; material.polygonOffsetUnits = -2;
          material.depthWrite = false;
        }
      });
      gltf.scene.updateMatrixWorld(true);
      this.bindSails(gltf.scene);
      this.ship = gltf.scene.getObjectByName('SV2_Ship');
      if (this.ship) {
        this.shipOrigin.copy(this.ship.position); this.shipRotation.copy(this.ship.quaternion);
        if (this.ship.userData.rig_version === 1) this.flight = new ShipFlight(this.ship);
        const sign = gltf.scene.getObjectByName('SV2_LoginSign');
        if (sign) {
          this.ship.attach(sign);
          const anchor = sign.getObjectByName('SV3_LoginSurface');
          if (anchor) this.loginSurface = { anchor, width: Number(anchor.userData.width), height: Number(anchor.userData.height) };
        }
      }
      this.host.classList.add('entry-voyage-ready');
      this.setStage(this.stage); this.ready(); this.resize(); this.updateActivity();
    };
    const failed = () => { if (this.alive) { this.ready('天空航船模型加载失败；现有登录入口仍可使用。'); this.destroy(); } };
    const load = (url: string, buffer?: ArrayBuffer) => new Promise<{ scene: T.Group }>((resolve, reject) => {
      if (buffer) loader.parse(buffer, '', resolve, reject); else loader.load(resolveAssetUrl(url), resolve, undefined, reject);
    });
    void Promise.all([load('/assets/entry/sky-voyage.glb', bytes), load('/assets/entry/sky-city.glb', cityBytes)]).then(([shipModel, cityModel]) => {
      if (!this.alive) { dispose(shipModel.scene); dispose(cityModel.scene); return; }
      const root = cityModel.scene; root.position.set(450, -80, -2200); root.scale.setScalar(1.8); this.scene.add(root);
      root.traverse(o => { if (o instanceof T.Mesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.city = new VoyageCity(root);
      const pools: T.Object3D[] = []; root.traverse(o => { if (o.userData.landscape_role === 'decorative water; not simulated fluid') pools.push(o); });
      const inverse = root.matrixWorld.clone().invert();
      const specs: WaterSpec[] = pools.map((pool, i) => {
        const bounds = new T.Box3().setFromObject(pool), size = bounds.getSize(new T.Vector3()).divideScalar(1.8);
        const p = pool.getWorldPosition(new T.Vector3()).applyMatrix4(inverse); p.y += .42; pool.visible = false;
        return { kind: 'pool', id: 'city-pool-' + i, center: p.toArray() as [number, number, number], size: [size.x, size.z], depth: 1.2 };
      });
      this.water = new VoyageWater(root, specs);
      this.water.surfaces.forEach((surface, i) => this.city!.islandRoot(pools[i].userData.island_binding)?.attach(surface.mesh));
      loaded(shipModel);
    }).catch(failed);
    this.resize(); this.updateActivity();
  }
  attach(target: HTMLElement) { target.append(this.canvas); this.resize(); this.updateActivity(); }
  setStage(stage: VoyageStage) {
    this.shot = undefined;
    this.stage = stage;
    if (stage !== 'login') this.login.destroy();
    if (this.loginSurface) this.loginSurface.anchor.parent!.visible = stage === 'login';
    if (stage !== 'login') this.skip();
    if (this.model) {
      const cabin = stage === 'characters' || stage === 'create';
      const exterior = this.model.getObjectByName('SV3_Exterior');
      const interior = this.model.getObjectByName('SV3_CabinInterior');
      if (exterior) exterior.visible = !cabin;
      if (interior) interior.visible = cabin;
      if (cabin) this.flight?.setTrial(false);
      const roof = this.model.getObjectByName('SV2_CabinRoof');
      if (roof) roof.visible = stage !== 'characters' && stage !== 'create';
      for (const name of ['SV2_CabinBackWall', 'SV2_CabinBackTrim']) {
        const wall = this.model.getObjectByName(name);
        if (wall) wall.visible = stage !== 'characters' && stage !== 'create';
      }
    }
    this.updateActivity();
  }
  skip() {
    this.elapsed = this.duration;
    this.host.classList.remove('voyage-travelling');
    try { sessionStorage.setItem('maple-voyage-seen', '1'); } catch { /* Optional display preference. */ }
  }
  /** Preview controls share the production geometry/camera. */
  showShot(shot: Shot) {
    this.setStage(shot === 'cabin' ? 'create' : shot === 'berths' ? 'characters' : 'login'); this.skip(); this.shot = shot;
    const pose = poses[shot]; this.camera.position.fromArray(pose.eye); this.camera.lookAt(new T.Vector3().fromArray(pose.aim));
    this.renderer.render(this.scene, this.camera);
  }
  private resize() {
    if (!this.alive) return;
    const width = Math.max(1, this.host.clientWidth), height = Math.max(1, this.host.clientHeight);
    this.camera.aspect = width / height; this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    const size = this.renderer.getDrawingBufferSize(new T.Vector2()); this.clouds.resize(size.x, size.y);
    if (this.reduced.matches) this.updateActivity();
  }
  private updateActivity() {
    if (!this.alive) return;
    cancelAnimationFrame(this.frame); this.previous = 0;
    if (!this.host.hidden && !document.hidden) this.frame = requestAnimationFrame(this.draw);
  }
  private draw = (now: number) => {
    if (!this.alive || this.host.hidden || document.hidden) return;
    const delta = this.previous ? Math.min((now - this.previous) / 1000, .05) : 0;
    this.previous = now;
    this.flight?.update(this.reduced.matches ? 0 : delta, this.reduced.matches);
    this.city?.update(delta, this.reduced.matches);
    this.clouds.update(delta, this.reduced.matches);
    if (!this.reduced.matches) {
      this.waterTime.value += delta;
      this.water?.update(delta);
      this.updateSails(delta, now / 1000);
    }
    if (this.model) this.elapsed = Math.min(this.duration, this.elapsed + delta);
    const t = this.elapsed / this.duration;
    // One sun for materials and clouds; concentrate its shadow texels on the current subject.
    const wideShadow = this.shot === 'city' || this.shot === 'far' || this.shot === 'overview' || t < .48;
    const extent = wideShadow ? 1800 : 170, shadowCamera = this.sun.shadow.camera;
    if (shadowCamera.right !== extent) {
      this.sun.target.position.set(wideShadow ? 450 : 0, wideShadow ? -80 : 0, wideShadow ? -2200 : -30);
      this.sun.position.copy(this.sun.target.position).add(new T.Vector3(-180, 260, 170).multiplyScalar(wideShadow ? 7 : 1));
      Object.assign(shadowCamera, { left: -extent, right: extent, top: extent, bottom: -extent, far: wideShadow ? 8000 : 900 });
      shadowCamera.updateProjectionMatrix();
    }
    const cabin = this.stage === 'characters' || this.stage === 'create';
    const cabinPose = this.stage === 'characters' ? poses.berths : poses.cabin;
    const from = this.shot ? poses[this.shot] : cabin ? cabinPose : t < .48 ? poses.far : poses.mid;
    const to = this.shot ? poses[this.shot] : cabin ? cabinPose : t < .48 ? poses.mid : poses.deck;
    const blend = cabin ? 1 : smooth(t < .48 ? t / .48 : (t - .48) / .52);
    this.camera.position.fromArray(from.eye).lerp(new T.Vector3().fromArray(to.eye), blend);
    this.camera.lookAt(new T.Vector3().fromArray(from.aim).lerp(new T.Vector3().fromArray(to.aim), blend));
    let fieldOfView = 46;
    if (!this.shot && this.stage === 'login' && t === 1 && (this.host.clientWidth < 700 || this.host.clientHeight < 600)) {
      // Keep the verified clear camera position; dollying back puts the mast between the reader and paper.
      const board = new T.Vector3(-2.5, 9.6, -12.5);
      fieldOfView = T.MathUtils.radToDeg(2 * Math.atan(Math.max(3.65, 4 / this.camera.aspect) / this.camera.position.distanceTo(board)));
      this.camera.lookAt(board);
    }
    if (this.camera.fov !== fieldOfView) { this.camera.fov = fieldOfView; this.camera.updateProjectionMatrix(); }
    if (this.ship) {
      this.ship.position.set(this.shipOrigin.x, this.shipOrigin.y + (this.reduced.matches ? 0 : Math.sin(now / 2500) * .12), this.shipOrigin.z + (1 - smooth(t)) * 180);
      this.ship.quaternion.copy(this.shipRotation);
      if (this.flight?.trial) {
        this.ship.position.add(this.flight.position);
        this.ship.quaternion.multiply(new T.Quaternion().setFromEuler(new T.Euler(0, this.flight.heading, -this.flight.steering * .025)));
        this.camera.position.add(this.flight.position);
        this.camera.lookAt(new T.Vector3().fromArray(to.aim).add(this.flight.position));
      }
    }
    const travelling = t < 1 && this.stage === 'login';
    this.host.classList.toggle('voyage-travelling', travelling);
    if (t === 1) this.skip();
    const avatar = this.host.querySelector<HTMLElement>('.voyage-deck-avatar');
    if (avatar && this.ship) {
      const point = this.ship.localToWorld(new T.Vector3(0, .1, -24)).project(this.camera);
      avatar.style.left = `${(point.x + 1) * 50}%`; avatar.style.top = `${(1 - point.y) * 50}%`;
      avatar.hidden = travelling || cabin;
    }
    const projectedBunks = this.stage === 'characters' && this.host.clientWidth >= 900 && this.host.clientHeight >= 600 && Boolean(this.ship);
    this.host.classList.toggle('voyage-projected-bunks', projectedBunks);
    if (projectedBunks && this.ship) this.host.querySelectorAll<HTMLElement>('[data-berth]').forEach(button => {
      const index = Number(button.dataset.berth), x = [-5.4, -1.8, 1.8, 5.4][index];
      const anchor = this.model?.getObjectByName(`SV2_Bed_${index}_${button.classList.contains('selected') ? 'Foot' : 'Sleep'}Anchor`);
      const point = (anchor ? anchor.getWorldPosition(new T.Vector3()) : this.ship!.localToWorld(new T.Vector3(x, .4, 43))).project(this.camera);
      button.style.left = `${(point.x + 1) * 50}%`; button.style.top = `${(1 - point.y) * 50}%`;
    });
    else this.host.querySelectorAll<HTMLElement>('[data-berth]').forEach(button => { if (button.style.left) { button.style.removeProperty('left'); button.style.removeProperty('top'); } });
    const projectedWindows = this.stage === 'create' && this.host.clientWidth >= 900 && this.host.clientHeight >= 600 && Boolean(this.model);
    this.host.classList.toggle('voyage-projected-windows', projectedWindows);
    if (projectedWindows) this.host.querySelectorAll<HTMLElement>('[data-profession]').forEach(button => {
      const index = Number(button.dataset.profession) + 1;
      const anchor = this.model?.getObjectByName(`SV2_CabinFrontWindow_${String(index).padStart(2, '0')}`);
      if (!anchor) return;
      const point = anchor.getWorldPosition(new T.Vector3()).project(this.camera);
      button.style.left = `${(point.x + 1) * 50}%`; button.style.top = `${(1 - point.y) * 50}%`;
    });
    else this.host.querySelectorAll<HTMLElement>('[data-profession]').forEach(button => { if (button.style.left) { button.style.removeProperty('left'); button.style.removeProperty('top'); } });
    if (this.stage === 'login') this.login.update(this.camera, this.loginSurface);
    this.clouds.render(this.renderer, this.scene, this.camera, this.sun);
    if (!this.reduced.matches) this.frame = requestAnimationFrame(this.draw);
  };
  private bindSails(model: T.Group) {
    model.traverse(node => {
      if (node.userData.cloth_canvas_vertex_start !== 0) return;
      const columns = Number(node.userData.cloth_columns), rows = Number(node.userData.cloth_rows);
      if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 2 || rows < 2 || columns > 64 || rows > 64) return;
      const meshes: T.Mesh[] = [];
      node.traverse(child => { if (child instanceof T.Mesh && child.geometry.getAttribute('uv')) meshes.push(child); });
      const canvas = meshes.find(mesh => !(mesh.material as T.MeshStandardMaterial).map) ?? meshes[0];
      if (!canvas) return;
      const rest = new Float32Array((columns + 1) * (rows + 1) * 3), filled = new Set<number>();
      const gridIndex = (uv: T.BufferAttribute, i: number) => Math.round(uv.getY(i) * rows) * (columns + 1) + Math.round(uv.getX(i) * columns);
      const pos = canvas.geometry.getAttribute('position') as T.BufferAttribute, uv = canvas.geometry.getAttribute('uv') as T.BufferAttribute;
      for (let i = 0; i < pos.count; i++) { const grid = gridIndex(uv, i); if (grid < 0 || grid >= rest.length / 3) return; rest.set([pos.getX(i), pos.getY(i), pos.getZ(i)], grid * 3); filled.add(grid); }
      if (filled.size !== rest.length / 3) return;
      const pins = node.userData.cloth_pins;
      const attachments = typeof pins === 'string' ? JSON.parse(pins) : pins;
      const simulation = new ClothGrid(rest, columns, rows, Array.isArray(attachments) ? attachments : Number(node.userData.pin_v) === 1);
      this.sails.push({ simulation, meshes: meshes.map(mesh => {
        mesh.geometry = mesh.geometry.clone();
        const p = mesh.geometry.getAttribute('position') as T.BufferAttribute, u = mesh.geometry.getAttribute('uv') as T.BufferAttribute;
        p.setUsage(T.DynamicDrawUsage);
        const map: number[] = [], offsets = new Float32Array(p.count * 3);
        for (let i = 0; i < p.count; i++) {
          const grid = gridIndex(u, i); map.push(grid);
          offsets.set([p.getX(i) - rest[grid * 3], p.getY(i) - rest[grid * 3 + 1], p.getZ(i) - rest[grid * 3 + 2]], i * 3);
        }
        return { mesh, map, offsets };
      }) });
    });
  }
  private updateSails(delta: number, time: number) {
    for (const sail of this.sails) {
      const inverse = sail.meshes[0].mesh.matrixWorld.clone().invert();
      const gravity = new T.Vector3(0, -1, 0).transformDirection(inverse).multiplyScalar(9.81);
      const wind = new T.Vector3(6 + Math.sin(time * .8) * 2, .4, Math.sin(time * .45) * 2);
      const force = wind.length(); wind.transformDirection(inverse).multiplyScalar(force);
      sail.simulation.advance(delta, wind.toArray(), gravity.toArray());
      for (const { mesh, map, offsets } of sail.meshes) {
        const position = mesh.geometry.getAttribute('position') as T.BufferAttribute;
        for (let i = 0; i < position.count; i++) { const grid = map[i] * 3; position.setXYZ(i, sail.simulation.positions[grid] + offsets[i * 3], sail.simulation.positions[grid + 1] + offsets[i * 3 + 1], sail.simulation.positions[grid + 2] + offsets[i * 3 + 2]); }
        position.needsUpdate = true; mesh.geometry.computeVertexNormals(); mesh.geometry.computeBoundingSphere();
      }
    }
  }
  disturbWater() { this.water?.disturb(); }
  setShipControls(input: Partial<ShipControls>) { this.flight?.setControls(input); this.updateActivity(); }
  setShipTrial(enabled: boolean) { this.flight?.setTrial(enabled); this.showShot('ship'); this.updateActivity(); }
  shipStatus() {
    const flight = this.flight;
    return flight ? { sail: flight.deployment, steering: flight.steering, wind: flight.controls.wind, thrust: flight.thrust, speed: flight.speed, trial: flight.trial } : undefined;
  }
  destroy() {
    if (!this.alive) return;
    this.alive = false; cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect(); this.hiddenObserver.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.reduced.removeEventListener('change', this.onMotion);
    this.login.destroy(); this.clouds.destroy(); this.water?.dispose(); dispose(this.scene); this.reflection.dispose(); this.renderer.dispose(); this.renderer.forceContextLoss(); this.canvas.remove();
    this.host.classList.remove('entry-voyage-ready', 'voyage-travelling');
  }
}
