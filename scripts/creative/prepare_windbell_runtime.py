#!/usr/bin/env python3
"""Prepare the local Windbell creative sources for the TMS273 web runtime.

This is intentionally a small, deterministic Pillow/copy step.  The source
art is split across the classified ``resources/{scenes,characters,music,sfx}``
Windbell directories; this script only writes the runtime bundle below
``client/public-tms273/assets/windbell`` and a report describing every resize
and crop.  It does not edit the TypeScript manifest.
"""

from __future__ import print_function

import argparse
import struct
import hashlib
import json
import shutil
from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter, ImageOps


ROOT = Path(__file__).resolve().parents[2]
SCENES = ROOT / "resources" / "scenes" / "windbell"
CHARACTERS = ROOT / "resources" / "characters" / "windbell"
IMAGES = SCENES / "images"
CLEAN = SCENES / "images" / "clean"
CLEAN_CHARACTERS = CHARACTERS / "images" / "clean"
MUSIC = ROOT / "resources" / "music" / "windbell"
SFX = ROOT / "resources" / "sfx" / "windbell"
OUT = ROOT / "client" / "public-tms273" / "assets" / "windbell"
REPORT_PATH = OUT / "runtime_asset_report.json"

NPC_NAMES = ("awei", "mucen", "lanzhi")
PROP_NAMES = ("cart", "materials", "bell", "waystation", "leafwing", "dragon")
SFX_DIR = SFX

# These crops are deliberately recorded in the report.  The wood area is a
# clean horizontal plank face in the already-cleaned materials cutout.  The
# ground area is a straight grass/path edge in the island key art.  Each
# 128px patch is followed by its horizontal mirror, so both ends of the
# resulting 256px tile meet on equal source pixels when Phaser repeats it.
WOOD_SOURCE = CLEAN / "prop-materials.png"
WOOD_CROP = (760, 580, 888, 604)  # x0, y0, x1, y1 -> 128x24
GROUND_SOURCE = IMAGES / "island-keyart.png"
GROUND_CROP = (320, 750, 448, 810)  # x0, y0, x1, y1 -> 128x60

# The backdrop crops contain only sky, distant mountain/tree shapes, and
# canopy framing.  They stop above the original bridge rails and exclude all
# visible stations, carts, houses, platforms, and playable ground.
BACKDROP_SPECS = {
    "island-backdrop.png": {
        "source": IMAGES / "island-keyart.png",
        "crop": (680, 350, 850, 520),
        "blur_radius": 5.0,
        "note": "soft warm sky, distant mountains and remote tree tops; no foreground route/building",
    },
    "bridge-backdrop.png": {
        "source": IMAGES / "bridge-dormant.png",
        "crop": (550, 0, 880, 170),
        "blur_radius": 3.0,
        "note": "soft blue sky, distant mountains/trees and canopy framing; crop ends above bridge rails",
    },
}


try:
    RESAMPLE = Image.Resampling.LANCZOS
except AttributeError:  # Pillow versions bundled with older Python runtimes.
    RESAMPLE = Image.LANCZOS


def rel(path):
    """Return a portable repository-relative path for the JSON report."""

    return path.resolve().relative_to(ROOT).as_posix()


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def alpha_bbox(image):
    """Return the exact non-zero alpha bounds without inventing a rectangle."""

    rgba = image.convert("RGBA")
    bbox = rgba.getchannel("A").getbbox()
    if bbox is None:
        raise ValueError("source has no visible alpha pixels")
    return bbox


def verify_png(path, expected_size=None, expected_mode=None):
    with Image.open(path) as check:
        check.load()
        size = tuple(check.size)
        mode = check.mode
    if expected_size is not None and size != tuple(expected_size):
        raise AssertionError("{} has size {}, expected {}".format(path, size, expected_size))
    if expected_mode is not None and mode != expected_mode:
        raise AssertionError("{} has mode {}, expected {}".format(path, mode, expected_mode))
    return size, mode


def save_png(image, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(str(destination), format="PNG", optimize=True)
    size, mode = verify_png(destination)
    return {
        "path": rel(destination),
        "bytes": destination.stat().st_size,
        "sha256": sha256(destination),
        "size": list(size),
        "mode": mode,
    }


def trim_visible(source):
    image = Image.open(str(source)).convert("RGBA")
    bbox = alpha_bbox(image)
    return image.crop(bbox), bbox, tuple(image.size)


def prepare_npc(name):
    source = CLEAN_CHARACTERS / "npc-{}.png".format(name)
    destination = OUT / "npc-{}.png".format(name)
    trimmed, bbox, original_size = trim_visible(source)
    scale = min(80.0 / trimmed.width, 120.0 / trimmed.height)
    resized_size = (
        max(1, int(round(trimmed.width * scale))),
        max(1, int(round(trimmed.height * scale))),
    )
    resized = trimmed.resize(resized_size, RESAMPLE)
    canvas = Image.new("RGBA", (80, 120), (0, 0, 0, 0))
    placement = ((80 - resized.width) // 2, 120 - resized.height)
    canvas.alpha_composite(resized, placement)
    record = save_png(canvas, destination)
    verify_png(destination, (80, 120), "RGBA")
    record.update(
        {
            "kind": "npc",
            "source": rel(source),
            "source_size": list(original_size),
            "alpha_bbox": list(bbox),
            "trimmed_size": list(trimmed.size),
            "resized_size": list(resized_size),
            "placement_bottom_center": list(placement),
            "operation": "alpha_bbox_crop_then_proportional_resize_then_bottom_center_on_80x120",
        }
    )
    return record


def prepare_prop(name):
    source = CLEAN / "prop-{}.png".format(name)
    destination = OUT / "prop-{}.png".format(name)
    trimmed, bbox, original_size = trim_visible(source)
    scale = min(1.0, 768.0 / trimmed.width)
    resized_size = (
        max(1, int(round(trimmed.width * scale))),
        max(1, int(round(trimmed.height * scale))),
    )
    resized = trimmed.resize(resized_size, RESAMPLE) if resized_size != trimmed.size else trimmed
    record = save_png(resized, destination)
    verify_png(destination, expected_mode="RGBA")
    if record["size"][0] > 768:
        raise AssertionError("prop {} is wider than 768px".format(name))
    record.update(
        {
            "kind": "prop",
            "source": rel(source),
            "source_size": list(original_size),
            "alpha_bbox": list(bbox),
            "trimmed_size": list(trimmed.size),
            "resized_size": list(resized_size),
            "operation": "alpha_bbox_crop_then_proportional_resize_width_at_most_768",
        }
    )
    return record


def prepare_keyart(filename):
    source = IMAGES / filename
    destination = OUT / filename
    image = Image.open(str(source)).convert("RGB")
    record = save_png(image, destination)
    record.update(
        {
            "kind": "activity_card_keyart",
            "source": rel(source),
            "source_size": list(image.size),
            "operation": "lossless-dimension-preserving-PNG-reencode",
        }
    )
    return record


def prepare_audio():
    records = []
    for source in sorted(SFX_DIR.glob("*.ogg")):
        destination = OUT / "sfx" / source.name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(str(source), str(destination))
        if not destination.is_file() or destination.stat().st_size == 0:
            raise AssertionError("audio copy failed: {}".format(destination))
        records.append(
            {
                "kind": "sfx",
                "name": source.stem,
                "source": rel(source),
                "path": rel(destination),
                "bytes": destination.stat().st_size,
                "sha256": sha256(destination),
                "operation": "copy2-web-ogg",
            }
        )
    if not records:
        raise AssertionError("no SFX OGG files found in {}".format(SFX_DIR))
    for name, scene in (("island_mix.ogg", "island"), ("bridge_mix.ogg", "bridge")):
        source = MUSIC / scene / name
        destination = OUT / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(str(source), str(destination))
        if not destination.is_file() or destination.stat().st_size == 0:
            raise AssertionError("music copy failed: {}".format(destination))
        records.append(
            {
                "kind": "bgm_mix",
                "name": name,
                "source": rel(source),
                "path": rel(destination),
                "bytes": destination.stat().st_size,
                "sha256": sha256(destination),
                "operation": "copy2-web-ogg",
            }
        )
    return records


def prepare_mirrored_tile(name, source, crop, minimum_size, note):
    image = Image.open(str(source)).convert("RGBA")
    if not (0 <= crop[0] < crop[2] <= image.width and 0 <= crop[1] < crop[3] <= image.height):
        raise ValueError("{} crop {} is outside {}".format(name, crop, source))
    patch = image.crop(crop)
    mirrored = ImageOps.mirror(patch)
    tile = Image.new("RGBA", (patch.width + mirrored.width, patch.height), (0, 0, 0, 0))
    tile.alpha_composite(patch, (0, 0))
    tile.alpha_composite(mirrored, (patch.width, 0))
    destination = OUT / "{}.png".format(name)
    record = save_png(tile, destination)
    verify_png(destination, expected_mode="RGBA")
    if record["size"][0] < minimum_size[0] or record["size"][1] < minimum_size[1]:
        raise AssertionError("{} tile is smaller than {}".format(name, minimum_size))
    alpha = tile.getchannel("A")
    record.update(
        {
            "kind": "foothold_tile",
            "source": rel(source),
            "source_size": list(image.size),
            "crop": list(crop),
            "crop_size": list(patch.size),
            "operation": "crop_then_original_plus_horizontal_mirror",
            "minimum_size": list(minimum_size),
            "alpha_extrema": list(alpha.getextrema()),
            "note": note,
        }
    )
    return record


def prepare_backdrop(filename, spec):
    source = spec["source"]
    image = Image.open(str(source)).convert("RGB")
    crop = tuple(spec["crop"])
    if not (0 <= crop[0] < crop[2] <= image.width and 0 <= crop[1] < crop[3] <= image.height):
        raise ValueError("{} crop {} is outside {}".format(filename, crop, source))
    patch = image.crop(crop)
    backdrop = patch.resize((2600, 1350), RESAMPLE)
    if spec["blur_radius"]:
        backdrop = backdrop.filter(ImageFilter.GaussianBlur(spec["blur_radius"]))
    # Reduce saturation slightly so the static far layer does not compete with
    # the gameplay sprites and foothold strips placed above it.
    backdrop = ImageEnhance.Color(backdrop).enhance(0.92)
    destination = OUT / filename
    record = save_png(backdrop, destination)
    verify_png(destination, expected_size=(2600, 1350), expected_mode="RGB")
    record.update(
        {
            "kind": "static_far_backdrop",
            "source": rel(source),
            "source_size": list(image.size),
            "crop": list(crop),
            "crop_size": list(patch.size),
            "output_size": [2600, 1350],
            "blur_radius": spec["blur_radius"],
            "operation": "local_sky_remote_tree_crop_resize_then_soften",
            "note": spec["note"],
        }
    )
    return record


def prepare_optional_scene_asset(filename):
    """Copy an authored scene sprite/reference without inventing a fallback."""
    source = IMAGES / filename
    if not source.is_file():
        return None
    destination = OUT / filename
    shutil.copy2(str(source), str(destination))
    verify_png(destination)
    return {
        "kind": "scene_reference",
        "name": filename,
        "source": rel(source),
        "path": rel(destination),
        "bytes": destination.stat().st_size,
        "sha256": sha256(destination),
        "operation": "copy2-authored-scene-asset",
    }


def write_report(records, audio_records):
    report = {
        "schema": "windbell-runtime-assets/v1",
        "generated_by": rel(Path(__file__)),
        "source_policy": "original Windbell creative sources; deterministic local Pillow preparation; no model audio or copied MapleStory melody",
        "output_root": rel(OUT),
        "manifest_policy": "assets/manifest.json is intentionally untouched; root agent owns manifest versioning",
        "records": records + audio_records,
        "checks": {
            "npc_count": sum(1 for item in records if item.get("kind") == "npc"),
            "prop_count": sum(1 for item in records if item.get("kind") == "prop"),
            "keyart_count": sum(1 for item in records if item.get("kind") == "activity_card_keyart"),
            "backdrop_count": sum(1 for item in records if item.get("kind") == "static_far_backdrop"),
            "tile_count": sum(1 for item in records if item.get("kind") == "foothold_tile"),
            "sfx_count": sum(1 for item in audio_records if item.get("kind") == "sfx"),
            "bgm_mix_count": sum(1 for item in audio_records if item.get("kind") == "bgm_mix"),
            "all_outputs_readable": True,
        },
    }
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def prepare_models():
    """Publish self-contained Blender GLBs; fail before copying an invalid pair."""
    sources = ROOT / "resources" / "blender" / "windbell" / "glb"
    records = []
    for kind in ("island", "bridge"):
        source = sources / (kind + ".glb")
        data = source.read_bytes()
        magic, version, length = struct.unpack_from("<4sII", data)
        assert magic == b"glTF" and version == 2 and length == len(data), source
        size, chunk = struct.unpack_from("<II", data, 12)
        assert chunk == 0x4E4F534A, source
        document = json.loads(data[20:20 + size].decode("utf-8"))
        assert len(document.get("scenes", [])) == 1 and document.get("meshes"), source
        assert document.get("images") and all("bufferView" in image for image in document["images"]), source
        assert all("uri" not in buffer for buffer in document["buffers"]), source
        records.append({"source": rel(source), "path": rel(OUT / "models" / source.name), "sha256": sha256(source), "bytes": len(data)})
    (OUT / "models").mkdir(parents=True, exist_ok=True)
    for record in records:
        shutil.copy2(ROOT / record["source"], ROOT / record["path"])
    (OUT / "models" / "report.json").write_text(json.dumps({"models": records}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return records


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    records = []
    for name in NPC_NAMES:
        records.append(prepare_npc(name))
    for name in PROP_NAMES:
        records.append(prepare_prop(name))
    records.append(prepare_keyart("island-keyart.png"))
    records.append(prepare_keyart("bridge-dormant.png"))
    records.append(
        prepare_mirrored_tile(
            "wood",
            WOOD_SOURCE,
            WOOD_CROP,
            (256, 24),
            "clean horizontal materials plank face for a rotating Phaser foothold tile",
        )
    )
    records.append(
        prepare_mirrored_tile(
            "ground",
            GROUND_SOURCE,
            GROUND_CROP,
            (256, 60),
            "grass and pale dirt path edge; the upper edge remains the visible walkable surface",
        )
    )
    for filename, spec in BACKDROP_SPECS.items():
        records.append(prepare_backdrop(filename, spec))
    for filename in ("island-distant-background.png", "bridge-distant-background.png", "island-ancient-tree.png", "island-floating-ground.png"):
        record = prepare_optional_scene_asset(filename)
        if record:
            records.append(record)
    audio_records = prepare_audio()
    report = write_report(records, audio_records)

    # A final independent read pass catches a bad path or corrupt PNG before
    # the bundle is handed to the frontend agent.
    for item in records:
        path = ROOT / item["path"]
        if item["path"].endswith(".png"):
            verify_png(path)
        if not path.is_file() or path.stat().st_size == 0:
            raise AssertionError("runtime output is unreadable: {}".format(path))
    for item in audio_records:
        path = ROOT / item["path"]
        if not path.is_file() or path.stat().st_size == 0:
            raise AssertionError("runtime audio output is unreadable: {}".format(path))
    print(
        json.dumps(
            {
                "output_root": str(OUT),
                "report": str(REPORT_PATH),
                "png_outputs": len(records),
                "audio_outputs": len(audio_records),
                "checks": report["checks"],
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--models-only", action="store_true")
    if parser.parse_args().models_only:
        print(json.dumps(prepare_models(), ensure_ascii=False))
    else:
        main()
