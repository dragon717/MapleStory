import * as T from 'three';
import { ShallowWater } from './voyage-physics';

type Point = [number, number, number];
export type WaterSpec =
  | { kind: 'pool'; id: string; center: Point; size: [number, number]; depth: number }
  | { kind: 'river'; id: string; points: Point[]; width: number; depth: number; flow: number }
  | { kind: 'fall'; id: string; from: Point; to: Point; width: number };
type Surface = { mesh: T.Mesh; rest: Float32Array; solver: ShallowWater; width: number; length: number; pool: boolean };
type Fall = { mesh: T.Mesh; spray: T.Points; from: Point; to: Point; width: number; duration: number };
const gravity = 9.81;

/** Generated water geometry; the GLB supplies only banks and water-domain descriptors. */
export class VoyageWater {
  readonly group = new T.Group();
  readonly surfaces: Surface[] = [];
  readonly falls: Fall[] = [];
  private time = { value: 0 };
  private gradient: T.DataTexture;
  constructor(parent: T.Object3D, specs: WaterSpec[]) {
    this.group.name = 'VoyageProgramWater'; parent.add(this.group);
    this.gradient = new T.DataTexture(new Uint8Array([65, 65, 65, 255, 160, 160, 160, 255, 255, 255, 255, 255]), 3, 1);
    this.gradient.minFilter = this.gradient.magFilter = T.NearestFilter; this.gradient.needsUpdate = true;
    for (const spec of specs) {
      const points = spec.kind === 'pool' ? [spec.center] : spec.kind === 'river' ? spec.points : [spec.from, spec.to];
      if (!points.every(p => p.length === 3 && p.every(Number.isFinite))) throw new Error('Invalid water coordinates');
      if (spec.kind === 'fall') this.makeFall(spec);
      else this.makeSurface(spec);
    }
    this.update(1 / 120);
  }
  private material(fall = false, pool = false) {
    const material = new T.MeshToonMaterial({ color: fall ? '#74d5e8' : '#35b5d5', gradientMap: this.gradient, side: T.DoubleSide, transparent: true, opacity: .94 });
    material.onBeforeCompile = shader => {
      shader.uniforms.voyageWaterTime = this.time;
      shader.vertexShader = `${fall ? '' : 'attribute float waterPhase;'} varying float voyageWaterPhase; varying vec2 voyageWaterUv;\n` + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\nvoyageWaterUv=uv;voyageWaterPhase=${fall ? '0.' : 'waterPhase'};`);
      shader.fragmentShader = 'uniform float voyageWaterTime; varying float voyageWaterPhase; varying vec2 voyageWaterUv;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
        #include <color_fragment>
        vec2 p = voyageWaterUv;
        ${pool ? 'float radius = length((p-.5)*2.); if(radius>1.) discard; float edge=(1.-radius)*.5;' : 'float edge = min(min(p.x,1.-p.x),min(p.y,1.-p.y));'}
        float phase = p.x * 38. + sin(p.y*12.-voyageWaterTime*4.)*.7;
        float whiteLine = ${fall ? 'smoothstep(.84,.98,sin(phase))' : 'smoothstep(.965,.997,sin(voyageWaterPhase))'};
        float broken = smoothstep(-.35,.35,sin(p.x * 24. + sin(p.y * 13.) + voyageWaterTime * .3));
        float shore = (1.-smoothstep(.003,.014,edge)) * (.45+.35*sin(p.x*60.+p.y*35.+voyageWaterTime));
        float foam = ${fall ? 'whiteLine*.55 + smoothstep(.85,1.,1.-p.y)*.25' : 'max(whiteLine * broken * .92, shore * .65)'};
        ${fall ? '' : 'diffuseColor.rgb *= mix(.7,1.18,smoothstep(-.55,.65,sin(voyageWaterPhase)));'}
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.94,.99,1.),foam);
      `);
    };
    material.customProgramCacheKey = () => fall ? 'voyage-comic-fall' : pool ? 'voyage-comic-pool' : 'voyage-comic-surface';
    return material;
  }
  private makeSurface(spec: Extract<WaterSpec, { kind: 'pool' | 'river' }>) {
    const width = spec.kind === 'pool' ? spec.size[0] : spec.width;
    const points = spec.kind === 'river' ? spec.points : [];
    const distances = [0];
    for (let i = 1; i < points.length; i++) distances.push(distances[i - 1] + Math.hypot(...points[i].map((v, axis) => v - points[i - 1][axis])));
    const length = spec.kind === 'pool' ? spec.size[1] : distances.at(-1)!;
    if (width < 1 || length < 1 || !Number.isFinite(width + length + spec.depth)) throw new Error('Invalid water dimensions');
    const nx = spec.kind === 'pool' ? 40 : 12, nz = spec.kind === 'pool' ? 32 : 64;
    const geometry = new T.PlaneGeometry(width, length, nx - 1, nz - 1);
    geometry.rotateX(-Math.PI / 2);
    const position = geometry.getAttribute('position') as T.BufferAttribute;
    const uv = geometry.getAttribute('uv') as T.BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      const u = uv.getX(i), v = 1 - uv.getY(i);
      if (spec.kind === 'pool') position.setXYZ(i, spec.center[0] + (u - .5) * width, spec.center[1], spec.center[2] + (v - .5) * length);
      else {
        const distance = v * length;
        let segment = 0; while (segment < points.length - 2 && distances[segment + 1] < distance) segment++;
        const a = points[segment], b = points[segment + 1], t = (distance - distances[segment]) / Math.max(.001, distances[segment + 1] - distances[segment]);
        const dx = b[0] - a[0], dz = b[2] - a[2], magnitude = Math.max(.001, Math.hypot(dx, dz));
        position.setXYZ(i, a[0] + dx * t - dz / magnitude * (u - .5) * width, a[1] + (b[1] - a[1]) * t, a[2] + dz * t + dx / magnitude * (u - .5) * width);
      }
    }
    const rest = new Float32Array(position.array); position.setUsage(T.DynamicDrawUsage);
    geometry.setAttribute('waterPhase', new T.BufferAttribute(new Float32Array(position.count), 1).setUsage(T.DynamicDrawUsage));
    const solver = new ShallowWater(nx, nz, width, length, spec.depth, spec.kind === 'river' ? spec.flow : 0);
    solver.disturb(.43, .52, 2);
    const mesh = new T.Mesh(geometry, this.material(false, spec.kind === 'pool')); mesh.name = 'VoyageWater_' + spec.id; mesh.receiveShadow = true;
    this.group.add(mesh); this.surfaces.push({ mesh, rest, solver, width, length, pool: spec.kind === 'pool' });
  }
  private makeFall(spec: Extract<WaterSpec, { kind: 'fall' }>) {
    const drop = spec.from[1] - spec.to[1];
    if (drop <= 0 || !Number.isFinite(spec.width) || spec.width < 1) throw new Error('Invalid waterfall');
    const duration = Math.sqrt(2 * drop / gravity);
    const geometry = new T.PlaneGeometry(spec.width, drop, 8, 48);
    (geometry.getAttribute('position') as T.BufferAttribute).setUsage(T.DynamicDrawUsage);
    const mesh = new T.Mesh(geometry, this.material(true)); mesh.name = 'VoyageFall_' + spec.id;
    const sprayGeometry = new T.BufferGeometry();
    sprayGeometry.setAttribute('position', new T.BufferAttribute(new Float32Array(96 * 3), 3).setUsage(T.DynamicDrawUsage));
    const spray = new T.Points(sprayGeometry, new T.PointsMaterial({ color: '#ecfbff', size: Math.max(.65, spec.width / 16), transparent: true, opacity: .6, depthWrite: false }));
    spray.frustumCulled = false; this.group.add(mesh, spray);
    this.falls.push({ mesh, spray, from: spec.from, to: spec.to, width: spec.width, duration });
  }
  disturb() { for (const surface of this.surfaces) surface.solver.disturb(.5, .5, 5); }
  update(delta: number) {
    if (delta <= 0) return;
    this.time.value += Math.min(delta, .05);
    const time = this.time.value;
    for (const { mesh, rest, solver, width, length, pool } of this.surfaces) {
      solver.advance(delta, Math.sin(time * .6) * .025);
      const position = mesh.geometry.getAttribute('position') as T.BufferAttribute, uv = mesh.geometry.getAttribute('uv') as T.BufferAttribute;
      const elevation = mesh.geometry.getAttribute('waterPhase') as T.BufferAttribute;
      for (let i = 0; i < position.count; i++) {
        const u = uv.getX(i), v = 1 - uv.getY(i), x = (u - .5) * width, z = v * length;
        const wavelength = Math.min(32, Math.max(5, width * .25)), k = Math.PI * 2 / wavelength;
        const omega = Math.sqrt(gravity * k * Math.tanh(k * solver.depth));
        const phase = k * (x * .4 + z * .92) + .5 * Math.sin(k*x*.8) - omega * time;
        const amplitude = Math.min(.8, solver.depth * .28);
        // ponytail: rectangular conservative solver, elliptical shore mask for these static basins.
        const edge = pool ? (1 - Math.hypot((u - .5) * 2, (v - .5) * 2)) * .5 : Math.min(u, 1 - u, v, 1 - v);
        const shore = Math.max(0, Math.min(1, edge * 18));
        const physicalHeight = solver.height(u, v);
        elevation.setX(i, phase);
        // Gerstner is a controllable render wave; conservative h/hu/hv stays in the solver.
        position.setXYZ(i, rest[i * 3] + .55 * amplitude * Math.cos(phase) * shore, rest[i * 3 + 1] + physicalHeight * shore + amplitude * (Math.sin(phase)+.18*Math.sin(2*phase)) * shore, rest[i * 3 + 2] + .25 * amplitude * Math.cos(phase) * shore);
      }
      position.needsUpdate = true; elevation.needsUpdate = true; mesh.geometry.computeVertexNormals(); mesh.geometry.computeBoundingSphere();
    }
    for (const fall of this.falls) {
      const p = fall.mesh.geometry.getAttribute('position') as T.BufferAttribute, uv = fall.mesh.geometry.getAttribute('uv') as T.BufferAttribute;
      for (let i = 0; i < p.count; i++) {
        const u = uv.getX(i), t = (1 - uv.getY(i)) * fall.duration, progress = t / fall.duration;
        p.setXYZ(i, fall.from[0] + (fall.to[0] - fall.from[0]) * progress + (u - .5) * fall.width * (1 + progress * .18), fall.from[1] - .5 * gravity * t * t, fall.from[2] + (fall.to[2] - fall.from[2]) * progress + Math.sin(t * 5 - time * 8 + u * 6) * .16 * progress);
      }
      p.needsUpdate = true; fall.mesh.geometry.computeVertexNormals(); fall.mesh.geometry.computeBoundingSphere();
      const spray = fall.spray.geometry.getAttribute('position') as T.BufferAttribute;
      for (let i = 0; i < spray.count; i++) {
        const age = (time + i * .037) % 1.4, angle = i * 2.399963;
        const speed = 1.4 + i % 7 * .45;
        spray.setXYZ(i, fall.to[0] + Math.cos(angle) * speed * age, fall.to[1] + speed * age - .5 * gravity * age * age, fall.to[2] + Math.sin(angle) * speed * age);
      }
      spray.needsUpdate = true;
    }
  }
  dispose() { this.gradient.dispose(); }
}
