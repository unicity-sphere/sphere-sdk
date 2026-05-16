/**
 * **ADR snapshot test for DispositionReason enum strings (Note N2 from
 * UXF-TRANSFER-IMPL-PLAN.md).** Failing this test means the on-disk schema
 * for `_invalid` / `_audit` collections changed — write an ADR before
 * updating.
 *
 * Covers:
 *  - Stability snapshot for the exact 14 {@link DispositionReason} strings
 *    (sorted comparison: ordering changes don't break, additions /
 *    deletions / renames do break — intended).
 *  - Stability snapshot for the exact 3 {@link AuditStatus} strings.
 *  - Runtime guards: positive (each valid string), negative (`null`,
 *    `undefined`, empty string, mis-cased variants, foreign strings).
 *  - Compile-time exhaustiveness fixture (`assertNever` over a `switch`
 *    on `DispositionReason`) — proves the union has exactly the 14 cases
 *    and no implicit fall-through.
 *
 * Spec references:
 *  - `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §5.4 — DispositionReason / AuditStatus
 *  - `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §6.1, §8 — usage contexts
 *  - `docs/uxf/PROFILE-ARCHITECTURE.md` §10.11 — ManifestEntry alignment
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  AuditEntry,
  AuditStatus,
  DispositionReason,
  InvalidEntry,
  ManifestEntry,
} from '../../../types/disposition';
import {
  AUDIT_STATUSES,
  DISPOSITION_REASONS,
  isAuditStatus,
  isDispositionReason,
} from '../../../types/disposition';

// =============================================================================
// 1. Stability snapshot — DispositionReason
// =============================================================================

describe('DispositionReason — stability snapshot (Note N2)', () => {
  /**
   * The exact 14 strings from UXF-TRANSFER-PROTOCOL.md §5.4 (round-2
   * spec correction adds `'client-error'` to the original 13). Sorted
   * lexicographically — adding, removing, or renaming any value breaks
   * this test, forcing an ADR + on-disk migration plan before the change
   * can land.
   */
  const EXPECTED_SORTED_REASONS: ReadonlyArray<string> = [
    'auth-invalid',
    'belief-divergence',
    'client-error',
    'continuity-broken',
    'gateway-fetch-failed',
    'not-our-state',
    'off-record-spend',
    'oracle-rejected',
    'parent-rejected',
    'predicate-eval',
    'proof-invalid',
    'proof-throw',
    'race-lost',
    'structural',
  ];

  it('contains exactly 14 values', () => {
    expect(DISPOSITION_REASONS).toHaveLength(14);
  });

  it('matches the canonical sorted snapshot from §5.4', () => {
    const actualSorted: ReadonlyArray<string> = [...DISPOSITION_REASONS].sort();
    expect(actualSorted).toEqual(EXPECTED_SORTED_REASONS);
  });

  it('has no duplicate values', () => {
    const unique = new Set<string>(DISPOSITION_REASONS);
    expect(unique.size).toBe(DISPOSITION_REASONS.length);
  });

  it('every value is a non-empty lowercase-kebab string', () => {
    for (const reason of DISPOSITION_REASONS) {
      expect(reason).toMatch(/^[a-z][a-z-]*[a-z]$/);
    }
  });
});

// =============================================================================
// 2. Stability snapshot — AuditStatus
// =============================================================================

describe('AuditStatus — stability snapshot (Note N6)', () => {
  /**
   * The exact 3 strings from §5.4. Same on-disk migration contract as
   * DispositionReason.
   */
  const EXPECTED_SORTED_STATUSES: ReadonlyArray<string> = [
    'audit-not-our-state',
    'audit-off-record-spend',
    'audit-promoted',
  ];

  it('contains exactly 3 values', () => {
    expect(AUDIT_STATUSES).toHaveLength(3);
  });

  it('matches the canonical sorted snapshot from §5.4', () => {
    const actualSorted: ReadonlyArray<string> = [...AUDIT_STATUSES].sort();
    expect(actualSorted).toEqual(EXPECTED_SORTED_STATUSES);
  });

  it('every value uses the `audit-` prefix (Note N6)', () => {
    for (const status of AUDIT_STATUSES) {
      expect(status.startsWith('audit-')).toBe(true);
    }
  });

  it('has no duplicate values', () => {
    const unique = new Set<string>(AUDIT_STATUSES);
    expect(unique.size).toBe(AUDIT_STATUSES.length);
  });
});

// =============================================================================
// 3. Runtime guard — isDispositionReason
// =============================================================================

describe('isDispositionReason — positive cases', () => {
  it('accepts every value listed in DISPOSITION_REASONS', () => {
    for (const reason of DISPOSITION_REASONS) {
      expect(isDispositionReason(reason)).toBe(true);
    }
  });
});

describe('isDispositionReason — negative cases (paranoid)', () => {
  it('rejects null', () => {
    expect(isDispositionReason(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isDispositionReason(undefined)).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isDispositionReason('')).toBe(false);
  });

  it('rejects upper-case variants', () => {
    expect(isDispositionReason('STRUCTURAL')).toBe(false);
    expect(isDispositionReason('Structural')).toBe(false);
    expect(isDispositionReason('Proof-Invalid')).toBe(false);
  });

  it('rejects strings with leading/trailing whitespace', () => {
    expect(isDispositionReason(' structural')).toBe(false);
    expect(isDispositionReason('structural ')).toBe(false);
    expect(isDispositionReason('\tstructural\n')).toBe(false);
  });

  it('rejects similar-but-foreign strings', () => {
    expect(isDispositionReason('unknown')).toBe(false);
    expect(isDispositionReason('invalid')).toBe(false);
    expect(isDispositionReason('valid')).toBe(false);
    expect(isDispositionReason('audit-promoted')).toBe(false); // an AuditStatus
    expect(isDispositionReason('proof_invalid')).toBe(false); // underscore
  });

  it('rejects non-string types', () => {
    expect(isDispositionReason(0)).toBe(false);
    expect(isDispositionReason(1)).toBe(false);
    expect(isDispositionReason(true)).toBe(false);
    expect(isDispositionReason(false)).toBe(false);
    expect(isDispositionReason([])).toBe(false);
    expect(isDispositionReason(['structural'])).toBe(false);
    expect(isDispositionReason({})).toBe(false);
    expect(isDispositionReason({ reason: 'structural' })).toBe(false);
  });
});

// =============================================================================
// 4. Runtime guard — isAuditStatus
// =============================================================================

describe('isAuditStatus — positive cases', () => {
  it('accepts every value listed in AUDIT_STATUSES', () => {
    for (const status of AUDIT_STATUSES) {
      expect(isAuditStatus(status)).toBe(true);
    }
  });
});

describe('isAuditStatus — negative cases (paranoid)', () => {
  it('rejects null', () => {
    expect(isAuditStatus(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isAuditStatus(undefined)).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isAuditStatus('')).toBe(false);
  });

  it('rejects upper-case variants', () => {
    expect(isAuditStatus('AUDIT-PROMOTED')).toBe(false);
    expect(isAuditStatus('Audit-Promoted')).toBe(false);
  });

  it('rejects DispositionReason values (cross-enum confusion)', () => {
    expect(isAuditStatus('not-our-state')).toBe(false);
    expect(isAuditStatus('off-record-spend')).toBe(false);
    expect(isAuditStatus('structural')).toBe(false);
  });

  it('rejects strings missing the `audit-` prefix', () => {
    expect(isAuditStatus('promoted')).toBe(false);
    expect(isAuditStatus('not-our-state')).toBe(false);
  });

  it('rejects non-string types', () => {
    expect(isAuditStatus(0)).toBe(false);
    expect(isAuditStatus(true)).toBe(false);
    expect(isAuditStatus([])).toBe(false);
    expect(isAuditStatus({})).toBe(false);
    expect(isAuditStatus({ status: 'audit-promoted' })).toBe(false);
  });
});

// =============================================================================
// 5. Compile-time exhaustiveness — DispositionReason
// =============================================================================

describe('DispositionReason — compile-time exhaustiveness', () => {
  /**
   * Switching on every {@link DispositionReason} literal forces the
   * compiler to verify the union has EXACTLY these 14 cases. If a future
   * change adds a new variant without updating this fixture, the
   * `_exhaustive: never` assignment fails to type-check; if a variant is
   * removed without updating this fixture, the corresponding `case` arm
   * type-narrows to `never` (still a compile error). The runtime
   * assertion below is a belt-and-suspenders check against an unreachable
   * default branch.
   */
  function classifyStorageLocation(
    reason: DispositionReason,
  ): '_invalid' | '_audit' | 'transient' {
    switch (reason) {
      case 'structural':
      case 'predicate-eval':
      case 'auth-invalid':
      case 'continuity-broken':
      case 'proof-invalid':
      case 'proof-throw':
      case 'oracle-rejected':
      case 'belief-divergence':
      case 'client-error':
      case 'parent-rejected':
      case 'race-lost':
        return '_invalid';
      case 'not-our-state':
      case 'off-record-spend':
        return '_audit';
      case 'gateway-fetch-failed':
        return 'transient';
      default: {
        const _exhaustive: never = reason;
        return _exhaustive;
      }
    }
  }

  it('every value routes to a known storage location', () => {
    for (const reason of DISPOSITION_REASONS) {
      const location = classifyStorageLocation(reason);
      expect(['_invalid', '_audit', 'transient']).toContain(location);
    }
  });

  it('§5.4 routing table: 11 invalid / 2 audit / 1 transient', () => {
    let invalid = 0;
    let audit = 0;
    let transient = 0;
    for (const reason of DISPOSITION_REASONS) {
      const loc = classifyStorageLocation(reason);
      if (loc === '_invalid') invalid += 1;
      else if (loc === '_audit') audit += 1;
      else transient += 1;
    }
    expect(invalid).toBe(11);
    expect(audit).toBe(2);
    expect(transient).toBe(1);
  });
});

// =============================================================================
// 6. Compile-time exhaustiveness — AuditStatus
// =============================================================================

describe('AuditStatus — compile-time exhaustiveness', () => {
  function describeAudit(status: AuditStatus): string {
    switch (status) {
      case 'audit-not-our-state':
        return 'NOT_OUR_CURRENT_STATE';
      case 'audit-off-record-spend':
        return 'UNSPENDABLE_BY_US';
      case 'audit-promoted':
        return 'promoted to active pool';
      default: {
        const _exhaustive: never = status;
        return _exhaustive;
      }
    }
  }

  it('every value maps to a non-empty description', () => {
    for (const status of AUDIT_STATUSES) {
      expect(describeAudit(status).length).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// 7. Type-shape sanity for record schemas (compile-time only)
// =============================================================================

describe('InvalidEntry / AuditEntry — type-shape sanity', () => {
  it('InvalidEntry accepts a fully-populated record literal', () => {
    const entry: InvalidEntry = {
      tokenId: 'abc123',
      observedTokenContentHash:
        '0000000000000000000000000000000000000000000000000000000000000000' as InvalidEntry['observedTokenContentHash'],
      reason: 'structural',
      observedAt: 1_700_000_000_000,
      bundleCid: 'bafy...',
      senderTransportPubkey: 'a'.repeat(64),
    };
    expect(entry.reason).toBe('structural');
    expectTypeOf(entry.reason).toEqualTypeOf<DispositionReason>();
  });

  it('AuditEntry accepts a record without optional promotion fields', () => {
    const entry: AuditEntry = {
      tokenId: 'abc123',
      observedTokenContentHash:
        '0000000000000000000000000000000000000000000000000000000000000000' as AuditEntry['observedTokenContentHash'],
      auditStatus: 'audit-not-our-state',
      reason: 'not-our-state',
      recordedAt: 1_700_000_000_000,
      bundleCidsObserved: ['bafy1', 'bafy2'],
    };
    expect(entry.auditStatus).toBe('audit-not-our-state');
    expectTypeOf(entry.auditStatus).toEqualTypeOf<AuditStatus>();
    expect(entry.promotedToManifestRef).toBeUndefined();
  });

  it('AuditEntry accepts a promoted record with both optional fields', () => {
    const entry: AuditEntry = {
      tokenId: 'abc123',
      observedTokenContentHash:
        '0000000000000000000000000000000000000000000000000000000000000000' as AuditEntry['observedTokenContentHash'],
      auditStatus: 'audit-promoted',
      reason: 'not-our-state',
      recordedAt: 1_700_000_000_000,
      bundleCidsObserved: ['bafy1'],
      promotedToManifestRef:
        '1111111111111111111111111111111111111111111111111111111111111111' as AuditEntry['observedTokenContentHash'],
      audit_promoted_from: 'addr.audit.tokenA.hashX',
    };
    expect(entry.auditStatus).toBe('audit-promoted');
    expect(entry.promotedToManifestRef).toBeDefined();
  });

  it('ManifestEntry re-export is type-compatible with profile/token-manifest', () => {
    // The alias resolves to the canonical TokenManifestEntry. This is a
    // compile-time check — if the canonical source is augmented (Wave T.1.F
    // / T.5.B), this fixture will pick up the new shape transparently.
    const entry: ManifestEntry = {
      rootHash:
        '2222222222222222222222222222222222222222222222222222222222222222' as ManifestEntry['rootHash'],
      status: 'valid',
    };
    expect(entry.status).toBe('valid');
  });
});
