#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成登录界面用的射手村（Henesys）风景背景 1280x720。

素材来源（TMS273 客户端打包资源的装配产物，权威源见 docs/technical 的资源链路说明）：
  - 天空/云层：Map_Back__Canvas_grassySoil.img_back_1-*.png   (1024x579，带 alpha)
  - 远景丘陵：Map_Back__Canvas_grassySoil.img_back_2-*.png   (2493x340，带 alpha)
      ↑ Map/Back/grassySoil.img/back/0..2 就是射手村（100000000）的三层背景：
        0=天空底色  1=云  2=丘陵。这里取 1+2 合成。

输出：
  resources/gms83-login-ui/background/henesys-login-bg-raw.png    合成原图（未压暗）
  resources/gms83-login-ui/background/henesys-login-bg.png        最终版（上暗-中亮-下暗渐晕）

用法：python3 scripts/build_henesys_login_bg.py
依赖：Pillow（本机用 ~/.workbuddy/binaries/python/envs/default/bin/python）
"""

import glob
import os
import sys

from PIL import Image, ImageChops, ImageEnhance

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(REPO, "client", "public-tms273", "assets", "tms273")
OUT_DIR = os.path.join(REPO, "resources", "gms83-login-ui", "background")

W, H = 1280, 720
HILL_HEIGHT = 280          # 丘陵在 720 高画布里的高度（底部贴齐）
COLOR_KEEP = 0.96          # 全局饱和度保留系数


def _find(pattern):
    hits = sorted(glob.glob(os.path.join(ASSETS, pattern)))
    if not hits:
        sys.exit(f"找不到素材：{pattern}\n（先确认导出树/装配产物已生成）")
    return hits[-1]


def over(base, layer, size, pos):
    """把带 alpha 的图层预乘后缩放，再 source-over 到不透明底图上。

    必须在预乘空间里做 resize —— 直接缩放 RGBA 会让透明区的 RGB 渗出来，
    在图层边缘留下一圈肉眼可见的方块接缝。
    """
    r, g, b, a = layer.split()
    pm = Image.merge("RGB", (
        ImageChops.multiply(r, a),
        ImageChops.multiply(g, a),
        ImageChops.multiply(b, a),
    )).resize(size, Image.LANCZOS)
    ar = a.resize(size, Image.LANCZOS)
    inv = ImageChops.invert(ar)

    box = (pos[0], pos[1], pos[0] + size[0], pos[1] + size[1])
    pms = pm.split()
    bands = []
    for i, band in enumerate(base.split()):
        # 在单通道 'L' 上贴 'L'；贴到 RGB 画布上会退化成灰度
        out = band.copy()
        out.paste(ImageChops.add(ImageChops.multiply(band.crop(box), inv), pms[i]), pos)
        bands.append(out)
    return Image.merge("RGB", bands)


def compose():
    sky = Image.open(_find("Map_Back__Canvas_grassySoil.img_back_1-*.png")).convert("RGBA")
    hills = Image.open(_find("Map_Back__Canvas_grassySoil.img_back_2-*.png")).convert("RGBA")

    # 1) 天空底色：垂直渐变（取云图上部天空色 -> 云白）
    top = sky.convert("RGB").getpixel((520, 60))
    base = Image.new("RGB", (W, H))
    px = base.load()
    for y in range(H):
        t = (y / (H - 1)) ** 1.4
        col = tuple(int(top[i] + (238 - top[i]) * t) for i in range(3))
        for x in range(W):
            px[x, y] = col

    # 2) 云层：等比缩到宽 1280，贴顶
    base = over(base, sky, (W, int(sky.height * W / sky.width)), (0, 0))

    # 3) 丘陵：放大到高 HILL_HEIGHT，水平居中裁切，底部贴齐
    hw = int(hills.width * HILL_HEIGHT / hills.height)
    hl = hills.resize((hw, HILL_HEIGHT), Image.LANCZOS)
    x0 = (hw - W) // 2
    base = over(base, hl.crop((x0, 0, x0 + W, HILL_HEIGHT)), (W, HILL_HEIGHT), (0, H - HILL_HEIGHT))
    return base


def vignette(img):
    """上暗-中亮-下暗的垂直增益。

    登录界面的标题/副标题落在顶部带、图注落在底部带，两条带都要压暗，
    浅色文字才有对比度；中部留给风景主体，保持通亮。
    """
    def gain(y):
        if y <= 120:
            return 0.54 + (0.70 - 0.54) * (y / 120)
        if y <= 470:
            return 0.70 + (0.83 - 0.70) * ((y - 120) / 350)
        return max(0.34, 0.83 - 0.49 * ((y - 470) / 250))

    src = ImageEnhance.Color(img).enhance(COLOR_KEEP).load()
    out = Image.new("RGB", (W, H))
    dst = out.load()
    for y in range(H):
        g = gain(y)
        for x in range(W):
            r, gg, b = src[x, y]
            dst[x, y] = (int(r * g), int(gg * g), int(b * g))
    return out


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    raw = compose()
    raw.save(os.path.join(OUT_DIR, "henesys-login-bg-raw.png"))
    vignette(raw).save(os.path.join(OUT_DIR, "henesys-login-bg.png"))
    print(f"已生成 {W}x{H} 射手村背景 -> {OUT_DIR}")


if __name__ == "__main__":
    main()
