/**
 * Integration test: per-address KV network isolation for the NODE
 * FileStorageProvider (end-to-end through the REAL provider, persisting to a
 * JSON file on disk).
 *
 * This is the Node parity of tests/integration/kv-network-isolation.test.ts
 * (which exercises the browser IndexedDBStorageProvider). FileStorageProvider's
 * getFullKey is a byte-for-byte copy of the IndexedDB one, and node wallets rely
 * on it, so the same isolation matrix must hold:
 *
 *   - Token/payment per-address keys (AUTO_RETURN_LEDGER, OUTBOX, ...) are
 *     NETWORK-ISOLATED: a value written on network 'testnet' is INVISIBLE to a
 *     provider reading the same key on network 'testnet2'. This is the
 *     fund-leak guard — a testnet2 ledger must never fire a send using
 *     testnet (or mainnet) state.
 *
 *   - Chat per-address keys (CONVERSATIONS, MESSAGES) are per-address only and
 *     SHARED across networks — same wallet sees the same conversations
 *     regardless of which network the wallet is currently on.
 *
 *   - Global / seed keys (MNEMONIC) carry neither an address nor a network
 *     segment and are SHARED across everything.
 *
 * Setup mirrors the browser file: two FileStorageProvider instances share ONE
 * dataDir + fileName (so they hit the same physical wallet.json) but are
 * configured with DIFFERENT `network` values, so only the key-prefixing differs.
 * Per-wallet identity is keyed on chainPubkey.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileStorageProvider } from '../../impl/nodejs/storage/FileStorageProvider';
import { STORAGE_KEYS_ADDRESS, STORAGE_KEYS_GLOBAL, type NetworkType } from '../../constants';
import type { FullIdentity } from '../../types';

// =============================================================================
// Helpers
// =============================================================================

// One shared physical file for every provider in this file. The per-key network
// segment — NOT a separate file — is what isolates token/payment state, so both
// providers must point at the same dataDir + fileName to make the test real.
const SHARED_FILE_NAME = 'wallet.json';

let dataDir: string;

/**
 * Distinct addresses must produce distinct chainPubkeys (the real per-wallet
 * identifier in getFullKey), matching the unit-test identity factory.
 */
function createIdentity(directAddress = 'DIRECT://abcdef1234567890'): FullIdentity {
  return {
    privateKey: '0'.repeat(64),
    publicKey: '02' + 'f'.repeat(64),
    chainPubkey: '02' + Buffer.from(directAddress).toString('hex').padEnd(64, '0').slice(0, 64),
    l1Address: 'alpha1testaddr',
    directAddress,
  } as unknown as FullIdentity;
}

async function createProvider(
  network: NetworkType,
  identity: FullIdentity,
): Promise<FileStorageProvider> {
  const p = new FileStorageProvider({ dataDir, fileName: SHARED_FILE_NAME, network });
  p.setIdentity(identity);
  await p.connect();
  return p;
}

/**
 * Open a FRESH reader on the shared file. Unlike the browser IndexedDB provider
 * (which has no per-instance write cache), FileStorageProvider keeps an
 * in-memory `data` map and rewrites the WHOLE file on every `set()`/`disconnect()`.
 * That means two simultaneously-live writers would clobber each other's file on
 * save — an artifact of the JSON-file backend, NOT of the isolation logic, which
 * lives entirely in getFullKey (a byte-for-byte copy of the IndexedDB one).
 *
 * To probe the SHARED physical file the way the browser test probes the shared
 * object store, we let the writer persist via set(), then construct a fresh
 * reader that loads the just-written file in connect(). The reader is never
 * mutated, so it never writes back — no clobber. Whether it can SEE the writer's
 * value is then purely a function of the per-key network segment.
 */
async function openReader(
  network: NetworkType,
  identity: FullIdentity,
): Promise<FileStorageProvider> {
  const r = new FileStorageProvider({ dataDir, fileName: SHARED_FILE_NAME, network });
  r.setIdentity(identity);
  await r.connect();
  return r;
}

// =============================================================================
// Tests
// =============================================================================

describe('File KV network isolation (integration, real FileStorageProvider)', () => {
  // Same wallet (same chainPubkey) on two different networks.
  const identity = createIdentity('DIRECT://shared-wallet-aaaa');

  // The SOLE writer in each test. Keeping a single mutator avoids the JSON-file
  // backend's whole-file overwrite-on-save clobber (see openReader docstring);
  // all "other network" / "other wallet" views are fresh, never-mutated readers.
  let writer: FileStorageProvider; // network: 'testnet'

  beforeEach(async () => {
    // Unique temp dir per test so there is no cross-test bleed via the shared
    // file. mkdtemp guarantees a fresh, collision-free directory.
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-file-iso-'));
    writer = await createProvider('testnet', identity);
  });

  afterEach(async () => {
    if (writer.isConnected()) await writer.disconnect();
    // Remove the temp dir (and the wallet.json + any .tmp inside it).
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('FUND-LEAK CLOSED: token/payment state on testnet is invisible on testnet2', async () => {
    // Writer writes its auto-return ledger on testnet (set() persists to disk)...
    await writer.set(STORAGE_KEYS_ADDRESS.AUTO_RETURN_LEDGER, 'A-data');

    // ...a fresh reader for the SAME wallet on testnet2 loads the shared file but
    // must NOT see it — different network segment in the full key.
    const readerTestnet2 = await openReader('testnet2', identity);
    try {
      expect(await readerTestnet2.get(STORAGE_KEYS_ADDRESS.AUTO_RETURN_LEDGER)).toBeNull();
    } finally {
      await readerTestnet2.disconnect();
    }

    // Writer still reads its own value back on its own network.
    expect(await writer.get(STORAGE_KEYS_ADDRESS.AUTO_RETURN_LEDGER)).toBe('A-data');

    // And the inverse holds too: a fresh testnet reader sees A-data, never a
    // testnet2 value. (Symmetry is guaranteed by the same getFullKey segment.)
    const readerTestnet = await openReader('testnet', identity);
    try {
      expect(await readerTestnet.get(STORAGE_KEYS_ADDRESS.AUTO_RETURN_LEDGER)).toBe('A-data');
    } finally {
      await readerTestnet.disconnect();
    }
  });

  it('FUND-LEAK CLOSED: OUTBOX is also network-isolated', async () => {
    await writer.set(STORAGE_KEYS_ADDRESS.OUTBOX, 'outbox-testnet');
    const readerTestnet2 = await openReader('testnet2', identity);
    try {
      expect(await readerTestnet2.get(STORAGE_KEYS_ADDRESS.OUTBOX)).toBeNull();
    } finally {
      await readerTestnet2.disconnect();
    }
    expect(await writer.get(STORAGE_KEYS_ADDRESS.OUTBOX)).toBe('outbox-testnet');
  });

  it('CHAT SHARED: conversations are per-address, NOT network-scoped', async () => {
    // Writer writes conversations while on testnet...
    await writer.set(STORAGE_KEYS_ADDRESS.CONVERSATIONS, 'chat-data');

    // ...a fresh reader for the SAME wallet on testnet2 sees the SAME
    // conversations — chat keys carry no network segment.
    const readerTestnet2 = await openReader('testnet2', identity);
    try {
      expect(await readerTestnet2.get(STORAGE_KEYS_ADDRESS.CONVERSATIONS)).toBe('chat-data');
    } finally {
      await readerTestnet2.disconnect();
    }
  });

  it('CHAT SHARED: messages are also shared across networks for the same wallet', async () => {
    await writer.set(STORAGE_KEYS_ADDRESS.MESSAGES, 'msg-data');
    const readerTestnet2 = await openReader('testnet2', identity);
    try {
      expect(await readerTestnet2.get(STORAGE_KEYS_ADDRESS.MESSAGES)).toBe('msg-data');
    } finally {
      await readerTestnet2.disconnect();
    }
  });

  it('SEED SHARED: global mnemonic is shared across networks', async () => {
    await writer.set(STORAGE_KEYS_GLOBAL.MNEMONIC, 'seed');
    const readerTestnet2 = await openReader('testnet2', identity);
    try {
      expect(await readerTestnet2.get(STORAGE_KEYS_GLOBAL.MNEMONIC)).toBe('seed');
    } finally {
      await readerTestnet2.disconnect();
    }
  });

  it('PER-WALLET ISOLATION still holds: two wallets on the same network do not share token state', async () => {
    const walletOne = createIdentity('DIRECT://wallet-one-bbbb');
    const walletTwo = createIdentity('DIRECT://wallet-two-cccc');
    expect(walletOne.chainPubkey).not.toBe(walletTwo.chainPubkey);

    // walletOne writes on testnet; walletTwo reads the shared file on the SAME
    // network but with a DIFFERENT chainPubkey → different per-address segment.
    const pOne = await openReader('testnet', walletOne);
    try {
      await pOne.set(STORAGE_KEYS_ADDRESS.AUTO_RETURN_LEDGER, 'wallet-one-ledger');

      const pTwo = await openReader('testnet', walletTwo);
      try {
        expect(await pTwo.get(STORAGE_KEYS_ADDRESS.AUTO_RETURN_LEDGER)).toBeNull();
      } finally {
        await pTwo.disconnect();
      }

      expect(await pOne.get(STORAGE_KEYS_ADDRESS.AUTO_RETURN_LEDGER)).toBe('wallet-one-ledger');
    } finally {
      if (pOne.isConnected()) await pOne.disconnect();
    }
  });
});
