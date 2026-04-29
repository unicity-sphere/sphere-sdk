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
   */
  readonly submittedAt: number;
  /** Wall-clock millisecond timestamp of queue creation. */
  readonly createdAt: number;
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

  constructor(options: FinalizationQueueOptions) {
    this.storage = options.storage;
    this.now = options.now ?? (() => Date.now());
    this.tombstoneRetentionMs =
      options.tombstoneRetentionMs ?? TOMBSTONE_RETENTION_MS;
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
   */
  async get(
    addr: string,
    entryId: string,
  ): Promise<FinalizationQueueEntry | undefined> {
    validateAddr(addr);
    validateEntryId(entryId);
    const raw = await this.storage.readKey(keyFor(addr, entryId));
    if (raw === null) return undefined;
    const parsed = parseQueueValue(raw);
    if (parsed.kind === 'tombstone' || parsed.kind === 'absent') return undefined;
    return parsed.entry;
  }

  /**
   * List every live entry under `addr`. Tombstones are filtered out.
   *
   * The order is implementation-defined; consumers that need a stable
   * order (e.g. lex-min-by-tokenId for cascade ordering) MUST sort
   * downstream.
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
      if (parsed.kind !== 'entry') continue;
      out.push(parsed.entry);
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
 * Encode a `Uint8Array` to base64. We avoid `Buffer` to keep the
 * module browser-safe; the SDK targets both Node and browser runtimes.
 *
 * @internal
 */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  // `btoa` is browser-native; Node 18+ also exposes it.
  return globalThis.btoa(bin);
}

/**
 * Decode a base64 string to `Uint8Array`. Round-trip with
 * {@link bytesToBase64}.
 *
 * @internal
 */
function base64ToBytes(b64: string): Uint8Array {
  const bin = globalThis.atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}
