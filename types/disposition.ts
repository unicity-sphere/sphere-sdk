/**
 * UXF Inter-Wallet Transfer — DispositionReason / AuditStatus enums (T.1.C)
 *
 * Single source of truth for the on-wire enum strings that the UXF transfer
 * recipient flow writes into `_invalid` and `_audit` profile collections.
 *
 * **Why these are string-literal unions, not TypeScript `enum`**: the strings
 * are the on-disk representation. They appear in `_invalid` and `_audit`
 * records keyed by `${addr}.invalid.${tokenId}.${observedTokenContentHash}`
 * etc. Renaming any of them is a profile-format migration, NOT a refactor.
 * `enum` would emit a JS object that's not the on-wire form; literal unions
 * keep types and runtime values identical.
 *
 * **Stability contract** (Note N2 from `docs/uxf/UXF-TRANSFER-IMPL-PLAN.md`):
 * the snapshot test in `tests/unit/types/disposition.test.ts` locks the
 * exact string set. Adding, removing, or renaming a value MUST be done
 * deliberately, with an ADR, and with a migration plan for any pre-existing
 * `_invalid` / `_audit` records on disk.
 *
 * Spec references:
 *  - `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §5.4 — DispositionReason canonical
 *    enum (14 values), `_invalid` / `_audit` record schemas.
 *  - `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §6.1 — sender-side finalization
 *    failures (`belief-divergence`, `client-error`, `oracle-rejected`,
 *    `race-lost`, `parent-rejected`).
 *  - `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §8 — disposition→manifest.status
 *    mapping.
 *  - `docs/uxf/PROFILE-ARCHITECTURE.md` §10.11 — `ManifestEntry` canonical
 *    shape (re-exported here from the existing `profile/token-manifest.ts`).
 *
 * @module types/disposition
 */

import type { ContentHash } from '../extensions/uxf/bundle/types.js';
// Canonical ManifestEntry source: `profile/token-manifest.ts` exports
// `TokenManifestEntry`. Per UXF-TRANSFER-IMPL-PLAN T.1.C, we re-export it
// under the spec-aligned alias `ManifestEntry`. Future waves (T.1.F, T.5.B,
// etc.) will augment that shape with the §5.4 cross-replica merge fields
// (`splitParent`, `audit_promoted_from`, `lamport`, `lastProofRefreshAt`)
// per PA §10.11; the alias keeps the import path stable across that
// augmentation.
import type { TokenManifestEntry } from '../extensions/uxf/profile/token-manifest.js';

// =============================================================================
// 1. DispositionReason — on-wire string union (14 values, §5.4)
// =============================================================================

/**
 * Canonical reason a token observed in an incoming UXF bundle was rejected
 * from the active pool, recorded in the `_invalid` or `_audit` collection.
 *
 * The exact 14 strings are stable on-disk; see {@link DISPOSITION_REASONS}
 * for runtime iteration and the snapshot test in
 * `tests/unit/types/disposition.test.ts` for the stability contract.
 *
 * **Storage routing** (per §5.4):
 *  - `_invalid` (cryptographically broken / hard-failed):
 *    `structural`, `predicate-eval`, `auth-invalid`, `continuity-broken`,
 *    `proof-invalid`, `proof-throw`, `oracle-rejected`,
 *    `belief-divergence`, `client-error`, `parent-rejected`, `race-lost`.
 *  - `_audit` (structurally valid, just not spendable by us):
 *    `not-our-state`, `off-record-spend`.
 *  - No storage (transient, retried by gateway-walking logic):
 *    `gateway-fetch-failed`.
 */
export type DispositionReason =
  // -- Structural / cryptographic failures (→ _invalid)
  /** [A] orphan ref / type-tag mismatch / hash mismatch / parser throw. */
  | 'structural'
  /** [B] predicate evaluation threw at receive time. */
  | 'predicate-eval'
  /** [C](1) ECDSA authenticator verify failed. */
  | 'auth-invalid'
  /** [C](2) source-state continuity broken (chain links don't match). */
  | 'continuity-broken'
  /**
   * [C](3) inclusionProof.verify() returned PATH_INVALID,
   * NOT_AUTHENTICATED, or PATH_NOT_INCLUDED at receive time.
   */
  | 'proof-invalid'
  /** [C](3) proof verify threw, or an orphan dependency was encountered. */
  | 'proof-throw'

  // -- Aggregator-driven failures (→ _invalid; §6.1)
  /**
   * §6.1 sustained PATH_NOT_INCLUDED past the polling window — the
   * commitment was never anchored.
   */
  | 'oracle-rejected'
  /**
   * §6.1 AUTHENTICATOR_VERIFICATION_FAILED at submit — local crypto
   * passed but the aggregator's check did not.
   */
  | 'belief-divergence'
  /**
   * §6.1 REQUEST_ID_MISMATCH at submit — the client sent an inconsistent
   * `(requestId, sourceState, transactionHash)` tuple. CLIENT BUG.
   */
  | 'client-error'
  /**
   * §6.1.1 cascade — the parent split-token was hard-failed (coin splits
   * only; NFTs do not have `splitParent`).
   */
  | 'parent-rejected'
  /**
   * §6.1 / §7.1 race-loser — REQUEST_ID_EXISTS at submit followed by a
   * `transactionHash` mismatch on poll. Cascade does NOT fire.
   */
  | 'race-lost'

  // -- Audit-only (→ _audit; structurally valid, just unspendable by us)
  /** [B] / [B'] current-state predicate doesn't bind to us. */
  | 'not-our-state'
  /** [E] oracle.isSpent === true on a finalized chain. */
  | 'off-record-spend'

  // -- Transport / IPFS failures (recoverable, no storage)
  /** §9.2 every gateway failed to serve the bundle CAR. Transient. */
  | 'gateway-fetch-failed';

/**
 * Runtime iteration of every {@link DispositionReason} value.
 *
 * The snapshot test sorts this array and compares against a hard-coded
 * sorted list of the exact 14 strings — additions, deletions, or renames
 * fail the test, forcing an ADR (Note N2 from
 * `docs/uxf/UXF-TRANSFER-IMPL-PLAN.md`).
 */
export const DISPOSITION_REASONS: ReadonlyArray<DispositionReason> = [
  'structural',
  'predicate-eval',
  'auth-invalid',
  'continuity-broken',
  'proof-invalid',
  'proof-throw',
  'oracle-rejected',
  'belief-divergence',
  'client-error',
  'parent-rejected',
  'race-lost',
  'not-our-state',
  'off-record-spend',
  'gateway-fetch-failed',
] as const;

/**
 * Runtime guard for {@link DispositionReason}. Returns true iff `value` is
 * one of the 14 canonical strings (per `DISPOSITION_REASONS`).
 *
 * Negative cases: `null`, `undefined`, non-strings, empty string, mis-cased
 * variants (`'STRUCTURAL'`), or any string not in the union (e.g.,
 * `'unknown'`, `'invalid'`, `'audit-promoted'`).
 */
export function isDispositionReason(value: unknown): value is DispositionReason {
  return (
    typeof value === 'string' &&
    (DISPOSITION_REASONS as ReadonlyArray<string>).includes(value)
  );
}

// =============================================================================
// 2. AuditStatus — on-wire string union (3 values, §5.4)
// =============================================================================

/**
 * Lifecycle state of an `_audit` collection record (per §5.4).
 *
 * - `audit-not-our-state`: initial state when [B] surfaced
 *   NOT_OUR_CURRENT_STATE.
 * - `audit-off-record-spend`: initial state when [E] surfaced
 *   UNSPENDABLE_BY_US.
 * - `audit-promoted`: a later transfer made the same `tokenId` bind to us
 *   at current state; the audit record is retained for forensic
 *   traceability and `promotedToManifestRef` points to the new active-pool
 *   manifest entry.
 */
export type AuditStatus =
  | 'audit-not-our-state'
  | 'audit-off-record-spend'
  | 'audit-promoted';

/**
 * Runtime iteration of every {@link AuditStatus} value. The snapshot test
 * locks this to the exact 3 strings (Note N6).
 */
export const AUDIT_STATUSES: ReadonlyArray<AuditStatus> = [
  'audit-not-our-state',
  'audit-off-record-spend',
  'audit-promoted',
] as const;

/**
 * Runtime guard for {@link AuditStatus}. Mirrors the contract of
 * {@link isDispositionReason} — paranoid against `null`, `undefined`,
 * non-strings, and any string not in the 3-value union.
 */
export function isAuditStatus(value: unknown): value is AuditStatus {
  return (
    typeof value === 'string' &&
    (AUDIT_STATUSES as ReadonlyArray<string>).includes(value)
  );
}

// =============================================================================
// 3. Off-balance collection record schemas — §5.4
// =============================================================================

/**
 * `_invalid` collection record. Multiple records MAY exist for the same
 * `tokenId`, disambiguated by `observedTokenContentHash` in the storage
 * key (`${addr}.invalid.${tokenId}.${observedTokenContentHash}`).
 *
 * @see UXF-TRANSFER-PROTOCOL §5.4 — `_invalid` key shape and record schema.
 */
export interface InvalidEntry {
  /**
   * Schema discriminator (G2 — no-token-loss). The legacy
   * PaymentsModule.save() flush owns the same `${addr}.invalid.` key
   * prefix and runs a per-entry diff that tombstones any on-disk key
   * not present in `data._invalid` (which is a `TxfInvalidEntry[]`,
   * NOT this DispositionWriter-owned shape). Stamping
   * `_schemaVersion: 'uxf-1'` on every write of this shape lets the
   * provider's `applyPerEntryDiff` recognize the foreign-schema entry
   * via `skipForeignSchema:true` and skip it during the live-vs-disk
   * diff — preserving the record across PaymentsModule.save() cycles.
   *
   * Stable on-disk; renaming this is a profile-format migration.
   */
  readonly _schemaVersion: 'uxf-1';
  /** Canonical token identifier (lowercase hex `byte_fields` form). */
  readonly tokenId: string;
  /**
   * Hex-encoded SHA-256 of the token-root element AS OBSERVED in the
   * originating bundle (multi-representation disambiguator). Two distinct
   * bundle copies of the same `tokenId` produce two distinct keys;
   * identical bundle copies produce the same key (idempotent re-write).
   */
  readonly observedTokenContentHash: ContentHash;
  /** Why this token was rejected. See {@link DispositionReason}. */
  readonly reason: DispositionReason;
  /** Wall-clock millisecond timestamp at which the record was written. */
  readonly observedAt: number;
  /** CIDv1 base32 of the bundle that delivered this token. */
  readonly bundleCid: string;
  /**
   * Sender's transport pubkey (64-hex; secp256k1 x-coordinate from the
   * Nostr signing key) — for forensic peer attribution.
   */
  readonly senderTransportPubkey: string;
}

/**
 * `_audit` collection record. Multiple records MAY exist for the same
 * `tokenId`, disambiguated by `observedTokenContentHash` in the storage
 * key (`${addr}.audit.${tokenId}.${observedTokenContentHash}`).
 *
 * Records are retained INDEFINITELY by default; even after promotion
 * (`auditStatus === 'audit-promoted'`), the original audit record is kept
 * for forensic traceability per §5.4 retention rules.
 *
 * @see UXF-TRANSFER-PROTOCOL §5.4 — `_audit` key shape, record schema, and
 * promotion semantics.
 */
export interface AuditEntry {
  /**
   * Schema discriminator (G1 — no-token-loss). Mirrors
   * {@link InvalidEntry._schemaVersion}: the legacy PaymentsModule.save()
   * flush owns the same `${addr}.audit.` key prefix and runs a per-entry
   * diff that tombstones any on-disk key not present in `data._audit`
   * (which is a `TxfAuditEntry[]`, NOT this DispositionWriter-owned
   * shape). Stamping `_schemaVersion: 'uxf-1'` on every write of this
   * shape lets the provider's `applyPerEntryDiff` recognize the
   * foreign-schema entry via `skipForeignSchema:true` and skip it
   * during the live-vs-disk diff — preserving the record across
   * PaymentsModule.save() cycles.
   *
   * Stable on-disk; renaming this is a profile-format migration.
   */
  readonly _schemaVersion: 'uxf-1';
  /** Canonical token identifier (lowercase hex `byte_fields` form). */
  readonly tokenId: string;
  /** SHA-256 of the as-observed token-root element (disambiguator). */
  readonly observedTokenContentHash: ContentHash;
  /** Lifecycle state — see {@link AuditStatus}. */
  readonly auditStatus: AuditStatus;
  /**
   * Why this token landed in `_audit` initially. Restricted in practice
   * to `not-our-state` or `off-record-spend` per the §5.4 routing table,
   * but typed broadly to {@link DispositionReason} for forward-compat.
   */
  readonly reason: DispositionReason;
  /** Wall-clock millisecond timestamp of initial recording. */
  readonly recordedAt: number;
  /**
   * Every bundle CID under which this `(tokenId, observedTokenContentHash)`
   * pair has been observed. Accumulates across re-arrivals of the same
   * observed-token-content-hash — append-only, deduplicated.
   * CIDv1 base32 strings.
   */
  readonly bundleCidsObserved: ReadonlyArray<string>;
  /**
   * Set on promotion: the `ContentHash` of the new active-pool manifest
   * entry that supersedes this audit record. The audit record is NOT
   * deleted on promotion.
   */
  readonly promotedToManifestRef?: ContentHash;
  /**
   * Promotion back-reference — the audit-record key(s) this audit entry
   * was promoted from, if any. Note that the corresponding manifest entry
   * sets the reverse pointer `audit_promoted_from` per §5.4 normative
   * metadata-preservation rules. Optional / informational here for
   * symmetric traceability.
   */
  readonly audit_promoted_from?: string;
  /**
   * Two-phase promotion marker (steelman finding #164).
   *
   * Set to `true` BEFORE the manifest write in
   * `DispositionWriter.promoteAuditEntry`, and cleared (deleted) when:
   *   - the manifest write succeeds and `auditStatus` flips to
   *     `'audit-promoted'`, OR
   *   - the manifest write fails before completing (rollback marker).
   *
   * The marker exists to make promotion **transactional under crash**:
   * if the process dies between the manifest write and the audit-status
   * write, a subsequent retry / merge can detect the in-flight state and
   * either finalize (if the manifest write is observed to have succeeded
   * via `audit_promoted_from` reverse-pointer) or roll back (if not).
   *
   * **Invariant**: `promotionPending: true` is incompatible with
   * `auditStatus === 'audit-promoted'`. The two states are mutually
   * exclusive — the marker is the "in-flight" lifecycle stage between
   * `audit-not-our-state` / `audit-off-record-spend` and `audit-promoted`.
   */
  readonly promotionPending?: boolean;
}

// =============================================================================
// 4. DispositionRecord — discriminated union (T.3.C)
// =============================================================================

/**
 * Subset of {@link ManifestEntry} fields the `DispositionWriter` accepts
 * from upstream (decision-matrix walker, conflict merger). The writer
 * stamps `lamport`, `bundleCid`, `senderTransportPubkey`, and
 * `lastProofRefreshAt` itself when writing through the manifest store —
 * upstream callers should NOT set those fields on the delta because they
 * are merged set-OR / max-merge by the store on every write.
 */
export type ManifestEntryDelta = Pick<
  ManifestEntry,
  'rootHash' | 'status' | 'conflictingHeads' | 'invalidReason' | 'splitParent'
>;

/**
 * Discriminated record of one §5.3 disposition outcome for a single
 * `tokenId` observed in an incoming UXF bundle. The `DispositionWriter`
 * routes each variant to its appropriate OrbitDB collection per §5.4:
 *  - `VALID` / `PENDING` / `CONFLICTING` → manifest store (active pool).
 *  - `INVALID`                            → `_invalid` per-entry-key.
 *  - `AUDIT`                              → `_audit` per-entry-key.
 *
 * The five-variant shape mirrors §5.3 [F] terminal dispositions (with
 * `PROOF_INVALID` / `STRUCTURAL_INVALID` collapsed under the single
 * `INVALID` discriminator — they differ only in the `reason` field, not
 * in storage routing per §5.4).
 *
 * **Provenance fields**. Every variant carries `bundleCid` and
 * `senderTransportPubkey` so the writer can stamp them on whichever
 * collection it routes to. They are forensic-mandatory for `_invalid`
 * and `_audit` records (per §5.4 record schema) and informational on
 * manifest entries (per PA §10.11 augmentation).
 *
 * @see UXF-TRANSFER-PROTOCOL §5.3 (decision matrix, dispositions)
 * @see UXF-TRANSFER-PROTOCOL §5.4 (storage outcomes / routing)
 * @see PROFILE-ARCHITECTURE §10.11 (manifest entry shape)
 */
export type DispositionRecord =
  | {
      readonly disposition: 'VALID';
      readonly tokenId: string;
      readonly observedTokenContentHash: ContentHash;
      readonly bundleCid: string;
      readonly senderTransportPubkey: string;
      /** The manifest delta to upsert; the writer fills in cross-replica
       *  merge metadata (`lamport`, `audit_promoted_from`, etc.) itself. */
      readonly manifest: ManifestEntryDelta;
    }
  | {
      readonly disposition: 'PENDING';
      readonly tokenId: string;
      readonly observedTokenContentHash: ContentHash;
      readonly bundleCid: string;
      readonly senderTransportPubkey: string;
      readonly manifest: ManifestEntryDelta;
    }
  | {
      readonly disposition: 'CONFLICTING';
      readonly tokenId: string;
      readonly observedTokenContentHash: ContentHash;
      readonly bundleCid: string;
      readonly senderTransportPubkey: string;
      readonly manifest: ManifestEntryDelta;
      /**
       * Every distinct chain-head hash observed for this `tokenId` so
       * far. Length is always ≥ 2 by definition of CONFLICTING. The
       * primary head is `manifest.rootHash`; this list MAY contain it
       * (the writer dedups + sorts on merge).
       */
      readonly conflictingHeads: readonly ContentHash[];
    }
  | {
      readonly disposition: 'INVALID';
      readonly tokenId: string;
      readonly observedTokenContentHash: ContentHash;
      readonly bundleCid: string;
      readonly senderTransportPubkey: string;
      readonly reason: DispositionReason;
    }
  | {
      readonly disposition: 'AUDIT';
      readonly tokenId: string;
      readonly observedTokenContentHash: ContentHash;
      readonly bundleCid: string;
      readonly senderTransportPubkey: string;
      readonly auditStatus: AuditStatus;
      readonly reason: DispositionReason;
    };

// =============================================================================
// 4. ManifestEntry re-export — PA §10.11 / canonical source
// =============================================================================

/**
 * The canonical wallet-level token manifest entry.
 *
 * Re-exported from `profile/token-manifest.ts` (the existing `TokenManifestEntry`
 * structural-subset definition) under the spec-aligned alias `ManifestEntry`
 * per UXF-TRANSFER-IMPL-PLAN T.1.C.
 *
 * **Future augmentation note**: PROFILE-ARCHITECTURE §10.11 specifies the
 * full augmented shape (with `splitParent`, `audit_promoted_from`,
 * `lamport`, `lastProofRefreshAt`, and `invalidReason: DispositionReason`).
 * Wave T.1.F (manifest CRDT) extends the canonical source to include those
 * fields; this re-export will pick up the augmentation transparently.
 *
 * @see PROFILE-ARCHITECTURE.md §10.11
 * @see UXF-TRANSFER-PROTOCOL.md §5.4 (cross-replica merge metadata rules)
 */
export type ManifestEntry = TokenManifestEntry;
