/**
 * Self-issued Unicity ID (nametag) token mint — token-engine/unicity-id.ts —
 * over the in-memory TestAggregatorClient (same harness as the real engine).
 */
import { describe, expect, it } from 'vitest';

import {
  PredicateVerifierService,
  SigningService,
  StateTransitionClient,
  UnicityId,
  UnicityIdToken,
  HexConverter,
} from '../../../token-engine/sdk';
import {
  createUnicityIdMinterFromDeps,
  type UnicityIdMinterDeps,
} from '../../../token-engine/unicity-id';
import { TestAggregatorClient } from './support/TestAggregatorClient';

function createHarness(privateKey?: Uint8Array): { deps: UnicityIdMinterDeps; aggregator: TestAggregatorClient } {
  const aggregator = TestAggregatorClient.create();
  const deps: UnicityIdMinterDeps = {
    client: new StateTransitionClient(aggregator),
    trustBase: aggregator.rootTrustBase,
    predicateVerifier: PredicateVerifierService.create(),
    signingService: new SigningService(privateKey ?? SigningService.generatePrivateKey()),
  };
  return { deps, aggregator };
}

describe('UnicityIdMinter (self-issued, in-memory aggregator)', () => {
  it('mints a UnicityIdToken whose id derives from the name', async () => {
    const { deps } = createHarness();
    const minter = createUnicityIdMinterFromDeps(deps);

    const result = await minter.mintUnicityIdToken('alice');

    expect(result.tokenId).toMatch(/^[0-9a-f]{64}$/);
    const expectedId = await new UnicityId('alice').toTokenId();
    expect(result.tokenId).toBe(HexConverter.encode(expectedId.bytes));
  }, 15000);

  it('the stored CBOR round-trips and verifies against the trust base (issuer = self)', async () => {
    const { deps } = createHarness();
    const minter = createUnicityIdMinterFromDeps(deps);

    const { tokenCborHex } = await minter.mintUnicityIdToken('bob');

    const token = await UnicityIdToken.fromCBOR(HexConverter.decode(tokenCborHex));
    const verdict = await token.verify(deps.trustBase, deps.predicateVerifier, deps.signingService.publicKey);
    expect(verdict.status).toBeDefined();
    // UnicityIdToken.mint already verified the genesis on the local-mint path;
    // re-verifying with the issuer pin (our own key) must also pass.
    expect(String(verdict.status)).toBe('OK');
  }, 15000);

  it('re-mint of the same name by the same wallet is idempotent (same bytes)', async () => {
    const key = SigningService.generatePrivateKey();
    const { deps } = createHarness(key);
    const minter = createUnicityIdMinterFromDeps(deps);

    const first = await minter.mintUnicityIdToken('carol');
    const second = await minter.mintUnicityIdToken('carol');

    expect(second.tokenId).toBe(first.tokenId);
    expect(second.tokenCborHex).toBe(first.tokenCborHex);
  }, 15000);

  it('different names yield different token ids; same name from different wallets coexists (per-issuer uniqueness)', async () => {
    const { deps: a } = createHarness();
    const { deps: b } = createHarness();
    const minterA = createUnicityIdMinterFromDeps(a);
    const minterB = createUnicityIdMinterFromDeps(b);

    const alice = await minterA.mintUnicityIdToken('alice');
    const dave = await minterA.mintUnicityIdToken('dave');
    expect(dave.tokenId).not.toBe(alice.tokenId);

    // Self-issued claims are per-issuer: another wallet can mint the same name
    // on-chain (different lock script → different StateId). Global uniqueness
    // stays with the Nostr binding — documented behavior, locked here.
    const aliceB = await minterB.mintUnicityIdToken('alice');
    expect(aliceB.tokenId).toBe(alice.tokenId); // same name → same token id
    expect(aliceB.tokenCborHex).not.toBe(alice.tokenCborHex); // different issuer/owner
  }, 15000);
});
