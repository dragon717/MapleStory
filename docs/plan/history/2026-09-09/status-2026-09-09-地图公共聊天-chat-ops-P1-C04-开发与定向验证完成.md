# 2026-09-09 地图公共聊天（chat_ops P1-C04）开发与定向验证完成
> 状态：已完成

> 来源：迁移前 IMPLEMENTATION_STATUS.md 原第 19–26 行；原条目状态保留，不因迁移改判。


- 按 `MapleStory_Rust_Chat_Ops_Development_Plan` 落实 P0-C00 真实盘点（启动入口/network/world 权威循环/protocol/socket writer/客户端聊天与渲染现状）与 P1 C03/C04 最小闭环；当前服务端为单进程权威 World、每连接有界 `mpsc::Sender<String>` 出站队列、玩家以 `map_id` 归属，无频道/多实例体系（P：地图房间=map_id）。
- 协议 protocolVersion 10→11，server `protocol.rs` 与 `shared/protocol.ts` 同步：`chatSend`（requestId+text）与 `chatMessage`（messageId/requestId 可选/mapId/authorId/authorName/text/occurredAtTick）。客户端仅交文本；地图房间/作者/展示名由服务端会话推导；伪造 mapId/authorName/GM/system 字段在反序列化层被拒。
- 服务端 world.rs：新增 `handle_chat`（当前地图成员房间 fan-out、文本策略 ≤200 字符且 ≤1KiB 且无控制符、令牌桶突发5 速率1/s 按 tick 惰性补充、request_id 幂等窗口64：同ID同正文不重复广播/异正文冲突拒绝）、`chat_reject`、`chat_consume_token`；Player 增 chat_tokens/chat_bucket_tick/chat_recent，World 增 chat_sequence。发送者 echo 带 requestId，其它玩家载荷不带；慢连接出站队列满则丢弃该条临时消息，不阻塞世界 tick、不踢人。
- 客户端：ChatView 接入真实提交与 pending 合并（requestId 匹配升级行；服务端拒绝恢复草稿可改后重发）、IME composition 保护、Enter 聚焦/Esc 退出、面板可用文案；`scenes/world.ts` 对 `chatMessage` 在 Phaser 角色头顶渲染 4 秒气泡（仅他人发言，切图/历史重放不生成）；`i18n.ts` 补 chat_rate_limited/invalid_chat_text/idempotency_conflict 文案。
- 验证证据：`cargo test` chat 定向 7 项通过（房间隔离、伪造拒绝、幂等重复/冲突、令牌限流及 1s 恢复、慢连接满队列不阻塞、文本策略/线级校验），`cargo build --offline` 通过（仅既有 contact_damage 警告），前端 `tsc --noEmit` 通过。全量 `cargo test` 另有 4 项失败经 stash 验证为基线既有（third_store/bundled_catalog/config_drop/third_sphere，09-09 装配回退与数值待办范围，与聊天无关）。未覆盖在线 dist/服务/数据库、未重启服务；vite 生产构建留给 `启动3010.command` 统一发布。用户实玩待验（Enter 发言、气泡、房间隔离、限流、IME）。

