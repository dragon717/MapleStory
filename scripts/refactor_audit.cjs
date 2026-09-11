#!/usr/bin/env node
/**
 * P0 只读审计：超大文件清单 + 前端依赖图。
 *
 * 依据 MapleStory_Large_File_Refactoring_Plan.md 第 3 节（P0）与第 14.1/14.2 节。
 * 本脚本不修改任何业务文件，只读 Git 工作树并写出 artifacts/refactor/*.json。
 *
 * 用法：
 *   node scripts/refactor_audit.cjs              # 两个产物都生成
 *   node scripts/refactor_audit.cjs --sizes      # 只生成大文件清单
 *   node scripts/refactor_audit.cjs --deps       # 只生成前端依赖图
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

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.css'];
const INDEX_SUFFIXES = ['/index.ts', '/index.tsx', '/index.js', '/index.mjs'];

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

function scanFrontendDeps() {
  const sources = collectClientSources();
  const rel = (abs) => path.relative(ROOT, abs);
  const nodes = sources.map(rel);
  const edges = [];
  const unresolved = [];
  const externals = new Set();

  for (const abs of sources) {
    const text = fs.readFileSync(abs, 'utf8');
    const specifiers = new Set();
    for (const re of [IMPORT_RE, BARE_IMPORT_RE]) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(text)) !== null) specifiers.add(match[1]);
    }
    for (const specifier of specifiers) {
      const resolved = resolveSpecifier(abs, specifier);
      if (resolved.kind === 'external') {
        externals.add(resolved.target);
        continue;
      }
      if (resolved.kind === 'unresolved') {
        unresolved.push({ from: rel(abs), specifier });
        continue;
      }
      edges.push({ from: rel(abs), to: rel(resolved.target) });
    }
  }

  // 循环检测：DFS 三色标记，报告每条回边形成的环。
  const adjacency = new Map(nodes.map((node) => [node, []]));
  for (const edge of edges) {
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

  // 实际布局（P0 实测，非计划示意）下的禁止方向。
  const RULES = [
    { name: 'entry-app-not-imported-by-features', test: (f, t) => f.startsWith('client/src/features/') && t === 'client/src/app/main.ts' },
    { name: 'network-session-not-imported-by-features', test: (f, t) => f.startsWith('client/src/features/') && t === 'client/src/network/session.ts' },
    { name: 'asset-manifest-not-imported-by-network', test: (f, t) => f.startsWith('client/src/network/') && t.startsWith('client/src/assets/') },
    { name: 'scene-layer-not-imported-by-features', test: (f, t) => f.startsWith('client/src/features/') && t.startsWith('client/src/scenes/') },
  ];
  const violations = [];
  for (const edge of edges) {
    for (const rule of RULES) {
      if (rule.test(edge.from, edge.to)) violations.push({ rule: rule.name, ...edge });
    }
  }

  return {
    generated_by: 'scripts/refactor_audit.cjs',
    generated_for: 'MapleStory_Large_File_Refactoring_Plan.md §14.2',
    scope: 'client/src 全部 .ts/.tsx/.js/.mjs/.cjs',
    limitations: [
      '静态正则抽取 import/export-from；动态 import() 与字符串拼接路径未覆盖。',
      '仅类型导入与运行期导入未区分（计划 §14.2 要求分别报告，此处合并，见 limitations）。',
      'resolution 只覆盖本仓库实际使用的无别名相对导入。',
    ],
    node_count: nodes.length,
    edge_count: edges.length,
    external_specifiers: [...externals].sort(),
    unresolved,
    cycles: [...cycles].sort(),
    rules: RULES.map((rule) => rule.name),
    violations,
    edges,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const wantSizes = argv.length === 0 || argv.includes('--sizes');
  const wantDeps = argv.length === 0 || argv.includes('--deps');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (wantSizes) {
    const report = scanSizes();
    const outPath = path.join(OUT_DIR, 'large-files.json');
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`[sizes] ${report.files.length} 个文件 -> ${path.relative(ROOT, outPath)}`);
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
    const report = scanFrontendDeps();
    const outPath = path.join(OUT_DIR, 'frontend-deps.json');
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
    console.log(
      `[deps] ${report.node_count} 节点 / ${report.edge_count} 边 -> ${path.relative(ROOT, outPath)}`
    );
    console.log(`[deps] unresolved=${report.unresolved.length} cycles=${report.cycles.length} ` +
      `violations=${report.violations.length}`);
    for (const cycle of report.cycles) console.log(`  cycle: ${cycle}`);
    for (const item of report.unresolved) console.log(`  unresolved: ${item.from} -> ${item.specifier}`);
    for (const item of report.violations) console.log(`  violation[${item.rule}]: ${item.from} -> ${item.to}`);
  }
}

main();
