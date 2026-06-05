import { describe, expect, it } from 'vitest';

import { deriveDirectAddress } from '../../../token-engine/identity';
import {
  MintJustificationVerifierService,
  NetworkId,
  PredicateVerifierService,
  SigningService,
  StateTransitionClient,
} from '../../../token-engine/sdk';
import { type EngineDeps, SphereTokenEngine } from '../../../token-engine/SphereTokenEngine';
import { TestAggregatorClient } from './support/TestAggregatorClient';

const COIN = 'a'.repeat(64);

function makeEngine(): SphereTokenEngine {
  const aggregator = TestAggregatorClient.create();
  const deps: EngineDeps = {
    client: new StateTransitionClient(aggregator),
    trustBase: aggregator.rootTrustBase,
    predicateVerifier: PredicateVerifierService.create(),
    mintJustificationVerifier: new MintJustificationVerifierService(),
    signingService: new SigningService(SigningService.generatePrivateKey()),
    networkId: NetworkId.LOCAL,
  };
  return new SphereTokenEngine(deps);
}

describe('SphereTokenEngine (real adapter, A1+A2) — via in-memory aggregator', () => {
  it('mints a token and reflects its value', async () => {
    const e = makeEngine();
    const token = await e.mint({
      recipientPubkey: e.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 100n }] },
    });
    expect(e.balanceOf(token, COIN)).toBe(100n);
    expect(e.readValue(token)).toEqual({ assets: [{ coinId: COIN, amount: 100n }] });
    expect((await e.verify(token)).ok).toBe(true);
  }, 15000);

  it('mints a value-less token', async () => {
    const e = makeEngine();
    const token = await e.mint({ recipientPubkey: e.getIdentity().chainPubkey });
    expect(e.readValue(token)).toBeNull();
    expect((await e.verify(token)).ok).toBe(true);
  }, 15000);

  it('transfers a self-owned token to a recipient (value preserved, verifies)', async () => {
    const e = makeEngine();
    const src = await e.mint({
      recipientPubkey: e.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 100n }] },
    });
    const recipientPubkey = new SigningService(SigningService.generatePrivateKey()).publicKey;
    const received = await e.transfer({ token: src, recipientPubkey });
    expect(e.balanceOf(received, COIN)).toBe(100n);
    expect((await e.verify(received)).ok).toBe(true);
  }, 15000);

  it('encode → decode round-trips a token', async () => {
    const e = makeEngine();
    const token = await e.mint({
      recipientPubkey: e.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 5n }] },
    });
    const back = await e.decodeToken(e.encodeToken(token));
    expect(e.readValue(back)).toEqual({ assets: [{ coinId: COIN, amount: 5n }] });
    expect((await e.verify(back)).ok).toBe(true);
  }, 15000);

  it('deriveIdentityAddress matches the standalone DIRECT:// helper', async () => {
    const e = makeEngine();
    const pubkey = e.getIdentity().chainPubkey;
    expect(await e.deriveIdentityAddress()).toBe(await deriveDirectAddress(pubkey));
    expect(await e.deriveIdentityAddress(pubkey)).toMatch(/^DIRECT:\/\//);
  });
});
