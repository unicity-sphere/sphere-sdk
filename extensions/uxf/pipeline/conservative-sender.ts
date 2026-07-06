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
 *  9. **IPFS pin** (T.4.A) — for the CID branch the orchestrator
 *     EAGERLY transitions outbox `packaging → pinned` BEFORE invoking
 *     {@link resolveDelivery}. The resolver then calls the injected
 *     `publishToIpfs` callback (which performs the actual pin). Pin
 *     idempotency is delegated to the IPFS HTTP layer (Kubo's
 *     `/api/v0/add?pin=true` and Helia's `pinning.add` are no-ops on
 *     already-pinned CIDs — content-addressing guarantees the same
 *     CAR maps to the same CID). On pin failure, the orchestrator
 *     transitions `pinned → failed-permanent` (the T.4.A arc added in
 *     this wave to §7.0) and re-throws — Nostr publish is NEVER
 *     dispatched on the pin-failure arc (§3.3.2 invariant).
 * 10. **Outbox bookkeeping** (T.2.D.2) — the per-entry-key
 *     {@link UxfTransferOutboxEntry} writer threads through
 *     {@link OutboxIntegrationHooks}. Lifecycle:
 *       * inline:  packaging → sending → delivered.
 *       * cid OK:  packaging → pinned → sending → delivered.
 *       * cid err: packaging → pinned → failed-permanent (no publish).
 * 11. {@link TransportProvider.sendTokenTransfer} — publish the wire
 *     payload over the transport layer. For CID payloads the optional
 *     `senderGateways` hint (sourced from {@link
 *     ConservativeSenderDeps.senderGateways}) is stamped onto the
 *     envelope for INFORMATIONAL purposes only (recipient walks its
 *     own configured list per §3.3 / §9.2).
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
 *  - §3.3.2 Pin/Nostr ordering — Nostr publish MUST NOT happen on
 *           permanent pin failure (T.4.A invariant).
 *  - §7.0  Outbox state machine (T.4.A `pinned → failed-permanent`
 *          arc).
 *
 * @module modules/payments/transfer/conservative-sender
 * @internal
 */

import { SphereError } from '../../../core/errors';
import { logger } from '../../../core/logger';
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
import { UxfPackage } from '../bundle/UxfPackage';
import { extractCarRootCid } from '../bundle/transfer-payload';

import type { TokenLike } from './classify-token';
import type { PublishToIpfsCallback } from './delivery-resolver';
import { resolveDelivery } from './delivery-resolver';
import { enforceOverTransferGuard } from './over-transfer-guard';
import {
  AUTOMATED_CID_DELIVERY_ENABLED,
  MAX_INLINE_CAR_BYTES,
  RELAY_SAFE_CAP_BYTES,
} from './limits';
import {
  preflightFinalize,
  type PreflightFinalizeOptions,
} from './preflight-finalize';
import { validateTargets, type ValidatedTargets } from './target-validator';
import { acquireSourceLocks } from './source-locks';

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
/**
 * #142/#149 contract widening — source selection carries `splitSources`
 * intent. Mirrors {@link
 * import('./instant-sender').InstantSourceSelection} for the
 * conservative path. The split executor differs
 * (`TokenSplitExecutor` instead of `InstantSplitExecutor`) but the
 * contract shape is identical.
 */
export interface ConservativeSourceSelection {
  readonly directSources: ReadonlyArray<Token>;
  /**
   * Zero or more sources to split. See {@link
   * import('./instant-sender').InstantSourceSelection.splitSources}
   * for the full invariants (distinct coinIdHex, distinct token.id,
   * disjoint from directSources, splitAmount + remainderAmount =
   * coin balance).
   */
  readonly splitSources?: ReadonlyArray<{
    readonly token: Token;
    readonly splitAmount: bigint;
    readonly remainderAmount: bigint;
    readonly coinIdHex: string;
  }>;
}

export type CommitSourcesFn = (params: {
  readonly sources: ReadonlyArray<Token>;
  /** #142/#149 — split intents. See InstantCommitSourcesFn for rationale. */
  readonly splitSources?: ConservativeSourceSelection['splitSources'];
  readonly recipient: PeerInfo;
  readonly memo: string | undefined;
}) => Promise<ReadonlyArray<ConservativeCommitResult>>;

/**
 * Caller-supplied source-selection callback. Wraps the existing
 * {@link ../SpendQueue.SpendPlanner} (production) or returns the test's
 * pre-chosen sources (unit). Receives the validated target list so
 * future revisions can do per-target routing (e.g., NFT-direct + coin-
 * split mixes).
 *
 * #142 widening: backwards-compatible — return either the legacy array
 * shape or the new {@link ConservativeSourceSelection}.
 */
export type SelectSourcesFn = (params: {
  readonly request: TransferRequest;
  readonly validated: ValidatedTargets;
  readonly available: ReadonlyArray<Token>;
}) => Promise<ReadonlyArray<Token> | ConservativeSourceSelection>;

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
  /**
   * Issue #166 P2 #3 — Nostr event id returned by the relay's OK ack.
   * Captured at the `sending → delivered{,-instant}` arc and persisted
   * to the OUTBOX entry. Propagates to SENT via
   * {@link PaymentsModule.writeSentEntryFromOutbox} so the
   * `NostrPersistenceVerifier` worker can re-query the relay later to
   * detect retention drops.
   *
   * Optional — pre-#166 entries lacked this field; the SENT type
   * guard accepts `undefined` here as the legacy default.
   */
  readonly nostrEventId?: string;
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
  /**
   * Optional gateway hint set the sender used to pin / make the bundle
   * retrievable. Stamped onto the wire payload as
   * `UxfTransferPayloadCid.senderGateways` for INFORMATIONAL purposes
   * only (recipient walks its OWN configured list per the verified-CAR
   * pipeline; spec §3.3 / §9.2 — sender list is unauthenticated).
   *
   * Sourced from the surrounding `PaymentsModule` config (the gateway
   * list backing the `IpfsHttpClient`). Empty array when the publisher
   * is configured without a gateway list — the field is omitted from
   * the wire payload entirely in that case to keep the envelope tight
   * and the canonical-order rules satisfied.
   *
   * Ignored for inline (`uxf-car`) deliveries — the field is part of the
   * `uxf-cid` shape only.
   */
  readonly senderGateways?: ReadonlyArray<string>;
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
  /**
   * **TEST-ONLY** fault-injection seam. The `__` prefix is intentional —
   * this is NOT a stable public API and MUST NOT be used in production
   * wiring. Used exclusively by the T.6.E crash-recovery harness to
   * deterministically simulate process death between the §6.3-mandated
   * persistence checkpoints, without resorting to sleep loops or real
   * SIGKILLs.
   *
   * Hook firing points (mapped onto the §7.0 sender pipeline):
   *  - {@link afterOutboxCommitSending} — fires AFTER the OrbitDB write
   *    that sets `status='sending'` returns successfully, and BEFORE
   *    {@link TransportProvider.sendTokenTransfer} is dispatched. A throw
   *    here simulates a crash exactly at the §6.3 ordering boundary.
   *  - {@link afterTransportAck} — fires AFTER the transport's
   *    `sendTokenTransfer` returns successfully, and BEFORE the OrbitDB
   *    write that sets `status='delivered'`. A throw here simulates a
   *    crash where the recipient already saw the bundle but the sender
   *    has not durably recorded delivery.
   *
   * The hooks are awaited; thrown errors propagate through the normal
   * try/catch and trigger the `transfer:failed` path. The orchestrator
   * does NOT swallow them — that would defeat the purpose of fault
   * injection.
   */
  readonly __faultInject?: FaultInjectionHooks;
  /**
   * **TEST-ONLY** override for the source-lock max-hold timeout
   * (Audit #333 H1). Defaults to 60_000ms in production; tests override
   * to a smaller value to exercise the force-release path without
   * burning real wall-clock seconds. Symmetric with
   * `InstantSenderDeps.__sourceLockMaxHoldMs`.
   *
   * @internal Test seam only.
   */
  readonly __sourceLockMaxHoldMs?: number;
  /**
   * Lock the bundle envelope's `createdAt` timestamp (UNIX
   * milliseconds) for cross-attempt determinism. Symmetric with
   * `InstantSenderDeps.bundleCreatedAt` — see that field for the
   * full rationale. Production workers pass the persisted outbox
   * entry's `createdAt` on **resume** so the rebuilt bundle bytes
   * (and `bundleCid`) reproduce the original first-attempt values.
   */
  readonly bundleCreatedAt?: number;
}

/**
 * **TEST-ONLY** fault-injection hook surface. See
 * {@link ConservativeSenderDeps.__faultInject} for semantics.
 *
 * Implementations typically `throw new Error('SIMULATED_CRASH')` to halt
 * the orchestrator at a precise, deterministic checkpoint. Async hooks
 * are awaited.
 *
 * @internal Test seam only.
 */
export interface FaultInjectionHooks {
  /** Fires after the `sending` outbox commit, before transport publish. */
  readonly afterOutboxCommitSending?: () => void | Promise<void>;
  /** Fires after transport ack, before the `delivered` outbox commit. */
  readonly afterTransportAck?: () => void | Promise<void>;
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
  // Steelman fix (#170 issue 3): match the instant-sender's projection
  // exactly. Walk `transactions[]` to detect any unfinalized predecessor
  // (`inclusionProof: null`) so the W11 `confirmNftPending` check fires
  // BEFORE preflight finalize attempts to clear the chain. Even though
  // conservative mode runs preflight, the validator must see the
  // pre-finalize pending state so the user receives the irrecoverable-
  // cascade warning before the SDK touches the network.
  const fallbackPending = token.status === 'transferring' || token.status === 'submitted';
  const fallback: TokenLike = {
    id: token.id,
    coins: [{ coinId: token.coinId, amount: BigInt(token.amount || '0') }],
    pending: fallbackPending,
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
    let pending = fallbackPending;
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
  // Lock the timestamp once at the start; use caller-supplied
  // `bundleCreatedAt` on resume so the bundleCid reproduces the
  // original. See `ConservativeSenderDeps.bundleCreatedAt`.
  const now = deps.bundleCreatedAt ?? Date.now();

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

  // Audit #333 H1 — same-process source-lock seam, symmetric with
  // sendInstantUxf. Bound to `null` until selection completes; released
  // in the outer `finally`. See `./source-locks.ts` for the rationale.
  let releaseSourceLocks: (() => void) | null = null;

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
    const selectedRaw = await deps.selectSources({
      request,
      validated,
      available,
    });

    // #142/#149 contract widening — normalize legacy array-shape into
    // the structured {directSources, splitSources} form.
    // Backwards-compatible with existing array callers.
    const normalizedSelection: ConservativeSourceSelection = Array.isArray(selectedRaw)
      ? { directSources: selectedRaw as ReadonlyArray<Token>, splitSources: [] }
      : (selectedRaw as ConservativeSourceSelection);
    const splitSources = normalizedSelection.splitSources ?? [];

    // #149 defense-in-depth — same invariants as sendInstantUxf above.
    // See instant-sender.ts for the full rationale.
    const seenSplitCoinIds = new Set<string>();
    const seenSplitTokenIds = new Set<string>();
    for (const entry of splitSources) {
      if (seenSplitCoinIds.has(entry.coinIdHex)) {
        throw new SphereError(
          `sendConservativeUxf: splitSources contains duplicate coinIdHex=${entry.coinIdHex.slice(0, 32)}; ` +
            'multi-asset planner must produce at most one split entry per coin class',
          'INVALID_CONFIG',
        );
      }
      seenSplitCoinIds.add(entry.coinIdHex);
      if (seenSplitTokenIds.has(entry.token.id)) {
        throw new SphereError(
          `sendConservativeUxf: splitSources contains duplicate token.id=${entry.token.id} (planner bug)`,
          'INVALID_CONFIG',
        );
      }
      seenSplitTokenIds.add(entry.token.id);
    }
    for (const direct of normalizedSelection.directSources) {
      if (seenSplitTokenIds.has(direct.id)) {
        throw new SphereError(
          `sendConservativeUxf: token.id=${direct.id} appears in BOTH directSources and splitSources (planner bug)`,
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
        'sendConservativeUxf: source selection returned no tokens; ' +
          'caller must throw INSUFFICIENT_BALANCE before reaching the orchestrator',
        'SEND_INSUFFICIENT_BALANCE',
      );
    }
    result.tokens = [...selected];

    // -----------------------------------------------------------------
    // Step 2.5 (Audit #333 H1): acquire per-source in-memory locks.
    //
    // Mirrors the instant-sender pattern (Wave 4 #171). Held across the
    // entire preflight → commit → transport → mark sequence so two
    // parallel sendConservativeUxf calls (or one conservative + one
    // instant) sharing source tokens cannot both pass selection and
    // race to commit on-chain. Without this, the aggregator catches
    // the duplicate-spend after a source is already burned, leaving
    // the loser's outbox in a recoverable-but-broken state.
    //
    // Locks acquired in lex-sorted order of tokenId (deadlock-prevention
    // discipline shared with instant-sender). Released in the outer
    // `finally` regardless of success/failure.
    // -----------------------------------------------------------------
    const sourceTokenIds = selected.map((t) => t.id);
    releaseSourceLocks = await acquireSourceLocks(
      sourceTokenIds,
      deps.__sourceLockMaxHoldMs,
      'sendConservativeUxf',
    );

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
    // #142/#149: forward `splitSources` so commitSources can drive the
    // appropriate split executor — one invocation per entry for
    // multi-coin partial-amount sends.
    // -----------------------------------------------------------------
    const commitResults = await deps.commitSources({
      sources: selected,
      splitSources,
      recipient,
      memo: request.memo,
    });
    if (commitResults.length === 0) {
      throw new SphereError(
        'sendConservativeUxf: commit callback returned zero results; cannot ship empty bundle',
        'TRANSFER_FAILED',
      );
    }

    // Loop1-S6 — OVER_TRANSFER_GUARD. The same defense-in-depth that
    // sendInstantUxf applies. A buggy commitSources that whole-token-
    // transfers a source that should have been split silently
    // over-sends — the wire bundle has more coin amount than the
    // request asked for. The conservative path has the same risk
    // class as the instant path (FIX 3 wires TokenSplitExecutor into
    // dispatchUxfConservativeSend.commitSources; a regression here
    // would not be caught without this guard). Throws fire-closed
    // (Loop1-S5) on any structural break in coinData too.
    enforceOverTransferGuard(request, commitResults);

    // Acceptance: deterministic bundle order — lex-ascending by tokenId.
    const orderedResults = sortByTokenIdAsc(commitResults);

    // Loop4-e2e (round 2) + L5-C1/C2 — validate AND extract the
    // recipient tokenIds for payload.tokenIds BEFORE pkg.ingestAll
    // so misshapen commit results surface as clean SphereErrors
    // rather than vague UXF deconstruct errors. Fail-closed on
    // missing/non-hex; lowercase-normalize. See instant-sender.ts
    // for the full rationale.
    const tokenIds = orderedResults.map((r): string => {
      const j = r.recipientTokenJson as {
        readonly genesis?: { readonly data?: { readonly tokenId?: unknown } };
      } | null | undefined;
      const tid = j?.genesis?.data?.tokenId;
      if (typeof tid !== 'string' || !/^[0-9a-f]{64}$/i.test(tid)) {
        throw new SphereError(
          `sendConservativeUxf: recipientTokenJson.genesis.data.tokenId for source ${r.sourceTokenId} ` +
            `is missing or not 64-char hex (got ${typeof tid === 'string' ? `"${tid.slice(0, 32)}…"` : typeof tid}). ` +
            'The recipient bundle verifier would silently drop the transfer as an advisory unclaimed root.',
          'INVALID_CONFIG',
        );
      }
      return tid.toLowerCase();
    });

    // -----------------------------------------------------------------
    // Step 5: build UxfPackage and ingest tokens.
    // -----------------------------------------------------------------
    const envelopeStamp = Math.floor(now / 1000);
    const pkg = UxfPackage.create({
      description: 'inter-wallet-transfer',
      creator: deps.identity.chainPubkey,
      // Lock the envelope timestamp to the pinned `now` so the
      // bundleCid is deterministic across crash-restart retries.
      createdAt: envelopeStamp,
    });
    // Also lock updatedAt to prevent ingestAll from drifting it.
    pkg.ingestAll(
      orderedResults.map((r) => r.recipientTokenJson),
      { updatedAt: envelopeStamp },
    );

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
    // Issue #394 — see instant-sender.ts for the full doc. Default cap
    // is RELAY_SAFE_CAP_BYTES (96 KiB, Nostr cap), not the pre-#394
    // MAX_INLINE_CAR_BYTES (16 KiB) — promotion trips near the relay
    // ceiling so CID delivery is reserved for bundles that truly need it.
    const wantsCidBranch = AUTOMATED_CID_DELIVERY_ENABLED
      ? strategy.kind === 'force-cid' ||
        (strategy.kind === 'auto' &&
          carBytes.byteLength >
            (strategy.inlineCapBytes ?? RELAY_SAFE_CAP_BYTES))
      : strategy.kind === 'force-cid';
    if (wantsCidBranch && deps.publishToIpfs === undefined) {
      // Pre-flight reject: bundle needs CID delivery and no publisher
      // is wired. Fail fast here rather than letting `resolveDelivery`
      // surface the error after all the work has already been done.
      //
      // **Steelman fix (Wave 3) — privacy regression hardening.** The
      // resolver now distinguishes two no-publisher cases:
      //
      //   - `force-cid` + no publisher (any size) → hard-fail with
      //     `FORCE_CID_NO_PUBLISHER`. The caller's explicit privacy
      //     intent (CID-only, no inline leak) cannot be silently
      //     downgraded.
      //   - `auto`-over-cap + no publisher → fall back to inline if
      //     the bundle fits within `RELAY_SAFE_CAP_BYTES` (approach γ);
      //     hard-fail with `IPFS_PUBLISHER_REQUIRED` if not.
      //
      // Mirror those branches at pre-flight so the orchestrator does
      // not waste cycles building a CAR it cannot ship.
      if (strategy.kind === 'force-cid') {
        throw new SphereError(
          'sendConservativeUxf: force-cid strategy explicitly requires a' +
            ' publishToIpfs callback. The orchestrator REFUSES to silently' +
            ' downgrade to inline delivery because force-cid signals a' +
            ' privacy intent (the caller does NOT want the bundle inlined' +
            " on the relay). Wire an IPFS publisher or switch to 'auto' /" +
            " 'force-inline' if inline delivery is acceptable.",
          'FORCE_CID_NO_PUBLISHER',
        );
      }
      if (carBytes.byteLength > RELAY_SAFE_CAP_BYTES) {
        throw new SphereError(
          'sendConservativeUxf: delivery strategy requires CID delivery, no publishToIpfs' +
            ` callback was supplied, and the CAR (${carBytes.byteLength} bytes) exceeds` +
            ` the relay-safe inline ceiling of ${RELAY_SAFE_CAP_BYTES} bytes.` +
            ' Configure an IPFS provider to send large bundles.',
          'IPFS_PUBLISHER_REQUIRED',
        );
      }
      // auto-over-cap + bundle fits within RELAY_SAFE_CAP_BYTES:
      // resolveDelivery will apply the CAR-inline fallback transparently.
      // No pre-flight throw.
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
        `sendConservativeUxf: bundle is ${carBytes.byteLength} bytes, exceeds the ` +
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
    // Step 10a (T.2.D.2): create UXF outbox entry with
    // status='packaging' AS SOON AS the bundle CID is known. The entry
    // identifies the recipient + bundleCid + token list before any
    // transport / IPFS work so a crash here leaves a forensic record.
    // -----------------------------------------------------------------
    // `tokenIds` was computed above (right after sortByTokenIdAsc),
    // BEFORE pkg.ingestAll, with L5-C1/C2 fail-closed validation +
    // lowercase normalization. Reuse it here.

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
    // Step 8 (cont.) / 10b: T.4.A — eager transition into `pinned` for
    // the CID branch BEFORE the IPFS pin call.
    //
    // The §7.0 transition table forbids `packaging → failed-permanent`
    // and `packaging → failed-transient` (legal arcs out of `packaging`
    // are only `pinned` and `sending`). To honour the impl plan T.4.A
    // acceptance ("pin failure → outbox `pinned → failed-permanent`")
    // and §3.3.2 ("on permanent pin failure, outbox transitions to
    // `failed-permanent`"), we MUST be in `pinned` at the moment the
    // pin call is dispatched. The arc semantics here read as:
    //
    //   `pinned` := "the IPFS pin step is in flight or has completed".
    //
    // On pin success → continue (existing flow into `sending`).
    // On pin failure → transition `pinned → failed-permanent` (the
    //                  T.4.A arc added in this wave to §7.0) and
    //                  re-throw. The Nostr publish is NEVER dispatched.
    //
    // For inline (`uxf-car`) deliveries the pin step does not run; the
    // `pinned` state is skipped entirely and we go straight to
    // `packaging → sending` below.
    // -----------------------------------------------------------------
    if (wantsCidBranch && deps.outbox !== undefined) {
      await deps.outbox.transition(transferId, { status: 'pinned' });
    }

    // -----------------------------------------------------------------
    // Step 8 (cont.): resolveDelivery — invokes publishToIpfs inside
    // for any CID-bound branch.
    //
    // Idempotency strategy (T.4.A note + impl plan §risks): the
    // `publishToIpfs` callback MUST be safely re-runnable for the same
    // CAR bytes — both Kubo's `/api/v0/add?pin=true` and Helia's
    // `pinning.add` are idempotent at the HTTP layer (re-pinning an
    // already-pinned CID is a no-op; the resulting CID is content-
    // addressed so a duplicate add yields the same Hash). We rely on
    // that property rather than issuing a separate `pin/status` query
    // — the §3.3.2 paragraph already notes that the outbox pipeline
    // may have pinned the bundle already, in which case the publish
    // call here is the no-op tail of the same idempotent operation.
    // -----------------------------------------------------------------
    let delivery: Awaited<ReturnType<typeof resolveDelivery>>;
    try {
      delivery = await resolveDelivery({
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
    } catch (cause) {
      // Pin (or any resolveDelivery step) threw on the CID branch.
      // §3.3.2 invariant: Nostr publish MUST NOT happen if pin fails.
      // The eager `packaging → pinned` transition above means we are
      // currently in `pinned`; the arc `pinned → failed-permanent`
      // (T.4.A; §7.0) records the permanent failure forensically.
      //
      // Inline (force-inline) failures (e.g., `INLINE_CAR_TOO_LARGE`)
      // come through this same try block but never set `pinned` because
      // the eager transition above gates on `wantsCidBranch`. For those
      // we leave the entry in `packaging` (existing T.2.D.2 behaviour:
      // outer catch will surface `transfer:failed`; the entry remains
      // forensic at `packaging`).
      if (wantsCidBranch && deps.outbox !== undefined) {
        const message = cause instanceof Error ? cause.message : String(cause);
        try {
          await deps.outbox.transition(transferId, {
            status: 'failed-permanent',
            error: message,
          });
        } catch {
          // Outbox transition failure is informational; the underlying
          // pin error is the primary signal. The outer catch still
          // emits transfer:failed and re-throws the original cause.
        }
      }
      throw cause;
    }

    // -----------------------------------------------------------------
    // Step 8.5: OUTBOX-SEND-FOLLOWUPS Item #6.a — fire-and-forget
    // local IPFS pin on the inline path.
    //
    // When `delivery.kind === 'inline'` AND the resolver flagged the
    // decision with `shouldPin: true` (which happens iff a publisher
    // is wired), additionally pin the SAME content-addressed CAR
    // bytes to the local IPFS node. The wire delivery stays inline
    // (`uxf-car`); the pin is independent best-effort durability so
    // Item #2's retention re-publish closure can downgrade
    // `'car-over-nostr'` re-publishes to CID-shape later (the pin
    // guarantees the CID is fetchable).
    //
    // Strictly fire-and-forget:
    //  - Pin failure MUST NOT block the send (wire delivery is
    //    already inline — recipient is not waiting on the pin).
    //  - The pin runs in parallel with the rest of the wire-envelope
    //    construction below; we don't await it anywhere.
    //  - Idempotent: re-running publishToIpfs for the same CAR is a
    //    no-op at the IPFS layer (content-addressed).
    //
    // Defensive: only fires when both signals agree
    // (`shouldPin === true` from the resolver AND `deps.publishToIpfs`
    // is present at call time). This double-gate protects against a
    // future refactor that detaches the publisher between the
    // resolver call and this point.
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
          // Fire-and-forget: log and swallow. The inline wire delivery
          // is unaffected — the recipient gets the CAR via the Nostr
          // event regardless. The lost-pin trade-off only matters for
          // Item #2's CAR-mode retention re-publish, which retains its
          // defensive throw arc for entries without a live local pin.
          const message =
            pinErr instanceof Error ? pinErr.message : String(pinErr);
          logger.warn(
            'Payments',
            `sendUxfConservative: best-effort inline-CAR pin failed (Item #6.a) — wire send unaffected; ` +
              `Item #2 retention re-publish for this entry will fall back to the defensive arc. ` +
              `bundleCid=${bundleCid} cause=${message}`,
          );
        });
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

    // T.4.A — `senderGateways` hint stamped on the wire payload for
    // CID-bound deliveries only. The list is INFORMATIONAL (recipient
    // walks its own configured gateway list per §3.3 / §9.2 — sender
    // list is unauthenticated). Empty / missing list → field omitted
    // entirely from the envelope to keep the canonical-order output
    // tight and avoid emitting a redundant empty array.
    const senderGatewaysHint =
      deps.senderGateways !== undefined && deps.senderGateways.length > 0
        ? [...deps.senderGateways]
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
            ...(senderGatewaysHint !== undefined
              ? { senderGateways: senderGatewaysHint }
              : {}),
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

    // TEST-ONLY fault-injection seam: simulate process death between
    // outbox commit and Nostr publish (§6.3 last-paragraph crash window).
    if (deps.__faultInject?.afterOutboxCommitSending !== undefined) {
      await deps.__faultInject.afterOutboxCommitSending();
    }

    // -----------------------------------------------------------------
    // Step 11 (cont.): publish via transport. The PRE-PUBLISH ordering
    // invariant above means this dispatch happens AFTER the
    // 'sending' commit has hit OrbitDB.
    // -----------------------------------------------------------------
    result.status = 'submitted';
    // Issue #166 P2 #3 — capture the Nostr event id returned by the
    // relay's OK ack so the post-publish `delivered` transition can
    // persist it. The verifier worker re-queries by event id later to
    // detect retention drops.
    let nostrEventId: string | undefined;
    try {
      // T.2.E widened TokenTransferPayload to UxfTransferPayload; pass
      // the typed payload directly.
      nostrEventId = await deps.transport.sendTokenTransfer(
        recipient.transportPubkey,
        payload,
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

    // TEST-ONLY fault-injection seam: simulate process death between
    // transport ack and the post-ack outbox transition. A crash here
    // leaves the entry stuck in 'sending' — the worker will resume on
    // restart, and idempotency at the recipient is guaranteed by the
    // content-addressed bundleCid (replay-LRU dedupe per T.3.A).
    if (deps.__faultInject?.afterTransportAck !== undefined) {
      await deps.__faultInject.afterTransportAck();
    }

    // -----------------------------------------------------------------
    // After-publish bookkeeping: §7.0 arc sending → delivered. The
    // entry stays in the outbox until the retention window expires
    // (delivered → expired) — the orchestrator does NOT delete it.
    // -----------------------------------------------------------------
    if (deps.outbox !== undefined) {
      try {
        await deps.outbox.transition(transferId, {
          status: 'delivered',
          // Issue #166 P2 #3 — propagate the captured event id so the
          // OUTBOX entry (and via writeSentEntryFromOutbox the SENT
          // ledger) records the relay's id for later persistence
          // verification. Omitted when undefined.
          ...(typeof nostrEventId === 'string' && nostrEventId.length > 0
            ? { nostrEventId }
            : {}),
        });
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
  } finally {
    // Audit #333 H1: release per-source locks regardless of success or
    // failure. Bound to `null` until selection completes; if we threw
    // before locks were acquired (e.g. validateTargets rejection, empty
    // selection) there is nothing to release.
    if (releaseSourceLocks !== null) {
      releaseSourceLocks();
    }
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

