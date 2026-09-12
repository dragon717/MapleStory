# R9 几何与内容校验核对 + 内嵌测试钉扎：核对 `server/src/geometry.rs`（622 行，R0 前已抽离）

> 状态：已完成（原 PLAN 勾选）；未上线或待用户实玩范围按正文保留。
> 状态：已完成（待验收）

> 来源：PLAN.md 原第 101 行起的已完成条目；原勾选状态保留。

- **R9 几何与内容校验核对 + 内嵌测试钉扎**：核对 `server/src/geometry.rs`（622 行，R0 前已抽离）
  已覆盖计划 §11.1 全部候选——Foothold 插值/墙阻挡/接触时刻判定、Ladder 列窗口/uf 顶端语义、
  WaterRect 水底插值/形状校验、ReactorPlacement hitbox 归一化与 `TYPE_AREA` 触发——
  **确认不重复立项 `world_geometry.rs`**。补齐原缺失的内嵌纯函数测试 5 个
  （foothold 插值内外、wall blocks/防隧穿接触时刻、ladder 容差与探测窗口、water 插值与校验、
  reactor hitbox 归一化），把 `blocks_at_crossing` "接触时刻判定而非端点判定"这一防隧穿语义首次钉进测试。
  验证：cargo test **309过/6失败**（失败集与基线逐名一致，+5 新测试）；警告 39 与基线一致。



