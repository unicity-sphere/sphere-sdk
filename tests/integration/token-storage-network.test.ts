/**
 * Integration test: TOKEN storage providers are NETWORK-ISOLATED.
 *
 * The token stores (FileTokenStorageProvider on Node, IndexedDBTokenStorageProvider
 * in the browser) physically separate a wallet's tokens per network so a testnet2
 * balance can never be mistaken for / overwritten by / wiped together with a
 * testnet (or mainnet) balance for the SAME wallet identity (same chainPubkey).
 *
 *   - Node:   {baseTokensDir}/{network}/{chainPubkey}/   — network is a path segment.
 *   - Browser: db name `sphere-token-storage-{network}-{chainPubkey}` — network is
 *              baked into the db-name prefix.
 *
 * Two regressions are guarded here:
 *
 * 1. createForAddress() must PRESERVE the network. The per-address sub-provider
 *    that Sphere spins up for each wallet address used to drop `network` on the
 *    Node side (browser preserved it via the network-baked dbNamePrefix). A
 *    dropped network collapses every network's tokens into one shared dir — the
 *    exact fund-mixing this isolation exists to prevent.
 *
 * 2. clear() on ONE network must NOT wipe ANOTHER network's tokens. Browser
 *    clear() wipes every database sharing its dbNamePrefix; because the prefix
 *    is per-network, clearing testnet2 must leave testnet's tokens intact.
 *    A network-blind clear() would be a wallet-wipe catastrophe.
 *
 * Identity factory mirrors the unit tests: distinct directAddresses MUST produce
 * distinct chainPubkeys (the real per-wallet key), so two wallets never collide.
 */

import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileTokenStorageProvider } from '../../impl/nodejs/storage/FileTokenStorageProvider';
import { IndexedDBTokenStorageProvider } from '../../impl/browser/storage/IndexedDBTokenStorageProvider';
import type { TxfStorageDataBase } from '../../storage';
import type { FullIdentity } from '../../types';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Distinct addresses must produce distinct chainPubkeys (the real per-wallet
 * identifier the token store keys on), matching the unit-test identity factory.
 */
function createIdentity(directAddress: string): FullIdentity {
  return {
    privateKey: '0'.repeat(64),
    chainPubkey: '02' + Buffer.from(directAddress).toString('hex').padEnd(64, '0').slice(0, 64),
    l1Address: 'alpha1testaddr',
    directAddress,
    nametag: 'testuser',
  } as unknown as FullIdentity;
}

function createTxfData(tokenIds: string[]): TxfStorageDataBase {
  const data: TxfStorageDataBase = {
    _meta: {
      version: 1,
      address: 'alpha1test',
      formatVersion: '2.0',
      updatedAt: Date.now(),
    },
  };
  for (const id of tokenIds) {
    (data as Record<string, unknown>)[`_${id}`] = {
      version: '2.0',
      state: { tokenId: id },
      transactions: [],
    };
  }
  return data;
}

/** Count real token keys in TXF data (exclude meta/tombstones/outbox/sent/invalid). */
function countTokens(data: TxfStorageDataBase): number {
  return Object.keys(data).filter(
    k => k.startsWith('_') && !['_meta', '_tombstones', '_outbox', '_sent', '_invalid'].includes(k),
  ).length;
}

function hasToken(data: TxfStorageDataBase, id: string): boolean {
  return (data as Record<string, unknown>)[`_${id}`] !== undefined;
}

// =============================================================================
// 1. createForAddress() PRESERVES network (regression)
// =============================================================================

describe('Token storage: createForAddress() preserves network (regression)', () => {
  it('Node FileTokenStorageProvider child keeps the network path segment', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-token-net-'));
    const id = createIdentity('DIRECT://node-preserve-aaaa');

    const parent = new FileTokenStorageProvider({ tokensDir: tmpDir, network: 'testnet2' });
    parent.setIdentity(id);

    // The per-address sub-provider Sphere spins up for each wallet address.
    const child = parent.createForAddress();
    child.setIdentity(id);

    // Resolved dir must be {tmpDir}/testnet2/{chainPubkey}/ — the network segment
    // MUST survive createForAddress(). Before the fix it was {tmpDir}/{chainPubkey}/.
    const resolvedDir = (child as unknown as { tokensDir: string }).tokensDir;
    expect(resolvedDir).toContain(path.join('testnet2', id.chainPubkey));
  });

  it('Browser IndexedDBTokenStorageProvider child keeps the network db prefix', () => {
    const id = createIdentity('DIRECT://browser-preserve-bbbb');

    const parent = new IndexedDBTokenStorageProvider({ network: 'testnet2' });
    const child = parent.createForAddress();
    child.setIdentity(id);

    // db name = `sphere-token-storage-testnet2-{chainPubkey}`. The network must be
    // baked into the prefix so it survives createForAddress().
    const resolvedDb = (child as unknown as { dbName: string }).dbName;
    expect(resolvedDb.startsWith('sphere-token-storage-testnet2')).toBe(true);
  });

  it('Node child WITHOUT a configured network has NO network segment (sanity)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-token-nonet-'));
    const id = createIdentity('DIRECT://node-nonet-cccc');

    const parent = new FileTokenStorageProvider({ tokensDir: tmpDir });
    const child = parent.createForAddress();
    child.setIdentity(id);

    const resolvedDir = (child as unknown as { tokensDir: string }).tokensDir;
    // No network configured → dir is just {tmpDir}/{chainPubkey}, never a stray
    // 'testnet2' segment. Guards against the factory accidentally injecting one.
    expect(resolvedDir).toBe(path.join(tmpDir, id.chainPubkey));
    expect(resolvedDir).not.toContain('testnet2');
  });
});

// =============================================================================
// 2. clear() on one network does NOT wipe the other network's tokens
// =============================================================================

describe('Token storage: clear() is network-scoped (wallet-wipe guard)', () => {
  it('Browser: clearing testnet2 leaves testnet tokens intact (real save/clear/load)', async () => {
    // SAME wallet identity on two different networks. fake-indexeddb backs both.
    const id = createIdentity('DIRECT://wipe-guard-dddd');

    const t1 = new IndexedDBTokenStorageProvider({ network: 'testnet' });
    const t2 = new IndexedDBTokenStorageProvider({ network: 'testnet2' });
    t1.setIdentity(id);
    t2.setIdentity(id);

    // Different network → different physical database. This is what makes a
    // clear() on one network unable to touch the other.
    const db1 = (t1 as unknown as { dbName: string }).dbName;
    const db2 = (t2 as unknown as { dbName: string }).dbName;
    expect(db1).not.toBe(db2);

    await t1.initialize();
    await t2.initialize();

    // Save a distinct token on each network.
    expect((await t1.save(createTxfData(['tn1-token']))).success).toBe(true);
    expect((await t2.save(createTxfData(['tn2-token']))).success).toBe(true);

    // Sanity: each network reads back its own token.
    expect(hasToken((await t1.load()).data!, 'tn1-token')).toBe(true);
    expect(hasToken((await t2.load()).data!, 'tn2-token')).toBe(true);

    // Wipe ONLY testnet2.
    await t2.clear();

    // testnet2 is empty...
    const t2Verify = new IndexedDBTokenStorageProvider({ network: 'testnet2' });
    t2Verify.setIdentity(id);
    await t2Verify.initialize();
    const t2After = await t2Verify.load();
    expect(t2After.success).toBe(true);
    expect(countTokens(t2After.data!)).toBe(0);
    await t2Verify.shutdown();

    // ...but testnet STILL has its token. clear() must not have crossed networks.
    const t1Verify = new IndexedDBTokenStorageProvider({ network: 'testnet' });
    t1Verify.setIdentity(id);
    await t1Verify.initialize();
    const t1After = await t1Verify.load();
    expect(t1After.success).toBe(true);
    expect(hasToken(t1After.data!, 'tn1-token')).toBe(true);
    expect(countTokens(t1After.data!)).toBe(1);
    await t1Verify.shutdown();

    await t1.shutdown();
    await t2.shutdown();
  });

  it('Node: clearing testnet2 leaves testnet tokens intact (separate dirs)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-token-clear-'));
    const id = createIdentity('DIRECT://node-wipe-eeee');

    const t1 = new FileTokenStorageProvider({ tokensDir: tmpDir, network: 'testnet' });
    const t2 = new FileTokenStorageProvider({ tokensDir: tmpDir, network: 'testnet2' });
    t1.setIdentity(id);
    t2.setIdentity(id);

    // Same base dir, same wallet, different network → different resolved dir.
    const dir1 = (t1 as unknown as { tokensDir: string }).tokensDir;
    const dir2 = (t2 as unknown as { tokensDir: string }).tokensDir;
    expect(dir1).not.toBe(dir2);

    await t1.initialize();
    await t2.initialize();

    expect((await t1.save(createTxfData(['tn1-token']))).success).toBe(true);
    expect((await t2.save(createTxfData(['tn2-token']))).success).toBe(true);

    // Wipe ONLY testnet2.
    await t2.clear();

    // testnet2 dir is empty of tokens...
    expect(countTokens((await t2.load()).data!)).toBe(0);

    // ...but testnet's token survives untouched.
    const t1After = await t1.load();
    expect(hasToken(t1After.data!, 'tn1-token')).toBe(true);
    expect(countTokens(t1After.data!)).toBe(1);

    await t1.shutdown();
    await t2.shutdown();
  });
});
