/**
 * T-D9 regression tests for W11 originated-tag stamping in
 * SwapModule. Mirrors the T-D7 payments test pattern: verifies the
 * direct `storage.set` call sites route through the `setEntry`
 * helper when the provider implements it, carrying the expected
 * OpLog entry type, and falls back to plain `set` otherwise.
 *
 * Scope: exercises `setStorageEntry` via a source-level invariant
 * (no raw `storage.set(<stamped-key>, …)`) plus a behavioural test
 * of a local copy of the dispatcher. SwapModule has enough
 * dependency surface (communications / accounting / escrow-client /
 * transport) that a full-module integration test would outstrip the
 * guarantee we want to pin here: that W11 classification reaches
 * the storage layer.
 *
 * Classification matrix (see SPEC §10.2.3 and
 * profile/aggregator-pointer/originated-tag.ts):
 *
 *   key                    entryType       call site
 *   ─────────────────────  ─────────────   ──────────────────────
 *   swap:{swapId}          swap_propose    persistSwap (progress='proposed')
 *   swap:{swapId}          swap_accept     persistSwap (progress='accepted')
 *   swap:{swapId}          swap_deposit    persistSwap (all other progress)
 *   swap_index             cache_index     persistIndex, loadFromStorage cleanup
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SWAP_MODULE_PATH = path.resolve(
  __dirname,
  '../../../modules/swap/SwapModule.ts',
);

describe('T-D9 SwapModule W11 stamping — source-level invariant', () => {
  const source = fs.readFileSync(SWAP_MODULE_PATH, 'utf8');

  // These keys represent user actions (swap record per-swap) and
  // system index state that must carry an explicit originated tag.
  // A future regression that reintroduces `storage.set(<key>, …)`
  // fails this test.
  const W11_STAMPED_KEYS: readonly string[] = [
    'STORAGE_KEYS_ADDRESS.SWAP_RECORD_PREFIX',
    'STORAGE_KEYS_ADDRESS.SWAP_INDEX',
  ];

  for (const key of W11_STAMPED_KEYS) {
    it(`${key} is not written via raw storage.set (W11 routing guard)`, () => {
      const escapedKey = key.replace(/[.]/g, '\\.');
      // Match `deps.storage.set(...KEY...` or `this.deps!.storage.set(...KEY...`
      // where KEY is the stamped key — we only care about raw set calls
      // that pass the stamped constant as part of the first argument.
      const offenderRe = new RegExp(
        `storage\\s*\\.\\s*set\\s*\\([^)]*${escapedKey}`,
      );
      const lines = source.split('\n');
      const offenders: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (offenderRe.test(lines[i])) {
          offenders.push(`line ${i + 1}: ${lines[i].trim()}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  it('setStorageEntry helper is present at the expected class location', () => {
    // Anchor the helper so a future refactor (rename / move) trips
    // this test rather than silently losing stamping.
    expect(source).toMatch(/private\s+async\s+setStorageEntry\s*\(/);
    // Narrow union covers the three swap user-action edges plus cache_index.
    expect(source).toMatch(/entryType:\s*['"]swap_propose['"]\s*\|/);
    expect(source).toMatch(/['"]swap_accept['"]/);
    expect(source).toMatch(/['"]swap_deposit['"]/);
    expect(source).toMatch(/['"]cache_index['"]/);
  });

  it('classifySwapWrite helper maps progress → user-action tag', () => {
    // Anchor the progress→tag mapping used by persistSwap.
    expect(source).toMatch(/private\s+classifySwapWrite\s*\(/);
    expect(source).toMatch(/progress\s*===\s*['"]proposed['"]/);
    expect(source).toMatch(/progress\s*===\s*['"]accepted['"]/);
  });

  it('every setStorageEntry call uses one of the declared entry types', () => {
    // TypeScript catches mismatches at compile time, but the grep
    // pin catches any future widening of the union that slips a new
    // tag into a call site without updating the declared set.
    // Calls may span multiple lines — scan with the `s` flag so `.`
    // matches newlines, and only count calls whose final positional
    // argument is a string literal (the cache_index path). Calls
    // whose last argument is `this.classifySwapWrite(...)` are
    // intentionally excluded here and covered by the classify/
    // persistSwap tests.
    const calls = [
      ...source.matchAll(
        /setStorageEntry\s*\([\s\S]*?,\s*['"]([a-z_]+)['"]\s*,?\s*\)/g,
      ),
    ];
    const tags = calls.map((m) => m[1]);
    const allowed = new Set([
      'swap_propose',
      'swap_accept',
      'swap_deposit',
      'cache_index',
    ]);
    for (const tag of tags) {
      expect(allowed.has(tag), `unexpected entryType: ${tag}`).toBe(true);
    }
    // We expect at least the two cache_index sites (persistIndex,
    // loadFromStorage cleanup).
    expect(tags.length).toBeGreaterThanOrEqual(2);
    // And cache_index must appear at least twice (both index writes).
    const cacheIndexCount = tags.filter((t) => t === 'cache_index').length;
    expect(cacheIndexCount).toBeGreaterThanOrEqual(2);
  });

  it('persistSwap routes through setStorageEntry with classified entry type', () => {
    // Anchor the persistSwap implementation so a regression that
    // reverts to raw `storage.set` or drops the classification call
    // is caught here.
    const persistSwapBlock = /private\s+async\s+persistSwap\s*\(\s*swap:\s*SwapRef[\s\S]+?^\s{2}\}/m;
    const match = source.match(persistSwapBlock);
    expect(match).not.toBeNull();
    const body = match![0];
    expect(body).toMatch(/this\.setStorageEntry\s*\(/);
    expect(body).toMatch(/this\.classifySwapWrite\s*\(\s*swap\.progress\s*\)/);
    expect(body).not.toMatch(/deps\.storage\.set\s*\(/);
  });
});

describe('T-D9 setStorageEntry helper — dispatcher behaviour', () => {
  // Simulate the helper's dispatch logic directly. Keeps the test
  // decoupled from SwapModule's heavy dependency surface while
  // pinning the contract: setEntry is preferred when available,
  // set is the fallback.
  async function setStorageEntry(
    storage: {
      set: (k: string, v: string) => Promise<void>;
      setEntry?: (k: string, v: string, t: string) => Promise<void>;
    },
    key: string,
    value: string,
    entryType: string,
  ): Promise<void> {
    if (typeof storage.setEntry === 'function') {
      await storage.setEntry(key, value, entryType);
    } else {
      await storage.set(key, value);
    }
  }

  it('routes to setEntry with the given entryType when available (swap_propose)', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const setEntry = vi.fn().mockResolvedValue(undefined);
    await setStorageEntry({ set, setEntry }, 'swap:abc', '{}', 'swap_propose');
    expect(setEntry).toHaveBeenCalledWith('swap:abc', '{}', 'swap_propose');
    expect(set).not.toHaveBeenCalled();
  });

  it('routes to setEntry with swap_accept when available', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const setEntry = vi.fn().mockResolvedValue(undefined);
    await setStorageEntry({ set, setEntry }, 'swap:abc', '{}', 'swap_accept');
    expect(setEntry).toHaveBeenCalledWith('swap:abc', '{}', 'swap_accept');
  });

  it('routes to setEntry with swap_deposit when available', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const setEntry = vi.fn().mockResolvedValue(undefined);
    await setStorageEntry({ set, setEntry }, 'swap:abc', '{}', 'swap_deposit');
    expect(setEntry).toHaveBeenCalledWith('swap:abc', '{}', 'swap_deposit');
  });

  it('routes to setEntry with cache_index for swap_index writes', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const setEntry = vi.fn().mockResolvedValue(undefined);
    await setStorageEntry({ set, setEntry }, 'swap_index', '[]', 'cache_index');
    expect(setEntry).toHaveBeenCalledWith('swap_index', '[]', 'cache_index');
  });

  it('falls back to set when setEntry is absent', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    await setStorageEntry({ set }, 'swap:abc', '{}', 'swap_propose');
    expect(set).toHaveBeenCalledWith('swap:abc', '{}');
  });
});

describe('T-D9 classifySwapWrite — progress → user-action mapping', () => {
  // Simulate the classifySwapWrite helper directly (SwapModule's
  // instance method is trivially stateless — it reads no fields).
  type SwapProgress =
    | 'proposed'
    | 'accepted'
    | 'announced'
    | 'depositing'
    | 'awaiting_counter'
    | 'concluding'
    | 'completed'
    | 'cancelled'
    | 'failed';

  function classifySwapWrite(
    progress: SwapProgress,
  ): 'swap_propose' | 'swap_accept' | 'swap_deposit' {
    if (progress === 'proposed') return 'swap_propose';
    if (progress === 'accepted') return 'swap_accept';
    return 'swap_deposit';
  }

  it('proposed → swap_propose', () => {
    expect(classifySwapWrite('proposed')).toBe('swap_propose');
  });

  it('accepted → swap_accept', () => {
    expect(classifySwapWrite('accepted')).toBe('swap_accept');
  });

  it.each([
    'announced',
    'depositing',
    'awaiting_counter',
    'concluding',
    'completed',
    'cancelled',
    'failed',
  ] as const)('%s → swap_deposit (post-accept progression)', (progress) => {
    expect(classifySwapWrite(progress)).toBe('swap_deposit');
  });
});
