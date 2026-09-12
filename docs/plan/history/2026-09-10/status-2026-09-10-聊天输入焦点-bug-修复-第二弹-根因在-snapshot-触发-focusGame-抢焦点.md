# 2026-09-10 聊天输入焦点 bug 修复（第二弹：根因在 snapshot 触发 focusGame 抢焦点）
> 状态：已完成

> 来源：迁移前 IMPLEMENTATION_STATUS.md 原第 1–8 行；原条目状态保留，不因迁移改判。


- 现象（用户实测复述）：按 Enter 后光标短暂进入聊天输入框"闪一下"即消失，再按键又触发游戏快捷键。
- 根因：服务端 `world.rs` 每个世界 tick(~50ms)向每个玩家 `try_send(snapshot)`（tick 尾部 players 全量快照）；客户端 `Connection.onmessage` 对**每一条 snapshot** 都回调 `state('online')`；`main.ts` 连接状态回调对每次 online 执行 `focusGame()`（rAF 聚焦 `#game`）。于是 Enter 聚焦输入框后不足 50ms 即被下一个 snapshot 触发 focusGame 抢走焦点——"闪一下就没"。此前 headless mock 只触发一次 online，故未暴露。
- 修复（`client/src/network/session.ts`）：新增 `lastState` + `report()`，仅当 connecting/online/offline 真正变化时回调 `state()`；snapshot 只作为"已连接"确认，不再每 tick 重复上报 online。离线复现脚本 `chat-focus.check.mjs` 的 mock 相应模拟修复后契约（仅在变化时上报）。
- 验证：chat-focus.check.mjs 新增场景 10a/10b 精确复现并验证——legacy 模式（每 snapshot 上报 online）下 Enter 聚焦 260ms 后被抢回 `DIV`（复现"闪没"）；修复模式（幂等上报）下持续 snapshot(~400ms/8 tick) 输入框焦点保持、`focusGame` 零额外调用、打字正常落框；加上此前 9 场景全过；`tsc --noEmit` 通过。保留为回归测试。
- 未上线：在线服务仍跑旧构建；待 `启动3010.command` 统一构建（protocol 11）后实玩验证（Enter 后光标驻留、打字不触发快捷键）。

