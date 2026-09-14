// 楓之島災禍篇 36315「奧莉維亞的特別修練」的最小场景执行（P）。
//
// 为什么需要这一步：36315 的完成条件是一次**已核定的击杀**——源 QuestData 的
// `Check.1.infoex` 是 kill 计数器，QuestInfo 的 demandSummary 直接写着
// 「擊殺藍色蘑菇王 (#R36315ExkillRef36315#)」，目标模板 8645261 见
// `references/tms273-data/maple-island-calamity-source.json` 的
// `classification.kill`。但 8645261 在原版只出现在专用修練地图 993166xxx 里，而那
// 批地图的几何在本地不可解（该记录 uBoundaries 的 U-993166-maps）。没有可击杀目标
// 时，任务规格再完整也永远完不成——这正是审计 C02「被阻塞的续章入口」。
//
// 所以这里只做一件事：把 8645261 放到一张已装配、且从出生图经传送门可达的地图
// 上。这是 P 适配，不是原作事实：
//   - 选址依据是任务文本（"特別修練"）与模块名（楓之島災禍篇）：001010000
//     冒險者修練場入口 是楓葉島的训练图，链路 000010000（出生图）→ 001000000
//     楓葉村 → 001010000；
//   - 地形锚点复用该图已有刷怪记录的地形段与巡逻约定（服务端在
//     `monsters.rs::spawn_monster_on_map` 里按 footholdId 把怪物吸附到地面并重算
//     y），不新造坐标，也不改任何原作地图的 life 记录。
//
// 只放 8645261。36319/36322 的 8645264/8645262 不放：这两条任务的完成阶段在源
// QuestInfo 里没有 `selfComplete`（只有 `selfStart`），按本项目口径仍是
// script-scene 边界，放怪不会让它们可达，加了反而是没有验收依据的内容。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const CALAMITY_SOURCE = path.join(
  root,
  'references/tms273-data/maple-island-calamity-source.json',
);

// 每一项都要能追到"哪条任务、哪个已核定目标、为什么放在这张图"。
const PLACEMENTS = [
  {
    questId: '36315',
    mobId: '8645261',
    mapId: '001010000',
    // 复用的地形锚点：同图已有的一条刷怪记录，取它的 footholdId / 巡逻范围 /
    // 朝向，保证新刷怪落在真实可走的地形段上。
    anchorSpawnId: '001010000-life-0',
    x: -450,
  },
];

function applyCalamity(gameplay, manifest) {
  const record = JSON.parse(fs.readFileSync(CALAMITY_SOURCE, 'utf8'));
  const sourceQuests = new Map(
    (record.quests || []).map(quest => [String(quest.id), quest]),
  );
  const catalogMaps = new Map(
    manifest.mapCatalog.maps.map(map => [String(map.id), map]),
  );

  for (const placement of PLACEMENTS) {
    // 来源必须仍然支持这次放置：任务在已核定记录里，且击杀目标没变。
    const quest = sourceQuests.get(placement.questId);
    assert(quest, `Calamity source record is missing quest ${placement.questId}`);
    const kill = quest.classification && quest.classification.kill;
    assert(
      kill && String(kill.mobId) === placement.mobId,
      `${placement.questId} verified kill target changed; review the placement`,
    );
    const monster = (record.monsters || {})[String(placement.mobId)];
    assert(
      monster,
      `Calamity source record has no stats for ${placement.mobId}`,
    );

    // 模板由 generate_tms273_gameplay.py 以 P 模板生成（同 practice Boss 的做法），
    // 没有模板就没有可刷的怪。
    const template = gameplay.monsters.find(
      mob => String(mob.templateId) === placement.mobId,
    );
    assert(
      template,
      `Calamity monster template ${placement.mobId} was not generated`,
    );

    const map = catalogMaps.get(placement.mapId);
    assert(
      map,
      `Calamity placement map ${placement.mapId} is not in the assembled catalog`,
    );
    const anchor = gameplay.spawns.find(
      spawn => spawn.id === placement.anchorSpawnId,
    );
    assert(
      anchor && String(anchor.mapId) === placement.mapId,
      `Calamity terrain anchor ${placement.anchorSpawnId} is missing from ${placement.mapId}`,
    );
    const foothold = (map.footholds || []).find(
      line => Number(line.id) === Number(anchor.footholdId),
    );
    assert(
      foothold,
      `Calamity anchor foothold ${anchor.footholdId} is missing on ${placement.mapId}`,
    );
    // 新刷怪必须落在锚点地形段的 x 区间内，否则服务端吸附不到地面。
    const low = Math.min(Number(foothold.x1), Number(foothold.x2));
    const high = Math.max(Number(foothold.x1), Number(foothold.x2));
    assert(
      placement.x >= low && placement.x <= high,
      `Calamity x ${placement.x} is outside foothold ${anchor.footholdId} (${low}..${high})`,
    );
    assert(
      placement.x !== anchor.x,
      'Calamity spawn must not stack on its terrain anchor',
    );

    const spawn = {
      id: `${placement.mapId}-calamity-${placement.mobId}`,
      mapId: placement.mapId,
      templateId: placement.mobId,
      x: placement.x,
      // 服务端按 footholdId 重算 y；这里的 y 只是锚点记录值。
      y: anchor.y,
      facing: anchor.facing,
      // 0 = 用地图的正常重生周期，玩家打不死也能重来。
      mobTime: 0,
      source: `P: quest${placement.questId} verified kill target ${placement.mobId} (${monster.name || ''}); source map 993166xxx is not decodable locally, placed on the reachable ${placement.mapId} via anchor ${placement.anchorSpawnId}`,
      footholdId: anchor.footholdId,
      rx0: anchor.rx0,
      rx1: anchor.rx1,
    };
    assert(
      !gameplay.spawns.some(existing => existing.id === spawn.id),
      `Calamity spawn ${spawn.id} already exists`,
    );
    gameplay.spawns.push(spawn);
  }

  gameplay.compatibility.mapleIslandCalamity = {
    ruleVersion: 'tms273-calamity-p1',
    sourceRecord: 'references/tms273-data/maple-island-calamity-source.json',
    // T：来源记录核定的任务、怪物与击杀目标。
    sourceQuests: (record.quests || []).map(quest => String(quest.id)),
    placements: PLACEMENTS.map(placement => ({
      questId: placement.questId,
      mobId: placement.mobId,
      mapId: placement.mapId,
      anchorSpawnId: placement.anchorSpawnId,
      x: placement.x,
    })),
    placed: 'T: 36315 的击杀目标是已核定的 8645261 藍色蘑菇王（source QuestInfo demandSummary「擊殺藍色蘑菇王 #R36315ExkillRef36315#」+ Check.1.infoex kill）。P: 原版专用地图 993166xxx 几何本地不可解（U-993166-maps），改放在已装配且从出生图可达的 001010000 冒險者修練場入口，地形锚点复用该图已有刷怪记录，不新造坐标，也不改原作地图的 life。',
    notPlaced: 'U: 36319/36322 的 8645264/8645262 不放置——这两条任务的完成阶段在源 QuestInfo 里没有 selfComplete，按 script-scene 边界登记，放置不会让它们可达。36316/36317/36318/36320/36321/36323/36324 同样缺源可执行依据，保持边界。',
  };

  return { placed: PLACEMENTS.length };
}

module.exports = { applyCalamity, PLACEMENTS };

if (require.main === module) {
  const gameplay = JSON.parse(
    fs.readFileSync(path.join(root, 'shared/gameplay.json'), 'utf8'),
  );
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(root, 'client/public-tms273/assets/manifest.json'),
      'utf8',
    ),
  );
  console.log(JSON.stringify(applyCalamity(gameplay, manifest), null, 2));
}
