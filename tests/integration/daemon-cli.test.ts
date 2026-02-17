/**
 * Comprehensive E2E integration tests for the CLI daemon feature.
 *
 * Tests cover:
 *   A. Help text verification
 *   B. Argument & config validation (no wallet needed)
 *   C. Daemon lifecycle (start/status/stop)
 *   D. Event & rule configuration logging
 *   E. Log & PID file options
 *   F. Real event triggers via DM over Nostr
 *
 * Note: The daemon's `--detach` mode uses `fork()` which doesn't work with
 * TypeScript (tsx). Tests that need a running daemon use `spawnDaemon()` which
 * spawns `npx tsx ... --_forked` directly, simulating detach mode behavior.
 */

import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const exec = promisify(execFile);

const CLI_PATH = path.resolve(__dirname, '../../cli/index.ts');
const TSX = 'npx';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a CLI command via tsx, returns { stdout, stderr, exitCode }. */
async function runCli(
  args: string[],
  options?: { timeout?: number; cwd?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await exec(TSX, ['tsx', CLI_PATH, ...args], {
      timeout: options?.timeout ?? 15_000,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      cwd: options?.cwd,
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

/**
 * Spawn a daemon process in the background using `--_forked` flag.
 * This simulates what `--detach` does internally but works with tsx.
 * Returns the spawned ChildProcess.
 */
function spawnDaemon(
  testDir: string,
  extraArgs: string[],
): ChildProcess {
  const child = spawn(
    TSX,
    ['tsx', CLI_PATH, 'daemon', 'start', '--_forked', ...extraArgs],
    {
      cwd: testDir,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    },
  );
  child.unref();
  return child;
}

/** Create an isolated temp directory for a test. */
function createTestDir(): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(os.tmpdir(), `sphere-daemon-test-${suffix}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Recursively remove a directory. */
function cleanupTestDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* best effort */ }
}

/** Initialize a fresh wallet in the given directory. */
async function initWallet(
  testDir: string,
  opts?: { noNostr?: boolean; nametag?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const noNostr = opts?.noNostr ?? true;
  const cliArgs = ['init', '--network', 'testnet'];
  if (noNostr) cliArgs.push('--no-nostr');
  if (opts?.nametag) cliArgs.push('--nametag', opts.nametag);
  return runCli(cliArgs, { cwd: testDir, timeout: opts?.timeout ?? 60_000 });
}

/** Sleep for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Poll for a file to exist and optionally contain a substring.
 * Returns the file contents on success, or throws on timeout.
 */
async function pollForFile(
  filePath: string,
  opts?: { timeout?: number; contains?: string; interval?: number },
): Promise<string> {
  const timeout = opts?.timeout ?? 15_000;
  const interval = opts?.interval ?? 500;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      if (!opts?.contains || content.includes(opts.contains)) {
        return content;
      }
    }
    await sleep(interval);
  }

  const exists = fs.existsSync(filePath);
  if (!exists) {
    throw new Error(`File ${filePath} did not appear within ${timeout}ms`);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  if (opts?.contains && !content.includes(opts.contains)) {
    throw new Error(
      `File ${filePath} exists but does not contain "${opts.contains}" within ${timeout}ms. Contents:\n${content}`,
    );
  }
  return content;
}

/**
 * Force-stop a daemon by reading its PID file and sending SIGKILL.
 */
function stopDaemonForce(testDir: string, pidPath?: string): void {
  const pidFile = pidPath || path.join(testDir, '.sphere-cli', 'daemon.pid');
  try {
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
      try { fs.unlinkSync(pidFile); } catch { /* best effort */ }
    }
  } catch { /* best effort */ }
}

// Track all test dirs for cleanup
const testDirs: string[] = [];

afterEach(() => {
  // Stop any daemons left running in test dirs
  for (const dir of testDirs) {
    stopDaemonForce(dir);
  }
});

// =============================================================================
// A. Help Text
// =============================================================================

describe('Daemon CLI', () => {
  describe('A. Help text', () => {
    it('A1: --help includes EVENT DAEMON section with all flags', async () => {
      const { stdout } = await runCli(['--help']);
      expect(stdout).toContain('EVENT DAEMON:');
      expect(stdout).toContain('daemon start');
      expect(stdout).toContain('--config');
      expect(stdout).toContain('--detach');
      expect(stdout).toContain('--log');
      expect(stdout).toContain('--pid');
      expect(stdout).toContain('--event');
      expect(stdout).toContain('--action');
      expect(stdout).toContain('--market-feed');
      expect(stdout).toContain('--verbose');
      expect(stdout).toContain('daemon stop');
      expect(stdout).toContain('daemon status');
    });

    it('A2: --help includes Daemon Examples section', async () => {
      const { stdout } = await runCli(['--help']);
      expect(stdout).toContain('Daemon Examples:');
      expect(stdout).toContain('daemon start --event transfer:incoming --action auto-receive');
      expect(stdout).toContain('daemon start --config');
      expect(stdout).toContain('daemon status');
      expect(stdout).toContain('daemon stop');
    });
  });

  // =============================================================================
  // B. Argument & Config Validation (no wallet needed)
  // =============================================================================

  describe('B. Argument & config validation', () => {
    it('B1: unknown daemon sub-command shows error', async () => {
      const { stderr, exitCode } = await runCli(['daemon', 'restart']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Unknown daemon sub-command');
    });

    it('B2: --event without --action shows error', async () => {
      const testDir = createTestDir();
      testDirs.push(testDir);
      try {
        const { stderr, exitCode } = await runCli(
          ['daemon', 'start', '--event', 'transfer:incoming'],
          { cwd: testDir },
        );
        expect(exitCode).not.toBe(0);
        expect(stderr).toContain('--event requires at least one --action');
      } finally {
        cleanupTestDir(testDir);
      }
    });

    it('B3: --action without --event shows error', async () => {
      const testDir = createTestDir();
      testDirs.push(testDir);
      try {
        const { stderr, exitCode } = await runCli(
          ['daemon', 'start', '--action', 'auto-receive'],
          { cwd: testDir },
        );
        expect(exitCode).not.toBe(0);
        expect(stderr).toContain('--action requires at least one --event');
      } finally {
        cleanupTestDir(testDir);
      }
    });

    it('B4: --config with nonexistent file shows error', async () => {
      const testDir = createTestDir();
      testDirs.push(testDir);
      try {
        const { stderr, exitCode } = await runCli(
          ['daemon', 'start', '--config', '/tmp/nonexistent-daemon-config-xyz.json'],
          { cwd: testDir },
        );
        expect(exitCode).not.toBe(0);
        expect(stderr).toContain('Config file not found');
      } finally {
        cleanupTestDir(testDir);
      }
    });

    it('B5: invalid JSON in config file shows error', async () => {
      const testDir = createTestDir();
      testDirs.push(testDir);
      const configPath = path.join(testDir, 'bad.json');
      fs.writeFileSync(configPath, '{ not valid json !!!');
      try {
        const { stderr, exitCode } = await runCli(
          ['daemon', 'start', '--config', configPath],
          { cwd: testDir },
        );
        expect(exitCode).not.toBe(0);
        expect(stderr).toContain('Invalid JSON');
      } finally {
        cleanupTestDir(testDir);
      }
    });

    it('B6: config with empty rules exits with "No active rules"', async () => {
      const testDir = createTestDir();
      testDirs.push(testDir);
      const configPath = path.join(testDir, 'empty.json');
      fs.writeFileSync(configPath, JSON.stringify({ rules: [] }));
      await initWallet(testDir, { timeout: 60_000 });
      try {
        const { stdout, stderr } = await runCli(
          ['daemon', 'start', '--no-nostr', '--config', configPath],
          { cwd: testDir, timeout: 60_000 },
        );
        const combined = stdout + stderr;
        expect(combined).toContain('No active rules');
      } finally {
        cleanupTestDir(testDir);
      }
    }, 90_000);

    it('B7: config with unknown action type shows error', async () => {
      const testDir = createTestDir();
      testDirs.push(testDir);
      const configPath = path.join(testDir, 'bad-action.json');
      fs.writeFileSync(configPath, JSON.stringify({
        rules: [{
          events: ['transfer:incoming'],
          actions: [{ type: 'email', to: 'test@example.com' }],
        }],
      }));
      try {
        const { stderr, exitCode } = await runCli(
          ['daemon', 'start', '--config', configPath],
          { cwd: testDir },
        );
        expect(exitCode).not.toBe(0);
        expect(stderr).toContain('type must be "bash", "webhook", or "builtin"');
      } finally {
        cleanupTestDir(testDir);
      }
    });

    it('B8: bash action missing command shows error', async () => {
      const testDir = createTestDir();
      testDirs.push(testDir);
      const configPath = path.join(testDir, 'no-cmd.json');
      fs.writeFileSync(configPath, JSON.stringify({
        rules: [{
          events: ['transfer:incoming'],
          actions: [{ type: 'bash' }],
        }],
      }));
      try {
        const { stderr, exitCode } = await runCli(
          ['daemon', 'start', '--config', configPath],
          { cwd: testDir },
        );
        expect(exitCode).not.toBe(0);
        expect(stderr).toContain('bash action requires a non-empty command');
      } finally {
        cleanupTestDir(testDir);
      }
    });

    it('B9: rule with empty events array shows error', async () => {
      const testDir = createTestDir();
      testDirs.push(testDir);
      const configPath = path.join(testDir, 'empty-events.json');
      fs.writeFileSync(configPath, JSON.stringify({
        rules: [{
          events: [],
          actions: [{ type: 'bash', command: 'echo hi' }],
        }],
      }));
      try {
        const { stderr, exitCode } = await runCli(
          ['daemon', 'start', '--config', configPath],
          { cwd: testDir },
        );
        expect(exitCode).not.toBe(0);
        expect(stderr).toContain('events must be a non-empty array');
      } finally {
        cleanupTestDir(testDir);
      }
    });

    it('B10: invalid inline action spec shows error', async () => {
      const testDir = createTestDir();
      testDirs.push(testDir);
      try {
        const { stderr, exitCode } = await runCli(
          ['daemon', 'start', '--event', 'message:dm', '--action', 'email:test@example.com'],
          { cwd: testDir },
        );
        expect(exitCode).not.toBe(0);
        expect(stderr).toContain('Unknown action type "email"');
      } finally {
        cleanupTestDir(testDir);
      }
    });

    it('B11: all rules disabled exits with "No active rules"', async () => {
      const testDir = createTestDir();
      testDirs.push(testDir);
      const configPath = path.join(testDir, 'disabled.json');
      fs.writeFileSync(configPath, JSON.stringify({
        rules: [{
          events: ['transfer:incoming'],
          actions: [{ type: 'bash', command: 'echo hi' }],
          disabled: true,
        }],
      }));
      await initWallet(testDir, { timeout: 60_000 });
      try {
        const { stdout, stderr } = await runCli(
          ['daemon', 'start', '--no-nostr', '--config', configPath],
          { cwd: testDir, timeout: 60_000 },
        );
        const combined = stdout + stderr;
        expect(combined).toContain('No active rules');
      } finally {
        cleanupTestDir(testDir);
      }
    }, 90_000);
  });

  // =============================================================================
  // C. Daemon Lifecycle
  // =============================================================================

  describe('C. Daemon lifecycle', () => {
    let testDir: string;

    afterEach(async () => {
      if (testDir) {
        stopDaemonForce(testDir);
        try {
          await runCli(['daemon', 'stop'], { cwd: testDir, timeout: 10_000 });
        } catch { /* best effort */ }
        cleanupTestDir(testDir);
      }
    });

    it('C1: full lifecycle — start, PID file, log, status (running), stop, status (not running)', async () => {
      testDir = createTestDir();
      testDirs.push(testDir);
      await initWallet(testDir, { timeout: 60_000 });

      const pidFile = path.join(testDir, '.sphere-cli', 'daemon.pid');
      const logFile = path.join(testDir, '.sphere-cli', 'daemon.log');

      // Start daemon via spawnDaemon (simulates --detach with tsx)
      spawnDaemon(testDir, [
        '--no-nostr', '--event', 'transfer:incoming', '--action', 'auto-receive',
      ]);

      // Wait for PID file
      await pollForFile(pidFile, { timeout: 15_000 });
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      expect(pid).toBeGreaterThan(0);

      // Wait for log to contain "Daemon running"
      await pollForFile(logFile, { timeout: 60_000, contains: 'Daemon running' });

      // Status should show running
      const status1 = await runCli(['daemon', 'status'], { cwd: testDir, timeout: 10_000 });
      expect(status1.stdout).toContain('running');
      expect(status1.stdout).toContain(`PID ${pid}`);

      // Stop daemon
      const stop = await runCli(['daemon', 'stop'], { cwd: testDir, timeout: 15_000 });
      expect(stop.stdout).toMatch(/Daemon stopped|Daemon killed/);

      // PID file should be removed
      await sleep(1000);
      expect(fs.existsSync(pidFile)).toBe(false);

      // Status should show not running
      const status2 = await runCli(['daemon', 'status'], { cwd: testDir, timeout: 10_000 });
      expect(status2.stdout).toContain('not running');
    }, 90_000);

    it('C2: double-start prevention — second start sees running PID', async () => {
      testDir = createTestDir();
      testDirs.push(testDir);
      await initWallet(testDir, { timeout: 60_000 });

      const logFile = path.join(testDir, '.sphere-cli', 'daemon.log');

      // Start first daemon
      spawnDaemon(testDir, [
        '--no-nostr', '--event', 'transfer:incoming', '--action', 'auto-receive',
      ]);
      await pollForFile(logFile, { timeout: 60_000, contains: 'Daemon running' });

      // Try to start second daemon via --detach (it checks PID file before fork)
      const second = await runCli(
        ['daemon', 'start', '--detach',
         '--event', 'transfer:incoming', '--action', 'auto-receive'],
        { cwd: testDir, timeout: 30_000 },
      );
      expect(second.exitCode).not.toBe(0);
      expect(second.stderr).toContain('already running');
    }, 90_000);

    it('C3: stop when not running shows message', async () => {
      testDir = createTestDir();
      testDirs.push(testDir);

      const stop = await runCli(['daemon', 'stop'], { cwd: testDir, timeout: 10_000 });
      expect(stop.stdout).toContain('No daemon running');
    });

    it('C4: status when not running shows message', async () => {
      testDir = createTestDir();
      testDirs.push(testDir);

      const status = await runCli(['daemon', 'status'], { cwd: testDir, timeout: 10_000 });
      expect(status.stdout).toContain('not running');
    });

    it('C5: stale PID on stop cleans up', async () => {
      testDir = createTestDir();
      testDirs.push(testDir);
      const pidDir = path.join(testDir, '.sphere-cli');
      fs.mkdirSync(pidDir, { recursive: true });
      const pidFile = path.join(pidDir, 'daemon.pid');
      fs.writeFileSync(pidFile, '999999999');

      const stop = await runCli(['daemon', 'stop'], { cwd: testDir, timeout: 10_000 });
      expect(stop.stdout).toContain('Stale PID file');
      expect(fs.existsSync(pidFile)).toBe(false);
    });

    it('C6: stale PID on status shows stale message', async () => {
      testDir = createTestDir();
      testDirs.push(testDir);
      const pidDir = path.join(testDir, '.sphere-cli');
      fs.mkdirSync(pidDir, { recursive: true });
      fs.writeFileSync(path.join(pidDir, 'daemon.pid'), '999999999');

      const status = await runCli(['daemon', 'status'], { cwd: testDir, timeout: 10_000 });
      expect(status.stdout).toContain('stale PID file');
    });

    it('C7: stale PID does not block new daemon start', async () => {
      testDir = createTestDir();
      testDirs.push(testDir);
      await initWallet(testDir, { timeout: 60_000 });

      const pidDir = path.join(testDir, '.sphere-cli');
      fs.mkdirSync(pidDir, { recursive: true });
      const pidFile = path.join(pidDir, 'daemon.pid');
      fs.writeFileSync(pidFile, '999999999');
      const logFile = path.join(pidDir, 'daemon.log');

      // spawnDaemon with --_forked writes its own PID, overwriting the stale one
      spawnDaemon(testDir, [
        '--no-nostr', '--event', 'transfer:incoming', '--action', 'auto-receive',
      ]);

      // Wait for daemon to be running
      await pollForFile(logFile, { timeout: 60_000, contains: 'Daemon running' });

      // PID should now be a valid running process
      const newPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      expect(newPid).not.toBe(999999999);
      expect(newPid).toBeGreaterThan(0);
    }, 90_000);
  });

  // =============================================================================
  // D. Event & Rule Configuration
  // =============================================================================

  describe('D. Event & rule configuration', () => {
    let testDir: string;

    afterEach(async () => {
      if (testDir) {
        stopDaemonForce(testDir);
        try {
          await runCli(['daemon', 'stop'], { cwd: testDir, timeout: 10_000 });
        } catch { /* best effort */ }
        cleanupTestDir(testDir);
      }
    });

    it('D1: inline --event flags produce correct subscriptions', async () => {
      testDir = createTestDir();
      testDirs.push(testDir);
      await initWallet(testDir, { timeout: 60_000 });

      const logFile = path.join(testDir, '.sphere-cli', 'daemon.log');

      spawnDaemon(testDir, [
        '--no-nostr',
        '--event', 'transfer:incoming', '--event', 'message:dm',
        '--action', 'auto-receive',
      ]);

      const log = await pollForFile(logFile, { timeout: 60_000, contains: 'Daemon running' });
      expect(log).toContain('Active rules: 1');
      expect(log).toContain('transfer:incoming');
      expect(log).toContain('message:dm');
    }, 90_000);

    it('D2: config file with named rule logs correctly', async () => {
      testDir = createTestDir();
      testDirs.push(testDir);
      await initWallet(testDir, { timeout: 60_000 });

      const configPath = path.join(testDir, 'daemon.json');
      fs.writeFileSync(configPath, JSON.stringify({
        rules: [{
          name: 'my-receive-rule',
          events: ['transfer:incoming'],
          actions: [{ type: 'builtin', action: 'auto-receive' }],
        }],
      }));

      const logFile = path.join(testDir, '.sphere-cli', 'daemon.log');

      spawnDaemon(testDir, ['--no-nostr', '--config', configPath]);

      const log = await pollForFile(logFile, { timeout: 60_000, contains: 'Daemon running' });
      expect(log).toContain('Active rules: 1');
      expect(log).toContain('transfer:incoming');
    }, 90_000);

    it('D3: config with 2 rules for different events', async () => {
      testDir = createTestDir();
      testDirs.push(testDir);
      await initWallet(testDir, { timeout: 60_000 });

      const configPath = path.join(testDir, 'daemon.json');
      fs.writeFileSync(configPath, JSON.stringify({
        rules: [
          {
            name: 'receive-rule',
            events: ['transfer:incoming'],
            actions: [{ type: 'builtin', action: 'auto-receive' }],
          },
          {
            name: 'dm-rule',
            events: ['message:dm'],
            actions: [{ type: 'bash', command: 'echo dm received' }],
          },
        ],
      }));

      const logFile = path.join(testDir, '.sphere-cli', 'daemon.log');

      spawnDaemon(testDir, ['--no-nostr', '--config', configPath]);

      const log = await pollForFile(logFile, { timeout: 60_000, contains: 'Daemon running' });
      expect(log).toContain('Active rules: 2');
      expect(log).toContain('transfer:incoming');
      expect(log).toContain('message:dm');
    }, 90_000);

    it('D4: config with 1 active + 1 disabled rule', async () => {
      testDir = createTestDir();
      testDirs.push(testDir);
      await initWallet(testDir, { timeout: 60_000 });

      const configPath = path.join(testDir, 'daemon.json');
      fs.writeFileSync(configPath, JSON.stringify({
        rules: [
          {
            name: 'active-rule',
            events: ['transfer:incoming'],
            actions: [{ type: 'builtin', action: 'auto-receive' }],
          },
          {
            name: 'disabled-rule',
            events: ['message:dm'],
            actions: [{ type: 'bash', command: 'echo disabled' }],
            disabled: true,
          },
        ],
      }));

      const logFile = path.join(testDir, '.sphere-cli', 'daemon.log');

      spawnDaemon(testDir, ['--no-nostr', '--config', configPath]);

      const log = await pollForFile(logFile, { timeout: 60_000, contains: 'Daemon running' });
      expect(log).toContain('Active rules: 1');
      expect(log).toContain('transfer:incoming');
      // The disabled rule's event should NOT appear in subscribed events line
      const subscribedLine = log.split('\n').find(l => l.includes('Subscribed events:'));
      expect(subscribedLine).toBeDefined();
      expect(subscribedLine).not.toContain('message:dm');
    }, 90_000);

    it('D5: wildcard "transfer:*" expands to all transfer events', async () => {
      testDir = createTestDir();
      testDirs.push(testDir);
      await initWallet(testDir, { timeout: 60_000 });

      const logFile = path.join(testDir, '.sphere-cli', 'daemon.log');

      spawnDaemon(testDir, [
        '--no-nostr', '--event', 'transfer:*', '--action', 'auto-receive',
      ]);

      const log = await pollForFile(logFile, { timeout: 60_000, contains: 'Daemon running' });
      expect(log).toContain('transfer:incoming');
      expect(log).toContain('transfer:confirmed');
      expect(log).toContain('transfer:failed');
    }, 90_000);

    it('D6: wildcard "*" expands to many known events', async () => {
      testDir = createTestDir();
      testDirs.push(testDir);
      await initWallet(testDir, { timeout: 60_000 });

      const logFile = path.join(testDir, '.sphere-cli', 'daemon.log');

      spawnDaemon(testDir, [
        '--no-nostr', '--event', '*', '--action', 'auto-receive',
      ]);

      const log = await pollForFile(logFile, { timeout: 60_000, contains: 'Daemon running' });
      // Spot-check several known events
      expect(log).toContain('transfer:incoming');
      expect(log).toContain('message:dm');
      expect(log).toContain('connection:changed');
      expect(log).toContain('nametag:registered');
      expect(log).toContain('sync:completed');
      // market:feed is in ALL_SPHERE_EVENTS so * should enable market feed
      expect(log).toContain('Market feed: enabled');
    }, 90_000);
  });

  // =============================================================================
  // E. Log & PID Options
  // =============================================================================

  describe('E. Log & PID options', () => {
    let testDir: string;

    afterEach(async () => {
      if (testDir) {
        stopDaemonForce(testDir);
        stopDaemonForce(testDir, path.join(testDir, 'custom.pid'));
        try {
          await runCli(['daemon', 'stop'], { cwd: testDir, timeout: 10_000 });
        } catch { /* best effort */ }
        cleanupTestDir(testDir);
      }
    });

    it('E1: --log sets custom log file path', async () => {
      testDir = createTestDir();
      testDirs.push(testDir);
      await initWallet(testDir, { timeout: 60_000 });

      const customLog = path.join(testDir, 'custom.log');

      spawnDaemon(testDir, [
        '--no-nostr', '--log', customLog,
        '--event', 'transfer:incoming', '--action', 'auto-receive',
      ]);

      const log = await pollForFile(customLog, { timeout: 60_000, contains: 'Daemon running' });
      expect(log).toContain('Daemon running');
    }, 90_000);

    it('E2: --pid sets custom PID file path', async () => {
      testDir = createTestDir();
      testDirs.push(testDir);
      await initWallet(testDir, { timeout: 60_000 });

      const customPid = path.join(testDir, 'custom.pid');

      spawnDaemon(testDir, [
        '--no-nostr', '--pid', customPid,
        '--event', 'transfer:incoming', '--action', 'auto-receive',
      ]);

      await pollForFile(customPid, { timeout: 15_000 });
      const pid = parseInt(fs.readFileSync(customPid, 'utf8').trim(), 10);
      expect(pid).toBeGreaterThan(0);

      // Stop using custom PID path
      const stop = await runCli(
        ['daemon', 'stop', '--pid', customPid],
        { cwd: testDir, timeout: 15_000 },
      );
      expect(stop.stdout).toMatch(/Daemon stopped|Daemon killed/);
    }, 90_000);

    it('E3: daemon log contains wallet identity line', async () => {
      testDir = createTestDir();
      testDirs.push(testDir);
      await initWallet(testDir, { timeout: 60_000 });

      const logFile = path.join(testDir, '.sphere-cli', 'daemon.log');

      spawnDaemon(testDir, [
        '--no-nostr', '--event', 'transfer:incoming', '--action', 'auto-receive',
      ]);

      const log = await pollForFile(logFile, { timeout: 60_000, contains: 'Daemon running' });
      expect(log).toContain('Wallet:');
    }, 90_000);

    it('E4: multiple --event + multiple --action flags produce single rule', async () => {
      testDir = createTestDir();
      testDirs.push(testDir);
      await initWallet(testDir, { timeout: 60_000 });

      const logFile = path.join(testDir, '.sphere-cli', 'daemon.log');

      spawnDaemon(testDir, [
        '--no-nostr',
        '--event', 'transfer:incoming', '--event', 'message:dm',
        '--action', 'auto-receive', '--action', 'bash:echo test',
      ]);

      const log = await pollForFile(logFile, { timeout: 60_000, contains: 'Daemon running' });
      expect(log).toContain('Active rules: 1');
      expect(log).toContain('transfer:incoming');
      expect(log).toContain('message:dm');
    }, 90_000);
  });

  // =============================================================================
  // F. Real Event Triggers via DM
  // =============================================================================

  describe('F. Real event triggers via DM', () => {
    let testDirA: string;
    let testDirB: string;
    let nametagA: string;
    let nametagB: string;

    beforeAll(async () => {
      const rand = Math.random().toString(36).slice(2, 8);
      nametagA = `daemon-a-${rand}`;
      nametagB = `daemon-b-${rand}`;

      testDirA = createTestDir();
      testDirB = createTestDir();
      testDirs.push(testDirA, testDirB);

      // Init wallets with real Nostr (no --no-nostr)
      const [resA, resB] = await Promise.all([
        initWallet(testDirA, { noNostr: false, nametag: nametagA, timeout: 90_000 }),
        initWallet(testDirB, { noNostr: false, nametag: nametagB, timeout: 90_000 }),
      ]);

      if (resA.exitCode !== 0) throw new Error(`Wallet A init failed: ${resA.stderr}`);
      if (resB.exitCode !== 0) throw new Error(`Wallet B init failed: ${resB.stderr}`);

      // Wait for Nostr relay propagation
      await sleep(5000);
    }, 120_000);

    afterEach(async () => {
      // Stop daemon on A after each test
      stopDaemonForce(testDirA);
      try {
        await runCli(['daemon', 'stop'], { cwd: testDirA, timeout: 10_000 });
      } catch { /* best effort */ }
    });

    afterAll(() => {
      stopDaemonForce(testDirA);
      stopDaemonForce(testDirB);
      cleanupTestDir(testDirA);
      cleanupTestDir(testDirB);
    });

    it('F1: bash action triggered by DM', async () => {
      const markerFile = path.join(testDirA, 'marker-f1.txt');
      const logFile = path.join(testDirA, '.sphere-cli', 'daemon.log');

      // Start daemon on wallet A (with real Nostr)
      spawnDaemon(testDirA, [
        '--event', 'message:dm',
        '--action', `bash:echo $SPHERE_EVENT >> ${markerFile}`,
      ]);
      await pollForFile(logFile, { timeout: 60_000, contains: 'Daemon running' });

      // Send DM from B to A
      const dmResult = await runCli(
        ['dm', `@${nametagA}`, 'Hello from F1 test'],
        { cwd: testDirB, timeout: 30_000 },
      );
      expect(dmResult.exitCode).toBe(0);

      // Wait for the marker file
      const marker = await pollForFile(markerFile, { timeout: 30_000 });
      expect(marker).toContain('message:dm');
    }, 120_000);

    it('F2: log-to-file action triggered by DM', async () => {
      const eventsFile = path.join(testDirA, 'events-f2.jsonl');
      const logFile = path.join(testDirA, '.sphere-cli', 'daemon.log');

      spawnDaemon(testDirA, [
        '--event', 'message:dm',
        '--action', `log:${eventsFile}`,
      ]);
      await pollForFile(logFile, { timeout: 60_000, contains: 'Daemon running' });

      await runCli(
        ['dm', `@${nametagA}`, 'Hello from F2 test'],
        { cwd: testDirB, timeout: 30_000 },
      );

      const content = await pollForFile(eventsFile, { timeout: 30_000, contains: 'message:dm' });
      const firstLine = content.split('\n').find(l => l.trim().length > 0);
      expect(firstLine).toBeDefined();
      const parsed = JSON.parse(firstLine!);
      expect(parsed.event).toBe('message:dm');
    }, 120_000);

    it('F3: bash action receives SPHERE_SENDER and SPHERE_MESSAGE env vars', async () => {
      const markerFile = path.join(testDirA, 'marker-f3.txt');
      const logFile = path.join(testDirA, '.sphere-cli', 'daemon.log');
      const dmText = `hello-f3-${Date.now()}`;

      spawnDaemon(testDirA, [
        '--event', 'message:dm',
        '--action', `bash:echo "$SPHERE_SENDER $SPHERE_MESSAGE" >> ${markerFile}`,
      ]);
      await pollForFile(logFile, { timeout: 60_000, contains: 'Daemon running' });

      await runCli(
        ['dm', `@${nametagA}`, dmText],
        { cwd: testDirB, timeout: 30_000 },
      );

      const marker = await pollForFile(markerFile, { timeout: 30_000, contains: dmText });
      expect(marker).toContain(dmText);
      // Sender should be present (nametag or pubkey)
      expect(marker.trim().length).toBeGreaterThan(dmText.length);
    }, 120_000);

    it('F4: config file with matching filter triggers action', async () => {
      const markerFile = path.join(testDirA, 'marker-f4.txt');
      const configPath = path.join(testDirA, 'daemon-f4.json');
      const logFile = path.join(testDirA, '.sphere-cli', 'daemon.log');

      fs.writeFileSync(configPath, JSON.stringify({
        rules: [{
          name: 'filter-match',
          events: ['message:dm'],
          filter: { senderNametag: nametagB },
          actions: [{ type: 'bash', command: `echo matched >> ${markerFile}` }],
        }],
      }));

      spawnDaemon(testDirA, ['--config', configPath]);
      await pollForFile(logFile, { timeout: 60_000, contains: 'Daemon running' });

      await runCli(
        ['dm', `@${nametagA}`, 'Hello from F4 filter test'],
        { cwd: testDirB, timeout: 30_000 },
      );

      const marker = await pollForFile(markerFile, { timeout: 30_000 });
      expect(marker).toContain('matched');
    }, 120_000);

    it('F5: config file with mismatching filter does NOT trigger action', async () => {
      const markerFile = path.join(testDirA, 'marker-f5.txt');
      const configPath = path.join(testDirA, 'daemon-f5.json');
      const logFile = path.join(testDirA, '.sphere-cli', 'daemon.log');

      fs.writeFileSync(configPath, JSON.stringify({
        rules: [{
          name: 'filter-mismatch',
          events: ['message:dm'],
          filter: { senderNametag: 'wrong-nametag-that-does-not-exist' },
          actions: [{ type: 'bash', command: `echo should-not-appear >> ${markerFile}` }],
        }],
      }));

      spawnDaemon(testDirA, ['--config', configPath]);
      await pollForFile(logFile, { timeout: 60_000, contains: 'Daemon running' });

      await runCli(
        ['dm', `@${nametagA}`, 'Hello from F5 mismatch test'],
        { cwd: testDirB, timeout: 30_000 },
      );

      // Wait a reasonable time and verify the marker file was NOT created
      await sleep(10_000);
      expect(fs.existsSync(markerFile)).toBe(false);
    }, 120_000);
  });

  // =============================================================================
  // G. Market Feed
  // =============================================================================

  describe('G. Market feed', () => {
    let testDir: string;

    afterEach(async () => {
      if (testDir) {
        stopDaemonForce(testDir);
        try {
          await runCli(['daemon', 'stop'], { cwd: testDir, timeout: 10_000 });
        } catch { /* best effort */ }
        cleanupTestDir(testDir);
      }
    });

    it('G1: --market-feed flag logs "Market feed: enabled"', async () => {
      testDir = createTestDir();
      testDirs.push(testDir);
      await initWallet(testDir, { timeout: 60_000 });

      const logFile = path.join(testDir, '.sphere-cli', 'daemon.log');

      spawnDaemon(testDir, [
        '--no-nostr', '--market-feed',
        '--event', 'transfer:incoming', '--action', 'auto-receive',
      ]);

      const log = await pollForFile(logFile, { timeout: 60_000, contains: 'Daemon running' });
      expect(log).toContain('Market feed: enabled');
    }, 90_000);

    it('G2: --event market:feed produces "Market feed: enabled" log', async () => {
      testDir = createTestDir();
      testDirs.push(testDir);
      await initWallet(testDir, { timeout: 60_000 });

      const logFile = path.join(testDir, '.sphere-cli', 'daemon.log');

      spawnDaemon(testDir, [
        '--no-nostr',
        '--event', 'market:feed', '--action', 'bash:echo market event',
      ]);

      const log = await pollForFile(logFile, { timeout: 60_000, contains: 'Daemon running' });
      expect(log).toContain('Market feed: enabled');
    }, 90_000);

    it('G3: wildcard "*" includes market:feed (Market feed: enabled)', async () => {
      testDir = createTestDir();
      testDirs.push(testDir);
      await initWallet(testDir, { timeout: 60_000 });

      const logFile = path.join(testDir, '.sphere-cli', 'daemon.log');

      spawnDaemon(testDir, [
        '--no-nostr', '--event', '*', '--action', 'auto-receive',
      ]);

      const log = await pollForFile(logFile, { timeout: 60_000, contains: 'Daemon running' });
      expect(log).toContain('Market feed: enabled');
    }, 90_000);

    it('G4: wildcard "market:*" expands to include market:feed', async () => {
      testDir = createTestDir();
      testDirs.push(testDir);
      await initWallet(testDir, { timeout: 60_000 });

      const logFile = path.join(testDir, '.sphere-cli', 'daemon.log');

      spawnDaemon(testDir, [
        '--no-nostr', '--event', 'market:*', '--action', 'bash:echo market',
      ]);

      const log = await pollForFile(logFile, { timeout: 60_000, contains: 'Daemon running' });
      expect(log).toContain('Market feed: enabled');
    }, 90_000);

    it('G5: config with marketFeed: true logs "Market feed: enabled"', async () => {
      testDir = createTestDir();
      testDirs.push(testDir);
      await initWallet(testDir, { timeout: 60_000 });

      const configPath = path.join(testDir, 'market-config.json');
      fs.writeFileSync(configPath, JSON.stringify({
        marketFeed: true,
        rules: [{
          events: ['transfer:incoming'],
          actions: [{ type: 'builtin', action: 'auto-receive' }],
        }],
      }));

      const logFile = path.join(testDir, '.sphere-cli', 'daemon.log');

      spawnDaemon(testDir, ['--no-nostr', '--config', configPath]);

      const log = await pollForFile(logFile, { timeout: 60_000, contains: 'Daemon running' });
      expect(log).toContain('Market feed: enabled');
    }, 90_000);
  });
});
