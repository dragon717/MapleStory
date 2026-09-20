import * as T from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import config from '../../../../shared/colossus.json';
import type { ColossusState, ColossusBody, Vec3, PlayerState } from '../../../../shared/protocol';
import type { Manifest, AvatarActionSet, Frame } from '../../assets/manifest';
import { composeAppearance } from '../entry/appearance';
import { frameAt } from '../player/animation';
import { resolveAssetUrl } from '../../assets/resource-url';
import { HarborSound } from './sound';
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
function trackPoint(name: string, s: number) {
    const points = config.tracks[name as keyof typeof config.tracks].points;
    for (let i = 1; i < points.length; i++) {
        const a = v(points[i - 1]), b = v(points[i]), d = a.distanceTo(b);
        if (s <= d || i === points.length - 1)
            return a.lerp(b, T.MathUtils.clamp(s / d, 0, 1));
        s -= d;
    }
    return v(points[0]);
}
function worldPoint(body: ColossusBody, frame: ColossusState['frame']) {
    if (!body.grounded)
        return v(body.position);
    const p = trackPoint(body.track, body.s);
    return config.tracks[body.track as TrackName].frame !== 'world' ? p.applyAxisAngle(new T.Vector3(0, 1, 0), frame.yaw).add(v(frame.position)) : p;
}
/** Third activity only. No prediction, collision, event advancement or client coordinates. */
export class ColossusScene {
    readonly renderer: T.WebGLRenderer;
    readonly scene = new T.Scene();
    readonly camera = new T.PerspectiveCamera(38, 1, .1, 2200);
    readonly giant = new T.Group();
    private sound = new HarborSound();
    private hand = new T.Group();
    private distantVillage = new T.Group();
    private harborProps = new T.Group();
    private witnessedCut = 0;
    private districts = new Map<string, T.Group>();
    private roads = new Map<string, T.Group>();
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
    private arm?: T.Mesh;
    private bridge = new T.Group();
    private vine = new T.Group();
    private water: T.Mesh<T.PlaneGeometry, T.ShaderMaterial>;
    private curtains: T.Mesh[] = [];
    private flags: T.Mesh[] = [];
    private stones: T.Group[] = [];
    private buckets: T.Mesh[] = [];
    private actorSprites = new Map<string, {
        sprite: T.Sprite;
        actions: AvatarActionSet;
        textures: Map<Frame, T.CanvasTexture>;
        key: string;
    }>();
    private people: T.Sprite[] = [];
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
    private orbit = 0;
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
    constructor(private host: HTMLElement, private manifest: Manifest, status: (text: string) => void, private talk?: (index: number) => void) {
        this.status = status;
        this.renderer = new T.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
        this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
        this.renderer.outputColorSpace = T.SRGBColorSpace;
        this.renderer.domElement.setAttribute('aria-label', '巨石之约：港口与移动巨像');
        this.host.append(this.renderer.domElement);
        this.renderer.domElement.addEventListener('pointerup',this.onPointer);
        this.scene.background = new T.Color(0xb4dadd);
        this.scene.fog = new T.Fog(0xc3dfdf, 200, 1050);
        this.scene.add(new T.HemisphereLight(0xfff4dc, 0x9bbcc4, 1.4));
        const sun = new T.DirectionalLight(0xffead2, 1.0);
        sun.position.set(-70, 140, 90);
        this.scene.add(sun);
        this.scene.add(this.giant);
        this.makeColossus();
        const old = new Set(this.scene.children);
        this.makeHarbor();
        for (const child of [...this.scene.children])
            if (!old.has(child))
                this.harborProps.add(child);
        this.scene.add(this.harborProps);
        this.loadDistrict('harbor');
        this.water = this.makeWater();
        this.makeClouds();
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
        return new T.MeshToonMaterial({ color: painted ? 0xffffff : color, map: painted ? this.texture(roof ? 'handpainted-roof' : wood ? 'handpainted-timber' : color === C.wall ? 'handpainted-plaster' : color === C.moss ? 'handpainted-grass' : 'handpainted-stone') : null });
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
            if (!(o instanceof T.Mesh || o instanceof T.LineSegments) || o instanceof T.InstancedMesh)
                return;
            for (let p: T.Object3D | null = o; p; p = p.parent)
                if (excluded.has(p))
                    return;
            const mat = o.material;
            if (Array.isArray(mat) || !(mat instanceof T.MeshToonMaterial || mat instanceof T.LineBasicMaterial))
                return;
            const line = o instanceof T.LineSegments, key = [line, mat.color.getHex(), mat.side, mat.opacity, 'map' in mat ? mat.map?.uuid : ''].join(':');
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
            batch.parts.push(geometry);
            sources.push(o);
        });
        for (const batch of batches.values()) {
            const geometry = mergeGeometries(batch.parts);
            if (!geometry)
                throw new Error('港口静态几何格式不一致');
            parent.add(batch.line ? new T.LineSegments(geometry, batch.material) : new T.Mesh(geometry, batch.material));
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
    private rock(p: number[], size: number[], color: number, parent: T.Object3D = this.scene, detail = 0) { const geometry = new T.SphereGeometry(1, color === C.moss ? 12 : 24 + detail * 4, color === C.moss ? 8 : 16 + detail * 4), uv = geometry.attributes.uv; const repeat = Math.max(1, Math.max(...size) / 6); for (let i = 0; i < uv.count; i++)
        uv.setXY(i, uv.getX(i) * repeat, uv.getY(i) * repeat); const m = this.mesh(geometry, color, parent, false); m.position.copy(v(p)); m.scale.set(...size as [
        number,
        number,
        number
    ]); return m; }
    private beam(a: T.Vector3, b: T.Vector3, width: number, color: number, parent: T.Object3D = this.scene) { const m = this.mesh(new T.CylinderGeometry(width, width, a.distanceTo(b), 5), color, parent, false); m.position.copy(a).add(b).multiplyScalar(.5); m.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), b.clone().sub(a).normalize()); return m; }
    private house(x: number, y: number, z: number, scale = 1, parent: T.Object3D = this.scene) {
        const g = new T.Group();
        g.position.set(x, y, z);
        g.scale.setScalar(scale);
        parent.add(g);
        this.box([0, 2.25, 0], [6, 4.5, 4.8], C.wall, g, false);
        for (const x of [-2.7, 0, 2.7])
            this.box([x, 2.3, 2.43], [.19, 4.6, .17], C.wood, g, false);
        this.box([0, .1, 0], [6.5, .25, 5.3], C.pale, g, false);
        this.box([0, 3.8, 2.5], [6.6, .18, .2], C.wood, g, false);
        const shape = new T.Shape();
        shape.moveTo(-3.7, 0);
        shape.quadraticCurveTo(-1.8, .25, 0, 2.4);
        shape.quadraticCurveTo(1.8, .25, 3.7, 0);
        shape.lineTo(3.7, -.35);
        shape.quadraticCurveTo(0, 1.2, -3.7, -.35);
        shape.closePath();
        const roofGeometry = new T.ExtrudeGeometry(shape, { depth: 5.6, bevelEnabled: true, bevelThickness: .12, bevelSize: .12, bevelSegments: 2, steps: 1 });
        const roofUv = roofGeometry.attributes.uv;
        for (let i = 0; i < roofUv.count; i++)
            roofUv.setXY(i, roofUv.getX(i) / 7, roofUv.getY(i) / 7);
        const roof = this.mesh(roofGeometry, C.roof, g, false);
        roof.position.set(0, 4.6, -2.8);
        this.box([0, 1.3, 2.48], [1.35, 2.6, .12], C.wood, g, false);
        this.box([.42, 1.3, 2.59], [.1, .1, .1], 0xe8bd65, g, false);
        for (const side of [-1, 1]) {
            this.box([side * 1.8, 2.2, 2.46], [1.1, 1.4, .14], 0x526b76, g, false);
            this.box([side * 1.8, 1.42, 2.68], [1.45, .18, .7], C.wood, g, false);
            this.box([side * 1.8, 2.2, 2.57], [.08, 1.45, .12], C.wood, g, false);
            this.box([side * 1.8, 2.2, 2.57], [1.1, .09, .12], C.wood, g, false);
        }
        this.box([1.7, 5.5, 0], [.8, 2.1, .8], C.pale, g, false);
        return g;
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
                if (name === 'harbor' && config.gaps.some(g => at > g[0] && at < g[1]))
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
    private flag(x: number, y: number, z: number, parent: T.Object3D = this.scene) { this.beam(new T.Vector3(x, y, z), new T.Vector3(x, y + 6, z), .08, C.wood, parent); const flag = this.mesh(new T.PlaneGeometry(2.8, 1.4, 8, 2), C.blue, parent, false); flag.material.side = T.DoubleSide; flag.position.set(x + 1.4, y + 5, z); this.flags.push(flag); }
    private makeHarbor() {
        for (const s of [8, 29, 42, 64, 88, 111]) {
            const p = trackPoint('harbor', s);
            this.flag(p.x, p.y, p.z - 1.4);
        }
        for (const x of [4, 10, 14]) {
            const bucket = this.mesh(new T.CylinderGeometry(.35, .3, .7, 12), C.blue);
            bucket.position.set(x, .4, -1);
            this.buckets.push(bucket);
        }
        const boat = new T.Group();
        boat.position.set(-6, -1.5, -10);
        this.scene.add(boat);
        const hull = new T.Shape();
        hull.moveTo(-8, 1);
        hull.quadraticCurveTo(-5, -2.4, 0, -2.4);
        hull.quadraticCurveTo(6, -2.3, 8, 1.4);
        hull.quadraticCurveTo(0, .2, -8, 1);
        const hullGeo = new T.ExtrudeGeometry(hull, { depth: 4, bevelEnabled: true, bevelThickness: .3, bevelSize: .3, bevelSegments: 3, steps: 1 });
        const hu = hullGeo.attributes.uv;
        for (let i = 0; i < hu.count; i++)
            hu.setXY(i, hu.getX(i) / 8, hu.getY(i) / 8);
        this.mesh(hullGeo, C.wood, boat, false).position.z = -2;
        this.box([0, .45, 0], [10, .3, 3.5], C.sand, boat, false);
        this.beam(v([0, 0, 0]), v([0, 11, 0]), .13, C.wood, boat);
        const sail = this.mesh(new T.PlaneGeometry(5.5, 7, 6, 6), C.wall, boat, false);
        const sp = sail.geometry.attributes.position;
        for (let i = 0; i < sp.count; i++)
            sp.setZ(i, Math.sin((sp.getX(i) + 2.75) / 5.5 * Math.PI) * .8);
        sail.geometry.computeVertexNormals();
        sail.position.set(2.7, 6.5, 0);
        sail.material.side = T.DoubleSide;
        const start = trackPoint('harbor', 48.7), end = trackPoint('harbor', 57.7);
        this.bridge.position.copy(start);
        this.scene.add(this.bridge);
        for (let i = 0; i < 12; i++)
            this.box([(i + .5) * (end.x - start.x) / 12, 0, 0], [(end.x - start.x) / 12 - .035, .4, 3.5], C.wood, this.bridge);
        this.bridge.rotation.z = Math.PI * .46;
        this.scene.add(this.vine);
        for (let i = 0; i < 3; i++)
            this.beam(v([44.2 + i * .3, 7.8, -1]), v([49.5, 13 + i * .3, -1]), .12, 0x537251, this.vine);
        this.winch.position.set(44, 8.6, .3);
        this.scene.add(this.winch);
        this.mesh(new T.TorusGeometry(.55, .09, 8, 24), C.wood, this.winch, false);
        this.beam(v([-.5, 0, 0]), v([.5, 0, 0]), .07, C.wood, this.winch);
        this.beam(v([0, -.55, 0]), v([0, .55, 0]), .07, C.wood, this.winch);
        this.bridgeRope = this.beam(v([44, 8.6, .3]), v([49.5, 13, -1]), .035, C.wood);
        for (const size of [1.4, 9]) {
            const g = new T.Group();
            this.scene.add(g);
            this.stones.push(g);
            this.rock([0, size * .5, 0], [size * .32, size * .37, size * .24], C.stone, g);
            this.rock([0, size * .87, 0], [size * .23, size * .21, size * .22], C.pale, g);
            for (const side of [-1, 1]) {
                this.rock([side * size * .24, size * .12, 0], [size * .16, size * .16, size * .23], C.stone, g);
                this.rock([side * size * .38, size * .52, 0], [size * .16, size * .3, size * .16], C.stone, g);
                this.box([side * size * .075, size * .9, size * .2], [size * .035, size * .035, size * .03], 0xf3d77c, g, false);
            }
        }
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
        this.rock([0, -84, -40], [93, 100, 65], C.stone, this.giant, 1);
        this.rock([0, -13, -30], [111, 27, 91], C.pale, this.giant, 1);
        this.rock([0, 51, -54], [34, 46, 32], C.stone, this.giant, 2);
        for (const x of [-17, 17]) {
            this.rock([x, 48, -24], [13, 5, 7], C.pale, this.giant);
            this.box([x, 46, -17.6], [10, 1, 1], 0x435958, this.giant, false);
        }
        this.rock([0, 38, -21], [7, 13, 9], C.pale, this.giant);
        this.rock([0, 21, -28], [23, 11, 20], C.stone, this.giant);
        for (const x of [-44, 44])
            this.beam(v([x, -110, -37]), v([x * 1.3, -237, -19]), 24, C.stone, this.giant);
        this.beam(v([90, -17, -25]), v([138, -83, 12]), 20, C.stone, this.giant);
        this.giant.add(this.hand);
        this.rock([0, -1.5, 0], [12, 3.2, 11], C.pale, this.hand, 2);
        for (let i = 0; i < 4; i++) {
            this.rock([-14 - i % 2 * 2, -1, -7.2 + i * 4.8], [13, 2.3, 2.2], C.stone, this.hand, 1);
            this.rock([-7, .1, -7.2 + i * 4.8], [4.2, 2.1, 2.3], C.pale, this.hand, 1);
        }
        this.rock([1, -1, 13], [4, 3, 10], C.stone, this.hand, 1);
        this.arm = this.mesh(new T.CylinderGeometry(5.5, 12, Math.sqrt(114 ** 2 + 16 ** 2 + 38 ** 2), 20), C.stone, this.giant, false);
        for (let i = 0; i < 9; i++) {
            const m = this.box([-15 + i * 3.7, 0, 8], [2.1, 1, .65], 0xc2f4ed, this.hand, false);
            m.material.transparent = true;
            m.material.opacity = .68;
            this.curtains.push(m);
        }
        this.giant.add(this.distantVillage);
        this.landform('shoulder', this.distantVillage);
        for (const s of [198, 260, 322, 384]) {
            const p = trackPoint('shoulder', s), tangent = trackPoint('shoulder', s + 1).sub(p).normalize();
            p.addScaledVector(new T.Vector3(-tangent.z, 0, tangent.x), -8);
            this.box([p.x, p.y - 2, p.z], [8, 4, 8], C.stone, this.distantVillage);
            const house = this.house(p.x, p.y, p.z, 1.05, this.distantVillage);
            house.rotation.y = -Math.atan2(tangent.z, tangent.x);
        }
        this.bake(this.distantVillage, new Set());
        this.bake(this.giant, new Set([this.hand, this.arm, this.distantVillage]));
    }
    private trackLength(name: string) { const points = config.tracks[name as TrackName].points; return points.slice(1).reduce((n, p, i) => n + v(p).distanceTo(v(points[i])), 0); }
    private terrain(name: string, parent: T.Object3D) {
        const track = config.tracks[name as TrackName];
        const road = new T.Group();
        parent.add(road);
        this.roads.set(name, road);
        this.makeTrack(name, road, C.stone, 4.8, 2);
        this.makeTrack(name, road, ['gardens', 'heights'].includes(track.region) ? C.moss : track.region === 'harbor' ? C.sand : C.pale);
    }
    private landform(name: RegionName, parent: T.Object3D) {
        const home = name === 'harbor' ? 'quay' : config.regions[name].home;
        const path = config.tracks[home as TrackName].points.filter(p => name !== 'shoulder' || p[0] > -120).map(v);
        const paths = Object.values(config.tracks).filter(t => t.region === name).map(t => t.points.filter(p => name !== 'shoulder' || p[0] > -120).map(v));
        const bounds = new T.Box3().setFromPoints(path), center = bounds.getCenter(new T.Vector3()), size = bounds.getSize(new T.Vector3());
        const positions: number[] = [], uvs: number[] = [], indices: number[] = [], rings = 14, sectors = 64;
        for (let ring = 0; ring <= rings; ring++)
            for (let j = 0; j <= sectors; j++) {
                const r = ring / rings, angle = j / sectors * Math.PI * 2, x = center.x + Math.cos(angle) * (size.x * .57 + 8) * r, z = center.z + Math.sin(angle) * (size.z * .57 + 8) * r;
                let height = Infinity;
                // A lower turn constrains the earth beneath every overpass at the same X/Z.
                for (const line of paths)
                    for (let k = 1; k < line.length; k++) {
                        const a = line[k - 1], d = line[k].clone().sub(a), f = T.MathUtils.clamp(((x - a.x) * d.x + (z - a.z) * d.z) / (d.x * d.x + d.z * d.z), 0, 1), q = a.clone().addScaledVector(d, f), dist = Math.hypot(x - q.x, z - q.z);
                        height = Math.min(height, q.y + dist * .12);
                    }
                const floor = config.tracks[home as TrackName].frame === 'world' ? -13 : bounds.min.y - 26;
                const y = lerp(height - 3, floor, smooth((r - .88) / .12));
                positions.push(x, y, z);
                uvs.push(x / 16, z / 16);
            }
        const geometry = new T.BufferGeometry();
        geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
        for (let ring = 0; ring < rings; ring++) {
            const start = indices.length;
            for (let j = 0; j < sectors; j++) {
                const a = ring * (sectors + 1) + j, b = a + sectors + 1;
                indices.push(a, a + 1, b, a + 1, b + 1, b);
            }
            geometry.addGroup(start, indices.length - start, ring < rings - 2 ? 0 : 1);
        }
        geometry.setIndex(indices);
        geometry.computeVertexNormals();
        parent.add(new T.Mesh(geometry, [this.toon(name === 'coast' ? C.pale : C.moss), this.toon(C.stone)]));
    }
    private loadDistrict(name: RegionName) {
        const existing = this.districts.get(name);
        if (existing)
            return existing;
        const group = new T.Group();
        group.name = name;
        const region = config.regions[name];
        const tracks = Object.entries(config.tracks).filter(([, t]) => t.region === name);
        const moving = tracks[0][1].frame !== 'world';
        (moving ? this.giant : this.scene).add(group);
        this.districts.set(name, group);
        for (const [key] of tracks)
            this.terrain(key, group);
        this.landform(name, group);
        // Keep the harbor settlement on the quay island; the lookout is a narrow pier.
        const main = name === 'harbor' ? 'quay' : region.home, len = this.trackLength(main), step = name === 'coast' ? 54 : 31;
        const foundationFloor = moving ? Math.min(...tracks.flatMap(([, t]) => t.points.map(p => p[1]))) - 26 : -13;
        for (let s = 12; s < len - 10; s += step) {
            const p = trackPoint(main, s), tangent = trackPoint(main, s + 1).sub(p).normalize(), side = new T.Vector3(-tangent.z, 0, tangent.x);
            const back = p.clone().addScaledVector(side, -8);
            if (name === 'town' || name === 'harbor' || name === 'shoulder') {
                this.box([back.x, (back.y + foundationFloor) / 2, back.z], [8, back.y - foundationFloor, 8], C.stone, group, false);
                const house = this.house(back.x, back.y, back.z, name === 'town' ? 1.5 : 1.05, group);
                house.rotation.y = Math.atan2(tangent.z, tangent.x) * -1;
            }
            else if (name === 'gardens') {
                this.box([back.x, back.y - .15, back.z], [9, .3, 6], C.wood, group, false);
                for (let i = 0; i < 4; i++)
                    for (let j = 0; j < 3; j++)
                        this.rock([back.x - 3 + i * 2, back.y + .5, back.z - 2 + j * 2], [.75, .55, .65], C.moss, group);
            }
            else
                this.rock([back.x, back.y + 1, back.z], [4, 4 + s % 5, 3], C.pale, group, 1);
            if (Math.floor(s / step) % 3 === 0)
                this.flag(p.x, p.y, p.z - 2, group);
            if (name !== 'coast' && s > 30) {
                const tree = p.clone().addScaledVector(side, -13);
                this.beam(tree, tree.clone().add(new T.Vector3(0, 8, 0)), .45, C.wood, group);
                for (const [x, y, z, r] of [[-2, 7, 0, 3], [2, 8, -1, 3.4], [0, 10, 0, 3.3]])
                    this.rock([tree.x + x, tree.y + y, tree.z + z], [r, r * .8, r * .85], C.moss, group);
            }
        }
        if (name === 'harbor') {
            for (let s = 24; s < this.trackLength('quay'); s += 47) {
                const p = trackPoint('quay', s);
                this.house(p.x, p.y, p.z - 8, 1.2, group);
            }
        }
        if (name === 'coast') {
            for (const s of [125, 310, 520]) {
                const p = trackPoint(main, s), arch = this.mesh(new T.TorusGeometry(9, 2.6, 12, 24, Math.PI), C.stone, group, false);
                arch.position.copy(p).add(new T.Vector3(0, 0, -5));
            }
        }
        if (name === 'heights') {
            for (const s of [100, 340]) {
                const p = trackPoint(main, s);
                this.mesh(new T.CylinderGeometry(2.5, 3.5, 15, 20), C.wall, group, false).position.copy(p).add(new T.Vector3(0, 7.5, -8));
                const hub = p.clone().add(new T.Vector3(0, 13, -4));
                for (let i = 0; i < 4; i++) {
                    const angle = i * Math.PI / 2 + .4;
                    this.beam(hub, hub.clone().add(new T.Vector3(Math.cos(angle) * 8, Math.sin(angle) * 8, 0)), .35, C.wood, group);
                }
            }
        }
        const labels: T.Texture[] = [];
        group.userData.labels = labels;
        for (const passage of config.passages.filter(p => config.tracks[p.track as TrackName].region === name)) {
            const p = trackPoint(passage.track, passage.s), tangent = trackPoint(passage.track, Math.min(passage.s + 1, this.trackLength(passage.track))).sub(trackPoint(passage.track, Math.max(0, passage.s - 1))).normalize(), side = new T.Vector3(-tangent.z, 0, tangent.x);
            p.addScaledVector(side, -3.3);
            this.beam(p, p.clone().add(new T.Vector3(0, 3, 0)), .11, C.wood, group);
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
            labels.push(texture);
            const sign = new T.Mesh(new T.PlaneGeometry(4, 1), new T.MeshBasicMaterial({ map: texture, side: T.DoubleSide }));
            sign.position.copy(p).addScaledVector(side, .16).add(new T.Vector3(0, 2.7, 0));
            sign.rotation.y = -Math.atan2(tangent.z, tangent.x);
            group.add(sign);
        }
        this.bake(group, new Set<T.Object3D>([...this.flags, ...this.roads.values()]));
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
            vertexShader: `uniform float time;uniform float sea;varying vec3 w;varying float wave;void main(){vec3 p=position;wave=sin(p.x*.072+time*.7)*.42+sin(p.z*.1+time*.91)*.27; p.y=sea+wave;w=p;gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);}`,
            fragmentShader: `uniform float time;uniform vec3 hand;varying vec3 w;varying float wave;void main(){vec3 dark=vec3(.13,.43,.53),light=vec3(.27,.67,.70);float height=sin(w.x*.072+time*.7)*.42+sin(w.z*.1+time*.91)*.27;float band=smoothstep(-.2,.18,height);vec3 col=mix(dark,light,band);float crest=smoothstep(.48,.61,height);float rings=abs(sin(length(w.xz-hand.xz)*.72-time*1.8));float nearHand=1.-smoothstep(11.,25.,distance(w.xz,hand.xz));float foam=crest*.65+nearHand*smoothstep(.93,.995,rings)*.65;col=mix(col,vec3(.86,.96,.86),clamp(foam,0.,.85));float fog=1.-exp(-distance(w,cameraPosition)*.0018);gl_FragColor=vec4(mix(col,vec3(.70,.85,.86),fog),1.);}` });
        const water = new T.Mesh(geometry, material);
        this.scene.add(water);
        return water;
    }
    private makeClouds() {
        const shape = new T.Shape();
        shape.moveTo(-24, 0);
        shape.bezierCurveTo(-30, 0, -31, 8, -24, 10);
        shape.bezierCurveTo(-25, 20, -12, 22, -8, 15);
        shape.bezierCurveTo(-3, 26, 15, 24, 16, 13);
        shape.bezierCurveTo(28, 17, 34, 5, 28, 1);
        shape.quadraticCurveTo(5, -4, -24, 0);
        const geometry = new T.ExtrudeGeometry(shape, { depth: 7, bevelEnabled: true, bevelSize: 2, bevelThickness: 3, bevelSegments: 5, curveSegments: 10, steps: 1 }), uv = geometry.attributes.uv;
        for (let i = 0; i < uv.count; i++)
            uv.setXY(i, uv.getX(i) / 55, uv.getY(i) / 30);
        const material = new T.MeshBasicMaterial({ color: 0xf4f3e7, map: this.texture('handpainted-cloud'), fog: true });
        for (let i = 0; i < 14; i++) {
            const cloud = new T.Mesh(geometry, material);
            cloud.position.set(-370 + i * 70, 50 + (i % 3) * 21, -290 - i % 4 * 42);
            cloud.scale.set(1 + i % 3 * .28, .7 + i % 2 * .3, 1);
            this.scene.add(cloud);
        }
    }
    private fit() { const w = this.host.clientWidth, h = this.host.clientHeight; if (!w || !h)
        return; this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.renderer.setSize(w, h); }
    setLow(low: boolean) { this.low = low; this.renderer.setPixelRatio(low ? .7 : Math.min(devicePixelRatio, 1.5)); this.fit(); this.water.geometry.dispose(); this.water.geometry = new T.PlaneGeometry(2600, 2600, low ? 40 : 120, low ? 40 : 120); this.water.geometry.rotateX(-Math.PI / 2); this.frames = []; this.renders = []; this.curtains.forEach((m, i) => m.visible = !low || i % 2 === 0); }
    setMuted(muted: boolean) { this.sound.setMuted(muted); }
    rotateCamera() { this.orbit = (this.orbit + 1) % 3; }
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
            texture.dispose();
        const actions = (this.manifest.appearanceCatalog && player.appearance ? composeAppearance(this.manifest.appearanceCatalog, player.appearance, player.equipped ?? []) : undefined) ?? this.manifest.avatar.actions;
        const textures = new Map<Frame, T.CanvasTexture>();
        const sprite = old?.sprite ?? new T.Sprite(new T.SpriteMaterial({ transparent: true, alphaTest: .12, depthWrite: true }));
        sprite.center.set(.5, 20 / 128);
        sprite.scale.set(3.52, 3.52, 1);
        sprite.visible = false;
        this.scene.add(sprite);
        const actor = { sprite, actions, textures, key };
        this.actorSprites.set(player.id, actor);
        try {
            for (const action of ['stand', 'walk', 'jump', 'attack'] as const) {
                for (const frame of actions[action]) {
                    if (textures.has(frame))
                        continue;
                    const parts = await Promise.all(frame.parts.map(async (p) => ({ p, image: await loadImage(p.url) })));
                    if (this.disposed || this.actorSprites.get(player.id) !== actor)
                        return;
                    const canvas = document.createElement('canvas');
                    canvas.width = 128;
                    canvas.height = 128;
                    const ctx = canvas.getContext('2d')!;
                    for (const { p, image } of parts)
                        ctx.drawImage(image, 64 + p.x, 108 + p.y);
                    const t = new T.CanvasTexture(canvas);
                    t.colorSpace = T.SRGBColorSpace;
                    t.magFilter = T.NearestFilter;
                    textures.set(frame, t);
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
        this.distantVillage.visible = latest.region !== 'shoulder';
        const old = this.previous ?? latest;
        const f = T.MathUtils.clamp((now - this.received) / 50, 0, 1);
        const coherent = latest.frame.revision - old.frame.revision < 40;
        const t = coherent ? f : 1;
        const seconds = lerp(old.seconds, latest.seconds, t);
        const frame = { ...latest.frame, position: v(old.frame.position).lerp(v(latest.frame.position), t).toArray() as Vec3, yaw: lerp(old.frame.yaw, latest.frame.yaw, t) };
        this.giant.position.copy(v(frame.position));
        this.giant.rotation.y = frame.yaw;
        const rise = smooth((seconds - 30) / 35);
        this.hand.position.set(-205, -22 + 167 * (1 - rise), 60);
        if (this.arm) {
            const a = v([-91, -12, 22]), b = this.hand.position.clone().add(new T.Vector3(0, -6, 0));
            this.arm.position.copy(a).add(b).multiplyScalar(.5);
            this.arm.scale.y = a.distanceTo(b) / Math.sqrt(114 ** 2 + 16 ** 2 + 38 ** 2);
            this.arm.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), b.clone().sub(a).normalize());
        }
        this.water.material.uniforms.sea.value = latest.seaLevel;
        this.water.material.uniforms.time.value = seconds;
        this.water.material.uniforms.hand.value.copy(this.hand.getWorldPosition(new T.Vector3()));
        const draining = rise > .05 && rise < .98;
        for (let i = 0; i < this.curtains.length; i++) {
            const m = this.curtains[i];
            const height = draining ? Math.min(40, 8 + rise * 30) : .01;
            m.scale.y = height;
            m.position.y = -height / 2 - 1;
            m.visible = draining && (!this.low || i % 2 === 0);
        }
        this.bridge.rotation.z = (1 - smooth((latest.bridgeAge ?? 0) / 1.5)) * Math.PI * .46;
        this.vine.visible = latest.region === 'harbor' && latest.bridgeAge === null;
        this.bridge.visible = latest.region === 'harbor';
        this.winch.visible = latest.region === 'harbor';
        this.winch.rotation.z = -(latest.bridgeAge ?? 0) * 3;
        if (this.bridgeRope) {
            this.bridge.updateWorldMatrix(true, false);
            const a = this.winch.position.clone(), b = this.bridge.localToWorld(v([trackPoint('harbor', 57.7).x - this.bridge.position.x, 0, -1.4]));
            this.bridgeRope.position.copy(a).add(b).multiplyScalar(.5);
            this.bridgeRope.scale.y = a.distanceTo(b) / Math.hypot(5.5, 4.4, -1.3);
            this.bridgeRope.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), b.sub(a).normalize());
        }
        for (const bucket of this.buckets)
            bucket.rotation.z = Math.sin(seconds * 44) * .025 * Math.exp(-((seconds + 31) % 3.1) * 8);
        for (const flag of this.flags) {
            const a = flag.geometry.attributes.position;
            for (let i = 0; i < a.count; i++)
                a.setZ(i, Math.sin(a.getX(i) * 1.8 + seconds * 3) * .22);
            a.needsUpdate = true;
        }
        for (let i = 0; i < latest.stones.length; i++) {
            const b = latest.stones[i], before = old.stones[i] ?? b;
            const p = v(before.position).lerp(v(b.position), t);
            this.stones[i].visible = latest.region === 'harbor';
            this.stones[i].position.copy(p).add(new T.Vector3(0, Math.abs(Math.sin(seconds * (i ? 2 : 10))) * (i ? .15 : .2), -2.7));
            this.stones[i].rotation.z = Math.sin(seconds * (i ? 2 : 10)) * .04;
        }
        latest.people.forEach((p, i) => {
            const before = old.people[i] ?? p;
            const q = worldPoint({ ...p, s: lerp(before.s, p.s, t) }, frame), sprite = this.people[i];
            sprite.visible = latest.region === 'harbor' && !!sprite.material.map;
            sprite.position.copy(q);
            sprite.material.rotation = p.grounded ? 0 : .04;
            if (i < 5) {
                const holding = i === 0 && p.track === 'harbor' && p.s > 43 && p.s < 47 && !latest.bridgeOpen;
                sprite.center.y = holding ? 64 / 1536 : 48 / 1536;
                const map = holding ? this.winchFrame : Math.abs(p.speed) > .15 ? this.workerFrames[[1, 0, 2, 0][Math.floor(seconds * 7 + i) % 4]] : this.workerFrames[0];
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
            const same = before.track === b.track && before.grounded === b.grounded;
            let pos = same && b.grounded ? worldPoint({ ...b, s: lerp(before.s, b.s, t) }, frame) : v(before.position).lerp(v(b.position), same ? t : 1);
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
            const action = actor.attacking ? 'attack' : !b.grounded ? 'jump' : Math.abs(b.speed) > .15 ? 'walk' : 'stand';
            const frames = art.actions[action];
            const chosen = frames[frameAt(frames.map(f => f.delay), seconds * 1000, true)];
            const texture = art.textures.get(chosen);
            if (texture) {
                art.sprite.visible = true;
                art.sprite.material.map = texture;
                art.sprite.material.needsUpdate = true;
                art.sprite.position.copy(pos);
                art.sprite.scale.x = b.facing === 1 ? -3.52 : 3.52;
            }
        }
        for (const [id, a] of this.actorSprites)
            if (!latest.actors.some(p => p.id === id)) {
                this.scene.remove(a.sprite);
                a.sprite.material.dispose();
                for (const texture of a.textures.values())
                    texture.dispose();
                this.actorSprites.delete(id);
            }
        this.sound.update(seconds, latest.bridgeAge, selfBody);
        if (self && selfBody) {
            const region = latest.region as RegionName;
            if (region !== this.activeRegion) {
                this.activeRegion = region;
                this.cameraReady = false;
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
            const length = this.trackLength(selfBody.track), a = trackPoint(selfBody.track, Math.min(selfBody.s + 1, length)), b = trackPoint(selfBody.track, Math.max(0, selfBody.s - 1));
            const tangent = a.sub(b).normalize();
            if (config.tracks[selfBody.track as TrackName].frame !== 'world')
                tangent.applyAxisAngle(new T.Vector3(0, 1, 0), frame.yaw);
            const side = new T.Vector3(-tangent.z, 0, tangent.x);
            let target = self.clone().add(new T.Vector3(0, 2, 0));
            let position = self.clone().addScaledVector(side, 35).add(new T.Vector3(0, 7, 0));
            if (this.orbit)
                position.sub(self).applyAxisAngle(new T.Vector3(0, 1, 0), this.orbit === 1 ? .27 : -.27).add(self);
            const elapsed = this.revealAt ? (now - this.revealAt) / 1000 : 99;
            if (elapsed < this.revealLength) {
                const amount = smooth(elapsed / 4) * (1 - smooth((elapsed - this.revealLength + 4) / 4));
                const outward = smooth((elapsed - 6) / 5);
                const palm = this.hand.getWorldPosition(new T.Vector3());
                const focus = palm.clone().add(new T.Vector3(0, 1, 0)).lerp(new T.Vector3(285, 5 + rise * 30, -35), outward);
                const wide = palm.clone().add(new T.Vector3(-25, 95, 70)).lerp(new T.Vector3(235, 100, 455), outward);
                target.lerp(focus, amount);
                position.lerp(wide, amount);
            }
            const weight = this.cameraReady ? 1 - Math.exp(-Math.min(dt, 100) / 140) : 1;
            this.camera.position.lerp(position, weight);
            if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                const pulse = Math.exp(-((seconds - 3 + 31) % 3.1) * 8);
                const heavy = seconds > 30 && seconds < 65 ? .08 : latest.stones[1] && Math.abs(latest.stones[1].position[0] - self.x) < 25 ? .025 : 0;
                this.camera.position.y += Math.sin(seconds * 46) * pulse * heavy;
            }
            this.camera.lookAt(target);
            this.cameraReady = true;
            if (now - this.occlusionAt > 180) {
                this.occlusionAt = now;
                const direction = self.clone().add(new T.Vector3(0, .8, 0)).sub(this.camera.position);
                this.sight.set(this.camera.position, direction.clone().normalize());
                this.sight.far = direction.length() - .2;
                for (const [name, road] of this.roads) {
                    if (config.tracks[name as TrackName].region !== region)
                        continue;
                    road.updateWorldMatrix(true, true);
                    const blocks = this.sight.intersectObject(road, true).length > 0;
                    road.traverse(o => { if (o instanceof T.Mesh) {
                        const material = o.material as T.MeshToonMaterial;
                        if (material.transparent !== blocks) {
                            material.transparent = blocks;
                            material.opacity = blocks ? .24 : 1;
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
            if (elapsed < this.revealLength)
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
                line = seconds < 65 ? '高台可以安全停留。海中的石纹正在离开水面。' : '手掌停稳了。可以登上去，也可以再看一会儿。';
            this.status(line);
        }
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
    destroy() { this.disposed = true; this.renderer.domElement.removeEventListener('pointerup',this.onPointer); this.sound.destroy(); cancelAnimationFrame(this.request); this.resize.disconnect(); this.scene.traverse(o => { if (o instanceof T.Mesh || o instanceof T.LineSegments) {
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material])
            m.dispose();
    }
    else if (o instanceof T.Sprite)
        o.material.dispose(); }); for (const group of this.districts.values())
        for (const t of group.userData.labels ?? [])
            t.dispose(); for (const a of this.actorSprites.values())
        for (const t of a.textures.values())
            t.dispose(); this.assets.forEach(t => t.dispose()); images.clear(); this.renderer.dispose(); this.renderer.forceContextLoss(); this.renderer.domElement.remove(); }
}
