# Codex 射手村皮肤

用户范围：不动项目业务代码，只实现射手村主题 Codex 皮肤。参考用户 Downloads 研究方案，但以当前射手村要求覆盖文中登录背景建议。

交付目录：`/Users/muniao/Downloads/MapleStory-Henesys-Codex-Skin/`，成品 `MapleStory-Henesys-Codex-Skin.zip`。制作脚本、来源清单、背景候选与导入恢复说明均在独立目录，不依赖游戏进程。

主代理负责地图素材渲染、主题包与整合；GPT-5.6 Luna / max（skin_contract）负责锁定上游契约与兼容核查。Dream Skin v1.5.18，commit `34335d27d54300eccb325cc652f6c93fef428b84`。

素材为本地 TMS273.7 地图 100000000「弓箭手村 / 射手村」，使用地图西侧蘑菇屋，视口 1920×1080、camera=(650,-580)，按现有 world.ts 图层坐标/背景视差契约静态首帧渲染。原图无 AI 重绘、无角色账号内容、无 UI 假按钮。使用的145张原图保留来源与SHA-256，制作后核对一致。

主题使用浅色奶油面板、深棕文字、橙棕边框及草绿强调。Safe CSS 8规则/26声明通过；上游 package validator 返回 official / safeCssStatus=validated（macOS/client 1.5.18）。ZIP五个根目录文件，CRC/负载哈希通过。正文/次要文字对不透明奶油面板对比度13.11:1/5.65:1。打包脚本保留可运行负载检查，渲染脚本保留路径穿越拒绝与尺寸检查。

背景图片已直接核看。本地 HTML 样式示意被浏览器安全策略拒绝打开，未绕过；浏览器和宿主应用效果未验。当前宿主为 ChatGPT.app 26.908.40834 (8881) 内嵌 Codex Framework，未安装Dream Skin、未重启宿主。用户后续按README导入、应用并检查恢复；格式通过不代表实机通过。

仅修改任务文档；用户既有业务改动、服务、账号数据库和机器人均未触碰。未跑游戏构建或独立QA。

## 用户授权安装后的进展

已校验官方v1.5.18 DMG SHA-256并安装 `/Applications/Codex Dream Skin.app`；通过App内导入器导入 `maplestory-henesys`，返回 imported / official / safeCssStatus=validated。引擎安装器即使 --no-launch 也要求当前Codex退出，防止配置同时写入。尚未部署引擎、开启CDP或重启；等待用户确认最后启用动作。安装包和状态记录保留在独立交付目录。
