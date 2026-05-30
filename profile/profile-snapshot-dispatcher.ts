/**
 * Item #15 Phase D.2 — Pull-side snapshot dispatcher.
 *
 * Consumes a parsed {@link LeanProfileSnapshot} (produced by Phase A's
 * `parseLeanProfileSnapshot`) and dispatches per-writer JOINs over the
 * snapshot's entries.
 *
 * **Responsibilities**:
 *   1. Base64-decode the snapshot's encrypted KV entries into the
 *      raw-bytes {@link SnapshotEntry} shape consumed by each writer's
 *      `joinSnapshot()`.
 *   2. Extract unique `addressId` prefixes from the entry keys
 *      (pattern `DIRECT_[0-9a-f]{6}_[0-9a-f]{6}`) so the dispatcher
 *      can instantiate per-address sync writers without depending on
 *      the receiver's in-memory tracked-addresses cache (which may
 *      lag a fresh address that landed via this very snapshot).
 *   3. Dispatch each per-address writer (`OutboxWriter`,
 *      `SentLedgerWriter`, finalization-queue, recipient-context
 *      request + finalization) over the writer's prefix-filtered
 *      slice of `entries[]`. Each writer's `joinSnapshot` already
 *      validates the prefix and rejects foreign entries; pre-filtering
 *      is purely for diagnostic clarity.
 *   4. Dispatch the wallet-global {@link BundleIndex} writer over
 *      `tokens.bundle.*` entries.
 *   5. Aggregate per-writer {@link JoinResult} counters and return a
 *      consolidated {@link ApplySnapshotResult} so the pointer-wiring
 *      layer can decide whether to re-mark the profile dirty (if any
 *      JOIN landed, the receiver's snapshot now diverges from the one
 *      it just consumed → next flush re-publishes the union).
 *
 * **What this module DOES NOT do**:
 *   - Persist the local pointer version cursor — that stays in
 *     `buildFetchAndJoin` per the existing crash-safety contract
 *     (write data → advance cursor, never the inverse).
 *   - Fetch the CAR from IPFS — the pointer-wiring layer does that.
 *   - Notify the dirty-flush debouncer — each per-writer
 *     `joinSnapshot()` already invokes `notifyProfileDirty()` when
 *     entries land, per the Phase C contract.
 *
 * @see profile/profile-lean-snapshot.ts — snapshot format
 * @see profile/profile-snapshot-merge.ts — per-writer JOIN runner
 * @see profile/pointer-wiring.ts — the caller (D.2 buildFetchAndJoin path)
 * @module profile/profile-snapshot-dispatcher
 */

import { logger } from '../core/logger';
import type { LeanProfileSnapshot } from './profile-lean-snapshot';
import type {
  JoinResult,
  ProfileSyncWriter,
  SnapshotEntry,
} from './profile-snapshot-merge';
import { BUNDLE_KEY_PREFIX } from './profile-token-storage/bundle-index';

// =============================================================================
// Public types
// =============================================================================

/**
 * One per-address writer entry produced by the {@link ProfileSnapshotJoinDeps}
 * factory. The `keyPrefix` is captured at construction so the dispatcher
 * can pre-filter `entries[]` before invoking `joinSnapshot()` — each
 * writer's internal classifier already filters defensively, but
 * pre-filtering keeps the `remoteRejectedMalformed` counter signal-only
 * (counts truly malformed entries rather than foreign-prefix noise).
 */
export interface SnapshotJoinWriterEntry {
  readonly keyPrefix: string;
  readonly writer: ProfileSyncWriter;
}

/**
 * Dependency block for {@link runProfileSnapshotJoin}. Production
 * wiring is built in `profile/factory.ts:createProfileProviders`
 * after both storage providers are constructed. Unit tests inject
 * stubs.
 */
export interface ProfileSnapshotJoinDeps {
  /**
   * Build the per-address sync writers for a given `addressId`. The
   * factory implementation calls `storage.buildOutboxWriter(addressId)`,
   * `storage.buildSentLedgerWriter(addressId)`,
   * `finalizationStorage.syncWriterFor(addressId)`,
   * `recipientContextStorage.syncWritersFor(addressId).{request,finalization}`.
   *
   * Returns an empty array if encryption / identity preconditions are
   * not yet satisfied (the dispatcher logs and skips). Per-address
   * writers are constructed lazily so a remote snapshot from a peer
   * that uses a new HD index converges without needing the receiver
   * to know about that address ahead of time.
   */
  readonly writersFor: (
    addressId: string,
  ) => ReadonlyArray<SnapshotJoinWriterEntry>;
  /**
   * The wallet-global {@link BundleIndex} sync writer, or `null` when
   * the token storage layer is not ready (e.g., shutdown in progress).
   * BundleIndex implements `ProfileSyncWriter` directly and owns the
   * `tokens.bundle.*` namespace.
   */
  readonly bundleIndex: ProfileSyncWriter | null;
  /** Optional debug logger; falls back to the SDK logger. */
  readonly log?: (msg: string) => void;
}

/**
 * Aggregated counters across every per-writer JOIN performed by a
 * single dispatch. Mirrors the per-writer {@link JoinResult} shape
 * with all values summed.
 */
export interface AggregatedJoinCounters {
  readonly entriesEvaluated: number;
  readonly liveLanded: number;
  readonly tombstonesLanded: number;
  readonly localWon: number;
  readonly remoteRejectedMalformed: number;
}

/**
 * Outcome of a full snapshot apply. The pointer-wiring layer uses
 * `joinedAny` to decide whether to mark the profile dirty for a
 * follow-up re-publish (the receiver's state now is the *union* of
 * the consumed snapshot + the receiver's local state; the next
 * pointer version should reflect that union).
 */
export interface ApplySnapshotResult {
  /**
   * True if any live or tombstone entry from the remote snapshot was
   * persisted locally during this dispatch. The dispatcher itself
   * does NOT propagate the dirty signal — the per-writer
   * `joinSnapshot()` already invokes the host's notifier when
   * entries land; this flag is consumed by the pointer-wiring layer
   * for cursor-advancement bookkeeping and tests.
   */
  readonly joinedAny: boolean;
  /** Number of distinct `addressId` prefixes observed in the snapshot. */
  readonly addressesSeen: number;
  /** Number of bundle refs the BundleIndex JOIN evaluated. */
  readonly bundleEntriesSeen: number;
  /** Aggregated counters across every per-writer JOIN. */
  readonly counters: AggregatedJoinCounters;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Address ID pattern from `constants.ts:getAddressId()` —
 * `DIRECT_[0-9a-f]{6}_[0-9a-f]{6}`. Captured here as a regex with a
 * leading-prefix capture group so the dispatcher can pluck the
 * addressId from any per-address key (`${addressId}.outbox.*`, etc.).
 *
 * Defense in depth: matches against the BEGINNING of the key only,
 * and requires a trailing `.` to ensure we don't pick up a key that
 * happens to start with the pattern but isn't address-prefixed.
 */
const ADDRESS_ID_PREFIX_RE = /^(DIRECT_[0-9a-f]{6}_[0-9a-f]{6})\./;

/**
 * Issue #335 Phase 2.5 — legacy → profile key normalization table for
 * single-blob per-address keys.
 *
 * **Why this exists.** The lean-snapshot publisher reads keys via
 * `ProfileStorageProvider.keys()` which translates OrbitDB profile-form
 * keys (`${addressId}.tombstones`) back to legacy form
 * (`${addressId}_tombstones`) for backward compatibility with the
 * non-Profile `StorageProvider` interface. The reverse-mapping fires
 * only when a key matches a static `PROFILE_KEY_MAPPING` per-address
 * suffix (e.g., `.tombstones`, `.invalidatedNametags`). Per-entry keys
 * like `${addressId}.outbox.${id}` are NOT remapped — their suffix
 * (`.outbox.${id}`) doesn't match the static `.outbox` suffix.
 *
 * Consequence pre-Phase-2.5: snapshot entries for single-blob keys
 * carry the legacy form (`${addressId}_tombstones`). The dispatcher
 * routes by profile-form prefix (`${addressId}.tombstones`) — no match,
 * silent drop. The Phase 2 `SingleBlobSyncWriter` was correctly wired
 * via `factory.ts:writersFor()` but never fired because the dispatcher
 * pre-filter `entries.filter(e => e.key.startsWith(keyPrefix))` never
 * matched a single entry. Soak `bob-peer1-vs-peer2-after` failed with
 * the same divergence Phase 2 was meant to fix.
 *
 * **Per-entry writers are unaffected.** Outbox/sent/dispositions/
 * finalization/recipient-context entries flow as `${addressId}.${prefix}.${id}`
 * — the suffix-match in `reverseMapProfileKey` doesn't trigger for
 * those (the suffix is `.${prefix}.${id}`, not `.${prefix}`), so they
 * stay in profile form end-to-end.
 *
 * **Scope.** This table covers ONLY the single-blob per-address keys
 * Phase 2 added writers for (`tombstones`, `invalidatedNametags`).
 * Adding more single-blob writers in the future requires extending
 * both this table AND `factory.ts:writersFor()`. The dispatcher fails
 * closed on unlisted legacy suffixes — the entry is dispatched in its
 * legacy form, which downstream writers will not match, exactly
 * mirroring the pre-fix behaviour for those (currently unrouted)
 * keys.
 *
 * Keep the table sorted by `legacySuffix` for stable iteration.
 */
const PER_ADDRESS_LEGACY_SUFFIX_MAP: ReadonlyArray<{
  readonly legacySuffix: string;
  readonly profileSuffix: string;
}> = [
  { legacySuffix: '_invalidatedNametags', profileSuffix: '.invalidatedNametags' },
  { legacySuffix: '_tombstones', profileSuffix: '.tombstones' },
];

/**
 * Match the leading addressId (anchored, hex-strict) so the
 * normalization step cannot accidentally pick up a key like
 * `not_a_direct_addr_tombstones`. Mirrors the strictness of
 * {@link ADDRESS_ID_PREFIX_RE} but without the trailing `.` — the
 * trailing delimiter (`_` or `.`) is appended by the suffix check.
 */
const ADDRESS_ID_BARE_RE = /^DIRECT_[0-9a-f]{6}_[0-9a-f]{6}/;

/**
 * Issue #335 Phase 2.5 — normalize a snapshot entry's key from legacy
 * form to profile form when it matches the
 * {@link PER_ADDRESS_LEGACY_SUFFIX_MAP} table. Returns the input
 * unchanged when no mapping applies — per-entry keys, bundle keys, and
 * any not-yet-covered single-blob key pass through verbatim.
 *
 * Pure function; safe to call N times.
 */
function normalizeEntryKey(key: string): string {
  // Cheap reject when the key isn't even an addressId-prefixed key.
  const addrMatch = ADDRESS_ID_BARE_RE.exec(key);
  if (addrMatch === null) return key;
  const addrEnd = addrMatch[0].length;
  // Must be followed by `_` to be a legacy form candidate. `.` form is
  // already profile-form (or per-entry) and needs no rewrite.
  if (key[addrEnd] !== '_') return key;
  const suffixFromAddr = key.slice(addrEnd);
  for (const { legacySuffix, profileSuffix } of PER_ADDRESS_LEGACY_SUFFIX_MAP) {
    if (suffixFromAddr === legacySuffix) {
      return key.slice(0, addrEnd) + profileSuffix;
    }
  }
  return key;
}

/**
 * Decode a base64-encoded ciphertext blob into raw bytes. Mirrors the
 * encoding used by `profile-storage-provider.ts:getEncryptedRaw` which
 * is what the lean-snapshot builder reads.
 *
 * Uses `Buffer.from(_, 'base64')` in Node and `atob` in browsers.
 * Both are universally available in our runtime targets.
 */
function base64ToBytes(b64: string): Uint8Array {
  // Node fast path — Buffer is also available in browser shims.
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    const buf = Buffer.from(b64, 'base64');
    // Buffer is a subclass of Uint8Array but Vitest/jsdom can deliver a
    // Buffer that is NOT instanceof Uint8Array in some weird harness
    // configurations. Slice into a fresh Uint8Array to be safe.
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  // Browser fallback (atob is available on the global).
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Add a per-writer JOIN result into the running aggregated counters.
 * Pure mutation — no allocation in the hot path.
 */
function accumulate(agg: {
  entriesEvaluated: number;
  liveLanded: number;
  tombstonesLanded: number;
  localWon: number;
  remoteRejectedMalformed: number;
}, r: JoinResult): void {
  agg.entriesEvaluated += r.entriesEvaluated;
  agg.liveLanded += r.liveLanded;
  agg.tombstonesLanded += r.tombstonesLanded;
  agg.localWon += r.localWon;
  agg.remoteRejectedMalformed += r.remoteRejectedMalformed;
}

// =============================================================================
// Public entry point
// =============================================================================

/**
 * Apply a parsed lean profile snapshot to the local Profile via
 * per-writer JOIN dispatch. See module docstring for the full
 * contract.
 *
 * Sequencing (Issue #360 Finding #8 — single-pass bucketing):
 *   1. Normalize legacy keys and extract unique addressIds in one
 *      pass over `snapshot.entries`. No base64 decode yet — that's
 *      deferred until an entry is actually routed to a writer.
 *   2. Build the per-writer prefix table by calling
 *      `deps.writersFor(addressId)` once per observed addressId,
 *      then sort the combined table by prefix length descending so
 *      longest-prefix-wins for any future overlap. As of writing,
 *      no two registered prefixes overlap (see {@link
 *      ProfileSnapshotJoinDeps.writersFor} and `factory.ts`), so
 *      longest-match-wins is identical to the prior per-writer
 *      filter semantics.
 *   3. Single pass over normalized keys: bucket each entry under
 *      the first (longest) matching prefix. Decode base64 at the
 *      moment of bucketing — entries that match no prefix skip
 *      decode entirely.
 *   4. Dispatch each writer with its bucket (preserving the prior
 *      empty-bucket short-circuit). Dispatch order is preserved by
 *      iterating addressIds and their writers in registration
 *      order rather than by prefix-length order.
 *   5. For the wallet-global BundleIndex, dispatch over the
 *      `tokens.bundle.*` bucket.
 *
 * Per-writer errors are swallowed and logged — a single misbehaving
 * writer must NOT block convergence of the other writers. The
 * counter aggregation reflects only writers that completed
 * successfully.
 */
export async function runProfileSnapshotJoin(
  snapshot: LeanProfileSnapshot,
  deps: ProfileSnapshotJoinDeps,
): Promise<ApplySnapshotResult> {
  const log = deps.log ?? ((msg: string): void => logger.debug('SnapshotDispatcher', msg));

  const rawEntries = snapshot.entries;
  const entryCount = rawEntries.length;

  // 1. Normalize keys + extract addressIds in one pass. Base64 decode
  //    is deferred to the bucketing step below so entries that no
  //    writer claims never pay the decode cost (Finding #8).
  //
  //    Issue #335 Phase 2.5 — normalize legacy-form single-blob keys
  //    (`${addr}_tombstones`, `${addr}_invalidatedNametags`) to profile
  //    form (`${addr}.tombstones`, `${addr}.invalidatedNametags`).
  //    See `normalizeEntryKey` for the full rationale.
  const normalizedKeys: string[] = new Array(entryCount);
  const addressIds = new Set<string>();
  for (let i = 0; i < entryCount; i++) {
    const k = normalizeEntryKey(rawEntries[i].key);
    normalizedKeys[i] = k;
    const m = ADDRESS_ID_PREFIX_RE.exec(k);
    if (m !== null) addressIds.add(m[1]);
  }

  // 2. Build the per-writer prefix table. We keep a parallel
  //    `dispatchOrder` array so the eventual writer-call sequence
  //    matches the original (addressId iteration order × writer
  //    registration order, then bundleIndex last). The
  //    `prefixTable` is sorted by prefix length descending purely
  //    for the bucketing step's longest-match-wins lookup — no
  //    writer is invoked out of registration order.
  interface DispatchSlot {
    readonly prefix: string;
    readonly writer: ProfileSyncWriter;
    readonly label: string; // for error logging
  }
  const dispatchOrder: DispatchSlot[] = [];
  const skippedAddresses: string[] = [];
  for (const addressId of addressIds) {
    const writers = deps.writersFor(addressId);
    if (writers.length === 0) {
      skippedAddresses.push(addressId);
      continue;
    }
    for (const { keyPrefix, writer } of writers) {
      dispatchOrder.push({
        prefix: keyPrefix,
        writer,
        label: `writer @ ${keyPrefix}`,
      });
    }
  }
  for (const addressId of skippedAddresses) {
    log(
      `runProfileSnapshotJoin: no writers available for address ${addressId} ` +
        '(encryption/identity preconditions not yet met) — skipping',
    );
  }

  // Sorted prefix table for bucketing. Longest first so a key like
  // `${addr}.recipientContext.request.X` lands under
  // `.recipientContext.request.` rather than a hypothetical shorter
  // `.recipientContext.` prefix. Currently no overlap exists, but
  // the sort costs O(W log W) (W ≈ 25) and is a free safety net.
  const prefixTable: DispatchSlot[] = [...dispatchOrder].sort(
    (a, b) => b.prefix.length - a.prefix.length,
  );

  // 3. Single-pass bucketing. `buckets` is keyed by writer slot
  //    identity (the DispatchSlot reference) via a Map; bundle
  //    entries go into `bundleBucket` directly. Entries that match
  //    no known prefix are simply unrouted (and skip base64 decode).
  const buckets = new Map<DispatchSlot, SnapshotEntry[]>();
  const bundleBucket: SnapshotEntry[] = [];

  for (let i = 0; i < entryCount; i++) {
    const key = normalizedKeys[i];

    // BundleIndex check first — `tokens.bundle.` is not addressId
    // prefixed, so testing it once per entry is cheap and avoids
    // walking the per-address table for global keys.
    if (key.startsWith(BUNDLE_KEY_PREFIX)) {
      if (deps.bundleIndex !== null) {
        bundleBucket.push({
          key,
          encryptedValue: base64ToBytes(rawEntries[i].value),
        });
      }
      continue;
    }

    // Longest-prefix-wins match against per-writer table. Stop at
    // the first hit — see the doc-comment for why this is
    // semantically identical to the original per-writer filter for
    // the current prefix set.
    for (const slot of prefixTable) {
      if (key.startsWith(slot.prefix)) {
        let bucket = buckets.get(slot);
        if (bucket === undefined) {
          bucket = [];
          buckets.set(slot, bucket);
        }
        bucket.push({
          key,
          encryptedValue: base64ToBytes(rawEntries[i].value),
        });
        break;
      }
    }
  }

  // 4. Dispatch in original registration order. Each writer gets
  //    its bucket (or skips when empty).
  const aggregated = {
    entriesEvaluated: 0,
    liveLanded: 0,
    tombstonesLanded: 0,
    localWon: 0,
    remoteRejectedMalformed: 0,
  };

  for (const slot of dispatchOrder) {
    const slice = buckets.get(slot);
    if (slice === undefined || slice.length === 0) continue;
    try {
      const result = await slot.writer.joinSnapshot(slice);
      accumulate(aggregated, result);
    } catch (err) {
      // A single writer's failure must not block convergence for
      // the others. The writer's own classifier is responsible for
      // skipping malformed entries; an exception escaping here is a
      // hard storage error that the next reconcile will retry.
      log(
        `runProfileSnapshotJoin: ${slot.label} threw — skipping ` +
          `(error: ${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  // 5. Wallet-global BundleIndex dispatch.
  let bundleEntriesSeen = 0;
  if (deps.bundleIndex !== null) {
    bundleEntriesSeen = bundleBucket.length;
    if (bundleBucket.length > 0) {
      try {
        const result = await deps.bundleIndex.joinSnapshot(bundleBucket);
        accumulate(aggregated, result);
      } catch (err) {
        log(
          `runProfileSnapshotJoin: bundleIndex.joinSnapshot threw — skipping ` +
            `(error: ${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
  } else {
    log(
      'runProfileSnapshotJoin: bundleIndex not available — bundle JOIN skipped',
    );
  }

  const joinedAny = aggregated.liveLanded > 0 || aggregated.tombstonesLanded > 0;
  return {
    joinedAny,
    addressesSeen: addressIds.size,
    bundleEntriesSeen,
    counters: aggregated,
  };
}

// =============================================================================
// Test-only exports
// =============================================================================

/**
 * Internals exposed for unit tests — not part of the public API.
 */
export const __internal = {
  base64ToBytes,
  ADDRESS_ID_PREFIX_RE,
  // Issue #335 Phase 2.5 — exposed so unit tests can pin the legacy →
  // profile key mapping table without re-deriving it from the storage
  // layer's PROFILE_KEY_MAPPING (which would couple the dispatcher
  // tests to unrelated mapping changes).
  PER_ADDRESS_LEGACY_SUFFIX_MAP,
  normalizeEntryKey,
};
