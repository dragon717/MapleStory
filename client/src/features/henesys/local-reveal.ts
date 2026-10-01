import * as T from 'three';

/** One local window in the existing opaque pass; scenery still casts its normal shadow. */
export class LocalReveal {
  private window = { value: new T.Vector4() };
  private depth = { value: 0 };
  private strength = { value: 0 };
  private candidates: { mesh: T.Mesh; bounds: T.Box3 }[] = [];
  private lastFoot?: T.Vector3;
  private direction = new T.Vector3();
  private ray = new T.Ray();
  private hit = new T.Vector3();
  private checkedAt = -Infinity;
  private blocked = false;

  constructor(model: T.Object3D) {
    const materials = new Map<T.Material, T.Material>();
    model.updateMatrixWorld(true);
    model.traverseVisible(o => {
      if (!(o instanceof T.Mesh)) return;
      let parent: T.Object3D | null = o, layer;
      while (parent && !layer) { layer = parent.userData.layer; parent = parent.parent; }
      if (!['buildings', 'props', 'vegetation'].includes(layer)) return;
      if (o instanceof T.InstancedMesh) {
        o.geometry.computeBoundingBox();
        const matrix = new T.Matrix4();
        for (let i = 0; i < o.count; i++) {
          o.getMatrixAt(i, matrix);matrix.premultiply(o.matrixWorld);
          this.candidates.push({ mesh: o, bounds: o.geometry.boundingBox!.clone().applyMatrix4(matrix) });
        }
      } else this.candidates.push({ mesh: o, bounds: new T.Box3().setFromObject(o) });
      const patch = (source: T.Material) => {
        let material = materials.get(source);
        if (material) return material;
        // A source material may also belong to the ground: clone only eligible scenery.
        material = source.clone();
        material.customProgramCacheKey = () => 'chuxian-local-reveal-v1';
        material.onBeforeCompile = shader => {
          Object.assign(shader.uniforms, { revealWindow: this.window, revealDepth: this.depth, revealStrength: this.strength });
          shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_pars_fragment>', `#include <clipping_planes_pars_fragment>
uniform vec4 revealWindow;
uniform float revealDepth, revealStrength;`);
          shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
// Only foreground fragments inside the feathered window are removed. Rear walls stay solid.
vec2 revealPoint = (gl_FragCoord.xy - revealWindow.xy) / max(revealWindow.zw, vec2(1.));
float reveal = (1. - smoothstep(.62, 1., length(revealPoint))) * revealStrength;
// Stable pixel coverage preserves opaque depth and avoids another scene/alpha-sort pass.
float coverage = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(.06711056, .00583715))));
if (gl_FragCoord.z < revealDepth && reveal > coverage) discard;`);
        };
        materials.set(source, material);
        return material;
      };
      o.material = Array.isArray(o.material) ? o.material.map(patch) : patch(o.material);
    });
  }

  update(foot: T.Vector3, camera: T.PerspectiveCamera, width: number, height: number, ratio: number, delta: number, now = performance.now(), bodyHeight = 2.2, bodyWidth = 0) {
    const movement = this.lastFoot ? foot.clone().sub(this.lastFoot) : new T.Vector3();
    const teleported = movement.length() > 5;
    if (teleported) { this.direction.set(0, 0, 0); this.strength.value = 0; this.checkedAt = -Infinity; }
    else if (movement.lengthSq() > 1e-8) { movement.y = 0; if (movement.lengthSq() > 1e-8) this.direction.lerp(movement.normalize(), 1 - Math.exp(-Math.max(0, delta) / 100)); }
    this.lastFoot = foot.clone();
    const ahead = foot.clone().addScaledVector(this.direction, 2.4);
    const head = foot.clone().add(new T.Vector3(0, bodyHeight, 0));
    const project = (p: T.Vector3) => p.clone().project(camera);
    const f = project(foot), h = project(head), a = project(ahead);
    const scale = height / (2 * Math.tan(T.MathUtils.degToRad(camera.fov / 2)) * -foot.clone().applyMatrix4(camera.matrixWorldInverse).z);
    // Include the body, feet and a few steps ahead, with room to read a nearby branch.
    const cx = (f.x + h.x) / 2 + (a.x - f.x) * .35, cy = (f.y + h.y) / 2 + (a.y - f.y) * .35;
    const rx = Math.min(width * .6, Math.max(70, Math.max(2.4, (bodyWidth / 2 + .5) / .62) * scale + Math.abs(a.x - f.x) * width * .25));
    const ry = Math.min(height * .6, Math.max(90, (Math.abs(h.y - f.y) * height * .25 + .6 * scale) / .62 + Math.abs(a.y - f.y) * height * .25));
    // gl_FragCoord uses bottom-left physical pixels, unlike top-left CSS projection.
    this.window.value.set((cx + 1) * width * ratio / 2, (cy + 1) * height * ratio / 2, rx * ratio, ry * ratio);
    this.depth.value = (Math.max(f.z, a.z) + 1) / 2;
    if (now - this.checkedAt >= 100) {
      this.checkedAt = now;
      // Bounding boxes only decide fade timing; the shader checks actual foreground pixels.
      // No triangle raycasts, GPU readbacks, or distance cutoff that misses a large building.
      const side = new T.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(Math.max(.65, bodyWidth * .4));
      const middle = foot.clone().add(new T.Vector3(0, bodyHeight / 2, 0));
      this.blocked = [foot.clone().add(new T.Vector3(0, .15, 0)), head, middle.clone().add(side), middle.sub(side), ahead].some(p => {
        this.ray.set(camera.position, p.clone().sub(camera.position).normalize());
        const distance = camera.position.distanceTo(p) - .05;
        return this.candidates.some(o => o.mesh.visible && this.ray.intersectBox(o.bounds, this.hit) && this.hit.distanceTo(camera.position) < distance);
      });
    }
    const target = this.blocked ? 1 : 0;
    this.strength.value += (target - this.strength.value) * (1 - Math.exp(-Math.max(0, delta) / 90));
    if (Math.abs(target - this.strength.value) < .002) this.strength.value = target;
  }

  // Patched materials/textures are owned and disposed by HenesysView's model lifecycle.
  destroy() { this.strength.value = 0; this.candidates.length = 0; this.lastFoot = undefined; }
}
