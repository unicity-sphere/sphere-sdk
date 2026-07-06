/**
 * UXF Transfer — canonical `PublishToIpfsCallback` factory.
 *
 * The Nostr CID-by-reference (`uxf-cid`) path requires an IPFS publisher
 * that pins a UXF bundle CAR in a way **compatible with the wire's
 * `bundleCid`**. The wire's `bundleCid` is computed via
 * {@link extractCarRootCid}(carBytes) — i.e. the dag-cbor CID of the
 * CAR's single root block (the package envelope).
 *
 * **The latent footgun (issue #200).** A naive implementation of
 * `publishToIpfs` that calls `pinToIpfs(carBytes)` (raw codec) pins the
 * ENTIRE CAR envelope as ONE raw block under a `bafkrei…` (raw) CID. The
 * dag-cbor root CID (`bafyrei…`) is NOT indexed individually. The
 * recipient — who fetches `bundleCid` (the dag-cbor root) via
 * `block/get` or the gateway's `?format=car` endpoint — gets a 404
 * because no block at that CID was ever pinned.
 *
 * This is the exact same bug class that PR #199 fixed for the lean
 * profile-snapshot path. Issue #200 generalizes the fix.
 *
 * **The canonical publisher (this module).** {@link createUxfCarPublisher}
 * builds a {@link PublishToIpfsCallback} that:
 *  1. Calls {@link extractCarRootCid} on the CAR bytes to derive the
 *     canonical bundleCid.
 *  2. Invokes {@link pinCarBlocksToIpfs}, which walks the CAR block-by-block
 *     and pins each block under its canonical CID via Kubo's
 *     `/api/v0/dag/put` endpoint with `input-codec=dag-cbor` (or `raw`
 *     for non-cbor blocks). The bundleCid is now retrievable on its own.
 *  3. Returns `{ cid: bundleCid }` so the resolver and sender pipeline
 *     see the same value the wire carries.
 *
 * By construction, the returned CID equals `extractCarRootCid(carBytes)`
 * — closing the footgun.
 *
 * **Use this whenever wiring a real IPFS publisher.** Do NOT roll your
 * own with `pinToIpfs(carBytes)`; that is the documented footgun.
 *
 * @module modules/payments/transfer/ipfs-publisher
 */

import { pinCarBlocksToIpfs } from '../profile/ipfs-client.js';
import { extractCarRootCid } from '../bundle/transfer-payload.js';

import type {
  PublishToIpfsCallback,
  PublishToIpfsResult,
} from './delivery-resolver.js';

/**
 * Build the canonical UXF bundle-CAR publisher.
 *
 * The returned callback is the recommended way to wire a real IPFS
 * publisher into the CID-by-reference (`uxf-cid`) delivery path. It
 * guarantees the published CID equals the wire's `bundleCid`
 * (`extractCarRootCid(carBytes)`), so the recipient's fetch resolves
 * correctly on any honest gateway.
 *
 * **Contract** (matches `PublishToIpfsCallback`):
 *  - Accepts the assembled CAR bytes.
 *  - Pins every block in the CAR under its canonical CID via per-block
 *    `dag/put`.
 *  - Returns `{ cid }` where `cid === extractCarRootCid(carBytes)`.
 *  - Rejects (propagates) on parse failure, pin failure, or gateway
 *    errors — the resolver does NOT auto-fallback (that's the
 *    orchestrator's job).
 *
 * @param gateways IPFS gateway URLs to try in order. SHOULD be the
 *                 wallet's configured gateway list. Passing an empty
 *                 array falls back to the default gateway in
 *                 {@link pinCarBlocksToIpfs}.
 * @param timeoutMs Optional per-gateway-per-block timeout (ms). Defaults
 *                 to the {@link pinCarBlocksToIpfs} default.
 * @returns A `PublishToIpfsCallback` ready to drop into
 *          `ResolveDeliveryOptions.publishToIpfs` or a sender's
 *          `deps.publishToIpfs` field.
 */
export function createUxfCarPublisher(
  gateways: readonly string[],
  timeoutMs?: number,
): PublishToIpfsCallback {
  // Snapshot the gateway list at factory time so callers can't mutate
  // it out from under in-flight publishes.
  const frozenGateways = [...gateways];

  return async (carBytes: Uint8Array): Promise<PublishToIpfsResult> => {
    // Derive bundleCid from the CAR header. This is the SAME value the
    // sender writes onto the wire as `payload.bundleCid` — so the
    // publisher's returned cid is guaranteed to match.
    const bundleCid = await extractCarRootCid(carBytes);

    // Per-block pin via dag/put. Each block (root + every linked
    // sub-block in the bundle DAG) is indexed under its canonical CID.
    // The recipient can fetch `bundleCid` directly OR walk the DAG via
    // the gateway's `?format=car` endpoint — both work.
    const publishedCid = await pinCarBlocksToIpfs(
      frozenGateways,
      carBytes,
      bundleCid,
      timeoutMs,
    );

    // `pinCarBlocksToIpfs` returns the same `expectedRootCid` it was
    // given (by design — it's a defense against gateway-CID tampering).
    // We return that same value so callers see the canonical bundleCid.
    return { cid: publishedCid };
  };
}
