/**
 * E2E Test: Full Wallet Lifecycle with IPFS Recovery
 *
 * Demonstrates the "logout → login on another device → tokens recovered via IPFS" scenario.
 *
 * Flow:
 * 1. Create wallet A + nametag + IPFS provider
 * 2. Top-up via faucet, wait for tokens
 * 3. Verify balance
 * 4. Create wallet B + nametag
 * 5. Send UCT from A → B
 * 6. Snapshot balance on A (IPFS sync should have happened automatically on send/receive)
 * 7. Destroy A + clear local data (= logout / IndexedDB cleared)
 * 8. Verify data gone
 * 9. Import A from mnemonic on fresh dirs (= new device) with IPFS provider
 * 10. Verify tokens recovered automatically — balance matches snapshot
 *
 * IPFS sync is expected to trigger automatically on token operations (receive, send).
 * No manual sync() calls — if tokens don't appear, it means auto-sync isn't working yet.
 *
 * NOTE: This test will likely fail until auto-sync and IPFS recovery are fully wired.
 *
 * Run with: npm run test:e2e
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Sphere } from '../../core/Sphere';
import { createNodeProviders } from '../../impl/nodejs';
import { createNodeIpfsStorageProvider } from '../../impl/nodejs/ipfs';
import { STORAGE_KEYS_GLOBAL, getIpfsGatewayUrls } from '../../constants';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// =============================================================================
// Constants
// =============================================================================

const FAUCET_URL = 'https://faucet.unicity.network/api/v1/faucet/request';
const TRUSTBASE_URL = 'https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/bft-trustbase.testnet.json';
const DEFAULT_API_KEY = 'sk_06365a9c44654841a366068bcfc68986';

const FAUCET_TOPUP_TIMEOUT_MS = 90_000;
const TRANSFER_TIMEOUT_MS = 60_000;
const IPNS_PROPAGATION_WAIT_MS = 5_000;
const RECOVERY_POLL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;

const rand = () => Math.random().toString(36).slice(2, 8);

// =============================================================================
// Helpers
// =============================================================================

function makeTempDirs(label: string) {
  const base = join(tmpdir(), `sphere-e2e-lifecycle-${label}-${Date.now()}-${rand()}`);
  const dataDir = join(base, 'data');
  const tokensDir = join(base, 'tokens');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(tokensDir, { recursive: true });
  return { base, dataDir, tokensDir };
}

async function ensureTrustbase(dataDir: string): Promise<void> {
  const trustbasePath = join(dataDir, 'trustbase.json');
  if (existsSync(trustbasePath)) return;
  const res = await fetch(TRUSTBASE_URL);
  if (!res.ok) throw new Error(`Failed to download trustbase: ${res.status}`);
  writeFileSync(trustbasePath, await res.text());
}

function makeProviders(dirs: { dataDir: string; tokensDir: string }) {
  return createNodeProviders({
    network: 'testnet',
    dataDir: dirs.dataDir,
    tokensDir: dirs.tokensDir,
    oracle: {
      trustBasePath: join(dirs.dataDir, 'trustbase.json'),
      apiKey: DEFAULT_API_KEY,
    },
  });
}

function makeIpfsProvider(storage: Parameters<typeof createNodeIpfsStorageProvider>[1]) {
  return createNodeIpfsStorageProvider(
    {
      gateways: getIpfsGatewayUrls(),
      debug: true,
      resolveTimeoutMs: 15000,
      publishTimeoutMs: 60000,
    },
    storage,
  );
}

async function requestFaucet(
  nametag: string,
  coin: string,
  amount: number,
): Promise<{ success: boolean; message?: string }> {
  try {
    const response = await fetch(FAUCET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unicityId: nametag, coin, amount }),
    });
    const result = (await response.json()) as {
      success: boolean;
      message?: string;
      error?: string;
    };
    return { success: result.success, message: result.message || result.error };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Request failed',
    };
  }
}

interface BalanceSnapshot {
  coinId: string;
  totalAmount: string;
  tokenCount: number;
  confirmedAmount: string;
}

function getUctBalance(sphere: Sphere): BalanceSnapshot | null {
  const assets = sphere.payments.getBalance();
  const uct = assets.find((a) => a.symbol === 'UCT');
  if (!uct) return null;
  return {
    coinId: uct.coinId,
    totalAmount: uct.totalAmount,
    tokenCount: uct.tokenCount,
    confirmedAmount: uct.confirmedAmount,
  };
}

// =============================================================================
// Test
// =============================================================================

describe('Wallet lifecycle: create → topup → send → destroy → import → IPFS recover', () => {
  const cleanupDirs: string[] = [];
  const spheres: Sphere[] = [];

  afterEach(async () => {
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

  it('recovers L3 tokens via IPFS after wallet destruction and re-import', async () => {
    // =========================================================================
    // Step 1: Create wallet A with nametag + IPFS provider
    // =========================================================================
    const nametagA = `e2e-life-a-${rand()}`;
    const dirsA = makeTempDirs('walletA');
    cleanupDirs.push(dirsA.base);
    await ensureTrustbase(dirsA.dataDir);

    const providersA = makeProviders(dirsA);

    console.log(`\n[1] Creating wallet A with @${nametagA}...`);
    const { sphere: sphereA, created, generatedMnemonic } = await Sphere.init({
      ...providersA,
      autoGenerate: true,
      nametag: nametagA,
    });
    spheres.push(sphereA);

    expect(created).toBe(true);
    expect(generatedMnemonic).toBeDefined();
    expect(sphereA.identity!.nametag).toBe(nametagA);
    const mnemonic = generatedMnemonic!;
    console.log(`  Wallet A created: ${sphereA.identity!.directAddress}`);

    // Attach IPFS — sync should trigger automatically on token operations
    const ipfsProviderA = makeIpfsProvider(providersA.storage);
    await sphereA.addTokenStorageProvider(ipfsProviderA);
    console.log(`  IPFS provider attached, IPNS name: ${ipfsProviderA.getIpnsName()}`);

    // =========================================================================
    // Step 2: Top-up wallet A via faucet
    // =========================================================================
    console.log(`[2] Requesting UCT from faucet for @${nametagA}...`);
    const faucetResult = await requestFaucet(nametagA, 'unicity', 100);
    console.log(`  Faucet response: ${faucetResult.success ? 'OK' : faucetResult.message}`);

    // Poll until tokens arrive
    console.log('  Waiting for tokens to arrive via Nostr...');
    const topupStart = Date.now();
    let uctBalance: BalanceSnapshot | null = null;

    while (Date.now() - topupStart < FAUCET_TOPUP_TIMEOUT_MS) {
      await sphereA.payments.load();
      uctBalance = getUctBalance(sphereA);
      if (uctBalance && BigInt(uctBalance.totalAmount) > 0n) {
        console.log(
          `  UCT received: ${uctBalance.totalAmount} (${uctBalance.tokenCount} tokens) in ${((Date.now() - topupStart) / 1000).toFixed(1)}s`,
        );
        break;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    expect(uctBalance).not.toBeNull();
    expect(BigInt(uctBalance!.totalAmount)).toBeGreaterThan(0n);

    // Resolve unconfirmed tokens so they become spendable
    console.log('  Resolving unconfirmed tokens...');
    const resolveStart = Date.now();
    while (Date.now() - resolveStart < 60_000) {
      await sphereA.payments.resolveUnconfirmed();
      const bal = getUctBalance(sphereA);
      if (bal && BigInt(bal.confirmedAmount) > 0n) {
        console.log(`  Tokens confirmed in ${((Date.now() - resolveStart) / 1000).toFixed(1)}s`);
        uctBalance = bal;
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
      await sphereA.payments.load();
    }

    // =========================================================================
    // Step 3: Verify balance
    // =========================================================================
    console.log('[3] Verifying balance on wallet A...');
    const allAssets = sphereA.payments.getBalance();
    console.log(
      `  Assets: ${allAssets.map((a) => `${a.symbol}: confirmed=${a.confirmedAmount} (${a.tokenCount} tokens)`).join(', ')}`,
    );
    expect(allAssets.length).toBeGreaterThan(0);
    expect(BigInt(uctBalance!.confirmedAmount)).toBeGreaterThan(0n);

    // =========================================================================
    // Step 4: Create wallet B with nametag
    // =========================================================================
    const nametagB = `e2e-life-b-${rand()}`;
    const dirsB = makeTempDirs('walletB');
    cleanupDirs.push(dirsB.base);
    await ensureTrustbase(dirsB.dataDir);

    const providersB = makeProviders(dirsB);

    console.log(`[4] Creating wallet B with @${nametagB}...`);
    const { sphere: sphereB } = await Sphere.init({
      ...providersB,
      autoGenerate: true,
      nametag: nametagB,
    });
    spheres.push(sphereB);
    console.log(`  Wallet B created: ${sphereB.identity!.directAddress}`);

    // =========================================================================
    // Step 5: Send UCT from A → B
    //   After send(), IPFS should auto-sync the updated token state.
    // =========================================================================
    const uctCoinId = uctBalance!.coinId;
    const confirmedBigint = BigInt(uctBalance!.confirmedAmount);
    const sendAmount = (confirmedBigint / 2n).toString();

    const balanceBeforeSend = getUctBalance(sphereA);
    console.log(`[5] Sending tokens from @${nametagA} → @${nametagB}`);
    console.log(`  Balance BEFORE send: ${balanceBeforeSend!.totalAmount} UCT (${balanceBeforeSend!.tokenCount} tokens)`);
    console.log(`  Sending amount: ${sendAmount} UCT`);

    const sendStart = Date.now();
    const sendResult = await sphereA.payments.send({
      recipient: `@${nametagB}`,
      amount: sendAmount,
      coinId: uctCoinId,
      memo: 'E2E lifecycle test transfer',
    });
    const sendDuration = ((Date.now() - sendStart) / 1000).toFixed(1);
    console.log(`  Send completed in ${sendDuration}s — status: ${sendResult.status}, token transfers: ${sendResult.tokenTransfers.length}`);
    if (sendResult.error) {
      console.log(`  Send error: ${sendResult.error}`);
    }

    // Check A balance immediately after send
    const balanceAfterSendImmediate = getUctBalance(sphereA);
    console.log(`  Balance on A right after send: ${balanceAfterSendImmediate?.totalAmount ?? '0'} UCT (${balanceAfterSendImmediate?.tokenCount ?? 0} tokens)`);

    // Wait for B to receive
    console.log('  Waiting for wallet B to receive tokens...');
    const receiveStart = Date.now();
    let receivedOnB = false;

    while (Date.now() - receiveStart < TRANSFER_TIMEOUT_MS) {
      await sphereB.payments.load();
      const balB = getUctBalance(sphereB);
      if (balB && BigInt(balB.totalAmount) > 0n) {
        console.log(
          `  Wallet B received: ${balB.totalAmount} UCT (${balB.tokenCount} tokens) in ${((Date.now() - receiveStart) / 1000).toFixed(1)}s`,
        );
        receivedOnB = true;
        break;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    if (!receivedOnB) {
      console.log('  WARNING: Wallet B did not receive tokens within timeout');
    }

    // Refresh A (change token may arrive async after instant split)
    console.log('  Waiting for change token on A...');
    await sphereA.payments.load();
    await new Promise((r) => setTimeout(r, 5000));
    await sphereA.payments.load();

    const balanceAfterSendFinal = getUctBalance(sphereA);
    console.log(`  Balance on A after settle: ${balanceAfterSendFinal?.totalAmount ?? '0'} UCT (${balanceAfterSendFinal?.tokenCount ?? 0} tokens)`);

    // =========================================================================
    // Step 6: Snapshot balance before destruction
    //   IPFS should already have the latest state from auto-sync.
    //   Check IPFS provider state to see if sync happened.
    // =========================================================================
    const snapshotBeforeDestroy = getUctBalance(sphereA);
    const ipfsSeqBefore = ipfsProviderA.getSequenceNumber();
    const ipfsCidBefore = ipfsProviderA.getLastCid?.() ?? 'N/A';
    console.log(`[6] Balance snapshot before destroy:`);
    console.log(`  Wallet A: ${snapshotBeforeDestroy?.totalAmount ?? '0'} UCT (${snapshotBeforeDestroy?.tokenCount ?? 0} tokens)`);
    if (receivedOnB) {
      const balB = getUctBalance(sphereB);
      console.log(`  Wallet B: ${balB?.totalAmount ?? '0'} UCT (${balB?.tokenCount ?? 0} tokens)`);
    }
    console.log(`  IPFS state: seq=${ipfsSeqBefore}, lastCid=${ipfsCidBefore}`);
    if (Number(ipfsSeqBefore) > 0) {
      console.log(`  ✓ IPFS auto-sync triggered — data was saved to IPFS during token operations`);
    } else {
      console.log(`  ✗ IPFS auto-sync NOT triggered — seq is still 0`);
    }

    // =========================================================================
    // Step 7: Destroy wallet A + clear local data (= logout / IndexedDB wipe)
    // =========================================================================
    console.log('[7] Destroying wallet A (simulating logout / device change)...');
    console.log('  Calling sphere.destroy()...');
    await sphereA.destroy();
    spheres.splice(spheres.indexOf(sphereA), 1);

    console.log('  Calling Sphere.clear() — wiping all local data (storage + tokens)...');
    await Sphere.clear({
      storage: providersA.storage,
      tokenStorage: providersA.tokenStorage,
    });

    const walletExists = await Sphere.exists(providersA.storage);
    const mnemonicGone = (await providersA.storage.get(STORAGE_KEYS_GLOBAL.MNEMONIC)) === null;
    expect(walletExists).toBe(false);
    expect(mnemonicGone).toBe(true);
    console.log(`  Wallet exists: ${walletExists} (expected: false)`);
    console.log(`  Mnemonic cleared: ${mnemonicGone} (expected: true)`);
    console.log('  Local data wiped — as if IndexedDB was cleared or user logged out.');

    // Wait for IPNS propagation
    console.log(`  Waiting ${IPNS_PROPAGATION_WAIT_MS / 1000}s for IPNS propagation...`);
    await new Promise((r) => setTimeout(r, IPNS_PROPAGATION_WAIT_MS));

    // =========================================================================
    // Step 8: Import wallet A from mnemonic on fresh dirs (= new device)
    //   Attach IPFS provider — tokens should be recovered automatically.
    // =========================================================================
    console.log('[8] Importing wallet A from mnemonic (simulating new device)...');
    console.log('  Creating fresh directories (clean device)...');
    const dirsA2 = makeTempDirs('walletA-reimport');
    cleanupDirs.push(dirsA2.base);
    await ensureTrustbase(dirsA2.dataDir);

    const providersA2 = makeProviders(dirsA2);

    console.log('  Calling Sphere.import() with mnemonic...');
    const sphereA2 = await Sphere.import({
      ...providersA2,
      mnemonic,
    });
    spheres.push(sphereA2);
    console.log(`  Wallet A re-imported: ${sphereA2.identity!.directAddress}`);
    console.log(`  Nametag recovered: ${sphereA2.identity!.nametag ?? 'none'}`);

    // Check balance BEFORE IPFS — should be empty (no local tokens)
    const balanceBeforeIpfs = getUctBalance(sphereA2);
    console.log(`  Balance before IPFS: ${balanceBeforeIpfs?.totalAmount ?? '0'} UCT (expected: 0 — no local tokens)`);

    // Attach IPFS — this should trigger automatic recovery from IPNS
    console.log('  Attaching IPFS provider — expecting automatic token recovery...');
    const ipfsProviderA2 = makeIpfsProvider(providersA2.storage);
    await sphereA2.addTokenStorageProvider(ipfsProviderA2);
    console.log(`  IPFS provider attached, IPNS name: ${ipfsProviderA2.getIpnsName()}`);

    // Check balance immediately after IPFS attach
    const balanceAfterIpfsAttach = getUctBalance(sphereA2);
    console.log(`  Balance right after IPFS attach: ${balanceAfterIpfsAttach?.totalAmount ?? '0'} UCT`);

    // =========================================================================
    // Step 9: Wait for tokens to appear (auto-recovered from IPFS)
    // =========================================================================
    console.log('[9] Waiting for IPFS recovery (polling getBalance for up to 60s)...');
    let recovered = false;
    const recoveryStart = Date.now();

    while (Date.now() - recoveryStart < RECOVERY_POLL_TIMEOUT_MS) {
      const recoveredBalance = getUctBalance(sphereA2);
      if (recoveredBalance && BigInt(recoveredBalance.totalAmount) > 0n) {
        console.log(
          `  ✓ Tokens recovered: ${recoveredBalance.totalAmount} UCT (${recoveredBalance.tokenCount} tokens) in ${((Date.now() - recoveryStart) / 1000).toFixed(1)}s`,
        );
        recovered = true;
        break;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    if (!recovered) {
      const ipfsSeqAfter = ipfsProviderA2.getSequenceNumber();
      console.log(`  ✗ Recovery FAILED — no tokens appeared after ${RECOVERY_POLL_TIMEOUT_MS / 1000}s`);
      console.log(`  IPFS provider seq on new device: ${ipfsSeqAfter} (0 = never synced from remote)`);
      console.log(`  Expected: auto-pull from IPNS → tokens loaded into payments module`);
    }

    // =========================================================================
    // Step 10: Verify recovered balance matches pre-destruction snapshot
    // =========================================================================
    console.log('[10] Verifying recovered balance...');
    const recoveredBalance = getUctBalance(sphereA2);
    console.log(`  Expected: ${snapshotBeforeDestroy!.totalAmount} UCT (${snapshotBeforeDestroy!.tokenCount} tokens)`);
    console.log(`  Got:      ${recoveredBalance?.totalAmount ?? '0'} UCT (${recoveredBalance?.tokenCount ?? 0} tokens)`);

    expect(recovered).toBe(true);
    expect(recoveredBalance).not.toBeNull();
    expect(recoveredBalance!.totalAmount).toBe(snapshotBeforeDestroy!.totalAmount);
    expect(recoveredBalance!.tokenCount).toBe(snapshotBeforeDestroy!.tokenCount);

    console.log(
      `  ✓ PASS: balance matches snapshot`,
    );

    // Cleanup B
    await sphereB.destroy();
    spheres.splice(spheres.indexOf(sphereB), 1);

    console.log('\nFull wallet lifecycle test completed.');
  }, 300_000); // 5 minutes — faucet + transfer + IPNS propagation
});
