/**
 * IPNS → Pointer Migration Reader (T-D6b).
 *
 * One-shot migration path for wallets created before the aggregator
 * pointer layer existed. Pre-pointer wallets have:
 *   - A `profile.ipns.sequence` key in the local cache (monotonic
 *     sequence used by the now-retired IPNS snapshot channel).
 *   - An IPNS record on the network pointing at a JSON snapshot of
 *     the wallet's active bundle CIDs.
 *   - No `profile.pointer.migration.done` marker yet.
 *
 * On next cold-start (`ProfileTokenStorageProvider.initialize()`) we
 * detect this via `needsMigration(localCache)` and run
 * `runIpnsToPointerMigration()` — reads the IPNS snapshot, writes
 * each active bundle ref into OrbitDB, and stamps the migration-
 * done marker. The pointer layer's FIRST subsequent flush then
 * publishes the bundle set under the new anchor.
 *
 * New wallets (no IPNS history) skip the migration entirely — no
 * `profile.ipns.sequence` key, no legacy IPNS record, migration
 * marker is never set but also never needed.
 *
 * This module is the successor to the old `profile/profile-ipns.ts`
 * module (T-D6c deletion). Only the READ path survives; the
 * publish/snapshot code is gone — pointer layer is the sole
 * publish channel going forward.
 *
 * @module profile/migration/ipns-reader
 */

import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { CID } from 'multiformats/cid';
import { IpfsCache } from '../../impl/shared/ipfs/ipfs-cache.js';
import { IpfsHttpClient } from '../../impl/shared/ipfs/ipfs-http-client.js';
import { hexToBytes } from '../../core/crypto.js';
import { ProfileError } from '../errors.js';
import { logger } from '../../core/logger.js';
import type { UxfBundleRef } from '../types.js';
import { verifyCarAndExtractFile } from './unixfs-verify.js';

// =============================================================================
// Constants
// =============================================================================

/**
 * HKDF info string that derives the Profile's Ed25519 IPNS identity
 * from the wallet's secp256k1 private key. MUST exactly match the
 * info used by the legacy `profile/profile-ipns.ts` module
 * (`'uxf-profile-ed25519-v1'`), otherwise migration cannot resolve
 * the wallet's own IPNS record.
 */
export const PROFILE_IPNS_HKDF_INFO = 'uxf-profile-ed25519-v1';

/** Local-cache key: legacy IPNS sequence number (presence = legacy wallet). */
export const LEGACY_IPNS_SEQUENCE_KEY = 'profile.ipns.sequence';

/**
 * Local-cache key: migration-done marker. Once set, migration never re-runs.
 *
 * Steelman⁴³ note (THREAT MODEL): this marker is plain unsigned text in
 * local storage. An attacker with filesystem access can:
 *   - DELETE the marker to force re-migration with hostile new IPNS data;
 *   - INJECT the marker to suppress legitimate migration.
 * Both attacks require local filesystem access, which is a stronger threat
 * than the SDK's general perimeter. The local-storage trust assumption is
 * inherent to the legacy migration path; binding the marker to a HMAC-of-
 * chainPubkey would close it but adds infrastructure (key rotation,
 * migration-of-the-migration). Filed as a known limitation.
 */
export const MIGRATION_DONE_KEY = 'profile.pointer.migration.done';

/** Snapshot schema version produced by the legacy IPNS writer. */
const SNAPSHOT_VERSION = 1 as const;

// =============================================================================
// Types
// =============================================================================

export interface SnapshotBundleRef {
  readonly cid: string;
  readonly status: 'active' | 'superseded';
  readonly createdAt: number;
}

export interface ProfileSnapshot {
  readonly version: typeof SNAPSHOT_VERSION;
  readonly walletPubkey: string;
  readonly timestamp: number;
  readonly bundles: ReadonlyArray<SnapshotBundleRef>;
}

/**
 * Minimal local-cache surface the migration needs. Subset of
 * `StorageProvider` — lets callers pass a mock or a narrowed adapter
 * without pulling in the full provider interface.
 */
export interface MigrationLocalCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

// =============================================================================
// Dynamic imports (libp2p Ed25519 key derivation)
// =============================================================================

let libp2pModules: {
  generateKeyPairFromSeed: (typeof import('@libp2p/crypto/keys'))['generateKeyPairFromSeed'];
  peerIdFromPrivateKey: (typeof import('@libp2p/peer-id'))['peerIdFromPrivateKey'];
} | null = null;

async function loadLibp2pModules() {
  if (!libp2pModules) {
    const [crypto, peerIdMod] = await Promise.all([
      import('@libp2p/crypto/keys'),
      import('@libp2p/peer-id'),
    ]);
    libp2pModules = {
      generateKeyPairFromSeed: crypto.generateKeyPairFromSeed,
      peerIdFromPrivateKey: peerIdMod.peerIdFromPrivateKey,
    };
  }
  return libp2pModules;
}

/**
 * Derive the Profile's deterministic IPNS identity from the wallet's
 * secp256k1 private key. Byte-identical to the legacy derivation in
 * `profile/profile-ipns.ts` so the migration can resolve the
 * wallet's own pre-existing IPNS record.
 */
export async function deriveProfileIpnsIdentity(
  privateKeyHex: string,
): Promise<{ keyPair: unknown; ipnsName: string }> {
  const { generateKeyPairFromSeed, peerIdFromPrivateKey } = await loadLibp2pModules();
  const walletSecret = hexToBytes(privateKeyHex);
  const derivedSeed = hkdf(
    sha256,
    walletSecret,
    undefined,
    new TextEncoder().encode(PROFILE_IPNS_HKDF_INFO),
    32,
  );
  const keyPair = await generateKeyPairFromSeed('Ed25519', derivedSeed);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const peerId = peerIdFromPrivateKey(keyPair as any);
  return { keyPair, ipnsName: peerId.toString() };
}

// =============================================================================
// Resolve
// =============================================================================

function deserializeSnapshot(bytes: Uint8Array): ProfileSnapshot {
  const text = new TextDecoder().decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ProfileError(
      'BUNDLE_NOT_FOUND',
      `Failed to parse legacy Profile IPNS snapshot: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { version?: unknown }).version !== SNAPSHOT_VERSION ||
    !Array.isArray((parsed as { bundles?: unknown }).bundles)
  ) {
    throw new ProfileError(
      'BUNDLE_NOT_FOUND',
      `Legacy Profile IPNS snapshot has unexpected shape`,
    );
  }
  return parsed as ProfileSnapshot;
}

/**
 * Fetch the snapshot body from a CID via the `/ipfs/<cid>` gateway
 * path. Authenticity is anchored at the IPNS record's Ed25519
 * signature (verified in `resolveProfileSnapshot` below) — this fetch
 * itself does not content-address verify the BYTES because legacy
 * snapshots were published via `/api/v0/add` (UnixFS-wrapped; CID
 * does not hash directly to the file bytes).
 *
 * Wave G.5 deferred: full UnixFS payload content-verification (parse
 * the CAR + dag-pb root, walk linked chunks, recompute root CID,
 * reconstruct file bytes) requires a non-trivial UnixFS protobuf
 * decoder. The cryptographic authentication boundary still holds
 * via the IPNS Ed25519 signature on the (CID, sequence, validity)
 * tuple — a hostile gateway cannot forge an IPNS record claiming an
 * attacker-chosen CID. The residual gap is "gateway lies about the
 * bytes at that CID"; mitigated by raw-codec verify (below) for
 * snapshots published via raw multicodec, and by IPNS pubkey
 * authentication for the (CID,sequence) → bytes contract. Future
 * work: implement full UnixFS verification per the deferred item.
 */
async function fetchFileFromIpfs(
  gateways: string[],
  cid: string,
  timeoutMs: number,
  maxSizeBytes: number = 1 * 1024 * 1024,
): Promise<Uint8Array> {
  let lastError: Error | null = null;

  // Steelman remediation: parse the CID locally so we know whether the
  // content is raw-encoded (sha256-verifiable) or UnixFS-wrapped (not
  // directly byte-verifiable). For raw-codec CIDs we enforce
  // content-address verify after fetch; for UnixFS-wrapped (legacy path)
  // we still fetch but log a one-time warning that bytes are not
  // content-address verified — the IPNS pubkey signature remains the
  // trust anchor.
  let parsedCid: CID;
  try {
    parsedCid = CID.parse(cid);
  } catch (err) {
    throw new ProfileError(
      'BUNDLE_NOT_FOUND',
      `Legacy snapshot CID is not parseable: ${cid}`,
      err,
    );
  }
  const isRawCodec = parsedCid.code === 0x55; // raw multicodec

  for (const gateway of gateways) {
    try {
      // Wave G.5: prefer the CAR-fetch path for ALL CIDs — works
      // for both raw-codec (single block) and dag-pb-wrapped UnixFS
      // files, and gives full content-address verification by
      // walking every block in the response. Falls back to the
      // legacy `/ipfs/<cid>` raw-bytes path on CAR-fetch failure
      // (gateway doesn't support `?format=car`, or returned
      // malformed CAR), preserving the IPNS-Ed25519 trust anchor
      // for older gateways.
      const carBytes = await tryFetchCarFromGateway(
        gateway,
        cid,
        timeoutMs,
        maxSizeBytes,
      );
      if (carBytes) {
        try {
          const reconstructed = await verifyCarAndExtractFile(carBytes, parsedCid);
          if (reconstructed.length > maxSizeBytes) {
            lastError = new Error(
              `Reconstructed file ${reconstructed.length} bytes exceeds cap ${maxSizeBytes} from ${gateway}`,
            );
            continue;
          }
          return reconstructed;
        } catch (err) {
          // CAR-walk verification failure is a hard signal — bytes
          // delivered by this gateway do NOT match the requested
          // CID. Try the next gateway rather than fall back to
          // the unverified raw path (which would defeat the gate).
          lastError = err instanceof Error ? err : new Error(String(err));
          continue;
        }
      }

      // Steelman² remediation: stream the body with a STREAMING cap.
      // Previous fix only checked Content-Length when present and
      // honestly declared; a gateway omitting CL or sending CL=0 then
      // streaming gigabytes bypassed that gate (response.arrayBuffer()
      // is unbounded). We now read chunk-by-chunk and abort the moment
      // the running total exceeds maxSizeBytes — closing the OOM
      // window for missing/lying CL entirely.
      const url = `${gateway.replace(/\/$/, '')}/ipfs/${cid}`;
      const response = await fetch(url, {
        headers: { Accept: 'application/octet-stream' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status} from ${gateway}`);
        continue;
      }
      // Defense-in-depth Content-Length pre-check (when honestly declared).
      const declaredLen = Number(response.headers.get('content-length') ?? '');
      if (Number.isFinite(declaredLen) && declaredLen > maxSizeBytes) {
        lastError = new Error(
          `Content-Length ${declaredLen} exceeds cap ${maxSizeBytes} from ${gateway}`,
        );
        continue;
      }
      // Streaming read with running cap.
      const bytes = await readStreamWithLimitLocal(response, maxSizeBytes, gateway);
      if (bytes === null) {
        // Steelman³ remediation: actually set lastError. Previous
        // version commented "recorded as lastError" but never assigned
        // it — final user-facing error was "...failed: unknown".
        // Now the cap-exceeded path produces a useful diagnostic.
        lastError = new Error(
          `Stream exceeded ${maxSizeBytes}-byte cap (or body unavailable) from ${gateway}`,
        );
        continue;
      }

      // Wave G.5 fallback: the CAR-fetch path didn't activate (gateway
      // doesn't support ?format=car). For raw-codec CIDs we can still
      // verify by direct hash. For dag-pb-wrapped UnixFS we cannot
      // verify the resolved bytes locally — the IPNS Ed25519 signature
      // remains the trust anchor for the (CID, sequence) tuple. We log
      // the unverified path so operators can flag gateways that don't
      // support CAR and either upgrade them or accept the residual.
      if (isRawCodec) {
        const computed = sha256(bytes);
        const expected = parsedCid.multihash.digest;
        if (computed.length !== expected.length) {
          lastError = new Error(`CID digest length mismatch from ${gateway}`);
          continue;
        }
        let match = true;
        for (let i = 0; i < computed.length; i++) {
          if (computed[i] !== expected[i]) { match = false; break; }
        }
        if (!match) {
          lastError = new Error(
            `Content-address verify FAILED from ${gateway}: sha256(bytes) does not match CID digest`,
          );
          continue;
        }
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          '[ipns-reader] Wave G.5: gateway',
          gateway,
          'did not support ?format=car for UnixFS-wrapped CID',
          cid,
          '— falling back to unverified bytes (IPNS signature still authenticates the CID).',
        );
      }
      return bytes;
    } catch (err) {
      if (err instanceof ProfileError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw new ProfileError(
    'BUNDLE_NOT_FOUND',
    `Legacy snapshot fetch failed on all gateways: ${lastError?.message ?? 'unknown'}`,
    lastError,
  );
}

/**
 * Read a Response body via a streaming reader, aborting the moment the
 * running total exceeds `maxBytes`. Returns the assembled Uint8Array
 * on success, or `null` if the cap was breached (caller falls through
 * to next gateway).
 *
 * Closure over `lastError` would leak across gateway iterations; we
 * use an outer reference passed via the `gateway` label for messages.
 *
 * Steelman² remediation: gateway-omitted Content-Length cannot OOM
 * the wallet — the stream is bounded by `maxBytes` regardless of
 * declared size.
 */
async function readStreamWithLimitLocal(
  response: Response,
  maxBytes: number,
  gateway: string,
): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    // Steelman³ remediation: refuse to fall back to the unbounded
    // arrayBuffer() path. The previous fallback first allocated the
    // full body THEN checked size — defeating the streaming-cap's
    // claim of "abort the moment running total exceeds cap." A
    // gateway that returns a non-streamable body is treated as an
    // error and the caller rotates to the next gateway.
    void gateway;
    return null;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* noop */ }
        return null;
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* noop */ }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Wave G.5: try to fetch the content as a CAR via `?format=car`.
 * Returns the CAR bytes on success, or `null` if the gateway
 * doesn't support CAR (caller falls back to the legacy
 * `/ipfs/<cid>` path). Also returns `null` on transport errors
 * — the caller tries the next gateway in either case.
 */
async function tryFetchCarFromGateway(
  gateway: string,
  cid: string,
  timeoutMs: number,
  maxSizeBytes: number,
): Promise<Uint8Array | null> {
  try {
    const url = `${gateway.replace(/\/$/, '')}/ipfs/${cid}?format=car`;
    const response = await fetch(url, {
      headers: { Accept: 'application/vnd.ipld.car' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    // Accept either an explicit CAR content-type or no content-type
    // (some gateways serve raw bytes with octet-stream). Reject
    // text/* and application/json so we don't mis-feed an HTML
    // error page to the CAR parser.
    const ct = response.headers.get('content-type') ?? '';
    if (ct && (ct.startsWith('text/') || ct.startsWith('application/json'))) {
      return null;
    }
    // CAR can be larger than the file (overhead + metadata blocks),
    // so allow up to 2× the file cap.
    const carCapBytes = maxSizeBytes * 2;
    const declaredLen = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declaredLen) && declaredLen > carCapBytes) return null;
    const carBytes = await readStreamWithLimitLocal(response, carCapBytes, gateway);
    return carBytes;
  } catch {
    return null;
  }
}

/**
 * Resolve the Profile's legacy IPNS name to a snapshot. Returns
 * `null` if the record doesn't exist yet (no legacy publish ever
 * happened) or if no gateway responded within the timeout.
 *
 * Signature verification: `IpfsHttpClient.resolveIpns` now verifies
 * the record's Ed25519 signature against the pubkey embedded in the
 * IPNS name (see `impl/shared/ipfs/ipns-record-manager.ts`). A
 * hostile gateway cannot return a forged record pointing to
 * attacker-chosen bytes.
 */
export async function resolveProfileSnapshot(params: {
  gateways: string[];
  privateKeyHex: string;
  resolveTimeoutMs?: number;
  fetchTimeoutMs?: number;
}): Promise<{ snapshot: ProfileSnapshot; cid: string; sequence: bigint } | null> {
  const { ipnsName } = await deriveProfileIpnsIdentity(params.privateKeyHex);

  const cache = new IpfsCache();
  const http = new IpfsHttpClient(
    {
      gateways: params.gateways,
      resolveTimeoutMs: params.resolveTimeoutMs ?? 20_000,
      fetchTimeoutMs: params.fetchTimeoutMs ?? 30_000,
    },
    cache,
  );

  const { best } = await http.resolveIpns(ipnsName);
  if (!best) return null;

  const bytes = await fetchFileFromIpfs(
    params.gateways,
    best.cid,
    params.fetchTimeoutMs ?? 30_000,
  );
  const snapshot = deserializeSnapshot(bytes);
  return { snapshot, cid: best.cid, sequence: best.sequence };
}

// =============================================================================
// Migration orchestrator
// =============================================================================

/**
 * Is this a legacy wallet that requires IPNS→pointer migration?
 *
 * Returns `true` iff BOTH:
 *   - `profile.ipns.sequence` is present (legacy publish ever happened)
 *   - `profile.pointer.migration.done` is NOT present
 *
 * A wallet that has never used IPNS (new install post-pointer) or
 * has already migrated returns `false`.
 */
export async function needsMigration(localCache: MigrationLocalCache): Promise<boolean> {
  const sequence = await localCache.get(LEGACY_IPNS_SEQUENCE_KEY);
  if (sequence === null) return false;
  const migrationDone = await localCache.get(MIGRATION_DONE_KEY);
  return migrationDone === null;
}

export interface RunMigrationParams {
  readonly localCache: MigrationLocalCache;
  readonly privateKeyHex: string;
  readonly gateways: string[];
  /**
   * Called with each active bundle ref discovered in the snapshot.
   * Caller writes the ref into OrbitDB via its own `addBundle` to
   * preserve encryption conventions. Failures on a single ref are
   * caught inside the orchestrator and logged — a partial migration
   * still records the marker so the next load does not re-run.
   */
  readonly onBundle: (cid: string, ref: UxfBundleRef) => Promise<void>;
  /**
   * Optional logger hook. Defaults to the shared `logger` namespace.
   */
  readonly log?: (message: string) => void;
  /**
   * Optional resolver override. Defaults to the real
   * `resolveProfileSnapshot` (which hits IPFS gateways). Tests pass
   * a fake so the orchestrator's control-flow can be exercised
   * without network I/O — and, critically, so future orchestrator
   * edits are caught by existing tests rather than silently
   * diverging from a copy-pasted shim.
   */
  readonly resolver?: (params: {
    gateways: string[];
    privateKeyHex: string;
  }) => Promise<{ snapshot: ProfileSnapshot; cid: string; sequence: bigint } | null>;
}

export interface MigrationResult {
  readonly migrated: boolean;
  readonly bundlesImported: number;
  readonly skipped?: 'not-legacy' | 'already-done' | 'no-record';
}

/**
 * One-shot migration. Safe to call on every wallet init — no-ops
 * unless `needsMigration` returns true. On success stamps
 * `MIGRATION_DONE_KEY` atomically after all bundle refs have been
 * processed (or attempted). On total failure (IPNS resolve fails,
 * no record) the marker is NOT set — next load retries.
 *
 * Partial-failure policy: per-bundle `onBundle` errors are logged
 * but the migration still stamps the marker to prevent infinite
 * retry on the same broken snapshot. The recovered bundle set is
 * authoritative only for what succeeded; the next pointer flush
 * will re-publish the union of whatever landed plus new state.
 */
export async function runIpnsToPointerMigration(
  params: RunMigrationParams,
): Promise<MigrationResult> {
  const log = params.log ?? ((msg: string) => logger.debug('IpnsMigration', msg));

  if (!(await needsMigration(params.localCache))) {
    const migrationDone = await params.localCache.get(MIGRATION_DONE_KEY);
    return {
      migrated: false,
      bundlesImported: 0,
      skipped: migrationDone !== null ? 'already-done' : 'not-legacy',
    };
  }

  const resolver = params.resolver ?? resolveProfileSnapshot;
  let resolved: Awaited<ReturnType<typeof resolveProfileSnapshot>>;
  try {
    resolved = await resolver({
      gateways: params.gateways,
      privateKeyHex: params.privateKeyHex,
    });
  } catch (err) {
    log(
      `legacy IPNS resolve failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Do NOT stamp the marker — the record may be temporarily
    // unreachable; next load retries. If the IPNS key was never
    // published (new install that happened to set ipns.sequence
    // somehow), resolveProfileSnapshot returns null and we hit the
    // no-record branch below.
    return { migrated: false, bundlesImported: 0 };
  }

  if (!resolved) {
    // `resolveProfileSnapshot` returns null for BOTH "no record on
    // network" and "every gateway was transiently unreachable" —
    // `IpfsHttpClient.resolveIpns` swallows per-gateway failures and
    // returns `{ best: null }` without signalling which case fired.
    //
    // We must NOT stamp MIGRATION_DONE_KEY here: a transient failure
    // during first cold-start would permanently disable migration
    // for that wallet, causing real data loss on the next load when
    // the gateways are reachable again. The cost of not stamping is
    // a cheap IPNS lookup on every load for the rare case of a
    // wallet that has a dangling `profile.ipns.sequence` local key
    // but no on-network record (a never-successful legacy publish).
    // That lookup is << a single pointer probe, and it self-resolves
    // once the wallet starts publishing via the pointer layer —
    // first successful pointer publish can optionally stamp the
    // migration marker, but is not required.
    log('legacy IPNS resolve returned null — retrying on next load');
    return { migrated: false, bundlesImported: 0, skipped: 'no-record' };
  }

  log(
    `legacy snapshot resolved: cid=${resolved.cid} seq=${resolved.sequence} ` +
      `bundles=${resolved.snapshot.bundles.length}`,
  );

  let imported = 0;
  let skippedMalformed = 0;
  for (const b of resolved.snapshot.bundles) {
    if (b.status !== 'active') continue;

    // Validate the CID string before handing it to onBundle. The
    // snapshot body is fetched via `/ipfs/<cid>` which does NOT
    // content-address verify (UnixFS-wrapped payload), so a hostile
    // gateway that MITMs the snapshot fetch — even though the IPNS
    // record itself is signature-verified — could inject arbitrary
    // strings into `bundles[].cid`. Unparseable CIDs would poison
    // downstream consumers (`listActiveBundles` deserializes and
    // iterates keys by prefix). Reject non-CID strings here.
    if (typeof b.cid !== 'string' || b.cid.length === 0) {
      skippedMalformed++;
      log(`migration: dropping bundle with empty/non-string cid`);
      continue;
    }
    try {
      CID.parse(b.cid);
    } catch {
      skippedMalformed++;
      log(`migration: dropping bundle with malformed cid=${b.cid.slice(0, 40)}…`);
      continue;
    }

    try {
      await params.onBundle(b.cid, {
        cid: b.cid,
        status: 'active',
        createdAt: b.createdAt,
        // tokenCount unknown — refreshed on next flush.
      });
      imported++;
    } catch (err) {
      log(
        `migration: addBundle(${b.cid}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  await params.localCache.set(MIGRATION_DONE_KEY, String(Date.now()));
  log(
    `migration complete: ${imported}/${resolved.snapshot.bundles.length} bundles imported` +
      (skippedMalformed > 0 ? ` (${skippedMalformed} malformed dropped)` : ''),
  );
  return { migrated: true, bundlesImported: imported };
}
