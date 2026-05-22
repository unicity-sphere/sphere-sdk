/**
 * Integration test — UXF transfer CID-by-reference recipient path uses
 * the **hierarchical block-walk** (`fetchCarFromIpfs`), NOT the gateway
 * `?format=car` endpoint (`fetchCarByCid`).
 *
 * **Why this is critical to test (root cause #2 of Issue #223):**
 *
 * UXF element blocks use Issue #213's Option-C canonical encoding —
 * child references are stored as raw 32-byte bstrs so that
 * `sha256(block.bytes) === block.cid.multihash.digest` for every
 * sub-block (enabling per-block `dag/put` pinning under each block's
 * canonical CID).
 *
 * The standard IPFS Trustless Gateway `?format=car` endpoint only
 * traverses CBOR Tag 42 CID links when assembling the DAG, so for
 * UXF bundles it returns ONLY the root + envelope + manifest and stops.
 * The receiver gets an incomplete CAR; `pkg.verify()` throws
 * `MISSING_ELEMENT`; `IngestWorkerPool.classifyAcquireError` silently
 * swallows it; the transfer is invisible.
 *
 * The fix (committed alongside this test): the uxf-cid branch in
 * `bundle-acquirer` now uses `fetchCarFromIpfs` (per-block walk via
 * `/api/v0/block/get`), which IS UXF-aware (`walkUxfElement` follows
 * raw-bstr children). This test reproduces the gateway shape that
 * surfaced the bug — a node that exposes `/api/v0/block/get` per block
 * but cannot serve a complete `?format=car` for Option-C bundles —
 * and asserts that the recipient successfully reassembles the bundle.
 *
 * **Test gateway shape:**
 *   - `/api/v0/block/get?arg=<cid>` → returns the pinned block bytes
 *   - `/ipfs/<cid>?format=car`     → returns ONLY the root block (the
 *     production-symptom of the bug; included so we can compare
 *     behavior with and without the fix on the same gateway).
 *
 * Spec references:
 *   - Issue #213 — Option C canonical encoding (children as raw bstrs).
 *   - Issue #223 — the bug this test guards against.
 *   - profile/ipfs-client.ts:578 fetchCarFromIpfs — symmetric receiver.
 *   - profile/ipfs-client.ts:293 pinCarBlocksToIpfs — producer.
 *
 * @packageDocumentation
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CarReader } from '@ipld/car';

import {
  acquireBundle,
  isReplayOutcome,
} from '../../../modules/payments/transfer/bundle-acquirer';
import { ReplayLRU } from '../../../modules/payments/transfer/replay-lru';
import { isSphereError } from '../../../core/errors';
import type { UxfTransferPayloadCid } from '../../../types/uxf-transfer';
import { UxfPackage } from '../../../uxf/UxfPackage';
import { extractCarRootCid } from '../../../uxf/transfer-payload';

import { TOKEN_A } from '../../fixtures/uxf-mock-tokens';
import { rewriteFixtureTokenId } from './_harness';

const SENDER = 'a'.repeat(64);

// =============================================================================
// 1. Mock IPFS gateway — exposes both `block/get` (per-block) AND
//    `?format=car` (root-only). The latter simulates the production bug
//    where the gateway cannot traverse Option-C child references.
// =============================================================================

interface MockIpfsNode {
  readonly url: string;
  /** Pin a single block (CID → bytes) addressable via /api/v0/block/get. */
  putBlock: (cid: string, bytes: Uint8Array) => void;
  /** Pin a CAR root for the `?format=car` endpoint. The returned CAR
   *  here is INTENTIONALLY just the root block — the very shape that
   *  surfaces #223. */
  putCarRootOnly: (rootCid: string, rootBlockBytes: Uint8Array) => void;
  /** Statistics — how many block/get hits and ?format=car hits the
   *  gateway saw. Used in assertions to prove the recipient used the
   *  block-walk path, not the legacy gateway-CAR path. */
  stats: () => { blockGetHits: number; formatCarHits: number };
  close: () => Promise<void>;
}

async function startMockIpfsNode(): Promise<MockIpfsNode> {
  const blocks = new Map<string, Uint8Array>();
  const carPins = new Map<string, Uint8Array>();
  let blockGetHits = 0;
  let formatCarHits = 0;

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    if (!req.url) {
      res.statusCode = 400;
      res.end();
      return;
    }

    // ---- /api/v0/block/get?arg=<cid> ----
    const blockMatch = /^\/api\/v0\/block\/get\?arg=([^&]+)/.exec(req.url);
    if (blockMatch) {
      blockGetHits++;
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

    // ---- /ipfs/<cid>?format=car ----
    const carMatch = /^\/ipfs\/([^?/#]+)(?:\?.*)?$/.exec(req.url);
    if (carMatch) {
      formatCarHits++;
      const cid = carMatch[1]!;
      const car = carPins.get(cid);
      if (!car) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/vnd.ipld.car');
      res.setHeader('content-length', String(car.byteLength));
      res.end(Buffer.from(car));
      return;
    }

    res.statusCode = 404;
    res.end();
  };

  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${addr.port}`,
    putBlock: (cid, bytes) => { blocks.set(cid, bytes); },
    putCarRootOnly: (rootCid, rootBlockBytes) => {
      carPins.set(rootCid, rootBlockBytes);
    },
    stats: () => ({ blockGetHits, formatCarHits }),
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

// =============================================================================
// 2. Bundle setup helpers
// =============================================================================

interface BundleArtifacts {
  readonly carBytes: Uint8Array;
  readonly bundleCid: string;
  readonly cidPayload: UxfTransferPayloadCid;
  /** Every block in the CAR, keyed by stringified CID. Used to "pin"
   *  each block to the mock node's `/api/v0/block/get` endpoint. */
  readonly blocks: Map<string, Uint8Array>;
}

async function buildBundleArtifacts(tokenIdOverride?: string): Promise<BundleArtifacts> {
  // Allow each test to mint a unique bundleCid so the ReplayLRU and
  // the gateway's per-block pinning state from prior tests don't
  // contaminate this one. The default reuses TOKEN_A.
  const fixture = tokenIdOverride
    ? rewriteFixtureTokenId(TOKEN_A, tokenIdOverride)
    : TOKEN_A;

  const pkg = UxfPackage.create();
  pkg.ingestAll([fixture as unknown as Record<string, unknown>]);
  const carBytes = await pkg.toCar();
  const bundleCid = await extractCarRootCid(carBytes);

  // Parse the CAR back into individual blocks so we can pin each one
  // independently to the mock node (mirrors what `pinCarBlocksToIpfs`
  // does in production).
  const reader = await CarReader.fromBytes(carBytes);
  const blocks = new Map<string, Uint8Array>();
  for await (const block of reader.blocks()) {
    blocks.set(block.cid.toString(), block.bytes);
  }

  const cidPayload: UxfTransferPayloadCid = {
    kind: 'uxf-cid',
    version: '1.0',
    mode: 'instant',
    bundleCid,
    tokenIds: [(fixture as { genesis: { data: { tokenId: string } } }).genesis.data.tokenId.toLowerCase()],
    sender: { transportPubkey: SENDER },
  };
  return { carBytes, bundleCid, cidPayload, blocks };
}

/** Build a CAR containing ONLY the root block — simulates the
 *  production gateway's blind-spot behaviour for Option-C bundles. */
async function buildPartialCar(rootCid: string, rootBlock: Uint8Array): Promise<Uint8Array> {
  const { CarWriter } = await import('@ipld/car/writer');
  const { CID } = await import('multiformats/cid');
  const parsedRoot = CID.parse(rootCid);
  const { writer, out } = CarWriter.create([parsedRoot]);
  const chunks: Uint8Array[] = [];
  const collectPromise = (async () => {
    for await (const chunk of out) chunks.push(chunk);
  })();
  await writer.put({ cid: parsedRoot, bytes: rootBlock });
  await writer.close();
  await collectPromise;
  let total = 0;
  for (const c of chunks) total += c.length;
  const out2 = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out2.set(c, off); off += c.length; }
  return out2;
}

// =============================================================================
// 3. Tests
// =============================================================================

describe('UXF transfer CID-by-reference — hierarchical block-walk recipient path (Issue #223)', () => {
  let node: MockIpfsNode;
  let artifacts: BundleArtifacts;

  beforeAll(async () => {
    node = await startMockIpfsNode();
    artifacts = await buildBundleArtifacts();
  });

  afterAll(async () => {
    await node.close();
  });

  it('REGRESSION: gateway serving only `?format=car` (root-only) — old path fails, new path succeeds', async () => {
    // Stage 1 — pin ONLY the root block via the `?format=car` endpoint.
    // The gateway will return a CAR containing just the root; no
    // sub-blocks. This is the exact production-symptom of #223.
    const rootBlock = artifacts.blocks.get(artifacts.bundleCid);
    expect(rootBlock).toBeDefined();
    const partialCar = await buildPartialCar(artifacts.bundleCid, rootBlock!);
    node.putCarRootOnly(artifacts.bundleCid, partialCar);

    // Stage 2 — also pin every block via /api/v0/block/get so the new
    // hierarchical-walk path CAN reassemble. We need to verify that
    // `acquireBundle` does NOT rely on `?format=car` — it MUST walk
    // per-block. We assert this by checking `formatCarHits` stays 0
    // after a successful acquire.
    for (const [cid, bytes] of artifacts.blocks) {
      node.putBlock(cid, bytes);
    }

    const baselineFormatCarHits = node.stats().formatCarHits;
    const lru = new ReplayLRU();
    const result = await acquireBundle(artifacts.cidPayload, SENDER, lru, {
      gateways: [node.url],
    });

    if (isReplayOutcome(result)) {
      throw new Error('unreachable: first arrival should not be a replay');
    }
    expect(result.verified).toBe(true);
    expect(result.bundleCid).toBe(artifacts.bundleCid);

    // The decisive assertion: the recipient walked per-block, NOT via
    // `?format=car`. If a future refactor reroutes uxf-cid back through
    // `fetchCarByCid` / gateway CAR endpoint, the gateway-CAR hit
    // counter will tick and this assertion will fail.
    const stats = node.stats();
    expect(stats.formatCarHits).toBe(baselineFormatCarHits);
    expect(stats.blockGetHits).toBeGreaterThan(0);
  });

  it('rejects with BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT when gateway 404s every block/get', async () => {
    // Stage: a fresh artifact set with a unique tokenId (different
    // bundleCid → different gateway pin key → no contamination from
    // previously pinned blocks). DO NOT pin any blocks. Every
    // /api/v0/block/get response is 404.
    const uniqueTokenId = 'cd00000000000000000000000000000000000000000000000000000000000099';
    const freshArtifacts = await buildBundleArtifacts(uniqueTokenId);
    // Override the bundleCid only — that's what `fetchCarFromIpfs`
    // walks from. (We don't want to reuse the same bundleCid as the
    // first test or the LRU would deduplicate.)
    const lru = new ReplayLRU();

    let caught: unknown;
    try {
      await acquireBundle(freshArtifacts.cidPayload, SENDER, lru, {
        gateways: [node.url],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    if (!isSphereError(caught)) {
      throw new Error(
        `expected SphereError, got ${
          caught instanceof Error ? `${caught.constructor.name}: ${caught.message}` : typeof caught
        }`,
      );
    }
    expect(caught.code).toBe('BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT');
  });

  it('rejects with BUNDLE_REJECTED_CID_MODE_NOT_YET_SUPPORTED when no gateways are wired', async () => {
    // Backward-compat contract: a caller that passes `cidOptions`
    // without a `gateways` array (or omits cidOptions entirely) still
    // gets the legacy rejection. This is the same contract that
    // PaymentsModule.cid-fetch-gateways-wiring-223.test.ts pins on the
    // wiring side — both ends must agree.
    const lru = new ReplayLRU();
    let caught: unknown;
    try {
      await acquireBundle(artifacts.cidPayload, SENDER, lru); // no cidOptions
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) {
      throw new Error('expected SphereError');
    }
    expect(caught.code).toBe('BUNDLE_REJECTED_CID_MODE_NOT_YET_SUPPORTED');
  });
});
