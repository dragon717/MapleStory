//! 现金宠物的轻量移动模拟。
//!
//! 这是宠物的纯状态层：世界模块负责把它接到宠物实例与快照，地图几何仍由
//! `geometry.rs` 统一判定。速度字段沿用客户端面板单位；`100` 面板速度对应
//! 世界中的 `WALK_SPEED`（125 px/s）。

use super::*;

const PET_OWNER_TELEPORT_DISTANCE: f64 = 1_000.0;
const PET_STOP_DISTANCE: f64 = 8.0;
const PET_RETURN_DISTANCE: f64 = 120.0;
const PET_BODY_HEIGHT: f64 = 50.0;
const PET_SPEED_VARIATION: f64 = 0.12;
const PET_FOLLOW_GAP: f64 = 30.0;
const PET_LEAD_GAP: f64 = 44.0;
const PET_INDEX_GAP: f64 = 18.0;
const PET_JUMP_COOLDOWN_TICKS: u64 = 14;
const PET_STUCK_TICKS: u16 = 80;
const PET_RETURN_COOLDOWN_TICKS: u64 = 40;

/// One authoritative companion's movement state.
#[derive(Clone)]
pub(super) struct PetMotion {
    pub(super) x: f64,
    pub(super) y: f64,
    pub(super) facing: i8,
    pub(super) action: &'static str,
    /// Panel speed units.  This is deliberately independent from the owner.
    pub(super) base_speed: f64,
    /// Current panel speed units, with the small per-pet P variation applied;
    /// while seeking, this includes the requested two-times multiplier.
    pub(super) move_speed: f64,
    /// `idle`, `follow`, or `loot`, matching the PetState wire contract.
    pub(super) mode: &'static str,
    vy: f64,
    grounded: bool,
    foothold_id: u64,
    last_foothold_id: u64,
    ignored_foothold_id: u64,
    phase: f64,
    stuck_ticks: u16,
    returning: bool,
    return_until: u64,
    jump_again_tick: u64,
}

impl PetMotion {
    pub(super) fn new(x: f64, y: f64, facing: i8, base_speed: f64, seed: u64) -> Self {
        let base_speed = sane_speed(base_speed);
        Self {
            x: sane_coordinate(x),
            y: sane_coordinate(y),
            facing: normalize_facing(facing),
            action: "stand",
            base_speed,
            move_speed: base_speed,
            mode: "idle",
            vy: 0.0,
            grounded: false,
            foothold_id: 0,
            last_foothold_id: 0,
            ignored_foothold_id: 0,
            // P: Item/Pet has no independent TMS273 speed field in this
            // export.  The seed keeps up to three pets from sharing a phase.
            phase: seed_phase(seed),
            stuck_ticks: 0,
            returning: false,
            return_until: 0,
            jump_again_tick: 0,
        }
    }

    pub(super) fn reset(&mut self, x: f64, y: f64, facing: i8) {
        self.x = sane_coordinate(x);
        self.y = sane_coordinate(y);
        self.facing = normalize_facing(facing);
        self.action = "stand";
        self.move_speed = self.base_speed;
        self.mode = "idle";
        self.vy = 0.0;
        self.grounded = false;
        self.foothold_id = 0;
        self.last_foothold_id = 0;
        self.ignored_foothold_id = 0;
        self.stuck_ticks = 0;
        self.returning = false;
        self.return_until = 0;
        self.jump_again_tick = 0;
    }

    pub(super) fn step(
        &mut self,
        map: &Map,
        owner_x: f64,
        owner_y: f64,
        owner_facing: i8,
        owner_moving: bool,
        lead: bool,
        index: usize,
        target: Option<(f64, f64)>,
        tick: u64,
    ) {
        let owner_x = sane_coordinate(owner_x);
        let owner_y = sane_coordinate(owner_y);
        let owner_facing = normalize_facing(owner_facing);

        let normal_speed = self.current_speed(tick, index);
        let owner_dx = owner_x - self.x;
        let owner_dy = owner_y - self.y;
        if owner_dx * owner_dx + owner_dy * owner_dy
            > PET_OWNER_TELEPORT_DISTANCE * PET_OWNER_TELEPORT_DISTANCE
        {
            // P: the requested 1000-world-unit leash is a bounded recovery
            // rule, not an authored TMS273 teleport distance.
            self.reset(owner_x, owner_y, owner_facing);
            self.mode = "follow";
            return;
        }

        if self.returning {
            let close_enough = owner_dx * owner_dx + owner_dy * owner_dy
                <= PET_RETURN_DISTANCE * PET_RETURN_DISTANCE;
            // P: keep the owner-recovery state for 2 seconds even when the
            // pet reaches the owner immediately; this prevents a target on
            // the same wall from being retried on the very next tick.
            if close_enough && tick >= self.return_until {
                self.returning = false;
            }
        }

        let target = target.filter(|(x, y)| x.is_finite() && y.is_finite());
        let seeking = target.is_some() && !self.returning;
        let (goal_x, goal_y, goal_mode) = if seeking {
            let (x, y) = target.expect("target checked above");
            (x, y, "loot")
        } else {
            let side = f64::from(owner_facing);
            let gap = if lead {
                PET_LEAD_GAP + index as f64 * PET_INDEX_GAP
            } else {
                PET_FOLLOW_GAP + index as f64 * PET_INDEX_GAP
            };
            let goal_x = if lead {
                owner_x + side * gap
            } else {
                owner_x - side * gap
            };
            (goal_x, owner_y, "follow")
        };

        self.settle_on_nearby_ground(map);
        let wanted_dx = goal_x - self.x;
        let before_x = self.x;
        let before_y = self.y;

        // A pet jumps only when its destination is visibly higher or a
        // grounded edge has blocked it for a few ticks.  It never copies the
        // owner's y coordinate; gravity and authored footholds decide where
        // it lands.
        let wants_jump = self.grounded
            && tick >= self.jump_again_tick
            && (goal_y < self.y - PET_BODY_HEIGHT * 0.45
                || (self.stuck_ticks >= 8 && wanted_dx.abs() > PET_STOP_DISTANCE));
        if wants_jump {
            self.grounded = false;
            self.foothold_id = 0;
            self.ignored_foothold_id = 0;
            self.vy = -JUMP_SPEED;
            self.jump_again_tick = tick.saturating_add(PET_JUMP_COOLDOWN_TICKS);
        }

        let dt = TICK_MS as f64 / 1_000.0;
        let wants_horizontal = wanted_dx.abs() > PET_STOP_DISTANCE;
        if wants_horizontal {
            self.facing = if wanted_dx < 0.0 { -1 } else { 1 };
        }
        let speed_multiplier = if seeking { 2.0 } else { 1.0 };
        self.move_speed = normal_speed * speed_multiplier;
        let world_speed = self.move_speed * (WALK_SPEED / 100.0);
        let horizontal_step = (world_speed * dt).min(wanted_dx.abs());
        let intended_x = if wants_horizontal {
            self.x + wanted_dx.signum() * horizontal_step
        } else {
            self.x
        };

        let vertical_end = if self.grounded {
            self.y
        } else {
            let projected_vy = (self.vy + GRAVITY * dt).min(FALL_SPEED);
            self.y + projected_vy * dt
        };
        let anchor = if self.foothold_id != 0 {
            self.foothold_id
        } else {
            self.last_foothold_id
        };
        let mut blocked = false;
        let mut next_x = intended_x.clamp(map.bounds.x_min, map.bounds.x_max);
        if wants_horizontal && anchor != 0 {
            if let Some(wall) = map.chain_wall_on_sweep(
                anchor,
                wanted_dx < 0.0,
                self.x,
                next_x,
                self.y,
                vertical_end,
            ) {
                let crossed = if wanted_dx < 0.0 {
                    self.x >= wall && next_x <= wall
                } else {
                    self.x <= wall && next_x >= wall
                };
                if crossed {
                    next_x = wall;
                    blocked = true;
                }
            }
        }

        let was_grounded = self.grounded;
        let mut ignored = self.ignored_foothold_id;
        self.x = next_x;
        if was_grounded {
            self.advance_grounded(map, before_x, wanted_dx, &mut ignored);
        }
        self.ignored_foothold_id = ignored;

        if !self.grounded {
            self.advance_airborne(map, before_x, before_y, tick, dt);
            if self.y > map.fall_boundary() {
                // P: falling past the authored map boundary is a bounded
                // return-to-owner escape hatch; no general pathfinder is
                // introduced for the three-pet MVP.
                self.reset(owner_x, owner_y, owner_facing);
                self.mode = "follow";
                return;
            }
        }

        let moved_x = (self.x - before_x).abs();
        if wants_horizontal && moved_x < 0.01 {
            self.stuck_ticks = self.stuck_ticks.saturating_add(1);
        } else if moved_x > 0.25 || !wants_horizontal {
            self.stuck_ticks = 0;
        }
        if self.stuck_ticks >= PET_STUCK_TICKS {
            // P: four seconds of no horizontal progress switches to owner
            // recovery.  This is deliberately a small local heuristic.
            self.returning = true;
            self.return_until = tick.saturating_add(PET_RETURN_COOLDOWN_TICKS);
            self.stuck_ticks = 0;
        }

        self.mode = if self.returning {
            "follow"
        } else if goal_mode == "follow" && !owner_moving && wanted_dx.abs() <= PET_STOP_DISTANCE {
            "idle"
        } else {
            goal_mode
        };
        if !self.grounded {
            self.action = "jump";
        } else if moved_x > 0.01 || blocked && wants_horizontal {
            self.action = "move";
        } else {
            self.action = "stand";
        }
    }

    fn current_speed(&self, tick: u64, index: usize) -> f64 {
        let wobble = (self.phase + tick as f64 * 0.04 + index as f64 * 0.73).sin();
        (self.base_speed * (1.0 + wobble * PET_SPEED_VARIATION)).max(1.0)
    }

    fn settle_on_nearby_ground(&mut self, map: &Map) {
        if self.grounded {
            if map.get(self.foothold_id).is_none() {
                self.grounded = false;
                self.foothold_id = 0;
            }
            return;
        }
        if self.vy.abs() > 0.001 {
            return;
        }
        let Some((foothold_id, ground)) = map.ground_near(self.x, self.y) else {
            return;
        };
        if (ground - self.y).abs() <= 8.0 {
            self.y = ground;
            self.vy = 0.0;
            self.grounded = true;
            self.foothold_id = foothold_id;
            self.last_foothold_id = foothold_id;
            self.ignored_foothold_id = 0;
        }
    }

    fn advance_grounded(&mut self, map: &Map, old_x: f64, direction: f64, ignored: &mut u64) {
        let Some(current) = map.get(self.foothold_id) else {
            self.grounded = false;
            self.foothold_id = 0;
            return;
        };
        if let Some(ground) = current.at(self.x) {
            self.y = ground;
            return;
        }

        let next_id = if self.x > current.right() {
            current.next
        } else if self.x < current.left() {
            current.prev
        } else {
            0
        };
        let Some(next) = map.get(next_id) else {
            self.grounded = false;
            *ignored = current.id;
            self.foothold_id = 0;
            self.vy = 0.0;
            return;
        };
        let travel_direction = if direction >= 0.0 { 1 } else { -1 };
        let continuous = map
            .contiguous_neighbor(current.id, travel_direction)
            .is_some_and(|neighbor| neighbor.id == next.id);
        if continuous {
            if let Some(ground) = next.at(self.x) {
                self.foothold_id = next.id;
                self.last_foothold_id = next.id;
                self.y = ground;
                return;
            }
        }
        // The edge is a gap or a raised platform.  Let the vertical sweep
        // decide the next authored landing instead of snapping across it.
        self.grounded = false;
        *ignored = current.id;
        self.foothold_id = 0;
        self.last_foothold_id = current.id;
        self.vy = 0.0;
        let _ = old_x;
    }

    fn advance_airborne(&mut self, map: &Map, old_x: f64, old_y: f64, _tick: u64, dt: f64) {
        let next_vy = (self.vy + GRAVITY * dt).min(FALL_SPEED);
        let next_y = self.y + next_vy * dt;
        if next_vy >= 0.0 {
            if let Some((foothold_id, landing_x, ground)) =
                map.landing_on_sweep(old_x, self.x, old_y, next_y, self.ignored_foothold_id)
            {
                self.x = landing_x;
                self.y = ground;
                self.vy = 0.0;
                self.grounded = true;
                self.foothold_id = foothold_id;
                self.last_foothold_id = foothold_id;
                self.ignored_foothold_id = 0;
                return;
            }
        }
        self.vy = next_vy;
        self.y = next_y.clamp(map.bounds.y_min, map.fall_boundary() + 1.0);
    }
}

fn normalize_facing(facing: i8) -> i8 {
    if facing < 0 {
        -1
    } else {
        1
    }
}

fn sane_coordinate(value: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        0.0
    }
}

fn sane_speed(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(1.0, 300.0)
    } else {
        100.0
    }
}

fn seed_phase(seed: u64) -> f64 {
    let mixed = seed.wrapping_add(0x9e37_79b9_7f4a_7c15).rotate_left(17) ^ 0xa076_1d64_78bd_642f;
    (mixed as f64 / u64::MAX as f64) * std::f64::consts::TAU
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat_map() -> Map {
        Map {
            id: "pet-test".to_owned(),
            bounds: Bounds {
                x_min: -500.0,
                x_max: 500.0,
                y_min: -500.0,
                y_max: 500.0,
            },
            spawn: Point { x: 0.0, y: 100.0 },
            footholds: vec![Foothold {
                id: 1,
                x1: -500.0,
                y1: 100.0,
                x2: 500.0,
                y2: 100.0,
                prev: 0,
                next: 0,
                forbid_fall_down: 0,
            }],
            ladders: Vec::new(),
            portals: Vec::new(),
            water: Vec::new(),
            reactors: Vec::new(),
        }
    }

    #[test]
    fn lands_without_copying_owner_y_and_recalls_when_far() {
        let map = flat_map();
        let mut pet = PetMotion::new(0.0, 0.0, 1, 150.0, 7);
        pet.step(&map, 0.0, 20.0, 1, false, false, 0, None, 0);
        assert!(
            (pet.y - 20.0).abs() > 1.0,
            "physics must own y on the first tick"
        );
        for tick in 1..20 {
            pet.step(&map, 0.0, 100.0, 1, false, false, 0, None, tick);
        }
        assert!((pet.y - 100.0).abs() < 0.01);
        assert!((pet.y - 20.0).abs() > 1.0);

        pet.step(&map, 1_200.0, 20.0, -1, false, false, 0, None, 20);
        assert_eq!(pet.x, 1_200.0);
        assert_eq!(pet.y, 20.0);
        assert_eq!(pet.facing, -1);
    }

    #[test]
    fn seeded_speed_varies_and_loot_uses_two_times_current_speed() {
        let map = flat_map();
        let mut follow = PetMotion::new(0.0, 100.0, 1, 150.0, 7);
        let mut loot = follow.clone();
        follow.step(&map, 200.0, 100.0, 1, true, false, 0, None, 10);
        loot.step(
            &map,
            200.0,
            100.0,
            1,
            true,
            false,
            0,
            Some((200.0, 100.0)),
            10,
        );
        assert_eq!(follow.facing, 1);
        assert_eq!(loot.facing, 1);
        assert!((loot.move_speed - follow.move_speed * 2.0).abs() < 1e-9);
        assert!((loot.x - follow.x * 2.0).abs() < 1e-9);

        let mut left = PetMotion::new(200.0, 100.0, 1, 150.0, 7);
        left.step(&map, 0.0, 100.0, -1, true, false, 0, None, 10);
        assert_eq!(left.facing, -1);

        let first = loot.move_speed;
        loot.step(
            &map,
            200.0,
            100.0,
            1,
            true,
            false,
            0,
            Some((200.0, 100.0)),
            80,
        );
        assert!((loot.move_speed - first).abs() > 0.01);
    }
}
