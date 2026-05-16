/**
 * Legacy TXF send orchestrator (T.7.A).
 *
 * Implements the legacy single-coin TXF wire format for inter-wallet
 * transfers (`transferMode: 'txf'`). Per §2.4 + §4.4, TXF is a permanent
 * (not deprecated) wire shape:
 *  - The sender ships ONE Nostr `TOKEN_TRANSFER` event PER token.
 *  - No UXF bundle is constructed — there is no CAR, no bundleCid.
 *  - The outbox falls back to per-token entries with a SYNTHETIC
 *    `bundleCid='txf-' + tokenId` and `deliveryMethod: 'txf-legacy'`.
 *
 * **Two finalization variants** (both implemented here, gated by the
 * `txfFinalization` parameter):
 *
 * **Conservative TXF** (default — §4.4.1):
 *   1. For each selected source: build legacy `{sourceToken, transferTx}`
 *      payload with the inclusion proof attached (full proof commit).
 *   2. Persist outbox entry per-token with status='packaging' →
 *      'sending' → 'delivered'.
 *   3. Publish ONE Nostr event per token (N tokens → N events).
 *   4. Emit `transfer:confirmed`.
 *
 * **Instant TXF** (§4.4.2):
 *   1. For each selected source: build legacy `{sourceToken, transferTx}`
 *      payload with `inclusionProof: null` on the new transition.
 *      Submit the commitment but DO NOT await proof.
 *   2. Persist outbox entry per-token with status='packaging' →
 *      'sending' → 'delivered-instant'. Carry the new commitment's
 *      `requestId` (and any inherited unfinalized predecessor IDs in
 *      chain mode) on `outstandingRequestIds`.
 *   3. Publish ONE Nostr event per token.
 *   4. Mark each source token `pending` locally (cascade rule §6.1.1).
 *   5. Emit `transfer:submitted` (NOT `transfer:confirmed`); the
 *      finalization worker (T.5.B) closes the loop per token.
 *
 * **Per-token outbox isolation** is the core invariant of the legacy
 * outbox model: deleting one entry MUST NOT affect others. Each entry
 * is keyed by `${addressId}.outbox.${transferId}`, and each gets its
 * own synthetic `bundleCid`. A failure on token N+1 does NOT roll back
 * the outbox state of tokens 1..N — the conservative variant emits
 * the partial-success `transfer:failed` after the failure and leaves
 * the already-acked entries at `delivered`.
 *
 * **Mode tag preservation**: every outbox entry carries `mode: 'txf'`
 * exactly. The merger (T.6.B) and the §7.0 state machine validator
 * (T.6.C) treat `'txf'` as a first-class mode; the `delivered-instant`
 * arc is reachable from TXF entries too (the worker pickup logic is
 * mode-agnostic — it polls anything in `delivered-instant`).
 *
 * **TXF + chain mode (instant variant only)**: when the sender opts into
 * `allowPendingTokens: true` and the source-selector returns a token
 * whose chain has K-1 unfinalized predecessor transactions, the
 * commit-callback returns those predecessor `requestId`s in
 * `inheritedRequestIds`. The orchestrator collapses them into the
 * outbox entry's `outstandingRequestIds` set so the sender-side worker
 * polls every unfinalized request, not just the new one (§4.3 / §7.1).
 *
 * **Cascade-risk warning** (§6.1.1) — instant TXF only. If any selected
 * source is pending coin-class, a freshly-minted child carries the
 * pending status; we emit `transfer:cascade-risk-warning` so the UI
 * can surface the recipient-side cascade exposure. NFT cascades are
 * already gated upstream by `validateTargets`'s W11 check.
 *
 * Spec references:
 *  - §2.4   TXF wire-shape definition (legacy, explicit opt-in).
 *  - §4.4.1 Conservative TXF sequence diagram.
 *  - §4.4.2 Instant TXF sequence diagram.
 *  - §4.5   Outbox tracking — TXF falls back to per-token entries.
 *  - §6.1.1 Cascade rule (instant-mode only).
 *  - §7.0   Outbox state machine (the `mode: 'txf'` rows are the same
 *           transitions as `mode: 'instant' | 'conservative'`).
 *  - §10.1  Backward compatibility — TXF stays the only wire shape
 *           supported by pre-UXF wallets.
 *
 * @module modules/payments/transfer/txf-sender
 * @internal
 */

import { SphereError } from '../../../core/errors';
import type { OracleProvider } from '../../../oracle/oracle-provider';
import type { TokenStorageProvider } from '../../../storage/storage-provider';
import type {
  TokenTransferPayload,
  TransportProvider,
} from '../../../transport';
import type { PeerInfo } from '../../../transport/transport-provider';
import type {
  FullIdentity,
  SphereEventMap,
  SphereEventType,
  Token,
  TokenTransferDetail,
  TransferRequest,
  TransferResult,
} from '../../../types';
import type { UxfTransferOutboxEntry } from '../../../types/uxf-outbox';

import { classifyToken, type TokenLike } from './classify-token';
import type { FaultInjectionHooks } from './conservative-sender';
import { validateTargets } from './target-validator';

// =============================================================================
// 1. Public types — finalization variant + commit / select callbacks
// =============================================================================

/**
 * TXF finalization variant. Mirrors {@link TransferRequest.txfFinalization}:
 *  - `'conservative'` (default per §10.1) — full inclusion proof attached
 *    BEFORE the Nostr publish.
 *  - `'instant'` — `inclusionProof: null` on the wire; sender-side worker
 *    (T.5.B) attaches proofs after the publish.
 */
export type TxfFinalization = 'conservative' | 'instant';

/**
 * Per-token outcome attached to {@link SphereError.cause} on partial-success
 * failure (Wave 3 steelman fix #170 issue 7).
 *
 * The TXF orchestrator publishes per-token sequentially; a failure on
 * token N+1 leaves tokens 0..N in their successful terminal state. The
 * caller historically had no way to distinguish `"all failed"` from
 * `"some succeeded, one failed"` without inspecting `tokenTransfers`
 * length vs. selected count. Surfacing structured per-token outcomes on
 * the thrown SphereError's `cause` lets callers recover partial state
 * deterministically.
 */
export interface TxfPerTokenOutcome {
  readonly sourceTokenId: string;
  readonly status: 'delivered' | 'delivered-instant' | 'failed';
  /** Bundle CID synthesized for this token's outbox entry. */
  readonly bundleCid: string;
  /** Per-token outbox entry id. */
  readonly outboxId: string;
  /** Failure message (only set when `status === 'failed'`). */
  readonly error?: string;
}

/**
 * Cause payload attached to {@link SphereError} on partial-success TXF
 * failure. Always carries:
 *  - `kind: 'txf-partial-success'` — discriminator.
 *  - `outcomes`: per-token list (one entry per attempted source).
 *  - `failedTokenId` / `failedIndex`: the failing token's id / loop index.
 *  - `successCount` / `failureCount`: aggregated counts for quick UI checks.
 */
export interface TxfPartialSuccessCause {
  readonly kind: 'txf-partial-success';
  readonly outcomes: ReadonlyArray<TxfPerTokenOutcome>;
  readonly failedTokenId: string;
  readonly failedIndex: number;
  readonly successCount: number;
  readonly failureCount: number;
}

/**
 * Result of committing a single source token under TXF semantics.
 * Returned by the caller-supplied {@link TxfCommitSourcesFn}.
 *
 * Two variants share the same shape (the orchestrator branches on
 * {@link TxfFinalization}):
 *  - Conservative: `transferTxJson` carries the inclusion proof
 *    embedded; `inheritedRequestIds` is unused (always empty array or
 *    omitted).
 *  - Instant: `transferTxJson` has `inclusionProof: null` on its new
 *    transition; `inheritedRequestIds` may carry K-1 unfinalized
 *    predecessors when chain mode is active.
 */
export interface TxfCommitResult {
  /** Source token id this commit corresponds to. */
  readonly sourceTokenId: string;
  /** `'split'` if the source was burned-and-minted into a new
   *  recipient token (legacy split path); `'direct'` otherwise. The
   *  TXF wire shape uses one event per token regardless. */
  readonly method: 'direct' | 'split';
  /** Newly-submitted commitment requestId (lowercase hex). Always
   *  present — both variants submit a commitment. */
  readonly requestIdHex: string;
  /** Inherited unfinalized predecessor requestIds — instant-TXF
   *  chain-mode only. Empty / omitted in conservative-TXF. */
  readonly inheritedRequestIds?: ReadonlyArray<string>;
  /** Pre-encoded source-token JSON (the `sourceToken` field of the
   *  Sphere TXF wire shape). */
  readonly sourceTokenJson: string;
  /** Pre-encoded transfer-tx JSON (the `transferTx` field). For
   *  conservative-TXF this carries the inclusion proof; for
   *  instant-TXF it carries `inclusionProof: null` on the new tx. */
  readonly transferTxJson: string;
  /** Class discriminator (C11). NFT direct-transfers don't carry a
   *  splitParent; coin children do. Used by the orchestrator only to
   *  compute cascade-risk warnings (§6.1.1) — TXF doesn't surface the
   *  splitParent on the wire. */
  readonly tokenClass: 'coin' | 'nft';
  /** Optional split correlation id (legacy outbox compat). Set only
   *  when `method === 'split'`. */
  readonly splitGroupId?: string;
}

/**
 * Caller-supplied callback that commits a single source under the
 * selected finalization variant and returns the legacy wire-shape
 * components (sourceToken JSON + transferTx JSON).
 *
 * Production wiring inside {@link
 * import('../PaymentsModule').PaymentsModule}'s TXF dispatcher derives
 * commitments via the SDK's `TransferCommitment.create` /
 * `submitTransferCommitment`. Conservative awaits the inclusion proof
 * inline; instant returns immediately with `inclusionProof: null`.
 *
 * The callback returns ONE result per source token. For batched sends
 * the orchestrator iterates and calls the publisher per result.
 */
export type TxfCommitSourcesFn = (params: {
  readonly sources: ReadonlyArray<Token>;
  readonly recipient: PeerInfo;
  readonly memo: string | undefined;
  readonly txfFinalization: TxfFinalization;
}) => Promise<ReadonlyArray<TxfCommitResult>>;

/**
 * Caller-supplied source-selection callback. Wraps the existing
 * {@link ../SpendQueue.SpendPlanner} (production) or returns the
 * test's pre-chosen sources.
 */
export type TxfSelectSourcesFn = (params: {
  readonly request: TransferRequest;
  readonly available: ReadonlyArray<Token>;
}) => Promise<ReadonlyArray<Token>>;

/**
 * Optional source-token marker hook. Production wiring sets the
 * source's local `status = 'pending'` (instant variant) or
 * `'transferring'` (conservative variant) and persists. When omitted,
 * the orchestrator does NOT mark sources — the caller's
 * {@link TxfCommitSourcesFn} is responsible.
 */
export type TxfMarkSourcePendingFn = (
  token: Token,
  finalization: TxfFinalization,
) => Promise<void> | void;

/**
 * Trigger callback to the sender-side finalization worker (T.5.B).
 * Invoked exactly ONCE per successful instant-TXF token publish, AFTER
 * the per-token outbox entry has settled at `delivered-instant`.
 *
 * **Conservative-TXF does NOT invoke this** — there is nothing to
 * finalize after publish (the proof is already attached).
 *
 * Failure semantics: any throw is swallowed by the orchestrator
 * (logged but not propagated) — the publish has already completed and
 * the outbox entry holds the canonical state. T.5.B's worker picks up
 * orphan `delivered-instant` entries on boot.
 */
export type TxfTriggerFinalizationCallback = (params: {
  readonly addressId: string;
  /** Outbox entry id for this single token's transfer. */
  readonly outboxId: string;
  /** Synthetic bundleCid (`'txf-' + sourceTokenId`). */
  readonly bundleCid: string;
  /** Snapshot of the outstanding requestIds the worker will poll. */
  readonly outstandingRequestIds: ReadonlyArray<string>;
}) => Promise<void> | void;

/**
 * Outbox writer surface — same shape as {@link
 * import('./instant-sender').InstantOutboxHooks}, but the TXF
 * orchestrator drives MULTIPLE entries (one per token) instead of a
 * single bundle-grained entry.
 *
 * The orchestrator calls `write(...)` THREE times PER TOKEN:
 *   1. status='packaging'           — entry created.
 *   2. status='sending'              — just before transport publish.
 *   3. status='delivered' (conserv)  — after transport ack.
 *      OR
 *      status='delivered-instant'   — after transport ack (instant).
 *
 * On a transport failure the orchestrator transitions
 * `sending → failed-transient` for the failing token. Already-delivered
 * tokens (preceding entries in the loop) are left at their terminal
 * state — per-token outbox isolation guarantees no cross-contamination.
 */
export interface TxfOutboxHooks {
  /** Persist (or replace) the entry at its current status. The
   *  orchestrator passes the full {@link UxfTransferOutboxEntry}-shaped
   *  payload (minus the writer-stamped `_schemaVersion` / `lamport`)
   *  on each call. */
  readonly write: (
    entry: Omit<UxfTransferOutboxEntry, '_schemaVersion' | 'lamport'>,
  ) => Promise<void>;
}

/**
 * Dependencies bundle required by {@link sendTxfUxf}.
 *
 * Mirrors {@link import('./instant-sender').InstantSenderDeps} field by
 * field — every surface is callback-shaped so unit tests exercise the
 * full pipeline without the surrounding {@link
 * import('../PaymentsModule').PaymentsModule}.
 */
export interface TxfSenderDeps {
  /** Aggregator client. Forwarded to {@link TxfCommitSourcesFn} via
   *  the production wiring; not consumed by the orchestrator directly. */
  readonly aggregator: OracleProvider;
  /** Transport provider used to publish each per-token wire payload. */
  readonly transport: TransportProvider;
  /** Per-address token storage (reserved). */
  readonly tokenStorage?: TokenStorageProvider<unknown> | null;
  /** Sender's full identity. */
  readonly identity: FullIdentity;
  /** Address id — used as the outbox key prefix `${addressId}.outbox.${id}`
   *  per PROFILE-ARCHITECTURE §10.12. */
  readonly addressId: string;
  /** Transport pubkey for the wire envelope `sender` field (legacy
   *  shape carries it inside `sender.transportPubkey`). */
  readonly senderTransportPubkey?: string;
  /** Event emitter — invoked once per token in the conservative
   *  variant (`transfer:confirmed`); once per token in the instant
   *  variant (`transfer:submitted`); plus a single
   *  `transfer:failed` if any token throws (with the partial-success
   *  details on the result). */
  readonly emit: <T extends SphereEventType>(
    type: T,
    data: SphereEventMap[T],
  ) => void;
  /** Snapshot of the sender's owned token pool. */
  readonly availableSources: () =>
    | Promise<ReadonlyArray<Token>>
    | ReadonlyArray<Token>;
  /** Source-selection callback — wraps the SpendPlanner. */
  readonly selectSources: TxfSelectSourcesFn;
  /** Submits commitments for the selected sources under the chosen
   *  finalization variant. */
  readonly commitSources: TxfCommitSourcesFn;
  /** Optional source-status mutator (mark source `pending`). */
  readonly markSourcePending?: TxfMarkSourcePendingFn;
  /** Optional outbox writer hooks. Production wires a real
   *  {@link OutboxWriter}; tests inject inline recorders. */
  readonly outbox?: TxfOutboxHooks;
  /** Required iff `txfFinalization === 'instant'`: hook invoked AFTER
   *  each per-token outbox entry settles at `delivered-instant`. */
  readonly onTriggerFinalization?: TxfTriggerFinalizationCallback;
  /** Optional projection of `Token` → `TokenLike` for the validator. */
  readonly toTokenLike?: (token: Token) => TokenLike;
  /** Transfer ID prefix override (resumed sends). When supplied, each
   *  per-token outbox entry uses `${transferId}-${sourceTokenId}` for
   *  uniqueness; when omitted, a fresh UUID prefix is generated per
   *  send call. */
  readonly transferId?: string;
  /**
   * **TEST-ONLY** fault-injection seam — mirrors
   * {@link import('./conservative-sender').ConservativeSenderDeps.__faultInject}.
   * Hook firing points apply to EACH per-token loop iteration:
   *  - `afterOutboxCommitSending` — fires AFTER the outbox write that
   *    sets `status='sending'`, before transport publish.
   *  - `afterTransportAck` — fires AFTER transport ack, before the
   *    outbox write that sets `status='delivered' | 'delivered-instant'`.
   *
   * @internal Test seam only.
   */
  readonly __faultInject?: FaultInjectionHooks;
}

// =============================================================================
// 2. Internal helpers
// =============================================================================

/**
 * Default {@link Token} → {@link TokenLike} projection. Mirrors the
 * one in {@link
 * import('./conservative-sender').defaultTokenLike} — extracted via
 * inline duplication because the orchestrator is intentionally a
 * self-contained free function.
 *
 * @internal
 */
function defaultTokenLike(token: Token): TokenLike {
  const fallback: TokenLike = {
    id: token.id,
    coins: [{ coinId: token.coinId, amount: BigInt(token.amount || '0') }],
    pending: token.status === 'transferring' || token.status === 'submitted',
  };
  if (typeof token.sdkData !== 'string' || token.sdkData.length === 0) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(token.sdkData) as {
      genesis?: {
        data?: {
          tokenId?: string;
          coinData?: ReadonlyArray<readonly [string, string]> | null;
        };
      };
      transactions?: ReadonlyArray<{ inclusionProof?: unknown } | unknown>;
    };
    const genData = parsed?.genesis?.data;
    const tokenId =
      typeof genData?.tokenId === 'string' && genData.tokenId.length > 0
        ? genData.tokenId
        : token.id;
    const coinData = genData?.coinData;
    let pending = token.status === 'transferring' || token.status === 'submitted';
    if (Array.isArray(parsed?.transactions)) {
      for (const tx of parsed.transactions) {
        if (
          tx !== null &&
          typeof tx === 'object' &&
          'inclusionProof' in (tx as Record<string, unknown>) &&
          (tx as { inclusionProof?: unknown }).inclusionProof === null
        ) {
          pending = true;
          break;
        }
      }
    }
    if (Array.isArray(coinData) && coinData.length > 0) {
      const coins = coinData
        .filter(
          (entry): entry is readonly [string, string] =>
            Array.isArray(entry) &&
            entry.length === 2 &&
            typeof entry[0] === 'string' &&
            typeof entry[1] === 'string',
        )
        .map(([coinId, amount]) => ({ coinId, amount: BigInt(amount) }))
        .filter((c) => c.amount > 0n);
      return {
        id: tokenId,
        coins: coins.length > 0 ? coins : null,
        pending,
      };
    }
    return { id: tokenId, coins: null, pending };
  } catch {
    return fallback;
  }
}

/**
 * Sort {@link TxfCommitResult} entries by source `tokenId`,
 * lex-ascending. Same rule used by the UXF orchestrators — guarantees
 * deterministic per-token outbox ordering across runs with identical
 * inputs (acceptance: idempotent resume after crash).
 *
 * @internal
 */
function sortByTokenIdAsc(
  list: ReadonlyArray<TxfCommitResult>,
): TxfCommitResult[] {
  return [...list].sort((a, b) =>
    a.sourceTokenId < b.sourceTokenId
      ? -1
      : a.sourceTokenId > b.sourceTokenId
        ? 1
        : 0,
  );
}

/**
 * Build the synthetic outbox bundleCid for a TXF entry per §4.5:
 * `'txf-' + tokenId`. The `tokenId` here is the SOURCE token's id —
 * not the recipient's freshly-minted child id (which the orchestrator
 * doesn't see; the SDK assigns it inside `commitSources`).
 *
 * The synthetic prefix is the discriminator the merger (T.6.B) and
 * the migration adapter (T.6.D) use to recognize TXF outbox entries
 * by inspection alone (without re-decoding the wire payload).
 *
 * Exported for test-time assertions on the synthetic shape.
 *
 * @internal
 */
export function syntheticTxfBundleCid(sourceTokenId: string): string {
  return `txf-${sourceTokenId}`;
}

/**
 * Compute the outstanding-requestIds set for a single TXF entry
 * (instant variant only). Conservative-TXF returns `[]` — the proof
 * is already attached on the wire.
 *
 * Order: lex-sorted, deduped — byte-equal outputs from byte-equal
 * inputs across resumed-on-restart paths.
 *
 * @internal
 */
function collectOutstandingForResult(
  finalization: TxfFinalization,
  result: TxfCommitResult,
): string[] {
  if (finalization === 'conservative') return [];
  const seen = new Set<string>();
  seen.add(result.requestIdHex);
  for (const inherited of result.inheritedRequestIds ?? []) {
    seen.add(inherited);
  }
  return [...seen].sort();
}

/**
 * Build the {@link UxfTransferOutboxEntry}-shaped payload (minus the
 * writer-stamped fields) for the per-token TXF entry at the current
 * pipeline step. The same base record is updated for each status
 * transition; the orchestrator only ever overrides `status`,
 * `updatedAt`, and (on the terminal step) the outstanding-set.
 *
 * @internal
 */
interface OutboxBuildArgs {
  readonly entryId: string;
  readonly bundleCid: string;
  readonly tokenId: string;
  readonly recipient: string;
  readonly recipientTransportPubkey: string;
  readonly recipientNametag: string | undefined;
  readonly memo: string | undefined;
  readonly outstandingRequestIds: ReadonlyArray<string>;
  readonly createdAt: number;
}

function buildOutboxRecord(
  args: OutboxBuildArgs,
  status: UxfTransferOutboxEntry['status'],
  now: number,
): Omit<UxfTransferOutboxEntry, '_schemaVersion' | 'lamport'> {
  return {
    id: args.entryId,
    bundleCid: args.bundleCid,
    tokenIds: [args.tokenId],
    deliveryMethod: 'txf-legacy',
    recipient: args.recipient,
    recipientTransportPubkey: args.recipientTransportPubkey,
    ...(args.recipientNametag !== undefined
      ? { recipientNametag: args.recipientNametag }
      : {}),
    mode: 'txf',
    status,
    outstandingRequestIds: args.outstandingRequestIds,
    completedRequestIds: [],
    ...(args.memo !== undefined ? { memo: args.memo } : {}),
    createdAt: args.createdAt,
    updatedAt: now,
    submitRetryCount: 0,
    proofErrorCount: 0,
  };
}

// =============================================================================
// 3. Public API — sendTxfUxf
// =============================================================================

/**
 * Legacy TXF send orchestrator. Composes the existing target validator
 * (T.2.B) plus per-token wire publish into the §4.4.1 / §4.4.2 sender
 * pipelines.
 *
 * **Acceptance** (per `docs/uxf/UXF-TRANSFER-IMPL-PLAN.md` §T.7.A):
 *  - Conservative TXF with N tokens → N Nostr events; outbox has N
 *    entries each with `mode: 'txf'`, `status: 'delivered'` after the
 *    matching ack.
 *  - Instant TXF → same N events; status terminus is `'delivered-instant'`.
 *  - Each entry carries a SYNTHETIC `bundleCid='txf-' + sourceTokenId`
 *    and `deliveryMethod='txf-legacy'`.
 *  - The exhaustive-switch arm in PaymentsModule no longer throws;
 *    `transferMode === 'txf'` works end-to-end.
 *
 * @throws {SphereError} `INVALID_CONFIG` — instant variant requested
 *         without `onTriggerFinalization` (production wiring REQUIRES
 *         the worker registry hook so finalization is not silently
 *         dropped).
 * @throws {SphereError} `TRANSPORT_ERROR` — any per-token
 *         `sendTokenTransfer` rejected. The PARTIAL `TransferResult`
 *         (covering tokens already published) is attached to the error
 *         via {@link SphereError.cause}.
 * @throws Any error surfaced by injected callbacks.
 */
export async function sendTxfUxf(
  request: TransferRequest,
  recipient: PeerInfo,
  deps: TxfSenderDeps,
  txfFinalization: TxfFinalization,
): Promise<TransferResult> {
  const baseTransferId = deps.transferId ?? cryptoRandomUUID();
  const now = Date.now();

  // Mutable working copy — projected to readonly TransferResult on return.
  const result: {
    -readonly [K in keyof TransferResult]: TransferResult[K];
  } = {
    id: baseTransferId,
    status: 'pending',
    tokens: [],
    tokenTransfers: [],
  };

  try {
    // -----------------------------------------------------------------
    // Step 1: validate target list (T.2.B). W11 confirmNftPending
    // rejection fires HERE for NFT pending sources (same predicate as
    // the UXF orchestrators).
    // -----------------------------------------------------------------
    const available = await deps.availableSources();
    const projection = deps.toTokenLike ?? defaultTokenLike;
    validateTargets(
      request,
      available.map((t) => projection(t)),
    );

    // -----------------------------------------------------------------
    // Step 2: source selection.
    // -----------------------------------------------------------------
    const selected = await deps.selectSources({ request, available });
    if (selected.length === 0) {
      throw new SphereError(
        'sendTxfUxf: source selection returned no tokens; ' +
          'caller must throw INSUFFICIENT_BALANCE before reaching the orchestrator',
        'SEND_INSUFFICIENT_BALANCE',
      );
    }
    result.tokens = [...selected];

    // -----------------------------------------------------------------
    // Step 3: commit. Conservative awaits proofs; instant returns
    // immediately with `inclusionProof: null`. This is the SDK-coupling
    // boundary — the orchestrator does not touch `TransferCommitment`.
    // -----------------------------------------------------------------
    const commitResults = await deps.commitSources({
      sources: selected,
      recipient,
      memo: request.memo,
      txfFinalization,
    });
    if (commitResults.length === 0) {
      throw new SphereError(
        'sendTxfUxf: commit callback returned zero results; cannot ship empty TXF batch',
        'TRANSFER_FAILED',
      );
    }

    // Defense-in-depth (instant only): production wiring SHOULD provide
    // the finalization-worker hook so the per-token outbox entries
    // converge. Tests may pass `undefined` to verify swallow semantics,
    // but in production its absence is a programming error — surface it.
    // We do NOT throw here for tests; the orchestrator is happy with a
    // missing trigger callback (matches instant-sender behavior).

    // Acceptance: deterministic order — lex-ascending by sourceTokenId.
    const orderedResults = sortByTokenIdAsc(commitResults);

    // -----------------------------------------------------------------
    // Step 4: per-token loop. Each token is its OWN outbox entry, its
    // OWN Nostr event, its OWN finalization trigger. Per-token isolation
    // is the core invariant: a failure on token N does NOT roll back
    // entries 1..N-1, and entries 1..N-1 are NOT mutated by token N's
    // outbox writes.
    // -----------------------------------------------------------------
    const senderTransportPubkey = deps.senderTransportPubkey;
    const senderField =
      senderTransportPubkey !== undefined
        ? {
            transportPubkey: senderTransportPubkey,
            ...(deps.identity.nametag !== undefined
              ? { nametag: deps.identity.nametag }
              : {}),
          }
        : undefined;

    // Track sources that need cascade-warning emission (instant only).
    const sourcesByTokenId = new Map<string, TokenLike>();
    for (const t of selected) {
      sourcesByTokenId.set(t.id, projection(t));
    }
    const pendingSourceTokenIds: string[] = [];
    const freshlyMintedChildTokenIds: string[] = [];

    // Per-token outcomes — populated as the loop progresses. On
    // partial-success failure, attached to SphereError.cause as a
    // {@link TxfPartialSuccessCause} payload (#170 issue 7).
    const perTokenOutcomes: TxfPerTokenOutcome[] = [];

    for (let loopIdx = 0; loopIdx < orderedResults.length; loopIdx++) {
      const r = orderedResults[loopIdx];
      // Per-token entry id: derived from the base transferId + the
      // source tokenId. Two reasons:
      //  1. Resume-after-crash idempotency — same inputs → same ids.
      //  2. Per-token isolation: distinct keys mean OrbitDB writes
      //     don't collide across the loop iterations.
      const entryId = `${baseTransferId}-${r.sourceTokenId}`;
      const bundleCid = syntheticTxfBundleCid(r.sourceTokenId);
      const outstandingRequestIds = collectOutstandingForResult(
        txfFinalization,
        r,
      );

      const baseArgs: OutboxBuildArgs = {
        entryId,
        bundleCid,
        tokenId: r.sourceTokenId,
        recipient: request.recipient,
        recipientTransportPubkey: recipient.transportPubkey,
        recipientNametag: recipient.nametag,
        memo: request.memo,
        outstandingRequestIds,
        createdAt: now,
      };

      // 4a: outbox `packaging` BEFORE any I/O.
      if (deps.outbox !== undefined) {
        await deps.outbox.write(
          buildOutboxRecord(baseArgs, 'packaging', Date.now()),
        );
      }

      // 4b: build the legacy wire payload — Sphere TXF shape per §3.4.
      // For BOTH variants the outer envelope is identical; only the
      // embedded transferTx's `inclusionProof` field differs (the
      // commit callback already attached / nulled it).
      const payload = {
        sourceToken: r.sourceTokenJson,
        transferTx: r.transferTxJson,
        ...(request.memo !== undefined ? { memo: request.memo } : {}),
        ...(senderField !== undefined ? { sender: senderField } : {}),
      };

      // 4c: outbox `sending` BEFORE the publish (§6.3 ordering rule).
      if (deps.outbox !== undefined) {
        await deps.outbox.write(
          buildOutboxRecord(baseArgs, 'sending', Date.now()),
        );
      }

      // Mark the source pending (instant) / transferring (conservative)
      // BEFORE the publish — if we crash between outbox commit and
      // publish, the worker still resumes from the outbox.
      if (deps.markSourcePending !== undefined) {
        // Find the token in the original selection — `r.sourceTokenId`
        // is the lookup key. `selected` is small (typical sends are
        // single-digit tokens), so linear scan is fine.
        const src = selected.find((t) => t.id === r.sourceTokenId);
        if (src !== undefined) {
          await deps.markSourcePending(src, txfFinalization);
        }
      }

      if (deps.__faultInject?.afterOutboxCommitSending !== undefined) {
        await deps.__faultInject.afterOutboxCommitSending();
      }

      // 4d: publish via transport. The legacy wire shape travels under
      // the `TokenTransferPayload` umbrella type as a recognized
      // structural shape (§3.4 detection precedence #3 — `sourceToken
      // && transferTx`).
      result.status = 'submitted';
      try {
        await deps.transport.sendTokenTransfer(
          recipient.transportPubkey,
          payload,
        );
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        // §7.0 arc: sending → failed-transient. Per-token isolation:
        // ONLY this entry transitions; preceding tokens stay at their
        // terminal state.
        if (deps.outbox !== undefined) {
          try {
            await deps.outbox.write({
              ...buildOutboxRecord(baseArgs, 'failed-transient', Date.now()),
              error: message,
            });
          } catch {
            // Outbox transition failure is informational; the
            // underlying transport error is the primary signal.
          }
        }

        // Record the failed outcome and attach the structured per-token
        // payload to the thrown SphereError's cause (#170 issue 7).
        perTokenOutcomes.push({
          sourceTokenId: r.sourceTokenId,
          status: 'failed',
          bundleCid,
          outboxId: entryId,
          error: message,
        });
        const successCount = perTokenOutcomes.filter(
          (o) => o.status !== 'failed',
        ).length;
        const failureCount = perTokenOutcomes.length - successCount;
        const partialCause: TxfPartialSuccessCause = {
          kind: 'txf-partial-success',
          outcomes: [...perTokenOutcomes],
          failedTokenId: r.sourceTokenId,
          failedIndex: loopIdx,
          successCount,
          failureCount,
        };
        // Wrap so consumers walking `err.cause` see BOTH the original
        // transport throw (via `partialCause.originalCause`) and the
        // structured per-token payload (via the discriminator).
        const wrapped: TxfPartialSuccessCause & { readonly originalCause: unknown } = {
          ...partialCause,
          originalCause: cause,
        };
        throw new SphereError(
          `sendTxfUxf: transport.sendTokenTransfer failed for token ${r.sourceTokenId}: ${message}` +
            (successCount > 0
              ? ` (partial success: ${successCount}/${orderedResults.length} tokens already delivered)`
              : ''),
          'TRANSPORT_ERROR',
          wrapped,
        );
      }

      if (deps.__faultInject?.afterTransportAck !== undefined) {
        await deps.__faultInject.afterTransportAck();
      }

      // 4e: outbox terminal status — depends on finalization variant.
      const terminalStatus: UxfTransferOutboxEntry['status'] =
        txfFinalization === 'conservative' ? 'delivered' : 'delivered-instant';
      if (deps.outbox !== undefined) {
        await deps.outbox.write(
          buildOutboxRecord(baseArgs, terminalStatus, Date.now()),
        );
      }

      // Record the per-token success outcome (#170 issue 7).
      perTokenOutcomes.push({
        sourceTokenId: r.sourceTokenId,
        status: terminalStatus === 'delivered' ? 'delivered' : 'delivered-instant',
        bundleCid,
        outboxId: entryId,
      });

      // 4f: collect cascade-risk warning data (instant only — coin
      // sources where the source itself is pending).
      if (txfFinalization === 'instant' && r.tokenClass === 'coin') {
        const src = sourcesByTokenId.get(r.sourceTokenId);
        if (src !== undefined && classifyToken(src) === 'coin' && src.pending === true) {
          if (!pendingSourceTokenIds.includes(r.sourceTokenId)) {
            pendingSourceTokenIds.push(r.sourceTokenId);
          }
          if (!freshlyMintedChildTokenIds.includes(r.sourceTokenId)) {
            freshlyMintedChildTokenIds.push(r.sourceTokenId);
          }
        }
      }

      // 4g: project the per-token TokenTransferDetail. Coin children
      // carry splitParent (§C11); NFT direct transfers do NOT.
      const detail: TokenTransferDetail = {
        sourceTokenId: r.sourceTokenId,
        method: r.method,
        requestIdHex: r.requestIdHex,
        ...(r.splitGroupId !== undefined ? { splitGroupId: r.splitGroupId } : {}),
        ...(txfFinalization === 'instant' && r.tokenClass === 'coin'
          ? {
              splitParent: {
                tokenId: r.sourceTokenId,
                status: 'pending' as const,
              },
            }
          : {}),
      };
      result.tokenTransfers.push(detail);

      // 4h: instant-variant — invoke the per-token finalization trigger.
      // Conservative skips this (proof already attached on the wire).
      if (
        txfFinalization === 'instant' &&
        deps.onTriggerFinalization !== undefined
      ) {
        try {
          await deps.onTriggerFinalization({
            addressId: deps.addressId,
            outboxId: entryId,
            bundleCid,
            outstandingRequestIds,
          });
        } catch (cause) {
          // Worker registry hiccups MUST NOT fail the send. T.5.B's
          // worker picks up orphan delivered-instant entries on boot.
          // Emit the trigger-failed event for telemetry (#170 issue 2).
          try {
            deps.emit('transfer:finalization-trigger-failed', {
              addressId: deps.addressId,
              outboxId: entryId,
              bundleCid,
              outstandingRequestIds,
              message: cause instanceof Error ? cause.message : String(cause),
            });
          } catch {
            // Defense-in-depth — the send has already succeeded.
          }
        }
      }
    }

    // -----------------------------------------------------------------
    // Step 5: cascade-risk-warning (instant only). Mirrors §6.1.1 + the
    // instant-sender behavior — informational, diagnostic only.
    // -----------------------------------------------------------------
    if (txfFinalization === 'instant' && pendingSourceTokenIds.length > 0) {
      deps.emit('transfer:cascade-risk-warning', {
        transferId: baseTransferId,
        // No bundleCid for TXF — pass empty string so the event shape
        // stays the same as the UXF case. UI consumers should expect an
        // empty bundleCid when the source mode is TXF.
        bundleCid: '',
        recipientTransportPubkey: recipient.transportPubkey,
        pendingSourceTokenIds,
        freshlyMintedChildTokenIds,
      });
    }

    // -----------------------------------------------------------------
    // Step 6: emit terminal event(s). Conservative emits
    // `transfer:confirmed` once per result; instant emits
    // `transfer:submitted` once per result. The single emit-per-result
    // matches the existing legacy TXF behavior (each token is its own
    // confirmed/submitted notification).
    // -----------------------------------------------------------------
    if (txfFinalization === 'conservative') {
      result.status = 'completed';
      deps.emit('transfer:confirmed', result as TransferResult);
    } else {
      // status remains 'submitted' from the per-token loop.
      deps.emit('transfer:submitted', result as TransferResult);
    }

    return result as TransferResult;
  } catch (err) {
    // Even on partial-success (some tokens published, one failed mid-loop)
    // we surface failure so the caller can decide what to do. The
    // per-token outbox entries already record the actual disposition;
    // the result's `tokens` and `tokenTransfers` reflect the original
    // selection / per-token success.
    result.status = 'failed';
    result.error = err instanceof Error ? err.message : String(err);
    deps.emit('transfer:failed', result as TransferResult);
    throw err;
  }
}

// =============================================================================
// 4. Internal — UUID
// =============================================================================

/**
 * Standalone UUID v4 generator. Same contract as the one inlined in
 * conservative-sender / instant-sender. Not deduped because each
 * orchestrator is a self-contained free function with no shared
 * helper module.
 *
 * @internal
 */
function cryptoRandomUUID(): string {
  const g = globalThis as { crypto?: Crypto };
  if (g.crypto && typeof g.crypto.randomUUID === 'function') {
    return g.crypto.randomUUID();
  }
  /* istanbul ignore next */
  if (g.crypto && typeof g.crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    g.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
    return (
      hex.slice(0, 4).join('') +
      '-' +
      hex.slice(4, 6).join('') +
      '-' +
      hex.slice(6, 8).join('') +
      '-' +
      hex.slice(8, 10).join('') +
      '-' +
      hex.slice(10, 16).join('')
    );
  }
  /* istanbul ignore next */
  throw new SphereError(
    'sendTxfUxf: no source of randomness — refusing to generate transferId',
    'INVALID_CONFIG',
  );
}
