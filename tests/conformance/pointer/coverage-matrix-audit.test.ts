/**
 * Vitest wrapper for the pointer-layer coverage-matrix audit.
 *
 * Task IDs: T-E22 (audit scaffold), T-E22b (parser), T-E23 (CI wiring).
 *
 * Behaviour:
 *   - If TEST-SPEC §4 parses cleanly and all H/W findings have both
 *     PRIMARY and SECONDARY coverage (or are marked deferred), PASS.
 *   - If parse fails, SKIP with the reason logged. This matches the
 *     scope-constraint "passes or SKIPs with documented reason if
 *     TEST-SPEC §4 is unparseable".
 *   - If parse succeeds but gaps exist, FAIL with a full report.
 *
 * @see tests/conformance/pointer/coverage-matrix-audit.ts
 * @see docs/uxf/PROFILE-AGGREGATOR-POINTER-TEST-SPEC.md §4
 */

import { describe, it, expect } from 'vitest';
import {
  runCoverageAudit,
  renderAuditReport,
  type AuditResult,
} from './coverage-matrix-audit.js';

describe('Pointer layer — TEST-SPEC §4 coverage matrix audit (T-E22/E23)', () => {
  const result: AuditResult = runCoverageAudit();
  const report = renderAuditReport(result);

  // Always surface the report — visible on both pass and fail paths.
  // (Vitest prints console output on failure; on pass with --reporter
  // verbose it shows inline.)
  console.log(report);

  it('TEST-SPEC §4 is parseable, or the test skips with a documented reason', () => {
    if (!result.parseable) {
      // Scope-constraint-mandated behaviour: SKIP rather than FAIL
      // when the spec shape has shifted. The CI workflow's checksum
      // step catches silent drift separately.
      console.warn(
        `[coverage-audit] SKIP: ${result.reason}\n` +
          `  (fallback findings: ${result.fallbackFindings.join(', ')})`,
      );
      return; // treated as pass — no assertion failures
    }
    expect(result.parseable).toBe(true);
  });

  it('every H/W finding has PRIMARY + SECONDARY coverage (or is deferred)', () => {
    if (!result.parseable) {
      console.warn('[coverage-audit] SKIP: parse failed — see prior warning');
      return;
    }
    if (result.gaps.length > 0) {
      const msg =
        `Coverage matrix has ${result.gaps.length} gap(s):\n\n${report}`;
      throw new Error(msg);
    }
    expect(result.gaps).toHaveLength(0);
  });

  it('every finding in the fallback list is present in the parsed matrix', () => {
    if (!result.parseable) {
      console.warn('[coverage-audit] SKIP: parse failed — see prior warning');
      return;
    }
    if (result.missingFindings.length > 0) {
      const msg =
        `${result.missingFindings.length} finding(s) from the fallback list ` +
        `are missing from the parsed §4 matrix:\n\n${report}`;
      throw new Error(msg);
    }
    expect(result.missingFindings).toHaveLength(0);
  });

  it('parsed matrix has at least 20 rows (sanity — guards against a truncated parse)', () => {
    if (!result.parseable) return;
    // H1–H14 + W1–W12 = 26 rows. Accept 20+ to avoid over-pinning
    // while still catching catastrophic parse truncation.
    expect(result.rows.length).toBeGreaterThanOrEqual(20);
  });
});
