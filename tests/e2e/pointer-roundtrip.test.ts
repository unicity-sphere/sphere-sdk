/**
 * E2E Test: ProfilePointerLayer round-trip against Unicity testnet.
 *
 * Exercises the pointer layer landed across the last ~24 commits
 * (Wave A unblocks this: commit d262b5c threads the oracle into
 * `createNodeProfileProviders` so Phase C of `ProfileStorageProvider.
 * doConnect()` actually constructs a ProfilePointerLayer).
 *
 * Real infrastructure:
 *   - Aggregator:  https://goggregator-test.unicity.network
 *   - Nostr relay: wss://nostr-relay.testnet.unicity.network
 *   - IPFS:        DEFAULT_IPFS_GATEWAYS (testnet)
 *   - OrbitDB:     Helia + @orbitdb/core (Node, isolated libp2p mode)
 *
 * Test shape mirrors `profile-sync.test.ts` for dataDir setup, identity
 * fixtures, timeouts, and cleanup — but drives the full `Sphere.init`
 * flow end-to-end so the pointer layer is exercised as a runtime
 * subsystem, not as a unit.
 *
 * What this test proves:
 *
 *   1. `sphere.getStorage().getPointerLayer()` is non-null after
 *      `Sphere.init` + a follow-up `storage.connect()` (see the
 *      ORDERING NOTE below), with `getPointerSkipReason() === null`.
 *      If this fails, the pointer layer is DARK and every recovery-
 *      path assertion downstream is meaningless. Wave A + the
 *      Phase-C retry-after-skip fix (commit e349863) jointly
 *      guarantee this.
 *
 *   2. `pointer.isReachable()` === true within 30s — proves the real
 *      aggregator HTTP RPC responds (HEALTH_CHECK_REQUEST_ID round-
 *      trip per SPEC §11.12).
 *
 *   3. A real save + flush + pointer publish succeeds. The
 *      `storage:saved` event carries the CID that was pinned and
 *      anchored — we capture it for the assertion below.
 *
 *   4. `pointer.recoverLatest()` returns a non-null `{cid, version}`
 *      and the CID decodes to the same bundle CID the flush published.
 *      version must be >= 1 on a clean testnet (we expect version == 1
 *      for a fresh wallet).
 *
 *   5. The BLOCKED flag is NOT set after a normal publish — ensures
 *      we did not trip any integrity guard during the round-trip.
 *
 *   6. Negative case: `pointer.recoverLatest()` on a freshly-created
 *      wallet (fresh random mnemonic, never published) returns null
 *      cleanly (no throw, no blocked state).
 *
 * ORDERING NOTE (reported back to the maintainer):
 *   `Sphere.initializeProviders` runs `storage.connect()` BEFORE
 *   `oracle.initialize()`. So Phase C of `ProfileStorageProvider.
 *   doConnect()` fires while the oracle's AggregatorClient is still
 *   null and skips with `aggregator_client_unavailable`. The Phase-C
 *   retry-after-skip fix (commit e349863) marks that reason
 *   RETRYABLE, so a later `storage.connect()` rebuilds the pointer
 *   layer. The CLI `pointer` subcommand (Wave A, d262b5c) must hit
 *   the same condition — any consumer touching the pointer layer
 *   right after `Sphere.init` either needs this explicit reconnect
 *   or a re-ordering of `initializeProviders`. This test calls
 *   `storage.connect()` explicitly so the assertions below target
 *   the pointer layer behaviour, not the initialize-ordering bug.
 *
 * Skip conditions:
 *   - `E2E_SKIP_POINTER_ROUNDTRIP=1` — explicit opt-out for CI
 *     environments without testnet access.
 *   - `NO_TESTNET=1` — ecosystem-wide convention for "no testnet".
 *
 * This test is NOT included in the default vitest run — it lives
 * under `tests/e2e/` which is excluded by vitest.config.ts. Invoke
 * explicitly via:
 *   npx vitest run --config vitest.e2e.config.ts tests/e2e/pointer-roundtrip.test.ts
 */

import { describe, it, expect, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { CID } from 'multiformats/cid';
import { Sphere } from '../../core/Sphere';
import { createNodeProviders, type NodeProviders } from '../../impl/nodejs';
import { createNodeProfileProviders } from '../../profile/node';
import { DEFAULT_IPFS_BOOTSTRAP_PEERS } from '../../constants';
import {
  NETWORK,
  DEFAULT_API_KEY,
  makeTempDirs,
  ensureTrustbase,
  rand,
} from './helpers';
import type { ProfileStorageProvider } from '../../profile/profile-storage-provider';
import type { ProfileTokenStorageProvider } from '../../profile/profile-token-storage-provider';
import type { StorageEvent, TxfStorageDataBase } from '../../storage';
import { preflightSkip } from './lib/preflight';

// =============================================================================
// Skip gates
// =============================================================================

// Suite needs `aggregator` (pointer round-trip is an aggregator RPC) and
// `nostr` (wallet identity binding events). The infra-probe runs once at
// suite start via globalSetup; if either service is unreachable we skip
// here rather than burning the 30 s pointer-isReachable timeout. Set
// E2E_SKIP_PREFLIGHT=1 to bypass the probe entirely.
const SKIP =
  process.env.E2E_SKIP_POINTER_ROUNDTRIP === '1' ||
  process.env.NO_TESTNET === '1' ||
  preflightSkip(['aggregator', 'nostr'], 'pointer-roundtrip');

// =============================================================================
// Providers — direct construction so we control oracle threading
// =============================================================================

/**
 * Build Profile-backed providers WITH the oracle threaded into the
 * Profile factory — this is the exact pattern Wave A (d262b5c) adds
 * to the CLI. Without this oracle-threading, `tryBuildPointerLayer`
 * exits with `oracle_missing` and the pointer layer is never built.
 *
 * We do NOT reuse `makeProfileProviders` from `profile-helpers.ts`
 * because it does not thread the oracle — deliberately kept so this
 * test's provider setup is self-contained and explicit about the
 * invariant it needs.
 */
function makePointerProviders(dirs: {
  dataDir: string;
  tokensDir: string;
}): NodeProviders {
  // Construct the legacy provider FIRST so its oracle (with the
  // bundled RootTrustBase and the testnet aggregator client) can be
  // passed into the Profile factory. Mirrors cli/index.ts Wave A
  // ordering exactly.
  const legacyForNonStorage = createNodeProviders({
    network: NETWORK,
    dataDir: dirs.dataDir,
    tokensDir: dirs.tokensDir,
    oracle: {
      trustBasePath: join(dirs.dataDir, 'trustbase.json'),
      apiKey: DEFAULT_API_KEY,
    },
    // No IPFS token sync — pointer layer replaces IPNS-based recovery
    // so we don't want the legacy IPFS provider fighting for the same
    // state.
    tokenSync: { ipfs: { enabled: false } },
    market: false,
    groupChat: false,
  });

  const profile = createNodeProfileProviders({
    network: NETWORK,
    dataDir: dirs.dataDir,
    oracle: legacyForNonStorage.oracle,
    profileConfig: {
      orbitDb: {
        privateKey: '', // set via setIdentity() in Sphere.init
        directory: join(dirs.dataDir, 'orbitdb'),
        bootstrapPeers: [...DEFAULT_IPFS_BOOTSTRAP_PEERS],
      },
      encrypt: true,
    },
  });

  return {
    ...legacyForNonStorage,
    storage: profile.storage,
    tokenStorage: profile.tokenStorage,
    ipfsTokenStorage: undefined,
  } as NodeProviders;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Type-narrow cast: `sphere.getStorage()` returns the generic
 * `StorageProvider`, but we know it's a `ProfileStorageProvider`
 * here because we constructed it via `createNodeProfileProviders`.
 * The two pointer-layer accessors (`getPointerLayer`,
 * `getPointerSkipReason`) live ONLY on the concrete type.
 */
function profileStorageOf(sphere: Sphere): ProfileStorageProvider {
  return sphere.getStorage() as unknown as ProfileStorageProvider;
}

function profileTokenStorageOf(sphere: Sphere): ProfileTokenStorageProvider {
  const providers = sphere.payments.getTokenStorageProviders();
  const first = providers.values().next().value;
  if (!first) {
    throw new Error(
      'No token storage provider registered — Profile factory must have produced at least one',
    );
  }
  return first as unknown as ProfileTokenStorageProvider;
}

/**
 * Wait for a `storage:saved` event carrying a `cid` in its payload.
 * The initial `storage:saved` emitted from `save()` has
 * `data.debounced === true` and NO cid — we skip that one. The
 * second `storage:saved`, emitted at the end of `flushToIpfs()`,
 * carries the published CID.
 */
function waitForFlushedCid(
  tokenStorage: ProfileTokenStorageProvider,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(
        new Error(
          `Timed out after ${timeoutMs}ms waiting for storage:saved{cid} ` +
            `event — flush did not reach publishAggregatorPointerBestEffort`,
        ),
      );
    }, timeoutMs);
    const unsubscribe = tokenStorage.onEvent((event: StorageEvent) => {
      if (event.type !== 'storage:saved') return;
      const data = event.data as { cid?: string; debounced?: boolean } | undefined;
      if (!data || typeof data.cid !== 'string') return;
      clearTimeout(timer);
      unsubscribe();
      resolve(data.cid);
    });
  });
}

/**
 * Poll `pointer.isReachable()` until it returns true or the budget
 * expires. Fails loudly if we never get a `true`, with a message that
 * clearly blames the aggregator HTTP RPC (not the test harness).
 */
async function waitForReachable(
  pointer: { isReachable(): Promise<boolean> },
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  let lastError: unknown = null;
  while (performance.now() < deadline) {
    try {
      if (await pointer.isReachable()) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(
    `Aggregator unreachable after ${timeoutMs}ms — last error: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/**
 * Minimal synthetic UXF inventory for triggering a flush. The token
 * storage provider's `save()` schedules a debounced flush; the flush
 * reads `pendingData`, builds a UXF package, pins a CAR, writes the
 * bundle ref to OrbitDB, and finally calls
 * `publishAggregatorPointerBestEffort()`. We need at least `_meta`
 * populated so the extract helpers do not bail out.
 *
 * The `archived-*` prefix keeps the tokens out of the operational-
 * state extraction path (`_outbox`, `_sent`, `_history`) and routes
 * them through the token-extraction path that ends up in the CAR.
 */
function buildSyntheticInventory(
  ownerAddress: string,
): TxfStorageDataBase {
  return {
    _meta: {
      version: 1,
      address: ownerAddress,
      formatVersion: '2.0',
      updatedAt: Date.now(),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ['archived-alpha']: { id: 'alpha', coinId: 'UCT', amount: '1000' } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ['archived-bravo']: { id: 'bravo', coinId: 'UCT', amount: '2500' } as any,
  };
}

// =============================================================================
// Test Suite
// =============================================================================

describe.skipIf(SKIP)('ProfilePointerLayer round-trip (Unicity testnet)', () => {
  const cleanupDirs: string[] = [];
  const spheres: Sphere[] = [];

  afterAll(async () => {
    // Tear spheres down first so their in-flight flushes/publishes
    // have a chance to drain cleanly before we nuke their dataDirs.
    for (const s of spheres) {
      try {
        await s.destroy();
      } catch {
        /* best-effort — test cleanup */
      }
    }
    spheres.length = 0;
    for (const d of cleanupDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    cleanupDirs.length = 0;
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Test 1: Full round-trip — publish then recover
  // ---------------------------------------------------------------------------

  it('publishes a pointer anchor and recovers it on the same wallet', async () => {
    const label = `pointer-roundtrip-${rand()}`;
    const dirs = makeTempDirs(label);
    cleanupDirs.push(dirs.base);
    await ensureTrustbase(dirs.dataDir);

    const providers = makePointerProviders(dirs);

    console.log(`\n[pointer-roundtrip] dataDir=${dirs.dataDir}`);
    console.log('[pointer-roundtrip] Creating Profile-backed wallet...');
    const t0 = performance.now();
    const { sphere, created, generatedMnemonic } = await Sphere.init({
      ...providers,
      autoGenerate: true,
      // No nametag — the on-chain mint adds ~30-60s of latency we
      // do not need for the pointer-layer assertions. The pointer
      // layer's signing key is HKDF-derived from the master key,
      // independent of the nametag.
    });
    const tInit = performance.now() - t0;
    spheres.push(sphere);

    expect(created).toBe(true);
    expect(generatedMnemonic).toBeTruthy();
    console.log(`[pointer-roundtrip] Sphere.init took ${tInit.toFixed(0)}ms`);
    console.log(`[pointer-roundtrip] identity=${sphere.identity!.l1Address}`);

    // See ORDERING NOTE at the top of this file. Force a Phase-C
    // retry now that the oracle is initialized — without this, the
    // pointer layer stays in `aggregator_client_unavailable` skip
    // state.
    const profileStorage = profileStorageOf(sphere);
    await profileStorage.connect();

    // Assertion 1: pointer layer is constructed AND skip reason is null.
    const skipReason = profileStorage.getPointerSkipReason();
    const pointer = profileStorage.getPointerLayer();
    console.log(`[pointer-roundtrip] skipReason=${skipReason ?? '(null)'}`);
    expect(skipReason).toBeNull();
    expect(pointer).not.toBeNull();
    if (!pointer) throw new Error('unreachable: narrowed by expect above');

    // Assertion 2: aggregator HTTP RPC responds to our probe within
    // 30s. This is the first real network call that hits the testnet
    // aggregator — if it fails, every subsequent publish/recover
    // assertion is guaranteed to fail too, so fail fast with a clear
    // error message instead of waiting for a publish timeout.
    console.log('[pointer-roundtrip] Probing aggregator reachability...');
    const tReach0 = performance.now();
    await waitForReachable(pointer, 30_000);
    const tReach = performance.now() - tReach0;
    console.log(`[pointer-roundtrip] isReachable=true (${tReach.toFixed(0)}ms)`);

    // Assertion 2b: BLOCKED must be false on a fresh wallet.
    const blockedBefore = await pointer.getBlockedState();
    expect(blockedBefore.blocked).toBe(false);

    // Trigger a pointer publish by calling `save()` directly on the
    // token storage provider. This schedules a debounced flush
    // which calls `flushToIpfs()` which calls
    // `publishAggregatorPointerBestEffort()`. We watch for the
    // terminal `storage:saved` event carrying the CID.
    //
    // Why NOT go through `sphere.payments.sync()`:
    //   `sync()` calls `provider.sync(localData)` (read-only merge),
    //   not `provider.save(localData)`. No flush is scheduled. A
    //   read-only sync on a fresh wallet sees no remote bundles and
    //   returns immediately with `{added:0, removed:0}`. See
    //   PaymentsModule._doSync path (lines ~5193-5210).
    //
    // Why NOT go through `sphere.payments.send()`:
    //   Would require L3 identity resolution + aggregator round-trip
    //   for the state transition, adding ~5-15s to the test and
    //   exercising subsystems unrelated to the pointer layer. A
    //   synthetic save keeps the test focused on the pointer
    //   publish/recover code path.
    const tokenStorage = profileTokenStorageOf(sphere);
    const flushWaiter = waitForFlushedCid(tokenStorage, 90_000);

    console.log('[pointer-roundtrip] Triggering save + flush...');
    const tPub0 = performance.now();
    const saveResult = await tokenStorage.save(
      buildSyntheticInventory(sphere.identity!.directAddress ?? sphere.identity!.l1Address),
    );
    expect(saveResult.success).toBe(true);

    const publishedCid = await flushWaiter;
    const tPub = performance.now() - tPub0;
    console.log(
      `[pointer-roundtrip] Flush completed in ${tPub.toFixed(0)}ms, cid=${publishedCid}`,
    );

    // Assertion 3: the published CID parses as a valid CID.
    const parsedPublished = CID.parse(publishedCid);
    expect(parsedPublished.version).toBeGreaterThanOrEqual(0);

    // Assertion 3b: BLOCKED remains false after publish.
    const blockedAfter = await pointer.getBlockedState();
    expect(blockedAfter.blocked).toBe(false);

    // Assertion 4: recoverLatest returns non-null with matching CID
    // and a version >= 1.
    console.log('[pointer-roundtrip] Recovering latest via pointer layer...');
    const tRec0 = performance.now();
    const recovered = await pointer.recoverLatest();
    const tRec = performance.now() - tRec0;
    console.log(`[pointer-roundtrip] recoverLatest took ${tRec.toFixed(0)}ms`);

    expect(recovered).not.toBeNull();
    if (!recovered) throw new Error('unreachable: narrowed by expect above');
    expect(recovered.version).toBeGreaterThanOrEqual(1);

    // The CID bytes decoded by the pointer layer must match the CID
    // the flush published. This is the critical end-to-end assertion
    // — it proves the anchor we published IS the anchor the discover
    // algorithm finds.
    const recoveredCidString = CID.decode(recovered.cid).toString();
    expect(recoveredCidString).toBe(publishedCid);
    console.log(
      `[pointer-roundtrip] recovered v=${recovered.version} cid=${recoveredCidString}`,
    );

    // Summary line for operator logs.
    console.log(
      `[pointer-roundtrip] TIMING init=${tInit.toFixed(0)}ms ` +
        `reach=${tReach.toFixed(0)}ms publish=${tPub.toFixed(0)}ms ` +
        `recover=${tRec.toFixed(0)}ms`,
    );
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Test 2: Negative — fresh wallet has no anchor to recover
  // ---------------------------------------------------------------------------

  it('returns null from recoverLatest on a freshly-created wallet that has never published', async () => {
    const label = `pointer-empty-${rand()}`;
    const dirs = makeTempDirs(label);
    cleanupDirs.push(dirs.base);
    await ensureTrustbase(dirs.dataDir);

    const providers = makePointerProviders(dirs);

    // Fresh mnemonic — guaranteed to have never published a pointer
    // anchor against the testnet aggregator (keyspace is 2^256).
    const { sphere } = await Sphere.init({
      ...providers,
      autoGenerate: true,
    });
    spheres.push(sphere);

    // Same ordering workaround as the positive test — reconnect
    // triggers Phase C retry now that the oracle is initialized.
    const profileStorage = profileStorageOf(sphere);
    await profileStorage.connect();

    const pointer = profileStorage.getPointerLayer();
    expect(pointer).not.toBeNull();
    if (!pointer) throw new Error('unreachable: narrowed by expect above');

    // Must return null WITHOUT throwing. A fresh wallet must not
    // leave the pointer layer in a BLOCKED state from the discovery
    // probe alone — BLOCKED is reserved for integrity violations
    // (§10.2).
    const recovered = await pointer.recoverLatest();
    expect(recovered).toBeNull();

    const blocked = await pointer.getBlockedState();
    expect(blocked.blocked).toBe(false);

    console.log('[pointer-empty] recoverLatest returned null as expected');
  }, 60_000);
});
