/**
 * §11.2 integration — Multi-coin send via `additionalAssets` (happy path).
 *
 * Spec scenario (§11.2):
 *   "Single multi-coin source `{UCT: 100, USDU: 50, ALPHA: 1000}` sent
 *    with `coinId='UCT', amount='30', additionalAssets=[{kind:'coin',
 *    coinId:'USDU', amount:'20'}]`. Recipient receives one child token
 *    with `{UCT: 30, USDU: 20}`; change has `{UCT: 70, USDU: 30,
 *    ALPHA: 1000}`."
 *
 * Pipeline under test:
 *   - `validateTargets` accepts (primary UCT, additional USDU) targets
 *     against a multi-coin source.
 *   - The conservative-sender invokes `commitSources` with the SDK
 *     handling the burn-then-mint that produces a multi-coin recipient
 *     child + a multi-coin change.
 *   - Wire payload carries the source's tokenId; the recipient's
 *     ingested JSON shape is opaque to the orchestrator.
 *
 * Includes the §11.2 dual-source variant where two single-coin sources
 * (A=`{UCT:100}` + B=`{USDU:50}`) cover the same target list — recipient
 * receives TWO child tokens (one per source).
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

describe('§11.2 — additionalAssets happy path (single multi-coin source)', () => {
  it('UCT(30) + USDU(20) against {UCT:100, USDU:50, ALPHA:1000} — orchestrator commits one source', async () => {
    const srcIdHex = `aa${'1'.padStart(2, '0')}${'0'.repeat(60)}`;
    const source = makeToken({
      id: srcIdHex,
      fixture: rewriteFixtureTokenId(TOKEN_A, srcIdHex),
    });

    // Project the source as multi-coin {UCT:100, USDU:50, ALPHA:1000}.
    const projection = (token: Token): TokenLike => ({
      id: token.id,
      coins: [
        { coinId: 'UCT', amount: 100n },
        { coinId: 'USDU', amount: 50n },
        { coinId: 'ALPHA', amount: 1000n },
      ],
    });

    // Recipient child: one fresh token with the requested slice
    // {UCT:30, USDU:20}. The orchestrator does NOT inspect the JSON;
    // we use the fixture's shape as a placeholder.
    const childIdHex = `bb${'1'.padStart(2, '0')}${'0'.repeat(60)}`;
    const childFixture = rewriteFixtureTokenId(TOKEN_A, childIdHex);

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
      toTokenLike: projection,
    };

    const request: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '30',
      additionalAssets: [{ kind: 'coin', coinId: 'USDU', amount: '20' }],
      transferMode: 'conservative',
      delivery: { kind: 'force-inline' },
    };

    const result = await sendConservativeUxf(request, makePeerInfo(), deps);
    expect(result.status).toBe('completed');

    const payload = transport._calls[0].payload as UxfTransferPayloadCar;
    expect(payload.tokenIds).toEqual([srcIdHex]);
    expect(events.count('transfer:confirmed')).toBe(1);
    expect(result.tokenTransfers).toHaveLength(1);
    expect(result.tokenTransfers[0].method).toBe('split');
  });

  it('UCT(30) + USDU(20) covered by TWO single-coin sources — bundle ships both', async () => {
    // Spec: "Multiple sources (A `{UCT:100}`, B `{USDU:50}`) covering
    // `coinId='UCT', amount='30', additionalAssets=[{kind:'coin',
    // coinId:'USDU', amount:'20'}]`. Recipient receives TWO child tokens
    // (one per source); change has two tokens (`{UCT:70}` from A,
    // `{USDU:30}` from B)."

    const srcA = makeToken({
      id: `aa${'2'.padStart(2, '0')}${'0'.repeat(60)}`,
      fixture: rewriteFixtureTokenId(
        TOKEN_A,
        `aa${'2'.padStart(2, '0')}${'0'.repeat(60)}`,
      ),
    });
    const srcB = makeToken({
      id: `bb${'2'.padStart(2, '0')}${'0'.repeat(60)}`,
      fixture: rewriteFixtureTokenId(
        TOKEN_A,
        `bb${'2'.padStart(2, '0')}${'0'.repeat(60)}`,
      ),
    });

    const projection = (token: Token): TokenLike => {
      if (token.id === srcA.id) {
        return { id: token.id, coins: [{ coinId: 'UCT', amount: 100n }] };
      }
      return { id: token.id, coins: [{ coinId: 'USDU', amount: 50n }] };
    };

    // Two children, one per source.
    const childA = rewriteFixtureTokenId(
      TOKEN_A,
      `cc${'1'.padStart(2, '0')}${'0'.repeat(60)}`,
    );
    const childB = rewriteFixtureTokenId(
      TOKEN_A,
      `cc${'2'.padStart(2, '0')}${'0'.repeat(60)}`,
    );
    const commitResults: ConservativeCommitResult[] = [
      {
        sourceTokenId: srcA.id,
        method: 'split',
        requestIdHex: `req-${srcA.id}`,
        recipientTokenJson: childA,
      },
      {
        sourceTokenId: srcB.id,
        method: 'split',
        requestIdHex: `req-${srcB.id}`,
        recipientTokenJson: childB,
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
      availableSources: () => [srcA, srcB],
      selectSources: async () => [srcA, srcB],
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
      additionalAssets: [{ kind: 'coin', coinId: 'USDU', amount: '20' }],
      transferMode: 'conservative',
      delivery: { kind: 'force-inline' },
    };

    const result = await sendConservativeUxf(request, makePeerInfo(), deps);
    expect(result.status).toBe('completed');

    const payload = transport._calls[0].payload as UxfTransferPayloadCar;
    // Both source ids surface in tokenIds, lex-sorted.
    expect([...payload.tokenIds].sort()).toEqual([srcA.id, srcB.id].sort());
    expect(result.tokenTransfers).toHaveLength(2);
    expect(events.count('transfer:confirmed')).toBe(1);
  });

  it('rejects duplicate-coinId target list — INVALID_REQUEST', async () => {
    // primary UCT + additionalAssets UCT → spec validator rule.
    const transport = makeRecordingTransport();
    const events = makeEventRecorder();
    const deps: ConservativeSenderDeps = {
      aggregator: makeOracleStub(),
      transport,
      identity: makeIdentity(),
      senderTransportPubkey: BOB_TRANSPORT_PUBKEY,
      emit: events.emit,
      availableSources: () => [],
      selectSources: async () => {
        throw new Error('selectSources should not be reached');
      },
      preflightOptions: () => ({
        resolveRequestId: () => {
          throw new Error('not invoked');
        },
        extractPendingChain: () => [],
      } satisfies Omit<PreflightFinalizeOptions, 'aggregator'>),
      commitSources: async () => [],
      toTokenLike: (t: Token): TokenLike => ({
        id: t.id,
        coins: null,
      }),
    };

    const request: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '10',
      additionalAssets: [{ kind: 'coin', coinId: 'UCT', amount: '5' }],
      transferMode: 'conservative',
    };

    let caughtCode: string | undefined;
    try {
      await sendConservativeUxf(request, makePeerInfo(), deps);
    } catch (err) {
      caughtCode = (err as { code?: string }).code;
    }
    expect(caughtCode).toBe('INVALID_REQUEST');
    expect(transport._calls).toHaveLength(0);
    expect(events.count('transfer:failed')).toBe(1);
  });
});
