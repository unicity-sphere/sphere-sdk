import { describe, expect, it, vi } from 'vitest';

import { MintReasonRegistry } from '../../../token-engine/mint-reasons';
import {
  CborSerializer,
  type CertifiedMintTransaction,
  type IMintJustificationVerifier,
  VerificationResult,
  VerificationStatus,
} from '../../../token-engine/sdk';
import { TestAggregatorClient } from './support/TestAggregatorClient';
import { createTestEngine } from './test-engine';

const TAG = 1330002n;
const OTHER_TAG = 1330010n;

function reason(tag: bigint): Uint8Array {
  return CborSerializer.encodeTag(tag, CborSerializer.encodeUnsignedInteger(1n));
}

function verifier(tag: bigint, status: VerificationStatus): IMintJustificationVerifier {
  return { tag, verify: vi.fn(async () => new VerificationResult('Plugin', status)) };
}

function throwing(tag: bigint): IMintJustificationVerifier {
  return { tag, verify: vi.fn(async () => Promise.reject(new Error('source chain RPC 503'))) };
}

function mintOf(justification: Uint8Array): CertifiedMintTransaction {
  return { justification } as unknown as CertifiedMintTransaction;
}

const DATA = new TextEncoder().encode('bridged');
const TYPE = new Uint8Array(32).fill(0x6f);

describe('MintReasonRegistry', () => {
  it('an overlay replaces the verifiers of the tags it names and keeps every other registered tag', async () => {
    const registered = verifier(TAG, VerificationStatus.FAIL);
    const other = verifier(OTHER_TAG, VerificationStatus.OK);
    const perCall = verifier(TAG, VerificationStatus.OK);
    const registry = new MintReasonRegistry().register(registered).register(other);

    const overlay = registry.overlaid([perCall]);

    expect((await overlay.verify(mintOf(reason(TAG)), () => undefined)).status).toBe(VerificationStatus.OK);
    expect((await overlay.verify(mintOf(reason(OTHER_TAG)), () => undefined)).status).toBe(VerificationStatus.OK);
    expect(registered.verify).not.toHaveBeenCalled();
    expect((await registry.verify(mintOf(reason(TAG)), () => undefined)).status).toBe(VerificationStatus.FAIL);
  });

  it('a plugin verifier that throws makes the reason not verifiable yet (a throw), while its FAIL stays a FAIL', async () => {
    const registry = new MintReasonRegistry().registerPlugin(throwing(TAG)).registerPlugin(verifier(OTHER_TAG, VerificationStatus.FAIL));

    await expect(registry.verify(mintOf(reason(TAG)), () => undefined)).rejects.toMatchObject({ code: 'MINT_REASON_UNVERIFIABLE' });
    expect((await registry.verify(mintOf(reason(OTHER_TAG)), () => undefined)).status).toBe(VerificationStatus.FAIL);
  });

  it('a reason tag with no registered verifier is not verifiable yet on this wallet, never a FAIL', async () => {
    const registry = new MintReasonRegistry().registerPlugin(verifier(TAG, VerificationStatus.OK));

    await expect(registry.verify(mintOf(reason(OTHER_TAG)), () => undefined)).rejects.toMatchObject({ code: 'MINT_REASON_UNVERIFIABLE' });
  });

  it('a built-in verifier that throws is still the SDK FAIL, and an overlay keeps plugin semantics for the tags it replaces', async () => {
    const registry = new MintReasonRegistry().register(throwing(TAG)).registerPlugin(verifier(OTHER_TAG, VerificationStatus.OK));

    expect((await registry.verify(mintOf(reason(TAG)), () => undefined)).status).toBe(VerificationStatus.FAIL);
    await expect(registry.overlaid([throwing(TAG)]).verify(mintOf(reason(TAG)), () => undefined)).rejects.toMatchObject({
      code: 'MINT_REASON_UNVERIFIABLE',
    });
  });

  it('an overlay refuses a per-call verifier for a tag the engine does not register: its replay could never verify', () => {
    const registry = new MintReasonRegistry().register(verifier(TAG, VerificationStatus.OK));

    expect(() => registry.overlaid([verifier(OTHER_TAG, VerificationStatus.OK)])).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });
});

describe('SphereTokenEngine — mint reasons', () => {
  it('mints under the per-call verifier where the registered one would refuse, and refuses under the registered one alone', async () => {
    const e = createTestEngine({ mintReasonVerifiers: [verifier(TAG, VerificationStatus.FAIL)] });
    const recipientPubkey = e.getIdentity().chainPubkey;
    const params = { recipientPubkey, data: DATA, tokenType: TYPE, justification: reason(TAG) };

    const minted = await e.mintDataToken({ ...params, salt: new Uint8Array(32).fill(1), mintJustificationVerifiers: [verifier(TAG, VerificationStatus.OK)] });
    expect(e.readTokenJustification(minted)).toEqual(reason(TAG));
    await expect(e.mintDataToken({ ...params, salt: new Uint8Array(32).fill(2) })).rejects.toThrow();
  });

  it('verify throws, instead of answering not-ok, when a plugin cannot answer yet or no plugin handles the reason', async () => {
    const aggregator = TestAggregatorClient.create();
    const minter = createTestEngine({ aggregator, mintReasonVerifiers: [verifier(TAG, VerificationStatus.OK)] });
    const token = await minter.mintDataToken({
      recipientPubkey: minter.getIdentity().chainPubkey,
      data: DATA,
      tokenType: TYPE,
      salt: new Uint8Array(32).fill(3),
      justification: reason(TAG),
    });
    const lagging = createTestEngine({ aggregator: aggregator, mintReasonVerifiers: [throwing(TAG)] });
    const unaware = createTestEngine({ aggregator: aggregator });
    const refusing = createTestEngine({ aggregator: aggregator, mintReasonVerifiers: [verifier(TAG, VerificationStatus.FAIL)] });

    await expect(lagging.verify(token)).rejects.toMatchObject({ code: 'MINT_REASON_UNVERIFIABLE' });
    await expect(unaware.verify(token)).rejects.toMatchObject({ code: 'MINT_REASON_UNVERIFIABLE' });
    await expect(refusing.verify(token)).resolves.toMatchObject({ ok: false });
    await expect(minter.verify(token)).resolves.toEqual({ ok: true });
  });

  it('assertMintable refuses a reason tag or a per-call verifier the engine has no verifier for, and an empty reason', () => {
    const e = createTestEngine({ mintReasonVerifiers: [verifier(TAG, VerificationStatus.OK)] });
    const base = { recipientPubkey: e.getIdentity().chainPubkey, data: DATA, tokenType: TYPE };

    expect(() => e.assertMintable({ ...base, justification: reason(TAG) })).not.toThrow();
    for (const params of [
      { ...base, justification: reason(OTHER_TAG) },
      { ...base, justification: new Uint8Array(0) },
      { ...base, justification: reason(TAG), mintJustificationVerifiers: [verifier(OTHER_TAG, VerificationStatus.OK)] },
    ]) {
      expect(() => e.assertMintable(params)).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    }
  });
});
