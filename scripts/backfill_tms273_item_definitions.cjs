// Backfill the item-definition JSONs the assembled catalog needs but the local
// reference tree is missing.
//
// Why this exists
// ---------------
// `generate_tms273_gameplay.py` drops any item whose definition JSON is absent
// from `参考/.../TMS273/WZ_JSON_TW`, and then prunes every shop row and monster
// drop that referenced it (`shop["items"] = [item for item in shop["items"] if
// item["itemId"] in items]`).  A reference tree with holes therefore shrinks the
// runtime catalogue silently: the item disappears, then the shop row that sold
// it disappears, then `shared/notebook-catalog.json` keeps a reward that points
// at a definition nobody has.  Nothing in that chain raises.
//
// This is not hypothetical.  The local tree was bulk-filled from a sister
// extraction and later narrowed back to one file, and the ids the source still
// declares reachable came back as `sources.items[*].status == "json-missing"` —
// which is exactly the set this tool materialises.
//
// How a definition is located
// ---------------------------
// The generator finds an item's source by *file stem* (`build_source_index`
// rglobs `<volume>/**/*.json` and keys on the 8-digit name), so a definition in
// `Item/Consume/0204 2/02044012.json` is just as valid as one in
// `Item/Consume/0204/02044012.json` — and the split-client `… 2` sibling is
// where the local extractions actually keep a number of rows.  This tool
// therefore searches by stem, and writes each file at the path the assembled
// catalogue already records for that id (so `spriteSource` — which is derived
// from the stored path — does not move), falling back to the canonical path.
//
// Provenance, in order of preference:
//   1. `手工服务端/tms273/WZ_JSON_TW`  — an extraction of the same archive, same
//      typed shape, so the bytes are copied verbatim.  The item price/spec
//      backfills already treat this tree as the source for missing item data.
//   2. `.TheUnarchiverTemp0/tms273/WZ_JSON_TW` — the sister extraction.
//   3. The authoritative client WZ (`客户端/TMS273.7/Data`), re-encoded into the
//      typed shape.  Canvas nodes are dropped, never folded into a placeholder —
//      that is what the existing Item/Character JSONs look like, and dropping
//      them is what makes a re-encoded `info` compare equal to the recorded one.
//   4. The last committed `shared/items.json`.  Only reached for the Weapon
//      structural volumes the shipped WZ carries as bare canvases (01382000 and
//      its siblings have `info = [icon, iconRaw]` and no stat fields at all).
//      The committed `info`/`spec` are re-encoded to the typed shape; the value
//      is the one this repository already recorded, not an invented one.
//
// Anything no source can supply is *not* written.  It is listed in the manifest
// under `unresolved`, with its reason, so the gap stays visible instead of
// turning into a silently pruned shop row.
//
// Verification
// ------------
// Every written file is read back and run through the same unboxing rules the
// generator applies (`unwrap(info)` / `unwrap(spec)`); when the repository
// already records a definition for that id, the result must equal it.  A file
// that fails is deleted again and reported, so a bad write cannot pass as a fix.
//
// Usage:
//   node scripts/backfill_tms273_item_definitions.cjs --dry-run
//   node scripts/backfill_tms273_item_definitions.cjs
//   node scripts/backfill_tms273_item_definitions.cjs --strict   # fail on any gap
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');

const root = path.resolve(__dirname, '..');
const packageRoot = path.join(root, '参考/273/TMS273少爷一键端');
const DEP = path.join(packageRoot, 'TMS273/WZ_JSON_TW');
const SOURCES = [
  ['manual-extraction', path.join(packageRoot, '手工服务端/tms273/WZ_JSON_TW')],
  ['sister-extraction', path.join(packageRoot, '.TheUnarchiverTemp0/tms273/WZ_JSON_TW')],
];
const WZ_DATA = path.join(packageRoot, '客户端/TMS273.7/Data');
const LEDGER = path.join(root, 'resources/tms273-export/gameplay.json');
const MANIFEST = path.join(root, 'artifacts/tms273_item_definition_backfill.json');
const ITEM_CATEGORY = { 2: 'Consume', 3: 'Install', 4: 'Etc', 5: 'Cash' };

const dryRun = process.argv.includes('--dry-run');
const strict = process.argv.includes('--strict');

// --- the generator's own unboxing rules, mirrored ---------------------------
function unwrap(value) {
  if (Array.isArray(value)) return value.map(unwrap);
  if (value === null || typeof value !== 'object') return value;
  const kind = value._dirType;
  if (kind === 'vector' || ('_x' in value && '_y' in value)) {
    return { x: Number(value._x) || 0, y: Number(value._y) || 0 };
  }
  if ('_value' in value) {
    const raw = value._value;
    if (['int', 'short', 'long', 'uint', 'ushort', 'ulong'].includes(kind)) return Number(raw);
    if (['float', 'double'].includes(kind)) return Number(raw);
    return raw;
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) if (key !== '_dirType') out[key] = unwrap(item);
  return out;
}
const stable = value => JSON.stringify(value, Object.keys(value ?? {}).sort());

// --- typed re-encoding, matching how the tree stores scalars ----------------
// `spec` is not always flat: pet-food rows are numeric-keyed records
// (`{0: 7465, 1: 40, ...}`), which the source stores as a nested `sub` node.
function encode(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return { _dirType: 'string', _value: value };
  if (typeof value === 'boolean') return { _dirType: 'int', _value: value ? '1' : '0' };
  if (typeof value === 'number') {
    assert(Number.isFinite(value), `non-finite scalar: ${value}`);
    return { _dirType: Number.isInteger(value) ? 'int' : 'float', _value: String(value) };
  }
  if (typeof value === 'object') {
    const node = { _dirType: 'sub' };
    const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);
    for (const [key, item] of entries) {
      const encoded = encode(item);
      if (encoded !== null) node[key] = encoded;
    }
    return node;
  }
  throw new Error(`cannot re-encode scalar of type ${typeof value}: ${JSON.stringify(value)}`);
}
function encodeNode(record) {
  const node = { _dirType: 'sub' };
  for (const [key, value] of Object.entries(record ?? {})) {
    const encoded = encode(value);
    if (encoded !== null) node[key] = encoded;
  }
  return node;
}

// --- WZ -> typed JSON (canvas/null children dropped, as Item/Character do) ---
function fromWz(property) {
  const children = [...(property.wzProperties ?? [])];
  if (property instanceof wz.WzSubProperty || property instanceof wz.WzConvexProperty) {
    const node = { _dirType: property instanceof wz.WzConvexProperty ? 'convex' : 'sub' };
    for (const child of children) {
      const value = fromWz(child);
      if (value !== null) node[child.name] = value;
    }
    return node;
  }
  if (property instanceof wz.WzVectorProperty) {
    const value = property.value;
    const x = value && Number.isFinite(value.x) ? value.x : property.x?.val;
    const y = value && Number.isFinite(value.y) ? value.y : property.y?.val;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { _dirType: 'vector', _x: x, _y: y };
  }
  if (property instanceof wz.WzCanvasProperty || property instanceof wz.WzNullProperty) return null;
  if (property instanceof wz.WzUOLProperty) return { _dirType: 'uol', _value: String(property.value ?? '') };
  if (property instanceof wz.WzStringProperty) return { _dirType: 'string', _value: String(property.value ?? '') };
  if (property instanceof wz.WzIntProperty) return { _dirType: 'int', _value: String(property.value) };
  if (property instanceof wz.WzShortProperty) return { _dirType: 'short', _value: String(property.value) };
  if (property instanceof wz.WzLongProperty) return { _dirType: 'long', _value: String(property.value) };
  if (property instanceof wz.WzFloatProperty) return { _dirType: 'float', _value: String(property.value) };
  if (property instanceof wz.WzDoubleProperty) return { _dirType: 'double', _value: String(property.value) };
  throw new Error(`unsupported WZ property for typed JSON: ${property.propertyType} ${property.fullPath}`);
}
const hasScalars = node => Boolean(node) && Object.keys(node).some(key => key !== '_dirType');

// --- helpers ---------------------------------------------------------------
function canonicalPath(id) {
  const pad = id.padStart(8, '0');
  const group = Math.floor(Number(id) / 1_000_000);
  if (group === 1) return null;                       // category comes from the source
  const category = ITEM_CATEGORY[group];
  return category ? `Item/${category}/${pad.slice(0, 4)}/${pad}.json` : null;
}
// `build_source_index` semantics: stem-keyed, recursive, first path in sort order.
function buildIndex(base) {
  const index = new Map();
  if (!fs.existsSync(base)) return index;
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /^\d+\.json$/.test(entry.name)) {
        const stem = entry.name.replace(/\.json$/, '');
        const list = index.get(stem) ?? [];
        list.push(full);
        index.set(stem, list);
      }
    }
  };
  walk(base);
  for (const [stem, list] of index) index.set(stem, list.sort());
  return index;
}

function main() {
  const ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8')).sources.items;
  const declared = Object.keys(ledger).sort((a, b) => Number(a) - Number(b));

  // The last committed catalogue is both the record of which path each id lives
  // at and the only remaining copy of the Weapon volumes that ship as bare
  // canvases.  A missing entry is normal — most ids do not need it.
  let committed = {};
  try {
    committed = JSON.parse(execFileSync('git', ['show', 'HEAD:shared/items.json'], { cwd: root, maxBuffer: 1 << 28 }).toString());
  } catch { /* git unavailable: the recorded fallback is simply not offered */ }
  const record = id => {
    const entry = committed[id] ?? committed[id.padStart(8, '0')];
    return entry && entry.source ? entry : null;
  };

  // One combined stem index per source tree, restricted to the volume the id
  // belongs to (group 1 is Character, everything else Item) so a Face/NPC id
  // cannot collide with an item id.
  const volumeIndex = new Map();
  const lookup = (base, volume, pad) => {
    const key = `${base}\0${volume}`;
    if (!volumeIndex.has(key)) volumeIndex.set(key, buildIndex(path.join(base, volume)));
    return (volumeIndex.get(key).get(pad) ?? [])[0] ?? null;
  };

  const reader = createReader(WZ_DATA, path.join(root, 'resources/tms273-export/ms'));
  const written = [];
  const unresolved = [];

  const choose = async id => {
    const pad = id.padStart(8, '0');
    const rec = record(id);
    const volume = Math.floor(Number(id) / 1_000_000) === 1 ? 'Character' : 'Item';
    let relative = rec?.source ?? canonicalPath(id);
    // An equipment id with no recorded entry still has a category, and the
    // category is what `source_node` turns into the icon path — so it has to be
    // resolved from the WZ itself rather than guessed.
    if (!relative && volume === 'Character') {
      const base = path.join(DEP, 'Character');
      if (fs.existsSync(base)) {
        for (const category of fs.readdirSync(base)) {
          try {
            const node = await reader.get(`Character/${category}/${pad}.img`);
            if (typeof node.parseImage === 'function' && !node.parsed) await node.parseImage();
            relative = `Character/${category}/${pad}.json`;
            break;
          } catch { /* not in this category */ }
        }
      }
      if (!relative) return null;
    }
    if (!relative) return null;
    // 1/2 — verbatim copy out of an extraction of the same archive.
    for (const [provenance, base] of SOURCES) {
      const file = lookup(base, volume, pad);
      if (file) return { relative, provenance, read: () => fs.readFileSync(file, 'utf8') };
    }
    // 3 — re-encode the authoritative client WZ.  The stored path is honoured
    // first (it may be a `… 2` split sibling) before the canonical image name.
    const parts = relative.split('/');
    const images = volume === 'Character'
      ? [`Character/${parts[1]}/${pad}.img`]
      : [`Item/${parts[1]}/${parts[2]}.img/${pad}`, `Item/${parts[1]}/${pad.slice(0, 4)}.img/${pad}`];
    for (const image of images) {
      try {
        const node = await reader.get(image);
        if (typeof node.parseImage === 'function' && !node.parsed) await node.parseImage();
        const tree = {};
        for (const child of [...node.wzProperties]) {
          const value = fromWz(child);
          if (value !== null) tree[child.name] = value;
        }
        if (hasScalars(tree.info) || hasScalars(tree.spec)) {
          return { relative, provenance: 'client-wz', read: () => JSON.stringify(tree) + '\n' };
        }
      } catch { /* try the next image name shape */ }
    }
    // 4 — the definition this repository already recorded.
    if (rec && (Object.keys(rec.info ?? {}).length || Object.keys(rec.spec ?? {}).length)) {
      const tree = {};
      if (Object.keys(rec.info ?? {}).length) tree.info = encodeNode(rec.info);
      if (Object.keys(rec.spec ?? {}).length) tree.spec = encodeNode(rec.spec);
      return { relative: rec.source, provenance: 'recorded-catalogue', read: () => JSON.stringify(tree) + '\n' };
    }
    return null;
  };

  return (async () => {
    const targets = [];
    for (const id of declared) {
      if (ledger[id].status !== 'json-missing') continue;
      const relative = record(id)?.source ?? canonicalPath(id);
      if (relative && fs.existsSync(path.join(DEP, relative))) continue;
      targets.push(id);
    }
    for (const id of targets) {
      const plan = await choose(id);
      if (!plan) {
        unresolved.push({ id, source: record(id)?.source ?? canonicalPath(id), reason: 'no available tree, WZ image or recorded entry carries a definition' });
        continue;
      }
      const destination = path.join(DEP, plan.relative);
      const text = plan.read();
      const parsed = JSON.parse(text);
      const info = unwrap(parsed.info ?? {});
      const spec = unwrap(parsed.spec ?? {});
      if (!Object.keys(info).length && !Object.keys(spec).length) {
        unresolved.push({ id, source: plan.relative, provenance: plan.provenance, reason: 'resolved node carries no info/spec scalar' });
        continue;
      }
      const expected = record(id);
      if (expected) {
        assert.equal(stable(info), stable(expected.info ?? {}), `${id}: info does not match the recorded definition`);
        assert.equal(stable(spec), stable(expected.spec ?? {}), `${id}: spec does not match the recorded definition`);
      }
      const entry = { id, path: plan.relative, provenance: plan.provenance, sha256: crypto.createHash('sha256').update(text).digest('hex') };
      if (!dryRun) {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, text, 'utf8');
        try {
          const reread = JSON.parse(fs.readFileSync(destination, 'utf8'));
          assert.equal(stable(unwrap(reread.info ?? {})), stable(info), `${id}: info changed on write`);
          assert.equal(stable(unwrap(reread.spec ?? {})), stable(spec), `${id}: spec changed on write`);
        } catch (error) {
          fs.rmSync(destination, { force: true });
          unresolved.push({ id, source: plan.relative, provenance: plan.provenance, reason: `verification failed, file removed: ${error.message}` });
          continue;
        }
      }
      written.push(entry);
    }

    const byProvenance = {};
    for (const entry of written) byProvenance[entry.provenance] = (byProvenance[entry.provenance] ?? 0) + 1;
    const report = {
      generatedFrom: 'resources/tms273-export/gameplay.json sources.items ledger (the source-declared reachable set)',
      targetTree: path.relative(root, DEP),
      declared: declared.length,
      jsonMissing: declared.filter(id => ledger[id].status === 'json-missing').length,
      targets: targets.length,
      written: written.length,
      byProvenance,
      unresolved,
      files: written,
    };
    if (!dryRun) fs.writeFileSync(MANIFEST, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(
      `273 item definitions: 声明可达 ${declared.length}；台账缺失 ${report.jsonMissing}；本轮目标 ${targets.length}；` +
      `可补 ${written.length}（${Object.entries(byProvenance).map(([k, v]) => `${k}=${v}`).join(' ') || '无'}）；` +
      `无源可补 ${unresolved.length}${dryRun ? '（dry-run，未落盘）' : ''}`
    );
    for (const item of unresolved) console.log(`  unresolved ${item.id}: ${item.reason}  <- ${item.source}`);
    if (strict && unresolved.length) {
      throw new Error(`${unresolved.length} declared ids have no source; 清单见 ${path.relative(root, MANIFEST)}`);
    }
  })().finally(() => reader.close());
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
