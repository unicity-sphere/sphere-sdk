import { describe, expect, it, vi } from 'vitest';

import { MintReasonRegistry } from '../../../token-engine/mint-reasons';
import {
  CborSerializer,
  type CertifiedMintTransaction,
  type IMintJustificationVerifier,
  VerificationResult,
  VerificationStatus,
} from '../../../token-engine/sdk';
import { createTestEngine } from './test-engine';

const TAG = 1330002n;
const OTHER_TAG = 1330010n;

function reason(tag: bigint): Uint8Array {
  return CborSerializer.encodeTag(tag, CborSerializer.encodeUnsignedInteger(1n));
}

function verifier(tag: bigint, status: VerificationStatus): IMintJustificationVerifier {
  return { tag, verify: vi.fn(async () => new VerificationResult('Plugin', status)) };
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
