//! 转职任务（`shared/job-advance.json`）：配置、纯判定与世界集成。
//!
//! ## 为什么单独成模块
//!
//! 转职和 `world::quest` 的通用任务共享「接取 → 做目标 → 交付」的形状，但有三处
//! 本质差异，硬塞进通用任务只会把两套语义绞在一起：
//! - **奖励维度不同**：通用任务的奖励是 mesos / exp / 道具；转职的奖励是**职业
//!   本身**外加技能书 SP、固定技能与 MP 下限，落库时还要以职业做 CAS。
//! - **幂等键不同**：通用任务靠 `(quest_id, status)` 转场；转职一旦完成，`from_job`
//!   就再也不成立，因此「已转职」这一事实额外由职业字段兜底。
//! - **生命周期不同**：转职任务不可重复，且它的可接取性由**当前职业**唯一决定
//!   （同一时间对同一角色最多一条命中，由 `validate` 保证）。
//!
//! ## 分层
//!
//! - [`JobAdvanceCatalog`]：配置加载与启动校验。配置缺项＝装配没跑完，**硬失败**
//!   （与 `npc-dialogue.json` 同一口径）；静默降级会让整条转职链变成「点了没反应」。
//! - [`rules`]：纯判定。**不接收 `World` / `Store` / `&mut`**，输入只取
//!   [`rules::Facts`] 这份收窄过的只读事实集。目标进度只读落盘事实（击杀计数、
//!   背包），客户端声明永远不是来源。
//! - 本文件下半的 `impl World`：**唯一**的写路径。接取、交付、回执、事务都在这里，
//!   顺序是「先算候选 → 再落库 → 成功后才写回内存并回执」。
//!
//! ## 进度存储
//!
//! 复用通用任务的两张表，不新建表：`player_quests(account_id, quest_id, status)`
//! 存状态，`quest_kills(account_id, quest_id, mob_id)` 存击杀计数；收集类目标直接读
//! 背包，没有第二份副本。因此转职进度与任务日志天然同源，客户端无需改动。
//!
//! ## 不负责
//!
//! - 「選擇岔道」漢斯（NPC 10201 / 地圖 001020000）的快捷转职：那是用户指定的
//!   便利入口，留在 `dialogue::apply_job_advance`，判据是等级。本模块是原版转职官
//!   （NPC 1032001 / 地圖 101000003）的完整任务流程。二者是两条独立授权，互不改写。
//! - 一转（0 → 200）：源 273 的 `QuestData/1402.img` 已经是可执行任务，走通用任务
//!   系统（含 `Store::commit_quest` 里的 1402 守卫），不在这里重复登记。

use crate::auth::notebook::{AcquisitionSource, ItemAcquisition};
use crate::auth::JobAdvancePlan;
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use super::*;

/// 对话状态机里标记「本次会话停在转职任务菜单」的节点前缀。
/// 与 `dialogue::MAGE_TRAINING_NODE` 同一手法：节点名里带 quest id，
/// 一次会话只可能停在一条转职任务上。
pub(super) const JOB_ADVANCE_NODE: &str = "job-advance";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/// 一条收集/击杀目标。`kind` 决定进度来源：
/// - `kill`：读 `quest_kills` 里 `(questId, mobId)` 的落盘计数；
/// - `collect`：读背包里 `itemId` 的持有量。
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct JobAdvanceObjective {
    #[serde(default)]
    pub(super) kind: String,
    #[serde(default)]
    pub(super) mob_id: String,
    #[serde(default)]
    pub(super) item_id: String,
    #[serde(default)]
    pub(super) required: u32,
    /// 目标文案。缺省时退化成任务标题，不出空白行。
    #[serde(default)]
    pub(super) text: serde_json::Value,
}

/// 前置任务。缺省 `status` 视为要求 `completed`。
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct JobAdvancePrerequisite {
    #[serde(default)]
    pub(super) quest_id: String,
    #[serde(default)]
    pub(super) status: Option<String>,
}

/// 接取条件：等级下限 + 前置任务（AND）。
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct JobAdvanceRequirement {
    #[serde(default)]
    pub(super) level_at_least: u32,
    #[serde(default)]
    pub(super) quests: Vec<JobAdvancePrerequisite>,
}

/// 交付时的奖励。除 `items` 外都是转职特有的维度。
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct JobAdvanceReward {
    /// 技能书 id -> 发放点数。**只加不减**（见 `auth::apply_job_advance_grant`），
    /// 历史档里已攒的 SP 不会被抹掉。
    #[serde(default)]
    pub(super) skill_points: Vec<JobAdvanceSkillPoint>,
    /// 固定技能 id -> 等级。同样只补不覆盖。
    #[serde(default)]
    pub(super) skills: Vec<JobAdvanceSkill>,
    /// 法师专属 MP 下限。0 表示不动。
    #[serde(default)]
    pub(super) max_mp_floor: i64,
    #[serde(default)]
    pub(super) exp: u64,
    #[serde(default)]
    pub(super) mesos: u64,
    #[serde(default)]
    pub(super) items: Vec<JobAdvanceRewardItem>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct JobAdvanceSkillPoint {
    pub(super) book: u32,
    #[serde(default)]
    pub(super) amount: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct JobAdvanceSkill {
    pub(super) skill_id: u32,
    #[serde(default)]
    pub(super) level: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct JobAdvanceRewardItem {
    #[serde(default)]
    pub(super) item_id: String,
    #[serde(default)]
    pub(super) quantity: u32,
}

/// 任务 NPC 的摆放约束：`templateId` 是源模板 id，`maps` 为空表示不限地图。
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct JobAdvanceNpc {
    #[serde(default)]
    pub(super) template_id: String,
    #[serde(default)]
    pub(super) maps: Vec<String>,
}

/// 本地化文案。缺语言时按 zh → en 回退。
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
pub(super) struct JobAdvanceText {
    #[serde(default)]
    pub(super) zh: String,
    #[serde(default)]
    pub(super) en: String,
}

impl JobAdvanceText {
    /// 取当前语言的文案；缺则回退另一语言；两条都缺时返回空串（调用方给兜底）。
    fn pick(&self, lang: &str) -> &str {
        let zh = self.zh.trim();
        let en = self.en.trim();
        if lang == crate::quest_text::LANG_EN {
            if !en.is_empty() {
                return en;
            }
            return zh;
        }
        if !zh.is_empty() {
            return zh;
        }
        en
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
pub(super) struct JobAdvanceDialogue {
    /// 可接取时 NPC 说的话。
    #[serde(default)]
    pub(super) offer: JobAdvanceText,
    /// 条件不足时说的话。
    #[serde(default)]
    pub(super) locked: JobAdvanceText,
    /// 接取成功。
    #[serde(default)]
    pub(super) accept: JobAdvanceText,
    /// 进行中、目标未完成。
    #[serde(default)]
    pub(super) progress: JobAdvanceText,
    /// 目标已齐、可以交付。
    #[serde(default)]
    pub(super) ready: JobAdvanceText,
    /// 交付成功。
    #[serde(default)]
    pub(super) complete: JobAdvanceText,
}

/// 一条转职任务。`from_job` 是该角色接取时必须处于的职业，
/// `to_job` 是交付后写入的职业。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JobAdvanceQuest {
    pub(super) quest_id: String,
    #[serde(default)]
    pub(super) title: JobAdvanceText,
    /// 来源边界：`T`（同版 WZ 已核）/ `P`（项目补齐）。仅作留痕，不参与判定。
    #[serde(default)]
    pub(super) provenance: String,
    pub(super) from_job: u32,
    pub(super) to_job: u32,
    #[serde(default)]
    pub(super) npc: Option<JobAdvanceNpc>,
    #[serde(default)]
    pub(super) require: JobAdvanceRequirement,
    #[serde(default)]
    pub(super) objectives: Vec<JobAdvanceObjective>,
    /// 交付时是否扣除收集类目标的道具（默认扣，与通用任务 `consumeItems` 同义）。
    #[serde(default = "default_consume_items")]
    pub(super) consume_items: bool,
    #[serde(default)]
    pub(super) reward: JobAdvanceReward,
    #[serde(default)]
    pub(super) dialogue: JobAdvanceDialogue,
}

fn default_consume_items() -> bool {
    true
}

impl JobAdvanceQuest {
    /// 交给 `Store` 的事务契约。auth 侧只认这份扁平结构，不认配置 schema，
    /// 因此改配置字段不会牵动持久化层。
    ///
    /// `level` 是交付瞬间的角色等级：技能点按「**规定转职等级 → 当前等级**」派生
    /// （`auth::book_sp_through_level`），而不是配置里写死的起手值——晚转职时
    /// 差额（如 45 级才转二转的 45 点）必须在这里一次补齐。转职这一刻新书必然为空
    /// （职业 CAS 保证 `from_job` 不能持有它），所以应有点数就是全额；
    /// 配置里的 `amount` 是「按时转职」的那一份，与 30/60/100 门槛处的派生根值一致。
    fn plan(&self, level: u32) -> JobAdvancePlan {
        JobAdvancePlan {
            quest_id: self.quest_id.clone(),
            from_job: self.from_job,
            to_job: self.to_job,
            level_at_least: self.require.level_at_least,
            skill_points: self
                .reward
                .skill_points
                .iter()
                .map(|point| {
                    (
                        point.book,
                        auth::book_sp_through_level(point.book, level, true),
                    )
                })
                .collect(),
            skills: self
                .reward
                .skills
                .iter()
                .map(|skill| (skill.skill_id, skill.level))
                .collect(),
            max_mp_floor: self.reward.max_mp_floor,
        }
    }
}

/// 两组地图是否指向同一处（顺序无关）。同一职业的分支候选必须挂在同样的地图上，
/// 否则「选分支」会变成「跑两张图各说一次话」。
fn same_placement(left: &[String], right: &[String]) -> bool {
    let left: BTreeSet<&str> = left.iter().map(String::as_str).collect();
    let right: BTreeSet<&str> = right.iter().map(String::as_str).collect();
    left == right
}

/// 转职任务目录。启动时加载并校验；校验失败直接顶掉进程。
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JobAdvanceCatalog {
    #[serde(default)]
    pub(crate) quests: Vec<JobAdvanceQuest>,
}

impl JobAdvanceCatalog {
    pub(crate) fn load(path: &Path) -> Result<Self, String> {
        let raw = std::fs::read_to_string(path).map_err(|error| {
            format!("Cannot read job advance config {}: {error}", path.display())
        })?;
        let catalog: Self = serde_json::from_str(&raw).map_err(|error| {
            format!("Cannot parse job advance config {}: {error}", path.display())
        })?;
        catalog.validate()?;
        Ok(catalog)
    }

    /// 启动校验。与 `Gameplay::validate` 同一口径：**数据自己说的事**必须自洽。
    /// 悬空的引用在运行时会变成「点了没反应」，必须在启动时挡下。
    pub(crate) fn validate(&self) -> Result<(), String> {
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        for quest in &self.quests {
            if quest.quest_id.trim().is_empty() {
                return Err("job advance quest id is empty".to_owned());
            }
            if !seen.insert(quest.quest_id.as_str()) {
                return Err(format!("duplicate job advance quest {}", quest.quest_id));
            }
            if quest.from_job == quest.to_job {
                return Err(format!(
                    "job advance {} does not change the job",
                    quest.quest_id
                ));
            }
            // 一个职业只能由一条任务转出（`to_job` 全局唯一），否则「转到哪」
            // 会取决于配置顺序。
            for other in &self.quests {
                if other.quest_id != quest.quest_id && other.to_job == quest.to_job {
                    return Err(format!(
                        "job advance {} and {} both advance to job {}",
                        quest.quest_id, other.quest_id, quest.to_job
                    ));
                }
            }
            // 同一职业挂多条＝**二转的分支选择**（法师 200 → 火毒 210 / 冰雷 220 /
            // 主教 230）。原版就是站在同一位转职官面前挑路线，因此这些候选必须挂在
            // **同一位 NPC 的同一组地图**上：否则「选分支」会散落在两张图里，
            // 玩家一次会话根本选不全。去向互不相同由上一条保证。
            for other in &self.quests {
                if other.quest_id == quest.quest_id || other.from_job != quest.from_job {
                    continue;
                }
                let (Some(left), Some(right)) = (quest.npc.as_ref(), other.npc.as_ref()) else {
                    return Err(format!(
                        "job advance {} and {} share from job {} but one of them has no npc",
                        quest.quest_id, other.quest_id, quest.from_job
                    ));
                };
                if left.template_id != right.template_id || !same_placement(&left.maps, &right.maps)
                {
                    return Err(format!(
                        "job advance {} and {} share from job {} but not the same npc placement",
                        quest.quest_id, other.quest_id, quest.from_job
                    ));
                }
            }
            if quest
                .npc
                .as_ref()
                .is_none_or(|npc| npc.template_id.trim().is_empty())
            {
                return Err(format!("job advance {} has no npc", quest.quest_id));
            }
            for objective in &quest.objectives {
                match objective.kind.as_str() {
                    "kill" if objective.mob_id.trim().is_empty() || objective.required == 0 => {
                        return Err(format!(
                            "job advance {} has an invalid kill objective",
                            quest.quest_id
                        ));
                    }
                    "collect"
                        if objective.item_id.trim().is_empty() || objective.required == 0 =>
                    {
                        return Err(format!(
                            "job advance {} has an invalid collect objective",
                            quest.quest_id
                        ));
                    }
                    "kill" | "collect" => {}
                    other => {
                        return Err(format!(
                            "job advance {} has unknown objective kind {other}",
                            quest.quest_id
                        ));
                    }
                }
            }
            for prerequisite in &quest.require.quests {
                if prerequisite.quest_id.trim().is_empty() {
                    return Err(format!(
                        "job advance {} has an empty prerequisite",
                        quest.quest_id
                    ));
                }
            }
        }
        Ok(())
    }

    /// 命中规则：当前职业必须等于 `from_job`，且说话的 NPC 必须挂在配置的位置上。
    ///
    /// **同一职业可能有多条候选**（二转的火毒／冰雷／主教分支），此时由玩家在菜单里
    /// 选，所以返回 `Vec`；顺序按 `quest_id` 排定，**不依赖配置书写顺序**——否则
    /// 菜单项顺序会随配置改动漂移。
    pub(super) fn candidates(
        &self,
        job: u32,
        template_id: &str,
        map_id: &str,
    ) -> Vec<&JobAdvanceQuest> {
        let mut found: Vec<&JobAdvanceQuest> = self
            .quests
            .iter()
            .filter(|quest| {
                quest.from_job == job
                    && quest.npc.as_ref().is_some_and(|npc| {
                        npc.template_id == template_id
                            && (npc.maps.is_empty() || npc.maps.iter().any(|map| map == map_id))
                    })
            })
            .collect();
        found.sort_by(|left, right| left.quest_id.cmp(&right.quest_id));
        found
    }

    /// 按 id 精确定位。会话中途只认节点里带着的那一条，不重新猜。
    pub(super) fn by_id(&self, quest_id: &str) -> Option<&JobAdvanceQuest> {
        self.quests.iter().find(|quest| quest.quest_id == quest_id)
    }

    /// 玩家手里正在进行的转职任务（目录内至多一条：转职一旦完成职业就变了，
    /// 而同一职业的分支只可能接一条）。拿到它就**不再出分支菜单**——路已经选过了。
    pub(super) fn active_quest<'a>(
        &'a self,
        quests: &BTreeMap<String, String>,
    ) -> Option<&'a JobAdvanceQuest> {
        self.quests
            .iter()
            .find(|quest| quests.get(&quest.quest_id).map(String::as_str) == Some("active"))
    }

    /// 一次击杀要推进的 `(questId, mobId)`。只对**处于 active** 的任务计数，
    /// 所以先杀怪再接任务永远不会补记。
    pub(super) fn kill_targets(
        &self,
        quests: &BTreeMap<String, String>,
        mob_template_id: &str,
    ) -> Vec<(String, String)> {
        let mut targets: BTreeSet<(String, String)> = BTreeSet::new();
        for quest in &self.quests {
            if quests.get(&quest.quest_id).map(String::as_str) != Some("active") {
                continue;
            }
            for objective in &quest.objectives {
                if objective.kind == "kill"
                    && objective.required > 0
                    && objective.mob_id == mob_template_id
                {
                    targets.insert((quest.quest_id.clone(), objective.mob_id.clone()));
                }
            }
        }
        targets.into_iter().collect()
    }

    /// 目录里是否登记过这个 id。任务日志靠它把转职行从「遗留存档行」里摘出来，
    /// 走本模块的正式条目。
    pub(super) fn contains_id(&self, quest_id: &str) -> bool {
        self.quests.iter().any(|quest| quest.quest_id == quest_id)
    }
}

// ---------------------------------------------------------------------------
// 纯判定（不持有 World / Store / 网络，不接收 &mut）
// ---------------------------------------------------------------------------

pub(super) mod rules {
    use super::{JobAdvanceObjective, JobAdvanceQuest, JobAdvanceRequirement};
    use crate::protocol::InventoryItem;
    use std::collections::BTreeMap;

    /// 判定所需的玩家事实集。只读，字段外没有世界状态。
    pub(super) struct Facts<'a> {
        pub(super) level: u32,
        pub(super) job: u32,
        pub(super) quests: &'a BTreeMap<String, String>,
        pub(super) inventory: &'a [InventoryItem],
        pub(super) kills: &'a BTreeMap<String, BTreeMap<String, u32>>,
    }

    /// 背包里某道具的总持有量。
    pub(super) fn item_count(inventory: &[InventoryItem], item_id: &str) -> u32 {
        inventory
            .iter()
            .filter(|item| item.item_id == item_id)
            .fold(0_u32, |total, item| total.saturating_add(item.quantity))
    }

    /// 前置任务判定（AND）。未写 `status` 时默认要求 `completed`；
    /// 空清单视为满足。`active` 不等于 `completed`。
    pub(super) fn prerequisites_match(
        quests: &BTreeMap<String, String>,
        requirement: &JobAdvanceRequirement,
    ) -> bool {
        requirement.quests.iter().all(|prerequisite| {
            let expected = prerequisite.status.as_deref().unwrap_or("completed");
            quests
                .get(&prerequisite.quest_id)
                .is_some_and(|status| status == expected)
        })
    }

    /// 接取条件：等级 + 前置。职业由 `quest_for` 的命中规则保证，这里不再比。
    pub(super) fn requirement_matches(
        facts: &Facts<'_>,
        requirement: &JobAdvanceRequirement,
    ) -> bool {
        facts.level >= requirement.level_at_least
            && prerequisites_match(facts.quests, requirement)
    }

    /// 单个目标的当前进度。击杀读落盘计数，收集读背包；**没有第三份来源**。
    pub(super) fn objective_current(
        quest_id: &str,
        objective: &JobAdvanceObjective,
        facts: &Facts<'_>,
    ) -> u32 {
        if objective.kind == "kill" {
            return facts
                .kills
                .get(quest_id)
                .and_then(|kills| kills.get(&objective.mob_id))
                .copied()
                .unwrap_or(0);
        }
        if objective.item_id.is_empty() {
            return 0;
        }
        item_count(facts.inventory, &objective.item_id)
    }

    /// 全部目标是否达成。`required == 0` 的目标视为无效、永远不满足，
    /// 免得一条坏配置把转职变成无条件可交付。
    pub(super) fn objectives_complete(quest: &JobAdvanceQuest, facts: &Facts<'_>) -> bool {
        quest.objectives.iter().all(|objective| {
            objective.required > 0
                && match objective.kind.as_str() {
                    "kill" => !objective.mob_id.trim().is_empty(),
                    _ => !objective.item_id.is_empty(),
                }
                && objective_current(&quest.quest_id, objective, facts) >= objective.required
        })
    }

    /// 交付时要扣除的清单：只有收集类目标有实物，击杀类没有。
    pub(super) fn consume_items(quest: &JobAdvanceQuest) -> Vec<(String, u32)> {
        if !quest.consume_items {
            return Vec::new();
        }
        quest
            .objectives
            .iter()
            .filter(|objective| objective.kind == "collect" && objective.required > 0)
            .map(|objective| (objective.item_id.clone(), objective.required))
            .collect()
    }
}

// ---------------------------------------------------------------------------
// World 集成：唯一的写路径
// ---------------------------------------------------------------------------

impl World {
    /// 收窄出转职判定所需的事实集。返回 `None` 表示角色不在场。
    fn job_advance_facts(&self, id: &str) -> Option<rules::Facts<'_>> {
        let player = self.players.get(id)?;
        Some(rules::Facts {
            level: player.state.level,
            job: player.state.job,
            quests: &player.quests,
            inventory: &player.state.inventory,
            kills: &player.quest_kills,
        })
    }

    /// 目标行文案：配置给了就用，没给就退化成任务标题，不出空白行。
    fn job_advance_line(text: &JobAdvanceText, fallback: &str, lang: &str) -> String {
        let picked = text.pick(lang);
        if picked.is_empty() {
            fallback.to_owned()
        } else {
            picked.to_owned()
        }
    }

    fn job_advance_objective_text(
        value: &serde_json::Value,
        fallback: &str,
        lang: &str,
    ) -> String {
        if let Some(text) = value.as_str().filter(|text| !text.is_empty()) {
            return (*text).to_owned();
        }
        value
            .as_object()
            .and_then(|object| {
                object
                    .get(lang)
                    .or_else(|| object.get(crate::quest_text::LANG_ZH))
                    .or_else(|| object.get(crate::quest_text::LANG_EN))
            })
            .and_then(serde_json::Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| fallback.to_owned())
    }

    /// 目标进度行，形状与通用任务的 `objectives` 一致，客户端无需区分。
    fn job_advance_objective_rows(
        &self,
        quest: &JobAdvanceQuest,
        facts: &rules::Facts<'_>,
        lang: &str,
    ) -> Vec<serde_json::Value> {
        let fallback = quest.title.pick(lang).to_owned();
        quest
            .objectives
            .iter()
            .map(|objective| {
                serde_json::json!({
                    "text": Self::job_advance_objective_text(&objective.text, &fallback, lang),
                    "current": rules::objective_current(&quest.quest_id, objective, facts),
                    "required": objective.required,
                })
            })
            .collect()
    }

    /// 任务日志里的转职条目。形状与 `quest::quest_entry` 对齐，客户端复用同一个窗口。
    pub(super) fn job_advance_log_entries(&self, id: &str) -> Vec<serde_json::Value> {
        let Some(player) = self.players.get(id) else {
            return Vec::new();
        };
        let lang = player.lang;
        let facts = match self.job_advance_facts(id) {
            Some(facts) => facts,
            None => return Vec::new(),
        };
        let mut entries = Vec::new();
        for quest in &self.job_advance.quests {
            let persisted = player.quests.get(&quest.quest_id).map(String::as_str);
            // 只展示「当前职业能接」或「自己已经接了/完成了」的转职行；
            // 其余职业路线不该出现在别人的日志里。
            let relevant = matches!(persisted, Some("active") | Some("completed"))
                || (persisted.is_none() && quest.from_job == player.state.job);
            if !relevant {
                continue;
            }
            let status = match persisted {
                Some("completed") => "completed",
                Some("active") if rules::objectives_complete(quest, &facts) => {
                    "objectivesComplete"
                }
                Some("active") => "active",
                _ if rules::requirement_matches(&facts, &quest.require) => "available",
                _ => "locked",
            };
            let mut entry = serde_json::json!({
                "questId": quest.quest_id,
                "name": quest.title.pick(lang),
                "status": status,
                "summary": quest.dialogue.offer.pick(lang),
                "objectives": self.job_advance_objective_rows(quest, &facts, lang),
                "jobAdvance": {
                    "fromJob": quest.from_job,
                    "toJob": quest.to_job,
                    // 来源边界透给日志：`T` 是同版 WZ 已核，`P` 是项目补齐。
                    // 让「这条转职哪些是原作」永远查得到，不被时间冲掉。
                    "provenance": quest.provenance,
                },
            });
            if let Some(npc) = quest.npc.as_ref() {
                entry["targetNpcId"] = serde_json::Value::String(npc.template_id.clone());
                if let Some(map_id) = npc.maps.first() {
                    entry["targetMapId"] = serde_json::Value::String(map_id.clone());
                    entry["nextAction"] = serde_json::Value::String(if status == "available" {
                        format!("前往{}，與轉職官交談接取轉職任務", map_id)
                    } else {
                        format!("前往{}，與轉職官交談完成轉職", map_id)
                    });
                }
            }
            if status == "locked" {
                entry["blockReason"] = serde_json::Value::String(
                    if facts.level < quest.require.level_at_least {
                        format!("需要達到 {} 級", quest.require.level_at_least)
                    } else {
                        "需要先完成前置轉職任務".to_owned()
                    },
                );
            }
            entries.push(entry);
        }
        entries
    }

    /// 击杀记分：把转职任务的击杀目标并入通用任务的记分清单。
    /// 只有 active 的任务会被计数，因此「先杀后接」不会补记。
    pub(super) fn job_advance_kill_targets(
        &self,
        id: &str,
        mob_template_id: &str,
    ) -> Vec<(String, String)> {
        let Some(player) = self.players.get(id) else {
            return Vec::new();
        };
        self.job_advance.kill_targets(&player.quests, mob_template_id)
    }

    /// 转职任务对话分发。**返回 true 表示这次请求已被本模块接走**，
    /// 调用方必须立刻 return，不能再落到通用任务菜单或台词分支。
    ///
    /// 分发位置在通用任务菜单之前：命中的判据是「当前职业 == fromJob 且站对了 NPC」，
    /// 新手（job 0）在这里不命中，照旧走 1402 的一转菜单。
    #[allow(clippy::too_many_arguments)]
    pub(super) fn handle_job_advance_talk(
        &mut self,
        id: &str,
        request_id: &str,
        npc_id: &str,
        template_id: &str,
        map_id: &str,
        name: &str,
        name_zh: Option<&str>,
        lang: &str,
        step: Option<&str>,
        selection: Option<u32>,
    ) -> bool {
        let Some(job) = self.players.get(id).map(|player| player.state.job) else {
            return false;
        };
        // 同一职业可能有多条候选（二转的火毒／冰雷／主教分支）。克隆出来，
        // 后面所有 `&mut self` 的发送都不再借用目录。
        let candidates: Vec<JobAdvanceQuest> = self
            .job_advance
            .candidates(job, template_id, map_id)
            .into_iter()
            .cloned()
            .collect();
        if candidates.is_empty() {
            return false;
        }
        let alive = self
            .players
            .get(id)
            .is_some_and(|player| player.state.hp > 0 && player.state.action != "dead");
        let quests = self
            .players
            .get(id)
            .map(|player| player.quests.clone())
            .unwrap_or_default();
        let node = self
            .npcs
            .get(npc_id)
            .and_then(|npc| npc.conversation.get(id).cloned());
        let branch_node = format!("{JOB_ADVANCE_NODE}-branch");
        let opening = step.is_none_or(|step| step == "start");

        // 会话中途（玩家真的选了选项）：**只认节点里带着的那一条**。
        // 同职业有多个分支，重新「猜一条」会把玩家送到他没选的路上。
        if !opening {
            let Some(node) = node.as_deref() else {
                return false;
            };
            if node == branch_node {
                let Some(index) = selection else {
                    return false;
                };
                let index = index as usize;
                if step == Some("end") || index >= candidates.len() {
                    self.end_conversation(id);
                    self.send_npc_dialogue(
                        id,
                        npc::DialogueView::End.to_json(request_id, npc_id, name, name_zh),
                    );
                    return true;
                }
                let quest = candidates[index].clone();
                return self.send_job_advance_menu(
                    id, request_id, npc_id, name, name_zh, lang, &quest,
                );
            }
            let Some(quest_id) = node
                .strip_prefix(JOB_ADVANCE_NODE)
                .and_then(|rest| rest.strip_prefix(':'))
            else {
                return false;
            };
            // 换了职业或换了 NPC 之后，旧节点指向的任务已经不是候选了：
            // 如实让玩家重新对话，而不是静默什么都不回。
            let Some(quest) = candidates
                .iter()
                .find(|quest| quest.quest_id == quest_id)
                .cloned()
            else {
                self.end_conversation(id);
                self.send_reject(
                    id,
                    "npc_step_invalid",
                    if lang == crate::quest_text::LANG_EN {
                        "This conversation option is no longer available."
                    } else {
                        "該對話選項已失效，請重新與 NPC 交談。"
                    },
                    Some(request_id),
                );
                return true;
            };
            let status = quests.get(&quest.quest_id).cloned();
            return self.handle_job_advance_selection(
                id,
                request_id,
                npc_id,
                name,
                name_zh,
                lang,
                &quest,
                status.as_deref(),
                step,
                selection,
            );
        }

        // **通用剧情任务优先**。漢斯（1032001）同时是源一转任务 1402 的接取/交付
        // NPC，而 1402 的条件里写着职业 0/200/220/221/222——走「選擇岔道」快捷
        // 转职过来的角色职业已经是 200，若本模块先接手，他们就再也没有入口把
        // 一转剧情补完（那条支线是用户明确要求保留的原版冒险家剧情）。
        // 所以只要这位 NPC 此刻还有剧情任务要给，本模块就让路。
        if !self.quest_menu_choices(id, template_id).is_empty() {
            return false;
        }
        if !alive {
            self.end_conversation(id);
            self.send_reject(
                id,
                "job_advance_unavailable",
                if lang == crate::quest_text::LANG_EN {
                    "You cannot take a job advancement while dead."
                } else {
                    "死亡角色不能進行轉職。"
                },
                Some(request_id),
            );
            return true;
        }
        // 已经接过的那条优先（分支已经选过了，不能再给一次选择）；
        // 只有一条候选时不必问；多条 ⇒ 出分支菜单。
        let picked = candidates
            .iter()
            .find(|quest| quests.get(&quest.quest_id).map(String::as_str) == Some("active"))
            .cloned()
            .or_else(|| {
                if candidates.len() == 1 {
                    candidates.first().cloned()
                } else {
                    None
                }
            });
        match picked {
            Some(quest) => {
                self.send_job_advance_menu(id, request_id, npc_id, name, name_zh, lang, &quest)
            }
            None => self.send_job_advance_branch_menu(
                id, request_id, npc_id, name, name_zh, lang, &candidates,
            ),
        }
    }

    /// 分支菜单：同一职业有多条路线时（法师二转的火毒／冰雷／主教）让玩家自己挑。
    /// 选项下标即候选下标，末位是「結束對話」——**让玩家选，不替玩家选**。
    #[allow(clippy::too_many_arguments)]
    fn send_job_advance_branch_menu(
        &mut self,
        id: &str,
        request_id: &str,
        npc_id: &str,
        name: &str,
        name_zh: Option<&str>,
        lang: &str,
        candidates: &[JobAdvanceQuest],
    ) -> bool {
        let text = if lang == crate::quest_text::LANG_EN {
            "Which advancement path will you take?"
        } else {
            "要走上哪一條轉職路線？"
        }
        .to_owned();
        let mut options: Vec<(u32, String)> = candidates
            .iter()
            .enumerate()
            .map(|(index, quest)| (index as u32, quest.title.pick(lang).to_owned()))
            .collect();
        options.push((
            candidates.len() as u32,
            if lang == crate::quest_text::LANG_EN {
                "End conversation"
            } else {
                "結束對話"
            }
            .to_owned(),
        ));
        if let Some(npc) = self.npcs.get_mut(npc_id) {
            npc.conversation
                .insert(id.to_owned(), format!("{JOB_ADVANCE_NODE}-branch"));
        }
        let value = npc::DialogueView::Say {
            text,
            kind: "simple".to_owned(),
            options,
        }
        .to_json(request_id, npc_id, name, name_zh);
        self.send_npc_dialogue(id, value);
        true
    }

    /// 出一条转职任务的菜单（接取／进行中／已完成／条件不足），并把会话节点
    /// 钉在这条任务上。开场与「分支菜单选完」共用同一条路径。
    #[allow(clippy::too_many_arguments)]
    fn send_job_advance_menu(
        &mut self,
        id: &str,
        request_id: &str,
        npc_id: &str,
        name: &str,
        name_zh: Option<&str>,
        lang: &str,
        quest: &JobAdvanceQuest,
    ) -> bool {
        let status = self
            .players
            .get(id)
            .and_then(|player| player.quests.get(&quest.quest_id).cloned());
        let facts = match self.job_advance_facts(id) {
            Some(facts) => facts,
            None => return false,
        };
        let eligible = rules::requirement_matches(&facts, &quest.require);
        let title = quest.title.pick(lang).to_owned();
        let rows = self.job_advance_objective_rows(quest, &facts, lang);
        // 「已接」优先于「可接」：接了之后等级掉回门槛以下也不能把进度抹掉。
        let (text, options) = match status.as_deref() {
            Some("completed") => (
                Self::job_advance_line(&quest.dialogue.complete, &title, lang),
                Vec::new(),
            ),
            Some("active") => {
                let complete = rules::objectives_complete(quest, &facts);
                let text = if complete {
                    Self::job_advance_line(&quest.dialogue.ready, &title, lang)
                } else {
                    Self::job_advance_line(&quest.dialogue.progress, &title, lang)
                };
                let mut options = Vec::new();
                if complete {
                    options.push((
                        0u32,
                        if lang == crate::quest_text::LANG_EN {
                            "Complete the job advancement"
                        } else {
                            "完成轉職"
                        }
                        .to_owned(),
                    ));
                }
                options.push((
                    1u32,
                    if lang == crate::quest_text::LANG_EN {
                        "End conversation"
                    } else {
                        "結束對話"
                    }
                    .to_owned(),
                ));
                (text, options)
            }
            _ if eligible => (
                Self::job_advance_line(&quest.dialogue.offer, &title, lang),
                vec![
                    (
                        0u32,
                        if lang == crate::quest_text::LANG_EN {
                            "Accept the trial"
                        } else {
                            "接受試煉"
                        }
                        .to_owned(),
                    ),
                    (
                        1u32,
                        if lang == crate::quest_text::LANG_EN {
                            "End conversation"
                        } else {
                            "結束對話"
                        }
                        .to_owned(),
                    ),
                ],
            ),
            _ => (
                Self::job_advance_line(&quest.dialogue.locked, &title, lang),
                vec![(
                    1u32,
                    if lang == crate::quest_text::LANG_EN {
                        "End conversation"
                    } else {
                        "結束對話"
                    }
                    .to_owned(),
                )],
            ),
        };
        if let Some(npc) = self.npcs.get_mut(npc_id) {
            npc.conversation
                .insert(id.to_owned(), format!("{JOB_ADVANCE_NODE}:{}", quest.quest_id));
        }
        let mut value = npc::DialogueView::Say {
            text,
            kind: "simple".to_owned(),
            options,
        }
        .to_json(request_id, npc_id, name, name_zh);
        value["objectives"] = serde_json::Value::Array(rows);
        self.send_npc_dialogue(id, value);
        true
    }

    /// 玩家在转职菜单里按下的那个键。节点已经在调用方被认过，这里只处理动作。
    #[allow(clippy::too_many_arguments)]
    fn handle_job_advance_selection(
        &mut self,
        id: &str,
        request_id: &str,
        npc_id: &str,
        name: &str,
        name_zh: Option<&str>,
        lang: &str,
        quest: &JobAdvanceQuest,
        status: Option<&str>,
        step: Option<&str>,
        selection: Option<u32>,
    ) -> bool {
        // 节点已在调用方认过：能走到这里，玩家面前就是这条任务的菜单。
        match (step, selection) {
            (Some("end"), _) | (Some("select"), Some(1)) => {
                self.end_conversation(id);
                self.send_npc_dialogue(
                    id,
                    npc::DialogueView::End.to_json(request_id, npc_id, name, name_zh),
                );
                true
            }
            (Some("select"), Some(0)) => match status {
                None => {
                    self.accept_job_advance(id, request_id, npc_id, name, name_zh, lang, quest)
                }
                Some("active") => {
                    self.complete_job_advance(id, request_id, npc_id, name, name_zh, lang, quest)
                }
                _ => {
                    self.end_conversation(id);
                    self.send_reject(
                        id,
                        "npc_step_invalid",
                        if lang == crate::quest_text::LANG_EN {
                            "This conversation option is no longer available."
                        } else {
                            "該對話選項已失效，請重新與 NPC 交談。"
                        },
                        Some(request_id),
                    );
                    true
                }
            },
            _ => {
                self.end_conversation(id);
                self.send_reject(
                    id,
                    "npc_step_invalid",
                    if lang == crate::quest_text::LANG_EN {
                        "This conversation option is no longer available."
                    } else {
                        "該對話選項已失效，請重新與 NPC 交談。"
                    },
                    Some(request_id),
                );
                true
            }
        }
    }

    /// 接取：写 `player_quests` 的 active 行。事务由 `Store::commit_quest` 拥有，
    /// 无 Store（单测 / store-less 世界）时退化为内存镜像，判据与事务路径一致。
    fn accept_job_advance(
        &mut self,
        id: &str,
        request_id: &str,
        npc_id: &str,
        name: &str,
        name_zh: Option<&str>,
        lang: &str,
        quest: &JobAdvanceQuest,
    ) -> bool {
        let eligible = match self.job_advance_facts(id) {
            Some(facts) => rules::requirement_matches(&facts, &quest.require),
            None => false,
        };
        if !eligible {
            self.end_conversation(id);
            let title = quest.title.pick(lang).to_owned();
            let message = Self::job_advance_line(&quest.dialogue.locked, &title, lang);
            self.send_reject(id, "job_advance_unavailable", &message, Some(request_id));
            return true;
        }
        if let Some(store) = self.store.as_ref() {
            let candidate = self.players.get(id).map(|player| {
                profile_from_state(
                    &player.state,
                    &player.map_id,
                    &player.death_id,
                    player.base_max_mp,
                )
            });
            let Some(profile) = candidate else {
                return false;
            };
            match store.commit_quest(id, &quest.quest_id, "active", &profile, &[]) {
                Ok(true) => {}
                // 已接过：幂等重放，不报错、不重复记。
                Ok(false) => {
                    self.end_conversation(id);
                    self.send_npc_dialogue(
                        id,
                        npc::DialogueView::End.to_json(request_id, npc_id, name, name_zh),
                    );
                    return true;
                }
                Err(error) => {
                    self.end_conversation(id);
                    self.send_reject(id, "persistence", &error, Some(request_id));
                    return true;
                }
            }
        }
        if let Some(player) = self.players.get_mut(id) {
            player
                .quests
                .insert(quest.quest_id.clone(), "active".to_owned());
        }
        self.end_conversation(id);
        let title = quest.title.pick(lang).to_owned();
        let text = Self::job_advance_line(&quest.dialogue.accept, &title, lang);
        let mut value = npc::DialogueView::Say {
            text,
            kind: "simple".to_owned(),
            options: Vec::new(),
        }
        .to_json(request_id, npc_id, name, name_zh);
        if let Some(facts) = self.job_advance_facts(id) {
            value["objectives"] =
                serde_json::Value::Array(self.job_advance_objective_rows(quest, &facts, lang));
        }
        self.send_npc_dialogue(id, value);
        self.send_quest_list(id);
        true
    }

    /// 交付：扣材料 → 发奖励 → 切职业 → 落库 → 成功后才写回内存并回执。
    ///
    /// 顺序与 `quest::apply_quest_effect_at` 一致：**先在本进程算出候选**，
    /// 任何一步失败都不落库；落库成功后才把权威结果读回来。
    fn complete_job_advance(
        &mut self,
        id: &str,
        request_id: &str,
        npc_id: &str,
        name: &str,
        name_zh: Option<&str>,
        lang: &str,
        quest: &JobAdvanceQuest,
    ) -> bool {
        // 1) 判定：目标必须全齐，且角色仍处在 from_job。
        let eligible = match self.job_advance_facts(id) {
            Some(facts) => facts.job == quest.from_job && rules::objectives_complete(quest, &facts),
            None => false,
        };
        if !eligible {
            self.end_conversation(id);
            self.send_reject(
                id,
                "job_advance_unavailable",
                if lang == crate::quest_text::LANG_EN {
                    "The trial is not finished yet."
                } else {
                    "試煉尚未完成。"
                },
                Some(request_id),
            );
            return true;
        }

        // 2) 扣材料。扣不掉就不落库（与通用任务同一口径）。
        let mut next_inventory = match self.players.get(id) {
            Some(player) => player.state.inventory.clone(),
            None => return false,
        };
        for (item_id, quantity) in rules::consume_items(quest) {
            let Some(kind) = inventory::inventory_type(&item_id) else {
                self.end_conversation(id);
                self.send_reject(
                    id,
                    "job_advance_requirements_missing",
                    "轉職道具無效。",
                    Some(request_id),
                );
                return true;
            };
            let mut remaining = quantity;
            let slots: Vec<i16> = next_inventory
                .iter()
                .filter(|item| item.item_id == item_id)
                .filter_map(|item| i16::try_from(item.slot).ok())
                .collect();
            for slot in slots {
                if remaining == 0 {
                    break;
                }
                let available = next_inventory
                    .iter()
                    .find(|item| {
                        item.slot == u16::try_from(slot).unwrap_or(0) && item.item_id == item_id
                    })
                    .map(|item| item.quantity)
                    .unwrap_or(0);
                let removed = remaining.min(available);
                if removed == 0 {
                    continue;
                }
                match inventory::remove_items(&mut next_inventory, kind, slot, removed) {
                    Ok((removed_item, actual)) if removed_item == item_id => {
                        remaining = remaining.saturating_sub(actual);
                    }
                    Ok(_) | Err(_) => break,
                }
            }
            if remaining > 0 {
                self.end_conversation(id);
                self.send_reject(
                    id,
                    "job_advance_requirements_missing",
                    "轉職道具數量不足。",
                    Some(request_id),
                );
                return true;
            }
        }

        // 3) 奖励候选：道具、经验、金币，以及转职专属的职业/SP/技能/MP。
        let Some((mut next_state, map_id, death_id, base_max_mp)) =
            self.players.get(id).map(|player| {
                (
                    player.state.clone(),
                    player.map_id.clone(),
                    player.death_id.clone(),
                    player.base_max_mp,
                )
            })
        else {
            return false;
        };
        next_state.inventory = next_inventory;
        let mut granted: Vec<ItemAcquisition> = Vec::new();
        for item in &quest.reward.items {
            if item.item_id.is_empty() || item.quantity == 0 {
                continue;
            }
            let kind = inventory::inventory_type(&item.item_id).unwrap_or(4);
            let slot_limit = self
                .players
                .get(id)
                .and_then(|player| player.state.inventory_slots.get(&kind).copied())
                .unwrap_or(inventory::SLOT_LIMIT);
            if let Err(error) = inventory::add_items(
                &mut next_state.inventory,
                item.item_id.clone(),
                item.quantity,
                slot_limit,
            ) {
                let code = match error {
                    inventory::InventoryError::InventoryFull => "job_advance_inventory_full",
                    inventory::InventoryError::UnknownItem => "job_advance_unknown_item",
                    _ => "job_advance_rejected",
                };
                self.end_conversation(id);
                self.send_reject(
                    id,
                    code,
                    if code == "job_advance_inventory_full" {
                        "背包空間不足，請整理背包後再次與轉職官交談。"
                    } else {
                        "轉職獎勵暫時無法領取，進度已保留。"
                    },
                    Some(request_id),
                );
                return true;
            }
            granted.push(ItemAcquisition {
                item_id: item.item_id.as_str(),
                quantity: item.quantity,
                source: AcquisitionSource::QuestReward,
                source_ref: Some(quest.quest_id.as_str()),
            });
        }
        if quest.reward.exp > 0 {
            Self::add_exp(&mut next_state, quest.reward.exp, &self.gameplay.exp_table);
        }
        next_state.mesos = next_state.mesos.saturating_add(quest.reward.mesos);

        let mut profile = profile_from_state(&next_state, &map_id, &death_id, base_max_mp);
        // 技能点按交付瞬间的等级派生（见 `JobAdvanceQuest::plan`）。
        let plan = quest.plan(next_state.level);
        auth::apply_job_advance_grant(&mut profile, &plan);

        // 4) 落库。事务由 Store 拥有：状态转场 active → completed 是幂等键，
        //    职业 CAS（`durable.job == from_job`）是第二道闸。
        if let Some(store) = self.store.as_ref() {
            match store.commit_job_advance(id, &plan, &profile, &granted) {
                Ok(true) => {}
                // 已完成过：不重复发奖励。
                Ok(false) => {
                    self.end_conversation(id);
                    self.send_npc_dialogue(
                        id,
                        npc::DialogueView::End.to_json(request_id, npc_id, name, name_zh),
                    );
                    return true;
                }
                Err(error) => {
                    self.end_conversation(id);
                    self.send_reject(id, "persistence", &error, Some(request_id));
                    return true;
                }
            }
        }

        // 5) 成功后才写回内存。有 Store 时以库里的事实为准重新加载，
        //    无 Store 时直接用候选（单测路径）。
        if self.store.is_some() {
            let defaults = self.default_profile();
            let reloaded = self
                .store
                .as_ref()
                .and_then(|store| store.load_profile(id, &defaults).ok());
            if let Some(profile) = reloaded {
                if let Some(player) = self.players.get_mut(id) {
                    apply_profile_to_player(&self.gameplay, &self.mage_skills, player, profile);
                }
            }
            let kills = self
                .store
                .as_ref()
                .and_then(|store| store.load_quest_kills(id).ok());
            let quests = self
                .store
                .as_ref()
                .and_then(|store| store.load_quests(id).ok());
            if let Some(player) = self.players.get_mut(id) {
                if let Some(kills) = kills {
                    player.quest_kills = kills;
                }
                if let Some(quests) = quests {
                    player.quests = quests;
                }
            }
        } else if let Some(player) = self.players.get_mut(id) {
            apply_profile_to_player(&self.gameplay, &self.mage_skills, player, profile);
            player
                .quests
                .insert(quest.quest_id.clone(), "completed".to_owned());
        }

        self.end_conversation(id);
        let title = quest.title.pick(lang).to_owned();
        let text = Self::job_advance_line(&quest.dialogue.complete, &title, lang);
        let mut value = npc::DialogueView::Say {
            text,
            kind: "simple".to_owned(),
            options: Vec::new(),
        }
        .to_json(request_id, npc_id, name, name_zh);
        // 与「選擇岔道」快捷转职同一套回执标记：客户端据此打开技能窗并播转职结果。
        value["openSkills"] = serde_json::Value::Bool(true);
        value["trainingResult"] = serde_json::json!({
            "kind": "jobAdvance",
            "job": quest.to_job,
        });
        self.send_npc_dialogue(id, value);
        self.send_quest_list(id);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::rules::*;
    use super::*;
    use crate::protocol::InventoryItem;
    use std::collections::BTreeMap;

    fn item(item_id: &str, quantity: u32) -> InventoryItem {
        InventoryItem {
            slot: 0,
            item_id: item_id.to_owned(),
            quantity,
            stats: None,
            remaining_slots: None,
            upgrade_count: None,
        }
    }

    // 三条二转分支（火毒／冰雷／主教）挂在同一位转职官上 + 一条三转。
    const CATALOG: &str = r#"{"quests":[
        {"questId":"job-210","title":{"zh":"火毒法師的試煉","en":"Trial of the Fire/Poison Magician"},
         "fromJob":200,"toJob":210,
         "npc":{"templateId":"1032001","maps":["101000003"]},
         "require":{"levelAtLeast":30,"quests":[{"questId":"1402","status":"completed"}]},
         "objectives":[{"kind":"kill","mobId":"1130100","required":30}],
         "reward":{"skillPoints":[{"book":210,"amount":5}]}},
        {"questId":"job-220","title":{"zh":"冰雷法師的試煉","en":"Trial of the Ice/Lightning Magician"},
         "fromJob":200,"toJob":220,
         "npc":{"templateId":"1032001","maps":["101000003"]},
         "require":{"levelAtLeast":30,"quests":[{"questId":"1402","status":"completed"}]},
         "objectives":[{"kind":"kill","mobId":"2130100","required":30},
                       {"kind":"collect","itemId":"4000215","required":10}],
         "consumeItems":true,
         "reward":{"skillPoints":[{"book":220,"amount":5}],"skills":[{"skillId":2200011,"level":1}],
                   "maxMpFloor":100,"exp":0,"mesos":0,"items":[]}},
        {"questId":"job-230","title":{"zh":"僧侶的試煉","en":"Trial of the Cleric"},
         "fromJob":200,"toJob":230,
         "npc":{"templateId":"1032001","maps":["101000003"]},
         "require":{"levelAtLeast":30,"quests":[{"questId":"1402","status":"completed"}]},
         "objectives":[{"kind":"kill","mobId":"1140100","required":30}],
         "reward":{"skillPoints":[{"book":230,"amount":5}]}},
        {"questId":"job-221","title":{"zh":"冰雷大魔導士的試煉","en":"Trial of the Ice/Lightning Arch Magician"},
         "fromJob":220,"toJob":221,
         "npc":{"templateId":"1032001","maps":["101000003"]},
         "require":{"levelAtLeast":60,"quests":[{"questId":"job-220","status":"completed"}]},
         "objectives":[{"kind":"kill","mobId":"2230110","required":30}],
         "reward":{"skillPoints":[{"book":221,"amount":5}]}}]}"#;

    fn catalog() -> JobAdvanceCatalog {
        let catalog = serde_json::from_str::<JobAdvanceCatalog>(CATALOG).unwrap();
        catalog.validate().unwrap();
        catalog
    }

    fn parse(raw: &str) -> Result<JobAdvanceCatalog, String> {
        let catalog = serde_json::from_str::<JobAdvanceCatalog>(raw).unwrap();
        catalog.validate()?;
        Ok(catalog)
    }

    #[test]
    fn validation_rejects_broken_configs() {
        // 基准配置：三条二转分支 + 一条三转。
        assert_eq!(catalog().quests.len(), 4);

        // 同一职业的两条分支挂在**不同的 NPC** 上：玩家一次会话选不全。
        let other_npc = r#"{"quests":[{"questId":"a","fromJob":200,"toJob":210,"npc":{"templateId":"1"}},
                                      {"questId":"b","fromJob":200,"toJob":220,"npc":{"templateId":"2"}}]}"#;
        assert!(parse(other_npc).is_err());

        // 同一职业的两条分支挂在**不同的地图**上：同样选不全。
        let other_map = r#"{"quests":[{"questId":"a","fromJob":200,"toJob":210,
                                       "npc":{"templateId":"1","maps":["101000003"]}},
                                      {"questId":"b","fromJob":200,"toJob":220,
                                       "npc":{"templateId":"1","maps":["001020000"]}}]}"#;
        assert!(parse(other_map).is_err());

        // 两条任务转向同一个职业：「转到哪」会取决于配置顺序。
        let same_target = r#"{"quests":[{"questId":"a","fromJob":200,"toJob":220,"npc":{"templateId":"1"}},
                                        {"questId":"b","fromJob":100,"toJob":220,"npc":{"templateId":"1"}}]}"#;
        assert!(parse(same_target).is_err());

        // 职业没变。
        let noop = r#"{"quests":[{"questId":"a","fromJob":200,"toJob":200,"npc":{"templateId":"1"}}]}"#;
        assert!(parse(noop).is_err());

        // 缺 NPC：没有入口的任务等于死配置。
        let no_npc = r#"{"quests":[{"questId":"a","fromJob":200,"toJob":220}]}"#;
        assert!(parse(no_npc).is_err());

        // 目标 required 为 0：会变成无条件可交付。
        let bad_kill = r#"{"quests":[{"questId":"a","fromJob":200,"toJob":220,"npc":{"templateId":"1"},
            "objectives":[{"kind":"kill","mobId":"1","required":0}]}]}"#;
        assert!(parse(bad_kill).is_err());

        // 未知目标类型：宁可启动失败，也不能静默放过。
        let unknown = r#"{"quests":[{"questId":"a","fromJob":200,"toJob":220,"npc":{"templateId":"1"},
            "objectives":[{"kind":"talk","required":1}]}]}"#;
        assert!(parse(unknown).is_err());

        // 空前置 id。
        let empty_prereq = r#"{"quests":[{"questId":"a","fromJob":200,"toJob":220,"npc":{"templateId":"1"},
            "require":{"quests":[{"questId":""}]}}]}"#;
        assert!(parse(empty_prereq).is_err());
    }

    #[test]
    fn candidates_match_job_npc_map_and_come_back_in_a_stable_order() {
        let catalog = catalog();
        // 二转：三条分支，顺序按 questId 排定（不依赖配置书写顺序）。
        let branches: Vec<&str> = catalog
            .candidates(200, "1032001", "101000003")
            .iter()
            .map(|quest| quest.quest_id.as_str())
            .collect();
        assert_eq!(branches, vec!["job-210", "job-220", "job-230"]);
        // 三转：已选定分支，只剩一条。
        let third: Vec<&str> = catalog
            .candidates(220, "1032001", "101000003")
            .iter()
            .map(|quest| quest.quest_id.as_str())
            .collect();
        assert_eq!(third, vec!["job-221"]);
        // 职业不对（新手走 1402，不在这里命中）。
        assert!(catalog.candidates(0, "1032001", "101000003").is_empty());
        // NPC 不对（快捷转职的漢斯不接任务）。
        assert!(catalog.candidates(200, "10201", "101000003").is_empty());
        // 地图不对。
        assert!(catalog.candidates(200, "1032001", "001020000").is_empty());
        assert!(catalog.contains_id("job-220"));
        assert!(!catalog.contains_id("1402"));
    }

    #[test]
    fn active_quest_is_the_branch_the_player_already_picked() {
        let catalog = catalog();
        let mut quests = BTreeMap::new();
        quests.insert("job-230".to_owned(), "active".to_owned());
        assert_eq!(
            catalog.active_quest(&quests).map(|quest| quest.quest_id.as_str()),
            Some("job-230")
        );
        // 已完成不算「进行中」：此时该职业的下一段（三转）才是候选。
        let mut done = BTreeMap::new();
        done.insert("job-220".to_owned(), "completed".to_owned());
        assert!(catalog.active_quest(&done).is_none());
        assert!(catalog.active_quest(&BTreeMap::new()).is_none());
        // 按 id 精确定位：会话中途只认节点里带着的那一条。
        assert_eq!(
            catalog.by_id("job-221").map(|quest| quest.to_job),
            Some(221)
        );
        assert!(catalog.by_id("1402").is_none());
    }

    #[test]
    fn kill_targets_require_an_active_quest() {
        let catalog = catalog();
        let active = BTreeMap::from([("job-220".to_owned(), "active".to_owned())]);
        let completed = BTreeMap::from([("job-220".to_owned(), "completed".to_owned())]);
        assert_eq!(
            catalog.kill_targets(&active, "2130100"),
            vec![("job-220".to_owned(), "2130100".to_owned())]
        );
        assert!(catalog.kill_targets(&completed, "2130100").is_empty());
        assert!(catalog.kill_targets(&active, "9999999").is_empty());
    }

    #[test]
    fn objectives_read_persisted_facts_only() {
        let catalog = catalog();
        let quest = catalog.by_id("job-220").unwrap().clone();
        let quests = BTreeMap::new();
        let mut kills = BTreeMap::new();
        kills.insert(
            "job-220".to_owned(),
            BTreeMap::from([("2130100".to_owned(), 30_u32)]),
        );
        let inventory = vec![item("4000215", 10)];
        let facts = Facts {
            level: 30,
            job: 200,
            quests: &quests,
            inventory: &inventory,
            kills: &kills,
        };
        assert!(objectives_complete(&quest, &facts));
        assert_eq!(
            objective_current(&quest.quest_id, &quest.objectives[0], &facts),
            30
        );
        assert_eq!(
            objective_current(&quest.quest_id, &quest.objectives[1], &facts),
            10
        );

        // 差一个就不算完成：不给「差不多就行」留缝。
        let short = Facts {
            inventory: &[item("4000215", 9)],
            ..facts
        };
        assert!(!objectives_complete(&quest, &short));

        let mut almost = BTreeMap::new();
        almost.insert(
            "job-220".to_owned(),
            BTreeMap::from([("2130100".to_owned(), 29_u32)]),
        );
        let almost_facts = Facts {
            kills: &almost,
            ..facts
        };
        assert!(!objectives_complete(&quest, &almost_facts));
    }

    #[test]
    fn requirement_gates_on_level_and_prerequisite() {
        let catalog = catalog();
        let quest = catalog.by_id("job-220").unwrap().clone();
        let kills = BTreeMap::new();
        let inventory: Vec<InventoryItem> = Vec::new();
        let done = BTreeMap::from([("1402".to_owned(), "completed".to_owned())]);
        let active_only = BTreeMap::from([("1402".to_owned(), "active".to_owned())]);

        let ok = Facts {
            level: 30,
            job: 200,
            quests: &done,
            inventory: &inventory,
            kills: &kills,
        };
        assert!(requirement_matches(&ok, &quest.require));
        // 等级差一级。
        assert!(!requirement_matches(
            &Facts { level: 29, ..ok },
            &quest.require
        ));
        // 前置只是 active，不算完成。
        assert!(!requirement_matches(
            &Facts {
                quests: &active_only,
                ..ok
            },
            &quest.require
        ));
        // 前置缺一行。
        assert!(!requirement_matches(
            &Facts {
                quests: &BTreeMap::new(),
                ..ok
            },
            &quest.require
        ));
    }

    #[test]
    fn consume_items_covers_collect_objectives_only() {
        let catalog = catalog();
        // 只有冰雷那条带收集目标，按 id 取（`quests[0]` 不再是它）。
        let mut quest = catalog.by_id("job-220").unwrap().clone();
        assert_eq!(consume_items(&quest), vec![("4000215".to_owned(), 10_u32)]);
        quest.consume_items = false;
        assert!(consume_items(&quest).is_empty());
    }

    #[test]
    fn plan_carries_the_job_transition_contract() {
        let catalog = catalog();
        // 按时转职（正好 30 级）：配置里的起手 5 点就是全部。
        let plan = catalog.by_id("job-220").unwrap().plan(30);
        assert_eq!(plan.from_job, 200);
        assert_eq!(plan.to_job, 220);
        assert_eq!(plan.level_at_least, 30);
        assert_eq!(plan.skill_points, vec![(220, 5)]);
        assert_eq!(plan.skills, vec![(2200011, 1)]);
        assert_eq!(plan.max_mp_floor, 100);
        // 晚转职：30→45 这 15 级的点数必须一起补（5 + 3×15 = 50）。
        let late = catalog.by_id("job-220").unwrap().plan(45);
        assert_eq!(late.skill_points, vec![(220, 50)]);
        // 三转同理：按时 5 点，90 级才转则是 5 + 3×30 = 95。
        let third = catalog.by_id("job-221").unwrap().plan(60);
        assert_eq!(third.skill_points, vec![(221, 5)]);
        let late_third = catalog.by_id("job-221").unwrap().plan(90);
        assert_eq!(late_third.skill_points, vec![(221, 95)]);
    }

    /// 配置里写的 `amount` 必须就是「按时转职」的那一份，否则派生公式与配置
    /// 各说各话——把整张表逐条对一遍，漂移在测试里红，而不是在玩家身上。
    #[test]
    fn authored_skill_points_match_the_level_derived_floor() {
        let catalog = JobAdvanceCatalog::load(
            &std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("shared/job-advance.json"),
        )
        .expect("bundled job advance catalog");
        for quest in &catalog.quests {
            for point in &quest.reward.skill_points {
                assert_eq!(
                    point.amount,
                    crate::auth::book_sp_through_level(
                        point.book,
                        quest.require.level_at_least,
                        true
                    ),
                    "{}: book {} 的配置点数与派生根值不一致",
                    quest.quest_id,
                    point.book
                );
            }
        }
    }
}
