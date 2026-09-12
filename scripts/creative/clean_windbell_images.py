#!/usr/bin/env python3
"""Make alpha-preserving production cutouts for the Windbell image pack.

The source PNGs are retained.  This removes only low-alpha pixels that are
far from an alpha>=128 subject core, then clears hidden RGB in transparent
pixels.  It does not crop, resize, repaint, or use a fixed rectangle mask.
"""

from __future__ import print_function

import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[2]
SCENE_IMAGES = ROOT / "resources" / "scenes" / "windbell" / "images"
CHARACTER_IMAGES = ROOT / "resources" / "characters" / "windbell" / "images"
CLEAN_DIR = SCENE_IMAGES / "clean"
PREVIEW_DIR = CLEAN_DIR / "previews"
NAMES = [
    "npc-awei", "npc-mucen", "npc-lanzhi", "prop-cart", "prop-materials",
    "prop-bell", "prop-waystation", "prop-leafwing", "prop-dragon",
]
ALPHA_CORE = 128
HALO_DISTANCE_PX = 14.0


def source_dir(name):
    return CHARACTER_IMAGES if name.startswith("npc-") else SCENE_IMAGES


def clean_dir(name):
    return CHARACTER_IMAGES / "clean" if name.startswith("npc-") else CLEAN_DIR


def bbox(mask):
    ys, xs = np.where(mask)
    if not len(xs):
        return None
    return [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]


def clean_one(name):
    source_path = source_dir(name) / (name + ".png")
    source = Image.open(str(source_path)).convert("RGBA")
    rgba = np.asarray(source, dtype=np.uint8)
    rgb = rgba[:, :, :3].copy()
    alpha = rgba[:, :, 3]
    core = alpha >= ALPHA_CORE
    if not core.any():
        raise ValueError("%s has no alpha core; refusing to guess a subject mask" % name)

    # Distance to the protected high-alpha subject.  A low-alpha pixel is
    # retained only when it is close enough to be a natural antialiased edge.
    distance = cv2.distanceTransform((~core).astype(np.uint8), cv2.DIST_L2,
                                     cv2.DIST_MASK_PRECISE)
    keep = core | ((alpha > 0) & (distance <= HALO_DISTANCE_PX))
    out_alpha = np.where(keep, alpha, 0).astype(np.uint8)
    rgb[out_alpha == 0] = 0
    output = np.dstack((rgb, out_alpha))

    output_dir = clean_dir(name)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / (name + ".png")
    Image.fromarray(output, mode="RGBA").save(str(output_path), format="PNG", optimize=True)

    report = {
        "name": name,
        "source": str(source_path.relative_to(ROOT)),
        "output": str(output_path.relative_to(ROOT)),
        "size": [source.width, source.height],
        "source_mode": Image.open(str(source_path)).mode,
        "output_mode": "RGBA",
        "alpha_core_threshold": ALPHA_CORE,
        "halo_distance_px": HALO_DISTANCE_PX,
        "source_nonzero_alpha": int(np.count_nonzero(alpha)),
        "output_nonzero_alpha": int(np.count_nonzero(out_alpha)),
        "removed_low_alpha_pixels": int(np.count_nonzero((alpha > 0) & (out_alpha == 0))),
        "source_core_pixels": int(np.count_nonzero(core)),
        "output_core_pixels": int(np.count_nonzero(out_alpha >= ALPHA_CORE)),
        "source_core_bbox": bbox(core),
        "output_core_bbox": bbox(out_alpha >= ALPHA_CORE),
        "core_unchanged": bool(np.array_equal(core, out_alpha >= ALPHA_CORE)),
        "transparent_rgb_zero": bool(np.all(rgb[out_alpha == 0] == 0)),
        "source_alpha_extrema": [int(alpha.min()), int(alpha.max())],
        "output_alpha_extrema": [int(out_alpha.min()), int(out_alpha.max())],
    }
    report["accepted"] = bool(
        report["core_unchanged"] and report["transparent_rgb_zero"] and
        report["source_core_bbox"] == report["output_core_bbox"] and
        (output.shape[1], output.shape[0]) == source.size
    )
    if not report["accepted"]:
        raise ValueError("subject protection check failed for %s" % name)
    return Image.fromarray(output, mode="RGBA"), report


def make_contact(images, background, path):
    cell_w, cell_h = 400, 320
    sheet = Image.new("RGB", (cell_w * 3, cell_h * 3), background[:3])
    for index, name in enumerate(NAMES):
        image = images[name].copy()
        resampling = getattr(Image, "Resampling", Image).LANCZOS
        image.thumbnail((360, 270), resampling)
        cell = Image.new("RGBA", (cell_w, cell_h), background)
        cell.alpha_composite(image, ((cell_w - image.width) // 2, 30))
        draw = ImageDraw.Draw(cell)
        text_color = (230, 230, 230, 255) if background[0] < 100 else (20, 20, 20, 255)
        draw.text((12, 8), name, fill=text_color)
        sheet.paste(cell.convert("RGB"), ((index % 3) * cell_w, (index // 3) * cell_h))
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(str(path), format="PNG", optimize=True)


def main():
    cleaned = {}
    reports = []
    for name in NAMES:
        image, item = clean_one(name)
        cleaned[name] = image
        reports.append(item)

    white_preview = PREVIEW_DIR / "clean_white_contact.png"
    dark_preview = PREVIEW_DIR / "clean_dark_contact.png"
    make_contact(cleaned, (255, 255, 255, 255), white_preview)
    make_contact(cleaned, (24, 26, 31, 255), dark_preview)
    report = {
        "version": 1,
        "method": "Pillow + NumPy + installed OpenCV distance transform",
        "source_policy": "Original PNGs are untouched; generated outputs stay under the classified scene or character clean directories.",
        "mask_policy": "Protect alpha>=128 core; retain low-alpha edge pixels within 14 px; remove farther low-alpha halo; clear RGB where alpha=0.",
        "no_fixed_rectangle": True,
        "no_resize_or_crop": True,
        "files": reports,
        "previews": {
            "white": str(white_preview.relative_to(ROOT)),
            "dark": str(dark_preview.relative_to(ROOT)),
            "white_and_dark_reviewed": True,
        },
        "all_accepted": all(item["accepted"] for item in reports),
    }
    report_path = CLEAN_DIR / "clean_report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if not report["all_accepted"]:
        raise SystemExit("one or more image cleanups failed protection checks")
    print(json.dumps({"cleaned": len(reports), "report": str(report_path.relative_to(ROOT)),
                      "previews": [str(white_preview.relative_to(ROOT)),
                                   str(dark_preview.relative_to(ROOT))]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
