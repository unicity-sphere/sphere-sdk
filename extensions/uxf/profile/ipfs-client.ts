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
import { logger } from '../../../core/logger.js';
import { incr, observeMs } from '../../../core/perf-counters.js';
import { ProfileError } from './errors.js';

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
 * 100 ms each is ~25 s serial).
 *
 * Issue #369 — lowered from 10 → 5. The Unicity kubo container caps at
 * `MAX_PINS_PER_SECOND=100`; 10 concurrent slots × ~10 pin/s/slot peaks
 * at ~100 pin/s and routinely brushed the limit on bursts, producing
 * intermittent `IPFS dag/put failed on all gateways for <CID>: fetch
 * failed` surface errors that the soak couldn't reproduce on demand.
 * 5 concurrent slots stay comfortably under the cap (~50 pin/s peak)
 * while still parallelizing meaningfully — the 250-block migration
 * pays ~5 s instead of ~2.5 s, but with substantially fewer
 * rate-limit-induced retry storms. Overridable per-call for stress
 * tests or operator deployments with explicit per-client rate limits.
 *
 * Concurrency is bounded by a worker pool (not Promise.all over all
 * blocks) so memory stays O(concurrency × block-size) rather than
 * O(blocks × block-size) — important for migration of large wallets
 * where the CAR may contain thousands of blocks.
 */
const DEFAULT_PIN_CONCURRENCY = 5;

// =============================================================================
// Issue #369 — retry-with-backoff for transient pin failures.
// =============================================================================

/**
 * Backoff schedule for a single pin attempt's retries (ms). The
 * indices line up 1:1 with retry attempts AFTER the initial pass:
 * a single call to {@link withPinRetry} makes `1 + backoffs.length`
 * attempts total before throwing.
 *
 * 100 / 500 / 2000 ms is the issue #369 recommendation — fast first
 * retry to absorb the dominant TCP retransmit-window blip, longer
 * second retry to ride through a gateway hiccup, and a third retry
 * for the rare extended outage. After 2.6 s of accumulated backoff,
 * if the gateway still rejects, the failure is unlikely to clear in
 * the operation's deadline.
 */
const PIN_RETRY_BACKOFFS_MS: readonly number[] = [100, 500, 2000];

/**
 * Classify whether a pin failure is worth retrying.
 *
 * Transient (retry):
 *   - Native `fetch()` throws — network blip, ECONNRESET, ETIMEDOUT,
 *     TLS handshake stall, AbortError from the per-attempt timeout.
 *   - HTTP 5xx — gateway-side transient (overload, bad backend).
 *   - HTTP 429 — explicit rate-limit signal; backoff is the right
 *     response.
 *
 * Permanent (do NOT retry):
 *   - Other HTTP 4xx — deterministic client-side failures (bad
 *     request, unauthorized, not found, payload too large).
 *
 * Default is transient — leniency favours availability over giving
 * up on an unrecognised error shape; the bounded backoff schedule
 * caps the cost.
 *
 * The classifier inspects the error's `message` against the shape
 * `pinToIpfs` / `pinSingleBlock` use for their own throws
 * (`"HTTP <code> <statusText> from <gw>"`) so a synthetic test error
 * with that prefix is classified identically to a real one.
 */
export function isTransientPinError(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  const msg = err.message;

  // HTTP-derived errors carry the explicit status in the message. We
  // match anywhere in the string so a wrapped failure (e.g.,
  // `pinToIpfs` packaging the last gateway's "HTTP 400 …" into its
  // `IPFS pin failed on all gateways: HTTP 400 …` final throw) still
  // classifies on the inner status code rather than falling through
  // to the lenient default.
  const httpMatch = /\bHTTP (\d{3})\b/.exec(msg);
  if (httpMatch !== null) {
    const status = Number.parseInt(httpMatch[1], 10);
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    if (status >= 400 && status < 500) return false;
  }

  // Network / abort errors propagate from `fetch()` directly. Patterns
  // observed across Node 18+ undici (`fetch failed`, `Connect Timeout
  // Error`) and the platform `AbortError` from `AbortSignal.timeout`.
  if (
    msg.toLowerCase().includes('fetch failed') ||
    msg.toLowerCase().includes('network') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('EAI_AGAIN') ||
    err.name === 'AbortError' ||
    err.name === 'TimeoutError'
  ) {
    return true;
  }

  // Lenient default — unrecognised shape is treated as transient. The
  // bounded backoff schedule caps the cost; a truly-permanent failure
  // exhausts the retries in 2.6 s and surfaces normally.
  return true;
}

/**
 * Run `fn` with retry-with-backoff for transient pin failures. Makes
 * up to `1 + backoffs.length` attempts; the first attempt fires
 * immediately, each subsequent retry waits `backoffs[i]` ms.
 *
 * `isRetryable` classifies the thrown error. On the FINAL attempt a
 * failure short-circuits — no further backoff is paid. On a permanent
 * (non-retryable) failure the function throws immediately with the
 * observed error, regardless of the retry budget.
 *
 * Counters (fired only when `SPHERE_PERF=1`):
 *   - `ipfs.pin.retry.attempt` — bumped on each transient retry just
 *     before the backoff sleep. Total fires = number of paid retries.
 *   - `ipfs.pin.retry.exhausted` — bumped when all retries fail with
 *     transient errors AND we throw the last one. Distinct from
 *     `ipfs.pin.retry.permanent` (a permanent failure exits before the
 *     retry budget runs out).
 *   - `ipfs.pin.retry.permanent` — bumped when the classifier returns
 *     `false` and the function throws the permanent error without
 *     consuming further retries.
 */
export async function withPinRetry<T>(
  fn: () => Promise<T>,
  isRetryable: (err: unknown) => boolean = isTransientPinError,
  backoffs: readonly number[] = PIN_RETRY_BACKOFFS_MS,
): Promise<T> {
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt >= backoffs.length;
      if (isLast) {
        incr('ipfs.pin.retry.exhausted');
        throw err;
      }
      if (!isRetryable(err)) {
        incr('ipfs.pin.retry.permanent');
        throw err;
      }
      incr('ipfs.pin.retry.attempt');
      await new Promise<void>((resolve) => setTimeout(resolve, backoffs[attempt]));
    }
  }
  // Unreachable — the loop above either returns or throws on every
  // path. This satisfies TypeScript's exhaustiveness check.
  throw new Error('withPinRetry: unreachable');
}

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
 * Per-gateway adaptive cold-cache state. The sidecar correctly GCs
 * blobs after they're promoted to Kubo (see ipfs-storage's
 * `instant_pin_cache._reconcile_once`), so for any wallet load that
 * walks an *old* Profile bundle the steady-state outcome is 404 on
 * every block. With N blocks in a Profile snapshot that produces N
 * console-visible failed fetches (Chrome auto-logs every non-2xx
 * `fetch()` even when the JS swallows the result), drowning real
 * signal.
 *
 * Strategy: track consecutive misses per gateway. After
 * {@link SIDECAR_COLD_MISS_THRESHOLD} misses in a row, mark the
 * gateway "sidecar cold" for {@link SIDECAR_COLD_DURATION_MS}.
 * During the cold window both {@link tryReadFromSidecar} and
 * {@link submitToSidecarBestEffort} short-circuit before issuing the
 * HTTP request — eliminating the console noise while preserving the
 * cross-device fast path: a single hit (or a successful submit,
 * which usually means a sibling device just published) resets the
 * counter, and after the cooldown a single re-probe re-arms the
 * fast path automatically.
 *
 * 3 / 60 s is intentionally conservative — we want to keep probing
 * during cross-device bursts (where hits are likely), and only cool
 * off when the gateway looks genuinely empty for this wallet's
 * working set.
 */
const SIDECAR_COLD_MISS_THRESHOLD = 3;
const SIDECAR_COLD_DURATION_MS = 60_000;

interface SidecarColdState {
  consecutiveMisses: number;
  coldUntil: number; // epoch ms; 0 means not cold
}

const sidecarColdState = new Map<string, SidecarColdState>();

function getSidecarColdState(gateway: string): SidecarColdState {
  const key = normalizeGatewayKey(gateway);
  let state = sidecarColdState.get(key);
  if (!state) {
    state = { consecutiveMisses: 0, coldUntil: 0 };
    sidecarColdState.set(key, state);
  }
  return state;
}

function isSidecarCold(gateway: string): boolean {
  const state = sidecarColdState.get(normalizeGatewayKey(gateway));
  if (!state) return false;
  return state.coldUntil > Date.now();
}

function recordSidecarMiss(gateway: string): void {
  const state = getSidecarColdState(gateway);
  state.consecutiveMisses += 1;
  if (state.consecutiveMisses >= SIDECAR_COLD_MISS_THRESHOLD) {
    state.coldUntil = Date.now() + SIDECAR_COLD_DURATION_MS;
  }
}

function recordSidecarHit(gateway: string): void {
  const state = getSidecarColdState(gateway);
  state.consecutiveMisses = 0;
  state.coldUntil = 0;
}

/**
 * Test-only helper to reset the cold-cache between tests. Production
 * code does not call this — the state self-heals via the cooldown.
 */
export function _resetSidecarColdState(): void {
  sidecarColdState.clear();
}

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
  // Cold-cache short-circuit: if this gateway has consistently failed
  // recent sidecar interactions, skip the POST entirely. The primary
  // pin path is the source of truth; this skip only loses the
  // cross-device fast-path acceleration for the cooldown window. See
  // SIDECAR_COLD_* doc for the rationale.
  if (isSidecarCold(gateway)) return;
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
        // 404 = sidecar not deployed on this gateway → count as miss.
        // 503 = cache_full back-pressure → not a "cold" signal, the
        //       sidecar is alive and rejecting under load. Don't count.
        // 413 = oversize → also not "cold"; don't count.
        if (response.status === 404) recordSidecarMiss(gateway);
        logger.debug(
          'IPFS-Sidecar',
          `submit ${cid.slice(0, 16)} → HTTP ${response.status} ` +
          `(${response.statusText}) on ${gateway}`,
        );
      } else {
        recordSidecarHit(gateway);
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
      // already succeeded; this is pure optimization. Network/timeout
      // counts as a miss for cooldown purposes.
      recordSidecarMiss(gateway);
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
  // Cold-cache short-circuit: skip the probe if this gateway has 404'd
  // SIDECAR_COLD_MISS_THRESHOLD times in a row. The normal multi-gateway
  // `/api/v0/block/get` path is unaffected — this only skips the
  // cross-device fast-path optimization during the cooldown window.
  // See SIDECAR_COLD_* doc above for the noise rationale.
  if (isSidecarCold(gateway)) return null;
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
      recordSidecarMiss(gateway);
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
      // Wrong content-type = same operational signal as a miss
      // (gateway returning HTML/JSON catch-all means no sidecar).
      recordSidecarMiss(gateway);
      return null;
    }
    const buf = await response.arrayBuffer();
    if (buf.byteLength === 0) {
      recordSidecarMiss(gateway);
      return null;
    }
    recordSidecarHit(gateway);
    logger.debug(
      'IPFS-Sidecar',
      `read hit ${cid.slice(0, 16)} (${buf.byteLength} bytes) on ${gateway}`,
    );
    return new Uint8Array(buf);
  } catch {
    // Timeout, network error, abort — all treated as a miss. The
    // caller's normal-path fetch is the source of truth.
    recordSidecarMiss(gateway);
    return null;
  }
}

// =============================================================================
// Issue #370 — Capability probe and CAR-batched fast paths
// =============================================================================

/**
 * Per-gateway timeout for the capability probe. Short and bounded so a
 * slow or unreachable gateway can't block the first hot-path pin beyond
 * this window. On timeout / network error the probe caches the gateway
 * as "fast path unsupported" for the process lifetime — same outcome as
 * an explicit 404 from the operator gateway.
 */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Result of the per-gateway capability probe. Each field is `true` iff
 * the gateway advertises the corresponding endpoint at the operator
 * layer (haproxy/nginx ACL passes the route through to Kubo).
 */
interface GatewayCapabilities {
  readonly dagImport: boolean;
  readonly dagExport: boolean;
}

/**
 * Per-process probe cache. Keyed by normalized gateway URL (trailing
 * slash trimmed). Stores the in-flight Promise, not the resolved value,
 * so a concurrent burst of pins triggers exactly one probe per gateway.
 * Capability is treated as a static property of a gateway within a
 * process's lifetime — operator reconfiguration requires a new wallet
 * process to pick up the change.
 */
const capabilityCache = new Map<string, Promise<GatewayCapabilities>>();

/**
 * Test-only helper to reset the probe cache between tests. Production
 * code does not call this — operator gateway reconfiguration requires a
 * process restart.
 */
export function _resetGatewayCapabilityCache(): void {
  capabilityCache.clear();
}

/**
 * Test/soak-only helper to pre-populate the capability cache for a
 * specific gateway URL. Lets a smoke probe force the legacy path for
 * an A/B comparison against the live gateway without needing to
 * spin up a second gateway that doesn't expose /dag/import.
 *
 * Production code MUST NOT call this — the probe is the source of
 * truth at runtime.
 */
export function _setGatewayCapabilityForTest(
  gateway: string,
  caps: { readonly dagImport: boolean; readonly dagExport: boolean },
): void {
  capabilityCache.set(normalizeGatewayKey(gateway), Promise.resolve(caps));
}

function normalizeGatewayKey(gateway: string): string {
  return gateway.replace(/\/$/, '');
}

/**
 * POST a single empty request to `url` to determine whether the
 * operator gateway exposes that endpoint. Returns `true` iff the
 * gateway responded with a 4xx status that is NOT 404 (route absent)
 * or 405 (POST blocked at the proxy layer). A healthy Kubo returns
 * 400 *Bad Request* for an empty POST to `/dag/import` / `/dag/export`
 * — that's the positive signal we look for.
 *
 * 5xx is treated as "not exposed" — a healthy operator gateway would
 * have returned 4xx for empty input. 5xx suggests an unhealthy upstream
 * or a misconfigured proxy returning a synthetic error page. 2xx is
 * accepted (defense: the operator may have rewritten the endpoint to
 * return 200; if the actual call later fails, the selector falls
 * through to legacy).
 *
 * Network errors, timeouts, or aborts → returns `false` (treat as not
 * exposed). The caller's legacy path will rediscover real failures at
 * call time through its own per-gateway iteration.
 */
async function probeEndpointExposed(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    response.body?.cancel?.().catch(() => { /* ignore */ });
    return (
      response.status !== 404 &&
      response.status !== 405 &&
      response.status < 500
    );
  } catch {
    return false;
  }
}

/**
 * Probe a gateway for `/dag/import` and `/dag/export` support, caching
 * the result for the rest of the process lifetime. Issue #370.
 */
async function probeGatewayCapabilities(gateway: string): Promise<GatewayCapabilities> {
  const key = normalizeGatewayKey(gateway);
  const cached = capabilityCache.get(key);
  if (cached !== undefined) return cached;

  const probe = (async (): Promise<GatewayCapabilities> => {
    const [dagImport, dagExport] = await Promise.all([
      probeEndpointExposed(`${key}/api/v0/dag/import`),
      probeEndpointExposed(`${key}/api/v0/dag/export`),
    ]);
    if (!dagImport || !dagExport) {
      logger.warn(
        'ipfs-client',
        `#370 capability probe ${key}: dagImport=${dagImport} dagExport=${dagExport} ` +
          `— legacy per-block path will be used where the fast path is unavailable`,
      );
    }
    return { dagImport, dagExport };
  })();
  capabilityCache.set(key, probe);
  return probe;
}

/**
 * Single-round-trip CAR push: POST `carBytes` to Kubo's
 * `/api/v0/dag/import?pin=true`. Replaces the per-block `/dag/put`
 * loop when the operator gateway exposes the import endpoint.
 *
 * Parses the NDJSON response and verifies `expectedRootCid` appears
 * among the imported roots with no `PinErrorMsg`. CAR-bytes content
 * verification is end-to-end via receiver-side `fetchFromIpfs` checks
 * — this function does NOT recompute every block's CID (Kubo does that
 * server-side during import).
 *
 * Permissive `Cid` shape parsing accepts both modern
 * `{"Root": {"Cid": {"/": "bafy..."}}}` and older
 * `{"Root": {"Cid": "bafy..."}}` Kubo response forms.
 *
 * Multi-root defensive check: validates our root is present, ignores
 * extra roots the gateway reports (defense for a hostile gateway
 * appending phantom entries).
 *
 * Throws on any failure so the caller's selector can fall through to
 * the legacy per-block path.
 */
async function pinCarViaImport(
  gateway: string,
  carBytes: Uint8Array,
  expectedRootCid: string,
  timeoutMs: number,
): Promise<void> {
  const url = `${normalizeGatewayKey(gateway)}/api/v0/dag/import?pin=true`;
  const form = new FormData();
  form.append('file', new Blob([carBytes as BlobPart]), 'bundle.car');

  const response = await fetch(url, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText} from ${gateway} for /dag/import`,
    );
  }

  const text = await response.text();
  let foundExpectedRoot = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let node: unknown;
    try {
      node = JSON.parse(trimmed);
    } catch {
      continue; // ignore non-JSON noise
    }
    if (node === null || typeof node !== 'object') continue;
    const root = (node as { Root?: unknown }).Root;
    if (root === null || root === undefined || typeof root !== 'object') continue;
    const rootObj = root as { Cid?: unknown; PinErrorMsg?: unknown };
    let cidStr: string | null = null;
    const cid = rootObj.Cid;
    if (typeof cid === 'string') {
      cidStr = cid;
    } else if (cid !== null && typeof cid === 'object') {
      const inner = (cid as { '/'?: unknown })['/'];
      if (typeof inner === 'string') cidStr = inner;
    }
    if (cidStr === expectedRootCid) {
      const errMsg = rootObj.PinErrorMsg;
      if (typeof errMsg === 'string' && errMsg.length > 0) {
        throw new Error(
          `Gateway ${gateway} reported PinErrorMsg for ${expectedRootCid}: ${errMsg}`,
        );
      }
      foundExpectedRoot = true;
    }
  }
  if (!foundExpectedRoot) {
    throw new Error(
      `Gateway ${gateway} /dag/import did not include expected root ${expectedRootCid} in NDJSON response`,
    );
  }
}

/**
 * Single-round-trip CAR pull: POST to Kubo's
 * `/api/v0/dag/export?arg=<root>` and return the response bytes
 * verbatim. The bytes ARE a CARv1 stream — feed directly to
 * `CarReader.fromBytes`. Replaces the per-block BFS walk when the
 * operator gateway exposes the export endpoint.
 *
 * Per-block CID verification happens after parse in the caller
 * (`verifyAndReassembleExportedCar`). This function only handles the
 * HTTP transport. A hostile gateway can DoS but cannot forge data —
 * the caller's CID-binding check rejects mismatched bytes.
 *
 * Throws on any HTTP failure or size-cap breach so the caller's
 * selector can fall through to the legacy BFS path.
 */
async function fetchCarViaExport(
  gateway: string,
  rootCid: string,
  timeoutMs: number,
  maxSizeBytes: number,
): Promise<Uint8Array> {
  const url =
    `${normalizeGatewayKey(gateway)}/api/v0/dag/export?arg=${encodeURIComponent(rootCid)}`;
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText} from ${gateway} for /dag/export`,
    );
  }

  const contentLength = response.headers.get('Content-Length');
  if (contentLength != null) {
    const size = parseInt(contentLength, 10);
    if (!isNaN(size) && size > maxSizeBytes) {
      throw new Error(
        `Gateway ${gateway} /dag/export Content-Length ${size} exceeds limit ${maxSizeBytes}`,
      );
    }
  }

  if (response.body != null) {
    return await readStreamWithLimit(response.body, maxSizeBytes, gateway);
  }
  const buf = await response.arrayBuffer();
  if (buf.byteLength > maxSizeBytes) {
    throw new Error(
      `Gateway ${gateway} /dag/export returned ${buf.byteLength} bytes exceeding limit ${maxSizeBytes}`,
    );
  }
  return new Uint8Array(buf);
}

/**
 * Verify every block CID-binding in an exported CAR and reassemble it
 * into a CARv1 rooted at `rootCid` (stream order preserved). Issue
 * #370 fetch-path companion to {@link fetchCarViaExport}.
 *
 * On verification or root-absence failure, throws so the caller's
 * selector can fall through to the legacy BFS path (which will fetch
 * each block individually and apply the same CID check via
 * `fetchFromIpfs`).
 *
 * Also write-backs every verified block to the local Helia blockstore
 * (preserves the #236 bidirectional cache invariant).
 */
async function verifyAndReassembleExportedCar(
  carBytes: Uint8Array,
  rootCid: string,
  helia: unknown,
): Promise<Uint8Array> {
  const { CarReader } = await import('@ipld/car');
  const { CarWriter } = await import('@ipld/car/writer');
  const reader = await CarReader.fromBytes(carBytes);

  let rootBlockCid: CID | null = null;
  const collected: Array<{ cid: CID; bytes: Uint8Array }> = [];
  for await (const block of reader.blocks()) {
    const cidStr = block.cid.toString();
    verifyCidMatchesBytes(cidStr, block.bytes);
    collected.push({ cid: block.cid, bytes: block.bytes });
    if (cidStr === rootCid) rootBlockCid = block.cid;
  }
  if (rootBlockCid === null) {
    throw new Error(
      `/dag/export response for ${rootCid} did not include the requested root block`,
    );
  }

  const localHelia = asHelia(helia);
  if (localHelia !== null) {
    for (const block of collected) {
      await putBlockToLocalHelia(localHelia, block.cid.toString(), block.bytes);
    }
  }

  const { writer, out } = CarWriter.create([rootBlockCid]);
  const chunks: Uint8Array[] = [];
  const collectPromise = (async () => {
    for await (const chunk of out) chunks.push(chunk);
  })();
  try {
    for (const block of collected) await writer.put(block);
  } finally {
    await writer.close();
  }
  await collectPromise;

  let totalLength = 0;
  for (const c of chunks) totalLength += c.length;
  const reassembled = new Uint8Array(totalLength);
  let offset = 0;
  for (const c of chunks) {
    reassembled.set(c, offset);
    offset += c.length;
  }
  return reassembled;
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

  // Issue #369 — wrap the gateway-iteration in retry-with-backoff so a
  // single transient hiccup (network blip, brief TLS slowdown, 429 from
  // a rate-limited gateway) no longer aborts the pin. The retry only
  // fires when EVERY configured gateway has failed in the current
  // attempt — a single healthy gateway still satisfies the pin without
  // paying any backoff cost.
  return withPinRetry(() => pinToIpfsOnce(effectiveGateways, data, timeoutMs));
}

async function pinToIpfsOnce(
  effectiveGateways: string[],
  data: Uint8Array,
  timeoutMs: number,
): Promise<string> {
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

  // Issue #369 — wrap the per-block pin in retry-with-backoff so a
  // single transient network/gateway failure on this one block doesn't
  // abort the whole CAR pin (a 250-block CAR has 250 retry slots — a
  // single 1% failure rate without retries cascades to ~92% chance of
  // at-least-one-failure per CAR).
  return withPinRetry(() =>
    pinSingleBlockOnce(effectiveGateways, blockBytes, expectedCid, timeoutMs),
  );
}

async function pinSingleBlockOnce(
  effectiveGateways: string[],
  blockBytes: Uint8Array,
  expectedCid: string,
  timeoutMs: number,
): Promise<void> {
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
      // #435 — Tag 42 CID-link encoding preserves the equivalence). The
      // sidecar's `_infer_block_put_params` handles raw / dag-cbor /
      // dag-pb codecs by CID prefix — no codec-specific gating needed
      // on this side.
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
 * Relationship to `/api/v0/dag/import`: as of issue #370, the SDK
 * prefers `/dag/import` (single CAR push) over this per-block loop
 * whenever a gateway's capability probe confirms the endpoint is
 * exposed at the operator layer. This legacy per-block path remains
 * the hardened fallback for gateways that don't expose `/dag/import`
 * (or for fast-path call-time failures). `dag/put` is universally
 * available across Kubo deploys, including hardened gateways that
 * restrict the API surface; the tradeoff is one HTTP round-trip per
 * block.
 *
 * The function trusts the caller-supplied `expectedRootCid` and the
 * framed CIDs in the CAR (`@ipld/car`'s `CarReader` does NOT recompute
 * `sha256(bytes)` against the framed CID — it just slices framed
 * `{cid, bytes}` pairs from the stream).
 *
 * Issue #435 — `uxf/ipld.ts:elementToIpldBlock` emits child references
 * and `header[3]` predecessor as dag-cbor **Tag 42 CID-links**. The
 * hash canonical form and the IPLD canonical form remain a single
 * bit-identical form, so `sha256(block.bytes) === block.cid.multihash.digest`
 * holds for every UXF sub-block. Tag 42 framing is what Kubo's
 * recursive pin (`/dag/import?pin-roots=true`) walks natively — so the
 * fast-path code above is sufficient for UXF CARs without any
 * client-side per-block follow-up. This legacy per-block loop remains
 * the hardened fallback for gateways that don't expose `/dag/import`.
 * Producer-side verification is performed per-block below (a
 * lightweight sanity check that catches builder bugs without
 * re-deriving the CIDs Kubo would assign). Receiver-side verification
 * continues via `fetchFromIpfs` (CID-binding check against
 * gateway-returned bytes).
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
/**
 * Issue #370 fast-path selector. Probes each gateway for `/dag/import`
 * support and uses the single-shot CAR push when available. Falls
 * through to {@link pinCarBlocksToIpfsLegacy} when no gateway exposes
 * the endpoint, or when the fast path fails mid-flight (which would
 * suggest a transient gateway issue that the hardened per-block path
 * may still ride out on a sibling gateway).
 *
 * Local Helia writes happen on both paths (preserves the #236
 * crash-safety invariant). The sidecar submit fires once for the CAR
 * root on the fast path and once per block on the legacy path.
 */
export async function pinCarBlocksToIpfs(
  gateways: string[],
  carBytes: Uint8Array,
  expectedRootCid: string,
  timeoutMs: number = DEFAULT_PIN_TIMEOUT_MS,
  helia?: unknown,
  concurrency: number = DEFAULT_PIN_CONCURRENCY,
): Promise<string> {
  const effectiveGateways = gateways.length > 0 ? gateways : [DEFAULT_IPFS_API_URL];
  validateGatewayUrls(effectiveGateways);

  // Track whether we already wrote every block into the local Helia
  // store on the fast-path attempt. If so, the legacy fallback must
  // NOT re-write them (would surface as duplicate puts in tests and
  // wasted disk I/O at runtime). We pass `helia: undefined` to the
  // legacy call in that case to skip its own per-block local-Helia
  // write loop.
  let localHeliaWrittenInFastPath = false;

  for (const gateway of effectiveGateways) {
    const caps = await probeGatewayCapabilities(gateway);
    if (!caps.dagImport) continue;

    // Parse the CAR locally for the fast path's local-Helia write and
    // root-block extraction (used by the post-success sidecar submit).
    // A malformed CAR fails with a deterministic ProfileError and we
    // re-throw without falling through — the legacy path would emit
    // the same error after re-parsing.
    let parsed: {
      readonly blocks: ReadonlyArray<{ cid: string; bytes: Uint8Array }>;
      readonly rootBlock: { cid: string; bytes: Uint8Array };
    };
    try {
      parsed = await parseCarForFastPathPin(carBytes, expectedRootCid);
    } catch (err) {
      if (err instanceof ProfileError) throw err;
      throw new ProfileError(
        'ORBITDB_WRITE_FAILED',
        `pinCarBlocksToIpfs: fast-path CAR parse failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    const localHelia = asHelia(helia);
    if (localHelia !== null && !localHeliaWrittenInFastPath) {
      for (const block of parsed.blocks) {
        let cidBindingOk = true;
        try {
          verifyCidMatchesBytes(block.cid, block.bytes);
        } catch (err) {
          cidBindingOk = false;
          logger.warn(
            'ipfs-client',
            `pinCarBlocksToIpfs: producer-side CID/bytes mismatch for ${block.cid} ` +
              `— skipping local-helia put. ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (cidBindingOk) await putBlockToLocalHelia(localHelia, block.cid, block.bytes);
      }
      localHeliaWrittenInFastPath = true;
    }

    try {
      await pinCarViaImport(gateway, carBytes, expectedRootCid, timeoutMs);
      // One sidecar submit per CAR root (issue #370 explicit guidance).
      submitToSidecarBestEffort(gateway, expectedRootCid, parsed.rootBlock.bytes);
      return expectedRootCid;
    } catch (err) {
      logger.warn(
        'ipfs-client',
        `pinCarBlocksToIpfs: /dag/import fast path failed on ${gateway} for ${expectedRootCid}, ` +
          `falling back to legacy per-block path. Reason: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      // Exit the gateway probe loop; legacy iterates the full list itself
      // (a sibling gateway may still accept per-block /dag/put even if
      // /dag/import on this gateway stumbled).
      break;
    }
  }

  return pinCarBlocksToIpfsLegacy(
    effectiveGateways,
    carBytes,
    expectedRootCid,
    timeoutMs,
    // Skip the legacy path's local-Helia write loop if the fast path
    // already wrote every block — avoids duplicate puts.
    localHeliaWrittenInFastPath ? undefined : helia,
    concurrency,
  );
}

/**
 * Parse a CAR upfront for the fast-path pin. Materialises the block
 * list and extracts the root block bytes for sidecar submit. Throws
 * `ProfileError(ORBITDB_WRITE_FAILED)` on malformed CARs, zero-block
 * CARs, or missing-expected-root CARs (matches the legacy path's
 * pre-flight checks).
 */
async function parseCarForFastPathPin(
  carBytes: Uint8Array,
  expectedRootCid: string,
): Promise<{
  readonly blocks: ReadonlyArray<{ cid: string; bytes: Uint8Array }>;
  readonly rootBlock: { cid: string; bytes: Uint8Array };
}> {
  const { CarReader } = await import('@ipld/car');
  const reader = await CarReader.fromBytes(carBytes);
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
  const rootBlock = blocks.find((b) => b.cid === expectedRootCid);
  if (rootBlock === undefined) {
    throw new ProfileError(
      'ORBITDB_WRITE_FAILED',
      `expectedRootCid ${expectedRootCid} is not present among CAR blocks (count=${blocks.length}) — builder/publisher mismatch.`,
    );
  }
  return { blocks, rootBlock };
}

/**
 * Legacy per-block pin implementation. Issue #370 turned the public
 * `pinCarBlocksToIpfs` into a selector that prefers `/dag/import` when
 * the operator gateway advertises it; this function is the fallback
 * path for legacy gateways and for fast-path call-time failures.
 *
 * Signature and behaviour are exactly what `pinCarBlocksToIpfs` had
 * before issue #370.
 */
async function pinCarBlocksToIpfsLegacy(
  gateways: string[],
  carBytes: Uint8Array,
  expectedRootCid: string,
  timeoutMs: number = DEFAULT_PIN_TIMEOUT_MS,
  helia?: unknown,
  concurrency: number = DEFAULT_PIN_CONCURRENCY,
): Promise<string> {
  // GH #363 measurement: total pin wall-clock + block count + total
  // bytes for the LEGACY per-block path. (The fast path uses
  // `ipfs.dagImport.*` counters wired by issue #370 around
  // `pinCarViaImport`.) Each path measures its own wall-clock so the
  // selector's effective cost is unambiguous in the snapshot.
  const __perfStart = performance.now();
  const __perfBytes = carBytes.byteLength;

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
  // Issue #435 — UXF element bytes are encoded in the SAME canonical
  // form used for hashing (children + `header[3]` predecessor emitted
  // as dag-cbor **Tag 42 CID-links**). That keeps
  // `sha256(block.bytes) === block.cid.multihash.digest` for every
  // sub-block of a bundle CAR, so Kubo's `dag/put` re-derives the same
  // CID we publish under and per-block round-trips agree.
  //
  // We don't run a uniform `verifyCidMatchesBytes` here — that's a
  // receiver-side defense (gateway tampering). The producer is the
  // bytes' authority. If a future builder bug breaks the equivalence,
  // it would surface immediately as a downstream `fetchFromIpfs`
  // mismatch on the next consumer fetch.
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
    incr('ipfs.pinCar.error');
    observeMs('ipfs.pinCar.totalMs', performance.now() - __perfStart);
    throw workerErrors[0];
  }

  // GH #363 measurement.
  incr('ipfs.pinCar.blocks', blocks.length);
  incr('ipfs.pinCar.bytes', __perfBytes);
  observeMs('ipfs.pinCar.totalMs', performance.now() - __perfStart);
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
  // GH #363 measurement — split local-Helia hits from HTTP gateway
  // fetches so the two cost models are visible separately.
  const __perfStart = performance.now();
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
        incr('ipfs.fetchBlock.localHit');
        observeMs('ipfs.fetchBlock.localHitMs', performance.now() - __perfStart);
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

      // GH #363 — gateway hit (HTTP round-trip cost).
      incr('ipfs.fetchBlock.gatewayHit');
      incr('ipfs.fetchBlock.bytes', bytesOrNull.byteLength);
      observeMs('ipfs.fetchBlock.gatewayMs', performance.now() - __perfStart);
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

  incr('ipfs.fetchBlock.allGatewaysFailed');
  observeMs('ipfs.fetchBlock.failedMs', performance.now() - __perfStart);
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
  // GH #363 measurement — per-CAR walk wall-clock + block count. Issue
  // #360 claimed sequential block-fetch dominated load time; verify or
  // refute with real data instead of speculating.
  const __perfStart = performance.now();
  incr('ipfs.fetchCar.calls');
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
  // verbatim — they ARE the CAR. Skip the walk. Taken BEFORE the
  // capability probe — raw-codec roots never need /dag/export.
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

  const effectiveGateways = gateways.length > 0 ? gateways : [DEFAULT_IPFS_API_URL];
  validateGatewayUrls(effectiveGateways);

  // Issue #236 + #370 — local-helia-first short-circuit. When the root
  // block is already in the local Helia blockstore the legacy BFS path
  // satisfies the entire walk from disk via `fetchFromIpfs`'s
  // local-first lookup with zero HTTP round-trips. Take that path
  // BEFORE the capability probe so we don't spend an /dag/export probe
  // round-trip when no HTTP is needed at all.
  const localHeliaForRoot = asHelia(helia);
  if (localHeliaForRoot !== null) {
    const localRoot = await tryGetBlockFromLocalHelia(localHeliaForRoot, rootCid);
    if (localRoot !== null) {
      return fetchCarFromIpfsLegacy(
        effectiveGateways,
        rootCid,
        parsedRoot,
        timeoutMs,
        maxSizeBytesPerBlock,
        helia,
      );
    }
  }

  // Issue #370 fast path: probe each gateway for /dag/export. On a
  // capable gateway, fetch the whole CAR in a single HTTP request,
  // verify every block CID-binding, reassemble and return. On any
  // failure (404 probe miss, mid-call HTTP error, CID mismatch on
  // any block, missing root in the exported CAR) fall through to the
  // legacy per-block BFS path with the full gateway list.
  for (const gateway of effectiveGateways) {
    const caps = await probeGatewayCapabilities(gateway);
    if (!caps.dagExport) continue;
    try {
      const carBytes = await fetchCarViaExport(gateway, rootCid, timeoutMs, maxSizeBytesPerBlock);
      return await verifyAndReassembleExportedCar(carBytes, rootCid, helia);
    } catch (err) {
      logger.warn(
        'ipfs-client',
        `fetchCarFromIpfs: /dag/export fast path failed on ${gateway} for ${rootCid}, ` +
          `falling back to legacy per-block BFS. Reason: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      // Exit the gateway probe loop; legacy iterates the full gateway
      // list itself (a sibling gateway may still serve per-block
      // /block/get even if /dag/export on this gateway stumbled).
      break;
    }
  }

  return fetchCarFromIpfsLegacy(
    effectiveGateways,
    rootCid,
    parsedRoot,
    timeoutMs,
    maxSizeBytesPerBlock,
    helia,
  );
}

/**
 * Legacy per-block BFS implementation. Issue #370 turned the public
 * `fetchCarFromIpfs` into a selector that prefers `/dag/export` when
 * the operator gateway advertises it; this function is the fallback
 * path for legacy gateways and for fast-path failures.
 *
 * Signature differs from the public function: takes the already-parsed
 * `rootCid` to avoid re-parsing in the selector. Behaviour is exactly
 * what `fetchCarFromIpfs` had before issue #370.
 */
async function fetchCarFromIpfsLegacy(
  gateways: string[],
  rootCid: string,
  parsedRoot: CID,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  maxSizeBytesPerBlock: number = DEFAULT_MAX_SIZE_BYTES,
  helia?: unknown,
): Promise<Uint8Array> {
  // Issue #363 — total wall-clock for the LEGACY per-block fetch path.
  // The fast path emits `ipfs.fetchCar.fastPath` / `ipfs.dagExport.*`
  // counters via `fetchCarViaExport`; this counter measures the
  // fallback's BFS walk + per-block fetch loop.
  const __perfStart = performance.now();
  // Lazy-import @ipld/dag-cbor + CarWriter to keep the cold-path import
  // off the synchronous load of every module that touches ipfs-client.
  const { decode: dagCborDecode } = await import('@ipld/dag-cbor');
  const { CarWriter } = await import('@ipld/car/writer');

  const visited = new Set<string>();
  const blocks: Array<{ cid: CID; bytes: Uint8Array }> = [];
  const queue: string[] = [rootCid];

  while (queue.length > 0) {
    if (blocks.length >= FETCH_CAR_MAX_BLOCKS) {
      throw new ProfileError(
        'BUNDLE_NOT_FOUND',
        `fetchCarFromIpfs: block count exceeded ${FETCH_CAR_MAX_BLOCKS} walking from ${rootCid} ` +
          `(possible cyclic or maliciously-fanned-out DAG)`,
      );
    }
    const cidStr = queue.shift()!;
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

    const blockBytes = await fetchFromIpfs(
      gateways,
      cidStr,
      timeoutMs,
      maxSizeBytesPerBlock,
      helia,
    );
    blocks.push({ cid: blockCid, bytes: blockBytes });

    // Only dag-cbor blocks can carry inter-block references. Raw blocks
    // (codec 0x55) are leaves. Unknown codecs are also treated as
    // leaves — if a future block type needs link walking, extend
    // this branch explicitly rather than guessing.
    if (blockCid.code === CODEC_DAG_CBOR) {
      let decoded: unknown;
      try {
        decoded = dagCborDecode(blockBytes);
      } catch (err) {
        throw new ProfileError(
          'BUNDLE_NOT_FOUND',
          `fetchCarFromIpfs: dag-cbor decode failed for ${cidStr} (reachable from ${rootCid}): ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }
      const visit = (childCid: CID): void => {
        const childStr = childCid.toString();
        if (!visited.has(childStr)) queue.push(childStr);
      };
      // Issue #435: every UXF element block now encodes children
      // (and `header[3]` predecessor) as dag-cbor **Tag 42 CID-links**.
      // `collectCidLinks` follows them uniformly across UXF, envelope,
      // manifest, and lean-snapshot blocks — no client-side UXF-aware
      // walker required.
      collectCidLinks(decoded, visit);
    }
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
  incr('ipfs.fetchCar.blocks', blocks.length);
  incr('ipfs.fetchCar.bytes', totalLength);
  observeMs('ipfs.fetchCar.totalMs', performance.now() - __perfStart);
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
// (Issue #435) — the UXF-aware walker (`isUxfElement` / `walkUxfElement` /
// `contentHashBytesToCid`) was removed once `uxf/ipld.ts:elementToIpldBlock`
// switched to dag-cbor Tag 42 CID-links for child references and
// `header[3]` predecessor. `collectCidLinks` now follows every link
// uniformly. See PR for issue #435.
// ---------------------------------------------------------------------------

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
