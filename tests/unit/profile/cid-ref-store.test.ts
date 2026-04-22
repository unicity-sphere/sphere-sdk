/**
 * CidRefStore tests (PROFILE-CID-REFERENCES.md §2, §5).
 *
 * Covers:
 *   - pin/fetch round-trip (bytes + JSON)
 *   - content-address verification (fetchFromIpfs verifies internally)
 *   - encryption envelope (content at IPFS is ciphertext, not plaintext)
 *   - CidRef serialize / tryParseRef discriminator
 *   - tryParseRef returns null for legacy inline values (discriminator)
 *   - tryParseRef rejects malformed refs (fail-closed at read)
 *   - Constructor validation (gateways, encryptionKey length)
 *
 * IPFS I/O is mocked via a simple in-memory blockstore to avoid network
 * dependency. Content-addressing uses the real sha256 + CID multihash.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { CID } from 'multiformats/cid';
import { create as createDigest } from 'multiformats/hashes/digest';
import { CID_REF_SCHEMA_VERSION, CidRefStore, type CidRef } from '../../../profile/cid-ref-store';

// ── Test fixtures ─────────────────────────────────────────────────────────

const TEST_KEY = new Uint8Array(32).fill(0xaa);

/**
 * Set up a fake IPFS gateway by mocking global fetch.
 * Pin request (POST /api/v0/dag/put) returns a CID computed from the posted bytes.
 * Fetch request (GET /ipfs/<cid>) returns the stored bytes for that CID.
 */
function installFakeIpfsGateway(): { store: Map<string, Uint8Array>; cleanup: () => void } {
  const store = new Map<string, Uint8Array>();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    // Pin (POST /api/v0/dag/put)
    if (url.includes('/api/v0/dag/put')) {
      const body = init!.body as Uint8Array;
      // Compute a proper CIDv1 with raw codec (0x55) + sha2-256 multihash (0x12).
      const hashBytes = sha256(body);
      const digest = createDigest(0x12, hashBytes);
      const cid = CID.createV1(0x55, digest).toString();
      store.set(cid, new Uint8Array(body));
      return new Response(JSON.stringify({ Cid: { '/': cid } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Response;
    }

    // Fetch (GET /ipfs/<cid>)
    const match = url.match(/\/ipfs\/([A-Za-z0-9]+)/);
    if (match) {
      const cid = match[1]!;
      const data = store.get(cid);
      if (!data) {
        return new Response('not found', { status: 404 }) as unknown as Response;
      }
      return new Response(data, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(data.byteLength) },
      }) as unknown as Response;
    }

    return new Response('bad gateway', { status: 502 }) as unknown as Response;
  }) as typeof fetch;

  return {
    store,
    cleanup: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

// ── Constructor validation ────────────────────────────────────────────────

describe('CidRefStore — constructor validation', () => {
  it('rejects empty gateways array', () => {
    expect(
      () =>
        new CidRefStore({
          gateways: [],
          encryptionKey: TEST_KEY,
        }),
    ).toThrow(/gateway/);
  });

  it('rejects wrong-size encryption key (31 bytes)', () => {
    expect(
      () =>
        new CidRefStore({
          gateways: ['https://ipfs.example.com'],
          encryptionKey: new Uint8Array(31),
        }),
    ).toThrow(/32 bytes/);
  });

  it('rejects 33-byte encryption key', () => {
    expect(
      () =>
        new CidRefStore({
          gateways: ['https://ipfs.example.com'],
          encryptionKey: new Uint8Array(33),
        }),
    ).toThrow(/32 bytes/);
  });

  it('accepts valid config', () => {
    expect(
      () =>
        new CidRefStore({
          gateways: ['https://ipfs.example.com'],
          encryptionKey: TEST_KEY,
        }),
    ).not.toThrow();
  });
});

// ── pinBytes / fetchBytes round-trip ──────────────────────────────────────

describe('CidRefStore — pinBytes / fetchBytes round-trip', () => {
  let gateway: ReturnType<typeof installFakeIpfsGateway>;
  let store: CidRefStore;

  beforeEach(() => {
    gateway = installFakeIpfsGateway();
    store = new CidRefStore({
      gateways: ['https://ipfs.example.com'],
      encryptionKey: TEST_KEY,
    });
  });

  it('pinBytes returns a valid CidRef', async () => {
    const payload = new TextEncoder().encode('hello world');
    const ref = await store.pinBytes(payload);
    expect(ref.v).toBe(CID_REF_SCHEMA_VERSION);
    expect(ref.cid).toMatch(/^bafkr/); // CIDv1 raw codec
    expect(ref.size).toBeGreaterThan(0);
    expect(ref.ts).toBeGreaterThan(0);
    gateway.cleanup();
  });

  it('fetchBytes returns the original plaintext', async () => {
    const payload = new TextEncoder().encode('round-trip test');
    const ref = await store.pinBytes(payload);
    const fetched = await store.fetchBytes(ref);
    expect(Array.from(fetched)).toEqual(Array.from(payload));
    gateway.cleanup();
  });

  it('empty payload round-trips', async () => {
    const ref = await store.pinBytes(new Uint8Array(0));
    const fetched = await store.fetchBytes(ref);
    expect(fetched.byteLength).toBe(0);
    gateway.cleanup();
  });

  it('large payload (100 KiB) round-trips', async () => {
    const payload = new Uint8Array(100 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
    const ref = await store.pinBytes(payload);
    const fetched = await store.fetchBytes(ref);
    expect(fetched.byteLength).toBe(payload.length);
    expect(Array.from(fetched.slice(0, 100))).toEqual(Array.from(payload.slice(0, 100)));
    gateway.cleanup();
  });

  it('stored IPFS content is CIPHERTEXT, not plaintext', async () => {
    const payload = new TextEncoder().encode('secret message');
    const ref = await store.pinBytes(payload);
    const storedBytes = gateway.store.get(ref.cid)!;
    // The stored bytes should NOT contain the plaintext marker anywhere.
    const storedAsString = new TextDecoder().decode(storedBytes);
    expect(storedAsString).not.toContain('secret message');
    // Ciphertext first byte is part of a random AES-GCM IV — effectively random.
    // Stored size should be plaintext + 12-byte IV + 16-byte auth tag.
    expect(storedBytes.byteLength).toBe(payload.byteLength + 12 + 16);
    gateway.cleanup();
  });
});

// ── pinJson / fetchJson ────────────────────────────────────────────────────

describe('CidRefStore — pinJson / fetchJson', () => {
  let gateway: ReturnType<typeof installFakeIpfsGateway>;
  let store: CidRefStore;

  beforeEach(() => {
    gateway = installFakeIpfsGateway();
    store = new CidRefStore({
      gateways: ['https://ipfs.example.com'],
      encryptionKey: TEST_KEY,
    });
  });

  it('JSON object round-trips', async () => {
    const original = { hello: 'world', count: 42, nested: { flag: true } };
    const ref = await store.pinJson(original);
    const fetched = await store.fetchJson<typeof original>(ref);
    expect(fetched).toEqual(original);
    gateway.cleanup();
  });

  it('JSON array round-trips (Pattern A usage)', async () => {
    const messages = [
      { id: 'msg1', content: 'hello' },
      { id: 'msg2', content: 'world' },
    ];
    const ref = await store.pinJson(messages);
    const fetched = await store.fetchJson<typeof messages>(ref);
    expect(fetched).toEqual(messages);
    gateway.cleanup();
  });

  it('contentV is preserved', async () => {
    const ref = await store.pinJson({ data: 'x' }, 42);
    expect(ref.contentV).toBe(42);
    gateway.cleanup();
  });
});

// ── stringifyRef / tryParseRef ─────────────────────────────────────────────

describe('CidRefStore.stringifyRef + tryParseRef — discriminator', () => {
  const VALID_REF: CidRef = {
    v: CID_REF_SCHEMA_VERSION,
    cid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    size: 1024,
    ts: 1700000000000,
  };

  it('stringifyRef + tryParseRef round-trip', () => {
    const str = CidRefStore.stringifyRef(VALID_REF);
    const parsed = CidRefStore.tryParseRef(str);
    expect(parsed).toEqual(VALID_REF);
  });

  it('preserves contentV field', () => {
    const ref: CidRef = { ...VALID_REF, contentV: 3 };
    const str = CidRefStore.stringifyRef(ref);
    const parsed = CidRefStore.tryParseRef(str);
    expect(parsed?.contentV).toBe(3);
  });

  it('returns null for empty string', () => {
    expect(CidRefStore.tryParseRef('')).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(CidRefStore.tryParseRef(null)).toBeNull();
    expect(CidRefStore.tryParseRef(undefined)).toBeNull();
  });

  it('returns null for non-JSON input (legacy inline blob)', () => {
    expect(CidRefStore.tryParseRef('just a plain string')).toBeNull();
  });

  it('returns null for legacy array (what legacy wallets stored)', () => {
    // Old format: storage.set(key, JSON.stringify([...tokens]))
    expect(CidRefStore.tryParseRef('[{"id":"token1"},{"id":"token2"}]')).toBeNull();
  });

  it('returns null for legacy object without v field', () => {
    expect(CidRefStore.tryParseRef('{"foo":"bar"}')).toBeNull();
  });

  it('returns null for wrong schema version (v=2)', () => {
    const bad = JSON.stringify({ v: 2, cid: 'bafy...', size: 100, ts: 123 });
    expect(CidRefStore.tryParseRef(bad)).toBeNull();
  });

  it('returns null for missing cid', () => {
    const bad = JSON.stringify({ v: 1, size: 100, ts: 123 });
    expect(CidRefStore.tryParseRef(bad)).toBeNull();
  });

  it('returns null for empty cid', () => {
    const bad = JSON.stringify({ v: 1, cid: '', size: 100, ts: 123 });
    expect(CidRefStore.tryParseRef(bad)).toBeNull();
  });

  it('returns null for negative size', () => {
    const bad = JSON.stringify({ v: 1, cid: 'bafy...', size: -1, ts: 123 });
    expect(CidRefStore.tryParseRef(bad)).toBeNull();
  });

  it('returns null for invalid ts', () => {
    const bad = JSON.stringify({ v: 1, cid: 'bafy...', size: 100, ts: 'not a number' });
    expect(CidRefStore.tryParseRef(bad)).toBeNull();
  });

  it('returns null for non-numeric contentV', () => {
    const bad = JSON.stringify({ v: 1, cid: 'bafy...', size: 100, ts: 123, contentV: 'x' });
    expect(CidRefStore.tryParseRef(bad)).toBeNull();
  });

  it('returns null for JSON array (not an envelope)', () => {
    expect(CidRefStore.tryParseRef('[1,2,3]')).toBeNull();
  });

  it('returns null for CBOR-like binary garbage', () => {
    // Simulate a previous-format raw string.
    expect(CidRefStore.tryParseRef('\xff\xfe\xfd')).toBeNull();
  });
});

// ── Integration: write ref, store it in a fake KV, read it back ───────────

describe('CidRefStore — end-to-end migration pattern', () => {
  let gateway: ReturnType<typeof installFakeIpfsGateway>;
  let store: CidRefStore;
  const fakeKv = new Map<string, string>();

  beforeEach(() => {
    gateway = installFakeIpfsGateway();
    store = new CidRefStore({
      gateways: ['https://ipfs.example.com'],
      encryptionKey: TEST_KEY,
    });
    fakeKv.clear();
  });

  it('module write/read pattern (Pattern A)', async () => {
    // WRITE: module has a large array of tokens.
    const tokens = Array.from({ length: 20 }, (_, i) => ({
      id: `token${i}`,
      sdkData: 'x'.repeat(2000), // simulate fat SDK data
    }));
    const ref = await store.pinJson(tokens);
    fakeKv.set('pendingV5', CidRefStore.stringifyRef(ref));

    // The value in the OpLog (fakeKv) is small — < 300 bytes.
    const opLogValue = fakeKv.get('pendingV5')!;
    expect(opLogValue.length).toBeLessThan(300);

    // READ: module reads back; discriminator says "it's a ref".
    const parsed = CidRefStore.tryParseRef(opLogValue);
    expect(parsed).not.toBeNull();
    const fetched = await store.fetchJson<typeof tokens>(parsed!);
    expect(fetched).toEqual(tokens);
    gateway.cleanup();
  });

  it('legacy fallback path: module reads old inline data, writes new ref', async () => {
    // Simulate a pre-refactor wallet with inline JSON.
    const legacyTokens = [{ id: 'legacy1' }, { id: 'legacy2' }];
    fakeKv.set('pendingV5', JSON.stringify(legacyTokens));

    // READ: module distinguishes legacy from new via tryParseRef.
    const storedValue = fakeKv.get('pendingV5')!;
    const ref = CidRefStore.tryParseRef(storedValue);
    expect(ref).toBeNull(); // legacy path

    const legacy = JSON.parse(storedValue);
    expect(legacy).toEqual(legacyTokens);

    // WRITE: on next save, module uses new ref path.
    const newTokens = [...legacy, { id: 'new3' }];
    const newRef = await store.pinJson(newTokens);
    fakeKv.set('pendingV5', CidRefStore.stringifyRef(newRef));

    // Verify: stored value is now a ref, not inline JSON.
    const afterWrite = fakeKv.get('pendingV5')!;
    const afterRef = CidRefStore.tryParseRef(afterWrite);
    expect(afterRef).not.toBeNull();
    gateway.cleanup();
  });
});
