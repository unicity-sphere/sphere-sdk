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
} from '../../../types/uxf-transfer';
import type { UxfTransferOutboxEntry } from '../../../types/uxf-outbox';
import { UxfPackage } from '../../../uxf/UxfPackage';
import { extractCarRootCid } from '../../../uxf/transfer-payload';

import { classifyToken, type TokenLike } from './classify-token';
import type { FaultInjectionHooks } from './conservative-sender';
import type {
  PublishToIpfsCallback,
  PublishToIpfsResult,
} from './delivery-resolver';
import { resolveDelivery } from './delivery-resolver';
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
 * Caller-supplied callback that submits transfer commitments for the
 * supplied sources WITHOUT awaiting their inclusion proofs, and returns
 * the post-submit JSON shape (with `inclusionProof: null` on the new
 * transition) for ingestion into the UXF bundle.
 *
 * Production wiring inside {@link
 * import('../PaymentsModule').PaymentsModule}'s instant dispatcher
 * derives commitments via the SDK's `TransferCommitment.create` /
 * `submitTransferCommitment` and STOPS THERE — no
 * `waitInclusionProof()`. Tests inject inline mocks.
 *
 * Failure modes flow as `SphereError`s — typically `TRANSFER_FAILED`
 * (commit submission rejected) or any aggregator-side rejection per
 * §6.1's error model.
 */
export type InstantCommitSourcesFn = (params: {
  readonly sources: ReadonlyArray<Token>;
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
 */
export type InstantSelectSourcesFn = (params: {
  readonly request: TransferRequest;
  readonly validated: ValidatedTargets;
  readonly available: ReadonlyArray<Token>;
}) => Promise<ReadonlyArray<Token>>;

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
 * import('../PaymentsModule').PaymentsModule}.
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
}

// =============================================================================
// 2. Internal helpers
// =============================================================================

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
  readonly deliveryMethod: 'car-over-nostr' | 'cid-over-nostr';
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
    id: args.transferId,
    bundleCid: args.bundleCid,
    tokenIds: args.tokenIds,
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
  const now = Date.now();

  // Mutable working copy — projected to readonly TransferResult on return.
  const result: {
    -readonly [K in keyof TransferResult]: TransferResult[K];
  } = {
    id: transferId,
    status: 'pending',
    tokens: [],
    tokenTransfers: [],
  };

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
    const selected = await deps.selectSources({
      request,
      validated,
      available,
    });
    if (selected.length === 0) {
      throw new SphereError(
        'sendInstantUxf: source selection returned no tokens; ' +
          'caller must throw INSUFFICIENT_BALANCE before reaching the orchestrator',
        'SEND_INSUFFICIENT_BALANCE',
      );
    }
    result.tokens = [...selected];

    // -----------------------------------------------------------------
    // Step 3: skip preflight finalize. Instant mode permits unfinalized
    // predecessors per §2.3 — proofs are filled in by T.5.B's worker
    // after publish.
    // -----------------------------------------------------------------

    // -----------------------------------------------------------------
    // Step 4: commit + DO NOT await proofs. The callback returns the
    // recipient-shape JSON with `inclusionProof: null` on the new tx.
    // -----------------------------------------------------------------
    const commitResults = await deps.commitSources({
      sources: selected,
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

    const orderedResults = sortByTokenIdAsc(commitResults);

    // -----------------------------------------------------------------
    // Step 5: build UxfPackage and ingest tokens. Each ingested JSON
    // carries `inclusionProof: null` on the new transition — the
    // recipient's reader (T.5.D) walks the chain when proofs land.
    // -----------------------------------------------------------------
    const pkg = UxfPackage.create({
      description: 'inter-wallet-transfer',
      creator: deps.identity.chainPubkey,
    });
    pkg.ingestAll(orderedResults.map((r) => r.recipientTokenJson));

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
    const tokenIds = orderedResults.map((r) => r.sourceTokenId);

    // -----------------------------------------------------------------
    // Step 8: resolve delivery (T.2.C).
    // -----------------------------------------------------------------
    const strategy: DeliveryStrategy = request.delivery ?? { kind: 'auto' };
    const wantsCidBranch =
      strategy.kind === 'force-cid' ||
      (strategy.kind === 'auto' &&
        carBytes.byteLength >
          (strategy.inlineCapBytes ?? Number.POSITIVE_INFINITY));
    if (wantsCidBranch && deps.publishToIpfs === undefined) {
      throw new SphereError(
        'sendInstantUxf: delivery strategy requires CID delivery but no publishToIpfs callback was supplied',
        'IPFS_PUBLISHER_MISSING',
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
      publishToIpfs: deps.publishToIpfs ?? throwingPublishToIpfs,
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

    // Mark sources `pending` locally before we publish — if the
    // publish succeeds and we crash before bookkeeping, the worker
    // (T.5.B) still picks up the outbox entry and resumes.
    if (deps.markSourcePending !== undefined) {
      for (const src of selected) {
        await deps.markSourcePending(src);
      }
    }

    // TEST-ONLY fault-injection seam: simulate process death between
    // outbox commit and Nostr publish (§6.3 last-paragraph crash window).
    if (deps.__faultInject?.afterOutboxCommitSending !== undefined) {
      await deps.__faultInject.afterOutboxCommitSending();
    }

    // -----------------------------------------------------------------
    // Step 12: publish via transport.
    // -----------------------------------------------------------------
    result.status = 'submitted';
    try {
      await deps.transport.sendTokenTransfer(
        recipient.transportPubkey,
        payload as unknown as TokenTransferPayload,
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new SphereError(
        `sendInstantUxf: transport.sendTokenTransfer failed: ${message}`,
        'TRANSPORT_ERROR',
        cause,
      );
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
      await deps.outbox.write(
        buildOutboxRecord(argsAfterDelivery, 'delivered-instant', Date.now()),
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
      } catch {
        // Worker registry hiccups MUST NOT fail the send. T.5.B's
        // worker picks up orphan delivered-instant entries on boot.
      }
    }

    return result as TransferResult;
  } catch (err) {
    result.status = 'failed';
    result.error = err instanceof Error ? err.message : String(err);
    deps.emit('transfer:failed', result as TransferResult);
    throw err;
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

/**
 * Defense-in-depth `publishToIpfs` fallback. The pre-flight check above
 * already rejects CID-bound delivery without a publisher; this exists
 * for the auto-mode-edge-case where a bundle slips just past the cap
 * after the pre-flight guard.
 *
 * @internal
 */
const throwingPublishToIpfs: PublishToIpfsCallback = async (): Promise<PublishToIpfsResult> => {
  throw new SphereError(
    'sendInstantUxf: resolveDelivery requested CID delivery but no publishToIpfs callback was supplied',
    'IPFS_PUBLISHER_MISSING',
  );
};
