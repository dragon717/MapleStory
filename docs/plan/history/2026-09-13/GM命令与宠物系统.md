# GM 命令系统与宠物系统（TMS273）

日期：2026-09-13。内容版本 `tms273-13` → `tms273-14`，协议 `15` → `16`。

## GM 命令系统

- 入口：聊天框输入以 `/` 开头的文本，客户端原样作为 `chatSend` 发出；服务端 `World::handle_chat`（messaging.rs）在文本策略/幂等/限流**之前**截获，命令文本永不进入地图聊天广播。
- 实现：`server/src/gm.rs`（world 子模块），反馈走专用 `gmResult` 消息，**只发给命令发起者**。
- `/add <道具id> <数量>`：
  - 数量缺省为 1，上限 999；道具身份按「目录 + 宠物目录 + 百万位段回退」解析，宠物道具（5000000+）同样可发。
  - 叠加规则与全服一致：叠加物先填满堆再开新堆；装备/宠物每件占 1 格；背包满返回 `inventory_full`。
  - 反馈码：`gm_add_ok` / `gm_item_unknown` / `gm_quantity_invalid` / `gm_usage` / `gm_unknown_command`。
- 权限：当前阶段全角色可用（单机复刻用途）；后续接入 GM 账号表时只需在 `handle_gm_command` 入口加身份闸门。
- 客户端：聊天提交对 `/` 开头文本不挂「发送中」行（gmResult 永不以 chatMessage 回声），`main.ts` 把 `gmResult` 渲染成 `GM：…` 系统行。

## 宠物系统（MVP）

- 数据：`scripts/export_tms273_pet.cjs` 从 `Item/Pet`（990 只，拆分档 `_000` 由 ResourceReader 解析）+ `String/Pet.json` 导出：
  - `resources/tms273-export/pets.json`（运行时目录）→ 拷贝为 `shared/pets.json`（服务端 include_str：name/life/hungry）；
  - `resources/tms273-export/pet-images.json`（icon + stand0/move/jump 帧）→ 装配进 `manifest.pets`；
  - PNG 落 `resources/tms273-export/assets/tms273/`，装配时拷入 `client/public-tms273/assets/tms273/`。
- 运行时（`server/src/pets.rs`，world 子模块）：
  - 召唤/收回：`useItem`（现金页签）命中宠物目录时短路存档事务，双击切换；道具**不消耗**、不持久化宠物状态。
  - 跟随：每 tick 横向以 0.18px/ms 逼近主人面朝侧后方 18px，纵向贴主人脚底；动作只有 stand/move。
  - 快照注入 `players[].pet`（world.rs snapshot，参照 away 的注入方式），会话态：换图/断线即消失。
- 客户端：`client/src/features/pet/view.ts`（PetView，动画走 mob 的左向源约定 facing=1 翻转）；`scenes/world.ts` 按玩家 id 同步；`manifest.pets` 帧进 preload-plan；物品栏现金页签图标回退到 `manifest.pets[id].icon`，名称回退到 `shared/pets.json`。
- 身份闸门：`crate::inventory::is_pet/pet_name`（inventory.rs，include_str pets.json）；宠物 tab 解析沿用百万位段回退（5=现金），slotMax 每件 1、不可叠加（kind 5 天然不叠加）。

## 版本与校验

- 版本四处同步：shared/protocol.ts、server/src/protocol.rs、assemble_tms273.cjs、check_tms273_runtime.cjs（均 `tms273-14`/`16`）。
- check_tms273_runtime.cjs 新增宠物规模钉板：pets=990、manifest.pets 与之一致、5000000 褐色小貓帧齐全。
- 验收测试：`gm_acceptance.rs`(5) + `pet_acceptance.rs`(4) 经 include! 进 world tests。
- 结果：cargo test **344 过 / 6 失败**（失败集与既有基线完全一致：auth third_store、mage bundled_catalog、world config_drop/portal_command/reactor_area/third_sphere）；tsc --noEmit 0 错；npm run check **29/31**（两个既有失败项不变）；check_tms273_runtime 通过（50 图，64007 引用）。

## 待用户加载实玩

需在终端跑 `zsh 启动3010.command` 统一换前后端后验证：
1. 聊天框 `/add 2000000 10` → 背包消耗页签出现 10 瓶紅色藥水，聊天窗出 `GM：已获得…`；
2. `/add 5000000` → 现金页签出现褐色小貓；双击召唤 → 宠物跟随、他人可见；再双击收回；
3. 错误路径：`/add 9990000 1`（未知 id）、`/add 2000000 0`（数量）。

唯一配置 id 索引表：
- 道具：`shared/items.json`（647 条，含中文名/价格/页签/slotMax）；
- 宠物：`shared/pets.json`（990 条，含中文名/life/hungry）；
- 同源副本：`resources/tms273-export/items.json`、`client/public-tms273/assets/items.json`。

## 修复：传送后宠物显示错误（同日补丁）

- 现象：召唤宠物后走传送门，新地图上画出携带旧坐标的错位精灵。
- 根因：单 World 持全部地图，换图只改 `player.map_id`，Player 行跨图存活；宠物会话状态随之泄漏到新图快照。
- 修法：三个换图点统一收回宠物（`player.pet = None`）——`portals.rs`（门）、`inventory_ops.rs::land_player_on_return_map`（卷轴落点）、`quest.rs`（任务传送）。复活不换图，不受影响。
- 回归测试：`pet_acceptance.rs::pet_is_recalled_when_the_owner_transfers_maps`（真实 Portal 命令 + 目标图装配）。cargo test 345 过 / 6 失败，失败集不变。
- 纯服务端修复：重新跑 `zsh 启动3010.command` 即生效。
