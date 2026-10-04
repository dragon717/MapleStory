#!/usr/bin/env node
'use strict';

// Pure paper physics check. It deliberately bundles the production PaperCloth
// class instead of reimplementing its constraints in the check itself; no
// browser, WebGL context, server, or asset download is needed.
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require(path.join(__dirname, '..', 'client', 'node_modules', 'esbuild'));

const root = path.resolve(__dirname, '..');
const client = path.join(root, 'client');

function loadPaperRuntime() {
  const result = esbuild.buildSync({
    stdin: {
      contents: "import { PaperCloth } from './src/features/entry/voyage-paper.ts'; export { PaperCloth };",
      resolveDir: client,
      sourcefile: 'check-voyage-paper.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    write: false,
    logLevel: 'silent',
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

function makeSpec(width = 3.4, height = 5) {
  const columns = Math.max(10, Math.min(18, Math.round(width * 2.2)));
  const rows = Math.max(20, Math.min(32, Math.round(height * 3.2)));
  const rest = new Float32Array((columns + 1) * (rows + 1) * 3);
  for (let row = 0; row <= rows; row++) for (let column = 0; column <= columns; column++) {
    const index = (row * (columns + 1) + column) * 3;
    rest[index] = (column / columns - .5) * width;
    rest[index + 1] = (.5 - row / rows) * height;
  }
  return { width, height, columns, rows, radius: Math.max(.12, Math.min(.3, width * .075)), rest };
}

function nodeOffset(spec, row, column = Math.floor(spec.columns / 2)) {
  return (row * (spec.columns + 1) + column) * 3;
}

function nodeDistance(a, b, offset) {
  return Math.hypot(a[offset] - b[offset], a[offset + 1] - b[offset + 1], a[offset + 2] - b[offset + 2]);
}

function foldedTarget(spec, index, progress) {
  const row = Math.floor(index / (spec.columns + 1));
  const localRow = row / spec.rows;
  const x = spec.rest[index * 3];
  if (localRow <= progress) return [x, spec.rest[index * 3 + 1], spec.rest[index * 3 + 2]];
  const around = Math.max(0, Math.min(1, (localRow - progress) / Math.max(1e-4, 1 - progress)));
  const angle = around * Math.PI * 2;
  return [x, spec.rest[1] + Math.sin(angle) * spec.radius, spec.radius * .12 + (1 - Math.cos(angle)) * spec.radius * .82];
}

function assertFiniteAndBounded(cloth, limit, label) {
  let maxAbs = 0;
  for (const value of cloth.positions) {
    assert(Number.isFinite(value), `${label}: non-finite vertex`);
    maxAbs = Math.max(maxAbs, Math.abs(value));
  }
  assert(maxAbs < limit, `${label}: vertex escaped bound (${maxAbs})`);
  return maxAbs;
}

function maxTopDrift(cloth, spec) {
  let drift = 0;
  for (let column = 0; column <= spec.columns; column++) drift = Math.max(drift, nodeDistance(cloth.positions, spec.rest, nodeOffset(spec, 0, column)));
  return drift;
}

function maxCornerError(cloth, spec) {
  const corners = [
    nodeOffset(spec, 0, 0),
    nodeOffset(spec, 0, spec.columns),
    nodeOffset(spec, spec.rows, 0),
    nodeOffset(spec, spec.rows, spec.columns),
  ];
  return Math.max(...corners.map(offset => nodeDistance(cloth.positions, spec.rest, offset)));
}

function runRowReleaseCheck(PaperCloth, spec) {
  const cloth = new PaperCloth(spec.rest, spec.columns, spec.rows, spec.radius);
  const progressSamples = [.05, .1, .15, .2, .3, .4, .6];
  let previousDeepest = 0;
  const releasedRows = [];
  for (const progress of progressSamples) {
    // Give each release edge enough fixed-step time to show its actual cloth
    // response; rows below the edge stay exactly in their rolled pose.
    for (let frame = 0; frame < 6; frame++) cloth.advance(1 / 60, progress);
    let deepest = 0;
    for (let row = 1; row <= spec.rows; row++) {
      const offset = nodeOffset(spec, row);
      const index = row * (spec.columns + 1) + Math.floor(spec.columns / 2);
      const [x, y, z] = foldedTarget(spec, index, progress);
      const error = Math.hypot(cloth.positions[offset] - x, cloth.positions[offset + 1] - y, cloth.positions[offset + 2] - z);
      if (error > 1e-4) deepest = row;
      if (row > Math.ceil(progress * spec.rows) + 2) assert(error < 1e-4, `row ${row} moved before release edge ${progress}`);
    }
    assert(deepest >= Math.max(1, Math.floor(progress * spec.rows)), `release did not reach row ${Math.floor(progress * spec.rows)} at ${progress}`);
    assert(deepest >= previousDeepest, `release edge moved backward at ${progress}`);
    previousDeepest = deepest;
    releasedRows.push(deepest);
  }
  assert(releasedRows.at(-1) > releasedRows[0], 'paper did not release rows progressively');
  return releasedRows;
}

function runFrameRateCheck(PaperCloth, spec, hz) {
  const cloth = new PaperCloth(spec.rest, spec.columns, spec.rows, spec.radius);
  const duration = 1.1, targetProgress = .8;
  let maxAbs = 0, maxDepth = 0;
  for (let frame = 0; frame < Math.round(duration * hz); frame++) {
    const progress = targetProgress * Math.min(1, (frame + 1) / (duration * hz));
    cloth.advance(1 / hz, progress);
    maxAbs = Math.max(maxAbs, assertFiniteAndBounded(cloth, 64, `${hz}Hz`));
    for (let index = 2; index < cloth.positions.length; index += 3) maxDepth = Math.max(maxDepth, Math.abs(cloth.positions[index]));
    assert(maxTopDrift(cloth, spec) < 1e-6, `${hz}Hz: fixed top row drifted`);
  }
  assert(maxDepth > .01, `${hz}Hz: paper never developed physical Z depth`);
  return { cloth, maxAbs, maxDepth };
}

function maxArrayDifference(a, b) {
  assert.equal(a.length, b.length);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference = Math.max(difference, Math.abs(a[index] - b[index]));
  return difference;
}

function runTerminalAndCloseChecks(PaperCloth, spec) {
  const cloth = new PaperCloth(spec.rest, spec.columns, spec.rows, spec.radius);
  for (let frame = 0; frame < 36; frame++) cloth.advance(1 / 60, .72);
  assertFiniteAndBounded(cloth, 64, 'terminal prelude');

  // This is the reduced-motion path: it must snap even without elapsed time.
  cloth.advance(0, 1);
  assert(maxCornerError(cloth, spec) < 1e-7, 'advance(0, 1) did not restore terminal corners');
  assert(maxArrayDifference(cloth.positions, spec.rest) < 1e-7, 'advance(0, 1) did not restore the exact rest pose');

  // Closing resets the entire rolled section in one deterministic pose.
  cloth.advance(1 / 60, 0);
  for (let row = 0; row <= spec.rows; row++) for (let column = 0; column <= spec.columns; column++) {
    const index = row * (spec.columns + 1) + column;
    const expected = foldedTarget(spec, index, 0);
    const offset = index * 3;
    // The simulation stores Float32 vertices while the analytic target is
    // evaluated in JS doubles; allow that representation round-off only.
    assert(Math.hypot(cloth.positions[offset] - expected[0], cloth.positions[offset + 1] - expected[1], cloth.positions[offset + 2] - expected[2]) < 2e-6, `close did not restore rolled row ${row}`);
  }
  assertFiniteAndBounded(cloth, 64, 'closed');
}

function main() {
  const { PaperCloth } = loadPaperRuntime();
  const spec = makeSpec();
  const releasedRows = runRowReleaseCheck(PaperCloth, spec);
  const frameRates = {};
  for (const hz of [30, 60, 120]) frameRates[hz] = runFrameRateCheck(PaperCloth, spec, hz);
  const reference = frameRates[60].cloth.positions;
  const frameRateDifference = {};
  for (const hz of [30, 120]) {
    frameRateDifference[hz] = maxArrayDifference(frameRates[hz].cloth.positions, reference);
    assert(frameRateDifference[hz] < .25, `${hz}Hz diverged from 60Hz beyond tolerance: ${frameRateDifference[hz]}`);
  }
  runTerminalAndCloseChecks(PaperCloth, spec);
  console.log(JSON.stringify({
    status: 'passed',
    grid: { width: spec.width, height: spec.height, columns: spec.columns, rows: spec.rows, nodes: spec.rest.length / 3 },
    releasedRows,
    frameRates: Object.fromEntries(Object.entries(frameRates).map(([hz, result]) => [hz, { maxAbs: result.maxAbs, maxDepth: result.maxDepth }])),
    frameRateDifference,
    terminal: { topPin: true, corners: true, reducedMotionSnap: true, closeRestore: true },
  }));
}

main();
