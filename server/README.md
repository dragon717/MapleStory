# Rust 单地图服务

日常运行请双击项目根目录的 `启动3010.command` / `关闭3010.command`；它们只管理新版 `127.0.0.1:3010` 和一个陪测 bot。脚本复用已构建二进制、`client/dist-next` 与 `qa-gameplay-round2.sqlite3`，不重复编译。旧版 3000 仅作历史说明，不由脚本管理。

手动启动时，服务读取 `BIND_ADDR`、`MAP_FILE`、`ACCOUNT_DB`、`CLIENT_DIST`、`ASSETS_DIR`、`GAMEPLAY_FILE`；当前新版配置见 `evidence/runtime/gameplay-round2.json` 与 `map-round2.json`。缺少地图或玩法配置会直接报错。

配置环境变量：`BIND_ADDR`、`MAP_FILE`、`ACCOUNT_DB`、`CLIENT_DIST`、`ASSETS_DIR`、`ATTACK_DURATION_MS`（默认800，50–5000ms）。路径默认基于编译时项目位置。账号数据库默认 `server/data/accounts.sqlite3`；Argon2id盐化hash，SQLite持久化。用户名3–32 ASCII字母数字下划线/短横线，密码8–128 UTF-8字节。注册后登录，每账号一个24小时随机token；新登录替换该账号token，已有在线连接保留，重复角色连接拒绝新连接。重启需重新登录。

`POST /api/register`、`POST /api/login` 使用 `{username,password}`。WS `/ws` 首包 `hello`，token不进入URL或日志。协议见 `shared/protocol.ts`。`GET /api/health`。

主世界任务唯一拥有玩家状态，每50ms读取当时队列长度，按FIFO处理这些命令，随后按玩家ID固定顺序模拟，再广播；有界队列只控制积压，不意味着所有异步到达顺序跨运行完全一致。网络任务只投递命令，认证worker独立串行处理SQLite及hash，不占世界tick。没有每实体task、世界锁或并行模拟。

新版使用源foothold链的水平/斜坡移动、墙/边缘约束、ladder/rope、Down+Space下跳，以及少量Snail的普攻/接触伤害、贡献EXP、掉落拾取、背包和死亡复活；没有PVP、完整技能、任务、商城或真实聊天业务。普攻800ms来自真实swingO1帧300+150+350ms。

重复攻击以账号ID+操作+requestId绑定，进程生命周期保存成功动作，重发仅回原事件。100000动作后显式拒绝新动作，重启清除；不是跨崩溃exactly-once。连接断开despawn，重新入图从出生点；500ms未输入停止移动，30秒无业务包断开。慢连接输出队列满后despawn并断开。包体2048字节、每秒60条、世界队列1024、每连接输出32、认证队列32/并发4（至少500ms请求间隔）、连接上限256。登录注册默认明文HTTP适合受信LAN；公开部署需TLS和更完整防暴力破解策略。

验证：`~/.cargo/bin/cargo test --manifest-path server/Cargo.toml`，包含真实模拟落地/斜坡/跳跃、跨连接身份无效、重复动作与断线，以及非法字段拒绝。网络双机器人验收由根目录脚本实施，不与单元测试混称。

实现模块：`main`仅启动装配；`network`校验并投递；`auth`串行持有账号数据库/会话；`world`独占玩家状态与移动模拟；`combat`拥有攻击实例/去重历史，仅由world调用。`/assets`优先提供dist/assets构建产物，再回退public/assets原始导出；缺失资源返回404。

库API依据：[axum WebSocket](https://docs.rs/axum/latest/axum/extract/ws/)、[Argon2](https://docs.rs/argon2/latest/argon2/)、[rusqlite](https://docs.rs/rusqlite/latest/rusqlite/struct.Connection.html)。
