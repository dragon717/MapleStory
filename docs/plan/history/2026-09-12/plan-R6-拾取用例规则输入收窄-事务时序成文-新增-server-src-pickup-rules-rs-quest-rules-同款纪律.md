# R6 拾取用例规则输入收窄 + 事务时序成文：新增 `server/src/pickup_rules.rs`（quest_rules 同款纪律：

> 状态：已完成（原 PLAN 勾选）；未上线或待用户实玩范围按正文保留。
> 状态：已完成（待验收）

> 来源：PLAN.md 原第 68 行起的已完成条目；原勾选状态保留。

- **R6 拾取用例规则输入收窄 + 事务时序成文**：新增 `server/src/pickup_rules.rs`（quest_rules 同款纪律：
  不用 `use super::*`、窄输入 `PickupFacts`/`PickupVerdict`、不接 World/Store/网络）——掉落可得性判定
  （地图/归属保护/距离/内存容量预检）与图鉴饱和入账从 `handle_pickup` 纯搬出，拒绝码与文案逐字保留；
  `handle_pickup` 保留幂等查询、Store 提交、世界回填与回执顺序（未动事务）。先补齐四个窗口的保护测试
  再搬移：新增 `pickup_store_windows_replay_prior_failure_and_side_effect_free_reject`（成功/重放/持久化失败）
  与 `pickup_backfill_failure_after_commit_keeps_persisted_truth`（事务成功+回填失败：资产以持久化为准）
  两个 world 层测试 + pickup_rules 5 个纯规则单测。事务时序与失败窗口说明成文于
  `BACKEND_ARCHITECTURE.md` §6.1，模块表加 `world::pickup_rules` 条目。
  验证：cargo test **304过/6失败**（失败集与基线逐名一致，+7 新测试）；新代码零警告；
  audit `--deps --check` OK（0 环 0 违规 0 债务）；`check_tms273_runtime` OK。



