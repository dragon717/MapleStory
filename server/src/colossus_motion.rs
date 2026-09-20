//! Metres, right-handed Y-up. Grounded bodies belong to a track; airborne
//! bodies have a world position and inherit the carrier's point velocity.
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
pub fn rotate(v: V3, yaw: f64) -> V3 {
    let (s, c) = yaw.sin_cos();
    [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c]
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub id: &'static str,
    pub revision: u64,
    pub position: V3,
    pub yaw: f64,
}
impl Frame {
    pub fn at(seconds: f64, revision: u64) -> Self {
        let a = ((seconds - 30.0) / 35.0).clamp(0.0, 1.0);
        let rise = a * a * (3.0 - 2.0 * a);
        let walking = (seconds - 68.0).max(0.0);
        Self {
            id: "ancient-colossus",
            revision,
            position: [
                320.0 + (walking / 35.0).sin() * 2.0,
                -150.0 + 186.0 * rise,
                -60.0 + (walking / 40.0).sin() * 2.0,
            ],
            yaw: (walking / 55.0).sin() * 0.035,
        }
    }
    pub fn world(&self, p: V3) -> V3 {
        add(self.position, rotate(p, self.yaw))
    }
    pub fn local(&self, p: V3) -> V3 {
        rotate(sub(p, self.position), -self.yaw)
    }
    pub fn point_velocity(&self, previous: &Self, p: V3, dt: f64) -> V3 {
        mul(sub(self.world(p), previous.world(p)), 1.0 / dt)
    }
}
#[derive(Clone, Deserialize)]
pub struct Track {
    pub frame: String,
    pub region: String,
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
            position: if t.frame == "world" { p } else { f.world(p) },
            velocity: [0.0; 3],
            grounded: true,
            speed: 0.0,
            pace: 5.5,
            facing: 1,
        }
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
        if direction != 0 {
            self.facing = direction;
        }
        if self.grounded {
            let (local, tangent) = t.point(self.s);
            let target = direction as f64 * self.pace;
            self.speed += (target - self.speed).clamp(-18.0 * dt, 18.0 * dt);
            self.velocity = if t.frame == "world" {
                mul(tangent, self.speed)
            } else {
                add(
                    frame.point_velocity(previous, local, dt),
                    rotate(mul(tangent, self.speed), frame.yaw),
                )
            };
            self.position = if t.frame == "world" {
                local
            } else {
                frame.world(local)
            };
            if jump {
                self.grounded = false;
                self.velocity[1] += 7.5;
            } else {
                let next = (self.s + self.speed * dt).clamp(0.0, t.len());
                if c.solid(&self.track, next, bridge) {
                    self.s = next;
                    let p = t.point(next).0;
                    self.position = if t.frame == "world" {
                        p
                    } else {
                        frame.world(p)
                    };
                    if self.track == "lower" && next >= t.len() && direction > 0 {
                        let (s, q, d) = c.tracks["harbor"].nearest(self.position);
                        if d < 0.1 && (q[1] - self.position[1]).abs() < 0.1 {
                            self.track = "harbor".into();
                            self.s = s;
                        }
                    }
                    return;
                }
                self.grounded = false;
            }
        }
        let before = self.position;
        let tangent = t.point(self.s).1;
        let tangent = if t.frame == "world" {
            tangent
        } else {
            rotate(tangent, frame.yaw)
        };
        // Air steering is bounded; carrier momentum is not reset to input speed.
        self.velocity = add(self.velocity, mul(tangent, direction as f64 * 3.0 * dt));
        self.velocity[1] -= 18.0 * dt;
        self.position = add(self.position, mul(self.velocity, dt));
        let mut landing = None;
        for (name, track) in &c.tracks {
            if track.region != t.region {
                continue;
            }
            let moving = track.frame != "world";
            // The rising palm is a spectacle, not an invisible boarding platform.
            if moving && frame.position[1] < 36.0 {
                continue;
            }
            let p = if moving {
                frame.local(self.position)
            } else {
                self.position
            };
            let old = if moving {
                previous.local(before)
            } else {
                before
            };
            // Several turns of a spiral can share X/Z. Test every crossed height.
            for (s, q, d) in track.projections(p, false) {
                if d <= track.width / 2.0
                    && old[1] >= q[1] - 0.35
                    && p[1] <= q[1]
                    && p[1] < old[1]
                    && c.solid(name, s, bridge)
                {
                    let world = if moving { frame.world(q) } else { q };
                    if landing
                        .as_ref()
                        .is_none_or(|(_, _, p): &(String, f64, V3)| world[1] > p[1])
                    {
                        landing = Some((name.clone(), s, world));
                    }
                }
            }
        }
        if let Some((name, s, p)) = landing {
            let track = &c.tracks[&name];
            let local = track.point(s);
            let carrier = if track.frame == "world" {
                [0.0; 3]
            } else {
                frame.point_velocity(previous, local.0, dt)
            };
            let tangent = if track.frame == "world" {
                local.1
            } else {
                rotate(local.1, frame.yaw)
            };
            self.speed = dot(sub(self.velocity, carrier), tangent);
            self.track = name;
            self.s = s;
            self.position = p;
            self.grounded = true;
        }
        // A fall returns to this district's safe path, never to another garden.
        if self.position[1] < c.sea_level - 4.0 {
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
    fn colossus_carrier_detachment_landing_and_gap_are_authoritative() {
        let c = Config::shipped();
        let old = Frame::at(90.0, 1);
        let new = Frame::at(90.05, 2);
        let mut b = Body::new(&c, "shoulder", 60.0, &old);
        let local = c.tracks["shoulder"].point(b.s).0;
        let inherited = new.point_velocity(&old, local, 0.05);
        b.step(&c, &old, &new, true, 0, true, 0.05);
        assert!(!b.grounded);
        assert!((b.velocity[0] - inherited[0]).abs() < 1e-9);
        assert!((b.velocity[2] - inherited[2]).abs() < 1e-9);
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
                    f.world(c.tracks["shoulder"].point(70.0).0)
                )) < 1e-8
            );
        }

        assert!(!c.solid("harbor", 52.0, false));
        assert!(c.solid("harbor", 52.0, true));
    }
}
