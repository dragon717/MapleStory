import * as T from 'three';
import type { EnvironmentSettings } from './environment-settings';

export type SnowCover = { amount: number; depth: number; fall: number };
export const EMPTY_SNOW: SnowCover = { amount: 0, depth: 0, fall: 0 };

/** Display-only metres of snow: winter snowfall builds it, winter clearing preserves it. */
export function advanceSnowCover(previous: SnowCover, settings: EnvironmentSettings, seconds: number): SnowCover {
  const dt = Number.isFinite(seconds) ? Math.max(0, Math.min(seconds, 1)) : 0;
  const falling = settings.season === 'winter' && settings.weather === 'snow';
  const rate = falling ? 1 / 45 : settings.season === 'winter' ? 0 : -1 / (settings.season === 'summer' ? 70 : 140);
  const amount = T.MathUtils.clamp(previous.amount + rate * dt, 0, 1);
  return { amount, depth: amount * .18, fall: previous.fall + (falling ? dt * .004 : 0) };
}

const TILE_SIZE = 8, CELLS = 64, TILE_COUNT = 12, CELL_SIZE = TILE_SIZE / CELLS, SIDE = CELLS + 1;
type Foot = { x: number; y: number; z: number };
type Triangle = { a: T.Vector3; b: T.Vector3; c: T.Vector3; top: [number, number, number]; slopeX: number; slopeZ: number };
type Sample = { y: number; top: number; triangle: Triangle };
type Tile = { mesh: T.Mesh; position: T.BufferAttribute; top: T.BufferAttribute; press: T.BufferAttribute; indices: T.BufferAttribute; x: number; z: number; used: number; assigned: boolean };
type Shader = Parameters<T.Material['onBeforeCompile']>[0];

/** Real snow shells plus a fixed cache of small road heightfields; no collision or foot-height changes. */
export class SnowSurface {
  cover: SnowCover = { ...EMPTY_SNOW };
  get amount() { return this.cover.amount; }
  get depth() { return this.cover.depth; }
  private root = new T.Group();
  private shells: T.Mesh[] = [];
  private tiles: Tile[] = [];
  private materials = new Set<T.Material>();
  private bins = new Map<string, Triangle[]>();
  private clock = 0;
  private shadowPending = false;
  private shadowAmount = 0;
  private shadowTime = -Infinity;
  private destroyed = false;
  private layerData = new Float32Array(CELLS * CELLS * TILE_COUNT * 4);
  private layerMap = new T.DataTexture(this.layerData, CELLS, CELLS * TILE_COUNT, T.RGBAFormat, T.FloatType);
  private uniforms = {
    snowAmount: { value: 0 }, snowFall: { value: 0 },
    snowTiles: { value: Array.from({ length: TILE_COUNT }, () => new T.Vector4()) },
    snowLayerMap: { value: this.layerMap },
  };

  /** Construct after LocalReveal and VillageEnvironment so the cloned material retains both hooks. */
  constructor(model: T.Object3D) {
    model.updateMatrixWorld(true);
    this.root.name = 'CE_AccumulatedSnow';
    // Samples and footsteps are world-space; keep them so even when the model has a transform.
    this.root.matrixAutoUpdate = false; this.root.matrix.copy(model.matrixWorld).invert();
    Object.assign(this.layerMap, { minFilter: T.NearestFilter, magFilter: T.NearestFilter, generateMipmaps: false });
    this.layerMap.needsUpdate = true;
    const sources: { mesh: T.Mesh; road: boolean; depth: number }[] = [];
    model.traverseVisible(o => {
      if (!(o instanceof T.Mesh) || o instanceof T.InstancedMesh) return;
      let layer = '', name = '', walkable = false;
      for (let parent: T.Object3D | null = o; parent; parent = parent.parent) {
        if (!layer && parent.userData.layer) layer = parent.userData.layer;
        name += ' ' + parent.name; walkable ||= parent.userData.walkable === true;
      }
      const road = layer === 'roads' && walkable;
      const terrain = layer === 'terrain' && /RollingVillageGround|FrontBank|Cliff/.test(name);
      const roof = layer === 'buildings';
      if (road || terrain || roof) sources.push({ mesh: o, road, depth: road ? .075 : roof ? .18 : .15 });
    });
    let roadSource: T.MeshStandardMaterial | undefined;
    for (const { mesh, road, depth } of sources) {
      const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const groups = mesh.geometry.groups.length ? mesh.geometry.groups : [{ start: 0, count: mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count, materialIndex: 0 }];
      for (const group of groups) {
        const source = sourceMaterials[Array.isArray(mesh.material) ? group.materialIndex ?? 0 : 0];
        if (!(source instanceof T.MeshStandardMaterial)) continue;
        if (!road && depth === .18 && !/CE_(red|orange|yellow|slate|roofSpot)/i.test(source.name)) continue;
        const geometry = this.shellGeometry(mesh, group.start, group.count, depth, road, depth === .18 && /CE_(red|orange|yellow)/i.test(source.name));
        if (!geometry) continue;
        const shell = new T.Mesh(geometry, this.snowMaterial(source, false, road));
        shell.customDepthMaterial = this.depthMaterial(false, road); shell.castShadow = true; shell.receiveShadow = true;
        shell.name = 'CE_Snow_' + mesh.name; shell.visible = false; this.root.add(shell); this.shells.push(shell);
        if (road) roadSource ??= source;
      }
    }
    // ponytail: 12 cached 8m road patches; raise this fixed budget only if visible track eviction matters.
    if (roadSource) {
      const material = this.snowMaterial(roadSource, true, true), depth = this.depthMaterial(true, true);
      for (let i = 0; i < TILE_COUNT; i++) {
        const geometry = new T.BufferGeometry();
        const position = new T.BufferAttribute(new Float32Array(SIDE * SIDE * 3), 3).setUsage(T.DynamicDrawUsage);
        const top = new T.BufferAttribute(new Float32Array(SIDE * SIDE), 1).setUsage(T.DynamicDrawUsage);
        const press = new T.BufferAttribute(new Float32Array(SIDE * SIDE * 2), 2).setUsage(T.DynamicDrawUsage);
        const indices = new T.BufferAttribute(new Uint16Array(CELLS * CELLS * 6), 1).setUsage(T.DynamicDrawUsage);
        geometry.setAttribute('position', position); geometry.setAttribute('snowTop', top); geometry.setAttribute('snowPress', press);
        geometry.setAttribute('normal', new T.BufferAttribute(new Float32Array(SIDE * SIDE * 3), 3));
        geometry.setIndex(indices); geometry.setDrawRange(0, 0);
        const mesh = new T.Mesh(geometry, material); mesh.customDepthMaterial = depth; mesh.castShadow = true; mesh.receiveShadow = true; mesh.visible = false;
        mesh.name = 'CE_SnowTracks_' + i; this.root.add(mesh);
        this.tiles.push({ mesh, position, top, press, indices, x: 0, z: 0, used: 0, assigned: false });
      }
    }
    model.add(this.root);
  }

  private inwardCaps(mesh: T.Mesh, start: number, count: number) {
    const position = mesh.geometry.getAttribute('position'), index = mesh.geometry.index;
    const points: T.Vector3[] = [], parent: number[] = [], welded = new Map<string, number>(), faces: { start: number; ids: number[]; area: number }[] = [];
    const root = (id: number): number => { while (parent[id] !== id) { parent[id] = parent[parent[id]]; id = parent[id]; } return id; };
    const vertex = (id: number) => {
      const p = new T.Vector3().fromBufferAttribute(position, id).applyMatrix4(mesh.matrixWorld), key = `${Math.round(p.x * 10000)},${Math.round(p.y * 10000)},${Math.round(p.z * 10000)}`;
      let n = welded.get(key);
      if (n === undefined) { n = points.length; welded.set(key, n); points.push(p); parent.push(n); }
      return n;
    };
    for (let i = start; i + 2 < Math.min(start + count, index?.count ?? position.count); i += 3) {
      const ids = [0, 1, 2].map(j => vertex(index ? index.getX(i + j) : i + j)), [a, b, c] = ids.map(id => points[id]);
      parent[root(ids[1])] = root(ids[0]); parent[root(ids[2])] = root(ids[0]);
      faces.push({ start: i, ids, area: (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z) });
    }
    const components = new Map<number, { box: T.Box3; down: number; up: number; faces: typeof faces }>();
    for (const face of faces) {
      const id = root(face.ids[0]), component = components.get(id) ?? { box: new T.Box3(), down: 0, up: 0, faces: [] };
      for (const vertex of face.ids) component.box.expandByPoint(points[vertex]);
      component.down += Math.max(0, -face.area); component.up += Math.max(0, face.area); component.faces.push(face); components.set(id, component);
    }
    const reverse = new Set<number>();
    // ponytail: repair known inward domes only; fix export winding if other inverted assets appear.
    // Closed lips/boxes have both orientations; flat undersides and walls have no central summit.
    for (const component of components.values()) {
      if (component.down <= 0 || component.up > component.down * .001) continue;
      const size = component.box.getSize(new T.Vector3()), centre = component.box.getCenter(new T.Vector3());
      if (Math.min(size.x, size.z) < .5 || size.y < Math.min(size.x, size.z) * .08) continue;
      const summit = component.faces.some(face => face.ids.some(id => {
        const p = points[id]; return p.y > component.box.max.y - size.y * .03 && Math.abs(p.x - centre.x) < size.x * .25 && Math.abs(p.z - centre.z) < size.z * .25;
      }));
      if (summit) for (const face of component.faces) reverse.add(face.start);
    }
    return reverse;
  }

  private shellGeometry(mesh: T.Mesh, start: number, count: number, depth: number, road: boolean, cap = false) {
    const source = mesh.geometry, attribute = source.getAttribute('position'), index = source.index;
    const reverse = cap ? this.inwardCaps(mesh, start, count) : undefined;
    const vertices: T.Vector3[] = [], tops: number[] = [], indices: number[] = [], welded = new Map<string, number>(), edges = new Map<string, [number, number, number]>();
    const a = new T.Vector3(), b = new T.Vector3(), c = new T.Vector3(), normal = new T.Vector3(), ab = new T.Vector3(), ac = new T.Vector3();
    const vertex = (p: T.Vector3, top: number) => {
      const key = `${Math.round(p.x * 10000)},${Math.round(p.y * 10000)},${Math.round(p.z * 10000)}`;
      let id = welded.get(key);
      if (id === undefined) { id = vertices.length; welded.set(key, id); vertices.push(p.clone()); tops.push(top); }
      else tops[id] = Math.max(tops[id], top);
      return id;
    };
    for (let i = start; i + 2 < Math.min(start + count, index?.count ?? attribute.count); i += 3) {
      a.fromBufferAttribute(attribute, index ? index.getX(i) : i).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(attribute, index ? index.getX(i + 1) : i + 1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(attribute, index ? index.getX(i + 2) : i + 2).applyMatrix4(mesh.matrixWorld);
      normal.crossVectors(ab.copy(b).sub(a), ac.copy(c).sub(a)).normalize();
      if (reverse?.has(i)) { const old = b.clone(); b.copy(c); c.copy(old); normal.negate(); }
      if (normal.y < .38) continue;
      const thickness = depth * T.MathUtils.smoothstep(normal.y, .38, .85);
      const ids = [a, b, c].map(p => vertex(p, thickness * (.82 + .18 * Math.sin(p.x * .71 + p.z * .38) ** 2)));
      indices.push(...ids);
      for (let j = 0; j < 3; j++) { const v = ids[j], w = ids[(j + 1) % 3], key = `${Math.min(v, w)},${Math.max(v, w)}`, edge = edges.get(key); if (edge) edge[2]++; else edges.set(key, [v, w, 1]); }
    }
    if (!indices.length) return;
    if (road) for (let i = 0; i < indices.length; i += 3) {
      const ids = indices.slice(i, i + 3), [a, b, c] = ids.map(id => vertices[id]);
      normal.crossVectors(ab.copy(b).sub(a), ac.copy(c).sub(a)).normalize();
      const triangle: Triangle = { a, b, c, top: ids.map(id => tops[id]) as [number, number, number], slopeX: -normal.x / normal.y, slopeZ: -normal.z / normal.y };
      for (let x = Math.floor(Math.min(a.x, b.x, c.x) / 2); x <= Math.floor(Math.max(a.x, b.x, c.x) / 2); x++) for (let z = Math.floor(Math.min(a.z, b.z, c.z) / 2); z <= Math.floor(Math.max(a.z, b.z, c.z) / 2); z++) {
        const key = `${x},${z}`, bin = this.bins.get(key) ?? []; bin.push(triangle); this.bins.set(key, bin);
      }
    }
    // Close the snow edge down to its supporting surface: eaves and road edges have actual thickness.
    for (const [a, b, count] of edges.values()) if (count === 1) {
      const low = vertices.length; vertices.push(vertices[a].clone(), vertices[b].clone()); tops.push(0, 0);
      indices.push(a, low, low + 1, a, low + 1, b);
    }
    const geometry = new T.BufferGeometry();
    geometry.setAttribute('position', new T.BufferAttribute(new Float32Array(vertices.flatMap(p => [p.x, p.y, p.z])), 3));
    geometry.setAttribute('snowTop', new T.BufferAttribute(new Float32Array(tops), 1));
    geometry.setAttribute('snowPress', new T.BufferAttribute(new Float32Array(vertices.length * 2), 2));
    geometry.setIndex(indices); geometry.computeVertexNormals(); geometry.computeBoundingSphere();
    // The shader adds at most 18cm plus a small compressed rim.
    geometry.boundingSphere!.radius += .22;
    return geometry;
  }

  private patchShader(shader: Shader, local: boolean, road: boolean) {
    Object.assign(shader.uniforms, this.uniforms);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
uniform float snowAmount,snowFall;attribute float snowTop;attribute vec2 snowPress;
varying vec3 snowBasePosition,snowViewPosition;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
snowBasePosition=(modelMatrix*vec4(position,1.)).xyz;
float snowIndent=sign(snowPress.x)*max(0.,abs(snowPress.x)-max(0.,snowFall-snowPress.y));
transformed.y+=snowTop>0.?max(.001,snowTop*snowAmount-snowIndent):0.;`)
      .replace('#include <project_vertex>', '#include <project_vertex>\nsnowViewPosition=mvPosition.xyz;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
uniform float snowAmount;varying vec3 snowBasePosition,snowViewPosition;
float snowHash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float snowNoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(snowHash(i),snowHash(i+vec2(1,0)),f.x),mix(snowHash(i+vec2(0,1)),snowHash(i+vec2(1,1)),f.x),f.y);}
${road && !local ? `uniform vec4 snowTiles[${TILE_COUNT}];uniform sampler2D snowLayerMap;` : ''}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
if(snowAmount<.6&&snowNoise(snowBasePosition.xz*2.)>smoothstep(0.,.6,snowAmount))discard;
${road && !local ? `for(int i=0;i<${TILE_COUNT};i++){
 vec2 p=(snowBasePosition.xz-snowTiles[i].xy)/${TILE_SIZE}.;
 if(snowTiles[i].z>.5&&p.x>=0.&&p.y>=0.&&p.x<1.&&p.y<1.){
  vec4 layer=texture2D(snowLayerMap,vec2(p.x,(float(i)+p.y)/${TILE_COUNT}.));
  vec2 cellOffset=(fract(p*${CELLS}.)-.5)*${CELL_SIZE};
  float layerHeight=layer.x+dot(cellOffset,layer.yz);
  if(layer.w>.5&&abs(layerHeight-snowBasePosition.y)<.025)discard;
 }
}` : ''}`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
normal=normalize(cross(dFdx(snowViewPosition),dFdy(snowViewPosition)));`)
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb*=.95+.05*snowNoise(snowBasePosition.xz*95.);');
  }

  private snowMaterial(source: T.MeshStandardMaterial, local: boolean, road: boolean) {
    const material = source.clone(), previous = source.onBeforeCompile.bind(source), key = source.customProgramCacheKey.bind(source);
    material.color.setRGB(.91, .95, 1); material.roughness = .94; material.metalness = 0; material.emissive.setRGB(0, 0, 0);
    material.map = material.normalMap = material.bumpMap = material.roughnessMap = material.metalnessMap = material.aoMap = material.emissiveMap = material.alphaMap = material.displacementMap = null;
    material.transparent = false; material.opacity = 1;
    material.customProgramCacheKey = () => key() + `-snow-v1-${local}-${road}`;
    material.onBeforeCompile = (shader, renderer) => { previous(shader, renderer); this.patchShader(shader, local, road); };
    this.materials.add(material); return material;
  }

  private depthMaterial(local: boolean, road: boolean) {
    const material = new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking });
    material.customProgramCacheKey = () => `snow-depth-v1-${local}-${road}`;
    material.onBeforeCompile = shader => this.patchShader(shader, local, road);
    this.materials.add(material); return material;
  }

  private sample(x: number, z: number, y: number, tolerance = .45): Sample | undefined {
    let result: Sample | undefined, closest = tolerance;
    for (const triangle of this.bins.get(`${Math.floor(x / 2)},${Math.floor(z / 2)}`) ?? []) {
      const { a, b, c } = triangle, d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
      if (Math.abs(d) < 1e-8) continue;
      const u = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / d;
      const v = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / d, w = 1 - u - v;
      if (Math.min(u, v, w) < -1e-5) continue;
      const height = u * a.y + v * b.y + w * c.y, gap = Math.abs(height - y);
      if (gap < closest || result && gap < closest + .025 && height > result.y) {
        closest = Math.min(closest, gap); result = { y: height, top: u * triangle.top[0] + v * triangle.top[1] + w * triangle.top[2], triangle };
      }
    }
    return result;
  }

  private tile(x: number, z: number, foot: Foot, reference: Sample) {
    let tile = this.tiles.find(t => {
      if (!t.assigned || t.x !== x || t.z !== z) return false;
      const height = this.tileHeight(t, foot.x, foot.z);
      return height !== undefined && Math.abs(height - reference.y) < .025;
    });
    if (tile) { tile.used = ++this.clock; return tile; }
    tile = this.tiles.reduce((old, next) => !next.assigned || next.used < old.used ? next : old);
    tile.x = x; tile.z = z; tile.assigned = true; tile.used = ++this.clock;
    const slot = this.tiles.indexOf(tile), valid = new Uint8Array(SIDE * SIDE);
    const positions = tile.position.array as Float32Array, tops = tile.top.array as Float32Array;
    (tile.press.array as Float32Array).fill(0);
    for (let j = 0; j < SIDE; j++) for (let i = 0; i < SIDE; i++) {
      const n = j * SIDE + i, wx = x + i * CELL_SIZE, wz = z + j * CELL_SIZE;
      const predicted = reference.y + reference.triangle.slopeX * (wx - foot.x) + reference.triangle.slopeZ * (wz - foot.z);
      const sample = this.sample(wx, wz, predicted);
      positions.set([wx, sample?.y ?? predicted, wz], n * 3); tops[n] = sample?.top ?? 0; valid[n] = sample ? 1 : 0;
    }
    const indices = tile.indices.array as Uint16Array; let count = 0;
    for (let j = 0; j < CELLS; j++) for (let i = 0; i < CELLS; i++) {
      const a = j * SIDE + i, b = a + 1, c = a + SIDE, d = c + 1, covered = valid[a] && valid[b] && valid[c] && valid[d];
      const cell = (slot * CELLS * CELLS + j * CELLS + i) * 4, ya = positions[a * 3 + 1], yb = positions[b * 3 + 1], yc = positions[c * 3 + 1], yd = positions[d * 3 + 1];
      this.layerData.set([(ya + yb + yc + yd) / 4, (yb - ya + yd - yc) / (2 * CELL_SIZE), (yc - ya + yd - yb) / (2 * CELL_SIZE), covered ? 1 : 0], cell);
      if (covered) { indices.set([a, c, b, b, c, d], count); count += 6; }
    }
    tile.mesh.geometry.setDrawRange(0, count); tile.mesh.geometry.computeVertexNormals(); tile.mesh.geometry.computeBoundingSphere(); tile.mesh.geometry.boundingSphere!.radius += .22;
    tile.position.needsUpdate = tile.top.needsUpdate = tile.press.needsUpdate = tile.indices.needsUpdate = true;
    this.uniforms.snowTiles.value[slot].set(x, z, 1, 0); this.layerMap.needsUpdate = true; tile.mesh.visible = this.amount > .003; this.shadowPending = true;
    return tile;
  }

  private tileHeight(tile: Tile, x: number, z: number) {
    const px = (x - tile.x) / CELL_SIZE, pz = (z - tile.z) / CELL_SIZE;
    if (px < 0 || pz < 0 || px > CELLS || pz > CELLS) return;
    const i = Math.min(CELLS - 1, Math.floor(px)), j = Math.min(CELLS - 1, Math.floor(pz)), a = j * SIDE + i, b = a + 1, c = a + SIDE, d = c + 1;
    if ([a, b, c, d].some(n => tile.top.getX(n) <= 0)) return;
    const u = px - i, v = pz - j, ya = tile.position.getY(a), yb = tile.position.getY(b), yc = tile.position.getY(c), yd = tile.position.getY(d);
    return u + v <= 1 ? ya + (yb - ya) * u + (yc - ya) * v : yd + (yc - yd) * (1 - u) + (yb - yd) * (1 - v);
  }

  /** The supplied point is the actual left/right shoe (or mount contact), already offset by the caller. */
  stamp(foot: Foot, direction: { x: number; z: number }, mount = false) {
    if (this.destroyed || this.amount < .015 || !this.tiles.length || ![foot.x, foot.y, foot.z, direction.x, direction.z].every(Number.isFinite)) return false;
    const reference = this.sample(foot.x, foot.z, foot.y, .18); if (!reference) return false;
    const length = Math.hypot(direction.x, direction.z), ux = length > 1e-5 ? direction.x / length : 1, uz = length > 1e-5 ? direction.z / length : 0;
    const along = mount ? .46 : .29, across = mount ? .28 : .16, radius = along * 1.35;
    let changed = false;
    for (let tx = Math.floor((foot.x - radius) / TILE_SIZE); tx <= Math.floor((foot.x + radius) / TILE_SIZE); tx++) for (let tz = Math.floor((foot.z - radius) / TILE_SIZE); tz <= Math.floor((foot.z + radius) / TILE_SIZE); tz++) {
      // Use a point inside this tile when stamping across a tile boundary.
      const anchor = { x: T.MathUtils.clamp(foot.x, tx * TILE_SIZE + .001, (tx + 1) * TILE_SIZE - .001), y: foot.y, z: T.MathUtils.clamp(foot.z, tz * TILE_SIZE + .001, (tz + 1) * TILE_SIZE - .001) };
      anchor.y = reference.y + reference.triangle.slopeX * (anchor.x - foot.x) + reference.triangle.slopeZ * (anchor.z - foot.z);
      const tile = this.tile(tx * TILE_SIZE, tz * TILE_SIZE, anchor, { ...reference, y: anchor.y });
      const press = tile.press.array as Float32Array;
      const firstX = Math.max(0, Math.floor((foot.x - radius - tile.x) / CELL_SIZE)), lastX = Math.min(CELLS, Math.ceil((foot.x + radius - tile.x) / CELL_SIZE));
      const firstZ = Math.max(0, Math.floor((foot.z - radius - tile.z) / CELL_SIZE)), lastZ = Math.min(CELLS, Math.ceil((foot.z + radius - tile.z) / CELL_SIZE));
      let first = SIDE * SIDE, last = -1;
      for (let j = firstZ; j <= lastZ; j++) for (let i = firstX; i <= lastX; i++) {
        const n = j * SIDE + i, dx = tile.x + i * CELL_SIZE - foot.x, dz = tile.z + j * CELL_SIZE - foot.z;
        const expected = reference.y + reference.triangle.slopeX * dx + reference.triangle.slopeZ * dz;
        if (tile.top.getX(n) <= 0 || Math.abs(tile.position.getY(n) - expected) > .04) continue;
        const r = Math.hypot((dx * ux + dz * uz) / along, (dz * ux - dx * uz) / across); if (r > 1.3) continue;
        const top = tile.top.getX(n) * this.amount;
        const target = r < 1 ? top * .96 * (1 - T.MathUtils.smoothstep(r, .55, 1)) : -top * .12 * Math.sin((r - 1) / .3 * Math.PI);
        const previous = Math.sign(press[n * 2]) * Math.max(0, Math.abs(press[n * 2]) - Math.max(0, this.cover.fall - press[n * 2 + 1]));
        // A shoe can deepen an old depression; its rim cannot refill a neighbour's print.
        const value = target > 0 ? Math.max(previous, target) : previous > 0 ? previous : Math.min(previous, target);
        if (Math.abs(value - previous) < 1e-5) continue;
        press[n * 2] = value; press[n * 2 + 1] = this.cover.fall; first = Math.min(first, n); last = Math.max(last, n); changed = true;
      }
      if (last >= first) { tile.press.addUpdateRange(first * 2, (last - first + 1) * 2); tile.press.needsUpdate = true; }
    }
    this.shadowPending ||= changed; return changed;
  }

  /** True requests a cached shadow redraw, capped at 2.5Hz while snow or footprints change. */
  update(settings: EnvironmentSettings, deltaSeconds: number, time: number) {
    if (this.destroyed) return false;
    const previous = this.cover.amount; this.cover = advanceSnowCover(this.cover, settings, deltaSeconds);
    this.uniforms.snowAmount.value = this.amount; this.uniforms.snowFall.value = this.cover.fall;
    for (const shell of this.shells) shell.visible = this.amount > .003;
    for (const tile of this.tiles) tile.mesh.visible = tile.assigned && this.amount > .003;
    if (previous > 0 && this.amount === 0) for (const tile of this.tiles) { (tile.press.array as Float32Array).fill(0); tile.press.needsUpdate = true; }
    this.shadowPending ||= Math.abs(this.amount - this.shadowAmount) >= .025 || previous > .003 && this.amount <= .003 || previous <= .003 && this.amount > .003;
    if (this.shadowPending && Number.isFinite(time) && time - this.shadowTime >= .4) {
      this.shadowPending = false; this.shadowTime = time; this.shadowAmount = this.amount; return true;
    }
    return false;
  }

  destroy() {
    if (this.destroyed) return; this.destroyed = true; this.root.removeFromParent();
    for (const mesh of [...this.shells, ...this.tiles.map(t => t.mesh)]) mesh.geometry.dispose();
    this.materials.forEach(material => material.dispose()); this.layerMap.dispose(); this.root.clear();
    this.shells.length = this.tiles.length = 0; this.materials.clear(); this.bins.clear();
  }
}
