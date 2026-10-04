import * as T from 'three';

/** Four authored glass projectors share their maps and shadow matrices with the cabin haze. */
export class VoyageWindowLight {
  readonly lights: T.SpotLight[] = [];
  private scene = new T.Scene();
  private camera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private uniforms: Record<string, T.IUniform> = {
    image: { value: null }, depth: { value: null }, inverseProjection: { value: new T.Matrix4() },
    cameraWorld: { value: new T.Matrix4() }, shipInverse: { value: new T.Matrix4() }, eye: { value: new T.Vector3() }, time: { value: 0 },
  };
  private material: T.ShaderMaterial;
  private quad: T.Mesh;
  constructor(private ship: T.Object3D, model: T.Object3D, parent: T.Group) {
    ship.updateWorldMatrix(true, false);
    const scale = ship.getWorldScale(new T.Vector3()).x;
    this.uniforms.beamRange = { value: 90 * scale };
    for (const [i, name] of ['warrior', 'mage', 'archer', 'rogue'].entries()) {
      const glass = model.getObjectByName(`SV3_StainedGlass_${name}`) as T.Mesh<T.BufferGeometry, T.MeshStandardMaterial>;
      if (!glass?.material.map) throw new Error(`Missing stained-glass window: ${name}`);
      glass.castShadow = false; glass.receiveShadow = false;
      const x = -8.1 + i * 5.4, light = new T.SpotLight('#ffffff', 9000 * scale * scale, 90 * scale, .056, .05, 2);
      light.position.set(x + 2.94, 19.31, -10); light.target.position.set(x - .7, -.65, 42.8);
      light.map = glass.material.map;
      light.castShadow = true; light.shadow.mapSize.set(512, 768); light.shadow.camera.near = 30 * scale;
      light.shadow.bias = -.0001; light.shadow.normalBias = .018;
      parent.add(light, light.target); this.lights.push(light);
      this.uniforms[`glass${i}`] = { value: light.map }; this.uniforms[`shadow${i}`] = { value: null };
      this.uniforms[`matrix${i}`] = { value: light.shadow.matrix };
    }
    const declarations = this.lights.map((_, i) => `uniform sampler2D glass${i}; uniform sampler2DShadow shadow${i}; uniform mat4 matrix${i};`).join('\n');
    const beams = this.lights.map((_, i) => `{
      vec4 q=matrix${i}*vec4(p,1.);vec3 s=q.xyz/q.w;
      if(all(greaterThan(s,vec3(0.)))&&all(lessThan(s,vec3(1.)))){
        vec4 glass=texture(glass${i},s.xy);
        light+=glass.rgb*glass.a*texture(shadow${i},vec3(s.xy,s.z-.00015));
      }
    }`).join('\n');
    this.material = new T.ShaderMaterial({ glslVersion: T.GLSL3, depthTest: true, depthWrite: true, depthFunc: T.AlwaysDepth,
      uniforms: this.uniforms,
      vertexShader: 'out vec2 screenUv;void main(){screenUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
      fragmentShader: `precision highp sampler2DShadow;
      uniform sampler2D image,depth;uniform mat4 inverseProjection,cameraWorld,shipInverse;uniform vec3 eye;uniform float time,beamRange;
      ${declarations}
      in vec2 screenUv;out vec4 outColor;
      #define gl_FragColor outColor
      vec2 interval(vec3 o,vec3 d){
        vec2 span=vec2(0.,beamRange);vec3 lo=vec3(-13.3,.08,32.),hi=vec3(13.3,6.,48.);
        for(int a=0;a<3;a++){
          if(abs(d[a])<.000001){if(o[a]<lo[a]||o[a]>hi[a])return vec2(1.,0.);}
          else{vec2 hit=vec2(lo[a]-o[a],hi[a]-o[a])/d[a];span.x=max(span.x,min(hit.x,hit.y));span.y=min(span.y,max(hit.x,hit.y));}
        }return span;
      }
      void main(){
        float d=texture(depth,screenUv).r;vec4 v=inverseProjection*vec4(screenUv*2.-1.,d*2.-1.,1.);
        vec3 end=(cameraWorld*vec4(v.xyz/v.w,1.)).xyz,ray=normalize(end-eye);
        vec3 origin=(shipInverse*vec4(eye,1.)).xyz,direction=(shipInverse*vec4(ray,0.)).xyz;
        vec2 span=interval(origin,direction);span.y=min(span.y,distance(end,eye));
        float stepLength=max(0.,span.y-span.x)/32.,transmission=1.;vec3 scatter=vec3(0.);
        float jitter=fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(.06711056,.00583715))));
        // ponytail: 32 bounded samples; a lower-resolution bilateral pass is only needed if GPU timing requires it.
        for(int i=0;i<32;i++){
          if(stepLength<=0.)break;
          vec3 p=eye+ray*(span.x+(float(i)+jitter)*stepLength),local=(shipInverse*vec4(p,1.)).xyz;
          vec3 light=vec3(0.);${beams}
          float dust=.022*(.85+.15*sin(local.x*5.+local.y*3.+local.z*2.+time*.18));
          float absorb=1.-exp(-dust*stepLength);
          scatter+=transmission*absorb*light*1.65;transmission*=1.-absorb;
        }
        outColor=vec4(texture(image,screenUv).rgb*transmission+scatter,1.);gl_FragDepth=d;
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }` });
    this.quad = new T.Mesh(new T.PlaneGeometry(2, 2), this.material); this.scene.add(this.quad);
  }
  render(renderer: T.WebGLRenderer, target: T.WebGLRenderTarget, camera: T.PerspectiveCamera, time: number) {
    const u = this.uniforms;
    u.image.value = target.texture; u.depth.value = target.depthTexture;
    u.inverseProjection.value.copy(camera.projectionMatrixInverse); u.cameraWorld.value.copy(camera.matrixWorld);
    u.shipInverse.value.copy(this.ship.matrixWorld).invert(); camera.getWorldPosition(u.eye.value); u.time.value = time;
    this.lights.forEach((light, i) => { u[`shadow${i}`].value = light.shadow.map?.depthTexture; });
    renderer.render(this.scene, this.camera);
  }
  destroy() {
    this.lights.forEach(light => { light.dispose(); light.removeFromParent(); light.target.removeFromParent(); });
    this.lights.length = 0; this.quad.geometry.dispose(); this.material.dispose(); this.scene.clear();
  }
}
