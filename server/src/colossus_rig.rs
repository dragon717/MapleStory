//! Blender's exported rest skeleton is also the server's carrier geometry.
//! Pose angles are program-controlled radians; meshes keep rigid stone weights.
use super::motion::{add, sub, V3};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::OnceLock};
pub type Q4 = [f64; 4];
pub type Pose = BTreeMap<String, f64>;
pub fn multiply(a: Q4, b: Q4) -> Q4 {
    [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ]
}
pub fn inverse(q: Q4) -> Q4 {
    [-q[0], -q[1], -q[2], q[3]]
}
pub fn turn(q: Q4, v: V3) -> V3 {
    let r = multiply(multiply(q, [v[0], v[1], v[2], 0.0]), inverse(q));
    [r[0], r[1], r[2]]
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Transform {
    pub position: V3,
    pub rotation: Q4,
}
impl Transform {
    pub fn point(&self, p: V3) -> V3 {
        add(self.position, turn(self.rotation, p))
    }
    pub fn local(&self, p: V3) -> V3 {
        turn(inverse(self.rotation), sub(p, self.position))
    }
    fn compose(&self, b: &Self) -> Self {
        Self {
            position: self.point(b.position),
            rotation: multiply(self.rotation, b.rotation),
        }
    }
}
#[derive(Deserialize)]
struct Bone {
    name: String,
    parent: Option<String>,
    position: V3,
    rotation: Q4,
    flex: [f64; 2],
}
#[derive(Deserialize)]
struct Rig {
    bones: Vec<Bone>,
}
fn rig() -> &'static Rig {
    static RIG: OnceLock<Rig> = OnceLock::new();
    RIG.get_or_init(|| {
        serde_json::from_str(include_str!("../../shared/colossus-rig.json")).expect("Blender rig")
    })
}
pub fn sample(seconds: f64) -> (Pose, BTreeMap<String, Transform>) {
    let awake = ((seconds - 30.0) / 35.0).clamp(0.0, 1.0);
    let wave = ((seconds - 65.0).max(0.0) / 13.0).sin();
    let mut pose = Pose::new();
    // Tiny torso motion at continental scale still moves occupied districts by metres.
    for (name, angle) in [
        ("chest", wave * 0.000015),
        ("head", awake * (0.025 + wave * 0.012)),
        ("upper_arm.R", -awake * (0.02 + wave * 0.01)),
        ("forearm.R", -awake * (0.11 + wave * 0.04)),
        ("hand.R", -awake * 0.025),
    ] {
        pose.insert(name.into(), angle);
    }
    for finger in ["index", "middle", "ring", "little", "thumb"] {
        for segment in 1..=3 {
            pose.insert(
                format!("{finger}.{segment}.R"),
                -awake * (0.08 + wave * 0.025),
            );
        }
    }
    let mut rest: BTreeMap<String, Transform> = BTreeMap::new();
    let mut posed: BTreeMap<String, Transform> = BTreeMap::new();
    for b in &rig().bones {
        let angle = pose
            .get(&b.name)
            .copied()
            .unwrap_or(0.0)
            .clamp(b.flex[0], b.flex[1]);
        let q = [(angle / 2.0).sin(), 0.0, 0.0, (angle / 2.0).cos()];
        let local = Transform {
            position: b.position,
            rotation: b.rotation,
        };
        let live = Transform {
            position: b.position,
            rotation: multiply(b.rotation, q),
        };
        let r = b
            .parent
            .as_ref()
            .map_or_else(|| local.clone(), |p| rest[p].compose(&local));
        let p = b
            .parent
            .as_ref()
            .map_or_else(|| live.clone(), |p| posed[p].compose(&live));
        rest.insert(b.name.clone(), r);
        posed.insert(b.name.clone(), p);
    }
    let zones = ["index.3.L", "clavicle.L", "chest"]
        .into_iter()
        .map(|name| {
            let r = &rest[name];
            let p = &posed[name];
            let rotation = multiply(p.rotation, inverse(r.rotation));
            (
                name.into(),
                Transform {
                    position: sub(p.position, turn(rotation, r.position)),
                    rotation,
                },
            )
        })
        .collect();
    (pose, zones)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn colossus_rig_preserves_rest_and_clamps_all_finger_controls() {
        assert_eq!(rig().bones.len(), 48);
        assert_eq!(
            rig()
                .bones
                .iter()
                .filter(|b| b.name.starts_with("index.")
                    || b.name.starts_with("middle.")
                    || b.name.starts_with("ring.")
                    || b.name.starts_with("little.")
                    || b.name.starts_with("thumb."))
                .count(),
            30
        );
        for seconds in [0.0, 32.0, 90.0, 1000.0] {
            let (pose, zones) = sample(seconds);
            for b in &rig().bones {
                let a = pose.get(&b.name).copied().unwrap_or(0.0);
                assert!(a >= b.flex[0] && a <= b.flex[1]);
            }
            for transform in zones.values() {
                let p = [-33000.0, 87500.0, -1000.0];
                let q = transform.local(transform.point(p));
                assert!(super::super::motion::length(sub(q, p)) < 0.1);
            }
        }
    }
}
