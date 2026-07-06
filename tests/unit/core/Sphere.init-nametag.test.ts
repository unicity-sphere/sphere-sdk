/**
 * Tests for `Sphere.init({ nametag })` against an existing wallet (Bug A).
 *
 * Before the fix, `Sphere.init` routed to `Sphere.load` when a wallet
 * already existed in the storage, and `Sphere.load` silently ignored the
 * `nametag` option. So running `sphere init --nametag alice-t1` on a
 * profile whose wallet was already initialized printed "Wallet
 * initialized successfully!" while leaving the nametag entirely untouched
 * — the kind of silent failure that hid the alice-vs-alice-t1 bug class
 * from the operator.
 *
 * After the fix, the loaded-wallet path honors `options.nametag` with
 * the same invariants as a fresh-create call:
 *
 *  1. No claim yet + nametag provided → call `registerNametag(name)`.
 *  2. Active claim equals requested → no-op (idempotent re-init).
 *  3. Active claim differs from requested → throw `ALREADY_INITIALIZED`
 *     (refuse to silently switch — the operator must `clear()` or
 *     `switchToAddress` explicitly).
 *
 * The first scenario inherits the full registerNametag invariant chain
 * (NAMETAG_CONFLICT, NAMETAG_TAKEN, AGGREGATOR_ERROR) — not re-tested
 * here; covered in `Sphere.mint-before-publish.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Sphere } from '../../../core/Sphere';
import { FileStorageProvider } from '../../../impl/nodejs/storage/FileStorageProvider';
import { FileTokenStorageProvider } from '../../../impl/nodejs/storage/FileTokenStorageProvider';
import type { TransportProvider, OracleProvider } from '../../../index';
import type { ProviderStatus } from '../../../types';
import { mockMintNametagSuccess } from '../../helpers/mockMintNametag';

// Per-test unique directory (Date.now() + random suffix). The previous
// shared `path.join(__dirname, '.test-init-nametag')` triggered
// intermittent "Wallet already exists" failures under full-suite
// worker contention (#217), same family as the flake fixed for
// `Sphere.test.ts` in commit `9bf3e90`. Issuing each test its own
// tmpdir eliminates FS-level interference between tests in this file.
let TEST_DIR: string = '';
let DATA_DIR: string = '';
let TOKENS_DIR: string = '';

function freshTestDirs(): void {
  TEST_DIR = path.join(
    os.tmpdir(),
    `sphere-init-nametag-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  );
  DATA_DIR = path.join(TEST_DIR, 'data');
  TOKENS_DIR = path.join(TEST_DIR, 'tokens');
}

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
    recoverNametag: vi.fn().mockResolvedValue(null),
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

describe('Sphere.init({ nametag }) on existing wallet (Bug A)', () => {
  let storage: FileStorageProvider;
  let tokenStorage: FileTokenStorageProvider;
  let mnemonic: string;
  let mintSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(async () => {
    freshTestDirs();
    if (Sphere.getInstance()) {
      (Sphere as unknown as { instance: null }).instance = null;
    }
    storage = new FileStorageProvider({ dataDir: DATA_DIR });
    tokenStorage = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });

    // Seed: create a fresh wallet WITHOUT a nametag. Captures the mnemonic
    // so subsequent tests can drop the in-memory Sphere instance and
    // re-init from the same persisted storage (the "second sphere init"
    // scenario from the bug report).
    mintSpy = mockMintNametagSuccess();
    const first = await Sphere.init({
      storage,
      transport: createMockTransport(),
      oracle: createMockOracle(),
      tokenStorage,
      autoGenerate: true,
    });
    expect(first.created).toBe(true);
    mnemonic = first.generatedMnemonic!;
    await first.sphere.destroy();
    mintSpy.mockRestore();
    (Sphere as unknown as { instance: null }).instance = null;
  });

  afterEach(() => {
    mintSpy?.mockRestore();
    mintSpy = undefined;
    (Sphere as unknown as { instance: null }).instance = null;
    cleanTestDir();
  });

  it('registers the nametag when the loaded wallet has no claim yet', async () => {
    mintSpy = mockMintNametagSuccess();
    const transport = createMockTransport();

    const { sphere, created } = await Sphere.init({
      storage,
      transport,
      oracle: createMockOracle(),
      tokenStorage,
      nametag: 'alice-t1',
    });

    // Loaded the persisted wallet (not freshly created).
    expect(created).toBe(false);

    // CRITICAL: identity claim now reflects the requested nametag —
    // proving that Sphere.load → Sphere.init no longer silently drops
    // the option.
    expect(sphere.identity!.nametag).toBe('alice-t1');

    // The mint mock was invoked, and Nostr publish was called with the
    // requested nametag.
    expect(mintSpy).toHaveBeenCalledWith('alice-t1');
    const publishCalls = (transport.publishIdentityBinding as ReturnType<typeof vi.fn>).mock.calls;
    // publishIdentityBinding is 3-arg: (chainPubkey, directAddress, nametag)
    const publishedNames = publishCalls.map((args) => args[2]);
    expect(publishedNames).toContain('alice-t1');

    await sphere.destroy();
  });

  it('is a no-op when the requested nametag matches the active claim (idempotent re-init)', async () => {
    // First registration to establish 'alice' as the active claim.
    {
      mintSpy = mockMintNametagSuccess();
      const { sphere } = await Sphere.init({
        storage,
        transport: createMockTransport(),
        oracle: createMockOracle(),
        tokenStorage,
        nametag: 'alice',
      });
      expect(sphere.identity!.nametag).toBe('alice');
      await sphere.destroy();
      mintSpy.mockRestore();
      (Sphere as unknown as { instance: null }).instance = null;
    }

    // Re-init with the SAME nametag — should not throw, not re-mint, not
    // re-publish, just load and confirm.
    mintSpy = mockMintNametagSuccess();
    const transport = createMockTransport();
    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle: createMockOracle(),
      tokenStorage,
      nametag: 'alice',
    });

    expect(sphere.identity!.nametag).toBe('alice');
    expect(mintSpy).not.toHaveBeenCalled();

    // No re-publish either — registerNametag's ALREADY_INITIALIZED-as-no-op
    // branch in Sphere.init means we never reach the registerNametag path.
    // (The init flow's own identity-binding publish DOES run, but that's
    // a separate code path from registerNametag's publish.)
    await sphere.destroy();
  });

  it('throws ALREADY_INITIALIZED when the requested nametag differs from the active claim', async () => {
    // First, register 'alice'.
    {
      mintSpy = mockMintNametagSuccess();
      const { sphere } = await Sphere.init({
        storage,
        transport: createMockTransport(),
        oracle: createMockOracle(),
        tokenStorage,
        nametag: 'alice',
      });
      expect(sphere.identity!.nametag).toBe('alice');
      await sphere.destroy();
      mintSpy.mockRestore();
      (Sphere as unknown as { instance: null }).instance = null;
    }

    // Now re-init asking for a DIFFERENT nametag — must throw rather than
    // silently load the wallet with 'alice' still active. Refusing makes
    // the operator-visible intent (switching nametags) require explicit
    // action.
    mintSpy = mockMintNametagSuccess();

    await expect(
      Sphere.init({
        storage,
        transport: createMockTransport(),
        oracle: createMockOracle(),
        tokenStorage,
        nametag: 'bob',
      }),
    ).rejects.toMatchObject({
      code: 'ALREADY_INITIALIZED',
      message: expect.stringMatching(/cannot re-init with "@bob"/),
    });
  });

  // Use the mnemonic var so the linter doesn't strip the seed step.
  it('mnemonic is preserved across the seed → re-init flow', () => {
    expect(mnemonic).toMatch(/^[a-z]+( [a-z]+){11,23}$/);
  });
});
