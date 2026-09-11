use crate::{
    auth::{self, Identity, Profile, Store},
    combat::{Attack, Combat},
    inventory,
    mage::{MageLevel, MageSkills},
    npc::{self, DialogueContext, NpcSpawn, NpcTemplate, Shop},
    protocol::{
        reject, AbilityStat, AbilityStats, ClientMessage, DerivedStats, DropState, MonsterState,
        NpcState, PlayerState, RegenerationPassive, StorageState, StorageTransferOperation,
    },
};
use rand::Rng;
use serde::{de::Error as DeError, Deserialize};
use std::{
    collections::{hash_map::DefaultHasher, BTreeMap, BTreeSet, VecDeque},
    hash::{Hash, Hasher},
    path::Path,
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, mpsc::error::TrySendError, oneshot};

#[path = "boss.rs"]
mod boss;

pub const TICK_MS: u64 = 50;
const NATURAL_RECOVERY_INTERVAL_TICKS: u64 = 1_000 / TICK_MS;
/// Map-chat rate limit (per character): burst of 5 with a 1 token/second
/// refill.  Chat_ops plan §10.3 defaults; a sender cannot re-establish the
/// allowance by switching maps or reconnecting because the bucket lives on
/// the authoritative Player row.
const CHAT_TOKEN_BURST: u32 = 5;
const CHAT_TOKEN_REFILL_PER_SEC: u32 = 1;
/// Per-session chat request-id idempotency window (bounded; §9.1 ephemeral).
const CHAT_RECENT_WINDOW: usize = 64;

/// How many characters one party can hold.
/// P: the TMS273 export carries no party-size field, so the cap follows the
/// original party size the rest of these rules are written against.
const PARTY_MAX_MEMBERS: usize = 6;
/// Per-character bounded request-id idempotency window for party intents, so
/// a network retry cannot send a second invitation or kick twice.
const PARTY_REQUEST_WINDOW: usize = 32;
/// Per-character bounded request-id idempotency window for friend intents.
/// The authoritative record for a friend edit lives in SQLite
/// (`friend_actions`), so this map only spares the common in-session retry a
/// second read; it is not what makes a replay safe.
const FRIEND_REQUEST_WINDOW: usize = 32;

/// Per-session whisper (密語) idempotency window, bounded like the chat one.
/// A whisper is ephemeral and has no durable record, so this window only
/// protects the common network retry; it is not what makes a replay safe.
const WHISPER_RECENT_WINDOW: usize = 32;

/// Per-session chat-emoticon idempotency window, bounded like the other two.
/// An emoticon is ephemeral and has no durable record, so this only protects
/// the common network retry from broadcasting the head animation twice.
const EMOTICON_RECENT_WINDOW: usize = 32;

/// Continuous-away policy: how long the authoritative character is kept with
/// its normal world rules before it drops to basic residency, and the hard
/// bound after which the normal exit path is requested.  Both are counted
/// from a single away start, not from each other.  The 600 s value is the
/// requested product behaviour; 3600 s is a first-version test bound and is
/// meant to be tuned.  Policy is snapshotted into each away window so a live
/// config change cannot silently shorten an in-flight grace period.
const AWAY_FULL_RETENTION: Duration = Duration::from_secs(600);
const AWAY_MAX_TOTAL: Duration = Duration::from_secs(3600);

const MAGE_ADVANCE_MAP_ID: &str = "001020000";
const BOSS_PRACTICE_FALLBACK_MAP_ID: &str = "102020500";
const MAGE_ADVANCE_NPC_ID: &str = "001020000-life-1";
const MAGE_ADVANCE_TEMPLATE_ID: &str = "10201";
const BEGINNER_JOB: u32 = 0;
const BEGINNER_BOOK: u32 = 0;
const MAGICIAN_JOB: u32 = 200;
const ALREADY_MAGICIAN_NODE: &str = "__already_magician__";
const MAGE_BOOK: u32 = 200;
const ICE_BOOK: u32 = 220;
const ICE_MAGE_JOB: u32 = 220;
const THIRD_BOOK: u32 = 221;
const ICE_THIRD_JOB: u32 = 221;
const FOURTH_BOOK: u32 = 222;
const ICE_FOURTH_JOB: u32 = 222;
const SKILL_MAGIC_BOOST: u32 = 2000006;
const SKILL_ELEMENTAL_WEAKEN: u32 = 2000007;
const SKILL_MAGIC_SHIELD: u32 = 2000010;
const SKILL_MAGIC_GUARD: u32 = 2001002;
const SKILL_ENERGY_BOLT: u32 = 2001008;
const SKILL_TELEPORT: u32 = 2001009;
const SKILL_MAGIC_WAVE: u32 = 2001011;
const SKILL_MAGIC_WAVE_HIDDEN: u32 = 2001012;
const SKILL_MANA_ABSORB: u32 = 2200000;
const SKILL_SPELL_MASTERY: u32 = 2200006;
const SKILL_INTELLIGENCE: u32 = 2200007;
const SKILL_MEDITATION: u32 = 2201001;
const SKILL_THUNDER_BOLT: u32 = 2201005;
const SKILL_COLD_BEAM: u32 = 2201008;
const SKILL_ICE_TELEPORT: u32 = 2201009;
const SKILL_ICE_EFFECT: u32 = 2200011;
const SKILL_BOOSTER: u32 = 2200012;
const SKILL_EXTREME_MAGIC: u32 = 2210000;
const SKILL_ELEMENT_AMP: u32 = 2210001;
const SKILL_MAGIC_CRITICAL: u32 = 2210009;
const SKILL_FROZEN_BREAK: u32 = 2210013;
const SKILL_ELEMENTAL_RESET: u32 = 2210016;
const SKILL_ICE_STORM: u32 = 2211002;
const SKILL_TELEPORT_MASTERY: u32 = 2211007;
const SKILL_THUNDER_SPHERE: u32 = 2211011;
const SKILL_ELEMENTAL_ADAPTING: u32 = 2211012;
const SKILL_GLACIAL_WALL: u32 = 2211014;
const SKILL_THUNDER_SPHERE_HIDDEN: u32 = 2211015;
const SKILL_TELEPORT_BOOST: u32 = 2211017;
const SKILL_MYSTIC_STRIKE: u32 = 2220010;
const SKILL_MASTER_MAGIC: u32 = 2220013;
const SKILL_FOURTH_FREEZE: u32 = 2220015;
const SKILL_MAPLE_WARRIOR: u32 = 2221000;
const SKILL_INFINITY: u32 = 2221004;
const SKILL_ICE_DEMON: u32 = 2221005;
const SKILL_CHAIN_LIGHTNING: u32 = 2221006;
const SKILL_BLIZZARD: u32 = 2221007;
const SKILL_MAPLE_CURE: u32 = 2221008;
const SKILL_ICE_DRAGON_BREATH: u32 = 2221011;
const SKILL_FROZEN_ORB: u32 = 2221012;
// Source-only follow-up hit for Blizzard's direct-hit passive.  It is kept out
// of the learnable catalog and can only be emitted by the authoritative hit
// path below.
const SKILL_BLIZZARD_HIDDEN: u32 = 2220014;
const SKILL_HYPER_TELEPORT_DAMAGE: u32 = 2220043;
const SKILL_HYPER_TELEPORT_TARGET: u32 = 2220044;
const SKILL_HYPER_TELEPORT_DISTANCE: u32 = 2221045;
const SKILL_HYPER_CHAIN_DAMAGE: u32 = 2220046;
const SKILL_HYPER_CHAIN_TARGET: u32 = 2220047;
const SKILL_HYPER_CHAIN_ATTACK: u32 = 2220048;
const SKILL_HYPER_ICE_DAMAGE: u32 = 2220049;
const SKILL_HYPER_ICE_TARGET: u32 = 2220050;
const SKILL_HYPER_ICE_CRIT: u32 = 2220051;
const SKILL_HYPER_THUNDER: u32 = 2221052;
const SKILL_HYPER_ADVENTURER: u32 = 2221053;
const SKILL_HYPER_VORTEX: u32 = 2221054;
const SKILL_HYPER_VORTEX_HIDDEN: u32 = 2221055;
const HYPER_PASSIVE_IDS: [u32; 9] = [
    SKILL_HYPER_TELEPORT_DAMAGE,
    SKILL_HYPER_TELEPORT_TARGET,
    SKILL_HYPER_TELEPORT_DISTANCE,
    SKILL_HYPER_CHAIN_DAMAGE,
    SKILL_HYPER_CHAIN_TARGET,
    SKILL_HYPER_CHAIN_ATTACK,
    SKILL_HYPER_ICE_DAMAGE,
    SKILL_HYPER_ICE_TARGET,
    SKILL_HYPER_ICE_CRIT,
];
const HYPER_ACTIVE_IDS: [u32; 3] = [
    SKILL_HYPER_THUNDER,
    SKILL_HYPER_ADVENTURER,
    SKILL_HYPER_VORTEX,
];
const SKILL_THREE_SNAILS: u32 = 1000;
const SKILL_RECOVERY: u32 = 1001;
const SKILL_NIMBLE_FEET: u32 = 1002;
const BEGINNER_SKILLS: [u32; 3] = [SKILL_THREE_SNAILS, SKILL_RECOVERY, SKILL_NIMBLE_FEET];
const BEGINNER_HEAL_TICK_MS: u64 = 5_000;
const BEGINNER_HEAL_TICKS: u32 = 6;
const BEGINNER_THROW_RANGE: f64 = 340.0;
const MAGE_TRANSFER_MIN_MP: i64 = 100;
const SKILL_CAST_DURATION_MS: u64 = 500;
const MAGE_TRAINING_NODE: &str = "__mage_training__";
const QUEST_MENU_NODE: &str = "__quest_menu__";
const QUEST_HIDDEN_NPC_1: &str = "1541000";
const QUEST_HIDDEN_NPC_2: &str = "1541001";
const QUEST_HIDDEN_NPC_3: &str = "1541002";
const QUEST_OLIVIA_NPC: &str = "1541003";
// P: the selected export exposes freeze duration but no authoritative stack
// ledger; cap five layers and change one layer per cast/target.
const ICE_FREEZE_STACK_CAP: u32 = 5;
const ICE_FREEZE_DURATION_MS: u64 = 8_000;
// P: quantize the authored subTime=1200 ms to this world's 50 ms tick.
const ICE_TELEPORT_FIELD_DEFAULT_SUB_TIME_MS: u64 = 1_200;
// Fallback map respawn cycle for spawns whose source mobTime is 0 (Cosmic
// semantics: "use the map's normal respawn cycle").  The TMS273 export keeps
// no map-level respawn interval, and the earlier assembled gameplay used
// 10000 ms; keep that cycle as the default so a dead mob always returns.
const DEFAULT_MONSTER_RESPAWN_MS: u64 = 10_000;
// ---- Monster abnormal-status skill system (怪物異常狀態) ----
// The `info/skill` list of a mob carries MobSkill ids, and the mapping from a
// MobSkill id to the player disease it inflicts is MapleDisease.getBySkill,
// the table every open MapleStory server carries (R reference, not TMS273 text):
//   120=Seal 121=Darkness 122=Weaken 123=Stun 124=Curse 125=Poison 126=Slow
//   128=Seduce 133=Zombify 134=Potion 137=Freeze.
// The same id space feeds `info/bodyDisease`, the contact-hit disease.  Only
// the subset this server models is wired below; anything else is ignored as an
// unknown source node rather than guessed into a different effect.
const MOB_SKILL_SEAL: u32 = 120;
const MOB_SKILL_STUN: u32 = 123;
const MOB_SKILL_CURSE: u32 = 124;
const MOB_SKILL_POISON: u32 = 125;
const MOB_SKILL_SLOW: u32 = 126;
/// Lower bound (ms) under which a source `time` reads as "instant" and is not
/// a disease duration (e.g. Seal time=3 is not a disease, it gates the cast).
const MOB_SKILL_MIN_DISEASE_MS: u64 = 1_000;
/// Stun locks movement but keeps the body airborne-legal; seal blocks skills;
/// slow scales the walk; poison/curse tick damage.  Each disease has its own
/// authoritative deadline so one source cannot overwrite an unrelated one.
const MOB_DISEASE_POISON_TICK_MS: u64 = 1_000;
/// Contact `bodyDisease` has no per-level duration in the export, so a fixed
/// base window (scaled by the authored `bodyDiseaseLevel`) is the P adapter.
const MOB_DISEASE_CONTACT_BASE_MS: u64 = 1_000;

/// How long a reactor's one-shot hit animation owns the sprite.  The source
/// `hit` frames carry their own per-frame delays and the client plays them
/// once; the server only needs a lock long enough that a fast second request
/// cannot skip the art or double-advance the state.
const REACTOR_HIT_LOCK_MS: u64 = 600;
/// Tolerance behind the character when deciding whether a swing reached a
/// reactor without an authored interaction box.  The player's foot point sits
/// inside its own hitbox, so a prop overlapping the body must still be
/// reachable rather than requiring the character to step past it.
const REACTOR_REACH_BACK_PX: f64 = 12.0;

/// Fraction of an item's catalog `price` that an NPC shop pays when buying it
/// back from a player.
///
/// P: the TMS273 export carries no authored sell/buyback price, and neither
/// the local reference server nor the research pack records one, so the
/// long-standing "shops pay half" behaviour is used as a temporary rule.  It
/// is deliberately expressed as a ratio of the catalog `price` (the same
/// field the shop's own sale prices are authored in) so replacing it with a
/// verified TMS273 value is a one-line change.  Not an official number.
/// Npc.wz `func` marker for an account warehouse keeper.  TMS273 authors three
/// of them (倉庫老闆 金先生 / 倉庫王老闆 / 倉庫管理員朴先生) and all three sit
/// in maps that are part of the assembled catalog, so the warehouse is
/// reachable in normal play.  Matching on the authored marker — rather than on
/// a hard-coded npc id — means a newly placed keeper works without a code
/// change, and a forged request for a non-keeper npc is refused.
const STORAGE_KEEPER_FUNC: &str = "倉庫";

const SHOP_SELL_PRICE_PERCENT: u64 = 50;
/// Denominator for [`SHOP_SELL_PRICE_PERCENT`].
const SHOP_SELL_PRICE_DIVISOR: u64 = 100;

/// Respawn deadline for one source spawn, measured in world ticks.
///
/// TMS273 Map life keeps no map-wide respawn interval: normal spawns carry
/// mobTime 0, which Cosmic interprets as "follow the map respawn cycle".
/// The assembled gameplay left the map cycle empty, so the default above is
/// applied; without it those mobs were removed on death and never returned,
/// emptying each map over time.
fn respawn_deadline(tick: u64, map_respawn_ms: Option<u64>, mob_time: i64) -> Option<u64> {
    match mob_time {
        // One forced spawn that never respawns.
        -1 => None,
        // The map's normal respawn cycle.
        0 => {
            let interval_ticks = map_respawn_ms
                .unwrap_or(DEFAULT_MONSTER_RESPAWN_MS)
                .div_ceil(TICK_MS)
                .max(1);
            Some((tick / interval_ticks + 1) * interval_ticks)
        }
        // Positive source mobTime is a private SpawnPoint delay measured
        // from death, expressed in seconds.
        seconds => {
            let delay_ms = u64::try_from(seconds)
                .unwrap_or(u64::MAX)
                .saturating_mul(1_000);
            Some(tick + delay_ms.div_ceil(TICK_MS).max(1))
        }
    }
}

fn is_mage_advance_npc(map_id: &str, npc_id: &str, template_id: &str) -> bool {
    map_id == MAGE_ADVANCE_MAP_ID
        && npc_id == MAGE_ADVANCE_NPC_ID
        && template_id == MAGE_ADVANCE_TEMPLATE_ID
}
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
// 魔力波動 (2001011) 与其隐藏的浮空节点 (2001012) 共用同一套手感：发动时向
// 上的位移是普通跳的 1.5 倍。位移与初速是平方关系（h = v²/2g），所以初速取
// JUMP_SPEED * sqrt(1.5)。下降阶段在下坠速度上限之外再压到源数据 2001012 的
// v=95 px/s，缓降才看得出与普通下落的区别。
const MAGIC_WAVE_LAUNCH_HEIGHT_RATIO: f64 = 1.5;
const MAGIC_WAVE_SLOW_FALL_SPEED: f64 = 95.0;
const MAGIC_WAVE_SLOW_FALL_SECONDS: i64 = 5;
const DOWNJUMP_RANGE: f64 = 600.0;
const DOWNJUMP_LAUNCH: f64 = 196.0;
/// Height of the authored foot-point collision proxy used by `Foothold::blocks`
/// and the sidewall tests.  The project has no full body AABB; this is the
/// existing 50px figure the wall checks already assumed, now named once so the
/// swept test and the point test cannot drift apart.
const BODY_HEIGHT_PX: f64 = 50.0;
// Body-hit knockback from a monster's contact damage is a short hop, not a
// long ground slide: the body leaves the foothold with a small upward launch,
// arcs back a short horizontal distance and stands again on landing.  Both the
// hop and the horizontal push are scaled by the player's tenacity (0..0.6,
// LoL-style), so tougher players are knocked back less far and recover sooner.
// The numbers keep a tenacity-0 hop ≈10 px high and ≈40-50 px long so the
// knockback reads as a flinch rather than a knock across the platform.
const KNOCKBACK_SPEED: f64 = 240.0; // horizontal push at tenacity 0 (px/s)
const KNOCKBACK_JUMP: f64 = 200.0; // upward hop launch at tenacity 0 (px/s)
const KNOCKBACK_TICKS: u64 = 8; // upper guard window; the hop ends on landing
const TENACITY_CAP: f64 = 0.6; // knockback-reduction cap, mirroring LoL soft cap
                               // Mapleweb's Ladder::felloff probes five pixels beyond each authored end
                               // before cancelling the fixed climb state.  Reuse that source boundary when
                               // resolving the foothold at an allowed top exit.
const LADDER_END_PROBE_PX: f64 = 5.0;
// P: user-authorized adaptation (not original TMS273 rule). When an item drop
// lands in a water zone it is pinned 16px below the surface so a swimming
// player (pickup range is |dx|,|dy| <= 32 at world.rs:8215) can actually reach
// it instead of it resting on the pool floor. y grows downward in world coords.
const DROP_WATER_DRAFT: f64 = 16.0;
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

// ---- Monster pursuit / aggro (server-authoritative). ----
// Being hit marks a mob's attacker as its target.  It then chases that
// target while the target stays alive on the same map within the leash
// radius of the spawn point; once it loses interest (target leaves the map,
// dies, walks beyond the leash, or the hold window elapses without a new
// hit) it forgets and walks back to its spawn point.
/// Euclidean radius (world px) around a mob's spawn that it will leave to
/// pursue a target.  Beyond it the mob gives up and returns home.
const MOB_AGGRO_LEASH: f64 = 900.0;
/// How long a mob keeps pursuing after the last hit it took, before giving
/// up, measured in world ticks.
const MOB_AGGRO_HOLD_TICKS: u64 = 4_000_u64.div_ceil(TICK_MS);
/// Horizontal distance (world px) from the spawn point at which a returning
/// mob considers itself home and resumes its idle wander.
const MOB_HOME_RADIUS: f64 = 2.0;

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
    fn blocks_at_crossing(&self, from_y: f64, to_y: f64, t: f64) -> bool {
        if !self.is_wall() {
            return false;
        }
        let contact_y = from_y + (to_y - from_y) * t.clamp(0.0, 1.0);
        self.blocks(contact_y - BODY_HEIGHT_PX, contact_y - 1.0)
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

/// One authored reactor placement (Map.wz `reactor` subtree).
///
/// A reactor is the original interactive map prop — a flower shaken for an
/// item, a herb patch, a quest container.  Unlike a background layer it owns
/// authoritative state: every accepted hit advances it one state, and the last
/// state is the empty "used up" form until the authored `reactorTime` expires.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReactorPlacement {
    pub id: String,
    pub template_id: String,
    /// Authored world anchor, in the same foot coordinates as footholds.
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub flip: bool,
    /// Source seconds until the prop returns after being used up.  `0` means
    /// it never comes back.
    #[serde(default)]
    pub reactor_time: u32,
    /// Number of authored states.  The last one is the empty form, so a
    /// reactor is interactable while `state + 1 < state_count`.
    pub state_count: u32,
    /// 0 = hit by a normal attack, 9 = clicked / bumped into via an authored
    /// area.  Carried from the source `event/0/type` so the server and client
    /// agree on how the prop is meant to be used instead of guessing.
    #[serde(default)]
    pub hit_type: u32,
    /// Character-local interaction box authored by the source `event/0/lt|rb`.
    /// Mirrored for right-facing like the player attack hitbox.
    #[serde(default)]
    pub hitbox_lt: Option<Point>,
    #[serde(default)]
    pub hitbox_rb: Option<Point>,
}

impl ReactorPlacement {
    /// Source event type 9: the prop is used by clicking it or standing in the
    /// authored `lt`/`rb` area rather than by swinging a weapon at it.
    const TYPE_AREA: u32 = 9;

    /// The last authored state is the empty "used up" form.
    fn interactable_at(&self, state: u32) -> bool {
        self.state_count > 0 && state + 1 < self.state_count
    }

    /// True when the source expects the player to walk into / click the prop.
    fn area_triggered(&self) -> bool {
        self.hit_type == Self::TYPE_AREA
    }

    /// Authored interaction box in world coordinates, or `None` when the
    /// source declares none (those reactors fall back to the attack reach).
    fn hit_bounds(&self) -> Option<(f64, f64, f64, f64)> {
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

/// Live reactor state for one placement.  Session-scoped on purpose: a
/// half-used flower is a moment-to-moment world fact, and losing it on a
/// restart is far better than persisting a state the source would have reset.
#[derive(Clone)]
struct ReactorInstance {
    map_id: String,
    placement: ReactorPlacement,
    state: u32,
    /// Tick until which the one-shot hit animation owns the sprite; the client
    /// plays `hitFrames` once and then returns to the new state's idle frames.
    hit_until: u64,
    /// Tick at which a used-up reactor returns to state 0.
    respawn_at: Option<u64>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaterRect {
    pub x_min: f64,
    pub x_max: f64,
    /// The water surface and floor in world-space foot coordinates.
    pub y_min: f64,
    pub y_max: f64,
    #[serde(default)]
    pub floor: Vec<Point>,
}

impl WaterRect {
    fn valid(&self, bounds: &Bounds) -> bool {
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

    fn floor_at(&self, x: f64) -> f64 {
        self.floor
            .windows(2)
            .find(|p| x >= p[0].x && x <= p[1].x)
            .map(|p| p[0].y + (p[1].y - p[0].y) * (x - p[0].x) / (p[1].x - p[0].x))
            .unwrap_or(self.y_max)
    }

    fn contains_x(&self, x: f64) -> bool {
        x >= self.x_min - 0.001 && x <= self.x_max + 0.001
    }

    fn contains(&self, x: f64, y: f64) -> bool {
        self.contains_x(x) && y >= self.y_min - 0.001 && y <= self.y_max + 0.001
    }
}

fn deserialize_water_zones<'de, D>(deserializer: D) -> Result<Vec<WaterRect>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<Vec<WaterRect>>::deserialize(deserializer).map(Option::unwrap_or_default)
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
    /// Optional map-authored flat water rectangles.  Older exports carry a
    /// null field, so normalize both null and an absent field to an empty list.
    #[serde(default, deserialize_with = "deserialize_water_zones")]
    pub water: Vec<WaterRect>,
    /// Authored interactive props (source Map.wz `reactor` subtree).  Absent
    /// on maps that place none, which is the majority.
    #[serde(default)]
    pub reactors: Vec<ReactorPlacement>,
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
    /// Zero-length-step form of `chain_wall_on_sweep`, kept for the geometry
    /// tests that assert the chain resolution directly.  Production movement
    /// always goes through `chain_wall_on_sweep` so the overlap is evaluated at
    /// the contact fraction rather than at a tick boundary.
    #[cfg(test)]
    fn chain_wall_for(&self, current_id: u64, left: bool, foot_y: f64) -> Option<f64> {
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
    fn chain_wall_on_sweep(
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

    fn water_at(&self, x: f64, y: f64) -> Option<&WaterRect> {
        self.water.iter().find(|water| water.contains(x, y))
    }

    fn water_entry(&self, from_x: f64, to_x: f64, from_y: f64, to_y: f64) -> Option<(f64, f64)> {
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

    fn water_below(&self, current_id: u64, x: f64) -> bool {
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
    fn water_float_y(&self, x: f64, y: f64) -> f64 {
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

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapCatalog {
    pub birth_map_id: String,
    #[serde(default)]
    pub maps: Vec<Map>,
    /// Source `Map.wz .../info/returnMap` per map id, normalized to 9 digits.
    /// This is the whole destination table for 回家卷軸: the item carries only
    /// the `spec.moveTo = 999999999` sentinel, so the town has to come from the
    /// map the character is standing on.  Absent in catalogs that predate the
    /// export, which simply leaves the scroll with no target.
    #[serde(default)]
    pub return_maps: BTreeMap<String, String>,
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
    /// Knockback resistance as a reduction factor (0.0 = none, capped at
    /// TENACITY_CAP). Higher values shorten and lower the contact-damage hop,
    /// League-of-Legends style. The base player stays 0; equipment can feed
    /// the derived value later.
    #[serde(default)]
    pub tenacity: Option<f64>,
    pub weapon_defense: Option<i64>,
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
    #[serde(default)]
    pub quest_id: Option<String>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeferredQuestDrop {
    pub template_id: String,
    pub item_id: String,
    pub minimum: u32,
    #[serde(default)]
    pub maximum: Option<u32>,
    #[serde(deserialize_with = "deserialize_string_or_number")]
    pub quest_id: String,
    #[serde(default)]
    pub chance: Option<u64>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourcesDrops {
    #[serde(default, rename = "deferredQuestDrops")]
    pub deferred_quest_drops: Vec<DeferredQuestDrop>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Sources {
    #[serde(default)]
    pub drops: SourcesDrops,
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
// `y`/`z`/`mp_con`/`hp` are retained verbatim from the MobSkill export for
// future skill handlers even though the current five modelled diseases only
// read `x`/`time`/`prop`/`interval`/`lt`/`rb`.
#[allow(dead_code)]
pub struct MonsterSkillEffect {
    /// Source `x`, meaning depends on the skill (seal/curse duration ms, slow
    /// percent, poison damage, ...).  Retained verbatim so the effect handler
    /// can read it against the authored MobSkill semantics.
    #[serde(default)]
    pub x: Option<i64>,
    #[serde(default)]
    pub y: Option<i64>,
    #[serde(default)]
    pub z: Option<i64>,
    /// Source `time` (seconds) — disease duration for debuffs, cast window for
    /// others.
    #[serde(default)]
    pub time: Option<i64>,
    /// Cast success chance (percent).
    #[serde(default)]
    pub prop: Option<i64>,
    /// Cast interval (seconds).
    #[serde(default)]
    pub interval: Option<i64>,
    #[serde(rename = "mpCon", default)]
    pub mp_con: Option<i64>,
    #[serde(default)]
    pub hp: Option<i64>,
    #[serde(default)]
    pub lt: Option<Point>,
    #[serde(default)]
    pub rb: Option<Point>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonsterSkillTemplate {
    pub skill_id: u32,
    #[serde(default)]
    pub action: i64,
    #[serde(default)]
    pub level: u32,
    #[serde(default, rename = "effectAfterMs")]
    pub effect_after_ms: u64,
    /// Per-level resolved effect numbers keyed by the authored level ("1", ...).
    #[serde(default)]
    pub effects: BTreeMap<String, MonsterSkillEffect>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonsterTemplate {
    #[serde(alias = "id")]
    pub template_id: String,
    pub level: u32,
    pub max_hp: i64,
    #[serde(default, alias = "MMaxMP", alias = "maxMP")]
    pub max_mp: i64,
    #[serde(default)]
    pub boss: bool,
    #[serde(alias = "PADamage")]
    pub pa_damage: Option<i64>,
    /// Source Mob.wz physical defense used by the weapon damage interval.
    #[serde(default, alias = "PDDamage", alias = "pdd")]
    pub pd_damage: Option<i64>,
    /// TMS273 Mob.info.PDRate is percentage defense, not an absolute PDD value.
    #[serde(default, alias = "PDRate")]
    pub pd_rate: Option<f64>,
    /// P adapter for Mob magic-defense rate.  This is deliberately separate
    /// from PDRate: Frozen Break can ignore part of this magic-defense rate,
    /// while Elemental Reset's `u` needs a future elemental-resistance field
    /// and must never be inferred from this value.
    #[serde(default, alias = "MDRate")]
    pub md_rate: Option<f64>,
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
    /// Authored active skills (`info/skill`).  The id -> disease mapping is
    /// MapleDisease.getBySkill (R); `effects` carries the resolved per-level
    /// numbers from `Skill/MobSkill/<id>.json` (T).
    #[serde(default)]
    pub skills: Vec<MonsterSkillTemplate>,
    /// Contact-hit disease id (`info/bodyDisease`, MapleDisease.getBySkill
    /// space).  `None` for the vast majority of mobs that only body-attack.
    #[serde(default)]
    pub body_disease: Option<u32>,
    #[serde(default)]
    pub body_disease_level: Option<u32>,
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

fn deserialize_string_or_number<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Value {
        String(String),
        U64(u64),
        I64(i64),
    }

    match Value::deserialize(deserializer)? {
        Value::String(value) => Ok(value),
        Value::U64(value) => Ok(value.to_string()),
        Value::I64(value) => value
            .try_into()
            .map(|value: u64| value.to_string())
            .map_err(DeError::custom),
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

    /// Resolve the authored level's effect numbers for one authored skill.
    /// `Mob/<id>.img/info/skill` references a level; the exported `effects`
    /// map carries that level's `Skill/MobSkill/<id>.json` numbers.
    fn skill_effect<'a>(&self, skill: &'a MonsterSkillTemplate) -> Option<&'a MonsterSkillEffect> {
        skill
            .effects
            .get(&skill.level.to_string())
            .or_else(|| skill.effects.values().next())
    }
}

/// A player-side abnormal status inflicted by a monster.  `MapleDisease`-space
/// id is kept so the runtime can report which source disease is active, but the
/// authoritative deadlines live on `Player`, one per modelled disease.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PlayerDisease {
    Seal,
    Stun,
    Curse,
    Poison,
    Slow,
}

impl PlayerDisease {
    /// MapleDisease.getBySkill id -> modelled disease.  `None` for the many
    /// ids this server does not model (buffs, summon, darkness, weaken, ...).
    fn from_mob_skill_id(id: u32) -> Option<Self> {
        match id {
            MOB_SKILL_SEAL => Some(Self::Seal),
            MOB_SKILL_STUN => Some(Self::Stun),
            MOB_SKILL_CURSE => Some(Self::Curse),
            MOB_SKILL_POISON => Some(Self::Poison),
            MOB_SKILL_SLOW => Some(Self::Slow),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Seal => "seal",
            Self::Stun => "stun",
            Self::Curse => "curse",
            Self::Poison => "poison",
            Self::Slow => "slow",
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

/// Record a player's hit on a mob as an aggro request: remember the attacker,
/// refresh the pursue-withhold window, and cancel a return-home that is still
/// in progress.  Called only for real player attacks (not body contact, which
/// already has the mob on the player).  Taking `&mut Monster` keeps callers
/// free to use `self.monsters.get_mut` first without a self re-borrow.
fn mark_monster_hit_aggro(monster: &mut Monster, attacker_id: &str, tick: u64) {
    monster.aggro_target = Some(attacker_id.to_owned());
    monster.aggro_until = tick.saturating_add(MOB_AGGRO_HOLD_TICKS);
    monster.returning_home = false;
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
struct QuestRewardItem {
    #[serde(default)]
    item_id: String,
    #[serde(default)]
    quantity: u32,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuestReward {
    #[serde(default)]
    mesos: u64,
    #[serde(default)]
    exp: u64,
    #[serde(default)]
    items: Vec<QuestRewardItem>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuestItemRequirement {
    #[serde(default)]
    item_id: String,
    #[serde(default)]
    quantity: u32,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuestPrerequisite {
    #[serde(default)]
    quest_id: String,
    #[serde(default)]
    status: Option<String>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuestConditions {
    /// Source Check.job is an OR list.  P-compatible chapter data may include
    /// the beginner and already-transferred jobs while retaining sourceJob.
    #[serde(default)]
    job: Vec<u32>,
    // Source metadata; runtime eligibility uses conditions.job.
    #[serde(default, rename = "sourceJob")]
    _source_job: Vec<u32>,
    #[serde(default)]
    level_at_least: u32,
    #[serde(default, alias = "prereq", alias = "prerequisites")]
    quests: Vec<QuestPrerequisite>,
    /// Source Check.QuestOrOption == 1 makes the quest list an OR: any one
    /// satisfied prerequisite unlocks the phase, not every one.  Branch quests
    /// like 36337 list mutually exclusive route checkpoints this way.
    #[serde(default)]
    quest_or_option: bool,
    #[serde(default)]
    items: Vec<QuestItemRequirement>,
    #[serde(default)]
    equipped_items: Vec<String>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuestPhase {
    /// This is the source Check NPC template id (for example 1541000), not
    /// the placed runtime spawn id.
    #[serde(default)]
    npc_id: Option<String>,
    #[serde(default)]
    conditions: QuestConditions,
    /// The generator briefly emitted an item list; current chapter data uses
    /// the source-compatible boolean. Accept both while content rolls forward.
    #[serde(default)]
    consume_items: serde_json::Value,
    #[serde(default)]
    warp_map_id: Option<String>,
    #[serde(default)]
    warp_portal_name: Option<String>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuestObjective {
    // Current objectives all use item counts; retain the source discriminator.
    #[serde(default, rename = "kind", alias = "type")]
    _kind: String,
    #[serde(default)]
    item_id: String,
    #[serde(default)]
    required: u32,
    /// The generator may provide a localized object; keep it as JSON so the
    /// server can select the player's language without inventing text.
    #[serde(default)]
    text: serde_json::Value,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuestInteraction {
    #[serde(default)]
    map_id: String,
    #[serde(default)]
    map_layer_key: String,
    #[serde(default)]
    x: f64,
    #[serde(default)]
    y: f64,
    #[serde(default)]
    range: f64,
    #[serde(default)]
    item_id: String,
    #[serde(default)]
    quantity: u32,
    #[serde(default)]
    label: serde_json::Value,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuestSpec {
    #[serde(default)]
    executable: Option<bool>,
    #[serde(default)]
    quest_id: String,
    #[serde(default)]
    reward: QuestReward,
    #[serde(default)]
    start_items: Vec<QuestRewardItem>,
    #[serde(default)]
    start: QuestPhase,
    #[serde(default)]
    complete: QuestPhase,
    #[serde(default)]
    objectives: Vec<QuestObjective>,
    #[serde(default)]
    interaction: Option<QuestInteraction>,
    #[serde(default)]
    summaries: BTreeMap<String, String>,
    // Source metadata; runtime eligibility uses conditions.job.
    #[serde(default, rename = "sourceJob")]
    _source_job: Vec<u32>,
    #[serde(default)]
    return_map_id: Option<String>,
}

impl QuestSpec {
    fn valid_reward(&self) -> bool {
        self.reward
            .items
            .iter()
            .all(|item| !item.item_id.is_empty() && item.quantity > 0)
    }

    fn executable(&self) -> bool {
        self.executable.unwrap_or(false)
    }

    fn valid_execution(&self) -> bool {
        if !self.executable() {
            return true;
        }
        let valid_conditions = |conditions: &QuestConditions| {
            conditions
                .items
                .iter()
                .all(|item| !item.item_id.is_empty() && item.quantity > 0)
                && conditions
                    .equipped_items
                    .iter()
                    .all(|item_id| !item_id.trim().is_empty())
                && conditions
                    .quests
                    .iter()
                    .all(|quest| !quest.quest_id.is_empty())
        };
        let valid_consume = match &self.complete.consume_items {
            serde_json::Value::Array(items) => items.iter().all(|item| {
                item.get("itemId")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|item_id| !item_id.is_empty())
                    && item
                        .get("quantity")
                        .and_then(serde_json::Value::as_u64)
                        .is_some_and(|quantity| quantity > 0)
            }),
            serde_json::Value::Bool(_) | serde_json::Value::Null => true,
            _ => false,
        };
        valid_conditions(&self.start.conditions)
            && valid_conditions(&self.complete.conditions)
            && valid_consume
            && self
                .start_items
                .iter()
                .all(|item| !item.item_id.is_empty() && item.quantity > 0)
            && self
                .objectives
                .iter()
                .all(|objective| !objective.item_id.is_empty() && objective.required > 0)
            && self.interaction.as_ref().is_none_or(|interaction| {
                !interaction.map_id.is_empty()
                    && !interaction.item_id.is_empty()
                    && interaction.quantity > 0
                    && interaction.range.is_finite()
                    && interaction.range > 0.0
                    && interaction.x.is_finite()
                    && interaction.y.is_finite()
            })
    }
}

/// The sendable chat-emoticon catalogue, exported from
/// `UI/ChatEmoticon.img` into `shared/gameplay.json` (`emoticons`).
///
/// The server never needs the artwork — the sticker icons and the head
/// animation frames are presentation, and live in the client manifest.  It
/// needs only what it must *own*: which ids are real, and the source's own
/// send budget.  Both are facts about TMS273.7, so id validation and rate
/// limiting reuse them instead of inventing a list or a limit of our own.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmoticonCatalogue {
    /// `<groupId>:<sourceName>`, e.g. `1036:10360001`.  The group qualifier is
    /// load-bearing: group 1043 re-releases group 1036's six stickers under the
    /// same authored node names (byte-identical canvases, different captions),
    /// so the bare node name is only unique *inside* its group.
    pub ids: Vec<String>,
    /// `UI/ChatEmoticon.img/ChatLimit`.
    pub limit: EmoticonLimit,
    /// Export provenance stamp (`tms273-emoticon`); informational only.
    #[serde(default)]
    pub source: Option<String>,
}

/// The source's emoticon send budget: at most `count` stickers inside any
/// `time_ms` window.  TMS273.7 authors 4 stickers per 5000 ms, which is a
/// sliding window, not a token bucket — the original client refuses the next
/// sticker while the `count`-th most recent one is still inside `time_ms`.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmoticonLimit {
    pub count: u32,
    #[serde(rename = "timeMs")]
    pub time_ms: u64,
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
    #[serde(default)]
    quests: Vec<QuestSpec>,
    /// Chat-emoticon catalogue (表情貼圖).  `None` for worlds built without the
    /// export — unit-test worlds use `Gameplay::default()` — in which case an
    /// emoticon intent is rejected instead of quietly accepted.
    #[serde(default)]
    pub emoticons: Option<EmoticonCatalogue>,
    #[serde(default)]
    pub sources: Sources,
}

impl Gameplay {
    pub fn load(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let mut gameplay: Self = serde_json::from_str(&std::fs::read_to_string(path)?)?;
        gameplay.apply_deferred_quest_drops()?;
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
                || template.max_mp < 0
                || template
                    .move_speed
                    .is_some_and(|speed| !speed.is_finite() || speed < 0.0)
                || template
                    .source_speed
                    .is_some_and(|speed| !speed.is_finite() || speed < -100.0)
                || template.pd_damage.is_some_and(|damage| damage < 0)
                || template
                    .pd_rate
                    .is_some_and(|rate| !rate.is_finite() || rate < 0.0)
                || template
                    .md_rate
                    .is_some_and(|rate| !rate.is_finite() || !(0.0..=100.0).contains(&rate))
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
                        || drop.quest_id.as_deref().is_some_and(str::is_empty)
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
                    (Some(rx0), Some(rx1)) => !rx0.is_finite() || !rx1.is_finite() || rx0 > rx1,
                    (None, None) => false,
                    _ => true,
                }
        }) {
            return Err("invalid gameplay monster spawn".into());
        }
        if self.spawns.iter().enumerate().any(|(index, spawn)| {
            self.spawns[..index]
                .iter()
                .any(|prior| prior.id == spawn.id)
        }) {
            return Err("duplicate gameplay monster spawn id".into());
        }
        if self.monsters.iter().enumerate().any(|(index, template)| {
            self.monsters[..index]
                .iter()
                .any(|prior| prior.template_id == template.template_id)
        }) {
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
        if self.npc_spawns.iter().enumerate().any(|(index, spawn)| {
            self.npc_spawns[..index]
                .iter()
                .any(|prior| prior.id == spawn.id)
        }) {
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
                || shop
                    .items
                    .iter()
                    .any(|entry| entry.item_id.is_empty() || entry.price == 0)
            {
                return Err("invalid gameplay shop".into());
            }
            if shop.items.iter().enumerate().any(|(index, entry)| {
                shop.items[..index]
                    .iter()
                    .any(|prior| prior.item_id == entry.item_id)
            }) {
                return Err("duplicate gameplay shop item".into());
            }
            if !template_ids.contains(shop.npc_id.as_str()) {
                return Err("shop references unknown npc template".into());
            }
        }
        for quest in &self.quests {
            if quest.quest_id.trim().is_empty() || !quest.valid_reward() || !quest.valid_execution()
            {
                return Err("invalid gameplay quest".into());
            }
        }
        for index in 0..self.quests.len() {
            let quest = &self.quests[index].quest_id;
            if self.quests[..index]
                .iter()
                .any(|prior| prior.quest_id == *quest)
            {
                return Err("duplicate gameplay quest id".into());
            }
        }
        let quest_ids: BTreeSet<&str> = self
            .quests
            .iter()
            .map(|quest| quest.quest_id.as_str())
            .collect();
        for quest in self.quests.iter().filter(|quest| quest.executable()) {
            if quest
                .start
                .npc_id
                .as_deref()
                .is_some_and(|npc_id| !template_ids.contains(npc_id))
                || quest
                    .complete
                    .npc_id
                    .as_deref()
                    .is_some_and(|npc_id| !template_ids.contains(npc_id))
                || quest
                    .start
                    .conditions
                    .quests
                    .iter()
                    .chain(quest.complete.conditions.quests.iter())
                    .any(|requirement| !quest_ids.contains(requirement.quest_id.as_str()))
            {
                return Err("quest references unknown npc or prerequisite".into());
            }
        }
        // An export that lost its sticker ids or authored a nonsensical send
        // budget would silently turn every emoticon intent into a rejection, so
        // it is a load error rather than a runtime surprise.
        if let Some(emoticons) = &self.emoticons {
            let ids: BTreeSet<&str> = emoticons.ids.iter().map(String::as_str).collect();
            if emoticons.ids.is_empty()
                || ids.len() != emoticons.ids.len()
                || emoticons.limit.count == 0
                || emoticons.limit.time_ms == 0
            {
                return Err("emoticon catalogue is malformed".into());
            }
        }
        Ok(())
    }

    fn apply_deferred_quest_drops(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        for drop in &self.sources.drops.deferred_quest_drops {
            let template = self
                .monsters
                .iter_mut()
                .find(|template| template.template_id == drop.template_id)
                .ok_or_else(|| {
                    format!(
                        "deferred quest drop references unknown monster template {}",
                        drop.template_id
                    )
                })?;

            let mut drops = template.drops();
            drops.push(DropSpec {
                item_id: drop.item_id.clone(),
                quantity: drop.minimum,
                quantity_max: drop.maximum,
                chance: drop.chance,
                quest_id: Some(drop.quest_id.clone()),
            });
            template.drop = Some(DropInput::Many(drops));
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
            let map = maps.get(map_id).ok_or_else(|| {
                format!(
                    "monster spawn {} references unknown map {}",
                    spawn.id, map_id
                )
            })?;
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

    fn validate_quest_maps(&self, maps: &BTreeMap<String, Map>) -> Result<(), String> {
        for quest in self.quests.iter().filter(|quest| quest.executable()) {
            if let Some(interaction) = quest.interaction.as_ref() {
                if !maps.contains_key(&interaction.map_id) {
                    return Err(format!(
                        "quest {} interaction references unknown map {}",
                        quest.quest_id, interaction.map_id
                    ));
                }
            }
            for map_id in [
                quest.start.warp_map_id.as_ref(),
                quest.complete.warp_map_id.as_ref(),
            ]
            .into_iter()
            .flatten()
            {
                if !maps.contains_key(map_id) {
                    return Err(format!(
                        "quest {} warp references unknown map {}",
                        quest.quest_id, map_id
                    ));
                }
            }
            if let Some(map_id) = quest.return_map_id.as_ref() {
                if !maps.contains_key(map_id) {
                    return Err(format!(
                        "quest {} return references unknown map {}",
                        quest.quest_id, map_id
                    ));
                }
            }
        }
        Ok(())
    }
}

impl PlayerConfig {
    fn with_ability_stats(
        &self,
        ability_stats: &AbilityStats,
        equipped: &[crate::protocol::InventoryItem],
        job: u32,
    ) -> Self {
        let mut config = self.clone();
        config.base_str = Some(ability_stats.strength);
        config.base_dex = Some(ability_stats.dexterity);
        config.base_int = Some(ability_stats.intelligence);
        config.base_luk = Some(ability_stats.luck);
        config.with_equipment(equipped, job)
    }

    fn with_equipment(&self, equipped: &[crate::protocol::InventoryItem], job: u32) -> Self {
        let bonus = |key: &str| {
            equipped.iter().fold(0i64, |total, item| {
                total.saturating_add(inventory::equipment_attribute(item, key))
            })
        };
        let mut derived = self.clone();
        derived.job = Some(job);
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
    fn attack_range_against(&self, player_level: u32, monster: &MonsterTemplate) -> (f64, f64) {
        let (min, max) = self.attack_range();
        if let Some(rate) = monster.pd_rate {
            let factor = (1.0 - rate / 100.0).max(0.0);
            return (
                (min as f64 * factor).max(1.0),
                (max as f64 * factor).max(1.0),
            );
        }
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

    /// P adapter: source Mob.PADamage minus equipment PDD, minimum one.
    /// ponytail: flat defense only; replace when verified TMS273 received-damage
    /// rules are available. Do not restore the pre-BB standard-PDD table.
    fn contact_damage(&self, monster: &MonsterTemplate) -> Option<i64> {
        if !monster.body_attack {
            return None;
        }
        Some(
            monster
                .pa_damage?
                .max(0)
                .saturating_sub(self.weapon_defense.unwrap_or(0).max(0))
                .max(1),
        )
    }
}

pub enum Command {
    Join {
        identity: Identity,
        connection: String,
        output: mpsc::Sender<String>,
        reply: oneshot::Sender<bool>,
        /// Preferred display language reported by the client hello
        /// ("zh" default, "en" for the ?lang=en UI).
        lang: String,
    },
    Input {
        id: String,
        connection: String,
        message: ClientMessage,
    },
    /// The transport went away or went silent.  The authoritative character is
    /// **detached, not deleted**: it keeps its world entity, map, social
    /// identity and an away window so a later connection can take it over.
    /// Only `Exit` (explicit logout / ban / residency expiry) removes a
    /// character from the world.
    Detach {
        id: String,
        connection: String,
        reason: AwayReason,
    },
    /// Explicit, permanent departure: player logout, ban, or the normal exit
    /// path after a residency window expires.
    Exit {
        id: String,
        connection: Option<String>,
    },
    Leave {
        id: String,
        connection: String,
    },
}

/// Why a character entered an away window.  Stored as a fact next to the
/// window start so the same continuous absence is never restarted by a
/// re-hide, a reconnect, or a transport Pong.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AwayReason {
    /// The client reported `document.hidden`.
    Hidden,
    /// The client reported an explicit away/stay-away intent.
    Manual,
    /// Transport was alive but the application stopped making progress.
    ApplicationStalled,
    /// The socket closed, timed out, or failed to write.
    TransportLost,
}

/// Derived stage of one continuous away window.  Never stored as a mutable
/// field that can drift out of sync; it is computed from elapsed time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AwayPhase {
    /// Within `full_retention`: the character keeps normal world rules.
    Grace,
    /// Past `full_retention`: basic residency, still visible to others.
    Idle,
    /// Past `max_total`: the normal exit path must run.
    ExitDue,
}

/// The single fact describing one continuous absence.  Elapsed time is derived
/// from `started` at every decision point, so a stage can never be stale.
#[derive(Debug, Clone)]
struct AwayWindow {
    id: u64,
    started: Instant,
    started_unix_ms: i64,
    full_retention: Duration,
    max_total: Duration,
    reason: AwayReason,
    /// Last stage already broadcast, used only for notification de-duplication.
    /// It never replaces re-deriving the stage from the current time.
    announced: AwayPhase,
}

impl AwayWindow {
    fn new(id: u64, reason: AwayReason) -> Self {
        Self {
            id,
            started: Instant::now(),
            started_unix_ms: unix_now_ms(),
            full_retention: AWAY_FULL_RETENTION,
            max_total: AWAY_MAX_TOTAL,
            reason,
            announced: AwayPhase::Grace,
        }
    }
    fn phase(&self, now: Instant) -> AwayPhase {
        let elapsed = now.saturating_duration_since(self.started);
        if elapsed >= self.max_total {
            AwayPhase::ExitDue
        } else if elapsed >= self.full_retention {
            AwayPhase::Idle
        } else {
            AwayPhase::Grace
        }
    }
    fn elapsed(&self, now: Instant) -> Duration {
        now.saturating_duration_since(self.started)
    }
    fn remaining_until_exit_ms(&self, now: Instant) -> i64 {
        self.max_total
            .saturating_sub(self.elapsed(now))
            .as_millis()
            .min(i64::MAX as u128) as i64
    }
}

/// Wall-clock milliseconds for display and logs only.  Away decisions are made
/// from `Instant`, never from this value, so a client cannot manipulate the
/// grace window by forging times or by moving the system clock.
fn unix_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Clone)]
struct Player {
    state: PlayerState,
    /// Persisted MP baseline before equipment/skill-derived bonuses.  The
    /// wire state's maxMp is a snapshot and must never become the next
    /// baseline, otherwise reconnecting after Magic Boost would compound the
    /// percentage bonus.
    base_max_mp: i64,
    map_id: String,
    death_id: String,
    connection: String,
    output: mpsc::Sender<String>,
    /// The authoritative character survives its transport.  `None` means the
    /// character is resident without a controlling socket; world rules
    /// (gravity, damage, buffs, death) keep applying to it.
    away: Option<AwayWindow>,
    /// Set when the controlling socket is gone.  The stale `output` channel is
    /// left in place but is never written to again, so a closed receiver can
    /// no longer be mistaken for "broadcast failed, delete the character".
    detached: bool,
    /// Incremented on every successful takeover.  Commands and late close
    /// events carry the connection string they were issued for, so a stale
    /// socket can never move or delete a newer controller's character.
    away_sequence: u64,
    direction: i8,
    vertical: i8,
    jump: bool,
    swimming: bool,
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
    /// Contact-hit knockback: horizontal slide velocity (px/s) and the tick
    /// until which the player is pushed instead of walking.  Both stay on the
    /// authoritative Player, so a pushed body cannot fight the server state.
    knockback_vx: f64,
    knockback_until: u64,
    move_speed: f64,
    magic_guard: bool,
    magic_wave_used: bool,
    magic_wave_float_used: bool,
    slow_fall_until: u64,
    meditation_until: u64,
    meditation_mad: i64,
    ice_teleport_enabled: bool,
    ice_fields: Vec<IceField>,
    /// Third-job ON/OFF skills are world state.  Learned levels remain in the
    /// profile; toggles and their temporary effects are intentionally reset on
    /// reconnect/death/map change.
    teleport_mastery_enabled: bool,
    teleport_boost_enabled: bool,
    adaptation_active: bool,
    adaptation_charges: u32,
    /// Remaining cooldown converted from auth's durable epoch value at join.
    /// The world decrements this tick-local cache; it never queries SQLite in
    /// the simulation loop.
    adaptation_cooldown_ms: u64,
    /// Durable cooldowns are loaded from auth at join and mirrored here so
    /// the single world loop can expose an up-to-date remaining value.
    skill_cooldowns: BTreeMap<u32, u64>,
    /// Beginner buffs are intentionally session state: their effects clear on
    /// reconnect, death, or map change while their skill cooldowns persist.
    skill_buffs: BTreeMap<u32, u64>,
    /// Next authoritative one-second natural-recovery boundary.  It is reset
    /// on join, map entry, death, and revive; failed persistence only advances
    /// this retry boundary, so a failed second is never replayed every tick.
    natural_recovery_next_tick: u64,
    beginner_heal_next_tick: u64,
    beginner_heal_remaining_ticks: u32,
    beginner_heal_per_tick: i64,
    beginner_speed_percent: i64,
    /// The third-job sphere keeps its old single-slot state for compatibility;
    /// fourth-job summons use this bounded list so the ice demon and frozen
    /// orb can coexist with that sphere.
    summon: Option<ThunderSummon>,
    summons: Vec<ThunderSummon>,
    /// Four-segment Ice Dragon Breath is a single accepted cast.  The request
    /// id binds the self-lock so ReleaseSkill cannot cancel another cast.
    channel_request_id: Option<String>,
    channel_skill_id: Option<u32>,
    channel_until: u64,
    channel_level: u32,
    hyper_channel_prepare_until: u64,
    hyper_channel_next_pulse: u64,
    hyper_channel_pulse_index: u32,
    hyper_vortex: Option<HyperVortex>,
    hyper_barrier_enabled: bool,
    hyper_barrier_next_mp: u64,
    hyper_barrier_next_pulse: u64,
    hyper_teleport_enabled: bool,
    hyper_reset_count: u8,
    status_immune_until: u64,
    /// Monster-inflicted abnormal-status deadlines (world tick).  Each disease
    /// has its own deadline so a seal cannot be overwritten by an unrelated
    /// slow; the client renders whatever is still in the future.  A value of 0
    /// means "not afflicted".
    seal_until: u64,
    stun_until: u64,
    curse_until: u64,
    poison_until: u64,
    slow_until: u64,
    /// Tick of the next poison/curse damage pulse while afflicted, so the DoT
    /// keeps its own cadence instead of riding the world's recovery tick.
    poison_next_tick: u64,
    curse_next_tick: u64,
    infinity_next_tick: u64,
    infinity_damage_bonus: i64,
    mystic_strike_stacks: u32,
    mystic_strike_until: u64,
    /// quest id -> "active" | "completed".  Authored quest dialog branches on
    /// these rows and the complete effect grants the configured reward.
    quests: BTreeMap<String, String>,
    /// Display language for server-pushed quest text (see quest_text::LANG_*).
    lang: &'static str,
    /// Per-item consumable cooldowns: item id -> tick at which the item may be
    /// drunk again.  Only items that author a `spec.time` cooldown ever get an
    /// entry, so ordinary potions stay spammable exactly as in the original.
    /// The cooldown gates the *recovery effect* of that item id; it is world
    /// state that resets on join/death/map change, matching the session-scoped
    /// treatment every other temporary player state here gets.
    potion_cooldowns: BTreeMap<String, u64>,
    /// Map-chat token bucket (1 token/s refill, burst 5) replenished lazily
    /// from the authoritative tick so rate limits stay deterministic.
    chat_tokens: u32,
    chat_bucket_tick: u64,
    /// Bounded recent ChatSend request ids (request_id -> echoed text).  A
    /// network retry with the same id and text must not re-broadcast; the same
    /// id with a different body is a conflict.  Oldest entries fall out once
    /// the window is full (ephemeral chat tolerates the small gap).
    chat_recent: VecDeque<(String, String)>,
    /// Bounded recent WhisperSend request ids: (request id, resolved target id,
    /// text).  A retry with the same id re-sends the *sender's* echo only — the
    /// recipient is never whispered twice — and the same id with a different
    /// body is a conflict.  Kept separate from `chat_recent` so a burst of map
    /// chat cannot evict a whisper's idempotency record (and vice versa).
    whisper_recent: VecDeque<(String, String, String)>,
    /// Bounded recent EmoticonSend request ids: (request id, sticker id).  A
    /// retry with the same id and sticker must not replay the animation a
    /// second time; the same id with a different sticker is a conflict.  Kept
    /// apart from `chat_recent`/`whisper_recent` so a burst of talk cannot
    /// evict an emoticon's idempotency record.
    emoticon_recent: VecDeque<(String, String)>,
    /// Ticks of the recent accepted emoticon sends, oldest first.  The source
    /// `ChatLimit` is a sliding window (`count` stickers per `time_ms`), not a
    /// refilling bucket, so the exact send times are kept and pruned lazily
    /// against the authoritative tick.
    emoticon_sends: VecDeque<u64>,
    /// Characters this account has on its blacklist, cached at join and after
    /// every block/unblock so the chat fan-out never has to reach for SQLite.
    /// Enforced on the server: a blocked sender's map chat is dropped here,
    /// which a modified client cannot opt back into.
    blocked: BTreeSet<String>,
    /// Track which area-type reactors are currently overlapped so automatic
    /// stepping only triggers a hit on entry, not every tick while standing.
    area_reactor_overlaps: BTreeSet<String>,
}

fn clear_beginner_buffs(player: &mut Player) {
    player.skill_buffs.clear();
    player.beginner_heal_next_tick = 0;
    player.beginner_heal_remaining_ticks = 0;
    player.beginner_heal_per_tick = 0;
    player.beginner_speed_percent = 0;
    player.summons.clear();
    player.channel_request_id = None;
    player.channel_skill_id = None;
    player.channel_until = 0;
    player.channel_level = 0;
    player.hyper_channel_prepare_until = 0;
    player.hyper_channel_next_pulse = 0;
    player.hyper_channel_pulse_index = 0;
    player.hyper_vortex = None;
    player.hyper_barrier_enabled = false;
    player.hyper_barrier_next_mp = 0;
    player.hyper_barrier_next_pulse = 0;
    player.hyper_teleport_enabled = false;
    player.status_immune_until = 0;
    player.seal_until = 0;
    player.stun_until = 0;
    player.curse_until = 0;
    player.poison_until = 0;
    player.slow_until = 0;
    player.poison_next_tick = 0;
    player.curse_next_tick = 0;
    player.infinity_next_tick = 0;
    player.infinity_damage_bonus = 0;
    player.mystic_strike_stacks = 0;
    player.mystic_strike_until = 0;
    // Consumable cooldowns share the session-scoped lifetime of every other
    // temporary player state here, so a map change, death or reconnect clears
    // them.  Without this a player could carry a lock across a revive and be
    // unable to drink for a minute with no way to see why.
    player.potion_cooldowns.clear();
    player.area_reactor_overlaps.clear();
}

fn clear_hyper_runtime(player: &mut Player) {
    player.skill_buffs.remove(&SKILL_HYPER_THUNDER);
    player.skill_buffs.remove(&SKILL_HYPER_ADVENTURER);
    player.skill_buffs.remove(&SKILL_HYPER_VORTEX);
    if player.channel_skill_id == Some(SKILL_HYPER_THUNDER) {
        player.channel_request_id = None;
        player.channel_skill_id = None;
        player.channel_until = 0;
        player.channel_level = 0;
        player.hyper_channel_prepare_until = 0;
        player.hyper_channel_next_pulse = 0;
        player.hyper_channel_pulse_index = 0;
        player.attack_until = 0;
    }
    player.hyper_vortex = None;
    player.hyper_barrier_enabled = false;
    player.hyper_barrier_next_mp = 0;
    player.hyper_barrier_next_pulse = 0;
    player.hyper_teleport_enabled = false;
}

struct Monster {
    state: MonsterState,
    map_id: String,
    template: MonsterTemplate,
    spawn: MonsterSpawn,
    foothold_id: u64,
    horizontal_speed: f64,
    mp: i64,
    damage_by_player: BTreeMap<String, i64>,
    /// Active pursuit target set by being hit.  `None` means the mob idles.
    /// While set, `step_monsters` chases the target on the same map instead of
    /// walking at random.
    aggro_target: Option<String>,
    /// World tick at which the current pursuit expires if the target does not
    /// deal another hit before then.  Combined with the same-map/death/leash
    /// checks, this is the whole "脱离" (give up) rule: a uniform wall-clock
    /// window independent of how many times the target hit the mob.
    aggro_until: u64,
    /// True while the mob walks back to its spawn point after losing interest.
    /// Set once when aggro breaks, cleared when it is home or lands a fresh
    /// hit again.
    returning_home: bool,
    elemental_weaken_until: u64,
    freeze_until: u64,
    stun_until: u64,
    bind_until: u64,
    bind_immune_until: u64,
    /// Ice Dragon Breath's temporary armor-melting reductions.  They are
    /// kept on the runtime mob rather than mutating the shared template, so
    /// the values disappear with the bind/respawn and cannot leak to another
    /// map instance.
    bind_pd_rate_reduction: i64,
    bind_md_rate_reduction: i64,
    death_until: Option<u64>,
    respawn_at: Option<u64>,
    /// Next world tick at which this mob may cast another authored skill.
    /// A mob only casts while it has a live pursuit target, and each cast
    /// advances this by the skill's authored `interval` (seconds).
    next_skill_tick: u64,
}

struct PendingAttack {
    player_id: String,
    request_id: String,
    action_id: String,
    hit_tick: u64,
}

/// The remembered result of one `ShopSell`, replayed verbatim if the same
/// request id arrives again.  Selling moves mesos, so without this a retried
/// packet would pay twice for a stack that is already gone.
#[derive(Clone)]
#[allow(dead_code)] // fields are replayed through the wire message, not read back.
struct ShopSellOutcome {
    success: bool,
    code: String,
    shop_id: String,
    item_id: String,
    quantity: u32,
    slot: i16,
    mesos_gained: u64,
    mesos: u64,
}

struct TeleportPlan {
    map_id: String,
    x: f64,
    y: f64,
    foothold_id: u64,
    grounded: bool,
}

#[derive(Clone)]
struct IceField {
    field_id: String,
    map_id: String,
    start_x: f64,
    start_y: f64,
    end_x: f64,
    end_y: f64,
    lt: (f64, f64),
    rb: (f64, f64),
    damage_percent: i64,
    expires_at: u64,
    next_hit_at: u64,
    sub_time_ms: u64,
}

#[derive(Clone)]
struct ThunderSummon {
    summon_id: String,
    skill_id: u32,
    level: u32,
    map_id: String,
    x: f64,
    y: f64,
    facing: i8,
    anchored: bool,
    expires_at: u64,
    next_hit_at: u64,
    pulse_index: u64,
}

#[derive(Clone)]
struct HyperVortex {
    request_id: String,
    map_id: String,
    x: f64,
    y: f64,
    facing: i8,
    hidden: bool,
    expires_at: u64,
    next_pulse_at: u64,
}

/// A configured npc placed on a map.  Npcs do not move; the field mirrors
/// `Monster`/`DropState` so the snapshot iterator can collect everything by
/// map id in one pass.
struct NpcInstance {
    state: NpcState,
    map_id: String,
    template_id: String,
    /// Currently-playing conversation node per player.  A shared node would
    /// let one player continue another player's menu selection.
    conversation: BTreeMap<String, String>,
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

/// One authoritative party.  Membership is session state, the same way a
/// reactor's state is: a party is a fact about characters currently in the
/// world, so a restart legitimately dissolves it.  Nothing here is persisted,
/// and nothing here can be created, joined or left by a client claim — every
/// transition goes through the handlers below.
#[derive(Clone)]
struct Party {
    id: String,
    /// The member allowed to invite, kick and hand over leadership.  P: the
    /// source carries no invite-permission field; leader-only matches the
    /// authored `BtKick` / `BtChangeBoss` buttons living on the leader's row.
    leader_id: String,
    members: Vec<String>,
}

/// A pending invitation, stored on the *invited* character so only that
/// character can answer it.  The party id is captured at send time: if the
/// party is gone by the time the answer arrives, the answer simply fails
/// instead of silently creating a new one.
#[derive(Clone)]
struct PartyInvite {
    inviter_id: String,
    party_id: String,
}

/// Outcome of one party intent, kept for request-id idempotency.
#[derive(Clone)]
struct PartyOutcome {
    success: bool,
    code: String,
}

/// Live party state.  Session-scoped and derived from `players` every tick: a
/// member who is no longer in the world is pruned by `step_parties`, so no
/// removal site has to remember to clean a party up.
pub struct World {
    pub map: Map,
    pub gameplay: Gameplay,
    maps: BTreeMap<String, Map>,
    /// `Map.wz .../info/returnMap` per map id, already normalized to the
    /// 9-digit form — the town a 回家卷軸 (`spec.moveTo = 999999999`) sends a
    /// character to.  It lives beside the catalog rather than on `Map` because
    /// the scroll resolves it by the *current* map id, the same way the
    /// snapshot and the world map already speak those ids.
    return_maps: BTreeMap<String, String>,
    players: BTreeMap<String, Player>,
    monsters: BTreeMap<String, Monster>,
    npcs: BTreeMap<String, NpcInstance>,
    drops: BTreeMap<String, DropState>,
    drop_instances: BTreeMap<String, DropInstance>,
    drop_owners: BTreeMap<String, (Option<String>, i64)>,
    drop_maps: BTreeMap<String, String>,
    revive_requests: BTreeMap<(String, String), auth::ReviveOutcome>,
    inventory_requests: BTreeMap<(String, String), auth::InventoryOutcome>,
    /// Authoritative outcome of the last shop sell-back per (player, request),
    /// so a replayed `ShopSell` re-sends the original result instead of paying
    /// mesos a second time for the same stack.
    shop_sell_requests: BTreeMap<(String, String), ShopSellOutcome>,
    /// Which storage keeper each character currently has open, if any.  The
    /// window is bound to the npc so walking away (or a different keeper)
    /// closes it instead of silently operating on a shop the player left.
    open_storage: BTreeMap<String, String>,
    /// Authoritative parties, keyed by a monotonic id.
    parties: BTreeMap<String, Party>,
    /// Pending invitations keyed by the invited character, so an invitation
    /// can only ever be answered by the character it was addressed to.
    party_invites: BTreeMap<String, PartyInvite>,
    /// Bounded request-id idempotency for party intents (player, request).
    party_requests: BTreeMap<(String, String), PartyOutcome>,
    party_sequence: u64,
    /// Cached outcome of the last friend/blacklist intent per (player,
    /// request).  Mirrors the persisted `friend_actions` row so a retry inside
    /// one session does not pay for a second transaction.
    friend_requests: BTreeMap<(String, String), auth::FriendOutcome>,
    /// Reverse index of the friend graph: who lists `key` as a friend.  Built
    /// from the persisted rows (a friend row is written in both directions) so
    /// that a login/logout can push a refreshed window to exactly the
    /// characters that are watching, instead of to the whole world.
    friend_links: BTreeMap<String, BTreeSet<String>>,
    /// Roster snapshot used to notice that somebody's online flag changed.
    /// Compared once per tick; the friend pass is skipped whenever the set of
    /// characters in the world is unchanged.
    friend_roster: Vec<String>,
    skill_requests: BTreeMap<(String, String), auth::SkillActionOutcome>,
    ability_requests: BTreeMap<(String, String), (AbilityStat, auth::AbilityActionOutcome)>,
    pending_attacks: BTreeMap<String, PendingAttack>,
    /// One private first-Boss practice encounter per connected character.
    /// The instance map is runtime-only; profile persistence canonicalizes it
    /// back to the authored source map.
    boss_practices: BTreeMap<String, boss::BossPractice>,
    /// Live reactor state, keyed by the authored placement id.  Session-scoped
    /// world fact: a used-up prop returns on the source timer, and a restart
    /// legitimately resets it.
    reactors: BTreeMap<String, ReactorInstance>,
    /// Bounded request idempotency for BossPractice lifecycle commands.  The
    /// encounter id is part of the key's semantic value so a stale Leave or
    /// Retry cannot mutate a newer private instance.
    boss_requests: BTreeMap<(String, String), boss::BossRequestRecord>,
    boss_request_sequence: u64,
    hyper_reset_quotes: BTreeMap<(String, String), u64>,
    /// Offline multilingual quest display-text catalog (shared/quest-text.json).
    /// The authoritative source for the localized names/summaries the server
    /// pushes in questList/questUpdate.
    quest_text: crate::quest_text::QuestTextCorpus,
    /// Chinese display names for placed npc templates (shared/npc-names.json).
    /// Attached to snapshot/npcResult rows as `nameZh` so the zh UI can label
    /// npcs consistently with quest text without shipping a client table.
    npc_names_zh: BTreeMap<String, String>,
    tick: u64,
    /// Monotonic id source for away windows, so each continuous absence has a
    /// stable identity for prompt de-duplication and logging.
    next_away: u64,
    combat: Combat,
    store: Option<Store>,
    mage_skills: MageSkills,
    next_monster: u64,
    /// Monotonic map-chat message sequence for this node.  Every accepted
    /// ephemeral message gets a unique id; the sequence never resets inside a
    /// process so message ids stay distinct across reconnects.
    chat_sequence: u64,
    /// Monotonic whisper sequence.  Separate from `chat_sequence` so a message
    /// id never has to carry a room kind in its prefix and the two streams stay
    /// independently readable in logs.
    whisper_sequence: u64,
    /// Monotonic emoticon sequence.  Separate from the chat and whisper
    /// sequences so the three ephemeral streams stay independently readable in
    /// logs while every message id remains unique inside the process.
    emoticon_sequence: u64,
    /// The exported sticker ids, flattened into a set once at construction so
    /// the map-room hot path never scans the catalogue.
    emoticon_ids: BTreeSet<String>,
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
        // Flatten the exported sticker ids once; the catalogue is a publication
        // detail after this point.
        let emoticon_ids: BTreeSet<String> = gameplay
            .emoticons
            .as_ref()
            .map(|catalogue| catalogue.ids.iter().cloned().collect())
            .unwrap_or_default();
        let mut world = Self {
            maps: BTreeMap::from([(map.id.clone(), map.clone())]),
            return_maps: BTreeMap::new(),
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
            shop_sell_requests: BTreeMap::new(),
            open_storage: BTreeMap::new(),
            parties: BTreeMap::new(),
            party_invites: BTreeMap::new(),
            party_requests: BTreeMap::new(),
            party_sequence: 0,
            friend_requests: BTreeMap::new(),
            friend_links: BTreeMap::new(),
            friend_roster: Vec::new(),
            skill_requests: BTreeMap::new(),
            ability_requests: BTreeMap::new(),
            pending_attacks: BTreeMap::new(),
            reactors: BTreeMap::new(),
            boss_practices: BTreeMap::new(),
            boss_requests: BTreeMap::new(),
            boss_request_sequence: 0,
            hyper_reset_quotes: BTreeMap::new(),
            quest_text: crate::quest_text::QuestTextCorpus::default(),
            npc_names_zh: BTreeMap::new(),
            tick: 0,
            next_away: 0,
            combat: Combat::new(duration_ms, hit_after_ms),
            store,
            mage_skills: MageSkills::default(),
            next_monster: 0,
            chat_sequence: 0,
            whisper_sequence: 0,
            emoticon_sequence: 0,
            emoticon_ids,
        };
        if let Some(store) = &world.store {
            for drop in store.load_drops(&world.map.id)? {
                let drop_id = drop.id.clone();
                let owner_id = drop.owner_id.clone();
                // P: user-authorized drop floating — re-pin any stored drop
                // that sits in water to just below the surface.
                let (load_x, load_y) = (drop.x, world.map.water_float_y(drop.x, drop.y));
                world.drops.insert(
                    drop_id.clone(),
                    DropState {
                        id: drop.id.clone(),
                        item_id: drop.item_id.clone(),
                        quantity: drop.quantity,
                        x: load_x,
                        y: load_y,
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
        // Reactors are authored per map, so build them once the map set is
        // known.  `attach_catalog` calls this again for the full catalog; it is
        // idempotent and never rolls back state a player already advanced.
        world.rebuild_reactors();
        Ok(world)
    }

    /// Attach the multilingual quest-text corpus so questList/questUpdate can
    /// push authoritative localized display text.  Worlds built without it
    /// (unit tests) degrade to quest-id names with empty summaries.
    pub fn with_quest_text(mut self, quest_text: crate::quest_text::QuestTextCorpus) -> Self {
        self.quest_text = quest_text;
        self
    }

    /// Inject Chinese display names for placed npc templates (shared/npc-names.json).
    pub fn with_npc_names_zh(mut self, names_zh: BTreeMap<String, String>) -> Self {
        self.npc_names_zh = names_zh;
        // The world constructors spawn the birth-map npcs before this injection
        // runs, so backfill any already-placed instances that spawned without a
        // zh name (their lookup table was still empty at that point).
        for npc in self.npcs.values_mut() {
            if npc.state.name_zh.is_none() {
                npc.state.name_zh = self
                    .npc_names_zh
                    .get(npc.state.template_id.as_str())
                    .cloned();
            }
        }
        self
    }

    pub fn with_mage_skills(mut self, mage_skills: MageSkills) -> Self {
        self.mage_skills = mage_skills;
        self
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
        let MapCatalog { birth_map_id, maps, return_maps } = catalog;
        if birth_map_id != self.map.id {
            return Err(format!(
                "map catalog birth map {} does not match {}",
                birth_map_id, self.map.id
            ));
        }
        for map in maps {
            let map_id = map.id.clone();
            self.maps.insert(map_id.clone(), map);
            if let Some(store) = self.store.as_ref() {
                for drop in store.load_drops(&map_id)? {
                    let drop_id = drop.id.clone();
                    // P: user-authorized drop floating.
                    let (load_x, load_y) = (drop.x, self.map.water_float_y(drop.x, drop.y));
                    self.drops.insert(
                        drop_id.clone(),
                        DropState {
                            id: drop.id.clone(),
                            item_id: drop.item_id.clone(),
                            quantity: drop.quantity,
                            x: load_x,
                            y: load_y,
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
        // Validate the return table before it can ever be used: every key must
        // be a map this world actually loaded, and every town must at least be
        // shaped like a map id.  A town *outside* the catalog stays legal data —
        // the archive ships maps this build does not — and is refused when a
        // scroll actually asks for it, which is why membership is not required.
        for (map_id, town_id) in &return_maps {
            if town_id.len() != 9 || !town_id.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(format!(
                    "map catalog returnMap target {town_id} for {map_id} is not a 9-digit map id"
                ));
            }
            if !self.maps.contains_key(map_id) {
                return Err(format!(
                    "map catalog returnMap names an unloaded map: {map_id}"
                ));
            }
        }
        self.return_maps = return_maps;
        self.gameplay
            .validate_spawns_against_maps(&self.maps, &self.map.id)?;
        self.gameplay.validate_quest_maps(&self.maps)?;
        self.rebuild_reactors();
        self.spawn_configured_monsters()
    }

    /// (Re)build live reactor state from every known map's placements.
    ///
    /// Called once the map set is final: at `build` for the single-map worlds
    /// and again from `attach_catalog` once the full catalog is known.  It is
    /// idempotent — a placement already carrying live state keeps it, so
    /// attaching a catalog never resets a prop a player already used.
    fn rebuild_reactors(&mut self) {
        let placements = self
            .maps
            .values()
            .flat_map(|map| {
                map.reactors
                    .iter()
                    .map(|placement| (map.id.clone(), placement.clone()))
            })
            .collect::<Vec<_>>();
        for (map_id, placement) in placements {
            let id = placement.id.clone();
            let entry = self.reactors.entry(id).or_insert_with(|| ReactorInstance {
                map_id: map_id.clone(),
                placement: placement.clone(),
                state: 0,
                hit_until: 0,
                respawn_at: None,
            });
            // Keep the authored geometry current if the map data was reloaded,
            // but never roll back state a player already advanced.
            entry.map_id = map_id;
            entry.placement = placement;
        }
        let known: BTreeSet<String> = self
            .maps
            .values()
            .flat_map(|map| map.reactors.iter().map(|placement| placement.id.clone()))
            .collect();
        self.reactors.retain(|id, _| known.contains(id));
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
            job: self.gameplay.player.job.unwrap_or(0),
            exp: 0,
            exp_to_next: self.gameplay.exp_table.first().copied().unwrap_or(0),
            mesos: 0,
            death_id: String::new(),
            // Empty map_id + (0,0) tells the join site to fall back to the
            // birth map spawn; load_profile() writes the persisted row back
            // over these defaults when the account already exists.
            map_id: String::new(),
            x: 0.0,
            y: 0.0,
            inventory: Vec::new(),
            skills: BTreeMap::new(),
            skill_points: BTreeMap::new(),
            ability_stats: AbilityStats::default(),
        }
    }

    fn spawn_configured_monsters(&mut self) -> Result<(), String> {
        self.gameplay
            .validate()
            .map_err(|error| error.to_string())?;
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

    fn spawn_monster_on_map(&mut self, map_id: String, spawn: MonsterSpawn) -> Result<(), String> {
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
        let map = self.maps.get(&map_id).cloned().ok_or_else(|| {
            format!(
                "monster spawn {} references unknown map {}",
                spawn.id, map_id
            )
        })?;
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
                    spawn
                        .foothold_id
                        .map_or_else(|| "<inferred>".to_owned(), |id| id.to_string()),
                    map_id
                )
            })?;
        let monster_mp = template.max_mp.max(0);
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
                    freeze_stacks: None,
                    action: if can_move { "move" } else { "stand" },
                    action_started_tick: self.tick,
                },
                map_id,
                template,
                spawn,
                foothold_id: foothold_id.unwrap_or(0),
                horizontal_speed: 0.0,
                mp: monster_mp,
                damage_by_player: BTreeMap::new(),
                // A freshly spawned mob has no memory of any prior attacker;
                // aggro only ever appears by taking a hit in this room.
                aggro_target: None,
                aggro_until: 0,
                returning_home: false,
                elemental_weaken_until: 0,
                freeze_until: 0,
                stun_until: 0,
                bind_until: 0,
                bind_immune_until: 0,
                bind_pd_rate_reduction: 0,
                bind_md_rate_reduction: 0,
                death_until: None,
                respawn_at: None,
                next_skill_tick: 0,
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
                    name_zh: self
                        .npc_names_zh
                        .get(template.template_id.as_str())
                        .cloned(),
                    x: spawn.x,
                    y: spawn.y,
                    facing: spawn.facing,
                    shop_id: template.shop_id.clone(),
                    job_advancement_available: None,
                    quest_available: None,
                },
                map_id,
                template_id: template.template_id,
                conversation: BTreeMap::new(),
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
        let observer_job = self
            .players
            .get(id)
            .map(|player| player.state.job)
            .unwrap_or(BEGINNER_JOB);
        let observer_can_advance = self
            .players
            .get(id)
            .is_some_and(|player| player.state.hp > 0 && player.state.action != "dead");
        let observer_can_second_advance = self.players.get(id).is_some_and(|player| {
            observer_can_advance && player.state.job == MAGICIAN_JOB && player.state.level >= 30
        });
        // A stale 8/17-node catalog must not advertise the third transfer:
        // the NPC menu and this marker share the same source skill gate.
        let observer_can_third_advance = self.players.get(id).is_some_and(|player| {
            observer_can_advance
                && player.state.job == ICE_MAGE_JOB
                && player.state.level >= 60
                && self.mage_skills.get(SKILL_ICE_STORM).is_some()
        });
        let observer_can_use_mage_training = self.players.get(id).is_some_and(|player| {
            observer_can_advance && matches!(player.state.job, MAGICIAN_JOB | 220 | 221 | 222)
        });
        let npcs = self
            .npcs
            .values()
            .filter(|npc| npc.map_id == map_id && self.quest_npc_visible(id, npc))
            .map(|npc| {
                let mut state = npc.state.clone();
                if observer_job == BEGINNER_JOB
                    && observer_can_advance
                    && is_mage_advance_npc(map_id, &npc.state.id, &npc.template_id)
                {
                    state.job_advancement_available = Some(true);
                } else if (observer_can_second_advance || observer_can_third_advance)
                    && is_mage_advance_npc(map_id, &npc.state.id, &npc.template_id)
                {
                    state.job_advancement_available = Some(true);
                } else if observer_can_use_mage_training
                    && is_mage_advance_npc(map_id, &npc.state.id, &npc.template_id)
                {
                    state.job_advancement_available = Some(true);
                }
                if !self.quest_menu_choices(id, &npc.template_id).is_empty() {
                    state.quest_available = Some(true);
                }
                state
            })
            .collect::<Vec<_>>();
        let quest_interactions = self.quest_interactions_for(id, map_id);
        let mut summons = self
            .players
            .iter()
            .flat_map(|(player_id, player)| {
                player
                    .summon
                    .iter()
                    .chain(player.summons.iter())
                    .filter(move |summon| summon.map_id == map_id && summon.expires_at > self.tick)
                    .map(move |summon| {
                        serde_json::json!({
                            "id": summon.summon_id,
                            "playerId": player_id,
                            "skillId": summon.skill_id,
                            "x": summon.x,
                            "y": summon.y,
                            "facing": summon.facing,
                            "expiresInMs": (summon.expires_at - self.tick).saturating_mul(TICK_MS),
                            "stationary": summon.anchored,
                        })
                    })
            })
            .collect::<Vec<_>>();
        for (player_id, player) in &self.players {
            if let Some(vortex) = player
                .hyper_vortex
                .as_ref()
                .filter(|vortex| vortex.map_id == map_id && vortex.expires_at > self.tick)
            {
                summons.push(serde_json::json!({
                    "id": format!("hyper-vortex-{player_id}-{}", vortex.request_id),
                    "playerId": player_id,
                    "skillId": if vortex.hidden { SKILL_HYPER_VORTEX_HIDDEN } else { SKILL_HYPER_VORTEX },
                    "x": vortex.x,
                    "y": vortex.y,
                    "facing": vortex.facing,
                    "expiresInMs": (vortex.expires_at - self.tick).saturating_mul(TICK_MS),
                    "stationary": true,
                }));
            }
        }
        // Away state is attached per observer row so every client that can see
        // the character also sees the marker.  It never removes the character
        // from anyone's view and never changes its physics or damage rules.
        let now = Instant::now();
        let mut player_rows = Vec::new();
        for player in self.players.values().filter(|p| p.map_id == map_id) {
            let mut row = serde_json::to_value(&player.state).unwrap_or(serde_json::Value::Null);
            if let Some(away) = player.away.as_ref() {
                if let Some(object) = row.as_object_mut() {
                    object.insert(
                        "away".to_owned(),
                        serde_json::json!({
                            "residency": away.phase(now) != AwayPhase::Grace,
                            "remainingMs": away.remaining_until_exit_ms(now),
                        }),
                    );
                }
            }
            // Monster-inflicted abnormal statuses ride the same per-row block;
            // only active diseases are serialized so a healthy player never
            // carries an empty object.
            let abnormal = crate::protocol::AbnormalStatus {
                seal_ms: remaining_ticks(player.seal_until, self.tick),
                stun_ms: remaining_ticks(player.stun_until, self.tick),
                curse_ms: remaining_ticks(player.curse_until, self.tick),
                poison_ms: remaining_ticks(player.poison_until, self.tick),
                slow_ms: remaining_ticks(player.slow_until, self.tick),
            };
            if !abnormal.is_empty() {
                if let Some(object) = row.as_object_mut() {
                    object.insert("abnormalStatus".to_owned(), serde_json::to_value(&abnormal).unwrap());
                }
            }
            player_rows.push(row);
        }
        let mut snapshot = serde_json::json!({
            "type":"snapshot",
            "serverTick":self.tick,
            "tickMs":TICK_MS,
            "mapId":map_id,
            "selfId":id,
            "players":player_rows,
            "monsters":self.monsters.values().filter(|m| m.map_id == map_id).map(|m| &m.state).collect::<Vec<_>>(),
            "npcs":npcs,
            "questInteractions":quest_interactions,
            "summons": summons,
            "reactors":self.reactors.values().filter(|reactor| reactor.map_id == map_id).map(|reactor| serde_json::json!({
                "id": reactor.placement.id,
                "templateId": reactor.placement.template_id,
                "x": reactor.placement.x,
                "y": reactor.placement.y,
                "flip": reactor.placement.flip,
                "hitType": reactor.placement.hit_type,
                "state": reactor.state,
                "spent": !reactor.placement.interactable_at(reactor.state),
                "hitting": reactor.hit_until > self.tick,
                "respawnInMs": reactor.respawn_at.map(|tick| (tick.saturating_sub(self.tick)).saturating_mul(TICK_MS)),
            })).collect::<Vec<_>>(),
            "drops":self.drops.iter().filter(|(drop_id, _)| self.drop_maps.get(*drop_id).is_some_and(|drop_map| drop_map == map_id)).map(|(_, drop)| drop).collect::<Vec<_>>()
        });
        if let Some((source_map_id, boss_practice)) = self.boss_snapshot_fields(id, map_id) {
            snapshot["sourceMapId"] = source_map_id.into();
            snapshot["bossPractice"] = boss_practice;
        }
        snapshot.to_string()
    }

    fn next_away_id(&mut self) -> u64 {
        self.next_away = self.next_away.wrapping_add(1);
        self.next_away
    }

    /// Advance every away window to the stage implied by the current server
    /// time and run the side effects exactly once per transition.  Called at
    /// the top of each tick and again on any control boundary, so a command
    /// never trusts a cached stage that time has already moved past.
    /// Expire finished consumable cooldowns and refresh the wire mirror.
    ///
    /// The cooldown map is keyed by item id and only ever holds entries for
    /// items the source actually gives a cooldown, but a long session could
    /// still accumulate entries for items the player no longer carries.  This
    /// sweep removes the finished ones each tick and republishes the rest, so
    /// the wire value is always derived from the authoritative tick rather
    /// than from a countdown that a paused client would read stale.
    fn expire_potion_cooldowns(&mut self) {
        let tick = self.tick;
        for player in self.players.values_mut() {
            if player.potion_cooldowns.is_empty() {
                if player.state.potion_cooldowns.is_some() {
                    player.state.potion_cooldowns = None;
                }
                continue;
            }
            player.potion_cooldowns.retain(|_, ready| *ready > tick);
            player.state.potion_cooldowns = if player.potion_cooldowns.is_empty() {
                None
            } else {
                Some(
                    player
                        .potion_cooldowns
                        .iter()
                        .map(|(item_id, ready)| (item_id.clone(), (ready - tick) * TICK_MS))
                        .collect(),
                )
            };
        }
    }

    fn advance_away_windows(&mut self) {
        let now = Instant::now();
        let mut entering_residency: Vec<String> = Vec::new();
        let mut must_exit: Vec<String> = Vec::new();
        for (id, player) in self.players.iter_mut() {
            let Some(away) = player.away.as_mut() else {
                continue;
            };
            let phase = away.phase(now);
            if phase == away.announced {
                continue;
            }
            // A single check may have skipped stages; jump straight to the
            // current one and never replay the intermediate transitions.
            away.announced = phase;
            match phase {
                AwayPhase::Grace => {}
                AwayPhase::Idle => entering_residency.push(id.clone()),
                AwayPhase::ExitDue => must_exit.push(id.clone()),
            }
        }
        for id in entering_residency {
            // The character stays in the world and stays visible; only the
            // away marker changes, which the next snapshot carries to
            // everyone who can see it.
            if let Some(player) = self.players.get_mut(&id) {
                player.direction = 0;
                player.vertical = 0;
                player.jump = false;
            }
        }
        for id in must_exit {
            self.disconnect_boss_player(&id);
            self.players.remove(&id);
            self.end_conversation(&id);
            self.pending_attacks
                .retain(|_, attack| attack.player_id != id);
            self.inventory_requests
                .retain(|(player_id, _), _| player_id != &id);
            self.skill_requests
                .retain(|(player_id, _), _| player_id != &id);
            self.hyper_reset_quotes
                .retain(|(player_id, _), _| player_id != &id);
            self.ability_requests
                .retain(|(player_id, _), _| player_id != &id);
        }
    }

    /// True when the character is a resident without a controlling socket, or
    /// is controlling but has an away window past the grace threshold.
    fn away_visible_phase(&self, id: &str) -> Option<AwayPhase> {
        let player = self.players.get(id)?;
        let away = player.away.as_ref()?;
        Some(away.phase(Instant::now()))
    }

    fn broadcast_to_map(&mut self, map_id: &str, message: &str) {
        // A resident character with no controlling socket is skipped entirely:
        // it stays in the world and stays visible to others, it simply has
        // nobody to push this particular message to.
        let failed: Vec<String> = self
            .players
            .iter()
            .filter(|(_, player)| player.map_id == map_id && !player.detached)
            .filter_map(
                |(id, player)| match player.output.try_send(message.to_owned()) {
                    Err(TrySendError::Closed(_)) => Some(id.clone()),
                    Err(TrySendError::Full(_)) | Ok(()) => None,
                },
            )
            .collect();
        for id in failed {
            self.disconnect_boss_player(&id);
            self.players.remove(&id);
            self.end_conversation(&id);
            self.pending_attacks
                .retain(|_, attack| attack.player_id != id);
        }
    }

    /// Return used-up reactors to state 0 when their authored timer expires.
    ///
    /// `reactorTime` is source seconds.  `0` means the prop never comes back,
    /// which is the correct behaviour for the one-shot quest containers.
    fn step_reactors(&mut self) {
        for reactor in self.reactors.values_mut() {
            if reactor.respawn_at.is_some_and(|tick| tick <= self.tick) {
                reactor.state = 0;
                reactor.respawn_at = None;
                reactor.hit_until = 0;
            }
        }
    }

    /// Authoritative reactor hit: advance one state, or reject the attempt.
    ///
    /// The client only sends "I hit this reactor".  Everything that matters is
    /// decided here — range from the authoritative player position, whether
    /// this prop is still interactable, and which state comes next.  A forged
    /// request for a reactor on another map, or a second request while the
    /// first is still animating, resolves to a rejection instead of a state
    /// change.
    fn handle_reactor_hit(&mut self, id: String, request_id: String, reactor_id: String) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        let map_id = player.map_id.clone();
        let (x, y, facing) = (player.state.x, player.state.y, player.state.facing);
        let dead = player.state.action == "dead" || player.state.hp <= 0;
        let busy = player.channel_until > self.tick || player.state.climbing;
        let output = player.output.clone();

        let reject_with = |code: &'static str, output: &mpsc::Sender<String>| {
            let _ = output.try_send(reject(code, "Reactor hit rejected", Some(&request_id)));
        };
        if dead || busy {
            reject_with("invalid_state", &output);
            return;
        }

        let Some(reactor) = self.reactors.get(&reactor_id) else {
            reject_with("reactor_unknown", &output);
            return;
        };
        // A reactor belongs to one map.  A request naming one on another map
        // is either stale (the player walked through a portal) or forged.
        if reactor.map_id != map_id {
            reject_with("reactor_unknown", &output);
            return;
        }
        let placement = reactor.placement.clone();
        let state = reactor.state;
        let hit_until = reactor.hit_until;
        if !placement.interactable_at(state) {
            // Already used up: returning this instead of silently ignoring
            // lets the client stop prompting for a spent prop.
            reject_with("reactor_spent", &output);
            return;
        }
        if hit_until > self.tick {
            // One hit animation per state.  Accepting another now would skip
            // the art and let a fast client double-advance the state.
            reject_with("reactor_busy", &output);
            return;
        }
        if !self.reactor_in_reach(&placement, x, y, facing) {
            reject_with("reactor_out_of_range", &output);
            return;
        }

        let next_state = state + 1;
        let hit_ms = REACTOR_HIT_LOCK_MS;
        let hit_ticks = hit_ms.div_ceil(TICK_MS).max(1);
        let spent = !placement.interactable_at(next_state);
        let respawn_at = if spent && placement.reactor_time > 0 {
            Some(
                self.tick
                    + u64::from(placement.reactor_time)
                        .saturating_mul(1_000)
                        .div_ceil(TICK_MS)
                        .max(1),
            )
        } else {
            None
        };
        let Some(reactor) = self.reactors.get_mut(&reactor_id) else {
            return;
        };
        reactor.state = next_state;
        reactor.hit_until = self.tick + hit_ticks;
        reactor.respawn_at = respawn_at;

        // Broadcast the authoritative result: every observer on the map plays
        // the same one-shot animation and sees the same new state, so two
        // clients cannot disagree about whether the flower is still there.
        let event = serde_json::json!({
            "type": "reactorState",
            "serverTick": self.tick,
            "mapId": map_id,
            "reactorId": reactor_id,
            "state": next_state,
            "spent": spent,
            "hitDurationMs": hit_ms,
            "respawnInMs": respawn_at.map(|tick| (tick - self.tick).saturating_mul(TICK_MS)),
            "playerId": id,
        })
        .to_string();
        self.broadcast_to_map(&map_id, &event);
    }

    /// Range check for one reactor, mirroring how the source decides it.
    ///
    /// Source type 9 reactors publish a character-local `lt`/`rb` box and are
    /// meant to be bumped into at close range.  Type 0 reactors (and any
    /// placement the source left without a box) are struck with a normal
    /// attack, so they reuse the authoritative attack reach the server already
    /// uses for monsters — one reach rule, no client-supplied geometry.
    fn reactor_in_reach(&self, placement: &ReactorPlacement, x: f64, y: f64, facing: i8) -> bool {
        // Area-triggered props (source type 9) own an authored box and ignore
        // facing entirely: you walk into the flower, you do not swing at it.
        if placement.area_triggered() {
            let Some((x_min, x_max, y_min, y_max)) = placement.hit_bounds() else {
                return false;
            };
            return x >= x_min && x <= x_max && y >= y_min && y <= y_max;
        }
        // Everything else is struck with a normal attack, so it reuses the
        // authored afterimage hitbox the server already trusts for monsters.
        // `attackReach`/`attackHeight` are that WZ box's size; reactors sit on
        // the ground like a monster does.
        let reach = self.gameplay.player.attack_reach.unwrap_or(88.0).max(1.0);
        let height = self.gameplay.player.attack_height.unwrap_or(62.0).max(1.0);
        let facing = if facing == 0 { 1 } else { facing };
        let dx = if facing < 0 {
            x - placement.x
        } else {
            placement.x - x
        };
        dx >= -REACTOR_REACH_BACK_PX && dx <= reach && (placement.y - y).abs() <= height
    }

    /// Trigger type-9 area reactors when the character enters their authored
    /// box.  This reuses the authoritative `handle_reactor_hit` path so
    /// cooldown/state checks stay centralized.
    fn step_area_reactor_interactions(&mut self, id: &str) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        if player.state.action == "dead" || player.state.hp <= 0 {
            return;
        }
        if player.channel_until > self.tick || player.state.climbing {
            return;
        }
        let map_id = player.map_id.clone();
        let x = player.state.x;
        let y = player.state.y;
        let facing = player.state.facing;
        let prev_overlaps = player.area_reactor_overlaps.clone();

        let mut next_overlaps = BTreeSet::new();
        let mut to_hit = Vec::new();
        for (reactor_id, reactor) in &self.reactors {
            if reactor.map_id != map_id || !reactor.placement.area_triggered() {
                continue;
            }
            if reactor.hit_until > self.tick || !reactor.placement.interactable_at(reactor.state) {
                continue;
            }
            if !self.reactor_in_reach(&reactor.placement, x, y, facing) {
                continue;
            }
            if !next_overlaps.insert(reactor_id.clone()) {
                continue;
            }
            if !prev_overlaps.contains(reactor_id) {
                to_hit.push(reactor_id.clone());
            }
        }

        if let Some(player) = self.players.get_mut(id) {
            player.area_reactor_overlaps = next_overlaps;
        }
        for reactor_id in to_hit {
            self.handle_reactor_hit(
                id.to_owned(),
                format!("auto-area:{id}:{reactor_id}:{}", self.tick),
                reactor_id,
            );
        }
    }

    pub fn command(&mut self, command: Command) {
        match command {
            Command::Join {
                identity,
                connection,
                output,
                reply,
                lang,
            } => {
                // Take over the resident character instead of building a new
                // one.  A character is only recreated when it is genuinely
                // absent from the world (fresh login or after a completed
                // exit), so reconnecting never produces a second entity and
                // never restarts the away window that is already running.
                let mut carried_away_sequence = 0;
                if self.players.contains_key(&identity.id) {
                    // A reconnect replaces the stale session.  Resolve its
                    // private Boss instance before rebinding the Player row;
                    // otherwise the old practice entry could move the new
                    // connection into a deleted encounter on the next tick.
                    if !self.prepare_boss_replacement(&identity.id) {
                        let _ = output.try_send(reject(
                            "persistence",
                            "旧连接的练习位置尚未保存，请稍后重连。",
                            None,
                        ));
                        let _ = reply.send(false);
                        return;
                    }
                    self.end_conversation(&identity.id);
                    self.pending_attacks
                        .retain(|_, attack| attack.player_id != identity.id);
                    if let Some(existing) = self.players.get_mut(&identity.id) {
                        existing.away_sequence += 1;
                        carried_away_sequence = existing.away_sequence;
                        existing.connection = connection.clone();
                        existing.output = output.clone();
                        existing.detached = false;
                        // Control is handed over clean: no stale held key, no
                        // queued channel release, no resurrected attack.
                        existing.direction = 0;
                        existing.vertical = 0;
                        existing.jump = false;
                        existing.last_input = Instant::now();
                        // The new client starts its input sequence at 1 again.
                        // Keeping the old high-water mark would make every
                        // fresh packet look stale and silently drop it, so the
                        // character would stand frozen and unmovable.
                        existing.state.last_input_seq = 0;
                        // Recovery boundaries restart from now.  Without this,
                        // time spent away would be paid out as recovery on
                        // return, handing the character free HP/MP for doing
                        // nothing.
                        existing.natural_recovery_next_tick =
                            self.tick.saturating_add(NATURAL_RECOVERY_INTERVAL_TICKS);
                        existing.beginner_heal_next_tick = 0;
                        existing.beginner_heal_remaining_ticks = 0;
                        let _ = output.try_send(self.snapshot(&identity.id));
                        self.send_quest_list(&identity.id);
                        let _ = reply.send(true);
                        return;
                    }
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
                let progress_before = (
                    profile.level,
                    profile.exp,
                    profile.exp_to_next,
                    profile.ability_stats.clone(),
                    profile.skill_points.clone(),
                );
                Self::normalize_profile_progress(&mut profile, &self.gameplay.exp_table);
                if let Some(store) = self.store.as_ref() {
                    let progress_after = (
                        profile.level,
                        profile.exp,
                        profile.exp_to_next,
                        profile.ability_stats.clone(),
                        profile.skill_points.clone(),
                    );
                    if progress_after != progress_before {
                        if let Err(error) = store.save_profile(&identity.id, &profile) {
                            let _ = output.try_send(reject("persistence", &error, None));
                            let _ = reply.send(false);
                            return;
                        }
                    }
                }
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
                let appearance = match self.store.as_ref() {
                    Some(store) => match store.character_appearance(&identity.id) {
                        Ok(appearance) => appearance,
                        Err(error) => {
                            let _ = output.try_send(reject("persistence", &error, None));
                            let _ = reply.send(false);
                            return;
                        }
                    },
                    None => None,
                };
                let id = identity.id.clone();
                if auth::is_practice_map(&profile.map_id) {
                    // Migrate any profile written by an older runtime before
                    // the private-map canonicalization was installed.
                    profile.map_id = BOSS_PRACTICE_FALLBACK_MAP_ID.to_owned();
                }
                // Restore the player's last map + coordinates from the
                // persisted profile.  The map must still exist in the runtime
                // catalog and the persisted point must land inside the map
                // bounds; otherwise fall back to the birth map's authored
                // spawn so the join site never drops a player outside the
                // playable area.
                let persisted_map = self.maps.get(profile.map_id.as_str()).cloned();
                let resolved_map = persisted_map.clone().unwrap_or_else(|| self.map.clone());
                let resolved_map_id = resolved_map.id.clone();
                let (resolved_x, resolved_y) = if persisted_map.is_some()
                    && profile.x.is_finite()
                    && profile.y.is_finite()
                    && resolved_map.bounds.x_min <= profile.x
                    && profile.x <= resolved_map.bounds.x_max
                    && resolved_map.bounds.y_min <= profile.y
                    && profile.y <= resolved_map.bounds.y_max
                {
                    (profile.x, profile.y)
                } else {
                    (resolved_map.spawn.x, resolved_map.spawn.y)
                };
                let foothold_id = resolved_map
                    .ground_near(resolved_x, resolved_y)
                    .map(|(id, _)| id)
                    .unwrap_or(0);
                let quests = match self.store.as_ref() {
                    Some(store) => match store.load_quests(&identity.id) {
                        Ok(quests) => quests,
                        Err(error) => {
                            let _ = output.try_send(reject("persistence", &error, None));
                            let _ = reply.send(false);
                            return;
                        }
                    },
                    None => BTreeMap::new(),
                };
                let adaptation_cooldown_ms = match self.store.as_ref() {
                    Some(store) => {
                        match store.skill_cooldown_remaining_ms(&id, SKILL_ELEMENTAL_ADAPTING) {
                            Ok(remaining) => remaining,
                            Err(error) => {
                                let _ = output.try_send(reject("persistence", &error, None));
                                let _ = reply.send(false);
                                return;
                            }
                        }
                    }
                    None => 0,
                };
                let mut skill_cooldowns = BTreeMap::new();
                if let Some(store) = self.store.as_ref() {
                    for skill_id in [
                        SKILL_RECOVERY,
                        SKILL_NIMBLE_FEET,
                        SKILL_INFINITY,
                        SKILL_BLIZZARD,
                        SKILL_MAPLE_CURE,
                        SKILL_ICE_DRAGON_BREATH,
                        SKILL_FROZEN_ORB,
                        SKILL_HYPER_THUNDER,
                        SKILL_HYPER_ADVENTURER,
                        SKILL_HYPER_VORTEX_HIDDEN,
                    ] {
                        let remaining = match store.skill_cooldown_remaining_ms(&id, skill_id) {
                            Ok(remaining) => remaining,
                            Err(error) => {
                                let _ = output.try_send(reject("persistence", &error, None));
                                let _ = reply.send(false);
                                return;
                            }
                        };
                        if remaining > 0 {
                            skill_cooldowns.insert(skill_id, remaining);
                        }
                    }
                }
                let hyper_points = hyper_points_for_state(profile.level, &profile.skills);
                let hyper_reset_count = match self.store.as_ref() {
                    Some(store) => match store.hyper_reset_count(&id) {
                        Ok(count) => count,
                        Err(error) => {
                            let _ = output.try_send(reject("persistence", &error, None));
                            let _ = reply.send(false);
                            return;
                        }
                    },
                    None => 0,
                };
                let (derived_stats, derived_max_mp) = compute_derived_stats(
                    &self.gameplay,
                    &self.mage_skills,
                    profile.job,
                    profile.max_mp,
                    profile.level,
                    &profile.skills,
                    &profile.ability_stats,
                    &equipped,
                    false,
                    0,
                    None,
                    false,
                    false,
                    false,
                    false,
                    false,
                    0,
                    (adaptation_cooldown_ms > 0).then_some(adaptation_cooldown_ms),
                    0,
                    &skill_cooldowns,
                    &BTreeMap::new(),
                );
                let derived_move_speed = derived_stats.move_speed;
                // The blacklist is read once here instead of inside the chat
                // fan-out: it only ever changes through a friend intent, and
                // every such intent refreshes this cached set.
                let blocked: BTreeSet<String> = self
                    .store
                    .as_ref()
                    .and_then(|store| store.load_blacklist(&id).ok())
                    .unwrap_or_default()
                    .into_iter()
                    .map(|row| row.id)
                    .collect();
                self.players.insert(
                    id.clone(),
                    Player {
                        state: PlayerState {
                            id: id.clone(),
                            username: identity.username,
                            appearance,
                            x: resolved_x,
                            y: resolved_y,
                            vx: 0.,
                            vy: 0.,
                            facing: 1,
                            grounded: false,
                            swimming: false,
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
                            mp: profile.mp.min(derived_max_mp).max(0),
                            max_mp: derived_max_mp,
                            derived_stats,
                            ability_stats: profile.ability_stats,
                            level: profile.level.max(1),
                            job: profile.job,
                            exp: profile.exp,
                            exp_to_next: profile.exp_to_next,
                            mesos: profile.mesos,
                            skills: profile.skills,
                            skill_points: profile.skill_points,
                            hyper_points,
                            hyper_reset_count,
                            hyper_reset_cost: auth::hyper_reset_cost(hyper_reset_count),
                            potion_cooldowns: None,
                            inventory: profile.inventory,
                            equipped,
                            monster_book,
                            away: None,
                        },
                        base_max_mp: profile.max_mp.max(0),
                        map_id: resolved_map_id,
                        death_id: profile.death_id,
                        connection,
                        output: output.clone(),
                        away: None,
                        detached: false,
                        away_sequence: carried_away_sequence,
                        direction: 0,
                        vertical: 0,
                        jump: false,
                        swimming: false,
                        foothold_id,
                        last_foothold_id: foothold_id,
                        fall_boundary_hold: false,
                        drop_fh: 0,
                        last_input: Instant::now(),
                        attack_until: 0,
                        contact_invulnerable_until: 0,
                        knockback_vx: 0.,
                        knockback_until: 0,
                        move_speed: derived_move_speed,
                        magic_guard: false,
                        magic_wave_used: false,
                        magic_wave_float_used: false,
                        slow_fall_until: 0,
                        meditation_until: 0,
                        meditation_mad: 0,
                        ice_teleport_enabled: false,
                        ice_fields: Vec::new(),
                        teleport_mastery_enabled: false,
                        teleport_boost_enabled: false,
                        adaptation_active: false,
                        adaptation_charges: 0,
                        adaptation_cooldown_ms,
                        skill_cooldowns,
                        skill_buffs: BTreeMap::new(),
                        natural_recovery_next_tick: self
                            .tick
                            .saturating_add(NATURAL_RECOVERY_INTERVAL_TICKS),
                        beginner_heal_next_tick: 0,
                        beginner_heal_remaining_ticks: 0,
                        beginner_heal_per_tick: 0,
                        beginner_speed_percent: 0,
                        summon: None,
                        summons: Vec::new(),
                        channel_request_id: None,
                        channel_skill_id: None,
                        channel_until: 0,
                        channel_level: 0,
                        hyper_channel_prepare_until: 0,
                        hyper_channel_next_pulse: 0,
                        hyper_channel_pulse_index: 0,
                        hyper_vortex: None,
                        hyper_barrier_enabled: false,
                        hyper_barrier_next_mp: 0,
                        hyper_barrier_next_pulse: 0,
                        hyper_teleport_enabled: false,
                        hyper_reset_count,
                        status_immune_until: 0,
                        seal_until: 0,
                        stun_until: 0,
                        curse_until: 0,
                        poison_until: 0,
                        slow_until: 0,
                        poison_next_tick: 0,
                        curse_next_tick: 0,
                        infinity_next_tick: 0,
                        infinity_damage_bonus: 0,
                        mystic_strike_stacks: 0,
                        mystic_strike_until: 0,
                        quests,
                        lang: crate::quest_text::normalize_lang(Some(&lang)),
                        chat_tokens: CHAT_TOKEN_BURST,
                        chat_bucket_tick: self.tick,
                        chat_recent: VecDeque::new(),
                        whisper_recent: VecDeque::new(),
                        emoticon_recent: VecDeque::new(),
                        emoticon_sends: VecDeque::new(),
                        blocked,
                        potion_cooldowns: BTreeMap::new(),
                        area_reactor_overlaps: BTreeSet::new(),
                    },
                );
                let _ = output.try_send(self.snapshot(&id));
                // Authoritative quest log push follows the join snapshot so a
                // fresh client window always reflects the persisted rows and
                // the client never needs a client-side translation table.
                self.send_quest_list(&id);
                // A login is the one friend-window fact that is not persisted.
                // Rebuild this character's slice of the friend graph and
                // refresh the windows watching it, so an online flag flips at
                // once instead of on the next tick.
                self.refresh_friend_links(&id);
                self.push_friend_state_to_watchers(&id);
                let _ = reply.send(true);
            }
            Command::Detach {
                id,
                connection,
                reason,
            } => {
                // Only the socket that currently owns the character may detach
                // it.  A late close event from a superseded connection is
                // ignored, so it can never delete someone else's character.
                if !self
                    .players
                    .get(&id)
                    .is_some_and(|p| p.connection == connection)
                {
                    return;
                }
                self.disconnect_boss_player(&id);
                self.end_conversation(&id);
                self.pending_attacks
                    .retain(|_, attack| attack.player_id != id);
                // A repeated hide, a reconnect, or a transport Pong never
                // restarts the grace period: the existing window is kept and
                // only a genuinely new absence allocates a new away id.
                let needs_window = self
                    .players
                    .get(&id)
                    .is_some_and(|player| player.away.is_none());
                let away_id = if needs_window { self.next_away_id() } else { 0 };
                let Some(player) = self.players.get_mut(&id) else {
                    return;
                };
                // Stop honouring any held intent immediately; the character
                // must not keep walking or attacking without authorization.
                player.direction = 0;
                player.vertical = 0;
                player.jump = false;
                player.channel_request_id = None;
                player.channel_until = 0;
                // The stale channel is retained but marked dead: residency is
                // modelled by the character row, not by keeping a socket
                // receiver alive, and a later close can never delete the row.
                player.detached = true;
                if player.away.is_none() {
                    player.away = Some(AwayWindow::new(away_id, reason));
                }
            }
            Command::Exit { id, connection } => {
                if let Some(expected) = connection.as_ref() {
                    if !self
                        .players
                        .get(&id)
                        .is_some_and(|p| p.connection == *expected)
                    {
                        return;
                    }
                }
                self.disconnect_boss_player(&id);
                self.players.remove(&id);
                self.end_conversation(&id);
                self.pending_attacks
                    .retain(|_, attack| attack.player_id != id);
                self.inventory_requests
                    .retain(|(player_id, _), _| player_id != &id);
                self.shop_sell_requests
                    .retain(|(player_id, _), _| player_id != &id);
                self.skill_requests
                    .retain(|(player_id, _), _| player_id != &id);
                self.hyper_reset_quotes
                    .retain(|(player_id, _), _| player_id != &id);
                self.ability_requests
                    .retain(|(player_id, _), _| player_id != &id);
            }
            Command::Leave { id, connection } => {
                if self
                    .players
                    .get(&id)
                    .is_some_and(|p| p.connection == connection)
                {
                    self.disconnect_boss_player(&id);
                    self.players.remove(&id);
                    self.end_conversation(&id);
                    self.pending_attacks
                        .retain(|_, attack| attack.player_id != id);
                    self.inventory_requests
                        .retain(|(player_id, _), _| player_id != &id);
                    self.shop_sell_requests
                        .retain(|(player_id, _), _| player_id != &id);
                    self.skill_requests
                        .retain(|(player_id, _), _| player_id != &id);
                    self.hyper_reset_quotes
                        .retain(|(player_id, _), _| player_id != &id);
                    self.ability_requests
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
                    // An explicit logout removes the character.  This is the
                    // only client message allowed to do so: a socket that
                    // merely closes is a tab switch or a reload, not a
                    // departure, and must keep the character resident.
                    ClientMessage::Logout => {
                        self.disconnect_boss_player(&id);
                        self.players.remove(&id);
                        self.end_conversation(&id);
                        self.pending_attacks
                            .retain(|_, attack| attack.player_id != id);
                        self.inventory_requests
                            .retain(|(player_id, _), _| player_id != &id);
                        self.skill_requests
                            .retain(|(player_id, _), _| player_id != &id);
                        self.hyper_reset_quotes
                            .retain(|(player_id, _), _| player_id != &id);
                        self.ability_requests
                            .retain(|(player_id, _), _| player_id != &id);
                    }
                    ClientMessage::Lifecycle { hidden, away, .. } => {
                        // A lifecycle report is advisory.  It may open an away
                        // window but it can never close one: only completing a
                        // real takeover ends an absence.  Re-reporting hidden
                        // keeps the original start, so flashing the tab cannot
                        // extend the grace period.
                        if hidden || away.unwrap_or(false) {
                            let reason = if away.unwrap_or(false) {
                                AwayReason::Manual
                            } else {
                                AwayReason::Hidden
                            };
                            let needs_window = self
                                .players
                                .get(&id)
                                .is_some_and(|player| player.away.is_none());
                            let away_id = if needs_window { self.next_away_id() } else { 0 };
                            let Some(player) = self.players.get_mut(&id) else {
                                return;
                            };
                            // Leaving sight must not leave a key held down: the
                            // character stops acting on stale intent at once.
                            player.direction = 0;
                            player.vertical = 0;
                            player.jump = false;
                            if player.away.is_none() {
                                player.away = Some(AwayWindow::new(away_id, reason));
                            }
                        }
                    }
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
                        let (mut direction, mut vertical, mut jump) = (direction, vertical, jump);
                        player.state.last_input_seq = seq;
                        if player.channel_until > self.tick {
                            // Ice Dragon Breath owns movement for its source
                            // q-window; input heartbeats remain acknowledged
                            // but cannot move or jump the authoritative body.
                            direction = 0;
                            vertical = 0;
                            jump = false;
                        }
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
                    ClientMessage::AllocateAp { request_id, stat } => {
                        self.handle_allocate_ap(id, request_id, stat)
                    }
                    ClientMessage::LearnSkill {
                        request_id,
                        skill_id,
                    } => self.handle_learn_skill(id, request_id, skill_id),
                    ClientMessage::ResetHyper {
                        request_id,
                        expected_cost,
                    } => self.handle_reset_hyper(id, request_id, expected_cost),
                    ClientMessage::CastSkill {
                        request_id,
                        skill_id,
                        direction,
                        vertical,
                    } => self.handle_cast_skill(id, request_id, skill_id, direction, vertical),
                    ClientMessage::BossPractice {
                        request_id,
                        action,
                        encounter_id,
                    } => self.handle_boss_practice(id, request_id, action, encounter_id),
                    ClientMessage::ReleaseSkill { request_id } => {
                        self.handle_release_skill(id, request_id)
                    }
                    ClientMessage::Pickup {
                        request_id,
                        drop_id,
                    } => self.handle_pickup(id, request_id, drop_id),
                    ClientMessage::ReactorHit {
                        request_id,
                        reactor_id,
                    } => self.handle_reactor_hit(id, request_id, reactor_id),
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
                    ClientMessage::QuestInteract {
                        request_id,
                        quest_id,
                    } => self.handle_quest_interact(id, request_id, quest_id),
                    ClientMessage::NpcTalk {
                        request_id,
                        npc_id,
                        step,
                        selection,
                    } => self.handle_npc_talk(id, request_id, npc_id, step.as_deref(), selection),
                    ClientMessage::ShopBuy {
                        request_id,
                        shop_id,
                        item_id,
                        quantity,
                    } => self.handle_shop_buy(id, request_id, shop_id, item_id, quantity),
                    ClientMessage::ShopSell {
                        request_id,
                        shop_id,
                        inventory_type,
                        source_slot,
                        quantity,
                    } => self.handle_shop_sell(
                        id,
                        request_id,
                        shop_id,
                        inventory_type,
                        source_slot,
                        quantity,
                    ),
                    ClientMessage::StorageOpen { request_id, npc_id } => {
                        self.handle_storage_open(id, request_id, npc_id)
                    }
                    ClientMessage::StorageTransfer {
                        request_id,
                        operation,
                        inventory_type,
                        slot,
                        quantity,
                    } => self.handle_storage_transfer(
                        id,
                        request_id,
                        operation,
                        inventory_type,
                        slot,
                        quantity,
                    ),
                    ClientMessage::StorageMesos {
                        request_id,
                        operation,
                        quantity,
                    } => self.handle_storage_mesos(id, request_id, operation, quantity),
                    ClientMessage::ChatSend { request_id, text } => {
                        self.handle_chat(id, request_id, text)
                    }
                    ClientMessage::WhisperSend {
                        request_id,
                        target_name,
                        text,
                    } => self.handle_whisper(id, request_id, target_name, text),
                    ClientMessage::EmoticonSend {
                        request_id,
                        emoticon_id,
                    } => self.handle_emoticon(id, request_id, emoticon_id),
                    ClientMessage::PartyInvite {
                        request_id,
                        player_name,
                    } => self.handle_party_invite(id, request_id, player_name),
                    ClientMessage::PartyRespond { request_id, accept } => {
                        self.handle_party_respond(id, request_id, accept)
                    }
                    ClientMessage::PartyLeave { request_id } => {
                        self.handle_party_leave(id, request_id)
                    }
                    ClientMessage::PartyKick {
                        request_id,
                        player_id,
                    } => self.handle_party_kick(id, request_id, player_id),
                    ClientMessage::PartyLeader {
                        request_id,
                        player_id,
                    } => self.handle_party_leader(id, request_id, player_id),
                    ClientMessage::FriendOpen { request_id } => {
                        self.handle_friend_open(id, request_id)
                    }
                    ClientMessage::FriendAdd {
                        request_id,
                        player_name,
                    } => self.handle_friend_by_name(
                        id,
                        request_id,
                        auth::FriendOperation::Add,
                        player_name,
                    ),
                    ClientMessage::FriendRemove {
                        request_id,
                        player_id,
                    } => self.apply_friend_edit(
                        id,
                        request_id,
                        auth::FriendOperation::Remove,
                        player_id,
                    ),
                    ClientMessage::FriendBlock {
                        request_id,
                        player_name,
                    } => self.handle_friend_by_name(
                        id,
                        request_id,
                        auth::FriendOperation::Block,
                        player_name,
                    ),
                    ClientMessage::FriendUnblock {
                        request_id,
                        player_id,
                    } => self.apply_friend_edit(
                        id,
                        request_id,
                        auth::FriendOperation::Unblock,
                        player_id,
                    ),
                    ClientMessage::Hello { .. } => {}
                }
            }
        }
    }

    /// Map public chat (P1-C04).  The client submits only a ChatSend intent;
    /// the authoritative room (current map), author identity and display name
    /// are all resolved here.  Control flow stays inside the world tick and
    /// every outbound write is a bounded try_send, so a slow reader or a
    /// spammer cannot stall gameplay on another map or another player.
    fn handle_chat(&mut self, id: String, request_id: String, text: String) {
        // 1. Room: the sender's current authoritative map.  The client cannot
        //    widen the audience — protocol parsing denies unknown fields, so a
        //    forged map/channel/realm field never reaches this function.
        let map_id = match self.players.get(&id) {
            Some(player) => player.map_id.clone(),
            None => return,
        };
        // 2. Text policy before any bookkeeping.
        if !crate::protocol::valid_chat_text(&text) {
            let _ = self.chat_reject(
                &id,
                &request_id,
                "invalid_chat_text",
                "消息为空、过长或包含不允许的字符。",
            );
            return;
        }
        let text = text.trim().to_owned();
        // 3. Bounded per-session idempotency (§9.1/§9.2): a retry with the
        //    same request id and body never re-broadcasts; the same id with a
        //    different body is rejected as a conflict.
        enum Duplicate {
            Replay,
            Conflict,
        }
        let duplicate = {
            let Some(player) = self.players.get_mut(&id) else {
                return;
            };
            let mut duplicate = None;
            for (seen_id, seen_text) in player.chat_recent.iter() {
                if seen_id == &request_id {
                    duplicate = Some(if seen_text == &text {
                        Duplicate::Replay
                    } else {
                        Duplicate::Conflict
                    });
                    break;
                }
            }
            if duplicate.is_none() {
                if player.chat_recent.len() >= CHAT_RECENT_WINDOW {
                    player.chat_recent.pop_front();
                }
                player
                    .chat_recent
                    .push_back((request_id.clone(), text.clone()));
            }
            duplicate
        };
        match duplicate {
            Some(Duplicate::Replay) => return,
            Some(Duplicate::Conflict) => {
                let _ = self.chat_reject(
                    &id,
                    &request_id,
                    "idempotency_conflict",
                    "重复请求使用了不同的内容。",
                );
                return;
            }
            None => {}
        }
        // 4. Rate limit: burst 5, refill 1/s.  The bucket lives on the
        //    authoritative Player row, so map changes cannot reset it.
        if !self.chat_consume_token(&id) {
            let _ = self.chat_reject(
                &id,
                &request_id,
                "chat_rate_limited",
                "发言太快，请稍后再试。",
            );
            return;
        }
        // 5. Immutable message fact; the server is the only author.
        self.chat_sequence += 1;
        let message_id = format!("chat-{id}-{}", self.chat_sequence);
        let (author_id, author_name) = match self.players.get(&id) {
            Some(player) => (player.state.id.clone(), player.state.username.clone()),
            None => return,
        };
        let common = serde_json::json!({
            "type": "chatMessage",
            "messageId": message_id,
            "mapId": map_id,
            "authorId": author_id,
            "authorName": author_name,
            "text": text,
            "occurredAtTick": self.tick,
        });
        let mut sender_payload = common.clone();
        sender_payload["requestId"] = serde_json::Value::String(request_id);
        let sender_payload = sender_payload.to_string();
        let peer_payload = common.to_string();
        // 6. Ephemeral fan-out to the current map-room membership.  A full
        //    bounded outbox drops this best-effort message instead of blocking
        //    the tick; the sender merges its own echo by request id.
        let recipients: Vec<(String, mpsc::Sender<String>)> = self
            .players
            .iter()
            .filter(|(player_id, player)| {
                player.map_id == map_id
                    // A blocked sender's map chat never reaches the blocker.
                    // The filter sits at fan-out rather than in the client, so
                    // a modified build cannot opt back into hearing somebody
                    // it blacklisted.  The sender always gets its own echo.
                    && (**player_id == id || !player.blocked.contains(&id))
            })
            .map(|(player_id, player)| (player_id.clone(), player.output.clone()))
            .collect();
        for (player_id, output) in recipients {
            let payload = if player_id == id {
                &sender_payload
            } else {
                &peer_payload
            };
            let _ = output.try_send(payload.clone());
        }
    }

    /// Whisper (密語): one character talks to one other character.
    ///
    /// This is the missing half of the chat module — map chat is a *room* fact
    /// derived from the sender's map, while a whisper is a *pair* fact resolved
    /// from a typed name.  Everything the client is not allowed to decide is
    /// decided here:
    ///
    ///   * who the typed name belongs to (`resolve_friend_name`, the same
    ///     authoritative lookup the friend and party modules use);
    ///   * whether the pair may talk at all (self, offline, either blacklist);
    ///   * the message body, id and timestamp — the server is the only author;
    ///   * the rate budget, shared with map chat because a whisper is still
    ///     one outgoing line of chat.
    ///
    /// A whisper is session-routed only: it is delivered to a character that is
    /// currently in the world and never stored.  There is deliberately no
    /// offline inbox — pretending to queue a message we cannot later deliver
    /// would be inventing a feature the source does not back.
    fn handle_whisper(
        &mut self,
        id: String,
        request_id: String,
        target_name: String,
        text: String,
    ) {
        if !self.players.contains_key(&id) {
            return;
        }
        // 1. Body policy, before any bookkeeping.  Same rule as map chat so a
        //    whisper cannot smuggle a layout/control payload past the reader.
        if !crate::protocol::valid_chat_text(&text) {
            self.whisper_reject(
                &id,
                &request_id,
                "invalid_chat_text",
                "消息为空、过长或包含不允许的字符。",
            );
            return;
        }
        let text = text.trim().to_owned();
        let typed_name = target_name.trim().to_owned();
        // 2. Resolve the typed name into an identity.  A whisper is addressed
        //    to a character, never to an id, so this is the same authoritative
        //    lookup the friend and party modules use.
        let target_id = match self.resolve_friend_name(&typed_name) {
            Some(target_id) => target_id,
            None => {
                self.whisper_reject(
                    &id,
                    &request_id,
                    "whisper_unknown_player",
                    "找不到这个名字的角色。",
                );
                return;
            }
        };
        if target_id == id {
            self.whisper_reject(&id, &request_id, "whisper_self", "不能给自己发密语。");
            return;
        }
        // 3. Idempotency, keyed by (request id, resolved target, text).  A
        //    retry re-sends the sender's own echo from the recorded fact and
        //    stays silent to the recipient — the recipient already has the
        //    message and must never receive it twice.  The same id with a
        //    different body is a conflict.
        let mut replay = None;
        let mut conflict = false;
        if let Some(player) = self.players.get_mut(&id) {
            for (seen_id, seen_target, seen_text) in player.whisper_recent.iter() {
                if seen_id == &request_id {
                    if *seen_target == target_id && seen_text == &text {
                        replay = Some(seen_text.clone());
                    } else {
                        conflict = true;
                    }
                    break;
                }
            }
        } else {
            return;
        }
        if conflict {
            self.whisper_reject(
                &id,
                &request_id,
                "idempotency_conflict",
                "重复请求使用了不同的内容。",
            );
            return;
        }
        if let Some(recorded_text) = replay {
            self.whisper_echo(&id, &request_id, &target_id, &recorded_text, true);
            return;
        }
        // 4. Presence.  A whisper is routed to a live session; there is no
        //    offline inbox, so "not in the world right now" is a reported
        //    outcome rather than a queued message.
        let Some(target) = self.players.get(&target_id) else {
            self.whisper_reject(&id, &request_id, "whisper_offline", "对方当前不在线。");
            return;
        };
        // 5. Blacklist, both directions.  A blocked sender must not be able to
        //    reach the blocker by switching to a different chat surface, and a
        //    player who blocked somebody should not be able to talk to them
        //    either — the block is a statement about the pair, not about the
        //    channel.
        let target_blocked_sender = target.blocked.contains(&id);
        let sender_blocked_target = self
            .players
            .get(&id)
            .is_some_and(|sender| sender.blocked.contains(&target_id));
        if target_blocked_sender {
            self.whisper_reject(&id, &request_id, "whisper_blocked", "对方已把你加入黑名单。");
            return;
        }
        if sender_blocked_target {
            self.whisper_reject(&id, &request_id, "whisper_ignored", "你已把对方加入黑名单。");
            return;
        }
        // 6. Rate limit — the shared chat bucket, so whispering is not a way
        //    around the map-chat limit.
        if !self.chat_consume_token(&id) {
            self.whisper_reject(&id, &request_id, "chat_rate_limited", "发言太快，请稍后再试。");
            return;
        }
        // 7. Immutable message fact; the server is the only author.
        if let Some(player) = self.players.get_mut(&id) {
            if player.whisper_recent.len() >= WHISPER_RECENT_WINDOW {
                player.whisper_recent.pop_front();
            }
            player
                .whisper_recent
                .push_back((request_id.clone(), target_id.clone(), text.clone()));
        }
        self.whisper_sequence += 1;
        let message_id = format!("whisper-{id}-{}", self.whisper_sequence);
        let (author_id, author_name, target_name) = {
            let Some(sender) = self.players.get(&id) else {
                return;
            };
            let Some(target) = self.players.get(&target_id) else {
                return;
            };
            (
                sender.state.id.clone(),
                sender.state.username.clone(),
                target.state.username.clone(),
            )
        };
        let common = serde_json::json!({
            "type": "whisperMessage",
            "messageId": message_id,
            "fromId": author_id,
            "fromName": author_name,
            "toId": target_id,
            "toName": target_name,
            "text": text,
            "occurredAtTick": self.tick,
        });
        // The sender's echo carries the request id so a pending line can be
        // merged instead of duplicated; the recipient's copy never needs it.
        let mut sender_payload = common.clone();
        sender_payload["requestId"] = serde_json::Value::String(request_id);
        let sender_payload = sender_payload.to_string();
        let peer_payload = common.to_string();
        // 8. Two-party fan-out.  A full outbox drops the message instead of
        //    blocking the tick, exactly as map chat does.
        if let Some(target) = self.players.get(&target_id) {
            let _ = target.output.try_send(peer_payload);
        }
        if let Some(sender) = self.players.get(&id) {
            let _ = sender.output.try_send(sender_payload);
        }
    }

    /// Re-send one recorded whisper to its sender only, used when a network
    /// retry replays a request id.  `recorded` is the text stored with the id,
    /// so a replay can never change what was said.
    fn whisper_echo(
        &self,
        id: &str,
        request_id: &str,
        target_id: &str,
        text: &str,
        replay: bool,
    ) {
        let (Some(sender), Some(target)) = (self.players.get(id), self.players.get(target_id))
        else {
            return;
        };
        let mut payload = serde_json::json!({
            "type": "whisperMessage",
            "messageId": format!("whisper-{id}-replay-{request_id}"),
            "fromId": sender.state.id,
            "fromName": sender.state.username,
            "toId": target.state.id,
            "toName": target.state.username,
            "text": text,
            "occurredAtTick": self.tick,
            "replay": replay,
        });
        payload["requestId"] = serde_json::Value::String(request_id.to_owned());
        let _ = sender.output.try_send(payload.to_string());
    }

    fn whisper_reject(&self, id: &str, request_id: &str, code: &str, message: &str) -> bool {
        match self.players.get(id) {
            Some(player) => player
                .output
                .try_send(reject(code, message, Some(request_id)))
                .is_ok(),
            None => false,
        }
    }

    /// Best-effort private rejection to one sender.  A full outbox drops the
    /// reply; ephemeral chat never blocks on it.
    fn chat_reject(&self, id: &str, request_id: &str, code: &str, message: &str) -> bool {
        match self.players.get(id) {
            Some(player) => player
                .output
                .try_send(reject(code, message, Some(request_id)))
                .is_ok(),
            None => false,
        }
    }

    /// Lazy token-bucket consume for map chat: refill 1 token/second up to
    /// burst 5, driven purely by the authoritative tick for deterministic
    /// tests (no wall clock dependency).
    fn chat_consume_token(&mut self, id: &str) -> bool {
        let Some(player) = self.players.get_mut(id) else {
            return false;
        };
        let ticks_per_second = 1_000 / TICK_MS;
        let elapsed = self.tick.saturating_sub(player.chat_bucket_tick);
        let whole_seconds = elapsed / ticks_per_second;
        if whole_seconds > 0 {
            player.chat_bucket_tick = self.tick - elapsed % ticks_per_second;
            player.chat_tokens = (player.chat_tokens
                + whole_seconds as u32 * CHAT_TOKEN_REFILL_PER_SEC)
                .min(CHAT_TOKEN_BURST);
        }
        if player.chat_tokens == 0 {
            return false;
        }
        player.chat_tokens -= 1;
        true
    }

    /// Chat emoticon (表情貼圖) — the third chat surface, and the only one whose
    /// payload is not free text: the client submits one catalogue id and the
    /// server owns everything else.
    ///
    ///   * the id must exist in the exported `UI/ChatEmoticon.img` table, so a
    ///     modified client cannot push an arbitrary key into other clients'
    ///     renderers;
    ///   * the send budget is the source's own `ChatLimit` and lives on the
    ///     authoritative `Player` row, so changing map or reconnecting cannot
    ///     refill it;
    ///   * the room, the author identity and the tick are derived here — none of
    ///     them is on the wire — so a sticker can never be shown as somebody
    ///     else or into a map its author is not standing in;
    ///   * the fan-out honours the blacklist at the server, exactly like map
    ///     chat, so a modified client cannot opt back into seeing a character it
    ///     blocked.
    ///
    /// Control flow stays inside the world tick and every outbound write is a
    /// bounded `try_send`, so a spammer cannot stall gameplay anywhere else.
    fn handle_emoticon(&mut self, id: String, request_id: String, emoticon_id: String) {
        // 1. Room: the sender's current authoritative map, exactly as chat does
        //    it.  A forged map/channel field never reaches this function
        //    because protocol parsing denies unknown fields.
        let map_id = match self.players.get(&id) {
            Some(player) => player.map_id.clone(),
            None => return,
        };
        // 2. Catalogue membership before any bookkeeping.  The set is built from
        //    the export at construction, so this is the same table the client
        //    renders from.
        if !self.emoticon_ids.contains(&emoticon_id) {
            let _ = self.chat_reject(&id, &request_id, "emoticon_unknown", "未知的表情贴图。");
            return;
        }
        // 3. Bounded per-session idempotency, same contract as map chat: a retry
        //    with the same id and sticker never plays the animation twice, and
        //    the same id with a different sticker is a conflict.  Recording the
        //    id first (as chat does) means a retry of anything already seen is
        //    idempotent even if it was refused below.
        enum Duplicate {
            Replay,
            Conflict,
        }
        let duplicate = {
            let Some(player) = self.players.get_mut(&id) else {
                return;
            };
            let mut duplicate = None;
            for (seen_id, seen_sticker) in player.emoticon_recent.iter() {
                if seen_id == &request_id {
                    duplicate = Some(if seen_sticker == &emoticon_id {
                        Duplicate::Replay
                    } else {
                        Duplicate::Conflict
                    });
                    break;
                }
            }
            if duplicate.is_none() {
                if player.emoticon_recent.len() >= EMOTICON_RECENT_WINDOW {
                    player.emoticon_recent.pop_front();
                }
                player
                    .emoticon_recent
                    .push_back((request_id.clone(), emoticon_id.clone()));
            }
            duplicate
        };
        match duplicate {
            Some(Duplicate::Replay) => return,
            Some(Duplicate::Conflict) => {
                let _ = self.chat_reject(
                    &id,
                    &request_id,
                    "idempotency_conflict",
                    "重复请求使用了不同的内容。",
                );
                return;
            }
            None => {}
        }
        // 4. Source send budget (`ChatLimit`).  Sharing the chat token bucket
        //    would have been the easy option, but the source authors a separate
        //    sticker limit, so the sticker limit is what is enforced.
        if !self.emoticon_consume_budget(&id) {
            let _ = self.chat_reject(
                &id,
                &request_id,
                "emoticon_rate_limited",
                "表情发送太快，请稍后再试。",
            );
            return;
        }
        // 5. Immutable message fact; the server is the only author.
        self.emoticon_sequence += 1;
        let message_id = format!("emoticon-{id}-{}", self.emoticon_sequence);
        let (author_id, author_name) = match self.players.get(&id) {
            Some(player) => (player.state.id.clone(), player.state.username.clone()),
            None => return,
        };
        let common = serde_json::json!({
            "type": "emoticonMessage",
            "messageId": message_id,
            "mapId": map_id,
            "authorId": author_id,
            "authorName": author_name,
            "emoticonId": emoticon_id,
            "occurredAtTick": self.tick,
        });
        let mut sender_payload = common.clone();
        sender_payload["requestId"] = serde_json::Value::String(request_id);
        let sender_payload = sender_payload.to_string();
        let peer_payload = common.to_string();
        // 6. Ephemeral fan-out to the current map-room membership, with the same
        //    blacklist filter map chat uses.  The sender always gets its own
        //    echo so the animation plays locally from the authoritative fact
        //    rather than from an optimistic local guess.
        let recipients: Vec<(String, mpsc::Sender<String>)> = self
            .players
            .iter()
            .filter(|(player_id, player)| {
                player.map_id == map_id && (**player_id == id || !player.blocked.contains(&id))
            })
            .map(|(player_id, player)| (player_id.clone(), player.output.clone()))
            .collect();
        for (player_id, output) in recipients {
            let payload = if player_id == id {
                &sender_payload
            } else {
                &peer_payload
            };
            let _ = output.try_send(payload.clone());
        }
    }

    /// Lazily prune and consume the source emoticon budget.
    ///
    /// `ChatLimit` is a sliding window — at most `count` stickers inside any
    /// `time_ms` — not a refilling bucket, so the accepted send ticks are kept
    /// oldest-first and pruned against the authoritative tick.  That keeps the
    /// limit exactly reproducible in tests without reading a wall clock.
    fn emoticon_consume_budget(&mut self, id: &str) -> bool {
        // `EmoticonLimit` is `Copy`, so the immutable borrow of `gameplay` ends
        // with this statement and the mutable borrow of `players` is free.
        let Some(limit) = self
            .gameplay
            .emoticons
            .as_ref()
            .map(|catalogue| catalogue.limit)
        else {
            return false;
        };
        let window_ticks = (limit.time_ms + TICK_MS - 1) / TICK_MS;
        let window_ticks = window_ticks.max(1);
        let tick = self.tick;
        let Some(player) = self.players.get_mut(id) else {
            return false;
        };
        while let Some(oldest) = player.emoticon_sends.front() {
            if tick.saturating_sub(*oldest) >= window_ticks {
                player.emoticon_sends.pop_front();
            } else {
                break;
            }
        }
        if player.emoticon_sends.len() >= limit.count as usize {
            return false;
        }
        player.emoticon_sends.push_back(tick);
        true
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
        self.end_conversation(&id);
        let Some(player) = self.players.get_mut(&id) else {
            return;
        };
        player.map_id = target_map_id.clone();
        player.natural_recovery_next_tick =
            self.tick.saturating_add(NATURAL_RECOVERY_INTERVAL_TICKS);
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
        player.swimming = false;
        player.direction = 0;
        player.vertical = 0;
        player.jump = false;
        player.foothold_id = foothold_id;
        player.last_foothold_id = foothold_id;
        player.fall_boundary_hold = false;
        player.drop_fh = 0;
        player.attack_until = 0;
        player.meditation_until = 0;
        player.meditation_mad = 0;
        clear_beginner_buffs(player);
        player.ice_teleport_enabled = false;
        player.ice_fields.clear();
        player.teleport_mastery_enabled = false;
        player.teleport_boost_enabled = false;
        player.adaptation_active = false;
        player.adaptation_charges = 0;
        player.summon = None;
        refresh_player_derived(&self.gameplay, &self.mage_skills, player);
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
        if player.state.climbing
            || player.state.action == "dead"
            || player.channel_until > self.tick
        {
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
            &map_id,
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

    fn handle_allocate_ap(&mut self, id: String, request_id: String, stat: AbilityStat) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        if player.state.hp <= 0 || player.state.action == "dead" {
            self.send_reject(
                &id,
                "invalid_state",
                "死亡角色不能加点。",
                Some(&request_id),
            );
            return;
        }
        let outcome = match self.store.as_ref() {
            Some(store) => match store.allocate_ap(&id, &request_id, stat) {
                Ok(outcome) => outcome,
                Err(error) => {
                    self.send_reject(&id, "persistence", &error, Some(&request_id));
                    return;
                }
            },
            None => self.local_allocate_ap(&id, &request_id, stat),
        };
        if outcome.success && !outcome.already_resolved {
            if let Some(player) = self.players.get_mut(&id) {
                player.state.ability_stats = outcome.stats.clone();
                refresh_player_derived(&self.gameplay, &self.mage_skills, player);
            }
            if let Err(error) = self.persist_player(&id) {
                self.send_reject(&id, "persistence", &error, Some(&request_id));
                return;
            }
        }
        self.send_ability_result(&id, &request_id, &outcome);
        self.send_snapshot(&id);
    }

    fn local_allocate_ap(
        &mut self,
        id: &str,
        request_id: &str,
        stat: AbilityStat,
    ) -> auth::AbilityActionOutcome {
        if let Some(prior) = self
            .ability_requests
            .get(&(id.to_owned(), request_id.to_owned()))
            .cloned()
        {
            let (prior_stat, prior) = prior;
            return auth::AbilityActionOutcome {
                success: prior.success && prior_stat == stat,
                code: if prior_stat == stat {
                    prior.code
                } else {
                    "request_conflict".into()
                },
                stats: prior.stats,
                already_resolved: true,
            };
        }
        let Some(player) = self.players.get_mut(id) else {
            return auth::AbilityActionOutcome {
                success: false,
                code: "player_unknown".into(),
                stats: AbilityStats::default(),
                already_resolved: false,
            };
        };
        let mut stats = player.state.ability_stats.clone();
        let success = stats.add_point(stat);
        let outcome = auth::AbilityActionOutcome {
            success,
            code: if success {
                String::new()
            } else {
                "not_enough_ap".into()
            },
            stats: if success {
                stats.clone()
            } else {
                player.state.ability_stats.clone()
            },
            already_resolved: false,
        };
        if success {
            player.state.ability_stats = stats;
            refresh_player_derived(&self.gameplay, &self.mage_skills, player);
        }
        self.ability_requests.insert(
            (id.to_owned(), request_id.to_owned()),
            (stat, outcome.clone()),
        );
        outcome
    }

    fn send_ability_result(
        &self,
        id: &str,
        request_id: &str,
        outcome: &auth::AbilityActionOutcome,
    ) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let _ = player.output.try_send(
            serde_json::json!({
                "type": "abilityResult",
                "requestId": request_id,
                "success": outcome.success,
                "code": outcome.code,
                "abilityStats": outcome.stats,
            })
            .to_string(),
        );
    }

    fn handle_reset_hyper(&mut self, id: String, request_id: String, expected_cost: u64) {
        let store_prior = if let Some(store) = self.store.as_ref() {
            match store.prior_skill_action(&id, &request_id, "hyper_reset", 0) {
                Ok(prior) => prior,
                Err(error) => {
                    self.send_reject(&id, "persistence", &error, Some(&request_id));
                    return;
                }
            }
        } else {
            None
        };
        if self.store.is_none() {
            if let Some(prior) = self
                .skill_requests
                .get(&(id.clone(), request_id.clone()))
                .cloned()
            {
                let quoted = self
                    .hyper_reset_quotes
                    .get(&(id.clone(), request_id.clone()))
                    .copied();
                let mut outcome = prior;
                outcome.already_resolved = true;
                if outcome.operation != "hyper_reset"
                    || outcome.skill_id != 0
                    || quoted != Some(expected_cost)
                {
                    outcome.success = false;
                    outcome.code = "request_conflict".to_owned();
                }
                self.send_skill_result_with_request(&id, &request_id, &outcome);
                return;
            }
        }
        if store_prior.is_none()
            && self
                .players
                .get(&id)
                .is_none_or(|player| player.state.hp <= 0)
        {
            self.send_reject(
                &id,
                "invalid_state",
                "当前状态不能重置Hyper技能。",
                Some(&request_id),
            );
            return;
        }
        let outcome = match self.store.as_ref() {
            Some(store) => store.reset_hyper_skills(&id, &request_id, expected_cost),
            None => Ok(self.local_reset_hyper(&id, &request_id, expected_cost)),
        };
        let Ok(outcome) = outcome else {
            self.send_reject(
                &id,
                "persistence",
                "Hyper重置保存失败，请重试。",
                Some(&request_id),
            );
            return;
        };
        if outcome.already_resolved {
            self.send_skill_result_with_request(&id, &request_id, &outcome);
            return;
        }
        if !outcome.success {
            self.send_skill_result_with_request(&id, &request_id, &outcome);
            return;
        }
        let next_reset_count = self
            .store
            .as_ref()
            .and_then(|store| store.hyper_reset_count(&id).ok());
        if let Some(player) = self.players.get_mut(&id) {
            player
                .state
                .skills
                .retain(|skill_id, _| !is_hyper_skill(*skill_id));
            player.state.mesos = player.state.mesos.saturating_sub(expected_cost);
            player.hyper_reset_count = next_reset_count
                .unwrap_or_else(|| player.hyper_reset_count.saturating_add(1).min(4));
            player.state.hyper_reset_count = player.hyper_reset_count;
            player.state.hyper_reset_cost = auth::hyper_reset_cost(player.hyper_reset_count);
            player.state.hyper_points =
                hyper_points_for_state(player.state.level, &player.state.skills);
            clear_hyper_runtime(player);
            refresh_player_derived(&self.gameplay, &self.mage_skills, player);
        }
        self.send_skill_result_with_request(&id, &request_id, &outcome);
        self.send_snapshot(&id);
    }

    fn local_reset_hyper(
        &mut self,
        id: &str,
        request_id: &str,
        expected_cost: u64,
    ) -> auth::SkillActionOutcome {
        if let Some(prior) = self
            .skill_requests
            .get(&(id.to_owned(), request_id.to_owned()))
        {
            let mut prior = prior.clone();
            prior.already_resolved = true;
            return prior;
        }
        let Some(player) = self.players.get_mut(id) else {
            return auth::SkillActionOutcome {
                operation: "hyper_reset".into(),
                skill_id: 0,
                success: false,
                code: "player_unknown".into(),
                level: 0,
                remaining_sp: 0,
                mp: 0,
                already_resolved: false,
            };
        };
        let current = auth::hyper_reset_cost(player.hyper_reset_count);
        let success =
            player.state.hp > 0 && expected_cost == current && player.state.mesos >= expected_cost;
        let outcome = auth::SkillActionOutcome {
            operation: "hyper_reset".into(),
            skill_id: 0,
            success,
            code: if success {
                String::new()
            } else {
                "invalid_state".into()
            },
            level: 0,
            remaining_sp: auth::hyper_points(player.state.level, &player.state.skills, 1),
            mp: player.state.mp,
            already_resolved: false,
        };
        self.hyper_reset_quotes
            .insert((id.to_owned(), request_id.to_owned()), expected_cost);
        self.skill_requests
            .insert((id.to_owned(), request_id.to_owned()), outcome.clone());
        outcome
    }

    fn handle_learn_skill(&mut self, id: String, request_id: String, skill_id: u32) {
        if let Some(store) = self.store.as_ref() {
            match store.prior_skill_action(&id, &request_id, "learn", skill_id) {
                Ok(Some(outcome)) => {
                    self.send_skill_result_with_request(&id, &request_id, &outcome);
                    return;
                }
                Ok(None) => {}
                Err(error) => {
                    self.send_reject(&id, "persistence", &error, Some(&request_id));
                    return;
                }
            }
        } else if let Some(prior) = self
            .skill_requests
            .get(&(id.clone(), request_id.clone()))
            .cloned()
        {
            let mut outcome = prior;
            outcome.already_resolved = true;
            if outcome.operation != "learn" || outcome.skill_id != skill_id {
                outcome.success = false;
                outcome.code = "request_conflict".to_owned();
            }
            self.send_skill_result_with_request(&id, &request_id, &outcome);
            return;
        }
        let Some(skill) = self.mage_skills.get(skill_id).cloned() else {
            self.send_reject(&id, "skill_unknown", "未知法师技能。", Some(&request_id));
            return;
        };
        if skill.hidden {
            self.send_reject(
                &id,
                "skill_hidden",
                "该技能由职业规则自动启用。",
                Some(&request_id),
            );
            return;
        }
        if skill.fixed_level {
            self.send_reject(
                &id,
                "skill_fixed_level",
                "该技能由职业规则固定启用。",
                Some(&request_id),
            );
            return;
        }
        let Some(player) = self.players.get(&id) else {
            return;
        };
        if !skill_job_allowed(player.state.job, skill.book_id) {
            self.send_reject(
                &id,
                "wrong_job",
                "当前职业不能学习法师技能。",
                Some(&request_id),
            );
            return;
        }
        if skill.hyper > 0 {
            let kind = skill.hyper;
            if player.state.level < skill.required_level {
                self.send_reject(
                    &id,
                    "level_requirement",
                    "尚未达到Hyper技能等级要求。",
                    Some(&request_id),
                );
                return;
            }
            if auth::hyper_points(player.state.level, &player.state.skills, kind) == 0 {
                self.send_reject(
                    &id,
                    "not_enough_hyper_points",
                    "没有可用的Hyper点数。",
                    Some(&request_id),
                );
                return;
            }
        }
        let prerequisites = skill
            .prerequisites
            .iter()
            .filter_map(|(id, level)| id.parse::<u32>().ok().map(|id| (id, *level)))
            .collect::<BTreeMap<_, _>>();
        let outcome = match self.store.as_ref() {
            Some(store) => store.learn_skill(
                &id,
                &request_id,
                skill_id,
                skill.book_id,
                skill.book_id,
                skill.max_level,
                &prerequisites,
                false,
            ),
            None => Ok(self.local_learn_skill(
                &id,
                &request_id,
                skill_id,
                skill.book_id,
                skill.max_level,
                &prerequisites,
            )),
        };
        let Ok(outcome) = outcome else {
            self.send_reject(
                &id,
                "persistence",
                "技能学习保存失败，请重试。",
                Some(&request_id),
            );
            return;
        };
        if outcome.success && !outcome.already_resolved {
            if let Some(player) = self.players.get_mut(&id) {
                player.state.skills.insert(skill_id, outcome.level);
                player
                    .state
                    .skill_points
                    .insert(skill.book_id, outcome.remaining_sp);
                refresh_player_derived(&self.gameplay, &self.mage_skills, player);
            }
        }
        self.send_skill_result_with_request(&id, &request_id, &outcome);
        if outcome.success && skill.hyper > 0 {
            self.send_snapshot(&id);
        }
    }

    fn local_learn_skill(
        &mut self,
        id: &str,
        request_id: &str,
        skill_id: u32,
        book_id: u32,
        max_level: u32,
        prerequisites: &BTreeMap<u32, u32>,
    ) -> auth::SkillActionOutcome {
        if let Some(prior) = self
            .skill_requests
            .get(&(id.to_owned(), request_id.to_owned()))
        {
            let mut prior = prior.clone();
            prior.already_resolved = true;
            if prior.operation != "learn" || prior.skill_id != skill_id {
                prior.success = false;
                prior.code = "request_conflict".into();
            }
            return prior;
        }
        let Some(player) = self.players.get_mut(id) else {
            return auth::SkillActionOutcome {
                operation: "learn".into(),
                skill_id,
                success: false,
                code: "player_unknown".into(),
                level: 0,
                remaining_sp: 0,
                mp: 0,
                already_resolved: false,
            };
        };
        let current = player.state.skills.get(&skill_id).copied().unwrap_or(0);
        let mut outcome = auth::SkillActionOutcome {
            operation: "learn".into(),
            skill_id,
            success: false,
            code: String::new(),
            level: current,
            remaining_sp: player
                .state
                .skill_points
                .get(&book_id)
                .copied()
                .unwrap_or(0),
            mp: player.state.mp,
            already_resolved: false,
        };
        if current >= max_level {
            outcome.code = "max_level".into();
        } else if prerequisites
            .iter()
            .any(|(id, required)| player.state.skills.get(id).copied().unwrap_or(0) < *required)
        {
            outcome.code = "prerequisite".into();
        } else if hyper_skill_kind(skill_id).is_none() && outcome.remaining_sp == 0 {
            outcome.code = "not_enough_sp".into();
        } else {
            outcome.success = true;
            outcome.level = current + 1;
            if hyper_skill_kind(skill_id).is_none() {
                outcome.remaining_sp -= 1;
            }
            player.state.skills.insert(skill_id, outcome.level);
            if hyper_skill_kind(skill_id).is_none() {
                player
                    .state
                    .skill_points
                    .insert(book_id, outcome.remaining_sp);
            }
            player.state.hyper_points =
                hyper_points_for_state(player.state.level, &player.state.skills);
        }
        self.skill_requests
            .insert((id.to_owned(), request_id.to_owned()), outcome.clone());
        outcome
    }

    fn send_skill_result_with_request(
        &self,
        id: &str,
        request_id: &str,
        outcome: &auth::SkillActionOutcome,
    ) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let _ = player.output.try_send(
            serde_json::json!({
                "type": "skillResult",
                "requestId": request_id,
                "skillId": outcome.skill_id,
                "operation": outcome.operation,
                "success": outcome.success,
                "code": outcome.code,
                "level": outcome.level,
                "skillPoints": outcome.remaining_sp,
                "mp": outcome.mp,
            })
            .to_string(),
        );
    }

    fn handle_cast_skill(
        &mut self,
        id: String,
        request_id: String,
        skill_id: u32,
        direction: Option<i8>,
        vertical: Option<i8>,
    ) {
        if let Some(store) = self.store.as_ref() {
            match store.prior_skill_action(&id, &request_id, "cast", skill_id) {
                Ok(Some(outcome)) => {
                    self.send_skill_result_with_request(&id, &request_id, &outcome);
                    return;
                }
                Ok(None) => {}
                Err(error) => {
                    self.send_reject(&id, "persistence", &error, Some(&request_id));
                    return;
                }
            }
        } else if let Some(prior) = self
            .skill_requests
            .get(&(id.clone(), request_id.clone()))
            .cloned()
        {
            let mut outcome = prior;
            outcome.already_resolved = true;
            if outcome.operation != "cast" || outcome.skill_id != skill_id {
                outcome.success = false;
                outcome.code = "request_conflict".to_owned();
            }
            self.send_skill_result_with_request(&id, &request_id, &outcome);
            return;
        }
        let Some(skill) = self.mage_skills.get(skill_id).cloned() else {
            self.send_reject(&id, "skill_unknown", "未知法师技能。", Some(&request_id));
            return;
        };
        if (skill.hidden || skill.fixed_level) && skill_id != SKILL_MAGIC_WAVE_HIDDEN {
            self.send_reject(
                &id,
                "skill_hidden",
                "该技能由职业规则自动启用。",
                Some(&request_id),
            );
            return;
        }
        let Some(player) = self.players.get(&id) else {
            return;
        };
        if !skill_job_allowed(player.state.job, skill.book_id)
            || player.state.hp <= 0
            || player.state.action == "dead"
            || player.state.climbing
        {
            self.send_reject(
                &id,
                "invalid_state",
                "当前状态不能施放技能。",
                Some(&request_id),
            );
            return;
        }
        // Seal and stun both silence the skill bar: seal only blocks skills,
        // stun blocks every action and is already filtered at input, but the
        // cast path re-checks so a queued cast cannot slip through a stun.
        if player.seal_until > self.tick || player.stun_until > self.tick {
            self.send_reject(
                &id,
                "status_sealed",
                "受到異常狀態影響，無法施放技能。",
                Some(&request_id),
            );
            return;
        }
        if player.channel_until > self.tick {
            self.send_reject(&id, "skill_busy", "冰龙吐息进行中。", Some(&request_id));
            return;
        }
        let skill_level = player.state.skills.get(&skill_id).copied().unwrap_or(0);
        let Some(level) = self.mage_skills.level(skill_id, skill_level).cloned() else {
            self.send_reject(&id, "not_learned", "请先学习该技能。", Some(&request_id));
            return;
        };
        if skill.hyper > 0 && player.state.level < skill.required_level {
            self.send_reject(
                &id,
                "level_requirement",
                "尚未达到Hyper技能等级要求。",
                Some(&request_id),
            );
            return;
        }
        let mut direction = direction.unwrap_or(player.state.facing).clamp(-1, 1);
        let vertical = vertical.unwrap_or(0).clamp(-1, 1);
        if direction == 0 && vertical == 0 {
            direction = if player.state.facing < 0 { -1 } else { 1 };
        }
        if !matches!(
            skill_id,
            SKILL_MAGIC_GUARD
                | SKILL_TELEPORT
                | SKILL_ENERGY_BOLT
                | SKILL_MAGIC_WAVE
                | SKILL_MAGIC_WAVE_HIDDEN
                | SKILL_MEDITATION
                | SKILL_COLD_BEAM
                | SKILL_THUNDER_BOLT
                | SKILL_ICE_TELEPORT
                | SKILL_ICE_STORM
                | SKILL_GLACIAL_WALL
                | SKILL_THUNDER_SPHERE
                | SKILL_ELEMENTAL_ADAPTING
                | SKILL_TELEPORT_MASTERY
                | SKILL_TELEPORT_BOOST
                | SKILL_HYPER_TELEPORT_DISTANCE
                | SKILL_MAPLE_WARRIOR
                | SKILL_INFINITY
                | SKILL_ICE_DEMON
                | SKILL_CHAIN_LIGHTNING
                | SKILL_BLIZZARD
                | SKILL_MAPLE_CURE
                | SKILL_ICE_DRAGON_BREATH
                | SKILL_FROZEN_ORB
                | SKILL_HYPER_THUNDER
                | SKILL_HYPER_ADVENTURER
                | SKILL_HYPER_VORTEX
                | SKILL_THREE_SNAILS
                | SKILL_RECOVERY
                | SKILL_NIMBLE_FEET
        ) {
            self.send_reject(
                &id,
                "skill_passive",
                "被动技能不能主动施放。",
                Some(&request_id),
            );
            return;
        }
        if skill_id == SKILL_ELEMENTAL_ADAPTING && player.adaptation_cooldown_ms > 0 {
            self.send_reject(
                &id,
                "skill_cooldown",
                "元素适应尚在冷却中。",
                Some(&request_id),
            );
            return;
        }
        if player
            .skill_cooldowns
            .get(&skill_id)
            .copied()
            .is_some_and(|remaining| remaining > 0)
        {
            self.send_reject(&id, "skill_cooldown", "技能尚在冷却中。", Some(&request_id));
            return;
        }
        if skill_id == SKILL_HYPER_VORTEX
            && vertical > 0
            && player
                .skill_cooldowns
                .get(&SKILL_HYPER_VORTEX_HIDDEN)
                .copied()
                .is_some_and(|remaining| remaining > 0)
        {
            self.send_reject(
                &id,
                "skill_cooldown",
                "漩涡生成尚在冷却中。",
                Some(&request_id),
            );
            return;
        }
        let teleport = if skill_id == SKILL_TELEPORT {
            match self.plan_teleport(&id, &level, direction, vertical) {
                Ok(plan) => Some(plan),
                Err(code) => {
                    self.send_reject(&id, &code, "瞬間移動被地图碰撞阻挡。", Some(&request_id));
                    return;
                }
            }
        } else {
            None
        };
        let has_magic_wave = player
            .state
            .skills
            .get(&SKILL_MAGIC_WAVE)
            .copied()
            .unwrap_or(0)
            > 0;
        let has_magic_wave_hidden = player
            .state
            .skills
            .get(&SKILL_MAGIC_WAVE_HIDDEN)
            .copied()
            .unwrap_or(0)
            > 0;
        let has_magic_wave_skill = (skill_id == SKILL_MAGIC_WAVE && has_magic_wave)
            || (skill_id == SKILL_MAGIC_WAVE_HIDDEN && has_magic_wave_hidden);
        if matches!(skill_id, SKILL_MAGIC_WAVE | SKILL_MAGIC_WAVE_HIDDEN)
            && (!has_magic_wave_skill
                || (skill_id == SKILL_MAGIC_WAVE && vertical >= 0)
                || (skill_id == SKILL_MAGIC_WAVE_HIDDEN
                    && (vertical <= 0 || player.state.grounded))
                || (skill_id == SKILL_MAGIC_WAVE && player.magic_wave_used)
                || (skill_id == SKILL_MAGIC_WAVE_HIDDEN && player.magic_wave_float_used))
        {
            self.send_reject(
                &id,
                "skill_cooldown",
                "魔力波動当前不能使用。",
                Some(&request_id),
            );
            return;
        }
        if matches!(
            skill_id,
            SKILL_ENERGY_BOLT
                | SKILL_THREE_SNAILS
                | SKILL_COLD_BEAM
                | SKILL_THUNDER_BOLT
                | SKILL_ICE_STORM
                | SKILL_GLACIAL_WALL
                | SKILL_THUNDER_SPHERE
                | SKILL_ICE_DEMON
                | SKILL_CHAIN_LIGHTNING
                | SKILL_BLIZZARD
                | SKILL_ICE_DRAGON_BREATH
                | SKILL_FROZEN_ORB
                | SKILL_HYPER_THUNDER
        ) && player.attack_until > self.tick
        {
            self.send_reject(&id, "skill_busy", "技能动作尚未结束。", Some(&request_id));
            return;
        }
        let mut mp_cost = self.skill_mp_cost(&id, skill_id, &level, vertical);
        if skill_id == SKILL_HYPER_VORTEX && player.hyper_barrier_enabled && vertical <= 0 {
            // Turning the barrier off does not charge the next second.
            mp_cost = 0;
        }
        // 用户指定规则（2026-09-10）：瞬移全等级固定 10 MP，等级差异体现在距离与冷却。
        // 数值来自 shared/mage-skills.json#2001009（覆盖表见 scripts/tms273_skill_manifest.cjs），
        // 原版 TMS273 为 mpCon 28→20 且没有 cooltime——此处按用户指定执行，不冒充原作。
        let cooldown_ms: i64 = if skill_id == SKILL_TELEPORT {
            level.cooldown_ms.unwrap_or(0).max(0)
        } else if BEGINNER_SKILLS.contains(&skill_id)
            || skill_id == SKILL_ELEMENTAL_ADAPTING
            || (skill.book_id == FOURTH_BOOK && level.cooltime.is_some())
        {
            level.cooltime.unwrap_or(0).max(0).saturating_mul(1_000)
        } else {
            0
        };
        // 瞬移是高频移动技能：冷却只进内存 skill_cooldowns 做施放节流，不写 skill_cooldowns 表。
        // 逐次瞬移都落一条持久冷却只会制造无谓事务，秒级冷却也没有跨登录保留的意义。
        let durable_cooldown_ms = if skill_id == SKILL_TELEPORT {
            0
        } else {
            cooldown_ms
        };
        let outcome = match self.store.as_ref() {
            Some(store) if skill_id == SKILL_HYPER_VORTEX && vertical > 0 => store
                .cast_hyper_vortex(
                    &id,
                    &request_id,
                    mp_cost,
                    if vertical > 0 {
                        level.cooltime.unwrap_or(60).max(0).saturating_mul(1_000)
                    } else {
                        0
                    },
                ),
            Some(store) if durable_cooldown_ms > 0 => store.cast_skill_with_cooldown(
                &id,
                &request_id,
                skill_id,
                skill.book_id,
                skill.book_id,
                skill.max_level,
                mp_cost,
                cooldown_ms,
            ),
            Some(store) => store.cast_skill(
                &id,
                &request_id,
                skill_id,
                skill.book_id,
                skill.book_id,
                skill.max_level,
                mp_cost,
            ),
            None => Ok(self.local_cast_skill(&id, &request_id, skill_id, skill.book_id, mp_cost)),
        };
        let Ok(outcome) = outcome else {
            self.send_reject(
                &id,
                "persistence",
                "技能施放保存失败，请重试。",
                Some(&request_id),
            );
            return;
        };
        if outcome.already_resolved {
            self.send_skill_result_with_request(&id, &request_id, &outcome);
            return;
        }
        if !outcome.success {
            self.send_skill_result_with_request(&id, &request_id, &outcome);
            return;
        }
        if let Some(player) = self.players.get_mut(&id) {
            player.state.mp = outcome.mp;
            if cooldown_ms > 0 {
                player
                    .skill_cooldowns
                    .insert(skill_id, u64::try_from(cooldown_ms).unwrap_or(u64::MAX));
            }
            if skill_id == SKILL_HYPER_VORTEX && vertical > 0 {
                let vortex_cooldown = u64::try_from(level.cooltime.unwrap_or(60).max(0))
                    .unwrap_or(60)
                    .saturating_mul(1_000);
                if vortex_cooldown > 0 {
                    player
                        .skill_cooldowns
                        .insert(SKILL_HYPER_VORTEX_HIDDEN, vortex_cooldown);
                }
            }
        }
        let duration_ms = if skill_id == SKILL_THREE_SNAILS {
            SKILL_CAST_DURATION_MS
        } else if skill_id == SKILL_HYPER_THUNDER {
            780
        } else if matches!(skill_id, SKILL_HYPER_ADVENTURER | SKILL_HYPER_VORTEX) {
            600
        } else if skill_id == SKILL_MAGIC_WAVE_HIDDEN {
            level.time.unwrap_or(5).max(0).try_into().unwrap_or(5_000) * 1_000
        } else if skill_id == SKILL_INFINITY {
            // The source has an alert/activation action but no authored
            // duration field.  Keep the visual cast finite and independent
            // of weapon action speed; the actual buff duration is tracked
            // separately by activate_infinity.
            600
        } else if skill_id == SKILL_ICE_DRAGON_BREATH {
            // q is the held-key maximum from String.h.  Master Magic
            // buff-time does not extend this channel ceiling.
            u64::try_from(level.q.unwrap_or(0).max(0)).unwrap_or(0) * 1_000
        } else if matches!(
            skill_id,
            SKILL_ENERGY_BOLT
                | SKILL_MAGIC_WAVE
                | SKILL_COLD_BEAM
                | SKILL_THUNDER_BOLT
                | SKILL_ICE_STORM
                | SKILL_GLACIAL_WALL
                | SKILL_THUNDER_SPHERE
                | SKILL_ICE_DEMON
                | SKILL_CHAIN_LIGHTNING
                | SKILL_BLIZZARD
                | SKILL_ICE_DRAGON_BREATH
                | SKILL_FROZEN_ORB
                | SKILL_HYPER_THUNDER
                | SKILL_HYPER_VORTEX
        ) {
            if skill_id == SKILL_ENERGY_BOLT {
                self.energy_duration_ms(&id)
            } else {
                self.skill_duration_ms(&id, skill_id)
            }
        } else {
            0
        };
        let event = if skill_id == SKILL_HYPER_THUNDER {
            self.skill_cast_event_phase(
                &id,
                &request_id,
                skill_id,
                duration_ms,
                &level,
                Some("prepare"),
                None,
            )
        } else {
            self.skill_cast_event(
                &id,
                &request_id,
                skill_id,
                duration_ms,
                &level,
                (skill_id == SKILL_THREE_SNAILS).then_some(skill_level),
            )
        };
        let map_id = self.players.get(&id).map(|player| player.map_id.clone());
        if let Some(map_id) = map_id.as_deref() {
            self.broadcast_to_map(map_id, &event);
        }
        match skill_id {
            SKILL_MAGIC_GUARD => {
                if let Some(player) = self.players.get_mut(&id) {
                    player.magic_guard = !player.magic_guard;
                    refresh_player_derived(&self.gameplay, &self.mage_skills, player);
                }
            }
            SKILL_TELEPORT => {
                if let Some(plan) = teleport {
                    let start = self
                        .players
                        .get(&id)
                        .map(|player| (player.state.x, player.state.y));
                    self.apply_teleport(&id, plan);
                    if let Some((start_x, start_y)) = start {
                        self.maybe_create_ice_field(&id, start_x, start_y);
                    }
                    let mastery = self.players.get(&id).and_then(|player| {
                        player
                            .teleport_mastery_enabled
                            .then(|| player.state.skills.get(&SKILL_TELEPORT_MASTERY).copied())
                            .flatten()
                            .and_then(|level| self.mage_skills.level(SKILL_TELEPORT_MASTERY, level))
                            .cloned()
                    });
                    if let Some(mastery) = mastery {
                        if let Err(error) = self.cast_teleport_mastery(&id, &request_id, &mastery) {
                            self.handle_accepted_effect_error(&id, &request_id, &error);
                            return;
                        }
                    }
                }
            }
            SKILL_MEDITATION => self.apply_meditation(&id, &level),
            SKILL_COLD_BEAM => {
                if let Err(error) =
                    self.cast_elemental_area(&id, &request_id, skill_id, &level, false)
                {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.action = "attack";
                    player.state.action_started_tick = self.tick;
                    player.attack_until = self.tick + duration_ms.div_ceil(TICK_MS).max(1);
                }
            }
            SKILL_THUNDER_BOLT => {
                if let Err(error) =
                    self.cast_elemental_area(&id, &request_id, skill_id, &level, true)
                {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.action = "attack";
                    player.state.action_started_tick = self.tick;
                    player.attack_until = self.tick + duration_ms.div_ceil(TICK_MS).max(1);
                }
            }
            SKILL_ICE_STORM => {
                if let Err(error) =
                    self.cast_elemental_area(&id, &request_id, skill_id, &level, false)
                {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.action = "attack";
                    player.state.action_started_tick = self.tick;
                    player.attack_until = self.tick + duration_ms.div_ceil(TICK_MS).max(1);
                }
            }
            SKILL_GLACIAL_WALL => {
                if let Err(error) = self.cast_glacial_wall(&id, &request_id, &level) {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.action = "attack";
                    player.state.action_started_tick = self.tick;
                    player.attack_until = self.tick + duration_ms.div_ceil(TICK_MS).max(1);
                }
            }
            SKILL_THUNDER_SPHERE => {
                if let Err(error) = self.cast_thunder_sphere(&id, &request_id, &level, vertical) {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.action = "attack";
                    player.state.action_started_tick = self.tick;
                    player.attack_until = self.tick + duration_ms.div_ceil(TICK_MS).max(1);
                }
            }
            SKILL_ELEMENTAL_ADAPTING => {
                if let Some(player) = self.players.get_mut(&id) {
                    // Elemental Adapting is a guarded activation with a
                    // durable cooldown, not an on/off toggle.  A successful
                    // cast always refreshes its source charge count.
                    player.adaptation_active = true;
                    player.adaptation_charges = u32::try_from(level.y.unwrap_or(7).max(0))
                        .unwrap_or(0)
                        .max(1);
                    player.adaptation_cooldown_ms = u64::try_from(cooldown_ms).unwrap_or(0);
                }
            }
            SKILL_MAPLE_WARRIOR => {
                let duration_ms = self.buff_duration_ms(
                    &id,
                    &level,
                    level.time.unwrap_or(0).max(0) as u64 * 1_000,
                );
                if let Some(player) = self.players.get_mut(&id) {
                    player.skill_buffs.insert(SKILL_MAPLE_WARRIOR, duration_ms);
                }
            }
            SKILL_INFINITY => {
                if let Err(error) = self.activate_infinity(&id, &level) {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
            }
            SKILL_ICE_DEMON => {
                if let Err(error) = self.cast_ice_demon(&id, &request_id, &level) {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.action = "attack";
                    player.state.action_started_tick = self.tick;
                    player.attack_until = self.tick + duration_ms.div_ceil(TICK_MS).max(1);
                }
            }
            SKILL_CHAIN_LIGHTNING | SKILL_BLIZZARD => {
                if let Err(error) = self.cast_elemental_area(
                    &id,
                    &request_id,
                    skill_id,
                    &level,
                    skill_id == SKILL_CHAIN_LIGHTNING,
                ) {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.action = "attack";
                    player.state.action_started_tick = self.tick;
                    player.attack_until = self.tick + duration_ms.div_ceil(TICK_MS).max(1);
                }
                if skill_id == SKILL_CHAIN_LIGHTNING {
                    self.apply_chain_stun(&id, &request_id, &level);
                }
            }
            SKILL_MAPLE_CURE => self.activate_status_cleanse(&id, &level),
            SKILL_ICE_DRAGON_BREATH => {
                if let Err(error) = self.cast_ice_dragon_breath(&id, &request_id, &level) {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.action = "attack";
                    player.state.action_started_tick = self.tick;
                    player.attack_until = player.channel_until;
                }
            }
            SKILL_HYPER_THUNDER => {
                if let Err(error) = self.start_hyper_thunder(&id, &request_id, &level) {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
            }
            SKILL_HYPER_ADVENTURER => {
                self.activate_hyper_adventurer(&id, &level);
            }
            SKILL_HYPER_VORTEX => {
                if let Err(error) = self.activate_hyper_vortex(&id, &request_id, &level, vertical) {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
            }
            SKILL_FROZEN_ORB => {
                if let Err(error) = self.cast_frozen_orb(&id, &request_id, &level) {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.action = "attack";
                    player.state.action_started_tick = self.tick;
                    player.attack_until = self.tick + duration_ms.div_ceil(TICK_MS).max(1);
                }
            }
            SKILL_THREE_SNAILS => {
                if let Err(error) = self.cast_beginner_throw(&id, &request_id, &level, skill_level)
                {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.action = "attack";
                    player.state.action_started_tick = self.tick;
                    player.attack_until = self.tick + duration_ms.div_ceil(TICK_MS).max(1);
                }
            }
            SKILL_RECOVERY | SKILL_NIMBLE_FEET => {
                self.activate_beginner_buff(&id, skill_id, &level);
            }
            SKILL_TELEPORT_MASTERY => {
                if let Some(player) = self.players.get_mut(&id) {
                    player.teleport_mastery_enabled = !player.teleport_mastery_enabled;
                }
            }
            SKILL_TELEPORT_BOOST => {
                if let Some(player) = self.players.get_mut(&id) {
                    player.teleport_boost_enabled = !player.teleport_boost_enabled;
                    if player.teleport_boost_enabled {
                        player.hyper_teleport_enabled = false;
                    }
                }
            }
            SKILL_HYPER_TELEPORT_DISTANCE => {
                if let Some(player) = self.players.get_mut(&id) {
                    player.hyper_teleport_enabled = !player.hyper_teleport_enabled;
                    if player.hyper_teleport_enabled {
                        player.teleport_boost_enabled = false;
                    }
                }
            }
            SKILL_ICE_TELEPORT => {
                if let Some(player) = self.players.get_mut(&id) {
                    player.ice_teleport_enabled = !player.ice_teleport_enabled;
                }
            }
            SKILL_MAGIC_WAVE | SKILL_MAGIC_WAVE_HIDDEN => {
                self.apply_magic_wave(&id, &level, vertical, skill_id == SKILL_MAGIC_WAVE_HIDDEN)
            }
            SKILL_ENERGY_BOLT => {
                if let Err(error) = self.cast_energy_bolt(&id, &request_id, skill_id, &level) {
                    self.handle_accepted_effect_error(&id, &request_id, &error);
                    return;
                }
            }
            _ => {}
        }
        if let Some(player) = self.players.get_mut(&id) {
            refresh_player_derived(&self.gameplay, &self.mage_skills, player);
        }
        if self.store.is_some() {
            if let Err(error) = self.persist_player(&id) {
                self.handle_accepted_effect_error(&id, &request_id, &error);
                return;
            }
        }
        self.send_skill_result_with_request(&id, &request_id, &outcome);
    }

    fn handle_release_skill(&mut self, id: String, request_id: String) {
        let Some((channel_skill, channel_request, channel_until, hp, action)) =
            self.players.get(&id).map(|player| {
                (
                    player.channel_skill_id,
                    player.channel_request_id.clone(),
                    player.channel_until,
                    player.state.hp,
                    player.state.action,
                )
            })
        else {
            return;
        };
        let valid = matches!(
            channel_skill,
            Some(SKILL_ICE_DRAGON_BREATH) | Some(SKILL_HYPER_THUNDER)
        ) && channel_request
            .as_deref()
            .is_some_and(|value| value == request_id)
            && channel_until > self.tick
            && action != "dead"
            && hp > 0;
        if !valid {
            // Key-up can arrive after the channel naturally expired, after a
            // death/map change cleared it, or as a duplicate network packet.
            // Treat those cases as an idempotent no-op so a stale release
            // cannot surface a false gameplay error or affect a new channel.
            return;
        }
        if channel_skill == Some(SKILL_HYPER_THUNDER) {
            if let Err(error) = self.finish_hyper_thunder(&id, &request_id) {
                self.handle_accepted_effect_error(&id, &request_id, &error);
            }
            return;
        }
        let Some(player) = self.players.get_mut(&id) else {
            return;
        };
        player.channel_request_id = None;
        player.channel_skill_id = None;
        player.channel_until = 0;
        player.channel_level = 0;
        player.skill_buffs.remove(&SKILL_ICE_DRAGON_BREATH);
        player.attack_until = self.tick;
        player.state.action = "stand";
        player.state.action_started_tick = self.tick;
        let map_id = player.map_id.clone();
        let event = serde_json::json!({
            "type": "skillCast",
            "eventId": format!("skill-release-{id}-{request_id}"),
            "serverTick": self.tick,
            "playerId": id,
            "skillId": SKILL_ICE_DRAGON_BREATH,
            "requestId": request_id,
            "x": player.state.x,
            "y": player.state.y,
            "facing": player.state.facing,
            "durationMs": 0,
            "released": true,
        })
        .to_string();
        refresh_player_derived(&self.gameplay, &self.mage_skills, player);
        self.broadcast_to_map(&map_id, &event);
    }

    fn handle_accepted_effect_error(&mut self, id: &str, request_id: &str, error: &str) {
        // MP/cooldown was already committed by auth.  Never turn a durable
        // cast into a client-visible retry that could spend it twice.  A
        // fresh snapshot lets the client reconcile MP/toggles before the next
        // request; the explicit code tells it that only the effect failed.
        self.send_reject(id, "effect_persistence", error, Some(request_id));
        self.send_snapshot(id);
    }

    fn skill_mp_cost(&self, id: &str, skill_id: u32, level: &MageLevel, vertical: i8) -> i64 {
        // Hyper Thunder's accepted cast is the first sustained pulse: the P
        // contract charges its authored 30 MP up front and starts the durable
        // 60-second cooldown.  Keep it outside Amp/Infinity adjustments so a
        // tap cannot create a free release or an under/overcharged first hit.
        if skill_id == SKILL_HYPER_THUNDER {
            return level.mp_con.unwrap_or(30).max(0);
        }
        let mut cost = level.mp_con.unwrap_or(0).max(0);
        if is_magic_attack_skill(skill_id) {
            let amp_level = self
                .players
                .get(id)
                .and_then(|player| player.state.skills.get(&SKILL_ELEMENT_AMP))
                .copied()
                .and_then(|level| self.mage_skills.level(SKILL_ELEMENT_AMP, level));
            if let Some(amp) = amp_level {
                cost = cost.saturating_mul(100 + amp.costmp_r.unwrap_or(0).max(0)) / 100;
            }
        }
        if skill_id == SKILL_TELEPORT {
            if let Some(master_level) = self
                .players
                .get(id)
                .and_then(|player| player.state.skills.get(&SKILL_TELEPORT_MASTERY))
                .copied()
                .and_then(|level| self.mage_skills.level(SKILL_TELEPORT_MASTERY, level))
            {
                if self
                    .players
                    .get(id)
                    .is_some_and(|player| player.teleport_mastery_enabled)
                {
                    cost = cost.saturating_add(master_level.y.unwrap_or(0).max(0));
                }
            }
        } else if skill_id == SKILL_TELEPORT_BOOST
            && self
                .players
                .get(id)
                .is_some_and(|player| player.teleport_boost_enabled)
        {
            // Turning the toggle off has no source MP cost.
            cost = 0;
        } else if skill_id == SKILL_THUNDER_SPHERE
            && vertical > 0
            && self.players.get(id).is_some_and(|player| {
                player.summon.as_ref().is_some_and(|summon| {
                    matches!(
                        summon.skill_id,
                        SKILL_THUNDER_SPHERE | SKILL_THUNDER_SPHERE_HIDDEN
                    )
                })
            })
        {
            // Re-anchoring the existing sphere is a control action; only the
            // initial summon consumes its authored mpCon.
            cost = 0;
        }
        // Infinity is an authoritative active buff.  Its no-MP rule applies
        // to every other accepted skill, including skills whose source value
        // is zero or whose Elemental Amp adjustment was already calculated.
        if skill_id != SKILL_INFINITY
            && self.players.get(id).is_some_and(|player| {
                player
                    .skill_buffs
                    .get(&SKILL_INFINITY)
                    .copied()
                    .is_some_and(|remaining| remaining > 0)
            })
        {
            cost = 0;
        }
        cost
    }

    fn local_cast_skill(
        &mut self,
        id: &str,
        request_id: &str,
        skill_id: u32,
        book_id: u32,
        mp_cost: i64,
    ) -> auth::SkillActionOutcome {
        if let Some(prior) = self
            .skill_requests
            .get(&(id.to_owned(), request_id.to_owned()))
        {
            let mut prior = prior.clone();
            prior.already_resolved = true;
            if prior.operation != "cast" || prior.skill_id != skill_id {
                prior.success = false;
                prior.code = "request_conflict".into();
            }
            return prior;
        }
        let Some(player) = self.players.get_mut(id) else {
            return auth::SkillActionOutcome {
                operation: "cast".into(),
                skill_id,
                success: false,
                code: "player_unknown".into(),
                level: 0,
                remaining_sp: 0,
                mp: 0,
                already_resolved: false,
            };
        };
        let level = player.state.skills.get(&skill_id).copied().unwrap_or(0);
        let mut outcome = auth::SkillActionOutcome {
            operation: "cast".into(),
            skill_id,
            success: level > 0 && player.state.mp >= mp_cost,
            code: String::new(),
            level,
            remaining_sp: player
                .state
                .skill_points
                .get(&book_id)
                .copied()
                .unwrap_or(0),
            mp: player.state.mp,
            already_resolved: false,
        };
        if level == 0 {
            outcome.success = false;
            outcome.code = "not_learned".into();
        } else if player.state.mp < mp_cost {
            outcome.success = false;
            outcome.code = "not_enough_mp".into();
        } else {
            player.state.mp -= mp_cost;
            outcome.mp = player.state.mp;
        }
        self.skill_requests
            .insert((id.to_owned(), request_id.to_owned()), outcome.clone());
        outcome
    }

    fn skill_cast_event(
        &self,
        id: &str,
        request_id: &str,
        skill_id: u32,
        duration_ms: u64,
        level: &MageLevel,
        skill_level: Option<u32>,
    ) -> String {
        let (x, y, facing) = self
            .players
            .get(id)
            .map(|player| (player.state.x, player.state.y, player.state.facing))
            .unwrap_or((0.0, 0.0, 1));
        let mut value = serde_json::json!({
            "type": "skillCast",
            "eventId": format!("skill-cast-{id}-{request_id}"),
            "serverTick": self.tick,
            "playerId": id,
            "skillId": skill_id,
            "requestId": request_id,
            "x": x,
            "y": y,
            "facing": facing,
            "durationMs": duration_ms,
        });
        if let Some(skill_level) = skill_level {
            value["skillLevel"] = skill_level.into();
        }
        if matches!(
            skill_id,
            SKILL_THREE_SNAILS
                | SKILL_ENERGY_BOLT
                | SKILL_COLD_BEAM
                | SKILL_THUNDER_BOLT
                | SKILL_ICE_STORM
                | SKILL_GLACIAL_WALL
                | SKILL_TELEPORT_MASTERY
                | SKILL_THUNDER_SPHERE
                | SKILL_ICE_DEMON
                | SKILL_CHAIN_LIGHTNING
                | SKILL_BLIZZARD
                | SKILL_ICE_DRAGON_BREATH
                | SKILL_FROZEN_ORB
                | SKILL_HYPER_THUNDER
                | SKILL_HYPER_VORTEX
        ) {
            let target_ids = if skill_id == SKILL_THREE_SNAILS {
                self.beginner_throw_targets(id)
            } else if skill_id == SKILL_ENERGY_BOLT {
                self.energy_targets(id, level)
            } else {
                self.skill_area_targets(id, skill_id, level)
            };
            if let Some(target_id) = target_ids.first() {
                if let Some(target) = self.monsters.get(target_id) {
                    value["targetId"] = serde_json::Value::String(target_id.to_owned());
                    value["targetX"] = target.state.x.into();
                    value["targetY"] = target.state.y.into();
                }
            } else {
                let range = if skill_id == SKILL_THREE_SNAILS {
                    BEGINNER_THROW_RANGE
                } else {
                    level.range.unwrap_or(0).max(0) as f64
                };
                value["targetX"] = (x + f64::from(if facing < 0 { -1 } else { 1 }) * range).into();
                value["targetY"] = y.into();
            }
        }
        value.to_string()
    }

    fn skill_cast_event_phase(
        &self,
        id: &str,
        request_id: &str,
        skill_id: u32,
        duration_ms: u64,
        level: &MageLevel,
        phase: Option<&str>,
        skill_level: Option<u32>,
    ) -> String {
        let mut value: serde_json::Value = serde_json::from_str(&self.skill_cast_event(
            id,
            request_id,
            skill_id,
            duration_ms,
            level,
            skill_level,
        ))
        .unwrap_or_else(|_| serde_json::json!({"type":"skillCast"}));
        if let Some(phase) = phase {
            value["phase"] = serde_json::Value::String(phase.to_owned());
        }
        value.to_string()
    }

    fn activate_beginner_buff(&mut self, id: &str, skill_id: u32, level: &MageLevel) {
        let duration_ms = u64::try_from(level.time.unwrap_or(0).max(0))
            .unwrap_or(0)
            .saturating_mul(1_000);
        let duration_ms = self.buff_duration_ms(id, level, duration_ms);
        if duration_ms == 0 {
            return;
        }
        let Some(player) = self.players.get_mut(id) else {
            return;
        };
        player.skill_buffs.insert(skill_id, duration_ms);
        match skill_id {
            SKILL_RECOVERY => {
                player.beginner_heal_next_tick = self
                    .tick
                    .saturating_add((BEGINNER_HEAL_TICK_MS / TICK_MS).max(1));
                player.beginner_heal_remaining_ticks = BEGINNER_HEAL_TICKS;
                player.beginner_heal_per_tick = level.x.unwrap_or(0).max(0);
            }
            SKILL_NIMBLE_FEET => {
                player.beginner_speed_percent = level.speed.unwrap_or(0).clamp(0, 100);
            }
            _ => {}
        }
    }

    fn beginner_throw_targets(&self, id: &str) -> Vec<String> {
        // P: the selected export has no authoritative 1000 rectangle/range.
        // Reuse the existing remote bolt adapter's 340 px range while keeping
        // the source's single target/count semantics explicit.
        let level = MageLevel {
            range: Some(BEGINNER_THROW_RANGE as i64),
            mob_count: Some(1),
            attack_count: Some(1),
            ..MageLevel::default()
        };
        self.energy_targets(id, &level)
    }

    fn apply_beginner_heal_tick(&mut self, id: &str) {
        let Some((state, map_id, death_id, base_max_mp, next_tick, remaining_ticks, per_tick)) =
            self.players.get(id).and_then(|player| {
                (player
                    .skill_buffs
                    .get(&SKILL_RECOVERY)
                    .copied()
                    .is_some_and(|remaining| remaining > 0))
                .then(|| {
                    (
                        player.state.clone(),
                        player.map_id.clone(),
                        player.death_id.clone(),
                        player.base_max_mp,
                        player.beginner_heal_next_tick,
                        player.beginner_heal_remaining_ticks,
                        player.beginner_heal_per_tick,
                    )
                })
            })
        else {
            return;
        };
        if state.hp <= 0 || next_tick > self.tick || remaining_ticks == 0 || per_tick <= 0 {
            return;
        }
        let healed_hp = state.hp.saturating_add(per_tick).min(state.max_hp.max(1));
        let next_remaining_ticks = remaining_ticks.saturating_sub(1);
        let next_tick = if next_remaining_ticks > 0 {
            self.tick
                .saturating_add((BEGINNER_HEAL_TICK_MS / TICK_MS).max(1))
        } else {
            0
        };
        if healed_hp != state.hp {
            let mut healed_state = state;
            healed_state.hp = healed_hp;
            if let Some(store) = self.store.as_ref() {
                let profile = profile_from_state(&healed_state, &map_id, &death_id, base_max_mp);
                // The durable profile is written before the in-memory HP is
                // advanced.  A transient DB failure therefore cannot make a
                // heal appear in a snapshot that was never saved.
                if store.save_profile(id, &profile).is_err() {
                    return;
                }
            }
            if let Some(player) = self.players.get_mut(id) {
                player.state.hp = healed_hp;
            }
        }
        if let Some(player) = self.players.get_mut(id) {
            player.beginner_heal_remaining_ticks = next_remaining_ticks;
            player.beginner_heal_next_tick = next_tick;
        }
    }

    /// Apply one authoritative one-second natural-recovery interval.  The
    /// candidate profile is durable before HP/MP advance in memory; a failed
    /// write schedules only the next one-second retry and never replays the
    /// failed interval on every 50 ms tick.
    fn step_natural_recovery(&mut self, id: &str) {
        let retry_tick = self.tick.saturating_add(NATURAL_RECOVERY_INTERVAL_TICKS);
        let (state, map_id, death_id, base_max_mp, hp_per_second, mp_per_second) = {
            let Some(player) = self.players.get_mut(id) else {
                return;
            };
            if player.state.hp <= 0 || player.state.action == "dead" {
                player.natural_recovery_next_tick = retry_tick;
                return;
            }
            if player.natural_recovery_next_tick > self.tick {
                return;
            }
            let (hp_per_second, mp_per_second) = regeneration_passives_for_job(player.state.job)
                .into_iter()
                .fold((0_i64, 0_i64), |(hp, mp), passive| {
                    (
                        hp.saturating_add(passive.hp_per_second.max(0)),
                        mp.saturating_add(passive.mp_per_second.max(0)),
                    )
                });
            if player.state.hp >= player.state.max_hp.max(0)
                && player.state.mp >= player.state.max_mp.max(0)
            {
                player.natural_recovery_next_tick = retry_tick;
                return;
            }
            (
                player.state.clone(),
                player.map_id.clone(),
                player.death_id.clone(),
                player.base_max_mp,
                hp_per_second,
                mp_per_second,
            )
        };
        let candidate_hp = state
            .hp
            .saturating_add(hp_per_second)
            .min(state.max_hp.max(0));
        let candidate_mp = state
            .mp
            .saturating_add(mp_per_second)
            .min(state.max_mp.max(0));
        if candidate_hp == state.hp && candidate_mp == state.mp {
            // Full resources consume the interval without issuing an SQLite
            // write, so taking damage immediately after a full interval still
            // waits for a complete new second before recovery.
            if let Some(player) = self.players.get_mut(id) {
                player.natural_recovery_next_tick = retry_tick;
            }
            return;
        }
        let mut candidate = state;
        candidate.hp = candidate_hp;
        candidate.mp = candidate_mp;
        if let Some(store) = self.store.as_ref() {
            if store
                .save_profile(
                    id,
                    &profile_from_state(&candidate, &map_id, &death_id, base_max_mp),
                )
                .is_err()
            {
                if let Some(player) = self.players.get_mut(id) {
                    player.natural_recovery_next_tick = retry_tick;
                }
                return;
            }
        }
        if let Some(player) = self.players.get_mut(id) {
            player.state.hp = candidate_hp;
            player.state.mp = candidate_mp;
            player.natural_recovery_next_tick = retry_tick;
        }
    }

    fn buff_duration_ms(&self, id: &str, level: &MageLevel, base_ms: u64) -> u64 {
        let bufftime = self
            .players
            .get(id)
            .and_then(|player| player.state.skills.get(&SKILL_MASTER_MAGIC))
            .copied()
            .and_then(|level| self.mage_skills.level(SKILL_MASTER_MAGIC, level))
            .and_then(|level| level.buff_time_r)
            .unwrap_or(0)
            .max(0) as u64;
        let _ = level;
        base_ms.saturating_mul(100 + bufftime) / 100
    }

    fn activate_infinity(&mut self, id: &str, level: &MageLevel) -> Result<(), String> {
        let base_ms = u64::try_from(level.time.unwrap_or(0).max(0))
            .map_err(|_| "infinity_duration_invalid".to_owned())?
            .saturating_mul(1_000);
        let duration_ms = self.buff_duration_ms(id, level, base_ms);
        if duration_ms == 0 {
            return Err("infinity_duration_invalid".to_owned());
        }
        let next_tick = self.tick.saturating_add((5_000_u64 / TICK_MS).max(1));
        let initial_bonus = level.q.unwrap_or(0).max(0);
        let Some(player) = self.players.get_mut(id) else {
            return Err("player_unknown".to_owned());
        };
        player.skill_buffs.insert(SKILL_INFINITY, duration_ms);
        player.infinity_next_tick = next_tick;
        player.infinity_damage_bonus = initial_bonus.min(level.w.unwrap_or(0).max(0));
        Ok(())
    }

    /// Apply Infinity's five-second HP/MP candidate only after the profile
    /// write succeeds.  The damage stage is session state and advances on the
    /// same successful interval; a failed write leaves both stages retryable.
    fn step_infinity_tick(&mut self, id: &str) {
        let Some(snapshot) = self.players.get(id).map(|player| {
            (
                player.state.clone(),
                player.map_id.clone(),
                player.death_id.clone(),
                player.base_max_mp,
                player.infinity_next_tick,
                player
                    .skill_buffs
                    .get(&SKILL_INFINITY)
                    .copied()
                    .unwrap_or(0),
                player
                    .state
                    .skills
                    .get(&SKILL_INFINITY)
                    .copied()
                    .and_then(|level| self.mage_skills.level(SKILL_INFINITY, level).cloned()),
            )
        }) else {
            return;
        };
        let (state, map_id, death_id, base_max_mp, next_tick, remaining, level) = snapshot;
        if remaining == 0 || next_tick > self.tick || state.hp <= 0 {
            return;
        }
        let Some(level) = level else {
            return;
        };
        let percent = level.y.unwrap_or(0).clamp(0, 100);
        let hp_gain = state.max_hp.max(0).saturating_mul(percent) / 100;
        // String.h specifies the base MP recovery.  Do not let Magic Boost,
        // equipment, or a previous recomputation turn the tick into a larger
        // percentage of the derived MP pool.
        let mp_gain = base_max_mp.max(0).saturating_mul(percent) / 100;
        let candidate_hp = state.hp.saturating_add(hp_gain).min(state.max_hp.max(1));
        let candidate_mp = state.mp.saturating_add(mp_gain).min(state.max_mp.max(0));
        let mut candidate = state.clone();
        candidate.hp = candidate_hp;
        candidate.mp = candidate_mp;
        if let Some(store) = self.store.as_ref() {
            if store
                .save_profile(
                    &id,
                    &profile_from_state(&candidate, &map_id, &death_id, base_max_mp),
                )
                .is_err()
            {
                return;
            }
        }
        if let Some(player) = self.players.get_mut(id) {
            player.state.hp = candidate_hp;
            player.state.mp = candidate_mp;
            let increment = level.damage.unwrap_or(0).max(0);
            let cap = level.w.unwrap_or(0).max(0);
            player.infinity_damage_bonus = player
                .infinity_damage_bonus
                .saturating_add(increment)
                .min(cap.max(player.infinity_damage_bonus));
            player.infinity_next_tick = self.tick.saturating_add((5_000_u64 / TICK_MS).max(1));
        }
    }

    fn activate_status_cleanse(&mut self, id: &str, _level: &MageLevel) {
        let Some(player) = self.players.get_mut(id) else {
            return;
        };
        // 楓葉淨化 (Maple Cure) now actually clears the monster-inflicted
        // abnormal statuses modelled below, then re-arms the source's separate
        // three-second immunity window.  The immunity deadline is consumed by
        // the abnormal-status entry point, so a cleanse both removes current
        // diseases and blocks new ones for the authored window.
        player.seal_until = 0;
        player.stun_until = 0;
        player.curse_until = 0;
        player.poison_until = 0;
        player.slow_until = 0;
        player.poison_next_tick = 0;
        player.curse_next_tick = 0;
        player.status_immune_until = self.tick.saturating_add((3_000_u64 / TICK_MS).max(1));
        player.skill_buffs.insert(SKILL_MAPLE_CURE, 3_000);
    }

    /// Resolve the player-side defenses against one monster disease, returning
    /// `true` when the disease is blocked.  The order is authoritative and
    /// mirrors the authored layers:
    ///   1. 楓葉淨化 immunity window (`status_immune_until`) — a fresh cleanse
    ///      blocks everything for its three-second deadline;
    ///   2. 元素適應 charges (`adaptation_charges`) — one charge negates one
    ///      incoming abnormal status and is consumed on use;
    ///   3. 元素適應 status resistance (`asrR`) — a percent chance to shrug it
    ///      off entirely.
    /// A consumed charge / immune window is a real cost, so a blocked disease
    /// still spends the defence rather than being a free no-op.
    fn disease_is_blocked(&mut self, id: &str, parts: &[&str]) -> bool {
        // Read the resistance number first (immutable borrow released before
        // the mutable borrow below), then consume the defence layers.
        let resistance = self
            .players
            .get(id)
            .and_then(|player| player.state.skills.get(&SKILL_ELEMENTAL_ADAPTING))
            .copied()
            .and_then(|level| self.mage_skills.level(SKILL_ELEMENTAL_ADAPTING, level))
            .and_then(|level| level.asr_r)
            .unwrap_or(0)
            .clamp(0, 100) as u64;
        let Some(player) = self.players.get_mut(id) else {
            return true;
        };
        if self.tick < player.status_immune_until {
            return true;
        }
        if player.adaptation_active && player.adaptation_charges > 0 {
            player.adaptation_charges -= 1;
            return true;
        }
        resistance > 0 && deterministic_percent(parts) < resistance
    }

    /// Inflict one modelled disease on a player, honouring the defence layers
    /// above and writing the authoritative deadline.  The duration comes from
    /// the resolved MobSkill effect (`time` seconds for debuff skills, or the
    /// authored contact `bodyDiseaseLevel`-scaled window).  Returns `false`
    /// when the disease was blocked or the source authored no usable duration.
    fn inflict_disease(
        &mut self,
        id: &str,
        disease: PlayerDisease,
        duration_ms: u64,
        monster_id: &str,
    ) -> bool {
        if duration_ms == 0 {
            return false;
        }
        let parts = [id, monster_id, disease.as_str(), &self.tick.to_string()];
        if self.disease_is_blocked(id, &parts) {
            return false;
        }
        let Some(player) = self.players.get_mut(id) else {
            return false;
        };
        let deadline = self
            .tick
            .saturating_add((duration_ms / TICK_MS).max(1));
        match disease {
            PlayerDisease::Seal => player.seal_until = deadline,
            PlayerDisease::Stun => player.stun_until = deadline,
            PlayerDisease::Curse => {
                player.curse_until = deadline;
                player.curse_next_tick = self.tick.saturating_add(1);
            }
            PlayerDisease::Poison => {
                player.poison_until = deadline;
                player.poison_next_tick = self.tick.saturating_add(1);
            }
            PlayerDisease::Slow => player.slow_until = deadline,
        }
        true
    }

    fn cast_ice_demon(
        &mut self,
        id: &str,
        request_id: &str,
        level: &MageLevel,
    ) -> Result<(), String> {
        let Some((map_id, x, y, facing, skill_level)) = self.players.get(id).map(|player| {
            (
                player.map_id.clone(),
                player.state.x,
                player.state.y,
                player.state.facing,
                player
                    .state
                    .skills
                    .get(&SKILL_ICE_DEMON)
                    .copied()
                    .unwrap_or(1),
            )
        }) else {
            return Err("player_unknown".to_owned());
        };
        let duration_ticks = u64::try_from(level.time.unwrap_or(0).max(0))
            .unwrap_or(0)
            .saturating_mul(1_000)
            .div_ceil(TICK_MS)
            .max(1);
        let summon = ThunderSummon {
            summon_id: format!("ice-demon-{id}-{request_id}"),
            skill_id: SKILL_ICE_DEMON,
            level: skill_level,
            map_id,
            x,
            y,
            facing,
            anchored: true,
            expires_at: self.tick.saturating_add(duration_ticks),
            next_hit_at: self.tick.saturating_add((1_080_u64 / TICK_MS).max(1)),
            pulse_index: 0,
        };
        let Some(player) = self.players.get_mut(id) else {
            return Err("player_unknown".to_owned());
        };
        player.summons.retain(|old| old.skill_id != SKILL_ICE_DEMON);
        if player.summons.len() >= 2 {
            return Err("summon_limit".to_owned());
        }
        player.summons.push(summon);
        Ok(())
    }

    fn cast_frozen_orb(
        &mut self,
        id: &str,
        request_id: &str,
        _level: &MageLevel,
    ) -> Result<(), String> {
        let Some((map_id, x, y, facing, skill_level)) = self.players.get(id).map(|player| {
            (
                player.map_id.clone(),
                player.state.x,
                player.state.y,
                player.state.facing,
                player
                    .state
                    .skills
                    .get(&SKILL_FROZEN_ORB)
                    .copied()
                    .unwrap_or(1),
            )
        }) else {
            return Err("player_unknown".to_owned());
        };
        let summon = ThunderSummon {
            summon_id: format!("frozen-orb-{id}-{request_id}"),
            skill_id: SKILL_FROZEN_ORB,
            level: skill_level,
            map_id,
            x,
            y,
            facing,
            anchored: false,
            expires_at: self.tick.saturating_add(4_000_u64.div_ceil(TICK_MS)),
            next_hit_at: self.tick.saturating_add((210_u64 / TICK_MS).max(1)),
            pulse_index: 0,
        };
        let Some(player) = self.players.get_mut(id) else {
            return Err("player_unknown".to_owned());
        };
        player
            .summons
            .retain(|old| old.skill_id != SKILL_FROZEN_ORB);
        if player.summons.len() >= 2 {
            return Err("summon_limit".to_owned());
        }
        player.summons.push(summon);
        Ok(())
    }

    fn cast_ice_dragon_breath(
        &mut self,
        id: &str,
        request_id: &str,
        level: &MageLevel,
    ) -> Result<(), String> {
        let targets = self.area_targets(id, level);
        let excluded: BTreeSet<String> = targets
            .iter()
            .filter(|target_id| {
                self.monsters
                    .get(*target_id)
                    .is_some_and(|monster| monster.bind_immune_until > self.tick)
            })
            .cloned()
            .collect();
        let before: BTreeMap<String, (i64, i64)> = targets
            .iter()
            .filter(|target_id| !excluded.contains(*target_id))
            .filter_map(|target_id| {
                self.monsters
                    .get(target_id)
                    .map(|monster| (target_id.clone(), (monster.state.hp, monster.state.max_hp)))
            })
            .collect();
        if !before.is_empty() {
            self.cast_elemental_area_at_filtered(
                id,
                request_id,
                SKILL_ICE_DRAGON_BREATH,
                level,
                false,
                None,
                Some(&excluded),
            )?;
        }
        let base_seconds = u64::try_from(level.time.unwrap_or(0).max(0)).unwrap_or(0);
        let base_ticks = base_seconds.saturating_mul(1_000).div_ceil(TICK_MS).max(1);
        for (target_id, (old_hp, max_hp)) in before {
            let Some(monster) = self.monsters.get_mut(&target_id) else {
                continue;
            };
            if monster.state.hp <= 0 || monster.bind_immune_until > self.tick {
                continue;
            }
            let dealt = old_hp.saturating_sub(monster.state.hp).max(0);
            if dealt == 0 {
                continue;
            }
            let ratio = if max_hp > 0 {
                ((dealt as i128 * 100) / max_hp as i128).clamp(0, 100) as u64
            } else {
                0
            };
            let bind_ticks = base_ticks.saturating_mul(100 + ratio).div_ceil(100).max(1);
            monster.bind_until = self.tick.saturating_add(bind_ticks);
            monster.bind_immune_until = self.tick.saturating_add((90_000_u64 / TICK_MS).max(1));
            // String.h calls this action armor melting: v lowers PDRate and
            // w lowers MDRate for the bind window.  Keep both reductions
            // independent from the ninety-second bind immunity timer.
            monster.bind_pd_rate_reduction = level.v.unwrap_or(0).clamp(0, 100);
            monster.bind_md_rate_reduction = level.w.unwrap_or(0).clamp(0, 100);
            monster.state.action = "hit";
            monster.state.action_started_tick = self.tick;
        }
        // String.h makes q the hard held-key maximum; only ordinary buffs
        // use Master Magic's buff-time multiplier.
        let duration_ms = u64::try_from(level.q.unwrap_or(0).max(0)).unwrap_or(0) * 1_000;
        let Some(player) = self.players.get_mut(id) else {
            return Err("player_unknown".to_owned());
        };
        player.channel_request_id = Some(request_id.to_owned());
        player.channel_skill_id = Some(SKILL_ICE_DRAGON_BREATH);
        player.channel_until = self
            .tick
            .saturating_add(duration_ms.div_ceil(TICK_MS).max(1));
        player.channel_level = player
            .state
            .skills
            .get(&SKILL_ICE_DRAGON_BREATH)
            .copied()
            .unwrap_or(1);
        player
            .skill_buffs
            .insert(SKILL_ICE_DRAGON_BREATH, duration_ms);
        Ok(())
    }

    fn start_hyper_thunder(
        &mut self,
        id: &str,
        request_id: &str,
        level: &MageLevel,
    ) -> Result<(), String> {
        let prepare_ticks = 780_u64.div_ceil(TICK_MS).max(1);
        let hold_ticks = u64::try_from(level.q.unwrap_or(2).max(0))
            .unwrap_or(2)
            .saturating_mul(1_000)
            .div_ceil(TICK_MS)
            .max(1);
        let channel_until = self.tick.saturating_add(prepare_ticks + hold_ticks);
        let Some(player) = self.players.get_mut(id) else {
            return Err("player_unknown".to_owned());
        };
        player.channel_request_id = Some(request_id.to_owned());
        player.channel_skill_id = Some(SKILL_HYPER_THUNDER);
        player.channel_until = channel_until;
        player.channel_level = player
            .state
            .skills
            .get(&SKILL_HYPER_THUNDER)
            .copied()
            .unwrap_or(1);
        player.hyper_channel_prepare_until = self.tick.saturating_add(prepare_ticks);
        player.hyper_channel_next_pulse = player.hyper_channel_prepare_until;
        player.hyper_channel_pulse_index = 0;
        player.skill_buffs.insert(
            SKILL_HYPER_THUNDER,
            (prepare_ticks + hold_ticks).saturating_mul(TICK_MS),
        );
        player.state.action = "attack";
        player.state.action_started_tick = self.tick;
        player.attack_until = channel_until;
        Ok(())
    }

    fn step_hyper_channels(&mut self) {
        let ids: Vec<String> = self
            .players
            .iter()
            .filter_map(|(id, player)| {
                (player.channel_skill_id == Some(SKILL_HYPER_THUNDER)).then_some(id.clone())
            })
            .collect();
        for id in ids {
            let Some(snapshot) = self.players.get(&id).map(|player| {
                (
                    player.channel_until,
                    player.hyper_channel_prepare_until,
                    player.hyper_channel_next_pulse,
                    player.hyper_channel_pulse_index,
                    player.channel_request_id.clone(),
                    player.channel_level,
                    player.state.hp,
                )
            }) else {
                continue;
            };
            if snapshot.6 <= 0 || snapshot.0 <= self.tick {
                if snapshot.6 > 0 {
                    let request = snapshot.4.as_deref().unwrap_or("hyper-timeout");
                    if let Err(error) = self.finish_hyper_thunder(&id, request) {
                        self.handle_accepted_effect_error(&id, request, &error);
                    }
                } else {
                    self.stop_hyper_thunder(&id, snapshot.4.as_deref().unwrap_or("hyper-dead"));
                }
                continue;
            }
            if self.tick < snapshot.1 || self.tick < snapshot.2 {
                continue;
            }
            let Some(level) = self
                .mage_skills
                .level(SKILL_HYPER_THUNDER, snapshot.5.max(1))
                .cloned()
            else {
                self.stop_hyper_thunder(&id, snapshot.4.as_deref().unwrap_or("hyper-invalid"));
                continue;
            };
            let base_request = snapshot.4.as_deref().unwrap_or("hyper");
            let pulse_request = format!("{base_request}:pulse:{}", snapshot.3 + 1);
            // The accepted cast pre-pays the first source MP charge and owns
            // the durable 60-second cooldown.  The first pulse therefore
            // resolves without a second debit; every later pulse is its own
            // durable 30 MP action with cooldown=0.
            let prepaid_first_pulse = snapshot.3 == 0;
            let mut pulse_mp = self.players.get(&id).map(|p| p.state.mp).unwrap_or(0);
            if !prepaid_first_pulse {
                let outcome = match self.store.as_ref() {
                    Some(store) => store.cast_skill_with_cooldown(
                        &id,
                        &pulse_request,
                        SKILL_HYPER_THUNDER,
                        ICE_FOURTH_JOB,
                        FOURTH_BOOK,
                        1,
                        level.mp_con.unwrap_or(30).max(0),
                        0,
                    ),
                    None => Ok(self.local_cast_skill(
                        &id,
                        &pulse_request,
                        SKILL_HYPER_THUNDER,
                        FOURTH_BOOK,
                        level.mp_con.unwrap_or(30).max(0),
                    )),
                };
                let Ok(outcome) = outcome else {
                    self.stop_hyper_thunder(&id, base_request);
                    self.send_reject(&id, "effect_persistence", "Hyper持续脉冲保存失败。", None);
                    continue;
                };
                if !outcome.success {
                    self.stop_hyper_thunder(&id, base_request);
                    self.send_reject(
                        &id,
                        "hyper_pulse_stopped",
                        "MP不足，Hyper持续攻击已结束。",
                        None,
                    );
                    continue;
                }
                pulse_mp = outcome.mp;
            }
            if let Some(player) = self.players.get_mut(&id) {
                player.state.mp = pulse_mp;
                player.hyper_channel_pulse_index =
                    player.hyper_channel_pulse_index.saturating_add(1);
                player.hyper_channel_next_pulse =
                    self.tick.saturating_add(200_u64.div_ceil(TICK_MS));
            }
            if let Err(error) =
                self.cast_elemental_area(&id, &pulse_request, SKILL_HYPER_THUNDER, &level, false)
            {
                self.stop_hyper_thunder(&id, base_request);
                self.handle_accepted_effect_error(&id, &pulse_request, &error);
                continue;
            }
            if snapshot.3 == 0 {
                let event = self.skill_cast_event_phase(
                    &id,
                    base_request,
                    SKILL_HYPER_THUNDER,
                    2_000,
                    &level,
                    Some("sustain"),
                    None,
                );
                if let Some(map_id) = self.players.get(&id).map(|player| player.map_id.clone()) {
                    self.broadcast_to_map(&map_id, &event);
                }
            }
        }
    }

    fn stop_hyper_thunder(&mut self, id: &str, request_id: &str) {
        let Some(player) = self.players.get_mut(id) else {
            return;
        };
        let map_id = player.map_id.clone();
        let x = player.state.x;
        let y = player.state.y;
        let facing = player.state.facing;
        player.channel_request_id = None;
        player.channel_skill_id = None;
        player.channel_until = 0;
        player.channel_level = 0;
        player.hyper_channel_prepare_until = 0;
        player.hyper_channel_next_pulse = 0;
        player.hyper_channel_pulse_index = 0;
        player.skill_buffs.remove(&SKILL_HYPER_THUNDER);
        player.attack_until = self.tick;
        if player.state.action == "attack" {
            player.state.action = "stand";
            player.state.action_started_tick = self.tick;
        }
        let event = serde_json::json!({
            "type": "skillCast",
            "eventId": format!("skill-hyper-stop-{id}-{request_id}"),
            "serverTick": self.tick,
            "playerId": id,
            "skillId": SKILL_HYPER_THUNDER,
            "requestId": request_id,
            "x": x,
            "y": y,
            "facing": facing,
            "durationMs": 0,
            "phase": "sustain",
        })
        .to_string();
        self.broadcast_to_map(&map_id, &event);
    }

    fn finish_hyper_thunder(&mut self, id: &str, request_id: &str) -> Result<(), String> {
        let Some((level, map_id)) = self.players.get(id).map(|player| {
            (
                self.mage_skills
                    .level(SKILL_HYPER_THUNDER, player.channel_level.max(1))
                    .cloned()
                    .unwrap_or_default(),
                player.map_id.clone(),
            )
        }) else {
            return Err("player_unknown".to_owned());
        };
        let mut final_level = level.clone();
        final_level.damage = level.x.or(level.damage);
        final_level.attack_count = Some(level.w.unwrap_or(15).max(0) as u32);
        final_level.mob_count = Some(level.mob_count.unwrap_or(15));
        self.stop_hyper_thunder(id, request_id);
        self.cast_elemental_area(
            id,
            &format!("{request_id}:final"),
            SKILL_HYPER_THUNDER,
            &final_level,
            false,
        )?;
        if let Some(player) = self.players.get_mut(id) {
            player.attack_until = self.tick.saturating_add(900_u64.div_ceil(TICK_MS).max(1));
            player.state.action = "attack";
            player.state.action_started_tick = self.tick;
        }
        let event = self.skill_cast_event_phase(
            id,
            request_id,
            SKILL_HYPER_THUNDER,
            900,
            &final_level,
            Some("final"),
            None,
        );
        self.broadcast_to_map(&map_id, &event);
        Ok(())
    }

    fn activate_hyper_adventurer(&mut self, id: &str, level: &MageLevel) {
        // The source describes an adventurer-wide damage buff.  It now reaches
        // the party members standing on the caster's map; a caster without a
        // party still gets exactly the old self-only behaviour.  Its duration
        // is independent of Master Magic's buff-time multiplier.
        let duration_ms = u64::try_from(level.time.unwrap_or(60).max(0))
            .unwrap_or(60)
            .saturating_mul(1_000);
        if duration_ms == 0 {
            return;
        }
        for target in self.party_members_on_map(id) {
            if let Some(player) = self.players.get_mut(&target) {
                player
                    .skill_buffs
                    .insert(SKILL_HYPER_ADVENTURER, duration_ms);
            }
        }
    }

    fn activate_hyper_vortex(
        &mut self,
        id: &str,
        request_id: &str,
        level: &MageLevel,
        vertical: i8,
    ) -> Result<(), String> {
        let Some((map_id, x, y, facing, barrier_enabled)) = self.players.get(id).map(|player| {
            (
                player.map_id.clone(),
                player.state.x,
                player.state.y,
                player.state.facing,
                player.hyper_barrier_enabled,
            )
        }) else {
            return Err("player_unknown".to_owned());
        };
        if vertical > 0 {
            let hidden_level = self
                .mage_skills
                .level(SKILL_HYPER_VORTEX_HIDDEN, 1)
                .cloned()
                .unwrap_or_else(|| level.clone());
            let duration_ms = u64::try_from(hidden_level.u2.unwrap_or(30).max(0))
                .unwrap_or(30)
                .saturating_mul(1_000);
            let pulse_ms =
                u64::try_from(hidden_level.sub_time.unwrap_or(1_200).max(1)).unwrap_or(1_200);
            if duration_ms == 0 || pulse_ms == 0 {
                return Err("invalid_hyper_vortex".to_owned());
            }
            let Some(player) = self.players.get_mut(id) else {
                return Err("player_unknown".to_owned());
            };
            player.hyper_vortex = Some(HyperVortex {
                request_id: request_id.to_owned(),
                map_id: map_id.clone(),
                x,
                y,
                facing,
                hidden: true,
                expires_at: self.tick.saturating_add(duration_ms.div_ceil(TICK_MS)),
                next_pulse_at: self.tick,
            });
            // A down-key vortex is a separate area object; it does not turn
            // the visible ON/OFF barrier off or on and has no damage path.
            let event = serde_json::json!({
                "type": "skillCast",
                "eventId": format!("skill-hyper-vortex-{id}-{request_id}"),
                "serverTick": self.tick,
                "playerId": id,
                "skillId": SKILL_HYPER_VORTEX_HIDDEN,
                "requestId": request_id,
                "x": x,
                "y": y,
                "facing": facing,
                "durationMs": duration_ms,
            })
            .to_string();
            self.broadcast_to_map(&map_id, &event);
        } else {
            let Some(player) = self.players.get_mut(id) else {
                return Err("player_unknown".to_owned());
            };
            player.hyper_barrier_enabled = !barrier_enabled;
            if player.hyper_barrier_enabled {
                player.hyper_barrier_next_mp =
                    self.tick.saturating_add(1_000_u64.div_ceil(TICK_MS));
                player.hyper_barrier_next_pulse = self.tick;
            } else {
                player.hyper_barrier_next_mp = 0;
                player.hyper_barrier_next_pulse = 0;
            }
        }
        Ok(())
    }

    fn step_hyper_effects(&mut self) {
        let ids: Vec<String> = self.players.keys().cloned().collect();
        for id in ids {
            let Some(snapshot) = self.players.get(&id).map(|player| {
                (
                    player.state.hp,
                    player.map_id.clone(),
                    player.hyper_barrier_enabled,
                    player.hyper_barrier_next_mp,
                    player.hyper_barrier_next_pulse,
                    player.hyper_vortex.clone(),
                )
            }) else {
                continue;
            };
            if snapshot.0 <= 0 {
                if let Some(player) = self.players.get_mut(&id) {
                    clear_hyper_runtime(player);
                    refresh_player_derived(&self.gameplay, &self.mage_skills, player);
                }
                continue;
            }

            if snapshot.2 && snapshot.3 <= self.tick {
                let upkeep_request = format!("hyper-barrier:{id}:{}", self.tick);
                let cost = if self
                    .players
                    .get(&id)
                    .is_some_and(|player| player.skill_buffs.contains_key(&SKILL_INFINITY))
                {
                    0
                } else {
                    60
                };
                let outcome = match self.store.as_ref() {
                    Some(store) => store.cast_skill(
                        &id,
                        &upkeep_request,
                        SKILL_HYPER_VORTEX,
                        ICE_FOURTH_JOB,
                        FOURTH_BOOK,
                        1,
                        cost,
                    ),
                    None => Ok(self.local_cast_skill(
                        &id,
                        &upkeep_request,
                        SKILL_HYPER_VORTEX,
                        FOURTH_BOOK,
                        cost,
                    )),
                };
                match outcome {
                    Ok(outcome) if outcome.success => {
                        if let Some(player) = self.players.get_mut(&id) {
                            player.state.mp = outcome.mp;
                            player.hyper_barrier_next_mp =
                                self.tick.saturating_add(1_000_u64.div_ceil(TICK_MS));
                        }
                    }
                    Ok(_) | Err(_) => {
                        if let Some(player) = self.players.get_mut(&id) {
                            player.hyper_barrier_enabled = false;
                            player.hyper_barrier_next_mp = 0;
                            player.hyper_barrier_next_pulse = 0;
                            refresh_player_derived(&self.gameplay, &self.mage_skills, player);
                        }
                        self.send_reject(
                            &id,
                            "hyper_barrier_stopped",
                            "MP不足，冰雪結界已结束。",
                            None,
                        );
                        self.send_snapshot(&id);
                    }
                }
            }

            // The upkeep transaction may turn the barrier off in this same
            // tick.  Read the committed runtime flag again before applying
            // its freeze pulse; the pre-charge snapshot must not grant one
            // last free effect after an MP/persistence failure.
            let barrier_enabled = self
                .players
                .get(&id)
                .is_some_and(|player| player.hyper_barrier_enabled);
            if barrier_enabled && snapshot.4 <= self.tick {
                let Some(level) = self.mage_skills.level(SKILL_HYPER_VORTEX, 1).cloned() else {
                    continue;
                };
                let targets = self.area_targets(&id, &level);
                for target_id in targets {
                    self.freeze_target(&target_id, 1);
                }
                if let Some(player) = self.players.get_mut(&id) {
                    player.hyper_barrier_next_pulse =
                        self.tick.saturating_add(2_400_u64.div_ceil(TICK_MS));
                }
            }

            let Some(vortex) = snapshot.5 else {
                continue;
            };
            if vortex.map_id != snapshot.1 || vortex.expires_at <= self.tick {
                if let Some(player) = self.players.get_mut(&id) {
                    player.hyper_vortex = None;
                }
                let event = serde_json::json!({
                    "type": "skillCast",
                    "eventId": format!("skill-hyper-vortex-stop-{id}-{}", vortex.request_id),
                    "serverTick": self.tick,
                    "playerId": id,
                    "skillId": SKILL_HYPER_VORTEX_HIDDEN,
                    "requestId": vortex.request_id,
                    "x": vortex.x,
                    "y": vortex.y,
                    "facing": vortex.facing,
                    "durationMs": 0,
                })
                .to_string();
                self.broadcast_to_map(&snapshot.1, &event);
                self.refresh_hyper_player_derived(&id);
                continue;
            }
            if vortex.next_pulse_at <= self.tick {
                let Some(level) = self
                    .mage_skills
                    .level(SKILL_HYPER_VORTEX_HIDDEN, 1)
                    .cloned()
                else {
                    continue;
                };
                let targets = self.area_targets_at(&id, &level, vortex.x, vortex.y, vortex.facing);
                for target_id in targets {
                    self.freeze_target(&target_id, 1);
                }
                if let Some(player) = self.players.get_mut(&id) {
                    if let Some(active) = player.hyper_vortex.as_mut() {
                        let pulse_ms =
                            u64::try_from(level.sub_time.unwrap_or(1_200).max(1)).unwrap_or(1_200);
                        active.next_pulse_at = self.tick.saturating_add(pulse_ms.div_ceil(TICK_MS));
                    }
                }
            }
            self.refresh_hyper_player_derived(&id);
        }
    }

    fn refresh_hyper_player_derived(&mut self, id: &str) {
        if let Some(player) = self.players.get_mut(id) {
            refresh_player_derived(&self.gameplay, &self.mage_skills, player);
        }
    }

    fn maybe_cast_blizzard_follow_up(
        &mut self,
        id: &str,
        request_id: &str,
        target_id: &str,
    ) -> Result<(), String> {
        let Some(level) = self
            .players
            .get(id)
            .and_then(|player| player.state.skills.get(&SKILL_BLIZZARD))
            .copied()
            .and_then(|skill_level| self.mage_skills.level(SKILL_BLIZZARD, skill_level))
            .cloned()
        else {
            return Ok(());
        };
        let Some((target_x, target_y, map_id)) = self.monsters.get(target_id).and_then(|monster| {
            (monster.state.hp > 0).then_some((
                monster.state.x,
                monster.state.y,
                monster.map_id.clone(),
            ))
        }) else {
            return Ok(());
        };
        if self
            .players
            .get(id)
            .is_none_or(|player| player.map_id != map_id)
        {
            return Ok(());
        }
        let prop = level.prop.unwrap_or(0).clamp(0, 100) as u64;
        if deterministic_percent(&[id, request_id, target_id, "blizzard-follow-up"]) >= prop {
            return Ok(());
        }
        let mut follow = level.clone();
        follow.damage = level.x;
        follow.mob_count = Some(1);
        follow.attack_count = Some(1);
        follow.lt = Some(crate::mage::MagePoint {
            x: -500.0,
            y: -500.0,
        });
        follow.rb = Some(crate::mage::MagePoint { x: 500.0, y: 500.0 });
        // Anchor the hidden hit at the target that actually survived the
        // triggering cast, then exclude every other mob.  A second scan from
        // the caster would let a nearby mob steal the passive hit.
        let excluded = self
            .monsters
            .keys()
            .filter(|other_id| other_id.as_str() != target_id)
            .cloned()
            .collect::<BTreeSet<_>>();
        self.cast_elemental_area_at_filtered(
            id,
            &format!("{request_id}:blizzard-passive"),
            SKILL_BLIZZARD_HIDDEN,
            &follow,
            false,
            Some((
                target_x,
                target_y,
                self.players.get(id).map(|p| p.state.facing).unwrap_or(1),
            )),
            Some(&excluded),
        )
    }

    fn apply_chain_stun(&mut self, id: &str, request_id: &str, level: &MageLevel) {
        let prop = level.prop.unwrap_or(0).clamp(0, 100) as u64;
        let duration_ticks = u64::try_from(level.time.unwrap_or(1).max(0))
            .unwrap_or(1)
            .saturating_mul(1_000)
            .div_ceil(TICK_MS)
            .max(1);
        for target_id in self.skill_area_targets(id, SKILL_CHAIN_LIGHTNING, level) {
            if deterministic_percent(&[id, request_id, target_id.as_str(), "chain-stun"]) >= prop {
                continue;
            }
            if let Some(monster) = self.monsters.get_mut(&target_id) {
                if monster.state.hp > 0 {
                    monster.stun_until = self.tick.saturating_add(duration_ticks);
                    monster.state.action = "hit";
                    monster.state.action_started_tick = self.tick;
                }
            }
        }
    }

    fn energy_duration_ms(&self, id: &str) -> u64 {
        let action_speed = self
            .players
            .get(id)
            .map(|player| self.action_speed_bonus(player))
            .unwrap_or(0);
        // P: the source actionSpeed=-1 shortens the 600 ms server animation
        // lock by one 50 ms world tick; damage still resolves in this request.
        (600_i64 + action_speed.saturating_mul(TICK_MS as i64)).clamp(250, 1_000) as u64
    }

    fn action_speed_bonus(&self, player: &Player) -> i64 {
        let first = player
            .state
            .skills
            .get(&SKILL_MAGIC_BOOST)
            .and_then(|level| self.mage_skills.level(SKILL_MAGIC_BOOST, *level))
            .and_then(|level| level.action_speed)
            .unwrap_or(0);
        let second = player
            .state
            .skills
            .get(&SKILL_BOOSTER)
            .and_then(|level| self.mage_skills.level(SKILL_BOOSTER, *level))
            .and_then(|level| level.action_speed)
            .or_else(|| {
                self.mage_skills
                    .get(SKILL_BOOSTER)
                    .and_then(|skill| skill.booster_action_speed)
            })
            .unwrap_or(0);
        first.min(0).saturating_add(second.min(0))
    }

    fn cast_beginner_throw(
        &mut self,
        id: &str,
        request_id: &str,
        level: &MageLevel,
        skill_level: u32,
    ) -> Result<(), String> {
        let target_id = self.beginner_throw_targets(id).into_iter().next();
        let Some(target_id) = target_id else {
            return Ok(());
        };
        let Some((target_template, target_hp, target_max_hp, target_x, target_y, map_id, quests)) =
            self.monsters.get(&target_id).map(|monster| {
                let quests = self
                    .players
                    .get(id)
                    .map(|player| player.quests.clone())
                    .unwrap_or_default();
                (
                    monster.template.clone(),
                    monster.state.hp,
                    monster.state.max_hp,
                    monster.state.x,
                    monster.state.y,
                    monster.map_id.clone(),
                    quests,
                )
            })
        else {
            return Ok(());
        };
        let damage = level.fixdamage.unwrap_or(0).max(0);
        let killed = damage >= target_hp;
        let applied_damage = damage.min(target_hp.max(0));
        let practice = auth::is_practice_map(&map_id);
        let drops = if killed && !practice {
            self.choose_drops(&target_template, target_x, target_y, id, &quests)
        } else {
            Vec::new()
        };
        let action_request = format!("{request_id}:t{target_id}");
        let action_id = format!("skill-{request_id}-{target_id}");
        let resolution = if let Some(store) = self.store.as_ref() {
            let claim = store.claim_attack(id, &map_id, &action_request, &action_id, "skill")?;
            if claim.resolved {
                return Ok(());
            }
            store.resolve_attack_with_party(
                id,
                &map_id,
                &action_request,
                Some(&target_id),
                applied_damage,
                killed,
                target_template.exp,
                target_max_hp,
                &drops,
                &self.gameplay.exp_table,
                &self.players.keys().cloned().collect::<Vec<_>>(),
                &self.party_exp_members(id),
            )?
        } else {
            auth::AttackResolution {
                already_resolved: false,
                target_id: Some(target_id.clone()),
                damage: applied_damage,
                killed,
                exp_gain: if killed && !practice {
                    target_template.exp
                } else {
                    0
                },
                drop: drops.first().cloned(),
                drops,
                profile: None,
                profiles: Vec::new(),
            }
        };
        if resolution.already_resolved {
            return Ok(());
        }
        if let Some(monster) = self.monsters.get_mut(&target_id) {
            if resolution.damage > 0 {
                let contribution = monster.damage_by_player.entry(id.to_owned()).or_default();
                *contribution = contribution.saturating_add(resolution.damage);
                // A successful hit is what turns the mob hostile toward this
                // attacker (pursuit resolution happens each step in
                // `step_monsters`).
                mark_monster_hit_aggro(monster, &id, self.tick);
            }
            monster.state.hp = (monster.state.hp - resolution.damage).max(0);
            monster.state.action = if monster.state.hp == 0 { "die" } else { "hit" };
            monster.state.action_started_tick = self.tick;
            if monster.state.hp == 0 {
                monster.freeze_until = 0;
                monster.state.freeze_stacks = None;
                monster.stun_until = 0;
                let die_ticks = monster
                    .template
                    .die_duration_ms
                    .unwrap_or(1)
                    .div_ceil(TICK_MS)
                    .max(1);
                monster.death_until = Some(self.tick + die_ticks);
                monster.respawn_at = respawn_deadline(
                    self.tick,
                    self.gameplay.monster_respawn_ms,
                    monster.spawn.mob_time,
                );
            }
        }
        if resolution.damage > 0 {
            self.broadcast_to_map(
                &map_id,
                &serde_json::json!({
                    "type": "damageEvent",
                    "eventId": format!("damage-event-{id}-{request_id}-{target_id}"),
                    "serverTick": self.tick,
                    "attackerId": id,
                    "targetId": target_id,
                    "x": target_x,
                    "y": target_y,
                    "damage": resolution.damage,
                    "killed": resolution.killed,
                    "skillId": SKILL_THREE_SNAILS,
                    "skillLevel": skill_level,
                })
                .to_string(),
            );
        }
        if !resolution.profiles.is_empty() {
            for (participant, profile) in resolution.profiles {
                if let Some(player) = self.players.get_mut(&participant) {
                    apply_profile_to_player(&self.gameplay, &self.mage_skills, player, profile);
                }
            }
        } else if let Some(profile) = resolution.profile {
            if let Some(player) = self.players.get_mut(id) {
                apply_profile_to_player(&self.gameplay, &self.mage_skills, player, profile);
            }
        } else if resolution.exp_gain > 0 && self.store.is_none() {
            if let Some(player) = self.players.get_mut(id) {
                Self::add_exp(
                    &mut player.state,
                    resolution.exp_gain,
                    &self.gameplay.exp_table,
                );
                refresh_player_derived(&self.gameplay, &self.mage_skills, player);
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
            self.drop_maps.insert(drop_id, map_id.clone());
        }
        Ok(())
    }

    fn skill_duration_ms(&self, id: &str, skill_id: u32) -> u64 {
        // P: no server hit scheduler is exported for these second-job attacks;
        // resolve all authored attackCount segments immediately and retain a
        // 600 ms action lock (500 ms after action-speed reductions).
        let base = match skill_id {
            SKILL_COLD_BEAM
            | SKILL_THUNDER_BOLT
            | SKILL_ICE_STORM
            | SKILL_GLACIAL_WALL
            | SKILL_THUNDER_SPHERE
            | SKILL_ICE_DEMON
            | SKILL_CHAIN_LIGHTNING
            | SKILL_BLIZZARD
            | SKILL_ICE_DRAGON_BREATH
            | SKILL_FROZEN_ORB => 600,
            _ => SKILL_CAST_DURATION_MS,
        };
        let action_speed = self
            .players
            .get(id)
            .map(|player| self.action_speed_bonus(player))
            .unwrap_or(0);
        (i64::try_from(base).unwrap_or(600) + action_speed * TICK_MS as i64).clamp(250, 1_000)
            as u64
    }

    fn plan_teleport(
        &self,
        id: &str,
        level: &MageLevel,
        direction: i8,
        vertical: i8,
    ) -> Result<TeleportPlan, String> {
        let Some(player) = self.players.get(id) else {
            return Err("player_unknown".to_owned());
        };
        if direction == 0 && vertical == 0 {
            return Err("teleport_no_direction".to_owned());
        }
        let map_id = player.map_id.clone();
        let map = self.map_for(&map_id).clone();
        let boost = if player.teleport_boost_enabled {
            self.players
                .get(id)
                .and_then(|player| player.state.skills.get(&SKILL_TELEPORT_BOOST))
                .copied()
                .and_then(|skill_level| self.mage_skills.level(SKILL_TELEPORT_BOOST, skill_level))
        } else {
            None
        };
        let (boost_x, boost_y) = boost
            .map(|level| (level.x.unwrap_or(0).max(0), level.y.unwrap_or(0).max(0)))
            .unwrap_or((0, 0));
        let hyper_distance = if player.hyper_teleport_enabled {
            self.players
                .get(id)
                .and_then(|player| player.state.skills.get(&SKILL_HYPER_TELEPORT_DISTANCE))
                .copied()
                .and_then(|skill_level| {
                    self.mage_skills
                        .level(SKILL_HYPER_TELEPORT_DISTANCE, skill_level)
                })
                .and_then(|value| value.x)
                .unwrap_or(0)
                .max(0)
        } else {
            0
        };
        let horizontal_distance =
            level.x.unwrap_or(0).max(0) as f64 + boost_x as f64 + hyper_distance as f64;
        let vertical_distance_abs = level.y.unwrap_or(0).max(0) as f64 + boost_y as f64;
        let horizontal = horizontal_distance * f64::from(direction);
        let vertical_distance = vertical_distance_abs * f64::from(vertical);
        let mut target_x = (player.state.x + horizontal).clamp(map.bounds.x_min, map.bounds.x_max);
        if direction != 0 && player.state.grounded {
            let wall = map.wall_for(player.foothold_id, direction < 0, player.state.y);
            target_x = if direction < 0 {
                target_x.max(wall)
            } else {
                target_x.min(wall)
            };
        }
        let mut target_y =
            (player.state.y + vertical_distance).clamp(map.bounds.y_min, map.bounds.y_max);
        let mut foothold_id = 0;
        let mut grounded = false;
        if vertical == 0 {
            if let Some((id, ground)) = map.ground_near(target_x, player.state.y) {
                if (ground - player.state.y).abs() <= 24.0 {
                    foothold_id = id;
                    target_y = ground;
                    grounded = true;
                }
            }
        } else if vertical > 0 {
            if let Some((id, ground)) = map.ground_near(target_x, target_y) {
                if ground >= player.state.y - 1.0
                    && ground <= target_y + 24.0
                    && ground - player.state.y <= vertical_distance_abs + 24.0
                {
                    foothold_id = id;
                    target_y = ground;
                    grounded = true;
                }
            }
        }
        if (target_x - player.state.x).abs() < 0.001 && (target_y - player.state.y).abs() < 0.001 {
            return Err("teleport_blocked".to_owned());
        }
        if !target_x.is_finite() || !target_y.is_finite() {
            return Err("teleport_blocked".to_owned());
        }
        Ok(TeleportPlan {
            map_id,
            x: target_x,
            y: target_y,
            foothold_id,
            grounded,
        })
    }

    fn apply_teleport(&mut self, id: &str, plan: TeleportPlan) {
        let Some(player) = self.players.get_mut(id) else {
            return;
        };
        player.map_id = plan.map_id;
        player.state.x = plan.x;
        player.state.y = plan.y;
        player.state.vx = 0.0;
        player.state.vy = 0.0;
        player.state.grounded = plan.grounded;
        player.state.climbing = false;
        player.state.ladder_id = None;
        player.state.action_id = None;
        player.state.action = if plan.grounded { "stand" } else { "jump" };
        player.state.action_started_tick = self.tick;
        player.swimming = false;
        player.foothold_id = plan.foothold_id;
        player.last_foothold_id = plan.foothold_id;
        player.drop_fh = 0;
        player.fall_boundary_hold = false;
        player.attack_until = 0;
    }

    fn apply_magic_wave(&mut self, id: &str, level: &MageLevel, _vertical: i8, hidden: bool) {
        let tick = self.tick;
        let Some(player) = self.players.get_mut(id) else {
            return;
        };
        // Both nodes share one feel: 1.5x the normal jump displacement, then a
        // slow descent at the source's v=95 px/s for the source's time window.
        // The visible node keeps its authored y scaling around that baseline.
        let authored = if hidden {
            1.0
        } else {
            (level.y.unwrap_or(1_200).max(0) as f64 / 1_200.0).clamp(0.75, 1.5)
        };
        player.state.vy = -(JUMP_SPEED * MAGIC_WAVE_LAUNCH_HEIGHT_RATIO.sqrt() * authored);
        player.state.grounded = false;
        player.state.action = "jump";
        player.state.action_started_tick = tick;
        let seconds = level.time.unwrap_or(MAGIC_WAVE_SLOW_FALL_SECONDS).max(0) as u64;
        player.slow_fall_until =
            tick.saturating_add(seconds.saturating_mul(1_000).div_ceil(TICK_MS));
        if hidden {
            player.magic_wave_float_used = true;
        } else {
            player.foothold_id = 0;
            player.magic_wave_used = true;
            player.magic_wave_float_used = false;
        }
    }

    fn energy_targets(&self, id: &str, level: &MageLevel) -> Vec<String> {
        let Some(player) = self.players.get(id) else {
            return Vec::new();
        };
        let range = level.range.unwrap_or(0).max(0) as f64;
        let max_targets = level.mob_count.unwrap_or(1).clamp(1, 4) as usize;
        let facing = if player.state.facing < 0 { -1.0 } else { 1.0 };
        let mut candidates = self
            .monsters
            .iter()
            .filter_map(|(monster_id, monster)| {
                if monster.map_id != player.map_id || monster.state.hp <= 0 {
                    return None;
                }
                let dx = (monster.state.x - player.state.x) * facing;
                let dy = (monster.state.y - player.state.y).abs();
                (dx >= 0.0 && dx <= range && dy <= 90.0).then_some((dx, dy, monster_id.clone()))
            })
            .collect::<Vec<_>>();
        candidates.sort_by(|a, b| {
            a.0.total_cmp(&b.0)
                .then_with(|| a.1.total_cmp(&b.1))
                .then_with(|| a.2.cmp(&b.2))
        });
        let Some((_, _, first_id)) = candidates.first().cloned() else {
            return Vec::new();
        };
        let Some(first) = self.monsters.get(&first_id) else {
            return Vec::new();
        };
        let (lt_x, rb_x) = level
            .lt
            .zip(level.rb)
            .map(|(lt, rb)| (lt.x, rb.x))
            .unwrap_or((-120.0, 120.0));
        let (lt_y, rb_y) = level
            .lt
            .zip(level.rb)
            .map(|(lt, rb)| (lt.y, rb.y))
            .unwrap_or((-75.0, 75.0));
        let mut selected = self
            .monsters
            .iter()
            .filter_map(|(monster_id, monster)| {
                if monster.map_id != player.map_id || monster.state.hp <= 0 {
                    return None;
                }
                let dx = monster.state.x - first.state.x;
                let dy = monster.state.y - first.state.y;
                (dx >= lt_x && dx <= rb_x && dy >= lt_y && dy <= rb_y)
                    .then_some(((dx * dx + dy * dy).sqrt(), monster_id.clone()))
            })
            .collect::<Vec<_>>();
        selected.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        selected
            .into_iter()
            .take(max_targets)
            .map(|(_, id)| id)
            .collect()
    }

    fn area_targets(&self, id: &str, level: &MageLevel) -> Vec<String> {
        let Some(player) = self.players.get(id) else {
            return Vec::new();
        };
        self.area_targets_at(
            id,
            level,
            player.state.x,
            player.state.y,
            player.state.facing,
        )
    }

    fn skill_area_targets(&self, id: &str, skill_id: u32, level: &MageLevel) -> Vec<String> {
        self.area_targets(id, &self.hyper_area_level(id, skill_id, level))
    }

    fn hyper_area_level(&self, id: &str, skill_id: u32, level: &MageLevel) -> MageLevel {
        let mut adjusted = level.clone();
        if skill_id == SKILL_CHAIN_LIGHTNING && adjusted.lt.is_none() && adjusted.rb.is_none() {
            // Chain Lightning's source exposes range=420 and y=350 rather
            // than an lt/rb rectangle.  Keep that authored envelope while
            // allowing the Hyper target passive to add two slots.
            let range = adjusted.range.unwrap_or(420).max(0) as f64;
            let vertical = adjusted.y.unwrap_or(350).abs() as f64;
            adjusted.lt = Some(crate::mage::MagePoint {
                x: -range,
                y: -vertical,
            });
            adjusted.rb = Some(crate::mage::MagePoint {
                x: range,
                y: vertical,
            });
        }
        let target_plus_id = match skill_id {
            SKILL_TELEPORT_MASTERY => Some(SKILL_HYPER_TELEPORT_TARGET),
            SKILL_CHAIN_LIGHTNING => Some(SKILL_HYPER_CHAIN_TARGET),
            SKILL_ICE_DEMON => Some(SKILL_HYPER_ICE_TARGET),
            _ => None,
        };
        if let Some(passive_id) = target_plus_id {
            let learned = self
                .players
                .get(id)
                .and_then(|player| player.state.skills.get(&passive_id))
                .copied()
                .unwrap_or(0);
            if learned > 0 {
                let plus = self
                    .mage_skills
                    .level(passive_id, learned)
                    .and_then(|value| value.target_plus)
                    .unwrap_or(0);
                adjusted.mob_count =
                    Some(adjusted.mob_count.unwrap_or(1).saturating_add(plus).min(15));
            }
        }
        adjusted
    }

    fn area_targets_at(
        &self,
        id: &str,
        level: &MageLevel,
        origin_x: f64,
        origin_y: f64,
        facing: i8,
    ) -> Vec<String> {
        let Some(player) = self.players.get(id) else {
            return Vec::new();
        };
        let (lt, rb) = level.lt.zip(level.rb).map(|(lt, rb)| (lt, rb)).unwrap_or((
            crate::mage::MagePoint {
                x: -250.0,
                y: -75.0,
            },
            crate::mage::MagePoint { x: 250.0, y: 75.0 },
        ));
        let max_targets = level.mob_count.unwrap_or(1).clamp(1, 15) as usize;
        let facing = if facing < 0 { -1.0 } else { 1.0 };
        let mut candidates = self
            .monsters
            .iter()
            .filter_map(|(monster_id, monster)| {
                if monster.map_id != player.map_id || monster.state.hp <= 0 {
                    return None;
                }
                // WZ rectangles are authored facing left; mirroring the local
                // x coordinate keeps the source lt/rb geometry for both ways.
                let local_x = -((monster.state.x - origin_x) * facing);
                let local_y = monster.state.y - origin_y;
                (local_x >= lt.x && local_x <= rb.x && local_y >= lt.y && local_y <= rb.y)
                    .then_some(((monster.state.x - origin_x).abs(), monster_id.clone()))
            })
            .collect::<Vec<_>>();
        candidates.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        candidates
            .into_iter()
            .take(max_targets)
            .map(|(_, id)| id)
            .collect()
    }

    fn apply_meditation(&mut self, id: &str, level: &MageLevel) {
        let duration_ms =
            self.buff_duration_ms(id, level, level.time.unwrap_or(40).max(0) as u64 * 1_000);
        let mad = level.indie_mad.unwrap_or(10).max(0);
        // With a party model the buff finally has someone to reach: it now
        // applies to the party members actually standing on the caster's map.
        // `party_members_on_map` returns the caster alone when there is no
        // party, so solo behaviour is unchanged.  P: the source still has no
        // party-target contract; the level/floor rules are untouched.
        let targets = self.party_members_on_map(id);
        let until = self.tick.saturating_add(duration_ms.div_ceil(TICK_MS));
        for target in targets {
            let Some(player) = self.players.get_mut(&target) else {
                continue;
            };
            player.meditation_mad = mad;
            player.meditation_until = until;
        }
    }

    fn maybe_absorb_monster_mp(&mut self, id: &str, target_id: &str) {
        let level = self
            .players
            .get(id)
            .and_then(|player| player.state.skills.get(&SKILL_MANA_ABSORB))
            .copied()
            .and_then(|level| self.mage_skills.level(SKILL_MANA_ABSORB, level).cloned());
        let Some(level) = level else {
            return;
        };
        let prop = level.prop.unwrap_or(0).clamp(0, 100);
        if prop == 0 || rand::thread_rng().gen_range(0..100) >= prop {
            return;
        }
        let Some((remaining, max_mp, boss)) = self.monsters.get(target_id).map(|monster| {
            (
                monster.mp.max(0),
                monster.template.max_mp.max(0),
                monster.template.boss,
            )
        }) else {
            return;
        };
        if remaining == 0 || max_mp == 0 {
            return;
        }
        let percent = if boss {
            level.y.unwrap_or(0)
        } else {
            level.x.unwrap_or(0)
        }
        .clamp(0, 100);
        // The WZ x/y expressions are percentages of the mob's maximum MP;
        // clamp the result to the mob's current remaining pool and the
        // player's current MP capacity.  Zero after integer truncation is a
        // valid source result and does not mint a point of MP.
        let amount = max_mp.saturating_mul(percent) / 100;
        let amount = amount.min(remaining);
        if amount == 0 {
            return;
        }
        let Some(monster) = self.monsters.get_mut(target_id) else {
            return;
        };
        monster.mp = monster.mp.saturating_sub(amount);
        if let Some(player) = self.players.get_mut(id) {
            player.state.mp = player
                .state
                .mp
                .saturating_add(amount)
                .min(player.state.max_mp);
        }
    }

    fn freeze_target(&mut self, target_id: &str, delta: i32) -> u32 {
        let Some(monster) = self.monsters.get_mut(target_id) else {
            return 0;
        };
        let expired = monster.freeze_until <= self.tick;
        let current = if expired {
            0
        } else {
            monster.state.freeze_stacks.unwrap_or(0)
        };
        // P: freeze is authoritative movement lock for the exported v=-75
        // slow value; the source s/v physics effect is not otherwise applied.
        let next = if delta >= 0 {
            current
                .saturating_add(u32::try_from(delta).unwrap_or(0))
                .min(ICE_FREEZE_STACK_CAP)
        } else {
            current.saturating_sub(delta.unsigned_abs())
        };
        monster.state.freeze_stacks = (next > 0).then_some(next);
        if next > 0 {
            monster.freeze_until = self
                .tick
                .saturating_add(ICE_FREEZE_DURATION_MS.div_ceil(TICK_MS));
            monster.state.action = "freeze";
            monster.state.action_started_tick = self.tick;
        } else {
            monster.freeze_until = 0;
            if monster.state.action == "freeze" {
                monster.state.action = if monster.template.can_move() {
                    "move"
                } else {
                    "stand"
                };
                monster.state.action_started_tick = self.tick;
            }
        }
        next
    }

    fn magic_critical_chance(&self, id: &str) -> i64 {
        let Some(player) = self.players.get(id) else {
            return 0;
        };
        let mastery_crit = player
            .state
            .skills
            .get(&SKILL_SPELL_MASTERY)
            .and_then(|level| self.mage_skills.level(SKILL_SPELL_MASTERY, *level))
            .and_then(|level| level.cr)
            .unwrap_or(0);
        let third_crit = player
            .state
            .skills
            .get(&SKILL_MAGIC_CRITICAL)
            .and_then(|level| self.mage_skills.level(SKILL_MAGIC_CRITICAL, *level))
            .and_then(|level| level.cr)
            .unwrap_or(0);
        let wand_crit = player
            .state
            .skills
            .get(&SKILL_MAGIC_BOOST)
            .is_some_and(|level| *level > 0)
            && player.state.equipped.iter().any(|item| {
                item.slot == 11
                    && item
                        .item_id
                        .parse::<i64>()
                        .ok()
                        .is_some_and(|item_id| item_id / 10_000 == 137)
            });
        let hyper_ice_crit = player
            .state
            .skills
            .get(&SKILL_HYPER_ICE_CRIT)
            .copied()
            .and_then(|level| self.mage_skills.level(SKILL_HYPER_ICE_CRIT, level))
            .and_then(|level| level.cr)
            .unwrap_or(0)
            .max(0);
        (mastery_crit + third_crit + hyper_ice_crit + if wand_crit { 5 } else { 0 }).clamp(0, 100)
    }

    fn magic_damage_with_passives(
        &self,
        id: &str,
        skill_id: u32,
        target_id: &str,
        base_damage: i64,
        critical: bool,
        request_id: &str,
        segment: u32,
    ) -> i64 {
        let Some(target) = self.monsters.get(target_id) else {
            return base_damage.max(1);
        };
        let mut damage = base_damage.max(1);
        let frozen_stacks = target
            .state
            .freeze_stacks
            .unwrap_or(0)
            .min(ICE_FREEZE_STACK_CAP);
        let frozen_break = self
            .players
            .get(id)
            .and_then(|player| player.state.skills.get(&SKILL_FROZEN_BREAK))
            .copied()
            .and_then(|level| self.mage_skills.level(SKILL_FROZEN_BREAK, level));
        let mut ignored_md_rate = 0_i64;
        if let Some(level) = frozen_break {
            let prop = level.prop.unwrap_or(0).clamp(0, 100) as u64;
            let sub_prop = level.sub_prop.unwrap_or(0).clamp(0, 100) as u64;
            for layer in 0..frozen_stacks {
                let roll = deterministic_percent(&[
                    id,
                    request_id,
                    target_id,
                    &segment.to_string(),
                    &layer.to_string(),
                ]);
                // subProp is the per-layer chance; a successful layer adds
                // prop percent of magic defense ignore, capped at five layers.
                if roll < sub_prop {
                    ignored_md_rate = ignored_md_rate.saturating_add(prop as i64);
                }
            }
        }
        let (mystic_ignore, mystic_bonus, infinity_bonus) = self
            .players
            .get(id)
            .map(|player| {
                let mystic = player
                    .state
                    .skills
                    .get(&SKILL_MYSTIC_STRIKE)
                    .copied()
                    .and_then(|level| self.mage_skills.level(SKILL_MYSTIC_STRIKE, level));
                (
                    mystic
                        .and_then(|level| level.ignore_mob_pdp_r)
                        .unwrap_or(0)
                        .clamp(0, 100),
                    if is_nonsummon_direct_skill(skill_id) {
                        mystic
                            .and_then(|level| level.x)
                            .unwrap_or(0)
                            .max(0)
                            .saturating_mul(i64::from(player.mystic_strike_stacks))
                    } else {
                        0
                    },
                    if player.skill_buffs.contains_key(&SKILL_INFINITY) {
                        player.infinity_damage_bonus.max(0)
                    } else {
                        0
                    },
                )
            })
            .unwrap_or((0, 0, 0));
        ignored_md_rate = ignored_md_rate.saturating_add(mystic_ignore);
        let bind_md_rate = (target.bind_until > self.tick)
            .then_some(target.bind_md_rate_reduction)
            .unwrap_or(0)
            .clamp(0, 100) as f64;
        if let Some(md_rate) = target.template.md_rate {
            let md_rate = (md_rate - bind_md_rate).max(0.0);
            let effective_md_rate = (md_rate * (100.0 - ignored_md_rate.clamp(0, 100) as f64)
                / 100.0)
                .clamp(0.0, 100.0);
            damage = (damage as f64 * (100.0 - effective_md_rate) / 100.0)
                .floor()
                .max(1.0) as i64;
        }
        let hyper_damage_percent = self
            .players
            .get(id)
            .and_then(|player| {
                let passive = match skill_id {
                    SKILL_TELEPORT_MASTERY => SKILL_HYPER_TELEPORT_DAMAGE,
                    SKILL_CHAIN_LIGHTNING => SKILL_HYPER_CHAIN_DAMAGE,
                    SKILL_ICE_DEMON => SKILL_HYPER_ICE_DAMAGE,
                    _ => 0,
                };
                let passive_bonus = (passive != 0)
                    .then(|| player.state.skills.get(&passive).copied().unwrap_or(0))
                    .and_then(|level| self.mage_skills.level(passive, level))
                    .and_then(|level| level.dam_r)
                    .unwrap_or(0)
                    .max(0);
                let adventurer_bonus = player
                    .skill_buffs
                    .get(&SKILL_HYPER_ADVENTURER)
                    .copied()
                    .filter(|remaining| *remaining > 0)
                    .map(|_| {
                        self.mage_skills
                            .level(SKILL_HYPER_ADVENTURER, 1)
                            .and_then(|level| level.indie_dam_r)
                            .unwrap_or(10)
                    })
                    .unwrap_or(0)
                    .max(0);
                Some(passive_bonus.saturating_add(adventurer_bonus))
            })
            .unwrap_or(0);
        if hyper_damage_percent > 0 {
            damage = (damage as f64 * (100 + hyper_damage_percent) as f64 / 100.0)
                .floor()
                .max(1.0) as i64;
        }
        let amp = self
            .players
            .get(id)
            .and_then(|player| player.state.skills.get(&SKILL_ELEMENT_AMP))
            .copied()
            .and_then(|level| self.mage_skills.level(SKILL_ELEMENT_AMP, level))
            .and_then(|level| level.dam_r)
            .unwrap_or(0)
            .max(0);
        if is_magic_attack_skill(skill_id) && amp > 0 {
            damage = (damage as f64 * (100 + amp) as f64 / 100.0)
                .floor()
                .max(1.0) as i64;
        }
        let reset = self
            .players
            .get(id)
            .and_then(|player| player.state.skills.get(&SKILL_ELEMENTAL_RESET))
            .copied()
            .and_then(|level| self.mage_skills.level(SKILL_ELEMENTAL_RESET, level))
            .and_then(|level| level.md_r)
            .unwrap_or(0)
            .max(0);
        // P: no current mob export carries an elemental-resistance target, so
        // source `u` is intentionally not applied to mdRate.  mdR is the
        // independent final-damage multiplier and always applies here.
        if reset > 0 {
            damage = (damage as f64 * (100 + reset) as f64 / 100.0)
                .floor()
                .max(1.0) as i64;
        }
        let extreme = self
            .players
            .get(id)
            .and_then(|player| player.state.skills.get(&SKILL_EXTREME_MAGIC))
            .copied()
            .and_then(|level| self.mage_skills.level(SKILL_EXTREME_MAGIC, level))
            .and_then(|level| level.z)
            .unwrap_or(0)
            .max(0);
        let has_status =
            target.state.freeze_stacks.unwrap_or(0) > 0 || target.stun_until > self.tick;
        if extreme > 0 && has_status {
            damage = (damage as f64 * (100 + extreme) as f64 / 100.0)
                .floor()
                .max(1.0) as i64;
        }
        if critical {
            let critical_damage = self
                .players
                .get(id)
                .and_then(|player| player.state.skills.get(&SKILL_MAGIC_CRITICAL))
                .copied()
                .and_then(|level| self.mage_skills.level(SKILL_MAGIC_CRITICAL, level))
                .and_then(|level| level.critical_damage)
                .unwrap_or(0)
                .max(0);
            damage = (damage as f64 * (200 + critical_damage) as f64 / 100.0)
                .floor()
                .max(1.0) as i64;
        }
        if mystic_bonus > 0 {
            damage = (damage as f64 * (100 + mystic_bonus) as f64 / 100.0)
                .floor()
                .max(1.0) as i64;
        }
        if infinity_bonus > 0 {
            damage = (damage as f64 * (100 + infinity_bonus) as f64 / 100.0)
                .floor()
                .max(1.0) as i64;
        }
        if let Some(map_id) = self
            .monsters
            .get(target_id)
            .map(|monster| monster.map_id.clone())
        {
            let guard_percent = self.boss_damage_multiplier(&map_id, true);
            damage = (damage as i128 * i128::from(guard_percent) / 100).max(1) as i64;
        }
        damage
    }

    fn advance_mystic_strike(&mut self, id: &str, request_id: &str, target_id: &str) {
        let Some(level) = self
            .players
            .get(id)
            .and_then(|player| player.state.skills.get(&SKILL_MYSTIC_STRIKE))
            .copied()
            .and_then(|level| self.mage_skills.level(SKILL_MYSTIC_STRIKE, level).cloned())
        else {
            return;
        };
        let prop = level.prop.unwrap_or(0).clamp(0, 100) as u64;
        if prop == 0 || deterministic_percent(&[id, request_id, target_id, "mystic-strike"]) >= prop
        {
            return;
        }
        let cap = u32::try_from(level.y.unwrap_or(5).max(0))
            .unwrap_or(5)
            .min(5);
        let duration_ticks = u64::try_from(level.time.unwrap_or(5).max(0))
            .unwrap_or(5)
            .saturating_mul(1_000)
            .div_ceil(TICK_MS)
            .max(1);
        if let Some(player) = self.players.get_mut(id) {
            player.mystic_strike_stacks = player.mystic_strike_stacks.saturating_add(1).min(cap);
            player.mystic_strike_until = self.tick.saturating_add(duration_ticks);
        }
    }

    fn cast_elemental_area(
        &mut self,
        id: &str,
        request_id: &str,
        skill_id: u32,
        level: &MageLevel,
        lightning: bool,
    ) -> Result<(), String> {
        self.cast_elemental_area_at(id, request_id, skill_id, level, lightning, None)
    }

    fn cast_elemental_area_at(
        &mut self,
        id: &str,
        request_id: &str,
        skill_id: u32,
        level: &MageLevel,
        lightning: bool,
        origin: Option<(f64, f64, i8)>,
    ) -> Result<(), String> {
        self.cast_elemental_area_at_filtered(
            id, request_id, skill_id, level, lightning, origin, None,
        )
    }

    fn cast_elemental_area_at_filtered(
        &mut self,
        id: &str,
        request_id: &str,
        skill_id: u32,
        level: &MageLevel,
        lightning: bool,
        origin: Option<(f64, f64, i8)>,
        excluded: Option<&BTreeSet<String>>,
    ) -> Result<(), String> {
        let target_level = self.hyper_area_level(id, skill_id, level);
        let targets = origin
            .map(|(x, y, facing)| self.area_targets_at(id, &target_level, x, y, facing))
            .unwrap_or_else(|| self.area_targets(id, &target_level))
            .into_iter()
            .filter(|target_id| excluded.is_none_or(|excluded| !excluded.contains(target_id)))
            .collect::<Vec<_>>();
        let mut attack_count = level.attack_count.unwrap_or(1).clamp(
            1,
            if skill_id == SKILL_HYPER_THUNDER {
                15
            } else {
                12
            },
        );
        if skill_id == SKILL_CHAIN_LIGHTNING {
            let learned = self
                .players
                .get(id)
                .and_then(|player| player.state.skills.get(&SKILL_HYPER_CHAIN_ATTACK))
                .copied()
                .unwrap_or(0);
            if learned > 0 {
                let extra = self
                    .mage_skills
                    .level(SKILL_HYPER_CHAIN_ATTACK, learned)
                    .and_then(|value| value.attack_count)
                    .unwrap_or(1);
                attack_count = attack_count.saturating_add(extra).min(12);
            }
        }
        let target_count = targets.len();
        let lightning_effect = lightning || skill_id == SKILL_CHAIN_LIGHTNING;
        let magic_attack = self
            .players
            .get(id)
            .map(|player| player.state.derived_stats.magic_attack)
            .unwrap_or(1)
            .max(1);
        let mut consumed = BTreeMap::new();
        let mut successful_direct_targets = BTreeSet::new();
        for target_id in &targets {
            if lightning_effect {
                if self
                    .monsters
                    .get(target_id)
                    .is_some_and(|monster| monster.freeze_until <= self.tick)
                {
                    self.freeze_target(target_id, 0);
                }
                if self
                    .monsters
                    .get(target_id)
                    .and_then(|monster| monster.state.freeze_stacks)
                    .is_some_and(|stacks| stacks > 0)
                {
                    consumed.insert(
                        target_id.clone(),
                        self.monsters
                            .get(target_id)
                            .and_then(|monster| monster.state.freeze_stacks)
                            .unwrap_or(0),
                    );
                }
            }
        }
        // Preserve the existing freeze-effect coverage for every elemental
        // area source, including summons and the hidden Blizzard follow-up.
        // Fourth-job fixed level replaces the third-job node when both are
        // present; it must never create two independent layers.
        let fixed_effect = {
            let fourth = self
                .players
                .get(id)
                .and_then(|player| player.state.skills.get(&SKILL_FOURTH_FREEZE))
                .copied()
                .and_then(|level| self.mage_skills.level(SKILL_FOURTH_FREEZE, level));
            fourth
                .or_else(|| {
                    self.players
                        .get(id)
                        .and_then(|player| player.state.skills.get(&SKILL_ICE_EFFECT))
                        .copied()
                        .and_then(|level| self.mage_skills.level(SKILL_ICE_EFFECT, level))
                })
                .map(|level| (level.x.unwrap_or(0).max(0), level.y.unwrap_or(0).max(0)))
        };
        let fixed_crit = fixed_effect.map(|effect| effect.0).unwrap_or(0);
        let fixed_lightning = fixed_effect.map(|effect| effect.1).unwrap_or(0);
        if !lightning_effect && fixed_effect.is_some() {
            for target_id in &targets {
                if let Some(stacks) = self
                    .monsters
                    .get(target_id)
                    .and_then(|monster| monster.state.freeze_stacks)
                {
                    if stacks > 0 {
                        consumed.insert(target_id.clone(), stacks);
                    }
                }
            }
        }
        let critical_chance = self
            .magic_critical_chance(id)
            .saturating_add(
                (skill_id == SKILL_CHAIN_LIGHTNING)
                    .then_some(level.cr.unwrap_or(0).max(0))
                    .unwrap_or(0),
            )
            .clamp(0, 100);
        let weaken_level = self
            .players
            .get(id)
            .and_then(|player| player.state.skills.get(&SKILL_ELEMENTAL_WEAKEN))
            .copied()
            .unwrap_or(0);
        let weaken = self
            .mage_skills
            .level(SKILL_ELEMENTAL_WEAKEN, weaken_level)
            .cloned();
        for segment in 1..=attack_count {
            for target_id in &targets {
                if self
                    .monsters
                    .get(target_id)
                    .is_none_or(|monster| monster.state.hp <= 0)
                {
                    continue;
                }
                let (target_hp, target_max_hp, target_template, target_x, target_y, map_id, quests) =
                    match self.monsters.get(target_id) {
                        Some(monster) => (
                            monster.state.hp,
                            monster.state.max_hp,
                            monster.template.clone(),
                            monster.state.x,
                            monster.state.y,
                            monster.map_id.clone(),
                            self.players
                                .get(id)
                                .map(|player| player.quests.clone())
                                .unwrap_or_default(),
                        ),
                        None => continue,
                    };
                let normal_bonus = if !target_template.boss
                    && matches!(skill_id, SKILL_THUNDER_SPHERE | SKILL_THUNDER_SPHERE_HIDDEN)
                {
                    level.u2.unwrap_or(0).max(0)
                } else {
                    0
                };
                let multiplier = level
                    .damage
                    .unwrap_or(1)
                    .max(1)
                    .saturating_add(normal_bonus);
                let mut damage = (magic_attack as f64 * multiplier as f64 / 100.0)
                    .floor()
                    .max(1.0) as i64;
                if weaken.as_ref().is_some_and(|_| {
                    rand::thread_rng().gen_range(0..100)
                        < weaken
                            .as_ref()
                            .and_then(|level| level.prop)
                            .unwrap_or(0)
                            .clamp(0, 100)
                }) {
                    if let Some(monster) = self.monsters.get_mut(target_id) {
                        let seconds = weaken
                            .as_ref()
                            .and_then(|value| value.time)
                            .unwrap_or(5)
                            .max(0) as u64;
                        monster.elemental_weaken_until = self
                            .tick
                            .saturating_add(seconds.saturating_mul(1_000).div_ceil(TICK_MS));
                    }
                }
                if self
                    .monsters
                    .get(target_id)
                    .is_some_and(|monster| monster.elemental_weaken_until > self.tick)
                {
                    let bonus = weaken
                        .as_ref()
                        .and_then(|level| level.x)
                        .unwrap_or(20)
                        .max(0);
                    damage = (damage as f64 * (1.0 + bonus as f64 / 100.0)).floor() as i64;
                }
                let critical = rand::thread_rng().gen_range(0..100) < critical_chance;
                if let Some(stacks) = consumed.get(target_id).copied() {
                    let layer_bonus = if lightning_effect { fixed_lightning } else { 0 }
                        .saturating_add(if critical { fixed_crit } else { 0 });
                    damage = (damage as f64 * (1.0 + layer_bonus as f64 * stacks as f64 / 100.0))
                        .floor()
                        .max(1.0) as i64;
                }
                damage = self.magic_damage_with_passives(
                    id, skill_id, target_id, damage, critical, request_id, segment,
                );
                let killed = damage >= target_hp;
                let applied_damage = damage.min(target_hp.max(0));
                let practice = auth::is_practice_map(&map_id);
                let drops = if killed && !practice {
                    self.choose_drops(&target_template, target_x, target_y, id, &quests)
                } else {
                    Vec::new()
                };
                let action_request = format!("{request_id}:s{segment}:t{target_id}");
                let action_id = format!("skill-{request_id}-{segment}-{target_id}");
                let resolution = if let Some(store) = self.store.as_ref() {
                    let claim =
                        store.claim_attack(id, &map_id, &action_request, &action_id, "skill")?;
                    if claim.resolved {
                        continue;
                    }
                    store.resolve_attack_with_party(
                        id,
                        &map_id,
                        &action_request,
                        Some(target_id),
                        applied_damage,
                        killed,
                        target_template.exp,
                        target_max_hp,
                        &drops,
                        &self.gameplay.exp_table,
                        &self.players.keys().cloned().collect::<Vec<_>>(),
                        &self.party_exp_members(id),
                    )?
                } else {
                    auth::AttackResolution {
                        already_resolved: false,
                        target_id: Some(target_id.clone()),
                        damage: applied_damage,
                        killed,
                        exp_gain: if killed && !practice {
                            target_template.exp
                        } else {
                            0
                        },
                        drop: drops.first().cloned(),
                        drops,
                        profile: None,
                        profiles: Vec::new(),
                    }
                };
                if resolution.already_resolved {
                    continue;
                }
                if resolution.damage > 0 && is_nonsummon_direct_skill(skill_id) {
                    self.advance_mystic_strike(id, request_id, target_id);
                    successful_direct_targets.insert(target_id.clone());
                }
                if let Some(monster) = self.monsters.get_mut(target_id) {
                    monster.state.hp = (monster.state.hp - resolution.damage).max(0);
                    monster.state.action = if monster.state.hp == 0 { "die" } else { "hit" };
                    monster.state.action_started_tick = self.tick;
                    if monster.state.hp == 0 {
                        monster.freeze_until = 0;
                        monster.state.freeze_stacks = None;
                        monster.stun_until = 0;
                        monster.death_until = Some(
                            self.tick
                                + monster
                                    .template
                                    .die_duration_ms
                                    .unwrap_or(1)
                                    .div_ceil(TICK_MS)
                                    .max(1),
                        );
                        monster.respawn_at = respawn_deadline(
                            self.tick,
                            self.gameplay.monster_respawn_ms,
                            monster.spawn.mob_time,
                        );
                    }
                }
                if resolution.damage > 0 {
                    self.broadcast_to_map(
                        &map_id,
                        &serde_json::json!({
                            "type": "damageEvent",
                            "eventId": format!("damage-event-{id}-{request_id}-{segment}-{target_id}"),
                            "serverTick": self.tick,
                            "attackerId": id,
                            "targetId": target_id,
                            "x": target_x,
                            "y": target_y,
                            "damage": resolution.damage,
                            "killed": resolution.killed,
                            "skillId": skill_id,
                            "segment": segment,
                            "targetCount": target_count,
                            "critical": critical,
                        })
                        .to_string(),
                    );
                }
                if !resolution.profiles.is_empty() {
                    for (participant, profile) in resolution.profiles {
                        if let Some(player) = self.players.get_mut(&participant) {
                            apply_profile_to_player(
                                &self.gameplay,
                                &self.mage_skills,
                                player,
                                profile,
                            );
                        }
                    }
                } else if let Some(profile) = resolution.profile {
                    if let Some(player) = self.players.get_mut(id) {
                        apply_profile_to_player(&self.gameplay, &self.mage_skills, player, profile);
                    }
                } else if resolution.exp_gain > 0 && self.store.is_none() {
                    if let Some(player) = self.players.get_mut(id) {
                        Self::add_exp(
                            &mut player.state,
                            resolution.exp_gain,
                            &self.gameplay.exp_table,
                        );
                        refresh_player_derived(&self.gameplay, &self.mage_skills, player);
                    }
                }
                if segment == 1 {
                    // Apply absorption after a stored resolution profile so
                    // the MP delta cannot be overwritten by the old profile.
                    self.maybe_absorb_monster_mp(id, target_id);
                }
                if lightning_effect
                    && segment == 1
                    && fixed_effect.is_some()
                    && consumed.contains_key(target_id)
                {
                    // Consume one fixed-effect layer only after the attack
                    // resolution succeeds, so a persistent replay/failure
                    // cannot spend a freeze stack.
                    self.freeze_target(target_id, -1);
                }
                if !lightning
                    && skill_id != SKILL_CHAIN_LIGHTNING
                    && segment == 1
                    && resolution.damage > 0
                    && self
                        .monsters
                        .get(target_id)
                        .is_some_and(|monster| monster.state.hp > 0)
                {
                    // Freeze is a post-resolution effect.  This prevents a
                    // failed/duplicate DB claim from leaving a free stack,
                    // and the same cast cannot consume the stack it creates.
                    self.freeze_target(target_id, 1);
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
                    self.drop_maps.insert(drop_id, map_id.clone());
                }
            }
        }
        if is_nonsummon_direct_skill(skill_id) && skill_id != SKILL_BLIZZARD_HIDDEN {
            if !successful_direct_targets.is_empty() {
                let index = deterministic_percent(&[id, request_id, "blizzard-target"]) as usize
                    % successful_direct_targets.len();
                if let Some(target_id) = successful_direct_targets.iter().nth(index).cloned() {
                    self.maybe_cast_blizzard_follow_up(id, request_id, &target_id)?;
                }
            }
        }
        Ok(())
    }

    fn cast_thunder_sphere(
        &mut self,
        id: &str,
        request_id: &str,
        level: &MageLevel,
        vertical: i8,
    ) -> Result<(), String> {
        let Some(player_snapshot) = self.players.get(id).map(|player| {
            (
                player.map_id.clone(),
                player.state.x,
                player.state.y,
                player.state.facing,
                player.summon.clone(),
            )
        }) else {
            return Err("player_unknown".to_owned());
        };
        let (map_id, x, y, facing, existing) = player_snapshot;
        let hidden_level = self
            .mage_skills
            .level(
                SKILL_THUNDER_SPHERE_HIDDEN,
                self.players
                    .get(id)
                    .and_then(|player| player.state.skills.get(&SKILL_THUNDER_SPHERE))
                    .copied()
                    .unwrap_or(1),
            )
            .cloned()
            .unwrap_or_else(|| level.clone());
        let anchor = vertical > 0;
        let duration_source = if anchor {
            hidden_level.time.unwrap_or(20)
        } else {
            level.time.unwrap_or(60)
        };
        let duration_ticks = u64::try_from(duration_source.max(0))
            .unwrap_or(if anchor { 20 } else { 60 })
            .saturating_mul(1_000)
            .div_ceil(TICK_MS)
            .max(1);
        if let Some(existing) = existing
            .clone()
            .filter(|summon| {
                summon.skill_id == SKILL_THUNDER_SPHERE
                    || summon.skill_id == SKILL_THUNDER_SPHERE_HIDDEN
            })
            .filter(|_| anchor)
        {
            if let Some(player) = self.players.get_mut(id) {
                player.summon = Some(ThunderSummon {
                    x,
                    y,
                    facing,
                    anchored: true,
                    skill_id: SKILL_THUNDER_SPHERE_HIDDEN,
                    expires_at: existing
                        .expires_at
                        .min(self.tick.saturating_add(duration_ticks)),
                    ..existing
                });
            }
            return Ok(());
        }
        let summon = ThunderSummon {
            summon_id: format!("thunder-sphere-{id}-{request_id}"),
            skill_id: if anchor {
                SKILL_THUNDER_SPHERE_HIDDEN
            } else {
                SKILL_THUNDER_SPHERE
            },
            level: self
                .players
                .get(id)
                .and_then(|player| player.state.skills.get(&SKILL_THUNDER_SPHERE))
                .copied()
                .unwrap_or(1),
            map_id,
            x,
            y,
            facing,
            anchored: anchor,
            expires_at: self.tick.saturating_add(duration_ticks),
            next_hit_at: self.tick,
            pulse_index: 0,
        };
        if let Some(player) = self.players.get_mut(id) {
            player.summon = Some(summon);
        }
        Ok(())
    }

    fn step_summons(&mut self) {
        let ids: Vec<String> = self.players.keys().cloned().collect();
        let mut due = Vec::new();
        for id in ids {
            let map_id = self
                .players
                .get(&id)
                .map(|player| player.map_id.clone())
                .unwrap_or_default();
            let map = self.map_for(&map_id).clone();
            let Some(player) = self.players.get_mut(&id) else {
                continue;
            };
            if player.state.action == "dead" {
                player.summon = None;
                player.summons.clear();
                continue;
            }
            if let Some(mut summon) = player.summon.take() {
                if summon.expires_at > self.tick && summon.map_id == player.map_id {
                    if !summon.anchored {
                        summon.x = player.state.x;
                        summon.y = player.state.y;
                        summon.facing = player.state.facing;
                    }
                    if summon.next_hit_at <= self.tick {
                        due.push((id.clone(), summon.clone()));
                        let pulse_skill = if summon.skill_id == SKILL_THUNDER_SPHERE_HIDDEN {
                            SKILL_THUNDER_SPHERE_HIDDEN
                        } else {
                            SKILL_THUNDER_SPHERE
                        };
                        let pulse_ms = self
                            .mage_skills
                            .level(pulse_skill, summon.level)
                            .and_then(|level| level.sub_time)
                            .unwrap_or(1_080)
                            .max(1) as u64;
                        summon.next_hit_at = self.tick.saturating_add(pulse_ms.div_ceil(TICK_MS));
                        summon.pulse_index = summon.pulse_index.saturating_add(1);
                    }
                    player.summon = Some(summon);
                }
            }
            let mut retained = Vec::with_capacity(player.summons.len());
            for mut summon in std::mem::take(&mut player.summons) {
                if summon.expires_at <= self.tick || summon.map_id != player.map_id {
                    continue;
                }
                if summon.skill_id == SKILL_FROZEN_ORB {
                    let direction = if summon.facing < 0 { -1.0 } else { 1.0 };
                    summon.x = (summon.x + direction * 180.0 * TICK_MS as f64 / 1_000.0)
                        .clamp(map.bounds.x_min, map.bounds.x_max);
                }
                if summon.next_hit_at <= self.tick {
                    due.push((id.clone(), summon.clone()));
                    let pulse_ms = match summon.skill_id {
                        // The exported subTime is a source-side delay field,
                        // while this P implementation's periodic demon hit
                        // is explicitly 1080ms.  Do not interpret source 8
                        // as eight milliseconds.
                        SKILL_ICE_DEMON => 1_080,
                        SKILL_FROZEN_ORB => self
                            .mage_skills
                            .level(SKILL_FROZEN_ORB, summon.level)
                            .and_then(|level| level.attack_delay)
                            .unwrap_or(210)
                            .max(1) as u64,
                        _ => 1_080,
                    };
                    summon.next_hit_at = self.tick.saturating_add(pulse_ms.div_ceil(TICK_MS));
                    summon.pulse_index = summon.pulse_index.saturating_add(1);
                }
                retained.push(summon);
            }
            player.summons = retained;
        }
        for (id, summon) in due {
            let Some(pulse_level) = self
                .mage_skills
                .level(summon.skill_id, summon.level)
                .cloned()
                .or_else(|| {
                    self.mage_skills
                        .level(SKILL_THUNDER_SPHERE, summon.level)
                        .cloned()
                })
            else {
                continue;
            };
            let request_id = format!("{}-pulse-{}", summon.summon_id, summon.pulse_index);
            let lightning = matches!(
                summon.skill_id,
                SKILL_THUNDER_SPHERE | SKILL_THUNDER_SPHERE_HIDDEN
            );
            let result = self.cast_elemental_area_at(
                &id,
                &request_id,
                summon.skill_id,
                &pulse_level,
                lightning,
                Some((summon.x, summon.y, summon.facing)),
            );
            if let Err(error) = result {
                self.handle_accepted_effect_error(&id, &request_id, &error);
            }
        }
    }

    fn cast_glacial_wall(
        &mut self,
        id: &str,
        request_id: &str,
        level: &MageLevel,
    ) -> Result<(), String> {
        let targets = self.area_targets(id, level);
        self.cast_elemental_area(id, request_id, SKILL_GLACIAL_WALL, level, false)?;
        for target_id in targets {
            self.apply_glacial_push(id, &target_id);
        }
        Ok(())
    }

    fn apply_glacial_push(&mut self, caster_id: &str, target_id: &str) {
        let Some(caster_facing) = self
            .players
            .get(caster_id)
            .map(|player| player.state.facing)
        else {
            return;
        };
        let Some((map_id, x, y)) = self
            .monsters
            .get(target_id)
            .map(|monster| (monster.map_id.clone(), monster.state.x, monster.state.y))
        else {
            return;
        };
        let map = self.map_for(&map_id).clone();
        let direction = if caster_facing < 0 { -1.0 } else { 1.0 };
        // P: String/Skill has no server displacement contract for `u=480`;
        // use one bounded source-facing push so the wall has a visible,
        // collision-safe effect without inventing a map-wide knockback.
        let pushed_x = (x + direction * 48.0).clamp(map.bounds.x_min, map.bounds.x_max);
        let Some((foothold_id, pushed_y)) = map
            .ground_near(pushed_x, y)
            .filter(|(_, ground)| (ground - y).abs() <= 48.0)
            .map(|(foothold_id, ground)| (foothold_id, ground))
        else {
            return;
        };
        if let Some(monster) = self.monsters.get_mut(target_id) {
            if monster.state.hp <= 0 {
                return;
            }
            monster.state.x = pushed_x;
            monster.state.y = pushed_y;
            monster.foothold_id = foothold_id;
        }
    }

    fn cast_teleport_mastery(
        &mut self,
        id: &str,
        request_id: &str,
        level: &MageLevel,
    ) -> Result<(), String> {
        let targets = self.skill_area_targets(id, SKILL_TELEPORT_MASTERY, level);
        self.cast_elemental_area(id, request_id, SKILL_TELEPORT_MASTERY, level, true)?;
        let chance = level.sub_prop.unwrap_or(0).clamp(0, 100) as u64;
        let duration_ticks = u64::try_from(level.time.unwrap_or(2).max(0))
            .unwrap_or(2)
            .saturating_mul(1_000)
            .div_ceil(TICK_MS);
        for target_id in targets {
            let roll =
                deterministic_percent(&[id, request_id, target_id.as_str(), "teleport-mastery"]);
            if roll >= chance {
                continue;
            }
            if let Some(monster) = self.monsters.get_mut(&target_id) {
                if monster.state.hp > 0 {
                    monster.stun_until = self.tick.saturating_add(duration_ticks.max(1));
                    monster.state.action = "hit";
                    monster.state.action_started_tick = self.tick;
                }
            }
        }
        Ok(())
    }

    fn maybe_create_ice_field(&mut self, id: &str, start_x: f64, start_y: f64) {
        let Some((map_id, end_x, end_y, facing, level)) = self.players.get(id).and_then(|player| {
            if !player.ice_teleport_enabled {
                return None;
            }
            player
                .state
                .skills
                .get(&SKILL_ICE_TELEPORT)
                .and_then(|level| self.mage_skills.level(SKILL_ICE_TELEPORT, *level))
                .cloned()
                .map(|level| {
                    (
                        player.map_id.clone(),
                        player.state.x,
                        player.state.y,
                        player.state.facing,
                        level,
                    )
                })
        }) else {
            return;
        };
        let prop = level.prop.unwrap_or(0).clamp(0, 100);
        if prop == 0
            || rand::thread_rng().gen_range(0..100) >= prop
            || (start_x - end_x).abs() < 0.001 && (start_y - end_y).abs() < 0.001
        {
            return;
        }
        let lt = level
            .lt
            .map(|point| (point.x, point.y))
            .unwrap_or((-20.0, -20.0));
        let rb = level
            .rb
            .map(|point| (point.x, point.y))
            .unwrap_or((40.0, 20.0));
        // P: use the authored rectangle as a swept corridor and round the
        // source subTime to the fixed world tick; no source tile scheduler is
        // available in this server.
        let sub_time_ms = level
            .sub_time
            .unwrap_or(i64::try_from(ICE_TELEPORT_FIELD_DEFAULT_SUB_TIME_MS).unwrap_or(1_200))
            .max(1) as u64;
        let duration_ms = (level.time.unwrap_or(6).max(0) as u64).saturating_mul(1_000);
        let expires_at = self.tick.saturating_add(duration_ms.div_ceil(TICK_MS));
        let field_index = self
            .players
            .get(id)
            .map(|player| player.ice_fields.len())
            .unwrap_or(0);
        let field_id = format!("ice-field-cast-{id}-{}-{field_index}", self.tick);
        let field = IceField {
            field_id: field_id.clone(),
            map_id: map_id.clone(),
            start_x,
            start_y,
            end_x,
            end_y,
            lt,
            rb,
            damage_percent: level.damage.unwrap_or(2).max(0),
            expires_at,
            next_hit_at: self.tick,
            sub_time_ms,
        };
        let pushed = if let Some(player) = self.players.get_mut(id) {
            player.ice_fields.push(field);
            true
        } else {
            false
        };
        if pushed {
            // P: reuse the existing skillCast envelope so clients can render
            // the authored rectangular corridor without a new protocol type.
            self.broadcast_to_map(
                &map_id,
                &serde_json::json!({
                    "type": "skillCast",
                    "eventId": field_id,
                    "serverTick": self.tick,
                    "playerId": id,
                    "skillId": SKILL_ICE_TELEPORT,
                    "requestId": format!("ice-field-cast-{id}-{}-{field_index}", self.tick),
                    "x": start_x,
                    "y": start_y,
                    "targetX": end_x,
                    "targetY": end_y,
                    "facing": facing,
                    "durationMs": duration_ms,
                })
                .to_string(),
            );
        }
    }

    fn step_ice_fields(&mut self) {
        let ids: Vec<String> = self.players.keys().cloned().collect();
        let mut due = Vec::new();
        for id in ids {
            let Some(player) = self.players.get(&id) else {
                continue;
            };
            for (index, field) in player.ice_fields.iter().enumerate() {
                if field.expires_at <= self.tick || field.next_hit_at > self.tick {
                    continue;
                }
                let targets = self
                    .monsters
                    .iter()
                    .filter_map(|(monster_id, monster)| {
                        (monster.map_id == field.map_id
                            && monster.state.hp > 0
                            && self.ice_field_contains(field, monster.state.x, monster.state.y))
                        .then_some(monster_id.clone())
                    })
                    .take(6)
                    .collect::<Vec<_>>();
                due.push((id.clone(), index, field.clone(), targets));
            }
        }
        for (id, index, field, targets) in due {
            for target_id in targets {
                let _ = self.resolve_ice_field_hit(&id, &field, &target_id);
            }
            if let Some(player) = self.players.get_mut(&id) {
                if let Some(field) = player.ice_fields.get_mut(index) {
                    field.next_hit_at = self
                        .tick
                        .saturating_add(field.sub_time_ms.div_ceil(TICK_MS));
                }
            }
        }
        for player in self.players.values_mut() {
            player
                .ice_fields
                .retain(|field| field.expires_at > self.tick);
        }
    }

    fn ice_field_contains(&self, field: &IceField, x: f64, y: f64) -> bool {
        let left = field.start_x.min(field.end_x) + field.lt.0.min(field.rb.0);
        let right = field.start_x.max(field.end_x) + field.lt.0.max(field.rb.0);
        let top = field.start_y.min(field.end_y) + field.lt.1.min(field.rb.1);
        let bottom = field.start_y.max(field.end_y) + field.lt.1.max(field.rb.1);
        x >= left && x <= right && y >= top && y <= bottom
    }

    fn resolve_ice_field_hit(
        &mut self,
        id: &str,
        field: &IceField,
        target_id: &str,
    ) -> Result<(), String> {
        let (target_hp, target_max_hp, template, x, y, quests) = match self.monsters.get(target_id)
        {
            Some(monster) if monster.state.hp > 0 => (
                monster.state.hp,
                monster.state.max_hp,
                monster.template.clone(),
                monster.state.x,
                monster.state.y,
                self.players
                    .get(id)
                    .map(|player| player.quests.clone())
                    .unwrap_or_default(),
            ),
            _ => return Ok(()),
        };
        let magic_attack = self
            .players
            .get(id)
            .map(|player| player.state.derived_stats.magic_attack)
            .unwrap_or(1)
            .max(1);
        let base_damage = (magic_attack as f64 * field.damage_percent as f64 / 100.0)
            .floor()
            .max(1.0) as i64;
        let request_id = format!("{}-hit-{}-{}", field.field_id, self.tick, target_id);
        let critical = rand::thread_rng().gen_range(0..100) < self.magic_critical_chance(id);
        let damage = self.magic_damage_with_passives(
            id,
            SKILL_ICE_TELEPORT,
            target_id,
            base_damage,
            critical,
            &request_id,
            1,
        );
        let killed = damage >= target_hp;
        let applied_damage = damage.min(target_hp.max(0));
        let practice = auth::is_practice_map(&field.map_id);
        let drops = if killed && !practice {
            self.choose_drops(&template, x, y, id, &quests)
        } else {
            Vec::new()
        };
        let resolution = if let Some(store) = self.store.as_ref() {
            let action_id = request_id.clone();
            let claim = store.claim_attack(id, &field.map_id, &request_id, &action_id, "skill")?;
            if claim.resolved {
                return Ok(());
            }
            store.resolve_attack_with_party(
                id,
                &field.map_id,
                &request_id,
                Some(target_id),
                applied_damage,
                killed,
                template.exp,
                target_max_hp,
                &drops,
                &self.gameplay.exp_table,
                &self.players.keys().cloned().collect::<Vec<_>>(),
                &self.party_exp_members(id),
            )?
        } else {
            auth::AttackResolution {
                already_resolved: false,
                target_id: Some(target_id.to_owned()),
                damage: applied_damage,
                killed,
                exp_gain: if killed && !practice { template.exp } else { 0 },
                drop: drops.first().cloned(),
                drops,
                profile: None,
                profiles: Vec::new(),
            }
        };
        if resolution.already_resolved {
            return Ok(());
        }
        self.freeze_target(target_id, 1);
        if let Some(monster) = self.monsters.get_mut(target_id) {
            monster.state.hp = (monster.state.hp - resolution.damage).max(0);
            monster.state.action = if monster.state.hp == 0 { "die" } else { "hit" };
            monster.state.action_started_tick = self.tick;
            if monster.state.hp == 0 {
                monster.freeze_until = 0;
                monster.state.freeze_stacks = None;
                monster.stun_until = 0;
                monster.death_until = Some(
                    self.tick
                        + monster
                            .template
                            .die_duration_ms
                            .unwrap_or(1)
                            .div_ceil(TICK_MS)
                            .max(1),
                );
                monster.respawn_at = respawn_deadline(
                    self.tick,
                    self.gameplay.monster_respawn_ms,
                    monster.spawn.mob_time,
                );
            }
        }
        if resolution.damage > 0 {
            self.broadcast_to_map(
                &field.map_id,
                &serde_json::json!({
                    "type": "damageEvent",
                    "eventId": format!("damage-event-{request_id}"),
                    "serverTick": self.tick,
                    "attackerId": id,
                    "targetId": target_id,
                    "x": x,
                    "y": y,
                    "damage": resolution.damage,
                    "killed": resolution.killed,
                    "skillId": SKILL_ICE_TELEPORT,
                    "segment": 1,
                    "targetCount": 1,
                    "critical": critical,
                })
                .to_string(),
            );
        }
        if !resolution.profiles.is_empty() {
            for (participant, profile) in resolution.profiles {
                if let Some(player) = self.players.get_mut(&participant) {
                    apply_profile_to_player(&self.gameplay, &self.mage_skills, player, profile);
                }
            }
        } else if let Some(profile) = resolution.profile {
            if let Some(player) = self.players.get_mut(id) {
                apply_profile_to_player(&self.gameplay, &self.mage_skills, player, profile);
            }
        } else if resolution.exp_gain > 0 && self.store.is_none() {
            if let Some(player) = self.players.get_mut(id) {
                Self::add_exp(
                    &mut player.state,
                    resolution.exp_gain,
                    &self.gameplay.exp_table,
                );
                refresh_player_derived(&self.gameplay, &self.mage_skills, player);
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
            self.drop_maps.insert(drop_id, field.map_id.clone());
        }
        Ok(())
    }

    fn cast_energy_bolt(
        &mut self,
        id: &str,
        request_id: &str,
        skill_id: u32,
        level: &MageLevel,
    ) -> Result<(), String> {
        let targets = self.energy_targets(id, level);
        let attack_count = level.attack_count.unwrap_or(1).clamp(1, 4);
        let target_count = targets.len();
        let magic_attack = self
            .players
            .get(id)
            .map(|player| player.state.derived_stats.magic_attack)
            .unwrap_or(1)
            .max(1);
        let critical_chance = self.magic_critical_chance(id);
        let mut successful_direct_targets = BTreeSet::new();
        for segment in 1..=attack_count {
            for target_id in &targets {
                if self
                    .monsters
                    .get(target_id)
                    .is_none_or(|monster| monster.state.hp <= 0)
                {
                    continue;
                }
                let (target_template, target_hp, target_max_hp, target_x, target_y, map_id, quests) =
                    match self.monsters.get(target_id) {
                        Some(monster) => {
                            let quests = self
                                .players
                                .get(id)
                                .map(|player| player.quests.clone())
                                .unwrap_or_default();
                            (
                                monster.template.clone(),
                                monster.state.hp,
                                monster.state.max_hp,
                                monster.state.x,
                                monster.state.y,
                                monster.map_id.clone(),
                                quests,
                            )
                        }
                        None => continue,
                    };
                let damage_percent = level.damage.unwrap_or(1).max(1) as f64 / 100.0;
                let mut damage = (magic_attack as f64 * damage_percent).floor().max(1.0) as i64;
                let mut critical = false;
                let weaken_level = self
                    .players
                    .get(id)
                    .and_then(|player| player.state.skills.get(&SKILL_ELEMENTAL_WEAKEN))
                    .copied()
                    .unwrap_or(0);
                if weaken_level > 0 {
                    let weaken = self.mage_skills.level(SKILL_ELEMENTAL_WEAKEN, weaken_level);
                    let prop = weaken
                        .and_then(|value| value.prop)
                        .unwrap_or(0)
                        .clamp(0, 100);
                    let applies = rand::thread_rng().gen_range(0..100) < prop;
                    if applies {
                        let seconds =
                            weaken.and_then(|value| value.time).unwrap_or(5).max(0) as u64;
                        if let Some(monster) = self.monsters.get_mut(target_id) {
                            monster.elemental_weaken_until = self
                                .tick
                                .saturating_add(seconds.saturating_mul(1_000).div_ceil(TICK_MS));
                        }
                    }
                }
                if self
                    .monsters
                    .get(target_id)
                    .is_some_and(|monster| monster.elemental_weaken_until > self.tick)
                {
                    let x = self
                        .mage_skills
                        .level(SKILL_ELEMENTAL_WEAKEN, weaken_level)
                        .and_then(|value| value.x)
                        .unwrap_or(20)
                        .max(0);
                    damage = (damage as f64 * (1.0 + x as f64 / 100.0)).floor() as i64;
                }
                // P/R: Character/Weapon 1372000's source display flag carries
                // cr=5; second-job Spell Mastery adds its exported `cr`.
                if rand::thread_rng().gen_range(0..100) < critical_chance {
                    critical = true;
                }
                damage = self.magic_damage_with_passives(
                    id, skill_id, target_id, damage, critical, request_id, segment,
                );
                let killed = damage >= target_hp;
                let applied_damage = damage.min(target_hp.max(0));
                let practice = auth::is_practice_map(&map_id);
                let drops = if killed && !practice {
                    self.choose_drops(&target_template, target_x, target_y, id, &quests)
                } else {
                    Vec::new()
                };
                let action_request = format!("{request_id}:s{segment}:t{target_id}");
                let action_id = format!("skill-{request_id}-{segment}-{target_id}");
                let resolution = if let Some(store) = self.store.as_ref() {
                    let claim =
                        store.claim_attack(id, &map_id, &action_request, &action_id, "skill")?;
                    if claim.resolved {
                        continue;
                    }
                    store.resolve_attack_with_party(
                        id,
                        &map_id,
                        &action_request,
                        Some(target_id),
                        applied_damage,
                        killed,
                        target_template.exp,
                        target_max_hp,
                        &drops,
                        &self.gameplay.exp_table,
                        &self.players.keys().cloned().collect::<Vec<_>>(),
                        &self.party_exp_members(id),
                    )?
                } else {
                    auth::AttackResolution {
                        already_resolved: false,
                        target_id: Some(target_id.clone()),
                        damage: applied_damage,
                        killed,
                        exp_gain: if killed && !practice {
                            target_template.exp
                        } else {
                            0
                        },
                        drop: drops.first().cloned(),
                        drops,
                        profile: None,
                        profiles: Vec::new(),
                    }
                };
                if resolution.already_resolved {
                    continue;
                }
                if resolution.damage > 0 {
                    self.advance_mystic_strike(id, request_id, target_id);
                    successful_direct_targets.insert(target_id.clone());
                }
                if let Some(monster) = self.monsters.get_mut(target_id) {
                    if resolution.damage > 0 {
                        let contribution =
                            monster.damage_by_player.entry(id.to_owned()).or_default();
                        *contribution = contribution.saturating_add(resolution.damage);
                        // Prey turns hostile to this attacker; see
                        // `step_monsters` for the per-step pursuit resolution.
                        mark_monster_hit_aggro(monster, &id, self.tick);
                    }
                    monster.state.hp = (monster.state.hp - resolution.damage).max(0);
                    monster.state.action = if monster.state.hp == 0 { "die" } else { "hit" };
                    monster.state.action_started_tick = self.tick;
                    if monster.state.hp == 0 {
                        monster.freeze_until = 0;
                        monster.state.freeze_stacks = None;
                        monster.stun_until = 0;
                        let die_ticks = monster
                            .template
                            .die_duration_ms
                            .unwrap_or(1)
                            .div_ceil(TICK_MS)
                            .max(1);
                        monster.death_until = Some(self.tick + die_ticks);
                        monster.respawn_at = respawn_deadline(
                            self.tick,
                            self.gameplay.monster_respawn_ms,
                            monster.spawn.mob_time,
                        );
                    }
                }
                if resolution.damage > 0 {
                    self.broadcast_to_map(
                        &map_id,
                        &serde_json::json!({
                            "type": "damageEvent",
                            "eventId": format!("damage-event-{id}-{request_id}-{segment}-{target_id}"),
                            "serverTick": self.tick,
                            "attackerId": id,
                            "targetId": target_id,
                            "x": target_x,
                            "y": target_y,
                            "damage": resolution.damage,
                            "killed": resolution.killed,
                            "skillId": skill_id,
                            "segment": segment,
                            "targetCount": target_count,
                            "critical": critical,
                        })
                        .to_string(),
                    );
                }
                if !resolution.profiles.is_empty() {
                    for (participant, profile) in resolution.profiles {
                        if let Some(player) = self.players.get_mut(&participant) {
                            apply_profile_to_player(
                                &self.gameplay,
                                &self.mage_skills,
                                player,
                                profile,
                            );
                        }
                    }
                } else if let Some(profile) = resolution.profile {
                    if let Some(player) = self.players.get_mut(id) {
                        apply_profile_to_player(&self.gameplay, &self.mage_skills, player, profile);
                    }
                }
                if segment == 1 {
                    self.maybe_absorb_monster_mp(id, target_id);
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
                    self.drop_maps.insert(drop_id, map_id.clone());
                }
            }
        }
        if let Some(target_id) = successful_direct_targets.iter().next() {
            self.maybe_cast_blizzard_follow_up(id, request_id, target_id)?;
        }
        // Leave the player action visible for the source/client animation.
        let attack_duration_ticks = self.energy_duration_ms(id).div_ceil(TICK_MS);
        if let Some(player) = self.players.get_mut(id) {
            player.state.action = "attack";
            player.state.action_started_tick = self.tick;
            player.attack_until = self.tick + attack_duration_ticks;
        }
        Ok(())
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
                                apply_profile_to_player(
                                    &self.gameplay,
                                    &self.mage_skills,
                                    player,
                                    profile,
                                );
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
                self.send_quest_list(&id);
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
                                    apply_profile_to_player(
                                        &self.gameplay,
                                        &self.mage_skills,
                                        player,
                                        profile,
                                    );
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
                    if outcome.success {
                        self.send_quest_list(&id);
                    }
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
        if outcome.success {
            self.send_quest_list(&id);
        }
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
        if auth::is_practice_map(&map_id) {
            self.send_reject(
                &id,
                "practice_inventory_locked",
                "练习中不能丢弃物品。",
                Some(&request_id),
            );
            return;
        }
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
                                    apply_profile_to_player(
                                        &self.gameplay,
                                        &self.mage_skills,
                                        player,
                                        profile,
                                    );
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
                    if outcome.success {
                        self.send_quest_list(&id);
                    }
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
                    // P: user-authorized drop floating — pin to surface if the
                    // player dropped the item while swimming.
                    let drop_y = self.map.water_float_y(drop_x, drop_y);
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
        if outcome.success {
            self.send_quest_list(&id);
        }
    }

    fn equipment_stats(&self, id: &str) -> inventory::EquipmentStats {
        let (level, job, ability) = self
            .players
            .get(id)
            .map(|player| {
                (
                    player.state.level,
                    player.state.job,
                    player.state.ability_stats.clone(),
                )
            })
            .unwrap_or((1, 0, AbilityStats::default()));
        inventory::EquipmentStats {
            level,
            job,
            strength: ability.strength.max(0),
            dexterity: ability.dexterity.max(0),
            intelligence: ability.intelligence.max(0),
            luck: ability.luck.max(0),
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
                                    apply_profile_to_player(
                                        &self.gameplay,
                                        &self.mage_skills,
                                        player,
                                        profile,
                                    );
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

    /// Resolve where a map-move consumable (`spec.moveTo`) would send this
    /// character, or refuse it.
    ///
    /// The item side is source data, but the *destination* is a world fact:
    /// 回家卷軸 asks for the current map's authored `returnMap`, a fixed scroll
    /// names its town outright.  Resolving here — before either persistence
    /// path — is what makes "a scroll with nowhere to go is never spent" true
    /// by construction, because the item is only ever paid for after this has
    /// returned a reachable map.  `Ok(None)` means the item is not a map-move
    /// consumable at all, i.e. the ordinary potion/scroll paths keep working.
    fn plan_map_move(&self, id: &str, item_id: &str) -> Result<Option<String>, &'static str> {
        let Some(target) = inventory::move_target(item_id) else {
            return Ok(None);
        };
        let Some(player) = self.players.get(id) else {
            return Err("item_unavailable");
        };
        if player.state.action == "dead" || player.state.hp <= 0 {
            return Err("dead");
        }
        // A Boss practice instance is not part of the map catalog, so the
        // character's `returnMap` would resolve against the wrong map — and
        // leaving a practice encounter is the practice window's own decision,
        // never a scroll's.  Mirrors the practice guards on the other
        // escape-like intents (dropping mesos, leaving the map).
        if auth::is_practice_map(&player.map_id) {
            return Err("scroll_blocked");
        }
        let current_map_id = player.map_id.as_str();
        let destination = match target {
            inventory::MapMoveTarget::ReturnMap => match self.return_maps.get(current_map_id) {
                Some(town_id) => town_id.clone(),
                None => return Err("scroll_no_target"),
            },
            inventory::MapMoveTarget::Map(town_id) => town_id,
        };
        if !self.maps.contains_key(&destination) {
            return Err("scroll_unavailable");
        }
        Ok(Some(destination))
    }

    /// Land one character on a town the scroll named, after that scroll has
    /// actually been spent.
    ///
    /// A scroll names a *map*, never a gate, so the body arrives on that map's
    /// authored `sp` spawn point — the same landing a fresh join uses, re-grounded
    /// through the shared foothold lookup.  Every scene-scoped field the portal
    /// path clears is cleared here too; otherwise a scroll and a gate would
    /// leave different residue behind (a live summon or an ice field floating in
    /// a town the caster is no longer in).
    fn land_player_on_return_map(&mut self, id: &str, target_map_id: &str) {
        let Some(target_map) = self.maps.get(target_map_id).cloned() else {
            return;
        };
        self.end_conversation(id);
        let Some(player) = self.players.get_mut(id) else {
            return;
        };
        player.map_id = target_map_id.to_owned();
        player.natural_recovery_next_tick =
            self.tick.saturating_add(NATURAL_RECOVERY_INTERVAL_TICKS);
        reset_player_to_spawn(&target_map, player, self.tick);
        player.attack_until = 0;
        player.meditation_until = 0;
        player.meditation_mad = 0;
        clear_beginner_buffs(player);
        player.ice_teleport_enabled = false;
        player.ice_fields.clear();
        player.teleport_mastery_enabled = false;
        player.teleport_boost_enabled = false;
        player.adaptation_active = false;
        player.adaptation_charges = 0;
        player.summon = None;
        player.state.action_id = None;
        refresh_player_derived(&self.gameplay, &self.mage_skills, player);
        self.send_snapshot(id);
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
        // Consumable cooldown gate.  Only items that author a `spec.time`
        // cooldown are ever in this map; an ordinary potion has no entry and
        // can be drunk as fast as the player can click, which is the
        // original's behaviour.  The check runs before any persistence so a
        // rejected use never spends an item.
        if let Some(ready_tick) = player.potion_cooldowns.get(&item_id).copied() {
            if self.tick < ready_tick {
                let remaining_ms = ready_tick.saturating_sub(self.tick) * TICK_MS;
                self.send_reject(
                    &id,
                    "potion_cooldown",
                    &format_potion_cooldown(remaining_ms, player.lang),
                    Some(&request_id),
                );
                return;
            }
        }
        if let Some(store) = self.store.clone() {
            let derived_max_mp = player.state.max_mp;
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
            // Resolve a map-move destination only for a *fresh* request: the
            // idempotency peek above has already answered a replay with its
            // original result, so a retried scroll can never move the body a
            // second time.  An unusable scroll is refused here, before the
            // transaction, and therefore spends nothing.
            let move_destination = match self.plan_map_move(&id, &item_id) {
                Ok(destination) => destination,
                Err(code) => {
                    self.send_reject(
                        &id,
                        code,
                        map_move_reject_message(code, player.lang),
                        Some(&request_id),
                    );
                    return;
                }
            };
            let stats = self.equipment_stats(&id);
            let recovery = inventory::use_effect(&item_id).ok();
            match store.use_item_with_max_mp(
                &id,
                &request_id,
                inventory_type,
                source_slot,
                &item_id,
                target_slot,
                target_item_id.as_deref(),
                stats,
                Some(derived_max_mp),
            ) {
                Ok(outcome) => {
                    if outcome.success {
                        self.arm_potion_cooldown(&id, &item_id, recovery);
                        let defaults = self.default_profile();
                        if let Ok(profile) = store.load_profile(&id, &defaults) {
                            if let Some(player) = self.players.get_mut(&id) {
                                apply_profile_to_player(
                                    &self.gameplay,
                                    &self.mage_skills,
                                    player,
                                    profile,
                                );
                                if let Ok(equipped) = store.load_equipped(&id) {
                                    player.state.equipped = equipped;
                                    refresh_player_derived(
                                        &self.gameplay,
                                        &self.mage_skills,
                                        player,
                                    );
                                }
                                if let Ok(monster_book) = store.load_monster_book(&id) {
                                    player.state.monster_book = monster_book;
                                }
                            }
                        }
                    }
                    if outcome.success {
                        if let Some(destination) = move_destination.as_deref() {
                            // The scroll is persisted and the unit is already
                            // gone; only now does the body travel.  Nothing can
                            // fail here — the destination was proven to be an
                            // assembled map before the transaction ran.
                            self.land_player_on_return_map(&id, destination);
                        }
                    }
                    self.send_inventory_outcome(&id, &outcome);
                    if outcome.success && matches!(outcome.operation.as_str(), "equip" | "unequip")
                    {
                        self.send_quest_list(&id);
                        self.send_snapshot(&id);
                    }
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
        // Mirrors the store branch: only a fresh request resolves a destination,
        // so the idempotency peek above stays the single answer for a retry.
        let move_destination = match self.plan_map_move(&id, &item_id) {
            Ok(destination) => destination,
            Err(code) => {
                self.send_reject(
                    &id,
                    code,
                    map_move_reject_message(code, player.lang),
                    Some(&request_id),
                );
                return;
            }
        };
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
            } else if let Ok(effect) = inventory::use_effect(&item_id) {
                // Percentage recovery (`hpR`/`mpR`) is resolved against this
                // body's own maxima, so the same potion scales with the
                // character instead of carrying a baked-in amount.
                if let Some(player) = self.players.get_mut(&id) {
                    let (hp, mp) = effect.resolve(player.state.max_hp, player.state.max_mp);
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
            } else if inventory::move_target(&item_id).is_some() {
                // Mirrors the store branch: `plan_map_move` already proved the
                // destination is an assembled map, so this only has to spend a
                // unit.  The body itself travels after the state commit below,
                // which keeps "paid for" and "moved" in that order.
                inventory::remove_items(&mut inventory_items, 2, source_slot, 1)
                    .map(|_| result_code = "map_move".to_owned())
            } else {
                Err(inventory::InventoryError::ItemNotUsable)
            }
        } else {
            Err(inventory::InventoryError::InvalidInventoryType)
        };
        let (success, code) = match result {
            Ok(()) => {
                if operation == "use" {
                    self.arm_potion_cooldown(&id, &item_id, inventory::use_effect(&item_id).ok());
                }
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.inventory = inventory_items;
                    player.state.equipped = equipped_items;
                    refresh_player_derived(&self.gameplay, &self.mage_skills, player);
                }
                (true, result_code)
            }
            Err(error) => (false, error.code().to_owned()),
        };
        if success {
            if let Some(destination) = move_destination.as_deref() {
                // Persisted-then-travel, same order as the store branch: the
                // unit is already gone from the committed inventory, so the
                // landing can never leave an unpaid scroll behind.
                self.land_player_on_return_map(&id, destination);
            }
        }
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
        if outcome.success && matches!(outcome.operation.as_str(), "equip" | "unequip") {
            self.send_quest_list(&id);
            self.send_snapshot(&id);
        }
    }

    fn handle_drop_mesos(&mut self, id: String, request_id: String, quantity: u32) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        let map_id = player.map_id.clone();
        let x = player.state.x;
        let y = player.state.y;
        if auth::is_practice_map(&map_id) {
            self.send_reject(
                &id,
                "practice_inventory_locked",
                "练习中不能丢弃枫币。",
                Some(&request_id),
            );
            return;
        }
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
                    // P: user-authorized drop floating — mesos dropped while
                    // swimming pin to just below the surface.
                    y: self.map.water_float_y(x, y),
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
            // P: user-authorized drop floating.
            let (load_x, load_y) = (drop.x, self.map.water_float_y(drop.x, drop.y));
            self.drops.insert(
                drop_id.to_owned(),
                DropState {
                    id: drop.id.clone(),
                    item_id: drop.item_id.clone(),
                    quantity: drop.quantity,
                    x: load_x,
                    y: load_y,
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
        // P: user-authorized drop floating — pin to surface if dropped in water.
        let float_y = self.map.water_float_y(x, y);
        self.drops.insert(
            drop_id.to_owned(),
            DropState {
                id: drop_id.to_owned(),
                item_id: outcome.item_id.clone(),
                quantity: outcome.quantity,
                x,
                y: float_y,
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
        if self.players.get(&id).is_some_and(|player| {
            auth::is_practice_map(&player.map_id) && player.state.action == "dead"
        }) {
            // Resolve the private encounter before applying the normal revive
            // transaction, so a revived player cannot remain in a deleted
            // practice map or revive a Boss state that was already failed.
            if !self.finish_boss_practice(&id, Some(boss::BossPracticeStatus::Failed), true, true) {
                self.send_reject(
                    &id,
                    "persistence",
                    "练习结果尚未保存，请稍后重试。",
                    Some(&request_id),
                );
                return;
            }
        }
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
        player.swimming = false;
        player.death_id.clear();
        player.natural_recovery_next_tick =
            self.tick.saturating_add(NATURAL_RECOVERY_INTERVAL_TICKS);
        player.attack_until = 0;
        player.magic_wave_used = false;
        player.magic_wave_float_used = false;
        player.slow_fall_until = 0;
        player.meditation_until = 0;
        player.meditation_mad = 0;
        clear_beginner_buffs(player);
        player.ice_teleport_enabled = false;
        player.ice_fields.clear();
        player.teleport_mastery_enabled = false;
        player.teleport_boost_enabled = false;
        player.adaptation_active = false;
        player.adaptation_charges = 0;
        player.summon = None;
        refresh_player_derived(&self.gameplay, &self.mage_skills, player);
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
                player.state.job,
                player.state.hp > 0 && player.state.action != "dead",
                player.state.mesos,
                player.state.inventory.clone(),
                player.lang,
            ),
            None => return,
        };
        let (map_id, px, py, level, job, can_advance, mesos, inventory, lang) = player_state;
        // Locate the npc and its template.
        let npc_view = {
            let Some(npc) = self.npcs.get(&npc_id) else {
                let (code, message) = if lang == crate::quest_text::LANG_EN {
                    ("npc_unknown", "That NPC is not on this map.")
                } else {
                    ("npc_unknown", "找不到该 NPC。")
                };
                self.send_reject(&id, code, message, Some(&request_id));
                return;
            };
            if npc.map_id != map_id {
                self.end_conversation(&id);
                let (code, message) = if lang == crate::quest_text::LANG_EN {
                    ("npc_too_far", "That NPC is on another map.")
                } else {
                    ("npc_too_far", "该 NPC 不在当前地图。")
                };
                self.send_reject(&id, code, message, Some(&request_id));
                return;
            }
            if !self.quest_npc_visible(&id, npc) {
                self.end_conversation(&id);
                let (code, message) = if lang == crate::quest_text::LANG_EN {
                    (
                        "npc_unavailable",
                        "That NPC cannot help you at this quest stage.",
                    )
                } else {
                    ("npc_unavailable", "该 NPC 当前无法与你对话。")
                };
                self.send_reject(&id, code, message, Some(&request_id));
                return;
            }
            (
                npc.template_id.clone(),
                npc.state.x,
                npc.state.y,
                npc.state.name.clone(),
                npc.state.name_zh.clone(),
            )
        };
        let (template_id, nx, ny, name, name_zh) = npc_view;
        let mage_entry = is_mage_advance_npc(&map_id, &npc_id, &template_id);
        // The 选择岔道 magician instructor deliberately has no talk range: the
        // player opens Hans from the map shortcut, so a distance rule would
        // only reject a request the client intentionally offers.  Every other
        // npc keeps the shared talk range below.
        if !mage_entry
            && ((px - nx).abs() > npc::TALK_RANGE_X || (py - ny).abs() > npc::TALK_RANGE_Y)
        {
            self.end_conversation(&id);
            let (code, message) = if lang == crate::quest_text::LANG_EN {
                ("npc_too_far", "Please stand closer to the NPC to talk.")
            } else {
                ("npc_too_far", "请靠近 NPC 后再与其对话。")
            };
            self.send_reject(&id, code, message, Some(&request_id));
            return;
        }
        let Some(template) = self
            .gameplay
            .npcs
            .iter()
            .find(|template| template.template_id == template_id)
            .cloned()
        else {
            let (code, message) = if lang == crate::quest_text::LANG_EN {
                ("npc_unknown", "NPC data is missing.")
            } else {
                ("npc_unknown", "该 NPC 资料缺失，暂时无法对话。")
            };
            self.send_reject(&id, code, message, Some(&request_id));
            return;
        };
        // A warehouse keeper has no authored dialogue script: talking to one
        // *is* the "open my storage" action in the original.  Answering with
        // the shared `openStorage` marker keeps the same one-marker pattern as
        // `openSkills`, so the client opens the window without a bespoke
        // conversation tree per keeper.
        if template.func.contains(STORAGE_KEEPER_FUNC) {
            self.end_conversation(&id);
            if !can_advance {
                self.send_reject(&id, "dead", "死亡角色不能使用仓库。", Some(&request_id));
                return;
            }
            let mut value =
                npc::DialogueView::End.to_json(&request_id, &npc_id, &name, name_zh.as_deref());
            value["openStorage"] = serde_json::Value::Bool(true);
            self.send_npc_dialogue(&id, value);
            return;
        }
        if self.handle_quest_npc_menu(
            &id,
            &request_id,
            &npc_id,
            &template_id,
            &name,
            name_zh.as_deref(),
            lang,
            step,
            selection,
        ) {
            return;
        }
        let opening = step.is_none_or(|step| step == "start");
        if mage_entry && opening {
            match job {
                MAGICIAN_JOB | ICE_MAGE_JOB | 221 | 222 => {
                    if !can_advance {
                        self.end_conversation(&id);
                        self.send_reject(
                            &id,
                            "job_advance_unavailable",
                            "死亡角色不能使用法师训练。",
                            Some(&request_id),
                        );
                        return;
                    }
                    // The training conversation is only an offer.  Its
                    // one-time compatibility grant is committed after the
                    // player selects a supported action below, so merely
                    // opening Hans cannot mutate a live character.
                    let text = if lang == crate::quest_text::LANG_EN {
                        "Choose a Magician training action."
                    } else {
                        "请选择法师训练操作。"
                    };
                    if let Some(npc) = self.npcs.get_mut(&npc_id) {
                        npc.conversation
                            .insert(id.clone(), MAGE_TRAINING_NODE.to_owned());
                    }
                    let mut options = vec![
                        (
                            0,
                            if lang == crate::quest_text::LANG_EN {
                                "Open Magician skills"
                            } else {
                                "打开法师技能"
                            }
                            .to_owned(),
                        ),
                        (
                            1,
                            if lang == crate::quest_text::LANG_EN {
                                "Restore MP"
                            } else {
                                "恢复魔力"
                            }
                            .to_owned(),
                        ),
                    ];
                    if job == MAGICIAN_JOB && level >= 30 {
                        options.push((
                            2,
                            if lang == crate::quest_text::LANG_EN {
                                "Advance to Ice/Lightning Magician"
                            } else {
                                "转职为冰雷法师"
                            }
                            .to_owned(),
                        ));
                    }
                    if job == ICE_MAGE_JOB
                        && level >= 60
                        && self.mage_skills.get(SKILL_ICE_STORM).is_some()
                    {
                        options.push((
                            3,
                            if lang == crate::quest_text::LANG_EN {
                                "Advance to Ice/Lightning Arch Magician"
                            } else {
                                "转职为冰雷大魔导士"
                            }
                            .to_owned(),
                        ));
                    }
                    let mut value = npc::DialogueView::Say {
                        text: text.to_owned(),
                        kind: "simple".to_owned(),
                        options,
                    }
                    .to_json(&request_id, &npc_id, &name, name_zh.as_deref());
                    value["openSkills"] = serde_json::Value::Bool(false);
                    self.send_npc_dialogue(&id, value);
                    return;
                }
                BEGINNER_JOB if can_advance => {}
                BEGINNER_JOB => {
                    self.end_conversation(&id);
                    self.send_reject(
                        &id,
                        "job_advance_unavailable",
                        "死亡角色不能转职。",
                        Some(&request_id),
                    );
                    return;
                }
                _ => {
                    self.end_conversation(&id);
                    self.send_reject(
                        &id,
                        "job_advance_unavailable",
                        "只有新手可以在汉斯处转职为法师。",
                        Some(&request_id),
                    );
                    return;
                }
            }
        }
        let current_node = self
            .npcs
            .get(&npc_id)
            .and_then(|npc| npc.conversation.get(&id).cloned());
        if mage_entry && current_node.as_deref() == Some(MAGE_TRAINING_NODE) {
            if !can_advance {
                self.end_conversation(&id);
                self.send_reject(
                    &id,
                    "job_advance_unavailable",
                    "死亡角色不能使用法师训练。",
                    Some(&request_id),
                );
                return;
            }
            match (step, selection) {
                (Some("select"), Some(0)) => {
                    if job == MAGICIAN_JOB {
                        if let Err(error) = self.ensure_mage_support(&id) {
                            self.end_conversation(&id);
                            self.send_reject(&id, "persistence", &error, Some(&request_id));
                            return;
                        }
                    }
                    let mut value = npc::DialogueView::End.to_json(
                        &request_id,
                        &npc_id,
                        &name,
                        name_zh.as_deref(),
                    );
                    value["openSkills"] = serde_json::Value::Bool(true);
                    self.end_conversation(&id);
                    self.send_npc_dialogue(&id, value);
                }
                (Some("select"), Some(1)) => {
                    if job == MAGICIAN_JOB {
                        if let Err(error) = self.ensure_mage_support(&id) {
                            self.end_conversation(&id);
                            self.send_reject(&id, "persistence", &error, Some(&request_id));
                            return;
                        }
                    }
                    let old_mp = self
                        .players
                        .get(&id)
                        .map(|player| player.state.mp)
                        .unwrap_or(0);
                    let mut new_mp = old_mp;
                    let mut max_mp = 0;
                    if let Some(player) = self.players.get_mut(&id) {
                        refresh_player_derived(&self.gameplay, &self.mage_skills, player);
                        max_mp = player.state.max_mp;
                        new_mp = max_mp;
                        player.state.mp = max_mp;
                    }
                    if let Some(store) = self.store.as_ref() {
                        let persisted = self.players.get(&id).map(|player| {
                            profile_from_state(
                                &player.state,
                                &player.map_id,
                                &player.death_id,
                                player.base_max_mp,
                            )
                        });
                        if let Some(profile) = persisted {
                            if let Err(error) = store.save_profile(&id, &profile) {
                                if let Some(player) = self.players.get_mut(&id) {
                                    player.state.mp = old_mp;
                                }
                                self.send_reject(&id, "persistence", &error, Some(&request_id));
                                return;
                            }
                        }
                    }
                    let mut value = npc::DialogueView::End.to_json(
                        &request_id,
                        &npc_id,
                        &name,
                        name_zh.as_deref(),
                    );
                    value["trainingResult"] = serde_json::json!({
                        "kind": "restoreMp",
                        "mp": new_mp,
                        "maxMp": max_mp,
                        "temporary": true,
                    });
                    self.end_conversation(&id);
                    self.send_npc_dialogue(&id, value);
                }
                (Some("select"), Some(2)) if job == MAGICIAN_JOB && level >= 30 => {
                    match self.apply_job_advance(
                        &id,
                        &map_id,
                        &npc_id,
                        &template_id,
                        MAGICIAN_JOB,
                        ICE_MAGE_JOB,
                    ) {
                        Ok(true) => {
                            let mut value = npc::DialogueView::End.to_json(
                                &request_id,
                                &npc_id,
                                &name,
                                name_zh.as_deref(),
                            );
                            value["openSkills"] = serde_json::Value::Bool(true);
                            value["trainingResult"] = serde_json::json!({
                                "kind": "jobAdvance",
                                "job": ICE_MAGE_JOB,
                            });
                            self.end_conversation(&id);
                            self.send_npc_dialogue(&id, value);
                        }
                        Ok(false) => {
                            self.end_conversation(&id);
                            self.send_reject(
                                &id,
                                "job_advance_unavailable",
                                "冰雷转职条件不满足。",
                                Some(&request_id),
                            );
                        }
                        Err(error) => {
                            self.end_conversation(&id);
                            self.send_reject(&id, "persistence", &error, Some(&request_id));
                        }
                    }
                }
                (Some("select"), Some(3))
                    if job == ICE_MAGE_JOB
                        && level >= 60
                        && self.mage_skills.get(SKILL_ICE_STORM).is_some() =>
                {
                    match self.apply_job_advance(
                        &id,
                        &map_id,
                        &npc_id,
                        &template_id,
                        ICE_MAGE_JOB,
                        ICE_THIRD_JOB,
                    ) {
                        Ok(true) => {
                            let mut value = npc::DialogueView::End.to_json(
                                &request_id,
                                &npc_id,
                                &name,
                                name_zh.as_deref(),
                            );
                            value["openSkills"] = serde_json::Value::Bool(true);
                            value["trainingResult"] = serde_json::json!({
                                "kind": "jobAdvance",
                                "job": ICE_THIRD_JOB,
                            });
                            self.end_conversation(&id);
                            self.send_npc_dialogue(&id, value);
                        }
                        Ok(false) => {
                            self.end_conversation(&id);
                            self.send_reject(
                                &id,
                                "job_advance_unavailable",
                                "冰雷三转条件不满足。",
                                Some(&request_id),
                            );
                        }
                        Err(error) => {
                            self.end_conversation(&id);
                            self.send_reject(&id, "persistence", &error, Some(&request_id));
                        }
                    }
                }
                (Some("end"), _) => {
                    self.end_conversation(&id);
                    self.send_npc_dialogue(
                        &id,
                        npc::DialogueView::End.to_json(
                            &request_id,
                            &npc_id,
                            &name,
                            name_zh.as_deref(),
                        ),
                    );
                }
                _ => {
                    self.end_conversation(&id);
                    let (code, message) = if lang == crate::quest_text::LANG_EN {
                        (
                            "npc_step_invalid",
                            "This conversation option is no longer available.",
                        )
                    } else {
                        ("npc_step_invalid", "该对话选项已失效，请重新与 NPC 交谈。")
                    };
                    self.send_reject(&id, code, message, Some(&request_id));
                }
            }
            return;
        }
        let Some(script) = template.script.clone() else {
            self.send_npc_dialogue(
                &id,
                npc::DialogueView::End.to_json(&request_id, &npc_id, &name, name_zh.as_deref()),
            );
            self.end_conversation(&id);
            return;
        };
        let current_node = self
            .npcs
            .get(&npc_id)
            .and_then(|npc| npc.conversation.get(&id).cloned());
        if current_node.as_deref() == Some(ALREADY_MAGICIAN_NODE) {
            if step == Some("end") {
                self.end_conversation(&id);
                self.send_npc_dialogue(
                    &id,
                    npc::DialogueView::End.to_json(&request_id, &npc_id, &name, name_zh.as_deref()),
                );
            } else {
                self.end_conversation(&id);
                let (code, message) = if lang == crate::quest_text::LANG_EN {
                    (
                        "npc_step_invalid",
                        "This conversation option is no longer available.",
                    )
                } else {
                    ("npc_step_invalid", "该对话选项已失效，请重新与 NPC 交谈。")
                };
                self.send_reject(&id, code, message, Some(&request_id));
            }
            return;
        }
        let quests = self
            .players
            .get(&id)
            .map(|player| player.quests.clone())
            .unwrap_or_default();
        let hp = self
            .players
            .get(&id)
            .map(|player| u32::try_from(player.state.hp.max(0)).unwrap_or(0))
            .unwrap_or(0);
        let context = DialogueContext {
            hp,
            level,
            mesos,
            inventory: &inventory,
            quests: &quests,
            lang,
        };
        match npc::advance(&script, current_node.as_deref(), step, selection, &context) {
            Ok((next_node, view, effect)) => {
                let mut quest_effect = None;
                let mut job_advanced = false;
                if let Some(effect) = effect {
                    match effect {
                        npc::QuestEffect::JobAdvance { from_job, job } => {
                            match self.apply_job_advance(
                                &id,
                                &map_id,
                                &npc_id,
                                &template_id,
                                from_job,
                                job,
                            ) {
                                Ok(true) => job_advanced = true,
                                Ok(false) => {
                                    self.end_conversation(&id);
                                    self.send_reject(
                                        &id,
                                        "job_advance_unavailable",
                                        "只有新手可以在汉斯处转职为法师。",
                                        Some(&request_id),
                                    );
                                    return;
                                }
                                Err(error) => {
                                    self.end_conversation(&id);
                                    self.send_reject(&id, "persistence", &error, Some(&request_id));
                                    return;
                                }
                            }
                        }
                        effect => quest_effect = Some(effect),
                    }
                }
                let mut value = view.to_json(&request_id, &npc_id, &name, name_zh.as_deref());
                if job_advanced {
                    value["openSkills"] = serde_json::Value::Bool(true);
                }
                if let Some(npc) = self.npcs.get_mut(&npc_id) {
                    if let npc::DialogueView::End = &view {
                        npc.conversation.remove(&id);
                    } else {
                        npc.conversation.insert(id.clone(), next_node);
                    }
                }
                // Warp immediately when the dialogue resolves to one.
                if let npc::DialogueView::Warp { map_id: warp_to } = &view {
                    let target = warp_to.clone();
                    if !self.warp_player(&id, target) {
                        self.end_conversation(&id);
                        self.send_reject(
                            &id,
                            "persistence",
                            "傳送未能保存，請稍後重試。",
                            Some(&request_id),
                        );
                        return;
                    }
                }
                self.send_npc_dialogue(&id, value);
                // Apply the one-shot quest effect after the client has been
                // told the conversation ended.
                if let Some(effect) = quest_effect {
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
        for npc in self.npcs.values_mut() {
            npc.conversation.remove(player_id);
        }
        // Closing the conversation also closes the warehouse window: the two
        // are the same interaction with the same npc, so a player who walks
        // away must not keep a live storage session behind.
        self.close_storage(player_id);
    }

    fn apply_job_advance(
        &mut self,
        id: &str,
        map_id: &str,
        npc_id: &str,
        template_id: &str,
        from_job: u32,
        job: u32,
    ) -> Result<bool, String> {
        let first_transfer = from_job == BEGINNER_JOB && job == MAGICIAN_JOB;
        let second_transfer = from_job == MAGICIAN_JOB && job == ICE_MAGE_JOB;
        let third_transfer = from_job == ICE_MAGE_JOB && job == ICE_THIRD_JOB;
        if !is_mage_advance_npc(map_id, npc_id, template_id)
            || (!first_transfer && !second_transfer && !third_transfer)
        {
            return Ok(false);
        }
        let Some(player) = self.players.get(id) else {
            return Ok(false);
        };
        if player.state.job != from_job
            || player.state.hp <= 0
            || player.state.action == "dead"
            || (second_transfer && player.state.level < 30)
            || (third_transfer
                && (player.state.level < 60 || self.mage_skills.get(SKILL_ICE_STORM).is_none()))
        {
            return Ok(false);
        }
        if let Some(store) = self.store.as_ref() {
            if !store.advance_job(id, from_job, job)? {
                return Ok(false);
            }
        }
        let loaded_profile = if self.store.is_some() {
            let defaults = self.default_profile();
            Some(
                self.store
                    .as_ref()
                    .ok_or_else(|| "account store unavailable".to_owned())?
                    .load_profile(id, &defaults)?,
            )
        } else {
            None
        };
        if let Some(player) = self.players.get_mut(id) {
            player.state.job = job;
            if self.store.is_none() {
                if first_transfer {
                    player.base_max_mp = player.base_max_mp.max(MAGE_TRANSFER_MIN_MP);
                    player.state.skill_points.entry(MAGE_BOOK).or_insert(5);
                    player
                        .state
                        .skills
                        .entry(SKILL_ELEMENTAL_WEAKEN)
                        .or_insert(1);
                    player
                        .state
                        .skills
                        .entry(SKILL_MAGIC_WAVE_HIDDEN)
                        .or_insert(1);
                    player.state.max_mp = player.base_max_mp;
                    player.state.mp = player.state.max_mp;
                } else if second_transfer {
                    player.state.skill_points.entry(ICE_BOOK).or_insert(5);
                    player.state.skills.entry(SKILL_ICE_EFFECT).or_insert(1);
                }
                if third_transfer {
                    player.state.skill_points.entry(THIRD_BOOK).or_insert(5);
                }
                refresh_player_derived(&self.gameplay, &self.mage_skills, player);
            } else {
                if let Some(profile) = loaded_profile {
                    player.base_max_mp = profile.max_mp.max(0);
                    apply_profile_to_player(&self.gameplay, &self.mage_skills, player, profile);
                }
            }
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Hans' one-time compatibility grant for rows that were already job 200
    /// before the first-job runtime existed.  The Store transaction owns the
    /// idempotence bit; the no-Store world mirrors the same or-insert behavior
    /// for unit tests without inventing a second reset path.
    fn ensure_mage_support(&mut self, id: &str) -> Result<bool, String> {
        let Some(player) = self.players.get(id) else {
            return Ok(false);
        };
        if player.state.job != MAGICIAN_JOB {
            return Ok(false);
        }
        if let Some(store) = self.store.as_ref() {
            let granted = store.ensure_mage_support(id)?;
            if granted {
                let profile = store.load_profile(id, &self.default_profile())?;
                if let Some(player) = self.players.get_mut(id) {
                    apply_profile_to_player(&self.gameplay, &self.mage_skills, player, profile);
                }
            }
            Ok(granted)
        } else {
            let Some(player) = self.players.get_mut(id) else {
                return Ok(false);
            };
            let changed = player.state.skill_points.get(&MAGE_BOOK).is_none()
                || !player.state.skills.contains_key(&SKILL_ELEMENTAL_WEAKEN)
                || !player.state.skills.contains_key(&SKILL_MAGIC_WAVE_HIDDEN)
                || player.base_max_mp < MAGE_TRANSFER_MIN_MP;
            if changed {
                player.base_max_mp = player.base_max_mp.max(MAGE_TRANSFER_MIN_MP);
                player.state.skill_points.entry(MAGE_BOOK).or_insert(5);
                player
                    .state
                    .skills
                    .entry(SKILL_ELEMENTAL_WEAKEN)
                    .or_insert(1);
                player
                    .state
                    .skills
                    .entry(SKILL_MAGIC_WAVE_HIDDEN)
                    .or_insert(1);
                refresh_player_derived(&self.gameplay, &self.mage_skills, player);
            }
            Ok(changed)
        }
    }

    fn quest_item_count(inventory: &[crate::protocol::InventoryItem], item_id: &str) -> u32 {
        inventory
            .iter()
            .filter(|item| item.item_id == item_id)
            .fold(0_u32, |total, item| total.saturating_add(item.quantity))
    }

    fn quest_equipped_item_count(
        equipped: &[crate::protocol::InventoryItem],
        item_id: &str,
    ) -> u32 {
        equipped
            .iter()
            .filter(|item| item.item_id == item_id)
            .fold(0_u32, |total, item| {
                total.saturating_add(item.quantity.max(1))
            })
    }

    fn quest_jobs_match(conditions: &QuestConditions, job: u32) -> bool {
        conditions.job.is_empty() || conditions.job.contains(&job)
    }

    fn quest_prerequisites_match(
        player: &Player,
        prerequisites: &[QuestPrerequisite],
        or_option: bool,
    ) -> bool {
        // Source Check.QuestOrOption == 1 makes the quest list an OR: the phase
        // requires any one satisfied prerequisite (route checkpoints are
        // mutually exclusive), not every one.
        let mut satisfied = prerequisites.iter().map(|requirement| {
            let expected = requirement.status.as_deref().unwrap_or("completed");
            player
                .quests
                .get(&requirement.quest_id)
                .is_some_and(|status| status == expected)
        });
        if or_option {
            satisfied.any(|matched| matched)
        } else {
            satisfied.all(|matched| matched)
        }
    }

    fn quest_conditions_match(player: &Player, conditions: &QuestConditions) -> bool {
        (conditions.level_at_least == 0 || player.state.level >= conditions.level_at_least)
            && Self::quest_jobs_match(conditions, player.state.job)
            && Self::quest_prerequisites_match(
                player,
                &conditions.quests,
                conditions.quest_or_option,
            )
            && conditions.items.iter().all(|requirement| {
                !requirement.item_id.is_empty()
                    && requirement.quantity > 0
                    && Self::quest_item_count(&player.state.inventory, &requirement.item_id)
                        >= requirement.quantity
            })
            && conditions.equipped_items.iter().all(|item_id| {
                !item_id.is_empty()
                    && Self::quest_equipped_item_count(&player.state.equipped, item_id) > 0
            })
    }

    fn quest_phase_matches_npc(phase: &QuestPhase, template_id: &str) -> bool {
        phase
            .npc_id
            .as_deref()
            .is_some_and(|npc_id| npc_id == template_id)
    }

    fn quest_complete_items(spec: &QuestSpec) -> Vec<QuestItemRequirement> {
        spec.complete.conditions.items.clone()
    }

    fn quest_consume_items(spec: &QuestSpec) -> Vec<QuestItemRequirement> {
        match &spec.complete.consume_items {
            serde_json::Value::Array(items) => {
                serde_json::from_value(serde_json::Value::Array(items.clone()))
                    .unwrap_or_else(|_| Self::quest_complete_items(spec))
            }
            serde_json::Value::Bool(false) => Vec::new(),
            _ => Self::quest_complete_items(spec),
        }
    }

    fn quest_objective_text(
        &self,
        value: &serde_json::Value,
        lang: &'static str,
    ) -> Option<String> {
        if let Some(text) = value.as_str().filter(|text| !text.is_empty()) {
            return Some(text.to_owned());
        }
        value
            .as_object()
            .and_then(|object| {
                object
                    .get(lang)
                    .or_else(|| object.get(crate::quest_text::LANG_ZH))
                    .or_else(|| object.get(crate::quest_text::LANG_EN))
            })
            .and_then(serde_json::Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    }

    fn quest_objective_rows(
        &self,
        spec: &QuestSpec,
        player: &Player,
        lang: &'static str,
    ) -> Vec<serde_json::Value> {
        let fallback = self.quest_summary(spec, "active", lang);
        if spec.objectives.is_empty() {
            return Self::quest_complete_items(spec)
                .into_iter()
                .map(|requirement| {
                    let current =
                        Self::quest_item_count(&player.state.inventory, &requirement.item_id);
                    serde_json::json!({
                        "text": fallback,
                        "current": current,
                        "required": requirement.quantity,
                    })
                })
                .collect();
        }
        spec.objectives
            .iter()
            .map(|objective| {
                let current = self.quest_objective_count(objective, player);
                let text = self
                    .quest_objective_text(&objective.text, lang)
                    .unwrap_or_else(|| fallback.clone());
                serde_json::json!({
                    "text": text,
                    "current": current,
                    "required": objective.required,
                })
            })
            .collect()
    }

    fn quest_objective_count(&self, objective: &QuestObjective, player: &Player) -> u32 {
        if objective.item_id.is_empty() {
            return 0;
        }
        if objective._kind == "equip" {
            Self::quest_equipped_item_count(&player.state.equipped, &objective.item_id)
        } else {
            Self::quest_item_count(&player.state.inventory, &objective.item_id)
        }
    }

    fn quest_objectives_complete(&self, spec: &QuestSpec, player: &Player) -> bool {
        let objectives_ok = spec.objectives.iter().all(|objective| {
            objective.required > 0
                && !objective.item_id.is_empty()
                && self.quest_objective_count(objective, player) >= objective.required
        });
        let complete_items_ok = Self::quest_complete_items(spec).iter().all(|requirement| {
            requirement.quantity > 0
                && !requirement.item_id.is_empty()
                && Self::quest_item_count(&player.state.inventory, &requirement.item_id)
                    >= requirement.quantity
        });
        objectives_ok && complete_items_ok
    }

    fn quest_status_for<'a>(player: &'a Player, quest_id: &str) -> Option<&'a str> {
        player.quests.get(quest_id).map(String::as_str)
    }

    fn quest_summary(&self, spec: &QuestSpec, status: &str, lang: &'static str) -> String {
        if lang == crate::quest_text::LANG_ZH {
            let phase = match status {
                "available" => "available",
                "active" | "objectivesComplete" => "active",
                "completed" => "completed",
                _ => "active",
            };
            if let Some(summary) = spec.summaries.get(phase).filter(|text| !text.is_empty()) {
                return summary.clone();
            }
        }
        self.quest_text.summary(&spec.quest_id, lang)
    }

    fn quest_map_label(&self, map_id: &str) -> String {
        match map_id {
            "000010000" => "楓葉山丘".to_owned(),
            "001020000" => "選擇岔道".to_owned(),
            "002000000" => "楓之港".to_owned(),
            "002000100" => "碼頭".to_owned(),
            "104000000" => "維多利亞港".to_owned(),
            "100000201" => "弓箭手培訓中心".to_owned(),
            "130000000" => "耶雷弗".to_owned(),
            "310050000" => "發電廠大廳".to_owned(),
            _ => map_id.to_owned(),
        }
    }

    fn quest_npc_map(&self, template_id: Option<&str>) -> Option<String> {
        let template_id = template_id?;
        self.npcs
            .values()
            .find(|npc| {
                npc.template_id == template_id
                    && (template_id != QUEST_OLIVIA_NPC || npc.map_id == "130000000")
            })
            .map(|npc| npc.map_id.clone())
    }

    fn quest_npc_label(&self, template_id: Option<&str>) -> String {
        let Some(template_id) = template_id else {
            return "任務目標".to_owned();
        };
        self.npc_names_zh
            .get(template_id)
            .cloned()
            .or_else(|| {
                self.gameplay
                    .npcs
                    .iter()
                    .find(|npc| npc.template_id == template_id)
                    .map(|npc| npc.name.clone())
            })
            .unwrap_or_else(|| template_id.to_owned())
    }

    fn quest_menu_choices(&self, id: &str, template_id: &str) -> Vec<(String, String)> {
        let Some(player) = self.players.get(id) else {
            return Vec::new();
        };
        let mut choices = Vec::new();
        for spec in self.gameplay.quests.iter().filter(|spec| spec.executable()) {
            let status = Self::quest_status_for(player, &spec.quest_id);
            match status {
                None => {
                    if Self::quest_phase_matches_npc(&spec.start, template_id)
                        && Self::quest_conditions_match(player, &spec.start.conditions)
                    {
                        choices.push((spec.quest_id.clone(), "start".to_owned()));
                    }
                }
                Some("active") => {
                    // A phase warp is also a resumable route while the quest is
                    // active.  The same tuple is re-derived on selection, so a
                    // stale menu cannot move a player after the quest changes.
                    if Self::quest_phase_matches_npc(&spec.start, template_id)
                        && spec
                            .start
                            .warp_map_id
                            .as_ref()
                            .is_some_and(|map_id| self.maps.contains_key(map_id))
                    {
                        choices.push((spec.quest_id.clone(), "route_start".to_owned()));
                    }
                    if Self::quest_phase_matches_npc(&spec.complete, template_id) {
                        if Self::quest_conditions_match(player, &spec.complete.conditions)
                            && self.quest_objectives_complete(spec, player)
                        {
                            choices.push((spec.quest_id.clone(), "complete".to_owned()));
                        } else {
                            choices.push((spec.quest_id.clone(), "pending".to_owned()));
                        }
                    }
                }
                Some("completed") => {
                    if Self::quest_phase_matches_npc(&spec.start, template_id)
                        && spec
                            .start
                            .warp_map_id
                            .as_ref()
                            .is_some_and(|map_id| self.maps.contains_key(map_id))
                    {
                        choices.push((spec.quest_id.clone(), "route_start".to_owned()));
                    }
                    if Self::quest_phase_matches_npc(&spec.complete, template_id) {
                        if spec
                            .complete
                            .warp_map_id
                            .as_ref()
                            .is_some_and(|map_id| self.maps.contains_key(map_id))
                        {
                            choices.push((spec.quest_id.clone(), "route_complete".to_owned()));
                        }
                        if spec
                            .return_map_id
                            .as_ref()
                            .is_some_and(|map_id| self.maps.contains_key(map_id))
                        {
                            choices.push((spec.quest_id.clone(), "return".to_owned()));
                        }
                    }
                }
                _ => {}
            }
        }
        choices
    }

    fn quest_route_map_id<'a>(spec: &'a QuestSpec, action: &str) -> Option<&'a str> {
        match action {
            "route_start" => spec.start.warp_map_id.as_deref(),
            "route_complete" => spec.complete.warp_map_id.as_deref(),
            "return" => spec.return_map_id.as_deref(),
            _ => None,
        }
    }

    fn quest_route_target(
        &self,
        id: &str,
        quest_id: &str,
        template_id: &str,
        action: &str,
    ) -> Option<(String, Option<String>)> {
        let player = self.players.get(id)?;
        let spec = self
            .gameplay
            .quests
            .iter()
            .find(|spec| spec.quest_id == quest_id)?;
        let status = Self::quest_status_for(player, quest_id);
        let phase = match action {
            "route_start" if matches!(status, Some("active") | Some("completed")) => &spec.start,
            "route_complete" | "return" if status == Some("completed") => &spec.complete,
            _ => return None,
        };
        let recheck_active_start = action == "route_start" && status == Some("active");
        if !Self::quest_phase_matches_npc(phase, template_id)
            || (recheck_active_start && !Self::quest_conditions_match(player, &phase.conditions))
        {
            return None;
        }
        let map_id = Self::quest_route_map_id(spec, action)?;
        self.maps.contains_key(map_id).then(|| {
            (
                map_id.to_owned(),
                match action {
                    "route_start" => spec.start.warp_portal_name.clone(),
                    "route_complete" => spec.complete.warp_portal_name.clone(),
                    _ => None,
                },
            )
        })
    }

    fn quest_npc_visible(&self, id: &str, npc: &NpcInstance) -> bool {
        let Some(player) = self.players.get(id) else {
            return !matches!(
                npc.template_id.as_str(),
                QUEST_HIDDEN_NPC_1 | QUEST_HIDDEN_NPC_2 | QUEST_HIDDEN_NPC_3 | QUEST_OLIVIA_NPC
            );
        };
        match npc.template_id.as_str() {
            QUEST_HIDDEN_NPC_1 => {
                !matches!(Self::quest_status_for(player, "36301"), Some("completed"))
            }
            QUEST_HIDDEN_NPC_2 => {
                Self::quest_status_for(player, "36301") == Some("completed")
                    && !matches!(Self::quest_status_for(player, "36304"), Some("completed"))
            }
            QUEST_HIDDEN_NPC_3 => Self::quest_status_for(player, "36306") == Some("completed"),
            QUEST_OLIVIA_NPC => {
                npc.map_id == "130000000"
                    && Self::quest_status_for(player, "36309") == Some("active")
            }
            _ => true,
        }
    }

    fn quest_interactions_for(&self, id: &str, map_id: &str) -> Vec<serde_json::Value> {
        let Some(player) = self.players.get(id) else {
            return Vec::new();
        };
        if player.state.hp <= 0 || player.state.action == "dead" {
            return Vec::new();
        }
        self.gameplay
            .quests
            .iter()
            .filter(|spec| spec.executable())
            .filter_map(|spec| {
                let interaction = spec.interaction.as_ref()?;
                if Self::quest_status_for(player, &spec.quest_id) != Some("active")
                    || interaction.map_id != map_id
                    || interaction.item_id.is_empty()
                    || interaction.quantity == 0
                    || Self::quest_item_count(&player.state.inventory, &interaction.item_id)
                        >= interaction.quantity
                {
                    return None;
                }
                let range = if interaction.range > 0.0 {
                    interaction.range
                } else {
                    64.0
                };
                let label = self
                    .quest_objective_text(&interaction.label, player.lang)
                    .unwrap_or_else(|| self.quest_text.summary(&spec.quest_id, player.lang));
                Some(serde_json::json!({
                    "questId": spec.quest_id,
                    "mapId": interaction.map_id,
                    "mapLayerKey": interaction.map_layer_key,
                    "x": interaction.x,
                    "y": interaction.y,
                    "range": range,
                    "label": label,
                }))
            })
            .collect()
    }

    fn quest_entry(
        &self,
        id: &str,
        spec: &QuestSpec,
        persisted: Option<&str>,
    ) -> Option<serde_json::Value> {
        let player = self.players.get(id)?;
        let status = match persisted {
            Some("completed") => "completed",
            Some("active") if self.quest_objectives_complete(spec, player) => "objectivesComplete",
            Some("active") => "active",
            Some(_) => return None,
            None if spec.executable()
                && Self::quest_conditions_match(player, &spec.start.conditions) =>
            {
                "available"
            }
            None => return None,
        };
        let objective_rows = self.quest_objective_rows(spec, player, player.lang);
        let (target_map_id, target_npc_id, next_action) = match status {
            "available" => (
                self.quest_npc_map(spec.start.npc_id.as_deref()),
                spec.start.npc_id.clone(),
                spec.start.npc_id.as_deref().and_then(|npc_id| {
                    self.quest_npc_map(Some(npc_id)).map(|map_id| {
                        format!(
                            "前往{}，與{}交談接取任務",
                            self.quest_map_label(&map_id),
                            self.quest_npc_label(Some(npc_id))
                        )
                    })
                }),
            ),
            "active" => {
                let interaction = spec.interaction.as_ref();
                let target_map_id = interaction
                    .map(|interaction| interaction.map_id.clone())
                    .or_else(|| self.quest_npc_map(spec.complete.npc_id.as_deref()));
                let target_npc_id = if interaction.is_some() {
                    None
                } else {
                    spec.complete.npc_id.clone()
                };
                let next_action = if let Some(interaction) = interaction {
                    let label = self
                        .quest_objective_text(&interaction.label, player.lang)
                        .unwrap_or_else(|| self.quest_summary(spec, "active", player.lang));
                    Some(format!(
                        "前往{}，点击{}",
                        self.quest_map_label(&interaction.map_id),
                        label
                    ))
                } else {
                    spec.complete.npc_id.as_deref().and_then(|npc_id| {
                        self.quest_npc_map(Some(npc_id)).map(|map_id| {
                            let delivery = format!(
                                "前往{}，與{}交談交付任務",
                                self.quest_map_label(&map_id),
                                self.quest_npc_label(Some(npc_id))
                            );
                            let has_equipment_goal = spec
                                .objectives
                                .iter()
                                .any(|objective| objective._kind == "equip");
                            let has_collect_goal = !Self::quest_complete_items(spec).is_empty()
                                || spec
                                    .objectives
                                    .iter()
                                    .any(|objective| objective._kind != "equip");
                            if has_equipment_goal && !has_collect_goal {
                                format!("先完成裝備目標；完成後{}", delivery)
                            } else if has_collect_goal {
                                format!("先收集任務目標；完成後{}", delivery)
                            } else {
                                delivery
                            }
                        })
                    })
                };
                (target_map_id, target_npc_id, next_action)
            }
            "objectivesComplete" => (
                self.quest_npc_map(spec.complete.npc_id.as_deref()),
                spec.complete.npc_id.clone(),
                spec.complete.npc_id.as_deref().and_then(|npc_id| {
                    self.quest_npc_map(Some(npc_id)).map(|map_id| {
                        format!(
                            "前往{}，與{}交談交付任務",
                            self.quest_map_label(&map_id),
                            self.quest_npc_label(Some(npc_id))
                        )
                    })
                }),
            ),
            "completed" => (
                spec.return_map_id.clone(),
                None,
                spec.return_map_id
                    .as_deref()
                    .map(|map_id| format!("返回{}", self.quest_map_label(map_id))),
            ),
            _ => (None, None, None),
        };
        let mut entry = serde_json::json!({
            "questId": spec.quest_id,
            "name": self.quest_text.name(&spec.quest_id, player.lang),
            "status": status,
            "summary": self.quest_summary(spec, status, player.lang),
        });
        if !objective_rows.is_empty() {
            entry["objectives"] = serde_json::Value::Array(objective_rows);
        }
        if let Some(target_map_id) = target_map_id.filter(|value| !value.is_empty()) {
            entry["targetMapId"] = target_map_id.into();
        }
        if let Some(target_npc_id) = target_npc_id.filter(|value| !value.is_empty()) {
            entry["targetNpcId"] = target_npc_id.into();
        }
        if let Some(next_action) = next_action {
            entry["nextAction"] = next_action.into();
        }
        Some(entry)
    }

    fn quest_log_entries(&self, id: &str) -> Vec<serde_json::Value> {
        let Some(player) = self.players.get(id) else {
            return Vec::new();
        };
        let mut entries = Vec::new();
        let catalog_ids: BTreeSet<&str> = self
            .gameplay
            .quests
            .iter()
            .map(|spec| spec.quest_id.as_str())
            .collect();
        for spec in &self.gameplay.quests {
            if let Some(entry) = self.quest_entry(
                id,
                spec,
                player.quests.get(&spec.quest_id).map(String::as_str),
            ) {
                entries.push(entry);
            }
        }
        // Preserve old save rows even when their content definition is no
        // longer present in the current catalog. They remain display-only;
        // execution still requires an executable catalog entry.
        for (quest_id, status) in &player.quests {
            if !catalog_ids.contains(quest_id.as_str()) {
                entries.push(serde_json::json!({
                    "questId": quest_id,
                    "name": self.quest_text.name(quest_id, player.lang),
                    "status": status,
                    "summary": self.quest_text.summary(quest_id, player.lang),
                }));
            }
        }
        entries
    }

    fn handle_quest_npc_menu(
        &mut self,
        id: &str,
        request_id: &str,
        npc_id: &str,
        template_id: &str,
        name: &str,
        name_zh: Option<&str>,
        lang: &'static str,
        step: Option<&str>,
        selection: Option<u32>,
    ) -> bool {
        let current_node = self
            .npcs
            .get(npc_id)
            .and_then(|npc| npc.conversation.get(id).cloned());
        let opening = step.is_none_or(|value| value == "start");
        let cached_choices = current_node
            .as_deref()
            .and_then(|node| node.strip_prefix(QUEST_MENU_NODE))
            .and_then(|json| serde_json::from_str::<Vec<(String, String)>>(json).ok());
        if cached_choices.is_none() && opening {
            let choices = self.quest_menu_choices(id, template_id);
            if choices.is_empty() {
                return false;
            }
            let options = choices
                .iter()
                .enumerate()
                .map(|(index, (quest_id, action))| {
                    let name = self.quest_text.name(quest_id, lang);
                    let route_map = self
                        .gameplay
                        .quests
                        .iter()
                        .find(|spec| spec.quest_id == quest_id.as_str())
                        .and_then(|spec| Self::quest_route_map_id(spec, action))
                        .map(|map_id| self.quest_map_label(map_id));
                    let text = match action.as_str() {
                        "start" if lang == crate::quest_text::LANG_EN => format!("Accept: {name}"),
                        "complete" if lang == crate::quest_text::LANG_EN => {
                            format!("Turn in: {name}")
                        }
                        "pending" if lang == crate::quest_text::LANG_EN => format!("View: {name}"),
                        "route_start" if lang == crate::quest_text::LANG_EN => format!(
                            "Go to {}: {name}",
                            route_map.as_deref().unwrap_or("the next area")
                        ),
                        "route_complete" if lang == crate::quest_text::LANG_EN => format!(
                            "Go to {}: {name}",
                            route_map.as_deref().unwrap_or("the destination")
                        ),
                        "return" if lang == crate::quest_text::LANG_EN => format!(
                            "Return: {}",
                            route_map.as_deref().unwrap_or("the return route")
                        ),
                        "start" => format!("接取：{name}"),
                        "complete" => format!("交付：{name}"),
                        "pending" => format!("查看：{name}"),
                        "route_start" => format!(
                            "前往{}繼續：{name}",
                            route_map.as_deref().unwrap_or("下一站")
                        ),
                        "route_complete" => format!(
                            "前往{}：{name}",
                            route_map.as_deref().unwrap_or("任務目的地")
                        ),
                        "return" => format!("返回{}", route_map.as_deref().unwrap_or("選擇岔道")),
                        _ => format!("返回選擇岔道：{name}"),
                    };
                    (u32::try_from(index).unwrap_or(u32::MAX), text)
                })
                .collect();
            if let Some(npc) = self.npcs.get_mut(npc_id) {
                let encoded = serde_json::to_string(&choices).unwrap_or_else(|_| "[]".to_owned());
                npc.conversation
                    .insert(id.to_owned(), format!("{QUEST_MENU_NODE}{encoded}"));
            }
            let text = choices
                .first()
                .map(|(quest_id, _)| self.quest_text.summary(quest_id, lang))
                .unwrap_or_default();
            self.send_npc_dialogue(
                id,
                npc::DialogueView::Say {
                    text,
                    kind: "simple".to_owned(),
                    options,
                }
                .to_json(request_id, npc_id, name, name_zh),
            );
            return true;
        }
        let Some(cached_choices) = cached_choices else {
            return false;
        };
        match (step, selection) {
            (Some("select"), Some(index)) => {
                let Some((quest_id, action)) = cached_choices.get(index as usize).cloned() else {
                    self.end_conversation(id);
                    self.send_reject(
                        id,
                        "quest_step_invalid",
                        "quest option is not offered",
                        Some(request_id),
                    );
                    return true;
                };
                let still_offered = self
                    .quest_menu_choices(id, template_id)
                    .iter()
                    .any(|choice| choice == &(quest_id.clone(), action.clone()));
                if !still_offered {
                    self.end_conversation(id);
                    self.send_reject(
                        id,
                        "quest_option_unavailable",
                        "任務選項已更新，請重新開啟NPC對話。",
                        Some(request_id),
                    );
                    return true;
                }
                self.end_conversation(id);
                if matches!(action.as_str(), "route_start" | "route_complete" | "return") {
                    let Some((route_map_id, route_portal_name)) =
                        self.quest_route_target(id, &quest_id, template_id, &action)
                    else {
                        self.send_reject(
                            id,
                            "quest_return_unavailable",
                            "任務路線已更新，請重新開啟NPC對話。",
                            Some(request_id),
                        );
                        return true;
                    };
                    if !self.warp_player_at(id, route_map_id, route_portal_name.as_deref()) {
                        self.send_reject(
                            id,
                            "persistence",
                            "傳送未能保存，請稍後重試。",
                            Some(request_id),
                        );
                        return true;
                    }
                    self.send_npc_dialogue(
                        id,
                        npc::DialogueView::End.to_json(request_id, npc_id, name, name_zh),
                    );
                    return true;
                }
                if action == "pending" {
                    let text = self
                        .gameplay
                        .quests
                        .iter()
                        .find(|spec| spec.quest_id == quest_id)
                        .map(|spec| self.quest_summary(spec, "active", lang))
                        .unwrap_or_default();
                    self.send_npc_dialogue(
                        id,
                        npc::DialogueView::Say {
                            text,
                            kind: "ok".to_owned(),
                            options: Vec::new(),
                        }
                        .to_json(request_id, npc_id, name, name_zh),
                    );
                    return true;
                }
                let effect = if action == "start" {
                    npc::QuestEffect::Start(quest_id)
                } else {
                    npc::QuestEffect::Complete(quest_id)
                };
                if self.apply_quest_effect_at(id, effect, Some(template_id), Some(request_id)) {
                    self.send_npc_dialogue(
                        id,
                        npc::DialogueView::End.to_json(request_id, npc_id, name, name_zh),
                    );
                }
                true
            }
            (Some("end"), _) => {
                self.end_conversation(id);
                self.send_npc_dialogue(
                    id,
                    npc::DialogueView::End.to_json(request_id, npc_id, name, name_zh),
                );
                true
            }
            _ => {
                self.end_conversation(id);
                self.send_reject(
                    id,
                    "quest_step_invalid",
                    "quest conversation step is not offered",
                    Some(request_id),
                );
                true
            }
        }
    }

    fn quest_reward(&self, quest_id: &str) -> QuestReward {
        self.gameplay
            .quests
            .iter()
            .find(|quest| quest.quest_id == quest_id)
            .map(|quest| quest.reward.clone())
            .unwrap_or_default()
    }

    fn add_exp(state: &mut PlayerState, amount: u64, exp_table: &[u64]) {
        state.exp = state.exp.saturating_add(amount);
        while let Some(&threshold) = exp_table.get(state.level.saturating_sub(1) as usize) {
            if threshold == 0 || state.exp < threshold {
                state.exp_to_next = threshold;
                break;
            }
            state.exp -= threshold;
            let next_level = state.level.saturating_add(1);
            if next_level == state.level {
                state.exp_to_next = 0;
                break;
            }
            state.level = next_level;
            state.ability_stats.available_ap = state.ability_stats.available_ap.saturating_add(5);
            auth::grant_level_sp(state.job, state.level, &mut state.skill_points);
            state.exp_to_next = exp_table
                .get(state.level.saturating_sub(1) as usize)
                .copied()
                .unwrap_or(0);
            if state.exp_to_next == 0 {
                break;
            }
        }
        if exp_table
            .get(state.level.saturating_sub(1) as usize)
            .copied()
            .unwrap_or(0)
            == 0
        {
            state.exp_to_next = 0;
        }
    }

    fn normalize_profile_progress(profile: &mut Profile, exp_table: &[u64]) {
        // Reuse auth's profile-level advancement path so reconnect catch-up
        // and persisted combat/quest rewards award the same AP/SP exactly
        // once.  Zero experience is a normalization pass because auth also
        // refreshes exp_to_next at the current level.
        auth::add_exp(profile, 0, exp_table);
    }

    fn apply_quest_effect(&mut self, id: &str, effect: npc::QuestEffect) {
        let _ = self.apply_quest_effect_at(id, effect, None, None);
    }

    /// Settle a quest transition after all authored gates have been checked.
    /// `npc_template` is supplied by the dynamic chapter menu; scripted legacy
    /// effects keep the old call path and therefore omit the NPC gate.
    fn apply_quest_effect_at(
        &mut self,
        id: &str,
        effect: npc::QuestEffect,
        npc_template: Option<&str>,
        request_id: Option<&str>,
    ) -> bool {
        let (quest_id, wanted) = match effect {
            npc::QuestEffect::Start(quest_id) => (quest_id, "active"),
            npc::QuestEffect::Complete(quest_id) => (quest_id, "completed"),
            npc::QuestEffect::JobAdvance { .. } => return false,
        };
        let Some(spec) = self
            .gameplay
            .quests
            .iter()
            .find(|quest| quest.quest_id == quest_id)
            .cloned()
        else {
            self.send_reject(
                id,
                "quest_unknown",
                "此任務不在目前的任務目錄中。",
                request_id,
            );
            return false;
        };
        if !spec.executable() {
            self.send_reject(
                id,
                "quest_script_unavailable",
                "此任務的原版劇情腳本尚未接入。",
                request_id,
            );
            return false;
        }
        let phase = if wanted == "active" {
            &spec.start
        } else {
            &spec.complete
        };
        let Some(player_snapshot) = self.players.get(id).cloned() else {
            return false;
        };
        if player_snapshot.state.hp <= 0 || player_snapshot.state.action == "dead" {
            self.send_reject(id, "invalid_state", "死亡角色不能處理任務。", request_id);
            return false;
        }
        if npc_template.is_some_and(|template| !Self::quest_phase_matches_npc(phase, template)) {
            self.send_reject(
                id,
                "quest_npc_unavailable",
                "此任務NPC目前無法處理任務。",
                request_id,
            );
            return false;
        }
        if quest_id == "1402"
            && (npc_template != Some("1032001") || player_snapshot.map_id != "101000003")
        {
            self.send_reject(
                id,
                "quest_npc_unavailable",
                "請前往魔法森林圖書館與漢斯交談。",
                request_id,
            );
            return false;
        }
        let transition_ok = match player_snapshot.quests.get(&quest_id).map(String::as_str) {
            None => wanted == "active",
            Some("active") => wanted == "completed",
            Some("completed") => false,
            Some(_) => false,
        };
        if !transition_ok {
            self.send_reject(
                id,
                "quest_transition_invalid",
                "任務狀態已更新。",
                request_id,
            );
            return false;
        }
        if !Self::quest_conditions_match(&player_snapshot, &phase.conditions)
            || (wanted == "completed" && !self.quest_objectives_complete(&spec, &player_snapshot))
        {
            self.send_reject(
                id,
                "quest_requirements_missing",
                "任務條件尚未完成。",
                request_id,
            );
            return false;
        }

        let mut next_state = player_snapshot.state.clone();
        let mut next_quests = player_snapshot.quests.clone();
        let reward = if wanted == "completed" {
            self.quest_reward(&quest_id)
        } else {
            QuestReward::default()
        };
        if wanted == "active" {
            // Start items are part of the same profile/quest transaction as
            // the status transition.  Count equipped copies too so a
            // reconnect or an already-worn quest hat cannot mint a second
            // copy; only the missing quantity is provisioned.
            for item in &spec.start_items {
                let held = Self::quest_item_count(&next_state.inventory, &item.item_id)
                    .saturating_add(Self::quest_equipped_item_count(
                        &player_snapshot.state.equipped,
                        &item.item_id,
                    ));
                let missing = item.quantity.saturating_sub(held);
                if missing == 0 {
                    continue;
                }
                if let Err(error) =
                    inventory::add_items(&mut next_state.inventory, item.item_id.clone(), missing)
                {
                    let code = match error {
                        inventory::InventoryError::InventoryFull => "quest_start_inventory_full",
                        inventory::InventoryError::UnknownItem => "quest_start_unknown_item",
                        _ => "quest_start_rejected",
                    };
                    let message = if code == "quest_start_inventory_full" {
                        "背包空間不足，任務尚未接取。請整理背包後再次與NPC交談。"
                    } else {
                        "任務起始物品暫時無法取得，任務尚未接取。"
                    };
                    self.send_reject(id, code, message, request_id);
                    return false;
                }
            }
        }
        if wanted == "completed" {
            for requirement in Self::quest_consume_items(&spec) {
                if requirement.item_id.is_empty() || requirement.quantity == 0 {
                    continue;
                }
                let mut remaining = requirement.quantity;
                let slots: Vec<i16> = next_state
                    .inventory
                    .iter()
                    .filter(|item| item.item_id == requirement.item_id)
                    .filter_map(|item| i16::try_from(item.slot).ok())
                    .collect();
                for slot in slots {
                    if remaining == 0 {
                        break;
                    }
                    let available = next_state
                        .inventory
                        .iter()
                        .find(|item| {
                            item.slot == u16::try_from(slot).unwrap_or(0)
                                && item.item_id == requirement.item_id
                        })
                        .map(|item| item.quantity)
                        .unwrap_or(0);
                    let removed = remaining.min(available);
                    if removed > 0 {
                        let Some(kind) = inventory::inventory_type(&requirement.item_id) else {
                            self.send_reject(
                                id,
                                "quest_requirements_missing",
                                "任務物品無效。",
                                request_id,
                            );
                            return false;
                        };
                        match inventory::remove_items(
                            &mut next_state.inventory,
                            kind,
                            slot,
                            removed,
                        ) {
                            Ok((removed_item, actual)) if removed_item == requirement.item_id => {
                                remaining = remaining.saturating_sub(actual);
                            }
                            Ok(_) | Err(_) => {
                                self.send_reject(
                                    id,
                                    "quest_requirements_missing",
                                    "任務物品無法扣除。",
                                    request_id,
                                );
                                return false;
                            }
                        }
                    }
                }
                if remaining > 0 {
                    self.send_reject(
                        id,
                        "quest_requirements_missing",
                        "任務物品數量不足。",
                        request_id,
                    );
                    return false;
                }
            }
            next_state.mesos = next_state.mesos.saturating_add(reward.mesos);
            if reward.exp > 0 {
                Self::add_exp(&mut next_state, reward.exp, &self.gameplay.exp_table);
            }
            for item in reward.items.iter() {
                if let Err(error) = inventory::add_items(
                    &mut next_state.inventory,
                    item.item_id.clone(),
                    item.quantity,
                ) {
                    let code = match error {
                        inventory::InventoryError::InventoryFull => "quest_reward_inventory_full",
                        inventory::InventoryError::UnknownItem => "quest_reward_unknown_item",
                        _ => "quest_reward_rejected",
                    };
                    let message = if code == "quest_reward_inventory_full" {
                        "背包空間不足。請整理背包後再次與任務NPC交談，獎勵尚未領取。"
                    } else {
                        "任務獎勵暫時無法領取，進度已保留。請稍後重試。"
                    };
                    self.send_reject(id, code, message, request_id);
                    return false;
                }
            }
        }

        let mut next_map_id = player_snapshot.map_id.clone();
        let mut warp = None;
        if let Some(target_map_id) = phase.warp_map_id.clone() {
            let Some(target_map) = self.maps.get(&target_map_id).cloned() else {
                self.send_reject(
                    id,
                    "map_unavailable",
                    "任務目的地目前無法使用。",
                    request_id,
                );
                return false;
            };
            let spawn = (target_map.spawn.x, target_map.spawn.y);
            let preferred = phase
                .warp_portal_name
                .as_deref()
                .and_then(|name| target_map.portals.iter().find(|portal| portal.name == name))
                .map(|portal| (portal.x, portal.y))
                .unwrap_or(spawn);
            let resolve_spawn = |(x, y): (f64, f64)| {
                if !x.is_finite()
                    || !y.is_finite()
                    || !(target_map.bounds.x_min..=target_map.bounds.x_max).contains(&x)
                    || !(target_map.bounds.y_min..=target_map.bounds.y_max).contains(&y)
                {
                    return None;
                }
                // Authored map spawns may be airborne above their first
                // foothold. Preserve that source point and let normal
                // gravity land the player instead of inventing a corner
                // position or selecting an unrelated upper platform.
                let (foothold_id, ground) = target_map.ground_below(x, y)?;
                if (ground - y).abs() <= 24.0 {
                    Some((x, ground, foothold_id, true))
                } else {
                    Some((x, y, 0, false))
                }
            };
            let Some((x, y, foothold_id, grounded)) =
                resolve_spawn(preferred).or_else(|| resolve_spawn(spawn))
            else {
                self.send_reject(
                    id,
                    "map_unavailable",
                    "任務目的地沒有可用出生點。",
                    request_id,
                );
                return false;
            };
            next_map_id = target_map_id;
            next_state.x = x;
            next_state.y = y;
            next_state.vx = 0.0;
            next_state.vy = 0.0;
            next_state.grounded = grounded;
            next_state.action = if grounded { "stand" } else { "jump" };
            warp = Some(foothold_id);
        }
        next_quests.insert(quest_id.clone(), wanted.to_owned());
        let did_warp = warp.is_some();
        let warp_foothold = warp.unwrap_or(0);

        let mut profile = profile_from_state(
            &next_state,
            &next_map_id,
            &player_snapshot.death_id,
            player_snapshot.base_max_mp,
        );
        // P: the original q1402 scripts are absent. Explicit completion at
        // Hans uses the same first-job grant as the authorized shortcut.
        // Existing mage jobs recover only the story; they receive no grant.
        let first_mage_transfer = quest_id == "1402" && wanted == "completed" && profile.job == 0;
        if first_mage_transfer {
            if profile.level < 10
                || player_snapshot.quests.get("36307").map(String::as_str) != Some("completed")
            {
                self.send_reject(
                    id,
                    "quest_requirements_missing",
                    "請先完成前置劇情並達到10級。",
                    request_id,
                );
                return false;
            }
            auth::grant_first_mage(&mut profile);
            apply_profile(&mut next_state, profile.clone());
        }
        if let Some(store) = self.store.as_ref() {
            match store.commit_quest(id, &quest_id, wanted, &profile) {
                Ok(true) => {}
                Ok(false) => {
                    let restored = store
                        .load_profile(id, &profile)
                        .and_then(|profile| store.load_quests(id).map(|quests| (profile, quests)));
                    match restored {
                        Ok((profile, quests)) => {
                            if let Some(player) = self.players.get_mut(id) {
                                apply_profile_to_player(
                                    &self.gameplay,
                                    &self.mage_skills,
                                    player,
                                    profile,
                                );
                                player.quests = quests;
                            }
                            self.send_quest_list(id);
                        }
                        Err(error) => self.send_reject(id, "persistence", &error, request_id),
                    }
                    return false;
                }
                Err(error) => {
                    self.send_reject(id, "persistence", &error, request_id);
                    return false;
                }
            }
        }
        if let Some(player) = self.players.get_mut(id) {
            player.map_id = next_map_id;
            player.state = next_state;
            player.quests = next_quests;
            if first_mage_transfer {
                player.base_max_mp = profile.max_mp;
            }
            if did_warp {
                player.natural_recovery_next_tick =
                    self.tick.saturating_add(NATURAL_RECOVERY_INTERVAL_TICKS);
                player.state.facing = 1;
                player.state.climbing = false;
                player.state.ladder_id = None;
                player.state.action_id = None;
                player.state.action_started_tick = self.tick;
                player.direction = 0;
                player.vertical = 0;
                player.jump = false;
                player.foothold_id = warp_foothold;
                player.last_foothold_id = player.foothold_id;
                player.fall_boundary_hold = false;
                player.meditation_until = 0;
                player.meditation_mad = 0;
                clear_beginner_buffs(player);
                player.ice_teleport_enabled = false;
                player.ice_fields.clear();
                player.teleport_mastery_enabled = false;
                player.teleport_boost_enabled = false;
                player.adaptation_active = false;
                player.adaptation_charges = 0;
                player.summon = None;
            }
            refresh_player_derived(&self.gameplay, &self.mage_skills, player);
        }
        self.send_quest_update(id, &quest_id, wanted, reward);
        self.send_quest_list(id);
        // Quest phase changes also alter hidden chapter NPCs and interaction
        // markers, so refresh the snapshot even when the reward did not warp.
        self.send_snapshot(id);
        true
    }

    fn handle_quest_interact(&mut self, id: String, request_id: String, quest_id: String) {
        let Some(spec) = self
            .gameplay
            .quests
            .iter()
            .find(|spec| spec.quest_id == quest_id)
            .cloned()
        else {
            self.send_reject(
                &id,
                "quest_unknown",
                "此任務不在目前的任務目錄中。",
                Some(&request_id),
            );
            return;
        };
        if !spec.executable() {
            self.send_reject(
                &id,
                "quest_script_unavailable",
                "此任務的原版劇情腳本尚未接入。",
                Some(&request_id),
            );
            return;
        }
        let Some(interaction) = spec.interaction.clone() else {
            self.send_reject(
                &id,
                "quest_interaction_unavailable",
                "此任務目前沒有可互動目標。",
                Some(&request_id),
            );
            return;
        };
        let Some(player_snapshot) = self.players.get(&id).cloned() else {
            return;
        };
        if Self::quest_status_for(&player_snapshot, &quest_id) != Some("active") {
            self.send_reject(
                &id,
                "quest_interaction_unavailable",
                "此任務尚未進入互動階段。",
                Some(&request_id),
            );
            return;
        }
        if player_snapshot.state.hp <= 0 || player_snapshot.state.action == "dead" {
            self.send_reject(
                &id,
                "invalid_state",
                "死亡角色不能進行任務互動。",
                Some(&request_id),
            );
            return;
        }
        let range = if interaction.range > 0.0 {
            interaction.range
        } else {
            64.0
        };
        if player_snapshot.map_id != interaction.map_id
            || (player_snapshot.state.x - interaction.x)
                .hypot(player_snapshot.state.y - interaction.y)
                > range
        {
            self.send_reject(
                &id,
                "quest_interaction_too_far",
                "請靠近任務互動目標。",
                Some(&request_id),
            );
            return;
        }
        if interaction.item_id.is_empty() || interaction.quantity == 0 {
            self.send_reject(
                &id,
                "quest_interaction_done",
                "任務互動已完成。",
                Some(&request_id),
            );
            return;
        }
        let mut next_state = player_snapshot.state.clone();
        if self.store.is_none() {
            let held =
                Self::quest_item_count(&player_snapshot.state.inventory, &interaction.item_id);
            if held >= interaction.quantity {
                self.send_reject(
                    &id,
                    "quest_interaction_done",
                    "任務互動已完成。",
                    Some(&request_id),
                );
                return;
            }
            let missing = interaction.quantity.saturating_sub(held);
            if let Err(error) = inventory::add_items(
                &mut next_state.inventory,
                interaction.item_id.clone(),
                missing,
            ) {
                let code = match error {
                    inventory::InventoryError::InventoryFull => "quest_interaction_inventory_full",
                    inventory::InventoryError::UnknownItem => "quest_interaction_unknown_item",
                    _ => "quest_interaction_rejected",
                };
                self.send_reject(
                    &id,
                    code,
                    "背包空間不足或互動物品無法取得。",
                    Some(&request_id),
                );
                return;
            }
        }

        let mut authoritative_profile = None;
        if let Some(store) = self.store.as_ref() {
            let profile = profile_from_state(
                &next_state,
                &player_snapshot.map_id,
                &player_snapshot.death_id,
                player_snapshot.base_max_mp,
            );
            match store.commit_quest_interaction(
                &id,
                &quest_id,
                &interaction.item_id,
                interaction.quantity,
                &profile,
            ) {
                Ok(true) => match store.load_profile(&id, &profile) {
                    Ok(profile) => authoritative_profile = Some(profile),
                    Err(error) => {
                        self.send_reject(&id, "persistence", &error, Some(&request_id));
                        self.players.remove(&id);
                        self.end_conversation(&id);
                        self.pending_attacks
                            .retain(|_, attack| attack.player_id != id);
                        return;
                    }
                },
                Ok(false) => {
                    let restored = store
                        .load_profile(&id, &profile)
                        .and_then(|profile| store.load_quests(&id).map(|quests| (profile, quests)));
                    match restored {
                        Ok((profile, quests)) => {
                            if let Some(player) = self.players.get_mut(&id) {
                                apply_profile_to_player(
                                    &self.gameplay,
                                    &self.mage_skills,
                                    player,
                                    profile,
                                );
                                player.quests = quests;
                            }
                            self.send_quest_list(&id);
                            self.send_snapshot(&id);
                        }
                        Err(error) => {
                            self.send_reject(&id, "persistence", &error, Some(&request_id))
                        }
                    }
                    return;
                }
                Err(error) => {
                    self.send_reject(&id, "persistence", &error, Some(&request_id));
                    return;
                }
            }
        }
        if let Some(profile) = authoritative_profile {
            apply_profile(&mut next_state, profile);
        }
        if let Some(player) = self.players.get_mut(&id) {
            player.state = next_state;
            refresh_player_derived(&self.gameplay, &self.mage_skills, player);
        }
        self.send_quest_update(&id, &quest_id, "active", QuestReward::default());
        self.send_quest_list(&id);
        self.send_snapshot(&id);
    }

    fn warp_player(&mut self, player_id: &str, map_id: String) -> bool {
        self.warp_player_at(player_id, map_id, None)
    }

    fn warp_player_at(
        &mut self,
        player_id: &str,
        map_id: String,
        portal_name: Option<&str>,
    ) -> bool {
        let Some(map) = self.maps.get(&map_id).cloned() else {
            return false;
        };
        let spawn = (map.spawn.x, map.spawn.y);
        let preferred = map
            .portals
            .iter()
            .find(|portal| portal_name.is_some_and(|name| portal.name == name))
            .or_else(|| map.portals.first())
            .map(|portal| (portal.x, portal.y))
            .unwrap_or(spawn);
        let resolve_spawn = |(x, y): (f64, f64)| {
            if !x.is_finite()
                || !y.is_finite()
                || !(map.bounds.x_min..=map.bounds.x_max).contains(&x)
                || !(map.bounds.y_min..=map.bounds.y_max).contains(&y)
            {
                return None;
            }
            let (foothold_id, ground) = map.ground_below(x, y)?;
            if (ground - y).abs() <= 24.0 {
                Some((x, ground, foothold_id, true))
            } else {
                Some((x, y, 0, false))
            }
        };
        let Some((x, y, foothold_id, grounded)) =
            resolve_spawn(preferred).or_else(|| resolve_spawn(spawn))
        else {
            return false;
        };
        let Some(mut candidate) = self.players.get(player_id).cloned() else {
            return false;
        };
        candidate.map_id = map_id.clone();
        candidate.natural_recovery_next_tick =
            self.tick.saturating_add(NATURAL_RECOVERY_INTERVAL_TICKS);
        candidate.state.x = x;
        candidate.state.y = y;
        candidate.state.vx = 0.0;
        candidate.state.vy = 0.0;
        candidate.state.facing = 1;
        candidate.state.grounded = grounded;
        candidate.state.climbing = false;
        candidate.state.ladder_id = None;
        candidate.state.action = if grounded { "stand" } else { "jump" };
        candidate.state.action_id = None;
        candidate.state.action_started_tick = self.tick;
        candidate.direction = 0;
        candidate.vertical = 0;
        candidate.jump = false;
        candidate.foothold_id = foothold_id;
        candidate.last_foothold_id = foothold_id;
        candidate.drop_fh = 0;
        candidate.fall_boundary_hold = false;
        candidate.attack_until = 0;
        candidate.contact_invulnerable_until = 0;
        candidate.knockback_vx = 0.0;
        candidate.knockback_until = 0;
        candidate.meditation_until = 0;
        candidate.meditation_mad = 0;
        clear_beginner_buffs(&mut candidate);
        candidate.ice_teleport_enabled = false;
        candidate.ice_fields.clear();
        candidate.teleport_mastery_enabled = false;
        candidate.teleport_boost_enabled = false;
        candidate.adaptation_active = false;
        candidate.adaptation_charges = 0;
        candidate.summon = None;
        refresh_player_derived(&self.gameplay, &self.mage_skills, &mut candidate);

        let profile = profile_from_state(
            &candidate.state,
            &candidate.map_id,
            &candidate.death_id,
            candidate.base_max_mp,
        );
        if let Some(store) = self.store.as_ref() {
            if store.save_profile(player_id, &profile).is_err() {
                return false;
            }
        }
        self.end_conversation(player_id);
        let Some(player) = self.players.get_mut(player_id) else {
            return false;
        };
        *player = candidate;
        // Drops for the destination map arrive via the next snapshot.
        self.send_snapshot(player_id);
        true
    }

    fn send_snapshot(&mut self, id: &str) {
        let snapshot = self.snapshot(id);
        if let Some(player) = self.players.get(id) {
            let _ = player.output.try_send(snapshot);
        }
    }

    /// Push the player's full quest log with display text localized to the
    /// player's language.  Always sent after a join so the client window is
    /// authoritative even when every row was cleared on the previous session.
    fn send_quest_list(&self, id: &str) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let quests = self.quest_log_entries(id);
        let message = serde_json::json!({ "type": "questList", "quests": quests }).to_string();
        let _ = player.output.try_send(message);
    }

    /// Push a single quest transition (active/completed) with the localized
    /// display text and the reward the server actually granted.
    fn send_quest_update(&self, id: &str, quest_id: &str, status: &str, reward: QuestReward) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let lang = player.lang;
        let reward_items: Vec<serde_json::Value> = reward
            .items
            .into_iter()
            .map(|item| serde_json::json!({ "itemId": item.item_id, "quantity": item.quantity }))
            .collect();
        let mut message = self
            .gameplay
            .quests
            .iter()
            .find(|spec| spec.quest_id == quest_id)
            .and_then(|spec| self.quest_entry(id, spec, Some(status)))
            .unwrap_or_else(|| {
                serde_json::json!({
                    "questId": quest_id,
                    "name": self.quest_text.name(quest_id, lang),
                    "status": status,
                    "summary": self.quest_text.summary(quest_id, lang),
                })
            });
        message["type"] = serde_json::Value::String("questUpdate".to_owned());
        message["reward"] = serde_json::json!({
            "mesos": reward.mesos,
            "exp": reward.exp,
            "items": reward_items,
        });
        let _ = player.output.try_send(message.to_string());
    }

    /// Register the authored use cooldown of a consumable that was just drunk.
    ///
    /// Only an item whose `spec.time` the source authors a cooldown for gets an
    /// entry; everything else is left out of the map so the common case (a
    /// stack of 紅色藥水) stays free of any per-item bookkeeping.  A cooldown
    /// is stored as the tick at which the item becomes usable again, and the
    /// world loop never has to touch it — the gate is evaluated on use.
    fn arm_potion_cooldown(
        &mut self,
        id: &str,
        item_id: &str,
        effect: Option<inventory::UseEffect>,
    ) {
        let Some(cooldown_ms) = effect.and_then(|effect| effect.cooldown_ms) else {
            return;
        };
        let ticks = cooldown_ms.div_ceil(TICK_MS).max(1);
        if let Some(player) = self.players.get_mut(id) {
            player
                .potion_cooldowns
                .insert(item_id.to_owned(), self.tick + ticks);
        }
    }

    fn send_reject(&self, id: &str, code: &str, message: &str, request_id: Option<&str>) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let _ = player.output.try_send(reject(code, message, request_id));
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
                &profile_from_state(
                    &player.state,
                    &player.map_id,
                    &player.death_id,
                    player.base_max_mp,
                ),
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

    /// Authoritative NPC shop sell-back (`ShopSell`), the other half of the
    /// shop loop.
    ///
    /// The client only names the shop, the tab and the slot.  Which item sits
    /// there, how many it holds, whether the source lets it be sold and how
    /// many mesos it is worth are all resolved here, so a tampered request can
    /// neither rename the item nor name its own price.
    ///
    /// The whole exchange is one atomic step: the stack is removed from a
    /// cloned inventory and only committed together with the mesos credit, so
    /// a failure can never pay out without taking the item (or vice versa).
    fn handle_shop_sell(
        &mut self,
        id: String,
        request_id: String,
        shop_id: String,
        inventory_type: u8,
        source_slot: i16,
        quantity: u32,
    ) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        // A sell credits mesos, so a replayed request must not run twice.
        // Re-send the remembered result instead of touching the inventory.
        if let Some(prior) = self
            .shop_sell_requests
            .get(&(id.clone(), request_id.clone()))
        {
            let prior = prior.clone();
            self.send_shop_sell_outcome(&id, &request_id, &prior);
            return;
        }
        // The merchant must be on the player's own map and within talking
        // range, exactly as for a purchase; otherwise a client could trade
        // with a shop it never walked to.
        let shop_known = self
            .gameplay
            .shops
            .iter()
            .any(|shop| shop.shop_id == shop_id);
        if !shop_known {
            self.send_shop_sell_result(
                &id,
                &request_id,
                false,
                "shop_unknown",
                &shop_id,
                "",
                quantity,
                source_slot,
                0,
            );
            return;
        }
        let npc_in_range = self.npcs.values().any(|npc| {
            npc.map_id == player.map_id
                && npc.state.shop_id.as_deref() == Some(shop_id.as_str())
                && (player.state.x - npc.state.x).abs() <= npc::TALK_RANGE_X
                && (player.state.y - npc.state.y).abs() <= npc::TALK_RANGE_Y
        });
        if !npc_in_range {
            self.send_shop_sell_result(
                &id,
                &request_id,
                false,
                "shop_too_far",
                &shop_id,
                "",
                quantity,
                source_slot,
                0,
            );
            return;
        }
        // Resolve the stack server-side; the client's idea of what is in the
        // slot is never trusted.
        let Some(stack) = player
            .state
            .inventory
            .iter()
            .find(|item| item.slot == source_slot as u16)
            .filter(|item| inventory::inventory_type(&item.item_id) == Some(inventory_type))
        else {
            self.send_shop_sell_result(
                &id,
                &request_id,
                false,
                "shop_slot_empty",
                &shop_id,
                "",
                quantity,
                source_slot,
                0,
            );
            return;
        };
        let item_id = stack.item_id.clone();
        let available = stack.quantity;
        if available < quantity {
            self.send_shop_sell_result(
                &id,
                &request_id,
                false,
                "shop_quantity_invalid",
                &shop_id,
                &item_id,
                quantity,
                source_slot,
                0,
            );
            return;
        }
        // Source-authored restrictions: quest/cash/one-of-a-kind items carry
        // no shop value, so selling them is refused rather than paying mesos
        // for something the original never lets leave the inventory.
        if inventory::is_unsellable(&item_id) || inventory::is_cash_item(&item_id) {
            self.send_shop_sell_result(
                &id,
                &request_id,
                false,
                "shop_item_unsellable",
                &shop_id,
                &item_id,
                quantity,
                source_slot,
                0,
            );
            return;
        }
        let Some(unit_price) = inventory::item_price(&item_id) else {
            self.send_shop_sell_result(
                &id,
                &request_id,
                false,
                "shop_item_unsellable",
                &shop_id,
                &item_id,
                quantity,
                source_slot,
                0,
            );
            return;
        };
        // P: shops pay a fraction of the catalog price (see
        // SHOP_SELL_PRICE_PERCENT).  Rounding is down so a shop can never pay
        // out more than the authored value allows.
        let unit_payout =
            unit_price.saturating_mul(SHOP_SELL_PRICE_PERCENT) / SHOP_SELL_PRICE_DIVISOR;
        if unit_payout == 0 {
            self.send_shop_sell_result(
                &id,
                &request_id,
                false,
                "shop_item_unsellable",
                &shop_id,
                &item_id,
                quantity,
                source_slot,
                0,
            );
            return;
        }
        let payout = match unit_payout.checked_mul(u64::from(quantity)) {
            Some(payout) => payout,
            None => {
                self.send_shop_sell_result(
                    &id,
                    &request_id,
                    false,
                    "shop_quantity_invalid",
                    &shop_id,
                    &item_id,
                    quantity,
                    source_slot,
                    0,
                );
                return;
            }
        };
        // Atomic against a clone: the removal must fully succeed before any
        // mesos move, so a partial state can never be persisted.
        let mut next_inventory = player.state.inventory.clone();
        if let Err(error) =
            inventory::remove_items(&mut next_inventory, inventory_type, source_slot, quantity)
        {
            self.send_shop_sell_result(
                &id,
                &request_id,
                false,
                match error {
                    inventory::InventoryError::InvalidInventoryType => "shop_rejected",
                    inventory::InventoryError::InvalidSlot => "shop_slot_empty",
                    inventory::InventoryError::SourceEmpty => "shop_slot_empty",
                    inventory::InventoryError::QuantityMissing => "shop_quantity_invalid",
                    _ => "shop_rejected",
                },
                &shop_id,
                &item_id,
                quantity,
                source_slot,
                0,
            );
            return;
        }
        let new_mesos = player.state.mesos.saturating_add(payout);
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
                &profile_from_state(
                    &player.state,
                    &player.map_id,
                    &player.death_id,
                    player.base_max_mp,
                ),
            );
        }
        self.send_shop_sell_result(
            &id,
            &request_id,
            true,
            "",
            &shop_id,
            &item_id,
            quantity,
            source_slot,
            payout,
        );
    }

    /// Record one sell-back outcome and send it.  Every path goes through here
    /// so the idempotency window sees refusals as well: a request that was
    /// already refused stays refused, and a request that already paid is never
    /// charged twice.
    fn send_shop_sell_result(
        &mut self,
        id: &str,
        request_id: &str,
        success: bool,
        code: &str,
        shop_id: &str,
        item_id: &str,
        quantity: u32,
        slot: i16,
        mesos_gained: u64,
    ) {
        let mesos = self
            .players
            .get(id)
            .map(|player| player.state.mesos)
            .unwrap_or(0);
        let outcome = ShopSellOutcome {
            success,
            code: code.to_owned(),
            shop_id: shop_id.to_owned(),
            item_id: item_id.to_owned(),
            quantity,
            slot,
            mesos_gained,
            mesos,
        };
        self.shop_sell_requests
            .insert((id.to_owned(), request_id.to_owned()), outcome.clone());
        self.send_shop_sell_outcome(id, request_id, &outcome);
    }

    /// Emit the `shopSold` wire message for an already-decided outcome.
    fn send_shop_sell_outcome(&self, id: &str, request_id: &str, outcome: &ShopSellOutcome) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let message = serde_json::json!({
            "type":"shopSold",
            "requestId":request_id,
            "success":outcome.success,
            "code":outcome.code,
            "shopId":outcome.shop_id,
            "itemId":outcome.item_id,
            "quantity":outcome.quantity,
            "slot":outcome.slot,
            "mesosGained":outcome.mesos_gained,
            "mesos":player.state.mesos,
        })
        .to_string();
        let _ = player.output.try_send(message);
    }

    /// Close the character's warehouse window, if one is open.  Called from
    /// `end_conversation`, so leaving the npc, changing map or dying all end
    /// the session through one path.
    fn close_storage(&mut self, player_id: &str) {
        if self.open_storage.remove(player_id).is_some() {
            self.send_storage_state(player_id, None);
        }
    }

    /// Open the account warehouse at a placed storage keeper.
    ///
    /// The client names the npc; whether it is a storage keeper, whether the
    /// player is standing close enough and what the warehouse holds are all
    /// decided here.  Storage is account-wide, so two characters of the same
    /// account see the same rows.
    fn handle_storage_open(&mut self, id: String, request_id: String, npc_id: String) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        let Some(npc) = self.npcs.get(&npc_id) else {
            self.send_storage_result(&id, &request_id, false, "storage_unknown", "0", 0, 0, 0);
            return;
        };
        // The keeper must be authored as one in Npc.wz *and* the player must
        // be on its map within talking range: a client cannot open the
        // warehouse from across the world.
        let template_id = npc.template_id.clone();
        let is_keeper = self
            .gameplay
            .npcs
            .iter()
            .find(|template| template.template_id == template_id)
            .is_some_and(|template| template.func.contains(STORAGE_KEEPER_FUNC));
        if !is_keeper {
            self.send_storage_result(&id, &request_id, false, "storage_not_keeper", "0", 0, 0, 0);
            return;
        }
        let in_range = npc.map_id == player.map_id
            && (player.state.x - npc.state.x).abs() <= npc::TALK_RANGE_X
            && (player.state.y - npc.state.y).abs() <= npc::TALK_RANGE_Y;
        if !in_range {
            self.send_storage_result(&id, &request_id, false, "storage_too_far", "0", 0, 0, 0);
            return;
        }
        if player.state.hp <= 0 || player.state.action == "dead" {
            self.send_storage_result(&id, &request_id, false, "dead", "0", 0, 0, 0);
            return;
        }
        self.open_storage.insert(id.clone(), npc_id.clone());
        self.send_storage_result(&id, &request_id, true, "", &npc_id, 0, 0, 0);
        self.send_storage_state(&id, Some(&npc_id));
    }

    /// Move one stack between the inventory and the warehouse.
    ///
    /// The window must already be open at a keeper in range — that is the
    /// authority that the player actually walked to a warehouse, and it is
    /// re-checked on every transfer so a client cannot bank items from the
    /// field.
    fn handle_storage_transfer(
        &mut self,
        id: String,
        request_id: String,
        operation: StorageTransferOperation,
        inventory_type: u8,
        slot: i16,
        quantity: u32,
    ) {
        if !self.players.contains_key(&id) {
            return;
        }
        let Some(npc_id) = self.open_storage.get(&id).cloned() else {
            self.send_storage_result(
                &id,
                &request_id,
                false,
                "storage_closed",
                "0",
                inventory_type,
                slot,
                quantity,
            );
            return;
        };
        if !self.storage_keeper_in_range(&id, &npc_id) {
            self.close_storage(&id);
            self.send_storage_result(
                &id,
                &request_id,
                false,
                "storage_too_far",
                &npc_id,
                inventory_type,
                slot,
                quantity,
            );
            return;
        }
        let (operation, kind) = match operation {
            StorageTransferOperation::Deposit => (auth::StorageOperation::Deposit, inventory_type),
            StorageTransferOperation::Withdraw => {
                (auth::StorageOperation::Withdraw, inventory_type)
            }
        };
        let Some(store) = self.store.clone() else {
            self.send_storage_result(
                &id,
                &request_id,
                false,
                "persistence",
                &npc_id,
                inventory_type,
                slot,
                quantity,
            );
            return;
        };
        match store.storage_transfer(&id, &request_id, operation, kind, slot, quantity) {
            Ok(outcome) => {
                self.send_storage_transfer_result(&id, &request_id, &npc_id, &outcome);
                // Refresh the authoritative view from *inside the world* is
                // not needed for the warehouse (the DB just wrote it), but the
                // inventory side changed, so reload it to keep the snapshot
                // and the window consistent.
                self.reload_storage_side_effects(&id, &store);
                self.send_storage_state(&id, Some(&npc_id));
                if outcome.success {
                    self.send_quest_list(&id);
                }
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

    /// Move mesos between the character purse and the warehouse.
    fn handle_storage_mesos(
        &mut self,
        id: String,
        request_id: String,
        operation: StorageTransferOperation,
        quantity: u32,
    ) {
        let Some(npc_id) = self.open_storage.get(&id).cloned() else {
            self.send_storage_result(
                &id,
                &request_id,
                false,
                "storage_closed",
                "0",
                0,
                0,
                quantity,
            );
            return;
        };
        if !self.storage_keeper_in_range(&id, &npc_id) {
            self.close_storage(&id);
            self.send_storage_result(
                &id,
                &request_id,
                false,
                "storage_too_far",
                &npc_id,
                0,
                0,
                quantity,
            );
            return;
        }
        let operation = match operation {
            StorageTransferOperation::Deposit => auth::StorageOperation::Deposit,
            StorageTransferOperation::Withdraw => auth::StorageOperation::Withdraw,
        };
        let Some(store) = self.store.clone() else {
            self.send_storage_result(
                &id,
                &request_id,
                false,
                "persistence",
                &npc_id,
                0,
                0,
                quantity,
            );
            return;
        };
        match store.storage_mesos(&id, &request_id, operation, quantity) {
            Ok(outcome) => {
                // The purse lives in the profile, so mirror the new balance
                // into the in-memory state before the next snapshot.
                if let Some(player) = self.players.get_mut(&id) {
                    player.state.mesos = outcome.mesos;
                }
                let message = serde_json::json!({
                    "type":"storageMesos",
                    "requestId":request_id,
                    "success":outcome.success,
                    "code":outcome.code,
                    "operation":outcome.operation.as_str(),
                    "quantity":outcome.quantity,
                    "mesos":outcome.mesos,
                    "storedMesos":outcome.stored_mesos,
                })
                .to_string();
                if let Some(player) = self.players.get(&id) {
                    let _ = player.output.try_send(message);
                }
                self.send_storage_state(&id, Some(&npc_id));
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

    /// Re-verify that the open keeper is still on the player's map and close.
    fn storage_keeper_in_range(&self, id: &str, npc_id: &str) -> bool {
        let Some(player) = self.players.get(id) else {
            return false;
        };
        self.npcs.get(npc_id).is_some_and(|npc| {
            npc.map_id == player.map_id
                && (player.state.x - npc.state.x).abs() <= npc::TALK_RANGE_X
                && (player.state.y - npc.state.y).abs() <= npc::TALK_RANGE_Y
        })
    }

    // ----------------------------------------------------------------- party
    //
    // A party is session state owned entirely by the world, in the same sense
    // a reactor's state is: it is a fact about characters that are currently
    // in the world, so a restart legitimately dissolves it and no SQLite row
    // has to be kept in step.  The client only ever names a character to
    // invite, or answers an invitation with yes/no — whether a party exists,
    // who leads it, how many fit and who shares EXP are all decided here.

    /// The party `id` belongs to, if any.
    fn party_id_of(&self, id: &str) -> Option<String> {
        self.parties
            .iter()
            .find(|(_, party)| party.members.iter().any(|member| member == id))
            .map(|(party_id, _)| party_id.clone())
    }

    fn next_party_id(&mut self) -> u64 {
        self.party_sequence += 1;
        self.party_sequence
    }

    /// Resolve a typed character name to a character that is in the world.
    /// Matching is exact first and case-insensitive as a fallback, so a name
    /// typed with the wrong capitalisation still reaches its owner without
    /// ever becoming a claim about an identity.
    fn find_player_by_name(&self, name: &str) -> Option<String> {
        let needle = name.trim();
        self.players
            .iter()
            .find(|(_, player)| player.state.username == needle)
            .or_else(|| {
                self.players
                    .iter()
                    .find(|(_, player)| player.state.username.eq_ignore_ascii_case(needle))
            })
            .map(|(id, _)| id.clone())
    }

    /// Party members sharing the map with `id`, always including `id` itself.
    /// Grouping is a same-map fact: being listed in a party is not enough to
    /// share a buff or a kill.
    fn party_members_on_map(&self, id: &str) -> Vec<String> {
        let fallback = || vec![id.to_owned()];
        let Some(party_id) = self.party_id_of(id) else {
            return fallback();
        };
        let Some(party) = self.parties.get(&party_id) else {
            return fallback();
        };
        let Some(map_id) = self.players.get(id).map(|player| player.map_id.clone()) else {
            return fallback();
        };
        let members: Vec<String> = party
            .members
            .iter()
            .filter(|member| {
                self.players
                    .get(*member)
                    .is_some_and(|player| player.map_id == map_id && player.state.hp > 0)
            })
            .cloned()
            .collect();
        if members.is_empty() {
            fallback()
        } else {
            members
        }
    }

    /// Members that take part in a kill's EXP bonus.  Empty for a solo kill,
    /// which leaves every existing solo EXP number exactly as it is.
    fn party_exp_members(&self, id: &str) -> Vec<String> {
        let members = self.party_members_on_map(id);
        if members.len() < 2 {
            Vec::new()
        } else {
            members
        }
    }

    /// One authoritative view of a party.  Members that are no longer in the
    /// world are omitted — the view is rebuilt from `players`, not from a
    /// cached roster.
    fn party_view(&self, party_id: &str) -> Option<serde_json::Value> {
        let party = self.parties.get(party_id)?;
        let members: Vec<serde_json::Value> = party
            .members
            .iter()
            .filter_map(|member| {
                let player = self.players.get(member)?;
                Some(serde_json::json!({
                    "id": player.state.id,
                    "name": player.state.username,
                    "level": player.state.level,
                    "job": player.state.job,
                    "mapId": player.map_id,
                    "hp": player.state.hp,
                    "maxHp": player.state.max_hp,
                    "mp": player.state.mp,
                    "maxMp": player.state.max_mp,
                    "leader": *member == party.leader_id,
                }))
            })
            .collect();
        Some(serde_json::json!({
            "type": "partyState",
            "partyId": party.id,
            "leaderId": party.leader_id,
            "members": members,
        }))
    }

    /// Push the authoritative party view to every listed character.  A
    /// character without a party receives `closed: true`, which is what makes
    /// a removed member's window disappear.
    fn push_party_state(&self, ids: &[String]) {
        for id in ids {
            let message = self
                .party_id_of(id)
                .and_then(|party_id| self.party_view(&party_id))
                .unwrap_or_else(|| serde_json::json!({"type":"partyState","closed":true}))
                .to_string();
            if let Some(player) = self.players.get(id).filter(|player| !player.detached) {
                let _ = player.output.try_send(message);
            }
        }
    }

    /// Inform a character about a party event its own request did not cause —
    /// a declined invitation, a kick.  Display only: the authoritative state
    /// still arrives as a `partyState` view, so a lost notice cannot desync a
    /// window.
    fn send_party_notice(&self, recipient: &str, code: &str, actor_id: &str) {
        let Some(player) = self.players.get(recipient) else {
            return;
        };
        let actor_name = self
            .players
            .get(actor_id)
            .map(|player| player.state.username.clone())
            .unwrap_or_default();
        let message = serde_json::json!({
            "type":"partyNotice",
            "code":code,
            "playerId":actor_id,
            "playerName":actor_name,
        })
        .to_string();
        let _ = player.output.try_send(message);
    }

    fn send_party_result(&self, id: &str, request_id: &str, success: bool, code: &str) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let message = serde_json::json!({
            "type":"partyResult",
            "requestId":request_id,
            "success":success,
            "code":code,
        })
        .to_string();
        let _ = player.output.try_send(message);
    }

    /// Bounded request-id idempotency for party intents: a retried invite or
    /// kick replays the recorded outcome instead of acting a second time.
    fn remember_party_request(&mut self, id: &str, request_id: &str, success: bool, code: &str) {
        if self.party_requests.len() >= PARTY_REQUEST_WINDOW * self.players.len().max(1) {
            self.party_requests
                .retain(|(player_id, _), _| self.players.contains_key(player_id));
        }
        self.party_requests.insert(
            (id.to_owned(), request_id.to_owned()),
            PartyOutcome {
                success,
                code: code.to_owned(),
            },
        );
    }

    fn replayed_party_request(&self, id: &str, request_id: &str) -> Option<(bool, String)> {
        self.party_requests
            .get(&(id.to_owned(), request_id.to_owned()))
            .map(|outcome| (outcome.success, outcome.code.clone()))
    }

    /// Everything that can make an invitation impossible, checked in the
    /// order a player would notice it.
    fn party_invite_target(&self, id: &str, player_name: &str) -> Result<String, String> {
        let Some(target) = self.find_player_by_name(player_name) else {
            return Err("party_unknown_player".to_owned());
        };
        if target == id {
            return Err("party_self".to_owned());
        }
        if self.party_invites.contains_key(&target) {
            return Err("party_busy".to_owned());
        }
        if let Some(party) = self
            .party_id_of(id)
            .and_then(|party_id| self.parties.get(&party_id))
        {
            if party.leader_id != id {
                return Err("party_not_leader".to_owned());
            }
            if party.members.contains(&target) {
                return Err("party_already".to_owned());
            }
            if party.members.len() >= PARTY_MAX_MEMBERS {
                return Err("party_full".to_owned());
            }
        }
        if self.party_id_of(&target).is_some() {
            return Err("party_already".to_owned());
        }
        Ok(target)
    }

    fn create_party(&mut self, leader_id: &str) -> String {
        let id = format!("party-{}", self.next_party_id());
        self.parties.insert(
            id.clone(),
            Party {
                id: id.clone(),
                leader_id: leader_id.to_owned(),
                members: vec![leader_id.to_owned()],
            },
        );
        self.push_party_state(&[leader_id.to_owned()]);
        id
    }

    /// Drop one member and hand leadership on when the leader is the one
    /// leaving.  Returns every character whose party view changed.
    fn remove_from_party(&mut self, id: &str) -> Vec<String> {
        let Some(party_id) = self.party_id_of(id) else {
            return vec![id.to_owned()];
        };
        let mut affected = vec![id.to_owned()];
        let mut disbanded = false;
        if let Some(party) = self.parties.get_mut(&party_id) {
            party.members.retain(|member| member != id);
            affected.extend(party.members.iter().cloned());
            if party.members.len() < 2 {
                disbanded = true;
            } else if party.leader_id == id {
                party.leader_id = party.members.first().cloned().unwrap_or_default();
            }
        }
        if disbanded {
            self.parties.remove(&party_id);
            // An invitation into a party that no longer exists cannot be
            // accepted, so it is dropped instead of failing later.
            self.party_invites
                .retain(|_, invite| invite.party_id != party_id);
        }
        affected
    }

    /// Invite one character.  When the inviter has no party yet, the first
    /// invitation creates it — that is what the authored `BtCreate` button
    /// stands for in the original window.
    fn handle_party_invite(&mut self, id: String, request_id: String, player_name: String) {
        if !self.players.contains_key(&id) {
            return;
        }
        if let Some((success, code)) = self.replayed_party_request(&id, &request_id) {
            self.send_party_result(&id, &request_id, success, &code);
            return;
        }
        let target = match self.party_invite_target(&id, &player_name) {
            Ok(target) => target,
            Err(code) => {
                self.remember_party_request(&id, &request_id, false, &code);
                self.send_party_result(&id, &request_id, false, &code);
                return;
            }
        };
        let party_id = self
            .party_id_of(&id)
            .unwrap_or_else(|| self.create_party(&id));
        let invitation_id = format!("party-invite-{}", self.next_party_id());
        let inviter_name = self
            .players
            .get(&id)
            .map(|player| player.state.username.clone())
            .unwrap_or_default();
        self.party_invites.insert(
            target.clone(),
            PartyInvite {
                inviter_id: id.clone(),
                party_id,
            },
        );
        self.remember_party_request(&id, &request_id, true, "");
        self.send_party_result(&id, &request_id, true, "");
        if let Some(player) = self.players.get(&target) {
            let message = serde_json::json!({
                "type":"partyInvite",
                "invitationId":invitation_id,
                "fromId":id,
                "fromName":inviter_name,
            })
            .to_string();
            let _ = player.output.try_send(message);
        }
    }

    /// Accept or decline the pending invitation.
    fn handle_party_respond(&mut self, id: String, request_id: String, accept: bool) {
        if !self.players.contains_key(&id) {
            return;
        }
        if let Some((success, code)) = self.replayed_party_request(&id, &request_id) {
            self.send_party_result(&id, &request_id, success, &code);
            return;
        }
        let Some(invite) = self.party_invites.remove(&id) else {
            self.remember_party_request(&id, &request_id, false, "party_no_invite");
            self.send_party_result(&id, &request_id, false, "party_no_invite");
            return;
        };
        if !accept {
            // Declining closes the "create, then invite" window immediately:
            // the party only existed for this invitation.  Prune now instead of
            // waiting for the next tick so the inviter's window cannot linger.
            self.step_parties();
            // The inviter is told as well, so its window does not sit waiting
            // on an answer that will never come.
            self.send_party_notice(&invite.inviter_id, "party_declined", &id);
            self.remember_party_request(&id, &request_id, false, "party_declined");
            self.send_party_result(&id, &request_id, false, "party_declined");
            return;
        }
        // Every fact is re-checked at answer time: the party may have been
        // disbanded, filled by someone else, or the inviter may have left
        // while the invitation was pending.
        let joinable = self.parties.get(&invite.party_id).is_some_and(|party| {
            party.members.len() < PARTY_MAX_MEMBERS
                && !party.members.contains(&id)
                && self.players.contains_key(&invite.inviter_id)
        }) && self.party_id_of(&id).is_none();
        if !joinable {
            let code = "party_unavailable";
            self.remember_party_request(&id, &request_id, false, code);
            self.send_party_result(&id, &request_id, false, code);
            return;
        }
        let mut affected = vec![id.clone()];
        if let Some(party) = self.parties.get_mut(&invite.party_id) {
            party.members.push(id.clone());
            affected.extend(party.members.iter().cloned());
        }
        self.remember_party_request(&id, &request_id, true, "");
        self.send_party_result(&id, &request_id, true, "");
        affected.sort();
        affected.dedup();
        self.push_party_state(&affected);
    }

    fn handle_party_leave(&mut self, id: String, request_id: String) {
        if !self.players.contains_key(&id) {
            return;
        }
        if let Some((success, code)) = self.replayed_party_request(&id, &request_id) {
            self.send_party_result(&id, &request_id, success, &code);
            return;
        }
        if self.party_id_of(&id).is_none() {
            let code = "party_not_member";
            self.remember_party_request(&id, &request_id, false, code);
            self.send_party_result(&id, &request_id, false, code);
            return;
        }
        let mut affected = self.remove_from_party(&id);
        self.remember_party_request(&id, &request_id, true, "");
        self.send_party_result(&id, &request_id, true, "");
        affected.sort();
        affected.dedup();
        self.push_party_state(&affected);
    }

    /// Remove one member.  Only the leader may, and only from its own party.
    fn handle_party_kick(&mut self, id: String, request_id: String, player_id: String) {
        if !self.players.contains_key(&id) {
            return;
        }
        if let Some((success, code)) = self.replayed_party_request(&id, &request_id) {
            self.send_party_result(&id, &request_id, success, &code);
            return;
        }
        let code = self.party_leader_action_code(&id, &player_id);
        if let Some(code) = code {
            self.remember_party_request(&id, &request_id, false, &code);
            self.send_party_result(&id, &request_id, false, &code);
            return;
        }
        let mut affected = self.remove_from_party(&player_id);
        self.send_party_notice(&player_id, "party_kicked", &id);
        self.remember_party_request(&id, &request_id, true, "");
        self.send_party_result(&id, &request_id, true, "");
        affected.sort();
        affected.dedup();
        self.push_party_state(&affected);
    }

    /// Hand leadership to another member of the same party.
    fn handle_party_leader(&mut self, id: String, request_id: String, player_id: String) {
        if !self.players.contains_key(&id) {
            return;
        }
        if let Some((success, code)) = self.replayed_party_request(&id, &request_id) {
            self.send_party_result(&id, &request_id, success, &code);
            return;
        }
        let code = self.party_leader_action_code(&id, &player_id);
        if let Some(code) = code {
            self.remember_party_request(&id, &request_id, false, &code);
            self.send_party_result(&id, &request_id, false, &code);
            return;
        }
        let party_id = self.party_id_of(&id).unwrap_or_default();
        let mut affected = vec![player_id.clone()];
        if let Some(party) = self.parties.get_mut(&party_id) {
            party.leader_id = player_id.clone();
            affected.extend(party.members.iter().cloned());
        }
        self.remember_party_request(&id, &request_id, true, "");
        self.send_party_result(&id, &request_id, true, "");
        affected.sort();
        affected.dedup();
        self.push_party_state(&affected);
    }

    /// Shared guards for the two leader-only actions: the actor must be in a
    /// party and be its leader, and the target must be another member of it.
    fn party_leader_action_code(&self, id: &str, player_id: &str) -> Option<&'static str> {
        if player_id == id {
            return Some("party_self");
        }
        let party = self
            .party_id_of(id)
            .and_then(|party_id| self.parties.get(&party_id))?;
        if party.leader_id != id {
            return Some("party_not_leader");
        }
        if !party.members.iter().any(|member| member == player_id) {
            return Some("party_not_party_member");
        }
        None
    }

    /// Prune membership every tick so no removal site has to know about
    /// parties: a character that left the world simply stops being a member,
    /// leadership moves on, and a party with one member stops existing.
    fn step_parties(&mut self) {
        let mut affected: Vec<String> = Vec::new();
        let mut dissolved: Vec<String> = Vec::new();
        for (party_id, party) in self.parties.iter_mut() {
            let before = party.members.len();
            party
                .members
                .retain(|member| self.players.contains_key(member));
            if party.members.len() != before {
                affected.extend(party.members.iter().cloned());
            }
            if !party
                .members
                .iter()
                .any(|member| *member == party.leader_id)
            {
                if let Some(next) = party.members.first().cloned() {
                    party.leader_id = next;
                    affected.extend(party.members.iter().cloned());
                }
            }
            if party.members.len() < 2 {
                // A party of one is only meaningful while an invitation it
                // just sent is still pending — that is the "create, then
                // invite" window.  Once the answer arrives (or the inviter is
                // gone) the roster has nothing left to hold together.
                let pending = self
                    .party_invites
                    .values()
                    .any(|invite| invite.party_id == *party_id);
                if party.members.is_empty() || !pending {
                    dissolved.push(party_id.clone());
                    affected.extend(party.members.iter().cloned());
                }
            }
        }
        for party_id in &dissolved {
            self.parties.remove(party_id);
        }
        if !dissolved.is_empty() {
            self.party_invites
                .retain(|_, invite| !dissolved.contains(&invite.party_id));
        }
        // An invitation is meaningless once either side is gone.
        let stale: Vec<String> = self
            .party_invites
            .iter()
            .filter(|(invitee, invite)| {
                !self.players.contains_key(*invitee)
                    || !self.players.contains_key(&invite.inviter_id)
            })
            .map(|(invitee, _)| invitee.clone())
            .collect();
        for invitee in stale {
            self.party_invites.remove(&invitee);
        }
        if affected.is_empty() {
            return;
        }
        affected.sort();
        affected.dedup();
        self.push_party_state(&affected);
    }

    // ---------------------------------------------------------------- friends
    //
    // A friend row is the opposite of a party: it is an account fact, so it
    // survives a restart and every transition is written to SQLite by
    // `auth::friend_edit`.  What the world owns is the half that cannot be
    // persisted — whether a listed character is in the world right now and
    // which map it is on — plus the enforcement that turns a blacklist row
    // into silence.  The client only ever says "add this name", "remove this
    // row", "block this name" or "unblock this row"; the caps, the symmetry of
    // the relation and the actual membership are all decided here and in
    // auth.

    /// Persisted friend and blacklist rows for one account.  An absent store
    /// (test worlds) simply yields two empty lists, which is the honest answer
    /// for a world that has no accounts.
    fn friend_rows(&self, id: &str) -> (Vec<auth::FriendRow>, Vec<auth::FriendRow>) {
        let Some(store) = self.store.as_ref() else {
            return (Vec::new(), Vec::new());
        };
        (
            store.load_friends(id).unwrap_or_default(),
            store.load_blacklist(id).unwrap_or_default(),
        )
    }

    /// Rebuild `friend_links[id]` from the persisted rows, and register `id`
    /// on every row it points at.  Because `Add` writes the pair in both
    /// directions, one pass gives both halves of the reverse index.
    fn refresh_friend_links(&mut self, id: &str) {
        let friends: Vec<String> = self
            .friend_rows(id)
            .0
            .into_iter()
            .map(|row| row.id)
            .collect();
        for friend in &friends {
            self.friend_links
                .entry(friend.clone())
                .or_default()
                .insert(id.to_owned());
        }
        self.friend_links
            .insert(id.to_owned(), friends.into_iter().collect());
    }

    /// Re-read the blacklist into the Player row that the chat fan-out uses.
    fn reload_blocked(&mut self, id: &str) {
        let blocked: BTreeSet<String> = self
            .friend_rows(id)
            .1
            .into_iter()
            .map(|row| row.id)
            .collect();
        if let Some(player) = self.players.get_mut(id) {
            player.blocked = blocked;
        }
    }

    /// Authoritative view of one character's friend & blacklist window.  The
    /// persisted half (id, name, level, job) comes from SQLite; `online` and
    /// `mapId` are derived from the live world on every push, so a stale
    /// offline snapshot can never be presented as a live location.
    fn friend_view(&self, id: &str) -> serde_json::Value {
        let (friends, blocked) = self.friend_rows(id);
        let render = |rows: Vec<auth::FriendRow>| -> Vec<serde_json::Value> {
            rows.into_iter()
                .map(|row| {
                    let online = self.players.get(&row.id);
                    serde_json::json!({
                        "id": row.id,
                        "name": row.name,
                        "level": row.level,
                        "job": row.job,
                        "online": online.is_some(),
                        "mapId": online.map(|player| player.map_id.clone()).unwrap_or_default(),
                    })
                })
                .collect()
        };
        serde_json::json!({
            "type": "friendState",
            "friends": render(friends),
            "blocked": render(blocked),
        })
    }

    /// Push one character's window.  A detached character has no socket to
    /// write to, so its view is simply rebuilt on the next open.
    fn push_friend_state(&self, id: &str) {
        let Some(player) = self.players.get(id).filter(|player| !player.detached) else {
            return;
        };
        let message = self.friend_view(id).to_string();
        let _ = player.output.try_send(message);
    }

    /// Refresh this character's window and the window of everybody who lists
    /// it.  `friend_links` holds both directions of the relation, so one hop
    /// covers every observer.
    fn push_friend_state_to_watchers(&self, id: &str) {
        let mut targets: Vec<String> = vec![id.to_owned()];
        if let Some(links) = self.friend_links.get(id) {
            targets.extend(links.iter().cloned());
        }
        targets.sort();
        targets.dedup();
        for target in targets {
            self.push_friend_state(&target);
        }
    }

    fn send_friend_result(&self, id: &str, request_id: &str, success: bool, code: &str) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let message = serde_json::json!({
            "type":"friendResult",
            "requestId":request_id,
            "success":success,
            "code":code,
        })
        .to_string();
        let _ = player.output.try_send(message);
    }

    /// Bounded request-id idempotency for friend intents: a retried add or
    /// block replays the recorded outcome instead of acting a second time.
    fn remember_friend_request(&mut self, id: &str, outcome: &auth::FriendOutcome) {
        if self.friend_requests.len() >= FRIEND_REQUEST_WINDOW * self.players.len().max(1) {
            self.friend_requests
                .retain(|(player_id, _), _| self.players.contains_key(player_id));
        }
        self.friend_requests
            .insert((id.to_owned(), outcome.request_id.clone()), outcome.clone());
    }

    fn replayed_friend_request(&self, id: &str, request_id: &str) -> Option<auth::FriendOutcome> {
        self.friend_requests
            .get(&(id.to_owned(), request_id.to_owned()))
            .cloned()
    }

    /// Record and report a refusal that never reached SQLite, so the same
    /// request id cannot be retried into a different answer.
    fn friend_reject(
        &mut self,
        id: &str,
        request_id: &str,
        operation: auth::FriendOperation,
        code: &str,
    ) {
        let outcome = auth::FriendOutcome {
            request_id: request_id.to_owned(),
            operation,
            target_id: String::new(),
            success: false,
            code: code.to_owned(),
        };
        self.remember_friend_request(id, &outcome);
        self.send_friend_result(id, request_id, false, code);
    }

    /// Open (or refresh) the window.  Nothing is mutated: the answer is
    /// whatever the account already has, plus the live online flags.
    fn handle_friend_open(&mut self, id: String, request_id: String) {
        if !self.players.contains_key(&id) {
            return;
        }
        self.refresh_friend_links(&id);
        self.send_friend_result(&id, &request_id, true, "");
        self.push_friend_state(&id);
    }

    /// Resolve a typed name, then run the edit.  Names come from the source
    /// context menu, which carries no id; the resolution happens here so a
    /// client cannot hand the server an id it guessed.
    fn handle_friend_by_name(
        &mut self,
        id: String,
        request_id: String,
        operation: auth::FriendOperation,
        player_name: String,
    ) {
        if !self.players.contains_key(&id) {
            return;
        }
        if let Some(outcome) = self.replayed_friend_request(&id, &request_id) {
            self.send_friend_result(&id, &request_id, outcome.success, &outcome.code);
            return;
        }
        let target = match self.resolve_friend_name(&player_name) {
            Some(target) => target,
            None => {
                self.friend_reject(&id, &request_id, operation, "friend_unknown_player");
                return;
            }
        };
        self.apply_friend_edit(id, request_id, operation, target);
    }

    /// Look a typed character name up in the account store.  Exact match
    /// first, case-insensitive as a fallback, so a name typed with the wrong
    /// capitalisation still reaches its owner without the client ever being
    /// able to claim an identity.
    fn resolve_friend_name(&self, player_name: &str) -> Option<String> {
        let store = self.store.as_ref()?;
        let needle = player_name.trim();
        store
            .find_character_by_name(needle)
            .ok()
            .flatten()
            .map(|row| row.id)
            .or_else(|| {
                let players = self
                    .players
                    .iter()
                    .find(|(_, player)| player.state.username.eq_ignore_ascii_case(needle))
                    .map(|(id, _)| id.clone());
                players
            })
    }

    /// One authoritative friend / blacklist transaction.  Every guard lives in
    /// `auth::friend_edit`, which also persists the outcome so a replayed
    /// request id survives a restart; this layer only resolves the target and
    /// re-publishes what changed.
    fn apply_friend_edit(
        &mut self,
        id: String,
        request_id: String,
        operation: auth::FriendOperation,
        target_id: String,
    ) {
        if !self.players.contains_key(&id) {
            return;
        }
        if let Some(outcome) = self.replayed_friend_request(&id, &request_id) {
            self.send_friend_result(&id, &request_id, outcome.success, &outcome.code);
            return;
        }
        let Some(store) = self.store.clone() else {
            self.friend_reject(&id, &request_id, operation, "persistence");
            return;
        };
        match store.friend_edit(&id, &request_id, operation, &target_id) {
            Ok(outcome) => {
                let success = outcome.success;
                let code = outcome.code.clone();
                self.remember_friend_request(&id, &outcome);
                self.send_friend_result(&id, &request_id, success, &code);
                if !success {
                    return;
                }
                // Membership or the blacklist changed, so both sides of the
                // relation and the cached block set have to be rebuilt
                // before the windows are re-published.
                self.reload_blocked(&id);
                self.refresh_friend_links(&id);
                self.refresh_friend_links(&target_id);
                self.push_friend_state(&id);
                self.push_friend_state(&target_id);
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

    /// Notice that a character entered or left the world and refresh the
    /// friend windows that show it.  The roster is compared as a whole so the
    /// pass costs one allocation on the overwhelming majority of ticks and
    /// nothing at all when nobody joined or left.
    fn step_friends(&mut self) {
        let roster: Vec<String> = self.players.keys().cloned().collect();
        if roster == self.friend_roster {
            return;
        }
        let mut changed: BTreeSet<String> = roster.iter().cloned().collect();
        for id in &self.friend_roster {
            changed.insert(id.clone());
        }
        self.friend_roster = roster;
        for id in changed {
            self.push_friend_state_to_watchers(&id);
        }
    }

    /// Reload the character-owned rows a storage transfer can change.  Only
    /// the inventory moves here; the warehouse itself was just written.
    fn reload_storage_side_effects(&mut self, id: &str, store: &auth::Store) {
        let defaults = self.default_profile();
        let Ok(profile) = store.load_profile(id, &defaults) else {
            return;
        };
        if let Some(player) = self.players.get_mut(id) {
            player.state.inventory = profile.inventory;
        }
    }

    /// Record and send one transfer outcome.  Refusals are routed through the
    /// same path as successes so the client always gets a single, authoritative
    /// answer to the request it sent.
    fn send_storage_transfer_result(
        &mut self,
        id: &str,
        request_id: &str,
        npc_id: &str,
        outcome: &auth::StorageOutcome,
    ) {
        self.send_storage_result(
            id,
            request_id,
            outcome.success,
            &outcome.code,
            npc_id,
            outcome.inventory_type,
            outcome.slot,
            outcome.quantity,
        );
    }

    fn send_storage_result(
        &self,
        id: &str,
        request_id: &str,
        success: bool,
        code: &str,
        npc_id: &str,
        inventory_type: u8,
        slot: i16,
        quantity: u32,
    ) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let message = serde_json::json!({
            "type":"storageResult",
            "requestId":request_id,
            "success":success,
            "code":code,
            "npcId":npc_id,
            "inventoryType":inventory_type,
            "slot":slot,
            "quantity":quantity,
        })
        .to_string();
        let _ = player.output.try_send(message);
    }

    /// Push the owner a full warehouse view.  `npc_id` is `None` when the
    /// session just closed, which tells the client to dismiss the window.
    fn send_storage_state(&self, id: &str, npc_id: Option<&str>) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let Some(npc_id) = npc_id else {
            let _ = player
                .output
                .try_send(serde_json::json!({"type":"storageState","closed":true}).to_string());
            return;
        };
        let Some(store) = self.store.as_ref() else {
            return;
        };
        let state = StorageState {
            items: store.load_storage(id).unwrap_or_default(),
            mesos: store.storage_mesos_balance(id).unwrap_or(0),
            slot_limit: auth::STORAGE_SLOT_LIMIT,
            npc_id: npc_id.to_owned(),
        };
        let mut message = serde_json::to_value(&state).unwrap_or_default();
        if let Some(object) = message.as_object_mut() {
            object.insert("type".into(), serde_json::Value::from("storageState"));
        }
        let _ = player.output.try_send(message.to_string());
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
        // Drop consumable cooldowns that have expired so the per-player map
        // cannot grow without bound over a long session, and mirror what is
        // left onto the wire state for the client to render.
        self.expire_potion_cooldowns();
        // Left-over membership is pruned from the authoritative player map, so
        // a logout, a transport loss or an expired away window all end a
        // membership through the same single path.
        self.step_parties();
        // A login or a logout is the only thing that can change a friend
        // window without a client intent, so the online flags are refreshed
        // from the roster rather than pushed on a timer.
        self.step_friends();
        // Derive every away stage from the current time before simulating, so
        // no branch below can act on a stage that has already expired.
        self.advance_away_windows();
        let ids: Vec<String> = self.players.keys().cloned().collect();
        for id in ids {
            self.apply_beginner_heal_tick(&id);
            self.step_infinity_tick(&id);
            self.step_natural_recovery(&id);
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
            player.adaptation_cooldown_ms = player.adaptation_cooldown_ms.saturating_sub(TICK_MS);
            player.skill_cooldowns.retain(|_, remaining| {
                *remaining = remaining.saturating_sub(TICK_MS);
                *remaining > 0
            });
            for remaining in player.skill_buffs.values_mut() {
                *remaining = remaining.saturating_sub(TICK_MS);
            }
            if player
                .skill_buffs
                .get(&SKILL_RECOVERY)
                .copied()
                .is_some_and(|remaining| remaining == 0)
            {
                player.skill_buffs.remove(&SKILL_RECOVERY);
                player.beginner_heal_next_tick = 0;
                player.beginner_heal_remaining_ticks = 0;
                player.beginner_heal_per_tick = 0;
            }
            if player
                .skill_buffs
                .get(&SKILL_NIMBLE_FEET)
                .copied()
                .is_some_and(|remaining| remaining == 0)
            {
                player.skill_buffs.remove(&SKILL_NIMBLE_FEET);
                player.beginner_speed_percent = 0;
            }
            if player
                .skill_buffs
                .get(&SKILL_INFINITY)
                .copied()
                .is_some_and(|remaining| remaining == 0)
            {
                player.skill_buffs.remove(&SKILL_INFINITY);
                player.infinity_next_tick = 0;
                player.infinity_damage_bonus = 0;
            }
            if player
                .skill_buffs
                .get(&SKILL_MAPLE_WARRIOR)
                .copied()
                .is_some_and(|remaining| remaining == 0)
            {
                player.skill_buffs.remove(&SKILL_MAPLE_WARRIOR);
            }
            if player
                .skill_buffs
                .get(&SKILL_MAPLE_CURE)
                .copied()
                .is_some_and(|remaining| remaining == 0)
            {
                player.skill_buffs.remove(&SKILL_MAPLE_CURE);
                player.status_immune_until = 0;
            }
            if player
                .skill_buffs
                .get(&SKILL_HYPER_ADVENTURER)
                .copied()
                .is_some_and(|remaining| remaining == 0)
            {
                player.skill_buffs.remove(&SKILL_HYPER_ADVENTURER);
            }
            if player.channel_request_id.is_some()
                && player.channel_skill_id.is_some()
                && player.channel_skill_id != Some(SKILL_HYPER_THUNDER)
                && player.channel_until > 0
                && player.channel_until <= self.tick
            {
                player.channel_request_id = None;
                player.channel_skill_id = None;
                player.channel_until = 0;
                player.channel_level = 0;
                player.skill_buffs.remove(&SKILL_ICE_DRAGON_BREATH);
                if player.state.action == "attack" {
                    player.state.action = "stand";
                    player.state.action_started_tick = self.tick;
                    player.attack_until = self.tick;
                }
            }
            if player.mystic_strike_until <= self.tick {
                player.mystic_strike_stacks = 0;
                player.mystic_strike_until = 0;
            }
            // ---- Monster abnormal-status ticking (poison/curse DoT + expiry) ----
            // Poison and curse tick damage on their own cadence; the deadlines
            // are cleared once expired so a dead status never re-arms itself.
            // DoT is applied directly to `state.hp` (not `commit_incoming_damage`)
            // because poison bypasses weapon-defense/shield/guard layers; the
            // death transition itself is handled by the normal tick path.
            if player.poison_until > self.tick && player.poison_next_tick <= self.tick {
                player.poison_next_tick = self.tick.saturating_add(
                    (MOB_DISEASE_POISON_TICK_MS / TICK_MS).max(1),
                );
                player.state.hp = player.state.hp.saturating_sub(1).max(0);
            } else if player.poison_until != 0 && player.poison_until <= self.tick {
                player.poison_until = 0;
                player.poison_next_tick = 0;
            }
            if player.curse_until > self.tick && player.curse_next_tick <= self.tick {
                // Curse lowers effective EXP/ATK rather than dealing a large
                // DoT; model it as a light periodic drain like the original's
                // "every interval lose a little" behavior (P adapter).
                player.curse_next_tick = self
                    .tick
                    .saturating_add((MOB_DISEASE_POISON_TICK_MS / TICK_MS).max(1));
            } else if player.curse_until != 0 && player.curse_until <= self.tick {
                player.curse_until = 0;
                player.curse_next_tick = 0;
            }
            for deadline in [&mut player.seal_until, &mut player.stun_until, &mut player.slow_until]
            {
                if *deadline != 0 && *deadline <= self.tick {
                    *deadline = 0;
                }
            }
            if player.meditation_until <= self.tick {
                player.meditation_until = 0;
                player.meditation_mad = 0;
            }
            let meditation_remaining_ms = if player.meditation_until > self.tick {
                Some((player.meditation_until - self.tick).saturating_mul(TICK_MS))
            } else {
                None
            };
            let (derived_stats, derived_max_mp) = compute_derived_stats(
                &self.gameplay,
                &self.mage_skills,
                player.state.job,
                player.base_max_mp,
                player.state.level,
                &player.state.skills,
                &player.state.ability_stats,
                &player.state.equipped,
                player.magic_guard,
                player.meditation_mad,
                meditation_remaining_ms,
                player.ice_teleport_enabled,
                player.teleport_mastery_enabled,
                player.teleport_boost_enabled,
                hyper_barrier_active(player),
                player.hyper_teleport_enabled,
                if player.adaptation_active {
                    player.adaptation_charges
                } else {
                    0
                },
                (player.adaptation_cooldown_ms > 0).then_some(player.adaptation_cooldown_ms),
                player.beginner_speed_percent,
                &player.skill_cooldowns,
                &player.skill_buffs,
            );
            let derived = self.gameplay.player.with_ability_stats(
                &player.state.ability_stats,
                &player.state.equipped,
                player.state.job,
            );
            player.state.max_hp = derived.max_hp.unwrap_or(1);
            player.state.max_mp = derived_max_mp;
            player.state.derived_stats = derived_stats.clone();
            player.move_speed = derived_stats.move_speed;
            player.state.hp = player.state.hp.min(player.state.max_hp);
            player.state.mp = player.state.mp.min(player.state.max_mp);
            let old_x = player.state.x;
            let old_y = player.state.y;
            step_player(&map, &self.gameplay, player, self.tick);
            // Mirror the authoritative swim flag into the snapshot so clients
            // can tell "swimming" (never grounded) apart from "airborne".
            player.state.swimming = player.swimming;
            if player.state.grounded {
                player.magic_wave_used = false;
                player.magic_wave_float_used = false;
                player.slow_fall_until = 0;
            } else if player.swimming {
                // Leaving the water counts as landing for the one-use wave
                // flags.  A swimming body is never `grounded`, so grounding was
                // the only reset path and `magic_wave_float_used` latched
                // forever: the first float worked, then every later press was
                // rejected with `skill_cooldown` and the mage could not act.
                player.magic_wave_used = false;
                player.magic_wave_float_used = false;
                player.slow_fall_until = 0;
            }
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
            self.step_area_reactor_interactions(&id);
        }
        self.step_hyper_channels();
        self.step_hyper_effects();
        self.resolve_pending_attacks();
        self.step_reactors();
        self.step_boss_practice();
        self.step_monsters();
        self.step_ice_fields();
        self.step_summons();
        self.apply_contact_damage();
        self.respawn_monsters();
        // Full retention for residents: they keep being simulated and stay in
        // every observer's snapshot, but nothing is pushed to a dead channel.
        // A full queue only drops this tick's snapshot, it never deletes the
        // character, so a slow or frozen client cannot lose its role.
        let failed: Vec<_> = self
            .players
            .iter()
            .filter(|(_, p)| !p.detached)
            .filter_map(|(id, p)| match p.output.try_send(self.snapshot(id)) {
                Err(TrySendError::Closed(_)) => Some(id.clone()),
                Err(TrySendError::Full(_)) | Ok(()) => None,
            })
            .collect();
        for id in failed {
            self.disconnect_boss_player(&id);
            self.players.remove(&id);
            self.end_conversation(&id);
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
        store.save_profile(
            id,
            &profile_from_state(
                &player.state,
                &player.map_id,
                &player.death_id,
                player.base_max_mp,
            ),
        )
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
            let quests = player.quests.clone();
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
                        max_mp: 0,
                        boss: false,
                        pa_damage: None,
                        pd_damage: None,
                        pd_rate: None,
                        md_rate: None,
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
                        skills: Vec::new(),
                        body_disease: None,
                        body_disease_level: None,
                    },
                    player.state.x,
                    player.state.y,
                ));
            let mut target_template = target_template;
            if let Some(target_id) = target_id.as_ref() {
                let bind_pdr = self
                    .monsters
                    .get(target_id)
                    .filter(|monster| monster.bind_until > self.tick)
                    .map(|monster| monster.bind_pd_rate_reduction)
                    .unwrap_or(0)
                    .clamp(0, 100) as f64;
                if bind_pdr > 0.0 {
                    if let Some(rate) = target_template.pd_rate.as_mut() {
                        *rate = (*rate - bind_pdr).max(0.0);
                    }
                }
            }
            let mut damage = self
                .gameplay
                .player
                .with_ability_stats(
                    &player.state.ability_stats,
                    &player.state.equipped,
                    player.state.job,
                )
                .attack_damage_against(player.state.level, &target_template);
            if player
                .skill_buffs
                .get(&SKILL_INFINITY)
                .copied()
                .is_some_and(|remaining| remaining > 0)
            {
                damage = (damage as f64 * (100 + player.infinity_damage_bonus.max(0)) as f64
                    / 100.0)
                    .floor()
                    .max(1.0) as i64;
            }
            if let Some(level) = player
                .state
                .skills
                .get(&SKILL_MYSTIC_STRIKE)
                .copied()
                .and_then(|level| self.mage_skills.level(SKILL_MYSTIC_STRIKE, level))
            {
                let bonus = level
                    .x
                    .unwrap_or(0)
                    .max(0)
                    .saturating_mul(i64::from(player.mystic_strike_stacks));
                if bonus > 0 {
                    damage = (damage as f64 * (100 + bonus) as f64 / 100.0)
                        .floor()
                        .max(1.0) as i64;
                }
            }
            let hyper_adventurer_bonus = if player
                .skill_buffs
                .get(&SKILL_HYPER_ADVENTURER)
                .copied()
                .is_some_and(|remaining| remaining > 0)
            {
                player
                    .state
                    .skills
                    .get(&SKILL_HYPER_ADVENTURER)
                    .copied()
                    .and_then(|skill_level| {
                        self.mage_skills.level(SKILL_HYPER_ADVENTURER, skill_level)
                    })
                    .and_then(|level| level.indie_dam_r)
                    .unwrap_or(10)
                    .clamp(0, 100)
            } else {
                0
            };
            if hyper_adventurer_bonus > 0 {
                damage = (damage as f64 * (100 + hyper_adventurer_bonus) as f64 / 100.0)
                    .floor()
                    .max(1.0) as i64;
            }
            let guard_percent = self.boss_damage_multiplier(&map_id, false);
            damage = (damage as i128 * i128::from(guard_percent) / 100).max(1) as i64;
            let killed = target_id.is_some() && target_hp > 0 && damage >= target_hp;
            let applied_damage = target_id
                .is_some()
                .then_some(damage.min(target_hp.max(0)))
                .unwrap_or(0);
            let practice = auth::is_practice_map(&map_id);
            let drops = if killed && !practice {
                self.choose_drops(
                    &target_template,
                    target_x,
                    target_y,
                    &attack.player_id,
                    &quests,
                )
            } else {
                Vec::new()
            };
            let eligible_accounts: Vec<String> = self.players.keys().cloned().collect();
            let resolution = match self.store.as_ref() {
                Some(store) => store.resolve_attack_with_party(
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
                    &self.party_exp_members(&attack.player_id),
                ),
                None => Ok(auth::AttackResolution {
                    already_resolved: false,
                    target_id: target_id.clone(),
                    damage: applied_damage,
                    killed,
                    exp_gain: if killed && !practice {
                        target_template.exp
                    } else {
                        0
                    },
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
            if resolution.damage > 0 {
                if let Some(target_id) = resolution.target_id.as_deref() {
                    self.advance_mystic_strike(&attack.player_id, &attack.request_id, target_id);
                }
            }
            if let Some(target_id) = resolution.target_id.as_deref() {
                if let Some(monster) = self.monsters.get_mut(target_id) {
                    if resolution.damage > 0 {
                        let contribution = monster
                            .damage_by_player
                            .entry(attack.player_id.clone())
                            .or_default();
                        *contribution = contribution.saturating_add(resolution.damage);
                        // A direct normal attack marks its author as hostile;
                        // see `step_monsters` for the pursuit resolution.
                        mark_monster_hit_aggro(monster, &attack.player_id, self.tick);
                    }
                    monster.state.hp = (monster.state.hp - resolution.damage).max(0);
                    monster.state.action = if monster.state.hp == 0 { "die" } else { "hit" };
                    monster.state.action_started_tick = self.tick;
                    if monster.state.hp == 0 {
                        monster.freeze_until = 0;
                        monster.state.freeze_stacks = None;
                        monster.stun_until = 0;
                        let die_ticks = monster
                            .template
                            .die_duration_ms
                            .unwrap_or(1)
                            .div_ceil(TICK_MS)
                            .max(1);
                        monster.death_until = Some(self.tick + die_ticks);
                        monster.respawn_at = respawn_deadline(
                            self.tick,
                            self.gameplay.monster_respawn_ms,
                            monster.spawn.mob_time,
                        );
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
            if resolution.damage > 0 {
                if let Some(target_id) = resolution.target_id.as_deref() {
                    // A normal player attack is also a non-summon direct hit.
                    // The passive helper rechecks the live target and learned
                    // Blizzard level, so a lethal hit cannot proc on a dead mob
                    // and a replay cannot create a second hidden attack.
                    if let Err(error) = self.maybe_cast_blizzard_follow_up(
                        &attack.player_id,
                        &attack.request_id,
                        target_id,
                    ) {
                        self.handle_accepted_effect_error(
                            &attack.player_id,
                            &attack.request_id,
                            &error,
                        );
                    }
                }
            }
            if !resolution.profiles.is_empty() {
                for (participant, profile) in resolution.profiles {
                    if let Some(player) = self.players.get_mut(&participant) {
                        apply_profile_to_player(&self.gameplay, &self.mage_skills, player, profile);
                    }
                }
            } else if let Some(profile) = resolution.profile {
                if let Some(player) = self.players.get_mut(&attack.player_id) {
                    apply_profile_to_player(&self.gameplay, &self.mage_skills, player, profile);
                }
            } else if resolution.exp_gain > 0 && self.store.is_none() {
                if let Some(player) = self.players.get_mut(&attack.player_id) {
                    Self::add_exp(
                        &mut player.state,
                        resolution.exp_gain,
                        &self.gameplay.exp_table,
                    );
                    refresh_player_derived(&self.gameplay, &self.mage_skills, player);
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
        quests: &BTreeMap<String, String>,
    ) -> Vec<auth::DropRecord> {
        let denominator = self.gameplay.drop_chance_denominator;
        let mut drops = Vec::new();
        for spec in template.drops() {
            let should_drop = match spec.quest_id.as_deref() {
                None => true,
                Some(quest_id) => quests.get(quest_id).is_some_and(|state| state == "active"),
            };
            if !should_drop {
                continue;
            }
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
                // P: user-authorized drop floating — pin drops that land in
                // water to just below the surface so swimmers can reach them.
                let drop_y = self.map.water_float_y(x, y);
                drops.push(auth::DropRecord {
                    id,
                    item_id: spec.item_id,
                    quantity,
                    x,
                    y: drop_y,
                    owner_id: Some(owner_id.to_owned()),
                    protected_until_ms: auth::now_ms() + auth::DROP_PROTECTION_MS,
                    ..auth::DropRecord::default()
                });
            }
        }
        drops
    }

    /// Advance one monster's authored abnormal-status skills.  A mob only
    /// casts while it has a live pursuit target; each cast advances
    /// `next_skill_tick` by the authored `interval` so it cannot spam.  Only
    /// the modelled disease-skills act (seal/stun/curse/poison/slow); buffs,
    /// heals and summons are source nodes this server leaves inert.
    ///
    /// Kept as its own method so the player-target and `inflict_disease`
    /// borrows never overlap the caller's mutable monster borrow.
    fn step_monster_skills(&mut self, id: &str, map_id: &str) {
        let Some(snapshot) = self.monsters.get(id).map(|monster| {
            (
                monster.template.clone(),
                monster.state.id.clone(),
                monster.state.x,
                monster.state.y,
                monster.aggro_target.clone(),
                monster.aggro_until,
                monster.next_skill_tick,
            )
        }) else {
            return;
        };
        let (template, monster_id, monster_x, monster_y, aggro_target, aggro_until, next_tick) =
            snapshot;
        if self.tick < next_tick {
            return;
        }
        let Some(target_id) = aggro_target.filter(|_| self.tick <= aggro_until) else {
            return;
        };
        if template.skills.is_empty() {
            return;
        }
        let Some(target) = self.players.get(&target_id).filter(|p| {
            p.map_id == map_id && p.state.action != "dead" && p.state.hp > 0
        }) else {
            return;
        };
        let target_x = target.state.x;
        let target_y = target.state.y;
        // Drop the target borrow before inflicting so `inflict_disease` can
        // take its own mutable borrow of the player map.
        let mut advanced = false;
        for skill in &template.skills {
            let Some((disease, duration_ms)) = mob_skill_disease(&template, skill) else {
                continue;
            };
            let Some(effect) = template.skill_effect(skill) else {
                continue;
            };
            // Cast chance (`prop`) and authored reach (`lt`/`rb`) gate the
            // hit.  A target outside the authored box is out of range; a
            // failed prop roll wastes the interval without inflicting.
            let in_range = match (effect.lt.as_ref(), effect.rb.as_ref()) {
                (Some(lt), Some(rb)) => {
                    let dx = target_x - monster_x;
                    let dy = target_y - monster_y;
                    dx >= lt.x && dx <= rb.x && dy >= lt.y && dy <= rb.y
                }
                _ => true,
            };
            let prop = effect.prop.unwrap_or(100).clamp(0, 100) as u64;
            let rolled = prop == 100
                || deterministic_percent(&[
                    &monster_id,
                    &target_id,
                    &skill.skill_id.to_string(),
                    &self.tick.to_string(),
                ])
                    < prop;
            if !in_range || !rolled {
                continue;
            }
            self.inflict_disease(&target_id, disease, duration_ms, &monster_id);
            advanced = true;
            // Advance the interval for the skill that fired (or was blocked)
            // so a mob cannot spam its debuff every tick.  Blocked casts still
            // spend the interval.
            let interval_ms = effect.interval.unwrap_or(10).max(0) as u64
                * 1_000;
            let next = self.tick.saturating_add((interval_ms / TICK_MS).max(1));
            if let Some(monster) = self.monsters.get_mut(id) {
                monster.next_skill_tick = next;
            }
            // Broadcast the cast so clients can play the source action and any
            // effect anchors.
            let event = serde_json::json!({
                "type": "monsterSkill",
                "eventId": format!("monster-skill-{monster_id}-{}", self.tick),
                "serverTick": self.tick,
                "monsterId": monster_id,
                "skillId": skill.skill_id,
                "action": skill.action,
                "effectAfterMs": skill.effect_after_ms,
                "targetId": target_id,
            })
            .to_string();
            self.broadcast_to_map(map_id, &event);
            // One cast per step: exit after the first skill that fired so a
            // multi-skill mob does not chain every authored node in a tick.
            break;
        }
        // If a mob has skills but none fired this step (all out of range or
        // blocked by prop), still advance the interval by the first skill's
        // cadence so it retries instead of stalling forever.
        if !advanced {
            if let (Some(skill), Some(effect)) = (
                template.skills.first(),
                template.skills.first().and_then(|s| template.skill_effect(s)),
            ) {
                let interval_ms = effect.interval.unwrap_or(10).max(0) as u64 * 1_000;
                let next = self.tick.saturating_add((interval_ms / TICK_MS).max(1));
                if let Some(monster) = self.monsters.get_mut(id) {
                    monster.next_skill_tick = next;
                }
                let _ = skill;
            }
        }
    }

    fn step_monsters(&mut self) {
        let ids: Vec<String> = self.monsters.keys().cloned().collect();
        for id in ids {
            let map_id = self
                .monsters
                .get(&id)
                .map(|monster| monster.map_id.clone())
                .unwrap_or_else(|| self.map.id.clone());
            if auth::is_practice_map(&map_id) {
                // Practice Boss timing/control is advanced by the private
                // encounter state machine.  Generic mob AI must not move or
                // clear its source attack/guard action underneath it.
                continue;
            }
            let map = self.map_for(&map_id).clone();
            // Authored abnormal-status skill casting is advanced before the
            // `get_mut` below so it never holds the monster's mutable borrow
            // while resolving the player target (a second `self` borrow).
            self.step_monster_skills(&id, &map_id);
            let Some(monster) = self.monsters.get_mut(&id) else {
                continue;
            };
            if monster.state.hp <= 0 {
                continue;
            }
            if monster.bind_until <= self.tick {
                // Armor melting ends with the bind even when its separate
                // 90-second resistance is still active.
                monster.bind_pd_rate_reduction = 0;
                monster.bind_md_rate_reduction = 0;
            }
            if monster.bind_until > self.tick {
                monster.state.action = "hit";
                monster.horizontal_speed = 0.0;
                continue;
            }
            if monster.stun_until > self.tick {
                monster.state.action = "hit";
                monster.horizontal_speed = 0.0;
                continue;
            }
            if monster.freeze_until > self.tick {
                monster.state.action = "freeze";
                monster.horizontal_speed = 0.0;
                continue;
            }
            if monster.state.freeze_stacks.is_some() {
                monster.state.freeze_stacks = None;
                monster.freeze_until = 0;
                if monster.state.action == "freeze" {
                    monster.state.action = if monster.template.can_move() {
                        "move"
                    } else {
                        "stand"
                    };
                    monster.state.action_started_tick = self.tick;
                }
            }
            let can_move = monster.template.can_move();
            // ---- Aggro / pursuit resolution (server-authoritative) ----
            // Each step a mob re-checks its target once.  A target stays
            // pursueable only while it is still alive on the same map AND
            // within the leash radius of the spawn point AND its last hit is
            // still inside the hold window; break any part and the mob forgets
            // (記恨 lost) and walks back home.  `pursuit` resolves to the
            // facing needed to close on the target or return to spawn, or
            // `None` to fall back to the idle stand/move wander below.
            let pursuit: Option<i8> = if !can_move {
                None
            } else {
                let mobile_target = monster
                    .aggro_target
                    .as_deref()
                    .filter(|_| self.tick <= monster.aggro_until)
                    .and_then(|target| self.players.get(target))
                    .filter(|player| {
                        player.map_id == monster.map_id
                            && player.state.action != "dead"
                            && player.state.hp > 0
                            && {
                                let dx = player.state.x - monster.spawn.x;
                                let dy = player.state.y - monster.spawn.y;
                                dx.hypot(dy) <= MOB_AGGRO_LEASH
                            }
                    });
                if mobile_target.is_none() && monster.aggro_target.take().is_some() {
                    // Interest broke (離脫): the walk home flips on now and a
                    // later hit can flip it back off via mark_monster_hit_aggro.
                    monster.returning_home = true;
                }
                if let Some(target) = mobile_target {
                    monster.returning_home = false;
                    Some(if monster.state.x < target.state.x { 1 } else { -1 })
                } else if monster.returning_home {
                    let dx = monster.spawn.x - monster.state.x;
                    if dx.abs() <= MOB_HOME_RADIUS {
                        // Back on the spawn point: resume idle behaviour.
                        monster.returning_home = false;
                        None
                    } else {
                        Some(if dx < 0.0 { -1 } else { 1 })
                    }
                } else {
                    None
                }
            };
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
                if let Some(direction) = pursuit {
                    // A live target / a pending return-home should not linger
                    // in idle stand: close on it immediately.
                    monster.state.action = "move";
                    monster.state.facing = direction;
                    monster.state.action_started_tick = self.tick;
                } else {
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
            }

            if monster.state.action == "move" {
                if !can_move {
                    monster.state.action = "stand";
                    monster.state.action_started_tick = self.tick;
                    monster.horizontal_speed = 0.0;
                    continue;
                }
                if let Some(direction) = pursuit {
                    // Pursuing a target or returning home: keep pressing the
                    // same direction every step, ignoring the wander timer.
                    monster.state.action = "move";
                    monster.state.facing = direction;
                    monster.state.action_started_tick = self.tick;
                } else {
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
            // Mapleweb receives a server-selected movement stance/direction.
            // During pursuit (`pursuit.is_some()`) the facing was fixed by the
            // aggro block above to walk toward the target or home; otherwise
            // the walk continues in the current authoritative facing until a
            // linked foothold wall turns it around.
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

    /// Commit incoming player damage through the same profile transaction used
    /// by contact hits and Boss practice attacks.  The runtime state is only
    /// changed after SQLite accepts the candidate, so a persistence failure
    /// cannot leave the client damaged while the profile still has old HP/MP.
    pub(super) fn commit_incoming_damage(
        &mut self,
        id: &str,
        raw_damage_after_weapon_defense: i64,
    ) -> Option<(i64, i64, bool)> {
        let Some(snapshot) = self.players.get(id).map(|player| {
            (
                player.state.clone(),
                player.death_id.clone(),
                player.base_max_mp,
                player.magic_guard,
                player.contact_invulnerable_until,
                player.channel_until,
                player.channel_skill_id,
            )
        }) else {
            return None;
        };
        if snapshot.0.action == "dead"
            || snapshot.0.hp <= 0
            || snapshot.4 > self.tick
            || (snapshot.5 > self.tick && snapshot.6 == Some(SKILL_ICE_DRAGON_BREATH))
        {
            return None;
        }
        let shield_level = snapshot
            .0
            .skills
            .get(&SKILL_MAGIC_SHIELD)
            .copied()
            .unwrap_or(0);
        let shield_bonus = self
            .mage_skills
            .level(SKILL_MAGIC_SHIELD, shield_level)
            .and_then(|level| level.pdd_x)
            .unwrap_or(0)
            .max(0);
        let barrier_percent = self
            .players
            .get(id)
            .filter(|player| hyper_barrier_active(player))
            .map(|_| 20_i64)
            .unwrap_or(0);
        let barrier_damage = (raw_damage_after_weapon_defense.max(1) as i128
            * i128::from(100_i64.saturating_sub(barrier_percent.clamp(0, 100)))
            / 100)
            .max(1) as i64;
        // Thunder's sustained channel is damageable, unlike Ice Dragon's
        // source q-window.  It halves incoming damage and keeps the channel
        // from being interrupted by contact/boss damage.
        let channel_damage = if snapshot.5 > self.tick && snapshot.6 == Some(SKILL_HYPER_THUNDER) {
            (barrier_damage as i128 * 50 / 100).max(1) as i64
        } else {
            barrier_damage
        };
        let reduced_damage = channel_damage.saturating_sub(shield_bonus).max(1);
        let guard_level = snapshot
            .0
            .skills
            .get(&SKILL_MAGIC_GUARD)
            .copied()
            .unwrap_or(0);
        let guard_ratio = if snapshot.3 {
            self.mage_skills
                .level(SKILL_MAGIC_GUARD, guard_level)
                .and_then(|level| level.x)
                .unwrap_or(0)
                .clamp(0, 100)
        } else {
            0
        };
        let mp_damage = ((reduced_damage as i128 * guard_ratio as i128 + 99) / 100)
            .clamp(0, snapshot.0.mp.max(0) as i128) as i64;
        let hp_damage = reduced_damage.saturating_sub(mp_damage).max(0);
        let mut candidate = snapshot.0.clone();
        candidate.mp = candidate.mp.saturating_sub(mp_damage).max(0);
        candidate.hp = candidate.hp.saturating_sub(hp_damage).max(0);
        let killed = candidate.hp == 0;
        let death_id = if killed {
            auth::random_id()
        } else {
            snapshot.1.clone()
        };
        if let Some(store) = self.store.as_ref() {
            let map_id = self
                .players
                .get(id)
                .map(|player| player.map_id.clone())
                .unwrap_or_default();
            let mut persisted_state = candidate.clone();
            if auth::is_practice_map(&map_id) {
                let source_map = self.map_for(BOSS_PRACTICE_FALLBACK_MAP_ID).clone();
                let mut x = candidate
                    .x
                    .clamp(source_map.bounds.x_min, source_map.bounds.x_max);
                let mut y = candidate
                    .y
                    .clamp(source_map.bounds.y_min, source_map.bounds.y_max);
                if let Some((_, ground)) = source_map.ground_near(x, y) {
                    y = ground;
                } else {
                    x = source_map.spawn.x;
                    y = source_map
                        .ground_near(x, source_map.spawn.y)
                        .map(|(_, ground)| ground)
                        .unwrap_or(source_map.spawn.y);
                }
                persisted_state.x = x;
                persisted_state.y = y;
            }
            let profile = profile_from_state(&persisted_state, &map_id, &death_id, snapshot.2);
            if let Err(error) = store.save_profile(id, &profile) {
                self.send_reject(id, "persistence", &error, None);
                return None;
            }
        }
        let Some(player) = self.players.get_mut(id) else {
            return None;
        };
        player.state = candidate;
        player.death_id = death_id;
        player.contact_invulnerable_until = self.tick
            + self
                .gameplay
                .player
                .contact_invulnerability_ms
                .unwrap_or(0)
                .div_ceil(TICK_MS)
                .max(1);
        if killed {
            player.state.action = "dead";
            player.state.action_started_tick = self.tick;
            player.state.action_id = None;
            player.swimming = false;
            player.natural_recovery_next_tick =
                self.tick.saturating_add(NATURAL_RECOVERY_INTERVAL_TICKS);
            player.state.climbing = false;
            player.state.ladder_id = None;
            player.attack_until = 0;
            player.magic_guard = false;
            clear_beginner_buffs(player);
            player.ice_teleport_enabled = false;
            player.ice_fields.clear();
            player.teleport_mastery_enabled = false;
            player.teleport_boost_enabled = false;
            player.adaptation_active = false;
            player.adaptation_charges = 0;
            player.summon = None;
            player.knockback_vx = 0.0;
            player.knockback_until = 0;
            refresh_player_derived(&self.gameplay, &self.mage_skills, player);
        } else {
            if snapshot.6 != Some(SKILL_HYPER_THUNDER) {
                player.attack_until = 0;
                player.state.action_id = None;
            }
        }
        Some((hp_damage, mp_damage, killed))
    }

    fn apply_contact_damage(&mut self) {
        let ids: Vec<String> = self.players.keys().cloned().collect();
        for id in ids {
            let Some(player) = self.players.get(&id) else {
                continue;
            };
            if player.state.action == "dead"
                || self.tick < player.contact_invulnerable_until
                || (player.channel_until > self.tick
                    && player.channel_skill_id == Some(SKILL_ICE_DRAGON_BREATH))
            {
                // Ice Dragon Breath's q-window is a sourced self-invincible
                // channel; Hyper Thunder remains damageable but halves
                // damage and resists the contact knockback below.
                continue;
            }
            let map_id = player.map_id.clone();
            if auth::is_practice_map(&map_id) {
                // The private Boss state machine owns its source attack
                // windows; generic body contact must not add a second hit.
                continue;
            }
            let hit =
                self.monsters
                    .values()
                    .filter(|monster| {
                        if monster.map_id != map_id
                            || monster.state.hp <= 0
                            || !monster.template.body_attack
                            || monster.template.pa_damage.is_none()
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
                        monster.template.pa_damage.map(|damage| {
                            (
                                monster.state.id.clone(),
                                monster.state.x,
                                damage.max(1),
                                monster.template.body_disease,
                                monster.template.body_disease_level,
                            )
                        })
                    });
            let Some((monster_id, monster_x, raw_damage, body_disease, body_disease_level)) =
                hit
            else {
                continue;
            };
            let stance_prop = self
                .players
                .get(&id)
                .and_then(|player| player.state.skills.get(&SKILL_MASTER_MAGIC))
                .copied()
                .and_then(|level| self.mage_skills.level(SKILL_MASTER_MAGIC, level))
                .and_then(|level| level.stance_prop)
                .unwrap_or(0)
                .clamp(0, 100) as u64;
            let defense = self
                .gameplay
                .player
                .with_ability_stats(
                    &player.state.ability_stats,
                    &player.state.equipped,
                    player.state.job,
                )
                .weapon_defense
                .unwrap_or(0)
                .max(0);
            let Some((hp_damage, mp_damage, killed)) =
                self.commit_incoming_damage(&id, raw_damage.saturating_sub(defense).max(1))
            else {
                continue;
            };
            if !killed {
                let Some(player) = self.players.get_mut(&id) else {
                    continue;
                };
                let hyper_thunder_channel = player.channel_until > self.tick
                    && player.channel_skill_id == Some(SKILL_HYPER_THUNDER);
                if hyper_thunder_channel {
                    // The sustained Hyper channel keeps its action and lock;
                    // the damage transaction above already applied its 50%
                    // reduction and the hit must not add a knockback hop.
                } else {
                    // Body hit: interrupt the current attack and start the
                    // knockback hop.  The body leaves its foothold with a small
                    // upward launch plus a short horizontal push away from the
                    // monster centre, both scaled by tenacity.  step_player owns
                    // the ballistic arc and stands the player again on landing;
                    // clients render the white flash from the damage event below
                    // and follow the authoritative position from snapshots.
                    player.attack_until = 0;
                    player.state.action_id = None;
                    if player.state.climbing {
                        player.state.climbing = false;
                        player.state.ladder_id = None;
                    }
                    let resists_knockback = stance_prop > 0
                        && deterministic_percent(&[
                            &id,
                            &monster_id,
                            &self.tick.to_string(),
                            "teleport-mastery-stance",
                        ]) < stance_prop;
                    if resists_knockback {
                        player.state.action = if player.state.grounded {
                            "stand"
                        } else {
                            "jump"
                        };
                        player.state.action_started_tick = self.tick;
                    } else {
                        player.state.grounded = false;
                        player.foothold_id = 0;
                        player.drop_fh = 0;
                        let away = if player.state.x >= monster_x {
                            1.0
                        } else {
                            -1.0
                        };
                        let tenacity = self
                            .gameplay
                            .player
                            .tenacity
                            .unwrap_or(0.0)
                            .clamp(0.0, TENACITY_CAP);
                        let factor = 1.0 - tenacity;
                        player.knockback_vx = away * KNOCKBACK_SPEED * factor;
                        player.knockback_until = self.tick + KNOCKBACK_TICKS;
                        player.state.vy = -KNOCKBACK_JUMP * factor;
                        player.state.action = "jump";
                        player.state.action_started_tick = self.tick;
                    }
                }
            }
            // Contact disease (`info/bodyDisease`).  The mob's body touch can
            // also inflict a disease on top of the damage; the id is resolved
            // through the same MapleDisease space and honours the same defence
            // layers.  Only modelled diseases apply.
            if !killed {
                if let Some(disease) = body_disease.and_then(PlayerDisease::from_mob_skill_id) {
                    let level = body_disease_level.unwrap_or(1).max(1);
                    // P: no per-level disease duration is exported; the contact
                    // window is a fixed adapter value scaled by the source level.
                    let duration_ms = MOB_DISEASE_CONTACT_BASE_MS.saturating_mul(level as u64);
                    self.inflict_disease(&id, disease, duration_ms, &monster_id);
                }
            }

            let damage_event = serde_json::json!({
                "type": "damageEvent",
                "eventId": format!("damage-event-contact-{}-{}", id, self.tick),
                "serverTick": self.tick,
                "attackerId": monster_id,
                "targetId": id,
                "x": self.players.get(&id).map(|player| player.state.x).unwrap_or(monster_x),
                "y": self.players.get(&id).map(|player| player.state.y).unwrap_or(0.0),
                "damage": hp_damage,
                "mpDamage": mp_damage,
                "killed": killed,
            })
            .to_string();
            self.pending_attacks
                .retain(|_, attack| attack.player_id != id);
            self.broadcast_to_map(&map_id, &damage_event);
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

fn mage_job_allowed(job: u32) -> bool {
    matches!(
        job,
        200 | 210 | 211 | 212 | 220 | 221 | 222 | 230 | 231 | 232
    )
}

fn skill_job_allowed(job: u32, book_id: u32) -> bool {
    match book_id {
        BEGINNER_BOOK => job == BEGINNER_JOB || mage_job_allowed(job),
        MAGE_BOOK => mage_job_allowed(job),
        ICE_BOOK => matches!(job, 220 | 221 | 222),
        THIRD_BOOK => matches!(job, 221 | 222),
        FOURTH_BOOK => job == ICE_FOURTH_JOB,
        _ => false,
    }
}

fn regeneration_passives_for_job(job: u32) -> Vec<RegenerationPassive> {
    let mut passives = vec![RegenerationPassive {
        id: "beginner-recovery",
        book_id: BEGINNER_BOOK,
        hp_per_second: 1,
        mp_per_second: 1,
    }];
    if mage_job_allowed(job) {
        passives.push(RegenerationPassive {
            id: "magician-recovery",
            book_id: MAGE_BOOK,
            hp_per_second: 0,
            mp_per_second: 1,
        });
    } else if matches!(
        job,
        100 | 110 | 111 | 112 | 120 | 121 | 122 | 130 | 131 | 132
    ) {
        passives.push(RegenerationPassive {
            id: "warrior-recovery",
            book_id: 100,
            hp_per_second: 2,
            mp_per_second: 0,
        });
    }
    passives
}

fn is_magic_attack_skill(skill_id: u32) -> bool {
    matches!(
        skill_id,
        SKILL_ENERGY_BOLT
            | SKILL_COLD_BEAM
            | SKILL_THUNDER_BOLT
            | SKILL_ICE_TELEPORT
            | SKILL_ICE_STORM
            | SKILL_GLACIAL_WALL
            | SKILL_TELEPORT_MASTERY
            | SKILL_THUNDER_SPHERE
            | SKILL_THUNDER_SPHERE_HIDDEN
            | SKILL_CHAIN_LIGHTNING
            | SKILL_BLIZZARD
            | SKILL_BLIZZARD_HIDDEN
            | SKILL_ICE_DEMON
            | SKILL_ICE_DRAGON_BREATH
            | SKILL_FROZEN_ORB
            | SKILL_HYPER_THUNDER
    )
}

fn is_nonsummon_direct_skill(skill_id: u32) -> bool {
    matches!(
        skill_id,
        SKILL_ENERGY_BOLT
            | SKILL_COLD_BEAM
            | SKILL_THUNDER_BOLT
            | SKILL_ICE_STORM
            | SKILL_GLACIAL_WALL
            | SKILL_TELEPORT_MASTERY
            | SKILL_CHAIN_LIGHTNING
            | SKILL_BLIZZARD
            | SKILL_ICE_DRAGON_BREATH
    )
}

/// Convert a tick deadline into `Some(remaining ms)` while it is still in the
/// future, or `None` once it has lapsed (or was never set).
fn remaining_ticks(deadline: u64, now: u64) -> Option<u64> {
    (deadline > now).then(|| deadline.saturating_sub(now).saturating_mul(TICK_MS))
}

fn deterministic_percent(parts: &[&str]) -> u64 {
    let mut hasher = DefaultHasher::new();
    for part in parts {
        part.hash(&mut hasher);
        0xff_u8.hash(&mut hasher);
    }
    hasher.finish() % 100
}

/// Resolve a MobSkill id plus its authored level effect into the disease and
/// the duration it should apply for.  Only modelled diseases return `Some`;
/// buffs / summon / unknown ids return `None` and are ignored.
fn mob_skill_disease(
    template: &MonsterTemplate,
    skill: &MonsterSkillTemplate,
) -> Option<(PlayerDisease, u64)> {
    let disease = PlayerDisease::from_mob_skill_id(skill.skill_id)?;
    let effect = template.skill_effect(skill)?;
    // Debuff skills author `time` in seconds.  Seal uses `x` (ms) as its
    // hold length instead of `time`; Slow uses `x` as the move percent but
    // still authors a `time`.  Normalise to milliseconds.
    let duration_ms = match disease {
        PlayerDisease::Seal => effect.x.unwrap_or(0).max(0) as u64,
        _ => effect.time.unwrap_or(0).max(0) as u64 * 1_000,
    };
    (duration_ms >= MOB_SKILL_MIN_DISEASE_MS).then_some((disease, duration_ms))
}

fn hyper_points_for_state(level: u32, skills: &BTreeMap<u32, u32>) -> BTreeMap<u32, u32> {
    BTreeMap::from([
        (1, auth::hyper_points(level, skills, 1)),
        (2, auth::hyper_points(level, skills, 2)),
    ])
}

fn hyper_skill_kind(skill_id: u32) -> Option<u32> {
    if HYPER_PASSIVE_IDS.contains(&skill_id) {
        Some(1)
    } else if HYPER_ACTIVE_IDS.contains(&skill_id) {
        Some(2)
    } else if skill_id == SKILL_HYPER_VORTEX_HIDDEN {
        Some(2)
    } else {
        None
    }
}

fn is_hyper_skill(skill_id: u32) -> bool {
    hyper_skill_kind(skill_id).is_some()
}

fn hyper_vortex_contains(player: &Player, vortex: &HyperVortex) -> bool {
    if player.map_id != vortex.map_id || !player.state.x.is_finite() || !player.state.y.is_finite()
    {
        return false;
    }
    // The source hidden node carries lt[-300,-270]/rb[300,30].  The runtime
    // uses that authored rectangle as the self-only vortex effect envelope;
    // the client receives the same fixed origin through snapshot.summons.
    let facing = if vortex.facing < 0 { -1.0 } else { 1.0 };
    let local_x = -((player.state.x - vortex.x) * facing);
    let local_y = player.state.y - vortex.y;
    local_x >= -300.0 && local_x <= 300.0 && local_y >= -270.0 && local_y <= 30.0
}

fn hyper_barrier_active(player: &Player) -> bool {
    player.hyper_barrier_enabled
        || player
            .hyper_vortex
            .as_ref()
            .is_some_and(|vortex| vortex.expires_at > 0 && hyper_vortex_contains(player, vortex))
}

fn compute_derived_stats(
    gameplay: &Gameplay,
    mage_skills: &MageSkills,
    job: u32,
    base_max_mp: i64,
    character_level: u32,
    skills: &BTreeMap<u32, u32>,
    ability_stats: &AbilityStats,
    equipped: &[crate::protocol::InventoryItem],
    magic_guard: bool,
    meditation_mad: i64,
    meditation_remaining_ms: Option<u64>,
    ice_teleport: bool,
    teleport_mastery: bool,
    teleport_boost: bool,
    hyper_barrier_active: bool,
    hyper_teleport_enabled: bool,
    adaptation_charges: u32,
    adaptation_cooldown_ms: Option<u64>,
    beginner_speed_percent: i64,
    skill_cooldowns: &BTreeMap<u32, u64>,
    skill_buffs: &BTreeMap<u32, u64>,
) -> (DerivedStats, i64) {
    let mut config = gameplay.player.clone();
    // PlayerConfig::with_equipment treats maxMp as the unmodified character
    // baseline.  Keep the persisted baseline separate from the wire snapshot
    // so Magic Boost and equipment can be recomputed without compounding.
    config.max_mp = Some(base_max_mp.max(0));
    let int_bonus = [SKILL_INTELLIGENCE, SKILL_BOOSTER]
        .iter()
        .filter_map(|skill_id| {
            skills
                .get(skill_id)
                .and_then(|level| mage_skills.level(*skill_id, *level))
                .and_then(|level| level.int_x)
        })
        .sum::<i64>();
    let mut ability = ability_stats.clone();
    ability.intelligence = ability.intelligence.saturating_add(int_bonus);
    // Maple Warrior's source marker is an AP-only percentage.  Apply it to
    // the persisted four stat values before equipment is folded in, so gear
    // never receives the passive multiplier.
    let basic_stat_up = skills
        .get(&SKILL_MAPLE_WARRIOR)
        .and_then(|level| mage_skills.level(SKILL_MAPLE_WARRIOR, *level))
        .and_then(|level| level.basic_stat_up)
        .unwrap_or(0)
        .clamp(0, 100);
    if basic_stat_up > 0 {
        let scale = |value: i64| value.saturating_mul(100 + basic_stat_up) / 100;
        ability.strength = scale(ability.strength);
        ability.dexterity = scale(ability.dexterity);
        ability.intelligence = scale(ability.intelligence);
        ability.luck = scale(ability.luck);
    }
    let mut derived = config.with_ability_stats(&ability, equipped, job);
    let bonus = |key: &str| {
        equipped.iter().fold(0i64, |total, item| {
            total.saturating_add(inventory::equipment_attribute(item, key))
        })
    };
    let raw_mp = derived.max_mp.unwrap_or(0).max(0);
    let boost_level = skills.get(&SKILL_MAGIC_BOOST).copied().unwrap_or(0);
    let boost = mage_skills.level(SKILL_MAGIC_BOOST, boost_level);
    let boost_percent = boost.and_then(|level| level.mmp_r).unwrap_or(0).max(0);
    let boost_flat = boost.and_then(|level| level.lv2mmp).unwrap_or(0).max(0);
    let derived_max_mp = raw_mp
        .saturating_add(raw_mp.saturating_mul(boost_percent) / 100)
        // P: String.h describes lv2mmp as per-character-level MP; use the
        // current level during every recomputation so reconnects/equipment
        // changes cannot compound the bonus.
        .saturating_add(boost_flat.saturating_mul(i64::from(character_level.max(1))))
        .max(if mage_job_allowed(job) {
            MAGE_TRANSFER_MIN_MP
        } else {
            0
        });
    let spell_mastery = skills
        .get(&SKILL_SPELL_MASTERY)
        .and_then(|level| mage_skills.level(SKILL_SPELL_MASTERY, *level))
        .and_then(|level| level.mastery)
        .map(|value| (value as f64 / 100.0).clamp(0.0, 1.0))
        .unwrap_or_else(|| derived.mastery.unwrap_or(0.1));
    let demon_mastery = skills
        .get(&SKILL_ICE_DEMON)
        .and_then(|level| mage_skills.level(SKILL_ICE_DEMON, *level))
        .and_then(|level| level.mastery)
        .map(|value| (value as f64 / 100.0).clamp(0.0, 1.0))
        .unwrap_or(0.0);
    // Ice Demon's source mastery is a permanent coverage value: it replaces
    // a lower Spell Mastery value and never adds a second mastery band.
    derived.mastery = Some(spell_mastery.max(demon_mastery));
    let int = derived.base_int.unwrap_or(0).max(0);
    let luk = derived.base_luk.unwrap_or(0).max(0);
    let master_magic_level = skills
        .get(&SKILL_MASTER_MAGIC)
        .and_then(|level| mage_skills.level(SKILL_MASTER_MAGIC, *level));
    let master_magic_mad = master_magic_level
        .and_then(|level| level.mad_x)
        .unwrap_or(0)
        .max(0);
    // P: the selected export does not contain the final player magic formula;
    // this deliberately visible first-job rule gives INT/LUK/level/MAD all a
    // real effect while keeping the same value in damage and snapshots.
    let magic_attack = int
        .saturating_mul(4)
        .saturating_add(luk)
        .saturating_add(i64::from(character_level.max(1)))
        .saturating_add(
            skills
                .get(&SKILL_SPELL_MASTERY)
                .and_then(|level| mage_skills.level(SKILL_SPELL_MASTERY, *level))
                .and_then(|level| level.x)
                .unwrap_or(0)
                .max(0),
        )
        .saturating_add(meditation_mad.max(0))
        .saturating_add(master_magic_mad)
        .saturating_add(bonus("incMAD"))
        .max(1);
    let shield_level = skills.get(&SKILL_MAGIC_SHIELD).copied().unwrap_or(0);
    let shield_bonus = mage_skills
        .level(SKILL_MAGIC_SHIELD, shield_level)
        .and_then(|level| level.pdd_x)
        .unwrap_or(0)
        .max(0);
    let defense = derived
        .weapon_defense
        .unwrap_or(0)
        .max(0)
        .saturating_add(shield_bonus);
    let teleport_level = skills.get(&SKILL_TELEPORT).copied().unwrap_or(0);
    let teleport_speed = mage_skills
        .level(SKILL_TELEPORT, teleport_level)
        .and_then(|level| level.psd_speed)
        .unwrap_or(0)
        .max(0);
    let teleport_speed_max = mage_skills
        .level(SKILL_TELEPORT, teleport_level)
        .and_then(|level| level.speed_max)
        .unwrap_or(0)
        .max(0);
    // P: psdSpeed is the passive percent and speedMax is used as its source
    // cap; the exported values are applied to the real 125 px/s walker.
    let source_speed_percent = bonus("incSpeed").saturating_add(teleport_speed).clamp(
        0,
        if teleport_speed_max > 0 {
            teleport_speed_max.min(100)
        } else {
            100
        },
    );
    let speed_percent = source_speed_percent
        .saturating_add(beginner_speed_percent.max(0))
        .clamp(0, 100);
    let move_speed = WALK_SPEED * (1.0 + speed_percent as f64 / 100.0);
    let adaptation_level = skills
        .get(&SKILL_ELEMENTAL_ADAPTING)
        .copied()
        .and_then(|level| mage_skills.level(SKILL_ELEMENTAL_ADAPTING, level));
    let status_resistance = adaptation_level.and_then(|level| level.asr_r);
    let element_resistance = adaptation_level.and_then(|level| level.ter_r);
    let infinity_enhanced = skill_buffs
        .get(&SKILL_INFINITY)
        .copied()
        .filter(|remaining| *remaining > 0)
        .is_some_and(|remaining| {
            let Some(infinity_level) = skills
                .get(&SKILL_INFINITY)
                .and_then(|level| mage_skills.level(SKILL_INFINITY, *level))
            else {
                return false;
            };
            let source_time_ms = u64::try_from(infinity_level.time.unwrap_or(0).max(0))
                .unwrap_or(0)
                .saturating_mul(1_000);
            let bufftime = master_magic_level
                .and_then(|level| level.buff_time_r)
                .unwrap_or(0)
                .max(0) as u64;
            let full_ms = source_time_ms.saturating_mul(100 + bufftime) / 100;
            let threshold_percent = infinity_level.w2.unwrap_or(30).clamp(0, 100) as u64;
            let threshold = full_ms.saturating_mul(threshold_percent) / 100;
            full_ms > 0 && remaining <= threshold
        });
    (
        DerivedStats {
            magic_attack,
            defense,
            move_speed,
            magic_guard: magic_guard && skills.get(&SKILL_MAGIC_GUARD).copied().unwrap_or(0) > 0,
            hyper_barrier_active,
            hyper_teleport_enabled,
            damage_reduction_percent: if hyper_barrier_active { 20 } else { 0 },
            regeneration_passives: regeneration_passives_for_job(job),
            meditation_remaining_ms,
            skill_cooldowns: (!skill_cooldowns.is_empty()).then(|| skill_cooldowns.clone()),
            skill_buffs: (!skill_buffs.is_empty()).then(|| skill_buffs.clone()),
            infinity_enhanced,
            ice_teleport: Some(ice_teleport),
            teleport_mastery: skills
                .contains_key(&SKILL_TELEPORT_MASTERY)
                .then_some(teleport_mastery),
            teleport_boost: skills
                .contains_key(&SKILL_TELEPORT_BOOST)
                .then_some(teleport_boost),
            adaptation_charges: skills
                .contains_key(&SKILL_ELEMENTAL_ADAPTING)
                .then_some(adaptation_charges),
            adaptation_cooldown_ms,
            status_resistance,
            element_resistance,
            strength: Some(derived.base_str.unwrap_or(0).max(0)),
            dexterity: Some(derived.base_dex.unwrap_or(0).max(0)),
            intelligence: Some(int),
            luck: Some(luk),
        },
        derived_max_mp,
    )
}

fn refresh_player_derived(gameplay: &Gameplay, mage_skills: &MageSkills, player: &mut Player) {
    let (derived_stats, derived_max_mp) = compute_derived_stats(
        gameplay,
        mage_skills,
        player.state.job,
        player.base_max_mp,
        player.state.level,
        &player.state.skills,
        &player.state.ability_stats,
        &player.state.equipped,
        player.magic_guard,
        player.meditation_mad,
        None,
        player.ice_teleport_enabled,
        player.teleport_mastery_enabled,
        player.teleport_boost_enabled,
        hyper_barrier_active(player),
        player.hyper_teleport_enabled,
        if player.adaptation_active {
            player.adaptation_charges
        } else {
            0
        },
        (player.adaptation_cooldown_ms > 0).then_some(player.adaptation_cooldown_ms),
        player.beginner_speed_percent,
        &player.skill_cooldowns,
        &player.skill_buffs,
    );
    player.state.derived_stats = derived_stats.clone();
    player.state.max_mp = derived_max_mp;
    player.state.mp = player.state.mp.clamp(0, derived_max_mp);
    player.move_speed = derived_stats.move_speed;
}

fn profile_from_state(
    state: &PlayerState,
    map_id: &str,
    death_id: &str,
    base_max_mp: i64,
) -> Profile {
    let persisted_map_id = if auth::is_practice_map(map_id) {
        // Private Boss maps are runtime-only.  Persist the authored source
        // map so a reconnect can never resurrect an instance id that was
        // already torn down.
        map_id
            .split(':')
            .nth(1)
            .filter(|source| *source == BOSS_PRACTICE_FALLBACK_MAP_ID)
            .unwrap_or(BOSS_PRACTICE_FALLBACK_MAP_ID)
    } else {
        map_id
    };
    Profile {
        hp: state.hp,
        max_hp: state.max_hp,
        mp: state.mp,
        max_mp: base_max_mp.max(0),
        level: state.level,
        job: state.job,
        exp: state.exp,
        exp_to_next: state.exp_to_next,
        mesos: state.mesos,
        death_id: death_id.to_owned(),
        map_id: persisted_map_id.to_owned(),
        x: state.x,
        y: state.y,
        inventory: state.inventory.clone(),
        skills: state.skills.clone(),
        skill_points: state.skill_points.clone(),
        ability_stats: state.ability_stats.clone(),
    }
}

fn apply_profile(state: &mut PlayerState, profile: Profile) {
    state.hp = profile.hp;
    state.max_hp = profile.max_hp;
    state.mp = profile.mp;
    state.max_mp = profile.max_mp;
    state.level = profile.level;
    state.job = profile.job;
    state.exp = profile.exp;
    state.exp_to_next = profile.exp_to_next;
    state.mesos = profile.mesos;
    state.skills = profile.skills;
    state.skill_points = profile.skill_points;
    state.hyper_points = hyper_points_for_state(state.level, &state.skills);
    state.ability_stats = profile.ability_stats;
    state.inventory = profile.inventory;
    inventory::sort_items(&mut state.inventory);
}

fn apply_profile_to_player(
    gameplay: &Gameplay,
    mage_skills: &MageSkills,
    player: &mut Player,
    profile: Profile,
) {
    player.base_max_mp = profile.max_mp.max(0);
    apply_profile(&mut player.state, profile);
    refresh_player_derived(gameplay, mage_skills, player);
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
    // Stun locks the body: no walk, no jump, and the body is held in place
    // until the deadline passes.  It is applied here, in the authoritative
    // movement step, so a stunned body cannot be moved by a held key.
    if player.stun_until > tick {
        player.direction = 0;
        player.vertical = 0;
        player.jump = false;
        player.state.vx = 0.0;
        return;
    }
    if player.channel_until > tick {
        // Ice Dragon Breath owns the body for its q-window.  Holding the
        // channel must not let residual jump velocity or a stale input packet
        // move the authoritative position.
        player.direction = 0;
        player.vertical = 0;
        player.jump = false;
        player.state.vx = 0.0;
        player.state.vy = 0.0;
        player.state.action = "attack";
        player.state.action_started_tick = tick;
        return;
    }

    // Knockback hop set by a monster's contact hit: while the body is airborne
    // the server keeps the horizontal push instead of honouring walk/jump
    // input.  Landing ends the hop immediately; the tick window is only an
    // upper guard for hops that leave the map.  `knockback_active` stays in
    // scope for the horizontal override and the final action decision.
    if player.state.grounded && player.knockback_until > 0 {
        player.knockback_until = 0;
        player.knockback_vx = 0.0;
    }
    let knockback_active = tick < player.knockback_until && player.knockback_vx != 0.0;
    if knockback_active {
        player.direction = 0;
        player.vertical = 0;
        player.jump = false;
        if player.state.climbing {
            // Defensive only: the contact hit already detaches climbing bodies.
            player.state.climbing = false;
            player.state.ladder_id = None;
            player.state.grounded = false;
            player.foothold_id = 0;
        }
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

    if player.swimming && !knockback_active {
        if let Some(water) = map.water_at(player.state.x, player.state.y).cloned() {
            if player.jump {
                // Jump while swimming is a stroke upward.  Clearing
                // `swimming` unconditionally made the key unusable
                // underwater: the body popped out of the rectangle with full
                // land-jump speed and fell straight back in, so the player
                // could never actually rise.  The body now stays in the water
                // and rises; only when the stroke carries it to the surface
                // does it leave the water on the normal ballistic path, which
                // is what lets a player climb out onto a bank.
                //
                // `SWIM_JUMP_SPEED` is a P value: no TMS273 source number for
                // an in-water jump impulse was found, so it is tuned to lift
                // the body a useful distance per press.
                const SWIM_JUMP_SPEED: f64 = 260.0;
                const SURFACE_EXIT_MARGIN: f64 = 4.0;
                let surface = water.y_min;
                let body_at_surface = player.state.y <= surface + SURFACE_EXIT_MARGIN;
                if body_at_surface {
                    // Explicit swim-to-land transition at the surface: leave
                    // the rectangle and let the normal path find a bank.
                    player.swimming = false;
                    player.state.grounded = false;
                    player.state.climbing = false;
                    player.state.ladder_id = None;
                    player.state.vy = -JUMP_SPEED;
                    player.foothold_id = 0;
                    player.last_foothold_id = 0;
                    player.drop_fh = 0;
                    player.vertical = 0;
                    if tick >= player.attack_until {
                        player.state.action_id = None;
                        player.state.action = "jump";
                        player.state.action_started_tick = tick;
                    }
                    return;
                }
                player.state.vy = -SWIM_JUMP_SPEED;
                player.state.grounded = false;
                player.state.climbing = false;
                player.state.ladder_id = None;
                player.foothold_id = 0;
                player.drop_fh = 0;
                player.vertical = 0;
                player.state.y = (player.state.y + player.state.vy * (TICK_MS as f64 / 1000.0))
                    .clamp(water.y_min, water.floor_at(player.state.x));
                if player.state.y <= water.y_min {
                    player.state.vy = 0.0;
                }
                player.jump = false;
                if tick >= player.attack_until {
                    player.state.action_id = None;
                    if player.state.action != "jump" {
                        player.state.action_started_tick = tick;
                    }
                    player.state.action = "jump";
                }
                return;
            } else {
                const SWIM_SPEED: f64 = 140.0;
                player.state.vx = player.direction as f64 * SWIM_SPEED;
                player.state.vy = player.vertical as f64 * SWIM_SPEED;
                if player.direction != 0 {
                    player.state.facing = player.direction;
                }
                player.state.x = (player.state.x + player.state.vx * (TICK_MS as f64 / 1000.0))
                    .clamp(water.x_min, water.x_max);
                player.state.y = (player.state.y + player.state.vy * (TICK_MS as f64 / 1000.0))
                    .clamp(water.y_min, water.floor_at(player.state.x));
                if player.state.x <= water.x_min || player.state.x >= water.x_max {
                    player.state.vx = 0.0;
                }
                if player.state.y <= water.y_min || player.state.y >= water.floor_at(player.state.x)
                {
                    player.state.vy = 0.0;
                }
                player.state.grounded = false;
                player.state.climbing = false;
                player.state.ladder_id = None;
                player.foothold_id = 0;
                player.drop_fh = 0;
                player.jump = false;
                if tick >= player.attack_until {
                    player.state.action_id = None;
                    if player.state.action != "jump" {
                        player.state.action_started_tick = tick;
                    }
                    // No dedicated swimming sprite is part of the current
                    // avatar contract; keep the existing jump pose.
                    player.state.action = "jump";
                }
                return;
            }
        } else {
            player.swimming = false;
        }
    }

    if player.state.climbing {
        if player.jump && player.direction != 0 {
            player.jump = false;
            player.state.climbing = false;
            player.state.ladder_id = None;
            player.state.vx = player.direction as f64 * player.move_speed * 8.0;
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

    if !knockback_active && !player.state.climbing && player.vertical != 0 {
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
            && (map
                .downjump_target(player.foothold_id, player.state.x)
                .is_some()
                || map.water_below(player.foothold_id, player.state.x));
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
    // Slow (缓速) scales the walk speed while it lasts.  MobSkill `x` carries
    // the authored move percent (e.g. 85 keeps 85% of normal speed); the
    // runtime folds it into the walk so a slowed body genuinely lags rather
    // than only displaying a marker.
    let slow_factor = if player.slow_until > tick {
        // P: no per-source slow percent is re-read here; 50% is the adapter
        // stand-in for the unmodelled `x` denominator until a slow skill is
        // actually wired onto a placed mob.
        0.5
    } else {
        1.0
    };
    player.state.vx = if knockback_active {
        // Body-hit slide: keep the authoritative push even when the player
        // holds the opposite direction key.
        player.knockback_vx
    } else {
        player.direction as f64 * player.move_speed * slow_factor
    };
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
    let intended_x = player.state.x + player.state.vx * (TICK_MS as f64 / 1000.0);
    let projected_vy = (player.state.vy + GRAVITY * (TICK_MS as f64 / 1000.0)).min(FALL_SPEED);
    let water_entry_ahead = map
        .water_entry(
            old_x,
            intended_x,
            player.state.y,
            player.state.y + projected_vy * (TICK_MS as f64 / 1000.0),
        )
        .is_some();
    // Test the wall where the body actually reaches the wall plane, not at the
    // tick-start foot position: a fast fall can cross the plane after dropping
    // past the wall top inside a single tick, which the point-only test
    // tunnels straight through.
    let swept_y = player.state.y + projected_vy * (TICK_MS as f64 / 1000.0);
    let chain_wall =
        (!water_entry_ahead && player.state.vx != 0.0 && chain_anchor != 0).then(|| {
            map.chain_wall_on_sweep(
                chain_anchor,
                player.state.vx < 0.0,
                player.state.x,
                intended_x,
                player.state.y,
                swept_y,
            )
        });
    if let Some(Some(wall)) = chain_wall {
        let crossed = if player.state.vx < 0.0 {
            player.state.x >= wall && intended_x <= wall
        } else {
            player.state.x <= wall && intended_x >= wall
        };
        player.state.x = if crossed { wall } else { intended_x };
        if crossed {
            player.state.vx = 0.0;
        }
    } else {
        player.state.x = intended_x;
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
        let next_vy = (player.state.vy + GRAVITY * (TICK_MS as f64 / 1000.0)).min(FALL_SPEED);
        if tick < player.slow_fall_until {
            // P: the hidden companion's source v=95 is treated as the
            // downward-speed cap for its time window.  魔力波动 itself now
            // uses the same cap so the float is visible on the casted skill.
            player.state.vy = next_vy.min(MAGIC_WAVE_SLOW_FALL_SPEED);
        } else {
            player.slow_fall_until = 0;
            player.state.vy = next_vy;
        }
        let next_y = player.state.y + player.state.vy * (TICK_MS as f64 / 1000.0);
        if player.state.vy >= 0.0 {
            if let Some((water_x, water_y)) =
                map.water_entry(old_x, player.state.x, player.state.y, next_y)
            {
                player.state.x = water_x;
                player.state.y = water_y;
                player.state.vx = 0.0;
                player.state.vy = 0.0;
                player.state.grounded = false;
                player.swimming = true;
                player.foothold_id = 0;
                player.last_foothold_id = 0;
                player.fall_boundary_hold = false;
                player.drop_fh = 0;
            } else if let Some((foothold_id, landing_x, ground)) =
                map.landing_on_sweep(old_x, player.state.x, player.state.y, next_y, ignored_fh)
            {
                player.state.x = landing_x;
                player.state.y = ground;
                player.state.vy = 0.0;
                player.state.grounded = true;
                player.swimming = false;
                player.foothold_id = foothold_id;
                player.last_foothold_id = foothold_id;
                player.drop_fh = 0;
            } else {
                player.state.y = next_y;
            }
        } else {
            player.state.y = next_y;
        }
        if !player.swimming && player.state.vy >= 0.0 && player.state.y > map.fall_boundary() {
            recover_at_fall_boundary(map, player, tick);
        }
        if player.state.y < map.bounds.y_min {
            player.state.y = map.bounds.y_min;
            player.state.vy = player.state.vy.max(0.0);
        }
    }
    if tick >= player.attack_until {
        player.state.action_id = None;
        let action = if knockback_active {
            // Knockback hop pose: airborne bodies show the jump frames and
            // stand again on the tick they land; no walk cycle is played.
            if player.state.grounded {
                "stand"
            } else {
                "jump"
            }
        } else if player.state.climbing {
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

/// Human-readable remaining time for a rejected consumable use.
///
/// The remaining value comes from the authoritative cooldown, so the text only
/// has to render it.  Seconds are rounded up so a player is never told "0
/// seconds" while the item is still locked.
fn format_potion_cooldown(remaining_ms: u64, lang: &'static str) -> String {
    let seconds = remaining_ms.div_ceil(1000).max(1);
    if lang == crate::quest_text::LANG_EN {
        format!("This item is cooling down: {seconds}s remaining.")
    } else {
        format!("道具冷却中，还需 {seconds} 秒。")
    }
}

/// Explain why a map-move consumable did nothing.
///
/// Every code here comes from `plan_map_move`, and every one of them is a
/// *reason the scroll was not spent* — the player-visible contract is that a
/// refused teleport never costs an item, so the text says what was missing
/// rather than what went wrong.  The fallback covers the impossible case so a
/// future code cannot silently ship with an empty message.
fn map_move_reject_message(code: &str, lang: &'static str) -> &'static str {
    let (zh, en) = match code {
        "dead" => (
            "角色死亡时无法使用传送卷軸。",
            "You cannot use a teleport scroll while dead.",
        ),
        "scroll_blocked" => (
            "练习中不能使用传送卷軸。",
            "Teleport scrolls cannot be used during practice.",
        ),
        "scroll_no_target" => (
            "此地图没有可返回的城镇，卷軸未被消耗。",
            "This map has no return town, so the scroll was not consumed.",
        ),
        "scroll_unavailable" => (
            "目标城镇尚未开放，卷軸未被消耗。",
            "The destination town is not open yet, so the scroll was not consumed.",
        ),
        "item_unavailable" => ("道具已不可用。", "That item is no longer usable."),
        _ => (
            "无法使用该传送卷軸。",
            "The teleport scroll could not be used.",
        ),
    };
    if lang == crate::quest_text::LANG_EN {
        en
    } else {
        zh
    }
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
    player.swimming = false;
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
            water: Vec::new(),
            reactors: Vec::new(),
        }
    }

    fn life_template() -> MonsterTemplate {
        MonsterTemplate {
            template_id: "100100".into(),
            level: 1,
            max_hp: 8,
            max_mp: 0,
            boss: false,
            pa_damage: Some(3),
            pd_damage: Some(0),
            pd_rate: None,
            md_rate: None,
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

    fn life_spawn(id: &str, map_id: &str, x: f64, facing: i8, mob_time: i64) -> MonsterSpawn {
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

    fn join_test_player(world: &mut World, id: &str) -> mpsc::Receiver<String> {
        let (output, rx) = mpsc::channel(128);
        let (reply, _) = oneshot::channel();
        world.command(Command::Join {
            identity: Identity {
                id: id.to_owned(),
                username: id.to_owned(),
            },
            connection: format!("{id}-connection"),
            output,
            reply,
            lang: "zh".to_owned(),
        });
        rx
    }

    #[test]
    fn natural_recovery_passives_follow_job_without_skill_stacking() {
        let empty = BTreeMap::new();
        let (beginner, _) = compute_derived_stats(
            &Gameplay::default(),
            &MageSkills::default(),
            BEGINNER_JOB,
            5,
            1,
            &empty,
            &AbilityStats::default(),
            &[],
            false,
            0,
            None,
            false,
            false,
            false,
            false,
            false,
            0,
            None,
            0,
            &BTreeMap::new(),
            &BTreeMap::new(),
        );
        assert_eq!(
            beginner.regeneration_passives,
            vec![RegenerationPassive {
                id: "beginner-recovery",
                book_id: 0,
                hp_per_second: 1,
                mp_per_second: 1,
            }]
        );
        let forged_skills = BTreeMap::from([(SKILL_RECOVERY, 30), (1000003, 30), (1000009, 30)]);
        let (magician, _) = compute_derived_stats(
            &Gameplay::default(),
            &MageSkills::default(),
            ICE_MAGE_JOB,
            5,
            30,
            &forged_skills,
            &AbilityStats::default(),
            &[],
            false,
            0,
            None,
            false,
            false,
            false,
            false,
            false,
            0,
            None,
            0,
            &BTreeMap::new(),
            &BTreeMap::new(),
        );
        assert_eq!(
            magician.regeneration_passives,
            vec![
                RegenerationPassive {
                    id: "beginner-recovery",
                    book_id: 0,
                    hp_per_second: 1,
                    mp_per_second: 1,
                },
                RegenerationPassive {
                    id: "magician-recovery",
                    book_id: 200,
                    hp_per_second: 0,
                    mp_per_second: 1,
                },
            ]
        );
        let (warrior, _) = compute_derived_stats(
            &Gameplay::default(),
            &MageSkills::default(),
            100,
            5,
            30,
            &forged_skills,
            &AbilityStats::default(),
            &[],
            false,
            0,
            None,
            false,
            false,
            false,
            false,
            false,
            0,
            None,
            0,
            &BTreeMap::new(),
            &BTreeMap::new(),
        );
        assert_eq!(
            warrior.regeneration_passives,
            vec![
                RegenerationPassive {
                    id: "beginner-recovery",
                    book_id: 0,
                    hp_per_second: 1,
                    mp_per_second: 1,
                },
                RegenerationPassive {
                    id: "warrior-recovery",
                    book_id: 100,
                    hp_per_second: 2,
                    mp_per_second: 0,
                },
            ]
        );
        for job in [112, 132] {
            assert_eq!(
                regeneration_passives_for_job(job),
                warrior.regeneration_passives
            );
        }
        for job in [222, 232] {
            assert_eq!(
                regeneration_passives_for_job(job),
                magician.regeneration_passives
            );
        }
        assert_eq!(
            regeneration_passives_for_job(300),
            beginner.regeneration_passives
        );
    }

    #[test]
    fn natural_recovery_waits_a_second_caps_and_resets_after_death() {
        let gameplay = Gameplay {
            player: PlayerConfig {
                max_hp: Some(3),
                max_mp: Some(4),
                ..PlayerConfig::default()
            },
            ..Gameplay::default()
        };
        let mut world = World::new_with_gameplay(life_map("test"), 600, gameplay);
        let mut rx = join_test_player(&mut world, "natural");
        while rx.try_recv().is_ok() {}
        {
            let player = world.players.get_mut("natural").unwrap();
            player.state.hp = 1;
            player.state.mp = 1;
        }
        for _ in 0..19 {
            world.step();
        }
        assert_eq!(
            (
                world.players["natural"].state.hp,
                world.players["natural"].state.mp
            ),
            (1, 1)
        );
        world.step();
        assert_eq!(
            (
                world.players["natural"].state.hp,
                world.players["natural"].state.mp
            ),
            (2, 2)
        );
        for _ in 0..40 {
            world.step();
        }
        assert_eq!(
            (
                world.players["natural"].state.hp,
                world.players["natural"].state.mp
            ),
            (3, 4)
        );
        let full_tick = world.tick;
        world.players.get_mut("natural").unwrap().state.hp = 1;
        for _ in 0..19 {
            world.step();
        }
        assert_eq!(world.players["natural"].state.hp, 1);
        world.step();
        assert_eq!(world.players["natural"].state.hp, 2);
        assert!(world.tick > full_tick);
        {
            let player = world.players.get_mut("natural").unwrap();
            player.state.hp = 0;
            player.state.action = "dead";
        }
        for _ in 0..40 {
            world.step();
        }
        assert_eq!(world.players["natural"].state.hp, 0);
        assert_eq!(world.players["natural"].state.action, "dead");
        world.players.get_mut("natural").unwrap().death_id = "natural-death".into();
        world.complete_revive("natural", "natural-death");
        assert_eq!(world.players["natural"].state.action, "stand");
        world.players.get_mut("natural").unwrap().state.hp = 1;
        for _ in 0..19 {
            world.step();
        }
        assert_eq!(world.players["natural"].state.hp, 1);
        world.step();
        assert_eq!(world.players["natural"].state.hp, 2);
    }

    #[test]
    fn natural_recovery_does_not_restore_offline_time_or_update_on_failed_save() {
        let path = std::env::temp_dir().join(format!(
            "maple-natural-recovery-{}.sqlite3",
            auth::random_id()
        ));
        let service = auth::start(&path).unwrap();
        let store = service.store.clone();
        let gameplay = Gameplay {
            player: PlayerConfig {
                max_hp: Some(3),
                max_mp: Some(4),
                ..PlayerConfig::default()
            },
            ..Gameplay::default()
        };
        let mut world =
            World::new_with_store(life_map("test"), 600, gameplay, store.clone()).unwrap();
        let mut rx = join_test_player(&mut world, "natural-store");
        while rx.try_recv().is_ok() {}
        {
            let player = world.players.get_mut("natural-store").unwrap();
            player.state.hp = 1;
            player.state.mp = 1;
            store
                .save_profile(
                    "natural-store",
                    &profile_from_state(
                        &player.state,
                        &player.map_id,
                        &player.death_id,
                        player.base_max_mp,
                    ),
                )
                .unwrap();
        }
        world.tick = 200;
        let mut reconnect_rx = join_test_player(&mut world, "natural-store");
        while reconnect_rx.try_recv().is_ok() {}
        assert_eq!(
            (
                world.players["natural-store"].state.hp,
                world.players["natural-store"].state.mp
            ),
            (1, 1)
        );
        assert_eq!(
            world.players["natural-store"].natural_recovery_next_tick,
            world.tick + NATURAL_RECOVERY_INTERVAL_TICKS
        );
        world.tick = world.players["natural-store"].natural_recovery_next_tick;
        world.step_natural_recovery("natural-store");
        assert_eq!(
            (
                world.players["natural-store"].state.hp,
                world.players["natural-store"].state.mp
            ),
            (2, 2)
        );
        let saved = store
            .load_profile("natural-store", &world.default_profile())
            .unwrap();
        assert_eq!((saved.hp, saved.mp), (2, 2));
        {
            let player = world.players.get_mut("natural-store").unwrap();
            player.state.hp = 1;
            player.state.mp = 1;
        }
        world.tick = world.players["natural-store"].natural_recovery_next_tick;
        store
            .with_db(|db| {
                db.execute("DROP TABLE player_stats", [])
                    .map(|_| ())
                    .map_err(|_| "drop player_stats failed".to_owned())
            })
            .unwrap();
        world.step_natural_recovery("natural-store");
        assert_eq!(
            (
                world.players["natural-store"].state.hp,
                world.players["natural-store"].state.mp
            ),
            (1, 1)
        );
        let retry_tick = world.players["natural-store"].natural_recovery_next_tick;
        assert_eq!(retry_tick, world.tick + NATURAL_RECOVERY_INTERVAL_TICKS);
        world.tick += 1;
        world.step_natural_recovery("natural-store");
        assert_eq!(
            (
                world.players["natural-store"].state.hp,
                world.players["natural-store"].state.mp
            ),
            (1, 1)
        );
        drop(world);
        drop(service);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    fn beginner_skills_fixture() -> MageSkills {
        serde_json::from_str(
            r#"{"sourceVersion":"TMS273.7","bookId":200,"skills":{
                "1000":{"name":"嫩寶丟擲術","maxLevel":3,"bookId":0,"levels":[{"mpCon":3,"fixdamage":10},{"mpCon":5,"fixdamage":25},{"mpCon":7,"fixdamage":40}]},
                "1001":{"name":"治癒","maxLevel":3,"bookId":0,"levels":[{"mpCon":5,"time":30,"x":4,"cooltime":120},{"mpCon":10,"time":30,"x":8,"cooltime":120},{"mpCon":15,"time":30,"x":12,"cooltime":120}]},
                "1002":{"name":"疾風之步","maxLevel":3,"bookId":0,"levels":[{"mpCon":4,"time":4,"speed":10,"cooltime":60},{"mpCon":7,"time":8,"speed":15,"cooltime":60},{"mpCon":10,"time":12,"speed":20,"cooltime":60}]
            }}}"#,
        )
        .unwrap()
    }

    #[test]
    fn beginner_skill_runtime_locks_fixed_damage_and_timed_buffs() {
        let mut gameplay = life_gameplay(vec![life_spawn("beginner-mob", "test", 300.0, 1, -1)]);
        gameplay.player.max_hp = Some(35);
        gameplay.player.max_mp = Some(50);
        gameplay.player.attack_reach = Some(88.0);
        gameplay.monsters[0].max_hp = 50;
        let mut world = World::new_with_gameplay(life_map("test"), 600, gameplay)
            .with_mage_skills(beginner_skills_fixture());
        let (output, mut rx) = mpsc::channel(4096);
        let (reply, _) = oneshot::channel();
        world.command(Command::Join {
            identity: Identity {
                id: "beginner-runtime".into(),
                username: "beginner-runtime".into(),
            },
            connection: "beginner-runtime-connection".into(),
            output,
            reply,
            lang: "zh".into(),
        });
        while rx.try_recv().is_ok() {}
        {
            let player = world.players.get_mut("beginner-runtime").unwrap();
            player.state.x = 10.0;
            player.state.y = 100.0;
            player.state.grounded = true;
            player.state.action = "stand";
            player.state.skills = BTreeMap::from([
                (SKILL_THREE_SNAILS, 1),
                (SKILL_RECOVERY, 1),
                (SKILL_NIMBLE_FEET, 1),
            ]);
            player.state.mp = 50;
            player.state.hp = 12;
            player.foothold_id = 1;
            player.last_foothold_id = 1;
            refresh_player_derived(&world.gameplay, &world.mage_skills, player);
        }
        let monster_id = world.monsters.keys().next().cloned().unwrap();
        let drain = |rx: &mut mpsc::Receiver<String>| {
            let mut values = Vec::new();
            while let Ok(message) = rx.try_recv() {
                values.push(serde_json::from_str::<serde_json::Value>(&message).unwrap());
            }
            values
        };

        world.handle_cast_skill(
            "beginner-runtime".into(),
            "snails-1".into(),
            SKILL_THREE_SNAILS,
            Some(1),
            Some(0),
        );
        let first_cast = drain(&mut rx);
        let cast_event = first_cast
            .iter()
            .find(|value| value["type"] == "skillCast")
            .expect("beginner skillCast");
        assert_eq!(cast_event["skillId"], SKILL_THREE_SNAILS);
        assert_eq!(cast_event["skillLevel"], 1);
        assert_eq!(cast_event["targetId"], monster_id);
        let damage_event = first_cast
            .iter()
            .find(|value| value["type"] == "damageEvent")
            .expect("beginner damageEvent");
        assert_eq!(damage_event["damage"], 10);
        assert_eq!(damage_event["skillLevel"], 1);
        assert_eq!(world.monsters[&monster_id].state.hp, 40);
        assert_eq!(world.players["beginner-runtime"].state.mp, 47);
        assert!(world.players["beginner-runtime"].attack_until > world.tick);

        // The cast animation lock is authoritative, while the same request is
        // a replay and returns without spending MP or applying damage again.
        world.handle_cast_skill(
            "beginner-runtime".into(),
            "snails-2".into(),
            SKILL_THREE_SNAILS,
            Some(1),
            Some(0),
        );
        let busy = drain(&mut rx);
        assert!(busy
            .iter()
            .any(|value| { value["type"] == "rejected" && value["code"] == "skill_busy" }));
        assert_eq!(world.players["beginner-runtime"].state.mp, 47);
        world.handle_cast_skill(
            "beginner-runtime".into(),
            "snails-1".into(),
            SKILL_THREE_SNAILS,
            Some(1),
            Some(0),
        );
        let replay = drain(&mut rx);
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0]["type"], "skillResult");
        assert_eq!(world.monsters[&monster_id].state.hp, 40);
        assert_eq!(world.players["beginner-runtime"].state.mp, 47);

        world.handle_cast_skill(
            "beginner-runtime".into(),
            "recovery-1".into(),
            SKILL_RECOVERY,
            Some(0),
            Some(0),
        );
        let recovery = drain(&mut rx);
        assert!(recovery
            .iter()
            .any(|value| { value["type"] == "skillResult" && value["success"] == true }));
        assert_eq!(world.players["beginner-runtime"].state.mp, 42);
        assert_eq!(
            world.players["beginner-runtime"]
                .state
                .derived_stats
                .skill_buffs
                .as_ref()
                .and_then(|buffs| buffs.get(&SKILL_RECOVERY)),
            Some(&30_000)
        );
        assert_eq!(
            world.players["beginner-runtime"]
                .state
                .derived_stats
                .skill_cooldowns
                .as_ref()
                .and_then(|cooldowns| cooldowns.get(&SKILL_RECOVERY)),
            Some(&120_000)
        );
        world.handle_cast_skill(
            "beginner-runtime".into(),
            "recovery-2".into(),
            SKILL_RECOVERY,
            Some(0),
            Some(0),
        );
        let cooldown = drain(&mut rx);
        assert!(cooldown
            .iter()
            .any(|value| { value["type"] == "rejected" && value["code"] == "skill_cooldown" }));
        assert_eq!(world.players["beginner-runtime"].state.mp, 42);
        assert_eq!(world.tick, 0);
        assert_eq!(world.players["beginner-runtime"].state.max_hp, 35);
        assert_eq!(
            world.players["beginner-runtime"].beginner_heal_next_tick,
            100
        );
        assert_eq!(
            world.players["beginner-runtime"].beginner_heal_remaining_ticks,
            6
        );
        assert_eq!(world.players["beginner-runtime"].beginner_heal_per_tick, 4);
        for _ in 0..99 {
            world.step();
        }
        assert_eq!(world.tick, 99);
        assert_eq!(
            world.players["beginner-runtime"].beginner_heal_next_tick,
            100
        );
        assert_eq!(
            world.players["beginner-runtime"].beginner_heal_remaining_ticks,
            6
        );
        assert!(world.players["beginner-runtime"]
            .skill_buffs
            .contains_key(&SKILL_RECOVERY));
        assert_eq!(world.players["beginner-runtime"].state.hp, 16);
        world.step();
        // Tick 100 applies the active 4 HP heal and the permanent +1 HP/s
        // beginner passive after four earlier natural intervals.
        assert_eq!(world.players["beginner-runtime"].state.hp, 21);
        for _ in 0..500 {
            world.step();
        }
        assert_eq!(world.players["beginner-runtime"].state.hp, 35);
        assert!(world.players["beginner-runtime"]
            .state
            .derived_stats
            .skill_buffs
            .is_none());
        assert_eq!(
            world.players["beginner-runtime"]
                .skill_cooldowns
                .get(&SKILL_RECOVERY),
            Some(&90_000)
        );
        assert_eq!(
            world.players["beginner-runtime"]
                .state
                .derived_stats
                .skill_cooldowns
                .as_ref()
                .and_then(|cooldowns| cooldowns.get(&SKILL_RECOVERY)),
            Some(&90_000)
        );

        world.handle_cast_skill(
            "beginner-runtime".into(),
            "nimble-1".into(),
            SKILL_NIMBLE_FEET,
            Some(1),
            Some(0),
        );
        let nimble = drain(&mut rx);
        assert!(nimble
            .iter()
            .any(|value| { value["type"] == "skillResult" && value["success"] == true }));
        // Natural MP recovery reaches the 50 MP cap during the long buff
        // window, so Nimble Feet's 4 MP cost leaves 46.
        assert_eq!(world.players["beginner-runtime"].state.mp, 46);
        assert_eq!(
            world.players["beginner-runtime"]
                .state
                .derived_stats
                .move_speed,
            137.5
        );
        world.players.get_mut("beginner-runtime").unwrap().state.hp = 1;
        world.players.get_mut("beginner-runtime").unwrap().state.x = 300.0;
        world
            .monsters
            .get_mut(&monster_id)
            .unwrap()
            .template
            .body_attack = true;
        world
            .monsters
            .get_mut(&monster_id)
            .unwrap()
            .template
            .pa_damage = Some(2);
        world.apply_contact_damage();
        assert_eq!(world.players["beginner-runtime"].state.hp, 0);
        assert!(world.players["beginner-runtime"].skill_buffs.is_empty());
        assert_eq!(world.players["beginner-runtime"].beginner_speed_percent, 0);
        assert!(world.players["beginner-runtime"]
            .state
            .derived_stats
            .skill_buffs
            .is_none());
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
            lang: "zh".to_owned(),
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
            lang: "zh".to_owned(),
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
            lang: "zh".to_owned(),
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
            lang: "zh".to_owned(),
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
            slot: 9,
            item_id: "1102173".into(),
            quantity: 1,
            ..crate::protocol::InventoryItem::default()
        };
        inventory::ensure_equipment_instance(&mut helmet);
        world.players.get_mut("a").unwrap().state.inventory =
            vec![crate::protocol::InventoryItem {
                slot: 1,
                item_id: "2041006".into(),
                quantity: 2,
                ..crate::protocol::InventoryItem::default()
            }];
        world.players.get_mut("a").unwrap().state.equipped = vec![helmet];

        world.handle_use_item(
            "a".into(),
            "memory-scroll-wrong-target".into(),
            2,
            1,
            "2041006".into(),
            Some(-9),
            Some("1040002".into()),
        );
        assert_eq!(world.players["a"].state.inventory[0].quantity, 2);
        assert_eq!(
            world.players["a"].state.equipped[0].remaining_slots,
            Some(6)
        );

        world.handle_use_item(
            "a".into(),
            "memory-scroll-valid".into(),
            2,
            1,
            "2041006".into(),
            Some(-9),
            Some("1102173".into()),
        );
        assert_eq!(world.players["a"].state.inventory[0].quantity, 1);
        let helmet = &world.players["a"].state.equipped[0];
        assert_eq!(helmet.remaining_slots, Some(5));
        assert_eq!(
            helmet.stats.as_ref().and_then(|stats| stats.get("incMHP")),
            Some(&20)
        );

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
            job: 0,
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            death_id: String::new(),
            map_id: String::new(),
            x: 0.0,
            y: 0.0,
            inventory: Vec::new(),
            skills: BTreeMap::new(),
            skill_points: BTreeMap::new(),
            ability_stats: AbilityStats::default(),
        };
        store.load_profile("a", &defaults).unwrap();
        let stats = BTreeMap::from([(String::from("incPDD"), 12_i64)]);
        store
            .claim_attack("a", "test", "world-reward", "world-action", "attack")
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
            lang: "zh".to_owned(),
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
    fn join_snapshot_includes_persisted_character_appearance() {
        let path = std::env::temp_dir().join(format!(
            "maple-world-appearance-{}.sqlite3",
            auth::random_id()
        ));
        let service = auth::start(&path).unwrap();
        let store = service.store.clone();
        store
            .with_db(|db| {
                db.execute(
                    "INSERT INTO accounts(id,username,password_hash)
                     VALUES ('appearance-account','appearance-user','')",
                    [],
                )
                .map_err(|_| "test account insert failed".to_owned())?;
                Ok(())
            })
            .unwrap();
        let appearance = crate::lobby::Appearance {
            gender: 0,
            face: 20_100,
            hair: 30_000,
            skin: 0,
            coat: 1_050_286,
            pants: 0,
            shoes: 1_072_833,
            weapon: 1_302_000,
        };
        let character = match crate::lobby::handle(
            &store,
            "appearance-account",
            crate::lobby::Action::Create {
                request_id: "appearance-test".into(),
                name: "Appearance".into(),
                appearance: appearance.clone(),
            },
        )
        .unwrap()
        {
            crate::lobby::Response::Created { character } => character,
            _ => panic!("unexpected character response"),
        };
        let mut world = World::new_with_store(map(), 600, Gameplay::default(), store).unwrap();
        let (output, mut rx) = mpsc::channel(128);
        let (reply, _) = oneshot::channel();
        world.command(Command::Join {
            identity: Identity {
                id: character.id.clone(),
                username: character.name,
            },
            connection: "appearance-connection".into(),
            output,
            reply,
            lang: "zh".to_owned(),
        });
        let snapshot: serde_json::Value =
            serde_json::from_str(&rx.try_recv().expect("join snapshot")).unwrap();
        let player = snapshot["players"]
            .as_array()
            .and_then(|players| {
                players
                    .iter()
                    .find(|player| player["id"].as_str() == Some(character.id.as_str()))
            })
            .expect("joined character in snapshot");
        assert_eq!(
            player["appearance"],
            serde_json::to_value(&appearance).expect("appearance serializes")
        );
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
                lang: "zh".to_owned(),
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
            lang: "zh".to_owned(),
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
                return_maps: BTreeMap::new(),
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
            lang: "zh".to_owned(),
        });
        while rx.try_recv().is_ok() {}
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
            "000010000",
            "001000000",
            "001010000",
            "001020000",
            "002000000",
            "002000001",
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
    fn tms273_catalog_preserves_authored_portals_without_v83_rewrites() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/maps.json");
        let catalog = MapCatalog::load(&path).expect("generated TMS273 map catalog");
        let map = |id: &str| catalog.maps.iter().find(|map| map.id == id).unwrap();
        let portal = |id: &str, name: &str| {
            map(id)
                .portals
                .iter()
                .find(|portal| portal.name == name)
                .unwrap()
        };
        let exit = portal("000020000", "out00");
        assert_eq!(exit.target_map_id.as_deref(), Some("001000000"));
        assert_eq!(exit.target_portal_name.as_deref(), Some("west00"));
        // The source arrival marker is not an outgoing return gate.
        let arrival = portal("000030000", "in00");
        assert!(arrival.target_map_id.is_none());
        assert!(arrival.target_portal_name.is_none());
        assert!(!map("000020000").portals.iter().any(|p| p.name == "in01"));
        assert_eq!(
            portal("000040000", "in00").target_map_id.as_deref(),
            Some("000020000")
        );
    }

    /// A warp must land on the floor.  The arrival resolution in
    /// `handle_portal` only snaps to ground within 24 px, so a landing whose
    /// nearest foothold is farther than that leaves the player airborne until
    /// gravity pulls them down — visible as "landed in the wrong place".
    /// The bug was routing several scripted gates to the destination's default
    /// spawn (`sp`), which marks the authored spawn point rather than a floor.
    #[test]
    fn tms273_warp_landings_are_grounded() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/maps.json");
        let catalog = MapCatalog::load(&path).expect("generated TMS273 map catalog");
        let ids: BTreeSet<&str> = catalog.maps.iter().map(|map| map.id.as_str()).collect();
        let map = |id: &str| catalog.maps.iter().find(|map| map.id == id).unwrap();
        let gate = |id: &str, name: &str| {
            map(id)
                .portals
                .iter()
                .find(|portal| portal.name == name)
                .unwrap()
        };
        for source in &catalog.maps {
            for portal in &source.portals {
                let Some(target_id) = portal.target_map_id.as_deref() else {
                    continue;
                };
                if target_id == source.id || !ids.contains(target_id) {
                    continue;
                }
                let target = map(target_id);
                let landing = portal
                    .target_portal_name
                    .as_deref()
                    .and_then(|name| target.portals.iter().find(|p| p.name == name))
                    .map(|p| (p.x, p.y))
                    .unwrap_or((target.spawn.x, target.spawn.y));
                let ground = target.ground_near(landing.0, landing.1);
                let distance = ground.map_or(f64::INFINITY, |(_, y)| (y - landing.1).abs());
                assert!(
                    distance <= 24.0,
                    "{} / {} -> {} / {} lands {:?}px off the ground",
                    source.id,
                    portal.name,
                    target_id,
                    portal.target_portal_name.as_deref().unwrap_or("spawn"),
                    distance
                );
            }
        }
        // The pier ferry both ways, per `Map/Map/Graph.json`.
        let pier = gate("002000000", "east00");
        assert_eq!(pier.target_map_id.as_deref(), Some("002000100"));
        assert_eq!(pier.target_portal_name.as_deref(), Some("west00"));
        let back = gate("002000100", "west00");
        assert_eq!(back.target_map_id.as_deref(), Some("002000000"));
        assert_eq!(back.target_portal_name.as_deref(), Some("in00"));
        // 維多利亞港三家商店：原版 273 的三个 type-2 店门，以及店内的返回门。
        // 目标图不在目录里时 `handle_portal` 会回 `map_unavailable`，所以这里
        // 同时断言配对与目录归属，而上面的循环断言落点贴地。
        for (town, name, shop, exit_name) in [
            ("104000000", "in00", "104000001", "out00"),
            ("104000000", "in01", "104000002", "out01"),
            ("104000000", "in02", "104000003", "out00"),
        ] {
            assert!(
                ids.contains(shop),
                "{shop} must be part of the assembled catalog"
            );
            let enter = gate(town, name);
            assert_eq!(enter.target_map_id.as_deref(), Some(shop));
            assert_eq!(enter.target_portal_name.as_deref(), Some(exit_name));
            let exit = gate(shop, exit_name);
            assert_eq!(exit.target_map_id.as_deref(), Some(town));
            assert_eq!(exit.target_portal_name.as_deref(), Some(name));
        }
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
                return_maps: BTreeMap::new(),
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
            lang: "zh".to_owned(),
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
            lang: "zh".to_owned(),
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
        assert!(!world
            .monsters
            .values()
            .any(|monster| monster.spawn.id == "birth-life"));
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
            return_maps: BTreeMap::new(),
            maps: vec![life_map("birth"), life_map("target")],
        };
        let cases = [
            (
                life_spawn("unknown-map", "missing", 100.0, 1, 0),
                "unknown map",
            ),
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
    fn tms273_percentage_defense_is_not_absolute_pdd() {
        let config = PlayerConfig {
            base_str: Some(100),
            base_dex: Some(20),
            weapon_type: Some(130),
            weapon_watk: Some(100),
            ..PlayerConfig::default()
        };
        let mut monster = life_template();
        monster.pd_rate = Some(10.0);
        monster.pd_damage = Some(9999);
        let (min, max) = config.attack_range();
        assert_eq!(
            config.attack_range_against(1, &monster),
            (min as f64 * 0.9, max as f64 * 0.9)
        );
        monster.pd_rate = Some(300.0);
        assert_eq!(config.attack_range_against(1, &monster), (1.0, 1.0));
        let mut gameplay = life_gameplay(Vec::new());
        gameplay.monsters[0].pd_rate = Some(f64::NAN);
        assert!(gameplay.validate().is_err());
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
        assert_eq!(config.attack_range_against(1, &red_snail), (1.0, 1.0));
        assert_eq!(config.attack_range_against(1, &slime), (1.0, 1.0));
        assert_eq!(config.attack_range_against(1, &no_defense), (1.0, 2.0));
        let mut high_defense = life_template();
        high_defense.pd_damage = Some(1000);
        assert_eq!(config.attack_range_against(1, &high_defense), (1.0, 1.0));
        assert!(config.attack_damage_against(1, &high_defense) >= 1);
    }

    #[test]
    fn map_cycle_mob_time_zero_respawns_even_without_configured_interval() {
        // mobTime 0 means "follow the map respawn cycle"; when the assembled
        // gameplay leaves the map cycle empty the fallback 10 s cycle must
        // still return a deadline, otherwise the mob is removed forever and
        // every map empties over time.
        let interval_ticks = DEFAULT_MONSTER_RESPAWN_MS.div_ceil(TICK_MS);
        assert!(respawn_deadline(10_000, None, 0).is_some());
        assert_eq!(
            respawn_deadline(0, None, 0),
            Some(interval_ticks),
            "cycle-aligned deadline must land on the next interval boundary"
        );
        assert_eq!(
            respawn_deadline(10_000, Some(500), 0),
            Some(10_010),
            "explicit map cycle is preferred over the default"
        );
        assert_eq!(
            respawn_deadline(0, Some(500), 0),
            Some(10),
            "500 ms -> 10 ticks"
        );
        assert_eq!(
            respawn_deadline(0, None, -1),
            None,
            "mobTime -1 never respawns"
        );
        assert_eq!(
            respawn_deadline(1_000, None, 5),
            Some(1_000 + 5_000 / TICK_MS),
            "positive source mobTime is a death-relative second delay"
        );
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
            lang: "zh".to_owned(),
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
            lang: "zh".to_owned(),
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
        assert!(
            player.state.grounded,
            "body should land near the take-off platform"
        );
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
            lang: "zh".to_owned(),
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
            lang: "zh".to_owned(),
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
            lang: "zh".to_owned(),
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
            lang: "zh".to_owned(),
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
            r#"{"contentVersion":"tms273-3","player":{"baseStr":4,"baseDex":4,"baseInt":4,"baseLuk":4,"weaponType":130,"weaponWatk":10,"attackReach":80,"attackHeight":40,"attackAfterMs":300,"maxHp":30},"monsterTemplates":[{"templateId":"0100130","level":1,"maxHp":8,"PADamage":12,"exp":1,"bodyAttack":true,"moveSpeed":10,"hitboxWidth":39,"hitboxHeight":29,"drop":{"itemId":"2000000","quantity":1,"guaranteed":true}}],"monsterSpawns":[{"id":"s1","templateId":"0100130","x":100,"y":100,"footholdId":1}],"expTable":[15]}"#,
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
            lang: "zh".to_owned(),
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
            lang: "zh".to_owned(),
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
            lang: "zh".to_owned(),
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
            lang: "zh".to_owned(),
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
            lang: "zh".to_owned(),
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
            lang: "zh".to_owned(),
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
            lang: "zh".to_owned(),
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
                    max_mp: 0,
                    boss: false,
                    pa_damage: Some(12),
                    pd_damage: None,
                    pd_rate: None,
                    md_rate: None,
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
            lang: "zh".to_owned(),
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
            lang: "zh".to_owned(),
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
            job: 200,
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            death_id: String::new(),
            map_id: String::new(),
            x: 0.0,
            y: 0.0,
            inventory: Vec::new(),
            skills: BTreeMap::new(),
            skill_points: BTreeMap::new(),
            ability_stats: AbilityStats::default(),
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
            lang: "zh".to_owned(),
        });
        assert_eq!(w.players["a"].state.job, 200);
        let persisted = profile_from_state(
            &w.players["a"].state,
            &w.players["a"].map_id,
            &w.players["a"].death_id,
            w.players["a"].base_max_mp,
        );
        let mut restored = w.players["a"].state.clone();
        restored.job = 0;
        apply_profile(&mut restored, persisted);
        assert_eq!(restored.job, 200);
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
                    max_mp: 0,
                    boss: false,
                    pa_damage: Some(12),
                    pd_damage: None,
                    pd_rate: None,
                    md_rate: None,
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
                    max_mp: 0,
                    boss: false,
                    pa_damage: Some(12),
                    pd_damage: None,
                    pd_rate: None,
                    md_rate: None,
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
                    max_mp: 0,
                    boss: false,
                    pa_damage: Some(12),
                    pd_damage: None,
                    pd_rate: None,
                    md_rate: None,
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

    /// A deterministic boss/world-independent grid mob: step-based movement
    /// (`move_speed` 100 -> 5 px / world tick) so pursuit distance is linear
    /// and easy to assert.  Home/spawn point is `spawn_x` on the `map()` test
    /// floor.
    fn aggro_mob_gameplay(spawn_x: f64) -> Gameplay {
        Gameplay {
            monsters: vec![MonsterTemplate {
                template_id: "100100".into(),
                level: 1,
                max_hp: 100,
                max_mp: 0,
                boss: false,
                pa_damage: Some(3),
                pd_damage: None,
                pd_rate: None,
                md_rate: None,
                exp: 1,
                body_attack: false,
                move_speed: Some(100.0),
                source_speed: None,
                hitbox_width: None,
                hitbox_height: None,
                hitbox_lt: None,
                hitbox_rb: None,
                die_duration_ms: Some(50),
                stand_delay_ms: None,
                move_duration_ms: None,
                drop: None,
            }],
            spawns: vec![MonsterSpawn {
                id: "sa".into(),
                template_id: "100100".into(),
                x: spawn_x,
                y: 100.0,
                foothold_id: Some(1),
                map_id: String::new(),
                facing: 1,
                mob_time: 0,
                rx0: None,
                rx1: None,
            }],
            monster_respawn_ms: Some(500),
            ..Gameplay::default()
        }
    }

    #[test]
    fn monster_pursues_the_character_that_hit_it() {
        let mut w = World::new_with_gameplay(map(), 600, aggro_mob_gameplay(100.0));
        let _rx = join_test_player(&mut w, "a");
        let monster_id = w.monsters.keys().next().cloned().unwrap();
        {
            let player = w.players.get_mut("a").unwrap();
            player.map_id = "test".into();
            player.state.x = 300.0;
            player.state.y = 100.0;
            player.state.action = "stand";
        }
        {
            let mob = w.monsters.get_mut(&monster_id).unwrap();
            mob.state.x = 100.0;
            mob.state.y = 100.0;
            mob.state.action = "stand";
            mob.state.action_started_tick = 0;
            // Take a hit from "a": both remember the attacker and refresh the
            // hold window so the chase does not drop out mid-assertion.
            mark_monster_hit_aggro(mob, "a", w.tick);
            assert_eq!(mob.aggro_target.as_deref(), Some("a"));
            assert!(!mob.returning_home);
        }
        let start_x = w.monsters[&monster_id].state.x;
        // 10 ticks x 5 px keeps the mob closing on the (rightward) target while
        // staying left of the x=200 foothold seam, so facing is stable at 1.
        for _ in 0..10 {
            w.tick += 1;
            w.step_monsters();
        }
        let mob = &w.monsters[&monster_id];
        // The mob leaves idle stand, faces the target and closes ground each
        // step instead of drifting at random.
        assert_eq!(mob.state.action, "move");
        assert_eq!(mob.state.facing, 1);
        assert!(
            mob.state.x > start_x + 30.0,
            "mob should close on the target, moved to {}",
            mob.state.x
        );
    }

    #[test]
    fn monster_drops_aggro_and_walks_home() {
        let mut w = World::new_with_gameplay(map(), 600, aggro_mob_gameplay(100.0));
        let _rx = join_test_player(&mut w, "a");
        let monster_id = w.monsters.keys().next().cloned().unwrap();
        {
            let player = w.players.get_mut("a").unwrap();
            player.map_id = "test".into();
            player.state.x = 300.0;
            player.state.y = 100.0;
        }
        {
            let mob = w.monsters.get_mut(&monster_id).unwrap();
            // The mob pursued deep right (x=300); home is the spawn at x=100.
            mob.state.x = 300.0;
            mob.state.y = 100.0;
            mob.foothold_id = 2; // x=300 sits on foothold 2 (200-500), not 1
            mob.state.action = "move";
            mob.state.action_started_tick = 0;
            mob.aggro_target = Some("a".into());
            // The last hit happened long ago: the hold window already closed,
            // which is the "interest expires" (脱离) case.
            mob.aggro_until = 0;
            mob.returning_home = false;
        }
        w.tick = 5;
        w.step_monsters();
        {
            let mob = &w.monsters[&monster_id];
            assert!(mob.aggro_target.is_none(), "expired aggro must be forgotten");
            assert!(mob.returning_home, "mob must start walking home");
            assert_eq!(mob.state.facing, -1, "walking back toward the spawn");
        }
        let start_x = w.monsters[&monster_id].state.x;
        for _ in 0..30 {
            w.tick += 1;
            w.step_monsters();
        }
        let mob = &w.monsters[&monster_id];
        assert!(
            mob.state.x < start_x - 40.0,
            "mob should walk back toward home ({} -> {})",
            start_x,
            mob.state.x
        );
        assert!(
            mob.returning_home || (mob.state.x - 100.0).abs() <= MOB_HOME_RADIUS + 5.0,
            "still returning or already home"
        );
    }

    #[test]
    fn monster_forgets_a_dead_or_departed_target() {
        let mut w = World::new_with_gameplay(map(), 600, aggro_mob_gameplay(100.0));
        let _rx = join_test_player(&mut w, "a");
        let monster_id = w.monsters.keys().next().cloned().unwrap();
        {
            let player = w.players.get_mut("a").unwrap();
            player.map_id = "test".into();
            player.state.x = 300.0;
            player.state.y = 100.0;
        }
        // A valid aggro window, but the target's body is dead: the mob must
        // treat it as gone immediately (no waiting out the hold window).
        {
            let mob = w.monsters.get_mut(&monster_id).unwrap();
            // Park the mob away from its spawn so the walk-home assert is real.
            mob.state.x = 200.0;
            mob.state.y = 100.0;
            mob.state.action = "move";
            mark_monster_hit_aggro(mob, "a", w.tick);
        }
        w.players.get_mut("a").unwrap().state.action = "dead";
        w.tick = 10;
        w.step_monsters();
        {
            let mob = &w.monsters[&monster_id];
            assert!(mob.aggro_target.is_none());
            assert!(mob.returning_home);
        }
        // Same window, but the target left the map: also forgotten.
        let monster_id2 = w.monsters.keys().next().cloned().unwrap();
        {
            let mob = w.monsters.get_mut(&monster_id2).unwrap();
            mob.state.x = 200.0;
            mob.state.action = "move";
            mark_monster_hit_aggro(mob, "a", w.tick);
            assert!(mob.aggro_target.is_some());
        }
        w.players.get_mut("a").unwrap().map_id = "another-map".into();
        w.players.get_mut("a").unwrap().state.action = "stand";
        w.tick = 11;
        w.step_monsters();
        let mob = &w.monsters[&monster_id2];
        assert!(mob.aggro_target.is_none(), "off-map target is not pursued");
        assert!(mob.returning_home);
    }

    #[test]
    fn monster_gives_up_when_target_flees_beyond_the_leash() {
        let mut w = World::new_with_gameplay(map(), 600, aggro_mob_gameplay(100.0));
        let _rx = join_test_player(&mut w, "a");
        let monster_id = w.monsters.keys().next().cloned().unwrap();
        {
            let player = w.players.get_mut("a").unwrap();
            player.map_id = "test".into();
            player.state.x = 300.0;
            player.state.y = 100.0;
        }
        {
            let mob = w.monsters.get_mut(&monster_id).unwrap();
            mob.state.x = 200.0;
            mob.state.y = 100.0;
            mob.state.action = "move";
            mob.state.action_started_tick = 0;
            mark_monster_hit_aggro(mob, "a", w.tick);
        }
        // The player runs off past the leash radius (spawn 100 + leash 900).
        w.players.get_mut("a").unwrap().state.x = 1100.0;
        w.tick = 3;
        w.step_monsters();
        {
            let mob = &w.monsters[&monster_id];
            assert!(mob.aggro_target.is_none(), "out-of-leash target is dropped");
            assert!(mob.returning_home);
            assert_eq!(mob.state.facing, -1);
        }
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
            ..PlayerConfig::default()
        }
        .contact_damage(&monster);
        assert_eq!(damage, Some(9));
        assert_eq!(PlayerConfig::default().contact_damage(&monster), Some(12));
        assert_eq!(
            PlayerConfig {
                weapon_defense: Some(100),
                ..PlayerConfig::default()
            }
            .contact_damage(&monster),
            Some(1)
        );
        let mut harmless = monster.clone();
        harmless.body_attack = false;
        assert_eq!(player.contact_damage(&harmless), None);
        harmless.body_attack = true;
        harmless.pa_damage = None;
        assert_eq!(player.contact_damage(&harmless), None);
    }

    #[test]
    fn equipment_replaces_starter_stats_and_never_accumulates() {
        use crate::protocol::InventoryItem;
        let config = PlayerConfig {
            base_str: Some(4),
            base_dex: Some(4),
            weapon_type: Some(130),
            weapon_watk: Some(15),
            weapon_defense: Some(2),
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
        let derived = config.with_equipment(&equipped, config.job.unwrap_or(0));
        assert_eq!(derived.weapon_watk, Some(15));
        assert_eq!(derived.weapon_defense, Some(2));
        assert_eq!(derived.attack_range(), config.attack_range());
        // The runtime role is authoritative even if the startup config still
        // describes another role (or no role at all).
        assert_eq!(config.with_equipment(&equipped, 200).job, Some(200));
        let mut upgraded = equipped.clone();
        upgraded[1].stats = Some(BTreeMap::from([
            ("incPDD".into(), 8),
            ("incMHP".into(), 10),
        ]));
        let upgraded_stats = config.with_equipment(&upgraded, config.job.unwrap_or(0));
        assert_eq!(upgraded_stats.weapon_defense, Some(8));
        assert_eq!(upgraded_stats.max_hp, Some(60));
        assert_eq!(
            config
                .with_equipment(&upgraded, config.job.unwrap_or(0))
                .max_hp,
            Some(60)
        );
        assert_eq!(
            config
                .with_equipment(&[], config.job.unwrap_or(0))
                .weapon_watk,
            Some(0)
        );
        assert_eq!(
            config.with_equipment(&[], config.job.unwrap_or(0)).max_hp,
            Some(50)
        );
    }

    /// A snail (contact box 82..119 at x=100) that body-attacks, with the given
    /// player tenacity, on the shared test map.
    fn contact_hit_world(tenacity: f64) -> World {
        // Use the real 273 player config: no weaponDefense or standardPdd.
        let mut gameplay = Gameplay::load(Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../shared/gameplay.json"
        )))
        .unwrap();
        gameplay.player.tenacity = Some(tenacity);
        let mut snail = gameplay
            .monsters
            .iter()
            .find(|mob| mob.template_id == "100000")
            .unwrap()
            .clone();
        snail.move_speed = Some(0.0);
        snail.drop = None; // This fixture exercises contact, not the drop table.
        World::new_with_gameplay(
            map(),
            600,
            Gameplay {
                player: gameplay.player,
                monsters: vec![snail],
                spawns: vec![MonsterSpawn {
                    id: "s1".into(),
                    template_id: "100000".into(),
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
        )
    }

    #[test]
    fn contact_hit_knocks_player_back_and_broadcasts_damage_event() {
        let mut w = contact_hit_world(0.0);
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
            lang: "zh".to_owned(),
        });
        while rx.try_recv().is_ok() {}
        // Stand the player inside the snail's contact box (x 82..119 around a
        // monster centred at x=100), to the monster's right side.
        {
            let player = w.players.get_mut("a").unwrap();
            player.state.x = 118.0;
            player.state.y = 100.0;
            player.state.grounded = true;
            player.state.hp = 50;
            player.state.action = "stand";
            player.foothold_id = 1;
            player.last_foothold_id = 1;
            player.contact_invulnerable_until = 0;
        }
        {
            let monster = w.monsters.values_mut().next().unwrap();
            monster.state.x = 100.0;
            monster.state.y = 100.0;
            monster.state.action = "stand";
            monster.horizontal_speed = 0.0;
        }
        let map_id = w.players["a"].map_id.clone();
        w.monsters.values_mut().next().unwrap().map_id = "other-map".into();
        w.apply_contact_damage();
        assert_eq!(
            w.players["a"].state.hp, 50,
            "another map cannot cause contact damage"
        );
        w.monsters.values_mut().next().unwrap().map_id = map_id;
        w.pending_attacks.insert(
            "interrupted".into(),
            PendingAttack {
                player_id: "a".into(),
                request_id: "attack-before-hit".into(),
                action_id: "interrupted".into(),
                hit_tick: w.tick + 10,
            },
        );
        let start_x = w.players["a"].state.x;
        let start_tick = w.tick;
        w.step();
        let p = &w.players["a"];
        assert_eq!(p.state.hp, 49, "contact damage applies once");
        assert!(
            w.pending_attacks.is_empty(),
            "hit cancels unresolved attacks"
        );
        assert_eq!(p.knockback_until, start_tick + 1 + KNOCKBACK_TICKS);
        // The hit starts a short hop: the body leaves the foothold with the
        // tenacity-0 impulse and shows the jump pose while airborne.
        assert_eq!(
            p.knockback_vx, KNOCKBACK_SPEED,
            "pushed away from the monster"
        );
        assert_eq!(p.state.vy, -KNOCKBACK_JUMP);
        assert_eq!(p.state.action, "jump");
        assert!(!p.state.grounded);
        let mut saw_damage_event = false;
        let monster_id = w.monsters.keys().next().cloned().unwrap();
        while let Ok(line) = rx.try_recv() {
            let message: serde_json::Value = serde_json::from_str(&line).unwrap();
            if message["type"] == "damageEvent" && message["targetId"] == "a" {
                saw_damage_event = true;
                assert_eq!(message["damage"], 1);
                assert_eq!(message["killed"], false);
                assert_eq!(message["attackerId"].as_str(), Some(monster_id.as_str()));
            }
        }
        assert!(
            saw_damage_event,
            "player damage is broadcast for the hurt flash"
        );
        w.apply_contact_damage();
        assert_eq!(
            w.players["a"].state.hp, 49,
            "same-tick contact cannot charge twice"
        );
        assert!(
            rx.try_recv().is_err(),
            "invulnerable contact emits no duplicate event"
        );
        // The hop lands a short distance away and stands again: no long ground
        // slide, and no repeated contact damage while invulnerable.
        for _ in 0..12 {
            w.step();
        }
        let travelled = w.players["a"].state.x - start_x;
        assert!(
            travelled > 5.0 && travelled < 90.0,
            "hop travelled a short controlled distance: {travelled}"
        );
        assert!(w.players["a"].state.grounded);
        assert_eq!(w.players["a"].state.hp, 49);
        assert_eq!(w.players["a"].state.action, "stand");
        // At the exact invulnerability deadline a new collision can kill.
        w.tick = w.players["a"].contact_invulnerable_until;
        let player = w.players.get_mut("a").unwrap();
        player.state.x = 118.0;
        player.state.y = 100.0;
        player.state.hp = 1;
        w.apply_contact_damage();
        assert_eq!(w.players["a"].state.hp, 0);
        assert_eq!(w.players["a"].state.action, "dead");
        assert_eq!(w.players["a"].knockback_vx, 0.0);
    }

    #[test]
    fn tenacity_scales_down_the_knockback_hop() {
        let mut w = contact_hit_world(0.5);
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
            lang: "zh".to_owned(),
        });
        while rx.try_recv().is_ok() {}
        {
            let player = w.players.get_mut("a").unwrap();
            player.state.x = 118.0;
            player.state.y = 100.0;
            player.state.grounded = true;
            player.state.hp = 50;
            player.state.action = "stand";
            player.foothold_id = 1;
            player.last_foothold_id = 1;
            player.contact_invulnerable_until = 0;
        }
        {
            let monster = w.monsters.values_mut().next().unwrap();
            monster.state.x = 100.0;
            monster.state.y = 100.0;
            monster.state.action = "stand";
            monster.horizontal_speed = 0.0;
        }
        let start_x = w.players["a"].state.x;
        w.step();
        let p = &w.players["a"];
        // Tenacity 0.5 halves both the horizontal push and the hop height/time
        // (LoL-style reduction), so the same hit barely budges the player.
        assert_eq!(p.knockback_vx, KNOCKBACK_SPEED * 0.5);
        assert_eq!(p.state.vy, -(KNOCKBACK_JUMP * 0.5));
        for _ in 0..12 {
            w.step();
        }
        let travelled = w.players["a"].state.x - start_x;
        assert!(
            travelled < 45.0,
            "high tenacity keeps the hop short: {travelled}"
        );
        assert_eq!(w.players["a"].state.hp, 49);
        assert_eq!(w.players["a"].state.action, "stand");
    }

    #[test]
    fn quest_consume_items_accepts_array_and_boolean_forms() {
        let mut spec = QuestSpec::default();
        spec.complete.conditions.items = vec![QuestItemRequirement {
            item_id: "4000000".into(),
            quantity: 2,
        }];
        spec.complete.consume_items = serde_json::json!([{"itemId":"4000001","quantity":3}]);
        let items = World::quest_consume_items(&spec);
        assert_eq!(items.len(), 1);
        assert_eq!((&*items[0].item_id, items[0].quantity), ("4000001", 3));
        for empty in [serde_json::json!([]), serde_json::json!(false)] {
            spec.complete.consume_items = empty;
            assert!(World::quest_consume_items(&spec).is_empty());
        }
        for fallback in [serde_json::json!(true), serde_json::Value::Null] {
            spec.complete.consume_items = fallback;
            let items = World::quest_consume_items(&spec);
            assert_eq!((&*items[0].item_id, items[0].quantity), ("4000000", 2));
        }
    }

    // Localization/transition unit fixtures are independent of the active content edition.
    fn quest_test_text() -> crate::quest_text::QuestTextCorpus {
        serde_json::from_str(r#"{"quests": {"1021": {"name": {"en": "Roger's Apple", "zh": "罗杰的苹果"}, "log": {"zh": "前往冒险岛路与罗杰对话，使用他给你的罗杰的苹果恢复 HP 到满值。", "en": "Talk to Roger on Maple Road. Use the Roger's Apple he hands you and recover your HP to full."}}, "maple-road-training": {"name": {"en": "Training Camp Check", "zh": "训练营任务确认"}, "log": {"zh": "赛拉让你在离开营地前，先让希娜确认你的训练记录。", "en": "Sera asked you to let Heena confirm your training record before you leave the camp."}}}}"#).unwrap()
    }

    fn quest_profile() -> Profile {
        Profile {
            hp: 50,
            max_hp: 50,
            mp: 5,
            max_mp: 5,
            level: 1,
            job: 0,
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            death_id: String::new(),
            map_id: String::new(),
            x: 0.0,
            y: 0.0,
            inventory: Vec::new(),
            skills: BTreeMap::new(),
            skill_points: BTreeMap::new(),
            ability_stats: AbilityStats::default(),
        }
    }

    /// Join a fresh player against a store-backed world and return the parsed
    /// messages the world pushed (snapshot + questList, in that order).
    fn join_for_quests(
        store: auth::Store,
        account: &str,
        lang: &str,
        quests: &[(&str, &str)],
    ) -> (World, mpsc::Receiver<String>) {
        join_for_quests_with_gameplay(store, account, lang, quests, Gameplay::default())
    }

    fn join_for_quests_with_gameplay(
        store: auth::Store,
        account: &str,
        lang: &str,
        quests: &[(&str, &str)],
        gameplay: Gameplay,
    ) -> (World, mpsc::Receiver<String>) {
        store.load_profile(account, &quest_profile()).unwrap();
        for (quest_id, status) in quests {
            store.save_quest(account, quest_id, status).unwrap();
        }
        let mut world = World::new_with_store(map(), 600, gameplay, store)
            .unwrap()
            .with_quest_text(quest_test_text());
        let (output, rx) = mpsc::channel(128);
        let (reply, _) = oneshot::channel();
        world.command(Command::Join {
            identity: Identity {
                id: account.into(),
                username: "alice".into(),
            },
            connection: "c".into(),
            output,
            reply,
            lang: lang.to_owned(),
        });
        (world, rx)
    }

    fn quest_reward_gameplay() -> Gameplay {
        let mut gameplay = Gameplay::default();
        gameplay.exp_table = vec![15];
        gameplay.quests = vec![
            QuestSpec {
                quest_id: "maple-road-training".into(),
                executable: Some(true),
                reward: QuestReward {
                    mesos: 300,
                    exp: 0,
                    items: vec![],
                },
                ..QuestSpec::default()
            },
            QuestSpec {
                quest_id: "1021".into(),
                executable: Some(true),
                reward: QuestReward {
                    mesos: 0,
                    exp: 10,
                    items: vec![
                        QuestRewardItem {
                            item_id: "2010000".into(),
                            quantity: 3,
                        },
                        QuestRewardItem {
                            item_id: "2010009".into(),
                            quantity: 3,
                        },
                    ],
                },
                ..QuestSpec::default()
            },
        ];
        gameplay
    }

    include!("chapter_acceptance.rs");
    include!("continuation_acceptance.rs");
    include!("third_acceptance.rs");
    include!("boss_acceptance.rs");
    include!("hyper_acceptance.rs");
    include!("water_acceptance.rs");
    include!("chat_acceptance.rs");
    include!("sidewall_acceptance.rs");
    include!("wave_acceptance.rs");
    include!("realmaps.rs");
    include!("away_acceptance.rs");
    include!("reactor_acceptance.rs");
    include!("shop_sell_acceptance.rs");
    include!("consume_acceptance.rs");
    include!("scroll_acceptance.rs");
    include!("storage_acceptance.rs");
    include!("party_acceptance.rs");
    include!("friend_acceptance.rs");
    include!("whisper_acceptance.rs");
    include!("emoticon_acceptance.rs");

    #[test]
    fn quest_list_on_join_is_localized_to_player_language() {
        let path =
            std::env::temp_dir().join(format!("maple-quest-i18n-{}.sqlite3", auth::random_id()));
        let service = auth::start(&path).unwrap();
        let (world, mut rx) = join_for_quests(
            service.store.clone(),
            "a",
            "en",
            &[("1021", "active"), ("maple-road-training", "completed")],
        );
        assert_eq!(world.players["a"].lang, "en");

        let snapshot: serde_json::Value =
            serde_json::from_str(&rx.try_recv().expect("join snapshot")).unwrap();
        assert_eq!(snapshot["type"], "snapshot");
        let list: serde_json::Value =
            serde_json::from_str(&rx.try_recv().expect("quest list after join")).unwrap();
        assert_eq!(list["type"], "questList");
        let quests = list["quests"].as_array().expect("quests array");
        assert_eq!(quests.len(), 2);
        let by_id = |id: &str| {
            quests
                .iter()
                .find(|entry| entry["questId"] == id)
                .expect(id)
                .clone()
        };
        // English locale: English text straight from the corpus.
        let apple = by_id("1021");
        assert_eq!(apple["name"], "Roger's Apple");
        assert_eq!(apple["status"], "active");
        assert_eq!(
            apple["summary"],
            "Talk to Roger on Maple Road. Use the Roger's Apple he hands you and recover your HP to full."
        );
        let training = by_id("maple-road-training");
        assert_eq!(training["name"], "Training Camp Check");
        assert_eq!(training["status"], "completed");
    }

    #[test]
    fn quest_list_defaults_to_zh_when_locale_absent_or_unknown() {
        let path =
            std::env::temp_dir().join(format!("maple-quest-zh-{}.sqlite3", auth::random_id()));
        let service = auth::start(&path).unwrap();
        let (_, mut rx) = join_for_quests(service.store.clone(), "a", "zh", &[("1021", "active")]);
        let _: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        let list: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(list["type"], "questList");
        let entry = &list["quests"][0];
        assert_eq!(entry["questId"], "1021");
        assert_eq!(entry["name"], "罗杰的苹果");
        assert_eq!(
            entry["summary"],
            "前往冒险岛路与罗杰对话，使用他给你的罗杰的苹果恢复 HP 到满值。"
        );
    }

    #[test]
    fn tms273_missing_script_cannot_change_quest_state() {
        let path = std::env::temp_dir().join(format!(
            "maple-quest-disabled-{}.sqlite3",
            auth::random_id()
        ));
        let service = auth::start(&path).unwrap();
        let mut gameplay = Gameplay::default();
        gameplay.quests.push(QuestSpec {
            quest_id: "36301".into(),
            executable: Some(false),
            ..QuestSpec::default()
        });
        let (mut world, mut rx) =
            join_for_quests_with_gameplay(service.store.clone(), "a", "zh", &[], gameplay);
        while rx.try_recv().is_ok() {}
        world.apply_quest_effect("a", npc::QuestEffect::Start("36301".into()));
        let result: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(result["code"], "quest_script_unavailable");
        assert!(!world.players["a"].quests.contains_key("36301"));
        assert!(!service
            .store
            .load_quests("a")
            .unwrap()
            .contains_key("36301"));
    }

    #[test]
    fn quest_transitions_push_localized_quest_update_with_settled_reward() {
        let path =
            std::env::temp_dir().join(format!("maple-quest-update-{}.sqlite3", auth::random_id()));
        let service = auth::start(&path).unwrap();
        let (world, mut rx) = join_for_quests_with_gameplay(
            service.store.clone(),
            "a",
            "zh",
            &[],
            quest_reward_gameplay(),
        );
        // Drain the join snapshot + empty questList.
        while rx.try_recv().is_ok() {}

        let mut world = world;
        world.apply_quest_effect("a", npc::QuestEffect::Start("maple-road-training".into()));
        let accepted: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(accepted["type"], "questUpdate");
        assert_eq!(accepted["questId"], "maple-road-training");
        assert_eq!(accepted["status"], "objectivesComplete");
        assert_eq!(accepted["name"], "训练营任务确认");
        assert_eq!(
            accepted["summary"],
            "赛拉让你在离开营地前，先让希娜确认你的训练记录。"
        );
        assert_eq!(accepted["reward"]["mesos"], 0);
        while rx.try_recv().is_ok() {} // Full log/snapshot follow the transition.

        world.apply_quest_effect(
            "a",
            npc::QuestEffect::Complete("maple-road-training".into()),
        );
        let completed: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(completed["type"], "questUpdate");
        assert_eq!(completed["questId"], "maple-road-training");
        assert_eq!(completed["status"], "completed");
        assert_eq!(completed["name"], "训练营任务确认");
        // Reward reflects exactly what the server settled (300 mesos).
        assert_eq!(completed["reward"]["mesos"], 300);
        assert_eq!(world.players["a"].state.mesos, 300);
    }

    #[test]
    fn quest_completion_grants_configured_exp_and_items() {
        let path = std::env::temp_dir().join(format!(
            "maple-quest-complete-{}.sqlite3",
            auth::random_id()
        ));
        let service = auth::start(&path).unwrap();
        let (world, mut rx) = join_for_quests_with_gameplay(
            service.store.clone(),
            "a",
            "zh",
            &[],
            quest_reward_gameplay(),
        );
        // Drain the join snapshot + empty questList.
        while rx.try_recv().is_ok() {}

        let mut world = world;
        world.apply_quest_effect("a", npc::QuestEffect::Start("1021".into()));
        let accepted: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(accepted["status"], "objectivesComplete");
        while rx.try_recv().is_ok() {}

        world.apply_quest_effect("a", npc::QuestEffect::Complete("1021".into()));
        let completed: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(completed["status"], "completed");
        assert_eq!(completed["reward"]["exp"], 10);
        assert_eq!(completed["reward"]["mesos"], 0);
        let reward_items = completed["reward"]["items"]
            .as_array()
            .expect("reward items");
        assert_eq!(reward_items.len(), 2);
        let mut rewards = reward_items
            .iter()
            .map(|item| {
                (
                    item["itemId"].as_str().expect("item id"),
                    item["quantity"].as_u64().expect("item qty"),
                )
            })
            .collect::<Vec<_>>();
        rewards.sort_by(|a, b| a.0.cmp(b.0));
        assert_eq!(rewards[0], ("2010000", 3));
        assert_eq!(rewards[1], ("2010009", 3));
        assert_eq!(world.players["a"].state.exp, 10);
        assert_eq!(world.players["a"].state.exp_to_next, 15);
        let item_total = |id| {
            world.players["a"]
                .state
                .inventory
                .iter()
                .find(|item| item.item_id == id)
                .map(|item| item.quantity)
                .unwrap_or_default()
        };
        assert_eq!(item_total("2010000"), 3);
        assert_eq!(item_total("2010009"), 3);
    }

    fn mage_gameplay() -> Gameplay {
        let script: npc::DialogueScript = serde_json::from_str(
            r#"{"start":"choose","nodes":{
                "choose":{"menu":{"text":{"zh":"请选择职业。","en":"Choose a job."},"options":[{"index":0,"text":{"zh":"法师","en":"Magician"},"next":"advance"}]}},
                "advance":{"act":{"kind":"jobAdvance","fromJob":0,"job":200,"next":"advanced"}},
                "advanced":{"say":{"text":{"zh":"转职成功！你现在是一名法师了。","en":"Job advancement complete!"},"kind":"ok"}}}}"#,
        )
        .unwrap();
        Gameplay {
            npcs: vec![NpcTemplate {
                template_id: MAGE_ADVANCE_TEMPLATE_ID.into(),
                name: "Grendel".into(),
                func: "Magician instructor".into(),
                shop_id: None,
                script: Some(script),
                stand: Vec::new(),
            }],
            npc_spawns: vec![NpcSpawn {
                id: MAGE_ADVANCE_NPC_ID.into(),
                template_id: MAGE_ADVANCE_TEMPLATE_ID.into(),
                x: 100.0,
                y: 0.0,
                foothold_id: Some(1),
                map_id: MAGE_ADVANCE_MAP_ID.into(),
                facing: -1,
            }],
            ..Gameplay::default()
        }
    }

    fn mage_map() -> Map {
        let mut map = map();
        map.id = MAGE_ADVANCE_MAP_ID.into();
        map.spawn = Point { x: 100.0, y: 0.0 };
        map
    }

    #[test]
    fn mage_job_advance_is_menu_bound_authorized_and_persisted() {
        let path =
            std::env::temp_dir().join(format!("maple-mage-transfer-{}.sqlite3", auth::random_id()));
        let service = auth::start(&path).unwrap();
        let mut beginner = quest_profile();
        beginner.hp = 37;
        beginner.mp = 4;
        beginner.level = 9;
        service.store.load_profile("beginner", &beginner).unwrap();
        let mut magician = quest_profile();
        magician.job = MAGICIAN_JOB;
        service.store.load_profile("magician", &magician).unwrap();
        let mut other = quest_profile();
        other.job = 220;
        service.store.load_profile("other", &other).unwrap();
        service
            .store
            .load_profile("beginner2", &quest_profile())
            .unwrap();

        let mut world =
            World::new_with_store(mage_map(), 600, mage_gameplay(), service.store.clone()).unwrap();
        let join = |world: &mut World, account: &str, connection: &str| {
            let (output, rx) = mpsc::channel(128);
            let (reply, _) = oneshot::channel();
            world.command(Command::Join {
                identity: Identity {
                    id: account.into(),
                    username: account.into(),
                },
                connection: connection.into(),
                output,
                reply,
                lang: "zh".into(),
            });
            rx
        };
        let mut beginner_rx = join(&mut world, "beginner", "beginner-1");
        let mut beginner2_rx = join(&mut world, "beginner2", "beginner2-1");
        let mut magician_rx = join(&mut world, "magician", "magician-1");
        let mut other_rx = join(&mut world, "other", "other-1");
        while beginner_rx.try_recv().is_ok() {}
        while beginner2_rx.try_recv().is_ok() {}
        while magician_rx.try_recv().is_ok() {}
        while other_rx.try_recv().is_ok() {}

        let marker = |snapshot: &str| {
            let value: serde_json::Value = serde_json::from_str(snapshot).unwrap();
            value["npcs"]
                .as_array()
                .unwrap()
                .iter()
                .find(|npc| npc["id"] == MAGE_ADVANCE_NPC_ID)
                .unwrap()
                .get("jobAdvancementAvailable")
                .cloned()
        };
        assert_eq!(
            marker(&world.snapshot("beginner")),
            Some(serde_json::Value::Bool(true))
        );
        assert_eq!(
            marker(&world.snapshot("beginner2")),
            Some(serde_json::Value::Bool(true))
        );
        assert_eq!(
            marker(&world.snapshot("magician")),
            Some(serde_json::Value::Bool(true))
        );
        assert_eq!(
            marker(&world.snapshot("other")),
            Some(serde_json::Value::Bool(true))
        );

        // The 选择岔道 magician instructor has no talk range: a beginner far
        // away still gets the menu, and only the death guard can refuse.
        world.players.get_mut("beginner").unwrap().state.x = 250.0;
        world.handle_npc_talk(
            "beginner".into(),
            "far".into(),
            MAGE_ADVANCE_NPC_ID.into(),
            Some("start"),
            None,
        );
        let far: serde_json::Value =
            serde_json::from_str(&beginner_rx.try_recv().unwrap()).unwrap();
        assert_eq!(far["type"], "npcResult");
        assert_eq!(far["dialog"]["kind"], "simple");
        assert_eq!(world.players["beginner"].state.job, BEGINNER_JOB);
        world.end_conversation("beginner");

        world.players.get_mut("beginner").unwrap().state.x = 100.0;
        world.handle_npc_talk(
            "beginner".into(),
            "no-session".into(),
            MAGE_ADVANCE_NPC_ID.into(),
            Some("select"),
            Some(0),
        );
        let no_session: serde_json::Value =
            serde_json::from_str(&beginner_rx.try_recv().unwrap()).unwrap();
        assert_eq!(no_session["code"], "npc_step_invalid");
        assert_eq!(world.players["beginner"].state.job, BEGINNER_JOB);

        world.players.get_mut("beginner").unwrap().state.hp = 0;
        world.players.get_mut("beginner").unwrap().state.action = "dead";
        assert_eq!(marker(&world.snapshot("beginner")), None);
        world.handle_npc_talk(
            "beginner".into(),
            "dead".into(),
            MAGE_ADVANCE_NPC_ID.into(),
            Some("start"),
            None,
        );
        let dead: serde_json::Value =
            serde_json::from_str(&beginner_rx.try_recv().unwrap()).unwrap();
        assert_eq!(dead["code"], "job_advance_unavailable");
        world.players.get_mut("beginner").unwrap().state.hp = 37;
        world.players.get_mut("beginner").unwrap().state.action = "stand";

        world.handle_npc_talk(
            "beginner".into(),
            "open".into(),
            MAGE_ADVANCE_NPC_ID.into(),
            Some("start"),
            None,
        );
        let menu: serde_json::Value =
            serde_json::from_str(&beginner_rx.try_recv().unwrap()).unwrap();
        assert_eq!(menu["dialog"]["kind"], "simple");
        assert_eq!(menu["dialog"]["options"][0]["text"], "法师");

        // A second beginner cannot continue the first player's menu session.
        world.handle_npc_talk(
            "beginner2".into(),
            "cross-player".into(),
            MAGE_ADVANCE_NPC_ID.into(),
            Some("select"),
            Some(0),
        );
        let cross_player: serde_json::Value =
            serde_json::from_str(&beginner2_rx.try_recv().unwrap()).unwrap();
        assert_eq!(cross_player["code"], "npc_step_invalid");
        assert_eq!(world.players["beginner2"].state.job, BEGINNER_JOB);

        world.handle_npc_talk(
            "beginner".into(),
            "choose".into(),
            MAGE_ADVANCE_NPC_ID.into(),
            Some("select"),
            Some(0),
        );
        let success: serde_json::Value =
            serde_json::from_str(&beginner_rx.try_recv().unwrap()).unwrap();
        assert_eq!(success["dialog"]["kind"], "ok");
        assert_eq!(success["dialog"]["text"], "转职成功！你现在是一名法师了。");
        assert_eq!(world.players["beginner"].state.job, MAGICIAN_JOB);
        let persisted = service
            .store
            .load_profile("beginner", &quest_profile())
            .unwrap();
        assert_eq!(persisted.job, MAGICIAN_JOB);
        assert_eq!(persisted.hp, 37);
        assert_eq!(persisted.mp, 100);
        assert_eq!(persisted.level, 9);

        // A transferred magician receives a separate, idempotent training
        // menu.  The restore option only refills MP and never grants another
        // SP/hidden-skill bundle.
        world.handle_npc_talk(
            "beginner".into(),
            "training".into(),
            MAGE_ADVANCE_NPC_ID.into(),
            Some("start"),
            None,
        );
        let training: serde_json::Value =
            serde_json::from_str(&beginner_rx.try_recv().unwrap()).unwrap();
        assert_eq!(training["dialog"]["options"][1]["text"], "恢复魔力");
        let sp_before_restore = service
            .store
            .load_profile("beginner", &quest_profile())
            .unwrap()
            .skill_points
            .get(&MAGE_BOOK)
            .copied();
        world.players.get_mut("beginner").unwrap().state.mp = 1;
        world.handle_npc_talk(
            "beginner".into(),
            "restore".into(),
            MAGE_ADVANCE_NPC_ID.into(),
            Some("select"),
            Some(1),
        );
        let restore: serde_json::Value =
            serde_json::from_str(&beginner_rx.try_recv().unwrap()).unwrap();
        assert_eq!(restore["trainingResult"]["mp"], 100);
        assert_eq!(
            service
                .store
                .load_profile("beginner", &quest_profile())
                .unwrap()
                .job,
            MAGICIAN_JOB
        );
        assert_eq!(
            service
                .store
                .load_profile("beginner", &quest_profile())
                .unwrap()
                .skill_points
                .get(&MAGE_BOOK)
                .copied(),
            sp_before_restore
        );

        world.handle_npc_talk(
            "magician".into(),
            "already".into(),
            MAGE_ADVANCE_NPC_ID.into(),
            Some("start"),
            None,
        );
        let already: serde_json::Value =
            serde_json::from_str(&magician_rx.try_recv().unwrap()).unwrap();
        assert_eq!(already["dialog"]["kind"], "simple");
        assert_eq!(already["dialog"]["options"][0]["text"], "打开法师技能");
        assert!(service
            .store
            .load_profile("magician", &quest_profile())
            .unwrap()
            .skill_points
            .get(&MAGE_BOOK)
            .is_none());
        world.handle_npc_talk(
            "magician".into(),
            "already-select".into(),
            MAGE_ADVANCE_NPC_ID.into(),
            Some("select"),
            Some(0),
        );
        let already_selected: serde_json::Value =
            serde_json::from_str(&magician_rx.try_recv().unwrap()).unwrap();
        assert_eq!(already_selected["openSkills"], true);
        let supported = service
            .store
            .load_profile("magician", &quest_profile())
            .unwrap();
        assert_eq!(supported.skill_points.get(&MAGE_BOOK), Some(&5));
        assert_eq!(supported.skills.get(&SKILL_ELEMENTAL_WEAKEN), Some(&1));

        world.handle_npc_talk(
            "other".into(),
            "wrong-job".into(),
            MAGE_ADVANCE_NPC_ID.into(),
            Some("start"),
            None,
        );
        let wrong_job: serde_json::Value =
            serde_json::from_str(&other_rx.try_recv().unwrap()).unwrap();
        assert_eq!(wrong_job["dialog"]["kind"], "simple");
        assert_eq!(wrong_job["dialog"]["options"][0]["text"], "打开法师技能");
        assert_eq!(world.players["other"].state.job, 220);

        world.command(Command::Leave {
            id: "beginner".into(),
            connection: "beginner-1".into(),
        });
        let beginner_rx = join(&mut world, "beginner", "beginner-2");
        let mut beginner_rx = beginner_rx;
        let reconnected: serde_json::Value =
            serde_json::from_str(&beginner_rx.try_recv().unwrap()).unwrap();
        assert_eq!(world.players["beginner"].state.job, MAGICIAN_JOB);
        assert_eq!(
            marker(&reconnected.to_string()),
            Some(serde_json::Value::Bool(true))
        );
    }

    #[test]
    fn mage_skill_runtime_covers_learning_targets_replay_guard_teleport_and_wave() {
        let mut gameplay = life_gameplay(vec![
            life_spawn("mage-m1", "test", 140.0, 1, -1),
            life_spawn("mage-m2", "test", 160.0, 1, -1),
            life_spawn("mage-m3", "test", 180.0, 1, -1),
            life_spawn("mage-m4", "test", 200.0, 1, -1),
        ]);
        for template in &mut gameplay.monsters {
            template.max_hp = 1_000;
        }
        gameplay.player.base_int = Some(4);
        gameplay.player.base_luk = Some(1);
        gameplay.player.max_mp = Some(5);
        let mut world = World::new_with_gameplay(map(), 600, gameplay)
            .with_mage_skills(crate::mage::MageSkills::bundled());
        let (output, mut rx) = mpsc::channel(256);
        let (reply, _) = oneshot::channel();
        world.command(Command::Join {
            identity: Identity {
                id: "mage-runtime".into(),
                username: "mage-runtime".into(),
            },
            connection: "mage-runtime-connection".into(),
            output,
            reply,
            lang: "zh".into(),
        });
        while rx.try_recv().is_ok() {}
        let drain = |rx: &mut mpsc::Receiver<String>| {
            let mut values = Vec::new();
            while let Ok(message) = rx.try_recv() {
                values.push(serde_json::from_str::<serde_json::Value>(&message).unwrap());
            }
            values
        };

        {
            let player = world.players.get_mut("mage-runtime").unwrap();
            player.state.job = MAGICIAN_JOB;
            player.base_max_mp = 100;
            player.state.level = 1;
            player.state.hp = 50;
            player.state.max_hp = 50;
            player.state.mp = 100;
            player.state.skills = BTreeMap::from([
                (SKILL_MAGIC_BOOST, 1),
                (SKILL_ELEMENTAL_WEAKEN, 1),
                (SKILL_MAGIC_SHIELD, 1),
                (SKILL_MAGIC_WAVE_HIDDEN, 1),
            ]);
            player.state.skill_points = BTreeMap::from([(MAGE_BOOK, 5)]);
            player.state.x = 100.0;
            player.state.y = 100.0;
            player.state.grounded = true;
            player.state.action = "stand";
            player.foothold_id = 1;
            player.last_foothold_id = 1;
            refresh_player_derived(&world.gameplay, &world.mage_skills, player);
        }
        let initial_magic_attack = world.players["mage-runtime"]
            .state
            .derived_stats
            .magic_attack;
        let initial_max_mp = world.players["mage-runtime"].state.max_mp;
        let initial_mp = world.players["mage-runtime"].state.mp;
        assert!(initial_magic_attack > 0);
        assert_eq!(
            world.players["mage-runtime"].state.derived_stats.strength,
            Some(12)
        );
        assert_eq!(
            world.players["mage-runtime"]
                .state
                .derived_stats
                .intelligence,
            Some(4)
        );
        assert_eq!(
            world.players["mage-runtime"].state.derived_stats.luck,
            Some(4)
        );
        assert!(initial_max_mp >= 126);

        let learn =
            |world: &mut World, rx: &mut mpsc::Receiver<String>, request_id: &str, skill_id| {
                world.handle_learn_skill("mage-runtime".into(), request_id.into(), skill_id);
                let value: serde_json::Value =
                    serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
                assert_eq!(value["type"], "skillResult");
                assert_eq!(value["success"], true);
            };
        learn(&mut world, &mut rx, "learn-energy", SKILL_ENERGY_BOLT);
        learn(&mut world, &mut rx, "learn-guard", SKILL_MAGIC_GUARD);
        learn(&mut world, &mut rx, "learn-teleport", SKILL_TELEPORT);
        learn(&mut world, &mut rx, "learn-wave", SKILL_MAGIC_WAVE);
        assert_eq!(
            world.players["mage-runtime"].state.skill_points[&MAGE_BOOK],
            1
        );

        world.handle_cast_skill(
            "mage-runtime".into(),
            "bolt-1".into(),
            SKILL_ENERGY_BOLT,
            Some(1),
            Some(0),
        );
        let first_cast = drain(&mut rx);
        let skill_cast = first_cast
            .iter()
            .find(|value| value["type"] == "skillCast")
            .expect("energy skillCast");
        assert_eq!(skill_cast["playerId"], "mage-runtime");
        assert_eq!(skill_cast["targetId"].as_str().is_some(), true);
        assert!(skill_cast["targetX"].is_number());
        assert!(skill_cast["targetY"].is_number());
        let damage_events = first_cast
            .iter()
            .filter(|value| value["type"] == "damageEvent")
            .collect::<Vec<_>>();
        assert_eq!(
            damage_events.len(),
            16,
            "four targets and four source segments"
        );
        assert!(damage_events.iter().all(|event| {
            event["skillId"] == SKILL_ENERGY_BOLT
                && event["targetCount"] == 4
                && event["segment"]
                    .as_u64()
                    .is_some_and(|segment| (1..=4).contains(&segment))
        }));
        let mp_after_first_cast = world.players["mage-runtime"].state.mp;
        assert_eq!(mp_after_first_cast, initial_mp - 16);

        world.handle_cast_skill(
            "mage-runtime".into(),
            "bolt-1".into(),
            SKILL_ENERGY_BOLT,
            Some(1),
            Some(0),
        );
        let replay = drain(&mut rx);
        assert_eq!(
            replay.len(),
            1,
            "a resolved cast replay only returns its result"
        );
        assert_eq!(replay[0]["success"], true);
        assert_eq!(world.players["mage-runtime"].state.mp, mp_after_first_cast);

        let equipped_wand = crate::protocol::InventoryItem {
            slot: 11,
            item_id: "1372000".into(),
            quantity: 1,
            stats: Some(BTreeMap::from([
                ("incINT".into(), 5),
                ("incMMP".into(), 10),
            ])),
            ..crate::protocol::InventoryItem::default()
        };
        {
            let player = world.players.get_mut("mage-runtime").unwrap();
            player.state.equipped = vec![equipped_wand];
            refresh_player_derived(&world.gameplay, &world.mage_skills, player);
        }
        assert_eq!(
            world.players["mage-runtime"]
                .state
                .derived_stats
                .magic_attack,
            initial_magic_attack + 20
        );
        assert_eq!(
            world.players["mage-runtime"].state.max_mp,
            initial_max_mp + 10
        );
        assert!(world.players["mage-runtime"].move_speed > WALK_SPEED);
        {
            let player = world.players.get_mut("mage-runtime").unwrap();
            player.state.equipped.clear();
            refresh_player_derived(&world.gameplay, &world.mage_skills, player);
        }

        world.handle_cast_skill(
            "mage-runtime".into(),
            "guard-on".into(),
            SKILL_MAGIC_GUARD,
            Some(0),
            Some(0),
        );
        let guard_result = drain(&mut rx)
            .into_iter()
            .find(|value| value["type"] == "skillResult")
            .expect("guard result");
        assert_eq!(guard_result["success"], true);
        assert!(world.players["mage-runtime"].magic_guard);
        assert!(
            world.players["mage-runtime"]
                .state
                .derived_stats
                .magic_guard
        );
        let mp_before_contact = world.players["mage-runtime"].state.mp;
        {
            let monster = world.monsters.values_mut().next().unwrap();
            monster.template.body_attack = true;
            monster.template.pa_damage = Some(20);
        }
        {
            let monster_x = world.monsters.values().next().unwrap().state.x;
            let player = world.players.get_mut("mage-runtime").unwrap();
            player.state.x = monster_x;
            player.state.y = 100.0;
            player.state.grounded = true;
            player.state.action = "stand";
            player.foothold_id = 1;
            player.contact_invulnerable_until = 0;
        }
        let hp_before_contact = world.players["mage-runtime"].state.hp;
        // Source shield gives 10 PDD; guard absorbs ceil((20 - 10) * 22%).
        let expected_mp_damage = 3.min(mp_before_contact);
        world.apply_contact_damage();
        assert_eq!(
            world.players["mage-runtime"].state.hp,
            hp_before_contact - (10 - expected_mp_damage)
        );
        assert_eq!(
            world.players["mage-runtime"].state.mp,
            mp_before_contact - expected_mp_damage
        );
        while rx.try_recv().is_ok() {}

        world.handle_cast_skill(
            "mage-runtime".into(),
            "guard-off".into(),
            SKILL_MAGIC_GUARD,
            Some(0),
            Some(0),
        );
        let guard_off = drain(&mut rx)
            .into_iter()
            .find(|value| value["type"] == "skillResult")
            .expect("guard-off result");
        assert_eq!(guard_off["success"], true);
        assert!(
            !world.players["mage-runtime"]
                .state
                .derived_stats
                .magic_guard
        );

        {
            let player = world.players.get_mut("mage-runtime").unwrap();
            player.state.x = 100.0;
            player.state.y = 100.0;
            player.state.grounded = true;
            player.state.action = "stand";
            player.foothold_id = 1;
        }
        let mp_before_teleport = world.players["mage-runtime"].state.mp;
        world.handle_cast_skill(
            "mage-runtime".into(),
            "teleport-right".into(),
            SKILL_TELEPORT,
            Some(1),
            Some(0),
        );
        let teleport = drain(&mut rx)
            .into_iter()
            .find(|value| value["type"] == "skillResult")
            .expect("teleport result");
        assert_eq!(teleport["success"], true);
        assert!(world.players["mage-runtime"].state.x > 100.0);
        // 用户指定规则：瞬移全等级扣 10 MP（原版为 28→20）。
        assert_eq!(
            world.players["mage-runtime"].state.mp,
            mp_before_teleport - 10
        );
        // 冷却内不允许再次瞬移，且被拒时不扣 MP。
        world.handle_cast_skill(
            "mage-runtime".into(),
            "teleport-cooldown".into(),
            SKILL_TELEPORT,
            Some(1),
            Some(0),
        );
        let cooling = drain(&mut rx).into_iter().next().expect("cooldown result");
        assert_eq!(cooling["type"], "rejected");
        assert_eq!(cooling["code"], "skill_cooldown");
        assert_eq!(
            world.players["mage-runtime"].state.mp,
            mp_before_teleport - 10
        );
        assert_eq!(
            world.players["mage-runtime"]
                .skill_cooldowns
                .get(&SKILL_TELEPORT)
                .copied(),
            Some(1_200)
        );
        // 等级越高冷却越短：5 级为 600ms（P 值，见覆盖表）。
        {
            let player = world.players.get_mut("mage-runtime").unwrap();
            player.skill_cooldowns.remove(&SKILL_TELEPORT);
            player.state.skills.insert(SKILL_TELEPORT, 5);
        }
        let mp_before_level_five = world.players["mage-runtime"].state.mp;
        world.handle_cast_skill(
            "mage-runtime".into(),
            "teleport-level-five".into(),
            SKILL_TELEPORT,
            Some(1),
            Some(0),
        );
        let level_five = drain(&mut rx)
            .into_iter()
            .find(|value| value["type"] == "skillResult")
            .expect("level five teleport result");
        assert_eq!(level_five["success"], true);
        assert_eq!(
            world.players["mage-runtime"].state.mp,
            mp_before_level_five - 10
        );
        assert_eq!(
            world.players["mage-runtime"]
                .skill_cooldowns
                .get(&SKILL_TELEPORT)
                .copied(),
            Some(600)
        );
        {
            let player = world.players.get_mut("mage-runtime").unwrap();
            player.skill_cooldowns.remove(&SKILL_TELEPORT);
            player.state.skills.insert(SKILL_TELEPORT, 1);
        }
        {
            let player = world.players.get_mut("mage-runtime").unwrap();
            player.state.x = 475.0;
            player.state.y = 191.6666666667;
            player.state.grounded = true;
            player.state.action = "stand";
            player.foothold_id = 2;
        }
        let mp_before_blocked_teleport = world.players["mage-runtime"].state.mp;
        world.handle_cast_skill(
            "mage-runtime".into(),
            "teleport-blocked".into(),
            SKILL_TELEPORT,
            Some(1),
            Some(0),
        );
        let blocked = drain(&mut rx).into_iter().next().expect("blocked result");
        assert_eq!(blocked["type"], "rejected");
        assert_eq!(blocked["code"], "teleport_blocked");
        assert_eq!(
            world.players["mage-runtime"].state.mp,
            mp_before_blocked_teleport
        );

        {
            let player = world.players.get_mut("mage-runtime").unwrap();
            player.state.x = 100.0;
            player.state.y = 100.0;
            player.state.grounded = true;
            player.state.action = "stand";
            player.foothold_id = 1;
        }
        world.handle_cast_skill(
            "mage-runtime".into(),
            "wave-up".into(),
            SKILL_MAGIC_WAVE,
            Some(0),
            Some(-1),
        );
        let wave_up = drain(&mut rx)
            .into_iter()
            .find(|value| value["type"] == "skillResult")
            .expect("wave-up result");
        assert_eq!(wave_up["success"], true);
        assert!(world.players["mage-runtime"].magic_wave_used);
        assert!(!world.players["mage-runtime"].magic_wave_float_used);
        // The casted wave must climb 1.5x a normal jump and keep floating.
        let wave_launch = world.players["mage-runtime"].state.vy;
        assert!(
            (wave_launch.abs() - JUMP_SPEED * MAGIC_WAVE_LAUNCH_HEIGHT_RATIO.sqrt()).abs() < 1.0,
            "魔力波動 should launch at 1.5x the normal jump displacement"
        );
        assert!(world.players["mage-runtime"].slow_fall_until > world.tick);
        world.handle_cast_skill(
            "mage-runtime".into(),
            "wave-float".into(),
            SKILL_MAGIC_WAVE_HIDDEN,
            Some(0),
            Some(1),
        );
        let wave_messages = drain(&mut rx);
        let wave_float = wave_messages
            .iter()
            .find(|value| value["type"] == "skillResult")
            .expect("wave-float result");
        let wave_event = wave_messages
            .iter()
            .find(|value| value["type"] == "skillCast")
            .expect("wave-float event");
        assert_eq!(wave_float["success"], true);
        assert_eq!(wave_event["durationMs"], 5_000);
        assert!(world.players["mage-runtime"].magic_wave_float_used);
        assert!(world.players["mage-runtime"].slow_fall_until > world.tick);
        assert_eq!(world.players["mage-runtime"].state.action, "jump");
    }

    #[test]
    fn world_growth_and_allocate_ap_are_personal_and_idempotent() {
        let mut world = World::new(map(), 600);
        let (output, mut rx) = mpsc::channel(128);
        let (reply, _) = oneshot::channel();
        world.command(Command::Join {
            identity: Identity {
                id: "growth".into(),
                username: "growth".into(),
            },
            connection: "growth-connection".into(),
            output,
            reply,
            lang: "zh".into(),
        });
        while rx.try_recv().is_ok() {}
        {
            let player = world.players.get_mut("growth").unwrap();
            player.state.job = ICE_MAGE_JOB;
            player.state.level = 1;
            player.state.exp = 79;
            player.state.exp_to_next = 80;
            player.state.skill_points.clear();
            player.state.ability_stats.available_ap = 0;
        }
        World::add_exp(
            &mut world.players.get_mut("growth").unwrap().state,
            1,
            &[80, 160, 0],
        );
        assert_eq!(world.players["growth"].state.level, 2);
        assert_eq!(world.players["growth"].state.ability_stats.available_ap, 5);
        assert_eq!(world.players["growth"].state.skill_points[&ICE_BOOK], 3);
        assert_eq!(world.players["growth"].state.exp_to_next, 160);
        World::add_exp(
            &mut world.players.get_mut("growth").unwrap().state,
            160,
            &[80, 160, 0],
        );
        assert_eq!(world.players["growth"].state.level, 3);
        assert_eq!(world.players["growth"].state.ability_stats.available_ap, 10);
        assert_eq!(world.players["growth"].state.exp_to_next, 0);

        world.command(Command::Input {
            id: "growth".into(),
            connection: "growth-connection".into(),
            message: ClientMessage::AllocateAp {
                request_id: "ap-1".into(),
                stat: AbilityStat::Intelligence,
            },
        });
        let first: Vec<serde_json::Value> = std::iter::from_fn(|| rx.try_recv().ok())
            .map(|message| serde_json::from_str(&message).unwrap())
            .collect();
        let result = first
            .iter()
            .find(|value| value["type"] == "abilityResult")
            .expect("ability result");
        assert_eq!(result["success"], true);
        assert_eq!(world.players["growth"].state.ability_stats.intelligence, 5);
        assert_eq!(world.players["growth"].state.ability_stats.available_ap, 9);
        assert_eq!(world.equipment_stats("growth").intelligence, 5);

        world.command(Command::Input {
            id: "growth".into(),
            connection: "growth-connection".into(),
            message: ClientMessage::AllocateAp {
                request_id: "ap-1".into(),
                stat: AbilityStat::Intelligence,
            },
        });
        let replay: Vec<serde_json::Value> = std::iter::from_fn(|| rx.try_recv().ok())
            .map(|message| serde_json::from_str(&message).unwrap())
            .collect();
        assert_eq!(
            replay
                .iter()
                .find(|value| value["type"] == "abilityResult")
                .expect("replay result")["abilityStats"]["availableAp"],
            9
        );
        assert_eq!(world.players["growth"].state.ability_stats.intelligence, 5);

        world.command(Command::Input {
            id: "growth".into(),
            connection: "growth-connection".into(),
            message: ClientMessage::AllocateAp {
                request_id: "ap-1".into(),
                stat: AbilityStat::Luck,
            },
        });
        let conflict: Vec<serde_json::Value> = std::iter::from_fn(|| rx.try_recv().ok())
            .map(|message| serde_json::from_str(&message).unwrap())
            .collect();
        assert_eq!(
            conflict
                .iter()
                .find(|value| value["type"] == "abilityResult")
                .expect("conflict result")["code"],
            "request_conflict"
        );
        assert_eq!(world.players["growth"].state.ability_stats.luck, 4);
    }

    #[test]
    fn ice_mage_second_job_skills_damage_freeze_consume_and_path() {
        let mut gameplay = life_gameplay(vec![
            life_spawn("ice-m1", "test", 165.0, 1, -1),
            life_spawn("ice-m2", "test", 175.0, 1, -1),
            life_spawn("ice-m3", "test", 185.0, 1, -1),
            life_spawn("ice-m4", "test", 195.0, 1, -1),
        ]);
        for template in &mut gameplay.monsters {
            template.max_hp = 100_000;
            template.max_mp = 100;
        }
        gameplay.player.max_mp = Some(500);
        let mut world =
            World::new_with_gameplay(map(), 600, gameplay).with_mage_skills(MageSkills::bundled());
        let (output, mut rx) = mpsc::channel(512);
        let (reply, _) = oneshot::channel();
        world.command(Command::Join {
            identity: Identity {
                id: "ice-mage".into(),
                username: "ice-mage".into(),
            },
            connection: "ice-connection".into(),
            output,
            reply,
            lang: "zh".into(),
        });
        while rx.try_recv().is_ok() {}
        let drain = |rx: &mut mpsc::Receiver<String>| {
            std::iter::from_fn(|| rx.try_recv().ok())
                .map(|message| serde_json::from_str::<serde_json::Value>(&message).unwrap())
                .collect::<Vec<_>>()
        };

        world.players.get_mut("ice-mage").unwrap().state.job = MAGICIAN_JOB;
        world
            .players
            .get_mut("ice-mage")
            .unwrap()
            .state
            .skill_points = BTreeMap::from([(MAGE_BOOK, 5)]);
        world.handle_learn_skill("ice-mage".into(), "wrong-book".into(), SKILL_COLD_BEAM);
        let wrong_job: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(wrong_job["type"], "rejected");
        assert_eq!(wrong_job["code"], "wrong_job");

        {
            let player = world.players.get_mut("ice-mage").unwrap();
            player.state.job = ICE_MAGE_JOB;
            player.state.level = 30;
            player.state.mp = 500;
            player.state.max_mp = 500;
            player.state.skills = BTreeMap::from([
                (SKILL_MAGIC_BOOST, 1),
                (SKILL_MANA_ABSORB, 9),
                (SKILL_SPELL_MASTERY, 10),
                (SKILL_INTELLIGENCE, 5),
                (SKILL_ICE_EFFECT, 1),
                (SKILL_BOOSTER, 10),
                (SKILL_MEDITATION, 1),
                (SKILL_THUNDER_BOLT, 1),
                (SKILL_COLD_BEAM, 1),
                (SKILL_ICE_TELEPORT, 10),
                (SKILL_TELEPORT, 5),
            ]);
            player.state.skill_points = BTreeMap::from([(ICE_BOOK, 0)]);
            player.state.x = 100.0;
            player.state.y = 100.0;
            player.state.grounded = true;
            player.state.action = "stand";
            player.foothold_id = 1;
            player.last_foothold_id = 1;
            refresh_player_derived(&world.gameplay, &world.mage_skills, player);
            assert_eq!(player.state.derived_stats.intelligence, Some(64));
        }
        assert_eq!(world.action_speed_bonus(&world.players["ice-mage"]), -3);

        world.handle_cast_skill(
            "ice-mage".into(),
            "meditation".into(),
            SKILL_MEDITATION,
            Some(1),
            Some(0),
        );
        let meditation_messages = drain(&mut rx);
        let meditation = meditation_messages
            .iter()
            .find(|value| value["type"] == "skillResult")
            .expect("meditation result");
        assert_eq!(meditation["success"], true);
        assert!(world.players["ice-mage"].meditation_mad > 0);
        world.step();
        assert!(world.players["ice-mage"]
            .state
            .derived_stats
            .meditation_remaining_ms
            .is_some());

        world.handle_cast_skill(
            "ice-mage".into(),
            "cold-1".into(),
            SKILL_COLD_BEAM,
            Some(1),
            Some(0),
        );
        let cold_messages: Vec<serde_json::Value> = std::iter::from_fn(|| rx.try_recv().ok())
            .map(|message| serde_json::from_str(&message).unwrap())
            .collect();
        assert!(cold_messages
            .iter()
            .any(|value| value["type"] == "skillCast"));
        assert_eq!(
            cold_messages
                .iter()
                .filter(|value| value["type"] == "damageEvent")
                .count(),
            12
        );
        let first_monster = world.monsters.keys().next().cloned().unwrap();
        assert_eq!(world.monsters[&first_monster].state.freeze_stacks, Some(1));
        assert!(world.monsters[&first_monster].freeze_until > world.tick);

        world.tick += 20;
        if let Some(player) = world.players.get_mut("ice-mage") {
            player.attack_until = world.tick;
            player.state.action = "stand";
        }
        world.handle_cast_skill(
            "ice-mage".into(),
            "thunder-1".into(),
            SKILL_THUNDER_BOLT,
            Some(1),
            Some(0),
        );
        let thunder_messages: Vec<serde_json::Value> = std::iter::from_fn(|| rx.try_recv().ok())
            .map(|message| serde_json::from_str(&message).unwrap())
            .collect();
        assert_eq!(
            thunder_messages
                .iter()
                .filter(|value| value["type"] == "damageEvent")
                .count(),
            12
        );
        assert_eq!(world.monsters[&first_monster].state.freeze_stacks, None);

        world.handle_cast_skill(
            "ice-mage".into(),
            "ice-toggle".into(),
            SKILL_ICE_TELEPORT,
            Some(1),
            Some(0),
        );
        let toggle_messages = drain(&mut rx);
        let toggle = toggle_messages
            .iter()
            .find(|value| value["type"] == "skillResult")
            .expect("ice teleport result");
        assert_eq!(toggle["success"], true);
        assert_eq!(world.players["ice-mage"].ice_teleport_enabled, true);
        assert_eq!(
            world.players["ice-mage"].state.derived_stats.ice_teleport,
            Some(true)
        );

        // The exported path probability is random.  Repeating the authored
        // source transition keeps this check deterministic enough while still
        // exercising the enabled guard, 6 second lifetime and 1200 ms tick.
        for _ in 0..100 {
            if !world.players["ice-mage"].ice_fields.is_empty() {
                break;
            }
            if let Some(player) = world.players.get_mut("ice-mage") {
                player.state.x = 290.0;
                player.state.y = 130.0;
            }
            world.maybe_create_ice_field("ice-mage", 100.0, 100.0);
        }
        assert!(!world.players["ice-mage"].ice_fields.is_empty());
        let field_event = drain(&mut rx)
            .into_iter()
            .find(|value| {
                value["type"] == "skillCast"
                    && value["skillId"] == SKILL_ICE_TELEPORT
                    && value["targetX"].is_number()
                    && value["targetY"].is_number()
            })
            .expect("ice field skillCast");
        assert_eq!(field_event["x"], 100.0);
        assert_eq!(field_event["y"], 100.0);
        assert_eq!(field_event["requestId"], field_event["eventId"]);
        assert_eq!(field_event["facing"], 1);
        assert_eq!(field_event["durationMs"], 6_000);
        let mp_before_absorb = world.players["ice-mage"].state.mp;
        for _ in 0..1000 {
            if world.monsters[&first_monster].mp == 0 {
                break;
            }
            world.maybe_absorb_monster_mp("ice-mage", &first_monster);
        }
        assert!(world.monsters[&first_monster].mp < 100);
        assert!(world.players["ice-mage"].state.mp >= mp_before_absorb);
        world.step_ice_fields();
        assert!(world.monsters[&first_monster].state.freeze_stacks.is_some());
    }

    #[test]
    fn fourth_job_core_channel_bind_summon_infinity_and_blizzard() {
        let mut gameplay = life_gameplay(vec![
            life_spawn("fourth-m1", "test", 140.0, 1, -1),
            life_spawn("fourth-m2", "test", 165.0, 1, -1),
        ]);
        gameplay.player.max_hp = Some(1_000);
        gameplay.player.max_mp = Some(1_000);
        for template in &mut gameplay.monsters {
            template.max_hp = 1_000_000;
            template.md_rate = Some(50.0);
            template.pd_rate = Some(50.0);
        }
        let mut world = World::new_with_gameplay(life_map("test"), 600, gameplay)
            .with_mage_skills(MageSkills::bundled());
        let (output, mut rx) = mpsc::channel(4_096);
        let (reply, _) = oneshot::channel();
        world.command(Command::Join {
            identity: Identity {
                id: "fourth-runtime".into(),
                username: "fourth-runtime".into(),
            },
            connection: "fourth-runtime-connection".into(),
            output,
            reply,
            lang: "zh".into(),
        });
        while rx.try_recv().is_ok() {}
        {
            let player = world.players.get_mut("fourth-runtime").unwrap();
            player.state.job = ICE_FOURTH_JOB;
            player.state.level = 100;
            player.base_max_mp = 1_000;
            player.state.hp = 1_000;
            player.state.mp = 1_000;
            player.state.skills = BTreeMap::from([
                (SKILL_MASTER_MAGIC, 1),
                (SKILL_ICE_DRAGON_BREATH, 1),
                (SKILL_ICE_DEMON, 1),
                (SKILL_FROZEN_ORB, 1),
                (SKILL_INFINITY, 1),
                (SKILL_BLIZZARD, 1),
                (SKILL_COLD_BEAM, 1),
                (SKILL_CHAIN_LIGHTNING, 1),
            ]);
            player.state.x = 100.0;
            player.state.y = 100.0;
            player.state.grounded = true;
            player.state.action = "stand";
            player.foothold_id = 1;
            player.last_foothold_id = 1;
            refresh_player_derived(&world.gameplay, &world.mage_skills, player);
        }
        let drain = |rx: &mut mpsc::Receiver<String>| {
            std::iter::from_fn(|| rx.try_recv().ok())
                .map(|message| serde_json::from_str::<serde_json::Value>(&message).unwrap())
                .collect::<Vec<_>>()
        };
        let target_id = world.monsters.keys().next().cloned().unwrap();
        let damage_without_bind = world.magic_damage_with_passives(
            "fourth-runtime",
            SKILL_COLD_BEAM,
            &target_id,
            100,
            false,
            "before-bind",
            1,
        );

        // channel_until == 0 is an inactive state; it must not reset an
        // ordinary attack on the next simulation tick.
        {
            let player = world.players.get_mut("fourth-runtime").unwrap();
            player.state.action = "attack";
            player.attack_until = player.channel_until.saturating_add(10);
        }
        world.step();
        assert_eq!(world.players["fourth-runtime"].channel_until, 0);
        assert_eq!(world.players["fourth-runtime"].state.action, "attack");
        world
            .players
            .get_mut("fourth-runtime")
            .unwrap()
            .attack_until = world.tick;

        world.handle_cast_skill(
            "fourth-runtime".into(),
            "dragon-1".into(),
            SKILL_ICE_DRAGON_BREATH,
            Some(1),
            Some(0),
        );
        let dragon_messages = drain(&mut rx);
        let dragon_event = dragon_messages
            .iter()
            .find(|value| {
                value["type"] == "skillCast" && value["skillId"] == SKILL_ICE_DRAGON_BREATH
            })
            .expect("dragon cast event");
        assert_eq!(dragon_event["durationMs"], 7_000);
        let dragon_until = world.players["fourth-runtime"].channel_until;
        assert_eq!(dragon_until - world.tick, 140);
        assert!(world.monsters[&target_id].bind_until > world.tick);
        assert!(world.monsters[&target_id].bind_immune_until > world.tick);
        assert_eq!(world.monsters[&target_id].bind_pd_rate_reduction, 10);
        assert_eq!(world.monsters[&target_id].bind_md_rate_reduction, 20);
        let damage_with_bind = world.magic_damage_with_passives(
            "fourth-runtime",
            SKILL_COLD_BEAM,
            &target_id,
            100,
            false,
            "before-bind",
            1,
        );
        assert!(damage_with_bind > damage_without_bind);

        // A release after the q window is a silent idempotent no-op.
        world.tick = dragon_until;
        world.step();
        assert!(world.players["fourth-runtime"].channel_request_id.is_none());
        world.handle_release_skill("fourth-runtime".into(), "dragon-1".into());
        assert!(drain(&mut rx)
            .iter()
            .all(|value| { value["type"] != "skillCast" || value["requestId"] != "dragon-1" }));

        // The ninety-second immunity is independent from bind duration and
        // rejects a second Dragon cast without changing either mob's HP.
        let hp_before_immune = world
            .monsters
            .iter()
            .map(|(id, monster)| (id.clone(), monster.state.hp))
            .collect::<BTreeMap<_, _>>();
        {
            let player = world.players.get_mut("fourth-runtime").unwrap();
            player.skill_cooldowns.remove(&SKILL_ICE_DRAGON_BREATH);
            player.attack_until = player.channel_until;
        }
        world.handle_cast_skill(
            "fourth-runtime".into(),
            "dragon-2".into(),
            SKILL_ICE_DRAGON_BREATH,
            Some(1),
            Some(0),
        );
        let _ = drain(&mut rx);
        assert!(world
            .monsters
            .iter()
            .all(|(id, monster)| monster.state.hp == hp_before_immune[id]));

        let player_x = world.players["fourth-runtime"].state.x;
        let demon = world
            .mage_skills
            .level(SKILL_ICE_DEMON, 1)
            .cloned()
            .unwrap();
        let orb = world
            .mage_skills
            .level(SKILL_FROZEN_ORB, 1)
            .cloned()
            .unwrap();
        {
            let player = world.players.get_mut("fourth-runtime").unwrap();
            player.channel_request_id = None;
            player.channel_skill_id = None;
            player.channel_until = 0;
            player.attack_until = 0;
        }
        world
            .cast_ice_demon("fourth-runtime", "demon-1", &demon)
            .unwrap();
        world
            .cast_frozen_orb("fourth-runtime", "orb-1", &orb)
            .unwrap();
        assert_eq!(world.players["fourth-runtime"].summons.len(), 2);
        assert!(world.players["fourth-runtime"]
            .summons
            .iter()
            .any(|summon| summon.skill_id == SKILL_ICE_DEMON));
        assert!(world.players["fourth-runtime"]
            .summons
            .iter()
            .any(|summon| summon.skill_id == SKILL_FROZEN_ORB));
        world.step_summons();
        assert_eq!(world.players["fourth-runtime"].state.x, player_x);

        {
            let player = world.players.get_mut("fourth-runtime").unwrap();
            player.base_max_mp = 100;
            player.state.mp = 0;
            refresh_player_derived(&world.gameplay, &world.mage_skills, player);
        }
        let infinity = world.mage_skills.level(SKILL_INFINITY, 1).cloned().unwrap();
        world
            .activate_infinity("fourth-runtime", &infinity)
            .unwrap();
        {
            let player = world.players.get_mut("fourth-runtime").unwrap();
            player.state.mp = 0;
            player.infinity_next_tick = world.tick;
        }
        world.step_infinity_tick("fourth-runtime");
        assert_eq!(world.players["fourth-runtime"].state.mp, 1);
        {
            let player = world.players.get_mut("fourth-runtime").unwrap();
            player.skill_buffs.insert(SKILL_INFINITY, 1_000);
            refresh_player_derived(&world.gameplay, &world.mage_skills, player);
        }
        assert!(
            world.players["fourth-runtime"]
                .state
                .derived_stats
                .infinity_enhanced
        );

        // Blizzard's hidden proc is selected from the actual successful
        // direct targets and is excluded from its own direct-skill chain.
        let cold = world
            .mage_skills
            .level(SKILL_COLD_BEAM, 1)
            .cloned()
            .unwrap();
        let mut found_follow_up = false;
        for index in 0..300 {
            let request_id = format!("cold-follow-{index}");
            world
                .cast_elemental_area("fourth-runtime", &request_id, SKILL_COLD_BEAM, &cold, false)
                .unwrap();
            let messages = drain(&mut rx);
            let main_targets = messages
                .iter()
                .filter(|value| {
                    value["type"] == "damageEvent" && value["skillId"] == SKILL_COLD_BEAM
                })
                .filter_map(|value| value["targetId"].as_str())
                .collect::<BTreeSet<_>>();
            let follow_ups = messages
                .iter()
                .filter(|value| {
                    value["type"] == "damageEvent" && value["skillId"] == SKILL_BLIZZARD_HIDDEN
                })
                .collect::<Vec<_>>();
            if !follow_ups.is_empty() {
                assert_eq!(follow_ups.len(), 1);
                let target = follow_ups[0]["targetId"].as_str().unwrap();
                assert!(main_targets.contains(target));
                found_follow_up = true;
                break;
            }
        }
        assert!(found_follow_up, "deterministic Blizzard proc did not occur");
    }
}
