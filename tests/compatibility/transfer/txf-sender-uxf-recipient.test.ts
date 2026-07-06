/**
 * T.8.E.2 — Cross-mode compatibility: TXF sender ↔ UXF recipient.
 *
 * **Goal**: a sender that opted into the legacy `transferMode: 'txf'` path
 * (T.7.A `txf-sender.ts`) emits ONE Nostr `TOKEN_TRANSFER` event PER token
 * shaped as a Sphere TXF `{sourceToken, transferTx}` envelope. A modern UXF
 * recipient (post-T.7.B) MUST decode each event through the legacy-shape
 * adapter (T.7.B `legacy-shape-adapter.ts`) and converge on the SAME
 * per-token disposition outcomes the equivalent UXF bundle would produce
 * (§10.2 single-pipeline guarantee).
 *
 * The acceptance criterion is **not** byte-equality with a UXF reference
 * (TXF carries no CAR / no `bundleCid`); the criterion is the disposition
 * matrix per §5.3 — VALID / AUDIT / INVALID / PENDING / CONFLICTING — must
 * agree with the UXF path for the same chain inputs.
 *
 * **Scope of this test**:
 *  1. Sender produces N TXF Nostr payloads via `sendTxfUxf`
 *     (conservative + instant variants, N=1 and N=3).
 *  2. Each captured payload is fed to `adaptLegacyShape` with happy-path
 *     mocks for the disposition hooks (predicate / authenticator / proof /
 *     oracle / continuity-walker / local-manifest).
 *  3. We assert:
 *      a. One per-token Nostr event published per source token.
 *      b. Each event is recognized as `'sphere-txf'` by the adapter's
 *         `classifyLegacyShape`.
 *      c. The adapter produces exactly ONE `DispositionRecord` per event
 *         with `disposition === 'VALID'` (happy path).
 *      d. The synthetic `bundleCid` carries the documented
 *         `legacy-sphere-txf-` prefix (forensic provenance).
 *      e. The instant variant (`inclusionProof: null`) routes to the
 *         finalization-queue enqueuer with `disposition === 'PENDING'`
 *         and queue entries keyed by `${tokenId}:${txIndex}`.
 *      f. Round-trip is idempotent: re-running the adapter on the same
 *         payload produces a structurally-equivalent disposition list.
 *
 * **Not covered here** (delegated to existing tests):
 *  - The disposition engine's branch logic — `disposition-engine.test.ts`.
 *  - The full TXF sender outbox / cascade-warning flow — `txf-sender.test.ts`.
 *  - The full legacy-shape-adapter classifier matrix — `legacy-shape-adapter.test.ts`.
 *  - Production wiring of `extractTxLegacyChain` (SDK / CBOR parsing) —
 *    here we drive the adapter via a stub hook that returns canned entries
 *    derived from the captured TXF payload (the test SDK boundary).
 *
 * Spec references:
 *  - §2.4   TXF wire-shape (legacy, explicit opt-in).
 *  - §3.4   Sphere TXF detection precedence #4 (`sourceToken && transferTx`).
 *  - §4.4.1 / §4.4.2  Conservative / Instant TXF sequence diagrams.
 *  - §10.2  Single-pipeline convergence (TXF + UXF arrivals share §5.3).
 *
 * @packageDocumentation
 */

import { describe, expect, it, vi } from 'vitest';

import {
  sendTxfUxf,
  type TxfCommitResult,
  type TxfSenderDeps,
} from '../../../extensions/uxf/pipeline/txf-sender';
import {
  adaptLegacyShape,
  classifyLegacyShape,
  type FinalizationQueueEnqueuer,
  type LegacyTokenEntry,
} from '../../../extensions/uxf/pipeline/legacy-shape-adapter';
import type { ContinuityResult, TxLike } from '../../../extensions/uxf/pipeline/continuity-walker';
import type { EvaluatePredicateResult } from '../../../extensions/uxf/pipeline/predicate-evaluator';
import type { ProofVerifyStatus } from '../../../extensions/uxf/pipeline/proof-verifier';
import type { VerifyAuthenticatorResult } from '../../../extensions/uxf/pipeline/authenticator-verifier';
import type { OracleProvider } from '../../../oracle/oracle-provider';
import type { TransportProvider } from '../../../transport';
import type { PeerInfo } from '../../../transport/transport-provider';
import type { ContentHash } from '../../../extensions/uxf/bundle/types';
import type { LegacyTokenTransferPayload } from '../../../extensions/uxf/types/uxf-transfer';
import type {
  FullIdentity,
  SphereEventMap,
  SphereEventType,
  Token,
} from '../../../types';
import type { FinalizationQueueEntry } from '../../../extensions/uxf/pipeline/finalization-queue';
import { TOKEN_A } from '../../fixtures/uxf-mock-tokens';

// =============================================================================
// 1. Shared fixtures
// =============================================================================

const SENDER_PUBKEY = 'fe'.repeat(32);
const STATE_HEAD = ('0'.repeat(60) + '5646') as string;
const ADDR = 'DIRECT://addr-A';
const PUBKEY_BYTES = (() => {
  const k = new Uint8Array(33);
  k[0] = 0x02;
  return k;
})();
const TRUSTBASE = {} as unknown;

function makeToken(id: string): Token {
  return {
    id,
    coinId: 'UCT',
    symbol: 'UCT',
    name: 'Unicity',
    decimals: 8,
    amount: '1000000',
    status: 'confirmed',
    createdAt: 0,
    updatedAt: 0,
    sdkData: JSON.stringify(TOKEN_A),
  };
}

function makeCommitResult(
  sourceTokenId: string,
  variant: 'conservative' | 'instant',
): TxfCommitResult {
  // Mirrors the sender-side wire shape: conservative attaches a proof,
  // instant carries `inclusionProof: null` on the embedded transferTx.
  const transferTx = JSON.stringify({
    data: { requestId: `req-${sourceTokenId}` },
    inclusionProof:
      variant === 'instant'
        ? null
        : { merkleTreePath: { root: 'mock-proof-root', steps: [] } },
  });
  return {
    sourceTokenId,
    method: 'direct',
    requestIdHex: `req-${sourceTokenId}`,
    sourceTokenJson: JSON.stringify({ id: sourceTokenId, fixture: 'TOKEN_A' }),
    transferTxJson: transferTx,
    tokenClass: 'coin',
  };
}

function makeOracleStub(): OracleProvider {
  return {
    id: 'mock-oracle',
    name: 'Mock Oracle',
    type: 'network',
    description: 'Test stub',
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: () => true,
    getStatus: () => 'connected' as const,
    initialize: vi.fn(),
    submitCommitment: vi.fn(),
    getProof: vi.fn(),
    waitForProof: vi.fn(),
    validateToken: vi.fn(),
    isSpent: vi.fn().mockResolvedValue(false),
    getTokenState: vi.fn().mockResolvedValue(null),
    getCurrentRound: vi.fn().mockResolvedValue(1),
  };
}

interface CapturedTxfEvent {
  readonly recipient: string;
  readonly payload: LegacyTokenTransferPayload;
}

interface MockTransport extends TransportProvider {
  readonly _events: CapturedTxfEvent[];
}

function makeTransportStub(): MockTransport {
  const events: CapturedTxfEvent[] = [];
  const stub: MockTransport = {
    _events: events,
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p',
    description: 'Test stub',
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: () => true,
    getStatus: () => 'connected' as const,
    setIdentity: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue('event-id'),
    onMessage: vi.fn().mockReturnValue(() => undefined),
    sendTokenTransfer: vi
      .fn()
      .mockImplementation(async (recipient: string, payload: unknown) => {
        events.push({
          recipient,
          payload: payload as LegacyTokenTransferPayload,
        });
        return 'event-id';
      }),
    onTokenTransfer: vi.fn().mockReturnValue(() => undefined),
  };
  return stub;
}

function makeIdentity(): FullIdentity {
  return {
    chainPubkey: '02'.padEnd(66, 'a'),
    directAddress: 'DIRECT://mock-direct',
    privateKey: '01'.repeat(32),
  };
}

function makePeerInfo(): PeerInfo {
  return {
    transportPubkey: 'bb'.repeat(32),
    chainPubkey: '02'.padEnd(66, 'c'),
    directAddress: 'DIRECT://bob-direct',
    timestamp: 0,
    nametag: 'bob',
  };
}

interface DepsBundle {
  readonly deps: TxfSenderDeps;
  readonly transport: MockTransport;
}

function makeDeps(tokens: Token[], results: TxfCommitResult[]): DepsBundle {
  const transport = makeTransportStub();
  const events: Array<{ type: SphereEventType; data: unknown }> = [];
  const deps: TxfSenderDeps = {
    aggregator: makeOracleStub(),
    transport,
    identity: makeIdentity(),
    addressId: 'addr-test-001',
    senderTransportPubkey: SENDER_PUBKEY,
    emit: <T extends SphereEventType>(type: T, data: SphereEventMap[T]): void => {
      events.push({ type, data });
    },
    availableSources: () => tokens,
    selectSources: async () => tokens,
    commitSources: async () => results,
    transferId: 'fixed-test-transfer-id',
  };
  return { deps, transport };
}

function happyHooks(): {
  readonly evaluatePredicate: () => Promise<EvaluatePredicateResult>;
  readonly verifyAuthenticator: () => Promise<VerifyAuthenticatorResult>;
  readonly walkContinuity: (chain: ReadonlyArray<TxLike>) => ContinuityResult;
  readonly verifyProof: () => Promise<ProofVerifyStatus>;
  readonly oracleIsSpent: (stateHash: string) => Promise<boolean>;
  readonly readLocalManifest: () => Promise<undefined>;
} {
  return {
    evaluatePredicate: async () => ({ ok: true, bindsToUs: true }),
    verifyAuthenticator: async () => ({ ok: true, valid: true }),
    walkContinuity: () => ({ ok: true }),
    verifyProof: async () => 'OK' as ProofVerifyStatus,
    oracleIsSpent: async () => false,
    readLocalManifest: async () => undefined,
  };
}

/**
 * Build a `LegacyTokenEntry` deterministically from a captured TXF
 * payload. Production wiring lives behind the SDK; for compatibility
 * tests we synthesize a hydrated entry with a deterministic
 * `observedTokenContentHash` derived from the source tokenId so re-arrivals
 * land at the same multi-rep slot (idempotency property).
 */
function buildEntryFromTxfPayload(
  sourceTokenId: string,
  variant: 'conservative' | 'instant',
): LegacyTokenEntry {
  const observedTokenContentHash = ('0'.repeat(60) +
    sourceTokenId.slice(-4).padStart(4, '0')) as ContentHash;
  return {
    tokenId: sourceTokenId,
    observedTokenContentHash,
    chain: [
      {
        sourceState: 's0',
        destinationState: 's1',
        authenticator: { kind: 'auth' },
        transactionHash: { kind: 'txh' },
        // Conservative attaches an inclusion proof; instant null'd it.
        inclusionProof: variant === 'conservative' ? { kind: 'proof' } : null,
        requestId: `req-${sourceTokenId}`,
        ...(variant === 'instant'
          ? {
              transactionHashHex: 'aa'.repeat(34),
              authenticatorHex: 'bb'.repeat(32),
            }
          : {}),
      },
    ],
    currentStatePredicate: { kind: 'predicate' },
    currentDestinationStateHash: STATE_HEAD,
  };
}

// =============================================================================
// 2. Conservative TXF sender → UXF recipient (happy path)
// =============================================================================

describe('TXF sender → UXF recipient — conservative variant', () => {
  it.each([{ n: 1 }, { n: 3 }])(
    'N=$n tokens — every published event converges on a VALID disposition',
    async ({ n }) => {
      const tokens = Array.from({ length: n }, (_, i) =>
        makeToken(`tok-${String(i + 1).padStart(3, '0')}`),
      );
      const results = tokens.map((t) => makeCommitResult(t.id, 'conservative'));

      const { deps, transport } = makeDeps(tokens, results);
      await sendTxfUxf(
        {
          recipient: '@bob',
          coinId: 'UCT',
          amount: String(1000000 * n),
        },
        makePeerInfo(),
        deps,
        'conservative',
      );

      // Acceptance (a): N events, one per source token.
      expect(transport._events).toHaveLength(n);

      const dispositions = await Promise.all(
        transport._events.map(async (evt, idx) => {
          // Acceptance (b): every event recognized as 'sphere-txf'.
          expect(classifyLegacyShape(evt.payload)).toBe('sphere-txf');

          const sourceTokenId = tokens[idx]!.id;
          const out = await adaptLegacyShape({
            payload: evt.payload,
            senderTransportPubkey: SENDER_PUBKEY,
            addr: ADDR,
            ourPubkey: PUBKEY_BYTES,
            trustBase: TRUSTBASE,
            extractTxLegacyChain: async () => [
              buildEntryFromTxfPayload(sourceTokenId, 'conservative'),
            ],
            ...happyHooks(),
          });
          return out;
        }),
      );

      // Acceptance (c): exactly ONE DispositionRecord per event (Sphere TXF
      // shape always decomposes to one entry); all VALID.
      for (let i = 0; i < n; i++) {
        const out = dispositions[i]!;
        expect(out).toHaveLength(1);
        expect(out[0].disposition).toBe('VALID');
        expect(out[0].tokenId).toBe(tokens[i]!.id);
        // Acceptance (d): bundleCid carries 'legacy-sphere-txf-' prefix.
        expect(out[0].bundleCid).toContain('legacy-sphere-txf-');
        expect(out[0].senderTransportPubkey).toBe(SENDER_PUBKEY);
      }
    },
  );

  it('idempotency: re-running the adapter on the same payload produces equivalent dispositions', async () => {
    const token = makeToken('tok-001');
    const result = makeCommitResult(token.id, 'conservative');
    const { deps, transport } = makeDeps([token], [result]);

    await sendTxfUxf(
      { recipient: '@bob', coinId: 'UCT', amount: '1000000' },
      makePeerInfo(),
      deps,
      'conservative',
    );

    const evt = transport._events[0]!;
    const baseInput = {
      payload: evt.payload,
      senderTransportPubkey: SENDER_PUBKEY,
      addr: ADDR,
      ourPubkey: PUBKEY_BYTES,
      trustBase: TRUSTBASE,
      extractTxLegacyChain: async () => [
        buildEntryFromTxfPayload(token.id, 'conservative'),
      ],
      ...happyHooks(),
    };
    const first = await adaptLegacyShape(baseInput);
    const second = await adaptLegacyShape(baseInput);

    // Acceptance (f): structurally equivalent. Both runs see VALID, the
    // synthetic bundleCid is stable, and tokenId / senderTransportPubkey
    // round-trip across the second invocation. Order is also deterministic
    // (the engine's iteration is over sequential `chain[]`).
    expect(first.length).toBe(second.length);
    expect(first[0].disposition).toBe('VALID');
    expect(second[0].disposition).toBe('VALID');
    expect(first[0].tokenId).toBe(second[0].tokenId);
    expect(first[0].bundleCid).toBe(second[0].bundleCid);
    expect(first[0].observedTokenContentHash).toBe(second[0].observedTokenContentHash);
    expect(first[0].senderTransportPubkey).toBe(second[0].senderTransportPubkey);
  });
});

// =============================================================================
// 3. Instant TXF sender → UXF recipient (PENDING + queue)
// =============================================================================

describe('TXF sender → UXF recipient — instant variant', () => {
  it('inclusionProof:null arrival routes to PENDING + finalization queue', async () => {
    const token = makeToken('tok-instant-001');
    const result = makeCommitResult(token.id, 'instant');
    const { deps, transport } = makeDeps([token], [result]);

    await sendTxfUxf(
      {
        recipient: '@bob',
        coinId: 'UCT',
        amount: '1000000',
        transferMode: 'instant',
      },
      makePeerInfo(),
      deps,
      // The instant variant requires onTriggerFinalization in production
      // wiring; the orchestrator tolerates `undefined` (matches existing
      // unit tests). The recipient-side queue is asserted below.
      'instant',
    );

    expect(transport._events).toHaveLength(1);
    const evt = transport._events[0]!;
    expect(classifyLegacyShape(evt.payload)).toBe('sphere-txf');

    const enqueued: Array<{
      readonly addr: string;
      readonly entry: FinalizationQueueEntry;
    }> = [];
    const enqueue: FinalizationQueueEnqueuer = async (addr, entry) => {
      enqueued.push({ addr, entry });
    };

    const out = await adaptLegacyShape({
      payload: evt.payload,
      senderTransportPubkey: SENDER_PUBKEY,
      addr: ADDR,
      ourPubkey: PUBKEY_BYTES,
      trustBase: TRUSTBASE,
      extractTxLegacyChain: async () => [
        buildEntryFromTxfPayload(token.id, 'instant'),
      ],
      enqueueFinalization: enqueue,
      ...happyHooks(),
    });

    // Acceptance (e): one PENDING disposition; one queue entry; entryId
    // is `${tokenId}:${txIndex}` per the worker's keying convention.
    expect(out).toHaveLength(1);
    expect(out[0].disposition).toBe('PENDING');
    expect(out[0].tokenId).toBe(token.id);

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].addr).toBe(ADDR);
    expect(enqueued[0].entry.tokenId).toBe(token.id);
    expect(enqueued[0].entry.txIndex).toBe(0);
    expect(enqueued[0].entry.entryId).toBe(`${token.id}:0`);
    expect(enqueued[0].entry.source).toBe('received');
    expect(enqueued[0].entry.status).toBe('pending');
    expect(enqueued[0].entry.bundleCid).toContain('legacy-sphere-txf-');
  });

  it('multi-token instant TXF: each event independently routes through PENDING + queue', async () => {
    // The TXF wire shape is one-event-per-token even in instant mode; the
    // recipient adapter processes each event in isolation. We assert N
    // queue entries land for N events (one each) — no cross-talk.
    const tokens = [
      makeToken('tok-a01'),
      makeToken('tok-a02'),
      makeToken('tok-a03'),
    ];
    const results = tokens.map((t) => makeCommitResult(t.id, 'instant'));
    const { deps, transport } = makeDeps(tokens, results);

    await sendTxfUxf(
      {
        recipient: '@bob',
        coinId: 'UCT',
        amount: '3000000',
        transferMode: 'instant',
      },
      makePeerInfo(),
      deps,
      'instant',
    );

    expect(transport._events).toHaveLength(3);

    const enqueued: Array<{
      readonly addr: string;
      readonly entry: FinalizationQueueEntry;
    }> = [];
    const enqueue: FinalizationQueueEnqueuer = async (addr, entry) => {
      enqueued.push({ addr, entry });
    };

    const dispositions = await Promise.all(
      transport._events.map(async (evt, idx) => {
        return adaptLegacyShape({
          payload: evt.payload,
          senderTransportPubkey: SENDER_PUBKEY,
          addr: ADDR,
          ourPubkey: PUBKEY_BYTES,
          trustBase: TRUSTBASE,
          extractTxLegacyChain: async () => [
            buildEntryFromTxfPayload(tokens[idx]!.id, 'instant'),
          ],
          enqueueFinalization: enqueue,
          ...happyHooks(),
        });
      }),
    );

    for (const out of dispositions) {
      expect(out).toHaveLength(1);
      expect(out[0].disposition).toBe('PENDING');
    }
    expect(enqueued).toHaveLength(3);
    // Per-token isolation: every queue entry id is `${tokenId}:0`,
    // covering all three source tokens in iteration order.
    const enqueuedIds = enqueued.map((q) => q.entry.entryId).sort();
    const expectedIds = tokens
      .map((t) => `${t.id}:0`)
      .sort();
    expect(enqueuedIds).toEqual(expectedIds);
  });
});
