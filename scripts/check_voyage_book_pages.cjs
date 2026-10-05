#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require(path.join(__dirname, '..', 'client', 'node_modules', 'esbuild'));

const root = path.resolve(__dirname, '..');

function loadPageCloth() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(root, 'client', 'src', 'features', 'entry', 'voyage-book-pages.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    write: false,
    logLevel: 'silent',
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
  return module.exports.VoyageBookPageCloth;
}

function finiteArray(array, label) {
  for (let i = 0; i < array.length; i++) assert(Number.isFinite(array[i]), `${label}[${i}] is not finite`);
}

function distance(array, a, b) {
  const offsetA = a * 3;
  const offsetB = b * 3;
  return Math.hypot(
    array[offsetA] - array[offsetB],
    array[offsetA + 1] - array[offsetB + 1],
    array[offsetA + 2] - array[offsetB + 2],
  );
}

function edgesOf(cloth) {
  const edges = [];
  for (let row = 0; row <= cloth.rows; row++) for (let column = 0; column <= cloth.columns; column++) {
    const index = row * (cloth.columns + 1) + column;
    if (column < cloth.columns) edges.push([index, index + 1]);
    if (row < cloth.rows) edges.push([index, index + cloth.columns + 1]);
    if (column < cloth.columns && row < cloth.rows) {
      edges.push([index, index + cloth.columns + 2]);
      edges.push([index + 1, index + cloth.columns + 1]);
    }
    if (column + 2 <= cloth.columns) edges.push([index, index + 2]);
    if (row + 2 <= cloth.rows) edges.push([index, index + 2 * (cloth.columns + 1)]);
  }
  return edges;
}

function checkPose(cloth, side, pageIndex, label) {
  finiteArray(cloth.positions, `${label} positions`);
  finiteArray(cloth.previous, `${label} previous`);
  const floor = cloth.frontDepth + pageIndex * cloth.pageSpacing;
  let minHalf = Infinity;
  let minReadableDepth = Infinity;
  for (let index = 0; index < cloth.positions.length / 3; index++) {
    const offset = index * 3;
    minHalf = Math.min(minHalf, side * (cloth.positions[offset] - cloth.hinge));
    minReadableDepth = Math.min(minReadableDepth, cloth.positions[offset + 2] - floor);
  }
  assert(minHalf >= -1e-5, `${label} crossed the opposite page half: ${minHalf}`);
  assert(minReadableDepth >= -1e-5, `${label} crossed the cover depth: ${minReadableDepth}`);
  return { minHalf, minReadableDepth };
}

function edgeError(cloth, edges) {
  let maxRelative = 0;
  for (const [a, b] of edges) {
    const rest = distance(cloth.rest, a, b);
    const current = distance(cloth.positions, a, b);
    maxRelative = Math.max(maxRelative, Math.abs(current / rest - 1));
  }
  return maxRelative;
}

const VoyageBookPageCloth = loadPageCloth();
const samples = [0, .08, .18, .35, .55, .75, .95, 1];
const report = [];
let maxClosedEdgeError = 0;
let maxSimulatedEdgeError = 0;
let minHalf = Infinity;
let minReadableDepth = Infinity;

for (const side of [-1, 1]) for (let pageIndex = 0; pageIndex < 6; pageIndex++) {
  const cloth = new VoyageBookPageCloth({ side, pageIndex });
  assert.equal(cloth.columns, 8, 'page columns must keep the authored width sampling');
  assert.equal(cloth.rows, 12, 'page rows must keep the cloth sampling');
  assert.equal(cloth.closedAngle, 1.45, 'closed page hinge angle');
  assert.equal(cloth.frontDepth, .105, 'page readable face must stay in front of the opened cover');
  const edges = edgesOf(cloth);
  finiteArray(cloth.rest, `side ${side} page ${pageIndex} rest`);
  finiteArray(cloth.closed, `side ${side} page ${pageIndex} closed`);

  // The closed pose is a rigid rotation of the authored curved path, so it
  // should preserve every structural/shear/bending edge to float precision.
  cloth.positions.set(cloth.closed);
  const closedEdgeError = edgeError(cloth, edges);
  maxClosedEdgeError = Math.max(maxClosedEdgeError, closedEdgeError);
  assert(closedEdgeError < 2e-4, `side ${side} page ${pageIndex} closed edge error ${closedEdgeError}`);
  const closedPose = checkPose(cloth, side, pageIndex, `side ${side} page ${pageIndex} closed`);
  minHalf = Math.min(minHalf, closedPose.minHalf);
  minReadableDepth = Math.min(minReadableDepth, closedPose.minReadableDepth);

  for (const progress of samples) {
    cloth.reset();
    for (let frame = 0; frame < 120; frame++) {
      cloth.advance(1 / 60, progress, false);
      const pose = checkPose(cloth, side, pageIndex, `side ${side} page ${pageIndex} progress ${progress}`);
      minHalf = Math.min(minHalf, pose.minHalf);
      minReadableDepth = Math.min(minReadableDepth, pose.minReadableDepth);
    }
    const simulated = edgeError(cloth, edges);
    maxSimulatedEdgeError = Math.max(maxSimulatedEdgeError, simulated);
    assert(simulated < .06, `side ${side} page ${pageIndex} progress ${progress} edge error ${simulated}`);
  }

  cloth.reset();
  cloth.advance(0, 1, true);
  let terminalError = 0;
  for (let i = 0; i < cloth.positions.length; i++) terminalError = Math.max(terminalError, Math.abs(cloth.positions[i] - cloth.rest[i]));
  assert(terminalError < 1e-6, `side ${side} page ${pageIndex} terminal rest error ${terminalError}`);
  report.push({ side, pageIndex, closedEdgeError, terminalError });
}

console.log(JSON.stringify({
  pages: report.length,
  closedAngleRadians: 1.45,
  maxClosedEdgeError,
  maxSimulatedEdgeError,
  minHalf,
  minReadableDepth,
  finite: true,
}, null, 2));
