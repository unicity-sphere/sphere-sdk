/**
 * UXF Transfer — recipient finalization queue (T.5.C).
 *
 * Typed wrapper over the per-address finalization-queue collection
 * persisted under the OrbitDB key shape (Wave G.7 layout):
 *
 *     `${addr}.finalizationQueue.${entryId}`
 *
 * The queue is the durability anchor for the recipient-side
 * finalization worker per `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §5.5.
 * Each unfinalized transaction in an arriving chain-mode token is
 * enqueued as one entry; the token transitions `pending → valid`
 * only when EVERY entry resolves successfully (or `pending → invalid`
 * the moment any entry hard-fails — see §5.5 step 7).
 *
 * **Per-entry-key layout (T.1.E / Wave G.7)**: the queue is NOT a
 * single-blob serialized list. Each entry is its own OrbitDB key so
 * concurrent writes from the worker (resolve / remove) and replication
 * merges from peers (graft / merge-path) do not contend over a single
 * mutable blob. The `entryId` slot is opaque to the storage layer; the
 * recipient finalization worker uses `${tokenId}:${txIndex}` (a
 * per-token-per-tx-index composite) so multiple unfinalized
 * transactions of the same token deduplicate cleanly on replay.
 *
 * **Pure / I/O-free CRUD**. The wrapper performs NO Lamport bookkeeping,
 * NO event emission, NO chain hydration. It is a typed CRUD layer over
 * an injected {@link FinalizationQueueStorage}; production wires the
 * storage to `ProfileTokenStorageProvider`'s per-entry-key writer, tests
 * inject in-memory fakes.
 *
 * **Tombstone retention**: removed entries land as JSON tombstone
 * markers (`{tombstoned: true, deletedAt}`) at the same key for
 * `TOMBSTONE_RETENTION_DAYS = 30` (see §5.5 paragraph "Tombstone
 * retention"). The wrapper provides a `gcTombstones` helper so the
 * provider's flush path can collapse old tombstones; the worker itself
 * never has to think about retention.
 *
 * Spec references:
 *  - §5.5      Per-token finalization (chain-mode landing path)
 *  - §5.5#5    Crash-safe write order (queue removal LAST)
 *  - §5.6      Replay / duplicate / merge handling
 *  - §6.2      Recipient-side finalization worker (driver)
 *  - PA §10.12 Per-entry-key storage layout
 *
 * @packageDocumentation
 */

import { SphereError } from '../../../core/errors';

// =============================================================================
// 1. Public types — queue entry shape
// =============================================================================

/**
 * Status discriminator for a {@link FinalizationQueueEntry}. Mirrors the
 * sender-outbox status set but scoped to a single tx within a chain.
 *
 * - `'pending'`   — newly enqueued; worker has not yet observed.
 * - `'submitting'`— worker has issued submit and is awaiting result.
 * - `'polling'`   — submit succeeded; worker is polling for proof.
 * - `'attached'`  — proof attached to pool; manifest CID rewritten;
 *                   queue entry pending removal (durability-anchor
 *                   transition — see §5.5 step 5 step 4 "queue-entry
 *                   removal LAST"). Visible only briefly between step
 *                   1–3 completion and step 4 removal.
 * - `'hard-fail'` — terminal; worker has marked the chain dead. Entry
 *                   may persist as a tombstone for forensic correlation
 *                   but the worker treats `'hard-fail'` as terminal.
 *
 * The status is OPAQUE to the storage wrapper — the wrapper does not
 * gate transitions. The recipient worker is the authoritative source
 * of state-machine semantics.
 */
export type FinalizationQueueEntryStatus =
  | 'pending'
  | 'submitting'
  | 'polling'
  | 'attached'
  | 'hard-fail';

/**
 * Per-tx finalization queue entry. Persisted under
 * `${addr}.finalizationQueue.${entryId}` per Wave G.7.
 *
 * `entryId` is the primary key. The recipient worker uses
 * `${tokenId}:${txIndex}` for chain-mode entries (so K queue entries
 * for a K-deep chain have stable ids on replay) and falls back to a
 * unique random suffix only if a tx index is unavailable.
 *
 * **Why `signedTransferTxBytes` is optional**: §5.5 step 1 mandates
 * the worker resolve `signedTransferTxBytes` "queue-entry first, fall
 * back to in-pool by `(tokenId, txIndex)`". Storing the bytes inline
 * is the optimistic fast path; the worker MUST handle the fallback.
 *
 * The `bundleCid` field is forensic — it lets the worker correlate a
 * queue entry to the originating bundle for tracing without re-reading
 * the pool. `commitmentRequestId` is the canonical aggregator key the
 * worker submits + polls against.
 */
export interface FinalizationQueueEntry {
  /** Opaque primary key under the per-entry-key layout. */
  readonly entryId: string;
  /** Token id this finalization belongs to. */
  readonly tokenId: string;
  /** Originating bundle CID (forensic / cross-reference). */
  readonly bundleCid: string;
  /** Position in `token.transactions[]`; 0 = oldest unfinalized
   *  hop. Helps the worker resolve `signedTransferTxBytes` from the
   *  in-pool token when the inline bytes are absent. */
  readonly txIndex: number;
  /** Aggregator commitment request id. Computed locally from
   *  `(signedTx, sourceState)` per `RequestId.js`; also serves as the
   *  manifest-CID-rewrite "queueEntryRequestId" (§5.5 step 5 step 4). */
  readonly commitmentRequestId: string;
  /**
   * Local transactionHash imprint hex (68 chars). Used for the §6.1
   * race-loser detection (poll's `proof.transactionHash` is compared
   * against this) AND for the §5.6 idempotency invariant (W15) — two
   * queue entries with the same `transactionHash` describe the same
   * commitment and converge on attach.
   */
  readonly transactionHash: string;
  /** Local authenticator hex. Used for §6.3 same-value-vs-different-
   *  value resolution alongside `transactionHash`. */
  readonly authenticator: string;
  /**
   * Inline signed-tx bytes (T.5.C optimistic fast path). When absent,
   * the worker resolves via the in-pool token at `(tokenId, txIndex)`.
   */
  readonly signedTransferTxBytes?: Uint8Array;
  /**
   * Wall-clock millisecond timestamp of the FIRST successful submit.
   * Initialized to `createdAt` at queue-creation; updated to the
   * actual submit time on the first SUCCESS / REQUEST_ID_EXISTS
   * response. The §5.5 step 6 polling deadline is computed from this.
   *
   * MUST NOT fire pollingDeadline for entries with
   * `submittedAt === createdAt` (no submit yet) — protects against
   * restart-resume of an already-old entry hitting the deadline after
   * a single poll.
   *
   * Round 3 regression status: this field's CAS-update on first
   * submit was historically the planned W26 anchor; in practice the
   * recipient never wired a `submittedAt`-CAS path. The Round-3 fix
   * uses the separate {@link pollStartedAt} field below as the W26
   * anchor — it is stamped once on first poll-loop entry and surface
   * the wall-clock submit time without forcing every queue-store
   * implementation to bake a CAS-update method.
   */
  readonly submittedAt: number;
  /** Wall-clock millisecond timestamp of queue creation. */
  readonly createdAt: number;
  /**
   * Round 3 regression fix: wall-clock millisecond timestamp at which
   * the recipient finalization worker FIRST entered the poll-loop for
   * this entry. Stamped exactly once via
   * {@link FinalizationQueue.setPollStartedAt}, never re-stamped.
   *
   * The §5.5 step 6 hard polling deadline (2 × POLLING_WINDOW_MS) is
   * anchored at THIS field, NOT at {@link createdAt} or
   * {@link submittedAt}. Pre-Round-3 the deadline anchor read
   * `submittedAt > createdAt ? submittedAt : now()` — but no code path
   * ever updated `submittedAt` post-creation, so the `now()` branch
   * fired on every cycle and the W26 cross-restart safety net was
   * effectively inert (the deadline restarted on every worker
   * re-entry). Promoting `pollStartedAt` to its own persisted field
   * gives the worker an honest "wall-clock when polling actually
   * started" anchor; on the second pass after a restart, the
   * persisted value wins so the deadline survives crashes.
   *
   * Optional: a freshly-enqueued entry has `pollStartedAt: undefined`
   * until the first poll-loop entry stamps it. Once stamped, the
   * field is immutable for the lifetime of the queue entry.
   */
  readonly pollStartedAt?: number;
  /** Submit-side retry counter (bounded by `MAX_SUBMIT_RETRIES`). */
  readonly submitRetryCount: number;
  /** Poll-side proof-error retry counter (PATH_INVALID /
   *  NOT_AUTHENTICATED — bounded by `MAX_PROOF_ERROR_RETRIES`). */
  readonly proofErrorCount: number;
  /** Lifecycle discriminator. See {@link FinalizationQueueEntryStatus}. */
  readonly status: FinalizationQueueEntryStatus;
  /**
   * Source discriminator (matches §5.5 spec FinalizationQueueEntry
   * shape). The recipient worker only enqueues `'received'`; the
   * field is preserved for parity with the sender outbox structure
   * and to allow a future merged worker to distinguish.
   */
  readonly source: 'sent' | 'received';
}

/**
 * Tombstone marker stored at a removed entry's key. Consumed by the
 * GC sweep ({@link FinalizationQueue.gcTombstones}) — the wrapper
 * recognizes it on read and treats the entry as absent.
 *
 * Persistent retention is `TOMBSTONE_RETENTION_DAYS = 30` (see §5.5).
 * Older tombstones are physically deleted by the GC sweep.
 */
export interface FinalizationQueueTombstone {
  readonly tombstoned: true;
  readonly deletedAt: number;
}

// =============================================================================
// 2. Storage abstraction — minimal contract injected by callers
// =============================================================================

/**
 * Minimal per-entry-key storage contract. Production wires this to
 * `ProfileTokenStorageProvider`'s underlying OrbitDB adapter; tests
 * inject in-memory maps.
 *
 * The contract is intentionally narrow (read / write / list-by-prefix /
 * delete) — the wrapper does NOT need transactional semantics; replay
 * idempotency is delivered by the per-entry-key layout itself (writing
 * the same entry twice is a no-op at the storage layer).
 */
export interface FinalizationQueueStorage {
  /**
   * Read the JSON-encoded value at `key`. Returns `null` if the key
   * is absent. Implementations MAY return either a parsed object or
   * the raw JSON string at the implementation's discretion — the
   * wrapper handles both via {@link parseQueueValue}.
   */
  readKey(key: string): Promise<string | null>;
  /**
   * Idempotent write. Overwrites any previous value (entry or
   * tombstone) at the same key.
   */
  writeKey(key: string, value: string): Promise<void>;
  /**
   * List every key starting with `prefix`. The returned map's keys
   * are the FULL keys (prefix + entryId); the values are the entryIds.
   * Implementations MUST observe the latest committed state — no
   * caching layered above the underlying CRDT view.
   *
   * Throws on listing failure — callers (the worker) treat a thrown
   * listing as fatal (matches the W15 / PA §10 behavior of the
   * provider's `listExistingPerEntryKeys`).
   */
  listByPrefix(prefix: string): Promise<Map<string, string>>;
  /**
   * Physically delete the key. Used ONLY by the GC sweep — the
   * worker's "remove queue entry" path goes through {@link writeKey}
   * with a tombstone marker, NOT through `deleteKey`.
   */
  deleteKey(key: string): Promise<void>;
}

// =============================================================================
// 3. FinalizationQueue — public CRUD
// =============================================================================

/**
 * Default tombstone retention window. Matches §5.5 "Tombstone
 * retention" paragraph (`TOMBSTONE_RETENTION_DAYS = 30`).
 */
export const TOMBSTONE_RETENTION_DAYS = 30;
export const TOMBSTONE_RETENTION_MS =
  TOMBSTONE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Telemetry callback invoked when {@link FinalizationQueue} encounters
 * a corrupt slot — a key whose JSON parses to neither a valid live
 * entry nor a valid tombstone. The default behavior in addition to
 * this callback is to delete the corrupt slot so that a subsequent
 * `add()` can rewrite it cleanly (otherwise a corrupt slot would
 * silently mask the entry forever, causing the worker to think the
 * queue is drained and prematurely flip the token to `valid`).
 *
 * Steelman fix (Wave 3 #8): the prior implementation silently dropped
 * corrupt slots from `list()` / `gcTombstones()` / `get()`, which
 * caused both a disk-leak and a worker premature-flip on drain. The
 * callback lets the worker's host emit a `transfer:operator-alert` so
 * operators can investigate the corruption source (replication merge
 * conflict, partial write, byte-flip).
 */
export type FinalizationQueueCorruptSlotHandler = (info: {
  /** The full storage key carrying the corrupt value. */
  readonly key: string;
  /** Parsed `addr` (the prefix-strip target). */
  readonly addr: string;
  /** Parsed `entryId` (everything after `${addr}.finalizationQueue.`). */
  readonly entryId: string;
  /**
   * The raw value as read from storage. Truncated to 512 chars so
   * operator alerts don't carry potentially-large blobs.
   */
  readonly rawSnippet: string;
}) => void;

/**
 * Construction options for {@link FinalizationQueue}.
 */
export interface FinalizationQueueOptions {
  /** Per-entry-key storage adapter. */
  readonly storage: FinalizationQueueStorage;
  /** Wall-clock provider; default `Date.now`. Tests inject a
   *  deterministic clock so timestamps stay reproducible. */
  readonly now?: () => number;
  /** Tombstone retention window override (ms). Default
   *  {@link TOMBSTONE_RETENTION_MS}. */
  readonly tombstoneRetentionMs?: number;
  /**
   * Optional handler invoked for every corrupt slot the wrapper
   * encounters during `get` / `list` / `gcTombstones` / `lookupByTokenId`.
   * Production wiring emits a `transfer:operator-alert` so the
   * corruption is visible to operators; tests inject recorders to
   * assert the handler was called. When `null` / omitted, corrupt
   * slots are still deleted but no alert is surfaced.
   */
  readonly onCorruptSlot?: FinalizationQueueCorruptSlotHandler;
}

/**
 * Wave G.7 per-entry-key wrapper for the finalization queue.
 *
 * @example
 * ```ts
 * const queue = new FinalizationQueue({ storage });
 * await queue.add(addr, entry);
 * const all = await queue.list(addr);
 * const byToken = await queue.lookupByTokenId(addr, tokenId);
 * await queue.remove(addr, entry.entryId);
 * ```
 */
export class FinalizationQueue {
  private readonly storage: FinalizationQueueStorage;
  private readonly now: () => number;
  private readonly tombstoneRetentionMs: number;
  private readonly onCorruptSlot: FinalizationQueueCorruptSlotHandler | undefined;

  constructor(options: FinalizationQueueOptions) {
    this.storage = options.storage;
    this.now = options.now ?? (() => Date.now());
    this.tombstoneRetentionMs =
      options.tombstoneRetentionMs ?? TOMBSTONE_RETENTION_MS;
    this.onCorruptSlot = options.onCorruptSlot;
    if (
      !Number.isFinite(this.tombstoneRetentionMs) ||
      this.tombstoneRetentionMs < 0
    ) {
      throw new SphereError(
        `FinalizationQueue: tombstoneRetentionMs must be non-negative finite; got ${this.tombstoneRetentionMs}`,
        'VALIDATION_ERROR',
      );
    }
  }

  /**
   * Apply the corrupt-slot policy: invoke the operator-alert handler
   * (if registered) AND best-effort delete the corrupt slot so a
   * subsequent `add()` can rewrite it. Delete failures are swallowed
   * — the call site is already an error path.
   *
   * @internal
   */
  private async handleCorruptSlot(
    addr: string,
    key: string,
    raw: string,
  ): Promise<void> {
    const entryId = key.startsWith(prefixFor(addr))
      ? key.slice(prefixFor(addr).length)
      : key;
    if (this.onCorruptSlot !== undefined) {
      try {
        this.onCorruptSlot({
          key,
          addr,
          entryId,
          // Truncate the raw blob before surfacing — operator alerts
          // shouldn't carry potentially-large attacker-controlled
          // payloads (e.g., a megabyte-of-binary-garbage corruption).
          rawSnippet: raw.length > 512 ? `${raw.slice(0, 512)}…` : raw,
        });
      } catch {
        // Handler must not block GC; swallow.
      }
    }
    try {
      await this.storage.deleteKey(key);
    } catch {
      // Best-effort — a delete failure leaves the slot in place.
      // The next pass will re-visit and re-attempt deletion. The
      // operator alert above remains the authoritative signal.
    }
  }

  /**
   * Add (or idempotently overwrite) a queue entry.
   *
   * Persisted under `${addr}.finalizationQueue.${entry.entryId}`.
   *
   * Idempotent: writing the same entry twice converges on the same
   * stored bytes. The wrapper does NOT compare-and-swap on a prior
   * version — concurrent writers from the recipient worker (resolve)
   * and replication graft (merge-path) are both expected to land
   * here, and the write order is whichever wins last; the
   * subsequently-running worker pass re-reads via {@link list} or
   * {@link lookupByTokenId} so a clobbered field is recovered on the
   * next iteration.
   */
  async add(addr: string, entry: FinalizationQueueEntry): Promise<void> {
    validateAddr(addr);
    validateEntry(entry);
    const key = keyFor(addr, entry.entryId);
    await this.storage.writeKey(key, JSON.stringify(serializeEntry(entry)));
  }

  /**
   * Round 3 regression fix: stamp the W26 polling-deadline anchor on a
   * live queue entry. Read-modify-write the entry to set
   * `pollStartedAt = now`. Idempotent if `pollStartedAt` is already set
   * (no-op) — the worker's stamp-once contract prevents re-stamping
   * after a successful first poll-loop entry. Returns:
   *
   *   - `'set'`           — field stamped on this call.
   *   - `'already-set'`   — field was already populated; no-op.
   *   - `'absent'`        — entry not found (tombstoned or removed).
   *
   * The recipient finalization worker calls this at the top of each
   * cycle's poll loop: if `'set'` was returned the in-memory entry
   * MUST be refreshed (next call to `lookupByTokenId` carries the new
   * value). Persisted across worker restarts so the §5.5 step 6 hard
   * safety net (2 × POLLING_WINDOW_MS) is anchored at the real
   * wall-clock first-poll time, not at every worker re-entry's `now()`.
   *
   * **Why this method instead of mutating `submittedAt`**: the
   * `submittedAt` CAS-update path was historically the planned anchor
   * but was never wired into the recipient. Adding a dedicated
   * `pollStartedAt` field avoids overloading `submittedAt`'s "first
   * successful submit time" semantics (used by other code paths) and
   * makes the W26 contract explicit + self-documenting.
   */
  async setPollStartedAt(
    addr: string,
    entryId: string,
    when: number,
  ): Promise<'set' | 'already-set' | 'absent'> {
    validateAddr(addr);
    validateEntryId(entryId);
    if (!Number.isFinite(when)) {
      throw new SphereError(
        `FinalizationQueue.setPollStartedAt: when must be a finite number; got ${when}`,
        'VALIDATION_ERROR',
      );
    }
    const existing = await this.get(addr, entryId);
    if (existing === undefined) return 'absent';
    if (existing.pollStartedAt !== undefined) return 'already-set';
    const updated: FinalizationQueueEntry = {
      ...existing,
      pollStartedAt: when,
    };
    const key = keyFor(addr, entryId);
    await this.storage.writeKey(key, JSON.stringify(serializeEntry(updated)));
    return 'set';
  }

  /**
   * Mark an entry as removed (writes a tombstone marker at the same
   * key). The physical delete lands on the next GC sweep
   * ({@link gcTombstones}) once retention has elapsed.
   *
   * Idempotent: removing an already-removed entry overwrites the
   * tombstone with a fresh `deletedAt`. Removing an entry that never
   * existed STILL writes a tombstone — this is by design: the §5.5
   * step 5 "queue-entry removal LAST" sequence treats removal as a
   * positive write, NOT a delete, so subsequent worker passes can
   * detect "already removed" without distinguishing absent-vs-deleted.
   */
  async remove(addr: string, entryId: string): Promise<void> {
    validateAddr(addr);
    validateEntryId(entryId);
    const key = keyFor(addr, entryId);
    const tombstone: FinalizationQueueTombstone = {
      tombstoned: true,
      deletedAt: this.now(),
    };
    await this.storage.writeKey(key, JSON.stringify(tombstone));
  }

  /**
   * Predicate equivalent of `(await get(addr, entryId)) !== undefined`.
   * Tombstoned and absent entries both return `false`; a live entry
   * returns `true`.
   *
   * Used by the manifest-CID-rewrite step 4 "queue entry presence
   * is the durability anchor" check (§5.5 step 5 step 4).
   */
  async hasEntry(addr: string, entryId: string): Promise<boolean> {
    const e = await this.get(addr, entryId);
    return e !== undefined;
  }

  /**
   * Read a single entry by id. Returns `undefined` for absent or
   * tombstoned slots.
   *
   * Steelman fix (Wave 3 #8): a slot whose JSON parses to neither a
   * valid live entry nor a valid tombstone is corrupt — the prior
   * implementation silently returned `undefined`, leaking storage and
   * masking the corruption. The wrapper now invokes the
   * {@link FinalizationQueueOptions.onCorruptSlot} handler (so an
   * operator alert can be raised) AND best-effort deletes the slot
   * so a subsequent `add()` rewrites it cleanly.
   */
  async get(
    addr: string,
    entryId: string,
  ): Promise<FinalizationQueueEntry | undefined> {
    validateAddr(addr);
    validateEntryId(entryId);
    const key = keyFor(addr, entryId);
    const raw = await this.storage.readKey(key);
    if (raw === null) return undefined;
    const parsed = parseQueueValue(raw);
    if (parsed.kind === 'tombstone') return undefined;
    if (parsed.kind === 'absent') {
      await this.handleCorruptSlot(addr, key, raw);
      return undefined;
    }
    return parsed.entry;
  }

  /**
   * List every live entry under `addr`. Tombstones are filtered out.
   *
   * The order is implementation-defined; consumers that need a stable
   * order (e.g. lex-min-by-tokenId for cascade ordering) MUST sort
   * downstream.
   *
   * **Wave 5 steelman writer contract (NORMATIVE).** Production
   * implementations MUST keep the live-entry count BOUNDED by the
   * number of in-flight finalizations across all tokenIds for the
   * address, plus a tombstone-GC slack of at most a few thousand. A
   * queue store that ignores tombstone GC and grows without bound
   * will materialize the full result here BEFORE the recipient
   * worker's defensive truncation can run, OOM-ing at materialization
   * time. The recipient worker truncates oversize results at
   * `RECIPIENT_SCAN_LIST_HARD_GUARD` (16384) entries and rate-limits
   * the alert via power-of-two backoff; deployments that need
   * unbounded enumeration MUST switch to a paged / async-iterable
   * surface (see TODO on `FinalizationOutboxWriter.readAllNew` for
   * the cross-cutting plan).
   */
  async list(
    addr: string,
  ): Promise<ReadonlyArray<FinalizationQueueEntry>> {
    validateAddr(addr);
    const prefix = prefixFor(addr);
    const allKeys = await this.storage.listByPrefix(prefix);
    const out: FinalizationQueueEntry[] = [];
    // Iterate sequentially. Concurrent reads under the same prefix
    // would not improve throughput meaningfully on a single OrbitDB
    // store and risk subtle ordering bugs; serial keeps the wrapper
    // deterministic and easy to test.
    for (const key of allKeys.keys()) {
      const raw = await this.storage.readKey(key);
      if (raw === null) continue;
      const parsed = parseQueueValue(raw);
      if (parsed.kind === 'entry') {
        out.push(parsed.entry);
        continue;
      }
      if (parsed.kind === 'tombstone') continue;
      // Steelman fix (Wave 3 #8): corrupt slot — alert + delete.
      // Without this the worker's "queue-drained → flip token to
      // valid" check fires PREMATURELY because the corrupt entry is
      // invisible. Deleting on each visit ensures a subsequent
      // `add()` (e.g., from replay) can rewrite the slot.
      await this.handleCorruptSlot(addr, key, raw);
    }
    return out;
  }

  /**
   * Filter the list down to entries for a single `tokenId`. Equivalent
   * to `(await list(addr)).filter((e) => e.tokenId === tokenId)`,
   * exposed as a first-class method so the recipient worker can
   * efficiently look up "what's left for this token" inside the §5.5
   * step 9 "queue-drain → status transition" check.
   *
   * Returned order is the same implementation-defined order
   * `list()` uses; consumers sort by `txIndex` if they need
   * chronological semantics.
   */
  async lookupByTokenId(
    addr: string,
    tokenId: string,
  ): Promise<ReadonlyArray<FinalizationQueueEntry>> {
    validateAddr(addr);
    if (typeof tokenId !== 'string' || tokenId.length === 0) {
      throw new SphereError(
        'FinalizationQueue.lookupByTokenId: tokenId must be a non-empty string',
        'VALIDATION_ERROR',
      );
    }
    const all = await this.list(addr);
    return all.filter((e) => e.tokenId === tokenId);
  }

  /**
   * GC sweep over tombstones. Walks every key under the address's
   * prefix; for each tombstoned slot, if `now - deletedAt >
   * tombstoneRetentionMs`, the key is physically deleted.
   *
   * Best-effort: per-key delete failures are logged via the injected
   * storage's surface but do NOT abort the sweep. Returns a summary
   * `{scanned, deleted}` for telemetry.
   */
  async gcTombstones(addr: string): Promise<{
    readonly scanned: number;
    readonly deleted: number;
  }> {
    validateAddr(addr);
    const prefix = prefixFor(addr);
    const allKeys = await this.storage.listByPrefix(prefix);
    const now = this.now();
    let scanned = 0;
    let deleted = 0;
    for (const key of allKeys.keys()) {
      scanned++;
      const raw = await this.storage.readKey(key);
      if (raw === null) continue;
      const parsed = parseQueueValue(raw);
      if (parsed.kind === 'absent') {
        // Steelman fix (Wave 3 #8): corrupt slot encountered during
        // GC — surface via operator-alert and delete. The delete is
        // counted toward `deleted` so operators can correlate the
        // alert count to the GC summary.
        await this.handleCorruptSlot(addr, key, raw);
        deleted++;
        continue;
      }
      if (parsed.kind !== 'tombstone') continue;
      if (now - parsed.tombstone.deletedAt <= this.tombstoneRetentionMs) {
        continue;
      }
      try {
        await this.storage.deleteKey(key);
        deleted++;
      } catch {
        // Best-effort GC — swallow and continue.
      }
    }
    return { scanned, deleted };
  }
}

// =============================================================================
// 4. Helpers — key composition + parsing
// =============================================================================

/**
 * Compose the OrbitDB key for a queue entry. Public so the worker
 * (T.5.C) can compose keys for cross-cutting concerns (e.g. forwarding
 * the same entryId through the manifest-CID-rewrite adapter's
 * step 4 contract).
 */
export function keyFor(addr: string, entryId: string): string {
  return `${prefixFor(addr)}${entryId}`;
}

/**
 * Compose the prefix the wrapper scans under. Public for the same
 * reason {@link keyFor} is.
 */
export function prefixFor(addr: string): string {
  return `${addr}.finalizationQueue.`;
}

/**
 * Compose the canonical entryId for a (tokenId, txIndex) pair. The
 * recipient worker uses this so multiple unfinalized transactions of
 * the same token deduplicate cleanly on replay AND on cross-replica
 * merge.
 */
export function entryIdFor(tokenId: string, txIndex: number): string {
  if (typeof tokenId !== 'string' || tokenId.length === 0) {
    throw new SphereError(
      'finalizationQueue.entryIdFor: tokenId must be a non-empty string',
      'VALIDATION_ERROR',
    );
  }
  if (
    !Number.isFinite(txIndex) ||
    txIndex < 0 ||
    !Number.isInteger(txIndex)
  ) {
    throw new SphereError(
      `finalizationQueue.entryIdFor: txIndex must be a non-negative integer; got ${txIndex}`,
      'VALIDATION_ERROR',
    );
  }
  return `${tokenId}:${txIndex}`;
}

/**
 * Parse a JSON-encoded value from {@link FinalizationQueueStorage.readKey}.
 * Returns a discriminated record so callers can distinguish absent /
 * tombstoned / live-entry without re-encoding.
 *
 * @internal — exposed for unit tests of the wrapper itself.
 */
export function parseQueueValue(
  raw: string,
):
  | { readonly kind: 'absent' }
  | { readonly kind: 'tombstone'; readonly tombstone: FinalizationQueueTombstone }
  | { readonly kind: 'entry'; readonly entry: FinalizationQueueEntry } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt slot — treat as absent. The worker's outer loop will
    // overwrite on the next add() call with a well-formed entry.
    return { kind: 'absent' };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { kind: 'absent' };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.tombstoned === true) {
    const da = obj.deletedAt;
    return {
      kind: 'tombstone',
      tombstone: {
        tombstoned: true,
        deletedAt: typeof da === 'number' && Number.isFinite(da) ? da : 0,
      },
    };
  }
  // Entry decode. Defensive: refuse to surface a malformed entry.
  const entry = deserializeEntry(obj);
  if (entry === null) {
    return { kind: 'absent' };
  }
  return { kind: 'entry', entry };
}

/**
 * Project a {@link FinalizationQueueEntry} to a JSON-safe shape. The
 * `signedTransferTxBytes` field is base64-encoded so it round-trips
 * through `JSON.stringify`.
 *
 * @internal
 */
function serializeEntry(
  entry: FinalizationQueueEntry,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    entryId: entry.entryId,
    tokenId: entry.tokenId,
    bundleCid: entry.bundleCid,
    txIndex: entry.txIndex,
    commitmentRequestId: entry.commitmentRequestId,
    transactionHash: entry.transactionHash,
    authenticator: entry.authenticator,
    submittedAt: entry.submittedAt,
    createdAt: entry.createdAt,
    submitRetryCount: entry.submitRetryCount,
    proofErrorCount: entry.proofErrorCount,
    status: entry.status,
    source: entry.source,
  };
  if (entry.signedTransferTxBytes !== undefined) {
    out.signedTransferTxBytes = bytesToBase64(entry.signedTransferTxBytes);
  }
  // Round 3 regression fix: persist pollStartedAt when set so the W26
  // anchor survives crash/restart.
  if (entry.pollStartedAt !== undefined) {
    out.pollStartedAt = entry.pollStartedAt;
  }
  return out;
}

/**
 * Best-effort deserializer for a JSON-decoded entry. Returns `null` if
 * any required field is missing or mistyped — the caller treats this
 * as an absent slot.
 *
 * @internal
 */
function deserializeEntry(
  obj: Record<string, unknown>,
): FinalizationQueueEntry | null {
  const entryId = obj.entryId;
  const tokenId = obj.tokenId;
  const bundleCid = obj.bundleCid;
  const txIndex = obj.txIndex;
  const commitmentRequestId = obj.commitmentRequestId;
  const transactionHash = obj.transactionHash;
  const authenticator = obj.authenticator;
  const submittedAt = obj.submittedAt;
  const createdAt = obj.createdAt;
  const submitRetryCount = obj.submitRetryCount;
  const proofErrorCount = obj.proofErrorCount;
  const status = obj.status;
  const source = obj.source;
  if (
    typeof entryId !== 'string' ||
    entryId.length === 0 ||
    typeof tokenId !== 'string' ||
    tokenId.length === 0 ||
    typeof bundleCid !== 'string' ||
    typeof txIndex !== 'number' ||
    !Number.isFinite(txIndex) ||
    typeof commitmentRequestId !== 'string' ||
    commitmentRequestId.length === 0 ||
    typeof transactionHash !== 'string' ||
    typeof authenticator !== 'string' ||
    typeof submittedAt !== 'number' ||
    typeof createdAt !== 'number' ||
    typeof submitRetryCount !== 'number' ||
    typeof proofErrorCount !== 'number' ||
    typeof status !== 'string' ||
    !isValidStatus(status) ||
    typeof source !== 'string' ||
    (source !== 'sent' && source !== 'received')
  ) {
    return null;
  }
  const out: FinalizationQueueEntry = {
    entryId,
    tokenId,
    bundleCid,
    txIndex,
    commitmentRequestId,
    transactionHash,
    authenticator,
    submittedAt,
    createdAt,
    submitRetryCount,
    proofErrorCount,
    status,
    source,
    ...(typeof obj.signedTransferTxBytes === 'string'
      ? {
          signedTransferTxBytes: base64ToBytes(
            obj.signedTransferTxBytes,
          ),
        }
      : {}),
    // Round 3 regression fix: read pollStartedAt when present so the
    // W26 anchor survives crash/restart. Absent ⇒ no poll-loop entry
    // has happened yet (or this is a legacy entry written before the
    // field was introduced — both cases handled identically by the
    // worker's "stamp on first poll" code path).
    ...(typeof obj.pollStartedAt === 'number' &&
    Number.isFinite(obj.pollStartedAt)
      ? { pollStartedAt: obj.pollStartedAt }
      : {}),
  };
  return out;
}

function isValidStatus(s: string): s is FinalizationQueueEntryStatus {
  return (
    s === 'pending' ||
    s === 'submitting' ||
    s === 'polling' ||
    s === 'attached' ||
    s === 'hard-fail'
  );
}

function validateAddr(addr: string): void {
  if (typeof addr !== 'string' || addr.length === 0) {
    throw new SphereError(
      'FinalizationQueue: addr must be a non-empty string',
      'VALIDATION_ERROR',
    );
  }
}

function validateEntryId(entryId: string): void {
  if (typeof entryId !== 'string' || entryId.length === 0) {
    throw new SphereError(
      'FinalizationQueue: entryId must be a non-empty string',
      'VALIDATION_ERROR',
    );
  }
}

function validateEntry(entry: FinalizationQueueEntry): void {
  if (entry === null || typeof entry !== 'object') {
    throw new SphereError(
      'FinalizationQueue: entry must be an object',
      'VALIDATION_ERROR',
    );
  }
  validateEntryId(entry.entryId);
  if (typeof entry.tokenId !== 'string' || entry.tokenId.length === 0) {
    throw new SphereError(
      'FinalizationQueue: entry.tokenId must be a non-empty string',
      'VALIDATION_ERROR',
    );
  }
  if (
    !Number.isFinite(entry.txIndex) ||
    entry.txIndex < 0 ||
    !Number.isInteger(entry.txIndex)
  ) {
    throw new SphereError(
      `FinalizationQueue: entry.txIndex must be a non-negative integer; got ${entry.txIndex}`,
      'VALIDATION_ERROR',
    );
  }
  if (
    typeof entry.commitmentRequestId !== 'string' ||
    entry.commitmentRequestId.length === 0
  ) {
    throw new SphereError(
      'FinalizationQueue: entry.commitmentRequestId must be a non-empty string',
      'VALIDATION_ERROR',
    );
  }
  if (typeof entry.transactionHash !== 'string') {
    throw new SphereError(
      'FinalizationQueue: entry.transactionHash must be a string',
      'VALIDATION_ERROR',
    );
  }
}

// =============================================================================
// 5. Base64 helpers — minimal Uint8Array <-> base64 round-trip
// =============================================================================

/**
 * Steelman fix (Wave 3 #9): explicit feature-detection of `btoa`/`atob`
 * at module-load time, with a Node-`Buffer` fallback when both are
 * absent. Pre-fix code assumed `globalThis.btoa` / `globalThis.atob`
 * were always available, which is true for browser + Node ≥18 — but a
 * Node ≤16 host (or a stripped runtime) would fail at first
 * `signedTransferTxBytes` round-trip with an opaque
 * `TypeError: globalThis.btoa is not a function`. The fallback uses
 * `Buffer.from(...).toString('base64')` so the wrapper functions on
 * any environment that has either WebCrypto-style codecs OR Node's
 * `Buffer`. If neither exists, we throw at module-load with a clear
 * message naming the offending environment so the failure surfaces
 * synchronously at import-time rather than at first queue mutation.
 */
type Base64Codec = {
  readonly bytesToBase64: (bytes: Uint8Array) => string;
  readonly base64ToBytes: (b64: string) => Uint8Array;
};

const base64Codec: Base64Codec = (() => {
  const g = globalThis as {
    btoa?: (s: string) => string;
    atob?: (s: string) => string;
    Buffer?: {
      from(value: string, encoding?: string): { toString(encoding: string): string };
      from(value: Uint8Array): { toString(encoding: string): string };
    };
  };
  if (typeof g.btoa === 'function' && typeof g.atob === 'function') {
    const btoa = g.btoa;
    const atob = g.atob;
    return {
      bytesToBase64(bytes: Uint8Array): string {
        let bin = '';
        for (let i = 0; i < bytes.length; i++) {
          bin += String.fromCharCode(bytes[i]);
        }
        return btoa(bin);
      },
      base64ToBytes(b64: string): Uint8Array {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) {
          out[i] = bin.charCodeAt(i);
        }
        return out;
      },
    };
  }
  // Node.js fallback — Node ≤16 lacks `globalThis.btoa` / `atob` on
  // older line-up but always has `Buffer`. This branch keeps the
  // wrapper working there too.
  if (typeof g.Buffer !== 'undefined' && g.Buffer !== null) {
    const Buffer = g.Buffer;
    return {
      bytesToBase64(bytes: Uint8Array): string {
        return Buffer.from(bytes).toString('base64');
      },
      base64ToBytes(b64: string): Uint8Array {
        // Buffer extends Uint8Array, so we copy into a plain
        // `Uint8Array` to avoid the subclass leaking through the
        // wrapper's typed surface.
        const buf = Buffer.from(b64, 'base64');
        const view = buf as unknown as Uint8Array;
        return new Uint8Array(view);
      },
    };
  }
  // Neither codec available — fail at module load with a clear
  // message so the offending environment is identifiable.
  const runtimeId =
    typeof process !== 'undefined' && typeof process.version === 'string'
      ? `node ${process.version}`
      : typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
        ? `browser '${navigator.userAgent}'`
        : 'unknown runtime';
  throw new SphereError(
    `FinalizationQueue: no base64 codec available in this runtime (${runtimeId}); expected globalThis.btoa/atob (browser, Node ≥18) or Node Buffer. signedTransferTxBytes round-trip is unavailable — upgrade Node to ≥18 or run in a browser environment.`,
    'NOT_INITIALIZED',
  );
})();

/**
 * Encode a `Uint8Array` to base64. Routes through the module-init
 * codec so the wrapper works on browser, Node ≥18, and Node ≤16
 * runtimes (the last via `Buffer`).
 *
 * @internal
 */
function bytesToBase64(bytes: Uint8Array): string {
  return base64Codec.bytesToBase64(bytes);
}

/**
 * Decode a base64 string to `Uint8Array`. Round-trip with
 * {@link bytesToBase64}.
 *
 * @internal
 */
function base64ToBytes(b64: string): Uint8Array {
  return base64Codec.base64ToBytes(b64);
}
