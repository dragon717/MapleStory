# 聊天输入焦点根因修复：Enter 后光标被 snapshot 抢走（2026-09-10 凌晨）
> 状态：未完成

> 归档自迁移前 `PLAN.md`（超大文件治理：md 与代码同一口径）。原文逐字保留，未做改写。
> 归档位置：`docs/plan/history/2026-09-10/30-2026-09-10-聊天输入焦点根因修复-Enter-后光标被-snapshot-抢走.md`　　归档顺序：30/66（PLAN.md 原倒序）


- 现象（用户实测）：Enter 后光标"闪一下"即从聊天输入框消失，再按键又触发游戏快捷键。
- 根因：服务端每世界 tick(~50ms)向每个玩家推 snapshot；客户端 `Connection.onmessage` 对每条 snapshot 都回调 `state('online')`；`main.ts` 对每次 online 执行 `focusGame()`（rAF 聚焦 `#game`）。Enter 聚焦输入框后不足 50ms 即被下一个 snapshot 触发抢焦点。此前离线 mock 只触发一次 online，故复现脚本第一轮未暴露。
- 修复：`client/src/network/session.ts` 状态上报幂等（`lastState`+`report()`，仅变化时回调）。`chat-focus.check.mjs` mock 同步修复后契约并新增 10a(legacy 复现抢焦点)/10b(修复后 400ms 焦点保持、focusGame 零调用)场景。
- 待验（用户）：在线仍跑旧构建；下次 `启动3010.command` 统一构建加载后实玩确认：Enter 后光标驻留输入框、可连续打字、不触发快捷键、Esc 正常返回游戏。
