/**
 * Tests for NostrTransportProvider nametag functionality
 * Covers resolveNametagInfo, recoverNametag, and nametag encryption
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Buffer } from 'buffer';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 as sha256Noble } from '@noble/hashes/sha2.js';
import { NostrTransportProvider } from '../../../transport/NostrTransportProvider';
import { hashNametag } from '@unicitylabs/nostr-js-sdk';
import type { IWebSocket, IMessageEvent, WebSocketFactory } from '../../../transport/websocket';
import { WebSocketReadyState } from '../../../transport/websocket';
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
// Mock WebSocket with Event Response Support
// =============================================================================

type PendingRequest = {
  subscriptionId: string;
  filter: Record<string, unknown>;
  resolve: (events: unknown[]) => void;
};

class MockWebSocketWithEvents implements IWebSocket {
  readyState: number = WebSocketReadyState.CONNECTING;
  onmessage: ((event: IMessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  // Store events that will be returned for queries
  private _storedEvents: Map<string, unknown[]> = new Map();
  private _pendingRequests: PendingRequest[] = [];
  private _onopen: ((event: unknown) => void) | null = null;
  private _shouldConnect = false;

  constructor() {
    // Schedule connection - will fire when onopen is set
    this._shouldConnect = true;
  }

  // Use setter to trigger connection when handler is assigned
  set onopen(handler: ((event: unknown) => void) | null) {
    this._onopen = handler;
    if (handler && this._shouldConnect && this.readyState === WebSocketReadyState.CONNECTING) {
      // Use setImmediate/setTimeout(0) to ensure handler is fully set before calling
      setImmediate(() => {
        this.readyState = WebSocketReadyState.OPEN;
        this._onopen?.(new Event('open'));
      });
    }
  }

  get onopen(): ((event: unknown) => void) | null {
    return this._onopen;
  }

  /**
   * Add events that will be returned when queried with matching filter
   */
  addEvents(filterKey: string, events: unknown[]): void {
    this._storedEvents.set(filterKey, events);
  }

  send(data: string): void {
    const parsed = JSON.parse(data);
    const [type, subscriptionId, filter] = parsed;

    if (type === 'REQ') {
      // Find matching events
      let events: unknown[] = [];

      // Check for nametag binding queries by kind
      if (filter.kinds?.includes(NOSTR_EVENT_KINDS.NAMETAG_BINDING)) {
        // Try to find by hashed nametag in '#t' or '#d' tag
        const hashedTag = filter['#t']?.[0] || filter['#d']?.[0];
        if (hashedTag && this._storedEvents.has(`nametag:${hashedTag}`)) {
          events = this._storedEvents.get(`nametag:${hashedTag}`) || [];
        }

        // Try to find by author
        const author = filter.authors?.[0];
        if (author && this._storedEvents.has(`author:${author}`)) {
          events = this._storedEvents.get(`author:${author}`) || [];
        }
      }

      // Send events back
      setTimeout(() => {
        for (const event of events) {
          this.onmessage?.({ data: JSON.stringify(['EVENT', subscriptionId, event]) });
        }
        // Send EOSE (End of Stored Events)
        this.onmessage?.({ data: JSON.stringify(['EOSE', subscriptionId]) });
      }, 10);
    }

    if (type === 'CLOSE') {
      // Subscription closed, no action needed
    }

    if (type === 'EVENT') {
      // Event being published - respond with OK
      const eventId = parsed[1]?.id || 'unknown';
      setTimeout(() => {
        this.onmessage?.({ data: JSON.stringify(['OK', eventId, true, '']) });
      }, 5);
    }
  }

  close(): void {
    this.readyState = WebSocketReadyState.CLOSED;
    this.onclose?.({ code: 1000, reason: 'Normal closure' });
  }
}

// =============================================================================
// Test Fixtures
// =============================================================================

const TEST_PRIVATE_KEY = 'a'.repeat(64);
const TEST_COMPRESSED_PUBKEY = '02' + 'b'.repeat(64); // 33-byte compressed
const TEST_L1_ADDRESS = 'alpha1testaddress123';
const TEST_DIRECT_ADDRESS = 'DIRECT://testdirectaddress';
const TEST_NAMETAG = 'alice';

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

      // Different ciphertext due to random IV
      expect(encrypted1).not.toBe(encrypted2);

      // But both should decrypt to same value
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
      // Truncate to just IV (12 bytes = 16 base64 chars)
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
  let provider: NostrTransportProvider;
  let mockWs: MockWebSocketWithEvents;

  beforeEach(() => {
    mockWs = new MockWebSocketWithEvents();

    provider = new NostrTransportProvider({
      relays: ['wss://test.relay'],
      createWebSocket: () => mockWs,
      timeout: 1000,
      autoReconnect: false,
    });

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

    mockWs.addEvents(`nametag:${hashedNametag}`, [event]);

    await provider.connect();
    await new Promise(resolve => setTimeout(resolve, 20));

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
    await new Promise(resolve => setTimeout(resolve, 20));

    const info = await provider.resolveNametagInfo('nonexistent');
    expect(info).toBeNull();
  });

  it('should handle legacy event without extended fields', async () => {
    const hashedNametag = hashNametag('legacy');
    const nostrPubkey = 'e'.repeat(64);

    // Legacy event with no public_key or l1_address in content
    const event = {
      id: 'legacy_event',
      pubkey: nostrPubkey,
      created_at: Math.floor(Date.now() / 1000),
      kind: NOSTR_EVENT_KINDS.NAMETAG_BINDING,
      tags: [['t', hashedNametag]],
      content: JSON.stringify({ name: 'legacy' }), // No extended fields
      sig: 'mocksig',
    };

    mockWs.addEvents(`nametag:${hashedNametag}`, [event]);

    await provider.connect();
    await new Promise(resolve => setTimeout(resolve, 20));

    const info = await provider.resolveNametagInfo('legacy');

    expect(info).not.toBeNull();
    expect(info!.nametag).toBe('legacy');
    expect(info!.transportPubkey).toBe(nostrPubkey);
    // Legacy events have empty chainPubkey and l1Address
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
      content: JSON.stringify({}), // Empty content, info in tags
      sig: 'mocksig',
    };

    mockWs.addEvents(`nametag:${hashedNametag}`, [event]);

    await provider.connect();
    await new Promise(resolve => setTimeout(resolve, 20));

    const info = await provider.resolveNametagInfo('tagged');

    expect(info).not.toBeNull();
    expect(info!.chainPubkey).toBe(TEST_COMPRESSED_PUBKEY);
    expect(info!.l1Address).toBe(TEST_L1_ADDRESS);
  });

  it('should throw when not connected', async () => {
    // Don't connect
    await expect(provider.resolveNametagInfo(TEST_NAMETAG)).rejects.toThrow();
  });
});

// =============================================================================
// Tests: recoverNametag
// =============================================================================

describe('NostrTransportProvider.recoverNametag()', () => {
  let provider: NostrTransportProvider;
  let mockWs: MockWebSocketWithEvents;
  let nostrPubkey: string;

  beforeEach(async () => {
    mockWs = new MockWebSocketWithEvents();

    provider = new NostrTransportProvider({
      relays: ['wss://test.relay'],
      createWebSocket: () => mockWs,
      timeout: 5000, // Increased timeout for stability
      autoReconnect: false,
    });

    provider.setIdentity({
      privateKey: TEST_PRIVATE_KEY,
      chainPubkey: TEST_COMPRESSED_PUBKEY,
      l1Address: TEST_L1_ADDRESS,
    });

    // Get the actual Nostr pubkey that will be derived from the private key
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

    mockWs.addEvents(`author:${nostrPubkey}`, [event]);

    await provider.connect();
    await new Promise(resolve => setTimeout(resolve, 20));

    const recovered = await provider.recoverNametag();

    expect(recovered).toBe(TEST_NAMETAG);
  });

  it('should return null when no events found', async () => {
    await provider.connect();
    await new Promise(resolve => setTimeout(resolve, 20));

    const recovered = await provider.recoverNametag();
    expect(recovered).toBeNull();
  });

  it('should return null when events exist but no encrypted_nametag field', async () => {
    const event = createNametagEvent({
      nametag: TEST_NAMETAG,
      nostrPubkey,
      chainPubkey: TEST_COMPRESSED_PUBKEY,
      l1Address: TEST_L1_ADDRESS,
      // No encryptedNametag
    });

    mockWs.addEvents(`author:${nostrPubkey}`, [event]);

    await provider.connect();
    await new Promise(resolve => setTimeout(resolve, 20));

    const recovered = await provider.recoverNametag();
    expect(recovered).toBeNull();
  });

  it('should return null when decryption fails (wrong key scenario)', async () => {
    // Encrypt with different key
    const differentKey = 'c'.repeat(64);
    const encryptedWithDifferentKey = await encryptNametag(TEST_NAMETAG, differentKey);

    const event = createNametagEvent({
      nametag: TEST_NAMETAG,
      nostrPubkey,
      chainPubkey: TEST_COMPRESSED_PUBKEY,
      l1Address: TEST_L1_ADDRESS,
      encryptedNametag: encryptedWithDifferentKey,
    });

    mockWs.addEvents(`author:${nostrPubkey}`, [event]);

    await provider.connect();
    await new Promise(resolve => setTimeout(resolve, 20));

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
      timestamp: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
    });

    const newEvent = createNametagEvent({
      nametag: newNametag,
      nostrPubkey,
      encryptedNametag: encryptedNew,
      timestamp: Math.floor(Date.now() / 1000), // Now
    });

    // Add both events
    mockWs.addEvents(`author:${nostrPubkey}`, [oldEvent, newEvent]);

    await provider.connect();
    await new Promise(resolve => setTimeout(resolve, 20));

    const recovered = await provider.recoverNametag();
    expect(recovered).toBe(newNametag);
  });

  it('should throw when identity not set', async () => {
    const newProvider = new NostrTransportProvider({
      relays: ['wss://test.relay'],
      createWebSocket: () => new MockWebSocketWithEvents(),
      timeout: 1000,
      autoReconnect: false,
    });

    await newProvider.connect();
    await new Promise(resolve => setTimeout(resolve, 20));

    await expect(newProvider.recoverNametag()).rejects.toThrow('Identity not set');
  });

  it('should throw when not connected', async () => {
    // Don't connect
    await expect(provider.recoverNametag()).rejects.toThrow();
  });
});

// =============================================================================
// Tests: registerNametag with extended fields
// =============================================================================

describe('NostrTransportProvider.registerNametag() extended fields', () => {
  let provider: NostrTransportProvider;
  let mockWs: MockWebSocketWithEvents;
  let sentEvents: string[] = [];

  beforeEach(() => {
    sentEvents = [];
    mockWs = new MockWebSocketWithEvents();

    // Intercept sent messages
    const originalSend = mockWs.send.bind(mockWs);
    mockWs.send = (data: string) => {
      sentEvents.push(data);
      originalSend(data);
    };

    provider = new NostrTransportProvider({
      relays: ['wss://test.relay'],
      createWebSocket: () => mockWs,
      timeout: 1000,
      autoReconnect: false,
    });

    provider.setIdentity({
      privateKey: TEST_PRIVATE_KEY,
      chainPubkey: TEST_COMPRESSED_PUBKEY,
      l1Address: TEST_L1_ADDRESS,
      directAddress: TEST_DIRECT_ADDRESS,
    });
  });

  it('should include encrypted_nametag in published event', async () => {
    await provider.connect();
    await new Promise(resolve => setTimeout(resolve, 20));

    await provider.registerNametag(TEST_NAMETAG, TEST_COMPRESSED_PUBKEY, TEST_DIRECT_ADDRESS);

    // Find the EVENT message
    const eventMessage = sentEvents.find(msg => {
      try {
        const parsed = JSON.parse(msg);
        return parsed[0] === 'EVENT' && parsed[1]?.kind === NOSTR_EVENT_KINDS.NAMETAG_BINDING;
      } catch {
        return false;
      }
    });

    expect(eventMessage).toBeDefined();

    const parsed = JSON.parse(eventMessage!);
    const event = parsed[1];
    const content = JSON.parse(event.content);

    expect(content.encrypted_nametag).toBeDefined();
    expect(content.encrypted_nametag).not.toBe(TEST_NAMETAG); // Should be encrypted

    // Verify we can decrypt it
    const decrypted = await decryptNametag(content.encrypted_nametag, TEST_PRIVATE_KEY);
    expect(decrypted).toBe(TEST_NAMETAG);
  });

  it('should include public_key, l1_address, and direct_address in published event', async () => {
    await provider.connect();
    await new Promise(resolve => setTimeout(resolve, 20));

    await provider.registerNametag(TEST_NAMETAG, TEST_COMPRESSED_PUBKEY, TEST_DIRECT_ADDRESS);

    const eventMessage = sentEvents.find(msg => {
      try {
        const parsed = JSON.parse(msg);
        return parsed[0] === 'EVENT' && parsed[1]?.kind === NOSTR_EVENT_KINDS.NAMETAG_BINDING;
      } catch {
        return false;
      }
    });

    const parsed = JSON.parse(eventMessage!);
    const event = parsed[1];
    const content = JSON.parse(event.content);

    // Note: registerNametag derives pubkey and l1_address from privateKey for consistency
    // So we check that they exist and have correct format, not specific values
    expect(content.public_key).toBeDefined();
    expect(content.public_key).toMatch(/^0[23][0-9a-f]{64}$/); // 33-byte compressed pubkey
    expect(content.l1_address).toBeDefined();
    expect(content.l1_address).toMatch(/^alpha1[a-z0-9]+$/); // Valid bech32 alpha address
    expect(content.direct_address).toBe(TEST_DIRECT_ADDRESS); // This is passed through
  });

  it('should include hashed nametag in both "t" and "d" tags', async () => {
    await provider.connect();
    await new Promise(resolve => setTimeout(resolve, 20));

    await provider.registerNametag(TEST_NAMETAG, TEST_COMPRESSED_PUBKEY, TEST_DIRECT_ADDRESS);

    const eventMessage = sentEvents.find(msg => {
      try {
        const parsed = JSON.parse(msg);
        return parsed[0] === 'EVENT' && parsed[1]?.kind === NOSTR_EVENT_KINDS.NAMETAG_BINDING;
      } catch {
        return false;
      }
    });

    const parsed = JSON.parse(eventMessage!);
    const event = parsed[1];
    const hashedNametag = hashNametag(TEST_NAMETAG);

    const tTag = event.tags.find((t: string[]) => t[0] === 't');
    const dTag = event.tags.find((t: string[]) => t[0] === 'd');

    expect(tTag).toBeDefined();
    expect(tTag[1]).toBe(hashedNametag);
    expect(dTag).toBeDefined();
    expect(dTag[1]).toBe(hashedNametag);
  });
});
