#!/usr/bin/env node

// 门禁：Web 客户端交付边界（v3 §4 版本契约 / §5 HTTP 缓存 / §6 强制更新 / §10 下载）。
//
// 钉住的是「这份仓库到底有没有把资源交付这件事收口」：
//
//   1. **发布描述端点真的挂上了**：`/api/client-release` 存在、响应 `no-store`、
//      字段与客户端 `ClientRelease` 一致；
//   2. **缓存分类不许撒谎**：只有带内容指纹 / 内容寻址对象才允许长期 immutable；
//      过渡期固定名内容资源一律 `no-cache`；私人 API 一律 `no-store`；WS 不分类；
//   3. **逻辑 key 与下载地址分开**：Phaser loader / DOM / CSS / JSON 各处消费者
//      走 `resolveAssetUrl`，且**普通请求不带时间戳**（代数只随明确修复变化）；
//   4. **资源消费者覆盖如实登记**：已接入的文件逐个钉住；还没接入的 DOM `<img>`
//      站点必须列在 `UNCOVERED` 名单里并写明理由，名单过期（站点消失或新增文件）
//      都要失败；
//   5. **更新流程不越界**：不清存储、不用 `location.reload(true)`、不放宽
//      协议/内容校验、不依赖地图资源；
//   6. **下载入口不给假链接**：未发布就是空列表，地址只接受 http(s)；
//   7. **端点收敛**：登录/lobby/WS 三个入口走 `endpoints.ts`，不再各自拼主机。
//
// 本脚本只读源码，不启停服务、不访问网络、不碰数据库。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CLIENT_SRC = path.join(ROOT, 'client/src');
const SERVER_SRC = path.join(ROOT, 'server/src');
const read = file => fs.readFileSync(file, 'utf8');

function* walk(dir, filter) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, filter);
    else if (filter(entry.name)) yield full;
  }
}
const rel = file => path.relative(ROOT, file).split(path.sep).join('/');
/** 去掉行注释与块注释，避免「注释里提到某个 API」被当成调用。 */
function codeOnly(source) {
  return source.split('\n').filter(line => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n');
}
const group = label => console.log(`  ✔ ${label}`);

// ── 1. 发布描述端点 ────────────────────────────────────────────────────────
const mainSource = read(path.join(SERVER_SRC, 'main.rs'));
assert.ok(mainSource.includes('mod client_delivery;'), 'main.rs 必须声明 client_delivery 模块');
assert.ok(/\/api\/client-release/.test(mainSource), '必须挂载 /api/client-release 路由');
assert.ok(
  /from_fn\(client_delivery::apply_cache_headers\)/.test(mainSource),
  '必须把缓存分类中间件挂进路由（否则 §5 的缓存策略不会出现在响应上）',
);
const delivery = read(path.join(SERVER_SRC, 'client_delivery.rs'));
for (const field of ['releaseId', 'protocolVersion', 'contentVersion', 'assetRevision', 'desktop']) {
  assert.ok(delivery.includes(`"${field}"`), `发布描述必须包含 ${field}`);
}
assert.ok(/"no-store"/.test(delivery), '发布描述响应必须 no-store');
group('发布描述端点 /api/client-release 已挂载且 no-store');

// ── 2. 缓存分类：只有真不可变才 immutable ──────────────────────────────────
assert.ok(/const IMMUTABLE: &str = "public, max-age=31536000, immutable"/.test(delivery));
assert.ok(/const REVALIDATE: &str = "no-cache"/.test(delivery));
assert.ok(/const NO_STORE: &str = "no-store"/.test(delivery));
// 分类函数必须逐类都有测试，否则「改一行分类」不会被任何检查发现。
const deliveryTests = delivery.slice(delivery.indexOf('#[cfg(test)]'));
for (const name of [
  'classifies_entry_pages_as_revalidate',
  'classifies_fingerprinted_build_assets_as_immutable',
  'classifies_content_addressed_objects_as_immutable',
  'never_locks_mutable_fixed_name_content',
  'classifies_private_api_and_realtime_channels',
  'header_values_are_well_formed',
  'release_descriptor_reports_expected_contract',
  'release_descriptor_falls_back_without_metadata',
]) {
  assert.ok(deliveryTests.includes(`fn ${name}(`), `client_delivery 必须包含验收 ${name}`);
}
group('缓存分类四类常量与 8 组验收在位');

// ── 3. 逻辑 key 与下载地址分开；普通请求不带时间戳 ─────────────────────────
const resourceUrl = read(path.join(CLIENT_SRC, 'assets/resource-url.ts'));
assert.ok(/export function resolveAssetUrl\(url: string\): string/.test(resourceUrl));
assert.ok(/return url;/.test(resourceUrl), '代数为 0 时解析必须是恒等函数（普通请求逐字节不变）');
for (const banned of ['Date.now', 'performance.now', 'Math.random']) {
  assert.ok(!codeOnly(resourceUrl).includes(banned), `resource-url 不得使用 ${banned} 给正常请求加时间戳`);
}
assert.ok(/EPOCH_URL_PARAM/.test(resourceUrl), '修复代数必须能在偏好存储不可用时由 URL 携带');
group('逻辑 key 与下载地址分离，普通请求不加时间戳');

// ── 4. 已接入消费者 / 未接入登记 ───────────────────────────────────────────
const RESOLVER_CONSUMERS = [
  'assets/manifest.ts',        // 主清单 + 外观目录（JSON）
  'scenes/world.ts',           // Phaser 图片 / 音频 / windbell 音效
  'features/windbell/scene.ts',// 风铃 JSON / 图片 / 动态入队
  'features/entry/view.ts',    // 登录素材 + DOM 背景与纸娃娃 <img>
  'features/entry/appearance.ts',// 外观懒加载（JSON）
  'features/cashshop/view.ts', // 现金目录（JSON）
  'features/notebook/directory.ts',// 图鉴目录（JSON）
  'features/npc/dialogue.ts',  // gameplay/items（JSON）
  'features/world/storage-view.ts',// 仓库物品目录（JSON）
  'features/loading/view.ts',  // CSS background-image 底板
  'features/windbell/activities.ts',// DOM <img>
];
for (const file of RESOLVER_CONSUMERS) {
  const source = read(path.join(CLIENT_SRC, file));
  assert.ok(source.includes('resolveAssetUrl'), `${file} 必须经 resource-url 取资源`);
}
group(`${RESOLVER_CONSUMERS.length} 个真实消费者已接入 resolver`);

// 未接入登记：这些文件直接把 frame.url 赋给 DOM <img>，只享受 HTTP 缓存、
// 不参与「重新下载所需资源」的修复代数。名单必须**逐条**仍然成立，
// 站点消失或出现新文件都要失败（v3 §6.4：不许漏掉后仍宣布覆盖全部资源）。
const UNCOVERED = Object.freeze({
  'features/hud/view.ts': 'HUD 图标走 frame.url，未迁移',
  'features/hud/buff-bar.ts': '增益图标走 frame.url，未迁移',
  'features/skills/view.ts': '技能图标走 frame.url，未迁移',
  'features/inventory/view.ts': '背包底板与图标走 frame.url，未迁移',
  'features/chat/view.ts': '聊天框底板走 frame.url，未迁移',
  'features/chat/emoticon-view.ts': '表情贴纸走 frame.url，未迁移',
  'features/notebook/view.ts': '图鉴底板走 frame.url，未迁移',
  'features/notebook/item-section.ts': '图鉴条目图标走 frame.url，未迁移',
  'features/notebook/monster-section.ts': '怪物页图标走 frame.url，未迁移',
  'features/menu/view.ts': '菜单按钮图像走 frame.url，未迁移',
  'features/ui/window-shell.ts': '窗口底板走 frame.url，未迁移',
  'features/world/minimap-view.ts': '小地图切片走 frame.url，未迁移',
  'features/world/worldmap-view.ts': '世界地图底图走 frame.url，未迁移',
  'features/world/party-view.ts': '组队窗底板走 frame.url，未迁移',
  'features/world/friend-view.ts': '好友窗底板走 frame.url，未迁移',
  'features/character/view.ts': '角色窗图标走 frame.url，未迁移',
  'features/notice/death.ts': '死亡提示图标走 frame.url，未迁移',
  'features/keybindings/view.ts': '键位标签图像走 frame.url，未迁移',
  'features/pet/panel.ts': '宠物面板图像走 frame.url，未迁移',
  'features/npc/dialogue.ts': 'NPC 头像走 frame.url（目录 JSON 已接入，图像未接入）',
  'features/world/storage-view.ts': '仓库物品图标走 frame.url（目录 JSON 已接入，图像未接入）',
  'features/cashshop/view.ts': '现金商品图标走 asset.url（目录 JSON 已接入，图像未接入）',
});
// 未接入＝给 `<img>.src` 赋了资源地址、却**没有**经过 resolver 的那些行。
const BARE_SRC_LINES = file => read(file).split('\n')
  .map((line, index) => ({ line, number: index + 1 }))
  .filter(({ line }) => /\.src\s*=\s*[^;]*[Uu]rl\b/.test(line) && !line.includes('resolveAssetUrl'));
const offenders = [];
for (const file of walk(CLIENT_SRC, name => name.endsWith('.ts') && !name.includes('.check.'))) {
  const key = path.relative(CLIENT_SRC, file).split(path.sep).join('/');
  if (/ 2\.ts$/.test(key)) continue; // tsconfig 排除的冲突副本，不参与
  if (BARE_SRC_LINES(file).length === 0) continue;
  if (!(key in UNCOVERED)) offenders.push(key);
}
assert.deepEqual(offenders, [], `这些文件新增了未接入 resolver 的 DOM 图像赋值，必须迁移或登记：\n${offenders.join('\n')}`);
for (const key of Object.keys(UNCOVERED)) {
  const file = path.join(CLIENT_SRC, key);
  assert.ok(fs.existsSync(file), `登记未接入的文件不存在：${key}`);
  assert.ok(BARE_SRC_LINES(file).length > 0, `登记「未接入」的 ${key} 已不再有裸资源地址赋值，请把名单删掉`);
}
group(`${Object.keys(UNCOVERED).length} 个 DOM 图像站点登记为未接入（修复代数不覆盖，HTTP 缓存仍生效）`);

// ── 5. 更新流程不越界 ──────────────────────────────────────────────────────
const updateService = codeOnly(read(path.join(CLIENT_SRC, 'features/client-actions/update-service.ts')));
for (const banned of ['localStorage.clear', 'removeItem', 'indexedDB', 'Clear-Site-Data', 'location.reload', 'caches.delete']) {
  assert.ok(!updateService.includes(banned), `更新流程不得出现 ${banned}（v3 §6.5）`);
}
assert.ok(/PROTOCOL_VERSION/.test(updateService) && /CONTENT_VERSION/.test(updateService), '必须校验协议与内容版本');
assert.ok(/if \(this\.inFlight\) return this\.inFlight;/.test(updateService), '重复点击必须合并为单个在途任务（U01）');
const runtimeConfig = read(path.join(CLIENT_SRC, 'platform/runtime-config.ts'));
assert.ok(/\/api\/client-release/.test(runtimeConfig), '发布描述必须来自统一端点');
assert.ok(/no-store/.test(runtimeConfig), '强制更新检查必须绕过缓存副本');
group('强制更新：合并点击、校验版本、不清存储、不强制 reload');

// ── 6. 下载入口不给假链接 ──────────────────────────────────────────────────
const downloads = read(path.join(CLIENT_SRC, 'features/client-actions/desktop-downloads.ts'));
assert.ok(/parsed\.protocol === 'https:' \|\| parsed\.protocol === 'http:'/.test(downloads), '下载地址只接受 http(s)');
assert.ok(/normalizeDesktopReleases/.test(read(path.join(CLIENT_SRC, 'features/client-actions/view.ts'))), '面板必须走校验后的列表');
const viewSource = read(path.join(CLIENT_SRC, 'features/client-actions/view.ts'));
assert.ok(!/from '\.\.\/assets\/manifest'|from '\.\.\/\.\.\/assets\/manifest'|phaser/.test(viewSource), '首页操作区不得依赖 manifest / Phaser（资源坏掉时必须仍可用）');
assert.ok(/aria-live="polite"/.test(viewSource), '状态区必须 aria-live');
assert.ok(/<button type="button"/.test(viewSource), '必须是真 <button>，支持 Tab/Enter');
group('下载面板：只列真实已发布包，操作区不依赖地图资源');

// ── 7. 端点收敛 ────────────────────────────────────────────────────────────
const endpoints = read(path.join(CLIENT_SRC, 'network/endpoints.ts'));
assert.ok(/export function apiUrl\(/.test(endpoints) && /export function wsUrl\(/.test(endpoints));
for (const [file, pattern] of [
  ['network/auth-api.ts', /apiUrl\(/],
  ['features/entry/api.ts', /apiUrl\(/],
  ['network/session.ts', /wsUrl\(/],
]) {
  assert.ok(pattern.test(read(path.join(CLIENT_SRC, file))), `${file} 必须走 endpoints`);
}
const sessionSource = read(path.join(CLIENT_SRC, 'network/session.ts'));
assert.ok(!/new WebSocket\(`\$\{location/.test(sessionSource), 'WS 不再由 session 自己拼主机');
group('登录 / lobby / WS 三个入口已收敛到 endpoints.ts');

// ── 8. 页面身份：源码开发页与构建页可区分 ───────────────────────────────────
const viteConfig = read(path.join(ROOT, 'client/vite.config.ts'));
assert.ok(/__CODE_MODE__/.test(viteConfig), 'vite 必须注入 __CODE_MODE__');
assert.ok(/strictPort: true/.test(viteConfig) && /port: 5173/.test(viteConfig), '开发必须固定 5173 且不换端口');
const packageJson = JSON.parse(read(path.join(ROOT, 'client/package.json')));
assert.equal(packageJson.scripts.dev, 'vite', 'dev 脚本不得带 --host 覆盖本地默认');
assert.ok(/__CODE_MODE__/.test(read(path.join(CLIENT_SRC, 'app/page-shell.ts'))), '页面必须显示代码模式');
group('页面身份（DEV_SOURCE / BUILT_PACKAGE）与固定开发端口在位');

console.log('\ncheck_tms273_client_actions: 8 组断言全部通过');
