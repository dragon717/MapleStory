#!/usr/bin/env node

// Export the TMS273 map reactors (Reactor.wz) that the 41 assembled maps place.
//
// A reactor is the original "interactive map prop": a flower you can shake for
// an item, a herb patch, a quest container.  Unlike a background object it has
// authoritative server state — every hit advances it one state, and the last
// state is empty (gone) until the authored `reactorTime` expires.
//
// Source shapes (verified against Reactor.wz on the local TMS273.7 client):
//   Reactor/<id>.img
//     action:  string  — server script name (e.g. vFlowerItem0).  U: no
//              matching script ships in this reference server, so the runtime
//              does not execute it; it is retained for source tracing only.
//     <state>/0..n      — idle animation frames for that state
//     <state>/hit/0..n  — one-shot impact animation played on a hit
//     <state>/event/0/type    — 0 = normal attack hit, 9 = click/hit area
//     <state>/event/0/state   — the state this event advances to
//     <state>/event/0/lt|rb   — interaction box for type 9 (character-local)
//     <state>/repeat    — 1 when the idle animation loops
//
// Placements come from `references/tms273-data/maps.json` (Map.wz life/reactor
// subtree) so the server and the client share one authored coordinate set.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const OUTPUT = path.join(ROOT, 'resources/tms273-export');
const ASSETS = path.join(OUTPUT, 'assets/tms273');
const MAPS = path.join(ROOT, 'references/tms273-data/maps.json');

const reader = createReader(DATA);

function resolved(node) {
  const seen = new Set();
  let current = node;
  while (current instanceof wz.WzUOLProperty) {
    assert(!seen.has(current), 'UOL cycle');
    seen.add(current);
    current = current.linkValue;
  }
  return current;
}

async function get(source) {
  try {
    const node = await reader.get(source);
    if (node instanceof wz.WzImage) assert(await node.parseImage(), source);
    return node;
  } catch (error) {
    throw new Error(`${source}: ${error.message}`, { cause: error });
  }
}

const numeric = node => [...(node?.wzProperties ?? [])]
  .filter(child => /^\d+$/.test(child.name))
  .sort((a, b) => Number(a.name) - Number(b.name));

function scalar(node, name, fallback = null) {
  const child = node?.at?.(name);
  if (!child || child.wzProperties) return fallback;
  const value = child.wzValue;
  return typeof value === 'bigint' ? Number(value) : value;
}

function point(node, name) {
  const value = node?.at?.(name)?.wzValue;
  if (!value || !Number.isFinite(Number(value.x)) || !Number.isFinite(Number(value.y))) return null;
  return { x: Number(value.x), y: Number(value.y) };
}

/** Drop the 1×1 transparent placeholder the source uses for the "gone" state. */
function isBlank(frame) {
  return frame.width <= 1 && frame.height <= 1;
}

async function stateFrames(artId, state, kind) {
  const suffix = kind ? `/${kind}` : '';
  const source = `Reactor/${artId}.img/${state}${suffix}`;
  let node;
  try {
    node = resolved(await get(source));
  } catch {
    // Most states only forward their art through `0` or `hit` UOLs; a missing
    // subtree simply means "no frames of this kind here".
    return [];
  }
  if (node instanceof wz.WzCanvasProperty) {
    const frame = await reader.frame(source, ASSETS);
    return isBlank(frame) ? [] : [{ ...frame, url: `/assets/tms273/${frame.url}` }];
  }
  const frames = [];
  for (const child of numeric(node)) {
    const frame = await reader.frame(`${source}/${child.name}`, ASSETS);
    if (isBlank(frame)) continue;
    frames.push({ ...frame, url: `/assets/tms273/${frame.url}` });
  }
  return frames;
}

/**
 * Reactor templates may be aliases: `9102001` has no states of its own and
 * points at `9102000` through `info.link`.  Resolve that indirection once so a
 * placement always ends up with real art instead of an empty template.
 */
async function templateRoot(templateId, seen = new Set()) {
  assert(!seen.has(templateId), `Reactor link cycle at ${templateId}`);
  seen.add(templateId);
  const root = await get(`Reactor/${templateId}.img`);
  const link = scalar(root.at('info'), 'link');
  if (link && link !== templateId) return templateRoot(String(link), seen);
  return { root, artId: templateId };
}

async function exportTemplate(templateId) {
  const { root, artId } = await templateRoot(templateId);
  const states = {};
  for (const child of [...(root.wzProperties ?? [])].sort((a, b) => Number(a.name) - Number(b.name))) {
    if (!/^\d+$/.test(child.name)) continue;
    const events = [];
    const eventRoot = resolved(child.at('event')) ?? child.at('event');
    for (const event of numeric(eventRoot)) {
      const type = scalar(event, 'type', 0);
      const next = scalar(event, 'state');
      assert(Number.isInteger(next) && next >= 0, `Reactor/${artId}.img/${child.name} event without target state`);
      events.push({
        // 0 = hit by a normal attack, 9 = hit by clicking / standing in the
        // authored area.  Only these two appear in the TMS273 placements.
        type,
        nextState: next,
        lt: point(event, 'lt'),
        rb: point(event, 'rb'),
      });
    }
    states[child.name] = {
      frames: await stateFrames(artId, child.name, null),
      hitFrames: await stateFrames(artId, child.name, 'hit'),
      events,
      repeat: scalar(child, 'repeat', 0) === 1,
    };
  }
  assert(Object.keys(states).length > 0, `Reactor/${artId}.img has no states`);
  // Reject templates whose states carry no art at all: an invisible reactor
  // would be an unclickable hole in the map, and the source `_Canvas` for
  // these ids is genuinely absent from the local TMS273.7 client.
  assert(
    Object.values(states).some(state => state.frames.length),
    `Reactor/${artId}.img has no drawable frames`,
  );
  return {
    templateId,
    // Resolved art source when the template is a `info.link` alias.
    artId: artId === templateId ? undefined : artId,
    // Retained for source tracing only: this server does not execute WZ reactor
    // scripts (U — none of the placement `action` names exist locally).
    action: scalar(root, 'action') ?? null,
    states,
  };
}

async function main() {
  fs.mkdirSync(ASSETS, { recursive: true });
  const maps = JSON.parse(fs.readFileSync(MAPS, 'utf8')).maps;
  const placements = [];
  const templateIds = new Set();
  // A few authored placements sit outside the map's own bounds.  Those maps
  // derive their bounds from `miniMap` (they carry no VR rect), and the props
  // in question land beyond the outermost foothold too — they are unreachable,
  // and the player is clamped inside the bounds, so shipping them would add
  // props nobody can ever hit.  Record them instead of silently dropping them.
  const omitted = [];
  for (const map of maps) {
    const raw = map.raw?.reactor;
    if (!raw) continue;
    const { xMin, xMax, yMin, yMax } = map.bounds;
    for (const [index, entry] of Object.entries(raw)) {
      if (index === '_dirType') continue;
      const placement = {
        id: `${map.id}-reactor-${index}`,
        mapId: map.id,
        templateId: String(entry.id._value),
        x: Number(entry.x._value),
        y: Number(entry.y._value),
        // Source seconds until the reactor returns after it was used up.
        reactorTime: Number(entry.reactorTime._value ?? 0),
        flip: Number(entry.f._value ?? 0) === 1,
      };
      if (placement.x < xMin || placement.x > xMax || placement.y < yMin || placement.y > yMax) {
        omitted.push({ ...placement, reason: 'outside map bounds' });
        continue;
      }
      placements.push(placement);
      templateIds.add(placement.templateId);
    }
  }
  placements.sort((a, b) => a.id.localeCompare(b.id));
  omitted.sort((a, b) => a.id.localeCompare(b.id));

  const templates = {};
  for (const templateId of [...templateIds].sort()) {
    templates[templateId] = await exportTemplate(templateId);
  }

  const output = {
    contentVersion: 'tms273-reactor',
    source: 'TMS273.7 client WZ / Reactor.wz + Map.wz reactor placements',
    templates,
    placements,
    omitted,
  };
  const outputPath = path.join(OUTPUT, 'reactor.json');
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    output: outputPath,
    templates: Object.keys(templates).length,
    placements: placements.length,
    maps: [...new Set(placements.map(placement => placement.mapId))].length,
    omitted: omitted.map(entry => `${entry.id} (${entry.reason})`),
  }, null, 2));
}

if (require.main === module) {
  main()
    .catch(error => { console.error(error.stack || error.message); process.exitCode = 1; })
    .finally(() => reader.close());
}

module.exports = { main };
