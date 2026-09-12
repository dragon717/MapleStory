# 2026-09-08 普通四转运行基线 v0.8.0 / protocol8 / content6
> 状态：已完成

> 来源：迁移前 IMPLEMENTATION_STATUS.md 原第 635–643 行；原条目状态保留，不因迁移改判。


- 已接11普通四转源节点，累计43目录；原初心者/前三转保留。Hans P lv100四转、SP差额修复/学习前置/固定技能在现有CAS，原剧情和存档保留。按压释放、束缚与90秒免疫、防御削减、独立冰魔/冰锋刃/雷球、Infinity基础MP恢复/后段提示、实际命中触发暴风雪追加及属性接入。
- 源资源装配17图/3929素材/52NPC/4怪、31845资源引用。修复隐藏追加元数据混入数组、按压初始0误清普攻、q受buff时长放大、Infinity毫秒/tick混用、追加攻击目标错配和净化伪清攻击。旁观者恢复双层按压与声音清理已接。
- 必要验证：world::tests::fourth_job_core_channel_bind_summon_infinity_and_blizzard 1/1；mage::tests::bundled_catalog_is_strict_and_has_energy_bolt_geometry 1/1；fourth_store_ 4/4；mage_level_up_grants_three_book_points_once_across_reward_replay 1/1；cargo check通过。前端typecheck、skills/view.check.mjs、combat/skill.check.mjs、check_tms273_runtime.cjs通过；dist-fourth-check生产构建通过。
- 核心检查共7文件，独立4文件507行+world新增247行+mage既有检查约35行/auth接入及旧用例范围，合计低于1000行。没有独立QA或重复全套验收。
- 边界：SP历史MSEA分档、Hans入口、部分执行节拍均P而非原脚本；Hyper未开放。净化虽保留3秒免疫权威窗口，但当前敌方异常入口仍缺，尚不能宣称真实异常解除/拦截完成，需接后续状态/Boss。原版四转剧情脚本未恢复。在线dist/服务/数据库未修改，实际画面与手感用户待验。


