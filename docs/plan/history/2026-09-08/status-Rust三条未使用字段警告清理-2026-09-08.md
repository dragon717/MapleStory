# Rust三条未使用字段警告清理（2026-09-08）
> 状态：已完成

> 来源：迁移前 IMPLEMENTATION_STATUS.md 原第 567–571 行；原条目状态保留，不因迁移改判。


- QuestConditions和QuestSpec的source_job为来源元数据，运行权限读取conditions.job；当前4个QuestObjective均为collect，进度读取item_id/required。内部字段改_source_job/_kind并保留serde显式sourceJob/kind及type别名，不改变业务或数据结构。未添加全局allow或删除来源信息。
- cargo build --manifest-path server/Cargo.toml通过，无warning；git diff --check通过。未重启服务或修改存档。

