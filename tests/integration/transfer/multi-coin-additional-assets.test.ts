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
  rewriteFixtureCoinData,
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
    // {UCT:30, USDU:20}. The OVER_TRANSFER_GUARD inspects
    // `genesis.data.coinData` per source — defense-in-depth against a
    // buggy commitSources callback that silently over-sends. The
    // placeholder fixture's default `coinData: [['UCT', '1000000']]`
    // would trip the guard against the {UCT:30, USDU:20} budget, so
    // we rewrite coinData to match what production's TokenSplitExecutor
    // would mint for this slice.
    const childIdHex = `bb${'1'.padStart(2, '0')}${'0'.repeat(60)}`;
    const childFixture = rewriteFixtureCoinData(
      rewriteFixtureTokenId(TOKEN_A, childIdHex),
      [['UCT', '30'], ['USDU', '20']],
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

    // Wire `payload.tokenIds` is the RECIPIENT's genesis tokenId
    // (commit 718ab12 / #142 Loop4 — without this, the recipient's
    // bundle-verifier falls to advisoryUnclaimedRoots and silently
    // drops the transfer). For a split the child's tokenId is fresh.
    const payload = transport._calls[0].payload as UxfTransferPayloadCar;
    expect(payload.tokenIds).toEqual([childIdHex]);
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

    // Two children, one per source. Each child's `coinData` reflects
    // ONLY the slice that source contributes (TokenSplitExecutor mints
    // recipient coinData = `[[coinId, splitAmount]]`). The
    // OVER_TRANSFER_GUARD enforces this per-source — sticking with the
    // default TOKEN_A placeholder coinData would trip it.
    const childAIdHex = `cc${'1'.padStart(2, '0')}${'0'.repeat(60)}`;
    const childBIdHex = `cc${'2'.padStart(2, '0')}${'0'.repeat(60)}`;
    const childA = rewriteFixtureCoinData(
      rewriteFixtureTokenId(TOKEN_A, childAIdHex),
      [['UCT', '30']],
    );
    const childB = rewriteFixtureCoinData(
      rewriteFixtureTokenId(TOKEN_A, childBIdHex),
      [['USDU', '20']],
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
    // `payload.tokenIds` is the per-commit recipient genesis tokenId,
    // lex-sorted (commit 718ab12 / #142 Loop4). Splits produce fresh
    // child tokenIds, distinct from each source's id.
    expect([...payload.tokenIds].sort()).toEqual([childAIdHex, childBIdHex].sort());
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

// =============================================================================
// #149 — multi-coin splitSources (one split per coin class)
// =============================================================================
//
// Spec scenario (#149): Alice holds a single 1000-USDU token + a single
// 1000-USDC token. She sends `200 USDU + 100 USDC`. Both source holdings
// require partial-amount splitting (each coin has exactly one source
// token bigger than the requested amount).
//
// Pre-fix: the conservative dispatcher's `selectSources` ran one
// SpendPlanner.planSend per coin, but `ConservativeSourceSelection`
// only supported a single `splitSource`. The additional-asset
// `tokenToSplit` fell through to `directSources` → whole-token transfer
// → OVER_TRANSFER_GUARD throws.
//
// Post-fix: `splitSources` is an array. The dispatcher's
// `commitSources` iterates the array and runs one `TokenSplitExecutor.
// executeSplit` per entry. Each entry's `coinIdHex` drives the change
// token's coin class (not `request.coinId` for additional entries).

describe('#149 — multi-coin splitSources (conservative orchestrator)', () => {
  it('forwards multi-entry splitSources from selectSources to commitSources', async () => {
    const srcUsduIdHex = `cc${'1'.padStart(2, '0')}${'0'.repeat(60)}`;
    const srcUsdcIdHex = `cc${'2'.padStart(2, '0')}${'0'.repeat(60)}`;
    const srcUsdu = makeToken({
      id: srcUsduIdHex,
      fixture: rewriteFixtureTokenId(TOKEN_A, srcUsduIdHex),
    });
    const srcUsdc = makeToken({
      id: srcUsdcIdHex,
      fixture: rewriteFixtureTokenId(TOKEN_A, srcUsdcIdHex),
    });

    // USDU = 1000 in srcUsdu; USDC = 1000 in srcUsdc.
    const projection = (token: Token): TokenLike => {
      if (token.id === srcUsdu.id) {
        return { id: token.id, coins: [{ coinId: 'USDU', amount: 1000n }] };
      }
      return { id: token.id, coins: [{ coinId: 'USDC', amount: 1000n }] };
    };

    // Recipient gets a fresh child per split — USDU 200 + USDC 100.
    // Use fixtures with the requested per-coin coinData so the
    // OVER_TRANSFER_GUARD's per-coin sum lands at the budget.
    const childUsdu = rewriteFixtureTokenId(
      {
        ...TOKEN_A,
        genesis: {
          ...TOKEN_A.genesis,
          data: { ...TOKEN_A.genesis.data, coinData: [['USDU', '200']] },
        },
      } as typeof TOKEN_A,
      `dd${'1'.padStart(2, '0')}${'0'.repeat(60)}`,
    );
    const childUsdc = rewriteFixtureTokenId(
      {
        ...TOKEN_A,
        genesis: {
          ...TOKEN_A.genesis,
          data: { ...TOKEN_A.genesis.data, coinData: [['USDC', '100']] },
        },
      } as typeof TOKEN_A,
      `dd${'2'.padStart(2, '0')}${'0'.repeat(60)}`,
    );

    let observedSplitSources: ReadonlyArray<{
      readonly token: Token;
      readonly splitAmount: bigint;
      readonly remainderAmount: bigint;
      readonly coinIdHex: string;
    }> | undefined = undefined;

    const commitResults: ConservativeCommitResult[] = [
      {
        sourceTokenId: srcUsdu.id,
        method: 'split',
        requestIdHex: `req-${srcUsdu.id}`,
        recipientTokenJson: childUsdu,
      },
      {
        sourceTokenId: srcUsdc.id,
        method: 'split',
        requestIdHex: `req-${srcUsdc.id}`,
        recipientTokenJson: childUsdc,
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
      availableSources: () => [srcUsdu, srcUsdc],
      selectSources: async () => ({
        directSources: [],
        splitSources: [
          {
            token: srcUsdu,
            splitAmount: 200n,
            remainderAmount: 800n,
            coinIdHex: 'USDU',
          },
          {
            token: srcUsdc,
            splitAmount: 100n,
            remainderAmount: 900n,
            coinIdHex: 'USDC',
          },
        ],
      }),
      preflightOptions: () => ({
        resolveRequestId: () => {
          throw new Error('not invoked');
        },
        extractPendingChain: () => [],
      } satisfies Omit<PreflightFinalizeOptions, 'aggregator'>),
      commitSources: async ({ splitSources }) => {
        observedSplitSources = splitSources;
        return commitResults;
      },
      toTokenLike: projection,
    };

    const request: TransferRequest = {
      recipient: '@bob',
      coinId: 'USDU',
      amount: '200',
      additionalAssets: [{ kind: 'coin', coinId: 'USDC', amount: '100' }],
      transferMode: 'conservative',
      delivery: { kind: 'force-inline' },
    };

    const result = await sendConservativeUxf(request, makePeerInfo(), deps);
    expect(result.status).toBe('completed');

    // Forwarding invariant — both splits land in commitSources.
    expect(observedSplitSources).toBeDefined();
    expect(observedSplitSources).toHaveLength(2);
    expect(observedSplitSources![0].coinIdHex).toBe('USDU');
    expect(observedSplitSources![0].splitAmount).toBe(200n);
    expect(observedSplitSources![0].remainderAmount).toBe(800n);
    expect(observedSplitSources![1].coinIdHex).toBe('USDC');
    expect(observedSplitSources![1].splitAmount).toBe(100n);
    expect(observedSplitSources![1].remainderAmount).toBe(900n);

    // OVER_TRANSFER_GUARD did not fire — both children fit their per-
    // coin budgets exactly.
    expect(events.count('transfer:confirmed')).toBe(1);
    expect(result.tokenTransfers).toHaveLength(2);
  });

  it('rejects duplicate split coinIdHex (planner bug — INVALID_CONFIG)', async () => {
    const src1 = makeToken({
      id: `aa${'9'.padStart(2, '0')}${'0'.repeat(60)}`,
      fixture: rewriteFixtureTokenId(
        TOKEN_A,
        `aa${'9'.padStart(2, '0')}${'0'.repeat(60)}`,
      ),
    });
    const src2 = makeToken({
      id: `bb${'9'.padStart(2, '0')}${'0'.repeat(60)}`,
      fixture: rewriteFixtureTokenId(
        TOKEN_A,
        `bb${'9'.padStart(2, '0')}${'0'.repeat(60)}`,
      ),
    });

    const projection = (token: Token): TokenLike => ({
      id: token.id,
      coins: [{ coinId: 'USDU', amount: 1000n }],
    });

    const transport = makeRecordingTransport();
    const events = makeEventRecorder();
    const deps: ConservativeSenderDeps = {
      aggregator: makeOracleStub(),
      transport,
      identity: makeIdentity(),
      senderTransportPubkey: BOB_TRANSPORT_PUBKEY,
      emit: events.emit,
      availableSources: () => [src1, src2],
      selectSources: async () => ({
        directSources: [],
        // Two split entries claiming the same coinIdHex — a planner
        // bug the orchestrator should fail-closed on.
        splitSources: [
          {
            token: src1,
            splitAmount: 100n,
            remainderAmount: 900n,
            coinIdHex: 'USDU',
          },
          {
            token: src2,
            splitAmount: 200n,
            remainderAmount: 800n,
            coinIdHex: 'USDU',
          },
        ],
      }),
      preflightOptions: () => ({
        resolveRequestId: () => {
          throw new Error('not invoked');
        },
        extractPendingChain: () => [],
      } satisfies Omit<PreflightFinalizeOptions, 'aggregator'>),
      commitSources: async () => {
        throw new Error('commitSources must not be reached for duplicate coinId');
      },
      toTokenLike: projection,
    };

    const request: TransferRequest = {
      recipient: '@bob',
      coinId: 'USDU',
      amount: '100',
      transferMode: 'conservative',
      delivery: { kind: 'force-inline' },
    };

    let caughtCode: string | undefined;
    try {
      await sendConservativeUxf(request, makePeerInfo(), deps);
    } catch (err) {
      caughtCode = (err as { code?: string }).code;
    }
    expect(caughtCode).toBe('INVALID_CONFIG');
    expect(transport._calls).toHaveLength(0);
    expect(events.count('transfer:failed')).toBe(1);
  });

  it('rejects splitSources token overlapping directSources (planner bug — INVALID_CONFIG)', async () => {
    const shared = makeToken({
      id: `dd${'9'.padStart(2, '0')}${'0'.repeat(60)}`,
      fixture: rewriteFixtureTokenId(
        TOKEN_A,
        `dd${'9'.padStart(2, '0')}${'0'.repeat(60)}`,
      ),
    });
    const projection = (token: Token): TokenLike => ({
      id: token.id,
      coins: [{ coinId: 'USDU', amount: 1000n }],
    });

    const transport = makeRecordingTransport();
    const events = makeEventRecorder();
    const deps: ConservativeSenderDeps = {
      aggregator: makeOracleStub(),
      transport,
      identity: makeIdentity(),
      senderTransportPubkey: BOB_TRANSPORT_PUBKEY,
      emit: events.emit,
      availableSources: () => [shared],
      selectSources: async () => ({
        // Same token in BOTH directSources and splitSources — a
        // planner bug the orchestrator should fail-closed on (the
        // source would be both whole-token-transferred AND split-
        // minted, double-spending on-chain).
        directSources: [shared],
        splitSources: [
          {
            token: shared,
            splitAmount: 100n,
            remainderAmount: 900n,
            coinIdHex: 'USDU',
          },
        ],
      }),
      preflightOptions: () => ({
        resolveRequestId: () => {
          throw new Error('not invoked');
        },
        extractPendingChain: () => [],
      } satisfies Omit<PreflightFinalizeOptions, 'aggregator'>),
      commitSources: async () => {
        throw new Error('commitSources must not be reached for overlap');
      },
      toTokenLike: projection,
    };

    const request: TransferRequest = {
      recipient: '@bob',
      coinId: 'USDU',
      amount: '100',
      transferMode: 'conservative',
      delivery: { kind: 'force-inline' },
    };

    let caughtCode: string | undefined;
    try {
      await sendConservativeUxf(request, makePeerInfo(), deps);
    } catch (err) {
      caughtCode = (err as { code?: string }).code;
    }
    expect(caughtCode).toBe('INVALID_CONFIG');
    expect(transport._calls).toHaveLength(0);
  });

  it('mixed directSources + splitSources: 3-coin send (2 split + 1 direct) ships all three', async () => {
    // Spec scenario from #149 acceptance: "3-coin send where 2 of 3
    // need splitting → bundle contains 2 split-mints + 1 direct,
    // recipient receives all 3." Coin A and Coin B require splitting
    // (sources are bigger than requested); Coin C is fully consumed
    // by a whole-token direct transfer.
    const srcAIdHex = `aa${'a'.padStart(2, 'a')}${'0'.repeat(60)}`;
    const srcBIdHex = `bb${'a'.padStart(2, 'a')}${'0'.repeat(60)}`;
    const srcCIdHex = `cc${'a'.padStart(2, 'a')}${'0'.repeat(60)}`;
    const srcA = makeToken({
      id: srcAIdHex,
      fixture: rewriteFixtureTokenId(TOKEN_A, srcAIdHex),
    });
    const srcB = makeToken({
      id: srcBIdHex,
      fixture: rewriteFixtureTokenId(TOKEN_A, srcBIdHex),
    });
    const srcC = makeToken({
      id: srcCIdHex,
      fixture: rewriteFixtureTokenId(TOKEN_A, srcCIdHex),
    });

    const projection = (token: Token): TokenLike => {
      if (token.id === srcA.id) {
        return { id: token.id, coins: [{ coinId: 'COINA', amount: 1000n }] };
      }
      if (token.id === srcB.id) {
        return { id: token.id, coins: [{ coinId: 'COINB', amount: 1000n }] };
      }
      return { id: token.id, coins: [{ coinId: 'COINC', amount: 100n }] };
    };

    // Recipient gets fresh tokens for the splits (200 COINA, 300 COINB)
    // and the whole COINC source.
    const childA = rewriteFixtureTokenId(
      {
        ...TOKEN_A,
        genesis: {
          ...TOKEN_A.genesis,
          data: { ...TOKEN_A.genesis.data, coinData: [['COINA', '200']] },
        },
      } as typeof TOKEN_A,
      `dd${'a'.padStart(2, 'a')}${'0'.repeat(60)}`,
    );
    const childB = rewriteFixtureTokenId(
      {
        ...TOKEN_A,
        genesis: {
          ...TOKEN_A.genesis,
          data: { ...TOKEN_A.genesis.data, coinData: [['COINB', '300']] },
        },
      } as typeof TOKEN_A,
      `dd${'b'.padStart(2, 'b')}${'0'.repeat(60)}`,
    );
    const childC = rewriteFixtureTokenId(
      {
        ...TOKEN_A,
        genesis: {
          ...TOKEN_A.genesis,
          data: { ...TOKEN_A.genesis.data, coinData: [['COINC', '100']] },
        },
      } as typeof TOKEN_A,
      `dd${'c'.padStart(2, 'c')}${'0'.repeat(60)}`,
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
      {
        sourceTokenId: srcC.id,
        method: 'direct',
        requestIdHex: `req-${srcC.id}`,
        recipientTokenJson: childC,
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
      availableSources: () => [srcA, srcB, srcC],
      selectSources: async () => ({
        directSources: [srcC],
        splitSources: [
          {
            token: srcA,
            splitAmount: 200n,
            remainderAmount: 800n,
            coinIdHex: 'COINA',
          },
          {
            token: srcB,
            splitAmount: 300n,
            remainderAmount: 700n,
            coinIdHex: 'COINB',
          },
        ],
      }),
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
      coinId: 'COINA',
      amount: '200',
      additionalAssets: [
        { kind: 'coin', coinId: 'COINB', amount: '300' },
        { kind: 'coin', coinId: 'COINC', amount: '100' },
      ],
      transferMode: 'conservative',
      delivery: { kind: 'force-inline' },
    };

    const result = await sendConservativeUxf(request, makePeerInfo(), deps);
    expect(result.status).toBe('completed');

    // Bundle's payload.tokenIds carries the RECIPIENT genesis tokenIds
    // (one per commit result), lex-sorted. The fixture rewriter set
    // each child's `genesis.data.tokenId` to its `dd*` placeholder id.
    const childAId = `dd${'a'.padStart(2, 'a')}${'0'.repeat(60)}`;
    const childBId = `dd${'b'.padStart(2, 'b')}${'0'.repeat(60)}`;
    const childCId = `dd${'c'.padStart(2, 'c')}${'0'.repeat(60)}`;
    const payload = transport._calls[0].payload as UxfTransferPayloadCar;
    expect([...payload.tokenIds].sort()).toEqual(
      [childAId, childBId, childCId].sort(),
    );
    expect(result.tokenTransfers).toHaveLength(3);
    expect(events.count('transfer:confirmed')).toBe(1);
    // tokenTransfers carries the per-source method:
    //   - COINA, COINB: split (the splitSources entries)
    //   - COINC: direct (the directSources entry)
    const methodsBySrc = new Map(
      result.tokenTransfers.map((t) => [t.sourceTokenId, t.method]),
    );
    expect(methodsBySrc.get(srcA.id)).toBe('split');
    expect(methodsBySrc.get(srcB.id)).toBe('split');
    expect(methodsBySrc.get(srcC.id)).toBe('direct');
    // The OVER_TRANSFER_GUARD passes per-coin: COINA=200, COINB=300,
    // COINC=100 — each matches its per-coin budget exactly.
  });
});
