#!/usr/bin/env node
// #725 standing mutation-probe runner (`npm run test:mutation`). Per probe in
// tests/mutation/probes.json {name, file, find, replace, tests[]}: `find` must occur
// EXACTLY once (else STALE — code moved; update the probe with the refactor, never
// delete it silently); apply in place; `npx vitest run <tests>` must exit NON-ZERO;
// restore via `git checkout --`, verify clean. A GREEN probe = a hollow test = run fails.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'tests', 'mutation', 'probes.json');

/**
 * @typedef {{ name: string; note?: string; file: string; find: string; replace: string; tests: string[] }} Probe
 * @typedef {{ name: string; status: 'KILLED' | 'SURVIVED' | 'STALE' | 'BROKEN'; detail: string }} Result
 */

/** @returns {Probe[]} */
function loadManifest() {
  /** @type {unknown} */
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(raw) || raw.length === 0) die(`manifest ${manifestPath} must be a non-empty array`);
  const seen = new Set();
  for (const p of raw) {
    for (const key of ['name', 'file', 'find', 'replace']) {
      if (typeof p[key] !== 'string' || p[key] === '') die(`manifest probe is missing string field "${key}"`);
    }
    if (!Array.isArray(p.tests) || p.tests.length === 0 || p.tests.some((/** @type {unknown} */ t) => typeof t !== 'string')) {
      die(`probe ${p.name}: "tests" must be a non-empty string array`);
    }
    if (p.find === p.replace) die(`probe ${p.name}: find and replace are identical`);
    if (seen.has(p.name)) die(`duplicate probe name: ${p.name}`);
    seen.add(p.name);
  }
  return raw;
}

/** @param {string} message @returns {never} */
function die(message) {
  console.error(`test-mutation: ${message}`);
  process.exit(2);
}

/** @param {string[]} args */
function git(args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.error || r.status !== 0) die(`git ${args.join(' ')} failed: ${r.error?.message ?? r.stderr}`);
  return r.stdout;
}

/** @param {string} file */
function assertPristine(file) {
  if (git(['status', '--porcelain', '--', file]).trim() !== '') {
    die(`${file} has uncommitted changes — commit or stash them first (restore uses git checkout)`);
  }
}

/** @param {Probe} probe @returns {Result} */
function runProbe(probe) {
  const abs = path.join(root, probe.file);
  const original = readFileSync(abs, 'utf8');
  const first = original.indexOf(probe.find);
  const count = first === -1 ? 0 : original.split(probe.find).length - 1;
  if (count !== 1) {
    return {
      name: probe.name,
      status: 'STALE',
      detail: `find matched ${count}x in ${probe.file} — the code moved; update the probe with the refactor (never delete it silently)`,
    };
  }
  writeFileSync(abs, original.slice(0, first) + probe.replace + original.slice(first + probe.find.length));
  let vitest;
  try {
    vitest = spawnSync('npx', ['vitest', 'run', ...probe.tests], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0' },
    });
  } finally {
    git(['checkout', '--', probe.file]);
    if (git(['status', '--porcelain', '--', probe.file]).trim() !== '') {
      die(`restore left ${probe.file} dirty — repo state needs manual attention`);
    }
  }
  if (vitest.error) die(`vitest could not run for ${probe.name}: ${vitest.error.message}`);
  // eslint-disable-next-line no-control-regex -- strip ANSI color escapes
  const output = `${vitest.stdout}\n${vitest.stderr}`.replace(/\u001b\[[0-9;]*m/g, '');
  if (/Transform failed|Failed to load|ERR_MODULE_NOT_FOUND/.test(output)) {
    // The mutant didn't even parse/load: the suite never judged it.
    return { name: probe.name, status: 'BROKEN', detail: 'mutant failed to transform/load — fix the replace text' };
  }
  if (vitest.status === 0) {
    console.error(`\n!! SURVIVED: ${probe.name} — ${probe.tests.join(', ')} stayed GREEN under the mutation.`);
    console.error(`!! A green probe means a hollow test. Mutation applied to ${probe.file}:`);
    console.error(`!!   - ${probe.find.split('\n').join('\n!!   - ')}`);
    console.error(`!!   + ${probe.replace.split('\n').join('\n!!   + ')}`);
    if (probe.note) console.error(`!! Invariant: ${probe.note}`);
    return { name: probe.name, status: 'SURVIVED', detail: `suite stayed green: ${probe.tests.join(', ')}` };
  }
  const reds = [...output.matchAll(/^\s*×\s*(.+)$/gm)].map((m) => m[1].replace(/\s*\d+ms\s*$/, '').trim());
  const shown = reds.slice(0, 3).join(' | ') || `vitest exit ${String(vitest.status)}`;
  return {
    name: probe.name,
    status: 'KILLED',
    detail: `${String(reds.length)} RED: ${shown}${reds.length > 3 ? ' | …' : ''}`,
  };
}

function main() {
  const filters = process.argv.slice(2);
  const probes = loadManifest();
  const selected = filters.length === 0 ? probes : probes.filter((p) => filters.includes(p.name));
  if (selected.length === 0) die(`no probes match ${filters.join(', ')} (names: ${probes.map((p) => p.name).join(', ')})`);

  for (const probe of selected) assertPristine(probe.file);

  /** @type {Result[]} */
  const results = [];
  for (const [i, probe] of selected.entries()) {
    console.log(`[${String(i + 1)}/${String(selected.length)}] ${probe.name} → ${probe.file}`);
    const result = runProbe(probe);
    results.push(result);
    console.log(`    ${result.status}${result.status === 'KILLED' ? ` (${result.detail})` : ''}`);
  }

  const width = Math.max(...results.map((r) => r.name.length));
  console.log(`\n${'PROBE'.padEnd(width)}  RESULT    DETAIL`);
  for (const r of results) console.log(`${r.name.padEnd(width)}  ${r.status.padEnd(8)}  ${r.detail}`);
  const failed = results.filter((r) => r.status !== 'KILLED');
  console.log(`\n${String(results.length - failed.length)}/${String(results.length)} probes KILLED`);
  if (failed.length > 0) {
    console.error(`test-mutation FAILED: ${failed.map((r) => `${r.name} (${r.status})`).join(', ')}`);
    process.exit(1);
  }
}

main();
