//! 冒险笔记（图鉴）的事实层：获得记录、收藏记录、revision 与历史补记。
//!
//! ## 负责
//! - `record_item_acquisitions_tx`：把「权威业务真的把一件常规物品授予了这个角色」
//!   写成持久事实，并在**同一个事务**里推进该归属的 revision
//! - 目录键规范化与分类：`01302000` 与 `1302000` 是同一条记录；每个 id 都能说出
//!   为什么被收录或被排除，没有「未知分类」这一档
//! - 历史补记：只用能证明「这个角色曾经持有」的存档，时间未知就如实写未知
//! - 私有读取：按角色读物品记录、按账号读收藏登记、读 revision
//!
//! ## 不负责
//! - 给背包加物品、决定能否发奖——业务拥有「是否成功授予」的事实，图鉴只记录结果
//! - 在事务内发网络消息——本模块只回传 `NotebookChangeSet`
//! - 行列表与分页投影（世界侧 `notebook.rs` 的查询外壳 + NB-07）
//! - 怪物登记的判定（NB-06）。同版源不含登记概率与资格门
//!   （`registration.mode = "unverified"`），所以这里只提供收藏事实的读写，
//!   不提供任何「自动登记」的判定
//!
//! ## 归属（计划 §2.3 / §7.1）
//! 物品记录按**角色**（`notebook_item_records.character_id`）；怪物收藏按**登录账号**
//! （`monster_collection_records.owner_account_id`，由 `characters.account_id` 解析）。
//! `player_stats`／`inventory` 等表的列名仍叫 `account_id`，但那里存的是角色 id
//! （`commands.rs` 用 `identity.id` 当主键）——**不要凭列名决定共享范围**。
//!
//! ## 目录为什么放在这里
//! 计划 §14.1 把「目录加载／分类／ID 规范化」列在世界侧的 `notebook.rs`，但事实层
//! 必须先于世界侧存在才能校验归属，而世界侧是 `world` 的私有子模块、反向上层引用
//! 会破坏分层。因此目录与分类放在本模块（与 `auth` 引用 `crate::inventory` 同一个
//! 方向），世界侧查询再引用它；不为此再拆一层只做转发的文件。
//!
//! ## 写入面的调用方
//! NB-05 已把**物品授予入口**全部接上（拾取 / 商店买与买回 / 現金商店 / 任务起始
//! 物品与完成奖励 / 任务交互 / 创角初始装备与背包 / GM），所以
//! `record_item_acquisitions_tx` 与 `backfill_item_records_tx` 都有真实调用方，
//! 本模块不再需要 `#![allow(dead_code)]`（NB-03 期间的那条例外已随 NB-05 删除）。
//!
//! ## 仍留在本文件里的 `#[allow(dead_code)]`
//! 删掉 blanket 例外后，**只有**下面几处仍无生产调用方，且都只服务于尚未接线的
//! 后续条目。它们一律**逐条**标注而不是再开一个模块级例外——模块级例外会连带
//! 掩盖 NB-05 刚接好的写入面（那正是上一版 blanket 例外的害处）：
//! - 目录的**展示投影**访问器（版本号、页签清单、逐页 id、物品类型）：NB-07
//! - **历史补记**整簇（版本常量、证据来源、报告、两个入口）：NB-08
//! - `TIME_QUALITY_UNKNOWN` / `recorded_anything`：补记与「首次发现」提示，NB-07/08
//! 每条都写明了移除条件；接入该条目时必须删掉对应那一条。

use super::*;
use rusqlite::Transaction;
use serde::Serialize;
use std::sync::OnceLock;

// ---------------------------------------------------------------------- 目录 --

/// `shared/notebook-catalog.json` 里事实层需要的部分。
///
/// 只反序列化**身份与分类**：名称、说明、图标、可获得性属于展示投影
/// （`client/assets/notebook.json`），这里不复制第二份权威数据（计划 §5.4）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogFile {
    catalog_version: String,
    content_version: String,
    items: BTreeMap<String, CatalogItem>,
    /// 页签 → 该页的规范化物品 id。装配时它已是 `items` 的一个**无重叠全覆盖**
    /// 分区（equipment 1738 + use 206 + setup 1 + etc 86 + cash 520 + pet 12 +
    /// quest 21 = 2584 ＝ `items` 的全部键），所以它同时是「这个 id 属于哪一页」
    /// 的唯一索引。
    sections: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogItem {
    /// 目录声明的唯一键。规范化后按它回答，**不回显调用方传来的别名写法**。
    item_id: String,
    // 移除条件：NB-07 的定向检查（核对「分类来自数据」）接入后即可删。
    #[allow(dead_code)]
    inventory_type: u8,
}

/// 目录加上一次成型的分区反查索引。
#[derive(Debug)]
pub(crate) struct NotebookCatalog {
    // 移除条件：NB-07 的响应投影开始回显服务端自己的目录版本号后即可删。
    #[allow(dead_code)]
    catalog_version: String,
    /// 与 `catalog_version` 成对，用于核对目录与内容版本是否同步（NB-07）。
    ///
    /// 移除条件：同 `catalog_version`。
    #[allow(dead_code)]
    content_version: String,
    items: BTreeMap<String, CatalogItem>,
    // 移除条件：NB-07 的页签投影（逐页 id 列表）接入后即可删。
    #[allow(dead_code)]
    sections: BTreeMap<String, Vec<String>>,
    section_of_item: BTreeMap<String, String>,
}

pub(crate) fn catalog() -> &'static NotebookCatalog {
    static CATALOG: OnceLock<NotebookCatalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let file: CatalogFile = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../shared/notebook-catalog.json"
        )))
        .expect("shared/notebook-catalog.json must be valid");
        let mut section_of_item = BTreeMap::new();
        for (section, ids) in &file.sections {
            for id in ids {
                section_of_item.insert(id.clone(), section.clone());
            }
        }
        NotebookCatalog {
            catalog_version: file.catalog_version,
            content_version: file.content_version,
            items: file.items,
            sections: file.sections,
            section_of_item,
        }
    })
}

// 移除条件：NB-07 的行列表与分页投影接入后，这些访问器全部有生产调用方，
// 届时删掉这一条 impl 级例外（`section_of` / `canonical_id` 已在生产使用，
// 但同一 impl 里只要有未用项就会触发告警，所以例外挂在这里）。
#[allow(dead_code)]
impl NotebookCatalog {
    pub(crate) fn catalog_version(&self) -> &str {
        &self.catalog_version
    }

    pub(crate) fn content_version(&self) -> &str {
        &self.content_version
    }

    pub(crate) fn item_count(&self) -> usize {
        self.items.len()
    }

    pub(crate) fn section_keys(&self) -> impl Iterator<Item = &str> {
        self.sections.keys().map(String::as_str)
    }

    pub(crate) fn section_ids(&self, section: &str) -> Option<&[String]> {
        self.sections.get(section).map(Vec::as_slice)
    }

    /// 规范化 id 落在哪一页。目录里没有它则 `None`。
    pub(crate) fn section_of(&self, canonical: &str) -> Option<&str> {
        self.section_of_item.get(canonical).map(String::as_str)
    }

    /// 目录里这个 id 声明的唯一键。
    pub(crate) fn canonical_id(&self, canonical: &str) -> Option<&str> {
        self.items.get(canonical).map(|item| item.item_id.as_str())
    }

    /// 目录声明的物品类型（1 装备 / 2 消耗 / 3 设置 / 4 其它 / 5 现金）。
    ///
    /// 只用于定向检查核对「分类来自数据」；业务分类一律走 `section_of`。
    pub(crate) fn inventory_type(&self, canonical: &str) -> Option<u8> {
        self.items.get(canonical).map(|item| item.inventory_type)
    }

    fn from_items(items: &[(&str, u8)], sections: &[(&str, &[&str])]) -> NotebookCatalog {
        NotebookCatalog {
            catalog_version: "test".to_owned(),
            content_version: "test".to_owned(),
            items: items
                .iter()
                .map(|(id, kind)| {
                    (
                        (*id).to_owned(),
                        CatalogItem {
                            item_id: (*id).to_owned(),
                            inventory_type: *kind,
                        },
                    )
                })
                .collect(),
            sections: sections
                .iter()
                .map(|(name, ids)| {
                    (
                        (*name).to_owned(),
                        ids.iter().map(|id| (*id).to_owned()).collect(),
                    )
                })
                .collect(),
            section_of_item: sections
                .iter()
                .flat_map(|(name, ids)| {
                    ids.iter().map(move |id| ((*id).to_owned(), (*name).to_owned()))
                })
                .collect(),
        }
    }
}

/// 枫币不是物品：`auth/loot.rs` 用 `item_id == "0"` 表示金币入账。
const MESOS_ITEM_ID: &str = "0";

/// 规范化：去掉多余前导零，得到目录使用的唯一键（计划 §5.3）。
///
/// 只接受十进制数字串——空串、正负号、小数点、指数、任何非数字一律 `None`。
/// **不做浮点转换**：`1.3e6` 这类写法不能被当成物品 id 接受，也不能靠号段猜。
fn canonical_item_id(item_id: &str) -> Option<String> {
    let trimmed = item_id.trim();
    if trimmed.is_empty() || !trimmed.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let stripped = trimmed.trim_start_matches('0');
    Some(if stripped.is_empty() {
        MESOS_ITEM_ID.to_owned()
    } else {
        stripped.to_owned()
    })
}

/// 一个 id 的图鉴分类结论。
///
/// **没有「未知」这一档**：每个结论都能说出理由。目录与物品索引不一致时不是分类
/// 结论而是构建缺陷，由 `classify_item` 报错（计划 §7.4「漏写图鉴即整笔失败，
/// 且应产生可定位错误」）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ItemScope {
    /// 常规物品：必须留档。值＝目录里的规范化 id。
    Recorded(String),
    /// 明确排除，业务可正常授予而不留档（计划 §2.4.6）。值＝人话理由。
    NotAnItem(&'static str),
}

pub(crate) fn classify_item(
    item_id: &str,
    catalog: &NotebookCatalog,
) -> Result<ItemScope, String> {
    let Some(canonical) = canonical_item_id(item_id) else {
        return Ok(ItemScope::NotAnItem("不是合法的十进制物品 id"));
    };
    if canonical == MESOS_ITEM_ID {
        return Ok(ItemScope::NotAnItem("枫币不是物品（计划 §2.4.6）"));
    }
    if let Some(id) = catalog.canonical_id(&canonical) {
        return Ok(ItemScope::Recorded(id.to_owned()));
    }
    // 物品索引里有、图鉴目录里没有 ⇒ 目录构建漏了一个常规物品。这不是「排除」而是
    // 缺陷：静默跳过会让这件物品在图鉴里永久漏记，所以整笔业务必须失败。
    //
    // 判据必须是**出厂**索引（`shipped_catalog_contains`）：`server/test-fixtures`
    // 的 5 个条目是测试专用、故意不进运行时目录的，用测试增强过的索引会把它们
    // 误报成目录缺陷。
    if crate::inventory::shipped_catalog_contains(item_id)
        || crate::inventory::shipped_catalog_contains(&canonical)
    {
        return Err(format!(
            "notebook catalog is missing the regular item {canonical}"
        ));
    }
    Ok(ItemScope::NotAnItem("不是常规物品（物品索引里没有定义）"))
}

// ---------------------------------------------------------------- 事实词表 --

/// revision 作用域：角色（物品记录）。
pub(crate) const SCOPE_CHARACTER: &str = "character";
/// revision 作用域：账号（怪物收藏）。
pub(crate) const SCOPE_ACCOUNT: &str = "account";

/// 首次记录依据＝真实获得事件时间。
pub(crate) const TIME_QUALITY_EVENT: &str = "event";
/// 首次记录依据＝历史补记，**时间未知**（`first_obtained_at_ms` 写 NULL）。
///
/// 移除条件：NB-08 的历史补记有了生产入口后即可删（它是补记专用的时间档）。
#[allow(dead_code)]
pub(crate) const TIME_QUALITY_UNKNOWN: &str = "unknown";

/// 一次**真正授予**的来源。取值是持久化 token，改动等于改 schema 语义。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AcquisitionSource {
    /// 地面拾取（自动消耗拾取物是否留档由分类决定，见 `record_item_acquisitions_tx`）
    Pickup,
    /// 任务接取／完成奖励
    QuestReward,
    /// 任务交互授予
    QuestInteraction,
    /// 普通商店购买
    ShopBuy,
    /// 商店赎回
    ShopRebuy,
    /// 現金商店购买
    CashPurchase,
    /// 创建角色时的初始装备／道具
    Starter,
    /// GM 授予。它是真实授予、会留档，但**不会**让物品变得「正常可获得」（§5.5）。
    Gm,
}

impl AcquisitionSource {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            AcquisitionSource::Pickup => "pickup",
            AcquisitionSource::QuestReward => "questReward",
            AcquisitionSource::QuestInteraction => "questInteraction",
            AcquisitionSource::ShopBuy => "shopBuy",
            AcquisitionSource::ShopRebuy => "shopRebuy",
            AcquisitionSource::CashPurchase => "cashPurchase",
            AcquisitionSource::Starter => "starter",
            AcquisitionSource::Gm => "gm",
        }
    }
}

/// 一次实际正向授予。
///
/// `quantity` 必须是这次**真正授予的正数**：业务侧拥有「是否成功授予」的事实，
/// 图鉴只记录这个结果，绝不反过来替任务、背包、商店决定能否发奖（计划 §9.1）。
#[derive(Clone, Copy, Debug)]
pub(crate) struct ItemAcquisition<'a> {
    pub item_id: &'a str,
    pub quantity: u32,
    pub source: AcquisitionSource,
    pub source_ref: Option<&'a str>,
}

/// 一次事实提交的结果。
///
/// `first_obtained` 为空表示这次没有任何新事实，World 不应发出「首次发现」提示
/// （计划 §9.3）；非空表示这些模板是**第一次**留档，且 `revision` 已经前进。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct NotebookChangeSet {
    pub character_id: String,
    pub revision: u64,
    pub first_obtained: Vec<String>,
}

// 移除条件：NB-07 的「首次发现」提示接线后，World 会读 `first_obtained` 决定
// 是否提示，本 impl 即可删掉例外。
#[allow(dead_code)]
impl NotebookChangeSet {
    /// 这次提交是否产生了新事实。
    pub(crate) fn recorded_anything(&self) -> bool {
        !self.first_obtained.is_empty()
    }
}

// -------------------------------------------------------------------- 归属 --

/// 已认证连接的归属解析结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct NotebookOwner {
    pub character_id: String,
    /// 登录账号 id。物品记录不用它，怪物收藏用它。
    pub account_id: String,
}

/// 由**已认证连接绑定的角色 id** 解析所属登录账号（计划 §7.1）。
///
/// 角色行是唯一权威：`characters.account_id` 指向登录账号。客户端查询与操作不接收
/// 任意 `accountId`／`characterId` 作为授权依据，也不能用用户名、昵称、频道或
/// 客户端字段替代真实关联。
///
/// 兼容分支：`lobby::ensure_legacy` 给升级前的老账号补的角色行 id 就等于账号 id，
/// 所以 `characters` 查询直接命中、两个 id 相同；老账号还没有角色行时按「account.id
/// 与角色 id 相同」这一既有约定兜底，仍然只查库、不猜。
pub(crate) fn resolve_owner(
    conn: &Connection,
    character_id: &str,
) -> Result<Option<NotebookOwner>, String> {
    if character_id.is_empty() {
        return Ok(None);
    }
    let by_character: Option<String> = conn
        .query_row(
            "SELECT account_id FROM characters WHERE id=?1",
            [character_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "account persistence failed")?;
    if let Some(account_id) = by_character {
        return Ok(Some(NotebookOwner {
            character_id: character_id.to_owned(),
            account_id,
        }));
    }
    let legacy: Option<String> = conn
        .query_row(
            "SELECT a.id FROM accounts a WHERE a.id=?1
               AND EXISTS(SELECT 1 FROM player_stats p WHERE p.account_id=a.id)",
            [character_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "account persistence failed")?;
    Ok(legacy.map(|account_id| NotebookOwner {
        character_id: character_id.to_owned(),
        account_id,
    }))
}

// -------------------------------------------------------------------- 读取 --

/// 一条物品获得事实。**只有身份与时间**：名称、图标、分类、当前持有量都不在这里，
/// 目录修正后重新投影即可，不需要清洗上千条玩家记录（计划 §7.2）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ItemRecord {
    pub item_id: String,
    /// 真实获得时间；历史补记时是 `None`（时间未知），不是补记时间。
    pub first_obtained_at_ms: Option<i64>,
    /// 这一行被写下的时间。历史补记时它**不代表**原始获得时间。
    pub recorded_at_ms: i64,
    pub time_quality: String,
    pub source_kind: String,
}

/// 读一个角色的物品获得记录，按 id 升序；读两次结果完全相同（幂等读）。
pub(crate) fn read_item_records(
    conn: &Connection,
    character_id: &str,
) -> Result<Vec<ItemRecord>, String> {
    let mut statement = conn
        .prepare(
            "SELECT item_id,first_obtained_at_ms,recorded_at_ms,time_quality,source_kind
             FROM notebook_item_records WHERE character_id=?1 ORDER BY item_id",
        )
        .map_err(|_| "notebook read failed")?;
    let rows = statement
        .query_map([character_id], |row| {
            Ok(ItemRecord {
                item_id: row.get(0)?,
                first_obtained_at_ms: row.get(1)?,
                recorded_at_ms: row.get(2)?,
                time_quality: row.get(3)?,
                source_kind: row.get(4)?,
            })
        })
        .map_err(|_| "notebook read failed")?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| "notebook read failed".to_owned())
}

/// 读一个账号已登记的收藏条目 id，按 id 升序（幂等读）。
///
/// NB-06 是唯一的写入方，登记规则核定之前这张表只会是空的——读它仍然如实回答
/// 已提交的事实，而不是替 NB-06 造一个「按概率抽中」的结果。
pub(crate) fn read_collection_entries(
    conn: &Connection,
    owner_account_id: &str,
) -> Result<Vec<String>, String> {
    let mut statement = conn
        .prepare(
            "SELECT entry_id FROM monster_collection_records WHERE owner_account_id=?1
             ORDER BY entry_id",
        )
        .map_err(|_| "notebook read failed")?;
    let rows = statement
        .query_map([owner_account_id], |row| row.get::<_, String>(0))
        .map_err(|_| "notebook read failed")?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| "notebook read failed".to_owned())
}

/// 读某个归属已提交的 revision。没有行＝还没有任何已提交事实，即 0。
pub(crate) fn read_revision(
    conn: &Connection,
    scope_kind: &str,
    scope_id: &str,
) -> Result<u64, String> {
    let revision: Option<i64> = conn
        .query_row(
            "SELECT revision FROM notebook_revisions WHERE scope_kind=?1 AND scope_id=?2",
            params![scope_kind, scope_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "notebook read failed")?;
    Ok(revision.unwrap_or(0).max(0) as u64)
}

/// 推进一步 revision。只在**本次提交真的新增了事实**之后调用。
fn bump_revision_tx(
    tx: &Transaction<'_>,
    scope_kind: &str,
    scope_id: &str,
) -> Result<u64, String> {
    tx.execute(
        "INSERT INTO notebook_revisions(scope_kind,scope_id,revision) VALUES (?1,?2,1)
         ON CONFLICT(scope_kind,scope_id) DO UPDATE SET revision=revision+1",
        params![scope_kind, scope_id],
    )
    .map_err(|_| "notebook persistence failed")?;
    read_revision(tx, scope_kind, scope_id)
}

// ------------------------------------------------------------------ 写事实 --

/// 把一批实际授予写进图鉴事实，并在**同一个事务**里推进角色 revision。
///
/// - **规范化**：`01302000` 与 `1302000` 写同一行，键是目录里的 `1302000`，
///   所以别名不会在图鉴里变成两种装备（计划 §5.3 / §16.1）
/// - **幂等**：重复获得走 `(character_id,item_id)` 唯一键，不刷 revision，也不产生
///   第二次「首次发现」；已经写过的事实不会被覆盖（首次时间保持不变）
/// - **去重**：同一事务里同一模板可能被多条正向授予命中（§9.2），只关心首次获得，
///   所以按规范化 id 去重；证据取排序后的第一条，结果与调用方给的顺序无关
/// - **不吞错**：目录缺陷（常规物品缺目录）与非法授予（数量为 0）都返回 `Err`，
///   调用方必须让**整笔业务**回滚，而不是留下「物品已到、图鉴漏记」
/// - **不发消息**：返回 `NotebookChangeSet`，由 World 在提交成功后推送
/// - **分类决定去留**：调用方把「这次真的发出去的东西」整批交过来，是否留档由
///   `classify_item` 判定，不由调用方按结构筛。自动消耗拾取物（`consumeOnPickup`）
///   因此也走这条路径：当场被消耗的物品如果本身是常规物品就留档，而它**不会**因为
///   被消耗就变成怪物收藏登记（计划 §10.1）
///
/// 一次业务提交只推进一步 revision，而不是每件物品一步：revision 是给客户端判断
/// 「我这份缓存过期了没有」用的，一份缓存一次失效就够（§7.4）。
pub(crate) fn record_item_acquisitions_tx(
    tx: &Transaction<'_>,
    character_id: &str,
    grants: &[ItemAcquisition<'_>],
    event_time_ms: i64,
    catalog: &NotebookCatalog,
) -> Result<NotebookChangeSet, String> {
    let mut resolved: BTreeMap<String, (AcquisitionSource, Option<String>)> = BTreeMap::new();
    for grant in grants {
        if grant.quantity == 0 {
            return Err(format!(
                "notebook record refused a zero-quantity grant for {}",
                grant.item_id
            ));
        }
        match classify_item(grant.item_id, catalog)? {
            ItemScope::Recorded(canonical) => {
                resolved
                    .entry(canonical)
                    .or_insert((grant.source, grant.source_ref.map(str::to_owned)));
            }
            // 明确排除的 id 照常由业务授予，只是不留档——不是静默跳过，分类已经
            // 为它给出了理由，`classify_item` 的定向检查逐条核对这些理由。
            ItemScope::NotAnItem(_) => {}
        }
    }
    let recorded_at_ms = now_ms();
    let mut first_obtained = Vec::new();
    for (item_id, (source, source_ref)) in &resolved {
        let inserted = tx
            .execute(
                "INSERT OR IGNORE INTO notebook_item_records(
                   character_id,item_id,first_obtained_at_ms,recorded_at_ms,time_quality,source_kind,source_ref)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![
                    character_id,
                    item_id,
                    event_time_ms,
                    recorded_at_ms,
                    TIME_QUALITY_EVENT,
                    source.as_str(),
                    source_ref.as_deref(),
                ],
            )
            .map_err(|_| "notebook persistence failed")?;
        if inserted == 1 {
            first_obtained.push(item_id.clone());
        }
    }
    let revision = if first_obtained.is_empty() {
        read_revision(tx, SCOPE_CHARACTER, character_id)?
    } else {
        bump_revision_tx(tx, SCOPE_CHARACTER, character_id)?
    };
    Ok(NotebookChangeSet {
        character_id: character_id.to_owned(),
        revision,
        first_obtained,
    })
}

/// 在一个**已经打开的事务**里，为一次成功的业务授予留档，并返回本次新增的事实。
///
/// NB-05 的全部授予入口都走这里，而不是各自拼 `ItemAcquisition` 再调
/// `record_item_acquisitions_tx`：这样「授予时间取什么、来源怎么写、要不要发消息」
/// 只有一处决定，接入点只需要回答「我这次真的发出去什么」。
///
/// - 时间用**业务真实发生的时刻**（`event_time_ms` 由调用方给，通常是动作落库时间），
///   而不是图鉴自己的 `now_ms()`——同一笔业务里两处取时间会漂移
/// - 返回 `NotebookChangeSet`：调用方在**提交成功之后**才能用它发「首次发现」提示
///   （计划 §9.3），事务内发消息是禁止的
/// - 目录缺陷（常规物品缺目录）与数量为 0 会让整笔业务 `Err`：宁可让这笔授予失败，
///   也不能留下「物品已到、图鉴漏记」的不一致（计划 §9.1）
pub(crate) fn granted_tx(
    tx: &Transaction<'_>,
    character_id: &str,
    grants: &[ItemAcquisition<'_>],
    event_time_ms: i64,
) -> Result<NotebookChangeSet, String> {
    record_item_acquisitions_tx(tx, character_id, grants, event_time_ms, catalog())
}

// ---------------------------------------------------------------- 历史补记 --
//
// 移除条件（整簇）：NB-08 的受控发布补记入口接线后，下面这些都会成为生产
// 调用链的一部分，届时删掉本簇内各条例外。`backfill_item_records_tx` 本身已由
// `backfill_notebook_item_records` 调用，只是因为后者还没有生产调用方而连带告警。

/// 物品补记的迁移版本。版本变了才会再跑一遍（计划 §13.2）。
///
/// 移除条件：NB-08 接线后即可删。
#[allow(dead_code)]
pub(crate) const ITEM_BACKFILL_VERSION: &str = "notebook-item-backfill-1";

/// 历史补记能拿到的、**能归属到具体角色**的证据来源（计划 §13.1）。
///
/// 被刻意排除的：`storage` 之外的同名共享表、旧 MonsterBook 卡片（§8.4 与现代收藏
/// 隔离）、以及任何只能靠等级或任务完成数推断的东西。
///
/// 移除条件：NB-08 接线后即可删。
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum BackfillEvidence {
    /// 当前背包里还留着
    Inventory,
    /// 当前穿戴着
    Equipped,
    /// 当前放在自己的仓库里（存进去就证明持有过）
    Storage,
    /// 成功的拾取回执
    PickupReceipt,
    /// 成功的現金购买回执
    CashReceipt,
}

// 移除条件：NB-08 接线后即可删。
#[allow(dead_code)]
impl BackfillEvidence {
    const ALL: [BackfillEvidence; 5] = [
        BackfillEvidence::Inventory,
        BackfillEvidence::Equipped,
        BackfillEvidence::Storage,
        BackfillEvidence::PickupReceipt,
        BackfillEvidence::CashReceipt,
    ];

    fn as_str(self) -> &'static str {
        match self {
            BackfillEvidence::Inventory => "inventory",
            BackfillEvidence::Equipped => "equipped",
            BackfillEvidence::Storage => "storage",
            BackfillEvidence::PickupReceipt => "pickupReceipt",
            BackfillEvidence::CashReceipt => "cashReceipt",
        }
    }

    /// 证据查询。第二列是该行的可定位引用，写进 `source_ref`。
    ///
    /// 这些表的列名都叫 `account_id`，但写入路径传的是 World 的角色 id
    /// （`trade.rs::handle_storage_transfer`、`loot.rs::pickup`），所以它们证明的是
    /// **这个角色**的持有。仓库若真的改成账号级共享，这里必须重新核定。
    fn sql(self) -> &'static str {
        match self {
            BackfillEvidence::Inventory => {
                "SELECT item_id,'inv:'||inventory_type||':'||slot FROM inventory
                 WHERE account_id=?1 AND quantity>0"
            }
            BackfillEvidence::Equipped => {
                "SELECT item_id,'eqp:'||slot FROM equipped WHERE account_id=?1"
            }
            BackfillEvidence::Storage => {
                "SELECT item_id,'sto:'||slot FROM storage WHERE account_id=?1 AND quantity>0"
            }
            BackfillEvidence::PickupReceipt => {
                "SELECT item_id,request_id FROM pickup_actions
                 WHERE account_id=?1 AND success=1"
            }
            BackfillEvidence::CashReceipt => {
                "SELECT item_id,request_id FROM cash_actions WHERE account_id=?1 AND success=1"
            }
        }
    }
}

/// 一次历史补记的报告。
///
/// 报告要能回答「扫了什么、证明了多少、有多少是别名去重、有多少归不了、有多少是
/// 历史资料不足、以及用的是哪个迁移版本」（计划 §13.2）——但没有原始时间就必须说
/// 没有原始时间，不能靠等级或任务完成数猜（§13.3）。
/// 移除条件：NB-08 接线后即可删。
#[allow(dead_code)]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotebookBackfillReport {
    /// 来源名 → 扫到的行数。
    pub scanned: BTreeMap<String, u64>,
    /// 本次新证明并写入的角色持有事实（规范化 id，升序）。
    pub proved: Vec<String>,
    /// 被别名／重复证据去重掉的条目数。
    pub deduped: u64,
    /// 扫到但明确不是常规物品的行（枫币、非物品 id）。
    pub not_an_item: u64,
    /// 按 §8.4 明确隔离、不留档的条目（旧 MonsterBook 卡片）。
    pub excluded: u64,
    /// 有历史、但没有可靠的实际授予证据，因此**不予补记**的条目数（§13.3）。
    pub insufficient: u64,
    /// 提交后该角色的 revision。
    pub revision: u64,
    /// 这个角色在本迁移版本之前已经补记过。
    pub already_completed: bool,
}

/// 按角色做一次有版本标记、可重复执行的历史补记（计划 §13）。
///
/// 只用能**证明这个角色曾经持有**的存档（见 `BackfillEvidence`）。补记时
/// `first_obtained_at_ms` 写 `NULL`、`time_quality` 写 `unknown`：库里没有原始时间
/// 就不伪造一个，也不覆盖已有的真实时间（`INSERT OR IGNORE`）。
///
/// **先扫描后写标记**：扫描期间出错就整批回滚，绝不留下「已完成」标记而事实没写。
/// 已经跑过的角色直接回答 `already_completed`，不重复扫描、不发奖励、不刷 revision。
///
/// 调用点：受控发布流程按角色、事务、受控批次执行（§13.2／§13.4）。本模块不为它
/// 挂任何自动启动路径——当前阶段不访问也不迁移用户在线库。
/// 移除条件：NB-08 接线后即可删。
#[allow(dead_code)]
pub(crate) fn backfill_item_records_tx(
    tx: &Transaction<'_>,
    character_id: &str,
    migration_version: &str,
    catalog: &NotebookCatalog,
) -> Result<NotebookBackfillReport, String> {
    let done: Option<String> = tx
        .query_row(
            "SELECT summary_json FROM notebook_backfill_runs
             WHERE character_id=?1 AND migration_version=?2",
            params![character_id, migration_version],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "notebook read failed")?;
    if done.is_some() {
        return Ok(NotebookBackfillReport {
            already_completed: true,
            revision: read_revision(tx, SCOPE_CHARACTER, character_id)?,
            ..NotebookBackfillReport::default()
        });
    }

    let mut scanned: BTreeMap<&'static str, u64> = BTreeMap::new();
    let mut not_an_item = 0_u64;
    let mut deduped = 0_u64;
    let mut proved: BTreeMap<String, (BackfillEvidence, Option<String>)> = BTreeMap::new();
    for evidence in BackfillEvidence::ALL {
        let mut statement = tx.prepare(evidence.sql()).map_err(|_| "notebook read failed")?;
        let rows = statement
            .query_map([character_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|_| "notebook read failed")?;
        let scan = scanned.entry(evidence.as_str()).or_insert(0);
        for row in rows {
            let (item_id, reference) = row.map_err(|_| "notebook read failed")?;
            *scan += 1;
            match classify_item(&item_id, catalog)? {
                ItemScope::Recorded(canonical) => {
                    if proved.contains_key(&canonical) {
                        deduped += 1;
                    } else {
                        proved.insert(canonical, (evidence, Some(reference)));
                    }
                }
                ItemScope::NotAnItem(_) => not_an_item += 1,
            }
        }
    }
    // 有历史但没有逐次授予回执：如实报「资料不足」，绝不按「任务做完了」把所有奖励
    // 和材料一键登记（§13.3）。
    let insufficient = tx
        .query_row(
            "SELECT COUNT(*) FROM player_quests WHERE account_id=?1 AND status='completed'",
            [character_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| "notebook read failed")?
        .max(0) as u64;
    // 旧卡片按 §8.4 与现代收藏隔离：既不当现代登记，也不当物品获得证据（同版卡片的
    // id 不是常规物品，物品索引里一条都没有）。
    let excluded = tx
        .query_row(
            "SELECT COUNT(*) FROM monster_book_cards WHERE account_id=?1",
            [character_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| "notebook read failed")?
        .max(0) as u64;

    let recorded_at_ms = now_ms();
    let mut inserted_ids = Vec::new();
    for (item_id, (evidence, reference)) in &proved {
        let inserted = tx
            .execute(
                "INSERT OR IGNORE INTO notebook_item_records(
                   character_id,item_id,first_obtained_at_ms,recorded_at_ms,time_quality,source_kind,source_ref)
                 VALUES (?1,?2,NULL,?3,?4,?5,?6)",
                params![
                    character_id,
                    item_id,
                    recorded_at_ms,
                    TIME_QUALITY_UNKNOWN,
                    evidence.as_str(),
                    reference.as_deref(),
                ],
            )
            .map_err(|_| "notebook persistence failed")?;
        if inserted == 1 {
            inserted_ids.push(item_id.clone());
        }
    }
    let revision = if inserted_ids.is_empty() {
        read_revision(tx, SCOPE_CHARACTER, character_id)?
    } else {
        bump_revision_tx(tx, SCOPE_CHARACTER, character_id)?
    };
    let report = NotebookBackfillReport {
        scanned: scanned
            .into_iter()
            .map(|(source, rows)| (source.to_owned(), rows))
            .collect(),
        proved: inserted_ids,
        deduped,
        not_an_item,
        excluded,
        insufficient,
        revision,
        already_completed: false,
    };
    // 标记最后写，且与事实同一个事务：失败时一起回滚。
    tx.execute(
        "INSERT INTO notebook_backfill_runs(character_id,migration_version,completed_at_ms,summary_json)
         VALUES (?1,?2,?3,?4)",
        params![
            character_id,
            migration_version,
            now_ms(),
            serde_json::to_string(&report).map_err(|_| "notebook persistence failed")?,
        ],
    )
    .map_err(|_| "notebook persistence failed")?;
    Ok(report)
}

// ------------------------------------------------------------------ Store --

impl Store {
    /// 由已认证连接绑定的角色 id 解析归属；解析不出就是没有这个角色。
    pub(crate) fn notebook_owner(
        &self,
        character_id: &str,
    ) -> Result<Option<NotebookOwner>, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        resolve_owner(&db, character_id)
    }

    /// 一个角色已留档的物品获得记录。
    pub(crate) fn notebook_item_records(
        &self,
        character_id: &str,
    ) -> Result<Vec<ItemRecord>, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        read_item_records(&db, character_id)
    }

    /// 一个账号已登记的收藏条目 id。
    pub(crate) fn notebook_collection_entries(
        &self,
        owner_account_id: &str,
    ) -> Result<Vec<String>, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        read_collection_entries(&db, owner_account_id)
    }

    /// 一个归属已提交的 revision。
    pub(crate) fn notebook_revision(
        &self,
        scope_kind: &str,
        scope_id: &str,
    ) -> Result<u64, String> {
        let db = self.db.lock().map_err(|_| "account store unavailable")?;
        read_revision(&db, scope_kind, scope_id)
    }

    /// 在一个自持事务里记录一批实际授予。业务侧调用它时**必须**把自己的其他写入
    /// 放进同一个事务（计划 §10），否则会出现「物品已到、图鉴漏记」。
    ///
    /// 移除条件：NB-05 的授予入口都自带事务、走 `granted_tx`（同事务内写入），
    /// 所以这个「自开事务」的外观目前只有验收测试在用。NB-06／NB-08 若需要一个
    /// 无事务调用方的入口就会用上它，届时删掉这条例外。
    #[allow(dead_code)]
    pub(crate) fn record_notebook_acquisitions(
        &self,
        character_id: &str,
        grants: &[ItemAcquisition<'_>],
        event_time_ms: i64,
    ) -> Result<NotebookChangeSet, String> {
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        let change = record_item_acquisitions_tx(
            &tx,
            character_id,
            grants,
            event_time_ms,
            catalog(),
        )?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(change)
    }

    /// 按角色补记一次历史获得事实。见 `backfill_item_records_tx` 的调用约定。
    ///
    /// 移除条件：NB-08 接线后即可删。
    #[allow(dead_code)]
    pub(crate) fn backfill_notebook_item_records(
        &self,
        character_id: &str,
        migration_version: &str,
    ) -> Result<NotebookBackfillReport, String> {
        let mut db = self.db.lock().map_err(|_| "account store unavailable")?;
        let tx = db.transaction().map_err(|_| "account persistence failed")?;
        let report = backfill_item_records_tx(&tx, character_id, migration_version, catalog())?;
        tx.commit().map_err(|_| "account persistence failed")?;
        Ok(report)
    }
}

#[cfg(test)]
impl NotebookCatalog {
    /// 定向检查用的小目录：用来验证「常规物品缺目录 ⇒ 整笔失败」这条守卫。
    pub(crate) fn for_test(items: &[(&str, u8)], sections: &[(&str, &[&str])]) -> NotebookCatalog {
        NotebookCatalog::from_items(items, sections)
    }
}
