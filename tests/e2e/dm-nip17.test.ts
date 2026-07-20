/**
 * E2E test: NIP-17 DM round-trip over real testnet relay.
 *
 * Creates two ephemeral Sphere wallets (Alice and Bob), registers nametags,
 * and tests DM delivery both by pubkey and by nametag.
 *
 * Run manually:
 *   npm run test:e2e
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Sphere } from '../../core/Sphere';
import { createNodeProviders } from '../../impl/nodejs';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DirectMessage } from '../../types';

const rand = () => Math.random().toString(36).slice(2, 8);

const TRUSTBASE_URL = 'https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/bft-trustbase.testnet.json';
const DEFAULT_API_KEY = 'sk_06365a9c44654841a366068bcfc68986';

function makeTempDirs(label: string) {
  const base = join(tmpdir(), `sphere-e2e-${label}-${Date.now()}-${rand()}`);
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

/**
 * Resolve when a DM arrives whose content matches `match` (an exact string or a
 * predicate); pass no matcher to resolve on the first DM. The live relay
 * redelivers/echoes stored events on (re)subscribe, so resolving on the FIRST
 * event races — a stale replay can resolve before the awaited reply lands.
 * Matching on content ignores those replays.
 */
function waitForDM(
  sphere: Sphere,
  match?: string | ((m: DirectMessage) => boolean),
  timeoutMs = 15000,
): Promise<DirectMessage> {
  const matches = (m: DirectMessage): boolean =>
    match === undefined ? true : typeof match === 'string' ? m.content === match : match(m);
  return new Promise((resolve, reject) => {
    let unsub: (() => void) | undefined;
    const timer = setTimeout(
      () => {
        unsub?.();
        reject(new Error(`Timeout: matching DM not received within ${timeoutMs}ms`));
      },
      timeoutMs,
    );
    unsub = sphere.communications.onDirectMessage((msg) => {
      if (!matches(msg)) return; // ignore echoes/replays that don't match
      clearTimeout(timer);
      unsub?.();
      resolve(msg);
    });
  });
}

async function createSphere(label: string, nametag?: string) {
  const dirs = makeTempDirs(label);
  await ensureTrustbase(dirs.dataDir);

  const providers = createNodeProviders({
    network: 'testnet',
    dataDir: dirs.dataDir,
    tokensDir: dirs.tokensDir,
    oracle: {
      trustBasePath: join(dirs.dataDir, 'trustbase.json'),
      apiKey: DEFAULT_API_KEY,
    },
  });
  const result = await Sphere.init({ ...providers, network: 'testnet', autoGenerate: true, ...(nametag ? { nametag } : {}) });
  return { sphere: result.sphere, dirs };
}

describe('NIP-17 DM end-to-end', () => {
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

  it('sends DM by pubkey', async () => {
    const { sphere: alice, dirs: aliceDirs } = await createSphere('alice');
    const { sphere: bob, dirs: bobDirs } = await createSphere('bob');
    spheres.push(alice, bob);
    cleanupDirs.push(aliceDirs.base, bobDirs.base);

    // Compute the message first so we can match on it (the relay echoes/replays
    // stored events — we must await THIS message, not merely the first DM).
    const text = `pubkey test ${Date.now()}`;
    // Subscribe Bob first, then wait for relay subscription to establish
    const dmPromise = waitForDM(bob, text);
    await new Promise((r) => setTimeout(r, 3000));

    // Use 32-byte x-only pubkey (chainPubkey is 33-byte compressed)
    const bobPubkey = bob.identity!.chainPubkey;
    const bobNostrPubkey = bobPubkey.length === 66 ? bobPubkey.slice(2) : bobPubkey;

    await alice.communications.sendDM(bobNostrPubkey, text);

    const msg = await dmPromise;
    expect(msg.content).toBe(text);
    expect(msg.senderPubkey).toBeTruthy();
    expect(msg.isRead).toBe(false);
  }, 30000);

  it('sends DM by nametag', async () => {
    const aliceTag = `e2e-alice-${rand()}`;
    const bobTag = `e2e-bob-${rand()}`;

    // Sphere.init with nametag auto-registers it
    const { sphere: alice, dirs: aliceDirs } = await createSphere('alice', aliceTag);
    const { sphere: bob, dirs: bobDirs } = await createSphere('bob', bobTag);
    spheres.push(alice, bob);
    cleanupDirs.push(aliceDirs.base, bobDirs.base);

    expect(alice.identity!.nametag).toBe(aliceTag);
    expect(bob.identity!.nametag).toBe(bobTag);

    const text = `nametag test ${Date.now()}`;
    // Subscribe Bob, wait for relay subscription + nametag propagation
    const dmPromise = waitForDM(bob, text);
    await new Promise((r) => setTimeout(r, 3000));

    await alice.communications.sendDM(`@${bobTag}`, text);

    const msg = await dmPromise;
    expect(msg.content).toBe(text);
    expect(msg.senderNametag).toBe(aliceTag);
    expect(msg.isRead).toBe(false);
  }, 45000);

  it('completes bidirectional DM round-trip', async () => {
    const aliceTag = `e2e-alice-${rand()}`;
    const bobTag = `e2e-bob-${rand()}`;

    const { sphere: alice, dirs: aliceDirs } = await createSphere('alice', aliceTag);
    const { sphere: bob, dirs: bobDirs } = await createSphere('bob', bobTag);
    spheres.push(alice, bob);
    cleanupDirs.push(aliceDirs.base, bobDirs.base);

    expect(alice.identity!.nametag).toBe(aliceTag);
    expect(bob.identity!.nametag).toBe(bobTag);

    // Wait for relay subscriptions to establish
    await new Promise((r) => setTimeout(r, 3000));

    // First: Alice -> Bob
    const msg1 = `Round-trip A->B ${Date.now()}`;
    const bobDmPromise = waitForDM(bob, msg1, 30000);
    await new Promise((r) => setTimeout(r, 3000));

    await alice.communications.sendDM(`@${bobTag}`, msg1);

    const received1 = await bobDmPromise;
    expect(received1.content).toBe(msg1);
    expect(received1.senderNametag).toBe(aliceTag);

    // Wait for state to settle before second exchange
    await new Promise((r) => setTimeout(r, 5000));

    // Second: Bob -> Alice
    const msg2 = `Round-trip B->A ${Date.now()}`;
    const aliceDmPromise = waitForDM(alice, msg2, 30000);
    await new Promise((r) => setTimeout(r, 3000));

    await bob.communications.sendDM(`@${aliceTag}`, msg2);

    const received2 = await aliceDmPromise;
    expect(received2.content).toBe(msg2);
    expect(received2.senderNametag).toBe(bobTag);
  }, 90000);

  it('sustains multiple DM exchanges over time (connection stability)', async () => {
    const aliceTag = `e2e-alice-${rand()}`;
    const bobTag = `e2e-bob-${rand()}`;

    const { sphere: alice, dirs: aliceDirs } = await createSphere('alice', aliceTag);
    const { sphere: bob, dirs: bobDirs } = await createSphere('bob', bobTag);
    spheres.push(alice, bob);
    cleanupDirs.push(aliceDirs.base, bobDirs.base);

    // Wait for relay subscriptions to establish
    await new Promise((r) => setTimeout(r, 3000));

    const exchanges = 5;
    const delayBetweenExchanges = 15000; // 15 seconds between exchanges

    for (let i = 1; i <= exchanges; i++) {
      console.log(`\n--- Exchange ${i}/${exchanges} ---`);

      // Alice -> Bob
      const msgA = `Exchange ${i} A->B ${Date.now()}`;
      const bobDmPromise = waitForDM(bob, msgA, 30000);
      console.log(`Alice sending: "${msgA}"`);
      await alice.communications.sendDM(`@${bobTag}`, msgA);

      const receivedByBob = await bobDmPromise;
      console.log(`Bob received: "${receivedByBob.content}"`);
      expect(receivedByBob.content).toBe(msgA);
      expect(receivedByBob.senderNametag).toBe(aliceTag);

      // Wait between exchanges to test connection stability
      console.log(`Waiting ${delayBetweenExchanges / 1000}s before Bob replies...`);
      await new Promise((r) => setTimeout(r, delayBetweenExchanges));

      // Bob -> Alice
      const msgB = `Exchange ${i} B->A ${Date.now()}`;
      const aliceDmPromise = waitForDM(alice, msgB, 30000);
      console.log(`Bob sending: "${msgB}"`);
      await bob.communications.sendDM(`@${aliceTag}`, msgB);

      const receivedByAlice = await aliceDmPromise;
      console.log(`Alice received: "${receivedByAlice.content}"`);
      expect(receivedByAlice.content).toBe(msgB);
      expect(receivedByAlice.senderNametag).toBe(bobTag);

      // Wait before next exchange
      if (i < exchanges) {
        console.log(`Waiting ${delayBetweenExchanges / 1000}s before next exchange...`);
        await new Promise((r) => setTimeout(r, delayBetweenExchanges));
      }
    }

    console.log(`\n=== All ${exchanges} exchanges completed successfully ===`);
  }, 300000); // 5 minutes timeout

  it('receives DM after 70 seconds of idle (production scenario)', async () => {
    // This test simulates the EXACT production failure:
    // 1. Bot starts, sends greeting (connection works for outbound)
    // 2. ~60-70 seconds pass with no activity
    // 3. User sends message - it never arrives
    //
    // The relay typically closes idle connections after ~60 seconds.
    // Our keepalive pings should prevent this.

    const aliceTag = `e2e-alice-${rand()}`;
    const bobTag = `e2e-bob-${rand()}`;

    const { sphere: alice, dirs: aliceDirs } = await createSphere('alice', aliceTag);
    const { sphere: bob, dirs: bobDirs } = await createSphere('bob', bobTag);
    spheres.push(alice, bob);
    cleanupDirs.push(aliceDirs.base, bobDirs.base);

    // Wait for relay subscriptions to establish
    await new Promise((r) => setTimeout(r, 3000));

    // Bob sends initial greeting (like uniclaw does on startup)
    console.log('\n--- Initial greeting (like production startup) ---');
    const greeting = `I'm online! ${Date.now()}`;
    const aliceInitialPromise = waitForDM(alice, greeting, 30000);
    console.log(`Bob sending greeting: "${greeting}"`);
    await bob.communications.sendDM(`@${aliceTag}`, greeting);

    const receivedGreeting = await aliceInitialPromise;
    console.log(`Alice received greeting: "${receivedGreeting.content}"`);
    expect(receivedGreeting.content).toBe(greeting);

    // Now simulate the CRITICAL production scenario:
    // Wait 70 seconds with NO activity at all
    console.log('\n--- Waiting 70 seconds with NO activity (relay idle timeout) ---');
    console.log('This simulates the production failure case...');

    const startWait = Date.now();
    await new Promise((r) => setTimeout(r, 70000)); // 70 seconds
    console.log(`Waited ${Math.round((Date.now() - startWait) / 1000)}s`);

    // Now Alice sends a message to Bob (like user sends DM to uniclaw)
    console.log('\n--- Alice sends message after 70s idle ---');
    const msg = `Message after 70s idle ${Date.now()}`;
    const bobDmPromise = waitForDM(bob, msg, 30000);
    console.log(`Alice sending: "${msg}"`);
    await alice.communications.sendDM(`@${bobTag}`, msg);

    // This is the critical test: Bob MUST receive this message
    const received = await bobDmPromise;
    console.log(`Bob received: "${received.content}"`);
    expect(received.content).toBe(msg);
    expect(received.senderNametag).toBe(aliceTag);

    console.log('\n=== SUCCESS: DM received after 70s idle ===');
  }, 150000); // 2.5 minutes timeout
});
