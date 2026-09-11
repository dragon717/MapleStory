# 聊天表情 / Chat Emoticon（表情貼圖）：已完成，待统一加载实玩（2026-09-11）

> 归档自 `PLAN.md`（超大文件治理：md 与代码同一口径）。原文逐字保留，未做改写。
> 归档位置：`docs/history/plan/07-2026-09-11-聊天表情-Chat-Emoticon-已完成-待统一加载实玩.md`　　归档顺序：07/66（PLAN.md 原倒序）


- 选题：聊天模块的第三张面。地图聊天是**房间事实**（由发送者所在地图推导），悄悄話是**一对事实**
  （由键入的名字解析），表情是**目录事实**——一个 `emoticonSend` 只带一份可发送目录的 id、不带正文，
  所以"这个 id 存不存在、现在能不能发、同图谁看得见"全由服务端裁决，客户端只是选择器。
- 来源 T（本轮实测 `UI/ChatEmoticon.img`，非猜）：`Emoticon/` 51 组 **298** 张贴图；
  **`ChatLimit` = count 4 / timeMs 5000 的滑动窗口**（是窗口不是令牌桶，故 Rust 侧按 `TICK_MS`
  换算出窗口长度，与地图聊天的令牌桶分开两套，互不占额度）；窗口 `backgrnd` 370×530。
- 网格几何（**反证而非目测**）：`slotOffset`(23,115) + `slotSpace`(109,102) + `slotBase` 101×97 排 3 列 3 行，
  其外框 321×302 **正好等于** `layer:emptySlot`——源自己画在网格上的空态面板（文案
  「在本頁籤沒有可以使用的表情符號。」）。第 4 行会压到底部信息条，所以是 3×3 而不是"能塞几行算几行"。
- 目录 id：**组 1043 把组 1036 的六张图用同样的节点名再发一次**（画布字节相同、caption 不同），
  所以 id 必须是 `<groupId>:<sourceName>`（`1036:10360001`）；`:` 本就在协议 id 字母表内，
  不必把 id 变成复合线格式。导出时加全局唯一断言，重复即失败。
- 导航模型（**本轮先做错、被数据推翻，故记下判据**）：`pageUp`(80,50) / `pageDown`(321,50) 与
  chips 同一行（chips 113..309）分列两侧，`pageIcon` 画在 chips 下方 5px，而 3×3 网格（y=115..417）
  旁边**没有任何按钮**；51 组 ÷ 5 chips = **恰好 11 页**，等于圆点数；**51 组里 50 组 ≤ 9 张**
  （只有 1000 组 10 张）。⇒ 按钮与圆点驱动**分组条**，网格按**选中分组**取 9 格，
  分组条必须覆盖选中分组。原先"平铺 298 张、每页 9 张共 34 页"的模型已废弃。
- 协议（协议 12 未升版，同版扩展）：`emoticonSend{requestId,emoticonId}`（`valid()` 只校验形状，
  目录成员是世界观问题）与 `emoticonMessage{messageId,requestId?,mapId,authorId,authorName,emoticonId,occurredAtTick}`；
  伪造信封（作者/地图/时间戳）由 `deny_unknown_fields` 拒绝，已写成用例。
- 权威边界（服务端 `world.rs::handle_emoticon`）：① 目录白名单（由 `gameplay.emoticons.ids` 扁平而来，
  `Gameplay::validate()` 拒绝空/重复/零预算的目录）→ ② `(requestId, 贴图)` 幂等（重放只回显发送者，
  同 id 换贴图算冲突）→ ③ 源 `ChatLimit` 滑动窗口预算 → ④ 同图广播并尊重黑名单（发送者永远收到自己的回显）；
  消息 id/时间戳全由服务端落定。
- 客户端：`features/chat/emoticon-view.ts`（纯视图：分组条 + 3×3 网格 + 圆点 + 底部信息条，
  全部按导出坐标绝对定位；圆点可直接跳分组页；超版的 1000 组用 ↑↓ 翻第二版并在信息条提示「第 1/2 頁」）
  + `features/player/view.ts` 头顶播放源 `effect` 帧 + `main.ts` 实例/输入阻塞/拒绝分发/断线清理。
- 验证：导出（51 组 / 298 贴图 / 11 分组页 / 52 版 / 圆点容量 14）→ assemble（tms273-9，44 maps）
  → `check_tms273_runtime.cjs` → `emoticon.check.mjs` 12 项（含"全目录可达"遍历）
  → `tsc --noEmit` 全过；服务端 `emoticon_acceptance.rs` 5 项通过（上一轮）。
  `shared/gameplay.json` 与 HEAD 的结构化差异仅 2 个叶子（新增 `emoticons` + 兼容性文案），故未重跑 cargo。
- P 边界（未做，不冒充已完成）：`button:bookmarkTab` / `bookmark_ON|OFF` / `button:edit|save` /
  `button:keySettingUI`（书签页、我的表情编辑保存、按键设定）与限时贴图均未接入；
  每组第 10 张及以后的贴图没有源按钮，用 ↑↓ 替代。
