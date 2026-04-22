/**
 * Originated-tag discipline (T-B6, T-E9) — K1–K12 scenarios.
 *
 * Verifies all 12 enum members, fail-closed, downgrade, SECURITY_ORIGIN_MISMATCH.
 * SPEC §10.2.3, §10.2.3.1.
 */

import { describe, it, expect } from 'vitest';
import {
  stampOriginated,
  assertOriginTag,
  downgradeForReplication,
  ALL_ENTRY_TYPES,
  AggregatorPointerErrorCode,
} from '../../../../profile/aggregator-pointer/index.js';

const USER_TYPES = [
  'token_send',
  'token_receive',
  'nametag_register',
  'dm_send',
  'invoice_mint',
  'invoice_pay',
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
  it('contains exactly 12 entry types', () => {
    expect(ALL_ENTRY_TYPES.length).toBe(12);
  });

  it('contains all 9 user-action types', () => {
    for (const t of USER_TYPES) {
      expect(ALL_ENTRY_TYPES).toContain(t);
    }
  });

  it('contains all 3 system types', () => {
    for (const t of SYSTEM_TYPES) {
      expect(ALL_ENTRY_TYPES).toContain(t);
    }
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
});

describe('assertOriginTag — user-action types (K3–K7)', () => {
  for (const type of USER_TYPES) {
    it(`K3: ${type} with originated='user' passes`, () => {
      expect(() => assertOriginTag(type, 'user')).not.toThrow();
    });

    it(`K4: ${type} with originated='replicated' passes`, () => {
      expect(() => assertOriginTag(type, 'replicated')).not.toThrow();
    });

    it(`K5: ${type} with originated='system' throws SECURITY_ORIGIN_MISMATCH`, () => {
      expect(() => assertOriginTag(type, 'system')).toThrow(
        expect.objectContaining({ code: AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH }),
      );
    });
  }
});

describe('assertOriginTag — system types (K8–K10)', () => {
  for (const type of SYSTEM_TYPES) {
    it(`K8: ${type} with originated='system' passes`, () => {
      expect(() => assertOriginTag(type, 'system')).not.toThrow();
    });

    it(`K9: ${type} with originated='replicated' passes`, () => {
      expect(() => assertOriginTag(type, 'replicated')).not.toThrow();
    });

    it(`K10: ${type} with originated='user' throws SECURITY_ORIGIN_MISMATCH`, () => {
      expect(() => assertOriginTag(type, 'user')).toThrow(
        expect.objectContaining({ code: AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH }),
      );
    });
  }
});

describe('assertOriginTag — fail-closed (K11)', () => {
  it('missing originated (undefined) throws SECURITY_ORIGIN_MISMATCH', () => {
    expect(() => assertOriginTag('token_send', undefined)).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH }),
    );
  });

  it('null originated throws SECURITY_ORIGIN_MISMATCH', () => {
    expect(() => assertOriginTag('token_send', null)).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH }),
    );
  });

  it('empty string originated throws SECURITY_ORIGIN_MISMATCH', () => {
    expect(() => assertOriginTag('cache_index', '')).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH }),
    );
  });

  it('unknown entry type throws SECURITY_ORIGIN_MISMATCH', () => {
    expect(() => assertOriginTag('unknown_action', 'user')).toThrow(
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
});
