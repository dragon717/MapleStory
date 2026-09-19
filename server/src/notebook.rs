//! 冒险笔记（图鉴）消息入口。
//!
//! ## 负责
//! - 把冻结后的四个客户端消息接进权威世界：查询与三种操作各自都有明确回答，
//!   不存在「收到但不回应」的路径
//! - 查询的回答按**归属**给出：怪物收藏是账号级、物品与任务记录是角色级，
//!   客户端拿到的永远只是它自己那份
//! - 把目录投影成行、分页与「当前可获得」分母：目录是**服务器**的，事实是
//!   **服务器**的，客户端只提交「看哪一页、筛什么、按什么方式看」，然后渲染
//!   服务器算出来的那一页（计划 §4.2、§5.5）
//! - 任务页的筛选、分页和摘要全部在**已获得集合**上计算：一个未获得的任务
//!   条目从来不上线路，不是发给客户端再用 CSS 藏起来（计划 §12.2）
//!
//! ## 不负责
//! - 事实表、revision 与历史补记（`auth/notebook.rs`，NB-03 已落地）
//! - 登记／奖励／探险的规则核定（`shared/monster-collection-rules.json`）
//! - 怪物死亡时的登记结算（`auth/loot.rs` 事务内，NB-06）
//! - 客户端窗口与四页渲染（客户端 `features/notebook/`）
//!
//! ## 目录版本
//! 回答里的 `catalogVersion` 是**服务器自己**的目录版本，不是客户端回声。客户
//! 端把它与自己那份比较，不一致就明确报「版本不一致」并拒绝用旧页码解释新数据
//! （计划 §12.2）。这样不需要为版本错配再发明一个错误码。
//!
//! ## 仍然阻塞的部分
//! 登记规则未核定（`registration.mode = "unverified"`），所以怪物页如实回答
//! 「已登记 0」，并在 `blockedReason` 里说明缺的是哪一环——不是一个通用失败，
//! 也不是一个假进度条。三种操作在此之前一律拒绝：规则未核定就没有可领取的奖励，
//! 也没有可开始的探险。

use super::*;
use crate::auth::notebook as facts;
use crate::protocol::{
    NotebookOperation, NotebookSection, NOTEBOOK_MODE_ALL, NOTEBOOK_MODE_AVAILABLE,
    NOTEBOOK_MODE_MISSING, NOTEBOOK_MODE_OBTAINED,
};

/// 物品页一页多少格。  目录最大的分区是装备 1738 条，60 条一页约 29 页；
/// 这个值只影响分页手感，不影响任何判定。
const ITEM_PAGE_SIZE: usize = 60;

/// 客户端带来的目录版本与服务器不一致时的回答。  此时一行都不给：用旧页码解释
/// 新目录会得到一个看起来合理、其实错位的列表（计划 §12.2）。
const VERSION_MISMATCH: &str = "图鉴目录版本与服务器不一致，请重新载入页面后再打开。";

/// 怪物页暂时没有条目的原因：同版源既没有登记概率／资格门，本项目也还没有事实
/// 写入方（`shared/monster-collection-rules.json` 里 `registration.mode = "unverified"`）。
const MONSTER_BLOCKED: &str =
    "本构建尚未接入收藏登记（该登记规则尚未核定），因此怪物页暂时没有已登记的条目。";

/// 骑宠页要一并说清的事实：源把每件骑宠标成 `notSale:1 / only:1`，本版本没有
/// 任何掉落／商店／任务会发出它们，所以「已获得」只可能来自发放。页内写这一句，
/// 而不是把 935 格全标成「本版本未开放」（那是噪声，且掩盖了「发放即可获得」）。
const MOUNT_BLOCKED: &str =
    "本版本没有开放的骑宠获取途径（源 notSale / only，不进掉落与商店）；已发放到手的会如实记录在这里。";

/// 鞍具子页要一并说清的事实：鞍具与骑宠出自同一张表（源同样标 `notSale / only`），
/// 本版本没有开放的获取途径；而且它们在本构建里**不带任何属性、也不参与骑乘判定**
/// （源没给它们 `tamingMob`），所以「先装上马鞍才能骑」在这里并不成立——页内把
/// 这件事写出来，而不是让玩家去猜。
const SADDLE_BLOCKED: &str =
    "本版本没有开放的鞍具获取途径（源 notSale / only）；鞍具在本构建里不带属性、也不参与骑乘判定，骑乘与否由骑宠本身决定。已发放到手的会如实记录在这里。";

/// 椅子页要一并说清的事实：源把椅子整族排除在掉落与商店之外（只有个位数真的
/// 进商店），所以「已获得」基本只可能来自发放。页内写这一句，而不是把 2799 格
/// 全标成「本版本未开放」（那是噪声，且掩盖了「发放／商店买到的会记录」）。
const CHAIR_BLOCKED: &str =
    "本版本几乎没有开放的椅子获取途径（源里只有个位数进商店）；发放到手或买到的会如实记录在这里。";

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
        NotebookSection::Mount => Some(facts::MOUNT_SECTION),
        NotebookSection::Saddle => Some(facts::SADDLE_SECTION),
        NotebookSection::Chair => Some(facts::CHAIR_SECTION),
        NotebookSection::Quest => Some("quest"),
    }
}

/// 一个 id 是否与搜索词匹配。
///
/// 只在**服务器自己的集合**里做包含匹配（计划 §12.2）。目录里没有名字的条目
/// （源 `String/Mob.json` 没给它名字）永远不匹配——不拿模板 id 当名字去凑。
fn matches(label: Option<&str>, needle: &str) -> bool {
    let Some(label) = label else { return false };
    label.to_lowercase().contains(needle)
}

impl World {
    /// 读事实层里这个分区**真实提交**的 revision 与已记录条数。
    ///
    /// 读不到（影子世界没有 Store、归属解析不出来、或库暂时读不了）时如实回答 0：
    /// 0 表示「没有任何已提交事实」，与 `blockedReason` 说的是同一件事，而不是编
    /// 一个进度。
    fn notebook_summary_for(
        &self,
        owner: &facts::NotebookOwner,
        section: NotebookSection,
    ) -> (u64, usize) {
        let Some(store) = self.store.as_ref() else {
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

    /// 这个角色在某一页的真实获得事实：`item_id` →（首次时间、时间是否未知）。
    fn notebook_records(
        &self,
        owner: &facts::NotebookOwner,
    ) -> BTreeMap<String, (Option<i64>, bool)> {
        let Some(store) = self.store.as_ref() else {
            return BTreeMap::new();
        };
        store
            .notebook_item_records(&owner.character_id)
            .unwrap_or_default()
            .into_iter()
            .map(|record| {
                (
                    record.item_id,
                    (
                        record.first_obtained_at_ms,
                        record.time_quality == facts::TIME_QUALITY_UNKNOWN,
                    ),
                )
            })
            .collect()
    }

    /// 这个账号已登记的收藏条目集合。
    fn notebook_registered(&self, owner: &facts::NotebookOwner) -> BTreeSet<String> {
        let Some(store) = self.store.as_ref() else {
            return BTreeSet::new();
        };
        store
            .notebook_collection_entries(&owner.account_id)
            .unwrap_or_default()
            .into_iter()
            .collect()
    }

    /// 处理一次笔记查询，回答当前角色／账号真正拥有的记录。
    ///
    /// `page` 的含义随分区而变，并且**只由服务器解释**：
    /// - 怪物页＝地区序号（`catalog().regions()` 的下标），一次返回该地区的全部行
    /// - 物品页＝真正的分页下标
    ///
    /// `filter` 与 `mode` 同样在服务器自己的集合上生效：任务页永远不会因为客户端
    /// 传入一个筛选或浏览方式而多看到一条未获得的条目。
    pub(super) fn handle_notebook_query(
        &self,
        id: &str,
        request_id: String,
        section: NotebookSection,
        page: u32,
        catalog_version: String,
        filter: Option<String>,
        mode: Option<String>,
    ) {
        let Some(player) = self.players.get(id) else {
            return;
        };
        let catalog = facts::catalog();
        // 回答里回显**服务器**的目录版本，让客户端自己发现版本错配。
        let server_version = catalog.catalog_version().to_owned();
        let empty_summary = || serde_json::json!({ "registered": 0, "total": 0, "collectable": 0 });

        let (scope, owner) = match self.notebook_owner(id, section) {
            Some(owner) => owner,
            None => {
                self.send_notebook_state(
                    player,
                    request_id.clone(),
                    section,
                    server_version,
                    "character",
                    0,
                    page,
                    0,
                    Vec::new(),
                    empty_summary(),
                    Some("无法解析这个角色的图鉴归属。"),
                );
                return;
            }
        };
        if catalog_version.trim() != server_version {
            self.send_notebook_state(
                player,
                request_id.clone(),
                section,
                server_version,
                scope,
                0,
                page,
                0,
                Vec::new(),
                empty_summary(),
                Some(VERSION_MISMATCH),
            );
            return;
        }
        let needle = filter
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_lowercase);
        let browse = mode.as_deref().unwrap_or(NOTEBOOK_MODE_AVAILABLE);

        let revision = self.notebook_summary_for(&owner, section).0;
        let (rows, page_count, summary, blocked) = if catalog_section(section).is_none() {
            let registered = self.notebook_registered(&owner);
            monster_rows(page, needle.as_deref(), &registered)
        } else {
            let records = self.notebook_records(&owner);
            item_rows(section, page, needle.as_deref(), browse, &records)
        };
        self.send_notebook_state(
            player,
            request_id,
            section,
            server_version,
            scope,
            revision,
            page,
            page_count,
            rows,
            summary,
            blocked,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn send_notebook_state(
        &self,
        player: &Player,
        request_id: String,
        section: NotebookSection,
        catalog_version: String,
        scope: &str,
        revision: u64,
        page: u32,
        page_count: u32,
        rows: Vec<serde_json::Value>,
        summary: serde_json::Value,
        blocked_reason: Option<&str>,
    ) {
        let mut message = serde_json::json!({
            "type": "notebookState",
            "requestId": request_id,
            "section": section,
            "catalogVersion": catalog_version,
            "scope": scope,
            "revision": revision,
            "page": page,
            "pageCount": page_count,
            "rows": rows,
            "summary": summary,
            "serverNowMs": unix_now_ms(),
        });
        if let Some(reason) = blocked_reason {
            message["blockedReason"] = serde_json::json!(reason);
        }
        let _ = player.output.try_send(message.to_string());
    }

    /// 解析一次查询的归属，并给出这一页归谁所有。
    ///
    /// 怪物收藏是账号级、物品与任务记录是角色级（计划 §2.3）；主体只来自连接，
    /// 客户端提交不了任何身份字段。
    fn notebook_owner(
        &self,
        id: &str,
        section: NotebookSection,
    ) -> Option<(&'static str, facts::NotebookOwner)> {
        let owner = self.store.as_ref()?.notebook_owner(id).ok()??;
        let scope = if catalog_section(section).is_none() {
            facts::SCOPE_ACCOUNT
        } else {
            facts::SCOPE_CHARACTER
        };
        Some((scope, owner))
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

/// 怪物页：按地区取行，每行带上它的收藏槽位与登记状态。
///
/// 槽位顺序是源 `Etc/mobCollection.img` 的顺序（`entryIds`），地区／分頁／行
/// 的分组身份也来自源，客户端按 `rowKey` 还原分頁，不再自己排序。
///
/// 纯函数：只吃目录与登记事实，不碰连接也不碰库，所以定向检查能直接喂一组
/// 假事实来钉住「任务／隐私／分页」这类规则。
fn monster_rows(
    page: u32,
    needle: Option<&str>,
    registered: &BTreeSet<String>,
) -> (
    Vec<serde_json::Value>,
    u32,
    serde_json::Value,
    Option<&'static str>,
) {
    let catalog = facts::catalog();
    let regions = catalog.regions();
    let page_count = regions.len() as u32;
    let region = regions.get(page as usize).copied();
    let total = catalog.entry_count();
    let collectable = catalog.collectable_entry_count();

    let mut rows = Vec::new();
    if let Some(region) = region {
        for row in catalog.rows_of_region(region) {
            let mut slots = Vec::new();
            for entry_id in &row.entry_ids {
                let Some(entry) = catalog.entry(entry_id) else {
                    continue;
                };
                let label = catalog.monster_label(&entry.monster_template_id);
                if needle.is_some_and(|text| !matches(label, text)) {
                    continue;
                }
                let mut slot = serde_json::json!({
                    "key": entry.entry_id,
                    "label": label.unwrap_or_default(),
                    "monsterTemplateId": entry.monster_template_id,
                    "registered": registered.contains(&entry.entry_id),
                    "collectable": entry.collectable,
                });
                // 详情只在真的有内容时给：源没写介绍的条目不回一个空串充数。
                if let Some(text) = catalog.monster_text(&entry.monster_template_id) {
                    if !text.episode.is_empty() {
                        slot["detail"] = serde_json::json!(text.episode);
                    }
                    if !text.spawn_map_ids.is_empty() {
                        slot["spawnMapIds"] = serde_json::json!(text.spawn_map_ids);
                    }
                }
                slots.push(slot);
            }
            if slots.is_empty() {
                continue;
            }
            rows.push(serde_json::json!({
                "key": row.row_key,
                "label": row.name,
                "rowKey": row.row_key,
                "obtained": slots.iter().any(|slot| slot["registered"] == true),
                "registered": slots.iter().all(|slot| slot["registered"] == true),
                "slots": slots,
            }));
        }
    }
    let summary = serde_json::json!({
        "registered": registered.len(),
        "total": total,
        "collectable": collectable,
    });
    (rows, page_count, summary, Some(MONSTER_BLOCKED))
}

/// 物品页（含任务页）：在服务器自己的集合上筛选、分页、摘要。
///
/// 任务页的**基集合就是已获得集合**：未获得的任务条目从这里开始就不存在，
/// 而不是发给客户端再藏起来（计划 §12.2）。「当前可获得」分母是目录自己的
/// `availability`，与玩家做过什么无关——GM 授予不会让一件物品进分母（§5.5）。
///
/// 同 `monster_rows`，这是纯函数，便于定向检查。
fn item_rows(
    section: NotebookSection,
    page: u32,
    needle: Option<&str>,
    browse: &str,
    records: &BTreeMap<String, (Option<i64>, bool)>,
) -> (
    Vec<serde_json::Value>,
    u32,
    serde_json::Value,
    Option<&'static str>,
) {
    let catalog = facts::catalog();
    let Some(name) = catalog_section(section) else {
        return (
            Vec::new(),
            0,
            serde_json::json!({ "registered": 0, "total": 0, "collectable": 0 }),
            Some(MONSTER_BLOCKED),
        );
    };
    let is_quest = section == NotebookSection::Quest;
    // 骑宠、鞍具与椅子都不在物品树里（源 `Character/TamingMob` 与
    // `Item/Install/0301*`、`0302`），因此各有自己的口径，见 `MOUNT_BLOCKED` /
    // `SADDLE_BLOCKED` / `CHAIR_BLOCKED` 与下面的分母。
    // 骑宠与鞍具是**同一张表的两半**（源 `islot` `Tm` / `Sd`），口径一致：
    // 基集合是整张表，浏览方式只再分「已获得 / 未获得」。
    let is_mount = section == NotebookSection::Mount;
    let is_saddle = section == NotebookSection::Saddle;
    let is_chair = section == NotebookSection::Chair;
    let all_ids: Vec<String> = catalog
        .section_ids(name)
        .unwrap_or(&[])
        .iter()
        .filter(|id| {
            if !is_quest {
                return true;
            }
            // 任务页：只有这个角色真的获得过的条目才存在。
            records.contains_key(*id)
        })
        .filter(|id| {
            if is_quest {
                // 任务页的基集合已经是「这个角色真的获得过」，不再叠加浏览方式：
                // 一件已经拿到的任务道具如果因为目录把它的来源标成
                // `unverified` 就被过滤掉，那玩家反而看不到自己做过什么。
                return true;
            }
            if is_mount || is_saddle {
                // 骑宠页与鞍具子页：基集合是**整张表**。本版本没有任何开放获取
                // 途径，按「当前可获得」过滤会得到空页，读起来像「本版本没有坐骑 /
                // 没有鞍具」；浏览方式因此只再分「已获得 / 未获得」，`available`
                // 与 `all` 一样是全集（P：展示口径，页面同时给出
                // `MOUNT_BLOCKED` / `SADDLE_BLOCKED`）。
                return match browse {
                    NOTEBOOK_MODE_OBTAINED => records.contains_key(*id),
                    NOTEBOOK_MODE_MISSING => !records.contains_key(*id),
                    _ => true,
                };
            }
            if is_chair {
                // 椅子：基集合同样是**整张椅子表**（2799 件），浏览方式只再分
                // 「已获得 / 未获得」。与骑宠的差别是这一族里真有个位数进商店，
                // 所以 `available` 按目录判定如实筛出那一两件，而不是退化成全集
                // ——但页内同时给出 `CHAIR_BLOCKED`，不让人读成「椅子都能买到」。
                return match browse {
                    NOTEBOOK_MODE_OBTAINED => records.contains_key(*id),
                    NOTEBOOK_MODE_MISSING => !records.contains_key(*id),
                    NOTEBOOK_MODE_AVAILABLE => catalog.availability(id) == Some("obtainable"),
                    _ => true,
                };
            }
            match browse {
                NOTEBOOK_MODE_ALL => true,
                NOTEBOOK_MODE_OBTAINED => records.contains_key(*id),
                NOTEBOOK_MODE_MISSING => {
                    !records.contains_key(*id) && catalog.availability(id) == Some("obtainable")
                }
                // 默认（`available`）与任何未定义取值：目录判定为当前可获得的
                // 条目。
                _ => catalog.availability(id) == Some("obtainable"),
            }
        })
        .filter(|id| needle.is_none_or(|text| matches(catalog.item_label(id), text)))
        .cloned()
        .collect();

    let page_count = ((all_ids.len() + ITEM_PAGE_SIZE - 1) / ITEM_PAGE_SIZE) as u32;
    let start = (page as usize) * ITEM_PAGE_SIZE;
    let rows = all_ids
        .iter()
        .skip(start)
        .take(ITEM_PAGE_SIZE)
        .map(|id| {
            let mut row = serde_json::json!({
                "key": id,
                "label": catalog.item_label(id).unwrap_or(id.as_str()),
                "itemId": id,
                "obtained": records.contains_key(id),
                "registered": records.contains_key(id),
                "availability": catalog.availability(id).unwrap_or("unverified"),
            });
            if let Some((first, unknown)) = records.get(id) {
                if let Some(at) = first {
                    row["firstRecordMs"] = serde_json::json!(*at);
                }
                // 历史补记没有真实获得时间：如实标记，客户端不能把补记时间
                // 当成获得时间显示（计划 §13.2）。
                if *unknown {
                    row["timeUnknown"] = serde_json::json!(true);
                }
            }
            row
        })
        .collect::<Vec<_>>();

    // 分母是「当前可获得」，不是整个分区：一个尚未开放的条目既不该抬高
    // 完成率，也不该让玩家以为漏了什么。任务页不设分母——未来的任务条目
    // 总数不是公开信息（计划 §5.5）。
    let obtainable = catalog
        .section_ids(name)
        .unwrap_or(&[])
        .iter()
        .filter(|id| catalog.availability(id) == Some("obtainable"))
        .count();
    let recorded = records
        .keys()
        .filter(|id| catalog.section_of(id) == Some(name))
        .count();
    let mut summary = serde_json::json!({
        "registered": recorded,
        "total": obtainable,
        "collectable": 0,
    });
    if is_mount || is_saddle {
        // 分母是**整张表**（本版本把它们的图标与数值全部发布，表本身就是全集），
        // 不是「当前可获得」——后者为 0，会把「935 件里有 3 件到手」报成
        // 「0 / 0」。P：展示口径，页面同时说明没有开放途径。
        summary["total"] = serde_json::json!(catalog.section_ids(name).unwrap_or(&[]).len());
    }
    if is_chair {
        // 椅子同骑宠：分母是**整张椅子表**（2799 件），不是「当前可获得」——后者
        // 是个位数，会把「2799 件里有 30 件到手」报成「30 / 1」。
        summary["total"] = serde_json::json!(catalog.section_ids(name).unwrap_or(&[]).len());
    }
    if is_quest {
        // 任务页只报「已记录 N 种」，没有分母，也没有问号格。
        summary["total"] = serde_json::json!(recorded);
        summary["recorded"] = serde_json::json!(recorded);
    }
    (
        rows,
        page_count,
        summary,
        if is_mount {
            Some(MOUNT_BLOCKED)
        } else if is_saddle {
            Some(SADDLE_BLOCKED)
        } else if is_chair {
            Some(CHAIR_BLOCKED)
        } else {
            None
        },
    )
}

#[cfg(test)]
mod notebook_query_tests {
    //! NB-07 的四页查询定向检查。
    //!
    //! 只钉**服务器这一半**的规则：任务页的私有过滤、默认分母、浏览方式、搜索与
    //! 分页边界。渲染与小屏是客户端的事；事实怎么落库是 `auth/notebook.rs` 的事。

    use super::*;

    /// 一页里所有格子的 `key`。
    fn keys(rows: &[serde_json::Value]) -> Vec<String> {
        rows.iter()
            .map(|row| row["key"].as_str().unwrap_or_default().to_owned())
            .collect()
    }

    /// 一个分区在目录里、且目录判定为当前可获得的 id。
    fn obtainable_in(section: &str) -> Vec<String> {
        let catalog = facts::catalog();
        catalog
            .section_ids(section)
            .unwrap_or(&[])
            .iter()
            .filter(|id| catalog.availability(id) == Some("obtainable"))
            .cloned()
            .collect()
    }

    /// 任务页：未获得的条目**从基集合里就不存在**，不是发给客户端再藏起来。
    #[test]
    fn quest_page_never_serves_an_unobtained_entry() {
        let catalog = facts::catalog();
        let all = catalog.section_ids("quest").unwrap();
        assert!(all.len() > 1, "任务分区必须不止一条，否则这条检查没有意义");
        // 一条都没获得时：一行都不给，而且摘要没有分母。
        let empty = BTreeMap::new();
        let (rows, _, summary, _) =
            item_rows(NotebookSection::Quest, 0, None, NOTEBOOK_MODE_ALL, &empty);
        assert!(rows.is_empty(), "未获得任何任务道具时任务页必须是空的");
        assert_eq!(summary["total"], serde_json::json!(0));

        // 只获得其中一条：页面上只能有那一条，剩下的 20 条连名字都不出现。
        let one = all[0].clone();
        let records = BTreeMap::from([(one.clone(), (Some(1_700_000_000_000_i64), false))]);
        for mode in [
            NOTEBOOK_MODE_ALL,
            NOTEBOOK_MODE_AVAILABLE,
            NOTEBOOK_MODE_OBTAINED,
        ] {
            let (rows, _, summary, _) = item_rows(NotebookSection::Quest, 0, None, mode, &records);
            assert_eq!(
                keys(&rows),
                vec![one.clone()],
                "浏览方式 {mode} 泄漏了别的任务条目"
            );
            assert_eq!(summary["registered"], serde_json::json!(1));
            assert_eq!(summary["recorded"], serde_json::json!(1));
            // 任务页不报「未来总共有多少任务道具」这种分母。
            assert_eq!(summary["total"], serde_json::json!(1));
        }
    }

    /// 任务页不受「当前可获得」过滤影响：一件已经拿到的任务道具，不会因为目录
    /// 把它的来源标成 `unverified` 就从玩家自己的记录里消失。
    #[test]
    fn quest_page_keeps_an_obtained_entry_the_catalog_cannot_source() {
        let catalog = facts::catalog();
        let unverified = catalog
            .section_ids("quest")
            .unwrap()
            .iter()
            .find(|id| catalog.availability(id) != Some("obtainable"))
            .cloned()
            .expect("任务分区里应当有目录标为 unverified 的条目（4036846 就是）");
        let records = BTreeMap::from([(unverified.clone(), (None, true))]);
        let (rows, _, _, _) = item_rows(
            NotebookSection::Quest,
            0,
            None,
            NOTEBOOK_MODE_AVAILABLE,
            &records,
        );
        assert_eq!(keys(&rows), vec![unverified.clone()]);
        // 时间未知必须如实标记，客户端不能把补记时间当成获得时间。
        assert_eq!(rows[0]["timeUnknown"], serde_json::json!(true));
        assert!(rows[0].get("firstRecordMs").is_none());
    }

    /// 物品页默认只给「当前可获得」；`all` 才给出整个分区。
    #[test]
    fn item_page_defaults_to_the_obtainable_denominator() {
        let catalog = facts::catalog();
        let hidden = catalog
            .section_ids("equipment")
            .unwrap()
            .iter()
            .find(|id| catalog.availability(id) != Some("obtainable"))
            .cloned()
            .expect("装备分区里应当有目录标为不可获得的条目");
        let empty = BTreeMap::new();
        let (rows, _, _, _) = item_rows(
            NotebookSection::Equipment,
            0,
            None,
            NOTEBOOK_MODE_AVAILABLE,
            &empty,
        );
        assert!(!rows.is_empty());
        for row in &rows {
            assert_eq!(
                row["availability"],
                serde_json::json!("obtainable"),
                "默认浏览方式混进了目录判定为不可获得的条目"
            );
        }
        // 未知取值退化成默认，而不是被当成第四种浏览方式。
        let (also, _, _, _) = item_rows(NotebookSection::Equipment, 0, None, "nonsense", &empty);
        assert_eq!(keys(&rows), keys(&also));

        // `all` 翻遍所有页必须能看到目录里的不可获得条目（它不一定落在第 0 页）。
        let mut all_keys = Vec::new();
        for page in 0..64_u32 {
            let (page_rows, page_count, _, _) = item_rows(
                NotebookSection::Equipment,
                page,
                None,
                NOTEBOOK_MODE_ALL,
                &empty,
            );
            all_keys.extend(keys(&page_rows));
            if page + 1 >= page_count {
                break;
            }
        }
        assert!(all_keys.len() >= rows.len(), "`all` 必须是默认集合的超集");
        assert!(
            all_keys.contains(&hidden),
            "`all` 必须能看到目录里的不可获得条目 {hidden}"
        );
    }

    /// `missing`＝「当前可获得但还没获得」：既不含已获得，也不含不可获得。
    #[test]
    fn missing_mode_excludes_obtained_and_unavailable_entries() {
        let obtainable = obtainable_in("use");
        assert!(obtainable.len() > 1);
        let first = obtainable[0].clone();
        let records = BTreeMap::from([(first.clone(), (Some(42_i64), false))]);
        let (rows, _, _, _) = item_rows(
            NotebookSection::Use,
            0,
            None,
            NOTEBOOK_MODE_MISSING,
            &records,
        );
        let missing_keys = keys(&rows);
        assert!(
            !missing_keys.contains(&first),
            "已获得的条目不该出现在「未获得」里"
        );
        for row in &rows {
            assert_eq!(row["availability"], serde_json::json!("obtainable"));
            assert_eq!(row["obtained"], serde_json::json!(false));
        }
        let (obtained, _, _, _) = item_rows(
            NotebookSection::Use,
            0,
            None,
            NOTEBOOK_MODE_OBTAINED,
            &records,
        );
        assert_eq!(keys(&obtained), vec![first.clone()]);
        assert_eq!(obtained[0]["firstRecordMs"], serde_json::json!(42));
    }

    /// 搜索在服务器自己的集合上算：命中集合是全部集合的子集，且不掺进无关条目。
    #[test]
    fn search_stays_inside_the_server_set() {
        let catalog = facts::catalog();
        let target = obtainable_in("use")[0].clone();
        let label = catalog
            .item_label(&target)
            .unwrap_or_else(|| panic!("目录必须能给 {target} 一个名字"))
            .to_owned();
        let empty = BTreeMap::new();
        let (rows, _, _, _) = item_rows(
            NotebookSection::Use,
            0,
            Some(&label.to_lowercase()),
            NOTEBOOK_MODE_AVAILABLE,
            &empty,
        );
        assert!(!rows.is_empty(), "按自己的名字搜索必须能找到自己");
        assert!(
            keys(&rows).contains(&target),
            "搜索结果里必须有被搜索的那一条"
        );
        // 一个不可能出现在物品名里的搜索词：一行都不给，而不是退回全量。
        let (none, page_count, _, _) = item_rows(
            NotebookSection::Use,
            0,
            Some("不存在的物品名"),
            NOTEBOOK_MODE_AVAILABLE,
            &empty,
        );
        assert!(none.is_empty());
        assert_eq!(page_count, 0);
    }

    /// 分页：页与页不重叠，越界页是空的，`pageCount` 与集合大小一致。
    #[test]
    fn item_pages_partition_the_section_without_gaps() {
        let empty = BTreeMap::new();
        let (first, page_count, _, _) = item_rows(
            NotebookSection::Equipment,
            0,
            None,
            NOTEBOOK_MODE_ALL,
            &empty,
        );
        let total = obtainable_in("equipment").len();
        assert!(
            page_count >= 2,
            "装备分区必须多于一页，否则这条检查没有意义"
        );
        assert_eq!(first.len(), ITEM_PAGE_SIZE);
        let (second, _, _, _) = item_rows(
            NotebookSection::Equipment,
            1,
            None,
            NOTEBOOK_MODE_ALL,
            &empty,
        );
        let first_keys = keys(&first);
        let second_keys = keys(&second);
        assert!(
            first_keys.iter().all(|key| !second_keys.contains(key)),
            "相邻两页不能出现同一条"
        );
        // 越界页是空的，不是绕回第一页。
        let (beyond, _, _, _) = item_rows(
            NotebookSection::Equipment,
            page_count,
            None,
            NOTEBOOK_MODE_ALL,
            &empty,
        );
        assert!(beyond.is_empty());
        let _ = total;
    }

    /// 怪物页：分母是**完整原始集合**，与「当前可收集」摘要分开报。
    #[test]
    fn monster_page_reports_the_whole_original_set() {
        let catalog = facts::catalog();
        let registered = BTreeSet::new();
        let (rows, page_count, summary, blocked) = monster_rows(0, None, &registered);
        assert_eq!(page_count as usize, catalog.regions().len());
        assert_eq!(summary["registered"], serde_json::json!(0));
        assert_eq!(summary["total"], serde_json::json!(catalog.entry_count()));
        assert_eq!(
            summary["collectable"],
            serde_json::json!(catalog.collectable_entry_count())
        );
        // 原版分母必须大于当前可收集子集——不能拿缩小后的集合去发行／页奖励。
        assert!(
            summary["total"].as_u64().unwrap() > summary["collectable"].as_u64().unwrap(),
            "完整原始集合必须大于当前可收集子集"
        );
        assert_eq!(blocked, Some(MONSTER_BLOCKED));
        // 地区 0 的每一行都在，槽位顺序就是目录的 `entryIds` 顺序。
        let expected = catalog.rows_of_region(catalog.regions()[0]);
        assert_eq!(rows.len(), expected.len());
        for (row, authored) in rows.iter().zip(expected) {
            assert_eq!(row["key"], serde_json::json!(authored.row_key));
            assert_eq!(
                row["slots"].as_array().unwrap().len(),
                authored.entry_ids.len()
            );
        }
        // 越界地区：空行，但 `pageCount` 仍是地区数。
        let (beyond, count, _, _) = monster_rows(page_count, None, &registered);
        assert!(beyond.is_empty());
        assert_eq!(count, page_count);
    }

    /// 已登记的槽位如实点亮；行级 `obtained`/`registered` 由槽位推导。
    #[test]
    fn monster_rows_mark_registered_slots() {
        let catalog = facts::catalog();
        let authored = catalog.rows_of_region(catalog.regions()[0])[0].clone();
        let first = authored.entry_ids[0].clone();
        let registered = BTreeSet::from([first.clone()]);
        let (rows, _, summary, _) = monster_rows(0, None, &registered);
        assert_eq!(summary["registered"], serde_json::json!(1));
        let row = &rows[0];
        assert_eq!(row["obtained"], serde_json::json!(true));
        // 一行 5 个槽位只点亮 1 个 ⇒ 整行不算完成。
        assert_eq!(row["registered"], serde_json::json!(false));
        let slots = row["slots"].as_array().unwrap();
        assert_eq!(slots[0]["key"], serde_json::json!(first));
        assert_eq!(slots[0]["registered"], serde_json::json!(true));
        assert_eq!(slots[1]["registered"], serde_json::json!(false));
    }

    /// 骑宠页：基集合是**整张坐骑表**，分母也是它。
    ///
    /// 源把骑宠标成 `notSale:1 / only:1`，本版本没有任何掉落／商店／任务会发出
    /// 它们，所以按「当前可获得」过滤会得到空页——读起来像「本版本没有坐骑」，
    /// 而不是「这些坐骑还没到手」。
    #[test]
    fn mount_page_serves_the_whole_mount_table() {
        let catalog = facts::catalog();
        let mounts = catalog.section_ids(facts::MOUNT_SECTION).unwrap();
        assert!(mounts.len() > 1, "骑宠分区必须不止一条，否则这条检查没有意义");
        let first = mounts[0].clone();
        let empty = BTreeMap::new();
        for mode in [
            NOTEBOOK_MODE_AVAILABLE,
            NOTEBOOK_MODE_ALL,
            "nonsense",
        ] {
            let (rows, _, summary, blocked) =
                item_rows(NotebookSection::Mount, 0, None, mode, &empty);
            assert_eq!(
                rows.len(),
                std::cmp::min(ITEM_PAGE_SIZE, mounts.len()),
                "浏览方式 {mode} 把骑宠筛掉了"
            );
            assert_eq!(summary["total"], serde_json::json!(mounts.len()));
            assert_eq!(blocked, Some(MOUNT_BLOCKED));
            for row in &rows {
                assert_eq!(row["obtained"], serde_json::json!(false));
            }
        }
        // 已获得：只剩那一件，并且时间如实带出；未获得：不含它。
        let records = BTreeMap::from([(first.clone(), (Some(7_i64), false))]);
        let (obtained, _, summary, _) = item_rows(
            NotebookSection::Mount,
            0,
            None,
            NOTEBOOK_MODE_OBTAINED,
            &records,
        );
        assert_eq!(keys(&obtained), vec![first.clone()]);
        assert_eq!(obtained[0]["firstRecordMs"], serde_json::json!(7));
        assert_eq!(summary["registered"], serde_json::json!(1));
        let (missing, _, _, _) = item_rows(
            NotebookSection::Mount,
            0,
            None,
            NOTEBOOK_MODE_MISSING,
            &records,
        );
        assert!(!keys(&missing).contains(&first), "已获得的骑宠不该出现在「未获得」里");
    }

    /// 鞍具子页：与骑宠出自**同一张**源表（`shared/mounts.json`），是它 `islot = Sd`
    /// 的那一半，而骑乘判定与它无关——源没给鞍具 `tamingMob`。
    ///
    /// 这条测试把三件事钉在一起：
    ///   * 两个分区**不重叠**、合起来正好是坐骑表的键集（独立重算，不信目录自称）；
    ///   * 分区边界＝骑乘判定的边界（`inventory::is_mount_item` 对每一件鞍具都 false）；
    ///   * 这一页的基集合与分母都是整张鞍具表（26 件，没有一条开放途径）。
    #[test]
    fn saddle_page_is_the_taming_mob_free_half_of_the_mount_table() {
        let catalog = facts::catalog();
        let saddles: Vec<String> = catalog
            .section_ids(facts::SADDLE_SECTION)
            .expect("目录里必须有鞍具分区")
            .to_vec();
        let mounts: Vec<String> = catalog
            .section_ids(facts::MOUNT_SECTION)
            .expect("目录里必须有骑宠分区")
            .to_vec();
        assert!(saddles.len() > 1, "鞍具分区必须不止一条，否则这条检查没有意义");
        assert!(!mounts.is_empty());

        #[derive(serde::Deserialize)]
        struct MountTable {
            items: BTreeMap<String, serde_json::Value>,
        }
        let shipped: MountTable = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../shared/mounts.json"
        )))
        .expect("shared/mounts.json 必须可解析");
        let mut union: Vec<String> = mounts.iter().chain(saddles.iter()).cloned().collect();
        union.sort();
        union.dedup();
        assert_eq!(
            union.len(),
            mounts.len() + saddles.len(),
            "同一个 id 不能既属于骑宠页又属于鞍具页"
        );
        let mut expected: Vec<String> = shipped.items.keys().cloned().collect();
        expected.sort();
        assert_eq!(union, expected, "骑宠＋鞍具必须正好是坐骑表的键集");

        for id in &saddles {
            assert!(
                !crate::inventory::is_mount_item(id),
                "鞍具 {id} 被判成了坐骑：源里它不该有 tamingMob"
            );
            assert_eq!(catalog.section_of(id), Some(facts::SADDLE_SECTION));
            assert!(!catalog.is_mount(id), "鞍具 {id} 同时出现在骑宠表里");
        }

        let empty = BTreeMap::new();
        for mode in [NOTEBOOK_MODE_AVAILABLE, NOTEBOOK_MODE_ALL, "nonsense"] {
            let (rows, _, summary, blocked) =
                item_rows(NotebookSection::Saddle, 0, None, mode, &empty);
            assert_eq!(
                rows.len(),
                std::cmp::min(ITEM_PAGE_SIZE, saddles.len()),
                "浏览方式 {mode} 把鞍具筛掉了"
            );
            assert_eq!(summary["total"], serde_json::json!(saddles.len()));
            assert_eq!(blocked, Some(SADDLE_BLOCKED));
            for row in &rows {
                assert_eq!(row["obtained"], serde_json::json!(false));
            }
        }
        let first = saddles[0].clone();
        let records = BTreeMap::from([(first.clone(), (Some(11_i64), false))]);
        let (obtained, _, summary, _) = item_rows(
            NotebookSection::Saddle,
            0,
            None,
            NOTEBOOK_MODE_OBTAINED,
            &records,
        );
        assert_eq!(keys(&obtained), vec![first.clone()]);
        assert_eq!(obtained[0]["firstRecordMs"], serde_json::json!(11));
        assert_eq!(summary["registered"], serde_json::json!(1));
        let (missing, _, _, _) = item_rows(
            NotebookSection::Saddle,
            0,
            None,
            NOTEBOOK_MODE_MISSING,
            &records,
        );
        assert!(!keys(&missing).contains(&first), "已获得的鞍具不该出现在「未获得」里");
    }

    /// 椅子页：基集合是**整张椅子表**，分母也是它；`available` 只筛出真的进商店的
    /// 那几件（源把整族排除在掉落与商店之外，所以它是个位数，绝不能当成全集）。
    #[test]
    fn chair_page_serves_the_whole_chair_table() {
        let catalog = facts::catalog();
        let chairs = catalog.section_ids(facts::CHAIR_SECTION).unwrap();
        assert!(chairs.len() > 1, "椅子分区必须不止一条，否则这条检查没有意义");
        let first = chairs[0].clone();
        let empty = BTreeMap::new();
        let obtainable = chairs
            .iter()
            .filter(|id| catalog.availability(id) == Some("obtainable"))
            .count();
        assert!(
            obtainable < chairs.len(),
            "椅子的开放获取途径必须是少数，否则「全部 / 可获得」两个口径没有区别"
        );
        for mode in [NOTEBOOK_MODE_ALL, "nonsense"] {
            let (rows, _, summary, blocked) =
                item_rows(NotebookSection::Chair, 0, None, mode, &empty);
            assert_eq!(
                rows.len(),
                std::cmp::min(ITEM_PAGE_SIZE, chairs.len()),
                "浏览方式 {mode} 把椅子筛掉了"
            );
            assert_eq!(summary["total"], serde_json::json!(chairs.len()));
            assert_eq!(blocked, Some(CHAIR_BLOCKED));
        }
        let (available, _, _, _) = item_rows(
            NotebookSection::Chair,
            0,
            None,
            NOTEBOOK_MODE_AVAILABLE,
            &empty,
        );
        assert_eq!(
            available.len(),
            obtainable,
            "「当前可获得」必须如实只给出真进商店的椅子"
        );
        // 已获得：只剩那一件，并且时间如实带出；未获得：不含它。
        let records = BTreeMap::from([(first.clone(), (Some(9_i64), false))]);
        let (obtained, _, summary, _) = item_rows(
            NotebookSection::Chair,
            0,
            None,
            NOTEBOOK_MODE_OBTAINED,
            &records,
        );
        assert_eq!(keys(&obtained), vec![first.clone()]);
        assert_eq!(obtained[0]["firstRecordMs"], serde_json::json!(9));
        assert_eq!(summary["registered"], serde_json::json!(1));
        let (missing, _, _, _) = item_rows(
            NotebookSection::Chair,
            0,
            None,
            NOTEBOOK_MODE_MISSING,
            &records,
        );
        assert!(!keys(&missing).contains(&first), "已获得的椅子不该出现在「未获得」里");
        assert_eq!(
            missing.len(),
            std::cmp::min(ITEM_PAGE_SIZE, chairs.len() - 1)
        );
    }

    /// 搜索只留下命中的槽位；整行都不命中时该行消失。
    #[test]
    fn monster_search_filters_slots_and_drops_empty_rows() {
        let catalog = facts::catalog();
        let authored = catalog.rows_of_region(catalog.regions()[0])[0].clone();
        let entry = catalog.entry(&authored.entry_ids[0]).unwrap().clone();
        let label = catalog
            .monster_label(&entry.monster_template_id)
            .expect("同版源必须给收藏条目里的怪物一个名字")
            .to_owned();
        let registered = BTreeSet::new();
        let (rows, _, _, _) = monster_rows(0, Some(&label.to_lowercase()), &registered);
        assert!(!rows.is_empty());
        for row in rows.iter() {
            for slot in row["slots"].as_array().unwrap() {
                assert!(
                    slot["label"]
                        .as_str()
                        .unwrap_or_default()
                        .to_lowercase()
                        .contains(&label.to_lowercase()),
                    "搜索留下了不匹配的槽位"
                );
            }
        }
        assert!(
            rows.len() < catalog.rows_of_region(catalog.regions()[0]).len(),
            "按单个怪物名搜索必须比整地区少"
        );
    }
}
