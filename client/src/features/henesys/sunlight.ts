import * as T from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { CLOUD_GLSL, type VillageEnvironment } from './environment';

/** Linear HDR → diffuse screen-space bounce/AO → depth-bounded volumes → one display conversion. */
export class Sunlight {
 private target=new T.WebGLRenderTarget(1,1,{type:T.HalfFloatType,depthTexture:new T.DepthTexture(1,1)});
 private scattering=new T.WebGLRenderTarget(1,1,{type:T.HalfFloatType,depthBuffer:false});
 private indirect=new T.WebGLRenderTarget(1,1,{type:T.HalfFloatType,depthBuffer:false});
 private bloom=new UnrealBloomPass(new T.Vector2(32,32),.11,.45,1.1);
 private scene=new T.Scene();private camera=new T.OrthographicCamera(-1,1,1,-1,0,1);
 private shared={image:{value:this.target.texture},depth:{value:this.target.depthTexture},inverseProjection:{value:new T.Matrix4()},projection:{value:new T.Matrix4()},cameraWorld:{value:new T.Matrix4()},eye:{value:new T.Vector3()},solarDirection:{value:new T.Vector3()},solarColor:{value:new T.Color()},weatherTime:{value:0},cloudCover:{value:.2},daylight:{value:1},solarPower:{value:1},fogDensity:{value:.00065},strength:{value:1},aurora:{value:0}};
 private material=new T.ShaderMaterial({glslVersion:T.GLSL3,depthTest:false,depthWrite:false,uniforms:{...this.shared,shadow:{value:null},shadowMatrix:{value:new T.Matrix4()}},
  vertexShader:`out vec2 screenUv;void main(){screenUv=uv;gl_Position=vec4(position.xy,0.,1.);}`,
  fragmentShader:`precision highp sampler2DShadow;
  uniform sampler2D image,depth;uniform sampler2DShadow shadow;uniform mat4 inverseProjection,cameraWorld,shadowMatrix;
  uniform vec3 eye,solarDirection,solarColor;uniform float weatherTime,cloudCover,daylight,solarPower,fogDensity,strength,aurora;
  in vec2 screenUv;out vec4 outColor;${CLOUD_GLSL}
  float visibility(vec3 p){vec4 q=shadowMatrix*vec4(p,1.);vec3 s=q.xyz/q.w;float inside=step(0.,s.x)*step(s.x,1.)*step(0.,s.y)*step(s.y,1.)*step(0.,s.z)*step(s.z,1.);return mix(1.,texture(shadow,vec3(clamp(s.xy,.001,.999),clamp(s.z-.0015,.001,.999))),inside);}
  float phase(float mu){float g=.62;return (1.-g*g)/pow(max(1.+g*g-2.*g*mu,.01),1.5)*.25;}
  void main(){
   float d=texture(depth,screenUv).r;vec4 view=inverseProjection*vec4(screenUv*2.-1.,d*2.-1.,1.);vec3 end=(cameraWorld*vec4(view.xyz/view.w,1.)).xyz;
   vec3 ray=normalize(end-eye);float sceneLength=d>.99999?10000.:distance(end,eye),rayLength=min(sceneLength,220.),ds=rayLength/40.;
   float jitter=fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453);
   vec3 scatter=vec3(0.);float transmission=1.;
   for(int i=0;i<40;i++){
    vec3 p=eye+ray*(float(i)+jitter)*ds;
    float valley=exp(-max(p.y-3.,0.)*.13),river=exp(-abs(p.z-52.)*.10)*exp(-max(p.y-2.,0.)*.3);
    float density=fogDensity*(valley*.45+river*.6+.10)*smoothstep(-4.,1.,p.y);
    float absorb=1.-exp(-density*ds*strength),lit=visibility(p)*cloudVisibility(p);
    vec3 ambient=mix(vec3(.015,.028,.065),vec3(.16,.25,.37),daylight);
    scatter+=transmission*absorb*(ambient+solarColor*lit*phase(dot(ray,solarDirection))*solarPower*1.5);transmission*=1.-absorb;
   }
   // Thick cloud slab with Beer-Lambert extinction, forward scattering and a sun-facing silver edge.
   if(ray.y>.001){float start=max(0.,(62.-eye.y)/ray.y),finish=min(sceneLength,(106.-eye.y)/ray.y);
    if(finish>start){float stepCloud=(finish-start)/48.;
     for(int i=0;i<48;i++){
      vec3 p=eye+ray*(start+(float(i)+jitter)*stepCloud);float density=cloudDensity(p),a=1.-exp(-density*stepCloud*.12*strength);
      float shade=exp(-(cloudDensity(p+solarDirection*7.)+cloudDensity(p+solarDirection*17.)+cloudDensity(p+solarDirection*31.))*1.8);
      vec3 ambient=mix(vec3(.006,.012,.028),vec3(.24,.34,.47),daylight);
      vec3 light=ambient+solarColor*shade*solarPower*(.26+phase(dot(ray,solarDirection))*.24);
      scatter+=transmission*a*light;transmission*=1.-a;if(transmission<.01)break;
     }
    }
    // Emissive northern-light curtains occupy a higher volume and remain behind cloud extinction.
    if(aurora>.001){float start=max(0.,(135.-eye.y)/ray.y),finish=min(sceneLength,(185.-eye.y)/ray.y);float stepAurora=max(0.,finish-start)/96.;
     for(int i=0;i<96;i++){vec3 p=eye+ray*(start+(float(i)+jitter)*stepAurora);float wave=sin(p.x*.018+noise3(vec3(p.x*.025,p.z*.025,weatherTime*.025))*4.);float curtain=pow(max(0.,1.-abs(sin(p.z*.012+wave*1.8))),12.);float h=clamp((p.y-135.)/50.,0.,1.);vec3 color=mix(vec3(.025,.65,.23),vec3(.23,.065,.52),h);scatter+=transmission*color*curtain*sin(h*3.14159)*stepAurora*.018*aurora;}
    }
   }
   outColor=vec4(scatter,transmission);
  }`});
 private gi=new T.ShaderMaterial({glslVersion:T.GLSL3,depthTest:false,depthWrite:false,uniforms:{...this.shared,bounce:{value:.24}},
  vertexShader:`out vec2 screenUv;void main(){screenUv=uv;gl_Position=vec4(position.xy,0.,1.);}`,
  fragmentShader:`uniform sampler2D image,depth;uniform mat4 inverseProjection,projection;uniform float bounce;in vec2 screenUv;out vec4 outColor;
  vec3 point(vec2 uv){vec4 p=inverseProjection*vec4(uv*2.-1.,texture(depth,uv).r*2.-1.,1.);return p.xyz/p.w;}
  void main(){if(texture(depth,screenUv).r>.99999){outColor=vec4(0.,0.,0.,1.);return;}vec3 p=point(screenUv);vec3 n=normalize(cross(dFdx(p),dFdy(p)));if(dot(n,-p)<0.)n=-n;
   vec3 tangent=normalize(cross(n,abs(n.y)>.9?vec3(1,0,0):vec3(0,1,0))),bitangent=cross(n,tangent),indirectLight=vec3(0.);float occlusion=0.;
   // One visible-surface bounce, bounded to 9 hemisphere rays × 5 steps. Off-screen energy comes from the sky probe.
   for(int i=0;i<9;i++){float a=(float(i)+.5)*2.3999632,r=sqrt((float(i)+.5)/9.);vec3 direction=normalize(tangent*cos(a)*r+bitangent*sin(a)*r+n*sqrt(1.-r*r));
    for(int j=0;j<5;j++){float travel=.3*pow(1.85,float(j));vec3 q=p+n*.08+direction*travel;vec4 projected=projection*vec4(q,1.);vec2 uv=projected.xy/projected.w*.5+.5;if(any(lessThan(uv,vec2(0.)))||any(greaterThan(uv,vec2(1.))))break;
     vec3 hit=point(uv);float gap=hit.z-q.z;
     if(gap>.035&&gap<.65&&distance(hit,q)<1.){vec3 radiance=min(texture(image,uv).rgb,vec3(4.));indirectLight+=radiance*max(dot(n,direction),0.)/(1.+travel*travel*.22);occlusion+=1./(1.+travel*travel*.45);break;}
    }
   }
   outColor=vec4(indirectLight*bounce/9.,1.-min(.38,occlusion*.055));
  }`});
 private composite=new T.ShaderMaterial({glslVersion:T.GLSL3,depthTest:true,depthWrite:true,depthFunc:T.AlwaysDepth,
  uniforms:{image:this.shared.image,depth:this.shared.depth,scattering:{value:this.scattering.texture},indirect:{value:this.indirect.texture},grade:{value:0}},
  vertexShader:`out vec2 screenUv;void main(){screenUv=uv;gl_Position=vec4(position.xy,0.,1.);}`,
  fragmentShader:`uniform sampler2D image,depth,scattering,indirect;uniform float grade;in vec2 screenUv;out vec4 outColor;
  #define gl_FragColor outColor
  void main(){vec4 volume=texture(scattering,screenUv),gi=texture(indirect,screenUv);vec3 color=texture(image,screenUv).rgb*gi.a+gi.rgb;color=color*volume.a+volume.rgb;color=mix(color,vec3(dot(color,vec3(.2126,.7152,.0722))),grade);outColor=vec4(color,1.);gl_FragDepth=texture(depth,screenUv).r;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  }`});
 private quad=new T.Mesh(new T.PlaneGeometry(2,2),this.material);
 constructor(){this.scene.add(this.quad);}
 resize(width:number,height:number,quality=true){this.target.setSize(width,height);const scale=quality?2:4;this.scattering.setSize(Math.ceil(width/scale),Math.ceil(height/scale));this.indirect.setSize(Math.ceil(width/scale),Math.ceil(height/scale));this.bloom.setSize(Math.ceil(width/2),Math.ceil(height/2));}
 render(renderer:T.WebGLRenderer,scene:T.Scene,camera:T.PerspectiveCamera,sun:T.DirectionalLight,environment:VillageEnvironment){
  renderer.setRenderTarget(this.target);renderer.render(scene,camera);
  const u=this.material.uniforms,l=environment.light;
  u.weatherTime.value=environment.uniforms.weatherTime.value;u.shadow.value=sun.shadow.map!.depthTexture;u.shadowMatrix.value.copy(sun.shadow.matrix);u.inverseProjection.value.copy(camera.projectionMatrixInverse);u.projection.value.copy(camera.projectionMatrix);u.cameraWorld.value.copy(camera.matrixWorld);u.eye.value.copy(camera.position);u.solarDirection.value.copy(environment.uniforms.solarDirection.value);u.solarColor.value.copy(sun.color);u.solarPower.value=sun.intensity;u.daylight.value=l.daylight;u.cloudCover.value=l.cover;u.fogDensity.value=l.fog;u.aurora.value=environment.settings.weather==='aurora'?1-l.daylight:0;
  this.composite.uniforms.grade.value=environment.settings.grade;
  // GI samples radiance before bloom; sky/sun/lamps bloom while pixel art stays outside these passes.
  this.quad.material=this.gi;renderer.setRenderTarget(this.indirect);renderer.render(this.scene,this.camera);
  this.bloom.render(renderer,this.target,this.target,0,false);
  this.quad.material=this.material;renderer.setRenderTarget(this.scattering);renderer.render(this.scene,this.camera);
  this.quad.material=this.composite;renderer.setRenderTarget(null);renderer.render(this.scene,this.camera);
 }
 destroy(){this.target.dispose();this.indirect.dispose();this.scattering.dispose();this.bloom.dispose();this.quad.geometry.dispose();this.material.dispose();this.gi.dispose();this.composite.dispose();}
}
