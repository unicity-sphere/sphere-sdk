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
 *     joined view. The per-token JOIN resolver (Rules 3 + 4 of the
 *     D0 audit) is now wired: `resolveTokenRoot` (`uxf/token-join.ts`
 *     — exported and unit-tested) classifies overlapping tokenIds
 *     across remote + local bundles using longest-valid-chain
 *     semantics, with production callers in `UxfPackage.merge()`
 *     (`uxf/UxfPackage.ts:~785`) and the post-load conflict pass
 *     (`modules/payments/transfer/conflict-merger.ts:~351`). The
 *     reactive submit-time arm (`Item #14` Phase 1) emits
 *     `transfer:double-spend-detected` on aggregator state mismatch,
 *     and the snapshot-time arm (`PR #182`, JOIN-divergent loser
 *     detection in `PaymentsModule.loadFromStorageData` ~line 15112)
 *     drops superseded `'transferring'` tokens with a tombstone.
 *
 * @see PROFILE-AGGREGATOR-POINTER-IMPL-PLAN.md Phase D (T-D4 consumption, T-D3c)
 * @see PROFILE-AGGREGATOR-POINTER-INTEGRATION-MAP.md §3.2
 * @see PROFILE-AGGREGATOR-POINTER-D0-JOIN-AUDIT.md (Rules 1/3/4 — now landed)
 * @see uxf/token-join.ts — resolveTokenRoot implementation
 * @see modules/payments/PaymentsModule.ts — loadFromStorageData JOIN-divergent loser branch (PR #182)
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
import {
  parseLeanProfileSnapshotFromRootBlock,
  type LeanProfileSnapshot,
} from './profile-lean-snapshot';
import type { ApplySnapshotResult } from './profile-snapshot-dispatcher';

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
  | 'snapshot_applier_missing'
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
  /**
   * Item #15 Phase D.2 / E — pull-side snapshot applier. REQUIRED under
   * Item #15: the `fetchAndJoin` callback parses the remote CAR as a
   * {@link LeanProfileSnapshot} and dispatches per-writer JOIN via
   * this callback. Phase E removed the legacy bundle-CID-only fallback
   * (per the maintainer call: no backward compat) — the pointer layer
   * now ONLY processes lean-snapshot CARs.
   *
   * On parse failure (the remote CAR is not a lean snapshot, or is
   * malformed), the dispatcher throws a typed pointer-layer error so
   * the reconcile loop surfaces a clear diagnostic. A wiring without
   * an applier is rejected by `buildProfilePointerLayer` with the
   * `snapshot_applier_missing` skip reason — the wallet then runs
   * without aggregator-pointer recovery rather than silently writing
   * the wrong CAR shape to the bundle index.
   */
  readonly applySnapshot: (
    snapshot: LeanProfileSnapshot,
  ) => Promise<ApplySnapshotResult>;
  /** Turn on verbose logging for the wiring helper itself. */
  readonly debug?: boolean;
}

// =============================================================================
// Helpers — callbacks injected into the pointer layer
// =============================================================================

/** Storage key for the per-device pointer version (SPEC §13). */
const LOCAL_VERSION_KEY = 'profile.pointer.version';

/**
 * Issue #310 — local cache key for the OpLog epoch floor. Single
 * source of truth for the key namespace; the snapshot builder in
 * `factory.ts` reads from the same key when stamping the next root
 * block's `epoch` field.
 */
export const LOCAL_EPOCH_FLOOR_KEY = 'profile.pointer.epoch_floor';
export const LOCAL_EPOCH_RESET_REASON_KEY =
  'profile.pointer.epoch_reset_reason';
/**
 * PR #316 F3 fix — sentinel KV key written by `resetEpoch` BEFORE
 * triggering the dirty-flush. The value is the post-reset epoch
 * encoded as a decimal string (matches `LOCAL_EPOCH_FLOOR_KEY`'s
 * encoding).
 *
 * Purpose: give the OrbitDB-backed flush path concrete dirty state
 * to write even when the OpLog has just been wiped via
 * `OrbitDbAdapter.resetCorruptedLog`. Without this sentinel, an
 * idle wallet whose post-reset OpLog is empty MAY (depending on
 * the snapshot builder's internal change-detection heuristic)
 * skip building a fresh snapshot — leaving the aggregator chain
 * stuck at the pre-reset version and the local floor at +1
 * indefinitely until the user triggers another mutation.
 *
 * **Single slot.** The key is overwritten on every subsequent
 * reset (the value is always the latest `newEpoch`), so the
 * sentinel never accumulates across many resets. The post-publish
 * cleanup is a no-op — the next reset just overwrites it.
 */
export const LOCAL_EPOCH_RESET_FLUSH_TRIGGER_KEY =
  'profile.pointer.epoch_reset_flush_trigger';

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
 *   3. Parse the CAR as a {@link LeanProfileSnapshot} (Item #15 D.2)
 *      and dispatch per-writer JOIN via `applySnapshot`. Each writer
 *      persists its prefix-filtered slice of the snapshot into its
 *      own storage; the bundle-ref index is one of those writers
 *      (BundleIndex), so the merged `tokens.bundle.*` entries land
 *      through the same path. A malformed CAR — i.e. the remote does
 *      not publish a lean snapshot — is a hard PROTOCOL_ERROR; Phase
 *      E removed the legacy bundle-CID-only fallback that used to
 *      silently absorb the CAR into a single `tokens.bundle.{cid}`
 *      entry.
 *   4. Persist `profile.pointer.version = remoteVersion` so subsequent
 *      reconcile passes start from the advanced cursor.
 *
 * This callback is the SOLE owner of cursor advancement on the
 * conflict path (per the FetchAndJoinCallback contract in
 * reconcile-algorithm.ts). `reconcileAndPublish` does not call
 * `persistLocalVersion` after we return — it only updates its
 * in-memory loop variable. The applier-then-cursor ordering inside
 * this callback is therefore the only place enforcing the
 * "no orphan cursor without applied snapshot state" invariant.
 */
function buildFetchAndJoin(deps: {
  gateways: readonly string[];
  persistLocalVersion: (v: PointerVersion) => Promise<void>;
  /**
   * Item #15 Phase D.2 / E — REQUIRED. The remote CAR is parsed as a
   * {@link LeanProfileSnapshot} and dispatched through this callback.
   * Phase E removed the legacy bundle-CID-only fallback; this callback
   * is now the only sink for remote pointer state.
   */
  applySnapshot: (
    snapshot: LeanProfileSnapshot,
  ) => Promise<ApplySnapshotResult>;
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

    // 2. Fetch the dag-cbor root block via profile/ipfs-client. The
    //    publisher pins via `dag/import`, so each CAR block (currently
    //    just the root) lands under its canonical CID — `block/get(rootCid)`
    //    returns the dag-cbor encoded root block bytes directly (NOT a
    //    CAR envelope). `fetchFromIpfs` already content-address-verifies
    //    sha256(bytes) == cidString.multihash.
    let rootBlockBytes: Uint8Array;
    try {
      rootBlockBytes = await fetchFromIpfs([...deps.gateways], cidString);
    } catch (err) {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.CAR_UNAVAILABLE,
        `fetchAndJoin: snapshot block fetch failed for ${cidString}: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        { cause: err },
      );
    }

    // 3. Item #15 Phase D.2 / E — decode the dag-cbor root block as a
    //    lean snapshot and dispatch per-writer JOIN. OrbitDB writes
    //    happen inside the writers' `joinSnapshot()`; the cursor advance
    //    runs LAST so a JOIN failure does not strand the cursor past
    //    unconsumed remote state. Phase E removed the legacy bundle-CID-
    //    only fallback — `applySnapshot` is required and a parse failure
    //    is a hard PROTOCOL_ERROR rather than a silent re-write.
    let snapshot: LeanProfileSnapshot;
    try {
      // Phase 4 (issue #200) — v3 snapshots carry KV entries in
      // per-group sub-blocks; the fetcher closure resolves each
      // sub-block CID against the same gateway list as the root.
      // `fetchFromIpfs` content-address-verifies every block so the
      // dag-cbor decode operates on authenticated bytes.
      snapshot = await parseLeanProfileSnapshotFromRootBlock(
        rootBlockBytes,
        (subBlockCid) => fetchFromIpfs([...deps.gateways], subBlockCid),
      );
    } catch (err) {
      // The remote CAR is malformed or not a lean snapshot. Treat
      // as a hard protocol error. The next reconcile pass will
      // re-fetch and re-attempt; if the remote keeps publishing
      // malformed CARs, an operator must intervene.
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.PROTOCOL_ERROR,
        `fetchAndJoin: lean-snapshot parse failed for ${cidString} at v=${remoteVersion}: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        { cause: err },
      );
    }

    try {
      await deps.applySnapshot(snapshot);
    } catch (err) {
      // Throwing here keeps the cursor behind the unconsumed
      // remote, so the next reconcile pass re-fetches + re-applies.
      // Per-writer errors are already swallowed inside the
      // dispatcher (see profile/profile-snapshot-dispatcher.ts) —
      // an exception that escapes is a hard failure (e.g. the
      // dispatcher itself threw before any writer ran).
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.PROTOCOL_ERROR,
        `fetchAndJoin: applySnapshot threw for ${cidString} at v=${remoteVersion}: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        { cause: err },
      );
    }

    // Cursor advance AFTER all per-writer JOINs persist. A failure
    // here leaves the JOIN-applied entries durable (the dispatcher's
    // writers persist as they go), while the cursor stays behind so
    // the next reconcile re-runs the dispatch idempotently against
    // the same (or newer) remote.
    await deps.persistLocalVersion(remoteVersion);
  };
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

  // 4. Item #15 Phase E: the snapshot applier is the only sink for
  //    remote pointer state. Skip layer construction with a clean
  //    diagnostic when wiring is incomplete rather than building a
  //    layer whose fetchAndJoin would crash on the first remote.
  if (typeof input.applySnapshot !== 'function') {
    return { ok: false, reason: 'snapshot_applier_missing' };
  }

  // 5. Derive HKDF key material. Any failure inside the crypto stack
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
  try {
    masterKey = createMasterPrivateKey(rawPrivKeyBytes, input.network);
    rawPrivKeyBytes.fill(0);
    const keyMaterial = derivePointerKeyMaterial(masterKey);
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

    // Issue #310 — epoch floor read/write. Same pattern as the local
    // version pair; fail-closed to 0 on any parse error so a
    // corrupted cache cannot drive the walkback floor into an
    // undefined state.
    const readEpochFloor = async (): Promise<number> => {
      const raw = await input.localCache.get(LOCAL_EPOCH_FLOOR_KEY);
      if (raw === null) return 0;
      const parsed = Number.parseInt(raw, 10);
      if (
        !Number.isFinite(parsed) ||
        !Number.isInteger(parsed) ||
        parsed < 0
      ) {
        return 0;
      }
      return parsed;
    };
    const persistEpochFloor = async (epoch: number): Promise<void> => {
      if (
        typeof epoch !== 'number' ||
        !Number.isFinite(epoch) ||
        !Number.isInteger(epoch) ||
        epoch < 0
      ) {
        // Refuse to persist garbage; the pointer layer treats this as
        // best-effort so a return is sufficient.
        return;
      }
      await input.localCache.set(LOCAL_EPOCH_FLOOR_KEY, String(epoch));
    };

    const resolveRemoteCid = buildResolveRemoteCid({
      keyMaterial,
      signer,
      aggregatorClient,
      trustBase,
      decodeCid,
    });

    // Issue #310 — snapshot-epoch inspector. Re-resolve the CID for the
    // given version, fetch the snapshot ROOT block (content-address
    // verified by `fetchFromIpfs`), dag-cbor-decode the root, and
    // return its `epoch` field (or undefined for pre-#310 snapshots).
    //
    // Page-freeze 2026-05-29 fix — closure-scope memoization.
    //
    // Without a memo, every pointer-poll cycle re-issues the full
    // `resolveRemoteCid(v) → fetchFromIpfs(cid)` round-trip for every
    // version it walks back through, even when the previous poll
    // already learned the version's epoch (positive result) or its
    // CID 404s (negative result). Under a degraded testnet gateway
    // that floods the browser console with `/sidecar/blob?cid=… 404`
    // and pegs the daemon CPU, this is the dominant source of
    // redundant work. The memo TTL of 30 s ≥ POINTER_POLL_MIN_MS so
    // a single full poll cycle dedups; values older than that are
    // recomputed in case a stuck gateway has recovered.
    //
    // Memo key = version (a number). Positive entries cache the epoch
    // (`value`); negative entries cache the error so callers see the
    // same failure signature instead of re-walking the same
    // 404/decode/shape failure. The memo lives in the closure of the
    // surrounding layer-build call and is GC'd when the layer is.
    const INSPECT_EPOCH_MEMO_TTL_MS = 30_000;
    interface EpochMemoEntry {
      readonly expiresAt: number;
      readonly value?: number;
      readonly error?: Error;
    }
    const epochMemo = new Map<number, EpochMemoEntry>();

    const inspectSnapshotEpoch = async (
      version: number,
    ): Promise<number | undefined> => {
      const now = Date.now();
      const cached = epochMemo.get(version);
      if (cached !== undefined && cached.expiresAt > now) {
        if (cached.error !== undefined) throw cached.error;
        return cached.value;
      }

      const compute = async (): Promise<number | undefined> => {
        const cidBytes = await resolveRemoteCid(version);
        if (input.ipfsGateways.length === 0) {
          throw new Error(
            `inspectSnapshotEpoch: no IPFS gateways configured for v=${version}`,
          );
        }
        let cidString: string;
        try {
          cidString = CID.decode(cidBytes).toString();
        } catch (err) {
          throw new Error(
            `inspectSnapshotEpoch: invalid CID bytes at v=${version}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const rootBlockBytes = await fetchFromIpfs(
          [...input.ipfsGateways],
          cidString,
        );
        const { decode: cborDecode } = await import('@ipld/dag-cbor');
        let decoded: unknown;
        try {
          decoded = cborDecode(rootBlockBytes);
        } catch (err) {
          throw new Error(
            `inspectSnapshotEpoch: dag-cbor decode failed at v=${version}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (
          decoded === null ||
          typeof decoded !== 'object' ||
          Array.isArray(decoded)
        ) {
          throw new Error(
            `inspectSnapshotEpoch: root block decoded to non-object at v=${version}`,
          );
        }
        const epoch = (decoded as Record<string, unknown>).epoch;
        if (epoch === undefined) return undefined;
        if (
          typeof epoch !== 'number' ||
          !Number.isFinite(epoch) ||
          !Number.isInteger(epoch) ||
          epoch < 0
        ) {
          throw new Error(
            `inspectSnapshotEpoch: invalid epoch ${String(epoch)} at v=${version}`,
          );
        }
        return epoch;
      };

      try {
        const result = await compute();
        epochMemo.set(version, {
          value: result,
          expiresAt: Date.now() + INSPECT_EPOCH_MEMO_TTL_MS,
        });
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        epochMemo.set(version, {
          error,
          expiresAt: Date.now() + INSPECT_EPOCH_MEMO_TTL_MS,
        });
        throw error;
      }
    };

    // Item #15 Phase E: applySnapshot is the only sink for remote
    // pointer state. The precondition above (skip reason
    // `snapshot_applier_missing`) guarantees `input.applySnapshot` is
    // a function here.
    const fetchAndJoin = buildFetchAndJoin({
      gateways: input.ipfsGateways,
      persistLocalVersion,
      applySnapshot: input.applySnapshot,
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
      // Issue #310 — wire OpLog epoch-floor primitives.
      readEpochFloor,
      persistEpochFloor,
      inspectSnapshotEpoch,
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
