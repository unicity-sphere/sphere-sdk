/**
 * UXF Inter-Wallet Transfer — DispositionWriter (T.3.C)
 *
 * Given a {@link DispositionRecord} produced by the §5.3 decision-matrix
 * walker (T.3.B.2) and an address, route the record to the appropriate
 * OrbitDB collection per §5.4:
 *
 *  - `VALID`       → `${addr}.manifest.${tokenId}` (active pool)
 *  - `PENDING`     → `${addr}.manifest.${tokenId}` (active pool, status='pending')
 *  - `CONFLICTING` → `${addr}.manifest.${tokenId}` (active pool, status='conflicting')
 *  - `INVALID`     → `${addr}.invalid.${tokenId}.${observedTokenContentHash}`
 *  - `AUDIT`       → `${addr}.audit.${tokenId}.${observedTokenContentHash}`
 *
 * **Why per-entry-key for `_invalid` / `_audit`** (per §5.4): the same
 * `tokenId` MAY appear in multiple bundles concurrently, each producing
 * a forensically-distinct record. The composite key
 * `(tokenId, observedTokenContentHash)` is the multi-rep disambiguator
 * mandated by §5.4 — two distinct bundle copies of the same `tokenId`
 * produce two distinct keys; identical bundle copies produce the same
 * key (idempotent re-write).
 *
 * **Why manifest goes through {@link ManifestStore}** (per §5.5 step 9):
 * the active-pool writer needs CAS semantics so concurrent §5.3 [D]
 * resolves don't clobber each other. The store handles the read-merge-
 * CAS-retry loop and the §5.4 metadata-preservation rules (`set-OR /
 * max-merge` of `audit_promoted_from`, `splitParent`, `conflictingHeads`,
 * `lamport`, `lastProofRefreshAt`).
 *
 * **C13: client-error reason path** (§6.1 `REQUEST_ID_MISMATCH`): the
 * writer routes to `_invalid` like any other hard-failure reason BUT
 * also emits a `transfer:operator-alert` SphereEvent so the wallet UI
 * / operator console can surface the alert prominently — this reason
 * indicates a CLIENT BUG (the SDK computed an inconsistent
 * `(requestId, sourceState, transactionHash)` tuple), not a sender
 * misbehavior.
 *
 * **Promotion flow** (per §5.4):
 *  - {@link DispositionWriter.promoteAuditEntry} sets
 *    `auditStatus: 'audit-promoted'` + `promotedToManifestRef` on the
 *    audit record (does NOT delete it — forensic retention).
 *  - The same call sets `audit_promoted_from: [auditKey, ...]` on the
 *    manifest entry (set-OR via {@link ManifestStore.addAuditPromotedFrom}).
 *
 * @module profile/disposition-writer
 *
 * @see UXF-TRANSFER-PROTOCOL §5.3 (decision matrix dispositions)
 * @see UXF-TRANSFER-PROTOCOL §5.4 (storage outcomes / multi-rep keys)
 * @see UXF-TRANSFER-PROTOCOL §6.1 (DispositionReason mapping)
 * @see PROFILE-ARCHITECTURE §10.11 (manifest entry shape)
 */

import { SphereError } from '../core/errors.js';
import type {
  AuditEntry,
  AuditStatus,
  DispositionReason,
  DispositionRecord,
  InvalidEntry,
  ManifestEntryDelta,
} from '../types/disposition.js';
import type { SphereEventMap, SphereEventType } from '../types/index.js';
import type { ContentHash } from '../uxf/types.js';
import { ManifestStore } from './manifest-store.js';
import type { TokenManifestEntry } from './token-manifest.js';

// =============================================================================
// 1. Public types
// =============================================================================

/**
 * Minimal abstraction over the per-entry-key writer/reader required by
 * {@link DispositionWriter} for `_invalid` and `_audit` records.
 *
 * The production implementation is the
 * {@link OrbitDbDispositionStorageAdapter} below, which wraps a
 * {@link ProfileDatabase} (the same OrbitDB key-value store the rest of
 * the profile system uses) and reuses the encryption helpers from
 * `profile/encryption.ts`.
 *
 * Tests inject an in-memory implementation that bypasses encryption.
 */
export interface DispositionPerEntryStorage {
  /** Read a single record at the supplied key. Returns `undefined` if
   *  absent or if the value is a tombstone marker. */
  readRecord<T>(key: string): Promise<T | undefined>;
  /** Write a single record at the supplied key. Idempotent: writing the
   *  same value twice is a no-op apart from any per-write side effects
   *  in the storage backend (e.g. OpLog growth). */
  writeRecord<T>(key: string, value: T): Promise<void>;
}

/**
 * Lightweight event-emit shim. The production wiring routes to the
 * Sphere event bus; tests inject a recorder so assertions can verify
 * emit-or-not without standing up the full event infrastructure.
 *
 * Type-narrowed to the events {@link DispositionWriter} actually emits
 * (just `transfer:operator-alert` today) so callers can supply a
 * single-purpose adapter without implementing the full bus.
 */
export type DispositionEventEmitter = <T extends SphereEventType>(
  event: T,
  payload: SphereEventMap[T],
) => void;

/**
 * Construction options for {@link DispositionWriter}.
 */
export interface DispositionWriterOptions {
  /** Per-entry-key storage for `_invalid` / `_audit` collections. */
  readonly storage: DispositionPerEntryStorage;
  /** Active-pool manifest store (handles CAS + §5.4 merge rules). */
  readonly manifestStore: ManifestStore;
  /** Event emitter for `transfer:operator-alert` (C13 path). */
  readonly emit: DispositionEventEmitter;
  /**
   * Wall-clock supplier. Default `Date.now`. Tests inject a deterministic
   * clock so timestamps stay reproducible.
   */
  readonly now?: () => number;
}

// =============================================================================
// 2. Key helpers — §5.4 multi-rep keying
// =============================================================================

/**
 * Compose the `_invalid` per-entry key per §5.4:
 *   `${addr}.invalid.${tokenId}.${observedTokenContentHash}`
 *
 * Exposed for tests + the audit-promotion path (which needs to read the
 * audit record by key when promoting).
 */
export function invalidKeyFor(
  addr: string,
  tokenId: string,
  observedTokenContentHash: ContentHash,
): string {
  return `${addr}.invalid.${tokenId}.${observedTokenContentHash}`;
}

/**
 * Compose the `_audit` per-entry key per §5.4:
 *   `${addr}.audit.${tokenId}.${observedTokenContentHash}`
 */
export function auditKeyFor(
  addr: string,
  tokenId: string,
  observedTokenContentHash: ContentHash,
): string {
  return `${addr}.audit.${tokenId}.${observedTokenContentHash}`;
}

// =============================================================================
// 3. DispositionWriter
// =============================================================================

/**
 * Routes {@link DispositionRecord}s to the appropriate OrbitDB
 * collection per §5.4. Holds NO module-level state; per-Sphere
 * lifecycle is the caller's responsibility.
 */
export class DispositionWriter {
  private readonly storage: DispositionPerEntryStorage;
  private readonly manifestStore: ManifestStore;
  private readonly emit: DispositionEventEmitter;
  private readonly now: () => number;

  constructor(options: DispositionWriterOptions) {
    this.storage = options.storage;
    this.manifestStore = options.manifestStore;
    this.emit = options.emit;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Process one {@link DispositionRecord} for the supplied address.
   * Routing is type-driven: each variant lands in exactly one
   * collection per §5.4.
   *
   * Re-entrant: calling `write` twice with the same record is
   * idempotent at the storage layer (the per-entry-key path overwrites
   * the same composite key; the manifest store re-runs its merge and
   * converges to the same result).
   */
  async write(addr: string, record: DispositionRecord): Promise<void> {
    if (typeof addr !== 'string' || addr.length === 0) {
      throw new SphereError(
        'DispositionWriter.write: addr must be a non-empty string',
        'VALIDATION_ERROR',
      );
    }

    switch (record.disposition) {
      case 'VALID':
      case 'PENDING':
        await this.writeManifest(addr, record);
        return;
      case 'CONFLICTING':
        await this.writeConflictingManifest(addr, record);
        return;
      case 'INVALID':
        await this.writeInvalid(addr, record);
        // C13: emit operator-alert on client-error reason — see §6.1.
        if (record.reason === 'client-error') {
          this.emitOperatorAlert(record.reason, record);
        }
        return;
      case 'AUDIT':
        await this.writeAudit(addr, record);
        return;
      default: {
        // Exhaustiveness check — TypeScript narrows `record` to `never`
        // here. If a new variant is added to `DispositionRecord` without
        // updating this switch, the assignment fails to type-check.
        const _exhaustive: never = record;
        void _exhaustive;
        throw new SphereError(
          `DispositionWriter.write: unknown disposition variant`,
          'VALIDATION_ERROR',
        );
      }
    }
  }

  /**
   * Promote an `_audit` record to the active pool (per §5.4 promotion
   * semantics).
   *
   * **Transactional invariant** (steelman finding #164):
   *
   * Promotion is a **two-phase operation** with crash recovery, because
   * it spans two independent storage backends (the per-entry-key audit
   * collection and the CAS-protected manifest store). The invariant the
   * implementation must preserve across crashes / retries:
   *
   *   For any audit record `A` at key `auditKey`:
   *     - `A.auditStatus === 'audit-promoted'`  iff
   *       the manifest entry at `(addr, tokenId)` has `auditKey` in its
   *       `audit_promoted_from` set.
   *
   * The two writes are NOT a single atomic op, so we use a
   * `promotionPending` marker on the audit record to make the in-flight
   * state observable and recoverable:
   *
   *   Phase 1 (pre-write marker):  A.promotionPending = true
   *   Phase 2 (manifest write):    manifest.audit_promoted_from ⊇ {auditKey}
   *   Phase 3 (post-write commit): A.auditStatus = 'audit-promoted',
   *                                A.promotionPending = undefined,
   *                                A.promotedToManifestRef = manifestEntry.rootHash
   *
   * Recovery (executed on retry / re-entry of `promoteAuditEntry`):
   *   - If `A.auditStatus === 'audit-promoted'` already → no-op
   *     (idempotent; a prior call succeeded).
   *   - If `A.promotionPending === true` AND the manifest already
   *     contains `auditKey` in `audit_promoted_from` → Phase 3 only
   *     (a prior call crashed between Phase 2 and Phase 3; finish it).
   *   - If `A.promotionPending === true` AND the manifest does NOT
   *     contain `auditKey` → roll forward by retrying Phase 2 + Phase 3
   *     (a prior call crashed before Phase 2 succeeded).
   *   - Else (steady state) → execute Phases 1 → 2 → 3.
   *
   * If the Phase 2 manifest write throws, we explicitly clear the
   * `promotionPending` marker (Phase 1 rollback) so a future retry sees
   * a clean state instead of mistaking a never-started promotion for an
   * in-flight one. Best-effort: if the rollback also fails, the worst
   * case is a stale marker that the recovery branch above will resolve
   * on the next attempt by inspecting the manifest.
   *
   * Effects on success:
   *   1. The audit record at
   *      `${addr}.audit.${tokenId}.${observedTokenContentHash}` is
   *      updated in place: `auditStatus: 'audit-promoted'`,
   *      `promotedToManifestRef: <new-manifest-rootHash>`. The audit
   *      record is **not deleted** — forensic retention per §5.4.
   *   2. The manifest entry at `${addr}.manifest.${tokenId}` is
   *      upserted via {@link ManifestStore.addAuditPromotedFrom}, which
   *      set-OR-merges the audit key into `audit_promoted_from`.
   *
   * If no audit record exists at the supplied key, throws
   * `VALIDATION_ERROR` — the caller is asserting that an audit record
   * exists, and the absence of one indicates upstream programmer error.
   *
   * @param addr Wallet address (composite-key prefix).
   * @param tokenId Canonical token id.
   * @param observedTokenContentHash The audit record's disambiguator.
   * @param manifestEntry The manifest delta to upsert (must include
   *   `rootHash` — the new active-pool root the audit is promoted to).
   */
  async promoteAuditEntry(
    addr: string,
    tokenId: string,
    observedTokenContentHash: ContentHash,
    manifestEntry: TokenManifestEntry,
  ): Promise<void> {
    if (typeof addr !== 'string' || addr.length === 0) {
      throw new SphereError(
        'DispositionWriter.promoteAuditEntry: addr must be a non-empty string',
        'VALIDATION_ERROR',
      );
    }
    if (typeof tokenId !== 'string' || tokenId.length === 0) {
      throw new SphereError(
        'DispositionWriter.promoteAuditEntry: tokenId must be a non-empty string',
        'VALIDATION_ERROR',
      );
    }

    const auditKey = auditKeyFor(addr, tokenId, observedTokenContentHash);
    const existing = await this.storage.readRecord<AuditEntry>(auditKey);
    if (existing === undefined) {
      throw new SphereError(
        `DispositionWriter.promoteAuditEntry: no audit record at key "${auditKey}"`,
        'VALIDATION_ERROR',
      );
    }

    // ---------------------------------------------------------------
    // Recovery / idempotency branches (see invariant above).
    // ---------------------------------------------------------------

    // Branch A: already promoted. CAS-style no-op — promotion is
    // idempotent on a per-`auditKey` basis. Multiple concurrent callers
    // that race past the read-existing point will both submit Phase 2 +
    // Phase 3 writes, and the manifest store's set-OR semantics on
    // `audit_promoted_from` make those duplicate writes converge to the
    // same fixed point. The audit record's `auditStatus` field is
    // monotonic (`audit-promoted` is terminal per §5.4), so the only
    // way to land here is "a prior call already won the race".
    if (existing.auditStatus === 'audit-promoted') {
      return;
    }

    // Branch B: promotionPending marker observed. A prior call started
    // promotion but did not reach Phase 3. Inspect the manifest to
    // determine whether Phase 2 succeeded.
    if (existing.promotionPending === true) {
      const manifestNow = await this.manifestStore.readEntry(addr, tokenId);
      const promotedFrom = manifestNow?.audit_promoted_from;
      if (
        promotedFrom !== undefined &&
        promotedFrom.includes(auditKey)
      ) {
        // Phase 2 succeeded; just finalize Phase 3.
        const ref = manifestNow?.rootHash ?? manifestEntry.rootHash;
        const promoted: AuditEntry = stripUndefinedShallow({
          ...existing,
          auditStatus: 'audit-promoted',
          promotedToManifestRef: ref,
          promotionPending: undefined,
        });
        await this.storage.writeRecord<AuditEntry>(auditKey, promoted);
        return;
      }
      // Phase 2 was never observed to succeed. Fall through to the
      // steady-state path: re-attempt Phase 2 + Phase 3. The
      // `promotionPending` marker is already set, so we skip Phase 1.
    } else {
      // Branch C: steady state. Phase 1 — set the marker BEFORE the
      // manifest write so a crash between this write and the manifest
      // write is recoverable via Branch B.
      const marked: AuditEntry = stripUndefinedShallow({
        ...existing,
        promotionPending: true,
      });
      await this.storage.writeRecord<AuditEntry>(auditKey, marked);
    }

    // Phase 2: manifest write. On failure, attempt to clear the marker
    // (best-effort; see invariant doc above).
    try {
      await this.manifestStore.addAuditPromotedFrom(
        addr,
        tokenId,
        [auditKey],
        manifestEntry,
      );
    } catch (manifestErr) {
      // Roll back the Phase 1 marker so the next retry sees a clean
      // pre-promotion state instead of mistaking this as in-flight.
      try {
        const rolledBack: AuditEntry = stripUndefinedShallow({
          ...existing,
          promotionPending: undefined,
        });
        await this.storage.writeRecord<AuditEntry>(auditKey, rolledBack);
      } catch {
        // Marker-rollback failed. Worst case: a stale `promotionPending`
        // remains; the next retry's Branch B path will inspect the
        // manifest, see no reverse-pointer, and re-attempt Phase 2.
        // This is the design: we intentionally degrade to "retry, don't
        // lose data".
      }
      throw manifestErr;
    }

    // Phase 3: stamp the audit record. The manifest's `rootHash` is the
    // pointer the spec calls `promotedToManifestRef`.
    const promoted: AuditEntry = stripUndefinedShallow({
      ...existing,
      auditStatus: 'audit-promoted',
      promotedToManifestRef: manifestEntry.rootHash,
      promotionPending: undefined,
    });
    await this.storage.writeRecord<AuditEntry>(auditKey, promoted);
  }

  // ===========================================================================
  // Private — variant routers
  // ===========================================================================

  private async writeManifest(
    addr: string,
    record: Extract<DispositionRecord, { disposition: 'VALID' | 'PENDING' }>,
  ): Promise<void> {
    const entry = this.deltaToManifestEntry(record.manifest, record);
    await this.manifestStore.upsert(addr, record.tokenId, entry);
  }

  private async writeConflictingManifest(
    addr: string,
    record: Extract<DispositionRecord, { disposition: 'CONFLICTING' }>,
  ): Promise<void> {
    const entry = this.deltaToManifestEntry(record.manifest, record, {
      conflictingHeads: record.conflictingHeads,
    });
    await this.manifestStore.upsert(addr, record.tokenId, entry);
  }

  private async writeInvalid(
    addr: string,
    record: Extract<DispositionRecord, { disposition: 'INVALID' }>,
  ): Promise<void> {
    const key = invalidKeyFor(
      addr,
      record.tokenId,
      record.observedTokenContentHash,
    );
    const entry: InvalidEntry = {
      tokenId: record.tokenId,
      observedTokenContentHash: record.observedTokenContentHash,
      reason: record.reason,
      observedAt: this.now(),
      bundleCid: record.bundleCid,
      senderTransportPubkey: record.senderTransportPubkey,
    };
    await this.storage.writeRecord<InvalidEntry>(key, entry);
  }

  private async writeAudit(
    addr: string,
    record: Extract<DispositionRecord, { disposition: 'AUDIT' }>,
  ): Promise<void> {
    const key = auditKeyFor(
      addr,
      record.tokenId,
      record.observedTokenContentHash,
    );
    // Audit records are MULTI-OBSERVATION accumulators — re-arrival of
    // the same `(tokenId, observedTokenContentHash)` adds the new
    // bundleCid to the `bundleCidsObserved` list (deduplicated, append-
    // only) and preserves any prior `auditStatus` (e.g. 'audit-promoted'
    // must not regress to 'audit-not-our-state' just because a fresh
    // observation rolled in). See §5.4.
    const existing = await this.storage.readRecord<AuditEntry>(key);
    const merged = mergeAuditEntry(existing, record, this.now());
    await this.storage.writeRecord<AuditEntry>(key, merged);
  }

  // ===========================================================================
  // Private — helpers
  // ===========================================================================

  /**
   * Convert a {@link ManifestEntryDelta} (from the disposition record's
   * upstream producer) into a {@link TokenManifestEntry} ready for the
   * manifest store. Stamps `bundleCid` / `senderTransportPubkey` /
   * `lastProofRefreshAt` from the disposition record's provenance
   * fields. Does NOT stamp `lamport` — the manifest store's CAS path
   * does the §7.1 bump itself.
   */
  private deltaToManifestEntry(
    delta: ManifestEntryDelta,
    record: Extract<
      DispositionRecord,
      { disposition: 'VALID' | 'PENDING' | 'CONFLICTING' }
    >,
    overrides: Partial<TokenManifestEntry> = {},
  ): TokenManifestEntry {
    const entry: TokenManifestEntry = {
      rootHash: delta.rootHash,
      status: delta.status,
      conflictingHeads: delta.conflictingHeads,
      invalidReason: delta.invalidReason,
      splitParent: delta.splitParent,
      bundleCid: record.bundleCid,
      senderTransportPubkey: record.senderTransportPubkey,
      lastProofRefreshAt: this.now(),
      ...overrides,
    };
    return entry;
  }

  /**
   * Emit the `transfer:operator-alert` event for C13 client-error
   * routing. Centralized so the message format stays consistent across
   * the few code paths that surface this alert.
   */
  private emitOperatorAlert(
    code: DispositionReason,
    record: Extract<DispositionRecord, { disposition: 'INVALID' }>,
  ): void {
    this.emit('transfer:operator-alert', {
      code,
      tokenId: record.tokenId,
      bundleCid: record.bundleCid,
      observedTokenContentHash: record.observedTokenContentHash,
      senderTransportPubkey: record.senderTransportPubkey,
      message:
        code === 'client-error'
          ? `client-error disposition for tokenId ${record.tokenId}: REQUEST_ID_MISMATCH at submit indicates a CLIENT BUG (inconsistent (requestId, sourceState, transactionHash) tuple). Audit aggregator submission path.`
          : `operator-alert: ${code} disposition for tokenId ${record.tokenId}`,
    });
  }
}

// =============================================================================
// 4. mergeAuditEntry — multi-observation accumulator (pure)
// =============================================================================

/**
 * Fold an incoming AUDIT disposition record into a possibly-existing
 * audit record at the same key. Pure / deterministic.
 *
 * Merge rules (per §5.4):
 *  - `tokenId` / `observedTokenContentHash` — keying invariants;
 *    the caller has already verified they match.
 *  - `auditStatus` — preserved if existing carries 'audit-promoted'
 *    (a later transfer made the token ours; do NOT regress to
 *    'audit-not-our-state' just because a fresh forensic copy
 *    arrived). Otherwise take from `record`.
 *  - `reason` — preserved from existing if set; otherwise take from
 *    record. Reason is a property of the original disposition, not a
 *    re-arrival.
 *  - `recordedAt` — preserved from existing (initial recording time).
 *    Falls back to `now` for a fresh record.
 *  - `bundleCidsObserved` — set-OR (deduplicated, lex-sorted) union
 *    of existing + the incoming `bundleCid`.
 *  - `promotedToManifestRef` / `audit_promoted_from` — preserved from
 *    existing.
 *  - `promotionPending` — preserved from existing (steelman finding
 *    #164). A re-arrival of the same observation MUST NOT clear an
 *    in-flight promotion marker; recovery is the responsibility of
 *    `DispositionWriter.promoteAuditEntry`, not the merge path.
 *    However, if `existing.auditStatus === 'audit-promoted'`,
 *    `promotionPending` is dropped — the post-promotion invariant
 *    forbids both being set simultaneously.
 */
export function mergeAuditEntry(
  existing: AuditEntry | undefined,
  incoming: Extract<DispositionRecord, { disposition: 'AUDIT' }>,
  now: number,
): AuditEntry {
  const auditStatus: AuditStatus =
    existing?.auditStatus === 'audit-promoted'
      ? 'audit-promoted'
      : incoming.auditStatus;
  const reason: DispositionReason = existing?.reason ?? incoming.reason;
  const recordedAt = existing?.recordedAt ?? now;
  const bundleCidsObserved = unionBundleCids(
    existing?.bundleCidsObserved,
    [incoming.bundleCid],
  );

  // Mutual-exclusion invariant: 'audit-promoted' and `promotionPending`
  // cannot both be set. If the merged status is terminal, drop any
  // pending marker (defensive — post-promotion we never want a stale
  // marker to confuse recovery).
  const promotionPending: true | undefined =
    auditStatus === 'audit-promoted'
      ? undefined
      : existing?.promotionPending === true
        ? true
        : undefined;

  const merged: AuditEntry = {
    tokenId: incoming.tokenId,
    observedTokenContentHash: incoming.observedTokenContentHash,
    auditStatus,
    reason,
    recordedAt,
    bundleCidsObserved,
    promotedToManifestRef: existing?.promotedToManifestRef,
    audit_promoted_from: existing?.audit_promoted_from,
    promotionPending,
  };
  return stripUndefinedShallow(merged);
}

function unionBundleCids(
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string>,
): readonly string[] {
  const set = new Set<string>();
  if (a) for (const v of a) set.add(v);
  for (const v of b) set.add(v);
  return [...set].sort();
}

function stripUndefinedShallow<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}
