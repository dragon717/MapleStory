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
