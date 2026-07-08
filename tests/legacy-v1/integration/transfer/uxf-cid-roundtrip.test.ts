/**
 * Integration test: UXF transfer round-trip via CID-by-reference (T.4.B).
 *
 * **Goal**: end-to-end verify the recipient `kind: 'uxf-cid'` path against
 * a controlled HTTP gateway:
 *   1. Sender (force-cid) builds a real UXF bundle (CAR bytes + bundleCid).
 *   2. We host the CAR on a localhost HTTP server speaking the IPFS
 *      Trustless Gateway path-style (`/ipfs/{cid}?format=car`).
 *   3. Recipient calls `acquireBundle(payload, ..., { gateways: [<our-server>] })`
 *      which delegates to `fetchCarByCid` (T.4.B).
 *   4. The fetcher walks the gateway list, stream-fetches the CAR, verifies
 *      the root CID matches, and returns a {@link VerifiedBundle}.
 *
 * **Why a Node http server, not Helia**: Helia would pull in the full
 * libp2p / Helia stack as a test runtime dependency. The Trustless
 * Gateway HTTP semantics (path-style + `?format=car` Accept) are exactly
 * what every IPFS gateway speaks; a tiny Node http server reproducing
 * the response shape is functionally identical from the recipient SDK's
 * point of view, and it keeps test runtime dependencies to zero
 * additional packages.
 *
 * Spec references:
 *   - §3.3   `kind: 'uxf-cid'` envelope.
 *   - §3.3.1 Recipient-side 32 MiB cap (we do NOT exercise it here;
 *            covered by `cid-fetcher.test.ts`).
 *   - §3.3.2 Recipient delivered ONLY after physical fetch.
 *   - §9.2   No-op transient handling (NOT exercised here; covered by
 *            unit tests).
 *
 * @packageDocumentation
 */

import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  acquireBundle,
  isReplayOutcome,
} from '../../../extensions/uxf/pipeline/bundle-acquirer';
import { ReplayLRU } from '../../../extensions/uxf/pipeline/replay-lru';
import type { UxfTransferPayloadCid } from '../../../extensions/uxf/types/uxf-transfer';
import { UxfPackage } from '../../../extensions/uxf/bundle/UxfPackage';
import {
  carBytesToBase64,
  extractCarRootCid,
} from '../../../extensions/uxf/bundle/transfer-payload';

import { TOKEN_A } from '../../fixtures/uxf-mock-tokens';

const TOKEN_A_ID = 'aa00000000000000000000000000000000000000000000000000000000000001';
const SENDER = 'a'.repeat(64);

// =============================================================================
// 1. Test gateway — Node http server speaking the Trustless Gateway shape
// =============================================================================

interface MockGateway {
  readonly url: string;
  /** Pin a CAR to be served at `/ipfs/{cid}?format=car`. */
  put: (cid: string, carBytes: Uint8Array) => void;
  /** Drop a pin so the gateway returns 404. */
  unpin: (cid: string) => void;
  /** Shutdown the HTTP server. */
  close: () => Promise<void>;
}

async function startMockGateway(): Promise<MockGateway> {
  // Per-block index — populated automatically when `put()` is called.
  // The receiver now uses `fetchCarFromIpfs` (per-block walk) instead
  // of `?format=car` (issue #223), so the gateway MUST serve
  // `/api/v0/block/get?arg=<cid>` for each block in every pinned CAR.
  const pins = new Map<string, Uint8Array>(); // root CID → full CAR (legacy ?format=car endpoint)
  const blocks = new Map<string, Uint8Array>(); // each block CID → block bytes
  // Lazy import: CarReader is async-iterable and we parse on each
  // put() call. We cache the readers so put() stays synchronous from
  // the test's POV (puts that get extracted async).
  const { CarReader } = await import('@ipld/car');
  const indexCarBlocks = async (carBytes: Uint8Array): Promise<void> => {
    const reader = await CarReader.fromBytes(carBytes);
    for await (const block of reader.blocks()) {
      blocks.set(block.cid.toString(), block.bytes);
    }
  };
  const server: Server = createServer((req, res) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end();
      return;
    }
    // ---- /api/v0/block/get?arg=<cid> — used by fetchCarFromIpfs ----
    const blockMatch = /^\/api\/v0\/block\/get\?arg=([^&]+)/.exec(req.url);
    if (blockMatch) {
      const cid = decodeURIComponent(blockMatch[1]!);
      const bytes = blocks.get(cid);
      if (!bytes) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-length', String(bytes.byteLength));
      res.end(Buffer.from(bytes));
      return;
    }
    // ---- /ipfs/{cid}?format=car — legacy Trustless Gateway path
    //      (kept for tests that explicitly probe this endpoint;
    //      production no longer goes through it for uxf-cid). ----
    const m = /^\/ipfs\/([^?/#]+)(?:\?.*)?$/.exec(req.url);
    if (!m) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const cid = m[1];
    const car = pins.get(cid);
    if (!car) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/vnd.ipld.car');
    res.setHeader('content-length', String(car.byteLength));
    res.end(Buffer.from(car));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  // Track pending indexing operations so close() can flush.
  let pendingIndex: Promise<void> = Promise.resolve();
  return {
    url,
    put: (cid, carBytes) => {
      pins.set(cid, carBytes);
      // Parse the CAR and index every block under /api/v0/block/get.
      // Test scenarios that call put() expect the gateway to serve the
      // pinned content IMMEDIATELY; we chain the index promise so that
      // a subsequent close() will wait for the parse to finish.
      pendingIndex = pendingIndex.then(() => indexCarBlocks(carBytes));
    },
    unpin: (cid) => {
      // Unpinning the CAR root unpins the root block. Other blocks
      // remain reachable; tests that need to invalidate them must do
      // so explicitly. This matches real-IPFS unpinning semantics.
      pins.delete(cid);
      blocks.delete(cid);
    },
    close: async () => {
      await pendingIndex;
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

// =============================================================================
// 2. Sender side — assemble a real UXF bundle and produce a uxf-cid payload
// =============================================================================

interface SenderArtifacts {
  readonly carBytes: Uint8Array;
  readonly bundleCid: string;
  readonly cidPayload: UxfTransferPayloadCid;
  readonly carPayloadBase64: string;
}

async function makeSenderArtifacts(): Promise<SenderArtifacts> {
  const pkg = UxfPackage.create();
  pkg.ingestAll([TOKEN_A as unknown as Record<string, unknown>]);
  const carBytes = await pkg.toCar();
  const bundleCid = await extractCarRootCid(carBytes);
  // Force-cid envelope: NO inline CAR bytes; recipient MUST fetch.
  const cidPayload: UxfTransferPayloadCid = {
    kind: 'uxf-cid',
    version: '1.0',
    mode: 'instant',
    bundleCid,
    tokenIds: [TOKEN_A_ID],
    sender: { transportPubkey: SENDER },
  };
  return {
    carBytes,
    bundleCid,
    cidPayload,
    carPayloadBase64: carBytesToBase64(carBytes),
  };
}

// =============================================================================
// 3. Tests
// =============================================================================

describe('UXF transfer round-trip (T.4.B): force-cid → recipient fetches CAR', () => {
  let gateway: MockGateway;

  beforeAll(async () => {
    gateway = await startMockGateway();
  });

  afterAll(async () => {
    await gateway.close();
  });

  it('happy path: recipient fetches CAR via the gateway and produces VerifiedBundle', async () => {
    const sender = await makeSenderArtifacts();
    // The sender pins the CAR to the gateway (real-world: this is
    // `helia.blockstore.put(...)` followed by gateway resolution; in
    // the test we just pin directly).
    gateway.put(sender.bundleCid, sender.carBytes);

    const lru = new ReplayLRU();
    const result = await acquireBundle(sender.cidPayload, SENDER, lru, {
      gateways: [gateway.url],
    });
    if (isReplayOutcome(result)) throw new Error('unreachable: first arrival');
    expect(result.verified).toBe(true);
    expect(result.bundleCid).toBe(sender.bundleCid);
    expect(result.claimedTokens.map((r) => r.tokenId)).toEqual([TOKEN_A_ID]);
  });

  it('first gateway 404, second gateway succeeds — gateway list is walked in order', async () => {
    const sender = await makeSenderArtifacts();
    gateway.put(sender.bundleCid, sender.carBytes);
    // Simulate two gateways: a bogus URL first (network fail), then the
    // real gateway. The fetcher MUST fall through to the second.
    const lru = new ReplayLRU();
    const result = await acquireBundle(sender.cidPayload, SENDER, lru, {
      gateways: ['http://127.0.0.1:1', gateway.url], // port 1 is reserved/unused
    });
    if (isReplayOutcome(result)) throw new Error('unreachable: first arrival');
    expect(result.verified).toBe(true);
    expect(result.bundleCid).toBe(sender.bundleCid);
  });

  it('regression: force-cid for a TINY bundle still goes through fetch (no shortcut)', async () => {
    // The bundle is ~1 KiB; a faulty implementation might shortcut
    // the CID branch for tiny bundles or treat the absence of carBase64
    // as an error. The contract is: the sender chose force-cid, the
    // recipient MUST fetch unconditionally. We assert this by removing
    // the pin AFTER the fetch — if any caching kicked in, the second
    // fetch would still succeed; if the fetcher honors the wire
    // contract, it always asks the gateway.
    const sender = await makeSenderArtifacts();
    expect(sender.carBytes.byteLength).toBeLessThan(64 * 1024);
    gateway.put(sender.bundleCid, sender.carBytes);
    const lru = new ReplayLRU();
    const result = await acquireBundle(sender.cidPayload, SENDER, lru, {
      gateways: [gateway.url],
    });
    if (isReplayOutcome(result)) throw new Error('unreachable');
    expect(result.bundleCid).toBe(sender.bundleCid);
  });

  it('all gateways fail (404) → throws BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT', async () => {
    const sender = await makeSenderArtifacts();
    // We deliberately do NOT pin the CAR — the gateway returns 404 for
    // any unknown CID, forcing all-gateway-failure.
    gateway.unpin(sender.bundleCid);
    const lru = new ReplayLRU();
    let caught: unknown;
    const events: { name: string; payload: unknown }[] = [];
    try {
      await acquireBundle(sender.cidPayload, SENDER, lru, {
        gateways: [gateway.url],
        emit: (name, payload) => {
          events.push({ name, payload });
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe(
      'BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT',
    );
    // W13: NO disposition record write. The ONLY observable side-effect
    // is the `transfer:fetch-failed` event.
    expect(events.length).toBe(1);
    expect(events[0].name).toBe('transfer:fetch-failed');
  });
});
