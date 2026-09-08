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

资源压缩包：**[MapleStory-TMS273-resources.zip](MapleStory-TMS273-resources.zip)**（约 200 MiB，5,901 个文件）。

**解压到项目根目录，也就是 `start.bat`、`stop.bat` 和本 README 所在的文件夹。**

例如源码放在 `D:\MapleStory`，解压目标就选 `D:\MapleStory`，不要选它的 `client` 子目录，也不要额外套一层 `MapleStory-TMS273-resources` 文件夹。可以在项目根目录打开 PowerShell 执行：

```powershell
Expand-Archive -LiteralPath .\MapleStory-TMS273-resources.zip -DestinationPath . -Force
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

可选：执行 `Get-FileHash .\MapleStory-TMS273-resources.zip -Algorithm SHA256`，与同目录 [SHA256 校验文件](MapleStory-TMS273-resources.zip.sha256) 比较，确认传输完整。

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
| 启动后无法访问 | 查看启动窗口错误及 `evidence/runtime/windows-3010/` 中的 `build.log`、`server.log`、`server-error.log`。 |

## 操作与当前范围

方向键或 A/D 移动，空格跳跃，X/Ctrl 普攻，上方向进入传送门；I 背包、Q 任务、K 技能、C 属性。技能快捷键以页面显示为准。默认简体中文，可切换 English；图片内文字保留原版繁体。

当前源码为 v0.11.0 / protocol 10 / tms273-9，已接入 41 张地图、15 条可执行任务、法师至冰雷四转及部分 Hyper、经验升级与 AP、背包换装和 Boss 练习。缺失原版执行依据的适配规则标为 P，不代表完整原作复刻。完整过场、后续剧情、V/HEXA、现代装备成长及正式 Boss 奖励仍待开发。

## 开发与资源维护

开始开发先读 [长期规范](BUSINESS_DEVELOPMENT.md) 和 [当前计划](PLAN.md)，历史验证见 [完成记录](IMPLEMENTATION_STATUS.md)。

普通启动只需上述资源包，不需要 `参考/273`。需要重新导出原版资源时，必须另备同版参考资料及导出工具环境：

```sh
npm ci --prefix scripts
npm ci --prefix client
node scripts/build_tms273.cjs
```

导出中间产物为 `resources/tms273-export`，运行资源为 `client/public-tms273`，生产前端为 `client/dist-tms273`。`check_tms273_runtime.cjs` 是开发侧溯源检查，需要完整参考目录；Windows 启动使用不依赖原始 WZ 的资源检查。

维护者重新打包（需要 Python 3 和 Node，普通 Windows 使用者不用执行）：

```sh
python3 scripts/package_windows_resources.py
```

命令先检查运行资源，再生成根目录 ZIP 和 SHA256 文件，并逐项核验压缩内容。资源包不含账号、凭据、日志、原始 WZ 或旧 83 资源。

Windows 上可单独运行进程身份检查（不启动或停止服务）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-control.ps1 -SelfTest
```

本次在 macOS 上完成脚本静态核对、可执行资源检查和压缩完整性检查；本机没有 PowerShell / Windows，`-SelfTest` 及 Windows 实机的安装、启动、停止与浏览器运行仍待验证。
