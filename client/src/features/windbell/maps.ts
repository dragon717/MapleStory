import config from '../../../../shared/windbell.json';
import type { Manifest, MapCatalogEntry } from '../../assets/manifest';
export const WINDBELL_ASSETS = '/assets/windbell/';
export function installWindbellMaps(manifest: Manifest) {
  const maps: MapCatalogEntry[] = Object.entries(config.maps).map(([scene, map]) => ({
    ...map, spawn: {...map.spawn, id:'sp'}, name: map.name, streetName: '回风原 · 风铃林间', source: 'P: shared/windbell.json', assetStatus: 'rendered',
    bgm: `${WINDBELL_ASSETS}${scene}_mix.ogg`,
    layers: [{ key: `windbell-${scene}-sky`, url: `${WINDBELL_ASSETS}${scene}-distant-background.png`, x: 0, y: 100, depth: 0 }],
  }));
  manifest.mapCatalog = { birthMapId: manifest.mapCatalog?.birthMapId ?? manifest.map.id, source: manifest.mapCatalog?.source ?? 'TMS273', ...manifest.mapCatalog, maps: [...(manifest.mapCatalog?.maps ?? []).filter(m => !m.id.startsWith('windbell-')), ...maps] };
  manifest.npcs ??= {};
  for (const name of ['awei', 'mucen', 'lanzhi']) manifest.npcs[`windbell-${name}`] = {
    name: { awei:'阿苇', mucen:'木岑', lanzhi:'岚织' }[name]!, source: 'P: original Windbell portrait',
    stand: [{url:`${WINDBELL_ASSETS}npc-${name}.png`,width:80,height:120,x:-40,y:-120,origin:{x:40,y:120},delay:1000}],
  };
  manifest.npcs['windbell-awei'].move = [
    { file: 'npc-awei-walk-1.png', figureHeight: 1399, foot: 1493, center: 538.5 },
    { file: 'npc-awei-walk-2.png', figureHeight: 1440, foot: 1483, center: 546 },
  ].map(({ file, figureHeight, foot, center }) => {
    const scale = 120 / figureHeight;
    return { url: `${WINDBELL_ASSETS}${file}`, width: 1024*scale, height: 1536*scale,
      x: -center*scale, y: -foot*scale, origin: { x: center*scale, y: foot*scale }, delay: 180 };
  });
  // Preserve the 1024×1536 generated PNG; scale its visible 1240px figure to
  // 120 world pixels and anchor the measured sole at source y=1391.
  const scale = 120 / 1240;
  manifest.npcs['windbell-huaisheng'] = {
    name: '槐生', source: 'P: imagegen; npc.archive_keeper.huaisheng',
    stand: [{url:`${WINDBELL_ASSETS}npc-huaisheng-fresh.png`,width:1024*scale,height:1536*scale,x:-529*scale,y:-1391*scale,origin:{x:529*scale,y:1391*scale},delay:1000}],
  };
}
