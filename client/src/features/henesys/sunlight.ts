import * as T from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { PAPER_DEPTH, RAIL_RADIUS } from './coordinates';

/** Depth-bounded single scattering, using the same sun shadow as the terrain. */
export class Sunlight {
  private target = new T.WebGLRenderTarget(1, 1, { type: T.HalfFloatType, depthTexture: new T.DepthTexture(1, 1) });
  private scattering = new T.WebGLRenderTarget(1, 1, { type: T.HalfFloatType, depthBuffer: false });
  private bloom = new UnrealBloomPass(new T.Vector2(32, 32), .045, .45, .7);
  private scene = new T.Scene();
  private camera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material = new T.ShaderMaterial({
    glslVersion: T.GLSL3,
    depthTest: false, depthWrite: false,
    uniforms: {
      image: { value: this.target.texture }, depth: { value: this.target.depthTexture },
      shadow: { value: null }, shadowMatrix: { value: new T.Matrix4() },
      inverseProjection: { value: new T.Matrix4() }, cameraWorld: { value: new T.Matrix4() },
      eye: { value: new T.Vector3() }, sunDirection: { value: new T.Vector3() },
      strength: { value: .035 }, rail: { value: new T.Vector2(RAIL_RADIUS, PAPER_DEPTH) },
    },
    vertexShader: `out vec2 screenUv;
      void main() { screenUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `precision highp sampler2DShadow;
      uniform sampler2D image, depth;
      uniform sampler2DShadow shadow;
      uniform mat4 inverseProjection, cameraWorld, shadowMatrix;
      uniform vec3 eye, sunDirection;
      uniform float strength;
      uniform vec2 rail;
      in vec2 screenUv;
      out vec4 outColor;
      void main() {
        vec4 view = inverseProjection * vec4(screenUv * 2.0 - 1.0, texture(depth, screenUv).r * 2.0 - 1.0, 1.0);
        vec3 end = (cameraWorld * vec4(view.xyz / view.w, 1.0)).xyz;
        vec3 ray = normalize(end - eye);
        float rayLength = min(distance(end, eye), 100.0);
        float stepSize = rayLength / 32.0;
        float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898,78.233))) * 43758.5453);
        float light = 0.0, opticalDepth = 0.0;
        // ponytail: 32 samples, increase only if visible banding survives pixel jitter.
        for (int i = 0; i < 32; i++) {
          vec3 p = eye + ray * (float(i) + jitter) * stepSize;
          vec4 projected = shadowMatrix * vec4(p, 1.0);
          vec3 s = projected.xyz / projected.w;
          float inside = step(0.0,s.x)*step(s.x,1.0)*step(0.0,s.y)*step(s.y,1.0)*step(0.0,s.z)*step(s.z,1.0);
          float lit = texture(shadow, vec3(s.xy, s.z - .0015)) * inside;
          float radius = length(vec2(p.x, rail.x + rail.y - p.z));
          float forest = smoothstep(rail.x - 8.0, rail.x - 4.0, radius) * (1.0 - smoothstep(rail.x + 18.0, rail.x + 30.0, radius));
          float density = forest * exp(-max(p.y - 3.0, 0.0) * .12) * smoothstep(-5.0, 0.0, p.y);
          opticalDepth += density * stepSize * .008;
          light += lit * density * stepSize * exp(-opticalDepth);
        }
        float phase = .35 + pow(max(dot(ray, sunDirection), 0.0), 8.0) * 1.8;
        outColor = vec4(vec3(1.0,.8,.52) * light * strength * phase,exp(-opticalDepth));
      }`,
  });
  private composite = new T.ShaderMaterial({
    glslVersion: T.GLSL3, depthTest: true, depthWrite: true, depthFunc: T.AlwaysDepth,
    uniforms: { image: { value: this.target.texture }, depth: { value: this.target.depthTexture }, scattering: { value: this.scattering.texture } },
    vertexShader: `out vec2 screenUv; void main() { screenUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }`,
    fragmentShader: `uniform sampler2D image, depth, scattering;
      in vec2 screenUv; out vec4 outColor;
      #define gl_FragColor outColor
      void main() {
        vec4 volume=texture(scattering,screenUv);
        outColor=vec4(texture(image,screenUv).rgb*volume.a+volume.rgb,1.0);
        gl_FragDepth=texture(depth,screenUv).r;
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  private quad = new T.Mesh(new T.PlaneGeometry(2, 2), this.material);
  constructor() { this.scene.add(this.quad); }
  resize(width: number, height: number) {
    this.target.setSize(width, height);
    this.bloom.setSize(width, height);
    // Half each dimension for scattering only; scene depth and pixel art stay full size.
    this.scattering.setSize(Math.ceil(width / 2), Math.ceil(height / 2));
  }
  render(renderer: T.WebGLRenderer, scene: T.Scene, camera: T.PerspectiveCamera, sun: T.DirectionalLight) {
    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    // Bloom only the HDR environment; sprites and UI are drawn after composition.
    this.bloom.render(renderer, this.target, this.target, 0, false);
    const u = this.material.uniforms;
    u.shadow.value = sun.shadow.map!.depthTexture;
    u.shadowMatrix.value.copy(sun.shadow.matrix);
    u.inverseProjection.value.copy(camera.projectionMatrixInverse);
    u.cameraWorld.value.copy(camera.matrixWorld);
    u.eye.value.copy(camera.position);
    u.sunDirection.value.copy(sun.position).sub(sun.target.position).normalize();
    this.quad.material = this.material;
    renderer.setRenderTarget(this.scattering);
    renderer.render(this.scene, this.camera);
    this.quad.material = this.composite;
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
  }
  destroy() { this.target.dispose(); this.scattering.dispose(); this.bloom.dispose(); this.quad.geometry.dispose(); this.material.dispose(); this.composite.dispose(); }
}
