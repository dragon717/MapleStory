import packageJson from './package.json';
import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const buildParts = Object.fromEntries(new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
}).formatToParts(new Date()).map(({ type, value }) => [type, value]));
const buildTime = `${buildParts.year}年${buildParts.month}月${buildParts.day}日 ${buildParts.hour}:${buildParts.minute}:${buildParts.second}`;

export default defineConfig(({ command }) => ({
  define: {
    __RELEASE_VERSION__: JSON.stringify(`v${packageJson.version}`),
    __RELEASE_TIME__: JSON.stringify(buildTime),
    // 页面身份（v3 §8）：源码开发页与构建产物页必须能被看见地区分，
    // 不靠端口号猜。dev（serve）＝DEV_SOURCE；构建＝BUILT_PACKAGE。
    __CODE_MODE__: JSON.stringify(command === 'serve' ? 'DEV_SOURCE' : 'BUILT_PACKAGE'),
  },
  // TMS273 导出是唯一的内容来源，但内容数据（assets，843MB / 约 7 万个美术音频文件）
  // 不是构建产物：它由构建之外的装配管线写进 client/public-tms273，服务端再按
  // ASSETS_DIR 直接从源目录提供（见 server/src/main.rs 的 /assets 路由）。因此只有
  // dev 需要 vite 自己服务它；生产构建不再把它复制进 outDir。
  // 此前每次构建都拷一份，实测占掉「构建打包」这一步 95% 以上的时间（50.6s → 3.4s），
  // 而拷出来的内容与源目录逐字节相同。
  publicDir: command === 'serve' ? 'public-tms273' : false,
  // Phaser's full runtime is bundled locally; retain a 1.6 MB warning budget.
  //
  // 桌面包（v3 §10.2）用**独立暂存区**：由 scripts/build-desktop.cjs 经
  // MAPLE_DESKTOP_DIST 指定（`build/desktop/<target>/<buildId>/frontend`）。
  // 它绝不写正在运行的 `build/current`，也不与配对发布的 `build/tmp` 争用那个
  // 可被清空的目录。未设该变量＝Web 目标，行为与接入前完全一致。
  build: {
    outDir: process.env.MAPLE_DESKTOP_DIST
      ? resolve(process.env.MAPLE_DESKTOP_DIST)
      : resolve(projectRoot, 'build/tmp/client'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1600,
  },
  // 开发固定本机 5173、strictPort：端口被占用就明确失败，不自动换 5174，
  // 也不按端口盲杀（v2 §4.4 / v3 §8）。package.json 的 dev 脚本必须保持
  // 不带 --host，否则 CLI 参数会覆盖这里的本地默认值；局域网模式由调用方显式传参。
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:3010', '/ws': { target: 'ws://127.0.0.1:3010', ws: true } },
  },
}));
