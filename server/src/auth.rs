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
    Verify(String, oneshot::Sender<Option<Identity>>),
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
pub struct Profile {
    pub hp: i64,
    pub max_hp: i64,
    pub mp: i64,
    pub max_mp: i64,
    pub level: u32,
    pub exp: u64,
    pub exp_to_next: u64,
    pub mesos: u64,
    pub death_id: String,
    pub inventory: Vec<InventoryItem>,
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

#[derive(Clone, Debug)]
pub struct ReviveOutcome {
    pub request_id: String,
    pub death_id: String,
    pub success: bool,
    pub code: String,
}

pub fn random_id() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub(crate) const DROP_PROTECTION_MS: i64 = 60_000;

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
        })
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
               exp INTEGER NOT NULL,
               exp_to_next INTEGER NOT NULL,
               mesos INTEGER NOT NULL DEFAULT 0,
               death_id TEXT NOT NULL DEFAULT '',
               starter_equipment_seeded INTEGER NOT NULL DEFAULT 0
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
               drop_id TEXT
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
        Ok(())
    }

    pub fn load_profile(&self, account_id: &str, defaults: &Profile) -> Result<Profile, String> {
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        tx.execute(
            "INSERT OR IGNORE INTO player_stats(account_id,hp,max_hp,mp,max_mp,level,exp,exp_to_next,mesos,death_id)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'')",
            params![
                account_id,
                defaults.hp,
                defaults.max_hp,
                defaults.mp,
                defaults.max_mp,
                defaults.level,
                defaults.exp,
                defaults.exp_to_next,
                i64::try_from(defaults.mesos).map_err(|_| "account persistence failed")?
            ],
        )
        .map_err(|_| "account persistence failed")?;
        ensure_starter_equipment_tx(&tx, account_id)?;
        normalize_equipped_tx(&tx)?;
        let profile = read_profile(&tx, account_id)?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(profile)
    }

    pub fn save_profile(&self, account_id: &str, profile: &Profile) -> Result<(), String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        db.execute(
            "UPDATE player_stats SET hp=?2,max_hp=?3,mp=?4,max_mp=?5,level=?6,exp=?7,exp_to_next=?8,mesos=?9,death_id=?10
             WHERE account_id=?1",
            params![
                account_id,
                profile.hp,
                profile.max_hp,
                profile.mp,
                profile.max_mp,
                profile.level,
                profile.exp,
                profile.exp_to_next,
                i64::try_from(profile.mesos).map_err(|_| "account persistence failed")?,
                profile.death_id
            ],
        )
        .map_err(|_| "account persistence failed")?;
        Ok(())
    }

    pub fn claim_attack(
        &self,
        account_id: &str,
        request_id: &str,
        action_id: &str,
        event: &str,
    ) -> Result<AttackClaim, String> {
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        let prior: Option<(String, String, i64)> = tx
            .query_row(
                "SELECT action_id,event,resolved FROM attack_actions WHERE account_id=?1 AND request_id=?2",
                params![account_id, request_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|_| "account persistence failed")?;
        if let Some((action_id, event, resolved)) = prior {
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(AttackClaim {
                action_id,
                event,
                resolved: resolved != 0,
            });
        }
        tx.execute(
            "INSERT INTO attack_actions(account_id,request_id,action_id,event) VALUES (?1,?2,?3,?4)",
            params![account_id, request_id, action_id, event],
        )
        .map_err(|_| "account persistence failed")?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(AttackClaim {
            action_id: action_id.to_owned(),
            event: event.to_owned(),
            resolved: false,
        })
    }

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
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        let prior: Option<StoredResolution> = tx
            .query_row(
                "SELECT resolved,target_id,damage,killed,exp_gain,drop_id,drop_item_id,drop_quantity,drop_x,drop_y
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

        if let Some(monster_id) = target_id.filter(|_| damage > 0) {
            tx.execute(
                "INSERT INTO monster_damage(monster_id,account_id,damage) VALUES (?1,?2,?3)
                 ON CONFLICT(monster_id,account_id) DO UPDATE SET damage=damage+excluded.damage",
                params![monster_id, account_id, damage],
            )
            .map_err(|_| "account persistence failed")?;
        }

        let mut awarded_exp = 0u64;
        let mut awarded_drops = Vec::new();
        let mut reward_claimed = false;
        let mut profiles = Vec::new();
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
                let exp_gain = i64::try_from(exp_gain).map_err(|_| "account persistence failed")?;
                reward_claimed = tx
                    .execute(
                        "INSERT OR IGNORE INTO monster_rewards(monster_id,account_id,request_id,exp_gain,drop_id)
                         VALUES (?1,?2,?3,?4,?5)",
                        params![
                            monster_id,
                            winner.as_str(),
                            request_id,
                            exp_gain,
                            drops.first().map(|d| d.id.as_str())
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
                        let share = ((exp_gain.max(0) as f64) * (contribution.max(0) as f64)
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
                        profiles.push((participant, profile));
                    }
                    let protected_until_ms = now_ms().saturating_add(DROP_PROTECTION_MS);
                    for drop in drops {
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

        let profile = profiles
            .iter()
            .find(|(participant, _)| participant == account_id)
            .map(|(_, profile)| profile.clone());
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
            profiles,
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
            inventory::equip_items(&mut inventory, &mut equipped, stats, from_slot, to_slot)
        } else if operation == "unequip" {
            inventory::unequip_items(&mut inventory, &mut equipped, from_slot, to_slot)
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
                    let destination = (1..=SLOT_LIMIT as i16).find(|slot| {
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
            } else if let Ok((hp, mp)) = inventory::use_effect(item_id) {
                inventory::remove_items(&mut inventory, 2, source_slot, 1).and_then(|_| {
                    let changed = tx
                        .execute(
                            "UPDATE player_stats SET hp=MIN(max_hp,hp+?2),mp=MIN(max_mp,mp+?3)
                                 WHERE account_id=?1",
                            params![account_id, hp, mp],
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
    match inventory::add_items(&mut inventory_items, item_id.to_owned(), quantity) {
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
    let (hp, max_hp, mp, max_mp, level, exp, exp_to_next, mesos, death_id):
        (i64, i64, i64, i64, i64, i64, i64, i64, String) = tx
        .query_row(
            "SELECT hp,max_hp,mp,max_mp,level,exp,exp_to_next,mesos,death_id FROM player_stats WHERE account_id=?1",
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
                ))
            },
        )
        .map_err(|_| "account persistence failed")?;
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
    Ok(Profile {
        hp: hp.max(0),
        max_hp: max_hp.max(1),
        mp: mp.max(0),
        max_mp: max_mp.max(0),
        level: level.max(1) as u32,
        exp: exp.max(0) as u64,
        exp_to_next: exp_to_next.max(0) as u64,
        mesos: mesos.max(0) as u64,
        death_id,
        inventory,
    })
}

fn write_profile(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    profile: &Profile,
) -> Result<(), String> {
    tx.execute(
        "UPDATE player_stats SET hp=?2,max_hp=?3,mp=?4,max_mp=?5,level=?6,exp=?7,exp_to_next=?8,mesos=?9,death_id=?10
         WHERE account_id=?1",
        params![
            account_id,
            profile.hp,
            profile.max_hp,
            profile.mp,
            profile.max_mp,
            profile.level,
            profile.exp,
            profile.exp_to_next,
            i64::try_from(profile.mesos).map_err(|_| "account persistence failed")?,
            profile.death_id
        ],
    )
    .map_err(|_| "account persistence failed")?;
    Ok(())
}

fn add_exp(profile: &mut Profile, amount: u64, exp_table: &[u64]) {
    profile.exp = profile.exp.saturating_add(amount);
    while let Some(&threshold) = exp_table.get(profile.level.saturating_sub(1) as usize) {
        if threshold == 0 || profile.exp < threshold {
            profile.exp_to_next = threshold;
            break;
        }
        profile.exp -= threshold;
        profile.level = profile.level.saturating_add(1);
        profile.exp_to_next = exp_table
            .get(profile.level.saturating_sub(1) as usize)
            .copied()
            .unwrap_or(0);
        if profile.exp_to_next == 0 {
            break;
        }
    }
}

#[derive(Clone, Debug)]
struct StoredResolution {
    resolved: bool,
    target_id: Option<String>,
    damage: i64,
    killed: bool,
    exp_gain: u64,
    drop: Option<DropRecord>,
}

impl StoredResolution {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        let drop_id: Option<String> = row.get(5)?;
        let drop = if let Some(id) = drop_id {
            Some(DropRecord {
                id,
                item_id: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                quantity: row
                    .get::<_, Option<i64>>(7)?
                    .unwrap_or(0)
                    .try_into()
                    .unwrap_or(0),
                x: row.get::<_, Option<f64>>(8)?.unwrap_or(0.0),
                y: row.get::<_, Option<f64>>(9)?.unwrap_or(0.0),
                owner_id: None,
                protected_until_ms: 0,
                ..DropRecord::default()
            })
        } else {
            None
        };
        Ok(Self {
            resolved: row.get::<_, i64>(0)? != 0,
            target_id: row.get(1)?,
            damage: row.get(2)?,
            killed: row.get::<_, i64>(3)? != 0,
            exp_gain: row.get::<_, i64>(4)?.max(0) as u64,
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
    std::thread::spawn(move || {
        let mut sessions: HashMap<String, (String, Identity, Instant)> = HashMap::new();
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
                        sessions.retain(|_, (_, _, expiry)| *expiry > Instant::now());
                        sessions.insert(
                            identity.id.clone(),
                            (
                                token.clone(),
                                identity.clone(),
                                Instant::now() + Duration::from_secs(86400),
                            ),
                        );
                        Ok((identity, token))
                    })()
                    .map_err(str::to_owned);
                    let _ = reply.send(result);
                }
                Request::Verify(token, reply) => {
                    let identity = sessions
                        .values()
                        .find(|(t, _, expiry)| t == &token && *expiry > Instant::now())
                        .map(|(_, i, _)| i.clone());
                    let _ = reply.send(identity);
                }
            }
        }
    });
    Ok(AuthService { sender: tx, store })
}

#[cfg(test)]
mod tests {
    use super::*;

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
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            death_id: String::new(),
            inventory: Vec::new(),
        };
        store.load_profile("a", &defaults).unwrap();
        store.load_profile("b", &defaults).unwrap();
        store
            .claim_attack("a", "attack-1", "action-1", "started")
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
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            death_id: String::new(),
            inventory: Vec::new(),
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
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            death_id: String::new(),
            inventory: Vec::new(),
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
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            death_id: String::new(),
            inventory: Vec::new(),
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
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            death_id: String::new(),
            inventory: Vec::new(),
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
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            death_id: String::new(),
            inventory: Vec::new(),
        };
        store.load_profile("a", &defaults).unwrap();
        store.load_profile("b", &defaults).unwrap();
        let active = vec!["a".to_owned(), "b".to_owned()];
        store
            .claim_attack("a", "attack-a", "action-a", "started")
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
            .claim_attack("b", "attack-b", "action-b", "started")
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
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            death_id: String::new(),
            inventory: Vec::new(),
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
                "INSERT INTO inventory(account_id,slot,item_id,quantity) VALUES ('a',2,'2040002',2)",
                [],
            )
            .unwrap();
            db.execute(
                "INSERT INTO equipped(account_id,slot,item_id,quantity,stats_json,upgrade_count,remaining_slots)
                 VALUES ('a',-1,'1002067',1,?1,0,7)",
                [serde_json::to_string(&inventory::equipment_attributes("1002067")).unwrap()],
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
                "2040002",
                Some(-5),
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
            .find(|item| item.item_id == "2040002")
            .unwrap();
        assert_eq!(scroll_stack.quantity, 2);

        let valid_scroll = store
            .use_item(
                "a",
                "scroll-valid-target",
                2,
                2,
                "2040002",
                Some(-1),
                Some("1002067"),
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
            .find(|item| item.item_id == "1002067")
            .unwrap();
        assert_eq!(helmet.remaining_slots, Some(6));
        let helmet_stats = helmet.stats.as_ref().unwrap();
        assert!(matches!(helmet_stats.get("incPDD"), Some(5) | Some(10)));

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
            .find(|item| item.item_id == "1002067")
            .unwrap();
        assert_eq!(helmet.remaining_slots, Some(6));
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
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            death_id: String::new(),
            inventory: Vec::new(),
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
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            death_id: String::new(),
            inventory: Vec::new(),
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
            exp: 0,
            exp_to_next: 15,
            mesos: 0,
            death_id: String::new(),
            inventory: Vec::new(),
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
