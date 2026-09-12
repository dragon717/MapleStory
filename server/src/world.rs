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
#[path = "messaging.rs"]
mod messaging;
#[path = "inventory_ops.rs"]
mod inventory_ops;
#[path = "social.rs"]
mod social;
#[path = "trade.rs"]
mod trade;
#[path = "quest.rs"]
mod quest;
#[path = "monsters.rs"]
mod monsters;
#[path = "skills.rs"]
mod skills;
#[path = "elemental.rs"]
mod elemental;
#[path = "dialogue.rs"]
mod dialogue;
#[path = "portals.rs"]
mod portals;
#[path = "growth.rs"]
mod growth;
#[path = "revive.rs"]
mod revive;
#[path = "commands.rs"]
mod commands;
#[path = "derived.rs"]
mod derived;
#[path = "movement.rs"]
mod movement;
#[path = "attacks.rs"]
mod attacks;
#[path = "gameplay.rs"]
mod gameplay;
#[path = "combat_rules.rs"]
mod combat_rules;
#[path = "geometry.rs"]
mod geometry;
use self::monsters::mark_monster_hit_aggro;
use self::derived::*;
use self::movement::*;

pub const TICK_MS: u64 = 50;
const NATURAL_RECOVERY_INTERVAL_TICKS: u64 = 1_000 / TICK_MS;

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
/// 用户指定规则（2026-09-12）：魔心防禦从受伤中「接下」、转由 MP 承受的比例（%）。
/// 结算分两步：护罩先接下 floor(受伤 × 本值 / 100)，再按该级抵偿率把接下的部分
/// 化去 floor(接下 × 抵偿率 / 100) == floor(受伤 × 本值 × 抵偿率 / 10000)，抵偿率来自
/// `shared/mage-skills.json` 的 `mpSubstitutePercent`（100→80，见 mage.rs）；抵偿率化不去的
/// 差额由护盾消解，**不落到 HP、也不消耗 MP**（1 级 0、10 级为接下部分的 20%）。
/// 未被接下的那 1% 才由 HP 承担：floor(受伤 × (100 - 本值) / 100)。
/// 技能窗文案里的 99% 由 `scripts/tms273_skill_manifest.cjs` 的 USER_SPECIFIED_SKILL_RULES
/// 生成，两处必须一致。
const MAGIC_GUARD_COVERED_PERCENT: i64 = 99;
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
// `Mob.wz/info/speed` is an optional offset on the mob's own walk speed, not a
// walk/no-walk switch: 3111 of the 11614 TMS273 mobs ship no `speed` node at
// all and 731 of those still author a `move` animation (the 菇菇/木妖 families),
// while 541 mobs write the same default out as an explicit `0`.  An absent
// node therefore reads as this offset; the authored "stands still" form is the
// `-100` sentinel (城門/寶箱/訓練用木頭人/稻草人), which is the lowest value
// `Gameplay::validate` still accepts.
const MOB_DEFAULT_SPEED_OFFSET: f64 = 0.0;
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
    /// P drop table rolled when the prop is used up (see the exporter's
    /// `DROP_TABLES`).  `None` when the template's `action` has no known drop
    /// semantics — the reactor still breaks, it just yields nothing.
    #[serde(default)]
    pub drop_table: Option<DropInput>,
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
    /// before feeding the movement loop (Mob.cpp:197-199).  Optional in the
    /// source; `movement_force` owns the absent-node default.
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
    /// Durable per-tab inventory slot capacities (inventory type -> slot
    /// count).  Loaded from auth at join; the world reads it to bound
    /// `add_items`/`move_items` and the slot-expansion coupon writes a new
    /// value back through `Store::save_inventory_slots`.
    inventory_slots: BTreeMap<u8, u16>,
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

        // A prop used up for the last time pays out its drop table.  The
        // break is the one and only drop event: intermediate states advance
        // the animation without reward, so re-hitting a half-broken prop can
        // never farm the table.  The reactor's own anchor is the drop point,
        // and the breaker owns the protection window so they get first reach.
        if spent {
            if let Some(specs) = placement.drop_table.as_ref() {
                let drops = {
                    let specs = match specs {
                        DropInput::One(spec) => vec![spec.clone()],
                        DropInput::Many(specs) => specs.clone(),
                    };
                    self.roll_drop_specs(&specs, placement.x, placement.y, &id)
                };
                for drop in drops {
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
    // 通讯职责已搬到 `messaging`（超大文件治理 P2）：其策略常量是 `pub(super)`，
    // 在这里显式 glob 进来，使既有 `*_acceptance.rs` 里的裸名引用继续成立。
    use super::messaging::*;
    use super::monsters::*;
    use super::skills::*;
    use super::elemental::*;

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
            skills: Vec::new(),
            body_disease: None,
            body_disease_level: None,
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
                    skills: Vec::new(),
                    body_disease: None,
                    body_disease_level: None,
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
                    skills: Vec::new(),
                    body_disease: None,
                    body_disease_level: None,
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
                    skills: Vec::new(),
                    body_disease: None,
                    body_disease_level: None,
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
                    skills: Vec::new(),
                    body_disease: None,
                    body_disease_level: None,
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
                skills: Vec::new(),
                body_disease: None,
                body_disease_level: None,
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
    include!("monster_status_acceptance.rs");
    include!("slot_expand_acceptance.rs");
    include!("mob_move_acceptance.rs");

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
        // 源护盾 1 级给 10 PDD（pddX = 10*x），所以减伤后是 20 - 10 = 10。
        // 用户指定规则（2026-09-12）：1 级抵偿率 100%。护罩先接下受伤的 99%：
        // floor(10 * 99%) = 9 点接给 MP，floor(9 * 100%) = 9 点真由魔力化去（护盾无差额）；
        // 未被接下的那 1%（floor(10 * 1%) = 0）才落回 HP——所以 HP 一点不掉。
        let expected_mp_damage = 9.min(mp_before_contact);
        world.apply_contact_damage();
        assert_eq!(world.players["mage-runtime"].state.hp, hp_before_contact);
        assert_eq!(
            world.players["mage-runtime"].state.mp,
            mp_before_contact - expected_mp_damage
        );
        while rx.try_recv().is_ok() {}

        // 满级（10 级）抵偿率 80%：同一击接下 9 点，只化去 floor(9 * 80%) = 7 点，
        // 差额 2 点由护盾消解——既不扣 HP 也不扣 MP。HP 仍只承担那 1%（此处为 0）。
        {
            let player = world.players.get_mut("mage-runtime").unwrap();
            player.state.skills.insert(SKILL_MAGIC_GUARD, 10);
            player.contact_invulnerable_until = 0;
        }
        let hp_before_max_guard = world.players["mage-runtime"].state.hp;
        let mp_before_max_guard = world.players["mage-runtime"].state.mp;
        world.apply_contact_damage();
        assert_eq!(world.players["mage-runtime"].state.hp, hp_before_max_guard);
        assert_eq!(
            world.players["mage-runtime"].state.mp,
            mp_before_max_guard - 7
        );
        while rx.try_recv().is_ok() {}
        {
            let player = world.players.get_mut("mage-runtime").unwrap();
            player.state.skills.insert(SKILL_MAGIC_GUARD, 1);
        }

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
