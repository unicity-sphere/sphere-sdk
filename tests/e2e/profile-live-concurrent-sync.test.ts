/**
 * E2E Test: Profile Concurrent Cross-Device Sync (live two-Sphere)
 *
 * Sibling to `profile-multi-device-sync.test.ts`. Where that file proves
 * COLD-START recovery (Device A publishes, destroys; Device B imports
 * fresh from mnemonic), THIS file proves CONCURRENT cross-device sync —
 * two Sphere instances of the SAME wallet running SIMULTANEOUSLY, each
 * observing the other's state changes through the durable replication
 * paths.
 *
 * IMPORTANT — what this test DOES and does NOT verify:
 *
 *   Cross-device sync in production goes through two complementary paths:
 *     (a) **OrbitDB pubsub** via libp2p gossipsub — peer-to-peer, low-
 *         latency. Requires the two libp2p hosts to actually peer with
 *         each other. In production this happens across separate
 *         processes / devices via `DEFAULT_IPFS_BOOTSTRAP_PEERS`.
 *     (b) **Aggregator pointer + IPFS** — durable centralized anchor.
 *         Each `sync()` flushes a CAR to IPFS and a signed pointer to
 *         the Unicity aggregator; the other device's `sync()` re-reads
 *         the pointer and assembles the new CAR. HTTPS, robust against
 *         libp2p connectivity failures.
 *
 *   We assert the aggregator-pointer path because that's the production
 *   durability guarantee — pubsub is the latency optimization on top.
 *   Test 1 spawns each Sphere in its OWN Node process (forked worker)
 *   so libp2p has the inter-process boundary it expects in production.
 *   Two libp2p hosts inside the SAME Node process do not consistently
 *   establish gossipsub, which is why the in-process variant of this
 *   scenario was unreliable before the multi-process harness landed.
 *
 *   Two scenarios:
 *
 *     Test 1 — CROSS-DEVICE SYNC via aggregator pointer (forked workers):
 *       A on real Nostr; B on no-op transport (no Nostr) so any state
 *       B observes MUST have come through OrbitDB+IPFS. A receives a
 *       faucet token and explicitly flushes (`sync()`). B explicitly
 *       calls `sync()` in a polling loop. Within budget, B's
 *       `getBalance()` reflects the new token — proving the aggregator-
 *       pointer + IPFS-CAR path delivers cross-device sync correctly
 *       while both spheres are alive simultaneously. Each Sphere runs
 *       inside its own Node process via `child_process.spawn` with an
 *       IPC channel; see `lib/profile-sync-worker.ts` for the worker
 *       protocol.
 *
 *     Test 2 — BIDIRECTIONAL CONVERGENCE:
 *       Both A and B on real Nostr. Both receive the same faucet DM and
 *       independently process it (write to their own OrbitDB). After a
 *       settle window with bidirectional `sync()` calls, A.balance ===
 *       B.balance. Proves the CRDT merger converges concurrent writes.
 *
 *       NOTE on test target: passes deterministically on local-infra
 *       (the bundled Docker Nostr relay reliably delivers the same DM
 *       to both A and B). On the public testnet relay, B sometimes
 *       does not receive the DM that A receives — believed to be
 *       relay-side behavior when two simultaneous subscribers share
 *       the same chainPubkey. The SDK + CRDT path itself is correct
 *       (proven on local-infra); the public-testnet variability is
 *       operational, not a code bug. Keep this test in the suite —
 *       it exercises the full path on both targets and surfaces real
 *       network conditions.
 *
 * Real infrastructure:
 *   - Nostr testnet relay (DM delivery + identity binding)
 *   - Unicity IPFS gateways (CAR pin/fetch)
 *   - Aggregator pointer publish/recover
 *   - Real testnet faucet (HTTP endpoint or local-infra DM faucet)
 *
 * Run with: `npm run test:e2e`.
 */

import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sphere } from '../../core/Sphere';
import {
  rand,
  makeTempDirs,
  ensureTrustbase,
  requestFaucet,
  getBalance,
} from './helpers';
import { makeProfileProviders } from './profile-helpers';
import { preflightSkip } from './lib/preflight';
import type {
  ParentRequest,
  WorkerInitConfig,
  WorkerResponse,
} from './lib/profile-sync-worker';

const SKIP_INFRA = preflightSkip(
  ['nostr', 'ipfs', 'faucet', 'aggregator'],
  'profile-live-concurrent-sync',
);

// Per-test budgets — generous because two Sphere instances + libp2p
// peer discovery + OrbitDB replication take real wall-clock time.
const TEST1_BUDGET_MS = 240_000;
const TEST2_BUDGET_MS = 240_000;
// Within each test, how long to poll for the observable state change.
// Cross-device sync deadline: 100s covers the worst-case periodic
// aggregator-pointer poll cycle (max [30s, 90s) randomization + small
// margin). When pubsub between devices fails (which it does in many
// CI / NAT-bound environments), the periodic poll is the safety-net
// channel; 100s guarantees at least one full poll cycle.
const PROPAGATION_TIMEOUT_MS = 100_000;
// Poll every 10s — early-exit on first success. Most tests complete
// well under 100s when pubsub works; the long deadline is just to
// cover the worst case.
const POLL_INTERVAL_MS = 10_000;
// Settle window for Test 2 — give CRDT pubsub time to converge after
// both devices independently write to OrbitDB.
const CONVERGENCE_SETTLE_MS = 30_000;

// Single-coin scenarios (cheaper than 7-coin multi-coin). Mirrors the
// canonical `TEST_COINS[3]` UCT entry from helpers — the local-infra
// faucet recognizes faucetName='unicity'; the public-testnet faucet
// likewise.
//
// Amount note: local-infra clamps a single asset to 10^18 smallest
// units (faucet-handler.ts MAX_PER_ASSET_AMOUNT). UCT has 18 decimals
// so the local faucet delivers exactly 1 UCT regardless of human
// amount. Public testnet has no cap. We assert `>= 10^18` (i.e., at
// least 1 UCT) so the same test passes on both targets.
const TEST_COIN = {
  faucetName: 'unicity',
  symbol: 'UCT',
  amount: 1, // human-readable
  decimals: 18,
};
const FAUCET_AMOUNT_RAW = 1_000_000_000_000_000_000n; // 1 UCT in raw 18-decimal units

// ---------------------------------------------------------------------------
// Fork harness — Test 1 spawns each Sphere in its own Node process so
// libp2p has the inter-process boundary it expects. The worker speaks
// a tiny request/response IPC protocol (see lib/profile-sync-worker.ts).
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(HERE, 'lib', 'profile-sync-worker.ts');

interface PendingRequest {
  resolve: (msg: WorkerResponse) => void;
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
    // Use `spawn` with an explicit `ipc` slot so the child gets a
    // `process.send`/`process.on('message')` channel. We could call
    // `child_process.fork` directly, but `fork` requires a JS module —
    // the worker is TypeScript, so we route through `tsx` via the
    // `--import tsx/esm` Node CLI flag (Node 22+).
    this.child = spawn(
      process.execPath,
      ['--import', 'tsx/esm', WORKER_PATH],
      {
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env: { ...process.env, WORKER_LABEL: label },
      },
    );
    this.child.on('message', (raw) => this.onMessage(raw as WorkerResponse));
    this.child.on('exit', (code, signal) => {
      this.exited = true;
      this.exitError = new Error(
        `worker[${label}] exited prematurely (code=${code}, signal=${signal})`,
      );
      // Reject all pending — parent shouldn't deadlock if the worker
      // crashes mid-flight.
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(this.exitError);
      }
      this.pending.clear();
    });
  }

  private onMessage(msg: WorkerResponse): void {
    if (msg.type === 'log') {
      // Print worker logs into the test stdout so a failure trace shows
      // both A and B's narratives interleaved.
      console.log(msg.message);
      return;
    }
    const pending = this.pending.get(msg.requestId);
    if (!pending) {
      // Late response after timeout — drop quietly.
      return;
    }
    this.pending.delete(msg.requestId);
    clearTimeout(pending.timer);
    pending.resolve(msg);
  }

  request(
    cmd: Omit<ParentRequest, 'requestId'>,
    timeoutMs: number,
  ): Promise<WorkerResponse> {
    if (this.exited) {
      return Promise.reject(this.exitError ?? new Error('worker already exited'));
    }
    const requestId = `r${this.nextId++}`;
    const wrapped = { ...cmd, requestId } as ParentRequest;
    return new Promise<WorkerResponse>((resolve, reject) => {
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

  async destroy(timeoutMs = 60_000): Promise<void> {
    if (this.exited) return;
    try {
      await this.request({ type: 'destroy' }, timeoutMs);
    } catch {
      // Worker may already be gone — fall through to kill.
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

async function workerInit(
  worker: WorkerHandle,
  config: WorkerInitConfig,
  timeoutMs: number,
): Promise<Extract<WorkerResponse, { type: 'init_ok' }>> {
  const reply = await worker.request({ type: 'init', config }, timeoutMs);
  if (reply.type === 'error') {
    throw new Error(`worker init failed: ${reply.message}`);
  }
  if (reply.type !== 'init_ok') {
    throw new Error(`unexpected worker reply: ${reply.type}`);
  }
  return reply;
}

async function workerSync(
  worker: WorkerHandle,
  timeoutMs: number,
): Promise<{ added: number; removed: number }> {
  const reply = await worker.request({ type: 'sync' }, timeoutMs);
  if (reply.type === 'error') throw new Error(`worker sync failed: ${reply.message}`);
  if (reply.type !== 'sync_ok') throw new Error(`unexpected worker reply: ${reply.type}`);
  return { added: reply.added, removed: reply.removed };
}

async function workerReceive(
  worker: WorkerHandle,
  timeoutMs: number,
): Promise<void> {
  const reply = await worker.request({ type: 'receive' }, timeoutMs);
  if (reply.type === 'error') throw new Error(`worker receive failed: ${reply.message}`);
  if (reply.type !== 'receive_ok') throw new Error(`unexpected worker reply: ${reply.type}`);
}

async function workerBalance(
  worker: WorkerHandle,
  symbol: string,
  timeoutMs: number,
): Promise<{ total: bigint; tokens: number }> {
  const reply = await worker.request({ type: 'getBalance', symbol }, timeoutMs);
  if (reply.type === 'error') throw new Error(`worker balance failed: ${reply.message}`);
  if (reply.type !== 'balance_ok') throw new Error(`unexpected worker reply: ${reply.type}`);
  return { total: BigInt(reply.total), tokens: reply.tokens };
}

describe.skipIf(SKIP_INFRA)('Profile Live Concurrent Sync E2E', () => {
  const cleanupDirs: string[] = [];
  // Per-test sphere arrays so the singleton-destroy race between tests
  // doesn't leave a transport in a half-closed state.
  let testSpheres: Sphere[] = [];
  // Workers spawned by Test 1 — torn down in afterEach.
  let testWorkers: WorkerHandle[] = [];

  // Increased hook timeout — destroying two Profile-mode spheres each
  // with pointer-monotonicity assertions, in-flight flushes, OrbitDB
  // shutdown, and IPFS cleanup can take 60s+ combined in real-network
  // conditions because shutdown awaits in-flight flushes (lifecycle-
  // manager.ts:238) and each flush includes an IPFS pin + aggregator
  // submit. Two spheres serially × ~30-45s/flush = 60-90s total. Use
  // a 180s ceiling so legitimate slow teardowns aren't masked as
  // "test failures".
  afterEach(async () => {
    // Destroy spheres + workers in PARALLEL — each subject awaits its
    // own in-flight flush independently; running them serially would
    // multiply the wall-clock wait. Sphere.destroy and worker.destroy
    // both await pending OrbitDB+IPFS shutdown.
    await Promise.all([
      ...testSpheres.map(async (s) => {
        try { await s.destroy(); } catch { /* cleanup */ }
      }),
      ...testWorkers.map(async (w) => {
        try { await w.destroy(); } catch { /* cleanup */ }
      }),
    ]);
    testSpheres = [];
    testWorkers = [];
    // Null the singleton slot — same defensive pattern used in
    // provider-disable-sync.test.ts to keep cross-test state clean
    // when re-using the same local-infra relay/faucet.
    (Sphere as unknown as { instance: null }).instance = null;
    // Brief settle so any transport disconnects and pending writes
    // flush before the next test re-establishes connections.
    await new Promise((r) => setTimeout(r, 1_000));
  }, 180_000);

  afterAll(async () => {
    for (const d of cleanupDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
    cleanupDirs.length = 0;
  });

  // ---------------------------------------------------------------------------
  // Test 1 — LIVE PROPAGATION: A receives, B observes via OrbitDB pubsub
  // ---------------------------------------------------------------------------

  // Multi-process harness: A and B each run in their own forked Node
  // process so libp2p has the inter-process boundary it expects. The
  // single-process variant of this scenario was unreliable because two
  // libp2p hosts in the same Node event loop don't consistently
  // establish gossipsub. With one process per Sphere, OrbitDB's pubsub
  // replication AND the aggregator-pointer fallback both behave the
  // way they do in production. The test asserts on the aggregator-
  // pointer + IPFS CAR path (B has a no-op Nostr) — that's the durable
  // contract; pubsub is a latency optimization on top.
  it(
    'Cross-device sync: A on Nostr receives a token + flushes; B on no-op transport observes via aggregator pointer + IPFS CAR',
    async () => {
      const nametag = `e2e-live1-${rand()}`;
      console.log(`\n[Test 1] Setting up A and B as forked workers @${nametag}...`);

      // IPC budget for `workerSync` — must exceed the inner
      // `awaitNextFlush(120_000)` plus the aggregator-pointer poll
      // round-trip. 180 s gives 60 s headroom after the flush
      // completes for sphere.payments.sync() to run.
      const REQUEST_TIMEOUT_MS = 180_000;
      // Init covers wallet creation + identity binding publish + first
      // OrbitDB connect — slow, especially from cold-start. Allow the
      // full propagation budget so the test doesn't false-alarm on
      // transient testnet relay slowdowns.
      const INIT_TIMEOUT_MS = PROPAGATION_TIMEOUT_MS;

      // Long flush debounce: 5 min. All per-receive `save()` calls
      // coalesce into ONE pendingData; `handleSync`'s post-sync
      // `awaitNextFlush` is the explicit publish trigger. Mirrors
      // PR #201's pattern applied to `profile-multi-device-sync`.
      const FLUSH_DEBOUNCE_MS = 300_000;

      // Fork A first — autoGenerate, real Nostr transport, registers
      // the nametag. A is the source of truth for the shared mnemonic.
      const workerA = new WorkerHandle('A');
      testWorkers.push(workerA);
      console.log('  A: spawning worker (real Nostr, autoGenerate)...');
      const aInit = await workerInit(
        workerA,
        {
          label: 'A',
          nametag,
          useNoopTransport: false,
          flushDebounceMs: FLUSH_DEBOUNCE_MS,
        },
        INIT_TIMEOUT_MS,
      );
      console.log(`  A: identity=${aInit.l1Address}`);

      // Fork B with A's mnemonic, fresh storage dirs, NO-OP transport.
      // The no-op transport guarantees B cannot receive the faucet DM
      // via Nostr — any state change observed on B MUST have come
      // through Profile (OrbitDB+IPFS).
      const workerB = new WorkerHandle('B');
      testWorkers.push(workerB);
      console.log('  B: spawning worker (no-op transport, importing A\'s mnemonic)...');
      const bInit = await workerInit(
        workerB,
        {
          label: 'B',
          mnemonic: aInit.mnemonic,
          useNoopTransport: true,
          flushDebounceMs: FLUSH_DEBOUNCE_MS,
        },
        INIT_TIMEOUT_MS,
      );
      console.log(`  B: identity=${bInit.l1Address}`);
      expect(bInit.l1Address).toBe(aInit.l1Address);

      // Pre-condition: B starts with zero balance (no prior state).
      const preBalanceB = await workerBalance(workerB, TEST_COIN.symbol, REQUEST_TIMEOUT_MS);
      expect(preBalanceB.total).toBe(0n);
      console.log(`  B: pre-faucet balance=${preBalanceB.total} ${TEST_COIN.symbol} (expected 0)`);

      // Trigger faucet drop addressed to the shared nametag. A's Nostr
      // listener picks up the DM; B has no Nostr.
      console.log(`  Faucet: sending ${TEST_COIN.amount} ${TEST_COIN.symbol} to @${nametag}...`);
      const fres = await requestFaucet(nametag, TEST_COIN.faucetName, TEST_COIN.amount);
      expect(fres.success).toBe(true);

      // First, confirm A receives the token (sanity check — Nostr path
      // works). Use a short budget here; the real assertion is on B.
      console.log(`  Waiting for A to receive (${TEST_COIN.symbol})...`);
      const aDeadline = performance.now() + PROPAGATION_TIMEOUT_MS;
      let aBalance = await workerBalance(workerA, TEST_COIN.symbol, REQUEST_TIMEOUT_MS);
      while (aBalance.total < FAUCET_AMOUNT_RAW && performance.now() < aDeadline) {
        try { await workerReceive(workerA, REQUEST_TIMEOUT_MS); } catch { /* best-effort */ }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        aBalance = await workerBalance(workerA, TEST_COIN.symbol, REQUEST_TIMEOUT_MS);
      }
      expect(aBalance.total).toBeGreaterThanOrEqual(FAUCET_AMOUNT_RAW);
      console.log(`  A: received ${aBalance.total} ${TEST_COIN.symbol} (${aBalance.tokens} tokens)`);

      // A: explicit flush so the new token is published to IPFS as a
      // CAR + the signed pointer is written to the aggregator. Without
      // this, A's state lives only locally; B has nothing to pull.
      console.log('  A: flushing to Profile (IPFS CAR + aggregator pointer)...');
      const aSync = await workerSync(workerA, REQUEST_TIMEOUT_MS);
      console.log(`  A: sync done — added=${aSync.added}, removed=${aSync.removed}`);

      // B: poll via explicit sync(), which drives the aggregator-
      // pointer recovery path: re-read pointer → fetch CAR via IPFS →
      // assemble tokens. This proves cross-device sync works while
      // both spheres are alive simultaneously.
      //
      // B's transport is no-op so any token observed MUST have come
      // through Profile (not Nostr DM).
      console.log('  B: polling via aggregator-pointer + IPFS CAR (Profile sync)...');
      const bDeadline = performance.now() + PROPAGATION_TIMEOUT_MS;
      let bBalance = await workerBalance(workerB, TEST_COIN.symbol, REQUEST_TIMEOUT_MS);
      while (bBalance.total < FAUCET_AMOUNT_RAW && performance.now() < bDeadline) {
        try { await workerSync(workerB, REQUEST_TIMEOUT_MS); } catch (err) {
          console.log(`  B: sync() attempt failed: ${err instanceof Error ? err.message : err}`);
        }
        bBalance = await workerBalance(workerB, TEST_COIN.symbol, REQUEST_TIMEOUT_MS);
        if (bBalance.total >= FAUCET_AMOUNT_RAW) break;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }

      console.log(`  B: post-sync balance=${bBalance.total} ${TEST_COIN.symbol} (${bBalance.tokens} tokens)`);
      expect(bBalance.total).toBeGreaterThanOrEqual(FAUCET_AMOUNT_RAW);
      expect(bBalance.tokens).toBeGreaterThanOrEqual(1);
      expect(bBalance.total).toBe(aBalance.total);

      console.log('[Test 1] PASSED: B observed the new token via aggregator pointer + IPFS CAR (cross-device sync working)');
    },
    TEST1_BUDGET_MS,
  );

  // ---------------------------------------------------------------------------
  // Test 2 — BIDIRECTIONAL CONVERGENCE: both online, both write, both converge
  // ---------------------------------------------------------------------------

  it(
    'Bidirectional convergence: A and B both on Nostr, both process the same incoming token, OrbitDB CRDT converges to the same state',
    async () => {
      const nametag = `e2e-live2-${rand()}`;
      console.log(`\n[Test 2] Setting up A and B both on real Nostr @${nametag}...`);

      const dirsA = makeTempDirs('profile-live2-a');
      const dirsB = makeTempDirs('profile-live2-b');
      cleanupDirs.push(dirsA.base, dirsB.base);
      await ensureTrustbase(dirsA.dataDir);
      await ensureTrustbase(dirsB.dataDir);

      const providersA = makeProfileProviders(dirsA);
      const providersB = makeProfileProviders(dirsB);

      console.log('  A: creating wallet with real Nostr...');
      const { sphere: sphereA, generatedMnemonic } = await Sphere.init({
        ...providersA,
        autoGenerate: true,
        nametag,
      });
      testSpheres.push(sphereA);
      const mnemonic = generatedMnemonic!;
      console.log(`  A: identity=${sphereA.identity!.l1Address}`);

      // Sphere singleton dance — see Test 1 for rationale.
      (Sphere as unknown as { instance: null }).instance = null;
      console.log('  B: importing same mnemonic with real Nostr...');
      const sphereB = await Sphere.import({
        storage: providersB.storage,
        tokenStorage: providersB.tokenStorage,
        transport: providersB.transport,
        oracle: providersB.oracle,
        mnemonic,
      });
      testSpheres.push(sphereB);
      console.log(`  B: identity=${sphereB.identity!.l1Address}`);
      expect(sphereB.identity!.l1Address).toBe(sphereA.identity!.l1Address);

      // Both pre-conditions: zero balance.
      expect(getBalance(sphereA, TEST_COIN.symbol).total).toBe(0n);
      expect(getBalance(sphereB, TEST_COIN.symbol).total).toBe(0n);

      console.log(`  Faucet: sending ${TEST_COIN.amount} ${TEST_COIN.symbol} to @${nametag}...`);
      const fres = await requestFaucet(nametag, TEST_COIN.faucetName, TEST_COIN.amount);
      expect(fres.success).toBe(true);

      // Both A and B should receive the DM (both subscribed to the
      // shared chainPubkey on the same relay). Both write to their own
      // OrbitDB; both publish their own pointer. After both flush and
      // mutually pull, they should converge.
      console.log('  Polling A and B for token receipt...');
      const deadline = performance.now() + PROPAGATION_TIMEOUT_MS;
      while (performance.now() < deadline) {
        try { await sphereA.payments.receive(); } catch { /* ignore */ }
        try { await sphereB.payments.receive(); } catch { /* ignore */ }
        const aBal = getBalance(sphereA, TEST_COIN.symbol);
        const bBal = getBalance(sphereB, TEST_COIN.symbol);
        if (aBal.total >= FAUCET_AMOUNT_RAW && bBal.total >= FAUCET_AMOUNT_RAW) {
          break;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }

      const aBal = getBalance(sphereA, TEST_COIN.symbol);
      const bBal = getBalance(sphereB, TEST_COIN.symbol);
      console.log(`  A: ${aBal.total} ${TEST_COIN.symbol} (${aBal.tokens} tokens)`);
      console.log(`  B: ${bBal.total} ${TEST_COIN.symbol} (${bBal.tokens} tokens)`);
      expect(aBal.total).toBeGreaterThanOrEqual(FAUCET_AMOUNT_RAW);
      expect(bBal.total).toBeGreaterThanOrEqual(FAUCET_AMOUNT_RAW);

      // Both flush to their own pointer + CAR. Then both pull the
      // other's state via aggregator-pointer. Two rounds of mutual
      // sync ensures convergence (round 1 publishes both, round 2
      // ensures each has merged the other's view).
      console.log('  Mutual flush + sync (round 1)...');
      await sphereA.payments.sync();
      await sphereB.payments.sync();
      console.log(`  Settle window: ${CONVERGENCE_SETTLE_MS / 1000}s...`);
      await new Promise((r) => setTimeout(r, CONVERGENCE_SETTLE_MS));
      console.log('  Mutual flush + sync (round 2)...');
      await sphereA.payments.sync();
      await sphereB.payments.sync();

      // Convergence assertion: final balances must match.
      const aFinal = getBalance(sphereA, TEST_COIN.symbol);
      const bFinal = getBalance(sphereB, TEST_COIN.symbol);
      console.log(`  A final: ${aFinal.total} ${TEST_COIN.symbol} (${aFinal.tokens} tokens)`);
      console.log(`  B final: ${bFinal.total} ${TEST_COIN.symbol} (${bFinal.tokens} tokens)`);
      expect(aFinal.total).toBe(bFinal.total);
      expect(aFinal.tokens).toBe(bFinal.tokens);

      console.log('[Test 2] PASSED: A and B converged via aggregator pointer + CRDT merge');
    },
    TEST2_BUDGET_MS,
  );
});
