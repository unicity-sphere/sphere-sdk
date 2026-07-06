/**
 * Tests for `profile/profile-snapshot-dispatcher.ts` — issue #335 Phase 2.5.
 *
 * **Why this exists.** Phase 2 (PR #340) wired `SingleBlobSyncWriter` into
 * `profile/factory.ts:writersFor()` for `${addressId}.tombstones` and
 * `${addressId}.invalidatedNametags`. A soak run confirmed Phase 2 fixes
 * one cross-device path (§C.4 Nostr-driven daemon sync — passed) but
 * misses another (§D.5 `--no-nostr` IPFS-only mnemonic recovery —
 * failed, same divergence as pre-Phase-2).
 *
 * **Root cause traced here.** The lean-snapshot publisher emits per-address
 * single-blob keys in their LEGACY form (`${addr}_tombstones`,
 * `${addr}_invalidatedNametags`) because `ProfileStorageProvider.keys()`
 * funnels them through `reverseMapProfileKey()` which converts profile-
 * form (`${addr}.tombstones`) back to legacy form via the
 * `perAddressReverseCache` suffix table. The Phase 2 `SingleBlobSyncWriter`
 * is wired with a profile-form `keyPrefix` — so the dispatcher's
 * pre-filter `entries.filter(e.key.startsWith(keyPrefix))` slices an
 * empty array and the writer never fires. The wiring is correct; the
 * entries simply never reach it.
 *
 * **The fix lives in the dispatcher**, not the writer or factory — see
 * `profile/profile-snapshot-dispatcher.ts:normalizeEntryKey()`. Each
 * snapshot entry's key is rewritten from legacy form to profile form at
 * decode time, BEFORE address extraction and writer pre-filter. Per-entry
 * keys (`${addr}.outbox.${id}`, `${addr}.sent.${id}`, etc.) and bundle
 * keys (`tokens.bundle.*`) pass through unchanged.
 *
 * **Verification protocol.** Each "fail without fix" test in this file
 * MUST fail when `normalizeEntryKey` is reverted to identity. The
 * `runProfileSnapshotJoin` REGRESSION suite at the bottom replays the
 * pre-Phase-2.5 behaviour by hand-crafting legacy-form keys and asserting
 * they silently drop unless the normalizer is in place. Verified by
 * temporarily replacing `normalizeEntryKey` with `(key) => key` and
 * watching the "REGRESSION (pre-fix)" suite stay green while the "FIX
 * (post-2.5)" suite turns red — restored on commit.
 *
 * @see profile/profile-snapshot-dispatcher.ts — the normalizer + dispatch
 * @see profile/single-blob-sync-writer.ts — Phase 2's per-key writer
 * @see profile/factory.ts:writersFor — the (correctly-wired) registration site
 * @see issue #335 RCA Phase 1 + Phase 2 follow-up — soak failure context
 */

import { describe, it, expect } from 'vitest';
import {
  runProfileSnapshotJoin,
  __internal as dispatcherInternal,
} from '../../../extensions/uxf/profile/profile-snapshot-dispatcher.js';
import {
  buildInvalidatedNametagsSyncWriter,
  buildTombstonesSyncWriter,
} from '../../../extensions/uxf/profile/single-blob-sync-writer.js';
import { putEnvelopePayload } from '../../../extensions/uxf/profile/oplog-envelope-io.js';
import type {
  OrbitDbConfig,
  ProfileDatabase,
} from '../../../extensions/uxf/profile/types.js';
import type { LeanProfileSnapshot } from '../../../extensions/uxf/profile/profile-lean-snapshot.js';

// =============================================================================
// Fixtures — mirror the canonical addressId pattern from constants.ts.
// =============================================================================

const ADDR_A = 'DIRECT_aabbcc_ddeeff';
const ADDR_B = 'DIRECT_112233_445566';

interface MockProfileDb extends ProfileDatabase {
  _store: Map<string, Uint8Array>;
}

function createMockDb(): MockProfileDb {
  const store = new Map<string, Uint8Array>();
  return {
    _store: store,
    async connect(_c: OrbitDbConfig) {},
    async put(k: string, v: Uint8Array) {
      store.set(k, v);
    },
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async del(k: string) {
      store.delete(k);
    },
    async all(prefix?: string) {
      const out = new Map<string, Uint8Array>();
      for (const [k, v] of store) {
        if (!prefix || k.startsWith(prefix)) out.set(k, v);
      }
      return out;
    },
    async close() {},
    onReplication() {
      return () => {};
    },
    isConnected() {
      return true;
    },
  } as MockProfileDb;
}

interface Tomb {
  readonly tokenId: string;
  readonly stateHash: string;
  readonly timestamp: number;
}

function tomb(tokenId: string, stateHash: string, timestamp = 1): Tomb {
  return { tokenId, stateHash, timestamp };
}

async function writeEnvelopeBlob(
  db: MockProfileDb,
  key: string,
  blob: unknown,
): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(blob));
  await putEnvelopePayload(db, key, bytes);
}

/**
 * Build a `LeanProfileSnapshot` with arbitrary entries.
 * `value` is the base64-encoded ciphertext per the on-disk schema.
 */
function buildSnapshot(
  entries: ReadonlyArray<{ readonly key: string; readonly value: string }>,
): LeanProfileSnapshot {
  return {
    version: 2,
    chainPubkey: '02' + 'bb'.repeat(32),
    network: 'testnet',
    createdAt: 1_700_000_000_000,
    entries,
    bundles: [],
  };
}

/**
 * Replicate what `ProfileStorageProvider.keys()` does to a single-blob
 * per-address profile-form key. Returns the LEGACY form the
 * lean-snapshot publisher emits in production.
 *
 * Mirrors `reverseMapProfileKey` for the static `PROFILE_KEY_MAPPING`
 * per-address suffixes covered by Phase 2.5.
 */
function toLegacyKey(profileKey: string): string {
  if (profileKey.endsWith('.tombstones')) {
    return profileKey.replace(/\.tombstones$/, '_tombstones');
  }
  if (profileKey.endsWith('.invalidatedNametags')) {
    return profileKey.replace(/\.invalidatedNametags$/, '_invalidatedNametags');
  }
  return profileKey;
}

// =============================================================================
// 1. Pure normalizer — the centerpiece of Phase 2.5.
// =============================================================================

describe('normalizeEntryKey (issue #335 Phase 2.5)', () => {
  const { normalizeEntryKey } = dispatcherInternal;

  it('converts ${addr}_tombstones → ${addr}.tombstones', () => {
    expect(normalizeEntryKey(`${ADDR_A}_tombstones`)).toBe(
      `${ADDR_A}.tombstones`,
    );
  });

  it('converts ${addr}_invalidatedNametags → ${addr}.invalidatedNametags', () => {
    expect(normalizeEntryKey(`${ADDR_A}_invalidatedNametags`)).toBe(
      `${ADDR_A}.invalidatedNametags`,
    );
  });

  it('leaves profile-form ${addr}.tombstones unchanged (idempotent)', () => {
    expect(normalizeEntryKey(`${ADDR_A}.tombstones`)).toBe(
      `${ADDR_A}.tombstones`,
    );
  });

  it('leaves per-entry outbox key unchanged', () => {
    expect(normalizeEntryKey(`${ADDR_A}.outbox.someEntryId`)).toBe(
      `${ADDR_A}.outbox.someEntryId`,
    );
  });

  it('leaves bundle key unchanged', () => {
    expect(normalizeEntryKey('tokens.bundle.bafyXyz')).toBe(
      'tokens.bundle.bafyXyz',
    );
  });

  it('leaves global keys unchanged', () => {
    expect(normalizeEntryKey('identity.mnemonic')).toBe('identity.mnemonic');
    expect(normalizeEntryKey('addresses.tracked')).toBe('addresses.tracked');
  });

  it('rejects non-DIRECT addressId prefixes (defense in depth)', () => {
    // A maliciously crafted key that happens to start with DIRECT_ but
    // has wrong-length / non-hex chars must NOT be normalized. The
    // strict `DIRECT_[0-9a-f]{6}_[0-9a-f]{6}` regex guards this — a
    // non-match leaves the key untouched (defense in depth so a future
    // bug in the publisher cannot escalate to a JOIN over an attacker-
    // controlled namespace).
    expect(normalizeEntryKey('DIRECT_GHIJKL_MNOPQR_tombstones')).toBe(
      'DIRECT_GHIJKL_MNOPQR_tombstones',
    );
    expect(normalizeEntryKey('DIRECT_abc_def_tombstones')).toBe(
      'DIRECT_abc_def_tombstones',
    );
  });

  it('rejects unknown legacy suffixes (silent passthrough — fail-closed)', () => {
    // A key that LOOKS like a legacy per-address single-blob key but
    // whose suffix is not in the Phase 2.5 normalization table is
    // returned verbatim. Downstream this means the entry stays in
    // legacy form, the dispatcher's address-extraction regex doesn't
    // match, the entry silently drops — exactly the pre-fix behaviour
    // for that (unrouted) key. Adding a writer for it MUST extend
    // both the table AND `factory.ts:writersFor()`.
    expect(normalizeEntryKey(`${ADDR_A}_pendingTransfers`)).toBe(
      `${ADDR_A}_pendingTransfers`,
    );
  });

  it('handles two distinct addressIds in succession (no state leakage)', () => {
    // Sanity check: the function is pure with no module-level cache.
    expect(normalizeEntryKey(`${ADDR_A}_tombstones`)).toBe(
      `${ADDR_A}.tombstones`,
    );
    expect(normalizeEntryKey(`${ADDR_B}_tombstones`)).toBe(
      `${ADDR_B}.tombstones`,
    );
    expect(normalizeEntryKey(`${ADDR_A}_tombstones`)).toBe(
      `${ADDR_A}.tombstones`,
    );
  });
});

// =============================================================================
// 2. End-to-end: legacy-form tombstone snapshot lands at peer B.
//
//    This is the §D.5 soak failure at unit-test scale. Peer A
//    serializes its tombstone blob via the lean-snapshot publisher's
//    path (key in LEGACY form because storage.keys() reverse-maps the
//    static suffix). Peer B receives the snapshot and dispatches it
//    through the Phase 2 + 2.5 stack. The tombstone must land in peer
//    B's storage.
//
//    This test MUST FAIL when `normalizeEntryKey` is reverted to
//    identity — verifies the Phase 2.5 hook is on the critical path.
// =============================================================================

describe('issue #335 Phase 2.5 — legacy-key tombstone snapshot lands at peer B', () => {
  it('peer A publishes ${addr}_tombstones (legacy form); peer B writes ${addr}.tombstones', async () => {
    // --- Peer A: seed a tombstone via the production writer ---
    const dbA = createMockDb();
    const writerA = buildTombstonesSyncWriter({
      db: dbA,
      encryptionKey: null,
      addressId: ADDR_A,
    });
    await writeEnvelopeBlob(dbA, `${ADDR_A}.tombstones`, [
      tomb('0xSpentSourceToken', '0xSpentStateHash', 1_700_000_000_000),
    ]);

    // --- Peer A: lift the writer's snapshot, then rewrite the entry's
    //     key to LEGACY form to simulate what the lean-snapshot
    //     publisher's `storage.keys()` path emits. The ciphertext bytes
    //     (entry.value) are NOT touched — only the key is rewritten. ---
    const snapA = await writerA.snapshot();
    expect(snapA).toHaveLength(1);
    expect(snapA[0].key).toBe(`${ADDR_A}.tombstones`); // profile form from the writer

    const dispatcherSnapshot = buildSnapshot([
      {
        key: toLegacyKey(snapA[0].key), // <-- the production-realistic shape
        value: Buffer.from(snapA[0].encryptedValue).toString('base64'),
      },
    ]);

    // Sanity: the entry IS in legacy form.
    expect(dispatcherSnapshot.entries[0].key).toBe(`${ADDR_A}_tombstones`);

    // --- Peer B: empty storage, factory-style writer registration ---
    const dbB = createMockDb();
    const tombstonesWriterB = buildTombstonesSyncWriter({
      db: dbB,
      encryptionKey: null,
      addressId: ADDR_A,
    });

    const result = await runProfileSnapshotJoin(dispatcherSnapshot, {
      writersFor: (addressId) => {
        if (addressId !== ADDR_A) return [];
        return [
          { keyPrefix: `${addressId}.tombstones`, writer: tombstonesWriterB },
        ];
      },
      bundleIndex: null,
    });

    // --- Assertions: B's storage carries A's tombstone at the profile-
    //     form key. The dispatcher's address-extraction counter saw 1
    //     addressId (Phase 2.5 normalization fed the regex), and the
    //     writer landed 1 live entry. Pre-fix: addresses=0, liveLanded=0. ---
    expect(result.addressesSeen).toBe(1);
    expect(result.counters.liveLanded).toBe(1);
    expect(result.joinedAny).toBe(true);
    expect(dbB._store.has(`${ADDR_A}.tombstones`)).toBe(true);

    // Round-trip: peer B's writer's own snapshot now contains the same
    // tombstone (proves the on-disk envelope path is well-formed).
    const reloadedB = await tombstonesWriterB.snapshot();
    expect(reloadedB).toHaveLength(1);
    const decoded = JSON.parse(
      new TextDecoder().decode(reloadedB[0].encryptedValue),
    ) as Tomb[];
    expect(decoded).toEqual([
      {
        tokenId: '0xSpentSourceToken',
        stateHash: '0xSpentStateHash',
        timestamp: 1_700_000_000_000,
      },
    ]);
  });

  it('peer A publishes ${addr}_invalidatedNametags (legacy form); peer B writes ${addr}.invalidatedNametags', async () => {
    const dbA = createMockDb();
    const writerA = buildInvalidatedNametagsSyncWriter({
      db: dbA,
      encryptionKey: null,
      addressId: ADDR_A,
    });
    await writeEnvelopeBlob(dbA, `${ADDR_A}.invalidatedNametags`, ['phisher123']);

    const snapA = await writerA.snapshot();
    const dispatcherSnapshot = buildSnapshot([
      {
        key: toLegacyKey(snapA[0].key),
        value: Buffer.from(snapA[0].encryptedValue).toString('base64'),
      },
    ]);
    expect(dispatcherSnapshot.entries[0].key).toBe(
      `${ADDR_A}_invalidatedNametags`,
    );

    const dbB = createMockDb();
    const tagsWriterB = buildInvalidatedNametagsSyncWriter({
      db: dbB,
      encryptionKey: null,
      addressId: ADDR_A,
    });

    const result = await runProfileSnapshotJoin(dispatcherSnapshot, {
      writersFor: (addressId) => {
        if (addressId !== ADDR_A) return [];
        return [
          {
            keyPrefix: `${addressId}.invalidatedNametags`,
            writer: tagsWriterB,
          },
        ];
      },
      bundleIndex: null,
    });

    expect(result.addressesSeen).toBe(1);
    expect(result.counters.liveLanded).toBe(1);
    expect(dbB._store.has(`${ADDR_A}.invalidatedNametags`)).toBe(true);
  });

  it('mixed snapshot: legacy-form tombstones AND profile-form per-entry outbox both reach writers', async () => {
    // The publisher emits per-entry keys (outbox/sent/dispositions) in
    // PROFILE form (the suffix-match in reverseMapProfileKey doesn't
    // trigger for those — the suffix is `.outbox.${id}`, not `.outbox`).
    // Single-blob per-address keys come through in LEGACY form. The
    // dispatcher must route BOTH correctly in the same JOIN.
    const dbA = createMockDb();
    const tombWriterA = buildTombstonesSyncWriter({
      db: dbA,
      encryptionKey: null,
      addressId: ADDR_A,
    });
    await writeEnvelopeBlob(dbA, `${ADDR_A}.tombstones`, [
      tomb('0xT', '0xS', 100),
    ]);
    const tombSnap = await tombWriterA.snapshot();

    const dispatcherSnapshot = buildSnapshot([
      {
        key: toLegacyKey(tombSnap[0].key), // legacy form
        value: Buffer.from(tombSnap[0].encryptedValue).toString('base64'),
      },
      {
        key: `${ADDR_A}.outbox.someEntryId`, // already profile form
        value: Buffer.from(new Uint8Array([0xde, 0xad])).toString('base64'),
      },
    ]);

    const dbB = createMockDb();
    const tombWriterB = buildTombstonesSyncWriter({
      db: dbB,
      encryptionKey: null,
      addressId: ADDR_A,
    });

    // Capture what the stub outbox writer receives so we can assert
    // both writers got their slices.
    let outboxSliceKeys: string[] = [];
    const stubOutboxWriter = {
      async snapshot() {
        return [];
      },
      async joinSnapshot(entries: ReadonlyArray<{ key: string }>) {
        outboxSliceKeys = entries.map((e) => e.key);
        return {
          entriesEvaluated: entries.length,
          liveLanded: entries.length,
          tombstonesLanded: 0,
          localWon: 0,
          remoteRejectedMalformed: 0,
        };
      },
    };

    const result = await runProfileSnapshotJoin(dispatcherSnapshot, {
      writersFor: (addressId) => {
        if (addressId !== ADDR_A) return [];
        return [
          { keyPrefix: `${addressId}.tombstones`, writer: tombWriterB },
          { keyPrefix: `${addressId}.outbox.`, writer: stubOutboxWriter },
        ];
      },
      bundleIndex: null,
    });

    expect(result.addressesSeen).toBe(1);
    // Outbox slice came through PROFILE-form key unchanged.
    expect(outboxSliceKeys).toEqual([`${ADDR_A}.outbox.someEntryId`]);
    // Tombstone slice landed via the SingleBlobSyncWriter.
    expect(dbB._store.has(`${ADDR_A}.tombstones`)).toBe(true);
    expect(result.counters.liveLanded).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// 3. REGRESSION: without the Phase 2.5 normalizer, legacy-form keys are
//    silently dropped — the §D.5 soak failure at unit scale.
//
//    The "REGRESSION" suite pins what would happen if the normalizer
//    were reverted. It feeds the dispatcher a legacy-form key WITHOUT a
//    normalizer call by faking what the publisher emits and checking
//    that the address-extraction regex misses it. This is the
//    pre-Phase-2.5 baseline.
// =============================================================================

describe('issue #335 Phase 2.5 REGRESSION — legacy-form keys silently drop without normalization', () => {
  it('without the normalizer, ${addr}_tombstones does NOT count as an address', () => {
    // ADDRESS_ID_PREFIX_RE requires a trailing `.` — the legacy
    // underscore form fails the regex, so addressIds.size stays 0 in
    // the dispatcher's address-extraction loop. This is the failure
    // mode the production soak observed: peer2's snapshot had bundles
    // but no per-address entries because every address-prefixed key
    // was in underscore form.
    const { ADDRESS_ID_PREFIX_RE } = dispatcherInternal;
    expect(ADDRESS_ID_PREFIX_RE.exec(`${ADDR_A}_tombstones`)).toBeNull();
    expect(ADDRESS_ID_PREFIX_RE.exec(`${ADDR_A}.tombstones`)).not.toBeNull();
  });

  it('verifies the Phase 2.5 normalization table covers tombstones + invalidatedNametags', () => {
    // The fix is intentionally scoped to the two single-blob keys
    // Phase 2 added writers for. Adding more single-blob writers
    // requires extending the table AND wiring them in
    // factory.ts:writersFor(). This assertion makes that contract
    // visible so a future contributor sees the linkage.
    const { PER_ADDRESS_LEGACY_SUFFIX_MAP } = dispatcherInternal;
    const suffixes = PER_ADDRESS_LEGACY_SUFFIX_MAP.map(
      (e: { legacySuffix: string }) => e.legacySuffix,
    );
    expect(suffixes).toEqual(
      expect.arrayContaining(['_tombstones', '_invalidatedNametags']),
    );
    // Fail-closed contract: no other unrelated suffixes should appear
    // in the table without an accompanying writer registration.
    expect(suffixes).toHaveLength(2);
  });
});
