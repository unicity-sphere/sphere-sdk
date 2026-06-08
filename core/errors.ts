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
  // #142 defense-in-depth — the sender orchestrator's post-commit assertion
  // that the sum of fungible amounts encoded in the recipient token JSONs
  // does not exceed the request's per-coin totals. Catches over-send bugs
  // where a partial-amount request silently ships a full source token.
  | 'OVER_TRANSFER_GUARD'
  // PR #152 defense-in-depth — pre-validate that the wallet's signing key
  // owns every source token planned for spending. Catches the same bug
  // class PR #130 fixes at the root, on the send-side as a backstop.
  | 'OWNERSHIP_VERIFICATION_FAILED'
  // Issue #166 P2 #2 — duplicate-bundle guard. Rejects sends whose
  // source token selection includes a tokenId already present in a
  // live OUTBOX entry OR in the SENT ledger. Override via
  // `TransferRequest.allowDuplicateBundleMembership = true`.
  | 'DUPLICATE_BUNDLE_MEMBERSHIP'
  // Issue #166 P1 #2 — tombstone resurrection guard.
  // `OutboxWriter.write()` and `SentLedgerWriter.write()` refuse to
  // overwrite a slot that currently holds a tombstone marker. Pass
  // `{ allowResurrection: true }` as the second argument for
  // operator escape-hatch / test-fixture resurrections.
  | 'OUTBOX_ENTRY_TOMBSTONED'
  // OUTBOX-SEND-FOLLOWUPS Item #14 Phase 1 — typed throw for the
  // multi-device double-spend case. The aggregator rejected our
  // `submitTransferCommitment` because the source `stateHash` is
  // already spent on-chain. The dispatcher re-queries
  // `oracle.isSpent(sourceStateHash)` to disambiguate from generic
  // commit failures; on confirmed spent it raises this code with a
  // structured `details` payload carrying `tokenId`, `sourceStateHash`,
  // and `ourIntendedRecipient` so the outer dispatch catch can emit
  // `transfer:double-spend-detected` for operator visibility.
  //
  // Distinct from generic `TRANSFER_FAILED`: this code signals a
  // documented multi-device race (two peers concurrently spent the
  // SAME source token to DIFFERENT destinations; the loser sees this
  // code). The winning peer's commit IS on-chain — the loser's
  // bundle was never delivered.
  //
  // See docs/uxf/OUTBOX-SEND-FOLLOWUPS.md Item #14.
  | 'STATE_ALREADY_SPENT_BY_OTHER'
  | 'STORAGE_ERROR'
  | 'STORAGE_CORRUPTED'
  // Issue #310 — `sphere.profile.resetEpoch()` invoked when not in
  // Profile mode. Defensive: `Sphere.profile` returns `null` for
  // non-Profile wallets, so this is normally unreachable.
  | 'NOT_PROFILE_MODE'
  // Issue #310 — any step of `sphere.profile.resetEpoch()` threw.
  | 'PROFILE_RESET_FAILED'
  | 'TRANSPORT_ERROR'
  | 'AGGREGATOR_ERROR'
  | 'VALIDATION_ERROR'
  | 'NAMETAG_CONFLICT'
  | 'NAMETAG_TAKEN'
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
  | 'INVOICE_INVALID_RECIPIENT'
  | 'INVOICE_INVALID_CONTACT'
  | 'INVOICE_INVALID_ID'
  | 'INVOICE_TOO_MANY_TARGETS'
  | 'INVOICE_TOO_MANY_ASSETS'
  | 'INVOICE_MEMO_TOO_LONG'
  | 'INVOICE_TERMS_TOO_LARGE'
  | 'INVOICE_NOT_TERMINATED'
  | 'INVOICE_NOT_CANCELLED'
  | 'INVOICE_STORAGE_FAILED'
  | 'INVOICE_DELIVERY_FAILED'
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
  // Recipient-side authoritative inline-CAR size cap. The sender enforces
  // `clampInlineCap` against `RELAY_SAFE_CAP_BYTES = 96 KiB` before
  // inlining, but that's a politeness layer. Without recipient
  // enforcement, a hostile sender can ship a 6 MiB base64 payload
  // (~4.5 MiB CAR), bypassing the cap entirely and forcing the recipient
  // to base64-decode and CAR-parse a multi-megabyte blob. Surfaces from
  // `bundle-acquirer.ts` Step 2 when `payload.carBase64.length` exceeds
  // the cap. Steelman fix #170. */
  | 'BUNDLE_REJECTED_INLINE_CAP_EXCEEDED'
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
   * UXF Inter-Wallet Transfer T.4.A — a CID delivery branch was selected
   * (force-cid or auto-over-cap) but no `publishToIpfs` callback was
   * supplied AND the CAR exceeds the relay-safe inline ceiling. An IPFS
   * provider must be configured to send bundles of this size. See §3.3.1
   * / approach γ inline-fallback. */
  | 'IPFS_PUBLISHER_REQUIRED'
  /**
   * UXF Inter-Wallet Transfer (steelman Wave 3) — the caller explicitly
   * selected `force-cid` delivery (privacy / audit-by-CID intent) but no
   * `publishToIpfs` callback was supplied. The resolver REFUSES to
   * silently downgrade to inline because that would leak the CAR to the
   * relay — a privacy regression vs the caller's explicit choice. The
   * caller must either (a) wire an IPFS publisher or (b) switch to
   * `auto` / `force-inline` if the inline leak is acceptable. Distinct
   * from `IPFS_PUBLISHER_REQUIRED` (which fires only when the bundle is
   * physically too large for inline delivery). */
  | 'FORCE_CID_NO_PUBLISHER'
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
  | 'STRUCTURAL_INVALID'
  // UXF Transfer / Recipient CID fetcher (T.4.B) — §3.3, §3.3.1, §3.3.2 + §9.2.
  // The CID-by-reference recipient path (`kind: 'uxf-cid'`) walks a configured
  // gateway list and stream-fetches the CAR, with three distinct failure
  // modes that the worker pool needs to discriminate from "structural"
  // bundle rejections (which write `_invalid` records):
  //
  //   - `FETCHED_CAR_TOO_LARGE` — streaming fetch exceeded the recipient-side
  //     32 MiB cap (`MAX_FETCHED_CAR_BYTES`). The fetcher aborts the reader
  //     mid-stream — the body is NOT buffered in full before the check. This
  //     is a DoS defense against malicious senders pinning huge CARs (§3.3.1).
  //     Try the next gateway: a different gateway might serve the same CID
  //     under-cap (e.g., gateway-side compression / chunking differences),
  //     though most "huge CAR" cases are uniform across gateways.
  //   - `BUNDLE_REJECTED_GATEWAY_CID_MISMATCH` — gateway returned a parseable
  //     CAR whose root CID disagrees with the requested `bundleCid`. A buggy
  //     or hostile gateway is fabricating content. Try the next gateway —
  //     the protocol defends against gateway misbehavior by re-hashing.
  //   - `BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT` — every gateway in the list
  //     failed (network error, 5xx, mismatch, oversize, ...). This is a
  //     TRANSIENT class — the worker pool wraps this in retry, NOT in a
  //     `_invalid` disposition write. Per §9.2 / W13: "NO disposition record
  //     written" — only the transient retry path runs. The recipient does
  //     NOT acknowledge the sender; the sender's outbox times out at retry
  //     deadline and may attempt CAR-embed re-delivery. The error's `cause`
  //     carries `{ bundleCid, gatewaysAttempted, failureReasons }` for
  //     forensic detail.
  | 'FETCHED_CAR_TOO_LARGE'
  | 'BUNDLE_REJECTED_GATEWAY_CID_MISMATCH'
  | 'BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT'
  /**
   * UXF Inter-Wallet Transfer T.3.B.2 — instant-mode soft-rejection.
   *
   * The §5.3 disposition engine refuses to walk a bundle whose advertised
   * `mode` is `'instant'` AND whose pool contains at least one transaction
   * lacking an inclusion proof. Per the T.3 deferred-handling note in
   * `docs/uxf/UXF-TRANSFER-IMPL-PLAN.md` §13 / §T.5 wave plan, instant-mode
   * receive (with the recipient-side finalization queue) does not land
   * until the T.5.C finalization worker is wired. Until then, the engine
   * surfaces this typed soft-error so the worker pool (T.3.E) can drop
   * the bundle with a clean rejection path — no disposition record is
   * written, the sender's outbox times out, and re-delivery as a
   * conservative-mode bundle remains possible.
   *
   * **Why a SOFT error, not a per-token disposition**: a bundle whose
   * `mode` field claims `'instant'` is structurally well-formed; the
   * decision to defer is a CAPABILITY GATE on the recipient side, not a
   * structural / cryptographic failure of the bundle's contents. Routing
   * this through the disposition matrix (e.g. as STRUCTURAL_INVALID)
   * would produce false-positive `_invalid` records the operator would
   * then have to clear by hand once T.5.C lands.
   *
   * **Detection**: the engine inspects the supplied `mode` field AND
   * walks the token's transaction chain. If `mode === 'instant'` AND any
   * tx has `inclusionProof === null`, it throws this error. Conservative
   * mode bundles with all-finalized chains follow the regular [A]-[F]
   * matrix; instant-mode bundles whose chains are coincidentally fully
   * finalized are processed normally (the deferred behavior is gated by
   * unfinalized-tx presence, not by the `mode` field alone).
   */
  | 'BUNDLE_REJECTED_INSTANT_MODE_NOT_YET_SUPPORTED'
  /**
   * UXF Inter-Wallet Transfer T.7.B — legacy-shape adapter received an
   * instant-TXF chain (one or more transactions with `inclusionProof:
   * null`) but the caller did not wire a finalization-queue enqueuer
   * (`enqueueFinalization` was `undefined`/`null`, or `addr` was
   * missing).
   *
   * Per §4.4.2 / §5.5, instant-TXF arrivals MUST be routed through the
   * per-address chain-mode finalization queue so the recipient worker
   * can drain pending transactions and re-run §5.3 [B]/[D]/[E]. Without
   * a wired enqueuer, a `PENDING` disposition would be written to the
   * manifest with NO worker tracking — permanently stuck. We refuse to
   * write the disposition and throw at the adapter boundary instead.
   *
   * **Resolution**: callers MUST pass a `FinalizationQueueEnqueuer`
   * AND an `addr` whenever instant-TXF chains may arrive (i.e., for
   * any production recipient pipeline). Pre-T.5.C deployments that
   * cannot accept instant-TXF arrivals should configure their senders
   * to use `txfFinalization: 'conservative'`. Tests that intentionally
   * exercise legacy adapter paths without an enqueuer should ensure
   * every chain has fully-finalized transactions (no `inclusionProof:
   * null`).
   */
  | 'MISSING_FINALIZATION_QUEUE'
  /**
   * UXF Inter-Wallet Transfer T.5.B — sender-side finalization worker
   * polling-policy validation failure (§5.5 step 6 normative
   * configuration validity rule).
   *
   * Thrown at construction by `FinalizationWorkerSender` when the
   * cumulative backoff for the first `MIN_POLL_ATTEMPTS` polls exceeds
   * `POLLING_WINDOW_MS`. Spec mandates implementations refuse to start
   * if the rule is violated — otherwise the deadline could fire before
   * the minimum attempts are observed, deferring termination to the
   * 2× hard safety net for every queue entry.
   */
  | 'INVALID_POLLING_POLICY'
  /**
   * UXF Inter-Wallet Transfer T.3.E — recipient-side ingest worker pool
   * back-pressure (§5.0).
   *
   * The pool maintains a bounded queue (default `INGEST_QUEUE_SIZE = 256`)
   * that buffers verified bundles between the transport's `onIncomingTransfer`
   * callback and the N=16 worker fan-out. When every queue slot is occupied,
   * the next arrival is REJECTED at the door and the sender's outbox
   * eventually times out (transient-class). The pool emits
   * `transfer:ingest-queue-full` simultaneously so operators see the
   * back-pressure signal in real time.
   *
   * Per §5.0: this is "a hard back-pressure signal — the recipient cannot
   * keep up." Distinct from {@link INGEST_QUEUE_FULL_PER_TOKEN}: that is
   * fairness across token-ids; THIS is total-queue saturation.
   */
  | 'INGEST_QUEUE_FULL'
  /**
   * UXF Inter-Wallet Transfer T.3.E / W7 — per-tokenId fairness cap inside
   * the recipient ingest queue (§5.0).
   *
   * To prevent an attacker (or buggy peer) from monopolizing the queue with
   * bundles all targeting the same `tokenId`, the pool counts queue entries
   * by their claimed token-ids and rejects further arrivals once any one
   * id has accumulated `INGEST_QUEUE_PER_TOKEN_CAP` (default 16) pending
   * bundles. Other tokens continue to enqueue normally; only the hot
   * tokenId is gated.
   *
   * Counting rule: an enqueued bundle increments every claimed token-id's
   * counter; rejection fires if ANY claimed id is over-cap. Workers
   * decrement the counters when dequeueing.
   */
  | 'INGEST_QUEUE_FULL_PER_TOKEN'
  /**
   * UXF Inter-Wallet Transfer T.3.E (Round 3 regression fix) — re-enqueue
   * after wall-clock timeout would have exceeded the queue capacity cap.
   *
   * The per-bundle wall-clock budget triggers a one-shot retry: on
   * timeout we re-push the entry to the queue. Round 2 did this without
   * checking against the queue-capacity cap, so under sustained timeout
   * pressure the queue could grow unboundedly. Round 3: if a re-enqueue
   * would exceed `queueCapacity`, we hard-fail the entry instead and
   * emit a final `transfer:operator-alert`. The bundle is dropped; no
   * disposition record is written.
   */
  | 'BUNDLE_REJECTED_QUEUE_CAP_EXCEEDED'
  /**
   * UXF Inter-Wallet Transfer T.5.D — operator escape-hatch wiring missing.
   *
   * `PaymentsModule.importInclusionProof()` and
   * `PaymentsModule.revalidateCascadedChildren()` require the bootstrap
   * layer to install an {@link InclusionProofImporter} and a
   * {@link RevalidateCascadedRunner} respectively. When the operator
   * invokes either method without the corresponding `install*` having
   * been called, the module surfaces this code rather than silently
   * no-op-ing — the operator console MUST report the misconfiguration.
   *
   * Distinct from `MODULE_NOT_AVAILABLE` (which signals an entire
   * sub-module is disabled). This code signals a SPECIFIC integration
   * point inside an otherwise-functional payments module.
   */
  | 'OPERATOR_ESCAPE_HATCH_NOT_CONFIGURED'
  /**
   * Issue #312 — offline-mode send-path gate.
   *
   * `PaymentsModule.send()` throws this code BEFORE any state mutation
   * (no aggregator call, no Nostr publish, no token reservation) when
   * the aggregator backend is observed `'down'` by the connectivity
   * manager. Callers receive a structured `context` payload:
   *
   *     { which: 'aggregator' }
   *
   * The `'degraded'` aggregator state does NOT trigger this gate: the
   * SDK's retry layer already handles slow / partially-failing
   * aggregators, and the UX cost of blocking sends under `'degraded'`
   * is worse than letting the retry complete.
   *
   * IPFS and Nostr are NOT gated by this code. An IPFS outage means
   * the send may downgrade to inline delivery (under the relay-safe
   * cap), and a Nostr outage means delivery may be queued for retry —
   * neither is a hard offline condition.
   */
  | 'OFFLINE';

// ===========================================================================
// W40 — SphereError redaction layer (T.8.C)
// ===========================================================================
//
// Some error paths (notably the §5.5 / §6.1 finalization worker's
// REQUEST_ID_MISMATCH client-error branch) place a forensically-useful
// `cause` on the thrown SphereError that contains raw signed-transaction
// bytes (`signedTransferTxBytes`) or related signed authenticator/commitment
// payloads. Those bytes are submission-only secrets — re-emitting them in a
// log line, a UI surface, or an outgoing telemetry packet would let any
// observer replay the commitment under our key.
//
// The redaction layer below intercepts every `SphereError` constructor call
// and walks the supplied `cause` ONCE (eagerly, at construction time), deep-
// cloning it into a redacted view in which any field whose name appears in
// `REDACTED_FIELDS` is replaced by an opaque marker:
//
//     `[REDACTED: <field>(<n>-bytes)]`        for `Uint8Array` values
//     `[REDACTED: <field>]`                    for any other value type
//
// The redacted view is what `error.cause` and `error.context` expose; the
// original `cause` is NOT retained on the error. Callers that wish to
// preserve forensic detail must redact at *construction* — by the time
// the SphereError exists, the original bytes are already gone.
//
// **Why eager** — a lazy access-time redaction (computing on first read)
// would still hold the original bytes alive on the error instance, defeating
// the point if a logger walks the prototype chain or the GC pressure spikes
// before the first read. Eager redaction also means the marker is stable
// across `JSON.stringify(err.cause)`, `util.inspect(err)`, and the
// `error.cause` property walks done by Sentry / pino-pretty / Node's own
// error formatter.
//
// **Why a constant list** — adding a redaction target is a deliberate API
// decision that should land in this file, not be configurable per call.
// Drift between throw-sites would defeat the defense.

/**
 * Field names whose values are eagerly redacted from any SphereError
 * `cause` (deep walk). Keep in lockstep with §5.5 step 1 and §6.1 forensic
 * payload conventions.
 *
 * **Cryptographic-secret fields:**
 *  - `signedTransferTxBytes`  — see §5.5 `FinalizationQueueEntry` and the
 *    finalization-worker-sender `REQUEST_ID_MISMATCH` client-error path
 *    (§6.1, C12/C13). The bytes are the signed transfer transaction body
 *    submitted to the aggregator; replay would re-execute the transition.
 *  - `signedCommitmentBytes`  — generic submission payload field used by
 *    aggregator-client wrappers; redacted defensively for the same reason
 *    even though no current call site emits it on a SphereError cause.
 *  - `rawAuthenticator`       — the signed authenticator structure
 *    submitted alongside a commitment; treated as equally-sensitive.
 *
 * **Round 5 — defensive sister-name additions (W40 redaction).**
 * These are NOT secret bytes per se; they are aggregator-/peer-supplied
 * untrusted strings (or sub-structures) that historically leaked into
 * `err.cause` unchanged. The W40 redaction layer is the choke point we
 * trust to scrub them; sanitizers (`sanitizeReasonString`) at throw sites
 * provide a second line of defense for the human-readable `message`
 * field, but `cause`-attached forensic copies were uncovered. The
 * sister names below all carry untrusted content with the same threat
 * model (control-char log injection, HTML XSS, multi-MB log flood) that
 * defense-in-depth motivated for the cryptographic fields. Listing them
 * here means a hostile aggregator-/peer-supplied payload at any of these
 * keys is replaced with an opaque marker the moment it lands on a
 * SphereError.
 *
 *  - `aggregatorError`        — preflight-finalize / finalization-worker
 *    forensic field carrying the aggregator's verbatim error string.
 *  - `failureReasons`         — bundle-fetcher + sender-orchestrator
 *    accumulated remote rejection reasons.
 *  - `errorMessage`           — generic alias the SDK and downstream
 *    consumers attach when wrapping native throws.
 *  - `serverError`            — common HTTP/RPC server-error stash
 *    (e.g. `{ status, serverError }`).
 *  - `responseBody` / `responseText` / `body`  — raw HTTP response bodies
 *    captured for postmortem; can be megabytes and may carry HTML.
 *  - `requestBody`            — outgoing request body captured on failure
 *    (may include sensitive request payloads in addition to attacker-
 *    influenced content if echoed back; redact defensively).
 *  - `rawError`               — generic catch-all for "the original
 *    error string we wrapped."
 *  - `errorBody`              — alternate naming convention some
 *    libraries use for response bodies.
 *
 * **Trade-off documentation.** Redacting sister names sacrifices some
 * forensic context — operators who currently grep `aggregatorError` to
 * see verbatim server text will instead see `[REDACTED: aggregatorError]`.
 * Defense-in-depth wins for the protocol layer: senders are not
 * authenticated peers w.r.t. their error-string content, and the
 * narrowest defense (sanitize at throw sites) cannot cover unknown
 * future call sites. Operators who NEED readable forensics should
 * arrange for the throw site to splice a sanitized `*Summary` field
 * (e.g., `aggregatorErrorSummary: sanitizeReasonString(rawText)`)
 * alongside the redacted raw field — the summary survives W40 because
 * its name is not in the list.
 *
 * Adding a name here is a deliberate API decision — drift between throw
 * sites defeats the defense. New names land here AND in
 * `tests/unit/payments/transfer/sphere-error-redaction.test.ts`.
 */
export const REDACTED_FIELDS: ReadonlyArray<string> = Object.freeze([
  // Cryptographic-secret fields (W40 original set).
  'signedTransferTxBytes',
  'signedCommitmentBytes',
  'rawAuthenticator',
  // Round 5 — defensive sister names (untrusted strings/payloads).
  'aggregatorError',
  'failureReasons',
  'errorMessage',
  'serverError',
  'responseBody',
  'requestBody',
  'responseText',
  'body',
  'rawError',
  'errorBody',
]);

const REDACTED_FIELDS_SET: ReadonlySet<string> = new Set(REDACTED_FIELDS);

/**
 * Recursively deep-clone `value`, replacing any property whose KEY appears
 * in {@link REDACTED_FIELDS} with a marker string. Cycle-safe via a
 * `WeakMap` visited set; recursion depth is bounded by `MAX_REDACT_DEPTH`
 * (defense against an attacker-controlled deeply-nested cause).
 *
 * Behavior:
 *  - Primitive `value` (string/number/boolean/null/undefined/bigint/symbol)
 *    → returned as-is.
 *  - `Uint8Array` (or any `ArrayBufferView`) at the TOP level → returned
 *    as-is. Redaction is FIELD-NAME-driven; a bare buffer doesn't carry
 *    a name, so we leave it alone. Buffers nested under a redacted-name
 *    field ARE redacted (and reported with byte length).
 *  - `Error` instance → CLONED into a new object with the same prototype
 *    (so `instanceof MyCustomError` still works downstream). `name`,
 *    `message`, `stack` are copied verbatim. `cause` recurses through the
 *    redactor. Own enumerable string-keyed properties are walked through
 *    `redactValue` recursively — keys in {@link REDACTED_FIELDS} get the
 *    marker. Symbol-keyed and non-enumerable properties are dropped (they
 *    don't appear in `Object.keys(...)`).
 *  - Plain `Array` → mapped element-by-element, preserving array-ness.
 *  - Plain object → property-by-property; keys in {@link REDACTED_FIELDS}
 *    are replaced with a redaction marker. Other keys recurse.
 *  - Recursion exceeds `MAX_REDACT_DEPTH` → that subtree becomes the
 *    string `'[REDACTED: depth-cap]'`. This is a defense against a
 *    pathological attacker-built cause; honest call sites don't approach
 *    the cap (default 32 levels).
 */
const MAX_REDACT_DEPTH = 32;

function redactionMarkerFor(field: string, value: unknown): string {
  if (value instanceof Uint8Array) {
    return `[REDACTED: ${field}(${value.byteLength}-bytes)]`;
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    'byteLength' in value &&
    typeof (value as { byteLength: unknown }).byteLength === 'number'
  ) {
    return `[REDACTED: ${field}(${(value as { byteLength: number }).byteLength}-bytes)]`;
  }
  if (typeof value === 'string') {
    return `[REDACTED: ${field}(${value.length}-chars)]`;
  }
  return `[REDACTED: ${field}]`;
}

function redactValue(
  value: unknown,
  visited: WeakMap<object, unknown>,
  depth: number,
): unknown {
  if (depth > MAX_REDACT_DEPTH) return '[REDACTED: depth-cap]';
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t !== 'object' && t !== 'function') return value; // primitive

  // Steelman crit #17: Error instances were previously passed through
  // identity-untouched. That bypassed the W40 redaction layer entirely
  // for any sensitive own-property attached to an Error (e.g.
  // `signedTransferTxBytes`). Now we CLONE the Error: same prototype
  // (so `err instanceof CustomError` still works), but enumerable own
  // properties are walked through the redactor.
  //
  // **Round 5 fix — hostile Proxy / throwing protocol traps.** A `Proxy`
  // can install a `getPrototypeOf` trap (or a `Symbol.hasInstance` trap
  // on its target's constructor) that throws. Both `value instanceof
  // Error` and `Object.getPrototypeOf(value)` invoke those traps and
  // propagate the throw out of `redactValue` itself, crashing the
  // SphereError constructor. Wrap each in try/catch so the redactor
  // fails closed: on throw, treat the value as non-Error (fall through
  // to the plain-object branch) and use `Error.prototype` as a safe
  // fallback prototype for clone construction.
  let isError = false;
  try {
    isError = value instanceof Error;
  } catch {
    // Hostile `Symbol.hasInstance` / `getPrototypeOf` trap threw.
    // Treat as non-Error and fall through to plain-object handling.
    isError = false;
  }
  if (isError) {
    const errObj = value as Error;
    const memoExisting = visited.get(errObj);
    if (memoExisting !== undefined) return memoExisting;
    // Preserve prototype identity. Object.create avoids re-running
    // a (potentially throwing) Error constructor.
    let proto: object | null;
    try {
      proto = Object.getPrototypeOf(errObj) as object | null;
    } catch {
      // Hostile `getPrototypeOf` trap threw. Fall back to the plain
      // Error.prototype so the clone retains base-class semantics.
      proto = Error.prototype;
    }
    const clone = Object.create(proto) as Record<string, unknown>;
    visited.set(errObj, clone);
    // Copy core Error properties verbatim — they are NOT walked through
    // the redactor because their value space is well-known. `name`,
    // `message`, `stack` are strings; `cause` is recursed.
    let errName: unknown;
    try {
      errName = errObj.name;
    } catch {
      errName = '[REDACTED: getter-threw]';
    }
    if (errName !== undefined) clone.name = errName;
    let errMessage: unknown;
    try {
      errMessage = errObj.message;
    } catch {
      errMessage = '[REDACTED: getter-threw]';
    }
    if (errMessage !== undefined) clone.message = errMessage;
    let errStack: unknown;
    try {
      errStack = errObj.stack;
    } catch {
      errStack = '[REDACTED: getter-threw]';
    }
    if (errStack !== undefined) clone.stack = errStack;
    let errCause: unknown;
    try {
      errCause = (errObj as { cause?: unknown }).cause;
    } catch {
      errCause = '[REDACTED: getter-threw]';
    }
    if (errCause !== undefined) {
      clone.cause = redactValue(errCause, visited, depth + 1);
    }
    // Walk own enumerable string-keyed properties. Symbol-keyed and
    // non-enumerable properties are intentionally dropped (they don't
    // appear in `Object.keys(...)`); this is the same shape as the
    // plain-object branch below.
    let keys: string[];
    try {
      keys = Object.keys(errObj);
    } catch {
      return clone;
    }
    for (const key of keys) {
      // Skip the standard Error trio — we already copied them above
      // (name/message/stack become own properties when assigned).
      if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause') {
        continue;
      }
      let v: unknown;
      try {
        v = (errObj as unknown as Record<string, unknown>)[key];
      } catch {
        clone[key] = '[REDACTED: getter-threw]';
        continue;
      }
      if (REDACTED_FIELDS_SET.has(key)) {
        clone[key] = redactionMarkerFor(key, v);
      } else {
        clone[key] = redactValue(v, visited, depth + 1);
      }
    }
    return clone;
  }

  // Buffers / typed arrays at the top level are passed through; only
  // fields named in REDACTED_FIELDS get the marker treatment. Top-level
  // bare buffers occasionally appear in tests of generic SphereError
  // shapes — leaving them alone keeps existing forensic-cause shapes
  // intact unless the caller embeds them under a redacted-name key.
  //
  // Round 5 fix — `value instanceof Uint8Array` also walks the prototype
  // chain via `Symbol.hasInstance` / `getPrototypeOf` and can be made to
  // throw by a hostile Proxy. Same try/catch closure as the Error check
  // above.
  let isU8 = false;
  try {
    isU8 = value instanceof Uint8Array;
  } catch {
    isU8 = false;
  }
  if (isU8) return value;
  let isArray = false;
  try {
    isArray = Array.isArray(value);
  } catch {
    isArray = false;
  }

  if (typeof value === 'object') {
    const obj = value as object;
    const memo = visited.get(obj);
    if (memo !== undefined) return memo;

    if (isArray) {
      const arr = obj as unknown[];
      const out: unknown[] = [];
      visited.set(obj, out);
      let len = 0;
      try {
        len = arr.length;
      } catch {
        len = 0;
      }
      for (let i = 0; i < len; i++) {
        let item: unknown;
        try {
          item = arr[i];
        } catch {
          item = '[REDACTED: getter-threw]';
        }
        out.push(redactValue(item, visited, depth + 1));
      }
      return out;
    }

    // Plain object: iterate own enumerable string keys.
    // Steelman fix: a hostile cause supplied via a Proxy with a
    // throwing getter (or any object that raises on property access)
    // would propagate the throw out of the SphereError constructor
    // itself, masking the original error context. Wrap every property
    // read in try/catch and substitute a marker on throw.
    const out: Record<string, unknown> = {};
    visited.set(obj, out);
    let keys: string[];
    try {
      keys = Object.keys(obj);
    } catch {
      return '[REDACTED: keys-threw]';
    }
    for (const key of keys) {
      let v: unknown;
      try {
        v = (obj as Record<string, unknown>)[key];
      } catch {
        out[key] = '[REDACTED: getter-threw]';
        continue;
      }
      if (REDACTED_FIELDS_SET.has(key)) {
        out[key] = redactionMarkerFor(key, v);
      } else {
        out[key] = redactValue(v, visited, depth + 1);
      }
    }
    return out;
  }

  return value;
}

/**
 * Deep-redact a `cause` value before it is attached to a `SphereError`.
 *
 * Exported for tests and for any caller that wants to pre-redact a value
 * before logging it independently of throwing. Production code should
 * rely on the `SphereError` constructor's automatic redaction rather than
 * calling this directly.
 */
export function redactCause(cause: unknown): unknown {
  if (cause === undefined) return undefined;
  return redactValue(cause, new WeakMap<object, unknown>(), 0);
}

export class SphereError extends Error {
  readonly code: SphereErrorCode;

  /**
   * Eagerly-redacted forensic payload, read-only. Field names listed in
   * {@link REDACTED_FIELDS} are replaced with opaque markers. The original
   * `cause` (if any) is NOT retained on the instance — by the time this
   * error exists, the original bytes are already gone.
   *
   * Aliased to the native `Error.cause` getter so Sentry / pino /
   * `util.inspect` / explicit `error.cause` reads all see the SAME redacted
   * view.
   */
  readonly context: unknown;

  constructor(message: string, code: SphereErrorCode, cause?: unknown) {
    const redacted = redactCause(cause);
    // Steelman³⁸ note: forward `redacted` (NOT the raw cause) to the native
    // Error constructor so `err.cause` walks (Sentry, util.inspect,
    // pino-pretty) see the redacted chain. Previously a redeclared
    // `readonly cause?: unknown` field shadowed the native getter, breaking
    // standard tooling. After T.8.C the native cause IS the redacted
    // payload; the `context` accessor below points at the same value.
    super(message, redacted !== undefined ? { cause: redacted } : undefined);
    this.name = 'SphereError';
    this.code = code;
    this.context = redacted;
  }
}

/**
 * Type guard to check if an error is a SphereError
 */
export function isSphereError(err: unknown): err is SphereError {
  return err instanceof SphereError;
}

/**
 * Lossy-safe stringification of an unknown error value (issue #191).
 *
 * The inline pattern `err instanceof Error ? err.message : String(err)`
 * collapses object-shaped errors to the default `Object.prototype.toString`
 * output (`'[object Object]'`), masking aggregator response payloads,
 * structured RPC errors, and any other non-Error throw value with useful
 * field-level forensics. NametagMinter's testnet failure surface is the
 * highest-visibility instance — operators saw `Submit failed: [object Object]`
 * with no way to distinguish rate-limit / API-key / faucet-exhausted /
 * validation-rejected outcomes.
 *
 * `errMessage` collapses to the same `Error.message` / `string` paths but
 * falls back to `JSON.stringify(redactCause(err))` for everything else,
 * routing through the W40 redaction layer so cryptographic-secret /
 * untrusted-payload fields never leak even on this debug path. The final
 * `String(err)` is the bottom of the stack for non-stringifiable values
 * (cycles that survive `redactCause`, BigInts in the redacted view, ...).
 *
 * @example
 *   errMessage(new Error('boom'))           // 'boom'
 *   errMessage('boom')                       // 'boom'
 *   errMessage({ status: 'BAD_REQUEST' })    // '{"status":"BAD_REQUEST"}'
 *   errMessage({ signedTransferTxBytes: u8 }) // '{"signedTransferTxBytes":"[REDACTED: signedTransferTxBytes(<n>-bytes)]"}'
 */
export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(redactCause(err));
  } catch {
    return String(err);
  }
}
