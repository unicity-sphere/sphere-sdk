/**
 * Shared IPFS client helpers for Profile storage operations.
 *
 * Provides pin, fetch, and verify operations against multiple IPFS gateways
 * with configurable timeouts, size limits, and multi-gateway fallback.
 *
 * Extracted from `ProfileTokenStorageProvider` and `ConsolidationEngine` to
 * eliminate ~120 lines of duplicated IPFS pin/fetch logic.
 *
 * Fetched bytes are content-address verified: `sha256(bytes)` must match
 * the multihash digest encoded in the requested CID. This protects against
 * a malicious or compromised gateway substituting different content.
 * Without encryption on the CAR payloads (see PROFILE-ARCHITECTURE.md
 * §10.2), the CID check is the sole authentication boundary between
 * "the bytes I pinned" and "the bytes a gateway hands me back".
 *
 * @module profile/ipfs-client
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { create as createMultihash } from 'multiformats/hashes/digest';
import { ProfileError } from './errors.js';

// =============================================================================
// Constants
// =============================================================================

/** Default IPFS gateway URL (used when no gateways are provided). */
const DEFAULT_IPFS_API_URL = 'https://ipfs.unicity.network';

/** Default timeout for pin operations (ms). */
const DEFAULT_PIN_TIMEOUT_MS = 60_000;

/** Default timeout for fetch operations (ms). */
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/** Default timeout for verify (HEAD) operations (ms). */
const DEFAULT_VERIFY_TIMEOUT_MS = 10_000;

/** Default maximum response size for fetch operations (bytes). */
const DEFAULT_MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

// =============================================================================
// Public API
// =============================================================================

/**
 * Pin a CAR file (or any bytes) to an IPFS gateway.
 * Tries each gateway in order, returns the CID on first success.
 *
 * @param gateways  - Array of IPFS gateway base URLs
 * @param data      - Bytes to pin
 * @param timeoutMs - Timeout per gateway attempt (default: 60 000)
 * @returns The CID of the pinned content
 * @throws {ProfileError} `ORBITDB_WRITE_FAILED` if all gateways fail or
 *         the response does not contain a CID.
 */
export async function pinToIpfs(
  gateways: string[],
  data: Uint8Array,
  timeoutMs: number = DEFAULT_PIN_TIMEOUT_MS,
): Promise<string> {
  const effectiveGateways = gateways.length > 0 ? gateways : [DEFAULT_IPFS_API_URL];
  validateGatewayUrls(effectiveGateways);
  let lastError: Error | null = null;

  for (const gateway of effectiveGateways) {
    try {
      // Kubo `/api/v0/dag/put` REQUIRES multipart/form-data with a
      // `data` field name — the raw-body-with-application/octet-stream
      // shape this code used previously returns HTTP 400
      // "file argument 'object data' is required" on any real Kubo.
      //
      // Query params:
      //   input-codec=raw    — treat the uploaded bytes as raw (no CBOR decode)
      //   store-codec=raw    — persist under the raw codec (CID prefix bafkrei…)
      //   pin=true           — keep the block pinned so the gateway
      //                        doesn't GC it before the aggregator
      //                        layer records the ref
      //   hash=sha2-256      — default, explicit for clarity
      // Result: CID.createV1(raw, sha256(data)) — byte-verifiable
      // via verifyCidMatchesBytes on fetch.
      const url =
        `${gateway.replace(/\/$/, '')}/api/v0/dag/put` +
        `?input-codec=raw&store-codec=raw&pin=true&hash=sha2-256`;

      const form = new FormData();
      // `new Blob([data])` where `data: Uint8Array` is safe across
      // Node 18+ (undici FormData) and browsers. The filename is
      // arbitrary but required by some server-side multipart parsers.
      form.append('data', new Blob([data as BlobPart]), 'data');

      const response = await fetch(url, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status} ${response.statusText} from ${gateway}`);
        continue;
      }

      // Kubo returns one line of JSON: `{"Cid":{"/":"bafkrei…"}}`.
      // Defensively handle both `Cid.` (current) and legacy `Hash`
      // shapes.
      const result = (await response.json()) as { Cid?: { '/': string }; Hash?: string };
      const returnedCid = result.Cid?.['/'] ?? result.Hash;
      if (!returnedCid) {
        lastError = new Error('IPFS pin response did not contain a CID');
        continue;
      }

      // Steelman remediation: do NOT trust the gateway's returned CID.
      // A malicious/misconfigured gateway could return any CID (redirecting
      // the wallet's pointer anchor to attacker-controlled content).
      // Compute the CID locally from the uploaded bytes — with
      // `input-codec=raw&store-codec=raw&hash=sha2-256` the expected
      // CID is deterministic: `CID.createV1(raw.code, sha256(data))`.
      // If the gateway returned a different CID, we IGNORE it and
      // return our locally-computed CID. A subsequent fetch against
      // that CID will succeed on any honest gateway that pinned the
      // bytes. A gateway that intentionally pinned OUR bytes under a
      // DIFFERENT CID reduces to a pin-failure from our perspective
      // (404 on next lookup); attacker cannot redirect the wallet's
      // anchor to attacker-chosen content.
      const expectedCid = CID.createV1(raw.code, createMultihash(0x12, sha256(data))).toString();
      return expectedCid;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw new ProfileError(
    'ORBITDB_WRITE_FAILED',
    `IPFS pin failed on all gateways: ${lastError?.message ?? 'unknown error'}`,
    lastError,
  );
}

/**
 * Map a codec code (the first byte after the CID version in a CIDv1) to
 * the Kubo `dag/put` `input-codec` / `store-codec` token. Only codecs the
 * Profile layer actually produces are listed — extend as the hierarchical
 * model adds new block types.
 */
const CODEC_NAMES: Record<number, string> = {
  0x55: 'raw',        // raw
  0x71: 'dag-cbor',   // dag-cbor
  0x70: 'dag-pb',     // dag-pb (legacy IPFS UnixFS — not produced by Profile, listed for completeness)
};

/**
 * Pin a single dag-cbor (or other-codec) block to IPFS via Kubo's
 * `/api/v0/dag/put` endpoint. The block is stored under its canonical
 * CID, addressable by subsequent `block/get`/`fetchFromIpfs`.
 *
 * Internal helper for {@link pinCarBlocksToIpfs}. The codec/hash tokens
 * are inferred from `expectedCid` — caller does not need to know the
 * Kubo wire vocabulary.
 *
 * @throws {ProfileError} `ORBITDB_WRITE_FAILED` if all gateways fail or
 *         the gateway returned an unsupported response.
 */
async function pinSingleBlock(
  gateways: string[],
  blockBytes: Uint8Array,
  expectedCid: string,
  timeoutMs: number,
): Promise<void> {
  const effectiveGateways = gateways.length > 0 ? gateways : [DEFAULT_IPFS_API_URL];
  validateGatewayUrls(effectiveGateways);

  // Derive the Kubo codec token from the CID's multicodec prefix.
  // Unknown codecs fall back to `raw` so we still store the bytes (the
  // gateway will compute a different CID, but our locally-computed
  // expected CID is what gets published — the next fetch will fail loud).
  let codecName = 'raw';
  try {
    const parsed = CID.parse(expectedCid);
    codecName = CODEC_NAMES[parsed.code] ?? 'raw';
  } catch {
    // ignore — fall through with `raw`
  }

  let lastError: Error | null = null;
  for (const gateway of effectiveGateways) {
    try {
      const url =
        `${gateway.replace(/\/$/, '')}/api/v0/dag/put` +
        `?input-codec=${codecName}&store-codec=${codecName}&pin=true&hash=sha2-256`;
      const form = new FormData();
      form.append('data', new Blob([blockBytes as BlobPart]), 'block');
      const response = await fetch(url, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status} ${response.statusText} from ${gateway}`);
        continue;
      }
      // Drain so the connection releases. We trust our locally-computed
      // expectedCid; the gateway-returned CID is intentionally ignored
      // (same posture as `pinToIpfs` — a malicious gateway pinning under
      // a different CID would just produce a 404 on the next fetch, not
      // an anchor redirect).
      try {
        await response.json();
      } catch {
        // ignore — body parse failure on a 200 doesn't change durability
      }
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw new ProfileError(
    'ORBITDB_WRITE_FAILED',
    `IPFS dag/put failed on all gateways for ${expectedCid}: ${lastError?.message ?? 'unknown error'}`,
    lastError,
  );
}

/**
 * Pin every block contained in a CAR file to IPFS, each under its
 * canonical CID. Used in place of `pinToIpfs(carBytes)` when the
 * published reference is a dag-cbor CID over a block INSIDE the CAR
 * (rather than a raw CID over the whole CAR envelope).
 *
 * Why not `/api/v0/dag/import`: the Unicity IPFS gateway does not expose
 * that endpoint. `dag/put` is universally available across Kubo deploys,
 * including hardened gateways that restrict the API surface. The
 * tradeoff is one HTTP round-trip per block — acceptable for the
 * single-block lean snapshot today; future hierarchical snapshots
 * (per-writer / per-bundle / per-token / per-sub-token sub-blocks) will
 * scale linearly, but each block is small and we can parallelize if
 * latency becomes a concern.
 *
 * Use this for profile lean-snapshot CARs: the published pointer is the
 * snapshot's dag-cbor `rootCid`, and consumers fetch the root block via
 * `block/get(rootCid)`. Bundle CARs continue to use {@link pinToIpfs}
 * (bundle CIDs are raw-CIDs over the whole bundle CAR; the existing
 * pin-as-one-raw-block semantics still match). Migrating bundles to the
 * per-block model is a future step that would expose individual tokens /
 * sub-token components as addressable sub-CIDs in the hierarchical
 * profile model.
 *
 * The function trusts the caller-supplied `expectedRootCid` and returns
 * it on success — defense-in-depth posture mirroring {@link pinToIpfs}.
 *
 * @param gateways          - Array of IPFS gateway base URLs
 * @param carBytes          - CAR file bytes to import block-by-block
 * @param expectedRootCid   - The root CID claimed by the CAR header
 * @param timeoutMs         - Timeout per gateway+block (default: 60 000)
 * @returns The `expectedRootCid` on success.
 * @throws {ProfileError} `ORBITDB_WRITE_FAILED` if any block fails on all gateways.
 */
export async function pinCarBlocksToIpfs(
  gateways: string[],
  carBytes: Uint8Array,
  expectedRootCid: string,
  timeoutMs: number = DEFAULT_PIN_TIMEOUT_MS,
): Promise<string> {
  // Parse the CAR locally to extract each block. Done up front so a
  // malformed CAR fails fast before any network round-trips.
  const { CarReader } = await import('@ipld/car');
  let reader: InstanceType<typeof CarReader>;
  try {
    reader = await CarReader.fromBytes(carBytes);
  } catch (err) {
    throw new ProfileError(
      'ORBITDB_WRITE_FAILED',
      `Failed to parse CAR for block-by-block pinning: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const blocks: Array<{ cid: string; bytes: Uint8Array }> = [];
  for await (const block of reader.blocks()) {
    blocks.push({ cid: block.cid.toString(), bytes: block.bytes });
  }
  if (blocks.length === 0) {
    throw new ProfileError(
      'ORBITDB_WRITE_FAILED',
      'CAR contained zero blocks — refusing to publish a phantom rootCid.',
    );
  }
  // Sanity-check: the expected root must be present as one of the blocks.
  // This is a defense against a builder bug where the published rootCid
  // doesn't match anything inside the CAR.
  if (!blocks.some((b) => b.cid === expectedRootCid)) {
    throw new ProfileError(
      'ORBITDB_WRITE_FAILED',
      `expectedRootCid ${expectedRootCid} is not present among CAR blocks (count=${blocks.length}) — builder/publisher mismatch.`,
    );
  }

  // Pin each block sequentially. A single block failure aborts the
  // whole import: callers MUST see "all blocks pinned" or "publish
  // failed" — never a partial import that would leave the rootCid
  // pointing into a hole.
  for (const block of blocks) {
    await pinSingleBlock(gateways, block.bytes, block.cid, timeoutMs);
  }

  return expectedRootCid;
}

/**
 * Fetch content from IPFS by CID.
 * Tries each gateway in order, returns the bytes on first success.
 *
 * If the response includes a `Content-Length` header that exceeds
 * `maxSizeBytes`, the request is aborted immediately. Otherwise a
 * streaming reader enforces the size limit while reading the body.
 *
 * @param gateways     - Array of IPFS gateway base URLs
 * @param cid          - Content identifier to fetch
 * @param timeoutMs    - Timeout per gateway attempt (default: 30 000)
 * @param maxSizeBytes - Maximum response size (default: 50 MB)
 * @returns The fetched content as a `Uint8Array`
 * @throws {ProfileError} `BUNDLE_NOT_FOUND` if all gateways fail or
 *         the response exceeds the size limit.
 */
export async function fetchFromIpfs(
  gateways: string[],
  cid: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  maxSizeBytes: number = DEFAULT_MAX_SIZE_BYTES,
): Promise<Uint8Array> {
  const effectiveGateways = gateways.length > 0 ? gateways : [DEFAULT_IPFS_API_URL];
  // Steelman²⁸/²⁹ warning: validate gateway URLs via shared helper —
  // applies the same allowlist to fetchFromIpfs / pinToIpfs /
  // verifyCidAccessible (previous F.33 fix only validated fetchFromIpfs).
  validateGatewayUrls(effectiveGateways);
  let lastError: Error | null = null;

  // One attempt: try POST first, fall back to GET for gateways that
  // disable POST to /api/v0/. The fall-through is per-gateway —
  // failures roll over to the next gateway in the outer loop.
  const tryFetchBlock = async (
    gateway: string,
    method: 'POST' | 'GET',
  ): Promise<{ bytes: Uint8Array | null; reason: string | null; retryAsGet: boolean }> => {
    const url =
      `${gateway.replace(/\/$/, '')}/api/v0/block/get?arg=${encodeURIComponent(cid)}`;
    const response = await fetch(url, {
      method,
      headers: { Accept: 'application/octet-stream' },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      // POST disabled on this gateway? Retry as GET (Kubo's documented
      // alias) before giving up on the gateway.
      const retryAsGet =
        method === 'POST' && (response.status === 405 || response.status === 501);
      return {
        bytes: null,
        reason: `HTTP ${response.status} from ${gateway} (${method})`,
        retryAsGet,
      };
    }

    // Steelman fix W2 — sniff Content-Type so a "200 OK but it's HTML"
    // response (some hardened nginx fronts return an "API disabled"
    // page with 200) surfaces a useful error instead of the misleading
    // sha256-mismatch. block/get on a real Kubo returns
    // application/octet-stream (or unset, which we treat as raw).
    const contentType = (response.headers.get('Content-Type') ?? '').toLowerCase();
    const isHtmlOrJson =
      contentType.startsWith('text/html') || contentType.startsWith('application/json');
    if (isHtmlOrJson) {
      return {
        bytes: null,
        reason: `gateway ${gateway} returned ${contentType} for /api/v0/block/get (likely API disabled or wrong endpoint)`,
        retryAsGet: false,
      };
    }

    // Check Content-Length header before reading body
    const contentLength = response.headers.get('Content-Length');
    if (contentLength != null) {
      const size = parseInt(contentLength, 10);
      if (!isNaN(size) && size > maxSizeBytes) {
        return {
          bytes: null,
          reason: `Response size ${size} bytes exceeds limit of ${maxSizeBytes} bytes from ${gateway}`,
          retryAsGet: false,
        };
      }
    }

    // Always use streaming reader with size enforcement.
    // Content-Length is only a fast-reject pre-check — a malicious gateway
    // can set Content-Length: 1000 but stream 500MB.
    let bytes: Uint8Array;
    if (response.body != null) {
      bytes = await readStreamWithLimit(response.body, maxSizeBytes, gateway);
    } else {
      // Fallback for environments without ReadableStream (unlikely in Node 18+)
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > maxSizeBytes) {
        throw new ProfileError(
          'BUNDLE_NOT_FOUND',
          `Response ${buffer.byteLength} bytes exceeds limit ${maxSizeBytes} from ${gateway}`,
        );
      }
      bytes = new Uint8Array(buffer);
    }

    return { bytes, reason: null, retryAsGet: false };
  };

  for (const gateway of effectiveGateways) {
    try {
      let bytesOrNull: Uint8Array | null = null;
      // First attempt: POST (Kubo's declared method).
      let attempt = await tryFetchBlock(gateway, 'POST');
      if (attempt.bytes !== null) {
        bytesOrNull = attempt.bytes;
      } else if (attempt.retryAsGet) {
        // POST blocked on this gateway — retry as GET (Kubo accepts
        // it as a documented alias). Avoids skipping a healthy
        // gateway just because its proxy disables POST.
        const second = await tryFetchBlock(gateway, 'GET');
        if (second.bytes !== null) {
          bytesOrNull = second.bytes;
        } else {
          lastError = new Error(`${attempt.reason}; GET retry: ${second.reason}`);
          continue;
        }
      } else {
        lastError = new Error(attempt.reason ?? 'unknown gateway error');
        continue;
      }

      // Content-address verification. Without this, a malicious gateway can
      // substitute arbitrary bytes for any CID. After we removed CAR-level
      // encryption (see module doc) this check is the only authentication
      // layer against gateway tampering — do not remove it.
      //
      // NB: verification failures are RECOVERABLE — the next gateway may
      // return legitimate bytes. We must NOT short-circuit the outer
      // fallback loop with `throw err` the way size-limit failures do.
      // Catch and record as lastError so the next gateway is tried.
      try {
        verifyCidMatchesBytes(cid, bytesOrNull);
      } catch (verifyErr) {
        lastError =
          verifyErr instanceof Error ? verifyErr : new Error(String(verifyErr));
        continue;
      }

      return bytesOrNull;
    } catch (err) {
      // Size-limit ProfileError is fatal for this request (not per-gateway)
      // because the caller already constrained maxSizeBytes; retrying won't
      // make the content smaller. Other errors are per-gateway transient
      // failures — try the next gateway.
      if (err instanceof ProfileError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw new ProfileError(
    'BUNDLE_NOT_FOUND',
    `Failed to fetch CAR ${cid} from all gateways: ${lastError?.message ?? 'unknown error'}`,
    lastError,
  );
}

/**
 * Verify that `sha256(bytes)` matches the multihash digest encoded in
 * `cidString`. Only sha256 multihash is supported — this is the hash
 * used by every CID our pin path produces. Any other multihash codec
 * is treated as a verification failure and the bytes are rejected.
 *
 * @throws {ProfileError} `BUNDLE_NOT_FOUND` on mismatch or unsupported
 *         multihash code, so that the caller can try the next gateway.
 */
export function verifyCidMatchesBytes(cidString: string, bytes: Uint8Array): void {
  let parsed: CID;
  try {
    parsed = CID.parse(cidString);
  } catch (err) {
    throw new ProfileError(
      'BUNDLE_NOT_FOUND',
      `Cannot parse CID ${cidString}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 0x12 == sha2-256 multihash code
  if (parsed.multihash.code !== 0x12) {
    throw new ProfileError(
      'BUNDLE_NOT_FOUND',
      `Unsupported multihash code 0x${parsed.multihash.code.toString(16)} for CID ${cidString}; only sha2-256 is verified`,
    );
  }

  const expected = parsed.multihash.digest;
  const actual = sha256(bytes);
  if (!bytesEqual(expected, actual)) {
    throw new ProfileError(
      'BUNDLE_NOT_FOUND',
      `CID verification failed for ${cidString}: gateway returned bytes whose sha256 does not match the CID`,
    );
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Check if a CID is accessible on any gateway.
 *
 * Sends a HEAD request to each gateway in order and returns `true` on
 * the first successful response. Returns `false` if all gateways fail.
 *
 * @param gateways  - Array of IPFS gateway base URLs
 * @param cid       - Content identifier to verify
 * @param timeoutMs - Timeout per gateway attempt (default: 10 000)
 */
export async function verifyCidAccessible(
  gateways: string[],
  cid: string,
  timeoutMs: number = DEFAULT_VERIFY_TIMEOUT_MS,
): Promise<boolean> {
  const effectiveGateways = gateways.length > 0 ? gateways : [DEFAULT_IPFS_API_URL];
  validateGatewayUrls(effectiveGateways);

  for (const gateway of effectiveGateways) {
    try {
      const url = `${gateway.replace(/\/$/, '')}/ipfs/${cid}`;

      const response = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.ok) return true;
    } catch {
      // Try next gateway
    }
  }

  return false;
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Steelman²⁸/²⁹: shared IPFS gateway URL allowlist enforcement. Used by
 * fetchFromIpfs / pinToIpfs / verifyCidAccessible — they MUST all
 * route here so the allowlist applies to every code path.
 */
function validateGatewayUrls(gateways: readonly string[]): void {
  for (const gateway of gateways) {
    let u: URL;
    try {
      u = new URL(gateway);
    } catch (err) {
      throw new Error(
        `Invalid IPFS gateway URL "${gateway}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(
        `IPFS gateway URL must use http:// or https://, got "${gateway}" (protocol="${u.protocol}")`,
      );
    }
    if (u.username !== '' || u.password !== '') {
      throw new Error(`IPFS gateway URL must not contain userinfo: "${gateway}"`);
    }
  }
}

/**
 * Read a `ReadableStream<Uint8Array>` into a single `Uint8Array`, aborting
 * if the accumulated byte count exceeds `maxBytes`.
 */
async function readStreamWithLimit(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  gatewayLabel: string,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        reader.cancel();
        throw new ProfileError(
          'BUNDLE_NOT_FOUND',
          `Response from ${gatewayLabel} exceeded size limit of ${maxBytes} bytes (read ${totalBytes} so far)`,
        );
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  // Concatenate chunks into a single Uint8Array
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return result;
}
