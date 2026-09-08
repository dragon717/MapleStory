# [QA][P1] 右下动作按钮组未按可变数量自适应排布

构建/服务/浏览器/视口：3010 `gms83-gameplay-2`；Playwright Chromium/Chrome；1440×900、1280×720、390×844；另附用户提供的红框截图（来源环境未确认）。

现状证据：

- [用户红框截图](./user-right-buttons-redbox.png)：SHOP 与 TRADE 间距异常大，MENU/SHORTCUT 挤在右端。
- [3010 当前宽屏截图](./desktop-wide.png)：同样显示 `SHOP → TRADE → MENU → SHORTCUT`，中间留下约一个按钮宽度的空洞。
- [3010 浏览器数据](./browser.json)：当前 HUD 的实际按钮列表为 `BtShop, BtNPT, BtMenu, BtShort`；manifest 虽有 `base/chat` 和 `BtWhisper/*`，但没有渲染聊天按钮。
- 量测（后续回归数据 `evidence/qa/2026-09-05T08-44-27-955Z/browser.json`）：1440/1280 宽屏相邻边界间距为 `[36, -9, -9]` px；390px 竖屏实际只显示 `BtMenu, BtShort`，`BtShop`/`BtNPT` 被隐藏，按钮行是 `[2,2]`，聊天仍为 0。
- 当前实现依据：`client/src/features/hud/view.ts` 的 `BUTTONS` 使用固定 x 坐标，`client/src/app/style.css` 窄屏规则还固定隐藏 `BtShop`/`BtNPT`；这不能覆盖未来 4 个一排、8 个一排或两排配置。

预期：按钮由列表/测试配置驱动，保持原版视觉比例和源顺序；可用宽度不足时自动换行，4/8 个配置均无空洞、遮挡或横向溢出；窄屏始终保留 HP、设置和聊天入口，runtime resize 后重新布局；按钮真实边界可访问。

回归要求：开发提供 4/8/两排测试配置后，分别记录 DOM 顺序、行数、相邻间距、与 HP/MP/EXP 及聊天区域的重叠测量，并保存宽屏/横屏/390px 竖屏及 runtime resize 前后截图。

状态：OPEN；等待前端列表驱动布局后回归。
