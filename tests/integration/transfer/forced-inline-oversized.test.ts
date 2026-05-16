/**
 * §11.2 integration — `delivery: { kind: 'force-inline' }` with an
 * oversized bundle.
 *
 * Spec scenario (§11.2):
 *   "`delivery: { kind: 'force-inline' }` with an oversized bundle →
 *    expect `INLINE_CAR_TOO_LARGE` error."
 *
 * Pipeline under test:
 *   - The conservative-sender invokes `resolveDelivery` with
 *     `force-inline`. The resolver checks `carBytes.length` against
 *     `RELAY_SAFE_CAP_BYTES` (96 KiB) and throws
 *     `INLINE_CAR_TOO_LARGE` when the CAR exceeds it.
 *   - The orchestrator's outer try/catch surfaces the throw, transitions
 *     the working result to `failed`, and emits `transfer:failed`.
 *   - The transport MUST NOT have been called — the resolver fails
 *     BEFORE the publish step.
 *
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';

import {
  sendConservativeUxf,
  type ConservativeCommitResult,
  type ConservativeSenderDeps,
} from '../../../modules/payments/transfer/conservative-sender';
import { RELAY_SAFE_CAP_BYTES } from '../../../modules/payments/transfer/limits';
import type { PreflightFinalizeOptions } from '../../../modules/payments/transfer/preflight-finalize';
import type { TransferRequest } from '../../../types';
import { TOKEN_A } from '../../fixtures/uxf-mock-tokens';

import {
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
// 1. Tests
// =============================================================================

describe('§11.2 — force-inline with an oversized bundle (> RELAY_SAFE_CAP_BYTES)', () => {
  it('throws INLINE_CAR_TOO_LARGE; transport never called; transfer:failed emitted', async () => {
    // Build enough sources so the assembled CAR exceeds 96 KiB. Each
    // TOKEN_A child is roughly ~700 bytes serialized; 200 of them
    // comfortably crosses the 96 KiB ceiling.
    const N = 200;
    const sources = Array.from({ length: N }, (_, i) => {
      const serial = (i + 1).toString(16).padStart(4, '0');
      const idHex = `aa${serial}${'0'.repeat(58)}`;
      const fixture = rewriteFixtureTokenId(TOKEN_A, idHex);
      return { token: makeToken({ id: idHex, fixture }), fixture, idHex };
    });

    const commitResults: ConservativeCommitResult[] = sources.map((s) => ({
      sourceTokenId: s.idHex,
      method: 'direct',
      requestIdHex: `req-${s.idHex}`,
      recipientTokenJson: s.fixture,
    }));

    const transport = makeRecordingTransport();
    const events = makeEventRecorder();
    const deps: ConservativeSenderDeps = {
      aggregator: makeOracleStub(),
      transport,
      identity: makeIdentity(),
      senderTransportPubkey: BOB_TRANSPORT_PUBKEY,
      emit: events.emit,
      availableSources: () => sources.map((s) => s.token),
      selectSources: async () => sources.map((s) => s.token),
      preflightOptions: () => ({
        resolveRequestId: () => {
          throw new Error('not invoked');
        },
        extractPendingChain: () => [],
      } satisfies Omit<PreflightFinalizeOptions, 'aggregator'>),
      commitSources: async () => commitResults,
      toTokenLike: defaultCoinTokenLike,
    };

    const request: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: String(1_000_000 * N),
      transferMode: 'conservative',
      delivery: { kind: 'force-inline' },
    };

    let caughtCode: string | undefined;
    let caughtMessage: string | undefined;
    try {
      await sendConservativeUxf(request, makePeerInfo(), deps);
    } catch (err) {
      caughtCode = (err as { code?: string }).code;
      caughtMessage = (err as Error).message;
    }
    expect(caughtCode).toBe('INLINE_CAR_TOO_LARGE');
    // The error message references the relay-safe ceiling so an
    // operator can correlate the cap with the caller's choice.
    expect(caughtMessage).toContain(String(RELAY_SAFE_CAP_BYTES));

    // Transport was NEVER called — the resolver rejected before the
    // publish step.
    expect(transport._calls).toHaveLength(0);

    // Sender event: `transfer:failed` exactly once, no confirmed.
    expect(events.count('transfer:failed')).toBe(1);
    expect(events.count('transfer:confirmed')).toBe(0);
  });

  it('boundary: bundle just under RELAY_SAFE_CAP_BYTES succeeds force-inline', async () => {
    // Sanity: a 50-token bundle is ~35 KiB — well under the 96 KiB
    // ceiling. force-inline accepts. Confirms the rejection above is
    // size-driven, not a bug.
    const N = 50;
    const sources = Array.from({ length: N }, (_, i) => {
      const serial = (i + 1).toString(16).padStart(4, '0');
      const idHex = `bb${serial}${'0'.repeat(58)}`;
      const fixture = rewriteFixtureTokenId(TOKEN_A, idHex);
      return { token: makeToken({ id: idHex, fixture }), fixture, idHex };
    });

    const commitResults: ConservativeCommitResult[] = sources.map((s) => ({
      sourceTokenId: s.idHex,
      method: 'direct',
      requestIdHex: `req-${s.idHex}`,
      recipientTokenJson: s.fixture,
    }));

    const transport = makeRecordingTransport();
    const events = makeEventRecorder();
    const deps: ConservativeSenderDeps = {
      aggregator: makeOracleStub(),
      transport,
      identity: makeIdentity(),
      senderTransportPubkey: BOB_TRANSPORT_PUBKEY,
      emit: events.emit,
      availableSources: () => sources.map((s) => s.token),
      selectSources: async () => sources.map((s) => s.token),
      preflightOptions: () => ({
        resolveRequestId: () => {
          throw new Error('not invoked');
        },
        extractPendingChain: () => [],
      } satisfies Omit<PreflightFinalizeOptions, 'aggregator'>),
      commitSources: async () => commitResults,
      toTokenLike: defaultCoinTokenLike,
    };

    const request: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: String(1_000_000 * N),
      transferMode: 'conservative',
      delivery: { kind: 'force-inline' },
    };

    const result = await sendConservativeUxf(request, makePeerInfo(), deps);
    expect(result.status).toBe('completed');
    expect(transport._calls).toHaveLength(1);
    expect(events.count('transfer:confirmed')).toBe(1);
  });
});
