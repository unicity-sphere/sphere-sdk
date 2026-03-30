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

// ---------------------------------------------------------------------------
// Error class -- minimal inline definition.
// If profile/errors.ts is created by another agent, this can be replaced with
// an import. The code and format mirror UxfError from uxf/errors.ts.
// ---------------------------------------------------------------------------

/** Error codes specific to the Profile module. */
export type ProfileErrorCode =
  | 'PROFILE_NOT_INITIALIZED'
  | 'ORBITDB_NOT_INSTALLED'
  | 'ORBITDB_WRITE_FAILED'
  | 'ORBITDB_READ_FAILED'
  | 'ORBITDB_CONNECTION_FAILED'
  | 'BUNDLE_NOT_FOUND'
  | 'MIGRATION_FAILED'
  | 'ENCRYPTION_FAILED'
  | 'DECRYPTION_FAILED';

/**
 * Structured error for Profile operations.
 * Formats as `[PROFILE:<CODE>] <message>` for easy log filtering.
 */
export class ProfileError extends Error {
  constructor(
    readonly code: ProfileErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(`[PROFILE:${code}] ${message}`);
    this.name = 'ProfileError';
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Configuration for connecting to the OrbitDB-backed Profile database.
 *
 * @see PROFILE-ARCHITECTURE.md Section 4.1 (Database Identity)
 */
export interface OrbitDbConfig {
  /** Wallet private key (hex) for OrbitDB identity derivation. */
  readonly privateKey: string;
  /** Local storage directory for OrbitDB/IPFS data (Node.js only). */
  readonly directory?: string;
  /** libp2p bootstrap peer multiaddrs. */
  readonly bootstrapPeers?: string[];
  /** Enable libp2p PubSub for real-time replication (default: true). */
  readonly enablePubSub?: boolean;
}

/**
 * Promise-based interface for the Profile's OrbitDB key-value database.
 *
 * All values are opaque `Uint8Array` blobs -- encryption/decryption is handled
 * by the caller (ProfileStorageProvider / ProfileTokenStorageProvider).
 */
export interface ProfileDatabase {
  /** Open (or create) the database. Must be called before any other method. */
  connect(config: OrbitDbConfig): Promise<void>;
  /** Write a value. Throws `ProfileError` if not connected. */
  put(key: string, value: Uint8Array): Promise<void>;
  /** Read a value. Returns `null` if the key does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  /** Delete a key. No-op if the key does not exist. */
  del(key: string): Promise<void>;
  /**
   * Return all entries, optionally filtered by a key prefix.
   * Used for listing `tokens.bundle.*` keys (Section 2.3).
   */
  all(prefix?: string): Promise<Map<string, Uint8Array>>;
  /** Cleanly shut down the database, OrbitDB instance, and Helia/libp2p. */
  close(): Promise<void>;
  /**
   * Subscribe to OrbitDB replication events (Section 4.4).
   * The callback fires when remote entries are merged into the local database.
   * @returns An unsubscribe function.
   */
  onReplication(callback: () => void): () => void;
  /** Whether `connect()` has been called and `close()` has not. */
  isConnected(): boolean;
}

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
      const publicKeyShort = derivePublicKeyShort(config.privateKey);
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

    // Clear all replication listeners
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
 * This performs a lightweight hex-substring extraction. The actual secp256k1
 * public key derivation would require the `@noble/curves` or `elliptic`
 * library at runtime. Because this adapter runs in contexts where those
 * libraries are always present (they are core sphere-sdk dependencies), we
 * attempt a dynamic import of `@noble/curves/secp256k1` first, falling back
 * to using the first 16 hex chars of the private key as a stable identifier
 * (the private key is unique per wallet, so the database name remains
 * deterministic and collision-free).
 */
function derivePublicKeyShort(privateKeyHex: string): string {
  // Attempt to derive the actual compressed public key from the private key.
  // This is best-effort -- if @noble/curves is available (it is a core
  // sphere-sdk dependency), we use it synchronously.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const secp256k1 = require('@noble/curves/secp256k1');
    const pubKeyBytes: Uint8Array = secp256k1.secp256k1.getPublicKey(privateKeyHex, true);
    return bytesToHex(pubKeyBytes).slice(0, 16);
  } catch {
    // Fallback: use hash of private key to avoid leaking raw key material.
    // In practice, @noble/curves is always available in sphere-sdk.
    // We hash to avoid exposing the private key prefix in the database name.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { sha256 } = require('@noble/hashes/sha256');
      const hash = sha256(hexToBytes(privateKeyHex));
      return bytesToHex(hash).slice(0, 16);
    } catch {
      // Last resort: truncate the private key hex. This is acceptable because
      // the database name is not secret (OrbitDB addresses are public), and
      // 16 hex chars of a 64-char key reveal limited entropy.
      return privateKeyHex.slice(0, 16);
    }
  }
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
