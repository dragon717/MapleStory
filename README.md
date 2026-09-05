# MapleStory Web MVP

GMS83蘑菇村，TypeScript/Phaser前端、Rust单机权威服务。3010玩法版包含foothold墙/边缘、梯绳与下跳、Snail、普攻/接触伤害、经验、掉落拾取和响应式原素材HUD；没有PVP、完整技能、任务、商城或真实聊天业务。

## 新版 3010 一键启动（推荐）

直接双击项目根目录的 [启动3010.command](./启动3010.command) 启动新版服务和唯一陪测 bot；双击 [关闭3010.command](./关闭3010.command) 停止它们。两个脚本只管理 `127.0.0.1:3010`，不会操作旧版 3000；启动会复用已构建二进制和 `client/dist-next`，不会每次重新编译，检测到已运行实例也不会重复启动。

脚本把 PID、日志和 bot 凭据保存在 `evidence/runtime/3010-control/`（凭据文件权限为 600，不打印密码），数据库仍为 `server/data/qa-gameplay-round2.sqlite3`。首次缺少二进制时，启动脚本会提示构建命令；端口被其他程序占用时会停止并提示，不会误杀。

## 运行资源归档

根目录的 `MapleStory-运行资源-2026-09-05.tar.gz` 是已导出的可运行资源包（723452060 bytes，10837个归档条目，SHA-256 `bfdcfc7e306ffaeac8a43b71a93558e358c372a7559acd8b434d9d5a0ae05383`），包含完整的 `resources/gms83-export`（8005个文件：音频、图像和动画样本）以及当前浏览器/玩法运行时目录：`client/public`、`client/public-gameplay`、`references/browser-probe/assets`、`references/gameplay-assets/assets`、`references/gameplay-assets/avatar/assets`。归档不含 `参考/` 下的原始WZ、原始压缩包、第三方仓库和工具，也不含数据库、凭据、依赖或编译产物。

在任意环境先进入仓库根目录，再用 UTF-8 路径解压；不要在仓库外解压后再套一层同名目录：

```sh
cd "/path/to/MapleStory"
tar -xzf "MapleStory-运行资源-2026-09-05.tar.gz"
```

解压后可直接运行 `启动3010.command`；需要重新生成浏览器资源时再执行 `python3 scripts/integrate_assets.py`，玩法资源用 `python3 scripts/integrate_gameplay.py`。这些脚本只读取 `参考/` 中保留的原始资料或 `resources/gms83-export` 中的处理结果。

## 旧版 3000（历史入口）

在本项目根目录使用Node 22与Rust stable。依赖和首版资源当前已备好；从源导出再次集成用 `python3 scripts/integrate_assets.py`。

```sh
npm run build --prefix client
~/.cargo/bin/cargo run --manifest-path server/Cargo.toml
```

另开终端，在根目录启动自动机器人：

```sh
node bots/run.mjs demo
```

同机打开 [登录页](http://127.0.0.1:3000)，同一局域网设备打开 [主机地址](http://192.168.1.19:3000)。IP改变时改用新的主机IP。点击注册，用自己的账号进入地图；默认用户名3–32 ASCII字母/数字/下划线/短横线，密码8–128 UTF-8字节。

左右方向键或A/D移动，空格跳跃，X或Ctrl普攻。页面提供静音和退出。机器人使用独立账号自动往返、跳跃与攻击，不依赖AI发指令。服务和机器人各自在运行它的终端按Ctrl+C停止，重启机器人会创建新的演示账号。

账号存在 `server/data/accounts.sqlite3`，密码经Argon2id盐化hash；token仅内存、24小时有效。断线角色移除，重入从出生点开始；同角色重复连接拒绝新连接。默认监听 `0.0.0.0:3000`。其他配置和已知物理边界见 `server/README.md`。

## 开发验证

服务运行时：

```sh
~/.cargo/bin/cargo test --manifest-path server/Cargo.toml
npm run check --prefix client
node bots/run.mjs selftest
```

网络自测通过后写入 `evidence/bot-selftest.json`，不写密码或token。`SERVER_URL=http://主机IP:3000 node bots/run.mjs selftest` 可指向其它主机。阶段A开发自测与阶段B用户登录验收分开记录；目前用户验收仍待执行。

后续业务按 `BUSINESS_DEVELOPMENT.md` 操作。资源来源、解码证据和覆盖限制见 `references/evidence/gms83-verification.md`；素材取自现有GMS83包，不能把参考代码许可证当作美术再分发授权。

执行入口：先读 BUSINESS_DEVELOPMENT.md（长期规范）和 PLAN.md（唯一当前计划）；仅相关追溯时读 IMPLEMENTATION_STATUS.md（已完成历史）。完成结果从计划移入历史，不创建重复台账。
