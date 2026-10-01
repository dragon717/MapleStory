//! GM 进度发放与请求回执的持久事务。

use super::db::write_profile;
use super::*;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GmProgressResult {
    pub success: bool,
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum GmActionCommit {
    Applied,
    Replayed(GmProgressResult),
    RequestReused,
}

fn read_action(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    request_id: &str,
) -> Result<Option<(String, String, GmProgressResult)>, String> {
    tx.query_row(
        "SELECT command,argument,success,code,message
         FROM gm_progress_actions WHERE account_id=?1 AND request_id=?2",
        params![account_id, request_id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                GmProgressResult {
                    success: row.get::<_, i64>(2)? != 0,
                    code: row.get(3)?,
                    message: row.get(4)?,
                },
            ))
        },
    )
    .optional()
    .map_err(|_| "account persistence failed".to_owned())
}

fn insert_action(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    request_id: &str,
    command: &str,
    argument: &str,
    result: &GmProgressResult,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO gm_progress_actions(account_id,request_id,command,argument,success,code,message)
         VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![
            account_id,
            request_id,
            command,
            argument,
            i64::from(result.success),
            result.code,
            result.message,
        ],
    )
    .map_err(|_| "account persistence failed".to_owned())?;
    Ok(())
}

impl Store {
    /// Commit `/cash` or `/exp` and its durable request result together.
    pub(crate) fn commit_gm_progress(
        &self,
        account_id: &str,
        request_id: &str,
        command: &str,
        argument: &str,
        expected_cash: Option<u64>,
        profile: &Profile,
        result: &GmProgressResult,
    ) -> Result<GmActionCommit, String> {
        self.refuse_if_persistence_denied()?;
        let mut db = self
            .db
            .lock()
            .map_err(|_| "account store unavailable".to_owned())?;
        let tx = db
            .transaction()
            .map_err(|_| "account persistence failed".to_owned())?;
        if let Some((prior_command, prior_argument, prior)) =
            read_action(&tx, account_id, request_id)?
        {
            tx.commit()
                .map_err(|_| "account persistence failed".to_owned())?;
            return Ok(if prior_command != command || prior_argument != argument {
                GmActionCommit::RequestReused
            } else {
                GmActionCommit::Replayed(prior)
            });
        }

        let stored_cash: i64 = tx
            .query_row(
                "SELECT cash FROM player_stats WHERE account_id=?1",
                [account_id],
                |row| row.get(0),
            )
            .map_err(|_| "account persistence failed".to_owned())?;
        if expected_cash.is_some_and(|expected| stored_cash.max(0) as u64 != expected) {
            return Err("account persistence failed".to_owned());
        }

        write_profile(&tx, account_id, profile)?;
        if expected_cash.is_some() {
            let cash =
                i64::try_from(profile.cash).map_err(|_| "account persistence failed".to_owned())?;
            if tx
                .execute(
                    "UPDATE player_stats SET cash=?2 WHERE account_id=?1",
                    params![account_id, cash],
                )
                .map_err(|_| "account persistence failed".to_owned())?
                != 1
            {
                return Err("account persistence failed".to_owned());
            }
        }
        insert_action(&tx, account_id, request_id, command, argument, result)?;
        tx.commit()
            .map_err(|_| "account persistence failed".to_owned())?;
        Ok(GmActionCommit::Applied)
    }

    /// The tombstone and its replay receipt are one fact, including after a crash.
    pub(crate) fn commit_gm_shadow(
        &self,
        account_id: &str,
        request_id: &str,
        stage: u8,
        record: &death_world::TombstoneRecord,
        result: &GmProgressResult,
    ) -> Result<GmActionCommit, String> {
        self.refuse_if_persistence_denied()?;
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        let argument = stage.to_string();
        if let Some((command, prior_argument, prior)) = read_action(&tx, account_id, request_id)? {
            return Ok(if command != "shadow" || prior_argument != argument {
                GmActionCommit::RequestReused
            } else {
                GmActionCommit::Replayed(prior)
            });
        }
        death_world::write_tombstone(&tx, record)?;
        insert_action(&tx, account_id, request_id, "shadow", &argument, result)?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(GmActionCommit::Applied)
    }
}
