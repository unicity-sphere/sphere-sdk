/**
 * Tests for `modules/payments/transfer/instant-sender.ts` (T.5.A).
 *
 * Exercises the instant-mode UXF send orchestrator with inline-mocked
 * dependencies. Spec references:
 *  - §2.1   Instant mode definition.
 *  - §2.3   Chain-mode framing — K unfinalized predecessors.
 *  - §4.3   Outstanding/completed two-set form.
 *  - §6.1   Sender-side worker semantics.
 *  - §6.1.1 Cascade rule.
 *  - §7.0   Outbox state machine.
 *  - C11    Class-disjoint splitParent rule.
 *
 * Scenarios covered:
 *  - 1-token instant send → outbox transitions packaging → sending →
 *    delivered-instant; outstandingRequestIds=[req-tok-1]; source
 *    marked pending; `transfer:submitted` emitted (NOT confirmed).
 *  - Chain mode K=3 with allowPendingTokens=true → outstandingRequestIds
 *    contains all K commitments (new + K-1 inherited).
 *  - NFT instant with confirmNftPending=true → no splitParent on result;
 *    tokenClass='nft' preserves tokenId.
 *  - Coin instant → splitParent set on result; status='pending'.
 *  - Cascade-risk-warning emitted when source is pending coin.
 *  - onTriggerFinalization callback invoked AFTER delivered-instant.
 *  - CID-bound delivery emits `pinned` outbox transition.
 *  - C11 violations rejected (NFT with splitParent, coin without).
 *  - Transport rejection → TRANSPORT_ERROR + `transfer:failed`.
 *  - Feature flag OFF: legacy path runs unchanged (export-shape anchor).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  sendInstantUxf,
  __resetSourceLocksForTesting,
  type InstantCommitResult,
  type InstantSenderDeps,
  type InstantOutboxHooks,
} from '../../../../modules/payments/transfer/instant-sender';
import type { TokenLike } from '../../../../modules/payments/transfer/classify-token';
import type { PublishToIpfsCallback } from '../../../../modules/payments/transfer/delivery-resolver';
import { isSphereError } from '../../../../core/errors';
import type { OracleProvider } from '../../../../oracle/oracle-provider';
import type { TransportProvider } from '../../../../transport';
import type { PeerInfo } from '../../../../transport/transport-provider';
import type {
  FullIdentity,
  SphereEventMap,
  SphereEventType,
  Token,
  TransferRequest,
} from '../../../../types';
import type {
  UxfTransferOutboxEntry,
  UxfOutboxStatus,
} from '../../../../types/uxf-outbox';
import type {
  UxfTransferPayloadCar,
  UxfTransferPayloadCid,
} from '../../../../types/uxf-transfer';
import { TOKEN_A } from '../../../fixtures/uxf-mock-tokens';

// =============================================================================
// 1. Shared test fixtures + helpers
// =============================================================================

function makeToken(
  id: string,
  fixture: Record<string, unknown>,
  overrides: Partial<Token> = {},
): Token {
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
    sdkData: JSON.stringify(fixture),
    ...overrides,
  };
}

function makeCommitResult(params: {
  readonly sourceTokenId: string;
  readonly fixture: Record<string, unknown>;
  readonly rewriteTokenId?: string;
  readonly tokenClass?: 'coin' | 'nft';
  readonly inheritedRequestIds?: ReadonlyArray<string>;
  readonly splitParentTokenId?: string;
  readonly requestIdHex?: string;
}): InstantCommitResult {
  const f = params.fixture;
  // The orchestrator's UxfPackage ingest is exercised here by the
  // fixture's existing genesis state; we keep `transactions: []` from
  // the fixture (matching the conservative-sender test pattern). The
  // production dispatcher appends a real transfer transaction with
  // `inclusionProof: null` — that path is exercised in integration
  // tests, not unit tests.
  const rewritten: Record<string, unknown> = {
    ...f,
    genesis: {
      ...((f as { genesis: Record<string, unknown> }).genesis),
      data: {
        ...((f as { genesis: { data: Record<string, unknown> } }).genesis.data),
        ...(params.rewriteTokenId !== undefined
          ? { tokenId: params.rewriteTokenId }
          : {}),
      },
    },
  };
  const tokenClass = params.tokenClass ?? 'coin';
  const base: InstantCommitResult = {
    sourceTokenId: params.sourceTokenId,
    method: 'direct',
    requestIdHex: params.requestIdHex ?? `req-${params.sourceTokenId}`,
    recipientTokenJson: rewritten,
    tokenClass,
    ...(params.inheritedRequestIds !== undefined
      ? { inheritedRequestIds: params.inheritedRequestIds }
      : {}),
  };
  if (tokenClass === 'coin') {
    return {
      ...base,
      splitParentTokenId: params.splitParentTokenId ?? params.sourceTokenId,
    };
  }
  return base;
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

interface MockTransport extends TransportProvider {
  readonly _calls: Array<{ recipient: string; payload: unknown }>;
  _failNextSendWith: Error | null;
}

function makeTransportStub(): MockTransport {
  const calls: MockTransport['_calls'] = [];
  const stub: MockTransport = {
    _calls: calls,
    _failNextSendWith: null,
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
        if (stub._failNextSendWith) {
          const err = stub._failNextSendWith;
          stub._failNextSendWith = null;
          throw err;
        }
        calls.push({ recipient, payload });
        return 'event-id';
      }),
    onTokenTransfer: vi.fn().mockReturnValue(() => undefined),
  };
  return stub;
}

function makeIdentity(): FullIdentity {
  return {
    chainPubkey: '02aaaa'.padEnd(66, 'a'),
    l1Address: 'alpha1mock',
    directAddress: 'DIRECT://mock-direct',
    privateKey: '01'.repeat(32),
  };
}

function makePeerInfo(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    transportPubkey: '02bbbb'.padEnd(64, 'b'),
    chainPubkey: '02cccc'.padEnd(66, 'c'),
    l1Address: 'alpha1bob',
    directAddress: 'DIRECT://bob-direct',
    timestamp: 0,
    ...overrides,
  };
}

function defaultTokenLikeForTest(token: Token): TokenLike {
  // The fixture has coinData → coin class.
  return {
    id: token.id,
    coins: [{ coinId: token.coinId, amount: BigInt(token.amount) }],
  };
}

interface OutboxRecorder extends InstantOutboxHooks {
  readonly _records: Array<Omit<UxfTransferOutboxEntry, '_schemaVersion' | 'lamport'>>;
}

function makeOutboxRecorder(): OutboxRecorder {
  const records: Array<Omit<UxfTransferOutboxEntry, '_schemaVersion' | 'lamport'>> = [];
  return {
    _records: records,
    write: async (entry) => {
      records.push(entry);
    },
  };
}

function makeDeps(overrides: Partial<InstantSenderDeps> = {}): {
  readonly deps: InstantSenderDeps;
  readonly transport: MockTransport;
  readonly events: Array<{ type: SphereEventType; data: unknown }>;
  readonly outbox: OutboxRecorder;
} {
  const transport = makeTransportStub();
  const events: Array<{ type: SphereEventType; data: unknown }> = [];
  const outbox = makeOutboxRecorder();
  const emit = <T extends SphereEventType>(type: T, data: SphereEventMap[T]): void => {
    events.push({ type, data });
  };
  const deps: InstantSenderDeps = {
    aggregator: makeOracleStub(),
    transport,
    identity: makeIdentity(),
    addressId: 'addr-test-001',
    senderTransportPubkey: '02bbbb'.padEnd(64, 'b'),
    emit,
    availableSources: () => [],
    selectSources: async () => [],
    commitSources: async () => [],
    outbox,
    toTokenLike: defaultTokenLikeForTest,
    ...overrides,
  };
  return { deps, transport, events, outbox };
}

function basicRequest(overrides: Partial<TransferRequest> = {}): TransferRequest {
  return {
    recipient: '@bob',
    coinId: 'UCT',
    amount: '1000000',
    transferMode: 'instant',
    ...overrides,
  };
}

function statusesOf(records: ReadonlyArray<{ status: UxfOutboxStatus }>): UxfOutboxStatus[] {
  return records.map((r) => r.status);
}

// Wave 5 steelman fix #171 — `sourceLocks` is a module-level singleton. A
// hung/leaked lock from a prior test (e.g. an async dep that resolved on a
// later microtask than expected) would wedge a subsequent test that picks
// the same tokenId fixture. Reset before every case for hermetic isolation.
beforeEach(() => {
  __resetSourceLocksForTesting();
});

// =============================================================================
// 2. Happy path — 1-token instant send, default delivery (inline)
// =============================================================================

describe('sendInstantUxf — 1-token happy path', () => {
  it('emits transfer:submitted, NOT transfer:confirmed; outbox = packaging→sending→delivered-instant', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const commitResult = makeCommitResult({
      sourceTokenId: 'tok-1',
      fixture: TOKEN_A,
    });
    const { deps, transport, events, outbox } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async ({ sources }) => {
        expect(sources).toEqual([source]);
        return [commitResult];
      },
    });

    const result = await sendInstantUxf(basicRequest(), makePeerInfo(), deps);

    // Result: status='submitted' (NOT 'completed'). The orchestrator
    // ends the pipeline at submitted; T.5.B's worker will set
    // 'completed' once proofs land.
    expect(result.status).toBe('submitted');
    expect(result.tokens).toEqual([source]);
    expect(result.tokenTransfers).toHaveLength(1);
    expect(result.tokenTransfers[0]).toMatchObject({
      sourceTokenId: 'tok-1',
      method: 'direct',
      requestIdHex: 'req-tok-1',
      // C11: coin class → splitParent set, status='pending'.
      splitParent: { tokenId: 'tok-1', status: 'pending' },
    });

    // Transport: exactly one sendTokenTransfer with mode='instant'.
    expect(transport._calls).toHaveLength(1);
    const payload = transport._calls[0].payload as UxfTransferPayloadCar;
    expect(payload.mode).toBe('instant');
    expect(payload.kind).toBe('uxf-car');
    // Loop4-e2e (round 2) — payload.tokenIds is the recipient genesis
    // tokenId (extracted from recipientTokenJson.genesis.data.tokenId),
    // NOT the sender-side sourceTokenId.
    expect(payload.tokenIds).toEqual([
      'aa00000000000000000000000000000000000000000000000000000000000001',
    ]);

    // Event: transfer:submitted (NOT transfer:confirmed).
    const submitted = events.filter((e) => e.type === 'transfer:submitted');
    const confirmed = events.filter((e) => e.type === 'transfer:confirmed');
    expect(submitted).toHaveLength(1);
    expect(confirmed).toHaveLength(0);

    // Outbox status timeline: packaging → sending → delivered-instant.
    expect(statusesOf(outbox._records)).toEqual([
      'packaging',
      'sending',
      'delivered-instant',
    ]);
    // Final entry's outstandingRequestIds includes the new commitment.
    const final = outbox._records[outbox._records.length - 1];
    expect(final.outstandingRequestIds).toEqual(['req-tok-1']);
    expect(final.completedRequestIds).toEqual([]);
    expect(final.mode).toBe('instant');
    expect(final.deliveryMethod).toBe('car-over-nostr');
  });

  it('marks selected sources via markSourcePending hook', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const commitResult = makeCommitResult({
      sourceTokenId: 'tok-1',
      fixture: TOKEN_A,
    });
    const markedTokens: Token[] = [];
    const { deps } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commitResult],
      markSourcePending: async (tok) => {
        markedTokens.push(tok);
      },
    });

    await sendInstantUxf(basicRequest(), makePeerInfo(), deps);
    expect(markedTokens).toEqual([source]);
  });
});

// =============================================================================
// 3. Chain mode — K=3 inherited unfinalized requestIds
// =============================================================================

describe('sendInstantUxf — chain mode (allowPendingTokens=true) K=3', () => {
  it('persists outstandingRequestIds = new + K-1 inherited (deduped, sorted)', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const commitResult = makeCommitResult({
      sourceTokenId: 'tok-1',
      fixture: TOKEN_A,
      // K=3: 1 new + 2 inherited (the canonical K-1 framing per §2.3).
      inheritedRequestIds: ['req-pred-2', 'req-pred-1'],
    });
    const { deps, outbox } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commitResult],
    });

    await sendInstantUxf(
      basicRequest({ allowPendingTokens: true }),
      makePeerInfo(),
      deps,
    );

    const final = outbox._records[outbox._records.length - 1];
    expect(final.status).toBe('delivered-instant');
    // Total = K = 3 (new + 2 inherited). Lex-sorted.
    expect(final.outstandingRequestIds).toEqual([
      'req-pred-1',
      'req-pred-2',
      'req-tok-1',
    ]);
  });

  it('dedupes overlapping inherited requestIds across multiple sources', async () => {
    const sourceA = makeToken('tok-a', TOKEN_A);
    const sourceB = makeToken('tok-b', TOKEN_A);
    // Both sources share an inherited predecessor — the dedup logic
    // MUST collapse them.
    const commitA = makeCommitResult({
      sourceTokenId: 'tok-a',
      fixture: TOKEN_A,
      rewriteTokenId: 'aa'.padEnd(64, 'a'),
      requestIdHex: 'req-tok-a',
      inheritedRequestIds: ['req-shared-pred'],
    });
    const commitB = makeCommitResult({
      sourceTokenId: 'tok-b',
      fixture: TOKEN_A,
      rewriteTokenId: 'bb'.padEnd(64, 'b'),
      requestIdHex: 'req-tok-b',
      inheritedRequestIds: ['req-shared-pred'],
    });
    const { deps, outbox } = makeDeps({
      availableSources: () => [sourceA, sourceB],
      selectSources: async () => [sourceA, sourceB],
      commitSources: async () => [commitA, commitB],
    });

    await sendInstantUxf(
      basicRequest({ allowPendingTokens: true, amount: '2000000' }),
      makePeerInfo(),
      deps,
    );

    const final = outbox._records[outbox._records.length - 1];
    expect(final.outstandingRequestIds).toEqual([
      'req-shared-pred',
      'req-tok-a',
      'req-tok-b',
    ]);
  });
});

// =============================================================================
// 4. NFT instant — confirmNftPending=true, no splitParent
// =============================================================================

describe('sendInstantUxf — NFT instant, confirmNftPending=true', () => {
  it('NFT result has NO splitParent; tokenId preserved (whole-token transfer)', async () => {
    // NFT-class source: 64-char hex tokenId + empty coinData.
    const NFT_TOKEN_ID =
      'fa11000000000000000000000000000000000000000000000000000000000001';
    const NFT_FIXTURE: Record<string, unknown> = {
      ...TOKEN_A,
      genesis: {
        ...((TOKEN_A as { genesis: Record<string, unknown> }).genesis),
        data: {
          ...(
            (TOKEN_A as { genesis: { data: Record<string, unknown> } })
              .genesis.data
          ),
          tokenId: NFT_TOKEN_ID,
          coinData: [],
        },
      },
    };
    const nftSource = makeToken(NFT_TOKEN_ID, NFT_FIXTURE);
    const commitResult = makeCommitResult({
      sourceTokenId: NFT_TOKEN_ID,
      fixture: NFT_FIXTURE,
      tokenClass: 'nft',
    });

    // For NFT-only requests we still need a primary slot until T.2.B's
    // multi-asset selector lands. The NFT travels via additionalAssets.
    const { deps } = makeDeps({
      availableSources: () => [nftSource],
      selectSources: async () => [nftSource],
      commitSources: async () => [commitResult],
      // Custom toTokenLike so the validator sees NFT class for the source.
      toTokenLike: (t) =>
        t.id === NFT_TOKEN_ID
          ? { id: NFT_TOKEN_ID, coins: null, pending: false }
          : { id: t.id, coins: [{ coinId: t.coinId, amount: BigInt(t.amount) }] },
    });

    const request: TransferRequest = {
      recipient: '@bob',
      transferMode: 'instant',
      confirmNftPending: true,
      additionalAssets: [{ kind: 'nft', tokenId: NFT_TOKEN_ID }],
    };

    const result = await sendInstantUxf(request, makePeerInfo(), deps);
    expect(result.tokenTransfers).toHaveLength(1);
    const detail = result.tokenTransfers[0];
    expect(detail.sourceTokenId).toBe(NFT_TOKEN_ID);
    // C11: NFT direct transfers do NOT carry splitParent.
    expect(detail.splitParent).toBeUndefined();
  });
});

// =============================================================================
// 5. Coin instant — splitParent set on each child
// =============================================================================

describe('sendInstantUxf — coin instant carries splitParent', () => {
  it('every coin result has splitParent: { tokenId, status: "pending" }', async () => {
    const sources = ['tok-a', 'tok-b'].map((id) => makeToken(id, TOKEN_A));
    const commitResults = sources.map((s, i) =>
      makeCommitResult({
        sourceTokenId: s.id,
        fixture: TOKEN_A,
        rewriteTokenId: ('cc' + i.toString(16)).padEnd(64, 'c'),
      }),
    );
    const { deps } = makeDeps({
      availableSources: () => sources,
      selectSources: async () => sources,
      commitSources: async () => commitResults,
    });

    const result = await sendInstantUxf(
      basicRequest({ amount: '2000000' }),
      makePeerInfo(),
      deps,
    );
    for (const detail of result.tokenTransfers) {
      expect(detail.splitParent).toEqual({
        tokenId: detail.sourceTokenId,
        status: 'pending',
      });
    }
  });
});

// =============================================================================
// 6. Cascade-risk-warning — pending source coin → freshly-minted child
// =============================================================================

describe('sendInstantUxf — cascade-risk-warning fires for pending coin sources', () => {
  it('emits transfer:cascade-risk-warning when source is pending', async () => {
    const pendingSource = makeToken('pending-tok', TOKEN_A);
    const commitResult = makeCommitResult({
      sourceTokenId: 'pending-tok',
      fixture: TOKEN_A,
    });
    const { deps, events } = makeDeps({
      availableSources: () => [pendingSource],
      selectSources: async () => [pendingSource],
      commitSources: async () => [commitResult],
      // Override projection so the orchestrator sees pending=true.
      toTokenLike: (t) => ({
        id: t.id,
        coins: [{ coinId: t.coinId, amount: BigInt(t.amount) }],
        pending: true,
      }),
    });

    await sendInstantUxf(
      basicRequest({ allowPendingTokens: true }),
      makePeerInfo(),
      deps,
    );

    const warnings = events.filter(
      (e) => e.type === 'transfer:cascade-risk-warning',
    );
    expect(warnings).toHaveLength(1);
    const data = warnings[0].data as {
      transferId: string;
      bundleCid: string;
      pendingSourceTokenIds: string[];
      freshlyMintedChildTokenIds: string[];
    };
    expect(data.pendingSourceTokenIds).toContain('pending-tok');
    expect(data.freshlyMintedChildTokenIds).toContain('pending-tok');
    expect(data.bundleCid.length).toBeGreaterThan(0);
  });

  it('does NOT emit when sources are all finalized (pending=false)', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const commitResult = makeCommitResult({
      sourceTokenId: 'tok-1',
      fixture: TOKEN_A,
    });
    const { deps, events } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commitResult],
      // Default projection → pending omitted (= false).
    });
    await sendInstantUxf(basicRequest(), makePeerInfo(), deps);
    const warnings = events.filter(
      (e) => e.type === 'transfer:cascade-risk-warning',
    );
    expect(warnings).toHaveLength(0);
  });
});

// =============================================================================
// 7. Trigger callback — invoked AFTER delivered-instant
// =============================================================================

describe('sendInstantUxf — onTriggerFinalization callback', () => {
  it('invoked exactly once with addressId, outboxId, bundleCid, outstandingRequestIds', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const commitResult = makeCommitResult({
      sourceTokenId: 'tok-1',
      fixture: TOKEN_A,
    });
    const triggerCalls: Array<{
      addressId: string;
      outboxId: string;
      bundleCid: string;
      outstandingRequestIds: ReadonlyArray<string>;
    }> = [];
    const { deps, outbox } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commitResult],
      onTriggerFinalization: async (params) => {
        triggerCalls.push({
          addressId: params.addressId,
          outboxId: params.outboxId,
          bundleCid: params.bundleCid,
          outstandingRequestIds: [...params.outstandingRequestIds],
        });
      },
    });

    const result = await sendInstantUxf(basicRequest(), makePeerInfo(), deps);

    expect(triggerCalls).toHaveLength(1);
    expect(triggerCalls[0].addressId).toBe('addr-test-001');
    expect(triggerCalls[0].outboxId).toBe(result.id);
    expect(triggerCalls[0].outstandingRequestIds).toEqual(['req-tok-1']);
    // delivered-instant must already be persisted by the time the
    // trigger fires.
    const final = outbox._records[outbox._records.length - 1];
    expect(final.status).toBe('delivered-instant');
  });

  it('swallows trigger throws so the publish is not retracted', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const commitResult = makeCommitResult({
      sourceTokenId: 'tok-1',
      fixture: TOKEN_A,
    });
    const { deps } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commitResult],
      onTriggerFinalization: async () => {
        throw new Error('worker registry unavailable');
      },
    });

    // Should NOT throw — the throw is swallowed.
    const result = await sendInstantUxf(basicRequest(), makePeerInfo(), deps);
    expect(result.status).toBe('submitted');
  });
});

// =============================================================================
// 8. CID-bound delivery — outbox emits `pinned` transition
// =============================================================================

describe('sendInstantUxf — CID delivery emits pinned status', () => {
  it('outbox transitions packaging → pinned → sending → delivered-instant', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const commitResult = makeCommitResult({
      sourceTokenId: 'tok-1',
      fixture: TOKEN_A,
    });
    const publishToIpfs = vi.fn<PublishToIpfsCallback>().mockResolvedValue({
      cid: 'bafyfakemockcidv1example',
    });
    const { deps, transport, outbox } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commitResult],
      publishToIpfs,
    });

    await sendInstantUxf(
      basicRequest({ delivery: { kind: 'force-cid' } }),
      makePeerInfo(),
      deps,
    );

    expect(publishToIpfs).toHaveBeenCalledOnce();
    expect(transport._calls).toHaveLength(1);
    const payload = transport._calls[0].payload as UxfTransferPayloadCid;
    expect(payload.kind).toBe('uxf-cid');
    expect(payload.mode).toBe('instant');

    // Outbox: packaging → pinned → sending → delivered-instant.
    expect(statusesOf(outbox._records)).toEqual([
      'packaging',
      'pinned',
      'sending',
      'delivered-instant',
    ]);
    // deliveryMethod is updated to cid-over-nostr from the pinned step on.
    expect(outbox._records[1].deliveryMethod).toBe('cid-over-nostr');
    expect(outbox._records[outbox._records.length - 1].deliveryMethod).toBe(
      'cid-over-nostr',
    );
  });
});

// =============================================================================
// 9. C11 violations — orchestrator rejects malformed commit results
// =============================================================================

describe('sendInstantUxf — C11 splitParent invariant', () => {
  it('rejects coin commit result missing splitParentTokenId', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const broken: InstantCommitResult = {
      sourceTokenId: 'tok-1',
      method: 'direct',
      requestIdHex: 'req-tok-1',
      recipientTokenJson: TOKEN_A,
      tokenClass: 'coin',
      // splitParentTokenId omitted — C11 violation.
    };
    const { deps } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [broken],
    });

    let caught: unknown;
    try {
      await sendInstantUxf(basicRequest(), makePeerInfo(), deps);
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) {
      throw new Error(`expected SphereError; got ${String(caught)}`);
    }
    expect(caught.code).toBe('INVALID_CONFIG');
  });

  it('rejects NFT commit result that carries splitParentTokenId', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const broken: InstantCommitResult = {
      sourceTokenId: 'tok-1',
      method: 'direct',
      requestIdHex: 'req-tok-1',
      recipientTokenJson: TOKEN_A,
      tokenClass: 'nft',
      splitParentTokenId: 'tok-1', // C11 violation
    };
    const { deps } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [broken],
    });

    let caught: unknown;
    try {
      await sendInstantUxf(basicRequest(), makePeerInfo(), deps);
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) {
      throw new Error(`expected SphereError; got ${String(caught)}`);
    }
    expect(caught.code).toBe('INVALID_CONFIG');
  });
});

// =============================================================================
// 10. Transport rejection → TRANSPORT_ERROR + transfer:failed
// =============================================================================

describe('sendInstantUxf — transport rejection', () => {
  it('wraps transport throw in SphereError(TRANSPORT_ERROR) and emits transfer:failed', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const commitResult = makeCommitResult({
      sourceTokenId: 'tok-1',
      fixture: TOKEN_A,
    });
    const { deps, transport, events } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commitResult],
    });
    transport._failNextSendWith = new Error('relay rejected: too large');

    let caught: unknown;
    try {
      await sendInstantUxf(basicRequest(), makePeerInfo(), deps);
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) {
      throw new Error(`expected SphereError; got ${String(caught)}`);
    }
    expect(caught.code).toBe('TRANSPORT_ERROR');

    const failed = events.filter((e) => e.type === 'transfer:failed');
    expect(failed).toHaveLength(1);
  });

  // ===========================================================================
  // Wave 3 steelman fix #170 issue 1 — Option A: defer markSourcePending
  // until AFTER transport ack so a transport failure does NOT leave sources
  // stuck in `pending`.
  // ===========================================================================
  it('does NOT call markSourcePending when transport fails (#170 issue 1)', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const commitResult = makeCommitResult({
      sourceTokenId: 'tok-1',
      fixture: TOKEN_A,
    });
    const markedTokens: Token[] = [];
    const { deps, transport } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commitResult],
      markSourcePending: async (tok) => {
        markedTokens.push(tok);
      },
    });
    transport._failNextSendWith = new Error('relay rejected');

    let caught: unknown;
    try {
      await sendInstantUxf(basicRequest(), makePeerInfo(), deps);
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) {
      throw new Error(`expected SphereError; got ${String(caught)}`);
    }
    expect(caught.code).toBe('TRANSPORT_ERROR');
    // Pre-fix: markSourcePending fired BEFORE transport publish, so
    // `markedTokens` would have length 1 even after transport throw.
    // Post-fix (Option A): markSourcePending is DEFERRED until after
    // transport ack, so a failed publish leaves the source unmarked.
    expect(markedTokens).toHaveLength(0);
  });

  it('does call markSourcePending when transport succeeds (#170 issue 1 — happy path regression)', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const commitResult = makeCommitResult({
      sourceTokenId: 'tok-1',
      fixture: TOKEN_A,
    });
    const markedTokens: Token[] = [];
    const { deps } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commitResult],
      markSourcePending: async (tok) => {
        markedTokens.push(tok);
      },
    });

    const result = await sendInstantUxf(basicRequest(), makePeerInfo(), deps);
    expect(result.status).toBe('submitted');
    expect(markedTokens).toEqual([source]);
  });
});

// =============================================================================
// 11. Feature flag anchor — orchestrator is a free function
// =============================================================================

describe('sendInstantUxf — feature-flag dispatcher anchor', () => {
  it('the orchestrator is a free function; PaymentsModule guards via features.senderUxf', () => {
    expect(typeof sendInstantUxf).toBe('function');
  });
});

// =============================================================================
// 12. Wave 4 steelman fix #171 — per-source lock prevents same-process
//     double-spend window introduced by Wave 3's deferred-mark fix.
// =============================================================================

describe('sendInstantUxf — per-source lock (Wave 4 #171)', () => {
  it('two parallel sends with OVERLAPPING source tokenIds — second waits for first; no concurrent commit/publish/mark', async () => {
    // Single shared source tokenId — both sends pick it.
    const sharedSource = makeToken('tok-shared', TOKEN_A);

    // Track event ordering across both sends to assert serialization.
    const eventTimeline: Array<{ send: 'A' | 'B'; phase: string }> = [];

    // Latches for send A so we can pin its position in the pipeline
    // while send B attempts to acquire the lock.
    let releaseSendACommit: (() => void) | null = null;
    const sendACommitGate = new Promise<void>((resolve) => {
      releaseSendACommit = resolve;
    });

    function makeCommitFor(label: 'A' | 'B'): InstantCommitResult {
      return makeCommitResult({
        sourceTokenId: 'tok-shared',
        fixture: TOKEN_A,
        rewriteTokenId: ('aa' + label).padEnd(64, 'a'),
        requestIdHex: `req-${label}`,
      });
    }

    // Send A: hangs in commitSources until we let it through.
    const sendADeps = makeDeps({
      availableSources: () => [sharedSource],
      selectSources: async () => [sharedSource],
      commitSources: async () => {
        eventTimeline.push({ send: 'A', phase: 'commit-start' });
        await sendACommitGate;
        eventTimeline.push({ send: 'A', phase: 'commit-end' });
        return [makeCommitFor('A')];
      },
      markSourcePending: async () => {
        eventTimeline.push({ send: 'A', phase: 'mark-pending' });
      },
    });

    // Send B: would race A to the same source.
    const sendBDeps = makeDeps({
      availableSources: () => [sharedSource],
      selectSources: async () => {
        eventTimeline.push({ send: 'B', phase: 'select' });
        return [sharedSource];
      },
      commitSources: async () => {
        eventTimeline.push({ send: 'B', phase: 'commit-start' });
        return [makeCommitFor('B')];
      },
      markSourcePending: async () => {
        eventTimeline.push({ send: 'B', phase: 'mark-pending' });
      },
    });

    // Kick off A. It will reach commit-start and block.
    const sendAPromise = sendInstantUxf(basicRequest(), makePeerInfo(), sendADeps.deps);

    // Wait until A is provably inside its commit. (Microtask drain.)
    await new Promise((r) => setTimeout(r, 10));
    expect(eventTimeline.find((e) => e.send === 'A' && e.phase === 'commit-start')).toBeDefined();

    // Kick off B. It will block at lock acquisition because A holds it.
    const sendBPromise = sendInstantUxf(basicRequest(), makePeerInfo(), sendBDeps.deps);

    // Wait a tick — B should NOT have started its commit because the
    // lock is held by A.
    await new Promise((r) => setTimeout(r, 10));
    expect(
      eventTimeline.find((e) => e.send === 'B' && e.phase === 'commit-start'),
    ).toBeUndefined();

    // Now release A. It will commit, transport, mark, and release the
    // lock. B should then proceed.
    releaseSendACommit!();

    await Promise.all([sendAPromise, sendBPromise]);

    // Assert serial order: A's mark-pending precedes B's commit-start.
    const aMarkIdx = eventTimeline.findIndex(
      (e) => e.send === 'A' && e.phase === 'mark-pending',
    );
    const bCommitIdx = eventTimeline.findIndex(
      (e) => e.send === 'B' && e.phase === 'commit-start',
    );
    expect(aMarkIdx).toBeGreaterThanOrEqual(0);
    expect(bCommitIdx).toBeGreaterThanOrEqual(0);
    expect(aMarkIdx).toBeLessThan(bCommitIdx);

    // Both sends got distinct transport publishes (the orchestrator
    // does NOT veto B — that is the aggregator's job in production).
    // The point of the lock is SERIALIZATION, not rejection.
    expect(sendADeps.transport._calls).toHaveLength(1);
    expect(sendBDeps.transport._calls).toHaveLength(1);
  });

  it('two parallel sends with DISJOINT source tokenIds — both proceed concurrently (no serialization)', async () => {
    const sourceA = makeToken('tok-a', TOKEN_A);
    const sourceB = makeToken('tok-b', TOKEN_A);

    const eventTimeline: Array<{ send: 'A' | 'B'; phase: string }> = [];

    // Both sends hang at commit-start until BOTH have entered. If the
    // lock serialized them, only one would reach commit-start before
    // the other completed, and this Promise.all would deadlock.
    let resolveBothInCommit: (() => void) | null = null;
    const bothInCommit = new Promise<void>((resolve) => {
      resolveBothInCommit = resolve;
    });
    let countInCommit = 0;
    const enterCommit = (label: 'A' | 'B') => {
      eventTimeline.push({ send: label, phase: 'commit-start' });
      countInCommit++;
      if (countInCommit === 2 && resolveBothInCommit) {
        resolveBothInCommit();
      }
      return bothInCommit;
    };

    const sendADeps = makeDeps({
      availableSources: () => [sourceA],
      selectSources: async () => [sourceA],
      commitSources: async () => {
        await enterCommit('A');
        return [
          makeCommitResult({
            sourceTokenId: 'tok-a',
            fixture: TOKEN_A,
            rewriteTokenId: 'aa'.padEnd(64, 'a'),
            requestIdHex: 'req-a',
          }),
        ];
      },
    });

    const sendBDeps = makeDeps({
      availableSources: () => [sourceB],
      selectSources: async () => [sourceB],
      commitSources: async () => {
        await enterCommit('B');
        return [
          makeCommitResult({
            sourceTokenId: 'tok-b',
            fixture: TOKEN_A,
            rewriteTokenId: 'bb'.padEnd(64, 'b'),
            requestIdHex: 'req-b',
          }),
        ];
      },
    });

    // Both sends should reach commit concurrently — bothInCommit only
    // resolves when BOTH have entered.
    const [resA, resB] = await Promise.all([
      sendInstantUxf(basicRequest(), makePeerInfo(), sendADeps.deps),
      sendInstantUxf(basicRequest(), makePeerInfo(), sendBDeps.deps),
    ]);

    expect(resA.status).toBe('submitted');
    expect(resB.status).toBe('submitted');
    // Both reached commit-start phase (rendezvous succeeded → no
    // serialization).
    expect(
      eventTimeline.filter((e) => e.phase === 'commit-start'),
    ).toHaveLength(2);
  });

  it('transport throws → lock released, source NOT marked pending (preserves Wave 3 deferred-mark)', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const commitResult = makeCommitResult({
      sourceTokenId: 'tok-1',
      fixture: TOKEN_A,
    });
    const markedTokens: Token[] = [];
    const { deps: depsA, transport: transportA } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commitResult],
      markSourcePending: async (t) => {
        markedTokens.push(t);
      },
    });
    transportA._failNextSendWith = new Error('relay rejected');

    let caught: unknown;
    try {
      await sendInstantUxf(basicRequest(), makePeerInfo(), depsA);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    // Wave 3 deferred-mark contract: source was NOT marked pending.
    expect(markedTokens).toHaveLength(0);

    // Wave 4 invariant: lock was released (else next send would block
    // forever). Verify by running a fresh send on the same source.
    const { deps: depsB, transport: transportB } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commitResult],
    });
    const result = await sendInstantUxf(basicRequest(), makePeerInfo(), depsB);
    expect(result.status).toBe('submitted');
    expect(transportB._calls).toHaveLength(1);
  });

  it('successful send → lock released after markSourcePending; subsequent send on same source proceeds', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const commitResult = makeCommitResult({
      sourceTokenId: 'tok-1',
      fixture: TOKEN_A,
    });
    let markCalledAt = 0;
    const { deps: depsA } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commitResult],
      markSourcePending: async () => {
        markCalledAt = Date.now();
      },
    });

    const r1 = await sendInstantUxf(basicRequest(), makePeerInfo(), depsA);
    expect(r1.status).toBe('submitted');
    expect(markCalledAt).toBeGreaterThan(0);

    // Second send on the SAME source — would deadlock if lock leaked.
    const { deps: depsB, transport: transportB } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commitResult],
    });
    const r2 = await sendInstantUxf(basicRequest(), makePeerInfo(), depsB);
    expect(r2.status).toBe('submitted');
    expect(transportB._calls).toHaveLength(1);
  });

  it('lock held >timeout → emits warning + auto-releases (force-release path)', async () => {
    const source = makeToken('tok-stuck', TOKEN_A);
    const commitResult = makeCommitResult({
      sourceTokenId: 'tok-stuck',
      fixture: TOKEN_A,
    });

    // Capture console.warn output to assert on the warning.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // Send A: hangs forever in commitSources. The lock timeout (50ms in
    // this test) should force-release.
    let releaseA: (() => void) | null = null;
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const { deps: depsA } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => {
        await aGate;
        return [commitResult];
      },
      __sourceLockMaxHoldMs: 50,
    });

    // Don't await — just kick off and let it hang.
    const aPromise = sendInstantUxf(basicRequest(), makePeerInfo(), depsA);

    // Wait long enough for the timeout to fire (50ms + grace).
    await new Promise((r) => setTimeout(r, 120));

    // The force-release warning should have been emitted.
    expect(warnSpy).toHaveBeenCalled();
    const warnCall = warnSpy.mock.calls.find((c) =>
      String(c[0]).includes('source lock for tokenId=tok-stuck'),
    );
    expect(warnCall).toBeDefined();

    // Now a second send on the SAME source should proceed (lock was
    // force-released).
    const { deps: depsB, transport: transportB } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commitResult],
      __sourceLockMaxHoldMs: 50,
    });
    const r2 = await sendInstantUxf(basicRequest(), makePeerInfo(), depsB);
    expect(r2.status).toBe('submitted');
    expect(transportB._calls).toHaveLength(1);

    // Clean up A. (Its outer Promise is still alive; release the gate
    // so it completes its own pipeline. We don't care about the result —
    // the test asserts on the lock's behavior, not A's outcome.)
    releaseA!();
    try {
      await aPromise;
    } catch {
      // Don't care — A may or may not throw depending on whether its
      // commit completes after the force-release. Both are acceptable
      // for this test's assertions.
    }

    warnSpy.mockRestore();
  });
});

// =============================================================================
// 13. Wave 5 steelman fix #171 — __resetSourceLocksForTesting hermetic reset
// =============================================================================

describe('__resetSourceLocksForTesting — Wave 5 steelman fix #171', () => {
  it('clears any in-flight locks so a subsequent send on the same tokenId proceeds without waiting', async () => {
    // Send A holds the lock indefinitely (commitSources never resolves).
    // Without the reset hook, send B would wait for the 60s force-release
    // timer or wedge the test. With the reset hook, the lock is cleared
    // immediately and B proceeds on the next acquire.
    const sharedSource = makeToken('tok-reset-shared', TOKEN_A);
    const commitResult = makeCommitResult({
      sourceTokenId: 'tok-reset-shared',
      fixture: TOKEN_A,
    });

    let neverResolve: (() => void) | null = null;
    const hangGate = new Promise<void>((resolve) => {
      neverResolve = resolve;
    });
    const { deps: depsA } = makeDeps({
      availableSources: () => [sharedSource],
      selectSources: async () => [sharedSource],
      commitSources: async () => {
        await hangGate;
        return [commitResult];
      },
    });
    // Kick off send A — it acquires the lock and hangs in commitSources.
    const aPromise = sendInstantUxf(basicRequest(), makePeerInfo(), depsA);

    // Yield once so A reaches the point where it holds the lock.
    await new Promise((r) => setTimeout(r, 5));

    // Force-clear the lock map. Send B should now proceed without waiting.
    __resetSourceLocksForTesting();

    const { deps: depsB, transport: transportB } = makeDeps({
      availableSources: () => [sharedSource],
      selectSources: async () => [sharedSource],
      commitSources: async () => [commitResult],
    });
    const start = Date.now();
    const r2 = await sendInstantUxf(basicRequest(), makePeerInfo(), depsB);
    const elapsed = Date.now() - start;

    expect(r2.status).toBe('submitted');
    expect(transportB._calls).toHaveLength(1);
    // B completed promptly — no 60s wait on A's lock.
    expect(elapsed).toBeLessThan(1_000);

    // Clean up A.
    neverResolve!();
    try {
      await aPromise;
    } catch {
      // Don't care — A's pipeline may complete or error; the test asserts
      // only on B's prompt completion.
    }
  });
});

// =============================================================================
// 14. Wave 7 steelman fix — __resetSourceLocksForTesting fail-closed guard
// =============================================================================
//
// Wave 5 exported the function as advisory-only ("MUST NOT" in JSDoc). A
// production consumer using `import * as instantSender` could still call it
// at runtime, clearing locks mid-flight and re-opening the same-process
// double-spend window.
//
// Wave 6 added a runtime guard that fired only when NODE_ENV === 'production'.
// In browser bundles where `process` is stripped, `typeof process ===
// 'undefined'` evaluated false-y for the guard's outer condition and the
// reset proceeded — the exact attack the function exists to prevent.
//
// Wave 7 inverts the polarity: FAIL-CLOSED. Reset is forbidden by default
// everywhere and only succeeds when the runtime is provably a test
// environment (NODE_ENV === 'test', or SPHERE_ALLOW_TEST_RESET === '1' as
// an explicit opt-in for prod-flag test harnesses).

describe('__resetSourceLocksForTesting — Wave 7 fail-closed guard', () => {
  // Save and restore the env across each test so we don't leak into
  // subsequent suites.
  const savedNodeEnv = process.env.NODE_ENV;
  const savedAllowReset = process.env.SPHERE_ALLOW_TEST_RESET;

  afterEach(() => {
    if (savedNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = savedNodeEnv;
    }
    if (savedAllowReset === undefined) {
      delete process.env.SPHERE_ALLOW_TEST_RESET;
    } else {
      process.env.SPHERE_ALLOW_TEST_RESET = savedAllowReset;
    }
  });

  it('succeeds when NODE_ENV === "test" (default vitest env)', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.SPHERE_ALLOW_TEST_RESET;
    expect(() => __resetSourceLocksForTesting()).not.toThrow();
  });

  it('throws when NODE_ENV === "production" (no opt-in)', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.SPHERE_ALLOW_TEST_RESET;
    expect(() => __resetSourceLocksForTesting()).toThrow(
      /only available in test environments/,
    );
  });

  it('throws when NODE_ENV is undefined (fail-closed)', () => {
    delete process.env.NODE_ENV;
    delete process.env.SPHERE_ALLOW_TEST_RESET;
    expect(() => __resetSourceLocksForTesting()).toThrow(
      /only available in test environments/,
    );
  });

  it('throws when NODE_ENV === "development" (fail-closed)', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.SPHERE_ALLOW_TEST_RESET;
    expect(() => __resetSourceLocksForTesting()).toThrow(
      /only available in test environments/,
    );
  });

  it('succeeds when SPHERE_ALLOW_TEST_RESET === "1" regardless of NODE_ENV (escape hatch)', () => {
    process.env.NODE_ENV = 'production';
    process.env.SPHERE_ALLOW_TEST_RESET = '1';
    expect(() => __resetSourceLocksForTesting()).not.toThrow();

    delete process.env.NODE_ENV;
    process.env.SPHERE_ALLOW_TEST_RESET = '1';
    expect(() => __resetSourceLocksForTesting()).not.toThrow();

    process.env.NODE_ENV = 'development';
    process.env.SPHERE_ALLOW_TEST_RESET = '1';
    expect(() => __resetSourceLocksForTesting()).not.toThrow();
  });
});

// =============================================================================
// #142 — InstantSourceSelection forwarding (split intent)
// =============================================================================
//
// FIX 1 widened `InstantSelectSourcesFn` to return either the legacy array
// shape or the new structured `InstantSourceSelection`. The orchestrator
// normalizes both shapes and forwards `splitSource` to `commitSources`.
// These tests lock down the normalization + forwarding contract so the
// production wiring in dispatchUxfInstantSend (FIX 2) can depend on it.

describe('sendInstantUxf — splitSources forwarding (#142 FIX 1 / #149 multi-asset)', () => {
  it('forwards a single splitSources entry from selectSources to commitSources', async () => {
    const splitSourceTok = makeToken('split-tok', TOKEN_A, {
      amount: '1000000',
    });
    const commitResult = makeCommitResult({
      sourceTokenId: 'split-tok',
      fixture: TOKEN_A,
    });
    let observedSplitSources: unknown = 'NOT_CALLED';
    const { deps } = makeDeps({
      availableSources: () => [splitSourceTok],
      selectSources: async () => ({
        directSources: [],
        splitSources: [
          {
            token: splitSourceTok,
            splitAmount: 300_000n,
            remainderAmount: 700_000n,
            coinIdHex: 'UCT',
          },
        ],
      }),
      commitSources: async ({ splitSources }) => {
        observedSplitSources = splitSources;
        return [commitResult];
      },
    });

    // Make the request budget cover the slice (300_000) so the guard
    // doesn't fire (TOKEN_A's recipient fixture has coinData 1_000_000 —
    // for this contract test we set the budget high to focus on the
    // forwarding invariant alone).
    await sendInstantUxf(
      basicRequest({ amount: '1000000' }),
      makePeerInfo(),
      deps,
    );

    expect(observedSplitSources).toEqual([
      {
        token: splitSourceTok,
        splitAmount: 300_000n,
        remainderAmount: 700_000n,
        coinIdHex: 'UCT',
      },
    ]);
  });

  it('legacy array-shape selectSources still works (empty splitSources)', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const commitResult = makeCommitResult({
      sourceTokenId: 'tok-1',
      fixture: TOKEN_A,
    });
    let observedSplitSources: unknown = 'NOT_CALLED';
    const { deps } = makeDeps({
      availableSources: () => [source],
      // LEGACY return shape — flat array. No splitSources entries.
      selectSources: async () => [source],
      commitSources: async ({ splitSources }) => {
        observedSplitSources = splitSources;
        return [commitResult];
      },
    });

    await sendInstantUxf(
      basicRequest({ amount: '1000000' }),
      makePeerInfo(),
      deps,
    );

    // Orchestrator normalizes legacy array form to splitSources: [].
    expect(observedSplitSources).toEqual([]);
  });
});

// =============================================================================
// #142 — OVER_TRANSFER_GUARD post-commit assertion
// =============================================================================
//
// The guard runs AFTER commitSources returns. It walks the recipient token
// JSONs and sums the per-coin `genesis.data.coinData` amounts; rejects if any
// coin's shipped sum exceeds the request's per-coin total. This block locks
// down the over-send invariant — the exact failure mode from issue #142
// where a partial-amount send silently shipped the entire source token.

describe('sendInstantUxf — OVER_TRANSFER_GUARD (#142)', () => {
  it('rejects when whole-token coinData exceeds request amount', async () => {
    // TOKEN_A's coinData is [['UCT', '1000000']]. If the request asks for
    // only 500000 UCT but the commitSources callback whole-token-transfers
    // the source, the recipient receives 1000000 — the silent over-send
    // bug. The guard must throw OVER_TRANSFER_GUARD.
    const source = makeToken('tok-1', TOKEN_A);
    const overSendResult = makeCommitResult({
      sourceTokenId: 'tok-1',
      fixture: TOKEN_A, // recipientTokenJson.genesis.data.coinData = [['UCT', '1000000']]
    });
    const { deps, transport } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [overSendResult],
    });

    let caught: unknown;
    try {
      await sendInstantUxf(
        basicRequest({ amount: '500000' }),
        makePeerInfo(),
        deps,
      );
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) {
      throw new Error(`expected SphereError; got ${String(caught)}`);
    }
    expect(caught.code).toBe('OVER_TRANSFER_GUARD');
    // CRITICAL — the guard fires BEFORE transport publish. Bob must
    // never see the over-send.
    expect(transport._calls).toEqual([]);
  });

  it('passes when shipped coin amount equals request amount', async () => {
    // Whole-token request of the full 1000000 — coinData equals request,
    // no over-send. Bundle must ship.
    const source = makeToken('tok-1', TOKEN_A);
    const wholeResult = makeCommitResult({
      sourceTokenId: 'tok-1',
      fixture: TOKEN_A,
    });
    const { deps, transport } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [wholeResult],
    });

    await sendInstantUxf(
      basicRequest({ amount: '1000000' }),
      makePeerInfo(),
      deps,
    );

    expect(transport._calls).toHaveLength(1);
  });

  it('skips NFT commit results (no fungible amount counted)', async () => {
    // NFT-class result has no coinData → guard MUST NOT compare against
    // the request's primary coin budget for it. A mixed coin + NFT
    // send with the coin amount exactly matching the budget should pass
    // even though the NFT entry exists alongside.
    const NFT_TOKEN_ID =
      'fa11000000000000000000000000000000000000000000000000000000000001';
    const NFT_FIXTURE: Record<string, unknown> = {
      ...TOKEN_A,
      genesis: {
        ...((TOKEN_A as { genesis: Record<string, unknown> }).genesis),
        data: {
          ...(
            (TOKEN_A as { genesis: { data: Record<string, unknown> } })
              .genesis.data
          ),
          tokenId: NFT_TOKEN_ID,
          coinData: [],
        },
      },
    };
    const coinSource = makeToken('tok-1', TOKEN_A);
    const nftSource = makeToken(NFT_TOKEN_ID, NFT_FIXTURE);
    const coinResult = makeCommitResult({
      sourceTokenId: 'tok-1',
      fixture: TOKEN_A,
    });
    const nftResult = makeCommitResult({
      sourceTokenId: NFT_TOKEN_ID,
      fixture: NFT_FIXTURE,
      tokenClass: 'nft',
    });
    const { deps, transport } = makeDeps({
      availableSources: () => [coinSource, nftSource],
      selectSources: async () => [coinSource, nftSource],
      commitSources: async () => [coinResult, nftResult],
      // Treat the NFT source as NFT-class for the validator path.
      toTokenLike: (t) =>
        t.id === NFT_TOKEN_ID
          ? { id: t.id, coins: null }
          : { id: t.id, coins: [{ coinId: t.coinId, amount: BigInt(t.amount) }] },
    });

    // Coin budget exactly matches the coin entry; NFT entry must not
    // trip the guard.
    await sendInstantUxf(
      basicRequest({ amount: '1000000' }),
      makePeerInfo(),
      deps,
    );
    expect(transport._calls).toHaveLength(1);
  });
});

// =============================================================================
// L5-C1/C2 — tokenIds extraction fail-closed semantics
// =============================================================================
//
// The orchestrator extracts `recipientTokenJson.genesis.data.tokenId`
// for the wire `payload.tokenIds` advertisement (Loop4 r2). Previously
// a missing/non-string/non-hex tokenId silently fell back to
// `sourceTokenId` — which IS the alice-local UI id, NOT the
// recipient-visible tokenId. The fallback reintroduced the silent
// mis-routing bug Loop4-r2 was designed to fix. L5-C1/C2 hardening:
// throw SphereError instead, AND lowercase-normalize valid values.

describe('sendInstantUxf — tokenIds extraction fail-closed (L5-C1/C2)', () => {
  it('throws INVALID_CONFIG when recipientTokenJson.genesis.data.tokenId is missing', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    // Construct a commit result with NO tokenId in the genesis.
    const broken: InstantCommitResult = {
      sourceTokenId: 'tok-1',
      method: 'direct',
      requestIdHex: 'req-tok-1',
      // Recipient JSON without genesis.data.tokenId.
      recipientTokenJson: {
        version: '2.0',
        genesis: { data: {} /* tokenId missing */, inclusionProof: {} },
        state: {},
        transactions: [],
        nametags: [],
      },
      tokenClass: 'coin',
      splitParentTokenId: 'tok-1',
    };
    const { deps, transport } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [broken],
    });

    let caught: unknown;
    try {
      await sendInstantUxf(basicRequest(), makePeerInfo(), deps);
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('INVALID_CONFIG');
    expect(caught.message).toContain('genesis.data.tokenId');
    // No transport publish on throw — bundle never shipped.
    expect(transport._calls).toEqual([]);
  });

  it('throws INVALID_CONFIG when tokenId is not 64-char hex (too short)', async () => {
    const source = makeToken('tok-1', TOKEN_A);
    const broken: InstantCommitResult = {
      sourceTokenId: 'tok-1',
      method: 'direct',
      requestIdHex: 'req-tok-1',
      recipientTokenJson: {
        version: '2.0',
        genesis: { data: { tokenId: 'aabb' /* 4 chars, not 64 */ }, inclusionProof: {} },
        state: {},
        transactions: [],
        nametags: [],
      },
      tokenClass: 'coin',
      splitParentTokenId: 'tok-1',
    };
    const { deps } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [broken],
    });

    let caught: unknown;
    try {
      await sendInstantUxf(basicRequest(), makePeerInfo(), deps);
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('INVALID_CONFIG');
  });

  it('lowercase-normalizes uppercase hex tokenId in payload.tokenIds', async () => {
    // Recipient deconstruct pool elements are lowercase. If the
    // sender shipped uppercase, the case-sensitive Set lookup would
    // miss → all roots advisory → recipient drops bundle.
    //
    // Use makeCommitResult with rewriteTokenId so the TOKEN_A
    // fixture's valid genesis shape is preserved; only the tokenId
    // field is rewritten to uppercase. This way pkg.ingestAll can
    // still deconstruct the bundle while my L5-C2 normalization
    // is exercised on the outgoing payload.tokenIds.
    const uppercaseTokenId = 'AA' + '00'.repeat(31); // 64-char, uppercase first 2 chars
    const source = makeToken('tok-1', TOKEN_A);
    const result = makeCommitResult({
      sourceTokenId: 'tok-1',
      fixture: TOKEN_A,
      rewriteTokenId: uppercaseTokenId,
    });
    const { deps, transport } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [result],
    });
    await sendInstantUxf(basicRequest({ amount: '1000000' }), makePeerInfo(), deps);

    expect(transport._calls).toHaveLength(1);
    const payload = transport._calls[0].payload as UxfTransferPayloadCar;
    expect(payload.tokenIds).toEqual([uppercaseTokenId.toLowerCase()]);
  });
});
