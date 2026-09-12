// Standalone harness for the minimap view: mounts the real MiniMapView against
// the real exported manifest so the header (plate badge, "MINI MAP" card, names,
// the four authored buttons and the NPC 目录 popup) can be inspected and driven
// without logging into the game.  Served from output/minimap-check with
// `assets -> client/public-tms273/assets`.
import { MiniMapView } from '../../client/src/features/world/minimap-view.ts';
import '../../client/src/features/world/minimap.css';

const manifest = await fetch('/assets/manifest.json').then(response => response.json());

const shell = document.createElement('div');
shell.id = 'game-shell';
const minimap = document.createElement('div');
minimap.id = 'minimap';
shell.append(minimap);
document.body.append(shell);

const view = new MiniMapView(minimap, manifest);
view.onWorldMap = () => { document.body.dataset.worldMap = 'opened'; };
view.mount();

// Two maps with different marks so the plate badge can be compared, plus a
// couple of NPCs for the 目录.
const mapIds = Object.keys(manifest.miniMap.maps);
const mapId = mapIds.find(id => manifest.miniMap.maps[id].mark === 'SixPath') ?? mapIds[0];
const npcs = (manifest.mapCatalog.maps.find(entry => entry.id === mapId) ? [] : []).concat([
  { id: 'npc-1', name: 'Sergeant Bravo', nameZh: '警備隊長', x: 0, y: 0 },
  { id: 'npc-2', name: 'Shop Keeper', nameZh: '雜貨商人', x: 100, y: 0 },
]);
const input = {
  mapId,
  self: { id: 'self', username: 'harness', x: 0, y: 0, facing: 1, grounded: true, vy: 0, action: 'stand' },
  players: [],
  npcs,
  portals: [],
  partyIds: [],
};
view.update(input);

globalThis.__minimap = { view, manifest, mapId, input };
document.body.dataset.ready = 'true';
