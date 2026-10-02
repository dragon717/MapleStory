import * as T from 'three';
import type { VoyageWindowLight } from './voyage-window-light';

// Periodic 3D value-Worley field, generated once; no downloaded cloud images.
// Value-noise interpolation follows henesys/environment.ts, with voyage-sized frequencies.
function cloudNoise() {
  const size = 64, data = new Uint8Array(size ** 3 * 4);
  let seed = 273;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const grids = [4, 8, 16, 32].map(n => ({ n, values: Float32Array.from({ length: n ** 3 }, random), points: Float32Array.from({ length: n ** 3 * 3 }, random) }));
  const index = (x: number, y: number, z: number, n: number) => ((z + n) % n * n + (y + n) % n) * n + (x + n) % n;
  const valueNoise = (x: number, y: number, z: number, grid: typeof grids[number]) => {
    const { n, values } = grid, px = x * n, py = y * n, pz = z * n, ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
    const fade = (v: number) => v * v * (3 - 2 * v), fx = fade(px - ix), fy = fade(py - iy), fz = fade(pz - iz);
    const mix = (a: number, b: number, f: number) => a + (b - a) * f, at = (dx: number, dy: number, dz: number) => values[index(ix + dx, iy + dy, iz + dz, n)];
    return mix(mix(mix(at(0, 0, 0), at(1, 0, 0), fx), mix(at(0, 1, 0), at(1, 1, 0), fx), fy), mix(mix(at(0, 0, 1), at(1, 0, 1), fx), mix(at(0, 1, 1), at(1, 1, 1), fx), fy), fz);
  };
  const worley = (x: number, y: number, z: number, grid: typeof grids[number]) => {
    const { n, points } = grid, px = x * n, py = y * n, pz = z * n, ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
    let distance = 3;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const i = index(ix + dx, iy + dy, iz + dz, n) * 3;
      const vx = ix + dx + points[i] - px, vy = iy + dy + points[i + 1] - py, vz = iz + dz + points[i + 2] - pz;
      distance = Math.min(distance, vx * vx + vy * vy + vz * vz);
    }
    return 1 - Math.min(1, Math.sqrt(distance));
  };
  for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = (x + .5) / size, py = (y + .5) / size, pz = (z + .5) / size;
    const cells = grids.map(grid => worley(px, py, pz, grid));
    const base = valueNoise(px, py, pz, grids[0]) * .6 + valueNoise(px, py, pz, grids[1]) * .25 + valueNoise(px, py, pz, grids[2]) * .15;
    const i = ((z * size + y) * size + x) * 4;
    data[i] = Math.round(T.MathUtils.clamp((base - (1 - cells[0]) * .23) / .77, 0, 1) * 255);
    data[i + 1] = Math.round((cells[0] * .625 + cells[1] * .25 + cells[2] * .125) * 255);
    data[i + 2] = Math.round((cells[1] * .625 + cells[2] * .25 + cells[3] * .125) * 255);
    data[i + 3] = Math.round(valueNoise(px, py, pz, grids[0]) * 255);
  }
  const texture = new T.Data3DTexture(data, size, size, size);
  texture.format = T.RGBAFormat;
  texture.minFilter = texture.magFilter = T.LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = T.RepeatWrapping;
  texture.unpackAlignment = 1; texture.needsUpdate = true;
  return texture;
}

const vertexShader = 'out vec2 screenUv; void main(){screenUv=uv; gl_Position=vec4(position.xy,0.,1.);}';
const cloudShader = /* glsl */`
precision highp sampler3D;
uniform sampler3D noiseVolume;
uniform sampler2D sceneDepth;
uniform mat4 inverseProjection, cameraWorld;
uniform vec3 eye, sunDirection, sunColor, hazeColor;
uniform float cloudTime, sunPower, cameraNear, cameraFar;
in vec2 screenUv;
out vec4 outColor;
const vec3 cloudMin=vec3(-9000.,-960.,-10500.), cloudMax=vec3(9000.,580.,6500.);
const float extinction=.012;

// Parallel rays and camera-inside intervals both work; no upward-ray restriction.
vec2 cloudInterval(vec3 origin, vec3 direction){
  vec2 interval=vec2(-1e20,1e20);
  for(int axis=0;axis<3;axis++){
    if(abs(direction[axis])<.000001){
      if(origin[axis]<cloudMin[axis] || origin[axis]>cloudMax[axis]) return vec2(1.,0.);
    }else{
      vec2 hit=vec2(cloudMin[axis]-origin[axis],cloudMax[axis]-origin[axis])/direction[axis];
      interval.x=max(interval.x,min(hit.x,hit.y)); interval.y=min(interval.y,max(hit.x,hit.y));
    }
  }
  return interval;
}

float density(vec3 p){
  if(any(lessThan(p,cloudMin)) || any(greaterThan(p,cloudMax))) return 0.;
  vec3 moving=p-vec3(cloudTime*9.,0.,cloudTime*3.2);
  float weather=textureLod(noiseVolume,vec3(moving.x*.00013,.37,moving.z*.00013),0.).a;
  // The ship and main island sit above the low sea; distant cumulus can rise above them.
  vec2 city=(p.xz-vec2(-1300.,-2200.))/vec2(1150.,950.), ship=p.xz/vec2(320.,620.);
  vec2 approach=vec2(p.x/1500.,(p.z+1100.)/2100.);
  float clearance=max(max(exp(-dot(city,city)),exp(-dot(ship,ship))),exp(-dot(approach,approach)));
  float top=-130.+(1.-clearance)*560.*smoothstep(.36,.73,weather);
  float height=(p.y+920.)/(top+920.);
  float profile=smoothstep(0.,.18,height)*(1.-smoothstep(.66,1.,height));
  if(profile<=0.) return 0.;
  vec4 noise=textureLod(noiseVolume,moving/1800.,0.);
  float coverage=.58+weather*.32;
  float shape=max(0.,(noise.r-(1.-coverage))/coverage);
  shape=max(0.,shape-(1.-noise.g)*.16);
  float detail=textureLod(noiseVolume,moving/540.+vec3(.13,.27,.41),0.).b;
  float erosion=(1.-detail)*.12*(1.-shape);
  vec2 edge=min(p.xz-cloudMin.xz,cloudMax.xz-p.xz);
  return clamp((shape-erosion)*2.3,0.,1.)*profile*smoothstep(0.,700.,min(edge.x,edge.y));
}

float sunlight(vec3 p){
  float finish=min(max(cloudInterval(p,sunDirection).y,0.),2200.), opticalDepth=0., travel=0.;
  // ponytail: six expanding sun samples; a light-volume cache is only needed after GPU measurement.
  for(int i=0;i<6;i++){
    float ds=finish*pow(1.6,float(i))/26.29536;
    opticalDepth+=density(p+sunDirection*(travel+ds*.5))*ds;
    travel+=ds;
  }
  return exp(-opticalDepth*extinction);
}

float phase(float mu,float g){return (1.-g*g)/(12.5663706*pow(max(1.+g*g-2.*g*mu,.001),1.5));}
float sceneDistance(vec2 uv){
  float d=texture(sceneDepth,uv).r;
  if(d>=.9999999) return cameraFar;
  vec4 view=inverseProjection*vec4(uv*2.-1.,d*2.-1.,1.);
  return length(view.xyz/view.w);
}

vec4 integrateClouds(vec2 uv){
  vec4 farView=inverseProjection*vec4(uv*2.-1.,1.,1.);
  vec3 view=farView.xyz/farView.w, ray=normalize((cameraWorld*vec4(normalize(view),0.)).xyz);
  vec2 interval=cloudInterval(eye,ray);
  float start=max(interval.x,cameraNear*length(view)/max(-view.z,.001));
  float finish=min(interval.y,sceneDistance(uv));
  if(finish<=start) return vec4(0.,0.,0.,1.);
  float ds=(finish-start)/96.;
  // Static screen dither avoids temporal sparkle and stays still with reduced motion.
  float jitter=fract(52.9829189*fract(dot(uv*vec2(textureSize(sceneDepth,0)),vec2(.06711056,.00583715))));
  float travel=start, transmission=1.;
  vec3 scatter=vec3(0.);
  float sunPhase=mix(phase(dot(ray,sunDirection),.62),phase(dot(ray,sunDirection),-.22),.85);
  for(int i=0;i<96;i++){
    if(travel>=finish || transmission<.008) break;
    vec3 p=eye+ray*(travel+jitter*ds);
    float cloud=density(p), stepLength=min(ds,finish-travel);
    if(cloud>.0001){
      float lit=sunlight(p), absorb=1.-exp(-cloud*stepLength*extinction);
      float altitude=clamp((p.y+920.)/1200.,0.,1.);
      vec3 ambient=vec3(.31,.43,.60)*mix(.62,1.18,altitude);
      vec3 light=ambient+sunColor*min(sunPower,1.35)*lit*(.52+sunPhase*1.45);
      light=mix(light,hazeColor,1.-exp(-travel*.000045));
      scatter+=transmission*absorb*light;
      transmission*=1.-absorb;
    }
    travel+=ds;
  }
  return vec4(scatter,transmission);
}
`;

/** Linear scene/depth -> true 3D density integration -> depth-aware display composite. */
export class VoyageClouds {
  private noise = cloudNoise();
  private sceneTarget = new T.WebGLRenderTarget(1, 1, { type: T.HalfFloatType, depthTexture: new T.DepthTexture(1, 1, T.UnsignedIntType), samples: 4 });
  private volumeTarget = new T.WebGLRenderTarget(1, 1, { type: T.HalfFloatType, depthBuffer: false, minFilter: T.NearestFilter, magFilter: T.NearestFilter });
  private uniforms = {
    noiseVolume: { value: this.noise }, sceneDepth: { value: this.sceneTarget.depthTexture },
    inverseProjection: { value: new T.Matrix4() }, cameraWorld: { value: new T.Matrix4() }, eye: { value: new T.Vector3() },
    sunDirection: { value: new T.Vector3(220, 380, 130).normalize() }, sunColor: { value: new T.Color('#fff3cf') },
    sunPower: { value: .95 }, hazeColor: { value: new T.Color('#d8e8ee') }, cloudTime: { value: 0 }, cameraNear: { value: 1 }, cameraFar: { value: 24000 },
  };
  private volume = new T.ShaderMaterial({ glslVersion: T.GLSL3, depthTest: false, depthWrite: false, uniforms: this.uniforms, vertexShader,
    fragmentShader: `${cloudShader}\nvoid main(){outColor=integrateClouds(screenUv);}` });
  private composite = new T.ShaderMaterial({ glslVersion: T.GLSL3, depthTest: true, depthWrite: true, depthFunc: T.AlwaysDepth,
    uniforms: { ...this.uniforms, sceneImage: { value: this.sceneTarget.texture }, volumeImage: { value: this.volumeTarget.texture } }, vertexShader,
    fragmentShader: `${cloudShader}
uniform sampler2D sceneImage, volumeImage;
#define gl_FragColor outColor
void main(){
  vec2 size=vec2(textureSize(volumeImage,0)), pixel=screenUv*size-.5, base=floor(pixel), fraction=fract(pixel);
  float reference=sceneDistance(screenUv), totalWeight=0.;
  vec4 volume=vec4(0.);
  // Bilateral 2x2 upscale. If an isolated foreground object has no matching low-res
  // sample, trace its own ray instead of bleeding clouds from behind its silhouette.
  for(int y=0;y<2;y++) for(int x=0;x<2;x++){
    vec2 offset=vec2(float(x),float(y)), uv=clamp((base+offset+.5)/size,.5/size,1.-.5/size);
    float sampleDistance=sceneDistance(uv), error=abs(sampleDistance-reference), tolerance=max(.15,reference*.003);
    float spatial=mix(1.-fraction.x,fraction.x,float(x))*mix(1.-fraction.y,fraction.y,float(y));
    float weight=spatial*exp(-error/tolerance)*step(error,tolerance*2.)*step(sampleDistance,reference);
    volume+=texture(volumeImage,uv)*weight; totalWeight+=weight;
  }
  volume=totalWeight>.02 ? volume/totalWeight : integrateClouds(screenUv);
  outColor=vec4(texture(sceneImage,screenUv).rgb*volume.a+volume.rgb,1.);
  gl_FragDepth=texture(sceneDepth,screenUv).r;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}` });
  private scene = new T.Scene();
  private camera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad = new T.Mesh(new T.PlaneGeometry(2, 2), this.volume);
  private lightTarget = new T.Vector3();
  private alive = true;
  constructor() { this.scene.add(this.quad); }
  /** Drawing-buffer pixels, after renderer.setSize; cloud work is capped at 640x360. */
  resize(width: number, height: number) {
    if (!this.alive || !Number.isFinite(width + height) || width < 1 || height < 1) return;
    width = Math.ceil(width); height = Math.ceil(height);
    this.sceneTarget.setSize(width, height);
    const scale = Math.min(.5, 640 / width, 360 / height);
    this.volumeTarget.setSize(Math.max(1, Math.ceil(width * scale)), Math.max(1, Math.ceil(height * scale)));
  }
  /** Only visible-frame delta is accepted; callers reset their previous RAF time on hide. */
  update(delta: number, reducedMotion = false, visible = true) {
    if (this.alive && visible && !reducedMotion && Number.isFinite(delta) && delta > 0) this.uniforms.cloudTime.value += Math.min(delta, .05);
  }
  render(renderer: T.WebGLRenderer, scene: T.Scene, camera: T.PerspectiveCamera, sun: T.DirectionalLight, cabin?: VoyageWindowLight) {
    if (!this.alive) return;
    const destination = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    const autoClear = renderer.autoClear, scissorTest = renderer.getScissorTest();
    try {
      renderer.autoClear = true; renderer.setScissorTest(false);
      renderer.setRenderTarget(this.sceneTarget); renderer.render(scene, camera);
      if (cabin) {
        renderer.setRenderTarget(destination, face, mip); renderer.setScissorTest(scissorTest);
        cabin.render(renderer, this.sceneTarget, camera, this.uniforms.cloudTime.value);
        return;
      }
      const u = this.uniforms;
      u.inverseProjection.value.copy(camera.projectionMatrixInverse); u.cameraWorld.value.copy(camera.matrixWorld); camera.getWorldPosition(u.eye.value);
      u.cameraNear.value = camera.near; u.cameraFar.value = camera.far;
      sun.getWorldPosition(u.sunDirection.value); sun.target.getWorldPosition(this.lightTarget); u.sunDirection.value.sub(this.lightTarget);
      if (u.sunDirection.value.lengthSq() < .000001) u.sunDirection.value.set(220, 380, 130);
      u.sunDirection.value.normalize(); u.sunColor.value.copy(sun.color); u.sunPower.value = Math.max(0, sun.intensity);
      if (scene.fog) u.hazeColor.value.copy(scene.fog.color);
      this.quad.material = this.volume; renderer.setRenderTarget(this.volumeTarget); renderer.render(this.scene, this.camera);
      this.quad.material = this.composite; renderer.setRenderTarget(destination, face, mip); renderer.setScissorTest(scissorTest); renderer.render(this.scene, this.camera);
    } finally {
      renderer.setRenderTarget(destination, face, mip); renderer.setScissorTest(scissorTest); renderer.autoClear = autoClear;
    }
  }
  destroy() {
    if (!this.alive) return;
    this.alive = false;
    this.sceneTarget.dispose(); this.volumeTarget.dispose(); this.noise.dispose();
    this.noise.image.data = new Uint8Array(0);
    this.quad.geometry.dispose(); this.volume.dispose(); this.composite.dispose(); this.scene.clear();
  }
}
