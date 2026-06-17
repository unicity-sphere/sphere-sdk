/**
 * Integration test: per-address KV network isolation (end-to-end through the
 * REAL IndexedDBStorageProvider).
 *
 * Proves the storage-network-isolation invariant against actual IndexedDB
 * (via fake-indexeddb), NOT a mocked getFullKey:
 *
 *   - Token/payment per-address keys (AUTO_RETURN_LEDGER, OUTBOX, ...) are
 *     NETWORK-ISOLATED: a value written on network 'testnet' is INVISIBLE to a
 *     provider reading the same key on network 'testnet2'. This is the
 *     fund-leak guard — a testnet2 ledger must never fire a send using
 *     testnet (or mainnet) state.
 *
 *   - Chat per-address keys (CONVERSATIONS, MESSAGES, GROUP_CHAT_*) are
 *     per-address only and SHARED across networks — same wallet sees the same
 *     conversations regardless of which network the wallet is currently on.
 *
 *   - Global / seed keys (MNEMONIC) carry neither an address nor a network
 *     segment and are SHARED across everything.
 *
 * Setup mirrors tests/unit/impl/browser/IndexedDBStorageProvider.test.ts:
 * two providers share ONE dbName (so they hit the same physical IndexedDB
 * object store) but are configured with DIFFERENT `network` values, so only
 * the key-prefixing differs. Per-wallet identity is keyed on chainPubkey.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IndexedDBStorageProvider } from '../../impl/browser/storage/IndexedDBStorageProvider';
import { STORAGE_KEYS_ADDRESS, STORAGE_KEYS_GLOBAL, type NetworkType } from '../../constants';
import type { FullIdentity } from '../../types';

// =============================================================================
// Helpers
// =============================================================================

// One shared physical store for every provider in this file. The per-key
// network segment — NOT a separate database — is what isolates token/payment
// state, so both providers must point at the same dbName to make the test real.
const SHARED_DB_NAME = 'kv-iso-test';

/**
 * Distinct addresses must produce distinct chainPubkeys (the real per-wallet
 * identifier in getFullKey), matching the unit-test identity factory.
 */
function createIdentity(directAddress = 'DIRECT://abcdef1234567890'): FullIdentity {
  return {
    privateKey: '0'.repeat(64),
    publicKey: '02' + 'f'.repeat(64),
    chainPubkey: '02' + Buffer.from(directAddress).toString('hex').padEnd(64, '0').slice(0, 64),
    directAddress,
  } as unknown as FullIdentity;
}

async function createProvider(
  network: NetworkType,
  identity: FullIdentity,
): Promise<IndexedDBStorageProvider> {
  const p = new IndexedDBStorageProvider({ network, dbName: SHARED_DB_NAME });
  p.setIdentity(identity);
  await p.connect();
  return p;
}

// =============================================================================
// Tests
// =============================================================================

describe('KV network isolation (integration, real IndexedDBStorageProvider)', () => {
  // Same wallet (same chainPubkey) on two different networks.
  const identity = createIdentity('DIRECT://shared-wallet-aaaa');

  let providerA: IndexedDBStorageProvider; // network: 'testnet'
  let providerB: IndexedDBStorageProvider; // network: 'testnet2'

  beforeEach(async () => {
    providerA = await createProvider('testnet', identity);
    providerB = await createProvider('testnet2', identity);
  });

  afterEach(async () => {
    if (providerA.isConnected()) await providerA.disconnect();
    if (providerB.isConnected()) await providerB.disconnect();
    // Wipe the shared store so each test starts clean (clear() disconnects).
    const cleaner = new IndexedDBStorageProvider({ dbName: SHARED_DB_NAME });
    await cleaner.clear();
  });

  it('FUND-LEAK CLOSED: token/payment state on testnet is invisible on testnet2', async () => {
    // A writes its auto-return ledger on testnet...
    await providerA.set(STORAGE_KEYS_ADDRESS.AUTO_RETURN_LEDGER, 'A-data');

    // ...B (same wallet, testnet2) must NOT see it — different network segment.
    expect(await providerB.get(STORAGE_KEYS_ADDRESS.AUTO_RETURN_LEDGER)).toBeNull();

    // A still reads its own value back on its own network.
    expect(await providerA.get(STORAGE_KEYS_ADDRESS.AUTO_RETURN_LEDGER)).toBe('A-data');

    // And the inverse: B's testnet2 ledger is invisible to A's testnet view.
    await providerB.set(STORAGE_KEYS_ADDRESS.AUTO_RETURN_LEDGER, 'B-data');
    expect(await providerA.get(STORAGE_KEYS_ADDRESS.AUTO_RETURN_LEDGER)).toBe('A-data');
    expect(await providerB.get(STORAGE_KEYS_ADDRESS.AUTO_RETURN_LEDGER)).toBe('B-data');
  });

  it('FUND-LEAK CLOSED: OUTBOX is also network-isolated', async () => {
    await providerA.set(STORAGE_KEYS_ADDRESS.OUTBOX, 'outbox-testnet');
    expect(await providerB.get(STORAGE_KEYS_ADDRESS.OUTBOX)).toBeNull();
    expect(await providerA.get(STORAGE_KEYS_ADDRESS.OUTBOX)).toBe('outbox-testnet');
  });

  it('CHAT SHARED: conversations are per-address, NOT network-scoped', async () => {
    // A writes conversations while on testnet...
    await providerA.set(STORAGE_KEYS_ADDRESS.CONVERSATIONS, 'chat-data');

    // ...B (same wallet on testnet2) sees the SAME conversations.
    expect(await providerB.get(STORAGE_KEYS_ADDRESS.CONVERSATIONS)).toBe('chat-data');
  });

  it('CHAT SHARED: messages are also shared across networks for the same wallet', async () => {
    await providerB.set(STORAGE_KEYS_ADDRESS.MESSAGES, 'msg-data');
    expect(await providerA.get(STORAGE_KEYS_ADDRESS.MESSAGES)).toBe('msg-data');
  });

  it('SEED SHARED: global mnemonic is shared across networks', async () => {
    await providerA.set(STORAGE_KEYS_GLOBAL.MNEMONIC, 'seed');
    expect(await providerB.get(STORAGE_KEYS_GLOBAL.MNEMONIC)).toBe('seed');
  });

  it('PER-WALLET ISOLATION still holds: two wallets on the same network do not share token state', async () => {
    const walletOne = createIdentity('DIRECT://wallet-one-bbbb');
    const walletTwo = createIdentity('DIRECT://wallet-two-cccc');
    expect(walletOne.chainPubkey).not.toBe(walletTwo.chainPubkey);

    // Both on the SAME network ('testnet'), same shared DB, different wallets.
    const pOne = await createProvider('testnet', walletOne);
    const pTwo = await createProvider('testnet', walletTwo);

    try {
      await pOne.set(STORAGE_KEYS_ADDRESS.AUTO_RETURN_LEDGER, 'wallet-one-ledger');

      // Different chainPubkey → different per-address segment → invisible.
      expect(await pTwo.get(STORAGE_KEYS_ADDRESS.AUTO_RETURN_LEDGER)).toBeNull();
      expect(await pOne.get(STORAGE_KEYS_ADDRESS.AUTO_RETURN_LEDGER)).toBe('wallet-one-ledger');
    } finally {
      if (pOne.isConnected()) await pOne.disconnect();
      if (pTwo.isConnected()) await pTwo.disconnect();
    }
  });
});
