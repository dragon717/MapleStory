use crate::{
    auth::{self, Identity, Profile, Store},
    combat::{Attack, Combat},
    inventory,
    npc::{self, DialogueContext, NpcSpawn, NpcTemplate, Shop},
    protocol::{reject, ClientMessage, DropState, MonsterState, NpcState, PlayerState},
};
use rand::Rng;
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
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
#[allow(dead_code)] // portal_type mirrors WZ type (spawn/script/portal); client renders it.
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

    /// Chain-neighbour side wall without the `outer_wall` fallback. Grounded
    /// walkers always want a hard wall (`wall_for` falls back to the
    /// FootholdTree outer wall when the chain has no neighbour), but airborne
    /// jumps only need a physical barrier: the body intentionally crosses
    /// the authored edge to recover past the fall boundary on the next sweep,
    /// and the outer wall must not pin it at the take-off point.
    fn chain_wall_for(&self, current_id: u64, left: bool, foot_y: f64) -> Option<f64> {
        let current = self.get(current_id)?;
        let mut id = if left { current.prev } else { current.next };
        let mut edge = if left {
            current.left()
        } else {
            current.right()
        };
        for _ in 0..2 {
            let Some(candidate) = self.get(id) else { break };
            if candidate.blocks(foot_y - 50.0, foot_y - 1.0) {
                return Some(edge);
            }
            edge = if left {
                candidate.left()
            } else {
                candidate.right()
            };
            id = if left { candidate.prev } else { candidate.next };
        }
        None
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
    /// Source Mob.wz physical defense used by the weapon damage interval.
    #[serde(default, alias = "PDDamage", alias = "pdd")]
    pub pd_damage: Option<i64>,
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

fn default_monster_facing() -> i8 {
    1
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
    /// Empty is the legacy schema: place the spawn on the birth map.
    #[serde(default)]
    pub map_id: String,
    #[serde(default = "default_monster_facing", alias = "f")]
    pub facing: i8,
    /// Cosmic SpawnPoint mobTime: -1 means one forced spawn, 0 uses the
    /// map's normal respawn cycle, and positive values are source seconds.
    #[serde(default)]
    pub mob_time: i64,
    #[serde(default)]
    pub rx0: Option<f64>,
    #[serde(default)]
    pub rx1: Option<f64>,
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
    #[serde(default)]
    pub npcs: Vec<NpcTemplate>,
    #[serde(default)]
    pub npc_spawns: Vec<NpcSpawn>,
    #[serde(default)]
    pub shops: Vec<Shop>,
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
                || template.pd_damage.is_some_and(|damage| damage < 0)
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
                || (!spawn.map_id.is_empty() && spawn.map_id.trim().is_empty())
                || ![-1, 1].contains(&spawn.facing)
                || spawn.mob_time < -1
                || match (spawn.rx0, spawn.rx1) {
                    (Some(rx0), Some(rx1)) => {
                        !rx0.is_finite() || !rx1.is_finite() || rx0 > rx1
                    }
                    (None, None) => false,
                    _ => true,
                }
        }) {
            return Err("invalid gameplay monster spawn".into());
        }
        if self
            .spawns
            .iter()
            .enumerate()
            .any(|(index, spawn)| self.spawns[..index].iter().any(|prior| prior.id == spawn.id))
        {
            return Err("duplicate gameplay monster spawn id".into());
        }
        if self
            .monsters
            .iter()
            .enumerate()
            .any(|(index, template)| {
                self.monsters[..index]
                    .iter()
                    .any(|prior| prior.template_id == template.template_id)
            })
        {
            return Err("duplicate gameplay monster template id".into());
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
        if self
            .npcs
            .iter()
            .any(|template| template.template_id.is_empty() || template.name.is_empty())
        {
            return Err("invalid gameplay npc template".into());
        }
        if self.npcs.iter().enumerate().any(|(index, template)| {
            self.npcs[..index]
                .iter()
                .any(|prior| prior.template_id == template.template_id)
        }) {
            return Err("duplicate gameplay npc template id".into());
        }
        if self.npc_spawns.iter().any(|spawn| {
            spawn.id.is_empty()
                || spawn.template_id.is_empty()
                || ![spawn.x, spawn.y].iter().all(|value| value.is_finite())
                || ![-1, 1].contains(&spawn.facing)
        }) {
            return Err("invalid gameplay npc spawn".into());
        }
        if self
            .npc_spawns
            .iter()
            .enumerate()
            .any(|(index, spawn)| {
                self.npc_spawns[..index]
                    .iter()
                    .any(|prior| prior.id == spawn.id)
            })
        {
            return Err("duplicate gameplay npc spawn id".into());
        }
        let template_ids: BTreeSet<&str> = self
            .npcs
            .iter()
            .map(|template| template.template_id.as_str())
            .collect();
        if self
            .npc_spawns
            .iter()
            .any(|spawn| !template_ids.contains(spawn.template_id.as_str()))
        {
            return Err("npc spawn references unknown npc template".into());
        }
        for template in &self.npcs {
            if let Some(script) = &template.script {
                script
                    .validate(&template.template_id)
                    .map_err(|error| format!("invalid npc dialogue: {error}"))?;
            }
        }
        for shop in &self.shops {
            if shop.shop_id.is_empty()
                || shop.npc_id.is_empty()
                || shop.items.is_empty()
                || shop.items.iter().any(|entry| entry.item_id.is_empty() || entry.price == 0)
            {
                return Err("invalid gameplay shop".into());
            }
            if shop
                .items
                .iter()
                .enumerate()
                .any(|(index, entry)| {
                    shop.items[..index]
                        .iter()
                        .any(|prior| prior.item_id == entry.item_id)
                })
            {
                return Err("duplicate gameplay shop item".into());
            }
            if !template_ids.contains(shop.npc_id.as_str()) {
                return Err("shop references unknown npc template".into());
            }
        }
        Ok(())
    }

    fn validate_spawns_against_maps(
        &self,
        maps: &BTreeMap<String, Map>,
        birth_map_id: &str,
    ) -> Result<(), String> {
        for spawn in &self.spawns {
            let map_id = if spawn.map_id.is_empty() {
                birth_map_id
            } else {
                spawn.map_id.as_str()
            };
            let map = maps
                .get(map_id)
                .ok_or_else(|| format!("monster spawn {} references unknown map {}", spawn.id, map_id))?;
            if !(map.bounds.x_min..=map.bounds.x_max).contains(&spawn.x)
                || !(map.bounds.y_min..=map.bounds.y_max).contains(&spawn.y)
            {
                return Err(format!(
                    "monster spawn {} is outside map {} bounds",
                    spawn.id, map_id
                ));
            }
            if let Some(foothold_id) = spawn.foothold_id {
                let foothold = map.get(foothold_id).ok_or_else(|| {
                    format!(
                        "monster spawn {} references unknown foothold {} on map {}",
                        spawn.id, foothold_id, map_id
                    )
                })?;
                if foothold.is_wall() || !foothold.contains_x(spawn.x) {
                    return Err(format!(
                        "monster spawn {} is off foothold {} on map {}",
                        spawn.id, foothold_id, map_id
                    ));
                }
            } else if map.ground_near(spawn.x, spawn.y).is_none() {
                return Err(format!(
                    "monster spawn {} has no foothold on map {}",
                    spawn.id, map_id
                ));
            }
        }
        Ok(())
    }
}

impl PlayerConfig {
    fn with_equipment(&self, equipped: &[crate::protocol::InventoryItem]) -> Self {
        let bonus = |key: &str| {
            equipped.iter().fold(0i64, |total, item| {
                total.saturating_add(inventory::equipment_attribute(item, key))
            })
        };
        let mut derived = self.clone();
        derived.base_str = Some(self.base_str.unwrap_or(0).saturating_add(bonus("incSTR")));
        derived.base_dex = Some(self.base_dex.unwrap_or(0).saturating_add(bonus("incDEX")));
        derived.base_int = Some(self.base_int.unwrap_or(0).saturating_add(bonus("incINT")));
        derived.base_luk = Some(self.base_luk.unwrap_or(0).saturating_add(bonus("incLUK")));
        // The old fixed 17 PAD / 3 PDD describe the starter sword and shirt.
        // Equipped items replace those values, so reconnects cannot add them twice.
        derived.weapon_watk = Some(bonus("incPAD").max(0));
        derived.weapon_defense = Some(bonus("incPDD").max(0));
        derived.weapon_type = Some(
            equipped
                .iter()
                .find(|item| item.slot == 11)
                .and_then(|item| item.item_id.parse::<i64>().ok())
                .unwrap_or(0)
                / 10_000,
        );
        derived.max_hp = Some(
            self.max_hp
                .unwrap_or(1)
                .saturating_add(bonus("incMHP"))
                .max(1),
        );
        derived.max_mp = Some(
            self.max_mp
                .unwrap_or(0)
                .saturating_add(bonus("incMMP"))
                .max(0),
        );
        derived
    }

    /// Reproduces the regular physical damage interval used by the local
    /// Mapleweb reference (`CharStats.cpp`, lines 80-85 and 95-142).
    #[allow(dead_code)] // kept for the Mapleweb reference damage model; combat uses skill paths.
    fn attack_damage(&self) -> i64 {
        let (min, max) = self.attack_range();
        if max <= min {
            min
        } else {
            rand::thread_rng().gen_range(min..=max)
        }
    }

    /// HeavenClient/Mob.cpp applies level difference and PDD to the raw
    /// interval, then samples a float and truncates it to an integer.
    fn attack_range_against(
        &self,
        player_level: u32,
        monster: &MonsterTemplate,
    ) -> (f64, f64) {
        let (min, max) = self.attack_range();
        let level_delta = monster.level.saturating_sub(player_level) as f64;
        let factor = 1.0 - 0.01 * level_delta;
        let pdd = monster.pd_damage.unwrap_or(0).max(0) as f64;
        (
            (min as f64 * factor - pdd * 0.6).max(1.0),
            (max as f64 * factor - pdd * 0.5).max(1.0),
        )
    }

    fn attack_damage_against(&self, player_level: u32, monster: &MonsterTemplate) -> i64 {
        let (min, max) = self.attack_range_against(player_level, monster);
        let damage = if max <= min {
            min
        } else {
            rand::thread_rng().gen_range(min..max)
        };
        damage.floor().max(1.0) as i64
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
    /// quest id -> "active" | "completed".  Authored quest dialog branches on
    /// these rows and the complete effect grants the configured reward.
    quests: BTreeMap<String, String>,
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

/// A configured npc placed on a map.  Npcs do not move; the field mirrors
/// `Monster`/`DropState` so the snapshot iterator can collect everything by
/// map id in one pass.
struct NpcInstance {
    state: NpcState,
    map_id: String,
    template_id: String,
    /// Currently-playing conversation node id (set when the player is talking).
    conversation: Option<String>,
}

/// Metadata for an equipment instance that is kept in the world's in-memory
/// drop map.  `DropState` is the wire representation and intentionally stays
/// small; this private sidecar preserves strengthened attributes during a
/// no-Store drop/pickup roundtrip.
#[derive(Clone, Default)]
struct DropInstance {
    stats: Option<BTreeMap<String, i64>>,
    remaining_slots: Option<u32>,
    upgrade_count: Option<u32>,
}

impl DropInstance {
    fn from_item(item: &crate::protocol::InventoryItem) -> Self {
        Self {
            stats: item.stats.clone(),
            remaining_slots: item.remaining_slots,
            upgrade_count: item.upgrade_count,
        }
    }

    fn from_record(drop: &auth::DropRecord) -> Self {
        Self {
            stats: drop.stats.clone(),
            remaining_slots: drop.remaining_slots,
            upgrade_count: drop.upgrade_count,
        }
    }
}

pub struct World {
    pub map: Map,
    pub gameplay: Gameplay,
    maps: BTreeMap<String, Map>,
    players: BTreeMap<String, Player>,
    monsters: BTreeMap<String, Monster>,
    npcs: BTreeMap<String, NpcInstance>,
    drops: BTreeMap<String, DropState>,
    drop_instances: BTreeMap<String, DropInstance>,
    drop_owners: BTreeMap<String, (Option<String>, i64)>,
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
    #[allow(dead_code)] // convenience constructors used by unit/integration tests.
    pub fn new(map: Map, duration_ms: u64) -> Self {
        let mut world = Self::build(map, duration_ms, Gameplay::default(), None).unwrap();
        world.spawn_configured_monsters().unwrap();
        world
    }

    #[allow(dead_code)]
    pub fn new_with_gameplay(map: Map, duration_ms: u64, gameplay: Gameplay) -> Self {
        let mut world = Self::build(map, duration_ms, gameplay, None).unwrap();
        world.spawn_configured_monsters().unwrap();
        world
    }

    pub fn new_with_store(
        map: Map,
        duration_ms: u64,
        gameplay: Gameplay,
        store: Store,
    ) -> Result<Self, String> {
        let mut world = Self::build(map, duration_ms, gameplay, Some(store))?;
        world.spawn_configured_monsters()?;
        world.spawn_configured_npcs()?;
        Ok(world)
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
            npcs: BTreeMap::new(),
            drops: BTreeMap::new(),
            drop_instances: BTreeMap::new(),
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
                        id: drop.id.clone(),
                        item_id: drop.item_id.clone(),
                        quantity: drop.quantity,
                        x: drop.x,
                        y: drop.y,
                    },
                );
                world
                    .drop_instances
                    .insert(drop_id.clone(), DropInstance::from_record(&drop));
                world
                    .drop_owners
                    .insert(drop_id.clone(), (owner_id, drop.protected_until_ms));
                world.drop_maps.insert(drop_id, world.map.id.clone());
            }
        }
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
        world.spawn_configured_npcs()?;
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
                            id: drop.id.clone(),
                            item_id: drop.item_id.clone(),
                            quantity: drop.quantity,
                            x: drop.x,
                            y: drop.y,
                        },
                    );
                    self.drop_instances
                        .insert(drop_id.clone(), DropInstance::from_record(&drop));
                    self.drop_owners
                        .insert(drop_id.clone(), (drop.owner_id, drop.protected_until_ms));
                    self.drop_maps.insert(drop_id, map_id.clone());
                }
            }
        }
        self.gameplay
            .validate_spawns_against_maps(&self.maps, &self.map.id)?;
        self.spawn_configured_monsters()
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

    fn spawn_configured_monsters(&mut self) -> Result<(), String> {
        self.gameplay.validate().map_err(|error| error.to_string())?;
        self.gameplay
            .validate_spawns_against_maps(&self.maps, &self.map.id)?;
        let spawns = self.gameplay.spawns.clone();
        for spawn in spawns {
            let map_id = if spawn.map_id.is_empty() {
                self.map.id.clone()
            } else {
                spawn.map_id.clone()
            };
            self.spawn_monster_on_map(map_id, spawn)?;
        }
        Ok(())
    }

    fn spawn_monster_on_map(
        &mut self,
        map_id: String,
        spawn: MonsterSpawn,
    ) -> Result<(), String> {
        if self
            .monsters
            .values()
            .any(|monster| monster.map_id == map_id && monster.spawn.id == spawn.id)
        {
            return Ok(());
        }
        let Some(template) = self
            .gameplay
            .monsters
            .iter()
            .find(|template| template.template_id == spawn.template_id)
            .cloned()
        else {
            return Err(format!(
                "monster spawn {} references unknown template {}",
                spawn.id, spawn.template_id
            ));
        };
        let map = self
            .maps
            .get(&map_id)
            .cloned()
            .ok_or_else(|| format!("monster spawn {} references unknown map {}", spawn.id, map_id))?;
        let foothold_id = spawn.foothold_id.or_else(|| {
            map.ground_near(spawn.x, spawn.y)
                .map(|(foothold_id, _)| foothold_id)
        });
        let (x, y) = foothold_id
            .and_then(|id| {
                map.get(id)
                    .and_then(|f| f.at(spawn.x).map(|y| (spawn.x, y)))
            })
            .ok_or_else(|| {
                format!(
                    "monster spawn {} has invalid foothold {} on map {}",
                    spawn.id,
                    spawn.foothold_id
                        .map_or_else(|| "<inferred>".to_owned(), |id| id.to_string()),
                    map_id
                )
            })?;
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
                    facing: spawn.facing,
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
        Ok(())
    }

    fn spawn_configured_npcs(&mut self) -> Result<(), String> {
        let spawns = self.gameplay.npc_spawns.clone();
        for spawn in spawns {
            let map_id = if spawn.map_id.is_empty() {
                self.map.id.clone()
            } else {
                spawn.map_id.clone()
            };
            self.spawn_npc_on_map(map_id, spawn)?;
        }
        Ok(())
    }

    fn spawn_npc_on_map(&mut self, map_id: String, spawn: NpcSpawn) -> Result<(), String> {
        if self
            .npcs
            .values()
            .any(|npc| npc.map_id == map_id && npc.state.id == spawn.id)
        {
            return Ok(());
        }
        let Some(template) = self
            .gameplay
            .npcs
            .iter()
            .find(|template| template.template_id == spawn.template_id)
            .cloned()
        else {
            return Err(format!(
                "npc spawn {} references unknown template {}",
                spawn.id, spawn.template_id
            ));
        };
        let id = spawn.id.clone();
        self.npcs.insert(
            id.clone(),
            NpcInstance {
                state: NpcState {
                    id,
                    template_id: template.template_id.clone(),
                    name: template.name.clone(),
                    x: spawn.x,
                    y: spawn.y,
                    facing: spawn.facing,
                    shop_id: template.shop_id.clone(),
                },
                map_id,
                template_id: template.template_id,
                conversation: None,
            },
        );
        Ok(())
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
            "npcs":self.npcs.values().filter(|n| n.map_id == map_id).map(|n| &n.state).collect::<Vec<_>>(),
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
                let (equipped, monster_book) = match self.store.as_ref() {
                    Some(store) => match (
                        store.load_equipped(&identity.id),
                        store.load_monster_book(&identity.id),
                    ) {
                        (Ok(equipped), Ok(monster_book)) => (equipped, monster_book),
                        (Err(error), _) | (_, Err(error)) => {
                            let _ = output.try_send(reject("persistence", &error, None));
                            let _ = reply.send(false);
                            return;
                        }
                    },
                    None => (inventory::starter_equipment(), BTreeMap::new()),
                };
                let id = identity.id.clone();
                let birth_map_id = self.map.id.clone();
                let foothold_id = self
                    .map
                    .ground_near(self.map.spawn.x, self.map.spawn.y)
                    .map(|(id, _)| id)
                    .unwrap_or(0);
                let quests = match self.store.as_ref() {
                    Some(store) => store.load_quests(&identity.id).unwrap_or_default(),
                    None => BTreeMap::new(),
                };
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
                            equipped,
                            monster_book,
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
                        quests,
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
                        inventory_type,
                        source_slot,
                        target_slot,
                        quantity,
                    } => self.handle_inventory_move(
                        id,
                        request_id,
                        inventory_type,
                        source_slot,
                        target_slot,
                        quantity,
                    ),
                    ClientMessage::DropItem {
                        request_id,
                        inventory_type,
                        source_slot,
                        quantity,
                    } => self.handle_inventory_drop(
                        id,
                        request_id,
                        inventory_type,
                        source_slot,
                        quantity,
                    ),
                    ClientMessage::InventoryGather {
                        request_id,
                        inventory_type,
                    } => self.handle_inventory_gather(id, request_id, inventory_type),
                    ClientMessage::InventorySort {
                        request_id,
                        inventory_type,
                    } => self.handle_inventory_sort(id, request_id, inventory_type),
                    ClientMessage::UseItem {
                        request_id,
                        inventory_type,
                        source_slot,
                        item_id,
                        target_slot,
                        target_item_id,
                    } => self.handle_use_item(
                        id,
                        request_id,
                        inventory_type,
                        source_slot,
                        item_id,
                        target_slot,
                        target_item_id,
                    ),
                    ClientMessage::DropMesos {
                        request_id,
                        quantity,
                    } => self.handle_drop_mesos(id, request_id, quantity),
                    ClientMessage::Revive { request_id } => self.handle_revive(id, request_id),
                    ClientMessage::NpcTalk {
                        request_id,
                        npc_id,
                        step,
                        selection,
                    } => self.handle_npc_talk(
                        id,
                        request_id,
                        npc_id,
                        step.as_deref(),
                        selection,
                    ),
                    ClientMessage::ShopBuy {
                        request_id,
                        shop_id,
                        item_id,
                        quantity,
                    } => self.handle_shop_buy(id, request_id, shop_id, item_id, quantity),
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
        let pickup_x = player.state.x;
        let pickup_y = player.state.y;
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
            .is_some_and(|(owner, until)| {
                owner.as_deref().is_some_and(|owner| owner != id) && auth::now_ms() < *until
            })
        {
            let _ = player.output.try_send(reject(
                "drop_owned",
                "该物品暂时不可拾取",
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
            if inventory::consume_on_pickup(&drop.item_id) {
                // ConsumeOnPickup cards are always collected.  The
                // MonsterBook count saturates at five, matching Cosmic's
                // Character.applyConsumeOnPickup behavior.
            } else {
                let mut inventory = player.state.inventory.clone();
                let instance = self.drop_instances.get(&drop_id);
                let can_add = inventory::add_item_instance(
                    &mut inventory,
                    drop.item_id.clone(),
                    drop.quantity,
                    instance.and_then(|value| value.stats.as_ref()),
                    instance.and_then(|value| value.remaining_slots),
                    instance.and_then(|value| value.upgrade_count),
                );
                if can_add.is_err() {
                    let _ = player.output.try_send(reject(
                        "inventory_full",
                        "Inventory is full",
                        Some(&request_id),
                    ));
                    return;
                }
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
                let drop_instance = self.drop_instances.remove(&drop_id);
                self.drop_owners.remove(&drop_id);
                self.drop_maps.remove(&drop_id);
                if let Some(store) = self.store.clone() {
                    // The SQLite transaction may have consumed a card into
                    // monster_book_cards or persisted equipment instance
                    // metadata that is not represented by DropState.  Reload
                    // every authoritative profile component after every
                    // successful pickup instead of replaying a lossy add in
                    // memory.
                    let defaults = self.default_profile();
                    let loaded_profile = store.load_profile(&id, &defaults);
                    let loaded_equipped = store.load_equipped(&id);
                    let loaded_monster_book = store.load_monster_book(&id);
                    match (loaded_profile, loaded_equipped, loaded_monster_book) {
                        (Ok(profile), Ok(equipped), Ok(monster_book)) => {
                            if let Some(player) = self.players.get_mut(&id) {
                                apply_profile(&mut player.state, profile);
                                player.state.equipped = equipped;
                                player.state.monster_book = monster_book;
                            }
                        }
                        (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => {
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
                } else if let Some(player) = self.players.get_mut(&id) {
                    if outcome.item_id == "0" {
                        player.state.mesos =
                            player.state.mesos.saturating_add(outcome.quantity as u64);
                    } else if inventory::consume_on_pickup(&outcome.item_id) {
                        let entry = player
                            .state
                            .monster_book
                            .entry(outcome.item_id.clone())
                            .or_insert(0);
                        let current = *entry;
                        let amount = outcome
                            .quantity
                            .min(u32::from(5_u8.saturating_sub(current)));
                        *entry = current
                            .saturating_add(u8::try_from(amount).unwrap_or(0))
                            .min(5);
                    } else {
                        outcome.slot = inventory::add_item_instance(
                            &mut player.state.inventory,
                            outcome.item_id.clone(),
                            outcome.quantity,
                            drop_instance
                                .as_ref()
                                .and_then(|value| value.stats.as_ref()),
                            drop_instance
                                .as_ref()
                                .and_then(|value| value.remaining_slots),
                            drop_instance.as_ref().and_then(|value| value.upgrade_count),
                        )
                        .ok();
                    }
                }
                let event = serde_json::json!({
                    "type": "dropPickedUp",
                    "mapId": map_id.as_str(),
                    "dropId": outcome.drop_id.as_str(),
                    "playerId": id.as_str(),
                    "x": pickup_x,
                    "y": pickup_y,
                })
                .to_string();
                self.broadcast_to_map(&map_id, &event);
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
        inventory_type: u8,
        from_slot: i16,
        to_slot: i16,
        quantity: u32,
    ) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        if let Some(store) = self.store.clone() {
            match store.prior_inventory(&id, &request_id) {
                Ok(Some(prior)) => {
                    if ["move", "equip", "unequip"].contains(&prior.operation.as_str()) {
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
            let equipment_stats = self.equipment_stats(&id);
            match store.move_inventory(
                &id,
                &request_id,
                inventory_type,
                from_slot,
                to_slot,
                quantity,
                equipment_stats,
            ) {
                Ok(outcome) => {
                    if outcome.success {
                        let kind = inventory_type;
                        let applied = self
                            .players
                            .get_mut(&id)
                            .map(|player| {
                                if kind == 1
                                    && inventory::valid_slot(from_slot)
                                    && inventory::valid_equipment_slot(to_slot)
                                {
                                    inventory::equip_items(
                                        &mut player.state.inventory,
                                        &mut player.state.equipped,
                                        equipment_stats,
                                        from_slot,
                                        to_slot,
                                    )
                                    .is_ok()
                                } else if kind == 1
                                    && inventory::valid_equipment_slot(from_slot)
                                    && inventory::valid_slot(to_slot)
                                {
                                    inventory::unequip_items(
                                        &mut player.state.inventory,
                                        &mut player.state.equipped,
                                        from_slot,
                                        to_slot,
                                    )
                                    .is_ok()
                                } else {
                                    inventory::move_items(
                                        &mut player.state.inventory,
                                        kind,
                                        from_slot,
                                        to_slot,
                                        quantity,
                                    )
                                    .is_ok()
                                }
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
                                    if let Ok(equipped) = store.load_equipped(&id) {
                                        player.state.equipped = equipped;
                                    }
                                    if let Ok(monster_book) = store.load_monster_book(&id) {
                                        player.state.monster_book = monster_book;
                                    }
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
            if ["move", "equip", "unequip"].contains(&prior.operation.as_str()) {
                self.send_inventory_outcome(&id, &prior);
            } else {
                self.send_inventory_conflict(&id, &request_id);
            }
            return;
        }
        let mut next_inventory = player.state.inventory.clone();
        let mut next_equipped = player.state.equipped.clone();
        let item_id = next_inventory
            .iter()
            .find(|item| {
                item.slot == u16::try_from(from_slot).unwrap_or(0)
                    && inventory::inventory_type(&item.item_id) == Some(inventory_type)
            })
            .map(|item| item.item_id.clone())
            .or_else(|| {
                next_equipped
                    .iter()
                    .find(|item| {
                        inventory_type == 1
                            && inventory::valid_equipment_slot(from_slot)
                            && item.slot == from_slot.unsigned_abs()
                    })
                    .map(|item| item.item_id.clone())
            })
            .unwrap_or_default();
        let operation = if inventory_type == 1
            && inventory::valid_slot(from_slot)
            && inventory::valid_equipment_slot(to_slot)
        {
            "equip"
        } else if inventory_type == 1
            && inventory::valid_equipment_slot(from_slot)
            && inventory::valid_slot(to_slot)
        {
            "unequip"
        } else {
            "move"
        };
        let result = if operation == "equip" {
            let target = inventory::equipment_slot(&item_id).unwrap_or(to_slot);
            inventory::equip_items(
                &mut next_inventory,
                &mut next_equipped,
                self.equipment_stats(&id),
                from_slot,
                target,
            )
            .map(|_| ())
        } else if operation == "unequip" {
            inventory::unequip_items(&mut next_inventory, &mut next_equipped, from_slot, to_slot)
                .map(|_| ())
        } else {
            inventory::move_items(
                &mut next_inventory,
                inventory_type,
                from_slot,
                to_slot,
                quantity,
            )
        };
        let (success, code) = match result {
            Ok(()) => {
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.inventory = next_inventory;
                    player.state.equipped = next_equipped;
                }
                (true, String::new())
            }
            Err(error) => (false, error.code().to_owned()),
        };
        let outcome = auth::InventoryOutcome {
            request_id: request_id.clone(),
            operation: operation.to_owned(),
            inventory_type: Some(inventory_type),
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
        inventory_type: u8,
        from_slot: i16,
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
                inventory_type,
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
                                    inventory_type,
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
                                    if let Ok(equipped) = store.load_equipped(&id) {
                                        player.state.equipped = equipped;
                                    }
                                    if let Ok(monster_book) = store.load_monster_book(&id) {
                                        player.state.monster_book = monster_book;
                                    }
                                }
                            }
                        }
                        self.ensure_inventory_drop_at(&outcome, drop_x, drop_y, &map_id);
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
            .find(|item| {
                item.slot == u16::try_from(from_slot).unwrap_or(0)
                    && inventory::inventory_type(&item.item_id) == Some(inventory_type)
            })
            .map(|item| item.item_id.clone())
            .unwrap_or_default();
        let instance = next_inventory
            .iter()
            .find(|item| {
                item.slot == u16::try_from(from_slot).unwrap_or(0)
                    && inventory::inventory_type(&item.item_id) == Some(inventory_type)
            })
            .map(DropInstance::from_item);
        let result =
            inventory::remove_items(&mut next_inventory, inventory_type, from_slot, quantity);
        let (success, code, drop_id) = match result {
            Ok((item_id, dropped_quantity)) => {
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.inventory = next_inventory;
                }
                if inventory::is_drop_restricted(&item_id) {
                    (true, String::new(), None)
                } else {
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
                    self.drop_instances
                        .insert(drop_id.clone(), instance.unwrap_or_default());
                    self.drop_owners.insert(drop_id.clone(), (None, 0));
                    self.drop_maps.insert(drop_id.clone(), map_id.clone());
                    (true, String::new(), Some(drop_id))
                }
            }
            Err(error) => (false, error.code().to_owned(), None),
        };
        let outcome = auth::InventoryOutcome {
            request_id: request_id.clone(),
            operation: "drop".to_owned(),
            inventory_type: Some(inventory_type),
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

    fn equipment_stats(&self, id: &str) -> inventory::EquipmentStats {
        let level = self
            .players
            .get(id)
            .map(|player| player.state.level)
            .unwrap_or(1);
        inventory::EquipmentStats {
            level,
            job: self.gameplay.player.job.unwrap_or(0),
            strength: self.gameplay.player.base_str.unwrap_or(0).max(0),
            dexterity: self.gameplay.player.base_dex.unwrap_or(0).max(0),
            intelligence: self.gameplay.player.base_int.unwrap_or(0).max(0),
            luck: self.gameplay.player.base_luk.unwrap_or(0).max(0),
        }
    }

    fn handle_inventory_gather(&mut self, id: String, request_id: String, inventory_type: u8) {
        self.handle_inventory_compact(id, request_id, inventory_type, false);
    }

    fn handle_inventory_sort(&mut self, id: String, request_id: String, inventory_type: u8) {
        self.handle_inventory_compact(id, request_id, inventory_type, true);
    }

    fn handle_inventory_compact(
        &mut self,
        id: String,
        request_id: String,
        inventory_type: u8,
        sort: bool,
    ) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        let operation = if sort { "sort" } else { "gather" };
        if let Some(store) = self.store.clone() {
            match store.prior_inventory(&id, &request_id) {
                Ok(Some(prior)) => {
                    if prior.operation == operation {
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
            let result = if sort {
                store.sort_inventory(&id, &request_id, inventory_type)
            } else {
                store.gather_inventory(&id, &request_id, inventory_type)
            };
            match result {
                Ok(outcome) => {
                    if outcome.success {
                        let applied = self
                            .players
                            .get_mut(&id)
                            .map(|player| {
                                if sort {
                                    inventory::sort_category(
                                        &mut player.state.inventory,
                                        inventory_type,
                                    );
                                    true
                                } else {
                                    inventory::gather_items(
                                        &mut player.state.inventory,
                                        inventory_type,
                                    )
                                    .is_ok()
                                }
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
            if prior.operation == operation {
                self.send_inventory_outcome(&id, &prior);
            } else {
                self.send_inventory_conflict(&id, &request_id);
            }
            return;
        }
        let mut items = player.state.inventory.clone();
        let result = if sort {
            if inventory::valid_inventory_type(inventory_type) {
                inventory::sort_category(&mut items, inventory_type);
                Ok(())
            } else {
                Err(inventory::InventoryError::InvalidInventoryType)
            }
        } else {
            inventory::gather_items(&mut items, inventory_type)
        };
        let (success, code) = match result {
            Ok(()) => {
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.inventory = items;
                }
                (true, String::new())
            }
            Err(error) => (false, error.code().to_owned()),
        };
        let outcome = auth::InventoryOutcome {
            request_id: request_id.clone(),
            operation: operation.to_owned(),
            inventory_type: Some(inventory_type),
            from_slot: 0,
            to_slot: None,
            item_id: String::new(),
            quantity: 0,
            drop_id: None,
            success,
            code,
        };
        self.inventory_requests
            .insert((id.clone(), request_id), outcome.clone());
        self.send_inventory_outcome(&id, &outcome);
    }

    fn handle_use_item(
        &mut self,
        id: String,
        request_id: String,
        inventory_type: u8,
        source_slot: i16,
        item_id: String,
        target_slot: Option<i16>,
        target_item_id: Option<String>,
    ) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        if let Some(store) = self.store.clone() {
            match store.prior_inventory(&id, &request_id) {
                Ok(Some(prior)) => {
                    if ["use", "equip", "unequip"].contains(&prior.operation.as_str()) {
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
            let stats = self.equipment_stats(&id);
            match store.use_item(
                &id,
                &request_id,
                inventory_type,
                source_slot,
                &item_id,
                target_slot,
                target_item_id.as_deref(),
                stats,
            ) {
                Ok(outcome) => {
                    if outcome.success {
                        let defaults = self.default_profile();
                        if let Ok(profile) = store.load_profile(&id, &defaults) {
                            if let Some(player) = self.players.get_mut(&id) {
                                apply_profile(&mut player.state, profile);
                                if let Ok(equipped) = store.load_equipped(&id) {
                                    player.state.equipped = equipped;
                                }
                                if let Ok(monster_book) = store.load_monster_book(&id) {
                                    player.state.monster_book = monster_book;
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
            if ["use", "equip", "unequip"].contains(&prior.operation.as_str()) {
                self.send_inventory_outcome(&id, &prior);
            } else {
                self.send_inventory_conflict(&id, &request_id);
            }
            return;
        }
        let mut inventory_items = player.state.inventory.clone();
        let mut equipped_items = player.state.equipped.clone();
        let stats = self.equipment_stats(&id);
        let mut operation = "use".to_owned();
        let mut result_code = String::new();
        let result = if inventory_type == 1 && inventory::valid_slot(source_slot) {
            if target_slot.is_some() || target_item_id.is_some() {
                Err(inventory::InventoryError::InvalidEquipmentSlot)
            } else if let Some(expected) = inventory::equipment_slot(&item_id) {
                operation = "equip".to_owned();
                inventory::equip_items(
                    &mut inventory_items,
                    &mut equipped_items,
                    stats,
                    source_slot,
                    expected,
                )
                .map(|_| ())
            } else {
                Err(inventory::InventoryError::UnknownItem)
            }
        } else if inventory_type == 1 && inventory::valid_equipment_slot(source_slot) {
            if target_slot.is_some() || target_item_id.is_some() {
                Err(inventory::InventoryError::InvalidEquipmentSlot)
            } else {
                let destination = (1..=inventory::SLOT_LIMIT as i16).find(|slot| {
                    inventory_items.iter().all(|item| {
                        !(item.slot == u16::try_from(*slot).unwrap_or(0)
                            && inventory::inventory_type(&item.item_id) == Some(1))
                    })
                });
                match destination {
                    Some(destination) => {
                        operation = "unequip".to_owned();
                        inventory::unequip_items(
                            &mut inventory_items,
                            &mut equipped_items,
                            source_slot,
                            destination,
                        )
                        .map(|_| ())
                    }
                    None => Err(inventory::InventoryError::InventoryFull),
                }
            }
        } else if inventory_type == 2 && inventory::valid_slot(source_slot) {
            let item_matches = inventory_items.iter().any(|item| {
                item.slot == u16::try_from(source_slot).unwrap_or(0)
                    && inventory::inventory_type(&item.item_id) == Some(2)
                    && item.item_id == item_id
            });
            if !item_matches {
                Err(inventory::InventoryError::SourceEmpty)
            } else if let Ok((hp, mp)) = inventory::use_effect(&item_id) {
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.hp = (player.state.hp + hp).min(player.state.max_hp);
                    player.state.mp = (player.state.mp + mp).min(player.state.max_mp);
                }
                inventory::remove_items(&mut inventory_items, 2, source_slot, 1).map(|_| ())
            } else if inventory::scroll_effect(&item_id).is_some() {
                // Work on clones until both source consumption and target
                // validation succeed.  Failed target/category checks must
                // not consume the scroll, while a valid target consumes one
                // slot even when the random scroll roll fails.
                let mut next_inventory = inventory_items.clone();
                let mut next_equipped = equipped_items.clone();
                match inventory::remove_items(&mut next_inventory, 2, source_slot, 1).and_then(
                    |_| {
                        inventory::apply_scroll(
                            &mut next_equipped,
                            &item_id,
                            target_slot,
                            target_item_id.as_deref(),
                        )
                    },
                ) {
                    Ok(applied) => {
                        inventory_items = next_inventory;
                        equipped_items = next_equipped;
                        result_code = if applied {
                            "scroll_success".to_owned()
                        } else {
                            "scroll_failed".to_owned()
                        };
                        Ok(())
                    }
                    Err(error) => Err(error),
                }
            } else {
                Err(inventory::InventoryError::ItemNotUsable)
            }
        } else {
            Err(inventory::InventoryError::InvalidInventoryType)
        };
        let (success, code) = match result {
            Ok(()) => {
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.inventory = inventory_items;
                    player.state.equipped = equipped_items;
                }
                (true, result_code)
            }
            Err(error) => (false, error.code().to_owned()),
        };
        let outcome = auth::InventoryOutcome {
            request_id: request_id.clone(),
            operation,
            inventory_type: Some(inventory_type),
            from_slot: source_slot,
            to_slot: target_slot,
            item_id,
            quantity: 1,
            drop_id: None,
            success,
            code,
        };
        self.inventory_requests
            .insert((id.clone(), request_id), outcome.clone());
        self.send_inventory_outcome(&id, &outcome);
    }

    fn handle_drop_mesos(&mut self, id: String, request_id: String, quantity: u32) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        let map_id = player.map_id.clone();
        let x = player.state.x;
        let y = player.state.y;
        if let Some(store) = self.store.clone() {
            match store.prior_inventory(&id, &request_id) {
                Ok(Some(prior)) => {
                    if prior.operation == "dropMesos" {
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
            match store.drop_mesos(&id, &map_id, &request_id, quantity, x, y) {
                Ok(outcome) => {
                    if outcome.success {
                        if let Some(player) = self.players.get_mut(&id) {
                            player.state.mesos = player.state.mesos.saturating_sub(quantity as u64);
                        }
                        self.ensure_inventory_drop_at(&outcome, x, y, &map_id);
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
            if prior.operation == "dropMesos" {
                self.ensure_inventory_drop_at(&prior, x, y, &map_id);
                self.send_inventory_outcome(&id, &prior);
            } else {
                self.send_inventory_conflict(&id, &request_id);
            }
            return;
        }
        let (success, code, drop_id) = if !(10..=50_000).contains(&quantity) {
            (false, "invalid_quantity".to_owned(), None)
        } else if player.state.mesos < quantity as u64 {
            (false, "mesos_insufficient".to_owned(), None)
        } else {
            let drop_id = auth::random_id();
            if let Some(player) = self.players.get_mut(&id) {
                player.state.mesos -= quantity as u64;
            }
            self.drops.insert(
                drop_id.clone(),
                crate::protocol::DropState {
                    id: drop_id.clone(),
                    item_id: "0".to_owned(),
                    quantity,
                    x,
                    y,
                },
            );
            self.drop_instances
                .insert(drop_id.clone(), DropInstance::default());
            self.drop_owners.insert(drop_id.clone(), (None, 0));
            self.drop_maps.insert(drop_id.clone(), map_id.clone());
            (true, String::new(), Some(drop_id))
        };
        let outcome = auth::InventoryOutcome {
            request_id: request_id.clone(),
            operation: "dropMesos".to_owned(),
            inventory_type: None,
            from_slot: 0,
            to_slot: None,
            item_id: "0".to_owned(),
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
        if let Some(inventory_type) = outcome.inventory_type {
            message["inventoryType"] = inventory_type.into();
        }
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
                    item_id: drop.item_id.clone(),
                    quantity: drop.quantity,
                    x: drop.x,
                    y: drop.y,
                },
            );
            self.drop_instances
                .insert(drop_id.to_owned(), DropInstance::from_record(&drop));
            self.drop_owners
                .insert(drop_id.to_owned(), (drop.owner_id, drop.protected_until_ms));
            self.drop_maps.insert(drop_id.to_owned(), map_id.to_owned());
        }
    }

    fn ensure_inventory_drop_at(
        &mut self,
        outcome: &auth::InventoryOutcome,
        x: f64,
        y: f64,
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
        let instance = self
            .store
            .clone()
            .and_then(|store| store.load_drop(map_id, drop_id).ok().flatten())
            .map(|drop| DropInstance::from_record(&drop))
            .unwrap_or_default();
        self.drop_instances.insert(drop_id.to_owned(), instance);
        self.drop_owners.insert(drop_id.to_owned(), (None, 0));
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

    fn send_npc_dialogue(&self, id: &str, value: serde_json::Value) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let _ = player.output.try_send(value.to_string());
    }

    fn send_shop_result(
        &self,
        id: &str,
        request_id: &str,
        success: bool,
        code: &str,
        shop_id: &str,
        item_id: &str,
        quantity: u32,
        mesos_spent: u64,
    ) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let message = serde_json::json!({
            "type":"shopResult",
            "requestId":request_id,
            "success":success,
            "code":code,
            "shopId":shop_id,
            "itemId":item_id,
            "quantity":quantity,
            "mesosSpent":mesos_spent,
        })
        .to_string();
        let _ = player.output.try_send(message);
    }

    fn handle_npc_talk(
        &mut self,
        id: String,
        request_id: String,
        npc_id: String,
        step: Option<&str>,
        selection: Option<u32>,
    ) {
        let player_state = match self.players.get(&id) {
            Some(player) => (
                player.map_id.clone(),
                player.state.x,
                player.state.y,
                player.state.level,
                player.state.mesos,
                player.state.inventory.clone(),
            ),
            None => return,
        };
        let (map_id, px, py, level, mesos, inventory) = player_state;
        // Locate the npc and its template.
        let npc_view = {
            let Some(npc) = self.npcs.get(&npc_id) else {
                self.send_reject(&id, "npc_unknown", "npc not placed on a map", Some(&request_id));
                return;
            };
            if npc.map_id != map_id {
                self.send_reject(
                    &id,
                    "npc_too_far",
                    "npc is on a different map",
                    Some(&request_id),
                );
                return;
            }
            (
                npc.template_id.clone(),
                npc.state.x,
                npc.state.y,
                npc.state.name.clone(),
            )
        };
        let (template_id, nx, ny, name) = npc_view;
        if (px - nx).abs() > npc::TALK_RANGE_X || (py - ny).abs() > npc::TALK_RANGE_Y {
            self.send_reject(&id, "npc_too_far", "stand closer to the npc", Some(&request_id));
            return;
        }
        let Some(template) = self
            .gameplay
            .npcs
            .iter()
            .find(|template| template.template_id == template_id)
            .cloned()
        else {
            self.send_reject(&id, "npc_unknown", "npc template missing", Some(&request_id));
            return;
        };
        let Some(script) = template.script.clone() else {
            self.send_npc_dialogue(
                &id,
                npc::DialogueView::End.to_json(&request_id, &npc_id, &name),
            );
            self.end_conversation(&id);
            return;
        };
        let current_node = self
            .npcs
            .get(&npc_id)
            .and_then(|npc| npc.conversation.clone());
        let quests = self
            .players
            .get(&id)
            .map(|player| player.quests.clone())
            .unwrap_or_default();
        let context = DialogueContext {
            level,
            mesos,
            inventory: &inventory,
            quests: &quests,
        };
        match npc::advance(&script, current_node.as_deref(), step, selection, &context) {
            Ok((next_node, view, effect)) => {
                let value = view.to_json(&request_id, &npc_id, &name);
                if let Some(npc) = self.npcs.get_mut(&npc_id) {
                    npc.conversation = match view {
                        npc::DialogueView::End => None,
                        _ => Some(next_node),
                    };
                }
                // Warp immediately when the dialogue resolves to one.
                if let npc::DialogueView::Warp { map_id: warp_to } = &view {
                    let target = warp_to.clone();
                    self.warp_player(&id, target);
                }
                self.send_npc_dialogue(&id, value);
                // Apply the one-shot quest effect after the client has been
                // told the conversation ended.
                if let Some(effect) = effect {
                    self.apply_quest_effect(&id, effect);
                }
            }
            Err(error) => {
                self.end_conversation(&id);
                self.send_reject(&id, "npc_step_invalid", &error, Some(&request_id));
            }
        }
    }

    fn end_conversation(&mut self, player_id: &str) {
        // No player → conversation tracker; conversations live on the npc and
        // are reset by either End or a failure response.  Nothing to do here.
        let _ = player_id;
    }

    /// Mesos reward granted when `complete` is confirmed for a quest.  This
    /// lives server-side next to the authored dialog so the client never has
    /// to trust reward numbers.
    fn quest_reward_mesos(quest_id: &str) -> u64 {
        match quest_id {
            "maple-road-training" => 300,
            _ => 0,
        }
    }

    fn apply_quest_effect(&mut self, id: &str, effect: npc::QuestEffect) {
        let (quest_id, wanted) = match effect {
            npc::QuestEffect::Start(quest_id) => (quest_id, "active"),
            npc::QuestEffect::Complete(quest_id) => (quest_id, "completed"),
        };
        // Only accept the authored transition: available -> active and
        // active -> completed.  Repeat accepts and double turn-ins are no-ops.
        let transition_ok = match self
            .players
            .get(id)
            .map(|player| player.quests.get(&quest_id).cloned())
        {
            Some(None) => wanted == "active",
            Some(Some(previous)) => previous == "active" && wanted == "completed",
            None => false,
        };
        if !transition_ok {
            return;
        }
        let reward = if wanted == "completed" {
            Self::quest_reward_mesos(&quest_id)
        } else {
            0
        };
        {
            let player = match self.players.get_mut(id) {
                Some(player) => player,
                None => return,
            };
            player.quests.insert(quest_id.clone(), wanted.to_owned());
            if reward > 0 {
                player.state.mesos = player.state.mesos.saturating_add(reward);
            }
        }
        if let Some(store) = self.store.as_ref() {
            if let Err(error) = store.save_quest(id, &quest_id, wanted) {
                let _ = self
                    .players
                    .get(id)
                    .and_then(|player| player.output.try_send(reject("persistence", &error, None)).ok());
            }
        }
        if wanted == "completed" {
            let _ = self.persist_player(id);
        }
    }

    fn warp_player(&mut self, player_id: &str, map_id: String) {
        let Some(map) = self.maps.get(&map_id).cloned() else {
            return;
        };
        // Park at the first portal for the target map; the client will
        // reconcile against the in-band portal metadata.
        let (x, y) = map
            .portals
            .first()
            .map(|portal| (portal.x, portal.y))
            .unwrap_or((map.bounds.x_min, map.bounds.y_min));
        if let Some(player) = self.players.get_mut(player_id) {
            player.map_id = map_id.clone();
            player.state.x = x;
            player.state.y = y;
            player.state.vx = 0.0;
            player.state.vy = 0.0;
            player.state.grounded = true;
            player.foothold_id = 0;
            player.last_foothold_id = 0;
            player.fall_boundary_hold = false;
        }
        // Drops for the destination map arrive via the next snapshot.
        let _ = self.send_snapshot(player_id);
    }

    fn send_snapshot(&mut self, id: &str) {
        let snapshot = self.snapshot(id);
        if let Some(player) = self.players.get(id) {
            let _ = player.output.try_send(snapshot);
        }
    }

    fn send_reject(&self, id: &str, code: &str, message: &str, request_id: Option<&str>) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let _ = player
            .output
            .try_send(reject(code, message, request_id));
    }

    fn handle_shop_buy(
        &mut self,
        id: String,
        request_id: String,
        shop_id: String,
        item_id: String,
        quantity: u32,
    ) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        let shop = match self
            .gameplay
            .shops
            .iter()
            .find(|shop| shop.shop_id == shop_id)
            .cloned()
        {
            Some(shop) => shop,
            None => {
                self.send_shop_result(
                    &id,
                    &request_id,
                    false,
                    "shop_unknown",
                    &shop_id,
                    &item_id,
                    quantity,
                    0,
                );
                return;
            }
        };
        let npc_in_range = self.npcs.values().any(|npc| {
            npc.map_id == player.map_id
                && npc.state.shop_id.as_deref() == Some(shop_id.as_str())
                && (player.state.x - npc.state.x).abs() <= npc::TALK_RANGE_X
                && (player.state.y - npc.state.y).abs() <= npc::TALK_RANGE_Y
        });
        if !npc_in_range {
            self.send_shop_result(
                &id,
                &request_id,
                false,
                "shop_too_far",
                &shop_id,
                &item_id,
                quantity,
                0,
            );
            return;
        }
        let unit_price = match shop.price(&item_id) {
            Some(price) => price,
            None => {
                self.send_shop_result(
                    &id,
                    &request_id,
                    false,
                    "shop_item_unknown",
                    &shop_id,
                    &item_id,
                    quantity,
                    0,
                );
                return;
            }
        };
        let total = match unit_price.checked_mul(u64::from(quantity)) {
            Some(total) => total,
            None => {
                self.send_shop_result(
                    &id,
                    &request_id,
                    false,
                    "shop_quantity_invalid",
                    &shop_id,
                    &item_id,
                    quantity,
                    0,
                );
                return;
            }
        };
        if player.state.mesos < total {
            self.send_shop_result(
                &id,
                &request_id,
                false,
                "shop_not_enough_mesos",
                &shop_id,
                &item_id,
                quantity,
                0,
            );
            return;
        }
        // Apply: deduct mesos, add items.  Insertion is atomic against a
        // cloned inventory so a full-tab failure cancels the gold spend.
        let mut next_inventory = player.state.inventory.clone();
        if let Err(error) = inventory::add_items(&mut next_inventory, item_id.clone(), quantity) {
            self.send_shop_result(
                &id,
                &request_id,
                false,
                match error {
                    inventory::InventoryError::InventoryFull => "shop_inventory_full",
                    inventory::InventoryError::UnknownItem => "shop_item_unknown",
                    _ => "shop_rejected",
                },
                &shop_id,
                &item_id,
                quantity,
                0,
            );
            return;
        }
        let new_mesos = player.state.mesos - total;
        let player = match self.players.get_mut(&id) {
            Some(player) => player,
            None => return,
        };
        player.state.inventory = next_inventory;
        player.state.mesos = new_mesos;
        if let Some(store) = self.store.as_ref() {
            let _ = store.write_inventory(&id, &player.state.inventory);
            let _ = store.save_profile(
                &id,
                &profile_from_state(&player.state, &player.death_id),
            );
        }
        self.send_shop_result(
            &id,
            &request_id,
            true,
            "",
            &shop_id,
            &item_id,
            quantity,
            total,
        );
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
            let old_mp = player.state.mp;
            let old_max_hp = player.state.max_hp;
            let old_max_mp = player.state.max_mp;
            let derived = self.gameplay.player.with_equipment(&player.state.equipped);
            player.state.max_hp = derived.max_hp.unwrap_or(1);
            player.state.max_mp = derived.max_mp.unwrap_or(0);
            player.state.hp = player.state.hp.min(player.state.max_hp);
            player.state.mp = player.state.mp.min(player.state.max_mp);
            let old_x = player.state.x;
            let old_y = player.state.y;
            step_player(&map, &self.gameplay, player, self.tick);
            if (player.state.hp != old_hp
                || player.state.mp != old_mp
                || player.state.max_hp != old_max_hp
                || player.state.max_mp != old_max_mp
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
                        pd_damage: None,
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
            let damage = self
                .gameplay
                .player
                .with_equipment(&player.state.equipped)
                .attack_damage_against(player.state.level, &target_template);
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
                        monster.respawn_at = match monster.spawn.mob_time {
                            -1 => None,
                            0 => self.gameplay.monster_respawn_ms.map(|ms| {
                                // Cosmic schedules mobTime=0 through the
                                // map-wide RespawnTask cycle.  Keep the
                                // cycle gate separate from the die animation.
                                let interval_ticks = ms.div_ceil(TICK_MS).max(1);
                                (self.tick / interval_ticks + 1) * interval_ticks
                            }),
                            seconds => {
                                // Positive source mobTime is a private
                                // SpawnPoint delay measured from death.
                                let delay_ms = u64::try_from(seconds)
                                    .unwrap_or(u64::MAX)
                                    .saturating_mul(1_000);
                                Some(self.tick + delay_ms.div_ceil(TICK_MS).max(1))
                            }
                        };
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
                        id: drop.id.clone(),
                        item_id: drop.item_id.clone(),
                        quantity: drop.quantity,
                        x: drop.x,
                        y: drop.y,
                    },
                );
                self.drop_instances
                    .insert(drop_id.clone(), DropInstance::from_record(&drop));
                self.drop_owners
                    .insert(drop_id.clone(), (drop.owner_id, drop.protected_until_ms));
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
                    protected_until_ms: auth::now_ms() + auth::DROP_PROTECTION_MS,
                    ..auth::DropRecord::default()
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
                        .with_equipment(&player.state.equipped)
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
        // finished death pending while its own map is empty; the next
        // occupied cycle can then recreate it with a fresh object id.
        let occupied_maps: BTreeSet<String> = self
            .players
            .values()
            .map(|player| player.map_id.clone())
            .collect();
        if occupied_maps.is_empty() {
            return;
        }
        let remove: Vec<String> = self
            .monsters
            .iter()
            .filter_map(|(id, monster)| {
                if !occupied_maps.contains(&monster.map_id) {
                    return None;
                }
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
                self.spawn_monster_on_map(monster.map_id, monster.spawn)
                    .expect("validated monster spawn became invalid");
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
    // Airborne jumps inherit the same chain-neighbour side wall check as
    // grounded walking: the previous step left the body at the edge of its
    // stable foothold, and the next reachable segment on that chain (e.g. an
    // ascending platform step) is the same hazard that walking already
    // blocks. Fall back to `last_foothold_id` when the jump cleared the
    // active id so the body cannot tunnel horizontally across the platform
    // edge it just left. Only physical chain walls block the jump — the
    // FootholdTree `outer_wall` fallback must not pin the body at the
    // take-off point because the next falling sweep intentionally leaves
    // that authored edge to recover past the map fall boundary.
    let chain_anchor = if player.state.grounded || player.foothold_id != 0 {
        player.foothold_id
    } else {
        player.last_foothold_id
    };
    let chain_wall = (player.state.vx != 0.0 && chain_anchor != 0)
        .then(|| map.chain_wall_for(chain_anchor, player.state.vx < 0.0, player.state.y));
    if let Some(Some(wall)) = chain_wall {
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
        "drop_owned" => "该物品暂时不可拾取",
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

    fn life_map(id: &str) -> Map {
        Map {
            id: id.to_owned(),
            bounds: Bounds {
                x_min: 0.0,
                x_max: 300.0,
                y_min: -100.0,
                y_max: 300.0,
            },
            spawn: Point { x: 10.0, y: 100.0 },
            footholds: vec![Foothold {
                id: 1,
                x1: 0.0,
                y1: 100.0,
                x2: 300.0,
                y2: 100.0,
                prev: 0,
                next: 0,
                forbid_fall_down: 0,
            }],
            ladders: Vec::new(),
            portals: Vec::new(),
        }
    }

    fn life_template() -> MonsterTemplate {
        MonsterTemplate {
            template_id: "100100".into(),
            level: 1,
            max_hp: 8,
            pa_damage: Some(3),
            pd_damage: Some(0),
            exp: 1,
            body_attack: false,
            move_speed: None,
            source_speed: None,
            hitbox_width: Some(20.0),
            hitbox_height: Some(20.0),
            hitbox_lt: None,
            hitbox_rb: None,
            die_duration_ms: Some(50),
            stand_delay_ms: None,
            move_duration_ms: None,
            drop: None,
        }
    }

    fn life_spawn(
        id: &str,
        map_id: &str,
        x: f64,
        facing: i8,
        mob_time: i64,
    ) -> MonsterSpawn {
        MonsterSpawn {
            id: id.into(),
            template_id: "100100".into(),
            x,
            y: 80.0,
            foothold_id: Some(1),
            map_id: map_id.into(),
            facing,
            mob_time,
            rx0: None,
            rx1: None,
        }
    }

    fn life_gameplay(spawns: Vec<MonsterSpawn>) -> Gameplay {
        Gameplay {
            monsters: vec![life_template()],
            spawns,
            monster_respawn_ms: Some(500),
            ..Gameplay::default()
        }
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
    fn pickup_protection_expires_and_inventory_drops_are_public() {
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
        let x = world.players["a"].state.x;
        let y = world.players["a"].state.y;
        world.drops.insert(
            "monster".into(),
            DropState {
                id: "monster".into(),
                item_id: "0".into(),
                quantity: 5,
                x,
                y,
            },
        );
        world.drop_owners.insert(
            "monster".into(),
            (Some("b".into()), auth::now_ms() + auth::DROP_PROTECTION_MS),
        );
        world.drop_maps.insert("monster".into(), "test".into());
        world.handle_pickup("a".into(), "protected".into(), "monster".into());
        assert!(world.drops.contains_key("monster"));
        let mut messages = Vec::new();
        while let Ok(message) = rx.try_recv() {
            messages.push(message);
        }
        assert!(messages.iter().any(
            |message| message.contains("drop_owned") && message.contains("该物品暂时不可拾取")
        ));
        let mesos = world.players["a"].state.mesos;
        world.drop_owners.get_mut("monster").unwrap().1 = auth::now_ms();
        world.handle_pickup("a".into(), "expired".into(), "monster".into());
        assert!(!world.drops.contains_key("monster"));
        assert_eq!(world.players["a"].state.mesos, mesos + 5);

        world.players.get_mut("a").unwrap().state.inventory =
            vec![crate::protocol::InventoryItem {
                slot: 1,
                item_id: "4000019".into(),
                quantity: 1,
                ..crate::protocol::InventoryItem::default()
            }];
        world.handle_inventory_drop("a".into(), "discard".into(), 4, 1, 1);
        let drop_id = world.drops.keys().next().unwrap().clone();
        assert_eq!(world.drop_owners[&drop_id], (None, 0));
        let (output, _other_rx) = mpsc::channel(128);
        let (reply, _) = oneshot::channel();
        world.command(Command::Join {
            identity: Identity {
                id: "b".into(),
                username: "bob".into(),
            },
            connection: "d".into(),
            output,
            reply,
        });
        world.handle_pickup("b".into(), "public".into(), drop_id.clone());
        assert!(!world.drops.contains_key(&drop_id));
        assert!(world.players["b"]
            .state
            .inventory
            .iter()
            .any(|item| item.item_id == "4000019" && item.quantity == 1));
    }

    #[test]
    fn memory_pickup_cards_saturate_and_scroll_preserves_instance_state() {
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
        while rx.try_recv().is_ok() {}
        let x = world.players["a"].state.x;
        let y = world.players["a"].state.y;

        world.drops.insert(
            "card-five".into(),
            DropState {
                id: "card-five".into(),
                item_id: "2380000".into(),
                quantity: 5,
                x,
                y,
            },
        );
        world.drop_owners.insert("card-five".into(), (None, 0));
        world.drop_maps.insert("card-five".into(), "test".into());
        world.handle_pickup("a".into(), "card-five-pickup".into(), "card-five".into());
        assert!(!world.drops.contains_key("card-five"));
        assert_eq!(
            world.players["a"].state.monster_book.get("2380000"),
            Some(&5)
        );
        assert!(world.players["a"]
            .state
            .inventory
            .iter()
            .all(|item| item.item_id != "2380000"));

        // A sixth card is consumed and removed even though the book count is
        // already capped.
        world.drops.insert(
            "card-six".into(),
            DropState {
                id: "card-six".into(),
                item_id: "2380000".into(),
                quantity: 1,
                x,
                y,
            },
        );
        world.drop_owners.insert("card-six".into(), (None, 0));
        world.drop_maps.insert("card-six".into(), "test".into());
        world.handle_pickup("a".into(), "card-six-pickup".into(), "card-six".into());
        assert!(!world.drops.contains_key("card-six"));
        assert_eq!(
            world.players["a"].state.monster_book.get("2380000"),
            Some(&5)
        );

        let mut helmet = crate::protocol::InventoryItem {
            slot: 1,
            item_id: "1002067".into(),
            quantity: 1,
            ..crate::protocol::InventoryItem::default()
        };
        inventory::ensure_equipment_instance(&mut helmet);
        world.players.get_mut("a").unwrap().state.inventory =
            vec![crate::protocol::InventoryItem {
                slot: 1,
                item_id: "2040002".into(),
                quantity: 2,
                ..crate::protocol::InventoryItem::default()
            }];
        world.players.get_mut("a").unwrap().state.equipped = vec![helmet];

        world.handle_use_item(
            "a".into(),
            "memory-scroll-wrong-target".into(),
            2,
            1,
            "2040002".into(),
            Some(-1),
            Some("1040002".into()),
        );
        assert_eq!(world.players["a"].state.inventory[0].quantity, 2);
        assert_eq!(
            world.players["a"].state.equipped[0].remaining_slots,
            Some(7)
        );

        world.handle_use_item(
            "a".into(),
            "memory-scroll-valid".into(),
            2,
            1,
            "2040002".into(),
            Some(-1),
            Some("1002067".into()),
        );
        assert_eq!(world.players["a"].state.inventory[0].quantity, 1);
        let helmet = &world.players["a"].state.equipped[0];
        assert_eq!(helmet.remaining_slots, Some(6));
        assert!(matches!(
            helmet.stats.as_ref().and_then(|stats| stats.get("incPDD")),
            Some(5) | Some(10)
        ));

        let strengthened = crate::protocol::InventoryItem {
            slot: 1,
            item_id: "1002067".into(),
            quantity: 1,
            stats: Some(BTreeMap::from([(String::from("incPDD"), 12)])),
            remaining_slots: Some(6),
            upgrade_count: Some(1),
        };
        world.players.get_mut("a").unwrap().state.inventory = vec![strengthened];
        world.handle_inventory_drop("a".into(), "memory-drop-equip".into(), 1, 1, 1);
        let drop_id = world
            .inventory_requests
            .get(&(String::from("a"), String::from("memory-drop-equip")))
            .and_then(|outcome| outcome.drop_id.clone())
            .expect("equipment drop id");
        world.handle_pickup("a".into(), "memory-pickup-equip".into(), drop_id);
        let picked = world.players["a"]
            .state
            .inventory
            .iter()
            .find(|item| item.item_id == "1002067")
            .expect("strengthened equipment returned to inventory");
        assert_eq!(
            picked.stats,
            Some(BTreeMap::from([(String::from("incPDD"), 12)]))
        );
        assert_eq!(picked.remaining_slots, Some(6));
        assert_eq!(picked.upgrade_count, Some(1));
    }

    #[test]
    fn store_pickup_refreshes_equipment_metadata_and_monster_book_in_world_state() {
        let path = std::env::temp_dir().join(format!(
            "maple-world-store-pickup-{}.sqlite3",
            auth::random_id()
        ));
        let service = auth::start(&path).unwrap();
        let store = service.store.clone();
        let defaults = Profile {
            hp: 50,
            max_hp: 50,
            mp: 5,
            max_mp: 5,
            level: 5,
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            death_id: String::new(),
            inventory: Vec::new(),
        };
        store.load_profile("a", &defaults).unwrap();
        let stats = BTreeMap::from([(String::from("incPDD"), 12_i64)]);
        store
            .claim_attack("a", "world-reward", "world-action", "attack")
            .unwrap();
        store
            .resolve_attack(
                "a",
                "test",
                "world-reward",
                Some("world-monster"),
                1,
                true,
                0,
                1,
                &[
                    auth::DropRecord {
                        id: "world-equipment".into(),
                        item_id: "1002067".into(),
                        quantity: 1,
                        x: 10.0,
                        y: 0.0,
                        stats: Some(stats.clone()),
                        remaining_slots: Some(6),
                        upgrade_count: Some(1),
                        ..auth::DropRecord::default()
                    },
                    auth::DropRecord {
                        id: "world-card".into(),
                        item_id: "2380000".into(),
                        quantity: 1,
                        x: 10.0,
                        y: 0.0,
                        ..auth::DropRecord::default()
                    },
                ],
                &[],
                &["a".into()],
            )
            .unwrap();
        let mut world = World::new_with_store(map(), 600, Gameplay::default(), store).unwrap();
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
        while rx.try_recv().is_ok() {}
        world.handle_pickup("a".into(), "world-card-pickup".into(), "world-card".into());
        assert_eq!(
            world.players["a"].state.monster_book.get("2380000"),
            Some(&1)
        );
        assert!(world.players["a"]
            .state
            .inventory
            .iter()
            .all(|item| item.item_id != "2380000"));

        world.handle_pickup(
            "a".into(),
            "world-equipment-pickup".into(),
            "world-equipment".into(),
        );
        let picked = world.players["a"]
            .state
            .inventory
            .iter()
            .find(|item| item.item_id == "1002067")
            .expect("store pickup is reflected in the world profile");
        assert_eq!(picked.stats, Some(stats));
        assert_eq!(picked.remaining_slots, Some(6));
        assert_eq!(picked.upgrade_count, Some(1));
        drop(service);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    #[test]
    fn pickup_broadcasts_animation_event_once_to_the_same_map() {
        let mut world = World::new(map(), 600);
        let (a_output, mut a_rx) = mpsc::channel(128);
        let (b_output, mut b_rx) = mpsc::channel(128);
        let (c_output, mut c_rx) = mpsc::channel(128);
        for (id, username, connection, output) in [
            ("a", "alice", "a-connection", a_output),
            ("b", "bob", "b-connection", b_output),
            ("c", "charlie", "c-connection", c_output),
        ] {
            let (reply, _) = oneshot::channel();
            world.command(Command::Join {
                identity: Identity {
                    id: id.into(),
                    username: username.into(),
                },
                connection: connection.into(),
                output,
                reply,
            });
        }
        while a_rx.try_recv().is_ok() {}
        while b_rx.try_recv().is_ok() {}
        while c_rx.try_recv().is_ok() {}
        world.players.get_mut("c").unwrap().map_id = "other".into();

        let pickup_x = world.players["a"].state.x;
        let pickup_y = world.players["a"].state.y;
        world.drops.insert(
            "animation-drop".into(),
            DropState {
                id: "animation-drop".into(),
                item_id: "0".into(),
                quantity: 5,
                x: pickup_x,
                y: pickup_y,
            },
        );
        world.drop_owners.insert("animation-drop".into(), (None, 0));
        world
            .drop_maps
            .insert("animation-drop".into(), "test".into());

        world.handle_pickup(
            "a".into(),
            "animation-pickup".into(),
            "animation-drop".into(),
        );

        let a_messages: Vec<_> = std::iter::from_fn(|| a_rx.try_recv().ok()).collect();
        let b_messages: Vec<_> = std::iter::from_fn(|| b_rx.try_recv().ok()).collect();
        let c_messages: Vec<_> = std::iter::from_fn(|| c_rx.try_recv().ok()).collect();
        let event = a_messages
            .iter()
            .find(|message| message.contains("\"type\":\"dropPickedUp\""))
            .map(|message| serde_json::from_str::<serde_json::Value>(message).unwrap())
            .expect("picker receives pickup animation event");
        assert_eq!(event["mapId"], "test");
        assert_eq!(event["dropId"], "animation-drop");
        assert_eq!(event["playerId"], "a");
        assert_eq!(event["x"].as_f64(), Some(pickup_x));
        assert_eq!(event["y"].as_f64(), Some(pickup_y));
        assert_eq!(
            b_messages
                .iter()
                .filter(|message| message.contains("\"type\":\"dropPickedUp\""))
                .count(),
            1
        );
        assert_eq!(
            c_messages
                .iter()
                .filter(|message| message.contains("\"type\":\"dropPickedUp\""))
                .count(),
            0
        );

        world.handle_pickup(
            "a".into(),
            "animation-pickup".into(),
            "animation-drop".into(),
        );
        let replay_messages: Vec<_> = std::iter::from_fn(|| a_rx.try_recv().ok()).collect();
        assert_eq!(
            replay_messages
                .iter()
                .filter(|message| message.contains("\"type\":\"dropPickedUp\""))
                .count(),
            0
        );
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
                ..crate::protocol::InventoryItem::default()
            },
            crate::protocol::InventoryItem {
                slot: 2,
                item_id: "2000000".into(),
                quantity: 1,
                ..crate::protocol::InventoryItem::default()
            },
        ];
        world.command(Command::Input {
            id: "a".into(),
            connection: "c".into(),
            message: ClientMessage::InventoryMove {
                request_id: "move-once".into(),
                inventory_type: 4,
                source_slot: 1,
                target_slot: 2,
                quantity: 3,
            },
        });
        let use_item = world.players["a"]
            .state
            .inventory
            .iter()
            .find(|item| item.item_id == "2000000")
            .unwrap();
        assert_eq!(use_item.slot, 2);
        let etc_item = world.players["a"]
            .state
            .inventory
            .iter()
            .find(|item| item.item_id == "4000019")
            .unwrap();
        assert_eq!(etc_item.slot, 2);
        world.command(Command::Input {
            id: "a".into(),
            connection: "c".into(),
            message: ClientMessage::InventoryMove {
                request_id: "move-once".into(),
                inventory_type: 4,
                source_slot: 1,
                target_slot: 2,
                quantity: 3,
            },
        });
        assert_eq!(
            world.players["a"]
                .state
                .inventory
                .iter()
                .find(|item| item.item_id == "4000019")
                .unwrap()
                .quantity,
            3
        );

        world.command(Command::Input {
            id: "a".into(),
            connection: "c".into(),
            message: ClientMessage::DropItem {
                request_id: "drop-once".into(),
                inventory_type: 4,
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
                inventory_type: 4,
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
        for id in [
            "000010000", "001000000", "001010000", "001020000", "002000000", "002000001",
        ] {
            assert!(
                catalog.maps.iter().any(|map| map.id == id),
                "missing starter map {id}"
            );
        }
        assert!(catalog.maps.iter().all(|map| !map.footholds.is_empty()));
        assert!(catalog
            .maps
            .iter()
            .flat_map(|map| map.portals.iter())
            .any(|portal| portal.target_map_id.as_deref() == Some("000020000")));
    }

    #[test]
    fn authored_life_loads_on_each_map_and_respawns_from_its_source() {
        let birth = life_map("birth");
        let target = life_map("target");
        let gameplay = life_gameplay(vec![
            life_spawn("birth-life", "birth", 100.0, -1, -1),
            life_spawn("target-life", "target", 200.0, 1, 1),
        ]);
        let mut world = World::build(birth.clone(), 600, gameplay, None).unwrap();
        world
            .attach_catalog(MapCatalog {
                birth_map_id: "birth".into(),
                maps: vec![birth, target],
            })
            .unwrap();
        assert_eq!(world.monsters.len(), 2);
        assert_eq!(
            world
                .monsters
                .values()
                .filter(|monster| monster.map_id == "birth")
                .count(),
            1
        );
        assert_eq!(
            world
                .monsters
                .values()
                .find(|monster| monster.map_id == "target")
                .unwrap()
                .state
                .facing,
            1
        );

        let (birth_output, _birth_rx) = mpsc::channel(16);
        let (birth_reply, _birth_reply_rx) = oneshot::channel();
        world.command(Command::Join {
            identity: Identity {
                id: "birth-player".into(),
                username: "birth-player".into(),
            },
            connection: "birth-connection".into(),
            output: birth_output,
            reply: birth_reply,
        });
        let (target_output, _target_rx) = mpsc::channel(16);
        let (target_reply, _target_reply_rx) = oneshot::channel();
        world.command(Command::Join {
            identity: Identity {
                id: "target-player".into(),
                username: "target-player".into(),
            },
            connection: "target-connection".into(),
            output: target_output,
            reply: target_reply,
        });
        world.players.get_mut("target-player").unwrap().map_id = "birth".into();

        let birth_id = world
            .monsters
            .iter()
            .find(|(_, monster)| monster.spawn.id == "birth-life")
            .map(|(id, _)| id.clone())
            .unwrap();
        let target_id = world
            .monsters
            .iter()
            .find(|(_, monster)| monster.spawn.id == "target-life")
            .map(|(id, _)| id.clone())
            .unwrap();
        {
            let monster = world.monsters.get_mut(&birth_id).unwrap();
            monster.state.hp = 0;
            monster.state.action = "die";
            monster.death_until = Some(1);
            monster.respawn_at = None;
        }
        {
            let monster = world.monsters.get_mut(&target_id).unwrap();
            monster.state.hp = 0;
            monster.state.action = "die";
            monster.death_until = Some(1);
            monster.respawn_at = Some(20);
        }
        world.tick = 20;
        world.respawn_monsters();
        assert!(!world.monsters.values().any(|monster| monster.spawn.id == "birth-life"));
        assert!(world.monsters.contains_key(&target_id));

        world.players.get_mut("target-player").unwrap().map_id = "target".into();
        world.respawn_monsters();
        let respawned = world
            .monsters
            .values()
            .find(|monster| monster.spawn.id == "target-life")
            .unwrap();
        assert_ne!(respawned.state.id, target_id);
        assert_eq!(respawned.map_id, "target");
        assert_eq!(respawned.state.x, 200.0);
        assert_eq!(respawned.state.y, 100.0);
        assert_eq!(respawned.state.facing, 1);
        assert_eq!(respawned.spawn.mob_time, 1);
    }

    #[test]
    fn authored_life_rejects_unknown_map_foothold_and_template() {
        let catalog = || MapCatalog {
            birth_map_id: "birth".into(),
            maps: vec![life_map("birth"), life_map("target")],
        };
        let cases = [
            (life_spawn("unknown-map", "missing", 100.0, 1, 0), "unknown map"),
            ({
                let mut spawn = life_spawn("unknown-foothold", "birth", 100.0, 1, 0);
                spawn.foothold_id = Some(99);
                (spawn, "unknown foothold")
            }),
            ({
                let mut spawn = life_spawn("unknown-template", "birth", 100.0, 1, 0);
                spawn.template_id = "missing".into();
                (spawn, "unknown template")
            }),
        ];
        for (spawn, expected) in cases {
            let gameplay = life_gameplay(vec![spawn]);
            let result = World::build(life_map("birth"), 600, gameplay, None)
                .and_then(|mut world| world.attach_catalog(catalog()));
            let error = match result {
                Ok(_) => panic!("invalid authored life was accepted: {expected}"),
                Err(error) => error,
            };
            assert!(error.contains(expected), "{error}");
        }
    }

    #[test]
    fn source_pdd_applies_to_damage_interval_and_keeps_one_damage_floor() {
        let config = PlayerConfig {
            base_str: Some(4),
            base_dex: Some(4),
            weapon_type: Some(130),
            weapon_watk: Some(10),
            ..PlayerConfig::default()
        };
        let mut red_snail = life_template();
        red_snail.pd_damage = Some(3);
        let mut slime = life_template();
        slime.pd_damage = Some(5);
        let no_defense = life_template();
        assert_eq!(
            config.attack_range_against(1, &red_snail),
            (1.0, 1.0)
        );
        assert_eq!(config.attack_range_against(1, &slime), (1.0, 1.0));
        assert_eq!(
            config.attack_range_against(1, &no_defense),
            (1.0, 2.0)
        );
        let mut high_defense = life_template();
        high_defense.pd_damage = Some(1000);
        assert_eq!(
            config.attack_range_against(1, &high_defense),
            (1.0, 1.0)
        );
        assert!(config.attack_damage_against(1, &high_defense) >= 1);
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
    fn jump_stops_at_chain_wall_but_outer_wall_does_not_pin_takeoff() {
        // Walking the chain already halts at the wall; jumping must hit the
        // same physical barrier instead of tunneling past it and landing on
        // the upper platform. The FootholdTree `outer_wall` must not pin the
        // body at the take-off point when the chain has no vertical wall
        // neighbour — the next falling sweep intentionally leaves the
        // authored edge to recover on the last foothold.
        let map: Map = serde_json::from_str(
            r#"{"id":"step","bounds":{"xMin":0,"xMax":500,"yMin":-200,"yMax":500},"spawn":{"x":50,"y":100},"footholds":[{"id":1,"x1":0,"y1":100,"x2":100,"y2":100,"prev":0,"next":2},{"id":2,"x1":100,"y1":50,"x2":100,"y2":150,"prev":1,"next":3},{"id":3,"x1":100,"y1":100,"x2":200,"y2":100,"prev":2,"next":0},{"id":4,"x1":0,"y1":250,"x2":500,"y2":250,"prev":0,"next":0}],"ladders":[]}"#,
        )
        .unwrap();
        assert_eq!(
            map.chain_wall_for(1, false, 100.0),
            Some(100.0),
            "chain wall must report the rising step edge"
        );
        // Walking's wall_for coincides here because the chain produces the
        // vertical step at the take-off height.
        assert_eq!(map.wall_for(1, false, 100.0), 100.0);
        // And it must NOT pin the body once the player has cleared the
        // authored area on a recover-jump out of the map.
        let recovery: Map = serde_json::from_str(
            r#"{"id":"recovery","bounds":{"xMin":0,"xMax":300,"yMin":-200,"yMax":300},"spawn":{"x":25,"y":0},"footholds":[{"id":1,"x1":0,"y1":0,"x2":50,"y2":0}],"ladders":[]}"#,
        )
        .unwrap();
        assert_eq!(
            recovery.chain_wall_for(1, false, 0.0),
            None,
            "no chain wall: the airborne jumper must keep rolling past the FootholdTree outer wall"
        );

        let mut w = World::new(map, 600);
        let (output, _rx) = mpsc::channel(128);
        let (reply, _) = oneshot::channel();
        w.command(Command::Join {
            identity: Identity {
                id: "a".into(),
                username: "alice".into(),
            },
            connection: "c".into(),
            reply,
            output,
        });
        w.step();

        // Anchor the player on foothold 1 (range 0..100, y=100), then jump
        // toward the rising step at x=100. The body must stop at the wall
        // edge and stay grounded near y=100 instead of landing on the upper
        // platform (foothold 3, y=100).
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
        for _ in 0..60 {
            w.step();
            let player = &w.players["a"];
            if !player.jump && player.state.grounded {
                break;
            }
        }
        let player = &w.players["a"];
        // The block at x=100 must hold the body near the take-off edge;
        // either it returns to the original segment (foothold 1, y=100,
        // x≤100) or — if the wall genuinely pins it — it falls onto the
        // lower world floor (foothold 4, y=250). It must never climb past
        // the wall onto the raised step (foothold 3, x>100).
        assert!(
            player.state.x <= 100.0 + 0.5,
            "jump must not tunnel across the chain wall, got x={}",
            player.state.x
        );
        assert!(player.state.grounded, "body should land near the take-off platform");
        assert!(
            (player.state.y - 100.0).abs() < 1.0 || player.state.y > 200.0,
            "body must end near take-off platform or on lower world floor, got y={}",
            player.state.y
        );
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
                    pd_damage: None,
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
                    map_id: String::new(),
                    facing: 1,
                    mob_time: 0,
                    rx0: None,
                    rx1: None,
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
                    pd_damage: None,
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
                    map_id: String::new(),
                    facing: 1,
                    mob_time: 0,
                    rx0: None,
                    rx1: None,
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
                    pd_damage: None,
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
                    map_id: String::new(),
                    facing: 1,
                    mob_time: 0,
                    rx0: None,
                    rx1: None,
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
                    pd_damage: None,
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
                    map_id: String::new(),
                    facing: 1,
                    mob_time: 0,
                    rx0: None,
                    rx1: None,
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

    #[test]
    fn equipment_replaces_starter_stats_and_never_accumulates() {
        use crate::protocol::InventoryItem;
        let config = PlayerConfig {
            base_str: Some(4),
            base_dex: Some(4),
            weapon_type: Some(130),
            weapon_watk: Some(17),
            weapon_defense: Some(3),
            max_hp: Some(50),
            max_mp: Some(5),
            ..PlayerConfig::default()
        };
        let equipped = vec![
            InventoryItem {
                slot: 11,
                item_id: "1302000".into(),
                quantity: 1,
                ..InventoryItem::default()
            },
            InventoryItem {
                slot: 5,
                item_id: "1040002".into(),
                quantity: 1,
                ..InventoryItem::default()
            },
        ];
        let derived = config.with_equipment(&equipped);
        assert_eq!(derived.weapon_watk, Some(17));
        assert_eq!(derived.weapon_defense, Some(3));
        assert_eq!(derived.attack_range(), config.attack_range());
        let mut upgraded = equipped.clone();
        upgraded[1].stats = Some(BTreeMap::from([
            ("incPDD".into(), 8),
            ("incMHP".into(), 10),
        ]));
        let upgraded_stats = config.with_equipment(&upgraded);
        assert_eq!(upgraded_stats.weapon_defense, Some(8));
        assert_eq!(upgraded_stats.max_hp, Some(60));
        assert_eq!(config.with_equipment(&upgraded).max_hp, Some(60));
        assert_eq!(config.with_equipment(&[]).weapon_watk, Some(0));
        assert_eq!(config.with_equipment(&[]).max_hp, Some(50));
    }
}
