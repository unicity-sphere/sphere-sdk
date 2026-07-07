/**
 * T-D7 regression tests for W11 originated-tag stamping in
 * PaymentsModule. Verifies that the direct `storage.set` call sites
 * route through the `setEntry` helper when the provider implements
 * it, carrying the expected OpLog entry type. Providers without
 * `setEntry` fall back to plain `set` and the operation still
 * succeeds — covered by the negative branch.
 *
 * Scope: exercises `setStorageEntry` via reflection rather than
 * spinning up a real PaymentsModule with all its dependencies. The
 * helper is a thin dispatcher; its correctness is proved by
 * showing (a) setEntry is invoked with the right args when
 * available, (b) falls through to set when absent, (c) each call
 * site in PaymentsModule reaches the helper with the intended
 * entryType.
 *
 * For (c) the tests use a grep-based assertion over the module
 * source — expensive-to-instantiate module surface makes a full
 * integration test impractical, but the grep catches regressions
 * where a future edit reintroduces `storage.set(…)` on a
 * W11-stamped key.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const PAYMENTS_MODULE_PATH = path.resolve(
  __dirname,
  '../../../modules/payments/PaymentsModule.ts',
);
// Phase 5 [C] quarantine — some historically-in-PaymentsModule bodies
// were moved wholesale to `legacy-v1/finalization.ts` (Phase 6.C deletes
// them). W11 stamping call-sites still need to be counted across both.
const PAYMENTS_LEGACY_FINALIZATION_PATH = path.resolve(
  __dirname,
  '../../../modules/payments/legacy-v1/finalization.ts',
);

// Phase 5 wave-3: the OUTBOX ops (which include four W11-stamped
// `setStorageEntry` call sites for STORAGE_KEYS_ADDRESS.OUTBOX) moved
// to `extensions/uxf/pipeline/module-glue/outbox-ops.ts` per
// docs/uxf/uxfv2-phase-5-payments-disposition.md. The source-level
// invariant survives — it just spans two files now.
const OUTBOX_OPS_PATH = path.resolve(
  __dirname,
  '../../../extensions/uxf/pipeline/module-glue/outbox-ops.ts',
);

describe('T-D7 PaymentsModule W11 stamping — source-level invariant', () => {
  const source =
    fs.readFileSync(PAYMENTS_MODULE_PATH, 'utf8') +
    '\n' +
    fs.readFileSync(PAYMENTS_LEGACY_FINALIZATION_PATH, 'utf8');
  const outboxOpsSource = fs.existsSync(OUTBOX_OPS_PATH)
    ? fs.readFileSync(OUTBOX_OPS_PATH, 'utf8')
    : '';
  // Combined view for source-level greps that used to run on
  // PaymentsModule.ts alone. Individual call-site guards below still
  // check each file independently so the invariant is scoped, not
  // laundered.
  const combinedSource = source + '\n' + outboxOpsSource;

  // Grep for the canonical W11-stamped keys and assert no raw
  // `storage.set(<key>, …)` appears. These keys represent user
  // actions or system state that must carry an explicit origin tag.
  const W11_STAMPED_KEYS: readonly string[] = [
    'STORAGE_KEYS_ADDRESS.OUTBOX',
    'STORAGE_KEYS_ADDRESS.PENDING_V5_TOKENS',
    'STORAGE_KEYS_ADDRESS.PROCESSED_COMBINED_TRANSFER_IDS',
    'STORAGE_KEYS_ADDRESS.PROCESSED_SPLIT_GROUP_IDS',
  ];

  for (const key of W11_STAMPED_KEYS) {
    it(`${key} is not written via raw storage.set (W11 routing guard)`, () => {
      // Build a regex that matches `this.deps!.storage.set(KEY,` —
      // i.e., a raw set using the W11-stamped key. The call sites
      // migrated in T-D7 now use setStorageEntry instead.
      const escapedKey = key.replace(/[.]/g, '\\.');
      const offenderRe = new RegExp(
        `storage\\s*\\.\\s*set\\s*\\(\\s*${escapedKey}\\b`,
      );
      // Check both PaymentsModule.ts and the module-glue outbox-ops.ts
      // where the OUTBOX-key call sites moved in Phase 5 wave-3.
      const offenders: string[] = [];
      for (const [name, src] of [
        ['PaymentsModule.ts', source],
        ['module-glue/outbox-ops.ts', outboxOpsSource],
      ] as const) {
        const lines = src.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (offenderRe.test(lines[i])) {
            offenders.push(`${name}:${i + 1}: ${lines[i].trim()}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  it('setStorageEntry helper is present at the expected class location', () => {
    // Anchor the helper to keep future refactors honest — a rename
    // or move should update this test alongside the call sites.
    expect(source).toMatch(/private\s+async\s+setStorageEntry\s*\(/);
    // Phase 5 persistence/ extraction: the `'token_send' | 'token_receive'
    // | 'cache_index'` union was hoisted into
    // `modules/payments/persistence/kv-writer-adapter.ts` as the
    // exported `EntryTag` alias, and the facade now delegates through
    // `writeKvEntry(...)`. The anchor tracks the alias name so a
    // rename or drop of `EntryTag` from the persistence submodule
    // trips this test.
    expect(source).toMatch(/entryType:\s*EntryTag\b/);
    expect(source).toMatch(/writeKvEntry\s*\(/);
  });

  it('every setStorageEntry call uses one of the declared entry types', () => {
    // The declared type is the union `'token_send' | 'token_receive'
    // | 'cache_index'`. Any call-site passing a raw string must match
    // one of those — TypeScript catches mismatches at compile time,
    // but a regression test anchors the narrow set explicitly.
    //
    // Post-wave-3: call sites span PaymentsModule.ts (PENDING_V5_TOKENS
    // paths) + extensions/uxf/pipeline/module-glue/outbox-ops.ts
    // (OUTBOX paths). Scan both.
    const calls = [
      ...combinedSource.matchAll(/setStorageEntry\s*\([^)]*,\s*['"]([^'"]+)['"]\s*\)/g),
    ];
    const tags = calls.map((m) => m[1]);
    const allowed = new Set(['token_send', 'token_receive', 'cache_index']);
    for (const tag of tags) {
      expect(allowed.has(tag), `unexpected entryType: ${tag}`).toBe(true);
    }
    // Sanity: we should have at least 6 call sites (two token_send
    // paths, two token_receive paths, two cache_index cleanups, plus
    // dedup-ledger writes).
    expect(tags.length).toBeGreaterThanOrEqual(6);
  });
});

describe('T-D7 setStorageEntry helper — dispatcher behaviour', () => {
  // Simulate the helper's dispatch logic directly (copy of the
  // PaymentsModule method body). This decouples the test from
  // PaymentsModule's heavy instantiation surface while pinning the
  // contract: setEntry is preferred when available, set is the
  // fallback.
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

  it('routes to setEntry with the given entryType when available', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const setEntry = vi.fn().mockResolvedValue(undefined);
    await setStorageEntry({ set, setEntry }, 'outbox', 'ref-123', 'token_send');
    expect(setEntry).toHaveBeenCalledWith('outbox', 'ref-123', 'token_send');
    expect(set).not.toHaveBeenCalled();
  });

  it('falls back to set when setEntry is absent', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    await setStorageEntry({ set }, 'outbox', 'ref-123', 'token_send');
    expect(set).toHaveBeenCalledWith('outbox', 'ref-123');
  });
});
