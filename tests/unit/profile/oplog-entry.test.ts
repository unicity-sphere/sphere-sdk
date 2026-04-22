/**
 * OpLog entry envelope tests — PROFILE-OPLOG-SCHEMA.md.
 *
 * Covers:
 *   - encode/decode round-trip for envelope
 *   - deterministic encoding (byte-identical for equal inputs)
 *   - schema version gating (unknown v fails closed)
 *   - legacy opaque-bytes fallback (wrap as synthetic envelope)
 *   - validation rejects malformed fields
 *   - buildLocalEntry enforces type/originated coherence
 *   - decodeAndDowngradeReplicated overrides peer-claimed origin tag
 *   - isLegacyEntry identifies migrated entries
 */

import { describe, it, expect } from 'vitest';
import { encode as cborEncode } from '@ipld/dag-cbor';
import {
  buildLocalEntry,
  decodeAndDowngradeReplicated,
  decodeEntry,
  encodeEntry,
  isLegacyEntry,
  OPLOG_ENTRY_SCHEMA_VERSION,
  OpLogEntryCorrupt,
  type OpLogEntryEnvelope,
} from '../../../profile/oplog-entry.js';
import { AggregatorPointerErrorCode } from '../../../profile/aggregator-pointer/index.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

const PAYLOAD = new TextEncoder().encode('test payload bytes');

function sampleEnvelope(): OpLogEntryEnvelope {
  return {
    v: OPLOG_ENTRY_SCHEMA_VERSION,
    type: 'token_send',
    originated: 'user',
    ts: 1700000000000,
    payload: PAYLOAD,
  };
}

// ── Round-trip ────────────────────────────────────────────────────────────

describe('encodeEntry + decodeEntry — round-trip', () => {
  it('encodes and decodes a valid envelope losslessly', () => {
    const entry = sampleEnvelope();
    const bytes = encodeEntry(entry);
    const decoded = decodeEntry(bytes);
    expect(decoded.v).toBe(OPLOG_ENTRY_SCHEMA_VERSION);
    expect(decoded.type).toBe('token_send');
    expect(decoded.originated).toBe('user');
    expect(decoded.ts).toBe(1700000000000);
    expect(Array.from(decoded.payload)).toEqual(Array.from(PAYLOAD));
  });

  it('deterministic encoding: same input → same bytes', () => {
    const entry = sampleEnvelope();
    const b1 = encodeEntry(entry);
    const b2 = encodeEntry(entry);
    expect(Array.from(b1)).toEqual(Array.from(b2));
  });

  it('handles empty payload', () => {
    const entry: OpLogEntryEnvelope = {
      v: OPLOG_ENTRY_SCHEMA_VERSION,
      type: 'cache_index',
      originated: 'system',
      ts: 1,
      payload: new Uint8Array(0),
    };
    const decoded = decodeEntry(encodeEntry(entry));
    expect(decoded.payload.length).toBe(0);
  });

  it('handles large payload (1 MiB)', () => {
    const big = new Uint8Array(1024 * 1024).fill(0x42);
    const entry: OpLogEntryEnvelope = {
      ...sampleEnvelope(),
      payload: big,
    };
    const decoded = decodeEntry(encodeEntry(entry));
    expect(decoded.payload.length).toBe(big.length);
    expect(decoded.payload[0]).toBe(0x42);
    expect(decoded.payload[big.length - 1]).toBe(0x42);
  });

  it('all user-action types round-trip', () => {
    const userTypes = [
      'token_send', 'token_receive', 'nametag_register',
      'dm_send', 'dm_receive',
      'invoice_mint', 'invoice_pay', 'invoice_close', 'invoice_cancel',
      'swap_propose', 'swap_accept', 'swap_deposit',
    ] as const;
    for (const type of userTypes) {
      const entry: OpLogEntryEnvelope = {
        v: OPLOG_ENTRY_SCHEMA_VERSION,
        type,
        originated: 'user',
        ts: 1,
        payload: PAYLOAD,
      };
      const decoded = decodeEntry(encodeEntry(entry));
      expect(decoded.type).toBe(type);
    }
  });

  it('all system types round-trip', () => {
    const systemTypes = ['session_receipt', 'cache_index', 'last_opened_ts'] as const;
    for (const type of systemTypes) {
      const entry: OpLogEntryEnvelope = {
        v: OPLOG_ENTRY_SCHEMA_VERSION,
        type,
        originated: 'system',
        ts: 1,
        payload: PAYLOAD,
      };
      const decoded = decodeEntry(encodeEntry(entry));
      expect(decoded.type).toBe(type);
    }
  });
});

// ── Schema version gating ─────────────────────────────────────────────────

describe('decodeEntry — schema version gating', () => {
  it('fails closed on unknown schema version (v=2)', () => {
    const futureEnvelope = cborEncode({
      v: 2,
      type: 'token_send',
      originated: 'user',
      ts: 1,
      payload: PAYLOAD,
    });
    expect(() => decodeEntry(futureEnvelope)).toThrow(OpLogEntryCorrupt);
  });

  it('fails closed on v=0', () => {
    const zeroVersion = cborEncode({
      v: 0,
      type: 'token_send',
      originated: 'user',
      ts: 1,
      payload: PAYLOAD,
    });
    expect(() => decodeEntry(zeroVersion)).toThrow(OpLogEntryCorrupt);
  });
});

// ── Legacy fallback ───────────────────────────────────────────────────────

describe('decodeEntry — legacy fallback (§7.1)', () => {
  it('wraps raw opaque bytes (not CBOR-decodable)', () => {
    // Some raw bytes that will either fail CBOR decode or decode to a non-object.
    const legacyBytes = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc]);
    const decoded = decodeEntry(legacyBytes);
    expect(decoded.v).toBe(OPLOG_ENTRY_SCHEMA_VERSION);
    expect(decoded.type).toBe('cache_index'); // conservative default
    expect(decoded.originated).toBe('system');
    expect(decoded.ts).toBe(0);
    expect(Array.from(decoded.payload)).toEqual(Array.from(legacyBytes));
  });

  it('wraps CBOR-decodable non-object (e.g., plain text string)', () => {
    const plainString = cborEncode('just a string');
    const decoded = decodeEntry(plainString);
    // Falls back to legacy: wraps the raw bytes as payload.
    expect(decoded.ts).toBe(0);
    expect(Array.from(decoded.payload)).toEqual(Array.from(plainString));
  });

  it('wraps CBOR map lacking `v` field', () => {
    // An object that decodes successfully but has no schema-version field.
    const fakeMap = cborEncode({ someField: 42, another: 'value' });
    const decoded = decodeEntry(fakeMap);
    expect(decoded.ts).toBe(0);
    expect(decoded.originated).toBe('system');
  });

  it('wraps empty byte buffer as legacy', () => {
    const empty = new Uint8Array(0);
    const decoded = decodeEntry(empty);
    expect(decoded.ts).toBe(0);
    expect(decoded.payload.length).toBe(0);
  });

  it('isLegacyEntry identifies the synthetic wrapper', () => {
    const legacy = decodeEntry(new Uint8Array([0xff]));
    expect(isLegacyEntry(legacy)).toBe(true);

    const real = decodeEntry(encodeEntry(sampleEnvelope()));
    expect(isLegacyEntry(real)).toBe(false);
  });
});

// ── Validation ────────────────────────────────────────────────────────────

describe('decodeEntry — malformed fields', () => {
  it('rejects invalid type', () => {
    const bad = cborEncode({
      v: 1,
      type: 'unknown_type',
      originated: 'user',
      ts: 1,
      payload: PAYLOAD,
    });
    expect(() => decodeEntry(bad)).toThrow(OpLogEntryCorrupt);
  });

  it('rejects invalid originated', () => {
    const bad = cborEncode({
      v: 1,
      type: 'token_send',
      originated: 'malicious',
      ts: 1,
      payload: PAYLOAD,
    });
    expect(() => decodeEntry(bad)).toThrow(OpLogEntryCorrupt);
  });

  it('rejects negative ts', () => {
    const bad = cborEncode({
      v: 1,
      type: 'token_send',
      originated: 'user',
      ts: -1,
      payload: PAYLOAD,
    });
    expect(() => decodeEntry(bad)).toThrow(OpLogEntryCorrupt);
  });

  it('rejects non-bytes payload', () => {
    const bad = cborEncode({
      v: 1,
      type: 'token_send',
      originated: 'user',
      ts: 1,
      payload: 'a string, not bytes',
    });
    expect(() => decodeEntry(bad)).toThrow(OpLogEntryCorrupt);
  });
});

describe('encodeEntry — shape validation at write site', () => {
  it('rejects invalid type', () => {
    const bad = {
      ...sampleEnvelope(),
      type: 'not_a_type' as never,
    };
    expect(() => encodeEntry(bad)).toThrow(OpLogEntryCorrupt);
  });

  it('rejects wrong schema version', () => {
    const bad = {
      ...sampleEnvelope(),
      v: 2 as never,
    };
    expect(() => encodeEntry(bad)).toThrow(OpLogEntryCorrupt);
  });

  it('rejects payload not Uint8Array', () => {
    const bad = {
      ...sampleEnvelope(),
      payload: 'wrong type' as never,
    };
    expect(() => encodeEntry(bad)).toThrow(OpLogEntryCorrupt);
  });
});

// ── buildLocalEntry ───────────────────────────────────────────────────────

describe('buildLocalEntry', () => {
  it('stamps user type + user origin correctly', () => {
    const entry = buildLocalEntry({
      type: 'token_send',
      originated: 'user',
      payload: PAYLOAD,
    });
    expect(entry.v).toBe(OPLOG_ENTRY_SCHEMA_VERSION);
    expect(entry.type).toBe('token_send');
    expect(entry.originated).toBe('user');
    expect(entry.payload).toBe(PAYLOAD);
    expect(entry.ts).toBeGreaterThan(0);
  });

  it('stamps system type + system origin correctly', () => {
    const entry = buildLocalEntry({
      type: 'cache_index',
      originated: 'system',
      payload: PAYLOAD,
    });
    expect(entry.type).toBe('cache_index');
    expect(entry.originated).toBe('system');
  });

  it('throws SECURITY_ORIGIN_MISMATCH for user type with system origin', () => {
    expect(() =>
      buildLocalEntry({
        type: 'token_send',
        originated: 'system',
        payload: PAYLOAD,
      }),
    ).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH }),
    );
  });

  it('throws SECURITY_ORIGIN_MISMATCH for system type with user origin', () => {
    expect(() =>
      buildLocalEntry({
        type: 'cache_index',
        originated: 'user',
        payload: PAYLOAD,
      }),
    ).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH }),
    );
  });

  it('accepts caller-supplied ts', () => {
    const entry = buildLocalEntry({
      type: 'token_send',
      originated: 'user',
      payload: PAYLOAD,
      ts: 42,
    });
    expect(entry.ts).toBe(42);
  });
});

// ── decodeAndDowngradeReplicated ──────────────────────────────────────────

describe('decodeAndDowngradeReplicated (§5.2)', () => {
  it('overrides peer-claimed originated=user → replicated', () => {
    // A malicious peer publishes an entry claiming user origin.
    const peerEnvelope: OpLogEntryEnvelope = {
      v: OPLOG_ENTRY_SCHEMA_VERSION,
      type: 'token_send',
      originated: 'user', // peer's claim
      ts: 1700000000000,
      payload: PAYLOAD,
    };
    const bytes = encodeEntry(peerEnvelope);

    const downgraded = decodeAndDowngradeReplicated(bytes);
    // The local client treats this as replicated — peer claim is IGNORED.
    expect(downgraded.originated).toBe('replicated');
    expect(downgraded.type).toBe('token_send'); // type preserved
    expect(downgraded.ts).toBe(1700000000000); // ts preserved (author's timestamp)
  });

  it('overrides peer-claimed system → replicated', () => {
    const peerEnvelope: OpLogEntryEnvelope = {
      v: OPLOG_ENTRY_SCHEMA_VERSION,
      type: 'cache_index',
      originated: 'system',
      ts: 1,
      payload: PAYLOAD,
    };
    const downgraded = decodeAndDowngradeReplicated(encodeEntry(peerEnvelope));
    expect(downgraded.originated).toBe('replicated');
  });

  it('passes replicated entries through (idempotent)', () => {
    const replicatedEnvelope: OpLogEntryEnvelope = {
      v: OPLOG_ENTRY_SCHEMA_VERSION,
      type: 'swap_propose',
      originated: 'replicated',
      ts: 1,
      payload: PAYLOAD,
    };
    const downgraded = decodeAndDowngradeReplicated(encodeEntry(replicatedEnvelope));
    expect(downgraded.originated).toBe('replicated');
  });

  it('throws OpLogEntryCorrupt on malformed bytes at decode step', () => {
    const bad = cborEncode({ v: 1, type: 'unknown', originated: 'user', ts: 1, payload: PAYLOAD });
    expect(() => decodeAndDowngradeReplicated(bad)).toThrow(OpLogEntryCorrupt);
  });

  it('legacy entry flows through replicated ingress unchanged (as replicated system)', () => {
    const legacyBytes = new Uint8Array([0xff, 0xfe, 0xfd]);
    // Legacy wraps as { type: 'cache_index', originated: 'system', ts: 0 }.
    // downgradeForReplication then sets originated = 'replicated'.
    const downgraded = decodeAndDowngradeReplicated(legacyBytes);
    expect(downgraded.originated).toBe('replicated');
    expect(downgraded.ts).toBe(0); // legacy marker
  });
});
