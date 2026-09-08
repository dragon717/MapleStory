import packageJson from './package.json';
import { defineConfig } from 'vite';

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

export default defineConfig({
  define: {
    __RELEASE_VERSION__: JSON.stringify(`v${packageJson.version}`),
    __RELEASE_TIME__: JSON.stringify(buildTime),
  },
  // TMS273 exports are the only active content source.
  publicDir: 'public-tms273',
  // Phaser's full runtime is bundled locally; retain a 1.6 MB warning budget.
  build: { outDir: 'dist-tms273', emptyOutDir: true, chunkSizeWarningLimit: 1600 },
  server: { host: '0.0.0.0', proxy: { '/api': 'http://127.0.0.1:3010', '/ws': { target: 'ws://127.0.0.1:3010', ws: true } } },
});
