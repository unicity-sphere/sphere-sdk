/**
 * OrbitDB Wrapper/Adapter for the UXF Profile system.
 *
 * Provides a typed, promise-based API around `@orbitdb/core` for the Profile's
 * key-value database. The rest of the Profile system never imports `@orbitdb/core`
 * directly -- all OrbitDB interaction flows through this adapter.
 *
 * `@orbitdb/core` is loaded via dynamic `import()` in `connect()`. If the package
 * is not installed, a `ProfileError` with code `ORBITDB_NOT_INSTALLED` is thrown.
 *
 * @module profile/orbitdb-adapter
 */

import { ProfileError } from './errors.js';
import type { OrbitDbConfig, ProfileDatabase } from './types.js';

// Re-export types so existing consumers that import from this module still work
export type { OrbitDbConfig, ProfileDatabase };
export { ProfileError };

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Concrete `ProfileDatabase` backed by `@orbitdb/core`.
 *
 * All OrbitDB / Helia / libp2p instances are created inside `connect()` via
 * dynamic `import()`, so the rest of the SDK tree-shakes cleanly when OrbitDB
 * is not used.
 */
export class OrbitDbAdapter implements ProfileDatabase {
  // ---- private fields (typed as `any` because @orbitdb/core may not be installed) ----
  /** The Helia IPFS node. */
  private helia: any = null;
  /** The OrbitDB instance. */
  private orbitdb: any = null;
  /** The opened `keyvalue` database handle. */
  private db: any = null;
  /** Tracks connection state. */
  private connected = false;
  /** Registered replication listeners for cleanup. */
  private replicationListeners: Set<() => void> = new Set();

  // ---------- ProfileDatabase implementation ----------

  async connect(config: OrbitDbConfig): Promise<void> {
    if (this.connected) {
      return; // idempotent
    }

    // --- Dynamic import of @orbitdb/core ---
    let orbitdbModule: any;
    try {
      orbitdbModule = await import('@orbitdb/core' as string);
    } catch {
      throw new ProfileError(
        'ORBITDB_NOT_INSTALLED',
        '@orbitdb/core is not installed. Install it with: npm install @orbitdb/core',
      );
    }

    // --- Dynamic import of Helia ---
    let heliaModule: any;
    try {
      heliaModule = await import('helia' as string);
    } catch {
      throw new ProfileError(
        'ORBITDB_NOT_INSTALLED',
        'helia is not installed. Install it with: npm install helia',
      );
    }

    try {
      // 1. Create Helia IPFS node
      const createHelia = heliaModule.createHelia ?? heliaModule.default?.createHelia;
      if (typeof createHelia !== 'function') {
        throw new Error('Could not resolve createHelia from helia module');
      }

      const heliaOptions: Record<string, unknown> = {};
      if (config.directory) {
        heliaOptions.directory = config.directory;
      }

      this.helia = await createHelia(heliaOptions);

      // 2. Create OrbitDB instance
      const createOrbitDB =
        orbitdbModule.createOrbitDB ?? orbitdbModule.default?.createOrbitDB;
      if (typeof createOrbitDB !== 'function') {
        throw new Error('Could not resolve createOrbitDB from @orbitdb/core');
      }

      const orbitDbOptions: Record<string, unknown> = {
        ipfs: this.helia,
      };
      if (config.directory) {
        orbitDbOptions.directory = config.directory;
      }

      this.orbitdb = await createOrbitDB(orbitDbOptions);

      // 3. Derive deterministic database name from wallet pubkey
      //    Section 4.1: sphere-profile-<first 16 hex chars of pubkey>
      const publicKeyShort = await derivePublicKeyShort(config.privateKey);
      const dbName = `sphere-profile-${publicKeyShort}`;

      // 4. Open (or create) the keyvalue database with access control
      //    Only the wallet identity can write.
      const OrbitDBAccessController =
        orbitdbModule.OrbitDBAccessController ??
        orbitdbModule.default?.OrbitDBAccessController;

      const openOptions: Record<string, unknown> = {
        type: 'keyvalue',
      };

      // Apply access controller if available
      if (OrbitDBAccessController) {
        openOptions.AccessController = OrbitDBAccessController({
          write: [this.orbitdb.identity.id],
        });
      }

      this.db = await this.orbitdb.open(dbName, openOptions);

      this.connected = true;
    } catch (err) {
      // Clean up partial state on failure
      await this.cleanupOnError();

      if (err instanceof ProfileError) {
        throw err;
      }
      throw new ProfileError(
        'ORBITDB_CONNECTION_FAILED',
        `Failed to connect to OrbitDB: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.ensureConnected();
    try {
      await this.db.put(key, value);
    } catch (err) {
      throw new ProfileError(
        'ORBITDB_WRITE_FAILED',
        `Failed to write key "${key}": ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    this.ensureConnected();
    try {
      const value = await this.db.get(key);
      if (value === undefined || value === null) {
        return null;
      }
      // Ensure we return a Uint8Array even if OrbitDB returns a different type
      if (value instanceof Uint8Array) {
        return value;
      }
      // OrbitDB may store/return values through IPLD serialization which can
      // produce a plain object with numeric keys. Coerce gracefully.
      if (typeof value === 'object' && value !== null) {
        return new Uint8Array(Object.values(value) as number[]);
      }
      return null;
    } catch (err) {
      throw new ProfileError(
        'ORBITDB_READ_FAILED',
        `Failed to read key "${key}": ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  async del(key: string): Promise<void> {
    this.ensureConnected();
    try {
      await this.db.del(key);
    } catch (err) {
      throw new ProfileError(
        'ORBITDB_WRITE_FAILED',
        `Failed to delete key "${key}": ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  async all(prefix?: string): Promise<Map<string, Uint8Array>> {
    this.ensureConnected();
    try {
      const result = new Map<string, Uint8Array>();
      // OrbitDB keyvalue databases expose an `all()` method that returns
      // all entries as an object or iterable.
      const allEntries = await this.db.all();

      // allEntries may be an object, a Map, or an async iterable depending
      // on the OrbitDB version. Handle each case.
      if (allEntries && typeof allEntries[Symbol.asyncIterator] === 'function') {
        for await (const entry of allEntries) {
          const entryKey: string = entry.key ?? entry[0];
          const entryValue = entry.value ?? entry[1];
          if (prefix && !entryKey.startsWith(prefix)) {
            continue;
          }
          result.set(entryKey, coerceToUint8Array(entryValue));
        }
      } else if (allEntries instanceof Map) {
        for (const [entryKey, entryValue] of allEntries) {
          if (prefix && !entryKey.startsWith(prefix)) {
            continue;
          }
          result.set(entryKey, coerceToUint8Array(entryValue));
        }
      } else if (typeof allEntries === 'object' && allEntries !== null) {
        for (const [entryKey, entryValue] of Object.entries(allEntries)) {
          if (prefix && !entryKey.startsWith(prefix)) {
            continue;
          }
          result.set(entryKey, coerceToUint8Array(entryValue as Uint8Array | Record<string, number>));
        }
      }

      return result;
    } catch (err) {
      throw new ProfileError(
        'ORBITDB_READ_FAILED',
        `Failed to read all entries${prefix ? ` with prefix "${prefix}"` : ''}: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  async close(): Promise<void> {
    if (!this.connected) {
      return; // idempotent
    }

    // Unsubscribe all replication listeners before closing the database
    if (this.db?.events?.off) {
      for (const handler of this.replicationListeners) {
        try {
          this.db.events.off('update', handler);
        } catch {
          // best-effort cleanup
        }
      }
    }
    this.replicationListeners.clear();

    try {
      if (this.db) {
        await this.db.close();
        this.db = null;
      }
    } catch {
      // Best-effort close -- log but do not throw
    }

    try {
      if (this.orbitdb) {
        await this.orbitdb.stop();
        this.orbitdb = null;
      }
    } catch {
      // Best-effort close
    }

    try {
      if (this.helia) {
        await this.helia.stop();
        this.helia = null;
      }
    } catch {
      // Best-effort close
    }

    this.connected = false;
  }

  onReplication(callback: () => void): () => void {
    this.ensureConnected();

    // OrbitDB databases emit 'update' events when remote entries are merged.
    const handler = () => {
      callback();
    };

    this.db.events.on('update', handler);
    this.replicationListeners.add(handler);

    // Return unsubscribe function
    return () => {
      this.db?.events?.off?.('update', handler);
      this.replicationListeners.delete(handler);
    };
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ---------- Private helpers ----------

  /**
   * Throws `ProfileError` if the adapter is not connected.
   */
  private ensureConnected(): void {
    if (!this.connected || !this.db) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        'OrbitDB adapter is not connected. Call connect() first.',
      );
    }
  }

  /**
   * Clean up partially initialized state after a failed `connect()`.
   */
  private async cleanupOnError(): Promise<void> {
    try {
      if (this.db) {
        await this.db.close();
      }
    } catch {
      // ignore
    }
    try {
      if (this.orbitdb) {
        await this.orbitdb.stop();
      }
    } catch {
      // ignore
    }
    try {
      if (this.helia) {
        await this.helia.stop();
      }
    } catch {
      // ignore
    }
    this.db = null;
    this.orbitdb = null;
    this.helia = null;
    this.connected = false;
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Derive the first 16 hex characters of the compressed public key from a
 * private key hex string. Used to build the deterministic database name:
 * `sphere-profile-<publicKeyShort>`.
 *
 * Uses `@noble/curves/secp256k1` (a mandatory sphere-sdk dependency) to
 * derive the compressed public key. Falls back to SHA-256 hashing of the
 * private key via `@noble/hashes` if curves is unavailable for any reason.
 * Both packages are required sphere-sdk dependencies -- if neither is
 * present the function throws rather than leaking private key material.
 */
async function derivePublicKeyShort(privateKeyHex: string): Promise<string> {
  // Primary: derive the actual compressed public key via @noble/curves
  try {
    // Dynamic import with type suppression -- @noble/curves is a mandatory
    // sphere-sdk dependency but may not have type declarations in this context
    const secp256k1Module: any = await import('@noble/curves/secp256k1' as string);
    const pubKeyBytes: Uint8Array = secp256k1Module.secp256k1.getPublicKey(privateKeyHex, true);
    return bytesToHex(pubKeyBytes).slice(0, 16);
  } catch {
    // Fallback: use SHA-256 hash of private key to avoid leaking raw key material
  }

  try {
    const hashModule: any = await import('@noble/hashes/sha256' as string);
    const hash: Uint8Array = hashModule.sha256(hexToBytes(privateKeyHex));
    return bytesToHex(hash).slice(0, 16);
  } catch {
    // Both mandatory dependencies are missing
  }

  throw new ProfileError(
    'ORBITDB_CONNECTION_FAILED',
    'Cannot derive public key: @noble/curves and @noble/hashes are required',
  );
}

/**
 * Convert a Uint8Array to a lowercase hex string.
 */
function bytesToHex(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    hex.push(bytes[i].toString(16).padStart(2, '0'));
  }
  return hex.join('');
}

/**
 * Convert a hex string to Uint8Array.
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Coerce a value returned by OrbitDB into a Uint8Array.
 * OrbitDB's IPLD serialization may return plain objects with numeric keys
 * instead of raw Uint8Array instances.
 */
function coerceToUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (typeof value === 'object' && value !== null) {
    return new Uint8Array(Object.values(value as Record<string, number>));
  }
  // If the value is something unexpected, return an empty array.
  return new Uint8Array(0);
}
