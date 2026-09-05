# 已完成历史档案

更新：2026-09-05。仅保存完成结果、验证证据和必要决策；当前待办在PLAN.md，长期规范在BUSINESS_DEVELOPMENT.md。新任务不默认全文读取本档案，只在相关追溯时读取。

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
