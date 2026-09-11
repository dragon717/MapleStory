#!/usr/bin/env node
// Temporary probe: list TradingRoom (trade window) structure in TMS273.7 UI wz.
const path = require('node:path');
const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const reader = createReader(DATA);

function resolved(node) {
  let current = node;
  const seen = new Set();
  while (current instanceof wz.WzUOLProperty) {
    if (seen.has(current)) break;
    seen.add(current);
    current = current.linkValue;
  }
  return current;
}

function kids(node) {
  if (!node) return [];
  const props = node.properties ?? node.wzProperties ?? node.children;
  if (props && typeof props !== 'string' && typeof props[Symbol.iterator] === 'function') {
    return Array.from(props).map(c => (typeof c === 'string' ? { name: c } : c));
  }
  if (props && typeof props === 'object') return Object.keys(props).map(name => ({ name }));
  return [];
}

async function dump(source, depth) {
  let node;
  try {
    node = await reader.get(source);
    if (node instanceof wz.WzImage) await node.parseImage();
  } catch (error) {
    console.log(`${'  '.repeat(depth)}MISS ${source}`);
    return;
  }
  node = resolved(node);
  const children = kids(node);
  const names = children.map(c => c.name ?? '?');
  console.log(`${'  '.repeat(depth)}${source} [${node?.constructor?.name}] (${names.length}): ${names.slice(0, 30).join(', ')}`);
  if (depth < 2) {
    for (const child of children.slice(0, 14)) await dump(`${source}/${child.name}`, depth + 1);
  }
}

(async () => {
  await dump('UI/UIWindow2.img/TradingRoom', 0);
  reader.close();
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
