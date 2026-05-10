/**
 * Tests for `Sphere.registerNametag` — mint-before-publish ordering AND
 * mint/Nostr-binding consistency guard.
 *
 * Verifies that:
 *
 * 1. Minting happens BEFORE publishing the Nostr binding.
 * 2. If minting fails, nothing is published (no unbacked Nostr claims).
 * 3. If minting succeeds but the Nostr publish fails, the error surfaces
 *    and local state is NOT updated to reflect the unpublished name.
 * 4. Local state is updated only when BOTH mint and publish succeed.
 *
 * Consistency guard (added by the nametag-mint-Nostr-consistency fix):
 *
 * 5. Registering the SAME name as a previously-minted nametag is a
 *    no-op for the mint (idempotent — `NametagMinter` deterministic
 *    salt + `REQUEST_ID_EXISTS` handle the restart-recovery case) and
 *    publishes to Nostr. Local state matches.
 * 6. Registering a DIFFERENT name when the wallet already holds an
 *    on-chain nametag token throws `NAMETAG_CONFLICT` — DOES NOT mint
 *    the new name, DOES NOT publish a Nostr binding, DOES NOT update
 *    `_identity.nametag`. This is exactly the alice-vs-alice-t1 bug
 *    that surfaced as a `PROXY address mismatch` rejection on inbound
 *    faucet transfers.
 * 7. Belt-and-braces: if mintNametag reports success but the wallet's
 *    nametag store doesn't actually contain a matching entry, refuse to
 *    publish. (Defends against races / partial-write bugs in the mint
 *    pipeline.)
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

// =============================================================================
// Test directories
// =============================================================================

const TEST_DIR = path.join(__dirname, '.test-mint-before-publish');
const DATA_DIR = path.join(TEST_DIR, 'data');
const TOKENS_DIR = path.join(TEST_DIR, 'tokens');

// =============================================================================
// Call order tracker
// =============================================================================

const callOrder: string[] = [];

// =============================================================================
// Mock providers
// =============================================================================

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
    publishIdentityBinding: vi.fn().mockImplementation(() => {
      callOrder.push('publish');
      return Promise.resolve(true);
    }),
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

// =============================================================================
// Mint mock helper
// =============================================================================

/**
 * Spy on `sphere._payments.mintNametag` and simulate the real flow:
 *  - record 'mint' in callOrder
 *  - if success, persist the NametagData via `setNametag` (what the real
 *    mintNametag does on success)
 *
 * Critical for the consistency-guard tests: the new `registerNametag`
 * verifies that a token for `cleanNametag` actually exists in the wallet's
 * nametag store after mint reports success. A mock that returns success
 * without calling `setNametag` would trip the belt-and-braces guard.
 */
function installMintMock(
  sphere: Sphere,
  opts: { success: boolean; errorMessage?: string },
): ReturnType<typeof vi.spyOn> {
  const payments = (sphere as unknown as { _payments: PaymentsModule })._payments;
  return vi.spyOn(payments, 'mintNametag').mockImplementation(
    async (name: string): Promise<MintNametagResult> => {
      callOrder.push('mint');
      if (!opts.success) {
        return { success: false, error: opts.errorMessage ?? 'Aggregator rejected' };
      }
      const data: NametagData = {
        name,
        token: { id: `${name}-mock-token-id` },
        timestamp: Date.now(),
        format: 'txf',
        version: '2.0',
      };
      await payments.setNametag(data);
      return { success: true, token: null, nametagData: data } as MintNametagResult;
    },
  );
}

/**
 * Seed a nametag into PaymentsModule's nametags array WITHOUT going through
 * mint — simulates "a different nametag is already minted in this wallet's
 * local state". Used by the conflict-rejection test (case 6).
 */
async function seedExistingNametag(sphere: Sphere, name: string): Promise<void> {
  const payments = (sphere as unknown as { _payments: PaymentsModule })._payments;
  await payments.setNametag({
    name,
    token: { id: `${name}-mock-token-id` },
    timestamp: Date.now(),
    format: 'txf',
    version: '2.0',
  });
}

// =============================================================================
// Helpers
// =============================================================================

function cleanTestDir(): void {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

// =============================================================================
// Tests
// =============================================================================

describe('Sphere.registerNametag() mint-before-publish ordering', () => {
  let storage: FileStorageProvider;
  let tokenStorage: FileTokenStorageProvider;
  let mintSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    cleanTestDir();
    callOrder.length = 0;
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

  it('should mint on-chain BEFORE publishing to Nostr', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    mintSpy = installMintMock(sphere, { success: true });

    // Reset call order after init (init publishes identity binding without nametag)
    callOrder.length = 0;

    await sphere.registerNametag('alice');

    // Verify ordering: mint must come before publish
    expect(callOrder).toEqual(['mint', 'publish']);

    await sphere.destroy();
  });

  it('should NOT publish to Nostr when minting fails', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    mintSpy = installMintMock(sphere, { success: false, errorMessage: 'Aggregator rejected' });

    // Reset after init
    callOrder.length = 0;
    (transport.publishIdentityBinding as ReturnType<typeof vi.fn>).mockClear();

    await expect(sphere.registerNametag('alice')).rejects.toThrow('Failed to mint nametag token');

    // Mint was called, but publish was NOT
    expect(callOrder).toEqual(['mint']);
    expect(transport.publishIdentityBinding).not.toHaveBeenCalled();

    // Local state should NOT have the nametag
    expect(sphere.identity!.nametag).toBeUndefined();

    await sphere.destroy();
  });

  it('should throw when publishing to Nostr fails (nametag taken)', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    mintSpy = installMintMock(sphere, { success: true });

    // publishIdentityBinding returns false (nametag taken by another pubkey)
    (transport.publishIdentityBinding as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    // Publish failure now throws NAMETAG_TAKEN (split from the generic
    // VALIDATION_ERROR "may already be taken") so callers can distinguish
    // relay-name-collision from aggregator-mint failure.
    await expect(sphere.registerNametag('taken')).rejects.toMatchObject({
      code: 'NAMETAG_TAKEN',
      message: expect.stringMatching(/the binding event was rejected/),
    });

    // Local state should NOT have the nametag (identity claim)
    expect(sphere.identity!.nametag).toBeUndefined();

    await sphere.destroy();
  });

  it('should update local state only after both mint and publish succeed', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    mintSpy = installMintMock(sphere, { success: true });

    expect(sphere.identity!.nametag).toBeUndefined();

    await sphere.registerNametag('alice');

    // Now local state should have the nametag
    expect(sphere.identity!.nametag).toBe('alice');

    await sphere.destroy();
  });
});

describe('Sphere.registerNametag() mint/Nostr-binding consistency guard', () => {
  let storage: FileStorageProvider;
  let tokenStorage: FileTokenStorageProvider;
  let mintSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    cleanTestDir();
    callOrder.length = 0;
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

  it('idempotent: registering the SAME nametag as already minted skips mint, still publishes', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    // Pre-seed: wallet already has "alice" minted (e.g. from a previous
    // session whose Nostr publish never landed, or a recovery scenario)
    await seedExistingNametag(sphere, 'alice');

    mintSpy = installMintMock(sphere, { success: true });
    callOrder.length = 0;
    (transport.publishIdentityBinding as ReturnType<typeof vi.fn>).mockClear();

    await sphere.registerNametag('alice');

    // Mint is NOT called again — we already have a matching entry
    expect(callOrder).toEqual(['publish']);
    expect(mintSpy).not.toHaveBeenCalled();

    // Nostr publish for the same name DID happen
    expect(transport.publishIdentityBinding).toHaveBeenCalled();
    const args = (transport.publishIdentityBinding as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args[3]).toBe('alice');

    // Local state reflects the registration
    expect(sphere.identity!.nametag).toBe('alice');

    await sphere.destroy();
  });

  it('NAMETAG_CONFLICT: rejects registering a DIFFERENT name when a nametag is already minted', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    // Pre-seed: wallet has "alice" minted (this is the alice-vs-alice-t1
    // scenario from the production bug report — somehow the wallet had
    // an `alice` token in its local state when the user requested to
    // register `alice-t1`).
    await seedExistingNametag(sphere, 'alice');

    mintSpy = installMintMock(sphere, { success: true });
    callOrder.length = 0;
    (transport.publishIdentityBinding as ReturnType<typeof vi.fn>).mockClear();

    // Registering a DIFFERENT name must throw NAMETAG_CONFLICT.
    await expect(sphere.registerNametag('alice-t1')).rejects.toThrow(
      /already holds an on-chain nametag token/,
    );

    // No mint attempt for the new name — the guard fires BEFORE mint.
    expect(callOrder).toEqual([]);
    expect(mintSpy).not.toHaveBeenCalled();

    // No Nostr publish for the rejected name.
    expect(transport.publishIdentityBinding).not.toHaveBeenCalled();

    // Identity claim NOT updated — the wallet still has no public claim
    // (the seed only put a token in the store; identity.nametag was unset).
    expect(sphere.identity!.nametag).toBeUndefined();

    await sphere.destroy();
  });

  it('NAMETAG_CONFLICT error carries the typed code', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    await seedExistingNametag(sphere, 'alice');

    mintSpy = installMintMock(sphere, { success: true });

    try {
      await sphere.registerNametag('alice-t1');
      throw new Error('Expected NAMETAG_CONFLICT to throw');
    } catch (err) {
      expect(err).toMatchObject({
        code: 'NAMETAG_CONFLICT',
        message: expect.stringMatching(/already holds an on-chain nametag token/),
      });
    }

    await sphere.destroy();
  });

  it('belt-and-braces: refuses to publish if mint reports success but no token is stored', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    // Pathological mock: mintNametag returns success but does NOT
    // populate the wallet's nametag store. Simulates a race / partial-
    // write bug in the mint pipeline.
    const payments = (sphere as unknown as { _payments: PaymentsModule })._payments;
    mintSpy = vi.spyOn(payments, 'mintNametag').mockImplementation(async (): Promise<MintNametagResult> => {
      callOrder.push('mint');
      return { success: true, token: null, nametagData: null } as unknown as MintNametagResult;
    });

    callOrder.length = 0;
    (transport.publishIdentityBinding as ReturnType<typeof vi.fn>).mockClear();

    await expect(sphere.registerNametag('alice')).rejects.toThrow(
      /mint reported success but no matching nametag token was persisted/,
    );

    // Mint was called, but Nostr publish was NOT.
    expect(callOrder).toEqual(['mint']);
    expect(transport.publishIdentityBinding).not.toHaveBeenCalled();

    // Identity claim NOT updated.
    expect(sphere.identity!.nametag).toBeUndefined();

    await sphere.destroy();
  });
});

describe('Sphere.registerNametag() failure-mode error split + rollback (Bug B+C)', () => {
  let storage: FileStorageProvider;
  let tokenStorage: FileTokenStorageProvider;
  let mintSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    cleanTestDir();
    callOrder.length = 0;
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

  it('NAMETAG_TAKEN: publish failure throws the typed code with binding-rejected message', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    mintSpy = installMintMock(sphere, { success: true });
    (transport.publishIdentityBinding as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    try {
      await sphere.registerNametag('taken');
      throw new Error('Expected NAMETAG_TAKEN');
    } catch (err) {
      expect(err).toMatchObject({
        code: 'NAMETAG_TAKEN',
        message: expect.stringMatching(/binding event was rejected/),
      });
    }

    await sphere.destroy();
  });

  it('rollback: when THIS call minted the nametag and publish fails, the local entry is removed', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    mintSpy = installMintMock(sphere, { success: true });
    (transport.publishIdentityBinding as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const payments = (sphere as unknown as { _payments: PaymentsModule })._payments;

    // Pre-conditions: wallet has no nametag entries.
    expect(payments.hasNametag()).toBe(false);

    await expect(sphere.registerNametag('alice')).rejects.toMatchObject({
      code: 'NAMETAG_TAKEN',
    });

    // After publish failure, the just-minted nametag entry MUST be rolled
    // back so a subsequent registerNametag with a different name doesn't
    // trip NAMETAG_CONFLICT.
    expect(payments.hasNametagNamed('alice')).toBe(false);
    expect(payments.hasNametag()).toBe(false);

    await sphere.destroy();
  });

  it('rollback: does NOT remove a pre-existing nametag that was already minted', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    const payments = (sphere as unknown as { _payments: PaymentsModule })._payments;

    // Pre-seed: wallet already holds "alice" from a prior successful
    // registerNametag (so registerNametag('alice') here is an
    // idempotent re-publish — mint is skipped, no `mintedFresh`).
    await seedExistingNametag(sphere, 'alice');

    mintSpy = installMintMock(sphere, { success: true });
    (transport.publishIdentityBinding as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    await expect(sphere.registerNametag('alice')).rejects.toMatchObject({
      code: 'NAMETAG_TAKEN',
      // Error message MUST NOT claim rollback occurred — nothing was
      // disturbed on this code path. The "orphan rolled back" wording
      // is conditional on mintedFresh.
      message: expect.not.stringMatching(/orphan local nametag entry .* has been rolled back/),
    });

    // The pre-existing alice entry MUST still be there — rollback only
    // applies to mints that happened in THIS call, not to any prior
    // legitimate mint.
    expect(payments.hasNametagNamed('alice')).toBe(true);
    // Mint mock was NOT called (idempotent skip).
    expect(mintSpy).not.toHaveBeenCalled();

    await sphere.destroy();
  });

  it('error message: mintedFresh failure surfaces "rolled back" language', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    mintSpy = installMintMock(sphere, { success: true });
    (transport.publishIdentityBinding as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    // No pre-seed: this call mints from scratch, so mintedFresh=true and
    // the rollback path fires. Error message should explicitly tell the
    // operator that local state was restored.
    await expect(sphere.registerNametag('fresh')).rejects.toMatchObject({
      code: 'NAMETAG_TAKEN',
      message: expect.stringMatching(/orphan local nametag entry .* has been rolled back/),
    });

    await sphere.destroy();
  });
});
