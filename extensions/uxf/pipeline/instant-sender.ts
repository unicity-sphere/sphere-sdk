/**
 * Instant-mode UXF send orchestrator (T.5.A).
 *
 * The instant-mode counterpart of {@link sendConservativeUxf}. Where the
 * conservative pipeline blocks on inclusion proofs BEFORE publishing the
 * Nostr bundle (§2.2), the instant pipeline ships the bundle AS SOON AS
 * the aggregator has accepted the commitments — proofs are filled in by
 * a sender-side finalization worker (T.5.B) AFTER the publish.
 *
 * **Pipeline differences vs. conservative-sender** (per §2.1, §6.1):
 *   1. NO preflight finalize — instant mode permits unfinalized
 *      predecessors in the source chain (chain-mode framing per §2.3).
 *   2. {@link CommitSourcesFn} returns commitments WITHOUT inclusion
 *      proofs. The orchestrator collects every `requestId` (the new
 *      transition's ID, plus any K-1 inherited unfinalized predecessor
 *      IDs from chain-mode sources) and persists them under the outbox
 *      entry's `outstandingRequestIds` field per §4.3 / §7.1.
 *   3. Source tokens are marked `pending` locally; T.5.B's worker
 *      attaches proofs and transitions them to `valid`.
 *   4. UXF bundle is built with `inclusionProof: null` on every transfer
 *      transaction. The recipient's instant-mode reader (T.5.D) walks
 *      the same chain when proofs eventually land.
 *   5. Outbox status terminus is `delivered-instant` (NOT `delivered`),
 *      flagging the entry for finalization-worker pickup.
 *   6. Emits `transfer:submitted` (NOT `transfer:confirmed`) — the
 *      latter fires only AFTER the finalization worker confirms every
 *      proof has landed locally.
 *   7. Coin children carry {@link TokenTransferDetail.splitParent} per
 *      C11; NFT direct transfers do NOT (whole-token transfer preserves
 *      `tokenId`).
 *
 * **Outbox status timeline** (per §7.0 transition table):
 *
 *     create → packaging
 *              ├── (CID branch) → pinned → sending → delivered-instant
 *              └── (inline)              → sending → delivered-instant
 *
 *     // T.5.B's worker resumes from delivered-instant:
 *     delivered-instant → finalizing → finalized | failed-permanent | failed-transient
 *
 * **Trigger callback to T.5.B**. The orchestrator does NOT instantiate
 * the worker. It calls back to the parent ({@link InstantSenderDeps.onTriggerFinalization})
 * AFTER the outbox entry has settled at `delivered-instant`. The parent
 * (PaymentsModule wiring) hands the `(addressId, outboxId)` pair to its
 * worker registry. T.5.B will land the worker; this hook keeps the
 * orchestrator decoupled from worker lifecycle.
 *
 * Spec references:
 *  - §2.1   Instant mode definition.
 *  - §2.3   Chain-mode framing — K unfinalized predecessors in sources.
 *  - §4.3   Outstanding/completed two-set form (CRDT-safe partition).
 *  - §6.1   Sender-side worker semantics (post-publish finalization).
 *  - §6.1.1 Cascade rule — pending source → pending child (NFT and coin).
 *  - §7.0   Outbox state machine.
 *  - §7.1   CRDT invariants — Lamport bump, two-set requestIds, override
 *           stickiness.
 *
 * @module modules/payments/transfer/instant-sender
 * @internal
 */

import { SphereError } from '../../../core/errors';
import { logger } from '../../../core/logger';
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
import type {
  DeliveryStrategy,
  UxfTransferPayloadCar,
  UxfTransferPayloadCid,
} from '../types/uxf-transfer';
import type { UxfTransferOutboxEntry } from '../types/uxf-outbox';
import { UxfPackage } from '../bundle/UxfPackage';
import { extractCarRootCid } from '../bundle/transfer-payload';

import { classifyToken, type TokenLike } from './classify-token';
import type { FaultInjectionHooks } from './conservative-sender';
import type { PublishToIpfsCallback } from './delivery-resolver';
import { resolveDelivery } from './delivery-resolver';
import {
  AUTOMATED_CID_DELIVERY_ENABLED,
  MAX_INLINE_CAR_BYTES,
  RELAY_SAFE_CAP_BYTES,
} from './limits';
import { enforceOverTransferGuard } from './over-transfer-guard';
import { validateTargets, type ValidatedTargets } from './target-validator';

// =============================================================================
// 1. Public types — commit + select callbacks, deps, return value
// =============================================================================

/**
 * Result of submitting a single source token's commitment for instant
 * mode. Returned by the caller-supplied {@link InstantCommitSourcesFn}.
 *
 * The shape mirrors {@link
 * import('./conservative-sender').ConservativeCommitResult} except for
 * three instant-specific fields:
 *
 *  - `inheritedRequestIds` — chain-mode (§2.3) sources may have K > 1
 *    unfinalized predecessor transactions. Their `requestId`s flow into
 *    the outbox entry's `outstandingRequestIds` set (the new transition's
 *    `requestIdHex` is implicit in the same set). Empty for K=1
 *    finalized-history sources.
 *  - `tokenClass` — `'coin'` or `'nft'`, computed by the caller from the
 *    canonical {@link classifyToken} predicate. Determines whether
 *    {@link TokenTransferDetail.splitParent} is set on the result (C11).
 *  - `splitParentTokenId` — the parent (source) `tokenId` whose burn
 *    produced the coin child. REQUIRED when `tokenClass === 'coin'`;
 *    forbidden when `tokenClass === 'nft'` (whole-token transfer).
 */
export interface InstantCommitResult {
  readonly sourceTokenId: string;
  readonly method: 'direct' | 'split';
  /** Newly-submitted commitment requestId (lowercase hex). Always
   *  present — instant mode publishes after submit, so every commit has
   *  exactly one fresh requestId. */
  readonly requestIdHex: string;
  /** Inherited unfinalized predecessor requestIds (§2.3 chain mode).
   *  Order does not matter — the outbox writer dedupes / serializes. */
  readonly inheritedRequestIds?: ReadonlyArray<string>;
  /** SDK-format token JSON to ingest into the UXF bundle. The transfer
   *  transaction MUST carry `inclusionProof: null` — the recipient's
   *  reader will walk the chain when proofs land. */
  readonly recipientTokenJson: unknown;
  /** Class discriminator (C11). Coin-class results carry
   *  `splitParentTokenId`; NFT-class results MUST NOT. */
  readonly tokenClass: 'coin' | 'nft';
  /** Parent (source) tokenId for coin children. REQUIRED iff
   *  `tokenClass === 'coin'`. */
  readonly splitParentTokenId?: string;
  /** Optional split correlation id (legacy outbox compat). */
  readonly splitGroupId?: string;
}

/**
 * #142 contract widening — source selection carries `splitSources`
 * intent so partial-amount sends drive `InstantSplitExecutor.buildSplitBundle`
 * instead of silently transferring the whole source token. Backwards-
 * compatible with the legacy `Promise<ReadonlyArray<Token>>` shape:
 * callers that don't need to split a source return the array directly;
 * new partial-amount callers return this structured form.
 *
 * #149 multi-asset widening — `splitSources` is an array so multi-coin
 * sends where N coins each need their own split can drive N independent
 * `buildSplitBundle` invocations (one per source). Each entry carries
 * its own `coinIdHex` because the split executor mints recipient + change
 * tokens for a specific coin class.
 *
 * Invariant: every token in the selection appears in EITHER
 * `directSources` (transferred as-is) XOR exactly one entry in
 * `splitSources` (burnt and re-minted into recipient + change). All
 * `splitSources[i].token.id` MUST be distinct from each other and from
 * `directSources`. The orchestrator computes the union as the source-
 * lock set.
 */
export interface InstantSourceSelection {
  /** Sources transferred as whole tokens (the legacy `direct` method). */
  readonly directSources: ReadonlyArray<Token>;
  /**
   * Zero or more sources to split. When non-empty, the orchestrator
   * forwards each entry to {@link InstantCommitSourcesFn} via
   * `splitSources` (the param name); each entry MUST drive its own
   * `InstantSplitExecutor.buildSplitBundle(token, splitAmount,
   * remainderAmount, coinIdHex, ...)` call. Each invocation produces
   * a recipient mint (shipped in the bundle) and a change mint (kept
   * locally).
   *
   * Per-entry invariants:
   *   - `splitAmount + remainderAmount` MUST equal the token's coin
   *     balance for `coinIdHex`.
   *   - `splitAmount` is what the recipient receives; `remainderAmount`
   *     is the sender's change.
   *   - `coinIdHex` MUST be unique across entries (one split per coin
   *     class — primary coin + each additional-asset coin).
   *
   * Multiple entries enable #149: multi-coin partial-amount sends
   * (e.g., send 200 USDU + 100 USDC where each coin holding requires
   * splitting). NFTs are whole-token by definition and never appear here.
   */
  readonly splitSources?: ReadonlyArray<{
    readonly token: Token;
    readonly splitAmount: bigint;
    readonly remainderAmount: bigint;
    readonly coinIdHex: string;
  }>;
}

/**
 * Caller-supplied callback that submits transfer commitments for the
 * supplied sources WITHOUT awaiting their inclusion proofs, and returns
 * the post-submit JSON shape (with `inclusionProof: null` on the new
 * transition) for ingestion into the UXF bundle.
 *
 * Production wiring inside {@link
 * import('../../../modules/payments/PaymentsModule').PaymentsModule}'s instant dispatcher
 * derives commitments via the SDK's `TransferCommitment.create` /
 * `submitTransferCommitment` and STOPS THERE — no
 * `waitInclusionProof()`. Tests inject inline mocks.
 *
 * Failure modes flow as `SphereError`s — typically `TRANSFER_FAILED`
 * (commit submission rejected) or any aggregator-side rejection per
 * §6.1's error model.
 *
 * #142 widening: `splitSources` carries split intents through to
 * `commitSources`. Implementations that ignore it silently fall back
 * to whole-token transfer of each split source (the pre-fix bug).
 *
 * #149 multi-asset widening: `splitSources` is an array. Implementations
 * MUST iterate it and run one `buildSplitBundle` per entry. Each entry's
 * `token.id` also appears in `sources` so the legacy whole-token path
 * MUST skip those ids (lookup by `token.id` set).
 */
export type InstantCommitSourcesFn = (params: {
  readonly sources: ReadonlyArray<Token>;
  /** #142/#149 — split intents. Each entry's `token` is also in `sources`
   *  AND MUST be split-minted rather than whole-transferred. Legacy
   *  callsites pass `undefined` (or an empty array) and the orchestrator
   *  treats every source in `sources` as whole-token. */
  readonly splitSources?: InstantSourceSelection['splitSources'];
  readonly recipient: PeerInfo;
  readonly memo: string | undefined;
}) => Promise<ReadonlyArray<InstantCommitResult>>;

/**
 * Caller-supplied source-selection callback. See {@link
 * import('./conservative-sender').SelectSourcesFn} for rationale.
 *
 * In instant mode, when `request.allowPendingTokens === true`, the
 * caller's spend planner is permitted to include pending source tokens
 * (chain-mode per §2.3). The orchestrator does NOT enforce that
 * constraint here — the planner does — but it surfaces a
 * `cascade-risk-warning` event on publish to flag the recipient-side
 * cascade exposure.
 *
 * #142/#149 widening: callers may return EITHER the legacy
 * `ReadonlyArray<Token>` (all whole-token) OR an {@link InstantSourceSelection}
 * with a structured `splitSources` array for multi-coin partial-amount
 * sends. The orchestrator normalizes both shapes internally.
 */
export type InstantSelectSourcesFn = (params: {
  readonly request: TransferRequest;
  readonly validated: ValidatedTargets;
  readonly available: ReadonlyArray<Token>;
}) => Promise<ReadonlyArray<Token> | InstantSourceSelection>;

/**
 * Trigger callback to the sender-side finalization worker (T.5.B).
 * Invoked exactly ONCE per successful instant send, AFTER the outbox
 * entry has settled at `delivered-instant`. The implementation is a
 * future-wave concern: T.5.A only emits the trigger so the parent can
 * register the outbox entry with its worker registry.
 *
 * **Failure semantics**: any throw from this callback is swallowed by
 * the orchestrator (logged, but not propagated). The wire publish has
 * already completed — failing the whole send because the worker hook
 * threw would lose forensic information that the outbox already holds.
 * T.5.B will instead pick up orphan `delivered-instant` entries on
 * boot.
 */
export type TriggerFinalizationCallback = (params: {
  /** Per-address outbox key prefix (`${addr}.outbox.`). */
  readonly addressId: string;
  /** Outbox entry id (the transferId). */
  readonly outboxId: string;
  /** Bundle CID (forensic — same value persisted on the outbox entry). */
  readonly bundleCid: string;
  /** Snapshot of the outstanding requestIds the worker will poll. */
  readonly outstandingRequestIds: ReadonlyArray<string>;
}) => Promise<void> | void;

/**
 * Optional source-token marker hook. Production wiring sets the
 * source's local `status = 'pending'` and persists. Tests assert on the
 * recorded calls. When omitted, the orchestrator does NOT mark sources
 * — the caller is responsible for whatever local bookkeeping the
 * commit callback hasn't already done.
 */
export type MarkSourcePendingFn = (token: Token) => Promise<void> | void;

/**
 * Optional outbox-writer surface. Production wires the per-entry-key
 * UXF outbox writer (T.6.A — `profile/outbox-writer.ts`); tests inject
 * an inline recorder. Distinct from {@link
 * import('./conservative-sender').OutboxStubHooks} — the instant
 * orchestrator drives a real OutboxWriter (or write-through shim that
 * conforms to the same surface).
 *
 * The orchestrator calls `write(...)` four times in the happy path:
 *   1. status='packaging'         (CID branch)
 *   2. status='pinned'            (CID branch only — after pin)
 *   3. status='sending'           (just before transport publish)
 *   4. status='delivered-instant' (after transport ack)
 *
 * For inline-only sends, step 2 is skipped (`packaging` directly
 * transitions to `sending`).
 *
 * Each transition is intentionally split into individual writes so the
 * §7.0 state-machine validator (T.6.C) sees each arc; collapsing into a
 * single write would skip arcs and silently weaken the audit trail.
 */
export interface InstantOutboxHooks {
  /** Persist the entry at its current status. The orchestrator passes
   *  the full {@link UxfTransferOutboxEntry}-shaped payload (minus the
   *  writer-stamped `_schemaVersion` / `lamport`) on each call. */
  readonly write: (
    entry: Omit<UxfTransferOutboxEntry, '_schemaVersion' | 'lamport'>,
  ) => Promise<void>;
}

/**
 * Dependencies bundle required by {@link sendInstantUxf}.
 *
 * Field rationale mirrors {@link
 * import('./conservative-sender').ConservativeSenderDeps} — every
 * surface is callback-shaped so unit tests can exercise the full
 * pipeline without the surrounding {@link
 * import('../../../modules/payments/PaymentsModule').PaymentsModule}.
 */
export interface InstantSenderDeps {
  /** Aggregator client. Forwarded to {@link InstantCommitSourcesFn} via
   *  the production wiring; not consumed by the orchestrator directly
   *  (no preflight in instant mode). */
  readonly aggregator: OracleProvider;
  /** Transport provider used to publish the wire payload. */
  readonly transport: TransportProvider;
  /** Per-address token storage (reserved). */
  readonly tokenStorage?: TokenStorageProvider<unknown> | null;
  /** Sender's full identity. */
  readonly identity: FullIdentity;
  /** Address id — used as the outbox key prefix `${addressId}.outbox.${id}`
   *  per PROFILE-ARCHITECTURE §10.12. */
  readonly addressId: string;
  /** Transport pubkey for the wire envelope `sender` field. */
  readonly senderTransportPubkey?: string;
  /** Event emitter — invoked once with `'transfer:submitted'` on
   *  successful publish, once with `'transfer:failed'` on any throw,
   *  and (conditionally) once with `'transfer:cascade-risk-warning'`
   *  when the cascade rule fires. */
  readonly emit: <T extends SphereEventType>(
    type: T,
    data: SphereEventMap[T],
  ) => void;
  /** Optional IPFS publisher (CID-bound delivery). */
  readonly publishToIpfs?: PublishToIpfsCallback;
  /** Snapshot of the sender's owned token pool. */
  readonly availableSources: () =>
    | Promise<ReadonlyArray<Token>>
    | ReadonlyArray<Token>;
  /** Source-selection callback — wraps the SpendPlanner. */
  readonly selectSources: InstantSelectSourcesFn;
  /** Submits commitments WITHOUT awaiting proofs. */
  readonly commitSources: InstantCommitSourcesFn;
  /** Optional source-status mutator (mark source `pending`). */
  readonly markSourcePending?: MarkSourcePendingFn;
  /** Optional outbox writer hooks. Production wires a real
   *  {@link OutboxWriter}; tests inject inline recorders. */
  readonly outbox?: InstantOutboxHooks;
  /** Required: hook invoked AFTER `delivered-instant` to register the
   *  entry with T.5.B's worker. Tests pass a recorder; production
   *  wires the worker registry. */
  readonly onTriggerFinalization?: TriggerFinalizationCallback;
  /** Optional projection of `Token` → `TokenLike` for the validator. */
  readonly toTokenLike?: (token: Token) => TokenLike;
  /** Transfer ID override (resumed sends). */
  readonly transferId?: string;
  /**
   * **TEST-ONLY** fault-injection seam (T.6.E crash-recovery harness).
   * Mirrors {@link
   * import('./conservative-sender').ConservativeSenderDeps.__faultInject}.
   *
   * Hook firing points (mapped onto the §7.0 instant-mode pipeline):
   *  - `afterOutboxCommitSending` — fires AFTER the outbox write that
   *    sets `status='sending'`, before transport publish.
   *  - `afterTransportAck` — fires AFTER transport ack, before the
   *    outbox write that sets `status='delivered-instant'`.
   *
   * The `__` prefix marks this as a test-only seam — NOT a stable
   * public API. See {@link FaultInjectionHooks} for full semantics.
   *
   * @internal Test seam only.
   */
  readonly __faultInject?: FaultInjectionHooks;
  /**
   * **TEST-ONLY** override for the source-lock max-hold timeout (Wave 4
   * #171 fix). Defaults to 60_000ms in production; tests override to
   * a smaller value to exercise the force-release path without
   * burning real wall-clock seconds.
   *
   * @internal Test seam only.
   */
  readonly __sourceLockMaxHoldMs?: number;
  /**
   * Lock the bundle envelope's `createdAt` timestamp (UNIX
   * milliseconds) for cross-attempt determinism. Production workers
   * pass the persisted outbox entry's `createdAt` on **resume** so the
   * rebuilt bundle reproduces the exact bytes the first attempt
   * produced — making `bundleCid` stable across retries.
   *
   * Why this matters: `bundleCid` is the dag-cbor SHA-256 of the
   * envelope block, which embeds `createdAt`. Two `Date.now()` calls
   * straddling a wall-clock second boundary (a few ms apart) produce
   * different second-resolution stamps → different envelopes →
   * different `bundleCid`s. That breaks every system keyed on
   * `bundleCid` for idempotency (replay-LRU at the recipient, IPFS
   * pin reuse, outbox dedup, audit-#333 H3 fast path).
   *
   * Omitted on first-attempt sends → the orchestrator locks
   * `Date.now()` once at the top of {@link sendInstantUxf} and threads
   * it through. Within-call determinism is therefore guaranteed
   * regardless of how slowly the bundle build runs.
   */
  readonly bundleCreatedAt?: number;
}

// =============================================================================
// 2. Internal helpers
// =============================================================================

// Audit #333 H1: the per-source lock registry was extracted to
// `./source-locks.ts` so the conservative-sender can share the same
// process-global map (previously only instant-sender had locking and
// concurrent conservative+instant sends sharing a source could race).
// The `__resetSourceLocksForTesting` symbol is re-exported here so the
// existing test imports (tests/unit/payments/transfer/instant-sender.test.ts)
// continue to resolve without churn.
import {
  acquireSourceLocks,
  __resetSourceLocksForTesting,
} from './source-locks';

export { __resetSourceLocksForTesting };

/**
 * Sort by source tokenId, lex-ascending. Same rule the
 * conservative-sender uses (acceptance: deterministic bundle order).
 *
 * @internal
 */
function sortByTokenIdAsc<T extends { readonly sourceTokenId: string }>(
  list: ReadonlyArray<T>,
): T[] {
  return [...list].sort((a, b) =>
    a.sourceTokenId < b.sourceTokenId ? -1 : a.sourceTokenId > b.sourceTokenId ? 1 : 0,
  );
}

/**
 * Default {@link Token} → {@link TokenLike} projection. Mirrors the
 * one in conservative-sender: parses the SDK-format `sdkData` JSON,
 * surfaces `coinData` as the post-prune {@link TokenLike.coins}.
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

    // §4.1 step 2 — pending iff any transaction lacks an inclusion proof.
    let pending = token.status === 'transferring' || token.status === 'submitted';
    if (Array.isArray(parsed?.transactions)) {
      for (const tx of parsed.transactions) {
        if (
          tx !== null &&
          typeof tx === 'object' &&
          ('inclusionProof' in (tx as Record<string, unknown>)) &&
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
    // Empty/null coinData → NFT.
    return { id: tokenId, coins: null, pending };
  } catch {
    return fallback;
  }
}

/**
 * Collect every commitment requestId that needs to ride on the outbox
 * entry's `outstandingRequestIds` field per §4.3 / §7.1. The ordering
 * is:
 *   1. The new (just-submitted) requestId for each source.
 *   2. Plus the inherited unfinalized predecessor requestIds (chain
 *      mode per §2.3).
 *
 * The orchestrator returns a deduped, lex-sorted list so byte-equal
 * outbox entries result from byte-equal inputs (idempotency for
 * resumed-on-restart paths).
 *
 * @internal
 */
function collectOutstandingRequestIds(
  results: ReadonlyArray<InstantCommitResult>,
): string[] {
  const seen = new Set<string>();
  for (const r of results) {
    seen.add(r.requestIdHex);
    for (const inherited of r.inheritedRequestIds ?? []) {
      seen.add(inherited);
    }
  }
  return [...seen].sort();
}

/**
 * Build the {@link UxfTransferOutboxEntry}-shaped payload (minus the
 * writer-stamped fields) for the current pipeline step. The same base
 * record is updated for each status transition; the orchestrator only
 * ever overrides `status` + `updatedAt` + (on terminal step) the
 * outstanding-set.
 *
 * @internal
 */
interface OutboxBuildArgs {
  readonly transferId: string;
  readonly bundleCid: string;
  readonly tokenIds: ReadonlyArray<string>;
  /**
   * Audit #333 H5 — source tokens spent in this transfer attempt. The
   * finalization worker reads this at the `failed-permanent` transition
   * to drive the source-unlock hook.
   */
  readonly sourceTokenIds: ReadonlyArray<string>;
  readonly deliveryMethod: 'car-over-nostr' | 'cid-over-nostr';
  readonly recipient: string;
  readonly recipientTransportPubkey: string;
  readonly recipientNametag: string | undefined;
  readonly memo: string | undefined;
  readonly outstandingRequestIds: ReadonlyArray<string>;
  readonly createdAt: number;
  /**
   * Issue #166 P2 #3 — captured Nostr event id (filled by the
   * orchestrator AFTER `transport.sendTokenTransfer` returns).
   * Threaded into the `delivered-instant` outbox record so the
   * SENT-ledger write picks it up via writeSentEntryFromOutbox.
   * Undefined for pre-delivery statuses (`packaging`, `pinned`,
   * `sending`).
   */
  readonly nostrEventId?: string;
}

function buildOutboxRecord(
  args: OutboxBuildArgs,
  status: UxfTransferOutboxEntry['status'],
  now: number,
): Omit<UxfTransferOutboxEntry, '_schemaVersion' | 'lamport'> {
  return {
    id: args.transferId,
    bundleCid: args.bundleCid,
    tokenIds: args.tokenIds,
    // Audit #333 H5 — surface the source set for failed-permanent
    // recovery. Omitted when the set is empty (back-compat: the field
    // is optional, undefined === empty).
    ...(args.sourceTokenIds.length > 0
      ? { sourceTokenIds: args.sourceTokenIds }
      : {}),
    deliveryMethod: args.deliveryMethod,
    recipient: args.recipient,
    recipientTransportPubkey: args.recipientTransportPubkey,
    ...(args.recipientNametag !== undefined
      ? { recipientNametag: args.recipientNametag }
      : {}),
    mode: 'instant',
    status,
    outstandingRequestIds: args.outstandingRequestIds,
    completedRequestIds: [],
    ...(args.memo !== undefined ? { memo: args.memo } : {}),
    // Issue #166 P2 #3 — Nostr event id (delivered-instant only).
    ...(typeof args.nostrEventId === 'string' && args.nostrEventId.length > 0
      ? { nostrEventId: args.nostrEventId }
      : {}),
    createdAt: args.createdAt,
    updatedAt: now,
    submitRetryCount: 0,
    proofErrorCount: 0,
  };
}

// =============================================================================
// 3. Public API — sendInstantUxf
// =============================================================================

/**
 * Instant-mode UXF send orchestrator. Composes Waves T.1 + T.2 + T.6's
 * pure modules into the §2.1 + §6.1 sender pipeline.
 *
 * **Acceptance** (per `docs/uxf/UXF-TRANSFER-IMPL-PLAN.md` §T.5.A):
 *  - Outbox entry settles at `status='delivered-instant'` AFTER the
 *    Nostr publish acks.
 *  - `outstandingRequestIds` populated with all unfinalized commitment
 *    IDs (the new ones plus K-1 inherited per chain mode).
 *  - Source tokens marked `pending` until T.5.B's worker attaches
 *    proofs.
 *  - Emits `transfer:submitted` (NOT `confirmed`).
 *  - Coin children carry `splitParent`; NFT direct transfers do NOT
 *    (C11).
 *  - `transfer:cascade-risk-warning` fires when source is pending and
 *    recipient is fed a freshly-minted child.
 *  - W11: `confirmNftPending` rejection fires at T.5.A entry too —
 *    {@link validateTargets} from T.2.B handles the predicate.
 *
 * @throws {SphereError} `IPFS_PUBLISHER_MISSING` — CID-bound delivery
 *         requested without `publishToIpfs`.
 * @throws {SphereError} `TRANSPORT_ERROR` — `sendTokenTransfer`
 *         rejected.
 * @throws {SphereError} `NFT_PENDING_REQUIRES_CONFIRMATION` (W11) —
 *         pending NFT source without `confirmNftPending: true`.
 * @throws Any error surfaced by injected callbacks.
 */
export async function sendInstantUxf(
  request: TransferRequest,
  recipient: PeerInfo,
  deps: InstantSenderDeps,
): Promise<TransferResult> {
  const transferId = deps.transferId ?? cryptoRandomUUID();
  // Lock the timestamp once at the start. Use the caller-supplied
  // `bundleCreatedAt` on resume so the bundleCid reproduces the
  // original; otherwise lock `Date.now()` once here and thread it
  // through every downstream use (outbox createdAt, envelope
  // createdAt). See `InstantSenderDeps.bundleCreatedAt`.
  const now = deps.bundleCreatedAt ?? Date.now();

  // Mutable working copy — projected to readonly TransferResult on return.
  const result: {
    -readonly [K in keyof TransferResult]: TransferResult[K];
  } = {
    id: transferId,
    status: 'pending',
    tokens: [],
    tokenTransfers: [],
  };

  // Wave 4 #171 fix — per-source lock release fn, bound after selection.
  // MUST be invoked in `finally` regardless of success/failure to prevent
  // a stuck send from wedging unrelated future sends sharing the same
  // sources. Bound late because we don't know which sources to lock until
  // `selectSources` returns; the selection→lock window is safe because it
  // contains no observable external mutations (no transport publish, no
  // aggregator commit), so even if two sends pick the same set in
  // parallel, exactly one will acquire the lock first and complete the
  // commit/publish/mark sequence atomically — the second blocks at the
  // lock and, on resume, sees the now-pending sources rejected by either
  // the aggregator (duplicate-spend) or the spend planner (excluded from
  // selection).
  let releaseSourceLocks: (() => void) | null = null;
  try {
    // -----------------------------------------------------------------
    // Step 1: validate target list (T.2.B — §4.1 step 1+2). W11
    // confirmNftPending rejection fires HERE for NFT pending sources.
    // -----------------------------------------------------------------
    const available = await deps.availableSources();
    const projection = deps.toTokenLike ?? defaultTokenLike;
    const validated = validateTargets(
      request,
      available.map((t) => projection(t)),
    );

    // -----------------------------------------------------------------
    // Step 2: source selection.
    // -----------------------------------------------------------------
    const selectedRaw = await deps.selectSources({
      request,
      validated,
      available,
    });

    // #142 / #149 contract widening — normalize legacy array-shape into
    // the structured {directSources, splitSources} form. Existing
    // tests/callers that return plain Token[] continue to work; new
    // partial-amount callers return the structured form (singular
    // splitSource is gone; pass [splitEntry] as splitSources).
    const normalizedSelection: InstantSourceSelection = Array.isArray(selectedRaw)
      ? { directSources: selectedRaw as ReadonlyArray<Token>, splitSources: [] }
      : (selectedRaw as InstantSourceSelection);
    const splitSources = normalizedSelection.splitSources ?? [];

    // Loop-149 defense-in-depth — fail-closed on:
    //   (a) duplicate split coinIdHex (would silently over-mint into the
    //       same coin class twice — the recipient bundle would still
    //       satisfy OVER_TRANSFER_GUARD if each amount alone fit, but
    //       the planner can never legitimately produce this).
    //   (b) duplicate split token.id across splitSources (a planner bug
    //       that re-selected the same source twice).
    //   (c) overlap between split token.id and directSources (same).
    const seenSplitCoinIds = new Set<string>();
    const seenSplitTokenIds = new Set<string>();
    for (const entry of splitSources) {
      if (seenSplitCoinIds.has(entry.coinIdHex)) {
        throw new SphereError(
          `sendInstantUxf: splitSources contains duplicate coinIdHex=${entry.coinIdHex.slice(0, 32)}; ` +
            'multi-asset planner must produce at most one split entry per coin class',
          'INVALID_CONFIG',
        );
      }
      seenSplitCoinIds.add(entry.coinIdHex);
      if (seenSplitTokenIds.has(entry.token.id)) {
        throw new SphereError(
          `sendInstantUxf: splitSources contains duplicate token.id=${entry.token.id} (planner bug)`,
          'INVALID_CONFIG',
        );
      }
      seenSplitTokenIds.add(entry.token.id);
    }
    for (const direct of normalizedSelection.directSources) {
      if (seenSplitTokenIds.has(direct.id)) {
        throw new SphereError(
          `sendInstantUxf: token.id=${direct.id} appears in BOTH directSources and splitSources (planner bug)`,
          'INVALID_CONFIG',
        );
      }
    }

    const selected: ReadonlyArray<Token> = [
      ...normalizedSelection.directSources,
      ...splitSources.map((s) => s.token),
    ];

    if (selected.length === 0) {
      throw new SphereError(
        'sendInstantUxf: source selection returned no tokens; ' +
          'caller must throw INSUFFICIENT_BALANCE before reaching the orchestrator',
        'SEND_INSUFFICIENT_BALANCE',
      );
    }
    result.tokens = [...selected];

    // -----------------------------------------------------------------
    // Step 2.5 (Wave 4 #171 fix): acquire per-source in-memory locks.
    // Held across the entire commit→transport→mark sequence to close
    // the same-process double-spend window introduced by Wave 3's
    // deferred-mark fix (#170). Locks released in the outer `finally`.
    // -----------------------------------------------------------------
    const sourceTokenIds = selected.map((t) => t.id);
    releaseSourceLocks = await acquireSourceLocks(
      sourceTokenIds,
      deps.__sourceLockMaxHoldMs,
      'sendInstantUxf',
    );

    // -----------------------------------------------------------------
    // Step 3: skip preflight finalize. Instant mode permits unfinalized
    // predecessors per §2.3 — proofs are filled in by T.5.B's worker
    // after publish.
    // -----------------------------------------------------------------

    // -----------------------------------------------------------------
    // Step 4: commit + DO NOT await proofs. The callback returns the
    // recipient-shape JSON with `inclusionProof: null` on the new tx.
    // #142/#149: `splitSources` (if any) drive `InstantSplitExecutor`
    // in the production wiring — one split per entry; the orchestrator
    // only forwards the metadata.
    // -----------------------------------------------------------------
    const commitResults = await deps.commitSources({
      sources: selected,
      splitSources,
      recipient,
      memo: request.memo,
    });
    if (commitResults.length === 0) {
      throw new SphereError(
        'sendInstantUxf: commit callback returned zero results; cannot ship empty bundle',
        'TRANSFER_FAILED',
      );
    }

    // Defense-in-depth: enforce the C11 class-disjoint splitParent rule
    // at the orchestrator boundary. Producers that violate the rule
    // would silently leak NFT splitParents through the API; explicit
    // rejection makes the invariant testable.
    for (const r of commitResults) {
      if (r.tokenClass === 'coin') {
        if (
          r.splitParentTokenId === undefined ||
          r.splitParentTokenId.length === 0
        ) {
          throw new SphereError(
            `sendInstantUxf: coin commit result for source ${r.sourceTokenId} ` +
              'is missing splitParentTokenId (required by C11 for coin children)',
            'INVALID_CONFIG',
          );
        }
      } else if (r.tokenClass === 'nft' && r.splitParentTokenId !== undefined) {
        throw new SphereError(
          `sendInstantUxf: NFT commit result for source ${r.sourceTokenId} ` +
            'carries splitParentTokenId; C11 forbids splitParent on NFT direct transfers',
          'INVALID_CONFIG',
        );
      }
    }

    // -----------------------------------------------------------------
    // #142 — OVER_TRANSFER_GUARD. Defense-in-depth assertion that the
    // sum of fungible amounts encoded in the recipient token JSONs does
    // not exceed the request's per-coin totals.
    //
    // The bug this catches: a partial-amount send (e.g. 10 UCT from a
    // 100 UCT source) where the commitSources callback silently ships
    // the whole source as a direct (whole-token) transfer instead of
    // burning-and-minting a 10 UCT recipient slice. Without the guard,
    // the recipient receives 100 UCT and the sender's spend planner
    // discovers the over-send only after the bundle has landed on the
    // wire.
    //
    // The guard runs AFTER on-chain commits are submitted but BEFORE
    // the UXF bundle is published. A violation throws into the outer
    // catch — the source tokens are spent on-chain, but the recipient
    // never sees the bundle and the wallet records `transfer:failed`.
    // Better than a silent over-send. Operators can recover the
    // committed source via cascade-walker on the next sync.
    //
    // NFT entries are skipped (no fungible amount). Multi-asset
    // requests sum the primary slot + each additionalAssets coin entry.
    enforceOverTransferGuard(request, commitResults);

    const orderedResults = sortByTokenIdAsc(commitResults);

    // Loop4-e2e (round 2) + L5-C1/C2 hardening: validate AND extract
    // the recipient's tokenId for payload.tokenIds advertisement,
    // BEFORE `pkg.ingestAll` (so a missing/malformed tokenId surfaces
    // as a clean SphereError instead of a UXF deconstruct error
    // deeper in the stack).
    //   - Advertise the RECIPIENT's tokenId (genesis.data.tokenId),
    //     NOT the sender's sourceTokenId. Direct transfers coincide;
    //     split transfers produce a new recipient tokenId.
    //   - FAIL CLOSED on missing/non-string/non-hex tokenId — the
    //     previous silent fallback to `sourceTokenId` reintroduced
    //     the exact bug Loop4-r2 was written to fix.
    //   - Normalize to lowercase. The UXF deconstruct pool encodes
    //     hex lowercase (via @noble/hashes `bytesToHex`); the
    //     recipient's claimed-tokenId Set lookup is case-sensitive.
    //   - Assert canonical 64-char hex shape so SDK shape regressions
    //     surface immediately.
    const tokenIds = orderedResults.map((r): string => {
      const j = r.recipientTokenJson as {
        readonly genesis?: { readonly data?: { readonly tokenId?: unknown } };
      } | null | undefined;
      const tid = j?.genesis?.data?.tokenId;
      if (typeof tid !== 'string' || !/^[0-9a-f]{64}$/i.test(tid)) {
        throw new SphereError(
          `sendInstantUxf: recipientTokenJson.genesis.data.tokenId for source ${r.sourceTokenId} ` +
            `is missing or not 64-char hex (got ${typeof tid === 'string' ? `"${tid.slice(0, 32)}…"` : typeof tid}). ` +
            'The recipient bundle verifier would silently drop the transfer as an advisory unclaimed root.',
          'INVALID_CONFIG',
        );
      }
      return tid.toLowerCase();
    });

    // -----------------------------------------------------------------
    // Step 5: build UxfPackage and ingest tokens. Each ingested JSON
    // carries `inclusionProof: null` on the new transition — the
    // recipient's reader (T.5.D) walks the chain when proofs land.
    // -----------------------------------------------------------------
    const envelopeStamp = Math.floor(now / 1000);
    const pkg = UxfPackage.create({
      description: 'inter-wallet-transfer',
      creator: deps.identity.chainPubkey,
      // Lock the envelope timestamp to the orchestrator's pinned
      // `now` so the bundle bytes (and therefore the CAR root CID
      // we publish + persist as `bundleCid`) are deterministic
      // across crash-restart retries.
      createdAt: envelopeStamp,
    });
    // Also lock updatedAt: ingestAll would otherwise stamp
    // Math.floor(Date.now()/1000) at call time, which drifts past
    // `envelopeStamp` if the build crosses a second boundary.
    pkg.ingestAll(
      orderedResults.map((r) => r.recipientTokenJson),
      { updatedAt: envelopeStamp },
    );

    // -----------------------------------------------------------------
    // Step 6: serialize CAR.
    // -----------------------------------------------------------------
    const carBytes = await pkg.toCar();

    // -----------------------------------------------------------------
    // Step 7: derive bundle CID.
    // -----------------------------------------------------------------
    const bundleCid = await extractCarRootCid(carBytes);

    // Pre-compute the outstanding requestIds set so the outbox writer
    // sees the same value across every persistence step.
    const outstandingRequestIds = collectOutstandingRequestIds(orderedResults);

    // -----------------------------------------------------------------
    // Step 8: resolve delivery (T.2.C).
    // -----------------------------------------------------------------
    const strategy: DeliveryStrategy = request.delivery ?? { kind: 'auto' };
    // Issue #394 — `wantsCidBranch` mirrors the CID-vs-inline decision
    // that `resolveDelivery` will make. The predicate is gated on the
    // kill-switch {@link AUTOMATED_CID_DELIVERY_ENABLED} (see
    // `limits.ts`):
    //  - When OFF: only `force-cid` requests CID.
    //  - When ON (the post-#394 default): `force-cid` OR `auto` with a
    //    bundle exceeding the cap. The cap defaults to
    //    {@link RELAY_SAFE_CAP_BYTES} (96 KiB — the Nostr relay event
    //    ceiling) rather than the smaller {@link MAX_INLINE_CAR_BYTES}
    //    (16 KiB) used pre-#394, so promotion to CID trips NEAR the
    //    relay cap instead of at a quarter of it. Callers that want a
    //    smaller cap can still pass `inlineCapBytes` explicitly.
    const wantsCidBranch = AUTOMATED_CID_DELIVERY_ENABLED
      ? strategy.kind === 'force-cid' ||
        (strategy.kind === 'auto' &&
          carBytes.byteLength >
            (strategy.inlineCapBytes ?? RELAY_SAFE_CAP_BYTES))
      : strategy.kind === 'force-cid';
    if (wantsCidBranch && deps.publishToIpfs === undefined) {
      // Pre-flight reject: bundle needs CID delivery, no publisher is
      // wired, and the bundle is too large for the CAR-inline fallback
      // in resolveDelivery (approach γ). Fail fast here rather than
      // letting resolveDelivery surface a generic error after all the
      // work has already been done.
      //
      // When the bundle is <= RELAY_SAFE_CAP_BYTES, resolveDelivery's
      // carInlineFallback() will silently downgrade to `uxf-car` inline
      // delivery — so we only hard-fail when inline is impossible.
      if (carBytes.byteLength > RELAY_SAFE_CAP_BYTES) {
        throw new SphereError(
          'sendInstantUxf: delivery strategy requires CID delivery, no publishToIpfs' +
            ` callback was supplied, and the CAR (${carBytes.byteLength} bytes) exceeds` +
            ` the relay-safe inline ceiling of ${RELAY_SAFE_CAP_BYTES} bytes.` +
            ' Configure an IPFS provider to send large bundles.',
          'IPFS_PUBLISHER_REQUIRED',
        );
      }
      // Bundle fits within RELAY_SAFE_CAP_BYTES: resolveDelivery will
      // apply the CAR-inline fallback transparently. No pre-flight throw.
    }
    // Issue #393 — when automated CID is OFF and the bundle exceeds
    // RELAY_SAFE_CAP_BYTES in `auto` mode, surface the error here at
    // pre-flight rather than after the full CAR build/pin work
    // completes in resolveDelivery. Same throw text as the resolver's
    // `'auto'` branch so operators see one consistent message regardless
    // of which call site detects the overflow.
    if (
      !AUTOMATED_CID_DELIVERY_ENABLED &&
      strategy.kind === 'auto' &&
      carBytes.byteLength > RELAY_SAFE_CAP_BYTES
    ) {
      throw new SphereError(
        `sendInstantUxf: bundle is ${carBytes.byteLength} bytes, exceeds the ` +
          `relay-safe inline ceiling of ${RELAY_SAFE_CAP_BYTES} bytes, AND ` +
          `automated CID delivery is currently disabled (see ` +
          `AUTOMATED_CID_DELIVERY_ENABLED in modules/payments/transfer/limits.ts). ` +
          `Either reduce the source set so the bundle fits inline, or pass ` +
          `\`delivery: { kind: 'force-cid' }\` with an IPFS publisher wired ` +
          `via createNodeProviders/createBrowserProviders.`,
        'INLINE_CAR_TOO_LARGE',
      );
    }

    // -----------------------------------------------------------------
    // Step 9 (outbox): persist `packaging` BEFORE pin / publish so a
    // crash leaves a forensic record. The CID branch transitions
    // through `pinned` after the resolveDelivery call returns; both
    // branches transition through `sending` just before transport.
    // -----------------------------------------------------------------
    const baseArgs: OutboxBuildArgs = {
      transferId,
      bundleCid,
      tokenIds,
      // Audit #333 H5 — record the source token set so the worker can
      // unlock them on failed-permanent.
      sourceTokenIds,
      // Set placeholder; updated to the real method when the
      // resolveDelivery decision is known.
      deliveryMethod: wantsCidBranch ? 'cid-over-nostr' : 'car-over-nostr',
      recipient: request.recipient,
      recipientTransportPubkey: recipient.transportPubkey,
      recipientNametag: recipient.nametag,
      memo: request.memo,
      outstandingRequestIds,
      createdAt: now,
    };

    if (deps.outbox !== undefined) {
      await deps.outbox.write(buildOutboxRecord(baseArgs, 'packaging', Date.now()));
    }

    // Now run delivery (which performs the actual IPFS pin for
    // CID-bound branches). The pin happens INSIDE resolveDelivery via
    // the injected callback.
    const delivery = await resolveDelivery({
      strategy,
      carBytes,
      // `publishToIpfs` is optional: when absent resolveDelivery
      // applies the CAR-inline fallback (approach γ) for bundles
      // <= RELAY_SAFE_CAP_BYTES, or throws IPFS_PUBLISHER_REQUIRED
      // for oversized bundles. The pre-flight above already caught
      // the oversized-without-publisher case, so the REQUIRED error
      // is defense-in-depth here.
      publishToIpfs: deps.publishToIpfs,
    });

    // After pin: CID branch transitions packaging → pinned. Inline
    // skips this arc and goes straight to sending.
    const finalDeliveryMethod: 'car-over-nostr' | 'cid-over-nostr' =
      delivery.kind === 'inline' ? 'car-over-nostr' : 'cid-over-nostr';
    const argsAfterDelivery: OutboxBuildArgs = {
      ...baseArgs,
      deliveryMethod: finalDeliveryMethod,
    };
    if (delivery.kind === 'cid' && deps.outbox !== undefined) {
      await deps.outbox.write(
        buildOutboxRecord(argsAfterDelivery, 'pinned', Date.now()),
      );
    }

    // -----------------------------------------------------------------
    // OUTBOX-SEND-FOLLOWUPS Item #6.a — fire-and-forget local IPFS
    // pin on the inline path.
    //
    // When `delivery.kind === 'inline'` AND the resolver flagged the
    // decision with `shouldPin: true` (which happens iff a publisher
    // is wired), additionally pin the SAME content-addressed CAR
    // bytes to the local IPFS node. The wire delivery stays inline
    // (`uxf-car`); the pin is independent best-effort durability so
    // Item #2's retention re-publish closure can downgrade
    // `'car-over-nostr'` re-publishes to CID-shape later.
    //
    // Strictly fire-and-forget — pin failure MUST NOT block the
    // send. Idempotent: re-running publishToIpfs for the same CAR
    // is a no-op at the IPFS layer (content-addressed).
    // -----------------------------------------------------------------
    if (
      delivery.kind === 'inline' &&
      delivery.shouldPin === true &&
      deps.publishToIpfs !== undefined
    ) {
      const publish = deps.publishToIpfs;
      // Trampoline through `Promise.resolve().then(...)` so a publisher
      // that throws SYNCHRONOUSLY (before constructing its Promise) is
      // still caught by `.catch()`. The `PublishToIpfsCallback` type
      // returns a Promise, which `async` implementations honor by
      // contract — but a non-async implementation that throws before
      // `return` would escape `void publish(carBytes).catch(...)`.
      void Promise.resolve()
        .then(() => publish(carBytes))
        .catch((pinErr) => {
          const message =
            pinErr instanceof Error ? pinErr.message : String(pinErr);
          logger.warn(
            'Payments',
            `sendInstantUxf: best-effort inline-CAR pin failed (Item #6.a) — wire send unaffected; ` +
              `Item #2 retention re-publish for this entry will fall back to the defensive arc. ` +
              `bundleCid=${bundleCid} cause=${message}`,
          );
        });
    }

    // -----------------------------------------------------------------
    // Step 10: build the wire envelope.
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

    const payload: UxfTransferPayloadCar | UxfTransferPayloadCid =
      delivery.kind === 'inline'
        ? {
            kind: 'uxf-car',
            version: '1.0',
            mode: 'instant',
            bundleCid,
            tokenIds,
            ...(request.memo !== undefined ? { memo: request.memo } : {}),
            ...(senderField !== undefined ? { sender: senderField } : {}),
            carBase64: delivery.carBase64,
          }
        : {
            kind: 'uxf-cid',
            version: '1.0',
            mode: 'instant',
            bundleCid,
            tokenIds,
            ...(request.memo !== undefined ? { memo: request.memo } : {}),
            ...(senderField !== undefined ? { sender: senderField } : {}),
          };

    // -----------------------------------------------------------------
    // Step 11: outbox `sending` BEFORE transport publish.
    // -----------------------------------------------------------------
    if (deps.outbox !== undefined) {
      await deps.outbox.write(
        buildOutboxRecord(argsAfterDelivery, 'sending', Date.now()),
      );
    }

    // INVARIANT (post-Wave-3 steelman fix #170 — Option A):
    // `markSourcePending` is DEFERRED until AFTER `transport.sendTokenTransfer`
    // returns success. Previously the marker fired before publish, so a
    // transport throw left sources stuck in `pending` forever — the outer
    // catch emitted `transfer:failed` but never unmarked, and a
    // sending-recovery-worker pickup that bypassed the cause of the
    // original failure could double-publish proofs into a transition the
    // recipient never received.
    //
    // The window between outbox `sending` and transport ack is now
    // observed-pending only via the OUTBOX state — the recovery worker
    // still resumes correctly from `sending` because it re-runs the
    // pipeline including `markSourcePending`. Crash-after-ack-before-mark
    // is covered by the symmetric resume path: the sources stay
    // `confirmed`/non-pending, which correctly reflects local state until
    // the worker picks the outbox up; the worker re-marks idempotently
    // (production wiring of `markSourcePending` is an idempotent setter
    // — re-marking an already-pending token is a no-op).
    //
    // Spec refs: §6.3 sender-side ordering, §7.1 CRDT invariants.

    // TEST-ONLY fault-injection seam: simulate process death between
    // outbox commit and Nostr publish (§6.3 last-paragraph crash window).
    if (deps.__faultInject?.afterOutboxCommitSending !== undefined) {
      await deps.__faultInject.afterOutboxCommitSending();
    }

    // -----------------------------------------------------------------
    // Step 12: publish via transport.
    // -----------------------------------------------------------------
    result.status = 'submitted';
    // Issue #166 P2 #3 — capture the Nostr event id returned by the
    // relay's OK ack so the `delivered-instant` outbox commit can
    // persist it.
    let nostrEventId: string | undefined;
    try {
      nostrEventId = await deps.transport.sendTokenTransfer(
        recipient.transportPubkey,
        payload,
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new SphereError(
        `sendInstantUxf: transport.sendTokenTransfer failed: ${message}`,
        'TRANSPORT_ERROR',
        cause,
      );
    }

    // -----------------------------------------------------------------
    // Step 12.5: mark sources `pending` AFTER transport ack (Option A).
    // The publish is durable on the relay; from this point onward the
    // recipient will receive the bundle, so the sender's local sources
    // MUST be locked into `pending` to prevent a parallel send from
    // double-spending the same token.
    // -----------------------------------------------------------------
    if (deps.markSourcePending !== undefined) {
      for (const src of selected) {
        await deps.markSourcePending(src);
      }
    }

    // TEST-ONLY fault-injection seam: simulate process death between
    // transport ack and the `delivered-instant` outbox commit.
    if (deps.__faultInject?.afterTransportAck !== undefined) {
      await deps.__faultInject.afterTransportAck();
    }

    // -----------------------------------------------------------------
    // Step 13: outbox `delivered-instant` AFTER transport ack.
    // -----------------------------------------------------------------
    if (deps.outbox !== undefined) {
      // Issue #166 P2 #3 — fold the captured event id into the
      // delivered-instant record. Earlier statuses (`packaging`,
      // `pinned`, `sending`) do NOT carry it because publish hasn't
      // happened yet.
      const argsAtDelivery: OutboxBuildArgs = {
        ...argsAfterDelivery,
        ...(typeof nostrEventId === 'string' && nostrEventId.length > 0
          ? { nostrEventId }
          : {}),
      };
      await deps.outbox.write(
        buildOutboxRecord(argsAtDelivery, 'delivered-instant', Date.now()),
      );
    }

    // -----------------------------------------------------------------
    // Step 14: project per-source token-transfer details. Coin children
    // carry `splitParent: { tokenId, status: 'pending' }`; NFT direct
    // transfers do NOT (C11). T.5.B will flip status to 'valid' once
    // the parent's commit-transition proof lands.
    // -----------------------------------------------------------------
    result.tokenTransfers = orderedResults.map(
      (r): TokenTransferDetail => {
        const base: TokenTransferDetail = {
          sourceTokenId: r.sourceTokenId,
          method: r.method,
          requestIdHex: r.requestIdHex,
          ...(r.splitGroupId !== undefined ? { splitGroupId: r.splitGroupId } : {}),
        };
        if (r.tokenClass === 'coin' && r.splitParentTokenId !== undefined) {
          return {
            ...base,
            splitParent: {
              tokenId: r.splitParentTokenId,
              status: 'pending',
            },
          };
        }
        return base;
      },
    );

    // -----------------------------------------------------------------
    // Step 15: cascade-risk-warning (§6.1.1). When ANY selected coin
    // source is pending, the recipient's freshly-minted child carries
    // the same pending status and will resolve only after the
    // sender's source proofs land. The warning is informational —
    // diagnostic only. NFT-class sources with `pending===true` are
    // already gated upstream by W11's `confirmNftPending` check inside
    // {@link validateTargets}, so a duplicate event here would be
    // redundant. We restrict the check to coin-class results.
    // -----------------------------------------------------------------
    const sourcesByTokenId = new Map<string, TokenLike>();
    for (const t of selected) {
      sourcesByTokenId.set(t.id, projection(t));
    }
    const pendingSourceTokenIds: string[] = [];
    const freshlyMintedChildTokenIds: string[] = [];
    for (const r of orderedResults) {
      if (r.tokenClass !== 'coin') continue;
      const src = sourcesByTokenId.get(r.sourceTokenId);
      if (src === undefined) continue;
      // Defense-in-depth: walk the source through classifyToken too —
      // surfaces a stale projection bug rather than silently skipping
      // a warning the operator should see.
      const sourceClass = classifyToken(src);
      if (sourceClass !== 'coin') continue;
      if (src.pending !== true) continue;
      if (!pendingSourceTokenIds.includes(r.sourceTokenId)) {
        pendingSourceTokenIds.push(r.sourceTokenId);
      }
      // The recipient's freshly-minted child is the source token's
      // burn-then-mint output. We surface the parent (source) tokenId
      // via splitParentTokenId — the actual child id is the new
      // tokenId on the recipient side, which the orchestrator does not
      // assign (that is the SDK's job in commitSources). Surfacing the
      // splitParentTokenId is the correlation key recipients need.
      if (
        r.splitParentTokenId !== undefined &&
        !freshlyMintedChildTokenIds.includes(r.splitParentTokenId)
      ) {
        freshlyMintedChildTokenIds.push(r.splitParentTokenId);
      }
    }
    if (pendingSourceTokenIds.length > 0) {
      deps.emit('transfer:cascade-risk-warning', {
        transferId,
        bundleCid,
        recipientTransportPubkey: recipient.transportPubkey,
        pendingSourceTokenIds,
        freshlyMintedChildTokenIds,
      });
    }

    // -----------------------------------------------------------------
    // Step 16: emit transfer:submitted (NOT transfer:confirmed). T.5.B
    // emits transfer:confirmed once proofs are attached.
    // -----------------------------------------------------------------
    deps.emit('transfer:submitted', result as TransferResult);

    // -----------------------------------------------------------------
    // Step 17: trigger T.5.B finalization worker. Fire-and-forget; any
    // throw is logged but not propagated — the publish has already
    // succeeded and the outbox entry holds the canonical state.
    // -----------------------------------------------------------------
    if (deps.onTriggerFinalization !== undefined) {
      try {
        await deps.onTriggerFinalization({
          addressId: deps.addressId,
          outboxId: transferId,
          bundleCid,
          outstandingRequestIds,
        });
      } catch (cause) {
        // Worker registry hiccups MUST NOT fail the send. T.5.B's
        // worker picks up orphan delivered-instant entries on boot.
        //
        // BUT: emit `transfer:finalization-trigger-failed` so that
        // operators / telemetry can observe the failure. A wallet that
        // never reboots before the worker's poll cycle would otherwise
        // leave the entry at `delivered-instant` indefinitely with NO
        // signal — the silent-swallow steelman gap (#170 issue 2).
        try {
          deps.emit('transfer:finalization-trigger-failed', {
            addressId: deps.addressId,
            outboxId: transferId,
            bundleCid,
            outstandingRequestIds,
            message: cause instanceof Error ? cause.message : String(cause),
          });
        } catch {
          // Defense-in-depth: if the emit itself throws (synchronous
          // listener error), do not propagate — the send has succeeded
          // and the swallow contract is the priority.
        }
      }
    }

    return result as TransferResult;
  } catch (err) {
    result.status = 'failed';
    result.error = err instanceof Error ? err.message : String(err);
    deps.emit('transfer:failed', result as TransferResult);
    throw err;
  } finally {
    // Wave 4 #171 fix: release per-source locks regardless of success
    // or failure. Bound to `null` until selection completes; if we
    // threw before locks were acquired (e.g. validateTargets rejection,
    // empty selection) there is nothing to release.
    if (releaseSourceLocks !== null) {
      releaseSourceLocks();
    }
  }
}

// =============================================================================
// 4. Internal — UUID + IPFS-publisher fallback
// =============================================================================

/**
 * Standalone UUID v4 generator. Same implementation as the
 * conservative-sender's helper — not deduped because the orchestrator
 * is intentionally a self-contained free function.
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
    'sendInstantUxf: no source of randomness — refusing to generate transferId',
    'INVALID_CONFIG',
  );
}

