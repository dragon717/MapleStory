#!/usr/bin/env node

// Build the 冒险笔记（图鉴）catalogue and rule tables.
//
// Two files come out, and the split is the whole point of the design:
//
//   notebook-catalog.json   what exists to be shown.  Item templates with
//                           their classification, and the monster collection's
//                           own region/page/row/slot structure.  A pure
//                           projection of content — it changes when the game
//                           version changes and never when a player acts.
//   monster-collection-rules.json
//                           what a registration/reward/exploration *means*.
//                           Every entry carries an evidence grade, and every
//                           grade that is `unverified` says so in words rather
//                           than carrying a made-up number.
//
// The distinction matters because the plan forbids the second file from
// inventing anything the source does not author (plan §3.3, §5.5).  The
// authored reward table is the place the two meet: the *catalogue* records
// which of the source's reward keys this client can even hand out, and the
// *rules* record that the condition for earning one is still unverified.
// Neither may imply the other.
//
// WHO CALLS THIS.  `scripts/assemble_tms273.cjs` calls `buildCatalog()` once,
// after the chapter/remaster adapters and after the cash-shop item definitions
// have been folded in, and writes the result to `shared/` and to the client
// asset tree.  That position is deliberate: the item tree is only final there.
// Running the generator earlier — or from the raw export — silently classifies
// the seven chapter-granted items and the whole cash catalogue as missing.
//
// Running this file directly is a *diagnostic*, not a build step: it reads the
// mid-pipeline export and reports the gap it expects.
//
// See docs/plan/topics/MapleStory_冒险笔记图鉴_复刻与扩展计划.md §2.4 / §5.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const INPUT = path.join(ROOT, 'resources/tms273-export');

/// Catalogue and rules carry their own versions.  They are *not* the runtime
/// content version: a catalogue rebuild that changes nothing a running client
/// can observe must not invalidate live sessions (plan §7.4).
const CATALOG_VERSION = 'notebook-catalog-4';
const RULES_VERSION = 'notebook-rules-1';

/// Item ids that are provably obtainable through a chain this build really
/// ships, collected from the assembled data instead of being listed by hand.
///
/// The one exception is the first-login grant, whose list lives in Rust
/// (`inventory::starter_items` / `starter_equipment`) and therefore cannot be
/// read from here; `scripts/check_tms273_notebook.cjs` re-reads that source and
/// fails if it stops matching, so the mirror cannot rot silently.
const INITIAL_GRANT_IDS = ['1302000', '1040002', '2430768'];

/// Canonical id: the project's single key form.  The export keeps both the
/// 7-digit and the 8-digit spelling of the same template; the catalogue must
/// never count them as two collectibles (plan §5.3).
function canonical(itemId) {
  if (!/^\d+$/.test(itemId)) return null;
  const value = Number(itemId);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return String(value);
}

/// Per-template classification.  Only fields whose meaning is established are
/// used: `inventoryType` and `info.islot` are read by the running game already,
/// and `info.quest` is the same-version tree's own quest marker.
function classify(item) {
  const info = item.info ?? {};
  const inventoryType = Number(item.inventoryType);
  const questMarker = info.quest === undefined ? null : Number(info.quest);
  const questSpecific = questMarker !== null && questMarker !== 0;
  return {
    inventoryType,
    questSpecific,
    questClassificationEvidence: questSpecific ? [`info.quest=${info.quest}`] : [],
    equipmentSlot: typeof info.islot === 'string' ? info.islot : null,
    isPet: /^Item\/Pet\//.test(String(item.source ?? '')),
  };
}

function buildCatalog({ notebook, items, mounts = {}, chairs = {}, gameplay, creation }) {
  // ------------------------------------------------------------- evidence --
  // Every obtainable chain this build actually ships, as (itemId -> evidence).
  const obtainable = new Map();
  const note = (itemId, evidence) => {
    const id = canonical(String(itemId));
    if (!id) return;
    if (!obtainable.has(id)) obtainable.set(id, new Set());
    obtainable.get(id).add(evidence);
  };
  for (const monster of gameplay.monsters) {
    for (const drop of monster.drop ?? []) note(drop.itemId, `drop:${monster.templateId}`);
  }
  for (const shop of gameplay.shops) {
    for (const row of shop.items ?? []) note(row.itemId, `shop:${shop.shopId}`);
  }
  for (const quest of gameplay.quests) {
    for (const row of quest.reward?.items ?? []) note(row.itemId, `questReward:${quest.questId}`);
    for (const row of quest.start?.items ?? []) note(row.itemId, `questStart:${quest.questId}`);
  }
  for (const gender of creation.genders ?? []) {
    for (const key of ['coat', 'pants', 'shoes', 'weapon']) {
      for (const itemId of gender[key] ?? []) note(itemId, `creation:${key}`);
    }
  }
  for (const itemId of INITIAL_GRANT_IDS) note(itemId, 'initialGrant:inventory::starter_*');
  for (const commodity of gameplay.cashShop?.commodities ?? []) note(commodity.itemId, `cashShop:${commodity.sn}`);
  // The collection's own authored rewards.  They are a real chain this build
  // ships, but a *blocked* one: the rule that turns a completed row into a
  // grant is unverified, so this evidence must not by itself make an item look
  // obtainable today (plan §5.5).  Hence the own token, excluded below.
  const authoredRewards = notebook.collection.rewardItems ?? {};
  for (const [itemId, reward] of Object.entries(authoredRewards)) {
    note(itemId, `collectionReward:${[...reward.roles].sort().join('+')}`);
  }
  /// Evidence that means "a player can reach this item through a chain this
  /// build actually runs".  A blocked chain does not count.
  const openChain = evidence => !evidence.startsWith('collectionReward:');

  // Static quest associations for an item.  An authored reward row is a real
  // association; it is *not* a registration, and never unlocks anything.
  const questsByItem = new Map();
  for (const quest of gameplay.quests) {
    for (const row of quest.reward?.items ?? []) {
      const id = canonical(String(row.itemId));
      if (!id) continue;
      if (!questsByItem.has(id)) questsByItem.set(id, new Set());
      questsByItem.get(id).add(String(quest.questId));
    }
  }

  const definitions = {};
  const excluded = [];
  let aliasDeduped = 0;
  const build = rawId => {
    const item = items[rawId];
    const id = canonical(rawId);
    const evidence = [...(obtainable.get(id) ?? [])].sort();
    const facts = classify(item);
    if (!Number.isInteger(facts.inventoryType) || facts.inventoryType < 1 || facts.inventoryType > 5) {
      excluded.push({ itemId: id, reason: `unsupported-inventory-type:${item.inventoryType}` });
      return;
    }
    // 椅子（`Item/Install/0301*`、`0302`）与骑宠同族：整表收进椅子页
    // （`sections.chair`），不再各留一件在物品页的设置分区里——同一件东西
    // 出现在两个分区会让页签不再是「无重叠全覆盖」。
    if (chairs[id]) {
      excluded.push({ itemId: id, reason: 'chair-family:notebook-chair-section' });
      return;
    }
    definitions[id] = {
      itemId: id,
      inventoryType: facts.inventoryType,
      questSpecific: facts.questSpecific,
      questClassificationEvidence: facts.questClassificationEvidence,
      // The three display references are pointers into catalogues that already
      // exist; the notebook never copies a name, a description or an icon.
      nameRef: `items.json:${id}.name`,
      descriptionRef: `items.json:${id}.description`,
      iconRef: `manifest.items:${id}`,
      equipmentSlot: facts.equipmentSlot,
      isPet: facts.isPet,
      questIds: [...(questsByItem.get(id) ?? [])].sort(),
      // "Obtainable" stays the strict §5.5 reading: a chain this build really
      // runs.  An item whose only authored chain is the (blocked) collection
      // reward is `unverified`, and the reward table below carries the separate
      // fact of whether a definition exists to hand it out at all.
      availability: evidence.some(openChain) ? 'obtainable' : 'unverified',
      sourceRefs: [String(item.source ?? '')].filter(Boolean),
      obtainEvidence: evidence,
    };
  };
  // Two passes so the canonical (no-leading-zero) spelling always wins: the
  // 8-digit alias of one template is the same collectible, and letting
  // whichever happened to appear first define it would make `sourceRefs`
  // depend on JSON key order.
  for (const rawId of Object.keys(items)) if (canonical(rawId) === rawId) build(rawId);
  for (const rawId of Object.keys(items)) {
    const id = canonical(rawId);
    if (!id) { excluded.push({ itemId: rawId, reason: 'not-a-decimal-item-id' }); continue; }
    if (id === rawId) continue;
    if (definitions[id]) aliasDeduped += 1;
    else build(rawId);
  }

  // ------------------------------------------------------------------ 骑宠 --
  // Mounts are a *separate* family, not another item section.  The source marks
  // them `notSale:1 / only:1`, so they appear in no drop, shop or quest row —
  // which is exactly why `shared/mounts.json` exists apart from `items.json`
  // and why the latter is the "obtainable today" denominator.  Folding 935
  // mounts into `items` would silently move that denominator, so the catalogue
  // declares them in their own table and its own section instead
  // (`server/src/inventory.rs::shipped_mounts` says the same).
  //
  // What is recorded per mount is only what the same-version source authors:
  // the taming-mob tier (`info.tamingMob`, the ride config the mount points at),
  // the level requirement and the availability derived from the same evidence
  // map the items use.  Name and icon stay references — they already ship in
  // `shared/mount-index.json` and the asset manifest.
  //
  // 同一个文件里其实住着**两个槽**的装备，源 `info.islot` 分得
  // 很清楚：`Tm` = 骑宠本体（带 `tamingMob`，骑着的就是它），`Sd` = 搭在坐骑上的
  // 鞍具（26 件，**没有** `tamingMob`，所以骑乘判定里它不是坐骑——服务端
  // `inventory::is_mount_item` 只看 `tamingMob`，同一条口径）。
  // 这里按槽拆成两张表、两个分区：一件东西只能属于一个页签，否则
  // 「分区是目录的无重叠全覆盖」这条不变式就没了，而记录归属也会有两个答案。
  const mountDefinitions = {};
  const saddleDefinitions = {};
  for (const [rawId, mount] of Object.entries(mounts)) {
    const id = canonical(rawId);
    if (!id || id !== rawId) { excluded.push({ itemId: rawId, reason: 'mount-id-not-canonical' }); continue; }
    const info = mount.info ?? {};
    const evidence = [...(obtainable.get(id) ?? [])].sort();
    const slot = typeof info.islot === 'string' ? info.islot : null;
    if (slot === 'Sd') {
      // 鞍具：只记源里有的东西（等级要求、槽位、可获得性）。**没有** `tamingMob`
      // 这一栏——源没给，编一个 0 或 null 都会被读成「它指向某个坐骑档」。
      saddleDefinitions[id] = {
        itemId: id,
        inventoryType: 1,
        reqLevel: Number.isFinite(Number(info.reqLevel)) ? Number(info.reqLevel) : null,
        equipmentSlot: slot,
        availability: evidence.some(openChain) ? 'obtainable' : 'unverified',
        obtainEvidence: evidence,
        nameRef: mount.name ? `mount-index.json:${id}.name` : null,
        iconRef: `manifest.items:${id}`,
        sourceRefs: [String(mount.source ?? '')].filter(Boolean),
      };
      continue;
    }
    mountDefinitions[id] = {
      itemId: id,
      inventoryType: 1,
      // 坐骑档（`info.tamingMob`）：源里真正决定它骑什么、多快的那一档配置。
      // 缺席（或指向源里没有的档）如实写 null，不猜一个档位。
      tamingMob: Number.isFinite(Number(info.tamingMob)) && info.tamingMob !== undefined ? Number(info.tamingMob) : null,
      reqLevel: Number.isFinite(Number(info.reqLevel)) ? Number(info.reqLevel) : null,
      equipmentSlot: slot,
      availability: evidence.some(openChain) ? 'obtainable' : 'unverified',
      obtainEvidence: evidence,
      // 名与图标归既有目录/素材表：本表只引用，不复制第二份权威。
      nameRef: mount.name ? `mount-index.json:${id}.name` : null,
      iconRef: `manifest.items:${id}`,
      sourceRefs: [String(mount.source ?? '')].filter(Boolean),
    };
  }

  // ------------------------------------------------------------------ 椅子 --
  // Chairs are the second family the source authors outside the item tree:
  // `Item/Install/0301*`、`0302`，shipped as `shared/chairs.json`（2799 件）。
  // The item tree carries exactly one of them (a single shop-sold chair), which
  // is why the setup page looked almost empty; the chair page owns the whole
  // family now, and the loop above drops any chair from the item definitions so
  // the sections stay a disjoint cover.
  //
  // Recorded per chair is only what the same-version source authors: the
  // recovery amounts (`info.recoveryHP` / `recoveryMP`) and — only when the
  // source really states it — the interval (`recoveryIntervalMs`, parsed out of
  // the authored `desc`; absent means "not核定", never a defaulted 10s).
  const chairDefinitions = {};
  for (const [rawId, chair] of Object.entries(chairs)) {
    const id = canonical(rawId);
    if (!id || id !== rawId) { excluded.push({ itemId: rawId, reason: 'chair-id-not-canonical' }); continue; }
    const info = chair.info ?? {};
    const evidence = [...(obtainable.get(id) ?? [])].sort();
    const number = value => (Number.isFinite(Number(value)) ? Number(value) : null);
    chairDefinitions[id] = {
      itemId: id,
      inventoryType: 3,
      // 恢复量与间隔。间隔缺席时如实写 null：`shared/chairs.json` 的契约就是
      // 「未核定」，运行时也不许套默认值，图鉴更不能替源编一个出来。
      recoveryHP: number(info.recoveryHP),
      recoveryMP: number(info.recoveryMP),
      recoveryIntervalMs: number(chair.recoveryIntervalMs),
      reqLevel: number(info.reqLevel),
      availability: evidence.some(openChain) ? 'obtainable' : 'unverified',
      obtainEvidence: evidence,
      // 名与图标归既有目录/素材表：本表只引用，不复制第二份权威。
      nameRef: chair.name ? `chair-names.json:${id}` : null,
      iconRef: `manifest.items:${id}`,
      sourceRefs: [String(chair.source ?? '')].filter(Boolean),
    };
  }

  // Section membership.  A quest-specific *equipment* template is legitimately
  // reachable from both the equipment page and the quest page — the two pages
  // reference the same acquisition fact, so nothing is stored twice and the
  // four page counts are never summed into one total (plan §2.4.5).
  const sections = { equipment: [], use: [], setup: [], etc: [], cash: [], pet: [], mount: [], saddle: [], chair: [], quest: [] };
  // 骑宠分区＝`Tm` 槽那一半，鞍具分区＝`Sd` 槽那一半；两张表加起来仍是
  // `shared/mounts.json` 的整份键集（`check_tms273_notebook.cjs` 反向核这一条）。
  sections.mount.push(...Object.keys(mountDefinitions));
  sections.saddle.push(...Object.keys(saddleDefinitions));
  // 椅子分区就是整张椅子表：本版本几乎没有开放获取途径，所以这一页的基集合是全集，
  // 少一件等于这一页少一件。
  sections.chair.push(...Object.keys(chairDefinitions));
  for (const definition of Object.values(definitions)) {
    const { itemId, inventoryType, questSpecific, isPet } = definition;
    if (questSpecific) sections.quest.push(itemId);
    if (isPet) { sections.pet.push(itemId); continue; }
    if (inventoryType === 1) sections.equipment.push(itemId);
    else if (questSpecific) continue; // quest-only consumables stay off the ordinary page
    else if (inventoryType === 2) sections.use.push(itemId);
    else if (inventoryType === 3) sections.setup.push(itemId);
    else if (inventoryType === 4) sections.etc.push(itemId);
    else if (inventoryType === 5) sections.cash.push(itemId);
  }
  for (const ids of Object.values(sections)) ids.sort((a, b) => Number(a) - Number(b));

  // ------------------------------------------------------- authored rewards --
  // The region/page/row reward keys the source authors, and the one thing that
  // decides whether this build could ever pay them out: does the same-version
  // client ship a definition for the item?
  //
  // Resolution happens in `export_tms273_collection.cjs` (it owns the source
  // tree and records the exact file each fact came from); this table only maps
  // that onto the assembled catalogue and refuses to let the two disagree.
  // `definitionStatus: json-present` with no catalogue entry means the reward
  // backfill did not run, which is a build-order bug and not a source boundary
  // — `check_tms273_notebook.cjs` fails on it.
  const rewardItems = {};
  /// The source's own names for the three authored reward levels.  Evidence
  /// text keeps the source wording; player-visible refusal reasons do not.
  const ROLE_LABEL = { row: '行', page: '分頁', region: '地區' };
  for (const [rawId, reward] of Object.entries(authoredRewards)) {
    const id = canonical(rawId);
    assert(id && id === rawId, `收藏奖励键不是规范化物品 id: ${rawId}`);
    const shipped = definitions[id];
    const definitionMissing = reward.statStatus !== 'json-present';
    const roles = [...reward.roles].sort();
    const references = roles.reduce((sum, role) => sum + reward.referenceCounts[role], 0);
    rewardItems[id] = {
      itemId: id,
      roles,
      referenceCounts: reward.referenceCounts,
      // An item with a catalogue entry of its own is referenced, never copied:
      // its name, description and icon already live in the item tree.  The
      // reverse mapping (which rows hand this key out) stays derivable from
      // `monsterStructure.rows[*].rewardItemId` rather than copied here.
      nameRef: shipped ? `items.json:${id}.name` : reward.nameSource,
      name: shipped ? null : reward.name,
      description: shipped ? null : reward.description,
      nameSource: reward.nameSource,
      definitionSource: reward.statSource,
      definitionStatus: reward.statStatus,
      inItemIndex: Boolean(shipped),
      definitionAvailable: Boolean(shipped) && !definitionMissing,
      reason: definitionMissing
        ? `该奖励物品在本版客户端没有物品定义（未找到 ${id} 的道具 JSON），无法在不编造属性的前提下发放。`
        : null,
      evidence: [
        `T: rewardID ${id} 由 Etc/mobCollection.img 的${roles.map(role => ROLE_LABEL[role]).join('、')}奖励授权，共 ${references} 处引用。`,
        reward.nameSource ? `T: 名称/说明来自 ${reward.nameSource}。` : 'U: 同版 String 表没有该 id 的名称记录。',
        reward.statSource
          ? `T: 物品定义来自 ${reward.statSource}。`
          : 'U: Item/** 与 Character/** 都没有该 id 的道具 JSON，属于源内边界而非本项目的导出缺口。',
        'U: 源没有给出这三层奖励的达成条件与数量，因此奖励本身仍不可领取。',
      ],
    };
  }

  // -------------------------------------------------------------- monsters --
  // The monster half is a re-key of the exported structure: the catalogue keeps
  // the authored region/page/row/slot identity, and the rules file keeps the
  // authored reward and exploration columns.
  const monsterEntries = [];
  const rows = {};
  const regions = {};
  for (const region of notebook.collection.regions) {
    regions[String(region.region)] = {
      region: region.region,
      name: region.name,
      recordId: region.recordId,
      rewardItemId: region.rewardItemId,
      pages: region.pages.map(page => page.page),
    };
    for (const page of region.pages) {
      for (const row of page.rows) {
        const rowKey = `mc-${region.region}-${page.page}-${row.row}`;
        assert(!rows[rowKey], `duplicate collection row key ${rowKey}`);
        rows[rowKey] = {
          rowKey,
          region: region.region,
          regionName: region.name,
          page: page.page,
          pageName: page.name,
          row: row.row,
          name: row.name,
          recordId: row.recordId,
          rewardItemId: row.rewardItemId,
          explorationCycleMinutes: row.explorationCycleMinutes,
          explorationRewardSelector: row.explorationRewardSelector,
          entryIds: row.slots.map(slot => slot.entryId),
        };
        for (const slot of row.slots) {
          monsterEntries.push({
            entryId: slot.entryId,
            monsterTemplateId: slot.monsterTemplateId,
            rowKey,
            region: region.region,
            page: page.page,
            row: row.row,
            slot: slot.slot,
            sourceType: slot.sourceType,
            tooltip: slot.tooltip,
          });
        }
      }
    }
  }
  const entryIds = new Set(monsterEntries.map(entry => entry.entryId));
  assert.equal(entryIds.size, monsterEntries.length, 'duplicate collection entry id');

  // Which slots this build can actually reach.  The authored row/page reward
  // still counts the full original set — the reduced denominator below is a
  // *summary* and is never used as a reward condition (plan §5.5).
  const deployed = new Set(gameplay.monsters.map(monster => String(Number(monster.templateId))));
  const textByTemplate = notebook.monsterText.monsters;
  for (const entry of monsterEntries) {
    entry.collectable = deployed.has(entry.monsterTemplateId);
    entry.hasEpisode = Boolean(textByTemplate[entry.monsterTemplateId]?.episode);
  }

  const catalog = {
    catalogVersion: CATALOG_VERSION,
    contentVersion: gameplay.contentVersion,
    source: {
      notebook: notebook.sourceAudit,
      items: 'assembled item catalogue',
      gameplay: 'assembled gameplay catalogue',
    },
    sections,
    itemDefinitionCount: Object.keys(definitions).length,
    // The alias bookkeeping the plan asks every catalogue rebuild to report.
    aliasDedupe: { deduped: aliasDeduped },
    items: definitions,
    // 骑宠是独立表：不在 `items`（那份是可获得分母），只在自己的分区里。
    mounts: mountDefinitions,
    mountCount: Object.keys(mountDefinitions).length,
    // 鞍具（同文件的 `Sd` 槽 26 件）同理独立成表：它不是坐骑（没有 `tamingMob`），
    // 却也不属于物品页，所以既不能混进 `mounts` 让「骑宠」页混着不是骑宠的东西，
    // 也不能落进 `items` 改动可获得分母。
    saddles: saddleDefinitions,
    saddleCount: Object.keys(saddleDefinitions).length,
    // 椅子同理（`Item/Install/0301*`、`0302`，`shared/chairs.json`）：独立表 +
    // 独立分区，物品页一件也不留。
    chairs: chairDefinitions,
    chairCount: Object.keys(chairDefinitions).length,
    monsterStructure: { regions, rows },
    monsterEntryCount: monsterEntries.length,
    monsterEntries: Object.fromEntries(monsterEntries.map(entry => [entry.entryId, entry])),
    monsterText: textByTemplate,
    // `String/MonsterBook.img/<id>/reward/*` is *not* a collection reward, even
    // though the node is named `reward`: it is the drop list the source's own
    // monster card prints, and the catalogue must not hand it to the reward
    // pipeline.  That reading is evidence-backed, not a preference — of the 40
    // deployed monsters that author both, the node overlaps the monster's real
    // drop table by 13.4 of 24.6 items on average (a collection reward would
    // not track drops at all), and the row/page/region keys above are the ones
    // the source's collection window itself pays out.
    monsterTextSemantics: {
      reward: 'P: 逐怪 `reward` 节点是怪物卡片显示的掉落物清单，不是收藏奖励；证据是同版 40 只已装配怪物中该节点与真实掉落表平均重叠 13.4/24.6 项。本项目只把它当作卡片展示数据，从不据此发奖。',
    },
    rewardItems,
    rewardItemCount: Object.keys(rewardItems).length,
    definitionMissingRewardCount: Object.values(rewardItems).filter(reward => reward.definitionStatus !== 'json-present').length,
    collectableEntryCount: monsterEntries.filter(entry => entry.collectable).length,
    excluded,
  };

  // ----------------------------------------------------------------- rules --
  const rules = {
    rulesVersion: RULES_VERSION,
    catalogVersion: CATALOG_VERSION,
    contentVersion: gameplay.contentVersion,
    // Ownership defaults the plan fixes for this feature (plan §2.3).
    scope: {
      monsterCollection: 'account',
      itemRecords: 'character',
      monsterCollectionEvidence: 'P: the modern collection is an account-level structure; the same-version export authors no per-character field either way.',
      itemRecordsEvidence: 'P: minimal scope, so one quest line cannot leak across characters; an account view can be projected from the per-character facts later.',
    },
    registration: {
      mode: 'unverified',
      probability: null,
      qualificationGate: null,
      evidence: 'U: Etc/mobCollection.img authors no registration probability, level gate, party rule or per-slot grade for any slot. String/MonsterBook.img authors text, spawn maps and reward items only.',
      blockedReason: '该收藏规则尚未核定：同版源不含登记概率与资格门，无法在不编造数值的前提下自动登记。',
      // A test drives the same code path with an injected roll, so the
      // mechanics are checkable without a production probability.
      testInjection: '登记管线接受注入的判定结果，用于在正式概率缺失时仍可验证「一次死亡一次已结算、唯一键幂等、revision 递增」这些机制。',
    },
    rewards: {
      row: {
        mode: 'unverified',
        rewardItemIdFrom: 'T: each authored row carries its own `rewardID`.',
        condition: null,
        candidateCondition: 'P: every slot of the row registered.',
        blockedReason: '该行的达成条件未核定：源只给出行奖励物品，没有逐行完成条件。',
      },
      page: {
        mode: 'unverified',
        rewardItemIdFrom: 'T: each authored page (分頁) carries its own `rewardID`.',
        condition: null,
        candidateCondition: 'P: every row of the page complete.',
        blockedReason: '该分页的达成条件未核定。',
      },
      region: {
        mode: 'unverified',
        rewardItemIdFrom: 'T: each authored region (地區) carries its own `rewardID`.',
        condition: null,
        candidateCondition: 'P: every page of the region complete.',
        blockedReason: '该地区的达成条件未核定。',
      },
      delivery: 'A claim is one transaction: eligibility, the granted item, its acquisition fact and the receipt.  An ineligible or full-inventory claim refuses without consuming the eligibility.',
      // A second, independent blocker: even a rule that was fully verified
      // could not pay these out, because the client ships no definition for
      // part of the authored reward set.  Kept apart from the condition facts
      // so unblocking one never silently implies the other.
      itemAvailability: {
        mode: 'P',
        deliverableCount: Object.values(rewardItems).filter(reward => reward.definitionAvailable).length,
        definitionMissingCount: Object.values(rewardItems).filter(reward => !reward.definitionAvailable).length,
        evidence: 'T: every authored region/page/row `rewardID` is resolved against the same-version client (stat JSON under Item/** or Character/** plus the name in String/*.json) and the result is recorded per key in `notebook-catalog.json#rewardItems`.  That resolution is what the reward backfill imports from, so a key marked `json-present` really is in the assembled item catalogue.',
        blockedReason: Object.values(rewardItems).some(reward => !reward.definitionAvailable)
          ? '有原版奖励物品在本版客户端没有物品定义（方塊椅子系列等），在补上定义或改用可发放的替代奖励之前，这些行 / 页 / 地区奖励不能发放。'
          : null,
      },
    },
    exploration: {
      mode: 'unverified',
      cycleMinutesFrom: 'T: each authored row carries `exploraionCycle`.',
      rewardSelectorFrom: "T: each authored row carries `exploraionReward`, an index into the source's `ExplorationRewardIcon` table.",
      slotCount: null,
      slotCountEvidence: 'U: the source authors no exploration slot count or unlock threshold.  This build runs a single slot (P) so the mechanic stays observable without inventing a progression table.',
      dailyLimit: null,
      dailyLimitEvidence: 'U: the source authors no daily claim limit; none is enforced.',
      blockedReason: '探险的组合资格依赖已核定的登记规则，而登记概率未核定，因此探险在正式内容中保持阻塞。',
      delivery: 'startedAt / finishesAt are persisted; the client renders the remaining time but never owns it.  A claim before finishesAt is refused from the server clock.',
    },
    sourceType: {
      mode: 'unverified',
      evidence: 'P: the per-slot `type` field exists in the source and is exported verbatim, but its meaning is not established.  It is shown as a raw marker and never used as a condition.',
    },
    collectableSummary: {
      mode: 'P',
      evidence: "T: the deployed monster templates come from the assembled gameplay catalogue; P: using them as the \"collectable today\" summary denominator is this project's presentation choice, not a source fact.",
    },
  };

  return { catalog, rules, aliasDeduped, excluded };
}

/// Diagnostic entry: read the mid-pipeline export and report the gap that the
/// assemble-time call is expected to close.  Never used as a build step.
function main() {
  const read = name => JSON.parse(fs.readFileSync(path.join(INPUT, `${name}.json`), 'utf8'));
  const items = read('items');
  const cashshop = read('cashshop');
  const mergedFromCashShop = [];
  for (const [rawId, definition] of Object.entries(cashshop.itemDefinitions ?? {})) {
    const key = String(Number(rawId));
    if (!(key in items)) { items[key] = definition; mergedFromCashShop.push(key); }
    const alias = key.padStart(8, '0');
    if (!(alias in items)) items[alias] = items[key];
  }
  const { catalog, rules, aliasDeduped } = buildCatalog({
    notebook: read('notebook'),
    items,
    // 骑宠不在导出物品树里，本表是它的唯一来源（`shared/mounts.json`）。
    mounts: JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/mounts.json'), 'utf8')).items,
    // 椅子同理：`shared/chairs.json`（`Item/Install/0301*`、`0302`）。
    chairs: JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/chairs.json'), 'utf8')).items,
    gameplay: read('gameplay'),
    creation: JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/character-creation.json'), 'utf8')),
  });
  const write = (name, value) => {
    const file = path.join(INPUT, `${name}.json`);
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return file;
  };
  console.log(JSON.stringify({
    mode: 'diagnostic (pre-chapter item set)',
    catalog: write('notebook-catalog', catalog),
    rules: write('notebook-rules', rules),
    itemDefinitions: Object.keys(catalog.items).length,
    mountDefinitions: catalog.mountCount,
    saddleDefinitions: catalog.saddleCount,
    chairDefinitions: catalog.chairCount,
    aliasDedupe: { deduped: aliasDeduped, mergedFromCashShop: mergedFromCashShop.length },
    sections: Object.fromEntries(Object.entries(catalog.sections).map(([key, ids]) => [key, ids.length])),
    monsterEntries: catalog.monsterEntryCount,
    collectable: catalog.collectableEntryCount,
    rows: Object.keys(catalog.monsterStructure.rows).length,
    regions: Object.keys(catalog.monsterStructure.regions).length,
    rewards: {
      total: catalog.rewardItemCount,
      deliverable: Object.values(catalog.rewardItems).filter(reward => reward.definitionAvailable).length,
      definitionMissing: catalog.definitionMissingRewardCount,
    },
    registration: rules.registration.mode,
  }, null, 2));
}

module.exports = { ROOT, INPUT, CATALOG_VERSION, RULES_VERSION, INITIAL_GRANT_IDS, canonical, buildCatalog, main };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
