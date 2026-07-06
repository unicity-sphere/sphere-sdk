/**
 * Worker entry point for `profile-live-concurrent-sync.test.ts` Test 1.
 *
 * Runs in a forked Node.js process (one per Sphere instance) so that
 * each Sphere's libp2p host lives in its own process. The single-process
 * variant of the test (sibling Test 2 in the same file uses real Nostr
 * for both spheres + a CRDT settle window — different mechanism) skipped
 * Test 1 because two libp2p hosts inside the same Node process do not
 * consistently establish gossipsub. With a fork-per-sphere harness the
 * libp2p layer behaves the way it does in production (separate
 * processes, separate event loops), and the aggregator-pointer + IPFS
 * CAR cross-device path can be exercised honestly.
 *
 * The worker speaks a tiny request/response IPC protocol with the
 * parent test:
 *
 *   parent → worker:
 *     { type: 'init', requestId, config }
 *     { type: 'receive', requestId }
 *     { type: 'sync', requestId }
 *     { type: 'getBalance', requestId, symbol }
 *     { type: 'destroy', requestId }
 *
 *   worker → parent:
 *     { type: 'init_ok', requestId, mnemonic, l1Address, ... }
 *     { type: 'receive_ok', requestId }
 *     { type: 'sync_ok', requestId, added, removed }
 *     { type: 'balance_ok', requestId, confirmed, unconfirmed, total, tokens }
 *     { type: 'destroy_ok', requestId }
 *     { type: 'error', requestId, message }
 *     { type: 'log', message }                 // optional informational
 *
 * `requestId` correlates the response with its initiating request so
 * the parent doesn't have to serialize commands. bigint balances are
 * serialized as decimal strings — `JSON.stringify` rejects bigint.
 *
 * Spawned via `child_process.spawn('node', ['--import', 'tsx/esm',
 * worker.ts], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] })`.
 * The `ipc` slot is what gives us `process.send` / `process.on('message')`
 * inside the worker.
 */

import { rmSync } from 'node:fs';
import { Sphere } from '../../../core/Sphere';
import {
  makeTempDirs,
  ensureTrustbase,
  createNoopTransport,
} from '../helpers';
import { makeProfileProviders } from '../profile-helpers';

// ---------------------------------------------------------------------------
// IPC message types — kept minimal and explicit so the parent test can
// import these for type-safety on its end.
// ---------------------------------------------------------------------------

export type WorkerInitConfig = {
  /** Optional override for the temp-dir label so logs distinguish A vs B. */
  readonly label: string;
  /** When set, import using this mnemonic. When unset, autoGenerate=true. */
  readonly mnemonic?: string;
  /** When supplied, init() registers the nametag (only valid with autoGenerate). */
  readonly nametag?: string;
  /** When true, swap the real Nostr transport for a no-op stub. */
  readonly useNoopTransport: boolean;
  /**
   * Profile flush debounce override. Tests that need deterministic
   * single-shot publishes pass a long debounce (e.g. 300_000) so all
   * `save()` calls during a test phase coalesce into one pendingData;
   * `handleSync()` then drives ONE explicit `awaitNextFlush()` to
   * publish. Mirrors PR #201's pattern for `profile-multi-device-sync`.
   * NOTE: scaffolding parity alone does NOT make this test pass — see
   * the follow-up issues filed in the parent PR for the SDK-level
   * defects (unconfirmed-token-flush regression, missing pointer-
   * version walk-through, OrbitDB OpLog CBOR decode failures).
   */
  readonly flushDebounceMs?: number;
};

export type ParentRequest =
  | { type: 'init'; requestId: string; config: WorkerInitConfig }
  | { type: 'receive'; requestId: string }
  | { type: 'sync'; requestId: string }
  | { type: 'getBalance'; requestId: string; symbol: string }
  | { type: 'destroy'; requestId: string };

export type WorkerResponse =
  | {
      type: 'init_ok';
      requestId: string;
      mnemonic: string;
      l1Address: string;
      chainPubkey: string;
      directAddress: string | undefined;
      nametag: string | undefined;
    }
  | { type: 'receive_ok'; requestId: string }
  | {
      type: 'sync_ok';
      requestId: string;
      added: number;
      removed: number;
    }
  | {
      type: 'balance_ok';
      requestId: string;
      confirmed: string;
      unconfirmed: string;
      total: string;
      tokens: number;
    }
  | { type: 'destroy_ok'; requestId: string }
  | { type: 'error'; requestId: string; message: string; stack?: string }
  | { type: 'log'; message: string };

// ---------------------------------------------------------------------------
// Worker state — single Sphere instance per process.
// ---------------------------------------------------------------------------

let sphere: Sphere | null = null;
let cleanupDir: string | null = null;
let label = 'worker';

function send(msg: WorkerResponse): void {
  if (typeof process.send !== 'function') {
    // No IPC channel attached — running stand-alone. Print to stderr
    // so a developer running the file directly still sees something.
    console.error(`[${label}] ${JSON.stringify(msg)}`);
    return;
  }
  process.send(msg);
}

function log(message: string): void {
  send({ type: 'log', message: `[${label}] ${message}` });
}

async function handleInit(
  requestId: string,
  config: WorkerInitConfig,
): Promise<void> {
  label = config.label;
  log('init: building providers...');

  const dirs = makeTempDirs(`profile-live1-${config.label}`);
  cleanupDir = dirs.base;
  await ensureTrustbase(dirs.dataDir);
  const providers = makeProfileProviders(
    dirs,
    config.flushDebounceMs !== undefined
      ? { flushDebounceMs: config.flushDebounceMs }
      : {},
  );

  if (config.mnemonic) {
    log('init: importing existing mnemonic with no-op transport=' +
      String(config.useNoopTransport));
    sphere = await Sphere.import({
      storage: providers.storage,
      tokenStorage: providers.tokenStorage,
      transport: config.useNoopTransport
        ? createNoopTransport()
        : providers.transport,
      oracle: providers.oracle,
      mnemonic: config.mnemonic,
    });
  } else {
    log('init: creating fresh wallet (autoGenerate)...');
    if (config.useNoopTransport) {
      throw new Error(
        'autoGenerate with useNoopTransport is unsupported — A side ' +
          'must publish identity binding via real transport',
      );
    }
    const result = await Sphere.init({
      ...providers,
      autoGenerate: true,
      nametag: config.nametag,
    });
    sphere = result.sphere;
    if (!result.generatedMnemonic) {
      throw new Error('Sphere.init did not return a generated mnemonic');
    }
    // Stash the mnemonic on the result message so the parent can pass
    // it to the second worker.
    const identity = sphere.identity!;
    send({
      type: 'init_ok',
      requestId,
      mnemonic: result.generatedMnemonic,
      chainPubkey: identity.chainPubkey,
      directAddress: identity.directAddress,
      nametag: identity.nametag,
    });
    return;
  }

  const identity = sphere.identity!;
  send({
    type: 'init_ok',
    requestId,
    mnemonic: config.mnemonic,
    chainPubkey: identity.chainPubkey,
    directAddress: identity.directAddress,
    nametag: identity.nametag,
  });
}

async function handleReceive(requestId: string): Promise<void> {
  if (!sphere) throw new Error('receive: sphere not initialized');
  // receive() may not be supported on the no-op transport — swallow
  // the error rather than crashing the worker. The parent uses the
  // balance check as the source of truth.
  try {
    await sphere.payments.receive();
  } catch (err) {
    log(`receive: best-effort failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  send({ type: 'receive_ok', requestId });
}

async function handleSync(requestId: string): Promise<void> {
  if (!sphere) throw new Error('sync: sphere not initialized');

  // Mirror PR #201's pattern: drive sphere.payments.sync() (which
  // drains pending V5 finalizations) THEN call awaitNextFlush on
  // every TokenStorageProvider that exposes it. The legacy flush
  // path also drives the new lean-snapshot publish via
  // `publishSnapshotIfWired` (flush-scheduler.ts), so awaitNextFlush
  // is the single seam that publishes both the bundle CAR and the
  // pointer.
  //
  // NOTE: with `flushDebounceMs: 300_000` the auto-flush is
  // effectively disabled; the post-sync awaitNextFlush is the ONLY
  // publish path. Under the SDK default 2 s debounce the auto-flush
  // races aggregator-gateway propagation, which is the symptom
  // called out in issue #199's follow-up.
  //
  // This scaffolding parity matches what PR #201 applied to
  // `profile-multi-device-sync.test.ts`. It is NECESSARY but NOT
  // SUFFICIENT to make the test pass — see the follow-up issues
  // referenced in the parent PR.
  const result = await sphere.payments.sync({ drainTimeoutMs: 60_000 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const providers = (sphere.payments as any).getTokenStorageProviders?.()
    ?? new Map<string, { awaitNextFlush?: (ms: number) => Promise<void> }>();
  for (const [pid, provider] of providers as Map<string, { awaitNextFlush?: (ms: number) => Promise<void> }>) {
    if (typeof provider.awaitNextFlush === 'function') {
      try {
        await provider.awaitNextFlush(120_000);
      } catch (err) {
        log(`sync: awaitNextFlush on provider ${pid} failed (best-effort): ${
          err instanceof Error ? err.message : String(err)
        }`);
      }
    }
  }

  send({
    type: 'sync_ok',
    requestId,
    added: result.added,
    removed: result.removed,
  });
}

function handleGetBalance(requestId: string, symbol: string): void {
  if (!sphere) throw new Error('getBalance: sphere not initialized');
  const balances = sphere.payments.getBalance();
  const bal = balances.find((b) => b.symbol === symbol);
  if (!bal) {
    send({
      type: 'balance_ok',
      requestId,
      confirmed: '0',
      unconfirmed: '0',
      total: '0',
      tokens: 0,
    });
    return;
  }
  send({
    type: 'balance_ok',
    requestId,
    confirmed: String(bal.confirmedAmount),
    unconfirmed: String(bal.unconfirmedAmount),
    total: String(bal.totalAmount),
    tokens: bal.tokenCount,
  });
}

async function handleDestroy(requestId: string): Promise<void> {
  if (sphere) {
    try {
      await sphere.destroy();
    } catch (err) {
      log(`destroy: ignored cleanup error: ${err instanceof Error ? err.message : String(err)}`);
    }
    sphere = null;
  }
  if (cleanupDir) {
    try { rmSync(cleanupDir, { recursive: true, force: true }); } catch { /* ignore */ }
    cleanupDir = null;
  }
  send({ type: 'destroy_ok', requestId });
  // Give the IPC channel a tick to flush the response, then exit.
  setImmediate(() => process.exit(0));
}

async function dispatch(msg: ParentRequest): Promise<void> {
  try {
    switch (msg.type) {
      case 'init':
        await handleInit(msg.requestId, msg.config);
        return;
      case 'receive':
        await handleReceive(msg.requestId);
        return;
      case 'sync':
        await handleSync(msg.requestId);
        return;
      case 'getBalance':
        handleGetBalance(msg.requestId, msg.symbol);
        return;
      case 'destroy':
        await handleDestroy(msg.requestId);
        return;
      default: {
        const unknown = msg as { requestId?: string };
        send({
          type: 'error',
          requestId: unknown.requestId ?? 'unknown',
          message: `unknown message type: ${JSON.stringify(msg)}`,
        });
      }
    }
  } catch (err) {
    send({
      type: 'error',
      requestId: msg.requestId,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
}

process.on('message', (raw) => {
  // Unknown shape — coerce defensively.
  void dispatch(raw as ParentRequest);
});

process.on('uncaughtException', (err) => {
  send({
    type: 'error',
    requestId: 'uncaughtException',
    message: err.message,
    stack: err.stack,
  });
});

process.on('unhandledRejection', (err) => {
  send({
    type: 'error',
    requestId: 'unhandledRejection',
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
});

async function emergencyShutdown(): Promise<never> {
  if (sphere) {
    try { await sphere.destroy(); } catch { /* ignore */ }
    sphere = null;
  }
  if (cleanupDir) {
    try { rmSync(cleanupDir, { recursive: true, force: true }); } catch { /* ignore */ }
    cleanupDir = null;
  }
  process.exit(0);
}

process.on('SIGTERM', () => { void emergencyShutdown(); });
// Defensive: if the parent dies, our IPC channel closes — exit cleanly
// so we don't leak a Sphere with open libp2p connections.
process.on('disconnect', () => { void emergencyShutdown(); });

