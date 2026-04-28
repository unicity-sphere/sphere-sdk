/**
 * Conservative-mode UXF send orchestrator (T.2.D.1).
 *
 * Composes the building blocks landed by Wave T.1 + T.2 (target validation,
 * preflight finalize, delivery resolver, transfer-payload encoding) into a
 * single async send pipeline that ships an inter-wallet transfer through
 * the UXF wire format. The orchestrator is a **pure free function** — no
 * module-level state, every dependency injected — so unit tests can
 * exercise the full pipeline without the surrounding {@link
 * ../PaymentsModule.PaymentsModule}.
 *
 * Pipeline (12 steps, mirroring the §4.2 sender state machine):
 *  1. {@link validateTargets} (T.2.B) — build the canonical target list
 *     from the request's `(primary + additionalAssets)`.
 *  2. **Source selection** — caller supplies a `selectSources` callback
 *     that wraps the existing `SpendPlanner` (or any policy). The
 *     orchestrator does NOT implement source-coverage logic itself.
 *  3. {@link preflightFinalize} (T.2.A) — finalize every pending
 *     predecessor of every selected source. Pure function chained from
 *     the caller-supplied resolvers.
 *  4. **Commitment + proof** — caller supplies a `commitSources`
 *     callback that submits each transfer commitment, awaits its
 *     inclusion proof, and returns the post-transfer SDK token JSON
 *     (the form a recipient will reconstruct). The orchestrator is
 *     decoupled from the SDK's `TransferCommitment` shape.
 *  5. {@link UxfPackage.create} + {@link UxfPackage.ingestAll} — assemble
 *     the bundle. Tokens are pre-sorted by lex-min `tokenId` for
 *     deterministic on-the-wire CAR layout.
 *  6. {@link UxfPackage.toCar} — serialize to CARv1 bytes.
 *  7. {@link extractCarRootCid} (T.1.D) — derive the bundle CID from the
 *     CAR's single root.
 *  8. {@link resolveDelivery} (T.2.C) — choose inline (`uxf-car`) or
 *     CID-by-reference (`uxf-cid`) per the caller's
 *     {@link DeliveryStrategy}.
 *  9. **IPFS pin** — when {@link resolveDelivery} returns a `cid` decision
 *     it has ALREADY invoked the injected `publishToIpfs` callback, so
 *     no extra step is needed here.
 * 10. **Stub outbox call** — emits a synthetic legacy {@link OutboxEntry}
 *     so existing tests keep their invariants. T.2.D.2 replaces this
 *     with the per-entry-key {@link UxfTransferOutboxEntry} writer.
 * 11. {@link TransportProvider.sendTokenTransfer} — publish the wire
 *     payload over the transport layer.
 * 12. emit `transfer:confirmed` — the orchestrator returns AFTER the
 *     event has been dispatched, so callers can serialize on the
 *     return.
 *
 * Spec references:
 *  - §2.2  Conservative mode definition (full-history finalize before
 *          send).
 *  - §4.1  Target list semantics (multi-asset, primary slot optional).
 *  - §4.2  Sender pipeline state machine.
 *  - §3.3  Inline vs CID delivery (handled by {@link resolveDelivery}).
 *
 * @module modules/payments/transfer/conservative-sender
 * @internal
 */

import { SphereError } from '../../../core/errors';
import type {
  OracleProvider,
} from '../../../oracle/oracle-provider';
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
import type {
  DeliveryStrategy,
  UxfTransferPayloadCar,
  UxfTransferPayloadCid,
} from '../../../types/uxf-transfer';
import { UxfPackage } from '../../../uxf/UxfPackage';
import { extractCarRootCid } from '../../../uxf/transfer-payload';

import type { TokenLike } from './classify-token';
import type {
  PublishToIpfsCallback,
  PublishToIpfsResult,
} from './delivery-resolver';
import { resolveDelivery } from './delivery-resolver';
import {
  preflightFinalize,
  type PreflightFinalizeOptions,
} from './preflight-finalize';
import { validateTargets, type ValidatedTargets } from './target-validator';

// =============================================================================
// 1. Public types — commit + select callbacks, deps, return value
// =============================================================================

/**
 * Result of committing a single source token on-chain. Returned by the
 * caller-supplied {@link CommitSourcesFn}.
 *
 * @remarks
 * - `recipientTokenJson` is the JSON shape the recipient will reconstruct
 *   (the SDK's `Token.fromJSON()` accepts this verbatim). Ingested by
 *   {@link UxfPackage.ingest} into the bundle pool. For coin-class
 *   `'split'` transfers it is the recipient's freshly-minted token; for
 *   coin-class `'direct'` and NFT-class `'direct'` transfers it is the
 *   source token with the recipient transition appended.
 * - `requestIdHex` is the lowercase-hex aggregator request id used by
 *   downstream observers (history, outbox).
 * - `splitGroupId` is set only for `method: 'split'` results — correlates
 *   sender / recipient / change tokens for legacy outbox compatibility.
 */
export interface ConservativeCommitResult {
  readonly sourceTokenId: string;
  readonly method: 'direct' | 'split';
  readonly requestIdHex: string;
  /** SDK-format token JSON to ingest into the UXF bundle. */
  readonly recipientTokenJson: unknown;
  /** Optional split correlation id (legacy outbox). */
  readonly splitGroupId?: string;
}

/**
 * Caller-supplied callback that submits transfer commitments for the
 * supplied sources, awaits inclusion proofs, and returns the post-
 * transfer JSON shapes. This is the SDK-coupling boundary — the
 * orchestrator does not depend on `TransferCommitment` /
 * `submitTransferCommitment` directly.
 *
 * Callers are responsible for:
 *  - Persisting any change tokens (split-mode).
 *  - Reservation bookkeeping.
 *  - Surfacing per-token failures as a single thrown {@link SphereError}.
 *
 * The returned array MUST cover every source supplied; entries may be
 * returned in any order — the orchestrator sorts by lex-min `tokenId`
 * before {@link UxfPackage.ingestAll}.
 */
export type CommitSourcesFn = (params: {
  readonly sources: ReadonlyArray<Token>;
  readonly recipient: PeerInfo;
  readonly memo: string | undefined;
}) => Promise<ReadonlyArray<ConservativeCommitResult>>;

/**
 * Caller-supplied source-selection callback. Wraps the existing
 * {@link ../SpendQueue.SpendPlanner} (production) or returns the test's
 * pre-chosen sources (unit). Receives the validated target list so
 * future revisions can do per-target routing (e.g., NFT-direct + coin-
 * split mixes).
 */
export type SelectSourcesFn = (params: {
  readonly request: TransferRequest;
  readonly validated: ValidatedTargets;
  readonly available: ReadonlyArray<Token>;
}) => Promise<ReadonlyArray<Token>>;

/**
 * Per-source preflight resolver injection — preserves the option grid
 * exposed by {@link preflightFinalize}. The orchestrator passes
 * `aggregator` from {@link ConservativeSenderDeps}; the rest comes from
 * here so callers can wire the SDK-specific extractors.
 */
export type PreflightOptionsFn = (params: {
  readonly selectedSources: ReadonlyArray<Token>;
  readonly aggregator: OracleProvider;
}) => Omit<PreflightFinalizeOptions, 'aggregator'>;

/**
 * Outbox integration hooks (T.2.D.2). Production wiring threads an
 * {@link OutboxWriter} through these callbacks; tests typically inject
 * inline spies.
 *
 * The orchestrator drives the §7.0 lifecycle for the entry it owns:
 *
 *   1. {@link create} — write a fresh entry with `status: 'packaging'`
 *      AFTER the bundle CID is derived (steps 5-7 of the pipeline).
 *      The entry id is the orchestrator's transferId. Implementations
 *      typically wrap {@link OutboxWriter.write}.
 *   2. {@link transition} — apply a status change (and optional
 *      forensic fields like `error`). The implementation wraps
 *      {@link OutboxWriter.update}, which gates every transition
 *      against the §7.0 state-machine validator (T.6.C).
 *
 * **Pre-publish persistence ordering** (§6.3 last paragraph): the
 * orchestrator awaits {@link transition} into `'sending'` BEFORE
 * dispatching the Nostr publish. A crash in between leaves the entry
 * in `'sending'`, which the recovery worker treats as "republish on
 * restart" — recipient idempotency is guaranteed by content-addressing
 * the bundle CID.
 */
export interface OutboxIntegrationHooks {
  /**
   * Persist a freshly-created entry. The orchestrator builds the full
   * payload (no `_schemaVersion` / `lamport` — those are stamped by
   * the writer) and calls this hook exactly once per send attempt.
   *
   * @param entry  Outbox entry shape; status is always `'packaging'`
   *               on create and includes all required fields per
   *               {@link UxfTransferOutboxEntry}.
   */
  readonly create: (entry: OutboxCreateInput) => Promise<void>;
  /**
   * Apply a status transition (and optionally other forensic fields)
   * to an existing entry. Implementations route through
   * {@link OutboxWriter.update}, which validates the arc against the
   * §7.0 transition table — illegal transitions throw
   * `INVALID_OUTBOX_TRANSITION`.
   *
   * @param id      Outbox entry id (the orchestrator's transferId).
   * @param patch   Partial mutation. The mutator-style shape is a
   *                tuple of `(prev) => next` semantics realized at the
   *                callsite as `Partial<UxfTransferOutboxEntry>` —
   *                callers fold these onto the existing entry.
   */
  readonly transition: (id: string, patch: OutboxTransitionPatch) => Promise<void>;
}

/**
 * Input shape for {@link OutboxIntegrationHooks.create}. Mirrors
 * {@link OutboxWriter.write}'s `OutboxWriteInput` — every field of
 * {@link UxfTransferOutboxEntry} except the writer-stamped
 * (`_schemaVersion`, `lamport`) ones, with `updatedAt` optional.
 */
export type OutboxCreateInput = Omit<
  UxfTransferOutboxEntry,
  '_schemaVersion' | 'lamport'
>;

/**
 * Patch shape for {@link OutboxIntegrationHooks.transition}. The
 * orchestrator only mutates the small set of fields required by the
 * §7.0 state machine; production wiring folds the patch via
 * `OutboxWriter.update` so the validator gate fires.
 */
export interface OutboxTransitionPatch {
  /** Required — the §7.0 destination state. */
  readonly status: UxfTransferOutboxEntry['status'];
  /** Optional forensic field — set on `failed-transient` arcs. */
  readonly error?: string;
  /** Optional — bumped by the worker on submit retries. */
  readonly submitRetryCount?: number;
}

/**
 * Dependencies bundle required by {@link sendConservativeUxf}.
 *
 * Field-level docs explain why each surface is callback-shaped: the
 * orchestrator stays decoupled from the surrounding {@link
 * ../PaymentsModule.PaymentsModule} state machine, so unit tests can
 * inject minimal mocks and the production dispatcher can wire the real
 * services without subclassing.
 */
export interface ConservativeSenderDeps {
  /** Aggregator client; consumed by preflight + (indirectly via callbacks)
   *  by the commit step. */
  readonly aggregator: OracleProvider;
  /** Transport provider used to publish the final wire payload. */
  readonly transport: TransportProvider;
  /** Per-address token storage. Currently unused by the orchestrator —
   *  reserved for T.2.D.2 (outbox writer integration) and T.4.A
   *  (CID-pin store). Plumbed through now to avoid a breaking signature
   *  change later. */
  readonly tokenStorage?: TokenStorageProvider<unknown> | null;
  /** Sender's full identity. The orchestrator only reads `chainPubkey`
   *  and `transportPubkey`-derived publishing key; the private key
   *  itself is consumed inside the caller-supplied
   *  {@link CommitSourcesFn}. */
  readonly identity: FullIdentity;
  /** Transport pubkey to attach to the wire envelope's `sender` field
   *  (UNAUTHENTICATED on the wire — see §9.3, T.7.B.5). When omitted,
   *  the sender field is dropped. */
  readonly senderTransportPubkey?: string;
  /** Event emitter — invoked once with `'transfer:confirmed'` on
   *  successful send, once with `'transfer:failed'` on any throw. */
  readonly emit: <T extends SphereEventType>(
    type: T,
    data: SphereEventMap[T],
  ) => void;
  /** Optional IPFS publisher. Required when the resolved delivery
   *  decision is CID-bound (`force-cid`, `auto`-over-cap). When
   *  omitted, CID-bound decisions throw `IPFS_PUBLISHER_MISSING`. */
  readonly publishToIpfs?: PublishToIpfsCallback;
  /** Snapshot of the sender's owned token pool (validated by T.2.B). */
  readonly availableSources: () =>
    | Promise<ReadonlyArray<Token>>
    | ReadonlyArray<Token>;
  /** Source-selection callback — wraps the SpendPlanner. */
  readonly selectSources: SelectSourcesFn;
  /** Builds {@link PreflightFinalizeOptions} for the selected sources. */
  readonly preflightOptions: PreflightOptionsFn;
  /** Submits commitments + awaits proofs for the selected sources. */
  readonly commitSources: CommitSourcesFn;
  /** Optional outbox writer hooks — defaults to no-op when absent
   *  (test convenience). Production wires the real per-entry-key
   *  {@link OutboxWriter} (T.6.A) through {@link OutboxIntegrationHooks}. */
  readonly outbox?: OutboxIntegrationHooks;
  /** Optional projection of `Token` → `TokenLike` for the validator. The
   *  default projection inspects `sdkData` opportunistically; tests can
   *  inject a richer projection. */
  readonly toTokenLike?: (token: Token) => TokenLike;
  /** Transfer ID override (for resumed sends). When omitted, a new UUID
   *  is generated. */
  readonly transferId?: string;
}

// =============================================================================
// 2. Internal helpers
// =============================================================================

/**
 * Sort a list of {@link ConservativeCommitResult} entries by their
 * source `tokenId`, lex-ascending. Used both for the bundle ingest
 * order (acceptance: "Bundle-internal token order is deterministic")
 * AND the {@link TokenTransferDetail} array shipped on the
 * {@link TransferResult}.
 *
 * Lexicographic byte-string compare matches the spec's `lex-min` rule
 * — the SDK-canonical `tokenId` is hex-encoded, so string-compare is
 * byte-equivalent.
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
 * Default {@link Token}-to-{@link TokenLike} projection. Reads the
 * SDK-format `sdkData` JSON if present and surfaces `coinData` as the
 * post-prune {@link TokenLike.coins}. Best-effort: any parse failure
 * falls through to a coin-with-self-amount projection (the validator's
 * pool-coverage path is the consumer of failures here, so the
 * fallback is intentionally permissive — the legitimate SDK shape
 * always has parseable `sdkData`).
 *
 * @internal
 */
function defaultTokenLike(token: Token): TokenLike {
  const fallback: TokenLike = {
    id: token.id,
    coins: [{ coinId: token.coinId, amount: BigInt(token.amount || '0') }],
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
    };
    const genData = parsed?.genesis?.data;
    const tokenId =
      typeof genData?.tokenId === 'string' && genData.tokenId.length > 0
        ? genData.tokenId
        : token.id;
    const coinData = genData?.coinData;
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
      return { id: tokenId, coins: coins.length > 0 ? coins : null };
    }
    // Empty/null coinData → NFT.
    return { id: tokenId, coins: null };
  } catch {
    return fallback;
  }
}

/**
 * Build the initial {@link UxfTransferOutboxEntry} payload (T.2.D.2 —
 * replaces D.1 stub). Status is always `'packaging'` on create per the
 * §7.0 initial state; the orchestrator transitions through the
 * lifecycle via {@link OutboxIntegrationHooks.transition}.
 *
 * The `deliveryMethod` reflects how the bundle was actually shipped:
 *  - `'car-over-nostr'` for inline (`uxf-car`) delivery.
 *  - `'cid-over-nostr'` for CID-bound (`uxf-cid`) delivery.
 *  - `'txf-legacy'` is reserved for the §7.2 migration path; the UXF
 *    sender never emits it.
 *
 * @internal
 */
function buildOutboxCreateInput(params: {
  readonly transferId: string;
  readonly bundleCid: string;
  readonly tokenIds: ReadonlyArray<string>;
  readonly recipientIdentifier: string;
  readonly recipientTransportPubkey: string;
  readonly recipientNametag: string | undefined;
  readonly memo: string | undefined;
  readonly deliveryMethod: 'car-over-nostr' | 'cid-over-nostr';
  readonly now: number;
}): OutboxCreateInput {
  const base: OutboxCreateInput = {
    id: params.transferId,
    bundleCid: params.bundleCid,
    tokenIds: params.tokenIds,
    deliveryMethod: params.deliveryMethod,
    recipient: params.recipientIdentifier,
    recipientTransportPubkey: params.recipientTransportPubkey,
    mode: 'conservative',
    status: 'packaging',
    createdAt: params.now,
    updatedAt: params.now,
    submitRetryCount: 0,
    proofErrorCount: 0,
  };
  // Splice optional fields only when defined — explicit `undefined`
  // muddies CRDT diffs and bloats the on-disk encoding.
  let out: OutboxCreateInput = base;
  if (params.recipientNametag !== undefined) {
    out = { ...out, recipientNametag: params.recipientNametag };
  }
  if (params.memo !== undefined) {
    out = { ...out, memo: params.memo };
  }
  return out;
}

// =============================================================================
// 3. Public API — sendConservativeUxf
// =============================================================================

/**
 * Conservative-mode UXF send orchestrator. Composes Waves T.1 + T.2's
 * pure modules into the full §4.2 sender pipeline.
 *
 * Safe to invoke from any async context. The function does NOT mutate
 * any global state; every side effect is mediated through the injected
 * {@link ConservativeSenderDeps} surface.
 *
 * **Acceptance** (per `docs/uxf/UXF-TRANSFER-IMPL-PLAN.md` §T.2.D.1):
 *  - With `senderUxf=true` flag, conservative-mode sends end-to-end
 *    through UXF wire format with byte-identical CAR for fixed inputs.
 *  - Bundle-internal token order is deterministic (lex-min `tokenId`).
 *  - `transfer:confirmed` event emitted with `tokenTransfers[i].method
 *    === 'split' | 'direct'`.
 *  - **Stub outbox writer**: synthetic legacy entry created.
 *
 * @throws {SphereError} `IPFS_PUBLISHER_MISSING` — caller chose CID-bound
 *         delivery (force-cid or auto-over-cap) without supplying
 *         `publishToIpfs`.
 * @throws {SphereError} `TRANSPORT_ERROR` — the transport's
 *         `sendTokenTransfer` rejected (relay error, oversized payload,
 *         identity mismatch). Auto-fallback to CID delivery on relay
 *         rejection is OUT OF SCOPE for D.1; the error propagates.
 * @throws Any error surfaced by the injected callbacks
 *         (`validateTargets`, `selectSources`, `preflightFinalize`,
 *         `commitSources`, `resolveDelivery`).
 */
export async function sendConservativeUxf(
  request: TransferRequest,
  recipient: PeerInfo,
  deps: ConservativeSenderDeps,
): Promise<TransferResult> {
  const transferId = deps.transferId ?? cryptoRandomUUID();
  const now = Date.now();

  // Mutable working copy — the public TransferResult is `readonly` on
  // most fields, so we project at the end. Until we know which tokens
  // were actually committed, `tokens` and `tokenTransfers` start empty.
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
    // Step 1: validate target list (T.2.B).
    // -----------------------------------------------------------------
    const available = await deps.availableSources();
    const projection = deps.toTokenLike ?? defaultTokenLike;
    const validated = validateTargets(
      request,
      available.map((t) => projection(t)),
    );

    // -----------------------------------------------------------------
    // Step 2: source selection (caller-supplied; wraps SpendPlanner).
    // -----------------------------------------------------------------
    const selected = await deps.selectSources({
      request,
      validated,
      available,
    });
    if (selected.length === 0) {
      throw new SphereError(
        'sendConservativeUxf: source selection returned no tokens; ' +
          'caller must throw INSUFFICIENT_BALANCE before reaching the orchestrator',
        'SEND_INSUFFICIENT_BALANCE',
      );
    }
    result.tokens = [...selected];

    // -----------------------------------------------------------------
    // Step 3: preflight finalize (T.2.A).
    // -----------------------------------------------------------------
    const preflightOpts = deps.preflightOptions({
      selectedSources: selected,
      aggregator: deps.aggregator,
    });
    await preflightFinalize(selected, {
      ...preflightOpts,
      aggregator: deps.aggregator,
    });

    // -----------------------------------------------------------------
    // Step 4: commitments + proofs (caller-supplied; wraps SDK).
    // -----------------------------------------------------------------
    const commitResults = await deps.commitSources({
      sources: selected,
      recipient,
      memo: request.memo,
    });
    if (commitResults.length === 0) {
      throw new SphereError(
        'sendConservativeUxf: commit callback returned zero results; cannot ship empty bundle',
        'TRANSFER_FAILED',
      );
    }

    // Acceptance: deterministic bundle order — lex-ascending by tokenId.
    const orderedResults = sortByTokenIdAsc(commitResults);

    // -----------------------------------------------------------------
    // Step 5: build UxfPackage and ingest tokens.
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
    // Step 7: derive bundle CID from the CAR root.
    // -----------------------------------------------------------------
    const bundleCid = await extractCarRootCid(carBytes);

    // -----------------------------------------------------------------
    // Step 8: resolve delivery (T.2.C). Inline → carBase64 in the
    // payload; CID → publishToIpfs invoked here.
    // -----------------------------------------------------------------
    const strategy: DeliveryStrategy = request.delivery ?? { kind: 'auto' };
    const wantsCidBranch =
      strategy.kind === 'force-cid' ||
      (strategy.kind === 'auto' &&
        carBytes.byteLength >
          (strategy.inlineCapBytes ?? Number.POSITIVE_INFINITY));
    if (wantsCidBranch && deps.publishToIpfs === undefined) {
      // Pre-flight reject: if we KNOW we'll need IPFS but no publisher
      // is wired, fail fast with a clear error rather than letting the
      // resolver throw a generic message after the work has been done.
      throw new SphereError(
        'sendConservativeUxf: delivery strategy requires CID delivery but no publishToIpfs callback was supplied',
        'IPFS_PUBLISHER_MISSING',
      );
    }
    // -----------------------------------------------------------------
    // Step 10a (T.2.D.2): create UXF outbox entry with
    // status='packaging' AS SOON AS the bundle CID is known. The entry
    // identifies the recipient + bundleCid + token list before any
    // transport / IPFS work so a crash here leaves a forensic record.
    // -----------------------------------------------------------------
    const tokenIds = orderedResults.map((r) => r.sourceTokenId);

    // Decide the delivery method up-front using the SAME predicate as
    // resolveDelivery's CID-branch decision (`wantsCidBranch` above).
    // The two are byte-equivalent — if `wantsCidBranch === true` the
    // resolver invokes publishToIpfs and returns a `cid` decision; if
    // false, the resolver returns `inline`. We can therefore stamp the
    // outbox `deliveryMethod` BEFORE calling resolveDelivery and trust
    // that the post-delivery branch matches.
    const predictedDeliveryMethod: 'car-over-nostr' | 'cid-over-nostr' =
      wantsCidBranch ? 'cid-over-nostr' : 'car-over-nostr';

    if (deps.outbox !== undefined) {
      const createInput = buildOutboxCreateInput({
        transferId,
        bundleCid,
        tokenIds,
        recipientIdentifier: request.recipient,
        recipientTransportPubkey: recipient.transportPubkey,
        recipientNametag: recipient.nametag,
        memo: typeof request.memo === 'string' ? request.memo : undefined,
        deliveryMethod: predictedDeliveryMethod,
        now,
      });
      await deps.outbox.create(createInput);
    }

    // -----------------------------------------------------------------
    // Step 8 (cont.): resolveDelivery — invokes publishToIpfs inside
    // for any CID-bound branch.
    // -----------------------------------------------------------------
    const delivery = await resolveDelivery({
      strategy,
      carBytes,
      publishToIpfs:
        deps.publishToIpfs ?? throwingPublishToIpfs,
    });

    // -----------------------------------------------------------------
    // Step 10b: per §7.0 transition table, CID-bound delivery flows
    // packaging → pinned (after IPFS pin acknowledged) → sending.
    // Inline delivery skips the `pinned` state and goes straight to
    // packaging → sending.
    // -----------------------------------------------------------------
    if (delivery.kind === 'cid' && deps.outbox !== undefined) {
      await deps.outbox.transition(transferId, { status: 'pinned' });
    }

    // -----------------------------------------------------------------
    // Step 11: build the wire envelope.
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
            mode: 'conservative',
            bundleCid,
            tokenIds,
            ...(request.memo !== undefined ? { memo: request.memo } : {}),
            ...(senderField !== undefined ? { sender: senderField } : {}),
            carBase64: delivery.carBase64,
          }
        : {
            kind: 'uxf-cid',
            version: '1.0',
            mode: 'conservative',
            bundleCid,
            tokenIds,
            ...(request.memo !== undefined ? { memo: request.memo } : {}),
            ...(senderField !== undefined ? { sender: senderField } : {}),
          };

    // -----------------------------------------------------------------
    // Step 10c (PRE-PUBLISH PERSISTENCE ORDERING — §6.3 last paragraph,
    // T.2.D.2 INVARIANT): the OrbitDB write that sets status='sending'
    // MUST be committed before the Nostr publish is dispatched. A
    // crash between OrbitDB commit and Nostr publish leaves the
    // worker re-publishing on restart (idempotent — same bundleCid →
    // same content-addressed payload).
    // -----------------------------------------------------------------
    if (deps.outbox !== undefined) {
      await deps.outbox.transition(transferId, { status: 'sending' });
    }

    // -----------------------------------------------------------------
    // Step 11 (cont.): publish via transport. The PRE-PUBLISH ordering
    // invariant above means this dispatch happens AFTER the
    // 'sending' commit has hit OrbitDB.
    // -----------------------------------------------------------------
    result.status = 'submitted';
    try {
      // The transport's TokenTransferPayload type is the legacy shape;
      // the `unknown` cast is the documented bridge until T.2.E widens
      // it to a tagged union (see plan §T.2.E).
      await deps.transport.sendTokenTransfer(
        recipient.transportPubkey,
        payload as unknown as TokenTransferPayload,
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // §7.0 arc: sending → failed-transient. Best-effort — if the
      // outbox transition itself fails we still surface the underlying
      // transport error to the caller.
      if (deps.outbox !== undefined) {
        try {
          await deps.outbox.transition(transferId, {
            status: 'failed-transient',
            error: message,
          });
        } catch {
          // Outbox transition failure is informational at this point;
          // the caller's transfer:failed event + thrown SphereError
          // remain the primary signals.
        }
      }
      throw new SphereError(
        `sendConservativeUxf: transport.sendTokenTransfer failed: ${message}`,
        'TRANSPORT_ERROR',
        cause,
      );
    }

    // -----------------------------------------------------------------
    // After-publish bookkeeping: §7.0 arc sending → delivered. The
    // entry stays in the outbox until the retention window expires
    // (delivered → expired) — the orchestrator does NOT delete it.
    // -----------------------------------------------------------------
    if (deps.outbox !== undefined) {
      try {
        await deps.outbox.transition(transferId, { status: 'delivered' });
      } catch {
        // The wire publish succeeded; outbox post-write is best-effort.
        // The merger / retention path repairs lingering 'sending'
        // entries on next read.
      }
    }

    // Project the per-source token transfer details onto the result.
    result.tokenTransfers = orderedResults.map(
      (r): TokenTransferDetail => ({
        sourceTokenId: r.sourceTokenId,
        method: r.method,
        ...(r.requestIdHex !== undefined
          ? { requestIdHex: r.requestIdHex }
          : {}),
        ...(r.splitGroupId !== undefined
          ? { splitGroupId: r.splitGroupId }
          : {}),
      }),
    );

    result.status = 'completed';

    // -----------------------------------------------------------------
    // Step 12: emit transfer:confirmed.
    // -----------------------------------------------------------------
    deps.emit('transfer:confirmed', result as TransferResult);
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
 * Standalone UUID v4 generator. Defers to `globalThis.crypto.randomUUID`
 * when present (Node 19+, modern browsers); falls back to a bytes-based
 * generator using `globalThis.crypto.getRandomValues` for older runtimes.
 *
 * The orchestrator is callable from both browser and Node.js; we avoid
 * importing `node:crypto` directly to stay platform-neutral.
 *
 * @internal
 */
function cryptoRandomUUID(): string {
  const g = globalThis as { crypto?: Crypto };
  if (g.crypto && typeof g.crypto.randomUUID === 'function') {
    return g.crypto.randomUUID();
  }
  // RFC 4122 §4.4 random-bytes fallback. Vanishingly rare on supported
  // runtimes (Node 19+ has randomUUID), but defensive for partial polyfills.
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
    'sendConservativeUxf: no source of randomness — refusing to generate transferId',
    'INVALID_CONFIG',
  );
}

/**
 * Fallback `publishToIpfs` callback used when the caller passes no
 * `publishToIpfs` and the resolver UNEXPECTEDLY tries to invoke it
 * (e.g., a bundle slipped just over the cap after the pre-flight
 * check). The pre-flight guard above catches the typical case; this
 * exists as a defense-in-depth backstop.
 *
 * @internal
 */
const throwingPublishToIpfs: PublishToIpfsCallback = async (): Promise<PublishToIpfsResult> => {
  throw new SphereError(
    'sendConservativeUxf: resolveDelivery requested CID delivery but no publishToIpfs callback was supplied',
    'IPFS_PUBLISHER_MISSING',
  );
};
