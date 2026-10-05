#!/usr/bin/env python3
"""Build the procedural finish textures used by the sky-voyage materials.

Every pattern is made from periodic functions, so the last pixel joins the
first pixel on both axes.  The script deliberately uses only Pillow and
numpy: it produces image assets and does not depend on, or modify, Blender.

The physical spans printed by the command are the expected UV contract for
the current voyage material pass.  This script does not assign UVs or change
material nodes.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image


SIZE = 1024
PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_OUTPUT_DIR = PROJECT_ROOT / "resources/scenes/sky-voyage-v3/textures"

# These are integration expectations, not values written into the PNG files.
# The current ship pass uses approximately these tile spans for the matching
# material families.  The parent material pass remains free to choose another
# span for a particular mesh.
EXPECTED_SPANS_METRES = {
    "finish-honey-teak": 3.0,
    "finish-walnut": 7.0,
    "finish-ivory-linen": 0.7,
    "finish-enamel-panels": 2.0,
}


def _grid(size: int = SIZE) -> tuple[np.ndarray, np.ndarray]:
    axis = np.arange(size, dtype=np.float32) / float(size)
    return np.meshgrid(axis, axis, indexing="xy")


def _periodic_waves(
    x: np.ndarray,
    y: np.ndarray,
    seed: int,
    components: int,
    x_frequency: tuple[int, int],
    y_frequency: tuple[int, int],
) -> np.ndarray:
    """Return deterministic, tileable low-amplitude wave noise.

    Integer cycles on the unit square make both image boundaries agree.  The
    deliberately different frequency ranges make the wood directional rather
    than turning into a cloud of random blobs.
    """

    rng = np.random.default_rng(seed)
    result = np.zeros_like(x, dtype=np.float32)
    amplitude_total = 0.0
    for _ in range(components):
        fx = int(rng.integers(x_frequency[0], x_frequency[1] + 1))
        fy = int(rng.integers(y_frequency[0], y_frequency[1] + 1))
        amplitude = float(rng.uniform(0.25, 1.0))
        phase = float(rng.uniform(0.0, 2.0 * np.pi))
        result += amplitude * np.sin(2.0 * np.pi * (fx * x + fy * y) + phase)
        amplitude_total += amplitude
    return result / max(amplitude_total, 1e-6)


def _periodic_distance(axis: np.ndarray, point: float) -> np.ndarray:
    distance = np.abs(axis - point)
    return np.minimum(distance, 1.0 - distance)


def _grid_seam(axis: np.ndarray, divisions: int, width_pixels: float) -> np.ndarray:
    phase = (axis * divisions) % 1.0
    distance_pixels = np.minimum(phase, 1.0 - phase) * SIZE
    return np.exp(-np.square(distance_pixels / width_pixels)).astype(np.float32)


def _normal_from_height(height: np.ndarray, strength: float) -> np.ndarray:
    """Encode a wrapped height field as a restrained tangent-space normal map."""

    dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * 0.5
    dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * 0.5
    normal = np.stack((-dx * strength, -dy * strength, np.ones_like(height)), axis=-1)
    normal /= np.linalg.norm(normal, axis=-1, keepdims=True)
    return np.rint((normal * 0.5 + 0.5) * 255.0).clip(0, 255).astype(np.uint8)


def _rgb(values: np.ndarray) -> np.ndarray:
    return np.rint(np.clip(values, 0.0, 255.0)).astype(np.uint8)


def _gray(values: np.ndarray) -> np.ndarray:
    return np.rint(np.clip(values, 0.0, 255.0)).astype(np.uint8)


def _seal_edges(values: np.ndarray) -> np.ndarray:
    """Make the sampled border pixels agree before PNG quantisation.

    The board and panel rows intentionally meet at dark seams, but their
    low-contrast per-row colour offsets are allowed to differ internally.
    Averaging only the one-pixel border preserves that authored seam while
    guaranteeing a true pixel-periodic tile at either repeat boundary.
    """

    sealed = np.array(values, copy=True)
    if sealed.ndim == 2:
        top_bottom = (sealed[0, :].astype(np.float32) + sealed[-1, :].astype(np.float32)) * 0.5
        sealed[0, :] = top_bottom
        sealed[-1, :] = top_bottom
        left_right = (sealed[:, 0].astype(np.float32) + sealed[:, -1].astype(np.float32)) * 0.5
        sealed[:, 0] = left_right
        sealed[:, -1] = left_right
    else:
        top_bottom = (sealed[0, :, :].astype(np.float32) + sealed[-1, :, :].astype(np.float32)) * 0.5
        sealed[0, :, :] = top_bottom
        sealed[-1, :, :] = top_bottom
        left_right = (sealed[:, 0, :].astype(np.float32) + sealed[:, -1, :].astype(np.float32)) * 0.5
        sealed[:, 0, :] = left_right
        sealed[:, -1, :] = left_right
    return sealed


def _save_rgb(path: Path, values: np.ndarray) -> None:
    Image.fromarray(_rgb(values), mode="RGB").save(path)


def _save_gray(path: Path, values: np.ndarray) -> None:
    Image.fromarray(_gray(values), mode="L").save(path)


def _honey_teak() -> dict[str, np.ndarray]:
    """Muted honey teak: eight horizontal boards with staggered end joints."""

    x, y = _grid()
    rows = np.floor(y * 8.0).astype(np.int8)

    broad = _periodic_waves(x, y, 1201, 28, (1, 5), (18, 120))
    fine = _periodic_waves(x, y, 1202, 22, (1, 8), (90, 300))
    grain = 0.72 * broad + 0.28 * fine

    # Keep the palette honey-warm without the red/orange cast of the old
    # image.  Small row offsets give the boards a crafted, low-contrast
    # difference while keeping the material calm under scene lighting.
    base = np.array([139.0, 115.0, 88.0], dtype=np.float32)
    grain_tint = np.array([10.0, 8.0, 6.0], dtype=np.float32)
    row_offsets = np.array([-1.5, 1.0, 0.0, 2.0, -2.0, 1.5, -0.5, 1.0], dtype=np.float32)
    surface = base + grain[..., None] * grain_tint + row_offsets[rows][..., None]

    horizontal_seams = _grid_seam(y, 8, width_pixels=1.35)
    # Two narrow end joints per board.  Alternating their positions makes
    # adjacent courses staggered, while all coordinates remain tileable.
    joint_positions = (
        (0.22, 0.69),
        (0.45, 0.88),
        (0.28, 0.76),
        (0.52, 0.93),
        (0.18, 0.64),
        (0.41, 0.82),
        (0.31, 0.73),
        (0.56, 0.91),
    )
    vertical_joints = np.zeros_like(x, dtype=np.float32)
    for row, positions in enumerate(joint_positions):
        row_mask = rows == row
        for position in positions:
            distance = _periodic_distance(x, position)
            line = np.exp(-np.square(distance * SIZE / 1.20)).astype(np.float32)
            vertical_joints = np.maximum(vertical_joints, line * row_mask)

    seam = np.clip(0.88 * horizontal_seams + 0.74 * vertical_joints, 0.0, 1.0)
    seam_colour = np.array([69.0, 60.0, 51.0], dtype=np.float32)
    seam_mix = (0.47 * seam)[..., None]
    surface = surface * (1.0 - seam_mix) + seam_colour * seam_mix

    height = 0.20 * grain + 0.44 * horizontal_seams + 0.38 * vertical_joints
    normal = _normal_from_height(height, strength=1.25)
    roughness = 184.0 + 7.0 * grain + 17.0 * seam

    return {
        "finish-honey-teak-basecolor.png": _rgb(surface),
        "finish-honey-teak-normal.png": normal,
        "finish-honey-teak-roughness.png": _gray(roughness),
    }


def _walnut() -> dict[str, np.ndarray]:
    """Quiet walnut grain for spars, running left-to-right with no board seams."""

    x, y = _grid()
    long_grain = _periodic_waves(x, y, 2301, 42, (1, 4), (24, 170))
    fine_grain = _periodic_waves(x, y, 2302, 18, (2, 8), (110, 340))
    grain = 0.78 * long_grain + 0.22 * fine_grain

    base = np.array([96.0, 75.0, 58.0], dtype=np.float32)
    surface = base + grain[..., None] * np.array([9.0, 7.0, 5.0], dtype=np.float32)
    surface += fine_grain[..., None] * np.array([1.6, 1.2, 0.8], dtype=np.float32)

    # There is no seam, knot, block, or panel break in this map: the normal
    # only follows the fine longitudinal grain.
    height = 0.25 * grain + 0.08 * fine_grain
    normal = _normal_from_height(height, strength=0.90)
    roughness = 179.0 + 6.0 * grain + 2.0 * fine_grain

    return {
        "finish-walnut-basecolor.png": _rgb(surface),
        "finish-walnut-normal.png": normal,
        "finish-walnut-roughness.png": _gray(roughness),
    }


def _ivory_linen() -> dict[str, np.ndarray]:
    """Low-contrast plain weave made from straight crossing threads."""

    x, y = _grid()
    warp = _periodic_waves(x, y, 3401, 8, (1, 3), (5, 18))
    weft = _periodic_waves(x, y, 3402, 8, (5, 18), (1, 3))

    # Straight, tightly spaced threads keep the weave legible without forming
    # the circular/scale shapes in the previous linen image.
    vertical_threads = np.sin(2.0 * np.pi * (x * 128.0 + 0.030 * warp))
    horizontal_threads = np.sin(2.0 * np.pi * (y * 128.0 + 0.030 * weft))
    plain_weave = 0.52 * vertical_threads + 0.48 * horizontal_threads
    surface = np.array([218.0, 211.0, 193.0], dtype=np.float32)
    surface = surface + plain_weave[..., None] * np.array([2.3, 2.1, 1.8], dtype=np.float32)

    height = 0.16 * plain_weave
    normal = _normal_from_height(height, strength=0.72)
    roughness = 236.0 + 1.8 * plain_weave

    return {
        "finish-ivory-linen-basecolor.png": _rgb(surface),
        "finish-ivory-linen-normal.png": normal,
        "finish-ivory-linen-roughness.png": _gray(roughness),
    }


def _enamel_panels() -> dict[str, np.ndarray]:
    """Warm ivory enamel in a 4x4 panel tile with restrained brass details."""

    x, y = _grid()
    panel_x = np.floor(x * 4.0).astype(np.int8)
    panel_y = np.floor(y * 4.0).astype(np.int8)
    panel_index = panel_y * 4 + panel_x

    # Tiny block-to-block differences read as painted panels, without adding
    # a photographic light gradient or dirty contrast.
    panel_offsets = np.array(
        [-1.5, 1.0, 0.0, 1.5, 1.0, -0.5, 1.5, -1.0,
         0.0, 1.0, -1.5, 0.5, 1.5, -1.0, 0.5, -0.5],
        dtype=np.float32,
    )
    low_variation = _periodic_waves(x, y, 4501, 12, (1, 5), (1, 5))
    surface = np.array([220.0, 212.0, 191.0], dtype=np.float32)
    surface = surface + panel_offsets[panel_index][..., None]
    surface += low_variation[..., None] * np.array([1.2, 1.0, 0.8], dtype=np.float32)

    horizontal_seams = _grid_seam(y, 4, width_pixels=1.25)
    vertical_seams = _grid_seam(x, 4, width_pixels=1.25)
    seam = np.clip(0.82 * horizontal_seams + 0.82 * vertical_seams, 0.0, 1.0)
    seam_colour = np.array([143.0, 124.0, 91.0], dtype=np.float32)
    seam_mix = (0.32 * seam)[..., None]
    surface = surface * (1.0 - seam_mix) + seam_colour * seam_mix

    # Sparse, small rivets are kept away from the tile boundary so repeated
    # tiles never expose a clipped dot.  Their coordinates still repeat
    # periodically with the rest of the material.
    rivet_points = (
        (0.12, 0.15), (0.39, 0.64), (0.63, 0.22), (0.87, 0.78),
        (0.18, 0.84), (0.72, 0.55), (0.47, 0.36), (0.91, 0.31),
    )
    rivets = np.zeros_like(x, dtype=np.float32)
    for point_x, point_y in rivet_points:
        dx = _periodic_distance(x, point_x)
        dy = _periodic_distance(y, point_y)
        distance = np.sqrt(np.square(dx * SIZE) + np.square(dy * SIZE))
        rivets = np.maximum(rivets, np.exp(-np.square(distance / 3.2)).astype(np.float32))
    rivet_colour = np.array([125.0, 96.0, 50.0], dtype=np.float32)
    rivet_mix = (0.56 * rivets)[..., None]
    surface = surface * (1.0 - rivet_mix) + rivet_colour * rivet_mix

    height = 0.50 * seam + 0.48 * rivets
    normal = _normal_from_height(height, strength=0.88)
    roughness = 151.0 + 6.0 * low_variation + 13.0 * seam - 22.0 * rivets

    return {
        "finish-enamel-panels-basecolor.png": _rgb(surface),
        "finish-enamel-panels-normal.png": normal,
        "finish-enamel-panels-roughness.png": _gray(roughness),
    }


def _stern_fascia() -> dict[str, np.ndarray]:
    """A continuous UV painting for the three retained curved stern galleries.

    U wraps around the measured elliptical stern; V covers native Z -10..20.
    Painting across triangle borders avoids the old face-centre serration.
    """
    u, v = _grid(); theta=(u-.5)*2*np.pi
    source_y=-51-16.5*np.cos(theta)
    z=(1-v)*30-10-.0025*(source_y+55)**2
    wood=np.array([.39,.29,.19],dtype=np.float32)
    ivory=np.array([.88,.854,.776],dtype=np.float32)
    brass=np.array([.78,.60,.27],dtype=np.float32)
    teal=np.array([.075,.42,.415],dtype=np.float32)
    grain=_periodic_waves(u,v,731,9,(0,3),(45,110))*.012
    color=np.broadcast_to(wood,(*u.shape,3)).copy()+grain[...,None]
    rough=np.full_like(u,.76);metal=np.zeros_like(u)
    for bottom,top in [(-7.8,-3.5),(.7,3.25),(9.05,13.7)]:
        panel=(z>=bottom)&(z<=top)
        rim=panel&((z-bottom<.22)|(top-z<.22))
        inlay=panel&(z-bottom>=.22)&(z-bottom<.88)
        color[panel]=ivory;rough[panel]=.54
        color[inlay]=teal;rough[inlay]=.47
        color[rim]=brass;rough[rim]=.37;metal[rim]=.72
    flat=np.zeros((*u.shape,3),dtype=np.float32);flat[:]=[.5,.5,1]
    return {'finish-stern-fascia-basecolor.png':color.clip(0,1)*255,
            'finish-stern-fascia-normal.png':flat*255,
            'finish-stern-fascia-roughness.png':rough*255,
            'finish-stern-fascia-metallic.png':metal*255}


def _stern_crown() -> dict[str, np.ndarray]:
    # Continuous outer return on the retained curved platform. The interior
    # remains timber; only the perimeter receives the prototype's pale trim.
    u,v=np.meshgrid(np.arange(SIZE)/SIZE,np.arange(SIZE)/SIZE)
    radius=v*1.4
    color=np.zeros((*u.shape,3),dtype=np.float32);color[:]=[.39,.26,.15]
    rough=np.full(u.shape,.76,dtype=np.float32);metal=np.zeros(u.shape,dtype=np.float32)
    ivory=(radius>=.78)&(radius<.96);teal=(radius>=.90)&(radius<.94)
    gold=(radius>=.96)&(radius<1.12)
    color[ivory]=[.90,.87,.76];rough[ivory]=.54
    color[teal]=[.03,.39,.35];rough[teal]=.47
    color[gold]=[.76,.54,.19];rough[gold]=.37;metal[gold]=.72
    normal=np.zeros_like(color);normal[:]=[.5,.5,1]
    return {'finish-stern-crown-basecolor.png':color*255,'finish-stern-crown-normal.png':normal*255,
            'finish-stern-crown-roughness.png':rough*255,'finish-stern-crown-metallic.png':metal*255}


def _write_assets(output_dir: Path) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    assets: dict[str, np.ndarray] = {}
    for builder in (_honey_teak, _walnut, _ivory_linen, _enamel_panels, _stern_fascia, _stern_crown):
        assets.update(builder())

    generated: list[Path] = []
    for name, values in assets.items():
        path = output_dir / name
        if not name.startswith("finish-"):
            raise ValueError(f"refusing to write a non-finish asset: {name}")
        if values.shape[:2] != (SIZE, SIZE):
            raise ValueError(f"{name} has unexpected shape {values.shape}")
        values = _seal_edges(values)
        if name.endswith("-normal.png") or name.endswith("-basecolor.png"):
            if values.ndim != 3 or values.shape[2] != 3:
                raise ValueError(f"{name} must be RGB")
            _save_rgb(path, values)
        else:
            if values.ndim != 2:
                raise ValueError(f"{name} must be grayscale")
            _save_gray(path, values)
        generated.append(path)
    return generated


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help="directory for new finish-* PNGs (default: voyage-v3 textures)",
    )
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    output_dir = args.output_dir.expanduser().resolve()
    generated = _write_assets(output_dir)
    print(f"Generated {len(generated)} seamless {SIZE}x{SIZE} finish maps in {output_dir}")
    for path in generated:
        print(f"  {path.name}")
    print("Tile contract:")
    print("  finish-honey-teak: 8 horizontal boards/tile; grain and board ends run left-to-right.")
    print("  finish-walnut: longitudinal grain runs left-to-right; no board seams.")
    print("  finish-ivory-linen: fine straight warp/weft plain weave; no scale motifs.")
    print("  finish-enamel-panels: 4x4 equal panels/tile (256px each; ≈0.5m each under 2m/tile); seams run horizontally and vertically.")
    for name, metres in EXPECTED_SPANS_METRES.items():
        print(f"  {name}: expected one tile span ≈ {metres:g} m under current UV family.")
    print("No UVs, Blender data, legacy PNGs, models, shaders, versions, or documents were changed.")


if __name__ == "__main__":
    main()
