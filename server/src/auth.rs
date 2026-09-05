use crate::{inventory::SLOT_LIMIT, protocol::InventoryItem};
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
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

#[derive(Clone, Debug)]
pub struct DropRecord {
    pub id: String,
    pub item_id: String,
    pub quantity: u32,
    pub x: f64,
    pub y: f64,
    pub owner_id: Option<String>,
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
    pub from_slot: u16,
    pub to_slot: Option<u16>,
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
               death_id TEXT NOT NULL DEFAULT ''
             );
             CREATE TABLE IF NOT EXISTS inventory(
               account_id TEXT NOT NULL,
               slot INTEGER NOT NULL,
               item_id TEXT NOT NULL,
               quantity INTEGER NOT NULL,
               PRIMARY KEY(account_id,slot)
             );
             CREATE TABLE IF NOT EXISTS inventory_actions(
               account_id TEXT NOT NULL,
               request_id TEXT NOT NULL,
               operation TEXT NOT NULL,
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
        // Early development databases keyed inventory by item ID, which
        // made two stacks of the same item impossible and discarded slot
        // order on every login.  Migrate those rows to the source-shaped
        // account/slot key without resetting the account database.
        let has_inventory_slot: Option<String> = db
            .query_row(
                "SELECT name FROM pragma_table_info('inventory') WHERE name='slot'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if has_inventory_slot.is_none() {
            db.execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE inventory_v2(
                   account_id TEXT NOT NULL,
                   slot INTEGER NOT NULL,
                   item_id TEXT NOT NULL,
                   quantity INTEGER NOT NULL,
                   PRIMARY KEY(account_id,slot)
                 );
                 INSERT INTO inventory_v2(account_id,slot,item_id,quantity)
                 SELECT old.account_id,
                        (SELECT COUNT(*) FROM inventory prior
                         WHERE prior.account_id=old.account_id
                           AND prior.quantity>0
                           AND prior.item_id<=old.item_id),
                        old.item_id,old.quantity
                 FROM inventory old
                 WHERE old.quantity>0;
                 DROP TABLE inventory;
                 ALTER TABLE inventory_v2 RENAME TO inventory;
                 COMMIT;",
            )?;
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
                    for drop in drops {
                        let mut drop = drop.clone();
                        drop.owner_id = Some(winner.clone());
                        tx.execute(
                            "INSERT OR IGNORE INTO drops(id,map_id,item_id,quantity,x,y,owner_account_id,active)
                             VALUES (?1,?2,?3,?4,?5,?6,?7,1)",
                            params![
                                drop.id,
                                map_id,
                                drop.item_id,
                                drop.quantity as i64,
                                drop.x,
                                drop.y,
                                drop.owner_id
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
            .prepare("SELECT id,item_id,quantity,x,y,owner_account_id FROM drops WHERE map_id=?1 AND active=1")
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
        if let Some(prior) = tx
            .query_row(
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
            .map_err(|_| "account persistence failed")?
        {
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(prior);
        }
        let drop: Option<(String, i64, Option<String>)> = tx
            .query_row(
                "SELECT item_id,quantity,owner_account_id FROM drops WHERE id=?1 AND map_id=?2 AND active=1",
                params![drop_id, map_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|_| "account persistence failed")?;
        let (item_id, quantity, slot, success, code) =
            if let Some((item_id, quantity, owner_id)) = drop {
                if owner_id.as_deref().is_some_and(|owner| owner != account_id) {
                    (item_id, quantity, None, false, "drop_owned".to_owned())
                } else if quantity <= 0 || u32::try_from(quantity).is_err() {
                    (item_id, quantity, None, false, "drop_invalid".to_owned())
                } else {
                    let quantity_u32 = u32::try_from(quantity).unwrap_or(0);
                    let add_result = if item_id == "0" {
                        Ok(Ok(None))
                    } else {
                        add_inventory_tx(&tx, account_id, &item_id, quantity_u32)
                            .map(|result| result.map(Some))
                    };
                    match add_result {
                        Err(error) => return Err(error),
                        Ok(Err(code)) => (item_id, quantity, None, false, code.to_owned()),
                        Ok(Ok(inventory_slot)) => {
                            if item_id == "0" {
                                tx.execute(
                                    "UPDATE player_stats SET mesos=mesos+?2 WHERE account_id=?1",
                                    params![account_id, quantity],
                                )
                                .map_err(|_| "account persistence failed")?;
                            }
                            let changed = tx
                            .execute(
                                "UPDATE drops SET active=0 WHERE id=?1 AND map_id=?2 AND active=1",
                                params![drop_id, map_id],
                            )
                            .map_err(|_| "account persistence failed")?;
                            if changed == 1 {
                                (item_id, quantity, inventory_slot, true, String::new())
                            } else {
                                (
                                    item_id,
                                    quantity,
                                    None,
                                    false,
                                    "drop_unavailable".to_owned(),
                                )
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
            "SELECT request_id,operation,from_slot,to_slot,item_id,quantity,drop_id,success,code
             FROM inventory_actions WHERE account_id=?1 AND request_id=?2",
            params![account_id, request_id],
            inventory_outcome_from_row,
        )
        .optional()
        .map_err(|_| "account persistence failed".into())
    }

    pub fn move_inventory(
        &self,
        account_id: &str,
        request_id: &str,
        from_slot: u16,
        to_slot: u16,
        quantity: u32,
    ) -> Result<InventoryOutcome, String> {
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        if let Some(prior) = tx
            .query_row(
                "SELECT request_id,operation,from_slot,to_slot,item_id,quantity,drop_id,success,code
                 FROM inventory_actions WHERE account_id=?1 AND request_id=?2",
                params![account_id, request_id],
                inventory_outcome_from_row,
            )
            .optional()
            .map_err(|_| "account persistence failed")?
        {
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(prior);
        }

        let source: Option<(String, i64)> = if valid_inventory_slot(from_slot) {
            tx.query_row(
                "SELECT item_id,quantity FROM inventory
                 WHERE account_id=?1 AND slot=?2 AND quantity>0",
                params![account_id, i64::from(from_slot)],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|_| "account persistence failed")?
        } else {
            None
        };
        let (item_id, _stored_quantity, success, code) = if !valid_inventory_slot(from_slot)
            || !valid_inventory_slot(to_slot)
        {
            (String::new(), 0_u32, false, "invalid_slot".to_owned())
        } else if let Some((item_id, stored_quantity_raw)) = source {
            if let Ok(stored_quantity) = u32::try_from(stored_quantity_raw) {
                if stored_quantity == 0 {
                    (item_id, 0, false, "source_empty".to_owned())
                } else if quantity == 0 {
                    (
                        item_id,
                        stored_quantity,
                        false,
                        "invalid_quantity".to_owned(),
                    )
                } else if quantity != stored_quantity {
                    (
                        item_id,
                        stored_quantity,
                        false,
                        "quantity_mismatch".to_owned(),
                    )
                } else if from_slot == to_slot {
                    (item_id, stored_quantity, true, String::new())
                } else {
                    let target: Option<(String, i64)> = tx
                        .query_row(
                            "SELECT item_id,quantity FROM inventory
                         WHERE account_id=?1 AND slot=?2 AND quantity>0",
                            params![account_id, i64::from(to_slot)],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        )
                        .optional()
                        .map_err(|_| "account persistence failed")?;
                    let mutation = match target {
                        None => {
                            tx.execute(
                                "UPDATE inventory SET slot=?3 WHERE account_id=?1 AND slot=?2",
                                params![account_id, i64::from(from_slot), i64::from(to_slot)],
                            )
                            .map_err(|_| "account persistence failed")?;
                            Ok(())
                        }
                        Some((target_item_id, target_quantity)) if target_item_id == item_id => {
                            match u32::try_from(target_quantity)
                                .ok()
                                .and_then(|target_quantity| {
                                    target_quantity.checked_add(stored_quantity)
                                }) {
                                None => Err("quantity_overflow"),
                                Some(total) => {
                                    tx.execute(
                                    "UPDATE inventory SET quantity=?3 WHERE account_id=?1 AND slot=?2",
                                    params![account_id, i64::from(to_slot), i64::from(total)],
                                )
                                .map_err(|_| "account persistence failed")?;
                                    tx.execute(
                                        "DELETE FROM inventory WHERE account_id=?1 AND slot=?2",
                                        params![account_id, i64::from(from_slot)],
                                    )
                                    .map_err(|_| "account persistence failed")?;
                                    Ok(())
                                }
                            }
                        }
                        Some((target_item_id, target_quantity)) => {
                            let Ok(target_quantity) = u32::try_from(target_quantity) else {
                                return Err("account persistence failed".into());
                            };
                            tx.execute(
                                "DELETE FROM inventory WHERE account_id=?1 AND slot IN (?2,?3)",
                                params![account_id, i64::from(from_slot), i64::from(to_slot)],
                            )
                            .map_err(|_| "account persistence failed")?;
                            tx.execute(
                            "INSERT INTO inventory(account_id,slot,item_id,quantity) VALUES (?1,?2,?3,?4)",
                            params![account_id, i64::from(to_slot), item_id, i64::from(stored_quantity)],
                        )
                        .map_err(|_| "account persistence failed")?;
                            tx.execute(
                            "INSERT INTO inventory(account_id,slot,item_id,quantity) VALUES (?1,?2,?3,?4)",
                            params![account_id, i64::from(from_slot), target_item_id, i64::from(target_quantity)],
                        )
                        .map_err(|_| "account persistence failed")?;
                            Ok(())
                        }
                    };
                    if let Err(code) = mutation {
                        (item_id, stored_quantity, false, code.to_owned())
                    } else {
                        (item_id, stored_quantity, true, String::new())
                    }
                }
            } else {
                (item_id, 0, false, "quantity_overflow".to_owned())
            }
        } else {
            (String::new(), 0, false, "source_empty".to_owned())
        };
        let outcome = InventoryOutcome {
            request_id: request_id.to_owned(),
            operation: "move".to_owned(),
            from_slot,
            to_slot: Some(to_slot),
            item_id,
            quantity,
            drop_id: None,
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
        from_slot: u16,
        quantity: u32,
        x: f64,
        y: f64,
    ) -> Result<InventoryOutcome, String> {
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        if let Some(prior) = tx
            .query_row(
                "SELECT request_id,operation,from_slot,to_slot,item_id,quantity,drop_id,success,code
                 FROM inventory_actions WHERE account_id=?1 AND request_id=?2",
                params![account_id, request_id],
                inventory_outcome_from_row,
            )
            .optional()
            .map_err(|_| "account persistence failed")?
        {
            tx.commit().map_err(|_| "account persistence failed")?;
            return Ok(prior);
        }

        let source: Option<(String, i64)> = if valid_inventory_slot(from_slot) {
            tx.query_row(
                "SELECT item_id,quantity FROM inventory
                 WHERE account_id=?1 AND slot=?2 AND quantity>0",
                params![account_id, i64::from(from_slot)],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|_| "account persistence failed")?
        } else {
            None
        };
        let mut drop_id = None;
        let (item_id, stored_quantity, success, code) = if !valid_inventory_slot(from_slot) {
            (String::new(), 0_u32, false, "invalid_slot".to_owned())
        } else if !x.is_finite() || !y.is_finite() {
            (String::new(), 0, false, "invalid_position".to_owned())
        } else if let Some((item_id, stored_quantity_raw)) = source {
            if let Ok(stored_quantity) = u32::try_from(stored_quantity_raw) {
                if stored_quantity == 0 {
                    (item_id, 0, false, "source_empty".to_owned())
                } else if quantity == 0 || quantity > stored_quantity {
                    (
                        item_id,
                        stored_quantity,
                        false,
                        "quantity_mismatch".to_owned(),
                    )
                } else {
                    if quantity == stored_quantity {
                        tx.execute(
                            "DELETE FROM inventory WHERE account_id=?1 AND slot=?2",
                            params![account_id, i64::from(from_slot)],
                        )
                    } else {
                        tx.execute(
                        "UPDATE inventory SET quantity=quantity-?3 WHERE account_id=?1 AND slot=?2",
                        params![account_id, i64::from(from_slot), i64::from(quantity)],
                    )
                    }
                    .map_err(|_| "account persistence failed")?;
                    let id = random_id();
                    tx.execute(
                        "INSERT INTO drops(id,map_id,item_id,quantity,x,y,owner_account_id,active)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,1)",
                        params![id, map_id, item_id, i64::from(quantity), x, y, account_id],
                    )
                    .map_err(|_| "account persistence failed")?;
                    drop_id = Some(id);
                    (item_id, stored_quantity, true, String::new())
                }
            } else {
                (item_id, 0, false, "quantity_overflow".to_owned())
            }
        } else {
            (String::new(), 0, false, "source_empty".to_owned())
        };
        let outcome = InventoryOutcome {
            request_id: request_id.to_owned(),
            operation: "drop".to_owned(),
            from_slot,
            to_slot: None,
            item_id,
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
            "SELECT id,item_id,quantity,x,y,owner_account_id FROM drops
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

fn valid_inventory_slot(slot: u16) -> bool {
    (1..=SLOT_LIMIT).contains(&slot)
}

fn inventory_outcome_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<InventoryOutcome> {
    Ok(InventoryOutcome {
        request_id: row.get(0)?,
        operation: row.get(1)?,
        from_slot: row.get::<_, i64>(2)?.try_into().unwrap_or(0),
        to_slot: row
            .get::<_, Option<i64>>(3)?
            .and_then(|slot| slot.try_into().ok()),
        item_id: row.get(4)?,
        quantity: row.get::<_, i64>(5)?.try_into().unwrap_or(0),
        drop_id: row.get(6)?,
        success: row.get::<_, i64>(7)? != 0,
        code: row.get(8)?,
    })
}

fn insert_inventory_action(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    outcome: &InventoryOutcome,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO inventory_actions(account_id,request_id,operation,from_slot,to_slot,item_id,quantity,drop_id,success,code)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![
            account_id,
            outcome.request_id,
            outcome.operation,
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
) -> Result<Result<u16, &'static str>, String> {
    let existing: Option<(i64, i64)> = tx
        .query_row(
            "SELECT slot,quantity FROM inventory
             WHERE account_id=?1 AND item_id=?2 AND quantity>0 ORDER BY slot LIMIT 1",
            params![account_id, item_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|_| "account persistence failed")?;
    if let Some((slot, current)) = existing {
        let Ok(slot) = u16::try_from(slot) else {
            return Ok(Err("invalid_slot"));
        };
        let Ok(current) = u32::try_from(current) else {
            return Ok(Err("quantity_overflow"));
        };
        let Some(total) = current.checked_add(quantity) else {
            return Ok(Err("quantity_overflow"));
        };
        tx.execute(
            "UPDATE inventory SET quantity=?3 WHERE account_id=?1 AND slot=?2",
            params![account_id, i64::from(slot), i64::from(total)],
        )
        .map_err(|_| "account persistence failed")?;
        return Ok(Ok(slot));
    }
    for slot in 1..=SLOT_LIMIT {
        let occupied: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM inventory WHERE account_id=?1 AND slot=?2 LIMIT 1",
                params![account_id, i64::from(slot)],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "account persistence failed")?;
        if occupied.is_none() {
            tx.execute(
                "INSERT INTO inventory(account_id,slot,item_id,quantity) VALUES (?1,?2,?3,?4)",
                params![account_id, i64::from(slot), item_id, i64::from(quantity)],
            )
            .map_err(|_| "account persistence failed")?;
            return Ok(Ok(slot));
        }
    }
    Ok(Err("inventory_full"))
}

fn read_profile(tx: &rusqlite::Transaction<'_>, account_id: &str) -> Result<Profile, String> {
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
        .prepare("SELECT slot,item_id,quantity FROM inventory WHERE account_id=?1 AND quantity>0 ORDER BY slot")
        .map_err(|_| "account persistence failed")?;
    let inventory = stmt
        .query_map([account_id], |row| {
            Ok(InventoryItem {
                slot: row.get::<_, i64>(0)?.try_into().unwrap_or(0),
                item_id: row.get(1)?,
                quantity: row.get::<_, i64>(2)?.try_into().unwrap_or(0),
            })
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
            "SELECT d.id,d.item_id,d.quantity,d.x,d.y,d.owner_account_id
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
            },
            DropRecord {
                id: "drop-meso".into(),
                item_id: "0".into(),
                quantity: 5,
                x: 0.0,
                y: 0.0,
                owner_id: None,
            },
        ];
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
            }]
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

        let moved = store.move_inventory("a", "move-1", 1, 2, 3).unwrap();
        assert!(moved.success);
        assert_eq!(moved.from_slot, 1);
        assert_eq!(moved.to_slot, Some(2));
        assert_eq!(
            store
                .move_inventory("a", "move-1", 1, 2, 3)
                .unwrap()
                .drop_id,
            None
        );
        let profile = store.load_profile("a", &defaults).unwrap();
        assert_eq!(
            profile.inventory,
            vec![
                InventoryItem {
                    slot: 2,
                    item_id: "4000019".into(),
                    quantity: 3,
                },
                InventoryItem {
                    slot: 3,
                    item_id: "2000000".into(),
                    quantity: 1,
                },
            ]
        );

        let first_drop = store
            .drop_inventory("a", "map", "drop-1", 2, 1, 10.0, 20.0)
            .unwrap();
        assert!(first_drop.success);
        let replay = store
            .drop_inventory("a", "map", "drop-1", 2, 1, 999.0, 999.0)
            .unwrap();
        assert_eq!(replay.drop_id, first_drop.drop_id);
        assert_eq!(replay.quantity, first_drop.quantity);
        let active = store
            .load_drop("map", first_drop.drop_id.as_deref().unwrap())
            .unwrap();
        assert_eq!(active.as_ref().map(|drop| drop.quantity), Some(1));
        assert_eq!(active.as_ref().map(|drop| drop.x), Some(10.0));
        let profile = store.load_profile("a", &defaults).unwrap();
        assert_eq!(profile.inventory[0].quantity, 2);

        drop(store);
        drop(auth);
        std::thread::sleep(Duration::from_millis(20));
        let auth = start(&path).unwrap();
        let profile = auth.store.load_profile("a", &defaults).unwrap();
        assert_eq!(profile.inventory[0].slot, 2);
        assert_eq!(profile.inventory[0].quantity, 2);
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
}
