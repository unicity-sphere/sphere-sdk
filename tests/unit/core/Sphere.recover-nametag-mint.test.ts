/**
 * Tests for `Sphere.recoverNametagFromTransport` — on-chain token re-mint
 * after Nostr-based nametag recovery.
 *
 * Bug class (PR #127 known-limitation now closed): when Nostr resolves
 * `@alice` → this wallet's pubkey but `_payments.nametags` is empty
 * (e.g. wallet imported from mnemonic on fresh storage), the recovery
 * path was setting `_identity.nametag = 'alice'` without recovering
 * the on-chain nametag token. PROXY-mode finalize then threw
 * `Cannot finalize PROXY transfer - no Unicity ID token` because
 * `getNametag()` returned null.
 *
 * Fix: after Nostr discovery, call `sphere.mintNametag(recoveredName)`.
 * The aggregator returns `REQUEST_ID_EXISTS` with the original
 * inclusion proof (deterministic salt — same wallet, same name), and
 * the wallet reconstructs the token locally.
 *
 * These tests verify:
 *   1. Successful recovery path: mintNametag is called, token lands in
 *      `_payments.nametags`, identity claim is set.
 *   2. Mint-failure path: identity claim is still set (the Nostr
 *      binding is authoritative), the missing token is logged, and
 *      `_payments.nametags` stays empty.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Sphere } from '../../../core/Sphere';
import { FileStorageProvider } from '../../../impl/nodejs/storage/FileStorageProvider';
import { FileTokenStorageProvider } from '../../../impl/nodejs/storage/FileTokenStorageProvider';
import type { TransportProvider, OracleProvider } from '../../../index';
import type { ProviderStatus } from '../../../types';
import type { PaymentsModule, MintNametagResult } from '../../../modules/payments';
import type { NametagData } from '../../../types/txf';

const TEST_DIR = path.join(__dirname, '.test-recover-nametag-mint');
const DATA_DIR = path.join(TEST_DIR, 'data');
const TOKENS_DIR = path.join(TEST_DIR, 'tokens');

const RECOVERED_NAME = 'alice';

function createMockTransport(): TransportProvider {
  return {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p' as const,
    description: 'Mock transport',
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
    subscribeToBroadcast: vi.fn().mockReturnValue(() => {}),
    publishBroadcast: vi.fn().mockResolvedValue('broadcast-id'),
    onEvent: vi.fn().mockReturnValue(() => {}),
    resolveNametag: vi.fn().mockResolvedValue(null),
    publishIdentityBinding: vi.fn().mockResolvedValue(true),
    // The recovery path under test: transport returns the previously-bound
    // nametag for this wallet's pubkey.
    recoverNametag: vi.fn().mockResolvedValue(RECOVERED_NAME),
  } as TransportProvider;
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
    mintToken: vi.fn().mockResolvedValue({ success: true, token: { id: 'mock-token' } }),
  } as unknown as OracleProvider;
}

function cleanTestDir(): void {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

interface SphereInternals {
  _payments: PaymentsModule;
}

describe('Sphere.recoverNametagFromTransport — on-chain token re-mint', () => {
  let storage: FileStorageProvider;
  let tokenStorage: FileTokenStorageProvider;
  let mintSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    cleanTestDir();
    if (Sphere.getInstance()) {
      (Sphere as unknown as { instance: null }).instance = null;
    }
    storage = new FileStorageProvider({ dataDir: DATA_DIR });
    tokenStorage = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });
  });

  afterEach(() => {
    mintSpy?.mockRestore();
    mintSpy = undefined;
    (Sphere as unknown as { instance: null }).instance = null;
    cleanTestDir();
  });

  it('recovery success: mintNametag is called and token lands in the local store', async () => {
    const transport = createMockTransport();

    // Mint mock simulates the REAL `mintNametag` flow: aggregator
    // returns proof, setNametag stores the NametagData.
    mintSpy = vi
      .spyOn(
        Sphere.prototype as unknown as { mintNametag: (n: string) => Promise<unknown> },
        'mintNametag',
      )
      .mockImplementation(async function (
        this: SphereInternals,
        name: string,
      ): Promise<MintNametagResult> {
        const data: NametagData = {
          name,
          token: { id: `${name}-mock-token-id` },
          timestamp: Date.now(),
          format: 'txf',
          version: '2.0',
        };
        await this._payments.setNametag(data);
        return { success: true, token: null, nametagData: data } as MintNametagResult;
      });

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle: createMockOracle(),
      tokenStorage,
      autoGenerate: true,
      // No `nametag` option → Sphere.create takes the recoverNametagFromTransport path.
    });

    // Nostr-recovery should have set the active claim.
    expect(sphere.identity!.nametag).toBe(RECOVERED_NAME);

    // The on-chain token MUST have been re-minted and persisted.
    const payments = (sphere as unknown as SphereInternals)._payments;
    expect(payments.hasNametagNamed(RECOVERED_NAME)).toBe(true);
    expect(mintSpy).toHaveBeenCalledWith(RECOVERED_NAME);

    await sphere.destroy();
  });

  it('mint failure: identity claim is still set, the missing token is tolerated', async () => {
    const transport = createMockTransport();

    // Mint reports failure (e.g. aggregator hiccup, or the salt doesn't
    // match a prior commitment under this pubkey). The recovery path
    // must NOT throw — the Nostr binding is authoritative for the
    // identity claim, and the operator can retry mintNametag manually
    // later.
    mintSpy = vi
      .spyOn(
        Sphere.prototype as unknown as { mintNametag: (n: string) => Promise<unknown> },
        'mintNametag',
      )
      .mockResolvedValue({
        success: false,
        error: 'Aggregator unreachable (simulated)',
      } as MintNametagResult);

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle: createMockOracle(),
      tokenStorage,
      autoGenerate: true,
    });

    // Identity claim still set — Nostr binding is authoritative.
    expect(sphere.identity!.nametag).toBe(RECOVERED_NAME);
    expect(mintSpy).toHaveBeenCalledWith(RECOVERED_NAME);

    // No on-chain token persisted (mint failed). PROXY-mode inbound
    // transfers will fail until a subsequent mint succeeds — that's
    // the documented graceful-degradation state.
    const payments = (sphere as unknown as SphereInternals)._payments;
    expect(payments.hasNametagNamed(RECOVERED_NAME)).toBe(false);

    await sphere.destroy();
  });

  it('mint throws: identity claim is still set, exception is swallowed', async () => {
    const transport = createMockTransport();

    mintSpy = vi
      .spyOn(
        Sphere.prototype as unknown as { mintNametag: (n: string) => Promise<unknown> },
        'mintNametag',
      )
      .mockRejectedValue(new Error('Network down (simulated)'));

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle: createMockOracle(),
      tokenStorage,
      autoGenerate: true,
    });

    expect(sphere.identity!.nametag).toBe(RECOVERED_NAME);

    const payments = (sphere as unknown as SphereInternals)._payments;
    expect(payments.hasNametagNamed(RECOVERED_NAME)).toBe(false);

    await sphere.destroy();
  });

  it('no Nostr binding: recovery is a no-op, mint is not called', async () => {
    const transport = createMockTransport();
    (transport.recoverNametag as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    mintSpy = vi
      .spyOn(
        Sphere.prototype as unknown as { mintNametag: (n: string) => Promise<unknown> },
        'mintNametag',
      )
      .mockResolvedValue({ success: true, token: null, nametagData: null } as MintNametagResult);

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle: createMockOracle(),
      tokenStorage,
      autoGenerate: true,
    });

    // No nametag recovered → identity claim stays undefined, mint never called.
    expect(sphere.identity!.nametag).toBeUndefined();
    expect(mintSpy).not.toHaveBeenCalled();

    await sphere.destroy();
  });
});
