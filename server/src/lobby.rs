use crate::{
    auth::Store,
    inventory,
    protocol::{InventoryItem, CONTENT_VERSION, PROTOCOL_VERSION},
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::PathBuf,
};

pub const CHANNEL_ID: u32 = 1;
pub const CHARACTER_SLOT_LIMIT: u32 = 12;

#[derive(Clone, Debug)]
pub struct HttpRequest {
    pub token: String,
    pub action: Action,
}

impl<'de> Deserialize<'de> for HttpRequest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        let object = value
            .as_object()
            .ok_or_else(|| serde::de::Error::custom("expected lobby object"))?;
        let token = object
            .get("token")
            .and_then(Value::as_str)
            .ok_or_else(|| serde::de::Error::custom("missing lobby token"))?
            .to_owned();
        let mut action_object = object.clone();
        action_object.remove("token");
        let action = serde_json::from_value(Value::Object(action_object))
            .map_err(serde::de::Error::custom)?;
        Ok(Self { token, action })
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum Action {
    List {
        #[serde(default, rename = "channelId")]
        channel_id: Option<u32>,
    },
    CheckName {
        name: String,
    },
    Create {
        #[serde(rename = "requestId")]
        request_id: String,
        name: String,
        appearance: Appearance,
    },
    Select {
        #[serde(rename = "characterId")]
        character_id: String,
        #[serde(default, rename = "channelId")]
        channel_id: Option<u32>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Appearance {
    pub gender: u8,
    pub face: u32,
    pub hair: u32,
    pub skin: u32,
    pub coat: u32,
    pub pants: u32,
    pub shoes: u32,
    pub weapon: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreationCatalog {
    source: String,
    skin: Vec<u32>,
    genders: Vec<GenderOptions>,
    #[serde(default)]
    names: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GenderOptions {
    gender: u8,
    face: Vec<u32>,
    hair: Vec<u32>,
    #[serde(default)]
    hair_colors: BTreeMap<String, Vec<u32>>,
    coat: Vec<u32>,
    pants: Vec<u32>,
    shoes: Vec<u32>,
    weapon: Vec<u32>,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            gender: 0,
            face: 20_000,
            hair: 30_020,
            skin: 0,
            coat: 1_040_002,
            pants: 1_060_003,
            shoes: 1_070_000,
            weapon: 1_302_000,
        }
    }
}

#[cfg(test)]
fn creation_default() -> Appearance {
    Appearance {
        gender: 0,
        face: 20_100,
        hair: 30_000,
        skin: 0,
        coat: 1_050_286,
        pants: 0,
        shoes: 1_072_833,
        weapon: 1_302_000,
    }
}

impl Appearance {
    fn validate(&self) -> Result<(), String> {
        let path = std::env::var_os("CHARACTER_CREATION_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../shared/character-creation.json"
                ))
            });
        match fs::read_to_string(path) {
            Ok(contents) => {
                let catalog: CreationCatalog = serde_json::from_str(&contents)
                    .map_err(|_| "appearance catalog invalid".to_owned())?;
                let _ = (&catalog.source, &catalog.names);
                let Some(options) = catalog
                    .genders
                    .iter()
                    .find(|group| group.gender == self.gender)
                else {
                    return Err("appearance option unavailable".to_owned());
                };
                let hair_allowed = options.hair.contains(&self.hair)
                    || options
                        .hair_colors
                        .values()
                        .any(|colors| colors.contains(&self.hair));
                if !catalog.skin.contains(&self.skin)
                    || !options.face.contains(&self.face)
                    || !hair_allowed
                    || !options.coat.contains(&self.coat)
                    || !options.pants.contains(&self.pants)
                    || !options.shoes.contains(&self.shoes)
                    || !options.weapon.contains(&self.weapon)
                {
                    return Err("appearance option unavailable".to_owned());
                }
                return Ok(());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("appearance catalog unavailable".to_owned()),
        }
        // Only the source-backed 273 look currently has exported paper-doll
        // assets. Extend these lists when another look is exported and checked.
        if self.gender > 1
            || self.face != 20_000
            || self.hair != 30_020
            || self.skin != 0
            || self.coat != 1_040_002
            || self.pants != 1_060_003
            || self.shoes != 1_070_000
            || self.weapon != 1_302_000
        {
            return Err("appearance option unavailable".to_owned());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CharacterSummary {
    pub id: String,
    pub name: String,
    pub level: u32,
    pub job: u32,
    pub appearance: Appearance,
}

pub enum Response {
    List {
        characters: Vec<CharacterSummary>,
        slot_limit: u32,
        channel_id: u32,
    },
    NameCheck {
        available: bool,
    },
    Created {
        character: CharacterSummary,
    },
    Selected {
        token: Option<String>,
        character: CharacterSummary,
        channel_id: u32,
    },
}

impl Response {
    pub fn into_json(self) -> Value {
        match self {
            Self::List {
                characters,
                slot_limit,
                channel_id,
            } => serde_json::json!({
                "characters": characters,
                "slotLimit": slot_limit,
                "channelId": channel_id,
            }),
            Self::NameCheck { available } => serde_json::json!({ "available": available }),
            Self::Created { character } => serde_json::json!({ "character": character }),
            Self::Selected {
                token,
                character,
                channel_id,
            } => serde_json::json!({
                "token": token,
                "playerId": character.id,
                "username": character.name,
                "protocolVersion": PROTOCOL_VERSION,
                "contentVersion": CONTENT_VERSION,
                "channelId": channel_id,
                "character": character,
            }),
        }
    }

    pub(crate) fn with_token(self, token: String) -> (Self, Option<CharacterSummary>) {
        match self {
            Self::Selected {
                token: _,
                character,
                channel_id,
            } => {
                let identity = character.clone();
                (
                    Self::Selected {
                        token: Some(token),
                        character,
                        channel_id,
                    },
                    Some(identity),
                )
            }
            response => (response, None),
        }
    }
}

pub(crate) fn init(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS characters(
           id TEXT PRIMARY KEY,
           account_id TEXT NOT NULL,
           name TEXT NOT NULL,
           name_key TEXT NOT NULL UNIQUE,
           appearance_json TEXT NOT NULL,
           request_id TEXT NOT NULL DEFAULT '',
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           UNIQUE(account_id,request_id),
           FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS characters_account_id ON characters(account_id);",
    )?;

    // A development build may have created this table before case-folded
    // names were added. Migrate that table in place and fail closed if two
    // existing names collide after normalization.
    let has_name_key: Option<String> = db
        .query_row(
            "SELECT name FROM pragma_table_info('characters') WHERE name='name_key'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if has_name_key.is_none() {
        db.execute(
            "ALTER TABLE characters ADD COLUMN name_key TEXT NOT NULL DEFAULT ''",
            [],
        )?;
        let names: Vec<(String, String)> = {
            let mut stmt = db.prepare("SELECT id,name FROM characters")?;
            let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let normalized: Vec<(String, String)> = names
            .into_iter()
            .map(|(id, name)| (id, normalize_name(&name)))
            .collect();
        let mut seen = BTreeSet::new();
        if normalized.iter().any(|(_, key)| !seen.insert(key.clone())) {
            return Err(rusqlite::Error::InvalidQuery);
        }
        for (id, key) in normalized {
            db.execute(
                "UPDATE characters SET name_key=?1 WHERE id=?2",
                params![key, id],
            )?;
        }
    }
    db.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS characters_name_key_unique
         ON characters(name_key)",
        [],
    )?;
    migrate_legacy(db)
}

fn migrate_legacy(db: &Connection) -> rusqlite::Result<()> {
    let appearance =
        serde_json::to_string(&Appearance::default()).map_err(|_| rusqlite::Error::InvalidQuery)?;
    let now = crate::auth::now_ms();
    let candidates: Vec<(String, String, String)> = {
        let mut stmt = db.prepare(
            "SELECT p.account_id,a.username,lower(a.username)
             FROM player_stats p JOIN accounts a ON a.id=p.account_id
             WHERE NOT EXISTS(
               SELECT 1 FROM characters c WHERE c.account_id=p.account_id
             )",
        )?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let mut candidate_names = BTreeSet::new();
    for (_, _, name_key) in &candidates {
        if !candidate_names.insert(name_key.clone()) {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let occupied: Option<i64> = db
            .query_row(
                "SELECT 1 FROM characters WHERE name_key=?1 LIMIT 1",
                [name_key],
                |row| row.get(0),
            )
            .optional()?;
        if occupied.is_some() {
            return Err(rusqlite::Error::InvalidQuery);
        }
    }
    for (account_id, username, name_key) in &candidates {
        db.execute(
            "INSERT OR IGNORE INTO characters(
               id,account_id,name,name_key,appearance_json,request_id,created_at,updated_at
             ) VALUES(?1,?1,?2,?3,?4,'legacy',?5,?5)",
            params![account_id, username, name_key, appearance, now],
        )?;
    }
    // INSERT OR IGNORE is used to keep startup idempotent. Verify that it did
    // not hide a case-folded collision, otherwise an old save would disappear
    // from the character list and could be claimed by a new character.
    for (account_id, _, _) in candidates {
        let materialized: Option<i64> = db
            .query_row(
                "SELECT 1 FROM characters WHERE id=?1 AND account_id=?1",
                [&account_id],
                |row| row.get(0),
            )
            .optional()?;
        if materialized.is_none() {
            return Err(rusqlite::Error::InvalidQuery);
        }
    }
    Ok(())
}

pub(crate) fn handle(store: &Store, account_id: &str, action: Action) -> Result<Response, String> {
    store.with_db(|db| {
        let tx = db
            .transaction()
            .map_err(|_| "account persistence failed".to_owned())?;
        let account_exists: Option<i64> = tx
            .query_row("SELECT 1 FROM accounts WHERE id=?1", [account_id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|_| "account persistence failed".to_owned())?;
        if account_exists.is_none() {
            return Err("invalid session".to_owned());
        }
        let response = match action {
            Action::List { channel_id } => {
                validate_channel(channel_id)?;
                ensure_legacy(&tx, account_id)?;
                Response::List {
                    characters: list_characters(&tx, account_id)?,
                    slot_limit: CHARACTER_SLOT_LIMIT,
                    channel_id: CHANNEL_ID,
                }
            }
            Action::CheckName { name } => {
                validate_name(&name)?;
                ensure_legacy(&tx, account_id)?;
                let exists: Option<i64> = tx
                    .query_row(
                        "SELECT 1 FROM characters WHERE name_key=?1 LIMIT 1",
                        [normalize_name(&name)],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|_| "account persistence failed".to_owned())?;
                Response::NameCheck {
                    available: exists.is_none(),
                }
            }
            Action::Create {
                request_id,
                name,
                appearance,
            } => {
                validate_id(&request_id, "request id")?;
                validate_name(&name)?;
                appearance.validate()?;
                ensure_legacy(&tx, account_id)?;
                create_character(&tx, account_id, &request_id, &name, appearance)?
            }
            Action::Select {
                character_id,
                channel_id,
            } => {
                validate_channel(channel_id)?;
                validate_id(&character_id, "character id")?;
                ensure_legacy(&tx, account_id)?;
                let character = find_character(&tx, account_id, &character_id)?
                    .ok_or_else(|| "character not found".to_owned())?;
                Response::Selected {
                    token: None,
                    character,
                    channel_id: CHANNEL_ID,
                }
            }
        };
        tx.commit()
            .map_err(|_| "account persistence failed".to_owned())?;
        Ok(response)
    })
}

fn validate_channel(channel_id: Option<u32>) -> Result<(), String> {
    if channel_id.is_some_and(|id| id != CHANNEL_ID) {
        Err("channel unavailable".to_owned())
    } else {
        Ok(())
    }
}

fn validate_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-.:".contains(&byte))
    {
        Err(format!("invalid {label}"))
    } else {
        Ok(())
    }
}

fn validate_name(name: &str) -> Result<(), String> {
    if !(2..=12).contains(&name.chars().count())
        || !name.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '_' | '-')
                || is_cjk_ideograph(character)
        })
    {
        Err("invalid character name".to_owned())
    } else {
        Ok(())
    }
}

fn normalize_name(name: &str) -> String {
    name.chars()
        .map(|character| character.to_ascii_lowercase())
        .collect()
}

fn is_cjk_ideograph(character: char) -> bool {
    matches!(
        character as u32,
        0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xF900..=0xFAFF
            | 0x20000..=0x2FA1F
    )
}

fn ensure_legacy(tx: &Transaction<'_>, account_id: &str) -> Result<(), String> {
    let has_character: Option<i64> = tx
        .query_row(
            "SELECT 1 FROM characters WHERE account_id=?1 LIMIT 1",
            [account_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "account persistence failed".to_owned())?;
    if has_character.is_some() {
        return Ok(());
    }
    let username: Option<String> = tx
        .query_row(
            "SELECT a.username FROM accounts a
             WHERE a.id=?1 AND EXISTS(SELECT 1 FROM player_stats p WHERE p.account_id=a.id)",
            [account_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "account persistence failed".to_owned())?;
    let Some(username) = username else {
        return Ok(());
    };
    let appearance = serde_json::to_string(&Appearance::default())
        .map_err(|_| "account persistence failed".to_owned())?;
    let now = crate::auth::now_ms();
    let name_key = normalize_name(&username);
    tx.execute(
        "INSERT OR IGNORE INTO characters(
           id,account_id,name,name_key,appearance_json,request_id,created_at,updated_at
         ) VALUES(?1,?1,?2,?3,?4,'legacy',?5,?5)",
        params![account_id, username, name_key, appearance, now],
    )
    .map_err(|error| {
        if error.sqlite_error_code() == Some(rusqlite::ErrorCode::ConstraintViolation) {
            "legacy character name already exists".to_owned()
        } else {
            "account persistence failed".to_owned()
        }
    })?;
    let materialized: Option<i64> = tx
        .query_row(
            "SELECT 1 FROM characters WHERE id=?1 AND account_id=?1",
            [account_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "account persistence failed".to_owned())?;
    if materialized.is_none() {
        return Err("legacy character name already exists".to_owned());
    }
    Ok(())
}

fn create_character(
    tx: &Transaction<'_>,
    account_id: &str,
    request_id: &str,
    name: &str,
    appearance: Appearance,
) -> Result<Response, String> {
    let prior: Option<String> = tx
        .query_row(
            "SELECT id FROM characters WHERE account_id=?1 AND request_id=?2",
            params![account_id, request_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "account persistence failed".to_owned())?;
    if let Some(id) = prior {
        let character = find_character(tx, account_id, &id)?
            .ok_or_else(|| "account persistence failed".to_owned())?;
        if character.name == name && character.appearance == appearance {
            return Ok(Response::Created { character });
        }
        // The request id is scoped to an account. A changed body must not
        // create a second character or mutate the original one.
        return Err("request conflict".to_owned());
    }
    let count: u32 = tx
        .query_row(
            "SELECT COUNT(*) FROM characters WHERE account_id=?1",
            [account_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| "account persistence failed".to_owned())?
        .try_into()
        .map_err(|_| "account persistence failed".to_owned())?;
    if count >= CHARACTER_SLOT_LIMIT {
        return Err("character slots full".to_owned());
    }
    let name_exists: Option<i64> = tx
        .query_row(
            "SELECT 1 FROM characters WHERE name_key=?1 LIMIT 1",
            [normalize_name(name)],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "account persistence failed".to_owned())?;
    if name_exists.is_some() {
        return Err("name already exists".to_owned());
    }
    let id = crate::auth::random_id();
    let appearance_json =
        serde_json::to_string(&appearance).map_err(|_| "account persistence failed".to_owned())?;
    let now = crate::auth::now_ms();
    tx.execute(
        "INSERT INTO characters(
           id,account_id,name,name_key,appearance_json,request_id,created_at,updated_at
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?7)",
        params![
            id,
            account_id,
            name,
            normalize_name(name),
            appearance_json,
            request_id,
            now
        ],
    )
    .map_err(|_| "account persistence failed".to_owned())?;
    seed_character_equipment(tx, &id, &appearance)?;
    let character = find_character(tx, account_id, &id)?
        .ok_or_else(|| "account persistence failed".to_owned())?;
    Ok(Response::Created { character })
}

fn seed_character_equipment(
    tx: &Transaction<'_>,
    character_id: &str,
    appearance: &Appearance,
) -> Result<(), String> {
    // The three visible beginner slots are part of the created character's
    // durable state. Pants stay empty for the modern overall-style looks;
    // the selected coat occupies slot -5.
    let mut equipment = vec![
        (5_u16, appearance.coat),
        (7_u16, appearance.shoes),
        (11_u16, appearance.weapon),
    ];
    if appearance.pants != 0 {
        equipment.push((6_u16, appearance.pants));
    }
    for (slot, item_id) in equipment {
        let mut item = InventoryItem {
            slot,
            item_id: item_id.to_string(),
            quantity: 1,
            ..InventoryItem::default()
        };
        inventory::ensure_equipment_instance(&mut item);
        let stats_json = serde_json::to_string(&item.stats.clone().unwrap_or_default())
            .map_err(|_| "account persistence failed".to_owned())?;
        tx.execute(
            "INSERT INTO equipped(
               account_id,slot,item_id,quantity,stats_json,upgrade_count,remaining_slots
             ) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                character_id,
                -i64::from(slot),
                item.item_id,
                i64::from(item.quantity),
                stats_json,
                i64::from(item.upgrade_count.unwrap_or(0)),
                i64::from(item.remaining_slots.unwrap_or(0)),
            ],
        )
        .map_err(|_| "account persistence failed".to_owned())?;
    }
    Ok(())
}

fn list_characters(
    tx: &Transaction<'_>,
    account_id: &str,
) -> Result<Vec<CharacterSummary>, String> {
    let mut stmt = tx
        .prepare(
            "SELECT c.id,c.name,c.appearance_json,
                    COALESCE(p.level,1),COALESCE(p.job,0)
             FROM characters c LEFT JOIN player_stats p ON p.account_id=c.id
             WHERE c.account_id=?1 ORDER BY c.created_at,c.id",
        )
        .map_err(|_| "account persistence failed".to_owned())?;
    let rows = stmt
        .query_map([account_id], character_from_row)
        .map_err(|_| "account persistence failed".to_owned())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| "invalid saved character".to_owned())
}

fn find_character(
    tx: &Transaction<'_>,
    account_id: &str,
    character_id: &str,
) -> Result<Option<CharacterSummary>, String> {
    tx.query_row(
        "SELECT c.id,c.name,c.appearance_json,
                COALESCE(p.level,1),COALESCE(p.job,0)
         FROM characters c LEFT JOIN player_stats p ON p.account_id=c.id
         WHERE c.account_id=?1 AND c.id=?2",
        params![account_id, character_id],
        character_from_row,
    )
    .optional()
    .map_err(|_| "account persistence failed".to_owned())
}

pub(crate) fn character_appearance(
    store: &Store,
    character_id: &str,
) -> Result<Option<Appearance>, String> {
    store.with_db(|db| {
        let appearance_json: Option<String> = db
            .query_row(
                "SELECT appearance_json FROM characters WHERE id=?1",
                [character_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "account persistence failed".to_owned())?;
        appearance_json
            .map(|json| {
                serde_json::from_str(&json).map_err(|_| "invalid saved appearance".to_owned())
            })
            .transpose()
    })
}

pub(crate) fn legacy_identity(
    store: &Store,
    account_id: &str,
) -> Result<Option<(String, String)>, String> {
    store.with_db(|db| {
        db.query_row(
            "SELECT c.id,c.name
             FROM characters c
             WHERE c.account_id=?1 AND c.id=?1
               AND EXISTS(SELECT 1 FROM player_stats p WHERE p.account_id=?1)
               AND (SELECT COUNT(*) FROM characters WHERE account_id=?1)=1",
            [account_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|_| "account persistence failed".to_owned())
    })
}

fn character_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CharacterSummary> {
    let appearance_json: String = row.get(2)?;
    let appearance: Appearance =
        serde_json::from_str(&appearance_json).map_err(|_| rusqlite::Error::InvalidQuery)?;
    Ok(CharacterSummary {
        id: row.get(0)?,
        name: row.get(1)?,
        appearance,
        level: row.get::<_, i64>(3)?.try_into().unwrap_or(1),
        job: row.get::<_, i64>(4)?.try_into().unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        auth::{self, Credentials, Profile},
        protocol::AbilityStats,
    };
    use serde_json::json;
    use std::{collections::BTreeMap, fs};
    use tokio::sync::oneshot;

    fn defaults() -> Profile {
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
            cash: 0,
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

    #[test]
    fn http_contract_accepts_camel_case_and_rejects_unknown_fields() {
        let request: HttpRequest = serde_json::from_value(json!({
            "token": "account-token",
            "action": "create",
            "requestId": "request-1",
            "name": "MageOne",
            "appearance": Appearance::default(),
        }))
        .unwrap();
        assert!(matches!(request.action, Action::Create { .. }));
        assert!(serde_json::from_value::<HttpRequest>(json!({
            "token": "account-token",
            "action": "list",
            "unexpected": true,
        }))
        .is_err());
    }

    #[test]
    fn appearance_validation_rejects_ids_outside_the_source_catalog() {
        let mut appearance = creation_default();
        appearance.face = 20_000;
        assert_eq!(
            appearance.validate(),
            Err("appearance option unavailable".to_owned())
        );
    }

    #[tokio::test]
    async fn characters_are_isolated_and_appearance_is_persistent() {
        let path = std::env::temp_dir().join(format!("maple-lobby-{}.sqlite3", auth::random_id()));
        let service = auth::start(&path).unwrap();
        let (reply, rx) = oneshot::channel();
        service
            .sender
            .send(auth::Request::Register(
                Credentials {
                    username: "lobby-user".into(),
                    password: "correct-password".into(),
                },
                reply,
            ))
            .await
            .unwrap();
        rx.await.unwrap().unwrap();
        let (reply, rx) = oneshot::channel();
        service
            .sender
            .send(auth::Request::Login(
                Credentials {
                    username: "lobby-user".into(),
                    password: "correct-password".into(),
                },
                reply,
            ))
            .await
            .unwrap();
        let (identity, account_token) = rx.await.unwrap().unwrap();
        let first = match handle(
            &service.store,
            &identity.id,
            Action::Create {
                request_id: "create-1".into(),
                name: "MageOne".into(),
                appearance: creation_default(),
            },
        )
        .unwrap()
        {
            Response::Created { character } => character,
            _ => panic!("unexpected response"),
        };
        let replay = match handle(
            &service.store,
            &identity.id,
            Action::Create {
                request_id: "create-1".into(),
                name: "MageOne".into(),
                appearance: creation_default(),
            },
        )
        .unwrap()
        {
            Response::Created { character } => character,
            _ => panic!("unexpected response"),
        };
        assert_eq!(first, replay);
        let seeded = service.store.load_equipped(&first.id).unwrap();
        assert_eq!(seeded.len(), 3);
        assert_eq!(
            seeded
                .iter()
                .map(|item| (item.slot, item.item_id.as_str()))
                .collect::<Vec<_>>(),
            vec![(11, "1302000"), (7, "1072833"), (5, "1050286")]
        );
        assert!(
            matches!(handle(&service.store, &identity.id, Action::Create {
            request_id: "create-1".into(), name: "mageone".into(), appearance: creation_default(),
        }), Err(error) if error == "request conflict")
        );
        assert!(matches!(
            handle(
                &service.store,
                &identity.id,
                Action::CheckName {
                    name: "mageone".into(),
                }
            )
            .unwrap(),
            Response::NameCheck { available: false }
        ));

        let (reply, rx) = oneshot::channel();
        service
            .sender
            .send(auth::Request::Lobby {
                token: account_token.clone(),
                action: Action::Select {
                    character_id: first.id.clone(),
                    channel_id: Some(CHANNEL_ID),
                },
                reply,
            })
            .await
            .unwrap();
        let role_token = match rx.await.unwrap().unwrap() {
            Response::Selected {
                token: Some(token),
                character,
                ..
            } => {
                assert_eq!(character.id, first.id);
                token
            }
            _ => panic!("unexpected response"),
        };
        let (reply, rx) = oneshot::channel();
        service
            .sender
            .send(auth::Request::VerifyCharacter(role_token, reply))
            .await
            .unwrap();
        assert_eq!(rx.await.unwrap().unwrap().id, first.id);
        let second = match handle(
            &service.store,
            &identity.id,
            Action::Create {
                request_id: "create-2".into(),
                name: "MageTwo".into(),
                appearance: creation_default(),
            },
        )
        .unwrap()
        {
            Response::Created { character } => character,
            _ => panic!("unexpected response"),
        };
        let chinese = match handle(
            &service.store,
            &identity.id,
            Action::Create {
                request_id: "create-3".into(),
                name: "冒险者一".into(),
                appearance: creation_default(),
            },
        )
        .unwrap()
        {
            Response::Created { character } => character,
            _ => panic!("unexpected response"),
        };
        assert_eq!(chinese.name, "冒险者一");
        assert!(matches!(
            handle(
                &service.store,
                &identity.id,
                Action::CheckName {
                    name: "冒险者一".into(),
                }
            )
            .unwrap(),
            Response::NameCheck { available: false }
        ));
        let mut first_profile = service.store.load_profile(&first.id, &defaults()).unwrap();
        first_profile.level = 7;
        service
            .store
            .save_profile(&first.id, &first_profile)
            .unwrap();
        let listed = match handle(
            &service.store,
            &identity.id,
            Action::List { channel_id: None },
        )
        .unwrap()
        {
            Response::List { characters, .. } => characters,
            _ => panic!("unexpected response"),
        };
        assert_eq!(
            listed
                .iter()
                .find(|character| character.id == first.id)
                .unwrap()
                .level,
            7
        );
        assert_eq!(
            listed
                .iter()
                .find(|character| character.id == second.id)
                .unwrap()
                .level,
            1
        );
        assert_eq!(
            listed
                .iter()
                .find(|character| character.id == chinese.id)
                .unwrap()
                .name,
            "冒险者一"
        );
        assert_eq!(first.appearance, creation_default());

        let (reply, rx) = oneshot::channel();
        service
            .sender
            .send(auth::Request::Register(
                Credentials {
                    username: "lobby-other".into(),
                    password: "correct-password".into(),
                },
                reply,
            ))
            .await
            .unwrap();
        rx.await.unwrap().unwrap();
        let (reply, rx) = oneshot::channel();
        service
            .sender
            .send(auth::Request::Login(
                Credentials {
                    username: "lobby-other".into(),
                    password: "correct-password".into(),
                },
                reply,
            ))
            .await
            .unwrap();
        let (other, other_token) = rx.await.unwrap().unwrap();
        let (reply, rx) = oneshot::channel();
        service
            .sender
            .send(auth::Request::VerifyCharacter(other_token.clone(), reply))
            .await
            .unwrap();
        assert!(rx.await.unwrap().is_none());
        assert!(matches!(handle(&service.store, &other.id, Action::Select {
            character_id: first.id.clone(), channel_id: None,
        }), Err(error) if error == "character not found"));

        // A legacy account keeps the original account id as its character id,
        // so all pre-lobby player state remains addressable after materialization.
        let mut legacy_profile = service.store.load_profile(&other.id, &defaults()).unwrap();
        legacy_profile.level = 9;
        service
            .store
            .save_profile(&other.id, &legacy_profile)
            .unwrap();
        let legacy =
            match handle(&service.store, &other.id, Action::List { channel_id: None }).unwrap() {
                Response::List { characters, .. } => characters
                    .into_iter()
                    .find(|character| character.id == other.id)
                    .unwrap(),
                _ => panic!("unexpected response"),
            };
        assert_eq!(legacy.name, "lobby-other");
        assert_eq!(legacy.level, 9);
        assert_eq!(
            service.store.character_appearance(&legacy.id).unwrap(),
            Some(legacy.appearance)
        );
        let (reply, rx) = oneshot::channel();
        service
            .sender
            .send(auth::Request::VerifyCharacter(other_token, reply))
            .await
            .unwrap();
        assert_eq!(rx.await.unwrap().unwrap().id, other.id);
        drop(service);
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(format!("{}-wal", path.display()));
        let _ = fs::remove_file(format!("{}-shm", path.display()));
    }

    #[tokio::test]
    async fn startup_materializes_legacy_player_state_without_changing_its_key() {
        let path = std::env::temp_dir().join(format!(
            "maple-lobby-migration-{}.sqlite3",
            auth::random_id()
        ));
        let service = auth::start(&path).unwrap();
        let (reply, rx) = oneshot::channel();
        service
            .sender
            .send(auth::Request::Register(
                Credentials {
                    username: "legacy-user".into(),
                    password: "correct-password".into(),
                },
                reply,
            ))
            .await
            .unwrap();
        rx.await.unwrap().unwrap();
        let (reply, rx) = oneshot::channel();
        service
            .sender
            .send(auth::Request::Login(
                Credentials {
                    username: "legacy-user".into(),
                    password: "correct-password".into(),
                },
                reply,
            ))
            .await
            .unwrap();
        let (identity, _) = rx.await.unwrap().unwrap();
        let mut profile = service
            .store
            .load_profile(&identity.id, &defaults())
            .unwrap();
        profile.level = 12;
        service.store.save_profile(&identity.id, &profile).unwrap();
        drop(service);

        let reopened = auth::start(&path).unwrap();
        let listed = match handle(
            &reopened.store,
            &identity.id,
            Action::List { channel_id: None },
        )
        .unwrap()
        {
            Response::List { characters, .. } => characters,
            _ => panic!("unexpected response"),
        };
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, identity.id);
        assert_eq!(listed[0].name, "legacy-user");
        assert_eq!(listed[0].level, 12);
        assert_eq!(
            reopened.store.character_appearance(&identity.id).unwrap(),
            Some(Appearance::default())
        );
        drop(reopened);
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(format!("{}-wal", path.display()));
        let _ = fs::remove_file(format!("{}-shm", path.display()));
    }
}
