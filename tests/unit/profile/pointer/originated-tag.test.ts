/**
 * Originated-tag discipline (T-B6, T-E9) — K1–K12 scenarios.
 *
 * Verifies all 15 enum members, fail-closed, double-stamp guard, downgrade
 * fail-closed, SECURITY_ORIGIN_MISMATCH, and split local/replicated validators.
 * SPEC §10.2.3, §10.2.3.1.
 */

import { describe, it, expect } from 'vitest';
import {
  stampOriginated,
  assertOriginTagLocal,
  assertOriginTagReplicated,
  downgradeForReplication,
  ALL_ENTRY_TYPES,
  AggregatorPointerErrorCode,
} from '../../../../extensions/uxf/profile/aggregator-pointer/index.js';

const USER_TYPES = [
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

const SYSTEM_TYPES = [
  'session_receipt',
  'cache_index',
  'last_opened_ts',
] as const;

describe('ALL_ENTRY_TYPES completeness (K1)', () => {
  it('contains exactly 15 entry types', () => {
    expect(ALL_ENTRY_TYPES.length).toBe(15);
  });

  it('contains all 12 user-action types', () => {
    for (const t of USER_TYPES) {
      expect(ALL_ENTRY_TYPES).toContain(t);
    }
  });

  it('contains all 3 system types', () => {
    for (const t of SYSTEM_TYPES) {
      expect(ALL_ENTRY_TYPES).toContain(t);
    }
  });

  it('is frozen (immutable at runtime)', () => {
    expect(Object.isFrozen(ALL_ENTRY_TYPES)).toBe(true);
  });
});

describe('stampOriginated (K2)', () => {
  it('adds originated field without mutating input', () => {
    const entry = { type: 'token_send', amount: '100' };
    const stamped = stampOriginated(entry, 'user');
    expect(stamped.originated).toBe('user');
    expect(entry).not.toHaveProperty('originated');
  });

  it('stamps system entries correctly', () => {
    const entry = { type: 'cache_index' };
    const stamped = stampOriginated(entry, 'system');
    expect(stamped.originated).toBe('system');
  });

  it('double-stamp guard: throws SECURITY_ORIGIN_MISMATCH if originated already set', () => {
    const entry = { type: 'token_send', originated: 'user' as const };
    expect(() => stampOriginated(entry, 'user')).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH }),
    );
  });

  it('double-stamp guard: throws even when re-stamping with same tag', () => {
    const entry = { type: 'token_send', originated: 'system' as const };
    expect(() => stampOriginated(entry as unknown as Record<string, unknown>, 'system')).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH }),
    );
  });

  it('double-stamp guard: triggered by originated=null (not just undefined)', () => {
    const entry = { type: 'token_send', originated: null };
    expect(() => stampOriginated(entry as unknown as Record<string, unknown>, 'user')).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH }),
    );
  });
});

describe('assertOriginTagLocal — user-action types (K3–K5)', () => {
  for (const type of USER_TYPES) {
    it(`K3: ${type} with originated='user' passes (local)`, () => {
      expect(() => assertOriginTagLocal(type, 'user')).not.toThrow();
    });

    it(`K4: ${type} with originated='replicated' REJECTED by local validator`, () => {
      expect(() => assertOriginTagLocal(type, 'replicated')).toThrow(
        expect.objectContaining({ code: AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH }),
      );
    });

    it(`K5: ${type} with originated='system' throws SECURITY_ORIGIN_MISMATCH`, () => {
      expect(() => assertOriginTagLocal(type, 'system')).toThrow(
        expect.objectContaining({ code: AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH }),
      );
    });
  }
});

describe('assertOriginTagLocal — system types (K8–K10)', () => {
  for (const type of SYSTEM_TYPES) {
    it(`K8: ${type} with originated='system' passes (local)`, () => {
      expect(() => assertOriginTagLocal(type, 'system')).not.toThrow();
    });

    it(`K9: ${type} with originated='replicated' REJECTED by local validator`, () => {
      expect(() => assertOriginTagLocal(type, 'replicated')).toThrow(
        expect.objectContaining({ code: AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH }),
      );
    });

    it(`K10: ${type} with originated='user' throws SECURITY_ORIGIN_MISMATCH`, () => {
      expect(() => assertOriginTagLocal(type, 'user')).toThrow(
        expect.objectContaining({ code: AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH }),
      );
    });
  }
});

describe('assertOriginTagLocal — fail-closed (K11)', () => {
  it('missing originated (undefined) throws SECURITY_ORIGIN_MISMATCH', () => {
    expect(() => assertOriginTagLocal('token_send', undefined)).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH }),
    );
  });

  it('null originated throws SECURITY_ORIGIN_MISMATCH', () => {
    expect(() => assertOriginTagLocal('token_send', null)).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH }),
    );
  });

  it('empty string originated throws SECURITY_ORIGIN_MISMATCH', () => {
    expect(() => assertOriginTagLocal('cache_index', '')).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH }),
    );
  });

  it('unknown entry type throws SECURITY_ORIGIN_MISMATCH', () => {
    expect(() => assertOriginTagLocal('unknown_action', 'user')).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH }),
    );
  });
});

describe('assertOriginTagReplicated — all types (K4b)', () => {
  for (const type of [...USER_TYPES, ...SYSTEM_TYPES]) {
    it(`${type} with originated='replicated' passes (replication validator)`, () => {
      expect(() => assertOriginTagReplicated(type, 'replicated')).not.toThrow();
    });

    it(`${type} with originated='user' REJECTED by replication validator`, () => {
      expect(() => assertOriginTagReplicated(type, 'user')).toThrow(
        expect.objectContaining({ code: AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH }),
      );
    });

    it(`${type} with originated='system' REJECTED by replication validator`, () => {
      expect(() => assertOriginTagReplicated(type, 'system')).toThrow(
        expect.objectContaining({ code: AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH }),
      );
    });
  }

  it('missing originated throws SECURITY_ORIGIN_MISMATCH', () => {
    expect(() => assertOriginTagReplicated('token_send', undefined)).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH }),
    );
  });

  it('unknown entry type throws SECURITY_ORIGIN_MISMATCH', () => {
    expect(() => assertOriginTagReplicated('unknown_action', 'replicated')).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH }),
    );
  });
});

describe('downgradeForReplication (K12)', () => {
  it('downgrades originated=user to replicated', () => {
    const entry = { type: 'token_send', originated: 'user' as const, amount: '100' };
    const downgraded = downgradeForReplication(entry);
    expect(downgraded.originated).toBe('replicated');
  });

  it('downgrade does not mutate the original', () => {
    const entry = { type: 'token_send', originated: 'user' as const };
    downgradeForReplication(entry);
    expect(entry.originated).toBe('user');
  });

  it('preserves all other fields', () => {
    const entry = { type: 'invoice_mint', originated: 'user' as const, invoiceId: 'inv-1' };
    const d = downgradeForReplication(entry);
    expect(d.type).toBe('invoice_mint');
    expect(d.invoiceId).toBe('inv-1');
    expect(d.originated).toBe('replicated');
  });

  it('fail-closed: throws SECURITY_ORIGIN_MISMATCH when originated is absent', () => {
    const entry = { type: 'token_send', amount: '100' };
    expect(() => downgradeForReplication(entry as unknown as Record<string, unknown>)).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH }),
    );
  });

  it('fail-closed: throws when originated is undefined explicitly', () => {
    const entry = { type: 'token_send', originated: undefined };
    expect(() => downgradeForReplication(entry as unknown as Record<string, unknown>)).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH }),
    );
  });

  it('fail-closed: throws when originated is null (not just undefined)', () => {
    const entry = { type: 'token_send', originated: null };
    expect(() => downgradeForReplication(entry as unknown as Record<string, unknown>)).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH }),
    );
  });
});
