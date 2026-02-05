/**
 * E2E test: Wallet clear lifecycle over real testnet infrastructure.
 *
 * Tests the full cycle:
 * 1. Create wallet + register nametag (real Nostr relay + real Aggregator mint)
 * 2. Verify data persisted (storage + tokens + nametag on relay)
 * 3. Clear wallet
 * 4. Verify local data is gone
 * 5. Verify nametag still lives on Nostr
 * 6. Different wallet can't take the same nametag
 * 7. Same mnemonic can re-import and reclaim the nametag
 *
 * Run manually:
 *   npm run test:e2e
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Sphere } from '../../core/Sphere';
import { createNodeProviders } from '../../impl/nodejs';
import { STORAGE_KEYS_GLOBAL } from '../../constants';
import { mkdirSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const rand = () => Math.random().toString(36).slice(2, 8);

const TRUSTBASE_URL = 'https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/bft-trustbase.testnet.json';
const DEFAULT_API_KEY = 'sk_06365a9c44654841a366068bcfc68986';

function makeTempDirs(label: string) {
  const base = join(tmpdir(), `sphere-e2e-clear-${label}-${Date.now()}-${rand()}`);
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
  if (!res.ok) {
    throw new Error(`Failed to download trustbase: ${res.status}`);
  }
  const data = await res.text();
  writeFileSync(trustbasePath, data);
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

function countTokenFiles(tokensDir: string): number {
  if (!existsSync(tokensDir)) return 0;
  let count = 0;
  for (const item of readdirSync(tokensDir, { withFileTypes: true })) {
    if (item.isDirectory()) {
      const subdir = join(tokensDir, item.name);
      count += readdirSync(subdir).filter(f => f.endsWith('.json')).length;
    } else if (item.name.endsWith('.json')) {
      count++;
    }
  }
  return count;
}

describe('Wallet clear end-to-end', () => {
  const cleanupDirs: string[] = [];
  const spheres: Sphere[] = [];

  afterEach(async () => {
    for (const s of spheres) {
      try { await s.destroy(); } catch { /* cleanup */ }
    }
    spheres.length = 0;
    for (const d of cleanupDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
    cleanupDirs.length = 0;
  });

  it('creates wallet with nametag, clears it, verifies local data gone', async () => {
    const nametag = `e2e-clear-${rand()}`;
    const dirs = makeTempDirs('create-clear');
    cleanupDirs.push(dirs.base);
    await ensureTrustbase(dirs.dataDir);

    const providers = makeProviders(dirs);

    console.log(`\nCreating wallet with nametag @${nametag}...`);
    const { sphere, created } = await Sphere.init({
      ...providers,
      autoGenerate: true,
      nametag,
    });
    spheres.push(sphere);

    expect(created).toBe(true);
    expect(sphere.identity!.nametag).toBe(nametag);
    console.log(`Wallet created: ${sphere.identity!.l1Address}`);
    console.log(`Chain pubkey: ${sphere.identity!.chainPubkey}`);

    // Verify storage has data
    const mnemonic = await providers.storage.get(STORAGE_KEYS_GLOBAL.MNEMONIC);
    expect(mnemonic).not.toBeNull();
    const walletFlag = await providers.storage.get(STORAGE_KEYS_GLOBAL.WALLET_EXISTS);
    expect(walletFlag).toBeTruthy();

    // Verify nametag stored in ADDRESS_NAMETAGS
    const nametagsJson = await providers.storage.get(STORAGE_KEYS_GLOBAL.ADDRESS_NAMETAGS);
    expect(nametagsJson).not.toBeNull();
    expect(nametagsJson).toContain(nametag);

    await sphere.destroy();
    spheres.length = 0;

    console.log('Clearing all wallet data...');
    await Sphere.clear({ storage: providers.storage, tokenStorage: providers.tokenStorage });

    // Verify local wallet is gone
    expect(await Sphere.exists(providers.storage)).toBe(false);
    expect(await providers.storage.get(STORAGE_KEYS_GLOBAL.MNEMONIC)).toBeNull();
    expect(await providers.storage.get(STORAGE_KEYS_GLOBAL.MASTER_KEY)).toBeNull();
    expect(await providers.storage.get(STORAGE_KEYS_GLOBAL.WALLET_EXISTS)).toBeNull();
    expect(await providers.storage.get(STORAGE_KEYS_GLOBAL.ADDRESS_NAMETAGS)).toBeNull();

    // Token files cleared
    expect(countTokenFiles(dirs.tokensDir)).toBe(0);

    console.log('All local data cleared successfully.');
  }, 60000);

  it('nametag persists on Nostr after local clear', async () => {
    const nametag = `e2e-persist-${rand()}`;
    const dirs = makeTempDirs('persist');
    cleanupDirs.push(dirs.base);
    await ensureTrustbase(dirs.dataDir);

    const providers = makeProviders(dirs);

    console.log(`\nCreating wallet with nametag @${nametag}...`);
    const { sphere } = await Sphere.init({
      ...providers,
      autoGenerate: true,
      nametag,
    });
    spheres.push(sphere);

    const chainPubkey = sphere.identity!.chainPubkey;
    console.log(`Nametag @${nametag} registered to pubkey ${chainPubkey}`);

    await sphere.destroy();
    spheres.length = 0;

    // Clear local data
    console.log('Clearing local wallet data...');
    await Sphere.clear({ storage: providers.storage, tokenStorage: providers.tokenStorage });
    expect(await Sphere.exists(providers.storage)).toBe(false);

    // Wait for relay propagation
    await new Promise((r) => setTimeout(r, 2000));

    // Resolve nametag from Nostr — it should still be there
    console.log(`Resolving @${nametag} from Nostr after local clear...`);
    const providers2 = makeProviders(dirs);
    await providers2.transport.connect();

    expect(providers2.transport.resolveNametag).toBeDefined();
    const resolved = await providers2.transport.resolveNametag!(nametag);
    console.log(`Resolved: ${resolved}`);

    expect(resolved).not.toBeNull();
    // The resolved value should be the nostr signer pubkey (32-byte x-only)
    // which corresponds to the original wallet's key
    expect(resolved).toBeTruthy();

    await providers2.transport.disconnect();
    console.log('Nametag confirmed on Nostr after local clear.');
  }, 60000);

  it('different wallet cannot take same nametag after clear', async () => {
    const nametag = `e2e-taken-${rand()}`;
    const dirs1 = makeTempDirs('taken-w1');
    cleanupDirs.push(dirs1.base);
    await ensureTrustbase(dirs1.dataDir);

    const providers1 = makeProviders(dirs1);

    // Wallet 1 registers the nametag
    console.log(`\nWallet 1: registering @${nametag}...`);
    const { sphere: sphere1 } = await Sphere.init({
      ...providers1,
      autoGenerate: true,
      nametag,
    });
    spheres.push(sphere1);

    expect(sphere1.identity!.nametag).toBe(nametag);
    console.log(`Wallet 1 registered @${nametag} successfully.`);

    await sphere1.destroy();
    spheres.length = 0;

    // Clear wallet 1 locally
    await Sphere.clear({ storage: providers1.storage, tokenStorage: providers1.tokenStorage });

    // Wait for relay
    await new Promise((r) => setTimeout(r, 2000));

    // Wallet 2 (different mnemonic) tries the same nametag
    const dirs2 = makeTempDirs('taken-w2');
    cleanupDirs.push(dirs2.base);
    await ensureTrustbase(dirs2.dataDir);

    const providers2 = makeProviders(dirs2);

    console.log(`Wallet 2: attempting to register @${nametag}...`);
    await expect(
      Sphere.init({
        ...providers2,
        autoGenerate: true,
        nametag,
      })
    ).rejects.toThrow('Failed to register nametag');

    console.log('Wallet 2 correctly rejected — nametag is taken on Nostr.');
  }, 90000);

  it('same mnemonic can reclaim nametag after clear and re-import', async () => {
    const nametag = `e2e-reclaim-${rand()}`;
    const dirs1 = makeTempDirs('reclaim-orig');
    cleanupDirs.push(dirs1.base);
    await ensureTrustbase(dirs1.dataDir);

    const providers1 = makeProviders(dirs1);

    // Create original wallet
    console.log(`\nCreating wallet with @${nametag}...`);
    const { sphere: sphere1 } = await Sphere.init({
      ...providers1,
      autoGenerate: true,
      nametag,
    });
    spheres.push(sphere1);

    const mnemonic = sphere1.getMnemonic()!;
    const originalPubkey = sphere1.identity!.chainPubkey;
    expect(mnemonic).toBeDefined();
    console.log(`Original pubkey: ${originalPubkey}`);

    await sphere1.destroy();
    spheres.length = 0;

    // Clear local data
    console.log('Clearing local data...');
    await Sphere.clear({ storage: providers1.storage, tokenStorage: providers1.tokenStorage });
    expect(await Sphere.exists(providers1.storage)).toBe(false);

    // Wait for relay
    await new Promise((r) => setTimeout(r, 2000));

    // Re-import with same mnemonic — same keys
    const dirs2 = makeTempDirs('reclaim-reimport');
    cleanupDirs.push(dirs2.base);
    await ensureTrustbase(dirs2.dataDir);

    const providers2 = makeProviders(dirs2);

    console.log(`Re-importing with same mnemonic, requesting @${nametag}...`);
    const sphere2 = await Sphere.import({
      ...providers2,
      mnemonic,
      nametag,
    });
    spheres.push(sphere2);

    // Same mnemonic = same keys → re-registration succeeds
    expect(sphere2.identity!.chainPubkey).toBe(originalPubkey);
    expect(sphere2.identity!.nametag).toBe(nametag);

    console.log(`Re-import succeeded: @${nametag} reclaimed by same pubkey.`);

    await sphere2.destroy();
    spheres.length = 0;
  }, 90000);

  it('creates new wallet on clean slate after clear', async () => {
    const dirs = makeTempDirs('clean-slate');
    cleanupDirs.push(dirs.base);
    await ensureTrustbase(dirs.dataDir);

    const providers = makeProviders(dirs);

    // Wallet 1
    const nametag1 = `e2e-w1-${rand()}`;
    console.log(`\nCreating wallet 1 with @${nametag1}...`);
    const { sphere: sphere1 } = await Sphere.init({
      ...providers,
      autoGenerate: true,
      nametag: nametag1,
    });
    spheres.push(sphere1);

    const addr1 = sphere1.identity!.l1Address;
    console.log(`Wallet 1: ${addr1}`);

    await sphere1.destroy();
    spheres.length = 0;

    // Clear
    console.log('Clearing...');
    await Sphere.clear({ storage: providers.storage, tokenStorage: providers.tokenStorage });
    expect(await Sphere.exists(providers.storage)).toBe(false);

    // Wallet 2 on same directory (fresh)
    const providers2 = makeProviders(dirs);
    const nametag2 = `e2e-w2-${rand()}`;

    console.log(`Creating wallet 2 with @${nametag2}...`);
    const { sphere: sphere2, created } = await Sphere.init({
      ...providers2,
      autoGenerate: true,
      nametag: nametag2,
    });
    spheres.push(sphere2);

    expect(created).toBe(true);
    expect(sphere2.identity!.nametag).toBe(nametag2);
    // Different mnemonic → different address
    expect(sphere2.identity!.l1Address).not.toBe(addr1);

    console.log(`Wallet 2: ${sphere2.identity!.l1Address}`);
    console.log('Clean slate wallet creation succeeded.');

    await sphere2.destroy();
    spheres.length = 0;
  }, 90000);
});
