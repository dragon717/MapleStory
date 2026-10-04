import * as T from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { resolveAssetUrl } from '../../assets/resource-url';
import { ClothGrid } from './voyage-physics';
import { VoyageWater, type WaterSpec } from './voyage-water';
import { ShipFlight, type ShipControls } from './voyage-ship';
import { VoyageClouds } from './voyage-clouds';
import { VoyageLogin, projectLoginSurface, type LoginSurface } from './voyage-login';
import { VoyageCity } from './voyage-city';
import { VoyageDeck } from './voyage-deck';
import { LocalReveal } from '../henesys/local-reveal';
import { VoyagePassengers } from './voyage-passengers';
import { VoyageWindowLight } from './voyage-window-light';
import type { Part } from '../../assets/avatar-types';
import { VOYAGE_SHIP_SCALE } from './voyage-scale';
import { createVoyagePaper, VoyagePaperProjector, type VoyagePaperSurface } from './voyage-paper';

export type VoyageStage = 'login' | 'channel' | 'characters' | 'create';
const poses = {
  far: { eye: [420, 210, 650], aim: [75, 45, -450] },
  mid: { eye: [160, 55, 205], aim: [5, 12, -50] },
  overview: { eye: [270, 190, 450], aim: [120, -10, -700] },
  deck: { eye: [.1, 7.2, 9], aim: [4.32, 6.78, 7] },
  channel: { eye: [-8, 11, 24], aim: [5, 6.3, 11] },
  cabin: { eye: [23, 19, 66], aim: [13, 2, 40] },
  berths: { eye: [-8.1, 5.8, 48], aim: [-8.1, .5, 43.7] },
  city: { eye: [150, 1300, -600], aim: [-1300, 70, -2200] },
  ship: { eye: [150, 85, -145], aim: [0, 10, 0] },
  water: { eye: [165, 50, -2580], aim: [80, -19.605, -2690] },
} as const;
type Shot = keyof typeof poses;
type CabinInteraction = { kind: 'enter-cabin' | 'return-deck' | 'create-character' | 'role-details'; label: string; id?: string; slot?: number };
const smooth = (v: number) => v * v * (3 - 2 * v);
const shipPose = <T extends { eye: readonly number[]; aim: readonly number[] }>(pose: T) => ({
  eye: pose.eye.map(value => value * VOYAGE_SHIP_SCALE),
  aim: pose.aim.map(value => value * VOYAGE_SHIP_SCALE),
});
const poseFor = (shot: Shot) => shot === 'city' || shot === 'water' ? poses[shot] : shipPose(poses[shot]);
// One continuous take, metres / glTF Y-up. Arc-length sampling avoids speed jumps at knots.
const openingEye = new T.CatmullRomCurve3([shipPose(poses.far).eye, [460, 225, 670], [180, 76, 260], [65, 29, 66], [34, 17, 20], shipPose(poses.deck).eye].map(p => new T.Vector3().fromArray(p)), false, 'catmullrom', .25);
const openingAim = new T.CatmullRomCurve3([shipPose(poses.far).aim, [35, 35, -340], [0, 18, -110], [5, 10, -24], shipPose(poses.deck).aim].map(p => new T.Vector3().fromArray(p)), false, 'catmullrom', .25);
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
  private skyDecor = new T.Group();
  private camera = new T.PerspectiveCamera(46, 1, 1, 24000);
  private model?: T.Group;
  private ship?: T.Object3D;
  private flight?: ShipFlight;
  private shipRotation = new T.Quaternion();
  private deck?: VoyageDeck;
  private cabinDeck?: VoyageDeck;
  private ids: string[] = [];
  private entranceArmed = true;
  private exitArmed = false;
  onCabin?: () => void;
  onDeck?: () => void;
  onCreate?: (slot: number) => void;
  onCharacter?: (id: string) => void;
  private reveal?: LocalReveal;
  onAdventure?: () => void;
  private pitch = .24;
  private yaw = 0;
  private zoom = 1.2;
  private inspection = false;
  private inspectionYaw = 0;
  private inspectionPitch = .48;
  private shipBounds?: T.Sphere;
  private followYaw = Math.PI / 2;
  private followEye?: T.Vector3;
  private followAim?: T.Vector3;
  private interactions: CabinInteraction[] = [];
  private choosingInteraction = false;
  private interactionIndex = 0;
  private cameraRay = new T.Raycaster();
  private cameraObstacles: T.Mesh[] = [];
  private drag?: { id: number; x: number; y: number };
  private deckCharacter?: string;
  private keys = new Set<string>();
  private stage: VoyageStage = 'login';
  private alive = true;
  private frame = 0;
  private elapsed = 0;
  private previous = 0;
  private animationTime = 0;
  private duration = 24;
  private shot?: Shot;
  private reduced = matchMedia('(prefers-reduced-motion: reduce)');
  private resizeObserver: ResizeObserver;
  private hiddenObserver: MutationObserver;
  private clouds = new VoyageClouds();
  private login: VoyageLogin;
  private loginSurface?: LoginSurface;
  private adventureSurface?: LoginSurface;
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
  private sails: { simulation: ClothGrid; target: Float32Array; morph: Float32Array; meshes: { mesh: T.Mesh; map: number[]; offsets: Float32Array; basis: Float32Array }[] }[] = [];
  private portalMeshes: T.Mesh[] = [];
  private portalTextures: T.Texture[] = [];
  private portalFrameTextures: T.Texture[] = [];
  private portalFrameIndex = 0;
  private portalFrameElapsed = 0;
  private floorCount?: T.Mesh;
  private floorCountTexture?: T.CanvasTexture;
  private slotLimit = 0;
  private nearInteraction: 'enter-cabin' | 'return-deck' | 'create-character' | 'role-details' | undefined;
  private nearbyEmptySlot?: number;
  private nearbyCharacterId?: string;
  private roleDetailOpen = false;
  private rolePaper?: VoyagePaperSurface;
  private createPaper?: VoyagePaperSurface;
  private rolePaperProjector = new VoyagePaperProjector();
  private createPaperProjector = new VoyagePaperProjector();
  private reflection: T.WebGLRenderTarget;
  private clearMovement = () => { this.keys.clear(); this.passengers.deckMoving = false; this.drag = undefined; this.closeInteractionChoices(); };
  private cameraDown = (event: PointerEvent) => {
    if (!['channel','characters'].includes(this.stage) || !(event.button === 2 || this.inspection && event.button === 0) || event.target instanceof HTMLElement && event.target.closest('button,input,textarea,select')) return;
    event.preventDefault(); this.host.setPointerCapture(event.pointerId);
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };
  private cameraMove = (event: PointerEvent) => {
    if (this.drag?.id !== event.pointerId) return;
    if (this.inspection) {
      this.inspectionYaw -= (event.clientX - this.drag.x) * .005;
      this.inspectionPitch = T.MathUtils.clamp(this.inspectionPitch + (event.clientY - this.drag.y) * .003, -.25, 1.25);
    } else {
      this.yaw = T.MathUtils.clamp(this.yaw - (event.clientX - this.drag.x) * .004, -.45, .45);
      this.pitch = T.MathUtils.clamp(this.pitch + (event.clientY - this.drag.y) * .003, .08, .75);
    }
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    if (this.reduced.matches) this.updateActivity();
  };
  private cameraUp = () => { this.drag = undefined; };
  private cameraWheel = (event: WheelEvent) => {
    if (!['channel','characters'].includes(this.stage) || event.target instanceof HTMLElement && event.target.closest('input,textarea,select,.entry-create-panel')) return;
    event.preventDefault(); this.zoom = T.MathUtils.clamp(this.zoom * Math.exp(T.MathUtils.clamp(event.deltaY, -100, 100) * .002), .9, this.stage === 'channel' ? 6.2 : 2.3);
    if (this.stage === 'channel' && !this.inspection && this.zoom >= 2.6) { this.inspection = true; this.drag = undefined; this.inspectionYaw = this.followYaw + this.yaw; this.inspectionPitch = .48; }
    if (this.inspection && this.zoom <= 2.2) { this.inspection = false; this.drag = undefined; this.yaw = 0; }
    if (this.reduced.matches) this.updateActivity();
  };
  private contextMenu = (event: Event) => { if (['channel','characters'].includes(this.stage)) event.preventDefault(); };
  private onKey = (event: KeyboardEvent) => {
    if (this.choosingInteraction) {
      if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','KeyW','KeyA','KeyS','KeyD','Space','Enter','Escape'].includes(event.code)) {
        event.preventDefault();
        if (event.type === 'keydown' && !event.repeat) {
          if (event.code === 'Escape') this.closeInteractionChoices();
          else if (event.code === 'Space' || event.code === 'Enter') this.performInteraction(this.interactions[this.interactionIndex]);
          else { this.interactionIndex = (this.interactionIndex + (['ArrowLeft','ArrowUp','KeyW','KeyA'].includes(event.code) ? -1 : 1) + this.interactions.length) % this.interactions.length; this.renderInteractionChoices(); }
        }
        return;
      }
    }
    if (event.type === 'keydown' && event.code === 'Escape' && this.roleDetailOpen) { event.preventDefault(); this.closeRoleDetails(); return; }
    if (this.roleDetailOpen) return;
    if (event.type === 'keydown' && ['Space', 'KeyX', 'ControlLeft', 'ControlRight'].includes(event.code) && ['channel','characters'].includes(this.stage) && !this.host.hidden && !document.hidden && !event.repeat && this.host.getAttribute('aria-busy') !== 'true' && !(event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[contenteditable]'))) {
      event.preventDefault();
      if (event.code === 'Space') {
        if (this.interactions.length > 1) { this.keys.clear(); this.passengers.deckMoving = false; this.choosingInteraction = true; this.interactionIndex = 0; this.renderInteractionChoices(); }
        else if (this.interactions.length) this.performInteraction(this.interactions[0]);
        else (this.stage === 'characters' ? this.cabinDeck : this.deck)?.jump();
        if (this.reduced.matches) this.updateActivity();
      }
      else if (this.stage === 'channel') this.onAdventure?.();
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(event.code)) return;
    if (event.type === 'keyup') { this.keys.delete(event.code); return; }
    if (!['channel','characters'].includes(this.stage) || this.host.hidden || document.hidden || (this.host.getAttribute('aria-busy') === 'true' && !this.host.classList.contains('voyage-loading')) || event.altKey || event.ctrlKey || event.metaKey || (event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[contenteditable]'))) { this.clearMovement(); return; }
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
    // Native depth-comparison shadows are required by the stained-glass haze.
    this.renderer.shadowMap.type = T.PCFShadowMap;
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'voyage-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.host.addEventListener('pointerdown', this.cameraDown);
    this.host.addEventListener('pointermove', this.cameraMove);
    this.host.addEventListener('pointerup', this.cameraUp);
    this.host.addEventListener('pointercancel', this.cameraUp);
    this.host.addEventListener('wheel', this.cameraWheel, { passive: false });
    this.host.addEventListener('contextmenu', this.contextMenu);
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
    this.scene.add(this.skyDecor);
    const moon = new T.Mesh(new T.SphereGeometry(130, 32, 24), new T.MeshStandardMaterial({ color: '#fff0cb', emissive: '#d2dcf2', emissiveIntensity: .2, roughness: 1 }));
    moon.position.set(-2200, 2100, -6800); this.skyDecor.add(moon);
    const starGeometry = new T.OctahedronGeometry(7), starMaterial = new T.MeshBasicMaterial({ color: '#fff7d8' });
    for (let i = 0; i < 24; i++) {
      const star = new T.Mesh(starGeometry, starMaterial); star.position.set(Math.sin(i * 2.4) * 4800, 1500 + i % 7 * 180, -4200 - i % 5 * 430); star.scale.y = 2.2; this.skyDecor.add(star);
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
            if (material.map) {
              material.map.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
              const decal = ['SV2_M_CrestDecal', 'SV3_MainSail_MapleDecal'].includes(material.name);
              material.map.wrapS = material.map.wrapT = decal ? T.ClampToEdgeWrapping : T.RepeatWrapping;
              const semantic = String(material.userData.voyage_material_semantic ?? '');
              // Older cached GLBs carry the pre-polish UV projection. Keep
              // the source recipe's directional grain readable until Blender
              // can regenerate the scene on the build machine.
              if (semantic === 'SparWood' || semantic === 'SternWalnut') material.map.repeat.set(.9, 1.05);
              if (semantic === 'DeckTeak') material.map.repeat.set(.8, .8);
              material.map.needsUpdate = true;
            }
            const semantic = String(material.userData.voyage_material_semantic ?? '');
            if (semantic === 'SparWood' || semantic === 'SternWalnut') material.roughness = Math.max(material.roughness, .72);
            if (material.map && material.userData.wood_bump_from_basecolor) {
              material.bumpMap = material.map;
              material.bumpScale = Math.min(.035, Number(material.userData.wood_bump_from_basecolor));
            }
          }
          if (!['SV2_M_CrestDecal','SV3_MainSail_MapleDecal'].includes(material.name)) continue;
          material.polygonOffset = true; material.polygonOffsetFactor = -2; material.polygonOffsetUnits = -2;
          material.depthWrite = false;
        }
      });
      gltf.scene.updateMatrixWorld(true);
      this.bindSails(gltf.scene);
      this.ship = gltf.scene.getObjectByName('SV2_Ship');
      if (this.ship) {
        this.ship.scale.setScalar(VOYAGE_SHIP_SCALE);
        this.ship.userData.presentation_scale = VOYAGE_SHIP_SCALE;
        this.shipOrigin.copy(this.ship.position); this.shipRotation.copy(this.ship.quaternion);
        this.reveal = new LocalReveal(this.ship, mesh => {
          // Cloth and its folding spars keep their full render; only solid ship scenery can hide the body.
          let node: T.Object3D | null = mesh;
          while (node) { if (node.userData.cloth_columns || node.name.startsWith('SV3_MainSail_Crest')) return false; node=node.parent; }
          return true;
        });
        this.deck = new VoyageDeck(this.ship); this.cabinDeck = new VoyageDeck(this.ship, true); this.passengers.deckPosition.copy(this.deck.position);
        this.passengers.attach(this.ship);
        this.ship.add(this.cabinLights);
        this.windowLight = new VoyageWindowLight(this.ship, gltf.scene, this.cabinLights);
        for (const x of [-11.7, -3.6, 4.5, 11.7]) {
          const lamp = new T.PointLight('#ffb76c', 36, 14, 2); lamp.position.set(x, 2.2, 42.6); this.cabinLights.add(lamp);
        }
        if (this.ship.userData.rig_version === 1) this.flight = new ShipFlight(this.ship);
        const adventureAnchor = gltf.scene.getObjectByName('SV3_AdventureSurface');
        if (adventureAnchor) this.adventureSurface = { anchor: adventureAnchor, width: Number(adventureAnchor.userData.width), height: Number(adventureAnchor.userData.height) };
        const sign = gltf.scene.getObjectByName('SV2_LoginSign');
        if (sign) {
          // Older cached exports still contain the inboard sign from the room
          // repair.  Normalize both old and newly exported files at runtime so
          // the physical form always lives on the starboard exterior.
          this.ship.attach(sign);
          sign.position.set(10.3, 5.4, 0);
          sign.rotation.set(0, Math.PI / 2, 0);
          sign.scale.setScalar(1);
          sign.userData.login_surface_mount = 'starboard-exterior';
          const anchor = sign.getObjectByName('SV3_LoginSurface');
          if (anchor) this.loginSurface = { anchor, width: Number(anchor.userData.width), height: Number(anchor.userData.height) };
        }
        const adventureSign = gltf.scene.getObjectByName('SV3_AdventureSign');
        if (adventureSign) { this.ship.attach(adventureSign); adventureSign.position.set(5.05, 7, 10.3); adventureSign.rotation.set(0, Math.PI / 2, 0); }
        this.installPortalVisuals();
        this.installFloorCountLabel();
        this.installPapers();
      }
      this.ship?.traverse(o => {
        if (!(o instanceof T.Mesh)) return;
        for (let parent:T.Object3D|null=o;parent;parent=parent.parent) if (['SV2_LoginSign','SV3_AdventureSign'].includes(parent.name) || parent.name.startsWith('SV3_Passenger_')) return;
        if (!(Array.isArray(o.material) ? o.material : [o.material]).every(m => m.transparent || m instanceof T.MeshPhysicalMaterial && m.transmission > .5)) this.cameraObstacles.push(o);
      });
      this.host.classList.add('entry-voyage-ready');
      this.showCabin(this.stage === 'characters' || this.stage === 'create'); this.ready(); this.resize(); this.updateActivity();
    };
    const failed = (error: unknown) => { if (this.alive) { console.error('Voyage model initialization failed', error); this.host.classList.add('voyage-unavailable'); this.ready('天空航船模型加载失败；现有登录入口仍可使用。'); this.destroy(); } };
    const load = (url: string, buffer?: ArrayBuffer) => new Promise<{ scene: T.Group }>((resolve, reject) => {
      if (buffer) loader.parse(buffer, '', resolve, reject); else loader.load(resolveAssetUrl(url), resolve, undefined, reject);
    });
    void Promise.all([load('/assets/entry/sky-voyage.glb', bytes), load('/assets/entry/sky-city.glb', cityBytes), loader.loadAsync(resolveAssetUrl('/assets/entry/voyage-book.glb'))]).then(([shipModel, cityModel, bookModel]) => {
      const clip = bookModel.animations.find(clip => clip.name === 'SV3_BookOpenFlipGlow');
      if (!clip || !bookModel.scene.getObjectByName('SV3_DepartureBook')) {
        dispose(bookModel.scene); dispose(shipModel.scene); dispose(cityModel.scene); throw new Error('Invalid voyage book model');
      }
      if (!this.alive) dispose(bookModel.scene); else this.passengers.setBook(bookModel.scene, clip);
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
    const previousStage = this.stage;
    const changed = previousStage !== stage;
    if (changed) {
      this.clearMovement(); this.followEye = undefined; this.followAim = undefined; this.inspection = false; this.zoom = 1.2; this.yaw = 0;
      this.interactions = []; this.nearInteraction = undefined; this.nearbyEmptySlot = undefined; this.nearbyCharacterId = undefined;
      this.roleDetailOpen = false;
    }
    if (changed && this.model && !this.reduced.matches) this.beginTransition(stage, 2.6);
    this.shot = undefined;
    this.stage = stage;
    if (changed && stage === 'characters' && previousStage !== 'create') {
      this.cabinDeck?.reset(); this.passengers.finishWake(); this.exitArmed=false;
    }
    if (changed && stage === 'create' && this.createPaper && this.cabinDeck) this.createPaper.group.position.copy(this.cabinDeck.position).add(new T.Vector3(2.4, 3.2, -1.0));
    if (changed && stage === 'channel' && this.deck) {
      // A completed login always returns to the open starboard deck. The
      // portal remains a manual Space interaction along the main deck loop.
      this.deck.reset();
      this.entranceArmed=false;
    }
    const sign=this.model?.getObjectByName('SV3_AdventureSign');if(sign)sign.visible=stage==='channel';
    if (stage !== 'login') this.login.destroy();
    if (this.loginSurface) this.loginSurface.anchor.parent!.visible = stage === 'login';
    if (stage !== 'login') this.skip();
    if (!this.transition) this.showCabin(stage === 'characters' || stage === 'create');
    this.resize(); this.updateActivity();
    this.updateInteractionHint();
  }
  private showCabin(cabin: boolean) {
    this.cabinShown = cabin;
    this.cabinLights.visible = cabin;
    // Frame the standalone cabin against black; the exterior city and sky
    // decorations are restored by the same transition when leaving it.
    if (this.city) this.city.root.visible = !cabin;
    this.skyDecor.visible = !cabin;
    if (this.scene.background instanceof T.Color) this.scene.background.set(cabin ? '#000000' : '#8ecfec');
    const sky = this.scene.getObjectByName('VoyageSky') as T.Mesh<T.SphereGeometry, T.ShaderMaterial>;
    sky.material.uniforms.top.value.set(cabin ? '#000000' : '#62b9e8');
    sky.material.uniforms.bottom.value.set(cabin ? '#000000' : '#e4f2fb');
    if (this.model) {
      const exterior = this.model.getObjectByName('SV3_Exterior');
      const interior = this.model.getObjectByName('SV3_CabinInterior');
      if (exterior) exterior.visible = !cabin;
      if (interior) interior.visible = cabin;
      if (this.floorCount) this.floorCount.visible = cabin;
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
  private installPortalVisuals() {
    if (!this.ship || !this.model) return;
    this.model.getObjectByName('SV3_CaptainPortal_Ring')?.traverse(node => { node.visible = false; });
    this.model.getObjectByName('SV3_CabinDeckPortal_Ring')?.traverse(node => { node.visible = false; });
    // Source-backed portal sequence from resources/tms273-export/portals.json.
    // Every frame is authored with a 100ms delay; frame 0 is the shared editor
    // export used by the source data for the first animation frame.
    const frameUrls = [
      '/assets/tms273/Map__Canvas_MapHelper.img_portal_editor_pv-e7c0ca5e5a.png',
      '/assets/tms273/Map__Canvas_MapHelper.img_portal_game_pv_default_1-3f8016697c.png',
      '/assets/tms273/Map__Canvas_MapHelper.img_portal_game_pv_default_2-81bc6650af.png',
      '/assets/tms273/Map__Canvas_MapHelper.img_portal_game_pv_default_3-3b2ac0bcc0.png',
      '/assets/tms273/Map__Canvas_MapHelper.img_portal_game_pv_default_4-eca7cee401.png',
      '/assets/tms273/Map__Canvas_MapHelper.img_portal_game_pv_default_5-7599963d1c.png',
      '/assets/tms273/Map__Canvas_MapHelper.img_portal_game_pv_default_6-39b4e78d02.png',
      '/assets/tms273/Map__Canvas_MapHelper.img_portal_game_pv_default_7-5ac11ddd13.png',
    ];
    const loader = new T.TextureLoader();
    this.portalFrameTextures = frameUrls.map(url => {
      const texture = loader.load(resolveAssetUrl(url));
      texture.colorSpace = T.SRGBColorSpace; texture.magFilter = T.LinearFilter; texture.minFilter = T.LinearMipmapLinearFilter;
      this.portalTextures.push(texture); return texture;
    });
    const add = (portalName: string, parentName: string) => {
      const portal = this.model!.getObjectByName(portalName), parent = this.model!.getObjectByName(parentName);
      if (!portal || !parent) return;
      const point = parent.worldToLocal(portal.getWorldPosition(new T.Vector3()));
      const material = new T.MeshBasicMaterial({ map: this.portalFrameTextures[0], transparent: true, depthWrite: false, depthTest: true, side: T.DoubleSide, opacity: .94 });
      // The source frames are a vertical light column (roughly 99×138), with
      // the portal node marking the bottom edge. Keep the authored aspect and
      // billboard it toward the camera instead of flattening it into a floor
      // decal.
      const height = 2.8 / VOYAGE_SHIP_SCALE, width = 1.95 / VOYAGE_SHIP_SCALE;
      const mesh = new T.Mesh(new T.PlaneGeometry(width, height), material);
      mesh.name = `${portalName}_Original2D`; mesh.position.copy(point); mesh.position.y += height / 2 + .035; parent.add(mesh); this.portalMeshes.push(mesh);
    };
    add('SV3_CaptainPortal', 'SV3_Exterior');
    add('SV3_CabinDeckPortal', 'SV3_CabinInterior');
  }
  private updatePortalVisuals(delta: number) {
    if (!this.portalMeshes.length) return;
    if (this.portalFrameTextures.length >= 2) {
      this.portalFrameElapsed += delta * 1000;
      if (this.portalFrameElapsed >= 100) {
        this.portalFrameElapsed %= 100;
        this.portalFrameIndex = (this.portalFrameIndex + 1) % this.portalFrameTextures.length;
        const texture = this.portalFrameTextures[this.portalFrameIndex];
        this.portalMeshes.forEach(mesh => {
          const material = mesh.material as T.MeshBasicMaterial;
          material.map = texture; material.needsUpdate = true;
        });
      }
    }
    // PlaneGeometry faces local +Z. Use the parent-local camera target so the
    // bottom anchor stays on the authored floor while the column remains
    // readable from either side of the 2.5D cabin view.
    const cameraWorld = this.camera.getWorldPosition(new T.Vector3());
    this.portalMeshes.forEach(mesh => {
      const parent = mesh.parent;
      if (!parent) return;
      parent.updateWorldMatrix(true, false);
      const direction = parent.worldToLocal(cameraWorld.clone()).sub(mesh.position);
      mesh.rotation.set(0, Math.atan2(direction.x, direction.z), 0);
    });
  }
  private installFloorCountLabel() {
    if (!this.ship || !this.model) return;
    const cabin = this.model.getObjectByName('SV3_CabinInterior'); if (!cabin) return;
    const canvas = document.createElement('canvas'); canvas.width = 2400; canvas.height = 1100;
    const texture = new T.CanvasTexture(canvas); texture.colorSpace = T.SRGBColorSpace; texture.minFilter = T.LinearFilter;
    const material = new T.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: T.DoubleSide });
    const mesh = new T.Mesh(new T.PlaneGeometry(6.8, 3.12), material); mesh.name = 'SV3_CabinFloorCount'; mesh.position.set(-9.7, 1.8, 47.7); mesh.visible = false; cabin.add(mesh);
    this.floorCount = mesh; this.floorCountTexture = texture; this.updateFloorCountLabel();
  }
  private installPapers() {
    const cabin = this.model?.getObjectByName('SV3_CabinInterior'); if (!cabin) return;
    this.rolePaper = createVoyagePaper(cabin, 'SV3_RoleParchment', new T.Vector3(11.0, 3.0, 41.2), 2.8, 4.3);
    this.createPaper = createVoyagePaper(cabin, 'SV3_CreateParchment', new T.Vector3(0, 3.1, 38.9), 3.4, 5.0);
  }
  private updateFloorCountLabel() {
    if (!this.floorCountTexture) return;
    const canvas = this.floorCountTexture.image as HTMLCanvasElement, context = canvas.getContext('2d'); if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height); context.fillStyle = '#fff3c8'; context.strokeStyle = '#3e2817'; context.lineWidth = 26; context.textAlign = 'center'; context.textBaseline = 'middle'; context.font = 'bold 880px Georgia, serif';
    const value = `${this.ids.length}/${Math.max(this.slotLimit, this.ids.length)}`; context.strokeText(value, canvas.width / 2, canvas.height / 2); context.fillText(value, canvas.width / 2, canvas.height / 2); this.floorCountTexture.needsUpdate = true;
  }
  setPassengers(ids: string[], selected: string | undefined, page: number, slotLimit = this.slotLimit) {

    if (selected !== this.deckCharacter) { this.clearMovement(); if (this.stage === 'channel') this.deck?.reset(); }
    this.ids=ids; this.deckCharacter = selected;
    this.slotLimit = Math.max(ids.length, slotLimit || ids.length); this.updateFloorCountLabel();
    this.page = page; this.passengers.setSlots(ids, selected, this.stage, page);
  }
  openRoleDetails() {
    if (this.stage !== 'characters' || this.nearInteraction !== 'role-details' || !this.nearbyCharacterId) return;
    this.roleDetailOpen = true;
    if (!this.reduced.matches) this.beginTransition('characters', .65);
    if (this.rolePaper && this.cabinDeck) this.rolePaper.group.position.copy(this.cabinDeck.position).add(new T.Vector3(2.4, 3.0, -1.0));
    this.updateActivity();
  }
  closeRoleDetails() { this.roleDetailOpen = false; if (!this.reduced.matches) this.beginTransition('characters', .65); this.clearMovement(); this.updateActivity(); }
  passengerTime() { return this.animationTime; }
  passengerAction(id: string) { return this.passengers.action(id); }
  passengerSleeping(id: string) { return this.passengers.sleeping(id); }
  setPassengerFrame(id: string, parts: Part[], bounds?: import('./voyage-passengers').DollBounds) { void this.passengers.setFrame(id, parts, bounds); }
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
    const pose = poseFor(shot); this.camera.position.fromArray(pose.eye); this.camera.lookAt(new T.Vector3().fromArray(pose.aim));
    this.renderer.render(this.scene, this.camera);
  }
  private resize() {
    if (!this.alive) return;
    const width = Math.max(1, this.host.clientWidth), height = Math.max(1, this.host.clientHeight);
    this.camera.aspect = width / height;
    this.camera.clearViewOffset();
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
  private avoidCameraSurface(base:T.Vector3) {
    if (!this.ship) return;
    this.ship.updateWorldMatrix(true,true);
    const direction=this.camera.position.clone().sub(base), distance=direction.length();direction.normalize();
    // Probe inward from outside the eye. A solid surface near the eye pushes
    // the camera OUT of the hull; pulling toward the passenger put the old
    // parallel view inside the wall. Body reveal keeps its separate rule.
    const origin=this.camera.position.clone().addScaledVector(direction,3), inward=direction.clone().negate();
    this.cameraRay.set(origin,inward);this.cameraRay.far=5;
    let nearest=Infinity;const small:T.Mesh[]=[];
    for(const mesh of this.cameraObstacles) {
      let visible=true;for(let p:T.Object3D|null=mesh;p;p=p.parent)if(!p.visible){visible=false;break;}
      if(!visible)continue;
      // Static hull tiles already exist for body reveal; cloth stays on its
      // small current mesh so its animated buffers need no second tile cache.
      if(mesh.geometry.attributes.position.count>10000 && this.reveal) nearest=Math.min(nearest,this.reveal.surfaceDistance(mesh,origin,inward,5)??Infinity);
      else small.push(mesh);
    }
    nearest=Math.min(nearest,this.cameraRay.intersectObjects(small,false)[0]?.distance??Infinity);
    if(nearest<4.5)this.camera.position.copy(base).addScaledVector(direction,distance+3-nearest+1.5);
  }
  private closeInteractionChoices() {
    this.choosingInteraction = false;
    this.host.querySelector('.voyage-interaction-choices')?.remove();
    this.updateInteractionHint();
  }
  private renderInteractionChoices() {
    let menu = this.host.querySelector<HTMLElement>('.voyage-interaction-choices');
    if (!menu) { menu = document.createElement('div'); menu.className = 'voyage-interaction-choices'; menu.setAttribute('role', 'dialog'); menu.setAttribute('aria-label', '选择交互'); this.host.append(menu); }
    menu.replaceChildren();
    const title = document.createElement('p'); title.textContent = '选择交互 · 方向键选择，Space 确认'; menu.append(title);
    this.interactions.forEach((choice, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = choice.label;
      button.setAttribute('aria-pressed', String(index === this.interactionIndex));
      button.addEventListener('click', event => { event.stopPropagation(); this.performInteraction(choice); }); menu!.append(button);
    });
    this.updateInteractionHint();
  }
  private performInteraction(choice: CabinInteraction | undefined) {
    this.closeInteractionChoices(); this.keys.clear();
    if (!choice) return;
    this.nearInteraction = choice.kind; this.nearbyCharacterId = choice.id; this.nearbyEmptySlot = choice.slot;
    if (choice.kind === 'enter-cabin') this.onCabin?.();
    else if (choice.kind === 'return-deck') this.onDeck?.();
    else if (choice.kind === 'create-character' && choice.slot !== undefined) this.onCreate?.(choice.slot);
    else if (choice.kind === 'role-details' && choice.id) { this.roleDetailOpen = true; this.onCharacter?.(choice.id); }
  }
  private updateInteractionHint() {
    const hint = this.host.querySelector<HTMLElement>('.voyage-space-hint');
    if (!hint) return;
    const active = Boolean(this.nearInteraction) && !this.choosingInteraction;
    hint.hidden = !active;
    hint.dataset.kind = this.nearInteraction ?? '';
    const label = hint.querySelector<HTMLElement>('[data-role="space-label"]');
    if (label) label.textContent = this.interactions.length > 1 ? '选择交互' : this.nearInteraction === 'enter-cabin'
      ? '传送至选角舱'
      : this.nearInteraction === 'return-deck'
        ? '返回甲板'
        : this.nearInteraction === 'role-details'
          ? '查看角色'
          : '创建角色';
  }
  private draw = (now: number) => {
    if (!this.alive || this.host.hidden || document.hidden) return;
    // Movement retains a bounded simulation step; presentation follows wall time.
    const frameDelta = this.previous ? Math.max(0, (now - this.previous) / 1000) : 0;
    const delta = Math.min(frameDelta, .05);
    this.previous = now; this.animationTime += delta*1000;
    const walkingDeck=this.stage==='characters' ? this.cabinDeck : this.deck;
    if (walkingDeck && this.ship && ['channel','characters'].includes(this.stage)) {
      if (this.host.getAttribute('aria-busy') === 'true' && !this.host.classList.contains('voyage-loading')) this.clearMovement();
      const held = (...codes: string[]) => codes.some(code => this.keys.has(code)) ? 1 : 0;
      if (!this.roleDetailOpen && !this.choosingInteraction && (this.stage!=='characters' || !this.passengers.waking)) walkingDeck.update(delta, held('ArrowRight', 'KeyD') - held('ArrowLeft', 'KeyA'), held('ArrowDown', 'KeyS') - held('ArrowUp', 'KeyW'), this.camera, this.ship);
      this.passengers.deckPosition.copy(walkingDeck.position); this.passengers.deckMoving = walkingDeck.moving; this.passengers.deckJumping = walkingDeck.jumping; this.passengers.deckFacing = walkingDeck.facing;
    }
    this.flight?.update(this.reduced.matches ? 0 : delta, this.reduced.matches);
    this.city?.update(delta, this.reduced.matches,1,undefined,this.camera,this.host.clientHeight);
    this.clouds.update(delta, this.reduced.matches);
    if (!this.reduced.matches) {
      this.waterTime.value += delta;
      this.water?.update(delta);
      this.updateSails(delta, now / 1000);
    }
    // Billboarding also runs in reduced motion so the first source frame is
    // readable in a static screenshot; animation timing itself stays paused.

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
    const createPose = compactCreate
      ? this.host.clientWidth < 600 ? shipPose({ eye: [8, 10, 57], aim: [0, -6, 39] }) : shipPose({ eye: [13, 9, 55], aim: [5, 0, 39] })
      : shipPose(poses.cabin);
    const cabinPose = this.stage === 'characters'
      ? { eye: [poses.berths.eye[0] * VOYAGE_SHIP_SCALE + this.page * 8.1 * VOYAGE_SHIP_SCALE, 5.8 * VOYAGE_SHIP_SCALE, 48 * VOYAGE_SHIP_SCALE], aim: [poses.berths.aim[0] * VOYAGE_SHIP_SCALE + this.page * 8.1 * VOYAGE_SHIP_SCALE, .5 * VOYAGE_SHIP_SCALE, 43.7 * VOYAGE_SHIP_SCALE] }
      : createPose;
    const fixed = this.shot ? poseFor(this.shot) : cabin ? cabinPose : this.stage === 'channel' ? shipPose(poses.channel) : undefined;
    const opening = voyageOpeningPose(t);
    const arrival = 1 - smooth(Math.min(1, t / .78));
    const shipOffset = new T.Vector3(-150 * arrival, 0, 220 * arrival);
    this.camera.position.copy(fixed ? new T.Vector3().fromArray(fixed.eye) : opening.eye);
    const aim = fixed ? new T.Vector3().fromArray(fixed.aim) : opening.aim;
    let fieldOfView = this.stage === 'channel' && !this.shot ? 38 : this.stage === 'characters' ? Math.max(38, T.MathUtils.radToDeg(2 * Math.atan(3.9 / this.camera.aspect / this.camera.position.distanceTo(aim)))) : 46;
    if (!this.shot && this.stage === 'characters' && this.roleDetailOpen && this.rolePaper) {
      this.rolePaper.anchor.updateWorldMatrix(true, false);
      const paper = this.rolePaper.anchor.getWorldPosition(new T.Vector3());
      const normal = new T.Vector3(0, 0, 1).applyNormalMatrix(new T.Matrix3().getNormalMatrix(this.rolePaper.anchor.matrixWorld)).normalize();
      this.camera.position.copy(paper).addScaledVector(normal, Math.max(16, 6.8 / (2 * this.camera.aspect * Math.tan(T.MathUtils.degToRad(19)) * .82))).add(new T.Vector3(-2, 2.5, 0)); aim.copy(paper).add(new T.Vector3(-1, 1.0, 0)); fieldOfView = 38;
    }
    if (!this.shot && this.stage === 'create' && this.createPaper) {
      this.createPaper.anchor.updateWorldMatrix(true, false);
      const paper = this.createPaper.anchor.getWorldPosition(new T.Vector3());
      const distance = Math.max(18, 9 / this.camera.aspect / (2 * Math.tan(T.MathUtils.degToRad(19))));
      this.camera.position.copy(paper).add(new T.Vector3(-3, 3, distance)); aim.copy(paper).add(new T.Vector3(-2, 0, 0)); fieldOfView = 38;
    }
    if (!this.shot && this.stage === 'login' && this.loginSurface && t > .78 && this.ship) {
      // The arrival finishes outside the physical board. Blend to the board
      // pose over the last fifth of the take so the continuous shot never
      // jumps from the mast view to a separate login camera.
      this.ship.updateWorldMatrix(true, true); this.loginSurface.anchor.updateWorldMatrix(true, false);
      const board = this.loginSurface.anchor.getWorldPosition(new T.Vector3());
      const normal = new T.Vector3(0, 0, 1).applyNormalMatrix(new T.Matrix3().getNormalMatrix(this.loginSurface.anchor.matrixWorld)).normalize();
      const settle = smooth(Math.max(0, Math.min(1, (t - .78) / .22)));
      const tangent = new T.Vector3(1, 0, 0).transformDirection(this.loginSurface.anchor.matrixWorld);
      // Leave room for the deck and destination on the right of the timber
      // sign. Narrow screens keep the same physical surface centred/readable.
      const wide = this.camera.aspect > 1.2;
      const boardWidth = this.loginSurface.width * this.loginSurface.anchor.getWorldScale(new T.Vector3()).x;
      const distance = wide ? 32 : Math.max(26, boardWidth / (2 * Math.tan(T.MathUtils.degToRad(20)) * this.camera.aspect * .76));
      const boardEye = board.clone().addScaledVector(normal, distance).addScaledVector(tangent, wide ? -4 : 0).add(new T.Vector3(0, 3, 0));
      const boardAim = board.clone().addScaledVector(tangent, wide ? 7 : 0).add(new T.Vector3(0, .6, 0));
      this.camera.position.lerp(boardEye, settle); aim.lerp(boardAim, settle); fieldOfView = T.MathUtils.lerp(fieldOfView, 40, settle);
    }
    if (['channel','characters'].includes(this.stage) && !this.shot && walkingDeck && this.ship && !this.roleDetailOpen) {
      const base = this.ship.localToWorld(walkingDeck.position.clone());
      base.y += 1.65;
      const x = walkingDeck.position.x, z = walkingDeck.position.z;
      // Each straight side has a stable heading. At a corner the camera rises
      // while a short eased turn completes, rather than rotating along the aisle.
      const targetYaw = Math.abs(x) >= 6.3 ? (x > 0 ? Math.PI / 2 : -Math.PI / 2) : z < 0 ? Math.PI : 0;
      const turn = Math.atan2(Math.sin(targetYaw - this.followYaw), Math.cos(targetYaw - this.followYaw));
      this.followYaw += turn * (this.reduced.matches ? 1 : 1 - Math.exp(-frameDelta * 4));
      const corner = this.stage === 'channel' ? Math.max(0, 1 - Math.min(Math.abs(z + 8), Math.abs(z - 22)) / 3) : 0;
      let distance = (this.stage === 'characters' ? 42 : Math.min(this.host.clientHeight / 45 / (2 * Math.tan(T.MathUtils.degToRad(19))), 15)) * Math.min(this.zoom, 2.6);
      let yaw = this.yaw + (this.stage === 'channel' ? this.followYaw : 0);
      let pitch = this.stage === 'channel' ? Math.max(.56 + corner * .36, this.pitch + .22) : Math.max(.55, this.pitch + .25);
      if (this.stage === 'characters') { base.y += 1.4; distance *= 1.05; }
      if (this.stage === 'channel' && this.zoom > 2.2 && this.model) {
        if (!this.shipBounds) {
          const box = new T.Box3(), inverse = this.ship.matrixWorld.clone().invert();
          this.model.getObjectByName('SV3_Exterior')?.traverse(node => {
            if (!(node instanceof T.Mesh) || !node.visible) return;
            for (let parent: T.Object3D | null = node; parent && parent !== this.ship; parent = parent.parent) if (!parent.visible) return;
            node.geometry.computeBoundingBox();
            if (node.geometry.boundingBox) box.union(node.geometry.boundingBox.clone().applyMatrix4(inverse.clone().multiply(node.matrixWorld)));
          });
          if (!box.isEmpty()) this.shipBounds = box.getBoundingSphere(new T.Sphere());
        }
        if (this.shipBounds) {
          const amount = smooth(T.MathUtils.clamp((this.zoom - 2.2) / 4, 0, 1));
          const halfVertical = T.MathUtils.degToRad(19), halfHorizontal = Math.atan(Math.tan(halfVertical) * this.camera.aspect);
          const radius = this.shipBounds.radius * this.ship.getWorldScale(new T.Vector3()).x;
          const fit = radius / Math.sin(Math.min(halfVertical, halfHorizontal)) * 1.13;
          base.lerp(this.ship.localToWorld(this.shipBounds.center.clone()), amount);
          distance = T.MathUtils.lerp(distance, fit, amount);
          yaw = this.inspection ? this.inspectionYaw : yaw;
          pitch = T.MathUtils.lerp(pitch, this.inspectionPitch, amount);
        }
      }
      const offset = new T.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))
        .applyQuaternion(this.ship.getWorldQuaternion(new T.Quaternion())).multiplyScalar(distance);
      this.camera.position.copy(base).add(offset);
      if (this.stage === 'channel' && !this.inspection) this.avoidCameraSurface(base);
      aim.copy(base);
      if (this.stage === 'characters') aim.add(new T.Vector3(0, 3, -3).applyQuaternion(this.ship.getWorldQuaternion(new T.Quaternion())));
      fieldOfView = 38;
      const alpha = this.reduced.matches || !this.followEye ? 1 : 1 - Math.exp(-frameDelta * 6);
      this.followEye ??= this.camera.position.clone(); this.followAim ??= aim.clone();
      this.followEye.lerp(this.camera.position, alpha); this.followAim.lerp(aim, alpha);
      this.camera.position.copy(this.followEye); aim.copy(this.followAim);

    }
    let passage = 0;
    if (this.transition) {
      const tr = this.transition; tr.time = Math.min(tr.duration, tr.time + frameDelta);
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
    if (['channel','characters'].includes(this.stage) && !this.shot && walkingDeck && this.ship) {
      this.ship.updateWorldMatrix(true, true);
      this.camera.updateMatrixWorld(true);
      this.reveal?.update(this.ship.localToWorld(walkingDeck.position.clone()), this.camera, this.host.clientWidth, this.host.clientHeight, this.renderer.getPixelRatio(), delta * 1000, now);
      const button = this.host.querySelector<HTMLButtonElement>('.voyage-adventure');
      if (button) {
        const projection=this.adventureSurface && projectLoginSurface(this.adventureSurface,this.camera,{width:this.host.clientWidth,height:this.host.clientHeight},{width:button.offsetWidth || parseFloat(getComputedStyle(button).width),height:button.offsetHeight || parseFloat(getComputedStyle(button).height)});
        button.hidden=!projection;
        if(projection){button.style.left='0';button.style.top='0';button.style.transform=`matrix3d(${projection.matrix.elements.join(',')})`;}
        button.disabled = this.host.getAttribute('aria-busy') === 'true';
        const quick=this.host.querySelector<HTMLElement>('.voyage-adventure-shortcut');
        if(quick)quick.hidden=!!projection;
      }
      if (!this.choosingInteraction) {
        const previousNearbyCharacter = this.nearbyCharacterId;
        this.interactions = [];
        if (this.host.getAttribute('aria-busy') !== 'true') {
          if (this.stage === 'channel') {
            const portal = this.model?.getObjectByName('SV3_CaptainPortal');
            const point = portal && this.ship.worldToLocal(portal.getWorldPosition(new T.Vector3()));
            if (point && point.distanceTo(walkingDeck.position) < 1.15) this.interactions.push({ kind: 'enter-cabin', label: '传送至选角舱' });
          } else {
            const marker = this.model?.getObjectByName('SV3_CabinDeckPortal');
            const exit = marker && this.ship.worldToLocal(marker.getWorldPosition(new T.Vector3()));
            if (exit && exit.distanceTo(walkingDeck.position) < 1) this.interactions.push({ kind: 'return-deck', label: '返回甲板' });
            for (let index = 0; index < Math.min(12, this.slotLimit); index++) {
              const anchor = this.model?.getObjectByName(`SV2_Bed_${index}_FootAnchor`);
              if (!anchor) continue;
              const point = this.ship.worldToLocal(anchor.getWorldPosition(new T.Vector3())).add(new T.Vector3(0, 0, .6)); point.y = .025;
              if (point.distanceTo(walkingDeck.position) < .95) this.interactions.push(index < this.ids.length
                ? { kind: 'role-details', label: `查看第 ${index + 1} 床角色`, id: this.ids[index] }
                : { kind: 'create-character', label: `在第 ${index + 1} 床创建角色`, slot: index });
            }
          }
        }
        const activeRole = this.roleDetailOpen ? this.interactions.find(choice => choice.kind === 'role-details' && choice.id === previousNearbyCharacter) : undefined;
        const first = activeRole ?? this.interactions[0];
        this.nearInteraction = first?.kind; this.nearbyEmptySlot = first?.slot; this.nearbyCharacterId = first?.id;
        if (this.roleDetailOpen && !activeRole) this.roleDetailOpen = false;
      }
      this.updateInteractionHint();

    }
    if (this.floorCount) this.floorCount.visible = this.cabinShown && this.stage === 'characters' && !this.roleDetailOpen;
    this.camera.updateMatrixWorld(true);
    this.updatePortalVisuals(this.reduced.matches ? 0 : delta);
    const travelling = t < 1 && this.stage === 'login';
    this.host.classList.toggle('voyage-travelling', travelling);
    const avatar = this.host.querySelector<HTMLElement>('.voyage-deck-avatar');
    if (avatar && this.ship) {
      const point = this.ship.localToWorld(this.passengers.deckPosition.clone()).project(this.camera);
      avatar.style.left = `${(point.x + 1) * 50}%`; avatar.style.top = `${(1 - point.y) * 50}%`;
      avatar.hidden = travelling || this.stage==='create';
    }
    const spaceHint = this.host.querySelector<HTMLElement>('.voyage-space-hint');
    const junctionHint = this.host.querySelector<HTMLElement>('.voyage-junction-hint');
    if (junctionHint && this.ship && walkingDeck) {
      const directions = ['channel','characters'].includes(this.stage) && !this.roleDetailOpen && !walkingDeck.jumping
        ? walkingDeck.junctionDirections(this.camera, this.ship) : [];
      junctionHint.hidden = !directions.length;
      junctionHint.querySelectorAll<HTMLImageElement>('[data-direction]').forEach(image => { image.hidden = !directions.includes(image.dataset.direction as typeof directions[number]); });
      const point = this.ship.localToWorld(walkingDeck.position.clone().add(new T.Vector3(0, 2.7, 0))).project(this.camera);
      junctionHint.style.left = `${(point.x + 1) * 50}%`; junctionHint.style.top = `${(1 - point.y) * 50}%`;
    }
    if (spaceHint && this.ship && walkingDeck && this.nearInteraction) {
      const point = this.ship.localToWorld(walkingDeck.position.clone().add(new T.Vector3(0, 1.9, 0))).project(this.camera);
      spaceHint.style.left = `${(point.x + 1) * 50}%`;
      spaceHint.style.top = `${(1 - point.y) * 50}%`;
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
    this.host.classList.toggle('voyage-paper-open', this.roleDetailOpen || this.stage === 'create');
    if (projectedBunks && this.ship) this.host.querySelectorAll<HTMLElement>('[data-berth]').forEach(button => {
      const index = Number(button.dataset.berth), x = -10.8 + index * 1.8;
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
      button.style.visibility = this.roleDetailOpen || point.z < -1 || point.z > 1 || !this.cabinShown || passage > .2 ? 'hidden' : 'visible';
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
    const roleElement = this.host.querySelector<HTMLElement>('[data-role="role-details"]') ?? undefined;
    this.rolePaperProjector.set(roleElement, this.rolePaper, this.stage === 'characters' && this.roleDetailOpen && Boolean(this.deckCharacter));
    this.rolePaperProjector.update(this.camera, { width: this.host.clientWidth, height: this.host.clientHeight });
    const createElement = this.host.querySelector<HTMLElement>('#create-character') ?? undefined;
    this.createPaperProjector.set(createElement, this.createPaper, this.stage === 'create');
    this.createPaperProjector.update(this.camera, { width: this.host.clientWidth, height: this.host.clientHeight });
    const loginVisible = this.stage === 'login' && this.login.update(this.camera, this.loginSurface, exterior ? [exterior] : []);
    this.host.classList.toggle('voyage-login-visible', loginVisible);
    this.clouds.render(this.renderer, this.scene, this.camera, this.sun, this.cabinShown ? this.windowLight : undefined);
    if (!this.reduced.matches || this.keys.size > 0 || walkingDeck?.jumping || this.passengers.waking || this.passengers.hasReturning) this.frame = requestAnimationFrame(this.draw);
  };
  private bindSails(model: T.Group) {
    model.traverse(node => {
      if (node.userData.cloth_canvas_vertex_start !== 0) return;
      const columns = Number(node.userData.cloth_columns), rows = Number(node.userData.cloth_rows);
      if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 2 || rows < 2 || columns > 64 || rows > 64) return;
      const meshes: T.Mesh[] = [];
      node.traverse(child => {
        if (!(child instanceof T.Mesh)) return;
        const uv = child.geometry.getAttribute(child.userData.cloth_grid_uv ?? node.userData.cloth_grid_uv ?? 'uv');
        // Rigid timber ribs have their own fold rig, never cloth-grid UVs.
        if (uv && uv.count === (columns+1)*(rows+1)*(node.userData.cloth_two_sides?2:1)) meshes.push(child);
      });
      for(const side of node.userData.cloth_two_sides?[-1,1]:[0]) {
      const canvas = meshes.find(mesh => !(mesh.material as T.MeshStandardMaterial).map) ?? meshes[0];
      if (!canvas) return;
      const rest = new Float32Array((columns + 1) * (rows + 1) * 3), filled = new Set<number>();
      const gridIndex = (uv: T.BufferAttribute, i: number) => Math.round(uv.getY(i) * rows) * (columns + 1) + Math.round(uv.getX(i) * columns);
      const pos = canvas.geometry.getAttribute('position') as T.BufferAttribute, uv = canvas.geometry.getAttribute(node.userData.cloth_grid_uv??'uv') as T.BufferAttribute;
      for (let i = 0; i < pos.count; i++) { if(side&&Math.sign(pos.getX(i))!==side)continue; const grid = gridIndex(uv, i); if (grid < 0 || grid >= rest.length / 3) return; rest.set([pos.getX(i), pos.getY(i), pos.getZ(i)], grid * 3); filled.add(grid); }
      if (filled.size !== rest.length / 3) return;
      const pins = node.userData.cloth_pins;
      const attachments = typeof pins === 'string' ? JSON.parse(pins) : pins;
      const simulation = new ClothGrid(rest, columns, rows, Array.isArray(attachments) ? attachments : Number(node.userData.pin_v) === 1);
      this.sails.push({ simulation, target: rest.slice(), morph: new Float32Array(pos.count * 3), meshes: meshes.map(mesh => {
        if(side!==1)mesh.geometry = mesh.geometry.clone();
        const p = mesh.geometry.getAttribute('position') as T.BufferAttribute, u = mesh.geometry.getAttribute(mesh.userData.cloth_grid_uv??node.userData.cloth_grid_uv??'uv') as T.BufferAttribute;
        p.setUsage(T.DynamicDrawUsage);
        const map: number[] = [], offsets = new Float32Array(p.count * 3);
        for (let i = 0; i < p.count; i++) {
          const grid = gridIndex(u, i); map.push(side&&Math.sign(p.getX(i))!==side?-1:grid);
          offsets.set([p.getX(i) - rest[grid * 3], p.getY(i) - rest[grid * 3 + 1], p.getZ(i) - rest[grid * 3 + 2]], i * 3);
        }
        return { mesh, map, offsets, basis:new Float32Array(p.array) };
      }) });
      }
    });
  }
  private updateSails(delta: number, time: number) {
    for (const sail of this.sails) {
      const inverse = sail.meshes[0].mesh.matrixWorld.clone().invert();
      const gravity = new T.Vector3(0, -1, 0).transformDirection(inverse).multiplyScalar(9.81);
      const wind = new T.Vector3(6 + Math.sin(time * .8) * 2, .4, Math.sin(time * .45) * 2);
      const force = wind.length(); wind.transformDirection(inverse).multiplyScalar(force);
      const {mesh:source,map:indices,basis}=sail.meshes[0], rest=sail.target, morph=sail.morph;
      const targets=source.geometry.morphAttributes.position??[],weights=source.morphTargetInfluences??[];
      morph.fill(0);
      for(let j=0;j<targets.length;j++) {
        const weight=weights[j]??0; if(!weight)continue;
        const target=targets[j];
        for(let i=0;i<indices.length;i++){if(indices[i]<0)continue;const k=i*3;morph[k]+=weight*target.getX(i);morph[k+1]+=weight*target.getY(i);morph[k+2]+=weight*target.getZ(i);}
      }
      for(let i=0;i<indices.length;i++){const grid=indices[i];if(grid<0)continue;for(let axis=0;axis<3;axis++)rest[grid*3+axis]=basis[i*3+axis]+morph[i*3+axis];}
      sail.simulation.retarget(rest);
      sail.simulation.advance(delta, wind.toArray(), gravity.toArray());
      for (const { mesh, map, offsets } of sail.meshes) {
        const position = mesh.geometry.getAttribute('position') as T.BufferAttribute;
        for (let i = 0; i < position.count; i++) { const grid = map[i] * 3; if(grid<0)continue;position.setXYZ(i, sail.simulation.positions[grid] + offsets[i * 3] - morph[i*3], sail.simulation.positions[grid + 1] + offsets[i * 3 + 1] - morph[i*3+1], sail.simulation.positions[grid + 2] + offsets[i * 3 + 2] - morph[i*3+2]); }
      }
    }
    // Both cloth faces write the same geometry: upload and rebuild normals only once.
    const geometries=new Set(this.sails.flatMap(s=>s.meshes.map(m=>m.mesh.geometry)));
    for(const geometry of geometries){geometry.getAttribute('position').needsUpdate=true;geometry.computeVertexNormals();geometry.computeBoundingSphere();}
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
    this.host.removeEventListener('pointerdown', this.cameraDown); this.host.removeEventListener('pointermove', this.cameraMove);
    this.host.removeEventListener('pointerup', this.cameraUp); this.host.removeEventListener('pointercancel', this.cameraUp);
    this.host.removeEventListener('wheel', this.cameraWheel); this.host.removeEventListener('contextmenu', this.contextMenu);
    this.cameraObstacles.length=0; this.clearMovement(); this.deck?.destroy(); this.cabinDeck?.destroy(); this.reveal?.destroy();
    this.portalMeshes.forEach(mesh => { mesh.geometry.dispose(); (mesh.material as T.Material).dispose(); mesh.removeFromParent(); });
    this.portalTextures.forEach(texture => texture.dispose()); this.portalMeshes = []; this.portalTextures = [];
    this.floorCount?.geometry.dispose(); (this.floorCount?.material as T.Material | undefined)?.dispose(); this.floorCountTexture?.dispose(); this.floorCount = undefined; this.floorCountTexture = undefined;
    for (const paper of [this.rolePaper, this.createPaper]) { if (!paper) continue; dispose(paper.group); paper.group.removeFromParent(); }
    this.rolePaperProjector.destroy(); this.createPaperProjector.destroy(); this.rolePaper = undefined; this.createPaper = undefined;
    this.reduced.removeEventListener('change', this.onMotion);
    this.passengers.destroy(); this.login.destroy(); this.clouds.destroy(); this.windowLight?.destroy(); this.water?.dispose(); dispose(this.scene); this.reflection.dispose(); this.renderer.dispose(); this.renderer.forceContextLoss(); this.canvas.remove();
    this.host.classList.remove('entry-voyage-ready', 'voyage-travelling', 'voyage-login-visible');
  }
}
