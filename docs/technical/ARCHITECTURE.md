# 架构文档入口

当前目标（2026-09-07）以PLAN.md的TMS273.7迁移为准；开发与验收遵循BUSINESS_DEVELOPMENT.md最新政策。下述首版架构与验证记录属于2026-09-05的83版本，不证明当前源码完整或273迁移通过。

历史记录（2026-09-05）：首版前后端已实施并构建通过，双机器人网络自测通过；代表性浏览器资源验收已完成，用户验收待执行。

已确认 Web TS/JS + Rust、单主机局域网联机、组合式组件与清晰业务模块。首版是一张地图、两个及多个不同账号、移动与普攻；开发双机器人自测和用户登录后同机器人验收分开记录。实现采用Phaser/TS/Vite + Rust axum/SQLite、GMS83蘑菇村000010000；性能阈值未设，先运行后优化。

- [计划与确认范围](../plan/PLAN.md)
- [前后端共同契约](SHARED_ARCHITECTURE.md)
- [前端方案与修改导航](FRONTEND_ARCHITECTURE.md)
- [后端职责与模拟流程](BACKEND_ARCHITECTURE.md)
- [架构与资源验收标准](ARCHITECTURE_ACCEPTANCE.md)
- [14库优先级与去重](REFERENCE_PROJECTS.md)

实现启动见 README.md；后续业务流程与模型阶段政策见 BUSINESS_DEVELOPMENT.md；实际协议字段以 shared/protocol.ts 为准。Rust单一权威逻辑拥有者顺序处理输入与模拟，分片/并行模拟/分布式未来先讨论。

执行入口：先读 BUSINESS_DEVELOPMENT.md（长期规范）和 PLAN.md（唯一当前计划）；仅相关追溯时读 IMPLEMENTATION_STATUS.md（已完成历史）。完成结果从计划移入历史，不创建重复台账。
