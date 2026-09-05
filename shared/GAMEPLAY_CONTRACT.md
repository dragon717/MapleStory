# 第二阶段业务契约

范围：真实foothold链/墙、ladderRope、Down+Space下跳；少量Snail、普攻/接触伤害、经验、随机掉落/拾取/最小背包；权威HP/MP/EXP与原版素材响应式HUD。没有摔伤、PVP、全技能/任务业务。当前状态以PLAN.md为准。

shared/protocol.ts是客户端消息定义：协议2，内容gms83-gameplay-2；Rust protocol.rs同步。input携带direction/vertical/jump/seq，vertical=-1上、1下；Down+Space优先下跳，禁止穿透forbidFallDown或无有效下方平台的地面。快照携带players/monsters/drops；角色含climbing/ladderId、HP/MP/等级/级内EXP/mesos/inventory。拾取为pickup(requestId,dropId)，响应pickupResult；浏览器不提交坐标、目标伤害、奖励或归属。

所有玩法由唯一world拥有者顺序处理。SQLite事务维护角色成长、击杀、掉落和请求去重；同一击杀/物品不得重复结算。前端仅按权威快照呈现。原始元数据和来源记录在shared/gameplay.json及references/gameplay-assets/manifest.json；Cosmic修改服掉落表、社区旧版公式和混版参考不得冒称官方GMS83精确一致。

废弃早期未经核实的300ms命中、3秒自动复活、1秒无敌、固定伤害及必掉红药。木剑01302000的swordOL/swingO1命中矩形来自WZ，afterimage首帧2对应原body时间轴450ms；2000ms受击无敌来自参考Char.cpp。死亡/返回地图使用源流程，不能重新引入猜测自动计时器。尚未实现或缺证据的规则明确保留，不用注释或配置字段代替完成。

开发隔离：旧3000与其陪测bot保留；新版3010使用qa-gameplay-round2.sqlite3、client/public-gameplay和dist-next，现有用户与新版陪测bot正在运行。独立QA已取消，实际改动仅做必要编译/小检查后交用户。根负责协调升级、刷新与重登录，禁止无提示打断或重置数据库。写入所有权和部署状态见PLAN.md。
