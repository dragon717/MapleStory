use crate::lobby;
use crate::protocol::{AbilityStat, AbilityStats};
use crate::{
    inventory::{self, EquipmentStats, SLOT_LIMIT},
    protocol::InventoryItem,
};
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use rand::{rngs::OsRng, Rng, RngCore};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, HashMap},
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, oneshot};

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
    fn init(db: &Connection) -> rusqlite::Result<()> {
        db.execute_batch(
            "PRAGMA foreign_keys=ON;
             PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS accounts(
               id TEXT PRIMARY KEY,
               username TEXT NOT NULL UNIQUE,
               password_hash TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS player_stats(
               account_id TEXT PRIMARY KEY,
               hp INTEGER NOT NULL,
               max_hp INTEGER NOT NULL,
               mp INTEGER NOT NULL,
               max_mp INTEGER NOT NULL,
               level INTEGER NOT NULL,
               job INTEGER NOT NULL DEFAULT 0,
               exp INTEGER NOT NULL,
               exp_to_next INTEGER NOT NULL,
               mesos INTEGER NOT NULL DEFAULT 0,
               death_id TEXT NOT NULL DEFAULT '',
               starter_equipment_seeded INTEGER NOT NULL DEFAULT 0,
               map_id TEXT NOT NULL DEFAULT '',
               x REAL NOT NULL DEFAULT 0,
               y REAL NOT NULL DEFAULT 0,
               skills_json TEXT NOT NULL DEFAULT '{}',
               skill_points_json TEXT NOT NULL DEFAULT '{}',
               ability_stats_json TEXT NOT NULL DEFAULT '',
               mage_support_granted INTEGER NOT NULL DEFAULT 0,
               hyper_reset_count INTEGER NOT NULL DEFAULT 0,
               inventory_slots_json TEXT NOT NULL DEFAULT ''
             );
             CREATE TABLE IF NOT EXISTS inventory(
               account_id TEXT NOT NULL,
               inventory_type INTEGER NOT NULL DEFAULT 0,
               slot INTEGER NOT NULL,
               item_id TEXT NOT NULL,
               quantity INTEGER NOT NULL,
               stats_json TEXT NOT NULL DEFAULT '{}',
               upgrade_count INTEGER NOT NULL DEFAULT 0,
               remaining_slots INTEGER NOT NULL DEFAULT 0,
               PRIMARY KEY(account_id,inventory_type,slot)
             );
             CREATE TABLE IF NOT EXISTS equipped(
               account_id TEXT NOT NULL,
               slot INTEGER NOT NULL,
               item_id TEXT NOT NULL,
               quantity INTEGER NOT NULL,
               stats_json TEXT NOT NULL DEFAULT '{}',
               upgrade_count INTEGER NOT NULL DEFAULT 0,
               remaining_slots INTEGER NOT NULL DEFAULT 0,
               PRIMARY KEY(account_id,slot)
             );
             CREATE TABLE IF NOT EXISTS monster_book_cards(
               account_id TEXT NOT NULL,
               item_id TEXT NOT NULL,
               quantity INTEGER NOT NULL,
               PRIMARY KEY(account_id,item_id)
             );
             CREATE TABLE IF NOT EXISTS storage(
               account_id TEXT NOT NULL,
               slot INTEGER NOT NULL,
               item_id TEXT NOT NULL,
               quantity INTEGER NOT NULL,
               stats_json TEXT NOT NULL DEFAULT '{}',
               upgrade_count INTEGER NOT NULL DEFAULT 0,
               remaining_slots INTEGER NOT NULL DEFAULT 0,
               PRIMARY KEY(account_id,slot)
             );
             CREATE TABLE IF NOT EXISTS storage_actions(
               account_id TEXT NOT NULL,
               request_id TEXT NOT NULL,
               operation TEXT NOT NULL,
               inventory_type INTEGER NOT NULL DEFAULT 0,
               item_id TEXT NOT NULL,
               quantity INTEGER NOT NULL,
               slot INTEGER,
               success INTEGER NOT NULL,
               code TEXT NOT NULL,
               PRIMARY KEY(account_id,request_id)
             );
             CREATE TABLE IF NOT EXISTS storage_mesos(
               account_id TEXT PRIMARY KEY,
               mesos INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS storage_mesos_actions(
               account_id TEXT NOT NULL,
               request_id TEXT NOT NULL,
               operation TEXT NOT NULL,
               quantity INTEGER NOT NULL,
               success INTEGER NOT NULL,
               code TEXT NOT NULL,
               mesos INTEGER NOT NULL DEFAULT 0,
               stored_mesos INTEGER NOT NULL DEFAULT 0,
               PRIMARY KEY(account_id,request_id)
             );
             CREATE TABLE IF NOT EXISTS inventory_actions(
               account_id TEXT NOT NULL,
               request_id TEXT NOT NULL,
               operation TEXT NOT NULL,
               inventory_type INTEGER NOT NULL DEFAULT 0,
               from_slot INTEGER NOT NULL,
               to_slot INTEGER,
               item_id TEXT NOT NULL,
               quantity INTEGER NOT NULL,
               drop_id TEXT,
               success INTEGER NOT NULL,
               code TEXT NOT NULL,
               PRIMARY KEY(account_id,request_id)
             );
             CREATE TABLE IF NOT EXISTS attack_actions(
               account_id TEXT NOT NULL,
               request_id TEXT NOT NULL,
               action_id TEXT NOT NULL,
               event TEXT NOT NULL,
               map_id TEXT NOT NULL DEFAULT '',
               resolved INTEGER NOT NULL DEFAULT 0,
               target_id TEXT,
               damage INTEGER NOT NULL DEFAULT 0,
               killed INTEGER NOT NULL DEFAULT 0,
               exp_gain INTEGER NOT NULL DEFAULT 0,
               drop_id TEXT,
               drop_item_id TEXT,
               drop_quantity INTEGER,
               drop_x REAL,
               drop_y REAL,
               PRIMARY KEY(account_id,request_id),
               UNIQUE(account_id,action_id)
             );
             CREATE TABLE IF NOT EXISTS attack_drops(
               account_id TEXT NOT NULL,
               request_id TEXT NOT NULL,
               drop_id TEXT NOT NULL,
               PRIMARY KEY(account_id,request_id,drop_id)
             );
             CREATE TABLE IF NOT EXISTS monster_rewards(
               monster_id TEXT PRIMARY KEY,
               account_id TEXT NOT NULL,
               request_id TEXT NOT NULL,
               exp_gain INTEGER NOT NULL,
               drop_id TEXT,
               practice INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS monster_damage(
               monster_id TEXT NOT NULL,
               account_id TEXT NOT NULL,
               damage INTEGER NOT NULL,
               PRIMARY KEY(monster_id,account_id)
             );
             CREATE TABLE IF NOT EXISTS drops(
               id TEXT PRIMARY KEY,
               map_id TEXT NOT NULL,
               item_id TEXT NOT NULL,
               quantity INTEGER NOT NULL,
               x REAL NOT NULL,
               y REAL NOT NULL,
               owner_account_id TEXT,
               protected_until_ms INTEGER NOT NULL DEFAULT 0,
               stats_json TEXT NOT NULL DEFAULT '{}',
               upgrade_count INTEGER NOT NULL DEFAULT 0,
               remaining_slots INTEGER NOT NULL DEFAULT 0,
               active INTEGER NOT NULL DEFAULT 1
             );
             CREATE TABLE IF NOT EXISTS pickup_actions(
               account_id TEXT NOT NULL,
               request_id TEXT NOT NULL,
               drop_id TEXT NOT NULL,
               item_id TEXT NOT NULL,
               quantity INTEGER NOT NULL,
               slot INTEGER,
               success INTEGER NOT NULL,
               code TEXT NOT NULL,
               PRIMARY KEY(account_id,request_id)
             );
             CREATE TABLE IF NOT EXISTS revive_actions(
               account_id TEXT NOT NULL,
               request_id TEXT NOT NULL,
               death_id TEXT NOT NULL,
               success INTEGER NOT NULL,
               code TEXT NOT NULL,
               PRIMARY KEY(account_id,request_id)
             );
             CREATE TABLE IF NOT EXISTS player_quests(
               account_id TEXT NOT NULL,
               quest_id TEXT NOT NULL,
               status TEXT NOT NULL,
               PRIMARY KEY(account_id,quest_id)
             );
             -- Account-scoped social graph (friend + blacklist).  Membership is
             -- symmetric: a friend row is inserted in both directions, so a
             -- friend is a fact about two characters at once and a single
             -- INSERT OR IGNORE on either side keeps the pair in sync.
             CREATE TABLE IF NOT EXISTS friends(
               account_id TEXT NOT NULL,
               friend_id TEXT NOT NULL,
               PRIMARY KEY(account_id,friend_id)
             );
             CREATE TABLE IF NOT EXISTS blacklist(
               account_id TEXT NOT NULL,
               blocked_id TEXT NOT NULL,
               PRIMARY KEY(account_id,blocked_id)
             );
             CREATE TABLE IF NOT EXISTS friend_actions(
               account_id TEXT NOT NULL,
               request_id TEXT NOT NULL,
               operation TEXT NOT NULL,
               target_id TEXT NOT NULL,
               success INTEGER NOT NULL,
               code TEXT NOT NULL,
               PRIMARY KEY(account_id,request_id)
             );",
        )?;
        // Existing development databases predate the mesos column. Keep their
        // account rows usable without resetting any progress.
        let has_mesos: Option<String> = db
            .query_row(
                "SELECT name FROM pragma_table_info('player_stats') WHERE name='mesos'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if has_mesos.is_none() {
            db.execute(
                "ALTER TABLE player_stats ADD COLUMN mesos INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        let has_death_id: Option<String> = db
            .query_row(
                "SELECT name FROM pragma_table_info('player_stats') WHERE name='death_id'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if has_death_id.is_none() {
            db.execute(
                "ALTER TABLE player_stats ADD COLUMN death_id TEXT NOT NULL DEFAULT ''",
                [],
            )?;
        }
        let has_starter_equipment_seeded: Option<String> = db
            .query_row(
                "SELECT name FROM pragma_table_info('player_stats') WHERE name='starter_equipment_seeded'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if has_starter_equipment_seeded.is_none() {
            db.execute(
                "ALTER TABLE player_stats ADD COLUMN starter_equipment_seeded INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        // Character job was added after the first 273 schema.  Existing rows
        // are authoritative beginners (job 0); new rows receive the startup
        // default supplied by load_profile().
        let has_job: Option<String> = db
            .query_row(
                "SELECT name FROM pragma_table_info('player_stats') WHERE name='job'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if has_job.is_none() {
            db.execute(
                "ALTER TABLE player_stats ADD COLUMN job INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        // Persist the player's last map + foot coordinates across reconnects.
        // Older databases predate these columns; treat them as "no record" so
        // the join site falls back to the authored birth map spawn.
        let has_position_map: Option<String> = db
            .query_row(
                "SELECT name FROM pragma_table_info('player_stats') WHERE name='map_id'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if has_position_map.is_none() {
            db.execute(
                "ALTER TABLE player_stats ADD COLUMN map_id TEXT NOT NULL DEFAULT ''",
                [],
            )?;
            db.execute(
                "ALTER TABLE player_stats ADD COLUMN x REAL NOT NULL DEFAULT 0",
                [],
            )?;
            db.execute(
                "ALTER TABLE player_stats ADD COLUMN y REAL NOT NULL DEFAULT 0",
                [],
            )?;
        }
        for (column, definition) in [
            ("skills_json", "TEXT NOT NULL DEFAULT '{}'"),
            ("skill_points_json", "TEXT NOT NULL DEFAULT '{}'"),
            ("ability_stats_json", "TEXT NOT NULL DEFAULT ''"),
        ] {
            let exists: Option<String> = db
                .query_row(
                    &format!(
                        "SELECT name FROM pragma_table_info('player_stats') WHERE name='{column}'"
                    ),
                    [],
                    |row| row.get(0),
                )
                .optional()?;
            if exists.is_none() {
                db.execute(
                    &format!("ALTER TABLE player_stats ADD COLUMN {column} {definition}"),
                    [],
                )?;
            }
        }
        // P: seed existing characters once with five AP per already-earned level.
        db.execute_batch(
            "UPDATE player_stats SET ability_stats_json=json_object(
            'strength',12,'dexterity',5,'intelligence',4,'luck',4,
            'availableAp',MIN(4294967295,MAX(0,level-1)*5)) WHERE ability_stats_json='';
            CREATE TABLE IF NOT EXISTS ability_actions(
                account_id TEXT NOT NULL,request_id TEXT NOT NULL,stat TEXT NOT NULL,
                success INTEGER NOT NULL,code TEXT NOT NULL,stats_json TEXT NOT NULL,
                PRIMARY KEY(account_id,request_id));",
        )?;
        let has_mage_support: Option<String> = db
            .query_row(
                "SELECT name FROM pragma_table_info('player_stats') WHERE name='mage_support_granted'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if has_mage_support.is_none() {
            db.execute(
                "ALTER TABLE player_stats ADD COLUMN mage_support_granted INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        let has_hyper_reset_count: Option<String> = db
            .query_row(
                "SELECT name FROM pragma_table_info('player_stats') WHERE name='hyper_reset_count'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if has_hyper_reset_count.is_none() {
            db.execute(
                "ALTER TABLE player_stats ADD COLUMN hyper_reset_count INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        // Per-tab inventory slot capacities (TMS273 slot-expansion coupons).
        // Empty means every tab is at the default 24; older rows are read as
        // the default rather than resetting progress.
        let has_inventory_slots: Option<String> = db
            .query_row(
                "SELECT name FROM pragma_table_info('player_stats') WHERE name='inventory_slots_json'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if has_inventory_slots.is_none() {
            db.execute(
                "ALTER TABLE player_stats ADD COLUMN inventory_slots_json TEXT NOT NULL DEFAULT ''",
                [],
            )?;
        }
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS skill_actions(
               account_id TEXT NOT NULL,
               request_id TEXT NOT NULL,
               operation TEXT NOT NULL,
               skill_id INTEGER NOT NULL,
               success INTEGER NOT NULL,
               code TEXT NOT NULL,
               skill_level INTEGER NOT NULL DEFAULT 0,
               remaining_sp INTEGER NOT NULL DEFAULT 0,
               mp INTEGER NOT NULL DEFAULT 0,
               quoted_cost INTEGER NOT NULL DEFAULT 0,
               PRIMARY KEY(account_id,request_id)
             );
             CREATE TABLE IF NOT EXISTS skill_cooldowns(
               account_id TEXT NOT NULL,
               skill_id INTEGER NOT NULL,
               ready_at_ms INTEGER NOT NULL,
               PRIMARY KEY(account_id,skill_id)
             );",
        )?;
        let has_quoted_cost: Option<String> = db
            .query_row(
                "SELECT name FROM pragma_table_info('skill_actions') WHERE name='quoted_cost'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if has_quoted_cost.is_none() {
            db.execute(
                "ALTER TABLE skill_actions ADD COLUMN quoted_cost INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        let has_drop_owner: Option<String> = db
            .query_row(
                "SELECT name FROM pragma_table_info('drops') WHERE name='owner_account_id'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if has_drop_owner.is_none() {
            db.execute("ALTER TABLE drops ADD COLUMN owner_account_id TEXT", [])?;
        }
        let has_drop_protection: Option<String> = db
            .query_row(
                "SELECT name FROM pragma_table_info('drops') WHERE name='protected_until_ms'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        // Legacy drops have no creation time: treat them as already expired.
        // Keep their items and owners; the deadline, not ownership alone, gates pickup.
        if has_drop_protection.is_none() {
            db.execute(
                "ALTER TABLE drops ADD COLUMN protected_until_ms INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        // Early development databases keyed inventory by item ID or by one
        // global slot.  Migrate both shapes to category-local slots without
        // resetting any account progress.
        let has_inventory_slot: Option<String> = db
            .query_row(
                "SELECT name FROM pragma_table_info('inventory') WHERE name='slot'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let has_inventory_type: Option<String> = db
            .query_row(
                "SELECT name FROM pragma_table_info('inventory') WHERE name='inventory_type'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let has_inventory_stats: Option<String> = db
            .query_row(
                "SELECT name FROM pragma_table_info('inventory') WHERE name='stats_json'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let has_inventory_upgrade_count: Option<String> = db
            .query_row(
                "SELECT name FROM pragma_table_info('inventory') WHERE name='upgrade_count'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let has_inventory_remaining_slots: Option<String> = db
            .query_row(
                "SELECT name FROM pragma_table_info('inventory') WHERE name='remaining_slots'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        // A short-lived intermediate schema added `inventory_type` but kept
        // the old `(account_id,slot)` primary key.  Presence of both columns
        // alone therefore does not prove that slots are category-local.
        let inventory_pk_columns: Vec<String> = {
            let mut stmt = db.prepare("PRAGMA table_info(inventory)")?;
            let mut columns = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, i64>(5)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            columns.retain(|(position, _)| *position > 0);
            columns.sort_by_key(|(position, _)| *position);
            columns.into_iter().map(|(_, name)| name).collect()
        };
        let has_category_local_key = inventory_pk_columns
            == ["account_id", "inventory_type", "slot"]
                .into_iter()
                .map(str::to_owned)
                .collect::<Vec<_>>();
        if has_inventory_slot.is_none() || has_inventory_type.is_none() || !has_category_local_key {
            migrate_inventory_schema(
                &db,
                has_inventory_slot.is_some(),
                has_inventory_stats.is_some(),
                has_inventory_upgrade_count.is_some(),
                has_inventory_remaining_slots.is_some(),
            )?;
        }
        for (table, column, definition) in [
            ("inventory", "stats_json", "TEXT NOT NULL DEFAULT '{}'"),
            ("inventory", "upgrade_count", "INTEGER NOT NULL DEFAULT 0"),
            ("inventory", "remaining_slots", "INTEGER NOT NULL DEFAULT 0"),
            ("drops", "stats_json", "TEXT NOT NULL DEFAULT '{}'"),
            ("drops", "upgrade_count", "INTEGER NOT NULL DEFAULT 0"),
            ("drops", "remaining_slots", "INTEGER NOT NULL DEFAULT 0"),
            ("attack_actions", "map_id", "TEXT NOT NULL DEFAULT ''"),
            ("monster_rewards", "practice", "INTEGER NOT NULL DEFAULT 0"),
        ] {
            let exists: Option<String> = db
                .query_row(
                    &format!("SELECT name FROM pragma_table_info('{table}') WHERE name='{column}'"),
                    [],
                    |row| row.get(0),
                )
                .optional()?;
            if exists.is_none() {
                db.execute(
                    &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
                    [],
                )?;
            }
        }
        let has_inventory_action_type: Option<String> = db
            .query_row(
                "SELECT name FROM pragma_table_info('inventory_actions') WHERE name='inventory_type'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if has_inventory_action_type.is_none() {
            db.execute(
                "ALTER TABLE inventory_actions ADD COLUMN inventory_type INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        for (table, column, definition) in [
            ("equipped", "stats_json", "TEXT NOT NULL DEFAULT '{}'"),
            ("equipped", "upgrade_count", "INTEGER NOT NULL DEFAULT 0"),
            ("equipped", "remaining_slots", "INTEGER NOT NULL DEFAULT 0"),
        ] {
            let exists: Option<String> = db
                .query_row(
                    &format!("SELECT name FROM pragma_table_info('{table}') WHERE name='{column}'"),
                    [],
                    |row| row.get(0),
                )
                .optional()?;
            if exists.is_none() {
                db.execute(
                    &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
                    [],
                )?;
            }
        }
        let has_pickup_slot: Option<String> = db
            .query_row(
                "SELECT name FROM pragma_table_info('pickup_actions') WHERE name='slot'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if has_pickup_slot.is_none() {
            db.execute("ALTER TABLE pickup_actions ADD COLUMN slot INTEGER", [])?;
        }
        crate::lobby::init(db)?;
        Ok(())
    }

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
            "INSERT OR IGNORE INTO player_stats(account_id,hp,max_hp,mp,max_mp,level,job,exp,exp_to_next,mesos,death_id,map_id,x,y,skills_json,skill_points_json,ability_stats_json)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'',?11,?12,?13,'{}','{}',?14)",
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
                slots.insert(kind, capacity.clamp(inventory::SLOT_LIMIT, inventory::MAX_SLOT_LIMIT));
            }
        }
        Ok(slots)
    }

    /// Persist the durable per-tab inventory slot capacities.
    pub fn save_inventory_slots(
        &self,
        account_id: &str,
        slots: &BTreeMap<u8, u16>,
    ) -> Result<(), String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        let json = serde_json::to_string(slots).map_err(|_| "account persistence failed")?;
        db.execute(
            "UPDATE player_stats SET inventory_slots_json=?2 WHERE account_id=?1",
            params![account_id, json],
        )
        .map_err(|_| "account persistence failed")?;
        Ok(())
    }

    pub fn save_profile(&self, account_id: &str, profile: &Profile) -> Result<(), String> {
        let skills_json = serialize_skill_map(&profile.skills)?;
        let skill_points_json = serialize_skill_map(&profile.skill_points)?;
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        db.execute(
            "UPDATE player_stats SET hp=?2,max_hp=?3,mp=?4,max_mp=?5,level=?6,job=?7,exp=?8,exp_to_next=?9,mesos=?10,death_id=?11,map_id=?12,x=?13,y=?14,skills_json=?15,skill_points_json=?16,ability_stats_json=?17
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
        let required_level: i64 = if from_job == 200 && job == 220 {
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

    pub fn cast_skill(
        &self,
        account_id: &str,
        request_id: &str,
        skill_id: u32,
        expected_job: u32,
        book_id: u32,
        max_level: u32,
        mp_cost: i64,
    ) -> Result<SkillActionOutcome, String> {
        self.cast_skill_with_cooldown(
            account_id,
            request_id,
            skill_id,
            expected_job,
            book_id,
            max_level,
            mp_cost,
            0,
        )
    }

    /// Atomically spend MP and start a server-authored skill cooldown.
    /// `cooldown_ms` is supplied by the server's skill definition; callers
    /// must never forward a client timestamp or client duration.
    pub fn cast_skill_with_cooldown(
        &self,
        account_id: &str,
        request_id: &str,
        skill_id: u32,
        expected_job: u32,
        book_id: u32,
        max_level: u32,
        mp_cost: i64,
        cooldown_ms: i64,
    ) -> Result<SkillActionOutcome, String> {
        self.skill_action(
            account_id,
            request_id,
            "cast",
            skill_id,
            expected_job,
            book_id,
            max_level,
            &BTreeMap::new(),
            false,
            mp_cost,
            cooldown_ms,
            skill_id,
        )
    }

    /// Cast the public Hyper vortex (2221054).  Its cooldown is keyed to the
    /// hidden server-only 2221055 variant so changing the visible skill id
    /// cannot bypass the shared cooldown.
    pub fn cast_hyper_vortex(
        &self,
        account_id: &str,
        request_id: &str,
        mp_cost: i64,
        cooldown_ms: i64,
    ) -> Result<SkillActionOutcome, String> {
        self.skill_action(
            account_id,
            request_id,
            "cast",
            HYPER_VORTEX_SKILL,
            FOURTH_JOB,
            FOURTH_MAGE_BOOK,
            1,
            &BTreeMap::new(),
            false,
            mp_cost,
            cooldown_ms,
            HYPER_HIDDEN_SKILL,
        )
    }

    /// Atomically clear all visible Hyper investments and charge the
    /// server-authored reset price.  The durable request ledger is checked
    /// before current state so a replay returns the original result verbatim.
    pub fn reset_hyper_skills(
        &self,
        account_id: &str,
        request_id: &str,
        expected_cost: u64,
    ) -> Result<SkillActionOutcome, String> {
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        if let Some((mut outcome, quoted_cost)) = tx
            .query_row(
                "SELECT operation,skill_id,success,code,skill_level,remaining_sp,mp,quoted_cost FROM skill_actions WHERE account_id=?1 AND request_id=?2",
                params![account_id, request_id],
                |row| {
                    Ok((
                        SkillActionOutcome {
                            operation: row.get(0)?,
                            skill_id: row.get::<_, i64>(1)?.try_into().unwrap_or(0),
                            success: row.get::<_, i64>(2)? != 0,
                            code: row.get(3)?,
                            level: row.get::<_, i64>(4)?.try_into().unwrap_or(0),
                            remaining_sp: row.get::<_, i64>(5)?.try_into().unwrap_or(0),
                            mp: row.get(6)?,
                            already_resolved: true,
                        },
                        row.get::<_, i64>(7)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| "account persistence failed")?
        {
            let expected_cost_i64 = i64::try_from(expected_cost).ok();
            if outcome.operation != "hyper_reset"
                || outcome.skill_id != 0
                || expected_cost_i64 != Some(quoted_cost)
            {
                outcome.success = false;
                outcome.code = "request_conflict".to_owned();
            }
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(outcome);
        }
        let (job, level, mesos, current_mp, skills_json, reset_count):
            (i64, i64, i64, i64, String, i64) = tx
            .query_row(
                "SELECT job,level,mesos,mp,skills_json,hyper_reset_count FROM player_stats WHERE account_id=?1",
                [account_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
            )
            .map_err(|_| "account persistence failed")?;
        let current_level = u32::try_from(level.max(0)).unwrap_or(0);
        let reset_count = u8::try_from(reset_count.clamp(0, 4)).unwrap_or(0);
        let cost = hyper_reset_cost(reset_count);
        let mut skills = parse_skill_map(&skills_json)?;
        let has_investment = HYPER_VISIBLE_SKILLS
            .iter()
            .any(|skill_id| skills.get(skill_id).copied().unwrap_or(0) > 0);
        let mut success = true;
        let mut code = String::new();
        if job != i64::from(FOURTH_JOB) {
            success = false;
            code = "wrong_job".to_owned();
        } else if current_level < 140 {
            success = false;
            code = "level_requirement".to_owned();
        } else if !has_investment {
            success = false;
            code = "hyper_no_investment".to_owned();
        } else if expected_cost != cost {
            success = false;
            code = "cost_changed".to_owned();
        } else if mesos < i64::try_from(cost).unwrap_or(i64::MAX) {
            success = false;
            code = "not_enough_mesos".to_owned();
        } else {
            for skill_id in HYPER_VISIBLE_SKILLS {
                skills.remove(&skill_id);
            }
        }
        let remaining_sp = 0_i64;
        let ledger_cost =
            i64::try_from(if success { cost } else { expected_cost }).unwrap_or(i64::MAX);
        tx.execute(
            "INSERT INTO skill_actions(account_id,request_id,operation,skill_id,success,code,skill_level,remaining_sp,mp,quoted_cost) VALUES(?1,?2,'hyper_reset',0,?3,?4,0,?5,?6,?7)",
            params![
                account_id,
                request_id,
                if success { 1 } else { 0 },
                code.clone(),
                remaining_sp,
                current_mp.max(0),
                ledger_cost,
            ],
        )
        .map_err(|_| "account persistence failed")?;
        if success {
            let new_mesos = mesos - i64::try_from(cost).unwrap_or(i64::MAX);
            let next_reset_count = i64::from(reset_count.min(4).saturating_add(1).min(4));
            let changed = tx
                .execute(
                    "UPDATE player_stats SET mesos=?2,skills_json=?3,hyper_reset_count=?4
                     WHERE account_id=?1 AND job=?5 AND level>=140 AND hyper_reset_count=?6",
                    params![
                        account_id,
                        new_mesos,
                        serialize_skill_map(&skills)?,
                        next_reset_count,
                        FOURTH_JOB,
                        i64::from(reset_count),
                    ],
                )
                .map_err(|_| "account persistence failed")?;
            if changed != 1 {
                return Err("account persistence failed".to_owned());
            }
        }
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(SkillActionOutcome {
            operation: "hyper_reset".to_owned(),
            skill_id: 0,
            success,
            code,
            level: 0,
            remaining_sp: u32::try_from(remaining_sp).unwrap_or(0),
            mp: current_mp.max(0),
            already_resolved: false,
        })
    }

    /// Return the durable server-side cooldown remaining for a skill.
    /// A missing or expired row is reported as zero.
    pub fn skill_cooldown_remaining_ms(
        &self,
        account_id: &str,
        skill_id: u32,
    ) -> Result<u64, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        let ready_at: Option<i64> = db
            .query_row(
                "SELECT ready_at_ms FROM skill_cooldowns WHERE account_id=?1 AND skill_id=?2",
                params![account_id, i64::from(skill_id)],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "account persistence failed")?;
        Ok(ready_at
            .map(|value| value.saturating_sub(now_ms()).try_into().unwrap_or(0))
            .unwrap_or(0))
    }

    /// Read an already settled skill request before any world-side validation
    /// (collision, action lock, or current MP).  A retry must replay the exact
    /// transaction outcome even after teleporting or changing state.
    pub fn prior_skill_action(
        &self,
        account_id: &str,
        request_id: &str,
        operation: &str,
        skill_id: u32,
    ) -> Result<Option<SkillActionOutcome>, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        let mut outcome = db
            .query_row(
                "SELECT operation,skill_id,success,code,skill_level,remaining_sp,mp FROM skill_actions WHERE account_id=?1 AND request_id=?2",
                params![account_id, request_id],
                |row| {
                    Ok(SkillActionOutcome {
                        operation: row.get(0)?,
                        skill_id: row.get::<_, i64>(1)?.try_into().unwrap_or(0),
                        success: row.get::<_, i64>(2)? != 0,
                        code: row.get(3)?,
                        level: row.get::<_, i64>(4)?.try_into().unwrap_or(0),
                        remaining_sp: row.get::<_, i64>(5)?.try_into().unwrap_or(0),
                        mp: row.get(6)?,
                        already_resolved: true,
                    })
                },
            )
            .optional()
            .map_err(|_| "account persistence failed")?;
        if let Some(value) = outcome.as_mut() {
            if value.operation != operation || value.skill_id != skill_id {
                value.success = false;
                value.code = "request_conflict".to_owned();
            }
        }
        Ok(outcome)
    }

    fn hyper_skill_action(
        &self,
        account_id: &str,
        request_id: &str,
        operation: &str,
        skill_id: u32,
        expected_job: u32,
        book_id: u32,
        _max_level: u32,
        _prerequisites: &BTreeMap<u32, u32>,
        _hidden: bool,
        mp_cost: i64,
        cooldown_ms: i64,
        cooldown_skill_id: u32,
    ) -> Result<SkillActionOutcome, String> {
        let (kind, required_level) =
            hyper_skill_info(skill_id).ok_or_else(|| "unknown Hyper skill".to_owned())?;
        let cooldown_key = if cooldown_skill_id == 0 {
            skill_id
        } else {
            cooldown_skill_id
        };
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        if let Some(mut outcome) = tx
            .query_row(
                "SELECT operation,skill_id,success,code,skill_level,remaining_sp,mp FROM skill_actions WHERE account_id=?1 AND request_id=?2",
                params![account_id, request_id],
                |row| {
                    Ok(SkillActionOutcome {
                        operation: row.get(0)?,
                        skill_id: row.get::<_, i64>(1)?.try_into().unwrap_or(0),
                        success: row.get::<_, i64>(2)? != 0,
                        code: row.get(3)?,
                        level: row.get::<_, i64>(4)?.try_into().unwrap_or(0),
                        remaining_sp: row.get::<_, i64>(5)?.try_into().unwrap_or(0),
                        mp: row.get(6)?,
                        already_resolved: true,
                    })
                },
            )
            .optional()
            .map_err(|_| "account persistence failed")?
        {
            if outcome.operation != operation || outcome.skill_id != skill_id {
                outcome.success = false;
                outcome.code = "request_conflict".to_owned();
            }
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(outcome);
        }
        if cooldown_ms < 0 {
            return Err("invalid skill cooldown".to_owned());
        }
        let (job, level, current_mp, skills_json): (i64, i64, i64, String) = tx
            .query_row(
                "SELECT job,level,mp,skills_json FROM player_stats WHERE account_id=?1",
                [account_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(|_| "account persistence failed")?;
        let current_level = u32::try_from(level.max(0)).unwrap_or(0);
        let mut skills = parse_skill_map(&skills_json)?;
        let current_skill_level = skills.get(&skill_id).copied().unwrap_or(0).min(1);
        let mut next_skill_level = current_skill_level;
        let mut next_mp = current_mp.max(0);
        let mut success = true;
        let mut code = String::new();
        if job != i64::from(FOURTH_JOB) || expected_job != FOURTH_JOB || book_id != FOURTH_MAGE_BOOK
        {
            success = false;
            code = "wrong_job".to_owned();
        } else if hyper_skill_hidden(skill_id) {
            success = false;
            code = "skill_hidden".to_owned();
        } else if current_level < required_level {
            success = false;
            code = "level_requirement".to_owned();
        } else if !matches!(operation, "learn" | "cast") {
            success = false;
            code = "invalid_operation".to_owned();
        } else if operation == "learn" {
            if current_skill_level >= 1 {
                success = false;
                code = "max_level".to_owned();
            } else if hyper_skill_prerequisites(skill_id)
                .iter()
                .any(|(prerequisite, required)| {
                    skills.get(prerequisite).copied().unwrap_or(0) < *required
                })
            {
                success = false;
                code = "prerequisite".to_owned();
            } else if hyper_points(current_level, &skills, kind) == 0 {
                success = false;
                code = "not_enough_hyper_points".to_owned();
            } else {
                next_skill_level = 1;
                skills.insert(skill_id, next_skill_level);
            }
        } else if current_skill_level == 0 {
            success = false;
            code = "not_learned".to_owned();
        } else if kind == 1 && skill_id != 2_221_045 {
            success = false;
            code = "skill_passive".to_owned();
        } else if mp_cost < 0 || current_mp < mp_cost {
            success = false;
            code = "not_enough_mp".to_owned();
        } else {
            // World emits each authorized 2221052 channel pulse as a fresh
            // request with the fixed 30 MP charge and cooldown_ms=0.  The
            // initial cast owns the durable 60-second cooldown; pulses must
            // charge MP without being mistaken for a second initial cast.
            let authorized_hyper_pulse =
                skill_id == HYPER_THUNDER_SKILL && cooldown_ms == 0 && mp_cost == 30;
            if !authorized_hyper_pulse {
                let now = now_ms();
                let ready_at: Option<i64> = tx
                    .query_row(
                        "SELECT ready_at_ms FROM skill_cooldowns WHERE account_id=?1 AND skill_id=?2",
                        params![account_id, i64::from(cooldown_key)],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|_| "account persistence failed")?;
                if ready_at.is_some_and(|value| value > now) {
                    success = false;
                    code = "skill_cooldown".to_owned();
                }
            }
            if success {
                next_mp = current_mp - mp_cost;
            }
        }
        let remaining_sp = hyper_points(current_level, &skills, kind);
        tx.execute(
            "INSERT INTO skill_actions(account_id,request_id,operation,skill_id,success,code,skill_level,remaining_sp,mp,quoted_cost) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,0)",
            params![
                account_id,
                request_id,
                operation,
                i64::from(skill_id),
                if success { 1 } else { 0 },
                code.clone(),
                i64::from(next_skill_level),
                i64::from(remaining_sp),
                next_mp,
            ],
        )
        .map_err(|_| "account persistence failed")?;
        if success {
            let changed = tx
                .execute(
                    "UPDATE player_stats SET skills_json=?2,mp=?3 WHERE account_id=?1",
                    params![account_id, serialize_skill_map(&skills)?, next_mp],
                )
                .map_err(|_| "account persistence failed")?;
            if changed != 1 {
                return Err("account persistence failed".to_owned());
            }
            if operation == "cast" && cooldown_ms > 0 {
                let ready_at = now_ms().saturating_add(cooldown_ms);
                tx.execute(
                    "INSERT INTO skill_cooldowns(account_id,skill_id,ready_at_ms) VALUES(?1,?2,?3)
                     ON CONFLICT(account_id,skill_id) DO UPDATE SET ready_at_ms=excluded.ready_at_ms",
                    params![account_id, i64::from(cooldown_key), ready_at],
                )
                .map_err(|_| "account persistence failed")?;
            }
        }
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(SkillActionOutcome {
            operation: operation.to_owned(),
            skill_id,
            success,
            code,
            level: next_skill_level,
            remaining_sp,
            mp: next_mp,
            already_resolved: false,
        })
    }

    fn skill_action(
        &self,
        account_id: &str,
        request_id: &str,
        operation: &str,
        skill_id: u32,
        expected_job: u32,
        book_id: u32,
        max_level: u32,
        prerequisites: &BTreeMap<u32, u32>,
        hidden: bool,
        mp_cost: i64,
        cooldown_ms: i64,
        cooldown_skill_id: u32,
    ) -> Result<SkillActionOutcome, String> {
        if hyper_skill_info(skill_id).is_some() {
            return self.hyper_skill_action(
                account_id,
                request_id,
                operation,
                skill_id,
                expected_job,
                book_id,
                max_level,
                prerequisites,
                hidden,
                mp_cost,
                cooldown_ms,
                cooldown_skill_id,
            );
        }
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        if let Some(mut outcome) = tx
            .query_row(
                "SELECT operation,skill_id,success,code,skill_level,remaining_sp,mp FROM skill_actions WHERE account_id=?1 AND request_id=?2",
                params![account_id, request_id],
                |row| {
                    Ok(SkillActionOutcome {
                        operation: row.get(0)?,
                        skill_id: row.get::<_, i64>(1)?.try_into().unwrap_or(0),
                        success: row.get::<_, i64>(2)? != 0,
                        code: row.get(3)?,
                        level: row.get::<_, i64>(4)?.try_into().unwrap_or(0),
                        remaining_sp: row.get::<_, i64>(5)?.try_into().unwrap_or(0),
                        mp: row.get(6)?,
                        already_resolved: true,
                    })
                },
            )
            .optional()
            .map_err(|_| "account persistence failed")?
        {
            if outcome.operation != operation || outcome.skill_id != skill_id {
                outcome.success = false;
                outcome.code = "request_conflict".to_owned();
            }
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(outcome);
        }
        if cooldown_ms < 0 {
            return Err("invalid skill cooldown".to_owned());
        }
        let (job, current_mp, skills_json, skill_points_json): (i64, i64, String, String) = tx
            .query_row(
                "SELECT job,mp,skills_json,skill_points_json FROM player_stats WHERE account_id=?1",
                [account_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(|_| "account persistence failed")?;
        let mut skills = parse_skill_map(&skills_json)?;
        let mut skill_points = parse_skill_map(&skill_points_json)?;
        let mut success = true;
        let mut code = String::new();
        let job_allowed = if expected_job == 0 {
            job == 0 || u32::try_from(job).ok().is_some_and(mage_job_allowed)
        } else if expected_job == 200 {
            matches!(
                job,
                200 | 210 | 211 | 212 | 220 | 221 | 222 | 230 | 231 | 232
            )
        } else if expected_job == 220 {
            matches!(job, 220 | 221 | 222)
        } else if expected_job == THIRD_JOB {
            matches!(job, 221 | 222)
        } else if expected_job == FOURTH_JOB {
            job == i64::from(FOURTH_JOB)
        } else {
            job == i64::from(expected_job)
        };
        let current_level = skills.get(&skill_id).copied().unwrap_or(0);
        let mut next_level = current_level;
        let mut next_mp = current_mp.max(0);
        if !job_allowed
            || !matches!(book_id, 0 | 200 | 220 | 221 | FOURTH_MAGE_BOOK)
            || skill_id / 10_000 != book_id
            || expected_job != book_id
        {
            success = false;
            code = "wrong_job".to_owned();
        } else if book_id == 0
            && (!(1000..=1002).contains(&skill_id) || !(1..=3).contains(&max_level) || hidden)
        {
            success = false;
            code = "skill_unknown".to_owned();
        } else if skill_id == THIRD_HIDDEN_SKILL || FOURTH_HIDDEN_SKILLS.contains(&skill_id) {
            // 2211015 and the fourth-job hidden nodes are authored internal
            // effects.  They are never client-learnable or client-cast,
            // even if a caller tries to use the internal `hidden` bypass.
            success = false;
            code = "skill_hidden".to_owned();
        } else if skill_id == FOURTH_FIXED_SKILL {
            // The fixed level is granted by the transfer transaction only.
            success = false;
            code = "skill_fixed_level".to_owned();
        } else if operation == "cast" && FOURTH_PASSIVE_SKILLS.contains(&skill_id) {
            success = false;
            code = "skill_passive".to_owned();
        } else if operation == "learn" {
            if current_level >= max_level {
                success = false;
                code = "max_level".to_owned();
            } else if !hidden
                && prerequisites
                    .iter()
                    .any(|(id, required)| skills.get(id).copied().unwrap_or(0) < *required)
            {
                success = false;
                code = "prerequisite".to_owned();
            } else if !hidden && skill_points.get(&book_id).copied().unwrap_or(0) == 0 {
                success = false;
                code = "not_enough_sp".to_owned();
            } else {
                next_level = current_level + 1;
                skills.insert(skill_id, next_level);
                if !hidden {
                    let points = skill_points.entry(book_id).or_default();
                    *points -= 1;
                }
            }
        } else if current_level == 0 {
            success = false;
            code = "not_learned".to_owned();
        } else if mp_cost < 0 || current_mp < mp_cost {
            success = false;
            code = "not_enough_mp".to_owned();
        } else {
            next_mp = current_mp - mp_cost;
        }
        if success && operation == "cast" {
            let now = now_ms();
            let ready_at: Option<i64> = tx
                .query_row(
                    "SELECT ready_at_ms FROM skill_cooldowns WHERE account_id=?1 AND skill_id=?2",
                    params![account_id, i64::from(cooldown_skill_id)],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|_| "account persistence failed")?;
            if ready_at.is_some_and(|value| value > now) {
                success = false;
                code = "skill_cooldown".to_owned();
                next_mp = current_mp.max(0);
            }
        }
        let remaining_sp = skill_points.get(&book_id).copied().unwrap_or(0);
        tx.execute(
            "INSERT INTO skill_actions(account_id,request_id,operation,skill_id,success,code,skill_level,remaining_sp,mp) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                account_id,
                request_id,
                operation,
                i64::from(skill_id),
                if success { 1 } else { 0 },
                code.clone(),
                i64::from(next_level),
                i64::from(remaining_sp),
                next_mp,
            ],
        )
        .map_err(|_| "account persistence failed")?;
        if success {
            tx.execute(
                "UPDATE player_stats SET skills_json=?2,skill_points_json=?3,mp=?4 WHERE account_id=?1",
                params![
                    account_id,
                    serialize_skill_map(&skills)?,
                    serialize_skill_map(&skill_points)?,
                    next_mp,
                ],
            )
            .map_err(|_| "account persistence failed")?;
            if operation == "cast" && cooldown_ms > 0 {
                let ready_at = now_ms().saturating_add(cooldown_ms);
                tx.execute(
                    "INSERT INTO skill_cooldowns(account_id,skill_id,ready_at_ms) VALUES(?1,?2,?3)
                     ON CONFLICT(account_id,skill_id) DO UPDATE SET ready_at_ms=excluded.ready_at_ms",
                    params![account_id, i64::from(cooldown_skill_id), ready_at],
                )
                .map_err(|_| "account persistence failed")?;
            }
        }
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(SkillActionOutcome {
            operation: operation.to_owned(),
            skill_id,
            success,
            code,
            level: next_level,
            remaining_sp,
            mp: next_mp,
            already_resolved: false,
        })
    }

    /// Load the quest status map (quest id -> "active" | "completed") for an
    /// account.  The table lives separately from `player_stats` so development
    /// databases do not need a column migration.
    pub fn load_quests(&self, account_id: &str) -> Result<BTreeMap<String, String>, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        let mut stmt = db
            .prepare("SELECT quest_id,status FROM player_quests WHERE account_id=?1")
            .map_err(|_| "account persistence failed")?;
        let rows = stmt
            .query_map(params![account_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|_| "account persistence failed")?;
        let mut quests = BTreeMap::new();
        for row in rows {
            let (quest_id, status) = row.map_err(|_| "account persistence failed")?;
            quests.insert(quest_id, status);
        }
        Ok(quests)
    }

    /// Upsert one quest status row for existing store-level fixtures.
    #[cfg(test)]
    pub fn save_quest(&self, account_id: &str, quest_id: &str, status: &str) -> Result<(), String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        db.execute(
            "INSERT INTO player_quests(account_id,quest_id,status) VALUES(?1,?2,?3)
             ON CONFLICT(account_id,quest_id) DO UPDATE SET status=?3",
            params![account_id, quest_id, status],
        )
        .map_err(|_| "account persistence failed")?;
        Ok(())
    }

    /// Commit a quest transition and its player-side rewards as one durable
    /// business operation.  `(account_id, quest_id)` is the idempotency key;
    /// a retry after a committed transition returns `false` and rolls back.
    pub fn commit_quest(
        &self,
        account_id: &str,
        quest_id: &str,
        status: &str,
        profile: &Profile,
    ) -> Result<bool, String> {
        if quest_id.trim().is_empty() {
            return Err("invalid quest id".to_owned());
        }
        if !matches!(status, "active" | "completed") {
            return Err("invalid quest status".to_owned());
        }

        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;

        // Read through the same transaction so an unknown character cannot
        // create a quest row or leave a partial reward behind.  The durable
        // profile is also the authority for the q1402 transfer guard; the
        // world-supplied profile is an internal candidate, never client input.
        let durable_profile = read_profile(&tx, account_id)?;
        let previous: Option<String> = tx
            .query_row(
                "SELECT status FROM player_quests WHERE account_id=?1 AND quest_id=?2",
                params![account_id, quest_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "account persistence failed")?;

        let transition_allowed = match previous.as_deref() {
            None if status == "active" => true,
            Some("active") if status == "completed" => true,
            None if status == "completed" => {
                return Err("quest is not active".to_owned());
            }
            None => return Err("invalid quest transition".to_owned()),
            Some("active") | Some("completed") => false,
            Some(_) => return Err("invalid saved quest status".to_owned()),
        };
        if !transition_allowed {
            // Do not commit read_profile's normalization or any other write
            // on an idempotent retry; the caller reloads authoritative state.
            tx.rollback().map_err(|_| "account persistence failed")?;
            return Ok(false);
        }

        let mut first_mage_transfer = false;
        if quest_id == "1402" && status == "completed" {
            if durable_profile.level < 10 {
                return Err("q1402 level requirement missing".to_owned());
            }
            let prerequisite: Option<String> = tx
                .query_row(
                    "SELECT status FROM player_quests WHERE account_id=?1 AND quest_id='36307'",
                    [account_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|_| "account persistence failed")?;
            if prerequisite.as_deref() != Some("completed") {
                return Err("q1402 prerequisite missing".to_owned());
            }
            match durable_profile.job {
                0 => {
                    // World must prepare the candidate with the same pure
                    // first-job grant. Compare only transfer-owned fields so
                    // a stale beginner profile cannot overwrite job/SP/MP.
                    let mut expected = durable_profile.clone();
                    grant_first_mage(&mut expected);
                    if profile.job != expected.job
                        || profile.max_mp != expected.max_mp
                        || profile.mp != expected.mp
                        || profile.skills != expected.skills
                        || profile.skill_points != expected.skill_points
                    {
                        return Err("invalid q1402 first-job candidate".to_owned());
                    }
                    first_mage_transfer = true;
                }
                200 | 220 | THIRD_JOB | FOURTH_JOB => {
                    // A shortcut/older transferred character may recover the
                    // original story, but q1402 must not grant another job,
                    // SP or MP entitlement.
                    if profile.job != durable_profile.job {
                        return Err("q1402 job changed during story recovery".to_owned());
                    }
                }
                _ => return Err("q1402 job is not eligible".to_owned()),
            }
        }

        write_profile(&tx, account_id, profile)?;
        write_inventory_tx(&tx, account_id, &profile.inventory)?;
        if first_mage_transfer {
            let changed = tx
                .execute(
                    "UPDATE player_stats SET mage_support_granted=1 WHERE account_id=?1 AND job=200",
                    [account_id],
                )
                .map_err(|_| "account persistence failed")?;
            if changed != 1 {
                return Err("account persistence failed".to_owned());
            }
        }
        tx.execute(
            "INSERT INTO player_quests(account_id,quest_id,status) VALUES(?1,?2,?3)
             ON CONFLICT(account_id,quest_id) DO UPDATE SET status=?3",
            params![account_id, quest_id, status],
        )
        .map_err(|_| "account persistence failed")?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(true)
    }

    /// Recover the one authored quest interaction item from the durable
    /// inventory fact.  The interaction has no request table: possession is
    /// its idempotency key, so a retry with any request id cannot mint a
    /// second hairpin.
    pub fn commit_quest_interaction(
        &self,
        account_id: &str,
        quest_id: &str,
        item_id: &str,
        quantity: u32,
        profile: &Profile,
    ) -> Result<bool, String> {
        // P: the first authored interaction is Candy's quest 36301.  Keep
        // both sides of the pair fixed here so a caller cannot turn this
        // recovery hook into a generic item grant.
        if quest_id != "36301" || item_id != "4036846" || quantity != 1 {
            return Err("invalid quest interaction".to_owned());
        }

        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        let durable = read_profile(&tx, account_id)?;
        let status: Option<String> = tx
            .query_row(
                "SELECT status FROM player_quests WHERE account_id=?1 AND quest_id=?2",
                params![account_id, quest_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "account persistence failed")?;
        if status.as_deref() != Some("active") {
            return Err("quest is not active".to_owned());
        }

        let held = durable
            .inventory
            .iter()
            .filter(|item| item.item_id == item_id)
            .fold(0u32, |total, item| total.saturating_add(item.quantity));
        if held >= quantity {
            // read_profile may normalize legacy inventory rows.  An
            // idempotent retry must not commit even that normalization.
            tx.rollback().map_err(|_| "account persistence failed")?;
            return Ok(false);
        }

        let missing = quantity - held;
        let mut next_inventory = durable.inventory;
        let slots = read_inventory_slots_tx(&tx, account_id)
            .map_err(|_| "quest interaction rejected".to_owned())?;
        let slot_limit = slots
            .get(&inventory::inventory_type(item_id).unwrap_or(4))
            .copied()
            .unwrap_or(inventory::SLOT_LIMIT);
        inventory::add_items(&mut next_inventory, item_id.to_owned(), missing, slot_limit).map_err(
            |error| match error {
                inventory::InventoryError::InventoryFull => "quest interaction inventory full",
                inventory::InventoryError::UnknownItem => "quest interaction unknown item",
                _ => "quest interaction rejected",
            },
        )?;

        // Keep the world-supplied profile fields (notably its current
        // position), but never trust its inventory snapshot: the DB fact is
        // the base and only the missing quantity is added above.
        let mut next_profile = profile.clone();
        next_profile.inventory = next_inventory;
        write_profile(&tx, account_id, &next_profile)?;
        write_inventory_tx(&tx, account_id, &next_profile.inventory)?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(true)
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

    pub fn claim_attack(
        &self,
        account_id: &str,
        map_id: &str,
        request_id: &str,
        action_id: &str,
        event: &str,
    ) -> Result<AttackClaim, String> {
        if map_id.is_empty() {
            return Err("attack map missing".into());
        }
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        let prior: Option<(String, String, i64, String)> = tx
            .query_row(
                "SELECT action_id,event,resolved,map_id FROM attack_actions WHERE account_id=?1 AND request_id=?2",
                params![account_id, request_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|_| "account persistence failed")?;
        if let Some((action_id, event, resolved, prior_map_id)) = prior {
            if resolved == 0 {
                if prior_map_id.is_empty() {
                    return Err("attack request has no bound map".into());
                }
                if prior_map_id != map_id {
                    return Err("attack request map changed".into());
                }
            }
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(AttackClaim {
                action_id,
                event,
                resolved: resolved != 0,
            });
        }
        tx.execute(
            "INSERT INTO attack_actions(account_id,request_id,action_id,event,map_id) VALUES (?1,?2,?3,?4,?5)",
            params![account_id, request_id, action_id, event, map_id],
        )
        .map_err(|_| "account persistence failed")?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(AttackClaim {
            action_id: action_id.to_owned(),
            event: event.to_owned(),
            resolved: false,
        })
    }

    /// Settle one attack without a party: the solo path every caller used
    /// before parties existed, and the entry point the store's own tests use.
    #[allow(dead_code)] // production callers pass a party list; tests use the solo form.
    pub fn resolve_attack(
        &self,
        account_id: &str,
        map_id: &str,
        request_id: &str,
        target_id: Option<&str>,
        damage: i64,
        killed: bool,
        exp_gain: u64,
        target_max_hp: i64,
        drops: &[DropRecord],
        exp_table: &[u64],
        eligible_accounts: &[String],
    ) -> Result<AttackResolution, String> {
        self.resolve_attack_with_party(
            account_id,
            map_id,
            request_id,
            target_id,
            damage,
            killed,
            exp_gain,
            target_max_hp,
            drops,
            exp_table,
            eligible_accounts,
            &[],
        )
    }

    /// Settle one attack, optionally sharing a party EXP bonus.
    ///
    /// `party_members` are the characters the world says are grouped with the
    /// killer *and* standing on the killer's map, already resolved to real
    /// accounts; an empty slice leaves the existing damage-share arithmetic
    /// untouched.  The bonus is granted inside the same transaction as the
    /// kill, so a retry of the same request settles exactly once.
    pub fn resolve_attack_with_party(
        &self,
        account_id: &str,
        map_id: &str,
        request_id: &str,
        target_id: Option<&str>,
        damage: i64,
        killed: bool,
        exp_gain: u64,
        target_max_hp: i64,
        drops: &[DropRecord],
        exp_table: &[u64],
        eligible_accounts: &[String],
        party_members: &[String],
    ) -> Result<AttackResolution, String> {
        if map_id.is_empty() {
            return Err("attack map missing".into());
        }
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        let practice = is_practice_map(map_id);
        let effective_exp_gain = if practice { 0 } else { exp_gain };
        let effective_drops: &[DropRecord] = if practice { &[] } else { drops };
        let prior: Option<StoredResolution> = tx
            .query_row(
                "SELECT map_id,resolved,target_id,damage,killed,exp_gain,drop_id,drop_item_id,drop_quantity,drop_x,drop_y
                 FROM attack_actions WHERE account_id=?1 AND request_id=?2",
                params![account_id, request_id],
                StoredResolution::from_row,
            )
            .optional()
            .map_err(|_| "account persistence failed")?;
        let Some(prior) = prior else {
            return Err("unknown attack request".into());
        };
        if prior.resolved {
            let drops = read_attack_drops(&tx, account_id, request_id, prior.drop)?;
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(AttackResolution {
                already_resolved: true,
                target_id: prior.target_id,
                damage: prior.damage,
                killed: prior.killed,
                exp_gain: prior.exp_gain,
                drop: drops.first().cloned(),
                drops,
                profile: None,
                profiles: Vec::new(),
            });
        }
        if prior.map_id.is_empty() {
            return Err("attack request has no bound map".into());
        }
        if prior.map_id != map_id {
            return Err("attack request map changed".into());
        }

        if let Some(monster_id) = target_id.filter(|_| damage > 0) {
            tx.execute(
                "INSERT INTO monster_damage(monster_id,account_id,damage) VALUES (?1,?2,?3)
                 ON CONFLICT(monster_id,account_id) DO UPDATE SET damage=damage+excluded.damage",
                params![monster_id, account_id, damage],
            )
            .map_err(|_| "account persistence failed")?;
        }

        // A member can be both a damage contributor and a party member; the
        // map keeps one authoritative row per character so the world never has
        // to decide which of two profiles is newer.
        let mut profiles: BTreeMap<String, Profile> = BTreeMap::new();
        let mut awarded_exp = 0u64;
        let mut awarded_drops = Vec::new();
        let mut reward_claimed = false;
        if killed {
            if let Some(monster_id) = target_id {
                let contributions = read_damage_contributions(&tx, monster_id)?;
                let winner = contributions
                    .iter()
                    .max_by(|(a_id, a_damage), (b_id, b_damage)| {
                        a_damage.cmp(b_damage).then_with(|| b_id.cmp(a_id))
                    })
                    .map(|(participant, _)| participant.clone())
                    .unwrap_or_else(|| account_id.to_owned());
                let persisted_exp_gain =
                    i64::try_from(effective_exp_gain).map_err(|_| "account persistence failed")?;
                // Practice rows are encounter facts only.  Any future formal
                // kill/quest counter must query this table with practice=0.
                reward_claimed = tx
                    .execute(
                        "INSERT OR IGNORE INTO monster_rewards(monster_id,account_id,request_id,exp_gain,drop_id,practice)
                         VALUES (?1,?2,?3,?4,?5,?6)",
                        params![
                            monster_id,
                            winner.as_str(),
                            request_id,
                            persisted_exp_gain,
                            effective_drops.first().map(|d| d.id.as_str()),
                            if practice { 1 } else { 0 },
                        ],
                    )
                    .map_err(|_| "account persistence failed")?
                    > 0;
                if reward_claimed {
                    let total_damage = target_max_hp.max(1) as f64;
                    for (participant, contribution) in contributions {
                        if !eligible_accounts.iter().any(|id| id == &participant) {
                            continue;
                        }
                        let share = ((persisted_exp_gain.max(0) as f64)
                            * (contribution.max(0) as f64)
                            / total_damage)
                            .round()
                            .max(0.0) as u64;
                        if share == 0 {
                            continue;
                        }
                        let mut profile = read_profile(&tx, &participant)?;
                        add_exp(&mut profile, share, exp_table);
                        write_profile(&tx, &participant, &profile)?;
                        if participant == account_id {
                            awarded_exp = share;
                        }
                        profiles.insert(participant, profile);
                    }
                    // Party bonus pool.  P: the TMS273 export carries no
                    // party EXP rule, so the bonus is a fixed share of the
                    // monster's authored EXP split by level between the
                    // grouped characters that are actually present — including
                    // members who never hit the monster, which is the reason
                    // to form a party at all.  It sits inside the kill
                    // transaction so a retried request cannot pay it twice.
                    if party_members.len() > 1 && persisted_exp_gain > 0 {
                        let rate = (PARTY_EXP_BONUS_PER_MEMBER * (party_members.len() - 1) as f64)
                            .min(PARTY_EXP_BONUS_CAP);
                        let pool = ((persisted_exp_gain as f64) * rate).round() as u64;
                        if pool > 0 {
                            // Read every grouped character once: it is both the
                            // level weight and the row the new total is written
                            // back into.
                            let mut weights: Vec<(String, u64)> = Vec::new();
                            let mut rows: BTreeMap<String, Profile> = BTreeMap::new();
                            for member in party_members {
                                let profile = match profiles.remove(member) {
                                    Some(profile) => profile,
                                    None => read_profile(&tx, member)?,
                                };
                                weights.push((member.clone(), profile.level.max(1) as u64));
                                rows.insert(member.clone(), profile);
                            }
                            let total_weight: u64 =
                                weights.iter().map(|(_, level)| *level).sum::<u64>().max(1);
                            for (member, level) in weights {
                                let Some(mut profile) = rows.remove(&member) else {
                                    continue;
                                };
                                let share = ((pool as f64) * (level as f64) / total_weight as f64)
                                    .floor() as u64;
                                if share > 0 {
                                    add_exp(&mut profile, share, exp_table);
                                    write_profile(&tx, &member, &profile)?;
                                    if member == account_id {
                                        awarded_exp = awarded_exp.saturating_add(share);
                                    }
                                }
                                profiles.insert(member, profile);
                            }
                        }
                    }
                    let protected_until_ms = now_ms().saturating_add(DROP_PROTECTION_MS);
                    for drop in effective_drops {
                        let mut drop = drop.clone();
                        drop.owner_id = Some(winner.clone());
                        drop.protected_until_ms = protected_until_ms;
                        let stats_json =
                            serde_json::to_string(&drop.stats.clone().unwrap_or_default())
                                .map_err(|_| "account persistence failed")?;
                        let upgrade_count = drop.upgrade_count.unwrap_or(0);
                        let remaining_slots = drop.remaining_slots.unwrap_or(0);
                        tx.execute(
                            "INSERT OR IGNORE INTO drops(id,map_id,item_id,quantity,x,y,owner_account_id,protected_until_ms,
                             stats_json,upgrade_count,remaining_slots,active)
                             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,1)",
                            params![
                                drop.id,
                                map_id,
                                drop.item_id,
                                drop.quantity as i64,
                                drop.x,
                                drop.y,
                                drop.owner_id,
                                drop.protected_until_ms,
                                stats_json,
                                i64::from(upgrade_count),
                                i64::from(remaining_slots),
                            ],
                        )
                        .map_err(|_| "account persistence failed")?;
                        tx.execute(
                            "INSERT OR IGNORE INTO attack_drops(account_id,request_id,drop_id)
                             VALUES (?1,?2,?3)",
                            params![account_id, request_id, drop.id],
                        )
                        .map_err(|_| "account persistence failed")?;
                        awarded_drops.push(drop);
                    }
                }
            }
        }

        let profile = profiles.get(account_id).cloned();
        tx.execute(
            "UPDATE attack_actions SET resolved=1,target_id=?3,damage=?4,killed=?5,exp_gain=?6,
             drop_id=?7,drop_item_id=?8,drop_quantity=?9,drop_x=?10,drop_y=?11
             WHERE account_id=?1 AND request_id=?2",
            params![
                account_id,
                request_id,
                target_id,
                damage,
                if reward_claimed { 1 } else { 0 },
                awarded_exp as i64,
                awarded_drops.first().map(|d| d.id.as_str()),
                awarded_drops.first().map(|d| d.item_id.as_str()),
                awarded_drops.first().map(|d| d.quantity as i64),
                awarded_drops.first().map(|d| d.x),
                awarded_drops.first().map(|d| d.y)
            ],
        )
        .map_err(|_| "account persistence failed")?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(AttackResolution {
            already_resolved: false,
            target_id: target_id.map(str::to_owned),
            damage,
            killed: reward_claimed,
            exp_gain: awarded_exp,
            drop: awarded_drops.first().cloned(),
            drops: awarded_drops,
            profile,
            profiles: profiles.into_iter().collect(),
        })
    }

    pub fn load_drops(&self, map_id: &str) -> Result<Vec<DropRecord>, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        let mut stmt = db
            .prepare("SELECT id,item_id,quantity,x,y,owner_account_id,protected_until_ms,stats_json,upgrade_count,remaining_slots FROM drops WHERE map_id=?1 AND active=1")
            .map_err(|_| "account persistence failed")?;
        let rows = stmt
            .query_map([map_id], |row| {
                Ok(DropRecord {
                    id: row.get(0)?,
                    item_id: row.get(1)?,
                    quantity: row.get::<_, i64>(2)?.try_into().unwrap_or(0),
                    x: row.get(3)?,
                    y: row.get(4)?,
                    owner_id: row.get(5)?,
                    protected_until_ms: row.get(6)?,
                    stats: row
                        .get::<_, String>(7)
                        .ok()
                        .and_then(|json| serde_json::from_str(&json).ok()),
                    upgrade_count: row
                        .get::<_, i64>(8)
                        .ok()
                        .and_then(|value| u32::try_from(value.max(0)).ok()),
                    remaining_slots: row
                        .get::<_, i64>(9)
                        .ok()
                        .and_then(|value| u32::try_from(value.max(0)).ok()),
                })
            })
            .map_err(|_| "account persistence failed")?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| "account persistence failed".into())
    }

    pub fn prior_pickup(
        &self,
        account_id: &str,
        request_id: &str,
    ) -> Result<Option<PickupOutcome>, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        db.query_row(
            "SELECT drop_id,item_id,quantity,slot,success,code FROM pickup_actions
             WHERE account_id=?1 AND request_id=?2",
            params![account_id, request_id],
            |row| {
                Ok(PickupOutcome {
                    drop_id: row.get(0)?,
                    item_id: row.get(1)?,
                    quantity: row.get::<_, i64>(2)?.try_into().unwrap_or(0),
                    slot: row
                        .get::<_, Option<i64>>(3)?
                        .and_then(|slot| slot.try_into().ok()),
                    success: row.get::<_, i64>(4)? != 0,
                    code: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|_| "account persistence failed".into())
    }

    pub fn pickup(
        &self,
        account_id: &str,
        map_id: &str,
        request_id: &str,
        drop_id: &str,
    ) -> Result<PickupOutcome, String> {
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        normalize_inventory_tx(&tx)?;
        normalize_equipped_tx(&tx)?;
        if let Some(prior) = read_pickup_action(&tx, account_id, request_id)? {
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(prior);
        }
        let drop: Option<(
            String,
            i64,
            Option<String>,
            i64,
            String,
            i64,
            i64,
        )> = tx
            .query_row(
                "SELECT item_id,quantity,owner_account_id,protected_until_ms,stats_json,upgrade_count,remaining_slots
                 FROM drops WHERE id=?1 AND map_id=?2 AND active=1",
                params![drop_id, map_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| "account persistence failed")?;
        let (item_id, quantity, slot, success, code) = if let Some((
            item_id,
            quantity,
            owner_id,
            protected_until_ms,
            stats_json,
            upgrade_count,
            remaining_slots,
        )) = drop
        {
            if protected_until_ms > now_ms()
                && owner_id.as_deref().is_some_and(|owner| owner != account_id)
            {
                (item_id, quantity, None, false, "drop_owned".to_owned())
            } else if quantity <= 0 || u32::try_from(quantity).is_err() {
                (item_id, quantity, None, false, "drop_invalid".to_owned())
            } else {
                let quantity_u32 = u32::try_from(quantity).unwrap_or(0);
                // Claim the row before awarding anything.  A second SQLite
                // connection can have read the same active row while the
                // first transaction is still open; making this conditional
                // update the first write guarantees that at most one caller
                // can proceed to reward mutation.
                let claimed = tx
                    .execute(
                        "UPDATE drops SET active=0 WHERE id=?1 AND map_id=?2 AND active=1",
                        params![drop_id, map_id],
                    )
                    .map_err(|_| "account persistence failed")?;
                if claimed != 1 {
                    (
                        item_id,
                        quantity,
                        None,
                        false,
                        "drop_unavailable".to_owned(),
                    )
                } else {
                    let add_result = if item_id == "0" {
                        Ok(Ok(None))
                    } else if inventory::consume_on_pickup(&item_id) {
                        let existing: i64 = tx
                            .query_row(
                                "SELECT COALESCE(quantity,0) FROM monster_book_cards
                                     WHERE account_id=?1 AND item_id=?2",
                                params![account_id, item_id.as_str()],
                                |row| row.get(0),
                            )
                            .optional()
                            .map_err(|_| "account persistence failed")?
                            .unwrap_or(0);
                        // Cosmic consumes every consumeOnPickup card even
                        // after the MonsterBook reaches five copies.  Only
                        // the persisted count saturates at five; the drop is
                        // still claimed successfully.
                        let capped_existing = existing.clamp(0, 5);
                        let accepted = (5 - capped_existing).min(i64::from(quantity_u32));
                        if accepted > 0 {
                            tx.execute(
                                    "INSERT INTO monster_book_cards(account_id,item_id,quantity)
                                     VALUES (?1,?2,?3)
                                     ON CONFLICT(account_id,item_id) DO UPDATE SET quantity=quantity+excluded.quantity",
                                    params![account_id, item_id.as_str(), accepted],
                                )
                                .map_err(|_| "account persistence failed")?;
                        }
                        Ok(Ok(None))
                    } else {
                        let stats = serde_json::from_str::<BTreeMap<String, i64>>(&stats_json).ok();
                        add_inventory_tx(
                            &tx,
                            account_id,
                            &item_id,
                            quantity_u32,
                            stats.as_ref(),
                            u32::try_from(remaining_slots.max(0)).ok(),
                            u32::try_from(upgrade_count.max(0)).ok(),
                        )
                        .map(|result| result.map(Some))
                    };
                    match add_result {
                        Err(error) => return Err(error),
                        Ok(Err(code)) => {
                            // Business-level rejection (full tab or card
                            // cap) must leave the drop available.  Restoring
                            // the claim inside this transaction also keeps
                            // the failure action durable without a reward.
                            let restored = tx
                                .execute(
                                    "UPDATE drops SET active=1 WHERE id=?1 AND map_id=?2 AND active=0",
                                    params![drop_id, map_id],
                                )
                                .map_err(|_| "account persistence failed")?;
                            if restored != 1 {
                                return Err("account persistence failed".to_owned());
                            }
                            (item_id, quantity, None, false, code.to_owned())
                        }
                        Ok(Ok(inventory_slot)) => {
                            if item_id == "0" {
                                tx.execute(
                                    "UPDATE player_stats SET mesos=mesos+?2 WHERE account_id=?1",
                                    params![account_id, quantity],
                                )
                                .map_err(|_| "account persistence failed")?;
                            }
                            (item_id, quantity, inventory_slot, true, String::new())
                        }
                    }
                }
            }
        } else {
            (String::new(), 0, None, false, "drop_unavailable".to_owned())
        };
        tx.execute(
            "INSERT INTO pickup_actions(account_id,request_id,drop_id,item_id,quantity,slot,success,code)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                account_id,
                request_id,
                drop_id,
                item_id,
                quantity,
                slot.map(i64::from),
                if success { 1 } else { 0 },
                code
            ],
        )
        .map_err(|_| "account persistence failed")?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(PickupOutcome {
            drop_id: drop_id.to_owned(),
            item_id,
            quantity: quantity.try_into().unwrap_or(0),
            slot,
            success,
            code,
        })
    }

    pub fn prior_inventory(
        &self,
        account_id: &str,
        request_id: &str,
    ) -> Result<Option<InventoryOutcome>, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        db.query_row(
            "SELECT request_id,operation,inventory_type,from_slot,to_slot,item_id,quantity,drop_id,success,code
             FROM inventory_actions WHERE account_id=?1 AND request_id=?2",
            params![account_id, request_id],
            inventory_outcome_from_row,
        )
        .optional()
        .map_err(|_| "account persistence failed".into())
    }

    pub fn load_equipped(&self, account_id: &str) -> Result<Vec<InventoryItem>, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        read_equipped_db(&db, account_id)
    }

    pub fn load_monster_book(&self, account_id: &str) -> Result<BTreeMap<String, u8>, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        let mut stmt = db
            .prepare(
                "SELECT item_id,quantity FROM monster_book_cards
                 WHERE account_id=?1 AND quantity>0 ORDER BY item_id",
            )
            .map_err(|_| "account persistence failed")?;
        let collected = {
            let result = stmt.query_map([account_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?.try_into().unwrap_or(0),
                ))
            });
            result
                .map_err(|_| "account persistence failed")?
                .collect::<Result<BTreeMap<_, _>, _>>()
                .map_err(|_| "account persistence failed".to_owned())?
        };
        Ok(collected)
    }

    pub fn move_inventory(
        &self,
        account_id: &str,
        request_id: &str,
        inventory_type: u8,
        from_slot: i16,
        to_slot: i16,
        quantity: u32,
        stats: EquipmentStats,
    ) -> Result<InventoryOutcome, String> {
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        normalize_inventory_tx(&tx)?;
        normalize_equipped_tx(&tx)?;
        if let Some(prior) = read_inventory_action(&tx, account_id, request_id)? {
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(prior);
        }
        let mut inventory = read_inventory_tx(&tx, account_id)?;
        let mut equipped = read_equipped_tx(&tx, account_id)?;
        let inventory_slots = read_inventory_slots_tx(&tx, account_id)
            .map_err(|_| "account persistence failed".to_owned())?;
        let slot_limit = inventory_slots
            .get(&inventory_type)
            .copied()
            .unwrap_or(inventory::SLOT_LIMIT);
        let item_id = if inventory_type == 1 && inventory::valid_equipment_slot(from_slot) {
            equipped
                .iter()
                .find(|item| item.slot == from_slot.unsigned_abs())
                .map(|item| item.item_id.clone())
        } else {
            inventory
                .iter()
                .find(|item| {
                    item.slot == u16::try_from(from_slot).unwrap_or(0)
                        && inventory::inventory_type(&item.item_id) == Some(inventory_type)
                })
                .map(|item| item.item_id.clone())
        }
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
        let mutation = if operation == "equip" {
            inventory::equip_items(&mut inventory, &mut equipped, stats, from_slot, to_slot, slot_limit)
        } else if operation == "unequip" {
            inventory::unequip_items(&mut inventory, &mut equipped, from_slot, to_slot, slot_limit)
        } else {
            inventory::move_items(&mut inventory, inventory_type, from_slot, to_slot, quantity)
                .map(|()| (item_id.clone(), quantity))
        };
        let (success, code, result_quantity) = match mutation {
            Ok((_id, amount)) => {
                write_inventory_tx(&tx, account_id, &inventory)?;
                write_equipped_tx(&tx, account_id, &equipped)?;
                (true, String::new(), amount)
            }
            Err(error) => (false, error.code().to_owned(), quantity),
        };
        let outcome = InventoryOutcome {
            request_id: request_id.to_owned(),
            operation: operation.to_owned(),
            inventory_type: Some(inventory_type),
            from_slot,
            to_slot: Some(to_slot),
            item_id,
            quantity: result_quantity,
            drop_id: None,
            success,
            code,
        };
        insert_inventory_action(&tx, account_id, &outcome)?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(outcome)
    }

    pub fn gather_inventory(
        &self,
        account_id: &str,
        request_id: &str,
        inventory_type: u8,
    ) -> Result<InventoryOutcome, String> {
        self.compact_inventory(account_id, request_id, inventory_type, false)
    }

    pub fn sort_inventory(
        &self,
        account_id: &str,
        request_id: &str,
        inventory_type: u8,
    ) -> Result<InventoryOutcome, String> {
        self.compact_inventory(account_id, request_id, inventory_type, true)
    }

    fn compact_inventory(
        &self,
        account_id: &str,
        request_id: &str,
        inventory_type: u8,
        sort: bool,
    ) -> Result<InventoryOutcome, String> {
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        normalize_inventory_tx(&tx)?;
        normalize_equipped_tx(&tx)?;
        if let Some(prior) = read_inventory_action(&tx, account_id, request_id)? {
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(prior);
        }
        let mut inventory = read_inventory_tx(&tx, account_id)?;
        let mutation = if sort {
            if inventory::valid_inventory_type(inventory_type) {
                inventory::sort_category(&mut inventory, inventory_type);
                Ok(())
            } else {
                Err(inventory::InventoryError::InvalidInventoryType)
            }
        } else {
            inventory::gather_items(&mut inventory, inventory_type)
        };
        let (success, code) = match mutation {
            Ok(()) => {
                write_inventory_tx(&tx, account_id, &inventory)?;
                (true, String::new())
            }
            Err(error) => (false, error.code().to_owned()),
        };
        let outcome = InventoryOutcome {
            request_id: request_id.to_owned(),
            operation: if sort { "sort" } else { "gather" }.to_owned(),
            inventory_type: Some(inventory_type),
            from_slot: 0,
            to_slot: None,
            item_id: String::new(),
            quantity: 0,
            drop_id: None,
            success,
            code,
        };
        insert_inventory_action(&tx, account_id, &outcome)?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(outcome)
    }

    #[cfg(test)]
    pub fn use_item(
        &self,
        account_id: &str,
        request_id: &str,
        inventory_type: u8,
        source_slot: i16,
        item_id: &str,
        target_slot: Option<i16>,
        target_item_id: Option<&str>,
        stats: EquipmentStats,
    ) -> Result<InventoryOutcome, String> {
        self.use_item_with_max_mp(
            account_id,
            request_id,
            inventory_type,
            source_slot,
            item_id,
            target_slot,
            target_item_id,
            stats,
            None,
        )
    }

    /// Inventory use with the world's derived MP cap.  `player_stats.max_mp`
    /// stores the unmodified baseline, while a Mage's snapshot cap includes
    /// equipment and Magic Boost; the optional cap keeps potion application
    /// atomic without persisting the derived value as a new baseline.
    pub fn use_item_with_max_mp(
        &self,
        account_id: &str,
        request_id: &str,
        inventory_type: u8,
        source_slot: i16,
        item_id: &str,
        target_slot: Option<i16>,
        target_item_id: Option<&str>,
        stats: EquipmentStats,
        max_mp_override: Option<i64>,
    ) -> Result<InventoryOutcome, String> {
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        normalize_inventory_tx(&tx)?;
        normalize_equipped_tx(&tx)?;
        if let Some(prior) = read_inventory_action(&tx, account_id, request_id)? {
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(prior);
        }
        let mut inventory = read_inventory_tx(&tx, account_id)?;
        let mut equipped = read_equipped_tx(&tx, account_id)?;
        let inventory_slots = read_inventory_slots_tx(&tx, account_id)
            .map_err(|_| "account persistence failed".to_owned())?;
        let equip_slot_limit = inventory_slots
            .get(&1)
            .copied()
            .unwrap_or(inventory::SLOT_LIMIT);
        let result_item = item_id.to_owned();
        let result_quantity = 1;
        let mut operation = "use".to_owned();
        let mut result_code = None;
        let mutation: Result<(), inventory::InventoryError> = if inventory_type == 1 {
            if inventory::valid_slot(source_slot) {
                if target_slot.is_some() || target_item_id.is_some() {
                    Err(inventory::InventoryError::InvalidEquipmentSlot)
                } else if inventory
                    .iter()
                    .position(|item| {
                        item.slot == u16::try_from(source_slot).unwrap_or(0)
                            && inventory::inventory_type(&item.item_id) == Some(1)
                            && item.item_id == item_id
                    })
                    .is_none()
                {
                    Err(inventory::InventoryError::SourceEmpty)
                } else if let Some(expected) = inventory::equipment_slot(item_id) {
                    operation = "equip".to_owned();
                    inventory::equip_items(
                        &mut inventory,
                        &mut equipped,
                        stats,
                        source_slot,
                        expected,
                        equip_slot_limit,
                    )
                    .map(|_| ())
                } else {
                    Err(inventory::InventoryError::UnknownItem)
                }
            } else if inventory::valid_equipment_slot(source_slot) {
                if target_slot.is_some() || target_item_id.is_some() {
                    Err(inventory::InventoryError::InvalidEquipmentSlot)
                } else if equipped
                    .iter()
                    .all(|item| item.slot != source_slot.unsigned_abs() || item.item_id != item_id)
                {
                    Err(inventory::InventoryError::SourceEmpty)
                } else {
                    let destination = (1..=equip_slot_limit as i16).find(|slot| {
                        inventory.iter().all(|item| {
                            !(item.slot == u16::try_from(*slot).unwrap_or(0)
                                && inventory::inventory_type(&item.item_id) == Some(1))
                        })
                    });
                    match destination {
                        Some(destination) => {
                            operation = "unequip".to_owned();
                            inventory::unequip_items(
                                &mut inventory,
                                &mut equipped,
                                source_slot,
                                destination,
                                equip_slot_limit,
                            )
                            .map(|_| ())
                        }
                        None => Err(inventory::InventoryError::InventoryFull),
                    }
                }
            } else {
                Err(inventory::InventoryError::InvalidEquipmentSlot)
            }
        } else if inventory_type == 2 && inventory::valid_slot(source_slot) {
            let source_exists = inventory.iter().any(|item| {
                item.slot == u16::try_from(source_slot).unwrap_or(0)
                    && inventory::inventory_type(&item.item_id) == Some(2)
                    && item.item_id == item_id
            });
            if !source_exists {
                Err(inventory::InventoryError::SourceEmpty)
            } else if let Some(target_tab) = inventory::slot_expand_target(item_id) {
                // A slot-expansion coupon grows one tab by `SLOT_EXPAND_STEP`
                // slots and is consumed on use.  The capacity is a durable
                // per-tab value, updated in the same transaction that spends
                // the coupon, so a rejected (already-at-cap) use spends nothing
                // and a replayed request never expands twice.
                let capacity = inventory_slots
                    .get(&target_tab)
                    .copied()
                    .unwrap_or(inventory::SLOT_LIMIT);
                let grown = capacity.saturating_add(inventory::SLOT_EXPAND_STEP);
                if grown > inventory::MAX_SLOT_LIMIT {
                    Err(inventory::InventoryError::SlotExpandMax)
                } else {
                    let mut slots = inventory_slots.clone();
                    slots.insert(target_tab, grown);
                    write_inventory_slots_tx(&tx, account_id, &slots)
                        .and_then(|_| inventory::remove_items(&mut inventory, 2, source_slot, 1))
                        .map(|_| {
                            result_code = Some("slot_expand");
                        })
                }
            } else if let Ok(effect) = inventory::use_effect(item_id) {
                // A percentage (`hpR`/`mpR`) potion heals a share of the
                // body's own pool, so the concrete amount has to be resolved
                // against the row's authored maxima inside the same
                // transaction that spends the item.  `max_mp_override` carries
                // the Mage's derived cap (equipment + Magic Boost) so the
                // potion heals what the player actually sees, without that
                // derived value ever being persisted as a new baseline.
                let (max_hp, base_max_mp): (i64, i64) = tx
                    .query_row(
                        "SELECT max_hp,max_mp FROM player_stats WHERE account_id=?1",
                        params![account_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .map_err(|_| "account persistence failed".to_owned())?;
                let (hp, mp) = effect.resolve(max_hp, max_mp_override.unwrap_or(base_max_mp));
                inventory::remove_items(&mut inventory, 2, source_slot, 1).and_then(|_| {
                    let changed = tx
                        .execute(
                            "UPDATE player_stats SET hp=MIN(max_hp,hp+?2),mp=MIN(COALESCE(?4,max_mp),mp+?3)
                                 WHERE account_id=?1",
                            params![account_id, hp, mp, max_mp_override],
                        )
                        .map_err(|_| inventory::InventoryError::QuantityOverflow)?;
                    (changed == 1)
                        .then_some(())
                        .ok_or(inventory::InventoryError::QuantityOverflow)
                })
            } else if inventory::scroll_effect(item_id).is_some() {
                let mut next_inventory = inventory.clone();
                match inventory::remove_items(&mut next_inventory, 2, source_slot, 1).and_then(
                    |_| apply_scroll_tx(&tx, account_id, item_id, target_slot, target_item_id),
                ) {
                    Ok(applied) => {
                        inventory = next_inventory;
                        result_code = Some(if applied {
                            "scroll_success"
                        } else {
                            "scroll_failed"
                        });
                        Ok(())
                    }
                    Err(error) => Err(error),
                }
            } else if inventory::move_target(item_id).is_some() {
                // A map-move consumable spends exactly one unit here, and only
                // here: *where* the body lands is the world's decision, and the
                // world has already proven the destination is reachable before
                // it asks for the item to be spent.  A scroll with nowhere to
                // go is therefore refused by the caller and never reaches this
                // branch — the item can never be paid for nothing.
                inventory::remove_items(&mut inventory, 2, source_slot, 1).map(|_| {
                    result_code = Some("map_move");
                })
            } else {
                Err(inventory::InventoryError::ItemNotUsable)
            }
        } else {
            Err(inventory::InventoryError::InvalidInventoryType)
        };
        let (success, code) = match mutation {
            Ok(()) => {
                write_inventory_tx(&tx, account_id, &inventory)?;
                if inventory_type == 1 {
                    write_equipped_tx(&tx, account_id, &equipped)?;
                }
                (true, result_code.unwrap_or_default().to_owned())
            }
            Err(error) => (false, error.code().to_owned()),
        };
        let outcome = InventoryOutcome {
            request_id: request_id.to_owned(),
            operation,
            inventory_type: Some(inventory_type),
            from_slot: source_slot,
            to_slot: target_slot,
            item_id: result_item,
            quantity: result_quantity,
            drop_id: None,
            success,
            code,
        };
        insert_inventory_action(&tx, account_id, &outcome)?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(outcome)
    }

    pub fn drop_mesos(
        &self,
        account_id: &str,
        map_id: &str,
        request_id: &str,
        quantity: u32,
        x: f64,
        y: f64,
    ) -> Result<InventoryOutcome, String> {
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        if let Some(prior) = read_inventory_action(&tx, account_id, request_id)? {
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(prior);
        }
        let mut drop_id = None;
        let (success, code) = if !(10..=50_000).contains(&quantity) {
            (false, "invalid_quantity".to_owned())
        } else if !x.is_finite() || !y.is_finite() {
            (false, "invalid_position".to_owned())
        } else {
            let changed = tx
                .execute(
                    "UPDATE player_stats SET mesos=mesos-?2
                     WHERE account_id=?1 AND mesos>=?2",
                    params![account_id, i64::from(quantity)],
                )
                .map_err(|_| "account persistence failed")?;
            if changed != 1 {
                (false, "mesos_insufficient".to_owned())
            } else {
                let id = random_id();
                tx.execute(
                    "INSERT INTO drops(id,map_id,item_id,quantity,x,y,owner_account_id,protected_until_ms,active)
                     VALUES (?1,?2,'0',?3,?4,?5,NULL,0,1)",
                    params![id, map_id, i64::from(quantity), x, y],
                )
                .map_err(|_| "account persistence failed")?;
                drop_id = Some(id);
                (true, String::new())
            }
        };
        let outcome = InventoryOutcome {
            request_id: request_id.to_owned(),
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
        insert_inventory_action(&tx, account_id, &outcome)?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(outcome)
    }

    pub fn drop_inventory(
        &self,
        account_id: &str,
        map_id: &str,
        request_id: &str,
        inventory_type: u8,
        from_slot: i16,
        quantity: u32,
        x: f64,
        y: f64,
    ) -> Result<InventoryOutcome, String> {
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        normalize_inventory_tx(&tx)?;
        normalize_equipped_tx(&tx)?;
        if let Some(prior) = read_inventory_action(&tx, account_id, request_id)? {
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(prior);
        }
        let mut inventory = read_inventory_tx(&tx, account_id)?;
        let source = inventory
            .iter()
            .find(|item| {
                item.slot == u16::try_from(from_slot).unwrap_or(0)
                    && inventory::inventory_type(&item.item_id) == Some(inventory_type)
            })
            .cloned();
        let source_item = source
            .as_ref()
            .map(|item| item.item_id.clone())
            .unwrap_or_default();
        let stored_quantity = source.as_ref().map(|item| item.quantity).unwrap_or(0);
        let mutation = if !inventory::valid_inventory_type(inventory_type)
            || !inventory::valid_slot(from_slot)
        {
            Err(inventory::InventoryError::InvalidSlot)
        } else if !x.is_finite() || !y.is_finite() {
            Err(inventory::InventoryError::InvalidSlot)
        } else {
            inventory::remove_items(&mut inventory, inventory_type, from_slot, quantity).map(|_| ())
        };
        let mut drop_id = None;
        let (success, code) = match mutation {
            Ok(()) => {
                write_inventory_tx(&tx, account_id, &inventory)?;
                if !inventory::is_drop_restricted(&source_item) {
                    let id = random_id();
                    let stats_json = serde_json::to_string(
                        &source
                            .as_ref()
                            .and_then(|item| item.stats.clone())
                            .unwrap_or_default(),
                    )
                    .map_err(|_| "account persistence failed")?;
                    let upgrade_count = source
                        .as_ref()
                        .and_then(|item| item.upgrade_count)
                        .unwrap_or(0);
                    let remaining_slots = source
                        .as_ref()
                        .and_then(|item| item.remaining_slots)
                        .unwrap_or(0);
                    tx.execute(
                        "INSERT INTO drops(id,map_id,item_id,quantity,x,y,owner_account_id,protected_until_ms,
                         stats_json,upgrade_count,remaining_slots,active)
                         VALUES (?1,?2,?3,?4,?5,?6,NULL,0,?7,?8,?9,1)",
                        params![
                            id,
                            map_id,
                            source_item,
                            i64::from(quantity),
                            x,
                            y,
                            stats_json,
                            i64::from(upgrade_count),
                            i64::from(remaining_slots),
                        ],
                    )
                    .map_err(|_| "account persistence failed")?;
                    drop_id = Some(id);
                }
                (true, String::new())
            }
            Err(error) => (false, error.code().to_owned()),
        };
        let outcome = InventoryOutcome {
            request_id: request_id.to_owned(),
            operation: "drop".to_owned(),
            inventory_type: Some(inventory_type),
            from_slot,
            to_slot: None,
            item_id: source_item,
            quantity: if success { quantity } else { stored_quantity },
            drop_id,
            success,
            code,
        };
        insert_inventory_action(&tx, account_id, &outcome)?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(outcome)
    }

    pub fn load_drop(&self, map_id: &str, drop_id: &str) -> Result<Option<DropRecord>, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        db.query_row(
            "SELECT id,item_id,quantity,x,y,owner_account_id,protected_until_ms,stats_json,upgrade_count,remaining_slots FROM drops
             WHERE id=?1 AND map_id=?2 AND active=1",
            params![drop_id, map_id],
            |row| {
                Ok(DropRecord {
                    id: row.get(0)?,
                    item_id: row.get(1)?,
                    quantity: row.get::<_, i64>(2)?.try_into().unwrap_or(0),
                    x: row.get(3)?,
                    y: row.get(4)?,
                    owner_id: row.get(5)?,
                    protected_until_ms: row.get(6)?,
                    stats: row
                        .get::<_, String>(7)
                        .ok()
                        .and_then(|json| serde_json::from_str(&json).ok()),
                    upgrade_count: row
                        .get::<_, i64>(8)
                        .ok()
                        .and_then(|value| u32::try_from(value.max(0)).ok()),
                    remaining_slots: row
                        .get::<_, i64>(9)
                        .ok()
                        .and_then(|value| u32::try_from(value.max(0)).ok()),
                })
            },
        )
        .optional()
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
        let (success, code, item_id, moved) = match operation {
            StorageOperation::Deposit => {
                match peek_inventory_stack(&tx, account_id, inventory_type, slot, quantity)? {
                    Err(reason) => (false, reason, String::new(), 0),
                    Ok(stack) => {
                        if let Err(reason) =
                            reserve_storage_slot(&tx, account_id, &stack.item_id, stack.quantity)
                        {
                            (false, reason, stack.item_id, 0)
                        } else {
                            take_inventory_stack(&tx, account_id, inventory_type, slot, quantity)?;
                            insert_storage_stack(&tx, account_id, &stack)?;
                            (true, String::new(), stack.item_id, stack.quantity)
                        }
                    }
                }
            }
            StorageOperation::Withdraw => {
                match peek_storage_stack(&tx, account_id, slot, quantity)? {
                    Err(reason) => (false, reason, String::new(), 0),
                    Ok(stack) => {
                        if !inventory_has_room(&tx, account_id, &stack)? {
                            (false, "inventory_full".to_owned(), stack.item_id, 0)
                        } else {
                            take_storage_stack(&tx, account_id, slot, quantity)?;
                            add_inventory_tx(
                                &tx,
                                account_id,
                                &stack.item_id,
                                stack.quantity,
                                stack.stats.as_ref(),
                                stack.remaining_slots,
                                stack.upgrade_count,
                            )
                            .map_err(|error| error)?
                            .map_err(|reason| reason.to_owned())?;
                            (true, String::new(), stack.item_id, stack.quantity)
                        }
                    }
                }
            }
        };
        let outcome = StorageOutcome {
            request_id: request_id.to_owned(),
            operation,
            inventory_type,
            slot,
            item_id,
            quantity: moved,
            success,
            code,
        };
        insert_storage_action(&tx, account_id, &outcome)?;
        if success {
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

    /// Account-scoped friend list, joined against `accounts` and
    /// `player_stats` so an offline friend's display name, level and job come
    /// straight from the persisted profile.  The online flag is a session
    /// fact the world layer derives, not a persisted column.
    pub fn load_friends(&self, account_id: &str) -> Result<Vec<FriendRow>, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        read_friend_rows(&db, "friends", account_id)
    }

    /// Account-scoped blacklist.  Same join as `load_friends`; the caller
    /// tells the two apart because the result feeds a different window tab.
    pub fn load_blacklist(&self, account_id: &str) -> Result<Vec<FriendRow>, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        read_friend_rows(&db, "blacklist", account_id)
    }

    /// Resolve a typed character name to a persisted character.  Used by
    /// `FriendAdd` and `FriendBlock`, which accept a typed name (the source
    /// context-menu only carries the name, never the id).
    pub fn find_character_by_name(&self, name: &str) -> Result<Option<FriendRow>, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        let mut stmt = db
            .prepare(
                "SELECT a.id, a.username, COALESCE(p.level, 1), COALESCE(p.job, 0)
                 FROM accounts a LEFT JOIN player_stats p ON p.account_id = a.id
                 WHERE a.username = ?1 LIMIT 1",
            )
            .map_err(|_| "account persistence failed")?;
        let mut rows = stmt
            .query([name])
            .map_err(|_| "account persistence failed")?;
        Ok(
            match rows.next().map_err(|_| "account persistence failed")? {
                Some(row) => Some(FriendRow {
                    id: row.get(0).map_err(|_| "account persistence failed")?,
                    name: row.get(1).map_err(|_| "account persistence failed")?,
                    level: row.get(2).map_err(|_| "account persistence failed")?,
                    job: row.get(3).map_err(|_| "account persistence failed")?,
                }),
                None => None,
            },
        )
    }

    /// One authoritative friend / blacklist transaction.  All four
    /// `FriendOperation` cases share the same shape: re-check every guard
    /// *before* writing, record the outcome in `friend_actions` so a replayed
    /// `requestId` never re-acts, and commit only the rows that are actually
    /// valid.  The world layer is responsible for `requestId` validation and
    /// for turning the returned `code` into a wire message.
    ///
    /// `Add` writes the pair in both directions (the friend row is symmetric
    /// in the original) and refuses when the target has put us on their
    /// blacklist, so a relationship cannot be forced across an explicit
    /// refusal.  `Block` also dissolves any existing friendship both ways,
    /// matching the source context-menu behaviour.
    pub fn friend_edit(
        &self,
        account_id: &str,
        request_id: &str,
        operation: FriendOperation,
        target_id: &str,
    ) -> Result<FriendOutcome, String> {
        if account_id == target_id {
            return Ok(FriendOutcome::reject(operation, target_id, "friend_self"));
        }
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        if let Some(prior) = read_friend_action(&tx, account_id, request_id)? {
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(prior);
        }
        let (table, column, limit) = match operation {
            FriendOperation::Add | FriendOperation::Remove => {
                ("friends", "friend_id", FRIEND_LIMIT)
            }
            FriendOperation::Block | FriendOperation::Unblock => {
                ("blacklist", "blocked_id", BLACKLIST_LIMIT)
            }
        };
        let count: i64 = tx
            .query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE account_id=?1"),
                [account_id],
                |row| row.get(0),
            )
            .map_err(|_| "account persistence failed")?;
        let already: bool = tx
            .query_row(
                &format!(
                    "SELECT EXISTS(SELECT 1 FROM {table} WHERE account_id=?1 AND {column}=?2)"
                ),
                rusqlite::params![account_id, target_id],
                |row| row.get(0),
            )
            .map_err(|_| "account persistence failed")?;
        let mut success = true;
        let mut code = String::new();
        match operation {
            FriendOperation::Add => {
                if already {
                    success = false;
                    code = "friend_already".into();
                } else if count >= limit {
                    success = false;
                    code = "friend_full".into();
                } else {
                    let target_blocked: bool = tx
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM blacklist WHERE account_id=?1 AND blocked_id=?2)",
                            rusqlite::params![target_id, account_id],
                            |row| row.get(0),
                        )
                        .map_err(|_| "account persistence failed")?;
                    if target_blocked {
                        success = false;
                        code = "friend_declined".into();
                    } else {
                        tx.execute(
                            "INSERT OR IGNORE INTO friends(account_id,friend_id) VALUES(?1,?2)",
                            rusqlite::params![account_id, target_id],
                        )
                        .map_err(|_| "account persistence failed")?;
                        tx.execute(
                            "INSERT OR IGNORE INTO friends(account_id,friend_id) VALUES(?1,?2)",
                            rusqlite::params![target_id, account_id],
                        )
                        .map_err(|_| "account persistence failed")?;
                    }
                }
            }
            FriendOperation::Remove => {
                if !already {
                    success = false;
                    code = "friend_not_friend".into();
                } else {
                    tx.execute(
                        "DELETE FROM friends WHERE account_id=?1 AND friend_id=?2",
                        rusqlite::params![account_id, target_id],
                    )
                    .map_err(|_| "account persistence failed")?;
                    tx.execute(
                        "DELETE FROM friends WHERE account_id=?1 AND friend_id=?2",
                        rusqlite::params![target_id, account_id],
                    )
                    .map_err(|_| "account persistence failed")?;
                }
            }
            FriendOperation::Block => {
                if already {
                    success = false;
                    code = "friend_already".into();
                } else if count >= limit {
                    success = false;
                    code = "friend_full".into();
                } else {
                    tx.execute(
                        "INSERT OR IGNORE INTO blacklist(account_id,blocked_id) VALUES(?1,?2)",
                        rusqlite::params![account_id, target_id],
                    )
                    .map_err(|_| "account persistence failed")?;
                    tx.execute(
                        "DELETE FROM friends WHERE account_id=?1 AND friend_id=?2",
                        rusqlite::params![account_id, target_id],
                    )
                    .map_err(|_| "account persistence failed")?;
                    tx.execute(
                        "DELETE FROM friends WHERE account_id=?1 AND friend_id=?2",
                        rusqlite::params![target_id, account_id],
                    )
                    .map_err(|_| "account persistence failed")?;
                }
            }
            FriendOperation::Unblock => {
                if !already {
                    success = false;
                    code = "friend_not_blocked".into();
                } else {
                    tx.execute(
                        "DELETE FROM blacklist WHERE account_id=?1 AND blocked_id=?2",
                        rusqlite::params![account_id, target_id],
                    )
                    .map_err(|_| "account persistence failed")?;
                }
            }
        }
        let outcome = FriendOutcome {
            request_id: request_id.to_owned(),
            operation,
            target_id: target_id.to_owned(),
            success,
            code,
        };
        insert_friend_action(&tx, account_id, &outcome)?;
        if success {
            tx.commit().map_err(|_| "account persistence failed")?;
        } else {
            tx.rollback().map_err(|_| "account persistence failed")?;
        }
        Ok(outcome)
    }
}

// ----------------------------------------------------------------------- friends

/// Authoritative friend-list and blacklist upper bounds.  The original client
/// window scrolls on overflow, so a real cap exists, but the source file
/// carried no `maxFriendList` / `maxBlackList` field for the slice we
/// verified; the numbers here are P values copied from the documented
/// 50 / 20 caps common to early-273 servers.
const FRIEND_LIMIT: i64 = 50;
const BLACKLIST_LIMIT: i64 = 20;

/// One row of a friend or blacklist view: the persisted identity (id + name)
/// and the most recent profile snapshot (level + job).  `online` and `mapId`
/// are *not* persisted here — they are session facts the world layer
/// derives on every push, so an offline snapshot is allowed to lag behind
/// the live character.
#[derive(Clone, Debug)]
pub struct FriendRow {
    pub id: String,
    pub name: String,
    pub level: i64,
    pub job: i64,
}

/// What the client asked for, in the storage-side enum form.  The wire
/// `type` discriminator lives in `protocol::ClientMessage`; the world layer
/// is the only place that maps one to the other.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FriendOperation {
    Add,
    Remove,
    Block,
    Unblock,
}

/// Result of one friend / blacklist intent, persisted so a retried
/// `requestId` re-sends the original outcome instead of re-acting.
#[derive(Clone, Debug)]
pub struct FriendOutcome {
    pub request_id: String,
    pub operation: FriendOperation,
    pub target_id: String,
    pub success: bool,
    pub code: String,
}

impl FriendOutcome {
    /// Construct a refused outcome that was rejected before any transaction
    /// was opened.  `friend_self` is the only code that reaches this path —
    /// every other check is a real DB read.
    fn reject(operation: FriendOperation, target_id: &str, code: &str) -> Self {
        Self {
            request_id: String::new(),
            operation,
            target_id: target_id.to_owned(),
            success: false,
            code: code.to_owned(),
        }
    }
}

/// Read every row of `table` (`friends` or `blacklist`) for `account_id`,
/// joined against `accounts` and `player_stats` so the world layer can
/// render an offline friend without a second round-trip.  The two tables
/// share an identical column shape, so a single helper handles both.
fn read_friend_rows(
    db: &Connection,
    table: &str,
    account_id: &str,
) -> Result<Vec<FriendRow>, String> {
    let column = if table == "friends" {
        "friend_id"
    } else {
        "blocked_id"
    };
    let mut stmt = db
        .prepare(&format!(
            "SELECT a.id, a.username, COALESCE(p.level, 1), COALESCE(p.job, 0)
                 FROM {table} f
                 JOIN accounts a ON a.id = f.{column}
                 LEFT JOIN player_stats p ON p.account_id = f.{column}
                 WHERE f.account_id = ?1
                 ORDER BY a.username COLLATE NOCASE"
        ))
        .map_err(|_| "account persistence failed")?;
    let rows = stmt
        .query_map([account_id], |row| {
            Ok(FriendRow {
                id: row.get(0)?,
                name: row.get(1)?,
                level: row.get(2)?,
                job: row.get(3)?,
            })
        })
        .map_err(|_| "account persistence failed")?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|_| "account persistence failed")?);
    }
    Ok(out)
}

/// Replay guard for friend / blacklist intents.  Returns the recorded
/// outcome if the `(account, request_id)` pair was already processed, so a
/// retried client packet never writes twice.
fn read_friend_action(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    request_id: &str,
) -> Result<Option<FriendOutcome>, String> {
    let row: Option<(String, String, i64, String)> = tx
        .query_row(
            "SELECT operation, target_id, success, code FROM friend_actions
             WHERE account_id=?1 AND request_id=?2",
            rusqlite::params![account_id, request_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|_| "account persistence failed")?;
    let Some((operation, target_id, success, code)) = row else {
        return Ok(None);
    };
    Ok(Some(FriendOutcome {
        request_id: request_id.to_owned(),
        operation: parse_friend_operation(&operation),
        target_id,
        success: success != 0,
        code,
    }))
}

/// Persist a friend / blacklist outcome.  Both the success and the refused
/// rows go in the same table, so a replayed intent returns the exact code
/// the original request produced.
fn insert_friend_action(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    outcome: &FriendOutcome,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO friend_actions(account_id,request_id,operation,target_id,success,code)
         VALUES(?1,?2,?3,?4,?5,?6)",
        rusqlite::params![
            account_id,
            outcome.request_id,
            friend_operation_str(outcome.operation),
            outcome.target_id,
            if outcome.success { 1 } else { 0 },
            outcome.code,
        ],
    )
    .map_err(|_| "account persistence failed")?;
    Ok(())
}

fn friend_operation_str(operation: FriendOperation) -> &'static str {
    match operation {
        FriendOperation::Add => "add",
        FriendOperation::Remove => "remove",
        FriendOperation::Block => "block",
        FriendOperation::Unblock => "unblock",
    }
}

fn parse_friend_operation(value: &str) -> FriendOperation {
    match value {
        "remove" => FriendOperation::Remove,
        "block" => FriendOperation::Block,
        "unblock" => FriendOperation::Unblock,
        _ => FriendOperation::Add,
    }
}

fn read_storage_db(db: &Connection, account_id: &str) -> Result<Vec<InventoryItem>, String> {
    let mut stmt = db
        .prepare(
            "SELECT slot,item_id,quantity,stats_json,upgrade_count,remaining_slots FROM storage
             WHERE account_id=?1 AND quantity>0 ORDER BY slot",
        )
        .map_err(|_| "account persistence failed")?;
    let collected = {
        let result = stmt.query_map([account_id], |row| {
            let mut item = InventoryItem {
                slot: row.get::<_, i64>(0)?.try_into().unwrap_or(0),
                item_id: row.get(1)?,
                quantity: row.get::<_, i64>(2)?.try_into().unwrap_or(0),
                stats: row
                    .get::<_, String>(3)
                    .ok()
                    .and_then(|json| serde_json::from_str(&json).ok()),
                upgrade_count: row
                    .get::<_, i64>(4)
                    .ok()
                    .and_then(|value| u32::try_from(value.max(0)).ok()),
                remaining_slots: row
                    .get::<_, i64>(5)
                    .ok()
                    .and_then(|value| u32::try_from(value.max(0)).ok()),
            };
            // A deposited weapon keeps the exact instance stats it was created
            // with, so round-tripping through the warehouse must not reset a
            // scroll's upgrades.
            inventory::ensure_equipment_instance(&mut item);
            Ok(item)
        });
        result
            .map_err(|_| "account persistence failed")?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "account persistence failed".to_owned())?
    };
    Ok(collected)
}

/// One stack read out of either side of a transfer, with the instance fields
/// that must survive the trip unchanged.
struct StorageStack {
    item_id: String,
    quantity: u32,
    stats: Option<BTreeMap<String, i64>>,
    upgrade_count: Option<u32>,
    remaining_slots: Option<u32>,
}

/// Read one inventory stack and check it can supply `quantity`.  Nothing is
/// mutated, so a refusal later in the same transaction costs nothing.
fn peek_inventory_stack(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    inventory_type: u8,
    slot: i16,
    quantity: u32,
) -> Result<Result<StorageStack, String>, String> {
    if !inventory::valid_slot(slot) {
        return Ok(Err("invalid_slot".to_owned()));
    }
    if quantity == 0 {
        return Ok(Err("invalid_quantity".to_owned()));
    }
    let row: Option<(String, i64, String, i64, i64)> = tx
        .query_row(
            "SELECT item_id,quantity,stats_json,upgrade_count,remaining_slots FROM inventory
             WHERE account_id=?1 AND inventory_type=?2 AND slot=?3",
            params![account_id, inventory_type, slot],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()
        .map_err(|_| "account persistence failed")?;
    let Some((item_id, available, stats_json, upgrade, remaining)) = row else {
        return Ok(Err("source_empty".to_owned()));
    };
    let available = u32::try_from(available.max(0)).unwrap_or(0);
    if available < quantity {
        return Ok(Err("invalid_quantity".to_owned()));
    }
    Ok(Ok(StorageStack {
        item_id,
        quantity,
        stats: serde_json::from_str::<BTreeMap<String, i64>>(&stats_json).ok(),
        upgrade_count: u32::try_from(upgrade.max(0)).ok(),
        remaining_slots: u32::try_from(remaining.max(0)).ok(),
    }))
}

/// Mirror of `peek_inventory_stack` for the warehouse side.
fn peek_storage_stack(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    slot: i16,
    quantity: u32,
) -> Result<Result<StorageStack, String>, String> {
    if !valid_storage_slot(slot) {
        return Ok(Err("invalid_slot".to_owned()));
    }
    if quantity == 0 {
        return Ok(Err("invalid_quantity".to_owned()));
    }
    let row: Option<(String, i64, String, i64, i64)> = tx
        .query_row(
            "SELECT item_id,quantity,stats_json,upgrade_count,remaining_slots FROM storage
             WHERE account_id=?1 AND slot=?2",
            params![account_id, slot],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()
        .map_err(|_| "account persistence failed")?;
    let Some((item_id, available, stats_json, upgrade, remaining)) = row else {
        return Ok(Err("storage_slot_empty".to_owned()));
    };
    let available = u32::try_from(available.max(0)).unwrap_or(0);
    if available < quantity {
        return Ok(Err("invalid_quantity".to_owned()));
    }
    Ok(Ok(StorageStack {
        item_id,
        quantity,
        stats: serde_json::from_str::<BTreeMap<String, i64>>(&stats_json).ok(),
        upgrade_count: u32::try_from(upgrade.max(0)).ok(),
        remaining_slots: u32::try_from(remaining.max(0)).ok(),
    }))
}

/// Remove `quantity` from one inventory stack.  The row is deleted when the
/// stack empties, which is what lets a later deposit reuse the slot.
fn take_inventory_stack(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    inventory_type: u8,
    slot: i16,
    quantity: u32,
) -> Result<(), String> {
    let remaining: i64 = tx
        .query_row(
            "SELECT quantity FROM inventory
             WHERE account_id=?1 AND inventory_type=?2 AND slot=?3",
            params![account_id, inventory_type, slot],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "account persistence failed")?
        .unwrap_or(0);
    if remaining <= i64::from(quantity) {
        tx.execute(
            "DELETE FROM inventory WHERE account_id=?1 AND inventory_type=?2 AND slot=?3",
            params![account_id, inventory_type, slot],
        )
        .map_err(|_| "account persistence failed")?;
    } else {
        tx.execute(
            "UPDATE inventory SET quantity=quantity-?4
             WHERE account_id=?1 AND inventory_type=?2 AND slot=?3",
            params![account_id, inventory_type, slot, i64::from(quantity)],
        )
        .map_err(|_| "account persistence failed")?;
    }
    Ok(())
}

/// Mirror of `take_inventory_stack` for the warehouse side.
fn take_storage_stack(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    slot: i16,
    quantity: u32,
) -> Result<(), String> {
    let remaining: i64 = tx
        .query_row(
            "SELECT quantity FROM storage WHERE account_id=?1 AND slot=?2",
            params![account_id, slot],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "account persistence failed")?
        .unwrap_or(0);
    if remaining <= i64::from(quantity) {
        tx.execute(
            "DELETE FROM storage WHERE account_id=?1 AND slot=?2",
            params![account_id, slot],
        )
        .map_err(|_| "account persistence failed")?;
    } else {
        tx.execute(
            "UPDATE storage SET quantity=quantity-?3 WHERE account_id=?1 AND slot=?2",
            params![account_id, slot, i64::from(quantity)],
        )
        .map_err(|_| "account persistence failed")?;
    }
    Ok(())
}

/// Decide whether a deposit can fit, and if so where the row(s) would go.
/// Checked before any mutation so a full warehouse refuses cleanly instead of
/// destroying the stack.
fn reserve_storage_slot(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    item_id: &str,
    quantity: u32,
) -> Result<(), String> {
    let mut need = i64::from(quantity);
    // Equipment instances never merge: two identical-looking weapons with a
    // different scroll history are different items.
    if !inventory::is_equipment(item_id) {
        let slot_max = i64::from(inventory::item_slot_max(item_id));
        let mergeable: i64 = tx
            .query_row(
                "SELECT COALESCE(SUM(?3-quantity),0) FROM storage
                 WHERE account_id=?1 AND item_id=?2 AND quantity>0 AND quantity<?3",
                params![account_id, item_id, slot_max],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "account persistence failed")?
            .unwrap_or(0);
        need = (need - mergeable.max(0)).max(0);
    }
    if need <= 0 {
        return Ok(());
    }
    let free: i64 = tx
        .query_row(
            "SELECT ?2 - COUNT(*) FROM storage WHERE account_id=?1",
            params![account_id, i64::from(STORAGE_SLOT_LIMIT)],
            |row| row.get(0),
        )
        .map_err(|_| "account persistence failed")?;
    if free <= 0 {
        return Err("storage_full".to_owned());
    }
    // A single slot can hold at most `slotMax`; more than one new row is only
    // needed when the amount exceeds a fresh stack.  Equipment needs exactly
    // one row and always fits in a free slot.
    let per_row = i64::from(inventory::item_slot_max(item_id)).max(1);
    let rows_needed = (need + per_row - 1) / per_row;
    if rows_needed > free {
        return Err("storage_full".to_owned());
    }
    Ok(())
}

/// Put a prepared stack into the warehouse, merging into an identical stack
/// when the item is stackable and there is room.
fn insert_storage_stack(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    stack: &StorageStack,
) -> Result<(), String> {
    let stats_json = serde_json::to_string(stack.stats.as_ref().unwrap_or(&BTreeMap::new()))
        .unwrap_or_else(|_| "{}".to_owned());
    let upgrade = i64::from(stack.upgrade_count.unwrap_or(0));
    let remaining = i64::from(stack.remaining_slots.unwrap_or(0));
    let mut left = i64::from(stack.quantity);
    if !inventory::is_equipment(&stack.item_id) {
        let slot_max = i64::from(inventory::item_slot_max(&stack.item_id));
        while left > 0 {
            let target: Option<(i64, i64)> = tx
                .query_row(
                    "SELECT slot,quantity FROM storage
                     WHERE account_id=?1 AND item_id=?2 AND quantity>0 AND quantity<?3
                     ORDER BY slot LIMIT 1",
                    params![account_id, stack.item_id, slot_max],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|_| "account persistence failed")?;
            let Some((slot, existing)) = target else {
                break;
            };
            let added = left.min((slot_max - existing).max(0));
            if added <= 0 {
                break;
            }
            tx.execute(
                "UPDATE storage SET quantity=quantity+?3 WHERE account_id=?1 AND slot=?2",
                params![account_id, slot, added],
            )
            .map_err(|_| "account persistence failed")?;
            left -= added;
        }
    }
    while left > 0 {
        let slot: i64 = (1..=i64::from(STORAGE_SLOT_LIMIT))
            .find(|candidate| {
                tx.query_row(
                    "SELECT 1 FROM storage WHERE account_id=?1 AND slot=?2",
                    params![account_id, candidate],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .unwrap_or(None)
                .is_none()
            })
            .ok_or_else(|| "storage_full".to_owned())?;
        let in_row = if inventory::is_equipment(&stack.item_id) {
            left
        } else {
            left.min(i64::from(inventory::item_slot_max(&stack.item_id)).max(1))
        };
        tx.execute(
            "INSERT INTO storage(account_id,slot,item_id,quantity,stats_json,upgrade_count,remaining_slots)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                account_id,
                slot,
                stack.item_id,
                in_row,
                stats_json,
                upgrade,
                remaining
            ],
        )
        .map_err(|_| "account persistence failed")?;
        left -= in_row;
    }
    Ok(())
}

/// Whether the character's inventory can accept a withdrawal.  Only decides
/// yes/no; the authoritative insert is `add_inventory_tx`.
fn inventory_has_room(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    stack: &StorageStack,
) -> Result<bool, String> {
    let kind = match inventory::inventory_type(&stack.item_id) {
        Some(kind) => kind,
        None => return Ok(false),
    };
    let mut need = i64::from(stack.quantity);
    if !inventory::is_equipment(&stack.item_id) {
        let slot_max = i64::from(inventory::item_slot_max(&stack.item_id));
        let mergeable: i64 = tx
            .query_row(
                "SELECT COALESCE(SUM(?4-quantity),0) FROM inventory
                 WHERE account_id=?1 AND inventory_type=?2 AND item_id=?3
                   AND quantity>0 AND quantity<?4",
                params![account_id, kind, stack.item_id, slot_max],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "account persistence failed")?
            .unwrap_or(0);
        need = (need - mergeable.max(0)).max(0);
    }
    if need <= 0 {
        return Ok(true);
    }
    let free: i64 = tx
        .query_row(
            "SELECT ?3 - COUNT(*) FROM inventory WHERE account_id=?1 AND inventory_type=?2",
            params![account_id, kind, i64::from(inventory::SLOT_LIMIT)],
            |row| row.get(0),
        )
        .map_err(|_| "account persistence failed")?;
    if free <= 0 {
        return Ok(false);
    }
    if inventory::is_equipment(&stack.item_id) {
        return Ok(true);
    }
    let per_row = i64::from(inventory::item_slot_max(&stack.item_id)).max(1);
    Ok((need + per_row - 1) / per_row <= free)
}

pub fn valid_storage_slot(slot: i16) -> bool {
    (1..=STORAGE_SLOT_LIMIT as i16).contains(&slot)
}

fn read_storage_action(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    request_id: &str,
) -> Result<Option<StorageOutcome>, String> {
    let row: Option<(String, i64, i64, String, i64, i64, String)> = tx
        .query_row(
            "SELECT operation,inventory_type,slot,item_id,quantity,success,code FROM storage_actions
             WHERE account_id=?1 AND request_id=?2",
            params![account_id, request_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional()
        .map_err(|_| "account persistence failed")?;
    let Some((operation, inventory_type, slot, item_id, quantity, success, code)) = row else {
        return Ok(None);
    };
    let operation = if operation == "storageWithdraw" {
        StorageOperation::Withdraw
    } else {
        StorageOperation::Deposit
    };
    Ok(Some(StorageOutcome {
        request_id: request_id.to_owned(),
        operation,
        inventory_type: u8::try_from(inventory_type).unwrap_or(0),
        slot: i16::try_from(slot).unwrap_or(0),
        item_id,
        quantity: u32::try_from(quantity.max(0)).unwrap_or(0),
        success: success != 0,
        code,
    }))
}

fn insert_storage_action(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    outcome: &StorageOutcome,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO storage_actions(account_id,request_id,operation,inventory_type,item_id,quantity,slot,success,code)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            account_id,
            outcome.request_id,
            outcome.operation.as_str(),
            i64::from(outcome.inventory_type),
            outcome.item_id,
            i64::from(outcome.quantity),
            outcome.slot,
            if outcome.success { 1 } else { 0 },
            outcome.code
        ],
    )
    .map_err(|_| "account persistence failed")?;
    Ok(())
}

fn read_storage_mesos_action(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    request_id: &str,
) -> Result<Option<StorageMesosOutcome>, String> {
    let row: Option<(String, i64, i64, String, i64, i64)> = tx
        .query_row(
            "SELECT operation,quantity,success,code,mesos,stored_mesos FROM storage_mesos_actions
             WHERE account_id=?1 AND request_id=?2",
            params![account_id, request_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()
        .map_err(|_| "account persistence failed")?;
    let Some((operation, quantity, success, code, mesos, stored)) = row else {
        return Ok(None);
    };
    let operation = if operation == "storageWithdraw" {
        StorageOperation::Withdraw
    } else {
        StorageOperation::Deposit
    };
    Ok(Some(StorageMesosOutcome {
        request_id: request_id.to_owned(),
        operation,
        quantity: u32::try_from(quantity.max(0)).unwrap_or(0),
        success: success != 0,
        code,
        mesos: u64::try_from(mesos.max(0)).unwrap_or(0),
        stored_mesos: u64::try_from(stored.max(0)).unwrap_or(0),
    }))
}

fn insert_storage_mesos_action(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    outcome: &StorageMesosOutcome,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO storage_mesos_actions(account_id,request_id,operation,quantity,success,code,mesos,stored_mesos)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            account_id,
            outcome.request_id,
            outcome.operation.as_str(),
            i64::from(outcome.quantity),
            if outcome.success { 1 } else { 0 },
            outcome.code,
            i64::try_from(outcome.mesos).unwrap_or(i64::MAX),
            i64::try_from(outcome.stored_mesos).unwrap_or(i64::MAX),
        ],
    )
    .map_err(|_| "account persistence failed")?;
    Ok(())
}

fn read_mesos_tx(tx: &rusqlite::Transaction<'_>, account_id: &str) -> Result<u64, String> {
    let mesos: i64 = tx
        .query_row(
            "SELECT mesos FROM player_stats WHERE account_id=?1",
            [account_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "account persistence failed")?
        .unwrap_or(0);
    Ok(u64::try_from(mesos.max(0)).unwrap_or(0))
}

fn read_storage_mesos_tx(tx: &rusqlite::Transaction<'_>, account_id: &str) -> Result<u64, String> {
    let mesos: i64 = tx
        .query_row(
            "SELECT mesos FROM storage_mesos WHERE account_id=?1",
            [account_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "account persistence failed")?
        .unwrap_or(0);
    Ok(u64::try_from(mesos.max(0)).unwrap_or(0))
}

fn read_storage_mesos_db(db: &Connection, account_id: &str) -> Result<u64, String> {
    let mesos: i64 = db
        .query_row(
            "SELECT mesos FROM storage_mesos WHERE account_id=?1",
            [account_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "account persistence failed")?
        .unwrap_or(0);
    Ok(u64::try_from(mesos.max(0)).unwrap_or(0))
}

fn migrate_inventory_schema(
    db: &Connection,
    had_slot: bool,
    had_stats: bool,
    had_upgrade_count: bool,
    had_remaining_slots: bool,
) -> rusqlite::Result<()> {
    db.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| {
        db.execute_batch(
            "ALTER TABLE inventory RENAME TO inventory_legacy;
             CREATE TABLE inventory(
               account_id TEXT NOT NULL,
               inventory_type INTEGER NOT NULL DEFAULT 0,
               slot INTEGER NOT NULL,
               item_id TEXT NOT NULL,
               quantity INTEGER NOT NULL,
               stats_json TEXT NOT NULL DEFAULT '{}',
               upgrade_count INTEGER NOT NULL DEFAULT 0,
               remaining_slots INTEGER NOT NULL DEFAULT 0,
               PRIMARY KEY(account_id,inventory_type,slot)
             );",
        )?;
        let stats_column = if had_stats { "stats_json" } else { "'{}'" };
        let upgrade_column = if had_upgrade_count {
            "upgrade_count"
        } else {
            "0"
        };
        let remaining_column = if had_remaining_slots {
            "remaining_slots"
        } else {
            "0"
        };
        let query = if had_slot {
            format!(
                "SELECT account_id,slot,item_id,quantity,{stats_column},{upgrade_column},{remaining_column}
                 FROM inventory_legacy WHERE quantity>0 ORDER BY account_id,slot,item_id"
            )
        } else {
            format!(
                "SELECT account_id,NULL,item_id,quantity,{stats_column},{upgrade_column},{remaining_column}
                 FROM inventory_legacy WHERE quantity>0 ORDER BY account_id,item_id"
            )
        };
        let rows = {
            let mut stmt = db.prepare(&query)?;
            let result = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            })?;
            result.collect::<Result<Vec<_>, _>>()?
        };
        let mut used: BTreeMap<(String, u8), Vec<u16>> = BTreeMap::new();
        for (
            account_id,
            preferred_slot,
            item_id,
            quantity,
            stats_json,
            upgrade_count,
            remaining_slots,
        ) in rows
        {
            let kind = inventory::inventory_type(&item_id).ok_or_else(|| {
                rusqlite::Error::InvalidParameterName(format!(
                    "inventory migration: unknown item {item_id}"
                ))
            })?;
            let max = inventory::item_slot_max(&item_id);
            if inventory::is_equipment(&item_id) && quantity != 1 {
                return Err(rusqlite::Error::InvalidParameterName(format!(
                    "inventory migration: invalid equipment quantity for {item_id}"
                )));
            }
            let key = (account_id.clone(), kind);
            let slots = used.entry(key).or_default();
            let mut remaining = u32::try_from(quantity).map_err(|_| {
                rusqlite::Error::InvalidParameterName(format!(
                    "inventory migration: invalid quantity for {item_id}"
                ))
            })?;
            let mut preferred = preferred_slot.and_then(|slot| u16::try_from(slot).ok());
            while remaining > 0 {
                let slot = preferred
                    .take()
                    .filter(|slot| inventory::valid_slot(*slot as i16) && !slots.contains(slot))
                    .or_else(|| (1..=SLOT_LIMIT).find(|slot| !slots.contains(slot)))
                    .ok_or_else(|| {
                        rusqlite::Error::InvalidParameterName(format!(
                            "inventory migration: no free slot for {item_id}"
                        ))
                    })?;
                slots.push(slot);
                let amount = remaining.min(max);
                db.execute(
                    "INSERT INTO inventory(account_id,inventory_type,slot,item_id,quantity,stats_json,upgrade_count,remaining_slots)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                    params![
                        account_id,
                        i64::from(kind),
                        i64::from(slot),
                        item_id,
                        i64::from(amount),
                        stats_json,
                        upgrade_count,
                        remaining_slots,
                    ],
                )?;
                remaining -= amount;
            }
        }
        db.execute_batch("DROP TABLE inventory_legacy;")?;
        Ok(())
    })();
    match result {
        Ok(()) => {
            db.execute_batch("COMMIT")?;
            Ok(())
        }
        Err(error) => {
            let _ = db.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn read_inventory_action(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    request_id: &str,
) -> Result<Option<InventoryOutcome>, String> {
    tx.query_row(
        "SELECT request_id,operation,inventory_type,from_slot,to_slot,item_id,quantity,drop_id,success,code
         FROM inventory_actions WHERE account_id=?1 AND request_id=?2",
        params![account_id, request_id],
        inventory_outcome_from_row,
    )
    .optional()
    .map_err(|_| "account persistence failed".to_owned())
}

fn read_pickup_action(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    request_id: &str,
) -> Result<Option<PickupOutcome>, String> {
    tx.query_row(
        "SELECT drop_id,item_id,quantity,slot,success,code FROM pickup_actions
         WHERE account_id=?1 AND request_id=?2",
        params![account_id, request_id],
        |row| {
            Ok(PickupOutcome {
                drop_id: row.get(0)?,
                item_id: row.get(1)?,
                quantity: row.get::<_, i64>(2)?.try_into().unwrap_or(0),
                slot: row
                    .get::<_, Option<i64>>(3)?
                    .and_then(|slot| slot.try_into().ok()),
                success: row.get::<_, i64>(4)? != 0,
                code: row.get(5)?,
            })
        },
    )
    .optional()
    .map_err(|_| "account persistence failed".to_owned())
}

fn normalize_inventory_tx(tx: &rusqlite::Transaction<'_>) -> Result<(), String> {
    let mut stmt = tx
        .prepare(
            "SELECT rowid,account_id,inventory_type,slot,item_id,quantity,
                    stats_json,upgrade_count,remaining_slots
             FROM inventory ORDER BY account_id,rowid",
        )
        .map_err(|_| "account persistence failed")?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, i64>(8)?,
            ))
        })
        .map_err(|_| "account persistence failed")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "account persistence failed")?;
    drop(stmt);
    for (
        rowid,
        account_id,
        _old_kind,
        old_slot,
        item_id,
        quantity,
        old_stats_json,
        old_upgrade_count,
        old_remaining_slots,
    ) in rows
    {
        if quantity <= 0 {
            tx.execute("DELETE FROM inventory WHERE rowid=?1", [rowid])
                .map_err(|_| "account persistence failed")?;
            continue;
        }
        let kind = inventory::inventory_type(&item_id)
            .ok_or_else(|| format!("unknown inventory item {item_id}"))?;
        let quantity = u32::try_from(quantity)
            .map_err(|_| format!("invalid inventory quantity for {item_id}"))?;
        if inventory::is_equipment(&item_id) && quantity != 1 {
            return Err(format!("invalid equipment quantity for {item_id}"));
        }
        let mut stats_json = old_stats_json;
        let upgrade_count = u32::try_from(old_upgrade_count.max(0)).unwrap_or(0);
        let mut remaining_slots = u32::try_from(old_remaining_slots.max(0)).unwrap_or(0);
        if inventory::is_equipment(&item_id) {
            let parsed = serde_json::from_str::<BTreeMap<String, i64>>(&stats_json).ok();
            if parsed.as_ref().is_none_or(BTreeMap::is_empty)
                && upgrade_count == 0
                && remaining_slots == 0
            {
                stats_json = serde_json::to_string(&inventory::equipment_attributes(&item_id))
                    .map_err(|_| "account persistence failed")?;
                remaining_slots = inventory::equipment_upgrade_slots(&item_id);
            }
        }
        let max = inventory::item_slot_max(&item_id);
        let mut quantity_remaining = quantity;
        let mut preferred = u16::try_from(old_slot).ok();
        // The source row is deliberately excluded from the SQL occupied
        // query so its legacy slot can be reused on the first pass.  Track
        // every slot allocated for this row as we split it, otherwise the
        // second pass can select that same slot and hit the composite PK.
        let mut allocated_slots = Vec::new();
        while quantity_remaining > 0 {
            let occupied: Vec<u16> = {
                let mut occupied_stmt = tx
                    .prepare(
                        "SELECT slot FROM inventory
                     WHERE account_id=?1 AND inventory_type=?2 AND rowid<>?3",
                    )
                    .map_err(|_| "account persistence failed")?;
                let occupied = {
                    let result = occupied_stmt.query_map(
                        params![account_id, i64::from(kind), rowid],
                        |row| {
                            row.get::<_, i64>(0)
                                .map(|slot| slot.try_into().unwrap_or(0))
                        },
                    );
                    result
                        .map_err(|_| "account persistence failed")?
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|_| "account persistence failed")?
                };
                occupied
            };
            let slot = preferred
                .take()
                .filter(|slot| {
                    inventory::valid_slot(*slot as i16)
                        && !occupied.contains(slot)
                        && !allocated_slots.contains(slot)
                })
                .or_else(|| {
                    (1..=SLOT_LIMIT)
                        .find(|slot| !occupied.contains(slot) && !allocated_slots.contains(slot))
                })
                .ok_or_else(|| format!("no free inventory slot for {item_id}"))?;
            allocated_slots.push(slot);
            let amount = quantity_remaining.min(max);
            if quantity_remaining == quantity {
                tx.execute(
                    "UPDATE inventory SET inventory_type=?2,slot=?3,quantity=?4,stats_json=?5,
                     upgrade_count=?6,remaining_slots=?7 WHERE rowid=?1",
                    params![
                        rowid,
                        i64::from(kind),
                        i64::from(slot),
                        i64::from(amount),
                        stats_json,
                        i64::from(upgrade_count),
                        i64::from(remaining_slots),
                    ],
                )
                .map_err(|_| "account persistence failed")?;
            } else {
                tx.execute(
                    "INSERT INTO inventory(account_id,inventory_type,slot,item_id,quantity,
                     stats_json,upgrade_count,remaining_slots)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                    params![
                        account_id,
                        i64::from(kind),
                        i64::from(slot),
                        item_id,
                        i64::from(amount),
                        stats_json,
                        i64::from(upgrade_count),
                        i64::from(remaining_slots),
                    ],
                )
                .map_err(|_| "account persistence failed")?;
            }
            quantity_remaining -= amount;
        }
    }
    Ok(())
}

fn read_inventory_tx(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
) -> Result<Vec<InventoryItem>, String> {
    let mut stmt = tx
        .prepare(
            "SELECT inventory_type,slot,item_id,quantity,stats_json,upgrade_count,remaining_slots FROM inventory
             WHERE account_id=?1 AND inventory_type BETWEEN 1 AND 5 AND slot BETWEEN 1 AND 24 AND quantity>0
             ORDER BY inventory_type,slot",
        )
        .map_err(|_| "account persistence failed")?;
    let rows = stmt
        .query_map([account_id], |row| {
            let item_id: String = row.get(2)?;
            let is_equipment = inventory::is_equipment(&item_id);
            Ok(InventoryItem {
                slot: row.get::<_, i64>(1)?.try_into().unwrap_or(0),
                item_id,
                quantity: row.get::<_, i64>(3)?.try_into().unwrap_or(0),
                stats: if is_equipment {
                    row.get::<_, String>(4)
                        .ok()
                        .and_then(|json| serde_json::from_str(&json).ok())
                } else {
                    None
                },
                remaining_slots: if is_equipment {
                    row.get::<_, i64>(6)
                        .ok()
                        .and_then(|value| u32::try_from(value.max(0)).ok())
                } else {
                    None
                },
                upgrade_count: if is_equipment {
                    row.get::<_, i64>(5)
                        .ok()
                        .and_then(|value| u32::try_from(value.max(0)).ok())
                } else {
                    None
                },
            })
        })
        .map_err(|_| "account persistence failed")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "account persistence failed")?;
    let mut rows = rows;
    for item in &mut rows {
        inventory::ensure_equipment_instance(item);
    }
    Ok(rows)
}

fn read_equipped_tx(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
) -> Result<Vec<InventoryItem>, String> {
    let mut stmt = tx
        .prepare(
            "SELECT slot,item_id,quantity,stats_json,upgrade_count,remaining_slots FROM equipped
             WHERE account_id=?1 AND slot BETWEEN -50 AND -1 AND quantity>0 ORDER BY slot",
        )
        .map_err(|_| "account persistence failed")?;
    let collected = {
        let result = stmt.query_map([account_id], |row| {
            let slot: i64 = row.get(0)?;
            let mut item = InventoryItem {
                slot: slot.unsigned_abs().try_into().unwrap_or(0),
                item_id: row.get(1)?,
                quantity: row.get::<_, i64>(2)?.try_into().unwrap_or(0),
                stats: row
                    .get::<_, String>(3)
                    .ok()
                    .and_then(|json| serde_json::from_str(&json).ok()),
                upgrade_count: row
                    .get::<_, i64>(4)
                    .ok()
                    .and_then(|value| u32::try_from(value.max(0)).ok()),
                remaining_slots: row
                    .get::<_, i64>(5)
                    .ok()
                    .and_then(|value| u32::try_from(value.max(0)).ok()),
            };
            inventory::ensure_equipment_instance(&mut item);
            Ok(item)
        });
        result
            .map_err(|_| "account persistence failed")?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "account persistence failed".to_owned())?
    };
    Ok(collected)
}

fn read_equipped_db(db: &Connection, account_id: &str) -> Result<Vec<InventoryItem>, String> {
    let mut stmt = db
        .prepare(
            "SELECT slot,item_id,quantity,stats_json,upgrade_count,remaining_slots FROM equipped
             WHERE account_id=?1 AND slot BETWEEN -50 AND -1 AND quantity>0 ORDER BY slot",
        )
        .map_err(|_| "account persistence failed")?;
    let collected = {
        let result = stmt.query_map([account_id], |row| {
            let slot: i64 = row.get(0)?;
            let mut item = InventoryItem {
                slot: slot.unsigned_abs().try_into().unwrap_or(0),
                item_id: row.get(1)?,
                quantity: row.get::<_, i64>(2)?.try_into().unwrap_or(0),
                stats: row
                    .get::<_, String>(3)
                    .ok()
                    .and_then(|json| serde_json::from_str(&json).ok()),
                upgrade_count: row
                    .get::<_, i64>(4)
                    .ok()
                    .and_then(|value| u32::try_from(value.max(0)).ok()),
                remaining_slots: row
                    .get::<_, i64>(5)
                    .ok()
                    .and_then(|value| u32::try_from(value.max(0)).ok()),
            };
            inventory::ensure_equipment_instance(&mut item);
            Ok(item)
        });
        result
            .map_err(|_| "account persistence failed")?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "account persistence failed".to_owned())?
    };
    Ok(collected)
}

fn write_inventory_tx(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    inventory_items: &[InventoryItem],
) -> Result<(), String> {
    tx.execute("DELETE FROM inventory WHERE account_id=?1", [account_id])
        .map_err(|_| "account persistence failed")?;
    for item in inventory_items {
        let kind = inventory::inventory_type(&item.item_id)
            .ok_or_else(|| format!("unknown inventory item {}", item.item_id))?;
        if !inventory::valid_slot(item.slot as i16) {
            return Err(format!("invalid inventory slot for {}", item.item_id));
        }
        if item.quantity == 0 {
            return Err(format!("invalid inventory quantity for {}", item.item_id));
        }
        if inventory::is_equipment(&item.item_id) && item.quantity != 1 {
            return Err(format!("invalid equipment quantity for {}", item.item_id));
        }
        let mut item = item.clone();
        inventory::ensure_equipment_instance(&mut item);
        let stats_json = serde_json::to_string(&item.stats.clone().unwrap_or_default())
            .map_err(|_| "account persistence failed")?;
        tx.execute(
            "INSERT INTO inventory(account_id,inventory_type,slot,item_id,quantity,stats_json,upgrade_count,remaining_slots)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                account_id,
                i64::from(kind),
                i64::from(item.slot),
                item.item_id,
                i64::from(item.quantity),
                stats_json,
                i64::from(item.upgrade_count.unwrap_or(0)),
                i64::from(item.remaining_slots.unwrap_or(0)),
            ],
        )
        .map_err(|_| "account persistence failed")?;
    }
    Ok(())
}

fn write_equipped_tx(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    equipped_items: &[InventoryItem],
) -> Result<(), String> {
    tx.execute("DELETE FROM equipped WHERE account_id=?1", [account_id])
        .map_err(|_| "account persistence failed")?;
    for item in equipped_items {
        if !inventory::is_equipment(&item.item_id) {
            return Err(format!("invalid equipped item {}", item.item_id));
        }
        if !(1..=50).contains(&item.slot) {
            return Err(format!("invalid equipped slot for {}", item.item_id));
        }
        if item.quantity != 1 {
            return Err(format!("invalid equipped quantity for {}", item.item_id));
        }
        if inventory::equipment_slot(&item.item_id) != Some(-(item.slot as i16)) {
            return Err(format!("equipment slot mismatch for {}", item.item_id));
        }
        let mut item = item.clone();
        inventory::ensure_equipment_instance(&mut item);
        let stats_json = serde_json::to_string(&item.stats.clone().unwrap_or_default())
            .map_err(|_| "account persistence failed")?;
        tx.execute(
            "INSERT INTO equipped(account_id,slot,item_id,quantity,stats_json,upgrade_count,remaining_slots)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                account_id,
                -i64::from(item.slot),
                item.item_id,
                i64::from(item.quantity),
                stats_json,
                i64::from(item.upgrade_count.unwrap_or(0)),
                i64::from(item.remaining_slots.unwrap_or(0)),
            ],
        )
        .map_err(|_| "account persistence failed")?;
    }
    Ok(())
}

/// Read the durable per-tab slot capacities inside a transaction.  An empty
/// JSON (older rows) means every tab is at the default 24.
fn read_inventory_slots_tx(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
) -> Result<BTreeMap<u8, u16>, inventory::InventoryError> {
    let raw: String = tx
        .query_row(
            "SELECT inventory_slots_json FROM player_stats WHERE account_id=?1",
            [account_id],
            |row| row.get(0),
        )
        .map_err(|_| inventory::InventoryError::QuantityOverflow)?;
    if raw.is_empty() {
        return Ok(inventory::default_inventory_slots());
    }
    let parsed: BTreeMap<u8, u16> = serde_json::from_str(&raw)
        .map_err(|_| inventory::InventoryError::QuantityOverflow)?;
    let mut slots = inventory::default_inventory_slots();
    for (kind, capacity) in parsed {
        if inventory::valid_inventory_type(kind) {
            slots.insert(kind, capacity.clamp(inventory::SLOT_LIMIT, inventory::MAX_SLOT_LIMIT));
        }
    }
    Ok(slots)
}

fn write_inventory_slots_tx(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    slots: &BTreeMap<u8, u16>,
) -> Result<(), inventory::InventoryError> {
    let json = serde_json::to_string(slots).map_err(|_| inventory::InventoryError::QuantityOverflow)?;
    tx.execute(
        "UPDATE player_stats SET inventory_slots_json=?2 WHERE account_id=?1",
        params![account_id, json],
    )
    .map_err(|_| inventory::InventoryError::QuantityOverflow)?;
    Ok(())
}

fn apply_scroll_tx(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    item_id: &str,
    target_slot: Option<i16>,
    target_item_id: Option<&str>,
) -> Result<bool, inventory::InventoryError> {
    let Some(target_slot) = target_slot else {
        return Err(inventory::InventoryError::InvalidEquipmentSlot);
    };
    if inventory::valid_slot(target_slot) {
        return Err(inventory::InventoryError::LegendarySpiritRequired);
    }
    if !inventory::valid_equipment_slot(target_slot) {
        return Err(inventory::InventoryError::InvalidEquipmentSlot);
    }
    let Some(target_item_id) = target_item_id else {
        return Err(inventory::InventoryError::UnknownItem);
    };
    let target: Option<(String, String, i64, i64)> = tx
        .query_row(
            "SELECT item_id,stats_json,upgrade_count,remaining_slots FROM equipped
             WHERE account_id=?1 AND slot=?2 AND quantity>0",
            params![account_id, i64::from(target_slot)],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|_| inventory::InventoryError::QuantityOverflow)?;
    let Some((equipped_item_id, stats_json, upgrades, remaining)) = target else {
        return Err(inventory::InventoryError::SourceEmpty);
    };
    if equipped_item_id != target_item_id || remaining <= 0 {
        return Err(inventory::InventoryError::RequirementsNotMet);
    }
    if !inventory::scroll_applies_to_item(item_id, &equipped_item_id) {
        return Err(inventory::InventoryError::RequirementsNotMet);
    }
    let Some(effects) = inventory::scroll_effect(item_id) else {
        return Err(inventory::InventoryError::ItemNotUsable);
    };
    let mut attributes: BTreeMap<String, i64> =
        serde_json::from_str(&stats_json).unwrap_or_default();
    if attributes.is_empty() {
        attributes = inventory::equipment_attributes(&equipped_item_id);
    }
    let success_rate = inventory::item_success_rate(item_id).unwrap_or(0);
    let success = rand::thread_rng().gen_range(0..100) < success_rate;
    if success {
        for (key, value) in effects {
            *attributes.entry(key).or_insert(0) += value;
        }
    }
    let serialized = serde_json::to_string(&attributes)
        .map_err(|_| inventory::InventoryError::QuantityOverflow)?;
    tx.execute(
        "UPDATE equipped SET stats_json=?3,upgrade_count=?4,remaining_slots=?5
         WHERE account_id=?1 AND slot=?2",
        params![
            account_id,
            i64::from(target_slot),
            serialized,
            upgrades.saturating_add(i64::from(success)),
            remaining.saturating_sub(1)
        ],
    )
    .map_err(|_| inventory::InventoryError::QuantityOverflow)?;
    Ok(success)
}

fn inventory_outcome_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<InventoryOutcome> {
    Ok(InventoryOutcome {
        request_id: row.get(0)?,
        operation: row.get(1)?,
        inventory_type: row
            .get::<_, i64>(2)?
            .try_into()
            .ok()
            .filter(|kind| inventory::valid_inventory_type(*kind)),
        from_slot: row.get::<_, i64>(3)?.try_into().unwrap_or(0),
        to_slot: row
            .get::<_, Option<i64>>(4)?
            .and_then(|slot| slot.try_into().ok()),
        item_id: row.get(5)?,
        quantity: row.get::<_, i64>(6)?.try_into().unwrap_or(0),
        drop_id: row.get(7)?,
        success: row.get::<_, i64>(8)? != 0,
        code: row.get(9)?,
    })
}

fn insert_inventory_action(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    outcome: &InventoryOutcome,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO inventory_actions(account_id,request_id,operation,inventory_type,from_slot,to_slot,item_id,quantity,drop_id,success,code)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![
            account_id,
            outcome.request_id,
            outcome.operation,
            outcome.inventory_type.map(i64::from).unwrap_or(0),
            i64::from(outcome.from_slot),
            outcome.to_slot.map(i64::from),
            outcome.item_id,
            i64::from(outcome.quantity),
            outcome.drop_id,
            if outcome.success { 1 } else { 0 },
            outcome.code,
        ],
    )
    .map_err(|_| String::from("account persistence failed"))?;
    Ok(())
}

/// Add a normal item to the first matching stack, or the first empty regular
/// inventory slot.  The caller owns the surrounding transaction so a failed
/// full/overflow result leaves both the item and its source drop untouched.
fn add_inventory_tx(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    item_id: &str,
    quantity: u32,
    instance_stats: Option<&BTreeMap<String, i64>>,
    instance_remaining_slots: Option<u32>,
    instance_upgrade_count: Option<u32>,
) -> Result<Result<u16, &'static str>, String> {
    if inventory::is_only(item_id) {
        let exists: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM inventory WHERE account_id=?1 AND item_id=?2 AND quantity>0
                 UNION ALL SELECT 1 FROM equipped WHERE account_id=?1 AND item_id=?2 AND quantity>0
                 UNION ALL SELECT 1 FROM monster_book_cards WHERE account_id=?1 AND item_id=?2 AND quantity>0
                 LIMIT 1",
                params![account_id, item_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "account persistence failed")?;
        if exists.is_some() {
            return Ok(Err("item_unavailable"));
        }
    }
    let Some(kind) = inventory::inventory_type(item_id) else {
        return Ok(Err("unknown_item"));
    };
    if kind == 1 && quantity != 1 {
        return Ok(Err("quantity_mismatch"));
    }
    let mut inventory_items = read_inventory_tx(tx, account_id)?;
    let slots = read_inventory_slots_tx(tx, account_id)
        .map_err(|_| "account persistence failed")?;
    let slot_limit = slots.get(&kind).copied().unwrap_or(inventory::SLOT_LIMIT);
    match inventory::add_items(&mut inventory_items, item_id.to_owned(), quantity, slot_limit) {
        Ok(slot) => {
            if kind == 1 {
                if let Some(item) = inventory_items.iter_mut().find(|item| {
                    item.slot == slot && inventory::inventory_type(&item.item_id) == Some(kind)
                }) {
                    if let Some(stats) = instance_stats {
                        item.stats = Some(stats.clone());
                    }
                    if let Some(remaining) = instance_remaining_slots {
                        item.remaining_slots = Some(remaining);
                    }
                    if let Some(upgrade_count) = instance_upgrade_count {
                        item.upgrade_count = Some(upgrade_count);
                    }
                    inventory::ensure_equipment_instance(item);
                }
            }
            write_inventory_tx(tx, account_id, &inventory_items)?;
            Ok(Ok(slot))
        }
        Err(error) => Ok(Err(error.code())),
    }
}

fn ensure_starter_equipment_tx(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
) -> Result<(), String> {
    let seeded: i64 = tx
        .query_row(
            "SELECT starter_equipment_seeded FROM player_stats WHERE account_id=?1",
            [account_id],
            |row| row.get(0),
        )
        .map_err(|_| "account persistence failed")?;
    if seeded != 0 {
        return Ok(());
    }
    let equipped_count: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM equipped WHERE account_id=?1 AND quantity>0",
            [account_id],
            |row| row.get(0),
        )
        .map_err(|_| "account persistence failed")?;
    if equipped_count == 0 {
        for item in inventory::starter_equipment() {
            let stats = item.stats.clone().unwrap_or_default();
            let stats_json =
                serde_json::to_string(&stats).map_err(|_| "account persistence failed")?;
            tx.execute(
                "INSERT INTO equipped(account_id,slot,item_id,quantity,stats_json,upgrade_count,remaining_slots)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![
                    account_id,
                    -i64::from(item.slot),
                    item.item_id,
                    i64::from(item.quantity),
                    stats_json,
                    i64::from(item.upgrade_count.unwrap_or(0)),
                    i64::from(item.remaining_slots.unwrap_or(0)),
                ],
            )
            .map_err(|_| "account persistence failed")?;
        }
    }
    tx.execute(
        "UPDATE player_stats SET starter_equipment_seeded=1 WHERE account_id=?1",
        [account_id],
    )
    .map_err(|_| "account persistence failed")?;
    Ok(())
}

fn normalize_equipped_tx(tx: &rusqlite::Transaction<'_>) -> Result<(), String> {
    let mut stmt = tx
        .prepare(
            "SELECT rowid,account_id,slot,item_id,quantity,stats_json,upgrade_count,remaining_slots
             FROM equipped ORDER BY account_id,rowid",
        )
        .map_err(|_| "account persistence failed")?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
            ))
        })
        .map_err(|_| "account persistence failed")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "account persistence failed")?;
    drop(stmt);
    for (
        rowid,
        account_id,
        old_slot,
        item_id,
        quantity,
        old_stats_json,
        old_upgrade_count,
        old_remaining_slots,
    ) in rows
    {
        if !inventory::is_equipment(&item_id) {
            return Err(format!("invalid equipped item {item_id}"));
        }
        if quantity != 1 {
            return Err(format!("invalid equipped quantity for {item_id}"));
        }
        let slot = if inventory::valid_equipment_slot(old_slot as i16) {
            old_slot as i16
        } else if inventory::valid_slot(old_slot as i16) {
            // A short-lived development schema stored the absolute slot.
            // Convert it once, preserving the instance rather than silently
            // dropping the row.
            -(old_slot as i16)
        } else {
            return Err(format!("invalid equipped slot for {item_id}"));
        };
        if inventory::equipment_slot(&item_id) != Some(slot) {
            return Err(format!("equipment slot mismatch for {item_id}"));
        }
        let occupied: Option<i64> = tx
            .query_row(
                "SELECT rowid FROM equipped WHERE account_id=?1 AND slot=?2 AND rowid<>?3",
                params![account_id, i64::from(slot), rowid],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "account persistence failed")?;
        if occupied.is_some() {
            return Err(format!("duplicate equipped slot for {item_id}"));
        }
        let mut stats_json = old_stats_json;
        let upgrade_count = u32::try_from(old_upgrade_count.max(0)).unwrap_or(0);
        let mut remaining_slots = u32::try_from(old_remaining_slots.max(0)).unwrap_or(0);
        let parsed = serde_json::from_str::<BTreeMap<String, i64>>(&stats_json).ok();
        if parsed.as_ref().is_none_or(BTreeMap::is_empty)
            && upgrade_count == 0
            && remaining_slots == 0
        {
            stats_json = serde_json::to_string(&inventory::equipment_attributes(&item_id))
                .map_err(|_| "account persistence failed")?;
            remaining_slots = inventory::equipment_upgrade_slots(&item_id);
        }
        tx.execute(
            "UPDATE equipped SET slot=?2,stats_json=?3,upgrade_count=?4,remaining_slots=?5
             WHERE rowid=?1",
            params![
                rowid,
                i64::from(slot),
                stats_json,
                i64::from(upgrade_count),
                i64::from(remaining_slots),
            ],
        )
        .map_err(|_| "account persistence failed")?;
    }
    Ok(())
}

fn read_profile(tx: &rusqlite::Transaction<'_>, account_id: &str) -> Result<Profile, String> {
    normalize_inventory_tx(tx)?;
    let (
        hp,
        max_hp,
        mp,
        max_mp,
        level,
        job,
        exp,
        exp_to_next,
        mesos,
        death_id,
        map_id,
        x,
        y,
        skills_json,
        skill_points_json,
    ): (
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
        String,
        String,
        f64,
        f64,
        String,
        String,
    ) = tx
            .query_row(
                "SELECT hp,max_hp,mp,max_mp,level,job,exp,exp_to_next,mesos,death_id,map_id,x,y,skills_json,skill_points_json FROM player_stats WHERE account_id=?1",
                [account_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                        row.get(9)?,
                        row.get(10)?,
                        row.get(11)?,
                        row.get(12)?,
                        row.get(13)?,
                        row.get(14)?,
                    ))
                },
            )
            .map_err(|_| "account persistence failed")?;
    let skills = parse_skill_map(&skills_json)?;
    let skill_points = parse_skill_map(&skill_points_json)?;
    let mut stmt = tx
        .prepare("SELECT inventory_type,slot,item_id,quantity,stats_json,upgrade_count,remaining_slots FROM inventory WHERE account_id=?1 AND quantity>0 ORDER BY inventory_type,slot")
        .map_err(|_| "account persistence failed")?;
    let inventory = stmt
        .query_map([account_id], |row| {
            let item_id: String = row.get(2)?;
            let is_equipment = inventory::is_equipment(&item_id);
            let mut item = InventoryItem {
                slot: row.get::<_, i64>(1)?.try_into().unwrap_or(0),
                item_id,
                quantity: row.get::<_, i64>(3)?.try_into().unwrap_or(0),
                stats: if is_equipment {
                    row.get::<_, String>(4)
                        .ok()
                        .and_then(|json| serde_json::from_str(&json).ok())
                } else {
                    None
                },
                upgrade_count: if is_equipment {
                    row.get::<_, i64>(5)
                        .ok()
                        .and_then(|value| u32::try_from(value.max(0)).ok())
                } else {
                    None
                },
                remaining_slots: if is_equipment {
                    row.get::<_, i64>(6)
                        .ok()
                        .and_then(|value| u32::try_from(value.max(0)).ok())
                } else {
                    None
                },
            };
            inventory::ensure_equipment_instance(&mut item);
            Ok(item)
        })
        .map_err(|_| "account persistence failed")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "account persistence failed")?;
    let ability_json: String = tx
        .query_row(
            "SELECT ability_stats_json FROM player_stats WHERE account_id=?1",
            [account_id],
            |row| row.get(0),
        )
        .map_err(|_| "account persistence failed")?;
    let ability_stats =
        serde_json::from_str(&ability_json).map_err(|_| "invalid saved ability stats")?;
    Ok(Profile {
        hp: hp.max(0),
        max_hp: max_hp.max(1),
        mp: mp.max(0),
        max_mp: max_mp.max(0),
        level: level.max(1) as u32,
        job: u32::try_from(job).map_err(|_| "account persistence failed")?,
        exp: exp.max(0) as u64,
        exp_to_next: exp_to_next.max(0) as u64,
        mesos: mesos.max(0) as u64,
        death_id,
        map_id,
        x: if x.is_finite() { x } else { 0.0 },
        y: if y.is_finite() { y } else { 0.0 },
        inventory,
        skills,
        skill_points,
        ability_stats,
    })
}

fn parse_skill_map(json: &str) -> Result<BTreeMap<u32, u32>, String> {
    serde_json::from_str(json).map_err(|_| "account persistence failed".to_owned())
}

fn serialize_skill_map(map: &BTreeMap<u32, u32>) -> Result<String, String> {
    serde_json::to_string(map).map_err(|_| "account persistence failed".to_owned())
}

fn write_profile(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    profile: &Profile,
) -> Result<(), String> {
    let skills_json = serialize_skill_map(&profile.skills)?;
    let skill_points_json = serialize_skill_map(&profile.skill_points)?;
    tx.execute(
        "UPDATE player_stats SET hp=?2,max_hp=?3,mp=?4,max_mp=?5,level=?6,job=?7,exp=?8,exp_to_next=?9,mesos=?10,death_id=?11,skills_json=?12,skill_points_json=?13,ability_stats_json=?14,map_id=?15,x=?16,y=?17
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
            profile.death_id,
            skills_json,
            skill_points_json,
            serde_json::to_string(&profile.ability_stats).map_err(|_| "account persistence failed")?,
            profile.map_id,
            profile.x,
            profile.y,
        ],
    )
    .map_err(|_| "account persistence failed")?;
    Ok(())
}

/// P: beginner levels 2..=7 grant 1 SP (R: historical cross-region rule,
/// https://en.wikibooks.org/wiki/MapleStory/Beginner_Guide/Skills; not a 273 script).
/// supported Mage books keep the project's existing 3-SP-per-level rule.
/// Call only after a real level increase, inside the reward transaction.
pub(crate) fn grant_level_sp(job: u32, level: u32, points: &mut BTreeMap<u32, u32>) {
    let (book, amount) = match job {
        0 if (2..=7).contains(&level) => (0, 1),
        THIRD_JOB => (THIRD_MAGE_BOOK, 3),
        220 => (220, 3),
        FOURTH_JOB => {
            let amount = fourth_sp_for_level(level);
            if amount == 0 {
                return;
            }
            (FOURTH_MAGE_BOOK, amount)
        }
        job if mage_job_allowed(job) => (MAGE_BOOK, 3),
        _ => return,
    };
    let available = points.entry(book).or_default();
    *available = available.saturating_add(amount);
}

pub(crate) fn add_exp(profile: &mut Profile, amount: u64, exp_table: &[u64]) {
    profile.exp = profile.exp.saturating_add(amount);
    while let Some(&threshold) = exp_table.get(profile.level.saturating_sub(1) as usize) {
        if threshold == 0 || profile.exp < threshold {
            profile.exp_to_next = threshold;
            break;
        }
        profile.exp -= threshold;
        profile.level = profile.level.saturating_add(1);
        profile.ability_stats.available_ap = profile.ability_stats.available_ap.saturating_add(5);
        grant_level_sp(profile.job, profile.level, &mut profile.skill_points);
        profile.exp_to_next = exp_table
            .get(profile.level.saturating_sub(1) as usize)
            .copied()
            .unwrap_or(0);
        if profile.exp_to_next == 0 {
            break;
        }
    }
    profile.exp_to_next = exp_table
        .get(profile.level.saturating_sub(1) as usize)
        .copied()
        .unwrap_or(0);
}

#[derive(Clone, Debug)]
struct StoredResolution {
    map_id: String,
    resolved: bool,
    target_id: Option<String>,
    damage: i64,
    killed: bool,
    exp_gain: u64,
    drop: Option<DropRecord>,
}

impl StoredResolution {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        let drop_id: Option<String> = row.get(6)?;
        let drop = if let Some(id) = drop_id {
            Some(DropRecord {
                id,
                item_id: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
                quantity: row
                    .get::<_, Option<i64>>(8)?
                    .unwrap_or(0)
                    .try_into()
                    .unwrap_or(0),
                x: row.get::<_, Option<f64>>(9)?.unwrap_or(0.0),
                y: row.get::<_, Option<f64>>(10)?.unwrap_or(0.0),
                owner_id: None,
                protected_until_ms: 0,
                ..DropRecord::default()
            })
        } else {
            None
        };
        Ok(Self {
            map_id: row.get(0)?,
            resolved: row.get::<_, i64>(1)? != 0,
            target_id: row.get(2)?,
            damage: row.get(3)?,
            killed: row.get::<_, i64>(4)? != 0,
            exp_gain: row.get::<_, i64>(5)?.max(0) as u64,
            drop,
        })
    }
}

fn read_damage_contributions(
    tx: &rusqlite::Transaction<'_>,
    monster_id: &str,
) -> Result<Vec<(String, i64)>, String> {
    let mut stmt = tx
        .prepare(
            "SELECT account_id,damage FROM monster_damage
             WHERE monster_id=?1 AND damage>0 ORDER BY account_id",
        )
        .map_err(|_| "account persistence failed")?;
    let rows = stmt
        .query_map([monster_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|_| "account persistence failed")?
        .collect::<Result<Vec<_>, _>>();
    rows.map_err(|_| "account persistence failed".into())
}

fn read_attack_drops(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    request_id: &str,
    legacy_drop: Option<DropRecord>,
) -> Result<Vec<DropRecord>, String> {
    let mut stmt = tx
        .prepare(
            "SELECT d.id,d.item_id,d.quantity,d.x,d.y,d.owner_account_id,d.protected_until_ms,
                    d.stats_json,d.upgrade_count,d.remaining_slots
             FROM attack_drops a JOIN drops d ON d.id=a.drop_id
             WHERE a.account_id=?1 AND a.request_id=?2 ORDER BY d.id",
        )
        .map_err(|_| "account persistence failed")?;
    let drops = stmt
        .query_map(params![account_id, request_id], |row| {
            Ok(DropRecord {
                id: row.get(0)?,
                item_id: row.get(1)?,
                quantity: row.get::<_, i64>(2)?.try_into().unwrap_or(0),
                x: row.get(3)?,
                y: row.get(4)?,
                owner_id: row.get(5)?,
                protected_until_ms: row.get(6)?,
                stats: row
                    .get::<_, String>(7)
                    .ok()
                    .and_then(|json| serde_json::from_str(&json).ok()),
                upgrade_count: row
                    .get::<_, i64>(8)
                    .ok()
                    .and_then(|value| u32::try_from(value.max(0)).ok()),
                remaining_slots: row
                    .get::<_, i64>(9)
                    .ok()
                    .and_then(|value| u32::try_from(value.max(0)).ok()),
                ..DropRecord::default()
            })
        })
        .map_err(|_| "account persistence failed")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "account persistence failed")?;
    if drops.is_empty() {
        Ok(legacy_drop.into_iter().collect())
    } else {
        Ok(drops)
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
    include!("attack_store_acceptance.rs");
    include!("third_store_acceptance.rs");
    include!("fourth_store_acceptance.rs");
    include!("hyper_store_acceptance.rs");
    include!("continuation_store_acceptance.rs");

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
        transfer.level = 9;
        transfer.exp = 4;
        transfer.exp_to_next = 19;
        transfer.mesos = 123;
        transfer.map_id = "001020000".into();
        transfer.x = 448.0;
        transfer.y = -41.0;
        transfer.skills = BTreeMap::from([(2001008, 1)]);
        transfer.skill_points = BTreeMap::from([(2, 7)]);
        store.save_profile("transfer", &transfer).unwrap();
        assert!(store.advance_job("transfer", 0, 200).unwrap());
        let transferred = store.load_profile("transfer", &defaults(300)).unwrap();
        assert_eq!(transferred.job, 200);
        assert_eq!(transferred.hp, 37);
        assert_eq!(transferred.max_hp, 61);
        assert_eq!(transferred.mp, 100);
        assert_eq!(transferred.max_mp, 100);
        assert_eq!(transferred.level, 9);
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
        assert!(store.advance_job("beginner", 0, 200).unwrap());
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
}
