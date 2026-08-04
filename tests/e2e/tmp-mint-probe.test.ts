// TEMP diagnostic (deleted before handoff): isolate whether the staging mint
// failure is engine-side (gateway) or facade-side (upload/apply path).
import { describe, expect, it } from 'vitest';

import { hexToBytes } from '../../core/crypto';
import { createSphereTokenEngine } from '../../token-engine/factory';
import { HARNESS_COIN, randomIdentity } from '../harness/support/stack';

const API_KEY = process.env.STAGING_AGGREGATOR_KEY;
const RUN = API_KEY !== undefined && API_KEY !== '';
const AGGREGATOR_URL = process.env.STAGING_AGGREGATOR ?? 'https://gateway.testnet2.unicity.network';
const TRUSTBASE_URL =
  process.env.STAGING_TRUSTBASE ??
  'https://raw.githubusercontent.com/unicitynetwork/unicity-ids/main/bft-trustbase.testnet2.json';

describe.runIf(RUN)('TEMP mint probe', () => {
  it('bare engine self-mint against the staging gateway', async () => {
    const identity = randomIdentity();
    const res = await fetch(TRUSTBASE_URL);
    const trustBaseJson = (await res.json()) as unknown;
    const engine = await createSphereTokenEngine({
      aggregatorUrl: AGGREGATOR_URL,
      ...(API_KEY !== undefined && API_KEY !== '' ? { apiKey: API_KEY } : {}),
      privateKey: hexToBytes(identity.privateKey),
      trustBaseJson,
    });
    try {
      const token = await engine.mint({
        recipientPubkey: hexToBytes(identity.chainPubkey),
        value: { assets: [{ coinId: HARNESS_COIN, amount: 123n }] },
      });
      console.log('ENGINE MINT OK', token.blob.tokenId);
      expect(token.blob.tokenId).toMatch(/^[0-9a-f]+$/);
    } catch (err) {
      console.log('ENGINE MINT FAILED:', err);
      throw err;
    }
  }, 120_000);
});
