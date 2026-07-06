/**
 * OpLog entry envelope tests — PROFILE-OPLOG-SCHEMA.md.
 *
 * Covers (post-steelman-hardening):
 *   - encode/decode round-trip for envelope
 *   - deterministic encoding (byte-identical for equal inputs)
 *   - schema version gating (unknown v fails closed)
 *   - legacy opaque-bytes fallback (STRICT: only Uint8Array decode wraps)
 *   - CBOR decode failure fails closed (no legacy promotion)
 *   - validation rejects malformed fields (ts range, payload size, extra fields)
 *   - buildLocalEntry enforces type/originated coherence
 *   - decodeAndDowngradeReplicated overrides peer-claimed origin tag
 *   - decodeAndDowngradeReplicated REJECTS legacy-shaped replicated bytes
 *   - isLegacyEntry identifies migrated entries via v=0 sentinel
 *   - MAX_ENVELOPE_BYTES / MAX_PAYLOAD_BYTES DoS guards
 *   - defensive payload copies (no aliasing)
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
  OPLOG_ENTRY_LEGACY_VERSION,
  MAX_ENVELOPE_BYTES,
  MAX_PAYLOAD_BYTES,
  OpLogEntryCorrupt,
  type OpLogEntryEnvelope,
} from '../../../extensions/uxf/profile/oplog-entry.js';
import { AggregatorPointerErrorCode } from '../../../extensions/uxf/profile/aggregator-pointer/index.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

const PAYLOAD = new TextEncoder().encode('test payload bytes');
/** Plausible real-wallet ts (2023-11-14 UTC). */
const TS = 1700000000000;

function sampleEnvelope(): OpLogEntryEnvelope {
  return {
    v: OPLOG_ENTRY_SCHEMA_VERSION,
    type: 'token_send',
    originated: 'user',
    ts: TS,
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
    expect(decoded.ts).toBe(TS);
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
      ts: TS,
      payload: new Uint8Array(0),
    };
    const decoded = decodeEntry(encodeEntry(entry));
    expect(decoded.payload.length).toBe(0);
  });

  it('handles large payload (just under MAX_PAYLOAD_BYTES)', () => {
    const big = new Uint8Array(MAX_PAYLOAD_BYTES - 100).fill(0x42);
    const entry: OpLogEntryEnvelope = {
      ...sampleEnvelope(),
      payload: big,
    };
    const decoded = decodeEntry(encodeEntry(entry));
    expect(decoded.payload.length).toBe(big.length);
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
        ts: TS,
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
        ts: TS,
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
      ts: TS,
      payload: PAYLOAD,
    });
    expect(() => decodeEntry(futureEnvelope)).toThrow(OpLogEntryCorrupt);
  });

  it('fails closed on v=0 (legacy sentinel cannot arrive via CBOR encode path)', () => {
    // A peer tries to forge a legacy-looking envelope. We reject because
    // legitimate legacy bytes never reach this path (they're Uint8Array CBOR).
    const fakeLegacyShape = cborEncode({
      v: 0,
      type: 'cache_index',
      originated: 'system',
      ts: 0,
      payload: PAYLOAD,
    });
    expect(() => decodeEntry(fakeLegacyShape)).toThrow(OpLogEntryCorrupt);
  });
});

// ── Legacy fallback (strict — post-steelman) ──────────────────────────────

describe('decodeEntry — legacy fallback (§7.1 v2 strict)', () => {
  it('wraps authentic legacy Uint8Array CBOR byte-string', () => {
    // Pre-schema OrbitDB stored raw Uint8Array values; IPLD CBOR encodes
    // these as CBOR byte-strings. Decoded shape is Uint8Array → wrap.
    const legacyPayload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const legacyCbor = cborEncode(legacyPayload);
    const decoded = decodeEntry(legacyCbor);
    expect(decoded.v).toBe(OPLOG_ENTRY_LEGACY_VERSION);
    expect(decoded.type).toBe('cache_index');
    expect(decoded.originated).toBe('system');
    expect(decoded.ts).toBe(0);
    expect(Array.from(decoded.payload)).toEqual(Array.from(legacyPayload));
  });

  it('FAIL-CLOSED on non-CBOR bytes (no promotion to legacy)', () => {
    // Post-steelman: a hostile peer writing raw non-CBOR garbage must NOT
    // be promoted to trusted cache_index/system.
    const garbage = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc]);
    expect(() => decodeEntry(garbage)).toThrow(OpLogEntryCorrupt);
  });

  it('FAIL-CLOSED on CBOR that decodes to a plain text string', () => {
    const plainString = cborEncode('just a string');
    expect(() => decodeEntry(plainString)).toThrow(OpLogEntryCorrupt);
  });

  it('FAIL-CLOSED on CBOR map lacking `v` field', () => {
    // Pre-steelman: this fell back to legacy. Post-steelman: rejected.
    const fakeMap = cborEncode({ someField: 42, another: 'value' });
    expect(() => decodeEntry(fakeMap)).toThrow(OpLogEntryCorrupt);
  });

  it('FAIL-CLOSED on empty byte buffer', () => {
    expect(() => decodeEntry(new Uint8Array(0))).toThrow(OpLogEntryCorrupt);
  });

  it('FAIL-CLOSED on CBOR array', () => {
    const arrayCbor = cborEncode([1, 2, 3]);
    expect(() => decodeEntry(arrayCbor)).toThrow(OpLogEntryCorrupt);
  });

  it('FAIL-CLOSED on envelope with extra fields (strict shape)', () => {
    const withExtra = cborEncode({
      v: 1,
      type: 'token_send',
      originated: 'user',
      ts: TS,
      payload: PAYLOAD,
      rogue_field: 'attacker_data',
    });
    expect(() => decodeEntry(withExtra)).toThrow(OpLogEntryCorrupt);
  });

  it('isLegacyEntry discriminates on v=0 sentinel', () => {
    const legacy = decodeEntry(cborEncode(new Uint8Array([0xff])));
    expect(isLegacyEntry(legacy)).toBe(true);

    const real = decodeEntry(encodeEntry(sampleEnvelope()));
    expect(isLegacyEntry(real)).toBe(false);
  });
});

// ── DoS guards ────────────────────────────────────────────────────────────

describe('decodeEntry — MAX_ENVELOPE_BYTES / MAX_PAYLOAD_BYTES guards', () => {
  it('rejects pre-decode inputs exceeding MAX_ENVELOPE_BYTES', () => {
    const huge = new Uint8Array(MAX_ENVELOPE_BYTES + 1);
    expect(() => decodeEntry(huge)).toThrow(OpLogEntryCorrupt);
    // Error should NOT mention CBOR (pre-decode guard fired first).
    try {
      decodeEntry(huge);
    } catch (e) {
      expect((e as Error).message).toContain('MAX_ENVELOPE_BYTES');
    }
  });

  it('rejects post-decode envelope payload exceeding MAX_PAYLOAD_BYTES', () => {
    // Build a CBOR envelope with oversized payload, but envelope bytes
    // stay under MAX_ENVELOPE_BYTES so the pre-decode guard doesn't fire.
    // MAX_PAYLOAD_BYTES=128KB, MAX_ENVELOPE_BYTES=256KB — fits cleanly.
    const oversized = new Uint8Array(MAX_PAYLOAD_BYTES + 1);
    const bytes = cborEncode({
      v: 1,
      type: 'token_send',
      originated: 'user',
      ts: TS,
      payload: oversized,
    });
    // This envelope's CBOR bytes are ~130 KB — under 256 KB envelope cap.
    expect(bytes.byteLength).toBeLessThan(MAX_ENVELOPE_BYTES);
    expect(() => decodeEntry(bytes)).toThrow(OpLogEntryCorrupt);
  });
});

// ── Validation ────────────────────────────────────────────────────────────

describe('decodeEntry — malformed fields', () => {
  it('rejects invalid type', () => {
    const bad = cborEncode({
      v: 1,
      type: 'unknown_type',
      originated: 'user',
      ts: TS,
      payload: PAYLOAD,
    });
    expect(() => decodeEntry(bad)).toThrow(OpLogEntryCorrupt);
  });

  it('rejects invalid originated', () => {
    const bad = cborEncode({
      v: 1,
      type: 'token_send',
      originated: 'malicious',
      ts: TS,
      payload: PAYLOAD,
    });
    expect(() => decodeEntry(bad)).toThrow(OpLogEntryCorrupt);
  });

  it('rejects ts below MIN_PLAUSIBLE_TS (attacker-set low ts)', () => {
    const bad = cborEncode({
      v: 1,
      type: 'token_send',
      originated: 'user',
      ts: 1, // way below 2020
      payload: PAYLOAD,
    });
    expect(() => decodeEntry(bad)).toThrow(OpLogEntryCorrupt);
  });

  it('rejects ts = 0 (reserved for legacy sentinel)', () => {
    const bad = cborEncode({
      v: 1,
      type: 'token_send',
      originated: 'user',
      ts: 0,
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

  it('rejects non-integer ts (floating point)', () => {
    const bad = cborEncode({
      v: 1,
      type: 'token_send',
      originated: 'user',
      ts: 1700000000000.5,
      payload: PAYLOAD,
    });
    expect(() => decodeEntry(bad)).toThrow(OpLogEntryCorrupt);
  });

  it('rejects non-bytes payload', () => {
    const bad = cborEncode({
      v: 1,
      type: 'token_send',
      originated: 'user',
      ts: TS,
      payload: 'a string, not bytes',
    });
    expect(() => decodeEntry(bad)).toThrow(OpLogEntryCorrupt);
  });
});

describe('encodeEntry — shape validation at write site', () => {
  it('rejects invalid type', () => {
    const bad = { ...sampleEnvelope(), type: 'not_a_type' as never };
    expect(() => encodeEntry(bad)).toThrow(OpLogEntryCorrupt);
  });

  it('rejects wrong schema version', () => {
    const bad = { ...sampleEnvelope(), v: 2 as never };
    expect(() => encodeEntry(bad)).toThrow(OpLogEntryCorrupt);
  });

  it('rejects synthetic legacy envelope (v=0) — never persisted', () => {
    const bad = { ...sampleEnvelope(), v: OPLOG_ENTRY_LEGACY_VERSION as never };
    expect(() => encodeEntry(bad)).toThrow(OpLogEntryCorrupt);
  });

  it('rejects ts=0', () => {
    const bad = { ...sampleEnvelope(), ts: 0 };
    expect(() => encodeEntry(bad)).toThrow(OpLogEntryCorrupt);
  });

  it('rejects ts below MIN_PLAUSIBLE_TS', () => {
    const bad = { ...sampleEnvelope(), ts: 123 };
    expect(() => encodeEntry(bad)).toThrow(OpLogEntryCorrupt);
  });

  it('rejects payload not Uint8Array', () => {
    const bad = { ...sampleEnvelope(), payload: 'wrong type' as never };
    expect(() => encodeEntry(bad)).toThrow(OpLogEntryCorrupt);
  });

  it('rejects payload exceeding MAX_PAYLOAD_BYTES', () => {
    const bad = {
      ...sampleEnvelope(),
      payload: new Uint8Array(MAX_PAYLOAD_BYTES + 1),
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
    expect(entry.ts).toBeGreaterThanOrEqual(Date.now() - 1000);
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

  it('accepts caller-supplied ts >= MIN_PLAUSIBLE_TS', () => {
    const entry = buildLocalEntry({
      type: 'token_send',
      originated: 'user',
      payload: PAYLOAD,
      ts: TS,
    });
    expect(entry.ts).toBe(TS);
  });
});

// ── decodeAndDowngradeReplicated ──────────────────────────────────────────

describe('decodeAndDowngradeReplicated (§5.2)', () => {
  it('overrides peer-claimed originated=user → replicated', () => {
    const peerEnvelope: OpLogEntryEnvelope = {
      v: OPLOG_ENTRY_SCHEMA_VERSION,
      type: 'token_send',
      originated: 'user', // peer's forgery attempt
      ts: TS,
      payload: PAYLOAD,
    };
    const downgraded = decodeAndDowngradeReplicated(encodeEntry(peerEnvelope));
    expect(downgraded.originated).toBe('replicated');
    expect(downgraded.type).toBe('token_send');
    expect(downgraded.ts).toBe(TS);
  });

  it('overrides peer-claimed system → replicated', () => {
    const peerEnvelope: OpLogEntryEnvelope = {
      v: OPLOG_ENTRY_SCHEMA_VERSION,
      type: 'cache_index',
      originated: 'system',
      ts: TS,
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
      ts: TS,
      payload: PAYLOAD,
    };
    const downgraded = decodeAndDowngradeReplicated(encodeEntry(replicatedEnvelope));
    expect(downgraded.originated).toBe('replicated');
  });

  it('REJECTS legacy-shaped bytes at replication ingress', () => {
    // A peer should never be able to deliver pre-schema bytes — the legacy
    // shape is strictly a LOCAL read-time synthesis.
    const legacyCbor = cborEncode(new Uint8Array([0xde, 0xad]));
    expect(() => decodeAndDowngradeReplicated(legacyCbor)).toThrow(OpLogEntryCorrupt);
  });

  it('throws on CBOR-malformed bytes at decode step', () => {
    const notCbor = new Uint8Array([0xff, 0xfe, 0xfd]);
    expect(() => decodeAndDowngradeReplicated(notCbor)).toThrow(OpLogEntryCorrupt);
  });
});

// ── Defensive payload copy (no aliasing) ──────────────────────────────────

describe('payload defensive copy', () => {
  it('decodeEntry returns payload independent of decoder buffer', () => {
    const entry = sampleEnvelope();
    const bytes = encodeEntry(entry);
    const decoded = decodeEntry(bytes);
    // Mutate the decoded payload.
    decoded.payload[0] = 0xff;
    // Re-decode from the same input bytes — should NOT reflect the mutation.
    const decoded2 = decodeEntry(bytes);
    expect(decoded2.payload[0]).not.toBe(0xff);
  });

  it('encodeEntry output is independent of input payload aliasing', () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const entry = { ...sampleEnvelope(), payload };
    const bytes1 = encodeEntry(entry);
    // Mutate the source payload AFTER encode.
    payload[0] = 0xff;
    const decoded = decodeEntry(bytes1);
    // Encoded bytes were already serialized — decode reflects the
    // pre-mutation value (or, at worst, is consistent under both encodes).
    expect(decoded.payload[0]).toBe(1);
  });
});
