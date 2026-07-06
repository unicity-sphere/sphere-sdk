/**
 * Issue #197 integration — `finalizeSourceTokenChain` end-to-end with
 * real SDK-built transfer-transaction JSON.
 *
 * The unit-tier coverage (tests/unit/payments/transfer/conservative-source-finalize.test.ts)
 * exercises the pure helpers (extract / apply / no-op orchestration).
 * This file pins the SDK-bound derivation path — `derivePendingTxDescriptor`
 * uses `TransferTransactionData.fromJSON` + `PredicateEngineService.createPredicate`
 * + `RequestId.create`, all of which require real SDK objects.
 *
 * Scenario under test:
 *   1. Build a Token whose `sdkData.transactions[i]` is a real SDK
 *      transferTxJson with `inclusionProof: null` (mirrors the
 *      "confirmed token with proofless intermediate" shape that wedges
 *      the recipient — see Issue #197 root cause analysis).
 *   2. Mock the aggregator's `getProof(requestId)` to serve back a
 *      valid InclusionProof envelope with `transactionHash` matching
 *      the canonical SDK-imprint hex.
 *   3. Call `finalizeSourceTokenChain(token, aggregator)`.
 *   4. Assert the returned Token is a NEW reference whose sdkData has
 *      the proof attached at the right index, `updatedAt` advanced.
 *
 * This is the "happy aggregator returns the proof" path. A separate
 * scenario covers the no-proof-available case (preflight raises hard-fail).
 *
 * NOTE: this test does NOT spin up real network infrastructure — the
 * aggregator is a vitest mock. It validates the in-process glue
 * between `finalizeSourceTokenChain` and the SDK shape; the live
 * happy-path coverage (sender → recipient via real Nostr/aggregator)
 * lives in `tests/e2e/uxf-send-receive.test.ts`.
 */

import { describe, it, expect, vi } from 'vitest';

import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm';
import { RequestId } from '@unicitylabs/state-transition-sdk/lib/api/RequestId';
import { SigningService } from '@unicitylabs/state-transition-sdk/lib/sign/SigningService';
import { TokenId } from '@unicitylabs/state-transition-sdk/lib/token/TokenId';
import { TokenState } from '@unicitylabs/state-transition-sdk/lib/token/TokenState';
import { TokenType } from '@unicitylabs/state-transition-sdk/lib/token/TokenType';
import { TransferTransactionData } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferTransactionData';
import { UnmaskedPredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate';

import { finalizeSourceTokenChain } from '../../../extensions/uxf/pipeline/conservative-source-finalize';
import type { InclusionProof, OracleProvider } from '../../../oracle/oracle-provider';
import type { Token } from '../../../types';

// =============================================================================
// 1. Fixture — build a real SDK transferTxJson + canonical requestId/txHash
// =============================================================================

/**
 * Build a real `transferTxJson` with `inclusionProof: null`. Mirrors the
 * shape `PaymentsModule` produces when synthesizing pending transitions
 * (e.g. the augmented source at line ~6237) and what `assembleTransaction`
 * yields when the underlying tx has no proof yet.
 *
 * Returns canonical values so the test can byte-compare them against
 * what `derivePendingTxDescriptor` produces.
 */
async function buildRealTransferTxJson(): Promise<{
  transferTxJson: { data: Record<string, unknown>; inclusionProof: null };
  expectedRequestIdHex: string;
  expectedTransactionHash: string;
}> {
  const senderSigningService = await SigningService.createFromSecret(
    SigningService.generatePrivateKey(),
  );
  const recipientSigningService = await SigningService.createFromSecret(
    SigningService.generatePrivateKey(),
  );

  const tokenId = TokenId.fromJSON('aa'.repeat(32));
  const tokenType = TokenType.fromJSON('bb'.repeat(32));

  const senderSalt = new Uint8Array(32).fill(0xcc);
  const senderPredicate = await UnmaskedPredicate.create(
    tokenId,
    tokenType,
    senderSigningService,
    HashAlgorithm.SHA256,
    senderSalt,
  );
  const sourceState = new TokenState(senderPredicate, null);

  const transferSalt = new Uint8Array(32).fill(0xdd);
  const recipientPredicate = await UnmaskedPredicate.create(
    tokenId,
    tokenType,
    recipientSigningService,
    HashAlgorithm.SHA256,
    transferSalt,
  );
  const recipientReference = await recipientPredicate.getReference();
  const recipientAddress = await recipientReference.toAddress();

  const txData = TransferTransactionData.create(
    sourceState,
    recipientAddress,
    transferSalt,
    null,
    null,
    [],
  );

  const txDataHash = await txData.calculateHash();
  const expectedTransactionHash = txDataHash.toJSON();

  const sourceStateHash = await sourceState.calculateHash();
  const expectedRequestIdHex = (
    await RequestId.create(senderSigningService.publicKey, sourceStateHash)
  ).toJSON();

  const transferTxJson = {
    data: txData.toJSON() as Record<string, unknown>,
    inclusionProof: null,
  };

  return { transferTxJson, expectedRequestIdHex, expectedTransactionHash };
}

/**
 * Build an aggregator mock whose `getProof(requestId)` returns the given
 * proof shape. All other methods throw — only `getProof` is exercised on
 * the attach-only flow (preflight does NOT re-submit).
 */
function makeProofServingAggregator(
  requestId: string,
  proofShape: unknown,
  transactionHash: string,
): OracleProvider {
  const proofEnvelope: InclusionProof & { transactionHash: string } = {
    requestId,
    roundNumber: 1,
    proof: proofShape,
    transactionHash,
    timestamp: Date.now(),
  } as InclusionProof & { transactionHash: string };

  return {
    id: 'mock-issue-197',
    name: 'Issue197Mock',
    type: 'network',
    description: '',
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: () => true,
    getStatus: () => 'connected' as const,
    initialize: vi.fn(),
    validateToken: vi.fn(),
    isSpent: vi.fn().mockResolvedValue(false),
    getTokenState: vi.fn().mockResolvedValue(null),
    getCurrentRound: vi.fn().mockResolvedValue(1),
    submitCommitment: vi.fn().mockRejectedValue(
      new Error('submit should not be called on attach-only finalize path'),
    ),
    getProof: vi.fn().mockImplementation(async (rid: string) => {
      if (rid === requestId) return proofEnvelope;
      return null;
    }),
    waitForProof: vi.fn().mockRejectedValue(new Error('not used')),
  } as unknown as OracleProvider;
}

// =============================================================================
// 2. Tests
// =============================================================================

describe('Issue #197 — finalizeSourceTokenChain with real SDK transferTxJson', () => {
  it('attaches an aggregator proof to a proofless intermediate tx', async () => {
    const { transferTxJson, expectedRequestIdHex, expectedTransactionHash } =
      await buildRealTransferTxJson();

    // Compose a Token whose sdkData chain ends with the proofless
    // tx. (For this test the chain depth is 1; the routine treats
    // every proofless entry identically regardless of position.)
    const sdkData = JSON.stringify({
      genesis: { data: { tokenId: 'aa'.repeat(32) } },
      transactions: [transferTxJson],
      state: { predicate: { engine: 'unmasked' } },
    });
    const token: Token = {
      id: 'tok-issue-197',
      coinId: 'UCT',
      symbol: 'UCT',
      name: 'Unicity',
      decimals: 8,
      amount: '100',
      status: 'confirmed',
      createdAt: 1_000,
      updatedAt: 1_000,
      sdkData,
    };

    const aggregatorProofShape = { mocked: 'inclusion-proof' };
    const aggregator = makeProofServingAggregator(
      expectedRequestIdHex,
      aggregatorProofShape,
      expectedTransactionHash,
    );

    const result = await finalizeSourceTokenChain(token, aggregator, {
      transientRetryDelayMs: 0,
    });

    // A NEW reference was returned (no-op contract: same ref when no
    // work was done; different ref when proof attached).
    expect(result).not.toBe(token);
    expect(result.id).toBe(token.id);
    expect(result.updatedAt).toBeGreaterThan(token.updatedAt);

    // The patched sdkData has the proof attached at the right index.
    expect(result.sdkData).toBeDefined();
    const parsed = JSON.parse(result.sdkData!);
    expect(parsed.transactions).toHaveLength(1);
    expect(parsed.transactions[0].inclusionProof).toEqual(aggregatorProofShape);
    // Other fields are preserved
    expect(parsed.transactions[0].data).toEqual(transferTxJson.data);
    expect(parsed.genesis).toEqual({ data: { tokenId: 'aa'.repeat(32) } });
    expect(parsed.state).toEqual({ predicate: { engine: 'unmasked' } });

    // The aggregator was probed exactly once for the canonical requestId.
    expect(aggregator.getProof).toHaveBeenCalledWith(expectedRequestIdHex);
    expect(aggregator.submitCommitment).not.toHaveBeenCalled();
  });

  it('returns SAME reference when chain is already fully finalized (idempotency)', async () => {
    const { transferTxJson } = await buildRealTransferTxJson();
    // Patch a non-null proof onto the tx so the chain looks finalized.
    const finalizedTx = { ...transferTxJson, inclusionProof: { already: 'attached' } };
    const sdkData = JSON.stringify({
      genesis: { data: { tokenId: 'aa'.repeat(32) } },
      transactions: [finalizedTx],
      state: { predicate: { engine: 'unmasked' } },
    });
    const token: Token = {
      id: 'tok-already-final',
      coinId: 'UCT',
      symbol: 'UCT',
      name: 'Unicity',
      decimals: 8,
      amount: '100',
      status: 'confirmed',
      createdAt: 1_000,
      updatedAt: 1_000,
      sdkData,
    };

    const aggregator = makeProofServingAggregator('unused', {}, 'unused');

    const result = await finalizeSourceTokenChain(token, aggregator);
    expect(result).toBe(token); // same reference — no allocation
    expect(aggregator.getProof).not.toHaveBeenCalled();
  });

  it('raises SOURCE_CHAIN_HARD_FAIL when aggregator returns null sustained past retry budget', async () => {
    const { transferTxJson, expectedRequestIdHex } = await buildRealTransferTxJson();
    const sdkData = JSON.stringify({
      genesis: { data: { tokenId: 'aa'.repeat(32) } },
      transactions: [transferTxJson],
      state: { predicate: { engine: 'unmasked' } },
    });
    const token: Token = {
      id: 'tok-no-proof',
      coinId: 'UCT',
      symbol: 'UCT',
      name: 'Unicity',
      decimals: 8,
      amount: '100',
      status: 'confirmed',
      createdAt: 1_000,
      updatedAt: 1_000,
      sdkData,
    };

    // Aggregator returns null for every getProof call.
    const aggregator = {
      ...makeProofServingAggregator(expectedRequestIdHex, {}, 'unused'),
      getProof: vi.fn().mockResolvedValue(null),
      submitCommitment: vi.fn().mockResolvedValue({
        success: true,
        requestId: expectedRequestIdHex,
        timestamp: Date.now(),
      }),
    } as unknown as OracleProvider;

    let captured: unknown = null;
    try {
      await finalizeSourceTokenChain(token, aggregator, {
        transientRetryCount: 1,
        transientRetryDelayMs: 0,
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).not.toBeNull();
    const errObj = captured as { code?: string; message?: string };
    expect(errObj.code).toBe('SOURCE_CHAIN_HARD_FAIL');
  });
});
