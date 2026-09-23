#!/usr/bin/env python3
"""把已产出的静帧组装成一支 animatic（动态分镜预览片）。

用途：Flova 额度耗尽、十二镜 AI 视频无法继续生成时，先用已核对的素材
按分镜顺序做模型式横向平移，让用户能真实看到节奏与构图。
输出：1920x1080 / 30fps / H.264，约 59 秒。无声（配音与音效属未完成环节）。
"""
import os
import shutil
import subprocess
import sys

import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFont

SRC = "/Users/muniao/Code/MapleStory/artifacts/flova/粉色旅店的金钥匙"
WORK = os.path.join(SRC, "animatic_build")
OUT = "/Users/muniao/Code/MapleStory/artifacts/flova/粉色旅店的金钥匙/粉色旅店的金钥匙_动态分镜预览.mp4"

W, H = 1920, 1080
SCALE = 1.05
BW, BH = int(W * SCALE), int(H * SCALE)          # 2016 x 1134
X_MAX, Y_MAX = BW - W, BH - H                     # 96 x 54
FPS = 30

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

FONT_CANDIDATES = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
    "/System/Library/Fonts/Helvetica.ttc",
]


def find_font():
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            return p
    return None


def fit_16x9(img):
    img = img.convert("RGB")
    sw, sh = img.size
    target = W / H
    if sw / sh > target:
        nw = int(sh * target)
        left = (sw - nw) // 2
        img = img.crop((left, 0, left + nw, sh))
    else:
        nh = int(sw / target)
        top = (sh - nh) // 2
        img = img.crop((0, top, sw, top + nh))
    return img.resize((BW, BH), Image.LANCZOS)


def make_outro():
    base = fit_16x9(Image.open(os.path.join(SRC, "element_6.png")))
    overlay = Image.new("RGBA", (BW, BH), (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    fp = find_font()
    title = "《粉色旅店的金钥匙》"
    sub = "The Golden Key of the Pink Hotel"
    t_font = ImageFont.truetype(fp, 92, index=0) if fp else ImageFont.load_default()
    s_font = ImageFont.truetype(fp, 30, index=0) if fp else ImageFont.load_default()
    tx, ty = BW // 2, BH // 2 - 30
    for dx, dy in ((-3, 3), (3, 3), (0, 0)):
        d.text((tx + dx, ty + dy), title, font=t_font, fill=(60, 22, 34, 200),
               anchor="mm")
    d.text((tx, ty), title, font=t_font, fill=(233, 200, 122, 255), anchor="mm")
    d.text((tx, ty + 92), sub, font=s_font, fill=(255, 236, 208, 220), anchor="mm")
    out = Image.alpha_composite(base.convert("RGBA"), overlay).convert("RGB")
    p = os.path.join(WORK, "outro.png")
    out.save(p)
    return p


SEGMENTS = [
    ("S01", "keyframe_4.png", 5.0, "still"),
    ("S02", "keyframe_2.png", 5.0, "slow"),
    ("S03", "keyframe_5.png", 4.0, "still"),
    ("S04", "element_5.png", 4.0, "slow"),
    ("S05", "element_3.png", 4.0, "lr"),
    ("S06", "keyframe_1.png", 5.0, "still"),
    ("S07", "element_4.png", 4.0, "slow"),
    ("S08", "keyframe_2.png", 5.0, "rl"),
    ("S09", "keyframe_3.png", 6.0, "still"),
    ("S10", "element_2.png", 5.0, "lr"),
    ("S11", "keyframe_1.png", 6.0, "still"),
    ("S12", "OUTRO", 6.0, "still"),
]


def x_expr(motion, dur):
    if motion == "still":
        return "48"
    if motion == "lr":
        return f"({X_MAX}*min(t/{dur},1))"
    if motion == "rl":
        return f"({X_MAX}-{X_MAX}*min(t/{dur},1))"
    if motion == "slow":
        return f"(12+{X_MAX - 24}*min(t/{dur},1))"
    return "48"


def main():
    if os.path.isdir(WORK):
        shutil.rmtree(WORK)
    os.makedirs(WORK)

    outro = make_outro()

    parts = []
    for name, src, dur, motion in SEGMENTS:
        path = outro if src == "OUTRO" else os.path.join(SRC, src)
        frame = fit_16x9(Image.open(path))
        fp = os.path.join(WORK, f"{name}.png")
        frame.save(fp)

        seg = os.path.join(WORK, f"{name}.mp4")
        vf = f"crop={W}:{H}:x='{x_expr(motion, dur)}':y=27,format=yuv420p"
        cmd = [
            FFMPEG, "-y", "-loglevel", "error",
            "-loop", "1", "-framerate", str(FPS), "-i", fp,
            "-t", str(dur), "-vf", vf,
            "-r", str(FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "18",
            "-pix_fmt", "yuv420p", seg,
        ]
        subprocess.run(cmd, check=True)
        size = os.path.getsize(seg)
        print(f"{name} {motion:6s} {dur:>4}s -> {size / 1e6:.2f} MB", flush=True)
        parts.append(seg)

    lst = os.path.join(WORK, "concat.txt")
    with open(lst, "w", encoding="utf-8") as f:
        for p in parts:
            f.write(f"file '{p}'\n")

    subprocess.run(
        [FFMPEG, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", lst, "-c", "copy", "-movflags", "+faststart", OUT],
        check=True,
    )
    total = sum(s[2] for s in SEGMENTS)
    print(f"\n{OUT}\n{os.path.getsize(OUT) / 1e6:.2f} MB / {total:.1f}s")


if __name__ == "__main__":
    sys.exit(main())
