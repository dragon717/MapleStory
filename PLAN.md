# 当前工作计划

更新：2026-09-05。长期规范见 BUSINESS_DEVELOPMENT.md，完成记录见 IMPLEMENTATION_STATUS.md；本文件仅保存实际剩余。

## 实际剩余与负责人

| 剩余项 | 负责人/依赖 | 完成条件 |
| --- | --- | --- |
| 后端新版协调部署 | /root，Astra high；已按用户授权完成 | 已启动最新 binary；数据库保留，用户需重新登录，唯一新版陪测bot已连接 |
| 最新前端与后端用户验收 | 用户；反馈由root分给所属前后端代理 | 响应式按钮默认4个/8个/4列两排/8列宽屏、聊天入口、死亡复活视觉、梯绳、Down+Space、台阶边缘、贡献EXP与怪物AI；未实测不标通过 |

/root/fix_background（Luna max，client/）与 /root/gameplay_backend（Luna max，server/）本轮开发和本次复活缺陷修复均已完成；无剩余开发项，仅用户反馈触发后续修改。菜单弹层不是本轮必需项或交付阻塞，不再扩展。

## 当前运行环境

- 新版用户入口：http://127.0.0.1:3010/，最新服务PID57199（由一键启动脚本托管），数据库 server/data/qa-gameplay-round2.sqlite3。用户账号与存档保留；用户需重新登录。
- 3010 已运行最新后端 binary，启动固定配置为 evidence/runtime/gameplay-round2.json、map-round2.json；贡献EXP、梯绳/下跳、复活幂等与怪物AI补丁已部署。
- 3010静态前端已更新到 client/dist-next，资源来自 client/public-gameplay；当前入口JS index-DPxYgAqH.js，CSS index-LTTRGTn1.css。复活缺陷修复已部署，用户刷新页面并重新登录即可加载。
- 旧3000服务及其陪测bot已停止，旧版 `client/dist` 与数据库均保留，禁止被v2覆盖。
- 服务认证session仅在内存，升级已使原用户 token 失效；请重新登录。唯一新版陪测 bot（PID57209）已完成真实认证连接，凭据由脚本保存在 `evidence/runtime/3010-control/bot-credentials.json`（600权限）。旧3000服务及其 bot 已停止，旧数据库 `server/data/accounts.sqlite3` 保留。

## 验收与交接边界

用户已取消独立QA；不创建3011，不重复已有测试，不运行额外网络探针打扰在线用户。只对实际改动做必要编译/小检查，然后交用户亲测；没有独立QA不构成交付阻塞，不削减已要求功能。复活缺陷已修复并随本次升级部署；等待用户刷新、重新登录后亲测。

一键入口：`启动3010.command`、`关闭3010.command`。两者只管理3010及其陪测bot，启动幂等并检查端口归属，停止校验PID/工作目录后优雅退出；日志/PID/凭据在 `evidence/runtime/3010-control/`，不提交Git。

原版来源与差异在 shared/gameplay.json：使用GMS83 WZ原素材/数值，但Cosmic修改服与社区公式不冒称官方精确一致。用户描述的具体左右台阶尚未唯一定位，保持源foothold链语义，不全平台封边。

来源任务01a07076-fe4c-7472-9582-a2f8d9ae4ce0接收最终代码/构建结果及部署待协调事项。完成项移入历史，不另建治理台账。
