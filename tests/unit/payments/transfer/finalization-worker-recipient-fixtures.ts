/**
 * Shared fixtures + helpers for T.5.C finalization-worker-recipient tests.
 *
 * Mirrors `finalization-worker-sender-fixtures.ts` but adapted to the
 * queue-driven recipient worker:
 *  - {@link FinalizationQueue} replaces the outbox writer.
 *  - {@link RevaluateHooksProvider} surface for §5.5 step 9 hooks.
 *  - {@link FinalizationDispositionWriter} surface for the T.3.C path.
 *  - {@link CascadeWalker} stub for T.5.B.5 delegation.
 */

import {
  CascadeWalker,
  type CascadeManifestScanner,
  type CascadeOutboxScanner,
  type ClassifyTokenLookup,
} from '../../../../modules/payments/transfer/cascade-walker';
import {
  FinalizationQueue,
  entryIdFor,
  type FinalizationQueueEntry,
  type FinalizationQueueStorage,
} from '../../../../modules/payments/transfer/finalization-queue';
import {
  FinalizationWorkerRecipient,
  type AnchoredProofDescriptor,
  type FinalizationAggregatorClient,
  type FinalizationDispositionWriter,
  type PoolReadAdapter,
  type RequestContext,
  type RequestContextResolver,
  type RevaluateHooksProvider,
  type SubmitOutcome,
  type PollOutcome,
} from '../../../../modules/payments/transfer/finalization-worker-recipient';
import { CountingSemaphore } from '../../../../modules/payments/transfer/finalization-worker-sender';
import {
  type FinalizationQueueAdapter,
  type PoolWriteAdapter,
  type TombstoneWriteAdapter,
} from '../../../../modules/payments/transfer/manifest-cid-rewrite';
import { ManifestCas, type MinimalManifestStorage } from '../../../../profile/manifest-cas';
import { PerTokenMutex } from '../../../../profile/per-token-mutex';
import { contentHash } from '../../../../uxf/types';
import type { ContentHash } from '../../../../uxf/types';
import type { DispositionRecord } from '../../../../types/disposition';
import type {
  DispositionRevaluateInput,
} from '../../../../modules/payments/transfer/disposition-engine';
import type { SphereEventMap, SphereEventType } from '../../../../types';
import type { TokenManifestEntry } from '../../../../profile/token-manifest';

// =============================================================================
// 1. Constants
// =============================================================================

export const ADDR = 'DIRECT://addr-A';
export const TOKEN_ID = 'token-1';
export const PREVIOUS_CID = contentHash('00'.repeat(32));
export const NEW_CID = contentHash('11'.repeat(32));

export const LOCAL_TX_HASH = `0000${'aa'.repeat(32)}`;
export const RACE_TX_HASH = `0000${'bb'.repeat(32)}`;
export const FORGED_TX_HASH = `0000${'cc'.repeat(32)}`;
export const LOCAL_AUTHENTICATOR = 'cc'.repeat(32);
export const FORGED_AUTHENTICATOR = 'dd'.repeat(32);

// =============================================================================
// 2. Event recorder
// =============================================================================

export interface RecordedEvent {
  readonly type: SphereEventType;
  readonly data: unknown;
}

export function makeEventRecorder(): {
  readonly emit: <T extends SphereEventType>(
    type: T,
    data: SphereEventMap[T],
  ) => void;
  readonly events: ReadonlyArray<RecordedEvent>;
  readonly clear: () => void;
} {
  const events: RecordedEvent[] = [];
  return {
    events,
    emit: <T extends SphereEventType>(type: T, data: SphereEventMap[T]) => {
      events.push({ type, data });
    },
    clear: () => {
      events.length = 0;
    },
  };
}

// =============================================================================
// 3. Storage / adapter fakes
// =============================================================================

export function makeFakeQueueStorage(): FinalizationQueueStorage & {
  readonly map: Map<string, string>;
} {
  const map = new Map<string, string>();
  return {
    map,
    async readKey(key) {
      return map.has(key) ? (map.get(key) ?? null) : null;
    },
    async writeKey(key, value) {
      map.set(key, value);
    },
    async listByPrefix(prefix) {
      const out = new Map<string, string>();
      for (const [k] of map) {
        if (k.startsWith(prefix)) out.set(k, k.slice(prefix.length));
      }
      return out;
    },
    async deleteKey(key) {
      map.delete(key);
    },
  };
}

export function makeFakePool(): PoolWriteAdapter & {
  readonly attached: Set<string>;
  readonly attachCalls: Array<{ tokenId: string; requestId: string }>;
} {
  const attached = new Set<string>();
  const attachCalls: Array<{ tokenId: string; requestId: string }> = [];
  return {
    attached,
    attachCalls,
    async isProofAttached(tokenId, requestId) {
      return attached.has(`${tokenId}:${requestId}`);
    },
    async attachProof(tokenId, requestId) {
      attachCalls.push({ tokenId, requestId });
      attached.add(`${tokenId}:${requestId}`);
    },
  };
}

export function makeFakePoolRead(
  initial: ReadonlyArray<{
    tokenId: string;
    requestId: string;
    proof: AnchoredProofDescriptor;
  }> = [],
): PoolReadAdapter & {
  readonly proofs: Map<string, AnchoredProofDescriptor>;
} {
  const proofs = new Map<string, AnchoredProofDescriptor>();
  for (const e of initial) {
    proofs.set(`${e.tokenId}:${e.requestId}`, e.proof);
  }
  return {
    proofs,
    async getAttachedProof(tokenId, requestId) {
      return proofs.get(`${tokenId}:${requestId}`) ?? null;
    },
  };
}

export function makeFakeTombstones(): TombstoneWriteAdapter & {
  readonly records: Set<string>;
  readonly insertCalls: Array<{ tokenId: string; cid: string }>;
} {
  const records = new Set<string>();
  const insertCalls: Array<{ tokenId: string; cid: string }> = [];
  return {
    records,
    insertCalls,
    async hasTombstone(tokenId, cid) {
      return records.has(`${tokenId}:${cid}`);
    },
    async insertTombstone(tokenId, cid) {
      insertCalls.push({ tokenId, cid });
      records.add(`${tokenId}:${cid}`);
    },
  };
}

/**
 * Bridge a {@link FinalizationQueue} to the
 * {@link FinalizationQueueAdapter} contract used by the §5.5 step 5
 * 4-step write orchestrator. The adapter's "queueEntryRequestId" is
 * the queue entry's id.
 */
export function makeQueueAdapter(
  queueStore: FinalizationQueue,
): FinalizationQueueAdapter {
  return {
    async hasEntry(addr, requestId) {
      return queueStore.hasEntry(addr, requestId);
    },
    async removeEntry(addr, requestId) {
      await queueStore.remove(addr, requestId);
    },
  };
}

export function makeFakeManifestStorage(
  initial: ReadonlyArray<{ addr: string; tokenId: string; entry: TokenManifestEntry }> = [],
): MinimalManifestStorage & {
  readonly entries: Map<string, TokenManifestEntry>;
} {
  const entries = new Map<string, TokenManifestEntry>();
  for (const e of initial) {
    entries.set(`${e.addr}:${e.tokenId}`, e.entry);
  }
  return {
    entries,
    async readEntry(addr, tokenId) {
      return entries.get(`${addr}:${tokenId}`);
    },
    async writeEntry(addr, tokenId, entry) {
      entries.set(`${addr}:${tokenId}`, entry);
    },
  };
}

// =============================================================================
// 4. Resolver / aggregator / proof fakes
// =============================================================================

export function makeFakeResolver(
  ctx: RequestContext = {
    transactionHash: LOCAL_TX_HASH,
    authenticator: LOCAL_AUTHENTICATOR,
    previousCid: PREVIOUS_CID,
    nextEntryRest: { status: 'valid' },
  },
): RequestContextResolver & {
  readonly calls: Array<{
    addressId: string;
    outboxId: string;
    tokenId: string;
    requestId: string;
  }>;
} {
  const calls: Array<{
    addressId: string;
    outboxId: string;
    tokenId: string;
    requestId: string;
  }> = [];
  return {
    calls,
    async resolve(input) {
      calls.push({
        addressId: input.addressId,
        outboxId: input.outboxId,
        tokenId: input.tokenId,
        requestId: input.requestId,
      });
      return ctx;
    },
  };
}

export function makeProof(
  overrides: Partial<AnchoredProofDescriptor> = {},
): AnchoredProofDescriptor {
  return {
    transactionHash: LOCAL_TX_HASH,
    authenticator: LOCAL_AUTHENTICATOR,
    roundNumber: 100,
    proof: { merkle: 'irrelevant-for-orchestrator-tests' },
    ...overrides,
  };
}

export function makeFakeAggregator(args: {
  readonly submit?: () => Promise<SubmitOutcome>;
  readonly poll?: () => Promise<PollOutcome>;
  readonly submitSequence?: ReadonlyArray<SubmitOutcome>;
  readonly pollSequence?: ReadonlyArray<PollOutcome>;
  readonly perRequestSubmit?: Map<string, ReadonlyArray<SubmitOutcome>>;
  readonly perRequestPoll?: Map<string, ReadonlyArray<PollOutcome>>;
} = {}): FinalizationAggregatorClient & {
  readonly submitCalls: Array<{ tokenId: string; requestId: string }>;
  readonly pollCalls: Array<{ tokenId: string; requestId: string }>;
} {
  const submitCalls: Array<{ tokenId: string; requestId: string }> = [];
  const pollCalls: Array<{ tokenId: string; requestId: string }> = [];
  const submitIdxByReq = new Map<string, number>();
  const pollIdxByReq = new Map<string, number>();
  let submitIdx = 0;
  let pollIdx = 0;
  return {
    submitCalls,
    pollCalls,
    async submit(input) {
      submitCalls.push({ tokenId: input.tokenId, requestId: input.requestId });
      const perReq = args.perRequestSubmit?.get(input.requestId);
      if (perReq !== undefined) {
        const i = submitIdxByReq.get(input.requestId) ?? 0;
        submitIdxByReq.set(input.requestId, i + 1);
        return perReq[i] ?? perReq[perReq.length - 1] ?? { kind: 'SUCCESS' };
      }
      const i = submitIdx++;
      if (args.submitSequence !== undefined) {
        return (
          args.submitSequence[i] ??
          args.submitSequence[args.submitSequence.length - 1] ??
          ({ kind: 'TRANSIENT' as const })
        );
      }
      if (args.submit !== undefined) return args.submit();
      return { kind: 'SUCCESS' };
    },
    async poll(input) {
      pollCalls.push({ tokenId: input.tokenId, requestId: input.requestId });
      const perReq = args.perRequestPoll?.get(input.requestId);
      if (perReq !== undefined) {
        const i = pollIdxByReq.get(input.requestId) ?? 0;
        pollIdxByReq.set(input.requestId, i + 1);
        return (
          perReq[i] ??
          perReq[perReq.length - 1] ??
          { kind: 'OK', proof: makeProof(), newCid: NEW_CID }
        );
      }
      const i = pollIdx++;
      if (args.pollSequence !== undefined) {
        return (
          args.pollSequence[i] ??
          args.pollSequence[args.pollSequence.length - 1] ??
          ({ kind: 'OK', proof: makeProof(), newCid: NEW_CID })
        );
      }
      if (args.poll !== undefined) return args.poll();
      return {
        kind: 'OK',
        proof: makeProof(),
        newCid: NEW_CID,
      };
    },
  };
}

// =============================================================================
// 5. Cascade walker fake
// =============================================================================

export function makeFakeCascadeWalker(args: {
  readonly tokenClass?: 'coin' | 'nft' | null;
  readonly children?: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly outboxEntries?: ReadonlyMap<string, ReadonlyArray<unknown>>;
} = {}): CascadeWalker & {
  readonly cascadeCalls: Array<{ addr: string; tokenId: string; reason: string }>;
} {
  const cascadeCalls: Array<{ addr: string; tokenId: string; reason: string }> = [];
  const manifestScanner: CascadeManifestScanner = {
    async readEntry(_addr, _tokenId) {
      // Used only in the coin path's parent-flip protection. Return a
      // fixture entry so the walker proceeds.
      return { rootHash: PREVIOUS_CID, status: 'invalid', invalidReason: 'oracle-rejected' };
    },
    async findChildren(_addr, parentTokenId) {
      return args.children?.get(parentTokenId) ?? [];
    },
  };
  const manifestStorage = makeFakeManifestStorage();
  const manifestCas = new ManifestCas(manifestStorage);
  const outboxScanner: CascadeOutboxScanner = {
    async findEntriesByTokenId() {
      return [];
    },
  };
  const classifyToken: ClassifyTokenLookup = async () => args.tokenClass ?? null;
  const events = makeEventRecorder();
  const walker = new CascadeWalker({
    manifestScanner,
    manifestCas,
    outboxScanner,
    classifyToken,
    emit: events.emit,
  });
  // Wrap cascade to record calls.
  const original = walker.cascade.bind(walker);
  walker.cascade = async (addr, tokenId, reason) => {
    cascadeCalls.push({ addr, tokenId, reason });
    return original(addr, tokenId, reason);
  };
  (walker as unknown as { cascadeCalls: typeof cascadeCalls }).cascadeCalls =
    cascadeCalls;
  return walker as CascadeWalker & {
    cascadeCalls: typeof cascadeCalls;
  };
}

// =============================================================================
// 6. Disposition writer fake
// =============================================================================

export function makeFakeDispositionWriter(): FinalizationDispositionWriter & {
  readonly writes: Array<{ addr: string; record: DispositionRecord }>;
} {
  const writes: Array<{ addr: string; record: DispositionRecord }> = [];
  return {
    writes,
    async write(addr, record) {
      writes.push({ addr, record });
    },
  };
}

// =============================================================================
// 7. Revaluate hooks provider fake
// =============================================================================

export function makeFakeRevaluateHooks(args: {
  readonly bindsToUs?: boolean;
  readonly oracleIsSpent?: boolean;
  readonly localManifest?: { rootHash: ContentHash; status: 'valid' | 'pending' | 'invalid' | 'conflicting' } | undefined;
  readonly hydrateThrow?: unknown;
  readonly oracleThrow?: unknown;
  readonly returnNull?: boolean;
} = {}): RevaluateHooksProvider {
  return {
    async buildRevaluateInput(_addr, tokenId) {
      if (args.returnNull === true) return null;
      const ourPubkey = new Uint8Array(33);
      ourPubkey[0] = 0x02;
      const input: DispositionRevaluateInput = {
        tokenRootHash: NEW_CID,
        pool: new Map(),
        bundleCidForProvenance: 'bafy-bundle',
        senderTransportPubkeyForProvenance: 'sender-pk',
        ourPubkey,
        async hydrateChain() {
          if (args.hydrateThrow !== undefined) throw args.hydrateThrow;
          return {
            tokenId,
            tokenRootHash: NEW_CID,
            chain: [
              {
                sourceState: 's0',
                destinationState: 's1',
                authenticator: { kind: 'auth' },
                transactionHash: { kind: 'txh' },
                inclusionProof: { kind: 'proof' },
                requestId: { kind: 'req' },
              },
            ],
            currentStatePredicate: { kind: 'predicate' },
            currentDestinationStateHash: 'state-head',
          };
        },
        async readLocalManifest() {
          return args.localManifest;
        },
        async evaluatePredicate() {
          return { ok: true, bindsToUs: args.bindsToUs ?? true };
        },
        async oracleIsSpent() {
          if (args.oracleThrow !== undefined) throw args.oracleThrow;
          return args.oracleIsSpent ?? false;
        },
      };
      return input;
    },
  };
}

// =============================================================================
// 8. Queue entry helpers
// =============================================================================

export function makeQueueEntry(
  overrides: Partial<FinalizationQueueEntry> = {},
): FinalizationQueueEntry {
  const tokenId = overrides.tokenId ?? TOKEN_ID;
  const txIndex = overrides.txIndex ?? 0;
  return {
    entryId: overrides.entryId ?? entryIdFor(tokenId, txIndex),
    tokenId,
    bundleCid: 'bafy-bundle',
    txIndex,
    commitmentRequestId: overrides.commitmentRequestId ?? `req-${txIndex}`,
    transactionHash: LOCAL_TX_HASH,
    authenticator: LOCAL_AUTHENTICATOR,
    submittedAt: 1700000000000,
    createdAt: 1700000000000,
    submitRetryCount: 0,
    proofErrorCount: 0,
    status: 'pending',
    source: 'received',
    ...overrides,
  };
}

// =============================================================================
// 9. Worker harness builder
// =============================================================================

export interface WorkerHarness {
  readonly worker: FinalizationWorkerRecipient;
  readonly queueStore: FinalizationQueue;
  readonly queueStorage: ReturnType<typeof makeFakeQueueStorage>;
  readonly aggregator: ReturnType<typeof makeFakeAggregator>;
  readonly resolver: ReturnType<typeof makeFakeResolver>;
  readonly pool: ReturnType<typeof makeFakePool>;
  readonly poolRead: ReturnType<typeof makeFakePoolRead>;
  readonly tombstones: ReturnType<typeof makeFakeTombstones>;
  readonly events: ReturnType<typeof makeEventRecorder>;
  readonly perTokenSemaphore: CountingSemaphore;
  readonly perAggSemaphore: CountingSemaphore;
  readonly mutex: PerTokenMutex;
  readonly manifestStorage: ReturnType<typeof makeFakeManifestStorage>;
  readonly cascadeWalker: ReturnType<typeof makeFakeCascadeWalker>;
  readonly dispositionWriter: ReturnType<typeof makeFakeDispositionWriter>;
}

export function buildWorker(args: {
  readonly queueEntries?: ReadonlyArray<FinalizationQueueEntry>;
  readonly aggregator?: ReturnType<typeof makeFakeAggregator>;
  readonly resolver?: ReturnType<typeof makeFakeResolver>;
  readonly poolRead?: ReturnType<typeof makeFakePoolRead>;
  readonly cascadeWalker?: ReturnType<typeof makeFakeCascadeWalker>;
  readonly revaluateHooks?: RevaluateHooksProvider;
  readonly nowFn?: () => number;
  readonly sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly perToken?: number;
  readonly perAgg?: number;
  readonly perAggSemaphore?: CountingSemaphore;
  readonly perTokenSemaphore?: CountingSemaphore;
  readonly maxSubmitRetries?: number;
  readonly maxProofErrorRetries?: number;
  readonly pollingWindowMs?: number;
  readonly mutexStrategy?: 'cas' | 'rpc-release' | 'bounded-hold';
} = {}): WorkerHarness {
  const queueStorage = makeFakeQueueStorage();
  const queueStore = new FinalizationQueue({ storage: queueStorage });
  const queueAdapter = makeQueueAdapter(queueStore);
  const aggregator = args.aggregator ?? makeFakeAggregator();
  const resolver = args.resolver ?? makeFakeResolver();
  const pool = makeFakePool();
  const poolRead = args.poolRead ?? makeFakePoolRead();
  const tombstones = makeFakeTombstones();
  const events = makeEventRecorder();
  const manifestStorage = makeFakeManifestStorage([
    {
      addr: ADDR,
      tokenId: TOKEN_ID,
      entry: { rootHash: PREVIOUS_CID, status: 'pending' },
    },
  ]);
  const manifestCas = new ManifestCas(manifestStorage);
  const perTokenSemaphore =
    args.perTokenSemaphore ?? new CountingSemaphore(args.perToken ?? 4);
  const perAggSemaphore =
    args.perAggSemaphore ?? new CountingSemaphore(args.perAgg ?? 16);
  const mutex = new PerTokenMutex();
  const cascadeWalker = args.cascadeWalker ?? makeFakeCascadeWalker();
  const dispositionWriter = makeFakeDispositionWriter();
  const revaluateHooks = args.revaluateHooks ?? makeFakeRevaluateHooks();

  const worker = new FinalizationWorkerRecipient({
    addressId: ADDR,
    queueStore,
    queueAdapter,
    aggregator,
    resolver,
    pool,
    poolRead,
    manifestCas,
    tombstones,
    perAggregatorSemaphore: perAggSemaphore,
    getPerTokenSemaphore: () => perTokenSemaphore,
    perTokenMutex: mutex,
    perTokenMutexStrategy: args.mutexStrategy ?? 'cas',
    cascadeWalker,
    dispositionWriter,
    revaluateHooks,
    emit: events.emit,
    // Default `now` matches the queue-entry fixture's `submittedAt`
    // (1700000000000) so the W26 cross-restart safety net does not
    // trip on default-built harnesses. Tests that need to advance the
    // clock pass an explicit `nowFn`.
    now: args.nowFn ?? (() => 1700000000000),
    sleep: args.sleepFn ?? (async () => undefined),
    caps: {
      maxSubmitRetries: args.maxSubmitRetries ?? 5,
      maxProofErrorRetries: args.maxProofErrorRetries ?? 3,
      pollingWindowMs: args.pollingWindowMs,
    },
  });

  return {
    worker,
    queueStore,
    queueStorage,
    aggregator,
    resolver,
    pool,
    poolRead,
    tombstones,
    events,
    perTokenSemaphore,
    perAggSemaphore,
    mutex,
    manifestStorage,
    cascadeWalker,
    dispositionWriter,
  };
}

/**
 * Pre-populate the queue with the supplied entries. Helper used by tests
 * that want a freshly-built worker with K queue entries already in
 * place.
 */
export async function seedQueue(
  harness: WorkerHarness,
  entries: ReadonlyArray<FinalizationQueueEntry>,
): Promise<void> {
  for (const e of entries) {
    await harness.queueStore.add(ADDR, e);
  }
}

// =============================================================================
// 10. Re-exports for direct access in test files
// =============================================================================

export {
  CountingSemaphore,
  FinalizationWorkerRecipient,
  type AnchoredProofDescriptor,
  type FinalizationAggregatorClient,
  type PollOutcome,
  type RequestContext,
  type RequestContextResolver,
  type SubmitOutcome,
};
