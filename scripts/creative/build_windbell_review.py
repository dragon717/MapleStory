#!/usr/bin/env python3
"""Build a file-local review of actual Windbell deliverables (no server)."""
import html
import json
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'resources/creative/windbell'

def esc(value):
    return html.escape(str(value), quote=True)

def url(path):
    return quote(path.relative_to(OUT).as_posix())

def build():
    images = sorted(p for p in (OUT / 'images').glob('*.png') if not any(tag in p.stem for tag in ('-study-', '-clean-edit-')))
    images = [(OUT / 'images/clean' / p.name) if (OUT / 'images/clean' / p.name).exists() else p for p in images]
    renders = sorted((OUT / 'blender/renders').glob('*.png')) if (OUT / 'blender').exists() else []
    music = sorted((OUT / 'audio').rglob('*.ogg')) if (OUT / 'audio').exists() else []
    models = sorted(p for p in (OUT / 'blender').rglob('*') if p.suffix in ('.blend', '.glb')) if (OUT / 'blender').exists() else []
    narratives = sorted((OUT / 'narrative').glob('*.json')) if (OUT / 'narrative').exists() else []
    cards = []
    for path in images + renders:
        group = '图像生成' if path in images else 'Blender 渲染'
        cards.append('<figure data-kind="image"><a href="{u}" target="_blank"><img loading="lazy" src="{u}" alt="{n}"></a><figcaption><small>{g}</small><strong>{n}</strong><a href="{u}" download>原文件 ↗</a></figcaption></figure>'.format(u=url(path), n=esc(path.stem), g=group))
    for path in music:
        cards.append('<article data-kind="audio"><small>原创程序作曲／合成 · OGG</small><h3>{n}</h3><audio controls preload="none" src="{u}"></audio><a href="{u}" download>保存音频 ↗</a></article>'.format(u=url(path), n=esc(path.stem)))
    for path in models:
        cards.append('<article data-kind="model"><small>可编辑模型／交换文件</small><h3>{n}</h3><p>{size:.1f} MB</p><a href="{u}">打开／保存 {ext} ↗</a></article>'.format(u=url(path),n=esc(path.stem),size=path.stat().st_size/1048576,ext=esc(path.suffix)))
    for path in narratives:
        data=json.loads(path.read_text(encoding='utf-8'))
        cards.append('<article data-kind="narrative"><small>离线设计数据 · 非在线游戏状态</small><h3>{n}</h3><a href="{u}">JSON 原文件 ↗</a><details><summary>查看树／分支数据</summary><pre>{body}</pre></details></article>'.format(n=esc(path.stem),u=url(path),body=esc(json.dumps(data,ensure_ascii=False,indent=2))))
    page='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>风铃桥与风铃岛 · 制作交付</title>
<style>:root{color-scheme:light;--ink:#19382c;--muted:#6a7669;--paper:#f5f2e8;--line:#d9ddcf}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.65 system-ui,-apple-system,sans-serif}header,main,footer{max-width:1440px;margin:auto;padding:36px clamp(18px,4vw,60px)}header{padding-top:64px}small{color:var(--muted);letter-spacing:.04em}h1{font-family:Georgia,serif;font-size:clamp(34px,5vw,68px);font-weight:500;line-height:1.12;margin:18px 0}h3{font-size:17px;overflow-wrap:anywhere}p{max-width:840px}nav{display:flex;flex-wrap:wrap;gap:8px;margin-top:26px}button{font:inherit;border:1px solid var(--line);background:transparent;color:var(--ink);padding:8px 20px;border-radius:24px;cursor:pointer}button[aria-pressed=true]{background:var(--ink);color:white}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:24px;align-items:start}figure,article{margin:0;background:#fffdf8;border:1px solid var(--line);border-radius:12px;overflow:hidden}article{padding:22px}img{display:block;width:100%;height:260px;object-fit:contain;background-color:#e2e4d9;background-image:linear-gradient(45deg,#d4d8ce 25%,transparent 25%),linear-gradient(-45deg,#d4d8ce 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#d4d8ce 75%),linear-gradient(-45deg,transparent 75%,#d4d8ce 75%);background-size:20px 20px;background-position:0 0,0 10px,10px -10px,-10px 0}figcaption{padding:16px 20px}figcaption strong{display:block;overflow-wrap:anywhere}a{color:#326c50;text-underline-offset:4px}audio{width:100%}details{margin-top:16px}summary{cursor:pointer}pre{font:12px/1.6 monospace;max-height:420px;overflow:auto;white-space:pre-wrap;word-break:break-word}footer{border-top:1px solid var(--line);color:var(--muted);font-size:13px}[hidden]{display:none!important}</style>
<header><small>WINDBELL / ORIGINAL WORLD STUDIES</small><h1>风经过，<br>这里记得。</h1><p>风铃桥的公共修复，与风铃岛的自由抵达。这里展示实际已生成的场景、模块、人物、声音和叙事数据；制作中缺失的文件不会显示为完成。</p><p><strong>交付边界：</strong>原创 P 类资产与设计包；活动清单及服务端地图交互已完成候选构建，在线 3010 尚未切换。主视觉用于参考，碰撞由共享地图几何定义；NPC 使用静态立绘。图像由用户同意的内置工具生成，工具未暴露准确模型名。</p><nav aria-label="筛选交付类型"><button data-filter="all" aria-pressed="true">全部</button><button data-filter="image" aria-pressed="false">场景与美术</button><button data-filter="audio" aria-pressed="false">音乐与音效</button><button data-filter="model" aria-pressed="false">3D 源文件</button><button data-filter="narrative" aria-pressed="false">文案与行为树</button></nav></header><main><div class="grid">'''+''.join(cards)+'''</div></main><footer>资源保存在当前项目 resources/creative/windbell。请点击图像查看原尺寸；音频只在你按播放时发声。<a href="manifest.json">制作清单</a> · <a href="../../../docs/design/windbell/PRODUCTION.md">设计规格</a></footer><script>document.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('[data-filter]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));document.querySelectorAll('[data-kind]').forEach(x=>x.hidden=b.dataset.filter!=='all'&&x.dataset.kind!==b.dataset.filter)}));</script></html>'''
    (OUT/'index.html').write_text(page,encoding='utf-8')
    print(json.dumps({'images':len(images),'renders':len(renders),'audio':len(music),'models':len(models),'narrative':len(narratives)},ensure_ascii=False))

if __name__ == '__main__':
    build()
