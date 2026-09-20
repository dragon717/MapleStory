//! Metres, right-handed Y-up. Both grounded and airborne bodies use track s
//! plus local jump height. Camera orientation never participates in simulation.
use super::rig::{self, Pose, Transform};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
pub type V3 = [f64; 3];
pub fn add(a: V3, b: V3) -> V3 {
    std::array::from_fn(|i| a[i] + b[i])
}
pub fn sub(a: V3, b: V3) -> V3 {
    std::array::from_fn(|i| a[i] - b[i])
}
pub fn mul(a: V3, k: f64) -> V3 {
    a.map(|v| v * k)
}
pub fn dot(a: V3, b: V3) -> f64 {
    (0..3).map(|i| a[i] * b[i]).sum()
}
pub fn length(a: V3) -> f64 {
    dot(a, a).sqrt()
}
fn smooth(x: f64) -> f64 { let x=x.clamp(0.0,1.0);x*x*(3.0-2.0*x) }
#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
struct Staging { knee_surface: V3, standing_harbor_height: f64 }
fn staging() -> &'static Staging {
    static VALUE: std::sync::OnceLock<Staging> = std::sync::OnceLock::new();
    VALUE.get_or_init(|| {
        let data: serde_json::Value=serde_json::from_str(include_str!("../../shared/colossus.json")).expect("colossus staging");
        serde_json::from_value(data["staging"].clone()).expect("staging dimensions")
    })
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub id: &'static str,
    pub revision: u64,
    pub position: V3,
    pub yaw: f64,
    pub rotation: rig::Q4,
    pub pose: Pose,
    pub zones: BTreeMap<String, Transform>,
}
impl Frame {
    pub fn at(seconds: f64, revision: u64) -> Self {
        let (pose, mut zones) = rig::sample(seconds);
        let data = staging();
        let rise = smooth((seconds - 40.0) / 25.0);
        let angle = -(1.0 - rise) * std::f64::consts::FRAC_PI_2;
        let rotation = [0.0, 0.0, (angle/2.0).sin(), (angle/2.0).cos()];
        let knee = zones["shin.L"].point(data.knee_surface);
        let protected_height = data.standing_harbor_height * rise;
        let residual = (rise * std::f64::consts::PI).sin() * 0.025;
        let level = [0.0,0.0,(residual/2.0).sin(),(residual/2.0).cos()];
        zones.insert("harbor".into(), Transform {
            position: knee, rotation: rig::multiply(rig::inverse(rotation),level),
        });
        Self { id: "ancient-colossus", revision, yaw: 0.0, rotation,
            position: sub([(seconds-69.0).max(0.0)*1.2,protected_height,0.0],rig::turn(rotation,knee)), pose, zones }
    }

    pub fn world_on(&self, t: &Track, p: V3) -> V3 {
        self.world(t.anchor.as_ref().map_or(p, |a| self.zones[a].point(p)))
    }
    pub fn local_on(&self, t: &Track, p: V3) -> V3 {
        let p = self.local(p);
        t.anchor.as_ref().map_or(p, |a| self.zones[a].local(p))
    }
    pub fn world(&self, p: V3) -> V3 {
        add(self.position, rig::turn(self.rotation, p))
    }
    pub fn local(&self, p: V3) -> V3 {
        rig::turn(rig::inverse(self.rotation), sub(p, self.position))
    }
}
#[derive(Clone, Deserialize)]
pub struct Track {
    pub frame: String,
    pub region: String,
    #[serde(default)]
    pub anchor: Option<String>,
    #[serde(default)]
    pub climb: bool,
    pub width: f64,
    pub points: Vec<V3>,
}
#[derive(Clone, Deserialize)]
pub struct Region {
    pub home: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Passage {
    pub id: String,
    pub track: String,
    pub s: f64,
    pub to_track: String,
    pub to_s: f64,
    pub label: String,
}
impl Track {
    pub fn len(&self) -> f64 {
        self.points
            .windows(2)
            .map(|p| length(sub(p[1], p[0])))
            .sum()
    }
    pub fn point(&self, s: f64) -> (V3, V3) {
        let mut remaining = s.max(0.0);
        for (i, p) in self.points.windows(2).enumerate() {
            let d = sub(p[1], p[0]);
            let l = length(d);
            if remaining <= l || i == self.points.len() - 2 {
                return (
                    add(p[0], mul(d, (remaining / l).clamp(0.0, 1.0))),
                    mul(d, 1.0 / l),
                );
            }
            remaining -= l;
        }
        unreachable!("validated track")
    }
    pub fn nearest(&self, p: V3) -> (f64, V3, f64) {
        self.projections(p, true)
            .into_iter()
            .min_by(|a, b| a.2.total_cmp(&b.2))
            .unwrap()
    }
    fn projections(&self, p: V3, endpoints: bool) -> Vec<(f64, V3, f64)> {
        let mut candidates = Vec::with_capacity(self.points.len() - 1);
        let mut s = 0.0;
        for pair in self.points.windows(2) {
            let d = sub(pair[1], pair[0]);
            let horizontal = d[0] * d[0] + d[2] * d[2];
            let v = sub(p, pair[0]);
            let along = (v[0] * d[0] + v[2] * d[2]) / horizontal.max(0.001);
            let segment_length = length(d);
            if !endpoints && !(0.0..=1.0).contains(&along) {
                s += segment_length;
                continue;
            }
            let f = along.clamp(0.0, 1.0);
            let q = add(pair[0], mul(d, f));
            let distance = ((p[0] - q[0]).powi(2) + (p[2] - q[2]).powi(2)).sqrt();
            candidates.push((s + length(d) * f, q, distance));
            s += length(d);
        }
        candidates
    }
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub regions: BTreeMap<String, Region>,
    pub tracks: BTreeMap<String, Track>,
    pub passages: Vec<Passage>,
    pub gaps: Vec<[f64; 2]>,
    pub vine: V3,
    pub sea_level: f64,
}
impl Config {
    pub fn shipped() -> Self {
        let c: Self = serde_json::from_str(include_str!("../../shared/colossus.json"))
            .expect("colossus content");
        assert!(
            c.regions.len() == 6
                && c.tracks.values().all(|t| t.width > 0.0
                    && c.regions.contains_key(&t.region)
                    && (t.frame == "world" || t.frame == "ancient-colossus")
                    && t.points.len() > 1
                    && t.points.iter().flatten().all(|v| v.is_finite())
                    && t.points.windows(2).all(|p| length(sub(p[1], p[0])) > 0.01))
        );
        assert!(c.regions.values().all(|r| c.tracks.contains_key(&r.home)));
        assert!(c.passages.iter().all(|p| c
            .tracks
            .get(&p.track)
            .is_some_and(|t| p.s >= 0.0 && p.s <= t.len() + 0.01)
            && c.tracks
                .get(&p.to_track)
                .is_some_and(|t| p.to_s >= 0.0 && p.to_s <= t.len() + 0.01)));
        c
    }
    pub fn passage(&self, body: &Body) -> Option<&Passage> {
        if !body.grounded {
            return None;
        }
        self.passages
            .iter()
            .filter(|p| p.track == body.track && (p.s - body.s).abs() < 4.0)
            .min_by(|a, b| (a.s - body.s).abs().total_cmp(&(b.s - body.s).abs()))
    }
    pub fn solid(&self, track: &str, s: f64, bridge: bool) -> bool {
        track != "harbor"
            || !self
                .gaps
                .iter()
                .enumerate()
                .any(|(i, g)| s > g[0] && s < g[1] && (i == 0 || !bridge))
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Body {
    pub track: String,
    pub s: f64,
    pub position: V3,
    pub velocity: V3,
    pub grounded: bool,
    pub height: f64,
    pub vertical_speed: f64,
    pub warp: u64,
    pub speed: f64,
    pub pace: f64,
    pub facing: i8,
}
impl Body {
    pub fn new(c: &Config, track: &str, s: f64, f: &Frame) -> Self {
        let t = &c.tracks[track];
        let s = s.clamp(0.0, t.len());
        let p = t.point(s).0;
        Self {
            track: track.into(),
            s,
            position: if t.frame == "world" {
                p
            } else {
                f.world_on(t, p)
            },
            velocity: [0.0; 3],
            grounded: true,
            height: 0.0,
            vertical_speed: 0.0,
            warp: 0,
            speed: 0.0,
            pace: 5.5,
            facing: 1,
        }
    }
    pub fn teleport(&self, c: &Config, frame: &Frame, bridge: bool, along: f64, up: f64) -> Option<Self> {
        let track = &c.tracks[&self.track];
        if track.climb || !along.is_finite() || !up.is_finite() { return None; }
        let mut next = self.clone();
        next.s = (self.s + along).clamp(0.0, track.len());
        next.height = (self.height + up).max(0.0);
        if next.height == 0.0 && !c.solid(&self.track, next.s, bridge) { return None; }
        if (next.s - self.s).abs() < 0.001 && (next.height - self.height).abs() < 0.001 { return None; }
        next.grounded = next.height == 0.0;
        next.vertical_speed = 0.0;
        next.speed = 0.0;
        next.velocity = [0.0; 3];
        if along != 0.0 { next.facing = if along < 0.0 { -1 } else { 1 }; }
        next.warp += 1;
        let p = add(track.point(next.s).0, [0.0, next.height, 0.0]);
        next.position = if track.frame == "world" { p } else { frame.world_on(track, p) };
        Some(next)
    }
    pub fn step(
        &mut self,
        c: &Config,
        previous: &Frame,
        frame: &Frame,
        bridge: bool,
        direction: i8,
        jump: bool,
        dt: f64,
    ) {
        let t = &c.tracks[&self.track];
        let before = self.position;
        let old_s = self.s;
        let old_height = self.height;
        if direction != 0 {
            self.facing = direction;
        }
        let target = direction as f64 * self.pace;
        self.speed += (target - self.speed).clamp(-18.0 * dt, 18.0 * dt);
        if jump && self.grounded {
            // Releasing movement then jumping means a jump on this exact rail point.
            if direction == 0 { self.speed = 0.0; }
            self.grounded = false;
            self.vertical_speed = 7.5;
        }
        self.s = (self.s + self.speed * dt).clamp(0.0, t.len());
        if self.grounded && !c.solid(&self.track, self.s, bridge) {
            self.grounded = false;
        }
        if !self.grounded {
            self.vertical_speed -= 18.0 * dt;
            self.height += self.vertical_speed * dt;
        }
        let local = add(t.point(self.s).0, [0.0, self.height, 0.0]);
        self.position = if t.frame == "world" { local } else { frame.world_on(t, local) };
        if !self.grounded && self.vertical_speed < 0.0 {
            // The authored rail remains the constraint through corners and carrier rotation.
            if !t.climb && old_height >= 0.0 && self.height <= 0.0
                && c.solid(&self.track, self.s, bridge) {
                self.grounded = true;
            } else {
                let mut landing: Option<(String, f64, V3)> = None;
                for (name, track) in &c.tracks {
                    if name == &self.track || track.region != t.region || track.climb { continue; }
                    let moving = track.frame != "world";
                    let p = if moving { frame.local_on(track, self.position) } else { self.position };
                    let old = if moving { previous.local_on(track, before) } else { before };
                    for (s, q, d) in track.projections(p, false) {
                        if d <= track.width / 2.0 && old[1] >= q[1] - 0.35
                            && p[1] <= q[1] && p[1] < old[1] && c.solid(name, s, bridge) {
                            let world = if moving { frame.world_on(track, q) } else { q };
                            if landing.as_ref().is_none_or(|(_, _, p)| world[1] > p[1]) {
                                landing = Some((name.clone(), s, world));
                            }
                        }
                    }
                }
                if let Some((name, s, _)) = landing {
                    self.track = name;
                    self.s = s;
                    self.grounded = true;
                }
            }
        }
        if self.grounded {
            self.height = 0.0;
            self.vertical_speed = 0.0;
            let track = &c.tracks[&self.track];
            let p = track.point(self.s).0;
            self.position = if track.frame == "world" { p } else { frame.world_on(track, p) };
            if (self.track == "climb" && self.s <= 0.0 && direction < 0)
                || (self.track == "lower" && self.s >= track.len() && direction > 0) {
                let harbor = &c.tracks["harbor"];
                let local = frame.local_on(harbor,self.position);
                let (s, q, d) = harbor.nearest(local);
                if d < 4.0 && (q[1] - local[1]).abs() < 4.0 {
                    self.track = "harbor".into(); self.s = s; self.position = frame.world_on(harbor,q);
                }
            }
        }
        self.velocity = mul(sub(self.position, before), 1.0 / dt);
        if self.s == old_s { self.speed = 0.0; }
        // A fall returns to this district's safe path, never to another garden.
        let floor = t
            .points
            .iter()
            .map(|p| {
                if t.frame == "world" {
                    p[1]
                } else {
                    frame.world_on(t, *p)[1]
                }
            })
            .fold(f64::INFINITY, f64::min)
            - 30.0;
        if self.position[1] < (c.sea_level - 4.0).max(floor) {
            let home = if t.region == "harbor" {
                "lower"
            } else {
                &c.regions[&t.region].home
            };
            *self = Self::new(c, home, 0.0, frame);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn colossus_rail_jump_landing_and_gap_are_authoritative() {
        let c = Config::shipped();
        let old = Frame::at(90.0, 1);
        let new = Frame::at(90.05, 2);
        let mut b = Body::new(&c, "shoulder", 60.0, &old);
        b.step(&c, &old, &new, true, 0, true, 0.05);
        assert!(!b.grounded);
        assert_eq!(b.s, 60.0);
        assert!(b.height > 0.0);
        for i in 2..80 {
            let p = Frame::at(90.0 + (i - 1) as f64 * 0.05, i - 1);
            let f = Frame::at(90.0 + i as f64 * 0.05, i);
            b.step(&c, &p, &f, true, 0, false, 0.05);
        }
        assert!(b.grounded);
        assert_eq!(b.track, "shoulder");
        let mut h = Body::new(&c, "harbor", 19.0, &old);
        for _ in 0..80 {
            h.step(&c, &old, &old, false, 1, false, 0.05);
        }
        assert_eq!(h.track, "lower");
        assert!(h.position.iter().all(|v| v.is_finite()));
        for _ in 0..260 {
            h.step(&c, &old, &old, false, 1, false, 0.05);
        }
        assert_eq!(
            h.track, "harbor",
            "the lower route must reconnect without jumping"
        );
        assert!(h.s > 85.0);
        let mut idle = Body::new(&c, "shoulder", 70.0, &old);
        for i in 1..100 {
            let p = Frame::at(90.0 + (i - 1) as f64 * 0.05, i - 1);
            let f = Frame::at(90.0 + i as f64 * 0.05, i);
            idle.step(&c, &p, &f, true, 0, false, 0.05);
            assert_eq!(idle.s, 70.0);
            assert!(
                length(sub(
                    idle.position,
                    f.world_on(&c.tracks["shoulder"], c.tracks["shoulder"].point(70.0).0)
                )) < 1e-8
            );
        }

        assert!(!c.solid("harbor", 52.0, false));
        assert!(c.solid("harbor", 52.0, true));
    }
}
