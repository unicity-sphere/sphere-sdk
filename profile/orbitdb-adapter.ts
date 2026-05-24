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

import { logger } from '../core/logger.js';
import { hexToBytes } from '../core/hex.js';
import { ProfileError } from './errors.js';
import {
  decodeAndDowngradeReplicated,
  decodeEntry,
  encodeEntry,
  type OpLogEntryEnvelope,
} from './oplog-entry.js';
import type { OrbitDbConfig, ProfileDatabase } from './types.js';

// Re-export types so existing consumers that import from this module still work
export type { OrbitDbConfig, ProfileDatabase };
export { ProfileError };
export type { OpLogEntryEnvelope };

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
  /**
   * Keys written by LOCAL `putEntry` calls during this session. Used by
   * `getEntry` to decide whether to trust the stored `originated` tag
   * (local write → trust) or force-downgrade to 'replicated' (peer write).
   *
   * Security invariant: `getEntry(key)` without `trustLocalClaim:true`
   * returns `originated:'replicated'` UNLESS the key is in this set AND
   * no replication event has fired for the key since we wrote it. This
   * closes the "peer forges 'user' tag in envelope, plain getEntry
   * returns it verbatim" attack surface.
   *
   * Set is session-scoped — cleared on `close()` / re-connect. That's
   * correct: a key we wrote in session N cannot be trusted across
   * sessions because a remote peer may have overwritten it (LWW) while
   * we were offline. Local writes are always re-stamped on next write.
   */
  private localAuthoredKeys: Set<string> = new Set();

  /**
   * Steelman⁴⁸ WARNING: dedup concurrent connect() calls.
   * Two callers racing on init both saw connected=false, both
   * proceeded to create Helia + OrbitDB + open db. The second
   * overwrote helia/orbitdb/db, leaking the first instance's
   * resources (no future close() could find them). Now both callers
   * await the same connect promise.
   */
  private connectInFlight: Promise<void> | null = null;
  private closeInFlight: Promise<void> | null = null;

  /**
   * Steelman remediation for issue #236 — set TRUE at the entry of
   * `closeInner()` (BEFORE the bounded teardown begins), cleared after
   * the close completes (or at the start of the next successful
   * `connect()`). Read by `getHelia()` to deny new fast-path callers
   * during the teardown window; pre-#236 the read was guarded only by
   * `this.connected`, which is cleared at the END of close — wide open
   * to a concurrent flush capturing a half-stopped Helia between the
   * `helia.stop()` race and the `onSettle` null-out.
   */
  private shuttingDown = false;

  // ---------- ProfileDatabase implementation ----------

  async connect(config: OrbitDbConfig): Promise<void> {
    // Steelman⁴⁹ WARNING: if a close() is currently tearing down,
    // we must wait for it to complete before we can connect again.
    // Otherwise a fresh connect() observing connected=true (close
    // hasn't reached connected=false yet) returns success while
    // close is still mid-teardown, leaving caller with db=null.
    if (this.closeInFlight) {
      try {
        await this.closeInFlight;
      } catch {
        /* close errors are best-effort; caller's connect should still proceed */
      }
    }
    if (this.connected) {
      return; // idempotent
    }
    if (this.connectInFlight) {
      return this.connectInFlight;
    }
    this.connectInFlight = this.connectWithRetry(config).finally(() => {
      this.connectInFlight = null;
    });
    return this.connectInFlight;
  }

  /**
   * Issue #245 #2 — bounded retry wrapper around `connectInner`.
   *
   * **Why:** the manual-test-full-recovery.sh §C.4 step reliably
   * surfaced
   *   `Failed to attach OrbitDB: ORBITDB_CONNECTION_FAILED: ...
   *    Failed to connect to OrbitDB: Database is not open`
   * on the FIRST CLI invocation following a daemon-driven sync
   * (where the daemon's prior `closeInner()` had hit the
   * `helia.stop exceeded 10000ms — dropping reference and continuing`
   * budget timeout, leaving on-disk state in a transient
   * lock/teardown limbo). The next process couldn't open the same
   * directory cleanly until ~seconds had passed.
   *
   * `cleanupOnError()` (run inside `connectInner` on throw) wipes
   * adapter-local helia/orbitdb/db handles before re-throwing — so
   * a retry creates a fresh helia + orbitdb pair from scratch. That
   * makes the retry both safe (no stale state carry-over) and
   * meaningful (we get a fresh attempt at acquiring the on-disk
   * locks / pubsub init / DB open).
   *
   * **Retry budget:** 2 attempts × 1.5s linear backoff = ~3-4.5s
   * worst-case extra latency. Acceptable given the failure mode
   * (test-script reliability + UX after a daemon restart). We do
   * NOT retry `ORBITDB_NOT_INSTALLED` — that's a sticky dep error.
   *
   * **Multi-process diagnosis:** if all retries exhaust and the
   * final message matches a lock-contention pattern, we augment the
   * error with an actionable hint pointing at the most likely cause
   * (a sphere daemon holding the lock). The base ProfileErrorCode
   * is preserved so callers' code-based routing keeps working.
   */
  private async connectWithRetry(config: OrbitDbConfig): Promise<void> {
    const RETRY_ATTEMPTS = 2; // 1 initial + 2 retries = 3 total
    const RETRY_BACKOFF_MS = 1500;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
      try {
        await this.connectInner(config);
        return;
      } catch (err) {
        lastErr = err;
        // Sticky errors: no retry. ORBITDB_NOT_INSTALLED is a dep
        // problem that won't fix itself; retrying just delays the
        // operator-visible failure.
        if (
          err instanceof ProfileError &&
          err.code === 'ORBITDB_NOT_INSTALLED'
        ) {
          throw err;
        }
        if (attempt >= RETRY_ATTEMPTS) break;
        // Linear backoff (≥1s) — absorbs a few seconds of teardown
        // / file-lock release without overshooting.
        await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
      }
    }
    // Augment the final error with multi-process diagnostic hint
    // when the message matches a likely lock-contention or
    // teardown-race pattern. Keep the original code so any caller
    // that branches on `err.code === 'ORBITDB_CONNECTION_FAILED'`
    // keeps working.
    if (
      lastErr instanceof ProfileError &&
      lastErr.code === 'ORBITDB_CONNECTION_FAILED' &&
      /Database is not open|LOCK|Resource temporarily unavailable|lockfile|EBUSY/i.test(
        lastErr.message,
      )
    ) {
      throw new ProfileError(
        'ORBITDB_CONNECTION_FAILED',
        `${lastErr.message} (after ${RETRY_ATTEMPTS + 1} attempts). ` +
          `This is typically caused by another process (e.g. a ` +
          `\`sphere daemon\`) still holding the OrbitDB / Helia ` +
          `directory lock. Stop the daemon (\`sphere daemon stop\`) ` +
          `or wait for its teardown to complete, then retry.`,
        lastErr,
      );
    }
    throw lastErr;
  }

  private async connectInner(config: OrbitDbConfig): Promise<void> {
    // Steelman remediation for issue #236 — clear the shutdown gate
    // defensively. `closeInner()` clears it on its own success path,
    // but a previous `close()` that threw mid-teardown could leave
    // `shuttingDown = true` and silently disable the local-helia
    // fast-path for the lifetime of the next session.
    this.shuttingDown = false;

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
      // 1. Create Helia IPFS node with gossipsub (required by OrbitDB v3 Sync)
      const createHelia = heliaModule.createHelia ?? heliaModule.default?.createHelia;
      const libp2pDefaults = heliaModule.libp2pDefaults ?? heliaModule.default?.libp2pDefaults;
      if (typeof createHelia !== 'function') {
        throw new Error('Could not resolve createHelia from helia module');
      }

      // OrbitDB v3 requires pubsub (gossipsub) in Helia's libp2p services.
      // Helia v6 does not include gossipsub by default, so we must inject it.
      let gossipsubFactory: any = null;
      try {
        const gossipsubModule: any = await import('@chainsafe/libp2p-gossipsub' as string);
        gossipsubFactory = gossipsubModule.gossipsub ?? gossipsubModule.default?.gossipsub ?? gossipsubModule.default;
      } catch {
        // gossipsub not installed -- OrbitDB Sync will fail if it tries to use pubsub
      }

      const heliaOptions: Record<string, unknown> = {};
      if (config.directory) {
        heliaOptions.directory = config.directory;
      }

      // Build libp2p config with gossipsub if available
      if (gossipsubFactory && typeof libp2pDefaults === 'function') {
        const libp2pConfig = libp2pDefaults();

        // Strip WebRTC transports in Node. `@libp2p/webrtc` relies on
        // `node-datachannel` which is browser-first; on Node it emits
        // `DataChannel is closed` errors during shutdown and isn't
        // actually reachable from peers without signalling. TCP +
        // WebSocket + circuit-relay cover every peer-to-peer path we
        // actually use (Helia gateway dials, OrbitDB OpLog replication
        // via gossipsub, NAT traversal via dcutr on a relay).
        //
        // Each transport in `libp2pDefaults()` is a factory function
        // whose `.toString()` reveals its constructor (e.g.
        // `new WebRTCTransport(...)`). Matching on the source string
        // is the only portable identifier across libp2p versions that
        // don't set `[Symbol.toStringTag]` on the factory.
        if (!isBrowserEnvironment() && Array.isArray(libp2pConfig.transports)) {
          libp2pConfig.transports = libp2pConfig.transports.filter((factory: any) => {
            try {
              const src = typeof factory === 'function' ? factory.toString() : '';
              return !src.includes('WebRTC');
            } catch {
              return true; // keep on inspection failure
            }
          });
        }
        if (!isBrowserEnvironment() && libp2pConfig.addresses?.listen) {
          libp2pConfig.addresses.listen = libp2pConfig.addresses.listen.filter(
            (addr: string) => !addr.includes('webrtc'),
          );
        }

        // **Isolated / test mode** — an explicit empty `bootstrapPeers`
        // array signals "do not attempt peer discovery."
        //
        // Why: `libp2pDefaults()` unconditionally includes
        // `peerDiscovery: [bootstrap(bootstrapConfig)]` pointing at the
        // canonical IPFS bootstrap list. On a CI runner with no
        // outbound IPFS connectivity, bootstrap retries indefinitely
        // and the OrbitDB integration test hangs past its 12-minute
        // suite timeout (originally tracked in sphere-sdk#105, which
        // led to the test being skipped in CI wholesale).
        //
        // With `bootstrapPeers: []`, we keep gossipsub (so OrbitDB v3
        // doesn't fail on missing pubsub) and the local-only services
        // (keychain, identify, ping) but drop every outbound-discovery
        // surface: peerDiscovery, DHT, autoNAT, dcutr, delegated
        // routing. The adapter remains fully functional for single-
        // process OrbitDB operations — which is all the CI integration
        // test needs.
        //
        // Production callers who want real peer discovery either omit
        // `bootstrapPeers` (getting libp2pDefaults behaviour) or pass
        // a non-empty list (wired here).
        const isIsolated = Array.isArray(config.bootstrapPeers) &&
          config.bootstrapPeers.length === 0;
        if (isIsolated) {
          libp2pConfig.peerDiscovery = [];
          if (libp2pConfig.services) {
            const isolatedServices: Record<string, unknown> = {};
            // Allow-list of services that do NOT perform outbound
            // discovery on startup. Every other service in
            // libp2pDefaults (autoNAT, dcutr, dht, delegatedRouting,
            // http, ipnsFetch, ipnsPublish) issues network requests.
            const allowed = new Set(['identify', 'identifyPush', 'keychain', 'ping']);
            for (const [k, v] of Object.entries(libp2pConfig.services)) {
              if (allowed.has(k)) isolatedServices[k] = v;
            }
            libp2pConfig.services = isolatedServices;
          }
          libp2pConfig.addresses = { listen: [] };
        } else if (config.bootstrapPeers && config.bootstrapPeers.length > 0) {
          // Non-empty bootstrap list — replace the default peers with
          // the caller's. Keeps peerDiscovery active but uses the
          // caller-supplied peer set.
          try {
            const bootstrapModule: any = await import('@libp2p/bootstrap' as string);
            const bootstrapFactory = bootstrapModule.bootstrap ?? bootstrapModule.default?.bootstrap ?? bootstrapModule.default;
            if (typeof bootstrapFactory === 'function') {
              libp2pConfig.peerDiscovery = [bootstrapFactory({ list: [...config.bootstrapPeers] })];
            }
          } catch {
            // @libp2p/bootstrap unavailable — leave the defaults in place.
          }
        }

        libp2pConfig.services = {
          ...libp2pConfig.services,
          pubsub: gossipsubFactory({ allowPublishToZeroTopicPeers: true }),
        };
        heliaOptions.libp2p = libp2pConfig;
      } else if (gossipsubFactory) {
        // libp2pDefaults not available -- pass minimal libp2p with gossipsub
        heliaOptions.libp2p = {
          services: {
            pubsub: gossipsubFactory({ allowPublishToZeroTopicPeers: true }),
          },
        };
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
      //
      // Steelman²⁸/²⁹ critical: prefer caller-supplied dbNameOverride
      // (derived from a wipeable Uint8Array). Falling back to
      // derivePublicKeyShort(config.privateKey) is a memory-safety
      // hazard documented on OrbitDbConfig. Now: require one or the
      // other, fail closed if neither.
      let dbName: string;
      if (config.dbNameOverride) {
        dbName = config.dbNameOverride;
      } else if (config.privateKey && config.privateKey.length > 0) {
        const publicKeyShort = await derivePublicKeyShort(config.privateKey);
        dbName = `sphere-profile-${publicKeyShort}`;
      } else {
        throw new ProfileError(
          'ORBITDB_CONNECTION_FAILED',
          'OrbitDbConfig requires either dbNameOverride (preferred) or privateKey (deprecated).',
        );
      }

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
      // Steelman² remediation: shape validation now lives inside
      // `coerceToUint8Array` (single source of truth shared with
      // getEntry() and all()). A peer-crafted LWW write that puts a
      // pathological object in the value slot is rejected uniformly
      // across all three entry points.
      return coerceToUint8Array(value);
    } catch (err) {
      if (err instanceof ProfileError) throw err;
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

  // ---------- Structured-entry API (PROFILE-OPLOG-SCHEMA.md §5) ----------

  /**
   * Write a structured OpLog entry envelope at `key`.
   *
   * Encodes via deterministic CBOR (@ipld/dag-cbor) and stores the bytes
   * in the underlying OrbitDB keyvalue database. OrbitDB signs the
   * (key, cborBytes) pair, binding the envelope's originated tag to the
   * author's identity.
   *
   * Callers SHOULD construct envelopes via `buildLocalEntry()` or the
   * replication-downgrade helpers from `profile/oplog-entry.ts` rather
   * than hand-rolling — those helpers enforce the (type, originated)
   * coherence check.
   */
  async putEntry(key: string, entry: OpLogEntryEnvelope): Promise<void> {
    this.ensureConnected();
    try {
      const cborBytes = encodeEntry(entry);
      await this.db.put(key, cborBytes);
      // Track this key as locally authored. `getEntry` uses this set to
      // decide whether to trust the stored `originated` tag.
      this.localAuthoredKeys.add(key);
    } catch (err) {
      throw new ProfileError(
        'ORBITDB_WRITE_FAILED',
        `Failed to write structured entry at "${key}": ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  /**
   * Also track local authorship when code takes the legacy `put()` path.
   * This is called by ProfileStorageProvider.writeEnvelope's fallback branch
   * (for adapters without structured-entry support). We track it here so
   * getEntry's trust decision is uniform regardless of which API wrote.
   */
  markLocallyAuthored(key: string): void {
    this.localAuthoredKeys.add(key);
  }

  /**
   * Read a structured OpLog entry envelope at `key`, or `null` if absent.
   *
   * SECURITY DEFAULT (post-steelman): the returned envelope's
   * `originated` field is forced to `'replicated'` UNLESS the key was
   * written by a local `putEntry` in THIS session AND no replication
   * event has fired for this key since. Callers that specifically need
   * the stored tag (e.g., debug tools) must pass `trustLocalClaim: true`.
   *
   * Legacy opaque-bytes entries (from pre-schema wallets) are wrapped
   * in a synthetic envelope per §7.1 — callers can detect them via
   * `isLegacyEntry(envelope)` from `profile/oplog-entry.ts`.
   *
   * @param opts.downgradeAsReplicated  — LEGACY: when true, forces
   *   downgrade via `decodeAndDowngradeReplicated`. Kept for backward
   *   compat but largely redundant since downgrade is now the DEFAULT.
   * @param opts.trustLocalClaim  — EXPLICIT: when true, returns the
   *   envelope's stored `originated` tag verbatim. Callers use this
   *   when they've already authenticated the source (e.g., immediately
   *   after putEntry). Legacy entries (v=0) always downgrade regardless.
   */
  async getEntry(
    key: string,
    opts: {
      downgradeAsReplicated?: boolean;
      trustLocalClaim?: boolean;
    } = {},
  ): Promise<OpLogEntryEnvelope | null> {
    this.ensureConnected();
    try {
      const raw = await this.db.get(key);
      if (raw === undefined || raw === null) return null;
      const bytes = coerceToUint8Array(raw);

      // Explicit downgrade requested → route through the ingress path.
      if (opts.downgradeAsReplicated === true) {
        return decodeAndDowngradeReplicated(bytes);
      }

      // Default: decode, then enforce the downgrade UNLESS the caller
      // explicitly trusts the local claim AND the key is known locally.
      const envelope = decodeEntry(bytes);

      // Legacy entries (v=0) always carry the synthesized system tag —
      // pass through unchanged; the v=0 sentinel tells the caller.
      if (envelope.v === 0) {
        return envelope;
      }

      const trusted = opts.trustLocalClaim === true && this.localAuthoredKeys.has(key);
      if (trusted) {
        return envelope;
      }

      // Non-trusted read → force downgrade to 'replicated'. Peer-claimed
      // 'user'/'system' tags are overridden here.
      //
      // Steelman⁴³/⁴⁴ DESIGN NOTE: `localAuthoredKeys` is per-INSTANCE
      // memory. Tab A's writes that replicate to Tab B (same identity)
      // appear as 'replicated' to B even though both tabs share the
      // wallet identity. This is FAIL-CLOSED behavior: B does NOT grant
      // elevated privilege based on a forged tag, just refuses to grant
      // it without local-authored proof. Cross-tab actions that depend
      // on `trustLocalClaim` will be downgraded — that's the safe
      // default. A future enhancement could verify the OpLog entry's
      // identity field against the wallet's chainPubkey to recognize
      // sibling-tab writes; deferred until a use case justifies it.
      return decodeAndDowngradeReplicated(bytes);
    } catch (err) {
      // Steelman³ remediation: pass ProfileError through unchanged.
      // Re-wrapping double-prefixes the error code (`[PROFILE:ORBITDB_READ_FAILED]
      // ... [PROFILE:ORBITDB_READ_FAILED]`) and obscures the original
      // diagnostic — particularly for malformed-bytes errors thrown by
      // coerceToUint8Array.
      if (err instanceof ProfileError) throw err;
      throw new ProfileError(
        'ORBITDB_READ_FAILED',
        `Failed to read structured entry at "${key}": ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  async all(
    prefix?: string,
    opts?: { readonly maxResults?: number },
  ): Promise<Map<string, Uint8Array>> {
    this.ensureConnected();
    try {
      const result = new Map<string, Uint8Array>();
      // OrbitDB keyvalue databases expose an `all()` method that returns
      // all entries as an object or iterable.
      const allEntries = await this.db.all();
      // Round 5 (FIX 3) — short-circuit iteration once the requested
      // `maxResults` matching entries have been buffered. Defends
      // against a hostile peer planting millions of crafted prefix
      // matches — without the cap, the entire matching set is
      // materialized regardless of the disposition adapter's own cap.
      const maxResults =
        opts?.maxResults !== undefined &&
        Number.isFinite(opts.maxResults) &&
        opts.maxResults >= 0
          ? Math.floor(opts.maxResults)
          : undefined;
      const isCapped = maxResults !== undefined;

      // Steelman³ remediation: skip malformed values rather than throwing.
      // `keys()` and `clear()` use `all()` purely for key enumeration —
      // a single peer-replicated bad value would otherwise DoS those
      // operations entirely. Skipping with a logged-once warning keeps
      // legitimate flows working while surfacing the corruption.
      //
      // Steelman²⁸ warning: enforce a per-call AGGREGATE memory budget so
      // a malicious peer publishing thousands of near-cap values cannot
      // sum into a multi-GB OOM. 256 MiB is far above any legitimate
      // session payload total.
      const ALL_AGGREGATE_BYTES_CAP = 256 * 1024 * 1024;
      // Steelman²⁹ warning: distinguish the cap-exceeded fail-stop from
      // per-entry coercion failures via a TYPED sentinel, not via brittle
      // substring matching on err.message. A future error message reword
      // would silently turn the hard-stop into a continue.
      const AGGREGATE_CAP_SENTINEL = Symbol('orbitdb-aggregate-cap-exceeded');
      let aggregateBytes = 0;
      let skippedCount = 0;
      const tryCoerce = (key: string, value: unknown): boolean => {
        try {
          const coerced = coerceToUint8Array(value);
          aggregateBytes += coerced.byteLength;
          if (aggregateBytes > ALL_AGGREGATE_BYTES_CAP) {
            const err = new ProfileError(
              'ORBITDB_READ_FAILED',
              `all(): aggregate value bytes exceeded ${ALL_AGGREGATE_BYTES_CAP} ` +
                `(at key="${key}"). Refusing to load further entries — possible ` +
                `OOM attack from a malicious peer.`,
            );
            (err as unknown as { [s: symbol]: boolean })[AGGREGATE_CAP_SENTINEL] = true;
            throw err;
          }
          result.set(key, coerced);
          return true;
        } catch (err) {
          if (err && typeof err === 'object' && (err as { [s: symbol]: boolean })[AGGREGATE_CAP_SENTINEL]) {
            // Hard fail-stop on aggregate cap.
            throw err;
          }
          skippedCount += 1;
          if (skippedCount <= 3) {
            // Log first few; suppress thereafter to avoid log spam.
            logger.warn(
              'OrbitDbAdapter',
              `all(): skipping malformed entry at key="${key}": ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          return false;
        }
      };

      // Round 5 (FIX 3) — early-out helper. When `maxResults` is set,
      // stop iterating as soon as the requested number of matching
      // entries have been successfully buffered.
      const reachedCap = (): boolean =>
        isCapped && result.size >= (maxResults as number);

      // allEntries may be an array of {key,value,hash}, an async iterable,
      // a Map, or a plain object depending on the OrbitDB version.
      if (Array.isArray(allEntries)) {
        // OrbitDB v3 keyvalue `all()` returns Array<{key, value, hash}>
        for (const entry of allEntries) {
          if (reachedCap()) break;
          const entryKey: string = entry.key ?? entry[0];
          const entryValue = entry.value ?? entry[1];
          if (prefix && !entryKey.startsWith(prefix)) {
            continue;
          }
          tryCoerce(entryKey, entryValue);
        }
      } else if (allEntries && typeof allEntries[Symbol.asyncIterator] === 'function') {
        for await (const entry of allEntries) {
          if (reachedCap()) break;
          const entryKey: string = entry.key ?? entry[0];
          const entryValue = entry.value ?? entry[1];
          if (prefix && !entryKey.startsWith(prefix)) {
            continue;
          }
          tryCoerce(entryKey, entryValue);
        }
      } else if (allEntries instanceof Map) {
        for (const [entryKey, entryValue] of allEntries) {
          if (reachedCap()) break;
          if (prefix && !entryKey.startsWith(prefix)) {
            continue;
          }
          tryCoerce(entryKey, entryValue);
        }
      } else if (typeof allEntries === 'object' && allEntries !== null) {
        for (const [entryKey, entryValue] of Object.entries(allEntries)) {
          if (reachedCap()) break;
          if (prefix && !entryKey.startsWith(prefix)) {
            continue;
          }
          tryCoerce(entryKey, entryValue);
        }
      }

      if (skippedCount > 3) {
        logger.warn(
          'OrbitDbAdapter',
          `all(): skipped ${skippedCount} malformed entries total (further details suppressed).`,
        );
      }

      return result;
    } catch (err) {
      if (err instanceof ProfileError) throw err;
      throw new ProfileError(
        'ORBITDB_READ_FAILED',
        `Failed to read all entries${prefix ? ` with prefix "${prefix}"` : ''}: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  async close(): Promise<void> {
    // Steelman⁴⁹ WARNING: dedup concurrent close() calls and let
    // connect() await us via closeInFlight. Without this, a new
    // connect() racing the second half of close() could observe
    // connected=true (close hasn't reset the flag yet) and return
    // immediately, leaving caller with stale handles.
    if (this.closeInFlight) return this.closeInFlight;
    this.closeInFlight = this.closeInner().finally(() => {
      this.closeInFlight = null;
    });
    return this.closeInFlight;
  }

  private async closeInner(): Promise<void> {
    // Steelman⁴⁸ WARNING: if a connect() is currently in flight, await
    // it before short-circuiting. Without this, close() observes
    // connected=false (still mid-init), returns, and the eventual
    // connect resolution leaves resources stranded with no cleanup
    // path. Best-effort: wait for connectInFlight; if it succeeded
    // we'll then clean up; if it failed (cleanupOnError already ran)
    // we return idempotently.
    if (this.connectInFlight) {
      try {
        await this.connectInFlight;
      } catch {
        /* already cleaned up via cleanupOnError */
      }
    }
    if (!this.connected) {
      return; // idempotent
    }

    // Steelman remediation for issue #236 — flip the shutdown gate
    // BEFORE the bounded teardown begins. From this point forward,
    // `getHelia()` returns `null` so any concurrent `pinCarBlocksToIpfs`
    // call falls back to HTTP-only. Without this gate, the next-process
    // recovery is unaffected (gateways still have the block) but the
    // current process avoids dispatching `blockstore.put` against a
    // helia whose libp2p / blockstore is mid-stop.
    this.shuttingDown = true;

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
    // Clear session-scoped locally-authored key set so a reconnect doesn't
    // trust keys from the prior session (post-session peer writes may have
    // overwritten them).
    this.localAuthoredKeys.clear();

    // Bounded teardown (#137). Each step gets a budget — a hung
    // libp2p / pubsub / DAG-sync layer must not pin `Sphere.destroy()`
    // for minutes. Best-effort: on timeout we log, drop the reference,
    // and proceed; any leaked resources are reclaimed at process exit.
    await closeWithBudget('db.close', () => this.db?.close(), () => {
      this.db = null;
    });
    await closeWithBudget('orbitdb.stop', () => this.orbitdb?.stop(), () => {
      this.orbitdb = null;
    });
    await closeWithBudget('helia.stop', () => this.helia?.stop(), () => {
      this.helia = null;
    });

    this.connected = false;
    // Clear the shutdown gate AFTER `this.connected` flips. A
    // subsequent connect() resets it again defensively below.
    this.shuttingDown = false;
  }

  onReplication(callback: () => void): () => void {
    this.ensureConnected();

    // OrbitDB databases emit 'update' events when remote entries are merged.
    // Invalidate the locally-authored set: a replication event means a peer
    // may have overwritten any of our keys (LWW per-key), so we can no
    // longer trust the stored `originated` tag for ANY key without
    // re-authoring. This is conservative (over-invalidates) but safe.
    const handler = () => {
      this.localAuthoredKeys.clear();
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

  /**
   * Issue #236 — Expose the underlying Helia node so the Profile token-
   * storage pin/fetch paths can use the local on-disk blockstore as the
   * primary CAR store. Returns `null` when disconnected, pre-`connect()`,
   * or DURING `close()` teardown (steelman remediation).
   *
   * Why this is safe to expose:
   *   - The accessor is READ-ONLY (no `setHelia`) — callers cannot swap
   *     out our IPFS substrate.
   *   - The returned handle is the SAME instance the adapter uses for
   *     OrbitDB's own blockstore, so writes via `blockstore.put` share
   *     the on-disk persistence directory configured at `connect()` time.
   *   - Typed as `unknown` to keep helia types out of the public Profile
   *     interface (the rest of the SDK still tree-shakes cleanly when
   *     helia is absent — the adapter is the single point of contact).
   *
   * **Shutdown gating (steelman remediation).** A concurrent flush
   * firing during `closeInner()` could otherwise capture the helia
   * handle and call `blockstore.put` on a draining Helia — the
   * underlying libp2p / blockstore is already mid-teardown and the put
   * may hang indefinitely (or write to a half-stopped store). We
   * surface `null` from the moment `closeInner()` begins its teardown
   * budget so in-flight callers immediately fall back to the HTTP-only
   * pin path. The destroy-ordering invariant from PR #235 already
   * ensures the token-storage layer is drained before the adapter
   * closes; this gate is a defense-in-depth backstop against a future
   * caller that bypasses the scheduler.
   */
  getHelia(): unknown | null {
    if (this.shuttingDown) return null;
    return this.helia ?? null;
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
    const secp256k1Module: any = await import('@noble/curves/secp256k1.js' as string);
    const pubKeyBytes: Uint8Array = secp256k1Module.secp256k1.getPublicKey(privateKeyHex, true);
    return bytesToHex(pubKeyBytes).slice(0, 16);
  } catch {
    // Fallback: use SHA-256 hash of private key to avoid leaking raw key material
  }

  try {
    const hashModule: any = await import('@noble/hashes/sha2.js' as string);
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
 * Per-step budget for graceful teardown of OrbitDB / Helia layers (#137).
 * On timeout we DROP the reference instead of awaiting forever — `destroy()`
 * is a terminal call and the process or test runner will reclaim the rest.
 */
const TEARDOWN_STEP_TIMEOUT_MS = 10_000;

async function closeWithBudget(
  label: string,
  invoke: () => Promise<void> | undefined,
  onSettle: () => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const op = invoke();
    if (!op) return; // ref was null
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), TEARDOWN_STEP_TIMEOUT_MS);
    });
    const outcome = await Promise.race([op.then(() => 'ok' as const), timeout]);
    if (outcome === 'timeout') {
      logger.warn(
        'OrbitDB',
        `${label} exceeded ${TEARDOWN_STEP_TIMEOUT_MS}ms — dropping reference and continuing`,
      );
    }
  } catch {
    // Best-effort close; swallow underlying errors.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    onSettle();
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

// Steelman³⁵: hexToBytes consolidated to core/hex.ts (top-of-file import).

/**
 * Steelman² remediation: hard cap on the object-coercion fallback. A
 * peer-replicated LWW write can put a pathological object in the value
 * slot — without a cap, `new Uint8Array(Object.values(...))` would
 * allocate proportional to attacker-chosen `length`. 1 MiB is well
 * above any legitimate envelope (CIDs + metadata) and well below an
 * OOM-inducing allocation.
 */
const COERCE_OBJECT_VALUE_CAP = 1 << 20;

/**
 * Coerce a value returned by OrbitDB into a Uint8Array.
 *
 * Steelman² remediation: validates object shape BEFORE coercing. A
 * peer-crafted LWW write can put any object in the value slot:
 *   - huge `length` → OOM via `new Uint8Array(1e9)`
 *   - non-numeric entries → silently coerced to NaN→0, masking corruption
 *   - strings, nested objects, inherited properties, etc.
 * Reject anything that doesn't look like a dense byte-valued map.
 *
 * Throws ProfileError('ORBITDB_READ_FAILED') on malformed input — same
 * code path the previous in-line validator used. Callers that already
 * wrap in their own try/catch propagate it correctly.
 *
 * Single source of truth shared across `get()`, `getEntry()`, and
 * `all()` so no entry point bypasses the validation.
 */
function coerceToUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (typeof value === 'object' && value !== null) {
    // Steelman³ remediation: count keys via a bounded for-in loop FIRST,
    // before any Object.values()/Object.keys() allocation. A peer-crafted
    // object with 10M numeric-keyed entries would otherwise allocate
    // an 80MB+ string array for the keys before the cap fires. Bounded
    // counting closes that pre-allocation OOM window.
    let keyCount = 0;
    for (const k in value) {
      if (Object.prototype.hasOwnProperty.call(value, k)) {
        keyCount += 1;
        if (keyCount > COERCE_OBJECT_VALUE_CAP) {
          throw new ProfileError(
            'ORBITDB_READ_FAILED',
            `Refusing to coerce object with > ${COERCE_OBJECT_VALUE_CAP} entries to Uint8Array (key-count cap exceeded)`,
          );
        }
      }
    }
    // Now safe to materialize values — bounded by the cap.
    const values = Object.values(value);
    if (values.length > COERCE_OBJECT_VALUE_CAP) {
      // Defensive: keyCount above SHOULD have caught this, but the for-in
      // loop excludes inherited enumerables which Object.values does not.
      throw new ProfileError(
        'ORBITDB_READ_FAILED',
        `Refusing to coerce object with ${values.length} entries to Uint8Array (post-allocation cap)`,
      );
    }
    const bytes = new Uint8Array(values.length);
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255) {
        throw new ProfileError(
          'ORBITDB_READ_FAILED',
          `Invalid byte value at index ${i}: ${typeof v} (expected integer 0-255)`,
        );
      }
      bytes[i] = v;
    }
    return bytes;
  }
  // If the value is something unexpected, return an empty array.
  return new Uint8Array(0);
}

/**
 * True when running in a browser-like environment (Window present).
 * In browsers we keep WebRTC because it's the only viable direct
 * peer-to-peer transport from a page — TCP/WebSocket-only browser
 * nodes can't initiate inbound connections. In Node we strip it
 * because `node-datachannel` is a workaround rather than real support.
 */
function isBrowserEnvironment(): boolean {
  return typeof (globalThis as { window?: unknown }).window !== 'undefined';
}
