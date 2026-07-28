#!/usr/bin/env node
/**
 * Code budget gate — measured off the TypeScript AST, not heuristics.
 *
 * Ratchet semantics: files already over budget are recorded in
 * code-budget-baseline.json and tolerated at their recorded size. They may never
 * grow, and no new violation may appear. `--update` re-records, which tightens
 * the baseline whenever a file improves.
 *
 * Run: node scripts/check-code-budget.mjs [--update]
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';

const ts = createRequire(import.meta.url)('typescript');

const ROOT = new URL('..', import.meta.url).pathname;
const BASELINE = join(ROOT, 'scripts/code-budget-baseline.json');

/** Structural budgets. Lowering these is progress; raising them is not an option. */
const BUDGET = {
  fileLines: 400,
  functionLines: 50,
  commentRatio: 0.15,
  commentBlock: 5,
};

const METRICS = Object.keys(BUDGET);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'scripts', 'tests']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const FUNCTION_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
]);

/** Longest function BODY in source lines, via the AST. Nested functions counted separately. */
function longestFunction(sf) {
  let worst = { lines: 0, name: '', line: 0 };
  const visit = (node) => {
    if (FUNCTION_KINDS.has(node.kind) && node.body) {
      const start = sf.getLineAndCharacterOfPosition(node.body.getStart(sf)).line;
      const end = sf.getLineAndCharacterOfPosition(node.body.getEnd()).line;
      const lines = end - start + 1;
      if (lines > worst.lines) {
        const name = node.name?.getText(sf)
          ?? (node.kind === ts.SyntaxKind.Constructor ? 'constructor' : '<anonymous>');
        worst = { lines, name, line: start + 1 };
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return worst;
}

/**
 * Comment lines and the longest INLINE run, via the scanner. A run that documents
 * the declaration directly below it is API contract, not inline prose, and is
 * excluded from the block metric (but still counts toward the ratio).
 */
function comments(sf, text) {
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line;
  const commentLines = new Set();
  const ranges = [];

  const scanner = ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ false, ts.LanguageVariant.Standard, text);
  let token;
  while ((token = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken) {
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    const from = lineOf(scanner.getTokenStart());
    const to = lineOf(scanner.getTokenEnd());
    for (let l = from; l <= to; l++) commentLines.add(l);
    ranges.push({ from, to, jsdoc: text.slice(scanner.getTokenStart(), scanner.getTokenStart() + 3) === '/**' });
  }

  // Merge adjacent comment ranges into runs.
  const lines = text.split('\n');
  const sorted = [...commentLines].sort((a, b) => a - b);
  let longestBlock = 0;
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    const run = sorted[j] - sorted[i] + 1;
    const startsJsdoc = ranges.some(r => r.from === sorted[i] && r.jsdoc);
    const next = (lines[sorted[j] + 1] ?? '').trim();
    const documentsDecl = startsJsdoc &&
      /^(export|async|private|public|protected|static|readonly|function|class|interface|type|enum|const|abstract|declare|@)/.test(next);
    if (!documentsDecl) longestBlock = Math.max(longestBlock, run);
    i = j + 1;
  }

  let code = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (!commentLines.has(i)) code++;
  }
  return { commentCount: commentLines.size, code, longestBlock };
}

function measure(abs) {
  const text = readFileSync(abs, 'utf8');
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  const fn = longestFunction(sf);
  const c = comments(sf, text);
  const denom = c.code + c.commentCount;
  return {
    fileLines: text.split('\n').length,
    functionLines: fn.lines,
    commentRatio: denom === 0 ? 0 : Math.round((c.commentCount / denom) * 1000) / 1000,
    commentBlock: c.longestBlock,
    _worstFunction: fn.name ? `${fn.name} (L${fn.line})` : '',
  };
}

const update = process.argv.includes('--update');
let baseline = {};
try { baseline = JSON.parse(readFileSync(BASELINE, 'utf8')); } catch { /* first run */ }

const failures = [];
const next = {};

for (const abs of walk(ROOT)) {
  const path = relative(ROOT, abs);
  const m = measure(abs);
  const base = baseline[path] ?? {};
  const over = {};

  for (const key of METRICS) {
    const allowed = Math.max(BUDGET[key], base[key] ?? 0);
    if (m[key] > allowed) over[key] = { actual: m[key], allowed, budget: BUDGET[key] };
  }

  const exceeds = METRICS.filter(k => m[k] > BUDGET[k]);
  if (exceeds.length) {
    next[path] = Object.fromEntries(exceeds.map(k => [k, m[k]]));
    if (m.functionLines > BUDGET.functionLines) next[path].worstFunction = m._worstFunction;
  }
  if (Object.keys(over).length) failures.push({ path, over });
}

if (update) {
  writeFileSync(BASELINE, JSON.stringify(next, null, 2) + '\n');
  console.log(`code-budget: baseline updated — ${Object.keys(next).length} file(s) over budget.`);
  process.exit(0);
}

if (failures.length) {
  console.error('\ncode-budget: FAIL — over budget AND over the recorded baseline.\n');
  for (const { path, over } of failures) {
    console.error(`  ${path}`);
    for (const [k, v] of Object.entries(over)) {
      console.error(`    ${k}: ${v.actual}  (baseline ${v.allowed}, target ${v.budget})`);
    }
  }
  console.error('\nExtract the function, split the file, or move prose into a test name or docs/.');
  console.error('Raising a limit is not an option — that is how the 7k-line file happened.\n');
  process.exit(1);
}

console.log(`code-budget: OK — no regressions. ${Object.keys(next).length} file(s) still above target.`);
