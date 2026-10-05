import * as T from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { environmentLight, environmentSettings, loadEnvironment, saveEnvironment, type EnvironmentSettings } from './environment-settings';
import { SolarGlow } from './solar-glow';

// Shared field: visible clouds and the shadows on buildings sample the same drifting volume.
export const CLOUD_GLSL=`
float hash3(vec3 p){p=fract(p*.3183099+.1);p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float noise3(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(hash3(i),hash3(i+vec3(1,0,0)),f.x),mix(hash3(i+vec3(0,1,0)),hash3(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash3(i+vec3(0,0,1)),hash3(i+vec3(1,0,1)),f.x),mix(hash3(i+vec3(0,1,1)),hash3(i+vec3(1,1,1)),f.x),f.y),f.z);}
float cloudDensity(vec3 p){vec3 q=p*.027+vec3(weatherTime*.004,0.,weatherTime*.002);float n=noise3(q)*.58+noise3(q*2.03)*.28+noise3(q*4.07)*.14;float erosion=(1.-noise3(q*8.1))*.07;float shape=clamp((n-(.68-cloudCover*.31))*5.4-erosion,0.,1.);return shape*smoothstep(62.,69.,p.y)*(1.-smoothstep(94.,106.,p.y));}
float cloudVisibility(vec3 p){if(solarDirection.y<=0.)return 1.;vec3 q=p+solarDirection*max(0.,(79.-p.y)/max(solarDirection.y,.08));return exp(-cloudDensity(q)*3.2/max(solarDirection.y,.25));}`;

/** One sun owns the visible disk, shadow camera, sky, material response and atmospheric scattering. */
export class VillageEnvironment {
 settings=loadEnvironment();
 light=environmentLight(this.settings);
 sky=new Sky();
 skyScene=new T.Scene();
 hemisphere=new T.HemisphereLight();
 moon=new T.DirectionalLight(0x8daeff,0);
 private solarDisk=new SolarGlow(490);
 private stars:T.Points;
 private precipitation:T.Points;
 private rain:T.LineSegments;
 private lamps:T.PointLight[]=[];
 private materials=new Map<T.MeshStandardMaterial,{color:T.Color;roughness:number;metalness:number;emissive:T.Color;vegetation:boolean;ground:boolean}>();
 uniforms={weatherTime:{value:0},solarDirection:{value:new T.Vector3()},cloudCover:{value:.2},wetness:{value:0},winterSnow:{value:0}};
 private dirty=true;
 constructor(private scene:T.Scene,private sun:T.DirectionalLight,model:T.Object3D){
  this.sky.scale.setScalar(550);
  this.sky.material.uniforms.night={value:0};
  this.sky.material.fragmentShader=this.sky.material.fragmentShader.replace('uniform float showSunDisc;','uniform float showSunDisc;\nuniform float night;').replace('vec4( texColor, 1.0 )','vec4(mix(texColor*.10,vec3(.0008,.0015,.004),night),1.0)');
  this.sky.material.uniforms.showSunDisc.value=0;this.sky.material.uniforms.cloudCoverage.value=0;
  const capture=new T.Mesh(this.sky.geometry,this.sky.material);capture.scale.copy(this.sky.scale);this.skyScene.add(capture);
  scene.add(this.sky,this.solarDisk,this.hemisphere,this.moon,this.moon.target);
  // Fixed stars and GPU precipitation have no per-frame particle allocation or CPU simulation.
  let seed=273;const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};
  const starGeometry=new T.BufferGeometry(),stars=new Float32Array(1800*3);
  for(let i=0;i<1800;i++){const y=random()*.96+.04,a=random()*Math.PI*2,r=Math.sqrt(1-y*y);stars.set([Math.cos(a)*r*520,y*520,Math.sin(a)*r*520],i*3);}
  starGeometry.setAttribute('position',new T.BufferAttribute(stars,3));
  const starMaterial=new T.ShaderMaterial({transparent:true,depthWrite:false,uniforms:{night:{value:0},time:{value:0},pixelRatio:{value:1}},
   vertexShader:`uniform float time,pixelRatio;varying float brightness;void main(){brightness=.55+.45*sin(time*.7+position.x*7.);vec4 p=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*p;gl_PointSize=(1.2+fract(position.x)*1.5)*pixelRatio;}`,
   fragmentShader:`uniform float night;varying float brightness;void main(){float a=(1.-smoothstep(.1,.5,length(gl_PointCoord-.5)))*night*brightness;gl_FragColor=vec4(vec3(.72,.83,1.)*2.,a);}`});
  this.stars=new T.Points(starGeometry,starMaterial);scene.add(this.stars);
  const geometry=new T.BufferGeometry(),positions=new Float32Array(1800*3);for(let i=0;i<1800;i++)positions.set([random()*100-50,random()*65,random()*100-50],i*3);geometry.setAttribute('position',new T.BufferAttribute(positions,3));
  this.precipitation=new T.Points(geometry,new T.ShaderMaterial({transparent:true,depthWrite:false,uniforms:{time:{value:0},center:{value:new T.Vector3()},snow:{value:0},amount:{value:0},pixelRatio:{value:1}},
   vertexShader:`uniform float time,snow,pixelRatio;uniform vec3 center;varying float seed;void main(){seed=fract(position.x*7.);vec3 p=position;float speed=mix(24.,2.8,snow);p.y=mod(p.y-time*speed,65.)-8.;p.x+=mix(time*1.8,sin(time*.7+position.z)*2.,snow);p.x=mod(p.x+50.,100.)-50.;p+=center;vec4 v=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*v;gl_PointSize=clamp(mix(2.8,4.8,snow)*pixelRatio*22./max(-v.z,5.),1.,12.);}`,
   fragmentShader:`uniform float snow,amount;varying float seed;void main(){if(seed>amount)discard;vec2 p=gl_PointCoord-.5;float a=mix((1.-smoothstep(.04,.14,abs(p.x)))*(1.-smoothstep(.2,.5,abs(p.y))),1.-smoothstep(.2,.5,length(p)),snow);gl_FragColor=vec4(mix(vec3(.54,.67,.82),vec3(.92,.96,1.),snow),a*mix(.6,.9,snow));}`}));
  this.precipitation.frustumCulled=false;scene.add(this.precipitation);
  const rainGeometry=new T.BufferGeometry(),rainPositions=new Float32Array(positions.length*2),trails=new Float32Array(1800*2);
  for(let i=0;i<1800;i++){rainPositions.set(positions.subarray(i*3,i*3+3),i*6);rainPositions.set(positions.subarray(i*3,i*3+3),i*6+3);trails[i*2+1]=1;}
  rainGeometry.setAttribute('position',new T.BufferAttribute(rainPositions,3));rainGeometry.setAttribute('trail',new T.BufferAttribute(trails,1));
  this.rain=new T.LineSegments(rainGeometry,new T.ShaderMaterial({transparent:true,depthWrite:false,uniforms:(this.precipitation.material as T.ShaderMaterial).uniforms,
   vertexShader:`uniform float time;uniform vec3 center;attribute float trail;varying float seed;void main(){seed=fract(position.x*7.);vec3 p=position;p.y=mod(p.y-time*24.,65.)-8.-trail*1.15;p.x=mod(p.x+time*1.8+50.,100.)-50.+trail*.10;gl_Position=projectionMatrix*modelViewMatrix*vec4(p+center,1.);}`,
   fragmentShader:`uniform float amount;varying float seed;void main(){if(seed>amount)discard;gl_FragColor=vec4(.5,.65,.82,.34);}`}));
  this.rain.frustumCulled=false;scene.add(this.rain);
  for(const position of [[-34,5.2,25],[30,25.2,-18],[12,3.4,43]]){const lamp=new T.PointLight(0xffbc6c,0,15,2);lamp.position.set(...position as [number,number,number]);scene.add(lamp);this.lamps.push(lamp);}
  model.traverse(o=>{if(!(o instanceof T.Mesh))return;let p:T.Object3D|null=o,layer='';while(p&&!layer){layer=p.userData.layer??'';p=p.parent;}
   for(const material of Array.isArray(o.material)?o.material:[o.material]){if(!(material instanceof T.MeshStandardMaterial)||this.materials.has(material))continue;
    this.materials.set(material,{color:material.color.clone(),roughness:material.roughness,metalness:material.metalness,emissive:material.emissive.clone(),vegetation:layer==='vegetation',ground:['terrain','roads'].includes(layer)});
    const previous=material.onBeforeCompile.bind(material),key=material.customProgramCacheKey.bind(material);
    material.customProgramCacheKey=()=>key()+'-climate-v1';
    material.onBeforeCompile=(shader,renderer)=>{previous(shader,renderer);Object.assign(shader.uniforms,this.uniforms);
     shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 weatherPosition;').replace('#include <project_vertex>','#include <project_vertex>\nvec4 weatherVertex=vec4(transformed,1.);\n#ifdef USE_INSTANCING\nweatherVertex=instanceMatrix*weatherVertex;\n#endif\nweatherPosition=(modelMatrix*weatherVertex).xyz;');
     shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>\nvarying vec3 weatherPosition;uniform float weatherTime,cloudCover,wetness,winterSnow;uniform vec3 solarDirection;${CLOUD_GLSL}`)
      .replace('#include <color_fragment>','#include <color_fragment>\n#ifdef FLAT_SHADED\nvec3 weatherNormal=normalize(cross(dFdx(weatherPosition),dFdy(weatherPosition)));\n#else\nvec3 weatherNormal=inverseTransformDirection(normalize(vNormal),viewMatrix);\n#endif\nfloat upward=clamp(weatherNormal.y,0.,1.);diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.88,.93,.98),winterSnow*smoothstep(.45,.85,upward));')
      .replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\nroughnessFactor=mix(roughnessFactor,max(.12,roughnessFactor*.35),wetness*upward);')
      .replace('#include <lights_fragment_begin>',T.ShaderChunk.lights_fragment_begin.replace('getDirectionalLightInfo( directionalLight, directLight );','getDirectionalLightInfo( directionalLight, directLight );\ndirectLight.color*=cloudVisibility(weatherPosition);'));
    };material.needsUpdate=true;
   }
  });
  this.apply();
 }
 set(value:Partial<EnvironmentSettings>){this.settings=environmentSettings({...this.settings,...value});saveEnvironment(this.settings);this.light=environmentLight(this.settings);this.apply();this.dirty=true;}
 private apply(){
  const l=this.light,u=this.uniforms,night=1-l.daylight;u.solarDirection.value.set(...l.direction);u.cloudCover.value=l.cover;u.wetness.value=l.wet;// SnowSurface supplies the same accumulated coverage used by geometry and footsteps.
  const warmth=1-T.MathUtils.smoothstep(l.direction[1],0,.5);
  this.sun.color.set(0xfff3df).lerp(new T.Color(0xff8a3c),warmth*.72);this.sun.intensity=l.sunlight*4.5*(1-l.cover*.55);
  this.hemisphere.color.set(0xa1c6f4).lerp(new T.Color(0xffbb95),warmth*.28);this.hemisphere.groundColor.set(0x45482c);this.hemisphere.intensity=.08+l.daylight*.50;
  this.moon.intensity=night*.16;this.moon.position.set(...l.direction).multiplyScalar(-150);this.moon.target.position.set(0,0,0);
  this.solarDisk.update(new T.Vector3(),u.solarDirection.value,this.sun.color,this.sun.intensity);
  const sky=this.sky.material.uniforms;sky.sunPosition.value.copy(u.solarDirection.value).multiplyScalar(450000);sky.turbidity.value=2.3+l.cover*4;sky.rayleigh.value=1.9;sky.mieCoefficient.value=.004+l.wet*.003;sky.mieDirectionalG.value=.82;sky.night.value=night;
  (this.stars.material as T.ShaderMaterial).uniforms.night.value=night*(1-l.cover*.88);
  const p=(this.precipitation.material as T.ShaderMaterial).uniforms;p.snow.value=l.snow;p.amount.value=Math.max(l.rain,l.snow);this.precipitation.visible=p.amount.value>0;this.rain.visible=l.rain>0;
  for(const lamp of this.lamps)lamp.intensity=night*12;
  for(const [material,base] of this.materials){material.color.copy(base.color);if(base.vegetation&&/Leaves|Flowers/i.test(material.name)){const tint={spring:0xb8e5a1,summer:0x83b75f,autumn:0xef9b52,winter:0xb1c4cb}[this.settings.season];material.color.lerp(new T.Color(tint),.55);}if(base.ground)material.color.multiplyScalar(1-l.wet*.16);material.emissive.copy(base.emissive);if(/CE_window/i.test(material.name))material.emissive.add(new T.Color(0xffa953).multiplyScalar(night*.75));}
  this.sun.shadow.needsUpdate=true;
 }
 consumeSkyChange(){const dirty=this.dirty;this.dirty=false;return dirty;}
 update(center:T.Vector3,time:number,ratio:number,eye:T.Vector3){this.uniforms.weatherTime.value=time;this.solarDisk.update(eye,this.uniforms.solarDirection.value,this.sun.color,this.sun.intensity);this.stars.position.copy(center);const s=(this.stars.material as T.ShaderMaterial).uniforms;s.time.value=time;s.pixelRatio.value=ratio;const p=(this.precipitation.material as T.ShaderMaterial).uniforms;p.time.value=time;p.center.value.copy(center);p.pixelRatio.value=ratio;}
 destroy(){this.sky.geometry.dispose();this.sky.material.dispose();this.solarDisk.destroy();this.stars.geometry.dispose();(this.stars.material as T.Material).dispose();this.precipitation.geometry.dispose();(this.precipitation.material as T.Material).dispose();this.rain.geometry.dispose();(this.rain.material as T.Material).dispose();this.materials.clear();}
}
