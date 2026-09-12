# R11 排名刷新 + 第一批热点治理（world.rs 测试搬出）：按计划"不用旧行数、每次重新排序"

> 状态：已完成（原 PLAN 勾选）；未上线或待用户实玩范围按正文保留。
> 状态：已完成（待验收）

> 来源：PLAN.md 原第 120 行起的已完成条目；原勾选状态保留。

- **R11 排名刷新 + 第一批热点治理（world.rs 测试搬出）**：按计划"不用旧行数、每次重新排序"
  重跑 `refactor_audit.cjs --sizes`，识别出 churn 最高的 `world.rs`（8,821 行 = 生产 3,436 + 内嵌测试 5,385）
  的最大零风险削减项——把内嵌 `#[cfg(test)] mod tests` **机械搬出**为 `#[path = "world_tests.rs"]`
  外置测试模块（含 20+ 个 `include!("*_acceptance.rs")`，相对路径要求平铺 `src/` 根）；
  一次性脚本按内容边界切除 + 重组逐字节自校验。`check_tms273_runtime.cjs` 生产源码扫描同步排除
  `world_tests.rs`（与 `*_acceptance.rs` 同理：测试文本不是生产实现）。
  验证：cargo test **309过/6失败**（失败集逐名一致）、警告 39、`check_tms273_runtime` OK、
  audit `--deps --check` OK。**world.rs 8,821 → 3,437 行（-61%）**；测试组织与原 mod 语义完全一致。
- 刷新后剩余超预算候选（下一批按需立项，不自动扩张）：
  `auth.rs` 3,569（≈2,100 行 tests，继续拆收益低）、`skills.rs` 2,977（churn=1 纯静态）、
  `inventory_ops.rs` 1,456、`quest.rs` 1,397、`elemental.rs` 1,377。



