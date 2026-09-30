import * as T from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

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
      strength: { value: .024 }, time: { value: 0 },
    },
    vertexShader: `out vec2 screenUv;
      void main() { screenUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `precision highp sampler2DShadow;
      uniform sampler2D image, depth;
      uniform sampler2DShadow shadow;
      uniform mat4 inverseProjection, cameraWorld, shadowMatrix;
      uniform vec3 eye, sunDirection;
      uniform float strength;
      uniform float time;
      in vec2 screenUv;
      out vec4 outColor;
      float hash(vec3 p){p=fract(p*.3183099+.1);p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
      float noise3(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
      float cloud(vec3 p){
        vec3 q=p*.032+vec3(time*.006,0.,time*.003);
        float n=noise3(q)*.6+noise3(q*2.1)*.28+noise3(q*4.2)*.12;
        float layer=smoothstep(42.,49.,p.y)*(1.-smoothstep(69.,82.,p.y));
        return smoothstep(.45,.72,n)*layer;
      }
      void main() {
        vec4 view = inverseProjection * vec4(screenUv * 2.0 - 1.0, texture(depth, screenUv).r * 2.0 - 1.0, 1.0);
        vec3 end = (cameraWorld * vec4(view.xyz / view.w, 1.0)).xyz;
        vec3 ray = normalize(end - eye);
        float sceneLength=distance(end,eye),rayLength=min(sceneLength,140.);
        float stepSize=rayLength/32.;
        float jitter=fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453);
        vec3 scatter=vec3(0.);float transmission=1.;
        float phase=.35+pow(max(dot(ray,sunDirection),0.),8.)*1.8;
        float cloudLight=exp(-cloud(end+sunDirection*((55.-end.y)/max(sunDirection.y,.1)))*.7);
        // Height fog and low river mist share actual terrain/tree shadow visibility.
        for(int i=0;i<32;i++){
          vec3 p=eye+ray*(float(i)+jitter)*stepSize;
          vec4 projected=shadowMatrix*vec4(p,1.);vec3 s=projected.xyz/projected.w;
          float inside=step(0.,s.x)*step(s.x,1.)*step(0.,s.y)*step(s.y,1.)*step(0.,s.z)*step(s.z,1.);
          float lit=mix(1.,texture(shadow,vec3(clamp(s.xy,.001,.999),clamp(s.z-.0015,.001,.999))),inside);
          lit*=cloudLight;
          float valley=exp(-max(p.y-2.,0.)*.15),river=exp(-abs(p.z-52.)*.12)*exp(-max(p.y-1.,0.)*.3);
          float density=(valley*.5+river*.45+.035)*smoothstep(-3.,1.,p.y);
          float absorb=1.-exp(-density*stepSize*.008);
          scatter+=transmission*absorb*(vec3(.65,.79,.86)*.45+vec3(1.,.82,.56)*lit*phase*strength*125.);
          transmission*=1.-absorb;
        }
        // A separate 3D slab ray march: clouds have thickness, changing density and self-shadow.
        if(ray.y>.001){
          float start=max(0.,(42.-eye.y)/ray.y),finish=min(sceneLength,(82.-eye.y)/ray.y);
          if(finish>start){float ds=(finish-start)/32.;vec3 color=vec3(0.);float tr=1.;
            for(int i=0;i<32;i++){
              vec3 p=eye+ray*(start+(float(i)+jitter)*ds);float d=cloud(p);float a=1.-exp(-d*ds*.026);
              float shade=exp(-(cloud(p+sunDirection*8.)+cloud(p+sunDirection*20.))*.85);
              vec3 light=mix(vec3(.50,.63,.73),vec3(1.,.91,.77),shade);
              color+=tr*a*light;tr*=1.-a;if(tr<.01)break;
            }
            scatter+=transmission*color;transmission*=tr;
          }
        }
        outColor=vec4(scatter,transmission);
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
    u.time.value = performance.now()/1000;
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
