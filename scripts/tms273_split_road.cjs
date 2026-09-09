// P: user-requested stepping plank and swimmable pool, not original TMS geometry.
function applySplitRoad(map) {
  if (map.id !== '001020000') return map;
  map.footholds = map.footholds.filter(f => f.id !== 58 && f.id !== 59);
  map.footholds.find(f => f.id === 57).next = 0;
  Object.assign(map.footholds.find(f => f.id === 15), { x1: 580, prev: 0 });
  map.footholds.push({ id: 59, x1: 620, y1: 180, x2: 690, y2: 180, prev: 0, next: 0, forbidFallDown: 0 });
  map.water = [{ xMin: 0, xMax: 580, yMin: 224, yMax: 340,
    floor: [[0,278],[45,284],[88,296],[94,340],[486,340],[493,296],[533,284],[575,278],[580,278]].map(([x,y]) => ({x,y})) }];
  if (map.layers) {
    map.layers = map.layers.filter(l => l.key !== 'split-road-step');
    const deck = map.layers.find(l => l.source === 'Map/Obj/acc1.img/grassySoil_new/house5/1');
    if (!deck) throw new Error('Split Road source deck missing');
    map.layers.push({ key: 'split-road-step', url: deck.url, source: deck.source,
      x: 50, y: 50, depth: 209.5, crop: { x: 570, y: 130, width: 70, height: 20 } });
  }
  return map;
}
module.exports = { applySplitRoad };
if (require.main === module) {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const read = file => JSON.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
  const source = read('resources/tms273-export/maps-rendered.json').maps;
  const map = applySplitRoad(structuredClone(source.find(m => m.id === '001020000')));
  assert.deepEqual(applySplitRoad(structuredClone(map)), map, 'assembly must be repeatable');
  for (const other of source.filter(m => m.id !== map.id)) assert.deepEqual(applySplitRoad(structuredClone(other)), other);
  const platform = map.footholds.find(f => f.id === 59);
  assert.equal(platform.y1, 180);
  assert(platform.x1 < 637 && platform.x2 > 637, 'step must bridge bank and deck edge');
  assert(!map.footholds.some(f => f.id === 58), 'old deck wall must not block entry');
  for (const emitted of [read('shared/maps.json').maps, read('client/public-tms273/assets/manifest.json').mapCatalog.maps]) {
    const actual = emitted.find(m => m.id === map.id);
    assert.deepEqual(actual.footholds, map.footholds);
    assert.deepEqual(actual.water, map.water);
  }
  const plank = map.layers.find(l => l.key === 'split-road-step');
  assert.equal(plank.x + plank.crop.x, platform.x1);
  assert.equal(plank.y + plank.crop.y, platform.y1);
  assert.equal(plank.crop.width, platform.x2 - platform.x1);
  console.log('Split Road geometry, source plank alignment, idempotence and runtime data: passed');
}
