/**
 * T.7.C — production call-site migration integration test for CLI.
 *
 * **Goal**: prove the CLI `send` command (and the `invoice-pay` /
 * `invoice-return` commands that delegate through AccountingModule) pass
 * `transferMode` explicitly to `payments.send()`. The migration is a
 * prerequisite for Wave T.1.B.2 (audit shim removal).
 *
 * **Approach** — two complementary checks:
 *
 *   1. **Subprocess-driven `--help` verification** — proves the CLI
 *      surface still exposes the `--instant` / `--conservative` mode
 *      flags. UX regression guard: if a future refactor accidentally
 *      drops the mode flag wiring, `--help` will stop listing them and
 *      this test flips red.
 *
 *   2. **Source-level structural assertion** — reads `cli/index.ts`
 *      directly and verifies:
 *
 *        a. The `send` case constructs an explicit `transferMode:
 *           TransferMode = forceConservative ? 'conservative' :
 *           'instant'` ternary (or equivalent — the regex tolerates
 *           whitespace variations).
 *        b. The `payments.send({...})` call inside the `send` case
 *           passes `transferMode` as a property.
 *        c. There is no `payments.send({...})` call ANYWHERE in
 *           `cli/index.ts` that omits `transferMode`. Adding a new CLI
 *           command that calls `payments.send()` without explicit
 *           `transferMode` flips this red.
 *
 *      Source-level assertions are a load-bearing supplement to the
 *      `accounting/uxf-transfer.test.ts` runtime check: between them,
 *      ALL production call-sites (CLI + AccountingModule + recursive
 *      PaymentsModule) are pinned.
 *
 * **Why not exec the full `send` happy path**: the CLI happy path
 * requires a configured wallet, network access, and the aggregator —
 * none of which are available to vitest's hermetic runtime. A
 * source-level assertion plus the `--help` shape check is the right
 * trade-off for an integration test that runs in <1s.
 *
 * Spec references:
 *   - T.7.C task definition (`docs/uxf/UXF-TRANSFER-IMPL-PLAN.md`).
 *   - §10.1 sender side.
 *
 * @module tests/integration/cli/uxf-transfer
 */

import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const exec = promisify(execFile);

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..', '..', '..');
const CLI_PATH = resolve(REPO_ROOT, 'cli', 'index.ts');
const TSX = 'npx';

/** Cold tsx + SDK transpile under contention can take 10–20s; budget under 30s vitest cap. */
const CLI_SUBPROCESS_TIMEOUT_MS = 25000;

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await exec(TSX, ['tsx', CLI_PATH, ...args], {
      timeout: CLI_SUBPROCESS_TIMEOUT_MS,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as Record<string, unknown>;
    return {
      stdout: (e.stdout as string) ?? '',
      stderr: (e.stderr as string) ?? '',
      exitCode: (e.code as number) ?? 1,
    };
  }
}

// =============================================================================
// 1. Subprocess-driven --help shape check
// =============================================================================

describe('T.7.C — CLI production call-site UXF migration (--help shape)', () => {
  it('IT-CLI-UXF-001: --help still exposes --instant and --conservative mode flags', async () => {
    const { stdout, stderr } = await runCli(['help', 'send']);
    const combined = `${stdout}\n${stderr}`;
    // The `send` command's usage line lists both mode flags. If a future
    // refactor accidentally removes them we catch it here. Tolerate a
    // missing wallet or other init failure: the help/usage text is
    // emitted before any wallet check.
    expect(combined).toMatch(/--instant/);
    expect(combined).toMatch(/--conservative/);
  });
});

// =============================================================================
// 2. Source-level structural assertions
// =============================================================================

describe('T.7.C — CLI production call-site UXF migration (source pin)', () => {
  let cliSource: string;

  /** Lazily read the CLI source once per file. */
  async function getCliSource(): Promise<string> {
    if (!cliSource) {
      cliSource = await readFile(CLI_PATH, 'utf8');
    }
    return cliSource;
  }

  it("IT-CLI-UXF-002: send case declares an explicit transferMode: TransferMode binding", async () => {
    const src = await getCliSource();
    // Tolerate whitespace + comment lines between `const transferMode:`
    // and the ternary body. The match is anchored on the literal binding
    // so a refactor to `let mode = ...` flips this red and forces an
    // ADR-style update to the test (see T.7.E for the eventual public
    // default flip).
    const re = /const\s+transferMode\s*:\s*TransferMode\s*=\s*forceConservative\s*\?\s*['"]conservative['"]\s*:\s*['"]instant['"]/;
    expect(src, 'cli/index.ts must declare an explicit TransferMode ternary').toMatch(re);
  });

  it('IT-CLI-UXF-003: every payments.send({...}) call in cli/index.ts passes transferMode', async () => {
    const src = await getCliSource();
    // Find every `*.payments.send({` opening and walk forward until the
    // matching `})`. Then assert each captured object literal contains
    // the substring `transferMode`. The walk is brace-depth aware so
    // nested object literals (e.g., `additionalAssets: [{ kind: 'coin' }]`)
    // do not terminate the call early.
    const occurrences: Array<{ start: number; argsLiteral: string }> = [];
    const opener = /\.payments\.send\s*\(\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = opener.exec(src)) !== null) {
      // The character immediately after the matched `{` is at index
      // m.index + m[0].length — start of the literal body.
      const literalStart = m.index + m[0].length - 1;
      let depth = 1;
      let i = literalStart + 1;
      while (i < src.length && depth > 0) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        // Skip JS string contents to avoid mistaken `{` / `}` inside
        // template literals or quotes. Cheap state machine — handles
        // single, double, backtick, and line/block comments.
        else if (c === "'" || c === '"' || c === '`') {
          const quote = c;
          i++;
          while (i < src.length && src[i] !== quote) {
            if (src[i] === '\\') i++; // skip escape
            i++;
          }
        } else if (c === '/' && src[i + 1] === '/') {
          while (i < src.length && src[i] !== '\n') i++;
        } else if (c === '/' && src[i + 1] === '*') {
          i += 2;
          while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++;
          i++;
        }
        i++;
      }
      const argsLiteral = src.slice(literalStart, i);
      occurrences.push({ start: m.index, argsLiteral });
    }

    expect(occurrences.length, 'expected at least one payments.send call in cli/index.ts').toBeGreaterThan(0);
    for (const { start, argsLiteral } of occurrences) {
      // Compute a 1-based line number for diagnostics.
      const line = src.slice(0, start).split('\n').length;
      expect(
        argsLiteral,
        `cli/index.ts:${line} — payments.send() call missing explicit transferMode`,
      ).toMatch(/\btransferMode\b/);
    }
  });

  // Also pin the cross-cutting expectation that AccountingModule's CLI
  // entry-points (invoice-pay / invoice-return) flow through
  // accounting.payInvoice / accounting.returnInvoicePayment — both of
  // which are pinned by the runtime test in
  // tests/integration/accounting/uxf-transfer.test.ts. We do NOT
  // duplicate those runtime assertions here; we only verify the CLI
  // delegates rather than calling `payments.send` directly.
  it('IT-CLI-UXF-004: invoice-pay and invoice-return delegate to AccountingModule (no direct payments.send)', async () => {
    const src = await getCliSource();

    /**
     * Extract the body of `case '<name>':` up to the next case label.
     * Returns the substring from the start of the case label's body
     * (i.e., AFTER the colon) to the next `case '` occurrence.
     */
    function extractCaseBody(name: string): string {
      const head = `case '${name}':`;
      const start = src.indexOf(head);
      if (start === -1) return '';
      const bodyStart = start + head.length;
      // Find the next `case '` AFTER the body starts.
      const next = src.indexOf("case '", bodyStart);
      return next === -1 ? src.slice(bodyStart) : src.slice(bodyStart, next);
    }

    const payBody = extractCaseBody('invoice-pay');
    const returnBody = extractCaseBody('invoice-return');

    expect(payBody).toContain('accounting.payInvoice');
    expect(payBody).not.toMatch(/\.payments\.send\s*\(/);
    expect(returnBody).toContain('accounting.returnInvoicePayment');
    expect(returnBody).not.toMatch(/\.payments\.send\s*\(/);
  });
});
