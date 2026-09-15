# 物品获得写点审计（NB-05 必交清单）

> 依据：`MapleStory_冒险笔记图鉴_怪物收集复刻与扩展计划_f62ef983.md` §10.3「实施时的调用点审计」。
> 要求：对下列符号与直接 SQL 写点做定向检索并**逐个归类**，结论只能是
> **「已核查并接入」／「不属于获得」／「尚缺实现」**，不能只列函数名。
> 审计日期：2026-09-15。范围：`server/src/**`（生产代码；`#[cfg(test)]` 与 `*_acceptance.rs` 单列）。

## 0. 结论速览

| 类别 | 处数 | 结论 |
|---|---|---|
| 实际正向授予 | **11** | 全部「已核查并接入」 |
| 同主体移动 | 7 | 不属于获得 |
| 消耗／移除 | 9 | 不属于获得 |
| 规范化／加载 | 4 类 | 不属于获得 |
| 测试夹具 | 若干 | 不参与生产 |
| **尚缺实现** | **0** | 本次审计补上了唯一缺口（见 §1.11） |

**本次审计发现并修复的缺口**：`lobby.rs::seed_character_equipment` 把创角时选定的外观装备
（外套／鞋／武器／裤子）写进 `equipped`，但**没有留档**。NB-03 的补记只能从「当前还穿着」
反推，换装后这件事实就永久丢失。已改为与角色行、`equipped` 行同一事务调用 `granted_tx`
（来源 `starter`），并在 `world_tests.rs::join_snapshot_includes_persisted_character_appearance`
里加了正向断言。

**统一入口**：所有授予都收敛到 `auth/notebook.rs::granted_tx`（内部
`record_item_acquisitions_tx`，`notebook.rs:514/587`）。本审计不认「直接调
`record_item_acquisitions_tx` 自开事务」的写法——生产上不存在这样的调用点，
唯一例外 `Store::record_notebook_acquisitions`（`notebook.rs:891`）是验收测试专用。

---

## 1. 实际正向授予（已核查并接入）

11 个生产调用点，全部满足三条：**与资产同一事务**、**只在业务确认成功后才构造 grants**、
**数量是本次真正发出去的正数**。

### 1.1 地面拾取（含宠物拾取、`consumeOnPickup`）

- 写点：`auth/loot.rs:547` `add_inventory_tx`（落进背包那一支）；`auth/loot.rs:536`
  `INSERT INTO monster_book_cards`（自动消耗的旧卡片那一支）。
- 留档：`auth/loot.rs:600` `granted_tx`，来源 `pickup`，`source_ref = request_id`。
- 事务：与「掉落认领（`UPDATE drops SET active=0`）＋入包」同一事务。业务拒绝（页签满／
  卡片饱和）会把掉落恢复成可拾取并整笔回滚 ⇒ 不留假事实。
- 分类决定去留：旧 MonsterBook 卡片不在出厂物品索引 ⇒ `NotAnItem` 静默跳过，且**不**变成
  现代收藏登记（§8.4）。金币走 `item_id == "0"` 分支，不进物品图鉴（§2.4.6）。
- 宠物拾取复用同一条事务，与本人拾取同款留档。

### 1.2 任务起始物品

- 写点：`quest.rs:1330` `add_items`（在克隆状态上）。
- 留档：`quest.rs:1345` 收集 → `auth/quests.rs:220` `granted_tx`，来源 `questReward`，
  `source_ref = quest_id`。
- 数量：只记**本次真正补发的 `missing`**（已持有／已穿在身上的部分不重复记，否则重连或
  重放会把同一件记成两次获得）。

### 1.3 任务完成奖励

- 写点：`quest.rs:1431`。
- 留档：`quest.rs:1450` → 同上（同一笔 `commit_quest` 提交）。
- 事务：与任务状态转场、金币、经验同一事务。

### 1.4 任务交互补发

- 写点：`auth/quests.rs:279` `add_items`（以**持久**背包事实为基准）。
- 留档：`auth/quests.rs:296` `granted_tx`，来源 `questInteraction`，数量 `= missing`。
- 幂等键是「持有」而非请求号：已持有则 `Ok(false)` 并 `rollback`，不推进 revision。

### 1.5 普通商店购买

- 写点：`trade.rs:153` `add_items`（克隆）→ `auth/shop.rs:140` `write_inventory_tx`。
- 留档：`trade.rs:183` 构造 `grants` → `auth/shop.rs:142` `granted_tx`，来源 `shopBuy`。
- 事务：扣金币（`write_profile`）＋授予行＋留档同一事务；`commit` 成功后才改内存与回执。

### 1.6 商店买回

- 写点：`trade.rs:671`（克隆）→ `auth/shop.rs:225` `write_inventory_tx`。
- 留档：`auth/shop.rs:227` `granted_tx`，来源 `shopRebuy`。
- **数量取自被消费掉的那一行**（事务内 `SELECT quantity FROM shop_rebuy` 后再 `DELETE`），
  不由调用方另传 ⇒ 不存在两处事实不一致。行不存在 `Ok(false)`，事务随 drop 回滚。

### 1.7 現金商店购买

- 写点：`cashshop.rs:195` `add_items_expiring`（克隆，含堆叠与租赁期限戳）→
  `auth/cash.rs:233` `write_inventory_tx`。
- 留档：`auth/cash.rs:268` `granted_tx`，来源 `cashPurchase`。
- 事务：余额＋背包＋限购＋回执＋留档同一事务；重放走持久回执（早于留档返回），
  所以不会写第二条事实、不刷 revision。

### 1.8 创角初始装备（固定套装）

- 写点：`auth/db.rs:1435` `add_items`＋`db.rs:1441` `INSERT INTO equipped`。
- 留档：`auth/db.rs:1466` `granted_tx`，来源 `starter`。
- 事务：与 `player_stats` 行同一事务（`load_profile` 内）。幂等靠
  `player_stats.starter_equipment_seeded`。

### 1.9 创角初始背包券

- 写点：`auth.rs:772` `add_items`。
- 留档：`auth.rs:805` `granted_tx`，来源 `starter`。
- 事务：与背包行同一事务；幂等靠 `starter_backpack_seeded`；背包非空时只打标记、不发。

### 1.10 GM `/add`

- 写点：`auth/bag.rs:303` `add_inventory_tx`。
- 留档：`auth/bag.rs:307` `granted_tx`，来源 `gm`。
- 事务：与背包落位同一事务；请求号单次有效（换参数重放返回 `request_reused`，不会
  被误当第二次授予）。GM 授予会留档但**不会**让物品变成「正常可获得」（§5.5）。

### 1.11 创角外观装备（**本次补接**）

- 写点：`lobby.rs::seed_character_equipment`（`INSERT INTO equipped`，槽位 -5 外套 /
  -6 裤子 / -7 鞋 / -11 武器）。
- 留档：同函数末尾 `granted_tx`，来源 `starter`，`source_ref = None`，数量恒为 1。
- 事务：与 `characters` 行、`equipped` 行同一事务 ⇒ 创角成功必有事实，创角回滚一条不留。
- `pants == 0` 表示该槽为空，不产生事实（与原 INSERT 的守卫一致）。
- **为什么接在这里是安全的**：`granted_tx` 只在「出厂物品索引有、图鉴目录没有」时报错。
  逐 id 核对（`shared/character-creation.json` 全部可选外观 id ∪ `Appearance::default()`
  ∪ 测试用 `creation_default()`）：

  | id | 图鉴目录 | 出厂索引 | 分类结论 |
  |---|---|---|---|
  | 1040002 / 1050286 / 1050287 / 1050288 / 1051353 / 1051354 / 1051355 / 1072833 / 1072834 / 1302000 / 1312004 / 1322005 | 有 | 有 | `Recorded` ⇒ 留档 |
  | 1060003 / 1070000 | 无 | 无 | `NotAnItem` ⇒ 静默跳过 |
  | **目录缺陷（会 Err）** | — | — | **无** |

  1060003／1070000 只出现在 `Appearance::default()`，而 `Appearance` 的字段没有
  serde 默认值（全部必填）且必须通过 `validate()`（只接受目录内 id），所以生产不可达；
  即便出现也只是跳过，不会让创角失败。

---

## 2. 同主体移动（不属于获得）

物品已属于该角色，只是换了存放位置 ⇒ **不接 hook**。计划 §10.3 已把「仓库转移」列在此类。

| 写点 | 说明 |
|---|---|
| `auth/item_world.rs:226` `add_inventory_tx`（`InventoryDestination::put`） | 搬运原语的目标侧落位，被仓库取出复用 |
| `trade.rs:1014` → `auth.rs:1266` `storage_transfer` → `item_world::move_stack` | 仓库存入／取出；`db.rs:346 INSERT INTO storage` / `db.rs:214 DELETE FROM storage` 同属这一对 |
| `auth/bag.rs:437` `move_inventory` | 背包内换格 |
| `auth/bag.rs:506` `compact_inventory`（整理／排序） | 位置重排 |
| `auth/bag.rs:744` `write_equipped_tx` | 用道具后自动装备 |
| `auth/bag.rs:55` `toggle_pet` / `auth/bag.rs:229` `retire_pet` | 宠物状态，非新获得 |
| `auth/db.rs:1167` `write_equipped_tx` / `db.rs:1280 UPDATE equipped` / `db.rs:1554` | 装备整表／单行写回原语 |

**反面证据（已论证，不再重推）**：地面掉落（增量 3）与装备栏（增量 2）不纳入容器契约——
`storage_transfer` 把同一业务码当**硬错误**，`pickup` 把它当**业务拒绝并恢复掉落**，
语义相反。因此「移动」不产生获得事实是设计结论，不是遗漏。

---

## 3. 消耗／移除（不属于获得）

| 写点 | 说明 |
|---|---|
| `auth/shop.rs:152` `shop_sell_commit`（`shop.rs:168` `write_inventory_tx`） | 出售＝移除。**反向断言**在 `shop_commit_acceptance.rs`：出售后 `notebook_item_records` 为空、revision 不变（若被误当授予会失败） |
| `auth/bag.rs:826` `drop_inventory`（`bag.rs:870`） | 丢弃 |
| `auth/bag.rs:529/557` `use_item` / `use_item_with_max_mp`（`bag.rs:742`） | 使用消耗品 |
| `cashshop.rs:363` `step_rental_expiries`（`cashshop.rs:395` `write_inventory`） | 租赁到期回收 |
| `quest.rs:1353` 起 `consume_items` | 任务完成时扣除任务物品（同事务） |
| `auth/db.rs:181/187` 扣减、`db.rs:807` 删行、`db.rs:896/947` 强化与卷轴改写 | 数量与实例属性变化 |
| `auth/bag.rs:161` `feed_pet` | 喂食消耗 |
| `loot.rs:536` `INSERT INTO monster_book_cards` | 卡片被消耗进旧系统（分类为「不是常规物品」） |
| `auth/db.rs:1097-1102` `write_inventory_tx` 的 `DELETE FROM inventory` | 整表写回的删除阶段 |

> 说明：`is_drop_restricted` 是**销毁**不是 Move，同样不产生获得事实。

---

## 4. 规范化／加载（不属于获得）

| 写点 | 结论 |
|---|---|
| `auth.rs:835` `save_profile` | **只写 `player_stats`**（hp/mp/level/job/exp/mesos/cash/death_id/map_id/x/y/skills/skill_points/ability），**完全不写 `inventory`／`equipped`** ⇒ 它约 30 处调用点（`commands.rs:114/124`、`monsters.rs:805`、`portals.rs:323`、`skills.rs:1069/1145`、`boss.rs:448`、`dialogue.rs:394`、`windbell.rs:1154/1402`、`elemental.rs:76`、`world.rs:3393`、`gm.rs:93`、`lobby.rs:1024/1105`…）**都不是获得写点**。位置／血量／经验的落库不会伪造获得事实。 |
| `auth/db.rs:1097` `write_inventory_tx`、`auth.rs:1117` `write_inventory` | 持久化原语，不判定获得。生产调用点只有 §1／§2／§3 三类；`write_inventory` 在生产上**只有 1 处**（`cashshop.rs:395`，移除） |
| `read_profile` / `load_profile` 解码、`ensure_equipment_instance` / `ensure_pet_instance` 补字段（`db.rs:1118-1120`） | 规范化，不产生事实 |
| 直接 SQL：`lobby.rs:675`、`auth/db.rs:346`、`db.rs:1124/1167`、`auth.rs:776`、`db.rs:1441` | 已分别归入 §1.8／§1.9／§1.11／§2 |

---

## 5. 测试夹具（不参与生产）

- `#[cfg(test)]` 内的 `INSERT INTO inventory/equipped/storage`：`auth/item_world.rs:368/619`、
  `auth.rs:2961/3016/3021/3361/3366/3371/3536/3607/3649`、`lobby.rs:1266`、
  `notebook_store_acceptance.rs:97/398/404/409`、`inventory_acceptance.rs:43`、`scroll_acceptance.rs:619`。
- acceptance 文件里的播种：`write_inventory`（`storage_acceptance.rs:166/183/553`、
  `cashshop_acceptance.rs:353`、`quest_store_acceptance.rs:118`）、`save_profile`（各 `*_acceptance.rs`）。
- `auth.rs:3749/3770/3974`、`auth.rs:3288/3750` 的 `write_inventory_tx`／`write_equipped_tx`
  在测试模块内。

---

## 6. 尚缺实现

**无。** 本次审计把唯一缺口（§1.11 创角外观装备）接上了。

后续条目接入时的新增发放点（不在本次范围，但届时必须走 `granted_tx`）：

- **NB-06** 怪物登记链路：登记本身是**收藏**事实，不是物品获得；但若奖励含物品，发放必须留档。
- **NB-07** 「首次发现」提示：读 `NotebookChangeSet::first_obtained`，**不新增写点**。
- **NB-08** 原版行页奖励、勋章、收藏道具、探险：物品发放必须与「资格认领＋领奖状态」同一事务
  调用 `granted_tx`（计划 §11.1）；勋章若对应装备，只在真实发放时记入。

---

## 7. 本次审计执行过的验证

- `cargo test --manifest-path server/Cargo.toml`：**457 过／0 失败**（含新增的创角留档断言）。
- 非测试构建 0 告警。
- `node scripts/check_tms273_notebook.cjs`：通过。
- 逐 id 分类核对：`shared/character-creation.json` ∪ `Appearance::default()` ∪ `creation_default()`
  与 `shared/notebook-catalog.json`（2584）／`shared/items.json`（3586）交叉验证，结论见 §1.11。
