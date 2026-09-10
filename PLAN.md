# 当前工作计划

## 账号仓库（Storage / 倉庫）：已完成，待统一加载实玩（2026-09-10）

- 选题：静态盘点确认 **`storage` 在服务端/客户端全仓库 0 处匹配**——`shared/gameplay.json` 里 3 个 `func: "倉庫老闆"`
  的 NPC（1002005 倉庫老闆金先生 / 1022005 倉庫王老闆 / 1032006 倉庫管理員朴先生）分别放在 104000000、102000000、
  101000000 三张**已装配**的地图上，`func` 字段被解析却从未被任何代码消费。这是"背包→装备→战斗→掉落→买卖"
  闭环里唯一没有出口的一端：装备/道具只能堆在 24 格背包里，既存不下也拿不出。
- 来源 T：NPC func 来自本地 TMS273 String/Npc + Npc 数据；窗口素材来自 TMS273.7 客户端
  `UI/UIWindow.img/Trunk`（backgrnd / select / 8 个按钮 × 4 态 / Tab × 2 态 × 5 帧），非自绘、非 v83。
- 实装五层：
  ① 新增 `scripts/export_tms273_storage.cjs`（44 张 PNG + `storage.json`），管线加入导出步并挂
     `manifest.storageUi`；`assemble_tms273.cjs` 同步 `storageUi: read('storage')`。
  ② `auth.rs` 新增 `storage` / `storage_actions` / `storage_mesos` / `storage_mesos_actions` 四张表与
     `load_storage` / `storage_transfer` / `storage_mesos` / `storage_mesos_balance`。
  ③ `world.rs` 新增 `handle_storage_open` / `handle_storage_transfer` / `handle_storage_mesos` 与
     `send_storage_state`，`close_storage` 挂在既有 `end_conversation` 上（离图/死亡/断线同一路径收口）。
  ④ 协议 12（未升版，同版扩展）：新增 `StorageOpen` / `StorageTransfer` / `StorageMesos` 三个意图与
     `storageResult` / `storageMesos` / `storageState` 三个下行，Rust 与 `shared/protocol.ts` 同步；
     `npcResult` 加 `openStorage` 标记（复用既有 `openSkills` 模式）。
  ⑤ 客户端新增 `features/world/storage-view.ts` + `style.css` 面板 + `i18n.ts` 6 条错误码，
     `main.ts` 接消息/模态/切图清理，`scenes/world.ts` 预载 44 张 Trunk 素材。
- 权威边界：客户端只发"方向 + 分类 + 格子"（`storageTransfer`）或"方向 + 枫币数"（`storageMesos`）；
  **物品身份、可存性、真实数量、仓库容量与两侧余额全部服务端推导**，不接受 itemId/价格/余额。
  开窗必须站在**被作者标为倉庫的 NPC**旁且在同图 TALK_RANGE 内，且每次搬运都**重新校验距离**——
  中途走开即拒绝并关闭会话（`storage_too_far`）。
- 账号级共享：仓库按 `account_id` 存储（非角色），同一账号新建角色可见既有存款，不同账号互不可见（s14 断言）。
- 幂等（本轮真实缺陷）：存取与枫币搬运都按 requestId 落 `storage_actions` / `storage_mesos_actions`，
  重放同 ID 重发原结果、不二次搬运；**已用"临时移除幂等判定 → 该测试即失败"反向验证**。
  另一处真实缺陷：`player_stats` 是 NOT NULL 全字段表，取出枫币时用 INSERT 会失败（首轮 4 项红），
  改为对既有 profile 行 UPDATE 并校验影响行数后修复。
- 拒绝码：`storage_unknown / storage_not_keeper / storage_too_far / storage_closed / source_empty /
  storage_slot_empty / storage_full / invalid_quantity / invalid_slot / mesos_insufficient / dead / persistence`；
  失败一律 `quantity=0`（客户端不可能把部分/被拒搬运误当成功）。
- P 临时规则（已注明单点）：`STORAGE_SLOT_LIMIT = 24`——原版仓库容量按扩充道具成长、TMS273 无本地字段，
  按"与背包同宽"作 P；`check_tms273_runtime.cjs` 从 `auth.rs` 读该常量并断言与 manifest 一致，防止两端漂移。
- 验证：
  - `cargo build` 通过，警告仍是**基线 6 条零新增**。
  - 新增 `storage_acceptance.rs` **14 项全过**（存款/取款/非管理员与伪造 NPC/离开管理员即拒/无会话即拒/
    超量/空槽/row 上限溢出/重放不双存/枫币存取/枫币不足/枫币重放不双搬/装备实例属性往返/账号共享与隔离）。
  - **反向验证两项**：移除"搬运时重校距离"→ s04 失败；移除"重放读回原结果"→ s09 失败。证明用例有效。
  - 全量 `cargo test` **196 过 / 10 失败**；`git stash` 后的真基线为 **182 过 / 10 失败且失败集逐条一致**
    （auth/inventory/mage/world 既有问题），即 **+14 项新通过、零回归**。
  - `tsc --noEmit` 通过；`vite build` 通过（→/tmp/dist-storage-check，仅既有 chunk 体积警告）；
    `check_tms273_runtime` 通过（41 图 / **45035** 引用，较上轮 +44，即 44 张 Trunk 素材全部落盘并被断言）。
  - 客户端新增 `storage.check.mjs` **7 项全过**（开窗不发意图 / 内容只随权威快照 / 全存按堆发意图且分类由物品推导 /
    取出按仓库物品推导分类 / 枫币意图与 0 值本地拦截 / 空仓库占位 / 关闭清理选择）。
- 待验（用户）：经 `启动3010.command` 统一构建加载后实玩——找倉庫老闆（如弓箭手村 104000000）按 ↑ 对话应弹仓库窗，
  双击背包道具应存入且仓库出现该道具、背包数量减少；双击仓库道具可取回；存入/取出枫币两侧余额同步变化；
  走远后操作应提示"距离太远"且窗口关闭；切图/死亡后窗口关闭；重新登录仓库内容仍在。
- 已知边界：仓库**容量扩充道具**（原版用道具加行）未做，固定 24 行；**仓库排序/搜索**未做（BtSort 目前转发背包整理）；
  「全部取出」未做（BtGetAll 映射为全部存入）；超出 24 行时的多行拆分已实现但仅装备与堆叠道具覆盖到。

## 消耗品恢复闭环（药水可用化 + 百分比恢复 + 药水冷却）：已完成，待统一加载实玩（2026-09-10）

- 选题：静态盘点发现 **全部 41 个消耗品的 `spec` 为空**——`inventory::use_effect` 读 `spec.hp/mp` 一无所获，
  对**每一瓶药水**都返回 `ItemNotUsable`。紅色藥水／白色藥水／蘋果等所有恢复道具在游戏中完全无法使用。
  这是"装备→战斗→掉落→拾取→补给"闭环里唯一整层断掉的环节：怪能打、药水能捡、能卖，就是喝不了。
- 根因：`shared/items.json` 由 **v83** WZ XML 导出，v83 的 Consume `info`/`spec` 节点不带这些字段；
  而 TMS273.7 的 `Item/Consume/<4位>/<8位>.json` 里 `spec.hp/mp/hpR/mpR/time` 全部齐备（紅色藥水 hp=50、超級藥水 hpR/mpR=100）。
- 数据（`scripts/backfill_tms273_item_spec.py`，新增）：
  - T 来源：本地 TMS273.7 `WZ_JSON_TW/Item/Consume`，只回填缺失键、不覆盖既有值（装备表零改动）。
  - 回填 7 个恢复类道具的 `spec`（6 个有 hp/mp）+ 12 项 `slotMax` 纠正（紅色藥水 100→3000、蘋果 100→300）。
  - 三份（shared / public-tms273 / tms273-export）已同步一致。
- 机制（`inventory.rs` / `auth.rs` / `world.rs`）：
  - `use_effect` 返回新增的 `UseEffect` 结构，支持原版两种恢复形式：**固定值**（`hp`/`mp`）与
    **百分比**（`hpR`/`mpR`，按角色自身上限结算）。百分比对 1 级与 200 级同样有意义，也正是原版给这类道具加冷却的原因。
  - 百分比在为**当前角色上限**实时解析（事务内读 `max_hp/max_mp`，法师用派生 MP 上限），不写死进目录；
    向下取整但**至少 1 点**，低等级角色不会喝了个寂寞。
  - 新增药水冷却：仅对源 `spec.time` 有值的道具登记（枯木樹液 300s），普通药水**不设冷却**，
    与原版"普通药水可连喝、超級藥水才上锁"一致。拒绝码 `potion_cooldown`，被拒时**不扣道具、不回血**。
  - 冷却随 `clear_beginner_buffs` 在切图/死亡/重连时清空（与其他临时状态同生命周期），
    并每 tick 由 `expire_potion_cooldowns` 回收过期项，避免长会话无界增长。
- 协议 12（未升版，同版扩展）：`PlayerState` 新增 `potionCooldowns`（itemId→剩余ms），
  Rust 与 `shared/protocol.ts` 同步；仅展示用，客户端不能设定或清除。
- 客户端：背包槽位冷却角标（剩余秒数 + 图标变暗，`style.css` 用既有 flex/绝对定位、无新框架）；
  冷却秒数纳入渲染 signature，否则角标会停在最后一次背包变化时的值；`i18n.ts` 补 `potion_cooldown` 中英文案。
- 验证：新增 `consume_acceptance.rs` **9 项全过**（固定恢复/百分比按上限缩放/不溢出上限/无恢复道具拒绝/
  冷却内拒用且不扣道具/冷却到期恢复可用/无冷却药水可连喝/死亡清空冷却/百分比至少1点）；
  **已用"临时禁用冷却校验 → 该测试即失败"反向验证其有效性**。
  `cargo build` 通过且警告仍是基线 6 条零新增；全量 `cargo test` 182 过 / 10 失败，
  与 stash 后的真基线（172 过 / 11 失败）比对——**反而修好 1 项既有失败**
  （`inventory::potion_effect_and_equip_requirements`，正是药水数据缺失所致），零回归。
  `tsc --noEmit` 通过；`vite build` 通过（→/tmp/dist-consume-check，仅既有 chunk 体积警告）；
  `check_tms273_runtime` 通过（41 图/44991 引用）。
- 待验（用户）：经 `启动3010.command` 统一构建加载后实玩——双击红色/白色药水应回血且数量-1；
  HP 将满时喝药不溢出；带冷却的道具连喝第二次提示"道具冷却中"且不扣数量；切图/死亡后冷却清零。
- 已知边界：只有 TMS273 本地存在的 7 个恢复类道具被回填，其余消耗品（箭矢/陀螺/卷轴等）按原版本就不可饮用；
  **百分比类道具（超級藥水 hpR=100）本地目录无对应条目**，机制已实现但当前无道具可验证，需目录扩充后再实测。

## NPC 商店卖出闭环：已完成，待统一加载实玩（2026-09-10）

- 选题：商店只有买入（`handle_shop_buy`），卖出全仓库 0 处匹配——原版基础经济闭环缺一半，怪物掉落/药水只能堆积无法变现。
- 服务端 `server/src/world.rs`：
  - 新增 `handle_shop_sell`（ShopSell）：客户端只报 shop/tab/slot/数量，物品身份、可售性、卖价全部服务端推导，不接受 itemId 或价格。
  - 校验链：商店存在 → 商人在同图且 `TALK_RANGE` 内 → 槽位有物且 tab 匹配 → 数量足够 → 非 tradeBlock/cash/无价 → 单价计算 → 克隆背包原子移除 → 加枫币 → 持久化。
  - 拒绝码：`shop_unknown/shop_too_far/shop_slot_empty/shop_quantity_invalid/shop_item_unsellable/shop_rejected`，失败一律 `mesosGained=0`。
  - 幂等（本轮测试暴露的真实缺陷）：新增 `shop_sell_requests` 缓存，重放同一 requestId 重发原结果、不二次支付；Exit/Leave 同步清理。
  - 常量 `SHOP_SELL_PRICE_PERCENT=50`：TMS273 无卖价字段、参考端与研究包均缺失，按"商店半价收购"作 P 临时规则，已注明替换为核定值的单点位置。
- 协议 12（未升版，属同版扩展）：新增 `ShopSell` 意图与 `shopSold` 广播（Rust + `shared/protocol.ts` 同步，复用既有的 inventory type/slot 校验）。
- 客户端：`features/npc/dialogue.ts` 商店窗口加「购买/出售」分页，出售页读权威快照背包、按目录价预览、点 BtBuy 发送；`app/i18n.ts` 补 2 个页签 + 8 个商店错误码中文；`main.ts` 处理 `shopSold` 成功/失败提示；`style.css` 加页签样式（列表区 top 52→54、height 236→234，底边不变）。
- **顺带修复导出缺陷**：`shared/items.json` 由 v83 XML 导出，全部 41 个消耗品 `info` 为空（无 price），药水等完全卖不掉。新增 `scripts/backfill_tms273_item_price.py` 从本地 TMS273 WZ JSON 回填：
  - T 来源：Consume 读 `info.price`（紅色藥水=3）；Etc 无 price 时按原版 `Item/ItemSellPriceStandard.json` 由 `lv` 定价（嫩寶殼=2）——原版官方自动定价表，非猜测。装备已有值不覆盖。
  - 回填 52 项（消耗品 37 + Etc 21 中可定者），剩余 30 项为 403xxxx 任务道具，原版本就无价不可售，保持缺失。三份（shared/public-tms273/dist-tms273）已同步。
- 验证：`cargo build` 通过且警告仍是基线 6 条零新增；新增 `shop_sell_acceptance.rs` **7 项全过**（整堆支付/自动定价 Etc/超量/空槽与错 tab/伪造商店与超距/无价道具/重放幂等）；全量 `cargo test` 172 过 / 11 失败，失败集与「回退 items.json」对照完全一致（回退后 14 失败，说明价格补齐反而修好 3 项既有），零回归；`tsc --noEmit` 通过；`vite build` 通过（→/tmp/dist-shopsell-check，仅既有 chunk 体积警告）。
- 待验（用户）：经 `启动3010.command` 统一构建加载后实玩——找商人 NPC 开商店，切「出售」页应列出背包中可卖物（含药水、怪物掉落），点按钮后枫币增加、物品消失；任务道具不出现在列表；远距离或不存在的商店给出中文提示。
- 已知边界：卖价 50% 为 P 临时规则，非 TMS273 官方数值；商店**回购**（把已卖物品买回）与批量/双击快捷卖出未做。

## 地图反应器（Reactor）：已完成，待统一加载实玩（2026-09-10）

- 选题：静态盘点确认 41 图中 9 张共 39 个 `raw.reactor` 放置，而导出器/服务端/客户端三层全无 reactor——原版基础地图交互里唯一整层缺失的模块。来源 T：本地 TMS273.7 `Reactor.wz` + `Map.wz` reactor 子树。
- 实装五层：① 新增 `scripts/export_tms273_reactor.cjs`（6 模板/39 放置，含 `info.link` 别名解析 9102001→9102000）；② `assemble_tms273.cjs` 给每图挂 `reactors`（坐标/reactorTime/stateCount/hitType/hitboxLt|Rb），manifest 挂 `reactors`，管线加入导出步；③ `world.rs` 加 `ReactorPlacement`/`ReactorInstance`/`Map.reactors` + 校验、`rebuild_reactors()` 幂等重建、`step_reactors()` 按源 timer 复位、`handle_reactor_hit()` 权威判定、快照 `reactors[]`、广播 `reactorState`；④ 协议 11→12，新增 `ReactorHit` 意图与 `reactorState` 广播（Rust + `shared/protocol.ts` 同步，线级 id 校验）；⑤ 客户端新增 `features/world/reactor-view.ts`（待机循环/受击一次性/采空隐藏），`scenes/world.ts` 装载同步清理，`input.ts` 普攻键优先敲 prop。
- 权威边界：客户端只发"我要敲这个 prop"，距离/是否可交互/下一状态全部服务端判定；命中锁 600ms 防连点跳帧连跳级；状态变化一律由广播驱动，客户端绝不自行推进。拒绝码 `reactor_unknown/busy/spent/out_of_range`。
- 验证：`cargo build` 通过且警告仍是基线 6 条零新增；新增 `reactor_acceptance.rs` 9 项全过；客户端 `reactor.check.mjs` 8 项全过；`tsc --noEmit`、`vite build`、`check_tms273_runtime`(41图/44991) 全过；真实 41 图目录端到端探针 31 个 reactor 加载并命中 0→1 广播正确（探针已删）。全量 `cargo test` 11 项失败经"禁用 reactor 校验后失败集不变"证实为既有（auth/inventory/mage 领域）。
- 已知取舍（不冒充完成）：本地参考服务端**无** reactor 掉落脚本（action 名 vFlowerItem0/periItem0 等均不存在），只保留 action 供溯源、不执行；**敲 reactor 当前只推进状态与表现，不掉道具**。8 个落在地图 bounds 之外的放置（閃爍森林两图，bounds 由 miniMap 推导）记入 `omitted` 保留理由，不篡改坐标、不静默丢弃。
- 待验（用户）：经 `启动3010.command` 统一构建加载（protocol 12）后实玩——風塵山丘/小岩石路/暴風地帶/大岩石路/粗岩地帶/楓葉村民家/魔法森林圖書館等图应出现原版花丛与遗物 prop，靠近按 X/Ctrl 有受击动画，敲满后消失并按源 timer 回来。
- 下一步（TODO）：reactor 掉落表需原版证据后再接；`type=9` 踩区 prop 目前靠普攻触发，原版为点击/碰撞触发，交互入口可再补点击。


## 楓之港↔碼頭 传送落点不对：已修复，待重启服务生效（2026-09-10 凌晨）

- 现象（用户）：碼頭→楓之港、楓之港→碼頭 传送后位置都不对（落到半空/错误位置）。
- 根因：章节适配器把脚本门的落点写成了目标图的默认出生点 `sp`。但 WZ 的 `sp` 是**作者标注的出生锚点**，不是地面——
  楓之港/碼頭 的 `sp` 都在 (71,432)，而两地实际地面在 y=527，两者差 95px。服务端 `handle_portal` 只在
  `|ground-dest.y| <= 24` 内吸附地面，超出即保持悬空，玩家落到半空再坠下 → 表现为「位置不对」。
- 原版依据（T）：`Map/Map/Graph.json` 给出脚本渡口的作者落点——
  `002000000/portal/2 → 2000100`、`002000100/portal/1 → 2000000`，且都落**配对门**而非出生点。
  按 portalNum 定位：楓之港→碼頭 落碼頭 `west00`(32,528)；碼頭→楓之港 落楓之港 `in00`(855,523)。两者 Δ 分别 -1/+4，贴地。
- 修复（`scripts/tms273_chapter.cjs` 两处，共 5 个落点）：
  - 渡口：`002000000/east00` 落点 `sp`→`west00`；`002000100/west00` 落点 `sp`→`in00`。
  - 剧情门：`101000000/jobin00` `sp`→`jobout00`；`100000000/Achter00` `sp`→`out02`（Δ 129/26 → -1/-4）。
  - 顺带修既有哑引用：`000030001/out00` 的 `tn=in01` 在嫩寶花園不存在（只有 in00/out00），服务器回落到出生点悬空 63px；改 `in00`（Δ=2）。
- 新增回归断言（两处，双向锁死）：
  - `check_tms273_runtime.cjs`：全量遍历所有跨图门，复刻 `ground_near`+24px 吸附窗口，落点离地 >24px 即失败；并断言渡口双向落点。
  - `server/src/world.rs::tms273_warp_landings_are_grounded`：读真实 `shared/maps.json`，用真正 `Map::ground_near` 验证全部落点贴地 + 渡口双向配对。
- 验证：全量落点 0 悬空；`check_tms273_runtime`（41图/44882引用）、`cargo test portal`(2)、新断言(1)、`tsc --noEmit`、
  `portal.check.mjs`、`vite build`(→/tmp/dist-portal-check2) 全部通过；`cargo build` 仅既有 6 条警告。
- 改动范围：仅 5 个传送门落点变更（+ 上一条的 89 光束），monsters18/skillEffects37/items489/npcs174 零变化。
- 已同步 `client/dist-tms273/assets/manifest.json`（在线 89 门、落点已正确）。
- **重要**：服务端 `MAP_CATALOG` 是**启动时**读取的，运行中的 PID 11921 仍是旧落点。
  需经根目录 `启动3010.command` 重启后本次修复才对服务端生效（会保留数据库与账号）。
- 待验（用户）：重启后实玩——楓之港右側傳陣→落到碼頭左側棧橋；碼頭左側傳陣→落到楓之港街上；两者均落地稳定不再下坠。

## Web 后台保活与暂离驻留：切角色残留 + 回归后无法移动 已修复，待统一加载实玩（2026-09-10）

- 用户实测两个 bug（均由上一轮保活改动引入，已修复）：
  ① 登录 A → 下线 → 登录 B，A 仍留在世界里；② 重新登录回 A，A 无法移动。
- 根因 1（A 残留）：`leaveGame()` 的 `connection.close()` 让服务端把 socket 关闭判为
  `Departure::Detached`（只解绑不删）。socket 关闭与"玩家登出"在服务端不可区分——
  切标签、刷新、关页面看起来完全一样。
  修复：协议新增 `ClientMessage::Logout`（唯一能删除角色的客户端消息）；
  `leaveGame(logout)` 在登出/切角色/菜单退出时先发 `logout` 再关连接；
  `pagehide`/`visibilitychange` 仍不发 logout（那是切屏不是登出）。
- 根因 2（A 无法移动）：接管驻留角色时复用了旧 `Player` 行，`state.last_input_seq`
  仍是上一会话高值（如 30），而新客户端 `PlayerInput.seq` 从 1 重开
  → `seq <= last_input_seq` 全部丢弃 → 角色冻住。
  修复：接管时 `existing.state.last_input_seq = 0`（已反向验证：去掉该行 a14 即失败）。
- 验证：新增 `away_acceptance.rs` a13/a14/a15（含用户完整流程端到端：A→登出→B→登出→回 A 可走）；
  away 用例 15 项全过；全量 165 过 / 11 失败，为基线 12 项的子集（T09 已被并行侧壁修复解决），零回归；
  `cargo build`、`tsc --noEmit` 通过。

## Web 后台保活与暂离驻留：P0 核查 + P1 内核已完成，待统一加载实玩（2026-09-10）

- 方案来源：`bugfix/MapleStory_Web后台保活与暂离驻留_开发方案`（P0—P5）。核查结论另存 `bugfix/MapleStory_Web后台保活与暂离驻留_P0仓库核查.md`。
- 根因（有代码证据）：① `network.rs` 30 秒无上行即 `break` 并 `Command::Leave`；② `world.rs:3146 Leave` 直接 `players.remove(&id)`；③ `main.ts:382 pagehide` 无条件 `connection.close()`。连接关闭 = 角色删除，非渲染暂停。
- 服务端 P1（`server/src/world.rs`、`protocol.rs`、`network.rs`）：
  - 新增 `Detach`/`Exit` 命令与 `AwayWindow`/`AwayPhase`/`AwayReason`；阶段由 `Instant` 派生，不存可变布尔。`AWAY_FULL_RETENTION=600s`、`AWAY_MAX_TOTAL=3600s`。
  - `Leave`→`Detach` 语义分离：仅解绑 `connection/output`（`detached=true`）并清输入，**不删角色**；`broadcast_to_map` 与 `step()` 快照循环跳过 `detached`，队列满只丢快照不删角色。
  - `Join` 改为接管驻留角色：同一实体、同一 away 窗口，`away_sequence+1`，清输入，重算自然恢复边界（避免离场时间被兑成免费 HP/MP）。
  - `step()` 开头 `advance_away_windows()`：达 600s 进基础驻留，达 3600s 走正常退出；一次跨多阈值直接到当前阶段，只播报一次。
  - 快照 `players[]` 增加 `away{residency,remainingMs}`，旁观者可见暂离标记；不改碰撞/受击/物理。
  - 协议新增 `ClientMessage::Lifecycle`（仅提示，不开 away 窗口的关闭权限）；`network.rs` 区分传输响应与应用进度，超时 30s→45s。
- 前端 P1（`client/src/app/main.ts`、`network/session.ts`、`features/player/input.ts`、`features/notice/away.ts`）：
  - `pagehide` 不再 `close()`，只清输入；新增带抖动退避自动重连，终止性结果（鉴权失败/被替代）停止重试。
  - 仅 `hidden` 上报暂离（`blur` 只清输入，双窗口不误判）；新增暂离驻留非阻塞横幅（继续冒险/保持暂离）。
- 验证：`cargo build` 通过；新增 `server/src/away_acceptance.rs` 12 项全过（a01—a12，注入时钟不等待）；`cargo test` 148 通过 / 12 失败，失败集与真基线（`HEAD` + 既有 `sidewall_acceptance` include）**完全一致**，零回归；`tsc --noEmit` 通过。
- 已知既有失败（非本次引入，含 `t09_fast_descent` 在真基线同样失败）：见上方失败清单。
- 待验（用户）：下次 `启动3010.command` 统一构建加载后实测——切标签 5 分钟返回自动继续不重建角色；隐藏 12 分钟后 B 仍见同一带暂离标记角色；A 返回先同步再出提示；按住方向键切出不卡键；真实断网后重连接管原角色且只有一个实体。**未跑浏览器实机冻结/回收场景（T27—T33）**，不冒称多浏览器保证。
- 未做（方案 P2—P5 剩余）：后台订阅降频（`Reduced`/`Minimal` 策略）、队列字节级预算、`freeze/resume` 事件、多标签 `SESSION_REPLACED` 终止码落地、驻留容量监控指标。

## 法师在水中跳不起来（魔力波動 skill_cooldown）：已修复（2026-09-10）

- 现象：法师入水后按跳跃弹出"魔力波動当前不能使用。(skill_cooldown)"且跳不起来；初心者正常。
- 根因（两层，缺一不可，也正因如此只有法师中招）：
  1. **服务端**：`magic_wave_used` / `magic_wave_float_used` 只在 `grounded` 时复位；游泳时 `grounded` 恒为 false → 标志位首次施放后永久置位，之后每次都被 `skill_cooldown` 拒绝。
  2. **客户端**：`castJumpSkill()` 在 `!grounded` 时把空格完全转给 2001012 并不再发跳跃输入；水中 `!grounded` 恒成立，所以空格只施法、永不跳跃。初心者不在法师职业白名单，直接走普通跳跃，故不受影响。
- 修复：
  - `world.rs`：每 tick 增加 `player.state.swimming = player.swimming`，并在游泳分支同样复位一次性波动标志（离水即清）；
  - `protocol.rs` + `shared/protocol.ts`：快照新增 `swimming` 字段（客户端需要区分"游泳"与"空中"）；
  - `client/src/features/player/input.ts`：`castJumpSkill()` 遇 `player.swimming` 直接返回 false，让空格走普通跳跃。
- 验证：
  - 服务端新增 `swimming_resets_the_one_use_magic_wave_flags`（水中连续 3 次施放全部成功、离水后标志清零）；**已用"临时移除修复→该测试失败"反证其有效性**。
  - 客户端独立脚本验证：游泳时不施法且发出 `jump` 输入；非游泳空中仍照旧施放 2001012（不破坏空中缓降）。
  - `cargo build`、`tsc --noEmit` 均通过。全量 165 过 / 11 失败——其中 7 项为并行工作改 `shared/items.json` 导致的背包/道具可用性用例（已用"回退 items.json → 失败降为 4 项基线"证实），4 项为既有基线失败，本改动零回归。
- 待验（用户）：实玩确认法师入水后可正常跳跃/上浮，且空中缓降（二段）不受影响。

## 水中无法起跳：已修复（2026-09-10 凌晨，用户报"严重"）

- 现象：在水中按跳跃完全跳不起来。
- 根因：`step_player` 游泳分支里 `if player.jump` **无条件** `swimming=false` 并施加陆跳速度 `-JUMP_SPEED`。角色以全速弹出水面、随即落回水里，净效果就是"跳不起来"（无论深水浅水，实测每次只上升 ~22px 就被判定离水回落）。
- 修复：跳跃改为"水中划水上升"——保留 `swimming`，施加 `SWIM_JUMP_SPEED=260`（P 值，无 TMS273 源数值），并把位移 clamp 在水体内；只有身体已到水面（`y <= y_min+4`）时跳跃才走原来的"离水登岸"弹道，保证仍能上岸。
- 验证：新增 `water_jump_rises_while_submerged_and_exits_at_the_surface`（3 种水深：均保持游泳且上升 50+px；水面跳跃仍正常离水 `vy<0`）。同时修正 `water_acceptance.rs` 中把旧错误行为写成断言的两处（原断言"深水跳跃必须离水"，正是用户报的 bug）。全量 158 过 / 4 失败（4 项与基线一致）。

## 下落时从两平台中间掉下去：已核查，非碰撞缺陷（2026-09-10 凌晨）

- 用户报："下落时还是会从两个上下不挨着但左右挨着的平台中间掉下去"。
- 核查结论：**未按缺陷修复，因为实测是物理正确行为**。逐帧回放显示：角色走下左平台边缘后，重力使其在下落 2 tick 内下降 15px；若右平台仅低 10~15px 且相距 12px 以上，角色到达其 x 范围时已位于台面**下方** 4px，属于从缝隙下方穿过，不是穿透。
- 判定依据：① 同一缝隙**跳跃可以通过**（证明是真实空隙而非漏检）；② 有 `prev/next` 链条相连的台阶（含竖墙）100% 正确阻挡；③ 41 张真实地图横走回归全部保持 `grounded`，无掉落；④ 扫描真实地图所有"疑似穿透"告警，逐条核对均为**走下平台端点**（如 fh57 在 x=637 结束、fh59 在 x=620 开始），属正常离台。
- 做了对照实验：曾尝试放宽 `landing_on_sweep` 的落点判定（合成矩阵 90 组中 45 组"失败"），但证实放宽会把"本应从下方穿过"的合法情形误判为落地（等于凭空登高），故**已回退该改动**，未引入。
- 若用户实际遇到的是别的地形，请把具体地图/坐标或录屏给我，我再针对性定位——目前合成场景与真实地图均无法复现"非物理"掉落。

## 平台侧壁碰撞：定位+修复完成，已并入主工作区（2026-09-10 凌晨）

- 方案来源：`bugfix/MapleStory_Platform_Sidewall_Collision_Plan.md`。先做定位再改代码，不预设答案。
- 定位结论（与原方案假设不同）：**现有代码并没有"空中失效"的状态分支缺陷**。`step_player` 里行走/上升/下落共用同一个 `chain_wall_for` 入口，`grounded` 不是墙是否存在的开关；起跳后用 `last_foothold_id` 兜住候选，走路撞墙（T01）本来就正确。
- 真实缺陷是**高速下落时的沿途漏检（T09）**：`chain_wall_for` 只用 tick 起始脚点 `y` 判断墙的纵向重叠。单 tick 下落可达 ~33px，角色可能在这一 tick 内从墙顶上方掉到墙的纵向范围内并越过墙面——起点在墙上方（不挡）、终点已过墙（不判），于是直接穿墙。实测 41 张真实地图共 695 段竖墙，`offset=112` 是唯一可复现的穿透相位（下落到 y≈104、墙范围 100..600）。
- 修复（第二阶段"沿途检测"，最小改动）：新增 `Foothold::blocks_at_crossing` 与 `Map::chain_wall_on_sweep`，把纵向重叠判定从 tick 边界改为**接触时刻** `t=(wall_x-from_x)/dx` 的插值 y。行走路径退化为 `t=0`，与 `chain_wall_for` 同一代码路径，保证"走路挡、跳跃也挡"不分裂。新增 `BODY_HEIGHT_PX=50` 复用既有脚点代理高度常量，未引入身体 AABB、未改跳跃参数/坐标精度。
- 关键取舍：不能改用"起止点纵向区间并集"判重叠——那会把"上升途中已越过墙顶"的合法跳跃也拦住（实测会破坏 T02/T06）。必须按接触时刻判定。
- 验证（隔离 worktree `/tmp/ms-sidewall`，HEAD=c37f5b0）：
  - 新增 `server/src/sidewall_acceptance.rs`（10 用例：T01/T02/T03/T05/T06/T07/T09/T11/T13 + 不变量断言）。**修复前 9 过 1 失败（T09 穿透），修复后 10 全过**。
  - 41 张真实地图静置回归全过（`real_map_walk_regression`，位置均有限、未掉出世界）。
  - 全量 `cargo test`：145 通过 / 4 失败，4 项与基线完全一致（`third_store_book_split_222`、`bundled_catalog_...`、`config_drop_and_exp_...`、`third_sphere_and_adaptation_...`），已用"回退修复后重跑同样失败"证实与本改动无关。
  - `cargo build` 通过，仅既有两个未使用告警（`contact_damage` 等在基线即有）。
- **未合并**：`server/src/world.rs` 正被另一并行工作（Web 后台保活/暂离驻留，新增 Detach/Exit 与 chrono 依赖）持续写入，为避免互相覆盖，本次未落盘主工作区。补丁已存 `bugfix/sidewall_fix.patch`（131 行，仅改 world.rs 的 3 处 + 常量），全量已修文件 `bugfix/world.rs.sidewall-fixed`。等对方稳定后 `git apply bugfix/sidewall_fix.patch` 或手工合并即可（三处：常量区 `BODY_HEIGHT_PX`、`Foothold` impl 加 `blocks_at_crossing`、`Map` impl 加 `chain_wall_on_sweep` + `step_player` 调用点）。
- 未验证范围（按用户验收政策，交用户亲测）：真实手感、斜坡/接缝（T13 仅覆盖链条几何）、冲刺/击退/瞬移（T18）、双端一致性（客户端无本地物理预测，权威全在服务端，故 T17 不适用）。未重启在线服务、未改数据库。

## 枫之港看不到前往码头的传送阵：已修复并上线（2026-09-10 凌晨）

- 现象（用户）：楓之港（002000000）看不到前往碼頭（002000100）的传送阵；该门实际可交互，只是没有光束。
- 根因（两处独立过滤叠加）：
  1. 导出器 `scripts/export_tms273.cjs::exportPortals` 只导出 `type===2 && targetMapId && !script` 的门。而 TMS273 里楓之港 `east00` 是 `pt=7` 且带 `script: pt_southperry`，WZ 原始 `tm=999999999`（无目标）；它的目标图是后来由 `tms273_chapter.cjs` 的 P 适配在装配期补上的。因此导出阶段它既不是 type2 又无目标 → 从未进入 `portals.json`（84 项里没有它）。
  2. 渲染层 `client/src/scenes/world.ts` 无条件 `if (portal.script) continue;`，即使装配后已有了目标也仍被跳过。
- 修复：
  - `scripts/assemble_tms273.cjs`：在 `applyChapter` 之后（路线已分配）补一段——对每张图里「有 targetMapId 且目标不是本图、且目标图在 41 图装配目录内、且尚未有光束」的门，复用共享 `pv/default` 光束（8 帧）。目标图未装配的门（104020100/310040210）不加光束，避免诱导走不通的路线。同图 type10（bottom0/top0）保持不可见。
  - `client/src/scenes/world.ts`：删除 `if (portal.script) continue;`，改为 `if (!portal.targetMapId || portal.targetMapId === this.manifest.map.id) continue;`（脚本不再作为排除条件）。
  - `client/src/features/world/portal-view.ts`：修首帧锚点单位 bug——`AssetFrame.origin` 是源像素，而 Phaser `setOrigin` 需要 0..1 归一化值；原代码首帧直接传像素（如 y=134），与换帧逻辑 `applyFrame` 不一致，会让光束偏移约 134px。统一抽 `normalizedOrigin()` 供两处共用。
- 结果：manifest portals 84 → 89，新增 `002000000/east00`、`002000100/west00`、`101000000/jobin00`、`100000000/Achter00`、`100000201/out02`；除 portals 外无任何顶层字段变化（monsters18/skillEffects37/items489/npcs174 均不变）。
- 验证：`check_tms273_runtime.cjs tms273-9` 通过（41 maps / 44882 refs）；`cargo build` 通过（仅既有 6 条警告）；前端 `tsc --noEmit` 通过；`portal.check.mjs` 9 场景通过（新增脚本门可进、同图链仍可进）；`vite build` 通过（因沙箱批量删除保护挡住 `emptyOutDir`，改用 `/tmp/dist-portal-check` 验证，产物 89 门 + 8 张光束 PNG 齐全）。
- 新增回归断言：`check_tms273_runtime.cjs` 增加「所有跨图门必须有光束」全量校验 + 楓之港/碼頭双向门断言；`portal.check.mjs` 增加脚本门交互用例。
- 发布：已把新 manifest 同步到 `client/dist-tms273`（在线服务正在使用），在线 `/assets/manifest.json` 已返回 89 门。**未重启服务、未改数据库**（光束 PNG 本就复用同一批 8 张，dist 不缺文件）。
- 待验（用户）：刷新浏览器实玩——楓之港右側碼頭方向（x≈2520, y≈290）应出现原版 pv/default 光束，按 ↑ 可前往碼頭；碼頭左側（x≈32, y≈528）同样有光束可返回楓之港；光束贴合地面不偏移。

## 选择岔道法师NPC距离限制移除 + 拒绝提示中文化 + 初心者隐藏法师技能页（2026-09-10 凌晨）

- 需求：选择岔道（001020000）汉斯 NPC 不再有「stand closer to the npc」距离限制；该限制改为合适的中文提示；初心者（job 0）技能界面不显示法师技能页。
- 服务端 `server/src/world.rs handle_npc_talk`：
  - `mage_entry`（map 001020000 + npc 001020000-life-1 + template 10201）直接跳过距离判定，不再复用 100×80 的放宽范围；其余 NPC 保持 `npc::TALK_RANGE_X/Y`（800×600）。
  - 4 处英文拒绝文案按 `lang` 出中文：`npc_too_far`（请靠近 NPC 后再与其对话 / 该 NPC 不在当前地图）、`npc_unknown`（找不到该 NPC / 该 NPC 资料缺失，暂时无法对话）、`npc_unavailable`（该 NPC 当前无法与你对话）、`npc_step_invalid`（该对话选项已失效，请重新与 NPC 交谈）；`LANG_EN` 保留英文。
  - 测试 `mage_job_advance_is_menu_bound_authorized_and_persisted`：原 `x=250` 断言 `npc_too_far` 改为断言返回 `npcResult`/`kind=simple`（远距离仍可开菜单），并 `end_conversation` 复位，后续步骤不变。
- 客户端 `client/src/app/i18n.ts` `PROTOCOL_ERRORS` 新增：`npc_too_far`、`npc_unknown`、`npc_unavailable`、`npc_step_invalid`、`job_advance_unavailable` 的 zh/en 文案，避免英文原串直接暴露。
- 客户端 `client/src/features/skills/view.ts`：
  - `books()` 新增过滤 `id !== '200' || MAGE_JOB_WHITELIST.has(job)`，初心者不再出现「法师入门/冰雷指南」等页；220/221/222 过滤保持原样。
  - `update()` 记录 `jobChanged`，转职后清空 `selectedBookId`，`render()` 自动落到新职业页（否则转职后停留在初心者页）。
  - `view.check.mjs` 追加断言：初心者 books 含 '0' 且不含 '200'/'220'、`canLearn(2001008)` 为 false；法师 books 含 '200'。
- 验证：`cargo build` 通过（仅既有 `contact_damage` 未使用警告）；`cargo test mage_job_advance_...` 通过；`cargo test chapter` 3 项通过；`cargo test` 全量 128 通过 / 11 失败，与 stash 掉本次改动后的基线完全一致（失败集中在 inventory/auth/mage/third，属既有问题）；前端 `tsc --noEmit` 通过；skills/npc dialogue/npc view/combat/character/levelup/water 检查通过。`input.check.mjs` 与 `hud/gauge.check.ts` 的失败为既有问题（未改动其源码，`npm run check` 未整体跑通）。在线服务与数据库未重启、未改动。
- 待验（用户）：下次 `启动3010.command` 统一构建加载后实玩确认：① 选择岔道任意位置点击/↑ 与汉斯对话不再提示距离；② 其他地图远距离点 NPC 提示「请靠近 NPC 后再与其对话」；③ 初心者按 K 只看到初心者页，转职为法师后自动切到法师页。

## 头顶聊天气泡：替换为原版 273 ChatBalloon 素材（2026-09-10 凌晨）

- 现状（替换前）：`PlayerView.showBubble` 用 Phaser Graphics 自绘半透明圆角矩形 + 浅蓝名字 + 白字正文，色系和原版 273 不一致；仅他人发言显示气泡，自己的 echo 只入聊天日志。
- 目标：参考原版 273 素材做气泡框，并按"气泡绑定角色"逻辑跟随角色移动、显示 4 秒、死亡/切图清理。
- 实装：
  - 新增 `scripts/export_tms273_balloon.cjs`：导出 `UI/ChatBalloon.img/0` 的 9 切片（nw/n/ne/w/c/e/sw/s/se 6×6/12×6/6×14/12×14/13×13）+ `arrow` 13×13 共 10 张 PNG 到 `resources/tms273-export/assets/tms273`，并生成 `balloon.json`（含 `slices.url/width/height/origin/x/y` 与 `clr=-16777216`）。
  - `scripts/assemble_tms273.cjs`：新增 `chatBalloon: read('balloon')` 合并到 manifest，`collect()` 自动把这 10 个 `/assets/tms273/...` 复制到 `client/public-tms273/assets/tms273`，`client/public-tms273/assets/manifest.json` 中已含 `chatBalloon` 节点。`build_tms273.cjs` 管线加入 `export_tms273_balloon`。
  - `client/src/assets/manifest.ts`：新增 `ChatBalloonData`/`ChatBalloonAsset` 类型与 `Manifest.chatBalloon` 字段。
  - `client/src/scenes/world.ts preload`：收集 `chatBalloon.slices` 全部 URL 用 `load.image(key, url)` 注册为纹理。
  - `client/src/features/player/view.ts`：
    - 新增 `private readonly self: boolean` 保留构造函数传入标志，用于气泡名字颜色（自己 #fff3a5 / 其他人 #5b9bcc）。
    - `showBubble` 拆分为 `buildSourceBubble` 与 `buildFallbackBubble`：源切片可用时用 9 个 `add.image` 拼九宫格（角部 6×6 不拉伸，n/s 用 `setDisplaySize(textW, 6)`、w/e 用 `setDisplaySize(6, textH)`，c 用 `setDisplaySize(textW, textH)`，arrow 居中贴底边）；文字 `nameLabel`/`bodyLabel` 用 `add.text`，body 用黑色 + 黑色 1px 描边（来自 `clr`）保可读性；`BUBBLE_MAX_CHARS=96` 保留。`clearBubble` 同时清理 `pendingBubble` 防止重复重建。`updateBubble` 改为锚定 `player.y + headOffsetY - bubble.height - 4`，气泡底部紧贴角色头顶。
    - 旧 graphics 矩形保留为 fallback（无 `chatBalloon` 资源时仍能渲染）。
- 验证：`client/tsc --noEmit` 通过；`client/npm run build` 跑过（dist-tms273/assets 含 10 张 ChatBalloon PNG + 新 index-*.js）；在线服务未重启、未碰数据库。
- 待验（用户）：下次 `启动3010.command` 统一加载后实玩确认：自己/他人发言时头顶出现白底气泡+箭头，名字+正文清晰可读，气泡随角色移动 4 秒后自动消失，死亡/换图清理，多人同时发言不串位、arrow 不被角色身体遮挡。

## 聊天输入焦点根因修复：Enter 后光标被 snapshot 抢走（2026-09-10 凌晨）

- 现象（用户实测）：Enter 后光标"闪一下"即从聊天输入框消失，再按键又触发游戏快捷键。
- 根因：服务端每世界 tick(~50ms)向每个玩家推 snapshot；客户端 `Connection.onmessage` 对每条 snapshot 都回调 `state('online')`；`main.ts` 对每次 online 执行 `focusGame()`（rAF 聚焦 `#game`）。Enter 聚焦输入框后不足 50ms 即被下一个 snapshot 触发抢焦点。此前离线 mock 只触发一次 online，故复现脚本第一轮未暴露。
- 修复：`client/src/network/session.ts` 状态上报幂等（`lastState`+`report()`，仅变化时回调）。`chat-focus.check.mjs` mock 同步修复后契约并新增 10a(legacy 复现抢焦点)/10b(修复后 400ms 焦点保持、focusGame 零调用)场景。
- 待验（用户）：在线仍跑旧构建；下次 `启动3010.command` 统一构建加载后实玩确认：Enter 后光标驻留输入框、可连续打字、不触发快捷键、Esc 正常返回游戏。

## 地图聊天输入焦点修复：完成开发与定向验证，待统一加载后实玩（2026-09-10）

- 范围：修复"聊天栏无法输入、打字触发游戏快捷键"。`client/src/features/chat/view.ts` 两处：① Enter 分支不再因折叠态 `input.disabled` 早退（改为 `!this.available` 守卫 + 先 `setOpen(true)` 解除 disabled 再 focus），折叠面板按 Enter 可重开并聚焦；② 新增 `onRootPointerDown`：点击聊天面板非控件/非日志区域即聚焦输入框（273 底图大于真实 input，此前点偏导致焦点落页面、打字落游戏键）。
- 验证：新增离线复现脚本 `client/src/app/chat-focus.check.mjs`（esbuild 打包真实 app+mock 连接）9 场景全过：Enter 聚焦输入、打字零泄漏、方向/空格/Z/X/数字/A/D 逐键不穿透、提交/Esc 正常、按住方向键开聊立即停止、折叠 Enter 重开聚焦、点击面板空白聚焦。`tsc --noEmit` 通过。
- 待验（用户）：在线服务仍跑旧构建，本次修复未上线。下次经根目录 `启动3010.command` 统一构建加载后实玩：折叠聊天框后按 Enter 应展开并可直接输入；点击聊天框底图任意处应聚焦输入框；聊天打字时角色不应移动/施法。

## 地图聊天 P1-C04：已完成开发与定向验证，待统一启动加载/用户实玩（2026-09-09）

- 范围：按 `MapleStory_Rust_Chat_Ops_Development_Plan` 完成 P0-C00 真实盘点 + P1 C03/C04 最小闭环（地图公共聊天），未做私聊/离线/跨服/公告/GM。
- 协议：protocolVersion 10→11（server protocol.rs 与 shared/protocol.ts 同步）；新增 `chatSend`（requestId+text）与 `chatMessage`（messageId/可选 requestId/mapId/authorId/authorName/text/occurredAtTick）。消息房间只由服务端从会话当前地图推导，`deny_unknown_fields` 拒绝伪造 mapId/author/GM/system 字段。
- 服务端（world.rs 权威边界 `handle_chat`）：按当前 `map_id` 成员做房间广播（复用每连接有界 output，`try_send` 不阻塞 tick）；文本策略 ≤200 字符/≤1KiB/无控制字符；每角色令牌桶（突发5、1/s 惰性按 tick 补充，换图不可重置）；request_id 幂等窗口 64（同ID同正文不重复广播，同ID异正文 `idempotency_conflict`）。
- 客户端：ChatView 接入提交与 pending（按 requestId 合并回显、拒绝恢复草稿可改后重发）、IME composition 防误发、Enter 聚焦输入/Esc 退出、273 面板由"暂未开放"转可用；Phaser 同图玩家头顶气泡（4s、非本人发言、切图/重放不生成）；i18n 补 3 个聊天错误码。
- P 边界：项目无频道/多实例体系，地图房间=map_id（同模板不同实例隔离以不同 map_id 覆盖验证）；私聊/频道/世界聊天/禁言/审计后续工单。
- 验证：chat 定向 7 项验收全通过（房间隔离、伪造拒绝、重复/冲突幂等、令牌限流与恢复、慢连接满队列不阻塞他人、文本策略）；`cargo test` 全量 135 通过 + 4 项基线既有失败（stash 掉聊天改动后同样失败，与聊天无关，属 09-09 装配回退/数值待办范围）；`cargo build` 通过（仅既有 contact_damage 警告）；前端 `tsc --noEmit` 通过。未跑 vite build——在线 dist/protocol10 服务运行中，避免覆盖与版本错配；未重启服务/改库。
- 待验（用户）：下次经根目录 `启动3010.command` 统一构建加载（protocol 11）后实玩：Enter 发言、他人头顶气泡、同图可见/异图不可见、连发限流提示与拒绝草稿恢复、中文输入法候选确认不误发。


## 地图怪物刷新修复：怪死后不重生（2026-09-09）

- 现象：地图怪物被清空后不再刷新，数量补不回出生点上限（离图再回也不恢复）。
- 根因：`shared/gameplay.json` 的 `monsterRespawnMs` 为 null（TMS273 迁移后装配脚本未写该字段，v83 时代为 10000）；377/390 出生点 `mobTime=0` 表示"走地图刷新周期"，代码里周期缺失→ `respawn_at=None` → 死后仅移除不重生。
- 修复：① `server/src/world.rs` 收敛 5 处 kill→重生赋值为 `respawn_deadline()`，`mobTime=0` 且无配置周期时用默认 10s（`DEFAULT_MONSTER_RESPAWN_MS`），`-1` 保持一次性、正数按死亡起算秒延迟；② `scripts/generate_tms273_gameplay.py` 输出 `monsterRespawnMs:10000` 并在 compatibility 注明 P 来源；③ 同步 resources/export、shared、client/public 三份 gameplay.json 该字段（三份一致）。
- 验证：cargo build 通过（仅既有 contact_damage 未使用警告）；新增定向测试 `map_cycle_mob_time_zero_respawns_even_without_configured_interval` 及 respawn/life/contact 相关 5 项通过；`check_tms273_runtime.cjs tms273-9` 通过（41 maps/44583 refs）。在线服务/库未动。
- 待验（用户）：下次通过根目录 `启动3010.command` 加载后，杀光地图怪观察 ~10s 后按出生点补刷、数量不超过该图出生点数。

## 36315–36324 楓之島災禍篇：来源已核、装配回退待基线（2026-09-09）

- 范围确认：接续 36314，原版 36315–36324 共 10 条任务；36325+ 被 1410/1430/1462 转职前置与 lv60/100/200 门槛挡住，保留 TODO。
- 已核来源（T，本地 TMS273，记录于 `references/tms273-data/maple-island-calamity-source.json`，保留）：任务 QuestData/36315..24（Act/Say 空、q3631xs/e 脚本体缺失→执行标 P）；怪物 8645261 藍色蘑菇王(lv22/HP2175)、8645262 黑色影子(lv30/HP4500/boss)、8645264 黑漆漆的嫩寶(lv25/HP525)；NPC 1520000 糖果；原版图 993166100/434/019·351/021·042·043·044·023/200/175/024·025（本地 Map JSON 为空不可解→U）。job 源列 [100,200,300,400,430,500,501] 缺 220/221/222→按职业群解释（P）。
- 本轮已回退（世界状态恢复 HEAD 已知良好组合）：装配子代理重建了 shared/gameplay.json 与 client/public-tms273 公开资源，但导出中间产物本身不一致（entities.json 仅 4 怪、mage-effects.json 仅 18 效果、appearance.json 缺 1003134），导致 manifest 从线上基线 18 怪/37 效果跌到 7 怪/18 效果，运行检查在 skillEffects 1000 与 disguise 处失败。已全部 git checkout 回退，并把公开 manifest/gameplay/items/entry-appearance 从在线 3010 服务还原为线上基线；`check_tms273_runtime.cjs tms273-9` 通过（41 maps/44583 refs），cargo build 通过，在线服务与库未动。
- 续接前提：先把导出中间产物与客户端 Data 对齐基线（entities 18 怪、mage-effects 含 1000/1001/1002、appearance 含 1003134，校验 `check_tms273_runtime` 与 `check_tms273_mage_effects`），再重做「数据装配→后端子代理（world.rs + calamity_acceptance.rs，击杀计数/任务刷怪/selfComplete）→前端」。
- 子代理频率限制：通用子代理 09-10 01:52 前不可再派发，后端骨架（world.rs 结构体+qkill 装载拆分）已随回退丢弃，续做时按来源记录重建即可。

## 最新目标：编译收尾完成（覆盖此前持续复刻目标）

- 用户要求尽快结束目标：前后端语法正确、编译正常，未完成但不影响编译的业务转TODO；本轮停止新增模块及研究派发。
- 后端cargo build、前端tsc/Vite生产build均通过；最后仅修改测试夹具，Rust测试编译及Hyper六项定向检查通过。证据见IMPLEMENTATION_STATUS.md。未重启在线服务或修改存档。
- TODO：原版36315+后续剧情、完整转职演出/礼盒；V核心/HEXA、现代装备强化与账号成长；正式Boss奖励、后续Boss与日周结算；研究包其余未完成项目。保留原研究包需求，不视为已经复刻完成。
- TODO：Hyper专用原版窗口、原版精确服务端节拍、敌方致命异常、队伍增益传播、末击Special目标标记；当前P规则及已实现逻辑保留。
- TODO：实际游戏手感、源素材挂点/遮挡与联机生命周期实玩；现有生产包体积警告及contact_damage未使用警告不阻塞编译，后续按需处理。

## Windows 构建环境已疏通（2026-10-19）

- Windows 首跑在 cargo 阶段失败：`CRYPT_E_REVOCATION_OFFLINE (0x80092013)`，根因是本机 schannel 连不上 CRL/OCSP，
  与 `~/.cargo/config.toml` 配置的 rsproxy 镜像 TLS 握手全败（镜像本身可用，`curl --ssl-no-revoke` 返回 200）。
- 只改仓库外的 `~/.cargo/config.toml`（`[http] check-revoke = false`，配套 `multiplexing=false`、`timeout=60`、`[net] retry=5`），
  未动业务代码。补齐 44 个缺失依赖（argon2/axum/rusqlite/tokio 等），registry 缓存 462→506。
- Windows 实机验证：资源检查（104429 引用/41 图）、`npm ci`、`cargo build --locked`（GC 后 0.48s，仅既有
  `contact_damage` 未使用警告）、`tsc --noEmit`、`vite build`（2m43s，仅 chunk 体积警告）全部通过；
  `/api/health` 返回 protocol10/tms273-9，`/` 与 CSS/JS 静态资源均 200。产物已在 `client/dist-tms273`。
- 待验（用户）：Windows 真实启停与浏览器实玩。上方两条警告按既有结论不阻塞编译。
- 注意两点排查陷阱：Cargo 首次构建会静默 GC 其他项目遗留的 registry 源码目录（约 15 分钟，只在 `-v` 打印，
  中断会重来）；`evidence/runtime/windows-3010/build.log` 是追加写入，开头的 `Missing asset` 是历史记录。

## 当前目标执行：大模块优先（2026-09-08）

- 用户 /goal：按研究包推进；模块开发先静态核对入口→权威状态→持久事务→反馈→失败恢复闭环，检查幂等、性能、分层、视觉及玩家下一步；完成模块后才运行必要核心脚本，每模块新增/修改验收脚本累计≤7文件、≤1000行，不独立QA、不动在线库与服务。
- 冒险家开局六任务大模块已完成开发与有限核心验证（6文件、不到550行），证据移入IMPLEMENTATION_STATUS.md。原版过场/礼盒及36308+尚未实现，未将整个M2标为完成。
- 冰雷三转核心模块已完成代码与有限验证，详细证据移入IMPLEMENTATION_STATUS.md：7文件/672行、Rust六项核心与客户端检查/离线构建通过；未在线发布。元素适应实际异常防御入口及原版耗尽后CD时点仍待状态/Boss模块，不能视作完全原作一致。
- 运行保持protocol7/content tms273-3；前端任务UI已由联合修复任务发布。首章最后后端恢复修正已验证，待下一次用户启动带入，不为复验重复重启服务。


## 升级原版反馈：已更新前端，待实玩（2026-09-08）

- v0.6.1已接原版LevelUp的21帧/2300ms及Sound/Game.img/LevelUp，实际升级只播放一次；初始入图/重连不播，离图清理。源检查、生命周期定向检查及生产构建通过，详细证据见IMPLEMENTATION_STATUS.md。
- LevelUp2仅保留来源，未证实与LevelUp同时播放；选用LevelUp的策略标P。用户待验升级时画面位置、声音与移动跟随；本轮未重启服务或更改存档。

## 冰雷后续与原版行为差距（2026-09-08）

- 三转已完成的来源、设计与核心验证见IMPLEMENTATION_STATUS.md，首章36308+、完整转职脚本、四转与区域成长/Boss仍待接续，不触发“冰雷完成”彩蛋。
- root下一步：结合联网官方资料和本地273核定冰雷四转/成长区域输入，先静态明确大模块闭环，不直接打开空技能书或赠满技能。维持原剧情与存档。
- 并行用户任务01a07ef8-4afc-7762-b743-f0b90a481015已接管world/mage/auth/protocol/client及导出装配，实施初心者0001000/1/2。其模块完成前root只做来源/架构调查，不交叉改业务文件；新目录32/content5由该任务负责，不沿用三转29目录通过证据。
- 在线仍content3；本任务v0.7.0/content4独立构建已完成但不覆盖在线dist，不自动重启。后续用户启动统一带入三转与SP补偿，实玩手感/遮挡待验。

## R012技能音效：已发布，待用户实玩（2026-09-08）

- 同版Sound导出与前端Use/Hit播放/去重/清理已完成，证据见IMPLEMENTATION_STATUS.md；special/Loop源节点保留但触发时序未知，后续核定后接，不冒称全部声音1:1。
- 本次发布范围已冻结，本任务所有文件释放；由并行“复刻菜单登录与角色流程”任务完成共同构建并通过启动3010.command发布；v0.6.0/tms273-2、PID82829监听证据见历史。用户在线库与服务未因本轮验证重置。

## 经验—升级—AP加点：已发布，待用户实玩（2026-09-08）

- 用户明确要求跑通经验进度、升级、属性加点。根因：shared/gameplay.json的expTable为空；四维仍来自全局PlayerConfig。保留已积累经验和角色数据，不清库。
- P临时曲线：1..59级升级经验=15×等级²，60级为当前表上限；升级+5AP，初始四维沿用当前12/5/4/4，旧版尚无AP的角色迁移补回每个已升级等级5AP，每次加点1点、基础单项上限9999。不是273官方经验/加点表，后续原表替换。
- root独占auth.rs/协议/装配；ice_runtime Luna/max独占world.rs/mage.rs，接个人基础属性到普攻、魔攻、装备门槛与存档；growth_frontend Luna/max独占client/src逻辑，接C窗口四维加点/经验显示与HUD；ice_source Luna/max导出同版AP按钮。源图PDF第2/4/6页已读，HTML A14/C06远程本轮打不开，使用已核本地273原节点，不凭标题补布局。
- 验证：真实运行经验表、跨级AP、重复奖励/加点与越权输入、零AP和死亡、保存重开/配置变更、个人与装备/技能加成不重复；UI必要定向检查和构建，在线服务与库不作为测试夹具。
- 当前：auth/协议4项定向检查已通过，来源/装配检查通过；前端check/typecheck和Safari离线390×844、844×390、1440×844加点响应通过。World成长/冰雷46项检查通过，证据已移入IMPLEMENTATION_STATUS.md；已与并行大厅任务联合构建/发布；用户待验打怪经验进度、升级提示、C窗口AP分配及重登恢复。

## 登录与菜单：已发布，用户待实玩（2026-09-08）

- 登录→单主频道→12栏选角→自定义外观创角→入图及菜单返回入口已实现；定向验证与来源差异见IMPLEMENTATION_STATUS.md。
- 待用户实玩：既有账号迁移后的角色/存档、创建后入图外观及施法、远端角色、菜单窗口切换、手机滚动操作。未执行在线账号探针或独立QA。
- 频道背景目前采用本地273默认WorldSelect，尚非用户图中的蓝龙季节主题；菜单未有对应业务的项目明确提示未实装，不把菜单复刻当作公会/拍卖等系统完成。


## 冰雷二转：已发布，待用户实玩（2026-09-08）

- 用户确认二转也先跑通，缺失规则标P。按源lv30/job200门槛在岔道汉斯训练菜单选择冰雷，P快捷转职不替代q1416剧情；转职授予5点book220 SP，固定1级结冰特效随转职启用，此后升级3点入220、一转未花SP保留。
- root：auth.rs持久化/共享协议、导出投影、装配与根文档；Luna/max ice_runtime：仅world.rs与mage.rs及所属定向检查，实现220全部9技能、二转菜单、源矩形多目标伤害/冻结/寒冰迅移路径/被动/精神强化。Luna/max ice_source：核定源后负责缺失效果和角色动作导出；前端Luna/max独占skills/player输入及显示逻辑。代理不得跨写。
- 架构复用既有顺序World和技能动作账本；book200/220分别校验与扣SP，原MP和伤害存档链复用。新增怪物MP/冻结层数与定时路径地面效果只在同一World tick处理；源未知的触发计次/冻结上限/伤害时序标P。
- 验证：两书权限隔离、重复转职/学习/施放、MP不足、源目标/段数与冻结消耗、被动重算/过期、重登恢复；只定向自检和编译，无在线账号探针或独立QA。冰雷后续转职/核心/Boss仍在总目标内，彩蛋未触发。
- 9技能与成长World46项检查已通过，前端技能/冻结/冰面表现已接，详细证据见历史。main/player/world已释放给登录任务；联合发布完成，由用户实玩技能学习、施放、冻结与冰面效果。


## 装备闭环：套服换装待实玩（2026-09-08）

- R014/R017/R020的套服占位、容量原子处理及存档重放这一子项已完成，代码与两项定向检查证据见IMPLEMENTATION_STATUS.md；不代表套装加成或整个M2已完成。
- 后续仅通过启动3010.command加载服务端改动；用户待验双击/拖拽换装、满包提示、画面层与属性刷新。本任务未重启服务或改在线存档。
- 接续优先级仍为首职业法师→冰雷及原版首章；q363执行脚本、冰雷后续转职规则与准确时序依赖保持原记录，不用原创任务或免费满技能替代。


## 碰撞与受击修复：待运行验收（2026-09-08）

- 代码和定向检查结果见IMPLEMENTATION_STATUS.md。本轮不重启在线服务；后续通过根目录启动3010.command加载修复，再由用户验收接触扣血、击退闪白、施法打断和魔心防御。背包与拾取动画继续使用现有实现。

更新：2026-09-08。目标以 `参考/273` 的 TMS273.7 为唯一复刻依据，替换 UI、地图、动画、任务并运行游戏。用户已明确选择 **273 原版冒险家剧情**，首个完整职业为 **法师 → 冰雷**（2026-09-07本轮确认）。

## 法师一转已发布 v0.5.0（2026-09-08）

- 选择岔道汉斯提供转职、技能窗入口和恢复魔力。学习/SP/MP/魔灵弹多目标多段/魔心防御/瞬移/魔力波动及被动属性已接入；按最新授权，参考缺失的规则以P临时实现，详见IMPLEMENTATION_STATUS.md。
- 原版技能特效、角色动作及角色属性窗已接入。K加点/施放，C属性；1魔灵弹、2瞬移、3魔心防御，上+空格魔力波动，空中空格缓降。四维及派生属性均读服务端快照。
- 定向服务端7项检查、客户端检查和生产构建通过；资源检查通过。用户实玩待验，未开独立QA或创建在线验收账号。
- 服务已通过启动3010.command重建并启动：PID58837，3010监听，仍用server/data/tms273.sqlite3。完整冰雷路线（后续转职/技能/装备成长/Boss验证）继续保留，尚未完成；Codex彩蛋暂不触发。

## 历史：v0.4.5法师入口发布（已由v0.5.0覆盖）

- 选择岔道001020000的汉斯菜单「法师」已接入job0→200持久化转职，原版气泡QuestIcon/30/0静态显示并可点击；此快捷入口按用户授权实施，不依赖q1402脚本。代码、素材与检查证据见IMPLEMENTATION_STATUS.md。
- Luna/max mage_transfer与mage_marker_assets已完成本轮分工。root已发布v0.4.5；旧服务在本轮中已无监听（未主动停止，原因未知），新服务PID44030使用原server/data/tms273.sqlite3启动，3010监听确认，未重置存档或创建验收账号。
- 转职实际操作、头顶位置/遮挡由用户亲测。完整冰雷仍需下列SP/技能施放/装备/Boss链路；未宣称完成，Codex彩蛋未触发，具体名称/入口仍待用户回答。

## 历史：技能学习条件与运行时接入边界（一转范围由2026-09-08授权覆盖）

- 同版技能窗口资源已完成，证据移入IMPLEMENTATION_STATUS.md；75张PNG、318×361底图、7个转职Tab与11组按钮四态已导出。客户端已接入目录和已学状态展示；不采用角色信息页2×6作为独立技能窗几何。
- 已学等级/SP、加点权限仍须服务器持有；除用户指定汉斯菜单转职外，不自动改变职业或赠送技能。
- 两本技能书17节点目录及图标已完成；客户端public清单已增量装配，运行dist已更新至v0.4.2，证据见IMPLEMENTATION_STATUS.md。

- 三技能逐级源数值表已完成并通过定向检查（历史见IMPLEMENTATION_STATUS.md）；下一步由服务器消费已核定字段，仍需已学等级/SP与权限校验，不能把源倍率表直接当最终伤害。

- 技能等级/SP存档与共享协议已完成，定向2项测试、cargo check、前端typecheck通过，历史见IMPLEMENTATION_STATUS.md；新增列已随v0.4.5服务正常启动迁移；实际角色交互待用户亲测。

- 只读技能目录窗口已完成并发布前端v0.4.2（K/主菜单入口、书页、等级与详情）；实际界面检查和构建证据移入IMPLEMENTATION_STATUS.md。下一步仍是已核定学习权限、SP授予与技能施放，不能把目录展示视为战斗完成。

## 本轮源规则核验（2026-09-08）

- 指定Etc实际WZ的权限核验已完成，结果移入IMPLEMENTATION_STATUS.md；未发现200/220的SP组/授予/职业访问。LevelUpGuide实际比JSON多Guide/Image，可作为后续等级引导输入，但不是转职执行脚本。
- 寒冰迅移概率颜色标志回归已修复并发布前端v0.4.4，检查证据移入IMPLEMENTATION_STATUS.md。
- 用户输入待回：已询问额外TMS273 q363/q1402/q1416脚本包及冰雷实机录像路径/链接。现有私服MakeCharacterSetting为自定义开局，已排除；武器两套编号仍无直接执行映射依据。

## 历史：技能接入边界（一转范围由本轮实现覆盖，冰雷部分仍待完成）

- 逐级原版技能说明已发布前端v0.4.3，16条有String.h的技能可显示当前/下一等级完整效果；证据移入IMPLEMENTATION_STATUS.md。界面实际阅读/滚动交用户亲测。
- root：现有攻击链按单target/damage/resolved存储，不能直接承载冰雷多目标/多段；下一步需以施放为单位绑定技能/等级和MP扣减、以命中序列去重结算，沿用世界顺序处理和SQLite事务，不从客户端接收伤害。命中时点证据未核定前不套用普攻延迟。
- 三技能施放时序仍未知：研究包S07没有这三技能条目，不能外推其他职业的攻速改动。冰/雷weapon=37/38为源字段，执行前仍核定映射及门槛语义；魔灵弹目标矩形/冰锥剑冻结8秒等已核字段不等于完整可执行规格。

## 历史：法师→冰雷技能接入依据（冰雷后续仍适用）

- root：协调共享协议/根文档和后续技能权威执行边界；2001008/2201008/2201005来源资源已完成（历史见IMPLEMENTATION_STATUS.md）；已学技能持久化与只读窗口已完成；下一步需SP/学习规则、MP/魔法伤害、施放意图及命中时间证据，不把素材导出视为技能可玩。
- 技能依据待补：魔灵弹2001008、当前冰锥剑2201008、电闪雷鸣2201005；不能使用只有旧String文本的2201004。三条源技能导出完成，下一步接入原版技能窗口与服务器持有的已学等级，需先核对技能窗口源布局及学习/加点条件；d()已有WzComparerR2固定提交的向下取整解析依据（R类工具，见历史）；执行前仍核对魔法伤害/命中时点的同期证据，不能用动画delay推成服务端时序。
- 部署状态：角色职业归属代码与定向检查已完成，v0.4.5服务已启动，使用既有数据库正常迁移。
- 转职依赖：同版任务1402要求等级10、职业0、任务36307完成，NPC1032001/地图101000003；q1402s/e和冒险家q363执行脚本仍缺；汉斯快捷入口已按最新授权独立完成，不赠送满级技能。
- 装备对比与原版浮层已完成，验证证据移入IMPLEMENTATION_STATUS.md；用户实玩待验。只执行实际改动必要检查，无独立QA、在线账号探针或服务重启。

## 运行与完整剧情边界

- 运行前端版本 `v0.6.0 / protocol 6 / tms273-2`，入口 http://127.0.0.1:3010，数据统一使用 `shared/` 与 `client/public-tms273`。
- 用户要求不保留旧账户：旧三个数据库及本次备份已删除；新库 `server/data/tms273.sqlite3` 已创建，启动时账户数 0，需重新注册。今后正常启动不自动清库。
- 17 图、UI、角色/地图/怪物动画及数据装配已完成；成果和检查移入 IMPLEMENTATION_STATUS.md。
- 待完成：参考包缺失原版 `q363*`、`enter_maple`、`enter_20000` 等执行脚本；63 条任务仅保留源条件与文本并禁用执行，不能视作完整剧情复刻。需要补齐同版原版脚本及可靠的初始属性、等级经验规则；下一张业务卡从36301开始，确认实际脚本和奖励后接现有权威链。
- 现有基础移动/战斗为运行适配层；完整职业、技能、商城及真实聊天业务尚未复刻。
- 研究包对照与首轮输入修复已完成，证据见 IMPLEMENTATION_STATUS.md；当前前端静态产物已更新，聊天Q/空格、对话Esc、切图/断线输入释放待用户实玩。不开独立QA，不创建额外验收账号。
- 原陪测 bot 凭据缺失，未创建新账号；当前仅运行游戏服务。

## 后续里程碑：按研究包补齐现有实现

| 阶段 | 当前差距与下一步 | 负责人 / 输入依赖 | 通过目标 |
| --- | --- | --- | --- |
| M0 证据与规格 | 保留TMS273.7资源指纹；世界类型、热更、官方初始属性/经验与私服差异待核；图源ID与主报告ID分开引用 | root；273本地源、研究包和可核验同期材料 | 每个新增规则可区分原版、适配与未知；不倒灌83或后续版 |
| M1 手感 | 已有平台/梯绳/普攻/怪物；仍缺首职业完整技能行为、资源/CD、取消与多段时间轴 | Luna max业务；同版Skill/角色动作及行为证据，root协调协议 | 首职业法师→冰雷；群攻、位移和单体技能可重复执行，不仅播放动画 |
| M2 首章闭环 | 已有背包、换装与SQLite权威结算；63条任务禁用，q363与入图脚本仍缺 | Luna max业务；原版Check/Act/Say和对应脚本，root负责共享协议 | 接取→目标→领奖→成长→重登恢复；满包/断线可恢复，重复请求不重复奖励 |
| M3 现代成长 | 星力/潜能、V/HEXA、区域力量未实现；现有换装不足以替代这些机制 | root界定状态，Luna max实施；TMS准确规则与M2结算 | 装备与技能选择改变玩法；未知概率不投入经济 |
| M4 Boss验证 | 前置、练习、阶段行为与个人/共享奖励资格未实现 | Luna max业务；M1/M3与同版Boss证据 | 先一只验证躲招，再一只验证成长与爆发；练习不发正式奖励 |
| M5 扩展 | 第二职业、小队、账号成长待首个闭环可靠后执行 | root；M1–M4 | 复用现有权威链，以数据和必要新机制扩展 |

所有阶段保持现有用户亲测政策：实际改动做必要定向检查，不启动独立QA或覆盖在线数据库；尚未实玩的手感/图层/响应式标为待验。研究包39项backlog是范围参考，不代表已经执行或全部完成。

## 浏览器铺满游戏与枫之谷消息：已发布，待用户实玩（2026-09-08）

- 用户启动失败恢复时通过启动3010.command联合构建并发布：v0.6.1 / protocol7 / tms273-3，health通过，证据见IMPLEMENTATION_STATUS.md。
- 待用户实玩：刷新入图、尺寸切换、地图边缘与各业务窗口遮挡；首章完整业务验证仍归并行任务，不以启动成功代替。

## 初心者SP修复：已验证，待统一发布（2026-09-08）

- 修复与定向检查证据见IMPLEMENTATION_STATUS.md；当前两条lv2/job0旧角色各1SP将在新版首次入图自动补齐，重复登录不重复补发，在线库未改。
- 等三转任务统一通过根启动3010.command发布；用户待验SP余额与后续升级。初心者三技能学习/施放已由本轮v0.7.1接入。

## 初心者三技能：已完成验证，待启动加载（2026-09-08）

- v0.7.1/content5：嫩寶丟擲術、治癒、疾風之步已接学习/施放/效果/音效与冷却存档，真实32目录、后端/前端定向与离线生产构建通过；证据与P边界见IMPLEMENTATION_STATUS.md。
- 全部业务/导出文件释放，保留三转最后抗性和雷球修复；后续四转可接续。在线服务/角色库未动，下次运行根启动3010.command加载；用户待验K加点、初心者1/2/3及旧账号补点。

## 四转后续缺口

- v0.8.0/protocol8/content6普通四转运行基线已通过有限核心验证，结果见IMPLEMENTATION_STATUS.md；world/mage/auth/client与导出文件均释放。在线服务与dist未更新，用户待验实际画面和手感。
- 仍需完成原版四转剧情脚本、净化真实异常解除/拦截与三转元素适应异常入口、Hyper等级与点数规则，随后V/HEXA与现代成长依赖。不得把当前43目录当作全职业系统完成。
- 已保存ice-fourth-job-source.json与ice-fourth-job-transfer-source.json：本地任务/数值为T；Hans快捷入口、SP历史MSEA分档及执行时序为P，JMS冲突保留R。后续规则继续联网结合本地源，保留原剧情与存档。

## 区域/Boss练习：已验证，待用户实玩

- v0.9.0/protocol9/content7区域/Boss大模块开发与有限核心验证完成，证据见IMPLEMENTATION_STATUS.md；30图、P树妖王私有练习、存档map绑定/零奖励与客户端提示已交付。核心6文件、集中脚本507行，含宿主/签名增量不足550行；未发布在线，后续统一启动3010.command加载。
- 用户待验：实际地图行走与门户、Boss躲招/死亡恢复、源特效挂点/遮挡、宽屏/横屏/窄屏。正式Boss生成/奖励仍U，blocked2813–2816未开放；敌方玩家异常入口仍待接，不能当M4全部完成。
- world/boss/auth/combat/client与导出文件已释放；不重复运行通过的检查或重启在线服务。

## Hyper：编译与有限核心验证完成

- 当前源码v0.11.0/protocol10/content9：56技能目录（12可见Hyper、隐藏1055）、41图/5854assets、等级上限200。普通四转SP止140，Hyper复用skills/skill_actions、两池余额独立；reset tier仅专属SQL更新，不扩Profile。源与联网官方R依据、P执行边界见references/tms273-data/ice-hyper-source.json。
- 已实现九强化、1052长按三阶段/15段/50%减伤免击退、1053自身增伤、1054开关与1055无伤害范围漩涡、重置与死亡/转图/断线清理。P：1052初始30MP预付首pulse或提前末击、后pulse30MP、200ms节拍；普通结界2400ms/漩涡1200ms冻结；主动点手动投资，无免费满技能。
- 客户端复用已查看的273 Skill壳/BtHyper，Hyper专用布局缺失标P；已接两池页、报价重置、Shift9/Shift0、长按释放、原三段动作/循环音效/漩涡分层。敌方致命异常、队伍传播及末击Special可靠目标标记仍缺，不能宣称原作全部行为完成。
- 业务源码已冻结，用户启动恢复任务01a07fc8-2a7c-7fb2-ba2e-dab8e0344b08回传最终cargo build与前端独立生产build通过；在线dist/服务/库未动。不重复构建，出现实际失败才释放所属文件修复。
- 有限核心检查共预留7文件/≤1000行：auth/world两个测试include、hyper_store_acceptance.rs、hyper_acceptance.rs、check_tms273_runtime.cjs、check_tms273_hyper_ui.mjs、check_tms273_hyper_visuals.mjs。auth142行3项已通过；UI82行、表现121行及源85行已通过，修复320px纵向居中和1054重复Use。World175行3项已通过；合计7文件、核心脚本605行加2行include，共607行。不独立QA。
- root持有台账/协议与整合；quest_flow已释放world/mage，chapter_assets与quest_store业务文件均已释放。实际源素材挂点/时序、手感与地图实玩交用户，不重启或造在线验收账号。
- 下个R023大模块已按用户最新要求停止：quest_store只读研究已中断，V核心获取/装配/强化/战斗来源闭环转TODO。原完整转职/36315+、V/HEXA、现代装备/账号、后续Boss及研究包其余目标均保留，未触发冰雷完成彩蛋。


## 技能详情与快捷栏：已验证，待启动加载（2026-09-08）

- 详情加点图标拉伸遮挡已修复；273槽位背景接32格、当前18快捷映射、冷却/等级/禁用态、点击与长按施放/释放、折叠和窄屏重排。文件已释放，证据见IMPLEMENTATION_STATUS.md。
- 独立输出output/hud-ui-build已通过类型检查与生产构建；在线dist/服务/角色库未动，下次统一运行启动3010.command加载。用户待验真实游戏手感；完整改键、物品绑定与原版设置控件仍未实现，当前键位保持项目适配。

## 自然恢复永久被动：已验证，待启动加载（2026-09-08）

- Rust权威永久恢复及技能窗展示已完成，来源/规则边界和4项后端、前端有限检查证据见IMPLEMENTATION_STATUS.md；world恢复区、protocol.rs、shared/protocol.ts及技能窗文件均释放。
- 未重启服务或修改在线角色库；下次统一运行启动3010.command加载。用户待验每秒HP/MP变化、转职继承、K窗口永久被动说明与切图/死亡复活体验；不把职业恢复适配当作完整战士职业路线。

## 原剧情接续：已验证，待用户实玩

- v0.10.0/protocol9/content8原剧情接续执行模块完成开发与有限验证，证据见IMPLEMENTATION_STATUS.md；41图、15执行任务，九任务完整NPC/戴帽/交物链与原子存档已跑通。6文件，核心脚本736行、含宿主不足750；未发布在线。
- 原缺失演出/精确奖励与远程交通仍按P/U区分，不将任务适配当作原版过场1:1完成。完整36315+、原完整转职/礼盒、Hyper/V/HEXA与研究包其余目标继续；下一步优先核定Hyper大模块，保持当前角色和剧情进度。
- auth/world任务区/导出装配均释放；并行自然恢复亦已释放，保留其恢复字段/永久被动及已通过证据，不重复验证。用户待验行走/门户、NPC/帽子源层、提示与声音；启动统一根启动3010.command，不自动重启。

- Hyper生产编译已通过：启动恢复任务回传cargo build（7.78s，仅既有contact_damage未使用警告）及最终前端构建（5.18s，index-CSBIPrvv.js/index-CmB4sO2_.css，仅chunk预算警告）。业务源码已冻结，在线dist/服务/库未变；接下来只运行cfg(test)核心检查，出现实际失败才修复。

- Hyper auth核心3项已定向通过（cargo test hyper_store_，126测试中仅执行3项）；World3项也已通过；V核心准备已停止，剩余业务见顶部TODO。

## Windows 启停与资源交付：待 Windows 实机验收

- root已接续完成start/stop、README与资源ZIP；原Luna/max已落盘运行资源检查，续轮Luna/max负责有限只读核对。文件及校验结果见IMPLEMENTATION_STATUS.md。
- 资源包直接解压到start.bat所在根目录。Windows安装、真实启停、-SelfTest及浏览器运行待用户亲验；当前macOS无PowerShell，不以静态核对冒充实机通过。

## 当前用户地图调整（2026-09-09）：水域与木架踏板已完成，待用户实玩

- 范围：选择岔道001020000右侧跳上木架的中间平台；平面物理水（计划 `Web_TS_2D_Water_Development_Plan`）、游泳与水域边缘通行。用户指定P适配。
- 状态：地图几何、服务端游泳/入水/掉落漂浮、客户端水面模拟与水花浮力均已实现并通过定向检查（证据与P边界已移入IMPLEMENTATION_STATUS.md）。手感由用户实玩验收。
- 分工：root负责地图/装配/渲染与台账；Luna/max后端子代理只改 `server/src/world.rs` 与 `server/src/water_acceptance.rs`，不交叉写。共享地图字段由root通过 `scripts/tms273_split_road.cjs` 单一写入。
- 验收：后端 `cargo test --offline water_` 2项通过；前端 `tsc --noEmit`、`water.check.mjs`、`vite build` 通过。不重启服务、不改数据库、不启动独立QA。
- 待验（用户）：波浪/水花/漂浮姿态手感、踏板两跳上木架、岸→水→岸通行与游泳拾取；游泳沿用jump pose（当前头像契约无swim动作）。

## 魔力波動缺陷修复（2026-09-10）：已改完并重启服务，待用户实玩

- 需求：发动魔力波動时往上位移为普通跳的 1.5 倍，并按源 v=95 px/s 做明显的缓慢下降。
- 状态：已改 `server/src/world.rs` 并通过定向测试，3010 已用新二进制重启；证据与P边界见 IMPLEMENTATION_STATUS.md 同名条目。
- 待验（用户）：上升高度与缓降观感；不够明显就调 `MAGIC_WAVE_LAUNCH_HEIGHT_RATIO` 与 `MAGIC_WAVE_SLOW_FALL_SPEED`。
