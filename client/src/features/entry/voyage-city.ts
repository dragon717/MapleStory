import * as T from 'three';

type Point = [number, number, number];
type Island = { id: string; motionPeriod: number; motionPhase: number };
type Node = { id: string; islandWeights: Record<string, number> };
type Link = { id: string; start: string; end: string; points: Point[]; surface: string };
type Layout = { nodes: Node[]; edges: Link[]; physicalLinks: Link[]; landscape: {
  islands: Island[]; motion: { commonAmplitude: number; commonPeriod: number; localAmplitude: number };
} };

export function islandOffset(s: Island, time: number, energy: number, config: Layout['landscape']['motion']) {
  return energy * (config.commonAmplitude * Math.sin(time * 2 * Math.PI / config.commonPeriod)
    + config.localAmplitude * Math.sin(time * 2 * Math.PI / s.motionPeriod + s.motionPhase));
}

/** Authored city coordinates stay local to its placement; only the preview geometry moves. */
export class VoyageCity {
  readonly layout: Layout;
  private groups = new Map<string, T.Group>();
  private pads: { object: T.Object3D; y: number; id: string }[] = [];
  private offsets = new Map<string, number>();
  private deformed: { mesh: T.Mesh; rest: Float32Array; u: Float32Array; link: Link; axis: T.Vector3; windAxis: T.Vector3 }[] = [];
  private time = 0;
  private glowTime = { value: 0 };
  nodeOffset(id: string) { return this.offsets.get(id) ?? 0; }
  islandRoot(id: string) { return this.groups.get(id); }
  snowMotion(mesh:T.Mesh) {
    let owner:T.Object3D|null=mesh;
    while(owner&&!owner.userData.edge_id&&!owner.userData.motion_node&&!owner.userData.island_binding)owner=owner.parent;
    const data=owner?.userData??{},link=this.layout.edges.find(e=>e.id===data.edge_id);
    if (link) {
      // Shell and track X/Z stay authored; cache their fixed road weights, not dynamic heights.
      const weights = new Map<string, number>();
      return (p:T.Vector3) => {
        const key = `${p.x},${p.z}`;
        let t = weights.get(key);
        if (t === undefined) { t = this.fraction(p, link.points); weights.set(key, t); }
        return this.nodeOffset(link.start) * (1-t) + this.nodeOffset(link.end) * t;
      };
    }
    if(data.motion_node)return (_p:T.Vector3)=>this.nodeOffset(data.motion_node);
    return (_p:T.Vector3)=>this.groups.get(data.island_binding)?.position.y??0;
  }
  status() { return { motionTime: this.time, islandOffsets: Object.fromEntries([...this.groups].map(([id, group]) => [id, group.position.y])), dynamicMeshes: this.deformed.length }; }
  constructor(readonly root: T.Group) {
    this.layout = JSON.parse(root.userData.spatial_layout) as Layout;
    const { layout } = this, edges = new Map(layout.edges.map(e => [e.id, e])), links = new Map(layout.physicalLinks.map(e => [e.id, e]));
    root.updateWorldMatrix(true, true);
    for (const spec of layout.landscape.islands) { const group = new T.Group(); root.add(group); this.groups.set(spec.id, group); }
    const objects: T.Object3D[] = []; root.traverse(o => objects.push(o));
    for (const object of objects) {
      const p = object.userData;
      if (p.edge_id || p.support_edge || p.bridge_edge) this.bind(object, edges.get(p.edge_id || p.support_edge) ?? links.get(p.bridge_edge)!);
      else if (p.motion_node) this.pads.push({ object, y: object.position.y, id: p.motion_node });
      else if (p.island_binding) this.groups.get(p.island_binding)?.attach(object);
    }
    this.batchPlants();
    this.update(0, true);
  }
  private fraction(point: T.Vector3, points: Point[]) {
    let best = Infinity, fraction = 0, distance = 0;
    const lengths = points.slice(1).map((b, i) => Math.hypot(b[0] - points[i][0], b[2] - points[i][2])), total = lengths.reduce((a, b) => a + b, 0);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], dx = b[0] - a[0], dz = b[2] - a[2], run = lengths[i - 1];
      const t = run ? T.MathUtils.clamp(((point.x - a[0]) * dx + (point.z - a[2]) * dz) / (run * run), 0, 1) : 0;
      const d = (point.x - a[0] - t * dx) ** 2 + (point.z - a[2] - t * dz) ** 2;
      if (d < best) { best = d; fraction = (distance + t * run) / (total || 1); }
      distance += run;
    }
    return fraction;
  }
  private bind(object: T.Object3D, link: Link) {
    if (!link) throw Error('City road has no authored motion link');
    const inverseRoot = this.root.matrixWorld.clone().invert();
    object.traverse(o => {
      if (!(o instanceof T.Mesh)) return;
      o.geometry = o.geometry.clone();
      const positions = o.geometry.getAttribute('position') as T.BufferAttribute;
      positions.setUsage(T.DynamicDrawUsage);
      const rest = new Float32Array(positions.array), u = new Float32Array(positions.count);
      const relative = inverseRoot.clone().multiply(o.matrixWorld), inverse = relative.clone().invert();
      for (let i = 0; i < u.length; i++) u[i] = this.fraction(new T.Vector3().fromArray(rest, i * 3).applyMatrix4(relative), link.points);
      o.frustumCulled = false;
      this.deformed.push({ mesh: o, rest, u, link, axis: new T.Vector3(0, 1, 0).transformDirection(inverse), windAxis: new T.Vector3(1, 0, 0).transformDirection(inverse) });
      if (object.userData.rainbow_bridge) {
        o.geometry.setAttribute('bridgeT', new T.BufferAttribute(u, 1));
        const materials: T.Material[] = Array.isArray(o.material) ? o.material : [o.material];
        for (const mat of materials) {
          mat.onBeforeCompile = shader => {
            shader.uniforms.skyEnergyTime = this.glowTime;
            shader.vertexShader = 'attribute float bridgeT; varying float vBridgeT;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvBridgeT=bridgeT;');
            shader.fragmentShader = 'uniform float skyEnergyTime; varying float vBridgeT;\n' + shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= 0.75+0.55*pow(0.5+0.5*sin(vBridgeT*55.0-skyEnergyTime*2.5),8.0);');
          };
          mat.customProgramCacheKey = () => 'sky-rainbow-flow'; mat.needsUpdate = true;
        }
      }
    });
  }
  private batchPlants() {
    for (const group of this.groups.values()) {
      group.updateWorldMatrix(true, true);
      const inverse = group.matrixWorld.clone().invert(), batches = new Map<string, { mesh: T.Mesh; matrices: T.Matrix4[] }>();
      const plants = group.children.filter(o => o.userData.asset_module);
      for (const plant of plants) plant.traverse(o => {
        if (!(o instanceof T.Mesh)) return;
        const key = o.geometry.uuid + ':' + (Array.isArray(o.material) ? o.material.map(m => m.uuid).join(',') : o.material.uuid);
        let batch = batches.get(key); if (!batch) { batch = { mesh: o, matrices: [] }; batches.set(key, batch); }
        batch.matrices.push(inverse.clone().multiply(o.matrixWorld));
      });
      for (const batch of batches.values()) {
        const mesh = new T.InstancedMesh(batch.mesh.geometry, batch.mesh.material, batch.matrices.length);
        batch.matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
        mesh.castShadow = mesh.receiveShadow = true; mesh.computeBoundingSphere(); group.add(mesh);
      }
      for (const plant of plants) group.remove(plant);
    }
  }
  update(delta: number, reduced = false, energy = 1, time?:number) {
    if(time!==undefined&&Number.isFinite(time))this.time=Math.max(0,time);
    if (time===undefined && !reduced && Number.isFinite(delta) && delta > 0) this.time += Math.min(delta, .05);
    energy = reduced ? 0 : T.MathUtils.clamp(Number.isFinite(energy) ? energy : 0, 0, 2);
    this.glowTime.value = this.time;
    const heights = new Map(this.layout.landscape.islands.map(s => [s.id, islandOffset(s, this.time, energy, this.layout.landscape.motion)]));
    for (const n of this.layout.nodes) this.offsets.set(n.id, Object.entries(n.islandWeights).reduce((sum, [id, weight]) => sum + heights.get(id)! * weight, 0));
    for (const [id, group] of this.groups) group.position.y = heights.get(id)!;
    for (const pad of this.pads) pad.object.position.y = pad.y + this.offsets.get(pad.id)!;
    for (const { mesh, rest, u, link, axis, windAxis } of this.deformed) {
      const a = this.offsets.get(link.start)!, b = this.offsets.get(link.end)!, positions = mesh.geometry.getAttribute('position') as T.BufferAttribute;
      for (let i = 0; i < u.length; i++) {
        const t = u[i], dy = a + (b - a) * t, wind = link.surface === 'suspension' ? .22 * energy * Math.sin(this.time * 1.1) * Math.sin(Math.PI * t) ** 2 : 0;
        positions.setXYZ(i, rest[i * 3] + axis.x * dy + windAxis.x * wind, rest[i * 3 + 1] + axis.y * dy + windAxis.y * wind, rest[i * 3 + 2] + axis.z * dy + windAxis.z * wind);
      }
      positions.needsUpdate = true;
    }
    // ponytail: this small, bounded motion retains rest normals; recompute if the energy range grows.
  }
}
