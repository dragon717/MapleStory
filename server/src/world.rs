use crate::{
    auth::{self, Identity, Profile, Store},
    combat::{Attack, Combat},
    inventory,
    protocol::{reject, ClientMessage, DropState, MonsterState, PlayerState},
};
use rand::Rng;
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    path::Path,
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, mpsc::error::TrySendError, oneshot};

pub const TICK_MS: u64 = 50;
// Mapleweb advances its PhysicsObject in 8 ms steps. Raw Mob.wz `speed` is
// the per-reference-tick horizontal force after `(speed + 100) * .001`;
// convert its displacement to this server's 50 ms world tick below.
const REFERENCE_TICK_MS: f64 = 8.0;
// Values measured/used by the local v83 physics reference (Maplewright
// `crates/physics/src/lib.rs`).
const WALK_SPEED: f64 = 125.0;
const JUMP_SPEED: f64 = 555.0;
const GRAVITY: f64 = 2_000.0;
const FALL_SPEED: f64 = 670.0;
const DOWNJUMP_RANGE: f64 = 600.0;
const DOWNJUMP_LAUNCH: f64 = 196.0;
// Mapleweb's Ladder::felloff probes five pixels beyond each authored end
// before cancelling the fixed climb state.  Reuse that source boundary when
// resolving the foothold at an allowed top exit.
const LADDER_END_PROBE_PX: f64 = 5.0;
// The Snail WZ animation manifest has a 100 ms stand frame and five move
// frames at 180 ms each (900 ms per move loop).  HeavenClient's controlled
// mob counter is the longer gate; the 50 ms authoritative loop uses the
// source-calibrated decision windows below.  They are overridable by the
// animation metadata on MonsterTemplate so another mob is not forced to use
// Snail's timing.
const MOB_DEFAULT_STAND_DELAY_MS: u64 = 100;
const MOB_DEFAULT_MOVE_DURATION_MS: u64 = 900;
const MOB_STAND_DECISION_MS: u64 = 1_700;
const MOB_MOVE_DECISION_MS: u64 = 1_800;
// HeavenClient Mob.cpp sets counter=170 when a controlled mob is knocked
// into HIT, then advances it every 8 ms and calls next_move only after
// counter>200.  That is 31 reference updates = 248 ms.  The Snail hit1
// frame itself has a 600 ms WZ delay, but the source controller leaves HIT
// on the counter gate, so this recovery window is the authoritative state
// transition used here.
const MOB_HIT_RECOVERY_MS: u64 = 248;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub x_min: f64,
    pub x_max: f64,
    pub y_min: f64,
    pub y_max: f64,
}

#[derive(Clone, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Portal {
    pub name: String,
    #[serde(rename = "type", default)]
    pub portal_type: i8,
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub target_map_id: Option<String>,
    #[serde(default)]
    pub target_portal_name: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Foothold {
    pub id: u64,
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
    #[serde(default)]
    pub prev: u64,
    #[serde(default)]
    pub next: u64,
    #[serde(default)]
    pub forbid_fall_down: i8,
}

impl Foothold {
    fn is_wall(&self) -> bool {
        (self.x1 - self.x2).abs() < 0.001
    }

    fn left(&self) -> f64 {
        self.x1.min(self.x2)
    }

    fn right(&self) -> f64 {
        self.x1.max(self.x2)
    }

    fn top(&self) -> f64 {
        self.y1.min(self.y2)
    }

    fn bottom(&self) -> f64 {
        self.y1.max(self.y2)
    }

    fn contains_x(&self, x: f64) -> bool {
        !self.is_wall() && x >= self.left() - 0.001 && x <= self.right() + 0.001
    }

    fn at(&self, x: f64) -> Option<f64> {
        if !self.contains_x(x) {
            return None;
        }
        Some(self.y1 + (x - self.x1) / (self.x2 - self.x1) * (self.y2 - self.y1))
    }

    fn blocks(&self, top: f64, bottom: f64) -> bool {
        self.is_wall() && self.top() <= bottom && self.bottom() >= top
    }
}

fn endpoint(foothold: &Foothold, left: bool) -> (f64, f64) {
    let take_first = if left {
        foothold.x1 <= foothold.x2
    } else {
        foothold.x1 >= foothold.x2
    };
    if take_first {
        (foothold.x1, foothold.y1)
    } else {
        (foothold.x2, foothold.y2)
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ladder {
    pub id: u64,
    pub x: f64,
    pub y1: f64,
    pub y2: f64,
    #[serde(default, deserialize_with = "deserialize_boolish_i8")]
    pub l: i8,
    #[serde(default, deserialize_with = "deserialize_boolish_i8")]
    pub uf: i8,
}

fn deserialize_boolish_i8<'de, D>(deserializer: D) -> Result<i8, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Value {
        Bool(bool),
        Int(i8),
    }
    match Value::deserialize(deserializer)? {
        Value::Bool(value) => Ok(i8::from(value)),
        Value::Int(value) => Ok(value),
    }
}

impl Ladder {
    fn top(&self) -> f64 {
        self.y1.min(self.y2)
    }

    fn bottom(&self) -> f64 {
        self.y1.max(self.y2)
    }

    /// `l` is the map WZ ladder/rope selector.  The client has separate
    /// source-backed ladder and rope stances, so keep that distinction in the
    /// authoritative action instead of treating every vertical link as a
    /// generic climb animation.
    fn action(&self) -> &'static str {
        if self.l != 0 {
            "ladder"
        } else {
            "rope"
        }
    }

    /// `uf` controls whether an upward climb may leave through the top end.
    /// The supplied map uses `uf=1`; an `uf=0` link must hold the player at its
    /// top until they reverse direction or leave by another sourced action.
    fn allows_top_exit(&self) -> bool {
        self.uf != 0
    }

    fn accepts(&self, x: f64, y: f64, upwards: bool) -> bool {
        let probe = y + if upwards { -5.0 } else { 5.0 };
        (x - self.x).abs() <= 10.0 && probe >= self.top() && probe <= self.bottom()
    }
}

#[derive(Clone, Deserialize)]
pub struct Map {
    pub id: String,
    pub bounds: Bounds,
    pub spawn: Point,
    pub footholds: Vec<Foothold>,
    #[serde(default, alias = "ladderRope")]
    pub ladders: Vec<Ladder>,
    #[serde(default)]
    pub portals: Vec<Portal>,
}

impl Map {
    pub fn load(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let mut map: Self = serde_json::from_str(&std::fs::read_to_string(path)?)?;
        map.validate()
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
        map.footholds.sort_by_key(|foothold| foothold.id);
        Ok(map)
    }

    fn validate(&self) -> Result<(), String> {
        let map = self;
        let b = &map.bounds;
        if map.id.is_empty()
            || map.footholds.is_empty()
            || ![b.x_min, b.x_max, b.y_min, b.y_max, map.spawn.x, map.spawn.y]
                .iter()
                .all(|x| x.is_finite())
            || b.x_min >= b.x_max
            || b.y_min >= b.y_max
            || !(b.x_min..=b.x_max).contains(&map.spawn.x)
            || !(b.y_min..=b.y_max).contains(&map.spawn.y)
            || map.footholds.iter().any(|f| {
                ![f.x1, f.y1, f.x2, f.y2].iter().all(|x| x.is_finite())
                    || f.id == 0
                    || f.id == f.prev && f.prev != 0
                    || f.id == f.next && f.next != 0
            })
            || map.ladders.iter().any(|l| {
                ![l.x, l.y1, l.y2].iter().all(|x| x.is_finite())
                    || l.id == 0
                    || l.top() == l.bottom()
            })
            || map.portals.iter().any(|portal| {
                portal.name.is_empty()
                    || ![portal.x, portal.y].iter().all(|x| x.is_finite())
                    || portal.target_map_id.as_deref().is_some_and(str::is_empty)
                    || portal
                        .target_portal_name
                        .as_deref()
                        .is_some_and(str::is_empty)
            })
        {
            return Err("invalid map bounds/spawn/footholds/ladders/portals".into());
        }
        Ok(())
    }

    fn get(&self, id: u64) -> Option<&Foothold> {
        self.footholds.iter().find(|f| f.id == id)
    }

    fn ground_below(&self, x: f64, y: f64) -> Option<(u64, f64)> {
        self.footholds
            .iter()
            .filter_map(|f| f.at(x).map(|ground| (f, ground)))
            .filter(|(_, ground)| *ground >= y - 0.001)
            .min_by(|(a, ay), (b, by)| ay.total_cmp(by).then_with(|| a.id.cmp(&b.id)))
            .map(|(f, ground)| (f.id, ground))
    }

    /// Match the source FootholdTree lower border: the greatest authored
    /// foothold bottom plus its 100px recovery margin, bounded by the map's
    /// explicit lower limit.
    fn fall_boundary(&self) -> f64 {
        self.footholds
            .iter()
            .map(Foothold::bottom)
            .reduce(f64::max)
            .map_or(self.bounds.y_max, |bottom| {
                (bottom + 100.0).min(self.bounds.y_max)
            })
    }

    /// Find the first authored foothold crossed by a descending movement
    /// segment.  The old single-point lookup only examined the post-move x;
    /// a fast horizontal step could therefore pass over a narrow foothold at
    /// a platform edge.  Keep the sweep geometric and map-driven: vertical
    /// walls are excluded by `Foothold::at`, slopes are interpolated, and an
    /// explicitly skipped down-jump foothold is never reselected.
    fn landing_on_sweep(
        &self,
        from_x: f64,
        to_x: f64,
        from_y: f64,
        to_y: f64,
        ignored_id: u64,
    ) -> Option<(u64, f64, f64)> {
        const EPSILON: f64 = 0.001;
        if to_y < from_y - EPSILON {
            return None;
        }
        let dx = to_x - from_x;
        let dy = to_y - from_y;
        if dx.abs() <= EPSILON && ignored_id == 0 {
            return self
                .ground_below(from_x, from_y)
                .filter(|(_, ground)| to_y >= *ground - EPSILON)
                .map(|(foothold_id, ground)| (foothold_id, from_x, ground));
        }
        let path_left = from_x.min(to_x);
        let path_right = from_x.max(to_x);
        self.footholds
            .iter()
            .filter(|foothold| foothold.id != ignored_id && !foothold.is_wall())
            .filter_map(|foothold| {
                let overlap_left = path_left.max(foothold.left());
                let overlap_right = path_right.min(foothold.right());
                if overlap_left > overlap_right + EPSILON {
                    return None;
                }

                let (mut t0, mut t1) = if dx.abs() <= EPSILON {
                    (0.0, 1.0)
                } else {
                    ((overlap_left - from_x) / dx, (overlap_right - from_x) / dx)
                };
                if t0 > t1 {
                    std::mem::swap(&mut t0, &mut t1);
                }
                t0 = t0.clamp(0.0, 1.0);
                t1 = t1.clamp(0.0, 1.0);
                let x0 = from_x + dx * t0;
                let x1 = from_x + dx * t1;
                let ground0 = foothold.at(x0)?;
                let ground1 = foothold.at(x1)?;
                let player0 = from_y + dy * t0;
                let player1 = from_y + dy * t1;
                let difference0 = ground0 - player0;
                let difference1 = ground1 - player1;

                // A landing crosses from above the foothold (difference >=0)
                // to at/below it (difference <=0).  Crossing in the opposite
                // direction means the player is already underneath it.
                if difference0 < -EPSILON || difference1 > EPSILON {
                    return None;
                }
                let crossing = if difference0.abs() <= EPSILON {
                    t0
                } else {
                    let denominator = difference0 - difference1;
                    if denominator.abs() <= EPSILON {
                        return None;
                    }
                    (t0 + (t1 - t0) * difference0 / denominator).clamp(t0, t1)
                };
                let x = from_x + dx * crossing;
                let ground = foothold.at(x)?;
                Some((crossing, foothold.id, x, ground))
            })
            .min_by(|(ta, ida, _, ga), (tb, idb, _, gb)| {
                ta.total_cmp(tb)
                    .then_with(|| ga.total_cmp(gb))
                    .then_with(|| ida.cmp(idb))
            })
            .map(|(_, foothold_id, x, ground)| (foothold_id, x, ground))
    }

    fn ground_near(&self, x: f64, y: f64) -> Option<(u64, f64)> {
        self.footholds
            .iter()
            .filter_map(|f| f.at(x).map(|ground| (f, ground)))
            .min_by(|(a, ay), (b, by)| {
                (ay - y)
                    .abs()
                    .total_cmp(&(by - y).abs())
                    .then_with(|| a.id.cmp(&b.id))
            })
            .map(|(f, ground)| (f.id, ground))
    }

    /// Resolve the authored platform at a ladder's top endpoint.  The WZ
    /// ladder boundary is independent from the foothold y coordinate (the
    /// live map's endpoint is y=127 while its support is y=125), so stopping
    /// at the ladder coordinate alone leaves the player above the platform
    /// and makes the next gravity step miss it.  Limit the lookup to the
    /// source's five-pixel endpoint probe so an unrelated lower platform is
    /// left to normal falling instead of being selected as a top exit.
    fn ladder_top_ground(&self, ladder: &Ladder) -> Option<(u64, f64)> {
        let top = ladder.top();
        self.footholds
            .iter()
            .filter_map(|foothold| foothold.at(ladder.x).map(|ground| (foothold, ground)))
            .filter(|(_, ground)| *ground <= top + 0.001 && top - *ground <= LADDER_END_PROBE_PX)
            .min_by(|(a, ay), (b, by)| {
                (ay - top)
                    .abs()
                    .total_cmp(&(by - top).abs())
                    .then_with(|| a.id.cmp(&b.id))
            })
            .map(|(foothold, ground)| (foothold.id, ground))
    }

    /// HeavenClient's Footholdtree derives horizontal outer walls from the
    /// foothold extents, inset by 25 px.  The map VR bounds are camera/fall
    /// bounds and are deliberately kept separate from this collision wall.
    fn outer_wall(&self, left: bool) -> f64 {
        let edge = if left {
            self.footholds.iter().map(Foothold::left).reduce(f64::min)
        } else {
            self.footholds.iter().map(Foothold::right).reduce(f64::max)
        };
        edge.map_or(
            if left {
                self.bounds.x_min
            } else {
                self.bounds.x_max
            },
            |edge| {
                if left {
                    edge + 25.0
                } else {
                    edge - 25.0
                }
            },
        )
    }

    fn downjump_target(&self, current_id: u64, x: f64) -> Option<(u64, f64)> {
        let current = self.get(current_id)?;
        if current.forbid_fall_down != 0 {
            return None;
        }
        let current_ground = current.at(x)?;
        self.footholds
            .iter()
            .filter_map(|f| f.at(x).map(|ground| (f, ground)))
            .filter(|(f, ground)| {
                f.id != current_id
                    && *ground > current_ground + 0.001
                    && *ground - current_ground < DOWNJUMP_RANGE
            })
            .min_by(|(a, ay), (b, by)| ay.total_cmp(by).then_with(|| a.id.cmp(&b.id)))
            .map(|(f, ground)| (f.id, ground))
    }

    /// The wall for a body on a foothold. Only chain neighbours can create a wall;
    /// background vertical lines and unrelated footholds never become global barriers.
    fn wall_for(&self, current_id: u64, left: bool, foot_y: f64) -> f64 {
        let outside = self.outer_wall(left);
        let Some(current) = self.get(current_id) else {
            return outside;
        };
        let mut id = if left { current.prev } else { current.next };
        let mut edge = if left {
            current.left()
        } else {
            current.right()
        };
        for _ in 0..2 {
            let Some(candidate) = self.get(id) else { break };
            if candidate.blocks(foot_y - 50.0, foot_y - 1.0) {
                return edge;
            }
            // HeavenClient returns the edge of the foothold immediately
            // before the blocking second neighbour (`prev.l()`/`next.r()`),
            // rather than the edge of `current`.
            edge = if left {
                candidate.left()
            } else {
                candidate.right()
            };
            id = if left { candidate.prev } else { candidate.next };
        }
        outside
    }

    /// Return the linked foothold at the travel edge when the two authored
    /// segments meet at the same endpoint.  A `prev`/`next` id alone is not
    /// enough: WZ chains also contain vertical wall segments and links across
    /// gaps.  Mobs may continue across a horizontal or sloped surface only
    /// when the edge is geometrically continuous; otherwise the current edge
    /// is a real turn-around wall.
    fn contiguous_neighbor(&self, current_id: u64, direction: i8) -> Option<&Foothold> {
        let current = self.get(current_id)?;
        if current.is_wall() || direction == 0 {
            return None;
        }
        let neighbor_id = if direction > 0 {
            current.next
        } else {
            current.prev
        };
        let neighbor = self.get(neighbor_id)?;
        if neighbor.is_wall() {
            return None;
        }

        let current_endpoint = if direction > 0 {
            endpoint(current, false)
        } else {
            endpoint(current, true)
        };
        let neighbor_endpoint = if direction > 0 {
            endpoint(neighbor, true)
        } else {
            endpoint(neighbor, false)
        };
        const ENDPOINT_EPSILON: f64 = 0.001;
        ((current_endpoint.0 - neighbor_endpoint.0).abs() <= ENDPOINT_EPSILON
            && (current_endpoint.1 - neighbor_endpoint.1).abs() <= ENDPOINT_EPSILON)
            .then_some(neighbor)
    }

    fn ladder_for(&self, x: f64, y: f64, upwards: bool) -> Option<&Ladder> {
        self.ladders
            .iter()
            .find(|ladder| ladder.accepts(x, y, upwards))
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapCatalog {
    pub birth_map_id: String,
    #[serde(default)]
    pub maps: Vec<Map>,
}

impl MapCatalog {
    pub fn load(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let mut catalog: Self = serde_json::from_str(&std::fs::read_to_string(path)?)?;
        if catalog.birth_map_id.is_empty() || catalog.maps.is_empty() {
            return Err("invalid map catalog".into());
        }
        catalog.maps.sort_by(|a, b| a.id.cmp(&b.id));
        if catalog.maps.iter().any(|map| map.validate().is_err())
            || catalog.maps.windows(2).any(|maps| maps[0].id == maps[1].id)
            || !catalog
                .maps
                .iter()
                .any(|map| map.id == catalog.birth_map_id)
        {
            return Err("invalid map catalog maps".into());
        }
        for map in &mut catalog.maps {
            map.footholds.sort_by_key(|foothold| foothold.id);
        }
        Ok(catalog)
    }
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerConfig {
    pub job: Option<u32>,
    pub base_str: Option<i64>,
    pub base_dex: Option<i64>,
    pub base_int: Option<i64>,
    pub base_luk: Option<i64>,
    pub weapon_type: Option<i64>,
    pub weapon_watk: Option<i64>,
    pub mastery: Option<f64>,
    pub damage_percent: Option<f64>,
    pub attack_reach: Option<f64>,
    pub attack_height: Option<f64>,
    /// WZ afterimage hitbox in character-local coordinates. The rectangle is
    /// authored for the left-facing attack, then mirrored for right-facing.
    #[serde(default)]
    pub attack_lt: Option<Point>,
    #[serde(default)]
    pub attack_rb: Option<Point>,
    pub attack_after_ms: Option<u64>,
    pub max_hp: Option<i64>,
    pub max_mp: Option<i64>,
    pub climb_speed: Option<f64>,
    pub contact_invulnerability_ms: Option<u64>,
    pub weapon_defense: Option<i64>,
    #[serde(default)]
    pub standard_pdd: Vec<DefenseThreshold>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefenseThreshold {
    pub level: u32,
    pub value: i64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DropSpec {
    pub item_id: String,
    #[serde(alias = "minimumQuantity", alias = "minQuantity")]
    pub quantity: u32,
    #[serde(default, alias = "maxQuantity", alias = "maximumQuantity")]
    pub quantity_max: Option<u32>,
    #[serde(default)]
    pub chance: Option<u64>,
}

#[derive(Clone, Deserialize)]
#[serde(untagged)]
pub enum DropInput {
    One(DropSpec),
    Many(Vec<DropSpec>),
}

impl DropInput {
    fn into_vec(self) -> Vec<DropSpec> {
        match self {
            Self::One(drop) => vec![drop],
            Self::Many(drops) => drops,
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonsterTemplate {
    #[serde(alias = "id")]
    pub template_id: String,
    pub level: u32,
    pub max_hp: i64,
    #[serde(alias = "PADamage")]
    pub pa_damage: Option<i64>,
    pub exp: u64,
    #[serde(default, deserialize_with = "deserialize_boolish")]
    pub body_attack: bool,
    #[serde(default)]
    pub move_speed: Option<f64>,
    /// Raw Mob.wz speed. Mapleweb applies `(speed + 100) * 0.001`
    /// before feeding the movement loop (Mob.cpp:197-199).
    #[serde(default, rename = "speed")]
    pub source_speed: Option<f64>,
    #[serde(default)]
    pub hitbox_width: Option<f64>,
    #[serde(default)]
    pub hitbox_height: Option<f64>,
    /// WZ body rectangle in monster-local coordinates.
    #[serde(default)]
    pub hitbox_lt: Option<Point>,
    #[serde(default)]
    pub hitbox_rb: Option<Point>,
    #[serde(default)]
    pub die_duration_ms: Option<u64>,
    /// Source animation metadata used by the controlled-mob `aniend` gate.
    /// Snail is 100 ms for `stand/0` and 5 * 180 ms for its `move` loop in
    /// `references/gameplay-assets/manifest.json`.
    #[serde(default)]
    pub stand_delay_ms: Option<u64>,
    #[serde(default)]
    pub move_duration_ms: Option<u64>,
    #[serde(default)]
    pub drop: Option<DropInput>,
}

fn deserialize_boolish<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Value {
        Bool(bool),
        Int(i64),
    }
    match Value::deserialize(deserializer)? {
        Value::Bool(value) => Ok(value),
        Value::Int(value) => Ok(value != 0),
    }
}

impl MonsterTemplate {
    fn drops(&self) -> Vec<DropSpec> {
        self.drop.clone().map_or_else(Vec::new, DropInput::into_vec)
    }

    fn body_bounds(&self, x: f64, y: f64) -> Option<(f64, f64, f64, f64)> {
        if let (Some(lt), Some(rb)) = (&self.hitbox_lt, &self.hitbox_rb) {
            return Some((x + lt.x, x + rb.x, y + lt.y, y + rb.y));
        }
        let width = self.hitbox_width?;
        let height = self.hitbox_height?;
        Some((x - width / 2.0, x + width / 2.0, y - height, y))
    }

    fn movement_step(&self) -> Option<f64> {
        self.move_speed.map(|speed| speed * TICK_MS as f64 / 1000.0)
    }

    fn movement_force(&self) -> Option<f64> {
        self.source_speed.map(|speed| (speed + 100.0) * 0.001)
    }

    fn can_move(&self) -> bool {
        self.movement_force().is_some() || self.movement_step().is_some_and(|step| step > 0.0)
    }

    fn stand_delay(&self) -> u64 {
        self.stand_delay_ms
            .unwrap_or(MOB_DEFAULT_STAND_DELAY_MS)
            .max(1)
    }

    fn move_duration(&self) -> u64 {
        self.move_duration_ms
            .unwrap_or(MOB_DEFAULT_MOVE_DURATION_MS)
            .max(1)
    }

    /// `Mob::update` waits for both animation end and `counter > 200` before
    /// calling `next_move`.  The source counter is represented by the
    /// calibrated 1700/1800 ms windows for the two authored Snail stances;
    /// custom animation metadata can only extend its corresponding window.
    fn ai_decision_ms(&self, action: &str) -> u64 {
        match action {
            "stand" => MOB_STAND_DECISION_MS.max(self.stand_delay()),
            "move" => MOB_MOVE_DECISION_MS.max(self.move_duration()),
            _ => 0,
        }
    }
}

fn random_monster_facing() -> i8 {
    if rand::thread_rng().gen_range(0..2) == 0 {
        -1
    } else {
        1
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonsterSpawn {
    #[serde(alias = "spawnId")]
    pub id: String,
    pub template_id: String,
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub foothold_id: Option<u64>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gameplay {
    #[serde(default)]
    pub content_version: Option<String>,
    #[serde(default)]
    pub player: PlayerConfig,
    #[serde(default, alias = "monsterTemplates", alias = "templates")]
    pub monsters: Vec<MonsterTemplate>,
    #[serde(default, alias = "monsterSpawns")]
    pub spawns: Vec<MonsterSpawn>,
    #[serde(default)]
    pub exp_table: Vec<u64>,
    #[serde(default)]
    pub monster_respawn_ms: Option<u64>,
    #[serde(default)]
    pub drop_chance_denominator: Option<u64>,
}

impl Gameplay {
    pub fn load(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let gameplay: Self = serde_json::from_str(&std::fs::read_to_string(path)?)?;
        gameplay.validate()?;
        Ok(gameplay)
    }

    pub fn validate(&self) -> Result<(), Box<dyn std::error::Error>> {
        if self
            .content_version
            .as_deref()
            .is_some_and(|version| version != crate::protocol::CONTENT_VERSION)
        {
            return Err("incompatible gameplay content version".into());
        }
        if self.monsters.iter().any(|template| {
            template.template_id.is_empty()
                || template.level == 0
                || template.max_hp < 1
                || template
                    .move_speed
                    .is_some_and(|speed| !speed.is_finite() || speed < 0.0)
                || template
                    .source_speed
                    .is_some_and(|speed| !speed.is_finite() || speed < -100.0)
                || template.stand_delay_ms.is_some_and(|delay| delay == 0)
                || template
                    .move_duration_ms
                    .is_some_and(|duration| duration == 0)
                || template
                    .hitbox_width
                    .is_some_and(|width| !width.is_finite() || width <= 0.0)
                || template
                    .hitbox_height
                    .is_some_and(|height| !height.is_finite() || height <= 0.0)
                || match (&template.hitbox_lt, &template.hitbox_rb) {
                    (Some(lt), Some(rb)) => {
                        ![lt.x, lt.y, rb.x, rb.y]
                            .iter()
                            .all(|value| value.is_finite())
                            || lt.x >= rb.x
                            || lt.y >= rb.y
                    }
                    (None, None) => false,
                    _ => true,
                }
                || template.drops().iter().any(|drop| {
                    drop.item_id.is_empty()
                        || drop.quantity == 0
                        || drop.quantity_max.is_some_and(|max| max < drop.quantity)
                        || drop.chance.is_some_and(|chance| {
                            self.drop_chance_denominator
                                .is_none_or(|denominator| denominator == 0 || chance > denominator)
                        })
                })
        }) {
            return Err("invalid gameplay monster template".into());
        }
        if self.spawns.iter().any(|spawn| {
            spawn.id.is_empty()
                || spawn.template_id.is_empty()
                || ![spawn.x, spawn.y].iter().all(|x| x.is_finite())
        }) {
            return Err("invalid gameplay monster spawn".into());
        }
        if self
            .player
            .attack_reach
            .is_some_and(|reach| !reach.is_finite() || reach <= 0.0)
            || self
                .player
                .attack_height
                .is_some_and(|height| !height.is_finite() || height <= 0.0)
            || self
                .player
                .climb_speed
                .is_some_and(|speed| !speed.is_finite() || speed <= 0.0)
            || self
                .player
                .mastery
                .is_some_and(|mastery| !mastery.is_finite() || !(0.0..=1.0).contains(&mastery))
            || self
                .player
                .damage_percent
                .is_some_and(|percent| !percent.is_finite() || percent < 0.0)
            || self.player.weapon_watk.is_some_and(|watk| watk < 0)
            || self.player.base_str.is_some_and(|value| value < 0)
            || self.player.base_dex.is_some_and(|value| value < 0)
            || self.player.base_int.is_some_and(|value| value < 0)
            || self.player.base_luk.is_some_and(|value| value < 0)
            || self.player.weapon_defense.is_some_and(|value| value < 0)
            || self
                .player
                .standard_pdd
                .iter()
                .any(|entry| entry.level == 0 || entry.value < 0)
            || match (&self.player.attack_lt, &self.player.attack_rb) {
                (Some(lt), Some(rb)) => {
                    ![lt.x, lt.y, rb.x, rb.y]
                        .iter()
                        .all(|value| value.is_finite())
                        || lt.x >= rb.x
                        || lt.y >= rb.y
                }
                (None, None) => false,
                _ => true,
            }
        {
            return Err("invalid gameplay player combat/movement values".into());
        }
        if self
            .drop_chance_denominator
            .is_some_and(|denominator| denominator == 0)
        {
            return Err("invalid gameplay drop chance denominator".into());
        }
        if self
            .monster_respawn_ms
            .is_some_and(|interval| interval == 0)
        {
            return Err("invalid gameplay monster respawn interval".into());
        }
        Ok(())
    }
}

impl PlayerConfig {
    /// Reproduces the regular physical damage interval used by the local
    /// Mapleweb reference (`CharStats.cpp`, lines 80-85 and 95-142).
    fn attack_damage(&self) -> i64 {
        let (min, max) = self.attack_range();
        if max <= min {
            min
        } else {
            rand::thread_rng().gen_range(min..=max)
        }
    }

    fn attack_range(&self) -> (i64, i64) {
        let str = self.base_str.unwrap_or(0).max(0) as f64;
        let dex = self.base_dex.unwrap_or(0).max(0) as f64;
        let int = self.base_int.unwrap_or(0).max(0) as f64;
        let luk = self.base_luk.unwrap_or(0).max(0) as f64;
        let weapon = self.weapon_type.unwrap_or(0);
        let job_group = self.job.unwrap_or(0) / 100;
        let (primary, secondary) = match job_group {
            2 => (int, luk),
            3 => (dex, str),
            4 => {
                let secondary = if weapon == 133 || weapon == 147 {
                    dex + str
                } else {
                    dex
                };
                (luk, secondary)
            }
            5 if weapon == 149 => (dex, str),
            5 => (str, dex),
            _ => (str, dex),
        };
        let weapon_multiplier = match weapon {
            130 => 4.0,
            131 | 132 | 137 | 138 => 4.4,
            133 | 145 | 146 | 147 | 149 => 3.6,
            140 => 4.6,
            141 | 142 | 148 => 4.8,
            143 | 144 => 5.0,
            _ => 0.0,
        };
        let watk = self.weapon_watk.unwrap_or(0).max(0) as f64;
        let multiplier = self.damage_percent.unwrap_or(0.0).max(0.0) + watk / 100.0;
        let mastery = self.mastery.unwrap_or(0.1).clamp(0.0, 1.0);
        let primary = primary * weapon_multiplier;
        let min = ((primary * 0.9 * mastery) + secondary) * multiplier;
        let max = (primary + secondary) * multiplier;
        let min = min.max(0.0).floor() as i64;
        let max = max.max(min as f64).floor() as i64;
        (min, max)
    }

    fn attack_bounds(&self, facing: i8) -> Option<(f64, f64, f64, f64)> {
        let lt = self.attack_lt.as_ref()?;
        let rb = self.attack_rb.as_ref()?;
        let (left, right) = if facing < 0 {
            (lt.x, rb.x)
        } else {
            (-rb.x, -lt.x)
        };
        Some((left, right, lt.y, rb.y))
    }

    /// Pre-BB community research formula cross-checked by the project owner
    /// against the 2010 PTT compilation. It is retained as an explicit
    /// source-backed approximation; it is not claimed as an official GMS83
    /// specification.
    fn contact_damage(&self, level: u32, monster: &MonsterTemplate) -> Option<i64> {
        if !monster.body_attack {
            return None;
        }
        let pad = monster.pa_damage?.max(0) as f64;
        let weapon_defense = self.weapon_defense?;
        let standard_pdd = self
            .standard_pdd
            .iter()
            .filter(|entry| entry.level <= level)
            .max_by_key(|entry| entry.level)?
            .value;
        let str = self.base_str.unwrap_or(0).max(0) as f64;
        let dex = self.base_dex.unwrap_or(0).max(0) as f64;
        let int = self.base_int.unwrap_or(0).max(0) as f64;
        let luk = self.base_luk.unwrap_or(0).max(0) as f64;
        let c = str / 2_000.0 + dex / 2_800.0 + int / 7_200.0 + luk / 3_200.0;
        let a = c + 0.28;
        let b = if weapon_defense >= standard_pdd {
            c * 28.0 / 45.0 + level as f64 * 7.0 / 13_000.0 + 0.196
        } else {
            let level_factor = if level >= monster.level {
                13.0 / (13.0 + (level - monster.level) as f64)
            } else {
                1.3
            };
            (c + level as f64 / 550.0 + 0.28) * level_factor
        };
        let raw = pad * pad * rand::thread_rng().gen_range(0.008..=0.0085)
            - weapon_defense as f64 * a
            - (weapon_defense - standard_pdd) as f64 * b;
        Some(raw.floor().max(1.0) as i64)
    }
}

pub enum Command {
    Join {
        identity: Identity,
        connection: String,
        output: mpsc::Sender<String>,
        reply: oneshot::Sender<bool>,
    },
    Input {
        id: String,
        connection: String,
        message: ClientMessage,
    },
    Leave {
        id: String,
        connection: String,
    },
}

struct Player {
    state: PlayerState,
    map_id: String,
    death_id: String,
    connection: String,
    output: mpsc::Sender<String>,
    direction: i8,
    vertical: i8,
    jump: bool,
    foothold_id: u64,
    // HeavenClient keeps the current foothold available to its lower-border
    // recovery even while a jump has temporarily cleared the active fhid.
    // This is server-internal state; the wire contract still exposes only
    // the authoritative PlayerState.
    last_foothold_id: u64,
    // A lower-border recovery clamps the player back to an authored edge.
    // Hold that source boundary until a neutral input arrives so the client
    // input heartbeat cannot immediately walk the player off and repeat the
    // recovery jump.
    fall_boundary_hold: bool,
    drop_fh: u64,
    last_input: Instant,
    attack_until: u64,
    contact_invulnerable_until: u64,
}

struct Monster {
    state: MonsterState,
    map_id: String,
    template: MonsterTemplate,
    spawn: MonsterSpawn,
    foothold_id: u64,
    horizontal_speed: f64,
    damage_by_player: BTreeMap<String, i64>,
    death_until: Option<u64>,
    respawn_at: Option<u64>,
}

struct PendingAttack {
    player_id: String,
    request_id: String,
    action_id: String,
    hit_tick: u64,
}

pub struct World {
    pub map: Map,
    pub gameplay: Gameplay,
    maps: BTreeMap<String, Map>,
    players: BTreeMap<String, Player>,
    monsters: BTreeMap<String, Monster>,
    drops: BTreeMap<String, DropState>,
    drop_owners: BTreeMap<String, Option<String>>,
    drop_maps: BTreeMap<String, String>,
    revive_requests: BTreeMap<(String, String), auth::ReviveOutcome>,
    inventory_requests: BTreeMap<(String, String), auth::InventoryOutcome>,
    pending_attacks: BTreeMap<String, PendingAttack>,
    tick: u64,
    combat: Combat,
    store: Option<Store>,
    next_monster: u64,
}

impl World {
    pub fn new(map: Map, duration_ms: u64) -> Self {
        Self::build(map, duration_ms, Gameplay::default(), None).unwrap()
    }

    pub fn new_with_gameplay(map: Map, duration_ms: u64, gameplay: Gameplay) -> Self {
        Self::build(map, duration_ms, gameplay, None).unwrap()
    }

    pub fn new_with_store(
        map: Map,
        duration_ms: u64,
        gameplay: Gameplay,
        store: Store,
    ) -> Result<Self, String> {
        Self::build(map, duration_ms, gameplay, Some(store))
    }

    fn build(
        map: Map,
        duration_ms: u64,
        gameplay: Gameplay,
        store: Option<Store>,
    ) -> Result<Self, String> {
        let hit_after_ms = gameplay.player.attack_after_ms.unwrap_or(duration_ms);
        let mut world = Self {
            maps: BTreeMap::from([(map.id.clone(), map.clone())]),
            map,
            gameplay,
            players: BTreeMap::new(),
            monsters: BTreeMap::new(),
            drops: BTreeMap::new(),
            drop_owners: BTreeMap::new(),
            drop_maps: BTreeMap::new(),
            revive_requests: BTreeMap::new(),
            inventory_requests: BTreeMap::new(),
            pending_attacks: BTreeMap::new(),
            tick: 0,
            combat: Combat::new(duration_ms, hit_after_ms),
            store,
            next_monster: 0,
        };
        if let Some(store) = &world.store {
            for drop in store.load_drops(&world.map.id)? {
                let drop_id = drop.id.clone();
                let owner_id = drop.owner_id.clone();
                world.drops.insert(
                    drop_id.clone(),
                    DropState {
                        id: drop.id,
                        item_id: drop.item_id,
                        quantity: drop.quantity,
                        x: drop.x,
                        y: drop.y,
                    },
                );
                world.drop_owners.insert(drop_id.clone(), owner_id);
                world.drop_maps.insert(drop_id, world.map.id.clone());
            }
        }
        world.spawn_configured_monsters();
        Ok(world)
    }

    pub fn new_with_store_and_catalog(
        map: Map,
        duration_ms: u64,
        gameplay: Gameplay,
        store: Store,
        catalog: MapCatalog,
    ) -> Result<Self, String> {
        let mut world = Self::build(map, duration_ms, gameplay, Some(store))?;
        world.attach_catalog(catalog)?;
        Ok(world)
    }

    fn attach_catalog(&mut self, catalog: MapCatalog) -> Result<(), String> {
        if catalog.birth_map_id != self.map.id {
            return Err(format!(
                "map catalog birth map {} does not match {}",
                catalog.birth_map_id, self.map.id
            ));
        }
        for map in catalog.maps {
            let map_id = map.id.clone();
            self.maps.insert(map_id.clone(), map);
            if let Some(store) = self.store.as_ref() {
                for drop in store.load_drops(&map_id)? {
                    let drop_id = drop.id.clone();
                    self.drops.insert(
                        drop_id.clone(),
                        DropState {
                            id: drop.id,
                            item_id: drop.item_id,
                            quantity: drop.quantity,
                            x: drop.x,
                            y: drop.y,
                        },
                    );
                    self.drop_owners.insert(drop_id.clone(), drop.owner_id);
                    self.drop_maps.insert(drop_id, map_id.clone());
                }
            }
        }
        Ok(())
    }

    fn map_for(&self, map_id: &str) -> &Map {
        self.maps.get(map_id).unwrap_or(&self.map)
    }

    fn default_profile(&self) -> Profile {
        let max_hp = self.gameplay.player.max_hp.unwrap_or(1).max(1);
        let max_mp = self.gameplay.player.max_mp.unwrap_or(0).max(0);
        Profile {
            hp: max_hp,
            max_hp,
            mp: max_mp,
            max_mp,
            level: 1,
            exp: 0,
            exp_to_next: self.gameplay.exp_table.first().copied().unwrap_or(0),
            mesos: 0,
            death_id: String::new(),
            inventory: Vec::new(),
        }
    }

    fn spawn_configured_monsters(&mut self) {
        let spawns = self.gameplay.spawns.clone();
        for spawn in spawns {
            self.spawn_monster(spawn);
        }
    }

    fn spawn_monster(&mut self, spawn: MonsterSpawn) {
        let map_id = self.map.id.clone();
        self.spawn_monster_on_map(map_id, spawn);
    }

    fn spawn_monster_on_map(&mut self, map_id: String, spawn: MonsterSpawn) {
        let Some(template) = self
            .gameplay
            .monsters
            .iter()
            .find(|template| template.template_id == spawn.template_id)
            .cloned()
        else {
            return;
        };
        let map = self.map_for(&map_id).clone();
        let foothold_id = spawn.foothold_id.or_else(|| {
            map.ground_near(spawn.x, spawn.y)
                .map(|(foothold_id, _)| foothold_id)
        });
        let (x, y) = foothold_id
            .and_then(|id| {
                map.get(id)
                    .and_then(|f| f.at(spawn.x).map(|y| (spawn.x, y)))
            })
            .unwrap_or((spawn.x, spawn.y));
        self.next_monster = self.next_monster.wrapping_add(1);
        let id = format!("monster-{}-{}", self.next_monster, auth::random_id());
        let can_move = template.can_move();
        self.monsters.insert(
            id.clone(),
            Monster {
                state: MonsterState {
                    id,
                    template_id: template.template_id.clone(),
                    x,
                    y,
                    // A controlled mob calls next_move immediately when it
                    // spawns in STAND.  For a movable Snail that is MOVE
                    // with a random source direction; immobile templates
                    // remain STAND.
                    facing: if can_move { random_monster_facing() } else { 1 },
                    hp: template.max_hp,
                    max_hp: template.max_hp,
                    action: if can_move { "move" } else { "stand" },
                    action_started_tick: self.tick,
                },
                map_id,
                template,
                spawn,
                foothold_id: foothold_id.unwrap_or(0),
                horizontal_speed: 0.0,
                damage_by_player: BTreeMap::new(),
                death_until: None,
                respawn_at: None,
            },
        );
    }

    fn snapshot(&self, id: &str) -> String {
        let map_id = self
            .players
            .get(id)
            .map(|player| player.map_id.as_str())
            .unwrap_or(self.map.id.as_str());
        serde_json::json!({
            "type":"snapshot",
            "serverTick":self.tick,
            "tickMs":TICK_MS,
            "mapId":map_id,
            "selfId":id,
            "players":self.players.values().filter(|p| p.map_id == map_id).map(|p| &p.state).collect::<Vec<_>>(),
            "monsters":self.monsters.values().filter(|m| m.map_id == map_id).map(|m| &m.state).collect::<Vec<_>>(),
            "drops":self.drops.iter().filter(|(drop_id, _)| self.drop_maps.get(*drop_id).is_some_and(|drop_map| drop_map == map_id)).map(|(_, drop)| drop).collect::<Vec<_>>()
        })
        .to_string()
    }

    fn broadcast_to_map(&mut self, map_id: &str, message: &str) {
        let failed: Vec<String> = self
            .players
            .iter()
            .filter(|(_, player)| player.map_id == map_id)
            .filter_map(
                |(id, player)| match player.output.try_send(message.to_owned()) {
                    Err(TrySendError::Closed(_)) => Some(id.clone()),
                    Err(TrySendError::Full(_)) | Ok(()) => None,
                },
            )
            .collect();
        for id in failed {
            self.players.remove(&id);
            self.pending_attacks
                .retain(|_, attack| attack.player_id != id);
        }
    }

    pub fn command(&mut self, command: Command) {
        match command {
            Command::Join {
                identity,
                connection,
                output,
                reply,
            } => {
                if self.players.contains_key(&identity.id) {
                    let _ = output.try_send(reject(
                        "already_connected",
                        "This character is already connected",
                        None,
                    ));
                    let _ = reply.send(false);
                    return;
                }
                let mut profile = match self.store.as_ref() {
                    Some(store) => {
                        match store.load_profile(&identity.id, &self.default_profile()) {
                            Ok(profile) => profile,
                            Err(error) => {
                                let _ = output.try_send(reject("persistence", &error, None));
                                let _ = reply.send(false);
                                return;
                            }
                        }
                    }
                    None => self.default_profile(),
                };
                if profile.hp <= 0 && profile.death_id.is_empty() {
                    profile.death_id = auth::random_id();
                    if let Some(store) = self.store.as_ref() {
                        if let Err(error) = store.save_profile(&identity.id, &profile) {
                            let _ = output.try_send(reject("persistence", &error, None));
                            let _ = reply.send(false);
                            return;
                        }
                    }
                }
                let id = identity.id.clone();
                let birth_map_id = self.map.id.clone();
                let foothold_id = self
                    .map
                    .ground_near(self.map.spawn.x, self.map.spawn.y)
                    .map(|(id, _)| id)
                    .unwrap_or(0);
                self.players.insert(
                    id.clone(),
                    Player {
                        state: PlayerState {
                            id: id.clone(),
                            username: identity.username,
                            x: self.map.spawn.x,
                            y: self.map.spawn.y,
                            vx: 0.,
                            vy: 0.,
                            facing: 1,
                            grounded: false,
                            // A persisted zero-HP profile reconnects into
                            // the same dead state so the source revive flow
                            // remains available after a process restart.
                            action: if profile.hp <= 0 { "dead" } else { "stand" },
                            action_id: None,
                            action_started_tick: self.tick,
                            last_input_seq: 0,
                            climbing: false,
                            ladder_id: None,
                            hp: profile.hp.min(profile.max_hp).max(0),
                            max_hp: profile.max_hp.max(1),
                            mp: profile.mp.min(profile.max_mp).max(0),
                            max_mp: profile.max_mp.max(0),
                            level: profile.level.max(1),
                            exp: profile.exp,
                            exp_to_next: profile.exp_to_next,
                            mesos: profile.mesos,
                            inventory: profile.inventory,
                        },
                        map_id: birth_map_id,
                        death_id: profile.death_id,
                        connection,
                        output: output.clone(),
                        direction: 0,
                        vertical: 0,
                        jump: false,
                        foothold_id,
                        last_foothold_id: foothold_id,
                        fall_boundary_hold: false,
                        drop_fh: 0,
                        last_input: Instant::now(),
                        attack_until: 0,
                        contact_invulnerable_until: 0,
                    },
                );
                let _ = output.try_send(self.snapshot(&id));
                let _ = reply.send(true);
            }
            Command::Leave { id, connection } => {
                if self
                    .players
                    .get(&id)
                    .is_some_and(|p| p.connection == connection)
                {
                    self.players.remove(&id);
                    self.pending_attacks
                        .retain(|_, attack| attack.player_id != id);
                    self.inventory_requests
                        .retain(|(player_id, _), _| player_id != &id);
                }
            }
            Command::Input {
                id,
                connection,
                message,
            } => {
                let Some(player) = self.players.get(&id).filter(|p| p.connection == connection)
                else {
                    return;
                };
                match message {
                    ClientMessage::Input {
                        seq,
                        direction,
                        vertical,
                        jump,
                    } => {
                        if seq <= player.state.last_input_seq {
                            return;
                        }
                        let Some(player) = self.players.get_mut(&id) else {
                            return;
                        };
                        player.state.last_input_seq = seq;
                        if player.fall_boundary_hold && (direction == 0 || vertical != 0 || jump) {
                            // Horizontal input alone may be a held-key
                            // heartbeat; a neutral packet is the release
                            // marker. Vertical movement or a jump is an
                            // explicit new action and may leave the boundary.
                            player.fall_boundary_hold = false;
                        }
                        player.direction = direction;
                        player.vertical = vertical;
                        player.jump |= jump;
                        player.last_input = Instant::now();
                    }
                    ClientMessage::Attack { request_id } => self.handle_attack(id, request_id),
                    ClientMessage::Pickup {
                        request_id,
                        drop_id,
                    } => self.handle_pickup(id, request_id, drop_id),
                    ClientMessage::Portal {
                        request_id,
                        portal_name,
                    } => self.handle_portal(id, request_id, portal_name),
                    ClientMessage::InventoryMove {
                        request_id,
                        source_slot,
                        target_slot,
                        quantity,
                    } => self.handle_inventory_move(
                        id,
                        request_id,
                        source_slot,
                        target_slot,
                        quantity,
                    ),
                    ClientMessage::DropItem {
                        request_id,
                        source_slot,
                        quantity,
                    } => self.handle_inventory_drop(id, request_id, source_slot, quantity),
                    ClientMessage::Revive { request_id } => self.handle_revive(id, request_id),
                    ClientMessage::Hello { .. } => {}
                }
            }
        }
    }

    fn handle_portal(&mut self, id: String, request_id: String, portal_name: String) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        let source_map_id = player.map_id.clone();
        let source_x = player.state.x;
        let source_y = player.state.y;
        let source_map = self.map_for(&source_map_id).clone();
        let Some(portal) = source_map
            .portals
            .iter()
            .find(|portal| portal.name == portal_name && portal.target_map_id.is_some())
            .cloned()
        else {
            self.send_portal_result(
                &id,
                &request_id,
                false,
                "portal_unavailable",
                &source_map_id,
                None,
            );
            return;
        };
        if (source_x - portal.x).abs() > 48.0 || (source_y - portal.y).abs() > 64.0 {
            self.send_portal_result(
                &id,
                &request_id,
                false,
                "out_of_range",
                &source_map_id,
                None,
            );
            return;
        }
        let Some(target_map_id) = portal.target_map_id.clone() else {
            self.send_portal_result(
                &id,
                &request_id,
                false,
                "portal_unavailable",
                &source_map_id,
                None,
            );
            return;
        };
        let Some(target_map) = self.maps.get(&target_map_id).cloned() else {
            self.send_portal_result(
                &id,
                &request_id,
                false,
                "map_unavailable",
                &source_map_id,
                None,
            );
            return;
        };
        let destination = portal
            .target_portal_name
            .as_deref()
            .and_then(|name| {
                target_map
                    .portals
                    .iter()
                    .find(|candidate| candidate.name == name)
            })
            .map(|portal| (portal.x, portal.y))
            .unwrap_or((target_map.spawn.x, target_map.spawn.y));
        let grounded = target_map
            .ground_near(destination.0, destination.1)
            .filter(|(_, ground)| (ground - destination.1).abs() <= 24.0);
        let (target_x, target_y, foothold_id, grounded) = grounded.map_or(
            (destination.0, destination.1, 0, false),
            |(foothold_id, ground)| (destination.0, ground, foothold_id, true),
        );
        let Some(player) = self.players.get_mut(&id) else {
            return;
        };
        player.map_id = target_map_id.clone();
        player.state.x = target_x;
        player.state.y = target_y;
        player.state.vx = 0.0;
        player.state.vy = 0.0;
        player.state.facing = 1;
        player.state.grounded = grounded;
        player.state.climbing = false;
        player.state.ladder_id = None;
        player.state.action_id = None;
        player.state.action = if grounded { "stand" } else { "jump" };
        player.state.action_started_tick = self.tick;
        player.direction = 0;
        player.vertical = 0;
        player.jump = false;
        player.foothold_id = foothold_id;
        player.last_foothold_id = foothold_id;
        player.fall_boundary_hold = false;
        player.drop_fh = 0;
        player.attack_until = 0;
        self.send_portal_result(
            &id,
            &request_id,
            true,
            "",
            &source_map_id,
            Some(&target_map_id),
        );
    }

    fn send_portal_result(
        &self,
        id: &str,
        request_id: &str,
        success: bool,
        code: &str,
        source_map_id: &str,
        target_map_id: Option<&str>,
    ) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let mut message = serde_json::json!({
            "type": "portalResult",
            "requestId": request_id,
            "success": success,
            "code": code,
            "sourceMapId": source_map_id,
        });
        if let Some(target_map_id) = target_map_id {
            message["targetMapId"] = target_map_id.into();
        }
        let _ = player.output.try_send(message.to_string());
    }

    fn handle_attack(&mut self, id: String, request_id: String) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        if player.state.climbing || player.state.action == "dead" {
            let _ = player.output.try_send(reject(
                "invalid_state",
                "Cannot attack while climbing or dead",
                Some(&request_id),
            ));
            return;
        }
        let map_id = player.map_id.clone();
        let active_until = player.attack_until;
        let (x, y, facing) = (player.state.x, player.state.y, player.state.facing);
        let result = self.combat.attack(
            self.store.as_ref(),
            &id,
            &request_id,
            self.tick,
            active_until,
            x,
            y,
            facing,
        );
        match result {
            Attack::Reply(message) => {
                if let Some(player) = self.players.get(&id) {
                    let _ = player.output.try_send(message);
                }
            }
            Attack::Started { action_id, event } => {
                let hit_tick = self.tick + self.combat.hit_after_ms.div_ceil(TICK_MS).max(1);
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.action_id = Some(action_id.clone());
                    player.state.action = "attack";
                    player.state.action_started_tick = self.tick;
                    player.attack_until = self.tick + self.combat.duration_ms.div_ceil(TICK_MS);
                }
                self.pending_attacks.insert(
                    action_id.clone(),
                    PendingAttack {
                        player_id: id,
                        request_id,
                        action_id,
                        hit_tick,
                    },
                );
                self.broadcast_to_map(&map_id, &event);
            }
            Attack::Resume {
                action_id,
                event: _,
            } => {
                let hit_tick = self.tick + self.combat.hit_after_ms.div_ceil(TICK_MS).max(1);
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.action_id = Some(action_id.clone());
                    player.state.action = "attack";
                    player.state.action_started_tick = self.tick;
                    player.attack_until = self.tick + self.combat.duration_ms.div_ceil(TICK_MS);
                }
                self.pending_attacks.insert(
                    action_id.clone(),
                    PendingAttack {
                        player_id: id,
                        request_id,
                        action_id,
                        hit_tick,
                    },
                );
            }
        }
    }

    fn handle_pickup(&mut self, id: String, request_id: String, drop_id: String) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        let map_id = player.map_id.clone();
        if let Some(store) = self.store.as_ref() {
            match store.prior_pickup(&id, &request_id) {
                Ok(Some(prior)) => {
                    self.send_pickup_outcome(&id, &request_id, prior);
                    return;
                }
                Ok(None) => {}
                Err(error) => {
                    let _ =
                        player
                            .output
                            .try_send(reject("persistence", &error, Some(&request_id)));
                    return;
                }
            }
        }
        let Some(drop) = self.drops.get(&drop_id) else {
            let _ = player.output.try_send(reject(
                "drop_unavailable",
                "Drop is unavailable",
                Some(&request_id),
            ));
            return;
        };
        if self
            .drop_maps
            .get(&drop_id)
            .is_some_and(|drop_map| drop_map != &map_id)
        {
            let _ = player.output.try_send(reject(
                "drop_unavailable",
                "Drop is unavailable",
                Some(&request_id),
            ));
            return;
        }
        if self
            .drop_owners
            .get(&drop_id)
            .and_then(Option::as_deref)
            .is_some_and(|owner| owner != id)
        {
            let _ = player.output.try_send(reject(
                "drop_owned",
                "Drop belongs to another player",
                Some(&request_id),
            ));
            return;
        }
        let pickup_range = 32.0;
        if (player.state.x - drop.x).abs() > pickup_range
            || (player.state.y - drop.y).abs() > pickup_range
        {
            let _ = player.output.try_send(reject(
                "out_of_range",
                "Drop is out of range",
                Some(&request_id),
            ));
            return;
        }
        if self.store.is_none() && drop.item_id != "0" {
            let mut inventory = player.state.inventory.clone();
            if inventory::add_items(&mut inventory, drop.item_id.clone(), drop.quantity).is_err() {
                let _ = player.output.try_send(reject(
                    "inventory_full",
                    "Inventory is full",
                    Some(&request_id),
                ));
                return;
            }
        }
        let outcome = match self.store.as_ref() {
            Some(store) => store.pickup(&id, &map_id, &request_id, &drop_id),
            None => Ok(auth::PickupOutcome {
                drop_id: drop_id.clone(),
                item_id: drop.item_id.clone(),
                quantity: drop.quantity,
                slot: None,
                success: true,
                code: String::new(),
            }),
        };
        match outcome {
            Ok(mut outcome) if outcome.success => {
                self.drops.remove(&drop_id);
                self.drop_owners.remove(&drop_id);
                self.drop_maps.remove(&drop_id);
                let mut reload_profile = false;
                if let Some(player) = self.players.get_mut(&id) {
                    if outcome.item_id == "0" {
                        player.state.mesos =
                            player.state.mesos.saturating_add(outcome.quantity as u64);
                    } else {
                        let assigned_slot = inventory::add_items(
                            &mut player.state.inventory,
                            outcome.item_id.clone(),
                            outcome.quantity,
                        );
                        if outcome.slot.is_none() {
                            outcome.slot = assigned_slot.ok();
                        } else if assigned_slot.ok() != outcome.slot {
                            // The SQLite pickup transaction is authoritative.
                            // If a stale in-memory profile chose another slot,
                            // reload the committed profile before the next
                            // snapshot rather than exposing a missing item.
                            reload_profile = true;
                        }
                    }
                }
                if reload_profile {
                    if let Some(store) = self.store.clone() {
                        let defaults = self.default_profile();
                        if let Ok(profile) = store.load_profile(&id, &defaults) {
                            if let Some(player) = self.players.get_mut(&id) {
                                apply_profile(&mut player.state, profile);
                            }
                        }
                    }
                }
                self.send_pickup_outcome(&id, &request_id, outcome);
            }
            Ok(outcome) => {
                self.send_pickup_outcome(&id, &request_id, outcome);
            }
            Err(error) => {
                if let Some(player) = self.players.get(&id) {
                    let _ =
                        player
                            .output
                            .try_send(reject("persistence", &error, Some(&request_id)));
                }
            }
        }
    }

    fn handle_inventory_move(
        &mut self,
        id: String,
        request_id: String,
        from_slot: u16,
        to_slot: u16,
        quantity: u32,
    ) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        if let Some(store) = self.store.clone() {
            match store.prior_inventory(&id, &request_id) {
                Ok(Some(prior)) => {
                    if prior.operation == "move" {
                        self.send_inventory_outcome(&id, &prior);
                    } else {
                        self.send_inventory_conflict(&id, &request_id);
                    }
                    return;
                }
                Ok(None) => {}
                Err(error) => {
                    let _ =
                        player
                            .output
                            .try_send(reject("persistence", &error, Some(&request_id)));
                    return;
                }
            }
            match store.move_inventory(&id, &request_id, from_slot, to_slot, quantity) {
                Ok(outcome) => {
                    if outcome.success {
                        let applied = self
                            .players
                            .get_mut(&id)
                            .map(|player| {
                                inventory::move_items(
                                    &mut player.state.inventory,
                                    from_slot,
                                    to_slot,
                                    quantity,
                                )
                                .is_ok()
                            })
                            .unwrap_or(false);
                        if !applied {
                            // The SQLite transaction is authoritative.  A
                            // mismatch means the in-memory profile was stale;
                            // reload it before the next snapshot so a client
                            // cannot observe or repeat a partial mutation.
                            let defaults = self.default_profile();
                            if let Ok(profile) = store.load_profile(&id, &defaults) {
                                if let Some(player) = self.players.get_mut(&id) {
                                    apply_profile(&mut player.state, profile);
                                }
                            }
                        }
                    }
                    self.send_inventory_outcome(&id, &outcome);
                }
                Err(error) => {
                    if let Some(player) = self.players.get(&id) {
                        let _ = player.output.try_send(reject(
                            "persistence",
                            &error,
                            Some(&request_id),
                        ));
                    }
                }
            }
            return;
        }

        if let Some(prior) = self
            .inventory_requests
            .get(&(id.clone(), request_id.clone()))
            .cloned()
        {
            if prior.operation == "move" {
                self.send_inventory_outcome(&id, &prior);
            } else {
                self.send_inventory_conflict(&id, &request_id);
            }
            return;
        }
        let mut next_inventory = player.state.inventory.clone();
        let item_id = next_inventory
            .iter()
            .find(|item| item.slot == from_slot)
            .map(|item| item.item_id.clone())
            .unwrap_or_default();
        let result = inventory::move_items(&mut next_inventory, from_slot, to_slot, quantity);
        let (success, code) = match result {
            Ok(()) => {
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.inventory = next_inventory;
                }
                (true, String::new())
            }
            Err(error) => (false, error.code().to_owned()),
        };
        let outcome = auth::InventoryOutcome {
            request_id: request_id.clone(),
            operation: "move".to_owned(),
            from_slot,
            to_slot: Some(to_slot),
            item_id,
            quantity,
            drop_id: None,
            success,
            code,
        };
        self.inventory_requests
            .insert((id.clone(), request_id), outcome.clone());
        self.send_inventory_outcome(&id, &outcome);
    }

    fn handle_inventory_drop(
        &mut self,
        id: String,
        request_id: String,
        from_slot: u16,
        quantity: u32,
    ) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        let map_id = player.map_id.clone();
        let drop_x = player.state.x;
        let drop_y = player.state.y;
        if let Some(store) = self.store.clone() {
            match store.prior_inventory(&id, &request_id) {
                Ok(Some(prior)) => {
                    if prior.operation == "drop" {
                        self.ensure_inventory_drop(&prior, &map_id);
                        self.send_inventory_outcome(&id, &prior);
                    } else {
                        self.send_inventory_conflict(&id, &request_id);
                    }
                    return;
                }
                Ok(None) => {}
                Err(error) => {
                    let _ =
                        player
                            .output
                            .try_send(reject("persistence", &error, Some(&request_id)));
                    return;
                }
            }
            match store.drop_inventory(
                &id,
                &map_id,
                &request_id,
                from_slot,
                quantity,
                drop_x,
                drop_y,
            ) {
                Ok(outcome) => {
                    if outcome.success {
                        let applied = self
                            .players
                            .get_mut(&id)
                            .map(|player| {
                                inventory::remove_items(
                                    &mut player.state.inventory,
                                    from_slot,
                                    quantity,
                                )
                                .is_ok()
                            })
                            .unwrap_or(false);
                        if !applied {
                            let defaults = self.default_profile();
                            if let Ok(profile) = store.load_profile(&id, &defaults) {
                                if let Some(player) = self.players.get_mut(&id) {
                                    apply_profile(&mut player.state, profile);
                                }
                            }
                        }
                        self.ensure_inventory_drop_at(&outcome, drop_x, drop_y, &id, &map_id);
                    }
                    self.send_inventory_outcome(&id, &outcome);
                }
                Err(error) => {
                    if let Some(player) = self.players.get(&id) {
                        let _ = player.output.try_send(reject(
                            "persistence",
                            &error,
                            Some(&request_id),
                        ));
                    }
                }
            }
            return;
        }

        if let Some(prior) = self
            .inventory_requests
            .get(&(id.clone(), request_id.clone()))
            .cloned()
        {
            if prior.operation == "drop" {
                self.send_inventory_outcome(&id, &prior);
            } else {
                self.send_inventory_conflict(&id, &request_id);
            }
            return;
        }
        let mut next_inventory = player.state.inventory.clone();
        let item_id = next_inventory
            .iter()
            .find(|item| item.slot == from_slot)
            .map(|item| item.item_id.clone())
            .unwrap_or_default();
        let result = inventory::remove_items(&mut next_inventory, from_slot, quantity);
        let (success, code, drop_id) = match result {
            Ok((item_id, dropped_quantity)) => {
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.inventory = next_inventory;
                }
                let drop_id = auth::random_id();
                self.drops.insert(
                    drop_id.clone(),
                    DropState {
                        id: drop_id.clone(),
                        item_id,
                        quantity: dropped_quantity,
                        x: drop_x,
                        y: drop_y,
                    },
                );
                self.drop_owners.insert(drop_id.clone(), Some(id.clone()));
                self.drop_maps.insert(drop_id.clone(), map_id.clone());
                (true, String::new(), Some(drop_id))
            }
            Err(error) => (false, error.code().to_owned(), None),
        };
        let outcome = auth::InventoryOutcome {
            request_id: request_id.clone(),
            operation: "drop".to_owned(),
            from_slot,
            to_slot: None,
            item_id,
            quantity,
            drop_id,
            success,
            code,
        };
        self.inventory_requests
            .insert((id.clone(), request_id), outcome.clone());
        self.send_inventory_outcome(&id, &outcome);
    }

    fn send_inventory_conflict(&self, id: &str, request_id: &str) {
        if let Some(player) = self.players.get(id) {
            let _ = player.output.try_send(reject(
                "request_reused",
                "Request ID was used for another inventory operation",
                Some(request_id),
            ));
        }
    }

    fn send_inventory_outcome(&self, id: &str, outcome: &auth::InventoryOutcome) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let message_type = if outcome.operation == "drop" {
            "inventoryDropResult"
        } else {
            "inventoryResult"
        };
        let mut message = serde_json::json!({
            "type": message_type,
            "requestId": outcome.request_id,
            "operation": outcome.operation,
            "success": outcome.success,
            "code": outcome.code,
            "sourceSlot": outcome.from_slot,
            "itemId": outcome.item_id,
            "quantity": outcome.quantity,
        });
        if let Some(target_slot) = outcome.to_slot {
            message["targetSlot"] = target_slot.into();
        }
        if let Some(drop_id) = outcome.drop_id.as_deref() {
            message["dropId"] = drop_id.into();
        }
        let message = message.to_string();
        let _ = player.output.try_send(message);
    }

    fn ensure_inventory_drop(&mut self, outcome: &auth::InventoryOutcome, map_id: &str) {
        let Some(drop_id) = outcome.drop_id.as_deref() else {
            return;
        };
        if self.drops.contains_key(drop_id) {
            return;
        }
        let Some(store) = self.store.as_ref() else {
            return;
        };
        if let Ok(Some(drop)) = store.load_drop(map_id, drop_id) {
            self.drops.insert(
                drop_id.to_owned(),
                DropState {
                    id: drop.id.clone(),
                    item_id: drop.item_id,
                    quantity: drop.quantity,
                    x: drop.x,
                    y: drop.y,
                },
            );
            self.drop_owners.insert(drop_id.to_owned(), drop.owner_id);
            self.drop_maps.insert(drop_id.to_owned(), map_id.to_owned());
        }
    }

    fn ensure_inventory_drop_at(
        &mut self,
        outcome: &auth::InventoryOutcome,
        x: f64,
        y: f64,
        owner_id: &str,
        map_id: &str,
    ) {
        let Some(drop_id) = outcome.drop_id.as_deref() else {
            return;
        };
        self.drops.insert(
            drop_id.to_owned(),
            DropState {
                id: drop_id.to_owned(),
                item_id: outcome.item_id.clone(),
                quantity: outcome.quantity,
                x,
                y,
            },
        );
        self.drop_owners
            .insert(drop_id.to_owned(), Some(owner_id.to_owned()));
        self.drop_maps.insert(drop_id.to_owned(), map_id.to_owned());
    }

    fn handle_revive(&mut self, id: String, request_id: String) {
        // Check a persisted request first.  A response from an earlier death
        // must never revive a later death that happens to reuse the same
        // client request id.
        let death_id = self
            .players
            .get(&id)
            .map(|player| player.death_id.clone())
            .unwrap_or_default();
        let dead = self
            .players
            .get(&id)
            .is_some_and(|player| player.state.action == "dead");

        if let Some(store) = self.store.as_ref() {
            match store.prior_revive(&id, &request_id) {
                Ok(Some(prior)) => {
                    if prior.success && dead && prior.death_id == death_id {
                        self.complete_revive(&id, &death_id);
                        self.send_revive_outcome(&id, prior);
                    } else if prior.success && dead && prior.death_id != death_id {
                        self.send_revive_outcome(
                            &id,
                            auth::ReviveOutcome {
                                request_id,
                                death_id,
                                success: false,
                                code: "revive_stale".to_owned(),
                            },
                        );
                    } else {
                        // A successful replay after the same death has
                        // already completed is still the original idempotent
                        // result.  Only a currently-dead later death is
                        // stale; an alive player has no new state to mutate.
                        self.send_revive_outcome(&id, prior);
                    }
                    return;
                }
                Ok(None) => {}
                Err(error) => {
                    if let Some(player) = self.players.get(&id) {
                        let _ = player.output.try_send(reject(
                            "persistence",
                            &error,
                            Some(&request_id),
                        ));
                    }
                    return;
                }
            }
            if !dead || death_id.is_empty() {
                if let Some(player) = self.players.get(&id) {
                    let _ = player.output.try_send(reject(
                        "invalid_state",
                        "Cannot revive while alive",
                        Some(&request_id),
                    ));
                }
                return;
            }
            match store.revive(&id, &request_id, &death_id) {
                Ok(outcome) => {
                    if outcome.success {
                        self.complete_revive(&id, &death_id);
                    }
                    self.send_revive_outcome(&id, outcome);
                }
                Err(error) => {
                    if let Some(player) = self.players.get(&id) {
                        let _ = player.output.try_send(reject(
                            "persistence",
                            &error,
                            Some(&request_id),
                        ));
                    }
                }
            }
            return;
        }

        if let Some(prior) = self
            .revive_requests
            .get(&(id.clone(), request_id.clone()))
            .cloned()
        {
            if prior.success && dead && prior.death_id == death_id {
                self.complete_revive(&id, &death_id);
                self.send_revive_outcome(&id, prior);
            } else if prior.success && dead && prior.death_id != death_id {
                self.send_revive_outcome(
                    &id,
                    auth::ReviveOutcome {
                        request_id,
                        death_id,
                        success: false,
                        code: "revive_stale".to_owned(),
                    },
                );
            } else {
                // See the persisted branch above: replaying a completed
                // request while alive returns its original result.
                self.send_revive_outcome(&id, prior);
            }
            return;
        }
        if !dead || death_id.is_empty() {
            if let Some(player) = self.players.get(&id) {
                let _ = player.output.try_send(reject(
                    "invalid_state",
                    "Cannot revive while alive",
                    Some(&request_id),
                ));
            }
            return;
        }
        let outcome = auth::ReviveOutcome {
            request_id: request_id.clone(),
            death_id: death_id.clone(),
            success: true,
            code: String::new(),
        };
        self.revive_requests
            .insert((id.clone(), request_id), outcome.clone());
        self.complete_revive(&id, &death_id);
        self.send_revive_outcome(&id, outcome);
    }

    fn complete_revive(&mut self, id: &str, death_id: &str) {
        let Some(map_id) = self.players.get(id).map(|player| player.map_id.clone()) else {
            return;
        };
        let map = self.map_for(&map_id).clone();
        let Some(player) = self.players.get_mut(id) else {
            return;
        };
        if player.state.action != "dead" || player.death_id != death_id {
            return;
        }
        player.state.hp = 50_i64.min(player.state.max_hp.max(1));
        // Cosmic's ordinary respawn restores HP while leaving MP untouched.
        player.state.x = map.spawn.x;
        player.state.y = map.spawn.y;
        player.state.vx = 0.0;
        player.state.vy = 0.0;
        player.state.grounded = false;
        player.state.ladder_id = None;
        player.state.climbing = false;
        player.state.action_id = None;
        player.state.action = "stand";
        player.state.action_started_tick = self.tick;
        player.death_id.clear();
        player.attack_until = 0;
        player.contact_invulnerable_until = 0;
        player.direction = 0;
        player.vertical = 0;
        player.jump = false;
        player.foothold_id = map
            .ground_near(map.spawn.x, map.spawn.y)
            .map_or(0, |(foothold_id, _)| foothold_id);
        player.last_foothold_id = player.foothold_id;
        player.fall_boundary_hold = false;
        player.drop_fh = 0;
        let _ = self.persist_player(id);
    }

    fn send_revive_outcome(&self, id: &str, outcome: auth::ReviveOutcome) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let message = serde_json::json!({
            "type":"reviveResult",
            "requestId":outcome.request_id,
            "success":outcome.success,
            "code":outcome.code
        })
        .to_string();
        let _ = player.output.try_send(message);
    }

    fn send_pickup_outcome(&self, id: &str, request_id: &str, outcome: auth::PickupOutcome) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        if outcome.success {
            let mut message = serde_json::json!({
                "type":"pickupResult",
                "requestId":request_id,
                "dropId":outcome.drop_id,
                "itemId":outcome.item_id,
                "quantity":outcome.quantity
            });
            if let Some(slot) = outcome.slot {
                message["slot"] = slot.into();
            }
            let message = message.to_string();
            let _ = player.output.try_send(message);
        } else {
            let _ = player.output.try_send(reject(
                &outcome.code,
                pickup_error_message(&outcome.code),
                Some(request_id),
            ));
        }
    }

    pub fn step(&mut self) {
        self.tick += 1;
        let ids: Vec<String> = self.players.keys().cloned().collect();
        for id in ids {
            let map_id = self
                .players
                .get(&id)
                .map(|player| player.map_id.clone())
                .unwrap_or_else(|| self.map.id.clone());
            let map = self.map_for(&map_id).clone();
            let Some(player) = self.players.get_mut(&id) else {
                continue;
            };
            let old_hp = player.state.hp;
            let old_x = player.state.x;
            let old_y = player.state.y;
            step_player(&map, &self.gameplay, player, self.tick);
            if (player.state.hp != old_hp
                || (player.state.x - old_x).abs() > 0.001
                || (player.state.y - old_y).abs() > 0.001)
                && self.store.is_some()
            {
                let _ = self.persist_player(&id);
            }
        }
        self.resolve_pending_attacks();
        self.step_monsters();
        self.apply_contact_damage();
        self.respawn_monsters();
        let failed: Vec<_> = self
            .players
            .iter()
            .filter_map(|(id, p)| match p.output.try_send(self.snapshot(id)) {
                Err(TrySendError::Closed(_)) => Some(id.clone()),
                Err(TrySendError::Full(_)) | Ok(()) => None,
            })
            .collect();
        for id in failed {
            self.players.remove(&id);
            self.pending_attacks
                .retain(|_, attack| attack.player_id != id);
        }
    }

    fn persist_player(&self, id: &str) -> Result<(), String> {
        let Some(store) = &self.store else {
            return Ok(());
        };
        let Some(player) = self.players.get(id) else {
            return Ok(());
        };
        store.save_profile(id, &profile_from_state(&player.state, &player.death_id))
    }

    fn resolve_pending_attacks(&mut self) {
        let ready: Vec<String> = self
            .pending_attacks
            .iter()
            .filter(|(_, attack)| attack.hit_tick <= self.tick)
            .map(|(id, _)| id.clone())
            .collect();
        for action_id in ready {
            let Some(attack) = self.pending_attacks.remove(&action_id) else {
                continue;
            };
            let Some(player) = self.players.get(&attack.player_id) else {
                continue;
            };
            if player.state.action == "dead" || player.state.climbing {
                continue;
            }
            let map_id = player.map_id.clone();
            let target_id = self.nearest_attack_target(player);
            let (target_hp, max_hp, target_template, target_x, target_y) = target_id
                .as_ref()
                .and_then(|id| self.monsters.get(id))
                .map(|monster| {
                    (
                        monster.state.hp,
                        monster.state.max_hp,
                        monster.template.clone(),
                        monster.state.x,
                        monster.state.y,
                    )
                })
                .unwrap_or((
                    0,
                    0,
                    MonsterTemplate {
                        template_id: String::new(),
                        level: 0,
                        max_hp: 0,
                        pa_damage: None,
                        exp: 0,
                        body_attack: false,
                        move_speed: None,
                        source_speed: None,
                        hitbox_width: None,
                        hitbox_height: None,
                        hitbox_lt: None,
                        hitbox_rb: None,
                        die_duration_ms: None,
                        stand_delay_ms: None,
                        move_duration_ms: None,
                        drop: None,
                    },
                    player.state.x,
                    player.state.y,
                ));
            let damage = self.gameplay.player.attack_damage();
            let killed = target_id.is_some() && target_hp > 0 && damage >= target_hp;
            let applied_damage = target_id
                .is_some()
                .then_some(damage.min(target_hp.max(0)))
                .unwrap_or(0);
            let drops = if killed {
                self.choose_drops(&target_template, target_x, target_y, &attack.player_id)
            } else {
                Vec::new()
            };
            let eligible_accounts: Vec<String> = self.players.keys().cloned().collect();
            let resolution = match self.store.as_ref() {
                Some(store) => store.resolve_attack(
                    &attack.player_id,
                    &map_id,
                    &attack.request_id,
                    target_id.as_deref(),
                    applied_damage,
                    killed,
                    target_template.exp,
                    max_hp,
                    &drops,
                    &self.gameplay.exp_table,
                    &eligible_accounts,
                ),
                None => Ok(auth::AttackResolution {
                    already_resolved: false,
                    target_id: target_id.clone(),
                    damage: applied_damage,
                    killed,
                    exp_gain: if killed { target_template.exp } else { 0 },
                    drop: drops.first().cloned(),
                    drops,
                    profile: None,
                    profiles: Vec::new(),
                }),
            };
            let Ok(resolution) = resolution else {
                if let Some(player) = self.players.get(&attack.player_id) {
                    let _ = player.output.try_send(reject(
                        "persistence",
                        "Attack persistence failed; retry the action",
                        Some(&attack.request_id),
                    ));
                }
                let mut retry = attack;
                retry.hit_tick = self.tick + 1;
                self.pending_attacks.insert(retry.action_id.clone(), retry);
                continue;
            };
            if resolution.already_resolved {
                continue;
            }
            if let Some(target_id) = resolution.target_id.as_deref() {
                if let Some(monster) = self.monsters.get_mut(target_id) {
                    if resolution.damage > 0 {
                        let contribution = monster
                            .damage_by_player
                            .entry(attack.player_id.clone())
                            .or_default();
                        *contribution = contribution.saturating_add(resolution.damage);
                    }
                    monster.state.hp = (monster.state.hp - resolution.damage).max(0);
                    monster.state.action = if monster.state.hp == 0 { "die" } else { "hit" };
                    monster.state.action_started_tick = self.tick;
                    if monster.state.hp == 0 {
                        let die_ticks = monster
                            .template
                            .die_duration_ms
                            .unwrap_or(1)
                            .div_ceil(TICK_MS)
                            .max(1);
                        monster.death_until = Some(self.tick + die_ticks);
                        monster.respawn_at = self.gameplay.monster_respawn_ms.map(|ms| {
                            // Cosmic schedules one map-wide respawn task
                            // every interval (Server.java/RespawnTask),
                            // rather than starting a private timer at each
                            // monster's death.  Align this spawn to the
                            // next world cycle and still require the die
                            // animation to have finished below.
                            let interval_ticks = ms.div_ceil(TICK_MS).max(1);
                            (self.tick / interval_ticks + 1) * interval_ticks
                        });
                    }
                }
                if resolution.damage > 0 {
                    let damage_event = serde_json::json!({
                        "type": "damageEvent",
                        "eventId": format!("damage-event-{}", attack.action_id),
                        "serverTick": self.tick,
                        "attackerId": attack.player_id,
                        "targetId": target_id,
                        "x": target_x,
                        "y": target_y,
                        "damage": resolution.damage,
                        "killed": resolution.killed
                    })
                    .to_string();
                    self.broadcast_to_map(&map_id, &damage_event);
                }
            }
            if !resolution.profiles.is_empty() {
                for (participant, profile) in resolution.profiles {
                    if let Some(player) = self.players.get_mut(&participant) {
                        apply_profile(&mut player.state, profile);
                    }
                }
            } else if let Some(profile) = resolution.profile {
                if let Some(player) = self.players.get_mut(&attack.player_id) {
                    apply_profile(&mut player.state, profile);
                }
            }
            for drop in resolution.drops {
                let drop_id = drop.id.clone();
                self.drops.insert(
                    drop_id.clone(),
                    DropState {
                        id: drop.id,
                        item_id: drop.item_id,
                        quantity: drop.quantity,
                        x: drop.x,
                        y: drop.y,
                    },
                );
                self.drop_owners.insert(drop_id.clone(), drop.owner_id);
                self.drop_maps.insert(drop_id.clone(), map_id.clone());
            }
        }
    }

    fn nearest_attack_target(&self, player: &Player) -> Option<String> {
        let (local_left, local_right, local_top, local_bottom) =
            self.gameplay.player.attack_bounds(player.state.facing)?;
        let attack_left = player.state.x + local_left;
        let attack_right = player.state.x + local_right;
        let attack_top = player.state.y + local_top;
        let attack_bottom = player.state.y + local_bottom;
        self.monsters
            .iter()
            .filter_map(|(id, monster)| {
                if monster.map_id != player.map_id || monster.state.hp <= 0 {
                    return None;
                }
                let (mob_left, mob_right, mob_top, mob_bottom) = monster
                    .template
                    .body_bounds(monster.state.x, monster.state.y)?;
                let overlaps = attack_left <= mob_right
                    && attack_right >= mob_left
                    && attack_top <= mob_bottom
                    && attack_bottom >= mob_top;
                overlaps.then_some((id, monster))
            })
            .min_by(|(a_id, a), (b_id, b)| {
                (a.state.x - player.state.x)
                    .abs()
                    .total_cmp(&(b.state.x - player.state.x).abs())
                    .then_with(|| a_id.cmp(b_id))
            })
            .map(|(id, _)| id.clone())
    }

    fn choose_drops(
        &self,
        template: &MonsterTemplate,
        x: f64,
        y: f64,
        owner_id: &str,
    ) -> Vec<auth::DropRecord> {
        let denominator = self.gameplay.drop_chance_denominator;
        let mut drops = Vec::new();
        for spec in template.drops() {
            if spec.quantity == 0 {
                continue;
            }
            let eligible = match spec.chance {
                None => true,
                Some(chance) => denominator.is_some_and(|denominator| {
                    denominator > 0 && rand::thread_rng().gen_range(0..denominator) < chance
                }),
            };
            if eligible {
                let id = format!("drop-{}", auth::random_id());
                let quantity = spec
                    .quantity_max
                    .filter(|max| *max >= spec.quantity)
                    .map(|max| rand::thread_rng().gen_range(spec.quantity..=max))
                    .unwrap_or(spec.quantity);
                drops.push(auth::DropRecord {
                    id,
                    item_id: spec.item_id,
                    quantity,
                    x,
                    y,
                    owner_id: Some(owner_id.to_owned()),
                });
            }
        }
        drops
    }

    fn step_monsters(&mut self) {
        let ids: Vec<String> = self.monsters.keys().cloned().collect();
        for id in ids {
            let map_id = self
                .monsters
                .get(&id)
                .map(|monster| monster.map_id.clone())
                .unwrap_or_else(|| self.map.id.clone());
            let map = self.map_for(&map_id).clone();
            let Some(monster) = self.monsters.get_mut(&id) else {
                continue;
            };
            if monster.state.hp <= 0 {
                continue;
            }
            let can_move = monster.template.can_move();
            if monster.state.action == "hit" {
                let recovery_ticks = MOB_HIT_RECOVERY_MS.div_ceil(TICK_MS);
                if self.tick.saturating_sub(monster.state.action_started_tick) < recovery_ticks {
                    continue;
                }
                // Mob::next_move() treats HIT like STAND: a movable mob
                // immediately enters MOVE with a random direction.
                monster.state.action = if can_move { "move" } else { "stand" };
                if can_move {
                    monster.state.facing = random_monster_facing();
                } else {
                    monster.horizontal_speed = 0.0;
                }
                monster.state.action_started_tick = self.tick;
            }

            if monster.state.action == "stand" {
                if !can_move {
                    continue;
                }
                let elapsed_ms = self
                    .tick
                    .saturating_sub(monster.state.action_started_tick)
                    .saturating_mul(TICK_MS);
                if elapsed_ms < monster.template.ai_decision_ms("stand") {
                    continue;
                }
                // Mob::next_move(): STAND -> MOVE and randomize direction.
                monster.state.action = "move";
                monster.state.facing = random_monster_facing();
                monster.state.action_started_tick = self.tick;
            }

            if monster.state.action == "move" {
                if !can_move {
                    monster.state.action = "stand";
                    monster.state.action_started_tick = self.tick;
                    monster.horizontal_speed = 0.0;
                    continue;
                }
                let elapsed_ms = self
                    .tick
                    .saturating_sub(monster.state.action_started_tick)
                    .saturating_mul(TICK_MS);
                if elapsed_ms >= monster.template.ai_decision_ms("move") {
                    // Mob::next_move(): MOVE -> random 0(STAND), 1(MOVE
                    // left), or 2(MOVE right).  Snail has no JUMP action in
                    // its WZ metadata, so the 25% canjump branch is absent.
                    match rand::thread_rng().gen_range(0..3) {
                        0 => {
                            monster.state.action = "stand";
                            monster.horizontal_speed = 0.0;
                        }
                        1 => {
                            monster.state.action = "move";
                            monster.state.facing = -1;
                        }
                        _ => {
                            monster.state.action = "move";
                            monster.state.facing = 1;
                        }
                    }
                    monster.state.action_started_tick = self.tick;
                    if monster.state.action == "stand" {
                        continue;
                    }
                }
            }

            if let Some(force) = monster.template.movement_force() {
                step_monster_with_force(&map, monster, force);
                continue;
            }
            let Some(step) = monster.template.movement_step() else {
                continue;
            };
            if step <= 0.0 {
                continue;
            }
            // Mapleweb receives a server-selected movement stance/direction;
            // this world has no sourced aggro routine, so never invent target
            // chasing. An explicit legacy speed simply continues the
            // authoritative facing until the linked foothold wall turns it
            // around.
            let direction = if monster.state.facing < 0 { -1 } else { 1 };
            let current_x = monster.state.x;
            let next_x = current_x + direction as f64 * step;
            let wall = map.wall_for(monster.foothold_id, direction < 0, monster.state.y);
            let blocked = if direction < 0 {
                current_x >= wall && next_x <= wall
            } else {
                current_x <= wall && next_x >= wall
            };
            if blocked {
                monster.state.facing = -direction;
                continue;
            }
            let next_x = next_x.clamp(map.bounds.x_min, map.bounds.x_max);
            let Some(current) = map.get(monster.foothold_id) else {
                monster.state.x = next_x;
                monster.state.facing = direction;
                monster.state.action = "move";
                continue;
            };
            if current.contains_x(next_x) {
                monster.state.x = next_x;
                monster.state.y = current.at(next_x).unwrap_or(monster.state.y);
                monster.state.facing = direction;
                monster.state.action = "move";
            } else {
                monster.state.facing = -direction;
            }
        }
    }

    fn apply_contact_damage(&mut self) {
        let ids: Vec<String> = self.players.keys().cloned().collect();
        let invulnerability_ticks = self
            .gameplay
            .player
            .contact_invulnerability_ms
            .unwrap_or(0)
            .div_ceil(TICK_MS);
        for id in ids {
            let Some(player) = self.players.get(&id) else {
                continue;
            };
            if player.state.action == "dead" || self.tick < player.contact_invulnerable_until {
                continue;
            }
            let map_id = player.map_id.clone();
            let hit = self
                .monsters
                .values()
                .filter(|monster| {
                    if monster.map_id != map_id
                        || monster.state.hp <= 0
                        || !monster.template.body_attack
                        || monster.template.pa_damage.is_none()
                        || self.gameplay.player.weapon_defense.is_none()
                        || !self
                            .gameplay
                            .player
                            .standard_pdd
                            .iter()
                            .any(|entry| entry.level <= player.state.level)
                    {
                        return false;
                    }
                    let Some((mob_left, mob_right, mob_top, mob_bottom)) = monster
                        .template
                        .body_bounds(monster.state.x, monster.state.y)
                    else {
                        return false;
                    };
                    // Mapleweb's collision probe uses the player's current
                    // movement span and a -50..0 body rectangle.
                    player.state.x >= mob_left
                        && player.state.x <= mob_right
                        && player.state.y - 50.0 <= mob_bottom
                        && player.state.y >= mob_top
                })
                .min_by(|a, b| {
                    (a.state.x - player.state.x)
                        .abs()
                        .total_cmp(&(b.state.x - player.state.x).abs())
                })
                .and_then(|monster| {
                    self.gameplay
                        .player
                        .contact_damage(player.state.level, &monster.template)
                });
            let Some(damage) = hit else { continue };
            let Some(player) = self.players.get_mut(&id) else {
                continue;
            };
            player.state.hp = (player.state.hp - damage.max(1)).max(0);
            player.contact_invulnerable_until = self.tick + invulnerability_ticks;
            if player.state.hp == 0 {
                player.state.action = "dead";
                player.state.action_started_tick = self.tick;
                player.state.action_id = None;
                player.state.climbing = false;
                player.state.ladder_id = None;
                player.attack_until = 0;
                player.death_id = auth::random_id();
            }
            let _ = self.persist_player(&id);
        }
    }

    fn respawn_monsters(&mut self) {
        // MapManager only updates maps that currently have players.  Keep a
        // finished death pending while the map is empty; the next occupied
        // cycle can then recreate it with a fresh object id.
        if self.players.is_empty() {
            return;
        }
        // Cosmic invokes MapManager.updateMaps from one fixed 10-second
        // RespawnTask.  A player entering between two task runs must wait
        // for the next global cycle rather than causing an immediate refill.
        if let Some(interval_ms) = self.gameplay.monster_respawn_ms {
            let interval_ticks = interval_ms.div_ceil(TICK_MS).max(1);
            if !self.tick.is_multiple_of(interval_ticks) {
                return;
            }
        }
        let remove: Vec<String> = self
            .monsters
            .iter()
            .filter_map(|(id, monster)| {
                monster
                    .death_until
                    .is_some_and(|death_until| {
                        // The map-wide Cosmic respawn task only asks a map to
                        // refill eligible spawn points.  A dead mob still
                        // has to finish its die animation before it can be
                        // replaced; the two gates are independent.
                        self.tick >= death_until
                            && monster
                                .respawn_at
                                .is_none_or(|respawn_at| self.tick >= respawn_at)
                    })
                    .then_some(id.clone())
            })
            .collect();
        for id in remove {
            let Some(monster) = self.monsters.remove(&id) else {
                continue;
            };
            if monster.respawn_at.is_some() {
                self.spawn_monster_on_map(monster.map_id, monster.spawn);
            }
        }
    }
}

fn profile_from_state(state: &PlayerState, death_id: &str) -> Profile {
    Profile {
        hp: state.hp,
        max_hp: state.max_hp,
        mp: state.mp,
        max_mp: state.max_mp,
        level: state.level,
        exp: state.exp,
        exp_to_next: state.exp_to_next,
        mesos: state.mesos,
        death_id: death_id.to_owned(),
        inventory: state.inventory.clone(),
    }
}

fn apply_profile(state: &mut PlayerState, profile: Profile) {
    state.hp = profile.hp;
    state.max_hp = profile.max_hp;
    state.mp = profile.mp;
    state.max_mp = profile.max_mp;
    state.level = profile.level;
    state.exp = profile.exp;
    state.exp_to_next = profile.exp_to_next;
    state.mesos = profile.mesos;
    state.inventory = profile.inventory;
    inventory::sort_items(&mut state.inventory);
}

fn step_monster_with_force(map: &Map, monster: &mut Monster, force: f64) {
    // Mapleweb Physics.cpp on a flat foothold: hacc = force -
    // (FRICTION + SLOPEFACTOR) * hspeed / GROUNDSLIP. Keep its 8 ms
    // integration step and use a short fractional step for the final 2 ms
    // of this server's 50 ms tick.
    const FRICTION: f64 = 0.3;
    const SLOPE_FACTOR: f64 = 0.1;
    const GROUND_SLIP: f64 = 3.0;
    let mut remaining = TICK_MS as f64;
    while remaining > 0.0 {
        let slice = remaining.min(REFERENCE_TICK_MS);
        let ratio = slice / REFERENCE_TICK_MS;
        let direction = if monster.state.facing < 0 { -1.0 } else { 1.0 };
        let acceleration =
            force * direction - (FRICTION + SLOPE_FACTOR) * monster.horizontal_speed / GROUND_SLIP;
        monster.horizontal_speed += acceleration * ratio;
        let mut distance = monster.horizontal_speed * ratio;
        if distance.abs() <= f64::EPSILON {
            remaining -= slice;
            continue;
        }

        // A source physics step can cross more than one very short segment.
        // Keep consuming the same distance through linked continuous
        // footholds instead of treating every `contains_x` boundary as a
        // wall.  The guard is only defensive for malformed cyclic map data.
        let mut transitions = 0;
        while distance.abs() > f64::EPSILON {
            transitions += 1;
            if transitions > map.footholds.len().max(1) {
                monster.horizontal_speed = 0.0;
                remaining = 0.0;
                break;
            }
            let travel_direction = if distance < 0.0 { -1 } else { 1 };
            let Some(current) = map.get(monster.foothold_id) else {
                monster.state.x =
                    (monster.state.x + distance).clamp(map.bounds.x_min, map.bounds.x_max);
                monster.state.action = "move";
                distance = 0.0;
                continue;
            };
            if current.is_wall() {
                monster.horizontal_speed = 0.0;
                monster.state.facing = -travel_direction;
                remaining = 0.0;
                break;
            }

            let edge = if travel_direction > 0 {
                current.right()
            } else {
                current.left()
            };
            let wall = map.wall_for(monster.foothold_id, travel_direction < 0, monster.state.y);
            let current_left = current.left();
            let current_right = current.right();
            let stop = if wall >= current_left - 0.001 && wall <= current_right + 0.001 {
                wall
            } else {
                edge
            };
            let to_stop = stop - monster.state.x;
            let reaches_stop = if travel_direction > 0 {
                distance >= to_stop - 0.001
            } else {
                distance <= to_stop + 0.001
            };
            if !reaches_stop {
                let next_x = monster.state.x + distance;
                monster.state.x = next_x;
                monster.state.y = current.at(next_x).unwrap_or(monster.state.y);
                monster.state.action = "move";
                distance = 0.0;
                continue;
            }

            // Consume the part of this reference step up to the edge/wall.
            monster.state.x = stop;
            monster.state.y = current.at(stop).unwrap_or(monster.state.y);
            distance -= to_stop;
            if (stop - edge).abs() > 0.001 {
                // A vertical chain neighbour reached the body span: this is
                // an actual wall, so turn at it and discard the remainder.
                monster.horizontal_speed = 0.0;
                monster.state.facing = -travel_direction;
                remaining = 0.0;
                break;
            }

            let next_id = map
                .contiguous_neighbor(monster.foothold_id, travel_direction)
                .map(|next| next.id);
            let Some(next_id) = next_id else {
                // No continuous prev/next segment means a real chain end.
                monster.horizontal_speed = 0.0;
                monster.state.facing = -travel_direction;
                remaining = 0.0;
                break;
            };
            monster.foothold_id = next_id;
            // The shared endpoint is valid on both segments.  The next loop
            // applies the remaining distance and updates the slope y.
        }
        remaining -= slice;
    }
}

fn step_player(map: &Map, gameplay: &Gameplay, player: &mut Player, tick: u64) {
    if player.last_input.elapsed() > Duration::from_millis(500) {
        player.direction = 0;
        player.vertical = 0;
        player.jump = false;
    }
    if player.state.action == "dead" {
        return;
    }

    // Keep the source current-foothold handle before climbing, jumping, or
    // stepping over an authored edge clears the active foothold id.
    if player.state.grounded {
        if let Some(current) = map.get(player.foothold_id) {
            if !current.is_wall() {
                player.last_foothold_id = current.id;
            }
        }
    }
    if player.fall_boundary_hold {
        if player.vertical != 0 || player.jump {
            player.fall_boundary_hold = false;
        } else {
            // A held horizontal key is suppressed until the command path
            // observes a neutral release packet.
            player.direction = 0;
        }
    }

    if player.state.climbing {
        if player.jump && player.direction != 0 {
            player.jump = false;
            player.state.climbing = false;
            player.state.ladder_id = None;
            player.state.vx = player.direction as f64 * WALK_SPEED * 8.0;
            player.state.vy = -JUMP_SPEED / 1.5;
            player.state.grounded = false;
            player.drop_fh = 0;
            player.state.action = "jump";
            player.state.action_started_tick = tick;
            return;
        } else {
            player.state.vx = 0.0;
            player.state.vy =
                player.vertical as f64 * gameplay.player.climb_speed.unwrap_or(0.0).max(0.0);
            player.state.y += player.state.vy * (TICK_MS as f64 / 1000.0);
            let ladder = player
                .state
                .ladder_id
                .and_then(|id| map.ladders.iter().find(|ladder| ladder.id == id));
            if let Some(ladder) = ladder {
                if player.state.y <= ladder.top() {
                    if ladder.allows_top_exit() && player.vertical <= 0 {
                        if let Some((foothold_id, ground)) = map.ladder_top_ground(ladder) {
                            land_at_ladder_top(player, ladder, foothold_id, ground, tick);
                        } else if player.vertical < 0 {
                            // There is no authored foothold at this end. Keep
                            // the source endpoint behaviour and let normal
                            // falling resolve the map rather than inventing a
                            // platform or an offset.
                            player.state.y = ladder.top();
                            detach_at_ladder_end(player, ladder, true, tick);
                        } else {
                            player.state.y = ladder.top();
                            player.state.vy = 0.0;
                            player.state.action = ladder.action();
                        }
                    } else {
                        // A forbidden top (uf=0), or a downwards input at the
                        // top of an allowed ladder, remains fixed on the
                        // ladder.  In particular, Down+horizontal input must
                        // not pass through this boundary.
                        player.state.y = ladder.top();
                        player.state.vy = 0.0;
                        player.state.action = ladder.action();
                    }
                } else if player.state.y >= ladder.bottom() {
                    player.state.y = ladder.bottom();
                    if player.vertical > 0 {
                        detach_at_ladder_end(player, ladder, false, tick);
                    } else {
                        player.state.vy = 0.0;
                        player.state.action = ladder.action();
                    }
                } else {
                    player.state.action = ladder.action();
                }
            } else {
                player.state.climbing = false;
                player.state.ladder_id = None;
            }
            player.jump = false;
            return;
        }
    }

    if !player.state.climbing && player.vertical != 0 {
        if let Some(ladder) = map.ladder_for(player.state.x, player.state.y, player.vertical < 0) {
            player.state.x = ladder.x;
            player.state.y = player.state.y.clamp(ladder.top(), ladder.bottom());
            player.state.vx = 0.0;
            player.state.vy = 0.0;
            player.state.grounded = false;
            player.state.climbing = true;
            player.state.ladder_id = Some(ladder.id);
            player.state.action = ladder.action();
            player.state.action_started_tick = tick;
            player.jump = false;
            return;
        }
    }

    let old_x = player.state.x;
    let old_y = player.state.y;
    let mut ignored_fh = player.drop_fh;
    if player.state.grounded {
        let down_jump_intent = player.vertical > 0 && player.jump;
        let down_jump = down_jump_intent
            && map
                .downjump_target(player.foothold_id, player.state.x)
                .is_some();
        if down_jump {
            // Match the v83 down-jump sequence: leave the current foothold by
            // one pixel, then use the short upward hop while ignoring that
            // foothold until the body has passed it.
            if let Some(current) = map.get(player.foothold_id) {
                player.state.y = current.at(player.state.x).unwrap_or(player.state.y) - 1.0;
            }
            player.drop_fh = player.foothold_id;
            ignored_fh = player.drop_fh;
            player.state.vy = -DOWNJUMP_LAUNCH;
            player.state.grounded = false;
            player.foothold_id = 0;
        } else if !down_jump_intent && player.jump {
            player.state.vy = -JUMP_SPEED;
            player.state.grounded = false;
            player.foothold_id = 0;
            player.drop_fh = 0;
        }
    }
    player.jump = false;
    player.state.vx = player.direction as f64 * WALK_SPEED;
    if player.direction != 0 {
        player.state.facing = player.direction;
    }
    if player.state.grounded && player.state.vx != 0.0 {
        let wall = map.wall_for(player.foothold_id, player.state.vx < 0.0, player.state.y);
        let intended = player.state.x + player.state.vx * (TICK_MS as f64 / 1000.0);
        let crossed = if player.state.vx < 0.0 {
            player.state.x >= wall && intended <= wall
        } else {
            player.state.x <= wall && intended >= wall
        };
        player.state.x = if crossed { wall } else { intended };
        if crossed {
            player.state.vx = 0.0;
        }
    } else {
        player.state.x += player.state.vx * (TICK_MS as f64 / 1000.0);
    }
    player.state.x = player.state.x.clamp(map.bounds.x_min, map.bounds.x_max);

    if player.state.grounded {
        let current = map.get(player.foothold_id);
        let next_id = current.and_then(|f| {
            if player.state.x > f.right() + 0.001 {
                Some(f.next)
            } else if player.state.x < f.left() - 0.001 {
                Some(f.prev)
            } else {
                Some(f.id)
            }
        });
        if let Some(next_id) = next_id.filter(|id| *id != 0) {
            if let Some(next) = map.get(next_id) {
                if let Some(ground) = next.at(player.state.x) {
                    let travel_direction = if player.state.x >= old_x { 1 } else { -1 };
                    let continuous = map
                        .contiguous_neighbor(player.foothold_id, travel_direction)
                        .is_some_and(|neighbor| neighbor.id == next.id);
                    if next.id != player.foothold_id && ground > old_y + 1.0 && !continuous {
                        player.state.grounded = false;
                    } else {
                        player.foothold_id = next.id;
                        player.state.y = ground;
                        player.state.vy = 0.0;
                    }
                } else {
                    player.state.grounded = false;
                }
            } else {
                player.state.grounded = false;
            }
        } else {
            player.state.grounded = false;
        }
        if !player.state.grounded {
            // The player has deliberately left the current foothold at an
            // authored edge. Do not let the falling sweep re-land at its
            // t=0 endpoint; the source physics likewise advances to a new
            // below foothold after leaving the current one.
            ignored_fh = player.foothold_id;
            player.foothold_id = 0;
        }
    }
    if !player.state.grounded {
        player.state.vy = (player.state.vy + GRAVITY * (TICK_MS as f64 / 1000.0)).min(FALL_SPEED);
        let next_y = player.state.y + player.state.vy * (TICK_MS as f64 / 1000.0);
        if player.state.vy >= 0.0 {
            if let Some((foothold_id, landing_x, ground)) =
                map.landing_on_sweep(old_x, player.state.x, player.state.y, next_y, ignored_fh)
            {
                player.state.x = landing_x;
                player.state.y = ground;
                player.state.vy = 0.0;
                player.state.grounded = true;
                player.foothold_id = foothold_id;
                player.last_foothold_id = foothold_id;
                player.drop_fh = 0;
            } else {
                player.state.y = next_y;
            }
        } else {
            player.state.y = next_y;
        }
        if player.state.y > map.fall_boundary() {
            recover_at_fall_boundary(map, player, tick);
        }
        if player.state.y < map.bounds.y_min {
            player.state.y = map.bounds.y_min;
            player.state.vy = player.state.vy.max(0.0);
        }
    }
    if tick >= player.attack_until {
        player.state.action_id = None;
        let action = if player.state.climbing {
            player
                .state
                .ladder_id
                .and_then(|id| map.ladders.iter().find(|ladder| ladder.id == id))
                .map_or("climb", Ladder::action)
        } else if !player.state.grounded {
            "jump"
        } else if player.state.vx != 0.0 {
            "walk"
        } else {
            "stand"
        };
        if player.state.action != action {
            player.state.action_started_tick = tick;
        }
        player.state.action = action;
    }
}

fn land_at_ladder_top(
    player: &mut Player,
    ladder: &Ladder,
    foothold_id: u64,
    ground: f64,
    tick: u64,
) {
    player.state.x = ladder.x;
    player.state.y = ground;
    player.state.vx = 0.0;
    player.state.vy = 0.0;
    player.state.grounded = true;
    player.foothold_id = foothold_id;
    player.last_foothold_id = foothold_id;
    player.fall_boundary_hold = false;
    player.drop_fh = 0;
    player.state.climbing = false;
    player.state.ladder_id = None;
    player.state.action = "stand";
    player.state.action_started_tick = tick;
}

fn recover_at_fall_boundary(map: &Map, player: &mut Player, tick: u64) {
    // HeavenClient's Footholdtree::update_fh first restores a retained,
    // non-wall current foothold at the lower border, clamping x to that
    // authored segment.  The active server fhid is intentionally cleared
    // during a jump/down-jump, so use the internal last id for that source
    // current-fh semantics.  A stale or wall id falls back to the authored
    // spawn support.
    if let Some(foothold) = map
        .get(player.last_foothold_id)
        .filter(|foothold| !foothold.is_wall())
    {
        let x = player.state.x.clamp(foothold.left(), foothold.right());
        if let Some(ground) = foothold.at(x) {
            player.state.x = x;
            player.state.y = ground;
            player.state.vx = 0.0;
            player.state.vy = 0.0;
            player.state.grounded = true;
            player.foothold_id = foothold.id;
            player.last_foothold_id = foothold.id;
            player.state.climbing = false;
            player.state.ladder_id = None;
            player.fall_boundary_hold = true;
            player.drop_fh = 0;
            player.direction = 0;
            player.vertical = 0;
            player.jump = false;
            player.state.action = "stand";
            player.state.action_started_tick = tick;
            return;
        }
    }
    reset_player_to_spawn(map, player, tick);
}

fn reset_player_to_spawn(map: &Map, player: &mut Player, tick: u64) {
    let spawn_ground = map.ground_near(map.spawn.x, map.spawn.y);
    player.state.x = map.spawn.x;
    player.state.y = spawn_ground.map_or(map.spawn.y, |(_, ground)| ground);
    player.state.vx = 0.0;
    player.state.vy = 0.0;
    player.state.grounded = spawn_ground.is_some();
    player.foothold_id = spawn_ground.map_or(0, |(foothold_id, _)| foothold_id);
    player.last_foothold_id = player.foothold_id;
    player.fall_boundary_hold = true;
    player.state.climbing = false;
    player.state.ladder_id = None;
    player.drop_fh = 0;
    player.direction = 0;
    player.vertical = 0;
    player.jump = false;
    player.state.action = if player.state.grounded {
        "stand"
    } else {
        "jump"
    };
    player.state.action_started_tick = tick;
}

fn detach_at_ladder_end(player: &mut Player, ladder: &Ladder, top: bool, tick: u64) {
    let y = if top { ladder.top() } else { ladder.bottom() };
    // Mapleweb's PlayerClimbState cancels the fixed ladder state at the
    // endpoint; normal foothold resolution on the next frame decides whether
    // the feet land. It does not teleport to the nearest unrelated platform.
    player.state.x = ladder.x;
    player.state.y = y;
    player.state.grounded = false;
    player.foothold_id = 0;
    player.state.climbing = false;
    player.state.ladder_id = None;
    player.state.vy = 0.0;
    player.state.action = "jump";
    player.state.action_started_tick = tick;
}

fn pickup_error_message(code: &str) -> &'static str {
    match code {
        "drop_owned" => "Drop belongs to another player",
        "drop_invalid" => "Drop data is invalid",
        "inventory_full" => "Inventory is full",
        "quantity_overflow" => "Item quantity is too large",
        "invalid_slot" => "Inventory slot is invalid",
        "drop_unavailable" => "Drop is unavailable",
        _ => "Pickup was rejected",
    }
}

pub async fn run(mut world: World, mut rx: mpsc::Receiver<Command>) {
    let mut interval = tokio::time::interval(Duration::from_millis(TICK_MS));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        let count = rx.len();
        for _ in 0..count {
            if let Ok(command) = rx.try_recv() {
                world.command(command);
            }
        }
        world.step();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map() -> Map {
        serde_json::from_str(
            r#"{"id":"test","bounds":{"xMin":0,"xMax":500,"yMin":-500,"yMax":500},"spawn":{"x":10,"y":0},"footholds":[{"id":1,"x1":0,"y1":100,"x2":200,"y2":100,"prev":0,"next":2},{"id":2,"x1":200,"y1":100,"x2":500,"y2":200,"prev":1,"next":0}],"ladders":[]}"#,
        )
        .unwrap()
    }

    #[test]
    fn authority_movement_dedup_and_disconnect() {
        let mut w = World::new(map(), 600);
        let (output, mut rx) = mpsc::channel(128);
        let (reply, _) = oneshot::channel();
        w.command(Command::Join {
            identity: Identity {
                id: "a".into(),
                username: "alice".into(),
            },
            connection: "c".into(),
            output,
            reply,
        });
        for _ in 0..20 {
            w.step();
        }
        assert!(w.players["a"].state.grounded);
        assert_eq!(w.players["a"].state.y, 100.);
        w.command(Command::Input {
            id: "a".into(),
            connection: "forged".into(),
            message: ClientMessage::Input {
                seq: 1,
                direction: 1,
                vertical: 0,
                jump: false,
            },
        });
        assert_eq!(w.players["a"].direction, 0);
        w.command(Command::Input {
            id: "a".into(),
            connection: "c".into(),
            message: ClientMessage::Input {
                seq: 1,
                direction: 1,
                vertical: 0,
                jump: true,
            },
        });
        w.step();
        assert!(w.players["a"].state.y < 100.);
        for _ in 0..35 {
            w.step();
        }
        assert!(w.players["a"].state.grounded);
        assert!(w.players["a"].state.y > 100.);
        for _ in 0..2 {
            w.command(Command::Input {
                id: "a".into(),
                connection: "c".into(),
                message: ClientMessage::Attack {
                    request_id: "once".into(),
                },
            });
        }
        assert_eq!(w.combat.next_action, 1);
        while rx.try_recv().is_ok() {}
        w.command(Command::Leave {
            id: "a".into(),
            connection: "c".into(),
        });
        assert!(w.players.is_empty());
        assert!(serde_json::from_str::<ClientMessage>(
            r#"{"type":"input","seq":1,"direction":1,"vertical":0,"jump":false,"playerId":"other"}"#,
        )
        .is_err());
        assert!(serde_json::from_str::<ClientMessage>(
            r#"{"type":"attack","requestId":"a","damage":999}"#,
        )
        .is_err());
    }

    #[test]
    fn inventory_commands_swap_drop_and_replay_without_duplication() {
        let mut world = World::new(map(), 600);
        let (output, mut rx) = mpsc::channel(128);
        let (reply, _) = oneshot::channel();
        world.command(Command::Join {
            identity: Identity {
                id: "a".into(),
                username: "alice".into(),
            },
            connection: "c".into(),
            output,
            reply,
        });
        let _ = rx.try_recv();
        world.players.get_mut("a").unwrap().state.inventory = vec![
            crate::protocol::InventoryItem {
                slot: 1,
                item_id: "4000019".into(),
                quantity: 3,
            },
            crate::protocol::InventoryItem {
                slot: 2,
                item_id: "2000000".into(),
                quantity: 1,
            },
        ];
        world.command(Command::Input {
            id: "a".into(),
            connection: "c".into(),
            message: ClientMessage::InventoryMove {
                request_id: "move-once".into(),
                source_slot: 1,
                target_slot: 2,
                quantity: 3,
            },
        });
        assert_eq!(world.players["a"].state.inventory[0].slot, 1);
        assert_eq!(world.players["a"].state.inventory[0].item_id, "2000000");
        assert_eq!(world.players["a"].state.inventory[1].slot, 2);
        assert_eq!(world.players["a"].state.inventory[1].item_id, "4000019");
        world.command(Command::Input {
            id: "a".into(),
            connection: "c".into(),
            message: ClientMessage::InventoryMove {
                request_id: "move-once".into(),
                source_slot: 1,
                target_slot: 2,
                quantity: 3,
            },
        });
        assert_eq!(world.players["a"].state.inventory[1].quantity, 3);

        world.command(Command::Input {
            id: "a".into(),
            connection: "c".into(),
            message: ClientMessage::DropItem {
                request_id: "drop-once".into(),
                source_slot: 2,
                quantity: 1,
            },
        });
        assert_eq!(world.drops.len(), 1);
        assert_eq!(world.players["a"].state.inventory[1].quantity, 2);
        world.command(Command::Input {
            id: "a".into(),
            connection: "c".into(),
            message: ClientMessage::DropItem {
                request_id: "drop-once".into(),
                source_slot: 2,
                quantity: 1,
            },
        });
        assert_eq!(world.drops.len(), 1);
        assert_eq!(world.players["a"].state.inventory[1].quantity, 2);
        let responses: Vec<_> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
        assert!(responses
            .iter()
            .any(|message| message.contains("inventoryResult")));
        assert!(responses
            .iter()
            .any(|message| message.contains("inventoryDropResult")));
        let move_response = responses
            .iter()
            .find(|message| message.contains("\"type\":\"inventoryResult\""))
            .expect("move response");
        assert!(move_response.contains("\"sourceSlot\":1"));
        assert!(move_response.contains("\"targetSlot\":2"));
        let drop_response = responses
            .iter()
            .find(|message| message.contains("\"type\":\"inventoryDropResult\""))
            .expect("drop response");
        assert!(drop_response.contains("\"sourceSlot\":2"));
    }

    #[test]
    fn portal_command_changes_map_and_snapshot_scope() {
        let mut birth = map();
        birth.portals.push(Portal {
            name: "out00".into(),
            portal_type: 2,
            x: 10.0,
            y: 0.0,
            target_map_id: Some("target".into()),
            target_portal_name: Some("in00".into()),
        });
        let target: Map = serde_json::from_str(
            r#"{"id":"target","bounds":{"xMin":0,"xMax":500,"yMin":-500,"yMax":500},"spawn":{"x":40,"y":100},"footholds":[{"id":1,"x1":0,"y1":100,"x2":500,"y2":100}],"ladders":[],"portals":[{"name":"in00","type":2,"x":40,"y":100}]}"#,
        )
        .unwrap();
        let mut world = World::new(birth.clone(), 600);
        world
            .attach_catalog(MapCatalog {
                birth_map_id: "test".into(),
                maps: vec![birth, target],
            })
            .unwrap();
        let (output, mut rx) = mpsc::channel(128);
        let (reply, _) = oneshot::channel();
        world.command(Command::Join {
            identity: Identity {
                id: "a".into(),
                username: "alice".into(),
            },
            connection: "c".into(),
            output,
            reply,
        });
        let _ = rx.try_recv();
        world.command(Command::Input {
            id: "a".into(),
            connection: "c".into(),
            message: ClientMessage::Portal {
                request_id: "portal-once".into(),
                portal_name: "out00".into(),
            },
        });
        assert_eq!(world.players["a"].map_id, "target");
        let result = rx.try_recv().expect("portal result");
        assert!(result.contains("\"type\":\"portalResult\""));
        world.step();
        let snapshot = rx.try_recv().expect("target snapshot");
        assert!(snapshot.contains("\"mapId\":\"target\""));
    }

    #[test]
    fn generated_map_catalog_loads_all_rendered_maps() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/maps.json");
        let catalog = MapCatalog::load(&path).expect("generated map catalog");
        assert_eq!(catalog.birth_map_id, "000010000");
        assert_eq!(catalog.maps.len(), 19);
        assert!(catalog.maps.iter().all(|map| !map.footholds.is_empty()));
        assert!(catalog
            .maps
            .iter()
            .flat_map(|map| map.portals.iter())
            .any(|portal| portal.target_map_id.as_deref() == Some("000020000")));
    }

    #[test]
    fn full_snapshot_queue_keeps_player_connected() {
        let mut world = World::new(map(), 600);
        let (output, mut rx) = mpsc::channel(1);
        let (reply, _) = oneshot::channel();
        world.command(Command::Join {
            identity: Identity {
                id: "a".into(),
                username: "alice".into(),
            },
            connection: "c".into(),
            output,
            reply,
        });
        assert!(rx.try_recv().is_ok());
        world.step();
        assert!(world.players.contains_key("a"));
    }

    #[test]
    fn wall_only_blocks_when_chain_vertical_foothold_reaches_body() {
        let map: Map = serde_json::from_str(
            r#"{"id":"walls","bounds":{"xMin":0,"xMax":300,"yMin":-100,"yMax":500},"spawn":{"x":100,"y":100},"footholds":[{"id":1,"x1":0,"y1":100,"x2":100,"y2":100,"prev":0,"next":2},{"id":2,"x1":100,"y1":100,"x2":100,"y2":180,"prev":1,"next":3},{"id":3,"x1":100,"y1":180,"x2":200,"y2":180,"prev":2,"next":0}],"ladders":[]}"#,
        )
        .unwrap();
        assert_eq!(map.wall_for(3, true, 180.0), 100.0);
        assert_eq!(map.wall_for(3, true, 100.0), 25.0);
        assert_eq!(map.wall_for(1, false, 180.0), 100.0);
        assert_eq!(map.wall_for(1, false, 100.0), 175.0);

        let two_hop: Map = serde_json::from_str(
            r#"{"id":"two-hop-walls","bounds":{"xMin":0,"xMax":400,"yMin":-100,"yMax":500},"spawn":{"x":50,"y":100},"footholds":[{"id":1,"x1":0,"y1":100,"x2":100,"y2":100,"prev":0,"next":2},{"id":2,"x1":100,"y1":100,"x2":200,"y2":100,"prev":1,"next":3},{"id":3,"x1":200,"y1":100,"x2":200,"y2":180,"prev":2,"next":4},{"id":4,"x1":200,"y1":180,"x2":300,"y2":180,"prev":3,"next":0}],"ladders":[]}"#,
        )
        .unwrap();
        assert_eq!(two_hop.wall_for(1, false, 180.0), 200.0);
    }

    #[test]
    fn ladder_follows_original_probe_and_detaches_at_end() {
        let map: Map = serde_json::from_str(
            r#"{"id":"ladder","bounds":{"xMin":0,"xMax":300,"yMin":-100,"yMax":500},"spawn":{"x":100,"y":200},"footholds":[{"id":1,"x1":0,"y1":200,"x2":300,"y2":200}],"ladders":[{"id":1,"x":100,"y1":50,"y2":200,"l":1,"uf":1}]}"#,
        )
        .unwrap();
        let mut w = World::new_with_gameplay(
            map,
            600,
            Gameplay {
                player: PlayerConfig {
                    climb_speed: Some(100.0),
                    ..PlayerConfig::default()
                },
                ..Gameplay::default()
            },
        );
        let (output, _rx) = mpsc::channel(128);
        let (reply, _) = oneshot::channel();
        w.command(Command::Join {
            identity: Identity {
                id: "a".into(),
                username: "alice".into(),
            },
            connection: "c".into(),
            output,
            reply,
        });
        w.command(Command::Input {
            id: "a".into(),
            connection: "c".into(),
            message: ClientMessage::Input {
                seq: 1,
                direction: 0,
                vertical: -1,
                jump: false,
            },
        });
        w.step();
        assert!(w.players["a"].state.climbing);
        assert_eq!(w.players["a"].state.ladder_id, Some(1));
        assert_eq!(w.players["a"].state.action, "ladder");

        let rope_map: Map = serde_json::from_str(
            r#"{"id":"rope","bounds":{"xMin":0,"xMax":300,"yMin":-100,"yMax":500},"spawn":{"x":100,"y":200},"footholds":[{"id":1,"x1":0,"y1":200,"x2":300,"y2":200}],"ladders":[{"id":1,"x":100,"y1":50,"y2":200,"l":0,"uf":0}]}"#,
        )
        .unwrap();
        let mut rope_world = World::new_with_gameplay(
            rope_map,
            600,
            Gameplay {
                player: PlayerConfig {
                    climb_speed: Some(100.0),
                    ..PlayerConfig::default()
                },
                ..Gameplay::default()
            },
        );
        let (output, _rx) = mpsc::channel(128);
        let (reply, _) = oneshot::channel();
        rope_world.command(Command::Join {
            identity: Identity {
                id: "a".into(),
                username: "alice".into(),
            },
            connection: "c".into(),
            output,
            reply,
        });
        rope_world.command(Command::Input {
            id: "a".into(),
            connection: "c".into(),
            message: ClientMessage::Input {
                seq: 1,
                direction: 0,
                vertical: -1,
                jump: false,
            },
        });
        for _ in 0..40 {
            rope_world.step();
        }
        assert!(rope_world.players["a"].state.climbing);
        assert_eq!(rope_world.players["a"].state.action, "rope");
        assert_eq!(rope_world.players["a"].state.y, 50.0);
    }

    #[test]
    fn allowed_ladder_top_lands_on_authored_foothold_and_stays_grounded() {
        let map: Map = serde_json::from_str(
            r#"{"id":"ladder-top","bounds":{"xMin":0,"xMax":300,"yMin":-100,"yMax":500},"spawn":{"x":100,"y":200},"footholds":[{"id":1,"x1":0,"y1":200,"x2":200,"y2":200},{"id":2,"x1":0,"y1":95,"x2":200,"y2":95}],"ladders":[{"id":1,"x":100,"y1":100,"y2":200,"l":1,"uf":1}]}"#,
        )
        .unwrap();
        let mut world = World::new_with_gameplay(
            map,
            600,
            Gameplay {
                player: PlayerConfig {
                    climb_speed: Some(125.0),
                    ..PlayerConfig::default()
                },
                ..Gameplay::default()
            },
        );
        let (output, _rx) = mpsc::channel(128);
        let (reply, _) = oneshot::channel();
        world.command(Command::Join {
            identity: Identity {
                id: "a".into(),
                username: "alice".into(),
            },
            connection: "c".into(),
            output,
            reply,
        });
        world.step();
        world.command(Command::Input {
            id: "a".into(),
            connection: "c".into(),
            message: ClientMessage::Input {
                seq: 1,
                direction: 0,
                vertical: -1,
                jump: false,
            },
        });
        world.step();
        assert!(world.players["a"].state.climbing);

        // Keep Up held until the climb crosses the WZ top endpoint.  The
        // authored support is two pixels above that endpoint, as in the live
        // map, so the transition must select foothold 2 and zero vertical
        // velocity in the same authoritative tick.
        for _ in 0..20 {
            world.step();
        }
        let player = &world.players["a"];
        assert!(!player.state.climbing);
        assert!(player.state.grounded);
        assert_eq!(player.state.ladder_id, None);
        assert_eq!(player.foothold_id, 2);
        assert_eq!(player.state.y, 95.0);
        assert_eq!(player.state.vy, 0.0);

        // Releasing Up must leave the grounded state intact; the following
        // horizontal input must walk on the selected foothold instead of
        // re-entering the ladder or falling through its endpoint.
        world.command(Command::Input {
            id: "a".into(),
            connection: "c".into(),
            message: ClientMessage::Input {
                seq: 2,
                direction: 0,
                vertical: 0,
                jump: false,
            },
        });
        world.step();
        assert!(world.players["a"].state.grounded);
        assert_eq!(world.players["a"].state.y, 95.0);
        world.command(Command::Input {
            id: "a".into(),
            connection: "c".into(),
            message: ClientMessage::Input {
                seq: 3,
                direction: 1,
                vertical: 0,
                jump: false,
            },
        });
        world.step();
        assert!(world.players["a"].state.grounded);
        assert_eq!(world.players["a"].foothold_id, 2);
        assert!(world.players["a"].state.x > 100.0);
        assert_eq!(world.players["a"].state.y, 95.0);
    }

    #[test]
    fn forbidden_ladder_top_holds_at_endpoint() {
        let map: Map = serde_json::from_str(
            r#"{"id":"forbidden-ladder-top","bounds":{"xMin":0,"xMax":300,"yMin":-100,"yMax":500},"spawn":{"x":100,"y":200},"footholds":[{"id":1,"x1":0,"y1":200,"x2":200,"y2":200},{"id":2,"x1":0,"y1":95,"x2":200,"y2":95}],"ladders":[{"id":1,"x":100,"y1":100,"y2":200,"l":1,"uf":0}]}"#,
        )
        .unwrap();
        let mut world = World::new_with_gameplay(
            map,
            600,
            Gameplay {
                player: PlayerConfig {
                    climb_speed: Some(125.0),
                    ..PlayerConfig::default()
                },
                ..Gameplay::default()
            },
        );
        let (output, _rx) = mpsc::channel(128);
        let (reply, _) = oneshot::channel();
        world.command(Command::Join {
            identity: Identity {
                id: "a".into(),
                username: "alice".into(),
            },
            connection: "c".into(),
            output,
            reply,
        });
        world.step();
        world.command(Command::Input {
            id: "a".into(),
            connection: "c".into(),
            message: ClientMessage::Input {
                seq: 1,
                direction: 0,
                vertical: -1,
                jump: false,
            },
        });
        world.step();
        for _ in 0..20 {
            world.step();
        }
        assert!(world.players["a"].state.climbing);
        assert!(!world.players["a"].state.grounded);
        assert_eq!(world.players["a"].state.y, 100.0);
        assert_eq!(world.players["a"].state.ladder_id, Some(1));

        // Horizontal input at a forbidden top cannot turn the endpoint into
        // an exit and cannot make the player pass through the platform.
        world.command(Command::Input {
            id: "a".into(),
            connection: "c".into(),
            message: ClientMessage::Input {
                seq: 2,
                direction: 1,
                vertical: 0,
                jump: false,
            },
        });
        world.step();
        assert!(world.players["a"].state.climbing);
        assert!(!world.players["a"].state.grounded);
        assert_eq!(world.players["a"].state.y, 100.0);
        assert_eq!(world.players["a"].state.ladder_id, Some(1));
    }

    #[test]
    fn config_drop_and_exp_are_authoritative_without_client_values() {
        let gameplay: Gameplay = serde_json::from_str(
            r#"{"contentVersion":"gms83-gameplay-2","player":{"baseStr":4,"baseDex":4,"baseInt":4,"baseLuk":4,"weaponType":130,"weaponWatk":10,"attackReach":80,"attackHeight":40,"attackAfterMs":300,"maxHp":30},"monsterTemplates":[{"templateId":"0100130","level":1,"maxHp":8,"PADamage":12,"exp":1,"bodyAttack":true,"moveSpeed":10,"hitboxWidth":39,"hitboxHeight":29,"drop":{"itemId":"2000000","quantity":1,"guaranteed":true}}],"monsterSpawns":[{"id":"s1","templateId":"0100130","x":100,"y":100,"footholdId":1}],"expTable":[15]}"#,
        )
        .unwrap();
        gameplay.validate().unwrap();
        assert_eq!(gameplay.monsters[0].pa_damage, Some(12));
        assert_eq!(gameplay.monsters[0].drops()[0].item_id, "2000000");
    }

    #[test]
    fn downjump_requires_allowed_source_foothold_and_skips_it_until_lower_landing() {
        let map: Map = serde_json::from_str(
            r#"{"id":"downjump","bounds":{"xMin":0,"xMax":300,"yMin":-500,"yMax":500},"spawn":{"x":100,"y":0},"footholds":[{"id":1,"x1":0,"y1":0,"x2":300,"y2":0,"prev":0,"next":0,"forbidFallDown":0},{"id":2,"x1":0,"y1":100,"x2":300,"y2":100,"prev":0,"next":0,"forbidFallDown":1}],"ladders":[]}"#,
        )
        .unwrap();
        let mut w = World::new(map, 600);
        let (output, _rx) = mpsc::channel(128);
        let (reply, _) = oneshot::channel();
        w.command(Command::Join {
            identity: Identity {
                id: "a".into(),
                username: "alice".into(),
            },
            connection: "c".into(),
            output,
            reply,
        });
        w.step();
        assert!(w.players["a"].state.grounded);
        w.command(Command::Input {
            id: "a".into(),
            connection: "c".into(),
            message: ClientMessage::Input {
                seq: 1,
                direction: 0,
                vertical: 1,
                jump: true,
            },
        });
        w.step();
        assert!(!w.players["a"].state.grounded);
        assert!(w.players["a"].state.y < 0.0);
        for _ in 0..40 {
            w.step();
        }
        assert!(w.players["a"].state.grounded);
        assert_eq!(w.players["a"].state.y, 100.0);

        let forbidden: Map = serde_json::from_str(
            r#"{"id":"forbidden","bounds":{"xMin":0,"xMax":300,"yMin":-500,"yMax":500},"spawn":{"x":100,"y":0},"footholds":[{"id":1,"x1":0,"y1":0,"x2":300,"y2":0,"prev":0,"next":0,"forbidFallDown":1},{"id":2,"x1":0,"y1":100,"x2":300,"y2":100,"prev":0,"next":0,"forbidFallDown":0}],"ladders":[]}"#,
        )
        .unwrap();
        let mut w = World::new(forbidden, 600);
        let (output, _rx) = mpsc::channel(128);
        let (reply, _) = oneshot::channel();
        w.command(Command::Join {
            identity: Identity {
                id: "a".into(),
                username: "alice".into(),
            },
            connection: "c".into(),
            output,
            reply,
        });
        w.step();
        w.command(Command::Input {
            id: "a".into(),
            connection: "c".into(),
            message: ClientMessage::Input {
                seq: 1,
                direction: 0,
                vertical: 1,
                jump: true,
            },
        });
        w.step();
        assert!(w.players["a"].state.grounded);
        assert_eq!(w.players["a"].state.y, 0.0);
        w.command(Command::Input {
            id: "a".into(),
            connection: "c".into(),
            message: ClientMessage::Input {
                seq: 2,
                direction: 1,
                vertical: 1,
                jump: true,
            },
        });
        w.step();
        assert!(w.players["a"].state.grounded);
        assert_eq!(w.players["a"].state.y, 0.0);
        assert_eq!(w.players["a"].state.vy, 0.0);
    }

    #[test]
    fn jump_returns_to_the_lowest_authored_foothold() {
        let map: Map = serde_json::from_str(
            r#"{"id":"lowest","bounds":{"xMin":0,"xMax":300,"yMin":-200,"yMax":300},"spawn":{"x":100,"y":200},"footholds":[{"id":1,"x1":0,"y1":200,"x2":300,"y2":200}],"ladders":[]}"#,
        )
        .unwrap();
        let mut world = World::new(map, 600);
        let (output, _rx) = mpsc::channel(128);
        let (reply, _) = oneshot::channel();
        world.command(Command::Join {
            identity: Identity {
                id: "a".into(),
                username: "alice".into(),
            },
            connection: "c".into(),
            output,
            reply,
        });
        world.step();
        world.command(Command::Input {
            id: "a".into(),
            connection: "c".into(),
            message: ClientMessage::Input {
                seq: 1,
                direction: 0,
                vertical: 0,
                jump: true,
            },
        });
        world.step();
        assert!(!world.players["a"].state.grounded);
        for _ in 0..30 {
            world.step();
        }
        let player = &world.players["a"];
        assert!(player.state.grounded);
        assert_eq!(player.state.y, 200.0);
        assert_eq!(player.foothold_id, 1);
        assert_eq!(player.state.vy, 0.0);
        assert_eq!(player.drop_fh, 0);
    }

    #[test]
    fn falling_sweeps_across_edge_to_narrow_authored_foothold() {
        let map: Map = serde_json::from_str(
            r#"{"id":"sweep","bounds":{"xMin":0,"xMax":300,"yMin":-200,"yMax":300},"spawn":{"x":50,"y":0},"footholds":[{"id":1,"x1":0,"y1":0,"x2":100,"y2":0,"prev":0,"next":0},{"id":2,"x1":122,"y1":47,"x2":124,"y2":47,"prev":0,"next":0},{"id":3,"x1":0,"y1":200,"x2":300,"y2":200,"prev":0,"next":0}],"ladders":[]}"#,
        )
        .unwrap();
        let mut world = World::new(map, 600);
        let (output, _rx) = mpsc::channel(128);
        let (reply, _) = oneshot::channel();
        world.command(Command::Join {
            identity: Identity {
                id: "a".into(),
                username: "alice".into(),
            },
            connection: "c".into(),
            output,
            reply,
        });
        world.step();
        world.command(Command::Input {
            id: "a".into(),
            connection: "c".into(),
            message: ClientMessage::Input {
                seq: 1,
                direction: 1,
                vertical: 0,
                jump: true,
            },
        });
        world.step();
        for _ in 0..20 {
            world.step();
            if world.players["a"].state.grounded {
                break;
            }
        }
        let player = &world.players["a"];
        assert!(player.state.grounded);
        assert_eq!(player.foothold_id, 2);
        assert_eq!(player.state.y, 47.0);
        assert!(player.state.x >= 122.0 && player.state.x <= 124.0);
    }

    #[test]
    fn walking_off_foothold_edge_does_not_reland_at_sweep_start() {
        let map: Map = serde_json::from_str(
            r#"{"id":"edge-fall","bounds":{"xMin":0,"xMax":300,"yMin":-200,"yMax":300},"spawn":{"x":99,"y":0},"footholds":[{"id":1,"x1":0,"y1":0,"x2":100,"y2":0,"prev":0,"next":0},{"id":2,"x1":0,"y1":100,"x2":300,"y2":100,"prev":0,"next":0}],"ladders":[]}"#,
        )
        .unwrap();
        let mut world = World::new(map, 600);
        let (output, _rx) = mpsc::channel(128);
        let (reply, _) = oneshot::channel();
        world.command(Command::Join {
            identity: Identity {
                id: "a".into(),
                username: "alice".into(),
            },
            connection: "c".into(),
            output,
            reply,
        });
        world.step();
        world.command(Command::Input {
            id: "a".into(),
            connection: "c".into(),
            message: ClientMessage::Input {
                seq: 1,
                direction: 1,
                vertical: 0,
                jump: false,
            },
        });
        world.step();
        assert!(!world.players["a"].state.grounded);
        assert_eq!(world.players["a"].foothold_id, 0);
        assert!(world.players["a"].state.x > 100.0);
        for _ in 0..20 {
            world.step();
            if world.players["a"].state.grounded {
                break;
            }
        }
        let player = &world.players["a"];
        assert!(player.state.grounded);
        assert_eq!(player.foothold_id, 2);
        assert_eq!(player.state.y, 100.0);
    }

    #[test]
    fn falling_beyond_map_recovers_on_last_authored_foothold_and_stays_stable() {
        let map: Map = serde_json::from_str(
            r#"{"id":"recovery","bounds":{"xMin":0,"xMax":300,"yMin":-200,"yMax":300},"spawn":{"x":25,"y":0},"footholds":[{"id":1,"x1":0,"y1":0,"x2":50,"y2":0}],"ladders":[]}"#,
        )
        .unwrap();
        let mut world = World::new(map, 600);
        let (output, _rx) = mpsc::channel(128);
        let (reply, _) = oneshot::channel();
        world.command(Command::Join {
            identity: Identity {
                id: "a".into(),
                username: "alice".into(),
            },
            connection: "c".into(),
            output,
            reply,
        });
        world.step();
        world.command(Command::Input {
            id: "a".into(),
            connection: "c".into(),
            message: ClientMessage::Input {
                seq: 1,
                direction: 1,
                vertical: 0,
                jump: true,
            },
        });
        world.step();
        for _ in 0..30 {
            world.step();
            if world.players["a"].state.grounded && world.players["a"].state.x == 50.0 {
                break;
            }
        }
        {
            let player = &world.players["a"];
            assert!(player.state.grounded);
            assert_eq!(player.state.x, 50.0);
            assert_eq!(player.state.y, 0.0);
            assert_eq!(player.state.vx, 0.0);
            assert_eq!(player.state.vy, 0.0);
            assert_eq!(player.foothold_id, 1);
            assert!(!player.state.climbing);
            assert_eq!(player.state.ladder_id, None);
            assert_eq!(player.drop_fh, 0);
            assert_eq!(player.direction, 0);
            assert_eq!(player.vertical, 0);
            assert!(!player.jump);
        }
        world.step();
        let player = &world.players["a"];
        assert!(player.state.grounded);
        assert_eq!(player.state.x, 50.0);
        assert_eq!(player.state.y, 0.0);
        assert_eq!(player.state.vy, 0.0);
        world.command(Command::Input {
            id: "a".into(),
            connection: "c".into(),
            message: ClientMessage::Input {
                seq: 2,
                direction: 1,
                vertical: 0,
                jump: false,
            },
        });
        world.step();
        let player = &world.players["a"];
        assert!(player.state.grounded);
        assert_eq!(player.state.x, 50.0);
        assert_eq!(player.state.y, 0.0);
        assert_eq!(player.state.vx, 0.0);
        assert_eq!(player.state.vy, 0.0);
    }

    #[test]
    fn falling_without_last_authored_foothold_uses_spawn_support() {
        let map: Map = serde_json::from_str(
            r#"{"id":"spawn-recovery","bounds":{"xMin":0,"xMax":300,"yMin":-200,"yMax":300},"spawn":{"x":25,"y":0},"footholds":[{"id":1,"x1":0,"y1":0,"x2":50,"y2":0}],"ladders":[]}"#,
        )
        .unwrap();
        let mut world = World::new(map, 600);
        let (output, _rx) = mpsc::channel(128);
        let (reply, _) = oneshot::channel();
        world.command(Command::Join {
            identity: Identity {
                id: "a".into(),
                username: "alice".into(),
            },
            connection: "c".into(),
            output,
            reply,
        });
        world.step();
        {
            let player = world.players.get_mut("a").unwrap();
            player.foothold_id = 0;
            player.last_foothold_id = 0;
        }
        world.command(Command::Input {
            id: "a".into(),
            connection: "c".into(),
            message: ClientMessage::Input {
                seq: 1,
                direction: 1,
                vertical: 0,
                jump: true,
            },
        });
        world.step();
        for _ in 0..30 {
            world.step();
            if world.players["a"].state.grounded && world.players["a"].state.x == 25.0 {
                break;
            }
        }
        let player = &world.players["a"];
        assert!(player.state.grounded);
        assert_eq!(player.state.x, 25.0);
        assert_eq!(player.state.y, 0.0);
        assert_eq!(player.foothold_id, 1);
        assert_eq!(player.last_foothold_id, 1);
        assert_eq!(player.state.vx, 0.0);
        assert_eq!(player.state.vy, 0.0);
    }

    #[test]
    fn monster_respawn_waits_for_cycle_and_death_animation() {
        let map: Map = serde_json::from_str(
            r#"{"id":"respawn","bounds":{"xMin":0,"xMax":300,"yMin":-100,"yMax":300},"spawn":{"x":100,"y":100},"footholds":[{"id":1,"x1":0,"y1":100,"x2":300,"y2":100}],"ladders":[]}"#,
        )
        .unwrap();
        let mut w = World::new_with_gameplay(
            map,
            600,
            Gameplay {
                monster_respawn_ms: Some(100),
                monsters: vec![MonsterTemplate {
                    template_id: "100100".into(),
                    level: 1,
                    max_hp: 8,
                    pa_damage: Some(12),
                    exp: 3,
                    body_attack: true,
                    move_speed: None,
                    source_speed: None,
                    hitbox_width: None,
                    hitbox_height: None,
                    hitbox_lt: Some(Point { x: -18.0, y: -26.0 }),
                    hitbox_rb: Some(Point { x: 19.0, y: 0.0 }),
                    die_duration_ms: Some(250),
                    stand_delay_ms: None,
                    move_duration_ms: None,
                    drop: None,
                }],
                spawns: vec![MonsterSpawn {
                    id: "s1".into(),
                    template_id: "100100".into(),
                    x: 100.0,
                    y: 100.0,
                    foothold_id: Some(1),
                }],
                ..Gameplay::default()
            },
        );
        let (output, _rx) = mpsc::channel(128);
        let (reply, _) = oneshot::channel();
        w.command(Command::Join {
            identity: Identity {
                id: "a".into(),
                username: "alice".into(),
            },
            connection: "c".into(),
            output,
            reply,
        });
        let old_id = w.monsters.keys().next().cloned().unwrap();
        let monster = w.monsters.get_mut(&old_id).unwrap();
        monster.state.hp = 0;
        monster.state.action = "die";
        monster.death_until = Some(6);
        monster.respawn_at = Some(2);

        for _ in 0..5 {
            w.step();
            assert!(w.monsters.contains_key(&old_id));
        }
        w.step();
        assert!(!w.monsters.contains_key(&old_id));
        assert_eq!(w.monsters.len(), 1);
        assert_ne!(w.monsters.keys().next().unwrap(), &old_id);
    }

    #[test]
    fn revive_replay_is_success_when_alive_but_stale_after_new_death() {
        let mut w = World::new(map(), 600);
        let (output, mut rx) = mpsc::channel(128);
        let (reply, _) = oneshot::channel();
        w.command(Command::Join {
            identity: Identity {
                id: "a".into(),
                username: "alice".into(),
            },
            connection: "c".into(),
            output,
            reply,
        });
        while rx.try_recv().is_ok() {}
        {
            let player = w.players.get_mut("a").unwrap();
            player.state.action = "dead";
            player.state.hp = 0;
            player.death_id = "death-1".into();
        }
        w.handle_revive("a".into(), "revive-1".into());
        let first: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(first["success"], true);

        // The original request is idempotent after its state transition.
        w.handle_revive("a".into(), "revive-1".into());
        let replay: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(replay["success"], true);
        assert_eq!(replay["code"], "");

        // A request from the previous death cannot revive a later one.
        {
            let player = w.players.get_mut("a").unwrap();
            player.state.action = "dead";
            player.state.hp = 0;
            player.death_id = "death-2".into();
        }
        w.handle_revive("a".into(), "revive-1".into());
        let stale: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(stale["success"], false);
        assert_eq!(stale["code"], "revive_stale");
        assert_eq!(w.players["a"].state.action, "dead");
    }

    #[test]
    fn dead_profile_reconnects_dead_and_can_use_revive() {
        let path =
            std::env::temp_dir().join(format!("maple-world-revive-{}.sqlite3", auth::random_id()));
        let auth = auth::start(&path).unwrap();
        let defaults = Profile {
            hp: 50,
            max_hp: 50,
            mp: 5,
            max_mp: 5,
            level: 1,
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            death_id: String::new(),
            inventory: Vec::new(),
        };
        auth.store.load_profile("a", &defaults).unwrap();
        let mut dead = defaults;
        dead.hp = 0;
        dead.death_id = "death-after-restart".into();
        auth.store.save_profile("a", &dead).unwrap();

        let mut w =
            World::new_with_store(map(), 600, Gameplay::default(), auth.store.clone()).unwrap();
        let (output, mut rx) = mpsc::channel(128);
        let (reply, _) = oneshot::channel();
        w.command(Command::Join {
            identity: Identity {
                id: "a".into(),
                username: "alice".into(),
            },
            connection: "c".into(),
            output,
            reply,
        });
        assert_eq!(w.players["a"].state.action, "dead");
        assert_eq!(w.players["a"].death_id, "death-after-restart");
        while rx.try_recv().is_ok() {}
        w.handle_revive("a".into(), "revive-after-restart".into());
        assert_eq!(w.players["a"].state.action, "stand");
        assert_eq!(w.players["a"].state.hp, 50);
        drop(w);
        drop(auth);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    #[test]
    fn monster_hit_state_uses_source_counter_window() {
        let mut w = World::new_with_gameplay(
            map(),
            600,
            Gameplay {
                monsters: vec![MonsterTemplate {
                    template_id: "100100".into(),
                    level: 1,
                    max_hp: 8,
                    pa_damage: Some(12),
                    exp: 3,
                    body_attack: true,
                    move_speed: None,
                    source_speed: Some(-65.0),
                    hitbox_width: None,
                    hitbox_height: None,
                    hitbox_lt: Some(Point { x: -18.0, y: -26.0 }),
                    hitbox_rb: Some(Point { x: 19.0, y: 0.0 }),
                    die_duration_ms: Some(1260),
                    stand_delay_ms: None,
                    move_duration_ms: None,
                    drop: None,
                }],
                spawns: vec![MonsterSpawn {
                    id: "s1".into(),
                    template_id: "100100".into(),
                    x: 100.0,
                    y: 100.0,
                    foothold_id: Some(1),
                }],
                ..Gameplay::default()
            },
        );
        let id = w.monsters.keys().next().cloned().unwrap();
        let monster = w.monsters.get_mut(&id).unwrap();
        monster.state.action = "hit";
        monster.state.action_started_tick = 10;

        w.tick = 14;
        w.step_monsters();
        assert_eq!(w.monsters[&id].state.action, "hit");
        w.tick = 15;
        w.step_monsters();
        assert_eq!(w.monsters[&id].state.action, "move");
    }

    #[test]
    fn snail_ai_uses_source_stand_and_move_windows() {
        let mut w = World::new_with_gameplay(
            map(),
            600,
            Gameplay {
                monsters: vec![MonsterTemplate {
                    template_id: "100100".into(),
                    level: 1,
                    max_hp: 8,
                    pa_damage: Some(12),
                    exp: 3,
                    body_attack: true,
                    move_speed: None,
                    source_speed: Some(-65.0),
                    hitbox_width: None,
                    hitbox_height: None,
                    hitbox_lt: Some(Point { x: -18.0, y: -26.0 }),
                    hitbox_rb: Some(Point { x: 19.0, y: 0.0 }),
                    die_duration_ms: Some(1260),
                    stand_delay_ms: Some(100),
                    move_duration_ms: Some(900),
                    drop: None,
                }],
                spawns: vec![MonsterSpawn {
                    id: "s1".into(),
                    template_id: "100100".into(),
                    x: 100.0,
                    y: 100.0,
                    foothold_id: Some(1),
                }],
                ..Gameplay::default()
            },
        );
        let id = w.monsters.keys().next().cloned().unwrap();
        {
            let monster = w.monsters.get_mut(&id).unwrap();
            monster.state.action = "stand";
            monster.state.action_started_tick = 0;
            monster.horizontal_speed = 0.0;
        }
        w.tick = 33;
        w.step_monsters();
        assert_eq!(w.monsters[&id].state.action, "stand");
        w.tick = 34;
        w.step_monsters();
        assert_eq!(w.monsters[&id].state.action, "move");
        assert_eq!(w.monsters[&id].state.action_started_tick, 34);

        {
            let monster = w.monsters.get_mut(&id).unwrap();
            monster.state.action = "move";
            monster.state.action_started_tick = 0;
            monster.horizontal_speed = 0.0;
        }
        w.tick = 35;
        w.step_monsters();
        assert_eq!(w.monsters[&id].state.action, "move");
        w.tick = 36;
        w.step_monsters();
        assert!(matches!(w.monsters[&id].state.action, "stand" | "move"));
        assert_eq!(w.monsters[&id].state.action_started_tick, 36);
    }

    #[test]
    fn monster_crosses_contiguous_footholds_and_turns_at_chain_end() {
        let mut w = World::new_with_gameplay(
            map(),
            600,
            Gameplay {
                monsters: vec![MonsterTemplate {
                    template_id: "100100".into(),
                    level: 1,
                    max_hp: 8,
                    pa_damage: Some(12),
                    exp: 3,
                    body_attack: true,
                    move_speed: None,
                    source_speed: Some(-65.0),
                    hitbox_width: None,
                    hitbox_height: None,
                    hitbox_lt: Some(Point { x: -18.0, y: -26.0 }),
                    hitbox_rb: Some(Point { x: 19.0, y: 0.0 }),
                    die_duration_ms: Some(1260),
                    stand_delay_ms: Some(100),
                    move_duration_ms: Some(900),
                    drop: None,
                }],
                spawns: vec![MonsterSpawn {
                    id: "s1".into(),
                    template_id: "100100".into(),
                    x: 100.0,
                    y: 100.0,
                    foothold_id: Some(1),
                }],
                ..Gameplay::default()
            },
        );
        let id = w.monsters.keys().next().cloned().unwrap();
        let monster = w.monsters.get_mut(&id).unwrap();
        monster.state.action = "move";
        monster.state.x = 199.9;
        monster.state.y = 100.0;
        monster.state.facing = 1;
        monster.foothold_id = 1;
        monster.horizontal_speed = 1.0;
        step_monster_with_force(&w.map, monster, 0.035);
        assert_eq!(monster.foothold_id, 2);
        assert!(monster.state.x > 200.0);
        assert!(monster.state.y > 100.0);

        monster.state.x = 474.9;
        monster.state.y = w.map.get(2).unwrap().at(474.9).unwrap();
        monster.state.facing = 1;
        monster.horizontal_speed = 1.0;
        step_monster_with_force(&w.map, monster, 0.035);
        assert_eq!(monster.state.x, 475.0);
        assert_eq!(monster.state.facing, -1);
        assert_eq!(monster.horizontal_speed, 0.0);
    }

    #[test]
    fn player_damage_range_uses_source_stat_and_weapon_formula() {
        let config: PlayerConfig = serde_json::from_str(
            r#"{"job":0,"baseStr":4,"baseDex":4,"baseInt":4,"baseLuk":4,"weaponType":130,"weaponWatk":10}"#,
        )
        .unwrap();
        assert_eq!(config.attack_range(), (0, 2));
        assert!((0..=2).contains(&config.attack_damage()));
    }

    #[test]
    fn attack_and_body_rectangles_mirror_and_overlap_like_wz() {
        let player: PlayerConfig =
            serde_json::from_str(r#"{"attackLt":{"x":-88,"y":-62},"attackRb":{"x":-18,"y":-6}}"#)
                .unwrap();
        assert_eq!(player.attack_bounds(-1), Some((-88.0, -18.0, -62.0, -6.0)));
        assert_eq!(player.attack_bounds(1), Some((18.0, 88.0, -62.0, -6.0)));

        let monster: MonsterTemplate = serde_json::from_str(
            r#"{"templateId":"100100","level":1,"maxHp":8,"PADamage":12,"exp":3,"bodyAttack":true,"hitboxLt":{"x":-18,"y":-26},"hitboxRb":{"x":19,"y":0}}"#,
        )
        .unwrap();
        assert_eq!(
            monster.body_bounds(100.0, 200.0),
            Some((82.0, 119.0, 174.0, 200.0))
        );
        let damage = PlayerConfig {
            base_str: Some(12),
            base_dex: Some(5),
            base_int: Some(4),
            base_luk: Some(4),
            weapon_defense: Some(3),
            standard_pdd: vec![DefenseThreshold { level: 1, value: 7 }],
            ..PlayerConfig::default()
        }
        .contact_damage(1, &monster);
        assert_eq!(damage, Some(1));
    }
}
