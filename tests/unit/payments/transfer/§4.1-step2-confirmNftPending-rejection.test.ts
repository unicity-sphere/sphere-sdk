/**
 * §4.1 step 2 — `confirmNftPending` rejection at T.5.A entry (W11 D-i-D).
 *
 * Replicates the §4.1 step 2 acceptance row "pending NFT source +
 * confirmNftPending=false → reject" at the T.5.A boundary. The
 * primary line of defense is {@link validateTargets} (T.2.B); T.5.A's
 * orchestrator runs the same validator at its entry point so any
 * caller bypassing the public {@link
 * import('../../../../modules/payments/PaymentsModule').PaymentsModule.send}
 * dispatcher (e.g., a unit-test that wires the orchestrator directly,
 * or a future arm that invokes `sendInstantUxf` from outside
 * PaymentsModule) still gets the rejection.
 *
 * This is a defense-in-depth test — the validator itself is exercised
 * exhaustively in `§4.1-step2-confirmNftPending.test.ts` (T.2.B).
 *
 * Acceptance per impl-plan §T.5.A:
 *  - confirmNftPending: undefined (default) + pending NFT source →
 *    NFT_PENDING_REQUIRES_CONFIRMATION.
 *  - confirmNftPending: false           + pending NFT source →
 *    NFT_PENDING_REQUIRES_CONFIRMATION.
 *  - confirmNftPending: true            + pending NFT source → ACCEPT.
 *  - confirmNftPending: undefined + non-pending NFT source → ACCEPT.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  sendInstantUxf,
  type InstantCommitResult,
  type InstantSenderDeps,
} from '../../../../extensions/uxf/pipeline/instant-sender';
import type { TokenLike } from '../../../../extensions/uxf/pipeline/classify-token';
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
import { TOKEN_A } from '../../../fixtures/uxf-mock-tokens';

// =============================================================================
// Shared fixtures (minimal — the full helper set is in instant-sender.test.ts)
// =============================================================================

// 64-char lowercase hex (UxfPackage.ingest accepts only this form).
const PENDING_NFT_TOKEN_ID =
  'fa11ed00000000000000000000000000000000000000000000000000aabbccdd';

const NFT_FIXTURE: Record<string, unknown> = {
  ...TOKEN_A,
  genesis: {
    ...((TOKEN_A as { genesis: Record<string, unknown> }).genesis),
    data: {
      ...(
        (TOKEN_A as { genesis: { data: Record<string, unknown> } }).genesis.data
      ),
      tokenId: PENDING_NFT_TOKEN_ID,
      coinData: [],
    },
  },
};

function makeNftToken(id: string, status: Token['status'] = 'submitted'): Token {
  return {
    id,
    coinId: '',
    symbol: 'NFT',
    name: 'Test NFT',
    decimals: 0,
    amount: '0',
    status,
    createdAt: 0,
    updatedAt: 0,
    sdkData: JSON.stringify(NFT_FIXTURE),
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

function makeTransportStub(): TransportProvider {
  return {
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
    sendTokenTransfer: vi.fn().mockResolvedValue('event-id'),
    onTokenTransfer: vi.fn().mockReturnValue(() => undefined),
  };
}

function makeIdentity(): FullIdentity {
  return {
    chainPubkey: '02aaaa'.padEnd(66, 'a'),
    directAddress: 'DIRECT://mock-direct',
    privateKey: '01'.repeat(32),
  };
}

function makePeerInfo(): PeerInfo {
  return {
    transportPubkey: '02bbbb'.padEnd(64, 'b'),
    chainPubkey: '02cccc'.padEnd(66, 'c'),
    directAddress: 'DIRECT://bob-direct',
    timestamp: 0,
  };
}

// Project NFT tokens with explicit `pending` flag so the validator
// sees the §4.1-step-2 condition.
function nftTokenLike(pending: boolean): (t: Token) => TokenLike {
  return (t: Token): TokenLike => ({
    id: t.id,
    coins: null,
    pending,
  });
}

function makeDeps(overrides: {
  readonly availableSources: ReadonlyArray<Token>;
  readonly toTokenLike: (t: Token) => TokenLike;
  readonly commitResult?: InstantCommitResult;
}): InstantSenderDeps {
  const events: Array<{ type: SphereEventType; data: unknown }> = [];
  const emit = <T extends SphereEventType>(type: T, data: SphereEventMap[T]): void => {
    events.push({ type, data });
  };
  return {
    aggregator: makeOracleStub(),
    transport: makeTransportStub(),
    identity: makeIdentity(),
    addressId: 'addr-test-w11',
    senderTransportPubkey: '02bbbb'.padEnd(64, 'b'),
    emit,
    availableSources: () => overrides.availableSources,
    selectSources: async () => [...overrides.availableSources],
    commitSources: async () => {
      // For ACCEPTING tests, return a synthetic NFT commit result.
      return overrides.commitResult ? [overrides.commitResult] : [];
    },
    toTokenLike: overrides.toTokenLike,
  };
}

function makeNftRequest(overrides: Partial<TransferRequest> = {}): TransferRequest {
  return {
    recipient: '@bob',
    transferMode: 'instant',
    additionalAssets: [{ kind: 'nft', tokenId: PENDING_NFT_TOKEN_ID }],
    ...overrides,
  };
}

function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  return promise.then(
    () => {
      throw new Error(`expected SphereError(${code}); promise resolved`);
    },
    (err) => {
      if (!isSphereError(err)) {
        throw new Error(`expected SphereError; got ${String(err)}`);
      }
      expect(err.code).toBe(code);
    },
  );
}

// =============================================================================
// W11 — §4.1 step 2 acceptance row replicated at T.5.A
// =============================================================================

describe('§4.1 step 2 — confirmNftPending rejection at T.5.A entry (W11 D-i-D)', () => {
  it('rejects pending NFT source when confirmNftPending is undefined (default)', async () => {
    const nft = makeNftToken(PENDING_NFT_TOKEN_ID);
    const deps = makeDeps({
      availableSources: [nft],
      toTokenLike: nftTokenLike(true),
    });
    await expectCode(
      sendInstantUxf(makeNftRequest(), makePeerInfo(), deps),
      'NFT_PENDING_REQUIRES_CONFIRMATION',
    );
  });

  it('rejects pending NFT source when confirmNftPending is explicitly false', async () => {
    const nft = makeNftToken(PENDING_NFT_TOKEN_ID);
    const deps = makeDeps({
      availableSources: [nft],
      toTokenLike: nftTokenLike(true),
    });
    await expectCode(
      sendInstantUxf(
        makeNftRequest({ confirmNftPending: false }),
        makePeerInfo(),
        deps,
      ),
      'NFT_PENDING_REQUIRES_CONFIRMATION',
    );
  });

  it('PERMITS pending NFT source when confirmNftPending is true', async () => {
    const nft = makeNftToken(PENDING_NFT_TOKEN_ID);
    const commitResult: InstantCommitResult = {
      sourceTokenId: PENDING_NFT_TOKEN_ID,
      method: 'direct',
      requestIdHex: 'req-nft-001',
      recipientTokenJson: NFT_FIXTURE,
      tokenClass: 'nft',
      // C11: NO splitParentTokenId for NFT.
    };
    const deps = makeDeps({
      availableSources: [nft],
      toTokenLike: nftTokenLike(true),
      commitResult,
    });
    const result = await sendInstantUxf(
      makeNftRequest({ confirmNftPending: true }),
      makePeerInfo(),
      deps,
    );
    expect(result.status).toBe('submitted');
    expect(result.tokenTransfers).toHaveLength(1);
    // C11: NFT direct transfers preserve tokenId — no splitParent.
    expect(result.tokenTransfers[0].splitParent).toBeUndefined();
  });

  it('PERMITS non-pending NFT source regardless of confirmNftPending', async () => {
    const nft = makeNftToken(PENDING_NFT_TOKEN_ID, 'confirmed');
    const commitResult: InstantCommitResult = {
      sourceTokenId: PENDING_NFT_TOKEN_ID,
      method: 'direct',
      requestIdHex: 'req-nft-001',
      recipientTokenJson: NFT_FIXTURE,
      tokenClass: 'nft',
    };
    const deps = makeDeps({
      availableSources: [nft],
      toTokenLike: nftTokenLike(false),
      commitResult,
    });
    const result = await sendInstantUxf(
      makeNftRequest(),
      makePeerInfo(),
      deps,
    );
    expect(result.status).toBe('submitted');
  });
});
