/**
 * §11.2 integration — NFT-only send (whole-token transfer).
 *
 * Spec scenario (§11.2, NFT-only send):
 *   "Source: NFT-token `T` (tokenId=`0xabc`, empty coinData), owned by
 *    sender. Request omits primary `coinId`/`amount`; `additionalAssets:
 *    [{kind: 'nft', tokenId: '0xabc'}]`. Recipient receives `T'` with
 *    the SAME tokenId; coinData still empty; current state binds to
 *    recipient. No split, no change token (whole-token state-transition)."
 *
 * Pipeline under test:
 *   - `validateTargets` accepts `(no primary, [{kind:'nft', tokenId}])`
 *     against an NFT-class source (empty coinData).
 *   - The conservative-sender's `commitSources` callback returns a
 *     whole-token state transition (`method: 'direct'`); recipient JSON
 *     preserves the source's tokenId.
 *
 * Also covers the multi-NFT case (two distinct NFTs in one bundle).
 *
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';

import {
  sendConservativeUxf,
  type ConservativeCommitResult,
  type ConservativeSenderDeps,
} from '../../../extensions/uxf/pipeline/conservative-sender';
import type { TokenLike } from '../../../extensions/uxf/pipeline/classify-token';
import type { PreflightFinalizeOptions } from '../../../extensions/uxf/pipeline/preflight-finalize';
import type { Token, TransferRequest } from '../../../types';
import type { UxfTransferPayloadCar } from '../../../extensions/uxf/types/uxf-transfer';
import { TOKEN_A } from '../../fixtures/uxf-mock-tokens';

import {
  BOB_TRANSPORT_PUBKEY,
  makeEventRecorder,
  makeIdentity,
  makeOracleStub,
  makePeerInfo,
  makeRecordingTransport,
  makeToken,
  rewriteFixtureCoinData,
  rewriteFixtureTokenId,
} from './_harness';

// =============================================================================
// 1. NFT projection
// =============================================================================

function nftProjection(token: Token): TokenLike {
  return {
    id: token.id,
    coins: null,
  };
}

// =============================================================================
// 2. Tests
// =============================================================================

describe('§11.2 — NFT-only send (single NFT, no primary slot)', () => {
  it('omits primary coinId/amount; additionalAssets carries one NFT entry; whole-token transfer', async () => {
    const nftIdHex = `aa${'1'.padStart(2, '0')}${'0'.repeat(60)}`;
    // NFTs carry empty `coinData` per §4.1 (class-disjoint with coin
    // tokens). The default TOKEN_A placeholder has UCT in coinData
    // which would trip OVER_TRANSFER_GUARD on a request with no
    // primary coin slot (budget = 0 for any coin).
    const nftFixture = rewriteFixtureCoinData(
      rewriteFixtureTokenId(TOKEN_A, nftIdHex),
      [],
    );
    const nftToken = makeToken({
      id: nftIdHex,
      fixture: nftFixture,
      // status doesn't affect NFT classification — the projection
      // returns coins: null which is the §4.1 normative NFT predicate.
    });

    // Recipient's child preserves the source tokenId (whole-token
    // transfer per §4.1 canonical asset model).
    const commitResult: ConservativeCommitResult = {
      sourceTokenId: nftIdHex,
      method: 'direct',
      requestIdHex: `req-${nftIdHex}`,
      // recipientTokenJson preserves the original tokenId — that's the
      // whole-token semantic for NFTs.
      recipientTokenJson: nftFixture,
    };

    const transport = makeRecordingTransport();
    const events = makeEventRecorder();
    const deps: ConservativeSenderDeps = {
      aggregator: makeOracleStub(),
      transport,
      identity: makeIdentity(),
      senderTransportPubkey: BOB_TRANSPORT_PUBKEY,
      emit: events.emit,
      availableSources: () => [nftToken],
      selectSources: async () => [nftToken],
      preflightOptions: () => ({
        resolveRequestId: () => {
          throw new Error('not invoked');
        },
        extractPendingChain: () => [],
      } satisfies Omit<PreflightFinalizeOptions, 'aggregator'>),
      commitSources: async () => [commitResult],
      toTokenLike: nftProjection,
    };

    // Request OMITS primary slot — both coinId and amount unset.
    // additionalAssets carries the single NFT target.
    const request: TransferRequest = {
      recipient: '@bob',
      additionalAssets: [{ kind: 'nft', tokenId: nftIdHex }],
      transferMode: 'conservative',
      delivery: { kind: 'force-inline' },
    };

    const result = await sendConservativeUxf(request, makePeerInfo(), deps);
    expect(result.status).toBe('completed');

    // Wire payload carries the NFT's tokenId; method = 'direct' (no
    // split for whole-token transfers).
    const payload = transport._calls[0].payload as UxfTransferPayloadCar;
    expect(payload.tokenIds).toEqual([nftIdHex]);
    expect(result.tokenTransfers).toHaveLength(1);
    expect(result.tokenTransfers[0].method).toBe('direct');
    expect(events.count('transfer:confirmed')).toBe(1);
  });

  it('multi-NFT send: two distinct NFTs in one bundle — both surface on the wire', async () => {
    const nft1Hex = `aa${'1'.padStart(2, '0')}${'0'.repeat(60)}`;
    const nft2Hex = `aa${'2'.padStart(2, '0')}${'0'.repeat(60)}`;
    // Both NFT fixtures carry empty coinData (§4.1 class-disjoint).
    // OVER_TRANSFER_GUARD treats empty/absent coinData as NFT-shape
    // and skips the per-coin budget check.
    const nft1Fixture = rewriteFixtureCoinData(
      rewriteFixtureTokenId(TOKEN_A, nft1Hex),
      [],
    );
    const nft2Fixture = rewriteFixtureCoinData(
      rewriteFixtureTokenId(TOKEN_A, nft2Hex),
      [],
    );
    const nft1 = makeToken({ id: nft1Hex, fixture: nft1Fixture });
    const nft2 = makeToken({ id: nft2Hex, fixture: nft2Fixture });

    const commitResults: ConservativeCommitResult[] = [
      {
        sourceTokenId: nft1Hex,
        method: 'direct',
        requestIdHex: `req-${nft1Hex}`,
        recipientTokenJson: nft1Fixture,
      },
      {
        sourceTokenId: nft2Hex,
        method: 'direct',
        requestIdHex: `req-${nft2Hex}`,
        recipientTokenJson: nft2Fixture,
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
      availableSources: () => [nft1, nft2],
      selectSources: async () => [nft1, nft2],
      preflightOptions: () => ({
        resolveRequestId: () => {
          throw new Error('not invoked');
        },
        extractPendingChain: () => [],
      } satisfies Omit<PreflightFinalizeOptions, 'aggregator'>),
      commitSources: async () => commitResults,
      toTokenLike: nftProjection,
    };

    const request: TransferRequest = {
      recipient: '@bob',
      additionalAssets: [
        { kind: 'nft', tokenId: nft1Hex },
        { kind: 'nft', tokenId: nft2Hex },
      ],
      transferMode: 'conservative',
      delivery: { kind: 'force-inline' },
    };

    const result = await sendConservativeUxf(request, makePeerInfo(), deps);
    expect(result.status).toBe('completed');

    const payload = transport._calls[0].payload as UxfTransferPayloadCar;
    expect([...payload.tokenIds].sort()).toEqual([nft1Hex, nft2Hex].sort());
    expect(result.tokenTransfers).toHaveLength(2);
    for (const detail of result.tokenTransfers) {
      expect(detail.method).toBe('direct');
    }
  });

  it('rejects NFT target whose source is missing — INSUFFICIENT_BALANCE / nft-not-owned', async () => {
    const ownedHex = `aa${'1'.padStart(2, '0')}${'0'.repeat(60)}`;
    const missingHex = `bb${'9'.padStart(2, '0')}${'0'.repeat(60)}`;
    const ownedNft = makeToken({
      id: ownedHex,
      fixture: rewriteFixtureTokenId(TOKEN_A, ownedHex),
    });

    const transport = makeRecordingTransport();
    const events = makeEventRecorder();
    const deps: ConservativeSenderDeps = {
      aggregator: makeOracleStub(),
      transport,
      identity: makeIdentity(),
      senderTransportPubkey: BOB_TRANSPORT_PUBKEY,
      emit: events.emit,
      availableSources: () => [ownedNft],
      selectSources: async () => [ownedNft],
      preflightOptions: () => ({
        resolveRequestId: () => {
          throw new Error('not invoked');
        },
        extractPendingChain: () => [],
      } satisfies Omit<PreflightFinalizeOptions, 'aggregator'>),
      commitSources: async () => [],
      toTokenLike: nftProjection,
    };

    const request: TransferRequest = {
      recipient: '@bob',
      additionalAssets: [{ kind: 'nft', tokenId: missingHex }],
      transferMode: 'conservative',
    };

    let caughtCode: string | undefined;
    let caughtReason: string | undefined;
    try {
      await sendConservativeUxf(request, makePeerInfo(), deps);
    } catch (err) {
      caughtCode = (err as { code?: string }).code;
      const cause = (err as { cause?: { reason?: string } }).cause;
      caughtReason = cause?.reason;
    }
    expect(caughtCode).toBe('INSUFFICIENT_BALANCE');
    expect(caughtReason).toBe('nft-not-owned');
    expect(transport._calls).toHaveLength(0);
    expect(events.count('transfer:failed')).toBe(1);
  });
});
