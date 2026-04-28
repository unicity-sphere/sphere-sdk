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

import { describe, expect, it, vi } from 'vitest';

import {
  sendInstantUxf,
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
    expect(payload.tokenIds).toEqual(['tok-1']);

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
});

// =============================================================================
// 11. Feature flag anchor — orchestrator is a free function
// =============================================================================

describe('sendInstantUxf — feature-flag dispatcher anchor', () => {
  it('the orchestrator is a free function; PaymentsModule guards via features.senderUxf', () => {
    expect(typeof sendInstantUxf).toBe('function');
  });
});
