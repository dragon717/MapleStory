import * as T from 'three';

export type ShipControls = { sail: number; wind: number; throttle: number; steering: number };
const bounded = (value: number, min: number, max: number, fallback: number) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

/** P entry simulation: local forces and display only; no world or account state. */
export class ShipFlight {
  controls: ShipControls = { sail: 1, wind: 8, throttle: .5, steering: 0 };
  deployment = 1;
  steering = 0;
  thrust = 0;
  speed = 0;
  heading = 0;
  wheelAngle = 0;
  time = 0;
  position = new T.Vector3();
  trial = false;
  private manualSail=false;
  private parts: { node: T.Object3D; rest: T.Quaternion; kind: string; fold: number; morphs: T.Mesh[] }[] = [];
  private nozzles: T.MeshStandardMaterial[] = [];
  constructor(root?: T.Object3D) {
    root?.traverse(node => {
      if (!node.userData.rig_kind) return;
      const morphs: T.Mesh[] = [];
      node.traverse(child => {
        if (!(child instanceof T.Mesh)) return;
        if (child.morphTargetDictionary) morphs.push(child);
        if (node.userData.rig_kind === 'nozzle') {
          const clone = (material: T.Material) => {
            const next = material.clone() as T.MeshStandardMaterial;
            if (next.isMeshStandardMaterial) { next.emissive.set('#168fae'); this.nozzles.push(next); }
            return next;
          };
          child.material = Array.isArray(child.material) ? child.material.map(clone) : clone(child.material);
        }
      });
      this.parts.push({ node, rest: node.quaternion.clone(), kind: node.userData.rig_kind, fold: Number(node.userData.fold_angle) || 0, morphs });
    });
  }
  setControls(input: Partial<ShipControls>) {
    if(input.sail!==undefined)this.manualSail=true;
    for (const key of ['sail', 'wind', 'throttle', 'steering'] as const) {
      if (input[key] !== undefined) this.controls[key] = bounded(input[key], key === 'steering' ? -1 : 0, key === 'wind' ? 16 : 1, this.controls[key]);
    }
  }
  setTrial(enabled: boolean) {
    this.trial = enabled;
    this.position.set(0, 0, 0); this.heading = 0; this.speed = 0;
  }
  update(delta: number, snap = false) {
    const dt = Number.isFinite(delta) ? Math.max(0, Math.min(delta, .05)) : 0;
    this.time += dt;
    const blend = snap ? 1 : 1 - Math.exp(-dt * 3);
    const sail=this.manualSail?this.controls.sail:.72+.28*(.5+.5*Math.cos(this.time*.35));
    this.deployment += (sail - this.deployment) * blend;
    this.steering += (this.controls.steering - this.steering) * blend;
    // ponytail: calibrated force/drag model for the entry preview; World owns future multiplayer navigation.
    this.thrust = 18 * this.controls.throttle + .22 * this.controls.wind ** 2 * (.18 + .82 * this.deployment);
    this.speed = Math.max(0, this.speed + (this.thrust - 2 * this.speed) * dt / 8);
    this.wheelAngle = (this.wheelAngle + this.controls.wind * this.deployment * dt * .17) % (2 * Math.PI);
    if (this.trial) {
      this.heading -= this.steering * .08 * (.3 + .7 * Math.min(1, this.speed / 8)) * dt;
      this.position.x -= Math.sin(this.heading) * this.speed * dt;
      this.position.z -= Math.cos(this.heading) * this.speed * dt;
    }
    const pressure = Math.min(1, this.controls.wind ** 2 / 64 * this.deployment * (.5 + .08 * Math.sin(this.time * 1.8)));
    for (const part of this.parts) {
      const fold = part.kind === 'rudder' ? part.fold * (1 - this.deployment) : part.kind === 'wheel' ? this.wheelAngle : 0;
      const yaw = ['rudder', 'steering', 'nozzle'].includes(part.kind) ? -this.steering * .38 : 0;
      part.node.quaternion.copy(part.rest).multiply(new T.Quaternion().setFromEuler(new T.Euler(fold, yaw, 0)));
      for (const mesh of part.morphs) {
        const dictionary = mesh.morphTargetDictionary!, values = mesh.morphTargetInfluences!;
        if (dictionary.DeployFold !== undefined) values[dictionary.DeployFold] = 1 - this.deployment;
        if (dictionary.WindPressure !== undefined) values[dictionary.WindPressure] = part.node.userData.cloth_canvas_vertex_start===0?0:pressure;
      }
    }
    for (const material of this.nozzles) material.emissiveIntensity = .08 + this.controls.throttle * .8;
  }
}
