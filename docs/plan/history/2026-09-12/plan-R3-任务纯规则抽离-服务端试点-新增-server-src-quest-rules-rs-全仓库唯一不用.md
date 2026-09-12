# R3 任务纯规则抽离（服务端试点）：新增 `server/src/quest_rules.rs`——全仓库唯一不用

> 状态：已完成（原 PLAN 勾选）；未上线或待用户实玩范围按正文保留。

> 来源：PLAN.md 原第 44 行起的已完成条目；原勾选状态保留。

- **R3 任务纯规则抽离**（服务端试点）：新增 `server/src/quest_rules.rs`——全仓库唯一不用
  `use super::*` 的 world 子模块，判定经 `QuestFacts` 窄视图，不接 World/Store/网络；
  quest.rs 19 处调用点迁移、7 个原静态函数删除、事务与回执留在 quest.rs 不动；新增 5 个纯规则测试。


