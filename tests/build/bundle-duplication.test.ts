/**
 * T-D12b — ProfilePointerLayer bundle-duplication invariant.
 *
 * tsup compiles each top-level entry (index.ts, profile/index.ts,
 * profile/browser.ts, profile/node.ts, impl/browser/index.ts,
 * impl/nodejs/index.ts, …) into its own bundle. Any ESM symbol
 * re-exported from multiple entries is inlined once per bundle —
 * producing distinct constructors, distinct `instanceof` identities,
 * and a subtle footgun for consumers who import from different
 * subpaths.
 *
 * CLAUDE.md documents the concrete example: `TokenRegistry` had to be
 * configured from both `dist/index.js` and `dist/impl/browser/index.js`
 * because each bundle inlines its own copy of the singleton.
 *
 * The pointer layer avoids the footgun by exporting `ProfilePointerLayer`
 * from EXACTLY ONE module: `profile/aggregator-pointer/index.ts`. No
 * top-level barrel re-exports it. Consumers that want the class
 * reference use the deep import path; internal wiring in each bundle
 * can import freely because the class is only ever constructed inside
 * `buildProfilePointerLayer` in `profile/pointer-wiring.ts`, never
 * `instanceof`-checked across bundle boundaries.
 *
 * This test pins that invariant. If a future refactor adds a re-export
 * of `ProfilePointerLayer` to a top-level barrel (directly or
 * transitively via `export *`), this test fails and forces the change
 * author to either:
 *   (a) Use a singleton pattern (`Symbol.for('...')` + dual-configure)
 *       so the symbol resolves to the same reference across bundles;
 *       document the pattern inline and add a positive test that
 *       asserts identity.
 *   (b) Keep the deep-import-only convention and revert the barrel
 *       addition.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

/** Top-level tsup entry points that MUST NOT re-export ProfilePointerLayer. */
const TOP_LEVEL_BARRELS: readonly string[] = [
  'index.ts',
  'extensions/uxf/profile/index.ts',
  'extensions/uxf/profile/browser.ts',
  'extensions/uxf/profile/node.ts',
  'impl/browser/index.ts',
  'impl/nodejs/index.ts',
];

/**
 * Heuristic re-export check. Looks for the class NAME appearing in any
 * `export` statement. A false positive would require the string
 * `ProfilePointerLayer` to appear in a non-export context (comment,
 * string literal); we scope the match to the `export` keyword line.
 *
 * Misses: `export * from './aggregator-pointer/index'` would re-export
 * everything without naming the class — separate assertion below
 * covers the wildcard case.
 */
function grepExportsNaming(content: string, symbol: string): string[] {
  const hits: string[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // `export { X }` or `export { X as Y }` or `export X` or `export type { X }`
    if (/^\s*export\b/.test(line) && line.includes(symbol)) {
      // Exclude comment lines that happen to include both `export` and the symbol.
      if (/^\s*\*/.test(line) || /^\s*\/\//.test(line)) continue;
      hits.push(`line ${i + 1}: ${line.trim()}`);
    }
  }
  return hits;
}

/**
 * Check for blanket `export * from '...aggregator-pointer...'` which
 * would transitively re-export ProfilePointerLayer without naming it.
 * Also catches the namespace form `export * as NS from '...'`, which
 * inlines the module into the second bundle under an alias — same
 * footgun as a direct wildcard re-export.
 */
function grepWildcardReExport(content: string): string[] {
  const hits: string[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // `export * from '…'` OR `export * as Name from '…'`
    if (/^\s*export\s*\*\s*(as\s+\w+\s+)?from/.test(line) && line.includes('aggregator-pointer')) {
      hits.push(`line ${i + 1}: ${line.trim()}`);
    }
  }
  return hits;
}

describe('T-D12b — ProfilePointerLayer bundle-duplication invariant', () => {
  it('ProfilePointerLayer is not re-exported from any top-level barrel', () => {
    const offenders: string[] = [];
    for (const rel of TOP_LEVEL_BARRELS) {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) continue; // optional entry points may not exist in every config
      const content = fs.readFileSync(abs, 'utf8');
      const named = grepExportsNaming(content, 'ProfilePointerLayer');
      const wildcard = grepWildcardReExport(content);
      if (named.length > 0 || wildcard.length > 0) {
        offenders.push(
          `${rel}:\n  named: ${JSON.stringify(named)}\n  wildcard: ${JSON.stringify(wildcard)}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it('ProfilePointerLayer is exported from exactly one canonical module', () => {
    // Canonical: profile/aggregator-pointer/index.ts
    const canonical = path.join(ROOT, 'extensions/uxf/profile/aggregator-pointer/index.ts');
    expect(fs.existsSync(canonical)).toBe(true);
    const content = fs.readFileSync(canonical, 'utf8');
    expect(grepExportsNaming(content, 'ProfilePointerLayer')).not.toEqual([]);
  });
});
