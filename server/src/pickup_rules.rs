//! 拾取纯规则（计划 R6：第二个窄输入试点，先例 `quest_rules.rs`）。
//!
//! 只回答一个问题：「这颗掉落现在能不能被这个玩家拾取」。不持有 `World`、
//! `Store` 或连接，不产生副作用；输入是 [`PickupFacts`] 窄视图，输出是
//! [`PickupVerdict`]。掉落缺失（`drops` 里查不到）由调用方处理——窄视图
//! 只在掉落存在时才能构造。
//!
//! 容量预检只对**无 Store 的内存权威路径**生效：调用方用
//! `memory_capacity: None` 表示 Store 权威路径（容量由事务内重验）。
//! 该判定是"试探式复制一份再 add"的纯计算，原样保留在规则侧。
//!
//! 本模块**有意不使用** `use super::*`：所有依赖显式列出，未来任何把
//! `World` / `Store` / 网络依赖引进来的改动都会在 review 中一眼可见。
//! 事务时序（幂等查询 → 纯判定 → Store 提交 → 世界回填 → 回执）与
//! 失败/重放/回填失败窗口的说明见 `BACKEND_ARCHITECTURE.md`
//! 「拾取事务时序」节；`handle_pickup` 仍是唯一的事务协调者。

use std::collections::BTreeMap;

use crate::inventory;
use crate::protocol::InventoryItem;

/// 源实现的拾取距离（inventory_ops 原 `pickup_range` 局部常量，逐字保留）。
pub(super) const PICKUP_RANGE: f64 = 32.0;

/// 掉落判定所需的窄视图：只在掉落存在时由调用方构造。
pub(super) struct PickupDropView<'a> {
    pub(super) item_id: &'a str,
    pub(super) quantity: u32,
    pub(super) x: f64,
    pub(super) y: f64,
}

/// 无 Store 内存权威路径的容量预检输入：背包快照 + 该页签槽位上限 +
/// 装备实例元数据（与原实现的试探入包参数一致）。
#[derive(Clone, Copy)]
pub(super) struct CapacityProbe<'a> {
    pub(super) inventory: &'a [InventoryItem],
    pub(super) slot_limit: u16,
    pub(super) stats: Option<&'a BTreeMap<String, i64>>,
    pub(super) remaining_slots: Option<u32>,
    pub(super) upgrade_count: Option<u32>,
}

/// 拾取判定输入。字段只读；`drop_map`/`drop_owner` 的 `None` 语义
/// 与原实现一致：未登记地图按可拾取处理，无归属记录则无保护窗口。
pub(super) struct PickupFacts<'a> {
    pub(super) player_id: &'a str,
    pub(super) player_x: f64,
    pub(super) player_y: f64,
    /// 毫秒时钟；与 `auth::now_ms()` 同为 i64（授权时钟语义原样保留）。
    pub(super) now_ms: i64,
    pub(super) map_id: &'a str,
    pub(super) drop: PickupDropView<'a>,
    pub(super) drop_map: Option<&'a str>,
    pub(super) drop_owner: Option<&'a (Option<String>, i64)>,
    /// 仅内存路径提供；Store 权威路径必须传 `None`。
    pub(super) memory_capacity: Option<CapacityProbe<'a>>,
}

/// 拾取判定结果：允许，或带回原实现的拒绝码与文案。
pub(super) enum PickupVerdict {
    Allowed,
    Reject {
        code: &'static str,
        message: &'static str,
    },
}

fn reject(code: &'static str, message: &'static str) -> PickupVerdict {
    PickupVerdict::Reject { code, message }
}

/// 掉落可得性判定。与原 `handle_pickup` 的校验链逐条一致，顺序固定：
/// 地图匹配 → 归属保护窗口 → 距离 → 内存容量预检。
pub(super) fn evaluate_pickup(facts: &PickupFacts<'_>) -> PickupVerdict {
    if facts
        .drop_map
        .is_some_and(|drop_map| drop_map != facts.map_id)
    {
        return reject("drop_unavailable", "Drop is unavailable");
    }
    if facts.drop_owner.is_some_and(|(owner, until)| {
        owner
            .as_deref()
            .is_some_and(|owner| owner != facts.player_id)
            && facts.now_ms < *until
    }) {
        return reject("drop_owned", "该物品暂时不可拾取");
    }
    if (facts.player_x - facts.drop.x).abs() > PICKUP_RANGE
        || (facts.player_y - facts.drop.y).abs() > PICKUP_RANGE
    {
        return reject("out_of_range", "Drop is out of range");
    }
    if let Some(probe) = facts.memory_capacity.as_ref() {
        // 金币（"0"）不占页签；ConsumeOnPickup 卡片恒可收（图鉴饱和在
        // 应用阶段处理），二者都不做容量预检——与原实现分支一致。
        if drop_needs_capacity_check(&facts.drop) && !memory_capacity_allows(probe, &facts.drop) {
            return reject("inventory_full", "Inventory is full");
        }
    }
    PickupVerdict::Allowed
}

/// 内存路径容量预检：试探式复制背包并执行一次入包，失败即判满。
/// 与原实现的 clone + `add_item_instance` + `is_err()` 逐行一致。
fn memory_capacity_allows(probe: &CapacityProbe<'_>, drop: &PickupDropView<'_>) -> bool {
    let mut trial = probe.inventory.to_vec();
    inventory::add_item_instance(
        &mut trial,
        drop.item_id.to_owned(),
        drop.quantity,
        probe.slot_limit,
        probe.stats,
        probe.remaining_slots,
        probe.upgrade_count,
    )
    .is_ok()
}

/// 金币（"0"）不占页签；ConsumeOnPickup 卡片恒可收，二者跳过容量预检。
fn drop_needs_capacity_check(drop: &PickupDropView<'_>) -> bool {
    drop.item_id != "0" && !inventory::consume_on_pickup(drop.item_id)
}

/// 图鉴卡片饱和入账（原 handle_pickup 内存路径的逐字抽离）：
/// 每种卡片至多记 5 张，超出部分静默丢弃但拾取本身仍成功。
pub(super) fn saturate_monster_book(book: &mut BTreeMap<String, u8>, item_id: &str, quantity: u32) {
    let entry = book.entry(item_id.to_owned()).or_insert(0);
    let current = *entry;
    let amount = quantity.min(u32::from(5_u8.saturating_sub(current)));
    *entry = current
        .saturating_add(u8::try_from(amount).unwrap_or(0))
        .min(5);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drop_view(item_id: &str) -> PickupDropView<'_> {
        PickupDropView {
            item_id,
            quantity: 1,
            x: 10.0,
            y: 0.0,
        }
    }

    fn facts(drop: PickupDropView<'_>) -> PickupFacts<'_> {
        PickupFacts {
            player_id: "a",
            player_x: 10.0,
            player_y: 0.0,
            now_ms: 1_000,
            map_id: "test",
            drop,
            drop_map: Some("test"),
            drop_owner: None,
            memory_capacity: None,
        }
    }

    #[test]
    fn map_mismatch_rejects_with_drop_unavailable() {
        let verdict = evaluate_pickup(&facts(drop_view("4000019")));
        assert!(matches!(verdict, PickupVerdict::Allowed));
        let mut mismatch = facts(drop_view("4000019"));
        mismatch.drop_map = Some("other");
        assert!(matches!(
            evaluate_pickup(&mismatch),
            PickupVerdict::Reject {
                code: "drop_unavailable",
                ..
            }
        ));
        // 未登记地图（None）按可拾取处理，与原实现一致。
        let mut unregistered = facts(drop_view("4000019"));
        unregistered.drop_map = None;
        assert!(matches!(
            evaluate_pickup(&unregistered),
            PickupVerdict::Allowed
        ));
    }

    #[test]
    fn ownership_window_rejects_only_other_players_within_deadline() {
        let other_protected = (Some("b".to_owned()), 2_000);
        let own_protected = (Some("a".to_owned()), 2_000);
        let other_expired = (Some("b".to_owned()), 1_000);
        let no_owner = (None, 2_000);
        let mut owned = facts(drop_view("4000019"));
        owned.drop_owner = Some(&other_protected);
        assert!(matches!(
            evaluate_pickup(&owned),
            PickupVerdict::Reject {
                code: "drop_owned",
                ..
            }
        ));
        // 归属者本人拾取不受保护窗口限制。
        let mut own = facts(drop_view("4000019"));
        own.drop_owner = Some(&own_protected);
        assert!(matches!(evaluate_pickup(&own), PickupVerdict::Allowed));
        // 保护过期后对任何人开放。
        let mut expired = facts(drop_view("4000019"));
        expired.drop_owner = Some(&other_expired);
        assert!(matches!(evaluate_pickup(&expired), PickupVerdict::Allowed));
        // 无归属记录（丢弃物）从一开始就是公共的。
        let mut public = facts(drop_view("4000019"));
        public.drop_owner = Some(&no_owner);
        assert!(matches!(evaluate_pickup(&public), PickupVerdict::Allowed));
    }

    #[test]
    fn range_boundary_is_inclusive_at_pickup_range() {
        let mut far = facts(drop_view("4000019"));
        far.player_x = 10.0 + PICKUP_RANGE;
        far.player_y = PICKUP_RANGE;
        assert!(matches!(evaluate_pickup(&far), PickupVerdict::Allowed));
        far.player_x = 10.0 + PICKUP_RANGE + 0.5;
        assert!(matches!(
            evaluate_pickup(&far),
            PickupVerdict::Reject {
                code: "out_of_range",
                ..
            }
        ));
        far.player_x = 10.0;
        far.player_y = PICKUP_RANGE + 0.5;
        assert!(matches!(
            evaluate_pickup(&far),
            PickupVerdict::Reject {
                code: "out_of_range",
                ..
            }
        ));
    }

    #[test]
    fn memory_capacity_rejects_full_tab_but_spares_mesos_and_cards() {
        // 装备不堆叠、每件占一格：slot_limit=1 且唯一格已被装备占用，
        // 再拾取另一件装备必须判满。
        let full = vec![InventoryItem {
            slot: 1,
            item_id: "1002067".into(),
            quantity: 1,
            ..InventoryItem::default()
        }];
        let probe = CapacityProbe {
            inventory: &full,
            slot_limit: 1,
            stats: None,
            remaining_slots: None,
            upgrade_count: None,
        };
        let mut full_facts = facts(drop_view("1102173"));
        full_facts.memory_capacity = Some(probe);
        assert!(matches!(
            evaluate_pickup(&full_facts),
            PickupVerdict::Reject {
                code: "inventory_full",
                ..
            }
        ));
        // 金币不占页签：同一名额下拾取金币恒可行。
        let mut mesos = facts(drop_view("0"));
        mesos.memory_capacity = Some(probe);
        assert!(matches!(evaluate_pickup(&mesos), PickupVerdict::Allowed));
        // ConsumeOnPickup 卡片恒可收（2380000 是图鉴卡片族）。
        let mut card = facts(drop_view("2380000"));
        card.memory_capacity = Some(probe);
        assert!(matches!(evaluate_pickup(&card), PickupVerdict::Allowed));
        // Store 权威路径（probe=None）不做内存预检。
        let mut store_path = facts(drop_view("1102173"));
        store_path.memory_capacity = None;
        assert!(matches!(
            evaluate_pickup(&store_path),
            PickupVerdict::Allowed
        ));
    }

    #[test]
    fn monster_book_saturates_at_five() {
        let mut book = BTreeMap::new();
        saturate_monster_book(&mut book, "2380000", 3);
        assert_eq!(book.get("2380000"), Some(&3));
        saturate_monster_book(&mut book, "2380000", 3);
        assert_eq!(book.get("2380000"), Some(&5), "3+3 saturates at five");
        saturate_monster_book(&mut book, "2380000", 2);
        assert_eq!(book.get("2380000"), Some(&5), "already full stays full");
        saturate_monster_book(&mut book, "2380001", 2);
        assert_eq!(book.get("2380001"), Some(&2));
    }
}
