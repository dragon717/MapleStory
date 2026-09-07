const assert = require('node:assert/strict');
const { geometry } = require('./export_tms273.cjs');
function node(data, name = '') {
  const entries = data && typeof data === 'object' ? Object.entries(data) : [];
  const properties = entries.map(([key, value]) => node(value, key));
  return { name, wzValue: data, wzProperties: properties, at: key => properties.find(p => p.name === key) };
}
const map = {
  info: {}, miniMap: { width: 1475, height: 963, centerX: 768, centerY: 409 },
  foothold: { 0: { 0: { 1: { x1: -400, y1: 241, x2: 400, y2: 241, prev: 0, next: 0 } } } },
  portal: {
    0: { pn: 'sp', pt: 0, x: -329, y: 241, tm: 999999999, tn: '' },
    1: { pn: 'sp', pt: 0, x: -300, y: 241, tm: 999999999, tn: '' },
    2: { pn: 'out00', pt: 2, x: 400, y: 241, tm: 30000, tn: 'in00' },
  },
};
const indoor = geometry(node(map), '000030001');
assert.deepEqual(indoor.bounds, { xMin: -768, xMax: 707, yMin: -409, yMax: 554 });
assert.equal(indoor.spawns.length, 2);
assert.equal(indoor.portals[0].targetMapId, null);
assert.equal(indoor.portals[2].targetMapId, '000030000');
assert.equal(indoor.footholds[0].path, 'foothold/0/0/1');
assert.throws(() => geometry(node({ ...map, miniMap: {} }), '000030001'), /authored bounds/);
assert.throws(() => geometry(node({ ...map, portal: {} }), '000030001'), /geometry/);
console.log('TMS273 map export checks passed');
