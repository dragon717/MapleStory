# 现金商店与纸娃娃定向验证

仅使用离线静态资源与模拟回执，未访问在线账号或游戏服务。

- `cash-data-check.json`：1100 商品/1002 图标、别名、PNG可见像素、扩展券定义、12只现金宠物。
- `cash-server-tests.log`：8 个现金服务端测试通过，包含真实武器槽位和宠物存档恢复。
- `cash-shop-ui-check.json`：分类、搜索、ID别名、源底图与缺图清理检查。
- `browser-check.json`、PNG：四种尺寸、余额无遮挡、首次试穿、购物车失败/成功回执、损坏图片移除；真实 Phaser 首次实装及施法无缺失纹理。
- `runtime-check.log`：71 张地图资源装配检查通过。
- `build-release.log`、`final-client-build.log`：配套候选构建及最终小屏收尾后的客户端重建通过。协议19 / 内容 tms273-18。

`browser-check.cjs` 保存本次开发者浏览器检查，可在仓库根目录用已安装 Playwright 运行（`PLAYWRIGHT_MODULE` 指向模块；使用当前机器已有 Chromium 1228）。不启动游戏服务、不安装依赖。最终账号实玩见 PLAN.md 待验项。
