#!/usr/bin/env node
// 把 export_gms83_login_ui.cjs 产出的 index.json 渲染成一份可离线浏览的素材总览页
// （<out>/preview.html）：按控件分组罗列每张 PNG 的缩略图、WZ 路径与原始尺寸，
// 供挑选 / 对照 / 交付时一眼看全。
//
// 用法：node scripts/render_gms83_ui_preview.cjs --dir resources/gms83-login-ui
const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const out = { dir: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') { out.dir = argv[i + 1]; i += 1; }
  }
  if (!out.dir) throw new Error('必须指定 --dir DIR');
  return out;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function main() {
  const { dir } = parseArgs(process.argv.slice(2));
  const root = path.resolve(dir);
  const idx = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'));

  // 分组键：路径去掉最后两段（表/帧），得到"控件级"分组
  const groups = new Map();
  for (const n of idx.nodes) {
    const seg = n.path.split('/');
    const key = seg.slice(0, Math.max(2, seg.length - 2)).join('/');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }

  const sections = [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, nodes]) => {
      const cards = nodes.map((n) => `
      <figure class="card" data-path="${esc(n.path)}">
        <div class="thumb"><img loading="lazy" src="./${esc(encodeURIComponent(n.file))}" alt="${esc(n.path)}" width="${n.width}" height="${n.height}"></div>
        <figcaption><b>${esc(n.path.split('/').slice(2).join('/'))}</b><span>${n.width}×${n.height}</span></figcaption>
      </figure>`).join('');
      return `<section class="group" data-group="${esc(key)}">
      <h2>${esc(key)}<em>${nodes.length}</em></h2>
      <div class="grid">${cards}</div>
    </section>`;
    })
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GMS083 UI 素材总览</title>
<style>
:root{--bg:#14100c;--panel:#1e1813;--line:#3a2f24;--ink:#e8dcc8;--dim:#a0907a;--gold:#d8a955}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.5 "Microsoft YaHei",Inter,system-ui,sans-serif}
header{position:sticky;top:0;z-index:9;background:#14100cf2;border-bottom:1px solid var(--line);padding:14px 20px;backdrop-filter:blur(8px);display:flex;gap:16px;align-items:center;flex-wrap:wrap}
h1{margin:0;font-size:16px;color:var(--gold);letter-spacing:.5px}
.stat{color:var(--dim)}.stat b{color:var(--ink)}
input[type=search]{margin-left:auto;min-width:230px;padding:7px 11px;border-radius:7px;border:1px solid var(--line);background:#0e0b08;color:var(--ink)}
main{padding:18px 20px 60px}
.group{margin:0 0 26px}
h2{font-size:13px;margin:0 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line);color:var(--gold);font-weight:600;display:flex;gap:8px;align-items:baseline}
h2 em{font-style:normal;color:var(--dim);font-weight:400;font-size:11px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:10px}
.card{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:7px;overflow:hidden}
.thumb{height:76px;display:flex;align-items:center;justify-content:center;background:repeating-conic-gradient(#241d16 0% 25%,#2a221a 0% 50%) 50%/14px 14px;border-radius:5px;padding:3px}
.thumb img{max-width:100%;max-height:70px;image-rendering:pixelated;object-fit:contain}
figcaption{font-size:10px;line-height:1.35;color:var(--dim);word-break:break-all}
figcaption b{display:block;color:var(--ink);font-weight:400}
figcaption span{color:#7d6f5d}
.hidden{display:none}
</style></head><body>
<header>
  <h1>GMS083 UI 素材总览</h1>
  <div class="stat">来源 <b>${esc(idx.source)}</b> · 加密 <b>${esc(idx.mapleVersion)}</b> · 映像 <b>${esc(idx.images.join(' / '))}</b> · 画布节点 <b>${idx.canvasNodes}</b> · 唯一 PNG <b>${idx.pngs}</b></div>
  <input type="search" id="q" placeholder="过滤路径，如 BtLogin / CheckBox">
</header>
<main>${sections}</main>
<script>
const q=document.getElementById('q');
q.addEventListener('input',()=>{const v=q.value.trim().toLowerCase();
  for(const s of document.querySelectorAll('.group')){let hit=0;
    for(const c of s.querySelectorAll('.card')){const ok=!v||c.dataset.path.toLowerCase().includes(v);c.classList.toggle('hidden',!ok);if(ok)hit++;}
    s.classList.toggle('hidden',v&&!hit);}});
</script>
</body></html>
`;
  const target = path.join(root, 'preview.html');
  fs.writeFileSync(target, html);
  console.log(`已生成 ${target}（${groups.size} 组 / ${idx.nodes.length} 张）`);
}

main();
