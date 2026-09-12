# 2026-09-06：任务体验完善 v0.3.0（gms83-quest-1 / protocol 5）
> 状态：已完成

> 来源：迁移前 IMPLEMENTATION_STATUS.md 原第 194–210 行；原条目状态保留，不因迁移改判。


按 Cosmic v83 参考复刻任务体验：以真实 v83 任务 **1021 Roger's Apple**（Roger/2000 发起，出生图闭环）为主干，叠加已有 maple-road-training 机制校验链。共享 `shared/protocol.ts` 与 Rust `server/src/protocol.rs` 协议升级到 5（CONTENT_VERSION `gms83-quest-1`）。

服务端（Rust）：
- `npc.rs`：条件新增 `hpAtLeast`；`QuestEffect::Start/Complete` 进入时结算。`DialogueContext` 扩展后授权世界内部调用（新 `ctx_quests` 供测试）。移除旧写死的 `quest_reward_mesos`。
- `world.rs`：`Gameplay` 新增 `quests: Vec<QuestDef>` 与解析，字段随字面量初始化补全；`apply_quest_effect` 重写为按 QuestDef 目录结算：start 检查 `start.hpCap/hpCapIfAbove` 与 HP 要求、按 `grantItems` 发放入场道具；complete 校验 `hpAtLeast`（或经持久化任务状态）、发 mesos/exp/物品（物品用既有 `add_items` 幂等合并），再 `persist_player`。保留 available→active→completed 幂等转换约束，重复交付不发二次奖励。
- `inventory.rs`/`auth.rs`：`add_exp` 由私有改 pub(super) 供 world 调用（auth 模块内），升级按 expTable 权威结算，快照随在线消息下发。
- 测试：world.rs 新增 quest 定向测试覆盖 start 发 Roger's Apple、complete 条件拦截、exp/物品奖励与二次交付幂等；fixture contentVersion 同步 `gms83-quest-1`。

客户端（TS）：
- 新增 `features/quest/log.ts` QuestLogView（任务日志，Q 键开合）；input.ts 注册 Q；main.ts 接线：quest 消息/日志状态推入、进入地图时全量请求、登录/登出与离场清理；任务接受/完成聊天提示含奖励文本（`Obtained …`）；样式追加羊皮纸日志面板（style.css 尾部）。
- 数据/素材：`scripts/export_rogers_apple.cjs` 从 Item.wz Consume 导出 2010007 Roger's Apple 图标并更新两份 manifest；`shared/items.json` 增补 2010007（consume/hp30 镜像 Apple）；`shared/gameplay.json` 与 `evidence/2026-09-12/runtime-snapshots/gameplay-round2.json` 增补 quests 目录（1021 与 maple-road-training）并覆写 Roger(2000) 对话状态机为 1021 流程。
- 必要检查：Rust 全量测试通过、cargo fmt、cargo build 成功；TS typecheck、`npm run build` 产出 v0.3.0。

受控更新 3010：经 `启动3010.command` 重启（server PID1904、bot PID1921，health `ok=true / protocolVersion=5 / gms83-quest-1`，bot 维持 TCP 连接）。沙箱纪律同前：启动脚本末尾自验在该沙箱假阴性退出（退出码 1），服务与 bot 均由 nohup 拉起独立保活，以 lsof/health 核验为准；勿在调用返回后 kill 包装进程组，否则连带回收服务（本次 882/903 即因清理保活 wrapper 被连带回收，重新后台拉起 1904/1921 解决）。数据库沿用既有 QA 库未重置。

