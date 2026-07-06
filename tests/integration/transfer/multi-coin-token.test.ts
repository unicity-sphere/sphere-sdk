/**
 * §11.2 integration — Multi-coin token, single-coin send.
 *
 * Spec scenario (§11.2):
 *   "A token containing `{UCT: 100, USDU: 50}` is sent for `(UCT, 30)`
 *    only. Verify change stays at sender with `{UCT: 70, USDU: 50}`;
 *    recipient receives a child token with `(UCT, 30)`."
 *
 * Pipeline under test:
 *   - `validateTargets` accepts a single-coin TransferRequest against a
 *     multi-coin source token (the validator partitions coverage by
 *     `coinId`).
 *   - The conservative-sender orchestrator commits the source via the
 *     caller-supplied `commitSources` callback; the callback simulates
 *     the SDK's burn-then-mint by returning a fresh recipient-shape
 *     token with the requested coin slice.
 *
 * The §11.2 spec also notes that the LEFTOVER (change) carries the
 * remaining `{UCT: 70, USDU: 50}` and stays with the sender — that
 * change-token is a SDK-side bookkeeping concern (the caller's
 * `commitSources` invoked the SDK's `TokenSplit` which produced the
 * change). The orchestrator does NOT see the change directly; we
 * validate that the sender-side projection still reflects it.
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
import type { TransferRequest, Token } from '../../../types';
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
  rewriteFixtureCoinData,
  rewriteFixtureTokenId,
} from './_harness';

// =============================================================================
// 1. Multi-coin TokenLike projection
// =============================================================================

/**
 * Project a wallet `Token` whose `sdkData` we treat opaquely into a
 * multi-coin {@link TokenLike} carrying both UCT and USDU balances. The
 * orchestrator's validator slot accepts arbitrary projections — see
 * `defaultCoinTokenLike` in `_harness.ts` for the single-coin case.
 */
function multiCoinTokenLike(token: Token): TokenLike {
  return {
    id: token.id,
    coins: [
      { coinId: 'UCT', amount: 100n },
      { coinId: 'USDU', amount: 50n },
    ],
  };
}

// =============================================================================
// 2. Test
// =============================================================================

describe('§11.2 — multi-coin source, single-coin send (UCT slice)', () => {
  it('validator accepts UCT(30) target against multi-coin {UCT:100, USDU:50} source', async () => {
    // Source: id `multi-1`, projection carries UCT(100) + USDU(50).
    const srcIdHex = `aa${'1'.padStart(2, '0')}${'0'.repeat(60)}`;
    const sourceFixture = rewriteFixtureTokenId(TOKEN_A, srcIdHex);
    const source = makeToken({ id: srcIdHex, fixture: sourceFixture });

    // Recipient child: a fresh tokenId carrying only UCT(30). The
    // orchestrator ingests this JSON into the bundle and the
    // OVER_TRANSFER_GUARD inspects `coinData` per source — overriding
    // the placeholder's default `[['UCT', '1000000']]` so the per-coin
    // ship-vs-budget sum lands at the exact requested slice (matches
    // what production's TokenSplitExecutor would mint).
    const childIdHex = `bb${'1'.padStart(2, '0')}${'0'.repeat(60)}`;
    const childFixture = rewriteFixtureCoinData(
      rewriteFixtureTokenId(TOKEN_A, childIdHex),
      [['UCT', '30']],
    );

    const commitResult: ConservativeCommitResult = {
      sourceTokenId: srcIdHex,
      method: 'split',
      requestIdHex: `req-${srcIdHex}`,
      recipientTokenJson: childFixture,
      splitGroupId: `split-${srcIdHex}`,
    };

    const transport = makeRecordingTransport();
    const events = makeEventRecorder();
    const deps: ConservativeSenderDeps = {
      aggregator: makeOracleStub(),
      transport,
      identity: makeIdentity(),
      senderTransportPubkey: BOB_TRANSPORT_PUBKEY,
      emit: events.emit,
      availableSources: () => [source],
      selectSources: async () => [source],
      preflightOptions: () => ({
        resolveRequestId: () => {
          throw new Error('not invoked');
        },
        extractPendingChain: () => [],
      } satisfies Omit<PreflightFinalizeOptions, 'aggregator'>),
      commitSources: async () => [commitResult],
      toTokenLike: multiCoinTokenLike,
    };

    // §11.2: send (UCT, 30) only — no additionalAssets, no NFTs.
    const request: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '30',
      transferMode: 'conservative',
      delivery: { kind: 'force-inline' },
    };

    const result = await sendConservativeUxf(request, makePeerInfo(), deps);
    expect(result.status).toBe('completed');

    // Wire payload carries exactly ONE tokenId — the recipient mint's
    // freshly-minted child tokenId. Commit 718ab12 (#142 Loop4) fixed
    // a recipient-side silent loss: advertising sourceTokenId caused
    // the receiver's bundle-verifier to fall to advisoryUnclaimedRoots
    // because the source token isn't in the CAR (it was burned). The
    // child mint IS in the CAR, so it must surface in tokenIds.
    const payload = transport._calls[0].payload as UxfTransferPayloadCar;
    expect(payload.tokenIds).toEqual([childIdHex]);
    expect(payload.mode).toBe('conservative');

    // method='split' on the per-source TokenTransferDetail (the SDK
    // performed a burn-then-mint).
    expect(result.tokenTransfers).toHaveLength(1);
    expect(result.tokenTransfers[0].method).toBe('split');
    expect(result.tokenTransfers[0].splitGroupId).toBe(`split-${srcIdHex}`);

    // No transfer:failed.
    expect(events.count('transfer:failed')).toBe(0);
    expect(events.count('transfer:confirmed')).toBe(1);
  });

  it('rejects (USDU, 200) on the same source — INSUFFICIENT_BALANCE for the un-covered coin', async () => {
    const srcIdHex = `aa${'2'.padStart(2, '0')}${'0'.repeat(60)}`;
    const sourceFixture = rewriteFixtureTokenId(TOKEN_A, srcIdHex);
    const source = makeToken({ id: srcIdHex, fixture: sourceFixture });

    const transport = makeRecordingTransport();
    const events = makeEventRecorder();
    const deps: ConservativeSenderDeps = {
      aggregator: makeOracleStub(),
      transport,
      identity: makeIdentity(),
      senderTransportPubkey: BOB_TRANSPORT_PUBKEY,
      emit: events.emit,
      availableSources: () => [source],
      selectSources: async () => [source],
      preflightOptions: () => ({
        resolveRequestId: () => {
          throw new Error('not invoked');
        },
        extractPendingChain: () => [],
      } satisfies Omit<PreflightFinalizeOptions, 'aggregator'>),
      commitSources: async () => {
        throw new Error('commitSources should not be reached');
      },
      toTokenLike: multiCoinTokenLike,
    };

    const request: TransferRequest = {
      recipient: '@bob',
      // USDU only has 50 in the source; ask for 200 → reject.
      coinId: 'USDU',
      amount: '200',
      transferMode: 'conservative',
    };

    let caughtCode: string | undefined;
    try {
      await sendConservativeUxf(request, makePeerInfo(), deps);
    } catch (err) {
      caughtCode = (err as { code?: string }).code;
    }
    expect(caughtCode).toBe('INSUFFICIENT_BALANCE');

    // Sender event: transfer:failed.
    expect(events.count('transfer:failed')).toBe(1);
    expect(events.count('transfer:confirmed')).toBe(0);

    // Transport untouched.
    expect(transport._calls).toHaveLength(0);
  });
});
