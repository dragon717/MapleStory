# GMS83 browser asset probe

The probe ran at `http://127.0.0.1:8765/index.html` in a headed Chromium session through the Playwright CLI skill. The page loads the exported PNGs and source-derived JSON, then composites the avatar parts in native Canvas. It exposes action selection, play/pause, single-frame stepping, whole-container left/right mirroring, and foothold visibility.

The selected real map is `Map.wz/Map/Map0/000010000.img` (Mushroom Village). Its source bounds are `x=-315..1390`, `y=-480..750`; the exported map contains 6 Back layers, 265 tile placements, 27 object placements, and 83 footholds. Spawn A is `(630,365)` on foothold `20`, and spawn B is `(1050,365)` on foothold `40`. Map layer `x/y` values in `manifest.json` and `map.json` are world top-left coordinates (`map position - Canvas origin`); the original position and origin remain in metadata.

The avatar look uses the real v83 paths `00002000.img`, `00012000.img`, Face `00020000`, Hair `00030020`, Cap `01000001`, Coat `01040002`, Pants `01060003`, Shoes `01070000`, and one-hand sword `Weapon/01302029.img`. Public actions are direct frame arrays: `stand -> stand1` (3 × 500ms), `walk -> walk1` (4 × 180ms), `jump -> jump` (1 × 200ms), and `attack -> swingO1` (3 frames, 300/150/350ms). Every frame carries part URLs plus source `origin`, named `map` anchors, z-map index/name, UOL source where present, and PNG SHA-256/decode evidence. Body positions are calculated from `targetAnchor - ownAnchor - origin`; no artwork-specific offset patch is used.

Cap visibility follows source slot metadata: `Cap/01000001.img/info` has `islot=Cp` and `vslot=CpH1H5`; `Base/smap.img` maps `hairOverHead` to `H1`, so each frame records and filters that covered hair layer in `filteredParts`, while retaining `hair=H2`, `hairShade=Hs`, and `hairBelowBody=Hb`. This is a representative vslot rule for this cap/look, not a claim that every equip combination is covered.

The browser capture shows the assembled two-instance look on the real map, the green source foothold overlay, attack frame timing text, and the mirrored right-facing state:

![stand composite](browser-asset-probe/stand.png)

![attack mirrored](browser-asset-probe/attack-flipped.png)

[12-second action capture](browser-asset-probe/actions-short.webm) · [browser metadata](browser-asset-probe/browser-metadata.json) · [video metadata](browser-asset-probe/video-metadata.json)

The source export is reproducible with `node references/browser-probe/export-assets.cjs`. It produced 125 unique PNG assets after the face leaf was included and the metadata-selected H1 hair layer was filtered. The remaining scope is intentionally limited to this one look/map and selected map placements; it does not claim full WZ wardrobe, all maps, gameplay, networking, login, or party support.
