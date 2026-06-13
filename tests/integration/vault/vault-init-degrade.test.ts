/**
 * Fund-safety: a vault outage must DEGRADE, never brick the wallet
 * (remote-provider-init-auth-throw-bricks-wallet).
 *
 * Sphere loads token-storage providers together; one provider's throw rejects
 * the whole wallet load. So `initialize()` must NEVER throw on auth / network /
 * first-load failure: it logs, leaves the flush gate SHUT, and RESOLVES `false`
 * (the contract's non-fatal value) so the wallet still loads from local storage.
 * A vault outage degrades to "remote backup inactive", never blocks startup.
 */

import { describe, it, expect } from 'vitest';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { RemoteTokenStorageProvider } from '../../../storage/remote/RemoteTokenStorageProvider';
import { FakeVaultServer } from '../../helpers/fake-vault-server';
import { wireKey } from '../../../storage/remote/wire-key';
import type { FullIdentity } from '../../../types';
import type {
  AuthTokens,
  StateResponse,
  VaultAuthHttpClient,
  VaultHttpClient,
  VerifyRequest,
} from '../../../storage/remote/types';

const NETWORK = 'testnet2';
const PRIV = '71'.repeat(32);
const PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(PRIV), true));
const identity: FullIdentity = { chainPubkey: PUB, l1Address: 'alpha1me', privateKey: PRIV };

interface ProviderOpts {
  httpClientFactory?: (ownerId: string) => VaultHttpClient;
  authClient?: VaultAuthHttpClient;
}

function makeProvider(server: FakeVaultServer, opts: ProviderOpts = {}): RemoteTokenStorageProvider {
  const p = new RemoteTokenStorageProvider({
    network: NETWORK,
    vaultUrl: 'https://vault.testnet.unicity.network',
    privateKey: PRIV,
    authClient: opts.authClient ?? server.authClient(),
    httpClientFactory: opts.httpClientFactory ?? ((ownerId) => server.clientFor(ownerId)),
  });
  p.setIdentity(identity);
  return p;
}

/** An auth seam whose /verify always 401s (server rejects the signature). */
function rejectingAuthClient(server: FakeVaultServer): VaultAuthHttpClient {
  const inner = server.authClient();
  return {
    challenge: (pubkey) => inner.challenge(pubkey),
    verify: (_req: VerifyRequest): Promise<AuthTokens | null> => Promise.resolve(null),
    refresh: (token) => inner.refresh(token),
    logout: (sessionId) => inner.logout(sessionId),
  };
}

/** An auth seam whose /challenge always throws (vault server is down). */
function downAuthClient(): VaultAuthHttpClient {
  return {
    challenge: () => Promise.reject(new Error('ECONNREFUSED: vault server down')),
    verify: () => Promise.resolve(null),
    refresh: () => Promise.resolve(null),
    logout: () => Promise.resolve(),
  };
}

describe('initialize() degrades, never bricks the wallet', () => {
  it('auth 401 → initialize() resolves false (does NOT throw), gate stays shut', async () => {
    const server = new FakeVaultServer(NETWORK);
    const provider = makeProvider(server, { authClient: rejectingAuthClient(server) });

    await expect(provider.initialize()).resolves.toBe(false);
    expect(provider.isInitialLoadDone()).toBe(false);
    expect(provider.getStatus()).toBe('error');
  });

  it('vault server down (auth throws) → initialize() resolves false, no throw, gate stays shut', async () => {
    const server = new FakeVaultServer(NETWORK);
    const provider = makeProvider(server, { authClient: downAuthClient() });

    await expect(provider.initialize()).resolves.toBe(false);
    expect(provider.isInitialLoadDone()).toBe(false);
    expect(provider.getStatus()).toBe('error');
  });

  it('first /state load failure → initialize() resolves false (does NOT throw), gate stays shut', async () => {
    const server = new FakeVaultServer(NETWORK);
    const wrap = (ownerId: string): VaultHttpClient => {
      const inner = server.clientFor(ownerId);
      return {
        patchEntries: (ops) => inner.patchEntries(ops),
        getState: (_since): Promise<StateResponse> => Promise.reject(new Error('transient /state failure')),
        appendHistory: (records) => inner.appendHistory(records),
        historySince: (since) => inner.historySince(since),
        deleteNonce: () => inner.deleteNonce(),
        deleteAccount: (nonce, sig) => inner.deleteAccount(nonce, sig),
      };
    };
    const provider = makeProvider(server, { httpClientFactory: wrap });

    await expect(provider.initialize()).resolves.toBe(false);
    expect(provider.isInitialLoadDone()).toBe(false);
    // No flush ever happened during initialize (gate never opened, decrypt never ran).
    expect(server.calls.patch).toHaveLength(0);
    const wk = wireKey(PRIV, NETWORK, 'aaa');
    expect(server.getEntry(PUB, wk)).toBeUndefined();
  });

  it('healthy auth + first load → initialize() resolves true and opens the gate (no regression)', async () => {
    const server = new FakeVaultServer(NETWORK);
    const provider = makeProvider(server);
    await expect(provider.initialize()).resolves.toBe(true);
    expect(provider.isInitialLoadDone()).toBe(true);
    expect(provider.getStatus()).toBe('connected');
  });
});
