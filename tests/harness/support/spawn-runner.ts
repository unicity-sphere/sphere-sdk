/**
 * tests/harness/support/spawn-runner.ts — spawn the crash-drill wallet runner
 * as a REAL OS process (node --import tsx) and fence on its stdout markers.
 * Timeouts here are failure fences (the suite fails loudly), never pacing.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RUNNER_PATH = fileURLToPath(new URL('./send-runner.ts', import.meta.url));

export interface RunnerHandle {
  readonly child: ChildProcess;
  /** Resolves with the full marker line; rejects on exit/timeout with diagnostics. */
  waitForLine(prefix: string, timeoutMs?: number): Promise<string>;
  /** SIGKILL and wait for the OS to reap the process. */
  kill(): Promise<void>;
  /** Wait for natural exit; rejects on nonzero code. */
  waitForExit(timeoutMs?: number): Promise<void>;
}

export function spawnRunner(phase: 'send' | 'resume', env: Record<string, string>): RunnerHandle {
  const child = spawn(process.execPath, ['--import', 'tsx', RUNNER_PATH, phase], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdoutBuf = '';
  let stderrBuf = '';
  const lines: string[] = [];
  const lineWaiters: { prefix: string; resolve: (line: string) => void }[] = [];
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const exitWaiters: (() => void)[] = [];

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutBuf += chunk;
    for (;;) {
      const nl = stdoutBuf.indexOf('\n');
      if (nl === -1) break;
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      lines.push(line);
      for (let i = lineWaiters.length - 1; i >= 0; i--) {
        if (line.startsWith(lineWaiters[i].prefix)) {
          const [waiter] = lineWaiters.splice(i, 1);
          waiter.resolve(line);
        }
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrBuf += chunk;
  });
  child.on('exit', (code, signal) => {
    exited = { code, signal };
    while (exitWaiters.length) exitWaiters.pop()?.();
  });

  const diagnostics = (): string =>
    `runner[${phase}] exit=${JSON.stringify(exited)}\n--- stdout ---\n${lines.join('\n')}\n--- stderr ---\n${stderrBuf}`;

  return {
    child,
    waitForLine(prefix: string, timeoutMs = 90_000): Promise<string> {
      const existing = lines.find((l) => l.startsWith(prefix));
      if (existing) return Promise.resolve(existing);
      if (exited) return Promise.reject(new Error(`runner exited before "${prefix}"\n${diagnostics()}`));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`timed out waiting for "${prefix}"\n${diagnostics()}`));
        }, timeoutMs);
        lineWaiters.push({
          prefix,
          resolve: (line) => {
            clearTimeout(timer);
            resolve(line);
          },
        });
        exitWaiters.push(() => {
          clearTimeout(timer);
          reject(new Error(`runner exited before "${prefix}"\n${diagnostics()}`));
        });
      });
    },
    kill(): Promise<void> {
      if (exited) return Promise.resolve();
      return new Promise((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGKILL');
      });
    },
    waitForExit(timeoutMs = 120_000): Promise<void> {
      const check = (): void => {
        if (exited && exited.code !== 0) {
          throw new Error(`runner exited with code ${String(exited.code)}\n${diagnostics()}`);
        }
      };
      if (exited) {
        check();
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`timed out waiting for runner exit\n${diagnostics()}`));
        }, timeoutMs);
        exitWaiters.push(() => {
          clearTimeout(timer);
          try {
            check();
            resolve();
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      });
    },
  };
}
