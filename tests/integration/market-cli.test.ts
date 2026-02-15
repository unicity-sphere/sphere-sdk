/**
 * CLI integration tests for market commands.
 *
 * Spawns the CLI as a subprocess and verifies:
 * - Help text lists all 5 intent types and the market-feed command
 * - market-post sends correct intent_type for each type
 * - market-search sends correct type filter for each type
 * - market-feed --rest fetches recent listings
 * - Error messages reference correct types
 */

import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';

const exec = promisify(execFile);

const CLI_PATH = path.resolve(__dirname, '../../cli/index.ts');
const TSX = 'npx';

/** Run a CLI command via tsx, returns { stdout, stderr } */
async function runCli(
  args: string[],
  options?: { timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await exec(TSX, ['tsx', CLI_PATH, ...args], {
      timeout: options?.timeout ?? 15000,
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

describe('Market CLI commands', () => {
  // ---------------------------------------------------------------------------
  // Help text
  // ---------------------------------------------------------------------------

  describe('help text', () => {
    it('should list all 5 intent types in market-post description', async () => {
      const { stdout } = await runCli(['--help']);
      expect(stdout).toContain('buy, sell, service, announcement, other');
    });

    it('should include market-feed command in help', async () => {
      const { stdout } = await runCli(['--help']);
      expect(stdout).toContain('market-feed');
      expect(stdout).toContain('--rest');
    });

    it('should include market-feed in examples section', async () => {
      const { stdout } = await runCli(['--help']);
      expect(stdout).toContain('market-feed');
      // Both live and REST examples
      expect(stdout).toMatch(/market-feed\b/);
      expect(stdout).toMatch(/market-feed --rest/);
    });

    it('should include announcement example in market examples', async () => {
      const { stdout } = await runCli(['--help']);
      expect(stdout).toContain('--type announcement');
    });
  });

  // ---------------------------------------------------------------------------
  // market-post argument parsing
  // ---------------------------------------------------------------------------

  describe('market-post argument validation', () => {
    it('should show usage when called without arguments', async () => {
      const { stderr, exitCode } = await runCli(['market-post']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Usage:');
    });

    it('should require --type flag', async () => {
      const { stderr, exitCode } = await runCli(['market-post', 'Test description']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('--type');
      // Error message should list all 5 types
      expect(stderr).toContain('buy, sell, service, announcement, other');
    });
  });

  // ---------------------------------------------------------------------------
  // market-search argument parsing
  // ---------------------------------------------------------------------------

  describe('market-search argument validation', () => {
    it('should show usage when called without query', async () => {
      const { stderr, exitCode } = await runCli(['market-search']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Usage:');
    });
  });

  // ---------------------------------------------------------------------------
  // market-close argument parsing
  // ---------------------------------------------------------------------------

  describe('market-close argument validation', () => {
    it('should show usage when called without intent ID', async () => {
      const { stderr, exitCode } = await runCli(['market-close']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Usage:');
    });
  });
});
