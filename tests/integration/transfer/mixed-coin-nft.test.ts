/**
 * §11.2 integration — Mixed coin + NFT send (separate sources only).
 *
 * Spec scenario (§11.2):
 *   "Source A `{UCT:100}` (coin token) + source B (NFT-token, empty
 *    coinData). Request: `coinId:'UCT', amount:'30',
 *    additionalAssets:[{kind:'nft', tokenId:B.id}]`. Split A: recipient-A
 *    `{UCT:30}` (fresh tokenId) + change-A `{UCT:70}` (fresh tokenId).
 *    Whole-transfer B: recipient-B `B'` with preserved tokenId. Bundle
 *    carries both; recipient receives two child tokens."
 *
 * Pipeline under test:
 *   - `validateTargets` accepts the heterogeneous target list
 *     (1 coin target + 1 nft target) against the heterogeneous source
 *     pool (1 coin source + 1 nft source).
 *   - `commitSources` returns two commits, one per source. The coin
 *     commit's `method='split'`; the NFT commit's `method='direct'`.
 *   - The wire payload's `tokenIds` carries both source ids; the
 *     bundle's two ingested elements are content-addressed under their
 *     respective tokenIds.
 *
 * Acceptance also covers the §11.2 class-disjointness rule: an NFT
 * target backed by a COIN token (non-empty coinData) MUST be rejected
 * with `INSUFFICIENT_BALANCE` reason='nft-not-owned'.
 *
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';

import {
  sendConservativeUxf,
  type ConservativeCommitResult,
  type ConservativeSenderDeps,
} from '../../../modules/payments/transfer/conservative-sender';
import type { TokenLike } from '../../../modules/payments/transfer/classify-token';
import type { PreflightFinalizeOptions } from '../../../modules/payments/transfer/preflight-finalize';
import type { Token, TransferRequest } from '../../../types';
import type { UxfTransferPayloadCar } from '../../../types/uxf-transfer';
import { TOKEN_A } from '../../fixtures/uxf-mock-tokens';

import {
  BOB_TRANSPORT_PUBKEY,
  makeEventRecorder,
  makeIdentity,
  makeOracleStub,
  makePeerInfo,
  makeRecordingTransport,
  makeToken,
  rewriteFixtureTokenId,
} from './_harness';

// =============================================================================
// 1. Tests
// =============================================================================

describe('§11.2 — mixed coin + NFT send (separate sources)', () => {
  it('UCT(30) + NFT(B) → bundle carries 2 source ids; coin=split, NFT=direct', async () => {
    const coinIdHex = `aa${'1'.padStart(2, '0')}${'0'.repeat(60)}`;
    const nftIdHex = `bb${'1'.padStart(2, '0')}${'0'.repeat(60)}`;
    const coinSrc = makeToken({
      id: coinIdHex,
      fixture: rewriteFixtureTokenId(TOKEN_A, coinIdHex),
    });
    const nftSrc = makeToken({
      id: nftIdHex,
      fixture: rewriteFixtureTokenId(TOKEN_A, nftIdHex),
    });

    // Heterogeneous projection: coin source carries UCT(100); NFT
    // source has empty coinData.
    const projection = (token: Token): TokenLike => {
      if (token.id === coinIdHex) {
        return { id: token.id, coins: [{ coinId: 'UCT', amount: 100n }] };
      }
      return { id: token.id, coins: null };
    };

    // Coin commit: split → fresh recipient-token id.
    // NFT commit: direct → preserved tokenId.
    const coinChild = rewriteFixtureTokenId(
      TOKEN_A,
      `cc${'1'.padStart(2, '0')}${'0'.repeat(60)}`,
    );
    const commitResults: ConservativeCommitResult[] = [
      {
        sourceTokenId: coinIdHex,
        method: 'split',
        requestIdHex: `req-${coinIdHex}`,
        recipientTokenJson: coinChild,
        splitGroupId: `split-${coinIdHex}`,
      },
      {
        sourceTokenId: nftIdHex,
        method: 'direct',
        requestIdHex: `req-${nftIdHex}`,
        recipientTokenJson: rewriteFixtureTokenId(TOKEN_A, nftIdHex),
      },
    ];

    const transport = makeRecordingTransport();
    const events = makeEventRecorder();
    const deps: ConservativeSenderDeps = {
      aggregator: makeOracleStub(),
      transport,
      identity: makeIdentity(),
      senderTransportPubkey: BOB_TRANSPORT_PUBKEY,
      emit: events.emit,
      availableSources: () => [coinSrc, nftSrc],
      selectSources: async () => [coinSrc, nftSrc],
      preflightOptions: () => ({
        resolveRequestId: () => {
          throw new Error('not invoked');
        },
        extractPendingChain: () => [],
      } satisfies Omit<PreflightFinalizeOptions, 'aggregator'>),
      commitSources: async () => commitResults,
      toTokenLike: projection,
    };

    const request: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '30',
      additionalAssets: [{ kind: 'nft', tokenId: nftIdHex }],
      transferMode: 'conservative',
      delivery: { kind: 'force-inline' },
    };

    const result = await sendConservativeUxf(request, makePeerInfo(), deps);
    expect(result.status).toBe('completed');

    // Bundle carries both source ids on the wire.
    const payload = transport._calls[0].payload as UxfTransferPayloadCar;
    expect([...payload.tokenIds].sort()).toEqual([coinIdHex, nftIdHex].sort());

    // Per-token detail: coin = split + splitGroupId; NFT = direct (no
    // splitGroupId).
    expect(result.tokenTransfers).toHaveLength(2);
    const byId = new Map(result.tokenTransfers.map((d) => [d.sourceTokenId, d]));
    const coinDetail = byId.get(coinIdHex);
    const nftDetail = byId.get(nftIdHex);
    expect(coinDetail?.method).toBe('split');
    expect(coinDetail?.splitGroupId).toBe(`split-${coinIdHex}`);
    expect(nftDetail?.method).toBe('direct');
    expect(nftDetail?.splitGroupId).toBeUndefined();

    expect(events.count('transfer:confirmed')).toBe(1);
  });

  it('rejects NFT target backed by a COIN token (class disjointness, §4.1)', async () => {
    // Source has tokenId == nftIdHex but its projection carries
    // non-empty coinData → it's classified as `coin`, not `nft`. The
    // validator rejects with INSUFFICIENT_BALANCE / nft-not-owned per
    // §11.2's class-disjointness rule.
    const coinIdHex = `aa${'1'.padStart(2, '0')}${'0'.repeat(60)}`;
    const fauxNftIdHex = `bb${'1'.padStart(2, '0')}${'0'.repeat(60)}`;
    const coinSrc = makeToken({
      id: coinIdHex,
      fixture: rewriteFixtureTokenId(TOKEN_A, coinIdHex),
    });
    const fauxNftSrc = makeToken({
      id: fauxNftIdHex,
      fixture: rewriteFixtureTokenId(TOKEN_A, fauxNftIdHex),
    });

    const projection = (token: Token): TokenLike => {
      // Both sources project as COIN tokens — the "NFT" target's
      // matching tokenId is wrapping a coin token (non-empty coinData).
      return {
        id: token.id,
        coins: [{ coinId: 'UCT', amount: 100n }],
      };
    };

    const transport = makeRecordingTransport();
    const events = makeEventRecorder();
    const deps: ConservativeSenderDeps = {
      aggregator: makeOracleStub(),
      transport,
      identity: makeIdentity(),
      senderTransportPubkey: BOB_TRANSPORT_PUBKEY,
      emit: events.emit,
      availableSources: () => [coinSrc, fauxNftSrc],
      selectSources: async () => [coinSrc, fauxNftSrc],
      preflightOptions: () => ({
        resolveRequestId: () => {
          throw new Error('not invoked');
        },
        extractPendingChain: () => [],
      } satisfies Omit<PreflightFinalizeOptions, 'aggregator'>),
      commitSources: async () => [],
      toTokenLike: projection,
    };

    const request: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '30',
      additionalAssets: [{ kind: 'nft', tokenId: fauxNftIdHex }],
      transferMode: 'conservative',
    };

    let caughtCode: string | undefined;
    let caughtReason: string | undefined;
    try {
      await sendConservativeUxf(request, makePeerInfo(), deps);
    } catch (err) {
      caughtCode = (err as { code?: string }).code;
      caughtReason = (err as { cause?: { reason?: string } }).cause?.reason;
    }
    expect(caughtCode).toBe('INSUFFICIENT_BALANCE');
    expect(caughtReason).toBe('nft-not-owned');
    expect(transport._calls).toHaveLength(0);
    expect(events.count('transfer:failed')).toBe(1);
  });
});
