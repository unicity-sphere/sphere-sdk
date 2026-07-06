/**
 * Issue #200 Phase 1 — end-to-end over-cap auto-route → CID delivery
 * using the canonical `createUxfCarPublisher`.
 *
 * Stops the latent footgun documented in
 * `modules/payments/transfer/ipfs-publisher.ts`:
 *
 *   The wire's `payload.bundleCid` is `extractCarRootCid(carBytes)` (a
 *   dag-cbor CID over the CAR's envelope root block). A naive
 *   `publishToIpfs = (b) => pinToIpfs(b)` pins the entire CAR as ONE
 *   raw block under a `bafkrei…` raw CID — NOT under the wire's
 *   `bafyrei…` dag-cbor CID. The recipient's gateway fetch for
 *   `bundleCid` 404s indefinitely.
 *
 * This test wires the conservative-sender pipeline with
 * `createUxfCarPublisher` and asserts:
 *
 *  1. The publisher's returned CID equals the wire's `bundleCid`.
 *  2. Every block in the CAR is `dag/put`-pinned at the gateway.
 *  3. The root block (= `bundleCid`) is present in the stub gateway's
 *     CID→bytes map — i.e. a recipient fetch via `block/get(bundleCid)`
 *     would succeed.
 *
 * The `delivery: { kind: 'auto', inlineCapBytes: 1 }` strategy forces
 * the CID branch for any non-empty CAR, so we can exercise the
 * over-cap path with a tiny 1-token bundle.
 *
 * @packageDocumentation
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTOMATED_CID_DELIVERY_ENABLED } from '../../../modules/payments/transfer/limits';
// Issue #393 — gate auto-CID-promotion tests on the kill-switch.
const ifAutoCid = AUTOMATED_CID_DELIVERY_ENABLED ? it : it.skip;

import {
  sendConservativeUxf,
  type ConservativeCommitResult,
  type ConservativeSenderDeps,
} from '../../../modules/payments/transfer/conservative-sender';
import { createUxfCarPublisher } from '../../../modules/payments/transfer/ipfs-publisher';
import type { PreflightFinalizeOptions } from '../../../modules/payments/transfer/preflight-finalize';
import type { TransferRequest } from '../../../types';
import type { UxfTransferPayloadCid } from '../../../types/uxf-transfer';
import { extractCarRootCid } from '../../../extensions/uxf/bundle/transfer-payload';
import { TOKEN_A } from '../../fixtures/uxf-mock-tokens';

import {
  BOB_TRANSPORT_PUBKEY,
  defaultCoinTokenLike,
  makeEventRecorder,
  makeIdentity,
  makeOracleStub,
  makePeerInfo,
  makeRecordingTransport,
  makeToken,
  rewriteFixtureTokenId,
} from './_harness';

// ---------------------------------------------------------------------------
// Stub IPFS gateway
// ---------------------------------------------------------------------------

interface PinnedBlock {
  readonly url: string;
  readonly cid: string;
  readonly bytes: Uint8Array;
}

/**
 * Install a `globalThis.fetch` stub that intercepts Kubo
 * `/api/v0/dag/put` calls. Each block's CID and bytes are accumulated
 * into the returned map so the test can assert per-block pinning.
 *
 * The stub also responds to `/api/v0/block/get?arg=<cid>` lookups so
 * the test can simulate a recipient gateway fetch.
 */
function installStubGateway(): {
  pinned: Map<string, Uint8Array>;
  calls: PinnedBlock[];
  restore: () => void;
} {
  const pinned = new Map<string, Uint8Array>();
  const calls: PinnedBlock[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    if (url.includes('/api/v0/dag/put')) {
      // Parse the bytes out of the multipart form so we can index them
      // under the CID the publisher will compute locally. We CANNOT
      // compute the canonical CID here without redoing the same
      // hash-codec arithmetic, so we extract it from the form by
      // matching against the parent CAR (loaded by the test via
      // CarReader). The test passes the expected CIDs in via `pinned`
      // beforehand. As a simpler scheme: this stub accepts any block,
      // stores the bytes against its sha256 (we compute it here), and
      // the test then re-derives the CID locally.
      //
      // Simpler still: the test pre-computes the CID set from the CAR
      // it knows the publisher will produce, and the stub just stores
      // bytes against their sha256 digest (key = base64). The test
      // converts CID→sha256 digest for lookup.
      const form = init?.body as FormData | undefined;
      const blob = form?.get('data') as Blob | undefined;
      const bytes = blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array();
      // Compute sha256 fingerprint for the test's lookup.
      const { sha256 } = await import('@noble/hashes/sha2.js');
      const digestHex = Array.from(sha256(bytes))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      pinned.set(digestHex, bytes);
      calls.push({ url, cid: digestHex, bytes });
      return new Response(
        JSON.stringify({ Cid: { '/': 'bafkreigatewaysuppliedfake' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.includes('/api/v0/block/get')) {
      const cid = new URL(url).searchParams.get('arg') ?? '';
      // Look up by sha256 fingerprint extracted from the CID's multihash.
      // For this test the caller pre-decodes; we just respond 404 here.
      // (The recipient-side fetch isn't exercised by this test — see the
      // separate bundle-acquirer suite for that.)
      const fake = pinned.get(cid);
      if (fake) {
        return new Response(fake, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        });
      }
      return new Response('not found', { status: 404 });
    }

    return original(input, init);
  }) as typeof globalThis.fetch;

  return {
    pinned,
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Issue #200 Phase 1 — auto-over-cap CID delivery with canonical publisher', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    restoreFetch = null;
  });

  afterEach(() => {
    if (restoreFetch) restoreFetch();
  });

  ifAutoCid('canonical publisher returns bundleCid == extractCarRootCid; every block is pinned', async () => {
    const gateway = installStubGateway();
    restoreFetch = gateway.restore;

    const idHex = `bb${'1'.padStart(2, '0')}${'0'.repeat(60)}`;
    const fixture = rewriteFixtureTokenId(TOKEN_A, idHex);
    const source = makeToken({ id: idHex, fixture });

    const commitResult: ConservativeCommitResult = {
      sourceTokenId: idHex,
      method: 'direct',
      requestIdHex: `req-${idHex}`,
      recipientTokenJson: fixture,
    };

    // Spy wrapper around the canonical publisher so we can assert the
    // CAR bytes it saw and the CID it returned.
    const canonical = createUxfCarPublisher(['https://test-gw.example']);
    let observedCid: string | null = null;
    let observedCarBytes: Uint8Array | null = null;
    const publishToIpfs = vi.fn(async (carBytes: Uint8Array) => {
      observedCarBytes = carBytes;
      const result = await canonical(carBytes);
      observedCid = result.cid;
      return result;
    });

    const transport = makeRecordingTransport();
    const events = makeEventRecorder();
    const deps: ConservativeSenderDeps = {
      aggregator: makeOracleStub(),
      transport,
      identity: makeIdentity(),
      senderTransportPubkey: BOB_TRANSPORT_PUBKEY,
      emit: events.emit,
      publishToIpfs,
      availableSources: () => [source],
      selectSources: async () => [source],
      preflightOptions: () =>
        ({
          resolveRequestId: () => {
            throw new Error('not invoked');
          },
          extractPendingChain: () => [],
        }) satisfies Omit<PreflightFinalizeOptions, 'aggregator'>,
      commitSources: async () => [commitResult],
      toTokenLike: defaultCoinTokenLike,
    };

    const request: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '1000000',
      transferMode: 'conservative',
      // Force the auto-route to CID by setting an absurdly low inline
      // cap. The published CAR is any non-empty CAR.
      delivery: { kind: 'auto', inlineCapBytes: 1 },
    };

    const result = await sendConservativeUxf(request, makePeerInfo(), deps);
    expect(result.status).toBe('completed');

    // --- Assertion 1: publisher invoked exactly once ----------------------
    expect(publishToIpfs).toHaveBeenCalledTimes(1);
    expect(observedCarBytes).not.toBeNull();
    expect(observedCarBytes!.byteLength).toBeGreaterThan(0);

    // --- Assertion 2: wire is uxf-cid, bundleCid == publisher.cid --------
    expect(transport._calls).toHaveLength(1);
    const payload = transport._calls[0].payload as UxfTransferPayloadCid;
    expect(payload.kind).toBe('uxf-cid');
    expect(payload.bundleCid).toBeTruthy();
    expect(payload.bundleCid).toBe(observedCid);

    // --- Assertion 3: bundleCid == extractCarRootCid(carBytes) -----------
    // The wire's bundleCid is derived from the same CAR the publisher
    // saw — and the canonical publisher returns the same value. Tying
    // both ends of the contract together is the whole point of #200
    // Phase 1.
    const carRootCid = await extractCarRootCid(observedCarBytes!);
    expect(payload.bundleCid).toBe(carRootCid);
    expect(observedCid).toBe(carRootCid);

    // --- Assertion 4: every block in the CAR was dag/put-pinned ----------
    const { CarReader } = await import('@ipld/car');
    const reader = await CarReader.fromBytes(observedCarBytes!);
    let blockCount = 0;
    for await (const _block of reader.blocks()) {
      blockCount++;
    }
    expect(blockCount).toBeGreaterThanOrEqual(2);
    expect(gateway.calls.length).toBe(blockCount);

    // --- Assertion 5: dag/put used dag-cbor codec for cbor blocks -------
    // The envelope + manifest are dag-cbor; the publisher MUST hint
    // input-codec=dag-cbor or the gateway would pin them under the
    // raw-codec CID prefix (bafkrei… vs bafyrei…), breaking the
    // recipient fetch.
    const cborPuts = gateway.calls.filter((c) =>
      c.url.includes('input-codec=dag-cbor&store-codec=dag-cbor'),
    );
    expect(cborPuts.length).toBeGreaterThanOrEqual(2);

    // --- Assertion 6: the recipient could fetch bundleCid -----------------
    // We don't run the recipient pipeline (other suites cover that);
    // instead we assert the gateway has a block whose sha256 matches
    // the multihash digest in bundleCid. That is the canonical fetch
    // path's invariant ("block/get(bundleCid) returns bytes verifiable
    // against bundleCid").
    const { CID } = await import('multiformats/cid');
    const parsedBundleCid = CID.parse(payload.bundleCid);
    const digestHex = Array.from(parsedBundleCid.multihash.digest)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(gateway.pinned.has(digestHex)).toBe(true);
  });
});
