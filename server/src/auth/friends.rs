//! 好友与黑名单持久化：读取两侧名单、按名字查角色、增删/屏蔽事务，
//! 以及请求幂等回执（read/insert_friend_action）、上限常量与类型定义。
//!
//! 从 `auth.rs` 机械搬出的第三块完整职责（超大文件治理）。搬的是**代码位置**，
//! 不是数据布局：friends / friend_actions 表结构与 50/20 上限口径均未改变。
//! `FriendRow` / `FriendOperation` / `FriendOutcome` 由 auth.rs re-export，
//! 外部 `auth::FriendX` 路径不变。

use super::*;

impl Store {
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
