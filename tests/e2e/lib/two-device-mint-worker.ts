/**
 * Worker entry point for `two-device-local-mint-convergence.test.ts`.
 *
 * Sibling of `profile-sync-worker.ts` but with a `mint` operation that
 * self-mints a test token (no faucet, no Nostr) via the live aggregator,
 * plus a `getTokenIds` operation that returns the wallet's full token
 * id set so the parent can assert joint convergence across two
 * independent worker processes.
 *
 * Why a separate process: Sphere enforces a process-singleton. The
 * second call to `Sphere.import` inside the same process invokes
 * `Sphere.clear()` which destroys the previous `Sphere.instance` and
 * its `_identity`. We need two Sphere instances active simultaneously
 * (one per "device"), so each runs in its own forked Node.js process.
 *
 * IPC protocol:
 *
 *   parent → worker:
 *     { type: 'init', requestId, config: { label, mnemonic? } }
 *     { type: 'mint', requestId, coinIdHex, amountStr }
 *     { type: 'sync', requestId }
 *     { type: 'getTokenIds', requestId }
 *     { type: 'destroy', requestId }
 *
 *   worker → parent:
 *     { type: 'init_ok', requestId, mnemonic, l1Address, ... }
 *     { type: 'mint_ok', requestId, tokenIdHex }
 *     { type: 'sync_ok', requestId, added, removed }
 *     { type: 'tokens_ok', requestId, tokenIds }
 *     { type: 'destroy_ok', requestId }
 *     { type: 'error', requestId, message, stack? }
 *     { type: 'log', message }
 *
 * Spawned via:
 *   spawn(process.execPath, ['--import', 'tsx/esm', WORKER_PATH],
 *         { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] })
 */

import { rmSync } from 'node:fs';
import { Sphere } from '../../../core/Sphere';
import {
  makeTempDirs,
  ensureTrustbase,
  createNoopTransport,
} from '../helpers';
import { makeProfileProviders } from '../profile-helpers';
import { mintTestTokenToSelf } from './test-mint';

// ---------------------------------------------------------------------------
// IPC types — exported so the parent test can import for type safety.
// ---------------------------------------------------------------------------

export type MintWorkerInitConfig = {
  readonly label: string;
  readonly mnemonic?: string;
};

export type MintWorkerRequest =
  | { type: 'init'; requestId: string; config: MintWorkerInitConfig }
  | { type: 'mint'; requestId: string; coinIdHex: string; amountStr: string }
  | { type: 'sync'; requestId: string }
  | { type: 'getTokenIds'; requestId: string }
  | { type: 'destroy'; requestId: string };

export type MintWorkerResponse =
  | {
      type: 'init_ok';
      requestId: string;
      mnemonic: string;
      l1Address: string;
      chainPubkey: string;
      directAddress: string | undefined;
    }
  | { type: 'mint_ok'; requestId: string; tokenIdHex: string }
  | {
      type: 'sync_ok';
      requestId: string;
      added: number;
      removed: number;
    }
  | { type: 'tokens_ok'; requestId: string; tokenIds: string[] }
  | { type: 'destroy_ok'; requestId: string }
  | { type: 'error'; requestId: string; message: string; stack?: string }
  | { type: 'log'; message: string };

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

let sphere: Sphere | null = null;
let cleanupDir: string | null = null;
let label = 'worker';

function send(msg: MintWorkerResponse): void {
  if (typeof process.send !== 'function') {
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
  config: MintWorkerInitConfig,
): Promise<void> {
  label = config.label;
  log('init: building providers (no-op transport)...');

  const dirs = makeTempDirs(`two-dev-mint-${config.label}`);
  cleanupDir = dirs.base;
  await ensureTrustbase(dirs.dataDir);
  const providers = makeProfileProviders(dirs);

  if (config.mnemonic) {
    log('init: importing existing mnemonic...');
    sphere = await Sphere.import({
      storage: providers.storage,
      tokenStorage: providers.tokenStorage,
      transport: createNoopTransport(),
      oracle: providers.oracle,
      mnemonic: config.mnemonic,
    });
  } else {
    // Note: autoGenerate with noop transport is NOT supported by
    // Sphere.init's check (it wants to publish identity binding via
    // a real transport). We work around this by initializing with
    // the REAL transport first to generate the mnemonic, then
    // tearing down and reimporting with the no-op transport.
    log('init: creating fresh wallet (autoGenerate) with real transport...');
    const initial = await Sphere.init({
      ...providers,
      autoGenerate: true,
    });
    if (!initial.generatedMnemonic) {
      throw new Error('Sphere.init did not return a generated mnemonic');
    }
    const mnemonic = initial.generatedMnemonic;
    await initial.sphere.destroy();
    // Reimport with the no-op transport — same dirs, fresh providers
    // since the old ones had their connections torn down.
    log('init: reimporting with no-op transport to lock in noop...');
    const reimportProviders = makeProfileProviders(dirs);
    sphere = await Sphere.import({
      storage: reimportProviders.storage,
      tokenStorage: reimportProviders.tokenStorage,
      transport: createNoopTransport(),
      oracle: reimportProviders.oracle,
      mnemonic,
    });
    const identity = sphere.identity!;
    send({
      type: 'init_ok',
      requestId,
      mnemonic,
      l1Address: identity.l1Address,
      chainPubkey: identity.chainPubkey,
      directAddress: identity.directAddress,
    });
    return;
  }

  const identity = sphere.identity!;
  send({
    type: 'init_ok',
    requestId,
    mnemonic: config.mnemonic!,
    l1Address: identity.l1Address,
    chainPubkey: identity.chainPubkey,
    directAddress: identity.directAddress,
  });
}

async function handleMint(
  requestId: string,
  coinIdHex: string,
  amountStr: string,
): Promise<void> {
  if (!sphere) throw new Error('mint: sphere not initialized');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const privateKey = (sphere as any)._identity?.privateKey as string | undefined;
  if (!privateKey) throw new Error('mint: cannot read wallet private key');

  log(`mint: requesting test mint coinId=${coinIdHex} amount=${amountStr}...`);
  const { token: sdkToken, tokenIdHex } = await mintTestTokenToSelf({
    sphere,
    privateKey,
    coinIdHex,
    amount: BigInt(amountStr),
  });
  log(`mint: aggregator returned proof for tokenId=${tokenIdHex.slice(0, 12)}...`);

  // Wrap the SDK Token in sphere-sdk's UI Token shape — mirrors the
  // pattern AccountingModule.createInvoice() uses (see line ~1262 of
  // modules/accounting/AccountingModule.ts). `id` doubles as the
  // in-memory map key; the genesis tokenId hex is unique per mint so
  // it makes a stable, debuggable id.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdkTokenJson = (sdkToken as any).toJSON();
  const uiToken = {
    id: tokenIdHex,
    coinId: coinIdHex,
    symbol: 'TEST',
    name: 'Test Mint',
    decimals: 0,
    amount: amountStr,
    status: 'confirmed' as const,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sdkData: JSON.stringify(sdkTokenJson),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await sphere.payments.addToken(uiToken as any);

  send({ type: 'mint_ok', requestId, tokenIdHex });
}

async function handleSync(requestId: string): Promise<void> {
  if (!sphere) throw new Error('sync: sphere not initialized');

  // Force any pending write-behind flushes to land durably BEFORE the
  // pointer-poll inside sync(). Without this, recent addToken() calls
  // sit in the 2s debounce buffer and the actual IPFS pin +
  // aggregator-pointer publish hasn't happened yet — so the pointer
  // poll returns the local cursor (no new CIDs) and convergence
  // never fires. awaitNextFlush is the public seam PaymentsModule's
  // own at-least-once gate uses for exactly this purpose.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const providers = (sphere.payments as any).getTokenStorageProviders?.()
    ?? new Map<string, { awaitNextFlush?: (ms: number) => Promise<void> }>();
  for (const [pid, provider] of providers as Map<string, { awaitNextFlush?: (ms: number) => Promise<void> }>) {
    if (typeof provider.awaitNextFlush === 'function') {
      try {
        await provider.awaitNextFlush(60_000);
      } catch (err) {
        log(`sync: awaitNextFlush on provider ${pid} failed (best-effort): ${
          err instanceof Error ? err.message : String(err)
        }`);
      }
    }
  }

  const result = await sphere.payments.sync({ drainTimeoutMs: 30_000 });
  send({
    type: 'sync_ok',
    requestId,
    added: result.added,
    removed: result.removed,
  });
}

function handleGetTokenIds(requestId: string): void {
  if (!sphere) throw new Error('getTokenIds: sphere not initialized');
  const tokenIds: string[] = [];
  for (const tok of sphere.payments.getTokens()) {
    const id = extractGenesisTokenId(tok.sdkData);
    if (id) tokenIds.push(id);
  }
  send({ type: 'tokens_ok', requestId, tokenIds });
}

function extractGenesisTokenId(sdkData: string | undefined): string | null {
  if (!sdkData) return null;
  try {
    const parsed = JSON.parse(sdkData) as {
      genesis?: { data?: { tokenId?: string } };
    };
    return parsed.genesis?.data?.tokenId ?? null;
  } catch {
    return null;
  }
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
    try {
      rmSync(cleanupDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    cleanupDir = null;
  }
  send({ type: 'destroy_ok', requestId });
  setImmediate(() => process.exit(0));
}

async function dispatch(msg: MintWorkerRequest): Promise<void> {
  try {
    switch (msg.type) {
      case 'init':
        await handleInit(msg.requestId, msg.config);
        return;
      case 'mint':
        await handleMint(msg.requestId, msg.coinIdHex, msg.amountStr);
        return;
      case 'sync':
        await handleSync(msg.requestId);
        return;
      case 'getTokenIds':
        handleGetTokenIds(msg.requestId);
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
  void dispatch(raw as MintWorkerRequest);
});

process.on('uncaughtException', (err) => {
  send({
    type: 'error',
    requestId: 'uncaught',
    message: `uncaught: ${err.message}`,
    stack: err.stack,
  });
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  send({
    type: 'error',
    requestId: 'unhandled',
    message: `unhandled: ${msg}`,
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});
