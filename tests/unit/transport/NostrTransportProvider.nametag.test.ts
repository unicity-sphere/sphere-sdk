/**
 * Tests for NostrTransportProvider nametag functionality
 * Covers resolveNametagInfo, recoverNametag, and nametag encryption
 *
 * Uses NostrClient module-level mock since NostrTransportProvider
 * delegates WebSocket management to NostrClient.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Buffer } from 'buffer';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 as sha256Noble } from '@noble/hashes/sha2.js';
import { NOSTR_EVENT_KINDS } from '../../../constants';

// =============================================================================
// Nametag Encryption Utilities (replicated for testing)
// =============================================================================

function deriveNametagEncryptionKey(privateKeyHex: string): Uint8Array {
  const privateKeyBytes = Buffer.from(privateKeyHex, 'hex');
  const saltInput = new TextEncoder().encode('sphere-nametag-salt');
  const salt = sha256Noble(saltInput);
  const info = new TextEncoder().encode('nametag-encryption');
  return hkdf(sha256Noble, privateKeyBytes, salt, info, 32);
}

async function encryptNametag(nametag: string, privateKeyHex: string): Promise<string> {
  const key = deriveNametagEncryptionKey(privateKeyHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const data = encoder.encode(nametag);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(key).buffer as ArrayBuffer,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv).buffer as ArrayBuffer },
    cryptoKey,
    new Uint8Array(data).buffer as ArrayBuffer
  );

  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  return Buffer.from(combined).toString('base64');
}

async function decryptNametag(encryptedBase64: string, privateKeyHex: string): Promise<string | null> {
  try {
    const key = deriveNametagEncryptionKey(privateKeyHex);
    const combined = Buffer.from(encryptedBase64, 'base64');

    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(key).buffer as ArrayBuffer,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv).buffer as ArrayBuffer },
      cryptoKey,
      new Uint8Array(ciphertext).buffer as ArrayBuffer
    );

    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
  } catch {
    return null;
  }
}

// =============================================================================
// Mock NostrClient
// =============================================================================

// Store events that should be returned for specific query filters
const storedQueryEvents: Map<string, unknown[]> = new Map();

// Capture published events for assertions
const publishedEvents: unknown[] = [];

// Build a key from a filter to match against storedQueryEvents
function filterKey(filter: Record<string, unknown>): string {
  if (filter['#t']) return `nametag:${(filter['#t'] as string[])[0]}`;
  if (filter['#d']) return `nametag:${(filter['#d'] as string[])[0]}`;
  if (filter.authors) return `author:${(filter.authors as string[])[0]}`;
  return `kinds:${(filter.kinds as number[])?.join(',')}`;
}

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn();
const mockIsConnected = vi.fn().mockReturnValue(true);
const mockGetConnectedRelays = vi.fn().mockReturnValue(new Set(['wss://test.relay']));
const mockAddConnectionListener = vi.fn();
const mockUnsubscribe = vi.fn();
const mockPublishEvent = vi.fn().mockImplementation(async (event: unknown) => {
  publishedEvents.push(event);
  return 'mock-event-id';
});

// subscribe mock: for queryEvents calls, deliver stored events then EOSE
const mockSubscribe = vi.fn().mockImplementation((filter: unknown, callbacks: {
  onEvent?: (event: unknown) => void;
  onEndOfStoredEvents?: () => void;
  onError?: (subId: string, error: string) => void;
}) => {
  const subId = 'sub-' + Math.random().toString(36).slice(2, 8);

  // Check if this is a queryEvents call (has filter with kinds for NAMETAG_BINDING or specific authors)
  const filterObj = typeof (filter as any).toJSON === 'function'
    ? (filter as any).toJSON()
    : filter as Record<string, unknown>;

  const key = filterKey(filterObj);
  const events = storedQueryEvents.get(key) || [];

  // Deliver events and EOSE asynchronously (like a real relay would)
  setTimeout(() => {
    for (const event of events) {
      callbacks.onEvent?.(event);
    }
    callbacks.onEndOfStoredEvents?.();
  }, 5);

  return subId;
});

vi.mock('@unicitylabs/nostr-js-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@unicitylabs/nostr-js-sdk')>();
  return {
    ...actual,
    NostrClient: vi.fn().mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
      isConnected: mockIsConnected,
      getConnectedRelays: mockGetConnectedRelays,
      subscribe: mockSubscribe,
      unsubscribe: mockUnsubscribe,
      publishEvent: mockPublishEvent,
      addConnectionListener: mockAddConnectionListener,
    })),
  };
});

// Import after mock is set up
const { NostrTransportProvider } = await import('../../../transport/NostrTransportProvider');
const { hashNametag } = await import('@unicitylabs/nostr-js-sdk');
type WebSocketFactory = import('../../../transport/websocket').WebSocketFactory;

// =============================================================================
// Test Fixtures
// =============================================================================

const TEST_PRIVATE_KEY = 'a'.repeat(64);
const TEST_COMPRESSED_PUBKEY = '02' + 'b'.repeat(64); // 33-byte compressed
const TEST_L1_ADDRESS = 'alpha1testaddress123';
const TEST_DIRECT_ADDRESS = 'DIRECT://testdirectaddress';
const TEST_NAMETAG = 'alice';

function createProvider() {
  return new NostrTransportProvider({
    relays: ['wss://test.relay'],
    createWebSocket: (() => {}) as WebSocketFactory,
    timeout: 1000,
    autoReconnect: false,
  });
}

// Create a realistic Nostr event structure
function createNametagEvent(options: {
  nametag: string;
  nostrPubkey: string;
  chainPubkey?: string;
  l1Address?: string;
  directAddress?: string;
  encryptedNametag?: string;
  timestamp?: number;
}): unknown {
  const hashedNametag = hashNametag(options.nametag);
  const content: Record<string, string> = {};

  if (options.chainPubkey) {
    content.public_key = options.chainPubkey;
  }
  if (options.l1Address) {
    content.l1_address = options.l1Address;
  }
  if (options.directAddress) {
    content.direct_address = options.directAddress;
  }
  if (options.encryptedNametag) {
    content.encrypted_nametag = options.encryptedNametag;
  }

  return {
    id: 'event_' + Math.random().toString(36).slice(2),
    pubkey: options.nostrPubkey,
    created_at: options.timestamp || Math.floor(Date.now() / 1000),
    kind: NOSTR_EVENT_KINDS.NAMETAG_BINDING,
    tags: [
      ['t', hashedNametag],
      ['d', hashedNametag],
    ],
    content: JSON.stringify(content),
    sig: 'mocksignature',
  };
}

// =============================================================================
// Tests: Nametag Encryption/Decryption
// =============================================================================

describe('Nametag Encryption', () => {
  describe('deriveNametagEncryptionKey()', () => {
    it('should derive consistent key from same private key', () => {
      const key1 = deriveNametagEncryptionKey(TEST_PRIVATE_KEY);
      const key2 = deriveNametagEncryptionKey(TEST_PRIVATE_KEY);

      expect(key1).toEqual(key2);
      expect(key1.length).toBe(32);
    });

    it('should derive different keys from different private keys', () => {
      const key1 = deriveNametagEncryptionKey('a'.repeat(64));
      const key2 = deriveNametagEncryptionKey('b'.repeat(64));

      expect(key1).not.toEqual(key2);
    });
  });

  describe('encryptNametag() and decryptNametag()', () => {
    it('should encrypt and decrypt nametag successfully', async () => {
      const originalNametag = 'alice';
      const encrypted = await encryptNametag(originalNametag, TEST_PRIVATE_KEY);

      expect(encrypted).toBeTruthy();
      expect(encrypted).not.toBe(originalNametag);

      const decrypted = await decryptNametag(encrypted, TEST_PRIVATE_KEY);
      expect(decrypted).toBe(originalNametag);
    });

    it('should produce different ciphertext each time (random IV)', async () => {
      const nametag = 'bob';
      const encrypted1 = await encryptNametag(nametag, TEST_PRIVATE_KEY);
      const encrypted2 = await encryptNametag(nametag, TEST_PRIVATE_KEY);

      expect(encrypted1).not.toBe(encrypted2);

      const decrypted1 = await decryptNametag(encrypted1, TEST_PRIVATE_KEY);
      const decrypted2 = await decryptNametag(encrypted2, TEST_PRIVATE_KEY);
      expect(decrypted1).toBe(nametag);
      expect(decrypted2).toBe(nametag);
    });

    it('should fail to decrypt with wrong private key', async () => {
      const encrypted = await encryptNametag('alice', TEST_PRIVATE_KEY);
      const wrongKey = 'c'.repeat(64);

      const decrypted = await decryptNametag(encrypted, wrongKey);
      expect(decrypted).toBeNull();
    });

    it('should handle unicode nametags', async () => {
      const unicodeNametag = '日本語ユーザー';
      const encrypted = await encryptNametag(unicodeNametag, TEST_PRIVATE_KEY);
      const decrypted = await decryptNametag(encrypted, TEST_PRIVATE_KEY);

      expect(decrypted).toBe(unicodeNametag);
    });

    it('should handle empty nametag', async () => {
      const encrypted = await encryptNametag('', TEST_PRIVATE_KEY);
      const decrypted = await decryptNametag(encrypted, TEST_PRIVATE_KEY);

      expect(decrypted).toBe('');
    });

    it('should return null for invalid base64 input', async () => {
      const decrypted = await decryptNametag('not-valid-base64!!!', TEST_PRIVATE_KEY);
      expect(decrypted).toBeNull();
    });

    it('should return null for truncated ciphertext', async () => {
      const encrypted = await encryptNametag('alice', TEST_PRIVATE_KEY);
      const truncated = encrypted.slice(0, 16);

      const decrypted = await decryptNametag(truncated, TEST_PRIVATE_KEY);
      expect(decrypted).toBeNull();
    });
  });
});

// =============================================================================
// Tests: resolveNametagInfo
// =============================================================================

describe('NostrTransportProvider.resolveNametagInfo()', () => {
  let provider: InstanceType<typeof NostrTransportProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    storedQueryEvents.clear();
    publishedEvents.length = 0;
    mockIsConnected.mockReturnValue(true);
    mockGetConnectedRelays.mockReturnValue(new Set(['wss://test.relay']));

    provider = createProvider();
    provider.setIdentity({
      privateKey: TEST_PRIVATE_KEY,
      chainPubkey: TEST_COMPRESSED_PUBKEY,
      l1Address: TEST_L1_ADDRESS,
    });
  });

  it('should return full NametagInfo for event with extended fields', async () => {
    const hashedNametag = hashNametag(TEST_NAMETAG);
    const nostrPubkey = 'd'.repeat(64);

    const event = createNametagEvent({
      nametag: TEST_NAMETAG,
      nostrPubkey,
      chainPubkey: TEST_COMPRESSED_PUBKEY,
      l1Address: TEST_L1_ADDRESS,
      directAddress: TEST_DIRECT_ADDRESS,
    });

    storedQueryEvents.set(`nametag:${hashedNametag}`, [event]);

    await provider.connect();
    const info = await provider.resolveNametagInfo(TEST_NAMETAG);

    expect(info).not.toBeNull();
    expect(info!.nametag).toBe(TEST_NAMETAG);
    expect(info!.transportPubkey).toBe(nostrPubkey);
    expect(info!.chainPubkey).toBe(TEST_COMPRESSED_PUBKEY);
    expect(info!.l1Address).toBe(TEST_L1_ADDRESS);
    expect(info!.directAddress).toBe(TEST_DIRECT_ADDRESS);
    expect(info!.proxyAddress).toBe(`PROXY:${hashedNametag}`);
    expect(info!.timestamp).toBeGreaterThan(0);
  });

  it('should return null for non-existent nametag', async () => {
    await provider.connect();
    const info = await provider.resolveNametagInfo('nonexistent');
    expect(info).toBeNull();
  });

  it('should handle legacy event without extended fields', async () => {
    const hashedNametag = hashNametag('legacy');
    const nostrPubkey = 'e'.repeat(64);

    const event = {
      id: 'legacy_event',
      pubkey: nostrPubkey,
      created_at: Math.floor(Date.now() / 1000),
      kind: NOSTR_EVENT_KINDS.NAMETAG_BINDING,
      tags: [['t', hashedNametag]],
      content: JSON.stringify({ name: 'legacy' }),
      sig: 'mocksig',
    };

    storedQueryEvents.set(`nametag:${hashedNametag}`, [event]);

    await provider.connect();
    const info = await provider.resolveNametagInfo('legacy');

    expect(info).not.toBeNull();
    expect(info!.nametag).toBe('legacy');
    expect(info!.transportPubkey).toBe(nostrPubkey);
    expect(info!.chainPubkey).toBe('');
    expect(info!.l1Address).toBe('');
    expect(info!.proxyAddress).toBe(`PROXY:${hashedNametag}`);
  });

  it('should handle event with tags fallback (pubkey and l1 tags)', async () => {
    const hashedNametag = hashNametag('tagged');
    const nostrPubkey = 'f'.repeat(64);

    const event = {
      id: 'tagged_event',
      pubkey: nostrPubkey,
      created_at: Math.floor(Date.now() / 1000),
      kind: NOSTR_EVENT_KINDS.NAMETAG_BINDING,
      tags: [
        ['t', hashedNametag],
        ['pubkey', TEST_COMPRESSED_PUBKEY],
        ['l1', TEST_L1_ADDRESS],
      ],
      content: JSON.stringify({}),
      sig: 'mocksig',
    };

    storedQueryEvents.set(`nametag:${hashedNametag}`, [event]);

    await provider.connect();
    const info = await provider.resolveNametagInfo('tagged');

    expect(info).not.toBeNull();
    expect(info!.chainPubkey).toBe(TEST_COMPRESSED_PUBKEY);
    expect(info!.l1Address).toBe(TEST_L1_ADDRESS);
  });
});

// =============================================================================
// Tests: recoverNametag
// =============================================================================

describe('NostrTransportProvider.recoverNametag()', () => {
  let provider: InstanceType<typeof NostrTransportProvider>;
  let nostrPubkey: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    storedQueryEvents.clear();
    publishedEvents.length = 0;
    mockIsConnected.mockReturnValue(true);
    mockGetConnectedRelays.mockReturnValue(new Set(['wss://test.relay']));

    provider = createProvider();
    provider.setIdentity({
      privateKey: TEST_PRIVATE_KEY,
      chainPubkey: TEST_COMPRESSED_PUBKEY,
      l1Address: TEST_L1_ADDRESS,
    });

    nostrPubkey = provider.getNostrPubkey();
  });

  afterEach(async () => {
    try {
      await provider.disconnect();
    } catch {
      // Ignore disconnect errors
    }
  });

  it('should recover nametag from encrypted event', async () => {
    const encryptedNametag = await encryptNametag(TEST_NAMETAG, TEST_PRIVATE_KEY);

    const event = createNametagEvent({
      nametag: TEST_NAMETAG,
      nostrPubkey,
      chainPubkey: TEST_COMPRESSED_PUBKEY,
      l1Address: TEST_L1_ADDRESS,
      encryptedNametag,
    });

    storedQueryEvents.set(`author:${nostrPubkey}`, [event]);

    await provider.connect();
    const recovered = await provider.recoverNametag();

    expect(recovered).toBe(TEST_NAMETAG);
  });

  it('should return null when no events found', async () => {
    await provider.connect();
    const recovered = await provider.recoverNametag();
    expect(recovered).toBeNull();
  });

  it('should return null when events exist but no encrypted_nametag field', async () => {
    const event = createNametagEvent({
      nametag: TEST_NAMETAG,
      nostrPubkey,
      chainPubkey: TEST_COMPRESSED_PUBKEY,
      l1Address: TEST_L1_ADDRESS,
    });

    storedQueryEvents.set(`author:${nostrPubkey}`, [event]);

    await provider.connect();
    const recovered = await provider.recoverNametag();
    expect(recovered).toBeNull();
  });

  it('should return null when decryption fails (wrong key scenario)', async () => {
    const differentKey = 'c'.repeat(64);
    const encryptedWithDifferentKey = await encryptNametag(TEST_NAMETAG, differentKey);

    const event = createNametagEvent({
      nametag: TEST_NAMETAG,
      nostrPubkey,
      chainPubkey: TEST_COMPRESSED_PUBKEY,
      l1Address: TEST_L1_ADDRESS,
      encryptedNametag: encryptedWithDifferentKey,
    });

    storedQueryEvents.set(`author:${nostrPubkey}`, [event]);

    await provider.connect();
    const recovered = await provider.recoverNametag();
    expect(recovered).toBeNull();
  });

  it('should recover most recent nametag when multiple events exist', async () => {
    const oldNametag = 'old_nametag';
    const newNametag = 'new_nametag';

    const encryptedOld = await encryptNametag(oldNametag, TEST_PRIVATE_KEY);
    const encryptedNew = await encryptNametag(newNametag, TEST_PRIVATE_KEY);

    const oldEvent = createNametagEvent({
      nametag: oldNametag,
      nostrPubkey,
      encryptedNametag: encryptedOld,
      timestamp: Math.floor(Date.now() / 1000) - 3600,
    });

    const newEvent = createNametagEvent({
      nametag: newNametag,
      nostrPubkey,
      encryptedNametag: encryptedNew,
      timestamp: Math.floor(Date.now() / 1000),
    });

    storedQueryEvents.set(`author:${nostrPubkey}`, [oldEvent, newEvent]);

    await provider.connect();
    const recovered = await provider.recoverNametag();
    expect(recovered).toBe(newNametag);
  });

  it('should throw when identity not set', async () => {
    const newProvider = createProvider();

    await newProvider.connect();
    await expect(newProvider.recoverNametag()).rejects.toThrow('Identity not set');
  });

  it('should throw when not connected', async () => {
    mockIsConnected.mockReturnValue(false);
    await expect(provider.recoverNametag()).rejects.toThrow();
  });
});

// =============================================================================
// Tests: registerNametag with extended fields
// =============================================================================

describe('NostrTransportProvider.registerNametag() extended fields', () => {
  let provider: InstanceType<typeof NostrTransportProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    storedQueryEvents.clear();
    publishedEvents.length = 0;
    mockIsConnected.mockReturnValue(true);
    mockGetConnectedRelays.mockReturnValue(new Set(['wss://test.relay']));

    provider = createProvider();
    provider.setIdentity({
      privateKey: TEST_PRIVATE_KEY,
      chainPubkey: TEST_COMPRESSED_PUBKEY,
      l1Address: TEST_L1_ADDRESS,
      directAddress: TEST_DIRECT_ADDRESS,
    });
  });

  it('should include encrypted_nametag in published event', async () => {
    await provider.connect();

    // resolveNametag returns null (nametag not taken)
    await provider.registerNametag(TEST_NAMETAG, TEST_COMPRESSED_PUBKEY, TEST_DIRECT_ADDRESS);

    expect(publishedEvents.length).toBeGreaterThan(0);

    // Find the nametag binding event
    const event = publishedEvents.find((e: any) => e.kind === NOSTR_EVENT_KINDS.NAMETAG_BINDING) as any;
    expect(event).toBeDefined();

    const content = JSON.parse(event.content);
    expect(content.encrypted_nametag).toBeDefined();
    expect(content.encrypted_nametag).not.toBe(TEST_NAMETAG);

    // Verify we can decrypt it
    const decrypted = await decryptNametag(content.encrypted_nametag, TEST_PRIVATE_KEY);
    expect(decrypted).toBe(TEST_NAMETAG);
  });

  it('should include public_key, l1_address, and direct_address in published event', async () => {
    await provider.connect();

    await provider.registerNametag(TEST_NAMETAG, TEST_COMPRESSED_PUBKEY, TEST_DIRECT_ADDRESS);

    const event = publishedEvents.find((e: any) => e.kind === NOSTR_EVENT_KINDS.NAMETAG_BINDING) as any;
    const content = JSON.parse(event.content);

    expect(content.public_key).toBeDefined();
    expect(content.public_key).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(content.l1_address).toBeDefined();
    expect(content.l1_address).toMatch(/^alpha1[a-z0-9]+$/);
    expect(content.direct_address).toBe(TEST_DIRECT_ADDRESS);
  });

  it('should include hashed nametag in both "t" and "d" tags', async () => {
    await provider.connect();

    await provider.registerNametag(TEST_NAMETAG, TEST_COMPRESSED_PUBKEY, TEST_DIRECT_ADDRESS);

    const event = publishedEvents.find((e: any) => e.kind === NOSTR_EVENT_KINDS.NAMETAG_BINDING) as any;
    const hashedNametag = hashNametag(TEST_NAMETAG);

    const tTag = event.tags.find((t: string[]) => t[0] === 't');
    const dTag = event.tags.find((t: string[]) => t[0] === 'd');

    expect(tTag).toBeDefined();
    expect(tTag[1]).toBe(hashedNametag);
    expect(dTag).toBeDefined();
    expect(dTag[1]).toBe(hashedNametag);
  });
});
