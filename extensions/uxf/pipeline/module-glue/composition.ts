/**
 * Composition factories — Phase 5 [B] extraction from PaymentsModule.ts.
 *
 * Module-scope factory functions that compose the default
 * auto-installed workers/runners `PaymentsModule.initialize()` wires up
 * when the bootstrap layer has not already plugged in production-grade
 * adapters. Each factory returns a fully-assembled worker/runner with
 * lightweight in-memory adapters (Map/Set-backed manifest, tombstone,
 * queue, and pool shims) — sufficient to drive the §6.1 finalization
 * cycle to completion in dev/test wallets without a Profile+OrbitDB
 * stack.
 *
 * These are true module-scope helpers — they receive their host state
 * (Maps, callbacks) through `opts` and never touch the PaymentsModule
 * instance. No host-shim is required (contrast with the OUTBOX ops
 * extraction in {@link ./outbox-ops}); the facade just imports and
 * calls the factories directly.
 *
 * See uxfv2-phase-5-payments-disposition.md §"Module-scope composition
 * factories" for the disposition entries this file satisfies.
 */

import type { Token, SphereEventType, SphereEventMap } from '../../../../types';
import { logger } from '../../../../core/logger';
import { SphereError } from '../../../../core/errors';
// eslint-disable-next-line no-restricted-imports
import { Token as SdkToken } from '@unicitylabs/state-transition-sdk/lib/token/Token';
// eslint-disable-next-line no-restricted-imports
import { TransferTransaction } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction';
// eslint-disable-next-line no-restricted-imports
import type { StateTransitionClient } from '@unicitylabs/state-transition-sdk/lib/StateTransitionClient';
import {
  FinalizationWorkerSender,
  CountingSemaphore,
  type FinalizationAggregatorClient,
  type FinalizationOutboxWriter,
  type RequestContextResolver,
  type RequestContext,
  type SubmitOutcome,
  type PollOutcome,
} from '../finalization-worker-sender';
import {
  FinalizationWorkerRecipient,
  type FinalizationDispositionWriter,
  type RevaluateHooksProvider,
} from '../finalization-worker-recipient';
import { FinalizationQueue } from '../finalization-queue';
import {
  CascadeWalker,
  type CascadeManifestScanner,
  type CascadeOutboxScanner,
  type ClassifyTokenLookup,
} from '../cascade-walker';
import { ManifestCas, type MinimalManifestStorage } from '../../profile/manifest-cas';
import { PerTokenMutex } from '../../profile/per-token-mutex';
import {
  InclusionProofImporter,
} from '../import-inclusion-proof';
import {
  RevalidateCascadedRunner,
} from '../revalidate-cascaded';
import {
  InMemoryDispositionStorageAdapter,
} from '../../profile/disposition-storage-adapters';
import { ManifestStore } from '../../profile/manifest-store';
import { Lamport } from '../../profile/lamport';
import type { TokenManifestEntry } from '../../profile/token-manifest';
import type { CascadeManifestScanner as CascadeManifestScannerForRevalidate } from '../cascade-walker';
import type { ProofVerifyStatus } from '../proof-verifier';
import { contentHash, type ContentHash } from '../../bundle/types';
import type { UxfTransferOutboxEntry } from '../../types/uxf-outbox';

/**
 * Task #151 — per-tokenId finalization context stashed by the default
 * processToken closure on instant-mode receive. Consumed by the
 * recipient finalization worker's dispositionWriter callback to
 * rebuild the locally-stored Token with the attached proof.
 *
 * Lifecycle:
 *  - WRITE: processToken closure (instant path), once per token.
 *  - READ:  dispositionWriter VALID branch, after the worker has
 *           polled the aggregator and called the pool's attachProof.
 *  - DELETE: same dispositionWriter branch on success.
 *
 * @internal
 */
export interface RecipientFinalizationContext {
  /** Local Token id (from `addToken`); used to find Bob's stored
   *  pending Token by `this.tokens.get(localTokenId)`. */
  readonly localTokenId: string;
  /** SDK source token JSON (state N-1) — needed to re-run
   *  `finalizeTransferToken` once the proof lands. */
  readonly sourceTokenJson: unknown;
  /** Last-tx JSON from the bundle (carries `inclusionProof: null`).
   *  The dispositionWriter callback patches this to use the actual
   *  proof returned by the aggregator before re-running finalization. */
  readonly lastTxJson: Record<string, unknown>;
  /** Aggregator request id hex used to look up the proof. */
  readonly requestIdHex: string;
}

// =============================================================================
// Phase 9.6.D — Default FinalizationWorkerSender factory
// =============================================================================

/**
 * Build the default auto-installed {@link FinalizationWorkerSender} for
 * {@link PaymentsModule.initialize}. Uses lightweight in-memory adapters
 * for the pool/manifest/tombstone/queue 4-step write order (no OrbitDB
 * required). Sufficient for §6.1 cycle completion and `transfer:confirmed`
 * emission.
 *
 * @internal — exported only for unit-test access.
 */
export function buildDefaultFinalizationWorkerSender(opts: {
  readonly addressId: string;
  readonly oracle: import('../../../../oracle').OracleProvider;
  readonly senderOutboxMap: Map<string, UxfTransferOutboxEntry>;
  readonly senderRequestContextMap: Map<string, RequestContext>;
  readonly emit: <T extends import('../../../../types').SphereEventType>(
    type: T,
    data: import('../../../../types').SphereEventMap[T],
  ) => void;
  /**
   * Task #169 — Optional cancellation signal. Wired to the
   * FinalizationWorkerSender's `signal` option AND through to the
   * `sleep` adapter. The worker honors `signal.aborted` between
   * aggregator calls and the sleep adapter rejects pending timers
   * on abort. PaymentsModule.destroy() aborts the parent controller
   * BEFORE awaiting `worker.stop()` so in-flight cycles terminate
   * deterministically rather than running orphaned to completion.
   */
  readonly signal?: AbortSignal;
  /**
   * Round 7 (FIX 3) — Optional shared {@link PerTokenMutex} so the
   * sender worker, recipient worker, and operator escape-hatch
   * InclusionProofImporter serialize against the same read-decide-write
   * window when they touch the same tokenId. When omitted, a fresh
   * per-builder mutex is used (the previous default — preserves
   * backward compatibility for callers that don't share).
   */
  readonly perTokenMutex?: PerTokenMutex | null;
}): FinalizationWorkerSender {
  const { addressId, oracle, senderOutboxMap, senderRequestContextMap, emit, signal } = opts;

  // In-memory outbox writer — thin wrapper over the module's _senderOutboxMap.
  const outbox: FinalizationOutboxWriter = {
    async readOne(id: string): Promise<UxfTransferOutboxEntry | null> {
      return senderOutboxMap.get(id) ?? null;
    },
    async update(
      id: string,
      mutator: (prev: UxfTransferOutboxEntry) => UxfTransferOutboxEntry,
    ): Promise<UxfTransferOutboxEntry> {
      const existing = senderOutboxMap.get(id);
      if (existing === null || existing === undefined) {
        throw new SphereError(
          `FinalizationOutboxWriter.update: no entry at id "${id}"`,
          'VALIDATION_ERROR',
        );
      }
      const next = mutator(existing);
      // Bump Lamport on every write so the worker's W26 state is consistent.
      const bumped: UxfTransferOutboxEntry = { ...next, lamport: (existing.lamport ?? 0) + 1 };
      senderOutboxMap.set(id, bumped);
      return bumped;
    },
  };

  // In-memory resolver — returns per-requestId context stored at commit time.
  const resolver: RequestContextResolver = {
    async resolve(input) {
      return senderRequestContextMap.get(input.requestId) ?? null;
    },
  };

  // In-memory pool adapter — no-op writes; sufficient for transfer:confirmed.
  const proofAttached = new Set<string>();
  const pool = {
    async isProofAttached(tokenId: string, reqId: string): Promise<boolean> {
      return proofAttached.has(`${tokenId}:${reqId}`);
    },
    async attachProof(tokenId: string, reqId: string): Promise<void> {
      proofAttached.add(`${tokenId}:${reqId}`);
    },
  };

  // In-memory pool read adapter.
  const poolProofs = new Map<string, import('../finalization-worker-base').AnchoredProofDescriptor>();
  const poolRead = {
    async getAttachedProof(
      tokenId: string,
      reqId: string,
    ): Promise<import('../finalization-worker-base').AnchoredProofDescriptor | null> {
      return poolProofs.get(`${tokenId}:${reqId}`) ?? null;
    },
  };

  // In-memory manifest storage — needed by ManifestCas.
  const manifestEntries = new Map<string, import('../../profile/token-manifest').TokenManifestEntry>();
  const manifestStorage: MinimalManifestStorage = {
    async readEntry(addr: string, tokenId: string) {
      return manifestEntries.get(`${addr}:${tokenId}`);
    },
    async writeEntry(addr: string, tokenId: string, entry: import('../../profile/token-manifest').TokenManifestEntry) {
      manifestEntries.set(`${addr}:${tokenId}`, entry);
    },
  };
  const manifestCas = new ManifestCas(manifestStorage);

  // In-memory tombstone adapter.
  const tombstoneSet = new Set<string>();
  const tombstones = {
    async hasTombstone(tokenId: string, cid: ContentHash): Promise<boolean> {
      return tombstoneSet.has(`${tokenId}:${cid}`);
    },
    async insertTombstone(tokenId: string, cid: ContentHash): Promise<void> {
      tombstoneSet.add(`${tokenId}:${cid}`);
    },
  };

  // In-memory finalization queue adapter.
  const queueEntries = new Set<string>();
  const queue = {
    async hasEntry(addr: string, reqId: string): Promise<boolean> {
      return queueEntries.has(`${addr}:${reqId}`);
    },
    async removeEntry(addr: string, reqId: string): Promise<void> {
      queueEntries.delete(`${addr}:${reqId}`);
    },
  };

  // Aggregator adapter — submit returns REQUEST_ID_EXISTS (already submitted
  // by commitSources); poll delegates to oracle.getProof(requestId).
  const aggregatorClient: FinalizationAggregatorClient = {
    async submit(_input): Promise<SubmitOutcome> {
      // The commitment was already submitted in commitSources. Return
      // REQUEST_ID_EXISTS so the cycle proceeds straight to polling.
      return { kind: 'REQUEST_ID_EXISTS' };
    },
    async poll(input): Promise<PollOutcome> {
      try {
        const proof = await oracle.getProof(input.requestId);
        if (proof === null || proof === undefined) {
          // Proof not yet available — retry next poll iteration.
          return { kind: 'TRANSIENT' };
        }
        // Task #152 — Build AnchoredProofDescriptor from the oracle's
        // InclusionProof. The aggregator's `proof.proof` field carries
        // the canonical IInclusionProofJson shape:
        //   { merkleTreePath, authenticator, transactionHash, unicityCertificate }
        // where `transactionHash` is the SDK-encoded DataHash imprint hex
        // (68 chars for sha2-256) or null for path-non-inclusion proofs,
        // and `authenticator` is an IAuthenticatorJson object or null.
        //
        // Race-lost detection (§6.1) compares the proof's transactionHash
        // against the locally-stored `_senderRequestContextMap` value
        // populated by `commitSources` from `commitment.transactionData
        // .calculateHash()`. Both sides MUST use the same imprint hex —
        // before this fix both sides used the requestId, which always
        // matched, making the detector dead in production.
        const proofJson = proof.proof as
          | {
              transactionHash?: string | null;
              authenticator?: unknown;
            }
          | null
          | undefined;
        // Wave 4 fix — classify path-non-inclusion (transactionHash === null)
        // BEFORE constructing the OK descriptor. Per SDK semantics a proof
        // with `transactionHash: null` is a cryptographic proof of NON-
        // inclusion at this SMT snapshot, not a successful proof. Treat as
        // PATH_NOT_INCLUDED so the worker continues polling within the
        // window (§6.1) instead of triggering race-lost when the OK
        // descriptor's transactionHash falls back to the requestId
        // (different from the local 68-char imprint by construction).
        if (proofJson !== null && proofJson !== undefined && proofJson.transactionHash === null) {
          return { kind: 'PATH_NOT_INCLUDED' };
        }
        const proofTxHash =
          proofJson !== null && proofJson !== undefined && typeof proofJson.transactionHash === 'string'
            ? proofJson.transactionHash
            : null;
        const proofAuthenticator =
          proofJson !== null && proofJson !== undefined && proofJson.authenticator !== undefined && proofJson.authenticator !== null
            ? JSON.stringify(proofJson.authenticator)
            : '';
        // Fallback for path-non-inclusion proofs (transactionHash is null
        // by spec). The Wave 4 early-return above already classifies
        // those as PATH_NOT_INCLUDED, so this fallback handles only the
        // degenerate case where proofJson is null/undefined entirely
        // (which should not happen given the upstream shape validation,
        // but keeps the descriptor a valid string for type safety).
        const descriptor: import('../finalization-worker-base').AnchoredProofDescriptor = {
          transactionHash: proofTxHash ?? proof.requestId,
          authenticator: proofAuthenticator,
          roundNumber: proof.roundNumber,
          proof: proof.proof,
        };
        // Store in poolRead so §6.3 most-recent-proof check can compare.
        poolProofs.set(`${input.tokenId}:${input.requestId}`, descriptor);
        // newCid: use a stable placeholder derived from requestId.
        // The in-memory manifest/tombstone/queue adapters don't care about the
        // actual CID content; they just key on (addr, tokenId).
        const newCid = contentHash(
          (input.requestId.replace(/[^0-9a-f]/gi, '').padStart(64, '0')).slice(0, 64),
        );
        return { kind: 'OK', proof: descriptor, newCid };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { kind: 'TRANSIENT', error: `oracle.getProof threw: ${message}` };
      }
    },
  };

  // Per-token semaphore factory — each tokenId gets its own semaphore.
  const perTokenSemaphores = new Map<string, CountingSemaphore>();
  const getPerTokenSemaphore = (tokenId: string): CountingSemaphore => {
    let sem = perTokenSemaphores.get(tokenId);
    if (sem === undefined) {
      sem = new CountingSemaphore(4); // MAX_CONCURRENT_POLLS_PER_TOKEN
      perTokenSemaphores.set(tokenId, sem);
    }
    return sem;
  };

  // Per-token mutex — shared for all requestIds within the same address.
  // Round 7 (FIX 3) — accept a shared instance from the caller so the
  // sender worker, recipient worker, and operator escape-hatch importer
  // serialize against the same per-tokenId mutex within the
  // PaymentsModule lifecycle. Falls back to a fresh per-builder mutex
  // if the caller doesn't pass one.
  const perTokenMutex = opts.perTokenMutex ?? new PerTokenMutex();

  return new FinalizationWorkerSender({
    addressId,
    outbox,
    aggregator: aggregatorClient,
    resolver,
    pool,
    poolRead,
    manifestCas,
    tombstones,
    queue,
    getPerTokenSemaphore,
    perTokenMutex,
    emit,
    now: () => Date.now(),
    sleep: (ms: number, abortSignal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        if (abortSignal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        const timer = setTimeout(resolve, ms);
        abortSignal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      }),
    // Task #169 — wire the parent AbortController's signal so destroy()
    // can cancel in-flight runFinalizationCycle invocations + sleep
    // timers. The worker's runFinalizationCycle inspects
    // `ctx.signal?.aborted` between aggregator calls; the sleep adapter
    // above also respects the signal for pending timers.
    ...(signal !== undefined ? { signal } : {}),
  });
}

// =============================================================================
// Task #151 — Default FinalizationWorkerRecipient factory
// =============================================================================

/**
 * Build the default auto-installed {@link FinalizationWorkerRecipient}
 * for {@link PaymentsModule.initialize}.
 *
 * Uses lightweight in-memory adapters for the
 * pool/manifest/tombstone/queue 4-step write order (no OrbitDB
 * required). Sufficient to drive the §6.1 cycle to completion and
 * flip Bob's pending tokens to confirmed once the proof lands.
 *
 * Bypasses the full §5.5 step 9 [B]/[D]/[E] re-evaluation: the
 * stub revaluateHooks build always says VALID. The real production
 * harness (bootstrap-injected) plugs in proper hydrateChain /
 * evaluatePredicate / oracleIsSpent against the local manifest.
 *
 * The dispositionWriter callback is the load-bearing path: when the
 * worker writes a VALID disposition (which our stub revaluator
 * always does on success), the callback rebuilds the SDK Token via
 * `finalizeTransferToken`, overwrites the locally-stored Token's
 * sdkData, and flips status to `'confirmed'`.
 *
 * @internal — exported only for unit-test access.
 */
export function buildDefaultFinalizationWorkerRecipient(opts: {
  readonly addressId: string;
  readonly oracle: import('../../../../oracle').OracleProvider;
  readonly recipientRequestContextMap: Map<string, RequestContext>;
  readonly recipientFinalizationContext: Map<string, RecipientFinalizationContext>;
  readonly tokens: Map<string, Token>;
  readonly finalizeTransferToken: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sourceToken: SdkToken<any>,
    transferTx: TransferTransaction,
    stClient: StateTransitionClient,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trustBase: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => Promise<SdkToken<any>>;
  readonly getStateTransitionClient: () => StateTransitionClient | undefined;
  readonly getTrustBase: () => unknown;
  readonly save: () => Promise<void>;
  readonly emit: <T extends import('../../../../types').SphereEventType>(
    type: T,
    data: import('../../../../types').SphereEventMap[T],
  ) => void;
  readonly signal?: AbortSignal;
  /**
   * Round 7 (FIX 3) — Optional shared {@link PerTokenMutex} so the
   * recipient worker, sender worker, and operator escape-hatch
   * InclusionProofImporter serialize against the same read-decide-write
   * window when they touch the same tokenId. When omitted, a fresh
   * per-builder mutex is used.
   */
  readonly perTokenMutex?: PerTokenMutex | null;
  /**
   * G3 — Optional persisted {@link FinalizationQueueStorage} for the
   * recipient FinalizationQueue. When omitted, an in-memory shim is used
   * (legacy behavior — does NOT survive Sphere.destroy() / restart). The
   * Sphere bootstrap layer plugs an `OrbitDbFinalizationQueueStorageAdapter`
   * here when a Profile-backed storage stack is detected, closing the
   * cross-restart safety net for the recipient worker.
   */
  readonly finalizationQueueStorage?: import('../finalization-queue').FinalizationQueueStorage;
}): {
  worker: FinalizationWorkerRecipient;
  queue: FinalizationQueue;
  dispositionWriter: FinalizationDispositionWriter;
  /**
   * Wave 7 hygiene: clears the closure-local `saveFailureStreak` Map.
   * The streak entries are otherwise per-tokenId and only cleaned on
   * save success — so a token that fails save then leaves the wallet
   * (tombstone, deletion, address switch) leaves a dead streak entry.
   * destroy() and similar instance-cleanup paths invoke this to keep
   * the closure's memory bounded.
   */
  clearSaveFailureStreak: () => void;
} {
  const {
    addressId,
    oracle,
    recipientRequestContextMap,
    recipientFinalizationContext,
    tokens,
    finalizeTransferToken,
    getStateTransitionClient,
    getTrustBase,
    save,
    emit,
    signal,
    finalizationQueueStorage,
  } = opts;

  // ---- FinalizationQueue (T.5.C / Wave G.7) --------------------------
  // G3: prefer the caller-supplied persisted storage (Profile/OrbitDb-
  // backed) over the in-memory shim. Sphere wires the persisted form
  // when a ProfileStorageProvider is present; legacy callers fall back
  // to the in-memory map (loss-prone across Sphere.destroy()/restart).
  let queueStorage: import('../finalization-queue').FinalizationQueueStorage;
  if (finalizationQueueStorage !== undefined) {
    queueStorage = finalizationQueueStorage;
  } else {
    const queueMap = new Map<string, string>();
    queueStorage = {
      async readKey(key: string): Promise<string | null> {
        return queueMap.has(key) ? (queueMap.get(key) ?? null) : null;
      },
      async writeKey(key: string, value: string): Promise<void> {
        queueMap.set(key, value);
      },
      async listByPrefix(prefix: string): Promise<Map<string, string>> {
        const out = new Map<string, string>();
        for (const [k] of queueMap) {
          if (k.startsWith(prefix)) out.set(k, k.slice(prefix.length));
        }
        return out;
      },
      async deleteKey(key: string): Promise<void> {
        queueMap.delete(key);
      },
    };
  }
  const queue = new FinalizationQueue({ storage: queueStorage });

  const queueAdapter = {
    async hasEntry(addr: string, requestId: string): Promise<boolean> {
      return queue.hasEntry(addr, requestId);
    },
    async removeEntry(addr: string, requestId: string): Promise<void> {
      await queue.remove(addr, requestId);
    },
  };

  // ---- Resolver: pulls per-requestId context populated at enqueue ----
  const resolver: RequestContextResolver = {
    async resolve(input) {
      return recipientRequestContextMap.get(input.requestId) ?? null;
    },
  };

  // ---- Pool / poolRead — track attached proofs per (tokenId, reqId) --
  const proofAttached = new Set<string>();
  const poolProofs = new Map<
    string,
    import('../finalization-worker-base').AnchoredProofDescriptor
  >();
  const pool = {
    async isProofAttached(tokenId: string, reqId: string): Promise<boolean> {
      return proofAttached.has(`${tokenId}:${reqId}`);
    },
    async attachProof(tokenId: string, reqId: string): Promise<void> {
      proofAttached.add(`${tokenId}:${reqId}`);
    },
  };
  const poolRead = {
    async getAttachedProof(
      tokenId: string,
      reqId: string,
    ): Promise<
      import('../finalization-worker-base').AnchoredProofDescriptor | null
    > {
      return poolProofs.get(`${tokenId}:${reqId}`) ?? null;
    },
  };

  // ---- ManifestCas + tombstones — in-memory ---------------------------
  const manifestEntries = new Map<
    string,
    import('../../profile/token-manifest').TokenManifestEntry
  >();
  const manifestStorage: MinimalManifestStorage = {
    async readEntry(addr, tokenId) {
      return manifestEntries.get(`${addr}:${tokenId}`);
    },
    async writeEntry(addr, tokenId, entry) {
      manifestEntries.set(`${addr}:${tokenId}`, entry);
    },
  };
  const manifestCas = new ManifestCas(manifestStorage);

  const tombstoneSet = new Set<string>();
  const tombstones = {
    async hasTombstone(tokenId: string, cid: ContentHash): Promise<boolean> {
      return tombstoneSet.has(`${tokenId}:${cid}`);
    },
    async insertTombstone(tokenId: string, cid: ContentHash): Promise<void> {
      tombstoneSet.add(`${tokenId}:${cid}`);
    },
  };

  // ---- Aggregator client ---------------------------------------------
  const aggregatorClient = {
    async submit(_input: {
      readonly addressId: string;
      readonly tokenId: string;
      readonly requestId: string;
      readonly signedTx: unknown;
    }): Promise<SubmitOutcome> {
      return { kind: 'REQUEST_ID_EXISTS' };
    },
    async poll(input: {
      readonly addressId: string;
      readonly tokenId: string;
      readonly requestId: string;
      readonly signedTx: unknown;
    }): Promise<PollOutcome> {
      try {
        const proof = await oracle.getProof(input.requestId);
        if (proof === null || proof === undefined) {
          return { kind: 'TRANSIENT' };
        }
        const proofJson = proof.proof as
          | { transactionHash?: string | null; authenticator?: unknown }
          | null
          | undefined;
        // Wave 4 fix — if the aggregator returned an inclusion-proof shape
        // with `transactionHash === null`, that is the SDK's canonical
        // path-non-inclusion proof (a cryptographic proof that the
        // requestId is NOT in the SMT at this snapshot). Treat as
        // PATH_NOT_INCLUDED so the worker keeps polling within the
        // window instead of taking the OK branch — which would then
        // (a) descriptor.transactionHash falls back to requestId and
        // (b) §6.1 race-lost fires because the local context has the
        // canonical 68-char imprint, not the requestId. This was the
        // regression introduced by Wave 1 #157 (shape validation
        // accepting null transactionHash) combined with Wave 2 #151
        // (recipient worker bootstrap).
        if (proofJson !== null && proofJson !== undefined && proofJson.transactionHash === null) {
          return { kind: 'PATH_NOT_INCLUDED' };
        }
        const proofTxHash =
          proofJson !== null && proofJson !== undefined && typeof proofJson.transactionHash === 'string'
            ? proofJson.transactionHash
            : null;
        const proofAuthenticator =
          proofJson !== null && proofJson !== undefined && proofJson.authenticator !== undefined && proofJson.authenticator !== null
            ? JSON.stringify(proofJson.authenticator)
            : '';
        const descriptor: import('../finalization-worker-base').AnchoredProofDescriptor = {
          transactionHash: proofTxHash ?? proof.requestId,
          authenticator: proofAuthenticator,
          roundNumber: proof.roundNumber,
          proof: proof.proof,
        };
        poolProofs.set(`${input.tokenId}:${input.requestId}`, descriptor);
        // Issue #195: do NOT synthesize a placeholder manifest entry here.
        // The §5.5 step 5 4-step write order assigns ownership of the
        // manifest entry to step 2 (`step2ManifestCidRewrite`). The
        // recipient enqueue path populates `RequestContext` with
        // `previousCid: undefined` (genesis), which step 2 translates to
        // `prev = null` (assert "no entry exists"). Writing a placeholder
        // here before step 2 runs breaks that contract — `manifestCas.update`
        // observes the placeholder, returns `cas-mismatch` (placeholder
        // ≠ undefined), and step 2 throws `ManifestCidRewriteCasError`.
        //
        // The escrow swap deposit flow surfaces this most visibly: the
        // CAS error blocks the deposit token from flipping to
        // `'confirmed'`, leaving the swap stuck at `PARTIAL_DEPOSIT`
        // with no progression to payout. Real receives are also broken;
        // they only "work" because the local Token still appears in the
        // UI and casual flows tolerate the silently stuck pending state.
        //
        // Removing this write lets step 2's CAS execute cleanly: it
        // observes `undefined`, accepts the `prev = null` assertion,
        // and inserts the canonical first entry via `writeEntry`.
        const newCid = contentHash(
          input.requestId.replace(/[^0-9a-f]/gi, '').padStart(64, '0').slice(0, 64),
        );
        return { kind: 'OK', proof: descriptor, newCid };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { kind: 'TRANSIENT', error: `oracle.getProof threw: ${message}` };
      }
    },
  };

  // ---- Per-token semaphores + per-token mutex ------------------------
  const perTokenSemaphores = new Map<string, CountingSemaphore>();
  const getPerTokenSemaphore = (tokenId: string): CountingSemaphore => {
    let sem = perTokenSemaphores.get(tokenId);
    if (sem === undefined) {
      sem = new CountingSemaphore(4);
      perTokenSemaphores.set(tokenId, sem);
    }
    return sem;
  };
  // Round 7 (FIX 3) — share with sender worker + operator importer so
  // concurrent paths on the same tokenId serialize against the same
  // read-decide-write window. Falls back to a fresh per-builder mutex
  // if the caller doesn't pass one.
  const perTokenMutex = opts.perTokenMutex ?? new PerTokenMutex();

  // ---- Stub CascadeWalker (no children scan, no NFT routing) ---------
  const cascadeManifestScanner: CascadeManifestScanner = {
    async readEntry(addr, tokenId) {
      return manifestEntries.get(`${addr}:${tokenId}`);
    },
    async findChildren(_addr, _parentTokenId) {
      return [];
    },
  };
  const cascadeOutboxScanner: CascadeOutboxScanner = {
    async findEntriesByTokenId() {
      return [];
    },
  };
  const classifyTokenLookup: ClassifyTokenLookup = async () => null;
  const cascadeWalker = new CascadeWalker({
    manifestScanner: cascadeManifestScanner,
    manifestCas,
    outboxScanner: cascadeOutboxScanner,
    classifyToken: classifyTokenLookup,
    emit,
  });

  // ---- Stub revaluateHooks (always VALID) ----------------------------
  const ourPubkey = new Uint8Array(33);
  ourPubkey[0] = 0x02;
  const revaluateHooks: RevaluateHooksProvider = {
    async buildRevaluateInput(_addr, tokenId) {
      const newHead = contentHash(('11'.repeat(32)).slice(0, 64));
      return {
        tokenRootHash: newHead,
        pool: new Map(),
        bundleCidForProvenance: 'task-151-stub',
        senderTransportPubkeyForProvenance: '',
        ourPubkey,
        async hydrateChain() {
          return {
            tokenId,
            tokenRootHash: newHead,
            chain: [
              {
                sourceState: 's0',
                destinationState: 's1',
                authenticator: { stub: true },
                transactionHash: { stub: true },
                inclusionProof: { stub: true },
                requestId: { stub: true },
              },
            ],
            currentStatePredicate: { stub: true },
            currentDestinationStateHash: 'stub-state-head',
          };
        },
        async readLocalManifest() {
          return undefined;
        },
        async evaluatePredicate() {
          return { ok: true, bindsToUs: true };
        },
        async oracleIsSpent() {
          return false;
        },
      };
    },
  };

  // ---- DispositionWriter — load-bearing finalization callback --------
  //
  // Wave 4 fix — every error path emits `transfer:operator-alert` so the
  // local Token doesn't silently stay 'pending' forever when the
  // recipient finalization fails. The previous Wave 2 implementation
  // swallowed errors in the catch block, which combined with the
  // race-lost regression made stuck tokens invisible to operators.
  //
  // Design choice: ctx is intentionally NOT removed on failure — that
  // way a subsequent retry (e.g. via payments.receive({finalize:true})
  // or a manual disposition replay) can pick up the same context. The
  // leak is bounded because `recipientFinalizationContext` is a
  // per-instance Map cleared on `destroy()` and on successful
  // finalization.
  //
  // Wave 6 steelman fix — alert flood backoff for save() failures.
  // If save() persistently fails (disk-full, quota), emitting an alert
  // on every retry would flood operators. Track a per-tokenId streak
  // and emit only at power-of-two boundaries (1, 2, 4, 8, …); reset
  // on save success. Per-token keying ensures distinct tokens have
  // independent counters. This Map is local to the builder — one
  // counter per `buildDefaultFinalizationWorkerRecipient` invocation,
  // matching the lifecycle of the `recipientFinalizationContext` Map.
  const saveFailureStreak = new Map<string, number>();
  const isPowerOfTwoBackoff = (n: number): boolean =>
    n > 0 && (n & (n - 1)) === 0;
  const dispositionWriter: FinalizationDispositionWriter = {
    async write(_addr, record) {
      if (record.disposition !== 'VALID') {
        return;
      }
      const tokenId = record.tokenId;
      const ctx = recipientFinalizationContext.get(tokenId);
      if (ctx === undefined) {
        logger.debug(
          'Payments',
          `Task #151: VALID disposition for ${tokenId.slice(0, 16)} but no finalization context`,
        );
        return;
      }
      try {
        const proof = await oracle.getProof(ctx.requestIdHex);
        if (proof === null || proof === undefined) {
          const msg = `Task #151: dispositionWriter VALID but oracle.getProof returned null for ${tokenId.slice(0, 16)} (requestId=${ctx.requestIdHex.slice(0, 16)})`;
          logger.warn('Payments', msg);
          // Wave 4 fix — surface to operators. proof-throw is the
          // closest existing DispositionReason for "we expected a proof
          // and the aggregator gave us nothing".
          emit('transfer:operator-alert', {
            code: 'proof-throw',
            tokenId: ctx.localTokenId,
            message: msg,
          });
          return;
        }
        const patchedLastTxJson = {
          ...ctx.lastTxJson,
          inclusionProof: proof.proof,
        };
        const stClient = getStateTransitionClient();
        const trustBase = getTrustBase();
        if (stClient === undefined || trustBase === null || trustBase === undefined) {
          logger.warn(
            'Payments',
            `Task #151: dispositionWriter VALID but stClient/trustBase missing for ${tokenId.slice(0, 16)} — falling back to status flip without re-finalization`,
          );
          const stored = tokens.get(ctx.localTokenId);
          if (stored !== undefined && stored.status === 'pending') {
            const updatedFallback: Token = {
              ...stored,
              status: 'confirmed',
              updatedAt: Date.now(),
            };
            tokens.set(ctx.localTokenId, updatedFallback);
            try {
              await save();
              // Wave 6 critical fix — only delete ctx after persistence
              // succeeds. The previous (Wave 2/4) ordering deleted
              // before save(), so a save() throw left ctx removed (no
              // retry possible) AND in-memory token flipped to
              // 'confirmed' while storage still showed 'pending'. On
              // reload the in-memory mutation is lost → token stuck
              // forever. Now mirrors the main success path below.
              recipientFinalizationContext.delete(tokenId);
              saveFailureStreak.delete(ctx.localTokenId);
              // Issue #195 (follow-up): emit `transfer:confirmed` so
              // listeners (notably AccountingModule) learn the inbound
              // deposit token is now aggregator-confirmed. Without this
              // emission an `invoice:covered` event never re-fires with
              // `confirmed: true`, leaving downstream consumers
              // (e.g. escrow swap orchestrator) stuck at PARTIAL_DEPOSIT
              // even after my CAS-mismatch fix unblocks the dispositionWriter.
              // Payload shape mirrors the NOSTR-FIRST and V5 emit sites.
              //
              // CAVEAT (steelman finding): `updatedFallback.sdkData` is in
              // SENDER-PREDICATE form — the recipient never ran
              // `finalizeTransferToken` on this path (it requires stClient
              // + trustBase, both missing here). The token is correctly
              // marked 'confirmed' for accounting purposes (the aggregator
              // anchored the commitment) but is NOT yet spendable: any
              // subsequent spend would build the commitment with the
              // sender's sourceState predicate while the authenticator
              // carries this wallet's pubkey, and `submitTransferCommitment`
              // would reject with "Authenticator does not match source
              // state predicate." The NOSTR-FIRST finalization path
              // (`handleCommitmentOnlyTransfer` → line ~13900) overwrites
              // `sdkData` with the properly finalized form once stClient
              // + trustBase become available. Listeners that read
              // `sdkData` for spend operations MUST guard against this
              // intermediate state.
              emit('transfer:confirmed', {
                id: crypto.randomUUID(),
                status: 'completed',
                tokens: [updatedFallback],
                tokenTransfers: [],
              });
            } catch (saveErr) {
              // Wave 6 critical fix — roll back the in-memory mutation
              // so retries can re-enter the `status === 'pending'`
              // guard above. Without this rollback, after the first
              // save() throw the in-memory token shows 'confirmed' and
              // the second retry skips the entire fallback block —
              // never re-attempting save() and never emitting an
              // alert. The retry path needs a clean 'pending' slate to
              // re-flip and retry persistence.
              //
              // Wave 7 steelman fix — compare-and-set rollback. While
              // we awaited save(), a concurrent path (another finalize,
              // a tombstone, a manual edit) may have replaced our
              // `updatedFallback` value with a different mutation. If
              // we blindly write `stored` back we clobber that work.
              // CAS: only restore if our update is still the current
              // value; otherwise leave the concurrent mutation alone.
              if (tokens.get(ctx.localTokenId) === updatedFallback) {
                tokens.set(ctx.localTokenId, stored);
              }
              const saveMsg = `Task #151: save() after status flip threw: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`;
              logger.warn('Payments', saveMsg);
              // Wave 4 fix — emit operator-alert when persistence fails.
              // Local Token state was mutated in-memory but didn't
              // round-trip to disk; operators need to know.
              // Wave 6 fix — power-of-two backoff so a permanent
              // disk-full failure doesn't flood operators with one
              // alert per retry. Streak keyed by tokenId so distinct
              // tokens accumulate independently.
              const prev = saveFailureStreak.get(ctx.localTokenId) ?? 0;
              const next = prev + 1;
              saveFailureStreak.set(ctx.localTokenId, next);
              if (isPowerOfTwoBackoff(next)) {
                emit('transfer:operator-alert', {
                  code: 'structural',
                  tokenId: ctx.localTokenId,
                  message: `${saveMsg} (consecutive save failures: ${next})`,
                });
              }
            }
          }
          return;
        }
        const lastTx = await TransferTransaction.fromJSON(patchedLastTxJson);
        const sourceToken = await SdkToken.fromJSON(ctx.sourceTokenJson);
        const finalizedToken = await finalizeTransferToken(
          sourceToken,
          lastTx,
          stClient,
          trustBase,
        );
        const stored = tokens.get(ctx.localTokenId);
        if (stored === undefined) {
          logger.debug(
            'Payments',
            `Task #151: local Token ${ctx.localTokenId.slice(0, 16)} disappeared before finalization`,
          );
          return;
        }
        const updated: Token = {
          ...stored,
          sdkData: JSON.stringify(finalizedToken.toJSON()),
          status: 'confirmed',
          updatedAt: Date.now(),
        };
        tokens.set(ctx.localTokenId, updated);
        try {
          await save();
          // Wave 5 fix — only delete ctx after persistence succeeds.
          // If save() threw, the in-memory mutation is lost on next
          // reload AND the ctx must be retained so an external retry
          // path (e.g. another disposition write or
          // payments.receive({finalize:true})) can re-attempt. This
          // matches the outer-catch retention promise below.
          recipientFinalizationContext.delete(tokenId);
          // Wave 6 fix — reset save-failure backoff on success.
          saveFailureStreak.delete(ctx.localTokenId);
          logger.debug(
            'Payments',
            `Task #151: token ${ctx.localTokenId.slice(0, 16)} finalized via recipient worker`,
          );
          // Issue #195 (follow-up): emit `transfer:confirmed` so
          // listeners (notably AccountingModule) learn the inbound
          // deposit token is now aggregator-confirmed. Without this
          // emission an `invoice:covered` event never re-fires with
          // `confirmed: true`, leaving downstream consumers (e.g. the
          // escrow swap orchestrator) stuck at PARTIAL_DEPOSIT even
          // after the CAS-mismatch fix unblocks the dispositionWriter.
          // Payload shape mirrors the NOSTR-FIRST and V5 emit sites.
          emit('transfer:confirmed', {
            id: crypto.randomUUID(),
            status: 'completed',
            tokens: [updated],
            tokenTransfers: [],
          });
        } catch (saveErr) {
          const saveMsg = `Task #151: save() after finalization threw: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`;
          logger.warn('Payments', saveMsg);
          // Wave 4 fix — emit operator-alert. The Token was finalized
          // and flipped to 'confirmed' in-memory, but persistence
          // failed; on the next reload the in-memory mutation is lost.
          // Wave 5 fix — ctx is intentionally NOT deleted here so a
          // retry path can pick it back up; consistent with the
          // outer-catch retention promise.
          // Wave 6 fix — power-of-two backoff so a permanent disk-full
          // failure doesn't flood operators. Streak keyed by tokenId.
          const prev = saveFailureStreak.get(ctx.localTokenId) ?? 0;
          const next = prev + 1;
          saveFailureStreak.set(ctx.localTokenId, next);
          if (isPowerOfTwoBackoff(next)) {
            emit('transfer:operator-alert', {
              code: 'structural',
              tokenId: ctx.localTokenId,
              message: `${saveMsg} (consecutive save failures: ${next})`,
            });
          }
        }
      } catch (err) {
        const errMsg = `Task #151: dispositionWriter finalization failed for ${tokenId.slice(0, 16)} — ${err instanceof Error ? err.message : String(err)}`;
        logger.warn(
          'Payments',
          errMsg,
          { err: err instanceof Error ? err.message : String(err) },
        );
        // Wave 4 fix — operator-alert on any unhandled finalization
        // error. Without this the local Token stays 'pending' forever
        // and the leak (`recipientFinalizationContext` entry retained
        // for retry) is invisible. We deliberately keep the ctx in
        // the Map so an external retry path (e.g. another disposition
        // write) can re-attempt.
        emit('transfer:operator-alert', {
          code: 'proof-throw',
          tokenId: ctx.localTokenId,
          message: errMsg,
        });
      }
    },
  };

  const worker = new FinalizationWorkerRecipient({
    addressId,
    queueStore: queue,
    queueAdapter,
    aggregator: aggregatorClient,
    resolver,
    pool,
    poolRead,
    manifestCas,
    tombstones,
    getPerTokenSemaphore,
    perTokenMutex,
    cascadeWalker,
    dispositionWriter,
    revaluateHooks,
    emit,
    now: () => Date.now(),
    sleep: (ms: number, abortSignal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        if (abortSignal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        const timer = setTimeout(resolve, ms);
        abortSignal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      }),
    ...(signal !== undefined ? { signal } : {}),
  });

  return {
    worker,
    queue,
    dispositionWriter,
    clearSaveFailureStreak: () => saveFailureStreak.clear(),
  };
}

// =============================================================================
// Round 5 (FIX 1) — default in-memory operator escape-hatch builders.
// =============================================================================

/**
 * Build a default {@link InclusionProofImporter} backed by in-memory
 * adapters. Auto-installed in `initialize()` when the bootstrap layer
 * has not already wired one. The defaults fail closed on every
 * operator-supplied proof (proof verification returns
 * `'NOT_AUTHENTICATED'`) so a misconfigured wallet cannot accidentally
 * apply unverified proofs — but the module no longer throws
 * `OPERATOR_ESCAPE_HATCH_NOT_CONFIGURED`, which lets operator scripts /
 * UIs probe the importer at startup without crashing.
 *
 * Production wiring should construct an OrbitDB-backed adapter (see
 * {@link OrbitDbDispositionStorageAdapter}) bound to the wallet's
 * ProfileDatabase plus a real `verifyProof` (the trust-base-aware
 * `verifyProof` from `transfer/proof-verifier.ts`), real
 * `graftCallback` / `overrideCallback` (the §5.5 step 5 4-step write
 * sequence + monotonicity-breach audit fields), and a real
 * `queueScanner` (the FinalizationQueue-backed scanner). Bootstrap
 * layers override via `payments.installInclusionProofImporter()`.
 *
 * @internal exposed for tests; production callers SHOULD NOT depend on
 *   this factory's exact shape — it is intentionally minimal.
 */
export function buildDefaultInclusionProofImporter(opts: {
  readonly emit: <T extends SphereEventType>(
    type: T,
    data: SphereEventMap[T],
  ) => void;
  /**
   * Round 7 (FIX 3) — Optional shared {@link PerTokenMutex} so the
   * operator importer serializes with the sender + recipient
   * finalization workers when they touch the same tokenId. Without
   * sharing, a concurrent `finalizeTransferToken(X)` and
   * `importInclusionProof(X)` race in their respective per-tokenId
   * guards (each builder previously created its own fresh mutex),
   * corrupting the manifest's audit trail or re-queuing duplicate K-1
   * entries. JSDoc on `ImportInclusionProofOptions.perTokenMutex` says
   * production callers SHOULD share — this knob fulfills that contract.
   */
  readonly perTokenMutex?: PerTokenMutex | null;
  /**
   * Round 7 (FIX 1) — Optional production-grade
   * `DispositionPerEntryStorage` adapter. When passed (e.g. an
   * {@link OrbitDbDispositionStorageAdapter} bound to the wallet's
   * ProfileDatabase), the importer's `_invalid` / `_audit` per-entry
   * records persist across restarts. When omitted, an
   * {@link InMemoryDispositionStorageAdapter} is used (the previous
   * default — preserves backward compatibility for tests + dev-mode
   * wallets without a profile stack).
   */
  readonly dispositionStorage?: import('../../profile/disposition-writer').DispositionPerEntryStorage;
  /**
   * Round 8 (FIX 1) — Optional production-grade
   * {@link ProofVerifier}. When passed (the Sphere bootstrap layer
   * builds an adapter over `oracle.verifyInclusionProof()`), the
   * importer's case 8 / 9 verification short-circuits run against the
   * trust-base-aware verifier so a real operator-supplied proof can
   * actually pass. When omitted, the default `'NOT_AUTHENTICATED'`
   * stub stays in place — the importer fails closed on every proof
   * (preserves the Round 7 default-safe semantics for callers without
   * a wired oracle).
   */
  readonly verifyProof?: import('../import-inclusion-proof').ProofVerifier;
  /**
   * Round 8 (FIX 1) — Optional production-grade graft callback. When
   * passed, case 3 (pending-graft) drives the §5.5 step 5 4-step write
   * sequence into the wallet's manifest store. When omitted, the
   * default no-op stub stays in place. The default harness's stub
   * `queueScanner` returns no entries, so this callback is unreachable
   * in the auto-installed default; bootstrap layers that wire a real
   * `queueScanner` (alongside this callback) close the production gap.
   */
  readonly graftCallback?: import('../import-inclusion-proof').ImportProofGraftCallback;
  /**
   * Round 8 (FIX 1) — Optional production-grade override callback.
   * When passed, cases 5 / 6 (operator override of `_invalid`) drive
   * the manifest stamp + audit-trail writes. When omitted, the default
   * no-op stub stays in place — same reachability caveat as
   * `graftCallback` above.
   */
  readonly overrideCallback?: import('../import-inclusion-proof').ImportProofOverrideCallback;
}): InclusionProofImporter {
  const { emit } = opts;

  // In-memory disposition storage — `_invalid` / `_audit` per-entry
  // records. Round 7 (FIX 1) — caller may pass an OrbitDb-backed
  // adapter for cross-restart persistence.
  const dispositionStorage = opts.dispositionStorage ?? new InMemoryDispositionStorageAdapter();

  // In-memory manifest storage — the operator escape-hatch reads
  // manifest entries to decide pending-vs-invalid routing.
  // Round 7 (FIX 5) — lowercase tokenId keys so mixed-case input from
  // operator scripts doesn't split the keyspace. The canonical-tokenId
  // regex contract says lowercase hex; storage keys must follow.
  const manifestEntries = new Map<string, TokenManifestEntry>();
  const manifestStorage: MinimalManifestStorage = {
    async readEntry(addr: string, tokenId: string) {
      return manifestEntries.get(`${addr}:${tokenId.toLowerCase()}`);
    },
    async writeEntry(addr: string, tokenId: string, entry: TokenManifestEntry) {
      manifestEntries.set(`${addr}:${tokenId.toLowerCase()}`, entry);
    },
  };
  const manifestStore = new ManifestStore({
    storage: manifestStorage,
    lamport: new Lamport(),
  });

  // Stub queue scanner — no live or hard-fail entries. Combined with
  // the stub verifyProof, every operator call resolves either to
  // `'no-such-token'` (no manifest entry) or `'tokenId-already-valid'` /
  // `'tokenId-in-invalid'` (depending on the manifest state, which is
  // also empty in the default harness).
  const queueScanner = {
    async lookupByTokenId() {
      return [];
    },
  };

  // Round 8 (FIX 1) — caller-supplied verifier wins. Default harness
  // fails closed (`NOT_AUTHENTICATED`) so the importer NEVER applies
  // an unverified proof; bootstrap layers that wire `oracle.
  // verifyInclusionProof()` swap in a real trust-base-aware verifier.
  const verifyProof = opts.verifyProof
    ?? (async (): Promise<ProofVerifyStatus> => 'NOT_AUTHENTICATED');

  // Round 8 (FIX 1) — caller-supplied graft callback wins. Default is
  // a no-op (case 3 unreachable in default harness because the stub
  // queueScanner returns no entries; the stub keeps the importer
  // structurally complete). When the bootstrap layer wires a real
  // queueScanner alongside this callback, case 3 becomes reachable.
  const graftCallback = opts.graftCallback ?? {
    async graft() {
      /* no-op */
    },
  };

  // Round 8 (FIX 1) — caller-supplied override callback wins. Default
  // is a no-op for the same reachability reason as `graftCallback`.
  const overrideCallback = opts.overrideCallback ?? {
    async applyOverride() {
      /* no-op */
    },
  };

  return new InclusionProofImporter({
    manifestStore,
    dispositionStorage,
    queueScanner,
    verifyProof,
    graftCallback,
    overrideCallback,
    emit,
    // Round 7 (FIX 3) — when caller provides a shared mutex, plumb it
    // through so this importer instance serializes against the
    // PaymentsModule's finalization workers. Default (undefined) leaves
    // the importer's own internal fallback in place.
    ...(opts.perTokenMutex !== null && opts.perTokenMutex !== undefined
      ? { perTokenMutex: opts.perTokenMutex }
      : {}),
  });
}

/**
 * Build a default {@link RevalidateCascadedRunner} backed by an
 * in-memory manifest scanner. Auto-installed in `initialize()` when
 * the bootstrap layer has not already wired one. The default scanner
 * surfaces no children for any parent, so `revalidateCascadedChildren`
 * resolves with `{ checked: 0, revalidated: 0, ... }` — equivalent to
 * "the operator's parent had no cascaded children", which is the
 * correct verdict for a freshly-bootstrapped wallet that hasn't yet
 * ingested any transfers.
 *
 * Production override (via `payments.installRevalidateCascadedRunner()`)
 * wires a manifestScanner that reads the wallet's OrbitDB-backed
 * manifest collection and a `revalidateChild` validator that runs the
 * §5.3 [B]/[C]/[E] sub-checks against the child token.
 *
 * @internal exposed for tests; production callers SHOULD NOT depend on
 *   this factory's exact shape — it is intentionally minimal.
 */
export function buildDefaultRevalidateCascadedRunner(): RevalidateCascadedRunner {
  // Empty in-memory scanner — no children for any parent. The
  // manifestStore returns undefined for every readEntry, so the
  // pre-loop parent-validity check classifies every cascaded subtree
  // as "still invalid". The runner returns zero counts.
  // Round 7 (FIX 5) — lowercase tokenId keys to match the canonical-
  // tokenId regex contract; mixed-case input must not split the
  // keyspace.
  const manifestEntries = new Map<string, TokenManifestEntry>();
  const manifestScanner: CascadeManifestScannerForRevalidate = {
    async readEntry(addr: string, tokenId: string) {
      return manifestEntries.get(`${addr}:${tokenId.toLowerCase()}`);
    },
    async findChildren() {
      return [];
    },
  };
  const manifestStorage: MinimalManifestStorage = {
    async readEntry(addr: string, tokenId: string) {
      return manifestEntries.get(`${addr}:${tokenId.toLowerCase()}`);
    },
    async writeEntry(addr: string, tokenId: string, entry: TokenManifestEntry) {
      manifestEntries.set(`${addr}:${tokenId.toLowerCase()}`, entry);
    },
  };
  const manifestStore = new ManifestStore({
    storage: manifestStorage,
    lamport: new Lamport(),
  });

  // Stub revalidator — never fires because findChildren always returns
  // []. Including it keeps the runner structurally complete.
  const revalidateChild = async () =>
    ({ kind: 'parent-still-invalid' } as const);

  return new RevalidateCascadedRunner({
    manifestScanner,
    manifestStore,
    revalidateChild,
  });
}
