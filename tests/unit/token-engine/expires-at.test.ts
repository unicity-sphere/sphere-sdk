/**
 * The v3 request-deadline policy and the money doctrine resting on it.
 *
 * `expiresAt` is hashed into the transaction but is NOT part of the StateId, so
 * two attempts that disagree about it address the SAME leaf with DIFFERENT
 * hashes. That is why the engine never sets one, and why the two new
 * time-dependent submit statuses are not clean rejects.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  type CertificationData,
  type CertificationResponse,
  HexConverter,
  type IAggregatorClient,
  type InclusionProofResponse,
  MintTransaction,
  NetworkId,
  SignaturePredicate,
  SigningService,
  StateId,
  TokenSalt,
  TokenType,
} from '../../../token-engine/sdk';
import { ProofUnconfirmedError } from '../../../token-engine/errors';
import { TestAggregatorClient } from './support/TestAggregatorClient';
import { createTestEngine, freshPubkey } from './test-engine';

const COIN = 'a'.repeat(64);
const TRANSFER_ID = '11111111-2222-4333-8444-555555555555';

/** Answers a fixed submit status, then fails the proof fetch: the classification probe. */
function statusThenNoProof(status: string): IAggregatorClient {
  return {
    submitCertificationRequest: () => Promise.resolve({ status } as unknown as CertificationResponse),
    getInclusionProof: () => Promise.reject(new Error('proof fetch failed (transient)')),
  } as unknown as IAggregatorClient;
}

describe('v3 request deadlines (expiresAt)', () => {
  it('sphere never sets a deadline on ANY certification request it submits', async () => {
    const aggregator = TestAggregatorClient.create();
    const engine = createTestEngine({ aggregator, wireClient: aggregator });
    const self = engine.getIdentity().chainPubkey;

    const src = await engine.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN, amount: 900n }] } });
    await engine.mintDataToken({ recipientPubkey: self, data: new TextEncoder().encode('note') });
    await engine.transfer({ token: src, recipientPubkey: freshPubkey() });
    const funded = await engine.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN, amount: 900n }] } });
    await engine.split({
      token: funded,
      outputs: [
        { recipientPubkey: freshPubkey(), coinId: COIN, amount: 400n },
        { recipientPubkey: self, coinId: COIN, amount: 500n },
      ],
    });

    // Covers the split BURN and every split mint leg too — they all go through here.
    expect(aggregator.certified.length).toBeGreaterThan(5);
    for (const request of aggregator.certified) {
      expect(request.expiresAt).toBeNull();
    }
  }, 30000);

  it('a mint and a transfer both leave the deadline unset on the token itself', async () => {
    const engine = createTestEngine();
    const self = engine.getIdentity().chainPubkey;
    const minted = await engine.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN, amount: 5n }] } });
    expect(minted.sdkToken.genesis.expiresAt).toBeNull();

    const moved = await engine.transfer({ token: minted, recipientPubkey: freshPubkey() });
    expect(moved.sdkToken.latestTransaction.expiresAt).toBeNull();
  }, 20000);

  it('a 24-hour clock jump between two attempts rebuilds the byte-identical transfer', async () => {
    const aggregator = TestAggregatorClient.create();
    const engine = createTestEngine({ aggregator, wireClient: aggregator });
    const self = engine.getIdentity().chainPubkey;
    const src = await engine.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN, amount: 7n }] } });
    const recipient = freshPubkey();

    const first = await engine.transfer({ token: src, recipientPubkey: recipient }, { transferId: TRANSFER_ID });

    // The wallet sleeps a day and resumes. A deadline read off this clock would
    // change the transaction hash and make our own certified spend look foreign.
    const realNow = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(realNow + 24 * 60 * 60 * 1000);
    try {
      const resumed = await engine.transfer({ token: src, recipientPubkey: recipient }, { transferId: TRANSFER_ID });
      expect(HexConverter.encode(resumed.blob.token)).toBe(HexConverter.encode(first.blob.token));
    } finally {
      clock.mockRestore();
    }
  }, 20000);

  it('two transactions differing ONLY in the deadline share a stateId but not a transaction hash', async () => {
    const recipient = SignaturePredicate.create(new SigningService(SigningService.generatePrivateKey()).publicKey);
    const shared = {
      tokenType: new TokenType(Uint8Array.from(Buffer.from('11'.repeat(32), 'hex'))),
      salt: TokenSalt.fromBytes(Uint8Array.from(Buffer.from('22'.repeat(32), 'hex'))),
    };
    const withoutDeadline = await MintTransaction.create(NetworkId.LOCAL, recipient, shared);
    const withDeadline = await MintTransaction.create(NetworkId.LOCAL, recipient, {
      ...shared,
      expiresAt: 1_900_000_000n,
    });

    const idA = await StateId.fromTransaction(withoutDeadline);
    const idB = await StateId.fromTransaction(withDeadline);
    expect(HexConverter.encode(idB.data)).toBe(HexConverter.encode(idA.data));

    const hashA = await withoutDeadline.calculateTransactionHash();
    const hashB = await withDeadline.calculateTransactionHash();
    expect(HexConverter.encode(hashB.data)).not.toBe(HexConverter.encode(hashA.data));
  });

  it('REQUEST_EXPIRED is NOT a clean reject — it never proves no earlier attempt certified', async () => {
    const engine = createTestEngine({ wireClient: statusThenNoProof('REQUEST_EXPIRED'), proofTimeoutMs: 400 });
    await expect(
      engine.mint({ recipientPubkey: engine.getIdentity().chainPubkey, value: { assets: [{ coinId: COIN, amount: 1n }] } }),
    ).rejects.toBeInstanceOf(ProofUnconfirmedError);
  });

  it('a gateway stuck on SERVICE_NOT_READY ends keep-open, never a clean abort', async () => {
    const engine = createTestEngine({
      wireClient: statusThenNoProof('SERVICE_NOT_READY'),
      proofTimeoutMs: 400,
      proofPollIntervalMs: 50,
    });
    await expect(
      engine.mint({ recipientPubkey: engine.getIdentity().chainPubkey, value: { assets: [{ coinId: COIN, amount: 1n }] } }),
    ).rejects.toBeInstanceOf(ProofUnconfirmedError);
  });

  it('a gateway that answers SERVICE_NOT_READY while booting is retried, not written off', async () => {
    const aggregator = TestAggregatorClient.create();
    let booting = 2;
    const wireClient = {
      submitCertificationRequest: (data: CertificationData): Promise<CertificationResponse> => {
        if (booting-- > 0) {
          return Promise.resolve({ status: 'SERVICE_NOT_READY' } as unknown as CertificationResponse);
        }
        return aggregator.submitCertificationRequest(data);
      },
      getInclusionProof: (stateId: StateId): Promise<InclusionProofResponse> => aggregator.getInclusionProof(stateId),
    } as unknown as IAggregatorClient;

    const engine = createTestEngine({ aggregator, wireClient, proofPollIntervalMs: 20 });
    const minted = await engine.mint({
      recipientPubkey: engine.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 3n }] },
    });
    expect(engine.balanceOf(minted, COIN)).toBe(3n);
    expect(booting).toBeLessThanOrEqual(0);
  }, 20000);
});
