#!/usr/bin/env node
/**
 * 内容寻址资源对象库（v3 §4.1「实体文件也必须不可变」）。
 *
 * 为什么需要它：`/assets/**` 下的内容资源是**固定名**的（`tms273/actor/....png`），
 * 装配管线可以原地改写它们。所以服务端只能给它 `no-cache`＝每次使用前重新验证，
 * 也就是**只有协商缓存、没有强缓存**——刷新时两万多个资源各发一次条件请求，
 * 这正是「刷新界面仍长时间加载地图资源」的直接原因。
 *
 * 本脚本把被引用的字节复制成**内容寻址对象** `objects/sha256/<摘要><扩展名>`：
 * 地址由字节决定，地址不变则字节不变，服务端才敢给 `immutable` 强缓存。
 *
 * 规则（照 v3 §4.1 逐条落实）：
 *   - **只写缺失摘要**：对象已存在就复用，不重写、不重算（后续装配只补变化字节）。
 *   - **复制而不是硬链接**：源文件是原地写入（`writeFileSync` 截断同一 inode），
 *     硬链接会把「快照」和可变源绑定在一起，禁止（v3 §4.1 明文）。
 *   - **先落临时名再 rename**：不产生半截对象；rename 在同一目录内是原子的。
 *   - **索引不含自身哈希**：`revision` 只由映射表算出，避免自引用。
 *   - **索引最后发布**：对象 → 不可变索引 → `current.json` 指针，指针是唯一的
 *     发布动作，读方永远看到一致的组合。
 *   - **路径不得逃逸资源根**：`..`、绝对路径、指向根外的符号链接一律拒绝。
 *   - **缺文件如实报告**：不补占位、不静默跳过（v3 §C06）。
 *   - **未实体化文件不得阻塞**：本仓库位于 iCloud Drive，部分文件是「占位稿」
 *     （`st_blocks === 0`＝内容不在本机）。读它会**永久阻塞**在云下载上——实测
 *     卡死在 28k 中的第 233 个。这类文件按 `blocks` 预判后跳过并如实报告，
 *     它们继续走逻辑地址（协商缓存），不影响其余资源的强缓存。
 *   - **大内容 JSON 预压缩**（2026-09-18 补）：见 `publishPrecompressed`。浏览器
 *     对**单个响应**有体积上限，超过就不再写 HTTP 缓存——实测 1.5MB 的图片能留
 *     本地副本、11.9MB 的索引留不下。`manifest.json`(35MB) 与 `entry/appearance.json`
 *     (23MB) 因此**每次加载都全量重下**，`no-cache` 的 304 重验证根本没机会发生。
 *     预压缩把编码后体积降到 1.49MB / 0.16MB，重新落进缓存门槛内。
 *   - **对象索引同规格**（2026-09-18 同日补）：`objects/index/<revision>.json` 本身就是
 *     那个 11.9MB 的不可缓存样本。首屏体积收口做完后，刷新时剩下的字节**几乎只有它**
 *     —— 所以索引也必须带 `.br`/`.gz`，否则「缓存没生效」只是被压缩到只剩这一条。
 *
 * 用法：
 *   node scripts/index_client_assets.cjs                  # 建立/补齐对象库
 *   node scripts/index_client_assets.cjs --dry-run        # 只统计，不写盘
 *   node scripts/index_client_assets.cjs --verify         # 独立重算并校验一致性
 *   node scripts/index_client_assets.cjs --limit 200      # 冒烟：只处理前 N 个
 *   node scripts/index_client_assets.cjs --report <path>  # 另存机器可读报告
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_ASSETS = path.join(ROOT, 'client/public-tms273/assets');
/**
 * 内容 JSON 集合**自动发现**，不维护手写名单。
 *
 * 教训（2026-09-17）：这里原先是 6 项写死的清单，漏掉了 `entry/appearance.json`
 * （23MB 的角色外观目录）。后果不是「少索引几张图」这么轻——它引用的角色装备图
 * 既不在闭包里、也没有对象副本，客户端只能退回逻辑地址；而服务端读**被 iCloud 驱逐的
 * 占位文件会阻塞约 30 秒才返回**，Phaser 预加载就在那一张图上卡死（表现为「卡在 37%」）。
 * 漏一项的代价是一个极难归因的界面故障 ⇒ 改为扫描 `assets/**` 下除 `objects/` 外的全部
 * JSON：闭包取超集最多多写几个对象，少一项却会挂死加载。
 */
function discoverContentFiles(root) {
  const found = [];
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // 对象库自身不是内容：扫它会把对象地址也当成引用，闭包自指。
        if (entry.name === 'objects') continue;
        walk(full);
        continue;
      }
      if (entry.name.endsWith('.json')) found.push(path.relative(root, full).split(path.sep).join('/'));
    }
  })(root);
  return found.sort();
}
/**
 * 只把真正的内容字节做成对象。JSON 清单**留在固定名**：它们是本次装配的产物、
 * 名字固定且内容随装配变化，进对象库只会让地址每轮都换。它们靠 `no-cache` 重验证 +
 * 预压缩这条路线（见 `publishPrecompressed`），不走内容寻址。
 */
const OBJECT_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp3', '.ogg', '.wav', '.m4a']);
const ALGORITHM = 'sha256';
const SCHEMA = 1;

/**
 * 预压缩（br + gz）的门槛与参数。
 *
 * 门槛取 256KB 的理由不是「压缩收益」，而是**浏览器愿不愿意留下副本**：实测同一个
 * 浏览器里 1.5MB 的 immutable 响应能留在磁盘缓存、11.9MB 的留不下（Chromium 对单个
 * 缓存条目有体积上限）。超过门槛才压，是为了把小内容 JSON 排除在外——它们本来就能
 * 走 304，压了只是多两份文件。
 *
 * br q9 在 35MB 的清单上耗 615ms、压到 1.49MB（gz9 是 391ms / 2.50MB）；两个编码都写，
 * 让服务端按客户端 `Accept-Encoding` 协商（tower-http 的档位是 zstd > br > gz，浏览器
 * 会拿到 br）。预压是**离线**做的，服务端只做文件查找，零 CPU 开销。
 */
const PRECOMPRESS_MIN_BYTES = 256 * 1024;
const PRECOMPRESS_VARIANTS = [
  {
    suffix: '.br',
    encode: body => zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }),
    decode: body => zlib.brotliDecompressSync(body),
  },
  {
    suffix: '.gz',
    encode: body => zlib.gzipSync(body, { level: 9 }),
    decode: body => zlib.gunzipSync(body),
  },
];

/**
 * 为大内容 JSON 写 `<文件>.br` / `<文件>.gz` 兄弟文件。
 *
 * 服务端靠 `ServeDir::precompressed_br()/precompressed_gzip()` 查找它们：只认**同目录同名的
 * 后缀变体**，所以这两份文件必须紧挨着源文件放，不能另建目录。
 *
 * 幂等规则是**比 mtime**而不是只看存在：内容被装配管线原地改写后，`mtime` 会变新，
 * 这一轮就必须重压——否则服务端会继续发旧的压缩字节（比不发压缩更坏）。
 * 同一理由，源文件掉到门槛以下时要**删掉**遗留变体，不然它会一直被发出去。
 */
function publishPrecompressed(entries, options) {
  let written = 0;
  let reused = 0;
  let removed = 0;
  let sourceBytes = 0;
  let encodedBytes = 0;

  for (const entry of entries) {
    const qualifies = entry.size >= PRECOMPRESS_MIN_BYTES;
    let sourceStat;
    try { sourceStat = fs.statSync(entry.file); } catch { continue; }
    if (qualifies) sourceBytes += entry.size;
    for (const variant of PRECOMPRESS_VARIANTS) {
      const target = `${entry.file}${variant.suffix}`;
      let targetStat = null;
      try { targetStat = fs.statSync(target); } catch { /* 尚无变体 */ }

      if (!qualifies) {
        if (targetStat) {
          if (!options.dryRun && !options.verify) { fs.rmSync(target); removed += 1; }
        }
        continue;
      }
      // mtime 相等也算新鲜：内容没动过就不该重压。
      if (targetStat && targetStat.size > 0 && targetStat.mtimeMs >= sourceStat.mtimeMs) {
        reused += 1;
        encodedBytes += targetStat.size;
        continue;
      }
      if (options.dryRun || options.verify) { continue; }
      const body = fs.readFileSync(entry.file);
      const encoded = variant.encode(body);
      fs.writeFileSync(`${target}.tmp-${process.pid}`, encoded);
      fs.renameSync(`${target}.tmp-${process.pid}`, target);
      written += 1;
      encodedBytes += encoded.length;
    }
  }
  return { written, reused, removed, sourceBytes, encodedBytes };
}

function parseArgs(argv) {
  const options = { assets: DEFAULT_ASSETS, dryRun: false, verify: false, limit: 0, report: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--verify') options.verify = true;
    else if (arg === '--assets') options.assets = path.resolve(argv[++index]);
    else if (arg === '--limit') options.limit = Number.parseInt(argv[++index], 10) || 0;
    else if (arg === '--report') options.report = path.resolve(argv[++index]);
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node scripts/index_client_assets.cjs [--dry-run|--verify] [--assets <目录>] [--limit N] [--report <文件>]');
      process.exit(0);
    } else {
      console.error(`未知参数: ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

/**
 * 收集引用闭包。
 *
 * 两种形态都要收：`{ "url": "/assets/..." }` 结构化字段，以及 `"bgm": "/assets/..."`
 * 这类**裸字符串**——`preload-plan.ts` 里有 `maps.map(map => map.bgm)`，漏掉裸字符串
 * 会让 BGM 拿不到对象地址，那一组就退回答协商缓存。
 */
function collectReferences(value, into) {
  if (typeof value === 'string') {
    if (value.startsWith('/assets/')) into.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, into);
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) collectReferences(value[key], into);
  }
}

/** 把 `/assets/<相对路径>` 解析成资源根内的绝对路径；越界一律抛错。 */
function resolveInsideRoot(root, url) {
  const relative = url.replace(/^\/assets\//, '');
  if (relative.length === 0) throw new Error(`空资源路径: ${url}`);
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new Error(`资源路径逃逸资源根: ${url}`);
  }
  return absolute;
}

function sha256OfFile(file) {
  const hash = crypto.createHash(ALGORITHM);
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

/** 映射表 → 规范化 JSON（键排序），保证同一组字节永远得到同一个 revision。 */
function canonicalMapping(objects) {
  const keys = Object.keys(objects).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${JSON.stringify(objects[key])}`).join(',')}}`;
}

function writeAtomic(target, body) {
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, body);
  fs.renameSync(temporary, target);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = options.assets;
  if (!fs.existsSync(root)) {
    console.error(`资源目录不存在: ${root}`);
    process.exit(1);
  }

  const started = Date.now();
  const references = new Set();
  const contentDataless = [];
  const compressible = [];
  const contentFiles = discoverContentFiles(root);
  for (const name of contentFiles) {
    const file = path.join(root, name);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    // 与对象一样：占位 JSON 读下去会永久阻塞，先用 stat 预判再决定读不读。
    // 跳过它意味着**它引用的资源这一轮进不了闭包**，所以必须计入报告并显式警告。
    if (stat.blocks === 0 && stat.size > 0) { contentDataless.push(name); continue; }
    compressible.push({ name, file, size: stat.size });
    try {
      collectReferences(JSON.parse(fs.readFileSync(file, 'utf8')), references);
    } catch {
      console.log(`  · 跳过（JSON 解析失败）: ${name}`);
    }
  }

  const objectExtensions = [];
  const missing = [];
  const skipped = [];
  const dataless = [];
  for (const url of [...references].sort()) {
    const extension = path.extname(url).toLowerCase();
    const file = resolveInsideRoot(root, url);
    if (!OBJECT_EXTENSIONS.has(extension)) {
      // 清单类或未知类型：保持固定名交付，不进对象库。
      skipped.push(url);
      continue;
    }
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      missing.push(url);
      continue;
    }
    if (!stat.isFile()) {
      missing.push(url);
      continue;
    }
    // iCloud 占位稿：内容不在本机。必须在**读之前**判掉——`readFileSync` 会阻塞
    // 在云下载上（实测永久卡在 28k 中的第 233 个），既拿不到摘要也让整次索引
    // 永远不结束。这类文件继续走逻辑地址（协商缓存），不影响其余资源的强缓存。
    if (stat.size > 0 && stat.blocks === 0) {
      dataless.push(url);
      continue;
    }
    objectExtensions.push({ url, file, extension, size: stat.size });
  }

  const selected = options.limit > 0 ? objectExtensions.slice(0, options.limit) : objectExtensions;
  const objectDir = path.join(root, 'objects', ALGORITHM);
  const indexDir = path.join(root, 'objects', 'index');
  const objects = {};
  const written = [];
  let reused = 0;
  let logicalBytes = 0;
  let objectBytes = 0;
  const seenDigests = new Set();

  let processed = 0;
  for (const entry of selected) {
    const digest = sha256OfFile(entry.file);
    const bytes = entry.size;
    logicalBytes += bytes;
    processed += 1;
    // 进度按**已处理**计数（不是已写入）：第二次运行时以复用为主，
    // 若只在写入时打印，看起来会像「毫无动静」。
    if (processed % 2000 === 0) console.log(`  · ${processed}/${selected.length} 已处理，新增 ${written.length} 个对象`);
    const fileName = `${digest}${entry.extension}`;
    const objectFile = path.join(objectDir, fileName);
    objects[entry.url] = `/assets/objects/${ALGORITHM}/${fileName}`;
    if (seenDigests.has(fileName)) continue;
    seenDigests.add(fileName);
    objectBytes += bytes;
    if (fs.existsSync(objectFile)) {
      reused += 1;
      continue;
    }
    // `--verify` 是只读校验：绝不能顺手把缺失对象补上，否则「校验通过」只是
    // 证明这次运行自己修好了，证明不了已发布产物是完整的。
    if (options.dryRun || options.verify) continue;
    fs.mkdirSync(objectDir, { recursive: true });
    // 复制而不是硬链接：源文件原地写入会同时改写硬链接指向的字节（v3 §4.1）。
    const temporary = `${objectFile}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, fs.readFileSync(entry.file));
    fs.renameSync(temporary, objectFile);
    written.push(fileName);
  }

  // 映射表是 revision 的唯一输入；`revision` 不参与自身计算（避免自引用）。
  const revision = crypto.createHash(ALGORITHM).update(canonicalMapping(objects)).digest('hex');
  const indexBody = {
    schema: SCHEMA,
    algorithm: ALGORITHM,
    revision,
    count: Object.keys(objects).length,
    bytes: logicalBytes,
    objectBytes,
    missing,
    dataless,
    objects,
  };

  const precompressed = publishPrecompressed(compressible, options);

  const report = {
    schema: SCHEMA,
    algorithm: ALGORITHM,
    revision,
    assetsRoot: path.relative(ROOT, root).split(path.sep).join('/'),
    referenced: references.size,
    indexed: Object.keys(objects).length,
    objectsWritten: written.length,
    objectsReused: reused,
    logicalBytes,
    objectBytes,
    missing,
    skippedNonObject: skipped.length,
    dataless,
    contentFiles: contentFiles.length,
    contentDataless,
    precompressedFiles: compressible.filter(entry => entry.size >= PRECOMPRESS_MIN_BYTES).length,
    precompressedWritten: precompressed.written,
    precompressedReused: precompressed.reused,
    precompressedSourceBytes: precompressed.sourceBytes,
    precompressedEncodedBytes: precompressed.encodedBytes,
    slowestMs: Date.now() - started,
    dryRun: options.dryRun,
  };

  if (options.verify) {
    return verify(root, report);
  }

  if (!options.dryRun) {
    fs.mkdirSync(indexDir, { recursive: true });
    const indexName = `${revision}.json`;
    const indexFile = path.join(indexDir, indexName);
    if (!fs.existsSync(indexFile)) writeAtomic(indexFile, JSON.stringify(indexBody));
    // 索引本身也走预压缩。**这一条是不可省的**：索引是 11.9MB 的 immutable JSON，
    // 实测它正好落在「浏览器单响应上限」之上 ⇒ Chromium 永远不把它写进 HTTP 缓存
    // ⇒ 每次进游戏都要重下它（2026-09-18 修完首屏体积后，刷新时剩下的字节几乎就是它）。
    // 索引与内容 JSON 同规格，所以在同一次发布里顺手生成兄弟文件；服务端零 CPU 直发。
    const indexPrecompressed = publishPrecompressed([{ name: `objects/index/${indexName}`, file: indexFile, size: fs.statSync(indexFile).size }], options);
    for (const key of ['written', 'reused', 'removed', 'sourceBytes', 'encodedBytes']) precompressed[key] += indexPrecompressed[key];
    report.precompressedFiles += 1;
    report.precompressedWritten = precompressed.written;
    report.precompressedReused = precompressed.reused;
    report.precompressedSourceBytes = precompressed.sourceBytes;
    report.precompressedEncodedBytes = precompressed.encodedBytes;
    report.indexPrecompressedSourceBytes = indexPrecompressed.sourceBytes;
    report.indexPrecompressedEncodedBytes = indexPrecompressed.encodedBytes;
    // 指针最后写：它是唯一的「发布」动作，读方要么看到旧组合、要么看到新组合。
    writeAtomic(path.join(root, 'objects', 'current.json'), JSON.stringify({
      schema: SCHEMA,
      algorithm: ALGORITHM,
      revision,
      index: `/assets/objects/index/${indexName}`,
      count: indexBody.count,
      bytes: logicalBytes,
      createdAt: new Date().toISOString(),
    }, null, 2));
  }

  if (options.report) writeAtomic(options.report, JSON.stringify(report, null, 2));

  console.log(`资源引用闭包: ${references.size}（内容 JSON ${contentFiles.length} 个 → 对象 ${report.indexed} / 清单类保持固定名 ${skipped.length}）`);
  console.log(`对象: 新增 ${report.objectsWritten}、复用 ${report.objectsReused}；逻辑 ${(logicalBytes / 1048576).toFixed(1)}MB → 去重后 ${(objectBytes / 1048576).toFixed(1)}MB`);
  console.log(`预压缩(br+gz): ${report.precompressedFiles} 个 ≥${PRECOMPRESS_MIN_BYTES / 1024}KB 的内容 JSON + 1 个对象索引；新增 ${precompressed.written}、复用 ${precompressed.reused}、清理 ${precompressed.removed}；`
    + `${(precompressed.sourceBytes / 1048576).toFixed(1)}MB → ${(precompressed.encodedBytes / 1048576).toFixed(2)}MB`);
  if (report.indexPrecompressedSourceBytes) {
    console.log(`  其中对象索引: ${(report.indexPrecompressedSourceBytes / 1048576).toFixed(1)}MB → ${(report.indexPrecompressedEncodedBytes / 1048576).toFixed(2)}MB`);
  }
  console.log(`缺文件: ${missing.length}${missing.length ? `（${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ' …' : ''}）` : ''}`);
  console.log(`未实体化(iCloud 占位) 资源: ${dataless.length} ｜ 内容 JSON: ${contentDataless.length}`);
  if (dataless.length > 0 || contentDataless.length > 0) {
    console.log('');
    console.log('⚠ 闭包不完整：上面这些占位文件既没进对象库，也无法从对象库取到。');
    console.log('  客户端对这些地址只能退回逻辑地址，而服务端读占位文件要等 iCloud 下载');
    console.log('  （实测约 30s/个）——**预加载会在它们身上卡住**。物化后重跑本脚本即可补齐：');
    console.log('    brctl download client/public-tms273/assets   # 在 Terminal 里跑（沙箱内 brctl 被拒）');
    console.log('    node scripts/warm_dataless_assets.cjs        # 或借服务端逐个请求触发下载');
  }
  console.log(`assetRevision: ${options.dryRun ? '(dry-run 未写入)' : revision}`);
  console.log(`耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (options.dryRun) console.log('dry-run：未写入任何文件。');
}

/**
 * `--verify`：**独立重算**而不是信任已写产物。
 *
 * 重算源文件摘要 → 与指针指向的索引比对；再抽查对象内容与文件名摘要一致。
 * 任何一处不符就失败，避免「索引写了但对象没落盘」这类半成品被当成已发布。
 */
function verify(root, report) {
  const pointerFile = path.join(root, 'objects', 'current.json');
  if (!fs.existsSync(pointerFile)) {
    console.error('校验失败：缺少 objects/current.json 指针（对象库尚未发布）。');
    console.error('  先运行: node scripts/index_client_assets.cjs');
    process.exit(1);
  }
  const pointer = JSON.parse(fs.readFileSync(pointerFile, 'utf8'));
  const indexFile = path.join(root, pointer.index.replace(/^\/assets\//, ''));
  if (!fs.existsSync(indexFile)) {
    console.error(`校验失败：指针指向的索引不存在: ${pointer.index}`);
    process.exit(1);
  }
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));

  const failures = [];
  const recomputed = crypto.createHash(ALGORITHM).update(canonicalMapping(index.objects)).digest('hex');
  if (recomputed !== index.revision) failures.push(`索引自述 revision ${index.revision} ≠ 重算 ${recomputed}`);
  if (pointer.revision !== recomputed) failures.push(`指针 revision ${pointer.revision} ≠ 重算 ${recomputed}`);
  if (pointer.revision !== index.revision) failures.push(`指针 revision ${pointer.revision} ≠ 索引 revision ${index.revision}`);
  if (pointer.index !== `/assets/objects/index/${index.revision}.json`) failures.push(`索引文件名与 revision 不一致: ${pointer.index}`);
  if (index.revision !== report.revision) failures.push(`当前源文件重算 revision ${report.revision} ≠ 已发布 ${index.revision}（源已变化，需重建）`);

  // 抽查对象字节：文件名声明的摘要必须等于内容摘要。
  const entries = Object.entries(index.objects);
  const step = Math.max(1, Math.floor(entries.length / 64));
  let checked = 0;
  for (let cursor = 0; cursor < entries.length; cursor += step) {
    const [url, objectUrl] = entries[cursor];
    const objectFile = path.join(root, objectUrl.replace(/^\/assets\//, ''));
    if (!fs.existsSync(objectFile)) {
      failures.push(`对象缺失: ${objectUrl}（对应 ${url}）`);
      continue;
    }
    const declared = path.basename(objectFile).split('.')[0];
    const actual = sha256OfFile(objectFile);
    if (declared !== actual) failures.push(`对象内容与名字不符: ${objectUrl}`);
    checked += 1;
  }

  // 预压缩变体：必须存在、且**解压后与源逐字节一致**。
  // 只比 mtime 不够——服务端发的是压缩字节，一份过期的变体会让客户端拿到旧清单，
  // 比不发压缩更坏。所以这里独立解压比对，不看 publishPrecompressed 自己的记账。
  let precompressedChecked = 0;
  // 内容 JSON 与**对象索引**同规格：索引也是大 JSON，也必须带兄弟文件，否则刷新时
  // 客户端要重下 11.9MB。校验把两者一起走，避免「补了索引却没进这套判据」。
  const storeIndexName = String(pointer.index ?? '').replace(/^\/assets\//, '');
  const precompressTargets = [...discoverContentFiles(root)];
  if (storeIndexName) precompressTargets.push(storeIndexName);
  for (const name of precompressTargets) {
    const file = path.join(root, name);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (stat.blocks === 0 && stat.size > 0) continue;
    const qualifies = stat.size >= PRECOMPRESS_MIN_BYTES;
    for (const variant of PRECOMPRESS_VARIANTS) {
      const target = `${file}${variant.suffix}`;
      const label = path.relative(root, target).split(path.sep).join('/');
      if (!qualifies) {
        if (fs.existsSync(target)) failures.push(`多余的预压缩变体（源已小于门槛）: ${label}`);
        continue;
      }
      if (!fs.existsSync(target)) { failures.push(`缺少预压缩变体: ${label}`); continue; }
      let decoded;
      try {
        decoded = variant.decode(fs.readFileSync(target));
      } catch (error) {
        failures.push(`预压缩变体无法解压: ${label}（${error instanceof Error ? error.message : error}）`);
        continue;
      }
      if (!decoded.equals(fs.readFileSync(file))) { failures.push(`预压缩变体与源不一致: ${label}`); continue; }
      precompressedChecked += 1;
    }
  }

  console.log(`校验：索引 ${entries.length} 条，抽查对象 ${checked} 个，预压缩变体 ${precompressedChecked} 个，revision ${index.revision}`);
  if (failures.length > 0) {
    console.error(`校验失败 ${failures.length} 项：`);
    for (const failure of failures.slice(0, 20)) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('校验通过：指针、索引、对象三者一致。');
}

main();
