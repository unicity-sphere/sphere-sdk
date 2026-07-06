/**
 * Category-K conformance tests — W11 originated-tag discipline (SPEC §10.2.3).
 *
 * Scope (K1–K10): complement, not duplicate,
 *   tests/unit/profile/pointer/originated-tag.test.ts (the broader K1–K12 fan-out).
 *
 * This file exercises the aggregator-pointer `originated-tag` layer and the
 * `oplog-entry` local-entry constructor together, with emphasis on:
 *   - surfacing the FULL enum once (ALL_ENTRY_TYPES is the source of truth)
 *   - the (type, originated) coherence check at the local write site
 *   - the downgrade helper's preservation + fail-closed semantics
 *   - unknown / out-of-enum entry type rejection
 *
 * All thrown errors are matched via AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH
 * (per SPEC §12 taxonomy) using `expect.objectContaining`.
 */

import { describe, it, expect } from 'vitest';

import {
  stampOriginated,
  assertOriginTagLocal,
  assertOriginTagReplicated,
  downgradeForReplication,
  ALL_ENTRY_TYPES,
  AggregatorPointerErrorCode,
} from '../../../extensions/uxf/profile/aggregator-pointer/index.js';
import type {
  OpLogEntryType,
  UserActionType,
  SystemActionType,
} from '../../../extensions/uxf/profile/aggregator-pointer/originated-tag.js';
import { buildLocalEntry } from '../../../extensions/uxf/profile/oplog-entry.js';

// ── Enum fixtures (mirror of originated-tag.ts, re-declared here on purpose:
//    if upstream drift changes the enum, K1 fails loudly.) ───────────────────
const USER_TYPES: readonly UserActionType[] = [
  'token_send',
  'token_receive',
  'nametag_register',
  'dm_send',
  'dm_receive',
  'invoice_mint',
  'invoice_pay',
  'invoice_close',
  'invoice_cancel',
  'swap_propose',
  'swap_accept',
  'swap_deposit',
] as const;

const SYSTEM_TYPES: readonly SystemActionType[] = [
  'session_receipt',
  'cache_index',
  'last_opened_ts',
] as const;

/**
 * Full 64-char hex helper — mirrors tests/unit/uxf/token-join.test.ts `hexTag`.
 * Produces deterministic payload bytes in the expected shape.
 */
function hexTag(tag: string): string {
  let out = '';
  for (const ch of tag) {
    out += ch.charCodeAt(0).toString(16).padStart(4, '0');
  }
  if (out.length >= 64) return out.slice(0, 64);
  return out + '0'.repeat(64 - out.length);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Deterministic non-empty Uint8Array payload for envelope construction. */
function payloadFor(tag: string): Uint8Array {
  return hexToBytes(hexTag(tag));
}

const ORIGIN_MISMATCH = expect.objectContaining({
  code: AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH,
});

// ───────────────────────────────────────────────────────────────────────────
// K1: every one of the 15 OpLogEntryType values is covered by at least one
//     assertion via ALL_ENTRY_TYPES, and the user-vs-system partition is
//     accurate. (The spec text says "12" — that's the user-action subset;
//     the full enum has 15 = 12 user + 3 system. We surface both.)
// ───────────────────────────────────────────────────────────────────────────
describe('K1: ALL_ENTRY_TYPES surfaces the full enum', () => {
  it('exposes all 12 user-action types plus 3 system types (= 15 total)', () => {
    // Each fixture is covered by the enum in exactly one role.
    for (const t of USER_TYPES) {
      expect(ALL_ENTRY_TYPES).toContain(t);
    }
    for (const t of SYSTEM_TYPES) {
      expect(ALL_ENTRY_TYPES).toContain(t);
    }
    // Cardinality lock: enum size = union size, no duplicates across partitions.
    expect(new Set<string>([...USER_TYPES, ...SYSTEM_TYPES]).size).toBe(
      USER_TYPES.length + SYSTEM_TYPES.length,
    );
    expect(ALL_ENTRY_TYPES.length).toBe(USER_TYPES.length + SYSTEM_TYPES.length);
  });

  it('every entry type is reachable via the replicated validator (full-surface assertion)', () => {
    // One concrete assertion per enum member proves the enum is covered.
    for (const t of ALL_ENTRY_TYPES) {
      expect(() => assertOriginTagReplicated(t, 'replicated')).not.toThrow();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// K2: stampOriginated rejects double-stamping.
// ───────────────────────────────────────────────────────────────────────────
describe('K2: stampOriginated double-stamp guard', () => {
  it('rejects an entry that already carries originated="user"', () => {
    const already = { type: 'token_send', originated: 'user' as const };
    expect(() => stampOriginated(already, 'user')).toThrow(ORIGIN_MISMATCH);
  });

  it('rejects an entry that already carries originated="system"', () => {
    const already = { type: 'cache_index', originated: 'system' as const };
    expect(() => stampOriginated(already, 'system')).toThrow(ORIGIN_MISMATCH);
  });

  it('rejects even when attempting to overwrite with a DIFFERENT tag', () => {
    // Particularly important: cannot silently re-classify a 'user' entry as
    // 'system' or 'replicated' by re-stamping. Must throw.
    const already = { type: 'dm_send', originated: 'user' as const };
    expect(() =>
      stampOriginated(already as unknown as Record<string, unknown>, 'replicated'),
    ).toThrow(ORIGIN_MISMATCH);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// K3: assertOriginTagLocal rejects 'replicated' at the local write site.
// ───────────────────────────────────────────────────────────────────────────
describe('K3: assertOriginTagLocal rejects originated="replicated"', () => {
  it('user-action types with "replicated" fail locally', () => {
    for (const t of USER_TYPES) {
      expect(() => assertOriginTagLocal(t, 'replicated')).toThrow(ORIGIN_MISMATCH);
    }
  });

  it('system types with "replicated" fail locally', () => {
    for (const t of SYSTEM_TYPES) {
      expect(() => assertOriginTagLocal(t, 'replicated')).toThrow(ORIGIN_MISMATCH);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// K4: assertOriginTagLocal rejects user-action type paired with 'system'.
// ───────────────────────────────────────────────────────────────────────────
describe('K4: user-action type + originated="system" is a mismatch', () => {
  it('each of the 12 user-action types rejects "system"', () => {
    for (const t of USER_TYPES) {
      expect(() => assertOriginTagLocal(t, 'system')).toThrow(ORIGIN_MISMATCH);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// K5: assertOriginTagLocal rejects system-action type paired with 'user'.
// ───────────────────────────────────────────────────────────────────────────
describe('K5: system-action type + originated="user" is a mismatch', () => {
  it('each of the 3 system-action types rejects "user"', () => {
    for (const t of SYSTEM_TYPES) {
      expect(() => assertOriginTagLocal(t, 'user')).toThrow(ORIGIN_MISMATCH);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// K6: assertOriginTagReplicated requires 'replicated'; accepts any entry type
//     (from the known enum).
// ───────────────────────────────────────────────────────────────────────────
describe('K6: assertOriginTagReplicated accepts "replicated" for every enum type', () => {
  it('passes for every user-action type with originated="replicated"', () => {
    for (const t of USER_TYPES) {
      expect(() => assertOriginTagReplicated(t, 'replicated')).not.toThrow();
    }
  });

  it('passes for every system-action type with originated="replicated"', () => {
    for (const t of SYSTEM_TYPES) {
      expect(() => assertOriginTagReplicated(t, 'replicated')).not.toThrow();
    }
  });

  it('still rejects non-"replicated" tags across the full enum', () => {
    // Cross-check: the replicated validator must not be lenient.
    for (const t of ALL_ENTRY_TYPES) {
      expect(() => assertOriginTagReplicated(t, 'user')).toThrow(ORIGIN_MISMATCH);
      expect(() => assertOriginTagReplicated(t, 'system')).toThrow(ORIGIN_MISMATCH);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// K7: downgradeForReplication preserves type (and other payload fields)
//     while forcing originated='replicated'.
// ───────────────────────────────────────────────────────────────────────────
describe('K7: downgradeForReplication preserves type, forces originated="replicated"', () => {
  it('user-action entry keeps type; originated flips "user" -> "replicated"', () => {
    const entry = {
      type: 'invoice_mint' as const,
      originated: 'user' as const,
      invoiceId: hexTag('inv-1'),
      amount: '1000000',
    };
    const down = downgradeForReplication(entry);
    expect(down.type).toBe('invoice_mint');
    expect(down.originated).toBe('replicated');
    // Sibling fields must survive the downgrade.
    expect(down.invoiceId).toBe(hexTag('inv-1'));
    expect(down.amount).toBe('1000000');
  });

  it('system-action entry keeps type; originated flips "system" -> "replicated"', () => {
    const entry = {
      type: 'cache_index' as const,
      originated: 'system' as const,
      index: 42,
    };
    const down = downgradeForReplication(entry);
    expect(down.type).toBe('cache_index');
    expect(down.originated).toBe('replicated');
    expect(down.index).toBe(42);
  });

  it('input object is not mutated (immutability)', () => {
    const entry = { type: 'token_send', originated: 'user' as const, memo: 'x' };
    downgradeForReplication(entry);
    expect(entry.originated).toBe('user');
  });

  it('already-"replicated" entry stays "replicated" (idempotent downgrade)', () => {
    // The downgrade is an overwrite, not a state-machine transition. A
    // re-run at the replication edge should be a no-op on `originated`.
    const entry = { type: 'swap_accept', originated: 'replicated' as const };
    const down = downgradeForReplication(entry);
    expect(down.originated).toBe('replicated');
    expect(down.type).toBe('swap_accept');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// K8: downgradeForReplication throws SECURITY_ORIGIN_MISMATCH on an entry
//     without any originated field.
// ───────────────────────────────────────────────────────────────────────────
describe('K8: downgradeForReplication fails-closed on missing originated', () => {
  it('rejects entry with no "originated" property at all', () => {
    const entry = { type: 'token_send', amount: '100' };
    expect(() =>
      downgradeForReplication(entry as unknown as Record<string, unknown>),
    ).toThrow(ORIGIN_MISMATCH);
  });

  it('rejects entry with originated === undefined', () => {
    const entry = { type: 'token_send', originated: undefined };
    expect(() =>
      downgradeForReplication(entry as unknown as Record<string, unknown>),
    ).toThrow(ORIGIN_MISMATCH);
  });

  it('rejects entry with originated === null (protocol violation at replication edge)', () => {
    const entry = { type: 'dm_receive', originated: null };
    expect(() =>
      downgradeForReplication(entry as unknown as Record<string, unknown>),
    ).toThrow(ORIGIN_MISMATCH);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// K9: buildLocalEntry → assertOriginTagLocal round-trip for each
//     user-action / system-action type.
// ───────────────────────────────────────────────────────────────────────────
describe('K9: buildLocalEntry + assertOriginTagLocal round-trip', () => {
  // Timestamp must be >= MIN_PLAUSIBLE_TS (2020-01-01) — `buildLocalEntry`
  // itself does not enforce this (only `encodeEntry` does via
  // `validateEnvelopeShape`), but using a realistic ts keeps fixtures
  // identical to downstream encode-path tests.
  const ts = 1_700_000_000_000; // 2023-11-14, well above the MIN_PLAUSIBLE_TS floor

  for (const type of USER_TYPES) {
    it(`user-action ${type} round-trips with originated="user"`, () => {
      const env = buildLocalEntry({
        type,
        originated: 'user',
        payload: payloadFor(`p-${type}`),
        ts,
      });
      expect(env.type).toBe(type);
      expect(env.originated).toBe('user');
      expect(env.ts).toBe(ts);
      expect(env.payload.byteLength).toBe(32);
      // Round-trip: the envelope shape must itself satisfy the local validator.
      expect(() => assertOriginTagLocal(env.type, env.originated)).not.toThrow();
    });
  }

  for (const type of SYSTEM_TYPES) {
    it(`system-action ${type} round-trips with originated="system"`, () => {
      const env = buildLocalEntry({
        type,
        originated: 'system',
        payload: payloadFor(`p-${type}`),
        ts,
      });
      expect(env.type).toBe(type);
      expect(env.originated).toBe('system');
      expect(env.ts).toBe(ts);
      expect(() => assertOriginTagLocal(env.type, env.originated)).not.toThrow();
    });
  }

  it('buildLocalEntry REJECTS a coherence violation (user-action + originated="system")', () => {
    // buildLocalEntry calls assertOriginTagLocal internally — this must surface
    // SECURITY_ORIGIN_MISMATCH and never materialise a malformed envelope.
    expect(() =>
      buildLocalEntry({
        type: 'token_send' as OpLogEntryType,
        // Cast: the external type narrows to 'user'|'system', but we exercise
        // the runtime guard here deliberately.
        originated: 'system' as 'user' | 'system',
        payload: payloadFor('bad'),
        ts,
      }),
    ).toThrow(ORIGIN_MISMATCH);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// K10: unknown entry type (not in the frozen ALL_ENTRY_TYPES list) is
//      rejected by BOTH local and replicated validators.
// ───────────────────────────────────────────────────────────────────────────
describe('K10: unknown entry types are rejected', () => {
  const UNKNOWN_TYPES: readonly string[] = [
    'totally_made_up',
    '', // empty string is not in the enum
    'TOKEN_SEND', // case-sensitive: upper-case variant is not in the enum
    'token_send ', // trailing space
    ' token_send', // leading space
    'swap', // truncated prefix of a real value
    '__proto__', // prototype-pollution-adjacent string
  ];

  it('ALL_ENTRY_TYPES is frozen and contains none of the unknown probes', () => {
    expect(Object.isFrozen(ALL_ENTRY_TYPES)).toBe(true);
    for (const probe of UNKNOWN_TYPES) {
      expect(ALL_ENTRY_TYPES).not.toContain(probe as OpLogEntryType);
    }
  });

  it('assertOriginTagLocal rejects unknown types (regardless of origin value)', () => {
    for (const probe of UNKNOWN_TYPES) {
      expect(() => assertOriginTagLocal(probe, 'user')).toThrow(ORIGIN_MISMATCH);
      expect(() => assertOriginTagLocal(probe, 'system')).toThrow(ORIGIN_MISMATCH);
      expect(() => assertOriginTagLocal(probe, 'replicated')).toThrow(ORIGIN_MISMATCH);
    }
  });

  it('assertOriginTagReplicated rejects unknown types (including with "replicated")', () => {
    for (const probe of UNKNOWN_TYPES) {
      expect(() => assertOriginTagReplicated(probe, 'replicated')).toThrow(ORIGIN_MISMATCH);
      expect(() => assertOriginTagReplicated(probe, 'user')).toThrow(ORIGIN_MISMATCH);
      expect(() => assertOriginTagReplicated(probe, 'system')).toThrow(ORIGIN_MISMATCH);
    }
  });
});
