//! 冒险笔记（图鉴）消息入口。
//!
//! ## 负责
//! - 把冻结后的四个客户端消息接进权威世界：查询与三种操作各自都有明确回答，
//!   不存在「收到但不回应」的路径
//! - 查询的回答按**归属**给出：怪物收藏是账号级、物品与任务记录是角色级，
//!   客户端拿到的永远只是它自己那份
//! - 查询的 `revision` 与「已记录」计数读**事实层真实提交**的值（`auth/notebook.rs`），
//!   不写死 0，也不编一个分母
//! - 操作在规则未核定时以拒绝回答，并带上人话原因，让窗口显示阻塞原因而不是
//!   一个通用失败或一个假进度条
//!
//! ## 不负责
//! - 事实表、revision 与历史补记（`auth/notebook.rs`，NB-03 已落地）
//! - 登记／奖励／探险的规则核定（`shared/monster-collection-rules.json`）
//! - 把目录投影成行、分页与「当前可获得」分母（NB-07）
//! - 怪物死亡时的登记结算（`auth/loot.rs` 事务内，NB-06）
//! - 客户端窗口与四页数据（NB-07）
//!
//! ## 本文件当前的诚实边界（NB-03 之后）
//! 事实层已经建好并能回答 revision／已记录计数，但**还没有任何写入方**：物品授予
//! 入口的接入是 NB-05，怪物登记要等登记规则核定（NB-06）。所以：
//! - `rows` 仍是空的：把目录投影成行属于 NB-07，不是"暂时没有数据"的托词
//! - `summary.total` 仍是 0：默认分母是目录里「当前可获得」的子集（计划 §5.5），
//!   那是目录规则＋展示投影的职责，事实层回答不了，也就不在这里编一个数
//! - `blockedReason` 逐分区说明**具体缺的是哪一环**，而不是一句笼统的"尚未开放"
//!
//! 三种操作在此之前一律拒绝：规则未核定就没有可领取的奖励，也没有可开始的探险。
//! 拒绝路径不需要幂等账本：它不改变任何状态，重发同一个 `requestId` 得到同一条
//! 回答。等 NB-08 真正开始发奖时，幂等约束落在奖励键与回执表上，而不是这里。

use super::*;
use crate::auth::notebook as facts;
use crate::protocol::{NotebookOperation, NotebookSection};

/// 物品页（装备／消耗／设置／其它／现金／宠物／任务道具）暂时没有条目的原因。
/// 它说的是**当前这一环缺什么**，不是"这个功能没做"。
const ITEMS_BLOCKED: &str =
    "本构建尚未把物品授予入口接到获得记录上，因此这几页暂时没有已记录的条目。";

/// 怪物页暂时没有条目的原因：同版源既没有登记概率／资格门，本项目也还没有事实写入方
/// （`shared/monster-collection-rules.json` 里 `registration.mode = "unverified"`）。
const MONSTER_BLOCKED: &str =
    "本构建尚未接入收藏登记（该登记规则尚未核定），因此怪物页暂时没有已登记的条目。";

/// 操作被拒绝时的原因，逐条对应源里尚未核定的那一项。
const CLAIM_BLOCKED: &str = "该奖励的达成条件尚未核定，本构建不能发放。";
const EXPLORATION_BLOCKED: &str = "探险依赖尚未核定的收藏登记规则，本构建不能开始或结算探险。";

/// 一个分区在目录里的页签名。怪物页不是物品页，没有目录分区。
fn catalog_section(section: NotebookSection) -> Option<&'static str> {
    match section {
        NotebookSection::Monster => None,
        NotebookSection::Equipment => Some("equipment"),
        NotebookSection::Use => Some("use"),
        NotebookSection::Setup => Some("setup"),
        NotebookSection::Etc => Some("etc"),
        NotebookSection::Cash => Some("cash"),
        NotebookSection::Pet => Some("pet"),
        NotebookSection::Quest => Some("quest"),
    }
}

impl World {
    /// 读事实层里这个分区**真实提交**的 revision 与已记录条数。
    ///
    /// 读不到（影子世界没有 Store、归属解析不出来、或库暂时读不了）时如实回答 0：
    /// 0 表示「没有任何已提交事实」，与 `blockedReason` 说的是同一件事，而不是编
    /// 一个进度。
    fn notebook_fact_summary(&self, id: &str, section: NotebookSection) -> (u64, usize) {
        let Some(store) = self.store.as_ref() else {
            return (0, 0);
        };
        // 归属由 `characters.account_id` 解析，绝不拿客户端给的 accountId 当依据。
        let Ok(Some(owner)) = store.notebook_owner(id) else {
            return (0, 0);
        };
        match catalog_section(section) {
            // 怪物收藏：账号级，读已登记的收藏条目。
            None => {
                let revision = store
                    .notebook_revision(facts::SCOPE_ACCOUNT, &owner.account_id)
                    .unwrap_or(0);
                let registered = store
                    .notebook_collection_entries(&owner.account_id)
                    .map(|entries| entries.len())
                    .unwrap_or(0);
                (revision, registered)
            }
            // 物品与任务记录：角色级，「已记录」只数本页签里真有的条目。
            Some(wanted) => {
                let revision = store
                    .notebook_revision(facts::SCOPE_CHARACTER, &owner.character_id)
                    .unwrap_or(0);
                let catalog = facts::catalog();
                let registered = store
                    .notebook_item_records(&owner.character_id)
                    .map(|records| {
                        records
                            .iter()
                            .filter(|record| catalog.section_of(&record.item_id) == Some(wanted))
                            .count()
                    })
                    .unwrap_or(0);
                (revision, registered)
            }
        }
    }

    /// 处理一次笔记查询，回答当前角色／账号真正拥有的记录。
    ///
    /// `page` 与 `filter` 只在服务器侧的集合上生效：任务页永远不会因为客户端
    /// 传入一个筛选而多看到一条未获得的条目。两者现在都没有行可筛——回答里的
    /// `registered` 是真实计数，`total` 与行列表留给目录投影（NB-07），这一点
    /// 写进 `blockedReason`，而不是留给客户端猜。
    pub(super) fn handle_notebook_query(
        &self,
        id: &str,
        request_id: String,
        section: NotebookSection,
        page: u32,
        catalog_version: String,
        filter: Option<String>,
    ) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let _ = filter;
        // 归属默认值来自计划 §2.3：怪物收藏账号级，物品与任务记录角色级。
        let (scope, blocked) = match section {
            NotebookSection::Monster => ("account", MONSTER_BLOCKED),
            _ => ("character", ITEMS_BLOCKED),
        };
        let (revision, registered) = self.notebook_fact_summary(id, section);
        let message = serde_json::json!({
            "type": "notebookState",
            "requestId": request_id,
            "section": section,
            "catalogVersion": catalog_version,
            "scope": scope,
            "revision": revision,
            "page": page,
            "pageCount": 1,
            "rows": [],
            "summary": { "registered": registered, "total": 0, "collectable": 0 },
            "serverNowMs": unix_now_ms(),
            "blockedReason": blocked,
        })
        .to_string();
        let _ = player.output.try_send(message);
    }

    /// 以「本构建没有核定这套机制」拒绝一次收藏操作。
    ///
    /// `rewardKey` / `runId` 的真实性、归属与重复领取属于权威世界的问题，等
    /// NB-08 落地时在同一个事务里重算；此刻它们连一个可校验的目标都没有，所以
    /// 回答里只带操作名与原因，不回显一个本方无法验证的键。
    pub(super) fn refuse_notebook_operation(
        &self,
        id: &str,
        request_id: String,
        operation: NotebookOperation,
        reason: &'static str,
    ) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let message = serde_json::json!({
            "type": "notebookActionResult",
            "requestId": request_id,
            "operation": operation,
            "success": false,
            "code": "notebook_unverified",
            "revision": 0,
            "serverNowMs": unix_now_ms(),
            "blockedReason": reason,
        })
        .to_string();
        let _ = player.output.try_send(message);
    }

    /// 领取一处行／分頁／地區完成奖励。
    pub(super) fn handle_collection_claim(&self, id: &str, request_id: String) {
        self.refuse_notebook_operation(
            id,
            request_id,
            NotebookOperation::CollectionClaim,
            CLAIM_BLOCKED,
        );
    }

    /// 开始或结算一次探险；两者共用同一条阻塞原因。
    pub(super) fn handle_exploration(&self, id: &str, request_id: String, start: bool) {
        let operation = if start {
            NotebookOperation::ExplorationStart
        } else {
            NotebookOperation::ExplorationClaim
        };
        self.refuse_notebook_operation(id, request_id, operation, EXPLORATION_BLOCKED);
    }
}
