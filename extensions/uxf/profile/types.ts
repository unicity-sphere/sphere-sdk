/**
 * UXF Profile Type Definitions
 *
 * All type definitions for the Profile persistence system.
 * References: PROFILE-ARCHITECTURE.md Sections 2, 2.3, 5.2, 7.6, 9.1
 *
 * This file is types-only with the exception of the key mapping constants
 * (PROFILE_KEY_MAPPING, CACHE_ONLY_KEYS, IPFS_STATE_KEYS_PATTERN).
 */

import type { OracleProvider } from '../../../oracle';
import type { ProfilePointerLayer } from './aggregator-pointer';

// =============================================================================
// OrbitDB Configuration
// =============================================================================

/**
 * Configuration for connecting to an OrbitDB instance.
 * The database identity is derived from the wallet's secp256k1 key.
 *
 * Steelman²⁸/²⁹ critical: passing the private key (hex string) into the
 * OrbitDB adapter is a memory-safety hazard — JS strings are immutable
 * and cannot be wiped, leaving the master key heap-resident for the
 * session lifetime. EITHER `dbNameOverride` OR `privateKey` must be
 * provided; new callers SHOULD pass `dbNameOverride` (computed ONCE
 * from a wipeable Uint8Array, with the bytes zeroized after derivation).
 */
/**
 * OUTBOX-SEND-FOLLOWUPS item #4 — result of one
 * `gcExpiredTombstones()` sweep on a profile writer (OutboxWriter or
 * SentLedgerWriter). Returned to callers for diagnostics.
 *
 *  - `scanned` — total tombstones observed under the writer's prefix.
 *  - `purged`  — tombstones whose `(now - deletedAt) > retentionMs`
 *                AND whose `db.del()` succeeded; storage reclaimed.
 *  - `kept`    — tombstones inside the retention window, OR
 *                tombstones whose `db.del()` threw (best-effort sweep
 *                preserves the marker for the next cycle).
 *  - `skipped` — `true` when the prefix scan itself failed (DB
 *                unavailable); counters are all zero in that case.
 *
 * Invariant: `scanned === purged + kept` when `skipped === false`.
 */
export interface TombstoneGcResult {
  readonly scanned: number;
  readonly purged: number;
  readonly kept: number;
  readonly skipped: boolean;
}

/**
 * Item #15 Phase D.1a — outcome of a lean-snapshot publish attempt.
 *
 * Shape mirrors `LifecycleManager.publishAggregatorPointerBestEffort`:
 *   - `{ ok: true }` — anchored at a new pointer version.
 *   - `{ ok: false, transient: true }` — network / aggregator timed
 *     out; pending-publish marker stamped; safe to retry.
 *   - `{ ok: false, transient: false, code? }` — permanent failure
 *     (rejected, untrusted proof, trust-base stale, etc.); operator
 *     intervention required; retrying will not help. The `code` field
 *     carries the typed `AggregatorPointerErrorCode` when available, or
 *     a closure-side `NOT_READY_*` sentinel when the closure bailed
 *     before reaching the publish step.
 */
export interface ProfileSnapshotPublishResult {
  readonly ok: boolean;
  readonly transient: boolean;
  readonly code?: string;
}

/**
 * Permanent marker written after a successful OpLog auto-reset
 * (see `OrbitDbAdapter.resetCorruptedLog` + the auto-reset path in
 * `FlushScheduler.flushToIpfs`).
 *
 * **Permanence semantics.** Once a Profile is "Recovered" it MUST stay
 * Recovered for the life of the wallet on this device. The marker is
 * idempotent under repeated writes (subsequent resets overwrite
 * `recoveredAt` / `lostHeadCid`) but is never deleted by the SDK except
 * via `Sphere.clear()` (full wallet wipe). The `walkBackClosed: true`
 * field encodes the "history before this point is permanently
 * inaccessible" invariant for downstream readers.
 *
 * **Data-loss implication.** Auto-reset wipes the local OrbitDB OpLog,
 * which holds bundle-index pointers + operational state for the Profile
 * layer. Token data on local token storage (TXF format under
 * `sphere-token-storage-<addressId>`) is preserved. Operational state
 * (outbox / sent / history / tombstones / finalization-queue) that lived
 * ONLY in the OpLog and had not been published to a UXF bundle CID is
 * lost. Cross-device peers may still hold some of that state and can
 * re-replicate it via OrbitDB gossipsub — but on a fresh-`dataDir`
 * cold start with no peers, the wallet starts from the snapshot/bundle
 * pin set alone.
 */
export interface ProfileRecoveryMarker {
  /** Schema version. Currently 1. */
  readonly version: 1;
  /** UNIX ms timestamp of the recovery operation. */
  readonly recoveredAt: number;
  /** CID of the OpLog head that was unreachable; null if pattern didn't capture. */
  readonly lostHeadCid: string | null;
  /** Where the recovery was triggered from (e.g. "flush-scheduler.bundle-write"). */
  readonly context: string;
  /**
   * Always true. Encodes the "walk-back past this point is permanently
   * closed" semantic for downstream readers — once present, callers MUST
   * treat any state derived from pre-`recoveredAt` OpLog entries as
   * unrecoverable.
   */
  readonly walkBackClosed: true;
  /** Human-readable note for operator triage. Stored verbatim. */
  readonly note: string;
}

export interface OrbitDbConfig {
  /**
   * @deprecated — pass `dbNameOverride` instead. JS strings cannot be
   * zeroized, so storing the master key here leaks it to GC for the
   * entire session. Optional: only consulted when `dbNameOverride` is
   * not set.
   */
  readonly privateKey?: string;
  /**
   * Pre-computed `sphere-profile-<16-hex>` database name. When set,
   * the adapter uses this directly and IGNORES privateKey for identity
   * derivation. Callers should derive once from a Uint8Array, wipe the
   * bytes, then pass the resulting name here.
   */
  readonly dbNameOverride?: string;
  /** Local storage directory for OrbitDB data (Node.js only) */
  readonly directory?: string;
  /**
   * Issue #330 — IndexedDB database name for Helia's blockstore in the
   * browser. When `directory` is not set and the runtime is a browser,
   * the adapter installs `blockstore-idb` so OpLog + CAR blocks persist
   * across page reloads (the pre-fix default was Helia's
   * `MemoryBlockstore`, which evaporates on tab unload — root cause
   * of #330). Defaults to `'sphere-helia-blocks'` when omitted; set
   * a per-wallet name (e.g. `sphere-helia-blocks-<addressId>`) for
   * full isolation between wallets sharing one origin.
   *
   * Ignored on Node (FsBlockstore is used instead).
   */
  readonly browserBlockstorePath?: string;
  /** libp2p bootstrap peers for peer discovery */
  readonly bootstrapPeers?: string[];
  /** Enable libp2p pubsub for replication (default: true) */
  readonly enablePubSub?: boolean;
  /**
   * Issue #266 — HTTP-only IPFS mode for wallet/CLI clients.
   *
   * When `true`, the OrbitDB adapter strips the libp2p networking
   * cost that was burning wallet startup time:
   *   - Forces libp2p into isolated mode (no DHT, bootstrap, autoNAT,
   *     dcutr, peerDiscovery, delegatedRouting, ipnsFetch, ipnsPublish).
   *     Only identify, identifyPush, keychain, ping, and the gossipsub
   *     stub required by OrbitDB v3 remain. No outbound TCP connections
   *     to port 4001; the global IPFS DHT is not joined.
   *   - Replaces Helia's default block brokers. The defaults are
   *     `bitswap` (would hang waiting for peers) and `trustlessGateway`
   *     (walks public gateways like `trustless-gateway.link` /
   *     `4everland.io` which do not host our wallet data and time out
   *     ~30s per miss). Instead we install a single broker that
   *     HTTP-fetches missing blocks from operator-controlled Kubo
   *     gateways via `POST /api/v0/block/get?arg=<cid>`, configured
   *     by `ipfsGateways` (see below).
   *
   * What is NOT stripped: Helia's `FsBlockstore` under
   * `<directory>/blocks/`. The on-disk blockstore handles cross-PROCESS
   * recovery on the same `dataDir` without depending on a successful
   * flush-to-Kubo before process exit. Disk-resident blocks are
   * MB-scale — negligible vs the libp2p costs we stripped.
   * Cross-DEVICE recovery (different machine, fresh `dataDir`) is
   * served by the HTTP block broker + the snapshot prefetch in
   * `profile/ipfs-client.ts`.
   *
   * Recommended default for `createNodeProfileProviders` and
   * `createBrowserProfileProviders` (the wallet client factories).
   * Tests and operator-side bridges that want real peer discovery
   * pass `httpOnlyIpfs: false` and configure `bootstrapPeers`
   * explicitly.
   *
   * If `bootstrapPeers` is also supplied as a non-empty array,
   * `httpOnlyIpfs: true` wins — the explicit isolation contract
   * takes precedence over any peer list.
   *
   * @default false on the raw `OrbitDbConfig` (backward compat).
   *          The wallet factories override to `true`.
   */
  readonly httpOnlyIpfs?: boolean;
  /**
   * Issue #266 — Operator-controlled Kubo HTTP gateway base URLs
   * used by the HTTP block broker in `httpOnlyIpfs: true` mode. The
   * broker races them via `Promise.any`. ProfileStorageProvider
   * passes through `ProfileConfig.ipfsGateways` automatically; raw
   * callers can supply this directly.
   *
   * Ignored when `httpOnlyIpfs !== true`.
   */
  readonly ipfsGateways?: ReadonlyArray<string>;
}

// =============================================================================
// Profile Configuration
// =============================================================================

/**
 * Configuration for Profile initialization.
 * Mirrors the IpfsStorageConfig pattern from impl/shared/ipfs/ipfs-types.ts.
 */
export interface ProfileConfig {
  /** OrbitDB connection configuration */
  readonly orbitDb: OrbitDbConfig;
  /** Whether to encrypt values stored in OrbitDB (default: true) */
  readonly encrypt?: boolean;
  /**
   * Network identifier — passed through to the pointer layer's
   * SPEC §14.1 / §11.12 denylist enforcement. Pass 'test-vectors' to
   * accept the canonical 0x01×32 KAT vector for fixture-driven tests.
   * Production deployments should use 'mainnet' / 'testnet' / 'dev'
   * (or leave undefined; any non-'test-vectors' value rejects the KAT).
   */
  readonly network?: string;
  /** IPFS gateway URLs for CAR file pinning/fetching */
  readonly ipfsGateways?: string[];
  /** Maximum local cache size in bytes (optional, platform-dependent) */
  readonly cacheMaxSizeBytes?: number;
  /** Consolidation retention period in ms before removing superseded bundles (default: 7 days) */
  readonly consolidationRetentionMs?: number;
  /** Minimum consolidation retention period in ms (default: 24 hours) */
  readonly consolidationRetentionMinMs?: number;
  /** Write-behind debounce window in ms (default: 2000) */
  readonly flushDebounceMs?: number;
  /**
   * Issue #239 — per-flush remote-durability verification deadline (ms)
   * for the token storage provider's flush body. Forwarded into
   * `ProfileTokenStorageProviderOptions.flushVerificationDeadlineMs`
   * when the factory wires up the provider.
   *
   * Defaults to 30 000 when undefined (production wants verification
   * by default). Pass `0` to opt out (tests, dev mode, scenarios
   * where the shutdown gate alone suffices). See
   * `ProfileTokenStorageProviderOptions.flushVerificationDeadlineMs`
   * for full semantics.
   */
  readonly flushVerificationDeadlineMs?: number;
  /**
   * Issue #330 — inline durability gate on `publishAggregatorPointerBestEffort`.
   *
   * When set to a positive number, the publish path performs an inline
   * HEAD-verify of the just-published snapshot CID against the configured
   * IPFS gateways *before* clearing `pendingPublishCid`. If HEAD-verify
   * does not confirm the CID within the deadline, the marker is kept
   * (publish is treated as transient-failure for retry purposes) and a
   * `storage:pending-publish` event fires.
   *
   * Distinct from `flushVerificationDeadlineMs` (which PR #272 moved off
   * the critical path to background): this gate is on the marker-clear,
   * not the flush completion. It enforces "the pointer never advertises
   * a CID that isn't durably remote." The at-least-once Nostr ack gate
   * is unaffected — the flush still completes; only the pending-publish
   * retry marker is held until durability is confirmed.
   *
   * Default: 0 (no gate, preserves pre-#330 behaviour). The wallet
   * factories (`createBrowserProfileProviders`, `createNodeProfileProviders`)
   * override to a sensible production value (5 000 ms).
   *
   * Pass `0` to opt out (tests, dev fixtures, stub pointers).
   */
  readonly pointerPublishDurabilityGateMs?: number;
  /**
   * Item #15 Phase F — retention window (in ms) for OUTBOX/SENT
   * tombstones before they are GC'd at snapshot-build time. Tombstones
   * older than this threshold are `db.del()`'d by the per-writer
   * `gcExpiredTombstones()` sweep that runs in the lean-snapshot
   * builder's pre-read hook, AND consequently dropped from the
   * published snapshot (so peers do not receive ancient deletes that
   * have already converged everywhere).
   *
   * Default: 30 days. The safety contract — retention must exceed the
   * longest realistic concurrent-replica pre-sync window — is taken
   * from the Item #4 default; a fortnight-long offline replica still
   * converges before its tombstones are reclaimed.
   *
   * Set lower for tests that exercise the GC path with simulated
   * clocks. Setting to `0` makes every tombstone immediately eligible
   * for purge.
   *
   * @see docs/uxf/OUTBOX-SEND-FOLLOWUPS.md — Item #4 (writer GC) and
   *      Item #15 Phase F (snapshot-build-time hook).
   */
  readonly tombstoneRetentionMs?: number;
  /** Custom bootstrap peers for OrbitDB (convenience alias for orbitDb.bootstrapPeers) */
  readonly profileOrbitDbPeers?: string[];
  /**
   * Publish a wallet-keyed IPNS snapshot of active bundle CIDs after
   * every flush, and attempt to resolve it on cold-start when the
   * local OrbitDB has no bundles. Default: true.
   *
   * This is an OrbitDB-layer parity assist — without it, a freshly
   * re-imported wallet on a wiped device cannot discover its own
   * bundles unless another live peer is replicating the OrbitDB
   * OpLog. Publish is best-effort (never fails the flush).
   *
   * Tests and specialised deployments can opt out with `false`.
   */
  readonly ipnsSnapshot?: boolean;
  /** Enable debug logging (default: false) */
  readonly debug?: boolean;
}

// =============================================================================
// UxfBundleRef — Per-Bundle Reference (Section 2.3)
// =============================================================================

/**
 * Reference to a single UXF bundle stored as a CAR file on IPFS.
 * Each bundle is stored as a separate OrbitDB key: `tokens.bundle.{CID}`.
 * Two devices writing different bundles never conflict because they write
 * to different keys.
 *
 * See PROFILE-ARCHITECTURE.md Section 2.3 for the multi-bundle model.
 */
export interface UxfBundleRef {
  /** CID of the UXF CAR file on IPFS */
  readonly cid: string;
  /**
   * Bundle lifecycle status.
   *
   *   - `active`     — JOIN walker includes this bundle.
   *   - `superseded` — older bundle subsumed by a consolidated one.
   *   - `unverified` — recovered from the aggregator pointer but the
   *                    CAR was not fetchable / verifiable at recovery
   *                    time. Excluded from JOIN until a subsequent
   *                    sync re-fetches and promotes to `active`.
   *                    Steelman defense: prevents a compromised
   *                    aggregator from poisoning the local bundle
   *                    index with un-fetchable CIDs. See
   *                    profile/profile-token-storage/lifecycle-
   *                    manager.ts:recoverFromAggregatorPointerBestEffort.
   */
  readonly status: 'active' | 'superseded' | 'unverified';
  /** Creation timestamp (Unix seconds) */
  readonly createdAt: number;
  /** Optional device identifier that created this bundle */
  readonly device?: string;
  /** CID of the consolidated bundle that includes this one (set when superseded) */
  readonly supersededBy?: string;
  /** Unix seconds -- when to remove this entry from the Profile (after safety period) */
  readonly removeFromProfileAfter?: number;
  /** Number of tokens in this bundle (for quick display without fetching CAR) */
  readonly tokenCount?: number;
  /**
   * Issue #367 — pointer CID of the lean-snapshot blob that placed this
   * bundle ref into the local OrbitDB store via a snapshot-apply dispatch.
   *
   * Set ONLY when the writer that landed the ref was the snapshot
   * dispatcher's `writeRemote` path inside `BundleIndex.joinSnapshot`.
   * Unset (undefined) on:
   *   - locally-published bundles written via `BundleIndex.addBundle`;
   *   - bundles arriving via OrbitDB cross-device pubsub replication
   *     (which doesn't flow through the snapshot dispatcher);
   *   - legacy bundle refs persisted before this field existed.
   *
   * Read by `load()`'s Rule-4 pairwise gate: when every active bundle's
   * `sourcedFromSnapshotPointerCid` is non-null AND identical, the load
   * is sourced from a single trusted snapshot blob and Rule-4 enrichment
   * can be skipped (the snapshot producer's local merge already resolved
   * any siblings before publication). Any non-snapshot bundle in the
   * active set forces Rule-4 to run.
   */
  readonly sourcedFromSnapshotPointerCid?: string;
}

// =============================================================================
// Consolidation State
// =============================================================================

/**
 * State written to OrbitDB as `consolidation.pending` during a consolidation
 * operation. Used for crash recovery and concurrent consolidation guards.
 *
 * See PROFILE-ARCHITECTURE.md Section 2.3 (Crash recovery for consolidation).
 */
export interface ConsolidationPendingState {
  /** CIDs of the source bundles being consolidated */
  readonly sourceCids: readonly string[];
  /** Timestamp when consolidation started (Unix seconds) */
  readonly startedAt: number;
  /** Device identifier performing the consolidation */
  readonly device: string;
}

// =============================================================================
// Migration Types (Section 7.6)
// =============================================================================

/**
 * Phases of the legacy-to-Profile migration.
 * Migration tracks progress via a local-only `migration.phase` key
 * for crash recovery and resume.
 */
export type MigrationPhase =
  | 'syncing'
  | 'transforming'
  | 'persisting'
  | 'verifying'
  | 'cleaning'
  | 'complete';

/**
 * Result of a completed migration operation.
 */
export interface MigrationResult {
  /** Whether the migration completed successfully */
  readonly success: boolean;
  /** Number of storage keys migrated */
  readonly keysMigrated: number;
  /** Number of tokens migrated */
  readonly tokensMigrated: number;
  /** Number of per-address scopes migrated */
  readonly addressesMigrated: number;
  /** Duration of the migration in ms */
  readonly durationMs: number;
  /** Error message if migration failed */
  readonly error?: string;
  /** Phase at which migration failed (if applicable) */
  readonly failedAtPhase?: MigrationPhase;
}

// =============================================================================
// Encryption Configuration (Section 9.1)
// =============================================================================

/**
 * Encryption configuration for Profile values.
 * All OrbitDB values and CAR files are encrypted with a key derived
 * from the wallet master key via HKDF.
 *
 * profileEncryptionKey = HKDF(masterKey, "uxf-profile-encryption", 32)
 */
export interface ProfileEncryptionConfig {
  /** Whether encryption is enabled (default: true) */
  readonly enabled: boolean;
  /** HKDF info string used for key derivation */
  readonly hkdfInfo: string;
  /** Derived key length in bytes */
  readonly keyLengthBytes: number;
  /** AES-GCM IV length in bytes */
  readonly ivLengthBytes: number;
}

/** Default encryption configuration */
export const DEFAULT_ENCRYPTION_CONFIG: ProfileEncryptionConfig = {
  enabled: true,
  hkdfInfo: 'uxf-profile-encryption',
  keyLengthBytes: 32,
  ivLengthBytes: 12,
} as const;

// =============================================================================
// Provider Options
// =============================================================================

/**
 * Options for constructing a ProfileStorageProvider.
 * The provider wraps a local cache (IndexedDB or file-based) with
 * an OrbitDB-backed persistence layer.
 */
export interface ProfileStorageProviderOptions {
  /** Profile configuration */
  readonly config: ProfileConfig;
  /** Enable encryption of OrbitDB values (default: true) */
  readonly encrypt?: boolean;
  /** Encryption configuration overrides */
  readonly encryptionConfig?: Partial<ProfileEncryptionConfig>;
  /**
   * Oracle provider used by the aggregator pointer layer (Phase D wiring).
   * The pointer layer consumes `getAggregatorClient()` and `getRootTrustBase()`
   * from this instance — the same oracle passed to L4 / `PaymentsModule` so
   * the embedded `RootTrustBase` is shared (SPEC §8.4.2 H6).
   */
  readonly oracle?: OracleProvider;
  /** Enable debug logging */
  readonly debug?: boolean;
}

/**
 * Options for constructing a ProfileTokenStorageProvider.
 * The provider bridges TxfStorageData (PaymentsModule format)
 * and UXF bundles stored as encrypted CAR files on IPFS.
 */
export interface ProfileTokenStorageProviderOptions {
  /** Profile configuration */
  readonly config: ProfileConfig;
  /** Address identifier for per-address scoping */
  readonly addressId: string;
  /** Enable encryption of CAR files (default: true) */
  readonly encrypt?: boolean;
  /** Encryption configuration overrides */
  readonly encryptionConfig?: Partial<ProfileEncryptionConfig>;
  /** Write-behind debounce window in ms (default: 2000) */
  readonly flushDebounceMs?: number;
  /**
   * Oracle provider used by the aggregator pointer layer (Phase D wiring).
   * Forwarded from the Profile factory. See ProfileStorageProviderOptions.
   */
  readonly oracle?: OracleProvider;
  /**
   * Lazy accessor for the aggregator pointer layer owned by the
   * companion `ProfileStorageProvider`. The pointer layer is
   * constructed asynchronously after Phase B OrbitDB attach, so at
   * factory-time it does not exist yet — callers pass a closure that
   * reads `storage.getPointerLayer()` on demand. Returns `null` when
   * the pointer is unavailable (no oracle, BLOCKED state, storage not
   * durable, etc.); consumers fall back to the legacy IPNS path.
   *
   * Optional during rollout. When absent, token storage runs in the
   * pre-pointer mode (IPNS-only cold-start recovery).
   */
  readonly getPointerLayer?: () => ProfilePointerLayer | null;
  /**
   * Optional accessor for the storage provider's pointer-build status.
   * Used by `recoverFromAggregatorPointerBestEffort` to distinguish:
   *   - 'pending'      — a build is in flight; caller should wait.
   *   - 'unavailable'  — no oracle wired or build deterministically skipped;
   *                      caller falls through to legacy IPNS migration
   *                      WITHOUT polling further.
   *   - 'ready'        — pointer layer is constructed (`getPointerLayer()`
   *                      already returns non-null).
   *
   * Without this accessor the lifecycle manager has to time-bound its
   * poll, which conflates "still building (slow CI)" with "build will
   * never produce one" — leading to spurious legacy-IPNS fallbacks that
   * fork the pointer history. Optional during rollout.
   */
  readonly getPointerBuildStatus?: () => 'pending' | 'unavailable' | 'ready';
  /**
   * Item #15 Phase C.2 — host-injected debounced handler for
   * "profile state changed" signals.
   *
   * Every per-writer mutation (OUTBOX, SENT, finalization queue,
   * recipient context, bundle index) and every JOIN-applied remote
   * change calls into the provider's `notifyProfileDirty()` method
   * (also exposed via the host interface). The provider debounces
   * these notifications over `dirtyFlushDebounceMs` and, when the
   * timer fires, invokes this callback.
   *
   * The natural caller (Sphere / pointer wiring) implements the
   * callback to:
   *   1. Build a lean profile snapshot via `buildLeanProfileSnapshot()`.
   *   2. Pin the snapshot CAR to IPFS.
   *   3. Publish the snapshot CID via the aggregator pointer layer.
   *
   * Optional. When omitted, `notifyProfileDirty()` is a no-op — the
   * Phase B sync writers stay wired but no aggregator-pointer
   * publication happens for non-token-bundle state. This is the
   * default during Phase C rollout; Phase D/E land the full pipeline.
   *
   * Errors thrown by the callback are caught and surfaced via a
   * `storage:error` event with `code: 'PROFILE_DIRTY_FLUSH_FAILED'`.
   * They do NOT propagate into write paths — dirty signalling is
   * best-effort by design.
   */
  readonly onProfileDirtyFlush?: () => Promise<void | ProfileSnapshotPublishResult>;
  /**
   * Item #15 Phase E follow-up — host-injected pull-side snapshot
   * applier. Counterpart to `onProfileDirtyFlush` (which publishes a
   * snapshot CID); this callback consumes a snapshot CID:
   *
   *   1. Fetch the CAR for `cidString` from the configured IPFS
   *      gateways (content-address verified by the fetcher).
   *   2. Parse it as a {@link LeanProfileSnapshot}.
   *   3. Dispatch per-writer JOIN over the parsed snapshot via the
   *      same factory closure that backs
   *      `ProfileStorageProvider.setSnapshotApplier`.
   *
   * Used by `LifecycleManager.runPointerPollOnce` and
   * `recoverFromAggregatorPointerBestEffort` so the periodic-poll and
   * cold-start recovery paths consume the pointer's CID as a snapshot
   * (Item #15) rather than calling `bundleIndex.addBundle()` on the
   * snapshot CID and corrupting the bundle index. The legacy
   * `addBundle` path was a latent bug: under Item #15 the pointer's
   * CID is a snapshot CID, not a UXF bundle CID, so the next `load()`
   * would try to parse the snapshot CAR as a UXF package and fail.
   *
   * Optional. When omitted, lifecycle's pointer paths log and skip
   * (no legacy fallback per Phase E — silent re-write of the snapshot
   * CID as a bundle ref is precisely the bug this option fixes).
   *
   * Errors thrown by the callback propagate to the lifecycle caller's
   * outer try/catch and are logged + re-armed on the next periodic
   * cycle. The pointer cursor is NOT advanced by this path — cursor
   * advancement remains owned by the reconcile-loop's `fetchAndJoin`
   * callback in `pointer-wiring.ts`.
   */
  readonly onApplySnapshot?: (
    cidString: string,
  ) => Promise<import('./profile-snapshot-dispatcher').ApplySnapshotResult>;
  /**
   * Item #15 Phase C.2 — debounce window for `notifyProfileDirty`
   * signals. Defaults to `flushDebounceMs` (2000ms). Set lower for
   * tests; higher for high-write-volume wallets where the natural
   * flush cadence is already the throttle.
   */
  readonly dirtyFlushDebounceMs?: number;
  /**
   * Issue #239 — per-flush remote-durability verification deadline (ms).
   *
   * After every successful `flushToIpfs` body (pin + bundle ref +
   * snapshot publish), the provider HEAD-verifies the just-pinned CIDs
   * against the configured IPFS gateways AND polls the aggregator
   * `recoverLatest()` until it returns the just-published snapshot CID.
   * The verification gate gives the at-least-once invariant teeth
   * across cross-process and cross-device recovery: a Nostr-delivered
   * token is only ack'd after its containing bundle is **verifiably**
   * fetchable by other peers (closes the cross-process invoice loss
   * documented in #234 / #239).
   *
   * Default when constructed via `createProfileProviders`: **30 000**
   * (production contract). Default when the provider is constructed
   * directly without the factory: **0** (off) — this keeps legacy
   * tests that wire stub pointers + mock IPFS gateways from hanging
   * on HEAD retries against bogus URLs. Callers that want the per-
   * flush contract on a directly-constructed provider must pass an
   * explicit value here.
   *
   * Set to `0` to disable per-flush verification entirely (tests, dev
   * mode, or operators who prefer the shutdown-only gate). Verification
   * is also automatically skipped when no pointer layer is wired (no
   * cross-device recovery surface exists to verify).
   */
  readonly flushVerificationDeadlineMs?: number;
  /**
   * Issue #330 — inline durability gate on `publishAggregatorPointerBestEffort`.
   * See `ProfileConfig.pointerPublishDurabilityGateMs` for full semantics.
   *
   * Default when constructed via `createProfileProviders`: **5 000** (5s,
   * production contract; closes the #330 cross-device gap where the
   * pointer can advertise a CID that the operator gateway hasn't yet
   * propagated). Default when the provider is constructed directly
   * without the factory: **0** (off) — same compatibility rationale as
   * `flushVerificationDeadlineMs`.
   *
   * Set to `0` to disable inline gate entirely; the background verifier
   * (`flushVerificationDeadlineMs`) still runs and emits
   * `storage:durability-deferred` on failure.
   */
  readonly pointerPublishDurabilityGateMs?: number;
  /** Enable debug logging */
  readonly debug?: boolean;
}

// =============================================================================
// ProfileDatabase Interface (OrbitDB Wrapper)
// =============================================================================

/**
 * Abstract interface for the OrbitDB key-value database.
 * Implemented by the OrbitDB adapter (WU-P03). The rest of the Profile
 * system never imports @orbitdb/core directly -- it uses this interface.
 *
 * Two write/read APIs coexist during the OpLog-schema migration
 * (PROFILE-OPLOG-SCHEMA.md §7):
 *   - Legacy opaque-bytes: `put(key, Uint8Array)` / `get(key)`
 *   - Structured envelope: `putEntry(key, OpLogEntryEnvelope)` / `getEntry(key)`
 * Callers migrate one module at a time. `getEntry` auto-wraps legacy
 * opaque bytes in a synthetic envelope, so a partial migration reads cleanly.
 */
export interface ProfileDatabase {
  /**
   * Open the database connection.
   * Creates Helia instance, OrbitDB instance, and opens the KV database
   * with a deterministic address derived from the wallet key.
   */
  connect(config: OrbitDbConfig): Promise<void>;

  /** Write a value (encrypted bytes) to the database. */
  put(key: string, value: Uint8Array): Promise<void>;

  /** Read a value by key. Returns null if the key does not exist. */
  get(key: string): Promise<Uint8Array | null>;

  /** Delete a key from the database. */
  del(key: string): Promise<void>;

  /**
   * Return all entries, optionally filtered by key prefix.
   * Used for listing `tokens.bundle.*` keys.
   *
   * **Round 5 (FIX 3) — `maxResults` cap.** Backends MAY accept an
   * optional `maxResults` cap to short-circuit iteration once that many
   * matching entries have been buffered. Without the cap, a hostile peer
   * planting millions of crafted prefix matches forces unbounded
   * materialization at the OrbitDB layer (the cap on the
   * disposition-storage adapter only bounds DECRYPT calls — the
   * underlying map is still fully populated). Backends that don't
   * support short-circuiting MAY ignore the cap (returning the full
   * matching set, as before) — callers MUST treat the cap as a request,
   * not a guarantee. The returned Map size MAY exceed the cap; the
   * caller still applies its own cap on the result.
   */
  all(
    prefix?: string,
    opts?: { readonly maxResults?: number },
  ): Promise<Map<string, Uint8Array>>;

  /** Close the database, Helia, and libp2p connections. */
  close(): Promise<void>;

  /**
   * Subscribe to replication events (new data arriving from peers).
   * Returns an unsubscribe function.
   */
  onReplication(callback: () => void): () => void;

  /** Whether `connect()` has been called and `close()` has not. */
  isConnected(): boolean;

  /**
   * Issue #236 — Local Helia accessor (read-only). Exposes the underlying
   * Helia IPFS node so callers (the Profile token-storage layer's pin and
   * fetch paths) can use the local on-disk blockstore as the primary CAR
   * store, treating HTTP IPFS gateways as best-effort replication.
   *
   * Returns the Helia handle on a connected adapter, or `null` when the
   * adapter has not been connected, has been closed, or the implementation
   * does not run a local Helia node. Typed as `unknown` so the public
   * interface does not leak `helia` types — consumers cast to a minimal
   * structural shape (`{ blockstore: { get, put, has } }`).
   *
   * Optional in the interface so legacy adapters that pre-date issue #236
   * (or test stubs) remain compatible — callers MUST treat a missing
   * accessor as equivalent to `null` and fall back to HTTP gateways for
   * both pin and fetch.
   */
  getHelia?(): unknown | null;

  /**
   * Write a structured OpLog entry envelope (PROFILE-OPLOG-SCHEMA.md §5).
   * Type is imported lazily via `import type` elsewhere; declared as
   * `unknown` here to avoid a circular types dependency.
   */
  putEntry?(key: string, entry: unknown): Promise<void>;

  /**
   * Read a structured OpLog entry envelope. Auto-wraps legacy opaque
   * bytes in a synthetic envelope (§7.1). Returns null if key absent.
   *
   * SECURITY DEFAULT: returned envelope's `originated` is forced to
   * `'replicated'` UNLESS caller passes `trustLocalClaim: true` AND the
   * key was written by a local putEntry in this session. Prevents peer-
   * forged `'user'`/`'system'` tags from leaking into local state (§5.2).
   *
   * @param opts.downgradeAsReplicated  — Legacy flag: force downgrade
   *   regardless. Kept for backward compat; new callers use the default.
   * @param opts.trustLocalClaim  — When true, returns the stored tag
   *   verbatim IF the key is known to be locally-authored. Otherwise
   *   still downgrades.
   */
  getEntry?(
    key: string,
    opts?: { downgradeAsReplicated?: boolean; trustLocalClaim?: boolean },
  ): Promise<unknown | null>;
}

// =============================================================================
// Sync Events
// =============================================================================

/** Types of sync events emitted by the Profile system. */
export type SyncEventType =
  | 'sync:started'
  | 'sync:completed'
  | 'sync:failed'
  | 'sync:remote-updated'
  | 'sync:bundle-added'
  | 'sync:bundle-removed';

/** Callback for sync events. */
export type SyncEventCallback = (event: {
  readonly type: SyncEventType;
  readonly timestamp: number;
  readonly detail?: unknown;
}) => void;

// =============================================================================
// Key Mapping Types and Constants (Section 5.2)
// =============================================================================

/**
 * Type-safe mapping entry from legacy storage key to Profile key name.
 * The `dynamic` flag indicates keys that require pattern-based transformation
 * (e.g., per-address keys with address ID substitution).
 */
export interface ProfileKeyMapEntry {
  /** The Profile key name (dot-notation) */
  readonly profileKey: string;
  /** Whether this key requires dynamic address ID substitution */
  readonly dynamic: boolean;
}

/**
 * Type-safe mapping of legacy storage keys to Profile key names.
 */
export type ProfileKeyMap = Readonly<Record<string, ProfileKeyMapEntry>>;

/**
 * Complete key mapping table from Section 5.2.
 * Maps legacy storage key names (without the `sphere_` prefix) to Profile key names.
 *
 * Global keys map directly. Per-address keys use `{addr}` as a placeholder
 * that is replaced at runtime with the actual address ID.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SCHEMA-vs-RUNTIME contract for per-entry-key collections (W46)
 * ─────────────────────────────────────────────────────────────────────────
 * `PROFILE_KEY_MAPPING` declares LOGICAL keys (a static schema). The
 * per-entry-key collections — `outbox`, `mintOutbox`, `audit`, `invalid`,
 * `finalizationQueue` — expand at runtime into composite keys of the form
 * `${addr}.<collection>.${id}` (and, for multi-rep collections like
 * `invalid` and `audit`, further composite ids of the form
 * `${tokenId}.${observedTokenContentHash}`). The static `outbox` /
 * `audit` / `invalid` / etc. logical keys NEVER appear at runtime — they
 * are emitted by the per-entry-key writer in
 * `profile-token-storage-provider.ts` and consumed by the matching reader.
 *
 * **`Sphere.clear()` reaches per-entry-key collections via parent
 * storage clear (prefix-scan-and-delete), NOT via the mapping table.**
 * This is intentional: adding new per-entry-key collections does NOT
 * require touching `Sphere.clear()`. The path is
 *   Sphere.clear() -> StorageProvider.clear() -> wipe ALL `${addr}.*`
 *   keys (including all `${addr}.<collection>.${id}` per-entry records)
 *
 * The legacy `invalidTokens` entry is retained for the one-way migration
 * window (see `profile/migration.ts::migrateInvalidTokensToPerEntryKey`);
 * it converts each legacy single-record entry into a per-entry-key form
 * `${addr}.invalid.${tokenId}.legacy-${tokenId}` (synthetic
 * `observedTokenContentHash`). The migration is additive — it never
 * overwrites a real per-entry-key entry that may have been written by a
 * later wave (T.3.B, etc.) before the migration ran.
 */
export const PROFILE_KEY_MAPPING: ProfileKeyMap = {
  // --- Global identity keys ---
  'mnemonic': { profileKey: 'identity.mnemonic', dynamic: false },
  'master_key': { profileKey: 'identity.masterKey', dynamic: false },
  'chain_code': { profileKey: 'identity.chainCode', dynamic: false },
  'derivation_path': { profileKey: 'identity.derivationPath', dynamic: false },
  'base_path': { profileKey: 'identity.basePath', dynamic: false },
  'derivation_mode': { profileKey: 'identity.derivationMode', dynamic: false },
  'wallet_source': { profileKey: 'identity.walletSource', dynamic: false },
  'wallet_exists': { profileKey: 'wallet_exists', dynamic: false }, // local-only fast-path flag
  'current_address_index': { profileKey: 'identity.currentAddressIndex', dynamic: false },

  // --- Global address keys ---
  'address_nametags': { profileKey: 'addresses.nametags', dynamic: false },
  'tracked_addresses': { profileKey: 'addresses.tracked', dynamic: false },

  // --- Global transport keys ---
  // Note: last_wallet_event_ts_{pubkey} and last_dm_event_ts_{pubkey} are dynamic
  // and handled by IPFS_STATE_KEYS_PATTERN + dynamic mapping logic, not here.
  'group_chat_relay_url': { profileKey: 'groupchat.relayUrl', dynamic: false },

  // --- Cache-only keys (stored in CACHE_ONLY_KEYS, NOT in OrbitDB) ---
  'token_registry_cache': { profileKey: 'tokens.registryCache', dynamic: false },
  'token_registry_cache_ts': { profileKey: 'tokens.registryCacheTs', dynamic: false },
  'price_cache': { profileKey: 'prices.cache', dynamic: false },
  'price_cache_ts': { profileKey: 'prices.cacheTs', dynamic: false },

  // --- Per-address keys (dynamic: address ID prefix) ---
  'pending_transfers': { profileKey: '{addr}.pendingTransfers', dynamic: true },
  'outbox': { profileKey: '{addr}.outbox', dynamic: true },
  'conversations': { profileKey: '{addr}.conversations', dynamic: true },
  'messages': { profileKey: '{addr}.messages', dynamic: true },
  'transaction_history': { profileKey: '{addr}.transactionHistory', dynamic: true },
  'pending_v5_tokens': { profileKey: '{addr}.pendingV5Tokens', dynamic: true },
  'group_chat_groups': { profileKey: '{addr}.groupchat.groups', dynamic: true },
  'group_chat_messages': { profileKey: '{addr}.groupchat.messages', dynamic: true },
  'group_chat_members': { profileKey: '{addr}.groupchat.members', dynamic: true },
  'group_chat_processed_events': { profileKey: '{addr}.groupchat.processedEvents', dynamic: true },
  'processed_split_group_ids': { profileKey: '{addr}.processedSplitGroupIds', dynamic: true },
  'processed_combined_transfer_ids': { profileKey: '{addr}.processedCombinedTransferIds', dynamic: true },

  // --- Per-address accounting keys ---
  'cancelled_invoices': { profileKey: '{addr}.accounting.cancelledInvoices', dynamic: true },
  'closed_invoices': { profileKey: '{addr}.accounting.closedInvoices', dynamic: true },
  'frozen_balances': { profileKey: '{addr}.accounting.frozenBalances', dynamic: true },
  'auto_return': { profileKey: '{addr}.accounting.autoReturn', dynamic: true },
  'auto_return_ledger': { profileKey: '{addr}.accounting.autoReturnLedger', dynamic: true },
  'inv_ledger_index': { profileKey: '{addr}.accounting.invLedgerIndex', dynamic: true },
  'token_scan_state': { profileKey: '{addr}.accounting.tokenScanState', dynamic: true },

  // --- Per-address swap keys ---
  'swap_index': { profileKey: '{addr}.swap.index', dynamic: true },
  // Note: {addr}_swap:{swapId} is handled by dynamic pattern matching, not a static entry.

  // --- Per-address operational keys (stored in OrbitDB due to criticality) ---
  'mintOutbox': { profileKey: '{addr}.mintOutbox', dynamic: true },
  /**
   * @deprecated Legacy single-blob form retained for one-way migration
   * (see profile/migration.ts::migrateInvalidTokensToPerEntryKey). New
   * writes go to the per-entry-key prefix below (`invalid`). This entry
   * SHOULD be removed in T.8.D once the migration window closes.
   */
  'invalidTokens': { profileKey: '{addr}.invalidTokens', dynamic: true },
  'invalidatedNametags': { profileKey: '{addr}.invalidatedNametags', dynamic: true },
  'tombstones': { profileKey: '{addr}.tombstones', dynamic: true },

  // --- UXF inter-wallet transfer protocol per-entry-key collections
  //     (T.0.G7-fill-gaps + T.1.E). Each entry expands at runtime into
  //     `${addr}.<collection>.<id>` records via the per-entry-key
  //     writer in profile-token-storage-provider.ts. The `id` form is
  //     treated as opaque by the writer — T.1.E declares the specific
  //     composite-id shapes:
  //       - `audit`:   `${tokenId}.${observedTokenContentHash}`
  //       - `invalid`: `${tokenId}.${observedTokenContentHash}`
  //                    (legacy `invalidTokens` migrates to
  //                    `${tokenId}.legacy-${tokenId}`)
  //       - `finalizationQueue`: `${requestId}` (single-rep)
  //
  // These static keys NEVER appear at runtime on their own — the writer
  // expands them into per-entry-key composites. The mapping is here so
  // (a) reverse-lookups and (b) tooling that scans the schema know the
  // collection exists. `Sphere.clear()` reaches every per-entry-key
  // record via parent-storage prefix wipe (W46) — see the contract
  // block at the top of this constant.
  'audit': { profileKey: '{addr}.audit', dynamic: true },
  'invalid': { profileKey: '{addr}.invalid', dynamic: true },
  'finalizationQueue': { profileKey: '{addr}.finalizationQueue', dynamic: true },

  // Issue #97 — SENT ledger. Per-entry-key records of successfully
  // delivered bundles, keyed `${addr}.sent.${id}` (one entry per
  // delivery; id matches the outbox transferId). Used by the crash-
  // recovery sweeper to distinguish "already delivered" from "needs
  // re-queue to OUTBOX". See profile/sent-ledger-writer.ts.
  'sent': { profileKey: '{addr}.sent', dynamic: true },
} as const;

/**
 * Keys that are stored ONLY in the local cache, never written to OrbitDB.
 *
 * Two distinct reasons land a key here:
 *
 * 1. **External-API caches** (`token_registry_*`, `price_*`) — regenerated
 *    from network calls; replicating wastes OpLog bytes and stale entries
 *    on one device can poison a cross-device read.
 *
 * 2. **Identity / seed material** (the IDENTITY_KEYS block) —
 *    *security boundary*. OrbitDB content is replicated to IPFS (the
 *    snapshot CAR is pinned by the user's own pin gateway *and*, in
 *    practice, observable by any peer the pubsub topic reaches). Even
 *    when wrapped by the password-derived `encrypt()`, distributing the
 *    encrypted seed lowers the threat model from "attacker must
 *    compromise the device" to "attacker must brute-force a password
 *    against an IPFS-pinned ciphertext". The seed MUST stay
 *    device-local; the only legitimate cross-device transport for the
 *    seed is the user's own BIP-39 mnemonic backup. Audit #333 C1 was
 *    interpreted as "encrypt before OrbitDB write" — that defense holds
 *    only during Phase A (no key derived → `encrypt()` throws); any
 *    post-Phase-A rewrite of an identity key would otherwise succeed
 *    encrypted and leak. Mark them cache-only so the write short-
 *    circuits at the localCache step in `ProfileStorageProvider.set()`.
 *
 * See PROFILE-ARCHITECTURE.md Section 2.1 "Cache-only keys".
 */
export const CACHE_ONLY_KEYS: ReadonlySet<string> = new Set([
  // External-API caches (regenerated from network)
  'token_registry_cache',
  'token_registry_cache_ts',
  'price_cache',
  'price_cache_ts',

  // Identity / seed material — NEVER replicate via OrbitDB/IPFS.
  // Keep this list in sync with IDENTITY_KEYS below.
  'mnemonic',
  'master_key',
  'chain_code',
  'derivation_path',
  'base_path',
  'derivation_mode',
  'wallet_source',
  // `current_address_index` is the active HD slot pointer. Could be cross-
  // device synced in principle, but on a fresh-device boot the address-
  // discovery walker re-derives it from the mnemonic anyway; keeping it
  // device-local removes one more identity-shaped key from the OpLog.
  'current_address_index',
]);

/**
 * The identity / seed-material keys. Listed separately so other modules
 * (migration, audits, tests) can refer to "the identity class" without
 * coupling to the full CACHE_ONLY_KEYS list.
 *
 * Every key here MUST also appear in CACHE_ONLY_KEYS.
 */
export const IDENTITY_KEYS: ReadonlySet<string> = new Set([
  'mnemonic',
  'master_key',
  'chain_code',
  'derivation_path',
  'base_path',
  'derivation_mode',
  'wallet_source',
  'current_address_index',
]);

/**
 * Regex pattern matching IPFS/IPNS state keys that are obsoleted by OrbitDB.
 * These keys are consumed during migration but NOT carried forward to the Profile.
 *
 * Matches: sphere_ipfs_seq_*, sphere_ipfs_cid_*, sphere_ipfs_ver_*
 * (After prefix stripping: ipfs_seq_*, ipfs_cid_*, ipfs_ver_*)
 */
export const IPFS_STATE_KEYS_PATTERN: RegExp = /^ipfs_(seq|cid|ver)_/;

// =============================================================================
// Address ID Utility
// =============================================================================

/**
 * Compute a short address ID from a DIRECT:// address string.
 * Format: `DIRECT_{first6}_{last6}` (lowercase hex).
 *
 * This matches the address ID format used by sphere-sdk's storage layer
 * for per-address key scoping.
 *
 * @param directAddress - A DIRECT:// address (e.g. `DIRECT://AABBCC...DDEEFF`)
 * @returns Short address ID (e.g. `DIRECT_aabbcc_ddeeff`)
 */
export function computeAddressId(directAddress: string): string {
  // Accept both `DIRECT://` and degenerate `DIRECT:` prefixes. The former is
  // canonical; the latter appears in some legacy/profile code paths.
  let clean: string;
  if (directAddress.startsWith('DIRECT://')) {
    clean = directAddress.slice(9);
  } else if (directAddress.startsWith('DIRECT:')) {
    clean = directAddress.slice(7);
  } else {
    clean = directAddress;
  }
  const first6 = clean.slice(0, 6).toLowerCase();
  const last6 = clean.slice(-6).toLowerCase();
  return `DIRECT_${first6}_${last6}`;
}
