# MapleStory Web · TMS273

基于 TMS273.7 素材的网页游戏：TypeScript / Phaser 前端，Rust / SQLite 服务端。使用项目自有 WebSocket 协议，不是原版 Windows 客户端。

## Windows：首次启动

1. 安装 [Node.js LTS](https://nodejs.org/en/download)（建议 24 LTS，最低 22.12，包含 npm）。
2. 安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，勾选 **使用 C++ 的桌面开发**，包含 MSVC 和 Windows SDK；再安装 [Rust](https://rust-lang.org/tools/install/) 的默认 MSVC 工具链。安装后重新打开终端。
3. 将项目源码放到本地文件夹，例如 `D:\MapleStory`。从 Mac 搬运时不带 `node_modules`、`server/target` 或旧构建目录，让 Windows 重新安装和编译。
4. 按下节解压资源包，然后双击根目录 **`start.bat`**。首次启动会联网下载 npm / Cargo 依赖并编译，请等待窗口提示成功。
5. 浏览器打开 **[http://127.0.0.1:3010](http://127.0.0.1:3010)**，首次使用注册账号。

Windows 使用系统自带的 Windows PowerShell 5.1，无需另装 PowerShell 7、Python、Java、MySQL 或原版游戏客户端。SQLite 随服务端编译。

## 资源包解压位置

资源压缩包：**[MapleStory-TMS273-resources.zip](build/current/packages/resources/MapleStory-TMS273-resources.zip)**（约 246 MiB，11,092 个文件）。

**解压到项目根目录，也就是 `start.bat`、`stop.bat` 和本 README 所在的文件夹。**

例如源码放在 `D:\MapleStory`，解压目标就选 `D:\MapleStory`，不要选它的 `client` 子目录，也不要额外套一层 `MapleStory-TMS273-resources` 文件夹。将压缩包存放到 `build/current/packages/resources/` 后，可以在项目根目录打开 PowerShell 执行：

```powershell
Expand-Archive -LiteralPath .\build\current\packages\resources\MapleStory-TMS273-resources.zip -DestinationPath . -Force
```

解压后应是：

```text
D:\MapleStory\
├── start.bat
├── stop.bat
├── README.md
├── scripts\
├── server\
├── shared\
│   ├── gameplay.json
│   ├── maps.json
│   ├── mage-skills.json
│   └── …
└── client\
    ├── package.json
    └── public-tms273\
        └── assets\
            ├── manifest.json
            ├── entry\
            └── tms273\
```

包内包含已导出的图片、动画、音效、角色创建素材，以及配套 `shared/*.json`；**不包含源码、编译工具、依赖包或账号数据库**，必须搭配本项目源码使用。首次编译仍需联网。该包对应当前 `tms273-9`，不要用旧 83 资源包替代。

升级资源时先运行 `stop.bat`，再解压与源码匹配的新包。`-Force` 会覆盖包内同名资源和配置，不涉及 `server/data` 存档。压缩包不随 Git 提交，需要单独传到 Windows。

可选：执行 `Get-FileHash .\build\current\packages\resources\MapleStory-TMS273-resources.zip -Algorithm SHA256`，与同目录 [SHA256 校验文件](build/current/packages/resources/MapleStory-TMS273-resources.zip.sha256) 比较，确认传输完整。

## 日常启动与停止

| 操作 | Windows | macOS |
| --- | --- | --- |
| 启动 | 双击 `start.bat` | 双击 `启动3010.command` |
| 停止 | 双击 `stop.bat` | 双击 `关闭3010.command` |
| 访问 | http://127.0.0.1:3010 | http://127.0.0.1:3010 |

Windows 重复启动会提示本项目已在运行；更新代码后先 `stop.bat` 再 `start.bat`，以重新构建并加载。每次冷启动会执行 `npm ci`，按锁文件安装依赖，再构建前后端。停止脚本只处理记录且身份匹配的本项目服务，不按端口结束其他程序。Windows 启停不创建或管理陪测机器人。

账号和角色保存在 **`server/data/tms273.sqlite3`**，正常启停不会删除。备份时先停止服务，再复制整个 `server/data` 文件夹；换电脑沿用账号时也迁移这个文件夹。新环境没有数据库会自动创建空库。

## 常见问题

| 提示或现象 | 处理 |
| --- | --- |
| 找不到 Node / npm / Cargo | 完成安装后重新打开终端，运行 `node --version`、`npm.cmd --version`、`cargo --version` 核对 PATH。 |
| `link.exe`、MSVC 或 C 编译器缺失 | 在 Build Tools 中补装“使用 C++ 的桌面开发”和 Windows SDK。 |
| 缺少资源、版本不一致 | 检查上述解压目录；重新解压与当前源码对应的资源包。 |
| npm / Cargo 下载失败 | 检查网络或代理，恢复后重新运行 `start.bat`，不要删账号库。 |
| 3010 被其他进程占用 | 手动确认占用程序并关闭，或停止另一个目录运行的本项目；脚本不会强杀它。 |
| 启动后无法访问 | 查看启动窗口错误及 `runtime/windows-3010/` 中的 `build.log`、`server.log`、`server-error.log`。 |

## 操作与当前范围

方向键或 A/D 移动，空格跳跃，X/Ctrl 普攻，上方向进入传送门；I 背包、Q 任务、K 技能、C 属性。技能快捷键以页面显示为准。默认简体中文，可切换 English；图片内文字保留原版繁体。

当前源码为 v0.11.0 / protocol 10 / tms273-9，已接入 41 张地图、15 条可执行任务、法师至冰雷四转及部分 Hyper、经验升级与 AP、背包换装和 Boss 练习。缺失原版执行依据的适配规则标为 P，不代表完整原作复刻。完整过场、后续剧情、V/HEXA、现代装备成长及正式 Boss 奖励仍待开发。

## 项目目录与文件职责

2026-09-12 已按用户确认的方案完成目录迁移，以下为项目目录规范。表内路径均相对项目根目录；进行中的工作统一见 [当前计划](docs/plan/PLAN.md)，迁移结果见 [历史索引](docs/plan/INDEX.md)。

| 目录 / 文件 | 职责与内容归属 | 管理规则 |
| --- | --- | --- |
| `README.md`、`AGENTS.md`、`MEMORY.md` | 项目说明、Agent 工作入口、长期记忆摘要 | 根目录只保留这三份可见文档；`MEMORY.md` 不复制当前计划 |
| 根目录打包、启动、停止命令 | 现有 `.command`、`start.bat`、`stop.bat` | 用户操作入口留在根目录，具体实现放 `scripts/`；其余内容归目录，`.gitignore` 等工具必需隐藏文件例外保留 |
| `docs/plan/PLAN.md` | 所有 Agent 唯一当前计划入口 | 只记录正在做、待做、阻塞、负责人、依赖和验收条件；由 `AGENTS.md` 指向这里 |
| `docs/plan/topics/` | 仍有效的重构、主线、聊天、HMR 等详细实施方案 | 当前计划链接专题方案；专题不另维护一套任务状态 |
| `docs/plan/history/YYYY-MM-DD/任务名.md` | 历史计划、完成记录及阶段快照 | 每任务单文件，标记已完成／未完成／已废弃；未完成快照链接回当前计划，废弃记录注明原因 |
| `docs/plan/INDEX.md` | 历史计划索引，与 `history/` 同级 | 只列日期、任务、状态、文件链接，不复制正文 |
| `docs/design/` | 玩法、剧情、世界意识、界面与数值策划 | 有效文档按主题存放；旧稿放 `history/YYYY-MM-DD/`，由同级 `INDEX.md` 索引 |
| `docs/technical/` | 长期开发规范、前后端架构、共享协议说明、UI 规范、操作手册 | 承接 `docs/technical/BUSINESS_DEVELOPMENT.md` 等；采用有效文档＋历史目录＋索引，执行进度统一回到计划 |
| `client/` | 前端源码、静态资源入口、依赖清单与 Vite 配置 | 保留现有源码路径；代码历史交给 Git，不复制日期版本目录 |
| `server/`、`shared/` | 后端源码、测试夹具；跨端协议与共享业务数据 | 保留现有路径与职责；`server/data/` 数据库独立保护，不参与构建清理 |
| `resources/` | 已导出的游戏素材与内容数据；`scenes/` 场景、`characters/` 人物、`ui/` 界面与审阅清单、`music/` 音乐、`sfx/` 音效，`blender/` 只放 3D 建模资产及必要贴图 | 保持 83、273 与原创版本边界；资源不是临时构建，不按两版规则删除；原创 Windbell 不再使用 `creative/` 聚合目录 |
| `references/`、`参考/` | 研究资料与原始参考仓库；研究包整体归入 `references/tms273_research_pack/` | 大型嵌套参考仓库保留原位，修改前先读其自身规则；研究包内部结构保持完整，历史资料用索引追溯 |
| `scripts/`、`bots/`、`qa/` | 构建、导出、检查工具，陪测机器人与现有验收脚本 | 保留可执行源码；报告、截图和构建产物分别归入对应目录 |
| `evidence/YYYY-MM-DD/任务名/` | 验证报告、截图、日志与必要补丁证据 | 旧输出、缺陷补丁和截图已按内容归入，由 `evidence/INDEX.md` 索引；不自动删除恢复点或数据库快照 |
| `runtime/` | 运行日志、PID、服务控制状态 | 只放当前运行控制和日志；历史快照归证据，启停脚本统一使用此路径 |
| `artifacts/refactor/` | 审计报告、门禁债务登记等工程检查数据 | `debt-register.json` 是检查输入，不能当临时产物清理 |
| `build/current/`、`build/previous/` | 配套前后端成功制品及发布包 | 当前成功版＋上一成功版，共两套；新版本通过必要检查并切换后删除更早版，失败不轮替，仍被运行引用的不删；数据库不入包 |
| `build/tmp/` 与工具原生缓存目录 | 候选构建、各类 `dist-*-check`；`server/target/`、`node_modules/` 等缓存 | 临时构建在任务结束后清理；缓存单独管理，不算历史版本；只清理未被使用的可再生缓存；正式启停使用 `build/current/server/` 中的二进制 |

维护顺序：先确定文件职责，再同步文档链接、启停、打包、构建和检查脚本路径。`npm run check --prefix client` 包含目录归属和构建轮替检查。Vite 的清空输出行为只用于候选构建目录，不能直接清空当前成功版。同名文件先比对，不仅凭名称删除；已完成记录按任务归档，不再新增重复台账。

## 开发与资源维护

开始开发先读 [长期规范](docs/technical/BUSINESS_DEVELOPMENT.md) 和 [当前计划](docs/plan/PLAN.md)，历史验证见 [完成记录](docs/plan/INDEX.md)。

普通启动只需上述资源包，不需要 `参考/273`。需要重新导出原版资源时，必须另备同版参考资料及导出工具环境：

```sh
npm ci --prefix scripts
npm ci --prefix client
node scripts/build_tms273.cjs
```

导出中间产物为 `resources/tms273-export`，运行资源为 `client/public-tms273`，当前前端为 `build/current/client`，直接 `npm run build` 只生成 `build/tmp/client` 候选；启停入口通过统一发布脚本配对构建前后端并轮替。`check_tms273_runtime.cjs` 是开发侧溯源检查，需要完整参考目录；Windows 启动使用不依赖原始 WZ 的资源检查。

维护者重新打包（需要 Python 3 和 Node，普通 Windows 使用者不用执行）：

```sh
python3 scripts/package_windows_resources.py
```

命令先检查运行资源，再生成 `build/current/packages/resources/` 下的 ZIP 和 SHA256 文件（上一包保留在 `build/previous/packages/resources/`），并逐项核验压缩内容。资源包不含账号、凭据、日志、原始 WZ 或旧 83 资源。

Windows 上可单独运行进程身份检查（不启动或停止服务）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-control.ps1 -SelfTest
```

本次在 macOS 上完成脚本静态核对、可执行资源检查和压缩完整性检查；本机没有 PowerShell / Windows，`-SelfTest` 及 Windows 实机的安装、启动、停止与浏览器运行仍待验证。
