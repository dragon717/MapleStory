# 前端开发验收记录

2026-09-05；浏览器：Codex In-app Browser，1280×720；主入口：http://localhost:3000/。
内容版本：gms83-mvp-1。执行账号：qa_frontend；同图程序化账号：demo_bot_mto1lpaf。

已执行：
- 通过真实表单注册并登录；生产入口再次登录、退出、重新登录。
- 同图显示两个独立账号，姓名与源地图可见，角色脚点落在真实草地。
- CUA 键盘事件发送方向键、X 普攻、Space 跳跃；跳跃截图确实离地。CUA 的快速按放不能替代持续按住移动的量化测试；网络机器人移动证据由主验收记录保存。
- 源 frame delay 边界及攻击非循环播放检查通过；重复/过时 actionStarted 消费检查通过。
- 音频依赖加入后重新构建、重入，加载完成且浏览器无 error/warn；点击画面解锁后发送 X。未进行主观听音验收。
- npm run build、npm run check 通过。构建含 Phaser 的单 JS 包约 1.22 MB，gzip 338 kB；保留 Vite 大包提示。

最终截图：final-world.png、final-jump-attack.png、login.png。过程截图：world-two-accounts.png、attack-left.png、attack-right.png、jump.png。
左右普攻截图按输入事件命名；不据此宣称完整逐帧原版一致性。

明确限制：
- 当前单图角色统一在地图静态层上方，不宣称通用前景遮挡。
- 背景 type3 双向平铺、type4 横向平铺；暂为静态，不含滚动与视差。
- 最终资源刷新后黑帽和脸部可见，final-world.png / final-jump-attack.png记录最终状态；旧attack-left/right/jump截图为修正前过程证据，不作为最终帽发依据。
- 浏览器端断线按钮代码已实现；断线/重连网络验收由程序化客户端完成，本轮未通过浏览器断网工具实测。
- 本记录为开发自测，不能代替用户本人在局域网设备上的验收。

最终 npm run build / npm run check 再次通过；生产包 index-rtGJbUDD.js。最终浏览器 error/warn = 0。qa_frontend 已点退出，临时 Vite 5173 已停止；保留 Rust 3000 和程序化 demo bot。
