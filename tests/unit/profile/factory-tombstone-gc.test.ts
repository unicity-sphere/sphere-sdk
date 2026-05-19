/**
 * Tests for Item #15 Phase F — `runProfileTombstoneGc` in
 * `profile/factory.ts`.
 *
 * The closure is exported separately from `createProfileProviders` so
 * its behaviour can be unit-tested against stub writer builders rather
 * than spinning up real OrbitDB. Production wiring invokes it from the
 * lean-snapshot builder's `gcExpiredTombstones` hook (configured by
 * `createProfileProviders`); these tests pin the closure's contract:
 *
 *   1. Discovers active addressIds from `listKeys()` via the address
 *      prefix regex (`DIRECT_xxxxxx_xxxxxx.`).
 *   2. Calls both OUTBOX and SENT `gcExpiredTombstones` on each address.
 *   3. Passes the configured `retentionMs` through to each writer.
 *   4. Silently skips addresses whose writer-build returned `null`
 *      (encryption / identity preconditions not satisfied).
 *   5. Per-writer thrown errors are swallowed — one bad writer must
 *      NOT block GC on the others.
 *   6. `listKeys()` failure → closure returns without throwing
 *      (snapshot build still proceeds).
 *   7. Empty key set → no writer-builder invocations.
 *   8. Duplicate address keys across many entries → builders invoked
 *      ONCE per address.
 *
 * @see profile/factory.ts — runProfileTombstoneGc + createProfileProviders
 * @see docs/uxf/OUTBOX-SEND-FOLLOWUPS.md — Item #15 Phase F
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROFILE_TOMBSTONE_RETENTION_MS,
  runProfileTombstoneGc,
  type ProfileTombstoneGcDeps,
} from '../../../profile/factory.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeWriter(): {
  gcExpiredTombstones: ReturnType<typeof vi.fn>;
} {
  return {
    gcExpiredTombstones: vi.fn(async () => ({
      scanned: 0,
      purged: 0,
      kept: 0,
      skipped: false,
    })),
  };
}

function makeDeps(
  overrides: Partial<ProfileTombstoneGcDeps> = {},
): ProfileTombstoneGcDeps {
  return {
    listKeys: vi.fn(async () => []),
    buildOutboxWriter: vi.fn(() => makeWriter()),
    buildSentLedgerWriter: vi.fn(() => makeWriter()),
    retentionMs: DEFAULT_PROFILE_TOMBSTONE_RETENTION_MS,
    ...overrides,
  };
}

const ADDR_A = 'DIRECT_aaaaaa_bbbbbb';
const ADDR_B = 'DIRECT_cccccc_dddddd';

// ---------------------------------------------------------------------------
// Address discovery
// ---------------------------------------------------------------------------

describe('runProfileTombstoneGc — address discovery', () => {
  it('extracts addressIds from per-address keys', async () => {
    const outboxBuilder = vi.fn(() => makeWriter());
    const sentBuilder = vi.fn(() => makeWriter());
    const deps = makeDeps({
      listKeys: async () => [
        `${ADDR_A}.outbox.id1`,
        `${ADDR_A}.outbox.id2`,
        `${ADDR_B}.sent.id3`,
        'mnemonic',
        'master_key',
        'tokens.bundle.bafyabc',
      ],
      buildOutboxWriter: outboxBuilder,
      buildSentLedgerWriter: sentBuilder,
    });

    await runProfileTombstoneGc(deps);

    // Each address invoked exactly once.
    expect(outboxBuilder).toHaveBeenCalledTimes(2);
    expect(sentBuilder).toHaveBeenCalledTimes(2);

    const outboxArgs = outboxBuilder.mock.calls.map((c) => c[0]).sort();
    expect(outboxArgs).toEqual([ADDR_A, ADDR_B]);

    const sentArgs = sentBuilder.mock.calls.map((c) => c[0]).sort();
    expect(sentArgs).toEqual([ADDR_A, ADDR_B]);
  });

  it('ignores non-address-prefixed keys', async () => {
    const outboxBuilder = vi.fn(() => makeWriter());
    const sentBuilder = vi.fn(() => makeWriter());
    const deps = makeDeps({
      listKeys: async () => [
        'mnemonic',
        'addresses.tracked',
        'tokens.bundle.bafyabc',
        'consolidation.pending',
        'last_wallet_event_ts_aabb',
      ],
      buildOutboxWriter: outboxBuilder,
      buildSentLedgerWriter: sentBuilder,
    });

    await runProfileTombstoneGc(deps);

    expect(outboxBuilder).not.toHaveBeenCalled();
    expect(sentBuilder).not.toHaveBeenCalled();
  });

  it('returns silently with empty key set', async () => {
    const outboxBuilder = vi.fn(() => makeWriter());
    const sentBuilder = vi.fn(() => makeWriter());
    const deps = makeDeps({
      listKeys: async () => [],
      buildOutboxWriter: outboxBuilder,
      buildSentLedgerWriter: sentBuilder,
    });

    await expect(runProfileTombstoneGc(deps)).resolves.toBeUndefined();
    expect(outboxBuilder).not.toHaveBeenCalled();
    expect(sentBuilder).not.toHaveBeenCalled();
  });

  it('deduplicates addresses across many entries', async () => {
    const outboxBuilder = vi.fn(() => makeWriter());
    const deps = makeDeps({
      listKeys: async () => [
        `${ADDR_A}.outbox.a`,
        `${ADDR_A}.outbox.b`,
        `${ADDR_A}.sent.c`,
        `${ADDR_A}.finalizationQueue.d`,
        `${ADDR_A}.recipientContext.request.e`,
      ],
      buildOutboxWriter: outboxBuilder,
    });

    await runProfileTombstoneGc(deps);

    expect(outboxBuilder).toHaveBeenCalledTimes(1);
    expect(outboxBuilder).toHaveBeenCalledWith(ADDR_A);
  });
});

// ---------------------------------------------------------------------------
// Writer dispatch
// ---------------------------------------------------------------------------

describe('runProfileTombstoneGc — writer dispatch', () => {
  it('passes retentionMs through to each writer', async () => {
    const outboxWriter = makeWriter();
    const sentWriter = makeWriter();
    const customRetention = 7 * 24 * 60 * 60 * 1000; // 7 days

    await runProfileTombstoneGc(
      makeDeps({
        listKeys: async () => [`${ADDR_A}.outbox.x`],
        buildOutboxWriter: () => outboxWriter,
        buildSentLedgerWriter: () => sentWriter,
        retentionMs: customRetention,
      }),
    );

    expect(outboxWriter.gcExpiredTombstones).toHaveBeenCalledWith({
      retentionMs: customRetention,
    });
    expect(sentWriter.gcExpiredTombstones).toHaveBeenCalledWith({
      retentionMs: customRetention,
    });
  });

  it('skips addresses where outbox builder returns null', async () => {
    const sentWriter = makeWriter();

    await runProfileTombstoneGc(
      makeDeps({
        listKeys: async () => [`${ADDR_A}.outbox.x`],
        buildOutboxWriter: () => null,
        buildSentLedgerWriter: () => sentWriter,
      }),
    );

    expect(sentWriter.gcExpiredTombstones).toHaveBeenCalledTimes(1);
  });

  it('skips addresses where sent builder returns null', async () => {
    const outboxWriter = makeWriter();

    await runProfileTombstoneGc(
      makeDeps({
        listKeys: async () => [`${ADDR_A}.outbox.x`],
        buildOutboxWriter: () => outboxWriter,
        buildSentLedgerWriter: () => null,
      }),
    );

    expect(outboxWriter.gcExpiredTombstones).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Error isolation
// ---------------------------------------------------------------------------

describe('runProfileTombstoneGc — error isolation', () => {
  it('swallows OUTBOX gcExpiredTombstones thrown error and proceeds to SENT', async () => {
    const outboxWriter = {
      gcExpiredTombstones: vi.fn(async () => {
        throw new Error('OUTBOX GC explosion');
      }),
    };
    const sentWriter = makeWriter();

    await expect(
      runProfileTombstoneGc(
        makeDeps({
          listKeys: async () => [`${ADDR_A}.outbox.x`],
          buildOutboxWriter: () => outboxWriter,
          buildSentLedgerWriter: () => sentWriter,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(outboxWriter.gcExpiredTombstones).toHaveBeenCalledTimes(1);
    // SENT still ran despite OUTBOX failure.
    expect(sentWriter.gcExpiredTombstones).toHaveBeenCalledTimes(1);
  });

  it('swallows SENT gcExpiredTombstones thrown error', async () => {
    const sentWriter = {
      gcExpiredTombstones: vi.fn(async () => {
        throw new Error('SENT GC explosion');
      }),
    };
    const outboxWriter = makeWriter();

    await expect(
      runProfileTombstoneGc(
        makeDeps({
          listKeys: async () => [`${ADDR_A}.outbox.x`],
          buildOutboxWriter: () => outboxWriter,
          buildSentLedgerWriter: () => sentWriter,
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('isolates per-address failures: one bad address does not block others', async () => {
    let calls = 0;
    const outboxBuilder = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        return {
          gcExpiredTombstones: vi.fn(async () => {
            throw new Error('first address GC failed');
          }),
        };
      }
      return makeWriter();
    });

    await runProfileTombstoneGc(
      makeDeps({
        listKeys: async () => [
          `${ADDR_A}.outbox.x`,
          `${ADDR_B}.outbox.y`,
        ],
        buildOutboxWriter: outboxBuilder,
      }),
    );

    // Both addresses processed despite first failure.
    expect(outboxBuilder).toHaveBeenCalledTimes(2);
  });

  it('returns silently when listKeys throws', async () => {
    const outboxBuilder = vi.fn(() => makeWriter());

    await expect(
      runProfileTombstoneGc(
        makeDeps({
          listKeys: async () => {
            throw new Error('storage offline');
          },
          buildOutboxWriter: outboxBuilder,
        }),
      ),
    ).resolves.toBeUndefined();

    // No builders consulted — listKeys failure is treated as no
    // discoverable addresses.
    expect(outboxBuilder).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe('runProfileTombstoneGc — defaults', () => {
  it('exposes the 30-day default retention as a constant', () => {
    expect(DEFAULT_PROFILE_TOMBSTONE_RETENTION_MS).toBe(
      30 * 24 * 60 * 60 * 1000,
    );
  });
});
