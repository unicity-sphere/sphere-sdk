/**
 * §11.2 integration — `delivery: { kind: 'force-cid' }` with a 1-token
 * tiny bundle.
 *
 * Spec scenario (§11.2):
 *   "`delivery: { kind: 'force-cid' }` with a 1-token tiny bundle →
 *    IPFS pin happens (or no-op since the outbox already pinned),
 *    recipient fetches via gateway."
 *
 * Pipeline under test:
 *   - The conservative-sender resolves delivery via `resolveDelivery`,
 *     which for `force-cid` ALWAYS invokes `publishToIpfs` regardless
 *     of CAR size.
 *   - The wire payload is `kind: 'uxf-cid'` (NOT `uxf-car`), with
 *     `bundleCid` populated from the `publishToIpfs` callback's return.
 *   - No `carBase64` is present on the wire — recipient MUST fetch.
 *
 * @packageDocumentation
 */

import { describe, expect, it, vi } from 'vitest';

import {
  sendConservativeUxf,
  type ConservativeCommitResult,
  type ConservativeSenderDeps,
} from '../../../modules/payments/transfer/conservative-sender';
import type {
  PublishToIpfsCallback,
  PublishToIpfsResult,
} from '../../../modules/payments/transfer/delivery-resolver';
import type { PreflightFinalizeOptions } from '../../../modules/payments/transfer/preflight-finalize';
import type { TransferRequest } from '../../../types';
import type {
  UxfTransferPayloadCar,
  UxfTransferPayloadCid,
} from '../../../types/uxf-transfer';
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

describe('§11.2 — force-cid with a tiny 1-token bundle', () => {
  it('publishToIpfs invoked exactly once; wire is uxf-cid (no carBase64)', async () => {
    const idHex = `aa${'1'.padStart(2, '0')}${'0'.repeat(60)}`;
    const fixture = rewriteFixtureTokenId(TOKEN_A, idHex);
    const source = makeToken({ id: idHex, fixture });

    const commitResult: ConservativeCommitResult = {
      sourceTokenId: idHex,
      method: 'direct',
      requestIdHex: `req-${idHex}`,
      recipientTokenJson: fixture,
    };

    // Recording IPFS publisher — captures the CAR bytes the resolver
    // hands it. The "real" IPFS pin would compute the CID by hashing
    // the CAR bytes; we mirror that here so the wire's bundleCid
    // matches the orchestrator's locally-derived bundleCid.
    let pinnedCar: Uint8Array | null = null;
    let pinnedCid: string | null = null;
    const publishToIpfs: PublishToIpfsCallback = vi
      .fn<(carBytes: Uint8Array) => Promise<PublishToIpfsResult>>(
        async (carBytes: Uint8Array): Promise<PublishToIpfsResult> => {
          pinnedCar = carBytes;
          // The orchestrator extracts the bundleCid from the CAR root
          // BEFORE calling resolveDelivery. We must return the SAME
          // CID. Easiest: extract here too. But the orchestrator
          // doesn't pass us the pre-computed CID — we'd have to redo
          // the work. The conservative-sender records the
          // orchestrator-side CID into its outbox + wire envelope; the
          // resolver's `cid` return value is used for the
          // resolveDelivery decision but the wire envelope's bundleCid
          // is whatever the orchestrator already computed. So
          // returning ANY string here is fine — the wire's bundleCid
          // is independent.
          pinnedCid = 'bafy-mock-cid';
          return { cid: 'bafy-mock-cid' };
        },
      );

    const transport = makeRecordingTransport();
    const events = makeEventRecorder();
    const deps: ConservativeSenderDeps = {
      aggregator: makeOracleStub(),
      transport,
      identity: makeIdentity(),
      senderTransportPubkey: BOB_TRANSPORT_PUBKEY,
      emit: events.emit,
      publishToIpfs,
      availableSources: () => [source],
      selectSources: async () => [source],
      preflightOptions: () => ({
        resolveRequestId: () => {
          throw new Error('not invoked');
        },
        extractPendingChain: () => [],
      } satisfies Omit<PreflightFinalizeOptions, 'aggregator'>),
      commitSources: async () => [commitResult],
      toTokenLike: defaultCoinTokenLike,
    };

    const request: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '1000000',
      transferMode: 'conservative',
      delivery: { kind: 'force-cid' },
    };

    const result = await sendConservativeUxf(request, makePeerInfo(), deps);
    expect(result.status).toBe('completed');

    // publishToIpfs invoked exactly once with non-empty CAR bytes.
    expect(publishToIpfs).toHaveBeenCalledTimes(1);
    expect(pinnedCar).not.toBeNull();
    expect(pinnedCar!.byteLength).toBeGreaterThan(0);
    expect(pinnedCid).toBe('bafy-mock-cid');

    // Wire payload: uxf-cid (NOT uxf-car). No `carBase64` field.
    const payload = transport._calls[0].payload as
      | UxfTransferPayloadCar
      | UxfTransferPayloadCid;
    expect(payload.kind).toBe('uxf-cid');
    expect((payload as UxfTransferPayloadCar).carBase64).toBeUndefined();
    expect(payload.bundleCid).toBeDefined();
    expect(payload.bundleCid.length).toBeGreaterThan(0);

    // The bundle is genuinely TINY — the §11.2 acceptance is "1-token
    // tiny bundle". The CAR bytes the publisher saw are well below the
    // 16 KiB inline default cap.
    expect(pinnedCar!.byteLength).toBeLessThan(16 * 1024);

    expect(events.count('transfer:confirmed')).toBe(1);
  });

  it('force-cid without publishToIpfs callback → throws FORCE_CID_NO_PUBLISHER (steelman Wave 3 — privacy hardening)', async () => {
    // **Steelman fix (Wave 3) — force-cid privacy regression hardening.**
    // Earlier behavior was to silently fall back to uxf-car inline
    // delivery for bundles that fit within RELAY_SAFE_CAP_BYTES. That
    // defeated the entire point of force-cid: the caller chose CID
    // because they did NOT want the bundle inlined on the relay
    // (privacy intent — the relay would otherwise see the bundle
    // bytes). The orchestrator now hard-fails with
    // `FORCE_CID_NO_PUBLISHER`. Callers must wire a publisher or pick a
    // different strategy.
    const idHex = `aa${'2'.padStart(2, '0')}${'0'.repeat(60)}`;
    const source = makeToken({
      id: idHex,
      fixture: rewriteFixtureTokenId(TOKEN_A, idHex),
    });

    const transport = makeRecordingTransport();
    const events = makeEventRecorder();
    const deps: ConservativeSenderDeps = {
      aggregator: makeOracleStub(),
      transport,
      identity: makeIdentity(),
      senderTransportPubkey: BOB_TRANSPORT_PUBKEY,
      emit: events.emit,
      // publishToIpfs intentionally omitted → MUST hard-fail rather
      // than silently falling back.
      availableSources: () => [source],
      selectSources: async () => [source],
      preflightOptions: () => ({
        resolveRequestId: () => {
          throw new Error('not invoked');
        },
        extractPendingChain: () => [],
      } satisfies Omit<PreflightFinalizeOptions, 'aggregator'>),
      commitSources: async () => [
        {
          sourceTokenId: idHex,
          method: 'direct',
          requestIdHex: `req-${idHex}`,
          recipientTokenJson: rewriteFixtureTokenId(TOKEN_A, idHex),
        },
      ],
      toTokenLike: defaultCoinTokenLike,
    };

    const request: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '1000000',
      transferMode: 'conservative',
      delivery: { kind: 'force-cid' },
    };

    await expect(
      sendConservativeUxf(request, makePeerInfo(), deps),
    ).rejects.toMatchObject({ code: 'FORCE_CID_NO_PUBLISHER' });

    // No transport call should have been made (we hard-fail at pre-flight).
    expect(transport._calls).toHaveLength(0);
    expect(events.count('transfer:confirmed')).toBe(0);
  });
});
