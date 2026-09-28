import { describe, expect, it, vi } from 'vitest';

import { SpherePaymentData } from '../../../token-engine/SpherePaymentData';
import {
  CborDeserializer,
  CborSerializer,
  type CertifiedMintTransaction,
  type IMintJustificationVerifier,
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
});
