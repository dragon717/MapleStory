#!/usr/bin/env node
'use strict';
// ============================================================================
// 传送闭包判据（根因封堵）——「装配目录里的每一扇门都得有人接」
// ============================================================================
//
// ## 为什么要这个文件
//
// 2026-09-21「勇士部落的所有地图 传送链接」：玩家在 `102030000 黑肥肥領土` 往西走，
// 撞上 `west00 → 102030100 野豬領土` 的门，客户端提示「此路线尚未开放」。查下去
// 不是接线错了——已装配的 13 张勇士部落地图与源**逐门全等**；死的是**目标图从没
// 装配过**：勇士部落在源里共 29 张图（`String.wz/Map.img/victoria` 按 `streetName`
// 归簇），装配目录里只有 13 张。
//
// 该发现的工具是 `artifacts/portal_closure_check.py`，但它把
// `WZ_JSON_TW/Map/Map/MapX/` 当源，而那是「已装配图的解包副本」——天然只含当时
// 已解包进来的图。于是 `102030100` 被 `portals_of()` 判成 `None`，打成
// 「SOURCE MISSING」后 `continue`，既没进「该装配」名单，也**没有继续 BFS**，
// 背后那 11 张同簇图因此从未被发现（详见
// `evidence/2026-09-21/perion-portal-links/根因核对.md` §3）。
//
// ## 判据形状：显式白名单 + 逐边机械核对
//
// 不再「从某个源树**推导**出该装配哪些图」（推导的判据源一错就静默漏一片），
// 而是反过来：**把边界写成显式数据表**，然后机械地核对它。
//
//   A 闭包（核心，只读 tracked 产物 `shared/maps.json`）
//     —— 每张已装配图的每个跨图 `tm`，必须「目标已装配」或「在 `PORTAL_BOUNDARIES` 里」
//   B 无陈旧 —— 白名单每条必须**仍然是**某张已装配图的真实未装配落点
//     （补上了就该删；这条与 A 反向，防白名单腐烂成垃圾桶）
//   C 形状   —— 白名单 id 必须 9 位数字、未装配、唯一、按 id 升序、kind 在枚举内
//   D 源存在（源核对模式，见下）—— 每条都能在**权威客户端打包 WZ**里打开
//     （旧工具正是在这一步翻车：把「镜像里没有」读成「源里没有」）
//   E 源分类 —— 声明的 `kind` 必须与源的浅层 BFS 一致，且门形态必须对得上：
//       `leaf`   源静态门、展开 0（室内/子图/单节点，装了也走不到第二张）—— 无害
//       `region` 源静态门、展开 >0（区域延伸，本次刻意不装，**须另立项**）
//       `script` 源 `tm` 是 `999999999` 哨兵，目标由 `scripts/tms273_remaster.cjs`
//                的 T2 表给出（自由市場/匠人街/隐藏图这类全局系统图）
//     —— 把 `region` 冒充 `leaf`，就是又把「漏装一批图」伪装成「一间小屋」。
//
//   F 未分发落点（`entry.unshippedTargets`）—— BFS 展开时必须跳过的 id，且**必须声明**。
//     场景：某扇门指向一张**真地图**（`String/Map.img` 里有名有姓），但这张图的
//     `<id>.img` 没随本包分发（本包是裁剪版，`957020004 末日反抗軍本部／病房`即一例；
//     同组 `957020002/005/006`、`910240000`、`931010000` 在 `Map9` 里都打得开）。
//     这种落点既装配不了、又不属于 A 的「漏装」形状，所以只能显式登记。
//     **两条反向断言**把声明钉死，防它腐烂成「什么都往里塞」：
//       ① 它在权威 Map 分卷里**确实打不开**——哪天源补齐了、能打开了，这里立刻红，
//          逼你去装配，而不是继续挂在表里；
//       ② 它在权威 `String/Map.img` 里**确实被命名**——写错 id、或塞一张根本不存在的图，
//          也会红。**不登记**的未分发落点仍然走原来的 `assert(portals, …)` 那条硬断言，
//          所以这个字段没法用来「静默吞掉」真正的漏装（那正是 2026-09-21 的病根）。
//
// ## 源核对模式什么时候跑
//
// 权威源树在 .gitignore 里（`参考/`），不是每台机器都有，所以默认**自动探测**：
// 在就跑 D+E，不在就打印一行显式 SKIP（**不是静默通过**）。`--source` 强制要求
// 必须在（装配流水线里用它），`--no-source` 强制跳过。
//
//   node scripts/check_tms273_portal_closure.cjs              # 自动
//   node scripts/check_tms273_portal_closure.cjs --source      # 源必须在
//   node scripts/check_tms273_portal_closure.cjs --print       # 只打印当前边界集
//
// `--catalog <file>` 可换一份装配目录做离线取证（例如
// `git show HEAD:shared/maps.json > /tmp/before.json`，用它复现「修复前两条死门」）。
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const data = path.join(root, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');

const argv = process.argv.slice(2);
const printOnly = argv.includes('--print');
const forceSource = argv.includes('--source');
const skipSource = argv.includes('--no-source');
const catalogIndex = argv.indexOf('--catalog');
const catalogPath = catalogIndex >= 0
  ? path.resolve(argv[catalogIndex + 1] ?? assert.fail('--catalog 后面要给文件路径'))
  : path.join(root, 'shared/maps.json');

// ---------------------------------------------------------------------------
// 边界数据表：**装配目录之外**、但被已装配图的某扇门指着的落点。
//
// 每一条都是一次**明确的取舍**，不是遗漏。加条目必须写清理由；补装了就删条目
// （B 会逼你删）。`kind` 的含义见文件头 E。
// ---------------------------------------------------------------------------
const PORTAL_BOUNDARIES = [
  // ---- 維多利亞港 / 楓之島
  { id: '100000101', kind: 'leaf', reason: '維多利亞港 100000100/in00 的室内（出口 out00 回 100000100）' },
  { id: '100000102', kind: 'leaf', reason: '維多利亞港 100000100/in01 的室内' },
  { id: '100000103', kind: 'leaf', reason: '維多利亞港 100000100/in04 的室内' },
  { id: '100000104', kind: 'leaf', reason: '維多利亞港 100000100/in05 的室内' },
  { id: '100000105', kind: 'leaf', reason: '維多利亞港 100000100/in06 的室内' },
  { id: '100000203', kind: 'leaf', reason: '100000200/in00 的室内：本图只有 h00x/up0x 自环与 out00 回 100000200' },
  { id: '100020100', kind: 'region', reason: '維多利亞港東側草原链（→100020200/101/300/301/400），未装配' },
  { id: '100030320', kind: 'region', reason: '100030400/east00 通向的南部链（→100030310/300/200），未装配' },
  { id: '100051010', kind: 'region', reason: '100020000/east00 通向的森林链（→100051011/12/13），未装配' },
  { id: '101020100', kind: 'region', reason: '101020000/north00 通向的維多利亞北链（→200/300/400 等 7 张），未装配' },
  { id: '103010000', kind: 'region', reason: '103010100/west00 通向的 103 街区（→103050000 等 8 张），未装配' },
  { id: '120010000', kind: 'region', reason: '120010100/east00 通向的路德斯链（→120000400/000/100），未装配' },
  { id: '130010000', kind: 'region', reason: '飛行船 130000200/west00 通向的路德斯城链（→130010100 等 6 张），未装配' },
  { id: '130030005', kind: 'script', reason: '130030006/east00（pt_01_130030006，portalNum 4）→ 離開遺忘的森林的路' },
  // ---- 天空之城
  { id: '200000200', kind: 'region', reason: '天空之城 200000000/west00 通向的西侧链（→200000203/202/201），未装配' },
  { id: '200000300', kind: 'leaf', reason: '天空之城 200000000/guild00 的公会本部：出口 out00 回本城' },
  { id: '200010000', kind: 'region', reason: '天空之城 200000000/east00 通向的庭園链（→200010100 等 11 张），未装配' },
  { id: '200080100', kind: 'region', reason: '天空之城 200000000/tower00 通向的大塔链（→200080200/300/400），未装配' },
  // ---- 玩具城
  { id: '220000003', kind: 'leaf', reason: '玩具城 220000000/in03 的室内' },
  { id: '220000004', kind: 'leaf', reason: '玩具城 220000000/in04 的室内' },
  { id: '220000005', kind: 'leaf', reason: '玩具城 220000000/in05 的室内' },
  { id: '220000006', kind: 'leaf', reason: '玩具城 220000000/in06 的室内' },
  { id: '220000301', kind: 'leaf', reason: '220000300/in00 的室内' },
  { id: '220000302', kind: 'leaf', reason: '220000300/in01 的室内' },
  { id: '220000303', kind: 'leaf', reason: '220000300/in02 的室内' },
  { id: '220000304', kind: 'leaf', reason: '220000300/in03 的室内' },
  { id: '220000305', kind: 'leaf', reason: '220000300/in04 的室内' },
  { id: '220000306', kind: 'leaf', reason: '220000300/in05 的室内' },
  { id: '220000307', kind: 'leaf', reason: '220000300/in06 的室内' },
  { id: '220010500', kind: 'region', reason: '玩具城 220000000/tower00 通向的玩具塔链（→22001xxxx/22002xxxx 共 15 张），未装配' },
  // ---- 埃德爾斯坦
  // `in02 → 957020004` 是本包**唯一**「指向一张真地图、但该图贴图没随包分发」的边：
  // 它在权威 `String/Map.img/etc` 里被命名为「末日反抗軍本部／病房」，同组的
  // `957020002/005/006`、`910240000`、`931010000` 在 `Map9` 分卷里**都打得开**
  // （见 `unshippedTargets` 的两条反向断言）。故该图既装配不了、也不该记成
  // 「非地图」——那是一句会被下一个人当成真的谎话。
  { id: '310010010', kind: 'leaf', reason: '埃德爾斯坦 310010000/in00 的室内（另有 in02 → 957020004，本包未分发该图贴图）',
    unshippedTargets: ['957020004'] },
  { id: '310020100', kind: 'region', reason: '埃德爾斯坦 310020000/west00 通向的礦山链（→310020200/931010000），未装配' },
  { id: '310030110', kind: 'leaf', reason: '310030100/in00 的室内' },
  { id: '310030310', kind: 'leaf', reason: '310030300/in00 的室内' },
  { id: '310040110', kind: 'leaf', reason: '310040100/in00 的室内' },
  { id: '310040400', kind: 'leaf', reason: '310040300/west00 通向的 310040400（出口 east00 回 310040300），单节点孤岛但走的是可见门' },
  { id: '310070100', kind: 'region', reason: '埃德爾斯坦 310030300/east01 通向的 31007 街区（→310070000 等 6 张），未装配' },
  // ---- 脚本门指向的全局系统图（源 `tm` 是 999999999 哨兵，目标只存在于脚本表）
  { id: '910000000', kind: 'script', reason: '310000000/market00（脚本 market19，Graph portalNum 16）→ 自由市場入口；本仓库无自由市場玩法' },
  { id: '910001000', kind: 'script', reason: '310000000/profession（profession09，portalNum 22）→ 專業技術村；全局系统' },
  { id: '913060000', kind: 'script', reason: '130000200/in01（cygnus_q20754，portalNum 6）→ 隐藏图（连 String/Map.json 都没有名字）' },
  { id: '931060000', kind: 'script', reason: '310000000/inXenonHouse（check_23637，portalNum 24）→ 空蕩蕩的房子（活动房）；本包未分发该图贴图',
    unshippedTargets: ['931060000'] },
];

const KINDS = new Set(['leaf', 'region', 'script']);
const pad = value => String(value).padStart(9, '0');

// ---------------------------------------------------------------------------
// 核心：只读 tracked 产物 `shared/maps.json`
// ---------------------------------------------------------------------------
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
console.log(`[portal-closure] 目录：${catalogPath.startsWith(root) ? path.relative(root, catalogPath) : catalogPath}`);
const assembled = new Set(catalog.maps.map(map => String(map.id)));

// 观测到的边界集：目标未装配、且不是自环（玩具城/天空之城的楼梯 `bottom00 ⇄ top00`
// 指向本图，不是边界）。
const observed = new Map(); // targetId -> [{ mapId, portalName, type }]
for (const map of catalog.maps) {
  for (const portal of map.portals) {
    const target = portal.targetMapId;
    if (!target) continue;
    if (String(target) === String(map.id)) continue;
    if (assembled.has(String(target))) continue;
    const key = String(target);
    if (!observed.has(key)) observed.set(key, []);
    observed.get(key).push({ mapId: String(map.id), portalName: portal.name, type: portal.type });
  }
}
const observedIds = [...observed.keys()].sort();

if (printOnly) {
  console.log(`已装配 ${assembled.size} 图，观测到 ${observedIds.length} 个未装配落点：`);
  for (const id of observedIds) {
    const entry = PORTAL_BOUNDARIES.find(item => item.id === id);
    const via = observed.get(id).map(edge => `${edge.mapId}/${edge.portalName}`).join(', ');
    console.log(`  ${id}  ${entry ? entry.kind.padEnd(9) : '(未登记!)  '}  <- ${via}`);
  }
  process.exit(0);
}

// ---- C 形状 ----
{
  const seen = new Set();
  const boundaryIds = new Set(PORTAL_BOUNDARIES.map(entry => entry.id));
  const claimedUnshipped = new Map();
  for (const entry of PORTAL_BOUNDARIES) {
    assert(/^\d{9}$/.test(entry.id), `白名单 id 必须是 9 位数字：${entry.id}`);
    assert(KINDS.has(entry.kind), `白名单 kind 非法：${entry.id} → ${entry.kind}`);
    assert(entry.reason && entry.reason.length >= 8, `白名单必须写理由：${entry.id}`);
    assert(!seen.has(entry.id), `白名单重复：${entry.id}`);
    seen.add(entry.id);
    assert(!assembled.has(entry.id), `白名单里的 ${entry.id} 已经装配了，该删条目`);
    // F 的形状：未分发落点必须是 9 位数字、未装配、不含**别的**白名单条目、且全局唯一。
    // （自身 id 允许出现——那表示「这个落点自己没有贴图」。）
    for (const id of entry.unshippedTargets ?? []) {
      assert(/^\d{9}$/.test(id), `${entry.id} 的 unshippedTargets 必须是 9 位数字：${id}`);
      assert(!assembled.has(id), `${entry.id} 把已装配的 ${id} 声明为「未分发贴图」，该删`);
      assert(id === entry.id || !boundaryIds.has(id),
        `${entry.id} 把另一个白名单条目 ${id} 声明为「未分发贴图」——它要么是边界、要么是缺口，二者只能留一个`);
      assert(!claimedUnshipped.has(id),
        `${id} 被 ${claimedUnshipped.get(id)} 与 ${entry.id} 重复声明为「未分发贴图」`);
      claimedUnshipped.set(id, entry.id);
    }
  }
  const sorted = [...PORTAL_BOUNDARIES].map(entry => entry.id).sort();
  assert.deepEqual(PORTAL_BOUNDARIES.map(entry => entry.id), sorted,
    '白名单必须按 id 升序（否则每次补图都会产生无意义 diff）');
}
const declared = new Map(PORTAL_BOUNDARIES.map(entry => [entry.id, entry]));

// ---- A 闭包：每扇指向目录外的门都必须被显式登记过 ----
{
  const unregistered = observedIds.filter(id => !declared.has(id));
  assert.deepEqual(unregistered, [],
    '装配目录里有门指向未装配的图，且没有登记进 PORTAL_BOUNDARIES —— ' +
    '这正是 2026-09-21 勇士部落的缺陷形状（13 张图从没装配，玩家撞门才发现）。' +
    `未登记：${unregistered.map(id => `${id} <- ${observed.get(id).map(e => `${e.mapId}/${e.portalName}`).join(', ')}`).join('; ')}`);
}

// ---- B 无陈旧：白名单每条必须仍然是活的未装配落点 ----
{
  const stale = PORTAL_BOUNDARIES.filter(entry => !observed.has(entry.id)).map(entry => entry.id);
  assert.deepEqual(stale, [],
    `白名单里的落点已不再是任何已装配图的未装配出口（多半是补装了）。该删：${stale.join(', ')}`);
}

// ---------------------------------------------------------------------------
// 源核对：权威客户端打包 WZ（不是 `WZ_JSON_TW` 解包镜像）
// ---------------------------------------------------------------------------
const sourceAvailable = fs.existsSync(path.join(data, 'Map'));
if (skipSource || (!forceSource && !sourceAvailable)) {
  console.log(`[portal-closure] 核心判据 PASS：${assembled.size} 图 / ${observedIds.length} 个已登记边界`);
  if (forceSource) assert(sourceAvailable, `--source 要求权威客户端 WZ 存在：${data}`);
  else console.log(`[portal-closure] SKIP 源核对（D/E）：客户端 WZ 不在本机（${path.relative(root, data)}）。`);
  process.exit(0);
}
assert(sourceAvailable, `找不到权威客户端 WZ：${data}`);

const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');
const children = node => [...(node?.wzProperties ?? [])];
const val = (node, key, fallback = 0) => node?.at?.(key)?.wzValue ?? fallback;

const reader = createReader(data, '/tmp/tms273-portal-closure');
const portalsOf = async mapId => {
  let image;
  try {
    image = await reader.get(`Map/Map/Map${mapId[0]}/${mapId}.img`);
  } catch {
    return null;
  }
  if (!(image instanceof wz.WzImage)) return null;
  await image.parseImage();
  return children(image.at('portal')).filter(node => /^\d+$/.test(node.name)).map(node => ({
    name: String(val(node, 'pn', '')),
    type: Number(val(node, 'pt', 0)),
    targetMapId: Number(val(node, 'tm', 999999999)) === 999999999 ? null : pad(val(node, 'tm')),
    targetPortalName: String(val(node, 'tn', '')) || null,
  }));
};

// 「这个 id 是不是一张**被命名的**地图」的权威判据。只被 F 的反向断言用到。
// 它补上一个容易搞错的口径：**「Map 分卷里打不开」不等于「不是地图」**——
// `957020004` 就是「String 里有名（末日反抗軍本部／病房）、Map 里没有贴图」的那一类。
let stringMapCategories = null;
const namedInStringWz = async mapId => {
  if (stringMapCategories === null) {
    const image = await reader.get('String/Map.img');
    await image.parseImage();
    stringMapCategories = children(image);
  }
  for (const category of stringMapCategories) {
    const node = category.at?.(mapId);
    if (node) return String(node.at?.('mapName')?.wzValue ?? '');
  }
  return null;
};

// F 声明的未分发落点留痕：跑完逐条打印。缺口应当**在输出里看得见**，而不是只躺在源码里
// 等人去读注释——2026-09-21 那次的病根之一就是「缺什么」从不出现在任何输出里。
const unshippedDeclared = [];

(async () => {
  const cache = new Map();
  const sourcePortals = async mapId => {
    if (!cache.has(mapId)) cache.set(mapId, await portalsOf(mapId));
    return cache.get(mapId);
  };

  let checked = 0;
  for (const entry of PORTAL_BOUNDARIES) {
    // ---- F 未分发贴图：两条反向断言（两种口径都要在权威源里对得上） ----
    // 放在 D 之前，因为**落点自己**也可能是缺贴图的那种（`unshippedTargets` 含 `entry.id`）。
    const unshipped = new Set(entry.unshippedTargets ?? []);
    for (const id of unshipped) {
      assert(!(await sourcePortals(id)),
        `${entry.id} 把 ${id} 声明为「本包未分发贴图」，但权威 Map 分卷里**打得开**它 ⇒ ` +
        '该图是可以装配的，请去装配它并从 unshippedTargets 删除（这个声明不许用来掩盖漏装）');
      const name = await namedInStringWz(id);
      assert(name !== null,
        `${entry.id} 声明的未分发落点 ${id} 在权威 String/Map.img 里**没有被命名** ⇒ ` +
        '它不是一张真地图（id 写错？或凭空塞了一个？）');
      unshippedDeclared.push({ from: entry.id, id, name, self: id === entry.id });
    }

    // ---- D 源存在 ----
    // 声明了「本包未分发贴图」的落点**不必也无法**满足 D：它的图不在包里，门形态（E）
    // 与展开（BFS）都无从谈起 ⇒ 只登记、只留痕，不留任何静默分支。
    if (unshipped.has(entry.id)) { checked++; continue; }
    const own = await sourcePortals(entry.id);
    assert(own, `白名单落点 ${entry.id} 在权威客户端 WZ 里打不开（旧工具把这种情况误读成「源缺失」而放弃继续 BFS）`);

    // ---- E 分类 + 门形态 ----
    const edges = observed.get(entry.id);
    const sentinelEdges = [];
    const staticEdges = [];
    for (const edge of edges) {
      const origin = await sourcePortals(edge.mapId);
      assert(origin, `权威源里打不开来源图 ${edge.mapId}`);
      const portal = origin.find(candidate => candidate.name === edge.portalName);
      assert(portal, `权威源里 ${edge.mapId} 没有门 ${edge.portalName}`);
      (portal.targetMapId === null ? sentinelEdges : staticEdges).push(edge);
      if (portal.targetMapId !== null) {
        assert.equal(portal.targetMapId, entry.id,
          `${edge.mapId}/${edge.portalName} 在权威源里指向 ${portal.targetMapId}，目录里却指向 ${entry.id}`);
      }
    }
    if (entry.kind === 'script') {
      assert(sentinelEdges.length > 0 && staticEdges.length === 0,
        `${entry.id} 声明为 script，但它在权威源里的门不是 999999999 哨兵（静态门就该是 leaf/region）`);
    } else {
      assert(staticEdges.length > 0 && sentinelEdges.length === 0,
        `${entry.id} 声明为 ${entry.kind}，但它的门在权威源里是 999999999 哨兵（须改声明为 script）`);
    }
    if (entry.kind === 'script') { checked++; continue; }

    // 浅层 BFS：从该落点出发，只走「尚未装配」的邻居（回到已装配集合不算展开）
    const seen = new Set([entry.id]);
    let frontier = [entry.id];
    for (let depth = 1; depth <= 3; depth++) {
      const next = [];
      for (const current of frontier) {
        const portals = await sourcePortals(current);
        assert(portals, `权威源里打不开 ${current}（从 ${entry.id} 展开）`);
        for (const portal of portals) {
          const target = portal.targetMapId;
          if (!target || target === current || seen.has(target) || assembled.has(target)) continue;
          if (unshipped.has(target)) continue;   // F：本包没有它的贴图，展开不下去（已反向断言过）
          seen.add(target);
          next.push(target);
        }
      }
      if (!next.length) break;
      frontier = next;
    }
    const reached = seen.size - 1;
    const expected = entry.kind === 'region' ? 'region' : 'leaf';
    const actual = reached > 0 ? 'region' : 'leaf';
    assert.equal(actual, expected,
      `${entry.id} 声明为 ${entry.kind}，但权威源里它展开出 ${reached} 张图 ⇒ 实际是 ${actual}。` +
      (actual === 'region' && expected === 'leaf'
        ? '（把整片未装配区域写成「一间小屋」，就是把 2026-09-21 那类漏装重新藏起来）' : ''));
    checked++;
  }

  console.log(`[portal-closure] 核心判据 PASS：${assembled.size} 图 / ${observedIds.length} 个已登记边界`);
  console.log(`[portal-closure] 源核对 PASS：${checked}/${PORTAL_BOUNDARIES.length} 条在权威客户端 WZ 里逐条对上门形态与展开分类`);
  for (const gap of unshippedDeclared) {
    console.log(`[portal-closure] 未分发贴图：${gap.id}（${gap.name}）` +
      (gap.self ? `＝条目 ${gap.from} 自身` : `<- ${gap.from}`) +
      '；本包 Map 分卷里没有它的 <id>.img，展开/分类到此为止');
  }
  reader.close();
})().catch(error => {
  try { reader.close(); } catch { /* 读取器可能已关闭 */ }
  console.error(`\n[portal-closure] FAIL\n\n${error.stack || error.message || error}\n`);
  process.exit(1);
});
