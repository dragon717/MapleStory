//! `Store` 的建表与 schema 迁移入口（`Store::init`）。
//!
//! 负责：SQLite 初始建表（`CREATE TABLE IF NOT EXISTS`）、既有库的列/索引迁移，
//! 末尾把建表入口交给 `crate::lobby::init` 续建其表。
//! 不负责：运行时读写与事务（见 `super::db` 与 `auth.rs` 中 `impl Store` 的各方法）。

use super::*;

impl Store {
    pub(super) fn init(db: &Connection) -> rusqlite::Result<()> {
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
               cash INTEGER NOT NULL DEFAULT 0,
               death_id TEXT NOT NULL DEFAULT '',
               starter_equipment_seeded INTEGER NOT NULL DEFAULT 0,
               starter_backpack_seeded INTEGER NOT NULL DEFAULT 0,
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
             CREATE TABLE IF NOT EXISTS shop_rebuy(
               account_id TEXT NOT NULL,
               seq INTEGER NOT NULL,
               item_id TEXT NOT NULL,
               quantity INTEGER NOT NULL,
               unit_price INTEGER NOT NULL,
               PRIMARY KEY(account_id,seq)
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
             CREATE TABLE IF NOT EXISTS windbell_bridge_state(
               world_id TEXT PRIMARY KEY,
               state_json TEXT NOT NULL,
               revision INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS windbell_player_state(
               account_id TEXT PRIMARY KEY,
               state_json TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS windbell_action_log(
               account_id TEXT NOT NULL,
               request_id TEXT NOT NULL,
               action TEXT NOT NULL,
               result_json TEXT NOT NULL,
               PRIMARY KEY(account_id,request_id)
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
        // Existing development databases predate the 現金商店 wallet column.
        // Fresh rows get 0; the GM /cash command is the only local grant path.
        let has_cash: Option<String> = db
            .query_row(
                "SELECT name FROM pragma_table_info('player_stats') WHERE name='cash'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if has_cash.is_none() {
            db.execute(
                "ALTER TABLE player_stats ADD COLUMN cash INTEGER NOT NULL DEFAULT 0",
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
        let has_starter_backpack_seeded: Option<String> = db
            .query_row(
                "SELECT name FROM pragma_table_info('player_stats') WHERE name='starter_backpack_seeded'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if has_starter_backpack_seeded.is_none() {
            db.execute(
                "ALTER TABLE player_stats ADD COLUMN starter_backpack_seeded INTEGER NOT NULL DEFAULT 0",
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
}
