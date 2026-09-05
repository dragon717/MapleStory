import { defineConfig } from 'vite';
export default defineConfig({
  // Keep the gameplay resource set and its output isolated from the already
  // served MVP at client/dist. Root's 3010 process serves dist-next.
  publicDir: 'public-gameplay',
  build: { outDir: 'dist-next' },
  server: { host: '0.0.0.0', proxy: { '/api': 'http://127.0.0.1:3010', '/ws': { target: 'ws://127.0.0.1:3010', ws: true } } },
});
