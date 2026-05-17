/**
 * Pointer-layer wiring helper (Phase D integration, Task #103).
 *
 * Constructs a `ProfilePointerLayer` from the dependencies available
 * inside `ProfileStorageProvider` after Phase B OrbitDB attach. The
 * helper is deliberately fail-open: if any precondition is not met
 * (no oracle, no aggregator client, no bundled trust base, local
 * cache not marked durable, etc.) it returns a structured skip result
 * rather than throwing. Callers report the reason and continue
 * without a pointer layer — the existing recovery path (IPNS, until
 * T-D6 removes it) remains live until all preconditions land.
 *
 * Scope:
 *   - Derive HKDF key material from the wallet private key
 *   - Build pointer signer, flag store, publish mutex
 *   - Wire `fetchCar` / `decodeCid` via profile/ipfs-client +
 *     multiformats
 *   - Wire `readLocalVersion` / `persistLocalVersion` via the local
 *     cache (no envelope; raw KV — the pointer version is per-device,
 *     not replicated)
 *   - Wire `resolveRemoteCid` via `decodeVersionCid` — re-runs Phase
 *     1+2 of `classifyVersion` (inclusion proofs + XOR-decode) to
 *     return the CID bytes for an already-VALID version
 *   - Wire `fetchAndJoin` — fetches the CAR from IPFS with content-
 *     address verify, records the remote CID as a bundle ref in
 *     OrbitDB (`tokens.bundle.{cid}`), and ONLY THEN advances the
 *     per-device cursor by calling `persistLocalVersion`. The bundle-
 *     ref-first ordering is load-bearing: if OrbitDB writes fail
 *     (timeout, sync error), the cursor stays behind OrbitDB and the
 *     next reconcile re-attempts the same `(cidBytes, version)` pair
 *     — recoverable. Reversing the order would silently strand the
 *     bundle on cross-device recovery. The next JOIN pass (inside
 *     ProfileTokenStorageProvider.load()) merges the new ref into the
 *     joined view. This relies on the existing multi-bundle union —
 *     which today runs under the last-writer-wins semantics flagged
 *     by T-D0 (PROFILE-AGGREGATOR-POINTER-D0-JOIN-AUDIT.md): until
 *     the per-token JOIN resolver lands (Rules 3 + 4 in that
 *     document), overlapping tokenIds across remote + local bundles
 *     are resolved by insertion order rather than longest-valid-chain.
 *     This is acceptable for the single-device cold-start and
 *     disjoint-token-set cases — the pointer anchor itself is
 *     correctly persisted either way.
 *
 * @see PROFILE-AGGREGATOR-POINTER-IMPL-PLAN.md Phase D (T-D4 consumption, T-D3c)
 * @see PROFILE-AGGREGATOR-POINTER-INTEGRATION-MAP.md §3.2
 * @see PROFILE-AGGREGATOR-POINTER-D0-JOIN-AUDIT.md (Rule 1/3/4 caveat)
 * @module profile/pointer-wiring
 */

import { CID } from 'multiformats/cid';

import type { FullIdentity } from '../types';
import type { StorageProvider } from '../storage/storage-provider';
import type { OracleProvider } from '../oracle';
import { logger } from '../core/logger';
import { hexToBytes as strictHexToBytesCore } from '../core/hex';

import type { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';
import type { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase.js';

import {
  ProfilePointerLayer,
  type PointerLayerConfig,
  createMasterPrivateKey,
  derivePointerKeyMaterial,
  buildPointerSigner,
  createPointerMutex,
  FlagStore,
  isDurableProvider,
  decodeVersionCid,
  type CarFetcher,
  type CidDecoder,
  type FetchAndJoinCallback,
  type PointerKeyMaterial,
  type PointerSigner,
  type PointerVersion,
} from './aggregator-pointer';
import { AggregatorPointerError, AggregatorPointerErrorCode } from './aggregator-pointer/errors';

import { fetchCarFromGateway } from './aggregator-pointer/ipfs-car-fetch';
import { fetchFromIpfs } from './ipfs-client';
import { deriveProfileEncryptionKey, encryptProfileValue } from './encryption';
import { buildLocalEntry } from './oplog-entry';
import type { ProfileDatabase, UxfBundleRef } from './types';

/** OrbitDB key prefix for UXF bundle references — mirrors ProfileTokenStorageProvider. */
const BUNDLE_KEY_PREFIX = 'tokens.bundle.';

/**
 * Wall-clock cap for the aggregate CAR fetch across all gateways in
 * buildCarFetcher. Each gateway call already has its own three-tier
 * timeout (MAX_CAR_FETCH_* constants in ipfs-car-fetch.ts), but
 * without an outer cap an operator with N stalling gateways pays
 * N × total_timeout before giving up — 15 min for 3 gateways,
 * 50 min for 10. classifyVersion / recoverLatest / flushToIpfs all
 * await this on the hot path, so a hard outer budget is required.
 */
const CAR_FETCH_TOTAL_BUDGET_MS = 60_000;

// =============================================================================
// Types
// =============================================================================

/**
 * Reason a pointer-layer construction was skipped. Surfaced to the
 * caller (ProfileStorageProvider) so the cause can be logged without
 * crashing the connect flow. Keep values stable — they show up in
 * logs and tests may assert on them.
 */
export type PointerWiringSkipReason =
  | 'oracle_missing'
  | 'aggregator_client_unavailable'
  | 'trust_base_unavailable'
  | 'storage_not_durable'
  | 'identity_missing'
  | 'lock_file_path_missing'
  | 'pointer_init_failed';

export type PointerWiringResult =
  | { readonly ok: true; readonly layer: ProfilePointerLayer }
  | {
      readonly ok: false;
      readonly reason: PointerWiringSkipReason;
      readonly detail?: string;
      // Steelman³⁸ warning: preserve typed AggregatorPointerError code
      // when the failure was a typed pointer-layer error. Consumers
      // can switch on this rather than parsing the `detail` string.
      readonly code?: string;
      // The underlying error object, for debugging / cause chains.
      readonly cause?: unknown;
    };

export interface PointerWiringInput {
  /** Wallet identity (provides private key + chain pubkey). */
  readonly identity: FullIdentity;
  /**
   * Per-device local cache. MUST be marked with `[DURABLE_STORAGE]: true`
   * (see profile/aggregator-pointer/flag-store.ts) before this helper can
   * construct a FlagStore. Backends that cannot prove durability are
   * skipped with `storage_not_durable`.
   */
  readonly localCache: StorageProvider;
  /**
   * OrbitDB adapter. Required so `fetchAndJoin` can persist bundle
   * refs after a successful remote CAR fetch.
   */
  readonly db: ProfileDatabase;
  /** Oracle provider (must expose `getAggregatorClient` + `getRootTrustBase`). */
  readonly oracle: OracleProvider;
  /** IPFS gateway URLs used by the CAR fetcher (rotated in order). */
  readonly ipfsGateways: readonly string[];
  /** Pointer-layer capability config (allowOperatorOverrides etc.). */
  readonly config?: PointerLayerConfig;
  /**
   * Node.js-only: absolute path for `proper-lockfile`. Pointer
   * construction is skipped with `lock_file_path_missing` in Node
   * runtimes when this is absent. Ignored in the browser (Web Locks).
   */
  readonly lockFilePath?: string;
  /**
   * Network identifier — passed through to `createMasterPrivateKey`
   * for SPEC §14.1 / §11.12 denylist enforcement. Pass 'test-vectors'
   * to accept the canonical 0x01×32 KAT vector; any other value (or
   * undefined) rejects it. Production deployments should leave this
   * undefined or set to 'mainnet' / 'testnet' / 'dev'.
   */
  readonly network?: string;
  /** Turn on verbose logging for the wiring helper itself. */
  readonly debug?: boolean;
}

// =============================================================================
// Helpers — callbacks injected into the pointer layer
// =============================================================================

/** Storage key for the per-device pointer version (SPEC §13). */
const LOCAL_VERSION_KEY = 'profile.pointer.version';

/**
 * Parse a CAR byte buffer and return its root CID bytes, or `null`
 * if the CAR is malformed or has no roots. Dynamic import keeps
 * `@ipld/car` out of the hot path of tree-shaken browser bundles
 * that don't hit this code.
 */
async function extractCarRootCid(carBytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const { CarReader } = await import('@ipld/car');
    const reader = await CarReader.fromBytes(carBytes);
    const roots = await reader.getRoots();
    if (roots.length === 0) return null;
    return new Uint8Array(roots[0].bytes);
  } catch {
    return null;
  }
}

function cidBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Build a `fetchCar` that iterates over the configured IPFS gateways
 * and maps the gateway-level failure kinds onto the pointer-layer
 * `CarFetchResult` shape.
 *
 * The pointer layer's `CarFetchResult` has only three failure modes:
 *   - `transient_unavailable` — network / HTTP errors, try again later
 *   - `content_mismatch`      — bytes don't hash to the expected CID
 *   - `car_parse_failed`      — bytes aren't a valid CAR
 *
 * `classifyVersion` promotes a version to `VALID` on `ok: true`, so
 * content-address verification MUST happen here or the inclusion-
 * proof authentication boundary is defeated (a hostile gateway
 * returning any HTTP 200 body would be accepted). We verify by
 * parsing the CAR header and byte-comparing the root CID to the
 * caller-supplied `cidBytes`.
 *
 * A wall-clock budget (`CAR_FETCH_TOTAL_BUDGET_MS`) caps the total
 * time across all gateways so a misconfigured operator with N
 * stalling gateways cannot block the hot path for N × per-gateway
 * timeout.
 */
function buildCarFetcher(gateways: readonly string[]): CarFetcher {
  return async (cidBytes: Uint8Array) => {
    let cidString: string;
    try {
      cidString = CID.decode(cidBytes).toString();
    } catch {
      return { ok: false, kind: 'car_parse_failed' } as const;
    }

    const startedAt = Date.now();
    const budgetRemaining = (): number =>
      Math.max(0, CAR_FETCH_TOTAL_BUDGET_MS - (Date.now() - startedAt));

    let lastTransient: string | null = null;
    for (const gateway of gateways) {
      if (budgetRemaining() === 0) {
        return {
          ok: false,
          kind: 'transient_unavailable',
        } as unknown as { readonly ok: false; readonly kind: 'transient_unavailable' };
      }

      const url = `${gateway.replace(/\/+$/, '')}/ipfs/${cidString}?format=car`;
      let outcome;
      try {
        // Clamp per-gateway total budget to whatever is left on the
        // outer budget so the inner fetch cannot outlive the cap.
        outcome = await fetchCarFromGateway(url, { totalMs: budgetRemaining() });
      } catch (err) {
        lastTransient = err instanceof Error ? err.message : String(err);
        continue;
      }

      if (outcome.ok) {
        // Content-address verify: extract the root CID from the CAR
        // header and compare byte-for-byte. A CAR file's root CID
        // does not equal sha256(carBytes) — the CAR is a serialized
        // DAG container, not a raw blob — so `verifyCidMatchesBytes`
        // from profile/ipfs-client does not apply. Use the CAR
        // reader's `getRoots()` instead.
        const rootCid = await extractCarRootCid(outcome.bytes);
        if (rootCid === null) {
          return { ok: false, kind: 'car_parse_failed' } as const;
        }
        if (!cidBytesEqual(rootCid, cidBytes)) {
          // Mismatch is not necessarily transient — a single hostile
          // gateway returning wrong bytes is an attacker signal. But
          // it could also be a gateway caching-bug returning the
          // wrong content for a requested CID. Per SPEC §8.2 step 3
          // this is SEMANTICALLY_INVALID, so we do NOT retry other
          // gateways; the CID is the authoritative identifier.
          return { ok: false, kind: 'content_mismatch' } as const;
        }
        return { ok: true } as const;
      }

      switch (outcome.kind) {
        case 'content_encoding_rejected':
          // Any Content-Encoding on a CAR fetch is a protocol
          // violation — per SPEC §8.5 D6 we do NOT retry other
          // gateways on this class of failure; it's a
          // deterministic rejection.
          return { ok: false, kind: 'car_parse_failed' } as const;
        case 'byte_cap_exceeded':
          return { ok: false, kind: 'car_parse_failed' } as const;
        case 'initial_response_timeout':
        case 'stall_timeout':
        case 'total_timeout':
        case 'http_error':
        case 'network_error':
        default:
          lastTransient = outcome.detail;
          continue;
      }
    }

    return { ok: false, kind: 'transient_unavailable', detail: lastTransient ?? 'no gateways' } as unknown as
      { readonly ok: false; readonly kind: 'transient_unavailable' };
  };
}

/**
 * Build a `resolveRemoteCid` callback that re-runs Phase 1+2 of
 * classifyVersion (inclusion proofs + XOR-decode) for a given
 * version and returns the decoded CID bytes.
 *
 * Phase 3 (CAR fetch) is NOT repeated here because discovery has
 * already certified the version as VALID via an earlier classifyVersion
 * pass. Recoverable failure modes are mapped onto pointer-layer
 * error codes so the caller (reconcile / recoverLatest) can
 * propagate a clear diagnostic.
 */
function buildResolveRemoteCid(deps: {
  keyMaterial: PointerKeyMaterial;
  signer: PointerSigner;
  aggregatorClient: AggregatorClient;
  trustBase: RootTrustBase;
  decodeCid: CidDecoder;
}): (version: PointerVersion) => Promise<Uint8Array> {
  return async (version: PointerVersion) => {
    const result = await decodeVersionCid({
      v: version,
      keyMaterial: deps.keyMaterial,
      signer: deps.signer,
      aggregatorClient: deps.aggregatorClient,
      trustBase: deps.trustBase,
      decodeCid: deps.decodeCid,
    });
    if (result.ok) return result.cidBytes;

    // A `'semantic'` failure here would be surprising — discovery is
    // supposed to have validated this version already. Treat it as a
    // protocol error so the caller surfaces it clearly instead of
    // silently failing. A transient failure is signalled with the
    // dedicated error code so callers can retry.
    if (result.reason === 'transient') {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.NETWORK_ERROR,
        `resolveRemoteCid: transient aggregator failure at v=${version}; retry later.`,
      );
    }
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.PROTOCOL_ERROR,
      `resolveRemoteCid: semantic failure at v=${version} for a version previously classified as VALID.`,
    );
  };
}

/**
 * Build a `fetchAndJoin` callback. On publish conflict (§9.2) the
 * pointer layer calls this with the remote winner's `(cidBytes,
 * remoteVersion)`. We:
 *
 *   1. Decode the CID bytes to a CID string (SDK transport is string-based).
 *   2. Fetch the CAR from IPFS with content-address verification
 *      (`profile/ipfs-client.ts:fetchFromIpfs` already rejects byte
 *      streams whose hash does not match the CID).
 *   3. Write the remote CID as a bundle ref in OrbitDB — OrbitDB
 *      replication + `ProfileTokenStorageProvider.load()` merge the
 *      new bundle into the joined view on the next read.
 *   4. Persist `profile.pointer.version = remoteVersion` so subsequent
 *      reconcile passes start from the advanced cursor.
 *
 * This callback is the SOLE owner of cursor advancement on the
 * conflict path (per the FetchAndJoinCallback contract in
 * reconcile-algorithm.ts). `reconcileAndPublish` does not call
 * `persistLocalVersion` after we return — it only updates its
 * in-memory loop variable. The bundle-ref-first / cursor-after ordering
 * inside this callback is therefore the only place enforcing the
 * "no orphan cursor without a bundle ref" invariant.
 *
 * Limitation (T-D0): the multi-bundle JOIN currently runs under
 * last-writer-wins for same-tokenId collisions and does not perform
 * longest-valid-chain resolution or proof enrichment. For the
 * single-device cold-start and disjoint-token-set cases this is
 * correct; cross-device conflicts on the same tokenId are resolved
 * deterministically but not optimally until the per-token JOIN
 * resolver lands (PROFILE-AGGREGATOR-POINTER-D0-JOIN-AUDIT.md
 * Rules 3 + 4).
 */
function buildFetchAndJoin(deps: {
  db: ProfileDatabase;
  gateways: readonly string[];
  persistLocalVersion: (v: PointerVersion) => Promise<void>;
  /**
   * Per-wallet encryption key matching
   * `ProfileTokenStorageProvider.encryptionKey`. Bundle refs at
   * `tokens.bundle.{cid}` are encrypted-by-convention on the write
   * side; mismatched encryption here would make reads fail to
   * decrypt.
   */
  bundleEncryptionKey: Uint8Array;
}): FetchAndJoinCallback {
  return async (remoteCid: Uint8Array, remoteVersion: PointerVersion) => {
    // 1. Decode CID bytes to the canonical string form.
    let cidString: string;
    try {
      cidString = CID.decode(remoteCid).toString();
    } catch (err) {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.PROTOCOL_ERROR,
        `fetchAndJoin: invalid CID bytes at v=${remoteVersion}: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        { cause: err },
      );
    }

    if (deps.gateways.length === 0) {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.CAR_UNAVAILABLE,
        `fetchAndJoin: no IPFS gateways configured (cannot fetch ${cidString}).`,
      );
    }

    // 2. Fetch CAR via profile/ipfs-client — it already performs the
    //    CID content-address verify internally.
    try {
      await fetchFromIpfs([...deps.gateways], cidString);
    } catch (err) {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.CAR_UNAVAILABLE,
        `fetchAndJoin: CAR fetch failed for ${cidString}: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        { cause: err },
      );
    }

    // 3. Record the remote bundle ref so the next JOIN pass picks it
    //    up. Mirror ProfileTokenStorageProvider.addBundle exactly:
    //    same JSON shape, same encryption (deterministic per-wallet
    //    key — see comment at the call site).
    const ref: UxfBundleRef = {
      cid: cidString,
      status: 'active',
      createdAt: Math.floor(Date.now() / 1000),
      // tokenCount unknown here — the CAR contents are not parsed.
      // ProfileTokenStorageProvider re-counts on next flush.
    };
    const serialized = new TextEncoder().encode(JSON.stringify(ref));
    let encrypted: Uint8Array;
    try {
      encrypted = await encryptProfileValue(deps.bundleEncryptionKey, serialized);
    } catch (err) {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.PROTOCOL_ERROR,
        `fetchAndJoin: bundle-ref encryption failed for ${cidString}: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        { cause: err },
      );
    }

    // Write the OrbitDB bundle ref FIRST, persistLocalVersion AFTER.
    //
    // The original ordering (persistLocalVersion → put) is unsafe under
    // any failure of the OrbitDB write: the local cursor advances to
    // `version = remoteVersion` but no bundle ref ever lands. The next
    // reconcile round queries the aggregator for versions > remoteVersion
    // and never re-fetches the bundle for `remoteVersion` — its tokens
    // are permanently invisible to JOIN. The OrbitDB write can fail
    // through any of: a 15s hard-timeout (see `ORBITDB_WRITE_TIMEOUT_MS`)
    // because @orbitdb/core queues writes against OpLog heads and can
    // hang when the replication layer is stuck; a thrown sync error from
    // the OrbitDB peer; or a `put`-path encryption/envelope failure.
    //
    // Correct ordering: write the bundle ref first. If it fails,
    // persistLocalVersion never runs — the cursor stays at its previous
    // value, and the next reconcile re-fetches the same `(remoteCid,
    // remoteVersion)` pair. The OrbitDB write is idempotent (same key
    // = `BUNDLE_KEY_PREFIX + cidString`, deterministically encrypted
    // payload — encryptProfileValue uses random nonces, but the ref
    // semantics are key-scoped so a duplicate put is a harmless
    // overwrite). The IPFS fetch above is content-addressed and also
    // idempotent.
    //
    // If persistLocalVersion fails AFTER the bundle ref lands, the
    // cursor stays behind OrbitDB on the next reconcile but the JOIN
    // walker still sees the ref (knownBundleCids picks it up), so
    // tokens remain visible. Reconcile re-attempts the same version.
    //
    // T-D11 W11: stamp the write with originated='system'.
    // fetchAndJoin's bundle-ref writes mirror addBundle — both are
    // system-generated cache-index events (not user actions), so
    // the envelope tag matches ProfileTokenStorageProvider.addBundle.
    // This keeps the peer's replication view consistent regardless
    // of which local path produced the ref.
    const bundleKey = BUNDLE_KEY_PREFIX + cidString;
    try {
      if (typeof deps.db.putEntry === 'function') {
        const envelope = buildLocalEntry({
          type: 'cache_index',
          originated: 'system',
          payload: encrypted,
        });
        await withTimeout(
          deps.db.putEntry(bundleKey, envelope),
          ORBITDB_WRITE_TIMEOUT_MS,
          `fetchAndJoin: OrbitDB bundle-ref write timed out after ${ORBITDB_WRITE_TIMEOUT_MS}ms for ${cidString}`,
        );
      } else {
        await withTimeout(
          deps.db.put(bundleKey, encrypted),
          ORBITDB_WRITE_TIMEOUT_MS,
          `fetchAndJoin: OrbitDB bundle-ref write timed out after ${ORBITDB_WRITE_TIMEOUT_MS}ms for ${cidString}`,
        );
        // Mirror the markLocallyAuthored convention — see the same
        // fallback in ProfileTokenStorageProvider.addBundle.
        const markHook = (deps.db as { markLocallyAuthored?: (k: string) => void })
          .markLocallyAuthored;
        if (typeof markHook === 'function') {
          markHook.call(deps.db, bundleKey);
        }
      }
    } catch (err) {
      if (err instanceof AggregatorPointerError) throw err;
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.PROTOCOL_ERROR,
        `fetchAndJoin: OrbitDB bundle-ref write failed for ${cidString}: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        { cause: err },
      );
    }

    // Cursor advance AFTER bundle ref is durable. A failure here leaves
    // the bundle ref in OrbitDB (JOIN still sees it) but the cursor at
    // its previous value — recoverable via re-reconcile.
    await deps.persistLocalVersion(remoteVersion);
  };
}

/** Hard cap for an OrbitDB write from inside fetchAndJoin. */
const ORBITDB_WRITE_TIMEOUT_MS = 15_000;

/** Race a promise against a wall-clock timeout. */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new AggregatorPointerError(
          AggregatorPointerErrorCode.PROTOCOL_ERROR,
          message,
        ),
      );
    }, ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Build a `CidDecoder` using `multiformats`. Returns `{ ok: false }`
 * on any parse failure — upstream treats this as
 * `SEMANTICALLY_INVALID` (probe classification).
 *
 * The 64-byte XOR-decoded plaintext encodes the CID with a length
 * prefix (SPEC §5.3):
 *
 *   full[0]           = cidLen (uint8, 1..63)
 *   full[1 .. 1+cidLen] = cidBytes
 *   full[1+cidLen..64]  = padding (derived, discarded)
 *
 * The decoder extracts the slice and hands it to `CID.decode` for
 * multiformats parsing. Length-prefix validation guards against
 * malformed payloads (cidLen=0 or > remaining bytes).
 */
function buildCidDecoder(): CidDecoder {
  return (full: Uint8Array) => {
    try {
      if (full.length === 0) return { ok: false };
      const cidLen = full[0];
      if (cidLen === undefined || cidLen === 0 || cidLen > full.length - 1) {
        return { ok: false };
      }
      const cidBytes = full.subarray(1, 1 + cidLen);
      // CID.decode validates varint structure, multihash length, etc.
      // It throws on malformed input; clone the bytes so the returned
      // slice is not backed by the transient `full` buffer (which
      // aggregator-probe zeroes on exit).
      const cid = CID.decode(cidBytes);
      return { ok: true, cidBytes: new Uint8Array(cid.bytes) };
    } catch {
      return { ok: false };
    }
  };
}

// =============================================================================
// Public entry point
// =============================================================================

/**
 * Attempt to construct a `ProfilePointerLayer` from the given wiring
 * dependencies. Returns a structured result — never throws — so the
 * caller can log the specific skip reason and proceed.
 */
export async function buildProfilePointerLayer(
  input: PointerWiringInput,
): Promise<PointerWiringResult> {
  const debug = input.debug ?? false;
  const log = (msg: string): void => {
    if (debug) {
      logger.debug('PointerWiring', msg);
    }
  };

  // 1. Identity
  if (!input.identity?.privateKey || !input.identity?.chainPubkey) {
    return { ok: false, reason: 'identity_missing' };
  }

  // 2. Oracle — aggregator client + trust base
  if (!input.oracle) {
    return { ok: false, reason: 'oracle_missing' };
  }
  const aggregatorClient = (input.oracle.getAggregatorClient?.() ?? null) as AggregatorClient | null;
  if (!aggregatorClient) {
    return { ok: false, reason: 'aggregator_client_unavailable' };
  }
  const trustBase = (input.oracle.getRootTrustBase?.() ?? null) as RootTrustBase | null;
  if (!trustBase) {
    return { ok: false, reason: 'trust_base_unavailable' };
  }

  // 3. Durable storage for flag store. FlagStore.create asserts this
  //    too, but pre-checking here lets us surface a clean skip reason
  //    instead of an AggregatorPointerError.
  if (!isDurableProvider(input.localCache)) {
    return { ok: false, reason: 'storage_not_durable' };
  }

  // 4. Derive HKDF key material. Any failure inside the crypto stack
  //    surfaces as `pointer_init_failed` — we do not leak the
  //    underlying error to avoid seeding stack traces with anything
  //    the log-scrub test would flag.
  //
  // Residual-risk narrowing (SPEC §11.11, R-11): master key bytes
  // are wiped as soon as HKDF derivation completes. `rawPrivKeyBytes`
  // is the input to createMasterPrivateKey (which copies internally);
  // we fill(0) it immediately after the copy so the hex-decode
  // intermediate doesn't linger in heap. `masterKey.zeroize()` wipes
  // the internal copy after derivePointerKeyMaterial returns.
  const rawPrivKeyBytes = hexToBytes(input.identity.privateKey);
  let masterKey: ReturnType<typeof createMasterPrivateKey> | null = null;
  let bundleEncryptionKey: Uint8Array | null = null;
  try {
    masterKey = createMasterPrivateKey(rawPrivKeyBytes, input.network);
    rawPrivKeyBytes.fill(0);
    const keyMaterial = derivePointerKeyMaterial(masterKey);
    // Steelman remediation (R-11): derive the bundle AES key from the
    // SAME masterKey while it is live, using a defensive copy that we
    // wipe in the finally block below. The previous implementation
    // called `hexToBytes(input.identity.privateKey)` a SECOND time at
    // layer-construction, leaking an unwiped plaintext private-key
    // copy to the heap for the lifetime of the layer.
    {
      const masterBytesCopy = masterKey.bytes;
      try {
        bundleEncryptionKey = deriveProfileEncryptionKey(masterBytesCopy);
      } finally {
        masterBytesCopy.fill(0);
      }
    }
    masterKey.zeroize();
    masterKey = null;
    const signer = await buildPointerSigner(keyMaterial.signingSeed);

    const flagStore = FlagStore.create(input.localCache, signer.signingPubKeyHex);

    // Publish mutex — Web Locks in browser, proper-lockfile in Node.
    // The lockName doubles as the Web Locks key + the file-lock
    // lockFilePath identifier, both scoped per-wallet via signingPubKey.
    const lockName = `profile.pointer.publish.${signer.signingPubKeyHex}`;
    const isNode = typeof process !== 'undefined' && !!process.versions?.node;
    if (isNode && !input.lockFilePath) {
      return { ok: false, reason: 'lock_file_path_missing' };
    }
    const mutex = createPointerMutex(lockName, {
      lockFilePath: input.lockFilePath,
    });

    const fetchCar = buildCarFetcher(input.ipfsGateways);
    const decodeCid = buildCidDecoder();

    const readLocalVersion = async (): Promise<number> => {
      const raw = await input.localCache.get(LOCAL_VERSION_KEY);
      if (raw === null) return 0;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 0) return 0;
      return parsed;
    };
    const persistLocalVersion = async (v: number): Promise<void> => {
      await input.localCache.set(LOCAL_VERSION_KEY, String(v));
    };

    const resolveRemoteCid = buildResolveRemoteCid({
      keyMaterial,
      signer,
      aggregatorClient,
      trustBase,
      decodeCid,
    });

    // `bundleEncryptionKey` was derived above from the live masterKey
    // (steelman R-11 remediation). Guarded against the earlier-throw
    // path via a non-null assertion: if we reach here the derivation
    // succeeded. Bundle-ref reads go through `decryptProfileValue` with
    // this key — writing raw bytes here would cause decrypt failures
    // on read. Deterministic derivation from the wallet private key
    // means both sides compute the same key without needing to share
    // state.
    if (bundleEncryptionKey === null) {
      throw new Error('pointer-wiring invariant: bundleEncryptionKey not derived');
    }

    const fetchAndJoin = buildFetchAndJoin({
      db: input.db,
      gateways: input.ipfsGateways,
      persistLocalVersion,
      bundleEncryptionKey,
    });

    const layer = new ProfilePointerLayer({
      keyMaterial,
      signer,
      aggregatorClient,
      trustBase,
      flagStore,
      mutex,
      decodeCid,
      fetchCar,
      fetchAndJoin,
      readLocalVersion,
      persistLocalVersion,
      resolveRemoteCid,
      config: input.config,
    });

    log(`constructed for pubkey ${signer.signingPubKeyHex.slice(0, 8)}…`);
    return { ok: true, layer };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Steelman³⁸: preserve typed code if the underlying error was an
    // AggregatorPointerError so consumers can route on it.
    const code =
      err instanceof AggregatorPointerError ? err.code : undefined;
    logger.warn('PointerWiring', `pointer layer init failed: ${detail}`);
    return { ok: false, reason: 'pointer_init_failed', detail, code, cause: err };
  } finally {
    // Residual-risk narrowing: if we threw BEFORE the explicit
    // zeroize() above (e.g., inside derivePointerKeyMaterial or
    // later), wipe the leftover master-key copy + raw hex buffer
    // here. Safe-idempotent: zeroize() is a no-op on an already-
    // zeroized instance.
    if (masterKey !== null) masterKey.zeroize();
    rawPrivKeyBytes.fill(0);
  }
}

// =============================================================================
// Utilities
// =============================================================================

// Steelman³⁵/³⁶: thin wrapper that strips 0x/0X prefix then delegates
// to the consolidated core/hex.ts strict decoder. Local wrapper
// retained because pointer-wiring callers may pass ethers-style
// 0x-prefixed hex (case-insensitive per EIP-55); core/hex.ts:hexToBytes
// deliberately does NOT auto-strip.
function hexToBytes(hex: string): Uint8Array {
  if (typeof hex !== 'string') {
    throw new TypeError(`hexToBytes: expected string, got ${typeof hex}`);
  }
  const hasPrefix = hex.length >= 2 && hex[0] === '0' && (hex[1] === 'x' || hex[1] === 'X');
  const clean = hasPrefix ? hex.slice(2) : hex;
  return strictHexToBytesCore(clean);
}

// =============================================================================
// Test-only exports
// =============================================================================

/**
 * Internals exposed for unit tests — not part of the public API.
 * Allows tests to exercise the callback builders in isolation with
 * injected mocks, rather than spinning up a full pointer-layer stack.
 */
export const __internal = {
  buildResolveRemoteCid,
  buildFetchAndJoin,
  buildCarFetcher,
  buildCidDecoder,
};
