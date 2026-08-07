#!/usr/bin/env node
/**
 * Post-removal sweep.
 *
 * Deleting a code path reliably leaves survivors behind: a doc that still
 * promises the behavior, a JSDoc describing it, a type field nothing populates,
 * a test mock for a method that no longer exists. Typecheck, lint and tests all
 * pass with every one of those in place — they are prose and dead declarations,
 * not broken code. Reviewers have caught these twice; this catches them first.
 *
 * Reads the identifiers your diff DELETED, then greps the whole repo for
 * anything still referring to them.
 *
 * Run: node scripts/check-removed-refs.mjs [base-ref]     (default: origin/main)
 */
import { execSync } from 'node:child_process';

const base = process.argv[2] ?? 'origin/main';

/** Files whose job is to talk about removed things. */
const EXPECTED_TO_MENTION = /^(CHANGELOG\.md|docs\/PAYMENTS-ANALYSIS\.md|docs\/PAYMENTS-REFACTOR\.md|docs\/PAYMENTS-V2-DESIGN\.md|docs\/MIGRATION-PAYMENTS-V2\.md|docs\/LEGACY-INVENTORY\.md|docs\/CODE-STANDARDS\.md|scripts\/check-removed-refs\.mjs)$/;

const sh = (cmd) => execSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Identifiers introduced by a `-` line and not re-introduced by any `+` line. */
function removedIdentifiers(diff) {
  const DECL = [
    /^-\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    /^-\s*(?:export\s+)?(?:abstract\s+)?(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    /^-\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
    /^-\s*(?:private|public|protected|readonly|static|async|get|set)[\w\s]*?\s([A-Za-z_$][\w$]*)\s*[(<:]/,
    /^-\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/,
  ];
  const removed = new Set();
  const added = new Set();
  for (const line of diff.split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    const target = line.startsWith('-') ? removed : line.startsWith('+') ? added : null;
    if (!target) continue;
    const probe = line.startsWith('+') ? '-' + line.slice(1) : line;
    for (const re of DECL) {
      const m = probe.match(re);
      if (m?.[1] && m[1].length > 3) target.add(m[1]);
    }
  }
  for (const a of added) removed.delete(a);
  return [...removed];
}

const diff = sh(`git diff ${base}...HEAD -- '*.ts' '*.mjs'`);
const names = removedIdentifiers(diff);

if (names.length === 0) {
  console.log('check-removed-refs: no removed declarations in this diff.');
  process.exit(0);
}

const survivors = [];
for (const name of names) {
  let out = '';
  try {
    out = sh(`git grep -n -w -- '${name}' -- '*.ts' '*.md' ':!node_modules' ':!dist' || true`);
  } catch { /* git grep exits 1 on no match */ }
  const hits = out.split('\n').filter(Boolean).filter((l) => {
    const file = l.split(':')[0];
    return !EXPECTED_TO_MENTION.test(file);
  });
  if (hits.length) survivors.push({ name, hits });
}

if (survivors.length === 0) {
  console.log(`check-removed-refs: OK — ${names.length} removed identifier(s), no survivors.`);
  process.exit(0);
}

console.log(`\ncheck-removed-refs: ${survivors.length} removed identifier(s) still referenced.\n`);
console.log('Each is either a live same-named symbol (fine) or a stale reference to');
console.log('something you deleted — a doc promise, a JSDoc, a dead field, a test mock.\n');
for (const { name, hits } of survivors) {
  console.log(`  ${name}  (${hits.length})`);
  for (const h of hits.slice(0, 6)) console.log(`      ${h.trim().slice(0, 150)}`);
  if (hits.length > 6) console.log(`      … ${hits.length - 6} more`);
  console.log('');
}
console.log('Advisory — review each, then proceed.\n');
