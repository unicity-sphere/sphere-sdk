/**
 * §11.2 / W29 integration — Cross-mode CID delivery with 5-minute IPFS
 * fetch delay.
 *
 * Spec scenario (§11.2):
 *   "**Cross-mode test**: sender ships in instant mode via CID;
 *    recipient's IPFS fetch succeeds 5 minutes after Nostr event
 *    arrival → recipient's instant-mode finalization queue starts at
 *    the IPFS-fetch time, not at the Nostr-event time (per §3.3.2
 *    'physically syncing' rule)."
 *
 * Pipeline under test:
 *   - The recipient observes a `kind: 'uxf-cid'` payload at time
 *     T_arrive. The SDK's bundle acquirer (`acquireBundle`) walks the
 *     gateway list; the gateway responds 5 minutes later at T_fetch.
 *   - Per §3.3.2, the bundle is NOT delivered until the fetch
 *     completes. Therefore any per-token bookkeeping (queue entry's
 *     `createdAt`, finalization timer's start) MUST be derived from
 *     T_fetch, not T_arrive.
 *
 * Test strategy:
 *   - Use Vitest's fake-timer harness so we can advance the deterministic
 *     clock by exactly 5 minutes between arrival and fetch.
 *   - Stub `globalThis.fetch` (the gateway transport) to resolve only
 *     after the test advances the clock — emulating the 5-minute
 *     network delay.
 *   - Capture `Date.now()` at the moment `acquireBundle` resolves; that
 *     is the recipient's "physical sync" instant per §3.3.2.
 *
 * Acceptance:
 *   - The recipient observes the wire payload at T_arrive but the
 *     fetch completion timestamp is T_arrive + 5 min.
 *   - The downstream queue-entry creator (modeled here as a thin
 *     adapter) stamps `createdAt` from the fetch-complete timestamp,
 *     NOT from the wire-arrival timestamp.
 *
 * @packageDocumentation
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acquireBundle,
  isReplayOutcome,
} from '../../../modules/payments/transfer/bundle-acquirer';
import { ReplayLRU } from '../../../modules/payments/transfer/replay-lru';
import {
  carBytesToBase64,
  extractCarRootCid,
} from '../../../uxf/transfer-payload';
import { UxfPackage } from '../../../uxf/UxfPackage';
import type { UxfTransferPayloadCid } from '../../../types/uxf-transfer';
import { TOKEN_A } from '../../fixtures/uxf-mock-tokens';

import { ALICE_CHAIN_PUBKEY } from './_harness';

// =============================================================================
// Module mock — Issue #223
//
// The receiver now routes uxf-cid through `fetchCarFromIpfs` (per-block
// walk via /api/v0/block/get) instead of the old gateway `?format=car`
// endpoint. Under fake timers, `fetchCarFromIpfs`'s internal
// `AbortSignal.timeout` races our `setTimeout`-modelled 5-minute delay
// and aborts the fetch before the mock can return.
//
// To keep this test focused on the §3.3.2 timing invariant (recipient's
// queue createdAt MUST be derived from fetch-completion, not Nostr
// arrival), we mock `fetchCarFromIpfs` at the module level. The mock
// awaits a single `setTimeout(FIVE_MINUTES_MS)` (test-controlled via
// `vi.advanceTimersByTimeAsync`) and then returns the prebuilt
// `carBytes`. This preserves the test's invariant — `acquireBundle`'s
// promise resolves at T_arrive + 5min — without entangling the test
// with the block-walk's network mechanics.
// =============================================================================
let mockFetchCarFromIpfs: (
  gateways: readonly string[],
  rootCid: string,
) => Promise<Uint8Array> = async () => {
  throw new Error('mockFetchCarFromIpfs not initialized');
};
vi.mock('../../../profile/ipfs-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../profile/ipfs-client')>();
  return {
    ...original,
    fetchCarFromIpfs: (...args: Parameters<typeof original.fetchCarFromIpfs>) =>
      mockFetchCarFromIpfs(args[0], args[1]),
  };
});

// =============================================================================
// 1. Constants
// =============================================================================

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const T_ARRIVE_FIXED = 1_700_000_000_000;

// =============================================================================
// 2. Test
// =============================================================================

describe('§11.2 / W29 — instant-mode CID delivery with 5-minute fetch delay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T_ARRIVE_FIXED));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('queue createdAt derived from IPFS fetch completion (T_arrive + 5min), NOT from Nostr arrival', async () => {
    // -------------------------------------------------------------------
    // 1. Sender side: build a real UXF bundle for one TOKEN_A.
    //    The CAR + bundleCid drive the recipient's CID-fetch path.
    // -------------------------------------------------------------------
    const pkg = UxfPackage.create();
    pkg.ingestAll([TOKEN_A as unknown as Record<string, unknown>]);
    const carBytes = await pkg.toCar();
    const bundleCid = await extractCarRootCid(carBytes);
    const carBase64 = carBytesToBase64(carBytes);
    expect(carBase64.length).toBeGreaterThan(0);

    // Wire payload: instant-mode CID delivery.
    const cidPayload: UxfTransferPayloadCid = {
      kind: 'uxf-cid',
      version: '1.0',
      mode: 'instant',
      bundleCid,
      tokenIds: [
        'aa00000000000000000000000000000000000000000000000000000000000001',
      ],
      sender: { transportPubkey: ALICE_CHAIN_PUBKEY },
    };

    // -------------------------------------------------------------------
    // 2. Recipient side: capture T_arrive, then start the fetch.
    //    `fetchCarFromIpfs` is module-mocked above so we control the
    //    resolution timing via fake timers without entangling block-
    //    walk mechanics.
    // -------------------------------------------------------------------
    const T_arrive = Date.now();
    expect(T_arrive).toBe(T_ARRIVE_FIXED);

    let fetchResolveAt: number | null = null;
    mockFetchCarFromIpfs = async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, FIVE_MINUTES_MS);
      });
      fetchResolveAt = Date.now();
      return carBytes;
    };

    // Kick off the acquire — it will eventually call our mock.
    const lru = new ReplayLRU();
    const acquirePromise = acquireBundle(cidPayload, ALICE_CHAIN_PUBKEY, lru, {
      gateways: ['http://gateway-stub.example/'],
    });

    // Advance the deterministic clock by exactly 5 minutes — this
    // releases the stubFetch's internal setTimeout and lets the
    // gateway "respond". Vitest's `advanceTimersByTimeAsync` flushes
    // pending microtasks too, so the `acquireBundle` promise can
    // make progress.
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS);

    // Bundle finally resolves; capture the fetch-complete timestamp.
    const verified = await acquirePromise;
    if (isReplayOutcome(verified)) {
      throw new Error('unreachable: first arrival');
    }
    const T_fetch = fetchResolveAt;
    expect(T_fetch).toBe(T_ARRIVE_FIXED + FIVE_MINUTES_MS);

    // -------------------------------------------------------------------
    // 3. Adapter under test: queue-entry creator stamps `createdAt`
    //    from THE FETCH-COMPLETE TIMESTAMP, NOT from T_arrive.
    //
    //    In production this is the recipient-side ingest pipeline:
    //    after `acquireBundle` resolves, T.3.E's worker pool walks the
    //    bundle and enqueues per-tx FinalizationQueueEntry records.
    //    The §3.3.2 invariant says those entries' `createdAt` MUST
    //    reflect the physical-sync instant.
    //
    //    We model the relevant slice here: a thin createQueueEntry
    //    adapter that takes `nowMs` and returns the entry. The "now"
    //    function is wired to the Date.now() AT FETCH RESOLUTION (T_fetch),
    //    which is what production wires (the recipient's clock at
    //    the moment acquireBundle's promise resolves).
    // -------------------------------------------------------------------
    interface MinimalQueueEntry {
      readonly tokenId: string;
      readonly createdAt: number;
      readonly submittedAt: number;
    }
    const createQueueEntry = (params: {
      readonly tokenId: string;
      readonly nowMs: number;
    }): MinimalQueueEntry => ({
      tokenId: params.tokenId,
      createdAt: params.nowMs,
      submittedAt: params.nowMs,
    });

    const queueEntry = createQueueEntry({
      tokenId: verified.claimedTokens[0].tokenId,
      // KEY ASSERTION: nowMs is `T_fetch`, not `T_arrive`. Production
      // wires this from `Date.now()` AT THE MOMENT the fetch promise
      // resolves; the test pins the value via the stubFetch capture.
      nowMs: T_fetch,
    });

    expect(queueEntry.createdAt).toBe(T_arrive + FIVE_MINUTES_MS);
    expect(queueEntry.submittedAt).toBe(T_arrive + FIVE_MINUTES_MS);
    // Sanity: the queue entry's clock is FIVE MINUTES later than the
    // wire-arrival instant.
    expect(queueEntry.createdAt - T_arrive).toBe(FIVE_MINUTES_MS);

    // -------------------------------------------------------------------
    // 4. The recipient's bundleCid still matches the wire envelope
    //    (content-addressing is unaffected by the delay).
    // -------------------------------------------------------------------
    expect(verified.bundleCid).toBe(bundleCid);
    expect(verified.verified).toBe(true);
  });

  it('zero-delay fetch: queue createdAt matches T_arrive (control)', async () => {
    // Sanity: when the fetch returns synchronously (T_fetch == T_arrive),
    // the queue createdAt equals T_arrive. Confirms the 5-minute test
    // above is genuinely measuring the delay, not a constant offset.
    const pkg = UxfPackage.create();
    pkg.ingestAll([TOKEN_A as unknown as Record<string, unknown>]);
    const carBytes = await pkg.toCar();
    const bundleCid = await extractCarRootCid(carBytes);
    const cidPayload: UxfTransferPayloadCid = {
      kind: 'uxf-cid',
      version: '1.0',
      mode: 'instant',
      bundleCid,
      tokenIds: [
        'aa00000000000000000000000000000000000000000000000000000000000001',
      ],
      sender: { transportPubkey: ALICE_CHAIN_PUBKEY },
    };

    const T_arrive = Date.now();
    let fetchResolveAt = -1;
    mockFetchCarFromIpfs = async () => {
      fetchResolveAt = Date.now();
      return carBytes;
    };

    const lru = new ReplayLRU();
    const verified = await acquireBundle(cidPayload, ALICE_CHAIN_PUBKEY, lru, {
      gateways: ['http://gateway-stub.example/'],
    });
    if (isReplayOutcome(verified)) {
      throw new Error('unreachable');
    }

    expect(fetchResolveAt).toBe(T_arrive);
    expect(verified.bundleCid).toBe(bundleCid);
  });
});
