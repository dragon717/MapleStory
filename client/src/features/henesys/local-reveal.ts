import * as T from 'three';

/** Authored interior cutaways and a local opaque-pass window for full outdoor occlusion. */
export class LocalReveal {
  private window = { value: new T.Vector4() };
  private depth = { value: 0 };
  private bottom = { value: -1 };
  private strength = { value: 0 };
  private candidates: { mesh: T.Mesh; bounds: T.Box3; instance?: number }[] = [];
  private geometryBounds = new WeakMap<T.BufferGeometry, { version: number; bounds: T.Box3 }>();
  private occluders = new WeakMap<T.BufferGeometry,{version:number;tiles:{bounds:T.Box3;triangles:number[]}[]}>();
  private localRay=new T.Ray();
  private inverse=new T.Matrix4();
  private vertices=[new T.Vector3(),new T.Vector3(),new T.Vector3()];
  private lastFoot?: T.Vector3;
  private direction = new T.Vector3();
  private ray = new T.Ray();
  private animatedRay = new T.Raycaster();
  private hit = new T.Vector3();
  private checkedAt = -Infinity;
  private blocked = false;
  private interiors: { volume:T.Object3D; bounds:T.Box3; shells:{object:T.Object3D;above:boolean}[] }[]=[];
  private hidden = new Map<T.Object3D,boolean>();
  private paused = false;

  constructor(model: T.Object3D, eligible?: (mesh:T.Mesh) => boolean, private bodyOcclusion: 'whole' | 'torso' = 'whole') {
    const materials = new Map<T.Material, T.Material>();
    model.updateMatrixWorld(true);
    model.traverse(o=>{
      const b=o.userData.interior_bounds;
      if(!Array.isArray(b)||b.length!==6||!b.every(Number.isFinite))return;
      const shells:{object:T.Object3D;above:boolean}[]=[];
      model.traverse(part=>{if(part.userData.cutaway_rooms?.split(',').includes(o.name))shells.push({object:part,above:part.userData.cutaway_above_rooms?.split(',').includes(o.name)??!!part.userData.cutaway_above});});
      this.interiors.push({volume:o,bounds:new T.Box3(new T.Vector3(...b.slice(0,3)),new T.Vector3(...b.slice(3))),shells});
    });
    model.traverseVisible(o => {
      if (!(o instanceof T.Mesh)) return;
      let parent: T.Object3D | null = o, layer;
      while (parent && !layer) { layer = parent.userData.layer; parent = parent.parent; }
      if (eligible ? !eligible(o) : !['buildings', 'props', 'vegetation'].includes(layer) && !o.userData.island_binding && !o.userData.edge_id && !o.userData.bridge_edge) return;
      if ((Array.isArray(o.material)?o.material:[o.material]).every(m=>m.transparent || m instanceof T.MeshPhysicalMaterial && m.transmission > .5)) return;
      if (o instanceof T.InstancedMesh) {
        o.geometry.computeBoundingBox();
        const matrix = new T.Matrix4();
        for (let i = 0; i < o.count; i++) {
          o.getMatrixAt(i, matrix);matrix.premultiply(o.matrixWorld);
          this.candidates.push({ mesh: o, bounds: o.geometry.boundingBox!.clone().applyMatrix4(matrix), instance: i });
        }
      } else this.candidates.push({ mesh: o, bounds: new T.Box3().setFromObject(o) });
      const patch = (source: T.Material) => {
        let material = materials.get(source);
        if (material) return material;
        // A source material may also belong to the ground: clone only eligible scenery.
        material = source.clone();
        const previous = source.onBeforeCompile, key = source.customProgramCacheKey.call(source);
        material.customProgramCacheKey = () => key + ':chuxian-local-reveal-v1';
        material.onBeforeCompile = (shader, renderer) => {
          previous.call(material!, shader, renderer);
          Object.assign(shader.uniforms, { revealWindow: this.window, revealDepth: this.depth, revealBottom: this.bottom, revealStrength: this.strength });
          shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_pars_fragment>', `#include <clipping_planes_pars_fragment>
uniform vec4 revealWindow;
uniform float revealDepth, revealBottom, revealStrength;`);
          shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
// Only foreground fragments inside the feathered window are removed. Rear walls stay solid.
vec2 revealPoint = (gl_FragCoord.xy - revealWindow.xy) / max(revealWindow.zw, vec2(1.));
float reveal = (1. - smoothstep(.62, 1., length(revealPoint))) * revealStrength;
// Keep the solid hull below the voyage passenger's deck line.
if (gl_FragCoord.y < revealBottom) reveal = 0.;
// Stable pixel coverage preserves opaque depth and avoids another scene/alpha-sort pass.
float coverage = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(.06711056, .00583715))));
if (gl_FragCoord.z < revealDepth && reveal > coverage) discard;`);
        };
        materials.set(source, material);
        return material;
      };
      o.material = Array.isArray(o.material) ? o.material.map(patch) : patch(o.material);
    });
    // Build large static hull/terrain tiles during scene setup, before the first walking frame.
    for(const {mesh} of this.candidates)if((mesh.geometry.index?.count??mesh.geometry.getAttribute('position').count)>10000)this.tiles(mesh.geometry);
  }

  /**
   * Temporarily suspend local body reveal while a scene is being inspected.
   * Restoring the tracked visibility and shader strength here is important:
   * callers may stop calling update for several frames, so waiting for the
   * next normal update would leave the last cutaway on screen.
   */
  setPaused(paused: boolean) {
    if (this.paused === paused) {
      if (paused) this.restorePausedState();
      return;
    }
    this.paused = paused;
    this.restorePausedState();
    this.lastFoot = undefined;
    this.direction.set(0, 0, 0);
    this.checkedAt = -Infinity;
  }

  private restorePausedState() {
    for (const [object, visible] of this.hidden) object.visible = visible;
    this.hidden.clear();
    this.blocked = false;
    this.strength.value = 0;
  }

  update(foot: T.Vector3, camera: T.PerspectiveCamera | T.OrthographicCamera, width: number, height: number, ratio: number, delta: number, now = performance.now(), bodyHeight = 2.2, bodyWidth = 0) {
    if (this.paused) {
      this.restorePausedState();
      this.lastFoot = undefined;
      return false;
    }
    const cut=new Set<T.Object3D>();
    for(const room of this.interiors){
      room.volume.updateWorldMatrix(true,false);
      const inside=room.volume.worldToLocal(foot.clone());
      // Small exit margin prevents rapid toggling while standing on the doorway.
      const bounds=room.bounds.clone();if(room.shells.some(s=>this.hidden.has(s.object)))bounds.expandByScalar(.6);
      if(!bounds.containsPoint(inside))continue;
      for(const shell of room.shells){
        if(shell.above){shell.object.updateWorldMatrix(true,false);const y=new T.Vector3(...shell.object.userData.cutaway_level).applyMatrix4(shell.object.matrixWorld).y;if(y<=foot.y+3)continue;}
        cut.add(shell.object);
      }
    }
    let changed=false;
    for(const [object,visible] of this.hidden)if(!cut.has(object)){object.visible=visible;this.hidden.delete(object);changed=true;}
    for(const object of cut)if(!this.hidden.has(object)){this.hidden.set(object,object.visible);object.visible=false;changed=true;}
    const movement = this.lastFoot ? foot.clone().sub(this.lastFoot) : new T.Vector3();
    const teleported = movement.length() > 5;
    if (teleported) { this.direction.set(0, 0, 0); this.strength.value = 0; this.checkedAt = -Infinity; }
    else if (movement.lengthSq() > 1e-8) { movement.y = 0; if (movement.lengthSq() > 1e-8) this.direction.lerp(movement.normalize(), 1 - Math.exp(-Math.max(0, delta) / 100)); }
    this.lastFoot = foot.clone();
    const ahead = foot.clone().addScaledVector(this.direction, 2.4);
    const head = foot.clone().add(new T.Vector3(0, bodyHeight, 0));
    const project = (p: T.Vector3) => p.clone().project(camera);
    const f = project(foot), h = project(head), a = project(ahead);
    const scale = camera instanceof T.OrthographicCamera
      ? height * camera.zoom / (camera.top - camera.bottom)
      : height / (2 * Math.tan(T.MathUtils.degToRad(camera.fov / 2)) * -foot.clone().applyMatrix4(camera.matrixWorldInverse).z);
    // Include the body, feet and a few steps ahead, with room to read a nearby branch.
    const cx = (f.x + h.x) / 2 + (a.x - f.x) * .35, cy = (f.y + h.y) / 2 + (a.y - f.y) * .35;
    const rx = Math.min(width * .6, Math.max(70, Math.max(2.4, (bodyWidth / 2 + .5) / .62) * scale + Math.abs(a.x - f.x) * width * .25));
    const ry = Math.min(height * .6, Math.max(90, (Math.abs(h.y - f.y) * height * .25 + .6 * scale) / .62 + Math.abs(a.y - f.y) * height * .25));
    // gl_FragCoord uses bottom-left physical pixels, unlike top-left CSS projection.
    this.window.value.set((cx + 1) * width * ratio / 2, (cy + 1) * height * ratio / 2, rx * ratio, ry * ratio);
    this.depth.value = (Math.max(f.z, a.z) + 1) / 2;
    this.bottom.value = this.bodyOcclusion === 'torso' ? (f.y + 1) * height * ratio / 2 - 8 * ratio : -1;
    if (now - this.checkedAt >= 100) {
      this.checkedAt = now;
      // Moving islands and ship require current, rather than construction-time, bounds.
      const matrix = new T.Matrix4();
      for (const item of this.candidates) {
        item.mesh.updateWorldMatrix(true, false);
        if (item.instance !== undefined) (item.mesh as T.InstancedMesh).getMatrixAt(item.instance, matrix); else matrix.identity();
        matrix.premultiply(item.mesh.matrixWorld);
        const geometry = item.mesh.geometry, position = geometry.getAttribute('position');
        const version = position instanceof T.InterleavedBufferAttribute ? position.data.version : position.version;
        let local = this.geometryBounds.get(geometry);
        if (!local || local.version !== version) {
          geometry.computeBoundingBox();
          local = { version, bounds: geometry.boundingBox!.clone() }; this.geometryBounds.set(geometry, local);
        }
        item.bounds.copy(local.bounds).applyMatrix4(matrix);
      }
      // Boxes reject distant candidates; cached triangle tiles distinguish real walls from hollow hull bounds.
      // The shader removes only foreground pixels; no GPU readback or alpha-sort pass.
      const side = new T.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(Math.max(.3, bodyWidth * .4));
      const middle = foot.clone().add(new T.Vector3(0, bodyHeight / 2, 0));
      // A deck wall can leave only the hat showing. The voyage's torso rule
      // reveals that case while the world keeps its whole-body policy.
      const samples = [foot.clone().add(new T.Vector3(0, .15, 0)), middle.clone().add(side), middle.sub(side)];
      if (this.bodyOcclusion === 'whole') samples.push(head);
      this.blocked = samples.every(p => {
        const origin = camera instanceof T.OrthographicCamera
          ? new T.Vector3(p.clone().project(camera).x, p.clone().project(camera).y, -1).unproject(camera)
          : camera.getWorldPosition(new T.Vector3());
        this.ray.set(origin, p.clone().sub(origin).normalize());
        const distance = origin.distanceTo(p) - .05;
        return this.candidates.some(o => {let p:T.Object3D|null=o.mesh;while(p){if(!p.visible)return false;p=p.parent;}return (o.bounds.containsPoint(this.ray.origin)||!!this.ray.intersectBox(o.bounds,this.hit)&&this.hit.distanceTo(origin)<distance)&&this.triangleDistance(o.mesh,o.instance,distance)!==undefined;});
      });
    }
    const target = this.blocked ? 1 : 0;
    // A reduced-motion single frame has no advancing delta. Resolve its
    // coverage immediately instead of leaving a fully hidden body invisible.
    this.strength.value += (target - this.strength.value) * (delta > 0 ? 1 - Math.exp(-delta / 90) : 1);
    if (Math.abs(target - this.strength.value) < .002) this.strength.value = target;
    return changed;
  }

  private tiles(geometry:T.BufferGeometry){
    const p=geometry.getAttribute('position'),index=geometry.index;
    const version=p instanceof T.InterleavedBufferAttribute?p.data.version:p.version;
    let cached=this.occluders.get(geometry);
    if(!cached||cached.version!==version){
      const bins=new Map<string,{bounds:T.Box3;triangles:number[]}>();
      const count=index?.count??p.count;
      for(let i=geometry.drawRange.start;i<Math.min(count,geometry.drawRange.start+geometry.drawRange.count);i+=3){
        for(let j=0;j<3;j++)this.vertices[j].fromBufferAttribute(p,index?index.getX(i+j):i+j);
        // Reuse the deck collider's small spatial tiles; cache until vertices actually change.
        const center=this.vertices[0].clone().add(this.vertices[1]).add(this.vertices[2]).divideScalar(3);
        const key=count>10000?`${Math.floor(center.x/4)},${Math.floor(center.y/4)},${Math.floor(center.z/4)}`:'all';
        let bin=bins.get(key);if(!bin){bin={bounds:new T.Box3(),triangles:[]};bins.set(key,bin);}
        bin.triangles.push(i);for(const v of this.vertices)bin.bounds.expandByPoint(v);
      }
      cached={version,tiles:[...bins.values()]};this.occluders.set(geometry,cached);
    }
    return cached.tiles;
  }
  /** Reuse the same static triangle tiles for a short camera-clearance ray. */
  surfaceDistance(mesh:T.Mesh,origin:T.Vector3,direction:T.Vector3,distance:number) {
    this.ray.set(origin,direction);
    return this.triangleDistance(mesh,undefined,distance,true);
  }
  private triangleDistance(mesh:T.Mesh,instance:number|undefined,distance:number,nearest=false){
    // Folding cloth uses both CPU positions and morph displacements. Three's
    // mesh raycast evaluates the rendered vertices; static triangle tiles do
    // not include the current morph, so cannot decide its body occlusion.
    if(instance===undefined && mesh.geometry.morphAttributes.position?.length){
      this.animatedRay.set(this.ray.origin,this.ray.direction);this.animatedRay.near=0;this.animatedRay.far=distance;
      const hit=this.animatedRay.intersectObject(mesh,false).find(hit=>{
        const material=Array.isArray(mesh.material)?mesh.material[hit.face?.materialIndex??0]:mesh.material;
        return material?.visible&&!material.transparent&&!(material instanceof T.MeshPhysicalMaterial&&material.transmission>.5);
      });
      return hit?.distance;
    }
    const geometry=mesh.geometry,p=geometry.getAttribute('position'),index=geometry.index,tiles=this.tiles(geometry);
    this.inverse.copy(mesh.matrixWorld);
    if(instance!==undefined){const m=new T.Matrix4();(mesh as T.InstancedMesh).getMatrixAt(instance,m);this.inverse.multiply(m);}
    const world=this.inverse.clone();this.localRay.copy(this.ray).applyMatrix4(this.inverse.invert());
    let closest:number|undefined;
    for(const tile of tiles){
      if(!this.localRay.intersectBox(tile.bounds,this.hit))continue;
      for(const i of tile.triangles){
        for(let j=0;j<3;j++)this.vertices[j].fromBufferAttribute(p,index?index.getX(i+j):i+j);
        const material=Array.isArray(mesh.material)?mesh.material[geometry.groups.find(g=>i>=g.start&&i<g.start+g.count)?.materialIndex??0]:mesh.material;
        if(!material||!material.visible||material.transparent || material instanceof T.MeshPhysicalMaterial && material.transmission > .5)continue;
        const [a,b,c]=this.vertices;
        if(this.localRay.intersectTriangle(material.side===T.BackSide?c:a,b,material.side===T.BackSide?a:c,material.side!==T.DoubleSide,this.hit)) {
          const hitDistance=this.hit.applyMatrix4(world).distanceTo(this.ray.origin);
          if(hitDistance<distance) {
            if(!nearest)return hitDistance;
            closest=Math.min(closest??Infinity,hitDistance);
          }
        }
      }
    }
    return closest;
  }

  // Patched materials/textures are owned and disposed by HenesysView's model lifecycle.
  destroy() { for(const [object,visible] of this.hidden)object.visible=visible;this.hidden.clear();this.interiors.length=0;this.strength.value = 0; this.candidates.length = 0; this.lastFoot = undefined; }
}
