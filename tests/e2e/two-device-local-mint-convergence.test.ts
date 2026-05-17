/**
 * E2E: Two-Device Local-Mint Convergence (no Nostr, no faucet).
 *
 * Proves that two Sphere instances of the SAME wallet, each minting
 * distinct test tokens against the live aggregator while running on
 * no-op transports (Nostr disabled on both sides), converge to the
 * same JOINT token set after `sync()`.
 *
 * Why this test (vs. `profile-multi-device-sync.test.ts`):
 *
 *   - `profile-multi-device-sync` proves COLD-START recovery: Device A
 *     receives tokens via faucet (which delivers over Nostr), Device A
 *     destroys; Device B imports fresh and recovers tokens via the
 *     aggregator-pointer + IPFS-CAR path. Only Device B runs with
 *     `createNoopTransport()`. Token origination still uses Nostr.
 *
 *   - THIS test proves CONCURRENT publishing + JOIN convergence with
 *     ZERO Nostr involvement on EITHER device. Each device mints its
 *     own tokens locally via the state-transition-sdk's
 *     `submitMintCommitment` path against the aggregator. The §9.2
 *     conflict path between two simultaneously-publishing devices is
 *     exercised end-to-end against real infrastructure.
 *
 * Test scenario:
 *
 *   1. Generate a mnemonic once. Create two temp dirs (Device A, B).
 *   2. Both Sphere instances import the SAME mnemonic with
 *      `createNoopTransport()` so no Nostr traffic flows.
 *   3. Device A mints test tokens T_A1, T_A2 directly via the
 *      aggregator (no faucet, no DM). Inject via
 *      `sphere.payments.addToken(...)`.
 *   4. Device B independently mints T_B1, T_B2 via the same path.
 *   5. Both devices call `sphere.payments.sync()` — this triggers a
 *      CAR pin + pointer publish, and the second publisher hits
 *      §9.2 CONFLICT, fetchAndJoin's the first publisher's CAR.
 *   6. After both syncs settle, both `getTokens()` views must
 *      include all four test tokens (the JOINT set).
 *
 * Real infrastructure:
 *   - Live Unicity aggregator (mint commitments + inclusion proofs)
 *   - Live Unicity IPFS gateways (CAR pin + fetch)
 *   - Aggregator pointer publish/recover (§9.2 conflict resolution)
 *
 * Run with: `npm run test:e2e`.
 *
 * Skipped automatically when aggregator + IPFS preflight fails.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { Sphere } from '../../core/Sphere';
import {
  rand,
  makeTempDirs,
  ensureTrustbase,
  createNoopTransport,
} from './helpers';
import { makeProfileProviders } from './profile-helpers';
import { preflightSkip } from './lib/preflight';
import { mintTestTokenToSelf } from './lib/test-mint';

const SKIP_INFRA = preflightSkip(
  ['aggregator', 'ipfs'],
  'two-device-local-mint-convergence',
);

// Per-test wall-clock budget. Allows for aggregator mint round-trips
// (commit + wait inclusion proof) on each device plus IPFS CAR pin +
// pointer publish + §9.2 conflict resolution + IPFS CAR fetch.
const TEST_BUDGET_MS = 240_000;

// Aggregator-pointer periodic poll is [30s, 90s); add slack for IPFS
// gateway propagation.
const CONVERGENCE_TIMEOUT_MS = 120_000;
const CONVERGENCE_POLL_INTERVAL_MS = 5_000;

// Coin hex used by the test mints. Distinct from real testnet coin
// IDs to avoid colliding with faucet-issued balances in case the test
// runs against a wallet that also has faucet tokens.
const TEST_COIN_HEX = 'aabbccdd';

describe.skipIf(SKIP_INFRA)('Two-Device Local-Mint Convergence E2E', () => {
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

  it(
    'both devices converge to the joint token set after concurrent local-mint + sync',
    async () => {
      // ─── Step 1: Generate one mnemonic, create two device directories ───
      const tag = `e2e-2dev-${rand()}`;
      const dirsA = makeTempDirs(`${tag}-a`);
      const dirsB = makeTempDirs(`${tag}-b`);
      cleanupDirs.push(dirsA.base, dirsB.base);
      await ensureTrustbase(dirsA.dataDir);
      await ensureTrustbase(dirsB.dataDir);

      // ─── Step 2: Bring up Device A with NO-OP transport ───
      const providersA = makeProfileProviders(dirsA);
      const transportA = createNoopTransport();
      providersA.transport = transportA;

      console.log('[setup] Creating Device A wallet (no Nostr)...');
      const { sphere: sphereA, generatedMnemonic } = await Sphere.init({
        ...providersA,
        autoGenerate: true,
      });
      spheres.push(sphereA);
      expect(generatedMnemonic).toBeTruthy();
      const mnemonic = generatedMnemonic!;
      console.log(`  Device A: ${sphereA.identity!.l1Address}`);

      // ─── Bring up Device B with NO-OP transport + SAME mnemonic ───
      const providersB = makeProfileProviders(dirsB);
      const transportB = createNoopTransport();
      providersB.transport = transportB;

      console.log('[setup] Importing Device B from same mnemonic (no Nostr)...');
      const sphereB = await Sphere.import({
        storage: providersB.storage,
        tokenStorage: providersB.tokenStorage,
        transport: providersB.transport,
        oracle: providersB.oracle,
        mnemonic,
      });
      spheres.push(sphereB);
      console.log(`  Device B: ${sphereB.identity!.l1Address}`);

      // Sanity: both devices share identity.
      expect(sphereA.identity!.l1Address).toBe(sphereB.identity!.l1Address);
      expect(sphereA.identity!.chainPubkey).toBe(sphereB.identity!.chainPubkey);

      // Extract privateKey from the internal identity for the mint helper.
      // (Sphere does not expose privateKey via the public surface — but
      // the test caller has it via `Sphere.import({ mnemonic })` derivation.)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const privateKey = (sphereA as any)._identity?.privateKey as string;
      expect(privateKey).toBeTruthy();

      // ─── Step 3: Device A mints two test tokens locally ───
      console.log('[mint] Device A self-minting T_A1, T_A2 via aggregator...');
      const tokenA1 = await mintTestTokenToSelf({
        sphere: sphereA,
        privateKey,
        coinIdHex: TEST_COIN_HEX,
        amount: 1_000_000n,
      });
      await sphereA.payments.addToken(tokenA1.token);
      console.log(`  T_A1 minted: tokenId=${tokenA1.tokenIdHex.slice(0, 12)}...`);

      const tokenA2 = await mintTestTokenToSelf({
        sphere: sphereA,
        privateKey,
        coinIdHex: TEST_COIN_HEX,
        amount: 500_000n,
      });
      await sphereA.payments.addToken(tokenA2.token);
      console.log(`  T_A2 minted: tokenId=${tokenA2.tokenIdHex.slice(0, 12)}...`);

      // ─── Step 4: Device B mints two DIFFERENT test tokens ───
      console.log('[mint] Device B self-minting T_B1, T_B2 via aggregator...');
      const tokenB1 = await mintTestTokenToSelf({
        sphere: sphereB,
        privateKey,
        coinIdHex: TEST_COIN_HEX,
        amount: 2_000_000n,
      });
      await sphereB.payments.addToken(tokenB1.token);
      console.log(`  T_B1 minted: tokenId=${tokenB1.tokenIdHex.slice(0, 12)}...`);

      const tokenB2 = await mintTestTokenToSelf({
        sphere: sphereB,
        privateKey,
        coinIdHex: TEST_COIN_HEX,
        amount: 750_000n,
      });
      await sphereB.payments.addToken(tokenB2.token);
      console.log(`  T_B2 minted: tokenId=${tokenB2.tokenIdHex.slice(0, 12)}...`);

      const expectedIds = new Set([
        tokenA1.tokenIdHex,
        tokenA2.tokenIdHex,
        tokenB1.tokenIdHex,
        tokenB2.tokenIdHex,
      ]);

      // Sanity: pre-sync each device sees ONLY its own tokens.
      const preSyncA = collectMintedIds(sphereA, expectedIds);
      const preSyncB = collectMintedIds(sphereB, expectedIds);
      expect(preSyncA).toEqual(new Set([tokenA1.tokenIdHex, tokenA2.tokenIdHex]));
      expect(preSyncB).toEqual(new Set([tokenB1.tokenIdHex, tokenB2.tokenIdHex]));

      // ─── Step 5: Both devices sync CONCURRENTLY ───
      console.log('[sync] Both devices syncing concurrently (§9.2 conflict path)...');
      const [syncA, syncB] = await Promise.all([
        sphereA.payments.sync({ drainTimeoutMs: 30_000 }),
        sphereB.payments.sync({ drainTimeoutMs: 30_000 }),
      ]);
      console.log(`  Device A sync: added=${syncA.added}, removed=${syncA.removed}`);
      console.log(`  Device B sync: added=${syncB.added}, removed=${syncB.removed}`);

      // ─── Step 6: Poll both devices until they converge on the joint set ───
      console.log('[verify] Polling for joint convergence...');
      const deadline = performance.now() + CONVERGENCE_TIMEOUT_MS;
      let finalA = preSyncA;
      let finalB = preSyncB;
      while (performance.now() < deadline) {
        // Drive additional sync rounds — in production the periodic
        // pointer poll handles this, but explicit sync() shortens the
        // test budget significantly.
        await Promise.all([
          sphereA.payments.sync({ drainTimeoutMs: 10_000 }).catch(() => undefined),
          sphereB.payments.sync({ drainTimeoutMs: 10_000 }).catch(() => undefined),
        ]);

        finalA = collectMintedIds(sphereA, expectedIds);
        finalB = collectMintedIds(sphereB, expectedIds);

        const aConverged = setsEqual(finalA, expectedIds);
        const bConverged = setsEqual(finalB, expectedIds);
        console.log(
          `  poll: A=${finalA.size}/${expectedIds.size} ` +
            `B=${finalB.size}/${expectedIds.size} ` +
            `(${aConverged && bConverged ? 'CONVERGED' : 'pending'})`,
        );
        if (aConverged && bConverged) break;

        await new Promise((r) => setTimeout(r, CONVERGENCE_POLL_INTERVAL_MS));
      }

      // ─── Assertions ───
      expect(finalA).toEqual(expectedIds);
      expect(finalB).toEqual(expectedIds);
      console.log('[verify] PASSED — both devices see the joint 4-token set');
    },
    TEST_BUDGET_MS,
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the set of minted-test-token tokenIds present on the device.
 * Filters by the input set so we ignore any unrelated tokens (e.g. nametag,
 * faucet-issued tokens that might be present in the wallet).
 */
function collectMintedIds(sphere: Sphere, expected: Set<string>): Set<string> {
  const present = new Set<string>();
  for (const tok of sphere.payments.getTokens()) {
    // Token.sdkData carries the original JSON; extract genesis.data.tokenId.
    const tokenIdHex = extractGenesisTokenId(tok.sdkData);
    if (tokenIdHex && expected.has(tokenIdHex)) {
      present.add(tokenIdHex);
    }
  }
  return present;
}

function extractGenesisTokenId(sdkData: string | undefined): string | null {
  if (!sdkData) return null;
  try {
    const parsed = JSON.parse(sdkData) as {
      genesis?: { data?: { tokenId?: string } };
    };
    return parsed.genesis?.data?.tokenId ?? null;
  } catch {
    return null;
  }
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
