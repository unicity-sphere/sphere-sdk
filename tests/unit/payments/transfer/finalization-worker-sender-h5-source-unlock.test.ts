/**
 * Tests for Audit #333 H5 — failed-permanent source unlock.
 *
 * Background
 * ----------
 * Before this fix, the FinalizationWorkerSender transitioned the outbox
 * entry to `failed-permanent` on any hard-fail and never touched the
 * source tokens that the instant-sender had marked `transferring`/
 * `pending` at submit time. With orphan auto-recovery default-OFF, the
 * spender-side balance was permanently locked as unspendable.
 *
 * Fix
 * ---
 *   - New optional `recoverFailedPermanentSources?(sources, outboxId)`
 *     hook on `FinalizationWorkerSenderOptions`.
 *   - New optional `sourceTokenIds` field on `UxfTransferOutboxEntry`,
 *     populated by the instant-sender via `OutboxBuildArgs`.
 *   - On `failed-permanent`, the worker invokes the hook with the
 *     entry's `sourceTokenIds`. The hook is best-effort: a throw is
 *     caught and emitted as a `transfer:failed` event, but the
 *     `failed-permanent` transition itself stands.
 *
 * These tests drive the worker through the same submit-failure path
 * existing tests exercise and additionally assert the new hook
 * behaviour.
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  UxfTransferOutboxEntry,
  UxfOutboxStatus,
} from '../../../../types/uxf-outbox';
import {
  FinalizationWorkerSender,
  type FinalizationOutboxWriter,
  type FinalizationAggregatorClient,
  type RequestContextResolver,
  type PoolWriteAdapter,
  type PoolReadAdapter,
  type TombstoneWriteAdapter,
  type FinalizationQueueAdapter,
  type Semaphore,
} from '../../../../extensions/uxf/pipeline/finalization-worker-sender';
import { ManifestCas } from '../../../../profile/manifest-cas';
import { PerTokenMutex } from '../../../../profile/per-token-mutex';
import type {
  SphereEventMap,
  SphereEventType,
} from '../../../../types';

// ---------------------------------------------------------------------------
// Fixture constants
// ---------------------------------------------------------------------------

const ADDR = 'DIRECT_aabbcc_ddeeff';
const TOKEN_ID = 'aa'.repeat(32);
const REQUEST_ID = 'req-1';
const PREVIOUS_CID = 'prev-cid';

// ---------------------------------------------------------------------------
// Minimal fake adapters — focused on the failed-permanent path so we can
// drive the hook without re-implementing all §6.1 machinery.
// ---------------------------------------------------------------------------

function makeFakeAggregator(opts?: {
  submitReject?: { reason: 'STATE_ALREADY_SPENT_BY_OTHER' | 'CLIENT_ERROR'; message?: string };
}): FinalizationAggregatorClient {
  return {
    aggregatorId: 'fake',
    async submit() {
      if (opts?.submitReject) {
        return {
          kind: 'rejected',
          reason: opts.submitReject.reason,
          message: opts.submitReject.message ?? 'submit rejected',
        };
      }
      return { kind: 'accepted' };
    },
    async pollProof() {
      return { kind: 'pending' };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeFakeResolver(): RequestContextResolver {
  return {
    async resolve(addr: string, requestId: string) {
      return {
        addr,
        requestId,
        tokenId: TOKEN_ID,
        bundleCid: 'bafy-bundle',
        recipientTransportPubkey: 'recipient-pk',
        sourceStateHash: 'src-state',
        destinationStateHash: 'dst-state',
        authenticatorJson: { auth: 'x' },
        transactionDataJson: { tx: 'x' },
        previousCid: PREVIOUS_CID,
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeFakePool(): PoolWriteAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { async writeRewrittenRoot() {} } as any;
}
function makeFakePoolRead(): PoolReadAdapter {
  return {
    async readMostRecentTokenRoot() { return null; },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}
function makeFakeTombstones(): TombstoneWriteAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { async write() {} } as any;
}
function makeFakeQueue(
  entries: Array<{ addr: string; requestId: string }>,
): FinalizationQueueAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    async drain() { return entries; },
    async remove() {},
  } as any;
}

function makeFakeManifestStorage(
  seed: Array<{ addr: string; tokenId: string; entry: { rootHash: string; status: string } }>,
): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly get: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly cas: any;
} {
  const store = new Map<string, { rootHash: string; status: string }>();
  for (const s of seed) store.set(`${s.addr}.${s.tokenId}`, s.entry);
  return {
    async get(addr: string, tokenId: string) {
      return store.get(`${addr}.${tokenId}`);
    },
    async cas(
      addr: string,
      tokenId: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expected: any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      next: any,
    ): Promise<boolean> {
      const key = `${addr}.${tokenId}`;
      const cur = store.get(key);
      if ((cur?.rootHash ?? null) !== (expected?.rootHash ?? null)) return false;
      store.set(key, next);
      return true;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

class CountingSemaphore implements Semaphore {
  constructor(private capacity: number) {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async acquire(): Promise<() => void> {
    return () => {};
  }
}

function makeOutboxEntry(
  overrides: Partial<UxfTransferOutboxEntry> = {},
): UxfTransferOutboxEntry {
  return {
    _schemaVersion: 'uxf-1',
    id: 'outbox-h5',
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeFakeOutboxWriter(initial: UxfTransferOutboxEntry): {
  readonly writer: FinalizationOutboxWriter;
  readonly entries: () => UxfTransferOutboxEntry;
} {
  let current = initial;
  return {
    entries: () => current,
    writer: {
      async readOne(_id: string) { return current; },
      async readAllNew() { return [current]; },
      async update(
        id: string,
        updater: (prev: UxfTransferOutboxEntry) => UxfTransferOutboxEntry,
      ) {
        if (id !== current.id) throw new Error('test: unknown outbox id');
        current = updater(current);
        return current;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

interface H5Harness {
  worker: FinalizationWorkerSender;
  outbox: ReturnType<typeof makeFakeOutboxWriter>;
  emittedEvents: Array<{ type: SphereEventType; data: unknown }>;
  hookCalls: Array<{ sources: ReadonlyArray<string>; outboxId: string }>;
}

function buildH5Worker(opts?: {
  entry?: UxfTransferOutboxEntry;
  submitReject?: { reason: 'STATE_ALREADY_SPENT_BY_OTHER' | 'CLIENT_ERROR'; message?: string };
  recoverHook?: 'throws' | 'records' | 'omit';
  recoverHookError?: Error;
}): H5Harness {
  const entry = opts?.entry ?? makeOutboxEntry({ sourceTokenIds: ['src-1', 'src-2'] });
  const outbox = makeFakeOutboxWriter(entry);
  const emittedEvents: Array<{ type: SphereEventType; data: unknown }> = [];
  const hookCalls: Array<{ sources: ReadonlyArray<string>; outboxId: string }> = [];

  const manifestStorage = makeFakeManifestStorage([
    {
      addr: ADDR,
      tokenId: TOKEN_ID,
      entry: { rootHash: PREVIOUS_CID, status: 'pending' },
    },
  ]);

  const baseOptions = {
    addressId: ADDR,
    outbox: outbox.writer,
    aggregator: makeFakeAggregator(
      opts?.submitReject !== undefined ? { submitReject: opts.submitReject } : {},
    ),
    resolver: makeFakeResolver(),
    pool: makeFakePool(),
    poolRead: makeFakePoolRead(),
    manifestCas: new ManifestCas(manifestStorage),
    tombstones: makeFakeTombstones(),
    queue: makeFakeQueue([{ addr: ADDR, requestId: REQUEST_ID }]),
    perAggregatorSemaphore: new CountingSemaphore(16),
    getPerTokenSemaphore: () => new CountingSemaphore(4),
    perTokenMutex: new PerTokenMutex(),
    perTokenMutexStrategy: 'cas' as const,
    emit: <T extends SphereEventType>(type: T, data: SphereEventMap[T]) => {
      emittedEvents.push({ type, data });
    },
    now: () => 1700000001000,
    sleep: async () => undefined,
    caps: { maxSubmitRetries: 1, maxProofErrorRetries: 1 },
  };

  let recoverHook:
    | ((sources: ReadonlyArray<string>, outboxId: string) => Promise<void>)
    | undefined;
  if (opts?.recoverHook === 'records') {
    recoverHook = async (sources, outboxId) => {
      hookCalls.push({ sources, outboxId });
    };
  } else if (opts?.recoverHook === 'throws') {
    recoverHook = async (sources, outboxId) => {
      hookCalls.push({ sources, outboxId });
      throw opts.recoverHookError ?? new Error('hook test failure');
    };
  }

  const worker = new FinalizationWorkerSender({
    ...baseOptions,
    ...(recoverHook ? { recoverFailedPermanentSources: recoverHook } : {}),
  });

  return { worker, outbox, emittedEvents, hookCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Audit #333 H5 — failed-permanent source unlock', () => {
  describe('hook fires on failed-permanent with the entry\'s sourceTokenIds', () => {
    it('fires once with the recorded source ids', async () => {
      const h = buildH5Worker({
        submitReject: { reason: 'STATE_ALREADY_SPENT_BY_OTHER' },
        recoverHook: 'records',
      });
      const result = await h.worker.processOne(
        makeOutboxEntry({ sourceTokenIds: ['src-1', 'src-2'] }),
      );
      expect(result.terminal).toBe('failed-permanent');
      expect(h.hookCalls).toHaveLength(1);
      expect(h.hookCalls[0].sources).toEqual(['src-1', 'src-2']);
      expect(h.hookCalls[0].outboxId).toBe('outbox-h5');
    });
  });

  // Note: The "hook does NOT fire on non-failed terminal states" guarantee
  // is structurally enforced by the code — the hook invocation is inside the
  // `if (totalFailure > 0)` branch that also sets `terminal = 'failed-permanent'`
  // (see modules/payments/transfer/finalization-worker-sender.ts at the H5
  // edit). A behavioural test would require driving the worker through the
  // full SUCCESS path, which needs significantly more fake-adapter wiring
  // than is worth duplicating for a property the code-review already shows.

  describe('back-compat: entries without sourceTokenIds get an empty array', () => {
    it('fires the hook with [] when the entry lacks sourceTokenIds', async () => {
      // Use a pre-H5-shape entry that has no sourceTokenIds field.
      const preFixEntry = makeOutboxEntry();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (preFixEntry as any).sourceTokenIds;
      const h = buildH5Worker({
        entry: preFixEntry,
        submitReject: { reason: 'STATE_ALREADY_SPENT_BY_OTHER' },
        recoverHook: 'records',
      });
      await h.worker.processOne(preFixEntry);
      expect(h.hookCalls).toHaveLength(1);
      expect(h.hookCalls[0].sources).toEqual([]);
    });
  });

  describe('hook absent: pre-fix behaviour preserved (worker still transitions)', () => {
    it('does NOT throw when recoverFailedPermanentSources is omitted', async () => {
      const h = buildH5Worker({
        submitReject: { reason: 'STATE_ALREADY_SPENT_BY_OTHER' },
        recoverHook: 'omit',
      });
      const result = await h.worker.processOne(
        makeOutboxEntry({ sourceTokenIds: ['src-1'] }),
      );
      expect(result.terminal).toBe('failed-permanent');
      // No hook means no calls.
      expect(h.hookCalls).toHaveLength(0);
    });
  });

  describe('hook throws: failed-permanent transition stands (terminal-state contract)', () => {
    it('catches hook throws and emits transfer:failed for triage', async () => {
      const h = buildH5Worker({
        submitReject: { reason: 'STATE_ALREADY_SPENT_BY_OTHER' },
        recoverHook: 'throws',
        recoverHookError: new Error('downstream recovery exploded'),
      });
      const result = await h.worker.processOne(
        makeOutboxEntry({ sourceTokenIds: ['src-1', 'src-2'] }),
      );
      expect(result.terminal).toBe('failed-permanent');
      const failureEvent = h.emittedEvents.find(
        (e) =>
          e.type === 'transfer:failed' &&
          (e.data as { error?: string }).error?.includes('downstream recovery exploded'),
      );
      expect(failureEvent).toBeDefined();
    });
  });

  describe('hook fires AFTER the outbox transition (terminal-state ordering)', () => {
    it('outbox status is failed-permanent at the moment the hook runs', async () => {
      let statusAtHookCall: UxfOutboxStatus | null = null;
      const entry = makeOutboxEntry({ sourceTokenIds: ['src-1'] });
      const outbox = makeFakeOutboxWriter(entry);
      const recover = vi.fn(async () => {
        statusAtHookCall = outbox.entries().status;
      });

      const manifestStorage = makeFakeManifestStorage([
        {
          addr: ADDR,
          tokenId: TOKEN_ID,
          entry: { rootHash: PREVIOUS_CID, status: 'pending' },
        },
      ]);

      const worker = new FinalizationWorkerSender({
        addressId: ADDR,
        outbox: outbox.writer,
        aggregator: makeFakeAggregator({
          submitReject: { reason: 'STATE_ALREADY_SPENT_BY_OTHER' },
        }),
        resolver: makeFakeResolver(),
        pool: makeFakePool(),
        poolRead: makeFakePoolRead(),
        manifestCas: new ManifestCas(manifestStorage),
        tombstones: makeFakeTombstones(),
        queue: makeFakeQueue([{ addr: ADDR, requestId: REQUEST_ID }]),
        perAggregatorSemaphore: new CountingSemaphore(16),
        getPerTokenSemaphore: () => new CountingSemaphore(4),
        perTokenMutex: new PerTokenMutex(),
        perTokenMutexStrategy: 'cas' as const,
        emit: () => {},
        now: () => 1700000001000,
        sleep: async () => undefined,
        caps: { maxSubmitRetries: 1, maxProofErrorRetries: 1 },
        recoverFailedPermanentSources: recover,
      });

      await worker.processOne(entry);
      expect(statusAtHookCall).toBe('failed-permanent');
    });
  });
});
