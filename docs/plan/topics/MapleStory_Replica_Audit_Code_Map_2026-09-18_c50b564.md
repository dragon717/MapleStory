# MapleStory TMS273：复刻进度、功能目录与代码落点

> 核查日期：2026-09-18。固定分支 `main`，提交 `c50b5647a9a57fb00cd4947559d41eb5b694885f`；协议 `24`，内容 `tms273-31`。[E00] [E01]
> 本轮重点：专业采集／制作／分解、坐骑／椅子、狩猎符文／连击／精英事件、成就／称号，并额外区分勋章与徽章装备。
> 不以地图、怪物模板、道具条目等重复内容数量计算进度；管理员定制与原创世界机制不作为原版缺失项。

**总判断：基础玩法主干已形成，但主线、现代成长、正式多人内容与玩家经济尚未完整贯通。本轮重点项中，普通 Reactor、坐骑装备槽、勋章／徽章装备有可复用基础；其余所列专属玩法未接入。**

## 0. 口径与核查范围

“主干已实现／基础已实现”只指表中限定链路已有源码实现，不代表整个原作系统 1:1 完成或当前运行版本已经验收。“未接入”指当前生产入口、状态与结算链未形成该玩法，**不等于仓库或本机完全没有相关素材、文本、草案或测试夹具**。没有统一的原版功能分母，本报告不编造总百分比。

本轮通过 GitHub 固定提交读取菜单路由、协议、物品使用事务、装备映射、技能白名单、NPC DSL、击杀结算、世界状态、建表迁移与相关模块；并核对上一轮提交到本提交的差异。未启动游戏、未运行 Cargo／浏览器验收，也未访问用户在线库。GitHub 代码检索返回 502，故改用关键生产路径逐段核查；没有声称完成全仓关键词穷举或全部原始资源盘点。非重点模块在上一轮审阅基础上核对提交差异，不冒充本轮全部重测。[E38]

表中路径均相对仓库根目录：`F/`＝`client/src/features/`；`B/`＝`server/src/`；`A/`＝`server/src/auth/`；`D/`＝`shared/`。**建议位置不是现有实现，也未在本轮创建；仅在对应子功能立项时增建。** ★ 为本轮重点核查。

## 1. 总进度与代码位置表

| 编号 | 大模块 | 当前进度 | 子模块进度／边界 | 已有位置 | 未接入部分建议落点 | 证据 |
|---|---|---|---|---|---|---|
| 01 | 账号与角色 | 主干已实现 | 注册登录、多角色创建／选择、外观与当前装备预览；仅单频道，删角／改名未接入。 | `F/entry/`；`B/network.rs`、`auth.rs`、`lobby.rs` | 删角／改名优先扩 `lobby.rs` 与 `F/entry/`，不另造角色服务。 | [E18] [E15] [E01] |
| 02 | 界面与纸娃娃 | 主干已实现 | HUD、常用窗口、换装、键位与快捷栏已接入；未路由的原版菜单仍显示未实装。 | `F/hud/`、`player/`、`keybindings/`、`menu/`；`client/src/app/main.ts` | 按实际功能接菜单；不要把菜单美术算成系统完成。 | [E15] [E02] [E35] |
| 03 | 移动与碰撞 | 主干已实现 | 行走、跳跃、下跳、爬绳、游泳、墙体碰撞与坠落恢复；完整原版手感未实玩核验。 | `F/player/`；`B/movement.rs`、`geometry.rs` | 复用现有移动链；缺陷定向修复。 | [E30] [E40] |
| 04 | 战斗与怪物 | 主干已实现 | 普攻／技能命中、受击、仇恨、刷新、部分怪物技能；不是全怪物 AI 完整复刻。 | `F/combat/`；`B/combat.rs`、`attacks.rs`、`skills.rs`、`elemental.rs`、`monsters.rs` | 新规则按职责扩现有模块；特殊事件见 30—33。 | [E08] [E10] [E11] |
| 05 | 掉落与拾取 | 主干已实现 | 掉落、归属保护、手动／宠物拾取、奖励认领与入包；目录数量不计进度。 | `B/inventory_ops.rs`、`pickup_rules.rs`、`monsters.rs`；`A/loot.rs` | 扩奖励来源时复用资产事务与 `A/notebook.rs` 留档。 | [E05] [E09] [E11] [E16] |
| 06 | 死亡与复活 | 基础已实现 | 死亡、惩罚、复活落点、状态恢复、去重；不含原创墓碑留存／虚影演化。 | `F/notice/death.ts`；`B/combat.rs`、`revive.rs` | 原创扩展另立项，不计入原版缺口。 | [E29] [E15] |
| 07 | 职业与技能成长 | 部分实现 | 经验、AP／SP、初心者→法师→冰雷四转及部分 Hyper；其他职业未接入。 | `F/skills/`；`B/mage.rs`、`growth.rs`、`skills.rs`、`elemental.rs`；`D/mage-skills.json` | 先选一个新职业；确有独立规则再增 `B/<职业域>.rs`。 | [E08] [E20] [E19] |
| 08 | 属性、Buff、异常状态 | 部分实现 | 属性聚合、伤害修正、Buff 生命周期和五类疾病已接入；黑暗、虚弱、诱惑、尸化、禁药等未建模。 | `B/attribute.rs`、`damage.rs`、`derived.rs`、`player_status.rs`；`F/hud/buff-bar.ts` | 在现有属性／状态权威内补规则，不再维护第二套面板算法。 | [E21] [E22] [E40] |
| 09 | NPC 与对话 | 部分实现 | 点击、原文分页、任务菜单、商店／仓库／转职／部分传送；完整脚本能力未覆盖。 | `F/npc/`；`B/npc.rs`、`dialogue.rs`；`D/npc-dialogue.json`、`npc-scripts.json` | 按真实动作扩 DSL 或专属职能，不能只补台词。 | [E13] [E15] [E33] |
| 10 | 任务与剧情 | 部分实现 | 接交、前置、持有／装备／击杀目标、事务奖励、日志追踪；通用脚本计数、完整过场和后续主线仍有缺口。 | `F/quest/`；`B/quest.rs`、`quest_rules.rs`、`quest_text.rs`；`A/quests.rs` | 需要场景执行时增 `B/quest_scene.rs`，进度仍归任务域。 | [E19] [E09] [E33] |
| 11 | 交通与旅行 | 部分实现 | 传送门、回城卷、计程车、飞船与巴洛古袭击已接入；票务／航程部分为项目适配。 | `B/portals.rs`、`ship.rs`、`ship_event.rs`、`dialogue.rs`、`inventory_ops.rs` | 复用交通与事件模块；已有袭击不能冒充精英事件。 | [E31] [E32] [E05] |
| 12 | 背包与道具 | 主干已实现 | 分栏、堆叠、拖动、整理、丢弃、扩容、药水／卷轴；设置栏存在但椅子使用未接入。 | `F/inventory/`；`B/inventory.rs`、`inventory_ops.rs`；`A/bag.rs`、`item_world.rs` | 特殊道具按行为分派；不要在通用使用函数堆所有玩法。 | [E04] [E05] [E17] [E35] [E36] |
| 13 | 装备与卷轴强化 | 部分实现 | 穿脱、准入校验、实例属性、卷轴概率／次数；星力、潜能、附加潜能、方块未接入。 | `F/inventory/`；`B/inventory.rs`；`A/bag.rs` | `F/enhancement/`；`B/enhancement.rs`；`A/enhancement.rs`；保留现有装备实例。 | [E03] [E04] [E17] [E01] |
| 14 | NPC 商店与仓库 | 基础已实现 | 买卖赎回、物品／金币存取与事务；复杂实例全路径保真仍需核验。 | `F/world/storage-view.ts`、`F/npc/`；`B/trade.rs`；`A/shop.rs` | 优先修现有往返链；不新建重复库存。 | [E23] [E12] [E15] |
| 15 | 现金商城 | 部分实现 | 展示试穿、购买、限购、租赁及购买持久去重；赠送、愿望单、里程、兑换券、退款未接入。 | `F/cashshop/`；`B/cashshop.rs`；`A/cash.rs` | 按子功能扩现有商城；真实支付另立项。 | [E24] [E15] |
| 16 | 玩家交易 | 未接入 | NPC 交易已做；玩家双边锁定、确认、资产交换未形成流程。 | 可复用 `B/inventory.rs`、`A/item_world.rs`；不是 `B/trade.rs` 已完成 | `F/player-trade/`；`B/player_trade.rs`；`A/player_trade.rs`。 | [E23] [E36] [E01] [E33] |
| 17 | 拍卖／寄售 | 未接入 | 无挂牌、撤单、成交与领取流程。 | 可复用物品和货币事务；无已接入市场模块 | `F/auction/`；`B/auction.rs`；`A/auction.rs`。 | [E01] [E12] [E33] |
| 18 | 邮件 | 未接入 | 无收发件、附件托管与领取流程。 | 可复用物品事务；无已接入邮件模块 | `F/mail/`；`B/mail.rs`；`A/mail.rs`；附件领取须复用入包与图鉴留档。 | [E01] [E12] [E33] |
| 19 | 组队与好友 | 部分实现 | 组队生命周期、同图经验共享、好友／黑名单已接入；队伍按现行设计不跨重启保存。 | `F/world/party-view.ts`、`friend-view.ts`；`B/social.rs`；`A/loot.rs` | 复用成员与经验规则；正式组队目标见 22。 | [E25] [E09] [E15] |
| 20 | 公会与联盟 | 未接入 | 无完整创建、成员权限、公会存档及联盟流程。 | 已有社交、认证与消息基础；不是公会实现 | `F/guild/`；`B/guild.rs`；`A/guild.rs`；联盟等有实际需求再扩。 | [E01] [E12] [E25] |
| 21 | 聊天 | 部分实现 | 地图公聊、密语、表情、限流与屏蔽；队伍／公会频道、跨频道／跨服与离线投递未接入。 | `F/chat/`；`B/messaging.rs`、`gm.rs` | 先扩 `messaging.rs` 的频道授权；真实跨节点时再建消息路由模块。 | [E26] [E01] |
| 22 | Boss 与副本 | 部分实现 | 单人练习、Boss 行为、胜败／离开／重试；正式奖励／次数和原版组队通关链未完成。 | `B/boss.rs`、`monsters.rs`；`F/combat/`；协议 `BossPractice` | 先在 `B/boss.rs` 扩正式模式，奖励／资格增 `A/boss.rs`；实例共性出现后再抽取。 | [E27] [E01] [E33] |
| 23 | 宠物 | 部分实现 | 三宠、跟随、拾取、喂食、饱足度、亲密度、等级与寿命；生命水复活未接入，装备／命令／自动补药本轮未专项核实。 | `F/pet/`；`B/pets.rs`、`pet_motion.rs`、`inventory.rs`；`A/bag.rs` | 优先扩宠物现有入口；未专项核实项不要直接当作空白重写。 | [E28] [E17] [E04] |
| 24 | 冒险笔记／图鉴 | 部分实现 | 物品获得留档、四页窗口与查询已接入；怪物登记、收藏奖励／勋章、探险仍被阻塞。 | `F/notebook/`；`B/notebook.rs`；`A/notebook.rs`；`D/notebook-catalog.json`、`monster-collection-rules.json` | 继续 NB-06／08；复用当前事实与查询，不新造图鉴。 | [E14] [E16] [E33] |
| 25 | 五／六转与高阶成长 | 未接入 | 已有 Hyper 技能；不等于 Hyper 属性、V 矩阵、HEXA 或成长符号。 | 可复用 `B/growth.rs`、`attribute.rs`、`A` 事务；无这些系统的完整操作链 | 按立项分别增 `B/hyper_stats.rs`、`v_matrix.rs`、`hexa.rs`、`symbols.rs` 与对应 `F/`、`A/`。 | [E20] [E21] [E01] [E33] |
| 26 | 账号横向成长 | 未接入 | 多角色已做；战地联盟、传授技能未形成账号成长链。 | `B/lobby.rs` 的账号／角色关系 | `F/account-growth/`；`B/account_growth.rs`；`A/account_growth.rs`。 | [E18] [E01] [E12] |
| 27 | 普通采集物／Reactor ★ | 基础已实现 | 攻击／区域交互、状态推进、耗尽、刷新、部分掉落；不是专业采集。 | `B/world.rs` 的 Reactor 状态与处理；`B/monsters.rs::roll_drop_specs`；`client/src/scenes/world.ts` | 复用原链；若专业采集确需共享，再将现有 Reactor 职责抽为 `B/reactors.rs`，不是从零重做。 | [E06] [E11] [E01] |
| 28 | 专业采集 ★ | 未接入 | 采药／采矿的专业学习、资格、采集过程与熟练度未接入；已有普通 Reactor 底座。 | 复用 27、`B/npc.rs`、`A/bag.rs`；无专业运行链 | `F/profession/`；`B/profession.rs`、`harvesting.rs`；`A/profession.rs`；`D/professions.json`。 | [E06] [E07] [E12] [E13] |
| 29 | 制作／炼金／分解 ★ | 未接入 | 无专业配方执行、材料与产物结算、制造成长、装备分解链；商店买卖和卷轴不是制作。 | 复用 `B/inventory.rs`、`A/item_world.rs`、`A/notebook.rs`；现有 NPC DSL 不提供这些专属动作 | 沿用 28 的专业域；增 `B/crafting.rs`、`D/recipes.json`；事务先放 `A/profession.rs`。 | [E04] [E07] [E12] [E13] [E16] |
| 30 | 坐骑 ★ | 仅装备层基础 | 已有 `Tm/Sd → -18/-19` 槽映射；骑乘切换、骑乘状态、移动与骑乘表现未接入。 | `B/inventory.rs::equipment_slot`；`A/bag.rs`；`F/inventory/` | `F/mounts/`；`B/mounts.rs`；`D/mounts.json`；既有物品持有／穿脱不重写。 | [E03] [E04] [E07] [E08] [E01] |
| 31 | 椅子／坐下 ★ | 未接入 | 设置栏可容纳道具；当前通用使用拒绝该栏，角色动作无坐姿；没有可用坐椅链。 | `F/inventory/`；`B/inventory_ops.rs`；`A/bag.rs`；`F/player/` | `F/chairs/`；`B/chairs.rs`；`D/chairs.json`；持有复用背包，坐姿先作会话状态。 | [E01] [E04] [E05] [E35] |
| 32 | 狩猎符文 ★ | 未接入 | 未见地图生成、交互／解谜、资格冷却、效果授予与结束链；不指五／六转成长符号。 | 可复用地图几何、交互和 `B/player_status.rs`；不是现有技能 Buff 已覆盖 | `F/runes/`；`B/runes.rs`；`D/runes.json`；需持久冷却／认领时再增 `A/runes.rs`。 | [E01] [E07] [E08] [E22] |
| 33 | 狩猎连击／多杀 ★ | 未接入 | 已有击杀事实、任务击杀计数与技能叠层；没有狩猎连击计时、多杀归并及专属收益反馈。 | `B/attacks.rs`、`skills.rs`；`A/loot.rs::resolve_attack_with_party` | `B/hunting.rs`；`F/hunting/`；`D/hunting.json`；统一接普攻与技能的已提交击杀，不只改普攻。 | [E07] [E09] [E10] [E01] |
| 34 | 精英怪／精英 Boss 事件 ★ | 未接入 | 无精英生成条件、事件状态、专属规则与结束奖励链；普通 Boss 标志、练习和飞船袭击不算。 | `B/monsters.rs`、`boss.rs`、`ship_event.rs` 可复用部分基础 | `B/elite.rs`；`F/elite/`；`D/elite.json`；发奖接 `A/loot.rs`，不复制掉落系统。 | [E07] [E11] [E27] [E32] |
| 35 | 成就 ★ | 未接入 | 已有任务、击杀和获得记录；无独立成就条件聚合、完成状态、奖励认领与成就窗口。 | `A/loot.rs`、`quests.rs`、`notebook.rs` 是事实来源；不是成就系统 | `F/achievements/`；`B/achievements.rs`；`A/achievements.rs`；`D/achievements.json`。 | [E02] [E07] [E12] [E14] |
| 36 | 称号 ★ | 未接入 | 无称号解锁、选择／卸下、到期与头顶展示链；普通角色名字不是称号。 | `F/player/`；`B/attribute.rs`；可复用物品／任务事实 | `F/titles/`；`B/titles.rs`；`A/titles.rs`；`D/titles.json`。 | [E01] [E02] [E07] [E12] |
| 37 | 勋章／徽章装备 ★ | 仅装备层基础 | `Me → -49`、`Ba/Be → -50` 已有映射及通用穿脱／属性通道；不代表获取、收藏、重发系统完成。 | `B/inventory.rs`；`A/bag.rs`；`F/inventory/`；图鉴奖励另在 `B/notebook.rs` | 穿戴复用原链；专属获取／重发需要时增 `B/medals.rs`、`A/medals.rs`、`F/medals/`。 | [E03] [E04] [E17] [E14] |
| 38 | 联机与会话 | 主干已实现 | 权威同步、重连、后台保留／驻留、运动插值；本地预测未实现，不等于已支持跨服。 | `B/network.rs`、`commands.rs`、`world.rs`；`client/src/network/`；`F/net-motion/` | 优先验现有会话边界；跨节点另立项。 | [E07] [E33] [E40] |
| 39 | Web 与桌面交付 | 部分实现 | 源码开发入口、缓存、按需加载、强制更新、Tauri 外壳；模块安全热替换、Three.js 接入和桌面完整交付未完成。 | `client/vite.config.ts`、`client/src/assets/`、`F/client-actions/`、`client/src-tauri/`；`B/client_delivery.rs`；`scripts/` | 继续现有交付计划；先修桌面资源来源／部署与打包验收，不另写游戏前端。 | [E33] [E15] |
| 40 | GM 与运营基础 | 部分实现 | 本地 GM 命令含 `/add`、`/cash`、`/exp`；不等于正式权限与运营审计体系。 | `B/gm.rs`、`messaging.rs`；`A/schema.rs` | 公开部署前另定授权；需要时增 `A/permissions.rs`、`A/audit.rs`，保留现有本地政策。 | [E37] [E38] [E26] [E12] |

## 2. 本轮重点判定依据

### 2.1 普通采集物有机制，专业采集没有完整流程

`ReactorPlacement` 明确持有交互类型、状态数、刷新时间与掉落表；`ReactorInstance` 持有当前状态和刷新截止点，掉落复用 `roll_drop_specs`。因此“所有采集都没做”不准确。但现有专业学习／资格／熟练度、配方与生产状态没有接入当前世界、协议和存档；NPC 对话及任务发物品不能代替专业系统。[E06] [E11] [E07] [E12] [E13]

### 2.2 制作、炼金、分解不能由“能扣材料、能发道具”推定完成

通用背包事务提供的是原语；当前实际使用分支主要为装备穿脱、扩容、回复、卷轴与传送，宠物另行分派。未见配方选择→资格／材料判定→生产结果→熟练度／产物持久化的专属链，也没有装备分解结果结算。它们应列“未接入”，但后续必须复用已有背包和获得留档。[E04] [E05] [E12] [E16]

### 2.3 坐骑与椅子的缺口不同

坐骑已有 `Tm/Sd` 装备槽映射及通用穿脱路径；这只证明装备层兼容，不证明骑乘。当前角色动作／状态和可施放技能没有形成骑乘链。椅子则连设置栏使用分支也未接入：非装备、非消耗品在持久化使用函数中落入 `InvalidInventoryType`，角色动作集合没有坐姿。不能把纸娃娃可能存在的坐姿素材、设置栏图标算成玩家能坐下。[E03] [E04] [E05] [E07] [E08] [E01]

### 2.4 狩猎连击／多杀不是技能叠层或任务击杀计数

当前确认的击杀事务负责怪物奖励唯一认领、贡献／组队经验、任务击杀计数与掉落，提交后返回结果；`mystic_strike_stacks` 属技能运行状态。未见狩猎连击持续窗口、多杀按一次攻击／施法归并、相应奖励与反馈链。后续挂点应覆盖普攻和技能，不可只在 `attacks.rs` 的普攻路径加计数。[E09] [E10] [E07]

### 2.5 狩猎符文、精英事件与已有战斗基础必须分开

当前 `World`、`Player`、`Monster` 状态没有狩猎符文／精英事件的完整生命周期；普通怪生成、`boss` 标志与 Boss 练习不是精英生成规则。飞船巴洛古袭击已经有独立事件模块，因此“随机／特殊事件全没做”也不准确；它只能计入交通事件，不计入精英事件进度。[E07] [E11] [E27] [E32]

### 2.6 勋章／徽章装备不是成就或称号系统

`Me → -49`、`Ba/Be → -50` 已接通装备映射，目录可识别且满足条件的物品可走通用穿脱与属性通道。尚不能据此证明全部勋章可获取、可收藏或可重发。成就／称号没有独立完成、领取、选择与展示链；图鉴的奖励／勋章操作仍明确拒绝。物品首次获得表也不是成就完成表。[E03] [E04] [E17] [E02] [E12] [E14]

## 3. 复刻功能目录

以下是功能分类，不是要求新建同名代码文件夹。编号对应上表；同类内容扩充不重复计一个系统。

```text
冒险岛复刻
├─ 入口与操作
│  ├─ 01 账号／角色：登录、创建、选择、外观
│  ├─ 02 界面／纸娃娃：HUD、窗口、键位、快捷栏
│  └─ 03 移动：走跳、下跳、攀爬、游泳、碰撞
├─ 核心战斗
│  ├─ 04 战斗／怪物：攻击、技能、受击、AI、刷新
│  ├─ 05 掉落／拾取：归属、入包、奖励认领
│  ├─ 06 死亡／复活
│  ├─ 07 职业／技能：转职、AP、SP、Hyper 技能
│  └─ 08 属性／状态：聚合、伤害、Buff、疾病
├─ 冒险推进
│  ├─ 09 NPC：台词、脚本、职能
│  ├─ 10 任务：前置、进度、奖励、追踪、场景执行
│  ├─ 11 交通：传送、卷轴、计程车、飞船／袭击
│  └─ 22 Boss／副本：练习、正式、组队、资格与奖励
├─ 物品与经济
│  ├─ 12 背包／道具：容器、使用、丢弃、整理
│  ├─ 13 装备／强化：穿脱、卷轴、现代强化
│  ├─ 14 NPC 商店／仓库
│  ├─ 15 现金商城
│  ├─ 16 玩家交易
│  ├─ 17 拍卖／寄售
│  └─ 18 邮件／附件
├─ 多人与社交
│  ├─ 19 组队／好友／黑名单
│  ├─ 20 公会／联盟
│  └─ 21 聊天／频道／跨域投递
├─ 收集与长期成长
│  ├─ 23 宠物
│  ├─ 24 冒险笔记：怪物、装备、道具、已获得任务道具
│  ├─ 25 高阶成长：Hyper 属性、V、HEXA、成长符号
│  └─ 26 账号成长：战地联盟、传授技能
├─ 生活生产【本轮重点】
│  ├─ 27 普通 Reactor：交互、耗尽、刷新、掉落
│  ├─ 28 专业采集：专业学习、采药、采矿、熟练度
│  └─ 29 制作／炼金／分解：配方、材料、产物、进度
├─ 休闲与装饰【本轮重点】
│  ├─ 30 坐骑：装备基础、解锁／骑乘、移动、表现
│  └─ 31 椅子：使用、坐下／起立、受击与离图处理
├─ 狩猎扩展【本轮重点】
│  ├─ 32 狩猎符文：生成、交互、效果、冷却
│  ├─ 33 连击／多杀：计数、窗口、归并、收益反馈
│  └─ 34 精英事件：触发、生成、结束、奖励
├─ 荣誉记录【本轮重点】
│  ├─ 35 成就：条件、进度、完成、奖励
│  ├─ 36 称号：解锁、选择、展示、期限
│  └─ 37 勋章／徽章：装备、获取、收藏／重发
└─ 工程支撑
   ├─ 38 联机／会话／插值
   ├─ 39 Web／缓存／更新／桌面交付
   └─ 40 GM／权限／运营审计
```

## 4. 代码目录：现有骨架与重点新增位置

`[现有]`＝已读取的实现／约定入口；`[建议]`＝未接入部分的推荐位置；`[条件]`＝确有需求才新增。全量模块的已有路径见第 1 节，本树只展开共享骨架和重点落点。

```text
client/src/
├─ app/main.ts                         [现有] 窗口组装、消息与交互路由
├─ assets/                             [现有] 资源地址解析、缓存、按需纹理
├─ scenes/world.ts                     [现有] 世界显示、Reactor 等交互
└─ features/
   ├─ menu/                            [现有] 菜单只接真正可执行功能
   ├─ player/                          [现有] 输入、角色表现
   ├─ inventory/                       [现有] 容器、穿脱、通用道具入口
   ├─ notebook/                        [现有] 物品记录、收藏查询
   ├─ profession/                      [建议] 专业、配方、采集／生产反馈
   ├─ mounts/                          [建议] 骑乘操作与表现
   ├─ chairs/                          [建议] 椅子表现与坐起反馈
   ├─ runes/                           [建议] 符文交互与效果表现
   ├─ hunting/                         [建议] 连击／多杀反馈
   ├─ elite/                           [建议] 精英事件提示与表现
   ├─ achievements/                    [建议] 成就查询与领奖
   ├─ titles/                          [建议] 称号选择与展示
   └─ medals/                          [条件] 专属收藏／重发窗口

server/src/
├─ main.rs                             [现有] 加载、校验与启动组装
├─ protocol.rs                         [现有] Rust 消息契约
├─ commands.rs                         [现有] 玩家意图分派
├─ world.rs                            [现有] 权威状态与顺序 tick；少量接线
├─ inventory.rs / inventory_ops.rs     [现有] 容器规则／物品意图
├─ attacks.rs / skills.rs              [现有] 普攻／技能执行
├─ monsters.rs                         [现有] 怪物与掉落通道
├─ attribute.rs / player_status.rs     [现有] 属性与限时状态权威
├─ npc.rs / dialogue.rs                [现有] NPC DSL／职能入口
├─ notebook.rs                         [现有] 目录与私有查询
├─ auth.rs                             [现有] Store／认证及子模块挂载
├─ profession.rs                       [建议] 专业学习、资格、成长规则
├─ harvesting.rs                       [建议] 专业采集的过程与结果
├─ crafting.rs                         [建议] 制作、炼金、分解规则
├─ reactors.rs                         [条件] 抽出现有 Reactor 职责；非新造系统
├─ mounts.rs / chairs.rs                [建议] 骑乘／坐姿运行状态
├─ runes.rs                            [建议] 符文生命周期
├─ hunting.rs                          [建议] 狩猎连击／多杀
├─ elite.rs                            [建议] 精英事件调度
├─ achievements.rs / titles.rs         [建议] 成就／称号规则与意图
├─ medals.rs                           [条件] 勋章专属领取／重发
└─ auth/
   ├─ schema.rs                        [现有] 统一建表与迁移
   ├─ bag.rs / item_world.rs           [现有] 物品事务／位置与容器契约
   ├─ loot.rs / quests.rs              [现有] 击杀／任务事务
   ├─ notebook.rs                     [现有] 物品首次获得留档
   ├─ profession.rs                   [建议] 专业进度、材料／产物同事务
   ├─ achievements.rs / titles.rs     [建议] 成就完成／认领、称号所有权
   ├─ runes.rs                        [条件] 持久冷却／认领，不存无须持久化的动画
   └─ medals.rs                       [条件] 领取／重发回执；装备仍归原链

shared/
├─ protocol.ts                         [现有] TS 消息契约，与 Rust 同步
├─ gameplay.json / items.json          [现有] 已装配玩法／物品数据
├─ maps.json / mage-skills.json        [现有] 地图／当前技能数据
├─ notebook-catalog.json               [现有] 图鉴目录
├─ monster-collection-rules.json       [现有] 未核定规则明确阻塞
├─ professions.json / recipes.json    [建议] 专业、配方；分类用数据，不每配方一个函数
├─ mounts.json / chairs.json           [建议] 坐骑／椅子目录
├─ runes.json / hunting.json           [建议] 狩猎扩展规则
├─ elite.json                          [建议] 精英事件规则
└─ achievements.json / titles.json    [建议] 条件、展示与授予配置
```

不为椅子单独复制背包表，不为勋章再造装备表，不为每一种采集物／配方建立业务类。新代码按既有 `world.rs` 子模块方式挂载；数据库写入留在 `auth/`，不要让前端或网络层直接改变世界。[E34] [E40]

### 4.1 复刻计划文档的目录

```text
docs/plan/
├─ PLAN.md                             [现有] 唯一当前任务状态入口
├─ INDEX.md                            [现有] 历史索引
├─ topics/                             [现有] 有效专题方案
│  ├─ MapleStory_Replica_Audit_Code_Map_2026-09-18_c50b564.md
│  │                                    [建议归档] 本报告，作为固定审计快照
│  ├─ MapleStory_Profession_Replication.md [建议] 专业采集／制作／分解
│  ├─ MapleStory_Mounts_Chairs.md          [建议] 坐骑／椅子
│  ├─ MapleStory_Hunting_Expansion.md     [建议] 符文／连击／多杀／精英
│  └─ MapleStory_Achievements_Titles.md   [建议] 成就／称号／勋章边界
└─ history/YYYY-MM-DD/                  [现有规范] 按实际任务归档结果
```

本报告是固定提交的审计快照，不另维护第二份滚动任务状态；真正立项后只在 `PLAN.md` 登记状态并链接专题。目录建议不等于已经写入 GitHub。[E34]

## 5. 接入时必须保留的边界

**资产与进度：** 采集、制作、分解、成就奖励要复用既有资产事务；材料扣除、产物／奖励与请求回执同事务。产物获得接 `A/notebook.rs`；资产事务失败不能先更新世界或回成功。不要把普通商店现有内存去重当作通用跨崩溃保障。[E09] [E16] [E23] [E34]

**统一事实：** 狩猎扩展消费服务端已确认击杀，区分击杀者、贡献者、队友；普攻、技能、多段、召唤与重放的边界需在实现时逐项覆盖。不能让客户端上报连击数、多杀数、奖励金额或“已完成成就”。[E09] [E10] [E34]

**状态与表现：** 坐姿、骑乘、符文状态由服务端持有，明确移动、受击、死亡、换图、重连如何结束。新 Buff 来源要进入明确的状态／属性口径，不把非技能效果随意塞进法师技能目录。前端新素材沿用资源地址解析与按需加载，避免绕过桌面资源来源。[E07] [E21] [E22] [E33]

**同版与实施：** 先核定 TMS273 规则与素材来源；缺原版规则就标未核定，不编概率、时长或资格。保持现有 Rust 权威世界＋Phaser 前端，不因新增这些系统强制引入 ECS、微服务或迁移 Three.js。不清库、不重启用户服务；仅执行实际改动必要的定向检查，实玩另记。[E34]

## 6. 证据索引

所有链接固定到本报告提交。源码证据用于判断接线与规则；`PLAN.md` 中的历史通过记录不算本轮重新执行。

[E00]: https://github.com/dragon717/MapleStory/commit/c50b5647a9a57fb00cd4947559d41eb5b694885f "固定提交"
[E01]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/shared/protocol.ts "前后端协议、角色动作与客户端意图"
[E02]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/client/src/features/menu/view.ts#L330-L355 "菜单实际路由及“尚未实装”分支"
[E03]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/inventory.rs#L760-L850 "装备槽映射：Tm/Sd、Me、Ba/Be"
[E04]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/auth/bag.rs#L575-L779 "持久化道具使用：装备、消耗品与拒绝分支"
[E05]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/inventory_ops.rs#L1000-L1310 "世界侧道具使用与宠物分流"
[E06]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/world.rs#L540-L645 "Reactor 放置、状态、刷新及掉落契约"
[E07]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/world.rs#L1380-L1980 "当前 Player、Monster 与 World 运行状态"
[E08]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/skills.rs#L1-L200 "技能实际施放白名单"
[E09]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/auth/loot.rs#L100-L380 "击杀认领、经验分账、任务计数与掉落事务"
[E10]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/attacks.rs#L1-L380 "普通攻击结算与击杀后处理"
[E11]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/monsters.rs#L130-L445 "怪物生成、掉落、技能执行"
[E12]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/auth/schema.rs "完整建表与迁移入口"
[E13]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/npc.rs#L1-L300 "NPC DSL 类型、条件与可表达动作"
[E14]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/notebook.rs#L1-L100 "图鉴查询与登记／奖励／探险阻塞"
[E15]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/client/src/app/main.ts#L1-L270 "客户端实际组装与功能窗口入口"
[E16]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/auth/notebook.rs "物品授予留档与图鉴事实"
[E17]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/inventory.rs "物品实例属性与限时堆叠规则"
[E18]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/lobby.rs "角色列表、创建与选择"
[E19]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/quest.rs "任务目标、推进与奖励"
[E20]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/growth.rs "成长：AP、技能与 Hyper 重置"
[E21]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/attribute.rs "属性聚合"
[E22]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/player_status.rs#L1-L200 "限时状态与尚未建模疾病"
[E23]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/trade.rs "NPC 商店与仓库"
[E24]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/cashshop.rs#L1-L200 "商城购买、限购、租赁与显式缺口"
[E25]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/social.rs "组队、好友、黑名单"
[E26]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/messaging.rs "地图聊天、密语与表情"
[E27]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/boss.rs "Boss 练习模式"
[E28]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/pets.rs "宠物运行、拾取与成长"
[E29]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/revive.rs "死亡复活"
[E30]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/movement.rs "移动、碰撞与游泳"
[E31]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/ship.rs "飞船航线"
[E32]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/ship_event.rs#L1-L105 "飞船巴洛古袭击：独立于精英事件"
[E33]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/docs/plan/PLAN.md "当前计划及交付边界；含缓存、桌面、插值"
[E34]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/docs/technical/BUSINESS_DEVELOPMENT.md "长期架构、目录与实施约束"
[E35]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/client/src/features/inventory/view.ts#L1-L230 "已有背包窗口、拖动及装备窗口组装"
[E36]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/auth/item_world.rs "物品位置／容器动作基础"
[E37]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/gm.rs "当前 GM 命令"
[E38]: https://github.com/dragon717/MapleStory/compare/fca871bd430561ae5dd681c94cde3c0ce34c2c9b...c50b5647a9a57fb00cd4947559d41eb5b694885f "同上轮提交的差异"
[E39]: https://github.com/dragon717/MapleStory/tree/c50b5647a9a57fb00cd4947559d41eb5b694885f/shared "当前 shared 目录"
[E40]: https://github.com/dragon717/MapleStory/blob/c50b5647a9a57fb00cd4947559d41eb5b694885f/server/src/world.rs#L1-L180 "世界模块注册"

---

文档交付范围：本地 Markdown 文件；未修改仓库代码、计划文件、运行服务或数据库。
