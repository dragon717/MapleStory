# Blender MCP 持久连接修复

2026-09-24，用户要求三次尝试并修复根因。

## 证据与根因

1. 修复前顺序调用 `get_addon_status` 两次、`get_scene_info` 一次，三次均返回无法连接 Blender。
2. Blender 正在运行（5.2.1 LTS、`henesys.blend`），但 9876/9987 均没有监听；Blender 用户目录只有配置，未安装 MCP 插件。
3. Codex 的 Blender MCP 配置为 `localhost:9987`。旧项目启动器只在一次性 GUI 进程中加载 `/tmp/maple_story_blender_mcp.py`，该临时文件已不存在，正常启动 Blender 不会加载它。
4. 安装官方包所带插件后，它默认监听 9876，而现有 MCP 进程继承 9987；Blender 插件并不读取 MCP 子进程的 `BLENDER_PORT`。这一中间状态的端口不一致也已验证。

## 修复

- 使用当前正在运行的 MCP 包自带 `install-addon`，将插件持久安装到 `/Users/muniao/Library/Application Support/Blender/5.2/scripts/addons/blender_mcp.py`，无需另下载或升级包。
- 保留 Codex/项目原有 9987 约定，将安装副本的 Scene 端口默认值由 9876 对齐为 9987，启用插件并保存 Blender 用户偏好，使用插件原生自动启动机制。
- 原插件副本备份为同目录 `blender_mcp.py.vendor-backup`；原偏好备份为 `5.2/config/userpref.before-mcp-20260924.blend`。Codex 原配置另有 `~/.codex/config.toml.before-blender-port-20260924.bak`，最终活动端口仍为原来的 9987。
- 保留 `BLENDER_MCP_SAFE_MODE=1`、`DISABLE_TELEMETRY=1`，插件 telemetry consent 为 false。只监听 `127.0.0.1:9987`。
- 未保存或改写场景文件；前后均为 `HN_Henesys`、3694 个对象。

## 验证

- `get_addon_status` 成功：插件 1.7，协议 9，`up_to_date=true`，Blender 5.2.1 LTS。
- `get_scene_info` 成功读取当前场景，3694 个对象。
- `execute_blender_code` 只读检查成功：enabled / auto_start / running 均 true，当前及默认端口均 9987。
- `get_viewport_screenshot` 成功返回射手村三维视图。
- 独立 Blender 后台进程读取已保存偏好，输出 `MCP_PERSISTENCE_CHECK True 9987 True`，正常退出。此验证不重启当前 GUI 或打开其场景文件。

插件安装目录中的默认端口是本机配置补丁；以后若主动重装插件会覆盖它，应继续将插件默认端口与客户端 9987 同步。此次未修改 uv 缓存中的官方源码。
