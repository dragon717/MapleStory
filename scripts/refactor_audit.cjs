#!/usr/bin/env node
/**
 * P0 只读审计：超大文件清单 + 前端依赖图。
 *
 * 依据 MapleStory_Large_File_Refactoring_Plan.md 第 3 节（P0）、第 2.2 节与第 14.1/14.2 节。
 * 本脚本不修改任何业务文件，只读 Git 工作树并写出 artifacts/refactor/*.json。
 *
 * 用法：
 *   node scripts/refactor_audit.cjs              # 两个产物都生成（报告模式，不设失败退出码）
 *   node scripts/refactor_audit.cjs --sizes      # 只生成大文件清单
 *   node scripts/refactor_audit.cjs --deps       # 只生成前端依赖图
 *   node scripts/refactor_audit.cjs --check      # 增量门禁：未登记的运行期环/规则违规 => 退出码 1
 *   node scripts/refactor_audit.cjs --self-test  # 用已知 fixture（type-only 环等）自测依赖分析
 *
 * 依赖边口径（计划 §2.2：类型依赖与运行期依赖分开报告）：
 *   - type        仅类型导入（import type / export type / 全部绑定均为 type 修饰）。
 *                 TypeScript 会擦除，不构成运行期初始化风险；只参与 type-cycle 报告。
 *   - value       运行期导入（默认 import/export-from、import ... = require）。
 *   - side-effect 裸 import 'x'。
 *   - dynamic     动态 import('x')。字符串拼接路径无法静态解析，单列为 unresolved-like，
 *                 不当作不存在（计划 §2.2）。
 * 循环检测分别输出 runtime-cycle（value/side-effect/dynamic 边构成）与 type-cycle。
 *
 * --check 门禁（计划 §15.2/§15.3）：规则违规与运行期环中，凡未在
 * artifacts/refactor/debt-register.json 登记的，退出码 1；已登记的打印为 known-debt。
 * 历史债务必须有理由与退出条件，不得靠自动更新基线吞掉新失败。
 *
 * 口径说明（可复核，不是行业标准）：
 *   - physical_lines / nonblank_lines 是物理行与去空行计数，**不是 SLOC**，
 *     也没有剔除注释；精确语言指标需要专门工具，本脚本不冒充。
 *   - 行数预算沿用计划第 14.1 节的建议值：TS/JS 600 预警 / 1000 需解释 / 1500 阻断；
 *     Rust 800 / 1200 / 1500。计划未给 md 定预算，本项目对文档沿用同一口径，
 *     这是本项目决定，不是计划原文。
 *   - churn_100 是「最近 100 次提交里触及该文件的提交数」，用于分修改热点，
 *     不代表复杂度或缺陷密度。
 */

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'artifacts', 'refactor');

const EXTENSIONS = new Set([
  '.rs', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.md', '.json', '.css', '.scss', '.glsl', '.wgsl', '.html',
]);

/** 目录名级排除：生成物、第三方、外部资料、本仓库不拥有的子树。 */
const EXCLUDED_SEGMENTS = new Set([
  '.git', 'node_modules', 'target', 'coverage', '.vite', '.cache',
  'vendor', 'third_party',
  // 本项目：外部资料与生成物，不属于手写业务源码（计划 3.1 的分类）
  '参考', 'resources', 'output', 'evidence', 'public-tms273',
]);

/** 前缀排除：dist-tms273、dist-beginner-check 等构建产物。 */
const EXCLUDED_PREFIXES = ['dist'];

const GENERATED_MARKERS = [
  '@generated', 'code generated', 'automatically generated', 'do not edit',
];

/** iCloud 冲突副本：`world 2.rs`、`view 3.ts` 这类被同步分裂出的副本。 */
const CONFLICT_COPY_RE = / \d+\.[A-Za-z0-9]+$/;

/** 计划第 14.1 节的行数预算；md 沿用 TS/JS 口径（本项目决定）。 */
const BUDGETS = {
  ts: { warn: 600, justify: 1000, block: 1500 },
  rust: { warn: 800, justify: 1200, block: 1500 },
  md: { warn: 600, justify: 1000, block: 1500 },
  other: { warn: 600, justify: 1000, block: 1500 },
};

function git(args) {
  return execFileSync('git', ['-C', ROOT, ...args], {
    maxBuffer: 256 * 1024 * 1024,
    encoding: 'buffer',
  });
}

function listTrackedFiles() {
  const raw = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  return raw.toString('utf8').split('\0').filter(Boolean);
}

function isExcluded(relPath) {
  const parts = relPath.split('/');
  return parts.some((part, index) => {
    if (EXCLUDED_SEGMENTS.has(part)) return true;
    // 只对目录名做前缀匹配；文件名本身不参与（避免误伤 dist-utils.ts 之类）。
    if (index === parts.length - 1) return false;
    return EXCLUDED_PREFIXES.some((prefix) => part.startsWith(prefix));
  });
}

/** 最近 100 次提交里每个文件的被改次数。 */
function churnMap() {
  const out = new Map();
  const raw = git(['log', '-100', '--name-only', '--format=']).toString('utf8');
  for (const line of raw.split('\n')) {
    const name = line.trim();
    if (!name) continue;
    out.set(name, (out.get(name) || 0) + 1);
  }
  return out;
}

function budgetFor(suffix) {
  if (suffix === '.rs') return BUDGETS.rust;
  if (suffix === '.md') return BUDGETS.md;
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(suffix)) return BUDGETS.ts;
  return BUDGETS.other;
}

function classify(relPath, head) {
  if (CONFLICT_COPY_RE.test(relPath)) return 'icloud-conflict-copy';
  const lowered = head.toLowerCase();
  if (GENERATED_MARKERS.some((marker) => lowered.includes(marker))) return 'generated-candidate';
  const parts = relPath.split('/');
  if (
    parts.some((p) => ['test', 'tests', 'fixtures', 'snapshots'].includes(p)) ||
    /\.(test|spec)\.[A-Za-z0-9]+$/.test(relPath) ||
    /_acceptance\.rs$/.test(relPath) ||
    /\.check\.[A-Za-z0-9]+$/.test(relPath)
  ) {
    return 'test-or-fixture-candidate';
  }
  if (relPath.endsWith('.json')) return 'data-or-config-candidate';
  return 'handwritten-or-unclassified';
}

function scanSizes() {
  const churn = churnMap();
  const files = [];
  const warnings = [];

  for (const relPath of listTrackedFiles()) {
    if (isExcluded(relPath)) continue;
    const suffix = path.extname(relPath).toLowerCase();
    if (!EXTENSIONS.has(suffix)) continue;

    const abs = path.join(ROOT, relPath);
    let stat;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      warnings.push(`missing-or-unreadable: ${relPath}`);
      continue;
    }
    if (stat.isSymbolicLink()) {
      warnings.push(`skipped-symlink: ${relPath}`);
      continue;
    }
    if (!stat.isFile()) {
      warnings.push(`skipped-non-file: ${relPath}`);
      continue;
    }

    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      warnings.push(`unreadable: ${relPath}`);
      continue;
    }
    if (text.includes('\0')) {
      warnings.push(`skipped-binary-like: ${relPath}`);
      continue;
    }

    const lines = text.split('\n');
    const nonblank = lines.filter((line) => line.trim() !== '').length;
    const category = classify(relPath, lines.slice(0, 20).join('\n'));
    const budget = budgetFor(suffix);
    let verdict = 'ok';
    if (lines.length > budget.block) verdict = 'block';
    else if (lines.length > budget.justify) verdict = 'needs-justification';
    else if (lines.length > budget.warn) verdict = 'warn';
    const exempt = category === 'generated-candidate' ||
      category === 'test-or-fixture-candidate' ||
      category === 'data-or-config-candidate';

    files.push({
      path: relPath,
      physical_lines: lines.length,
      nonblank_lines: nonblank,
      category,
      budget_exempt: exempt,
      verdict: exempt ? 'exempt-by-category' : verdict,
      churn_last_100_commits: churn.get(relPath) || 0,
    });
  }

  files.sort((a, b) => b.physical_lines - a.physical_lines);
  return {
    generated_by: 'scripts/refactor_audit.cjs',
    generated_for: 'MapleStory_Large_File_Refactoring_Plan.md §3 (P0)',
    scope: 'tracked-and-unignored-untracked-working-tree',
    excluded_directory_names: [...EXCLUDED_SEGMENTS].sort(),
    excluded_directory_prefixes: EXCLUDED_PREFIXES,
    limitations: [
      'physical_lines/nonblank_lines 不是 SLOC，未剔除注释。',
      '不含复杂度、依赖、缺陷密度或业务风险推断。',
      'churn_last_100_commits 以提交为单位，机械变更与业务变更未分离。',
      '子模块仓库（参考/）需单独扫描；本脚本按设计排除。',
    ],
    thresholds: BUDGETS,
    files,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* 前端依赖图                                                          */
/* ------------------------------------------------------------------ */

/**
 * 依赖抽取优先用 client 已安装的 TypeScript AST（计划 §2.2），
 * 注释与字符串里的 "import x from 'y'" 不会被误判；typescript 不可用时
 * 退回正则并降级（degraded 标记写进报告）。
 */
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.css'];
const INDEX_SUFFIXES = ['/index.ts', '/index.tsx', '/index.js', '/index.mjs'];

let tsModule;
try {
  tsModule = require(path.join(ROOT, 'client', 'node_modules', 'typescript'));
} catch {
  tsModule = null;
}

/** 从一个 import/export 声明节点判断边类型；全部绑定均为 type 时才算 type 边。 */
function edgeKindOfNode(node) {
  if (tsModule.isImportDeclaration(node)) {
    if (!node.importClause) return 'side-effect';
    const clause = node.importClause;
    const bindings = [];
    if (clause.namedBindings && tsModule.isNamedImports(clause.namedBindings)) {
      bindings.push(...clause.namedBindings.elements);
    }
    const hasValueDefault = Boolean(clause.name) || (clause.defaultImport !== undefined);
    const allSpecifiersTypeOnly = bindings.length > 0 && bindings.every((el) => el.isTypeOnly === true);
    if (clause.isTypeOnly || (allSpecifiersTypeOnly && !hasValueDefault)) return 'type';
    return 'value';
  }
  if (tsModule.isExportDeclaration(node)) {
    return node.isTypeOnly ? 'type' : 'value';
  }
  return 'value';
}

function collectImportCallExpressions(node, out) {
  if (tsModule.isCallExpression(node) && node.expression.kind === tsModule.SyntaxKind.ImportKeyword) {
    const arg = node.arguments[0];
    if (arg && tsModule.isStringLiteral(arg)) out.push(arg.text);
  }
  tsModule.forEachChild(node, (child) => collectImportCallExpressions(child, out));
}

function extractSpecifiersWithTs(text) {
  const sourceFile = tsModule.createSourceFile('x.ts', text, tsModule.ScriptTarget.ES2022, true);
  const edges = [];
  const dynamic = [];
  tsModule.forEachChild(sourceFile, (node) => {
    if (tsModule.isImportDeclaration(node) || tsModule.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier && tsModule.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : null;
      if (specifier) edges.push({ specifier, kind: edgeKindOfNode(node) });
    }
  });
  collectImportCallExpressions(sourceFile, dynamic);
  for (const specifier of dynamic) edges.push({ specifier, kind: 'dynamic' });
  return edges;
}

/** 正则回退：无法区分全部绑定是否 type-only；`import type`/`export type` 前缀可识别。 */
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function extractSpecifiersWithRegex(text) {
  const edges = [];
  for (const [re, defaultKind] of [[IMPORT_RE, 'value'], [BARE_IMPORT_RE, 'side-effect'], [DYNAMIC_IMPORT_RE, 'dynamic']]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      const before = text.slice(Math.max(0, match.index - 60), match.index + match[0].indexOf(match[1]));
      const kind = /import\s+type\b/.test(before) || /export\s+type\b/.test(before) ? 'type' : defaultKind;
      edges.push({ specifier: match[1], kind });
    }
  }
  return edges;
}

function extractSpecifiers(text) {
  return tsModule ? extractSpecifiersWithTs(text) : extractSpecifiersWithRegex(text);
}

function resolveSpecifier(fromAbs, specifier) {
  if (!specifier.startsWith('.')) return { kind: 'external', target: specifier };
  const base = path.resolve(path.dirname(fromAbs), specifier);
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = base + suffix;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return { kind: 'internal', target: candidate };
    }
  }
  for (const indexSuffix of INDEX_SUFFIXES) {
    const candidate = base + indexSuffix;
    if (fs.existsSync(candidate)) return { kind: 'internal', target: candidate };
  }
  return { kind: 'unresolved', target: base };
}

/** 纯函数：给定文件清单与文本，产出节点/分型边/环/违规；--self-test 与扫描共用。 */
function analyzeDeps(entries, resolve = resolveSpecifier) {
  const nodes = entries.map((entry) => entry.path);
  const edges = [];
  const unresolved = [];
  const externals = new Set();
  const dynamicUnresolved = [];

  for (const entry of entries) {
    for (const { specifier, kind } of extractSpecifiers(entry.text)) {
      const resolved = resolve(entry.abs, specifier);
      if (resolved.kind === 'external') {
        externals.add(resolved.target);
        continue;
      }
      if (resolved.kind === 'unresolved') {
        const record = { from: entry.path, specifier, kind };
        unresolved.push(record);
        if (kind === 'dynamic') dynamicUnresolved.push(record);
        continue;
      }
      edges.push({ from: entry.path, to: resolved.target, kind });
    }
  }

  const findCycles = (edgeKinds) => {
    const adjacency = new Map(nodes.map((node) => [node, []]));
    for (const edge of edges) {
      if (!edgeKinds.has(edge.kind)) continue;
      if (adjacency.has(edge.from) && adjacency.has(edge.to)) {
        adjacency.get(edge.from).push(edge.to);
      }
    }
    const color = new Map();
    const stack = [];
    const cycles = new Set();
    const visit = (node) => {
      color.set(node, 'gray');
      stack.push(node);
      for (const next of adjacency.get(node) || []) {
        const state = color.get(next);
        if (state === 'gray') {
          const start = stack.indexOf(next);
          const cycle = stack.slice(start).concat(next);
          // 归一化：以字典序最小节点起始，便于去重。
          const body = cycle.slice(0, -1);
          const minIndex = body.indexOf([...body].sort()[0]);
          const rotated = body.slice(minIndex).concat(body.slice(0, minIndex));
          cycles.add(rotated.join(' -> ') + ' -> ' + rotated[0]);
        } else if (!state) {
          visit(next);
        }
      }
      stack.pop();
      color.set(node, 'black');
    };
    for (const node of nodes) if (!color.get(node)) visit(node);
    return [...cycles].sort();
  };

  const runtimeCycles = findCycles(new Set(['value', 'side-effect', 'dynamic']));
  const typeCycles = findCycles(new Set(['type']));

  // 实际布局（P0 实测，非计划示意）下的禁止方向。只看运行期边；
  // type-only 边会被 TS 擦除，只参与 type-cycle 报告（计划 §15.2）。
  const RULES = [
    { name: 'entry-app-not-imported-by-features', test: (f, t) => f.startsWith('client/src/features/') && t === 'client/src/app/main.ts' },
    { name: 'network-session-not-imported-by-features', test: (f, t) => f.startsWith('client/src/features/') && t === 'client/src/network/session.ts' },
    { name: 'asset-manifest-not-imported-by-network', test: (f, t) => f.startsWith('client/src/network/') && t.startsWith('client/src/assets/') },
    { name: 'scene-layer-not-imported-by-features', test: (f, t) => f.startsWith('client/src/features/') && t.startsWith('client/src/scenes/') },
  ];
  const violations = [];
  for (const edge of edges) {
    if (edge.kind === 'type') continue;
    for (const rule of RULES) {
      if (rule.test(edge.from, edge.to)) violations.push({ rule: rule.name, ...edge });
    }
  }

  return {
    nodes,
    edges,
    external_specifiers: [...externals].sort(),
    unresolved,
    dynamic_unresolved: dynamicUnresolved,
    runtime_cycles: runtimeCycles,
    type_cycles: typeCycles,
    rules: RULES.map((rule) => rule.name),
    violations,
  };
}

function collectClientSources() {
  const sources = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) sources.push(abs);
    }
  };
  walk(path.join(ROOT, 'client', 'src'));
  return sources.sort();
}

function loadDebtRegister() {
  const registerPath = path.join(OUT_DIR, 'debt-register.json');
  if (!fs.existsSync(registerPath)) return { items: [], _registerPath: registerPath };
  try {
    const parsed = JSON.parse(fs.readFileSync(registerPath, 'utf8'));
    return { items: parsed.items || [], _registerPath: registerPath };
  } catch (error) {
    console.error(`[deps] debt-register.json 解析失败（按无登记处理）：${error.message}`);
    return { items: [], _registerPath: registerPath };
  }
}

function scanFrontendDeps() {
  const sources = collectClientSources();
  const rel = (abs) => path.relative(ROOT, abs);
  const entries = sources.map((abs) => ({ path: rel(abs), abs, text: fs.readFileSync(abs, 'utf8') }));
  const resolveToNode = (abs, specifier) => {
    const resolved = resolveSpecifier(abs, specifier);
    return resolved.kind === 'internal' ? { ...resolved, target: rel(resolved.target) } : resolved;
  };
  const analysis = analyzeDeps(entries, resolveToNode);
  const register = loadDebtRegister();
  const registeredIds = new Set(register.items.map((item) => item.id));
  const violationId = (item) => `${item.rule}: ${item.from} -> ${item.to}`;
  const knownDebt = [];
  const fresh = [];
  for (const item of analysis.violations) {
    (registeredIds.has(violationId(item)) ? knownDebt : fresh).push({ id: violationId(item), ...item });
  }
  for (const cycle of analysis.runtime_cycles) {
    const item = { id: cycle, kind: 'runtime-cycle' };
    (registeredIds.has(cycle) ? knownDebt : fresh).push(item);
  }

  return {
    generated_by: 'scripts/refactor_audit.cjs',
    generated_for: 'MapleStory_Large_File_Refactoring_Plan.md §2.2 / §14.2',
    scope: 'client/src 全部 .ts/.tsx/.js/.mjs/.cjs',
    extractor: tsModule ? `typescript-ast ${tsModule.version}` : 'regex-degraded',
    limitations: [
      '字符串拼接的动态 import 无法静态解析，单列在 dynamic_unresolved，不当作不存在。',
      '混合导入（含至少一个非 type 绑定）按 value 边处理，偏保守。',
      'resolution 只覆盖本仓库实际使用的无别名相对导入。',
    ],
    node_count: analysis.nodes.length,
    edge_count: analysis.edges.length,
    edge_kind_counts: analysis.edges.reduce((acc, edge) => {
      acc[edge.kind] = (acc[edge.kind] || 0) + 1;
      return acc;
    }, {}),
    external_specifiers: analysis.external_specifiers,
    unresolved: analysis.unresolved,
    dynamic_unresolved: analysis.dynamic_unresolved,
    runtime_cycles: analysis.runtime_cycles,
    type_cycles: analysis.type_cycles,
    rules: analysis.rules,
    violations: analysis.violations,
    known_debt: knownDebt,
    fresh_violations: fresh,
    debt_register: path.relative(ROOT, register._registerPath),
    edges: analysis.edges,
  };
}

/* ------------------------------------------------------------------ */
/* --self-test：已知 fixture 自测依赖分析（计划 §12 表 R2）             */
/* ------------------------------------------------------------------ */

function selfTest() {
  const assert = require('node:assert');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'refactor-audit-'));
  const write = (name, text) => {
    fs.writeFileSync(path.join(dir, name), text);
    return { path: name, abs: path.join(dir, name), text };
  };
  const fakeResolve = (fromAbs, specifier) => {
    if (!specifier.startsWith('.')) return { kind: 'external', target: specifier };
    const base = path.join(path.dirname(fromAbs), specifier);
    for (const suffix of ['', '.ts']) {
      if (fs.existsSync(base + suffix)) return { kind: 'internal', target: path.basename(base + suffix) };
    }
    return { kind: 'unresolved', target: base };
  };

  const entries = [
    // type-only 双向环：不应算运行期环，应进 type_cycles。
    write('a.ts', "import type { B } from './b';\nexport const a = 1;\n"),
    write('b.ts', "import type { A } from './a';\nexport const b = 2;\n"),
    // value 环：必须算运行期环。
    write('c.ts', "import { d } from './d';\nexport const c = 3;\n"),
    write('d.ts', "import { c } from './c';\nexport const d = 4;\n"),
    // 混合绑定（type + value）按 value 边。
    write('e.ts', "import type { A } from './a';\nimport { b, type C } from './b';\nexport const e = 5;\n"),
    // side-effect 与 dynamic 导入可识别。
    write('f.ts', "import './a';\nconst load = () => import('./b');\nexport const f = 6;\n"),
    // 注释里的 import 不是边（AST 应忽略）。
    write('g.ts', "// import x from './c';\n/* import y from './d'; */\nexport const g = 7;\n"),
  ];
  const result = analyzeDeps(entries, fakeResolve);

  assert.deepEqual(result.runtime_cycles, ['c.ts -> d.ts -> c.ts'], 'value 环必须进入 runtime_cycles');
  assert.equal(result.type_cycles.length, 1, 'type-only 环只进 type_cycles');
  assert.ok(result.type_cycles[0].includes('a.ts -> b.ts'), 'type 环应在 a/b 之间');
  const eEdge = result.edges.find((edge) => edge.from === 'e.ts' && edge.to === 'b.ts');
  assert.equal(eEdge.kind, 'value', '混合绑定应按 value 边');
  const gEdges = result.edges.filter((edge) => edge.from === 'g.ts');
  assert.equal(gEdges.length, 0, '注释中的 import 不是依赖边');
  const fEdges = result.edges.filter((edge) => edge.from === 'f.ts');
  assert.deepEqual(fEdges.map((edge) => edge.kind).sort(), ['dynamic', 'side-effect'],
    'side-effect 与 dynamic 导入应被识别');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`[self-test] 依赖分析 fixture 全部通过（extractor=${tsModule ? 'typescript-ast' : 'regex-degraded'}）`);
}

/* ------------------------------------------------------------------ */
/* 源码身份                                                            */
/* ------------------------------------------------------------------ */

function sourceIdentity() {
  let commit = 'unknown';
  let dirty = true;
  try {
    commit = git(['rev-parse', 'HEAD']).toString('utf8').trim();
    dirty = git(['status', '--porcelain']).toString('utf8').trim() !== '';
  } catch {
    // git 不可用时保持 unknown / dirty=true，宁可保守不冒充精确身份。
  }
  return {
    source_commit: commit,
    working_tree_dirty: dirty,
    node_version: process.version,
    generated_at: new Date().toISOString(),
  };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    selfTest();
    return;
  }
  const wantSizes = argv.length === 0 || argv.includes('--sizes');
  const wantDeps = argv.length === 0 || argv.includes('--deps');
  const checkMode = argv.includes('--check');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const identity = sourceIdentity();

  if (wantSizes) {
    const report = { ...scanSizes(), ...identity };
    const outPath = path.join(OUT_DIR, 'large-files.json');
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`[sizes] ${report.files.length} 个文件 -> ${path.relative(ROOT, outPath)} ` +
      `(commit=${identity.source_commit.slice(0, 12)} dirty=${identity.working_tree_dirty})`);
    for (const file of report.files.filter((f) => !f.budget_exempt).slice(0, 12)) {
      console.log(
        `  ${String(file.physical_lines).padStart(6)} 行  ${file.verdict.padEnd(19)} ` +
        `churn=${String(file.churn_last_100_commits).padStart(2)}  ${file.path}`
      );
    }
    if (report.warnings.length) {
      console.log(`[sizes] warnings: ${report.warnings.length}`);
      for (const warning of report.warnings) console.log(`  - ${warning}`);
    }
  }

  if (wantDeps) {
    const report = { ...scanFrontendDeps(), ...identity };
    const outPath = path.join(OUT_DIR, 'frontend-deps.json');
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`[deps] ${report.node_count} 节点 / ${report.edge_count} 边 ` +
      `(${JSON.stringify(report.edge_kind_counts)}) -> ${path.relative(ROOT, outPath)} ` +
      `(commit=${identity.source_commit.slice(0, 12)} dirty=${identity.working_tree_dirty})`);
    console.log(`[deps] unresolved=${report.unresolved.length} ` +
      `runtime_cycles=${report.runtime_cycles.length} type_cycles=${report.type_cycles.length} ` +
      `violations=${report.violations.length}`);
    for (const cycle of report.runtime_cycles) console.log(`  runtime-cycle: ${cycle}`);
    for (const cycle of report.type_cycles) console.log(`  type-cycle: ${cycle}`);
    for (const item of report.unresolved) console.log(`  unresolved: ${item.from} -> ${item.specifier}`);
    for (const item of report.violations) console.log(`  violation[${item.rule}]: ${item.from} -> ${item.to}`);

    if (checkMode) {
      // 计划 §15.3：登记的债务放行并提示，未登记的失败。不自动扩张基线。
      const freshItems = report.fresh_violations;
      for (const item of report.known_debt) console.log(`  known-debt: ${item.id}`);
      if (freshItems.length > 0) {
        console.error(`\n[check] FAILED: ${freshItems.length} 个未登记的违规/运行期环（新增债务必须先修复或显式登记）：`);
        for (const item of freshItems) console.error(`  - ${item.id}`);
        process.exit(1);
      }
      console.log(`\n[check] OK：无未登记违规（known-debt ${report.known_debt.length} 项，见 ${report.debt_register}）。`);
    }
  }
}

main();
