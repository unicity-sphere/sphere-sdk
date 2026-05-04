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
const RECOVERY_SYNC_MS = 120_000;

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
    const nametag = `e2e-prof-sync-car-${rand()}`;
    let dirs = makeTempDirs('profile-sync-car');
    cleanupDirs.push(dirs.base);
    await ensureTrustbase(dirs.dataDir);

    const providers = makeProfileProviders(dirs);
    const { storage } = unwrapProfileProviders(providers);

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
    // Sanity check: real testnet tokens have a genesis field — synthetic
    // stubs don't. This guards against accidental regression to fake shapes.
    for (const t of originalTokens) {
      expect((t as unknown as { genesis?: unknown }).genesis).toBeTruthy();
    }

    // Explicit sync flush — drains the debounced write-behind buffer so
    // the CAR is actually pinned to IPFS and the bundle ref is in OrbitDB
    // before we destroy the sphere.
    console.log(`  Flushing token storage to IPFS+OrbitDB...`);
    await sphere.payments.sync();

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
      await new Promise((r) => setTimeout(r, 5000));
    }

    // syncAdded > 0 proves the Profile layer actually delivered tokens
    // from the CAR pin (not from local cache).
    expect(lastSyncAdded).toBeGreaterThan(0);

    const recoveredBal = getBalance(sphere2, PRIMARY_SYMBOL);
    console.log(
      `  Post-sync ${PRIMARY_SYMBOL}: total=${recoveredBal.total}, tokens=${recoveredBal.tokens}`,
    );
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
    // And every recovered token still carries its real `genesis` —
    // confirms the CAR encoded the full UXF schema, not a stub.
    for (const t of recoveredTokens) {
      expect((t as unknown as { genesis?: unknown }).genesis).toBeTruthy();
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
