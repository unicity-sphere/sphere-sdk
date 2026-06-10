/**
 * Σ3 — live testnet2 e2e for the v2 token engine.
 *
 * Runs the real sender-driven flows (mint / transfer / split / data-token) against
 * the LIVE testnet2 v2 aggregator. Skipped unless TESTNET2_API_KEY is set, so it
 * never runs in CI / normal `npm run test:e2e` without credentials.
 *
 * Run locally: fill `.env` (see .env.example) then `npm run test:e2e`.
 */

import { describe, expect, it } from 'vitest';

import { createSphereTokenEngine } from '../../token-engine/factory';
import { SigningService } from '../../token-engine/sdk';
import { decodeTokenBlob, encodeTokenBlob } from '../../token-engine/token-blob';
import { bytesToHex, hexToBytes } from '../../core/crypto';

const GATEWAY = process.env.TESTNET2_GATEWAY ?? 'https://gateway.testnet2.unicity.network';
const API_KEY = process.env.TESTNET2_API_KEY;
const TRUSTBASE_URL =
  process.env.TESTNET2_TRUSTBASE_URL ??
  'https://raw.githubusercontent.com/unicitynetwork/unicity-ids/main/bft-trustbase.testnet2.json';

const COIN = 'a'.repeat(64);

async function makeEngine() {
  const trustBaseJson = await (await fetch(TRUSTBASE_URL)).json();
  const privateKey = SigningService.generatePrivateKey();
  return createSphereTokenEngine({ aggregatorUrl: GATEWAY, apiKey: API_KEY, privateKey, trustBaseJson });
}

// Live network — only runs when an API key is present.
describe.runIf(!!API_KEY)('token-engine e2e — live testnet2 (networkId 4)', () => {
  it('mints, transfers, verifies and detects spend against the live aggregator', async () => {
    const engine = await makeEngine();
    const self = engine.getIdentity().chainPubkey;

    const minted = await engine.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN, amount: 100n }] } });
    expect(engine.balanceOf(minted, COIN)).toBe(100n);
    expect((await engine.verify(minted)).ok).toBe(true);
    expect(await engine.isSpent(minted)).toBe(false);

    const recipient = new SigningService(SigningService.generatePrivateKey()).publicKey;
    const sent = await engine.transfer({ token: minted, recipientPubkey: recipient });
    expect(engine.balanceOf(sent, COIN)).toBe(100n);
    expect(engine.tokenId(sent)).toBe(engine.tokenId(minted)); // genesis-stable across transfer
    expect(await engine.isSpent(minted)).toBe(true);
  });

  it('splits a token into value-conserving outputs against the live aggregator', async () => {
    const engine = await makeEngine();
    const self = engine.getIdentity().chainPubkey;
    const src = await engine.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN, amount: 100n }] } });

    const other = new SigningService(SigningService.generatePrivateKey()).publicKey;
    const { outputs } = await engine.split({
      token: src,
      outputs: [
        { recipientPubkey: other, coinId: COIN, amount: 60n },
        { recipientPubkey: self, coinId: COIN, amount: 40n },
      ],
    });
    expect(outputs).toHaveLength(2);
    expect(outputs.reduce((sum, o) => sum + engine.balanceOf(o, COIN), 0n)).toBe(100n);
    expect(await engine.isSpent(src)).toBe(true);
  });

  it('mints a data token (invoice-style) and reads its bytes back', async () => {
    const engine = await makeEngine();
    const self = engine.getIdentity().chainPubkey;
    const data = new TextEncoder().encode(JSON.stringify({ inv: 'sphere-e2e' }));
    // Unique salt per run: the salt → a stable tokenId, so a fixed salt would collide
    // with a previous run's token on the persistent testnet (TRANSACTION_HASH_MISMATCH).
    const salt = crypto.getRandomValues(new Uint8Array(32));

    const t = await engine.mintDataToken({ recipientPubkey: self, data, salt });
    expect(engine.readValue(t)).toBeNull();
    expect(engine.readTokenData(t)).toEqual(data);
    expect(engine.tokenId(t)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('self-mints a top-up token to own identity and round-trips its stored blob', async () => {
    const engine = await makeEngine();
    const self = engine.getIdentity().chainPubkey;

    // Self-mint (the top-up primitive PaymentsModule.mintFungibleToken uses).
    const minted = await engine.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN, amount: 250n }] } });
    expect(engine.balanceOf(minted, COIN)).toBe(250n);
    expect((await engine.verify(minted)).ok).toBe(true);
    expect(await engine.isSpent(minted)).toBe(false);

    // Exactly the wallet's storage codec: blob hex -> decode -> balance preserved.
    const sdkData = bytesToHex(encodeTokenBlob(engine.encodeToken(minted)));
    const restored = await engine.decodeToken(decodeTokenBlob(hexToBytes(sdkData)));
    expect(engine.tokenId(restored)).toBe(engine.tokenId(minted));
    expect(engine.balanceOf(restored, COIN)).toBe(250n);
  });

  it('mints a self-issued Unicity ID token, idempotently, and round-trips its CBOR', async () => {
    const { createUnicityIdMinter } = await import('../../token-engine/unicity-id');
    const { UnicityIdToken, HexConverter, RootTrustBase, PredicateVerifierService } =
      await import('../../token-engine/sdk');

    const trustBaseJson = await (await fetch(TRUSTBASE_URL)).json();
    const privateKey = SigningService.generatePrivateKey();
    const minter = createUnicityIdMinter({ aggregatorUrl: GATEWAY, apiKey: API_KEY, privateKey, trustBaseJson });

    // Random name per run (the testnet is persistent; the mint is deterministic
    // per (name, key), so a fixed name + fresh key is also fine — random keeps logs tidy).
    const name = `e2e-${Math.random().toString(36).slice(2, 10)}`;

    const first = await minter.mintUnicityIdToken(name);
    expect(first.tokenId).toMatch(/^[0-9a-f]{64}$/);

    // Idempotent re-mint: identical bytes (the lost-storage recovery path).
    const second = await minter.mintUnicityIdToken(name);
    expect(second.tokenCborHex).toBe(first.tokenCborHex);

    // Stored form round-trips and verifies against the live trust base with the self issuer pin.
    const token = await UnicityIdToken.fromCBOR(HexConverter.decode(first.tokenCborHex));
    const trustBase = RootTrustBase.fromJSON(trustBaseJson);
    const verdict = await token.verify(
      trustBase,
      PredicateVerifierService.create(),
      new SigningService(privateKey).publicKey,
    );
    expect(String(verdict.status)).toBe('OK');
  });
});
