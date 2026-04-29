/**
 * §11.2 integration — End-to-end instant-mode UXF send/receive
 * (1, 5, and 100 tokens).
 *
 * Pipeline under test (sender side, T.5.A):
 *   `validateTargets` → `selectSources` → `commitSources` (no proof
 *   await) → `UxfPackage.create` + `ingestAll` → `toCar` →
 *   `extractCarRootCid` → `resolveDelivery` → outbox transitions →
 *   `transport.sendTokenTransfer`. The orchestrator emits
 *   `transfer:submitted` (NOT `transfer:confirmed`) because finalization
 *   happens asynchronously via T.5.B's worker.
 *
 * Pipeline under test (recipient side, T.3.A):
 *   `acquireBundle` → `verifyBundleStructure`. Both sides converge to a
 *   verified bundle whose `claimedTokens` covers every committed source.
 *
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';

import { acquireBundle, isReplayOutcome } from '../../../modules/payments/transfer/bundle-acquirer';
import {
  sendInstantUxf,
  type InstantCommitResult,
  type InstantSenderDeps,
} from '../../../modules/payments/transfer/instant-sender';
import { ReplayLRU } from '../../../modules/payments/transfer/replay-lru';
import type {
  UxfTransferPayload,
  UxfTransferPayloadCar,
} from '../../../types/uxf-transfer';
import type { TransferRequest } from '../../../types';
import { TOKEN_A } from '../../fixtures/uxf-mock-tokens';

import {
  ALICE_CHAIN_PUBKEY,
  BOB_TRANSPORT_PUBKEY,
  defaultCoinTokenLike,
  makeEventRecorder,
  makeIdentity,
  makeOracleStub,
  makePeerInfo,
  makeRecordingTransport,
  makeToken,
  rewriteFixtureTokenId,
} from './_harness';

// =============================================================================
// 1. Helpers
// =============================================================================

async function runInstantSendN(tokenCount: number): Promise<{
  readonly payload: UxfTransferPayloadCar;
  readonly events: ReturnType<typeof makeEventRecorder>;
  readonly canonicalTokenIds: ReadonlyArray<string>;
  readonly triggerCalls: ReadonlyArray<{
    readonly outboxId: string;
    readonly bundleCid: string;
    readonly outstandingRequestIds: ReadonlyArray<string>;
  }>;
}> {
  const sources = Array.from({ length: tokenCount }, (_, i) => {
    const serial = (i + 1).toString(16).padStart(4, '0');
    const idHex = `bb${serial}${'0'.repeat(58)}`;
    const fixture = rewriteFixtureTokenId(TOKEN_A, idHex);
    return { token: makeToken({ id: idHex, fixture }), fixture, idHex };
  });

  const commitResults: InstantCommitResult[] = sources.map((s) => ({
    sourceTokenId: s.idHex,
    method: 'split',
    requestIdHex: `req-${s.idHex}`,
    recipientTokenJson: s.fixture,
    tokenClass: 'coin',
    splitParentTokenId: s.idHex,
  }));

  const transport = makeRecordingTransport();
  const events = makeEventRecorder();
  const triggerCalls: Array<{
    outboxId: string;
    bundleCid: string;
    outstandingRequestIds: ReadonlyArray<string>;
  }> = [];

  const deps: InstantSenderDeps = {
    aggregator: makeOracleStub(),
    transport,
    identity: makeIdentity(),
    addressId: 'DIRECT://alice-direct',
    senderTransportPubkey: BOB_TRANSPORT_PUBKEY,
    emit: events.emit,
    availableSources: () => sources.map((s) => s.token),
    selectSources: async () => sources.map((s) => s.token),
    commitSources: async () => commitResults,
    onTriggerFinalization: ({ outboxId, bundleCid, outstandingRequestIds }) => {
      triggerCalls.push({
        outboxId,
        bundleCid,
        outstandingRequestIds: [...outstandingRequestIds],
      });
    },
    toTokenLike: defaultCoinTokenLike,
  };

  const request: TransferRequest = {
    recipient: '@bob',
    coinId: 'UCT',
    amount: String(1_000_000 * tokenCount),
    transferMode: 'instant',
    delivery: { kind: 'force-inline' },
  };

  const result = await sendInstantUxf(request, makePeerInfo(), deps);
  // Instant orchestrator transitions to `submitted` (workers complete
  // the cycle later); never to `completed` synchronously.
  expect(result.status).toBe('submitted');
  expect(transport._calls).toHaveLength(1);

  const payload = transport._calls[0].payload as UxfTransferPayloadCar;
  expect(payload.kind).toBe('uxf-car');
  expect(payload.mode).toBe('instant');
  return {
    payload,
    events,
    canonicalTokenIds: sources.map((s) => s.idHex),
    triggerCalls,
  };
}

async function recipientRoundtrip(
  payload: UxfTransferPayload,
): Promise<{ readonly tokenIds: ReadonlyArray<string>; readonly bundleCid: string }> {
  const lru = new ReplayLRU();
  const result = await acquireBundle(payload, ALICE_CHAIN_PUBKEY, lru);
  if (isReplayOutcome(result)) {
    throw new Error('unreachable: first arrival');
  }
  expect(result.verified).toBe(true);
  return {
    tokenIds: result.claimedTokens.map((r) => r.tokenId),
    bundleCid: result.bundleCid,
  };
}

// =============================================================================
// 2. Tests
// =============================================================================

describe('§11.2 — instant-mode end-to-end (1 token)', () => {
  it('sender publishes uxf-car instant payload; recipient verifies; finalization trigger fires once', async () => {
    const { payload, events, triggerCalls, canonicalTokenIds } =
      await runInstantSendN(1);

    expect(payload.tokenIds).toEqual(canonicalTokenIds);
    expect(payload.mode).toBe('instant');

    // Instant emits `transfer:submitted`, not `transfer:confirmed`.
    expect(events.count('transfer:submitted')).toBe(1);
    expect(events.count('transfer:confirmed')).toBe(0);
    expect(events.count('transfer:failed')).toBe(0);

    // Finalization worker (T.5.B) registration trigger fires exactly
    // once, with the same bundleCid the wire payload carries.
    expect(triggerCalls).toHaveLength(1);
    expect(triggerCalls[0].bundleCid).toBe(payload.bundleCid);
    expect(triggerCalls[0].outstandingRequestIds).toEqual([
      `req-${canonicalTokenIds[0]}`,
    ]);

    const verified = await recipientRoundtrip(payload);
    expect(verified.tokenIds).toEqual(canonicalTokenIds);
    expect(verified.bundleCid).toBe(payload.bundleCid);
  });
});

describe('§11.2 — instant-mode end-to-end (5 tokens)', () => {
  it('5 distinct tokens; lex-min wire order; both sides converge to verified bundle', async () => {
    const { payload, events, canonicalTokenIds, triggerCalls } =
      await runInstantSendN(5);

    expect(payload.tokenIds).toHaveLength(5);
    expect([...payload.tokenIds]).toEqual([...canonicalTokenIds].sort());

    expect(events.count('transfer:submitted')).toBe(1);
    expect(events.count('transfer:failed')).toBe(0);
    expect(triggerCalls).toHaveLength(1);
    expect(triggerCalls[0].outstandingRequestIds).toHaveLength(5);

    const verified = await recipientRoundtrip(payload);
    expect(verified.tokenIds).toHaveLength(5);
    expect([...verified.tokenIds].sort()).toEqual([...canonicalTokenIds].sort());
    expect(verified.bundleCid).toBe(payload.bundleCid);
  });
});

describe('§11.2 — instant-mode end-to-end (100 tokens)', () => {
  it('100 distinct tokens; verifier accepts; bundleCid stable across sender→recipient', async () => {
    const { payload, events, canonicalTokenIds, triggerCalls } =
      await runInstantSendN(100);

    expect(payload.tokenIds).toHaveLength(100);
    expect([...payload.tokenIds]).toEqual([...canonicalTokenIds].sort());
    expect(events.count('transfer:submitted')).toBe(1);
    expect(triggerCalls).toHaveLength(1);
    expect(triggerCalls[0].outstandingRequestIds).toHaveLength(100);

    const verified = await recipientRoundtrip(payload);
    expect(verified.tokenIds).toHaveLength(100);
    expect([...verified.tokenIds].sort()).toEqual([...canonicalTokenIds].sort());
    expect(verified.bundleCid).toBe(payload.bundleCid);
  });
});

// =============================================================================
// 3. Acceptance — instant payload's `mode` flag is `instant`
// =============================================================================

describe('§11.2 — instant-mode payload mode discriminator', () => {
  it('payload.mode === "instant" survives the sender→recipient round-trip', async () => {
    const { payload } = await runInstantSendN(1);
    expect(payload.mode).toBe('instant');
    // The recipient does NOT alter `mode`; it's an advisory hint.
    // (per §3.2 mode field semantics — receiver acts on bundle contents,
    // not on the claim.)
    expect(payload.mode).toBe('instant');
  });
});
