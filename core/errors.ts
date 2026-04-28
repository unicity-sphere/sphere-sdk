/**
 * SDK Error Types
 *
 * Structured error codes for programmatic error handling in UI.
 * UI can switch on error.code to show appropriate user-facing messages.
 *
 * @example
 * ```ts
 * import { SphereError } from '@unicitylabs/sphere-sdk';
 *
 * try {
 *   await sphere.payments.send({ ... });
 * } catch (err) {
 *   if (err instanceof SphereError) {
 *     switch (err.code) {
 *       case 'INSUFFICIENT_BALANCE': showToast('Not enough funds'); break;
 *       case 'INVALID_RECIPIENT': showToast('Recipient not found'); break;
 *       case 'TRANSPORT_ERROR': showToast('Network connection issue'); break;
 *       case 'TIMEOUT': showToast('Request timed out, try again'); break;
 *       default: showToast(err.message);
 *     }
 *   }
 * }
 * ```
 */

export type SphereErrorCode =
  | 'NOT_INITIALIZED'
  | 'ALREADY_INITIALIZED'
  | 'INVALID_CONFIG'
  | 'INVALID_IDENTITY'
  | 'INSUFFICIENT_BALANCE'
  | 'INVALID_RECIPIENT'
  | 'TRANSFER_FAILED'
  | 'UNSUPPORTED_TRANSFER_MODE'
  | 'STORAGE_ERROR'
  | 'STORAGE_CORRUPTED'
  | 'TRANSPORT_ERROR'
  | 'AGGREGATOR_ERROR'
  | 'VALIDATION_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'DECRYPTION_ERROR'
  | 'MODULE_NOT_AVAILABLE'
  | 'SIGNING_ERROR'
  // Token Spend Queue error codes
  | 'SEND_QUEUE_TIMEOUT'
  | 'SEND_INSUFFICIENT_BALANCE'
  | 'SEND_RESERVATION_CANCELLED'
  | 'SEND_QUEUE_FULL'
  | 'MODULE_DESTROYED'
  | 'REENTRANT_GATE'
  // Invoice / Accounting error codes
  | 'INVOICE_NO_TARGETS'
  | 'INVOICE_INVALID_ADDRESS'
  | 'INVOICE_NO_ASSETS'
  | 'INVOICE_INVALID_ASSET'
  | 'INVOICE_INVALID_AMOUNT'
  | 'INVOICE_INVALID_COIN'
  | 'INVOICE_INVALID_NFT'
  | 'INVOICE_PAST_DUE_DATE'
  | 'INVOICE_DUPLICATE_ADDRESS'
  | 'INVOICE_DUPLICATE_COIN'
  | 'INVOICE_DUPLICATE_NFT'
  | 'INVOICE_MINT_FAILED'
  | 'INVOICE_INVALID_PROOF'
  | 'INVOICE_WRONG_TOKEN_TYPE'
  | 'INVOICE_INVALID_DATA'
  | 'INVOICE_ALREADY_EXISTS'
  | 'INVOICE_NOT_FOUND'
  | 'INVOICE_NOT_TARGET'
  | 'INVOICE_ALREADY_CLOSED'
  | 'INVOICE_ALREADY_CANCELLED'
  | 'INVOICE_ORACLE_REQUIRED'
  | 'INVOICE_TERMINATED'
  | 'INVOICE_INVALID_TARGET'
  | 'INVOICE_INVALID_ASSET_INDEX'
  | 'INVOICE_RETURN_EXCEEDS_BALANCE'
  | 'INVOICE_INVALID_DELIVERY_METHOD'
  | 'INVOICE_INVALID_REFUND_ADDRESS'
  | 'INVOICE_INVALID_CONTACT'
  | 'INVOICE_INVALID_ID'
  | 'INVOICE_TOO_MANY_TARGETS'
  | 'INVOICE_TOO_MANY_ASSETS'
  | 'INVOICE_MEMO_TOO_LONG'
  | 'INVOICE_TERMS_TOO_LARGE'
  | 'INVOICE_NOT_TERMINATED'
  | 'INVOICE_NOT_CANCELLED'
  | 'INVOICE_STORAGE_FAILED'
  | 'RATE_LIMITED'
  | 'COMMUNICATIONS_UNAVAILABLE'
  // Swap error codes
  | 'SWAP_INVALID_DEAL'
  | 'SWAP_INVALID_MANIFEST'
  | 'SWAP_NOT_FOUND'
  | 'SWAP_WRONG_STATE'
  | 'SWAP_RESOLVE_FAILED'
  | 'SWAP_DM_SEND_FAILED'
  | 'SWAP_ESCROW_REJECTED'
  | 'SWAP_DEPOSIT_FAILED'
  | 'SWAP_PAYOUT_VERIFICATION_FAILED'
  | 'SWAP_ALREADY_EXISTS'
  | 'SWAP_ALREADY_COMPLETED'
  | 'SWAP_ALREADY_CANCELLED'
  | 'SWAP_TIMEOUT'
  | 'SWAP_LIMIT_EXCEEDED'
  | 'SWAP_ALREADY_INITIALIZED'
  | 'SWAP_MODULE_DESTROYED'
  | 'SWAP_NOT_INITIALIZED'
  // UXF transfer protocol error codes (T.1.D — bundle envelope decode failures).
  // The protocol surfaces three structurally-distinct failure modes that callers
  // and the receive worker must distinguish:
  //   - `BUNDLE_REJECTED_MALFORMED_ENVELOPE` — the outer Nostr-content JSON
  //     could not be parsed, was not a plain object, lacked required fields,
  //     carried a wrong version literal, or otherwise failed structural
  //     validation against `isUxfTransferPayload` (§3.1, §5.0).
  //   - `BUNDLE_REJECTED_MULTI_ROOT` — `extractCarRootCid` saw a CAR with more
  //     than one root, which the verifier rejects per Wave G.5 / §5.2 #1.
  //   - `BUNDLE_REJECTED_INVALID_CAR` — `extractCarRootCid` failed to parse the
  //     CAR bytes (truncated, corrupt header, unknown framing). Distinct from
  //     `MULTI_ROOT` because the latter is a parseable-but-policy-rejected CAR.
  //
  // Cryptographic verification (signatures, proofs, root-CID-vs-bundleCid match)
  // is delegated to `pkg.verify()` (T.3.A) and surfaces other codes; T.1.D's
  // helpers are envelope-level only.
  | 'BUNDLE_REJECTED_MALFORMED_ENVELOPE'
  | 'BUNDLE_REJECTED_MULTI_ROOT'
  | 'BUNDLE_REJECTED_INVALID_CAR'
  // UXF transfer protocol error codes (T.3.A — bundle acquirer + verifier).
  // The recipient-side bundle pipeline surfaces these structural rejections
  // before any per-token disposition is computed (§5.1, §5.2):
  //
  //   - `BUNDLE_REJECTED_ROOT_CID_MISMATCH` — `payload.bundleCid` did not
  //     match the CARv1 root CID we extracted from `payload.carBase64`. The
  //     sender lied about which CID their CAR represents (or the CAR was
  //     swapped in transit). §5.2 #1.
  //   - `BUNDLE_REJECTED_CHAIN_DEPTH_EXCEEDED` — at least one CLAIMED token
  //     (advertised in `payload.tokenIds`) carries an unfinalized-tx chain
  //     deeper than `MAX_CHAIN_DEPTH` (default 64). The whole bundle is
  //     rejected. Unclaimed/smuggled roots exceeding the cap are silently
  //     dropped, NOT escalated to this error (§5.2 #3 two-tier rule).
  //   - `BUNDLE_REJECTED_UNCLAIMED_ROOT_COUNT_EXCEEDED` — the bundle's pool
  //     contains more than `MAX_UNCLAIMED_ROOTS` (default 16) `token-root`
  //     elements that are NOT enumerated in `payload.tokenIds`. Includes
  //     elements with unknown type-tags as a fail-closed defense (§5.2 #4).
  //   - `BUNDLE_REJECTED_CID_MODE_NOT_YET_SUPPORTED` — `kind: 'uxf-cid'`
  //     payload arrived but the IPFS fetch path is not enabled in this
  //     build (T.4.B will land it). Surfaced so callers can distinguish a
  //     real failure from a deliberate not-implemented branch.
  | 'BUNDLE_REJECTED_ROOT_CID_MISMATCH'
  | 'BUNDLE_REJECTED_CHAIN_DEPTH_EXCEEDED'
  | 'BUNDLE_REJECTED_UNCLAIMED_ROOT_COUNT_EXCEEDED'
  | 'BUNDLE_REJECTED_CID_MODE_NOT_YET_SUPPORTED'
  // Generic structural rejection — used by the bundle verifier when
  // `pkg.verify()` reports any non-multi-root structural failure (cycle,
  // hash mismatch, missing element, type-tag mismatch, ...). The originating
  // `UxfVerificationIssue[]` is forwarded as `cause` so callers retain
  // forensic detail without exploding the SphereErrorCode taxonomy.
  | 'BUNDLE_REJECTED_VERIFY_FAILED'
  // UXF Transfer / Delivery resolver (T.2.C) — §3.3.1 inline-cap & relay-safe ceiling.
  // The resolver maps `(DeliveryStrategy, carBytes)` to a concrete delivery decision
  // (inline base64 vs CID-by-reference) and surfaces TWO distinct failure modes:
  //   - `INLINE_CAR_TOO_LARGE` — the resulting Nostr event would exceed the
  //     relay-safe ceiling (RELAY_SAFE_CAP_BYTES = 96 KiB). Surfaces in two paths:
  //     (a) `delivery: { kind: 'force-inline' }` with `carBytes.length > 96 KiB`
  //         — the caller chose force-inline explicitly and must handle this branch.
  //     (b) (future) §3.3 publish-time relay rejection in force-inline path
  //         — out of scope for T.2.C; surfaced by the sender orchestrator.
  //     `auto` mode never throws this code: it falls back to `uxf-cid` instead.
  //   - `INVALID_INLINE_CAP` — `delivery: { kind: 'auto', inlineCapBytes: N }` with
  //     `N < 1` (zero, negative, NaN, or non-finite). Per §3.3.1 normative paragraph,
  //     implementations MAY reject undersized caps deterministically — we choose
  //     reject (W12). Note that OVERSIZED caps (`N > 96 KiB`) are SILENTLY CLAMPED,
  //     not rejected, because the spec mandates `auto` never publishes inline above
  //     the relay-safe ceiling regardless of user override; clamp is the deterministic
  //     no-surprise behavior.
  | 'INLINE_CAR_TOO_LARGE'
  | 'INVALID_INLINE_CAP'
  // UXF Transfer / CRDT primitives (T.1.F) — §5.5 step 9, §7.1 Lamport invariants
  /** Observed remote Lamport > 2 × max(localKnownLamports). Defends against
   *  a malicious/buggy replica publishing an absurdly large Lamport (e.g.
   *  near `2^53`) to force everyone past JS safe-integer range. The bound
   *  is generous enough that legitimate divergence (e.g. one replica that
   *  has been offline) never trips, but rejects clearly-runaway values
   *  (W39). See profile/lamport.ts and §7.1 invariants. */
  | 'LAMPORT_BOUND_VIOLATION'
  /** `PerTokenMutex` strategy `'bounded-hold'` exceeded its `MAX_LOCK_HOLD_MS`
   *  (default 5000ms) and aborted the current acquire to prevent the lock
   *  from being held indefinitely under aggregator stalls (W35). The lock
   *  is released as part of throwing this error so the next caller may
   *  proceed. See profile/per-token-mutex.ts and §5.5 step 9. */
  | 'LOCK_BOUNDED_HOLD_FIRED'
  /** `ManifestStore.upsert` exhausted its bounded CAS retry budget
   *  (default 3 attempts) under concurrent contention. The caller may
   *  re-invoke; persistent failures indicate hot-key contention or a
   *  storage-backend defect that should surface to the operator rather
   *  than be retried indefinitely. See profile/manifest-store.ts and
   *  §5.5 step 9. */
  | 'MANIFEST_CAS_RETRY_EXHAUSTED'
  // UXF Transfer / outbox CRDT (T.6.A) — §7 bundle-grained outbox writer.
  /** `OutboxWriter.update(id, ...)` called with an `id` that has no live
   *  UXF outbox entry — either the key never existed, or the prior value
   *  is a tombstone, or the entry is in the legacy shape (which the
   *  writer does not mutate). Callers that need to upsert should call
   *  `OutboxWriter.write(...)` instead of update. See profile/outbox-writer.ts
   *  and UXF-TRANSFER-PROTOCOL §7. */
  | 'OUTBOX_ENTRY_NOT_FOUND'
  // UXF Transfer / outbox CRDT merger (T.6.B) — §7.1 conflict resolution.
  /** `mergeOutboxEntries(a, b)` called with replicas that disagree on `id`.
   *  Per-key keyvalue semantics mean the merger should never see a pair of
   *  records with different ids; the check is defensive against caller bugs.
   *  See profile/outbox-merger.ts and UXF-TRANSFER-PROTOCOL §7.1. */
  | 'OUTBOX_MERGE_ID_MISMATCH'
  /** `mergeOutboxEntriesPair([])` called with an empty replica set. The
   *  merger has no canonical answer for "merge zero replicas". Callers
   *  must filter empty inputs before invoking the fold. See
   *  profile/outbox-merger.ts. */
  | 'OUTBOX_MERGE_EMPTY'
  /**
   * UXF Inter-Wallet Transfer T.6.C — outbox state-machine validator hard-fail.
   *
   * Thrown by `profile/outbox-state-machine.ts` (and threaded through
   * `OutboxWriter.update`) when a caller attempts a `status` transition that
   * is not present in the §7.0 canonical transition table, or that requires
   * a side-channel condition (`overrideApplied`, `dualWriteEnabled`) that
   * was not supplied. The validator's transition table is the SINGLE source
   * of truth — disallowed moves never silently succeed.
   *
   * Surfaces in three sub-cases (cause carries `{ from, to, reason }`):
   *  - `'no-such-arc'`        — `(from, to)` is not in the §7.0 table.
   *  - `'override-required'`  — `failed-permanent → finalizing` without
   *                             `overrideApplied: true` (operator escape
   *                             hatch per §7.0 last paragraph).
   *  - `'dual-write-disabled'` — schema-mode `legacy ↔ uxf` arc attempted
   *                              while `dualWriteEnabled !== true` (§7.B /
   *                              W43 — migration-window only).
   *
   * See profile/outbox-state-machine.ts and UXF-TRANSFER-PROTOCOL §7.0.
   */
  | 'INVALID_OUTBOX_TRANSITION'
  /**
   * UXF Inter-Wallet Transfer T.2.A — preflight-finalize hard-failure.
   *
   * Thrown by `modules/payments/transfer/preflight-finalize.ts` when the
   * sender attempts to walk a source token's pending-transaction history
   * (conservative-mode preflight, §2.2 / §13 Wave T.2) and the aggregator
   * surfaces a non-transient rejection on any tx in that chain. The
   * `cause` carries `{ tokenId, requestId, reason }` where `reason` is one
   * of the canonical 14 `DispositionReason` strings (§6.1 mapping):
   *  - `'belief-divergence'`  ← `AUTHENTICATOR_VERIFICATION_FAILED` at submit
   *  - `'client-error'`       ← `REQUEST_ID_MISMATCH` at submit
   *  - `'oracle-rejected'`    ← sustained `PATH_NOT_INCLUDED` past polling window
   *  - `'proof-invalid'`      ← exhausted `PATH_INVALID` / `NOT_AUTHENTICATED`
   *  - `'race-lost'`          ← proof's transactionHash mismatches local
   *
   * T.2.D.1 (conservative-sender orchestrator) catches this and re-throws
   * `INSUFFICIENT_BALANCE` with `reason='source-cascade-failed'` per the
   * §13 Wave T.2 acceptance — preflight itself stays purely descriptive so
   * the typed cause is forensically preserved up the stack.
   */
  | 'SOURCE_CHAIN_HARD_FAIL'
  // UXF Transfer / Multi-asset target validation (T.2.B) — §4.1 step 1 + 2,
  // §11.2 validation rejection cases. The validator at
  // `modules/payments/transfer/target-validator.ts` is the SINGLE source of
  // truth; every error below surfaces at validation time as a `SphereError`.
  /** `validateTargets()` was called with no primary `(coinId, amount)` slot
   *  AND no `additionalAssets` entries (W22). The request carries nothing to
   *  send. See §4.1 step 1 "If `targetList.length === 0` → EMPTY_TRANSFER".
   */
  | 'EMPTY_TRANSFER'
  /** Structural rejection of the request shape: duplicate `coinId` across
   *  primary + `additionalAssets`, duplicate NFT `tokenId`, partial primary
   *  slot (only one of `coinId`/`amount` set), or otherwise malformed
   *  request. Distinct from `INVALID_AMOUNT` (numeric) and `EMPTY_TRANSFER`
   *  (no targets). See §4.1 step 1 prose and §11.2 validation rejections. */
  | 'INVALID_REQUEST'
  /** A coin-target's `amount` is not a positive integer string (`<= 0`,
   *  fractional, non-numeric, or negative). See §4.1 step 1 "Each `kind:
   *  'coin'` entry's `amount` MUST be > 0". */
  | 'INVALID_AMOUNT'
  /** An `additionalAssets` entry's `kind` discriminator is neither `'coin'`
   *  nor `'nft'`. Forward-compat reject rule per §4.1 step 1
   *  "Discriminator forward-compat" / §10.4. */
  | 'UNKNOWN_ASSET_KIND'
  /** A `kind: 'nft'` target's source token has unfinalized predecessor txs
   *  (status pending) AND `confirmNftPending: false` (default). NFT cascade
   *  asymmetry per §4.1 step 2 "NFT cascade asymmetry warning" — NFT
   *  cascades are irrecoverable, so callers MUST acknowledge with
   *  `confirmNftPending: true` to proceed (W11). */
  | 'NFT_PENDING_REQUIRES_CONFIRMATION'
  /** UXF Conservative-sender orchestrator (T.2.D.1) — the resolved
   *  delivery decision is CID-bound (`force-cid` or `auto`-over-cap) but
   *  the caller did not supply a `publishToIpfs` callback. Surfaced as a
   *  pre-flight reject so the orchestrator does not waste work
   *  building a CAR it cannot ship. See §3.3.1 / §T.2.D.1 acceptance. */
  | 'IPFS_PUBLISHER_MISSING'
  /**
   * UXF Inter-Wallet Transfer T.3.B.1 — per-element verifier surfaced a
   * SHAPE-LEVEL failure (parser threw, malformed authenticator, missing
   * required pool reference, inconsistent imprint). The verifiers in
   * `modules/payments/transfer/{predicate-evaluator,authenticator-verifier,
   * proof-verifier}.ts` raise this code when the SDK call they wrap
   * unexpectedly throws.
   *
   * Distinct from `BUNDLE_REJECTED_VERIFY_FAILED` (bundle-level §5.2 #1)
   * because the per-element verifiers operate after structural verify
   * already passed — a throw here means a defect inside an element that
   * the bundle-level pkg.verify() did not catch (e.g., ECDSA primitive
   * raised on malformed signature bytes the structural type-check waved
   * through). The decision-matrix walker in T.3.B.2 maps a STRUCTURAL_INVALID
   * to `DispositionReason: 'structural'` per §5.3 [A].
   */
  | 'STRUCTURAL_INVALID';

export class SphereError extends Error {
  readonly code: SphereErrorCode;

  constructor(message: string, code: SphereErrorCode, cause?: unknown) {
    // Steelman³⁸ note: forward `cause` to the native Error constructor
    // so `err.cause` walks (Sentry, util.inspect, pino-pretty) see the
    // chain. Previously a redeclared `readonly cause?: unknown` field
    // shadowed the native getter, breaking standard tooling.
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'SphereError';
    this.code = code;
  }
}

/**
 * Type guard to check if an error is a SphereError
 */
export function isSphereError(err: unknown): err is SphereError {
  return err instanceof SphereError;
}
