import { describe, expect, it } from 'vitest';

import { createSphereTokenEngine } from '../../../token-engine/factory';
import {
  CborSerializer,
  type IMintJustificationVerifier,
  MintJustificationVerifierService,
  MintTransaction,
  NetworkId,
  SignaturePredicate,
  SigningService,
  TokenSalt,
  TokenType,
  VerificationResult,
  VerificationStatus,
} from '../../../token-engine/sdk';
import { SpherePaymentData, spherePaymentAmountExtractor } from '../../../token-engine/SpherePaymentData';
import { HexConverter } from '../../../token-engine/sdk';

// Single-node trust base — parses fine, no network is touched.
const TRUST_BASE_JSON = {
  changeRecordHash: null,
  epoch: '0',
  epochStartRound: '0',
  networkId: 3,
  previousEntryHash: null,
  quorumThreshold: '1',
  rootNodes: [{ nodeId: 'NODE', sigKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', stake: '1' }],
  signatures: {},
  stateHash: '00',
  version: '0',
};

const BRIDGE_TAG = 1330002n;

function fakeBridgeVerifier(tag: bigint, status: VerificationStatus): IMintJustificationVerifier {
  return {
    get tag() {
      return tag;
    },
    async verify() {
      return new VerificationResult('FakeBridgeVerifier', status);
    },
  };
}

async function makeMintWithJustificationTag(tag: bigint): Promise<MintTransaction> {
  const recipient = SignaturePredicate.create(SigningService.generate().publicKey);
  const justification = CborSerializer.encodeTag(tag, CborSerializer.encodeArray());
  return MintTransaction.create(
    NetworkId.fromId(3),
    recipient,
    null,
    TokenType.generate(),
    TokenSalt.generate(),
    justification,
  );
}

describe('bridge plugin wiring (token-engine)', () => {
  it('createSphereTokenEngine registers bridge justification verifiers', async () => {
    const privateKey = SigningService.generatePrivateKey();
    // Two verifiers sharing a tag must collide at registration — proving the
    // factory actually registers config.bridgeJustificationVerifiers.
    await expect(
      createSphereTokenEngine({
        aggregatorUrl: 'https://example.invalid',
        privateKey,
        trustBaseJson: TRUST_BASE_JSON,
        bridgeJustificationVerifiers: [
          fakeBridgeVerifier(BRIDGE_TAG, VerificationStatus.OK),
          fakeBridgeVerifier(BRIDGE_TAG, VerificationStatus.OK),
        ],
      }),
    ).rejects.toThrow(/Duplicate/);

    // A single verifier wires up cleanly.
    const engine = await createSphereTokenEngine({
      aggregatorUrl: 'https://example.invalid',
      privateKey,
      trustBaseJson: TRUST_BASE_JSON,
      bridgeJustificationVerifiers: [fakeBridgeVerifier(BRIDGE_TAG, VerificationStatus.OK)],
    });
    expect(engine).toBeDefined();
  });

  it('works with no bridge verifiers configured', async () => {
    const engine = await createSphereTokenEngine({
      aggregatorUrl: 'https://example.invalid',
      privateKey: SigningService.generatePrivateKey(),
      trustBaseJson: TRUST_BASE_JSON,
    });
    expect(engine).toBeDefined();
  });

  it('a registered verifier is dispatched by the justification CBOR tag', async () => {
    const service = new MintJustificationVerifierService();
    service.register(fakeBridgeVerifier(BRIDGE_TAG, VerificationStatus.OK));

    const mint = await makeMintWithJustificationTag(BRIDGE_TAG);
    // service.verify only reads `.justification`; a MintTransaction suffices.
    const result = await service.verify(mint as unknown as Parameters<typeof service.verify>[0]);
    expect(result.status).toBe(VerificationStatus.OK);

    // An unregistered tag is rejected (unknown asset → not silently accepted).
    const other = await makeMintWithJustificationTag(999999n);
    const miss = await service.verify(other as unknown as Parameters<typeof service.verify>[0]);
    expect(miss.status).toBe(VerificationStatus.FAIL);
  });
});

describe('spherePaymentAmountExtractor', () => {
  const coinHex = 'ab'.repeat(32);
  const coinBytes = HexConverter.decode(coinHex);

  it('returns the declared amount for the coin', async () => {
    const data = await SpherePaymentData.fromValue({ assets: [{ coinId: coinHex, amount: 1_000_000n }] }).encode();
    expect(spherePaymentAmountExtractor(data, coinBytes)).toBe(1_000_000n);
  });

  it('returns null for a coin the token does not carry', async () => {
    const data = await SpherePaymentData.fromValue({ assets: [{ coinId: 'cd'.repeat(32), amount: 5n }] }).encode();
    expect(spherePaymentAmountExtractor(data, coinBytes)).toBeNull();
  });

  it('returns null for null/garbage data', () => {
    expect(spherePaymentAmountExtractor(null, coinBytes)).toBeNull();
    expect(spherePaymentAmountExtractor(new Uint8Array([1, 2, 3]), coinBytes)).toBeNull();
  });
});
