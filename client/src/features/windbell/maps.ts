import config from '../../../../shared/windbell.json';
import type { Manifest, MapCatalogEntry } from '../../assets/manifest';
export const WINDBELL_ASSETS = '/assets/windbell/';
export function installWindbellMaps(manifest: Manifest) {
  const maps: MapCatalogEntry[] = Object.entries(config.maps).map(([scene, map]) => ({
    ...map, spawn: {...map.spawn, id:'sp'}, name: map.name, streetName: '风铃林间', source: 'P: shared/windbell.json', assetStatus: 'rendered',
    bgm: `${WINDBELL_ASSETS}${scene}_mix.ogg`,
    layers: [{ key: `windbell-${scene}-sky`, url: `${WINDBELL_ASSETS}${scene}-distant-background.png`, x: 0, y: 100, depth: 0 }],
  }));
  manifest.mapCatalog = { birthMapId: manifest.mapCatalog?.birthMapId ?? manifest.map.id, source: manifest.mapCatalog?.source ?? 'TMS273', ...manifest.mapCatalog, maps: [...(manifest.mapCatalog?.maps ?? []).filter(m => !m.id.startsWith('windbell-')), ...maps] };
  manifest.npcs ??= {};
  for (const name of ['awei', 'mucen', 'lanzhi']) manifest.npcs[`windbell-${name}`] = {
    name: { awei:'阿苇', mucen:'木岑', lanzhi:'岚织' }[name]!, source: 'P: original Windbell portrait',
    stand: [{url:`${WINDBELL_ASSETS}npc-${name}.png`,width:80,height:120,x:-40,y:-120,origin:{x:40,y:120},delay:1000}],
  };
}
