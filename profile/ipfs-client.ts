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
import { logger } from '../core/logger.js';
import { ProfileError } from './errors.js';
import { runWithConcurrency } from './internal/concurrency.js';

// =============================================================================
// Issue #236 — Local-Helia primary blockstore
// =============================================================================

/**
 * Minimal structural shape of the Helia blockstore surface used by this
 * module. Declared locally so this file does not take a direct dependency
 * on `helia` types — callers pass the value returned by
 * `ProfileDatabase.getHelia()` (typed as `unknown`) and we cast inside.
 */
interface HeliaLike {
  readonly blockstore: {
    get(cid: CID, options?: unknown): Promise<Uint8Array>;
    put(cid: CID, bytes: Uint8Array, options?: unknown): Promise<unknown>;
    has?(cid: CID, options?: unknown): Promise<boolean>;
  };
}

/**
 * Narrow an `unknown` (the return of `ProfileDatabase.getHelia()`) into a
 * usable `HeliaLike` handle. Defensive — returns `null` if the value does
 * not expose the minimal `blockstore.get/put` surface we need so a
 * misconfigured adapter cannot crash the pin/fetch paths.
 */
function asHelia(value: unknown): HeliaLike | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return null;
  const obj = value as { blockstore?: unknown };
  if (!obj.blockstore || typeof obj.blockstore !== 'object') return null;
  const bs = obj.blockstore as { get?: unknown; put?: unknown };
  if (typeof bs.get !== 'function' || typeof bs.put !== 'function') return null;
  return value as HeliaLike;
}

/**
 * Best-effort write of a single block into the local Helia blockstore.
 *
 * Issue #236 — closes the gateway-propagation window. On the same
 * `dataDir`, the second process re-opens Helia with the same on-disk
 * blockstore directory and can read the block synchronously via
 * `blockstore.get` without waiting for HTTP gateway propagation
 * (~15s on testnet).
 *
 * Failures are LOGGED and SWALLOWED — local blockstore I/O issues
 * (full disk, lock contention, etc.) must not abort an otherwise-
 * successful HTTP pin. The fallback is the pre-#236 behaviour: the
 * caller's next-process load() reads via HTTP gateways, which becomes
 * available once propagation completes.
 *
 * @returns `true` if the local write succeeded, `false` on any error
 *          (logged via `logger.warn`). The return is informational
 *          (callers use it for tests); pin/fetch flow does not branch
 *          on the result.
 */
async function putBlockToLocalHelia(
  helia: HeliaLike,
  cidString: string,
  blockBytes: Uint8Array,
): Promise<boolean> {
  let parsed: CID;
  try {
    parsed = CID.parse(cidString);
  } catch (err) {
    logger.warn(
      'ipfs-client',
      `local-helia put: cannot parse CID ${cidString}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
  try {
    await helia.blockstore.put(parsed, blockBytes);
    return true;
  } catch (err) {
    logger.warn(
      'ipfs-client',
      `local-helia put failed for ${cidString} (continuing with HTTP pin): ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Try to satisfy a block fetch from the local Helia blockstore.
 *
 * Issue #236 — fast-path that skips HTTP gateways entirely when the
 * block is locally available (same-process cache hit OR cross-process
 * restart on the same `dataDir` where Helia's on-disk blockstore
 * persists).
 *
 * **Content verification (steelman remediation).** Helia's blockstore
 * is content-KEYED but NOT content-VERIFIED: `blockstore.put(cid, X)`
 * stores `X` under `cid` regardless of whether
 * `sha256(X) === cid.multihash.digest`. A corrupted on-disk store
 * (filesystem-level bit flip, partial-write crash residue, a malicious
 * party with disk access) could surface bytes that don't match the
 * requested CID. Without verification on read, garbage propagates to
 * downstream parsers and surfaces as an opaque "decode failed" error
 * far from the root cause. We re-instate the same content-address
 * check the HTTP path applies to gateway responses: on mismatch we LOG
 * and return `null` so the caller falls through to the HTTP gateway
 * loop — which either delivers an honest copy or surfaces a hard
 * `BUNDLE_NOT_FOUND` with full diagnostics. The cost is a single
 * `sha256(bytes)` per local read, dwarfed by the eliminated HTTP
 * round-trip on a clean cache hit.
 *
 * @returns the block bytes on a verified local hit, `null` when the
 *          block is absent, the local read errored, or the bytes
 *          failed CID-binding verification (caller continues with HTTP).
 */
async function tryGetBlockFromLocalHelia(
  helia: HeliaLike,
  cidString: string,
): Promise<Uint8Array | null> {
  let parsed: CID;
  try {
    parsed = CID.parse(cidString);
  } catch {
    return null;
  }
  let bytes: Uint8Array;
  try {
    // `{ offline: true }` is critical here. Without it, Helia's
    // default `blockstore.get` falls through from the local on-disk
    // store to a Bitswap network walk against connected libp2p peers
    // before throwing ERR_NOT_FOUND — a multi-second timeout that
    // would dominate the cross-device fetch path's latency. Our HTTP
    // gateway loop is the canonical "remote" surface; Bitswap from
    // arbitrary bootstrap-discovered peers is neither faster nor more
    // reliable than the gateways for the blocks we publish. Passing
    // `offline: true` makes a local miss return synchronously so the
    // caller falls through to HTTP without delay. See
    // `@helia/interface/dist/src/blocks.d.ts#GetOfflineOptions`.
    const got = await helia.blockstore.get(parsed, { offline: true });
    if (!(got instanceof Uint8Array) || got.byteLength === 0) {
      // Defensive: helia returned a non-Uint8Array (extreme edge case)
      // OR an empty-byte block — treat as a miss so the gateway loop
      // runs. A zero-length block is never legitimate in our schema
      // (every dag-cbor envelope and raw payload carries non-empty
      // bytes), so the fall-through is safe.
      return null;
    }
    bytes = got;
  } catch {
    // Block not present locally (helia throws ERR_NOT_FOUND) — caller
    // continues with the HTTP gateway loop. Other internal errors also
    // route through this miss path so a transient local-store glitch
    // does not block recovery via HTTP. With `offline: true`, this
    // path is reached IMMEDIATELY on local miss (no Bitswap detour).
    return null;
  }

  // Steelman remediation — verify the bytes hash to the requested CID.
  // Catches: ext4/zfs silent corruption, partial-write crash residue,
  // disk-side tampering, or a regression in our own writer that lets a
  // CID/bytes mismatch slip past `pinCarBlocksToIpfs`'s pin-time
  // verifier. On mismatch: log once, return null, fall through to
  // gateways (which apply their own verification on gateway-returned
  // bytes — see `verifyCidMatchesBytes` in `fetchFromIpfs`).
  try {
    verifyCidMatchesBytes(cidString, bytes);
  } catch (err) {
    logger.warn(
      'ipfs-client',
      `local-helia get returned bytes whose sha256 does NOT match ${cidString} ` +
        `(likely on-disk corruption); falling through to HTTP gateways: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  return bytes;
}

// SHA-256 multihash code (multiformats `sha2-256`).
const MULTIHASH_SHA256 = 0x12;
/** Length of a sha2-256 digest in bytes. */
const SHA256_DIGEST_BYTES = 32;

// =============================================================================
// Multicodec constants (subset used by the Profile/UXF stack)
// =============================================================================

/** raw multicodec (no further decoding — block bytes are the value). */
const CODEC_RAW = 0x55;

/** dag-cbor multicodec (deterministic CBOR with CID-link Tag 42). */
const CODEC_DAG_CBOR = 0x71;

/**
 * Safety bound on hierarchical CAR fetches. A poisoned root that links
 * to billions of unique sub-CIDs would otherwise drive `fetchCarFromIpfs`
 * unbounded — this hard-cap aborts after this many blocks. 10 000 is
 * generous for any plausible bundle today (the typical bundle has
 * envelope + manifest + token + element ≈ tens of blocks); revisit when
 * the hierarchical-bundle model in Phase 3 starts emitting wider DAGs.
 */
const FETCH_CAR_MAX_BLOCKS = 10_000;

// =============================================================================
// Constants
// =============================================================================

/** Default IPFS gateway URL (used when no gateways are provided). */
const DEFAULT_IPFS_API_URL = 'https://ipfs.unicity.network';

/** Default timeout for pin operations (ms). */
const DEFAULT_PIN_TIMEOUT_MS = 60_000;

/**
 * Default concurrency for `pinCarBlocksToIpfs`. Each in-flight slot is a
 * single HTTP POST to the sidecar; round-trip is ~80-150 ms regardless of
 * payload size, so serial = N × RTT and dominates wall-clock for any
 * non-trivial wallet (a 24-token migration emits ~250 blocks, which at
 * 100 ms each is ~25 s serial). 10 concurrent in-flight pins reduces the
 * same workload to ~2.5 s while staying well under typical browser
 * per-origin connection caps (Chrome's 6 HTTP/1.1 cap is multiplexed by
 * HTTP/2 on the sidecar). Overridable per-call to support stress tests
 * or sidecars with explicit per-client rate limits.
 *
 * Concurrency is bounded by a worker pool (not Promise.all over all
 * blocks) so memory stays O(concurrency × block-size) rather than
 * O(blocks × block-size) — important for migration of large wallets
 * where the CAR may contain thousands of blocks.
 */
const DEFAULT_PIN_CONCURRENCY = 10;

/**
 * Issue #360 Finding #5 — BFS frontier concurrency for the per-block
 * walk in `fetchCarFromIpfs`.
 *
 * The pre-fix walk fetched every block in the DAG sequentially. With
 * ~100 blocks per bundle and ~50 ms per fetch, a single bundle took
 * ~5 s on the gateway path. The frontier-parallel walk collapses each
 * BFS layer to `ceil(layer_size / cap) × per-block` wall-clock.
 *
 * 8 picked to stay under typical browser per-origin HTTP/1.1 socket
 * caps (Chrome's 6 is multiplexed by HTTP/2 on Kubo) while leaving
 * headroom for the bundle-level fetch pool above us (worst case both
 * caps multiply to 8 × 8 = 64 sockets, well under the 256 default
 * Node limit).
 */
const DEFAULT_DAG_WALK_FRONTIER_CONCURRENCY = 8;

/** Default timeout for fetch operations (ms). */
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/** Default timeout for verify (HEAD) operations (ms). */
const DEFAULT_VERIFY_TIMEOUT_MS = 10_000;

/** Default maximum response size for fetch operations (bytes). */
const DEFAULT_MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

// =============================================================================
// Issue #255 Problem B / ipfs-storage#7 — instant-pin sidecar submit
// =============================================================================

/**
 * Per-block upper bound for sidecar submissions. The sidecar's default
 * `SIDECAR_CACHE_MAX_BLOB_BYTES` is 32 MiB; anything larger gets a 413
 * back and is just wasted bandwidth. Stays comfortably above the
 * sphere-sdk Profile snapshot CAR block sizes (well under 256 KiB
 * for raw leaves, typically a few KiB for dag-cbor envelopes).
 */
const SIDECAR_SUBMIT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Per-call timeout for the fire-and-forget sidecar submit. Short by
 * design — the submit is an optimization, not a contract, and a slow
 * sidecar must not gate the pin-success return.
 */
const SIDECAR_SUBMIT_TIMEOUT_MS = 5_000;

/**
 * Per-attempt timeout for the {@link tryReadFromSidecar} fast-path
 * probe. Aggressively short — the sidecar is co-located with the
 * gateway nginx; if it can't answer in this window, the bytes
 * almost certainly aren't there and the request would be a waste.
 * Falling through to the normal `/api/v0/block/get` path costs
 * one ~100 ms RTT in any case.
 */
const SIDECAR_READ_TIMEOUT_MS = 500;

/**
 * Fire-and-forget POST the raw bytes that hash to `cid` to the
 * gateway's instant-pin sidecar (`/sidecar/submit?cid=<cid>`). Lets
 * cross-device readers fetch `cid` immediately after pin, before
 * Kubo's bitswap registration window closes (the dominant cross-
 * device race amplifier — see issue #255 Problem B, RFC-251).
 *
 * Contract:
 *   - Never throws. Never blocks the caller. Errors are swallowed
 *     via the trailing `.catch(() => {})`.
 *   - The bytes MUST hash to `cid` under the codec the sidecar
 *     reconciler will infer from the CID prefix (raw / dag-cbor /
 *     dag-pb). For the two call sites in this module (`pinToIpfs`,
 *     `pinSingleBlock`) this holds by construction; the sidecar's
 *     `_infer_block_put_params` handles the codec choice server-side.
 *   - If the gateway doesn't run the sidecar (e.g. `ipfs.io`), the
 *     POST 404s and is silently dropped — the primary pin already
 *     succeeded, so the bytes are durable in Kubo regardless.
 *   - 503 (cache_full back-pressure) and 413 (over 32 MiB) are
 *     handled identically: drop on the floor. The primary pin is
 *     the source of truth.
 */
function submitToSidecarBestEffort(
  gateway: string,
  cid: string,
  bytes: Uint8Array,
): void {
  if (typeof gateway !== 'string' || gateway.length === 0) return;
  if (typeof cid !== 'string' || cid.length === 0) return;
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return;
  if (bytes.length > SIDECAR_SUBMIT_MAX_BYTES) return;
  const url =
    `${gateway.replace(/\/$/, '')}/sidecar/submit?cid=${encodeURIComponent(cid)}`;
  // Detached fire-and-forget. The .catch swallows any rejection so
  // an unhandled-rejection doesn't surface; the void operator
  // discards the dangling promise reference so callers don't have
  // to ignore a `Promise<void>` they're not allowed to await.
  void fetch(url, {
    method: 'POST',
    body: bytes as BlobPart,
    headers: { 'Content-Type': 'application/octet-stream' },
    signal: AbortSignal.timeout(SIDECAR_SUBMIT_TIMEOUT_MS),
  })
    .then((response) => {
      // Drain the body so the connection releases promptly. Logged at
      // debug level for operator triage — Stage B.1 wants visibility
      // into how often sphere-sdk publishes actually populate the
      // cache vs how often they get 503-back-pressured or 4xx-rejected.
      if (!response.ok) {
        logger.debug(
          'IPFS-Sidecar',
          `submit ${cid.slice(0, 16)} → HTTP ${response.status} ` +
          `(${response.statusText}) on ${gateway}`,
        );
      } else {
        logger.debug(
          'IPFS-Sidecar',
          `submit ${cid.slice(0, 16)} → 200 on ${gateway}`,
        );
      }
      // Best-effort body drain — the sidecar returns small JSON; we
      // don't actually need its contents (the outcome is just diagnostic).
      response.body?.cancel?.().catch(() => { /* ignore */ });
    })
    .catch(() => {
      // Network error, timeout, gateway-without-sidecar (404 → ok=false
      // above), or AbortError. All silently dropped — the primary pin
      // already succeeded; this is pure optimization.
    });
}

/**
 * Read fast-path counterpart to {@link submitToSidecarBestEffort}.
 * Attempts `/sidecar/blob?cid=<cid>` against the supplied gateway with
 * a short timeout. Returns the bytes on a 200, `null` on anything
 * else (404 cache miss, gateway without sidecar, timeout, network
 * error). Never throws.
 *
 * Used by {@link fetchFromIpfs} to close the cross-device publish-
 * then-read window for CIDs a sibling device just submitted to the
 * sidecar. The window is ~5 s (until the reconciler promotes the
 * block to Kubo and removes it from sidecar disk); outside the
 * window the sidecar 404s and the caller falls through to the
 * normal `/api/v0/block/get` path.
 *
 * Important: the bytes returned by `/sidecar/blob` are the raw
 * block bytes (whatever the submitter posted). For single-block
 * CIDs (raw-leaf or dag-cbor envelope) these are bit-identical
 * to what `/api/v0/block/get` would return on a cache miss, so
 * the caller's downstream `verifyCidMatchesBytes` check still
 * succeeds. Multi-block UnixFS roots cannot round-trip through
 * the sidecar — but sphere-sdk's pin paths only submit
 * single-block CIDs, so the sidecar never serves multi-block
 * bytes for sphere-sdk-published CIDs.
 */
async function tryReadFromSidecar(
  gateway: string,
  cid: string,
): Promise<Uint8Array | null> {
  if (typeof gateway !== 'string' || gateway.length === 0) return null;
  if (typeof cid !== 'string' || cid.length === 0) return null;
  try {
    const url =
      `${gateway.replace(/\/$/, '')}/sidecar/blob?cid=${encodeURIComponent(cid)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/octet-stream' },
      signal: AbortSignal.timeout(SIDECAR_READ_TIMEOUT_MS),
    });
    if (!response.ok) {
      // 404 (cache miss / sidecar disabled) is the common case; drain
      // and return null so caller falls through to the normal fetch.
      response.body?.cancel?.().catch(() => { /* ignore */ });
      return null;
    }
    // Sniff content-type — a gateway that doesn't run the sidecar
    // may have a catch-all returning HTML/JSON for /sidecar/*; we
    // only trust application/octet-stream-like responses.
    const ct = (response.headers.get('Content-Type') ?? '').toLowerCase();
    if (
      ct &&
      !ct.startsWith('application/octet-stream') &&
      !ct.startsWith('application/vnd.ipld')
    ) {
      response.body?.cancel?.().catch(() => { /* ignore */ });
      return null;
    }
    const buf = await response.arrayBuffer();
    if (buf.byteLength === 0) return null;
    logger.debug(
      'IPFS-Sidecar',
      `read hit ${cid.slice(0, 16)} (${buf.byteLength} bytes) on ${gateway}`,
    );
    return new Uint8Array(buf);
  } catch {
    // Timeout, network error, abort — all treated as a miss. The
    // caller's normal-path fetch is the source of truth.
    return null;
  }
}

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
      // Issue #255 Problem B / ipfs-storage#7 — fire-and-forget submit
      // to the sidecar so cross-device readers can fetch the CID
      // immediately, before Kubo's bitswap registration window closes.
      // Always eligible here: `pinToIpfs` forces input-codec=raw, so
      // `expectedCid` is always a raw-leaf v1 (`bafkrei...`) and the
      // bytes that hash to it are exactly `data`. Gateway-targeted at
      // the SAME gateway that just succeeded the pin — if that gateway
      // doesn't run the sidecar, the POST 404s and is dropped silently.
      submitToSidecarBestEffort(gateway, expectedCid, data);
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
      // Issue #255 Problem B / ipfs-storage#7 — fire-and-forget submit
      // to the sidecar (same gateway). The bytes hash to `expectedCid`
      // by construction here (each block in a CAR satisfies
      // `sha256(block.bytes) === block.cid.multihash.digest` per Issue
      // #213 / Option C). The sidecar's `_infer_block_put_params`
      // handles raw / dag-cbor / dag-pb codecs by CID prefix — no
      // codec-specific gating needed on this side.
      submitToSidecarBestEffort(gateway, expectedCid, blockBytes);
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
 * canonical CID. The canonical primitive used across the whole SDK
 * whenever the published reference is a dag-cbor envelope CID over a
 * block INSIDE the CAR (or a raw CID over a single-block CAR, which
 * pins identically). Replaces the pre-issue-#199 `pinToIpfs(carBytes)`
 * pattern across all CAR-producing call sites: bundle CARs (Phase 2
 * of issue #200), consolidation CARs, manifest CARs, profile snapshot
 * CARs (lean v3 and fat v2), and the Nostr `uxf-cid` publisher (via
 * `createUxfCarPublisher`).
 *
 * Why not `/api/v0/dag/import`: the Unicity IPFS gateway does not expose
 * that endpoint. `dag/put` is universally available across Kubo deploys,
 * including hardened gateways that restrict the API surface. The
 * tradeoff is one HTTP round-trip per block.
 *
 * The function trusts the caller-supplied `expectedRootCid` and the
 * framed CIDs in the CAR (`@ipld/car`'s `CarReader` does NOT recompute
 * `sha256(bytes)` against the framed CID — it just slices framed
 * `{cid, bytes}` pairs from the stream).
 *
 * Issue #213 (Option C) reconciled the prior CID/bytes mismatch in
 * `uxf/ipld.ts:elementToIpldBlock`: sub-block bytes are now encoded in
 * the SAME canonical form used for content hashing (children as raw
 * 32-byte Uint8Array, not Tag 42 CID links), so
 * `sha256(block.bytes) === block.cid.multihash.digest` holds for every
 * UXF sub-block. The producer-side verification is performed
 * per-block below (a lightweight sanity check that catches builder
 * bugs without re-deriving the CIDs Kubo would assign). Receiver-side
 * verification continues via `fetchFromIpfs` (CID-binding check
 * against gateway-returned bytes).
 *
 * Issue #236 — when `helia` is supplied (the local Helia node managed by
 * the `OrbitDbAdapter`), each block is written to the local on-disk
 * blockstore BEFORE the HTTP gateway round-trip. This guarantees the
 * block is locally readable by the time `pinCarBlocksToIpfs` returns,
 * which closes the cross-process recovery window that previously
 * depended on HTTP gateway propagation (observed at ~15s on testnet).
 * Local writes are best-effort: failures are logged and the HTTP pin
 * proceeds unchanged. Callers without a local Helia (no on-disk
 * persistence, or test stubs) omit the argument and pay the gateway
 * propagation lag as before.
 *
 * @param gateways          - Array of IPFS gateway base URLs
 * @param carBytes          - CAR file bytes to import block-by-block
 * @param expectedRootCid   - The root CID claimed by the CAR header
 * @param timeoutMs         - Timeout per gateway+block (default: 60 000)
 * @param helia             - Optional local Helia node (see issue #236).
 *                            Pass the result of `OrbitDbAdapter.getHelia()`.
 * @param concurrency       - Maximum simultaneous in-flight block pins
 *                            (default: 10). Higher values may saturate
 *                            slow sidecars; lower values increase serial
 *                            tail. Non-positive / non-finite values are
 *                            clamped to 1.
 * @returns The `expectedRootCid` on success.
 * @throws {ProfileError} `ORBITDB_WRITE_FAILED` if all gateways fail to
 *         accept a pin or the CAR doesn't contain the expected root.
 */
export async function pinCarBlocksToIpfs(
  gateways: string[],
  carBytes: Uint8Array,
  expectedRootCid: string,
  timeoutMs: number = DEFAULT_PIN_TIMEOUT_MS,
  helia?: unknown,
  concurrency: number = DEFAULT_PIN_CONCURRENCY,
): Promise<string> {
  const localHelia = asHelia(helia);
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
  // Issue #213 (Option C) — UXF element bytes are now encoded in the
  // SAME canonical form used for hashing (children as raw 32-byte
  // Uint8Array; predecessor in `header[3]` likewise). That makes
  // `sha256(block.bytes) === block.cid.multihash.digest` hold for
  // every sub-block of every legitimate bundle CAR. Kubo's `dag/put`
  // re-derives the CID from the bytes; under Option C it agrees with
  // our locally claimed CID, so the per-block pin/fetch round-trips
  // succeed under the same CID we publish in the manifest.
  //
  // We don't run a uniform `verifyCidMatchesBytes` here — that's a
  // receiver-side defense (gateway tampering). The producer is the
  // bytes' authority. If a future builder bug breaks the equivalence,
  // it would surface immediately as a downstream `fetchFromIpfs`
  // mismatch on the next consumer fetch.
  //
  // Backward-compatibility note: legacy bundle CARs produced before
  // #213 encoded children as Tag 42 CID links. Their sub-block CIDs
  // did not match `sha256(bytes)`. They remain readable by the
  // hierarchical walker (`walkUxfElement` accepts both forms) but
  // cannot be pinned under their original CIDs by `pinCarBlocksToIpfs`
  // — a fresh export via `exportToCar` will produce the new canonical
  // form. The dual-codec receiver in `fetchCarFromIpfs` continues to
  // accept the legacy single-block raw-codec CARs from the #212
  // interim, so in-flight wallet pointers remain reachable.
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

  // Pin blocks with bounded concurrency. A single block failure aborts
  // the whole import: callers MUST see "all blocks pinned" or "publish
  // failed" — never a partial import that would leave the rootCid
  // pointing into a hole.
  //
  // Concurrency model: a fixed-size worker pool draws from a shared
  // monotonic index into `blocks`. Each worker iterates until the index
  // is exhausted, processing one block at a time (local Helia put then
  // HTTP pin). In-flight HTTP is bounded at exactly `concurrency` —
  // important for sidecars / browsers with per-origin connection caps.
  //
  // Memory: once `CarReader.fromBytes(carBytes)` materialises the block
  // index, the full `blocks[]` array is held in scope for the entire
  // pin operation (every worker closes over it). So peak memory is
  // O(N_blocks × block-size) + O(concurrency) for HTTP buffers —
  // dominated by the parsed CAR, not the pin parallelism. (A future
  // optimisation could stream blocks via `reader.blocks()` with a
  // producer-consumer queue, but the CAR-as-bytes input already
  // requires the full payload in memory, so this is bounded by the
  // CAR-build step upstream.)
  //
  // Error handling: a worker that fails sets the shared `aborted` flag
  // so peer workers short-circuit on their next iteration. Each worker
  // is wrapped via `.catch()` so a late rejection AFTER the first
  // failure cannot surface as `UnhandledPromiseRejection` (which would
  // either log spurious warnings or — in strict / `--unhandled-
  // rejections=strict` mode — terminate the host process). All worker
  // errors are collected into `workerErrors[]`; we throw the first one
  // so the caller sees the deterministic root cause rather than a
  // race-dependent variant. In-flight pin POSTs at the moment of abort
  // run to completion naturally (sidecar timeout) — no resource leak
  // because IPFS pins are idempotent at the same CID and the sidecar
  // bounds its own request lifetime.
  //
  // Issue #236 — when a local Helia handle is supplied, write each
  // block to its on-disk blockstore BEFORE the HTTP pin. This makes
  // the block readable to a subsequent same-`dataDir` process via
  // `blockstore.get` regardless of HTTP gateway propagation. Local
  // failures are logged and swallowed (the HTTP path remains the
  // source of truth for replication and cross-device recovery).
  //
  // Steelman remediation (#236 follow-up): Helia's blockstore is
  // content-KEYED, not content-VERIFIED — `blockstore.put(cid, X)`
  // stores `X` under `cid` regardless of `sha256(X) ===
  // cid.multihash.digest`. Pre-#236 a builder bug emitting a CAR with
  // a framed CID that didn't match its bytes was masked by Kubo's
  // server-side recompute (the gateway stored under the truthful CID
  // and the published lie-CID became unreachable, surfacing as a clear
  // `BUNDLE_NOT_FOUND` at fetch time). The #236 fast-path bypasses
  // that implicit guard: a lie would silently cache locally and survive
  // the read path's verification on a future cross-process load.
  //
  // We re-instate the guard explicitly: every block is checked against
  // `sha256(bytes) === cid.multihash.digest` BEFORE the local put.
  // On mismatch we SKIP the local put for that block (so we never
  // poison the on-disk store) but PROCEED with the HTTP pin so the
  // pre-#236 behaviour (Kubo redirects to truthful CID, lie becomes
  // unreachable) is preserved bit-for-bit. We log loudly so a
  // regression in our own CAR builder is visible in operator telemetry.
  const effectiveConcurrency = Math.max(
    1,
    Number.isFinite(concurrency) ? Math.floor(concurrency) : DEFAULT_PIN_CONCURRENCY,
  );
  const workerCount = Math.min(effectiveConcurrency, blocks.length);

  let nextIndex = 0;
  let aborted = false;
  const workerErrors: unknown[] = [];

  const processOne = async (block: { cid: string; bytes: Uint8Array }): Promise<void> => {
    if (localHelia !== null) {
      let cidBindingOk = true;
      try {
        verifyCidMatchesBytes(block.cid, block.bytes);
      } catch (err) {
        cidBindingOk = false;
        logger.warn(
          'ipfs-client',
          `pinCarBlocksToIpfs: producer-side CID/bytes mismatch for ${block.cid} ` +
            `— skipping local-helia put to avoid poisoning the on-disk store. ` +
            `Continuing with HTTP pin (Kubo will redirect to the truthful CID). ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (cidBindingOk) {
        await putBlockToLocalHelia(localHelia, block.cid, block.bytes);
      }
    }
    await pinSingleBlock(gateways, block.bytes, block.cid, timeoutMs);
  };

  const worker = async (): Promise<void> => {
    while (!aborted) {
      // Atomic index claim — V8 single-threaded model guarantees no
      // microtask interleaves between read and write of `nextIndex++`.
      // (Any future refactor that adds an `await` between read and
      // write would break this and is caught by the index-tracking
      // assertion in `tests/unit/profile/ipfs-client-parallel-pin.test.ts`.)
      const i = nextIndex++;
      if (i >= blocks.length) return;
      try {
        await processOne(blocks[i]);
      } catch (err) {
        // First failure tips the shared abort flag so peer workers
        // exit on their next iteration rather than uselessly pinning
        // additional blocks that the caller will discard anyway.
        aborted = true;
        throw err;
      }
    }
  };

  // Wrap each worker in a `.catch()` so a late rejection (after the
  // first failure already armed `aborted`) is absorbed locally rather
  // than escaping as an UnhandledPromiseRejection — operationally
  // visible (Node logs a warning, strict mode aborts the host process)
  // even though the original throw is already surfaced via `workerErrors`.
  // Steelman finding P1#1 — pre-fix `Promise.all(workers)` would short-
  // circuit on the first reject and leave 9 peer workers' eventual
  // rejections unattached.
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(
      worker().catch((err: unknown) => {
        workerErrors.push(err);
      }),
    );
  }
  await Promise.all(workers);

  if (workerErrors.length > 0) {
    // Throw the first observed failure so the caller sees a
    // deterministic root cause rather than a race-dependent variant.
    // Subsequent errors (typically the same shape — e.g., all workers
    // failed against a downed sidecar) are discarded; if operator
    // diagnostics need them, attach a `storage:error` event before
    // re-throwing in a future enhancement.
    throw workerErrors[0];
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
 * Issue #236 — when `helia` is supplied (the local Helia node managed by
 * the `OrbitDbAdapter`), the local on-disk blockstore acts as a
 * **bidirectional cache** for HTTP IPFS gateway content:
 *
 *   1. **Local-first read**: the local blockstore is consulted FIRST
 *      with `{ offline: true }`. A local hit returns synchronously
 *      without any HTTP round-trip OR Bitswap detour, eliminating
 *      gateway propagation as the bottleneck for cross-process
 *      recovery on the same `dataDir`. Local returns are
 *      content-verified against the requested CID (defends against
 *      fs-level corruption — see `tryGetBlockFromLocalHelia`).
 *   2. **Write-back on HTTP success**: bytes successfully fetched from
 *      an HTTP gateway (after `verifyCidMatchesBytes` passes) are
 *      written back to the local blockstore before being returned. So
 *      the second access to the same CID, from this process or any
 *      future process on the same `dataDir`, becomes a local hit.
 *
 * Together with the pin-time write in `pinCarBlocksToIpfs`, this gives
 * the **cache invariant**: any CID we have ever pinned or fetched is
 * present locally for fast subsequent reads. Cross-device recovery
 * (different machine, empty local helia) still works via the HTTP
 * gateway fallback exactly as before, and the first fetch warms the
 * local cache for everything that follows.
 *
 * @param gateways     - Array of IPFS gateway base URLs
 * @param cid          - Content identifier to fetch
 * @param timeoutMs    - Timeout per gateway attempt (default: 30 000)
 * @param maxSizeBytes - Maximum response size (default: 50 MB)
 * @param helia        - Optional local Helia node (see issue #236).
 *                       Pass the result of `OrbitDbAdapter.getHelia()`.
 * @returns The fetched content as a `Uint8Array`
 * @throws {ProfileError} `BUNDLE_NOT_FOUND` if all gateways fail or
 *         the response exceeds the size limit.
 */
export async function fetchFromIpfs(
  gateways: string[],
  cid: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  maxSizeBytes: number = DEFAULT_MAX_SIZE_BYTES,
  helia?: unknown,
): Promise<Uint8Array> {
  // Issue #236 — local Helia blockstore fast-path. When the block was
  // pinned through this process (or any prior process with the same
  // `dataDir`), it is already on disk and a synchronous get() avoids
  // HTTP gateway propagation entirely.
  const localHelia = asHelia(helia);
  if (localHelia !== null) {
    const local = await tryGetBlockFromLocalHelia(localHelia, cid);
    if (local !== null) {
      if (local.byteLength > maxSizeBytes) {
        // Defensive: a local block that exceeds the caller's size cap
        // is still a miss for the caller's contract. Fall through to
        // gateways (which apply their own enforcement) rather than
        // returning oversized bytes.
      } else {
        return local;
      }
    }
  }

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

  // Issue #255 Problem B / ipfs-storage#7 — read fast-path. Probe
  // the FIRST gateway's `/sidecar/blob?cid=<cid>` ONCE before the
  // normal multi-gateway loop. On a hit (bytes a sibling device
  // submitted within the last ~5 s window) the cross-device read
  // closes in sub-50 ms instead of paying the Kubo bitswap
  // registration window. On a miss / non-sidecar gateway / timeout
  // the helper returns null and the normal flow runs unchanged.
  // 500 ms ceiling per `SIDECAR_READ_TIMEOUT_MS`.
  if (effectiveGateways.length > 0) {
    const sidecarBytes = await tryReadFromSidecar(effectiveGateways[0], cid);
    if (sidecarBytes !== null && sidecarBytes.byteLength <= maxSizeBytes) {
      try {
        verifyCidMatchesBytes(cid, sidecarBytes);
        // Write-back to local Helia so subsequent same-`dataDir`
        // process loads hit the local-first read path (mirror the
        // gateway-fetch write-back at line 920 below).
        if (localHelia !== null) {
          await putBlockToLocalHelia(localHelia, cid, sidecarBytes);
        }
        return sidecarBytes;
      } catch (verifyErr) {
        // CID mismatch on sidecar bytes is a serious operational
        // signal: the sidecar's cache served bytes that don't hash
        // to the CID we asked for. Could be a rogue cache, a
        // submission-side codec mismatch, or in-flight bit-rot.
        // Don't throw — fall through to `/api/v0/block/get` so the
        // normal flow's own CID-verify either confirms (Kubo also
        // bad → caller surfaces ProfileError) or recovers (Kubo
        // good → caller gets right bytes). Warn so operators can
        // see the sidecar misbehavior even though the wallet
        // self-heals.
        logger.warn(
          'IPFS-Sidecar',
          `read CID mismatch on ${cid.slice(0, 16)} from ` +
          `${effectiveGateways[0]} (${sidecarBytes.byteLength} bytes); ` +
          `falling through to /api/v0/block/get. Reason: ` +
          `${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)}`,
        );
      }
    }
  }

  for (const gateway of effectiveGateways) {
    try {
      let bytesOrNull: Uint8Array | null = null;
      // First attempt: POST (Kubo's declared method).
      const attempt = await tryFetchBlock(gateway, 'POST');
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

      // Issue #236 follow-up — symmetric write-back: populate the
      // local Helia blockstore with content we just fetched from an
      // HTTP gateway, so the NEXT read (this process or any future
      // process on the same `dataDir`) is a local hit. Combined with
      // the pin-time local-put (`pinCarBlocksToIpfs`), this gives the
      // bidirectional cache invariant: "if we've ever seen a CID via
      // local or remote, the next read from either side is a local
      // hit."
      //
      // Safe by construction: the bytes have just passed
      // `verifyCidMatchesBytes` above, so we never write a CID/bytes
      // mismatch into the local store. Best-effort: a write failure
      // (disk full, lock contention) logs and we still return the
      // bytes to the caller. The pin-time guard in
      // `pinCarBlocksToIpfs` AND the read-time guard in
      // `tryGetBlockFromLocalHelia` both re-check on any future
      // access, so a transient write failure here just means the
      // next access incurs another HTTP round-trip — never wrong
      // bytes.
      if (localHelia !== null) {
        await putBlockToLocalHelia(localHelia, cid, bytesOrNull);
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
 * Fetch a hierarchical CAR rooted at `rootCid` by walking dag-cbor CID
 * links starting from the root block, and reassemble all collected
 * blocks into a single CARv1 byte stream rooted at `rootCid`.
 *
 * This is the symmetric consumer-side helper for {@link pinCarBlocksToIpfs}:
 * - **Producer** pins each block in the CAR under its canonical CID via
 *   `dag/put` (so every block is individually addressable).
 * - **Consumer** walks the DAG starting from the root, fetching each
 *   block via `block/get` and reassembling a synthetic CAR so existing
 *   `UxfPackage.fromCar(carBytes)` consumers don't have to change.
 *
 * **Backward compatibility with raw-codec roots.** Older bundles were
 * pinned as a single raw block whose CID equals `sha256(carBytes)`. For
 * those CIDs the bytes returned by `block/get` ARE the CAR — we detect
 * this by the CID codec (`raw` = 0x55) and short-circuit to a single
 * `fetchFromIpfs` call. This keeps in-flight wallet refs working through
 * the migration even though the {@link issue 200} non-goal disclaims
 * formal back-compat with the pre-#199 raw-pinning scheme.
 *
 * **Safety bounds.** The walk aborts when block count exceeds
 * {@link FETCH_CAR_MAX_BLOCKS} (currently 10 000) or when any single
 * block fetch exceeds `maxSizeBytesPerBlock` (defaults to the
 * `fetchFromIpfs` size cap). Content verification is end-to-end:
 * every fetched block is sha256-checked against its CID by
 * `fetchFromIpfs` — a hostile gateway cannot substitute different bytes
 * for any block.
 *
 * **What it does NOT do.** It does not check for "unreachable" blocks
 * (blocks pinned alongside the root but not referenced from it) — the
 * walk is reachability-from-root, exactly what `UxfPackage.fromCar`
 * consumes downstream. It also does not detect cycles by codec
 * mismatch; raw-codec children of a dag-cbor parent are treated as
 * opaque leaves (no further walk), which is the correct behavior for
 * the Profile/UXF model where all linkable blocks are dag-cbor.
 *
 * Issue #236 — forwards an optional `helia` handle to the per-block
 * `fetchFromIpfs` calls, so every block walked by the BFS is satisfied
 * from the local Helia blockstore first when available. This makes
 * cross-process recovery on the same `dataDir` independent of HTTP
 * gateway propagation lag.
 *
 * @param gateways              - IPFS gateway base URLs (allowlist-validated)
 * @param rootCid               - The CARv1 root CID (CIDv1 base32)
 * @param timeoutMs             - Per-block fetch timeout (default 30 000)
 * @param maxSizeBytesPerBlock  - Per-block byte cap (default 50 MiB)
 * @param helia                 - Optional local Helia node (see issue #236).
 *                                Pass the result of `OrbitDbAdapter.getHelia()`.
 * @returns The reassembled CARv1 bytes (root = `rootCid`, all blocks
 *          collected via BFS dag-cbor link walk)
 * @throws {ProfileError} `BUNDLE_NOT_FOUND` when any block fetch fails
 *         on every gateway, when the block count cap is exceeded, or
 *         when the root codec is neither `raw` nor `dag-cbor`.
 */
export async function fetchCarFromIpfs(
  gateways: string[],
  rootCid: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  maxSizeBytesPerBlock: number = DEFAULT_MAX_SIZE_BYTES,
  helia?: unknown,
): Promise<Uint8Array> {
  let parsedRoot: CID;
  try {
    parsedRoot = CID.parse(rootCid);
  } catch (err) {
    throw new ProfileError(
      'BUNDLE_NOT_FOUND',
      `fetchCarFromIpfs: cannot parse root CID ${rootCid}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Backcompat path: the legacy raw-pinning scheme pinned the entire
  // CAR as one raw block. `fetchFromIpfs` already returns the bytes
  // verbatim — they ARE the CAR. Skip the walk.
  if (parsedRoot.code === CODEC_RAW) {
    return fetchFromIpfs(gateways, rootCid, timeoutMs, maxSizeBytesPerBlock, helia);
  }
  if (parsedRoot.code !== CODEC_DAG_CBOR) {
    throw new ProfileError(
      'BUNDLE_NOT_FOUND',
      `fetchCarFromIpfs: unsupported root codec 0x${parsedRoot.code.toString(16)} for ${rootCid} ` +
        `(expected dag-cbor 0x71 or raw 0x55)`,
    );
  }

  // Lazy-import @ipld/dag-cbor + CarWriter to keep the cold-path import
  // off the synchronous load of every module that touches ipfs-client.
  const { decode: dagCborDecode } = await import('@ipld/dag-cbor');
  const { CarWriter } = await import('@ipld/car/writer');

  // Issue #360 Finding #5 — BFS layer-parallel walk.
  //
  // The pre-fix loop popped CIDs one at a time and awaited each
  // `fetchFromIpfs` sequentially. With ~50ms per gateway HEAD/GET and
  // ~100 blocks per bundle, that was ~5s per CAR even on a healthy
  // network. The new walk drains the entire current frontier in
  // parallel (bounded by DEFAULT_DAG_WALK_FRONTIER_CONCURRENCY) and
  // only awaits decode + child-enqueue serially because decoding
  // is microsecond-cheap.
  //
  // Invariants preserved:
  //   * Visit-set dedup — frontier entries are de-duplicated against
  //     `visited` BEFORE the parallel fetch, so the same CID never
  //     fans out into multiple in-flight requests.
  //   * Block-cap abort — checked after each frontier resolves so a
  //     hostile fan-out is still bounded by FETCH_CAR_MAX_BLOCKS.
  //   * Root-first ordering — `rootCid` is the sole frontier-0 entry
  //     and is pushed into `blocks` before any children. Within a
  //     frontier, blocks land in `runWithConcurrency`'s input-index
  //     order (i.e. the order children were enqueued in the previous
  //     layer), so the CAR write order remains deterministic across
  //     repeated walks of the same DAG.
  //   * Error/timeout semantics — `fetchFromIpfs` and `CID.parse`
  //     throw the same `ProfileError`s as before; the first failure
  //     in a frontier aborts the walk (via `runWithConcurrency`).
  const visited = new Set<string>();
  const blocks: Array<{ cid: CID; bytes: Uint8Array }> = [];
  let frontier: string[] = [rootCid];

  while (frontier.length > 0) {
    if (blocks.length + frontier.length > FETCH_CAR_MAX_BLOCKS) {
      throw new ProfileError(
        'BUNDLE_NOT_FOUND',
        `fetchCarFromIpfs: block count exceeded ${FETCH_CAR_MAX_BLOCKS} walking from ${rootCid} ` +
          `(possible cyclic or maliciously-fanned-out DAG)`,
      );
    }

    // De-dupe & parse the frontier BEFORE fetching so we never spawn
    // two in-flight requests for the same CID.
    const toFetch: Array<{ cidStr: string; cid: CID }> = [];
    for (const cidStr of frontier) {
      if (visited.has(cidStr)) continue;
      visited.add(cidStr);
      let blockCid: CID;
      try {
        blockCid = CID.parse(cidStr);
      } catch (err) {
        throw new ProfileError(
          'BUNDLE_NOT_FOUND',
          `fetchCarFromIpfs: child CID ${cidStr} (reachable from ${rootCid}) failed to parse: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      toFetch.push({ cidStr, cid: blockCid });
    }
    if (toFetch.length === 0) {
      frontier = [];
      continue;
    }

    // Fetch every block in this frontier in parallel (bounded).
    const fetched = await runWithConcurrency(
      toFetch,
      DEFAULT_DAG_WALK_FRONTIER_CONCURRENCY,
      async ({ cidStr, cid }) => {
        const bytes = await fetchFromIpfs(
          gateways,
          cidStr,
          timeoutMs,
          maxSizeBytesPerBlock,
          helia,
        );
        return { cid, cidStr, bytes };
      },
    );

    // Append to `blocks` in input-index order (root-first preserved).
    for (const f of fetched) {
      blocks.push({ cid: f.cid, bytes: f.bytes });
    }

    // Decode dag-cbor children to build the next frontier. Decoding is
    // synchronous and microsecond-cheap so it stays serial; it would
    // not benefit from worker parallelism.
    const nextFrontier: string[] = [];
    const enqueueChild = (childCid: CID): void => {
      const childStr = childCid.toString();
      if (!visited.has(childStr)) nextFrontier.push(childStr);
    };
    for (const f of fetched) {
      if (f.cid.code !== CODEC_DAG_CBOR) {
        // Raw and unknown codecs are leaves — no links to walk. Matches
        // the pre-fix behaviour (see the "Only dag-cbor blocks can
        // carry inter-block references" comment removed above).
        continue;
      }
      let decoded: unknown;
      try {
        decoded = dagCborDecode(f.bytes);
      } catch (err) {
        throw new ProfileError(
          'BUNDLE_NOT_FOUND',
          `fetchCarFromIpfs: dag-cbor decode failed for ${f.cidStr} (reachable from ${rootCid}): ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }
      // Issue #213 (Option C): UXF element blocks encode children as
      // raw 32-byte hash bytes (CBOR bstr) — the SAME canonical form
      // used for hashing — so `sha256(bytes) === cid.multihash.digest`
      // for every element block. The generic `CID.asCID`-based walker
      // misses these references because they're Uint8Array, not Tag 42
      // CID objects. Detect UXF shape and walk via
      // `contentHashBytesToCid` instead. Falls through to the generic
      // walker for envelope, manifest, and lean-snapshot blocks (which
      // continue to use CID-link references).
      if (isUxfElement(decoded)) {
        walkUxfElement(decoded, enqueueChild);
      } else {
        collectCidLinks(decoded, enqueueChild);
      }
    }
    frontier = nextFrontier;
  }

  // Reassemble a CAR with `rootCid` as the single root and all walked
  // blocks in BFS order (mirrors `exportToCar`'s ordering invariant in
  // uxf/ipld.ts so receivers that depend on root-then-manifest-first
  // continue to see the canonical order).
  const { writer, out } = CarWriter.create([parsedRoot]);
  const chunks: Uint8Array[] = [];
  const collectPromise = (async () => {
    for await (const chunk of out) {
      chunks.push(chunk);
    }
  })();
  try {
    for (const block of blocks) {
      await writer.put(block);
    }
  } finally {
    await writer.close();
  }
  await collectPromise;

  let totalLength = 0;
  for (const c of chunks) totalLength += c.length;
  const carBytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const c of chunks) {
    carBytes.set(c, offset);
    offset += c.length;
  }
  return carBytes;
}

/**
 * Recursively walk a dag-cbor-decoded value, invoking `visit` on every
 * CID instance found. Schema-agnostic — works for any dag-cbor block
 * shape because dag-cbor decodes CID links (Tag 42) into actual
 * `multiformats/cid` `CID` instances.
 *
 * `CID.asCID(value)` is the canonical predicate ("is this a CID?")
 * across both `multiformats` major versions; it returns the CID on
 * match or `null` otherwise (it does NOT throw).
 */
function collectCidLinks(value: unknown, visit: (cid: CID) => void): void {
  if (value === null || value === undefined) return;
  // Strings/numbers/bigints/booleans/Uint8Array — no links possible.
  if (typeof value !== 'object') return;
  if (value instanceof Uint8Array) return;

  const asCid = CID.asCID(value as CID);
  if (asCid !== null) {
    visit(asCid);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectCidLinks(item, visit);
    return;
  }

  // Maps from dag-cbor decode are plain objects; walk all values.
  // (We don't walk keys — dag-cbor restricts map keys to strings.)
  for (const v of Object.values(value as Record<string, unknown>)) {
    collectCidLinks(v, visit);
  }
}

// ---------------------------------------------------------------------------
// UXF-aware walker (issue #213, Option C)
// ---------------------------------------------------------------------------

/**
 * Internal type guard: detect the structural shape of a UXF element
 * block as produced by `uxf/ipld.ts:elementToIpldBlock`.
 *
 * A UXF element block is a dag-cbor map with four keys:
 *   - `header`:   array of length >= 4 ([representation, semantics,
 *                 kind, predecessor]); predecessor is `null` or a
 *                 32-byte Uint8Array (sha-256 digest).
 *   - `type`:     integer type ID (see `ELEMENT_TYPE_IDS` in
 *                 `uxf/types.ts`).
 *   - `content`:  object map (per-type schema).
 *   - `children`: object map; values are `null`, 32-byte Uint8Array,
 *                 or arrays thereof. Issue #213 transition tolerates
 *                 legacy Tag 42 CID values too, but the walker only
 *                 follows Uint8Array references — CID children are
 *                 redundantly handled by the generic walker fallback.
 *
 * The check is intentionally permissive on `content` (per-type schema
 * variance) and tight on the four-key surface that distinguishes UXF
 * elements from envelope / manifest / lean-snapshot blocks. False
 * positives are harmless: the worst case is that `walkUxfElement`
 * runs against a non-element shape and finds no Uint8Array children
 * (returns no CIDs, matching the safe fallback behaviour). False
 * negatives would silently break per-block traversal — keep the
 * predicate stable.
 */
function isUxfElement(value: unknown): value is {
  header: unknown[];
  type: number;
  content: Record<string, unknown>;
  children: Record<string, unknown>;
} {
  if (value === null || typeof value !== 'object') return false;
  if (value instanceof Uint8Array) return false;
  if (Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.header)) return false;
  if (obj.header.length < 4) return false;
  if (typeof obj.type !== 'number') return false;
  if (typeof obj.content !== 'object' || obj.content === null) return false;
  if (Array.isArray(obj.content)) return false;
  if (typeof obj.children !== 'object' || obj.children === null) return false;
  if (Array.isArray(obj.children)) return false;
  return true;
}

/**
 * Convert a 32-byte sha2-256 content hash digest (raw bytes) into a
 * CIDv1 with dag-cbor codec — the inverse of
 * `uxf/ipld.ts:contentHashToCid`. Mirrors that function locally so the
 * Profile package doesn't take a cross-package dependency on `uxf/` for
 * a hot fetch path.
 */
function contentHashBytesToCid(bytes: Uint8Array): CID {
  return CID.createV1(CODEC_DAG_CBOR, createMultihash(MULTIHASH_SHA256, bytes));
}

/**
 * Walk a UXF element block and invoke `visit` on every child CID
 * reference. Issue #213 (Option C) — UXF element blocks encode
 * `children` values as raw 32-byte Uint8Array digests (CBOR bstr) and
 * `header[3]` (predecessor) the same way. Each 32-byte digest is
 * converted into a CIDv1(dag-cbor, sha2-256) so the BFS walker treats
 * it as a normal child link.
 *
 * Mixed-form tolerance: a single element with a legacy Tag 42 CID
 * value alongside a Uint8Array value is visited correctly — Uint8Array
 * via `contentHashBytesToCid`, CID via `CID.asCID`. No producer emits
 * mixed shapes; the dual handling exists for the cutover window.
 *
 * Items of unexpected length (not 32 bytes) are silently skipped:
 * malformed bytes that survived `importFromCar`'s validation would
 * fail downstream verification anyway, so the walker stays liberal.
 */
function walkUxfElement(
  node: {
    header: unknown[];
    children: Record<string, unknown>;
  },
  visit: (cid: CID) => void,
): void {
  // Walk header[3] (predecessor). New canonical form encodes it as a
  // 32-byte Uint8Array. `header[0..2]` are scalar fields (numbers /
  // strings) with no link references.
  const predecessor = node.header[3];
  if (predecessor instanceof Uint8Array && predecessor.byteLength === SHA256_DIGEST_BYTES) {
    visit(contentHashBytesToCid(predecessor));
  } else {
    const asCid = predecessor != null ? CID.asCID(predecessor as CID) : null;
    if (asCid !== null) visit(asCid);
  }

  // Walk children. Each value is null | Uint8Array(32) | CID | array
  // of the prior.
  for (const value of Object.values(node.children)) {
    walkUxfChildValue(value, visit);
  }
}

function walkUxfChildValue(value: unknown, visit: (cid: CID) => void): void {
  if (value === null || value === undefined) return;
  if (value instanceof Uint8Array) {
    if (value.byteLength === SHA256_DIGEST_BYTES) {
      visit(contentHashBytesToCid(value));
    }
    return;
  }
  const asCid = CID.asCID(value as CID);
  if (asCid !== null) {
    visit(asCid);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkUxfChildValue(item, visit);
  }
  // Unknown shapes: silently skip — the importFromCar path would have
  // rejected them on the receiver side.
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

/**
 * Result of a retrying gateway accessibility check.
 * Issue #239 — used by `LifecycleManager.shutdown` to gate
 * `Sphere.destroy()` on remote IPFS pin durability.
 */
export interface VerifyCidAccessibleResult {
  /** True iff at least one gateway served the CID within the deadline. */
  readonly ok: boolean;
  /** Number of attempts that ran (1+ even on immediate success). */
  readonly attempts: number;
  /** Wall-clock elapsed in ms. */
  readonly elapsedMs: number;
  /**
   * Reason on failure: `gateway-not-serving` (every attempt returned
   * a non-2xx from every gateway), `deadline-exceeded` (ran out of
   * time mid-loop), or `aborted` (external abort signal fired). Absent
   * on success.
   */
  readonly failureKind?: 'gateway-not-serving' | 'deadline-exceeded' | 'aborted';
}

/**
 * Bounds for the exponential-backoff loop inside
 * {@link verifyCidAccessibleWithRetry}. Initial delay is doubled every
 * miss until it reaches `MAX_RETRY_DELAY_MS`; the loop then continues
 * at the cap until the deadline. The chosen numbers reflect typical
 * Kubo gateway propagation lag on testnet (~15 s — see issue #234) so a
 * 30 s deadline accommodates one or two retries past the median lag.
 */
const VERIFY_RETRY_INITIAL_DELAY_MS = 500;
const VERIFY_RETRY_MAX_DELAY_MS = 5_000;

/**
 * Like {@link verifyCidAccessible}, but with an exponential-backoff
 * retry loop bounded by `deadlineMs`. Returns as soon as any gateway
 * serves the CID; otherwise keeps retrying until the deadline elapses.
 *
 * Issue #239 — wraps the existing HEAD probe so the shutdown gate has
 * a single call site for "wait until propagated" semantics without
 * leaking the loop into the lifecycle manager. Failure semantics are
 * structured (see {@link VerifyCidAccessibleResult}) so the caller can
 * emit a typed `shutdown:verification-timeout` event with the correct
 * `failureKind`.
 *
 * `signal` is optional — when provided, an external abort cancels the
 * loop between attempts (an in-flight HEAD always runs to completion
 * because the underlying `verifyCidAccessible` does not accept a
 * signal). The post-attempt check ensures the abort eventually takes
 * effect without dangling timers.
 *
 * @param gateways    - Array of IPFS gateway base URLs
 * @param cid         - Content identifier to verify
 * @param options.deadlineMs - Max wall-clock budget across all attempts
 * @param options.perAttemptTimeoutMs - Per-attempt HEAD timeout (default 10s,
 *                                       inherited from `verifyCidAccessible`)
 * @param options.signal - Optional AbortSignal that cancels the retry loop
 */
export async function verifyCidAccessibleWithRetry(
  gateways: string[],
  cid: string,
  options: {
    readonly deadlineMs: number;
    readonly perAttemptTimeoutMs?: number;
    readonly signal?: AbortSignal;
  },
): Promise<VerifyCidAccessibleResult> {
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, options.deadlineMs);
  const perAttemptTimeoutMs = options.perAttemptTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  let attempts = 0;
  let delay = VERIFY_RETRY_INITIAL_DELAY_MS;

  for (;;) {
    if (options.signal?.aborted) {
      return {
        ok: false,
        attempts,
        elapsedMs: Date.now() - startedAt,
        failureKind: 'aborted',
      };
    }

    // First attempt runs even when the deadline is already 0 so callers
    // get at least one HEAD round-trip on `deadlineMs: 0`.
    attempts += 1;
    const ok = await verifyCidAccessible(gateways, cid, perAttemptTimeoutMs);
    if (ok) {
      return { ok: true, attempts, elapsedMs: Date.now() - startedAt };
    }

    const now = Date.now();
    if (now >= deadline) {
      return {
        ok: false,
        attempts,
        elapsedMs: now - startedAt,
        failureKind: 'deadline-exceeded',
      };
    }

    // Sleep up to `delay` ms, but clamp to remaining time so we don't
    // overshoot the deadline. We also break the sleep early if the
    // abort signal fires.
    const remaining = deadline - now;
    const sleepMs = Math.min(delay, remaining);
    if (sleepMs > 0) {
      await sleepInterruptible(sleepMs, options.signal);
    }
    delay = Math.min(delay * 2, VERIFY_RETRY_MAX_DELAY_MS);
  }
}

/**
 * Resolves after `ms` or as soon as `signal` aborts (whichever first).
 * Internal helper for `verifyCidAccessibleWithRetry`'s backoff sleeps.
 */
function sleepInterruptible(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((r) => setTimeout(r, ms));
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    if (signal.aborted) {
      clearTimeout(timer);
      resolve();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
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
