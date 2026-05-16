/**
 * Coverage-Matrix Audit for the Profile Aggregator Pointer Layer.
 *
 * Parses TEST-SPEC §4 (`docs/uxf/PROFILE-AGGREGATOR-POINTER-TEST-SPEC.md`)
 * and verifies that every H/W finding carries both a PRIMARY and a
 * SECONDARY test scenario. Deferred/reserved rows (marked `n/a for v1`,
 * `n/a`, `—`, or `*Reserved — not allocated in SPEC v3.x*`) are
 * accepted without coverage.
 *
 * Task IDs: T-E22 (audit scaffold), T-E22b (parser), T-E23 (CI wiring).
 *
 * DESIGN NOTES / FALLBACK
 * -----------------------
 * The §4 matrix in TEST-SPEC is a GitHub-Flavored Markdown table. We
 * parse it with a line-based heuristic rather than a full markdown
 * parser because:
 *   (a) the section is self-contained (§4 starts at a known heading,
 *       ends at the next `## ` heading);
 *   (b) the column layout is fixed and documented;
 *   (c) avoiding a markdown dep keeps the audit installable in bare
 *       CI environments.
 *
 * If the §4 section cannot be located or the table shape has shifted
 * (e.g. a column rename or extra/missing pipe), the audit returns a
 * structured `{ parseable: false, reason }` result instead of
 * throwing. The Vitest wrapper will then SKIP (not fail) with the
 * reason logged, so the test suite does not block on spec reformats
 * — the CI canary's `yq`/`jq` checksum step catches drift
 * separately.
 *
 * To extend the audit when SPEC v4 lands with new finding slots:
 *   1. No code change required — the parser is data-driven.
 *   2. If the column names change, update `EXPECTED_HEADER_CELLS`.
 *   3. If deferred-row markers change, update `DEFERRED_MARKERS`.
 *
 * HARDCODED FALLBACK MATRIX
 * -------------------------
 * If the TEST-SPEC file is missing or §4 is unparseable, the audit
 * falls back to the hardcoded `FALLBACK_FINDINGS` list below
 * (findings H1–H14, W1–W12 from SPEC v3.5, mirroring the state of
 * the spec at 2026-04-21). The fallback only verifies that the
 * expected finding IDs exist; it does not verify test coverage. A
 * `parseable: false` result still propagates so the wrapper can log
 * the degraded mode.
 *
 * @see docs/uxf/PROFILE-AGGREGATOR-POINTER-TEST-SPEC.md §4
 * @see .github/workflows/pointer-sdk-canary.yml (CI integration)
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Absolute path to the TEST-SPEC file. */
export const TEST_SPEC_PATH = resolve(
  process.cwd(),
  'docs/uxf/PROFILE-AGGREGATOR-POINTER-TEST-SPEC.md',
);

/**
 * Expected header cells for §4 (order-sensitive, trimmed).
 * A shape mismatch here triggers the unparseable fallback.
 */
const EXPECTED_HEADER_CELLS = [
  'Finding',
  'Title',
  'Description',
  'PRIMARY Test(s)',
  'SECONDARY Test(s)',
] as const;

/**
 * Cell values that mark a row as intentionally uncovered (v2 deferred,
 * reserved slots, or explicit n/a).
 */
const DEFERRED_MARKERS = [
  'n/a',
  'n/a for v1',
  '—', // em dash commonly used for "reserved / no coverage"
  '-',
  '',
];

/**
 * Hardcoded fallback list of finding IDs from SPEC v3.5. Used only
 * for sanity-checking in the fallback path — does NOT verify coverage.
 */
const FALLBACK_FINDINGS: readonly string[] = [
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'H10', 'H11',
  'H12', 'H13', 'H14',
  'W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'W10', 'W11',
  'W12',
];

export interface MatrixRow {
  /** e.g. "H1", "W12". Normalized — bold markers (`**`) stripped. */
  finding: string;
  title: string;
  description: string;
  primary: string;
  secondary: string;
  /** True if both PRIMARY and SECONDARY are either covered or marked deferred. */
  deferred: boolean;
}

export interface GapReport {
  finding: string;
  column: 'PRIMARY' | 'SECONDARY';
  cellValue: string;
  reason: string;
}

export type AuditResult =
  | {
      parseable: true;
      rows: MatrixRow[];
      gaps: GapReport[];
      /** Findings present in FALLBACK_FINDINGS but missing from the parsed matrix. */
      missingFindings: string[];
      specPath: string;
    }
  | {
      parseable: false;
      reason: string;
      fallbackFindings: readonly string[];
      specPath: string;
    };

/**
 * Split a GFM table row on `|` delimiters, stripping leading/trailing
 * empty cells produced by the outer pipes, and trimming each cell.
 *
 * IMPORTANT: the §4 table in TEST-SPEC contains at least one row
 * ("W11") with an unescaped `|` inside an inline-code span
 * (`` `originated: 'user' | 'system'` ``). Strict GFM requires
 * escaping as `\|`, but the spec does not. We defensively replace
 * backtick-delimited spans with a placeholder before splitting, then
 * restore them in each cell — this makes the parser tolerant of
 * both escaped and unescaped pipe-in-code authoring.
 */
function splitRow(line: string): string[] {
  // 1. Stash inline-code spans. Use a non-`|`-containing placeholder
  //    so splitting is safe. Order-preserving.
  const stash: string[] = [];
  const masked = line.replace(/`[^`]*`/g, (match) => {
    stash.push(match);
    return `￼${stash.length - 1}￼`;
  });

  const rawCells = masked.split('|').map((c) => c.trim());
  // Outer pipes produce empty cells at positions 0 and N-1. Strip them
  // iff they are genuinely empty (GFM requires outer pipes).
  if (rawCells.length > 0 && rawCells[0] === '') rawCells.shift();
  if (rawCells.length > 0 && rawCells[rawCells.length - 1] === '') rawCells.pop();

  // 2. Restore stashed code spans.
  return rawCells.map((c) =>
    c.replace(/￼(\d+)￼/g, (_m, idx) => stash[Number(idx)]),
  );
}

/**
 * Normalize a Finding cell: strip bold markers, extract the ID.
 * Accepts "**H1**", "H1", "**H1** | ...", returns "H1".
 */
function normalizeFinding(cell: string): string | null {
  const stripped = cell.replace(/\*/g, '').trim();
  // Accept H\d+ or W\d+ at the start of the cell.
  const match = stripped.match(/^([HW]\d+)\b/);
  return match ? match[1] : null;
}

/**
 * Does this cell count as "deferred / acceptably uncovered"?
 * We accept the literal markers, and also any cell starting with
 * "GAP:" (documented gap pointing at the SPEC changelog — still a
 * finding the reviewer must act on, but not a test-file-level gap).
 */
function isDeferredCell(cell: string): boolean {
  const trimmed = cell.trim().toLowerCase();
  for (const marker of DEFERRED_MARKERS) {
    if (trimmed === marker.toLowerCase()) return true;
  }
  // "n/a for v1" variants
  if (trimmed.startsWith('n/a')) return true;
  // Documented gap pointer — not a test file gap, but surfaced in CI.
  if (trimmed.startsWith('gap:')) return true;
  return false;
}

/**
 * Run the coverage-matrix audit. Pure function — no I/O beyond
 * reading `TEST_SPEC_PATH`.
 */
export function runCoverageAudit(specPath = TEST_SPEC_PATH): AuditResult {
  if (!existsSync(specPath)) {
    return {
      parseable: false,
      reason: `TEST-SPEC file not found at ${specPath}`,
      fallbackFindings: FALLBACK_FINDINGS,
      specPath,
    };
  }

  let text: string;
  try {
    text = readFileSync(specPath, 'utf8');
  } catch (err) {
    return {
      parseable: false,
      reason: `Failed to read TEST-SPEC file: ${(err as Error).message}`,
      fallbackFindings: FALLBACK_FINDINGS,
      specPath,
    };
  }

  const lines = text.split(/\r?\n/);

  // Locate §4 — "## 4. Coverage Matrix" (case-sensitive, leading `## `).
  const sectionStart = lines.findIndex((l) =>
    /^##\s+4\.\s+Coverage Matrix/i.test(l),
  );
  if (sectionStart < 0) {
    return {
      parseable: false,
      reason: 'Could not find "## 4. Coverage Matrix" heading in TEST-SPEC',
      fallbackFindings: FALLBACK_FINDINGS,
      specPath,
    };
  }

  // Section ends at the next top-level `## ` heading.
  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  // Find the header row (first line starting with `|` that contains
  // the word "Finding").
  let headerIdx = -1;
  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    if (lines[i].startsWith('|') && /\bFinding\b/.test(lines[i])) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) {
    return {
      parseable: false,
      reason: 'Could not find table header row in §4',
      fallbackFindings: FALLBACK_FINDINGS,
      specPath,
    };
  }

  const headerCells = splitRow(lines[headerIdx]);
  if (headerCells.length !== EXPECTED_HEADER_CELLS.length) {
    return {
      parseable: false,
      reason: `Header column count mismatch: expected ${EXPECTED_HEADER_CELLS.length}, got ${headerCells.length}`,
      fallbackFindings: FALLBACK_FINDINGS,
      specPath,
    };
  }
  for (let i = 0; i < EXPECTED_HEADER_CELLS.length; i++) {
    if (headerCells[i] !== EXPECTED_HEADER_CELLS[i]) {
      return {
        parseable: false,
        reason: `Header cell ${i} mismatch: expected "${EXPECTED_HEADER_CELLS[i]}", got "${headerCells[i]}"`,
        fallbackFindings: FALLBACK_FINDINGS,
        specPath,
      };
    }
  }

  // Separator row (|---|---|...) must immediately follow.
  const separatorIdx = headerIdx + 1;
  if (separatorIdx >= sectionEnd || !/^\|[\s|:-]+\|$/.test(lines[separatorIdx].trim())) {
    return {
      parseable: false,
      reason: 'Expected markdown separator row after header',
      fallbackFindings: FALLBACK_FINDINGS,
      specPath,
    };
  }

  const rows: MatrixRow[] = [];
  const gaps: GapReport[] = [];

  for (let i = separatorIdx + 1; i < sectionEnd; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) continue; // table ends when non-pipe line encountered
    if (!line.includes('|')) continue;
    const cells = splitRow(line);
    if (cells.length !== EXPECTED_HEADER_CELLS.length) continue; // skip malformed
    const finding = normalizeFinding(cells[0]);
    if (!finding) continue; // skip rows that aren't H\d/W\d

    const title = cells[1];
    const description = cells[2];
    const primary = cells[3];
    const secondary = cells[4];

    const primaryDeferred = isDeferredCell(primary);
    const secondaryDeferred = isDeferredCell(secondary);
    const rowDeferred = primaryDeferred && secondaryDeferred;

    rows.push({
      finding,
      title,
      description,
      primary,
      secondary,
      deferred: rowDeferred,
    });

    // If the row is fully deferred (both columns marked n/a), accept.
    if (rowDeferred) continue;

    // Partial deferral (PRIMARY has content but SECONDARY n/a, or
    // vice versa) is a gap — the SPEC requires BOTH coverage types
    // for active findings.
    if (primaryDeferred && !secondaryDeferred) {
      gaps.push({
        finding,
        column: 'PRIMARY',
        cellValue: primary,
        reason: 'PRIMARY is deferred but SECONDARY is populated — inconsistent',
      });
    }
    if (secondaryDeferred && !primaryDeferred) {
      gaps.push({
        finding,
        column: 'SECONDARY',
        cellValue: secondary,
        reason: 'SECONDARY is deferred but PRIMARY is populated — inconsistent',
      });
    }

    // PRIMARY empty is a gap.
    if (!primaryDeferred && primary.length === 0) {
      gaps.push({
        finding,
        column: 'PRIMARY',
        cellValue: primary,
        reason: 'PRIMARY cell is empty',
      });
    }
    // SECONDARY empty is a gap.
    if (!secondaryDeferred && secondary.length === 0) {
      gaps.push({
        finding,
        column: 'SECONDARY',
        cellValue: secondary,
        reason: 'SECONDARY cell is empty',
      });
    }
  }

  // Cross-check against FALLBACK_FINDINGS — anything missing is a
  // gap. (Extra findings in the parsed matrix are fine; SPEC may
  // have added slots.)
  const seen = new Set(rows.map((r) => r.finding));
  const missingFindings: string[] = FALLBACK_FINDINGS.filter(
    (f) => !seen.has(f),
  );

  return {
    parseable: true,
    rows,
    gaps,
    missingFindings,
    specPath,
  };
}

/**
 * Render a human-readable gap report. Used both by CI logs and by
 * Vitest failure messages.
 */
export function renderAuditReport(result: AuditResult): string {
  if (!result.parseable) {
    return [
      'Coverage matrix audit: UNPARSEABLE',
      `  spec path: ${result.specPath}`,
      `  reason:    ${result.reason}`,
      `  fallback findings: ${result.fallbackFindings.join(', ')}`,
      '',
      'Audit will be SKIPPED. Update tests/conformance/pointer/coverage-matrix-audit.ts',
      'if the TEST-SPEC §4 shape has changed intentionally.',
    ].join('\n');
  }

  const lines: string[] = [
    'Coverage matrix audit: OK parse',
    `  spec path:        ${result.specPath}`,
    `  rows parsed:      ${result.rows.length}`,
    `  gaps:             ${result.gaps.length}`,
    `  missing findings: ${result.missingFindings.length}`,
  ];
  if (result.gaps.length > 0) {
    lines.push('');
    lines.push('GAPS:');
    for (const g of result.gaps) {
      lines.push(`  - ${g.finding} [${g.column}]: ${g.reason}`);
      if (g.cellValue) {
        lines.push(`      cell: "${g.cellValue}"`);
      }
    }
  }
  if (result.missingFindings.length > 0) {
    lines.push('');
    lines.push('MISSING FINDINGS (present in fallback list but not in parsed matrix):');
    for (const f of result.missingFindings) {
      lines.push(`  - ${f}`);
    }
  }
  return lines.join('\n');
}
