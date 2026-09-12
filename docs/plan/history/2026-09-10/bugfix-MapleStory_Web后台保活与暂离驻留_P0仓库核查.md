# P0 仓库核查结论：Web 后台保活与暂离驻留
> 状态：未完成（含已落地部分）

> 日期：2026-09-10 · 范围：仅读取仓库现有代码，未修改业务代码、未重启在线服务、未改数据库。
> 核查人：按 `bugfix/MapleStory_Web后台保活与暂离驻留_开发方案` 第 4 节要求，给出实际路径、函数名、现有行为、拟修改点。

## 1. 根因：连接关闭 = 角色立即删除

服务端把「传输连接」和「权威角色」绑在同一个 `Player` 行上，连接一断就 `players.remove(&id)`。

| 位置 | 现有行为 |
| --- | --- |
| `server/src/world.rs:2813` `World::command` | 唯一权威边界，串行处理 `Join / Input / Leave` |
| `server/src/world.rs:3146-3165` `Command::Leave` | 只要 `player.connection == connection` 就 `self.players.remove(&id)` + `end_conversation` + 清理 pending/requests。**角色从世界消失** |
| `server/src/world.rs:2792-2810` `broadcast_to_map` | 输出 channel `Closed` 时同样 `players.remove(&id)`；`Full` 则静默丢弃该条（不阻塞 tick）——已有有界队列，但满队列只是丢包，不降级 |
| `server/src/network.rs:244-276` `socket_loop` | 退出循环后**无条件** `Command::Leave`。三个退出原因：① `watchdog` 发现 `last_received > 30s`；② `send` 超时 2s；③ 对端关闭/解析失败/限速 |
| `server/src/network.rs:269` | `last_received` 只在收到**客户端文本消息**时刷新；WebSocket Ping/Pong 控制帧走 `Some(Ok(Message::Ping(_)))|Some(Ok(Message::Pong(_)))=>{}`，**不刷新** `last_received` |
| `server/src/network.rs:251-252` | 60 消息/秒限速，超限即 `break` → 直接 Leave |

**结论：30 秒无客户端上行 = 角色被删除。**这是"切出去就掉线"的权威根因，不是渲染暂停。

与方案的偏差：方案 10.2 建议 `WS_TRANSPORT_TIMEOUT_SECS=45`；仓库实际是 **30 秒**，且**没有服务端主动 Ping**（`axum::extract::ws` 未配置 `WebSocketUpgrade` 的 ping 间隔），代理层（本仓库无 Nginx，axum 直连）不存在额外读超时。

## 2. 前端：失焦/隐藏已清输入，但 `pagehide` 无条件关连接

| 位置 | 现有行为 | 评价 |
| --- | --- | --- |
| `client/src/features/player/input.ts:56` `window.addEventListener('blur', this.reset)` | 失焦清 held、停 pickup、释放 channel，并发中性包 | ✅ 符合方案 9.1（不退出） |
| `client/src/features/player/input.ts:57,175` `visibilitychange` | 隐藏即 `reset()` | ✅ 清输入正确 |
| `client/src/features/player/input.ts:59` `setInterval(() => this.emit(false), 150)` | 150ms 输入心跳，**独立于渲染** | ✅ 已是独立循环；但页面冻结时定时器被限流 → 30s 无上行 → 服务端删角色 |
| **`client/src/app/main.ts:382`** `window.addEventListener('pagehide', () => { input?.destroy(); connection?.close(); })` | **刷新/关页/隐藏都无条件 close 连接** | ❌ 直接触发服务端 `Leave` → 删角色。方案 9.1 明确禁止 |
| `client/src/app/main.ts:366` `el('reconnect').onclick` | 仅手动点"重新连接"才重连 | ❌ 无自动退避重连；断线后只能手动 |
| `client/src/network/session.ts:36` | 10s 握手超时；无心跳定时器 | ❌ 连接建立后完全依赖服务端 30s 被动判定 |

**关键发现：前端目前没有"失焦就退出地图"的逻辑，真正的问题在 `pagehide` + 服务端 30s 无上行删除。**
`main 2.ts:196`（历史副本）同样是 `pagehide → connection.close()`。

## 3. 已有可复用资产（不必新造）

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 输入租约 | `server/src/world.rs:13801-13807` `step_player` | `last_input.elapsed() > 500ms` 即清零 `direction/vertical/jump`。**方案 9.3 的 500ms 租约已存在** ✅ |
| 输入序号去重 | `world.rs:3183` `seq <= player.state.last_input_seq` → 丢弃 | 已有 `client_seq` 等价能力 |
| 连接代际 | `Player.connection: String`（`world.rs:1993`），`Leave/Input` 均校验 `p.connection == connection` | **代际保护骨架已存在**，但 `Leave` 用它做"是本人就删"，需改为"是本人就解绑" |
| 有界输出队列 | `network.rs:219` `mpsc::channel(32)` | 32 条上限；`broadcast_to_map` 满则丢弃 |
| 位置/地图持久化 | `auth.rs:113-115` `Profile { map_id, x, y }` | 断线后重连能回到原地图坐标（走 `load_profile`），但**世界内实体已被删除**，是"重新入场"而非"接管原角色" |
| Boss 替换预处理 | `world.rs:2827` `prepare_boss_replacement` | 重连替换旧会话的先例，可复用于暂离接管 |
| 世界 Tick | `world.rs:14320` `run()`，`TICK_MS=50` | 单权威循环，与连接无关 ✅ 不因零 Socket 停止 |

## 4. 现有快照能力（决定 P3 恢复难度）

`world.rs:2790` 附近 `snapshot()` 每条 tick 对每个玩家生成全量 JSON，包含 `players/monsters/npcs/drops/summons/tickMs/selfId/bossPractice`。

- ✅ 每 tick 全量快照 = **天然具备"一致快照"**，不需要为恢复单独造基线机制；恢复即"重发一份当前 tick 的权威快照"。
- ❌ 没有 `sync_id` / `SnapshotApplied` 确认 / `ResumeGranted` 门禁；客户端收到快照即渲染，输入门禁由 `input.setReady(state==='online')` 控制（`main.ts:344`）。

**这意味着 P3 可以大幅简化**：复用现有全量快照 + 现有 `connection` 代际，只需补"确认 + 门禁"，不必新建增量基线体系。

## 5. 拟修改点清单（P1 起）

### 服务端 `server/src/world.rs`
1. `Player` 增加暂离事实：`away: Option<AwayWindow>`（`started: Instant`、`policy`、`reason`）、`connection_epoch: u64`、`session_id: String`。
2. 新增 `AwayWindow`/`AwayPhase`/`AwayPolicy` 结构与 `phase_at(now)`（方案 6.2 概念代码的落地版）。
3. `Command::Leave` 改为 `detach_connection`：仅清空 `connection/output` + 清输入，**不 `players.remove`**；若角色无暂离窗口则以 `TransportLost` 创建。
4. `broadcast_to_map` 的 `Closed` 分支同样改为解绑，不删角色。
5. `step()` 中增加到期扫描：达到 `full_retention`(600s) 发布暂离标记；达到 `max_total`(3600s) 转 `Leaving` 走既有退出收尾。
6. 快照 `players[]` 增加 `away: boolean`，供其他客户端显示"暂离"。

### 服务端 `server/src/network.rs`
7. `socket_loop` 退出时按原因区分：主动/解析失败/限速 → `Leave`（真离场）；超时/发送失败/对端静默 → `Detach`（暂离解绑，保留角色）。
8. 增加服务端主动 Ping 并将 Pong 纳入 `last_received` 刷新（区分传输响应与应用进度）。

### 前端
9. `client/src/app/main.ts:382` `pagehide` 不再 `connection.close()`；改为尽力报告生命周期 + 清输入。
10. `client/src/network/session.ts` 增加带抖动退避的自动重连，并对"终止性结果"（被替代/鉴权失败）停止重试。
11. `client/src/features/player/input.ts` 区分 `blur` 与 `hidden`：仅 `hidden` 向服务端上报暂离；两者都清输入。

## 6. 与方案的偏差记录

| 方案建议 | 仓库实际 | 处理 |
| --- | --- | --- |
| 传输超时 45s | 30s，且无服务端 Ping | P1 调为 45s 并加 Ping；不因"十分钟角色宽限"把传输超时设成十分钟 |
| `AWAY_SWEEP_INTERVAL_MS=1000` 后台扫描 | 世界 tick 50ms，可直接在 `step()` 判定 | 复用 50ms tick，不另起扫描任务 |
| `sync_id`/基线/追赶增量 | 已是每 tick 全量快照 | 简化为"当前 tick 权威快照 + 应用确认"，不建增量基线体系 |
| Nginx 代理排查 | 仓库无 Nginx，axum 直连 3010 | 无需调整代理；记录为不适用 |

## 7. 尚未验证（P0 声明边界）

- 未实机复现"仅失焦 / 切标签 / 最小化 / 真实断网 / 重新聚焦"五种场景的服务端日志——在线服务运行旧构建，按 `BUSINESS_DEVELOPMENT.md` 不得为测试重启。
- 上述根因结论来自源码静态判定（30s 无上行 + `pagehide` close 两条路径均可直接读证），实现后由用户通过 `启动3010.command` 实玩验证。
