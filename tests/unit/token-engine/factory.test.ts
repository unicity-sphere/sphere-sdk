import { describe, expect, it, vi } from 'vitest';

import { createSphereTokenEngine } from '../../../token-engine/factory';
import { NetworkId, SigningService } from '../../../token-engine/sdk';
import { logger } from '../../../core/logger';
import { createTestEngine } from './test-engine';

// Minimal single-node trust base (sigKey = a valid compressed pubkey). Parses fine;
// no network is touched (AggregatorClient connects lazily, on the first request).
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
  version: '1',
};

describe('createSphereTokenEngine', () => {
  it('wires an engine from sphere-domain config (no network)', async () => {
    const privateKey = SigningService.generatePrivateKey();
    const engine = await createSphereTokenEngine({
      aggregatorUrl: 'http://localhost:3000',
      privateKey,
      trustBaseJson: TRUST_BASE_JSON,
    });

    expect(engine.getIdentity().chainPubkey).toEqual(new SigningService(privateKey).publicKey);
    expect(await engine.deriveIdentityAddress()).toMatch(/^DIRECT:\/\//);
  });

  it('takes the network id from the trust base — non-standard ids work (e.g. testnet2 = 4)', async () => {
    const engine = await createSphereTokenEngine({
      aggregatorUrl: 'http://localhost:3000',
      privateKey: SigningService.generatePrivateKey(),
      trustBaseJson: { ...TRUST_BASE_JSON, networkId: 4 },
    });
    // Construction succeeds: NetworkId.fromId(4) is valid; no enum entry needed.
    expect(engine.getIdentity().chainPubkey).toBeInstanceOf(Uint8Array);
  });

  it('the trust base is the SINGLE SOURCE of the network id — a mainnet base yields network 1', async () => {
    // Constructing is not evidence: an engine that ignored the trust base entirely and
    // defaulted to some fixed id would also construct. decodeToken compares the token's
    // genesis network against the engine's (SphereTokenEngine "Token network mismatch"),
    // and does NOT verify proofs — so it reads the derived id offline, against a real
    // token. mainnet = 1 and testnet2 = 4 are the two ids the SDK actually ships against.
    const minted = createTestEngine(); // NetworkId.LOCAL — id 3, which TRUST_BASE_JSON declares
    const blob = minted.encodeToken(
      await minted.mint({
        recipientPubkey: minted.getIdentity().chainPubkey,
        value: { assets: [{ coinId: 'a'.repeat(64), amount: 1n }] },
      }),
    );

    const sameNetwork = await createSphereTokenEngine({
      aggregatorUrl: 'http://localhost:3000',
      privateKey: SigningService.generatePrivateKey(),
      trustBaseJson: TRUST_BASE_JSON,
    });
    await expect(sameNetwork.decodeToken(blob)).resolves.toBeDefined();

    const onMainnet = await createSphereTokenEngine({
      aggregatorUrl: 'http://localhost:3000',
      privateKey: SigningService.generatePrivateKey(),
      trustBaseJson: { ...TRUST_BASE_JSON, networkId: NetworkId.MAINNET.id },
    });
    await expect(onMainnet.decodeToken(blob)).rejects.toThrow(/network 3, engine on 1/);
  }, 30000);

  it('warns when constructed without an apiKey', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await createSphereTokenEngine({
      aggregatorUrl: 'http://localhost:3000',
      privateKey: SigningService.generatePrivateKey(),
      trustBaseJson: TRUST_BASE_JSON,
    });
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[1]).includes('apiKey'))).toBe(true);
    warn.mockRestore();
  });

  it('rejects a config without a trust base', async () => {
    await expect(
      createSphereTokenEngine({
        aggregatorUrl: 'http://localhost:3000',
        privateKey: SigningService.generatePrivateKey(),
        trustBaseJson: null,
      }),
    ).rejects.toThrow();
  });
});
