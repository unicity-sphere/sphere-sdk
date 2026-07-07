/**
 * Tests for `Sphere.registerNametag` — mint-before-publish ordering AND
 * mint/Nostr-binding consistency guard.
 *
 * Verifies that:
 *
 * 1. Minting happens BEFORE publishing the Nostr binding (background mode
 *    schedules the publish AFTER `registerNametag` returns).
 * 2. If minting fails, nothing is published (no unbacked Nostr claims).
 * 3. **Issue #42** — default `publishMode: 'background'` resolves
 *    `registerNametag` as soon as the on-chain mint lands. The Nostr
 *    publish runs detached; failures surface via the new
 *    `nametag:publish-failed` event instead of throwing.
 * 4. **Issue #42** — opt-in `publishMode: 'await'` preserves the strict
 *    legacy contract: relay rejections throw `NAMETAG_TAKEN` with
 *    orphan-mint rollback.
 * 5. Local state is updated when the mint succeeds, regardless of
 *    publish mode (background mode no longer waits for the relay).
 *
 * Consistency guard (added by the nametag-mint-Nostr-consistency fix):
 *
 * 6. Registering the SAME name as a previously-minted nametag is a
 *    no-op for the mint (idempotent — `NametagMinter` deterministic
 *    salt + `REQUEST_ID_EXISTS` handle the restart-recovery case) and
 *    publishes to Nostr. Local state matches.
 * 7. Registering a DIFFERENT name when the wallet already holds an
 *    on-chain nametag token throws `NAMETAG_CONFLICT` — DOES NOT mint
 *    the new name, DOES NOT publish a Nostr binding, DOES NOT update
 *    `_identity.nametag`. This is exactly the alice-vs-alice-t1 bug
 *    that surfaced as a `PROXY address mismatch` rejection on inbound
 *    faucet transfers.
 * 8. Belt-and-braces: if mintNametag reports success but the wallet's
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
//
// Per-test unique directory (Date.now() + random suffix). The previous
// shared `path.join(__dirname, '.test-mint-before-publish')` triggered
// intermittent "Wallet already exists" failures (~40% in full-suite
// runs) because under high parallel-worker CPU load, the FS race
// between cleanTestDir() and the next test's `Sphere.init` →
// `Sphere.exists` could see a partially-saved wallet.json from the
// FileStorageProvider's proper-lockfile path. Issuing each test its
// own tmpdir eliminates that interference at the FS level.
//
// `os.tmpdir()` is typically on a tmpfs in test environments — no
// fsync, no real cross-process lock contention.
import * as os from 'os';

let TEST_DIR: string = '';
let DATA_DIR: string = '';
let TOKENS_DIR: string = '';

function freshTestDirs(): void {
  TEST_DIR = path.join(os.tmpdir(), `sphere-mint-before-publish-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  DATA_DIR = path.join(TEST_DIR, 'data');
  TOKENS_DIR = path.join(TEST_DIR, 'tokens');
}

// =============================================================================
// Call order tracker
// =============================================================================

const callOrder: string[] = [];

// =============================================================================
// Microtask flush helper (issue #42)
// =============================================================================
//
// `publishMode: 'background'` schedules the Nostr publish via
// `void this._handleDetachedPublishOutcome(...)` so the caller's await
// chain resolves as soon as the mint lands. The detached handler then
// chains through `await publishPromise` and (on rejection)
// `clearNametagByName` → `setNametag` → real file I/O via
// `FileStorageProvider`. The `proper-lockfile` flow involves
// `setImmediate` / `process.nextTick` callbacks between microtask
// turns, so a pure microtask drain (`await Promise.resolve()`)
// isn't sufficient. Interleave macrotask + microtask ticks so we
// cover both queues.
async function flushBackgroundPublish(): Promise<void> {
  // The detached handler chains through real `proper-lockfile` file I/O
  // (clearNametagByName → setNametag → save, then persistAddressNametags).
  // Pure microtask draining doesn't cover the lockfile's setImmediate /
  // setTimeout-based fsync. Wait long enough that the chain settles even
  // under contended CI workers.
  await new Promise((r) => setTimeout(r, 200));
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  }
}

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
    freshTestDirs();
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

  it('background mode: mints on-chain BEFORE scheduling the Nostr publish', async () => {
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
    // Background publish: the mint has landed, the publish promise is
    // queued but its body may not have run yet. Flush microtasks so
    // the publish mock fires and pushes 'publish' onto callOrder.
    await flushBackgroundPublish();

    // Verify ordering: mint must come before publish even when the
    // publish is decoupled — `registerNametag` schedules the publish
    // AFTER the mint completes.
    expect(callOrder).toEqual(['mint', 'publish']);

    await sphere.destroy();
  });

  it('await mode: mints on-chain BEFORE publishing to Nostr (synchronous)', async () => {
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
    callOrder.length = 0;

    await sphere.registerNametag('alice', { publishMode: 'await' });

    // No microtask flush needed — `await` mode publishes synchronously.
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

    // Default `'background'` mode — the throw still happens because the
    // mint failure surfaces BEFORE the publish is scheduled.
    await expect(sphere.registerNametag('alice')).rejects.toThrow('Failed to mint nametag token');
    await flushBackgroundPublish();

    // Mint was called, but publish was NOT
    expect(callOrder).toEqual(['mint']);
    expect(transport.publishIdentityBinding).not.toHaveBeenCalled();

    // Local state should NOT have the nametag
    expect(sphere.identity!.nametag).toBeUndefined();

    await sphere.destroy();
  });

  it('await mode: throws NAMETAG_TAKEN when publish returns false', async () => {
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

    // `await` mode preserves the legacy strict contract:
    // relay rejection → throw NAMETAG_TAKEN.
    await expect(
      sphere.registerNametag('taken', { publishMode: 'await' }),
    ).rejects.toMatchObject({
      code: 'NAMETAG_TAKEN',
      message: expect.stringMatching(/the binding event was rejected/),
    });

    // Local state should NOT have the nametag (identity claim)
    expect(sphere.identity!.nametag).toBeUndefined();

    await sphere.destroy();
  });

  it('background mode: resolves successfully when publish returns false; emits nametag:publish-failed', async () => {
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

    const publishFailedEvents: Array<{
      nametag: string;
      reason: 'taken' | 'error';
      rolledBack: boolean;
      error?: string;
    }> = [];
    sphere.on('nametag:publish-failed', (payload) => {
      publishFailedEvents.push(payload);
    });

    // Default mode: does NOT throw — relay rejection is reported via event.
    await expect(sphere.registerNametag('taken')).resolves.toBeUndefined();

    // Identity is set immediately after the mint (caller has already gotten
    // the success they wanted; the relay binding is decoupled).
    expect(sphere.identity!.nametag).toBe('taken');

    // Background publish has been scheduled but not run yet.
    await flushBackgroundPublish();

    // After the publish settles: the event fired, and because `mintedFresh`
    // was true, the orphan local mint pointer (and identity claim) got
    // rolled back so a subsequent register-with-a-different-name attempt
    // isn't gated by NAMETAG_CONFLICT.
    expect(publishFailedEvents).toHaveLength(1);
    expect(publishFailedEvents[0]).toMatchObject({
      nametag: 'taken',
      reason: 'taken',
      rolledBack: true,
    });

    // Post-rollback: identity claim cleared, store entry removed.
    expect(sphere.identity!.nametag).toBeUndefined();
    const payments = (sphere as unknown as { _payments: PaymentsModule })._payments;
    expect(payments.hasNametagNamed('taken')).toBe(false);

    await sphere.destroy();
  });

  it('background mode: publish that throws surfaces as nametag:publish-failed with reason=error and no rollback', async () => {
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
    (transport.publishIdentityBinding as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('relay disconnected'),
    );

    const publishFailedEvents: Array<{
      nametag: string;
      reason: 'taken' | 'error';
      rolledBack: boolean;
      error?: string;
    }> = [];
    sphere.on('nametag:publish-failed', (payload) => {
      publishFailedEvents.push(payload);
    });

    // Default mode — no throw.
    await expect(sphere.registerNametag('alice')).resolves.toBeUndefined();

    // Identity is set immediately after the mint.
    expect(sphere.identity!.nametag).toBe('alice');

    await flushBackgroundPublish();

    expect(publishFailedEvents).toHaveLength(1);
    expect(publishFailedEvents[0]).toMatchObject({
      nametag: 'alice',
      reason: 'error',
      rolledBack: false,
      error: 'relay disconnected',
    });

    // Identity claim preserved — transient errors are recoverable on the
    // next wallet load via `syncIdentityWithTransport` republish.
    expect(sphere.identity!.nametag).toBe('alice');
    const payments = (sphere as unknown as { _payments: PaymentsModule })._payments;
    expect(payments.hasNametagNamed('alice')).toBe(true);

    await sphere.destroy();
  });

  it('background mode: a stalled relay does NOT block registerNametag', async () => {
    // Direct repro of issue #42 failure mode (3): "Nostr publish in-band
    // with the mint" — if the publish never settles, `await
    // registerNametag(...)` must NOT hang. Background mode detaches
    // the publish so the caller resolves as soon as the mint lands.
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
    // Mock a publish that never resolves — simulating a relay stall.
    (transport.publishIdentityBinding as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<never>(() => { /* intentionally never settles */ }),
    );

    // `registerNametag` resolves as soon as the mint completes,
    // unaffected by the never-resolving publish promise.
    const start = Date.now();
    await sphere.registerNametag('alice');
    const elapsed = Date.now() - start;

    // Bound: nowhere near a real relay timeout. The pending publish
    // continues to dangle but is detached from the caller's promise.
    expect(elapsed).toBeLessThan(5_000);
    expect(sphere.identity!.nametag).toBe('alice');

    await sphere.destroy();
  });

  it('background mode: destroy() while publish is in flight does NOT throw nametag:publish-failed (review B2)', async () => {
    // The detached publish handler must bail out when the wallet has
    // been torn down between dispatch and resume. Otherwise: emitEvent
    // lands on a cleared handler set (harmless), but the rollback's
    // storage writes silently no-op against a disconnected provider
    // and leave the wallet's on-disk nametag store inconsistent for
    // the next cold load.
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

    // Hold the publish promise in a pending state so we can interleave
    // `destroy()` between `registerNametag` returning and the handler
    // resuming.
    let resolvePublish!: (v: boolean) => void;
    const heldPublish = new Promise<boolean>((r) => { resolvePublish = r; });
    (transport.publishIdentityBinding as ReturnType<typeof vi.fn>).mockReturnValue(heldPublish);

    const publishFailedEvents: Array<{ nametag: string; reason: 'taken' | 'error'; rolledBack: boolean }> = [];
    sphere.on('nametag:publish-failed', (p) => publishFailedEvents.push(p));

    await sphere.registerNametag('alice');
    expect(sphere.identity!.nametag).toBe('alice');

    // Destroy BEFORE the publish settles.
    await sphere.destroy();

    // Now let the publish settle as a relay rejection.
    resolvePublish(false);
    await flushBackgroundPublish();

    // Destroy guard suppressed the event — apps don't react to a
    // publish-failure on a wallet they've already torn down.
    expect(publishFailedEvents).toHaveLength(0);
  });

  it('background mode: switchToAddress between dispatch and resume rolls back the ORIGINAL address (review B1)', async () => {
    // Reproduces the live-reference bug the review caught: the
    // handler captures `this._payments`, `this._currentAddressIndex`,
    // `this._addressNametags`, and `this._identity` at the call site
    // (RegistrationContext), so a `switchToAddress(N)` between the
    // caller's await resolving and the publish settling does NOT
    // misdirect the rollback at the new address's PaymentsModule.
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

    // Hold the publish so we can `switchToAddress` in between.
    let resolvePublish!: (v: boolean) => void;
    const heldPublish = new Promise<boolean>((r) => { resolvePublish = r; });
    (transport.publishIdentityBinding as ReturnType<typeof vi.fn>).mockReturnValue(heldPublish);

    const publishFailedEvents: Array<{ nametag: string; reason: 'taken' | 'error'; rolledBack: boolean }> = [];
    sphere.on('nametag:publish-failed', (p) => publishFailedEvents.push(p));

    // Register `alice` on address 0.
    await sphere.registerNametag('alice');
    expect(sphere.identity!.nametag).toBe('alice');

    const address0Payments = (sphere as unknown as { _payments: PaymentsModule })._payments;
    expect(address0Payments.hasNametagNamed('alice')).toBe(true);

    // Switch to address 1 — `_payments` rotates, `_identity` swaps,
    // `_currentAddressIndex` becomes 1. Mint mock is still installed
    // on address-0's PaymentsModule, but address 1 has its own
    // (un-mocked) instance; the switch doesn't trigger any mint.
    await sphere.switchToAddress(1);
    expect(sphere.getCurrentAddressIndex()).toBe(1);
    expect(sphere.identity!.nametag).toBeUndefined(); // address 1 has no nametag

    const address1Payments = (sphere as unknown as { _payments: PaymentsModule })._payments;
    expect(address1Payments).not.toBe(address0Payments);

    // Now resolve the publish with a relay rejection.
    resolvePublish(false);
    await flushBackgroundPublish();

    // The rollback must have hit address 0's PaymentsModule, NOT
    // address 1's. Pre-fix behaviour: `this._payments.clearNametagByName`
    // would call address 1's empty store, return false, and leave
    // address 0's orphan `alice` in place.
    expect(address0Payments.hasNametagNamed('alice')).toBe(false);

    // The event still fires (with rolledBack: true).
    expect(publishFailedEvents).toHaveLength(1);
    expect(publishFailedEvents[0]).toMatchObject({
      nametag: 'alice',
      reason: 'taken',
      rolledBack: true,
    });

    // Switch back to address 0 — its identity should NOT have a
    // resurrected stale `alice` (the `_addressNametags` entry for
    // address 0 was cleared as part of the rollback).
    await sphere.switchToAddress(0);
    expect(sphere.identity!.nametag).toBeUndefined();

    await sphere.destroy();
  });

  it('should update local state after mint succeeds (background mode default)', async () => {
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

    // Background mode: local state reflects the nametag as soon as the
    // mint lands. The relay publish runs detached.
    expect(sphere.identity!.nametag).toBe('alice');

    await sphere.destroy();
  });

  it('await mode: updates local state only after both mint and publish succeed', async () => {
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

    await sphere.registerNametag('alice', { publishMode: 'await' });

    expect(sphere.identity!.nametag).toBe('alice');

    await sphere.destroy();
  });
});

describe('Sphere.registerNametag() mint/Nostr-binding consistency guard', () => {
  let storage: FileStorageProvider;
  let tokenStorage: FileTokenStorageProvider;
  let mintSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    freshTestDirs();
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
    await flushBackgroundPublish();

    // Mint is NOT called again — we already have a matching entry
    expect(callOrder).toEqual(['publish']);
    expect(mintSpy).not.toHaveBeenCalled();

    // Nostr publish for the same name DID happen
    expect(transport.publishIdentityBinding).toHaveBeenCalled();
    const args = (transport.publishIdentityBinding as ReturnType<typeof vi.fn>).mock.calls[0];
    // publishIdentityBinding is 3-arg: (chainPubkey, directAddress, nametag)
    expect(args[2]).toBe('alice');

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
    await flushBackgroundPublish();

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
    freshTestDirs();
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

  it('await mode — NAMETAG_TAKEN: publish failure throws the typed code with binding-rejected message', async () => {
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
      await sphere.registerNametag('taken', { publishMode: 'await' });
      throw new Error('Expected NAMETAG_TAKEN');
    } catch (err) {
      expect(err).toMatchObject({
        code: 'NAMETAG_TAKEN',
        message: expect.stringMatching(/binding event was rejected/),
      });
    }

    await sphere.destroy();
  });

  it('await mode — rollback: when THIS call minted the nametag and publish fails, the local entry is removed', async () => {
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

    await expect(
      sphere.registerNametag('alice', { publishMode: 'await' }),
    ).rejects.toMatchObject({
      code: 'NAMETAG_TAKEN',
    });

    // After publish failure, the just-minted nametag entry MUST be rolled
    // back so a subsequent registerNametag with a different name doesn't
    // trip NAMETAG_CONFLICT.
    expect(payments.hasNametagNamed('alice')).toBe(false);
    expect(payments.hasNametag()).toBe(false);

    await sphere.destroy();
  });

  it('await mode — rollback: does NOT remove a pre-existing nametag that was already minted', async () => {
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

    await expect(
      sphere.registerNametag('alice', { publishMode: 'await' }),
    ).rejects.toMatchObject({
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

  it('await mode — error message: mintedFresh failure surfaces "rolled back" language', async () => {
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
    await expect(
      sphere.registerNametag('fresh', { publishMode: 'await' }),
    ).rejects.toMatchObject({
      code: 'NAMETAG_TAKEN',
      message: expect.stringMatching(/orphan local nametag entry .* has been rolled back/),
    });

    await sphere.destroy();
  });
});
