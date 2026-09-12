# Windows 启停与 TMS273 资源压缩包（2026-09-08）
> 状态：未完成（含已落地部分）

> 来源：迁移前 IMPLEMENTATION_STATUS.md 原第 714–721 行；原条目状态保留，不因迁移改判。


- 新增start.bat/stop.bat和scripts/windows-control.ps1：Node>=22.12、npm/Cargo依赖检查，锁文件安装与构建，前端暂存后发布；固定本地3010与全部运行数据路径，按PID/绝对exe路径/启动时间识别本项目进程，控制操作互斥；health核对协议/资源版本及监听PID，失败清理本轮启动进程。普通启停保留server/data，不管理bot或在线macOS服务。
- README按Windows首次安装→资源解压→日常启停→日志排障整理，明确ZIP解压到start.bat所在根目录，包含目录示例和PowerShell命令；旧17图/全部任务禁用等过期介绍改为当前范围及缺口。
- MapleStory-TMS273-resources.zip：209,418,874 bytes（约200 MiB），5,901文件，client/public-tms273完整运行树+shared/*.json；无源码、node_modules、原WZ、账号库/凭据。SHA256=5d507f8bf45ae800d3b9612c9ecd90c1c593ed9eedc617c8220a1f19d27811ba，另附.sha256；ZIP被gitignore排除，需单独传输。
- scripts/package_windows_resources.py可复现打包，CRC、逐文件SHA256和数量校验通过；运行检查14 JSON/104429素材引用/41图通过。中文空格临时目录干净解压、不含参考WZ的检查通过；错误contentVersion和缺引用文件拒绝通过。BAT CRLF/ASCII与静态diff检查通过。
- scripts/windows-control.ps1 -SelfTest保留PID/路径/启动时间匹配检查。本机无Windows/PowerShell，未运行PS解析或自检、Windows编译/真实启动/停止/浏览器验收；由用户Windows实机验证。未修改游戏业务、重启在线服务或操作账号数据库。

