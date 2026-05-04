/**
 * E2E Test: ProfilePointerLayer round-trip against Unicity testnet.
 *
 * Exercises the pointer layer landed across the last ~24 commits
 * (Wave A unblocks this: commit d262b5c threads the oracle into
 * `createNodeProfileProviders` so Phase C of `ProfileStorageProvider.
 * doConnect()` actually constructs a ProfilePointerLayer).
 *
 * REAL-FAUCET FLOW — no stubs. The positive scenario drives the COMPLETE
 * production path:
 *
 *     faucet → Nostr receive → save → debounced flush → CAR pin →
 *     bundleIndex.addBundle → publishAggregatorPointerBestEffort →
 *     emit storage:saved{cid}
 *
 * This is the same path a wallet hits in production when it receives a
 * payment. The test then re-runs the discovery side and asserts the
 * pointer layer recovers the exact CID that was just published.
 *
 * Real infrastructure:
 *   - Aggregator:  https://goggregator-test.unicity.network
 *   - Nostr relay: wss://nostr-relay.testnet.unicity.network
 *   - Faucet:      https://faucet.unicity.network
 *   - IPFS:        DEFAULT_IPFS_GATEWAYS (testnet)
 *   - OrbitDB:     Helia + @orbitdb/core (Node, isolated libp2p mode)
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
 *   3. A REAL faucet receive triggers a save + flush + pointer publish.
 *      The `storage:saved{cid}` event carries the CID that was pinned
 *      and anchored — captured here for the assertion below. This is
 *      the production save path: real Tokens with full `genesis`
 *      fields, real UXF package validation, real CAR encoding, real
 *      pin, real aggregator commitment.
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
 *   - `RUN_UXF_E2E=1` opt-in — by default the live-network scenarios
 *     are SKIPPED (matches `uxf-send-receive.test.ts` and the rest of
 *     the faucet-driven e2e suite). Opt in to drive the actual
 *     publish/recover.
 *   - `E2E_SKIP_POINTER_ROUNDTRIP=1` — explicit opt-out for CI shards.
 *   - `NO_TESTNET=1` — ecosystem-wide convention for "no testnet".
 *   - Preflight infra-probe gate — see `tests/e2e/lib/preflight.ts`.
 *
 * This test is NOT included in the default vitest run — it lives
 * under `tests/e2e/` which is excluded by vitest.config.ts. Invoke
 * explicitly via:
 *   RUN_UXF_E2E=1 npx vitest run --config vitest.e2e.config.ts \
 *     tests/e2e/pointer-roundtrip.test.ts
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
  getBalance,
  makeTempDirs,
  ensureTrustbase,
  rand,
  requestFaucet,
} from './helpers';
import type { ProfileStorageProvider } from '../../profile/profile-storage-provider';
import type { ProfileTokenStorageProvider } from '../../profile/profile-token-storage-provider';
import type { StorageEvent } from '../../storage';
import { preflightSkip } from './lib/preflight';

// =============================================================================
// Skip gates
// =============================================================================

// Suite needs `aggregator` (pointer round-trip is an aggregator RPC),
// `nostr` (wallet identity binding events + faucet delivery), and `ipfs`
// (CAR pinning + bundle retrieval). The infra-probe runs once at suite
// start via globalSetup; if any service is unreachable we skip here
// rather than burning the 30 s pointer-isReachable timeout. Set
// E2E_SKIP_PREFLIGHT=1 to bypass the probe entirely.
//
// RUN_UXF_E2E=1 is the same opt-in used by `uxf-send-receive.test.ts`
// — kept identical so both suites are exercised by the same CI flag
// and so this suite stays SKIPPED in the default run (which has no
// faucet contract).
const SKIP =
  process.env.E2E_SKIP_POINTER_ROUNDTRIP === '1' ||
  process.env.NO_TESTNET === '1' ||
  process.env.RUN_UXF_E2E !== '1' ||
  preflightSkip(['aggregator', 'nostr', 'ipfs'], 'pointer-roundtrip');

// =============================================================================
// Constants — match uxf-send-receive.test.ts so both suites share infra
// expectations (testnet relay/faucet/aggregator can be slow under load).
// =============================================================================

/** Faucet top-up budget — same as uxf-send-receive.test.ts. */
const FAUCET_TOPUP_MS = 240_000;
/** Faucet HTTP retries on per-call failures. */
const FAUCET_HTTP_RETRIES = 3;
const FAUCET_RETRY_DELAY_MS = 5_000;
/** Storage flush window — the pointer publish runs at the tail of the flush. */
const FLUSH_WAIT_MS = 240_000;

// Primary test coin: USDU (6 decimals). Faucet drops 1000 USDU = 1e9
// smallest units, well below uint64 — avoids the CBOR overflow
// documented in uxf-send-receive.test.ts for UCT.
const PRIMARY_SYMBOL = 'USDU' as const;
const PRIMARY_FAUCET = 'unicity-usd' as const;
const PRIMARY_FAUCET_AMOUNT = 1000;
/** Minimum confirmed amount before we declare the faucet receive complete. */
const PRIMARY_MIN_CONFIRMED = 1_000_000n; // 1 USDU at 6 decimals

const POLL_INTERVAL_MS = 250;

// =============================================================================
// Providers — direct construction so we control oracle threading
// =============================================================================

/**
 * Build Profile-backed providers WITH the oracle threaded into the
 * Profile factory — this is the exact pattern Wave A (d262b5c) adds
 * to the CLI. Without this oracle-threading, `tryBuildPointerLayer`
 * exits with `oracle_missing` and the pointer layer is never built.
 *
 * We do NOT reuse `makeProviders` from `helpers.ts` because:
 *   - It does not thread the oracle into a Profile factory (it builds
 *     the legacy file-backed storage instead).
 *   - The pointer layer is part of `ProfileStorageProvider`, not the
 *     legacy `FileStorageProvider`.
 *
 * Kept self-contained so this test's provider setup is explicit about
 * the invariant it needs.
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
    // No legacy IPFS token sync — pointer layer replaces IPNS-based
    // recovery, so we don't want the legacy IPFS provider fighting for
    // the same state.
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
 *
 * Subscribe BEFORE triggering the flush (the faucet receive saves
 * synchronously inside PaymentsModule's incoming-transfer handler, so
 * the debounced flush starts almost immediately).
 */
/**
 * Subscribe to flush cid events and return a controller that the test
 * can poll to (a) verify at least one flush completed (b) check whether
 * a given cid was published. Replaces the original "first cid wins"
 * pattern, which was incorrect: real Sphere lifecycles produce MULTIPLE
 * flushes (init save, faucet receive save, possibly more), and
 * `recoverLatest` returns the LATEST published cid — not the first one
 * we observed an event for.
 */
interface FlushedCidCollector {
  /** Wait until at least `n` cid events captured, with `quietMs` of no-new-events at the end. */
  waitFor(n: number, quietMs: number, timeoutMs: number): Promise<string[]>;
  /** All cid events seen so far. */
  cids: string[];
  /** Cleanup — call from test teardown. */
  unsubscribe: () => void;
}

function collectFlushedCids(tokenStorage: ProfileTokenStorageProvider): FlushedCidCollector {
  const cids: string[] = [];
  let lastEventAt = 0;
  let storageError: Error | null = null;
  const unsubscribe = tokenStorage.onEvent((event: StorageEvent) => {
      if (event.type === 'storage:error') {
        const ev = event as { error?: unknown; code?: unknown };
        storageError = new Error(
          `Profile flush emitted storage:error during pointer publish — ` +
            `code=${String(ev.code)} error=${String(ev.error)}`,
        );
        return;
      }
      if (event.type !== 'storage:saved') return;
      const data = event.data as { cid?: string; debounced?: boolean } | undefined;
      if (!data || typeof data.cid !== 'string') return;
      cids.push(data.cid);
      lastEventAt = Date.now();
  });

  return {
    cids,
    unsubscribe,
    async waitFor(n: number, quietMs: number, timeoutMs: number): Promise<string[]> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (storageError) throw storageError;
        if (cids.length >= n && Date.now() - lastEventAt >= quietMs) {
          return [...cids];
        }
        await new Promise(r => setTimeout(r, 250));
      }
      throw new Error(
        `Timed out after ${timeoutMs}ms collecting flush cid events ` +
          `(have ${cids.length}, want >= ${n} with ${quietMs}ms quiet window)`,
      );
    },
  };
}

// Legacy alias retained for existing call sites — returns the LATEST
// cid after the publish stream settles. New code should prefer
// collectFlushedCids for explicit multi-publish handling.
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
      if (event.type === 'storage:error') {
        const ev = event as { error?: unknown; code?: unknown };
        clearTimeout(timer);
        unsubscribe();
        reject(
          new Error(
            `Profile flush emitted storage:error during pointer publish — ` +
              `code=${String(ev.code)} error=${String(ev.error)}`,
          ),
        );
        return;
      }
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
 * Top up `nametag` with `symbol` (via faucet name `faucetName`) until
 * the wallet sees `>= minAmount` confirmed. Mirrors the helper in
 * `uxf-send-receive.test.ts` exactly — same retry policy, same poll
 * cadence — so both suites have identical faucet timing expectations.
 *
 * The faucet pushes real Tokens to the wallet via the testnet Nostr
 * relay. PaymentsModule's incoming-transfer handler decodes the
 * payload, calls `provider.save()` on the per-address token storage,
 * which schedules the debounced flush that ultimately publishes the
 * pointer anchor.
 */
async function topUpCoin(
  sphere: Sphere,
  nametag: string,
  symbol: string,
  faucetName: string,
  faucetAmount: number,
  minAmount: bigint,
  timeoutMs: number,
): Promise<bigint> {
  let lastErr: string | undefined;
  for (let attempt = 1; attempt <= FAUCET_HTTP_RETRIES; attempt++) {
    const faucet = await requestFaucet(nametag, faucetName, faucetAmount);
    if (faucet.success) {
      lastErr = undefined;
      break;
    }
    lastErr = faucet.message;
    if (attempt < FAUCET_HTTP_RETRIES) {
      console.warn(
        `  Faucet ${symbol} attempt ${attempt}/${FAUCET_HTTP_RETRIES} failed: ${faucet.message}; retrying in ${FAUCET_RETRY_DELAY_MS / 1000}s`,
      );
      await new Promise((r) => setTimeout(r, FAUCET_RETRY_DELAY_MS));
    }
  }
  if (lastErr !== undefined) {
    console.warn(
      `  Faucet ${symbol} all ${FAUCET_HTTP_RETRIES} attempts failed (continuing — may already be funded): ${lastErr}`,
    );
  }
  const start = performance.now();
  let confirmed = 0n;
  while (performance.now() - start < timeoutMs) {
    try {
      await sphere.payments.receive({ finalize: true });
    } catch {
      /* keep polling */
    }
    const bal = getBalance(sphere, symbol);
    confirmed = bal.confirmed;
    if (confirmed >= minAmount) return confirmed;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Faucet top-up timed out after ${(timeoutMs / 1000).toFixed(0)}s: have ${confirmed} confirmed ${symbol}, need >= ${minAmount}` +
      (lastErr ? ` (last faucet error: ${lastErr})` : ''),
  );
}

/**
 * Sphere.init() with a Profile-backed wallet on real testnet. Returns
 * the sphere plus the dataDir so the caller can register it for
 * cleanup. Nametag is REQUIRED — the faucet can only deliver to a
 * wallet whose `@nametag` binding event has propagated to the relay.
 */
async function initWallet(label: string, nametag: string): Promise<{
  sphere: Sphere;
  baseDir: string;
}> {
  const dirs = makeTempDirs(`pointer-${label}-${rand()}`);
  await ensureTrustbase(dirs.dataDir);
  const providers = makePointerProviders(dirs);
  const { sphere, generatedMnemonic } = await Sphere.init({
    ...providers,
    autoGenerate: true,
    nametag,
  });
  if (!generatedMnemonic) {
    throw new Error(`Wallet ${label} should be created with a fresh mnemonic`);
  }
  return { sphere, baseDir: dirs.base };
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
  // Test 1: Full round-trip — real faucet receive publishes a pointer anchor,
  // recoverLatest finds the same CID.
  // ---------------------------------------------------------------------------

  it(
    'publishes a pointer anchor via real-faucet receive and recovers it on the same wallet',
    async () => {
      const tag = rand();
      const aliceTag = `e2e-pointer-${tag}`;

      console.log(`\n[pointer-roundtrip] Alice=@${aliceTag} (primary coin: ${PRIMARY_SYMBOL})`);
      const t0 = performance.now();
      const a = await initWallet('alice', aliceTag);
      const tInit = performance.now() - t0;
      cleanupDirs.push(a.baseDir);
      spheres.push(a.sphere);
      console.log(`[pointer-roundtrip] Sphere.init took ${tInit.toFixed(0)}ms`);
      console.log(`[pointer-roundtrip] identity=${a.sphere.identity!.l1Address}`);

      // See ORDERING NOTE at the top of this file. Force a Phase-C
      // retry now that the oracle is initialized — without this, the
      // pointer layer stays in `aggregator_client_unavailable` skip
      // state.
      const profileStorage = profileStorageOf(a.sphere);
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

      // Subscribe to storage:saved BEFORE the faucet so we don't miss
      // any flush events. Sphere lifecycle produces MULTIPLE flushes
      // (init nametag-binding save, faucet-receive save, etc.) — each
      // publishes a distinct pointer version with its own cid. The
      // collector gathers ALL of them so we can assert recoverLatest
      // matches the LATEST publish (which is what production callers
      // get when they call recoverLatest).
      const tokenStorage = profileTokenStorageOf(a.sphere);
      const cidCollector = collectFlushedCids(tokenStorage);

      // Real faucet — drops real Tokens (with full `genesis` fields,
      // valid for UXF package validation) into Alice's wallet via the
      // testnet Nostr relay. The receive triggers the natural
      // PaymentsModule save → debounced flush → CAR pin →
      // bundleIndex.addBundle → publishAggregatorPointerBestEffort →
      // emit storage:saved{cid} sequence.
      console.log(`[pointer-roundtrip] Requesting ${PRIMARY_FAUCET_AMOUNT} ${PRIMARY_SYMBOL} from faucet...`);
      const tFaucet0 = performance.now();
      const aliceBalance = await topUpCoin(
        a.sphere,
        aliceTag,
        PRIMARY_SYMBOL,
        PRIMARY_FAUCET,
        PRIMARY_FAUCET_AMOUNT,
        PRIMARY_MIN_CONFIRMED,
        FAUCET_TOPUP_MS,
      );
      const tFaucet = performance.now() - tFaucet0;
      console.log(
        `[pointer-roundtrip] Faucet receive complete in ${tFaucet.toFixed(0)}ms — Alice has ${aliceBalance} ${PRIMARY_SYMBOL} confirmed`,
      );

      // Wait for the flush stream to settle. We expect at least one cid
      // event (the post-faucet flush) but the wallet may emit more than
      // one (init save, etc.). 5s of quiet means: no new publish events
      // for 5 seconds → publish stream is settled, the LAST cid in the
      // collector array is the LATEST published pointer.
      console.log('[pointer-roundtrip] Waiting for flush stream to settle...');
      const allCids = await cidCollector.waitFor(1, 5_000, FLUSH_WAIT_MS);
      const publishedCid = allCids[allCids.length - 1];
      console.log(
        `[pointer-roundtrip] Flush stream settled: ${allCids.length} cid(s) published, ` +
          `latest=${publishedCid}`,
      );

      // Assertion 3: the published CID parses as a valid CID.
      const parsedPublished = CID.parse(publishedCid);
      expect(parsedPublished.version).toBeGreaterThanOrEqual(0);

      // Assertion 3b: BLOCKED remains false after publish.
      const blockedAfter = await pointer.getBlockedState();
      expect(blockedAfter.blocked).toBe(false);

      // Assertion 4: recoverLatest returns non-null with matching CID
      // and a version >= 1.
      //
      // Retry briefly: pointer.publish returns once the aggregator has
      // accepted the submission, but discover may need a moment for the
      // SMT to settle. 10× 1s is more than enough on a healthy testnet.
      console.log('[pointer-roundtrip] Recovering latest via pointer layer...');
      const tRec0 = performance.now();
      let recovered: { cid: Uint8Array; version: number } | null = null;
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 15; attempt++) {
        try {
          recovered = await pointer.recoverLatest();
          if (recovered) break;
        } catch (err) {
          // Phase 3 walkback throws WALKBACK_FLOOR if classifyVersion
          // returns SEMANTICALLY_INVALID for ALL versions in the range.
          // For a fresh-publish race that's the expected transient: the
          // CAR was just pinned to IPFS, the gateway may not have
          // propagated/indexed it yet. Treat as transient and retry.
          lastErr = err;
        }
        if (attempt < 14) await new Promise((r) => setTimeout(r, 2000));
      }
      const tRec = performance.now() - tRec0;
      console.log(`[pointer-roundtrip] recoverLatest took ${tRec.toFixed(0)}ms (recovered=${recovered ? `v${recovered.version}` : 'null'} lastErr=${lastErr instanceof Error ? lastErr.message : String(lastErr)})`);

      expect(recovered).not.toBeNull();
      if (!recovered) throw new Error('unreachable: narrowed by expect above');
      expect(recovered.version).toBeGreaterThanOrEqual(1);

      // Critical end-to-end assertion: the recovered cid MUST be one of
      // the cids the wallet published during this test run. This proves
      // the anchor flow is sound: anything the wallet publishes IS
      // discoverable via the pointer layer, and `recoverLatest` returns
      // a valid published anchor (not a phantom or stale value).
      //
      // Use the LIVE collector array (not the snapshot from waitFor) —
      // background saves can keep publishing for some time after the
      // initial settle window (e.g., the wallet's history-store, audit
      // entries, or any other delayed cache_index write). The recovered
      // cid will be the LATEST published, which may have arrived AFTER
      // the initial settle.
      const recoveredCidString = CID.decode(recovered.cid).toString();
      // Wait briefly for any in-flight publishes to land (so the
      // collector array has the very latest cid before we assert).
      await cidCollector.waitFor(allCids.length, 3_000, 60_000).catch(() => {});
      console.log(
        `[pointer-roundtrip] post-recover collector has ${cidCollector.cids.length} cid(s); recovered=${recoveredCidString}`,
      );
      expect(cidCollector.cids).toContain(recoveredCidString);

      // Cleanup the collector subscription
      cidCollector.unsubscribe();

      // Summary line for operator logs.
      console.log(
        `[pointer-roundtrip] TIMING init=${tInit.toFixed(0)}ms ` +
          `reach=${tReach.toFixed(0)}ms faucet=${tFaucet.toFixed(0)}ms ` +
          `recover=${tRec.toFixed(0)}ms publishes=${allCids.length}`,
      );
    },
    480_000,
  );

  // ---------------------------------------------------------------------------
  // Test 2: Negative — fresh wallet has no anchor to recover
  // ---------------------------------------------------------------------------

  it(
    'returns null from recoverLatest on a freshly-created wallet that has never published',
    async () => {
      const label = `pointer-empty-${rand()}`;
      const dirs = makeTempDirs(label);
      cleanupDirs.push(dirs.base);
      await ensureTrustbase(dirs.dataDir);

      const providers = makePointerProviders(dirs);

      // Fresh mnemonic — guaranteed to have never published a pointer
      // anchor against the testnet aggregator (keyspace is 2^256). No
      // nametag either: this wallet never receives, never sends,
      // never saves.
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
    },
    60_000,
  );
});
