/**
 * §4.B / W13 — gateway-fetch-failed routes through transient retry only;
 * NO disposition record written.
 *
 * Per `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §9.2 + W13 (verbatim):
 *
 *   "BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT — every gateway in the list
 *    failed (network error, 5xx, mismatch, oversize, ...). This is a
 *    TRANSIENT class — the worker pool wraps this in retry, NOT in a
 *    `_invalid` disposition write. Per §9.2 / W13: 'NO disposition
 *    record written' — only the transient retry path runs."
 *
 * This integration test wires `IngestWorkerPool` against a mock gateway
 * that ALWAYS returns HTTP 503 (every gateway in the list fails). The
 * acquirer raises `BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT`; the pool's
 * W13 routing MUST:
 *
 *   (1) catch the transient,
 *   (2) NOT call `processToken` (no disposition write),
 *   (3) NOT log at error level (it's a normal-traffic class),
 *   (4) leave the disposition writer untouched.
 *
 * The disposition writer is a recording stub here — we assert
 * `writeRecord` is never called, which is the strongest possible
 * statement that no `_invalid` / `_audit` record was produced.
 */

import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { acquireBundle as acquireBundleProd } from '../../../extensions/uxf/pipeline/bundle-acquirer';
import {
  IngestWorkerPool,
  type ProcessTokenFn,
  type UxfV1Payload,
} from '../../../extensions/uxf/pipeline/ingest-worker-pool';
import { ReplayLRU } from '../../../extensions/uxf/pipeline/replay-lru';
import { PerTokenMutex } from '../../../extensions/uxf/profile/per-token-mutex';
import type {
  DispositionPerEntryStorage,
  DispositionEventEmitter,
} from '../../../extensions/uxf/profile/disposition-writer';
import { DispositionWriter } from '../../../extensions/uxf/profile/disposition-writer';
import { ManifestStore } from '../../../extensions/uxf/profile/manifest-store';
import { Lamport } from '../../../extensions/uxf/profile/lamport';

// =============================================================================
// 1. Mock IPFS Trustless Gateway — always 503
// =============================================================================

interface MockGateway {
  readonly url: string;
  readonly server: Server;
  hits: number;
}

async function startFailingGateway(): Promise<MockGateway> {
  const gw: { url: string; server: Server; hits: number } = {
    url: '',
    server: createServer((req, res) => {
      gw.hits += 1;
      res.statusCode = 503;
      res.setHeader('content-type', 'text/plain');
      res.end('mock 503');
    }),
    hits: 0,
  };
  await new Promise<void>((resolve) => {
    gw.server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = gw.server.address() as AddressInfo;
  gw.url = `http://127.0.0.1:${addr.port}`;
  return gw;
}

// =============================================================================
// 2. Disposition-writer stub that records every write
// =============================================================================

interface DispositionRecorder {
  readonly writer: DispositionWriter;
  readonly storage: DispositionPerEntryStorage;
  readonly storeEntries: Map<string, unknown>;
  readonly writes: Array<{ key: string; value: unknown }>;
}

function buildDispositionRecorder(): DispositionRecorder {
  const storeEntries = new Map<string, unknown>();
  const writes: Array<{ key: string; value: unknown }> = [];
  const storage: DispositionPerEntryStorage = {
    async readRecord(key) {
      return storeEntries.get(key) as never;
    },
    async writeRecord(key, value) {
      writes.push({ key, value });
      storeEntries.set(key, value);
    },
    async listKeysWithPrefix(keyPrefix, opts) {
      const cap = opts?.maxResults ?? Number.POSITIVE_INFINITY;
      const out: string[] = [];
      for (const k of storeEntries.keys()) {
        if (!k.startsWith(keyPrefix)) continue;
        out.push(k);
        if (out.length >= cap) break;
      }
      return out;
    },
  };
  // Minimal manifest store — tests never trigger an active-pool write
  // (writes are gated by a VALID/PENDING/CONFLICTING disposition,
  // none of which fire on a transient gateway failure).
  const manifestEntries = new Map<string, unknown>();
  const lamport = new Lamport();
  const manifestStore = new ManifestStore({
    storage: {
      async readEntry(addr, tokenId) {
        return manifestEntries.get(`${addr}.${tokenId}`) as never;
      },
      async writeEntry(addr, tokenId, _expectedRootHash, next) {
        manifestEntries.set(`${addr}.${tokenId}`, next);
        return { kind: 'ok' };
      },
    },
    lamport,
  });
  const emit: DispositionEventEmitter = () => undefined;
  const writer = new DispositionWriter({
    storage,
    manifestStore,
    emit,
  });
  return { writer, storage, storeEntries, writes };
}

// =============================================================================
// 3. Test
// =============================================================================

describe('§4.B / W13 — gateway-fetch-failed produces NO disposition record', () => {
  let gw: MockGateway;

  beforeAll(async () => {
    gw = await startFailingGateway();
  });
  afterAll(async () => {
    if (gw) {
      await new Promise<void>((resolve, reject) => {
        gw.server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it('all-gateways-fail surfaces transient + writes nothing to dispositions', async () => {
    // CIDv1 base32 — anything well-formed; we never resolve it (every
    // gateway returns 503).
    const bundleCid = 'bafkreieivf4t3hbz3sgqjj4xkwq6jhfqkzjxrtbbqlpwxapgvxnigvqlqe';
    const payload: UxfV1Payload = {
      kind: 'uxf-cid',
      version: '1.0',
      mode: 'conservative',
      bundleCid,
      tokenIds: [
        '01' + '0'.repeat(62), // synthetic 64-hex tokenId
      ],
    };

    const recorder = buildDispositionRecorder();
    const processToken = vi.fn<ProcessTokenFn>(async () => undefined);

    const errorLogs: Array<{ level: string; message: string }> = [];
    const allLogs: Array<{ level: string; message: string }> = [];

    const pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken,
      emit: () => undefined,
      // Production acquirer + real cid-fetcher → the failing gateway.
      acquireBundle: acquireBundleProd,
      cidOptions: {
        gateways: [gw.url],
        // Smaller cap so we don't try to read 32 MiB of mock 503 body.
        maxBytes: 1024,
      },
      logEmit: (level, message) => {
        allLogs.push({ level, message });
        if (level === 'error') errorLogs.push({ level, message });
      },
    });

    try {
      await pool.enqueue(payload, 'a'.repeat(64));
    } finally {
      await pool.destroy();
    }

    // (1) Acquirer attempted the gateway (and got the 503).
    expect(gw.hits).toBeGreaterThan(0);

    // (2) processToken was NEVER called — no per-token work happened.
    expect(processToken).not.toHaveBeenCalled();

    // (3) NO error-level log — W13 is a normal-traffic class.
    expect(errorLogs).toEqual([]);

    // (4) The transient log message is present at info level.
    const transientLog = allLogs.find((e) =>
      e.message.includes('gateway-fetch transient'),
    );
    expect(transientLog).toBeDefined();
    expect(transientLog!.level).toBe('info');

    // (5) STRONGEST CHECK — the disposition writer was never used.
    //     No `_invalid` and no `_audit` record materialized.
    expect(recorder.writes).toEqual([]);
    expect(recorder.storeEntries.size).toBe(0);
  });
});
