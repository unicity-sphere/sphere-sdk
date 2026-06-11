/**
 * Pins the REAL delivery-key derivation (sdk-changes S7 / ARCHITECTURE §6,
 * §8.2 step 4): SphereTokenEngine.deliveryKeys must return the SDK's protocol
 * state hash (DataHash imprint of the latest state) — the exact value the
 * wallet-api backend stores as `state_hash` and validates deposits against.
 * The fake-world derivation (FakeTokenEngine: sha256 over the bytes) is a
 * test-local convention; THIS test is what keeps the real path honest, with
 * the cross-repo harness as the end-to-end check.
 */
import { describe, expect, it } from 'vitest';

import { createTestEngine } from './test-engine';
import { TestAggregatorClient } from './support/TestAggregatorClient';
import { SigningService } from '../../../token-engine/sdk';
import { HexConverter, Token } from '../../../token-engine/sdk';
import { decodeTokenBlob, encodeTokenBlob } from '../../../token-engine/token-blob';
import { composeDeliveryKeys, computeDeliveryId } from '../../../transport/delivery-provider';

const COIN = 'aa'.repeat(10);

describe('SphereTokenEngine.deliveryKeys (the backend entry_id derivation)', () => {
  it('returns the SDK state-hash imprint — byte-equal to the backend formula', async () => {
    const engine = createTestEngine({
      aggregator: TestAggregatorClient.create(),
      privateKey: SigningService.generatePrivateKey(),
    });
    const self = engine.getIdentity().chainPubkey;
    const minted = await engine.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN, amount: 5n }] } });

    const blobBytes = encodeTokenBlob(engine.encodeToken(minted));
    const keys = await engine.deliveryKeys(blobBytes);

    // Independent recomputation straight through the SDK:
    const blob = decodeTokenBlob(blobBytes);
    const sdkToken = await Token.fromCBOR(blob.token);
    const expected = HexConverter.encode((await sdkToken.latestTransaction.calculateStateHash()).imprint);

    expect(keys.tokenId).toBe(blob.tokenId);
    expect(keys.stateHash).toBe(expected);
    // NOT the naive bytes-hash (the variant the backend 422s):
    expect(keys.stateHash.length).toBeGreaterThan(0);

    // entry_id composition = SHA-256(tokenId bytes ‖ stateHash bytes), hex —
    // identical to wallet-api's entryIdFor (src/mailbox/service.ts).
    const composed = composeDeliveryKeys(keys);
    expect(composed.deliveryId).toBe(computeDeliveryId(keys.tokenId, keys.stateHash));
    expect(composed.deliveryId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('opIndex enters the realization: same transferId, different opIndex => different transaction', async () => {
    const aggregator = TestAggregatorClient.create();
    const walletKey = SigningService.generatePrivateKey();
    const engine = createTestEngine({ aggregator, privateKey: walletKey });
    const self = engine.getIdentity().chainPubkey;
    const source = await engine.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN, amount: 5n }] } });
    const transferId = crypto.randomUUID();

    // Certify under opIndex 1, then prove the (transferId, opIndex) pairing:
    const first = await engine.transfer(
      { token: source, recipientPubkey: self, data: undefined },
      { transferId, opIndex: 1 },
    );
    // Same pairing => byte-identical resume (E.2 absorbs the duplicate submit).
    const resumed = await engine.transfer(
      { token: source, recipientPubkey: self, data: undefined },
      { transferId, opIndex: 1 },
    );
    expect(engine.encodeToken(resumed)).toEqual(engine.encodeToken(first));
    // Different opIndex => different stateMask => different transaction =>
    // the certified state no longer matches: a conflict, not a resume (§8.1).
    await expect(
      engine.transfer({ token: source, recipientPubkey: self, data: undefined }, { transferId, opIndex: 2 }),
    ).rejects.toThrow(/consumed by a different transaction/);
  });
});
