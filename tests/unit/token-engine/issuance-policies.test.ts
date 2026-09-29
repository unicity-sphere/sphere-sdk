import { describe, expect, it, vi } from 'vitest';

import { createSphereTokenEngine } from '../../../token-engine/factory';
import { SpherePaymentData } from '../../../token-engine/SpherePaymentData';
import {
  CborDeserializer,
  CborSerializer,
  type CertifiedMintTransaction,
  type IMintJustificationVerifier,
  SigningService,
  SplitMintJustification,
  TokenType,
  VerificationResult,
  VerificationStatus,
} from '../../../token-engine/sdk';
import type { TokenIssuancePolicy } from '../../../token-engine/types';
import { TestAggregatorClient } from './support/TestAggregatorClient';
import { createTestEngine } from './test-engine';

const LOCK_TAG = 1330002n;
const TYPE = new Uint8Array(32).fill(0x6f);
const COIN = 'ab'.repeat(32);

function lockReason(): Uint8Array {
  return CborSerializer.encodeTag(LOCK_TAG, CborSerializer.encodeUnsignedInteger(1n));
}

function acceptingLock(): IMintJustificationVerifier {
  return { tag: LOCK_TAG, verify: vi.fn(async () => new VerificationResult('Lock', VerificationStatus.OK)) };
}

function tagOf(transaction: CertifiedMintTransaction): bigint | null {
  if (!transaction.justification) return null;
  return BigInt(CborDeserializer.decodeTag(transaction.justification).tag);
}

function lockOrSplit(coinIds: readonly string[] = [COIN]): TokenIssuancePolicy {
  return {
    tokenType: new TokenType(TYPE),
    coinIds,
    verify: vi.fn(async (transaction: CertifiedMintTransaction) => {
      const tag = tagOf(transaction);
      const backed = tag === LOCK_TAG || tag === SplitMintJustification.CBOR_TAG;
      return new VerificationResult('Bridged', backed ? VerificationStatus.OK : VerificationStatus.FAIL);
    }),
  };
}

async function valued(amount: bigint): Promise<Uint8Array> {
  return SpherePaymentData.fromValue({ assets: [{ coinId: COIN, amount }] }).encode();
}

describe('SphereTokenEngine — issuance policies', () => {
  it('fails a token of a policed type that was minted without its reason', async () => {
    const aggregator = TestAggregatorClient.create();
    const counterfeiter = createTestEngine({ aggregator });
    const wallet = createTestEngine({ aggregator, mintReasonVerifiers: [acceptingLock()], issuancePolicies: [lockOrSplit()] });
    const counterfeit = await counterfeiter.mintDataToken({
      recipientPubkey: wallet.getIdentity().chainPubkey,
      data: await valued(10n),
      tokenType: TYPE,
      salt: new Uint8Array(32).fill(1),
    });

    await expect(counterfeiter.verify(counterfeit)).resolves.toEqual({ ok: true });
    await expect(wallet.verify(counterfeit)).resolves.toMatchObject({ ok: false });
  });

  it('verifies a policed token minted against its reason, and the outputs of its split', async () => {
    const e = createTestEngine({ mintReasonVerifiers: [acceptingLock()], issuancePolicies: [lockOrSplit()] });
    const self = e.getIdentity().chainPubkey;
    const bridged = await e.mintDataToken({
      recipientPubkey: self,
      data: await valued(10n),
      tokenType: TYPE,
      salt: new Uint8Array(32).fill(2),
      justification: lockReason(),
    });

    const { outputs } = await e.split({
      token: bridged,
      outputs: [
        { recipientPubkey: self, coinId: COIN, amount: 4n },
        { recipientPubkey: self, coinId: COIN, amount: 6n },
      ],
    });

    await expect(e.verify(bridged)).resolves.toEqual({ ok: true });
    for (const output of outputs) {
      expect(output.tokenType).toBe(bridged.tokenType);
      await expect(e.verify(output)).resolves.toEqual({ ok: true });
    }
  });

  it('an engine from the real factory enforces a plugin policy: no reason fails, the lock reason verifies', async () => {
    const aggregator = TestAggregatorClient.create();
    const minter = createTestEngine({ aggregator, mintReasonVerifiers: [acceptingLock()] });
    const wallet = await createSphereTokenEngine({
      aggregatorUrl: 'http://localhost:3000',
      privateKey: SigningService.generatePrivateKey(),
      trustBaseJson: aggregator.rootTrustBase.toJSON(),
      plugins: [{ id: 'bridge', mintJustificationVerifiers: [acceptingLock()], tokenIssuancePolicies: [lockOrSplit()] }],
    });
    const mint = async (salt: number, justification?: Uint8Array) =>
      minter.mintDataToken({
        recipientPubkey: minter.getIdentity().chainPubkey,
        data: await valued(10n),
        tokenType: TYPE,
        salt: new Uint8Array(32).fill(salt),
        ...(justification ? { justification } : {}),
      });

    await expect(wallet.verify(await mint(11))).resolves.toMatchObject({ ok: false });
    await expect(wallet.verify(await mint(12, lockReason()))).resolves.toEqual({ ok: true });
  });

  it('holds a mint with per-call verifiers to the type policy, so a policed type still needs its reason', async () => {
    const e = createTestEngine({ mintReasonVerifiers: [acceptingLock()], issuancePolicies: [lockOrSplit()] });

    await expect(
      e.mintDataToken({
        recipientPubkey: e.getIdentity().chainPubkey,
        data: await valued(10n),
        tokenType: TYPE,
        salt: new Uint8Array(32).fill(13),
        mintJustificationVerifiers: [acceptingLock()],
      }),
    ).rejects.toThrow();
  });

  it('fails the outputs of a split whose source was a policed type minted without its reason', async () => {
    const aggregator = TestAggregatorClient.create();
    const counterfeiter = createTestEngine({ aggregator });
    const wallet = createTestEngine({ aggregator, mintReasonVerifiers: [acceptingLock()], issuancePolicies: [lockOrSplit()] });
    const self = counterfeiter.getIdentity().chainPubkey;
    const counterfeit = await counterfeiter.mintDataToken({
      recipientPubkey: self,
      data: await valued(10n),
      tokenType: TYPE,
      salt: new Uint8Array(32).fill(14),
    });

    const { outputs } = await counterfeiter.split({
      token: counterfeit,
      outputs: [
        { recipientPubkey: self, coinId: COIN, amount: 4n },
        { recipientPubkey: self, coinId: COIN, amount: 6n },
      ],
    });

    for (const output of outputs) {
      expect(output.tokenType).toBe(counterfeit.tokenType);
      await expect(counterfeiter.verify(output)).resolves.toEqual({ ok: true });
      await expect(wallet.verify(output)).resolves.toMatchObject({ ok: false });
    }
  });
});
