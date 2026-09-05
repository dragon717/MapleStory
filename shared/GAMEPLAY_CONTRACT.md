# 第二阶段业务契约

范围：真实foothold链/墙、ladderRope、Down+Space下跳；少量Snail、普攻/接触伤害、经验、随机掉落/拾取/分类背包与装备；权威HP/MP/EXP与原版素材响应式HUD。没有摔伤、PVP、全技能/任务业务。当前状态以PLAN.md为准。

shared/protocol.ts是客户端消息定义：协议3，内容gms83-gameplay-2；Rust protocol.rs同步。input携带direction/vertical/jump/seq，vertical=-1上、1下；Down+Space优先下跳，禁止穿透forbidFallDown或无有效下方平台的地面。快照携带players/monsters/drops；角色含climbing/ladderId、HP/MP/等级/级内EXP/mesos/inventory。拾取为pickup(requestId,dropId)，响应pickupResult；浏览器不提交坐标、目标伤害、奖励或归属。

所有玩法由唯一world拥有者顺序处理。SQLite事务维护角色成长、击杀、掉落和请求去重；同一击杀/物品不得重复结算。前端仅按权威快照呈现。原始元数据和来源记录在shared/gameplay.json及references/gameplay-assets/manifest.json；Cosmic修改服掉落表、社区旧版公式和混版参考不得冒称官方GMS83精确一致。

废弃早期未经核实的300ms命中、3秒自动复活、1秒无敌、固定伤害及必掉红药。木剑01302000的swordOL/swingO1命中矩形来自WZ，afterimage首帧2对应原body时间轴450ms；2000ms受击无敌来自参考Char.cpp。死亡/返回地图使用源流程，不能重新引入猜测自动计时器。尚未实现或缺证据的规则明确保留，不用注释或配置字段代替完成。

开发隔离：旧3000与其陪测bot保留；新版3010使用qa-gameplay-round2.sqlite3、client/public-gameplay和dist-next，现有用户与新版陪测bot正在运行。独立QA已取消，实际改动仅做必要编译/小检查后交用户。根负责协调升级、刷新与重登录，禁止无提示打断或重置数据库。写入所有权和部署状态见PLAN.md。

怪物掉落保留最高伤害贡献者归属，生成后保护 60 秒，归属者可立即拾取，到期后任何人可拾取；截止时间持久化，重启不重新计时。其他人在保护期内尝试拾取时，聊天显示“该物品暂时不可拾取”。背包丢弃物品立即公开。客户端按 Z 立即拾取，长按每 200 毫秒从横纵距离均不超过 32 的掉落中重新随机选择，避免重叠时固定选中同一物品；松键、失焦或断线停止。

旧版快照中的持久化掉落缺少生成时间，迁移时保护截止时间设为 0（已到期），保留物品和归属记录，允许任何人拾取；不从迁移或重启时重新计算 60 秒。

拾取事务首次成功后向同图广播 dropPickedUp(mapId,dropId,playerId,x,y)，供本人及旁观者播放表现；失败和请求重放不重复广播。客户端将已拾取图标保留约 384 毫秒，向拾取角色身体位置跳跃并淡出，地图切换时清理。节奏参考本地 mapleweb/Journey Drop.cpp 的 48×8ms 拾取淡出；抛物线轨迹为本项目近似实现，并非官方客户端逐帧复刻。


物品栏沿用 GMS83 Item / Equip 窗口素材与参考布局，默认中文，`?lang=en` 使用英文。I 打开物品栏，E 独立打开装备栏；五类物品各有 24 个有效槽，展开窗口显示原版 96 格及未开放槽。支持分类内移动、交换、合堆、整理/排序、数量丢弃、金币丢弃、药水使用、穿脱装备和对已穿戴装备使用卷轴。未穿戴装备强化需要尚未开放的 Legendary Spirit 技能，拒绝时不扣卷轴。

当前可获得的 16 种道具元数据由 `scripts/export_inventory.py` 从本地 WZ 导出到 `shared/items.json`；堆叠上限、装备要求、药水效果和卷轴效果均使用该目录。装备实例的 stats 表示最终绝对属性，remainingSlots / upgradeCount 随交换、穿脱、丢弃、拾取和重启保存；战斗读取实际穿戴装备。卡片拾取进入怪物图鉴而非背包。离散操作由 Rust 校验并在 SQLite 事务内持久化及去重，客户端不决定强化结果或奖励。旧背包迁移按分类重新编号并拆分超限堆叠；容量不足或非法旧数据回滚保留，不静默丢弃。

针对性自检：`node scripts/check_inventory.mjs` 校验中英文与道具提示；`cargo test --manifest-path server/Cargo.toml` 包含药水单个消耗、卷轴错误目标不扣物品、请求重放、装备实例丢弃/拾回/重启和旧数据迁移回归。实际游戏内操作及外观验收由用户完成。
