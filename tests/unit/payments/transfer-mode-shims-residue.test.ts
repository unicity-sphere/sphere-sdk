/**
 * Transfer Mode shims — residue audit (T.1.B.2).
 *
 * After T.1.B.2 trims the transfer-mode shim file down to its
 * INTERNAL-only narrowings, this test asserts two invariants that future
 * reviewers can rely on:
 *
 *  1. **Surface lock-in.** The set of exported symbols is exactly the
 *     residual set documented in the shim file header. If a future
 *     commit re-introduces a removed shim (or removes a residual one),
 *     this test fails loudly.
 *  2. **Documented justification.** Every residual export carries a
 *     TSDoc comment containing the literal sequence `reason: "..."` so
 *     a reviewer skim-reading the file can immediately see why the
 *     symbol was kept. The convention mirrors the file-level removal
 *     schedule and prevents silent bit-rot of the residual surface.
 *
 * Spec references: Plan §T.1.B.2 acceptance criteria.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as shims from '../../../extensions/uxf/pipeline/transfer-mode-shims';

const __dirname_ = dirname(fileURLToPath(import.meta.url));
const SHIM_PATH = resolve(
  __dirname_,
  '../../../extensions/uxf/pipeline/transfer-mode-shims.ts',
);
const SHIM_SRC = readFileSync(SHIM_PATH, 'utf8');

// =============================================================================
// 1. Surface lock-in — exact residual export set, no more, no less.
// =============================================================================

const RESIDUAL_RUNTIME_EXPORTS = ['narrowTransferMode', 'requireLegacyCoinSlot'] as const;

// Type-only exports are erased at runtime so we cannot enumerate them via
// `Object.keys(shims)`; assert their presence in the source instead.
const RESIDUAL_TYPE_EXPORTS = ['LegacyCoinTransferRequest'] as const;

const REMOVED_EXPORTS = [
  'DEFAULT_TRANSFER_MODE',
  'defaultTransferMode',
  'assertConservativeOrInstant',
  'coercePartialTransferRequestMode',
] as const;

describe('transfer-mode-shims residue — surface', () => {
  it('exports exactly the residual runtime symbols', () => {
    const exported = Object.keys(shims).sort();
    expect(exported).toEqual([...RESIDUAL_RUNTIME_EXPORTS].sort());
  });

  it('does not re-introduce any removed symbol', () => {
    for (const name of REMOVED_EXPORTS) {
      expect(SHIM_SRC).not.toMatch(
        new RegExp(`^export\\s+(?:const|function|type)\\s+${name}\\b`, 'm'),
      );
    }
  });

  it('declares each residual type-only export', () => {
    for (const name of RESIDUAL_TYPE_EXPORTS) {
      expect(SHIM_SRC).toMatch(
        new RegExp(`^export\\s+type\\s+${name}\\b`, 'm'),
      );
    }
  });
});

// =============================================================================
// 2. Documented justification — every residual export has a `reason: "..."`
// =============================================================================

// Find the TSDoc block immediately preceding `name` and return its body
// (or `null` if no block is present). The matcher walks back from the
// export keyword to the nearest comment-close marker, then forwards to
// its comment-open. Any `export` shape is tolerated
// (`export function`, `export const`, `export type`).
function findTsdocBefore(src: string, name: string): string | null {
  const exportRegex = new RegExp(
    `export\\s+(?:async\\s+)?(?:function|const|type)\\s+${name}\\b`,
    'm',
  );
  const m = src.match(exportRegex);
  if (!m || m.index === undefined) return null;
  const head = src.slice(0, m.index);
  const closeIdx = head.lastIndexOf('*/');
  if (closeIdx < 0) return null;
  // Anything between `*/` and the export keyword that is not whitespace
  // means the comment is not directly attached.
  const between = head.slice(closeIdx + 2);
  if (/\S/.test(between)) return null;
  const openIdx = head.lastIndexOf('/**', closeIdx);
  if (openIdx < 0) return null;
  return head.slice(openIdx, closeIdx + 2);
}

describe('transfer-mode-shims residue — documentation', () => {
  // The marker we look for. Convention: the shim doc ends with
  // `reason: "<one sentence>"` so a grep over the file shows why every
  // residual symbol exists.
  const REASON_MARKER = /reason:\s*"[^"]+"/;

  for (const name of [...RESIDUAL_RUNTIME_EXPORTS, ...RESIDUAL_TYPE_EXPORTS]) {
    it(`residual export "${name}" has a TSDoc \`reason: "..."\` marker`, () => {
      const doc = findTsdocBefore(SHIM_SRC, name);
      expect(doc, `expected TSDoc block before \`${name}\``).not.toBeNull();
      expect(doc).toMatch(REASON_MARKER);
    });
  }

  it('file header documents the residual schedule with `reason:` markers', () => {
    // The header doc-block must list each residual export with a reason
    // so a reviewer reading top-to-bottom sees the rationale before the
    // implementations.
    const headerEnd = SHIM_SRC.indexOf('*/');
    expect(headerEnd).toBeGreaterThan(0);
    const header = SHIM_SRC.slice(0, headerEnd + 2);
    for (const name of [...RESIDUAL_RUNTIME_EXPORTS, ...RESIDUAL_TYPE_EXPORTS]) {
      expect(header).toMatch(new RegExp(`{@link\\s+${name}}`));
    }
    // At least one `reason:` marker per residual entry in the schedule.
    const reasonCount = (header.match(/reason:\s*"/g) ?? []).length;
    expect(reasonCount).toBeGreaterThanOrEqual(
      RESIDUAL_RUNTIME_EXPORTS.length + RESIDUAL_TYPE_EXPORTS.length,
    );
  });
});
