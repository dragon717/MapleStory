//! 地图几何与地形查询（`Foothold` / `Ladder` / `ReactorPlacement` / `WaterRect` / `Map` 的方法）。
//!
//! 负责：墙与落点判定（`is_wall` / `blocks` / `landing_on_sweep`）、地面查询
//! （`ground_below` / `ground_near` / `fall_boundary`）、链墙与外 wall
//! （`wall_for` / `chain_wall_for` / `chain_wall_on_sweep` / `outer_wall`）、爬绳
//! （`ladder_for` / `accepts` / `ladder_top_ground`）、水域（`water_*`）与
//! 下跳目标（`downjump_target`）、连绵地形（`contiguous_neighbor`）。
//! 不负责：地图加载（`Map::load` / `MapCatalog::load` 留在 `world.rs`）、
//! 玩家移动模拟（`step_player` 见 `movement.rs`）。
//! 类型定义留在 `world.rs`（规则：搬行为不搬状态布局）；方法可见性 pub(super)
//! 与原 private 可达范围相同，全为方法调用、无需 glob 接线。

use super::*;

impl Foothold {
    pub(super) fn is_wall(&self) -> bool {
        (self.x1 - self.x2).abs() < 0.001
    }

    pub(super) fn left(&self) -> f64 {
        self.x1.min(self.x2)
    }

    pub(super) fn right(&self) -> f64 {
        self.x1.max(self.x2)
    }

    pub(super) fn top(&self) -> f64 {
        self.y1.min(self.y2)
    }

    pub(super) fn bottom(&self) -> f64 {
        self.y1.max(self.y2)
    }

    pub(super) fn contains_x(&self, x: f64) -> bool {
        !self.is_wall() && x >= self.left() - 0.001 && x <= self.right() + 0.001
    }

    pub(super) fn at(&self, x: f64) -> Option<f64> {
        if !self.contains_x(x) {
            return None;
        }
        Some(self.y1 + (x - self.x1) / (self.x2 - self.x1) * (self.y2 - self.y1))
    }

    pub(super) fn blocks(&self, top: f64, bottom: f64) -> bool {
        self.is_wall() && self.top() <= bottom && self.bottom() >= top
    }

    /// Wall test at the moment the body reaches the wall plane, for a step
    /// that starts at `from_y`, ends at `to_y`, and crosses the plane at
    /// fraction `t` of the step.
    ///
    /// The check must be made at the contact time, not at a tick boundary.
    /// A body falling fast can drop past a wall's top inside one tick: at the
    /// tick start it is above the wall, at the tick end it has already crossed
    /// the plane, and a test at either endpoint alone tunnels straight
    /// through.  Conversely a rising body that clears the wall top *before*
    /// reaching the plane must be allowed over it — testing the union of both
    /// endpoints would wrongly block that legal jump.
    pub(super) fn blocks_at_crossing(&self, from_y: f64, to_y: f64, t: f64) -> bool {
        if !self.is_wall() {
            return false;
        }
        let contact_y = from_y + (to_y - from_y) * t.clamp(0.0, 1.0);
        self.blocks(contact_y - BODY_HEIGHT_PX, contact_y - 1.0)
    }
}

impl Ladder {
    pub(super) fn top(&self) -> f64 {
        self.y1.min(self.y2)
    }

    pub(super) fn bottom(&self) -> f64 {
        self.y1.max(self.y2)
    }

    /// `l` is the map WZ ladder/rope selector.  The client has separate
    /// source-backed ladder and rope stances, so keep that distinction in the
    /// authoritative action instead of treating every vertical link as a
    /// generic climb animation.
    pub(super) fn action(&self) -> &'static str {
        if self.l != 0 {
            "ladder"
        } else {
            "rope"
        }
    }

    /// `uf` controls whether an upward climb may leave through the top end.
    /// The supplied map uses `uf=1`; an `uf=0` link must hold the player at its
    /// top until they reverse direction or leave by another sourced action.
    pub(super) fn allows_top_exit(&self) -> bool {
        self.uf != 0
    }

    pub(super) fn accepts(&self, x: f64, y: f64, upwards: bool) -> bool {
        let probe = y + if upwards { -5.0 } else { 5.0 };
        (x - self.x).abs() <= 10.0 && probe >= self.top() && probe <= self.bottom()
    }
}

impl ReactorPlacement {
    /// Source event type 9: the prop is used by clicking it or standing in the
    /// authored `lt`/`rb` area rather than by swinging a weapon at it.
    const TYPE_AREA: u32 = 9;

    /// The last authored state is the empty "used up" form.
    pub(super) fn interactable_at(&self, state: u32) -> bool {
        self.state_count > 0 && state + 1 < self.state_count
    }

    /// True when the source expects the player to walk into / click the prop.
    pub(super) fn area_triggered(&self) -> bool {
        self.hit_type == Self::TYPE_AREA
    }

    /// Authored interaction box in world coordinates, or `None` when the
    /// source declares none (those reactors fall back to the attack reach).
    pub(super) fn hit_bounds(&self) -> Option<(f64, f64, f64, f64)> {
        let (lt, rb) = (self.hitbox_lt.as_ref()?, self.hitbox_rb.as_ref()?);
        let (x_min, x_max) = (lt.x.min(rb.x), lt.x.max(rb.x));
        let (y_min, y_max) = (lt.y.min(rb.y), lt.y.max(rb.y));
        Some((
            self.x + x_min,
            self.x + x_max,
            self.y + y_min,
            self.y + y_max,
        ))
    }
}

impl WaterRect {
    pub(super) fn valid(&self, bounds: &Bounds) -> bool {
        [self.x_min, self.x_max, self.y_min, self.y_max]
            .iter()
            .all(|value| value.is_finite())
            && self.x_min < self.x_max
            && self.y_min < self.y_max
            && self.x_min >= bounds.x_min
            && self.x_max <= bounds.x_max
            && self.y_min >= bounds.y_min
            && self.y_max <= bounds.y_max
            && (self.floor.is_empty()
                || (self.floor.len() >= 2
                    && self.floor.first().is_some_and(|p| p.x == self.x_min)
                    && self.floor.last().is_some_and(|p| p.x == self.x_max)
                    && self.floor.iter().all(|p| {
                        p.x.is_finite() && p.y.is_finite() && p.y >= self.y_min && p.y <= self.y_max
                    })
                    && self.floor.windows(2).all(|p| p[0].x < p[1].x)))
    }

    pub(super) fn floor_at(&self, x: f64) -> f64 {
        self.floor
            .windows(2)
            .find(|p| x >= p[0].x && x <= p[1].x)
            .map(|p| p[0].y + (p[1].y - p[0].y) * (x - p[0].x) / (p[1].x - p[0].x))
            .unwrap_or(self.y_max)
    }

    pub(super) fn contains_x(&self, x: f64) -> bool {
        x >= self.x_min - 0.001 && x <= self.x_max + 0.001
    }

    pub(super) fn contains(&self, x: f64, y: f64) -> bool {
        self.contains_x(x) && y >= self.y_min - 0.001 && y <= self.y_max + 0.001
    }
}

impl Map {
    pub fn load(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let mut map: Self = serde_json::from_str(&std::fs::read_to_string(path)?)?;
        map.validate()
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
        map.footholds.sort_by_key(|foothold| foothold.id);
        Ok(map)
    }

    pub(super) fn validate(&self) -> Result<(), String> {
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
            || map.water.iter().any(|water| !water.valid(b))
            || map.portals.iter().any(|portal| {
                portal.name.is_empty()
                    || ![portal.x, portal.y].iter().all(|x| x.is_finite())
                    || portal.target_map_id.as_deref().is_some_and(str::is_empty)
                    || portal
                        .target_portal_name
                        .as_deref()
                        .is_some_and(str::is_empty)
            })
            || map.reactors.iter().any(|reactor| {
                reactor.id.is_empty()
                    || reactor.template_id.is_empty()
                    || ![reactor.x, reactor.y].iter().all(|value| value.is_finite())
                    || reactor.state_count == 0
                    || !(b.x_min..=b.x_max).contains(&reactor.x)
                    || !(b.y_min..=b.y_max).contains(&reactor.y)
            })
        {
            return Err("invalid map bounds/spawn/footholds/ladders/portals/reactors".into());
        }
        Ok(())
    }

    pub(super) fn get(&self, id: u64) -> Option<&Foothold> {
        self.footholds.iter().find(|f| f.id == id)
    }

    pub(super) fn ground_below(&self, x: f64, y: f64) -> Option<(u64, f64)> {
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
    pub(super) fn fall_boundary(&self) -> f64 {
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
    pub(super) fn landing_on_sweep(
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

    pub(super) fn ground_near(&self, x: f64, y: f64) -> Option<(u64, f64)> {
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
    pub(super) fn ladder_top_ground(&self, ladder: &Ladder) -> Option<(u64, f64)> {
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
    pub(super) fn outer_wall(&self, left: bool) -> f64 {
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

    pub(super) fn downjump_target(&self, current_id: u64, x: f64) -> Option<(u64, f64)> {
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
    pub(super) fn wall_for(&self, current_id: u64, left: bool, foot_y: f64) -> f64 {
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
    /// Zero-length-step form of `chain_wall_on_sweep`, kept for the geometry
    /// tests that assert the chain resolution directly.  Production movement
    /// always goes through `chain_wall_on_sweep` so the overlap is evaluated at
    /// the contact fraction rather than at a tick boundary.
    #[cfg(test)]
    pub(super) fn chain_wall_for(&self, current_id: u64, left: bool, foot_y: f64) -> Option<f64> {
        self.chain_wall_on_sweep(current_id, left, 0.0, 0.0, foot_y, foot_y)
    }

    /// `chain_wall_for` for a movement step from `(from_x, from_y)` to
    /// `(to_x, to_y)`.  The vertical overlap is evaluated where the body
    /// actually reaches each candidate wall plane, not at the tick boundary.
    ///
    /// A body falling fast can drop past a wall's top inside one tick: at the
    /// tick start it is above the wall, at the tick end it has already crossed
    /// the plane, and testing either endpoint alone tunnels through.  A rising
    /// body that clears the top *before* the plane must still pass, so the
    /// check is made at the contact fraction `t = (wall_x - from_x) / dx`.
    pub(super) fn chain_wall_on_sweep(
        &self,
        current_id: u64,
        left: bool,
        from_x: f64,
        to_x: f64,
        from_y: f64,
        to_y: f64,
    ) -> Option<f64> {
        let current = self.get(current_id)?;
        let mut id = if left { current.prev } else { current.next };
        let mut edge = if left {
            current.left()
        } else {
            current.right()
        };
        let dx = to_x - from_x;
        for _ in 0..2 {
            let Some(candidate) = self.get(id) else { break };
            let t = if dx.abs() <= 0.001 {
                0.0
            } else {
                ((edge - from_x) / dx).clamp(0.0, 1.0)
            };
            if candidate.blocks_at_crossing(from_y, to_y, t) {
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
    pub(super) fn contiguous_neighbor(&self, current_id: u64, direction: i8) -> Option<&Foothold> {
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

    pub(super) fn ladder_for(&self, x: f64, y: f64, upwards: bool) -> Option<&Ladder> {
        self.ladders
            .iter()
            .find(|ladder| ladder.accepts(x, y, upwards))
    }

    pub(super) fn water_at(&self, x: f64, y: f64) -> Option<&WaterRect> {
        self.water.iter().find(|water| water.contains(x, y))
    }

    pub(super) fn water_entry(&self, from_x: f64, to_x: f64, from_y: f64, to_y: f64) -> Option<(f64, f64)> {
        const EPSILON: f64 = 0.001;
        if to_y < from_y - EPSILON {
            return None;
        }
        self.water.iter().find_map(|water| {
            if from_y < water.y_min - EPSILON && to_y >= water.y_min - EPSILON {
                let denominator = to_y - from_y;
                let t = if denominator.abs() <= EPSILON {
                    0.0
                } else {
                    ((water.y_min - from_y) / denominator).clamp(0.0, 1.0)
                };
                let x = from_x + (to_x - from_x) * t;
                return water
                    .contains_x(x)
                    .then_some((x.clamp(water.x_min, water.x_max), water.y_min));
            }
            if from_y >= water.y_min - EPSILON
                && from_y <= water.y_max + EPSILON
                && (from_x.min(to_x) <= water.x_max + EPSILON)
                && (from_x.max(to_x) >= water.x_min - EPSILON)
            {
                let x = if water.contains_x(to_x) {
                    to_x
                } else {
                    to_x.clamp(water.x_min, water.x_max)
                };
                return Some((x, from_y.clamp(water.y_min, water.floor_at(x))));
            }
            None
        })
    }

    pub(super) fn water_below(&self, current_id: u64, x: f64) -> bool {
        let Some(current_ground) = self
            .get(current_id)
            .filter(|foothold| foothold.forbid_fall_down == 0)
            .and_then(|foothold| foothold.at(x))
        else {
            return false;
        };
        self.water.iter().any(|water| {
            water.contains_x(x)
                && water.y_min > current_ground + 0.001
                && water.y_min - current_ground < DOWNJUMP_RANGE
        })
    }

    /// P: user-authorized drop floating (not original TMS273 rule). If a drop
    /// anchor falls inside a water zone (same x span and at or below the
    /// surface), pin it `DROP_WATER_DRAFT` below the surface so a swimming
    /// player can pick it up. Surface is `y_min` (y grows downward), so the
    /// floated y is `y_min + DROP_WATER_DRAFT`. The result is clamped to the
    /// water's surface..floor span so it never floats onto land or punches
    /// through the floor. Idempotent: re-applying to an already-floated y is a
    /// no-op.
    pub(super) fn water_float_y(&self, x: f64, y: f64) -> f64 {
        for water in &self.water {
            if water.contains_x(x) && y >= water.y_min {
                let floated = (water.y_min + DROP_WATER_DRAFT)
                    .max(water.y_min)
                    .min(water.floor_at(x));
                return floated;
            }
        }
        y
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ramp() -> Foothold {
        Foothold {
            id: 1,
            x1: 0.0,
            y1: 100.0,
            x2: 100.0,
            y2: 0.0,
            prev: 0,
            next: 0,
            forbid_fall_down: 0,
        }
    }

    fn wall(x: f64) -> Foothold {
        Foothold { id: 2, x1: x, y1: -50.0, x2: x, y2: 40.0, prev: 0, next: 0, forbid_fall_down: 0 }
    }

    #[test]
    fn foothold_interpolates_inside_and_rejects_outside() {
        let fh = ramp();
        assert_eq!(fh.left(), 0.0);
        assert_eq!(fh.right(), 100.0);
        assert_eq!(fh.top(), 0.0);
        assert_eq!(fh.bottom(), 100.0);
        // 线性插值：中点地面高度 = 50。
        assert!((fh.at(50.0).unwrap() - 50.0).abs() < 1e-9);
        assert!((fh.at(25.0).unwrap() - 75.0).abs() < 1e-9);
        assert_eq!(fh.at(-0.5), None, "左边界外不落点");
        assert_eq!(fh.at(100.5), None, "右边界外不落点");
        // 墙（x1==x2）没有可站立插值。
        assert_eq!(wall(20.0).at(20.0), None);
        assert!(wall(20.0).is_wall());
    }

    #[test]
    fn wall_blocks_at_contact_time_not_endpoints() {
        let wall = wall(10.0);
        // 身体高度 50：脚 y=30 时头顶 y=-20，身体与墙（-50..40）相交 → 阻挡。
        assert!(wall.blocks(30.0 - BODY_HEIGHT_PX, 30.0 - 1.0));
        // 跳过墙顶：脚 y=-60 时身体整体 (-110,-61) 高于墙顶 -50 → 放行；
        // 脚 y=-20 时身体 (-70,-21) 仍与墙重叠 → 阻挡。
        assert!(!wall.blocks(-60.0 - BODY_HEIGHT_PX, -60.0 - 1.0));
        assert!(wall.blocks(-20.0 - BODY_HEIGHT_PX, -20.0 - 1.0));
        // 穿越时刻判定：t=0.5 处脚 y=30（从 10 落到 50）→ 在接触时刻阻挡；
        // 两端点都高于墙顶也不能让穿越中的身体穿过（防隧穿）。
        assert!(wall.blocks_at_crossing(10.0, 50.0, 0.5));
        // 上升途中在接触时刻身体已整体越过墙顶（脚 -30→-70 中点 -50，
        // 身体 -101..-51 高于墙顶）→ 合法跳越，不阻挡。
        assert!(!wall.blocks_at_crossing(-30.0, -70.0, 0.5));
    }

    #[test]
    fn ladder_accepts_only_within_column_and_probe_window() {
        let ladder = Ladder { id: 3, x: 100.0, y1: 0.0, y2: 200.0, l: 1, uf: 1 };
        assert_eq!(ladder.action(), "ladder");
        let rope = Ladder { l: 0, ..ladder.clone() };
        assert_eq!(rope.action(), "rope");
        // 顶端离开受 uf 控制。
        assert!(ladder.allows_top_exit());
        assert!(!Ladder { uf: 0, ..ladder.clone() }.allows_top_exit());
        // 上爬探测点在脚下 5px：y=10 向上 → 探测 y=5，在 0..200 窗口内。
        assert!(ladder.accepts(100.0, 10.0, true));
        // 探测点越过顶端 → 不接受。
        assert!(!ladder.accepts(100.0, 4.0, true));
        // x 容差 10：±10 内接受，±11 拒绝。
        assert!(ladder.accepts(110.0, 100.0, false));
        assert!(!ladder.accepts(111.0, 100.0, false));
        // 下爬探测点在脚下 5px 之外同理。
        assert!(ladder.accepts(100.0, 195.0, false));
        assert!(!ladder.accepts(100.0, 200.0, false));
    }

    #[test]
    fn water_floor_interpolates_and_validates() {
        let bounds = Bounds { x_min: 0.0, y_min: 0.0, x_max: 500.0, y_max: 500.0 };
        let water = WaterRect {
            x_min: 100.0,
            x_max: 200.0,
            y_min: 300.0,
            y_max: 400.0,
            floor: vec![Point { x: 100.0, y: 380.0 }, Point { x: 200.0, y: 340.0 }],
        };
        assert!(water.valid(&bounds));
        // 分段线性插值：中点 360。
        assert!((water.floor_at(150.0) - 360.0).abs() < 1e-9);
        // floor 未覆盖的 x（理论上不会发生）回退水面下界。
        assert_eq!(water.floor_at(250.0), 400.0);
        assert!(water.contains(150.0, 350.0));
        assert!(!water.contains(250.0, 350.0));
        // floor 端点必须贴齐矩形左右边缘。
        let detached = WaterRect { floor: vec![Point { x: 110.0, y: 380.0 }, Point { x: 200.0, y: 340.0 }], ..water.clone() };
        assert!(!detached.valid(&bounds));
        // 水域必须完全落在地图边界内。
        let outside = WaterRect { x_max: 600.0, ..water };
        assert!(!outside.valid(&bounds));
    }

    #[test]
    fn reactor_hit_bounds_normalize_lt_rb_and_translate() {
        let placement = ReactorPlacement {
            id: "r".into(),
            template_id: "t".into(),
            x: 100.0,
            y: 50.0,
            flip: false,
            reactor_time: 0,
            state_count: 3,
            hit_type: 9,
            hitbox_lt: Some(Point { x: -30.0, y: -40.0 }),
            hitbox_rb: Some(Point { x: 20.0, y: 10.0 }),
            drop_table: None,
        };
        assert!(placement.area_triggered());
        assert!(placement.interactable_at(0));
        assert!(placement.interactable_at(1));
        assert!(!placement.interactable_at(2), "最后一个状态是耗尽形态");
        assert_eq!(placement.hit_bounds(), Some((70.0, 120.0, 10.0, 60.0)));
        // 未书写 hitbox 的反应物回退攻击判定。
        let plain = ReactorPlacement { hitbox_lt: None, hitbox_rb: None, ..placement };
        assert_eq!(plain.hit_bounds(), None);
    }
}
