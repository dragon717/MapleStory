//! 任务纯规则（计划 §6：quest_rules 试点）。
//!
//! 只做**判定与归一化**：不持有 `World`、`Store`、WebSocket 或 SQLite，
//! 不接收 `&mut` 世界状态；输入只取判定所需的必要事实。需要整个玩家视图的
//! 调用方（`quest.rs`）先用 [`QuestFacts`] 显式收窄再传入。
//!
//! 本模块**有意不使用** `use super::*`：所有依赖显式列出，未来任何把
//! `World` / `Store` / 网络依赖引进来的改动都会在 review 中一眼可见。
//! 任务交互与领奖的完整事务（`apply_quest_effect_at` 等）仍留在 `quest.rs`，
//! 这里不碰事务、回执与协议顺序。

use std::collections::BTreeMap;

use super::{QuestConditions, QuestItemRequirement, QuestPrerequisite, QuestSpec};
use crate::protocol::InventoryItem;

/// 条件判定所需的玩家事实视图：等级、职业、任务进度与背包/已装备物品。
/// 不包含位置、技能、连接或任何世界状态；字段只读。
pub(super) struct QuestFacts<'a> {
    pub(super) level: u32,
    pub(super) job: u32,
    pub(super) quests: &'a BTreeMap<String, String>,
    pub(super) inventory: &'a [InventoryItem],
    pub(super) equipped: &'a [InventoryItem],
}

/// 背包内某道具的总持有量（不含装备栏）。
pub(super) fn item_count(inventory: &[InventoryItem], item_id: &str) -> u32 {
    inventory
        .iter()
        .filter(|item| item.item_id == item_id)
        .fold(0_u32, |total, item| total.saturating_add(item.quantity))
}

/// 已装备栏内某道具的数量；装备实例数量按 1 起算（与原 `quest_equipped_item_count` 一致）。
pub(super) fn equipped_item_count(equipped: &[InventoryItem], item_id: &str) -> u32 {
    equipped
        .iter()
        .filter(|item| item.item_id == item_id)
        .fold(0_u32, |total, item| {
            total.saturating_add(item.quantity.max(1))
        })
}

/// 职业条件：空列表表示不限职业。
pub(super) fn jobs_match(conditions: &QuestConditions, job: u32) -> bool {
    conditions.job.is_empty() || conditions.job.contains(&job)
}

/// 前置任务判定。`or_option`（源 Check.QuestOrOption == 1）把清单变成 OR：
/// 任一前置满足即可（路线检查点互斥），否则要求全部满足。
/// 前置未写 `status` 时默认要求 `completed`；缺省进度视为不满足。
pub(super) fn prerequisites_match(
    quests: &BTreeMap<String, String>,
    prerequisites: &[QuestPrerequisite],
    or_option: bool,
) -> bool {
    let mut satisfied = prerequisites.iter().map(|requirement| {
        let expected = requirement.status.as_deref().unwrap_or("completed");
        quests
            .get(&requirement.quest_id)
            .is_some_and(|status| status == expected)
    });
    if or_option {
        satisfied.any(|matched| matched)
    } else {
        satisfied.all(|matched| matched)
    }
}

/// 完整条件判定：等级、职业、前置任务、背包材料与已装备物品。
/// 与原 `World::quest_conditions_match` 的语义逐条一致。
pub(super) fn conditions_match(facts: &QuestFacts<'_>, conditions: &QuestConditions) -> bool {
    (conditions.level_at_least == 0 || facts.level >= conditions.level_at_least)
        && jobs_match(conditions, facts.job)
        && prerequisites_match(facts.quests, &conditions.quests, conditions.quest_or_option)
        && conditions.items.iter().all(|requirement| {
            !requirement.item_id.is_empty()
                && requirement.quantity > 0
                && item_count(facts.inventory, &requirement.item_id) >= requirement.quantity
        })
        && conditions
            .equipped_items
            .iter()
            .all(|item_id| !item_id.is_empty() && equipped_item_count(facts.equipped, item_id) > 0)
}

/// 交付阶段的默认消耗清单：即完成条件的物品清单。
pub(super) fn complete_items(spec: &QuestSpec) -> Vec<QuestItemRequirement> {
    spec.complete.conditions.items.clone()
}

/// 消耗清单归一化：数组按内容解析（解析失败回退到完成条件清单）、
/// `false` 表示不消耗、其余形状（缺省/`true`/`null`）回退到完成条件清单。
/// 与原 `World::quest_consume_items` 的分支一一对应。
pub(super) fn consume_items(spec: &QuestSpec) -> Vec<QuestItemRequirement> {
    match &spec.complete.consume_items {
        serde_json::Value::Array(items) => {
            serde_json::from_value(serde_json::Value::Array(items.clone()))
                .unwrap_or_else(|_| complete_items(spec))
        }
        serde_json::Value::Bool(false) => Vec::new(),
        _ => complete_items(spec),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn requirement(item_id: &str, quantity: u32) -> QuestItemRequirement {
        QuestItemRequirement {
            item_id: item_id.to_owned(),
            quantity,
        }
    }

    fn inventory_item(item_id: &str, quantity: u32) -> InventoryItem {
        InventoryItem {
            slot: 0,
            item_id: item_id.to_owned(),
            quantity,
            stats: None,
            remaining_slots: None,
            upgrade_count: None,
        }
    }

    fn facts<'a>(
        level: u32,
        job: u32,
        quests: &'a BTreeMap<String, String>,
        inventory: &'a [InventoryItem],
        equipped: &'a [InventoryItem],
    ) -> QuestFacts<'a> {
        QuestFacts {
            level,
            job,
            quests,
            inventory,
            equipped,
        }
    }

    #[test]
    fn empty_job_condition_accepts_any_job() {
        let mut conditions = QuestConditions::default();
        conditions.job = vec![];
        assert!(jobs_match(&conditions, 0));
        assert!(jobs_match(&conditions, 2));
        conditions.job = vec![2, 4];
        assert!(jobs_match(&conditions, 2));
        assert!(!jobs_match(&conditions, 1));
    }

    #[test]
    fn prerequisites_default_to_completed_and_honor_or_option() {
        let quests = BTreeMap::from([
            ("36301".to_owned(), "completed".to_owned()),
            ("36304".to_owned(), "active".to_owned()),
        ]);
        let both = vec![
            QuestPrerequisite {
                quest_id: "36301".to_owned(),
                status: None,
            },
            QuestPrerequisite {
                quest_id: "36304".to_owned(),
                status: Some("completed".to_owned()),
            },
        ];
        // AND：缺一个都不行；active 不等于 completed。
        assert!(!prerequisites_match(&quests, &both, false));
        // OR：任一满足即可。
        assert!(prerequisites_match(&quests, &both, true));
        // 空前置集合是既有语义（特征测试，不是产品裁决）：
        // AND 语义下恒满足（all 空迭代器 = true），
        // OR 语义下恒不满足（any 空迭代器 = false）。保持原样，不改规则；
        // 该 quirk 已单独登记，留待产品口径确认后另行修复。
        assert!(prerequisites_match(&quests, &[], false));
        assert!(!prerequisites_match(&quests, &[], true));
        // 完全未接的任务不满足缺省的 completed 期望。
        let missing = vec![QuestPrerequisite {
            quest_id: "99999".to_owned(),
            status: None,
        }];
        assert!(!prerequisites_match(&quests, &missing, true));
    }

    #[test]
    fn conditions_check_level_job_items_and_equipment_separately() {
        let quests = BTreeMap::new();
        let inventory = vec![inventory_item("4000000", 2), inventory_item("4000000", 3)];
        let equipped = vec![inventory_item("1302000", 1)];
        let mut conditions = QuestConditions::default();
        conditions.level_at_least = 10;
        conditions.items = vec![requirement("4000000", 5)];
        conditions.equipped_items = vec!["1302000".to_owned()];

        assert!(conditions_match(
            &facts(10, 2, &quests, &inventory, &equipped),
            &conditions
        ));
        // 材料恰好够 / 差一个。
        assert!(!conditions_match(
            &facts(10, 2, &quests, &inventory[..1], &equipped),
            &conditions
        ));
        // 等级不够，即使材料与装备都齐。
        assert!(!conditions_match(
            &facts(9, 2, &quests, &inventory, &equipped),
            &conditions
        ));
        // 职业不匹配。
        let mut job_conditions = QuestConditions::default();
        job_conditions.job = vec![4];
        assert!(!conditions_match(
            &facts(10, 2, &quests, &inventory, &equipped),
            &job_conditions
        ));
        // 要求穿装备但没穿。
        let mut equip_only = QuestConditions::default();
        equip_only.equipped_items = vec!["1302000".to_owned()];
        assert!(conditions_match(
            &facts(1, 0, &quests, &[], &equipped),
            &equip_only
        ));
        assert!(!conditions_match(
            &facts(1, 0, &quests, &inventory, &[]),
            &equip_only
        ));
        // 空白条目与零数量要求一律不满足（防御 authored 数据）。
        let mut junk = QuestConditions::default();
        junk.items = vec![requirement("", 1), requirement("4000000", 0)];
        assert!(!conditions_match(
            &facts(1, 0, &quests, &inventory, &[]),
            &junk
        ));
        let mut junk_equip = QuestConditions::default();
        junk_equip.equipped_items = vec!["".to_owned()];
        assert!(!conditions_match(
            &facts(1, 0, &quests, &[], &[]),
            &junk_equip
        ));
    }

    #[test]
    fn consume_items_matches_original_branches() {
        let mut spec = QuestSpec::default();
        spec.complete.conditions.items = vec![requirement("4000000", 2)];

        // 数组：按内容解析，覆盖完成条件清单。
        spec.complete.consume_items = serde_json::json!([{"itemId": "4000001", "quantity": 3}]);
        let items = consume_items(&spec);
        assert_eq!(items.len(), 1);
        assert_eq!((&*items[0].item_id, items[0].quantity), ("4000001", 3));

        // 空数组：解析成功，结果就是空，不回退。
        spec.complete.consume_items = serde_json::json!([]);
        assert!(consume_items(&spec).is_empty());

        // false：不消耗。
        spec.complete.consume_items = serde_json::Value::Bool(false);
        assert!(consume_items(&spec).is_empty());

        // 其余形状（true / null / 缺省 / 解析失败）：回退到完成条件清单。
        spec.complete.consume_items = serde_json::json!(true);
        assert_eq!(consume_items(&spec).len(), 1);
        spec.complete.consume_items = serde_json::Value::Null;
        assert_eq!(consume_items(&spec)[0].item_id, "4000000");
        spec.complete.consume_items = serde_json::json!([{"itemId": 12}]);
        let fallback = consume_items(&spec);
        assert_eq!(
            (&*fallback[0].item_id, fallback[0].quantity),
            ("4000000", 2)
        );

        assert!(complete_items(&spec).iter().all(|r| r.item_id == "4000000"));
    }

    #[test]
    fn equipped_counts_floor_at_one_per_instance() {
        // 装备实例 quantity 可能为 0，计数按 1 起算；背包数量按实际累加。
        assert_eq!(
            equipped_item_count(&[inventory_item("1302000", 0)], "1302000"),
            1
        );
        assert_eq!(equipped_item_count(&[], "1302000"), 0);
        assert_eq!(
            item_count(
                &[inventory_item("4000000", 0), inventory_item("4000000", 2)],
                "4000000"
            ),
            2
        );
    }
}
