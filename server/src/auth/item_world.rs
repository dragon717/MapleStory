//! 物品世界事实（Owner / Location / State）与唯一的"搬运"领域原语。
//!
//! 依据 `docs/technical/rust_authoritative_world_model.md`：
//! - §2 / §3：把"谁拥有 / 在哪里 / 是否可操作"拆成三个独立维度，而不是一个容器；
//! - §6 / §9：业务层只表达完整动作（`MoveItem`），`peek` / `take` / `put` 是容器
//!   实现细节，单独一个都维持不了世界不变量，因此都不公开；
//! - §13：背包 ⇄ 仓库是 **Move**（Owner 不变、Location 改变），不是所有权转移；
//! - §32：一个业务动作一个事务，不存在"take 成功 / put 失败"的悬空状态；
//! - §41：只有行为契约真正一致的实现才共享抽象——所以只有背包与仓库实现
//!   `Source` / `Destination`，掉落物不实现（它的规则是"谁在什么时候获得操作权"，
//!   属于 §11 明确排除的那一类）。
//!
//! 本模块是**位置搬迁**与**事实命名**，不新增机制：所有 SQL 仍在 `auth/db.rs`，
//! 所有物品目录与堆叠规则仍在 `crate::inventory`，业务判定与幂等回执仍在 `Store`。

use super::*;
use rusqlite::Transaction;

/// 物品属于谁（世界模型 §3.1）。
///
/// 用 enum 而不是 `{ owner_type: u8, account_id: Option<String> }`：后者可以
/// 写出"系统拥有却带着玩家 id"这种非法组合（§3.1 明确不建议）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Owner<'a> {
    /// 某个账号。
    Account(&'a str),
    /// 系统——例如还没有归属的掉落物。
    System,
}

/// 物品在哪里（世界模型 §3.2）——这是**事实**，所以自带槽位。
///
/// 每个变体自带它需要的身份，因此不可能出现"location = Storage 却带着掉落
/// id"这种逻辑上不存在的状态。本轮只列出**已经有实现**的两处；装备栏与地面
/// 掉落等各自增量（见审查文档 §6 路线图），不提前建空变体。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ItemLocation<'a> {
    /// 角色背包的某一页签某一格。
    Inventory {
        account_id: &'a str,
        kind: u8,
        slot: i16,
    },
    /// 账号仓库的某一格。
    Storage { account_id: &'a str, slot: i16 },
}

/// 一个容器的**哪一侧**——这是**意图**，所以刻意没有槽位。
///
/// 本项目的放入动作一律由容器自选落点（合并同叠，或找第一个空格），业务层
/// 说不出、也不该说出目标槽位；把这个事实表达成"意图没有槽位、事实才有槽位"，
/// 正是 §39 让非法状态难以表达的做法。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ContainerSide<'a> {
    Inventory { account_id: &'a str },
    Storage { account_id: &'a str },
}

/// 物品当前为什么不可自由操作（世界模型 §3.3）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum LockReason {
    /// 掉落保护窗。这是源里**已经存在**的事实（`drops.protected_until_ms`），
    /// 本模块只是把它命名成一个锁，没有新增任何机制。
    PickupProtection { until_ms: i64 },
}

/// 物品当前是否可操作（世界模型 §3.3）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ItemState {
    Normal,
    Locked(LockReason),
}

/// 一次搬运被拒绝的**原因**。
///
/// 刻意不带字符串：同一个原因在不同业务动作里说法不同——"来源那一格是空的"
/// 在存仓时叫 `source_empty`，在取回时叫 `storage_slot_empty`；"装不下"在存仓
/// 时叫 `storage_full`，在取回时叫 `inventory_full`。玩家可见的码是**业务动作的
/// 词汇**，不是容器的词汇，所以容器只回答"为什么不行"，由动作翻译成码
/// （世界模型 §31：命令与事件不能混淆）。
///
/// 这个类型同时解掉了后续增量的唯一阻塞：以前 `peek` 直接回一个字符串码，
/// 于是任何新位置想接入搬运都得伪造别人的码；现在新位置只需回自己的原因。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum MoveRefusal {
    /// 槽位不合法。
    InvalidSlot,
    /// 请求数量不是正数，或超过来源那一叠实际有的数量。
    InvalidQuantity,
    /// 来源那一格是空的。
    SourceEmpty,
    /// 目标一侧装不下这一叠。
    DestinationFull,
}

/// 一个掉落物的世界事实投影：谁先有权拿、当前是否在保护窗内。
///
/// 搬的是判定依据，不是判定时机：`protected_until_ms <= 0` 表示源里没有登记
/// 保护窗（历史上迁移过来的旧行为），投影成 `State::Normal`。
pub(super) fn drop_fact(owner_id: Option<&str>, protected_until_ms: i64) -> (Owner<'_>, ItemState) {
    let owner = match owner_id {
        Some(id) => Owner::Account(id),
        None => Owner::System,
    };
    let state = if protected_until_ms > 0 {
        ItemState::Locked(LockReason::PickupProtection {
            until_ms: protected_until_ms,
        })
    } else {
        ItemState::Normal
    };
    (owner, state)
}

/// 世界模型 §41 的行为契约：`Normal` 对所有人开放；`Locked(PickupProtection)`
/// 在窗口内只属于保护对象，窗口过期后同样对所有人开放。`Owner::System`
/// 表示"无人认领"，任何窗口都不排斥别人。
///
/// 这是重构前 `pickup` 里那一行内联比较的唯一翻译点，真值表见本文件测试。
pub(super) fn pickup_allowed(
    owner: &Owner<'_>,
    state: &ItemState,
    account_id: &str,
    now_ms: i64,
) -> bool {
    match state {
        ItemState::Normal => true,
        ItemState::Locked(LockReason::PickupProtection { until_ms }) => {
            if *until_ms <= now_ms {
                return true;
            }
            !matches!(owner, Owner::Account(owner_id) if *owner_id != account_id)
        }
    }
}

/// 能定位并取出一叠物品的一侧（世界模型 §10 的容器原语）。
///
/// 刻意**不是** `pub trait`：它只是 Item 领域为了表达"搬运"而存在的内部抽象，
/// 业务模块既不需要、也无法看到它。方法同样不是 `pub`（§7 / §9）：单个
/// `peek` 或 `take` 都维持不了世界不变量。
trait Source {
    /// 只读探测：这一格能不能拿出 `quantity`。`Ok(Err(reason))` 是业务拒绝，
    /// `Err` 才是持久化失败。
    fn peek(
        &self,
        tx: &Transaction<'_>,
        quantity: u32,
    ) -> Result<Result<StorageStack, MoveRefusal>, String>;

    /// 真正取出。只在 `peek` 通过之后调用。
    fn take(&self, tx: &Transaction<'_>, quantity: u32) -> Result<(), String>;
}

/// 能收下一叠物品的一侧。落点由它自己决定，所以契约里没有槽位参数。
trait Destination {
    /// 只读预判能不能收下。语义同 `Source::peek` 的两层错误。
    fn can_accept(
        &self,
        tx: &Transaction<'_>,
        stack: &StorageStack,
    ) -> Result<Result<(), MoveRefusal>, String>;

    /// 真正放入。只在 `can_accept` 通过之后调用。
    fn put(&self, tx: &Transaction<'_>, stack: &StorageStack) -> Result<(), String>;
}

/// 背包来源。契约：`take` 成功后物品确实从背包移除。
struct InventorySource<'a> {
    account_id: &'a str,
    kind: u8,
    slot: i16,
}

impl Source for InventorySource<'_> {
    fn peek(
        &self,
        tx: &Transaction<'_>,
        quantity: u32,
    ) -> Result<Result<StorageStack, MoveRefusal>, String> {
        peek_inventory_stack(tx, self.account_id, self.kind, self.slot, quantity)
    }

    fn take(&self, tx: &Transaction<'_>, quantity: u32) -> Result<(), String> {
        take_inventory_stack(tx, self.account_id, self.kind, self.slot, quantity)
    }
}

/// 仓库来源。与背包来源共用同一份契约，因此二者可互换（§41）。
struct StorageSource<'a> {
    account_id: &'a str,
    slot: i16,
}

impl Source for StorageSource<'_> {
    fn peek(
        &self,
        tx: &Transaction<'_>,
        quantity: u32,
    ) -> Result<Result<StorageStack, MoveRefusal>, String> {
        peek_storage_stack(tx, self.account_id, self.slot, quantity)
    }

    fn take(&self, tx: &Transaction<'_>, quantity: u32) -> Result<(), String> {
        take_storage_stack(tx, self.account_id, self.slot, quantity)
    }
}

/// 背包目标。契约：`put` 成功后物品确实在背包里。
struct InventoryDestination<'a> {
    account_id: &'a str,
}

impl Destination for InventoryDestination<'_> {
    fn can_accept(
        &self,
        tx: &Transaction<'_>,
        stack: &StorageStack,
    ) -> Result<Result<(), MoveRefusal>, String> {
        inventory_has_room(tx, self.account_id, stack).map(|room| {
            if room {
                Ok(())
            } else {
                Err(MoveRefusal::DestinationFull)
            }
        })
    }

    fn put(&self, tx: &Transaction<'_>, stack: &StorageStack) -> Result<(), String> {
        // 与重构前逐字一致：`add_inventory_tx` 的内层业务错误同样是硬错误
        // （原始调用方对它也用了 `?`），只有 `can_accept` 的拒绝才记业务码。
        add_inventory_tx(
            tx,
            self.account_id,
            &stack.item_id,
            stack.quantity,
            stack.stats.as_ref(),
            stack.remaining_slots,
            stack.upgrade_count,
        )
        .and_then(|result| result.map(|_| ()).map_err(|code| code.to_owned()))
    }
}

/// 仓库目标。与背包目标共用同一份契约。
struct StorageDestination<'a> {
    account_id: &'a str,
}

impl Destination for StorageDestination<'_> {
    fn can_accept(
        &self,
        tx: &Transaction<'_>,
        stack: &StorageStack,
    ) -> Result<Result<(), MoveRefusal>, String> {
        reserve_storage_slot(tx, self.account_id, &stack.item_id, stack.quantity)
    }

    fn put(&self, tx: &Transaction<'_>, stack: &StorageStack) -> Result<(), String> {
        insert_storage_stack(tx, self.account_id, stack)
    }
}

fn source_at(location: ItemLocation<'_>) -> Box<dyn Source + '_> {
    match location {
        ItemLocation::Inventory {
            account_id,
            kind,
            slot,
        } => Box::new(InventorySource {
            account_id,
            kind,
            slot,
        }),
        ItemLocation::Storage { account_id, slot } => Box::new(StorageSource { account_id, slot }),
    }
}

fn destination_at(side: ContainerSide<'_>) -> Box<dyn Destination + '_> {
    match side {
        ContainerSide::Inventory { account_id } => Box::new(InventoryDestination { account_id }),
        ContainerSide::Storage { account_id } => Box::new(StorageDestination { account_id }),
    }
}

/// 一次搬运的结果。`Refused` 是业务拒绝（会被调用方按自己的词汇翻译成玩家
/// 可见的码并记进幂等回执），而 `move_stack` 返回 `Err` 才是持久化失败。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum MoveOutcome {
    Moved {
        item_id: String,
        quantity: u32,
    },
    Refused {
        reason: MoveRefusal,
        item_id: String,
    },
}

impl MoveOutcome {
    /// 被拒绝的原因；搬运成功返回 `None`。
    pub(super) fn refusal(&self) -> Option<MoveRefusal> {
        match self {
            MoveOutcome::Moved { .. } => None,
            MoveOutcome::Refused { reason, .. } => Some(*reason),
        }
    }

    pub(super) fn item_id(&self) -> String {
        match self {
            MoveOutcome::Moved { item_id, .. } | MoveOutcome::Refused { item_id, .. } => {
                item_id.clone()
            }
        }
    }

    pub(super) fn moved_quantity(&self) -> u32 {
        match self {
            MoveOutcome::Moved { quantity, .. } => *quantity,
            MoveOutcome::Refused { .. } => 0,
        }
    }
}

/// 把 `quantity` 个物品从 `from` 搬到 `to`，全部在一个**已经开启**的事务里完成。
///
/// 这是世界模型 §6 / §9 要求的完整业务动作：先探测来源、再预判目标能否收下、
/// 然后取出、最后放入。任何一步失败都返回 `Err`，由持有事务的调用方回滚，
/// 因此不存在"take 成功 / put 失败"的悬空状态（§32）。
///
/// 判定顺序刻意与重构前逐字一致：只有 `peek` 与 `can_accept` 的拒绝会被记成
/// 业务码，`take` / `put` 的失败是硬错误。
pub(super) fn move_stack(
    tx: &Transaction<'_>,
    from: ItemLocation<'_>,
    to: ContainerSide<'_>,
    quantity: u32,
) -> Result<MoveOutcome, String> {
    let source = source_at(from);
    let target = destination_at(to);
    let stack = match source.peek(tx, quantity)? {
        Ok(stack) => stack,
        Err(reason) => {
            return Ok(MoveOutcome::Refused {
                reason,
                item_id: String::new(),
            });
        }
    };
    if let Err(reason) = target.can_accept(tx, &stack)? {
        return Ok(MoveOutcome::Refused {
            reason,
            item_id: stack.item_id,
        });
    }
    source.take(tx, quantity)?;
    target.put(tx, &stack)?;
    Ok(MoveOutcome::Moved {
        item_id: stack.item_id,
        quantity: stack.quantity,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ACCOUNT: &str = "banker";
    /// TMS273 目录里的可堆叠 Etc 材料（嫩寶殼），按叠放进背包 / 仓库。
    const STACK_ITEM: &str = "4000019";
    /// 另一件真实 Etc 材料（菇菇寶貝傘）。用来测"目标页签塞不下"：它在背包里
    /// 没有任何同叠可合并，因此必须占一个空格。
    const MOVER_ITEM: &str = "4000001";
    /// 只是用来占格的第三件真实 Etc 材料，永远不参与断言。
    const FILLER_ITEM: &str = "4000003";

    fn bag_kind() -> u8 {
        inventory::inventory_type(STACK_ITEM).expect("catalog knows the tab")
    }

    /// 一个最小但真实的库：schema 是启动时那一份，行是真行。
    /// 契约测试的价值就来自"跑真 SQL"，所以这里不造假仓储。
    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        Store::init(&conn).expect("schema");
        conn.execute(
            "INSERT INTO player_stats(account_id,hp,max_hp,mp,max_mp,level,exp,exp_to_next)
             VALUES (?1,100,100,100,100,10,0,100)",
            params![ACCOUNT],
        )
        .expect("stats row");
        conn.execute(
            "INSERT INTO inventory(account_id,inventory_type,slot,item_id,quantity)
             VALUES (?1,?2,1,?3,10)",
            params![ACCOUNT, bag_kind(), STACK_ITEM],
        )
        .expect("seed bag");
        conn.execute(
            "INSERT INTO storage(account_id,slot,item_id,quantity) VALUES (?1,3,?2,7)",
            params![ACCOUNT, STACK_ITEM],
        )
        .expect("seed warehouse");
        conn.execute(
            "INSERT INTO storage(account_id,slot,item_id,quantity) VALUES (?1,4,?2,5)",
            params![ACCOUNT, MOVER_ITEM],
        )
        .expect("seed warehouse mover");
        conn
    }

    fn bag_at(conn: &Connection, slot: i16) -> i64 {
        conn.query_row(
            "SELECT COALESCE(SUM(quantity),0) FROM inventory
             WHERE account_id=?1 AND inventory_type=?2 AND slot=?3",
            params![ACCOUNT, bag_kind(), slot],
            |row| row.get(0),
        )
        .expect("bag slot read")
    }

    fn bag_total(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT COALESCE(SUM(quantity),0) FROM inventory
             WHERE account_id=?1 AND item_id=?2",
            params![ACCOUNT, STACK_ITEM],
            |row| row.get(0),
        )
        .expect("bag read")
    }

    fn warehouse_total(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT COALESCE(SUM(quantity),0) FROM storage
             WHERE account_id=?1 AND item_id=?2",
            params![ACCOUNT, STACK_ITEM],
            |row| row.get(0),
        )
        .expect("warehouse read")
    }

    fn stack_of(item_id: &str, quantity: u32) -> StorageStack {
        StorageStack {
            item_id: item_id.to_owned(),
            quantity,
            stats: None,
            upgrade_count: None,
            remaining_slots: None,
        }
    }

    /// 世界模型 §41 的契约测试手段：让**两个实现**跑同一段断言序列。
    /// `Source` 的契约是"take 成功后物品确实从该容器移除"。
    fn assert_source_contract(
        conn: &mut Connection,
        source: &dyn Source,
        quantity: u32,
        before: i64,
        held: impl Fn(&Connection) -> i64,
    ) {
        let tx = conn.transaction().expect("tx");
        let stack = source
            .peek(&tx, quantity)
            .expect("peek runs")
            .expect("stack readable");
        assert_eq!(stack.quantity, quantity, "peek 报告的是被请求的数量");
        source.take(&tx, quantity).expect("take");
        tx.commit().expect("commit");
        assert_eq!(
            held(conn),
            before - i64::from(quantity),
            "take 成功后物品确实从该容器移除"
        );
    }

    /// `Destination` 的契约是"put 成功后物品确实存在于该容器"。
    fn assert_destination_contract(
        conn: &mut Connection,
        target: &dyn Destination,
        stack: &StorageStack,
        before: i64,
        held: impl Fn(&Connection) -> i64,
    ) {
        let tx = conn.transaction().expect("tx");
        assert!(
            target
                .can_accept(&tx, stack)
                .expect("can_accept runs")
                .is_ok(),
            "目标容器应当收得下"
        );
        target.put(&tx, stack).expect("put");
        tx.commit().expect("commit");
        assert_eq!(
            held(conn),
            before + i64::from(stack.quantity),
            "put 成功后物品确实存在于该容器"
        );
    }

    // i01 — 背包与仓库是**同一个**抽象的两种实现：同一段契约序列在两边都成立。
    #[test]
    fn both_containers_honour_the_same_contract() {
        let mut conn = test_db();
        let bag_before = bag_at(&conn, 1);
        assert_source_contract(
            &mut conn,
            &InventorySource {
                account_id: ACCOUNT,
                kind: bag_kind(),
                slot: 1,
            },
            4,
            bag_before,
            |conn| bag_at(conn, 1),
        );

        let mut conn = test_db();
        let warehouse_before = warehouse_total(&conn);
        assert_source_contract(
            &mut conn,
            &StorageSource {
                account_id: ACCOUNT,
                slot: 3,
            },
            3,
            warehouse_before,
            warehouse_total,
        );

        let mut conn = test_db();
        let warehouse_before = warehouse_total(&conn);
        assert_destination_contract(
            &mut conn,
            &StorageDestination {
                account_id: ACCOUNT,
            },
            &stack_of(STACK_ITEM, 4),
            warehouse_before,
            warehouse_total,
        );

        let mut conn = test_db();
        let bag_before = bag_total(&conn);
        assert_destination_contract(
            &mut conn,
            &InventoryDestination {
                account_id: ACCOUNT,
            },
            &stack_of(STACK_ITEM, 4),
            bag_before,
            bag_total,
        );
    }

    // i02 — 世界模型 §13：背包 → 仓库是 Move，Owner 不变、Location 改变，
    // 总量守恒；反方向是同一件事的逆运算。
    #[test]
    fn a_warehouse_move_conserves_the_stack_and_is_reversible() {
        let mut conn = test_db();
        {
            let tx = conn.transaction().expect("tx");
            let moved = move_stack(
                &tx,
                ItemLocation::Inventory {
                    account_id: ACCOUNT,
                    kind: bag_kind(),
                    slot: 1,
                },
                ContainerSide::Storage {
                    account_id: ACCOUNT,
                },
                4,
            )
            .expect("deposit runs");
            assert_eq!(
                moved,
                MoveOutcome::Moved {
                    item_id: STACK_ITEM.to_owned(),
                    quantity: 4
                }
            );
            tx.commit().expect("commit");
        }
        assert_eq!(bag_total(&conn), 6);
        assert_eq!(warehouse_total(&conn), 11);

        // 同叠在仓库侧被合并进已有那一格（不是新开一格）——这正是
        // `insert_storage_stack` 的行为，也是"落点由容器决定"的例证。
        let stored_slot: i16 = conn
            .query_row(
                "SELECT slot FROM storage WHERE account_id=?1 AND item_id=?2 AND quantity>0
                 ORDER BY slot LIMIT 1",
                params![ACCOUNT, STACK_ITEM],
                |row| row.get(0),
            )
            .expect("merged row");
        {
            let tx = conn.transaction().expect("tx");
            let moved = move_stack(
                &tx,
                ItemLocation::Storage {
                    account_id: ACCOUNT,
                    slot: stored_slot,
                },
                ContainerSide::Inventory {
                    account_id: ACCOUNT,
                },
                4,
            )
            .expect("withdraw runs");
            assert_eq!(moved.moved_quantity(), 4);
            tx.commit().expect("commit");
        }
        assert_eq!(bag_total(&conn), 10);
        assert_eq!(warehouse_total(&conn), 7);
    }

    // i03 — 世界模型 §32：被拒绝的搬运是**全或全无**，两侧一格都不动。
    // 断言同时钉住两层：领域原语给"原因"，业务动作把它翻译成码。
    #[test]
    fn a_refused_move_leaves_both_sides_untouched() {
        let mut conn = test_db();

        // 来源那一格是空的：拒绝原因来自 peek，且 item_id 保持为空串
        // （与重构前逐字一致，业务层据此不出道具名）。
        let tx = conn.transaction().expect("tx");
        let refused = move_stack(
            &tx,
            ItemLocation::Inventory {
                account_id: ACCOUNT,
                kind: bag_kind(),
                slot: 9,
            },
            ContainerSide::Storage {
                account_id: ACCOUNT,
            },
            1,
        )
        .expect("refusal is not a persistence failure");
        assert_eq!(refused.refusal(), Some(MoveRefusal::SourceEmpty));
        assert_eq!(refused.item_id(), "");
        assert_eq!(
            StorageOperation::Deposit.refusal_code(MoveRefusal::SourceEmpty),
            "source_empty"
        );
        assert_eq!(
            StorageOperation::Withdraw.refusal_code(MoveRefusal::SourceEmpty),
            "storage_slot_empty",
            "同一个原因在两个方向上说法不同——这正是码属于业务动作的理由"
        );
        drop(tx);
        assert_eq!(bag_total(&conn), 10);
        assert_eq!(warehouse_total(&conn), 7);

        // 数量超过这一叠：同样是 peek 拒绝，仍然不动任何一侧。
        let tx = conn.transaction().expect("tx");
        let refused = move_stack(
            &tx,
            ItemLocation::Inventory {
                account_id: ACCOUNT,
                kind: bag_kind(),
                slot: 1,
            },
            ContainerSide::Storage {
                account_id: ACCOUNT,
            },
            11,
        )
        .expect("refusal is not a persistence failure");
        assert_eq!(refused.refusal(), Some(MoveRefusal::InvalidQuantity));
        assert_eq!(refused.item_id(), "");
        drop(tx);
        assert_eq!(bag_total(&conn), 10);
        assert_eq!(warehouse_total(&conn), 7);

        // 目标侧收不下：拒绝发生在 can_accept，`item_id` 必须回填成被搬运的
        // 那一叠（业务层靠它告诉玩家是哪件东西塞不下），而且来源一格不少。
        let used: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM inventory WHERE account_id=?1 AND inventory_type=?2",
                params![ACCOUNT, bag_kind()],
                |row| row.get(0),
            )
            .expect("row count");
        for slot in (used + 1)..=i64::from(inventory::SLOT_LIMIT) {
            conn.execute(
                "INSERT INTO inventory(account_id,inventory_type,slot,item_id,quantity)
                 VALUES (?1,?2,?3,?4,1)",
                params![ACCOUNT, bag_kind(), slot, FILLER_ITEM],
            )
            .expect("filler row");
        }
        assert_eq!(bag_at(&conn, 1), 10, "填满的是别的格子，来源那一格没被碰过");

        let tx = conn.transaction().expect("tx");
        let refused = move_stack(
            &tx,
            ItemLocation::Storage {
                account_id: ACCOUNT,
                slot: 4,
            },
            ContainerSide::Inventory {
                account_id: ACCOUNT,
            },
            1,
        )
        .expect("refusal is not a persistence failure");
        assert_eq!(refused.refusal(), Some(MoveRefusal::DestinationFull));
        assert_eq!(refused.item_id(), MOVER_ITEM);
        assert_eq!(refused.moved_quantity(), 0);
        assert_eq!(
            StorageOperation::Withdraw.refusal_code(MoveRefusal::DestinationFull),
            "inventory_full"
        );
        assert_eq!(
            StorageOperation::Deposit.refusal_code(MoveRefusal::DestinationFull),
            "storage_full"
        );
        drop(tx);
        assert_eq!(
            conn.query_row(
                "SELECT quantity FROM storage WHERE account_id=?1 AND slot=4",
                params![ACCOUNT],
                |row| row.get::<_, i64>(0),
            )
            .expect("mover row survives"),
            5
        );
    }

    // i04 — 世界模型 §3.3：掉落保护窗的真值表。这是重构前 `pickup` 里那行
    // 内联比较的唯一翻译点，四个象限都必须对得上。
    #[test]
    fn pickup_policy_is_the_protection_window_over_the_owner() {
        const MINE: &str = "mine";
        const OTHER: &str = "other";
        const NOW: i64 = 1_000;

        // 窗口内：只有保护对象能拿。
        let (owner, state) = drop_fact(Some(MINE), NOW + 500);
        assert!(pickup_allowed(&owner, &state, MINE, NOW));
        assert!(!pickup_allowed(&owner, &state, OTHER, NOW));

        // 窗口过期：对所有人开放。
        let (owner, state) = drop_fact(Some(MINE), NOW);
        assert!(pickup_allowed(&owner, &state, MINE, NOW));
        assert!(pickup_allowed(&owner, &state, OTHER, NOW));

        // 源里没有保护窗（0 或负数）：对所有人开放。
        let (owner, state) = drop_fact(Some(MINE), 0);
        assert_eq!(state, ItemState::Normal);
        assert!(pickup_allowed(&owner, &state, OTHER, NOW));

        // 无人认领（System）：任何窗口都不排斥别人。
        let (owner, state) = drop_fact(None, NOW + 500);
        assert_eq!(owner, Owner::System);
        assert!(pickup_allowed(&owner, &state, OTHER, NOW));
    }
}
