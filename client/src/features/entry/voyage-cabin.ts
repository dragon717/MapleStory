import * as T from 'three';

/** Resolve authored cabin coordinates through its exported orientation. */
export function cabinPoint(model: T.Object3D, carrier: T.Object3D, point: T.Vector3) {
  const cabin = model.getObjectByName('SV3_CabinInterior');
  return cabin ? carrier.worldToLocal(cabin.localToWorld(point.clone())) : point.clone();
}

export function berthAislePoint(model: T.Object3D, carrier: T.Object3D, index: number) {
  const anchor = model.getObjectByName(`SV2_Bed_${index}_FootAnchor`);
  return anchor ? carrier.worldToLocal(anchor.localToWorld(new T.Vector3(0, 0, .6))) : undefined;
}

export function cabinRotation(model: T.Object3D, carrier: T.Object3D) {
  const cabin = model.getObjectByName('SV3_CabinInterior');
  return carrier.getWorldQuaternion(new T.Quaternion()).invert().multiply(cabin?.getWorldQuaternion(new T.Quaternion()) ?? carrier.getWorldQuaternion(new T.Quaternion()));
}
