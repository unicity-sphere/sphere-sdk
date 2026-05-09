/**
 * Regression tests for the CLI entry-point gating logic.
 *
 * SKIPPED — POST-EXTRACTION PLACEHOLDER
 * --------------------------------------
 * The Sphere CLI was extracted into a separate package (`sphere-cli`,
 * tracked in the `sphere-cli` repository). The in-tree `cli/index.ts`
 * that these tests targeted no longer exists in the SDK package; only
 * `cli/global-flags.ts` and `cli/storage-mode.ts` (shared helpers
 * still consumed by the SDK itself) remain.
 *
 * These tests are skipped pending migration to the `sphere-cli` repo,
 * where they belong. The SDK repo's job is the SDK; the CLI's
 * entry-point semantics (F.18/F.19/F.20 history below) are now the
 * CLI repo's regression surface.
 *
 * Original history (preserved for context — re-apply in `sphere-cli`):
 *   F.18 (steelman¹⁵) introduced `isCliEntryPoint` to prevent
 *        library imports of `cli/index.ts` from running `main()`
 *        and calling `process.exit(1)` against the importer's argv.
 *   F.19 (steelman¹⁶) fixed F.18's symlink regression: `import.meta.url`
 *        resolves to the real path while `process.argv[1]` retains the
 *        symlink path, so `pathToFileURL(...) === import.meta.url` was
 *        false under symlinks → CLI silently exited 0 with no output.
 *        F.19 wraps both sides in `realpathSync` for symmetric resolution.
 *   F.20 (steelman¹⁷) ADDS THIS TEST. R17 reviewer noted that 16
 *        rounds of review had hammered the contract but the F.19 fix
 *        itself had zero test coverage; the next refactor that touches
 *        module-load semantics could silently regress to F.18-style
 *        behavior and `npm run test` would still pass.
 *
 * The contract being locked in:
 *   1. Direct invocation `npx tsx cli/index.ts --help` → main() runs.
 *   2. Symlink invocation `npx tsx /tmp/symlinked-cli.ts --help` → main() runs.
 *      (F.18 broke this; F.19 fixed it.)
 *   3. Dynamic import `await import('cli/index')` → main() does NOT run.
 *      (F.18+ never ran main on import; this is the original guard intent.)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CLI_PATH = path.resolve(__dirname, '../../../cli/index.ts');
const HELP_MARKER = 'Sphere SDK CLI v0.3.0';

function runCli(scriptPath: string, ...args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('npx', ['tsx', scriptPath, ...args], {
    encoding: 'utf-8',
    cwd: path.resolve(__dirname, '../../..'),
    timeout: 30000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

describe.skip('CLI entry-point gating (F.18 + F.19) — SKIPPED: CLI extracted to sphere-cli repo', () => {
  let tmpDir: string;
  let symlinkPath: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-cli-entry-point-'));
    symlinkPath = path.join(tmpDir, 'symlinked-cli.ts');
    fs.symlinkSync(CLI_PATH, symlinkPath);
  });

  afterAll(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('direct invocation: main() runs and prints help', () => {
    const { stdout, status } = runCli(CLI_PATH, '--help');
    expect(stdout).toContain(HELP_MARKER);
    expect(status).toBe(0);
  });

  it('symlink invocation: main() runs (F.19 regression fix)', () => {
    // Pre-F.19 (F.18-style equality on pathToFileURL alone): this
    // returned silent exit 0 with no output because Node resolves
    // import.meta.url to the real path while process.argv[1] retains
    // the symlink path. F.19's realpathSync symmetry closes this.
    const { stdout, status } = runCli(symlinkPath, '--help');
    expect(stdout).toContain(HELP_MARKER);
    expect(status).toBe(0);
  });

  it('library import: main() does NOT run, no process.exit', () => {
    // Use dynamic import via -e flag. main() should not fire; the
    // process should reach `console.log("imported, no main()")`.
    const importerScript = `
      import('${CLI_PATH.replace(/'/g, "\\'")}').then(() => {
        console.log('IMPORT_OK');
      }).catch((e) => {
        console.error('IMPORT_FAILED:', e.message);
        process.exit(2);
      });
    `;
    const result = spawnSync('npx', ['tsx', '-e', importerScript], {
      encoding: 'utf-8',
      cwd: path.resolve(__dirname, '../../..'),
      timeout: 30000,
    });
    // Should print our marker (not main()'s help output).
    expect(result.stdout || '').toContain('IMPORT_OK');
    expect(result.stdout || '').not.toContain(HELP_MARKER);
    expect(result.status).toBe(0);
  });

  it('symlink invocation handles errors normally (e.g., bad flag)', () => {
    // F.19 must preserve normal CLI error handling when invoked via
    // symlink — not just the happy path.
    const { stderr, status } = runCli(symlinkPath, '--ipfs-gateway', 'bogus-not-a-url', 'init');
    expect(stderr).toContain('not a valid http(s) URL');
    expect(status).toBe(1);
  });
});
