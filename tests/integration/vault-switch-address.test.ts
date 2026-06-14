/**
 * Vault per-address rebuild on switchToAddress (vault wallet wiring, concern 4).
 *
 * FUND-SAFETY: RemoteTokenStorageProvider binds its AEAD/wireKey/auth crypto to the
 * construction-time spend key. On an HD address switch the provider has no arg-less
 * `createForAddress()` clone, so the old single-key instance could not be re-keyed —
 * `setIdentity(newIdentity)` would throw INVALID_IDENTITY (or seal under the WRONG
 * key). switchToAddress must therefore REBUILD the vault via the factory with the new
 * address's private key in scope. This test drives a real address switch end-to-end
 * against a real-socket fake vault and asserts:
 *   - the switch does not throw (no INVALID_IDENTITY);
 *   - a flush AFTER the switch lands under address-1's owner (its key), never address-0's.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Sphere } from '../../core/Sphere';
import { FileStorageProvider } from '../../impl/nodejs/storage/FileStorageProvider';
import { FileTokenStorageProvider } from '../../impl/nodejs/storage/FileTokenStorageProvider';
import { startRealVaultSocket, type RealVaultSocket } from '../helpers/real-vault-socket';
import { wireKey } from '../../storage/remote/wire-key';
import { normalizeVaultNetwork } from '../../storage/remote/normalize-network';
import type { RemoteTokenStorageProvider } from '../../storage/remote/RemoteTokenStorageProvider';
import type { TransportProvider, OracleProvider } from '../../index';
import type { AddressModuleSet } from '../../core/Sphere';
import type { ProviderStatus, FullIdentity } from '../../types';
import type { TxfStorageDataBase } from '../../storage';
import { TEST_NETWORK } from '../test-network';

const TEST_DIR = path.join(__dirname, '.test-vault-switch-address');
const DATA_DIR = path.join(TEST_DIR, 'data');
const TOKENS_DIR = path.join(TEST_DIR, 'tokens');
const VAULT_PROVIDER_ID = 'remote-token-storage';

function createMockTransport(): TransportProvider {
  return {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p' as const,
    setIdentity: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    sendMessage: vi.fn().mockResolvedValue('event-id'),
    onMessage: vi.fn().mockReturnValue(() => {}),
    sendTokenTransfer: vi.fn().mockResolvedValue('transfer-id'),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    sendPaymentRequest: vi.fn().mockResolvedValue('request-id'),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    sendPaymentRequestResponse: vi.fn().mockResolvedValue('response-id'),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    publishIdentityBinding: vi.fn().mockResolvedValue(true),
    recoverNametag: vi.fn().mockResolvedValue(null),
    resolveNametag: vi.fn().mockResolvedValue(null),
    onEvent: vi.fn().mockReturnValue(() => {}),
  } as unknown as TransportProvider;
}

function createMockOracle(): OracleProvider {
  return {
    id: 'mock-oracle',
    name: 'Mock Oracle',
    type: 'aggregator' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    initialize: vi.fn().mockResolvedValue(undefined),
    submitCommitment: vi.fn().mockResolvedValue({ requestId: 'test-id' }),
    getProof: vi.fn().mockResolvedValue(null),
    waitForProof: vi.fn().mockResolvedValue({ proof: 'mock' }),
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
  } as unknown as OracleProvider;
}

function cleanTestDir(): void {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

/** Reach into the per-address module set to read its registered vault provider. */
function addressVault(sphere: Sphere, index: number): RemoteTokenStorageProvider {
  const modules = (sphere as unknown as { _addressModules: Map<number, AddressModuleSet> })._addressModules;
  const set = modules.get(index)!;
  return set.tokenStorageProviders.get(VAULT_PROVIDER_ID) as unknown as RemoteTokenStorageProvider;
}

/** Read the FULL (private-key-bearing) active identity — the public getter strips it. */
function fullIdentity(sphere: Sphere): FullIdentity {
  return (sphere as unknown as { _identity: FullIdentity })._identity;
}

function txf(id: string): TxfStorageDataBase {
  return {
    _meta: { version: 1, address: '', formatVersion: '2.0', updatedAt: Date.now() },
    [`_${id}`]: { amt: '1' },
  } as TxfStorageDataBase;
}

let socket: RealVaultSocket;

describe('vault per-address rebuild on switchToAddress', () => {
  beforeEach(async () => {
    cleanTestDir();
    if (Sphere.getInstance()) (Sphere as unknown as { instance: null }).instance = null;
    // The socket's epoch-signing key must match the network the wallet signs under.
    socket = await startRealVaultSocket(normalizeVaultNetwork(TEST_NETWORK));
  });

  afterEach(async () => {
    if (Sphere.getInstance()) {
      try { await Sphere.getInstance()!.destroy(); } catch { /* ignore */ }
    }
    (Sphere as unknown as { instance: null }).instance = null;
    await socket.close();
    cleanTestDir();
  });

  it('rebuilds the vault keyed to the new address (no INVALID_IDENTITY) and flushes under its key', async () => {
    const { sphere } = await Sphere.init({
      storage: new FileStorageProvider({ dataDir: DATA_DIR }),
      transport: createMockTransport(),
      oracle: createMockOracle(),
      tokenStorage: new FileTokenStorageProvider({ tokensDir: TOKENS_DIR }),
      network: TEST_NETWORK,
      autoGenerate: true,
      vault: { enabled: true, url: socket.baseUrl },
    });

    const vault0 = addressVault(sphere, 0);
    const id0 = fullIdentity(sphere).chainPubkey;

    // Switch to address 1 — the buggy fallback (reuse the address-0-keyed vault)
    // would throw INVALID_IDENTITY when PaymentsModule calls setIdentity here.
    await expect(sphere.switchToAddress(1)).resolves.toBeUndefined();

    const vault1 = addressVault(sphere, 1);
    const id1 = fullIdentity(sphere).chainPubkey;

    // The vault was REBUILT — a fresh instance, keyed to a different owner.
    expect(vault1).not.toBe(vault0);
    expect(id1).not.toBe(id0);

    // A flush under address 1 lands on the server under address-1's owner + key.
    const priv1 = fullIdentity(sphere).privateKey;
    const res = await vault1.sync(txf('tok1'));
    expect(res.success).toBe(true);
    const wk1 = wireKey(priv1, normalizeVaultNetwork(TEST_NETWORK), 'tok1');
    expect(socket.vault.getEntry(id1, wk1)).toBeDefined();
    // Nothing was ever written under address-0's owner by the address-1 flush.
    expect(socket.vault.getEntry(id0, wk1)).toBeUndefined();
  });
});
