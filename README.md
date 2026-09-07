# MapleStory Web · TMS273

复刻依据为 `参考/273` 中的 TMS273.7 客户端与对应 WZ_JSON_TW。前端使用 TypeScript、Phaser 3、Vite；后端使用 Rust、axum、SQLite，以服务端为移动、战斗、库存和账户状态的唯一权威。网页客户端使用项目自己的 WebSocket 协议，不是原版 Windows 客户端协议。

开始开发先读 [长期规范](BUSINESS_DEVELOPMENT.md) 和 [当前计划](PLAN.md)。

## 运行

双击根目录的 [启动3010.command](启动3010.command)，然后打开 [游戏](http://127.0.0.1:3010)。脚本先构建前后端，成功后启动 3010；存在原凭据时连接唯一陪测 bot，凭据缺失时保留服务运行并提示，不新建机器人账号。关闭使用 [关闭3010.command](关闭3010.command)。需要 Node 22+、npm、Cargo。

当前资源目录为 `client/public-tms273/assets`，构建目录为 `client/dist-tms273`。旧 83 的生成目录不再参与构建。数据库统一使用 `server/data/tms273.sqlite3`，首次启动自动创建空库。按用户要求已删除旧账户库及本次备份，需要重新注册；日后普通启动会保留新库。日志位于 `evidence/runtime/3010-control/`。

方向键或 A/D 移动，空格跳跃，X/Ctrl 普攻，上方向进入传送门，I 打开背包，Q 打开任务日志。具体快捷键以页面设置为准。

## 从参考资源重建

```sh
npm ci --prefix scripts
npm ci --prefix client
node scripts/build_tms273.cjs
```

管线依次解析 273 地图/任务元数据、解包 Mob 的 MS 文件、读取 WZ 的 PNG/UOL/Canvas 外链、按原始帧延时与命名锚点导出动画、组装客户端资源与共享服务端配置。输出为 `resources/tms273-export`；构建前会校验全部资源引用，禁止混入旧版图片。

```sh
node scripts/check_tms273_runtime.cjs
npm run check --prefix client
npm run typecheck --prefix client
```

## 覆盖与缺口

地图范围为现有楓之島区域及原版冒险家主线涉及的彩虹码头、码头船舱、维多利亚港，共 17 张。状态栏使用 StatusBar3，总菜单使用 UITotalMenu，任务窗口使用 Quest.img，背包与装备窗口使用 UIInventory/UIEquip。

当前冒险家出生任务为 `36301–36304 → 36306 → 36307`，不是 322xx 或 83 的苹果任务。参考包缺失 `q363*`、`enter_maple`、`enter_20000` 等执行脚本，WZ 对应 Say/Act 为空；这些任务保留原始条件和文本，标记不可执行，不能视作完整剧情复刻。原生任务演出、职业系统、完整技能和商城业务仍需继续实现。

物理和基础战斗沿用现有 Rust 运行模型；怪物模板、防御百分比、地图碰撞及动画来自 273，初始角色属性等尚未核实的规则在生成数据中单独标为兼容实现。等级经验表尚缺同版依据，当前不能视作完整升级玩法。

83 资源归档 `MapleStory-运行资源-2026-09-05.tar.gz` 只供历史追溯，不能用它替代本版资源。
