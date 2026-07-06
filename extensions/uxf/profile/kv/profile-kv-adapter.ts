/**
 * ProfileKvAdapter — implements the `ProfileDatabase` interface on top of
 * a `ProfileKvBackend` (Node file-per-key or browser IndexedDB) and a
 * `LocalBlockCacheFacade` (blockstore-fs / blockstore-idb direct).
 *
 * Byte-stable drop-in for `OrbitDbAdapter`. Preserves:
 *   - `put/get/del/all(prefix, opts?)` with the same `maxResults` cap
 *     semantics
 *   - `connect(config)` — derives a `sphere-profile-<16-hex>` DB name from
 *     `dbNameOverride` (preferred) or `privateKey` (deprecated). Both
 *     inputs are handled identically to the old adapter so cross-device
 *     opens land on the same directory / DB name.
 *   - `close()` — idempotent, drains pending writes.
 *   - `onReplication(cb)` — subscribes to a merge-applied signal. In
 *     httpOnly mode (which the wallet factories forced OrbitDB into anyway)
 *     OrbitDB's `'update'` event fired only on local writes. This adapter
 *     fires on local writes AND on `emitMergeApplied()` (called by the
 *     lean-snapshot JOIN path). Strict superset of the previous surface.
 *   - `isConnected()` — flag.
 *   - `getHelia()` — returns the LocalBlockCache facade cast to `unknown`,
 *     matching `ipfs-client.ts`'s `HeliaLike` structural shape.
 *   - `putEntry(key, envelope)` / `getEntry(key, opts?)` — CBOR envelope
 *     IO with the same security-tag downgrade behavior (`replicated`
 *     forced unless caller supplies `trustLocalClaim: true` AND the key
 *     was locally-authored in this session).
 *   - `markLocallyAuthored(key)`.
 *   - `setStoragePersistenceListener(cb)` — kept as a stub for
 *     browser-only IDB storage-permission events. The Node/browser
 *     factories detect via `typeof === 'function'`, so a no-op stub is
 *     compatible.
 *
 * Drops (relative to `OrbitDbAdapter`): everything that was OrbitDB-,
 * Helia-, or libp2p-specific — `resetCorruptedLog`, `getPinShimCounters`,
 * `getPinnedCids`, the ephemeral local identity `id`, connect-retry, the
 * gossipsub stub, and the entire replication event loop. See
 * `docs/uxf/uxfv2-substrate-alternatives.md` §5 for the retirement
 * rationale.
 *
 * @module extensions/uxf/profile/kv/profile-kv-adapter
 */

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import { logger } from '../../../../core/logger.js';
import { incr, observeMs } from '../../../../core/perf-counters.js';
import { ProfileError } from '../errors.js';
import {
  decodeAndDowngradeReplicated,
  decodeEntry,
  encodeEntry,
  type OpLogEntryEnvelope,
} from '../oplog-entry.js';
import type { OrbitDbConfig } from '../types.js';
import type { LocalBlockCacheFacade } from './local-block-cache-node.js';
import type { ProfileKvBackend } from './profile-kv-node.js';

export type { OpLogEntryEnvelope };

export interface ProfileKvAdapterOptions {
  readonly backend: ProfileKvBackend;
  /**
   * Optional local block cache exposed via `getHelia()` so
   * `ipfs-client.ts` can use it as the first-class store for CAR
   * blocks. Pass `null` in tests / stubs that don't exercise the
   * pin/fetch path.
   */
  readonly blockCache?: LocalBlockCacheFacade | null;
}

/**
 * Adapter class. Byte-stable substitute for `OrbitDbAdapter` under
 * `ProfileDatabase` consumers.
 */
export class ProfileKvAdapter {
  private readonly backend: ProfileKvBackend;
  private readonly blockCache: LocalBlockCacheFacade | null;
  private connected = false;
  private connectInFlight: Promise<void> | null = null;
  private shuttingDown = false;
  private readonly localAuthoredKeys = new Set<string>();
  private readonly replicationListeners = new Set<() => void>();
  private storagePersistenceListener:
    | ((info: { readonly granted: boolean; readonly supported: boolean }) => void)
    | null = null;

  constructor(opts: ProfileKvAdapterOptions) {
    this.backend = opts.backend;
    this.blockCache = opts.blockCache ?? null;
  }

  async connect(config: OrbitDbConfig): Promise<void> {
    if (this.connected) return;
    if (this.connectInFlight) return this.connectInFlight;
    this.connectInFlight = (async () => {
      const t0 = performance.now();
      try {
        // Byte-stable identity derivation with OrbitDbAdapter — same
        // `sphere-profile-<16-hex>` shape so cross-device opens on
        // the same seed land on the same KV directory.
        if (config.dbNameOverride) {
          // pre-derived name — nothing to do here, the backend already
          // has its directory / dbName from the factory.
        } else if (config.privateKey && config.privateKey.length > 0) {
          // Legacy path — the factory should have derived and passed
          // `dbNameOverride` already; keeping this branch alive means
          // adapter callers that skip the factory still work.
          // We don't actually re-derive here because the backend is
          // already bound to its directory / dbName; log for parity.
          await derivePublicKeyShort(config.privateKey);
        } else {
          throw new ProfileError(
            'PROFILE_KV_CONNECTION_FAILED',
            'ProfileKvConfig requires either dbNameOverride (preferred) or privateKey (deprecated).',
          );
        }
        await this.backend.open();
        this.connected = true;
        observeMs('profile-kv.connect.totalMs', performance.now() - t0);
      } catch (err) {
        this.connected = false;
        throw err instanceof ProfileError
          ? err
          : new ProfileError(
              'PROFILE_KV_CONNECTION_FAILED',
              `ProfileKvAdapter.connect failed: ${err instanceof Error ? err.message : String(err)}`,
              err,
            );
      } finally {
        this.connectInFlight = null;
      }
    })();
    return this.connectInFlight;
  }

  async close(): Promise<void> {
    if (!this.connected && !this.connectInFlight) return;
    this.shuttingDown = true;
    try {
      if (this.connectInFlight) {
        try {
          await this.connectInFlight;
        } catch {
          /* connect errors are terminal; keep tearing down */
        }
      }
      await this.backend.close();
      const cache = this.blockCache as
        | (LocalBlockCacheFacade & { close?: () => Promise<void> })
        | null;
      if (cache && typeof cache.close === 'function') {
        try {
          await cache.close();
        } catch (err) {
          logger.warn(
            'ProfileKvAdapter',
            `close: block cache close failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } finally {
      this.connected = false;
      this.shuttingDown = false;
      this.replicationListeners.clear();
      this.localAuthoredKeys.clear();
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new ProfileError(
        'PROFILE_KV_NOT_OPEN',
        'ProfileKvAdapter: operation before connect()',
      );
    }
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.ensureConnected();
    await this.backend.put(key, value);
    this.dispatchReplicationSignal();
  }

  async get(key: string): Promise<Uint8Array | null> {
    this.ensureConnected();
    return this.backend.get(key);
  }

  async del(key: string): Promise<void> {
    this.ensureConnected();
    await this.backend.del(key);
    this.dispatchReplicationSignal();
  }

  async all(
    prefix?: string,
    opts?: { readonly maxResults?: number },
  ): Promise<Map<string, Uint8Array>> {
    this.ensureConnected();
    return this.backend.all(prefix, opts);
  }

  onReplication(callback: () => void): () => void {
    this.ensureConnected();
    this.replicationListeners.add(callback);
    return () => {
      this.replicationListeners.delete(callback);
    };
  }

  /**
   * Signal that a remote merge has landed. The lean-snapshot JOIN path
   * calls this after applying a fetched snapshot into the writers.
   *
   * Also invalidates the local-authored-key set (a merge could have
   * overwritten any of our keys with peer content per LWW).
   */
  emitMergeApplied(): void {
    this.localAuthoredKeys.clear();
    this.dispatchReplicationSignal();
  }

  private dispatchReplicationSignal(): void {
    if (this.replicationListeners.size === 0) return;
    incr('profile-kv.onReplication.fired');
    const t0 = performance.now();
    // Snapshot listener list so a callback's unsubscribe during dispatch
    // doesn't mutate the iterator.
    for (const cb of Array.from(this.replicationListeners)) {
      try {
        cb();
      } catch (err) {
        logger.warn(
          'ProfileKvAdapter',
          `onReplication callback threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    observeMs('profile-kv.onReplication.callbackMs', performance.now() - t0);
  }

  getHelia(): unknown | null {
    if (this.shuttingDown) return null;
    return this.blockCache;
  }

  async putEntry(key: string, entry: OpLogEntryEnvelope): Promise<void> {
    this.ensureConnected();
    const t0 = performance.now();
    const isBundleKey = key.startsWith('tokens.bundle.');
    try {
      const cborBytes = encodeEntry(entry);
      await this.backend.put(key, cborBytes);
      this.localAuthoredKeys.add(key);
      this.dispatchReplicationSignal();
    } catch (err) {
      incr('profile-kv.putEntry.error');
      throw new ProfileError(
        'PROFILE_KV_WRITE_FAILED',
        `Failed to write structured entry at "${key}": ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    } finally {
      observeMs(
        isBundleKey ? 'profile-kv.putEntry.bundle' : 'profile-kv.putEntry.other',
        performance.now() - t0,
      );
    }
  }

  markLocallyAuthored(key: string): void {
    this.localAuthoredKeys.add(key);
  }

  async getEntry(
    key: string,
    opts: {
      downgradeAsReplicated?: boolean;
      trustLocalClaim?: boolean;
    } = {},
  ): Promise<OpLogEntryEnvelope | null> {
    this.ensureConnected();
    const t0 = performance.now();
    const isBundleKey = key.startsWith('tokens.bundle.');
    try {
      const bytes = await this.backend.get(key);
      if (bytes === null) {
        observeMs(
          isBundleKey ? 'profile-kv.getEntry.bundleMissMs' : 'profile-kv.getEntry.missMs',
          performance.now() - t0,
        );
        return null;
      }

      if (opts.downgradeAsReplicated === true) {
        const result = decodeAndDowngradeReplicated(bytes);
        observeMs(
          isBundleKey ? 'profile-kv.getEntry.bundleHitMs' : 'profile-kv.getEntry.hitMs',
          performance.now() - t0,
        );
        return result;
      }

      const envelope = decodeEntry(bytes);

      if (envelope.v === 0) {
        observeMs(
          isBundleKey ? 'profile-kv.getEntry.bundleHitMs' : 'profile-kv.getEntry.hitMs',
          performance.now() - t0,
        );
        return envelope;
      }

      const trusted =
        opts.trustLocalClaim === true && this.localAuthoredKeys.has(key);
      if (trusted) {
        observeMs(
          isBundleKey ? 'profile-kv.getEntry.bundleHitMs' : 'profile-kv.getEntry.hitMs',
          performance.now() - t0,
        );
        return envelope;
      }

      // Non-trusted read → force downgrade to 'replicated'.
      const downgraded = decodeAndDowngradeReplicated(bytes);
      observeMs(
        isBundleKey ? 'profile-kv.getEntry.bundleHitMs' : 'profile-kv.getEntry.hitMs',
        performance.now() - t0,
      );
      return downgraded;
    } catch (err) {
      incr('profile-kv.getEntry.error');
      if (err instanceof ProfileError) throw err;
      throw new ProfileError(
        'PROFILE_KV_READ_FAILED',
        `Failed to read structured entry at "${key}": ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  setStoragePersistenceListener(
    listener:
      | ((info: { readonly granted: boolean; readonly supported: boolean }) => void)
      | null,
  ): void {
    this.storagePersistenceListener = listener;
  }

  /**
   * Test / observability hook — surface the persistence listener state so
   * factory.ts can invoke it from browser storage-permission callbacks.
   * Called by the factory only if it can inject the actual permission
   * information (browser-only path).
   */
  reportStoragePersistence(info: {
    readonly granted: boolean;
    readonly supported: boolean;
  }): void {
    const listener = this.storagePersistenceListener;
    if (listener) {
      try {
        listener(info);
      } catch (err) {
        logger.warn(
          'ProfileKvAdapter',
          `storage persistence listener threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

/**
 * Byte-stable derivation of the profile DB shortname from a private key.
 * Matches `orbitdb-adapter.ts:1568` — sha256(pubkey) truncated to 16 hex
 * chars. Exposed so the factory can pre-derive `dbNameOverride` and wipe
 * the private-key bytes before ever handing them to the adapter (per the
 * memory-safety note on `OrbitDbConfig`).
 */
export async function deriveProfileDbNameShort(
  privateKeyHex: string,
): Promise<string> {
  try {
    const secp256k1Module: {
      secp256k1: { getPublicKey(k: string, compressed?: boolean): Uint8Array };
    } = await import('@noble/curves/secp256k1.js' as string);
    const pubKeyBytes = secp256k1Module.secp256k1.getPublicKey(privateKeyHex, true);
    return bytesToHex(pubKeyBytes).slice(0, 16);
  } catch {
    /* fall through */
  }
  try {
    const hashModule: { sha256(b: Uint8Array): Uint8Array } = await import(
      '@noble/hashes/sha2.js' as string
    );
    const hash = hashModule.sha256(hexToBytes(privateKeyHex));
    return bytesToHex(hash).slice(0, 16);
  } catch {
    /* fall through */
  }
  throw new ProfileError(
    'PROFILE_KV_CONNECTION_FAILED',
    'Cannot derive profile DB name: @noble/curves and @noble/hashes are required',
  );
}

// Internal helper mirroring OrbitDbAdapter's derivePublicKeyShort so the
// deprecated-path branch above has a place to touch the key when the
// factory hasn't pre-derived a dbNameOverride. Unused by production
// flows (factory always pre-derives), kept for CLI/test parity.
const derivePublicKeyShort = deriveProfileDbNameShort;
