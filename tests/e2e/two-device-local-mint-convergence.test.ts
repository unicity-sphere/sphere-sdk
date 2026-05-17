/**
 * E2E: Two-Device Local-Mint Convergence (no Nostr, no faucet).
 *
 * Proves that two Sphere instances of the SAME wallet, each minting
 * distinct test tokens against the live aggregator while running on
 * no-op transports (Nostr disabled on both sides), converge to the
 * same JOINT token set after `sync()`.
 *
 * Why this test (vs. `profile-multi-device-sync.test.ts`):
 *
 *   - `profile-multi-device-sync` proves COLD-START recovery: Device A
 *     receives tokens via faucet (which delivers over Nostr), Device A
 *     destroys; Device B imports fresh and recovers tokens via the
 *     aggregator-pointer + IPFS-CAR path. Only Device B runs with
 *     `createNoopTransport()`. Token origination still uses Nostr.
 *
 *   - THIS test proves CONCURRENT publishing + JOIN convergence with
 *     ZERO Nostr involvement on EITHER device. Each device mints its
 *     own tokens locally via the state-transition-sdk's
 *     `submitMintCommitment` path against the aggregator. The §9.2
 *     conflict path between two simultaneously-publishing devices is
 *     exercised end-to-end against real infrastructure.
 *
 * Why TWO PROCESSES: Sphere is a process-singleton — the second call
 * to `Sphere.import` in the same process invokes `Sphere.clear()`
 * which destroys the previous `Sphere.instance`. We need two Sphere
 * instances active simultaneously, so each runs in its own forked
 * Node.js process (worker pattern mirrors
 * `profile-live-concurrent-sync.test.ts`).
 *
 * Test scenario:
 *
 *   1. Spawn worker A → init (autoGenerate). Capture mnemonic + identity.
 *   2. Spawn worker B → init with that mnemonic (no-op transport).
 *   3. Worker A mints two test tokens via the aggregator
 *      (no faucet, no DM); calls `sphere.payments.addToken(...)`.
 *   4. Worker B independently mints two DIFFERENT test tokens.
 *   5. Both workers call `sphere.payments.sync()` concurrently —
 *      this triggers a CAR pin + pointer publish; one publisher
 *      hits §9.2 CONFLICT, fetchAndJoin's the other's CAR.
 *   6. Poll each worker's `getTokenIds` until both report the
 *      JOINT 4-token set.
 *
 * Real infrastructure exercised:
 *   - Live Unicity aggregator (mint commitments + inclusion proofs)
 *   - Live Unicity IPFS gateways (CAR pin + fetch)
 *   - Aggregator-pointer publish/recover (§9.2 conflict resolution
 *     between two simultaneously-publishing devices)
 *
 * Run with: `npm run test:e2e`.
 *
 * Auto-skipped via `preflightSkip(['aggregator', 'ipfs'])` when infra
 * is unavailable.
 */

import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preflightSkip } from './lib/preflight';
import type {
  MintWorkerInitConfig,
  MintWorkerRequest,
  MintWorkerResponse,
} from './lib/two-device-mint-worker';

const SKIP_INFRA = preflightSkip(
  ['aggregator', 'ipfs'],
  'two-device-local-mint-convergence',
);

// Per-test budget. Two real-aggregator mints per device (4 total) plus
// CAR pin + pointer publish + §9.2 conflict resolution + IPFS CAR fetch.
const TEST_BUDGET_MS = 360_000;

// Aggregator-pointer periodic poll is [30s, 90s); allow slack for IPFS
// gateway propagation.
const CONVERGENCE_TIMEOUT_MS = 180_000;
const CONVERGENCE_POLL_INTERVAL_MS = 5_000;

// Per-IPC-call timeout buckets.
const INIT_TIMEOUT_MS = 90_000;
const MINT_TIMEOUT_MS = 60_000;
const SYNC_TIMEOUT_MS = 90_000;
const SHORT_TIMEOUT_MS = 15_000;
const DESTROY_TIMEOUT_MS = 60_000;

// Test coin hex — distinct from real testnet coin IDs so faucet
// balances on a shared wallet (if any) don't pollute the assertions.
const TEST_COIN_HEX = 'aabbccdd';

// ---------------------------------------------------------------------------
// Worker harness — mirrors profile-live-concurrent-sync's WorkerHandle
// but typed for `MintWorkerRequest`/`MintWorkerResponse`.
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(HERE, 'lib', 'two-device-mint-worker.ts');

interface PendingRequest {
  resolve: (msg: MintWorkerResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

class WorkerHandle {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, PendingRequest>();
  private exited = false;
  private exitError: Error | null = null;
  private nextId = 0;

  constructor(label: string) {
    this.child = spawn(
      process.execPath,
      ['--import', 'tsx/esm', WORKER_PATH],
      {
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env: { ...process.env, WORKER_LABEL: label },
      },
    );
    this.child.on('message', (raw) => this.onMessage(raw as MintWorkerResponse));
    this.child.on('exit', (code, signal) => {
      this.exited = true;
      this.exitError = new Error(
        `worker[${label}] exited prematurely (code=${code}, signal=${signal})`,
      );
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(this.exitError);
      }
      this.pending.clear();
    });
  }

  private onMessage(msg: MintWorkerResponse): void {
    if (msg.type === 'log') {
      console.log(msg.message);
      return;
    }
    const pending = this.pending.get(msg.requestId);
    if (!pending) return;
    this.pending.delete(msg.requestId);
    clearTimeout(pending.timer);
    pending.resolve(msg);
  }

  request(
    cmd: Omit<MintWorkerRequest, 'requestId'>,
    timeoutMs: number,
  ): Promise<MintWorkerResponse> {
    if (this.exited) {
      return Promise.reject(this.exitError ?? new Error('worker already exited'));
    }
    const requestId = `r${this.nextId++}`;
    const wrapped = { ...cmd, requestId } as MintWorkerRequest;
    return new Promise<MintWorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(
          `worker request timeout after ${timeoutMs}ms (cmd=${cmd.type})`,
        ));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      if (!this.child.send(wrapped)) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(new Error(`worker.send() returned false (cmd=${cmd.type})`));
      }
    });
  }

  async destroy(timeoutMs = DESTROY_TIMEOUT_MS): Promise<void> {
    if (this.exited) return;
    try {
      await this.request({ type: 'destroy' }, timeoutMs);
    } catch {
      /* worker may already be gone */
    }
    if (!this.exited && !this.child.killed) {
      this.child.kill('SIGTERM');
      await new Promise<void>((r) => {
        const t = setTimeout(() => {
          this.child.kill('SIGKILL');
          r();
        }, 5_000);
        this.child.once('exit', () => {
          clearTimeout(t);
          r();
        });
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Strongly-typed helpers on top of `WorkerHandle.request`
// ---------------------------------------------------------------------------

async function workerInit(
  worker: WorkerHandle,
  config: MintWorkerInitConfig,
): Promise<Extract<MintWorkerResponse, { type: 'init_ok' }>> {
  const reply = await worker.request({ type: 'init', config }, INIT_TIMEOUT_MS);
  if (reply.type === 'error') {
    throw new Error(`worker init failed: ${reply.message}\n${reply.stack ?? ''}`);
  }
  if (reply.type !== 'init_ok') {
    throw new Error(`unexpected worker reply: ${reply.type}`);
  }
  return reply;
}

async function workerMint(
  worker: WorkerHandle,
  coinIdHex: string,
  amount: bigint,
): Promise<string> {
  const reply = await worker.request(
    { type: 'mint', coinIdHex, amountStr: amount.toString() },
    MINT_TIMEOUT_MS,
  );
  if (reply.type === 'error') {
    throw new Error(`worker mint failed: ${reply.message}\n${reply.stack ?? ''}`);
  }
  if (reply.type !== 'mint_ok') {
    throw new Error(`unexpected worker reply: ${reply.type}`);
  }
  return reply.tokenIdHex;
}

async function workerSync(
  worker: WorkerHandle,
): Promise<{ added: number; removed: number }> {
  const reply = await worker.request({ type: 'sync' }, SYNC_TIMEOUT_MS);
  if (reply.type === 'error') {
    throw new Error(`worker sync failed: ${reply.message}\n${reply.stack ?? ''}`);
  }
  if (reply.type !== 'sync_ok') {
    throw new Error(`unexpected worker reply: ${reply.type}`);
  }
  return { added: reply.added, removed: reply.removed };
}

async function workerTokenIds(worker: WorkerHandle): Promise<Set<string>> {
  const reply = await worker.request({ type: 'getTokenIds' }, SHORT_TIMEOUT_MS);
  if (reply.type === 'error') {
    throw new Error(`worker getTokenIds failed: ${reply.message}\n${reply.stack ?? ''}`);
  }
  if (reply.type !== 'tokens_ok') {
    throw new Error(`unexpected worker reply: ${reply.type}`);
  }
  return new Set(reply.tokenIds);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Workers tear down a real Sphere — IPFS pin flushes + OrbitDB close
// + IPC channel teardown take far longer than vitest's default 10s
// hook timeout. Match the request-side DESTROY_TIMEOUT_MS plus slack.
const HOOK_TIMEOUT_MS = 120_000;

describe.skipIf(SKIP_INFRA)('Two-Device Local-Mint Convergence E2E', () => {
  const workers: WorkerHandle[] = [];

  afterEach(async () => {
    while (workers.length > 0) {
      const w = workers.shift()!;
      try {
        await w.destroy();
      } catch {
        /* cleanup */
      }
    }
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    // Defensive cleanup if afterEach somehow missed any.
    while (workers.length > 0) {
      const w = workers.shift()!;
      try {
        await w.destroy();
      } catch {
        /* cleanup */
      }
    }
  }, HOOK_TIMEOUT_MS);

  it(
    'both devices converge to the joint token set after concurrent local-mint + sync',
    async () => {
      // ─── Spawn Device A and bootstrap with autoGenerate ───
      console.log('\n[A] spawning worker...');
      const workerA = new WorkerHandle('A');
      workers.push(workerA);

      const initA = await workerInit(workerA, { label: 'A' });
      console.log(`[A] initialized: ${initA.l1Address}`);
      const mnemonic = initA.mnemonic;
      expect(mnemonic).toBeTruthy();

      // ─── Spawn Device B with the SAME mnemonic ───
      console.log('[B] spawning worker (same mnemonic)...');
      const workerB = new WorkerHandle('B');
      workers.push(workerB);

      const initB = await workerInit(workerB, { label: 'B', mnemonic });
      console.log(`[B] initialized: ${initB.l1Address}`);

      // Sanity: both devices share identity.
      expect(initA.l1Address).toBe(initB.l1Address);
      expect(initA.chainPubkey).toBe(initB.chainPubkey);

      // ─── Round 1: each device mints + syncs concurrently ───
      // This exercises the §9.2 conflict path on the SECOND publisher:
      // whoever publishes first wins v=N; the loser hits CONFLICT,
      // runs fetchAndJoin (records winner's bundle ref), and publishes
      // at v=N+1. So the second publisher always converges via §9.2.
      console.log('[A] minting T_A1, T_A2 via aggregator...');
      const tokenA1 = await workerMint(workerA, TEST_COIN_HEX, 1_000_000n);
      const tokenA2 = await workerMint(workerA, TEST_COIN_HEX, 500_000n);
      console.log(`[A] minted A1=${tokenA1.slice(0, 12)}... A2=${tokenA2.slice(0, 12)}...`);

      console.log('[B] minting T_B1, T_B2 via aggregator...');
      const tokenB1 = await workerMint(workerB, TEST_COIN_HEX, 2_000_000n);
      const tokenB2 = await workerMint(workerB, TEST_COIN_HEX, 750_000n);
      console.log(`[B] minted B1=${tokenB1.slice(0, 12)}... B2=${tokenB2.slice(0, 12)}...`);

      // Pre-sync sanity: each device sees ONLY its own mints.
      const phase1Expected = new Set([tokenA1, tokenA2, tokenB1, tokenB2]);
      const preSyncA = await workerTokenIds(workerA);
      const preSyncB = await workerTokenIds(workerB);
      expect(intersect(preSyncA, phase1Expected)).toEqual(new Set([tokenA1, tokenA2]));
      expect(intersect(preSyncB, phase1Expected)).toEqual(new Set([tokenB1, tokenB2]));

      console.log('[sync-1] both workers syncing concurrently (§9.2 path)...');
      const [sync1A, sync1B] = await Promise.all([
        workerSync(workerA),
        workerSync(workerB),
      ]);
      console.log(`[A] sync-1: added=${sync1A.added}, removed=${sync1A.removed}`);
      console.log(`[B] sync-1: added=${sync1B.added}, removed=${sync1B.removed}`);

      // ─── Round 2: each device mints ONE MORE token + syncs ───
      // The "earlier" publisher from round 1 (whose pointer is no
      // longer the aggregator's latest) needs a fresh publish to
      // re-engage §9.2 against the other side. Issuing one more mint
      // on each device drives a second publish that hits CONFLICT
      // against the other side's pointer, fetchAndJoins their CAR,
      // and lands the missing bundle ref locally.
      console.log('[A] minting T_A3 (round 2)...');
      const tokenA3 = await workerMint(workerA, TEST_COIN_HEX, 100_000n);
      console.log(`[A] minted A3=${tokenA3.slice(0, 12)}...`);

      console.log('[B] minting T_B3 (round 2)...');
      const tokenB3 = await workerMint(workerB, TEST_COIN_HEX, 250_000n);
      console.log(`[B] minted B3=${tokenB3.slice(0, 12)}...`);

      console.log('[sync-2] both workers syncing concurrently again...');
      const [sync2A, sync2B] = await Promise.all([
        workerSync(workerA),
        workerSync(workerB),
      ]);
      console.log(`[A] sync-2: added=${sync2A.added}, removed=${sync2A.removed}`);
      console.log(`[B] sync-2: added=${sync2B.added}, removed=${sync2B.removed}`);

      const expectedJoint = new Set([
        tokenA1, tokenA2, tokenA3,
        tokenB1, tokenB2, tokenB3,
      ]);

      // ─── Poll for joint convergence ───
      console.log('[verify] polling for joint convergence...');
      const deadline = performance.now() + CONVERGENCE_TIMEOUT_MS;
      let finalA = await workerTokenIds(workerA);
      let finalB = await workerTokenIds(workerB);
      while (performance.now() < deadline) {
        // Each iteration re-syncs both devices — short-circuits the
        // [30s, 90s) periodic pointer poll cadence.
        await Promise.allSettled([workerSync(workerA), workerSync(workerB)]);
        finalA = await workerTokenIds(workerA);
        finalB = await workerTokenIds(workerB);
        const aHasJoint = isSuperset(finalA, expectedJoint);
        const bHasJoint = isSuperset(finalB, expectedJoint);
        const aOwn = intersect(finalA, expectedJoint).size;
        const bOwn = intersect(finalB, expectedJoint).size;
        console.log(
          `  poll: A=${aOwn}/${expectedJoint.size} B=${bOwn}/${expectedJoint.size} ` +
            `(${aHasJoint && bHasJoint ? 'CONVERGED' : 'pending'})`,
        );
        if (aHasJoint && bHasJoint) break;
        await sleep(CONVERGENCE_POLL_INTERVAL_MS);
      }

      const finalAOwn = intersect(finalA, expectedJoint);
      const finalBOwn = intersect(finalB, expectedJoint);
      expect(finalAOwn).toEqual(expectedJoint);
      expect(finalBOwn).toEqual(expectedJoint);
      console.log('[verify] PASSED — both devices see the joint 6-token set');
    },
    TEST_BUDGET_MS,
  );
});

// ---------------------------------------------------------------------------
// Set helpers
// ---------------------------------------------------------------------------

function intersect<T>(a: Set<T>, b: Set<T>): Set<T> {
  const out = new Set<T>();
  for (const v of a) if (b.has(v)) out.add(v);
  return out;
}

function isSuperset<T>(a: Set<T>, b: Set<T>): boolean {
  for (const v of b) if (!a.has(v)) return false;
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
