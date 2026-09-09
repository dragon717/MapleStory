## 2026-09-07 默认简体中文与语言入口

- 默认简体中文；页面提供简体中文/English 选择并保存偏好，URL lang 优先。禁用本地存储时仍可通过 URL 切换。
- 地图、NPC、道具、任务与对话的源文本在显示边界使用 OpenCC 转简体，不改用户输入、标识或源资料。登录页和页面外框补齐英文文案；图片内嵌文字及缺少英文翻译的源内容仍需单独本地化。
- 新增 i18n.check.ts，默认值、偏好优先级与繁转简检查通过；TypeScript 与 Vite 构建通过。只更新静态客户端，未重启游戏服务或修改账户库。

## 2026-09-07 TMS273 运行迁移

- 恢复缺失的 34 个前端源文件并核对 Git 索引 SHA；以本地 TMS273.7 WZ/MS 与 WZ_JSON_TW 建立可重跑导出管线。前端 TypeScript/Phaser/Vite，后端 Rust/axum/SQLite，保持现有 WebSocket 权威模型。
- 17 张地图、52 个 NPC 动画模板、4 个怪物动画模板、48 个怪物出生点、43 个活动 NPC 出生点、3 个商店与 54 个道具完成装配。StatusBar3、UITotalMenu、Quest、UIInventory、UIEquip、现代对话及聊天面板使用 273 源素材；背包后端容量仍为 24 格，额外显示格禁用。
- 角色使用同版武器、zmap 与命名锚点；修复多帧地图对象、镜像原点、前景层级、字符串帧延时及攻击淡出，移除旧地图绘制补丁和硬编码道具文案。怪物防御按同版百分比处理。
- 任务采用用户指定的原版冒险家 363xx，导入 63 条；缺执行源的任务明确不可执行并由服务端拒绝，未编造剧情。初始玩家属性是兼容实现，EXP 表缺源，完整升级与剧情仍未完成。
- 用户明确不保留旧账户：删除 server/data 下 accounts、qa-gameplay、qa-gameplay-round2 的 SQLite 主文件及 WAL/SHM，以及本次 pre-tms273 备份。启动器和后端默认统一为新库 tms273.sqlite3；首次启动读取账号数 0，未创建验收账号。
- 新目录 public-tms273/dist-tms273，v0.4.0 / protocol 6 / tms273-1。前后端构建、72 项 Rust 单元测试、动画/锚点/状态栏检查及数据装配检查通过（10,169 条素材引用，1,564 个独立文件）。3010 health 实际返回 ok=true/tms273-1。
- 当前服务 PID 7149 / exec session 27469。工具环境会回收已退出包装器的 nohup 子进程，本次改用持续会话运行；一键脚本仍可在用户终端使用。bot 凭据缺失，未创建替代账号；用户图形实玩未代测。

# 已完成历史档案

更新：2026-09-07。仅保存完成结果、验证证据和必要决策；当前待办在PLAN.md，长期规范在BUSINESS_DEVELOPMENT.md。新任务不默认全文读取本档案，只在相关追溯时读取。


## 2026-09-07：Codex GPT-6 技能、规则与 memory 适配

- 删除20个已失效的产品错配、重复或占位技能；4个旧办公备用入口保持停用，默认使用当前官方办公插件。保留技能修正工具契约、项目范围、授权及错误示例。
- 清理190条一次性历史命令许可，保留原有29条可复用前缀；模型、推理档位、权限模式及hooks保持原值。全局UTF-8和Luna/max子代理偏好保留。
- 修复memory的只读授权与跨项目套用问题，保留历史任务和引用；新增项目AGENTS入口并标注83历史文档边界。本轮未改游戏源码、数据库或服务。
- 验证包含真实YAML解析、TOML/规则比对、UTF-8、memory历史完整性及Codex原生加载；不等于游戏、OCR或办公产物的端到端验收。原始文件压缩归档到技能发现目录之外，明文备份目录移除。
- 详细变更与验证：`/Users/muniao/.codex/visualizations/2026/09/07/01a07bb1-4396-72a0-8cf6-2a58cc989009/codex-gpt6-applied.md`。

## 2026-09-05：参考项目与GMS83资源核验完成项

- 原始目标已确认经典端游冒险岛，Web TS/JS前端、Rust单主机LAN，不使用Godot作为实现引擎。参考代码只用于工程/规则/资源研究，组合式模块、先运行后优化，不照搬Java深继承。
- 14个参考库已浅克隆、固定原提交并留来源/许可证/实际资源统计；不重复下载包或克隆。具体项目分级、提交与用途见REFERENCE_PROJECTS.md及references/evidence/repository-inventory.json，早期参考仓库详细信息保留在这些既有专题记录。
- MapleStoryUnity/wzData索引的GMS83包83.zip已取得，精确1,752,051,975字节，17WZ解压总1,973,916,727字节，17/17成员CRC/大小通过。无远端SHA256对照，不虚构与发布方hash一致。
- 16个PKG1 WZ按v83解析、16,821 IMG遍历；List.wz按特殊格式完整读取371条，13,336字节，原先PKG1越界为读法错误。544,718 Canvas和724,843 UOL是节点总数，不等于全部唯一PNG/引用验收。
- 音频修复每WZ重置序号造成的24条覆盖，生成3,980唯一播放文件（3,940 MP3+40由源PCM封装WAV），payload SHA均与原审计一致；3,980/3,980 ffmpeg完整解码，0失败。40条PCM原先32条被ffprobe误判为MP3；原始PCM保留，时长误差<1ms。报告与复跑脚本见references/evidence/gms83-verification.md、gms83-audio-repair.json、gms83-audio-decode.json。
- 完整Mob9300348/move6帧、body/arm/head stand1与Basezmap/smap抽检完成，13唯一PNG/15次RGBA解码；代表性纸娃娃和蘑菇村导出125活动PNG、298图层（265tile/27obj/6背景）、83foothold。帽发按Cap vslot=CpH1H5与smap hairOverHead=H1修复，过滤证据入manifest。独立浏览器截图/12秒录像见references/evidence/browser-asset-probe.md。未宣称全衣柜/全地图/全部Canvas呈现正确。

## 2026-09-05：首个可运行版本与开发验收

- 已选Phaser3.90+TS5.9+Vite7.3，Rust axum+rusqlite/SQLite+Argon2id；一张GMS83蘑菇村000010000、多个独立账号、登录/注册、移动/跳跃/普攻动作。普通结构体/模块，不叠加ECS。主世界唯一拥有者按50ms tick顺序处理输入/模拟/广播，网络/认证IO不直接写世界；分片/并行模拟/分布式未来先讨论。
- Rust2项单测、cargo check/build/fmt通过；前端build/check通过。真实双账号HTTP/WS自测7项通过：身份互见、移动跳跃远端状态、双方普攻、重复请求原action不重播、伪造角色/坐标/damage拒绝、输入超时停止、断线移除与重连幂等。证据evidence/bot-selftest.json含双方快照/seq/tick/事件，不存凭据。
- 生产3000浏览器真实注册/登录qa_frontend，与demo_bot_mto1lpaf同图，普攻和离地跳跃截图已检查，帽/脸/草地脚点可见。最终截图client/evidence/final-world.png和final-jump-attack.png；旧过程截图不能代替最终帽发依据。前端详细记录client/evidence/VALIDATION.md，综合evidence/MVP_ACCEPTANCE.md。工具未主观听音；键盘快速按放不冒充持续移动量化测量。
- 当前原版武器sfx已实读swordS，BGM FloralLife与攻击音频加载/播放路径接入。首版只有动作，没有伤害目标/怪物/技能/任务/PVP，后续新增范围不能引用旧检查作为通过。
- 本机http://127.0.0.1:3000和LAN主机http://192.168.1.19:3000的health本机实测ok；另一物理设备可达由用户确认。首版开发验收与用户阶段B分开，不将代理操作冒充用户验收。

## 2026-09-05：用户反馈背景缺口修复

- 根因：导出丢失WZ背景rx/ry/cx/cy/type等，前端把相机相对锚点当作地图世界坐标。已补原始字段、按原版参考相机/重复语义渲染，保持图像与地图比例；未任意拉伸填洞。
- 3000生产浏览器1280×720与1024×640、移动前后验证，蓝底缺口消失，error/warn0，build通过。保留原Rust与bot，用户刷新获取新前端。
- 用户看到第二静止“机器人”已定位为背景验收账号bgfix_260905，该代理明确退出并关闭自己tab；没有第二个bot进程。qa_frontend也已退出，5173开发服务停止。只读pgrep确认唯一node bots/run.mjs demo/PID18720，账号demo_bot_mto1lpaf；未触碰用户角色。

## 运行交接与必要决策

- 旧Rust服务session74226/PID18039；唯一陪测bot session85536/PID18720。当前用户在测试，不重复启动或无故停止；新版在3010验证，最终升级由当前计划协调。
- 首版由Astra medium实现框架，资源Luna max；随后用户明确新治理：Astra high统筹判断/架构/职责，复杂路径验证后Astra medium实现，日常业务与独立测试Luna max。high为本轮落实值，非用户指定max。当前角色边界只以BUSINESS_DEVELOPMENT.md和PLAN.md为准。
- 用户确认按现有原版参考、同版真实素材复刻，视觉1:1；不足记录，不自行补规则。暂定固定死亡/伤害/必掉药被撤回，后续需来源核对。Cosmic为修改服务端，数据不能无说明冒充官方精确表。
- 资源代理恢复/新调度曾返回agent thread limit reached；并发受限时如实排队，保留在途成果。旧已完成代理不虚构为活跃。当前Task根无git提交，不虚构commit。工具/源细节在相关脚本和专题文档。

## 2026-09-05 新版资源与独立运行入口

定向导出Snail100100动作/源info、17种掉落含meso图标、StatusBar121张与Item背包/BtClose/Tab2；224张独立PNG全部经ffmpeg RGBA解码，见references/gameplay-assets/manifest.json。avatar导出增加ladder/rope各2帧250ms；按body.face=0隐藏攀爬脸部，新版装备换原WZ木剑01302000(req0/PAD17/sfxswordL)。scripts/integrate_gameplay.py将资源隔离写入client/public-gameplay，保留旧3000素材；shared/map.json加入原ladderRope。

3010使用独立qa-gameplay.sqlite3已启动，/api/health实测protocolVersion2/contentVersion gms83-gameplay-2；独立QA已收到网络验收入口。此为资源与运行门槛完成，不代表新增玩法/浏览器验收通过。

## 2026-09-05 3010第二轮独立验收实证

独立QA网络探针通过认证/伪造字段/旧seq、同怪双攻、普攻重发去重、EXP、随机掉落、拾取一份奖励与重放、断线重连：evidence/qa/2026-09-05T16-35-round2/network.json。该轮仍是最后击杀者奖励实现，不替代后续贡献分配补丁验收。

自然接触HP50→49、无敌窗口与三只怪物死亡后全新ID重生通过：evidence/qa/2026-09-05T16-35-contact-round2c/contact-respawn.json。两次自然受击至死亡各约104秒，死态禁止移动/攻击，复活回630,365/HP50/MP不重置，旧请求不能复活下一次死亡：evidence/qa/2026-09-05T16-35-revive-round2b/revive-e2e.json；无改库/伪造HP。

基础横竖屏、运行时resize、HP/HUD/背包窗口通过；独立QA同时确认右下按钮原gap36,-9,-9与390无聊天入口，缺陷证据evidence/qa/2026-09-05T08-40-36-516Z/right-buttons-defect.md；修复最终回归仍见PLAN。源资源继续补齐到296PNG（GameMenu/ShortCut/Notice/BtOK）并增加原body.dead，完成导出与解码不等于视觉验收通过。

## 2026-09-05 本轮前端收尾与验收方式调整

前端完成原素材响应式HUD、数据列表驱动按钮组、聊天输入空壳、物品背包、原Notice死亡确认、ladder/rope区分和静止帧、怪物脚点翻转，以及已实现的轻量GameMenu/ShortCut。最终 npm run build（含TypeScript）通过，仅更新client/dist-next；入口JS index-83bB_cWo.js、CSS index-BqYDsFfu.css，旧client/dist保持。

按钮默认4个，测试入口支持?qaHudButtons=8、附加&qaHudColumns=4或&qaHudColumns=8；最终8列宽屏按源尺寸使用446px单排，窄屏换行。最终8列改动仅构建检查，未新增截图验证。真实死亡/复活视觉、梯绳/下跳运行时仍交用户验证。

此前独立浏览器检查证据位于evidence/qa/2026-09-05T16-35-browser-default-round2b、browser-8-round2b与browser-8cols4-round2对应目录：默认按钮及8个/4列布局顺序、间距、横竖屏与resize通过。该记录不替代最终8列布局及后端新补丁验收。

用户取消后续独立QA，测试任务已停止，没有创建3011，也没有为验收重置当前数据库。3010陪测demo_bot_mto5qohf已认证连接（PID50689/session13127），与旧3000的demo_bot_mto1lpaf各一只；bot在死态发送稳定requestId的复活意图。用户当前会话、数据库和服务均保留，最新后端是否部署以PLAN.md为准。

## 2026-09-05 后端收尾构建完成（未部署）

后端完成按实际伤害贡献在同一击杀事务内一次结算EXP、最高贡献掉落归属、梯绳l/uf与ladder/rope动作、Down+Space组合优先、复活请求重放及跨死亡幂等补丁。前轮15项Rust测试通过，后续Snail停走/连续平台改动新增2项定向测试通过，cargo check与cargo build通过；不把round2旧网络测试当作这些补丁运行验收。

Snail按参考STAND/HIT转随机方向MOVE，MOVE随机站/左/右，源动画对应1700/1800ms决策窗；跨prev/next必须端点几何连续，遇链尾/间隙/竖墙转向。掉落分母保留999999，对齐Cosmic nextInt(999999)实际行为；队伍额外EXP、white EXP与underleveled加成不在本轮范围。

后端二进制已构建，3010服务和用户数据库没有重启或更改。实际上线与用户运行验收待协调，当前运行身份和限制见PLAN.md。

## 2026-09-05：3010 死亡弹窗无法复活缺陷修复

用户实际试玩发现死亡弹窗显示 HP 0/50，但点击 OK 后无法复活。根因是客户端 `Connection.send` 在 WebSocket 尚未打开时静默丢弃 revive 请求，而死亡按钮已经永久置为 disabled；旧服务返回通用 `rejected` 时，客户端也没有清除 pending request。另将死亡弹窗宿主在显示时显式设为可点击、隐藏时设为不可拦截，避免 overlay 命中歧义。

修复涉及 client/src/network/session.ts、client/src/features/notice/death.ts、client/src/app/main.ts、client/src/app/style.css：发送结果现在返回布尔值，发送失败保留可重试按钮并提示连接状态；匹配的 rejected 会释放 pending；reviveResult 继续按 requestId 处理。`npm run build`（含 TypeScript）通过，3010无需重启；当前静态入口为 dist-next 的 index-DPxYgAqH.js / index-LTTRGTn1.css，用户刷新后亲测。账号、数据库和服务均保持。

## 2026-09-05：3010 最新后端升级完成

用户明确授权直接升级，停止旧 3010（PID45771）及其陪测 bot（PID50689），启动已构建最新后端（PID54894/session75264），未触碰旧 3000（PID18039）及其 bot（PID18720）。启动日志确认 `content=gms83-gameplay-2, tick=50ms, attack=800ms`；`/api/health` 返回 protocol 2 / gms83-gameplay-2；静态入口提供复活修复 bundle `index-DPxYgAqH.js` / `index-LTTRGTn1.css`。

升级前 `server/data/qa-gameplay-round2.sqlite3` 完整性检查为 `ok`，含 21 个账号和 21 份角色存档；升级未重置数据库。启动新版唯一陪测 bot `demo_bot_mto6nl8x`（PID54951/session24537）完成真实认证并保持连接，新增一份预期陪测账号使当前计数为 22/22。用户旧 token 因进程升级失效，需刷新 3010 后重新登录；未运行独立 QA 或全量网络测试。

## 2026-09-05：一键入口、资源归档与本地提交完成

根目录 `启动3010.command` / `关闭3010.command` 已通过 `zsh -n`、启动幂等、优雅停止、端口归属和重复执行检查；脚本只管理新版3010及唯一陪测bot，控制目录权限700，bot凭据权限600。当前新版服务PID57199、bot PID57209，`/api/health` 为 `protocolVersion=2` / `contentVersion=gms83-gameplay-2`，bot保持TCP连接；数据库完整性 `ok`，当前24个账号及已有角色存档均保留，未重置数据库。旧3000及其bot已停止，`server/data/accounts.sqlite3` 未删除。

原始资料已集中到根目录 `参考/`（原始WZ/压缩包、第三方仓库、工具与采集证据）；已导出的处理结果移到 `resources/gms83-export`，共8005个文件、717M。运行资源归档 `MapleStory-运行资源-2026-09-05.tar.gz` 共10837个条目、723452060 bytes，SHA-256为 `bfdcfc7e306ffaeac8a43b71a93558e358c372a7559acd8b434d9d5a0ae05383`；已验证不含 `参考/`、`.git`、数据库、凭据、依赖和编译产物。README已写明从仓库根目录用带引号UTF-8路径解压的命令及目录内容。

本地Git仓库按约定完成三批提交：前端、后端、公共/文档/脚本资源各一批；仅本地提交，无远程仓库和推送。运行时数据库、凭据、构建产物、媒体和`参考/`继续由`.gitignore`排除。

## 2026-09-05：3010 梯顶平台落地修复

用户反馈角色沿梯子到达顶端后落不到平台。根因是服务端把角色停在 WZ ladder top（当前地图为 y=127），下一帧 `ground_below` 只接受不低于角色的地面，因而漏掉同一 x 处的上方支撑 foothold（y=125）并进入下落。修复沿 `network.rs → World::command → World::step → step_player` 调用链处理 `uf`：允许上行的梯顶在源五像素探测范围内解析 authored foothold，并在同一 tick 设置 x/y、grounded、foothold、vy=0、退出 climbing；无支撑时保留源端点下落行为，`uf=0` 与顶端下行继续停在梯上。没有写死地图坐标，也没有改客户端、账号或数据库。

新增梯顶落地、释放/继续上行后横向稳定、禁止顶端退出三项定向断言；`cargo fmt --check`、`cargo check`、`cargo build` 及梯子测试 3/3 通过。使用 `关闭3010.command` / `启动3010.command` 受控替换服务：新服务 PID63131，唯一陪测 bot PID63159，health 为 protocol 2 / `gms83-gameplay-2`，bot 保持 TCP 连接，3000 无监听；数据库完整性为 `ok`，账号/角色计数 24/23，未重置。用户需刷新 `http://127.0.0.1:3010/` 并重新登录后亲测。

## 2026-09-05：3010 地图底部跳跃穿透与防坠落兜底（首版）

用户反馈角色在蘑菇村底部小台阶/平台连接处跳跃下落时可能穿过底层并持续坠出。根因是 `step_player` 只在移动后的单一 x 调用 `ground_below`，大步长或边缘移动会跨过窄 authored foothold；原有越界处理又只等到 `map.bounds.y_max` 后重置，缺少源地图的底边恢复。修复沿 `network.rs → World::command → World::step → step_player` 调用链加入 from/to x+y 的下降扫掠，排除竖直墙、插值斜坡并跳过 `drop_fh`；边缘离台不会在 t=0 重新落回原平台。底部边界采用 HeavenClient `max(foothold.bottom)+100`，再受 `map.bounds.y_max` 限制；越界回出生点处 authored foothold，清零速度、grounded/foothold/climb/ladder/drop/input 临时状态，不改 HP、奖励或账号存档。

定向自检覆盖最低层跳起回落、窄平台/大步长扫掠、边缘离台、越界恢复后下一 tick 稳定；相关新测试通过，Down+Space 测试 1/1、梯顶回归 3/3 通过。`cargo fmt --check`、`cargo check`、`cargo build`、`git diff --check` 均通过。使用 `关闭3010.command` / `启动3010.command` 受控替换服务：新服务 PID66754，唯一陪测 bot PID66782，health 为 protocol 2 / `gms83-gameplay-2`，bot 保持 TCP 连接，3000 无监听；SQLite integrity 为 `ok`，账号/角色计数 24/23，未重置。用户需刷新 `http://127.0.0.1:3010/` 并重新登录。

## 2026-09-05：3010 底部回落根因复核与发布标识

用户复验首版后仍能从底部窄台阶“当前位置跳一下”进入无平台区域并看到角色反向回落。复核确认旧逻辑在源底边 `max(authored foothold bottom)+100`（本图为 y=705）处直接重置到出生 y=365；前端 `PlayerView.update` 对快照直接 `setPosition`，所以这是服务端出生点跳变在画面上的表现，不是插值误差。保留首版的下降扫掠、Down+Space 和梯顶落地规则。

服务端 `Player` 增加内部 `last_foothold_id` 保存最近有效非墙 authored foothold。越过源底边时优先将 x 夹回该 foothold 区间、恢复其地面 y、速度和 grounded 状态；只有没有有效支撑时才回出生支撑。边界恢复后暂时吞掉持续横向 heartbeat，直到中性输入，避免按键保持立即再次离台循环。新增 authored foothold 回落稳定与无支撑出生回退断言；`cargo fmt --check`、falling 定向测试 3/3、边缘 1/1、跳跃 1/1、Down+Space 1/1、梯顶 3/3、`cargo check`、`cargo build`、`git diff --check` 均通过。

3010 使用 `关闭3010.command` / `启动3010.command` 受控升级到修复 binary：服务 PID69704，唯一陪测 bot PID69731，health 为 protocol 2 / `gms83-gameplay-2`，bot 保持 TCP 连接，3000 无监听；SQLite integrity 为 `ok`，账号/角色计数 24/23，未重置。随后只重建 `client/dist-next`，未再次重启后端；Vite 从 `client/package.json` 读取真实版本 `0.1.0`，在构建时按 Asia/Shanghai 固化秒级时间。当前页面左上发布标识为 `v0.1.0 · 2026年09月05日 19:30:24`，前端 `npm run typecheck`、`npm run build`、`npm run check` 均通过。用户刷新 `http://127.0.0.1:3010/` 并重新登录后可看到发布标识并亲测底部回落。


## 2026-09-05：原版物品栏与装备业务

按本地 GMS83 Item / Equip 素材及参考源码恢复小/展开物品栏、五类独立槽、装备栏、I/E 快捷键、拖拽/合堆/交换/整理排序、数量丢弃与金币丢弃，默认中文并支持 `?lang=en`。当前已接入的 16 种道具使用本地 WZ 元数据，包含药水、装备、卷轴和怪物卡片；装备提示读取实例强化属性。

Rust/TypeScript 协议同步升级到 3。SQLite 原子处理使用、穿脱、强化、丢弃、拾取、图鉴及请求去重；装备最终属性与剩余升级次数随全部流转保存，并参与战斗属性计算。拾取成功后在线快照同步重载，避免卡片误入背包和强化属性暂时丢失；卡片数量饱和 5，第六张仍消费。旧 schema / 中间 schema 迁移拆分超限堆叠，容量不足时回滚保留原数据。内存世界同步支持卡片、卷轴及强化装备丢弃往返。

必要自检：Rust 46/46、cargo fmt 检查通过；新增回归覆盖 Store→World 拾取、强化实例往返与重启、卡片饱和、药水单个扣除、卷轴错误目标不扣、装备操作重发以及超限旧堆叠迁移。中文/英文、元数据与提示自检通过；无账号修改的浏览器组件检查覆盖原版小/展开布局、I/E 独立窗口和卷轴负装备槽请求。实际游戏内体验仍由用户验收。


四种已接入装备按 WZ 原始锚点、zmap/smap 和衣帽遮挡规则导出 12 种合法组合；显式空装备不再显示固定帽/上衣/武器，长袍遮挡裤子，己方和远端统一跟随 equipped 快照，无武器时停用剑光/剑音。复用现有导出器并实际集成 173 张源 PNG，组合引用的 127 个纹理路径全部存在；基础身体、脸、发型、裤子和鞋仍沿用现有角色外观，未扩展未接入的装备目录。

最终 Cargo/Vite 构建通过。以独立进程组运行既有 `启动3010.command` 完成受控升级：服务 PID22806、唯一 bot PID22870，health `ok=true / protocolVersion=3 / gms83-gameplay-2`，前端 `v0.2.0`、入口 `index-DTjhyyJb.js`。公共 manifest 包含 41 个装备窗口帧和 12 种外观组合，抽查原 PNG HTTP 200；线上首页与本次 dist 完全一致。数据库账号/角色数保持 25/24，完整性通过，备份位于忽略目录 `evidence/runtime/3010-control/pre-inventory-v3.sqlite3`。用户需刷新并重新登录；未替用户进行实际游戏操作。


## 2026-09-05：参考复刻 v0.2.1，彩虹村至南港路线

按本地 GMS83 WZ/XML 新增 `001010000` 训练场入口、`001020000` 命运岔路、`002000000` 南港、`002000001` 防具店，地图由 19 增至 23；保留源图层、foothold、梯绳、门目标与 BGM。002000000 经 String.wz 确认为同岛南港，不误判为岛外。地图目录加入 I 背包提示，原装备 12 组合及 41 个装备窗口帧保持。

参照 HeavenClient `Stage::send_key/check_portals`，普通/隐藏门改为按 ↑ 进入；touch 类型保留自动触发，冷却防重复，攻击/死亡/加载中不进门。输入框、失焦及断线不发传送请求，↑ 仍发攀爬输入。修复 portalResult 拒绝时误触资源失败回调、关闭连接的问题。参照 `DamageNumber.cpp` 修正相邻后续数字平均间距和首个后续数字 +2 的上下交错；暴击首位保持 base+8，缺暴击资源回退普通间距。

必要检查：input.check.mjs、portal.check.mjs、damage-number.check.ts 通过；TS 类型检查、Rust generated_map_catalog_loads_all_rendered_maps / portal_command_changes_map_and_snapshot_scope、git diff --check 通过；Cargo/Vite 构建通过。未运行独立 QA、额外账号探针或代替用户游戏操作。

既有启动脚本受控更新 3010：server PID31163、唯一 bot PID31224，协议3，入口 index-Db_VXX-2.js / index-D0RTgpKK.css；发布标识 v0.2.1 · 2026年09月05日 23:11:32。首次脱离会话的构建因 Python 子进程继承 Rosetta 架构使 xcrun 链接失败，旧服务未停止；以 arm64 启动同一脚本后成功。health、线上首页与 dist 一致、23图 manifest、新增四图各一份源图 HTTP200；数据库完整性 ok，账号25/角色24未变，备份 evidence/runtime/3010-control/pre-reference-v021.sqlite3。3000无监听。用户刷新重新登录后亲测。

地图可进入不代表 NPC/商店/任务/原版怪物出生业务已完成；这些仍按参考清单继续，未把测试 Snail 布点冒称原版 life。

## 2026-09-05：参考复刻 v0.2.2，原版怪物 life 出生（168/8）

按本地参考 `参考/repos/P0nk__Cosmic/wz/Map.wz/Map/Map0/*.img.xml` 的 `life` 与 `references/gameplay-assets/manifest.json` 复刻原版 v83 怪物出生：`scripts/generate_life.py` 生成 8 个怪物模板（100100, 100101, 120100, 1210102, 130100, 130101, 210100, 9300018）与 168 个 authored spawns，分布于 9 张地图（000040000/1/2、000050000/1、001000004/5/6、001010000）；出生地图 000010000 保持 0 只（测试 Snail 已移除，未冒称原版 life）。资源经 `scripts/integrate_gameplay.py` 并入 `client/public-gameplay/assets`，公共 manifest 含 8 怪物、monsterPngCount 198、monsterDropCount 162。部署读取 `evidence/runtime/gameplay-round2.json`（contentVersion `gms83-gameplay-2`），由 `shared/gameplay.json` 同步。

受控更新 3010：既有 `启动3010.command` 一键重启（先 `rm -rf client/dist-next` 规避 vite genie-trash 超时），server PID52074、唯一 bot PID52087，协议3，contentVersion `gms83-gameplay-2`，入口 index-CXyqIO1u.js / index-D0RTgpKK.css；health `ok=true / protocolVersion=3 / gms83-gameplay-2`。8 个怪物模板素材 URL 抽查全部 HTTP 200（含 9300018 的 `Mob.wz_9300018.img_move_0.png`，注意其 ID 无前导零）。服务端 `spawn_configured_monsters` 对每个 spawn 用 `?` 传播，任一失败即不监听，故“已监听+contentVersion 正确”即证明 168/8 全部出生。数据库账号 25 未变、完整性 ok；备份位于忽略目录 `evidence/runtime/3010-control/pre-originalspawns.sqlite3`。用户刷新重新登录后亲测。

关键沙箱纪律（下轮必看）：① 原生 `关闭3010.command` 的 `is_server_pid/is_bot_pid` 依赖 `ps -p PID -o command=`，本沙箱返回空 → 误判“非本项目实例”拒绝停止、且一键脚本末段自验失败退出码 1 为假阴性；进程仍经 nohup 拉起保活，终以 lsof/health/日志核验。② 直接 Bash 内 `nohup … &` 进程会在调用返回后被回收，必须经 `zsh 启动3010.command` 拉起才会持久。③ Node 走 localhost 受 Clash 代理影响，bot 需 `NO_PROXY=127.0.0.1,localhost`。④ `already_connected` 根因是旧 bot 被 kill 后其 WS 的 Leave 尚未处理、新 bot 即 Join 的竞态；以“全新 server（空 World.players）+ 单 bot”可彻底规避，无需改代码。


## 2026-09-06：任务体验完善 v0.3.0（gms83-quest-1 / protocol 5）

按 Cosmic v83 参考复刻任务体验：以真实 v83 任务 **1021 Roger's Apple**（Roger/2000 发起，出生图闭环）为主干，叠加已有 maple-road-training 机制校验链。共享 `shared/protocol.ts` 与 Rust `server/src/protocol.rs` 协议升级到 5（CONTENT_VERSION `gms83-quest-1`）。

服务端（Rust）：
- `npc.rs`：条件新增 `hpAtLeast`；`QuestEffect::Start/Complete` 进入时结算。`DialogueContext` 扩展后授权世界内部调用（新 `ctx_quests` 供测试）。移除旧写死的 `quest_reward_mesos`。
- `world.rs`：`Gameplay` 新增 `quests: Vec<QuestDef>` 与解析，字段随字面量初始化补全；`apply_quest_effect` 重写为按 QuestDef 目录结算：start 检查 `start.hpCap/hpCapIfAbove` 与 HP 要求、按 `grantItems` 发放入场道具；complete 校验 `hpAtLeast`（或经持久化任务状态）、发 mesos/exp/物品（物品用既有 `add_items` 幂等合并），再 `persist_player`。保留 available→active→completed 幂等转换约束，重复交付不发二次奖励。
- `inventory.rs`/`auth.rs`：`add_exp` 由私有改 pub(super) 供 world 调用（auth 模块内），升级按 expTable 权威结算，快照随在线消息下发。
- 测试：world.rs 新增 quest 定向测试覆盖 start 发 Roger's Apple、complete 条件拦截、exp/物品奖励与二次交付幂等；fixture contentVersion 同步 `gms83-quest-1`。

客户端（TS）：
- 新增 `features/quest/log.ts` QuestLogView（任务日志，Q 键开合）；input.ts 注册 Q；main.ts 接线：quest 消息/日志状态推入、进入地图时全量请求、登录/登出与离场清理；任务接受/完成聊天提示含奖励文本（`Obtained …`）；样式追加羊皮纸日志面板（style.css 尾部）。
- 数据/素材：`scripts/export_rogers_apple.cjs` 从 Item.wz Consume 导出 2010007 Roger's Apple 图标并更新两份 manifest；`shared/items.json` 增补 2010007（consume/hp30 镜像 Apple）；`shared/gameplay.json` 与 `evidence/runtime/gameplay-round2.json` 增补 quests 目录（1021 与 maple-road-training）并覆写 Roger(2000) 对话状态机为 1021 流程。
- 必要检查：Rust 全量测试通过、cargo fmt、cargo build 成功；TS typecheck、`npm run build` 产出 v0.3.0。

受控更新 3010：经 `启动3010.command` 重启（server PID1904、bot PID1921，health `ok=true / protocolVersion=5 / gms83-quest-1`，bot 维持 TCP 连接）。沙箱纪律同前：启动脚本末尾自验在该沙箱假阴性退出（退出码 1），服务与 bot 均由 nohup 拉起独立保活，以 lsof/health 核验为准；勿在调用返回后 kill 包装进程组，否则连带回收服务（本次 882/903 即因清理保活 wrapper 被连带回收，重新后台拉起 1904/1921 解决）。数据库沿用既有 QA 库未重置。

## 2026-09-06：任务多语言 M3 v0.3.1（gms83-quest-2 / protocol 6）

任务显示文本改为**服务端权威多语下发**：服务端加载 `shared/quest-text.json` 语料目录（新 `quest_text` 模块），Join 后推 `questList`、任务 start/complete 转移后推 `questUpdate`，name/summary 按玩家语言（hello 携带的 `lang`，zh 缺省/en 显式）解析，en→id 兜底。客户端 quest log 删除本地 `questTextMap` 映射（`quest-text.generated.ts` 移除）只渲染服务端文本。

服务端（Rust）：`quest_text.rs`（新增）、`protocol.rs` Hello `lang` + protocol 6、`network.rs` lang 透传 Join、`world.rs` Player/Command/World 挂 lang 与语料目录 + questList/questUpdate 推送、`main.rs` 注入语料。客户端（TS）：`shared/protocol.ts` v6/`gms83-quest-2`、`session.ts` hello 带 `lang: uiLocale()`、`quest/log.ts` 直渲服务端文本。

必要检查：`cargo test` 65/65（quest_text 4 单测 + world 3 集成）；`npm run typecheck` PASS；`git diff --check` 干净。运行文件同步 quest-2：`evidence/runtime/gameplay-round2.json`、`client/public-gameplay/assets/manifest.json`、`references/gameplay-assets/manifest.json`。

受控更新 3010：health `ok=true / protocolVersion=6 / gms83-quest-2`（server PID38678、bot PID38742 维持 TCP）。上线验证：双语 questList e2e 探针（新增 `qa/quest_i18n_probe.mjs`）en/zh PASS（1021 Roger's Apple/罗杰的苹果 等）；`qa/quest_smoke_probe.mjs` 升级到动态协议版本并补 questUpdate 断言，8/8 通过（accept/turn-in 推送 + reward 300 与到账一致）。DB 备份 `evidence/runtime/3010-control/pre-m3-quest-i18n.sqlite3`。M4 校对 reviewed 翻转待推进。

## 2026-09-07：归档已被273取代的旧计划

以下为PLAN迁出的83历史原文，不是当前运行环境或在途代理状态。

## 历史计划（83，已被273目标取代）


更新：2026-09-05。长期规范见 BUSINESS_DEVELOPMENT.md，已完成记录见 IMPLEMENTATION_STATUS.md。

## 正在执行：原版地图怪物

- `/root/life_backend`（Luna max）：server/src/world.rs 唯一写入，mapId/f/mobTime 出生配置、加载顺序、地图隔离与刷新检查；不动协议/素材。
- `/root/life_assets`（Luna max）：scripts/export_gameplay.cjs、export_inventory.py、参考素材manifest与shared/items.json；8种怪物动作/源信息和对应掉落图标导出，不动服务端/整合脚本。
- root：WZ/XML→玩法配置生成、integrate_gameplay.py、前端整合、最终定向检查及受控更新；保留既有修改。

## 实际剩余

| 剩余项 | 负责人/依赖 | 完成条件 |
| --- | --- | --- |
| 新手区域原版 life 与怪物 | root 编排，后续 Luna max 业务代理 | 按各图 WZ life 接入对应怪物、坐标、刷新与掉落；现有测试 Snail 布点不能当作原版完成 |
| NPC、教学脚本、任务与商店 | root 按参考确定逐项范围，后续 Luna max | 读取对应同版脚本与 Check/Act/Say 后接入权威业务；不把地图及店铺背景可进入当业务已实现 |
| 当前版本用户亲测 | 用户；反馈由 root 分给对应业务代理 | 新路线、普通/隐藏门按 ↑、触碰门、伤害数字、原有装备物品栏、梯绳/下跳与战斗体验 |

本轮两个 Luna max 子代理完成战斗参考核对和地图资源接入；root 完成进门触发/可恢复失败、整合与受控更新。具体成果及检查见历史。本目标“继续按参考去复刻”仍有以上业务差距，不宣称整套复刻完成。

## 当前运行环境

- 新版：http://127.0.0.1:3010/；协议3，客户端 v0.2.1，构建时间 2026年09月05日 23:11:32。
- server PID31163，唯一陪测 bot PID31224；原入口脚本托管。旧3000无监听。
- 数据库 server/data/qa-gameplay-round2.sqlite3，账号25/角色24，完整性 ok；升级备份 evidence/runtime/3010-control/pre-reference-v021.sqlite3。升级使内存 session 失效，需刷新并重新登录。
- 静态目录 client/dist-next，入口 index-Db_VXX-2.js / index-D0RTgpKK.css；资源 client/public-gameplay/assets。
- 地图共23张，出生点000010000，新增已证实的001010000、001020000、002000000、002000001。脚本训练入口和离岛NPC作为后续业务边界。
- 固定配置 evidence/runtime/gameplay-round2.json、map-round2.json、shared/maps.json；保留账号/存档与唯一bot。

## 验收边界

仅执行实际改动所需的编译和针对性自检；不启动独立QA、不创建3011、不运行额外网络账号探针。用户实玩未测不标通过。每个可运行阶段用既有脚本受控更新3010，保留数据库、真实版本和秒级构建时间。完成事项移入历史，不重复建台账。

## 2026-09-07：研究包对照与输入交互补齐

- root按当前规范将研究包M0–M5与已有模块对照，更新BUSINESS_DEVELOPMENT来源采用规则、PLAN唯一后续计划；83旧计划完整归档，不再冒充当前服务状态。保留原版冒险家剧情选择，不将原创/压缩成长提案自动投入正常流程。
- `/root/quest_reference`（Luna max，只读）确认：本地106个quest脚本不含q363；63条363xx仅有Check/Act/Say与引用，全部executable=false、空转换/零奖励，expTable为空；研究包未补执行脚本。现有NPC→QuestEffect→World→SQLite链可复用，下一内容切片q36301仍依赖真实q36301s/e/x或足够客户端行为证据。
- 读取研究正文、工单、backlog、HTML图卡及8页PDF文本。PDF明确0张嵌入截图，39个远程入口；主报告S01…与图集S01…不是同一来源编号。共享链接网页仅返回登录壳，浏览器尝试超时；没有声称读到共享正文或逐图视觉核验。
- `/root/input_interaction`（Luna max）修正PlayerInput的Q/空格抢占输入、已消费事件与IME穿透，增加UI所有者isBlocked回调；阻塞时释放移动/拾取，不自动恢复旧按键。root接NPC/商店/死亡状态，增加NPC的Esc退出、重复打开保护，断线/切图清理和过期回复拒绝；不修改服务器规则/数据库。
- 定向验证：`node client/src/features/player/input.check.mjs`、`node client/src/features/npc/dialogue.check.mjs`、`npm run typecheck`均通过；输入检查包含无focus事件的模态开启后心跳归零、关闭不恢复旧键、停止连续拾取。两个check已接现有npm check入口。
- Vite生产构建通过（37模块，保留现有大包提示）；输出index-BHTetyjh.js、index-087gBNyo.css。构建在tmp/research-client完成，再复制哈希资源并原子替换client/dist-tms273/index.html，旧静态资源保留，未重启服务或创建账号。源版本仍v0.4.0，构建带实际秒级时间。
- 未执行独立QA、在线账号/网络探针或图形实玩；用户待验聊天Q/空格、NPC/商店与死亡界面不触发移动/攻击/拾取、Esc退出、切图/断线清理。此轮不代表M1手感、M2首章或完整273复刻已经通过。


## 2026-09-07 装备选择与法师→冰雷路线确认

用户确认首个完整职业为法师→冰雷，继续原版冒险家开局。指定调研会话仅返回用户请求；图PDF会话明确是图源索引，未含装备对比成图，不能作为完整视觉验收证据。

装备栏复用273 islot与服务器实例stats，增加同部位当前装备、候选属性和差值；实例0覆盖模板、未装备按0对比，不生成未经核定的战斗力。修正字符串0限制标志；快照更新同步浮层，支持焦点访问、跨间隙悬停与内容滚动。导出UIToolTipNew/Item/Equip/frame/common的top/mid/btm，使用324宽原图（30/1/12高）固定首尾、重复中段。

Luna max实现并通过前端typecheck/check、scripts/check_inventory.mjs；皮肤补充后typecheck与无账号browser-fixture通过。root仅以静态fixture核对三种尺寸和运行中resize：1440×900浮层[595,113,919,348]；844×390为[377,6,701,241]；360×740为[6,147,330,382]且document宽360。确认INT +3、MAD +4、PDD -10以及空部位对比。横屏原有完整背包高度超出视口，本轮浮层在界内；未声称整个背包响应式完成。静态页和临时HTTP服务已关闭，未登录游戏、改库或重启游戏服务。

前端0.4.1构建通过；发布index-DrSPjxwj.js与index-DWE7wKPP.css后原子替换dist-tms273入口，保留旧哈希。构建仍提示大chunk，未扩大为拆包工程。git diff --check通过。在线换装与手感由用户亲测。


法师技能资源：Luna max新增export_tms273_skills.cjs与check_tms273_skills.cjs，选择性解包Skill/200.img至独立临时目录，不覆盖原Mob解包manifest。导出2001008魔灵弹48张PNG与skills.json，保留源文件/图片SHA-256、origin、outlink、原始公式与energyBolt延迟[-60,-330,270]。三个静态图标缺delay明确标注，没有灌入reader的100ms默认值。导出器和定向检查均通过。资源位于现有忽略目录resources/tms273-export，尚未加入运行时manifest；可通过脚本再生成。首轮取证将magicDamage归入info的说法经原始字段检查纠正：info没有该字段，不据此推导服务端公式。没有CD字段不等同于已确认无冷却。解锁、公式执行、命中时间仍未落实，未声称转职或技能可玩。


## 2026-09-07 角色职业持久化（代码完成，在线待应用）

Luna max将职业从全局配置归入Profile/PlayerState与SQLite player_stats.job。缺列旧库显式迁移job=0；新建档才读取Gameplay.player.job，当前273配置为0。保存、读取、奖励事务、Join和profile/state往返均保留角色职业；装备需求及已有普攻/接触派生入口使用角色job。非法DB职业拒绝读取并回滚，不静默改成初心者。未添加客户端改职入口，也没有转职或已学技能功能。

root增加TS可选job字段（协议6增量输出兼容），补inventory_acceptance现有Profile构造点。Rust PlayerState仅序列化，去掉无效serde(default)标记，兼容性由旧客户端忽略新增字段、TS允许缺字段实现。ClientMessage继续deny_unknown_fields，客户端不能上传权威职业。

Luna定向通过四项，每项1/1：character_job_migrates_isolates_and_survives_reward_and_config_changes；client_job_field_is_not_an_authoritative_input；equipment_replaces_starter_stats_and_never_accumulates（角色job优先）；dead_profile_reconnects_dead_and_can_use_revive（登录与profile/state往返）。cargo check通过。root前端typecheck通过，整合后使用/Users/muniao/.cargo/bin/cargo check --quiet通过（shell PATH无cargo，首次裸命令未执行）。git diff --check通过。全仓fmt检查仍存在此前未格式化区块，不为本改动格式化其他文件。

未登录账号、未启动独立QA、未改线上数据库、未重启服务器；在线仍为旧进程，不能声称新职业存档已部署。前端仅类型新增，无运行时代码改动，无需重新发布静态包。


法师执行依据核对（Luna max只读）：同版Skill/220.json确认当前coldBeam技能为2201008，2201004只有String残留；root直接解析原始JSON复核has_2201004=false、has_2201008=true。修正首轮取证旧ID，后续不得按2201004导出。2201008 MP=12+3*d(x/4)、damage=99+5*x、3段6目标；2201005 MP=20+5*d(x/4)、damage=130+8*x、3段6目标。来源数字只作原始公式，不解释d()、不把effect.property.delay=60当服务端命中窗口。

随端script/expand/change_job.js的200→220 Lv30、220→221 Lv60、221→222 Lv100是私服实现参考，尚非官方转职证据。无Java/jar源码；bin/game为Graal native image，未获得可验证公式解释或命中逻辑。当前Attack只有requestId，combat基础动作与world物理区间没有技能等级/MP/魔法路径，后续需明确cast权威边界。没有因为缺证据改成全员法师、满技能或原创新手任务。


## 2026-09-07 技能公式解释器来源核对

root核对WzComparerR2上游固定提交4b691cf55695fd13effdd0ba8f3826a8b6b81552：WzComparerR2.Common/Calculator.cs:341-355将d映射Math.Floor、u映射Math.Ceiling；CharaSim/SummaryParser.cs:63使用Calculator.Parse(prop, Level)生成技能说明。来源：https://github.com/Kagamia/WzComparerR2/blob/4b691cf55695fd13effdd0ba8f3826a8b6b81552/WzComparerR2.Common/Calculator.cs#L341-L355 。这是R类第三方工具的一手实现证据，提升“纯猜测”为可核对的解析兼容依据，不是TMS273官方服务端公式证明；后续可将三条同版技能原始公式按该解释生成参考等级值，须保留来源标签，不引入eval/通用脚本VM。伤害区间、解锁、命中/取消窗口仍独立待证。

读取源码位于忽略目录output/wcr2-Calculator.cs（SHA256 20c5c343827add699b4fe2dbb552ab3ce0ad30525a766a689bd41a9b3eb7d570）与output/wcr2-SummaryParser.cs（c993bf67323ad5db708f4fab04c01d188d10b3be82b6695dbfc511fa39e4dab9）。未复制源码入产品，未安装依赖。Python3.7的HTTPS证书校验失败后改用系统curl正常校验取回，未关闭TLS验证。


## 2026-09-07 冰雷二转技能资源导出

Luna max扩展现有export_tms273_skills.cjs/check_tms273_skills.cjs，隔离选择解包Skill/200.img与Skill/220.img，分别解析_Canvas_035.wz与_Canvas_040.wz。新增2201008冰锥剑41张（图标3、effect13、effect0 19、hit6）、2201005电闪雷鸣29张（图标3、effect14、hit12），共118张含魔灵弹原48张。实际Skill根节点确认不存在的组才标source-missing，存在组的解码/子帧错误直接失败；2201004无Skill节点，不使用残留String替代。

保留全部原始JSON、effect.property、origin/outlink/delay/hash。coldBeam原8帧延迟[-90,-90,-210,-60,60,60,120,120]、thunderBolt原2帧[-300,510]，并保留action/frame/move。只是动画源时序，未当作命中或取消窗口。

导出器与定向检查均通过。root使用扩展前output/energy-bolt-before.json与最终2001008对象全字段比较零差异，确认原rawWz/sourceFields/assets/bodyTimeline未变；查看两条新增技能effect中帧可正常解码。未运行游戏视觉/手感验收，也未把资源接入运行manifest。资源继续存放现有忽略目录resources/tms273-export，通过脚本可再生成；未修改在线数据/重启服务。


## 2026-09-07 用户提醒后的UI原图复核

root重读研究包workstreams/08_UI_UX_AND_ACCEPTANCE.md、03_COMBAT_AND_SKILL_FEEL.md及HTML覆盖/图卡说明。使用bundled pypdf检查PDF全部8页（各页images=0），读取技能相关第2/6页并用pdftoppm渲染/查看第6页。PDF明确C06为通用年代待核，不能仅凭图源索引视为273像素标准。

随后通过Safari实际打开HTML三个原图（未下载远程媒体）：
- C06 https://grandislibrary.com/images/info/skill-expanded-ui.png ，777×360。可见左Hyper Skill Inventory，中央Skill（转职页签、SP、职业条、双列技能图标/名称/等级、滚动条、底部Hyper/Guild/Mount/Note/Macro），右Macro List与Skill Alarm。样本职业Luminous；只作为窗口结构与交互参考，273边框/坐标仍从本地同版节点取。
- A14 https://hackmd.io/_uploads/H1dIjvZsex.png ，481×718。可见深色CHARACTER INFO，上部角色身份/外观卡，下部属性区、战斗力行、HP/MP/基础属性与分组双列统计、滚动条及底部入口。具体数字是原截图角色状态，不复制成项目默认值。
- A13 https://hackmd.io/_uploads/H1NfUbJoee.png ，507×591。实际是TIME/STAGE/SCORE场景画面，含场景人物与FINISH效果，不是属性面板；HTML的“角色／战斗信息候选图一”不能当作属性布局依据。后续引用须附此修正。

web直接图片读取失败；in-app tab创建后截图工具超时，不能据此视为图片失效。改用Safari新标签成功读图，最终关闭本轮Safari新标签，保留用户已有标签。未触及账号/游戏服务。产品UI下一步必须同时携带图卡ID、已核看结构与本地273路径，规则已补入BUSINESS_DEVELOPMENT.md。

原始技能窗口补查：直接读取273的 `UI/UIWindow2.img/Skill/main`，JSON中省略的Canvas在WZ中实际存在。root已逐张查看外框backgrnd（318×361，SKILL标题）、白色内容底backgrnd2（306×333，位置5,22）及蓝色职业条backgrnd3（304×45，位置7,47）。不能把JSON未含Canvas判为窗口缺失，也不采用UICharacterInfo远程角色技能页的2×6几何冒充独立K窗口；格子重复位置与按钮操作仍需对应源证据。此项为源图确认，尚未接入可玩的技能窗口。

2026-09-07 技能资源检查收紧：2001008静态图标原检查使用OR，可能在metadataStatus仍为static-delay-missing时放过非空伪造delay；改为同时断言delay=null及缺失状态，与220两技能一致。运行node scripts/check_tms273_skills.cjs通过，118张现有资源检查通过；不涉及在线资源更新或运行时技能完成。

## 2026-09-07 同版技能窗口资源导出完成

Luna max新增scripts/export_tms273_skill_ui.cjs与check_tms273_skill_ui.cjs，从UI/UIWindow2.img/Skill/main生成windows-skills.json及75个唯一PNG。包含三层底图、140×35技能格、95×16技能点标识、enabled/disabled/selected各7张转职Tab及11组四态按钮；保留origin、outlink、位置、尺寸和源/PNG SHA256，静态缺失delay为null。root复查源图并查看导出的技能格、SKILL POINT标识与加点按钮。

审查修正SkillEx错误路径：它与Skill同为UIWindow2.img下的节点，从已解析子节点判断存在，不捕获任意读取异常后冒称缺源；记录UI/UIWindow2.img/SkillEx/main存在但不泛化为普通展开窗。导出器和定向检查均由实施代理运行通过；未接运行时/未重启游戏，不把素材完成视为技能窗口可用。

## 2026-09-07 三技能逐级源表达式表

Luna max新增scripts/tms273_skill_formulas.cjs：有长度/嵌套上限的无eval计算器，仅支持当前所需整数、x、四则运算、括号、d/u和一元正负号；拒绝未知token、尾部内容、零除、非有限值及非法等级。按已核对WzComparerR2固定提交的floor/ceil语义（R类工具证据），明确JS Number针对当前小整数表达式、不声称通用decimal等价。代理运行内置正常/拒绝边界自检和语法检查通过。

root将其接入export_tms273_skills.cjs，在保留rawWz/sourceFields原表达式的同时输出三技能levelValues，逐级包含MP消耗、伤害倍率、目标上限及攻击段数；manifest附固定来源URL和语义边界。魔灵弹20级为24MP/78%，电闪雷鸣10级为30MP/210%，冰锥剑20级为27MP/199%。check_tms273_skills.cjs加入等级1、取整阈值前后和满级的明确预期值。导出器及检查均通过，原118张资源保留。未生成最终伤害、服务端命中时点、免费技能或SP，尚未接入在线运行时。

## 2026-09-07 学习条件源核对

Luna max只读核对当前TMS273/WZ_JSON_TW：2001008/2201005/2201008的common.maxLevel为20/10/20，节点无req、job、masterLevel；同文件其他技能确有req，不能将未出现req推断为任务解锁已核定。String/Skill的200.bookName为法師入門，220.bookName为冰/雷魔法指南；200/220归属来自技能书路径与命名，不是技能内job字段。

QuestData/1414入口要求job200、lv30及13028/36324任务；1416冰雷分支要求job200、lv30、1414完成并引用q1416s/e，节点没有直接job220写入。脚本缺失，所以不授予职业/技能/SP。QuestData四条Act.sp样本（22518/22527/22531/23026）只涉及2200/2210/3210等其他职业，不能据此确定200/220的SP组/初始点数；私服ScriptAPI.modifySp(skillBook,gain)仅为辅助代码证据。持久化可保存整数映射，业务组键仍待核定。

## 2026-09-07 技能状态存档完成

Luna max在Profile/PlayerState添加skills与skill_points整数映射，SQLite player_stats追加skills_json/skill_points_json并迁移旧列缺失情况。新建无视默认profile中技能值、始终空映射，不赠送技能/SP。load/save、事务read/write、奖励、Join、Profile↔state与重连均保留。root检查主要状态路径与独立损坏case。非法JSON/负数/越界SP分开断言拒绝，客户端伪造skills和skillPoints分别被拒绝；2项定向测试及cargo check通过。root共享协议新增兼容可选skills/skillPoints，前端typecheck通过。未重启线上进程、未执行在线库迁移，也未实现加点/授予/施放。

## 2026-09-08 完整技能书目录与客户端投影

Luna max扩展技能导出器及检查，增加两本技能书17个实际节点（200为8个，220为9个），保留rawWz、String、common、req、info与显示标志；全部三态图标导出，图标缺口为空，3条既有技能和逐级数值表保留。导出与检查通过。2000007、2001012的invisible为1，字段存在标记不再被命名为隐藏状态。

root新增tms273_skill_manifest.cjs客户端投影与定向检查，17节点、三条前置、逐级数值和invisible零值/非零/非法值检查通过。完整assemble脚本接入投影；本轮只增量合并public清单的三个技能字段、复制122个去重素材，保留原有其他数据，未改写shared玩法数据。菜单type11、K键和视图生命周期调用已接入，input检查通过；SkillsView仍在实施，隔离样例已准备，尚未整体构建或发布。

## 2026-09-08 只读技能窗口与前端v0.4.2

Luna max实现SkillView与独立CSS，root接入主菜单type11、K键、快照、断线/退出/资源失败清理；NPC键盘与鼠标入口统一关闭技能窗，避免两条调用路径不一致。两本源技能书可切换，普通目录6+9项，展示服务器等级、原文描述与前置，三技能显示已核定逐级MP/倍率/目标/段数；整个skills字段缺失为未知，存在但无条目为0。SP组未知显示横线，加点/施放及底部未实现功能不可用。内部详情页与CSS重复格子属于网页适配，不称完整原作交互1:1。

审查与页面修正：不再每50ms快照重建DOM导致焦点/滚动丢失；图标子坐标不重复偏移；书名移至蓝条、页签保留原图且完整名称用于无障碍；底部条件式Alarm与Macro重叠，改用同版Sequence所在正常位置；矮屏保留源底边。源描述字面换行及颜色控制符正常清理。

root使用隔离qa/skills_ui.ts（模拟50ms快照，无账号、无网络写入）和本地4187页面，实际检查1440×900、844×390、360×740及运行时尺寸变化，无横向页面溢出，318×361窗口保持视口内；额外844×260时窗口318×248、位置263/6，详情150高、234滚动高，滚动到底84后焦点/滚动在持续快照下保持。核对技能等级5/20与当前MP18/33%、下一等级6 MP18/36%，前置文本无残余控制符，未知与0级区分，K/Esc关闭、断线清除正常，浏览器错误日志为空。视口已重置、检查标签关闭、HTTP进程32742已退出，用户游戏标签和服务保留。

input.check.mjs通过（输入框/重复/Control+K边界）；客户端类型检查及Vite生产构建通过，仅已有大chunk提示。首次最终构建误从仓库根目录运行npm导致找不到package.json，改在client目录后通过。构建先写output/client-build-0.4.2，发布时逐文件临时写入后rename、最后切换index，旧hash资源保留，未重启服务或迁移在线数据库。最终dist入口为index-B3rsZUXu.js与index-DhQhfH6t.css；129个初始资源/入口更新加随后2文件修正。服务器技能状态代码待部署，旧在线服务器下等级显示未知，未伪造已学状态；用户登录游戏内手感与真实存档联动仍待亲测。


## 2026-09-08 技能逐级完整说明与v0.4.3

Luna/max（skill_descriptions）复用现有受限公式解析器，在tms273_skill_manifest.cjs投影catalog的String.h/common为levelDescriptions；17节点中16条有h，2001012无h保持缺失。保留源模板，不修改源JSON；最长字段匹配，允许MP/HP后缀，未知#identifier保留，向量不求值，异常表达式失败，最高等级限制1..100。root在技能详情消费当前/下一等级原文；已有3攻击指标仅作无原文的兼容回退。只清已知颜色标志，不再误删未知占位符首字母。

定向check由该Luna执行通过：魔心防御lv10 MP13/85%、瞬移lv5 MP20/横190/竖295、冰锥剑冰冻8秒、结冰特效颜色符、无h、未知#xyz和非法公式；公式自检通过。root客户端typecheck及生产build通过（仅既有chunk体积提示），增量装配16条说明，v0.4.3发布3文件（manifest、JS、index），JS为index-C42j1m10.js，CSS仍index-DhQhfH6t.css。保留旧hash文件；未重启服务、未改在线数据库，新增说明的实际阅读/滚动交用户亲测。

Luna/max（skill_runtime_evidence）只读核对研究包S07：https://www.maplesea.com/updates/view/v244_Patch_Notes_3/ 无Energy Bolt/Cold Beam/Thunder Bolt/Ice Strike条目，其他职业的攻速解耦不可外推。官方历史v198 https://www.maplesea.com/updates/view/dynamic_duo_patch_notes_v198/ 的延迟降低百分比不是TMS273时序，不采用。源技能保留weapon=37/38（冰/雷）、冰锥剑time=8及String明确冰冻8秒；武器代码的执行映射/权限、攻速公式、服务器命中时点仍未核定。

root追踪combat.attack→Store.claim_attack→world.pending_attacks→Store.resolve_attack：动作表仅单target/damage/resolved，world仅取nearest_attack_target；当前物理结算不能简单乘attackCount后当冰雷复刻。后续施放需原子绑定技能/等级/MP，逐目标与命中序列去重；未提前添加无调用的技能引擎，也未把客户端负delay改成服务器命中常数。


## 2026-09-08 技能权限指定源核验

Luna/max（skill_permission_sources）只读核对Etc_002.wz的LevelUpGuide、LoadSkillRootList、RecommendSkill、SkillFrameTooltip实际源，而不只依赖WZ_JSON_TW。LevelUpGuide JSON仅Contents，实际还有Guide/Image；Guide/10/quest/2/questId=1400、Guide/30/quest/2/questId=20200，可作等级/转职提示来源，无SP授予或职业许可。LoadSkillRootList仅11000/11200/11210/11211/11212空节点；RecommendSkill实际为空；SkillFrameTooltip仅GuardianAngelSlime/AnglerCompany/ChampionRaid特殊玩法。指定源不能补齐法师/冰雷SP组、升级SP或技能职业访问。

root核对私服data/Etc/MakeCharacterSetting.json内容为level10、meso1000000、fieldId910000000（SHA256 b4d62bfc02bfebc515fd12c68a2e0c614dd7fcc1c7e8b2e7a15b50fe909da9fb），排除为原版开局依据。String/Eqp.json的1372071等itemCollectionName=短杖，1382093等=長杖；Skill/220的2201005/2201008精确字段是weapon=37、weapon2=38，不能误记成单个数组。仍未将137/138与37/38的推断映射写成执行门槛。已向用户异步询问缺失q363/q1402/q1416脚本及273冰雷实机录像的路径/链接；未收到输入前不填造规则。


## 2026-09-08 寒冰迅移说明回归修复v0.4.4

root发现2201009模板的#c#prop替换后为#c6，上一版sourceText因颜色标志后有数字而未清理。Luna/max（skill_descriptions续作）修正实际view.ts清理规则，保留#unknown/#xyz；新增view.check.mjs转译实际视图函数（仅隔离i18n和CSS）验证真实模板、数字/中文颜色标志、未知字段与换行，通过。root将检查加入npm check，生产build通过，发布v0.4.4的JS/index两文件，index-CkAxQ8uw.js；原CSS/manifest未变。无在线服务重启、账户探针或存档修改；本次显示由用户实玩确认。


## 2026-09-08 选择岔道快捷法师转职

按用户最新要求，在现有001020000「选择岔道」的001020000-life-1/template10201汉斯菜单选择「法师」，将新手job0转为200；这是用户指定快捷入口，不伪称q1402原剧情。Luna/max（mage_transfer）复用NPC act/QuestEffect与SQLite事务，仅CAS更新job，保留等级、HP/MP、技能、SP、任务和装备。服务端限定地图/NPC、存活、100×80距离及玩家自己的菜单会话；修复原NPC对话进度共享，改为按玩家保存，离图/传送/断线清理。快照按观察者返回jobAdvancementAvailable，仅有资格的新手显示标记。

通过cargo check及三个定向测试：job_advance_keeps_the_success_say_after_applying_effect、character_job_migrates_isolates_and_survives_reward_and_config_changes、mage_job_advance_is_menu_bound_authorized_and_persisted；覆盖缺失act字段、重复选择、其他职业、死亡、越界、跨玩家菜单、实际传送清理及重登恢复。测试用临时SQLite，无在线账号探针。Rust开发二进制构建通过。

root复用NpcView/现有点击与纹理预加载接入标记，源origin仅应用一次；单帧静态不计算动画周期，标记隐藏后不可点击，离图销毁。view.check.mjs通过资格、源坐标/切帧、静帧、图像复用及销毁检查；前端v0.4.5生产构建通过（仅既有大chunk提示），JS index-DNrs-9bj.js，CSS index-DhQhfH6t.css。NPC头顶位置、遮挡及实际点击手感由用户亲测；未做在线验收。

Luna/max（mage_marker_assets）从UI/UIWindow2.img/QuestIcon/30/0导出44×55气泡原图，origin=(21,28)、x=-21/y=-28，PNG SHA256 c45b2c64aeaf18c442b4af524653da8fc41f616cf977785eaa550ccd92218f1d；root已核看。原30/0..3无delay，采用单帧静态，rawDelay=null、delaySource=missing、客户端delay=0仅为静态契约；其余3帧元数据与14个源文件指纹保留在npc-marker.json。导出及check_tms273_npc_marker.cjs通过。增量装配public与构建产物，发布5文件，index最后替换、旧hash保留。

原服务PID10220在本轮中消失、3010无监听，未由root发送停止信号，原因未知。发布后用既有server/data/tms273.sqlite3启动新二进制PID44030；启动日志output/server-v0.4.5.log与lsof确认3010监听，content=tms273-1/tick50ms/attack800ms。未清库、未新建账号、未做在线探针。完整冰雷职业仍未完成，彩蛋未提前触发。

## 2026-09-08 一转可玩化授权与源数据准备（进行中）

Luna/max mage_sp_official完成三组官方定向查询：当前台服职业展示页与初入游戏说明未给出SP授予公式，旧2005玩家帖不作为273证据。用户随后明确“参考没有则先实现跑通”，因此该范围改用标注P的临时运行规则，旧“未知即阻塞”不再适用。

root用既有受限公式解析器将book200的8节点投影shared/mage-skills.json，包含逐级common、前置、hidden与原始表达式，服务端无需手拆公式。check_tms273_skill_manifest.cjs新增魔心取整/85%分摊、瞬移295、魔力增幅120、前置与隐藏伴随节点、非法公式检查，通过。原版角色energyBolt/manaWave/manaWaveFloat动作通过现有纸娃娃导出器--mage-actions导出，解析action/frame链接、保留rawDelay，abs仅作视觉周期并应用原move；12套现有装备组合均有三动作，check_tms273_mage_avatar.cjs通过。

Luna/max mage_sp_official续作导出72张额外PNG与mage-effects.json，另复用已导出魔灵弹effect/hit/ball；5主动技能含原origin/rawDelay/outlink/源文件和PNG指纹。check_tms273_mage_effects.cjs通过。root核看UICharacterInfo同版common/main/backgrnd（472×230）和local/detail/backgrnd（472×479），按已核A14原图结构导出14张角色界面PNG与25个原位置；导出器检查原origin/静态无delay/尺寸通过。public清单已增量加入上述资源，尚未发布本轮运行代码，服务保留。

### 2026-09-08 法师一转实现（v0.5.0，已发布）

- 最新用户允许「参考没有则先实现跑通」，本节P临时规则覆盖此前该范围的等待条件。原版源数值与执行适配分开记录。
- 源：TMS273.7 的200技能书8节点逐级common、技能图标/说明；原版魔灵弹、魔心防御、瞬间移动、魔力波动/浮空特效；Character energyBolt/manaWave/manaWaveFloat动作及12套已有装备组合；UICharacterInfo原版背景/按钮/位置。研究包C06技能窗和A14角色信息结构继续作为参考，A13并非角色属性图。
- P：汉斯快捷转职/训练初始化一转SP5、基础MP至少100、两个隐藏节点自动启用一次；每级+3一转SP。主动技能须实际加点，学习消耗1SP并校验前置；不赠送满技能。
- P：最终魔攻暂为4×INT+LUK+角色等级+装备MAD；魔灵弹同一服务端请求内最多4目标×4段即时结算，首目标前方340范围/垂直90，后续使用源目标矩形。后续取得同期执行时序后替换，不宣称原版伤害公式或手感。
- P：魔力增幅MP按原版mmpR与lv2mmp×角色等级重算，基础MP单独存档防累加；actionSpeed每档适配50ms世界tick。瞬移源距离用于当前地图碰撞，源被动速度适配实际px/s；魔力波动为现有跳跃速度适配，隐藏节点按源v/time实现一次跳跃内限次缓降。短杖编号映射、暴击倍率和自然力变弱的伤害适配仍为P。
- 客户端：K技能窗可加点/施放，1魔灵弹、2瞬移（可配方向）、3魔心防御；上+空格魔力波动、空中空格缓降；C角色属性窗绑定实时服务器快照。岔道汉斯转职后继续提供技能入口及恢复魔力。
- 定向资源检查已通过：check_tms273_mage_avatar、check_tms273_mage_effects、check_tms273_skill_manifest。客户端已有检查及生产构建通过，四维追加后的最终构建待记录。未进行在线账号探针、独立QA或为验证重启服务。

- 最终整合：新增真实world综合检查覆盖加点、四目标×四段、MP扣除与重放、装备属性重算、魔心防御、瞬移阻挡、魔力波动/缓降；新增SQLite检查覆盖多级升级SP及奖励重放。最后执行 `cargo test mage_` 7项通过（75项过滤），此前80项已有检查通过；cargo build成功。未宣称最终82项全套重跑。
- 前端最终构建v0.5.0：JS index-DrGBXFaS.js、CSS index-ClkkooGe.css；角色四维/响应式检查和typecheck通过，原有client check通过，character check纳入npm check。生产构建通过（既有大chunk提示）。
- 发布1843个文件，保留旧hash资源并最后替换index。发布前3010无监听、旧PID44030已不存在（非本轮主动停止，原因未知）；启动PID53302，原server/data/tms273.sqlite3，日志output/server-v0.5.0.log；确认127.0.0.1:3010监听及正常启动日志。未清库、未建账号、未运行在线玩法探针。


## 2026-09-08 启动3010编译与warning核对

- 用户日志的5个E0063/E0599错误在本轮开始时源码已补齐：World.mage_skills、Monster.elemental_weaken_until、PlayerState.derived_stats、Player的3字段及with_mage_skills均存在；实际构建确认不再复现，未重复修改world。
- 本轮清理实际3个Rust dead_code warning：仅测试使用的Store.use_item和MageSkills.bundled限定cfg(test)；删除运行时未使用的MageSkill.source字段，shared/mage-skills.json原始来源继续保留。
- Vite完整Phaser包约1490.49kB，告警预算明确设为1600kB；这是预算调整，不是缩包优化。
- 两个现有定向测试通过：use_item_consumes_one_potion_cards_enter_book_and_scrolls_are_atomic、bundled_catalog_is_strict_and_has_energy_bolt_geometry。启动3010.command最终服务端/客户端构建均无warning，脚本健康检查通过；git diff --check通过。
- 工具exec会话结束后后台进程未保持，最终通过macOS Terminal打开同一启动3010.command（等同双击）运行；跨命令确认PID58837监听127.0.0.1:3010。使用既有server/data/tms273.sqlite3，未清库、未新建账号；原bot凭据缺失，不创建替代机器人。玩法交用户亲测。

## 碰撞与受击复用修复（2026-09-08）

- 用户确认按83历史复用调查建议实施；root负责服务端和文档，Luna/max hurt_cast负责客户端姿态。背包、拾取动画保留现有实现，未搬回旧版整文件。
- server/src/world.rs移除缺weaponDefense/standardPdd便跳过碰撞的过滤和Pre-BB标准防御表；使用P临时接触伤害=max(1,同版Mob.PADamage−装备PDD)，随后沿用魔力之盾减伤和魔心防御MP分摊。该线性规则不是已验证的273官方公式，待同版证据替换；原击退/韧性/无敌时长也仍为项目适配。MP比例乘法使用i128避免溢出。
- 保留世界顺序结算、同地图检测、无敌、死亡、击退、事件与存档；受击清除尚未命中的普攻。client/src/features/player/view.ts的hitFeedback清除skillAction，使服务端jump/stand姿态不再被旧施法计时覆盖；已结算技能不回滚。
- 4项Rust定向检查通过：contact_hit_knocks_player_back_and_broadcasts_damage_event（直接加载shared/gameplay.json玩家配置和273蜗牛，覆盖异图隔离、扣血/击退、未命中普攻取消、同tick重复接触、无敌到期死亡）、attack_and_body_rectangles_mirror_and_overlap_like_wz（含P伤害、防御下限与缺攻击字段）、tenacity_scales_down_the_knockback_hop、mage_skill_runtime_covers_learning_targets_replay_guard_teleport_and_wave（按源护盾10PDD及魔心防御22%验证新伤害）。测试旧数值断言已按实际273蜗牛与装备更新。
- node client/src/features/player/view.check.mjs行为检查、客户端typecheck、npm run build -- --outDir /tmp/maplestory-contact-build和cargo build --manifest-path server/Cargo.toml通过。Cargo使用/Users/muniao/.cargo/bin/cargo直接调用；一次经旧Python子进程链接遇到xcrun架构不匹配，改直接调用后通过，未改系统工具链。
- 未启动独立QA、重启服务、写用户数据库或覆盖在线前端产物。上线仍须用启动3010.command；受击画面/手感与在线存档交用户实玩验收，不能将上述单元检查视作线上已生效。


## 2026-09-08 研究包装备闭环：套服占位与原子换装

- 对应研究包02_BACKLOG.json的R014/R017/R020子项及主报告第9/10节。实际273 JSON Character/Longcoat/01052095的islot/vslot=MaPn，上衣01040002=Ma、裤子01060002=Pn；scripts/export_tms273_avatar.cjs已有套服替代裤子的表现规则。源字段与shared/items.json一致，未修改源数值。
- Luna/max player_hit在server/src/inventory.rs共享equip_items入口补齐套服/裤子双向冲突：目标格先处理，额外冲突优先回原背包格、再找空装备格；容量不足保留全部原物品，强化属性/次数/剩余卷轴位随实例返回。自动回包格位顺序明确为P交互适配，不声称已核看273客户端操作顺序。双击/拖拽及SQLite/内存路径均调用此入口，客户端已有对应遮挡，不改UI。
- root新增SQLite定向检查，修复前复现满包换套服错误成功；修复后overall_swap_is_atomic_and_replay_safe_after_reopen通过，覆盖满包无修改、腾一格换下两件、强化实例保留、关闭重开、成功请求重放、拖拽裤子换下套服及再次重放。Luna的longcoat_and_pants_share_body_slots_atomically通过，覆盖纯规则双向替换、额外空位及满包回滚。
- 最终cargo build --manifest-path server/Cargo.toml通过，无warning；改动文件git diff --check通过。全部存档检查使用临时SQLite，未修改在线库、启动独立QA或重启服务；未改客户端，不重复前端构建。后续通过启动3010.command加载，双击/拖拽手感、满包提示、纸娃娃及属性刷新由用户亲测。此项不宣称完整套装/强化系统或M2完成。


## 2026-09-08 成长与冰雷源素材增量

- Luna/max ice_source 从实际 UICharacterInfo 与 UI_000.wz/_Canvas006 导出 AP 加点相关52态，character-ui共66项/27向量；四维lvUp按钮复用源Hp outlink，保留origin/源路径。源PDF第2/4/6页已核看，HTML A14/C06远程图本轮无法访问，未声称在线图对照通过。
- 同版技能目录投影扩为book200+220共17节点，加入bookId/fixedLevel/boosterActionSpeed及源逐级字段；check_tms273_skill_manifest通过。源数值和执行P规则分别保留。
- mage-effects增量复用冰锥剑/电闪雷鸣既有图，新增寒冰迅移tile24帧/hit11帧、结冰mob30帧、精神强化effect19帧。精神强化rawJSON为空但实际二进制有19帧，以实际Skill_00001.ms/_Canvas_040.wz为准，修正“无效果”的早先判断。check_tms273_mage_effects通过10项技能、156PNG。
- mage-avatar新增coldBeam8帧、thunderBolt2帧、alert2三帧，starter和12套装备均覆盖；保留linkedAction/linkedFrame/rawDelay。check_tms273_mage_avatar和check_tms273_skills通过。
- root装配tms273-2完成：17图、2048素材；check_tms273_runtime通过17005源引用及客户端/服务端几何一致性，临时经验曲线与怪物源MP检查通过。尚未部署新服务，用户实玩与响应式待验。


## 2026-09-08 成长存档与AP事务定向证据

- auth增加个人四维/可用AP存档与单点分配事务；新角色12/5/4/4、0AP，旧列为空的角色只在首次迁移补(level−1)×5AP。每次成功升级+5AP；已积累EXP保留，曲线缺源按P的15×level²至60级暂跑。角色属性与剩余AP随奖励写回，原奖励去重链保留。
- 4项Rust定向检查通过：mage_level_up_grants_three_book_points_once_across_reward_replay（实际shared经验表，80EXP连升2级、10AP、奖励重放、跨属性请求冲突及零AP）；character_job_migrates_isolates_and_survives_reward_and_config_changes（旧表迁移、原EXP/level保留、落盘重开不重复补AP、旧请求重放、lv30二转及原一转SP保留）；skill_actions_are_transactional_and_request_idempotent（book200/220权限与SP隔离）；ability_allocation_accepts_only_one_known_stat_intent（未知属性、伪造amount/playerId/stats、空requestId及单项上限）。
- 使用临时SQLite和测试二进制，未触碰在线账号。此次测试编译通过，mage.rs尚有源字段s未消费warning，留给冰雷运行整合解决；尚未将World/前端业务与整服发布标为完成。


## 2026-09-08 成长与冰雷前端整合检查

- Luna/max growth_frontend 接C窗等级/经验目标与百分比、个人四维/派生总值、可用AP和原版四维加点按钮；等待服务器权威快照，历史abilityResult不覆盖当前角色数据。死亡/断线/无AP禁用，加点pending按请求处理，P成长说明可见。
- 冰雷book220学习权限、固定结冰被动、4/5/6/7快捷键、coldBeam/thunderBolt/alert2动作与源冻结层素材接入；前端npm run check全部通过，typecheck通过。修正并行EntryView两处NodeList遍历兼容性，仅最小改动。
- 开发者在离线Safari用/tmp/maple-character-stub.html检查390×844、844×390、1440×844及实际AP按钮请求；/tmp/assets临时链接到public-tms273/assets。截图只在CUA会话查看，未保存独立截图/日志，未访问在线角色作为测试。
- root复用既有CombatView技能视觉列表补冰路径tile/1平铺及循环：依赖服务端skillCast的起终点/持续时间，生命周期结束销毁、重复eventId不重复创建。skill.check.mjs新增路径去重、循环和6秒销毁检查通过；随后npm run typecheck通过。不声称冰雷整服已经发布。


## 2026-09-08 World成长与冰雷二转实现完成（待统一发布）

- Luna/max ice_runtime 完成world/mage：入图以auth::add_exp(Profile,0)补算累积EXP，不降低旧等级；升级AP/SP、个人四维、普攻/魔攻/装备门槛与派生值同源，加点重放不会恢复历史属性。Store交易结果与快照顺序保持权威。
- 汉斯lv30/job200→220快捷转职保留一转SP，book220独立学习、转职5SP与固定结冰1级，此后升级3SP入220。全部9技能接入：吸魔、魔法熟练、智慧/加速INT被动、精神强化、冰锥剑、电闪雷鸣、结冰效果与寒冰迅移；一转技能仍按家族权限可用。
- 修复整合发现：冰雷攻击共享动作锁；冻结每cast/target只加减一层；吸魔按源maxMP百分比并限剩余MP，0%不吸，结算后保存不被旧profile覆盖；关闭寒冰迅移不生成冰面；buff过期计算不发生无符号下溢。冰面成功创建发完整skillCast起终点、facing、requestId/eventId、durationMs，前端复用源tile循环。
- P执行边界：五层上限、即时多段命中、每目标每施放增减一层、精神强化仅自身、冰路径矩形走廊及50ms tick量化；源s/v未按未知原引擎物理执行，临时以冻结移动锁适配。源表数值/原图与P时序不混称官方规则。
- 代理报告world::tests::46/46通过，包含world_growth_and_allocate_ap_are_personal_and_idempotent与ice_mage_second_job_skills_damage_freeze_consume_and_path；cargo test --no-run、rustfmt、git diff --check通过。已有4项根auth/protocol结果仍有效，不重复运行。最终含大厅创角增量的runtime检查通过17图/2056素材/17013引用。
- world/mage及main/player前端已释放给并行“复刻菜单登录与角色流程”任务接外观；本任务未重启服务。完整生产构建和3010统一发布仍待两边整合，用户在线实玩不计作已验。完整职业后续转职/Boss与研究包总目标继续。


## 2026-09-08 R012法师/冰雷原版技能音效

- Luna/max ice_source新增export_tms273_skill_sounds.cjs与check：实际Sound_034.wz的Sound/Skill.img/200和220相关节点，17项目录中8个真实声音目录、13MP3；保留节点名、UOL解析来源、原文件/字节SHA-256，2201001/Use实际指向../2101001/Use。缺少节点的9项明确missing，不从旧版补声音。
- root新增manifest.skillSounds并接既有Phaser缓存：Use按权威skillCast去重、Hit按目标首段伤害事件触发（播放策略P，非原引擎时序证明），冰面派生事件不再播放玩家施放音。完成/播放失败销毁实例，死亡/离场/场景清理停止相应声音，遵循既有静音设置。源special/Loop保留导出但当前未推断触发语义，不声称全部声音节点行为1:1。
- source导出/check/两个脚本node --check通过；前端sound.check通过原怪物声、缺音频、技能施放/命中去重、首段策略与完成/离场/场景清理，typecheck通过。装配tms273-2完成17图/2067素材；13源MP3中11个Use/Hit节点纳入客户端。未在线播放或重启服务。
- 本任务所有文件已释放给“复刻菜单登录与角色流程”任务完成共同发布；本次发布范围冻结，不再并入新里程碑。该任务负责唯一生产构建/启动3010.command及报告版本/PID，当前未拿到发布成功证据。


## 2026-09-08 冰雷三转转职来源准备（未接运行）

- 新references/tms273-data/ice-third-job-transfer-source.json保留36329/1434/1436/36330原JSON节点、源SHA-256和脚本搜索范围。36329最低60级接二转职业；1434要求lv60、jobs210/220/230及36329完成，调用q1434s/e；36330最低100级接受三转221并以1434等完成为前置。
- 旧1436“魔導士(冰，雷)”在QuestInfo标blocked=1，条目带4031059/211040401神圣之石旧路线；不能据其内容直接启用为现行273三转剧情。该blocked结论当前限定本地WZ_JSON_TW文件，不将JSON缺节点推定实际二进制无节点。
- 参考/273文件扫描未找到q36329s/e、q1434s/e、q1436e、q36330s/e；Act空值不构成转职/SP授予执行证据。数据生成时断言60级条件、1436 blocked与36330接受221通过；运行目录/装配/服务未改变，本次联合发布范围不变。


## 2026-09-08 冰雷三转12节点实际WZ核验

- Luna/max ice_source新增references/tms273-data/ice-third-job-source.json：实际Skill/221.img全部12节点与String_000.wz逐项复核，保留原common公式、maxLevel/req/action/weapon/elemAttr/info/psd/invisible和视觉组结构及8个源文件指纹。root逐项一致性检查输出12skills、0mismatches。
- 2211015是invisible=1的闪电球子节点，其余没有hidden/fixLevel；不能照二转固定被动模式自动赠送三转全部技能。冰风暴/冰川墙分别最多8目标4段，不能仍套二转6目标3段的限制。
- Quest1436.blocked=1已在实际QuestData_000.wz验证与JSON一致，增强前一条仅JSON证据；仍不推导q1434/q1436执行和SP授予。转职/SP/服务器时间轴继续U。
- 复用现有群攻/冻结/瞬移与被动重算；召唤球与固定球、元素适应冷却/异常防护需新增真实状态。冰川墙只凭u/w与视觉组不证明持久场，root已纠正初稿的过度推断，优先前方矩形攻击。冻结粉碎与自然力重置还需怪物防御/属性耐性输入，不能只改面板冒称被动生效。
- 本轮仅新增来源artifact和记录，无运行目录/版本/服务改动，未扩大冻结的联合发布范围。


## 2026-09-08 成长、冰雷二转与技能音效联合发布

- 与登录菜单任务共同构建：Cargo与客户端TypeScript/Vite生产构建通过，v0.6.0 / protocol 6 / tms273-2；原数据库保留，无新增在线测试账号。
- 首次工具环境启动后进程未保持，发布任务随后通过系统Terminal执行根启动3010.command。root只读确认PID82829监听127.0.0.1:3010，server.log最新内容tms273-2，dist清单contentVersion=tms273-2。
- 经验进度、升级+5AP、C属性分配与个人属性存档，以及已授权冰雷二转9技能、Use/Hit源音效已随本版加载；P曲线当前至60级。先前定向检查不重复运行，实际打怪/升级/分配/重登和技能表现留用户验收。三转P方案仍待用户答复，完整研究包目标未完成。


## 2026-09-08 登录、大厅、创建角色与总菜单联合发布

- 按用户五图及图库A01/B01/B02/B03/B05核看原图，并对照本地TMS273.7。登录Title、大树角色选择customLoginTheme、CustomizeChar蘑菇屋背景、空角色动画、42项总菜单使用本地原素材。频道使用同版WorldSelect/default，未找到截图蓝龙主题，不宣称逐像素1:1；研究包B组为跨区结构R。创角控件采用网页响应式布局。
- 账号登录后进入唯一主频道1；每账号12角色栏，中文名称校验、名称占用、创建幂等、角色归属/token区分由服务端执行。创建角色、初装与请求重放持久化；旧player_stats按原ID迁移，原存档保留。
- MakeCharInfo/000的男女脸/发型/八色染发/衣鞋武器目录建立服务端白名单；112外观部件层、934PNG。登录预览与入图共享合成；按vslot/smap处理遮挡，按equipped快照换装，男女均保留一转和冰雷施法动作。
- 总菜单七分组/七底部操作、键盘导航与焦点恢复；已有背包/装备/任务/技能/属性及频道/选角/退出接通。缺少业务的入口明确提示未实装。
- 定向检查：lobby4、auth17、入图外观快照1通过；appearance.check.mjs验证88男女发色组合、装备移除与旧外观回退；view.check.mjs离线HTTP桩完成登录/选频道/名称检查/创建/选择回调、42菜单项/Escape以及390×844、844×390、1440×900响应尺寸变化。截图与结果位于evidence/entry-ui；不冒充真实联网入图验收。
- 检查发现并修复：页面/控件CSS类名冲突、普通HTTP缺randomUUID、菜单窄屏盒模型溢出、女性导出遗漏技能动作、截图未等源图片完成。Cargo build、TypeScript/Vite构建通过，Rust两条未使用代码warning仍在。
- 联合发布前端v0.6.0 / protocol6 / tms273-2，保留并行任务成长/AP/冰雷及技能声音。工具包装回收首次nohup，改由系统Terminal运行同一启动3010.command后保持PID82829监听127.0.0.1:3010，health ok=true/tms273-2。数据库未重置；启动器报告原bot凭据缺失，未新建账号。实际联网角色表现交用户亲测。


## 2026-09-08 启动构建：旧副本误编译及测试代码警告修复

- 用户报错来自未引用的main 2.ts、names 2.ts、world 2.ts旧副本；index.html实际入口为main.ts，现用调用已经传入manifest和完整CombatView参数。tsconfig保留src完整类型检查，仅排除src/**/* 2.ts，保留副本文件，不把旧副本改造成第二套运行实现。
- Request::Verify及对应match分支、creation_default仅由cfg(test)模块调用，改为cfg(test)，正式认证继续走VerifyCharacter。未使用allow(dead_code)。
- npm --prefix client run build通过；cargo build与cargo test --no-run通过，无所报Rust警告。只重建产物，未执行启动器、重启服务或修改用户库。


## 2026-09-08 升级原版反馈 v0.6.1

- Luna/max导出中因用量限制终止，root接管已有scripts/export_tms273_levelup.cjs与levelup.json，检查通过：Effect/BasicEff.img/LevelUp为21帧（首500ms，其余90ms，共2300ms），Sound/Game.img/LevelUp MP3为10920字节；3个实际WZ来源SHA256已保存。核看两序列第8帧，未把不同外观等同同步叠层，删除未证实的同步声明。
- LevelUp2的23帧单独保存，缺delay沿用reader默认100ms且不投入运行；播放选择明确P。现用只加载LevelUp和原版音效，原点/透明度/帧时间保留。导出进入既有build_tms273管线，assemble投影到可选levelUp字段。
- PlayerView沿用角色生命周期：观察等级上升、跨级单次播放、最高已见等级抑制旧快照重播；初次入图和重连不播。特效跟随脚点且不随角色朝向镜像，独立源帧到期销毁，声音完成或角色离开销毁；World统一预载并沿用静音。
- levelup.check.mjs已加入npm check，定向覆盖跨级/旧快照/初入图/重连、跟随、源时长、声音结束与离开清理；此前该检查及typecheck通过。本次资源指纹检查、生产构建通过，最终dist确认21帧/2300ms与MP3齐全，前端v0.6.1。较早产物检查发生在构建尚未完成时，最终构建完成后重检通过。
- 仅更新静态产物，未重启3010或修改账号；观察到现有PID4661监听，非本任务启动。实际运行表现交用户验收。

## 浏览器铺满游戏与枫之谷消息（2026-09-08，实现/定向检查完成）

- root修改main.ts/style.css/menu/view.ts：移除主游戏外层宽高限制与边框，100dvh承载Phaser RESIZE，ResizeObserver同步渲染与动态HUD占高；聊天置于HUD上方，宽屏/横屏/窄竖屏保留原尺寸按钮换行。world.ts仅调整centerOn垂直偏移为min(120,height×0.1)，修复844×390角色名字被HUD挡住；保留其他任务同文件修改。
- 复用273 UITotalMenu menu/buttonInfo/6/1（type36，楓之谷消息）入口，独立原生dialog集中原页面地图/传送门路线、连接/人数、版本、语言、声音、重连/返回角色和最近30条状态。开窗释放输入，模态键盘不穿透；Esc/关闭与离图恢复节点、焦点和监听器，错误提示仍可打开消息恢复连接。消息排版为本次用户授权的网页适配，非官方273新闻窗口1:1声明。
- 来源：研究包workstreams/08及PDF第2/3/5页、HTML A01图卡已读取；A01原图https://hackmd.io/_uploads/HkUqz2C5lx.png本轮打开失败，标未核看。已实际查看本地273 UI/_Canvas/UITotalMenu.img/main/backgrnd（client/public-tms273/assets/tms273/UI__Canvas_UITotalMenu.img_main_backgrnd-588cd18411.png）与清单type36入口，沿用现有青白色菜单结构。
- Luna/max viewport_trace只读追踪容器/相机/背景平铺链，确认Phaser相机随scale更新、背景读取动态相机尺寸，无额外背景resize机制；未启动独立QA。地图bounds保持原权威范围，小室内图在超大视口下可能露出边界外背景色，完整地图边缘实玩待用户验收。
- 新增唯一必要脚本client/src/app/viewport.check.mjs（node运行，沿用仓库esbuild/已装Playwright），真实主入口、Phaser、273单地图和默认角色，网络/入口为内存替身，所有请求限定viewport.test。1440×900、844×390、390×844、320×568、1920×1080及回切横屏通过：canvas/相机尺寸一致、无横向溢出、HUD按钮在界内、聊天/HUD不相交、角色名字高于HUD、type36打开/关闭、信息迁移、模态输入隔离、30条去重上限、断线重连和离图节点还原；无pageerror。截图及results.json位于output/playwright/viewport/。
- npm --prefix client run build -- --outDir dist-viewport-check --emptyOutDir false通过（含tsc，46模块）；未覆盖运行dist、未动在线服务或数据库。共享协议已由并行任务升级7，发布由「执行 tms273 复刻计划」任务下一次统一完成；已发送交接，不宣称在线生效。

## 启动3010的E0308修复（2026-09-08）

- 用户报告world.rs quest_consume_items将Vec<Value>传给serde_json::from_value导致启动脚本服务端编译失败；唯一调用在任务完成的消耗道具分支。已仅将数组包装回serde_json::Value::Array，保留布尔/默认消耗语义与并行任务修改。
- cargo build --manifest-path server/Cargo.toml通过；定向world::tests::quest_consume_items_accepts_array_and_boolean_forms通过（1 passed），覆盖显式数组、空数组、false不消耗以及true/null沿用条件物品。现存3条未读取字段警告不阻断构建。
- 本轮未执行启动/停止脚本、未触碰在线库；原服务继续由既有进程运行。已向并行任务交接修复。

## 3010健康检查失败恢复与全屏前端上线（2026-09-08）

- 日志证实程序要求tms273-3而gameplay仍为tms273-2，导致退出且3010无监听。并行任务完成真实首章资源装配后恢复；本任务未重复装配或仅改版本标签。
- 启动3010.command在停服前复用check_tms273_runtime.cjs并传入CONTENT_VERSION；检查脚本接收预期版本参数。匹配通过与故意不匹配拒绝的定向检查通过。
- 统一启动脚本exit0：17图/17049引用检查、Rust和前端构建、health版本检查通过。服务PID21001，原凭据bot PID21067已连接，v0.6.1 / protocol7 / tms273-3，全屏及枫之谷消息上线。数据库账号未重置。
- 启动恢复不等于首章业务验收，后续业务验证仍由并行任务执行；代码写入与启动已释放并交接。

## Rust三条未使用字段警告清理（2026-09-08）

- QuestConditions和QuestSpec的source_job为来源元数据，运行权限读取conditions.job；当前4个QuestObjective均为collect，进度读取item_id/required。内部字段改_source_job/_kind并保留serde显式sourceJob/kind及type别名，不改变业务或数据结构。未添加全局allow或删除来源信息。
- cargo build --manifest-path server/Cargo.toml通过，无warning；git diff --check通过。未重启服务或修改存档。

## 全屏背景露底修复（2026-09-08）

- 用户选择岔道截图上下浅色带为Phaser底色：273 grassySoil_new/back/0天空738高与back/12水色267高只横向平铺，大屏超出垂直范围。已查看两张源图，Luna/max只读核节点及alpha；同来源被多张地图复用。
- 最终只对这两条已核背景色带增加垂直覆盖：天空上缘不足时上移到0并拉长色带，水色下缘不足时延至视口底。色带渐变连续，建筑、云层、视差参数、角色、地形及物理坐标保留；不新增纹理或边缘精灵，不整屏缩放。其它垂直平铺背景继续先归一化再定位。
- 现有viewport.check.mjs保留首章/任务/HUD/消息检查，补选择岔道1800×1083、2560×1440、3600×2166、390×844、844×390及回切，顶部/中上部/底部像素拒绝原画布底色，背景清理通过。真实Phaser离线检查通过，宽屏及竖屏截图已目视核对，证据output/playwright/viewport/background-*.png；未使用在线账号或启动独立QA。
- 最终tsc/Vite生产构建通过；已复制新hash JS/CSS并原子替换运行dist的index.html，保留原资源及旧hash文件。前端现为index-B-3x5MB9.js，服务及bot未重启，数据库未改动，刷新生效。

## 2026-09-08：冒险家开局六任务大模块与有限核心验证

- 已接36301/36302/36303/36304/36306/36307：原273条件/文本、原NPC素材与位置，接取→叶堆取发夹/蜗牛壳收集→NPC交付→船票消耗及维多利亚港→返回汉斯。任务状态、奖励、背包和地图同一SQLite事务；重复提交不重复发奖，持久交互以DB背包事实恢复。保留既有任务记录与职业，不重置存档。
- 来源：官方日服 https://maplestory.nexon.co.jp/gameguide/basic/quest/ 与SEA https://www.maplesea.com/guide/user_interface/ 仅作R任务状态/追踪交互结构；跨区Wiki Sugar's Suggestion、Victoria Island or Bust仅佐证收壳/船票剧情。本地273 Quest Check/QuestInfo、NPC life、Item info为T。原q363脚本缺失，EXP15/30/45/90/120/150、对白代替过场、叶堆点击、4033919船票映射和返回路线均P；未实现原版礼盒内容/过场，未称1:1或完整M2。
- 素材静态纠错：guide/tutorial/key/0实际为方向键帽，已排除。真正叶堆使用出生图obj-5-0，acc1/mapleIsland/maple/6，源锚点(-432,646)、215×55、origin(107,27)，客户端使用源矩形(-539,619)绑定点击；缺失原版脚本绑定仍为P。
- 后端有限检查：`cargo test --manifest-path server/Cargo.toml chapter_ -- --nocapture` 3/3通过，实际shared数据+临时SQLite+真实NPC菜单贯通六任务、船票/地图/重登、死亡/远程选择/未接取拒绝；事务检查含重开重放、EXP/mesos/物品/位置不被重放覆盖、未知物品回滚、满包失败后重试。无在线账号探针或在线DB写入。
- 原任务兼容定向5项初次3过2失败（无目标任务现在投影为objectivesComplete且发送全量日志）；更新两处旧断言并排空新增推送后，两项各自精确复验通过。未接入脚本拒绝修改任务状态的精确检查1/1通过。未重复通过的其它项。
- 界面有限检查复用`client/src/app/viewport.check.mjs`：真实Phaser/本地273图，5尺寸+回切、叶堆点击仅发送一个意图、进度变化、热点消失/断线清理、任务日志不横溢且不挡生命栏。实际截图发现追踪条叠标题/小屏挡HUD后修复并复验通过；证据`output/playwright/viewport/quest-320x568.png`等。并行背景修复任务随后保留这些检查扩展并通过，前端最终build及静态发布由该任务完成。
- 检查规模：4个独立脚本当前507行（chapter203、store125、viewport146、runtime33）；另world/auth内嵌检查及适配不足40行，总计6文件、不到550行，低于本模块7文件/1000行上限。`git diff --check`通过。
- 发布边界：用户另一个启动修复任务已统一启动protocol7/content tms273-3并保留数据库和陪测bot，前端包含上述任务UI。最后的后端读档失败处理/提示/历史记录兼容修正已通过测试，尚未另行重启在线进程，待下一次用户启动统一带入。真实移动手感、原过场及后续36308+剧情仍不属于本次通过项。


## 初心者升级SP漏发与旧档差额补偿（2026-09-08）

- 根因：auth与world升级仅给法师职业SP；当前库只读快照为两条lv2/job0、skills与SP为空。前端目录也无初心者页，原先显示法师SP未知。
- 修复：auth::grant_level_sp供持久奖励/World奖励共用；job0升2..7每级1SP入book0，法师200/220/221及历史222规则不变。load_profile事务仅对job0补max(0,min(level-1,6)-skills[1000]-skills[1001]-skills[1002]-现有book0余额)，保留超额、其他技能书、技能/AP/任务；余额即幂等依据，失败整体回滚，不按总等级覆盖法师SP。
- 前端复用原技能窗tab0显示独立余额；初心者技能尚未开放学习，页面明确说明，不虚造可学习技能或把新手SP混入法师书。
- Luna/max只读核定本地`参考/273/TMS273少爷一键端/手工服务端/tms273-1/WZ_JSON_TW/Skill/000.json`含0001000/0001001/0001002，均maxLevel3；同树String/Skill.json名称为嫩寶丟擲術/治癒/疾風之步。源不含SP授予脚本，未将技能节点当作升级规则证明。
- 来源：跨区历史R规则 https://en.wikibooks.org/wiki/MapleStory/Beginner_Guide/Skills 与 https://strategywiki.org/wiki/MapleStory/Job_Advancements 支持2..7各1SP；JMS官方 https://maplestory.nexon.co.jp/gameguide/growth/skill/ 只作现代职业SP背景。该初心者数值暂标P，未宣称来自TMS273执行脚本。
- 验证通过：cargo test beginner_sp_growth_and_legacy_repair_are_idempotent（旧档已升级/已消费/超额保留、重复登录、数据库重开、2..8跨级、法师200/220/221/222隔离）；cargo test mage_level_up_grants_three_book_points_once_across_reward_replay；client npm run typecheck；node client/src/features/skills/points.check.mjs。新增检查仅2文件约90行。初次编译遇三转在途类型错误，所有者修复后本任务两项通过；旧view.check精神强化toggle断言由三转任务收口，未以其失败冒充全套通过。
- 发布边界：本任务未重启服务、未写在线库或更新dist。两条旧初心者各1SP为待补差额，新版本统一发布后首次角色入图自动写入；用户实玩与实际补偿到账待验。


## 冰雷三转核心大模块：代码与有限验证完成，未在线发布（2026-09-08）

- 联网核对 https://maplestory.nexon.co.jp/job/adventurer/archmage02/ ，仅采用R职业结构/技能类型；TMS273.7 Skill/221、String、任务36329/1434与实际Mob源决定数值/等级/素材。旧1436 blocked=1不启用；缺原版脚本与执行时序继续标P，不替换冒险家原剧情或重置存档。
- P汉斯lv60/job220→221入口、book221首次5SP/之后每级3SP；CAS防重发，旧221不自动补点，222沿用原220升级点数并可花已有221点。已合并并行初心者SP差额修复（其独立验证见对应历史）。临时经验曲线沿用15*level²扩至100，仍非官方经验表。
- 源目录29节点/三本书，新增12个221节点，隐藏2211015禁止直接学习/施放。全部三转原图/音效、5种角色姿态及两性/装扮部件导出；冰风暴原始0 delay保留元数据、显示至少1ms。雷球stand/move/attack源序列独立于施法光效。装配content tms273-4，17图/3215引用素材；protocol7只新增可选派生/召唤快照字段。
- 权威World接冰风暴/冰墙8目标4段、瞬移增距与精通伤害/眩晕、精通被动抗击退、魔力激发MP/伤害、暴击、终极魔法状态增伤、冻结逐层概率无视魔防、自然重置独立最终伤害。真实4怪MDRate=10；没有元素抗性源，不把mdRate冒当元素抗性。
- P雷球每角色至多1个，1080ms脉冲；普通2211011移动/time60+3x，↓0转固定2211015/time20+2x，沿用主技能等级，转换不延长原到期或重置脉冲。独立攻击原点不改角色坐标；同请求不重扣MP、不重建球；死亡/离图/断线/到期清理。u2只给普通怪追加源倍率，Boss不加。
- 元素适应MP/CD同SQLite事务、重登不能绕过CD，P施放即启动CD并刷新8次防护计数；源被动异常/元素耐性常驻，不依赖开关或剩余次数。当前4怪没有致命异常攻击，防护消耗/重建尚无实际敌方状态入口，不能宣称已验证完整异常防御；后续Boss/状态模块补齐。原作在防御次数耗尽后启动CD的时点尚未复刻。
- K技能页显示三转/学习门槛、施放或开关、冷却/防护次数、不可用原因；8冰风暴、9冰墙、0雷球、↓0固定。客户端按权威召唤快照用原帧呈现并清理；精神强化修正为限时buff刷新，非开关。
- 验证：auth third_store_* 3/3；world third_* 3/3，失败仅修测试夹具的Join、持久skills seed与baseMP，再精确复跑失败项。另补雷球真实脉冲/固定原点/同tick不重复、普通331%×3与Boss256%×3、未开启元素适应仍有被动抗性断言，精确通过；最后Rust编译无警告。冻结只在首次成功结算后加层，失败不留免费层。
- 有限检查脚本：third_acceptance.rs 247行、third_store_acceptance.rs 137行、skills/view.check.mjs 156行、combat/skill.check.mjs 93行、check_tms273_runtime.cjs 37行，共670行；加auth/world两处include合计7文件、672行，未超≤7/≤1000。客户端三脚本通过；npm run build -- --outDir dist-third-check成功；git diff --check通过。无独立QA或在线测试账号。
- 离线生产构建v0.7.0在client/dist-third-check（JS index-DOWHxrA2.js），未覆盖在线dist-tms273、未重启服务或更改在线数据库。在线仍v0.6.1/content3；下次通过启动3010.command构建加载。用户实玩动作、声音、击退、遮挡与技能节奏待验。
- 已释放业务/导出/协议文件给用户初心者技能任务01a07ef8-4afc-7762-b743-f0b90a481015继续0001000/1/2；其后续32目录/content5不属于上述29目录验证结果。完整冰雷四转、后续区域/成长/Boss、36308+及原版执行时序仍未完成，未触发Codex彩蛋，整体goal保持进行中。

## 冰雷四转来源核定（2026-09-08，尚未接运行）

- ice-fourth-job-source.json记录Skill/222的26节点（普通11、Hyper12、隐藏3），实际Skill包entry14解出144988 bytes；JSON/WZ共享语义与String字段一致，保留文件哈希、原始公式/req、动作、视觉outlink和Sound/UOL。不是技能已可玩证据。
- 已确认10/12段与15目标、按压束缚/90秒抗性、AP投入属性被动、冰魔与雷球共存、固定2220015。冰锋刃time4000/attackDelay210单位及服务器时序仍需明确P执行；净化common.time1与文本免疫3秒分开，不使用旧pdesc覆盖当前h。
- ice-fourth-job-transfer-source.json保留1452/1453/36330–36333及排除事件13030的原条件/文本/哈希；lv100/job221有同版来源，未恢复原执行脚本。JMS官方职业与成长指南、MSEA历史SP/2023技能公告仅为R；初始3加101–140累计252恰为255学习SP，仅为P候选，不证明TMS授予规则。
- 只做来源和静态架构核对，未运行四转业务测试、未改在线服务/数据库。后续定向查明112/212分别在_Canvas_003/038.wz；完整reader可解析，先前假缺失来自临时目录只挂载000/035/040。源产物已补两个archive哈希与代表性帧尺寸，四转导出时补挂载即可，不需改通用reader。


## 初心者三技能内容闭环（2026-09-08，v0.7.1 / content5）

- 用户要求先查现有参考、缺失再联网。本地实际TMS273.7 Skill/000.img、String/Skill.img与Sound/Skill.img已核并导出：0001000嫩寶丟擲術、0001001治癒、0001002疾風之步，内容key规范1000/1001/1002，book0、max3，原前导零路径与指纹保留在resources/tms273-export/skills.json、mage-effects.json、skill-sounds.json。其余五个可见节点缺默认授予/解锁依据，未擅自免费开放。
- T数值：丢掷MP3/5/7、固定伤害10/25/40；治愈MP5/10/15、30秒恢复24/48/72HP、CD120秒；疾风MP4/7/10、持续4/8/12秒、速度+10/15/20、CD60秒。源无壳消耗字段，不套Classic/私服材料消耗。三技能图标与各级说明；丢掷每级球3帧/命中6帧、治愈13帧/疾风12帧、原Use/Hit音效均已导出。
- 复用SP/技能动作账本与MP/冷却事务，book0仅允许这三项最高3级；重放不重复扣SP/MP，转职后保留初心者学习/使用权限，已消费SP不会被旧档补偿重新加回。丢掷单目标固定伤害、不受魔攻/暴击/魔防影响，具有动作锁；治愈六次tick先持久保存再改内存HP，不超上限；疾风实际改变移动速度，死亡/离图/断线清buff，CD仍持久且重登可见。
- P适配边界：源未给1000精确距离/命中调度，复用当前远程340px与600ms动作锁，立即权威结算；回血每5秒一次由源x与30秒总量推导。针对本地缺失的执行时点已补查 https://maplestorywiki.net/w/Three_Snails 与 https://maplestorywiki.net/w/Recovery 等跨区资料，未取得TMS273精确执行证据，不采用Classic冲突数值。现有基础MP容量/成长保持原规则，未为施放免费加MP或降低源消耗。
- 前端K初心者页可学习/施放，初心者1/2/3分别丢掷/治愈/疾风；转职后快捷键恢复原职业映射，初心者页仍可操作。显示效果/CD剩余时间；skillCast/damageEvent可选skillLevel锁定对应球/命中素材。DerivedStats新增可选skillCooldowns/skillBuffs，协议7兼容，content5。运行manifest将分级效果投影为1000:1..3扁平组并去掉顶层来源对象，维持预加载数组契约；完整来源仍留原导出。
- 验证通过：auth::beginner_learning_sp_and_cooldowns_survive_replay_and_reopen；world::beginner_skill_runtime_locks_fixed_damage_and_timed_buffs；mage::bundled_catalog_is_strict_and_has_energy_bolt_geometry（真实32节点）；cargo check；client typecheck；points.check.mjs/input.check.mjs/combat/skill.check.mjs；check_tms273_runtime.cjs tms273-5（17地图、24034素材引用）；Vite生产构建到client/dist-beginner-check；定向diff空白检查。核心检查变更7文件、不到500行，无独立QA。
- 发布与用户待验：源码/资源装配已完成，未更新在线dist-tms273、未重启服务、未写在线账号库；下次根启动3010.command统一带入。待用户实际验收K加点、1/2/3施放、原素材朝向/位置、MP提示和旧账号补点到账。初心者三技能已完成，不能把更高转职或所有000事件技能算作完成。


## 2026-09-08 普通四转运行基线 v0.8.0 / protocol8 / content6

- 已接11普通四转源节点，累计43目录；原初心者/前三转保留。Hans P lv100四转、SP差额修复/学习前置/固定技能在现有CAS，原剧情和存档保留。按压释放、束缚与90秒免疫、防御削减、独立冰魔/冰锋刃/雷球、Infinity基础MP恢复/后段提示、实际命中触发暴风雪追加及属性接入。
- 源资源装配17图/3929素材/52NPC/4怪、31845资源引用。修复隐藏追加元数据混入数组、按压初始0误清普攻、q受buff时长放大、Infinity毫秒/tick混用、追加攻击目标错配和净化伪清攻击。旁观者恢复双层按压与声音清理已接。
- 必要验证：world::tests::fourth_job_core_channel_bind_summon_infinity_and_blizzard 1/1；mage::tests::bundled_catalog_is_strict_and_has_energy_bolt_geometry 1/1；fourth_store_ 4/4；mage_level_up_grants_three_book_points_once_across_reward_replay 1/1；cargo check通过。前端typecheck、skills/view.check.mjs、combat/skill.check.mjs、check_tms273_runtime.cjs通过；dist-fourth-check生产构建通过。
- 核心检查共7文件，独立4文件507行+world新增247行+mage既有检查约35行/auth接入及旧用例范围，合计低于1000行。没有独立QA或重复全套验收。
- 边界：SP历史MSEA分档、Hans入口、部分执行节拍均P而非原脚本；Hyper未开放。净化虽保留3秒免疫权威窗口，但当前敌方异常入口仍缺，尚不能宣称真实异常解除/拦截完成，需接后续状态/Boss。原版四转剧情脚本未恢复。在线dist/服务/数据库未修改，实际画面与手感用户待验。


## 2026-09-08 区域成长与首只Boss练习 v0.9.0 / protocol9 / content7

- 开发与有限核心验证完成：30张原地图、85NPC资源、17怪模板（16图内+独立树妖王）、459真实物品，37647源资源引用。新增13图按原门户/foothold/life导入；缺源2212004保留来源缺口，禁止生成假属性/假图标并从激活掉落和商店过滤。导出入口统一实际TMS273目录，不再误标旧路径。
- 树妖王3220000仅为102020500的P私有练习，Lv25入口；原HP7500、3420ms攻击、1500/1320ms命中时点向上取整，原防御/治疗动作和真实MobSkill特效。服务端遭遇ID隔离、操作去重和旧场次拒绝；零经验/掉落，不写原任务完成，不占正式奖励。强控取消排队攻击，死亡保留源动画后返回，失败/退出/断线恢复真实地图；已完成状态可关闭/重试。
- 接触与Boss受击复用候选Profile提交后才更新世界，错误不吞；退出提交失败不缓存成功。攻击账本增加map绑定，新claim和未完成resolve双重拒绝跨地图；旧无地图未完成记录拒绝恢复，已完成结果仍安全重放。实践击杀账本practice=1、Store强制零奖励；无Store路径也实际验证零奖励。原账号和剧情保持，未触碰在线数据库。
- 前端复用sourceMapId地图/原动作；BGM按资源URL复用避免私有图漏加载与重试增长。预警由服务端世界坐标驱动，入口/HP/阶段/退出重试可见，练习禁止丢物和金币。112/113重复effect与mob0只播一组800ms光效，状态图标延续；114保留1100ms源空帧与2060ms总时间，缺失effect不伪造。死亡/离图清理，成功提示不显示成错误。新增装备level嵌套元数据由unknown值类型保留，原数值读取路径不变。
- 验证：attack_store_ 2/2通过（含临时DB关闭重开、旧schema迁移、旧未完成/跨map拒绝、已完成重放、正式奖励保留）；boss_practice_ 3/3通过（实际30图资格和站位、观察者隔离、旧遭遇/重复请求、失败可重试、真实无Store普攻击杀零奖励、断线恢复、受击失败不改HP/MP、死亡时序、朝向、控制、112/113/114边界）。cargo check通过；仅既存contact_damage dead-code警告。
- 前端typecheck、boss.check.mjs、check_tms273_runtime.cjs通过；最后一次dist-boss-check离线构建通过，JS约1.70MB触发现有体积阈值提示，没有为此引入新拆包机制。git diff --check通过。核心6文件：4个集中脚本共507行（264+121+54+68），另auth/world宿主和必要签名增量后不足550行；未跑独立QA。
- 来源边界：victoria-first-boss-source.json保留T原字段、R官方MSEA练习隔离与Swordie v206 MobSkill语义、P执行选择。2813–2816及上游任务blocked，未解封；两个私服千万HP/地图冲突配置排除。112/113保留对应伤害85%、114以80%门槛恢复700、调度节拍、圆形attack2与特效挂点为P，不冒称原作精确执行。原正式生成/奖励和敌方玩家异常仍U；未把首只练习等同完整M4。
- 在线dist-tms273/服务未更新；用户待验实际30图行走、Boss手感/预警/特效遮挡、宽屏/横屏/窄屏交互。后续启动统一启动3010.command，正常保留存档。


## 技能详情灰白遮挡与273快捷栏（2026-09-08）

- root统筹main/input集成与离线组件验收；skill_detail、shortcut_hud、shortcut_source均Luna/max。未启动独立QA、未重启在线服务或修改账号库。
- 根因已用真实273资源复现：详情学习按钮的skill-action-art继承绝对定位与100%宽高，缺少定位父级，渲染为299×260覆盖详情（技能图标仍32×32）。skills/style.css为详情动作按钮补position:relative，修复所有按钮态，不改源素材。before-detail-1440x900.png与修复截图保存在output/playwright/hud-skills/。
- HudView接32个源槽与18个现有绑定（1–0、四转Shift+1–8），显示技能图标/等级/冷却秒数/不可用态/开关态，支持点击与2221011长按请求及松手、焦点变化、死亡、隐藏、清理、切图释放。指针操作保持游戏焦点；键盘仍可Tab进入。input.ts的shortcutSkill由HUD和物理键盘复用，main复用同一施放请求生成器；无服务端或协议修改。
- T依据：已实际打开UI/StatusBar3.img/mainBar/quickSlot/backgrnd原始557×67图，16×2、32px槽、35px间距；参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW/UI/UIQuickSlot.json明确35间距和4×2至16×2设置范围。网页响应式重排、文字折叠按钮与现有固定映射为P适配；未拿83槽态替代273。尚无完整改键、道具绑定、原版设置/折叠控件导出，不宣称整个273键盘设置1:1。
- 研究包HTML A01/A02只作为候选索引；A01仅核到远图元数据，A02远图未作视觉结论。MSEA官方https://www.maplesea.com/guide/user_interface/ 与https://www.maplesea.com/guide/control/ 的展开/收起及技能/物品绑定说明为R结构参照，不当作TMS273精确默认键位。
- 验证通过：input.check.mjs（含共享映射初心者/一转/Numpad/四转边界）；skills/view.check.mjs；HUD gauge检查；scripts/check_hud_skill_ui.mjs（79行离线真实组件：1440×900、844×390、390×844、320×568和回到桌面，无横溢出/按钮出界、详情图像不越32px；32槽/普通点击/冷却/折叠/指针保持游戏焦点/快照禁用后松手/焦点变化立即释放/玩家消失释放）。最终npm run build -- --outDir ../output/hud-ui-build通过，TS通过；现有Phaser大包仍有约1.71MB体积警告。
- 在线dist-tms273未覆盖；后续统一启动3010.command带入，实际地图遮挡/战斗手感交用户亲测。


## 自然恢复永久被动（2026-09-08）

- 用户P数值：初心者基础HP/MP各+1每秒；冒险家法师系额外MP+1，战士系额外HP+2，后续转职保留基础与对应职业被动（合计初心者1/1、法师1/2、战士3/1）。每职业一个额外永久被动，自动获得，不消耗SP，不发送施放意图，不污染原版技能ID或技能等级存档。
- 同版依据与联网工程方案保存于references/tms273-data/natural-recovery-source.json：0001001是主动30秒治癒；2000006、1000003、1000009是MP/HP上限或成长；1110000周期恢复为后续职业参考。联网Epic Gameplay Effects采用Infinite+Periodic结构、Unity为服务器权威参考；MSEA历史初心者指南仅作主动/被动区分，不套用其旧冷却/转职值。
- Rust world.rs在单一顺序step内结算，每角色入图完整1秒后恢复；死亡暂停，复活/切图重置计时，重连不补离线，HP/MP分别封顶。只到恢复边界且缺资源才复制候选/写SQLite，保存成功后改世界，失败等下秒重试不补欠账。永久被动按权威job派生，独立于有期限skill_buffs，玩家输入与伪造技能等级不能堆叠它。
- 协议新增兼容regenerationPassives（id/bookId/hpPerSecond/mpPerSecond），TS为可选，旧快照不虚构恢复；bot直接保留服务器快照，无新增发送字段。K窗口复用273 skill0原格展示永久文字卡，点击仅显示说明；战士被动有对应book100标签。未伪造原版图标/技能ID，未扩展战士转职入口。C06远程图本轮无法打开，已查看现有本地273背景并复用组件。
- 验证：`/Users/muniao/.cargo/bin/cargo test natural_recovery -- --nocapture` 3/3通过，覆盖职业/后续转职/非对应职业、不受技能叠加、19/20 tick、封顶、死亡复活、重连无离线、成功落库和保存失败不改内存/不密集重试；`beginner_skill_runtime_locks_fixed_damage_and_timed_buffs` 1/1通过，原治癒与新增秒回叠加断言同步。最初章节测试两处Result索引编译错误由章节开发者修复后通过，不改其业务范围。
- 前端`npm run typecheck`通过；`node scripts/check_hud_skill_ui.mjs --regeneration`通过权威快照/点击不发请求/职业继承/死亡保留、1440×900、844×390、390×844、320×568与resize。截图output/playwright/hud-skills/regeneration-*.png；390×844已目视检查。`npx vite build --outDir ../output/regeneration-build`通过（现有包体积警告保留），无覆盖在线dist。定向检查新增/修改仅world.rs内联检查与现有UI检查脚本，不启动独立QA。
- 本模块文件释放；在线服务/数据库未变，下次统一启动3010.command加载。尚未实际账号实玩，数值遵从用户P规则，不冒称TMS273原作秒回。


## 2026-09-08 原剧情接续执行 v0.10.0 / protocol9 / content8

- 接续九任务1402→36337→36308…36314已接入，累计15条可执行任务、64条原始任务；任务导入器补收363xx之外的1402。41张源地图与NPC/物品已装配，源Mob0210100从同版MS解包，帽子1003134的两性纸娃娃动作沿已有导出器接入。
- T：保留原QuestInfo/Check、NPC模板/源life、地图几何和物品数值；帽子reqLevel=0、reqJob=0、防御30及原禁止交易字段保留。adventurer-continuation-source.json与chapter.json保存源指纹/原始节点。R：官方MSEA v217的有条件主动跳剧情仅作为结构参照，不自动补记剧情。
- P：明确NPC接取/交付替代缺失q1402/q363演出；选择法师路线恢复，不自动填写1406或其它职业剧情。章节EXP依次0/300/450/600/750/900/1050/1200/1500，无金币。那因哈特接取时发书信；伦多接取潜入时发原帽子、需实际戴帽；潜入后伦多交接找到的文件/封印石，回赫丽娜交付。物品不可交易/丢弃，重复接取不额外发放。Olivia使用原模板放在耶雷弗源入口平台，仅36309进行中显示；原源位置仍留档。
- P交通：图书馆/弓箭手中心缺脚本门户绑定本地对应端点；远程章节传送及在发起NPC续行明确为适配。任务ID与菜单动作绑定，选择时重验状态/源NPC/条件；源空中出生点保留自然下落。原版完整过场、取得物品的演出与精确奖励/交通脚本仍U，不宣称原场景1:1完成。
- 后端：q1402通过现有commit_quest同事务提交职业/SP/MP、任务与mage_support_granted；DB核10级/36307/旧职业，错误候选拒绝。既有200/220/221/222仅恢复剧情，不降职、不重复授予。startItems与任务/传送同事务，满包无半提交；装备目标读取真实equipped，换装刷新日志。warp_player由候选先落库再发布，失败保留位置/施法/恢复时钟，可重试；已与自然恢复模块同步地图切换时钟。
- 有限核心：continuation_store_ 2/2通过；world::tests::continuation_ 3/3通过，使用实际41图/NPC菜单走完整链、重连书信、真实戴帽、重复领奖、23格占用后的双物品原子回滚、过期菜单、旧222职业/SP与保存失败后重试。新脚本276+111行；既有Boss图数断言仅维护为41、未重跑Boss；源检查85行通过41图/42672资源引用/两端几何和前置源一致。计6文件，集中脚本736行，含宿主增量不足750行。
- 编译由上述定向Cargo测试完成；相关git diff --check通过。前端复用并行自然恢复任务本次通过的typecheck与output/regeneration-build离线构建：root核实产物manifest与当前public SHA相同、content8/41图，源码TS/CSS无更新；未重复构建。自然恢复3+1测试属于其独立用户模块，不计本章节验收，也不冒充章节覆盖。
- 未发布在线dist、未启动/重启服务、未改在线库。用户待验实体路线与门户、长任务文本/目标提示、源NPC挂点与帽子层、原地图行走/遮挡/音效。下次仅通过根启动3010.command加载。完整M2、Hyper/V/HEXA及后续研究包目标继续在PLAN，不触发冰雷完成彩蛋。

## 网页右键浏览器菜单拦截（2026-09-08）

- client/src/app/main.ts初始化时在document捕获contextmenu并preventDefault，覆盖登录与游戏页面，不停止事件传播，保留背包丢弃/装备卸下右键逻辑。
- Node EventTarget定向自检通过：contextmenu默认行为取消、后续游戏监听器仍执行、普通click不取消；npm --prefix client run typecheck通过。未更新在线dist或重启服务，下次统一构建加载，真实浏览器右键待用户验收。

## 启动资源检查过期修复（2026-09-08）

- 用户运行启动3010.command在资源检查阶段失败：Hyper生成/装配已为content9、200级经验表和56技能，check_tms273_runtime.cjs仍保留content8、140级、43技能预期。仅更新三处检查契约，保留完整经验公式、等级上限终值0和资源检查，不回退数据或绕过检查。
- node scripts/check_tms273_runtime.cjs tms273-9通过（41 maps、44582 source references）。仅离线检查；未重启服务、未更新dist或更改存档；不代表在途Hyper业务已完成验收。

## 用户启动编译恢复（2026-09-08）

- 启动失败根因是同工作区Hyper在途代码未完成：world.rs缺Player会话字段、两个激活方法和错名常量。协调所属任务01a07eb1-c556-72d1-9874-7078fb1772c0/Luna完成实现并冻结，本任务compile_trace Luna/max只读核世界循环与快照入口；未交叉编辑业务。
- 统一构建进一步发现并由所属开发者修复：combat/view.ts两处player空值收窄、world.rs增伤分支多余闭括号。并行核心检查修复窄屏纵向定位和结界Use重复音效后，本任务对最终代码重建。
- 最终/Users/muniao/.cargo/bin/cargo build --manifest-path server/Cargo.toml通过，7.78s；仅contact_damage dead_code警告。npm run build -- --outDir ../output/startup-recovery-build通过（含tsc），47模块/5.18s；产物index-CSBIPrvv.js、index-CmB4sO2_.css，仅chunk超1600kB预算提示。启动资源检查已有通过证据，未重复运行。
- 未重启在线服务、未覆盖online dist、未修改存档；恢复的是构建阻塞，Hyper核心业务验收仍由所属任务继续，不把编译通过当作全部业务完成。用户可用根启动3010.command加载，实际启动/实玩待验。

## 2026-09-08：按用户新目标完成编译收尾

- 用户把持续复刻目标改为尽快结束、保证前后端语法与编译正常；未完成业务已写入PLAN.md顶部TODO，V核心只读代理已中断，不继续扩展。
- 当前Hyper源码v0.11.0/protocol10/content9：最终`cargo build --manifest-path server/Cargo.toml`通过（启动恢复任务回传7.78s），最终前端`npm run build -- --outDir ../output/startup-recovery-build`通过（5.18s，tsc无错误，index-CSBIPrvv.js/index-CmB4sO2_.css）。仅contact_damage未使用、前端chunk预算警告。业务源码此后没有改变；仅补齐cfg(test)脚本与文档。
- Hyper有限核心验证：auth三项通过；World首次夹具没有save_profile导致技能未写入，已修夹具；脉冲断言改为实际15条damageEvent及总HP扣减，避免误用另一伤害路径的贡献表。World释放/50%减伤、增伤/漩涡/重置两项通过后，脉冲一项定向复验通过。最后Rust测试编译通过，无剩余失败。
- 前端UI检查通过（等级/两池/隐藏排除/长按配对/重置取消和报价/5次尺寸变化），实际combat/player模块检查通过（1052阶段释放、1054唯一音效、1055清理）；修复320px窗口纵向居中与重复Use。源runtime检查通过结果复用。7个检查文件含两个宿主include，脚本605行+include2行，合计607行。
- 原版剧情与存档保留，未覆盖online dist、重启服务或操作在线角色库。专用Hyper原窗/精确节拍/敌方异常/队伍传播/Special目标标记及后续研究包业务均未宣称完成，已列TODO。

## Windows 启停与 TMS273 资源压缩包（2026-09-08）

- 新增start.bat/stop.bat和scripts/windows-control.ps1：Node>=22.12、npm/Cargo依赖检查，锁文件安装与构建，前端暂存后发布；固定本地3010与全部运行数据路径，按PID/绝对exe路径/启动时间识别本项目进程，控制操作互斥；health核对协议/资源版本及监听PID，失败清理本轮启动进程。普通启停保留server/data，不管理bot或在线macOS服务。
- README按Windows首次安装→资源解压→日常启停→日志排障整理，明确ZIP解压到start.bat所在根目录，包含目录示例和PowerShell命令；旧17图/全部任务禁用等过期介绍改为当前范围及缺口。
- MapleStory-TMS273-resources.zip：209,418,874 bytes（约200 MiB），5,901文件，client/public-tms273完整运行树+shared/*.json；无源码、node_modules、原WZ、账号库/凭据。SHA256=5d507f8bf45ae800d3b9612c9ecd90c1c593ed9eedc617c8220a1f19d27811ba，另附.sha256；ZIP被gitignore排除，需单独传输。
- scripts/package_windows_resources.py可复现打包，CRC、逐文件SHA256和数量校验通过；运行检查14 JSON/104429素材引用/41图通过。中文空格临时目录干净解压、不含参考WZ的检查通过；错误contentVersion和缺引用文件拒绝通过。BAT CRLF/ASCII与静态diff检查通过。
- scripts/windows-control.ps1 -SelfTest保留PID/路径/启动时间匹配检查。本机无Windows/PowerShell，未运行PS解析或自检、Windows编译/真实启动/停止/浏览器验收；由用户Windows实机验证。未修改游戏业务、重启在线服务或操作账号数据库。

## 选择岔道水域与木架踏板：平面物理水与游泳（2026-09-09）

- 地图几何（P，用户指定两条截图标记）：001020000 移除木架竖墙 foothold 58、右岸 foothold 15 左端由 637 改为 580 并断开 prev、新增踏板 foothold 59（620..690，y=180），构成「岸→踏板→木架 foothold 57」两跳路线；新增水区 x 0..580、水面 y=224、池底折线 278..340。改动由装配脚本 `scripts/tms273_split_road.cjs` 单一生成，对齐/幂等/运行时数据自检通过，已同步 `shared/maps.json` 与 `client/public-tms273/assets/manifest.json`。
- 踏板贴图取自同图 `Map/Obj/acc1.img/grassySoil_new/house5/1` 木架原图的 crop(570,130,70,20)，对齐到 foothold 59 的世界坐标，不是自绘资源；渲染侧新增 `MapLayer.crop` 字段支持。
- 服务端（`server/src/world.rs`、`server/src/water_acceptance.rs`，Luna/max后端子代理）：`WaterRect`（含 floor 插值与启动校验）、`water_at/water_entry/water_below`、玩家 `swimming` 状态、↓+跳下跳入水、水域边缘进入、水中按方向游动与跳跃上岸、掉落物漂浮常量 `DROP_WATER_DRAFT = 16`（锚点=水面 y_min+16，夹在 floor 内，保证游泳玩家 32px 拾取范围可达；木架与岸上坐标不受影响，幂等）。
- 客户端（新增 `client/src/features/world/water.ts`，root）：按 `Web_TS_2D_Water_Development_Plan` 的模拟核心在 Phaser 内实现一维高度场水面（反射边界、两条环境波、固定 1/120 步长与积压裁剪、位移限幅）、按接触宽度归一化的入水冲量（网格细化不改变总注入冲量）、池化水花、掉落物固定吃水浮力（弹簧趋近、随波起伏、随水面斜率倾斜）、玩家入水/游动涟漪；水体前后两层绘制，使游泳角色与漂浮物水下部分由同一条水线着色。计划原定 Three.js + Rapier 的 Demo 栈未引入：本项目已有 Phaser 渲染与服务端权威物理，只移植模拟核心，客户端不回写任何权威坐标。
- 验证：`cargo test --offline water_` 2 项通过（`water_is_finite_enterable_and_swimmable_without_foothold_edges`、`water_drops_float_to_surface_but_not_onto_land`）；全量 `cargo test --offline` 127 passed / 4 failed，4 项失败经 stash 基线复现为既有问题（auth third_store_book_split、mage bundled_catalog、world config_drop_and_exp、world third_sphere），与本轮无关。前端 `tsc --noEmit` 通过、`client/src/features/world/water.check.mjs` 六组水面/浮力检查通过、`vite build`（dist-water-check，1m10s）通过，仅既有 chunk 体积警告。`npm run check` 中 `input.check.mjs` 在既有快捷键断言（222/Digit9）失败，与本轮无关、未修改。
- 待验（用户实玩）：波浪幅度、水花密度、漂浮姿态与吃水位置的手感；踏板两跳上木架；岸→水→岸与水中拾取。游泳沿用 jump pose（当前头像契约没有 swim 动作，未改协议）。未重启在线服务、未改数据库、未启动独立 QA。
