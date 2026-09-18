// 首页右下角「客户端操作区」的排版探针（v3 §6.1）。
//
// 为什么需要它：这块面板的高度/宽度由**内容**决定，而版本号与资源修订都是没有断点的
// 长串。2026-09-18 实拍到的故障是——修订号（64 位十六进制）把 `max-width` 顶穿、
// 文字溢出到圆角框外，同时中文标签被挤成「当前发 / 布：」。这类问题的共同点是
// **布局检查全绿但界面不对**，所以判据必须是几何量本身：
//   ① 面板内每个后代元素的右/左边界都必须落在面板的内容盒里（含容差）；
//   ② 中文标签不得在自己内部换行（标签应整体换行，而不是被拆成两截）；
//   ③ 修订号必须能读出完整值（`title`），不能因为缩短显示就丢掉。
//
// 运行：node qa/client-actions-fit-probe.mjs
import { chromium } from '/Users/muniao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';

const base = new URL(process.env.SERVER_URL || 'http://127.0.0.1:3010');
if (!['3010', '3011'].includes(base.port)) {
  throw new Error(`Refusing target ${base.origin}; this probe only allows ports 3010/3011`);
}
const output = process.env.PROBE_OUTPUT || '/tmp/client-actions-fit';
mkdirSync(output, { recursive: true });

function pickChromium() {
  const roots = [`${process.env.HOME}/Library/Caches/ms-playwright`, `${process.env.HOME}/.cache/ms-playwright`];
  const candidates = [];
  for (const root of roots) {
    let entries = [];
    try { entries = readdirSync(root); } catch { continue; }
    for (const entry of entries) {
      if (entry.startsWith('chromium_headless_shell-')) candidates.push(`${root}/${entry}/chrome-headless-shell-mac-arm64/chrome-headless-shell`);
      if (entry.startsWith('chromium-')) candidates.push(`${root}/${entry}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`);
    }
  }
  return candidates.find(file => existsSync(file));
}

const SIZES = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'narrow', width: 390, height: 844 },
];

/**
 * 用例＝「窗口尺寸 × 值形态」。
 *
 * `long` 这一档是必须的：本机验证实例的 releaseId 恰好是 `unversioned`（没有发布元数据），
 * 一行就放下了，**复现不出用户那张截图的场景**（真实 releaseId 是 20 字符，
 * 资源修订是 64 位十六进制）。所以这里直接把两个字段改成真实长度，验证的是
 * **CSS 本身撑不撑得住**——即便将来有人把关掉的缩短显示改回来，面板也不该溢出。
 */
const SCENARIOS = [
  { name: 'real', mutate: null },
  {
    name: 'long',
    mutate: () => {
      document.querySelector('#client-actions [data-role="version"]').textContent = '20260917124427-89966137';
      // 刻意写回**完整**摘要：这条用例要证明的是排版容得下它，不是显示被缩短。
      document.querySelector('#client-actions [data-role="resource"]').textContent =
        '8c1545c0d8ca9bb34bfabbc0dcbacde855a1a2cff31b208b65a0963574ed6d99';
    },
  },
];

const failures = [];
const browser = await chromium.launch({
  args: ['--no-proxy-server'],
  executablePath: process.env.CHROMIUM_PATH || pickChromium(),
});
try {
  const page = await browser.newPage();
  await page.goto(new URL('/', base).href, { waitUntil: 'load' });
  await page.waitForSelector('#client-actions [data-role="version"]', { timeout: 30000 });
  await page.waitForFunction(
    () => (document.querySelector('#client-actions [data-role="version"]')?.textContent ?? '').trim() !== '—',
    { timeout: 30000 },
  );
  await page.waitForTimeout(500);

  for (const size of SIZES) {
    for (const scenario of SCENARIOS) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('#client-actions [data-role="resource"]', { timeout: 30000 });
      await page.waitForTimeout(400);
      if (scenario.mutate) await page.evaluate(scenario.mutate);
      await page.waitForTimeout(250);
    const measurement = await page.evaluate(() => {
      const panel = document.querySelector('#client-actions');
      const panelBox = panel.getBoundingClientRect();
      const style = getComputedStyle(panel);
      const inset = (name) => Number.parseFloat(style[name]) || 0;
      const content = {
        left: panelBox.left + inset('borderLeftWidth') + inset('paddingLeft'),
        right: panelBox.right - inset('borderRightWidth') - inset('paddingRight'),
      };
      const escapes = [];
      for (const element of panel.querySelectorAll('*')) {
        const box = element.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;
        if (box.right > content.right + 0.5 || box.left < content.left - 0.5) {
          escapes.push({
            selector: `${element.tagName.toLowerCase()}${element.dataset?.role ? `[data-role=${element.dataset.role}]` : ''}`,
            text: (element.textContent ?? '').slice(0, 32),
            left: Number(box.left.toFixed(1)),
            right: Number(box.right.toFixed(1)),
          });
        }
      }
      // 标签有没有被拆行：标签是 nowrap，所以它的高度应当等于单行行高。
      const labels = [...panel.querySelectorAll('.client-actions-label')].map(label => ({
        text: label.textContent.trim(),
        height: Number(label.getBoundingClientRect().height.toFixed(1)),
        lineHeight: Number.parseFloat(getComputedStyle(label).lineHeight) || 0,
      }));
      const resource = panel.querySelector('[data-role="resource"]');
      return {
        content,
        escapes,
        labels,
        resourceText: resource?.textContent ?? '',
        resourceTitle: resource?.title ?? '',
        panel: { left: Number(panelBox.left.toFixed(1)), right: Number(panelBox.right.toFixed(1)), width: Number(panelBox.width.toFixed(1)) },
      };
    });

    const label = `${size.name}/${scenario.name}`;
    console.log(`\n== ${label} ${size.width}x${size.height} ==`);
    console.log(`  面板 x ${measurement.panel.left} … ${measurement.panel.right}（宽 ${measurement.panel.width}）`);
    console.log(`  修订显示 "${measurement.resourceText}"`);
    if (measurement.escapes.length === 0) {
      console.log('  ✓ 没有元素越出面板内容盒');
    } else {
      console.log(`  ✗ ${measurement.escapes.length} 个元素越界：`);
      for (const escape of measurement.escapes) console.log(`     ${escape.selector} "${escape.text}" → right=${escape.right}（内容盒右边界 ${measurement.content.right.toFixed(1)}）`);
      failures.push(`${label}: ${measurement.escapes.length} 个元素越出面板`);
    }
    for (const item of measurement.labels) {
      if (item.lineHeight > 0 && item.height > item.lineHeight * 1.6) {
        console.log(`  ✗ 标签被拆行："${item.text}" 高 ${item.height} > 行高 ${item.lineHeight}`);
        failures.push(`${label}: 标签被拆行 "${item.text}"`);
      }
    }
    // title 的完整值只在**未注入**的那档检查：注入档是按用例改写的正文，不看 title。
    if (scenario.mutate === null && measurement.resourceTitle.length < 16) {
      console.log(`  ✗ 修订号没有保留完整值（title="${measurement.resourceTitle}"）`);
      failures.push(`${label}: title 未保留完整修订号`);
    }

    const panel = await page.$('#client-actions');
    await panel.screenshot({ path: `${output}/client-actions-${size.name}-${scenario.name}.png` });
    }
  }
} finally {
  await browser.close();
}

console.log('');
if (failures.length > 0) {
  console.error(`✗ 排版探针失败 ${failures.length} 项：`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('✓ 排版探针通过：面板内无越界元素、标签未被拆行、修订号保留完整值。');
