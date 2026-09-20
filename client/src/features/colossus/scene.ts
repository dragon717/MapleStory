import * as T from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import config from '../../../../shared/colossus.json';
import rigData from '../../../../shared/colossus-rig.json';
import type { ColossusState, ColossusBody, Vec3, PlayerState, ServerMessage } from '../../../../shared/protocol';
import type { Manifest, AvatarActionSet, Frame, AssetFrame } from '../../assets/manifest';
import { composeAppearance, loadAppearanceLayers, appearanceWeaponType } from '../entry/appearance';
import { frameAt } from '../player/animation';
import { resolveAssetUrl } from '../../assets/resource-url';
import { HarborSound } from './sound';
import { trackPoint, worldPoint, worldTangent, angleDelta, screenDirection } from './spatial';
import { PaperActor, paperFrame, disposePaper, type PaperFrame } from './paper';
type OriginalAssets = {monsters:Record<string,{actions:Record<string,{frames:AssetFrame[];zigzag?:number}>}>;sceneAssets:Record<string,(AssetFrame&{source:string})[]>};
type ModelName = keyof typeof config.models;
type TrackName = keyof typeof config.tracks;
type RegionName = keyof typeof config.regions;
const C = { ink: 0x334b51, stone: 0x718c83, pale: 0xc0c9a2, sand: 0xe9c58d, roof: 0xd27b5b, wall: 0xf5ddb0, blue: 0x407da8, moss: 0x7eaa85, wood: 0x98674b };
const v = (p: readonly number[]) => new T.Vector3(p[0], p[1], p[2]);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (x: number) => { x = T.MathUtils.clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const textureLoader = new T.TextureLoader();
const images = new Map<string, Promise<HTMLImageElement>>();
function loadImage(url: string) { let p = images.get(url); if (!p) {
    p = new Promise<HTMLImageElement>((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error(`角色素材未加载：${url}`)); i.src = resolveAssetUrl(url); });
    images.set(url, p);
} return p; }
/** Third activity only. No prediction, collision, event advancement or client coordinates. */
export class ColossusScene {
    readonly renderer: T.WebGLRenderer;
    readonly scene = new T.Scene();
    readonly camera = new T.PerspectiveCamera(38, 1, .1, 2000000);
    readonly giant = new T.Group();
    private sound = new HarborSound();
    private climbPath = new T.Group();
    private bodyModel = new T.Group();
    private sun = new T.DirectionalLight(0xffefd5, 1.8);
    private harborProps = new T.Group();
    private witnessedCut = 0;
    private districts = new Map<string, T.Group>();
    private roads = new Map<string, T.Group>();
    private occluders = new Set<T.Group>();
    private occlusionAt = 0;
    private sight = new T.Raycaster();
    private activeRegion = 'harbor';
    private paint = new Map<string, T.Texture>();
    private winch = new T.Group();
    private bridgeRope?: T.Mesh;
    private workerFrames: T.Texture[] = [];
    private winchFrame?: T.Texture;
    private netFrames: T.Texture[] = [];
    private shuttle?: T.Mesh;
    private bones = new Map<string, T.Object3D>();
    private bridge = new T.Group();
    private vine = new T.Group();
    private water: T.Mesh<T.PlaneGeometry, T.ShaderMaterial>;
    private falls:{bone?:string;point?:T.Vector3;width:number;sheet:T.Mesh<T.PlaneGeometry,T.ShaderMaterial>;spray:T.Mesh<T.PlaneGeometry,T.ShaderMaterial>}[]=[];
    private flags: T.Mesh[] = [];
    private stones: PaperActor[] = [];
    private stoneFrames = new Map<string,PaperFrame>();
    private boat = new T.Group();
    private originalSprites:T.Sprite[]=[];
    private buckets: T.Mesh[] = [];
    private actorSprites = new Map<string, {
        sprite: PaperActor;
        actions: AvatarActionSet;
        textures: Map<Frame, PaperFrame>;
        key: string;
    }>();
    private people: T.Sprite[] = [];
    private spellEvents = new Set<string>();
    private spells: {actor:string;frames:AssetFrame[];start:number;mesh:T.Mesh<T.PlaneGeometry,T.MeshBasicMaterial>;at?:T.Vector3}[] = [];
    private spellTextures = new Map<string,T.Texture>();
    private casting = new Map<string,{action:string;start:number;until:number}>();
    skill(event: Extract<ServerMessage,{type:'skillCast'}>) {
        if(this.spellEvents.has(event.eventId))return;
        this.spellEvents.add(event.eventId);
        if(this.spellEvents.size>256)this.spellEvents.delete(this.spellEvents.values().next().value!);
        const now=performance.now();
        this.casting.set(event.playerId,{action:`skill${event.skillId}`,start:now,until:now+event.durationMs});
        const frames=this.manifest.skillEffects?.[String(event.skillId)]?.effect;
        if(!frames?.length)return;
        const mesh=new T.Mesh(new T.PlaneGeometry(1,1),new T.MeshBasicMaterial({transparent:true,depthWrite:false,side:T.DoubleSide}));
        const actor=this.latest?.actors.find(a=>a.id===event.playerId);
        const at=event.skillId===2001009 && actor && this.latest ? worldPoint(actor.body,this.latest.frame) : undefined;
        this.spells.push({actor:event.playerId,frames,start:now,mesh,at});this.scene.add(mesh);
        for(const f of frames)if(!this.spellTextures.has(f.url)) {
            const texture=textureLoader.load(resolveAssetUrl(f.url));texture.colorSpace=T.SRGBColorSpace;this.spellTextures.set(f.url,texture);
        }
    }
    private previous?: ColossusState;
    private latest?: ColossusState;
    private players: PlayerState[] = [];
    private selfId = '';
    private received = 0;
    private latestTick = -1;
    private revealAt = 0;
    private revealLength = 17;
    private revealDone = false;
    private disposed = false;
    private low = false;
    private chosenYaw = 0;
    private cameraYaw = 0;
    private pitch = .30;
    private cameraDistance = 55;
    private manualUntil = 0;
    private dragging?: { id: number; x: number; y: number };
    private screenSign: -1 | 1 = 1;
    private heldDirection = 0;
    private heldSign: -1 | 1 = 1;
    private onContext = (event: Event) => event.preventDefault();
    private onOrbitDown = (event: PointerEvent) => {
        if(event.button !== 2)return;
        this.dragging={id:event.pointerId,x:event.clientX,y:event.clientY};this.manualUntil=performance.now()+1200;
        this.renderer.domElement.setPointerCapture(event.pointerId);this.skip();event.preventDefault();
    };
    private onOrbitMove = (event: PointerEvent) => {
        const drag=this.dragging;if(!drag || drag.id!==event.pointerId)return;
        this.chosenYaw -= (event.clientX-drag.x)*.006;
        this.pitch=T.MathUtils.clamp(this.pitch+(event.clientY-drag.y)*.004,-.1,.65);
        drag.x=event.clientX;drag.y=event.clientY;this.manualUntil=performance.now()+1200;
    };
    private onOrbitWheel = (event: WheelEvent) => {
        event.preventDefault();this.skip();this.manualUntil=performance.now()+1200;
        const unit=event.deltaMode===1?16:event.deltaMode===2?this.host.clientHeight:1;
        const dx=T.MathUtils.clamp(event.deltaX*unit,-120,120),dy=T.MathUtils.clamp(event.deltaY*unit,-120,120);
        if(event.ctrlKey)this.cameraDistance=T.MathUtils.clamp(this.cameraDistance*Math.exp(dy*.008),18,65);
        else {this.chosenYaw-=dx*.004;this.pitch=T.MathUtils.clamp(this.pitch+dy*.003,-.1,.65);}
    };
    private onOrbitUp = (event: PointerEvent) => {if(this.dragging?.id===event.pointerId)this.dragging=undefined;};
    direction(raw: -1|0|1): -1|0|1 {
        if(raw!==this.heldDirection){this.heldDirection=raw;this.heldSign=this.screenSign;}
        return raw*this.heldSign as -1|0|1;
    }
    private frames: number[] = [];
    private renders: number[] = [];
    private lastAt = 0;
    private request = 0;
    private cameraReady = false;
    private resize: ResizeObserver;
    private assets: T.Texture[] = [];
    private status: (text: string) => void;
    private onPointer = (event: PointerEvent) => {
        if (event.button !== 0 || this.latest?.region !== 'harbor') return;
        const bounds=this.renderer.domElement.getBoundingClientRect(), ray=new T.Raycaster();
        ray.setFromCamera(new T.Vector2((event.clientX-bounds.left)/bounds.width*2-1,1-(event.clientY-bounds.top)/bounds.height*2),this.camera);
        const hit=ray.intersectObjects(this.people.filter(p=>p.visible))[0];
        if (hit) this.talk?.(this.people.indexOf(hit.object as T.Sprite));
    };
    static async create(host: HTMLElement, manifest: Manifest, status: (text: string) => void, talk?: (index: number) => void) {
        const loader = new GLTFLoader();
        const entries = await Promise.all(Object.entries(config.models).map(async ([name, url]) => [name, (await loader.loadAsync(resolveAssetUrl(url))).scene] as const));
        const response=await fetch(resolveAssetUrl('/assets/colossus/originals/manifest.json'));
        if(!response.ok)throw new Error('原版港口素材清单未加载');
        const links=await fetch(resolveAssetUrl('/assets/colossus/connections/manifest.json'));
        if(!links.ok)throw new Error('原版桥梯素材清单未加载');
        return new ColossusScene(host, manifest, status, talk, new Map(entries),await response.json(),await links.json());
    }
    constructor(private host: HTMLElement, private manifest: Manifest, status: (text: string) => void, private talk: ((index: number) => void) | undefined, private models: Map<string, T.Group>,private originals:OriginalAssets,private connections:{props:Record<string,AssetFrame[]>}) {
        this.status = status;
        this.renderer = new T.WebGLRenderer({ antialias: true, alpha: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
        this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
        this.renderer.outputColorSpace = T.SRGBColorSpace;
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = T.PCFSoftShadowMap;
        this.renderer.domElement.setAttribute('aria-label', '巨石之约：港口与移动巨像');
        this.host.append(this.renderer.domElement);
        this.renderer.domElement.addEventListener('pointerup',this.onPointer);
        this.renderer.domElement.addEventListener('contextmenu',this.onContext);
        this.renderer.domElement.addEventListener('wheel',this.onOrbitWheel,{passive:false});
        this.renderer.domElement.addEventListener('pointerdown',this.onOrbitDown);
        this.renderer.domElement.addEventListener('pointermove',this.onOrbitMove);
        this.renderer.domElement.addEventListener('pointerup',this.onOrbitUp);
        this.renderer.domElement.addEventListener('pointercancel',this.onOrbitUp);
        this.renderer.domElement.addEventListener('lostpointercapture',this.onOrbitUp);
        this.scene.background = new T.Color(0xb4dadd);
        this.scene.fog = new T.Fog(0xc3dfdf, 200, 1050);
        this.scene.add(new T.HemisphereLight(0xfff4dc, 0x738e99, 1.1));
        const sun = this.sun;
        sun.castShadow = true; sun.shadow.mapSize.set(2048,2048);
        Object.assign(sun.shadow.camera,{left:-65,right:65,top:65,bottom:-65,near:1,far:280});
        sun.shadow.bias=-.00015; sun.shadow.normalBias=.07;
        sun.position.set(-70, 140, 90);
        this.scene.add(sun,sun.target);
        this.scene.add(this.giant);
        const textures = new Set<T.Texture>();
        for (const [name, model] of this.models) {
            model.traverse(o => { if (o instanceof T.Mesh) {
                const source = o.material as T.MeshStandardMaterial;
                if (source.map) {
                    textures.add(source.map); source.map.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
                    // Preserve the painted macro shapes at reveal distance. 256 repeats averaged them to flat green.
                    if (name === 'colossus-rigged') { source.map.wrapS=source.map.wrapT=T.RepeatWrapping;source.map.repeat.set(2,2); }
                }
                o.material = new T.MeshToonMaterial({ color: source.color, map: source.map, emissive: source.emissive, emissiveMap: source.emissiveMap, side: source.side, alphaTest: source.alphaTest, vertexColors: source.vertexColors });
                if (source.name === 'CR_shade') o.material.color.setHex(0x718378);
                if (source.name === 'CR_stone') o.material.color.setHex(0xd6cbae);
                if(source.name.startsWith('CH_stone'))o.material.color.setHex(0xc9bc9f);
                if(source.name.startsWith('CH_plaster'))o.material.color.setHex(0xffe1ad);
                if(source.name.startsWith('CH_roof'))o.material.color.setHex(0xd8ac8a);
                if(source.name.startsWith('CH_wood'))o.material.color.setHex(0xbe9d76);
                o.castShadow=name!=='colossus-rigged';o.receiveShadow=name!=='colossus-rigged';
                source.dispose();
            } });
            if (name === 'colossus-rigged') {
                for (const bone of rigData.bones) {
                    const node = model.getObjectByName(T.PropertyBinding.sanitizeNodeName(bone.name));
                    if (!node) throw new Error(`巨像缺少骨骼：${bone.name}`);
                    this.bones.set(bone.name,node);
                }
                model.traverse(o => { if (o instanceof T.SkinnedMesh) o.frustumCulled = false; });
            } else this.bake(model, new Set());
        }
        this.assets.push(...textures);
        this.makeColossus();
        const old = new Set(this.scene.children);
        this.makeHarbor();
        for (const child of [...this.scene.children])
            if (!old.has(child))
                this.harborProps.add(child);
        this.giant.add(this.harborProps);
        this.scene.add(...this.people,...this.stones,this.boat);
        this.loadDistrict('harbor');
        this.water = this.makeWater();
        this.makeClouds();
        this.makeFalls();
        this.resize = new ResizeObserver(() => this.fit());
        this.resize.observe(host);
        this.fit();
        this.request = requestAnimationFrame(this.draw);
    }
    private texture(name: string) {
        let texture = this.paint.get(name);
        if (!texture) {
            texture = textureLoader.load(resolveAssetUrl(`/assets/colossus/${name}.png`));
            texture.colorSpace = T.SRGBColorSpace;
            texture.wrapS = texture.wrapT = T.RepeatWrapping;
            texture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
            this.paint.set(name, texture);
            this.assets.push(texture);
        }
        return texture;
    }
    private toon(color: number) {
        const roof = color === C.roof, wood = color === C.wood || color === C.sand;
        const painted = roof || wood || [C.stone, C.pale, C.moss, C.wall].includes(color);
        return new T.MeshToonMaterial({ color: painted ? (color === C.pale ? 0xd8ceb4 : 0xffffff) : color, map: painted ? this.texture(roof ? 'handpainted-roof' : wood ? 'handpainted-timber' : color === C.wall ? 'handpainted-plaster' : color === C.moss ? 'redesign/grass-painted' : 'redesign/limestone-painted') : null });
    }
    private mesh(geometry: T.BufferGeometry, color: number, parent: T.Object3D = this.scene, outline = true) {
        const m = new T.Mesh(geometry, this.toon(color));
        parent.add(m);
        if (outline) {
            const edge = new T.LineSegments(new T.EdgesGeometry(geometry, 30), new T.LineBasicMaterial({ color: C.ink, transparent: true, opacity: .5 }));
            m.add(edge);
        }
        return m;
    }
    private bake(parent: T.Object3D, excluded: Set<T.Object3D>) {
        // Measured software-GPU cost was draw calls, so combine static pieces by material.
        parent.updateWorldMatrix(true, true);
        const inverse = parent.matrixWorld.clone().invert();
        const batches = new Map<string, {
            parts: T.BufferGeometry[];
            material: T.Material;
            line: boolean;
        }>();
        const sources: (T.Mesh | T.LineSegments)[] = [];
        parent.traverse(o => {
            if (!(o instanceof T.Mesh || o instanceof T.LineSegments) || o instanceof T.InstancedMesh || o instanceof T.SkinnedMesh)
                return;
            for (let p: T.Object3D | null = o; p; p = p.parent)
                if (excluded.has(p))
                    return;
            const mat = o.material;
            if (Array.isArray(mat) || !(mat instanceof T.MeshToonMaterial || mat instanceof T.LineBasicMaterial))
                return;
            const line = o instanceof T.LineSegments, key = [line, mat.color.getHex(), mat.side, mat.opacity, 'map' in mat ? mat.map?.uuid : '', 'fog' in mat ? mat.fog : '', 'emissive' in mat ? (mat as T.MeshToonMaterial).emissive.getHex() : '', mat.vertexColors, mat.alphaTest].join(':');
            let batch = batches.get(key);
            if (!batch) {
                batch = { parts: [], material: mat.clone(), line };
                batches.set(key, batch);
            }
            let geometry = o.geometry.clone().applyMatrix4(new T.Matrix4().multiplyMatrices(inverse, o.matrixWorld));
            if (geometry.index) {
                const plain = geometry.toNonIndexed();
                geometry.dispose();
                geometry = plain;
            }
            for (const key of Object.keys(geometry.attributes))
                if (!['position','normal','uv'].includes(key)) geometry.deleteAttribute(key);
            batch.parts.push(geometry);
            sources.push(o);
        });
        for (const batch of batches.values()) {
            const geometry = mergeGeometries(batch.parts);
            if (!geometry)
                throw new Error('港口静态几何格式不一致');
            const merged=batch.line ? new T.LineSegments(geometry, batch.material) : new T.Mesh(geometry, batch.material);
            if(merged instanceof T.Mesh)merged.castShadow=merged.receiveShadow=true;
            parent.add(merged);
            batch.parts.forEach(g => g.dispose());
        }
        for (const o of sources) {
            o.removeFromParent();
            o.geometry.dispose();
            for (const m of Array.isArray(o.material) ? o.material : [o.material])
                m.dispose();
        }
    }
    private box(p: number[], size: number[], color: number, parent: T.Object3D = this.scene, outline = true) {
        const geometry = new T.BoxGeometry(...size as [
            number,
            number,
            number
        ]), uv = geometry.attributes.uv, pos = geometry.attributes.position, norm = geometry.attributes.normal;
        for (let i = 0; i < uv.count; i++) {
            const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
            uv.setXY(i, (Math.abs(norm.getX(i)) > .5 ? z : x) / 8, (Math.abs(norm.getY(i)) > .5 ? z : y) / 8);
        }
        const m = this.mesh(geometry, color, parent, outline);
        m.position.copy(v(p));
        return m;
    }
    private beam(a: T.Vector3, b: T.Vector3, width: number, color: number, parent: T.Object3D = this.scene) { const m = this.mesh(new T.CylinderGeometry(width, width, a.distanceTo(b), 5), color, parent, false); m.position.copy(a).add(b).multiplyScalar(.5); m.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), b.clone().sub(a).normalize()); return m; }
    private model(name: ModelName, parent: T.Object3D, position = new T.Vector3(), scale = 1) {
        const group = this.models.get(name)!.clone(true);
        // Each district owns its merged geometry/materials; templates/textures live until scene exit.
        group.traverse(o => { if (o instanceof T.Mesh) { o.geometry = o.geometry.clone(); o.material = (o.material as T.Material).clone(); } });
        group.position.copy(position); group.scale.setScalar(scale); parent.add(group);
        return group;
    }
    private makeTrack(name: string, parent: T.Object3D, color: number, depth = .44, extra = 0) {
        const t = config.tracks[name as keyof typeof config.tracks];
        let s = 0;
        const parts: T.BufferGeometry[] = [];
        for (let i = 1; i < t.points.length; i++) {
            const a = v(t.points[i - 1]), b = v(t.points[i]), d = b.clone().sub(a), len = d.length(), tangent = d.clone().normalize(), side = new T.Vector3(-tangent.z, 0, tangent.x).normalize(), normal = side.clone().cross(tangent).normalize();
            const rotation = new T.Quaternion().setFromRotationMatrix(new T.Matrix4().makeBasis(tangent, normal, side));
            const cuts = [s, s + len, ...name === 'harbor' ? config.gaps.flat().filter(x => x > s && x < s + len) : []].sort((x, y) => x - y);
            for (let j = 1; j < cuts.length; j++) {
                const at = (cuts[j - 1] + cuts[j]) / 2;
                if (name === 'harbor' && (at < 15 || config.gaps.some(g => at > g[0] && at < g[1])))
                    continue;
                const p = a.clone().lerp(b, (at - s) / len).addScaledVector(normal, -depth / 2 - (extra ? .5 : .015));
                const geometry = new T.BoxGeometry(cuts[j] - cuts[j - 1], depth, t.width + extra), uv = geometry.attributes.uv, pos = geometry.attributes.position, norm = geometry.attributes.normal;
                for (let k = 0; k < uv.count; k++)
                    uv.setXY(k, (pos.getX(k) + at) / 8, (Math.abs(norm.getY(k)) > .5 ? pos.getZ(k) : pos.getY(k)) / 8);
                geometry.applyMatrix4(new T.Matrix4().compose(p, rotation, new T.Vector3(1, 1, 1)));
                parts.push(geometry);
            }
            s += len;
        }
        const geometry = mergeGeometries(parts)!;
        parts.forEach(g => g.dispose());
        parent.add(new T.Mesh(geometry, this.toon(color)));
    }
    private sourceTexture(frame:AssetFrame) {
        let map=this.paint.get(frame.url);
        if(!map){map=textureLoader.load(resolveAssetUrl(frame.url));map.colorSpace=T.SRGBColorSpace;this.paint.set(frame.url,map);this.assets.push(map);}
        return map;
    }
    private sourcePlane(frame:AssetFrame,width:number,parent:T.Object3D,at:T.Vector3) {
        const mesh=new T.Mesh(new T.PlaneGeometry(width,width*frame.height/frame.width),new T.MeshLambertMaterial({map:this.sourceTexture(frame),alphaTest:.12,side:T.DoubleSide}));
        mesh.position.copy(at);parent.add(mesh);return mesh;
    }
    private flag(x:number,y:number,z:number,parent:T.Object3D=this.scene) {
        this.beam(v([x,y,z]),v([x,y+6,z]),.08,C.wood,parent);
        const cloth=new T.Mesh(new T.PlaneGeometry(2.2,1.15,8,3),new T.MeshToonMaterial({color:0x37799c,side:T.DoubleSide}));
        cloth.position.set(x+1.1,y+4.8,z);parent.add(cloth);this.flags.push(cloth);
    }
    private makeHarbor() {
        for (const s of [15, 42, 88, 111]) {
            const p = trackPoint('harbor', s);
            this.flag(p.x, p.y, p.z - 1.4);
        }
        for (const x of [4, 10, 14]) {
            const bucket = this.mesh(new T.CylinderGeometry(.35, .3, .7, 12), C.blue);
            bucket.position.set(x, .4, -1);
            this.buckets.push(bucket);
        }
        this.scene.add(this.boat);
        const hull=this.originals.sceneAssets.ships.find(f=>f.source==='Map/Obj/vehicle.img/ship/mapleIsland/1')!;
        const sails=this.originals.sceneAssets.ships.find(f=>f.source==='Map/Obj/vehicle.img/ship/mapleIsland/0')!;
        // Source 104000000 gives the sails' top-left offset (-111,-607) from the hull.
        this.sourcePlane(hull,hull.width/60,this.boat,v([0,(210-hull.height/2)/60,.1]));
        this.sourcePlane(sails,sails.width/60,this.boat,v([(-111+sails.width/2-hull.width/2)/60,(210+607-sails.height/2)/60,-.1]));
        const start = trackPoint('harbor', 48.7), end = trackPoint('harbor', 57.7);
        this.bridge.position.copy(start);
        this.scene.add(this.bridge);
        for (let i = 0; i < 12; i++)
            this.box([(i + .5) * (end.x - start.x) / 12, 0, 0], [(end.x - start.x) / 12 - .035, .4, 3.5], C.wood, this.bridge);
        for(let i=0;i<4;i++)this.sourcePlane(this.connections.props.bridge[i%3],(end.x-start.x)/4,this.bridge,v([(i+.5)*(end.x-start.x)/4,-.3,1.76]));
        this.bridge.rotation.z = Math.PI * .46;
        this.scene.add(this.vine);
        for (let i = 0; i < 3; i++)
            this.beam(v([44.2 + i * .3, 7.8, -1]), v([49.5, 13 + i * .3, -1]), .12, 0x537251, this.vine);
        this.sourcePlane(this.connections.props.vine[0],2.8,this.vine,v([46,10.7,-.85]));
        this.winch.position.set(44, 8.6, .3);
        this.scene.add(this.winch);
        this.mesh(new T.TorusGeometry(.55, .09, 8, 24), C.wood, this.winch, false);
        this.beam(v([-.5, 0, 0]), v([.5, 0, 0]), .07, C.wood, this.winch);
        this.beam(v([0, -.55, 0]), v([0, .55, 0]), .07, C.wood, this.winch);
        this.bridgeRope = this.beam(v([44, 8.6, .3]), v([49.5, 13, -1]), .035, C.wood);
        for(const scale of [.5,2]) {const actor=new PaperActor();actor.scale.setScalar(scale);this.stones.push(actor);this.scene.add(actor);}
        void this.loadOriginalArt();
        for (let i = 0; i < 7; i++) {
            const sprite = new T.Sprite(new T.SpriteMaterial({ transparent: true, alphaTest: .65, depthWrite: true }));
            sprite.visible = false;
            sprite.center.set(.5, 48 / 1536);
            sprite.scale.set(1.55, 2.325, 1);
            this.people.push(sprite);
            this.scene.add(sprite);
        }
        this.loadNpc('harbor-worker', this.people.slice(0, 5));
        this.loadNpc('harbor-child', [this.people[5]]);
        this.people[5].scale.set(1.12, 1.68, 1);
        this.loadNpc('netmender', [this.people[6]]);
        this.people[6].center.set(563 / 1024, 51 / 1536);
        const pose = (name: string, ready: (texture: T.Texture) => void) => { const url = (config.art as Record<string, string>)[name]; if (!url)
            return; textureLoader.load(resolveAssetUrl(url), texture => { if (this.disposed) {
            texture.dispose();
            return;
        } texture.colorSpace = T.SRGBColorSpace; this.assets.push(texture); ready(texture); }); };
        pose('harbor-worker-walk-a', t => this.workerFrames[1] = t);
        pose('harbor-worker-walk-b', t => this.workerFrames[2] = t);
        pose('harbor-worker-winch', t => this.winchFrame = t);
        pose('netmender-pickup', t => this.netFrames[1] = t);
        this.shuttle = this.box([0, 0, 0], [.35, .07, .11], C.wood, this.scene, false);
    }
    private loadNpc(name: 'netmender' | 'harbor-worker' | 'harbor-child', sprites: T.Sprite[]) { textureLoader.load(resolveAssetUrl(config.art[name]), texture => { if (this.disposed) {
        texture.dispose();
        return;
    } texture.colorSpace = T.SRGBColorSpace; this.assets.push(texture); if (name === 'harbor-worker')
        this.workerFrames[0] = texture; if (name === 'netmender')
        this.netFrames[0] = texture; for (const s of sprites) {
        s.material.map = texture;
        s.material.needsUpdate = true;
        s.visible = true;
    } }, undefined, () => this.status('港口人物素材未加载，请检查本地内容资源。')); }
    private makeColossus() {
        this.bodyModel = this.models.get('colossus-rigged')!;
        this.models.delete('colossus-rigged');
        this.giant.add(this.bodyModel, this.climbPath);
        this.occluders.add(this.model('climb-rock',this.climbPath));
        const base = v(config.tracks.climb.points[0]);
        const ladder=this.connections.props.ladder[0];
        this.sourcePlane(ladder,1.8,this.climbPath,base.clone().add(v([.5,4,0])));
        for(let i=0;i<8;i++) {
            const p=trackPoint('climb',9+i*3.7);
            this.sourcePlane(this.connections.props.vine[0],2.2,this.climbPath,p.clone().add(v([0,1,0])));
            if(i%3===0)this.model('grip',this.climbPath,p.clone().add(v([.5,0,0])));
        }
        // A small route cut into the outside of a natural finger; never an open palm platform.
        this.box(base.clone().add(v([-2,36.75,0])).toArray(),[8,.5,5],C.stone,this.climbPath,false);
    }
    private makeFalls() {
        const material=new T.ShaderMaterial({transparent:true,depthWrite:false,side:T.DoubleSide,uniforms:{time:{value:0},mist:{value:0}},
            vertexShader:`#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 tex;void main(){tex=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);
#include <logdepthbuf_vertex>
}`,
            fragmentShader:`#include <logdepthbuf_pars_fragment>
varying vec2 tex;uniform float time;uniform float mist;void main(){
#include <logdepthbuf_fragment>
float edge=smoothstep(0.,.15,tex.x)*smoothstep(0.,.15,1.-tex.x);float ribbon=.5+.5*sin(tex.x*62.+sin(tex.y*9.+time*3.)*2.);float flow=.6+.4*sin(tex.y*130.+time*12.+tex.x*8.);float cloud=pow(max(0.,1.-length((tex-.5)*2.)),1.7);float alpha=mix(edge*(.25+.6*ribbon*flow),cloud*(.3+.15*sin(time*3.+tex.x*9.)),mist);gl_FragColor=vec4(mix(vec3(.45,.8,.85),vec3(.93,.99,.95),ribbon),alpha);}`});
        const sources=[...['index','middle','ring','little','thumb'].map(f=>({bone:`${f}.3.L`,width:350})),{bone:'hand.R',width:550},{bone:'chest',width:800},{point:trackPoint('climb',0).add(v([4,-1,-3])),width:2.2}];
        for(const source of sources){const sheet=new T.Mesh(new T.PlaneGeometry(1,1),material.clone()),spray=new T.Mesh(new T.PlaneGeometry(1,1),material.clone());spray.material.uniforms.mist.value=1;this.scene.add(sheet,spray);this.falls.push({...source,sheet,spray});}
        material.dispose();
    }
    private trackLength(name: string) { const points = config.tracks[name as TrackName].points; return points.slice(1).reduce((n, p, i) => n + v(p).distanceTo(v(points[i])), 0); }
    private terrain(name: string, parent: T.Object3D) {
        const road = new T.Group();
        parent.add(road);
        this.roads.set(name, road);
        if(['harbor-street','harbor-roofs','harbor-skywalk'].includes(name))return;
        this.makeTrack(name, road, name==='quay' ? C.wood : C.stone, .5, .1);
        this.makeTrack(name, road, name==='quay' ? C.wood : C.pale, .18);
    }
    private landform(name: RegionName, parent: T.Object3D) {
        this.model(`landscape-${name}` as ModelName,parent);
    }

    private loadDistrict(name: RegionName) {
        const existing = this.districts.get(name);
        if (existing)
            return existing;
        const group = new T.Group();
        group.name = name;
        const region = config.regions[name];
        const tracks = Object.entries(config.tracks).filter(([key, t]) => t.region === name && key !== 'climb' && key !== 'arrival');
        const moving = tracks[0][1].frame !== 'world';
        (moving ? this.giant : this.scene).add(group);
        this.districts.set(name, group);
        for (const [key] of tracks)
            this.terrain(key, group);
        this.landform(name, group);
        // Architecture, cliffs and vegetation are authored together in Blender.
        // Keep only interactive passages here; no second grid of grass or repeated houses.
        const labels: T.Texture[] = [];
        group.userData.labels = labels;
        const signPoints: T.Vector3[] = [];
        for (const passage of config.passages.filter(p => config.tracks[p.track as TrackName].region === name)) {
            const p = trackPoint(passage.track, passage.s), tangent = trackPoint(passage.track, Math.min(passage.s + 1, this.trackLength(passage.track))).sub(trackPoint(passage.track, Math.max(0, passage.s - 1))).normalize(), side = new T.Vector3(-tangent.z, 0, tangent.x);
            if (passage.track !== 'climb') {
                if (signPoints.some(point => point.distanceToSquared(p) < .04)) continue;
                signPoints.push(p.clone());
            }
            if (passage.track === 'climb') side.set(1,0,0);
            p.addScaledVector(side, -3.3);
            const signParent = passage.track === 'climb' ? this.climbPath : group;
            if (passage.track === 'climb' && this.climbPath.userData.signs) continue;
            this.beam(p, p.clone().add(new T.Vector3(0, 3, 0)), .11, C.wood, signParent);
            const canvas = document.createElement('canvas');
            canvas.width = 512;
            canvas.height = 128;
            const ctx = canvas.getContext('2d')!;
            ctx.fillStyle = '#31586a';
            ctx.fillRect(0, 0, 512, 128);
            ctx.strokeStyle = '#d6c59b';
            ctx.lineWidth = 8;
            ctx.strokeRect(7, 7, 498, 114);
            ctx.fillStyle = '#fff1cd';
            ctx.font = '600 39px system-ui';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(passage.label + ' ↑', 256, 65, 470);
            const texture = new T.CanvasTexture(canvas);
            texture.colorSpace = T.SRGBColorSpace;
            if (passage.track === 'climb') this.assets.push(texture); else labels.push(texture);
            const sign = new T.Mesh(new T.PlaneGeometry(4, 1), new T.MeshBasicMaterial({ map: texture, side: T.DoubleSide }));
            sign.position.copy(p).addScaledVector(side, .16).add(new T.Vector3(0, 2.7, 0));
            sign.rotation.y = -Math.atan2(tangent.z, tangent.x);
            signParent.add(sign);
        }
        if (name === 'harbor') this.climbPath.userData.signs = true;
        this.bake(group, new Set<T.Object3D>([...this.flags, ...this.roads.values(), ...this.occluders]));
        return group;
    }
    private districtsFor(region: RegionName, preload?: RegionName) {
        for (const name of [region, ...preload ? [preload] : []])
            this.loadDistrict(name);
        for (const [name, g] of this.districts) {
            g.visible = name === region;
            if (name === region || name === preload)
                continue;
            this.flags = this.flags.filter(f => !g.getObjectById(f.id));
            for (const o of this.occluders) if (g.getObjectById(o.id)) this.occluders.delete(o);
            g.traverse(o => { if (o instanceof T.Mesh || o instanceof T.LineSegments) {
                o.geometry.dispose();
                for (const m of Array.isArray(o.material) ? o.material : [o.material])
                    m.dispose();
            } });
            for (const texture of g.userData.labels ?? [])
                texture.dispose();
            g.removeFromParent();
            this.districts.delete(name);
            for (const key of this.roads.keys())
                if (config.tracks[key as TrackName].region === name)
                    this.roads.delete(key);
        }
    }
    private makeWater() {
        const geometry = new T.PlaneGeometry(2600, 2600, 120, 120);
        geometry.rotateX(-Math.PI / 2);
        const material = new T.ShaderMaterial({ uniforms: { time: { value: 0 }, sea: { value: -5 }, hand: { value: new T.Vector3(115, -5, 0) } },
            vertexShader: `#include <common>\n#include <logdepthbuf_pars_vertex>\nuniform float time;uniform float sea;varying vec3 w;varying float wave;void main(){vec3 p=position;wave=sin(p.x*.072+time*.7)*.42+sin(p.z*.1+time*.91)*.27; p.y=sea+wave;w=p;gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);\n#include <logdepthbuf_vertex>\n}`,
            fragmentShader: `#include <logdepthbuf_pars_fragment>
uniform float time;uniform vec3 hand;varying vec3 w;varying float wave;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
void main(){
#include <logdepthbuf_fragment>
float scale=max(1.,cameraPosition.y*.001);vec2 p=w.xz/(28.*scale);
float wash=noise(p+vec2(time*.009,0.))*.55+noise(p*2.1+vec2(0.,time*.013))*.3+noise(p*4.3)*.15;
vec3 col=mix(vec3(.09,.39,.48),vec3(.24,.59,.62),wash);
float crest=sin(p.y*25.+noise(p*3.)*7.+time*.9);float stroke=smoothstep(.94,.995,crest)*smoothstep(.63,.82,noise(p*5.));
col=mix(col,vec3(.66,.86,.82),stroke*.32);
float mist=1.-exp(-distance(w,cameraPosition)/max(1300.,cameraPosition.y*14.));gl_FragColor=vec4(mix(col,vec3(.70,.85,.86),mist),1.);}` });
        const water = new T.Mesh(geometry, material);
        this.scene.add(water);
        const farGeometry=new T.PlaneGeometry(4000000,4000000,1,1);farGeometry.rotateX(-Math.PI/2);
        const horizon = new T.Mesh(farGeometry,material);
        horizon.position.y=-1; this.scene.add(horizon);
        return water;
    }
    private originalSprite(frame:AssetFrame,parent:T.Object3D,position:T.Vector3,width:number) {
        const map=textureLoader.load(resolveAssetUrl(frame.url));map.colorSpace=T.SRGBColorSpace;this.assets.push(map);
        const sprite=new T.Sprite(new T.SpriteMaterial({map,alphaTest:.12,transparent:true,depthWrite:true}));
        sprite.scale.set(width,width*frame.height/frame.width,1);sprite.position.copy(position);sprite.center.set(.5,0);parent.add(sprite);this.originalSprites.push(sprite);return sprite;
    }
    private async loadOriginalArt() {
        try {
            for(const id of ['5130101','5150000'])for(const action of ['stand','move'])for(const frame of this.originals.monsters[id].actions[action].frames) {
                const image=await loadImage(frame.url);if(this.disposed)return;
                const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;canvas.getContext('2d')!.drawImage(image,0,0);
                this.stoneFrames.set(frame.url,paperFrame(canvas,-image.width/2,-image.height,1/36,.03));
            }
        } catch(error){this.status(String(error));}
        const props=this.originals.sceneAssets.portObjects.filter(f=>/acc1.img\/portTown\/artificiality\/(0|2|3|9|10)$/.test(f.source));
        for(let i=0;i<props.length;i++){const p=trackPoint('harbor',5+i*4);p.z-=2;this.originalSprite(props[i],this.harborProps,p,props[i].width/36);}
    }
    private makeClouds() {
        const cloud=this.originals.sceneAssets.backgrounds.find(f=>f.source==='Map/Back/portTown.img/back/4');
        const island=this.originals.sceneAssets.backgrounds.find(f=>f.source==='Map/Back/vicportTown.img/back/17');
        if(cloud)for(let i=0;i<9;i++)this.originalSprite(cloud,this.scene,v([-260+i*80,60+i%3*15,-260-i%2*80]),80+i%3*20);
        if(island)for(let i=0;i<5;i++)this.originalSprite(island,this.scene,v([-600+i*300,-5,-550-i%2*80]),200+i%3*40);
    }
    private fit() { const w = this.host.clientWidth, h = this.host.clientHeight; if (!w || !h)
        return; this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.renderer.setSize(w, h); }
    setLow(low: boolean) { this.low = low; this.renderer.setPixelRatio(low ? .7 : Math.min(devicePixelRatio, 1.5)); this.fit(); this.water.geometry.dispose(); this.water.geometry = new T.PlaneGeometry(2600, 2600, low ? 40 : 120, low ? 40 : 120); this.water.geometry.rotateX(-Math.PI / 2); this.frames = []; this.renders = []; }
    setMuted(muted: boolean) { this.sound.setMuted(muted); }
    rotateCamera() { this.chosenYaw += .25; this.skip(); }
    replay() { this.revealAt = performance.now(); this.revealLength = Math.max(17, 69 - (this.latest?.seconds ?? 69)); this.revealDone = true; }
    skip() { this.revealAt = 0; this.revealDone = true; }
    receive(state: ColossusState, tick: number, selfId: string, players: PlayerState[]) { if (tick <= this.latestTick)
        return; if (this.latest?.bridgeAge === null && state.bridgeAge !== null)
        this.witnessedCut = performance.now(); this.previous = this.latest; this.latest = state; this.latestTick = tick; this.selfId = selfId; this.players = players; this.received = performance.now(); }
    private async avatar(player: PlayerState) {
        const key = JSON.stringify([player.appearance, player.equipped]);
        const old = this.actorSprites.get(player.id);
        if (old?.key === key)
            return old;
        for (const texture of old?.textures.values() ?? [])
            disposePaper(texture);
        const actions = (this.manifest.appearanceCatalog && player.appearance ? composeAppearance(this.manifest.appearanceCatalog, player.appearance, player.equipped ?? []) : undefined) ?? this.manifest.avatar.actions;
        const textures = new Map<Frame, PaperFrame>();
        const sprite = old?.sprite ?? new PaperActor();
        sprite.visible = false;
        this.scene.add(sprite);
        const actor = { sprite, actions, textures, key };
        this.actorSprites.set(player.id, actor);
        try {
            if(this.manifest.appearanceCatalog && player.appearance) {
                await loadAppearanceLayers(this.manifest.appearanceCatalog,(player.equipped??[]).map(item=>item.itemId));
                if(this.disposed||this.actorSprites.get(player.id)!==actor)return;
                const weaponType=appearanceWeaponType(this.manifest.appearanceCatalog,player.equipped??[],player.appearance.weapon);
                actor.actions=composeAppearance(this.manifest.appearanceCatalog,player.appearance,player.equipped??[],{weaponType}) ?? actions;
            }
            for (const action of Object.keys(actor.actions) as (keyof AvatarActionSet)[]) {
                for (const frame of actor.actions[action] ?? actor.actions.stand) {
                    if (textures.has(frame))
                        continue;
                    const parts = await Promise.all(frame.parts.map(async (p) => ({ p, image: await loadImage(p.url) })));
                    if (this.disposed || this.actorSprites.get(player.id) !== actor)
                        return;
                    const left=Math.min(0,...parts.map(({p})=>p.x)), top=Math.min(0,...parts.map(({p})=>p.y));
                    const right=Math.max(1,...parts.map(({p,image})=>p.x+image.width)), bottom=Math.max(1,...parts.map(({p,image})=>p.y+image.height));
                    const canvas = document.createElement('canvas');canvas.width=right-left;canvas.height=bottom-top;
                    const ctx=canvas.getContext('2d')!;
                    for(const {p,image} of parts)ctx.drawImage(image,p.x-left,p.y-top);
                    textures.set(frame,paperFrame(canvas,left,top,2/72,.025));
                }
            }
        }
        catch (e) {
            this.status(String(e));
        }
        return actor;
    }
    private draw = (now: number) => {
        if (this.disposed)
            return;
        this.request = requestAnimationFrame(this.draw);
        const latest = this.latest;
        if (!latest)
            return;
        const dt = this.lastAt ? now - this.lastAt : 16.7;
        this.lastAt = now;
        this.frames.push(dt);
        if (this.frames.length > 600)
            this.frames.shift();
        this.harborProps.visible = latest.region === 'harbor';
        this.climbPath.visible = latest.region === 'harbor';
        const old = this.previous ?? latest;
        const f = T.MathUtils.clamp((now - this.received) / 50, 0, 1);
        const coherent = latest.frame.revision - old.frame.revision < 40;
        const t = coherent ? f : 1;
        const seconds = lerp(old.seconds, latest.seconds, t);
        const frame = { ...latest.frame, position: v(old.frame.position).lerp(v(latest.frame.position), t).toArray() as Vec3, yaw: lerp(old.frame.yaw, latest.frame.yaw, t), rotation: new T.Quaternion().fromArray(old.frame.rotation).slerp(new T.Quaternion().fromArray(latest.frame.rotation),t).toArray() as [number,number,number,number] };
        this.giant.position.copy(v(frame.position));
        this.giant.quaternion.fromArray(frame.rotation);
        for (const bone of rigData.bones) {
            const angle = lerp(old.frame.pose[bone.name] ?? 0, latest.frame.pose[bone.name] ?? 0,t);
            this.bones.get(bone.name)!.quaternion.fromArray(bone.rotation).multiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(1,0,0),T.MathUtils.clamp(angle,bone.flex[0],bone.flex[1])));
            if(bone.spread) {
                const spread=lerp(old.frame.pose[bone.name+'.spread']??0,latest.frame.pose[bone.name+'.spread']??0,t);
                this.bones.get(bone.name)!.quaternion.multiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(0,0,1),T.MathUtils.clamp(spread,bone.spread[0],bone.spread[1])));
            }
        }
        for (const [name,zone] of Object.entries(frame.zones)) {
            const previous = old.frame.zones[name] ?? zone;
            frame.zones = { ...frame.zones, [name]: { position:v(previous.position).lerp(v(zone.position),t).toArray() as Vec3, rotation:new T.Quaternion().fromArray(previous.rotation).slerp(new T.Quaternion().fromArray(zone.rotation),t).toArray() as [number,number,number,number] } };
        }
        const place = (group:T.Group,anchor:string) => { const zone=frame.zones[anchor];group.position.copy(v(zone.position));group.quaternion.fromArray(zone.rotation); };
        place(this.climbPath,'shin.L');
        place(this.harborProps,'harbor');
        for (const [name,group] of this.districts) {
            const track=config.tracks[config.regions[name as RegionName].home as TrackName];
            if ('anchor' in track) place(group,track.anchor);
        }
        this.water.material.uniforms.sea.value = latest.seaLevel;
        this.water.material.uniforms.time.value = now/1000;
        this.water.material.uniforms.hand.value.copy(worldPoint({track:'climb',s:0,height:0},frame));
        this.giant.updateWorldMatrix(true,true);
        for(const fall of this.falls) {
            const start=fall.bone?this.bones.get(fall.bone)!.getWorldPosition(new T.Vector3()):this.climbPath.localToWorld(fall.point!.clone());
            const height=start.y-latest.seaLevel;
            const visible=seconds>=30&&seconds<78&&height>1;
            fall.sheet.visible=fall.spray.visible=visible;if(!visible)continue;
            fall.sheet.position.copy(start);fall.sheet.position.y-=height/2;
            fall.sheet.scale.set(fall.width,height,1);fall.sheet.rotation.y=Math.atan2(this.camera.position.x-start.x,this.camera.position.z-start.z);
            fall.spray.position.copy(start);fall.spray.position.y=latest.seaLevel+fall.width*.15;
            fall.spray.scale.set(fall.width*3,fall.width*1.4,1);fall.spray.quaternion.copy(this.camera.quaternion);
            fall.sheet.material.uniforms.time.value=fall.spray.material.uniforms.time.value=seconds;
        }
        this.bridge.rotation.z = (1 - smooth((latest.bridgeAge ?? 0) / 1.5)) * Math.PI * .46;
        this.vine.visible = latest.region === 'harbor' && latest.bridgeAge === null;
        this.bridge.visible = latest.region === 'harbor';
        this.winch.visible = latest.region === 'harbor';
        this.winch.rotation.z = -(latest.bridgeAge ?? 0) * 3;
        if (this.bridgeRope) {
            this.bridge.updateWorldMatrix(true, false);
            const a = this.winch.position.clone(), b = this.harborProps.worldToLocal(this.bridge.localToWorld(v([trackPoint('harbor', 57.7).x - this.bridge.position.x, 0, -1.4])));
            this.bridgeRope.position.copy(a).add(b).multiplyScalar(.5);
            this.bridgeRope.scale.y = a.distanceTo(b) / Math.hypot(5.5, 4.4, -1.3);
            this.bridgeRope.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), b.sub(a).normalize());
        }
        const heavyStone=latest.stones[1];
        for (const bucket of this.buckets)
            bucket.rotation.z = heavyStone?.grounded && Math.abs(heavyStone.speed)>.1 ? Math.sin(now*.044)*.025*Math.exp(-((heavyStone.s/1.35)%1)*12) : 0;
        for (const flag of this.flags) {
            const a = flag.geometry.attributes.position;
            for (let i = 0; i < a.count; i++)
                a.setZ(i, Math.sin(a.getX(i) * 1.8 + now*.003) * .22);
            a.needsUpdate = true;
        }
        for (let i=0;i<latest.stones.length;i++) {
            const b=latest.stones[i],before=old.stones[i]??b,actor=this.stones[i];
            const action=this.originals.monsters[i?'5150000':'5130101'].actions[Math.abs(b.speed)>.15?'move':'stand'];
            // P: source mob canvases lack origin/delay; bottom-center until complete metadata is available.
            const frames=action.zigzag && action.frames.length>2?[...action.frames,...action.frames.slice(1,-1).reverse()]:action.frames;
            const index=frameAt(frames.map(f=>f.delay),Math.abs(b.speed)>.15?b.s/(i?1.35:.7)*600:now,true);
            const art=this.stoneFrames.get(frames[index].url);
            if(art)actor.show(art);actor.visible=!!art&&latest.region==='harbor';
            actor.position.copy(worldPoint({...b,s:lerp(before.s,b.s,t),height:lerp(before.height,b.height,t)},frame));actor.position.z-=2.7;
            actor.faceCamera(this.camera,b.facing*screenDirection(worldTangent(b,frame),this.camera,this.screenSign));
        }
        latest.people.forEach((p, i) => {
            const before = old.people[i] ?? p;
            const q = worldPoint({ ...p, s: lerp(before.s, p.s, t),height:lerp(before.height,p.height,t) }, frame), sprite = this.people[i];
            sprite.visible = latest.region === 'harbor' && !!sprite.material.map;
            sprite.position.copy(q);
            sprite.material.rotation = p.grounded ? 0 : .04;
            if (i < 5) {
                const holding = i === 0 && p.track === 'harbor' && p.s > 43 && p.s < 47 && !latest.bridgeOpen;
                sprite.center.y = holding ? 64 / 1536 : 48 / 1536;
                const map = holding ? this.winchFrame : Math.abs(p.speed) > .15 ? this.workerFrames[[1, 0, 2, 0][Math.floor(now*.007 + i) % 4]] : this.workerFrames[0];
                if (map && map !== sprite.material.map) {
                    sprite.material.map = map;
                    sprite.material.needsUpdate = true;
                }
            }
        });
        let self: T.Vector3 | undefined;
        let selfBody: ColossusBody | undefined;
        for (const actor of latest.actors) {
            const before = old.actors.find(p => p.id === actor.id)?.body ?? actor.body;
            const b = actor.body;
            const same = before.track === b.track && before.warp === b.warp;
            const pos = worldPoint({ ...b, s: same ? lerp(before.s,b.s,t) : b.s, height: same ? lerp(before.height,b.height,t) : b.height },frame);
            if (actor.id === this.selfId) {
                self = pos;
                selfBody = b;
            }
            const player = this.players.find(p => p.id === actor.id);
            if (!player)
                continue;
            void this.avatar(player);
            const art = this.actorSprites.get(actor.id);
            if (!art)
                continue;
            const cast=this.casting.get(actor.id);
            const skillAction=cast&&cast.until>now?cast.action:undefined;
            const action = player.hp<=0 ? 'dead' : skillAction && (art.actions as Record<string,Frame[]>)[skillAction]?.length ? skillAction : player.chair ? 'sit' : b.track === 'climb' && b.grounded ? 'climb' : actor.attacking ? 'attack' : !b.grounded ? 'jump' : Math.abs(b.speed) > .15 ? 'walk' : 'stand';
            const frames = (art.actions as Record<string,Frame[]>)[action] ?? art.actions.stand;
            const chosen = frames[frameAt(frames.map(f => f.delay), (action==='climb' && Math.abs(b.speed)<.1 ? 0 : skillAction&&cast ? now-cast.start : actor.attacking ? Math.max(0,(this.latestTick-player.actionStartedTick)*50+(now-this.received)) : now), true)];
            const texture = art.textures.get(chosen);
            if (texture) {
                art.sprite.visible = true;
                art.sprite.show(texture);
                art.sprite.position.copy(pos);
                art.sprite.faceCamera(this.camera,b.facing*screenDirection(worldTangent(b,frame),this.camera,this.screenSign));
            }
        }
        for (const [id, a] of this.actorSprites)
            if (!latest.actors.some(p => p.id === id)) {
                this.scene.remove(a.sprite);
                a.sprite.dispose();
                for (const texture of a.textures.values())
                    disposePaper(texture);
                this.actorSprites.delete(id);
            }
        for(const effect of [...this.spells]) {
            const age=now-effect.start,total=effect.frames.reduce((sum,f)=>sum+f.delay,0);
            if(age>=total){effect.mesh.removeFromParent();effect.mesh.geometry.dispose();effect.mesh.material.dispose();this.spells.splice(this.spells.indexOf(effect),1);continue;}
            const f=effect.frames[frameAt(effect.frames.map(f=>f.delay),age,false)];
            const actor=this.actorSprites.get(effect.actor);if(!actor)continue;
            effect.mesh.position.copy(effect.at??actor.sprite.position);
            effect.mesh.quaternion.copy(this.camera.quaternion);
            effect.mesh.translateX((f.x+f.width/2)/36);effect.mesh.translateY(-(f.y+f.height/2)/36);
            effect.mesh.scale.set(f.width/36,f.height/36,1);effect.mesh.material.map=this.spellTextures.get(f.url)!;
        }
        if(selfBody?.track==='arrival'&&self)this.boat.position.copy(self);
        else this.boat.position.copy(trackPoint('arrival',this.trackLength('arrival')));
        this.boat.rotation.y=this.cameraYaw;
        this.boat.scale.y=this.boat.scale.z=.8;
        this.boat.scale.x=.8*screenDirection(worldTangent({track:'arrival',s:0},frame),this.camera,1);
        this.sound.update(seconds, latest.bridgeAge, selfBody, latest.stones);
        if (self && selfBody) {
            const region = latest.region as RegionName;
            if (region !== this.activeRegion) {
                this.activeRegion = region;
                this.revealAt = 0;
            }
            const nearby = config.passages.filter(p => p.track === selfBody.track && Math.abs(p.s - selfBody.s) < 24).sort((a, b) => Math.abs(a.s - selfBody!.s) - Math.abs(b.s - selfBody!.s))[0];
            const preload = nearby ? config.tracks[nearby.toTrack as TrackName].region as RegionName : undefined;
            this.districtsFor(region, preload);
            if (!this.revealDone && selfBody.track === 'harbor' && selfBody.s > 88 && seconds > 31) {
                this.revealAt = now;
                this.revealLength = Math.max(17, 69 - seconds);
                this.revealDone = true;
            }
            const tangent = selfBody.track === 'climb' ? new T.Vector3(1,0,0) : worldTangent(selfBody.track==='arrival'?{track:'harbor',s:0}:selfBody,frame);
            const desiredSide = new T.Vector3(-tangent.z,0,tangent.x).normalize();
            if(!this.cameraReady){this.chosenYaw=Math.atan2(desiredSide.x,desiredSide.z);this.cameraYaw=this.chosenYaw;}
            let yaw=this.chosenYaw;
            if(!this.dragging && now>this.manualUntil && Math.abs(selfBody.speed)>.15) {
                const preferred=Math.atan2(desiredSide.x,desiredSide.z);
                const near=angleDelta(yaw,preferred),opposite=angleDelta(yaw,preferred+Math.PI);
                const correction=Math.abs(near)<Math.abs(opposite)?near:opposite;
                yaw+=T.MathUtils.clamp(correction,-.18,.18);
            }
            const angularStep=(this.dragging?8:.35)*Math.min(dt,100)/1000;
            const manual=!!this.dragging||now<this.manualUntil;
            this.cameraYaw=manual?yaw:this.cameraYaw+T.MathUtils.clamp(angleDelta(this.cameraYaw,yaw),-angularStep,angularStep);
            let target = self.clone().add(new T.Vector3(0, 4.5, 0));
            if(region==='harbor' && selfBody.track!=='climb')target.addScaledVector(tangent,5);
            this.sun.target.position.copy(self);this.sun.position.copy(self).add(new T.Vector3(-55,100,65));
            let position = target.clone().add(new T.Vector3(Math.sin(this.cameraYaw)*this.cameraDistance,Math.tan(this.pitch)*this.cameraDistance,Math.cos(this.cameraYaw)*this.cameraDistance));
            const elapsed = this.revealAt ? (now - this.revealAt) / 1000 : 99;
            if (elapsed < this.revealLength) {
                const amount = smooth(elapsed / 4) * (1 - smooth((elapsed - this.revealLength + 4) / 4));
                const outward = smooth((elapsed - 6) / 5);
                const palm = worldPoint({track:'climb',s:0,height:0},frame);
                const focus = palm.clone().lerp(this.giant.localToWorld(v([0,65000,0])),outward);
                focus.y=Math.max(latest.seaLevel+6000,focus.y);
                const wide = focus.clone().add(new T.Vector3(-.52,.35,.85).multiplyScalar(lerp(75000,190000,outward)));
                target.lerp(focus, amount);
                position.lerp(wide, amount);
            }
            const weight = this.cameraReady && !manual ? 1 - Math.exp(-Math.min(dt, 100) / 140) : 1;
            this.camera.position.lerp(position, weight);
            if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                const stone=latest.stones[1];
                const pulse = seconds>=30&&seconds<65?Math.exp(-(seconds%4.5)*8):stone?.grounded&&Math.abs(stone.speed)>.1?Math.exp(-((stone.s/1.35)%1)*12):0;
                const heavy = seconds > 30 && seconds < 65 ? .08 : stone && v(stone.position).distanceTo(self)<25 ? .025 : 0;
                this.camera.position.y += Math.sin(seconds * 46) * pulse * heavy;
            }
            this.camera.lookAt(target);
            this.screenSign=screenDirection(tangent,this.camera,this.screenSign);
            this.cameraReady = true;
            if (now - this.occlusionAt > 180) {
                this.occlusionAt = now;
                const direction = self.clone().add(new T.Vector3(0, .8, 0)).sub(this.camera.position);
                this.sight.set(this.camera.position, direction.clone().normalize());
                this.sight.far = direction.length() - .2;
                const visibleRoads = [...this.roads].filter(([name])=>config.tracks[name as TrackName].region===region).map(([,road])=>road);
                for (const road of [...visibleRoads,...this.occluders]) {
                    road.updateWorldMatrix(true, true);
                    const blocks = this.sight.intersectObject(road, true).length > 0;
                    road.traverse(o => { if (o instanceof T.Mesh) {
                        const material = o.material as T.MeshToonMaterial;
                        if (material.transparent !== blocks) {
                            material.transparent = blocks;
                            material.opacity = blocks ? (this.occluders.has(road) ? .08 : .24) : 1;
                            material.depthWrite = !blocks;
                            material.needsUpdate = true;
                        }
                    } });
                }
            }
            let line: string;
            const child = latest.people[5], net = latest.people[6], crowdNear = region === 'harbor' && selfBody.track === 'harbor' && child.s > 88 && Math.abs(net.s - selfBody.s) < 15;
            const picking = crowdNear && elapsed >= this.revealLength + 3 && elapsed < this.revealLength + 5.5;
            this.people[6].center.y = picking ? 99 / 1536 : 51 / 1536;
            const netMap = this.netFrames[picking ? 1 : 0];
            if (netMap && this.people[6].material.map !== netMap) {
                this.people[6].material.map = netMap;
                this.people[6].material.needsUpdate = true;
            }
            if (this.shuttle) {
                this.shuttle.position.copy(worldPoint(net, frame)).add(new T.Vector3(.65, .05, .2));
                this.shuttle.visible = region === 'harbor' && (!this.revealAt || elapsed < this.revealLength + 4.7);
            }
            if (selfBody.track === 'climb')
                line = '沿石壁攀爬：↑ 上行，↓ 下行；松开方向可以停住。';
            else if (elapsed < this.revealLength)
                line = seconds < 65 ? '海水正从那道石纹两侧退开。' : '那道石纹，原来连着一只手。';
            else if (crowdNear && elapsed < this.revealLength + 3)
                line = '小孩：“那不是礁石。”';
            else if (crowdNear && elapsed < this.revealLength + 6)
                line = '补网人：“我知道。”';
            else if (latest.passage)
                line = `↑ ${latest.passage.label} · 沿路口继续`;
            else if (region !== 'harbor')
                line = config.regions[region].subtitle + '。路牌连接邻近街道，沿途可以随时折返。';
            else if (selfBody.track === 'lower')
                line = '浅坡仍通向高台。沿下面的路也能走上去。';
            else if (selfBody.track === 'quay')
                line = '港湾环道通往街区和海岸。高台的蓝旗在来路一侧。';
            else if (selfBody.s < 19)
                line = '船工：“沿蓝旗去高台！上面看得清！”';
            else if (latest.bridgeAge === null && selfBody.s > 37 && selfBody.s < 50)
                line = '船工：“我把绞盘稳住，你打断那根藤！”';
            else if (this.witnessedCut > 0 && now - this.witnessedCut < 6500 && selfBody.s > 37 && selfBody.s < 65)
                line = !latest.bridgeOpen ? '船工：“藤断了，等桥落稳！”' : latest.helped ? '船工：“多谢！好了，走！”' : '船工：“好了，走！”';
            else if (selfBody.s < 80)
                line = '沿蓝旗继续上行。落到浅坡也能走上高台。';
            else
                line = seconds < 65 ? '高台可以安全停留。海水正从那道石纹两侧退开。' : '石壁的落脚处露出来了。靠近后按 ↑ 攀爬，也可以继续留在高台。';
            this.status(line);
        }
        const fog = this.scene.fog as T.Fog;
        const wideDistance = self ? Math.max(0,this.camera.position.distanceTo(self)-100) : 0;
        fog.near = 160 + wideDistance*.75; fog.far = 850 + wideDistance*4;
        const start = performance.now();
        this.renderer.render(this.scene, this.camera);
        this.renders.push(performance.now() - start);
        if (this.renders.length > 600)
            this.renders.shift();
        if (this.frames.length % 30 === 0) {
            const quant = (a: number[], q: number) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * q)];
            this.host.dataset.metrics = JSON.stringify({ samples: this.frames.length, frameP50: quant(this.frames, .5), frameP95: quant(this.frames, .95), frameP99: quant(this.frames, .99), renderP95: quant(this.renders, .95), calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles, textures: this.renderer.info.memory.textures, geometries: this.renderer.info.memory.geometries, region: this.activeRegion, districts: this.districts.size, low: this.low });
        }
    };
    destroy() { this.disposed = true; for(const [name,handler] of [['contextmenu',this.onContext],['wheel',this.onOrbitWheel],['pointerdown',this.onOrbitDown],['pointermove',this.onOrbitMove],['pointerup',this.onOrbitUp],['pointercancel',this.onOrbitUp],['lostpointercapture',this.onOrbitUp]] as const)this.renderer.domElement.removeEventListener(name,handler as EventListener); this.renderer.domElement.removeEventListener('pointerup',this.onPointer); this.sound.destroy(); cancelAnimationFrame(this.request); this.resize.disconnect(); this.scene.traverse(o => { if (o instanceof T.Mesh || o instanceof T.LineSegments) {
        if (o instanceof T.SkinnedMesh) o.skeleton.dispose();
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material])
            m.dispose();
    }
    else if (o instanceof T.Sprite)
        o.material.dispose(); }); for (const group of this.districts.values())
        for (const t of group.userData.labels ?? [])
            t.dispose(); for (const a of this.actorSprites.values())
        for (const t of a.textures.values())
            disposePaper(t); for (const model of this.models.values()) model.traverse(o => { if (o instanceof T.Mesh) { o.geometry.dispose(); (o.material as T.Material).dispose(); } }); this.assets.forEach(t => t.dispose()); this.spellTextures.forEach(t=>t.dispose());this.stoneFrames.forEach(disposePaper); images.clear(); this.renderer.dispose(); this.renderer.forceContextLoss(); this.renderer.domElement.remove(); }
}
