// 通过「向正在运行的服务端逐个请求」来物化 iCloud 占位文件。
//
// 原理：服务端由用户在 Terminal 启动（**非沙箱**），它读取占位文件时会阻塞等 iCloud
// 下载，下载完再返回 200 + 完整字节，此时文件已落地。实测 654B 的文件约 32s。
// 这是沙箱内唯一可用的物化手段（`brctl` 被沙箱拒绝）。
//
// 用法：node scripts/warm_dataless_assets.cjs [并发数]
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..', 'client/public-tms273/assets');
const BASE = { host: '127.0.0.1', port: 3010 };
const CONCURRENCY = Number(process.argv[2] || 16);
const PER_REQUEST_TIMEOUT_MS = 300000;

function collect() {
  const urls = [];
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'objects') continue; // 对象库是新写的本地副本，不需要暖
        walk(full);
        continue;
      }
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.blocks === 0 && stat.size > 0) {
        urls.push('/assets/' + path.relative(ROOT, full).split(path.sep).join('/'));
      }
    }
  })(ROOT);
  return urls;
}

function fetchOnce(url) {
  return new Promise(resolve => {
    const started = Date.now();
    const request = http.get({ ...BASE, path: url }, response => {
      let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; });
      response.on('end', () => resolve({ ok: true, code: response.statusCode, bytes, ms: Date.now() - started }));
    });
    request.setTimeout(PER_REQUEST_TIMEOUT_MS, () => request.destroy(new Error('timeout')));
    request.on('error', error => resolve({ ok: false, error: error.message, ms: Date.now() - started }));
  });
}

(async () => {
  const pending = collect();
  console.log(`待物化 ${pending.length} 个文件，并发 ${CONCURRENCY}，单请求上限 ${PER_REQUEST_TIMEOUT_MS / 1000}s`);
  let done = 0;
  let failed = 0;
  let slowest = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < pending.length) {
      const url = pending[cursor++];
      const result = await fetchOnce(url);
      done += 1;
      if (result.ok) {
        slowest = Math.max(slowest, result.ms);
        console.log(`[${done}/${pending.length}] ok ${result.ms}ms ${result.bytes}B ${url.split('/').pop()}`);
      } else {
        failed += 1;
        console.log(`[${done}/${pending.length}] FAIL ${result.error} ${url.split('/').pop()}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));

  const remaining = collect().length;
  console.log('');
  console.log(`完成：成功 ${done - failed} / 失败 ${failed}；最慢单请求 ${slowest}ms`);
  console.log(`剩余未物化：${remaining} 个`);
})();
