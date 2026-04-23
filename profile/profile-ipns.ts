/**
 * Profile IPNS Snapshot
 *
 * Publishes a lightweight snapshot of the Profile's active bundle refs
 * to IPNS, keyed by a wallet-derived Ed25519 identity. This bridges a
 * gap in OrbitDB-based replication: without a live peer sharing the
 * database, a freshly-wiped device has no way to discover the current
 * set of active CAR bundles. Publishing a self-contained snapshot to
 * IPNS restores single-device recovery parity with the legacy IPNS
 * flow (`IpfsStorageProvider`).
 *
 * Design notes:
 *
 * - The IPNS key is derived from the wallet's secp256k1 private key
 *   via HKDF with a DISTINCT info string (`'uxf-profile-ed25519-v1'`)
 *   from the legacy IPFS IPNS name, so the two channels can coexist
 *   without collision.
 * - The snapshot is plain JSON (UTF-8), pinned as raw bytes to the
 *   configured IPFS gateways. Content-addressed dedup applies — two
 *   identical snapshots (same bundle set) produce the same CID.
 * - OrbitDB remains the primary store during normal operation. The
 *   IPNS snapshot is a STAPLE for cold-start recovery and a consistent
 *   view for peers that haven't yet replicated the live OpLog.
 * - This module is intentionally SDK-agnostic and synchronous-signed
 *   (no token references). The follow-up PR replaces this plain-IPNS
 *   channel with a token-backed pointer anchored to the Unicity
 *   aggregator as the single source of truth.
 *
 * @module profile/profile-ipns
 */

import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { IpfsCache } from '../impl/shared/ipfs/ipfs-cache.js';
import { IpfsHttpClient } from '../impl/shared/ipfs/ipfs-http-client.js';
import { createSignedRecord } from '../impl/shared/ipfs/ipns-record-manager.js';
import { hexToBytes } from '../core/crypto.js';
import { ProfileError } from './errors.js';
import { logger } from '../core/logger.js';

// =============================================================================
// Constants
// =============================================================================

/**
 * HKDF info string for deriving the Profile's Ed25519 IPNS key from
 * the wallet's secp256k1 private key. MUST be different from the
 * legacy `ipfs-storage-ed25519-v1` info so Profile and legacy IPNS
 * names don't collide on the same wallet.
 */
export const PROFILE_IPNS_HKDF_INFO = 'uxf-profile-ed25519-v1';

/** Current snapshot schema version. */
const SNAPSHOT_VERSION = 1 as const;

/** Local-storage key for the monotonic IPNS sequence number. */
const SEQUENCE_STORAGE_KEY = 'profile.ipns.sequence';

// =============================================================================
// Types
// =============================================================================

/**
 * Minimal reference for a single CAR bundle. Mirrors the `UxfBundleRef`
 * shape in `profile/types.ts` but keeps only what recovery needs.
 */
export interface SnapshotBundleRef {
  readonly cid: string;
  readonly status: 'active' | 'superseded';
  readonly createdAt: number;
}

/**
 * A snapshot of the Profile's active bundle set at a point in time.
 * JSON-serializable; pinned to IPFS as raw UTF-8 bytes.
 */
export interface ProfileSnapshot {
  readonly version: typeof SNAPSHOT_VERSION;
  readonly walletPubkey: string;
  readonly timestamp: number;
  readonly bundles: ReadonlyArray<SnapshotBundleRef>;
}

// =============================================================================
// Key derivation
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
 * secp256k1 private key.
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
// Snapshot serialization
// =============================================================================

export function serializeSnapshot(snapshot: ProfileSnapshot): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(snapshot));
}

export function deserializeSnapshot(bytes: Uint8Array): ProfileSnapshot {
  const text = new TextDecoder().decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ProfileError(
      'BUNDLE_NOT_FOUND',
      `Failed to parse Profile IPNS snapshot: ${err instanceof Error ? err.message : String(err)}`,
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
      `Profile IPNS snapshot has unexpected shape`,
    );
  }
  return parsed as ProfileSnapshot;
}

// =============================================================================
// Publish
// =============================================================================

/**
 * Pin the snapshot to IPFS and publish an IPNS record pointing to it.
 *
 * Errors are caught and logged — a failed IPNS publish does NOT
 * cause `flushToIpfs()` to fail. The CAR bundle is already pinned
 * and recorded in OrbitDB; IPNS is a recovery assist, not a
 * correctness boundary.
 */
export async function publishProfileSnapshot(params: {
  gateways: string[];
  privateKeyHex: string;
  snapshot: ProfileSnapshot;
  sequence: bigint;
  publishTimeoutMs?: number;
}): Promise<{ success: boolean; ipnsName?: string; cid?: string; error?: string }> {
  try {
    const { keyPair, ipnsName } = await deriveProfileIpnsIdentity(params.privateKeyHex);

    const cache = new IpfsCache();
    const http = new IpfsHttpClient(
      {
        gateways: params.gateways,
        publishTimeoutMs: params.publishTimeoutMs ?? 60_000,
      },
      cache,
    );

    // 1. Upload the snapshot JSON via `/api/v0/add`. The Unicity
    //    gateway whitelist doesn't expose `/api/v0/block/put`
    //    (which would produce a raw sha256 CID), so UnixFS wrapping
    //    is unavoidable. Authenticity of the retrieved snapshot is
    //    enforced at the IPNS layer — the record is signed by the
    //    wallet-derived Ed25519 key, so a gateway cannot forge a
    //    valid record pointing to attacker-chosen bytes.
    const { cid } = await http.upload(params.snapshot);

    // 2. Sign an IPNS record pointing to the snapshot CID.
    const marshalled = await createSignedRecord(keyPair, cid, params.sequence);

    // 3. Publish via the same gateways.
    const result = await http.publishIpns(ipnsName, marshalled);

    if (!result.success) {
      return {
        success: false,
        ipnsName,
        cid,
        error: result.error ?? 'IPNS publish failed',
      };
    }
    return { success: true, ipnsName, cid };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('ProfileIPNS', `Publish snapshot failed: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Fetch a file from IPFS by CID via the gateway path `/ipfs/<cid>`.
 *
 * Unlike {@link fetchFromIpfs} this does NOT perform
 * content-address verification (sha256 over bytes == CID hash),
 * because the snapshot was pinned via `/api/v0/add` which wraps the
 * payload in UnixFS — the CID does not hash directly to the file
 * bytes. Authenticity is instead anchored at the IPNS record: only
 * the wallet-derived key can publish a valid pointer.
 */
async function fetchFileFromIpfs(
  gateways: string[],
  cid: string,
  timeoutMs: number,
  maxSizeBytes: number = 1 * 1024 * 1024, // 1 MB cap for snapshot
): Promise<Uint8Array> {
  let lastError: Error | null = null;
  for (const gateway of gateways) {
    try {
      const url = `${gateway.replace(/\/$/, '')}/ipfs/${cid}`;
      const response = await fetch(url, {
        headers: { Accept: 'application/octet-stream' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status} from ${gateway}`);
        continue;
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > maxSizeBytes) {
        throw new ProfileError(
          'BUNDLE_NOT_FOUND',
          `Snapshot ${buffer.byteLength} bytes exceeds limit ${maxSizeBytes} from ${gateway}`,
        );
      }
      return new Uint8Array(buffer);
    } catch (err) {
      if (err instanceof ProfileError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw new ProfileError(
    'BUNDLE_NOT_FOUND',
    `Snapshot fetch failed on all gateways: ${lastError?.message ?? 'unknown'}`,
    lastError,
  );
}

// =============================================================================
// Resolve
// =============================================================================

/**
 * Resolve the Profile's IPNS name to a snapshot. Returns `null` if the
 * record doesn't exist yet (first-ever publish hasn't happened) or if
 * no gateway responded successfully within the timeout.
 *
 * The snapshot is deserialized eagerly — a malformed record throws
 * {@link ProfileError}.
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
// Sequence number persistence (local cache)
// =============================================================================

/**
 * Read the last-published sequence number for this wallet from the
 * local storage provider. Returns `0n` if nothing has ever been
 * published (first-ever publish will use `1n`).
 */
export async function readSequence(
  cache: { get(key: string): Promise<string | null> },
): Promise<bigint> {
  const raw = await cache.get(SEQUENCE_STORAGE_KEY);
  if (!raw) return 0n;
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
}

/**
 * Persist a new sequence number to local storage. Intended to be
 * called immediately after a successful `publishProfileSnapshot`.
 */
export async function writeSequence(
  cache: { set(key: string, value: string): Promise<void> },
  sequence: bigint,
): Promise<void> {
  await cache.set(SEQUENCE_STORAGE_KEY, sequence.toString());
}
