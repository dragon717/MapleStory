# 前端技术方案（审查草案）

更新：2026-09-05。**已确认前端使用浏览器 TypeScript / JavaScript，便于调试和扩展。** 当前已使用 Phaser 3.90、TypeScript 5.9、Vite 7.3 实施首版，构建通过并进入浏览器验证。Godot、Unity、C++ / Rust WASM 客户端仅作参考。实际代码在 client/。

跨端 ID、协议、服务端权威、版本与资源字段以《前后端通用技术方案》为唯一约定，本文件只讲前端组织和修改位置。

## 1. 推荐的最小选择

| 选择 | 收益 | 代价与取舍 |
| --- | --- | --- |
| **当前实现：Phaser + TS + Vite** | Phaser 已覆盖 scene、相机、输入、加载、动画与音频；TS 便于定位字段，Vite 用于开发和构建 | 纸娃娃、原版 foothold、技能时序仍需实现；Phaser 不是现成冒险岛。Vite 的 TS 转换不替代 `tsc --noEmit` 类型检查 |
| 备选：PixiJS + TS | 更专注渲染，运行结构可自行掌握 | 场景生命周期、输入和音频等要额外组织，当前“尽快跑通”的收益较小 |
| 暂不叠加 bitECS / React | 避免 Phaser 对象、ECS 和 UI 状态出现多套世界模型 | 只有实体查询 / 更新已出现实际复杂度时才评估 ECS；复杂 DOM 界面真实出现时再评估 UI 框架 |

登录、设置、错误提示建议使用普通 DOM / CSS，游戏世界使用 Phaser。DOM 表单保留键盘操作、标签和焦点管理；输入框聚焦时不能继续触发攻击。素材加载、声音解锁使用明确的加载 / 进入操作，遵循浏览器音频启动约束。

官方依据：[Phaser scene](https://docs.phaser.io/phaser/concepts/scenes)、[动画](https://docs.phaser.io/phaser/concepts/animations)、[Vite 功能](https://vite.dev/guide/features)、[PixiJS 架构](https://pixijs.com/8.x/guides/concepts/architecture)、[bitECS](https://github.com/NateTheGreatt/bitECS)。这是适配本任务的研究建议，非用户已定案技术清单。

## 2. 目录职责（扩展建议；实际以client/src为准）

```text
client/src/
  app/                 启动、配置、显式注册入口
  scenes/              Boot、Login、World 的组装与销毁
  features/
    player/            角色输入意图、本地状态副本、纸娃娃呈现
    mobs/              怪物状态副本、动画呈现
    combat/            动作表现、技能视觉、投射物、浮字
    quests/            对话与任务 UI，发起任务请求
  assets/              资源 manifest 加载、纹理/动画/声音访问
  input/               键鼠输入到动作意图的映射
  network/             会话、WS连接、消息解析与状态接收
  ui/                  DOM 登录/设置与通用提示
```

业务目录优先，文件先少后拆；每个 feature 只有实际需要时才分 `state.ts`、`view.ts`、`actions.ts`。普通 TS 状态与转换函数不引用 Phaser；呈现文件才持有 sprite / container。scene 负责组装与切换，不能同时承包战斗、任务、联网和存档。

`app` 直接 import 并注册已存在的模块；注册顺序清晰可读。**不先写自动扫描、插件市场、依赖注入容器或动态热加载。** 组件组合是对象的数据与行为组织方式，不等于必须有 ECS 库。

## 3. 职责与可替换范围

| 位置 | 拥有什么 | 不拥有 / 如何替换 |
| --- | --- | --- |
| assets | manifest、按地图依赖加载、纹理/音频缓存、缺失资源错误 | 不决定技能伤害。以后改图集格式主要改资源加载与引用映射 |
| features/player | 外观数据、动作游标、纸娃娃部件与锚点计算 | 不决定服务端 HP / EXP。外观逻辑依赖资源元数据，不能写死一套角色图片 |
| input | 按键 / 触屏 → move、jump、useSkill 等意图 | 不把 Q 键写进技能定义。换输入设备主要改本目录及设置 UI |
| network | 已验证会话、收发、请求对应、状态副本和重连状态 | 不操纵角色 sprite，不执行伤害公式。协议变化按共享契约调整 |
| features/combat | 根据动作/生成/命中事件播放姿态、飞行、命中特效、音效 | 不决定命中或自行发奖；结算来自后端 |
| scenes | 加载完成后组装地图，切图时释放场景拥有的实例 | 不销毁仍被其它场景使用的共享纹理缓存 |
| ui / quests | 展示状态、收集选择、显示拒绝原因 | 不在 UI 中直接改背包、任务完成状态 |

这些是实际修改边界，不要求每个边界都造一套仅有一个实现的接口。替换渲染引擎仍需改 view、scene、纹理与动画适配，不能承诺零成本；保持普通 TS 数据清晰可以减少影响。

## 4. 后续扩展：快速构造一个技能（非首版门槛）

以“发射一个投射物，命中后播放效果”为示意，技能名、数值和地图不是最终选定内容。

1. 在共享技能配置中引用已有的施放动作、投射物机制、命中效果；数值从选定版本规则核对。客户端可见部分包括资源 ID 与表现时序，按键在 input 的独立绑定表。
2. assets 的 manifest 能解析完整动作帧、delay、origin 和部件锚点，以及投射物、hit、施放音效引用。资源缺失在离线检查时失败，不到战斗时才发现。
3. 玩家按键后 input 产生 `useSkill` 意图，network 发请求；前端可先播放可撤销的施法准备反馈。
4. 服务端接受动作 / 生成投射物的事件到达，combat 从该时点开始表现飞行，关联 actionInstanceId / entityId。**不是等命中消息到了才补播整段飞行动画。**
5. 服务端命中 / 拒绝 / 取消事件结束对应实例，更新权威状态副本，播放命中特效或恢复姿态。不得让一次动画完成回调在客户端扣血。
6. 到期、切图、死亡或断线，释放该动作产生的 sprite、临时音效和订阅；共享纹理留在缓存策略内。

已有原语能表达新技能时只加配置。遇到新机制时新增一个明确的通用处理器，再让技能引用它；不为每个技能建一个子类，也不把所有技能堆成一个巨大 `switch(skillId)`。

## 5. 修改导航表

| 想做的改动 | 主要修改位置 | 一般无需修改 |
| --- | --- | --- |
| 新增复用已有机制的技能 | 共享技能配置、资源映射、必要的技能 UI 展示 | 网络传输层、场景生命周期、纸娃娃底层 |
| 新增视觉原语，如新的轨迹表现 | combat 的表现处理器，app 显式注册；如需新事件字段则更新共享契约 | 账号与存档 |
| 新增战斗机制，如新状态效果 | 后端 combat 规则、共享定义 / 事件、前端相应表现 | 原有资源解析器（格式没变时） |
| 新增功能模块 | features 下一个业务目录，在 app / scene 明确接入 | 不自动扫描全项目发现插件 |
| 更换键盘为触屏输入 | input 与设置界面 | 技能数据中的伤害 / 资源 ID |
| 换装备或发型 | player 外观组件及资源引用 | 战斗网络协议（已有外观事件可表达时） |
| 换地图 | 新地图包 / manifest、World 场景数据与服务端地图入口 | 不为每张地图复制整个 scene 类 |
| 改资源导出格式 | assets 加载与 manifest 版本，必要的拼接适配 | 后端战斗规则 |
| 改渲染库 | view、scenes、纹理 / 动画 / 相机调用 | 可保留经过隔离的普通 TS 数据，但仍须重验输入和时序 |

### 5.1 检查与防回潮门禁（R10 接线，2026-09-12）

- `npm run check`（`client/scripts/run-checks.mjs`）：逐项执行 24 个 check 文件 + 1 个仓库级门禁
  （`node scripts/refactor_audit.cjs --deps --check`，从仓库根扫描 client/src + shared + server），
  25 项全过、任一失败非零。新增跨域深层导入 / 依赖环 / 未登记越界会让 `npm run check` 失败。
- 例外登记：`artifacts/refactor/debt-register.json`（已知债务显式登记，不自动扩张；当前 0 项）。
- 依赖报告：`node scripts/refactor_audit.cjs --deps`（runtime/type 环分开报告，写入
  `artifacts/refactor/frontend-deps.json`）；脚本自测 `--self-test`。
- 接入 CI 时执行同一条门禁命令即可：`node scripts/refactor_audit.cjs --deps --check`。

## 6. 数据与临时作用的生命周期

| 生命周期 | 示例 | 结束责任 |
| --- | --- | --- |
| 角色长期数据 | 装备、技能学习、背包、任务进度 | 服务端持久化；前端仅持显示副本。HP / 位置是否跨重启保留待定 |
| 当前会话 | 认证状态、连接状态、选择角色、待确认请求 | network 在退出或断线恢复时处理 |
| 当前地图 | 实体视图、地图物件、BGM 句柄、场景订阅 | World scene 在切图 / 离开时释放 |
| 短时实例 | 施法、投射物、浮字、命中闪光 | 实例到期 / 被取消时清理；切图和断线兜底清理 |
| 原型临时实现 | 本地 mock、调试快捷键 | 留在开发入口，不混进正式协议或存档 |

原始 metadata 中的时间、原点和层级不能被 sprite 默认值悄悄替代。纸娃娃动作读完整时序，保留 UOL、action/frame 重定向和帽子/头发遮挡数据。调试面板建议仅在开发时显示当前动作、帧索引、锚点和资源路径，便于定位错位。

### 6.1 App/Session/Scene 作用域确认（R8 成文，2026-09-12）

对照计划 §10.2 生命周期表，确认 `app/main.ts` + `scenes/world.ts` 现状：

| 作用域 | 现状归属 | 结论 |
| --- | --- | --- |
| 页面/App | `app/page-shell.ts`（R8 拆出：模板、语言切换、新闻弹窗、game-mode 布局）；语言切换整页跳转，无需运行时重建 | ✅ 已拆出；不因切图重建页面 |
| 登录会话 | `Connection`（`network/session.ts`）+ `generation` 计数 + 各窗口实例（`enterGame` 建、`leaveGame` 拆） | ✅ 生命周期清楚但与 20+ 视图回调交织；**`game-session.ts` 按计划"仅在生命周期清楚后"暂不拆**，登记为后续候选 |
| 地图激活周期 | `World`（Phaser Scene）：切图走 `scene.restart()`，`create()` 重挂输入、重建 CombatView/图层；`SHUTDOWN` ≠ `DESTROY`，重进语义由 restart 保持 | ✅ 已由 feature views 承担实体，无需平行管理器 |
| 窗口实例 | 各 feature view 自持 DOM 监听与 destroy（R4/R7 已拆 inventory 为门面+四子模块） | ✅ 销毁清单在 `leaveGame`/`destroy()` 逐一调用 |
| 短时表现 | 浮字/投射物/气泡由 CombatView/PlayerView 自管 | ✅ 不触碰服务端资产 |

资源预加载：收集逻辑已纯函数化为 `assets/preload-plan.ts`（`buildPreloadPlan`，全量策略、
顺序与去重语义不变；BGM 的 `cache.audio.exists` 短路留在 Scene 执行）。

## 7. 源码审核依据与不照搬的部分

- DevenWen `src/main.ts` 实际选择 `DemoTileMap`，开启 Matter；该 scene 从 localhost 加载 Tiled JSON 和图块。它能说明加载/组装路径，但不是已完成端游地图运动模型。局域网客户端必须使用当前主机来源，不能把 localhost 写死在网页里。
- `RPCWzStorge.ts` 把 `.xml.json` 转树，再加载 `.tp.png/.tp.json`，通过纹理到达执行回调；`AnimationLoader.ts` 使用帧 delay，但技能和怪物加载函数仍有空实现。可以借鉴数据形态，重写明确的异步加载成功/失败与释放边界。
- `player/v2/Avatar.ts` 依次绘制 body/head/hair/cap/coat/pants，按命名锚点和 z 排序；每次绘制清空并重建部件，存在尚未完成的装备与移动信息处理。只拿它验证拼接规则，不把 demo 的限制写成我们的完整设计。
- Maplewright `crates/wz/src/paperdoll.rs` 读取 Base.wz/zmap、解析 UOL，并保存帧 footx/footy/delay，可用于交叉检查数据解释；不因此把前端改为 Rust。

## 8. 已确认首版前端验收

首版只做一张地图、多个不同账号、局域网在线、移动与普攻。登录页面必须让用户自行完成认证、角色进入地图的正常流程。

开发自测使用两个自动化机器人客户端，发送相同网络意图；用户验收时由用户自己的账号进入，与一个持续按预设程序移动 / 普攻的机器人同图。机器人不能由 AI 实时操控，也不能直接写服务端状态。两阶段记录分开。

前端检查身份不混淆、同图互见、位置 / 朝向 / 普攻同步、加载失败明报、断线时停止输入与重入取权威状态。新技能、任务、掉落及 PVP 留在后续，不作为首版门槛。具体地图与机器人节奏待选，无预设性能指标。

文档导航：[计划](PLAN.md) · [共同契约](SHARED_ARCHITECTURE.md) · [后端](BACKEND_ARCHITECTURE.md) · [验收标准](ARCHITECTURE_ACCEPTANCE.md) · [参考项目分级](REFERENCE_PROJECTS.md)

## 本地审核证据

以下位置属于**参考仓库，不随本仓库分发**：`参考/` 下目前只有 WZ 素材，`参考/repos/` 需按 [参考项目分级](REFERENCE_PROJECTS.md) 自行浅克隆后才会出现。路径写的是克隆后的规范位置，在此之前打不开属于预期。

| 证据 | 克隆后的相对位置 | 上游 |
| --- | --- | --- |
| Phaser 默认入口 | `参考/repos/DevenWen__maplestory_web_phaser_ts/src/main.ts` | [DevenWen/maplestory_web_phaser_ts](https://github.com/DevenWen/maplestory_web_phaser_ts) |
| DemoTileMap | `参考/repos/DevenWen__maplestory_web_phaser_ts/src/scenes/DemoTileMap.ts` | 同上 |
| 资源加载 RPCWzStorge | `参考/repos/DevenWen__maplestory_web_phaser_ts/src/wzStorage/RPCWzStorge.ts` | 同上 |
| AnimationLoader | `参考/repos/DevenWen__maplestory_web_phaser_ts/src/wzStorage/AnimationLoader.ts` | 同上 |
| Avatar 纸娃娃 | `参考/repos/DevenWen__maplestory_web_phaser_ts/src/player/v2/Avatar.ts` | 同上 |
| Rust 纸娃娃交叉参考 | `参考/repos/Sheilem__maplewright/crates/wz/src/paperdoll.rs` | [Sheilem/maplewright](https://github.com/Sheilem/maplewright) |
