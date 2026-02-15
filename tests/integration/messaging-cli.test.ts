/**
 * CLI integration tests for messaging and group chat commands.
 *
 * Spawns the CLI as a subprocess and verifies:
 * - Help text lists MESSAGING and GROUP CHAT sections
 * - DM commands show usage when called without required args
 * - Group chat commands show usage when called without required args
 */

import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';

const exec = promisify(execFile);

const CLI_PATH = path.resolve(__dirname, '../../cli/index.ts');
const TSX = 'npx';

/** Run a CLI command via tsx, returns { stdout, stderr, exitCode } */
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

describe('Messaging CLI commands', () => {
  // ---------------------------------------------------------------------------
  // Help text
  // ---------------------------------------------------------------------------

  describe('help text', () => {
    it('should include MESSAGING section', async () => {
      const { stdout } = await runCli(['--help']);
      expect(stdout).toContain('MESSAGING (Direct Messages)');
      expect(stdout).toContain('dm <@nametag> <message>');
      expect(stdout).toContain('dm-inbox');
      expect(stdout).toContain('dm-history');
    });

    it('should include GROUP CHAT section', async () => {
      const { stdout } = await runCli(['--help']);
      expect(stdout).toContain('GROUP CHAT (NIP-29)');
      expect(stdout).toContain('group-create');
      expect(stdout).toContain('group-list');
      expect(stdout).toContain('group-my');
      expect(stdout).toContain('group-join');
      expect(stdout).toContain('group-leave');
      expect(stdout).toContain('group-send');
      expect(stdout).toContain('group-messages');
      expect(stdout).toContain('group-members');
      expect(stdout).toContain('group-info');
    });

    it('should include messaging examples', async () => {
      const { stdout } = await runCli(['--help']);
      expect(stdout).toContain('Messaging Examples:');
      expect(stdout).toContain('dm @alice');
      expect(stdout).toContain('dm-history @alice');
    });

    it('should include group chat examples', async () => {
      const { stdout } = await runCli(['--help']);
      expect(stdout).toContain('Group Chat Examples:');
      expect(stdout).toContain('group-create');
      expect(stdout).toContain('group-send');
    });
  });

  // ---------------------------------------------------------------------------
  // DM argument validation
  // ---------------------------------------------------------------------------

  describe('dm argument validation', () => {
    it('should show usage when dm called without arguments', async () => {
      const { stderr, exitCode } = await runCli(['dm']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Usage:');
    });

    it('should show usage when dm-history called without peer', async () => {
      const { stderr, exitCode } = await runCli(['dm-history']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Usage:');
    });
  });

  // ---------------------------------------------------------------------------
  // Group Chat argument validation
  // ---------------------------------------------------------------------------

  describe('group chat argument validation', () => {
    it('should show usage when group-create called without name', async () => {
      const { stderr, exitCode } = await runCli(['group-create']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Usage:');
    });

    it('should show usage when group-join called without groupId', async () => {
      const { stderr, exitCode } = await runCli(['group-join']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Usage:');
    });

    it('should show usage when group-leave called without groupId', async () => {
      const { stderr, exitCode } = await runCli(['group-leave']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Usage:');
    });

    it('should show usage when group-send called without arguments', async () => {
      const { stderr, exitCode } = await runCli(['group-send']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Usage:');
    });

    it('should show usage when group-messages called without groupId', async () => {
      const { stderr, exitCode } = await runCli(['group-messages']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Usage:');
    });

    it('should show usage when group-members called without groupId', async () => {
      const { stderr, exitCode } = await runCli(['group-members']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Usage:');
    });

    it('should show usage when group-info called without groupId', async () => {
      const { stderr, exitCode } = await runCli(['group-info']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Usage:');
    });
  });
});
