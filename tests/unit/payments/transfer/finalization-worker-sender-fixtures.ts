/**
 * Shared fixtures + helpers for T.5.B finalization-worker-sender tests.
 *
 * Each acceptance test (race-lost-poll-mismatch, client-error-request-id-
 * mismatch, max-concurrent-polls-limits, pollingDeadline-propagation,
 * 2x-window-safety-net, most-recent-proof-tombstone) imports from here.
 *
 * Re-exports the harness types so call sites can keep imports flat.
 */

import {
  CountingSemaphore,
  FinalizationWorkerSender,
  type AnchoredProofDescriptor,
  type FinalizationAggregatorClient,
  type FinalizationOutboxWriter,
  type PoolReadAdapter,
  type RequestContext,
  type RequestContextResolver,
  type Semaphore,
  type SubmitOutcome,
  type PollOutcome,
} from '../../../../modules/payments/transfer/finalization-worker-sender';
import {
  type FinalizationQueueAdapter,
  type PoolWriteAdapter,
  type TombstoneWriteAdapter,
} from '../../../../modules/payments/transfer/manifest-cid-rewrite';
import { ManifestCas, type MinimalManifestStorage } from '../../../../profile/manifest-cas';
import { PerTokenMutex } from '../../../../profile/per-token-mutex';
import { contentHash } from '../../../../extensions/uxf/bundle/types';
import type { SphereEventMap, SphereEventType } from '../../../../types';
import type { UxfTransferOutboxEntry } from '../../../../types/uxf-outbox';
import type { TokenManifestEntry } from '../../../../profile/token-manifest';

export const ADDR = 'DIRECT://addr-A';
export const TOKEN_ID = 'token-1';
export const REQUEST_ID = 'req-1';
export const PREVIOUS_CID = contentHash('00'.repeat(32));
export const NEW_CID = contentHash('11'.repeat(32));

export const LOCAL_TX_HASH = `0000${'aa'.repeat(32)}`;
export const RACE_TX_HASH = `0000${'bb'.repeat(32)}`;
export const FORGED_TX_HASH = `0000${'cc'.repeat(32)}`;
export const LOCAL_AUTHENTICATOR = 'cc'.repeat(32);
export const FORGED_AUTHENTICATOR = 'dd'.repeat(32);

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

export function makeOutboxEntry(
  overrides: Partial<UxfTransferOutboxEntry> = {},
): UxfTransferOutboxEntry {
  return {
    _schemaVersion: 'uxf-1',
    id: 'outbox-1',
    bundleCid: 'bafy-bundle',
    tokenIds: [TOKEN_ID],
    deliveryMethod: 'car-over-nostr',
    recipient: '@bob',
    recipientTransportPubkey: 'recipient-pk',
    mode: 'instant',
    status: 'delivered-instant',
    outstandingRequestIds: [REQUEST_ID],
    completedRequestIds: [],
    submitRetryCount: 0,
    proofErrorCount: 0,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    lamport: 1,
    ...overrides,
  };
}

export function makeFakeOutboxWriter(initial: UxfTransferOutboxEntry): {
  readonly writer: FinalizationOutboxWriter;
  readonly entries: () => UxfTransferOutboxEntry;
  readonly transitions: ReadonlyArray<{ from: string; to: string }>;
} {
  let current = initial;
  const transitions: Array<{ from: string; to: string }> = [];
  return {
    transitions,
    entries: () => current,
    writer: {
      async readOne() {
        return current;
      },
      async update(id, mutator) {
        const prev = current;
        const next = mutator(prev);
        if (next.status !== prev.status) {
          transitions.push({ from: prev.status, to: next.status });
        }
        current = next;
        return next;
      },
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

export function makeFakeQueue(
  initialEntries: ReadonlyArray<{ addr: string; requestId: string }> = [],
): FinalizationQueueAdapter & {
  readonly entries: Set<string>;
  readonly removeCalls: Array<{ addr: string; requestId: string }>;
} {
  const entries = new Set<string>();
  for (const e of initialEntries) entries.add(`${e.addr}:${e.requestId}`);
  const removeCalls: Array<{ addr: string; requestId: string }> = [];
  return {
    entries,
    removeCalls,
    async hasEntry(addr, requestId) {
      return entries.has(`${addr}:${requestId}`);
    },
    async removeEntry(addr, requestId) {
      removeCalls.push({ addr, requestId });
      entries.delete(`${addr}:${requestId}`);
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
} = {}): FinalizationAggregatorClient & {
  readonly submitCalls: number;
  readonly pollCalls: number;
} {
  let submitCount = 0;
  let pollCount = 0;
  return {
    get submitCalls() {
      return submitCount;
    },
    get pollCalls() {
      return pollCount;
    },
    async submit() {
      const idx = submitCount++;
      if (args.submitSequence !== undefined) {
        return (
          args.submitSequence[idx] ??
          args.submitSequence[args.submitSequence.length - 1] ??
          { kind: 'TRANSIENT' as const }
        );
      }
      if (args.submit !== undefined) return args.submit();
      return { kind: 'SUCCESS' };
    },
    async poll() {
      const idx = pollCount++;
      if (args.pollSequence !== undefined) {
        return (
          args.pollSequence[idx] ??
          args.pollSequence[args.pollSequence.length - 1] ??
          { kind: 'TRANSIENT' as const }
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

export interface WorkerHarness {
  readonly worker: FinalizationWorkerSender;
  readonly outbox: ReturnType<typeof makeFakeOutboxWriter>;
  readonly aggregator: ReturnType<typeof makeFakeAggregator>;
  readonly resolver: ReturnType<typeof makeFakeResolver>;
  readonly pool: ReturnType<typeof makeFakePool>;
  readonly poolRead: ReturnType<typeof makeFakePoolRead>;
  readonly tombstones: ReturnType<typeof makeFakeTombstones>;
  readonly queue: ReturnType<typeof makeFakeQueue>;
  readonly events: ReturnType<typeof makeEventRecorder>;
  readonly perTokenSemaphore: CountingSemaphore;
  readonly perAggSemaphore: CountingSemaphore;
  readonly mutex: PerTokenMutex;
  readonly manifestStorage: ReturnType<typeof makeFakeManifestStorage>;
}

export function buildWorker(args: {
  readonly entry?: UxfTransferOutboxEntry;
  readonly aggregator?: ReturnType<typeof makeFakeAggregator>;
  readonly resolver?: ReturnType<typeof makeFakeResolver>;
  readonly poolRead?: ReturnType<typeof makeFakePoolRead>;
  readonly nowFn?: () => number;
  readonly sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly perToken?: number;
  readonly perAgg?: number;
  readonly perAggSemaphore?: CountingSemaphore;
  readonly perTokenSemaphore?: CountingSemaphore;
  readonly maxSubmitRetries?: number;
  readonly maxProofErrorRetries?: number;
  readonly pollingWindowMs?: number;
} = {}): WorkerHarness {
  const entry = args.entry ?? makeOutboxEntry();
  const outbox = makeFakeOutboxWriter(entry);
  const aggregator = args.aggregator ?? makeFakeAggregator();
  const resolver = args.resolver ?? makeFakeResolver();
  const pool = makeFakePool();
  const poolRead = args.poolRead ?? makeFakePoolRead();
  const tombstones = makeFakeTombstones();
  const queue = makeFakeQueue(
    entry.outstandingRequestIds!.map((r) => ({ addr: ADDR, requestId: r })),
  );
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

  const worker = new FinalizationWorkerSender({
    addressId: ADDR,
    outbox: outbox.writer,
    aggregator,
    resolver,
    pool,
    poolRead,
    manifestCas,
    tombstones,
    queue,
    perAggregatorSemaphore: perAggSemaphore,
    getPerTokenSemaphore: () => perTokenSemaphore,
    perTokenMutex: mutex,
    perTokenMutexStrategy: 'cas',
    emit: events.emit,
    now: args.nowFn ?? (() => Date.now()),
    sleep: args.sleepFn ?? (async () => undefined),
    caps: {
      maxSubmitRetries: args.maxSubmitRetries ?? 5,
      maxProofErrorRetries: args.maxProofErrorRetries ?? 3,
      pollingWindowMs: args.pollingWindowMs,
    },
  });

  return {
    worker,
    outbox,
    aggregator,
    resolver,
    pool,
    poolRead,
    tombstones,
    queue,
    events,
    perTokenSemaphore,
    perAggSemaphore,
    mutex,
    manifestStorage,
  };
}

// Re-exports for direct access in test files.
export {
  CountingSemaphore,
  FinalizationWorkerSender,
  type AnchoredProofDescriptor,
  type FinalizationAggregatorClient,
  type PollOutcome,
  type RequestContext,
  type RequestContextResolver,
  type Semaphore,
  type SubmitOutcome,
};
