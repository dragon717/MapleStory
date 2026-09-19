//! 原创扩展「死亡世界」的墓碑持久化（`death_tombstones` 表）。
//!
//! 负责：墓碑行的 upsert / 全量读 / 删除。表结构见 `schema.rs`——
//! `death_id` 上有 UNIQUE 约束，重复致死在库层也只容得下一座碑。
//! 不负责：世界内的生命周期（到期、容量、去重都在 `crate::death_world`）。
//! 旧二进制读到新库只是多出一张空表，不回读也不回写。

use super::*;

/// `death_tombstones` 一行的中立形状。世界内的 `Tombstone` 在写入时投影成
/// 这份记录，读回时再由世界侧重建——持久层不知道演化阶段这类派生值。
#[derive(Clone, Debug, PartialEq)]
pub struct TombstoneRecord {
    pub id: String,
    pub death_id: String,
    pub character_name: String,
    pub map_id: String,
    pub x: f64,
    pub y: f64,
    pub epitaph: String,
    /// 死亡时刻的角色外观（camelCase JSON，`lobby::Appearance` 的原样序列化）。
    /// 持久层只搬运字节，不理解外观；解析失败按「无外观」降级为抽象光点。
    pub appearance: Option<serde_json::Value>,
    pub created_unix_ms: i64,
    pub expires_unix_ms: i64,
    pub mourners: Vec<String>,
}

impl Store {
    /// Upsert 一座墓碑。悼念人数变化也走这里（整行重写），因为悼念集合
    /// 本身就是墓碑事实的一部分。
    pub fn save_tombstone(&self, record: &TombstoneRecord) -> Result<(), String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        let mourners_json = serde_json::to_string(&record.mourners)
            .map_err(|_| "account persistence failed")?;
        let appearance_json = record
            .appearance
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|_| "account persistence failed")?;
        db.execute(
            "INSERT OR REPLACE INTO death_tombstones(
               id,death_id,character_name,map_id,x,y,epitaph,appearance_json,
               created_unix_ms,expires_unix_ms,mourners_json)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                record.id,
                record.death_id,
                record.character_name,
                record.map_id,
                record.x,
                record.y,
                record.epitaph,
                appearance_json,
                record.created_unix_ms,
                record.expires_unix_ms,
                mourners_json,
            ],
        )
        .map_err(|_| "account persistence failed")?;
        Ok(())
    }

    /// 全量读回。到期筛选不在这一层做——期限是世界时钟的判据，这里只交事实。
    pub fn load_tombstones(&self) -> Result<Vec<TombstoneRecord>, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        let mut stmt = db
            .prepare(
                "SELECT id,death_id,character_name,map_id,x,y,epitaph,appearance_json,
                        created_unix_ms,expires_unix_ms,mourners_json
                 FROM death_tombstones",
            )
            .map_err(|_| "account persistence failed")?;
        let rows = stmt
            .query_map([], |row| {
                Ok(TombstoneRecord {
                    id: row.get(0)?,
                    death_id: row.get(1)?,
                    character_name: row.get(2)?,
                    map_id: row.get(3)?,
                    x: row.get(4)?,
                    y: row.get(5)?,
                    epitaph: row.get(6)?,
                    appearance: row
                        .get::<_, Option<String>>(7)?
                        .and_then(|json| serde_json::from_str(&json).ok()),
                    created_unix_ms: row.get(8)?,
                    expires_unix_ms: row.get(9)?,
                    mourners: row
                        .get::<_, String>(10)
                        .ok()
                        .and_then(|json| serde_json::from_str(&json).ok())
                        .unwrap_or_default(),
                })
            })
            .map_err(|_| "account persistence failed")?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| "account persistence failed".into())
    }

    pub fn remove_tombstone(&self, id: &str) -> Result<(), String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        db.execute("DELETE FROM death_tombstones WHERE id=?1", params![id])
            .map_err(|_| "account persistence failed")?;
        Ok(())
    }

    /// D06：虚影击杀的奖励认领。与玩家击杀共用 `monster_rewards` 的同一把
    /// 主键（monster_id 每条命唯一）：虚影行 `account_id=NULL`、
    /// `actor_kind='echo'`——不创建任何账号形状的行，也不写怪物伤害贡献
    /// （虚影伤害不参与、也不稀释玩家的分成）。重复结算（重放/重启后同一
    /// 生命）由 `INSERT OR IGNORE` 兜底：一条命只认领一次，经验值按击杀
    /// 当时的怪物模板冻结，成为后续经验球的根预算。
    pub fn claim_echo_kill(
        &self,
        monster_id: &str,
        request_id: &str,
        exp_gain: u64,
    ) -> Result<bool, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        let exp = i64::try_from(exp_gain).map_err(|_| "account persistence failed")?;
        let claimed = db
            .execute(
                "INSERT OR IGNORE INTO monster_rewards(monster_id,account_id,request_id,exp_gain,drop_id,practice,actor_kind)
                 VALUES (?1,NULL,?2,?3,NULL,0,'echo')",
                params![monster_id, request_id, exp],
            )
            .map_err(|_| "account persistence failed")?;
        Ok(claimed > 0)
    }
}
