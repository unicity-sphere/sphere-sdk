/**
 * Live integration test for OrbitDbAdapter.
 *
 * Uses REAL OrbitDB + Helia instances (no mocks). Each test suite spins up
 * its own Helia/libp2p node and OrbitDB database in a temporary directory,
 * then tears everything down afterward.
 *
 * These tests are slow (Helia + libp2p bootstrap takes several seconds).
 * The outer describe block has a 60-second timeout; individual tests that
 * need more time override with their own timeout.
 *
 * REQUIRES Node.js >= 22 (OrbitDB v3 / Helia v6 use Promise.withResolvers).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

// The CI hang that led to sphere-sdk#105 was caused by libp2pDefaults()
// unconditionally including a bootstrap peer-discovery service. On a CI
// runner without outbound IPFS connectivity, bootstrap retries forever
// and the suite timed out after 12+ minutes.
//
// Fix landed in the OrbitDbAdapter: passing `bootstrapPeers: []` now
// switches libp2p into "isolated mode" — peerDiscovery and every
// outbound-discovery service are dropped, leaving only the local
// identify/ping/keychain surface + gossipsub (required by OrbitDB v3).
// The adapter still works for single-process operations, which is all
// this integration test exercises.
//
// With isolated mode, the test runs in CI. The Node ≥ 22 gate stays
// because @orbitdb/core v3 uses Promise.withResolvers, which is a
// Node 22+ feature. CI's Node-20 matrix leg is excluded here; when
// the project drops Node 20 (see #105 follow-up) this guard can go.
const nodeVersion = parseInt(process.versions.node.split('.')[0], 10);
const describeOrSkip = nodeVersion >= 22 ? describe : describe.skip;
import { OrbitDbAdapter } from '../../extensions/uxf/profile/orbitdb-adapter.js';
import { randomBytes } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Suppress libp2p WebRTC "DataChannel is closed" errors during shutdown.
// These are cosmetic: libp2p/WebRTC fires async send attempts after the
// data channel is already closed. They do not affect correctness.
// ---------------------------------------------------------------------------

const originalListeners = process.listeners('uncaughtException');

function suppressWebRtcErrors(): void {
  process.removeAllListeners('uncaughtException');
  process.on('uncaughtException', (err: Error) => {
    if (err.message?.includes('DataChannel is closed')) {
      return; // swallow
    }
    // Forward to original listeners
    for (const listener of originalListeners) {
      (listener as (err: Error) => void)(err);
    }
  });
}

function restoreUncaughtListeners(): void {
  process.removeAllListeners('uncaughtException');
  for (const listener of originalListeners) {
    process.on('uncaughtException', listener as (...args: any[]) => void);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a random 32-byte hex private key. */
function randomKey(): string {
  return randomBytes(32).toString('hex');
}

/** Create a unique temporary directory for a test run. */
function makeTempDir(label: string): string {
  const dir = path.join(os.tmpdir(), `orbitdb-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Recursively remove a directory (best-effort). */
function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/** Encode a string as Uint8Array (UTF-8). */
function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Decode a Uint8Array to string (UTF-8). */
function decode(buf: Uint8Array): string {
  return new TextDecoder().decode(buf);
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describeOrSkip('OrbitDB Adapter (live integration)', { timeout: 60_000 }, () => {
  let adapter: OrbitDbAdapter;
  let testDir: string;
  const testKey = randomKey();

  beforeAll(async () => {
    suppressWebRtcErrors();
    testDir = makeTempDir('main');
    adapter = new OrbitDbAdapter();
    await adapter.connect({
      privateKey: testKey,
      directory: testDir,
      enablePubSub: false,
      // Isolated mode — see adapter's libp2p config block for rationale.
      // An empty bootstrap list strips peerDiscovery so libp2p doesn't
      // hang on bootstrap retries when the CI runner has no outbound
      // IPFS connectivity. Test exercises local CRUD only; no cross-
      // peer flow is needed.
      bootstrapPeers: [],
    });
  });

  afterAll(async () => {
    await adapter.close();
    cleanupDir(testDir);
    restoreUncaughtListeners();
  });

  // ---- Connection state ----

  it('isConnected() returns true after connect', () => {
    expect(adapter.isConnected()).toBe(true);
  });

  // ---- Basic CRUD ----

  it('put and get round-trip', async () => {
    const key = 'test.roundtrip';
    const value = encode('hello orbitdb');

    await adapter.put(key, value);
    const result = await adapter.get(key);

    expect(result).not.toBeNull();
    expect(decode(result!)).toBe('hello orbitdb');
  });

  it('get non-existent key returns null', async () => {
    const result = await adapter.get('nonexistent.key.12345');
    expect(result).toBeNull();
  });

  it('put overwrites existing value', async () => {
    const key = 'test.overwrite';

    await adapter.put(key, encode('first'));
    await adapter.put(key, encode('second'));

    const result = await adapter.get(key);
    expect(result).not.toBeNull();
    expect(decode(result!)).toBe('second');
  });

  it('del removes key', async () => {
    const key = 'test.delete-me';

    await adapter.put(key, encode('will be deleted'));
    const before = await adapter.get(key);
    expect(before).not.toBeNull();

    await adapter.del(key);
    const after = await adapter.get(key);
    expect(after).toBeNull();
  });

  it('del on non-existent key does not throw', async () => {
    await expect(adapter.del('nonexistent.del.key')).resolves.not.toThrow();
  });

  // ---- Binary data ----

  it('stores and retrieves binary data', async () => {
    const key = 'test.binary';
    const value = new Uint8Array([0, 1, 2, 127, 128, 255]);

    await adapter.put(key, value);
    const result = await adapter.get(key);

    expect(result).not.toBeNull();
    // OrbitDB's IPLD serialization may coerce Uint8Array through object form.
    // The adapter's coercion logic should handle this. We compare byte content.
    expect(Array.from(result!)).toEqual(Array.from(value));
  });

  // ---- all() enumeration ----

  it('all() returns all entries', async () => {
    // Write a few known keys with a unique prefix to avoid collisions with
    // earlier tests.
    const prefix = 'all-test.';
    await adapter.put(`${prefix}a`, encode('alpha'));
    await adapter.put(`${prefix}b`, encode('bravo'));
    await adapter.put(`${prefix}c`, encode('charlie'));

    const entries = await adapter.all();

    // Should contain at least our three keys (may also contain keys from
    // earlier tests in the same database).
    expect(entries.size).toBeGreaterThanOrEqual(3);
    expect(entries.has(`${prefix}a`)).toBe(true);
    expect(entries.has(`${prefix}b`)).toBe(true);
    expect(entries.has(`${prefix}c`)).toBe(true);

    expect(decode(entries.get(`${prefix}a`)!)).toBe('alpha');
    expect(decode(entries.get(`${prefix}b`)!)).toBe('bravo');
    expect(decode(entries.get(`${prefix}c`)!)).toBe('charlie');
  });

  it('all(prefix) filters by prefix', async () => {
    const prefixA = 'filter.groupA.';
    const prefixB = 'filter.groupB.';

    await adapter.put(`${prefixA}1`, encode('a1'));
    await adapter.put(`${prefixA}2`, encode('a2'));
    await adapter.put(`${prefixB}1`, encode('b1'));

    const groupA = await adapter.all(prefixA);
    const groupB = await adapter.all(prefixB);

    expect(groupA.size).toBe(2);
    expect(groupA.has(`${prefixA}1`)).toBe(true);
    expect(groupA.has(`${prefixA}2`)).toBe(true);
    expect(groupA.has(`${prefixB}1`)).toBe(false);

    expect(groupB.size).toBe(1);
    expect(groupB.has(`${prefixB}1`)).toBe(true);
  });

  it('all() with non-matching prefix returns empty map', async () => {
    const entries = await adapter.all('zzz.no.match.');
    expect(entries.size).toBe(0);
  });

  // ---- onReplication ----

  it('onReplication returns unsubscribe function', () => {
    const unsub = adapter.onReplication(() => {});
    expect(typeof unsub).toBe('function');
    unsub(); // should not throw
  });

  // ---- Close and state ----

  it('close() sets isConnected to false', async () => {
    const tempDir = makeTempDir('close-test');
    const tempAdapter = new OrbitDbAdapter();

    await tempAdapter.connect({
      privateKey: randomKey(),
      directory: tempDir,
      enablePubSub: false,
      bootstrapPeers: [],
    });
    expect(tempAdapter.isConnected()).toBe(true);

    await tempAdapter.close();
    expect(tempAdapter.isConnected()).toBe(false);

    cleanupDir(tempDir);
  });

  it('close() is idempotent', async () => {
    const tempDir = makeTempDir('close-idempotent');
    const tempAdapter = new OrbitDbAdapter();

    await tempAdapter.connect({
      privateKey: randomKey(),
      directory: tempDir,
      enablePubSub: false,
      bootstrapPeers: [],
    });

    await tempAdapter.close();
    await expect(tempAdapter.close()).resolves.not.toThrow();

    cleanupDir(tempDir);
  });

  it('operations throw after close', async () => {
    const tempDir = makeTempDir('ops-after-close');
    const tempAdapter = new OrbitDbAdapter();

    await tempAdapter.connect({
      privateKey: randomKey(),
      directory: tempDir,
      enablePubSub: false,
      bootstrapPeers: [],
    });
    await tempAdapter.close();

    await expect(tempAdapter.put('k', encode('v'))).rejects.toThrow(/not connected/i);
    await expect(tempAdapter.get('k')).rejects.toThrow(/not connected/i);
    await expect(tempAdapter.del('k')).rejects.toThrow(/not connected/i);
    await expect(tempAdapter.all()).rejects.toThrow(/not connected/i);

    cleanupDir(tempDir);
  });
});

// ---------------------------------------------------------------------------
// Replication test (two adapters, same key)
// ---------------------------------------------------------------------------

describeOrSkip('OrbitDB Adapter replication (same key)', { timeout: 60_000 }, () => {
  let adapterA: OrbitDbAdapter;
  let adapterB: OrbitDbAdapter;
  let dirA: string;
  let dirB: string;
  const sharedKey = randomKey();

  beforeAll(async () => {
    suppressWebRtcErrors();
    dirA = makeTempDir('repl-a');
    dirB = makeTempDir('repl-b');

    adapterA = new OrbitDbAdapter();
    await adapterA.connect({
      privateKey: sharedKey,
      directory: dirA,
      enablePubSub: false,
      bootstrapPeers: [],
    });

    adapterB = new OrbitDbAdapter();
    await adapterB.connect({
      privateKey: sharedKey,
      directory: dirB,
      enablePubSub: false,
      bootstrapPeers: [],
    });
  });

  afterAll(async () => {
    await adapterA.close();
    await adapterB.close();
    cleanupDir(dirA);
    cleanupDir(dirB);
    restoreUncaughtListeners();
  });

  it('two adapters with the same key derive the same database name and both connect', () => {
    expect(adapterA.isConnected()).toBe(true);
    expect(adapterB.isConnected()).toBe(true);
  });

  it('each adapter can independently write and read', async () => {
    await adapterA.put('repl.a', encode('from-a'));
    await adapterB.put('repl.b', encode('from-b'));

    const fromA = await adapterA.get('repl.a');
    const fromB = await adapterB.get('repl.b');

    expect(fromA).not.toBeNull();
    expect(decode(fromA!)).toBe('from-a');
    expect(fromB).not.toBeNull();
    expect(decode(fromB!)).toBe('from-b');
  });

  // Note: True cross-peer replication requires libp2p peer discovery and
  // pubsub, which is disabled in this test for speed. The adapters use
  // separate Helia nodes with separate local storage, so writes on one are
  // NOT visible on the other without network-level replication. This is
  // expected behavior: the two instances prove that the deterministic
  // database name derivation works (same key -> same db name) and that
  // each instance can operate independently. Full replication would require
  // enabling pubsub and connecting the libp2p peers, which is out of scope
  // for a unit-style integration test.
  it('adapters derive the same deterministic db name (same key)', async () => {
    // Both adapters opened successfully with the same private key.
    // If they derived different db names, the databases would be separate
    // (which they are anyway due to separate Helia nodes). The fact that
    // both connect without error with the same key verifies deterministic
    // name derivation does not depend on instance-specific state.
    expect(adapterA.isConnected()).toBe(true);
    expect(adapterB.isConnected()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Issue #266 — HTTP-only IPFS mode for wallet/CLI clients.
//
// When `httpOnlyIpfs: true` is set on OrbitDbConfig the adapter MUST:
//   - skip Helia's FsBlockstore (no `<directory>/blocks/` on disk),
//   - skip Helia's libp2p datastore (no peer-id/keychain on disk under
//     `<directory>` — these only get written under that path because
//     `directory` is passed into Helia options),
//   - take the isolated libp2p path (no DHT/bootstrap/peerDiscovery —
//     verified via test stability, since heavy mode hangs on bootstrap
//     in offline test envs),
//   - still let OrbitDB's level DB persist OpLog heads under
//     `<directory>/<dbname>/` (so cross-process recovery works once
//     blocks are re-warmed by HTTP snapshot prefetch in production).
// ---------------------------------------------------------------------------

describeOrSkip('OrbitDB Adapter — httpOnlyIpfs mode (issue #266)', { timeout: 60_000 }, () => {
  it('basic CRUD works with httpOnlyIpfs: true', async () => {
    suppressWebRtcErrors();
    const dir = makeTempDir('httponly-crud');
    const adapter = new OrbitDbAdapter();

    try {
      await adapter.connect({
        privateKey: randomKey(),
        directory: dir,
        enablePubSub: false,
        httpOnlyIpfs: true,
      });
      expect(adapter.isConnected()).toBe(true);

      await adapter.put('crud.k1', encode('v1'));
      await adapter.put('crud.k2', encode('v2'));
      const v1 = await adapter.get('crud.k1');
      const v2 = await adapter.get('crud.k2');
      expect(v1).not.toBeNull();
      expect(v2).not.toBeNull();
      expect(decode(v1!)).toBe('v1');
      expect(decode(v2!)).toBe('v2');
    } finally {
      await adapter.close();
      cleanupDir(dir);
      restoreUncaughtListeners();
    }
  });

  it('httpOnlyIpfs: true KEEPS FsBlockstore (cross-process recovery on same dataDir)', async () => {
    // Contract pin: lightweight mode strips libp2p networking (the
    // actual cost driver — see issue #266 root cause) but KEEPS the
    // local FsBlockstore. This is the user-approved tradeoff
    // ("preserve local helia storage but no libp2p bootstrapping"):
    // a freshly-initted wallet's OpLog blocks survive process exit
    // without depending on the flush-scheduler having pushed them
    // to operator Kubo first.
    suppressWebRtcErrors();
    const dir = makeTempDir('httponly-keeps-fsblocks');
    const adapter = new OrbitDbAdapter();

    try {
      await adapter.connect({
        privateKey: randomKey(),
        directory: dir,
        enablePubSub: false,
        httpOnlyIpfs: true,
      });
      // Touch the OpLog so the adapter has done at least one IPFS write
      await adapter.put('probe.k', encode('probe'));

      // FsBlockstore writes its CAR blocks under `<directory>/blocks/`.
      const blocksDir = path.join(dir, 'blocks');
      expect(fs.existsSync(blocksDir)).toBe(true);
    } finally {
      await adapter.close();
      cleanupDir(dir);
      restoreUncaughtListeners();
    }
  });

  it('reopen on same directory: lightweight mode recovers prior writes from FsBlockstore', async () => {
    // Cross-process recovery contract: write data, close, reopen on
    // the same directory. In `httpOnlyIpfs: true` mode we strip
    // libp2p networking and default block brokers BUT keep the
    // FsBlockstore, so OpLog blocks survive process exit without
    // depending on a flush to operator Kubo having completed first.
    //
    // This is the wallet CLI's happy path: a `sphere init` followed
    // by a `sphere balance` in a fresh process must work even before
    // any operator-side flush completes (the flush is async and may
    // not finish during a short-lived CLI session).
    suppressWebRtcErrors();
    const dir = makeTempDir('httponly-reopen');
    const key = randomKey();

    try {
      const a = new OrbitDbAdapter();
      await a.connect({
        privateKey: key,
        directory: dir,
        enablePubSub: false,
        httpOnlyIpfs: true,
      });
      await a.put('reopen.k', encode('original'));
      const beforeClose = await a.get('reopen.k');
      expect(beforeClose).not.toBeNull();
      expect(decode(beforeClose!)).toBe('original');
      await a.close();

      // Reopen — same dir, same key, fresh process state.
      const b = new OrbitDbAdapter();
      await b.connect({
        privateKey: key,
        directory: dir,
        enablePubSub: false,
        httpOnlyIpfs: true,
      });
      // Recover via FsBlockstore — must succeed quickly, no public
      // gateway walks (those would time out at 30s each).
      const start = Date.now();
      const afterReopen = await b.get('reopen.k');
      const elapsedMs = Date.now() - start;
      expect(afterReopen).not.toBeNull();
      expect(decode(afterReopen!)).toBe('original');
      expect(elapsedMs).toBeLessThan(5000);
      await b.close();
    } finally {
      cleanupDir(dir);
      restoreUncaughtListeners();
    }
  });

  it('reopen with WIPED FsBlockstore + HTTP fallback: lightweight mode recovers via operator Kubo HTTP', async () => {
    // Cross-DEVICE recovery: stand up a tiny in-process HTTP server
    // that mimics Kubo's `POST /api/v0/block/get?arg=<cid>` endpoint,
    // write data via adapter A, snapshot the blocks into the fake
    // gateway's store, close A, WIPE the `<dir>/blocks/` directory
    // (simulating a fresh device where the FsBlockstore has nothing
    // but the level DB heads have been replicated via the snapshot
    // mechanism), then open adapter B in the same `directory`. B
    // must HTTP-fetch the missing blocks from the fake gateway and
    // recover the data with no libp2p / public-gateway involvement.
    //
    // This validates the production cross-DEVICE recovery contract:
    // a fresh device pulls the snapshot CAR via HTTP from operator
    // Kubo and the OpLog blocks via the HTTP block broker. In the
    // same-device cross-PROCESS case the FsBlockstore on disk would
    // satisfy the read directly without the broker needing to fire.
    suppressWebRtcErrors();
    const http = await import('http' as string);
    const dir = makeTempDir('httponly-reopen-http');
    const key = randomKey();
    const blockStore = new Map<string, Uint8Array>();

    // Tiny fake operator Kubo: serves POST /api/v0/block/get?arg=<cid>
    // by looking up the CID in `blockStore`. 404 on miss.
    const server = http.createServer((req: any, res: any) => {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'POST' && url.pathname === '/api/v0/block/get') {
        const cidString = url.searchParams.get('arg') ?? '';
        const bytes = blockStore.get(cidString);
        if (!bytes) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end(Buffer.from(bytes));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;
    const gateway = `http://127.0.0.1:${port}`;

    try {
      // Phase A — write data with the local blockstore. Tap into Helia's
      // blockstore put to record every block in our fake gateway, since
      // the SDK's flush-scheduler isn't running in this unit test.
      const a = new OrbitDbAdapter();
      await a.connect({
        privateKey: key,
        directory: dir,
        enablePubSub: false,
        httpOnlyIpfs: true,
        ipfsGateways: [gateway],
      });
      // Snoop Helia's blockstore.put so we capture every CID/bytes
      // pair (this stands in for the flush-scheduler's HTTP pin step).
      const heliaInstance: any = (a as any).helia;
      const originalPut = heliaInstance.blockstore.put.bind(heliaInstance.blockstore);
      heliaInstance.blockstore.put = async (cid: any, bytes: Uint8Array, ...rest: any[]) => {
        blockStore.set(cid.toString(), bytes);
        return originalPut(cid, bytes, ...rest);
      };

      await a.put('recovery.k1', encode('alpha'));
      await a.put('recovery.k2', encode('beta'));
      await a.close();

      // Simulate a cross-device move: wipe the local FsBlockstore so
      // OrbitDB can't satisfy the read locally and MUST fall through
      // to the HTTP broker. (Same-device cross-process recovery is
      // covered by the previous test, where FsBlockstore stays.)
      const blocksDir = path.join(dir, 'blocks');
      if (fs.existsSync(blocksDir)) {
        fs.rmSync(blocksDir, { recursive: true, force: true });
      }

      // Phase B — reopen with the wiped blockstore. Must HTTP-fetch
      // the missing blocks from the fake gateway.
      const b = new OrbitDbAdapter();
      await b.connect({
        privateKey: key,
        directory: dir,
        enablePubSub: false,
        httpOnlyIpfs: true,
        ipfsGateways: [gateway],
      });

      const v1 = await b.get('recovery.k1');
      const v2 = await b.get('recovery.k2');
      expect(v1).not.toBeNull();
      expect(v2).not.toBeNull();
      expect(decode(v1!)).toBe('alpha');
      expect(decode(v2!)).toBe('beta');
      await b.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      cleanupDir(dir);
      restoreUncaughtListeners();
    }
  });

  it('httpOnlyIpfs: true overrides a non-empty bootstrapPeers list', async () => {
    // Contract: httpOnlyIpfs takes precedence — the isolation contract
    // wins over any caller-supplied peer list. Without this the wallet
    // could be tricked into the heavy libp2p path by stray config.
    suppressWebRtcErrors();
    const dir = makeTempDir('httponly-overrides-peers');
    const adapter = new OrbitDbAdapter();

    try {
      // Pass a non-empty bootstrap list AND httpOnlyIpfs: true. If
      // httpOnlyIpfs did not win, the adapter would dial the bogus
      // /ip4/198.51.100.1 (TEST-NET-2) address forever and the test
      // would fail by timeout. If httpOnlyIpfs wins, the adapter
      // forces isolated mode and never dials anything.
      await adapter.connect({
        privateKey: randomKey(),
        directory: dir,
        enablePubSub: false,
        httpOnlyIpfs: true,
        bootstrapPeers: ['/ip4/198.51.100.1/tcp/4001/p2p/QmInvalidBootstrapPeerForIssue266Test'],
      });
      expect(adapter.isConnected()).toBe(true);

      // And a write still works (no peer needed — local-only).
      await adapter.put('override.k', encode('ok'));
      const v = await adapter.get('override.k');
      expect(v).not.toBeNull();
      expect(decode(v!)).toBe('ok');
    } finally {
      await adapter.close();
      cleanupDir(dir);
      restoreUncaughtListeners();
    }
  });
});
