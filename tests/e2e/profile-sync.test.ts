/**
 * E2E Test: Profile (OrbitDB) Sync against real Unicity infrastructure.
 *
 * Exercises the Profile stack via REAL production paths — no synthetic
 * Token stubs, no fake `{id, coinId, amount}` shapes. Every Token that
 * lands in OrbitDB / a CAR bundle is sourced from the live testnet
 * faucet so the package round-trip exercises the full UXF schema
 * (`genesis`, transitions, and aggregator inclusion proofs).
 *
 * What this validates:
 *   - `ProfileStorageProvider` (local file cache + OrbitDB via Helia)
 *     KV write/read round-trip — exercised through `Sphere.init({ nametag })`
 *     which writes the nametag binding via the StorageProvider, then
 *     re-imported and verified.
 *   - `ProfileTokenStorageProvider` (CAR pin/fetch via live IPFS)
 *     pin-and-reload round-trip — exercised via real-faucet Tokens packaged
 *     into a CAR, pinned to IPFS, and recovered from a fresh wallet that
 *     reloads the bundle from `OrbitDB pointer → IPFS gateway → UXF decode`.
 *
 * Requires network access:
 *   - Nostr testnet relay (faucet → wallet token delivery)
 *   - Aggregator testnet (commitment submission, inclusion proofs)
 *   - `https://unicity-ipfs1.dyndns.org` (CAR pin/fetch HTTP API)
 *   - `DEFAULT_IPFS_BOOTSTRAP_PEERS` (libp2p gossipsub for OrbitDB replication)
 *
 * Each test uses a fresh randomised nametag so there is no cross-run state.
 *
 * Run with: `npm run test:e2e`.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { Sphere } from '../../core/Sphere';
import {
  rand,
  makeTempDirs,
  ensureTrustbase,
  requestFaucet,
  getBalance,
  POLL_INTERVAL_MS,
} from './helpers';
import { makeProfileProviders, unwrapProfileProviders } from './profile-helpers';
import { preflightSkip } from './lib/preflight';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKIP_INFRA = preflightSkip(['nostr', 'aggregator', 'ipfs', 'faucet'], 'profile-sync');

// Faucet primary coin: USDU (6 decimals). 1000 USDU = 1e9 smallest units —
// well below the uint64 ceiling, so no CBOR overflow for the CAR encoder.
const PRIMARY_SYMBOL = 'USDU' as const;
const PRIMARY_FAUCET = 'unicity-usd' as const;
const PRIMARY_FAUCET_AMOUNT = 1000;
const MIN_CONFIRMED = 1_000n; // smallest-unit threshold (1 USDU)

const FAUCET_TOPUP_MS = 240_000;
// 100s covers the worst-case aggregator pointer poll cycle
// ([30s, 90s) + margin). The aggregator is the authoritative source
// for the latest pointer version; even if pubsub between devices fails
// (Helia peer discovery, NAT, etc.), the periodic poll guarantees
// eventual sync within this window. Early-exit on first success.
const RECOVERY_SYNC_MS = 100_000;

// Faucet HTTP retries (the faucet's nametag-resolve relay flaps under load).
const FAUCET_HTTP_RETRIES = 3;
const FAUCET_RETRY_DELAY_MS = 5_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Top up `nametag` with primary coin via real faucet until the wallet
 * sees `>= minAmount` confirmed. Throws on timeout. Mirrors the helper
 * used by `uxf-send-receive.test.ts` so the real-faucet flow is identical.
 */
async function topUpPrimaryCoin(
  sphere: Sphere,
  nametag: string,
  minAmount: bigint,
  timeoutMs: number,
): Promise<bigint> {
  let lastErr: string | undefined;
  for (let attempt = 1; attempt <= FAUCET_HTTP_RETRIES; attempt++) {
    const faucet = await requestFaucet(nametag, PRIMARY_FAUCET, PRIMARY_FAUCET_AMOUNT);
    if (faucet.success) {
      lastErr = undefined;
      break;
    }
    lastErr = faucet.message;
    if (attempt < FAUCET_HTTP_RETRIES) {
      console.warn(
        `  Faucet ${PRIMARY_SYMBOL} attempt ${attempt}/${FAUCET_HTTP_RETRIES} failed: ${faucet.message}; retrying in ${FAUCET_RETRY_DELAY_MS / 1000}s`,
      );
      await new Promise((r) => setTimeout(r, FAUCET_RETRY_DELAY_MS));
    }
  }
  if (lastErr !== undefined) {
    console.warn(
      `  Faucet ${PRIMARY_SYMBOL} all ${FAUCET_HTTP_RETRIES} attempts failed (continuing — may already be funded): ${lastErr}`,
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
    const bal = getBalance(sphere, PRIMARY_SYMBOL);
    confirmed = bal.confirmed;
    if (confirmed >= minAmount) return confirmed;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Faucet top-up timed out after ${(timeoutMs / 1000).toFixed(0)}s: have ${confirmed} confirmed ${PRIMARY_SYMBOL}, need >= ${minAmount}` +
      (lastErr ? ` (last faucet error: ${lastErr})` : ''),
  );
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_INFRA)('Profile (OrbitDB + IPFS) Sync E2E', () => {
  const cleanupDirs: string[] = [];
  const spheres: Sphere[] = [];

  afterAll(async () => {
    for (const s of spheres) {
      try {
        await s.destroy();
      } catch {
        /* cleanup */
      }
    }
    spheres.length = 0;
    for (const d of cleanupDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* cleanup */
      }
    }
    cleanupDirs.length = 0;
  });

  // -------------------------------------------------------------------------
  // Test 1: ProfileStorageProvider — KV write round-trip via real nametag
  //
  // Real production path:
  //   Sphere.init({ nametag })
  //     → registers nametag on Nostr
  //     → ProfileStorageProvider.set(...) [OrbitDB write]
  //     → encrypted, replicated, persisted to local cache
  //
  //   destroy() + Sphere.import({ mnemonic })
  //     → ProfileStorageProvider.get(...) [OrbitDB read]
  //     → identity reconstructed with nametag intact
  //
  // No stubs — the value written is the real binding produced by
  // the nametag registration flow.
  // -------------------------------------------------------------------------

  it('ProfileStorageProvider round-trips a real nametag via OrbitDB on a fresh load', async () => {
    const nametag = `e2e-prof-sync-${rand()}`;
    const dirs = makeTempDirs('profile-sync-kv');
    cleanupDirs.push(dirs.base);
    await ensureTrustbase(dirs.dataDir);

    const providers = makeProfileProviders(dirs);
    const { storage } = unwrapProfileProviders(providers);

    console.log(`\n[Test 1] Creating Profile-backed wallet @${nametag}...`);
    const { sphere, created, generatedMnemonic } = await Sphere.init({
      ...providers,
      autoGenerate: true,
      nametag,
    });
    spheres.push(sphere);

    expect(created).toBe(true);
    expect(generatedMnemonic).toBeTruthy();
    const savedMnemonic = generatedMnemonic!;

    // OrbitDB connection is live for the wallet's identity.
    expect(storage.isConnected()).toBe(true);
    expect(sphere.identity?.nametag).toBe(nametag);

    // Cold-start the wallet from the same dataDir + mnemonic to prove the
    // value survived an OrbitDB read on a fresh load. We tear down only the
    // sphere — the on-disk OrbitDB directory and file cache are preserved
    // so the next import is genuinely reading from the persisted store.
    console.log(`  Destroying sphere (preserving Profile storage)...`);
    await sphere.destroy();
    spheres.splice(spheres.indexOf(sphere), 1);

    // Rebuild providers against the SAME on-disk directory.
    const providers2 = makeProfileProviders(dirs);

    console.log(`  Re-importing wallet from mnemonic (Profile read)...`);
    const sphere2 = await Sphere.import({
      ...providers2,
      mnemonic: savedMnemonic,
    });
    spheres.push(sphere2);

    // Round-trip assertion: the nametag survived the OrbitDB write/read.
    // This proves ProfileStorageProvider.set + flush + load + get all work
    // end to end against real Helia/OrbitDB.
    expect(sphere2.identity?.nametag).toBe(nametag);

    console.log(`[Test 1] PASSED: nametag @${nametag} round-tripped through OrbitDB`);
  }, 240_000);

  // -------------------------------------------------------------------------
  // Test 2: ProfileTokenStorageProvider — CAR pin + reload via real faucet
  //
  // Real production path:
  //   Sphere.init({ nametag })
  //     → faucet drops real Tokens via Nostr
  //     → PaymentsModule.receive() finalizes them
  //     → ProfileTokenStorageProvider.save() debounced
  //     → flushScheduler packages tokens into a UXF CAR
  //     → CAR pinned to live IPFS gateway
  //     → bundle CID recorded in OrbitDB under `tokens.bundle.*`
  //
  //   destroy() + Sphere.import({ mnemonic })
  //     → fresh wallet reads OrbitDB for bundle CIDs
  //     → fetchFromIpfs(gateways, cid) pulls the CAR bytes
  //     → UxfPackage.fromCar(carBytes) decodes the package
  //     → assembleAll() reconstructs Token instances
  //     → PaymentsModule loads them as confirmed
  //
  // No stubs — every byte travels through production code with real
  // testnet-issued tokens carrying real `genesis` fields.
  // -------------------------------------------------------------------------

  it('ProfileTokenStorageProvider pins real tokens to a CAR and recovers them on a fresh load', async () => {
    // Nametag regex caps at 20 chars; `e2e-pscar-` (10) + rand() (6) = 16.
    const nametag = `e2e-pscar-${rand()}`;
    let dirs = makeTempDirs('profile-sync-car');
    cleanupDirs.push(dirs.base);
    await ensureTrustbase(dirs.dataDir);

    // Suppress the auto-debouncer so all faucet / receive activity
    // coalesces into one pending state, then a single explicit
    // `awaitNextFlush()` below produces V1 only — deterministic publish,
    // no race with subsequent debounce ticks.
    const providers = makeProfileProviders(dirs, { flushDebounceMs: 300_000 });
    const { storage, tokenStorage } = unwrapProfileProviders(providers);

    console.log(`\n[Test 2] Creating Profile-backed wallet @${nametag}...`);
    const { sphere, generatedMnemonic } = await Sphere.init({
      ...providers,
      autoGenerate: true,
      nametag,
    });
    spheres.push(sphere);

    expect(storage.isConnected()).toBe(true);
    expect(generatedMnemonic).toBeTruthy();
    const savedMnemonic = generatedMnemonic!;

    // ---- Real faucet — drops real Tokens via Nostr → PaymentsModule.receive()
    //      → ProfileTokenStorageProvider.save() → CAR pin → bundle ref in OrbitDB.
    console.log(`  Faucet ${PRIMARY_SYMBOL} for @${nametag}...`);
    const aBalance = await topUpPrimaryCoin(sphere, nametag, MIN_CONFIRMED, FAUCET_TOPUP_MS);
    console.log(`  Wallet has ${aBalance} ${PRIMARY_SYMBOL} confirmed`);
    expect(aBalance).toBeGreaterThanOrEqual(MIN_CONFIRMED);

    // Capture the original token IDs + amounts to compare after recovery.
    const originalTokens = sphere.payments.getTokens().filter((t) => t.symbol === PRIMARY_SYMBOL);
    expect(originalTokens.length).toBeGreaterThan(0);
    const originalIds = new Set(originalTokens.map((t) => t.id));
    const originalAmounts = new Map(originalTokens.map((t) => [t.id, t.amount]));
    // Sanity check: real testnet tokens carry a TXF genesis inside sdkData
    // (the public Token type doesn't expose `genesis` directly). Guards
    // against accidental regression to synthetic stubs.
    for (const t of originalTokens) {
      expect(t.sdkData).toBeTruthy();
      const parsed = JSON.parse(t.sdkData!) as { genesis?: unknown };
      expect(parsed.genesis).toBeTruthy();
    }

    // Drain pending V5 finalizations and snapshot local state so any
    // unfinalized token is included in the upcoming lean-snapshot CAR.
    console.log(`  Draining pending V5 finalizations + saving local state...`);
    await sphere.payments.sync({ drainTimeoutMs: 60_000 });

    // Full-profile-sync: force ONE explicit lean-snapshot publish by
    // calling `awaitNextFlush()` on the token-storage provider. The
    // raised `flushDebounceMs` (5 min, see makeProfileProviders) means
    // the auto-debouncer has not fired during reception — all saves
    // coalesced into one pending state. This serialized flush:
    //   1. builds the lean profile snapshot CAR from the merged state,
    //   2. pins it to live IPFS,
    //   3. publishes the snapshot CID at V1 via the aggregator pointer.
    // Because V1 is the FIRST version on a fresh wallet, Phase-3
    // walkback is skipped entirely — no V_n→V_(n-1) CAR fetch is
    // attempted, so the publish does not race aggregator-gateway CAR
    // propagation. Successive publishes (V2+) WOULD race; we explicitly
    // suppress them via the long debounce + single-shot flush pattern
    // that the full-profile-sync integration test models.
    console.log(`  Publishing lean profile snapshot to IPFS + aggregator pointer...`);
    await tokenStorage.awaitNextFlush(120_000);

    // Allow IPFS replication so Device B's `recoverLatest()` finds the
    // freshly-pinned snapshot CAR via the aggregator's reachable
    // gateway. 10s mirrors the bootstrap-peer pubsub buffer that
    // `ipfs-multi-device-sync.test.ts` uses for the same purpose.
    console.log(`  Waiting 10s for IPFS replication to aggregator gateways...`);
    await new Promise((r) => setTimeout(r, 10_000));

    // ---- Cold-start a fresh wallet from the SAME mnemonic but a NEW
    //      data directory — simulates moving to a different device.
    console.log(`  Destroying wallet and wiping local storage...`);
    await sphere.destroy();
    spheres.splice(spheres.indexOf(sphere), 1);
    rmSync(dirs.base, { recursive: true, force: true });
    cleanupDirs.splice(cleanupDirs.indexOf(dirs.base), 1);

    dirs = makeTempDirs('profile-sync-car-recovered');
    cleanupDirs.push(dirs.base);
    await ensureTrustbase(dirs.dataDir);
    const providers2 = makeProfileProviders(dirs);

    console.log(`  Re-importing wallet from mnemonic (CAR pin recovery)...`);
    const sphere2 = await Sphere.import({
      ...providers2,
      mnemonic: savedMnemonic,
    });
    spheres.push(sphere2);

    // Sync from the Profile layer — pulls the CAR bundle ref from
    // OrbitDB, fetches the CAR from the live IPFS gateway, decodes it,
    // and assembles the Tokens. This is the real production reload.
    console.log(`  Syncing tokens from Profile layer (OrbitDB → IPFS → CAR)...`);
    const syncDeadline = performance.now() + RECOVERY_SYNC_MS;
    let lastSyncAdded = 0;
    while (performance.now() < syncDeadline) {
      try {
        const result = await sphere2.payments.sync();
        lastSyncAdded += result.added;
      } catch (err) {
        console.log(`  sync() attempt failed: ${err instanceof Error ? err.message : err}`);
      }
      const bal = getBalance(sphere2, PRIMARY_SYMBOL);
      if (bal.total >= MIN_CONFIRMED) break;
      await new Promise((r) => setTimeout(r, 10_000));
    }

    const recoveredBal = getBalance(sphere2, PRIMARY_SYMBOL);
    console.log(
      `  Post-sync ${PRIMARY_SYMBOL}: total=${recoveredBal.total}, tokens=${recoveredBal.tokens}, lastSyncAdded=${lastSyncAdded}`,
    );
    // syncAdded > 0 proves the Profile layer actually delivered tokens
    // from the CAR pin (not from local cache) — but ONLY when the cold-
    // start hydration is driven by sync() itself. In the current
    // architecture, `Sphere.import` → `payments.load()` already runs
    // the CAR pin → fetch → assemble path during bootstrap, so by the
    // time the test calls `sync()`, the tokens are already in the
    // in-memory pool. sync() correctly reports `added=0` because the
    // bundle CID was already known. The "Profile layer delivered" claim
    // is still proved — by the non-zero recovered balance on a fresh
    // wallet with wiped storage, the only source for those tokens is
    // the CAR pin via the aggregator pointer.
    // Whether lastSyncAdded > 0 or 0, the wallet MUST have recovered
    // the tokens via the Profile layer (storage was wiped before B's
    // import — no local cache to fall back on). The balance assertion
    // proves the round-trip end-to-end.
    expect(recoveredBal.total).toBeGreaterThanOrEqual(MIN_CONFIRMED);

    // Verify tokenIds + amounts match the original — the CAR really did
    // round-trip the real Tokens, not synthesise placeholders.
    const recoveredTokens = sphere2.payments.getTokens().filter((t) => t.symbol === PRIMARY_SYMBOL);
    const recoveredIds = new Set(recoveredTokens.map((t) => t.id));
    const recoveredAmounts = new Map(recoveredTokens.map((t) => [t.id, t.amount]));
    for (const id of originalIds) {
      expect(recoveredIds.has(id)).toBe(true);
      expect(recoveredAmounts.get(id)).toBe(originalAmounts.get(id));
    }
    // And every recovered token still carries its real `genesis` (parsed
    // out of sdkData) — confirms the CAR encoded the full UXF schema, not
    // a stub.
    for (const t of recoveredTokens) {
      expect(t.sdkData).toBeTruthy();
      const parsed = JSON.parse(t.sdkData!) as { genesis?: unknown };
      expect(parsed.genesis).toBeTruthy();
    }

    console.log(`[Test 2] PASSED: real testnet tokens round-tripped through CAR pin/reload`);
  }, 360_000);

  // -------------------------------------------------------------------------
  // Test 3: Profile IPNS snapshot publish + resolve round-trip
  //
  // IPNS publish was removed in T-D6c — the pointer layer is now the
  // sole publish channel. The READ path survives in
  // `profile/migration/ipns-reader.ts` as a one-shot migration for
  // legacy wallets. `it.skip` here preserves the original test
  // shape for future reference if a resolve-only regression test
  // against real gateways is ever added.
  // -------------------------------------------------------------------------

  it.skip('publishes a Profile IPNS snapshot and resolves it back via Unicity gateways (REMOVED in T-D6c)', async () => {
    // Obsolete: publishProfileSnapshot no longer exists. The
    // migration reader exposes `resolveProfileSnapshot` for
    // read-only legacy recovery; no corresponding publisher remains.
  });
});
