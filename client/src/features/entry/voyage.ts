import * as T from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { resolveAssetUrl } from '../../assets/resource-url';
import { ClothGrid } from './voyage-physics';
import { VoyageWater, type WaterSpec } from './voyage-water';
import { ShipFlight, type ShipControls } from './voyage-ship';
import { VoyageClouds } from './voyage-clouds';
import { VoyageLogin, type LoginSurface } from './voyage-login';
import { VoyageCity } from './voyage-city';
import { VoyageDeck } from './voyage-deck';
import { VoyagePassengers } from './voyage-passengers';
import { VoyageWindowLight } from './voyage-window-light';
import type { Part } from '../../assets/avatar-types';

export type VoyageStage = 'login' | 'channel' | 'characters' | 'create';
const poses = {
  far: { eye: [420, 210, 650], aim: [75, 45, -450] },
  mid: { eye: [160, 55, 205], aim: [5, 12, -50] },
  overview: { eye: [270, 190, 450], aim: [120, -10, -700] },
  deck: { eye: [25, 14, 11], aim: [5, 6.5, -14] },
  channel: { eye: [18, 11, 24], aim: [5, 6.3, 11] },
  cabin: { eye: [23, 19, 66], aim: [13, 2, 40] },
  berths: { eye: [-8.1, 5.8, 48], aim: [-8.1, .5, 43.7] },
  city: { eye: [150, 1300, -600], aim: [-1300, 70, -2200] },
  ship: { eye: [150, 85, -145], aim: [0, 10, 0] },
  water: { eye: [165, 50, -2580], aim: [80, -19.605, -2690] },
} as const;
type Shot = keyof typeof poses;
const smooth = (v: number) => v * v * (3 - 2 * v);
// One continuous take, metres / glTF Y-up. Arc-length sampling avoids speed jumps at knots.
const openingEye = new T.CatmullRomCurve3([poses.far.eye, [460, 225, 670], [180, 76, 260], [65, 29, 66], [34, 17, 20], poses.deck.eye].map(p => new T.Vector3().fromArray(p)), false, 'catmullrom', .25);
const openingAim = new T.CatmullRomCurve3([[75, 45, -450], [35, 35, -340], [0, 18, -110], [5, 10, -24], poses.deck.aim].map(p => new T.Vector3().fromArray(p)), false, 'catmullrom', .25);
export function voyageOpeningPose(progress: number) {
  const t = Math.max(0, Math.min(1, progress)), ease = t * t * t * (t * (t * 6 - 15) + 10);
  return { eye: openingEye.getPointAt(ease), aim: openingAim.getPointAt(ease) };
}
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
  private deck?: VoyageDeck;
  private deckCharacter?: string;
  private keys = new Set<string>();
  private stage: VoyageStage = 'login';
  private alive = true;
  private frame = 0;
  private elapsed = 0;
  private previous = 0;
  private duration = 24;
  private shot?: Shot;
  private reduced = matchMedia('(prefers-reduced-motion: reduce)');
  private resizeObserver: ResizeObserver;
  private hiddenObserver: MutationObserver;
  private clouds = new VoyageClouds();
  private login: VoyageLogin;
  private loginSurface?: LoginSurface;
  private city?: VoyageCity;
  private sun: T.DirectionalLight;
  private hemisphere: T.HemisphereLight;
  private cabinLights = new T.Group();
  private windowLight?: VoyageWindowLight;
  private passengers = new VoyagePassengers(() => { if (this.reduced.matches && this.keys.size === 0) this.updateActivity(); });
  private page = 0;
  private aim = new T.Vector3().fromArray(poses.far.aim);
  private transition?: { eye: T.Vector3; aim: T.Vector3; fov: number; time: number; duration: number; fromCabin: boolean; toCabin: boolean };
  private cabinShown = false;
  private shipOrigin = new T.Vector3();
  private waterTime = { value: 0 };
  private water?: VoyageWater;
  private sails: { simulation: ClothGrid; meshes: { mesh: T.Mesh; map: number[]; offsets: Float32Array }[] }[] = [];
  private reflection: T.WebGLRenderTarget;
  private clearMovement = () => { this.keys.clear(); this.passengers.deckMoving = false; };
  private onKey = (event: KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(event.code)) return;
    if (event.type === 'keyup') { this.keys.delete(event.code); return; }
    if (this.stage !== 'channel' || !this.deckCharacter || this.host.hidden || document.hidden || this.host.getAttribute('aria-busy') === 'true' || event.altKey || event.ctrlKey || event.metaKey || (event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[contenteditable]'))) { this.clearMovement(); return; }
    event.preventDefault(); this.keys.add(event.code);
    if (this.reduced.matches && !event.repeat) this.updateActivity();
  };
  private onVisibility = () => { this.clearMovement(); this.updateActivity(); };
  private onMotion = () => { if (this.reduced.matches) this.skip(); this.updateActivity(); };
  constructor(private host: HTMLElement, private ready: (error?: string) => void, bytes?: ArrayBuffer, cityBytes?: ArrayBuffer) {
    this.login = new VoyageLogin(host);
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
    this.hemisphere = new T.HemisphereLight('#d6ecff', '#687184', .5); this.scene.add(this.hemisphere);
    const sun = new T.DirectionalLight('#fff0d5', 2.4);
    this.sun = sun;
    sun.position.set(180, 260, 140); sun.target.position.set(0, 0, -30);
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
    sky.name = 'VoyageSky'; this.scene.add(sky);
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
    document.addEventListener('keydown', this.onKey); document.addEventListener('keyup', this.onKey);
    window.addEventListener('blur', this.clearMovement);
    this.reduced.addEventListener('change', this.onMotion);
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
            if (material.map && material.userData.wood_bump_from_basecolor) {
              material.bumpMap = material.map; material.bumpScale = Number(material.userData.wood_bump_from_basecolor);
            }
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
        this.deck = new VoyageDeck(this.ship); this.passengers.deckPosition.copy(this.deck.position);
        this.passengers.attach(this.ship);
        this.ship.add(this.cabinLights);
        this.windowLight = new VoyageWindowLight(this.ship, gltf.scene, this.cabinLights);
        for (const x of [-11.7, -3.6, 4.5, 11.7]) {
          const lamp = new T.PointLight('#ffb76c', 9, 7, 2); lamp.position.set(x, 2.2, 42.6); this.cabinLights.add(lamp);
        }
        if (this.ship.userData.rig_version === 1) this.flight = new ShipFlight(this.ship);
        const sign = gltf.scene.getObjectByName('SV2_LoginSign');
        if (sign) {
          this.ship.attach(sign);
          const anchor = sign.getObjectByName('SV3_LoginSurface');
          if (anchor) this.loginSurface = { anchor, width: Number(anchor.userData.width), height: Number(anchor.userData.height) };
        }
      }
      this.host.classList.add('entry-voyage-ready');
      this.showCabin(this.stage === 'characters' || this.stage === 'create'); this.ready(); this.resize(); this.updateActivity();
    };
    const failed = () => { if (this.alive) { this.host.classList.add('voyage-unavailable'); this.ready('天空航船模型加载失败；现有登录入口仍可使用。'); this.destroy(); } };
    const load = (url: string, buffer?: ArrayBuffer) => new Promise<{ scene: T.Group }>((resolve, reject) => {
      if (buffer) loader.parse(buffer, '', resolve, reject); else loader.load(resolveAssetUrl(url), resolve, undefined, reject);
    });
    void Promise.all([load('/assets/entry/sky-voyage.glb', bytes), load('/assets/entry/sky-city.glb', cityBytes)]).then(([shipModel, cityModel]) => {
      if (!this.alive) { dispose(shipModel.scene); dispose(cityModel.scene); return; }
      const root = cityModel.scene; root.position.set(-1300, -80, -2200); root.scale.setScalar(1.8); this.scene.add(root);
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
    const changed = this.stage !== stage;
    if (changed) this.clearMovement();
    if (changed && this.model && !this.reduced.matches) this.beginTransition(stage, 2.6);
    this.shot = undefined;
    this.stage = stage;
    if (stage !== 'login') this.login.destroy();
    if (this.loginSurface) this.loginSurface.anchor.parent!.visible = stage === 'login';
    if (stage !== 'login') this.skip();
    if (!this.transition) this.showCabin(stage === 'characters' || stage === 'create');
    this.resize(); this.updateActivity();
  }
  private showCabin(cabin: boolean) {
    this.cabinShown = cabin;
    this.cabinLights.visible = cabin;
    const sky = this.scene.getObjectByName('VoyageSky') as T.Mesh<T.SphereGeometry, T.ShaderMaterial>;
    sky.material.uniforms.top.value.set(cabin ? '#111724' : '#62b9e8');
    sky.material.uniforms.bottom.value.set(cabin ? '#222736' : '#e4f2fb');
    if (this.model) {
      const exterior = this.model.getObjectByName('SV3_Exterior');
      const interior = this.model.getObjectByName('SV3_CabinInterior');
      if (exterior) exterior.visible = !cabin;
      if (interior) interior.visible = cabin;
      if (cabin) this.flight?.setTrial(false);
      const roof = this.model.getObjectByName('SV2_CabinRoof');
      if (roof) roof.visible = !cabin;
      for (const name of ['SV2_CabinBackWall', 'SV2_CabinBackTrim']) {
        const wall = this.model.getObjectByName(name);
        if (wall) wall.visible = !cabin;
      }
    }
  }
  private beginTransition(stage: VoyageStage, duration: number) {
    this.transition = { eye: this.camera.position.clone(), aim: this.aim.clone(), fov: this.camera.fov, time: 0, duration, fromCabin: this.cabinShown, toCabin: stage === 'characters' || stage === 'create' };
  }
  setPassengers(ids: string[], selected: string | undefined, page: number) {
    if (page !== this.page && this.stage === 'characters' && !this.reduced.matches) this.beginTransition(this.stage, 1.25);
    if (selected !== this.deckCharacter) { this.clearMovement(); this.deck?.reset(); }
    this.deckCharacter = selected;
    this.page = page; this.passengers.setSlots(ids, selected, this.stage, page);
  }
  passengerAction(id: string) { return this.passengers.action(id); }
  passengerSleeping(id: string) { return this.passengers.sleeping(id); }
  setPassengerFrame(id: string, parts: Part[]) { void this.passengers.setFrame(id, parts); }
  depart() { this.clearMovement(); return this.passengers.depart(); }
  cancelDeparture() { this.passengers.cancelDeparture(); this.updateActivity(); }
  skip() {
    this.elapsed = this.duration;
    this.host.classList.remove('voyage-travelling');
    this.updateActivity();
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
    this.camera.aspect = width / height;
    this.camera.clearViewOffset();
    if (this.stage === 'channel' && width > 700) {
      const quick = this.host.querySelector('.entry-quick')?.getBoundingClientRect();
      const channels = this.host.querySelector('.entry-channels')?.getBoundingClientRect();
      const host = this.host.getBoundingClientRect();
      if (quick && channels && channels.left - quick.right > 150) {
        // Keep the standing passenger in the visible deck between the lobby panels.
        const center = (quick.right + channels.left) / 2 - host.left;
        this.camera.setViewOffset(width, height, width / 2 - center, 0, width, height);
      }
    }
    this.camera.updateProjectionMatrix();
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
    if (this.deck && this.ship && this.stage === 'channel') {
      if (this.host.getAttribute('aria-busy') === 'true') this.clearMovement();
      const held = (...codes: string[]) => codes.some(code => this.keys.has(code)) ? 1 : 0;
      this.deck.update(delta, held('ArrowRight', 'KeyD') - held('ArrowLeft', 'KeyA'), held('ArrowDown', 'KeyS') - held('ArrowUp', 'KeyW'), this.camera, this.ship);
      this.passengers.deckPosition.copy(this.deck.position); this.passengers.deckMoving = this.deck.moving; this.passengers.deckFacing = this.deck.facing;
    }
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
    const wideShadow = this.shot === 'city' || this.shot === 'far' || this.shot === 'overview' || this.elapsed < 6;
    const extent = wideShadow ? 1800 : 170, shadowCamera = this.sun.shadow.camera;
    if (shadowCamera.right !== extent) {
      this.sun.target.position.set(wideShadow ? -1300 : 0, wideShadow ? -80 : 0, wideShadow ? -2200 : -30);
      this.sun.position.copy(this.sun.target.position).add(new T.Vector3(180, 260, 170).multiplyScalar(wideShadow ? 7 : 1));
      Object.assign(shadowCamera, { left: -extent, right: extent, top: extent, bottom: -extent, far: wideShadow ? 8000 : 900 });
      shadowCamera.updateProjectionMatrix();
    }
    const cabin = this.stage === 'characters' || this.stage === 'create';
    const compactCreate = this.host.clientWidth < 900 || this.host.clientHeight < 600;
    const createPose = compactCreate ? this.host.clientWidth < 600 ? { eye: [8, 10, 57], aim: [0, -6, 39] } : { eye: [13, 9, 55], aim: [5, 0, 39] } : poses.cabin;
    const cabinPose = this.stage === 'characters' ? { eye: [poses.berths.eye[0] + this.page * 8.1, 5.8, 48], aim: [poses.berths.aim[0] + this.page * 8.1, .5, 43.7] } : createPose;
    const fixed = this.shot ? poses[this.shot] : cabin ? cabinPose : this.stage === 'channel' ? poses.channel : undefined;
    const opening = voyageOpeningPose(t);
    const arrival = 1 - smooth(Math.min(1, t / .78));
    const shipOffset = new T.Vector3(-150 * arrival, 0, 220 * arrival);
    this.camera.position.copy(fixed ? new T.Vector3().fromArray(fixed.eye) : opening.eye);
    const aim = fixed ? new T.Vector3().fromArray(fixed.aim) : opening.aim;
    if (this.stage === 'channel' && !this.shot && this.deck) {
      const offset = this.deck.position.clone().sub(this.deck.spawn); this.camera.position.add(offset); aim.add(offset);
    }
    let fieldOfView = this.stage === 'characters' ? Math.max(38, T.MathUtils.radToDeg(2 * Math.atan(3.9 / this.camera.aspect / this.camera.position.distanceTo(aim)))) : 46;
    if (!this.shot && this.stage === 'login' && (this.host.clientWidth < 700 || this.host.clientHeight < 600)) {
      // Keep the verified clear camera position; dollying back puts the mast between the reader and paper.
      const board = new T.Vector3(10.518, 9.6, 0);
      const settle = smooth(Math.max(0, Math.min(1, (t - .78) / .22)));
      const finalFov = T.MathUtils.radToDeg(2 * Math.atan(Math.max(3.65, 4 / this.camera.aspect) / new T.Vector3().fromArray(poses.deck.eye).distanceTo(board)));
      fieldOfView = T.MathUtils.lerp(46, finalFov, settle); aim.lerp(board, settle);
    }
    let passage = 0;
    if (this.transition) {
      const tr = this.transition; tr.time = Math.min(tr.duration, tr.time + delta);
      const progress = tr.time / tr.duration, amount = smooth(progress);
      this.camera.position.lerpVectors(tr.eye, this.camera.position.clone(), amount); aim.lerpVectors(tr.aim, aim.clone(), amount);
      fieldOfView = T.MathUtils.lerp(tr.fov, fieldOfView, amount);
      if (tr.fromCabin !== tr.toCabin) {
        // The short dark passage conceals the interior set while the camera continues moving.
        passage = smooth(Math.min(1, Math.max(0, (progress - .18) / .24))) * (1 - smooth(Math.min(1, Math.max(0, (progress - .6) / .28))));
        this.showCabin(progress >= .5 ? tr.toCabin : tr.fromCabin);
      }
      if (progress === 1) this.transition = undefined;
    }
    this.host.style.setProperty('--voyage-passage', String(passage));
    this.aim.copy(aim); this.camera.lookAt(aim);
    this.hemisphere.intensity = this.cabinShown ? .14 : .5;
    this.sun.intensity = this.cabinShown ? .3 : 2.4;
    this.scene.environmentIntensity = this.cabinShown ? .2 : .65;
    if (this.camera.fov !== fieldOfView) { this.camera.fov = fieldOfView; this.camera.updateProjectionMatrix(); }
    if (this.ship) {
      this.ship.position.copy(this.shipOrigin).add(shipOffset);
      this.ship.position.y += this.reduced.matches ? 0 : Math.sin(now / 2500) * .12;
      this.ship.quaternion.copy(this.shipRotation);
      if (this.flight?.trial) {
        this.ship.position.add(this.flight.position);
        this.ship.quaternion.multiply(new T.Quaternion().setFromEuler(new T.Euler(0, this.flight.heading, -this.flight.steering * .025)));
        this.camera.position.add(this.flight.position);
        this.camera.lookAt(aim.clone().add(this.flight.position));
      }
    }
    this.camera.updateMatrixWorld(true);
    const travelling = t < 1 && this.stage === 'login';
    this.host.classList.toggle('voyage-travelling', travelling);
    const avatar = this.host.querySelector<HTMLElement>('.voyage-deck-avatar');
    if (avatar && this.ship) {
      const point = this.ship.localToWorld(this.passengers.deckPosition.clone()).project(this.camera);
      avatar.style.left = `${(point.x + 1) * 50}%`; avatar.style.top = `${(1 - point.y) * 50}%`;
      avatar.hidden = travelling || cabin;
    }
    const draft = this.host.querySelector<HTMLElement>('.entry-create-preview');
    if (draft && this.ship) {
      const point = this.ship.localToWorld(new T.Vector3(0, .025, 38.8)).project(this.camera);
      draft.style.left = `${(point.x + 1) * 50}%`; draft.style.top = `${(1 - point.y) * 50}%`;
    }
    if (this.model) this.passengers.update(delta, this.reduced.matches, this.model, this.camera, now);
    this.host.classList.toggle('voyage-world-avatars', Boolean(this.model));
    const projectedBunks = this.stage === 'characters' && Boolean(this.ship);
    this.host.classList.toggle('voyage-projected-bunks', projectedBunks);
    if (projectedBunks && this.ship) this.host.querySelectorAll<HTMLElement>('[data-berth]').forEach(button => {
      const index = this.page * 4 + Number(button.dataset.berth), x = -10.8 + index * 1.8;
      const anchor = this.model?.getObjectByName(`SV2_Bed_${index}_FootAnchor`);
      const point = (anchor ? anchor.getWorldPosition(new T.Vector3()) : this.ship!.localToWorld(new T.Vector3(x, .4, 43))).project(this.camera);
      const head = this.model?.getObjectByName(`SV2_Bed_${index}_SleepAnchor`)?.getWorldPosition(new T.Vector3());
      if (head) {
        const top = head.clone().add(new T.Vector3(0, .7, -1)).project(this.camera);
        const left = head.clone().add(new T.Vector3(-.75, 0, 0)).project(this.camera);
        const right = head.clone().add(new T.Vector3(.75, 0, 0)).project(this.camera);
        button.style.width = `${Math.max(48, Math.abs(right.x - left.x) * this.host.clientWidth / 2)}px`;
        button.style.height = `${Math.max(85, (top.y - point.y) * this.host.clientHeight / 2)}px`;
        button.style.minHeight = '0';
      }
      button.style.left = `${(point.x + 1) * 50}%`; button.style.top = `${(1 - point.y) * 50}%`;
      button.style.visibility = point.z < -1 || point.z > 1 || !this.cabinShown || passage > .2 ? 'hidden' : 'visible';
    });
    else this.host.querySelectorAll<HTMLElement>('[data-berth]').forEach(button => { if (button.style.left) { button.style.removeProperty('left'); button.style.removeProperty('top'); } });
    const projectedWindows = this.stage === 'create' && this.host.clientWidth >= 900 && this.host.clientHeight >= 600 && Boolean(this.model);
    this.host.classList.toggle('voyage-projected-windows', projectedWindows);
    if (projectedWindows) this.host.querySelectorAll<HTMLElement>('[data-profession]').forEach(button => {
      const index = Number(button.dataset.profession) + 1;
      const anchor = this.model?.getObjectByName(`SV2_CabinFrontWindow_${String(index).padStart(2, '0')}`);
      if (!anchor) return;
      const center = anchor.getWorldPosition(new T.Vector3()), halfHeight = Number(anchor.userData.glass_height) / 2;
      const point = center.clone().project(this.camera), top = center.clone().add(new T.Vector3(0, halfHeight, 0)).project(this.camera), bottom = center.clone().add(new T.Vector3(0, -halfHeight, 0)).project(this.camera);
      const edge = center.clone().add(new T.Vector3(Number(anchor.userData.glass_width) / 2, 0, 0)).project(this.camera);
      button.style.width = `${Math.max(50, Math.abs(edge.x - point.x) * this.host.clientWidth)}px`;
      button.style.height = `${Math.max(70, (top.y - bottom.y) * this.host.clientHeight / 2)}px`;
      button.style.minHeight = '0'; button.style.left = `${(point.x + 1) * 50}%`; button.style.top = `${(1 - bottom.y) * 50}%`;
    });
    else this.host.querySelectorAll<HTMLElement>('[data-profession]').forEach(button => { if (button.style.left) button.removeAttribute('style'); });
    const exterior = this.model?.getObjectByName('SV3_Exterior');
    const loginVisible = this.stage === 'login' && this.login.update(this.camera, this.loginSurface, exterior ? [exterior] : []);
    this.host.classList.toggle('voyage-login-visible', loginVisible);
    this.clouds.render(this.renderer, this.scene, this.camera, this.sun, this.cabinShown ? this.windowLight : undefined);
    if (!this.reduced.matches || this.keys.size > 0) this.frame = requestAnimationFrame(this.draw);
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
    document.removeEventListener('keydown', this.onKey); document.removeEventListener('keyup', this.onKey); window.removeEventListener('blur', this.clearMovement);
    this.clearMovement(); this.deck?.destroy();
    this.reduced.removeEventListener('change', this.onMotion);
    this.passengers.destroy(); this.login.destroy(); this.clouds.destroy(); this.windowLight?.destroy(); this.water?.dispose(); dispose(this.scene); this.reflection.dispose(); this.renderer.dispose(); this.renderer.forceContextLoss(); this.canvas.remove();
    this.host.classList.remove('entry-voyage-ready', 'voyage-travelling', 'voyage-login-visible');
  }
}
