/**
 * Issue #336 — PID-liveness probe for stale CLI locks.
 *
 * Background: FILE_LOCK_STALE_MS (~920s) is calibrated for the worst-case
 * browser publishOnce hold time, but CLI processes spawn-publish-exit in
 * seconds. When a CLI crashes (SIGKILL, OOM, soak teardown) before
 * releasing its proper-lockfile marker, the next CLI invocation has to
 * wait ~15 minutes for proper-lockfile's mtime-based stale detection,
 * but the 30s mutex-acquire timeout trips first, surfacing PUBLISH_BUSY
 * even though no process holds the lock.
 *
 * Fix: write a sibling `<lockPath>.owner.json` containing {pid, hostname,
 * acquiredAt} on acquire. Before retrying on ELOCKED, probe the holder:
 * if the hostname matches local AND `process.kill(pid, 0)` reports ESRCH,
 * steal the lock immediately.
 *
 * Safety properties verified here:
 *   (a) live PID lock held → next acquire waits the full timeout (no false-stale)
 *   (b) dead PID lock stolen → next acquire succeeds quickly
 *   (c) cross-host metadata → no PID probe, falls back to timeout path
 *   (d) self-PID metadata → treated as alive (defensive against impossible
 *       same-process steal that would break in-process Mutex)
 *   (e) malformed/missing metadata → treated as alive (conservative)
 *   (f) clean acquire/release writes and removes owner metadata
 *   (g) stolen lock surfaces a warning log for operator visibility
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  createPointerMutex,
  AggregatorPointerErrorCode,
} from '../../../../profile/aggregator-pointer/index.js';

const OWNER_SUFFIX = '.owner.json';

interface LockOwnerMetadata {
  pid: number;
  hostname: string;
  acquiredAt: number;
}

async function writeOwnerFile(lockPath: string, meta: LockOwnerMetadata): Promise<void> {
  await fsp.writeFile(lockPath + OWNER_SUFFIX, JSON.stringify(meta), 'utf8');
}

/**
 * Forge a "stale CLI lock" on disk: create the lockfile placeholder, the
 * proper-lockfile lock dir (`${p}.lock`), and an owner.json claiming the
 * supplied PID/hostname. This is what the filesystem looks like after a
 * CLI process crashed mid-publish without cleaning up.
 */
async function forgeOrphanedLock(
  lockPath: string,
  meta: LockOwnerMetadata,
): Promise<void> {
  // proper-lockfile expects the target file to exist.
  await fsp.writeFile(lockPath, '', { flag: 'a' });
  // The atomic mkdir marker.
  await fsp.mkdir(lockPath + '.lock');
  // Our PID metadata sibling.
  await writeOwnerFile(lockPath, meta);
}

/** Spawn an actually-running child process and return its (live) PID. */
function spawnLiveChild(): { pid: number; kill: () => void } {
  // Sleep-forever child; cheap and portable.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached: false,
  });
  if (typeof child.pid !== 'number') {
    throw new Error('failed to spawn child process for live-PID test');
  }
  return {
    pid: child.pid,
    kill: () => { try { child.kill('SIGKILL'); } catch { /* noop */ } },
  };
}

/**
 * Find an unused PID on the local host. We probe upward from a high base
 * to minimise collisions with normal pid allocation. Returns a PID that
 * `process.kill(pid, 0)` confirms ESRCH (does not exist).
 */
function findDeadPid(): number {
  // Try a few candidates. On Linux the default pid_max is 32768 or 4 million;
  // pids near 2^30 are virtually never allocated. We still verify ESRCH.
  const candidates = [999_999, 999_998, 999_997, 888_888, 777_777, 666_666];
  for (const pid of candidates) {
    try {
      process.kill(pid, 0);
      // alive → skip
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
        return pid;
      }
      // EPERM means "exists but not ours" → skip
    }
  }
  throw new Error('could not find an unused PID for dead-PID test');
}

describe('NodeMutex PID-liveness probe (issue #336)', () => {
  let tmpDir: string;
  let lockFile: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pointer-mutex-pid-probe-'));
    lockFile = path.join(tmpDir, 'publish.lock');
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  // ── (a) live PID → no steal ──────────────────────────────────────────────

  it('does NOT steal a lock held by a still-alive local PID — short acquire times out', async () => {
    const child = spawnLiveChild();
    try {
      await forgeOrphanedLock(lockFile, {
        pid: child.pid,
        hostname: os.hostname(),
        acquiredAt: Date.now(),
      });

      const mutex = createPointerMutex('pid-probe-test', { lockFilePath: lockFile });

      // Short timeout: if the steal logic were buggy and stole a live lock,
      // this acquire would succeed quickly. Instead, it MUST surface
      // PUBLISH_BUSY because the holder is alive.
      const start = Date.now();
      await expect(mutex.acquire({ timeoutMs: 800 })).rejects.toMatchObject({
        code: AggregatorPointerErrorCode.PUBLISH_BUSY,
      });
      const elapsed = Date.now() - start;
      // Should consume ~most of the timeout, not finish near-instantly.
      expect(elapsed).toBeGreaterThanOrEqual(700);

      // Owner metadata still references the live child.
      const stillThere = await fsp.readFile(lockFile + OWNER_SUFFIX, 'utf8');
      expect(JSON.parse(stillThere).pid).toBe(child.pid);
    } finally {
      child.kill();
    }
  }, 15_000);

  // ── (b) dead PID → steal + immediate success ─────────────────────────────

  it('steals a lock held by a dead local PID and acquires within <2s', async () => {
    const deadPid = findDeadPid();
    await forgeOrphanedLock(lockFile, {
      pid: deadPid,
      hostname: os.hostname(),
      acquiredAt: Date.now() - 60_000,
    });

    const mutex = createPointerMutex('pid-probe-test', { lockFilePath: lockFile });

    const start = Date.now();
    // 5s budget is generous — the steal should land in well under a second,
    // far below FILE_LOCK_STALE_MS (~920s).
    const handle = await mutex.acquire({ timeoutMs: 5_000 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2_000);

    // After the steal, our acquire wrote NEW metadata identifying us.
    const newMetaRaw = await fsp.readFile(lockFile + OWNER_SUFFIX, 'utf8');
    const newMeta = JSON.parse(newMetaRaw) as LockOwnerMetadata;
    expect(newMeta.pid).toBe(process.pid);
    expect(newMeta.hostname).toBe(os.hostname());

    await handle.release();

    // Release removed the owner metadata.
    expect(fs.existsSync(lockFile + OWNER_SUFFIX)).toBe(false);

    // Operator visibility: a warning was logged with the stolen PID.
    expect(warnSpy).toHaveBeenCalled();
    const warnText = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(warnText).toMatch(/stole lock/);
    expect(warnText).toMatch(new RegExp(`pid=${deadPid}\\b`));
    expect(warnText).toMatch(/#336/);
  }, 15_000);

  // ── (c) cross-host metadata → skip probe, fall back to timeout ───────────

  it('does NOT steal a lock with cross-host metadata (PID probing across hosts is meaningless)', async () => {
    // Use a PID that IS dead locally — but mark it as held by a different
    // host. The probe MUST short-circuit "alive" rather than steal based on
    // the local PID check, because pid N on host A != pid N on host B.
    const deadPidLocally = findDeadPid();
    await forgeOrphanedLock(lockFile, {
      pid: deadPidLocally,
      hostname: 'some-other-host-' + Math.random().toString(36).slice(2),
      acquiredAt: Date.now(),
    });

    const mutex = createPointerMutex('pid-probe-test', { lockFilePath: lockFile });

    const start = Date.now();
    await expect(mutex.acquire({ timeoutMs: 800 })).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.PUBLISH_BUSY,
    });
    expect(Date.now() - start).toBeGreaterThanOrEqual(700);

    // Cross-host metadata was preserved (not overwritten).
    const stillThere = JSON.parse(await fsp.readFile(lockFile + OWNER_SUFFIX, 'utf8'));
    expect(stillThere.pid).toBe(deadPidLocally);
    expect(stillThere.hostname).not.toBe(os.hostname());
  }, 10_000);

  // ── (d) self-PID → never stolen (defensive) ──────────────────────────────

  it('treats a lock claiming our own PID as alive (never false-positives self-steal)', async () => {
    await forgeOrphanedLock(lockFile, {
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: Date.now(),
    });

    const mutex = createPointerMutex('pid-probe-test', { lockFilePath: lockFile });

    // Even though the owner metadata claims our own PID (which is by
    // definition alive), the probe must short-circuit and NOT attempt a
    // process.kill that succeeds. Acquire must time out cleanly.
    const start = Date.now();
    await expect(mutex.acquire({ timeoutMs: 800 })).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.PUBLISH_BUSY,
    });
    expect(Date.now() - start).toBeGreaterThanOrEqual(700);

    const stillThere = JSON.parse(await fsp.readFile(lockFile + OWNER_SUFFIX, 'utf8'));
    expect(stillThere.pid).toBe(process.pid);
  }, 10_000);

  // ── (e) missing / malformed metadata → conservative ──────────────────────

  it('does NOT steal a lock with missing owner metadata (conservative)', async () => {
    // Lock dir present but NO owner.json — pre-fix locks won't have it.
    await fsp.writeFile(lockFile, '', { flag: 'a' });
    await fsp.mkdir(lockFile + '.lock');

    const mutex = createPointerMutex('pid-probe-test', { lockFilePath: lockFile });

    const start = Date.now();
    await expect(mutex.acquire({ timeoutMs: 800 })).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.PUBLISH_BUSY,
    });
    expect(Date.now() - start).toBeGreaterThanOrEqual(700);
  }, 10_000);

  it('does NOT steal a lock with malformed owner metadata (conservative)', async () => {
    await fsp.writeFile(lockFile, '', { flag: 'a' });
    await fsp.mkdir(lockFile + '.lock');
    await fsp.writeFile(lockFile + OWNER_SUFFIX, 'this is not json', 'utf8');

    const mutex = createPointerMutex('pid-probe-test', { lockFilePath: lockFile });

    const start = Date.now();
    await expect(mutex.acquire({ timeoutMs: 800 })).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.PUBLISH_BUSY,
    });
    expect(Date.now() - start).toBeGreaterThanOrEqual(700);
  }, 10_000);

  // ── (f) clean acquire writes & release removes the metadata ──────────────

  it('writes owner metadata on acquire and removes it on release', async () => {
    const mutex = createPointerMutex('pid-probe-test', { lockFilePath: lockFile });
    const handle = await mutex.acquire({ timeoutMs: 5_000 });

    const meta = JSON.parse(
      await fsp.readFile(lockFile + OWNER_SUFFIX, 'utf8'),
    ) as LockOwnerMetadata;
    expect(meta.pid).toBe(process.pid);
    expect(meta.hostname).toBe(os.hostname());
    expect(meta.acquiredAt).toBeGreaterThan(0);
    expect(meta.acquiredAt).toBeLessThanOrEqual(Date.now());

    await handle.release();

    expect(fs.existsSync(lockFile + OWNER_SUFFIX)).toBe(false);
    // proper-lockfile also removed the lock dir.
    expect(fs.existsSync(lockFile + '.lock')).toBe(false);
  }, 10_000);
});
