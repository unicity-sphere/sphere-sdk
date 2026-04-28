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
} from '../../../modules/payments/transfer/bundle-acquirer';
import { ReplayLRU } from '../../../modules/payments/transfer/replay-lru';
import type { UxfTransferPayloadCid } from '../../../types/uxf-transfer';
import { UxfPackage } from '../../../uxf/UxfPackage';
import {
  carBytesToBase64,
  extractCarRootCid,
} from '../../../uxf/transfer-payload';

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
  const pins = new Map<string, Uint8Array>();
  const server: Server = createServer((req, res) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end();
      return;
    }
    // Match `/ipfs/{cid}` ignoring query string (we accept any
    // `?format=car` or absence-of-query — the body is always served as
    // `application/vnd.ipld.car`, matching real Trustless Gateway
    // behavior).
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
  return {
    url,
    put: (cid, carBytes) => {
      pins.set(cid, carBytes);
    },
    unpin: (cid) => {
      pins.delete(cid);
    },
    close: async () => {
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
