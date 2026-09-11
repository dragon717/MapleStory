// Source-backed opening quest data, with explicitly identified P execution gaps.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const decode = node => node && typeof node === 'object'
  ? ('_value' in node ? node._value : Object.fromEntries(Object.entries(node).filter(([k]) => !k.startsWith('_')).map(([k,v]) => [k, decode(v)]))) : node;

// Strip source formatting codes; the omitted abandonment hint belongs to the missing cutscene VM.
const display = text => String(text || '').replace(/#[bkrn]/g, '')
  .replace(/\((?:在任務中途離開時，請放棄任務後重新接收並進行。|任務途中離開時，請放棄後重新接取任務。|失敗時，放棄任務之後重新接受將可再次進行。)\)/g, '').trim();

function applyChapter(gameplay, items, manifest, chapter, questText, npcNames) {
  const source = JSON.parse(fs.readFileSync(path.join(root, 'references/tms273-data/quests.json'), 'utf8'));
  const ids = ['36301', '36302', '36303', '36304', '36306', '36307'];
  const experience = [15, 30, 45, 90, 120, 150];
  for (const [index, id] of ids.entries()) {
    const raw = source.quests.find(q => String(q.id) === id);
    assert(raw, `Missing source quest ${id}`);
    const check = decode(raw.Check), text = decode(raw.QuestInfo);
    const conditions = phase => ({
      levelAtLeast: Number(check[phase].lvmin || 1),
      // P: existing Magician saves may recover the opening story without losing their job.
      job: [0, 200, 220, 221, 222],
      quests: Object.values(check[phase].quest || {}).map(q => ({ questId: String(q.id), status: 'completed' })),
      items: Object.values(check[phase].item || {}).map(item => ({ itemId: String(item.id), quantity: Number(item.count) })),
    });
    const npcId = String(check['0'].npc || check['1'].npc);
    const quest = gameplay.quests.find(q => String(q.questId) === id);
    assert(quest);
    Object.assign(quest, {
      executable: true,
      name: raw.name,
      summary: display(text['0']),
      summaries: { available: display(text['0']), active: display(text['1'] || text['0']), completed: display(text['2']) },
      start: { npcId, conditions: conditions('0') },
      complete: { npcId: String(check['1'].npc || npcId), conditions: conditions('1'), consumeItems: true },
      reward: { mesos: 0, exp: experience[index], items: [] },
      sourceJob: Object.values(check['0'].job || {}).map(Number),
      sourceSubJobFlags: Number(check['0'].subJobFlags || 0),
      source: raw.source,
      ruleVersion: 'tms273-opening-p1',
      executionEvidence: 'P: dialogue/interaction/transport adapter; original q363 scripts unavailable. T: Quest Check IDs/counts and QuestInfo text. R: official quest guides describe objectives then NPC claim.',
    });
    if (questText.quests[id]) questText.quests[id].log = { zh: quest.summary };
  }
  const quest = id => gameplay.quests.find(q => String(q.questId) === id);
  if (chapter.interaction) quest('36301').interaction = { ...chapter.interaction, range: 120, itemId: '4036846', quantity: 1 };
  if (chapter.ticketItemId) {
    quest('36304').reward.items.push({ itemId: chapter.ticketItemId, quantity: 1 });
    quest('36306').complete.conditions.items = [{ itemId: chapter.ticketItemId, quantity: 1 }];
    quest('36306').complete.consumeItems = true;
  }
  quest('36306').complete.warpMapId = '104000000';
  quest('36307').returnMapId = '001020000';
  Object.assign(items, chapter.items);
  for (const spec of gameplay.quests.filter(q => ids.includes(String(q.questId)))) {
    spec.objectives = spec.complete.conditions.items.map(item => ({
      kind: 'collect', itemId: item.itemId, required: item.quantity,
      text: items[item.itemId]?.name || item.itemId,
    }));
  }
  for (const id of ['4036846', chapter.ticketItemId].filter(Boolean)) {
    assert(items[id], `Missing chapter item ${id}`);
    // P safety boundary: recoverable quest objects never become a tradable income source.
    items[id].info = { ...items[id].info, tradeBlock: 1, dropBlock: 1 };
  }
  Object.assign(manifest.items, chapter.itemImages);
  Object.assign(manifest.npcs, chapter.npcs);
  for (const npc of chapter.npcTemplates || []) {
    if (!gameplay.npcs.some(n => n.templateId === npc.templateId)) gameplay.npcs.push(npc);
    npcNames.npcs[npc.templateId] = npc.name;
  }
  for (const spawn of chapter.npcSpawns || []) {
    if (!manifest.mapCatalog.maps.some(map => map.id === spawn.mapId)) continue;
    if (!gameplay.npcSpawns.some(n => n.id === spawn.id)) gameplay.npcSpawns.push(spawn);
  }
  // P: enter_20000 / pier script bodies are absent. Preserve source portals and expose their local route.
  // T: `Map/Map/Graph.json` gives the authored landing for each scripted ferry —
  // 002000000/portal/2 → 2000100 and 002000100/portal/1 → 2000000 — and both
  // land on the *paired* gate (portalNum 1 = 碼頭 `west00`, 楓之港 `in00`),
  // not on the destination map's default spawn.  Landing on `sp` dropped the
  // player 95 px above the pier floor.
  for (const [mapId, portalName, targetMapId, targetPortalName] of [
    ['002000000', 'east00', '002000100', 'west00'],
    ['002000100', 'west00', '002000000', 'in00'],
  ]) {
    const portal = manifest.mapCatalog.maps.find(m => m.id === mapId)?.portals.find(p => p.name === portalName);
    assert(portal, `Missing source portal ${mapId}/${portalName}`);
    portal.targetMapId = targetMapId; portal.targetPortalName = targetPortalName;
  }
  gameplay.compatibility.openingChapter = {
    ruleVersion: 'tms273-opening-p1',
    sourceQuests: ids,
    officialStructureReferences: [
      'https://maplestory.nexon.co.jp/gameguide/basic/quest/',
      'https://www.maplesea.com/guide/user_interface/',
    ],
    crossRegionStoryReferences: ["https://maplestorywiki.net/w/(Explorer)_Sugar's_Suggestion", 'https://maplestorywiki.net/w/Quests/77/Victoria_Island_or_Bust'],
    rewardGap: 'R wiki also lists First Explorer Gift Box; TMS273 script/item contents unverified, no box reward claimed as implemented.',
    evidenceBoundary: 'Current cross-region official guides are R structure only, not TMS273 reward or script evidence.',
    temporaryRules: 'P: click interaction grants one untradeable hairpin; NPC dialogue replaces missing cutscenes; six quest EXP rewards 15/30/45/90/120/150 use the existing P level curve, no mesos; pier travel resumes at Victoria Harbor; existing mage jobs may recover chapter; return navigation to Hans does not alter job.',
  };
  applyContinuation(gameplay, items, manifest, source, questText);
}

function applyContinuation(gameplay, items, manifest, source, questText) {
  const rows = [
    ['1402', '36307', '1032001', '1032001', 0],
    ['36337', '1402', '1541009', '1541009', 300],
    ['36308', '36337', '1541009', '1012100', 450],
    ['36309', '36308', '1012100', '1541003', 600],
    ['36310', '36309', '1101002', '1012100', 750],
    ['36311', '36310', '1012100', '1012100', 900],
    ['36312', '36311', '1012100', '1541004', 1050],
    ['36313', '36312', '1541004', '1541004', 1200],
    ['36314', '36313', '1541005', '1012100', 1500],
  ];
  const quest = id => gameplay.quests.find(q => String(q.questId) === id);
  for (const [id, predecessor, startNpc, completeNpc, exp] of rows) {
    const raw = source.quests.find(q => String(q.id) === id);
    assert(raw && quest(id), `Missing continuation source ${id}`);
    const check = decode(raw.Check), text = decode(raw.QuestInfo);
    // Source Check.QuestOrOption == 1 lists mutually exclusive route
    // checkpoints (36337: 1401..2570): any one completed unlocks the quest.
    const check0 = check['0'];
    const routeQuests = Object.values(check0.quest || {}).map(node => String(node.id));
    const orOption = Number(check0.QuestOrOption || 0) === 1;
    const conditions = {
      levelAtLeast: Number(check0.lvmin || 10),
      job: id === '1402' ? [0, 200, 220, 221, 222] : [200, 220, 221, 222],
      quests: routeQuests.length > 0 && orOption
        ? routeQuests.map(questId => ({ questId, status: 'completed' }))
        : [{ questId: predecessor, status: 'completed' }],
      items: [],
    };
    if (routeQuests.length > 0 && orOption) conditions.questOrOption = true;
    Object.assign(quest(id), {
      executable: true, name: raw.name, summary: display(text['0']),
      summaries: { available: display(text['0']), active: display(text['1'] || text['0']), completed: display(text['2']) },
      start: { npcId: startNpc, conditions },
      complete: { npcId: completeNpc, conditions: { ...conditions, items: [] }, consumeItems: true },
      startItems: [], objectives: [], reward: { mesos: 0, exp, items: [] },
      source: raw.source, sourceCheck: check,
      ruleVersion: 'tms273-continuation-p1',
      executionEvidence: 'T: original QuestInfo/Check and source NPC/item/map assets. P: explicit NPC interaction, selected story travel and acquisition replace missing scripts; original scenes remain unavailable.',
    });
    if (questText.quests[id]) questText.quests[id].log = { zh: quest(id).summary };
  }
  quest('36309').start.warpMapId = '130000000';
  quest('36310').start.warpMapId = '100000201';
  quest('36310').startItems = [{ itemId: '4033888', quantity: 1 }];
  quest('36310').complete.conditions.items = [{ itemId: '4033888', quantity: 1 }];
  quest('36312').start.warpMapId = '310040200';
  quest('36313').startItems = [{ itemId: '1003134', quantity: 1 }];
  quest('36313').complete.conditions.equippedItems = ['1003134'];
  quest('36313').complete.consumeItems = false;
  quest('36313').complete.warpMapId = '310050000';
  quest('36313').objectives = [{ kind: 'equip', itemId: '1003134', required: 1, text: '戴上黑色翅膀的帽子' }];
  quest('36314').startItems = ['4033889', '4036847'].map(itemId => ({ itemId, quantity: 1 }));
  quest('36314').start.warpMapId = '100000201';
  quest('36314').complete.conditions.items = quest('36314').startItems.map(item => ({ ...item }));
  for (const id of ['4033888', '4033889', '4036847', '1003134']) {
    assert(items[id], `Missing original continuation item ${id}`);
    items[id].info = { ...items[id].info, tradeBlock: 1, dropBlock: 1 };
  }
  for (const id of ['36310', '36314']) {
    quest(id).objectives = quest(id).complete.conditions.items.map(item => ({
      kind: 'collect', itemId: item.itemId, required: item.quantity, text: items[item.itemId].name,
    }));
  }
  const maps = manifest.mapCatalog.maps;
  // Landing on the paired exit gate rather than the destination's default
  // `sp`: a WZ `sp` marks the authored spawn, which sits 26..129 px above the
  // walkable floor in these maps and dropped the player into mid-air.
  // `000030001/out00` is a source dangling reference: its authored `tn` is
  // `in01`, but 嫩寶花園 only has `in00`/`out00`, so the server fell back to the
  // spawn and dropped the player 63 px above the floor.  `Map/Map/Graph.json`
  // routes this edge to 嫩寶花園 without a named landing; `in00` is that map's
  // only authored entrance.
  for (const [mapId, name, targetMapId, targetPortalName] of [
    ['101000000', 'jobin00', '101000003', 'jobout00'],
    ['100000000', 'Achter00', '100000201', 'out02'],
    ['100000201', 'out02', '100000000', 'Achter00'],
    ['000030001', 'out00', '000030000', 'in00'],
  ]) {
    const portal = maps.find(m => m.id === mapId)?.portals.find(p => p.name === name);
    assert(portal, `Missing source scripted portal ${mapId}/${name}`);
    Object.assign(portal, { targetMapId, targetPortalName });
  }
  // P: the Ereve Olivia scene is missing. Reuse her original template at
  // this map's authored entry, visible only during quest 36309.
  const ereve = maps.find(m => m.id === '130000000');
  const entry = ereve?.spawn;
  assert(entry && manifest.npcs['1541003']);
  const olivia = gameplay.npcSpawns.find(n => n.templateId === '1541003');
  assert(olivia, 'Missing original Olivia source spawn');
  // Keep the original placement in chapter.json; this adapter has one
  // authoritative scene placement so quest navigation cannot point elsewhere.
  gameplay.npcSpawns = gameplay.npcSpawns.filter(n => n.templateId !== '1541003');
  const floor = ereve.footholds.find(f => f.id === 4);
  assert(floor && floor.x1 <= entry.x && floor.x2 >= entry.x && floor.y1 === floor.y2);
  gameplay.npcSpawns.push({
    ...olivia, id: 'story-36309-olivia', mapId: '130000000', x: entry.x, y: floor.y1,
    footholdId: floor.id, foothold: floor, cy: floor.y1, rx0: entry.x, rx1: entry.x,
    sourceSpawn: olivia.id, placementEvidence: 'P: original Olivia template on source Ereve entry floor; missing story scene script.',
  });
  gameplay.compatibility.adventurerContinuation = {
    ruleVersion: 'tms273-continuation-p1', sourceQuests: rows.map(row => row[0]),
    sourceRecord: 'references/tms273-data/adventurer-continuation-source.json',
    reference: 'https://www.maplesea.com/updates/view/v217_Patch_Notes_3/',
    temporaryRules: 'P: explicit mage-route NPC accept/claim; old mage jobs retain job/SP. EXP by quest is 0/300/450/600/750/900/1050/1200/1500, no mesos. Letter issued at Neinheart; hat issued at Rondo and must be equipped; after infiltration Rondo hands over recovered document/seal. Items cannot be traded/dropped. Story transport is recoverable at the issuing NPC. Olivia uses original art at the Ereve entry. Missing scripted library/training-centre portals use the selected local endpoints.',
    unknown: 'Original q1402/q363 execution, info1406 choice script, exact rewards, encounter/cutscene timing and original remote transport remain unavailable. Original text/Check retained; no auto-skip or synthetic quest completion on login.',
  };
}
module.exports = { applyChapter };
