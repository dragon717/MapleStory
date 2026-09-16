#!/usr/bin/env node

// Export the same-version monster display names (`String/Mob.json`).
//
// The 冒险笔记（图鉴） monster page has to *name* the 1550 authored collection
// slots, and the TMS273 client ships exactly one table that does:
// `String/Mob.json`, keyed by monster template id with a single `name` leaf.
// Nothing else in the project carries a monster name — `shared/gameplay.json`
// is stat-only and `String/MonsterBook.img` carries episode prose, not names.
//
// This export is deliberately the smallest possible reader: it copies the
// `name` leaf of every id that really has one and drops everything else.  An
// id with no name is *absent* from the output rather than given a placeholder,
// so the UI can say "this slot's name is unknown" instead of showing a number
// that looks like a name.
//
// The file is tiny enough (~1.6 MB source, ~200 KB output) to be read by both
// sides: the server `include_str!`s it for search and row labels, the client
// imports it for slot captions.  Neither side invents a name for an id the
// source does not name.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WZ_JSON = path.join(ROOT, '参考/273/TMS273少爷一键端/TMS273/WZ_JSON_TW');
const SOURCE = path.join(WZ_JSON, 'String/Mob.json');
const OUTPUT = path.join(ROOT, 'shared/mob-names.json');

/** `_value` of a `_dirType`-tagged leaf, or undefined when it carries none. */
function value(node) {
  if (!node || typeof node !== 'object') return undefined;
  return Object.prototype.hasOwnProperty.call(node, '_value') ? node._value : undefined;
}

const source = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
const names = {};
let skipped = 0;
for (const [id, node] of Object.entries(source)) {
  if (!/^\d+$/.test(id)) { skipped += 1; continue; }
  const name = value(node?.name);
  // An all-zero id (`0000000`) canonicalises to the empty string, which is not
  // a monster; ids are kept exactly as the source spells them so a lookup by
  // template id never depends on a padding rule either side invented.
  if (typeof name !== 'string' || !name.trim()) { skipped += 1; continue; }
  names[id] = name.trim();
}

const sorted = {};
for (const id of Object.keys(names).sort()) sorted[id] = names[id];
fs.writeFileSync(OUTPUT, `${JSON.stringify({ source: 'String/Mob.json', names: sorted }, null, 1)}\n`);
console.log(JSON.stringify({ mobNames: Object.keys(sorted).length, skipped }));
