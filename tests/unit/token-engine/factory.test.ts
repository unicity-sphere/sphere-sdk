import { describe, expect, it, vi } from 'vitest';

import { createSphereTokenEngine } from '../../../token-engine/factory';
import { SigningService } from '../../../token-engine/sdk';
import { logger } from '../../../core/logger';

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
