//! P: the bridge's ongoing food route. One cart, two bounded stores, no rewards
//! for being online. The first delivery remains a separate historical fact.
use serde::{Deserialize, Serialize};

const STEP_MS: i64 = 5_000;
const OFFLINE_LIMIT_MS: i64 = 3_600_000;
const CAPACITY: u32 = 12;
const LOAD: u32 = 4;
const TRAVEL_STEPS: u32 = 3;

/// One unit of heat first removes one unit of moisture; only dry fuel burns.
/// The hearth stops at dry paper, while the island's dry branches ignite.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(super) struct Material {
    pub moisture: u8,
    pub fuel: u8,
}
impl Material {
    pub fn heat(&mut self) -> bool {
        if self.moisture > 0 {
            self.moisture -= 1;
            false
        } else if self.fuel > 0 {
            self.fuel -= 1;
            true
        } else {
            false
        }
    }
}
fn wet_paper() -> Material {
    Material {
        moisture: 3,
        fuel: 1,
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum RoutePhase {
    Loading,
    Outbound,
    Resting,
    Returning,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct WindbellLife {
    pub source: u32,
    pub shelter: u32,
    pub cargo: u32,
    pub phase: RoutePhase,
    pub deliveries: u64,
    pub harvested: u64,
    pub consumed: u64,
    #[serde(default = "wet_paper")]
    pub paper: Material,
    last_ms: i64,
    steps: u64,
    remaining: u32,
}

impl WindbellLife {
    pub fn new(now_ms: i64) -> Self {
        Self {
            source: 8,
            shelter: 4, // Contents of the already-arrived first shipment.
            cargo: 0,
            phase: RoutePhase::Resting,
            deliveries: 1,
            harvested: 0,
            consumed: 0,
            paper: wet_paper(),
            last_ms: now_ms,
            steps: 0,
            remaining: 4,
        }
    }

    pub fn validate(&self) -> bool {
        self.source <= CAPACITY
            && self.paper.moisture <= 3
            && self.paper.fuel == 1
            && self.shelter <= CAPACITY
            && self.cargo <= LOAD
            && self.remaining <= 4
            && self.deliveries > 0
            && self.steps <= i64::MAX as u64
            && self.harvested <= self.steps / 4
            && self.deliveries <= self.steps.saturating_add(1)
            && self.last_ms >= 0
            && (self.phase == RoutePhase::Outbound || self.cargo == 0)
            && u128::from(self.source + self.shelter + self.cargo) + u128::from(self.consumed)
                == 12 + u128::from(self.harvested)
    }

    /// No players are needed. At most 720 small steps per wake; after a long
    /// shutdown residents rest beyond the first hour, with stocks/cargo kept.
    /// No wall-clock rollback, refreshed travel duration or duplicate harvest.
    pub fn advance(&mut self, now_ms: i64, archive_safe: bool) -> bool {
        let elapsed = now_ms.saturating_sub(self.last_ms);
        if elapsed < STEP_MS {
            return false;
        }
        let count = elapsed.min(OFFLINE_LIMIT_MS) / STEP_MS;
        for _ in 0..count {
            self.steps += 1;
            if self.steps % 4 == 0 && self.source < CAPACITY {
                self.source += 1;
                self.harvested += 1;
            }
            if self.steps % 6 == 0 {
                // One supply bundle supports the residents' meal and hearth.
                if archive_safe && self.paper.moisture > 0 {
                    self.dry_paper();
                } else {
                    self.consume();
                }
            }
            self.remaining = self.remaining.saturating_sub(1);
            if self.remaining != 0 {
                continue;
            }
            match self.phase {
                RoutePhase::Loading => {
                    let load = self.source.min(LOAD).min(CAPACITY - self.shelter);
                    if load > 0 {
                        self.source -= load;
                        self.cargo = load;
                        self.phase = RoutePhase::Outbound;
                        self.remaining = TRAVEL_STEPS;
                    }
                }
                RoutePhase::Outbound => {
                    self.shelter += self.cargo;
                    self.cargo = 0;
                    self.deliveries += 1;
                    self.phase = RoutePhase::Resting;
                    self.remaining = 4;
                }
                RoutePhase::Resting => {
                    self.phase = RoutePhase::Returning;
                    self.remaining = TRAVEL_STEPS;
                }
                RoutePhase::Returning => {
                    self.phase = RoutePhase::Loading;
                    self.remaining = 2;
                }
            }
        }
        self.last_ms = now_ms - elapsed % STEP_MS;
        debug_assert!(self.validate());
        true
    }

    pub fn consume(&mut self) -> bool {
        if self.shelter == 0 {
            return false;
        }
        self.shelter -= 1;
        self.consumed += 1;
        true
    }

    pub fn dry_paper(&mut self) -> bool {
        if self.paper.moisture == 0 || !self.consume() {
            return false;
        }
        self.paper.heat();
        true
    }

    /// Position is a projection of the committed journey, never a second
    /// persisted position or a client-authored arrival. Endpoints stay on land.
    pub fn cart_x(&self, now_ms: i64, source_x: f64, shelter_x: f64) -> f64 {
        let fraction =
            (now_ms.saturating_sub(self.last_ms) as f64 / STEP_MS as f64).clamp(0.0, 1.0);
        let progress =
            ((TRAVEL_STEPS.saturating_sub(self.remaining)) as f64 + fraction) / TRAVEL_STEPS as f64;
        match self.phase {
            RoutePhase::Loading => source_x,
            RoutePhase::Resting => shelter_x,
            RoutePhase::Outbound => source_x + (shelter_x - source_x) * progress,
            RoutePhase::Returning => shelter_x + (source_x - shelter_x) * progress,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windbell_heat_has_the_same_material_order_for_branches_and_paper() {
        let mut branch = Material {
            moisture: 0,
            fuel: 1,
        };
        assert!(branch.heat());
        assert!(!branch.heat());
        let mut paper = wet_paper();
        for _ in 0..3 {
            assert!(!paper.heat());
        }
        assert_eq!(
            paper,
            Material {
                moisture: 0,
                fuel: 1
            }
        );
        assert!(paper.heat(), "uncontrolled heat would burn dry paper too");
        let mut life = WindbellLife::new(0);
        life.advance(90_000, true);
        assert_eq!(life.paper.moisture, 0, "the keeper works without a player");
        let stocks = life.clone();
        assert!(
            !life.dry_paper(),
            "the hearth stops before burning the record"
        );
        assert_eq!(life, stocks);
    }

    #[test]
    fn windbell_life_conserves_food_and_continues_after_first_delivery() {
        let mut state = WindbellLife::new(100_000);
        for step in 1..=720 {
            state.advance(100_000 + step * STEP_MS, true);
            if step % 11 == 0 {
                state.consume();
            }
            assert!(state.validate());
        }
        assert!(state.deliveries > 2);
        assert!(state.harvested > 0 && state.consumed > 0);
        let saved = state.clone();
        assert!(!state.advance(100_000, true));
        assert_eq!(state, saved);
    }

    #[test]
    fn windbell_life_resume_matches_online_steps_and_bounds_long_absence() {
        let start = 100_000;
        let mut online = WindbellLife::new(start);
        for step in 1..=720 {
            online.advance(start + step * STEP_MS, true);
        }
        let json = serde_json::to_string(&WindbellLife::new(start)).unwrap();
        let mut restored: WindbellLife = serde_json::from_str(&json).unwrap();
        restored.advance(start + OFFLINE_LIMIT_MS, true);
        assert_eq!(restored, online);
        let mut long = WindbellLife::new(start);
        long.advance(start + OFFLINE_LIMIT_MS * 1_000, true);
        assert_eq!(long.steps, 720);
        assert_eq!(
            (long.source, long.shelter, long.cargo),
            (online.source, online.shelter, online.cargo)
        );
        assert!(!long.advance(start + OFFLINE_LIMIT_MS * 1_000, true));
        assert!(long.validate());
    }

    #[test]
    fn windbell_life_empty_pantry_recovers_without_refresh_or_player() {
        let mut state = WindbellLife::new(0);
        for _ in 0..4 {
            assert!(state.consume());
        }
        assert!(!state.consume());
        let consumed = state.consumed;
        state.advance(120_000, true);
        assert!(state.shelter > 0);
        assert!(state.consumed >= consumed);
        assert!(state.validate());
        state.source += 1;
        assert!(
            !state.validate(),
            "corrupt persisted stock must not be accepted"
        );
    }
}
