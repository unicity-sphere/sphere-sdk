/**
 * VaultApiClient auth (Task 6.1, DESIGN §4) against the in-process fake server.
 *
 * Asserts the client VERIFIES the challenge template BEFORE signing it (the spend
 * key never signs arbitrary server text), that `authenticate()` yields a usable
 * JWT, and that concurrent 401s collapse to ONE in-flight refresh promise (no
 * double-rotate → no spurious reuse-revoke).
 */

import { describe, it, expect } from 'vitest';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { VaultApiClient } from '../../../storage/remote/VaultApiClient';
import { FakeVaultServer } from '../../helpers/fake-vault-server';
import type {
  AuthTokens,
  ChallengeResponse,
  VaultAuthHttpClient,
  VerifyRequest,
} from '../../../storage/remote/types';

const NETWORK = 'testnet2';
const PRIV = '7c'.repeat(32);
const PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(PRIV), true));

function makeClient(auth: VaultAuthHttpClient, network = NETWORK): VaultApiClient {
  return new VaultApiClient({
    network,
    chainPubkey: PUB,
    privateKey: PRIV,
    deviceId: 'device-1',
    authClient: auth,
  });
}

describe('VaultApiClient — challenge template verification', () => {
  it('authenticates and yields a JWT over a faithful challenge', async () => {
    const server = new FakeVaultServer(NETWORK);
    const client = makeClient(server.authClient());
    const jwt = await client.authenticate();
    expect(typeof jwt).toBe('string');
    expect(jwt.length).toBeGreaterThan(0);
    // The server only issues a JWT if the signature recovered to PUB over the
    // exact challenge — proving the client signed the server's literal.
    expect(server.calls.verify).toHaveLength(1);
    expect(server.calls.verify[0].deviceId).toBe('device-1');
  });

  it('REJECTS a challenge missing the auth prefix (never signs arbitrary text)', async () => {
    const server = new FakeVaultServer(NETWORK);
    const auth = tamperedAuth(server.authClient(), (c) => ({ ...c, challenge: c.challenge.slice(20) }));
    const client = makeClient(auth);
    await expect(client.authenticate()).rejects.toThrow(/challenge/i);
    expect(auth.verifyCalls).toHaveLength(0); // never reached verify → never signed
  });

  it('REJECTS a challenge whose embedded pubkey is not our own', async () => {
    const server = new FakeVaultServer(NETWORK);
    const auth = tamperedAuth(server.authClient(), (c) => ({
      ...c,
      challenge: c.challenge.replace(PUB, 'ff'.repeat(33)),
    }));
    const client = makeClient(auth);
    await expect(client.authenticate()).rejects.toThrow(/pubkey/i);
    expect(auth.verifyCalls).toHaveLength(0);
  });

  it('REJECTS a challenge whose embedded network is not the expected canonical one', async () => {
    const server = new FakeVaultServer('mainnet'); // server stamps a different net
    const auth = tamperedAuth(server.authClient(), (c) => c);
    const client = makeClient(auth, NETWORK); // client expects testnet2
    await expect(client.authenticate()).rejects.toThrow(/network/i);
    expect(auth.verifyCalls).toHaveLength(0);
  });

  it('REJECTS a challenge with an implausible expiry (already expired)', async () => {
    const server = new FakeVaultServer(NETWORK);
    const auth = tamperedAuth(server.authClient(), (c) => mutateExpiry(c, -10 * 60_000));
    const client = makeClient(auth);
    await expect(client.authenticate()).rejects.toThrow(/expir|timestamp/i);
    expect(auth.verifyCalls).toHaveLength(0);
  });
});

describe('VaultApiClient — serialized refresh', () => {
  it('collapses concurrent 401s to ONE in-flight refresh (no double-rotate)', async () => {
    const server = new FakeVaultServer(NETWORK);
    const client = makeClient(server.authClient());
    await client.authenticate();

    // Fire three concurrent refreshes; they must share ONE in-flight promise so
    // the rotating-refresh server is hit exactly ONCE (a second hit would reuse
    // the now-stale token and revoke the session).
    const [a, b, c] = await Promise.all([client.refresh(), client.refresh(), client.refresh()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(server.calls.refresh).toHaveLength(1);
  });

  it('a fresh refresh after the in-flight one resolves rotates again (one hit each)', async () => {
    const server = new FakeVaultServer(NETWORK);
    const client = makeClient(server.authClient());
    await client.authenticate();
    const j1 = await client.refresh();
    const j2 = await client.refresh();
    expect(j1).not.toBe(j2);
    expect(server.calls.refresh).toHaveLength(2);
  });
});

// --- helpers ----------------------------------------------------------------

/** Wrap an auth client, tampering the challenge and counting `verify` calls. */
function tamperedAuth(
  inner: VaultAuthHttpClient,
  mutate: (c: ChallengeResponse) => ChallengeResponse,
): VaultAuthHttpClient & { verifyCalls: VerifyRequest[] } {
  const verifyCalls: VerifyRequest[] = [];
  return {
    verifyCalls,
    challenge: async (pubkey) => mutate(await inner.challenge(pubkey)),
    verify: async (req: VerifyRequest): Promise<AuthTokens | null> => {
      verifyCalls.push(req);
      return inner.verify(req);
    },
    refresh: (token) => inner.refresh(token),
    logout: (sessionId) => inner.logout(sessionId),
  };
}

/** Shift the challenge's embedded `expiresAt` by `deltaMs` (keeps it parseable). */
function mutateExpiry(c: ChallengeResponse, deltaMs: number): ChallengeResponse {
  const body = JSON.parse(c.challenge.slice('unicity:vault:auth:v1\n'.length));
  body.expiresAt = new Date(new Date(body.expiresAt).getTime() + deltaMs).toISOString();
  return { ...c, challenge: 'unicity:vault:auth:v1\n' + JSON.stringify(body) };
}
