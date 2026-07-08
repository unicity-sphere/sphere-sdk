/**
 * Issue #200 Phase 1 — `createUxfCarPublisher` contract tests.
 *
 * The canonical UXF bundle-CAR publisher (`createUxfCarPublisher`) is
 * the answer to the latent footgun documented in
 * `modules/payments/transfer/ipfs-publisher.ts`. This file pins its
 * contract:
 *
 *  1. The returned CID equals `extractCarRootCid(carBytes)` — the same
 *     value the sender writes on the wire as `payload.bundleCid`.
 *  2. Every block in the CAR is pinned individually via Kubo
 *     `/api/v0/dag/put` (one HTTP call per block).
 *  3. Each `dag/put` carries the correct codec hint derived from each
 *     block's CID prefix — dag-cbor blocks get `input-codec=dag-cbor`,
 *     raw blocks get `input-codec=raw`.
 *
 * The tests intercept `globalThis.fetch` so no real IPFS gateway is
 * touched. They feed real CARs produced by `UxfPackage.toCar()` so the
 * block structure matches production exactly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createUxfCarPublisher } from '../../../../extensions/uxf/pipeline/ipfs-publisher.js';
import { UxfPackage } from '../../../../extensions/uxf/bundle/UxfPackage.js';
import { extractCarRootCid } from '../../../../extensions/uxf/bundle/transfer-payload.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Build a small multi-block UXF bundle CAR.
 *
 * We seed a `UxfPackage` with one synthetic genesis-style element so the
 * exported CAR has >1 block (envelope + manifest + ≥1 pool element).
 * Production code paths only feed real bundles to the publisher, but a
 * 1-token synthetic is sufficient to verify the per-block-pin contract.
 */
async function buildBundleCar(): Promise<{
  carBytes: Uint8Array;
  rootCid: string;
}> {
  const pkg = UxfPackage.create({
    description: 'issue-200 phase-1 publisher fixture',
  });
  // The empty package serializes to an envelope + empty-manifest CAR
  // (≥2 blocks). That's enough to exercise the per-block loop.
  const carBytes = await pkg.toCar();
  const rootCid = await extractCarRootCid(carBytes);
  return { carBytes, rootCid };
}

interface FetchCall {
  url: string;
  method: string | undefined;
  body: FormData | undefined;
}

/**
 * Install a `globalThis.fetch` stub that captures every call and
 * responds with Kubo's expected `dag/put` response shape (`{ Cid: { "/":
 * "<cid>" } }`). The stub does NOT verify the CIDs returned — the
 * canonical publisher ignores the gateway-supplied CID and uses its own
 * locally-computed `bundleCid` (defense against malicious gateways).
 */
function installFetchStub(): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push({
      url,
      method: init?.method,
      body: init?.body instanceof FormData ? init.body : undefined,
    });
    return new Response(
      JSON.stringify({ Cid: { '/': 'bafkreigatewaysuppliedwhatever' } }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = stub as any;
  return { calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createUxfCarPublisher (issue #200 Phase 1)', () => {
  let restoreFetch: typeof globalThis.fetch;

  beforeEach(() => {
    restoreFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = restoreFetch;
  });

  it('returns a CID equal to extractCarRootCid(carBytes)', async () => {
    const { carBytes, rootCid } = await buildBundleCar();
    installFetchStub();

    const publish = createUxfCarPublisher(['https://test-gw.example']);
    const result = await publish(carBytes);

    expect(result.cid).toBe(rootCid);
  });

  it('pins every block in the CAR via dag/put (one POST per block)', async () => {
    const { carBytes } = await buildBundleCar();
    const { calls } = installFetchStub();

    // Count blocks by reading the CAR ourselves.
    const { CarReader } = await import('@ipld/car');
    const reader = await CarReader.fromBytes(carBytes);
    let blockCount = 0;
    for await (const _block of reader.blocks()) {
      blockCount++;
    }
    expect(blockCount).toBeGreaterThanOrEqual(2);

    const publish = createUxfCarPublisher(['https://test-gw.example']);
    await publish(carBytes);

    const dagPuts = calls.filter((c) => c.url.includes('/api/v0/dag/put'));
    expect(dagPuts).toHaveLength(blockCount);
  });

  it('encodes dag-cbor root block with input-codec=dag-cbor (not raw)', async () => {
    const { carBytes } = await buildBundleCar();
    const { calls } = installFetchStub();

    const publish = createUxfCarPublisher(['https://test-gw.example']);
    await publish(carBytes);

    // UXF bundle CARs use dag-cbor blocks (envelope + manifest + dag-cbor
    // elements). Every dag/put MUST carry `input-codec=dag-cbor` for the
    // root — pinning a dag-cbor block as raw would land it under a
    // different CID and break the receiver's fetch.
    expect(calls.length).toBeGreaterThan(0);
    const cborPuts = calls.filter((c) =>
      c.url.includes('input-codec=dag-cbor&store-codec=dag-cbor'),
    );
    // At minimum the envelope (root) and manifest are dag-cbor.
    expect(cborPuts.length).toBeGreaterThanOrEqual(2);
  });

  it('uses pin=true so the gateway does not GC the blocks before fetch', async () => {
    const { carBytes } = await buildBundleCar();
    const { calls } = installFetchStub();

    const publish = createUxfCarPublisher(['https://test-gw.example']);
    await publish(carBytes);

    for (const c of calls) {
      if (c.url.includes('/api/v0/dag/put')) {
        expect(c.url).toMatch(/[?&]pin=true(&|$)/);
      }
    }
  });

  it('reads gateway list lazily — caller mutating the array post-call has no effect', async () => {
    const { carBytes, rootCid } = await buildBundleCar();
    const { calls } = installFetchStub();

    const gateways = ['https://test-gw.example'];
    const publish = createUxfCarPublisher(gateways);
    gateways.push('https://attacker.example'); // tamper post-factory

    const result = await publish(carBytes);
    expect(result.cid).toBe(rootCid);

    // No call went to the post-injected attacker gateway.
    expect(calls.some((c) => c.url.includes('attacker'))).toBe(false);
  });

  it('rejects when the CAR fails to parse (defense against caller bugs)', async () => {
    installFetchStub();
    const publish = createUxfCarPublisher(['https://test-gw.example']);
    const garbage = new Uint8Array([0xff, 0xff, 0xff, 0xff]); // not a CAR
    await expect(publish(garbage)).rejects.toThrow();
  });
});
