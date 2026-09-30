// User-authored rail layout; TMS273 supplies actors, portals and their identities.
const rail = require('../shared/henesys-rail.json');
const surface = x => rail.platforms.find(f => x >= f.x1 && x < f.x2) ?? rail.platforms.at(-1);
function applyHenesysLayout(maps, gameplay) {
  const map = maps.find(m => m.id === rail.mapId);
  if (!map) throw new Error('Henesys is missing from the source catalog');
  map.footholds = [...rail.platforms, ...rail.decks].map(f => ({...f}));
  map.bounds = {...rail.bounds}; map.spawn = {...map.spawn, ...rail.spawn}; map.ladders = rail.ladders.map(l => ({...l}));
  for (const p of [...map.portals, ...(map.reactors ?? [])]) {
    p.x = Math.max(rail.bounds.xMin, Math.min(rail.bounds.xMax, p.x)); p.y = surface(p.x).y1;
  }
  for (const spawn of [...gameplay.npcSpawns, ...gameplay.spawns].filter(s => s.mapId === rail.mapId)) {
    spawn.x = Math.max(rail.bounds.xMin, Math.min(rail.bounds.xMax, spawn.x));
    const f = surface(spawn.x); spawn.y = f.y1;
    if ('footholdId' in spawn) spawn.footholdId = f.id;
    if ('rx0' in spawn) spawn.rx0 = f.x1;
    if ('rx1' in spawn) spawn.rx1 = f.x2;
  }
  gameplay.compatibility.henesysRail = 'P: user-authored curved rail and solid platforms, 2026-09-30; TMS273 actors and portal identities retained; placement heights follow shared/henesys-rail.json.';
}
module.exports = { applyHenesysLayout };
