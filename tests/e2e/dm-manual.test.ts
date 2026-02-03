/**
 * Manual E2E test: Start wallet, mint nametag, wait for incoming DM.
 *
 * Run manually:
 *   npx vitest run tests/e2e/dm-manual.test.ts
 */

import { describe, it, expect } from 'vitest';
import { Sphere } from '../../core/Sphere';
import { createNodeProviders } from '../../impl/nodejs';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DirectMessage } from '../../types';

const rand = () => Math.random().toString(36).slice(2, 8);

const TRUSTBASE_URL = 'https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/bft-trustbase.testnet.json';
const DEFAULT_API_KEY = 'sk_06365a9c44654841a366068bcfc68986';

// Timeout for waiting for DM (60 seconds)
const DM_WAIT_TIMEOUT = 60000;

function makeTempDirs(label: string) {
  const base = join(tmpdir(), `sphere-manual-${label}-${Date.now()}-${rand()}`);
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

function waitForDM(sphere: Sphere, timeoutMs: number): Promise<DirectMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: DM not received within ${timeoutMs}ms`)), timeoutMs);
    sphere.communications.onDirectMessage((msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
  });
}

describe('Manual DM test', () => {
  it('waits for incoming DM', async () => {
    // Generate unique nametag
    const nametag = `test-${rand()}`;

    console.log('\n========================================');
    console.log('Starting manual DM test...');
    console.log('========================================\n');

    // Create temp directories
    const dirs = makeTempDirs('manual');
    await ensureTrustbase(dirs.dataDir);

    // Create Sphere with nametag
    const providers = createNodeProviders({
      network: 'testnet',
      dataDir: dirs.dataDir,
      tokensDir: dirs.tokensDir,
      oracle: {
        trustBasePath: join(dirs.dataDir, 'trustbase.json'),
        apiKey: DEFAULT_API_KEY,
      },
    });

    console.log('Initializing Sphere...');
    const result = await Sphere.init({
      ...providers,
      autoGenerate: true,
      nametag,
    });
    const sphere = result.sphere;

    console.log('\n========================================');
    console.log(`NAMETAG: @${sphere.identity!.nametag}`);
    console.log(`PUBKEY:  ${sphere.identity!.chainPubkey}`);
    console.log('========================================');
    console.log(`\nWaiting ${DM_WAIT_TIMEOUT / 1000} seconds for incoming DM...`);
    console.log('Send a DM from Sphere app to the nametag above.\n');

    // Set up DM listener
    const dmPromise = waitForDM(sphere, DM_WAIT_TIMEOUT);

    try {
      const msg = await dmPromise;

      console.log('\n========================================');
      console.log('DM RECEIVED!');
      console.log('========================================');
      console.log(`From:    ${msg.senderNametag || msg.senderPubkey}`);
      console.log(`Content: ${msg.content}`);
      console.log(`Time:    ${new Date(msg.timestamp).toISOString()}`);
      console.log('========================================\n');

      expect(msg.content).toBeTruthy();
      expect(msg.senderPubkey).toBeTruthy();
    } finally {
      // Cleanup
      await sphere.destroy();
      rmSync(dirs.base, { recursive: true, force: true });
    }
  }, DM_WAIT_TIMEOUT + 30000); // Test timeout = wait timeout + 30s buffer
});
