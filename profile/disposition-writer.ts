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
   * Effects:
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

    // Step 1: write the manifest first. If this fails (CAS exhaustion
    // etc.), we have NOT yet mutated the audit record — the caller can
    // retry without leaving the system in a half-promoted state.
    await this.manifestStore.addAuditPromotedFrom(
      addr,
      tokenId,
      [auditKey],
      manifestEntry,
    );

    // Step 2: stamp the audit record. The manifest's `rootHash` is the
    // pointer the spec calls `promotedToManifestRef`.
    const promoted: AuditEntry = {
      ...existing,
      auditStatus: 'audit-promoted',
      promotedToManifestRef: manifestEntry.rootHash,
    };
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

  const merged: AuditEntry = {
    tokenId: incoming.tokenId,
    observedTokenContentHash: incoming.observedTokenContentHash,
    auditStatus,
    reason,
    recordedAt,
    bundleCidsObserved,
    promotedToManifestRef: existing?.promotedToManifestRef,
    audit_promoted_from: existing?.audit_promoted_from,
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
