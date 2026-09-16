use crate::lobby;
use crate::protocol::{AbilityStat, AbilityStats};
use crate::{
    inventory::{self, EquipmentStats, MAX_SLOT_LIMIT},
    protocol::InventoryItem,
};
// Bare `SLOT_LIMIT` is only referenced by this file's tests; keeping it out of
// the unconditional import keeps the non-test build warning-free.
#[cfg(test)]
use crate::inventory::SLOT_LIMIT;
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use rand::{rngs::OsRng, Rng, RngCore};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, oneshot};

// `grant_level_sp` / `add_exp` 原是 auth 层 `pub(crate)` 自由函数，world::quest 走
// `auth::X` 路径调用；搬入 db.rs 后 re-export 保住原路径。
use self::db::*;
pub(crate) use db::{add_exp, grant_level_sp};
// NB-05：物品授予的图鉴留档入口。auth 层各授予事务（拾取 / 商店 / 现金 /
// 任务 / 创角初始 / GM）统一走 `granted_tx`，保证「资产与留档同一事务」。
use self::notebook::{granted_tx, AcquisitionSource, ItemAcquisition};

#[path = "auth/friends.rs"]
pub(crate) mod friends;
#[path = "auth/quests.rs"]
pub(crate) mod quests;
#[path = "auth/skills.rs"]
pub(crate) mod skills;
pub use friends::{FriendOperation, FriendOutcome, FriendRow};
#[path = "auth/bag.rs"]
pub(crate) mod bag;
#[path = "auth/cash.rs"]
pub(crate) mod cash;
#[path = "auth/db.rs"]
pub(crate) mod db;
#[path = "auth/item_world.rs"]
pub(crate) mod item_world;
#[path = "auth/loot.rs"]
pub(crate) mod loot;
#[path = "auth/notebook.rs"]
pub(crate) mod notebook;
#[path = "auth/schema.rs"]
pub(crate) mod schema;
#[path = "auth/shop.rs"]
pub(crate) mod shop;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}

impl Credentials {
    pub fn validate(&self) -> bool {
        (3..=32).contains(&self.username.len())
            && self
                .username
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            && (8..=128).contains(&self.password.len())
    }
}

#[derive(Clone)]
pub struct Identity {
    pub id: String,
    pub username: String,
}

pub enum Request {
    Register(Credentials, oneshot::Sender<Result<(), String>>),
    Login(
        Credentials,
        oneshot::Sender<Result<(Identity, String), String>>,
    ),
    #[cfg(test)]
    Verify(String, oneshot::Sender<Option<Identity>>),
    VerifyCharacter(String, oneshot::Sender<Option<Identity>>),
    Lobby {
        token: String,
        action: crate::lobby::Action,
        reply: oneshot::Sender<Result<crate::lobby::Response, String>>,
    },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SessionKind {
    Account,
    Character,
}

#[derive(Clone)]
struct Session {
    token: String,
    identity: Identity,
    account_id: String,
    kind: SessionKind,
    expiry: Instant,
}

/// Acceptance-test failure injector: while set, the persistence write
/// primitives refuse, so a caller sees the same "commit failed" path as a real
/// SQLite error — without touching schema, data, or the connection mutex.
///
/// It is a process-global flag rather than a per-`Store` field because
/// [`Store`] is built by struct literal in a dozen test modules; a lock hold
/// was the first attempt and deadlocked the permanently blocked auth thread
/// that [`start`] spawns over the same connection.
///
/// Because the flag is global and `cargo test` runs tests in parallel, any
/// test that sets it must first take [`PERSISTENCE_INJECTION_LOCK`] — see
/// `Store::deny_persistence`.
#[cfg(test)]
static PERSISTENCE_DENIED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Serializes the tests that turn [`PERSISTENCE_DENIED`] on.  Without it a
/// parallel test's legitimate commit is refused by another test's injection.
#[cfg(test)]
static PERSISTENCE_INJECTION_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// RAII guard returned by `Store::deny_persistence`; clearing on drop keeps a
/// panicking test from poisoning the flag for the rest of the suite.  It also
/// owns the injection lock, so the flag can never outlive the serialized
/// section.
#[cfg(test)]
#[must_use = "the denial lasts only as long as this guard is alive"]
pub struct PersistenceDenial {
    _serialized: std::sync::MutexGuard<'static, ()>,
}

#[cfg(test)]
impl Drop for PersistenceDenial {
    fn drop(&mut self) {
        Store::release_persistence();
    }
}

#[derive(Clone)]
pub struct Store {
    db: Arc<Mutex<Connection>>,
}

pub struct AuthService {
    pub sender: mpsc::Sender<Request>,
    pub store: Store,
}

#[derive(Clone, Debug)]
pub struct AbilityActionOutcome {
    pub success: bool,
    pub code: String,
    pub stats: AbilityStats,
    pub already_resolved: bool,
}

#[derive(Clone, Debug)]
pub struct Profile {
    pub hp: i64,
    pub max_hp: i64,
    pub mp: i64,
    pub max_mp: i64,
    pub level: u32,
    /// Character-owned job id.  Zero is the source beginner job and is also
    /// the compatibility value for rows created before job persistence.
    pub job: u32,
    pub exp: u64,
    pub exp_to_next: u64,
    pub mesos: u64,
    /// Character-owned 現金商店 balance.  Persisted like mesos; the only
    /// local grant path is the GM `/cash` command (P: no real charging).
    pub cash: u64,
    pub death_id: String,
    /// Authoritative world position the player reconnects at; restored from
    /// SQLite on login so that map switches and overworld exploration persist
    /// across server restarts.  Empty `map_id` or non-finite coordinates fall
    /// back to the authored birth map spawn at the join site.
    pub map_id: String,
    pub x: f64,
    pub y: f64,
    pub inventory: Vec<InventoryItem>,
    /// Character-owned skill id -> learned level.  Values are persisted as
    /// JSON because the source skill set is sparse and still being verified.
    pub skills: BTreeMap<u32, u32>,
    /// Source SP group id -> remaining points.  Group semantics are not
    /// inferred here; this map only preserves authoritative state.
    pub skill_points: BTreeMap<u32, u32>,
    pub ability_stats: AbilityStats,
}

#[derive(Clone, Debug)]
pub struct AttackClaim {
    pub action_id: String,
    pub event: String,
    pub resolved: bool,
}

#[derive(Clone, Debug, Default)]
pub struct DropRecord {
    pub id: String,
    pub item_id: String,
    pub quantity: u32,
    pub x: f64,
    pub y: f64,
    pub owner_id: Option<String>,
    pub protected_until_ms: i64,
    /// Equipment instance metadata travels with a dropped item.  Ordinary
    /// stackable drops leave these fields empty.
    pub stats: Option<BTreeMap<String, i64>>,
    pub remaining_slots: Option<u32>,
    pub upgrade_count: Option<u32>,
}

#[derive(Clone, Debug)]
#[allow(dead_code)] // exp_gain/drop mirror reference rewards; drops/profiles are authoritative.
pub struct AttackResolution {
    pub already_resolved: bool,
    pub target_id: Option<String>,
    pub damage: i64,
    pub killed: bool,
    pub exp_gain: u64,
    /// The first drop is kept for callers that only render one result. `drops`
    /// contains the complete authoritative reward set.
    pub drop: Option<DropRecord>,
    pub drops: Vec<DropRecord>,
    pub profile: Option<Profile>,
    /// Solo profiles awarded by this kill, including the request owner.
    pub profiles: Vec<(String, Profile)>,
}

#[derive(Clone, Debug)]
pub struct PickupOutcome {
    pub drop_id: String,
    pub item_id: String,
    pub quantity: u32,
    pub slot: Option<u16>,
    pub success: bool,
    pub code: String,
}

#[derive(Clone, Debug)]
pub struct InventoryOutcome {
    pub request_id: String,
    pub operation: String,
    pub inventory_type: Option<u8>,
    pub from_slot: i16,
    pub to_slot: Option<i16>,
    pub item_id: String,
    pub quantity: u32,
    pub drop_id: Option<String>,
    pub success: bool,
    pub code: String,
}

/// Which way a warehouse transfer moves goods.  The client names only the
/// direction, the tab and the slot; item identity, quantity and price are all
/// resolved here, exactly like `ShopSell`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StorageOperation {
    /// Character inventory -> account warehouse.
    Deposit,
    /// Account warehouse -> character inventory.
    Withdraw,
}

impl StorageOperation {
    pub fn as_str(self) -> &'static str {
        match self {
            StorageOperation::Deposit => "storageDeposit",
            StorageOperation::Withdraw => "storageWithdraw",
        }
    }

    /// 把搬运被拒的**原因**翻译成本方向的玩家可见拒绝码。
    ///
    /// 这是业务动作的词汇，不是容器的词汇（世界模型 §31）：同一句"来源那一格
    /// 是空的"在存仓方向说 `source_empty`、在取回方向说 `storage_slot_empty`；
    /// 同一句"装不下"在存仓方向说 `storage_full`、在取回方向说 `inventory_full`。
    /// 翻译点只有这一处，客户端 `PROTOCOL_ERRORS` 与门禁脚本扫的就是这些码。
    fn refusal_code(self, reason: item_world::MoveRefusal) -> &'static str {
        match (self, reason) {
            (_, item_world::MoveRefusal::InvalidSlot) => "invalid_slot",
            (_, item_world::MoveRefusal::InvalidQuantity) => "invalid_quantity",
            (StorageOperation::Deposit, item_world::MoveRefusal::SourceEmpty) => "source_empty",
            (StorageOperation::Withdraw, item_world::MoveRefusal::SourceEmpty) => {
                "storage_slot_empty"
            }
            (StorageOperation::Deposit, item_world::MoveRefusal::DestinationFull) => "storage_full",
            (StorageOperation::Withdraw, item_world::MoveRefusal::DestinationFull) => {
                "inventory_full"
            }
        }
    }
}

/// Authoritative result of one item transfer.  `quantity` is the amount that
/// actually moved — 0 on every refusal — so a client can never mistake a
/// partial or rejected transfer for a completed one.
#[derive(Clone, Debug)]
pub struct StorageOutcome {
    pub request_id: String,
    pub operation: StorageOperation,
    pub inventory_type: u8,
    pub slot: i16,
    pub item_id: String,
    pub quantity: u32,
    pub success: bool,
    pub code: String,
}

/// Authoritative result of one mesos transfer.  Both balances are re-read
/// inside the transaction so the client is always shown the post-move state.
#[derive(Clone, Debug)]
pub struct StorageMesosOutcome {
    pub request_id: String,
    pub operation: StorageOperation,
    pub quantity: u32,
    pub success: bool,
    pub code: String,
    /// Character purse after the transfer.
    pub mesos: u64,
    /// Warehouse balance after the transfer.
    pub stored_mesos: u64,
}

/// Warehouse capacity.  The original's storage window is fixed at a small
/// number of rows; keep the same limit server-side so a client cannot grow the
/// warehouse past what the UI can show.
pub const STORAGE_SLOT_LIMIT: u16 = 24;

/// Party EXP bonus (P): every extra grouped character present on the killer's
/// map adds this share of the monster's authored EXP to a bonus pool, capped
/// at `PARTY_EXP_BONUS_CAP`.  Kept here so the single transaction that settles
/// a kill is the only place that can pay it.
const PARTY_EXP_BONUS_PER_MEMBER: f64 = 0.05;
const PARTY_EXP_BONUS_CAP: f64 = 0.20;

#[derive(Clone, Debug)]
pub struct ReviveOutcome {
    pub request_id: String,
    pub death_id: String,
    pub success: bool,
    pub code: String,
}

#[derive(Clone, Debug)]
pub struct SkillActionOutcome {
    pub operation: String,
    pub skill_id: u32,
    pub success: bool,
    pub code: String,
    pub level: u32,
    pub remaining_sp: u32,
    pub mp: i64,
    pub already_resolved: bool,
}

pub fn random_id() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub(crate) const DROP_PROTECTION_MS: i64 = 60_000;

// P: user-requested TMS273 gameplay rule (2026-09-14). The local Quest.wz
// export records 1402 lvmin=10; this explicit product rule makes the mage's
// first transfer the level-8 exception while other first-job routes stay 10.
pub(crate) const FIRST_MAGE_JOB_LEVEL: u32 = 8;

const MAGE_BOOK: u32 = 200;
const THIRD_MAGE_BOOK: u32 = 221;
const THIRD_JOB: u32 = 221;
const THIRD_HIDDEN_SKILL: u32 = 2_211_015;
const FOURTH_MAGE_BOOK: u32 = 222;
const FOURTH_JOB: u32 = 222;
const FOURTH_FIXED_SKILL: u32 = 2_220_015;
const FOURTH_PASSIVE_SKILLS: [u32; 2] = [2_220_010, 2_220_013];
const FOURTH_HIDDEN_SKILLS: [u32; 3] = [2_220_014, 2_221_055, 2_221_056];
const FOURTH_PAID_SKILLS: [u32; 10] = [
    2_220_010, 2_220_013, 2_221_000, 2_221_004, 2_221_005, 2_221_006, 2_221_007, 2_221_008,
    2_221_011, 2_221_012,
];
const HYPER_HIDDEN_SKILL: u32 = 2_221_055;
const HYPER_VORTEX_SKILL: u32 = 2_221_054;
const HYPER_THUNDER_SKILL: u32 = 2_221_052;
const HYPER_VISIBLE_SKILLS: [u32; 12] = [
    2_220_043,
    2_220_044,
    2_221_045,
    2_220_046,
    2_220_047,
    2_220_048,
    2_220_049,
    2_220_050,
    2_220_051,
    2_221_052,
    2_221_053,
    HYPER_VORTEX_SKILL,
];

/// Fixed TMS273 Hyper metadata.  Kind 1 is the passive pool and kind 2 is
/// the active pool.  The hidden 2221055 variant is retained in the metadata
/// so auth can reject it explicitly while World uses it only as the vortex's
/// server-side cooldown key.
pub(crate) fn hyper_skill_info(skill_id: u32) -> Option<(u32, u32)> {
    match skill_id {
        2_220_043 => Some((1, 140)),
        2_220_044 => Some((1, 150)),
        2_221_045 => Some((1, 180)),
        2_220_046 => Some((1, 140)),
        2_220_047 => Some((1, 165)),
        2_220_048 => Some((1, 180)),
        2_220_049 => Some((1, 150)),
        2_220_050 => Some((1, 165)),
        2_220_051 => Some((1, 190)),
        2_221_052 => Some((2, 160)),
        2_221_053 => Some((2, 190)),
        HYPER_VORTEX_SKILL => Some((2, 140)),
        HYPER_HIDDEN_SKILL => Some((2, 140)),
        _ => None,
    }
}

fn hyper_skill_hidden(skill_id: u32) -> bool {
    skill_id == HYPER_HIDDEN_SKILL
}

fn hyper_skill_prerequisites(skill_id: u32) -> &'static [(u32, u32)] {
    match skill_id {
        // TMS273 source req: 2211007 level 10.
        2_221_045 => &[(2_211_007, 10)],
        _ => &[],
    }
}

/// Return the remaining points in one independent Hyper pool.  The pool is
/// derived from the durable level and learned Hyper levels, so reconnects
/// cannot duplicate a level-up grant and ordinary SP remains untouched.
pub(crate) fn hyper_points(level: u32, skills: &BTreeMap<u32, u32>, kind: u32) -> u32 {
    let thresholds: &[u32] = match kind {
        1 => &[140, 150, 165, 180, 190],
        2 => &[140, 160, 190],
        _ => return 0,
    };
    let earned = thresholds
        .iter()
        .filter(|required| level >= **required)
        .count() as u32;
    let spent = HYPER_VISIBLE_SKILLS
        .iter()
        .filter(|skill_id| {
            hyper_skill_info(**skill_id).is_some_and(|(skill_kind, _)| skill_kind == kind)
        })
        .fold(0_u32, |total, skill_id| {
            total.saturating_add(skills.get(skill_id).copied().unwrap_or(0).min(1))
        });
    earned.saturating_sub(spent)
}

pub(crate) fn hyper_reset_cost(reset_count: u8) -> u64 {
    [100_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000][usize::from(reset_count.min(4))]
}

/// Apply the one-time P first-job entitlement to an authoritative profile.
///
/// The caller decides whether the source interaction is authorized.  Keeping
/// the field mutation here lets the quest completion path and the existing
/// Hans shortcut use exactly the same grant without resetting older AP/SP or
/// skills.
pub(crate) fn grant_first_mage(profile: &mut Profile) {
    profile.job = 200;
    grant_first_mage_fields(
        &mut profile.max_mp,
        &mut profile.mp,
        &mut profile.skills,
        &mut profile.skill_points,
    );
}

fn grant_first_mage_fields(
    max_mp: &mut i64,
    mp: &mut i64,
    skills: &mut BTreeMap<u32, u32>,
    skill_points: &mut BTreeMap<u32, u32>,
) {
    skill_points.entry(MAGE_BOOK).or_insert(5);
    skills.entry(2_000_007).or_insert(1);
    skills.entry(2_001_012).or_insert(1);
    *max_mp = (*max_mp).max(100);
    *mp = *max_mp;
}

fn fourth_sp_for_level(level: u32) -> u32 {
    let base = match level {
        101..=110 => 3,
        111..=120 => 4,
        121..=130 => 5,
        131..=140 => 6,
        _ => 0,
    };
    if base > 0 && matches!(level % 10, 0 | 3 | 6 | 9) {
        base * 2
    } else {
        base
    }
}

fn fourth_sp_through_level(level: u32) -> u32 {
    if level < 100 {
        return 0;
    }
    let mut total: u32 = 3;
    let end = level.min(140);
    if end >= 101 {
        for current in 101..=end {
            total = total.saturating_add(fourth_sp_for_level(current));
        }
    }
    total
}

fn fourth_learned_sp(skills: &BTreeMap<u32, u32>) -> u32 {
    FOURTH_PAID_SKILLS.iter().fold(0, |total, skill_id| {
        total.saturating_add(skills.get(skill_id).copied().unwrap_or(0))
    })
}

fn fourth_missing_sp(
    level: u32,
    skills: &BTreeMap<u32, u32>,
    skill_points: &BTreeMap<u32, u32>,
) -> u32 {
    fourth_sp_through_level(level).saturating_sub(
        fourth_learned_sp(skills)
            .saturating_add(skill_points.get(&FOURTH_MAGE_BOOK).copied().unwrap_or(0)),
    )
}

fn mage_job_allowed(job: u32) -> bool {
    matches!(
        job,
        200 | 210 | 211 | 212 | 220 | 221 | 222 | 230 | 231 | 232
    )
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
        })
}

/// Recognize only the World-owned practice instance form
/// `practice:<9-digit source map>:<encounter id>`.  Clients never provide
/// this map id; World creates it when entering a practice encounter.
pub(crate) fn is_practice_map(map_id: &str) -> bool {
    let mut fields = map_id.split(':');
    let (Some(prefix), Some(source_map), Some(encounter), None) =
        (fields.next(), fields.next(), fields.next(), fields.next())
    else {
        return false;
    };
    prefix == "practice"
        && source_map.len() == 9
        && source_map
            .chars()
            .all(|character| character.is_ascii_digit())
        && !encounter.is_empty()
}

impl Store {
    pub(crate) fn with_db<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut db = self
            .db
            .lock()
            .map_err(|_| "account store unavailable".to_owned())?;
        operation(&mut db)
    }

    /// Acceptance-test failure injector for the shop commit helpers.
    ///
    /// `#[cfg(test)]`-only, process-global, and scoped: it makes
    /// [`Self::persistence_denied`] report `true` until the returned guard
    /// drops.  The guard also holds [`PERSISTENCE_INJECTION_LOCK`], so only one
    /// test at a time can be in the injected state — otherwise a parallel
    /// test's legitimate commit would be refused.  Always bind it in a block
    /// (`let _denial = Store::deny_persistence();`) so the lock is released
    /// before the assertions that need a working store.
    #[cfg(test)]
    pub fn deny_persistence() -> PersistenceDenial {
        // A poisoned lock only means another injected test panicked; the flag
        // itself is cleared by its guard, so recovering is safe here.
        let serialized = PERSISTENCE_INJECTION_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        PERSISTENCE_DENIED.store(true, std::sync::atomic::Ordering::SeqCst);
        PersistenceDenial {
            _serialized: serialized,
        }
    }

    #[cfg(test)]
    fn release_persistence() {
        PERSISTENCE_DENIED.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    #[cfg(test)]
    fn persistence_denied() -> bool {
        PERSISTENCE_DENIED.load(std::sync::atomic::Ordering::SeqCst)
    }

    #[cfg(not(test))]
    #[inline]
    fn persistence_denied() -> bool {
        false
    }

    pub fn character_appearance(
        &self,
        character_id: &str,
    ) -> Result<Option<crate::lobby::Appearance>, String> {
        crate::lobby::character_appearance(self, character_id)
    }

    pub fn load_profile(&self, account_id: &str, defaults: &Profile) -> Result<Profile, String> {
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        tx.execute(
            "INSERT OR IGNORE INTO player_stats(account_id,hp,max_hp,mp,max_mp,level,job,exp,exp_to_next,mesos,cash,death_id,map_id,x,y,skills_json,skill_points_json,ability_stats_json)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'',?12,?13,?14,'{}','{}',?15)",
            params![
                account_id,
                defaults.hp,
                defaults.max_hp,
                defaults.mp,
                defaults.max_mp,
                defaults.level,
                defaults.job,
                defaults.exp,
                defaults.exp_to_next,
                i64::try_from(defaults.mesos).map_err(|_| "account persistence failed")?,
                i64::try_from(defaults.cash).map_err(|_| "account persistence failed")?,
                defaults.map_id,
                defaults.x,
                defaults.y,
                serde_json::to_string(&defaults.ability_stats).map_err(|_| "account persistence failed")?,
            ],
        )
        .map_err(|_| "account persistence failed")?;
        ensure_starter_equipment_tx(&tx, account_id)?;
        normalize_equipped_tx(&tx)?;
        let mut profile = read_profile(&tx, account_id)?;
        let mut repair_needed = false;
        // P: repair only the missing beginner entitlement, including spent SP.
        // The balance itself makes retries idempotent; no reset or grant marker.
        if profile.job == 0 {
            let spent = [1000, 1001, 1002].iter().fold(0u32, |sum, id| {
                sum.saturating_add(profile.skills.get(id).copied().unwrap_or(0))
            });
            let due = profile.level.saturating_sub(1).min(6).saturating_sub(spent);
            if profile.skill_points.get(&0).copied().unwrap_or(0) < due {
                profile.skill_points.insert(0, due);
                repair_needed = true;
            }
        }
        if profile.job == FOURTH_JOB {
            // Legacy job-222 rows may predate the fourth-job transfer grant.
            // Reconcile only the authored balance through the current level;
            // learned ordinary levels and an existing balance are preserved.
            if profile
                .skills
                .get(&FOURTH_FIXED_SKILL)
                .copied()
                .unwrap_or(0)
                == 0
            {
                profile.skills.insert(FOURTH_FIXED_SKILL, 1);
                repair_needed = true;
            }
            let due = fourth_missing_sp(profile.level, &profile.skills, &profile.skill_points);
            if due > 0 {
                let available = profile.skill_points.entry(FOURTH_MAGE_BOOK).or_default();
                *available = available.saturating_add(due);
                repair_needed = true;
            }
        }
        if repair_needed {
            tx.execute(
                "UPDATE player_stats SET skills_json=?2,skill_points_json=?3 WHERE account_id=?1",
                params![
                    account_id,
                    serialize_skill_map(&profile.skills)?,
                    serialize_skill_map(&profile.skill_points)?,
                ],
            )
            .map_err(|_| "account persistence failed")?;
        }
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(profile)
    }

    /// Read the durable Hyper reset tier without routing it through a stale
    /// World/Profile snapshot.  The value is clamped to the authored 0..=4
    /// price tiers for compatibility with older or manually repaired rows.
    pub fn hyper_reset_count(&self, account_id: &str) -> Result<u8, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        let count: i64 = db
            .query_row(
                "SELECT hyper_reset_count FROM player_stats WHERE account_id=?1",
                [account_id],
                |row| row.get(0),
            )
            .map_err(|_| "account persistence failed")?;
        Ok(u8::try_from(count.clamp(0, 4)).unwrap_or(0))
    }

    /// Seed the starter backpack coupon on the first join after a beginner
    /// account is created.  Idempotent through `starter_backpack_seeded`.
    /// Returns the freshly granted items so callers can merge them into the
    /// in-memory `profile.inventory` without round-tripping the database.
    pub fn seed_starter_backpack(&self, account_id: &str) -> Result<Vec<InventoryItem>, String> {
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        let seeded: i64 = tx
            .query_row(
                "SELECT starter_backpack_seeded FROM player_stats WHERE account_id=?1",
                [account_id],
                |row| row.get(0),
            )
            .map_err(|_| "account persistence failed")?;
        if seeded != 0 {
            return Ok(Vec::new());
        }
        let inventory_count: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM inventory WHERE account_id=?1 AND quantity>0",
                [account_id],
                |row| row.get(0),
            )
            .map_err(|_| "account persistence failed")?;
        if inventory_count != 0 {
            // A non-empty inventory means the starter backpack grant would
            // collide; mark the marker so the check stays idempotent.
            tx.execute(
                "UPDATE player_stats SET starter_backpack_seeded=1 WHERE account_id=?1",
                [account_id],
            )
            .map_err(|_| "account persistence failed")?;
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(Vec::new());
        }
        let mut granted = Vec::new();
        for item in inventory::starter_items() {
            let kind = inventory::inventory_type(&item.item_id)
                .ok_or_else(|| format!("unknown starter item {}", item.item_id))?;
            tx.execute(
                "INSERT INTO inventory(account_id,inventory_type,slot,item_id,quantity,stats_json,upgrade_count,remaining_slots)
                 VALUES (?1,?2,?3,?4,?5,'{}',0,0)",
                params![
                    account_id,
                    i64::from(kind),
                    i64::from(item.slot),
                    item.item_id,
                    i64::from(item.quantity),
                ],
            )
            .map_err(|_| "account persistence failed")?;
            granted.push(item);
        }
        tx.execute(
            "UPDATE player_stats SET starter_backpack_seeded=1 WHERE account_id=?1",
            [account_id],
        )
        .map_err(|_| "account persistence failed")?;
        // NB-05：创角初始背包物品是真实授予，与落库同一事务留档。`granted`
        // 就是本次真正写进去的那几件（非空才走到这里）。
        let starter_grants: Vec<ItemAcquisition> = granted
            .iter()
            .map(|item| ItemAcquisition {
                item_id: item.item_id.as_str(),
                quantity: item.quantity,
                source: AcquisitionSource::Starter,
                source_ref: None,
            })
            .collect();
        granted_tx(&tx, account_id, &starter_grants, now_ms())?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(granted)
    }

    /// Read the durable per-tab inventory slot capacities.  An empty or absent
    /// JSON (older rows) means every tab is at the default 24.
    pub fn load_inventory_slots(&self, account_id: &str) -> Result<BTreeMap<u8, u16>, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        let raw: String = db
            .query_row(
                "SELECT inventory_slots_json FROM player_stats WHERE account_id=?1",
                [account_id],
                |row| row.get(0),
            )
            .map_err(|_| "account persistence failed")?;
        if raw.is_empty() {
            return Ok(inventory::default_inventory_slots());
        }
        let parsed: BTreeMap<u8, u16> =
            serde_json::from_str(&raw).map_err(|_| "account persistence failed")?;
        let mut slots = inventory::default_inventory_slots();
        for (kind, capacity) in parsed {
            if inventory::valid_inventory_type(kind) {
                slots.insert(
                    kind,
                    capacity.clamp(inventory::SLOT_LIMIT, inventory::MAX_SLOT_LIMIT),
                );
            }
        }
        Ok(slots)
    }

    pub fn save_profile(&self, account_id: &str, profile: &Profile) -> Result<(), String> {
        let skills_json = serialize_skill_map(&profile.skills)?;
        let skill_points_json = serialize_skill_map(&profile.skill_points)?;
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        db.execute(
            "UPDATE player_stats SET hp=?2,max_hp=?3,mp=?4,max_mp=?5,level=?6,job=?7,exp=?8,exp_to_next=?9,mesos=?10,cash=?11,death_id=?12,map_id=?13,x=?14,y=?15,skills_json=?16,skill_points_json=?17,ability_stats_json=?18
             WHERE account_id=?1",
            params![
                account_id,
                profile.hp,
                profile.max_hp,
                profile.mp,
                profile.max_mp,
                profile.level,
                profile.job,
                profile.exp,
                profile.exp_to_next,
                i64::try_from(profile.mesos).map_err(|_| "account persistence failed")?,
                i64::try_from(profile.cash).map_err(|_| "account persistence failed")?,
                profile.death_id,
                profile.map_id,
                profile.x,
                profile.y,
                skills_json,
                skill_points_json,
                serde_json::to_string(&profile.ability_stats).map_err(|_| "account persistence failed")?,
            ],
        )
        .map_err(|_| "account persistence failed")?;
        Ok(())
    }

    /// Atomically advance a character from the expected job to the authored
    /// destination.  The temporary first-job support grant is part of this
    /// transaction, so a reconnect cannot observe job 200 without its SP/MP.
    pub fn advance_job(&self, account_id: &str, from_job: u32, job: u32) -> Result<bool, String> {
        if from_job == job {
            return Ok(false);
        }
        if !matches!(
            (from_job, job),
            (0, 200) | (200, 220) | (220, THIRD_JOB) | (THIRD_JOB, FOURTH_JOB)
        ) {
            return Ok(false);
        }
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        let (current_job, mut max_mp, mut mp, skills_json, skill_points_json, mage_support_granted):
            (i64, i64, i64, String, String, i64) = tx
            .query_row(
                "SELECT job,max_mp,mp,skills_json,skill_points_json,mage_support_granted FROM player_stats WHERE account_id=?1",
                [account_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
            )
            .optional()
            .map_err(|_| "account persistence failed")?
            .ok_or_else(|| "account persistence failed".to_owned())?;
        if u32::try_from(current_job).ok() != Some(from_job) {
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(false);
        }
        let mut skills = parse_skill_map(&skills_json)?;
        let mut skill_points = parse_skill_map(&skill_points_json)?;
        let required_level: i64 = if from_job == 0 && job == 200 {
            i64::from(FIRST_MAGE_JOB_LEVEL)
        } else if from_job == 200 && job == 220 {
            30
        } else if from_job == 220 && job == THIRD_JOB {
            60
        } else if from_job == THIRD_JOB && job == FOURTH_JOB {
            100
        } else {
            0
        };
        if job == 200 {
            // P: TMS273.7 export has no transfer grant script. Five book-200
            // points and hidden companion levels make the authorized shortcut
            // playable without pretending this is an original q1402 reward.
            grant_first_mage_fields(&mut max_mp, &mut mp, &mut skills, &mut skill_points);
        }
        if from_job == 200 && job == 220 {
            let level: u32 = tx
                .query_row(
                    "SELECT level FROM player_stats WHERE account_id=?1",
                    [account_id],
                    |row| row.get(0),
                )
                .map_err(|_| "account persistence failed")?;
            if level < 30 {
                return Ok(false);
            }
            skill_points.entry(220).or_insert(5); // P: starter second-job SP, not a max-skill grant.
            skills.entry(2200011).or_insert(1); // Source fixLevel=1.
        }
        if from_job == 220 && job == THIRD_JOB {
            let level: u32 = tx
                .query_row(
                    "SELECT level FROM player_stats WHERE account_id=?1",
                    [account_id],
                    |row| row.get(0),
                )
                .map_err(|_| "account persistence failed")?;
            if level < 60 {
                return Ok(false);
            }
            // The first third-job transfer owns the authored five starter SP.
            // The CAS on player_stats.job above makes this grant one-shot;
            // no old job-221 row is re-seeded on reconnect.
            skill_points.entry(THIRD_MAGE_BOOK).or_insert(5);
        }
        if from_job == THIRD_JOB && job == FOURTH_JOB {
            let level: u32 = tx
                .query_row(
                    "SELECT level FROM player_stats WHERE account_id=?1",
                    [account_id],
                    |row| row.get(0),
                )
                .map_err(|_| "account persistence failed")?;
            if level < 100 {
                return Ok(false);
            }
            // The fourth transfer owns the initial three points and the
            // level-101..140 P schedule.  The job CAS below makes this grant
            // one-shot; existing book-222 balances are preserved and only a
            // positive authored deficit is added.
            if skills.get(&FOURTH_FIXED_SKILL).copied().unwrap_or(0) == 0 {
                skills.insert(FOURTH_FIXED_SKILL, 1);
            }
            let due = fourth_missing_sp(level, &skills, &skill_points);
            if due > 0 {
                let available = skill_points.entry(FOURTH_MAGE_BOOK).or_default();
                *available = available.saturating_add(due);
            }
        }
        let is_mage = job == 200;
        let new_max_mp = if is_mage { max_mp.max(100) } else { max_mp };
        let new_mp = if is_mage { new_max_mp } else { mp };
        let next_support = if is_mage { 1 } else { mage_support_granted };
        let changed = tx
            .execute(
                "UPDATE player_stats SET job=?3,max_mp=?4,mp=?5,skills_json=?6,skill_points_json=?7,mage_support_granted=?8
                 WHERE account_id=?1 AND job=?2 AND level>=?9",
                params![
                    account_id,
                    from_job,
                    job,
                    new_max_mp,
                    new_mp,
                    serialize_skill_map(&skills)?,
                    serialize_skill_map(&skill_points)?,
                    next_support,
                    required_level,
                ],
            )
            .map_err(|_| "account persistence failed")?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(changed == 1)
    }

    /// Give an older job-200 row the one-time Hans support initialization.
    /// Existing SP/skill progress is retained verbatim.
    pub fn ensure_mage_support(&self, account_id: &str) -> Result<bool, String> {
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        let (job, granted, max_mp, skills_json, skill_points_json):
            (i64, i64, i64, String, String) = tx
            .query_row(
                "SELECT job,mage_support_granted,max_mp,skills_json,skill_points_json FROM player_stats WHERE account_id=?1",
                [account_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .optional()
            .map_err(|_| "account persistence failed")?
            .ok_or_else(|| "account persistence failed".to_owned())?;
        if job != 200 || granted != 0 {
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(false);
        }
        let mut skills = parse_skill_map(&skills_json)?;
        let mut skill_points = parse_skill_map(&skill_points_json)?;
        let mut new_max_mp = max_mp;
        let mut new_mp = max_mp;
        grant_first_mage_fields(&mut new_max_mp, &mut new_mp, &mut skills, &mut skill_points);
        tx.execute(
            "UPDATE player_stats SET max_mp=?2,mp=?3,skills_json=?4,skill_points_json=?5,mage_support_granted=1 WHERE account_id=?1 AND job=200 AND mage_support_granted=0",
            params![
                account_id,
                new_max_mp,
                new_mp,
                serialize_skill_map(&skills)?,
                serialize_skill_map(&skill_points)?,
            ],
        )
        .map_err(|_| "account persistence failed")?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(true)
    }

    pub fn allocate_ap(
        &self,
        account_id: &str,
        request_id: &str,
        stat: AbilityStat,
    ) -> Result<AbilityActionOutcome, String> {
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        let prior: Option<(String, bool, String, String)> = tx.query_row(
            "SELECT stat,success,code,stats_json FROM ability_actions WHERE account_id=?1 AND request_id=?2",
            params![account_id, request_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
            .optional().map_err(|_| "account persistence failed")?;
        if let Some((prior_stat, success, code, json)) = prior {
            return Ok(AbilityActionOutcome {
                success: success && prior_stat == stat.as_str(),
                code: if prior_stat == stat.as_str() {
                    code
                } else {
                    "request_conflict".into()
                },
                stats: serde_json::from_str(&json).map_err(|_| "invalid saved ability stats")?,
                already_resolved: true,
            });
        }
        let profile = read_profile(&tx, account_id)?;
        let mut stats = profile.ability_stats;
        let (success, code) = if profile.hp <= 0 {
            (false, "invalid_state")
        } else if stats.available_ap == 0 {
            (false, "not_enough_ap")
        } else if stats.add_point(stat) {
            (true, "")
        } else {
            (false, "stat_limit")
        };
        let json = serde_json::to_string(&stats).map_err(|_| "account persistence failed")?;
        if success {
            tx.execute(
                "UPDATE player_stats SET ability_stats_json=?2 WHERE account_id=?1",
                params![account_id, json],
            )
            .map_err(|_| "account persistence failed")?;
        }
        tx.execute("INSERT INTO ability_actions(account_id,request_id,stat,success,code,stats_json) VALUES(?1,?2,?3,?4,?5,?6)",
            params![account_id, request_id, stat.as_str(), success, code, json]).map_err(|_| "account persistence failed")?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(AbilityActionOutcome {
            success,
            code: code.into(),
            stats,
            already_resolved: false,
        })
    }

    pub fn learn_skill(
        &self,
        account_id: &str,
        request_id: &str,
        skill_id: u32,
        expected_job: u32,
        book_id: u32,
        max_level: u32,
        prerequisites: &BTreeMap<u32, u32>,
        hidden: bool,
    ) -> Result<SkillActionOutcome, String> {
        self.skill_action(
            account_id,
            request_id,
            "learn",
            skill_id,
            expected_job,
            book_id,
            max_level,
            prerequisites,
            hidden,
            0,
            0,
            skill_id,
        )
    }

    /// Public wrapper around `write_inventory_tx` for callers that mutate
    /// inventory outside an existing transaction (for example: the shop buy
    /// pipeline that adjusts slots and equipped directly).
    pub fn write_inventory(
        &self,
        account_id: &str,
        inventory_items: &[InventoryItem],
    ) -> Result<(), String> {
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        write_inventory_tx(&tx, account_id, inventory_items)?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(())
    }

    /// 現金商店限购：one SN's already-consumed purchase budget for this
    /// character (0 when the account never bought it).
    pub fn cash_purchased_units(&self, account_id: &str, sn: &str) -> Result<u64, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        db.query_row(
            "SELECT units FROM cash_purchases WHERE account_id=?1 AND sn=?2",
            params![account_id, sn],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map(|units| units.unwrap_or(0).max(0) as u64)
        .map_err(|_| "account persistence failed".into())
    }

    /// 現金商店限购：add `units` to the SN's consumed budget (upsert).
    pub fn record_cash_purchase(
        &self,
        account_id: &str,
        sn: &str,
        units: u64,
    ) -> Result<(), String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        db.execute(
            "INSERT INTO cash_purchases(account_id,sn,units) VALUES(?1,?2,?3)
             ON CONFLICT(account_id,sn) DO UPDATE SET units=units+?3",
            params![account_id, sn, units as i64],
        )
        .map(|_| ())
        .map_err(|_| "account persistence failed".into())
    }

    pub fn prior_revive(
        &self,
        account_id: &str,
        request_id: &str,
    ) -> Result<Option<ReviveOutcome>, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        db.query_row(
            "SELECT request_id,death_id,success,code FROM revive_actions
             WHERE account_id=?1 AND request_id=?2",
            params![account_id, request_id],
            |row| {
                Ok(ReviveOutcome {
                    request_id: row.get(0)?,
                    death_id: row.get(1)?,
                    success: row.get::<_, i64>(2)? != 0,
                    code: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|_| "account persistence failed".into())
    }

    pub fn revive(
        &self,
        account_id: &str,
        request_id: &str,
        death_id: &str,
    ) -> Result<ReviveOutcome, String> {
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        if let Some(prior) = tx
            .query_row(
                "SELECT request_id,death_id,success,code FROM revive_actions
                 WHERE account_id=?1 AND request_id=?2",
                params![account_id, request_id],
                |row| {
                    Ok(ReviveOutcome {
                        request_id: row.get(0)?,
                        death_id: row.get(1)?,
                        success: row.get::<_, i64>(2)? != 0,
                        code: row.get(3)?,
                    })
                },
            )
            .optional()
            .map_err(|_| "account persistence failed")?
        {
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(prior);
        }
        let state: Option<(i64, i64, String)> = tx
            .query_row(
                "SELECT hp,max_hp,death_id FROM player_stats WHERE account_id=?1",
                [account_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|_| "account persistence failed")?;
        let (success, code) = match state {
            Some((hp, _max_hp, stored_death_id))
                if hp <= 0 && !death_id.is_empty() && stored_death_id == death_id =>
            {
                let changed = tx
                    .execute(
                        "UPDATE player_stats SET hp=MIN(50,max_hp),death_id='' WHERE account_id=?1 AND hp<=0 AND death_id=?2",
                        params![account_id, death_id],
                    )
                    .map_err(|_| "account persistence failed")?;
                if changed == 1 {
                    (true, String::new())
                } else {
                    (false, "revive_stale".to_owned())
                }
            }
            Some(_) => (false, "revive_stale".to_owned()),
            None => (false, "profile_unavailable".to_owned()),
        };
        tx.execute(
            "INSERT INTO revive_actions(account_id,request_id,death_id,success,code)
             VALUES (?1,?2,?3,?4,?5)",
            params![
                account_id,
                request_id,
                death_id,
                if success { 1 } else { 0 },
                code
            ],
        )
        .map_err(|_| "account persistence failed")?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(ReviveOutcome {
            request_id: request_id.to_owned(),
            death_id: death_id.to_owned(),
            success,
            code,
        })
    }

    /// Read the account's warehouse.  Storage is account-wide and shared by
    /// every character on it, which is why the row key is the account and not
    /// the character — the original keeps deposited goods available to a newly
    /// created character of the same account.
    pub fn load_storage(&self, account_id: &str) -> Result<Vec<InventoryItem>, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        read_storage_db(&db, account_id)
    }

    /// Move one stack between the character's inventory and the account
    /// warehouse.  Both directions run in a single transaction so a crash can
    /// never leave an item in both places or in neither.
    pub fn storage_transfer(
        &self,
        account_id: &str,
        request_id: &str,
        operation: StorageOperation,
        inventory_type: u8,
        slot: i16,
        quantity: u32,
    ) -> Result<StorageOutcome, String> {
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        // Replaying a request must never move an item twice.  Re-send the
        // recorded result without touching either side again.
        if let Some(prior) = read_storage_action(&tx, account_id, request_id)? {
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(prior);
        }
        // Validate the whole move *before* mutating either side.  A refused
        // transfer must be a true no-op, and recording the refusal in the same
        // transaction keeps a replay idempotent for failures as well as
        // successes.
        //
        // The move itself is the domain action `MoveItem` (world model §13:
        // 背包 ⇄ 仓库 Owner 不变、Location 改变）, so the two directions are
        // just two (location, side) pairs and no longer two hand-written
        // take/put pairs.
        let (from, to) = match operation {
            StorageOperation::Deposit => (
                item_world::ItemLocation::Inventory {
                    account_id,
                    kind: inventory_type,
                    slot,
                },
                item_world::ContainerSide::Storage { account_id },
            ),
            StorageOperation::Withdraw => (
                item_world::ItemLocation::Storage { account_id, slot },
                item_world::ContainerSide::Inventory { account_id },
            ),
        };
        let moved = item_world::move_stack(&tx, from, to, quantity)?;
        // 原因由领域原语给出，措辞由**本动作**决定（见 `refusal_code`）。
        let (success, code) = match moved.refusal() {
            None => (true, String::new()),
            Some(reason) => (false, operation.refusal_code(reason).to_owned()),
        };
        let outcome = StorageOutcome {
            request_id: request_id.to_owned(),
            operation,
            inventory_type,
            slot,
            item_id: moved.item_id(),
            quantity: moved.moved_quantity(),
            success,
            code,
        };
        insert_storage_action(&tx, account_id, &outcome)?;
        if outcome.success {
            normalize_inventory_tx(&tx)?;
        }
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(outcome)
    }

    /// Deposit or withdraw mesos.  Warehouse mesos are a separate balance from
    /// the character's purse, so a transfer must debit one and credit the other
    /// atomically.
    pub fn storage_mesos(
        &self,
        account_id: &str,
        request_id: &str,
        operation: StorageOperation,
        quantity: u32,
    ) -> Result<StorageMesosOutcome, String> {
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        if let Some(prior) = read_storage_mesos_action(&tx, account_id, request_id)? {
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(prior);
        }
        let amount = i64::from(quantity);
        let (success, code) = if quantity == 0 {
            (false, "invalid_quantity".to_owned())
        } else {
            // The warehouse balance gets its own row (upsert), but the purse
            // lives on the existing profile row — `player_stats` has NOT NULL
            // columns, so a partial INSERT would fail.  A storage session
            // implies a loaded profile, so a plain UPDATE is correct and a
            // missing row is a real error rather than a silent credit.
            let (debit, credit) = match operation {
                StorageOperation::Deposit => (
                    "UPDATE player_stats SET mesos=mesos-?2 WHERE account_id=?1 AND mesos>=?2",
                    "INSERT INTO storage_mesos(account_id,mesos) VALUES (?1,?2)
                     ON CONFLICT(account_id) DO UPDATE SET mesos=mesos+excluded.mesos",
                ),
                StorageOperation::Withdraw => (
                    "UPDATE storage_mesos SET mesos=mesos-?2 WHERE account_id=?1 AND mesos>=?2",
                    "UPDATE player_stats SET mesos=mesos+?2 WHERE account_id=?1",
                ),
            };
            let changed = tx
                .execute(debit, params![account_id, amount])
                .map_err(|_| "account persistence failed")?;
            if changed != 1 {
                (false, "mesos_insufficient".to_owned())
            } else {
                let credited = tx
                    .execute(credit, params![account_id, amount])
                    .map_err(|_| "account persistence failed")?;
                if credited != 1 {
                    (false, "profile_unavailable".to_owned())
                } else {
                    (true, String::new())
                }
            }
        };
        let mesos = read_mesos_tx(&tx, account_id)?;
        let stored = read_storage_mesos_tx(&tx, account_id)?;
        let outcome = StorageMesosOutcome {
            request_id: request_id.to_owned(),
            operation,
            quantity,
            success,
            code,
            mesos,
            stored_mesos: stored,
        };
        insert_storage_mesos_action(&tx, account_id, &outcome)?;
        if success {
            tx.commit().map_err(|_| "account persistence failed")?;
        } else {
            tx.rollback().map_err(|_| "account persistence failed")?;
        }
        Ok(outcome)
    }

    /// Current warehouse mesos.  Read-only; a client never supplies this value.
    pub fn storage_mesos_balance(&self, account_id: &str) -> Result<u64, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        read_storage_mesos_db(&db, account_id)
    }

    /// Read the durable public Windbell bridge state.  This is deliberately
    /// separate from `player_stats`: the bridge is one shared world fact, not
    /// an account attribute.
    pub fn load_windbell_bridge_state(
        &self,
        world_id: &str,
    ) -> Result<Option<(String, u64)>, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        db.query_row(
            "SELECT state_json,revision FROM windbell_bridge_state WHERE world_id=?1",
            [world_id],
            |row| {
                let revision = row
                    .get::<_, i64>(1)
                    .ok()
                    .and_then(|value| u64::try_from(value.max(0)).ok())
                    .unwrap_or(0);
                Ok((row.get::<_, String>(0)?, revision))
            },
        )
        .optional()
        .map_err(|_| "account persistence failed".to_owned())
    }

    /// Persist one public Windbell bridge snapshot.  The world loop is the
    /// sole caller, so a single upsert is sufficient here; request-level
    /// replay records are kept in `windbell_action_log` below.
    pub fn save_windbell_bridge_state(
        &self,
        world_id: &str,
        state_json: &str,
        revision: u64,
    ) -> Result<(), String> {
        let revision = i64::try_from(revision).map_err(|_| "account persistence failed")?;
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        db.execute(
            "INSERT INTO windbell_bridge_state(world_id,state_json,revision) VALUES (?1,?2,?3)
             ON CONFLICT(world_id) DO UPDATE SET state_json=excluded.state_json,revision=excluded.revision",
            params![world_id, state_json, revision],
        )
        .map_err(|_| "account persistence failed".to_owned())?;
        Ok(())
    }

    /// Read the character-owned Windbell contribution/arrival memory.
    pub fn load_windbell_player_state(&self, account_id: &str) -> Result<Option<String>, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        db.query_row(
            "SELECT state_json FROM windbell_player_state WHERE account_id=?1",
            [account_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "account persistence failed".to_owned())
    }

    /// Persist character-owned Windbell memory without touching the legacy
    /// profile row.
    pub fn save_windbell_player_state(
        &self,
        account_id: &str,
        state_json: &str,
    ) -> Result<(), String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        db.execute(
            "INSERT INTO windbell_player_state(account_id,state_json) VALUES (?1,?2)
             ON CONFLICT(account_id) DO UPDATE SET state_json=excluded.state_json",
            params![account_id, state_json],
        )
        .map_err(|_| "account persistence failed".to_owned())?;
        Ok(())
    }

    /// Return a previously committed Windbell request, if one exists.  The
    /// result is stored as JSON so the protocol can grow without another
    /// schema migration; the world still validates the action and instance
    /// token before accepting a new request.
    pub fn load_windbell_action(
        &self,
        account_id: &str,
        request_id: &str,
    ) -> Result<Option<(String, String)>, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        db.query_row(
            "SELECT action,result_json FROM windbell_action_log WHERE account_id=?1 AND request_id=?2",
            params![account_id, request_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|_| "account persistence failed".to_owned())
    }

    /// Commit a Windbell action receipt together with every durable fact that
    /// the action changes.  Public bridge material and the character's
    /// contribution memory must cross the same SQLite commit boundary as the
    /// request id: a failed write must never consume material while leaving a
    /// replay receipt behind (or the reverse).
    pub fn commit_windbell_action(
        &self,
        account_id: &str,
        request_id: &str,
        action: &str,
        result_json: &str,
        bridge: Option<(&str, u64)>,
        player_state_json: Option<&str>,
    ) -> Result<bool, String> {
        let revision = bridge
            .map(|(_, revision)| {
                i64::try_from(revision).map_err(|_| "account persistence failed".to_owned())
            })
            .transpose()?;
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        let inserted = tx
            .execute(
                "INSERT OR IGNORE INTO windbell_action_log(account_id,request_id,action,result_json)
                 VALUES (?1,?2,?3,?4)",
                params![account_id, request_id, action, result_json],
            )
            .map_err(|_| "account persistence failed".to_owned())?;
        if inserted != 1 {
            // Keep the transaction boundary explicit even for a duplicate so
            // SQLite releases its write lock before the caller replays the
            // already committed snapshot.
            tx.commit()
                .map_err(|_| "account persistence failed".to_owned())?;
            return Ok(false);
        }
        if let Some((state_json, _)) = bridge {
            let revision = revision.ok_or_else(|| "account persistence failed".to_owned())?;
            tx.execute(
                "INSERT INTO windbell_bridge_state(world_id,state_json,revision) VALUES (?1,?2,?3)
                 ON CONFLICT(world_id) DO UPDATE SET state_json=excluded.state_json,revision=excluded.revision",
                params!["windbell", state_json, revision],
            )
            .map_err(|_| "account persistence failed".to_owned())?;
        }
        if let Some(state_json) = player_state_json {
            tx.execute(
                "INSERT INTO windbell_player_state(account_id,state_json) VALUES (?1,?2)
                 ON CONFLICT(account_id) DO UPDATE SET state_json=excluded.state_json",
                params![account_id, state_json],
            )
            .map_err(|_| "account persistence failed".to_owned())?;
        }
        tx.commit()
            .map_err(|_| "account persistence failed".to_owned())?;
        Ok(true)
    }
}

pub fn start(path: &Path) -> Result<AuthService, Box<dyn std::error::Error>> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let db = Connection::open(path)?;
    Store::init(&db)?;
    let store = Store {
        db: Arc::new(Mutex::new(db)),
    };
    let (tx, mut rx) = mpsc::channel(32);
    let auth_db = store.db.clone();
    let lobby_store = store.clone();
    std::thread::spawn(move || {
        let mut sessions: HashMap<String, Session> = HashMap::new();
        while let Some(request) = rx.blocking_recv() {
            match request {
                Request::Register(c, reply) => {
                    let result = (|| {
                        let salt = SaltString::generate(&mut OsRng);
                        let hash = Argon2::default()
                            .hash_password(c.password.as_bytes(), &salt)
                            .map_err(|_| "password hashing failed")?
                            .to_string();
                        let db = auth_db.lock().map_err(|_| "account store unavailable")?;
                        db.execute(
                            "INSERT INTO accounts(id,username,password_hash) VALUES (?1,?2,?3)",
                            params![random_id(), c.username, hash],
                        )
                        .map_err(|e| {
                            if e.sqlite_error_code()
                                == Some(rusqlite::ErrorCode::ConstraintViolation)
                            {
                                "username already exists"
                            } else {
                                "account persistence failed"
                            }
                        })?;
                        Ok(())
                    })()
                    .map_err(str::to_owned);
                    let _ = reply.send(result);
                }
                Request::Login(c, reply) => {
                    let result = (|| {
                        let db = auth_db.lock().map_err(|_| "account store unavailable")?;
                        let row: Option<(String, String)> = db
                            .query_row(
                                "SELECT id,password_hash FROM accounts WHERE username=?1",
                                [&c.username],
                                |r| Ok((r.get(0)?, r.get(1)?)),
                            )
                            .optional()
                            .map_err(|_| "account read failed")?;
                        let (id, hash) = row.ok_or("invalid credentials")?;
                        let parsed =
                            PasswordHash::new(&hash).map_err(|_| "account hash invalid")?;
                        Argon2::default()
                            .verify_password(c.password.as_bytes(), &parsed)
                            .map_err(|_| "invalid credentials")?;
                        let identity = Identity {
                            id,
                            username: c.username,
                        };
                        let token = random_id();
                        sessions.retain(|_, session| session.expiry > Instant::now());
                        // A fresh account login starts a new selection flow;
                        // invalidate role tokens issued by the previous flow.
                        sessions.retain(|_, session| session.account_id != identity.id);
                        sessions.insert(
                            identity.id.clone(),
                            Session {
                                token: token.clone(),
                                identity: identity.clone(),
                                account_id: identity.id.clone(),
                                kind: SessionKind::Account,
                                expiry: Instant::now() + Duration::from_secs(86400),
                            },
                        );
                        Ok((identity, token))
                    })()
                    .map_err(str::to_owned);
                    let _ = reply.send(result);
                }
                #[cfg(test)]
                Request::Verify(token, reply) => {
                    let identity = sessions
                        .values()
                        .find(|session| session.token == token && session.expiry > Instant::now())
                        .map(|session| session.identity.clone());
                    let _ = reply.send(identity);
                }
                Request::VerifyCharacter(token, reply) => {
                    sessions.retain(|_, session| session.expiry > Instant::now());
                    let session = sessions
                        .values()
                        .find(|session| session.token == token)
                        .cloned();
                    let identity = match session {
                        Some(session) if session.kind == SessionKind::Character => {
                            Some(session.identity)
                        }
                        // The original WS protocol sent the account token
                        // directly. Preserve that path only for a pre-lobby
                        // account whose one legacy role still owns account.id.
                        Some(session) if session.kind == SessionKind::Account => {
                            lobby::legacy_identity(&lobby_store, &session.account_id)
                                .ok()
                                .flatten()
                                .map(|(id, username)| Identity { id, username })
                        }
                        _ => None,
                    };
                    let _ = reply.send(identity);
                }
                Request::Lobby {
                    token,
                    action,
                    reply,
                } => {
                    sessions.retain(|_, session| session.expiry > Instant::now());
                    let result = (|| {
                        let account = sessions
                            .values()
                            .find(|session| {
                                session.kind == SessionKind::Account && session.token == token
                            })
                            .cloned()
                            .ok_or_else(|| "invalid session".to_owned())?;
                        let response = lobby::handle(&lobby_store, &account.account_id, action)?;
                        let selected_token = random_id();
                        let (response, character) = response.with_token(selected_token.clone());
                        if let Some(character) = character {
                            // The client closes its old WS before selecting
                            // again. Keep the session map bounded even if it
                            // retries selection repeatedly.
                            let account_id = account.account_id.clone();
                            sessions.retain(|_, session| {
                                session.account_id != account_id
                                    || session.kind != SessionKind::Character
                            });
                            sessions.insert(
                                selected_token.clone(),
                                Session {
                                    token: selected_token,
                                    identity: Identity {
                                        id: character.id,
                                        username: character.name,
                                    },
                                    account_id,
                                    kind: SessionKind::Character,
                                    expiry: Instant::now() + Duration::from_secs(86400),
                                },
                            );
                        }
                        Ok(response)
                    })();
                    let _ = reply.send(result);
                }
            }
        }
    });
    Ok(AuthService { sender: tx, store })
}

#[cfg(test)]
mod tests {
    use super::*;

    include!("quest_store_acceptance.rs");
    include!("quest_kill_store_acceptance.rs");
    include!("attack_store_acceptance.rs");
    include!("third_store_acceptance.rs");
    include!("fourth_store_acceptance.rs");
    include!("hyper_store_acceptance.rs");
    include!("continuation_store_acceptance.rs");
    include!("windbell_store_acceptance.rs");
    include!("notebook_store_acceptance.rs");
    include!("shop_commit_acceptance.rs");

    #[tokio::test]
    async fn accounts_persist_and_sessions_require_valid_credentials() {
        let path = std::env::temp_dir().join(format!("maple-auth-{}.sqlite3", random_id()));
        let auth = start(&path).unwrap();
        let (reply, rx) = oneshot::channel();
        auth.sender
            .send(Request::Register(
                Credentials {
                    username: "alice".into(),
                    password: "correct-password".into(),
                },
                reply,
            ))
            .await
            .unwrap();
        rx.await.unwrap().unwrap();
        let (reply, rx) = oneshot::channel();
        auth.sender
            .send(Request::Login(
                Credentials {
                    username: "alice".into(),
                    password: "wrong-password".into(),
                },
                reply,
            ))
            .await
            .unwrap();
        assert!(rx.await.unwrap().is_err());
        drop(auth);
        let auth = start(&path).unwrap();
        let (reply, rx) = oneshot::channel();
        auth.sender
            .send(Request::Login(
                Credentials {
                    username: "alice".into(),
                    password: "correct-password".into(),
                },
                reply,
            ))
            .await
            .unwrap();
        let (identity, token) = rx.await.unwrap().unwrap();
        let (reply, rx) = oneshot::channel();
        auth.sender
            .send(Request::Verify(token, reply))
            .await
            .unwrap();
        assert_eq!(rx.await.unwrap().unwrap().id, identity.id);
        let (reply, rx) = oneshot::channel();
        auth.sender
            .send(Request::Verify("forged-token".into(), reply))
            .await
            .unwrap();
        assert!(rx.await.unwrap().is_none());
        drop(auth);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    #[test]
    fn character_job_migrates_isolates_and_survives_reward_and_config_changes() {
        let path =
            std::env::temp_dir().join(format!("maple-ability-migration-{}.sqlite3", random_id()));
        let db = Connection::open(&path).unwrap();
        // The pre-job schema represents an existing 273 character.  Store::init
        // must add job with the beginner default without replacing this row.
        db.execute_batch(
            "CREATE TABLE player_stats(
                account_id TEXT PRIMARY KEY,
                hp INTEGER NOT NULL, max_hp INTEGER NOT NULL,
                mp INTEGER NOT NULL, max_mp INTEGER NOT NULL,
                level INTEGER NOT NULL, exp INTEGER NOT NULL,
                exp_to_next INTEGER NOT NULL, mesos INTEGER NOT NULL DEFAULT 0,
                death_id TEXT NOT NULL DEFAULT '',
                starter_equipment_seeded INTEGER NOT NULL DEFAULT 0,
                map_id TEXT NOT NULL DEFAULT '', x REAL NOT NULL DEFAULT 0,
                y REAL NOT NULL DEFAULT 0
             );
             INSERT INTO player_stats(account_id,hp,max_hp,mp,max_mp,level,exp,exp_to_next)
             VALUES ('legacy',50,50,5,5,3,4,15);",
        )
        .unwrap();
        Store::init(&db).unwrap();
        let store = Store {
            db: Arc::new(Mutex::new(db)),
        };
        let defaults = |job: u32| Profile {
            hp: 50,
            max_hp: 50,
            mp: 5,
            max_mp: 5,
            level: 1,
            job,
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            cash: 0,
            death_id: String::new(),
            map_id: String::new(),
            x: 0.0,
            y: 0.0,
            inventory: Vec::new(),
            skills: BTreeMap::new(),
            skill_points: BTreeMap::new(),
            ability_stats: AbilityStats::default(),
        };

        assert_eq!(store.load_profile("legacy", &defaults(200)).unwrap().job, 0);
        assert_eq!(
            store
                .load_profile("legacy", &defaults(200))
                .unwrap()
                .ability_stats
                .available_ap,
            10
        );
        assert!(
            store
                .allocate_ap("legacy", "legacy-ap", AbilityStat::Intelligence)
                .unwrap()
                .success
        );

        assert_eq!(store.load_profile("new", &defaults(200)).unwrap().job, 200);
        let mut new_profile = store.load_profile("new", &defaults(300)).unwrap();
        new_profile.job = 220;
        store.save_profile("new", &new_profile).unwrap();

        // Attack reward settlement uses the transactional write_profile path;
        // it must carry the character job through the same update.
        store
            .claim_attack("new", "map", "job-attack", "job-action", "started")
            .unwrap();
        store
            .resolve_attack(
                "new",
                "map",
                "job-attack",
                Some("mob"),
                1,
                true,
                1,
                1,
                &[],
                &[15],
                &[String::from("new")],
            )
            .unwrap();
        assert_eq!(store.load_profile("new", &defaults(300)).unwrap().job, 220);
        assert_eq!(store.load_profile("legacy", &defaults(300)).unwrap().job, 0);

        let mut transfer = store.load_profile("transfer", &defaults(0)).unwrap();
        transfer.hp = 37;
        transfer.max_hp = 61;
        transfer.mp = 9;
        transfer.max_mp = 17;
        transfer.level = 7;
        transfer.exp = 4;
        transfer.exp_to_next = 19;
        transfer.mesos = 123;
        transfer.map_id = "001020000".into();
        transfer.x = 448.0;
        transfer.y = -41.0;
        transfer.skills = BTreeMap::from([(2001008, 1)]);
        transfer.skill_points = BTreeMap::from([(2, 7)]);
        store.save_profile("transfer", &transfer).unwrap();
        // The mage exception starts at level 8; level 7 remains blocked.
        assert!(!store.advance_job("transfer", 0, 200).unwrap());
        assert_eq!(store.load_profile("transfer", &defaults(0)).unwrap().job, 0);
        transfer.level = 8;
        store.save_profile("transfer", &transfer).unwrap();
        assert!(store.advance_job("transfer", 0, 200).unwrap());
        let transferred = store.load_profile("transfer", &defaults(300)).unwrap();
        assert_eq!(transferred.job, 200);
        assert_eq!(transferred.hp, 37);
        assert_eq!(transferred.max_hp, 61);
        assert_eq!(transferred.mp, 100);
        assert_eq!(transferred.max_mp, 100);
        assert_eq!(transferred.level, 8);
        assert_eq!(transferred.exp, 4);
        assert_eq!(transferred.exp_to_next, 19);
        assert_eq!(transferred.mesos, 123);
        assert_eq!(transferred.map_id, "001020000");
        assert_eq!(transferred.x, 448.0);
        assert_eq!(transferred.y, -41.0);
        assert_eq!(
            transferred.skills,
            BTreeMap::from([(2000007, 1), (2001008, 1), (2001012, 1)])
        );
        assert_eq!(transferred.skill_points, BTreeMap::from([(2, 7), (200, 5)]));
        assert!(!store.advance_job("transfer", 0, 220).unwrap());
        assert!(!store.advance_job("transfer", 200, 220).unwrap());
        let mut eligible = transferred.clone();
        eligible.level = 30;
        store.save_profile("transfer", &eligible).unwrap();
        assert!(store.advance_job("transfer", 200, 220).unwrap());
        let ice = store.load_profile("transfer", &defaults(0)).unwrap();
        assert_eq!(ice.job, 220);
        assert_eq!(ice.skill_points.get(&200), Some(&5));
        assert_eq!(ice.skill_points.get(&220), Some(&5));
        assert_eq!(ice.skills.get(&2200011), Some(&1));
        assert!(!store.advance_job("transfer", 200, 220).unwrap());
        assert_eq!(
            store
                .load_profile("transfer", &defaults(0))
                .unwrap()
                .skill_points,
            ice.skill_points
        );

        drop(store);
        let db = Connection::open(&path).unwrap();
        Store::init(&db).unwrap();
        let store = Store {
            db: Arc::new(Mutex::new(db)),
        };
        let restored = store.load_profile("legacy", &defaults(300)).unwrap();
        assert_eq!((restored.level, restored.exp), (3, 4));
        assert_eq!(
            (
                restored.ability_stats.intelligence,
                restored.ability_stats.available_ap
            ),
            (5, 9)
        );
        assert!(
            store
                .allocate_ap("legacy", "legacy-ap", AbilityStat::Intelligence)
                .unwrap()
                .already_resolved
        );
        assert_eq!(
            store
                .load_profile("legacy", &defaults(0))
                .unwrap()
                .ability_stats,
            restored.ability_stats
        );

        // A corrupt persisted value is rejected and the failed read cannot
        // silently normalize it or overwrite it with the startup default.
        {
            let db = store.db.lock().unwrap();
            db.execute(
                "UPDATE player_stats SET job=-1 WHERE account_id='legacy'",
                [],
            )
            .unwrap();
        }
        assert!(store.load_profile("legacy", &defaults(0)).is_err());
        let db = store.db.lock().unwrap();
        let raw_job: i64 = db
            .query_row(
                "SELECT job FROM player_stats WHERE account_id='legacy'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(raw_job, -1);
        drop(db);
        drop(store);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    #[test]
    fn skill_state_migrates_isolates_survives_reward_and_restart() {
        let path = std::env::temp_dir().join(format!("maple-skills-{}.sqlite3", random_id()));
        {
            let db = Connection::open(&path).unwrap();
            // Deliberately omit the skill columns to exercise the legacy
            // player_stats migration.  The row must become an empty state.
            db.execute_batch(
                "CREATE TABLE player_stats(
                    account_id TEXT PRIMARY KEY,
                    hp INTEGER NOT NULL, max_hp INTEGER NOT NULL,
                    mp INTEGER NOT NULL, max_mp INTEGER NOT NULL,
                    level INTEGER NOT NULL, exp INTEGER NOT NULL,
                    exp_to_next INTEGER NOT NULL, mesos INTEGER NOT NULL DEFAULT 0,
                    death_id TEXT NOT NULL DEFAULT '',
                    starter_equipment_seeded INTEGER NOT NULL DEFAULT 0,
                    map_id TEXT NOT NULL DEFAULT '', x REAL NOT NULL DEFAULT 0,
                    y REAL NOT NULL DEFAULT 0
                 );
                 INSERT INTO player_stats(account_id,hp,max_hp,mp,max_mp,level,exp,exp_to_next)
                 VALUES ('legacy',50,50,5,5,1,0,15);",
            )
            .unwrap();
            Store::init(&db).unwrap();
        }

        let auth = start(&path).unwrap();
        let store = auth.store.clone();
        let defaults = Profile {
            hp: 50,
            max_hp: 50,
            mp: 5,
            max_mp: 5,
            level: 1,
            job: 0,
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            cash: 0,
            death_id: String::new(),
            map_id: String::new(),
            x: 0.0,
            y: 0.0,
            inventory: Vec::new(),
            // Non-empty defaults prove that new rows do not receive skill
            // state from a caller's startup configuration.
            skills: BTreeMap::from([(2001008, 99)]),
            skill_points: BTreeMap::from([(7, 99)]),
            ability_stats: AbilityStats::default(),
        };

        assert!(store
            .load_profile("legacy", &defaults)
            .unwrap()
            .skills
            .is_empty());
        assert!(store
            .load_profile("legacy", &defaults)
            .unwrap()
            .skill_points
            .is_empty());
        store.load_profile("a", &defaults).unwrap();
        store.load_profile("b", &defaults).unwrap();
        assert!(store
            .load_profile("a", &defaults)
            .unwrap()
            .skills
            .is_empty());
        assert!(store
            .load_profile("a", &defaults)
            .unwrap()
            .skill_points
            .is_empty());

        let mut a = store.load_profile("a", &defaults).unwrap();
        a.skills = BTreeMap::from([(2001008, 1), (2201008, 3)]);
        a.skill_points = BTreeMap::from([(1, 7), (2, 2)]);
        store.save_profile("a", &a).unwrap();
        assert!(store
            .load_profile("b", &defaults)
            .unwrap()
            .skills
            .is_empty());
        assert!(store
            .load_profile("b", &defaults)
            .unwrap()
            .skill_points
            .is_empty());

        // The transactional reward path must read/write the complete profile
        // without dropping either skill map.
        store
            .claim_attack("a", "map", "skill-reward", "skill-action", "started")
            .unwrap();
        let resolved = store
            .resolve_attack(
                "a",
                "map",
                "skill-reward",
                Some("skill-monster"),
                1,
                true,
                3,
                1,
                &[],
                &[15],
                &[String::from("a")],
            )
            .unwrap();
        assert_eq!(resolved.profile.as_ref().unwrap().skills, a.skills);
        assert_eq!(
            resolved.profile.as_ref().unwrap().skill_points,
            a.skill_points
        );

        drop(store);
        drop(auth);
        let reopened = start(&path).unwrap();
        let restored = reopened.store.load_profile("a", &defaults).unwrap();
        assert_eq!(restored.skills, a.skills);
        assert_eq!(restored.skill_points, a.skill_points);
        assert!(reopened
            .store
            .load_profile("b", &defaults)
            .unwrap()
            .skills
            .is_empty());

        // Invalid JSON, negative values, and values beyond u32 are rejected
        // instead of being replaced by an empty/default map.
        {
            let db = reopened.store.db.lock().unwrap();
            db.execute(
                "UPDATE player_stats SET skills_json='{bad', skill_points_json='{}' WHERE account_id='a'",
                [],
            )
            .unwrap();
        }
        assert!(reopened.store.load_profile("a", &defaults).is_err());
        {
            let db = reopened.store.db.lock().unwrap();
            db.execute(
                "UPDATE player_stats SET skills_json='{\"2001008\":-1}', skill_points_json='{}' WHERE account_id='a'",
                [],
            )
            .unwrap();
        }
        assert!(reopened.store.load_profile("a", &defaults).is_err());
        {
            let db = reopened.store.db.lock().unwrap();
            db.execute(
                "UPDATE player_stats SET skills_json='{}', skill_points_json='{\"1\":4294967296}' WHERE account_id='a'",
                [],
            )
            .unwrap();
        }
        assert!(reopened.store.load_profile("a", &defaults).is_err());

        drop(reopened);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    #[test]
    fn skill_actions_are_transactional_and_request_idempotent() {
        let db = Connection::open_in_memory().unwrap();
        Store::init(&db).unwrap();
        let store = Store {
            db: Arc::new(Mutex::new(db)),
        };
        let defaults = Profile {
            hp: 50,
            max_hp: 50,
            mp: 100,
            max_mp: 100,
            level: 9,
            job: 200,
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            cash: 0,
            death_id: String::new(),
            map_id: String::new(),
            x: 0.0,
            y: 0.0,
            inventory: Vec::new(),
            skills: BTreeMap::from([(2000007, 1), (2001012, 1)]),
            skill_points: BTreeMap::from([(200, 5)]),
            ability_stats: AbilityStats::default(),
        };
        store.load_profile("mage", &defaults).unwrap();
        store.save_profile("mage", &defaults).unwrap();
        let first = store
            .learn_skill(
                "mage",
                "learn-bolt",
                2001008,
                200,
                200,
                20,
                &BTreeMap::new(),
                false,
            )
            .unwrap();
        assert!(first.success);
        assert_eq!(first.remaining_sp, 4);
        let replay = store
            .learn_skill(
                "mage",
                "learn-bolt",
                2001008,
                200,
                200,
                20,
                &BTreeMap::new(),
                false,
            )
            .unwrap();
        assert!(replay.already_resolved);
        assert!(replay.success);
        assert_eq!(replay.remaining_sp, 4);
        let cast = store
            .cast_skill("mage", "cast-bolt", 2001008, 200, 200, 20, 16)
            .unwrap();
        assert!(cast.success);
        assert_eq!(cast.mp, 84);
        let cast_replay = store
            .cast_skill("mage", "cast-bolt", 2001008, 200, 200, 20, 16)
            .unwrap();
        assert!(cast_replay.already_resolved);
        assert_eq!(cast_replay.mp, 84);
        let conflict = store
            .cast_skill("mage", "cast-bolt", 2001009, 200, 200, 5, 28)
            .unwrap();
        assert!(conflict.already_resolved);
        assert!(!conflict.success);
        assert_eq!(conflict.code, "request_conflict");
        assert!(
            !store
                .learn_skill(
                    "mage",
                    "early-ice",
                    2201008,
                    220,
                    220,
                    20,
                    &BTreeMap::new(),
                    false
                )
                .unwrap()
                .success
        );
        let mut eligible = store.load_profile("mage", &defaults).unwrap();
        eligible.level = 30;
        store.save_profile("mage", &eligible).unwrap();
        assert!(store.advance_job("mage", 200, 220).unwrap());
        assert!(
            store
                .learn_skill(
                    "mage",
                    "learn-ice",
                    2201008,
                    220,
                    220,
                    20,
                    &BTreeMap::new(),
                    false
                )
                .unwrap()
                .success
        );
        assert!(
            store
                .learn_skill(
                    "mage",
                    "learn-ice",
                    2201008,
                    220,
                    220,
                    20,
                    &BTreeMap::new(),
                    false
                )
                .unwrap()
                .already_resolved
        );
        assert!(
            !store
                .learn_skill(
                    "mage",
                    "wrong-book",
                    2201008,
                    200,
                    200,
                    20,
                    &BTreeMap::new(),
                    false
                )
                .unwrap()
                .success
        );
        let ice = store.load_profile("mage", &defaults).unwrap();
        assert_eq!(ice.skill_points.get(&200), Some(&4));
        assert_eq!(ice.skill_points.get(&220), Some(&4));
    }

    #[test]
    fn beginner_learning_sp_and_cooldowns_survive_replay_and_reopen() {
        let path = std::env::temp_dir().join(format!("beginner-skills-{}.sqlite3", random_id()));
        let db = Connection::open(&path).unwrap();
        Store::init(&db).unwrap();
        let store = Store {
            db: Arc::new(Mutex::new(db)),
        };
        let base = Profile {
            hp: 30,
            max_hp: 50,
            mp: 30,
            max_mp: 30,
            level: 3,
            job: 0,
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            cash: 0,
            death_id: String::new(),
            map_id: String::new(),
            x: 0.0,
            y: 0.0,
            inventory: Vec::new(),
            skills: BTreeMap::new(),
            skill_points: BTreeMap::new(),
            ability_stats: AbilityStats::default(),
        };
        store.load_profile("beginner", &base).unwrap(); // Legacy repair grants 2 SP.
        let learn = |request: &str, skill| {
            store
                .learn_skill("beginner", request, skill, 0, 0, 3, &BTreeMap::new(), false)
                .unwrap()
        };
        let first = learn("learn-1", 1001);
        assert!(first.success);
        assert_eq!((first.level, first.remaining_sp), (1, 1));
        assert!(learn("learn-1", 1001).already_resolved);
        assert_eq!(learn("learn-1", 1002).code, "request_conflict");
        assert!(learn("learn-2", 1002).success);
        assert_eq!(learn("learn-3", 1000).code, "not_enough_sp");
        assert_eq!(
            store.load_profile("beginner", &base).unwrap().skill_points[&0],
            0
        );
        assert!(
            !store
                .learn_skill(
                    "beginner",
                    "fake-book",
                    1000,
                    200,
                    200,
                    3,
                    &BTreeMap::new(),
                    false
                )
                .unwrap()
                .success
        );
        assert!(
            !store
                .learn_skill(
                    "beginner",
                    "fake-id",
                    1003,
                    0,
                    0,
                    3,
                    &BTreeMap::new(),
                    false
                )
                .unwrap()
                .success
        );
        assert!(
            !store
                .learn_skill(
                    "beginner",
                    "fake-free",
                    1000,
                    0,
                    0,
                    3,
                    &BTreeMap::new(),
                    true
                )
                .unwrap()
                .success
        );
        let cast = store
            .cast_skill_with_cooldown("beginner", "heal", 1001, 0, 0, 3, 5, 120_000)
            .unwrap();
        assert!(cast.success);
        assert_eq!(cast.mp, 25);
        assert!(
            store
                .cast_skill_with_cooldown("beginner", "heal", 1001, 0, 0, 3, 5, 120_000)
                .unwrap()
                .already_resolved
        );
        assert_eq!(
            store
                .cast_skill_with_cooldown("beginner", "heal-again", 1001, 0, 0, 3, 5, 120_000)
                .unwrap()
                .code,
            "skill_cooldown"
        );
        assert_eq!(store.load_profile("beginner", &base).unwrap().mp, 25);
        // Raise the character to the mage exception boundary before exercising
        // the transfer, without dropping the skills learned above.
        let mut eligible = store.load_profile("beginner", &base).unwrap();
        eligible.level = 8;
        store.save_profile("beginner", &eligible).unwrap();
        assert!(store.advance_job("beginner", 0, 200).unwrap());
        assert!(!store
            .load_profile("beginner", &base)
            .unwrap()
            .skills
            .contains_key(&2001008));
        assert!(
            store
                .cast_skill_with_cooldown("beginner", "speed", 1002, 0, 0, 3, 4, 60_000)
                .unwrap()
                .success
        );
        drop(store);
        let db = Connection::open(&path).unwrap();
        Store::init(&db).unwrap();
        let store = Store {
            db: Arc::new(Mutex::new(db)),
        };
        let saved = store.load_profile("beginner", &base).unwrap();
        assert_eq!(saved.skills[&1001], 1);
        assert_eq!(saved.skill_points[&0], 0);
        assert_eq!(saved.skill_points[&200], 5);
        assert!(store.skill_cooldown_remaining_ms("beginner", 1001).unwrap() > 0);
        assert_eq!(
            store
                .cast_skill_with_cooldown("beginner", "heal-reconnect", 1001, 0, 0, 3, 5, 120_000)
                .unwrap()
                .code,
            "skill_cooldown"
        );
        drop(store);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    #[test]
    fn beginner_sp_growth_and_legacy_repair_are_idempotent() {
        let path = std::env::temp_dir().join(format!("maple-beginner-sp-{}.sqlite3", random_id()));
        let db = Connection::open(&path).unwrap();
        Store::init(&db).unwrap();
        let store = Store {
            db: Arc::new(Mutex::new(db)),
        };
        let defaults = Profile {
            hp: 50,
            max_hp: 50,
            mp: 5,
            max_mp: 5,
            level: 1,
            job: 0,
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            cash: 0,
            death_id: String::new(),
            map_id: String::new(),
            x: 0.0,
            y: 0.0,
            inventory: Vec::new(),
            skills: BTreeMap::new(),
            skill_points: BTreeMap::new(),
            ability_stats: AbilityStats::default(),
        };
        let mut profile = store.load_profile("old", &defaults).unwrap();
        assert!(profile.skill_points.is_empty());
        profile.level = 2; // Actual old-account failure: already leveled, no SP.
        profile.skill_points.insert(200, 9);
        store.save_profile("old", &profile).unwrap();
        let repaired = store.load_profile("old", &defaults).unwrap();
        assert_eq!(repaired.skill_points, BTreeMap::from([(0, 1), (200, 9)]));
        assert_eq!(
            store.load_profile("old", &defaults).unwrap().skill_points,
            repaired.skill_points
        );
        profile = repaired;
        profile.level = 7;
        profile.skills = BTreeMap::from([(1000, 3), (1001, 1)]);
        store.save_profile("old", &profile).unwrap();
        profile = store.load_profile("old", &defaults).unwrap();
        assert_eq!(profile.skill_points[&0], 2); // 6 earned - 4 spent.
        assert_eq!(profile.skills[&1000], 3);
        profile.skill_points.insert(0, 20); // Never reclaim an existing surplus.
        store.save_profile("old", &profile).unwrap();
        assert_eq!(
            store.load_profile("old", &defaults).unwrap().skill_points[&0],
            20
        );
        drop(store);
        let db = Connection::open(&path).unwrap();
        Store::init(&db).unwrap();
        let store = Store {
            db: Arc::new(Mutex::new(db)),
        };
        assert_eq!(
            store.load_profile("old", &defaults).unwrap().skill_points[&0],
            20
        );
        let mut fresh = defaults.clone();
        add_exp(&mut fresh, 7, &[1; 8]); // Cross levels 2..8: only six beginner SP.
        assert_eq!((fresh.level, fresh.skill_points[&0]), (8, 6));
        add_exp(&mut fresh, 0, &[1; 8]);
        assert_eq!(fresh.skill_points[&0], 6);
        for (job, book) in [(200, 200), (220, 220), (221, 221)] {
            let mut mage = defaults.clone();
            mage.job = job;
            add_exp(&mut mage, 2, &[1; 8]);
            assert_eq!(mage.skill_points, BTreeMap::from([(book, 6)]));
        }
        let mut fourth = defaults.clone();
        fourth.job = FOURTH_JOB;
        add_exp(&mut fourth, 2, &[1; 8]);
        assert!(fourth.skill_points.is_empty());
        drop(store);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    #[test]
    fn mage_level_up_grants_three_book_points_once_across_reward_replay() {
        let runtime: serde_json::Value =
            serde_json::from_str(include_str!("../../shared/gameplay.json")).unwrap();
        let exp_table: Vec<u64> = serde_json::from_value(runtime["expTable"].clone()).unwrap();
        assert_eq!(exp_table.first(), Some(&15));
        let db = Connection::open_in_memory().unwrap();
        Store::init(&db).unwrap();
        let store = Store {
            db: Arc::new(Mutex::new(db)),
        };
        let defaults = Profile {
            hp: 50,
            max_hp: 50,
            mp: 100,
            max_mp: 100,
            level: 1,
            job: 200,
            exp: 0,
            exp_to_next: 10,
            mesos: 0,
            cash: 0,
            death_id: String::new(),
            map_id: String::new(),
            x: 0.0,
            y: 0.0,
            inventory: Vec::new(),
            skills: BTreeMap::new(),
            skill_points: BTreeMap::from([(MAGE_BOOK, 5)]),
            ability_stats: AbilityStats::default(),
        };
        store.load_profile("mage", &defaults).unwrap();
        store.save_profile("mage", &defaults).unwrap();
        store
            .claim_attack("mage", "map", "mage-level", "mage-level-action", "skill")
            .unwrap();
        let settled = store
            .resolve_attack(
                "mage",
                "map",
                "mage-level",
                Some("mob-level"),
                1,
                true,
                80,
                1,
                &[],
                &exp_table,
                &["mage".to_owned()],
            )
            .unwrap();
        assert_eq!(settled.profiles.len(), 1);
        let after_level = store.load_profile("mage", &defaults).unwrap();
        assert_eq!(after_level.level, 3);
        assert_eq!(after_level.exp, 5);
        assert_eq!(after_level.ability_stats.available_ap, 10);
        assert_eq!(after_level.skill_points.get(&MAGE_BOOK), Some(&11));

        let replay = store
            .resolve_attack(
                "mage",
                "map",
                "mage-level",
                Some("mob-level"),
                999,
                true,
                999,
                999,
                &[],
                &[1, 1, 1],
                &["mage".to_owned()],
            )
            .unwrap();
        assert!(replay.already_resolved);
        let after_replay = store.load_profile("mage", &defaults).unwrap();
        assert_eq!(after_replay.level, 3);
        assert_eq!(after_replay.ability_stats.available_ap, 10);
        assert_eq!(after_replay.skill_points.get(&MAGE_BOOK), Some(&11));
        let first = store
            .allocate_ap("mage", "ap-int", AbilityStat::Intelligence)
            .unwrap();
        assert!(first.success);
        assert_eq!((first.stats.intelligence, first.stats.available_ap), (5, 9));
        let second = store
            .allocate_ap("mage", "ap-luk", AbilityStat::Luck)
            .unwrap();
        assert!(second.success);
        let repeated = store
            .allocate_ap("mage", "ap-int", AbilityStat::Intelligence)
            .unwrap();
        assert!(repeated.success && repeated.already_resolved);
        let conflict = store
            .allocate_ap("mage", "ap-int", AbilityStat::Strength)
            .unwrap();
        assert!(!conflict.success);
        assert_eq!(conflict.code, "request_conflict");
        let current = store.load_profile("mage", &defaults).unwrap();
        assert_eq!(
            (
                current.ability_stats.intelligence,
                current.ability_stats.luck,
                current.ability_stats.available_ap
            ),
            (5, 5, 8)
        );
        store.load_profile("other", &defaults).unwrap();
        assert!(
            !store
                .allocate_ap("other", "ap-int", AbilityStat::Intelligence)
                .unwrap()
                .success
        );
        let mut empty = current.clone();
        empty.ability_stats.available_ap = 0;
        store.save_profile("mage", &empty).unwrap();
        assert!(
            !store
                .allocate_ap("mage", "ap-empty", AbilityStat::Strength)
                .unwrap()
                .success
        );
        assert_eq!(
            store.load_profile("mage", &defaults).unwrap().ability_stats,
            empty.ability_stats
        );
    }

    #[test]
    fn reward_pickup_and_mesos_survive_replay_concurrency_and_restart() {
        let path = std::env::temp_dir().join(format!("maple-reward-{}.sqlite3", random_id()));
        let auth = start(&path).unwrap();
        let store = auth.store.clone();
        let defaults = Profile {
            hp: 50,
            max_hp: 50,
            mp: 5,
            max_mp: 5,
            level: 1,
            job: 0,
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            cash: 0,
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
        store.load_profile("b", &defaults).unwrap();
        store
            .claim_attack("a", "map", "attack-1", "action-1", "started")
            .unwrap();
        let drops = vec![
            DropRecord {
                id: "drop-item".into(),
                item_id: "4000019".into(),
                quantity: 1,
                x: 0.0,
                y: 0.0,
                owner_id: None,
                protected_until_ms: 0,
                ..DropRecord::default()
            },
            DropRecord {
                id: "drop-meso".into(),
                item_id: "0".into(),
                quantity: 5,
                x: 0.0,
                y: 0.0,
                owner_id: None,
                protected_until_ms: 0,
                ..DropRecord::default()
            },
        ];
        let resolve_started_ms = now_ms();
        let resolved = store
            .resolve_attack(
                "a",
                "map",
                "attack-1",
                Some("monster-1"),
                8,
                true,
                3,
                8,
                &drops,
                &[15],
                &["a".to_owned()],
            )
            .unwrap();
        assert_eq!(resolved.drops.len(), 2);
        assert_eq!(resolved.profile.as_ref().map(|p| p.exp), Some(3));
        let protected_until_ms = resolved.drops[0].protected_until_ms;
        assert!(protected_until_ms >= resolve_started_ms.saturating_add(DROP_PROTECTION_MS));
        assert!(protected_until_ms <= now_ms().saturating_add(DROP_PROTECTION_MS));
        let replay = store
            .resolve_attack(
                "a",
                "map",
                "attack-1",
                Some("monster-1"),
                8,
                true,
                3,
                8,
                &[],
                &[15],
                &["a".to_owned()],
            )
            .unwrap();
        assert!(replay.already_resolved);
        assert_eq!(replay.drops.len(), 2);

        let store_a = store.clone();
        let store_b = store.clone();
        let (pickup_a, pickup_b) = std::thread::scope(|scope| {
            let a = scope.spawn(move || store_a.pickup("a", "map", "pickup-a", "drop-meso"));
            let b = scope.spawn(move || store_b.pickup("b", "map", "pickup-b", "drop-meso"));
            (a.join().unwrap(), b.join().unwrap())
        });
        let pickup_a = pickup_a.unwrap();
        let pickup_b = pickup_b.unwrap();
        assert_ne!(pickup_a.success, pickup_b.success);
        let mesos_owner = if pickup_a.success { "a" } else { "b" };
        let item_pickup = store
            .pickup("a", "map", "pickup-item", "drop-item")
            .unwrap();
        assert!(item_pickup.success);
        let replay_pickup = store
            .pickup("a", "map", "pickup-item", "drop-item")
            .unwrap();
        assert_eq!(replay_pickup.success, item_pickup.success);
        let profile = store.load_profile("a", &defaults).unwrap();
        assert_eq!(profile.mesos, if mesos_owner == "a" { 5 } else { 0 });
        assert_eq!(
            profile.inventory,
            vec![InventoryItem {
                slot: 1,
                item_id: "4000019".into(),
                quantity: 1,
                ..InventoryItem::default()
            }]
        );
        let other_profile = store
            .load_profile(if mesos_owner == "a" { "b" } else { "a" }, &defaults)
            .unwrap();
        assert_eq!(other_profile.mesos, if mesos_owner == "b" { 5 } else { 0 });
        drop(store);
        drop(auth);
        std::thread::sleep(Duration::from_millis(20));
        let auth = start(&path).unwrap();
        let profile = auth.store.load_profile("a", &defaults).unwrap();
        assert_eq!(profile.mesos, if mesos_owner == "a" { 5 } else { 0 });
        assert_eq!(
            profile.inventory,
            vec![InventoryItem {
                slot: 1,
                item_id: "4000019".into(),
                quantity: 1,
                ..InventoryItem::default()
            }]
        );
        drop(auth);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    #[test]
    fn legacy_snapshot_drops_migrate_as_expired_and_can_be_picked_up() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE drops (
                id TEXT PRIMARY KEY, map_id TEXT NOT NULL, item_id TEXT NOT NULL,
                quantity INTEGER NOT NULL, x REAL NOT NULL, y REAL NOT NULL,
                owner_account_id TEXT, active INTEGER NOT NULL DEFAULT 1
             );
             INSERT INTO drops VALUES ('legacy','map','0',5,0,0,'old-owner',1);",
        )
        .unwrap();
        Store::init(&db).unwrap();
        Store::init(&db).unwrap();
        let store = Store {
            db: Arc::new(Mutex::new(db)),
        };
        let drops = store.load_drops("map").unwrap();
        assert_eq!(drops.len(), 1);
        assert_eq!(drops[0].owner_id.as_deref(), Some("old-owner"));
        assert_eq!(drops[0].protected_until_ms, 0);
        let defaults = Profile {
            hp: 50,
            max_hp: 50,
            mp: 5,
            max_mp: 5,
            level: 1,
            job: 0,
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            cash: 0,
            death_id: String::new(),
            map_id: String::new(),
            x: 0.0,
            y: 0.0,
            inventory: Vec::new(),
            skills: BTreeMap::new(),
            skill_points: BTreeMap::new(),
            ability_stats: AbilityStats::default(),
        };
        store.load_profile("other", &defaults).unwrap();
        assert!(
            store
                .pickup("other", "map", "legacy-pickup", "legacy")
                .unwrap()
                .success
        );
        assert!(
            store
                .pickup("other", "map", "legacy-pickup", "legacy")
                .unwrap()
                .success
        );
        assert_eq!(store.load_profile("other", &defaults).unwrap().mesos, 5);
        assert!(store.load_drops("map").unwrap().is_empty());
    }

    #[test]
    fn pickup_protection_expires_at_deadline_and_inventory_drop_is_immediate() {
        let path =
            std::env::temp_dir().join(format!("maple-pickup-protection-{}.sqlite3", random_id()));
        let auth = start(&path).unwrap();
        let store = auth.store.clone();
        let defaults = Profile {
            hp: 50,
            max_hp: 50,
            mp: 5,
            max_mp: 5,
            level: 1,
            job: 0,
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            cash: 0,
            death_id: String::new(),
            map_id: String::new(),
            x: 0.0,
            y: 0.0,
            inventory: Vec::new(),
            skills: BTreeMap::new(),
            skill_points: BTreeMap::new(),
            ability_stats: AbilityStats::default(),
        };
        store.load_profile("owner", &defaults).unwrap();
        store.load_profile("other", &defaults).unwrap();
        let protected_until_ms = now_ms().saturating_add(DROP_PROTECTION_MS);
        {
            let db = store.db.lock().unwrap();
            db.execute(
                "INSERT INTO drops(id,map_id,item_id,quantity,x,y,owner_account_id,protected_until_ms,active)
                 VALUES ('monster-drop','map','4000019',1,0,0,'owner',?1,1)",
                [protected_until_ms],
            )
            .unwrap();
            db.execute(
                "INSERT INTO drops(id,map_id,item_id,quantity,x,y,owner_account_id,protected_until_ms,active)
                 VALUES ('persisted-drop','map','2000000',1,0,0,'owner',?1,1)",
                [protected_until_ms],
            )
            .unwrap();
        }
        drop(store);
        drop(auth);
        std::thread::sleep(Duration::from_millis(20));
        let auth = start(&path).unwrap();
        let store = auth.store.clone();
        let persisted = store.load_drop("map", "persisted-drop").unwrap().unwrap();
        assert_eq!(persisted.protected_until_ms, protected_until_ms);
        assert_eq!(
            store
                .load_drops("map")
                .unwrap()
                .into_iter()
                .find(|drop| drop.id == "persisted-drop")
                .unwrap()
                .protected_until_ms,
            protected_until_ms
        );
        let protected = store
            .pickup("other", "map", "pickup-before-expiry", "monster-drop")
            .unwrap();
        assert!(!protected.success);
        assert_eq!(protected.code, "drop_owned");

        {
            let db = store.db.lock().unwrap();
            db.execute(
                "UPDATE drops SET protected_until_ms=?2 WHERE id=?1",
                params!["monster-drop", now_ms()],
            )
            .unwrap();
        }
        let expired = store
            .pickup("other", "map", "pickup-at-expiry", "monster-drop")
            .unwrap();
        assert!(expired.success);

        {
            let db = store.db.lock().unwrap();
            db.execute(
                "INSERT INTO inventory(account_id,slot,item_id,quantity) VALUES ('owner',1,'2000000',1)",
                [],
            )
            .unwrap();
        }
        let dropped = store
            .drop_inventory("owner", "map", "inventory-drop", 2, 1, 1, 0.0, 0.0)
            .unwrap();
        assert!(dropped.success);
        let drop_id = dropped.drop_id.as_deref().unwrap();
        let persisted = store.load_drop("map", drop_id).unwrap().unwrap();
        assert_eq!(persisted.owner_id, None);
        assert_eq!(persisted.protected_until_ms, 0);
        assert!(
            store
                .pickup("other", "map", "pickup-inventory-drop", drop_id)
                .unwrap()
                .success
        );

        drop(auth);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    #[test]
    fn inventory_move_drop_is_atomic_idempotent_and_survives_restart() {
        let path = std::env::temp_dir().join(format!("maple-inventory-{}.sqlite3", random_id()));
        let auth = start(&path).unwrap();
        let store = auth.store.clone();
        let defaults = Profile {
            hp: 50,
            max_hp: 50,
            mp: 5,
            max_mp: 5,
            level: 1,
            job: 0,
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            cash: 0,
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
        {
            let db = store.db.lock().unwrap();
            db.execute(
                "INSERT INTO inventory(account_id,slot,item_id,quantity) VALUES ('a',1,'4000019',3)",
                [],
            )
            .unwrap();
            db.execute(
                "INSERT INTO inventory(account_id,slot,item_id,quantity) VALUES ('a',3,'2000000',1)",
                [],
            )
            .unwrap();
        }

        let moved = store
            .move_inventory("a", "move-1", 4, 1, 2, 3, EquipmentStats::default())
            .unwrap();
        assert!(moved.success);
        assert_eq!(moved.from_slot, 1);
        assert_eq!(moved.to_slot, Some(2));
        assert_eq!(
            store
                .move_inventory("a", "move-1", 4, 1, 2, 3, EquipmentStats::default())
                .unwrap()
                .drop_id,
            None
        );
        let profile = store.load_profile("a", &defaults).unwrap();
        assert_eq!(
            profile.inventory,
            vec![
                InventoryItem {
                    slot: 3,
                    item_id: "2000000".into(),
                    quantity: 1,
                    ..InventoryItem::default()
                },
                InventoryItem {
                    slot: 2,
                    item_id: "4000019".into(),
                    quantity: 3,
                    ..InventoryItem::default()
                },
            ]
        );

        let first_drop = store
            .drop_inventory("a", "map", "drop-1", 4, 2, 1, 10.0, 20.0)
            .unwrap();
        assert!(first_drop.success);
        let replay = store
            .drop_inventory("a", "map", "drop-1", 4, 2, 1, 999.0, 999.0)
            .unwrap();
        assert_eq!(replay.drop_id, first_drop.drop_id);
        assert_eq!(replay.quantity, first_drop.quantity);
        let active = store
            .load_drop("map", first_drop.drop_id.as_deref().unwrap())
            .unwrap();
        assert_eq!(active.as_ref().map(|drop| drop.quantity), Some(1));
        assert_eq!(active.as_ref().map(|drop| drop.x), Some(10.0));
        let profile = store.load_profile("a", &defaults).unwrap();
        assert_eq!(
            profile
                .inventory
                .iter()
                .find(|item| item.item_id == "4000019")
                .map(|item| item.quantity),
            Some(2)
        );

        drop(store);
        drop(auth);
        std::thread::sleep(Duration::from_millis(20));
        let auth = start(&path).unwrap();
        let profile = auth.store.load_profile("a", &defaults).unwrap();
        let stack = profile
            .inventory
            .iter()
            .find(|item| item.item_id == "4000019")
            .unwrap();
        assert_eq!(stack.slot, 2);
        assert_eq!(stack.quantity, 2);
        assert!(auth
            .store
            .load_drop("map", first_drop.drop_id.as_deref().unwrap())
            .unwrap()
            .is_some());
        drop(auth);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    #[test]
    fn revive_is_bound_to_death_id_and_survives_replay() {
        let path = std::env::temp_dir().join(format!("maple-revive-{}.sqlite3", random_id()));
        let auth = start(&path).unwrap();
        let store = auth.store.clone();
        let defaults = Profile {
            hp: 50,
            max_hp: 50,
            mp: 5,
            max_mp: 5,
            level: 1,
            job: 0,
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            cash: 0,
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
        let mut dead = defaults.clone();
        dead.hp = 0;
        dead.death_id = "death-1".into();
        store.save_profile("a", &dead).unwrap();

        let revived = store.revive("a", "revive-1", "death-1").unwrap();
        assert!(revived.success);
        assert_eq!(
            store.revive("a", "revive-1", "death-1").unwrap().success,
            true
        );
        let profile = store.load_profile("a", &defaults).unwrap();
        assert_eq!(profile.hp, 50);
        assert!(profile.death_id.is_empty());
        assert_eq!(profile.mp, 5);

        let mut second_death = profile;
        second_death.hp = 0;
        second_death.death_id = "death-2".into();
        store.save_profile("a", &second_death).unwrap();
        let stale = store.revive("a", "revive-2", "death-1").unwrap();
        assert!(!stale.success);
        assert_eq!(stale.code, "revive_stale");
        drop(auth);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    #[test]
    fn kill_rewards_split_exp_by_damage_and_drop_goes_to_top_contributor() {
        let path = std::env::temp_dir().join(format!("maple-exp-split-{}.sqlite3", random_id()));
        let auth = start(&path).unwrap();
        let store = auth.store.clone();
        let defaults = Profile {
            hp: 50,
            max_hp: 50,
            mp: 5,
            max_mp: 5,
            level: 1,
            job: 0,
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            cash: 0,
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
        store.load_profile("b", &defaults).unwrap();
        let active = vec!["a".to_owned(), "b".to_owned()];
        store
            .claim_attack("a", "map", "attack-a", "action-a", "started")
            .unwrap();
        store
            .resolve_attack(
                "a",
                "map",
                "attack-a",
                Some("monster-1"),
                3,
                false,
                3,
                8,
                &[],
                &[15],
                &active,
            )
            .unwrap();
        store
            .claim_attack("b", "map", "attack-b", "action-b", "started")
            .unwrap();
        let drops = vec![DropRecord {
            id: "drop-1".into(),
            item_id: "4000019".into(),
            quantity: 1,
            x: 1.0,
            y: 2.0,
            owner_id: Some("b".into()),
            protected_until_ms: 0,
            ..DropRecord::default()
        }];
        let resolved = store
            .resolve_attack(
                "b",
                "map",
                "attack-b",
                Some("monster-1"),
                5,
                true,
                3,
                8,
                &drops,
                &[15],
                &active,
            )
            .unwrap();
        assert_eq!(resolved.profiles.len(), 2);
        assert_eq!(store.load_profile("a", &defaults).unwrap().exp, 1);
        assert_eq!(store.load_profile("b", &defaults).unwrap().exp, 2);
        assert_eq!(resolved.drops[0].owner_id.as_deref(), Some("b"));
        drop(auth);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    #[test]
    fn creation_longcoat_1051353_round_trips_through_login_normalization() {
        let path =
            std::env::temp_dir().join(format!("maple-creation-equip-{}.sqlite3", random_id()));
        let defaults = Profile {
            hp: 50,
            max_hp: 50,
            mp: 5,
            max_mp: 5,
            level: 1,
            job: 0,
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            cash: 0,
            death_id: String::new(),
            map_id: String::new(),
            x: 0.0,
            y: 0.0,
            inventory: Vec::new(),
            skills: BTreeMap::new(),
            skill_points: BTreeMap::new(),
            ability_stats: AbilityStats::default(),
        };
        let auth = start(&path).unwrap();
        auth.store.load_profile("creation", &defaults).unwrap();
        let stats = BTreeMap::from([
            (String::from("incPDD"), 17_i64),
            (String::from("incINT"), 4),
        ]);
        let expected = InventoryItem {
            slot: 5,
            item_id: "1051353".into(),
            quantity: 1,
            stats: Some(stats),
            remaining_slots: Some(3),
            upgrade_count: Some(5),
        };
        {
            let mut db = auth.store.db.lock().unwrap();
            let tx = db.transaction().unwrap();
            write_equipped_tx(&tx, "creation", &[expected.clone()]).unwrap();
            tx.commit().unwrap();
        }
        // TMS273 `Character/Longcoat/01051353.json` authors `islot=MaPn`;
        // login normalization must resolve that to the persisted -5 slot.
        assert_eq!(
            auth.store.load_profile("creation", &defaults).unwrap().job,
            0
        );
        assert_eq!(
            auth.store.load_equipped("creation").unwrap(),
            vec![expected.clone()]
        );
        {
            let mut db = auth.store.db.lock().unwrap();
            let tx = db.transaction().unwrap();
            tx.execute(
                "UPDATE equipped SET slot=-6 WHERE account_id='creation' AND item_id='1051353'",
                [],
            )
            .unwrap();
            let error = normalize_equipped_tx(&tx).unwrap_err();
            assert!(error.contains("equipment slot mismatch"));
            tx.rollback().unwrap();
        }
        assert_eq!(
            auth.store.load_equipped("creation").unwrap(),
            vec![expected.clone()]
        );
        drop(auth);
        let auth = start(&path).unwrap();
        assert_eq!(
            auth.store.load_profile("creation", &defaults).unwrap().job,
            0
        );
        assert_eq!(
            auth.store.load_equipped("creation").unwrap(),
            vec![expected]
        );
        drop(auth);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    #[test]
    fn use_item_consumes_one_potion_cards_enter_book_and_scrolls_are_atomic() {
        let path =
            std::env::temp_dir().join(format!("maple-inventory-use-{}.sqlite3", random_id()));
        let auth = start(&path).unwrap();
        let store = auth.store.clone();
        let defaults = Profile {
            hp: 1,
            max_hp: 100,
            mp: 1,
            max_mp: 100,
            level: 5,
            job: 0,
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            cash: 0,
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
        store.load_profile("b", &defaults).unwrap();
        {
            let db = store.db.lock().unwrap();
            db.execute(
                "INSERT INTO inventory(account_id,slot,item_id,quantity) VALUES ('a',1,'2000000',100)",
                [],
            )
            .unwrap();
            db.execute(
                "INSERT INTO inventory(account_id,slot,item_id,quantity) VALUES ('a',2,'2041006',2)",
                [],
            )
            .unwrap();
            db.execute(
                "INSERT INTO equipped(account_id,slot,item_id,quantity,stats_json,upgrade_count,remaining_slots)
                 VALUES ('a',-9,'1102173',1,?1,0,6)",
                [serde_json::to_string(&inventory::equipment_attributes("1102173")).unwrap()],
            )
            .unwrap();
            db.execute(
                "INSERT INTO drops(id,map_id,item_id,quantity,x,y,active)
                 VALUES ('card-drop','map','2380000',5,0,0,1)",
                [],
            )
            .unwrap();
        }

        let potion = store
            .use_item(
                "a",
                "use-potion",
                2,
                1,
                "2000000",
                None,
                None,
                EquipmentStats::default(),
            )
            .unwrap();
        assert!(potion.success);
        let potion_stack = store
            .load_profile("a", &defaults)
            .unwrap()
            .inventory
            .into_iter()
            .find(|item| item.item_id == "2000000")
            .unwrap();
        assert_eq!(potion_stack.quantity, 99);

        let wrong_target = store
            .use_item(
                "a",
                "scroll-wrong-target",
                2,
                2,
                "2041006",
                Some(-9),
                Some("1040002"),
                EquipmentStats::default(),
            )
            .unwrap();
        assert!(!wrong_target.success);
        assert_eq!(wrong_target.code, "requirements_not_met");
        assert_eq!(wrong_target.quantity, 1);
        let scroll_stack = store
            .load_profile("a", &defaults)
            .unwrap()
            .inventory
            .into_iter()
            .find(|item| item.item_id == "2041006")
            .unwrap();
        assert_eq!(scroll_stack.quantity, 2);

        let valid_scroll = store
            .use_item(
                "a",
                "scroll-valid-target",
                2,
                2,
                "2041006",
                Some(-9),
                Some("1102173"),
                EquipmentStats::default(),
            )
            .unwrap();
        assert!(valid_scroll.success);
        assert!(matches!(
            valid_scroll.code.as_str(),
            "scroll_success" | "scroll_failed"
        ));
        let equipped = store.load_equipped("a").unwrap();
        let helmet = equipped
            .iter()
            .find(|item| item.item_id == "1102173")
            .unwrap();
        assert_eq!(helmet.remaining_slots, Some(5));
        let helmet_stats = helmet.stats.as_ref().unwrap();
        assert_eq!(helmet_stats.get("incMHP"), Some(&20));

        let card = store
            .pickup("a", "map", "pickup-card", "card-drop")
            .unwrap();
        assert!(card.success);
        assert!(store
            .load_profile("a", &defaults)
            .unwrap()
            .inventory
            .iter()
            .all(|item| item.item_id != "2380000"));
        assert_eq!(
            store.load_monster_book("a").unwrap().get("2380000"),
            Some(&5)
        );
        {
            let db = store.db.lock().unwrap();
            db.execute(
                "INSERT INTO drops(id,map_id,item_id,quantity,x,y,active)
                 VALUES ('card-over-cap','map','2380000',1,0,0,1)",
                [],
            )
            .unwrap();
        }
        let over_cap = store
            .pickup("a", "map", "pickup-card-over-cap", "card-over-cap")
            .unwrap();
        assert!(over_cap.success);
        assert_eq!(over_cap.code, "");
        assert_eq!(
            store.load_monster_book("a").unwrap().get("2380000"),
            Some(&5)
        );

        drop(auth);
        std::thread::sleep(Duration::from_millis(20));
        let auth = start(&path).unwrap();
        let persisted = auth.store.load_equipped("a").unwrap();
        let helmet = persisted
            .iter()
            .find(|item| item.item_id == "1102173")
            .unwrap();
        assert_eq!(helmet.remaining_slots, Some(5));
        drop(auth);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    #[test]
    fn strengthened_equipment_drop_and_pickup_preserves_instance_metadata() {
        let path =
            std::env::temp_dir().join(format!("maple-equipment-drop-{}.sqlite3", random_id()));
        let auth = start(&path).unwrap();
        let store = auth.store.clone();
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
            cash: 0,
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
        store.load_profile("b", &defaults).unwrap();
        let stats = BTreeMap::from([(String::from("incPDD"), 12_i64)]);
        {
            let db = store.db.lock().unwrap();
            db.execute(
                "INSERT INTO inventory(account_id,inventory_type,slot,item_id,quantity,stats_json,upgrade_count,remaining_slots)
                 VALUES ('a',1,1,'1002067',1,?1,1,6)",
                [serde_json::to_string(&stats).unwrap()],
            )
            .unwrap();
        }
        let dropped = store
            .drop_inventory("a", "map", "drop-strengthened", 1, 1, 1, 1.0, 2.0)
            .unwrap();
        assert!(dropped.success);
        let drop_record = store
            .load_drop("map", dropped.drop_id.as_deref().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(drop_record.stats, Some(stats.clone()));
        assert_eq!(drop_record.upgrade_count, Some(1));
        assert_eq!(drop_record.remaining_slots, Some(6));
        assert!(
            store
                .pickup("b", "map", "pickup-strengthened", &drop_record.id)
                .unwrap()
                .success
        );
        let picked = store
            .load_profile("b", &defaults)
            .unwrap()
            .inventory
            .into_iter()
            .find(|item| item.item_id == "1002067")
            .unwrap();
        assert_eq!(picked.stats, Some(stats));
        assert_eq!(picked.upgrade_count, Some(1));
        assert_eq!(picked.remaining_slots, Some(6));
        drop(auth);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    #[test]
    fn current_schema_overflow_stack_splits_without_primary_key_collision() {
        let path = std::env::temp_dir().join(format!(
            "maple-current-schema-overflow-{}.sqlite3",
            random_id()
        ));
        let auth = start(&path).unwrap();
        let store = auth.store.clone();
        let defaults = Profile {
            hp: 50,
            max_hp: 50,
            mp: 5,
            max_mp: 5,
            level: 1,
            job: 0,
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            cash: 0,
            death_id: String::new(),
            map_id: String::new(),
            x: 0.0,
            y: 0.0,
            inventory: Vec::new(),
            skills: BTreeMap::new(),
            skill_points: BTreeMap::new(),
            ability_stats: AbilityStats::default(),
        };
        store.load_profile("overflow", &defaults).unwrap();
        {
            let db = store.db.lock().unwrap();
            db.execute(
                "INSERT INTO inventory(account_id,inventory_type,slot,item_id,quantity)
                 VALUES ('overflow',4,1,'4000019',201)",
                [],
            )
            .unwrap();
        }
        let profile = store.load_profile("overflow", &defaults).unwrap();
        let stacks: Vec<_> = profile
            .inventory
            .into_iter()
            .filter(|item| item.item_id == "4000019")
            .collect();
        assert_eq!(stacks.iter().map(|item| item.quantity).sum::<u32>(), 201);
        assert_eq!(
            stacks.iter().map(|item| item.slot).collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(stacks[0].quantity, 200);
        assert_eq!(stacks[1].quantity, 1);
        drop(auth);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    #[test]
    fn intermediate_inventory_type_schema_migrates_to_category_local_primary_key() {
        let path = std::env::temp_dir().join(format!(
            "maple-intermediate-inventory-{}.sqlite3",
            random_id()
        ));
        {
            let db = rusqlite::Connection::open(&path).unwrap();
            db.execute_batch(
                "CREATE TABLE inventory(
                   account_id TEXT NOT NULL,
                   inventory_type INTEGER NOT NULL,
                   slot INTEGER NOT NULL,
                   item_id TEXT NOT NULL,
                   quantity INTEGER NOT NULL,
                   PRIMARY KEY(account_id,slot)
                 );
                 INSERT INTO inventory(account_id,inventory_type,slot,item_id,quantity)
                 VALUES ('legacy',4,1,'4000019',1),('legacy',2,2,'2000000',3);",
            )
            .unwrap();
            Store::init(&db).unwrap();
            let rows: Vec<(u8, u16, String, u32)> = db
                .prepare(
                    "SELECT inventory_type,slot,item_id,quantity FROM inventory
                     ORDER BY inventory_type,slot",
                )
                .unwrap()
                .query_map([], |row| {
                    Ok((
                        row.get::<_, i64>(0)?.try_into().unwrap_or(0),
                        row.get::<_, i64>(1)?.try_into().unwrap_or(0),
                        row.get(2)?,
                        row.get::<_, i64>(3)?.try_into().unwrap_or(0),
                    ))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            assert_eq!(
                rows,
                vec![
                    (2, 2, "2000000".to_owned(), 3),
                    (4, 1, "4000019".to_owned(), 1),
                ]
            );
            let mut primary_key: Vec<(i64, String)> = db
                .prepare("PRAGMA table_info(inventory)")
                .unwrap()
                .query_map([], |row| {
                    Ok((row.get::<_, i64>(5)?, row.get::<_, String>(1)?))
                })
                .unwrap()
                .filter_map(Result::ok)
                .filter(|(position, _)| *position > 0)
                .collect();
            primary_key.sort_by_key(|(position, _)| *position);
            let primary_key: Vec<String> = primary_key.into_iter().map(|(_, name)| name).collect();
            assert_eq!(
                primary_key,
                vec![
                    "account_id".to_owned(),
                    "inventory_type".to_owned(),
                    "slot".to_owned()
                ]
            );
        }
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    #[test]
    fn overall_swap_is_atomic_and_replay_safe_after_reopen() {
        let path = std::env::temp_dir().join(format!("maple-overall-{}.sqlite3", random_id()));
        let auth = start(&path).unwrap();
        let store = auth.store.clone();
        let defaults = Profile {
            hp: 50,
            max_hp: 50,
            mp: 5,
            max_mp: 5,
            level: 10,
            job: 500,
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            cash: 0,
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
        let item = |slot, id: &str| {
            let mut item = InventoryItem {
                slot,
                item_id: id.into(),
                quantity: 1,
                ..InventoryItem::default()
            };
            inventory::ensure_equipment_instance(&mut item);
            item
        };
        let mut full: Vec<_> = (1..=SLOT_LIMIT).map(|slot| item(slot, "1002067")).collect();
        full[0] = item(1, "1052095");
        full[0].stats = Some(BTreeMap::from([("incPDD".into(), 27)]));
        full[0].upgrade_count = Some(2);
        full[0].remaining_slots = Some(9);
        let original_equipped = vec![item(5, "1040002"), item(6, "1060002")];
        {
            let mut db = store.db.lock().unwrap();
            let tx = db.transaction().unwrap();
            write_inventory_tx(&tx, "a", &full).unwrap();
            write_equipped_tx(&tx, "a", &original_equipped).unwrap();
            tx.commit().unwrap();
        }
        let original_equipped = store.load_equipped("a").unwrap();
        let stats = EquipmentStats {
            level: 10,
            job: 500,
            ..EquipmentStats::default()
        };
        let blocked = store
            .use_item("a", "full", 1, 1, "1052095", None, None, stats)
            .unwrap();
        assert!(!blocked.success);
        assert_eq!(blocked.code, "inventory_full");
        assert_eq!(store.load_profile("a", &defaults).unwrap().inventory, full);
        assert_eq!(store.load_equipped("a").unwrap(), original_equipped);
        // One extra free slot is enough: the source slot holds the other displaced item.
        {
            let mut db = store.db.lock().unwrap();
            let tx = db.transaction().unwrap();
            write_inventory_tx(&tx, "a", &full[..full.len() - 1]).unwrap();
            tx.commit().unwrap();
        }
        let applied = store
            .use_item("a", "equip", 1, 1, "1052095", None, None, stats)
            .unwrap();
        assert!(applied.success);
        let saved_inventory = store.load_profile("a", &defaults).unwrap().inventory;
        let saved_equipped = store.load_equipped("a").unwrap();
        assert_eq!(saved_inventory.len(), SLOT_LIMIT as usize);
        let mut expected_overall = full[0].clone();
        expected_overall.slot = 5;
        assert_eq!(saved_equipped, vec![expected_overall]);
        drop(store);
        drop(auth);
        let auth = start(&path).unwrap();
        let store = &auth.store;
        assert!(
            store
                .use_item("a", "equip", 1, 1, "1052095", None, None, stats)
                .unwrap()
                .success
        );
        assert_eq!(
            store.load_profile("a", &defaults).unwrap().inventory,
            saved_inventory
        );
        assert_eq!(store.load_equipped("a").unwrap(), saved_equipped);
        let pants_slot = saved_inventory
            .iter()
            .find(|i| i.item_id == "1060002")
            .unwrap()
            .slot as i16;
        // Dragging trousers onto the equipment slot shares the same atomic conflict handling.
        assert!(
            store
                .move_inventory("a", "pants", 1, pants_slot, -6, 1, stats)
                .unwrap()
                .success
        );
        let swapped_inventory = store.load_profile("a", &defaults).unwrap().inventory;
        let swapped_equipped = store.load_equipped("a").unwrap();
        assert_eq!(swapped_equipped, vec![item(6, "1060002")]);
        let mut returned_overall = full[0].clone();
        returned_overall.slot = pants_slot as u16;
        assert!(swapped_inventory.contains(&returned_overall));
        assert!(
            store
                .move_inventory("a", "pants", 1, pants_slot, -6, 1, stats)
                .unwrap()
                .success
        );
        assert_eq!(
            store.load_profile("a", &defaults).unwrap().inventory,
            swapped_inventory
        );
        assert_eq!(store.load_equipped("a").unwrap(), swapped_equipped);
        drop(auth);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    #[test]
    fn starter_equipment_is_seeded_once_and_unequip_does_not_restore_it() {
        let path =
            std::env::temp_dir().join(format!("maple-starter-equipment-{}.sqlite3", random_id()));
        let auth = start(&path).unwrap();
        let store = auth.store.clone();
        let defaults = Profile {
            hp: 50,
            max_hp: 50,
            mp: 5,
            max_mp: 5,
            level: 1,
            job: 0,
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            cash: 0,
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
        assert_eq!(store.load_equipped("a").unwrap().len(), 2);
        let unequipped = store
            .use_item(
                "a",
                "unequip-starter",
                1,
                -11,
                "1302000",
                None,
                None,
                EquipmentStats::default(),
            )
            .unwrap();
        assert!(unequipped.success);
        assert_eq!(store.load_equipped("a").unwrap().len(), 1);
        store.load_profile("a", &defaults).unwrap();
        assert_eq!(store.load_equipped("a").unwrap().len(), 1);
        drop(auth);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    #[test]
    fn starter_backpack_grants_one_slot_expansion_coupon_once() {
        let path =
            std::env::temp_dir().join(format!("maple-starter-coupon-{}.sqlite3", random_id()));
        let auth = start(&path).unwrap();
        let store = auth.store.clone();
        let defaults = Profile {
            hp: 50,
            max_hp: 50,
            mp: 5,
            max_mp: 5,
            level: 1,
            job: 0,
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            cash: 0,
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
        // First init seeds exactly one equip-tab coupon in the use tab.
        let granted = store.seed_starter_backpack("a").unwrap();
        assert_eq!(
            granted.len(),
            1,
            "fresh beginner holds one equip-tab coupon"
        );
        assert_eq!(granted[0].item_id, "2430768");
        assert_eq!(
            granted[0].slot, SLOT_LIMIT,
            "the coupon sits at the end of the use tab"
        );
        assert_eq!(granted[0].quantity, 1);
        // Re-seeding must be a no-op (idempotent).
        let granted = store.seed_starter_backpack("a").unwrap();
        assert!(
            granted.is_empty(),
            "re-seeding must not duplicate the starter coupon",
        );
        // The seeded row is visible through the normal profile read path.
        let profile = store.load_profile("a", &defaults).unwrap();
        assert_eq!(
            profile
                .inventory
                .iter()
                .filter(|item| item.item_id == "2430768")
                .count(),
            1,
            "profile inventory must include the freshly seeded coupon",
        );
        drop(auth);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    #[test]
    fn inventory_slots_above_24_round_trip_after_expansion() {
        let path =
            std::env::temp_dir().join(format!("maple-expanded-slots-{}.sqlite3", random_id()));
        let auth = start(&path).unwrap();
        let store = auth.store.clone();
        let defaults = Profile {
            hp: 50,
            max_hp: 50,
            mp: 5,
            max_mp: 5,
            level: 1,
            job: 0,
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            cash: 0,
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
        // A slot beyond the 24-slot default must survive a write/read round
        // trip: it is the exact regression that made expanded tabs appear to
        // lose items placed past slot 24.
        let expanded = InventoryItem {
            slot: 25,
            item_id: "2000000".into(),
            quantity: 3,
            ..InventoryItem::default()
        };
        {
            let mut db = store.db.lock().unwrap();
            let tx = db.transaction().unwrap();
            write_inventory_tx(&tx, "a", &[expanded.clone()]).unwrap();
            tx.commit().unwrap();
        }
        let read = store.load_profile("a", &defaults).unwrap().inventory;
        assert_eq!(
            read,
            vec![expanded],
            "slot 25 item must round-trip after expansion"
        );
        drop(auth);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    #[test]
    fn pet_instance_and_active_state_survive_store_round_trip() {
        let path =
            std::env::temp_dir().join(format!("maple-pet-persistence-{}.sqlite3", random_id()));
        let auth = start(&path).unwrap();
        let store = auth.store.clone();
        let defaults = Profile {
            hp: 50,
            max_hp: 50,
            mp: 5,
            max_mp: 5,
            level: 1,
            job: 0,
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            cash: 0,
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

        let pet_ids = |items: &[InventoryItem]| {
            let mut ids: Vec<_> = items
                .iter()
                .filter_map(inventory::pet_instance_id)
                .collect();
            ids.sort_unstable();
            ids
        };

        let granted = store
            .grant_inventory_item("a", "pet-grant", "5000000", 1)
            .unwrap();
        assert!(granted.success);
        // Replaying the grant request must return its original outcome without
        // creating a second row.
        let replayed_grant = store
            .grant_inventory_item("a", "pet-grant", "5000000", 1)
            .unwrap();
        assert_eq!(replayed_grant.from_slot, granted.from_slot);
        let before_toggle = store.load_profile("a", &defaults).unwrap().inventory;
        let pet = before_toggle
            .iter()
            .find(|item| item.item_id == "5000000")
            .unwrap();
        let first_pet_id = inventory::pet_instance_id(pet).unwrap();
        assert!(!inventory::pet_active(pet));

        let toggled = store
            .toggle_pet("a", "pet-toggle-1", pet.slot as i16, "5000000")
            .unwrap();
        assert!(toggled.success);
        assert_eq!(toggled.code, "pet_toggled");
        let replayed_toggle = store
            .toggle_pet("a", "pet-toggle-1", pet.slot as i16, "5000000")
            .unwrap();
        assert_eq!(replayed_toggle.success, toggled.success);
        assert_eq!(replayed_toggle.code, toggled.code);

        // Three different rows of the same pet species can be active, while
        // a fourth physical row remains in the bag until one is recalled.
        for index in 2..=3 {
            let request = format!("pet-grant-{index}");
            assert!(
                store
                    .grant_inventory_item("a", &request, "5000000", 1)
                    .unwrap()
                    .success
            );
            let inventory = store.load_profile("a", &defaults).unwrap().inventory;
            let pet = inventory
                .iter()
                .filter(|item| item.item_id == "5000000")
                .nth(index - 1)
                .unwrap();
            let toggled = store
                .toggle_pet(
                    "a",
                    &format!("pet-toggle-{index}"),
                    pet.slot as i16,
                    "5000000",
                )
                .unwrap();
            assert!(toggled.success);
        }
        assert_eq!(
            store
                .load_profile("a", &defaults)
                .unwrap()
                .inventory
                .iter()
                .filter(|item| inventory::pet_active(item))
                .count(),
            3
        );

        assert!(
            store
                .grant_inventory_item("a", "pet-grant-4", "5000000", 1)
                .unwrap()
                .success
        );
        let inventory = store.load_profile("a", &defaults).unwrap().inventory;
        let fourth = inventory
            .iter()
            .filter(|item| item.item_id == "5000000")
            .nth(3)
            .unwrap();
        let limited = store
            .toggle_pet("a", "pet-toggle-4", fourth.slot as i16, "5000000")
            .unwrap();
        assert!(!limited.success);
        assert_eq!(limited.code, "pet_limit");

        // A forged or empty source row must not alter any summon bit.
        let missing = store
            .toggle_pet("a", "pet-missing-source", 24, "5000000")
            .unwrap();
        assert!(!missing.success);
        assert_eq!(missing.code, "source_empty");

        // Moving and gathering the cash tab changes slots but must carry each
        // physical pet id with its row.
        let before_reorder = store.load_profile("a", &defaults).unwrap().inventory;
        let ids_before = pet_ids(&before_reorder);
        let first_slot = before_reorder
            .iter()
            .find(|item| inventory::pet_instance_id(item) == Some(first_pet_id))
            .unwrap()
            .slot as i16;
        assert!(
            store
                .move_inventory(
                    "a",
                    "pet-move",
                    5,
                    first_slot,
                    24,
                    1,
                    EquipmentStats::default(),
                )
                .unwrap()
                .success
        );
        assert!(
            store
                .gather_inventory("a", "pet-gather", 5)
                .unwrap()
                .success
        );
        let after_reorder = store.load_profile("a", &defaults).unwrap().inventory;
        assert_eq!(pet_ids(&after_reorder), ids_before);

        // Ordinary GM grants use the same transaction and are also idempotent.
        let ordinary = store
            .grant_inventory_item("a", "ordinary-grant", "2000000", 3)
            .unwrap();
        assert!(ordinary.success);
        assert!(
            store
                .grant_inventory_item("a", "ordinary-grant", "2000000", 3)
                .unwrap()
                .success
        );
        let changed_quantity = store
            .grant_inventory_item("a", "ordinary-grant", "2000000", 4)
            .unwrap();
        assert!(!changed_quantity.success);
        assert_eq!(changed_quantity.code, "request_reused");
        let changed_item = store
            .grant_inventory_item("a", "ordinary-grant", "2000001", 3)
            .unwrap();
        assert!(!changed_item.success);
        assert_eq!(changed_item.code, "request_reused");
        let refused = store
            .grant_inventory_item("a", "ordinary-refused", "2000000", 0)
            .unwrap();
        assert!(!refused.success);
        assert_eq!(refused.code, "invalid_quantity");
        let refused_replay = store
            .grant_inventory_item("a", "ordinary-refused", "2000000", 0)
            .unwrap();
        assert!(!refused_replay.success);
        assert_eq!(refused_replay.code, "invalid_quantity");
        let refused_changed = store
            .grant_inventory_item("a", "ordinary-refused", "2000001", 0)
            .unwrap();
        assert!(!refused_changed.success);
        assert_eq!(refused_changed.code, "request_reused");
        let unknown = store
            .grant_inventory_item("a", "ordinary-unknown", "not-an-item", 2)
            .unwrap();
        assert!(!unknown.success);
        assert_eq!(unknown.code, "unknown_item");
        let unknown_replay = store
            .grant_inventory_item("a", "ordinary-unknown", "not-an-item", 2)
            .unwrap();
        assert!(!unknown_replay.success);
        assert_eq!(unknown_replay.code, "unknown_item");
        let unknown_changed = store
            .grant_inventory_item("a", "ordinary-unknown", "not-an-item", 3)
            .unwrap();
        assert!(!unknown_changed.success);
        assert_eq!(unknown_changed.code, "request_reused");
        let inventory = store.load_profile("a", &defaults).unwrap().inventory;
        assert_eq!(
            inventory
                .iter()
                .find(|item| item.item_id == "2000000")
                .unwrap()
                .quantity,
            3
        );
        assert!(inventory.iter().all(|item| item.item_id != "2000001"));

        // NB-05：GM 正式授予是真实授予、要留档，来源写 `gm`（不伪装成掉落）；
        // 同 requestId 的重放不写第二条事实，被拒绝的授予（数量 0、未知 id、
        // 换参数的 requestId 重放）一条都不写。
        let archived = store.notebook_item_records("a").unwrap();
        assert_eq!(
            archived
                .iter()
                .filter(|row| row.item_id == "2000000")
                .map(|row| (row.source_kind.as_str(), row.time_quality.as_str()))
                .collect::<Vec<_>>(),
            vec![("gm", "event")],
            "GM 授予必须留档一次，重放不得算成第二次获得"
        );
        assert!(
            archived.iter().all(|row| row.item_id != "2000001"),
            "被拒绝的授予不得在图鉴里留下事实"
        );

        // Deposit two same-species instances separately and withdraw them
        // again; warehouse stack logic must preserve their identities.
        let mut storage_ids = vec![first_pet_id];
        storage_ids.push(
            inventory
                .iter()
                .filter_map(inventory::pet_instance_id)
                .find(|id| *id != first_pet_id)
                .unwrap(),
        );
        for (index, pet_id) in storage_ids.iter().enumerate() {
            let inventory = store.load_profile("a", &defaults).unwrap().inventory;
            let pet = inventory
                .iter()
                .find(|item| inventory::pet_instance_id(item) == Some(*pet_id))
                .unwrap();
            let outcome = store
                .storage_transfer(
                    "a",
                    &format!("pet-deposit-{index}"),
                    StorageOperation::Deposit,
                    5,
                    pet.slot as i16,
                    1,
                )
                .unwrap();
            assert!(outcome.success);
        }
        let stored = store.load_storage("a").unwrap();
        assert_eq!(pet_ids(&stored), {
            let mut expected = storage_ids.clone();
            expected.sort_unstable();
            expected
        });
        for (index, pet_id) in storage_ids.iter().enumerate() {
            let stored = store.load_storage("a").unwrap();
            let row = stored
                .iter()
                .find(|item| inventory::pet_instance_id(item) == Some(*pet_id))
                .unwrap();
            let outcome = store
                .storage_transfer(
                    "a",
                    &format!("pet-withdraw-{index}"),
                    StorageOperation::Withdraw,
                    5,
                    row.slot as i16,
                    1,
                )
                .unwrap();
            assert!(outcome.success);
        }
        let after_storage = store.load_profile("a", &defaults).unwrap().inventory;
        assert!(storage_ids.iter().all(|id| {
            after_storage
                .iter()
                .any(|item| inventory::pet_instance_id(item) == Some(*id))
        }));
        // NB-05：仓库存取是**同主体移动**，不是获得——存取往返不新增任何图鉴事实
        // （反证：若把存入／取出误当授予，下面就会多出宠物条目）。
        assert_eq!(
            store.notebook_item_records("a").unwrap(),
            archived,
            "仓库往返不得改变图鉴事实"
        );

        // Dropping the clone is required before reopening the same sqlite file.
        drop(store);
        drop(auth);
        let auth = start(&path).unwrap();
        let store = auth.store.clone();
        let profile = store.load_profile("a", &defaults).unwrap();
        let pet = profile
            .inventory
            .iter()
            .find(|item| inventory::pet_instance_id(item) == Some(first_pet_id))
            .unwrap();
        assert!(inventory::pet_active(pet));
        let replayed_after_restart = store
            .toggle_pet("a", "pet-toggle-1", pet.slot as i16, "5000000")
            .unwrap();
        assert!(replayed_after_restart.success);
        let after_replay = store.load_profile("a", &defaults).unwrap().inventory;
        let pet = after_replay
            .iter()
            .find(|item| inventory::pet_instance_id(item) == Some(first_pet_id))
            .unwrap();
        assert!(inventory::pet_active(pet));
        assert_eq!(
            after_replay
                .iter()
                .filter(|item| inventory::pet_active(item))
                .count(),
            3
        );
        drop(store);
        drop(auth);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }
}
