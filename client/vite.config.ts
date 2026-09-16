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
  },
  // TMS273 导出是唯一的内容来源，但内容数据（assets，843MB / 约 7 万个美术音频文件）
  // 不是构建产物：它由构建之外的装配管线写进 client/public-tms273，服务端再按
  // ASSETS_DIR 直接从源目录提供（见 server/src/main.rs 的 /assets 路由）。因此只有
  // dev 需要 vite 自己服务它；生产构建不再把它复制进 outDir。
  // 此前每次构建都拷一份，实测占掉「构建打包」这一步 95% 以上的时间（50.6s → 3.4s），
  // 而拷出来的内容与源目录逐字节相同。
  publicDir: command === 'serve' ? 'public-tms273' : false,
  // Phaser's full runtime is bundled locally; retain a 1.6 MB warning budget.
  build: { outDir: resolve(projectRoot, 'build/tmp/client'), emptyOutDir: true, chunkSizeWarningLimit: 1600 },
  server: { host: '0.0.0.0', proxy: { '/api': 'http://127.0.0.1:3010', '/ws': { target: 'ws://127.0.0.1:3010', ws: true } } },
}));
