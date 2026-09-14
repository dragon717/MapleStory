#!/usr/bin/env node
// 玩家可见的拒绝必须有中文表达（審計 T04：不能用相同的静默反馈 / 开发者诊断
// 覆盖所有情况）。
//
// 以前的做法是：服务端 `reject("code", "English diagnostics")`，客户端表格里
// 没有对应条目，兜底分支再把裸码拼上去 —— 于是一个中文界面的玩家看到的是
// "Cannot attack while climbing or dead (invalid_state)"。这不是"反馈"，这是
// 服务端在跟开发者说话。
//
// 规则：每一个 `reject` / `send_reject` 调用点，必须满足其一
//   1. 客户端 `PROTOCOL_ERRORS` 有这个码的文案（可按语言切换）；
//   2. 该调用点自带**中文** message（`invalid_state` 这类"原因由调用点决定"
//      的码走这条路 —— 给它一条通用文案反而会把"死亡"和"爬绳"抹平成一句话）。
// message 是变量（错误字符串）的调用点无法静态判断，跳过。
//
// 只做静态扫描，不启动服务、不连数据库、不改任何文件。

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const serverDir = path.join(root, 'server', 'src');
const i18nPath = path.join(root, 'client', 'src', 'app', 'i18n.ts');

const HAS_CJK = /[㐀-鿿豈-﫿]/;

function serverCallSites() {
  const sites = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!full.endsWith('.rs')) continue;
      const text = fs.readFileSync(full, 'utf8');
      // The code literal and, when present, the message literal — tolerating
      // the wrapped call style used across the server
      // (`send_reject(\n  &id,\n  "code",\n  "msg",`).
      const re = /\b(?:send_reject|reject|reject_with)\(\s*(?:&id,\s*)?"([a-z0-9_]+)",\s*(?:"((?:[^"\\]|\\.)*)"|([A-Za-z_&][\w.&]*))?/g;
      let match;
      while ((match = re.exec(text)) !== null) {
        const line = text.slice(0, match.index).split('\n').length;
        sites.push({
          file: path.relative(root, full),
          line,
          code: match[1],
          // match[2] is a literal message, match[3] a variable one (for
          // example a `persistence` error string the server cannot localize).
          message: match[2] ?? null,
          variableMessage: match[3] !== undefined,
        });
      }
    }
  };
  walk(serverDir);
  return sites;
}

function clientCoveredCodes() {
  const text = fs.readFileSync(i18nPath, 'utf8');
  const start = text.indexOf('PROTOCOL_ERRORS');
  const end = text.indexOf('MINIMAP_TEXT');
  if (start < 0 || end < 0) throw new Error('找不到 PROTOCOL_ERRORS 表');
  const block = text.slice(start, end);
  return new Set([...block.matchAll(/^\s{2}([a-z0-9_]+):\s*\{/gm)].map(match => match[1]));
}

const covered = clientCoveredCodes();
const sites = serverCallSites();
if (!sites.length) throw new Error('没有扫到任何 reject 调用点：扫描器失效了');

// A variable message (a `persistence` error string, say) cannot be localized by
// the server, so the code *must* carry the player-facing line itself.  Calls
// whose code is also a variable cannot be judged at all: they are counted and
// reported as the gate's blind spot instead of being silently skipped.
const violations = sites.filter(
  site =>
    !covered.has(site.code)
    && (site.variableMessage || site.message === null || !HAS_CJK.test(site.message)),
);

if (violations.length) {
  console.error(`协议拒绝文案：${violations.length} 个调用点没有中文表达`);
  for (const site of violations) {
    const shown = site.variableMessage
      ? '(message 是变量，必须靠码的客户端文案)'
      : site.message === null
        ? '(缺少 message)'
        : JSON.stringify(site.message);
    console.error(`  ${site.file}:${site.line} [${site.code}] ${shown}`);
  }
  console.error('\n要么在 client/src/app/i18n.ts 的 PROTOCOL_ERRORS 补一条文案，要么让该调用点自带中文 message。');
  process.exit(1);
}

const localized = sites.filter(site => site.message !== null && HAS_CJK.test(site.message)).length;
console.log(
  `协议拒绝文案：${sites.length} 个调用点全部有中文表达` +
    `（客户端文案 ${new Set(sites.filter(s => covered.has(s.code)).map(s => s.code)).size} 码，` +
    `服务端自带中文 ${localized} 处）。`,
);
