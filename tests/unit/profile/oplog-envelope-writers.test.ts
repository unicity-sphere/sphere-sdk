/**
 * Issue #247 — round-trip tests for OutboxWriter and SentLedgerWriter
 * exercising the new envelope-capable ProfileDatabase surface.
 *
 * Two scenarios per writer:
 *   1. Envelope-capable adapter: writes go through putEntry, the
 *      stored bytes are CBOR-encoded envelopes, and reads decode
 *      them cleanly.
 *   2. Backwards-compat: a pre-#247 legacy raw-ciphertext entry at
 *      the same key reads cleanly via the dual-format helper's
 *      fallback path.
 */

import { describe, it, expect } from 'vitest';

import { Lamport } from '../../../extensions/uxf/profile/lamport.js';
import { OutboxWriter, type OutboxWriteInput } from '../../../extensions/uxf/profile/outbox-writer.js';
import { SentLedgerWriter, type SentLedgerWriteInput } from '../../../extensions/uxf/profile/sent-ledger-writer.js';
import {
  encryptProfileValue,
} from '../../../extensions/uxf/profile/encryption.js';
import { deriveProfileEncryptionKey } from '../../../extensions/uxf/profile/encryption.js';
import {
  decodeEntry,
  encodeEntry,
  OPLOG_ENTRY_SCHEMA_VERSION,
} from '../../../extensions/uxf/profile/oplog-entry.js';
import type { ProfileDatabase } from '../../../extensions/uxf/profile/types.js';

const ADDR = 'DIRECT_aabbcc_ddeeff';
const KEY = deriveProfileEncryptionKey(new Uint8Array(32).fill(11));

interface EnvelopeDb extends ProfileDatabase {
  _store: Map<string, Uint8Array>;
  _localKeys: Set<string>;
}

function makeEnvelopeDb(): EnvelopeDb {
  const store = new Map<string, Uint8Array>();
  const localKeys = new Set<string>();
  const db: EnvelopeDb = {
    _store: store,
    _localKeys: localKeys,
    async connect() {},
    async put(k, v) {
      store.set(k, v);
    },
    async get(k) {
      return store.get(k) ?? null;
    },
    async del(k) {
      store.delete(k);
    },
    async all(prefix) {
      const out = new Map<string, Uint8Array>();
      for (const [k, v] of store.entries()) {
        if (prefix && !k.startsWith(prefix)) continue;
        out.set(k, v);
      }
      return out;
    },
    async close() {},
    onReplication() {
      return () => {};
    },
    isConnected() {
      return true;
    },
    async putEntry(key, entry) {
      const cborBytes = encodeEntry(entry as Parameters<typeof encodeEntry>[0]);
      store.set(key, cborBytes);
      localKeys.add(key);
    },
    async getEntry(key, _opts) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return decodeEntry(raw);
    },
    markLocallyAuthored(key: string) {
      localKeys.add(key);
    },
  } as EnvelopeDb & { markLocallyAuthored: (k: string) => void };
  return db;
}

function buildOutboxInput(id: string): OutboxWriteInput {
  const now = Date.now();
  return {
    id,
    bundleCid: `bafy-${id}`,
    tokenIds: ['0xt1'],
    deliveryMethod: 'car-over-nostr',
    recipient: '@bob',
    recipientTransportPubkey: 'a'.repeat(64),
    mode: 'instant',
    status: 'packaging',
    submitRetryCount: 0,
    proofErrorCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function buildSentInput(id: string): SentLedgerWriteInput {
  return {
    id,
    bundleCid: `bafy-${id}`,
    nostrEventId: 'e'.repeat(64),
    tokenIds: ['0xt1'],
    deliveryMethod: 'car-over-nostr',
    recipient: '@bob',
    recipientTransportPubkey: 'a'.repeat(64),
    mode: 'instant',
    sentAt: Date.now(),
  };
}

// =============================================================================
// OutboxWriter
// =============================================================================

describe('Issue #247 — OutboxWriter envelope round-trip', () => {
  it('writes through putEntry; stored bytes are a CBOR envelope', async () => {
    const db = makeEnvelopeDb();
    const writer = new OutboxWriter({
      db,
      encryptionKey: KEY,
      addressId: ADDR,
      lamport: new Lamport(),
    });

    await writer.write(buildOutboxInput('out-1'));

    // Locally-authored key tracked by putEntry-aware adapter.
    expect(db._localKeys.has(`${ADDR}.outbox.out-1`)).toBe(true);

    // Stored bytes decode as a v=1 envelope.
    const raw = db._store.get(`${ADDR}.outbox.out-1`)!;
    const envelope = decodeEntry(raw);
    expect(envelope.v).toBe(OPLOG_ENTRY_SCHEMA_VERSION);
    expect(envelope.type).toBe('cache_index');
    expect(envelope.originated).toBe('system');
  });

  it('round-trip: write -> readOne returns the entry', async () => {
    const db = makeEnvelopeDb();
    const writer = new OutboxWriter({
      db,
      encryptionKey: KEY,
      addressId: ADDR,
      lamport: new Lamport(),
    });

    await writer.write(buildOutboxInput('out-2'));
    const got = await writer.readOne('out-2');

    expect(got).not.toBeNull();
    expect(got!.shape).toBe('uxf-1');
    if (got!.shape === 'uxf-1') {
      expect(got!.entry.id).toBe('out-2');
      expect(got!.entry.bundleCid).toBe('bafy-out-2');
    }
  });

  it('backwards-compat: reads a legacy raw-ciphertext entry', async () => {
    const db = makeEnvelopeDb();
    const writer = new OutboxWriter({
      db,
      encryptionKey: KEY,
      addressId: ADDR,
      lamport: new Lamport(),
    });

    // Simulate a pre-#247 raw write: legacy outbox entry encrypted
    // and stored via db.put (no putEntry, no envelope wrap).
    const legacyEntry = {
      _schemaVersion: 'uxf-1',
      id: 'legacy-out',
      bundleCid: 'bafy-legacy',
      tokenIds: ['0xlegacy'],
      deliveryMethod: 'car-over-nostr',
      recipient: '@charlie',
      recipientTransportPubkey: 'b'.repeat(64),
      mode: 'instant',
      status: 'packaging',
      submitRetryCount: 0,
      proofErrorCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lamport: 1,
    };
    const ciphertext = await encryptProfileValue(
      KEY,
      new TextEncoder().encode(JSON.stringify(legacyEntry)),
    );
    db._store.set(`${ADDR}.outbox.legacy-out`, ciphertext);

    const got = await writer.readOne('legacy-out');
    expect(got).not.toBeNull();
    if (got!.shape === 'uxf-1') {
      expect(got!.entry.id).toBe('legacy-out');
      expect(got!.entry.bundleCid).toBe('bafy-legacy');
    }
  });

  it('readAll sees envelope-wrapped entries from db.all()', async () => {
    const db = makeEnvelopeDb();
    const writer = new OutboxWriter({
      db,
      encryptionKey: KEY,
      addressId: ADDR,
      lamport: new Lamport(),
    });

    await writer.write(buildOutboxInput('a'));
    await writer.write(buildOutboxInput('b'));
    await writer.write(buildOutboxInput('c'));

    const all = await writer.readAll();
    expect(all.length).toBe(3);
    const ids = new Set(
      all.map((c) => (c.shape === 'uxf-1' ? c.entry.id : c.entry.id)),
    );
    expect(ids.has('a')).toBe(true);
    expect(ids.has('b')).toBe(true);
    expect(ids.has('c')).toBe(true);
  });
});

// =============================================================================
// SentLedgerWriter
// =============================================================================

describe('Issue #247 — SentLedgerWriter envelope round-trip', () => {
  it('writes through putEntry; stored bytes are a CBOR envelope', async () => {
    const db = makeEnvelopeDb();
    const writer = new SentLedgerWriter({
      db,
      encryptionKey: KEY,
      addressId: ADDR,
      lamport: new Lamport(),
    });

    await writer.write(buildSentInput('sent-1'));

    expect(db._localKeys.has(`${ADDR}.sent.sent-1`)).toBe(true);

    const raw = db._store.get(`${ADDR}.sent.sent-1`)!;
    const envelope = decodeEntry(raw);
    expect(envelope.v).toBe(OPLOG_ENTRY_SCHEMA_VERSION);
    expect(envelope.type).toBe('cache_index');
    expect(envelope.originated).toBe('system');
  });

  it('round-trip: write -> readOne returns the entry', async () => {
    const db = makeEnvelopeDb();
    const writer = new SentLedgerWriter({
      db,
      encryptionKey: KEY,
      addressId: ADDR,
      lamport: new Lamport(),
    });

    await writer.write(buildSentInput('sent-2'));
    const got = await writer.readOne('sent-2');
    expect(got).not.toBeNull();
    expect(got!.id).toBe('sent-2');
  });

  it('backwards-compat: reads a legacy raw-ciphertext entry', async () => {
    const db = makeEnvelopeDb();
    const writer = new SentLedgerWriter({
      db,
      encryptionKey: KEY,
      addressId: ADDR,
      lamport: new Lamport(),
    });

    const legacyEntry = {
      _schemaVersion: 'uxf-1',
      id: 'legacy-sent',
      bundleCid: 'bafy-legacy-sent',
      nostrEventId: 'e'.repeat(64),
      tokenIds: ['0xlegacy'],
      deliveryMethod: 'car-over-nostr',
      recipient: '@charlie',
      recipientTransportPubkey: 'b'.repeat(64),
      mode: 'instant',
      sentAt: Date.now(),
      lamport: 1,
    };
    const ciphertext = await encryptProfileValue(
      KEY,
      new TextEncoder().encode(JSON.stringify(legacyEntry)),
    );
    db._store.set(`${ADDR}.sent.legacy-sent`, ciphertext);

    const got = await writer.readOne('legacy-sent');
    expect(got).not.toBeNull();
    expect(got!.id).toBe('legacy-sent');
  });
});
