/**
 * OrbitDbAdapter structured-entry API (PROFILE-OPLOG-SCHEMA.md §5).
 *
 * Tests the adapter's `putEntry` / `getEntry` methods by injecting a
 * fake `db` field — avoids the need for a real OrbitDB/Helia stack in
 * unit tests. The dynamic imports in `connect()` are skipped by
 * mutating the adapter's private state directly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OrbitDbAdapter } from '../../../profile/orbitdb-adapter';
import {
  buildLocalEntry,
  encodeEntry,
  OPLOG_ENTRY_SCHEMA_VERSION,
  OpLogEntryCorrupt,
  type OpLogEntryEnvelope,
} from '../../../profile/oplog-entry';
import { AggregatorPointerErrorCode } from '../../../profile/aggregator-pointer';

/**
 * Patch a fresh OrbitDbAdapter with a fake in-memory `db` so we can test
 * putEntry/getEntry without spinning up OrbitDB. We poke the private
 * fields via `as any` — only acceptable in tests.
 */
function makeAdapterWithFakeDb(): { adapter: OrbitDbAdapter; store: Map<string, Uint8Array> } {
  const adapter = new OrbitDbAdapter();
  const store = new Map<string, Uint8Array>();
  const fakeDb = {
    put: async (key: string, value: Uint8Array) => {
      store.set(key, value);
    },
    get: async (key: string) => {
      return store.get(key) ?? null;
    },
    del: async (key: string) => {
      store.delete(key);
    },
    all: async () => Array.from(store.entries()).map(([key, value]) => ({ key, value })),
    close: async () => { /* noop */ },
    events: {
      on: () => { /* noop */ },
      off: () => { /* noop */ },
    },
  };
  // Patch private fields via index-signature cast.
  (adapter as unknown as { db: unknown }).db = fakeDb;
  (adapter as unknown as { connected: boolean }).connected = true;
  return { adapter, store };
}

const PAYLOAD = new TextEncoder().encode('encrypted payload bytes');

// ── putEntry + getEntry round-trip ─────────────────────────────────────────

describe('OrbitDbAdapter.putEntry + getEntry — round-trip', () => {
  let adapter: OrbitDbAdapter;
  let store: Map<string, Uint8Array>;

  beforeEach(() => {
    ({ adapter, store } = makeAdapterWithFakeDb());
  });

  it('writes structured envelope via putEntry; reads it via getEntry with trustLocalClaim', async () => {
    const entry = buildLocalEntry({
      type: 'token_send',
      originated: 'user',
      payload: PAYLOAD,
    });
    await adapter.putEntry('tokens.bundle.abc', entry);
    // trustLocalClaim: true is required to see the stored 'user' tag.
    // Without it, the adapter defaults to replicated-downgrade (security).
    const read = await adapter.getEntry('tokens.bundle.abc', { trustLocalClaim: true });
    expect(read).not.toBeNull();
    expect(read!.type).toBe('token_send');
    expect(read!.originated).toBe('user');
    expect(Array.from(read!.payload)).toEqual(Array.from(PAYLOAD));
    expect(read!.ts).toBe(entry.ts);
  });

  it('default getEntry downgrades locally-written entries when trustLocalClaim omitted', async () => {
    // Security default: even for locally-authored entries, plain getEntry
    // returns 'replicated' unless caller explicitly trusts.
    const entry = buildLocalEntry({
      type: 'token_send',
      originated: 'user',
      payload: PAYLOAD,
    });
    await adapter.putEntry('tokens.bundle.abc', entry);
    const read = await adapter.getEntry('tokens.bundle.abc');
    expect(read!.originated).toBe('replicated');
    expect(read!.type).toBe('token_send');
  });

  it('getEntry returns null when key absent', async () => {
    const read = await adapter.getEntry('missing');
    expect(read).toBeNull();
  });

  it('putEntry stores deterministic CBOR bytes', async () => {
    const entry = buildLocalEntry({
      type: 'cache_index',
      originated: 'system',
      payload: PAYLOAD,
      ts: 1700000000000, // plausible real-wallet ts (>= MIN_PLAUSIBLE_TS)
    });
    await adapter.putEntry('key', entry);
    const raw = store.get('key');
    expect(raw).toBeDefined();
    // Re-encoding the same entry produces identical bytes.
    const expected = encodeEntry(entry);
    expect(Array.from(raw!)).toEqual(Array.from(expected));
  });
});

// ── Legacy opaque-bytes fallback ───────────────────────────────────────────

describe('OrbitDbAdapter.getEntry — legacy fallback (§7)', () => {
  let adapter: OrbitDbAdapter;
  let store: Map<string, Uint8Array>;

  beforeEach(() => {
    ({ adapter, store } = makeAdapterWithFakeDb());
  });

  it('wraps pre-schema opaque bytes in synthetic envelope', async () => {
    // Pre-schema OrbitDB stored raw Uint8Array values which IPLD-CBOR
    // encodes as CBOR byte-strings. Simulate that wire format.
    const { encode } = await import('@ipld/dag-cbor');
    const legacyPayload = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const legacyBytes = encode(legacyPayload);
    store.set('profile.identity', legacyBytes);

    const read = await adapter.getEntry('profile.identity');
    expect(read).not.toBeNull();
    expect(read!.v).toBe(0); // OPLOG_ENTRY_LEGACY_VERSION sentinel
    expect(read!.type).toBe('cache_index');
    expect(read!.originated).toBe('system');
    expect(read!.ts).toBe(0);
    expect(Array.from(read!.payload)).toEqual(Array.from(legacyPayload));
  });

  it('non-CBOR raw garbage FAILS CLOSED (steelman hardening)', async () => {
    // Post-steelman: random bytes must NOT be promoted to trusted system entries.
    store.set('bad.key', new Uint8Array([0xff, 0xfe, 0xfd, 0xfc]));
    await expect(adapter.getEntry('bad.key')).rejects.toMatchObject({
      code: 'ORBITDB_READ_FAILED',
    });
  });
});

// ── Replication-ingress downgrade ──────────────────────────────────────────

describe('OrbitDbAdapter.getEntry — downgradeAsReplicated (§5.2)', () => {
  let adapter: OrbitDbAdapter;

  beforeEach(() => {
    ({ adapter } = makeAdapterWithFakeDb());
  });

  it('default read overrides peer-claimed originated=user → replicated', async () => {
    // Post-steelman: downgrade is the DEFAULT, not opt-in. Writing an
    // envelope claiming 'user' origin is a local write (we're doing
    // putEntry ourselves in this test), so trustLocalClaim:true returns
    // the stored tag. Plain get() forces replicated regardless.
    const peerEnvelope: OpLogEntryEnvelope = {
      v: OPLOG_ENTRY_SCHEMA_VERSION,
      type: 'token_send',
      originated: 'user',
      ts: 1700000000000,
      payload: PAYLOAD,
    };
    await adapter.putEntry('tokens.bundle.xyz', peerEnvelope);

    // Default read: forces downgrade (even on locally-written entry).
    const plain = await adapter.getEntry('tokens.bundle.xyz');
    expect(plain!.originated).toBe('replicated');
    expect(plain!.type).toBe('token_send');

    // trustLocalClaim:true + key known locally → returns stored tag.
    const trusted = await adapter.getEntry('tokens.bundle.xyz', { trustLocalClaim: true });
    expect(trusted!.originated).toBe('user');

    // Explicit downgrade (legacy flag, still works).
    const downgraded = await adapter.getEntry('tokens.bundle.xyz', {
      downgradeAsReplicated: true,
    });
    expect(downgraded!.originated).toBe('replicated');
    expect(downgraded!.ts).toBe(1700000000000);
  });

  it('trustLocalClaim:true does NOT trust keys not locally-authored', async () => {
    const { adapter, store } = makeAdapterWithFakeDb();
    // Simulate a peer-authored write directly into the store (bypass putEntry).
    const { encodeEntry } = await import('../../../profile/oplog-entry');
    const peerEnvelope: OpLogEntryEnvelope = {
      v: OPLOG_ENTRY_SCHEMA_VERSION,
      type: 'token_send',
      originated: 'user', // peer's forgery
      ts: 1700000000000,
      payload: PAYLOAD,
    };
    store.set('tokens.bundle.peer', encodeEntry(peerEnvelope));

    // Key not in localAuthoredKeys → even with trustLocalClaim, downgrade.
    const read = await adapter.getEntry('tokens.bundle.peer', { trustLocalClaim: true });
    expect(read!.originated).toBe('replicated');
  });

  it('downgradeAsReplicated returns null when key absent', async () => {
    const read = await adapter.getEntry('missing', { downgradeAsReplicated: true });
    expect(read).toBeNull();
  });

  it('downgradeAsReplicated REJECTS legacy-shaped bytes (peers cannot deliver pre-schema)', async () => {
    // Post-steelman: legacy format is strictly a LOCAL read-time synthesis.
    // A peer delivering legacy-shaped bytes at replication ingress is a
    // protocol violation (SPEC §7 amended by steelman hardening).
    const { encode } = await import('@ipld/dag-cbor');
    const { adapter, store } = makeAdapterWithFakeDb();
    store.set('legacy', encode(new Uint8Array([0xde, 0xad])));

    await expect(
      adapter.getEntry('legacy', { downgradeAsReplicated: true }),
    ).rejects.toMatchObject({ code: 'ORBITDB_READ_FAILED' });
  });
});

// ── Validation errors ──────────────────────────────────────────────────────

describe('OrbitDbAdapter.putEntry — validation errors', () => {
  let adapter: OrbitDbAdapter;

  beforeEach(() => {
    ({ adapter } = makeAdapterWithFakeDb());
  });

  it('rejects envelope with invalid type (via encodeEntry shape check)', async () => {
    const bad = {
      v: OPLOG_ENTRY_SCHEMA_VERSION,
      type: 'unknown_type' as never,
      originated: 'user' as const,
      ts: 1,
      payload: PAYLOAD,
    };
    await expect(adapter.putEntry('key', bad)).rejects.toMatchObject({
      code: 'ORBITDB_WRITE_FAILED',
    });
  });
});

describe('OrbitDbAdapter.getEntry — corrupt-envelope gating', () => {
  let adapter: OrbitDbAdapter;
  let store: Map<string, Uint8Array>;

  beforeEach(() => {
    ({ adapter, store } = makeAdapterWithFakeDb());
  });

  it('fails closed on envelope with unknown schema version', async () => {
    // Hand-construct a CBOR envelope with v=99 (unknown version).
    const { encode } = await import('@ipld/dag-cbor');
    const futureBytes = encode({
      v: 99,
      type: 'token_send',
      originated: 'user',
      ts: 1,
      payload: PAYLOAD,
    });
    store.set('key', futureBytes);

    await expect(adapter.getEntry('key')).rejects.toMatchObject({
      code: 'ORBITDB_READ_FAILED',
    });
  });

  it('fails closed on envelope with invalid originated for unknown type', async () => {
    const { encode } = await import('@ipld/dag-cbor');
    const bad = encode({
      v: 1,
      type: 'totally_fake',
      originated: 'user',
      ts: 1,
      payload: PAYLOAD,
    });
    store.set('key', bad);

    await expect(adapter.getEntry('key')).rejects.toMatchObject({
      code: 'ORBITDB_READ_FAILED',
    });
  });
});

// ── ensureConnected guard ──────────────────────────────────────────────────

describe('OrbitDbAdapter — ensureConnected on structured-entry API', () => {
  it('putEntry throws PROFILE_NOT_INITIALIZED when not connected', async () => {
    const adapter = new OrbitDbAdapter();
    const entry = buildLocalEntry({
      type: 'token_send',
      originated: 'user',
      payload: PAYLOAD,
    });
    await expect(adapter.putEntry('k', entry)).rejects.toMatchObject({
      code: 'PROFILE_NOT_INITIALIZED',
    });
  });

  it('getEntry throws PROFILE_NOT_INITIALIZED when not connected', async () => {
    const adapter = new OrbitDbAdapter();
    await expect(adapter.getEntry('k')).rejects.toMatchObject({
      code: 'PROFILE_NOT_INITIALIZED',
    });
  });
});

// ── Coherence with buildLocalEntry ─────────────────────────────────────────

describe('OrbitDbAdapter.putEntry — coherence via buildLocalEntry', () => {
  it('encodeEntry enforces originated-tag discipline via buildLocalEntry', async () => {
    // buildLocalEntry throws SECURITY_ORIGIN_MISMATCH BEFORE reaching the adapter.
    expect(() =>
      buildLocalEntry({
        type: 'token_send',
        originated: 'system', // wrong — user-action types require 'user'
        payload: PAYLOAD,
      }),
    ).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH }),
    );
  });

  it('OpLogEntryCorrupt is exported and usable', () => {
    // Sanity: the error class is exported from oplog-entry.ts for callers to
    // catch selectively. Adapter wraps such errors in ProfileError('ORBITDB_*').
    const err = new OpLogEntryCorrupt('test');
    expect(err.name).toBe('OpLogEntryCorrupt');
  });
});
