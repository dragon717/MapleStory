// Scratch diagnostic: composite map 000010000 layers in DOM space and overlay
// the portal coordinates (red = out00, blue = glBmsg1, green = glBmsg0) to
// see where the WZ anchor falls relative to the terrain art.
import { chromium } from '/Users/muniao/.npm/_npx/31e32ef8478fbf80/node_modules/playwright/index.mjs';

const base = 'http://127.0.0.1:3010';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1900, height: 1300 } });
await page.setContent('<body style="margin:0;background:#000">compositing…</body>');
await page.addScriptTag({
  content: `(async () => {
    const base = '${base}';
    const m = await (await fetch(base + '/assets/manifest.json')).json();
    const map = m.map;
    const b = map.bounds;
    const W = b.xMax - b.xMin, H = b.yMax - b.yMin;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;left:20px;top:20px;width:' + W + 'px;height:' + H + 'px;background:#000;overflow:hidden;';
    document.body.appendChild(wrap);
    const layers = [...map.layers].sort((a, c) => a.depth - c.depth);
    for (const l of layers) {
      const img = document.createElement('img');
      img.src = base + '/' + l.url;
      img.style.cssText = 'position:absolute;left:' + (l.x - b.xMin) + 'px;top:' + (l.y - b.yMin) + 'px;';
      wrap.appendChild(img);
    }
    const mark = (x, y, color, label) => {
      const line = document.createElement('div');
      line.style.cssText = 'position:absolute;left:' + (x - b.xMin) + 'px;top:' + (0) + 'px;width:3px;height:' + H + 'px;background:' + color + ';';
      wrap.appendChild(line);
      const dot = document.createElement('div');
      dot.style.cssText = 'position:absolute;left:' + (x - b.xMin - 12) + 'px;top:' + (y - b.yMin - 12) + 'px;width:24px;height:24px;border:3px solid ' + color + ';border-radius:50%;box-sizing:border-box;';
      wrap.appendChild(dot);
      const tag = document.createElement('div');
      tag.textContent = label + ' (' + x + ',' + y + ')';
      tag.style.cssText = 'position:absolute;left:' + (x - b.xMin + 14) + 'px;top:' + (y - b.yMin - 30) + 'px;color:' + color + ';font:bold 18px monospace;background:#000a;';
      wrap.appendChild(tag);
    };
    for (const p of map.portals) {
      if (p.name === 'out00') mark(p.x, p.y, '#ff3b3b', 'out00');
      if (p.name === 'glBmsg0') mark(p.x, p.y, '#3bdc6b', 'glBmsg0');
      if (p.name === 'glBmsg1') mark(p.x, p.y, '#3b9bff', 'glBmsg1');
    }
    window.__ready = true;
  })();
  `,
});
await page.waitForFunction('window.__ready === true');
await page.waitForTimeout(1200);
await page.screenshot({ path: 'evidence/qa/portal-map-composite.png' });
console.log('screenshot saved');
await browser.close();
