"""Derive small, repeatable material patches from the reviewed Windbell key art.

The original key art remains untouched.  Each patch is cropped from a region
that contains one surface family, then mirrored/tiled to a square image so an
ordinary primitive UV map does not stretch a whole scenic plate across a face.
The JSON sidecar records the exact source crop for review and later rebakes.
"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageOps


PROJECT = Path(__file__).resolve().parents[3]
IMAGE_ROOT = PROJECT / "resources" / "creative" / "windbell" / "images"
OUTPUT_ROOT = PROJECT / "resources" / "creative" / "windbell" / "blender" / "textures"
TARGET_SIZE = 512

PATCHES = {
    # The small runtime swatches contain no scenic subject, so UVs cannot
    # reveal a dragon, NPC or building when a primitive is enlarged.
    "bridge_wood": {"source": "client/public-tms273/assets/windbell/wood.png", "crop": [0, 2, 256, 22], "surface": "bridge deck wood swatch"},
    "bridge_grass": {"source": "resources/creative/windbell/images/island-keyart.png", "crop": [320, 790, 448, 820], "surface": "bridge grass detail"},
    "bridge_bark": {"source": "resources/creative/windbell/images/bridge-restored.png", "crop": [270, 170, 320, 230], "surface": "giant tree bark detail"},
    "bridge_stone": {"source": "resources/creative/windbell/images/island-keyart.png", "crop": [1240, 330, 1300, 370], "surface": "floating island stone detail"},
    "bridge_water": {"source": "resources/creative/windbell/images/bridge-restored.png", "crop": [1060, 820, 1180, 880], "surface": "river water detail"},
    "island_wood": {"source": "client/public-tms273/assets/windbell/wood.png", "crop": [0, 2, 256, 22], "surface": "island root wood swatch"},
    "island_grass": {"source": "resources/creative/windbell/images/island-keyart.png", "crop": [320, 790, 448, 820], "surface": "island grass detail"},
    "island_bark": {"source": "resources/creative/windbell/images/bridge-restored.png", "crop": [270, 170, 320, 230], "surface": "island trunk bark detail"},
    "island_stone": {"source": "resources/creative/windbell/images/island-keyart.png", "crop": [1240, 330, 1300, 370], "surface": "island stone detail"},
    "island_water": {"source": "resources/creative/windbell/images/bridge-restored.png", "crop": [1060, 820, 1180, 880], "surface": "island water detail"},
}


def square_tile(crop: Image.Image) -> Image.Image:
    """Preserve the crop's primary detail axis while mirroring it to 512²."""
    crop = crop.convert("RGB")
    if crop.width >= crop.height:
        width = TARGET_SIZE
        height = max(1, round(crop.height * width / crop.width))
    else:
        height = TARGET_SIZE
        width = max(1, round(crop.width * height / crop.height))
    tile = crop.resize((width, height), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (TARGET_SIZE, TARGET_SIZE))
    if crop.width >= crop.height:
        y = 0
        row = 0
        while y < TARGET_SIZE:
            piece = ImageOps.flip(tile) if row % 2 else tile
            canvas.paste(piece, (0, y))
            y += height
            row += 1
    else:
        x = 0
        column = 0
        piece = tile
        while x < TARGET_SIZE:
            piece = ImageOps.mirror(tile) if column % 2 else tile
            canvas.paste(piece, (x, 0))
            x += width
            column += 1
    return canvas


def main() -> None:
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    records = {}
    for role, spec in PATCHES.items():
        source_path = PROJECT / spec["source"]
        if not source_path.is_file():
            raise SystemExit(f"Missing source key art: {source_path}")
        with Image.open(source_path) as image:
            image.load()
            box = tuple(spec["crop"])
            if box[2] > image.width or box[3] > image.height:
                raise SystemExit(f"Crop outside {source_path.name}: {box}")
            patch = square_tile(image.crop(box))
        output = OUTPUT_ROOT / f"windbell_{role}_patch.png"
        patch.save(output, format="PNG", optimize=True)
        records[role] = {
            "output": str(output.relative_to(PROJECT)),
            "source": str(source_path.relative_to(PROJECT)),
            "crop_xyxy_pixels": list(spec["crop"]),
            "surface": spec["surface"],
            "output_size": [TARGET_SIZE, TARGET_SIZE],
            "policy": "crop only; mirror/tile to avoid scene-scale UV stretching; source untouched",
        }
    sidecar = OUTPUT_ROOT / "patch_manifest.json"
    sidecar.write_text(json.dumps({"version": 1, "patches": records}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": "ok", "output": str(OUTPUT_ROOT), "patch_count": len(records), "manifest": str(sidecar)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
