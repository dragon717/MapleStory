import * as T from 'three';

/** HDR sun and atmospheric aureole, occluded by geometry and the existing cloud volume. */
export class SolarGlow extends T.Mesh<T.PlaneGeometry, T.ShaderMaterial> {
  constructor(private distance: number) {
    super(new T.PlaneGeometry(2, 2), new T.ShaderMaterial({
      transparent: true, blending: T.AdditiveBlending, depthWrite: false,
      uniforms: { solarColor: { value: new T.Color() }, power: { value: 1 } },
      vertexShader: 'varying vec2 solarUv;void main(){solarUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: `uniform vec3 solarColor;uniform float power;varying vec2 solarUv;
      void main(){
        float radius=length(solarUv*2.-1.),r2=radius*radius;
        float disk=1.-smoothstep(.033-fwidth(radius),.033+fwidth(radius),radius);
        float glow=1.6*exp(-r2*500.)+.32*exp(-r2*45.)+.055*exp(-r2*5.);
        vec3 color=mix(solarColor,vec3(1.),disk*.55);
        gl_FragColor=vec4(color*(disk*16.+glow)*power,1.-smoothstep(.8,1.,radius));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    }));
    this.name = 'SolarGlow'; this.scale.setScalar(distance * .16); this.frustumCulled = false;
  }
  update(center: T.Vector3, direction: T.Vector3, color: T.Color, intensity: number) {
    this.visible = direction.y > -.02 && intensity > 0;
    this.position.copy(center).addScaledVector(direction, this.distance);
    this.quaternion.setFromUnitVectors(new T.Vector3(0, 0, 1), direction.clone().negate());
    this.material.uniforms.solarColor.value.copy(color);
    this.material.uniforms.power.value = Math.max(0, intensity) / 3;
  }
  destroy() { this.removeFromParent(); this.geometry.dispose(); this.material.dispose(); }
}
