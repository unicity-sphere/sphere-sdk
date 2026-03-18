/**
 * Swap Module
 *
 * Orchestrates two-party atomic currency swaps within a Sphere wallet.
 * Coordinates the swap lifecycle — proposal negotiation, escrow interaction,
 * deposit payment, and payout verification — using DM messaging between
 * counterparties and the escrow service, backed by AccountingModule invoices.
 *
 * This module is a CLIENT of the escrow service: it does not hold funds,
 * compute coverage, or execute payouts. Those responsibilities belong to the
 * escrow service. The module manages the wallet-side state machine, DM protocol,
 * and local persistence.
 *
 * @see docs/SWAP-SPEC.md
 */

import { logger } from '../../core/logger.js';
import { SphereError } from '../../core/errors.js';
import { AsyncGateMap } from '../../core/async-gate.js';
import { STORAGE_KEYS_ADDRESS, getAddressStorageKey } from '../../constants.js';
import { assertTransition, isTerminalProgress, mapEscrowStateToProgress } from './state-machine.js';
import {
  parseSwapDM,
  isSwapDM,
  buildProposalDM,
  buildProposalDM_v2,
  buildAcceptanceDM,
  buildAcceptanceDM_v2,
  buildRejectionDM,
  buildAnnounceDM,
  buildStatusQueryDM,
  buildCancelDM,
} from './dm-protocol.js';
import {
  computeSwapId,
  buildManifest,
  validateManifest,
  verifyManifestIntegrity,
  signSwapManifest,
  verifySwapSignature,
  createNametagBinding,
  verifyNametagBinding,
} from './manifest.js';
import {
  resolveEscrowAddress,
  sendAnnounce,
  sendAnnounce_v2,
  sendStatusQuery,
  sendRequestInvoice,
  withRetry,
} from './escrow-client.js';
import type { TransferResult } from '../../types/index.js';
import type {
  SwapModuleConfig,
  SwapModuleDependencies,
  SwapRef,
  SwapProgress,
  SwapDeal,
  SwapManifest,
  SwapProposalResult,
  ProposeSwapOptions,
  GetSwapStatusOptions,
  GetSwapsFilter,
  SwapStorageData,
  SwapIndexEntry,
  ManifestAuxiliary,
  ManifestSignatures,
} from './types.js';

// Logger tag
const LOG_TAG = 'Swap';

/** Default proposal timeout: 5 minutes. */
const DEFAULT_PROPOSAL_TIMEOUT_MS = 300_000;

/** Default max pending (non-terminal) swaps. */
const DEFAULT_MAX_PENDING_SWAPS = 100;

/** Default announce timeout: 30 seconds. */
const DEFAULT_ANNOUNCE_TIMEOUT_MS = 30_000;

/** Default terminal purge TTL: 7 days. */
const DEFAULT_TERMINAL_PURGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Grace period added to local timeout over escrow timeout: 30 seconds. */
const LOCAL_TIMEOUT_GRACE_MS = 30_000;

export class SwapModule {
  // =========================================================================
  // Private fields
  // =========================================================================
  private config: Required<Pick<SwapModuleConfig, 'debug' | 'proposalTimeoutMs' | 'maxPendingSwaps' | 'announceTimeoutMs' | 'terminalPurgeTtlMs'>> & Pick<SwapModuleConfig, 'defaultEscrowAddress'>;
  private deps: SwapModuleDependencies | null = null;
  private swaps: Map<string, SwapRef> = new Map();
  /** Set of swap IDs that have reached terminal state (completed/cancelled/failed).
   * Used to reject replayed proposal DMs for swaps that were already processed.
   * Populated during loadFromStorage and updated on terminal transitions. */
  private terminalSwapIds: Set<string> = new Set();
  /** Terminal index entries loaded from storage — preserved so persistIndex()
   * can merge them back (terminal swaps are NOT in this.swaps). */
  private _storedTerminalEntries: SwapIndexEntry[] = [];
  private _gateMap = new AsyncGateMap();
  private localTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** AbortControllers for in-progress sendAnnounce_v2 calls, keyed by swapId.
   * Cancelled/rejected swaps abort these to stop retry loops immediately. */
  private announceAbortControllers: Map<string, AbortController> = new Map();
  /** Tracks swaps for which we already emitted swap:completed(payoutVerified:false).
   * Prevents returnFalse() from emitting duplicate events on repeated verifyPayout calls. */
  private _completedEventEmittedUnverified: Set<string> = new Set();
  private invoiceToSwapIndex: Map<string, string> = new Map(); // invoiceId -> swapId
  private destroyed = false;
  private loaded = false;
  private _loading = false;
  private _loadingDeferred: { resolve: () => void; promise: Promise<void> } | null = null;
  private loadPromise: Promise<void> | null = null;
  private dmUnsubscribe: (() => void) | null = null;
  private invoiceEventUnsubs: (() => void)[] = [];

  // =========================================================================
  // Constructor
  // =========================================================================

  /**
   * Create a SwapModule instance.
   * Stores configuration only. No I/O, no subscriptions, no storage access.
   * The module is inert until `initialize()` and `load()` are called.
   *
   * @param config - Optional module configuration. Defaults are applied for all fields.
   */
  constructor(config?: SwapModuleConfig) {
    this.config = {
      debug: config?.debug ?? false,
      defaultEscrowAddress: config?.defaultEscrowAddress,
      proposalTimeoutMs: config?.proposalTimeoutMs ?? DEFAULT_PROPOSAL_TIMEOUT_MS,
      maxPendingSwaps: config?.maxPendingSwaps ?? DEFAULT_MAX_PENDING_SWAPS,
      announceTimeoutMs: config?.announceTimeoutMs ?? DEFAULT_ANNOUNCE_TIMEOUT_MS,
      terminalPurgeTtlMs: config?.terminalPurgeTtlMs ?? DEFAULT_TERMINAL_PURGE_TTL_MS,
    };
  }

  // =========================================================================
  // Lifecycle: initialize
  // =========================================================================

  /**
   * Inject dependencies into the module. Must be called before `load()`.
   * Calling `initialize()` again replaces the deps without resetting in-memory
   * state -- always call `load()` after re-initializing.
   *
   * @param deps - Module dependencies provided by Sphere.
   */
  initialize(deps: SwapModuleDependencies): void {
    // Reset destroyed flag so load() can proceed after destroy() + re-init
    // (e.g., switchToAddress() calls destroy() then initialize() then load()).
    this.destroyed = false;
    this.deps = deps;
    if (this.config.debug) {
      logger.debug(LOG_TAG, 'Initialized with dependencies');
    }
  }

  // =========================================================================
  // Lifecycle: load
  // =========================================================================

  /**
   * Load persisted state from storage and subscribe to event streams.
   *
   * Steps (per SWAP-SPEC section 3.4):
   * 1. Load persisted swap records from storage.
   * 2. Purge terminal swaps older than terminalPurgeTtlMs.
   * 3. Clean up stale proposals (proposer-side timeout).
   * 4. Register DM handler via CommunicationsModule.
   * 5. Subscribe to invoice events.
   * 6. Resume local timers.
   * 7. Rebuild invoiceToSwapIndex.
   * 8. Crash recovery actions per state.
   *
   * @throws {SphereError} `SWAP_NOT_INITIALIZED` if `initialize()` has not been called.
   * @throws {SphereError} `SWAP_MODULE_DESTROYED` if the module has been destroyed.
   */
  async load(): Promise<void> {
    this.ensureInitialized();
    this.ensureNotDestroyed();

    // Re-entry guard: if load() is already in progress, return the same promise.
    if (this.loadPromise) {
      return this.loadPromise;
    }
    // If _loading is true but loadPromise is null (brief window in finally block),
    // wait for the deferred signal that the completing load resolves.
    if (this._loading) {
      if (!this._loadingDeferred) {
        this._loadingDeferred = this._createDeferred();
      }
      await Promise.race([
        this._loadingDeferred.promise,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new SphereError('load() timed out waiting for prior load', 'SWAP_NOT_INITIALIZED')), 10_000),
        ),
      ]);
      // After the previous load completed, verify module is still alive.
      if (this.destroyed) {
        throw new SphereError('SwapModule has been destroyed.', 'SWAP_MODULE_DESTROYED');
      }
      return;
    }

    this._loading = true;
    this.loadPromise = this._doLoad();
    try {
      await this.loadPromise;
    } finally {
      this._loading = false;
      this.loadPromise = null;
      // Signal any waiters from the deferred pattern
      if (this._loadingDeferred) {
        this._loadingDeferred.resolve();
        this._loadingDeferred = null;
      }
    }
  }

  /** Create a deferred promise (resolve callable externally). */
  private _createDeferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
  }

  /**
   * Internal load implementation. Separated from load() to keep the
   * re-entry guard logic clean.
   */
  private async _doLoad(): Promise<void> {
    const deps = this.deps!;

    // Step 1: Clear in-memory state
    this.swaps.clear();
    this.terminalSwapIds.clear();
    this._storedTerminalEntries = [];
    this.invoiceToSwapIndex.clear();
    this._completedEventEmittedUnverified.clear();
    this.loaded = false;

    if (this.config.debug) {
      logger.debug(LOG_TAG, 'load() starting');
    }

    // Step 2: Load from storage
    await this.loadFromStorage();

    // Step 3: Clean up stale proposals (proposer-side timeout check)
    const now = Date.now();
    for (const swap of this.swaps.values()) {
      if (
        swap.progress === 'proposed' &&
        swap.role === 'proposer' &&
        now - swap.createdAt > this.config.proposalTimeoutMs
      ) {
        swap.progress = 'failed';
        swap.error = 'Proposal timed out';
        swap.updatedAt = now;
        await this.persistSwap(swap);
        // Track as terminal so replayed proposal DMs don't recreate it this session.
        // Also add to _storedTerminalEntries so subsequent persistIndex() calls (triggered
        // by other swap persists) include this entry — without it the record would be
        // dropped from the index once the cleanup loop removes the swap from this.swaps.
        this.terminalSwapIds.add(swap.swapId);
        this._storedTerminalEntries.push({
          swapId: swap.swapId,
          progress: 'failed',
          role: swap.role,
          createdAt: swap.createdAt,
        });
        if (this.config.debug) {
          logger.debug(LOG_TAG, `Proposal ${swap.swapId} timed out during load`);
        }
      }
    }

    // Remove failed proposals from in-memory map (they are terminal)
    for (const [swapId, swap] of this.swaps.entries()) {
      if (isTerminalProgress(swap.progress)) {
        this.swaps.delete(swapId);
      }
    }

    // Step 4: Register DM handler
    this.dmUnsubscribe = deps.communications.onDirectMessage((dm) => {
      this.handleIncomingDM(dm);
    });

    // Step 5: Subscribe to invoice events
    this.setupInvoiceEventSubscriptions();

    // Step 6: Rebuild invoiceToSwapIndex
    for (const swap of this.swaps.values()) {
      if (swap.depositInvoiceId) {
        this.invoiceToSwapIndex.set(swap.depositInvoiceId, swap.swapId);
      }
      if (swap.payoutInvoiceId) {
        this.invoiceToSwapIndex.set(swap.payoutInvoiceId, swap.swapId);
      }
    }

    // Step 7: Resume local timers
    this.resumeTimers();

    // Step 8: Crash recovery — per-state recovery actions (fire-and-forget)
    // Each recovery action is async and tolerates failures — the swap will
    // eventually be resolved by the escrow timeout or the next CLI sync.
    for (const swap of this.swaps.values()) {
      const swapRef = swap; // capture for async closure
      void (async () => {
        try {
          if (this.destroyed) return; // Module was destroyed before recovery started

          // Resolve escrow pubkey if not already stored (network call — outside gate)
          let escrowPubkey = swapRef.escrowPubkey;
          if (!escrowPubkey) {
            try {
              const resolved = await resolveEscrowAddress(swapRef.deal, this.config, deps.resolve);
              if (this.destroyed) return; // Destroyed while awaiting escrow resolution
              // Persist escrow info inside per-swap gate to prevent concurrent DM handler races
              await this.withSwapGate(swapRef.swapId, async () => {
                if (this.destroyed) return;
                swapRef.escrowPubkey = resolved.escrowPubkey;
                swapRef.escrowDirectAddress = resolved.escrowDirectAddress;
                await this.persistSwap(swapRef);
              });
              escrowPubkey = resolved.escrowPubkey;
            } catch {
              if (!this.destroyed) {
                logger.warn(LOG_TAG, `Crash recovery: cannot resolve escrow for swap ${swapRef.swapId.slice(0, 12)}`);
              }
              return;
            }
          }

          if (this.destroyed) return; // Check after all async operations

          // Recovery DM sends are pure outgoing messages — no swap state mutation.
          // No gate needed for sends; only the escrow resolution above was gated.
          switch (swapRef.progress) {
            case 'accepted':
              if (swapRef.protocolVersion === 2 && swapRef.role === 'proposer') {
                // v2 proposer: Bob already announced. Just send a status query.
                logger.debug(LOG_TAG, `v2 crash recovery: proposer waiting for announce_result ${swapRef.swapId.slice(0, 12)}`);
                await sendStatusQuery(deps.communications, escrowPubkey, swapRef.swapId);
                // Start bounded timer AFTER the status query is sent, and only if the swap
                // is still in 'accepted' state — a concurrent invoice_delivery DM may have
                // advanced it to 'announced' and started the local expiry timer.
                if (this.swaps.get(swapRef.swapId)?.progress === 'accepted') {
                  this.startAnnounceTimer(swapRef.swapId);
                }
              } else if (swapRef.protocolVersion === 2 && swapRef.role === 'acceptor') {
                // v2 acceptor: re-announce with v2 format (both signatures)
                logger.debug(LOG_TAG, `v2 crash recovery: re-announcing swap ${swapRef.swapId.slice(0, 12)}`);
                if (swapRef.proposerSignature && swapRef.acceptorSignature && swapRef.proposerChainPubkey) {
                  const activeAddresses = deps.getActiveAddresses();
                  const ourAddrs = new Set(activeAddresses.map(a => a.directAddress));
                  if (deps.identity.directAddress) ourAddrs.add(deps.identity.directAddress);
                  const weArePartyA = ourAddrs.has(swapRef.manifest.party_a_address);
                  const signatures: ManifestSignatures = {
                    party_a: weArePartyA ? swapRef.acceptorSignature : swapRef.proposerSignature,
                    party_b: weArePartyA ? swapRef.proposerSignature : swapRef.acceptorSignature,
                  };
                  const chainPubkeys = {
                    party_a: weArePartyA ? deps.identity.chainPubkey : swapRef.proposerChainPubkey,
                    party_b: weArePartyA ? swapRef.proposerChainPubkey : deps.identity.chainPubkey,
                  };
                  await sendAnnounce_v2(deps.communications, escrowPubkey, swapRef.manifest, signatures, chainPubkeys, swapRef.auxiliary);
                  // Guard: only start timer if still in 'accepted' — concurrent invoice_delivery
                  // may have already moved the swap to 'announced' and started the expiry timer.
                  if (this.swaps.get(swapRef.swapId)?.progress === 'accepted') {
                    this.startAnnounceTimer(swapRef.swapId);
                  }
                } else {
                  // Missing signatures — fall back to status query
                  await sendStatusQuery(deps.communications, escrowPubkey, swapRef.swapId);
                  // Same guard: do not clobber the expiry timer if swap already advanced.
                  if (this.swaps.get(swapRef.swapId)?.progress === 'accepted') {
                    this.startAnnounceTimer(swapRef.swapId);
                  }
                }
              } else {
                // v1: Re-send announce DM to escrow (idempotent — escrow returns existing state)
                logger.debug(LOG_TAG, `Crash recovery: re-announcing swap ${swapRef.swapId.slice(0, 12)}`);
                await sendAnnounce(deps.communications, escrowPubkey, swapRef.manifest);
              }
              break;

            case 'announced':
            case 'depositing':
              // Send status query to get latest escrow state
              logger.debug(LOG_TAG, `Crash recovery: status query for swap ${swapRef.swapId.slice(0, 12)}`);
              await sendStatusQuery(deps.communications, escrowPubkey, swapRef.swapId);
              // Request deposit invoice if missing
              if (!swapRef.depositInvoiceId) {
                await sendRequestInvoice(deps.communications, escrowPubkey, swapRef.swapId, 'deposit');
              }
              break;

            case 'awaiting_counter':
              // Send status query to check if both deposits are in
              logger.debug(LOG_TAG, `Crash recovery: status query for swap ${swapRef.swapId.slice(0, 12)}`);
              await sendStatusQuery(deps.communications, escrowPubkey, swapRef.swapId);
              break;

            case 'concluding':
              // Send status query + request payout invoice if missing
              logger.debug(LOG_TAG, `Crash recovery: concluding check for swap ${swapRef.swapId.slice(0, 12)}`);
              await sendStatusQuery(deps.communications, escrowPubkey, swapRef.swapId);
              if (!swapRef.payoutInvoiceId) {
                await sendRequestInvoice(deps.communications, escrowPubkey, swapRef.swapId, 'payout');
              }
              break;

            default:
              break;
          }
        } catch (err) {
          if (!this.destroyed) {
            logger.warn(LOG_TAG, `Crash recovery failed for swap ${swapRef.swapId.slice(0, 12)}:`, err);
          }
        }
      })();
    }

    this.loaded = true;

    if (this.config.debug) {
      logger.debug(LOG_TAG, `load() complete: ${this.swaps.size} active swaps`);
    }
  }

  // =========================================================================
  // Lifecycle: destroy
  // =========================================================================

  /**
   * Clean up the module. Unsubscribes from events, clears timers, drains gates,
   * and persists any dirty state.
   *
   * After destroy(), all public methods throw `SWAP_MODULE_DESTROYED`.
   */
  async destroy(): Promise<void> {
    // Set destroyed flag FIRST to prevent concurrent operations
    this.destroyed = true;

    // Unsubscribe DM handler
    try { this.dmUnsubscribe?.(); } catch { /* ignore */ }
    this.dmUnsubscribe = null;

    // Unsubscribe invoice events
    for (const unsub of this.invoiceEventUnsubs) {
      try { unsub(); } catch { /* ignore */ }
    }
    this.invoiceEventUnsubs = [];

    // Clear all local timers
    for (const timer of this.localTimers.values()) {
      clearTimeout(timer);
    }
    this.localTimers.clear();

    // Abort any in-progress v2 announce retries
    for (const ctrl of this.announceAbortControllers.values()) {
      ctrl.abort();
    }
    this.announceAbortControllers.clear();

    // Drain all in-flight gated operations
    await this._gateMap.drainAll();

    // Final-flush: persist all remaining swaps as a safety net
    try {
      await this.persistIndex();
    } catch (err) {
      logger.warn(LOG_TAG, 'Failed to persist index during destroy:', err);
    }

    this.loaded = false;

    if (this.config.debug) {
      logger.debug(LOG_TAG, 'Module destroyed');
    }
  }

  // =========================================================================
  // Per-swap async mutex
  // =========================================================================

  /**
   * Execute `fn` exclusively for the given swap ID.
   * Operations on the same swap are serialized (FIFO).
   * Operations on different swaps run concurrently.
   */
  private async withSwapGate<T>(swapId: string, fn: () => Promise<T>): Promise<T> {
    return this._gateMap.withGate(swapId, fn, () => this.destroyed, 'SWAP_MODULE_DESTROYED');
  }

  // =========================================================================
  // Storage: persist + load
  // =========================================================================

  /**
   * Persist a single swap record to storage.
   * Writes the per-swap key and updates the index.
   *
   * TODO: Swap records are stored in StorageProvider (local file/IndexedDB) which
   * is NOT synced to IPFS. The IpfsStorageProvider only covers TokenStorageProvider
   * (TXF data). Nostr DMs provide the primary replication mechanism for swaps
   * (proposals, acceptance, escrow messages). In a future iteration, consider
   * extending IPFS sync to include swap records for full cross-device recovery.
   */
  private async persistSwap(swap: SwapRef): Promise<void> {
    const deps = this.deps;
    if (!deps) return;

    const addressId = deps.identity.directAddress
      ? deps.identity.directAddress
      : deps.identity.chainPubkey;

    const storageKey = getAddressStorageKey(
      addressId,
      `${STORAGE_KEYS_ADDRESS.SWAP_RECORD_PREFIX}${swap.swapId}`,
    );

    const data: SwapStorageData = { version: 1, swap };
    await deps.storage.set(storageKey, JSON.stringify(data));

    // Update the index
    await this.persistIndex();
  }

  /**
   * Persist the lightweight swap index to storage.
   * The index contains summary entries for all known swaps (including terminal).
   */
  /**
   * Persist the swap index. Merges in-memory active swaps with stored
   * terminal entries (which are not kept in this.swaps but still need
   * to be in the index for dedup and TTL purging).
   */
  private async persistIndex(): Promise<void> {
    const deps = this.deps;
    if (!deps) return;

    const addressId = deps.identity.directAddress
      ? deps.identity.directAddress
      : deps.identity.chainPubkey;

    const indexKey = getAddressStorageKey(
      addressId,
      STORAGE_KEYS_ADDRESS.SWAP_INDEX,
    );

    // Start with terminal entries preserved from the last load
    const indexMap = new Map<string, SwapIndexEntry>();
    for (const entry of this._storedTerminalEntries) {
      indexMap.set(entry.swapId, entry);
    }

    // Overlay with current in-memory swaps (active + newly terminal)
    for (const swap of this.swaps.values()) {
      indexMap.set(swap.swapId, {
        swapId: swap.swapId,
        progress: swap.progress,
        role: swap.role,
        createdAt: swap.createdAt,
      });
    }

    await deps.storage.set(indexKey, JSON.stringify([...indexMap.values()]));
  }

  /**
   * Load swap records from storage.
   * Reads the swap_index, then loads each non-terminal swap from its per-swap key.
   * Purges terminal swap records older than terminalPurgeTtlMs.
   */
  private async loadFromStorage(): Promise<void> {
    const deps = this.deps!;
    const addressId = deps.identity.directAddress
      ? deps.identity.directAddress
      : deps.identity.chainPubkey;

    const indexKey = getAddressStorageKey(
      addressId,
      STORAGE_KEYS_ADDRESS.SWAP_INDEX,
    );

    // Read the index
    let indexEntries: SwapIndexEntry[] = [];
    try {
      const raw = await deps.storage.get(indexKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          indexEntries = parsed as SwapIndexEntry[];
        }
      }
    } catch (err) {
      logger.warn(LOG_TAG, 'Failed to parse swap index, starting fresh:', err);
      indexEntries = [];
    }

    const now = Date.now();
    const purgedIds: string[] = [];
    let indexDirty = false;

    for (const entry of indexEntries) {
      // Purge terminal entries older than TTL
      if (isTerminalProgress(entry.progress)) {
        // Track terminal IDs to prevent replayed DMs from recreating the swap
        this.terminalSwapIds.add(entry.swapId);
        const age = now - entry.createdAt;
        if (age > this.config.terminalPurgeTtlMs) {
          purgedIds.push(entry.swapId);
          indexDirty = true;
          continue;
        }
        // Terminal but not yet expired — skip loading into memory but preserve in index
        this._storedTerminalEntries.push(entry);
        continue;
      }

      // Load non-terminal swap record
      const swapKey = getAddressStorageKey(
        addressId,
        `${STORAGE_KEYS_ADDRESS.SWAP_RECORD_PREFIX}${entry.swapId}`,
      );

      try {
        const raw = await deps.storage.get(swapKey);
        if (!raw) {
          // Missing record — remove from index on next persist
          indexDirty = true;
          continue;
        }

        const parsed = JSON.parse(raw) as SwapStorageData;

        // Version check: warn on future versions but attempt best-effort parsing
        if (parsed.version > 1) {
          logger.warn(LOG_TAG, `Swap ${entry.swapId} has version ${parsed.version}, expected 1. Attempting best-effort load.`);
        }

        if (parsed.swap) {
          this.swaps.set(entry.swapId, parsed.swap);
        }
      } catch (err) {
        logger.warn(LOG_TAG, `Failed to load swap ${entry.swapId}:`, err);
        indexDirty = true;
      }
    }

    // Purge expired terminal records from storage
    for (const id of purgedIds) {
      const swapKey = getAddressStorageKey(
        addressId,
        `${STORAGE_KEYS_ADDRESS.SWAP_RECORD_PREFIX}${id}`,
      );
      try {
        await deps.storage.remove(swapKey);
      } catch (err) {
        logger.warn(LOG_TAG, `Failed to delete purged swap ${id}:`, err);
      }
    }

    // Re-persist index if anything was removed or broken entries found
    if (indexDirty || purgedIds.length > 0) {
      // Rebuild index from loaded swaps + non-expired terminal entries
      const cleanIndex: SwapIndexEntry[] = [];
      for (const entry of indexEntries) {
        if (purgedIds.includes(entry.swapId)) continue;
        // Keep entry if we loaded it or if it's a still-valid terminal entry
        if (this.swaps.has(entry.swapId) || isTerminalProgress(entry.progress)) {
          cleanIndex.push(entry);
        }
      }
      await deps.storage.set(indexKey, JSON.stringify(cleanIndex));
    }

    if (this.config.debug) {
      logger.debug(LOG_TAG, `Loaded ${this.swaps.size} active swaps, purged ${purgedIds.length} terminal`);
    }
  }

  /**
   * Remove a single swap from storage (per-swap key) and update the index.
   */
  private async removeSwapFromStorage(swapId: string): Promise<void> {
    const deps = this.deps;
    if (!deps) return;

    // Clean up reverse index entries before removing from map
    const swap = this.swaps.get(swapId);
    if (swap) {
      if (swap.depositInvoiceId) this.invoiceToSwapIndex.delete(swap.depositInvoiceId);
      if (swap.payoutInvoiceId) this.invoiceToSwapIndex.delete(swap.payoutInvoiceId);
    }

    const addressId = deps.identity.directAddress
      ? deps.identity.directAddress
      : deps.identity.chainPubkey;

    const swapKey = getAddressStorageKey(
      addressId,
      `${STORAGE_KEYS_ADDRESS.SWAP_RECORD_PREFIX}${swapId}`,
    );

    try {
      await deps.storage.remove(swapKey);
    } catch (err) {
      logger.warn(LOG_TAG, `Failed to delete swap ${swapId} from storage:`, err);
    }

    this.swaps.delete(swapId);
    await this.persistIndex();
  }

  // =========================================================================
  // State transitions
  // =========================================================================

  /**
   * Transition a swap to a new progress state with optional field updates.
   * Validates the transition, updates in memory, persists, then returns.
   *
   * External actions (DM sends, event emissions) should happen AFTER calling
   * this method -- persist-before-act ensures crash safety.
   *
   * @param swap - The swap record to transition.
   * @param to - The target progress state.
   * @param updates - Optional partial updates to merge into the swap.
   */
  private async transitionProgress(
    swap: SwapRef,
    to: SwapProgress,
    updates?: Partial<SwapRef>,
  ): Promise<void> {
    // Validate the transition (throws SWAP_WRONG_STATE on illegal transition)
    assertTransition(swap.progress, to);

    // Update in memory
    swap.progress = to;
    swap.updatedAt = Date.now();
    if (updates) {
      Object.assign(swap, updates);
    }

    // Set announcedAt when entering 'announced' state
    if (to === 'announced' && !swap.announcedAt) {
      swap.announcedAt = Date.now();
    }

    // Persist per-swap key
    await this.persistSwap(swap);

    // Clear local timer and track terminal ID on terminal states.
    // Also push to _storedTerminalEntries so that subsequent persistIndex() calls
    // (triggered by other swap persists) preserve this terminal entry — without it,
    // if a future cleanup pass removes the swap from this.swaps mid-session, the
    // entry would be silently dropped from the index.
    if (isTerminalProgress(to)) {
      this.clearLocalTimer(swap.swapId);
      this.terminalSwapIds.add(swap.swapId);
      this._storedTerminalEntries.push({
        swapId: swap.swapId,
        progress: to,
        role: swap.role,
        createdAt: swap.createdAt,
      });
    }

    if (this.config.debug) {
      logger.debug(LOG_TAG, `Swap ${swap.swapId}: transitioned to ${to}`);
    }
  }

  // =========================================================================
  // Guards
  // =========================================================================

  /**
   * Ensure dependencies have been injected via `initialize()`.
   * @throws {SphereError} `SWAP_NOT_INITIALIZED`
   */
  private ensureInitialized(): void {
    if (!this.deps) {
      throw new SphereError(
        'SwapModule has not been initialized. Call initialize(deps) first.',
        'SWAP_NOT_INITIALIZED',
      );
    }
  }

  /**
   * Ensure the module has been initialized AND loaded.
   * Used by public API methods that require full readiness.
   * @throws {SphereError} `SWAP_NOT_INITIALIZED`
   */
  private ensureReady(): void {
    this.ensureInitialized();
    if (!this.loaded) {
      throw new SphereError(
        'SwapModule has not loaded. Call load() first.',
        'SWAP_NOT_INITIALIZED',
      );
    }
  }

  /**
   * Ensure the module has not been destroyed.
   * @throws {SphereError} `SWAP_MODULE_DESTROYED`
   */
  private ensureNotDestroyed(): void {
    if (this.destroyed) {
      throw new SphereError(
        'SwapModule has been destroyed.',
        'SWAP_MODULE_DESTROYED',
      );
    }
  }

  // =========================================================================
  // T2.1: IMPLEMENTATION START — proposeSwap
  // =========================================================================

  /**
   * Propose a swap to a counterparty.
   *
   * @param deal - The swap deal terms (parties, currencies, amounts, timeout).
   * @param options - Optional proposal options (message to include in DM).
   * @returns The swap proposal result with swapId, manifest, and SwapRef.
   * @throws {SphereError} `SWAP_INVALID_DEAL` for invalid deal fields.
   * @throws {SphereError} `SWAP_RESOLVE_FAILED` if address resolution fails.
   * @throws {SphereError} `SWAP_LIMIT_EXCEEDED` if max pending swaps reached.
   * @throws {SphereError} `SWAP_DM_SEND_FAILED` if proposal DM fails to send.
   */
  async proposeSwap(deal: SwapDeal, options?: ProposeSwapOptions): Promise<SwapProposalResult> {
    this.ensureNotDestroyed();
    this.ensureReady();
    const deps = this.deps!;

    // Step 2: Validate deal fields (§17.1)
    if (typeof deal.partyA !== 'string' || deal.partyA.length === 0) {
      throw new SphereError('SWAP_INVALID_DEAL: partyA is required', 'SWAP_INVALID_DEAL');
    }
    if (typeof deal.partyB !== 'string' || deal.partyB.length === 0) {
      throw new SphereError('SWAP_INVALID_DEAL: partyB is required', 'SWAP_INVALID_DEAL');
    }
    if (deal.partyA.toLowerCase() === deal.partyB.toLowerCase()) {
      throw new SphereError('SWAP_INVALID_DEAL: partyA and partyB must be different', 'SWAP_INVALID_DEAL');
    }
    const currencyRe = /^[A-Za-z0-9]{1,20}$/;
    if (typeof deal.partyACurrency !== 'string' || !currencyRe.test(deal.partyACurrency)) {
      throw new SphereError('SWAP_INVALID_DEAL: partyACurrency must be 1-20 alphanumeric characters', 'SWAP_INVALID_DEAL');
    }
    if (typeof deal.partyBCurrency !== 'string' || !currencyRe.test(deal.partyBCurrency)) {
      throw new SphereError('SWAP_INVALID_DEAL: partyBCurrency must be 1-20 alphanumeric characters', 'SWAP_INVALID_DEAL');
    }
    if (deal.partyACurrency === deal.partyBCurrency) {
      throw new SphereError('SWAP_INVALID_DEAL: currencies must differ', 'SWAP_INVALID_DEAL');
    }
    const amountRe = /^[1-9][0-9]*$/;
    if (typeof deal.partyAAmount !== 'string' || !amountRe.test(deal.partyAAmount)) {
      throw new SphereError('SWAP_INVALID_DEAL: partyAAmount must be a positive integer string', 'SWAP_INVALID_DEAL');
    }
    if (typeof deal.partyBAmount !== 'string' || !amountRe.test(deal.partyBAmount)) {
      throw new SphereError('SWAP_INVALID_DEAL: partyBAmount must be a positive integer string', 'SWAP_INVALID_DEAL');
    }
    if (typeof deal.timeout !== 'number' || !Number.isInteger(deal.timeout) || deal.timeout < 60 || deal.timeout > 86400) {
      throw new SphereError('SWAP_INVALID_DEAL: timeout must be an integer between 60 and 86400 seconds', 'SWAP_INVALID_DEAL');
    }

    // Step 3: Resolve escrow address
    const escrowAddress = deal.escrowAddress ?? this.config.defaultEscrowAddress;
    if (!escrowAddress) {
      throw new SphereError(
        'No escrow address: provide deal.escrowAddress or configure defaultEscrowAddress',
        'SWAP_INVALID_DEAL',
      );
    }
    const escrowPeer = await deps.resolve(escrowAddress);
    if (!escrowPeer) {
      throw new SphereError(`Cannot resolve escrow address: ${escrowAddress}`, 'SWAP_RESOLVE_FAILED');
    }

    // Step 4: Resolve party addresses
    const peerA = await deps.resolve(deal.partyA);
    if (!peerA) {
      throw new SphereError(`Cannot resolve party A address: ${deal.partyA}`, 'SWAP_RESOLVE_FAILED');
    }
    const peerB = await deps.resolve(deal.partyB);
    if (!peerB) {
      throw new SphereError(`Cannot resolve party B address: ${deal.partyB}`, 'SWAP_RESOLVE_FAILED');
    }
    const resolvedPartyA = peerA.directAddress;
    const resolvedPartyB = peerB.directAddress;

    // Step 5: Determine role
    const activeAddresses = deps.getActiveAddresses();
    const ownDirectAddresses = new Set(activeAddresses.map(a => a.directAddress));
    const matchesPartyA = ownDirectAddresses.has(resolvedPartyA);
    const matchesPartyB = ownDirectAddresses.has(resolvedPartyB);
    if (matchesPartyA && matchesPartyB) {
      throw new SphereError('SWAP_INVALID_DEAL: Cannot swap with yourself', 'SWAP_INVALID_DEAL');
    }
    if (!matchesPartyA && !matchesPartyB) {
      throw new SphereError('SWAP_INVALID_DEAL: Local wallet is neither party A nor party B', 'SWAP_INVALID_DEAL');
    }
    const role: 'proposer' = 'proposer';
    const counterpartyPeer = matchesPartyA ? peerB : peerA;
    const counterpartyPubkey = counterpartyPeer.transportPubkey ?? counterpartyPeer.chainPubkey;
    const counterpartyNametag = counterpartyPeer.nametag;

    // Step 6: Check pending swap limit
    let pendingCount = 0;
    for (const s of this.swaps.values()) {
      if (!isTerminalProgress(s.progress)) {
        pendingCount++;
      }
    }
    if (pendingCount >= this.config.maxPendingSwaps) {
      throw new SphereError(`Maximum pending swaps (${this.config.maxPendingSwaps}) exceeded`, 'SWAP_LIMIT_EXCEEDED');
    }

    // Step 7: Build SwapManifest (v2: include escrow address in manifest for swap_id computation)
    const manifest = buildManifest(resolvedPartyA, resolvedPartyB, deal, deal.timeout, escrowPeer.directAddress);
    const swapId = manifest.swap_id;

    // Step 7b: Sign the swap manifest (v2)
    const proposerSignature = signSwapManifest(deps.identity.privateKey, swapId, escrowPeer.directAddress);

    // Step 7c: Create nametag binding if proposer used @nametag
    let auxiliary: ManifestAuxiliary | undefined;
    const proposerIsPartyA = matchesPartyA;
    const proposerOriginalAddress = proposerIsPartyA ? deal.partyA : deal.partyB;
    if (proposerOriginalAddress.startsWith('@')) {
      const nametag = proposerOriginalAddress.slice(1);
      const directAddress = proposerIsPartyA ? resolvedPartyA : resolvedPartyB;
      const binding = createNametagBinding(
        deps.identity.privateKey, nametag, directAddress, swapId,
        deps.identity.chainPubkey,
      );
      auxiliary = proposerIsPartyA
        ? { party_a_binding: binding }
        : { party_b_binding: binding };
    }

    // Step 8: Check for duplicate (idempotent for active swaps)
    const existingSwap = this.swaps.get(swapId);
    if (existingSwap) {
      return {
        swapId,
        manifest: existingSwap.manifest,
        swap: { ...existingSwap, deal: { ...existingSwap.deal }, manifest: { ...existingSwap.manifest } },
      };
    }

    // Step 9: Create SwapRef
    const now = Date.now();
    const swap: SwapRef = {
      swapId,
      deal,
      manifest,
      role,
      progress: 'proposed',
      counterpartyPubkey,
      counterpartyNametag,
      escrowPubkey: escrowPeer.transportPubkey ?? escrowPeer.chainPubkey,
      escrowDirectAddress: escrowPeer.directAddress,
      payoutVerified: false,
      createdAt: now,
      updatedAt: now,
      proposerSignature,
      proposerChainPubkey: deps.identity.chainPubkey,
      auxiliary,
      protocolVersion: 2,
    };

    // Step 10: Persist (persist-before-act).
    // Remove from terminal set atomically with swaps.set — no window where the swap
    // appears in neither map (DM handlers look up swaps.get first, then terminalSwapIds).
    // Allow re-proposing a previously rejected/cancelled/failed swap
    // (same deal → same swap_id, but user explicitly wants to try again).
    this.swaps.set(swapId, swap);
    this.terminalSwapIds.delete(swapId);
    await this.persistSwap(swap);

    // Step 11: Send proposal DM to the counterparty (v2)
    try {
      const dmContent = buildProposalDM_v2(
        manifest, escrowAddress!, proposerSignature,
        deps.identity.chainPubkey, auxiliary, options?.message,
      );
      await deps.communications.sendDM(counterpartyPubkey, dmContent);
    } catch (err) {
      swap.progress = 'failed';
      swap.error = `Proposal DM send failed: ${err instanceof Error ? err.message : String(err)}`;
      swap.updatedAt = Date.now();
      // Maintain invariant: all terminal swaps are in terminalSwapIds (not just this.swaps).
      // transitionProgress() is bypassed here, so we must update all three collections manually.
      // IMPORTANT: persistSwap must run while swap is still in this.swaps — persistIndex()
      // iterates this.swaps to build the index; deleting before persist orphans the record.
      // The finally block ensures _storedTerminalEntries and swaps are updated even if
      // persistSwap throws (e.g., storage error) so in-memory state stays consistent.
      this.terminalSwapIds.add(swapId);
      try {
        await this.persistSwap(swap);
      } finally {
        this._storedTerminalEntries.push({
          swapId,
          progress: 'failed',
          role: swap.role,
          createdAt: swap.createdAt,
        });
        this.swaps.delete(swapId);
      }
      throw new SphereError(
        `Failed to send proposal DM: ${err instanceof Error ? err.message : String(err)}`,
        'SWAP_DM_SEND_FAILED',
      );
    }

    // Step 12: Start proposal timeout timer
    this.startProposalTimer(swapId);

    // Step 13: Emit event
    deps.emitEvent('swap:proposed', {
      swapId,
      deal: { ...deal },
      recipientPubkey: counterpartyPubkey,
    });

    // Step 14: Return result
    return {
      swapId,
      manifest,
      swap: { ...swap, deal: { ...swap.deal }, manifest: { ...swap.manifest } },
    };
  }

  // T2.1: IMPLEMENTATION END

  // =========================================================================
  // T2.2: IMPLEMENTATION START — acceptSwap + rejectSwap
  // =========================================================================

  /**
   * Accept a received swap proposal.
   * Transitions the swap from 'proposed' to 'accepted', sends an acceptance
   * DM to the proposer, then announces the manifest to the escrow.
   *
   * @param swapId - The swap ID to accept.
   * @throws {SphereError} `SWAP_NOT_FOUND` if swap does not exist.
   * @throws {SphereError} `SWAP_WRONG_STATE` if swap is not in 'proposed' state.
   */
  async acceptSwap(swapId: string): Promise<void> {
    this.ensureNotDestroyed();
    this.ensureReady();
    const deps = this.deps!;

    // Step 2: Look up swap
    const swap = this.swaps.get(swapId);
    if (!swap) {
      throw new SphereError(`Swap not found: ${swapId}`, 'SWAP_NOT_FOUND');
    }
    // Fast-path checks before gate (re-checked inside gate for TOCTOU safety)
    if (swap.progress !== 'proposed') {
      throw new SphereError(
        `Cannot accept: swap is in ${swap.progress} state`,
        'SWAP_WRONG_STATE',
      );
    }
    if (swap.role !== 'acceptor') {
      throw new SphereError(
        'Cannot accept: you are the proposer, not the acceptor',
        'SWAP_WRONG_STATE',
      );
    }

    // Capture v2 announce parameters from within the gate — executed outside to avoid
    // holding the per-swap gate during sendAnnounce_v2 (up to 6 retries, ~82s total).
    // Holding the gate would block all incoming escrow DMs (announce_result, invoice_delivery)
    // for this swap, potentially causing them to time out before announce completes.
    type V2AnnounceParams = {
      escrowPubkey: string;
      manifest: SwapManifest;
      signatures: ManifestSignatures;
      chainPubkeys: { party_a: string; party_b: string };
      auxiliary: ManifestAuxiliary | undefined;
    };
    let v2AnnounceParams: V2AnnounceParams | undefined;

    // Step 3: Enter per-swap gate
    await this.withSwapGate(swapId, async () => {
      // Re-check state inside gate (TOCTOU guard — concurrent rejection/cancellation may have fired)
      if (swap.progress !== 'proposed') {
        throw new SphereError(
          `Cannot accept: swap changed to ${swap.progress} state before gate acquired`,
          'SWAP_WRONG_STATE',
        );
      }

      // Step 4b: Validate escrow address BEFORE transitioning (needed for v2 signature)
      // For v2 swaps the escrow_address MUST be present in the manifest (set at proposal time).
      // For v1 swaps the address is resolved in Step 7 after the transition.
      const escrowAddressForSignature = swap.manifest.escrow_address ?? swap.escrowDirectAddress;
      if (swap.protocolVersion === 2 && !escrowAddressForSignature) {
        throw new SphereError(
          'Cannot accept: escrow address not yet resolved (retry shortly)',
          'SWAP_WRONG_STATE',
        );
      }

      // Determine protocol version
      const isV2 = swap.protocolVersion === 2;

      // Step 4b: Compute acceptor signature and nametag binding BEFORE transitioning,
      // so the single transitionProgress persist captures all fields atomically.
      // A crash between transitionProgress and a separate persistSwap would lose the
      // signature / auxiliary, preventing v2 announce recovery.

      // v2: Sign the swap manifest.
      // IMPORTANT: Use manifest.escrow_address (locked at proposal time), NOT re-resolved address.
      // escrowAddressForSignature is guaranteed non-undefined for v2 by the guard above.
      const acceptorSignature = isV2 && escrowAddressForSignature
        ? signSwapManifest(deps.identity.privateKey, swap.manifest.swap_id, escrowAddressForSignature)
        : undefined;

      // Step 4c: Resolve party positions for nametag binding (v2) and announce (v2)
      const activeAddresses = deps.getActiveAddresses();
      const ourAddresses = new Set<string>();
      for (const addr of activeAddresses) {
        if (addr.directAddress) ourAddresses.add(addr.directAddress);
      }
      if (deps.identity.directAddress) {
        ourAddresses.add(deps.identity.directAddress);
      }

      const acceptorIsPartyA = ourAddresses.has(swap.manifest.party_a_address);

      // v2: Create nametag binding proof if acceptor used @nametag
      let acceptorAuxiliary = swap.auxiliary;
      if (isV2) {
        const myNametag = deps.identity.nametag;
        if (myNametag) {
          const directAddress = acceptorIsPartyA
            ? swap.manifest.party_a_address
            : swap.manifest.party_b_address;
          const binding = createNametagBinding(
            deps.identity.privateKey, myNametag, directAddress, swap.manifest.swap_id,
            deps.identity.chainPubkey,
          );
          acceptorAuxiliary = {
            ...acceptorAuxiliary,
            ...(acceptorIsPartyA
              ? { party_a_binding: binding }
              : { party_b_binding: binding }),
          };
        }
      }

      // Assign acceptor signature (v2 only) and auxiliary to swap BEFORE transitioning.
      // transitionProgress calls persistSwap, so these fields are included in the
      // single atomic write — no second persistSwap needed.
      const prevProgress = swap.progress;
      const prevUpdatedAt = swap.updatedAt;
      const prevAcceptorSignature = (swap as { acceptorSignature?: string }).acceptorSignature;
      const prevAuxiliary = (swap as { auxiliary?: ManifestAuxiliary }).auxiliary;
      if (isV2 && acceptorSignature) {
        (swap as { acceptorSignature?: string }).acceptorSignature = acceptorSignature;
      }
      (swap as { auxiliary?: ManifestAuxiliary }).auxiliary = acceptorAuxiliary;

      // Step 4: Transition to 'accepted' (persist-before-act, includes signature + auxiliary)
      try {
        await this.transitionProgress(swap, 'accepted');
      } catch (err) {
        // Roll back ALL in-memory mutations (progress, updatedAt, and v2 fields) so the
        // swap is not left in a partially-advanced state if persistSwap throws.
        // transitionProgress mutates swap.progress before calling persistSwap, so we must
        // restore progress and updatedAt here — not just the fields we set before the call.
        swap.progress = prevProgress;
        swap.updatedAt = prevUpdatedAt;
        (swap as { acceptorSignature?: string }).acceptorSignature = prevAcceptorSignature;
        (swap as { auxiliary?: ManifestAuxiliary }).auxiliary = prevAuxiliary;
        throw err;
      }

      // Step 5: Send acceptance DM to proposer
      try {
        const acceptDM = isV2 && acceptorSignature
          ? buildAcceptanceDM_v2(swapId, acceptorSignature, deps.identity.chainPubkey)
          : buildAcceptanceDM(swapId); // v1: informational only, proposer announces
        if (swap.counterpartyPubkey) {
          await deps.communications.sendDM(swap.counterpartyPubkey, acceptDM);
        }
      } catch {
        // Best-effort — in v2 Bob announces directly, so the acceptance DM is informational
      }

      // Step 6: Emit swap:accepted
      deps.emitEvent('swap:accepted', { swapId, role: swap.role });

      // Step 7: v2 only — prepare announce params; actual send happens OUTSIDE the gate.
      // In v1, the proposer announces to escrow after receiving the acceptance DM.
      if (swap.protocolVersion === 2) {
        if (!swap.escrowPubkey) {
          const { escrowPubkey, escrowDirectAddress } = await resolveEscrowAddress(
            swap.deal, this.config, deps.resolve,
          );
          swap.escrowPubkey = escrowPubkey;
          swap.escrowDirectAddress = escrowDirectAddress;
          await this.persistSwap(swap);
        }

        // proposerChainPubkey is required for v2 (set during proposal receipt signature verification)
        const proposerChainPubkey = swap.proposerChainPubkey;
        if (!proposerChainPubkey) {
          await this.transitionProgress(swap, 'failed', {
            error: 'Cannot announce: proposer chain pubkey missing (v2 proposal)',
          });
          deps.emitEvent('swap:failed', { swapId, error: 'Cannot announce: proposer chain pubkey missing (v2 proposal)' });
          logger.warn(LOG_TAG, `v2 announce for ${swapId.slice(0, 12)} missing proposerChainPubkey`);
          return;
        }

        // acceptorSignature is guaranteed defined here: we are in the v2 block and
        // the guard above ensures escrowAddressForSignature was defined.
        if (!acceptorSignature) {
          await this.transitionProgress(swap, 'failed', {
            error: 'Cannot announce: acceptor signature missing (v2 internal error)',
          });
          deps.emitEvent('swap:failed', { swapId, error: 'Cannot announce: acceptor signature missing' });
          return;
        }

        const acceptorChainPubkey = deps.identity.chainPubkey;
        const weArePartyA = acceptorIsPartyA;
        const signatures: ManifestSignatures = {
          party_a: weArePartyA ? acceptorSignature : swap.proposerSignature,
          party_b: weArePartyA ? swap.proposerSignature : acceptorSignature,
        };
        const chainPubkeys = {
          party_a: weArePartyA ? acceptorChainPubkey : proposerChainPubkey,
          party_b: weArePartyA ? proposerChainPubkey : acceptorChainPubkey,
        };

        // Capture params — announce executes outside the gate (see Step 7b below)
        v2AnnounceParams = {
          escrowPubkey: swap.escrowPubkey!,
          manifest: swap.manifest,
          signatures,
          chainPubkeys,
          auxiliary: acceptorAuxiliary,
        };
      } else {
        // v1: Resolve and store escrow address so it's available for crash recovery and DM verification.
        // The proposer is responsible for announcing to escrow when they receive our acceptance DM.
        if (!swap.escrowPubkey) {
          try {
            const { escrowPubkey, escrowDirectAddress } = await resolveEscrowAddress(
              swap.deal, this.config, deps.resolve,
            );
            swap.escrowPubkey = escrowPubkey;
            swap.escrowDirectAddress = escrowDirectAddress;
            await this.persistSwap(swap);
          } catch {
            // Best-effort for v1 — escrow will be resolved at announce time
          }
        }
      }
    });

    // Step 7b: Execute v2 announce OUTSIDE the gate.
    // sendAnnounce_v2 has up to 6 retries (~82s). Running it inside the gate would block
    // all incoming escrow DMs for this swap (announce_result, invoice_delivery), which
    // arrive from escrow as a direct response to the announce we are sending.
    if (v2AnnounceParams) {
      const params = v2AnnounceParams;
      // Create an AbortController so cancelSwap/rejectSwap can stop retries immediately.
      const announceAbort = new AbortController();
      this.announceAbortControllers.set(swapId, announceAbort);
      try {
        await sendAnnounce_v2(
          deps.communications, params.escrowPubkey,
          params.manifest, params.signatures, params.chainPubkeys, params.auxiliary,
          announceAbort.signal,
        );
        // Start the announce-response timer ONLY if the swap is still in 'accepted' state.
        // sendAnnounce_v2 retries for up to ~82s; during that window the escrow may have
        // already delivered invoice_delivery (transitioning to 'announced' and starting the
        // local expiry timer). Calling startAnnounceTimer unconditionally would clobber that
        // expiry timer via clearLocalTimer, leaving the swap without any local deadline.
        if (this.swaps.get(swapId)?.progress === 'accepted') {
          this.startAnnounceTimer(swapId);
        }
      } catch (err) {
        // Announce failure — re-acquire gate to transition to failed and notify proposer
        await this.withSwapGate(swapId, async () => {
          const currentSwap = this.swaps.get(swapId);
          if (!currentSwap || isTerminalProgress(currentSwap.progress)) return;
          // Guard: if escrow already acknowledged the announce (depositInvoiceId set by an
          // announce_result DM that arrived while sendAnnounce_v2 was retrying), the announce
          // actually succeeded. escrowState alone is insufficient — a rogue/replayed
          // announce_result could set escrowState without providing a deposit invoice.
          if (currentSwap.depositInvoiceId) {
            logger.warn(LOG_TAG, `v2 announce for ${swapId.slice(0, 12)} threw but escrow already ack'd — ignoring failure`);
            return;
          }
          await this.transitionProgress(currentSwap, 'failed', {
            error: 'Failed to send v2 announce to escrow',
          });
          deps.emitEvent('swap:failed', { swapId, error: 'Failed to send v2 announce to escrow' });
          logger.warn(LOG_TAG, `Failed to announce v2 swap ${swapId} to escrow:`, err);
          // Notify proposer so they don't wait indefinitely for escrow messages
          if (currentSwap.counterpartyPubkey) {
            try {
              const cancelDM = buildCancelDM(swapId, 'Acceptor failed to announce to escrow');
              await deps.communications.sendDM(currentSwap.counterpartyPubkey, cancelDM);
            } catch {
              // Best-effort
            }
          }
        });
      } finally {
        // Always clean up the abort controller regardless of success/failure/abort
        this.announceAbortControllers.delete(swapId);
      }
    }
  }

  /**
   * Reject a received swap proposal.
   * Transitions the swap to 'cancelled', sends a rejection DM to the proposer.
   *
   * @param swapId - The swap ID to reject.
   * @param reason - Optional human-readable reason for rejection.
   * @throws {SphereError} `SWAP_NOT_FOUND` if swap does not exist.
   * @throws {SphereError} `SWAP_WRONG_STATE` if swap is not in 'proposed' state.
   */
  async rejectSwap(swapId: string, reason?: string): Promise<void> {
    this.ensureNotDestroyed();
    this.ensureReady();
    const deps = this.deps!;

    // Step 2: Look up swap
    const swap = this.swaps.get(swapId);
    if (!swap) {
      throw new SphereError(`Swap not found: ${swapId}`, 'SWAP_NOT_FOUND');
    }

    // Allow rejection at any pre-payout state
    if (swap.progress === 'concluding') {
      throw new SphereError('Cannot reject: payouts are already in progress', 'SWAP_WRONG_STATE');
    }
    if (swap.progress === 'completed') {
      throw new SphereError('Cannot reject: swap is already completed', 'SWAP_ALREADY_COMPLETED');
    }
    if (swap.progress === 'cancelled' || swap.progress === 'failed') {
      throw new SphereError('Swap is already cancelled', 'SWAP_ALREADY_CANCELLED');
    }

    // Step 3: Enter per-swap gate
    await this.withSwapGate(swapId, async () => {
      // Re-check state inside gate (TOCTOU guard — swap may have advanced to 'concluding'
      // between the pre-gate check and gate acquisition due to a concurrent escrow DM)
      if (swap.progress === 'concluding') {
        throw new SphereError('Cannot reject: payouts are already in progress', 'SWAP_WRONG_STATE');
      }
      if (swap.progress === 'completed') {
        throw new SphereError('Cannot reject: swap is already completed', 'SWAP_ALREADY_COMPLETED');
      }
      if (swap.progress === 'cancelled' || swap.progress === 'failed') {
        throw new SphereError('Swap is already cancelled', 'SWAP_ALREADY_CANCELLED');
      }

      // Step 4: If post-acceptance, notify escrow first to cancel and return deposits.
      // Escrow must be notified before the counterparty so deposits are protected promptly.
      // Include 'accepted': sendAnnounce_v2 runs outside the gate for up to 82s, so the
      // escrow may have already received the announce while progress is still 'accepted'.
      if (swap.escrowPubkey && ['accepted', 'announced', 'depositing', 'awaiting_counter'].includes(swap.progress)) {
        // Abort any in-progress v2 announce so retries stop immediately
        this.announceAbortControllers.get(swapId)?.abort();
        try {
          const cancelDM = buildCancelDM(swapId, reason ?? 'Rejected by user');
          await deps.communications.sendDM(swap.escrowPubkey, cancelDM);
        } catch (err) {
          logger.warn(LOG_TAG, `Failed to send cancel DM to escrow for swap ${swapId}:`, err);
        }
      }

      // Step 4b: Send rejection DM to counterparty (best-effort, after escrow notified)
      try {
        const dmContent = buildRejectionDM(swapId, reason);
        if (swap.counterpartyPubkey) {
          await deps.communications.sendDM(swap.counterpartyPubkey, dmContent);
        }
      } catch (err) {
        logger.warn(LOG_TAG, `Failed to send rejection DM for swap ${swapId}:`, err);
      }

      // Clear local timer
      this.clearLocalTimer(swapId);

      // Step 5: Transition to 'cancelled' with error
      await this.transitionProgress(swap, 'cancelled', { error: reason ?? 'Rejected by user' });

      // Step 6: Emit swap:rejected
      deps.emitEvent('swap:rejected', { swapId, reason });

      // Step 7: Emit swap:cancelled with reason='rejected'
      deps.emitEvent('swap:cancelled', { swapId, reason: 'rejected', depositsReturned: false });

      // Step 8: Clear proposal timer
      this.clearLocalTimer(swapId);
    });
  }

  // T2.2: IMPLEMENTATION END

  // =========================================================================
  // T2.3: IMPLEMENTATION START — deposit + verifyPayout
  // =========================================================================

  /**
   * Send the local deposit for a swap.
   * Calls accounting.payInvoice() with the swap's deposit invoice.
   *
   * @param swapId - The swap ID to deposit for.
   * @returns The transfer result from payInvoice().
   * @throws {SphereError} `SWAP_NOT_FOUND` if swap does not exist.
   * @throws {SphereError} `SWAP_WRONG_STATE` if swap is not in 'announced' state.
   * @throws {SphereError} `SWAP_DEPOSIT_FAILED` if payment fails.
   */
  async deposit(swapId: string): Promise<TransferResult> {
    this.ensureNotDestroyed();
    this.ensureReady();
    const deps = this.deps!;

    // Look up swap
    const swap = this.swaps.get(swapId);
    if (!swap) {
      throw new SphereError(`Swap ${swapId} not found`, 'SWAP_NOT_FOUND');
    }

    // Verify progress is 'announced'
    if (swap.progress !== 'announced') {
      throw new SphereError(
        `Swap ${swapId} is in '${swap.progress}' state, expected 'announced'`,
        'SWAP_WRONG_STATE',
      );
    }

    // Verify deposit invoice is available
    if (!swap.depositInvoiceId) {
      throw new SphereError('Deposit invoice not yet available', 'SWAP_WRONG_STATE');
    }

    // Determine which party we are by comparing our DIRECT addresses against the manifest
    const myDirectAddress = deps.identity.directAddress;
    const allAddresses = deps.getActiveAddresses();
    const myDirectAddresses = new Set<string>();
    if (myDirectAddress) myDirectAddresses.add(myDirectAddress);
    for (const addr of allAddresses) {
      myDirectAddresses.add(addr.directAddress);
    }

    let assetIndex: number;
    if (myDirectAddresses.has(swap.manifest.party_a_address)) {
      assetIndex = 0; // party A
    } else if (myDirectAddresses.has(swap.manifest.party_b_address)) {
      assetIndex = 1; // party B
    } else {
      throw new SphereError(
        'Local wallet address does not match either party in the swap manifest',
        'SWAP_DEPOSIT_FAILED',
      );
    }

    return this.withSwapGate(swapId, async () => {
      // Re-check state inside gate (TOCTOU guard — a concurrent cancelSwap/DM handler may have
      // transitioned the swap between the pre-gate checks and gate acquisition)
      if (swap.progress !== 'announced') {
        throw new SphereError(
          `Swap ${swapId} state changed before deposit could execute (now: ${swap.progress})`,
          'SWAP_WRONG_STATE',
        );
      }
      if (!swap.depositInvoiceId) {
        throw new SphereError('Deposit invoice not yet available', 'SWAP_WRONG_STATE');
      }
      try {
        const transferResult = await deps.accounting.payInvoice(swap.depositInvoiceId, {
          targetIndex: 0,
          assetIndex,
        });

        // Transition to 'depositing'
        await this.transitionProgress(swap, 'depositing', {
          localDepositTransferId: transferResult.id,
        });

        // Emit swap:deposit_sent
        deps.emitEvent('swap:deposit_sent', { swapId, transferResult });

        return transferResult;
      } catch (err) {
        // Do NOT change progress -- user can retry after resolving the issue
        throw new SphereError(
          `Deposit failed for swap ${swapId}: ${err instanceof Error ? err.message : String(err)}`,
          'SWAP_DEPOSIT_FAILED',
          err,
        );
      }
    });
  }

  /**
   * Verify that the payout invoice was correctly fulfilled.
   * Checks invoice status, verifies terms match the manifest, validates
   * L3 proofs, and verifies escrow creator identity.
   *
   * @param swapId - The swap ID to verify.
   * @returns true if payout is verified, false otherwise.
   * @throws {SphereError} `SWAP_NOT_FOUND` if swap does not exist.
   * @throws {SphereError} `SWAP_PAYOUT_VERIFICATION_FAILED` on verification failure.
   */
  async verifyPayout(swapId: string): Promise<boolean> {
    this.ensureNotDestroyed();
    this.ensureReady();
    const deps = this.deps!;

    // Look up swap (pre-gate fast check)
    const swap = this.swaps.get(swapId);
    if (!swap) {
      throw new SphereError(`Swap ${swapId} not found`, 'SWAP_NOT_FOUND');
    }

    if (!swap.payoutInvoiceId) {
      throw new SphereError('Payout invoice not yet received', 'SWAP_WRONG_STATE');
    }

    // Run all verification logic within the per-swap gate to prevent concurrent state mutations.
    // This is safe to call from both: (a) inside fire-and-forget from payout DM handler (the outer
    // gate has already released before this gate runs), and (b) from CLI (no outer gate).
    return this.withSwapGate(swapId, async () => {
      // Re-check after gate acquisition
      if (!swap.payoutInvoiceId) {
        throw new SphereError('Payout invoice not yet received', 'SWAP_WRONG_STATE');
      }

      // Idempotent for already-verified swaps: skip re-verification.
      // IMPORTANT: only short-circuit when payoutVerified is true. If escrow status DM drove
      // the swap to 'completed' before verifyPayout ran (payoutVerified=false), we must still
      // allow the verification pass rather than returning false forever.
      if (swap.progress === 'completed' && swap.payoutVerified === true) return true;
      // For other terminal states (cancelled/failed): clearly reject further verification.
      if (isTerminalProgress(swap.progress) && swap.progress !== 'completed') {
        throw new SphereError(
          `Cannot verify payout: swap is already ${swap.progress}`,
          'SWAP_WRONG_STATE',
        );
      }

      // Track whether the swap was already 'completed' before this call (driven by
      // status_result with payoutVerified=false). In that case, the status_result handler
      // suppressed swap:completed to avoid a duplicate — this call must emit it on both
      // success AND transient-failure paths, so the user is never left without any event.
      const alreadyCompleted = swap.progress === 'completed';

      // Helper: return false while ensuring swap:completed is emitted if needed.
      // The fraud-indicative paths use failPayout() and transition to 'failed' instead.
      // Dedup: only emit one swap:completed(payoutVerified:false) per swap; repeated
      // transient-failure retries must not flood the caller with duplicate events.
      const returnFalse = (): false => {
        if (alreadyCompleted && !this._completedEventEmittedUnverified.has(swapId)) {
          this._completedEventEmittedUnverified.add(swapId);
          deps.emitEvent('swap:completed', { swapId, payoutVerified: false });
        }
        return false;
      };

    // Get invoice ref to access terms
    const invoiceRef = deps.accounting.getInvoice(swap.payoutInvoiceId) as {
      invoiceId: string;
      terms: {
        creator?: string;
        targets: Array<{
          address: string;
          assets: Array<{ coin?: [string, string] }>;
        }>;
      };
    } | null;

    if (!invoiceRef) {
      throw new SphereError('Payout invoice not found', 'SWAP_PAYOUT_VERIFICATION_FAILED');
    }

    // Get invoice status for coverage check
    const status = deps.accounting.getInvoiceStatus(swap.payoutInvoiceId) as {
      state: string;
      targets: Array<{
        coinAssets: Array<{
          coin: [string, string];
          netCoveredAmount: string;
          isCovered: boolean;
        }>;
      }>;
    };

    // Determine expected currency and amount based on our role
    const myDirectAddress = deps.identity.directAddress;
    const allAddresses = deps.getActiveAddresses();
    const myDirectAddresses = new Set<string>();
    if (myDirectAddress) myDirectAddresses.add(myDirectAddress);
    for (const addr of allAddresses) {
      myDirectAddresses.add(addr.directAddress);
    }

    const isPartyA = myDirectAddresses.has(swap.manifest.party_a_address);
    let expectedCoinId: string;
    let expectedAmount: string;

    if (isPartyA) {
      // Party A receives party B's currency
      expectedCoinId = swap.manifest.party_b_currency_to_change;
      expectedAmount = swap.manifest.party_b_value_to_change;
    } else {
      // Party B receives party A's currency
      expectedCoinId = swap.manifest.party_a_currency_to_change;
      expectedAmount = swap.manifest.party_a_value_to_change;
    }

    // Helper: transition to failed and emit — used for fraud-indicative term mismatches.
    // When alreadyCompleted=true the swap is already in 'completed' state, which is a terminal
    // state with no outgoing transitions (completed → failed is INVALID in the state machine).
    // We must replicate the side effects of transitionProgress() via direct mutation instead
    // so that fraud is surfaced rather than silently swallowed by a SWAP_WRONG_STATE throw.
    const failPayout = async (error: string): Promise<false> => {
      if (swap.progress === 'completed') {
        // Direct mutation: completed → failed bypass (invalid state machine edge).
        // Side effects are replicated manually (clearLocalTimer, terminalSwapIds,
        // _storedTerminalEntries, persistSwap).
        //
        // If persistSwap throws, we ROLL BACK all in-memory changes so the swap
        // reloads as 'completed' next session and verifyPayout retries fraud detection.
        const prevProgress = swap.progress;
        const prevPayoutVerified = (swap as { payoutVerified?: boolean }).payoutVerified;
        const prevError = (swap as { error?: string }).error;
        const prevUpdatedAt = swap.updatedAt;
        swap.progress = 'failed';
        (swap as { payoutVerified?: boolean }).payoutVerified = false;
        (swap as { error?: string }).error = error;
        swap.updatedAt = Date.now();
        this.clearLocalTimer(swap.swapId);
        this.terminalSwapIds.add(swap.swapId);
        const entryIdx = this._storedTerminalEntries.length;
        this._storedTerminalEntries.push({
          swapId: swap.swapId,
          progress: 'failed',
          role: swap.role,
          createdAt: swap.createdAt,
        });
        try {
          await this.persistSwap(swap);
        } catch (persistErr) {
          // Storage failed — roll back so next load retries fraud detection.
          swap.progress = prevProgress;
          (swap as { payoutVerified?: boolean }).payoutVerified = prevPayoutVerified;
          (swap as { error?: string }).error = prevError;
          swap.updatedAt = prevUpdatedAt;
          this.terminalSwapIds.delete(swap.swapId);
          this._storedTerminalEntries.splice(entryIdx, 1);
          logger.warn(LOG_TAG, `failPayout: persistSwap failed for ${swapId}; fraud detection will retry on next load:`, persistErr);
          throw persistErr;
        }
      } else {
        await this.transitionProgress(swap, 'failed', { payoutVerified: false, error });
      }
      deps.emitEvent('swap:failed', { swapId, error });
      return false;
    };

    // Verify invoice terms match expectations
    const targetTerms = invoiceRef.terms.targets[0];
    if (!targetTerms || !targetTerms.assets[0]?.coin) {
      return failPayout('Payout invoice has no valid target or asset');
    }

    if (targetTerms.assets[0].coin[0] !== expectedCoinId) {
      return failPayout(
        `Payout invoice currency mismatch: expected ${expectedCoinId}, got ${targetTerms.assets[0].coin[0]}`,
      );
    }

    if (targetTerms.assets[0].coin[1] !== expectedAmount) {
      return failPayout(
        `Payout invoice amount mismatch: expected ${expectedAmount}, got ${targetTerms.assets[0].coin[1]}`,
      );
    }

    // Verify payout invoice targets OUR address (not someone else's)
    if (!myDirectAddresses.has(targetTerms.address)) {
      return failPayout('Payout invoice targets wrong address');
    }

    // Verify creator is defined (escrow invoices are non-anonymous)
    if (!invoiceRef.terms.creator) {
      return failPayout('Payout invoice has no creator (anonymous invoice)');
    }

    // Verify coverage from invoice status
    const targetStatus = status.targets[0];
    if (!targetStatus || !targetStatus.coinAssets[0]) {
      return returnFalse();
    }

    const coveredState = status.state;
    if (coveredState !== 'COVERED' && coveredState !== 'CLOSED') {
      return returnFalse();
    }

    if (!targetStatus.coinAssets[0].isCovered) {
      return returnFalse();
    }

    if (BigInt(targetStatus.coinAssets[0].netCoveredAmount) < BigInt(expectedAmount)) {
      return returnFalse();
    }

    // Verify escrow creator identity
    const escrowAddr = swap.deal.escrowAddress ?? this.config.defaultEscrowAddress;
    if (escrowAddr) {
      const escrowPeer = await deps.resolve(escrowAddr);
      if (escrowPeer && invoiceRef.terms.creator !== escrowPeer.chainPubkey) {
        return failPayout('Payout invoice creator does not match escrow pubkey');
      }
    }

    // Validate L3 inclusion proofs.
    // NOTE: validate() checks ALL wallet tokens, not only payout tokens. An unrelated
    // invalid token should NOT cause the swap to fail — the swap's payout may be
    // perfectly valid. We therefore do not call failPayout() here; instead we return
    // false so the caller can retry once the unrelated token issue is resolved.
    const validationResult = await deps.payments.validate();
    if (validationResult.invalid.length > 0) {
      logger.warn(LOG_TAG, `verifyPayout for ${swapId.slice(0, 12)}: L3 validation found ${validationResult.invalid.length} invalid token(s) — retry after wallet sync`);
      return returnFalse();
    }

    // All checks passed — mark payout as verified.
    // If the swap is already 'completed' (driven by escrow status DM before verifyPayout ran,
    // payoutVerified=false), skip transitionProgress because completed→completed is not a valid
    // state machine transition. Update the fields directly and persist instead.
    if (swap.progress === 'completed') {
      swap.payoutVerified = true;
      swap.updatedAt = Date.now();
      await this.persistSwap(swap);
    } else {
      await this.transitionProgress(swap, 'completed', { payoutVerified: true });
    }

    deps.emitEvent('swap:completed', { swapId, payoutVerified: true });

    return true;
    }); // end withSwapGate
  }

  // T2.3: IMPLEMENTATION END

  // =========================================================================
  // T2.4: IMPLEMENTATION START — getSwapStatus + getSwaps + cancelSwap
  // =========================================================================

  /**
   * Get the current status of a swap.
   * Optionally queries the escrow for the latest state.
   *
   * @param swapId - The swap ID to query.
   * @param options - Optional options (queryEscrow).
   * @returns The current SwapRef.
   * @throws {SphereError} `SWAP_NOT_FOUND` if swap does not exist.
   */
  async getSwapStatus(swapId: string, options?: GetSwapStatusOptions): Promise<SwapRef> {
    this.ensureNotDestroyed();
    this.ensureReady();

    const swap = this.swaps.get(swapId);
    if (!swap) {
      throw new SphereError(`Swap not found: ${swapId}`, 'SWAP_NOT_FOUND');
    }

    // Determine whether to query the escrow for the latest state.
    // If options.queryEscrow is explicitly set, use that; otherwise default to
    // true for active swaps and false for terminal swaps.
    const shouldQuery = options?.queryEscrow ?? !isTerminalProgress(swap.progress);

    if (shouldQuery) {
      // Fire-and-forget: resolve escrow address and send status DM.
      // Errors are logged but never propagated to the caller.
      const deps = this.deps!;
      const escrowAddr = swap.deal.escrowAddress ?? this.config.defaultEscrowAddress;
      if (escrowAddr) {
        deps.resolve(escrowAddr)
          .then((peer) => {
            if (peer) {
              const statusDM = buildStatusQueryDM(swapId);
              return deps.communications.sendDM(peer.transportPubkey ?? peer.chainPubkey, statusDM).then(() => undefined);
            }
          })
          .catch((err) => {
            logger.warn(LOG_TAG, `Failed to send status query for swap ${swapId}:`, err);
          });
      }
    }

    // Return a deep copy to prevent external mutation
    return { ...swap, deal: { ...swap.deal }, manifest: { ...swap.manifest } };
  }

  /**
   * List swaps with optional filtering.
   *
   * @param filter - Optional filter by progress, role, or excludeTerminal.
   * @returns Array of SwapRef matching the filter.
   */
  getSwaps(filter?: GetSwapsFilter): SwapRef[] {
    this.ensureNotDestroyed();
    this.ensureReady();

    let results = Array.from(this.swaps.values());

    if (filter?.progress) {
      const allowed = Array.isArray(filter.progress)
        ? new Set(filter.progress)
        : new Set([filter.progress]);
      results = results.filter(s => allowed.has(s.progress));
    }

    if (filter?.excludeTerminal) {
      results = results.filter(s => !isTerminalProgress(s.progress));
    }

    if (filter?.role) {
      results = results.filter(s => s.role === filter.role);
    }

    results.sort((a, b) => b.updatedAt - a.updatedAt);

    // Return copies to prevent external mutation
    return results.map(s => ({ ...s, deal: { ...s.deal }, manifest: { ...s.manifest } }));
  }

  /**
   * Cancel an active swap.
   * Transitions to 'cancelled' and cleans up local state.
   *
   * @param swapId - The swap ID to cancel.
   * @throws {SphereError} `SWAP_NOT_FOUND` if swap does not exist.
   * @throws {SphereError} `SWAP_ALREADY_COMPLETED` if swap is already completed.
   * @throws {SphereError} `SWAP_ALREADY_CANCELLED` if swap is already cancelled.
   */
  async cancelSwap(swapId: string): Promise<void> {
    this.ensureNotDestroyed();
    this.ensureReady();

    const swap = this.swaps.get(swapId);
    if (!swap) {
      throw new SphereError(`Swap not found: ${swapId}`, 'SWAP_NOT_FOUND');
    }

    // Fast-path checks before gate (TOCTOU-safe: re-checked inside gate)
    if (swap.progress === 'concluding') {
      throw new SphereError('Cannot cancel: payouts are already in progress', 'SWAP_WRONG_STATE');
    }
    if (swap.progress === 'completed') {
      throw new SphereError('Swap is already completed', 'SWAP_ALREADY_COMPLETED');
    }
    if (swap.progress === 'cancelled' || swap.progress === 'failed') {
      throw new SphereError('Swap is already cancelled', 'SWAP_ALREADY_CANCELLED');
    }

    const deps = this.deps!;

    await this.withSwapGate(swapId, async () => {
      // Re-check state inside gate (TOCTOU guard — a concurrent DM handler may have
      // transitioned the swap between the pre-gate check and gate acquisition)
      if (swap.progress === 'concluding') {
        throw new SphereError('Cannot cancel: payouts are already in progress', 'SWAP_WRONG_STATE');
      }
      if (swap.progress === 'completed') {
        throw new SphereError('Swap is already completed', 'SWAP_ALREADY_COMPLETED');
      }
      if (swap.progress === 'cancelled' || swap.progress === 'failed') {
        throw new SphereError('Swap is already cancelled', 'SWAP_ALREADY_CANCELLED');
      }

      // Clear local timer
      this.clearLocalTimer(swapId);

      // Abort any in-progress v2 announce so retries stop immediately.
      // Include 'accepted': sendAnnounce_v2 runs outside the gate for up to 82s.
      this.announceAbortControllers.get(swapId)?.abort();

      // Notify escrow to cancel and return any deposited assets
      if (swap.escrowPubkey && ['accepted', 'announced', 'depositing', 'awaiting_counter'].includes(swap.progress)) {
        try {
          const cancelDM = buildCancelDM(swapId, 'Cancelled by user');
          await deps.communications.sendDM(swap.escrowPubkey, cancelDM);
          logger.debug(LOG_TAG, `Sent cancel DM to escrow for swap ${swapId.slice(0, 12)}`);
        } catch (err) {
          logger.warn(LOG_TAG, `Failed to send cancel DM to escrow for swap ${swapId}:`, err);
        }
      }

      // Notify counterparty (best-effort)
      if (swap.counterpartyPubkey) {
        try {
          const dmContent = buildRejectionDM(swapId, 'Cancelled by counterparty');
          await deps.communications.sendDM(swap.counterpartyPubkey, dmContent);
        } catch {
          // Best-effort
        }
      }

      // Transition to cancelled
      await this.transitionProgress(swap, 'cancelled', { error: 'Cancelled by user' });

      // depositsReturned will be updated when escrow sends deposit returns via invoice:return_received
      deps.emitEvent('swap:cancelled', {
        swapId,
        reason: 'explicit',
        depositsReturned: false,
      });
    });
  }

  /**
   * Resolve a swap ID from a full 64-char hex string or a unique prefix (min 4 chars).
   * Matches against all known swaps (active + terminal in current session).
   *
   * @param idOrPrefix - Full swap ID or unique hex prefix (min 4 chars).
   * @returns The full 64-char swap ID.
   * @throws {SphereError} `SWAP_NOT_FOUND` if no match or ambiguous prefix.
   * @throws {SphereError} `SWAP_INVALID_DEAL` if prefix is too short or not hex.
   */
  resolveSwapId(idOrPrefix: string): string {
    const trimmed = idOrPrefix.trim();

    // Full ID — return as-is
    if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed;

    // Must be at least 4 hex chars
    if (!/^[0-9a-f]{4,}$/i.test(trimmed)) {
      throw new SphereError(
        `Invalid swap ID: "${trimmed}". Must be a 64-char hex string or a prefix of at least 4 hex characters.`,
        'SWAP_INVALID_DEAL',
      );
    }

    const lower = trimmed.toLowerCase();
    const matched = this.getSwaps().filter(s => s.swapId.startsWith(lower));

    if (matched.length === 0) {
      throw new SphereError(`No swap found matching prefix: ${trimmed}`, 'SWAP_NOT_FOUND');
    }
    if (matched.length > 1) {
      throw new SphereError(
        `Ambiguous prefix "${trimmed}" matches ${matched.length} swaps. Use more characters.`,
        'SWAP_NOT_FOUND',
      );
    }

    return matched[0].swapId;
  }

  // T2.4: IMPLEMENTATION END

  // =========================================================================
  // T2.5: IMPLEMENTATION START — DM processing handlers
  // =========================================================================

  /**
   * Handle an incoming DM that may be a swap-related message.
   * Dispatches to the appropriate handler based on message type.
   * All errors are caught and logged — never propagated.
   *
   * @param dm - The incoming direct message.
   */
  private handleIncomingDM(dm: {
    readonly content: string;
    readonly senderPubkey: string;
    readonly senderNametag?: string;
    readonly timestamp?: number;
  }): void {
    // Quick check: skip non-swap DMs early
    if (!isSwapDM(dm.content)) return;

    // Parse the DM into a typed discriminated union
    const parsed = parseSwapDM(dm.content);
    if (!parsed) return;

    // Wrap everything in a promise chain — NEVER propagate errors from DM handler
    void (async () => {
      try {
        switch (parsed.kind) {
          // =================================================================
          // P2P: swap_proposal (§12.1)
          // =================================================================
          case 'proposal': {
            const proposalMsg = parsed.payload;
            const manifest = proposalMsg.manifest;


            // Validate version (accept v1 and v2)
            if (proposalMsg.version !== 1 && proposalMsg.version !== 2) return;

            // Validate manifest integrity: swap_id matches SHA-256(JCS(fields))
            if (!verifyManifestIntegrity(manifest)) {
              if (this.config.debug) {
                logger.debug(LOG_TAG, `Proposal ignored: manifest integrity check failed for ${manifest.swap_id}`);
              }
              return;
            }

            // Validate manifest fields
            const validation = validateManifest(manifest);
            if (!validation.valid) {
              if (this.config.debug) {
                logger.debug(LOG_TAG, `Proposal ignored: manifest validation failed: ${validation.errors.join(', ')}`);
              }
              return;
            }

            // Check pending swap limit
            const pendingCount = Array.from(this.swaps.values()).filter(s => !isTerminalProgress(s.progress)).length;
            if (pendingCount >= this.config.maxPendingSwaps) {
              if (this.config.debug) {
                logger.debug(LOG_TAG, `Proposal ignored: pending swap limit (${this.config.maxPendingSwaps}) reached`);
              }
              return;
            }

            // Check for duplicate swap_id (active or previously terminal)
            if (this.swaps.has(manifest.swap_id) || this.terminalSwapIds.has(manifest.swap_id)) {
              if (this.config.debug) {
                logger.debug(LOG_TAG, `Proposal ignored: duplicate/terminal swap_id ${manifest.swap_id}`);
              }
              return;
            }

            // Determine role: check if our address matches one of the manifest parties
            const deps = this.deps!;
            const activeAddresses = deps.getActiveAddresses();
            const ourAddresses = new Set<string>();
            for (const addr of activeAddresses) {
              if (addr.directAddress) ourAddresses.add(addr.directAddress);
            }
            // Also check the current identity's direct address
            if (deps.identity.directAddress) {
              ourAddresses.add(deps.identity.directAddress);
            }

            const isPartyA = ourAddresses.has(manifest.party_a_address);
            const isPartyB = ourAddresses.has(manifest.party_b_address);


            if (!isPartyA && !isPartyB) {
              if (this.config.debug) {
                logger.debug(LOG_TAG, `Proposal ignored: neither party address matches our addresses`);
              }
              return;
            }

            // Reconstruct SwapDeal from manifest + escrow address
            const deal: SwapDeal = {
              partyA: manifest.party_a_address,
              partyB: manifest.party_b_address,
              partyACurrency: manifest.party_a_currency_to_change,
              partyAAmount: manifest.party_a_value_to_change,
              partyBCurrency: manifest.party_b_currency_to_change,
              partyBAmount: manifest.party_b_value_to_change,
              timeout: manifest.timeout,
              escrowAddress: proposalMsg.escrow,
            };

            // Verify sender is the other party in the manifest (defense against impersonation).
            // Note: dm.senderPubkey is the transport pubkey (HKDF-derived), while resolve()
            // returns chainPubkey (secp256k1) and transportPubkey. Compare against transportPubkey.
            const counterpartyAddress = isPartyA ? manifest.party_b_address : manifest.party_a_address;
            try {
              const counterpartyPeer = await deps.resolve(counterpartyAddress);
              if (counterpartyPeer) {
                // Peer found: transportPubkey must be present and match sender
                // If transportPubkey is missing, we cannot verify the sender — reject
                if (!counterpartyPeer.transportPubkey || counterpartyPeer.transportPubkey !== dm.senderPubkey) {
                  if (this.config.debug) {
                    logger.debug(LOG_TAG, `Proposal sender mismatch: expected transport ${counterpartyPeer.transportPubkey?.slice(0, 16) ?? '(none)'}, got ${dm.senderPubkey?.slice(0, 16)}`);
                  }
                  return; // Sender mismatch or unverifiable — drop silently
                }
              }
              // If counterpartyPeer is null (not yet in relay), allow the proposal to proceed.
              // v2 proposals have mandatory chain pubkey verification below, which will catch fakes.
              // v1 proposals rely on transport-layer authentication (NIP-17 sealed-sender).
            } catch {
              // Resolution error — drop for security (cannot authenticate sender)
              if (this.config.debug) {
                logger.debug(LOG_TAG, `Proposal ${manifest.swap_id}: peer resolution error, dropping`);
              }
              return;
            }

            // v2: Verify proposer's signature and chain pubkey
            let proposerSignature: string | undefined;
            let proposerChainPubkey: string | undefined;
            if (proposalMsg.version === 2) {
              proposerSignature = proposalMsg.proposer_signature;
              proposerChainPubkey = proposalMsg.proposer_chain_pubkey;

              if (!proposerSignature || !proposerChainPubkey) {
                if (this.config.debug) {
                  logger.debug(LOG_TAG, `v2 proposal ignored: missing signature or pubkey`);
                }
                return;
              }

              // Verify the escrow_address is present in v2 manifests
              const escrowAddr = manifest.escrow_address;
              if (!escrowAddr) {
                if (this.config.debug) {
                  logger.debug(LOG_TAG, `v2 proposal ignored: manifest missing escrow_address`);
                }
                return;
              }

              // Verify proposer's signature over the swap consent message
              if (!verifySwapSignature(manifest.swap_id, escrowAddr, proposerSignature, proposerChainPubkey)) {
                if (this.config.debug) {
                  logger.debug(LOG_TAG, `v2 proposal ${manifest.swap_id}: invalid proposer signature`);
                }
                return;
              }

              // Mandatory peer resolution for v2 — verify proposer's chain pubkey
              const proposerIsPartyA = !ourAddresses.has(manifest.party_a_address);
              const expectedAddress = proposerIsPartyA
                ? manifest.party_a_address
                : manifest.party_b_address;
              const proposerPeer = await deps.resolve(expectedAddress);
              if (!proposerPeer || proposerPeer.chainPubkey !== proposerChainPubkey) {
                if (this.config.debug) {
                  logger.debug(LOG_TAG, `v2 proposal ${manifest.swap_id}: ${!proposerPeer ? 'peer resolution failed' : 'chain pubkey mismatch'}`);
                }
                return;
              }

              // Verify nametag bindings if present.
              // For the proposer's own binding: verifyNametagBinding checks internal
              // signature consistency, but we must also cross-reference binding.chain_pubkey
              // against the already-verified proposerChainPubkey. Without this, a malicious
              // peer could craft a binding with a different chain_pubkey that still passes
              // verifyNametagBinding (valid self-signature, wrong identity).
              if (proposalMsg.auxiliary) {
                const aux = proposalMsg.auxiliary;
                if (aux.party_a_binding) {
                  const proposerBinding = proposerIsPartyA ? aux.party_a_binding : null;
                  if (!verifyNametagBinding(aux.party_a_binding, manifest.swap_id) ||
                      aux.party_a_binding.direct_address !== manifest.party_a_address ||
                      (proposerBinding && proposerBinding.chain_pubkey !== proposerChainPubkey)) {
                    logger.debug(LOG_TAG, `Proposal ${manifest.swap_id}: invalid party_a nametag binding`);
                    return;
                  }
                }
                if (aux.party_b_binding) {
                  const proposerBinding = !proposerIsPartyA ? aux.party_b_binding : null;
                  if (!verifyNametagBinding(aux.party_b_binding, manifest.swap_id) ||
                      aux.party_b_binding.direct_address !== manifest.party_b_address ||
                      (proposerBinding && proposerBinding.chain_pubkey !== proposerChainPubkey)) {
                    logger.debug(LOG_TAG, `Proposal ${manifest.swap_id}: invalid party_b nametag binding`);
                    return;
                  }
                }
              }
            }

            // Resolve escrow address to store escrowPubkey for later DM verification
            let escrowPubkey: string | undefined;
            let escrowDirectAddr: string | undefined;
            try {
              const escrowResult = await resolveEscrowAddress(
                deal, this.config, deps.resolve,
              );
              escrowPubkey = escrowResult.escrowPubkey;
              escrowDirectAddr = escrowResult.escrowDirectAddress;
            } catch {
              // Best-effort: escrow may not be resolvable yet
              if (this.config.debug) {
                logger.debug(LOG_TAG, `Could not resolve escrow for proposal ${manifest.swap_id}`);
              }
            }

            // Create SwapRef
            const swap: SwapRef = {
              swapId: manifest.swap_id,
              deal,
              manifest,
              role: 'acceptor',
              progress: 'proposed',
              counterpartyPubkey: dm.senderPubkey,
              counterpartyNametag: dm.senderNametag,
              escrowPubkey,
              escrowDirectAddress: escrowDirectAddr,
              payoutVerified: false,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              proposerSignature,
              proposerChainPubkey,
              auxiliary: proposalMsg.version === 2 ? proposalMsg.auxiliary : undefined,
              protocolVersion: proposalMsg.version,
            };

            // Persist
            this.swaps.set(manifest.swap_id, swap);
            await this.persistSwap(swap);

            // Emit swap:proposal_received
            deps.emitEvent('swap:proposal_received', {
              swapId: manifest.swap_id,
              deal: { ...deal },
              senderPubkey: dm.senderPubkey,
              senderNametag: dm.senderNametag,
            });

            if (this.config.debug) {
              logger.debug(LOG_TAG, `Received proposal ${manifest.swap_id} from ${dm.senderPubkey}`);
            }
            break;
          }

          // =================================================================
          // P2P: swap_acceptance (§12.2)
          // =================================================================
          case 'acceptance': {
            const acceptMsg = parsed.payload;
            const swapId = acceptMsg.swap_id;

            // Look up swap — must exist, role='proposer'
            const swap = this.swaps.get(swapId);
            if (!swap) return;
            if (swap.role !== 'proposer') return;

            // In v2, acceptance is informational. The proposer may already be in
            // 'announced' state if the escrow's announce_result arrived first.
            if (swap.progress !== 'proposed' && swap.progress !== 'accepted') return;

            // Verify sender is the counterparty
            if (dm.senderPubkey !== swap.counterpartyPubkey) return;

            // Skip stale acceptances from a previous proposal instance
            if (dm.timestamp && dm.timestamp < swap.createdAt) return;

            const deps = this.deps!;

            // Only transition if still in 'proposed'
            if (swap.progress === 'proposed') {
              await this.withSwapGate(swapId, async () => {
                // Re-check inside gate — a concurrent operation (e.g., cancelSwap, timeout)
                // may have already advanced the swap out of 'proposed'.
                if (swap.progress !== 'proposed') {
                  return; // Silently ignore — not a duplicate acceptance, just a race
                }

                // v2: For v2 swaps, REQUIRE v2 acceptance with signature (downgrade attack prevention)
                // Check BEFORE clearing the timer — a malformed/wrong-version acceptance must not
                // disarm the proposal timeout (otherwise a bad actor can strand the swap indefinitely)
                if (swap.protocolVersion === 2) {
                  if (acceptMsg.version !== 2 || !acceptMsg.acceptor_signature || !acceptMsg.acceptor_chain_pubkey) {
                    logger.debug(LOG_TAG, `Acceptance for ${swapId}: v2 swap requires v2 acceptance with signature (got version=${acceptMsg.version})`);
                    return; // Reject — do NOT clear timer
                  }
                }
                // v2: Verify acceptor signature BEFORE state transition (and before clearing timer)
                if (acceptMsg.version === 2 && acceptMsg.acceptor_signature && acceptMsg.acceptor_chain_pubkey) {
                  const escrowAddr = swap.manifest.escrow_address ?? swap.escrowDirectAddress;
                  if (!escrowAddr) {
                    logger.debug(LOG_TAG, `Acceptance for ${swapId}: cannot verify v2 signature — escrow address unknown`);
                    return; // Reject — do NOT clear timer
                  }
                  const valid = verifySwapSignature(
                    swap.manifest.swap_id, escrowAddr,
                    acceptMsg.acceptor_signature, acceptMsg.acceptor_chain_pubkey,
                  );
                  if (!valid) {
                    logger.debug(LOG_TAG, `Acceptance for ${swapId}: invalid acceptor signature`);
                    return; // Reject — do NOT clear timer
                  }
                }

                // All checks passed — now safe to clear the proposal timer
                this.clearLocalTimer(swapId);

                // Snapshot fields mutated before transitionProgress so we can fully revert
                // in-memory state if persistSwap throws (incomplete rollback previously left
                // acceptorSignature set on the swap object while storage had the old state).
                const prevProgress = swap.progress;
                const prevUpdatedAt = swap.updatedAt;
                const prevAcceptorSignature = (swap as { acceptorSignature?: string }).acceptorSignature;

                // Assign acceptor signature (v2 only) BEFORE transitionProgress so the
                // single atomic persist captures it. A crash between transitionProgress and
                // a separate persistSwap would leave the swap in 'accepted' without a
                // signature, breaking crash-recovery announce on restart.
                if (acceptMsg.version === 2 && acceptMsg.acceptor_signature) {
                  (swap as { acceptorSignature?: string }).acceptorSignature = acceptMsg.acceptor_signature;
                }

                // Transition to 'accepted'.
                // transitionProgress mutates swap.progress in memory BEFORE persisting.
                // If persistSwap throws, roll back ALL in-memory mutations so the swap
                // remains visibly 'proposed' and the proposal timer can still fire.
                try {
                  await this.transitionProgress(swap, 'accepted');
                } catch (err) {
                  swap.progress = prevProgress;   // roll back in-memory
                  swap.updatedAt = prevUpdatedAt;
                  (swap as { acceptorSignature?: string }).acceptorSignature = prevAcceptorSignature;
                  this.startProposalTimer(swapId); // re-arm so proposal can time out
                  // Best-effort: if persistSwap wrote the record before the index write
                  // failed, the storage record now has the wrong (advanced) state.
                  // Re-persist the rolled-back state to heal the partial write.
                  // Deep-copy nested objects before the fire-and-forget: the gate will be
                  // released (throw re-throws below) and the next gate acquisition can mutate
                  // swap.deal / swap.manifest / swap.auxiliary before persistSwap serializes.
                  // A shallow copy shares those references; deep-copy makes the snapshot safe
                  // even if persistSwap ever adds an `await` before JSON.stringify.
                  const rollbackSnapshot = {
                    ...swap,
                    deal: { ...swap.deal },
                    manifest: { ...swap.manifest },
                    ...(swap.auxiliary ? { auxiliary: { ...swap.auxiliary } } : {}),
                  };
                  this.persistSwap(rollbackSnapshot).catch((e) =>
                    logger.warn(LOG_TAG, `Failed to persist rollback for ${swapId}:`, e),
                  );
                  throw err;
                }

                // Emit swap:accepted
                deps.emitEvent('swap:accepted', {
                  swapId,
                  role: swap.role,
                });

                // v2: Proposer does NOT announce to escrow — Bob already did it.
                // Just wait for announce_result from escrow.
                // v1 fallback: announce from proposer side
                if (!swap.protocolVersion || swap.protocolVersion < 2) {
                  try {
                    if (!swap.escrowPubkey) {
                      const { escrowPubkey, escrowDirectAddress } = await resolveEscrowAddress(swap.deal, this.config, deps.resolve);
                      swap.escrowPubkey = escrowPubkey;
                      swap.escrowDirectAddress = escrowDirectAddress;
                      await this.persistSwap(swap);
                    }
                    await sendAnnounce(deps.communications, swap.escrowPubkey!, swap.manifest);
                  } catch (err) {
                    logger.warn(LOG_TAG, `Failed to announce swap ${swapId} to escrow:`, err);
                    await this.transitionProgress(swap, 'failed', { error: 'Failed to announce to escrow' });
                    deps.emitEvent('swap:failed', { swapId, error: 'Failed to announce to escrow' });
                  }
                }
              });
            }
            break;
          }

          // =================================================================
          // P2P: swap_rejection (§12.3)
          // =================================================================
          case 'rejection': {
            const rejectMsg = parsed.payload;
            const swapId = rejectMsg.swap_id;

            // Look up swap — must exist, in 'proposed' state, proposer only
            const swap = this.swaps.get(swapId);
            if (!swap) return;
            if (swap.progress !== 'proposed' || swap.role !== 'proposer') return;

            // Verify sender is counterparty
            if (dm.senderPubkey !== swap.counterpartyPubkey) return;

            // Skip stale rejections from a previous proposal instance
            // (same swap_id re-proposed after rejection — DM replay delivers the old rejection)
            if (dm.timestamp && dm.timestamp < swap.createdAt) return;

            const deps = this.deps!;

            await this.withSwapGate(swapId, async () => {
              // Skip if already terminal (e.g., replayed rejection DM)
              if (isTerminalProgress(swap.progress)) return;

              // Clear proposal timer
              this.clearLocalTimer(swapId);

              // Transition to 'cancelled'
              await this.transitionProgress(swap, 'cancelled', {
                error: rejectMsg.reason ?? 'Rejected by counterparty',
              });

              // Emit swap:rejected
              deps.emitEvent('swap:rejected', {
                swapId,
                reason: rejectMsg.reason,
              });

              // Also emit swap:cancelled
              deps.emitEvent('swap:cancelled', {
                swapId,
                reason: 'explicit',
                depositsReturned: false,
              });
            });
            break;
          }

          // =================================================================
          // Escrow messages (§12.4)
          // =================================================================
          case 'escrow': {
            const msg = parsed.payload;

            // Extract swap_id from the escrow message (present on most types)
            const swapId = 'swap_id' in msg ? (msg as { swap_id?: string }).swap_id : undefined;

            // Lazy escrow resolution: if this swap has no escrowPubkey (possible when
            // transient resolution failure occurred during proposal receipt), attempt to
            // resolve it now. Without this, isFromExpectedEscrow() would silently drop
            // every escrow DM for the swap, leaving it stranded until the next restart.
            if (swapId) {
              const swapForResolution = this.swaps.get(swapId);
              if (swapForResolution && !swapForResolution.escrowPubkey) {
                const depsForResolution = this.deps;
                if (depsForResolution) {
                  try {
                    const resolved = await resolveEscrowAddress(
                      swapForResolution.deal, this.config, depsForResolution.resolve,
                    );
                    swapForResolution.escrowPubkey = resolved.escrowPubkey;
                    swapForResolution.escrowDirectAddress = resolved.escrowDirectAddress;
                    await this.persistSwap(swapForResolution);
                  } catch {
                    // Still best-effort — will retry on the next escrow DM
                  }
                }
              }
            }

            switch (msg.type) {
              // ---------------------------------------------------------------
              // announce_result (§12.4.1)
              // ---------------------------------------------------------------
              case 'announce_result': {
                if (!swapId) return;
                const swap = this.swaps.get(swapId);
                if (!swap) return;

                // Verify escrow sender
                if (!this.isFromExpectedEscrow(dm.senderPubkey, swap)) return;

                // Allow proposed → announced (v2: Bob announced directly, Alice gets announce_result
                // before the acceptance DM arrives). Also allow accepted → announced (normal flow).
                if (swap.progress !== 'accepted' && swap.progress !== 'proposed') {
                  if (this.config.debug) {
                    logger.debug(LOG_TAG, `announce_result for ${swapId} ignored: progress is ${swap.progress}`);
                  }
                  return;
                }

                await this.withSwapGate(swapId, async () => {
                  // TOCTOU guard — re-check state after acquiring gate.
                  // Must still be in accepted/proposed; a concurrent cancellation, failure,
                  // or second announce_result DM may have advanced or terminated the swap.
                  if (swap.progress !== 'accepted' && swap.progress !== 'proposed') return;

                  // Store depositInvoiceId and escrowState
                  swap.depositInvoiceId = msg.deposit_invoice_id;
                  swap.escrowState = msg.state;
                  if (swap.depositInvoiceId) {
                    this.invoiceToSwapIndex.set(swap.depositInvoiceId, swapId);
                  }
                  swap.updatedAt = Date.now();
                  await this.persistSwap(swap);
                  // Don't transition yet — wait for invoice_delivery
                });
                break;
              }

              // ---------------------------------------------------------------
              // invoice_delivery (§12.4.2 + §12.4.3)
              // ---------------------------------------------------------------
              case 'invoice_delivery': {
                if (!swapId) return;
                const swap = this.swaps.get(swapId);
                if (!swap) return;

                // Verify escrow sender
                if (!this.isFromExpectedEscrow(dm.senderPubkey, swap)) return;

                const deps = this.deps!;

                if (msg.invoice_type === 'deposit') {
                  // §12.4.2: Deposit invoice delivery
                  await this.withSwapGate(swapId, async () => {
                    // Skip terminal swaps — late delivery after cancel/fail creates orphan invoices.
                    if (isTerminalProgress(swap.progress)) return;

                    try {
                      await deps.accounting.importInvoice(msg.invoice_token);
                    } catch (err) {
                      logger.error(LOG_TAG, `Failed to import deposit invoice for swap ${swapId}:`, err);
                      await this.transitionProgress(swap, 'failed', {
                        error: `Deposit invoice import failed: ${err instanceof Error ? err.message : String(err)}`,
                      });
                      deps.emitEvent('swap:failed', {
                        swapId,
                        error: 'Deposit invoice import failed',
                      });
                      return;
                    }

                    // Verify deposit invoice terms match expectations
                    const depositInvoiceId = msg.invoice_id ?? swap.depositInvoiceId;
                    if (depositInvoiceId) {
                      const invoice = deps.accounting.getInvoice(depositInvoiceId) as {
                        invoiceId: string;
                        terms: {
                          targets: Array<{
                            address: string;
                            assets: Array<{ coin?: [string, string] }>;
                          }>;
                        };
                      } | null;

                      if (!invoice) {
                        logger.warn(LOG_TAG, `Deposit invoice ${depositInvoiceId} imported but not found locally for swap ${swapId}`);
                        await this.transitionProgress(swap, 'failed', {
                          error: 'Deposit invoice imported but not retrievable',
                        });
                        deps.emitEvent('swap:failed', { swapId, error: 'Deposit invoice imported but not retrievable' });
                        return;
                      }
                      {
                        const terms = invoice.terms;
                        // Verify single target
                        if (terms.targets.length !== 1) {
                          logger.warn(LOG_TAG, `Deposit invoice for swap ${swapId} has ${terms.targets.length} targets, expected 1`);
                          await this.transitionProgress(swap, 'failed', {
                            error: 'Deposit invoice has unexpected number of targets',
                          });
                          deps.emitEvent('swap:failed', { swapId, error: 'Deposit invoice has unexpected number of targets' });
                          return;
                        }
                        // Verify target address matches escrow
                        if (!swap.escrowDirectAddress) {
                          logger.warn(LOG_TAG, `Cannot verify deposit invoice target for swap ${swapId}: escrow address not resolved`);
                          await this.transitionProgress(swap, 'failed', { error: 'Cannot verify deposit invoice: escrow address unknown' });
                          deps.emitEvent('swap:failed', { swapId, error: 'Cannot verify deposit invoice: escrow address unknown' });
                          return;
                        }
                        if (terms.targets[0].address !== swap.escrowDirectAddress) {
                          logger.warn(LOG_TAG, `Deposit invoice for swap ${swapId} targets wrong address`);
                          await this.transitionProgress(swap, 'failed', {
                            error: 'Deposit invoice targets wrong address',
                          });
                          deps.emitEvent('swap:failed', { swapId, error: 'Deposit invoice targets wrong address' });
                          return;
                        }
                        // Verify 2 assets with correct currencies/amounts
                        const assets = terms.targets[0].assets;
                        if (assets.length !== 2) {
                          logger.warn(LOG_TAG, `Deposit invoice for swap ${swapId} has ${assets.length} assets, expected 2`);
                          await this.transitionProgress(swap, 'failed', {
                            error: 'Deposit invoice has unexpected number of assets',
                          });
                          deps.emitEvent('swap:failed', { swapId, error: 'Deposit invoice has unexpected number of assets' });
                          return;
                        }
                        // Match currencies and amounts against manifest
                        const expectedAssets = [
                          { coinId: swap.manifest.party_a_currency_to_change, amount: swap.manifest.party_a_value_to_change },
                          { coinId: swap.manifest.party_b_currency_to_change, amount: swap.manifest.party_b_value_to_change },
                        ];
                        const invoiceAssets = assets.map(a => ({
                          coinId: a.coin?.[0],
                          amount: a.coin?.[1],
                        }));
                        const assetsMatch = expectedAssets.every(ea =>
                          invoiceAssets.some(ia => ia.coinId === ea.coinId && ia.amount === ea.amount),
                        );
                        if (!assetsMatch) {
                          logger.warn(LOG_TAG, `Deposit invoice for swap ${swapId} has mismatched assets`);
                          await this.transitionProgress(swap, 'failed', {
                            error: 'Deposit invoice assets do not match manifest',
                          });
                          deps.emitEvent('swap:failed', { swapId, error: 'Deposit invoice assets do not match manifest' });
                          return;
                        }
                      }
                    }

                    // Set depositInvoiceId if not already set (announce_result may not have arrived)
                    if (msg.invoice_id && !swap.depositInvoiceId) {
                      swap.depositInvoiceId = msg.invoice_id;
                    }
                    if (swap.depositInvoiceId) {
                      this.invoiceToSwapIndex.set(swap.depositInvoiceId, swapId);
                    }

                    // DM ORDERING: if swap is still in 'accepted' or 'proposed' (v2: proposer
                    // may receive invoice_delivery before acceptance DM), transition directly
                    // to 'announced'.
                    if (swap.progress === 'accepted' || swap.progress === 'proposed') {
                      // v2 fast path: if invoice_delivery arrives before swap_acceptance DM,
                      // the swap jumps proposed → announced. Emit swap:accepted synthetically
                      // so UIs depending on that event don't miss it.
                      const skippedAccepted = swap.progress === 'proposed';
                      await this.transitionProgress(swap, 'announced');
                      if (skippedAccepted) {
                        deps.emitEvent('swap:accepted', { swapId, role: swap.role });
                      }
                      deps.emitEvent('swap:announced', {
                        swapId,
                        depositInvoiceId: swap.depositInvoiceId ?? '',
                      });
                      // Start local timer
                      this.startLocalTimer(swap);
                    } else if (swap.progress === 'announced' || swap.progress === 'depositing' ||
                               swap.progress === 'awaiting_counter') {
                      // Already past accepted — just persist the update
                      swap.updatedAt = Date.now();
                      await this.persistSwap(swap);
                    }
                  });
                } else if (msg.invoice_type === 'payout') {
                  // §12.4.3: Payout invoice delivery
                  let shouldAutoVerify = false;
                  await this.withSwapGate(swapId, async () => {
                    // Skip terminal swaps — late delivery after cancel/fail creates orphan invoices.
                    if (isTerminalProgress(swap.progress)) return;
                    try {
                      await deps.accounting.importInvoice(msg.invoice_token);
                    } catch (err) {
                      logger.error(LOG_TAG, `Failed to import payout invoice for swap ${swapId}:`, err);
                      return;
                    }

                    // Store payoutInvoiceId
                    if (msg.invoice_id) {
                      swap.payoutInvoiceId = msg.invoice_id;
                      // Register in index so in-session invoice events (invoice:covered,
                      // invoice:return_received) route correctly to this swap.
                      this.invoiceToSwapIndex.set(msg.invoice_id, swapId);
                    }
                    swap.updatedAt = Date.now();
                    await this.persistSwap(swap);

                    // Emit swap:payout_received
                    deps.emitEvent('swap:payout_received', {
                      swapId,
                      payoutInvoiceId: swap.payoutInvoiceId ?? '',
                    });

                    shouldAutoVerify = true;
                  });

                  // Auto-verification runs OUTSIDE the gate so verifyPayout can acquire its own
                  // gate without deadlocking. The gate above will have fully released before
                  // verifyPayout's internal gate runs.
                  if (shouldAutoVerify) {
                    this.verifyPayout(swapId).catch((err) => {
                      if (this.config.debug) {
                        logger.debug(LOG_TAG, `Auto-verification for swap ${swapId} deferred:`, err);
                      }
                    });
                  }
                }
                break;
              }

              // ---------------------------------------------------------------
              // status_result (§12.4.4)
              // ---------------------------------------------------------------
              case 'status_result': {
                if (!swapId) return;
                const swap = this.swaps.get(swapId);
                if (!swap) return;

                // Verify escrow sender
                if (!this.isFromExpectedEscrow(dm.senderPubkey, swap)) return;

                const deps = this.deps!;

                await this.withSwapGate(swapId, async () => {
                  // Skip terminal swaps — no state advancement or persistence needed,
                  // and failPayout direct-mutation may have left the swap as 'failed'
                  // while still in this.swaps.
                  if (isTerminalProgress(swap.progress)) return;

                  // Update escrowState
                  swap.escrowState = msg.state;
                  swap.updatedAt = Date.now();
                  await this.persistSwap(swap);

                  // Map escrow state to client progress and advance if necessary
                  const mappedProgress = mapEscrowStateToProgress(msg.state);
                  if (mappedProgress && isTerminalProgress(mappedProgress) && !isTerminalProgress(swap.progress)) {
                    if (mappedProgress === 'completed') {
                      await this.transitionProgress(swap, 'completed', { payoutVerified: false });
                      // Only emit swap:completed here if no payout invoice has been received.
                      // When a payout invoice exists, verifyPayout (auto-triggered by invoice_delivery)
                      // will emit swap:completed with payoutVerified=true — emitting now would cause
                      // a duplicate event with conflicting payoutVerified values.
                      if (!swap.payoutInvoiceId) {
                        deps.emitEvent('swap:completed', { swapId, payoutVerified: false });
                      } else {
                        // Payout invoice exists but a prior auto-verify may have returned false
                        // before this status_result arrived. Schedule a fresh attempt so
                        // swap:completed is emitted (verifyPayout's returnFalse() ensures it fires
                        // even on transient failure). Runs OUTSIDE this gate via fire-and-forget.
                        this.verifyPayout(swapId).catch((err) => {
                          if (this.config.debug) {
                            logger.debug(LOG_TAG, `Deferred verify for swap ${swapId} after status_result:`, err);
                          }
                        });
                      }
                    } else if (mappedProgress === 'cancelled') {
                      await this.transitionProgress(swap, 'cancelled', { error: `Escrow state: ${msg.state}` });
                      deps.emitEvent('swap:cancelled', { swapId, reason: 'escrow_failed', depositsReturned: false });
                    } else if (mappedProgress === 'failed') {
                      await this.transitionProgress(swap, 'failed', { error: `Escrow state: ${msg.state}` });
                      deps.emitEvent('swap:failed', { swapId, error: `Escrow reported: ${msg.state}` });
                    }
                  } else if (mappedProgress && !isTerminalProgress(mappedProgress) && !isTerminalProgress(swap.progress)) {
                    // Advance local progress if escrow is further along
                    const progressOrder: SwapProgress[] = [
                      'proposed', 'accepted', 'announced', 'depositing', 'awaiting_counter', 'concluding',
                    ];
                    const currentIdx = progressOrder.indexOf(swap.progress);
                    const targetIdx = progressOrder.indexOf(mappedProgress);
                    if (targetIdx > currentIdx) {
                      try {
                        await this.transitionProgress(swap, mappedProgress);
                      } catch {
                        // Transition not valid from current state — ignore
                      }
                    }
                  }
                });
                break;
              }

              // ---------------------------------------------------------------
              // payment_confirmation (§12.4.5)
              // ---------------------------------------------------------------
              case 'payment_confirmation': {
                if (!swapId) return;
                const swap = this.swaps.get(swapId);
                if (!swap) return;

                // Verify escrow sender
                if (!this.isFromExpectedEscrow(dm.senderPubkey, swap)) return;

                const deps = this.deps!;

                await this.withSwapGate(swapId, async () => {
                  if (!isTerminalProgress(swap.progress) && swap.progress !== 'concluding') {
                    try {
                      await this.transitionProgress(swap, 'concluding');
                      deps.emitEvent('swap:concluding', { swapId });
                    } catch {
                      // Already in concluding or transition not valid — ignore
                    }
                  }
                });
                break;
              }

              // ---------------------------------------------------------------
              // swap_cancelled (§12.4.6)
              // ---------------------------------------------------------------
              case 'swap_cancelled': {
                if (!swapId) return;
                const swap = this.swaps.get(swapId);
                if (!swap) return;

                // Verify escrow sender
                if (!this.isFromExpectedEscrow(dm.senderPubkey, swap)) return;

                // Skip stale cancellation DMs
                if (dm.timestamp && dm.timestamp < swap.createdAt) return;
                if (isTerminalProgress(swap.progress)) return;

                const deps = this.deps!;

                await this.withSwapGate(swapId, async () => {
                  // TOCTOU guard — swap may have completed or failed while waiting for gate.
                  if (isTerminalProgress(swap.progress)) return;

                  this.clearLocalTimer(swapId);

                  await this.transitionProgress(swap, 'cancelled', {
                    error: `Escrow cancelled: ${msg.reason}`,
                  });

                  deps.emitEvent('swap:cancelled', {
                    swapId,
                    reason: msg.reason === 'timeout' ? 'timeout' : 'escrow_failed',
                    depositsReturned: msg.deposits_returned ?? false,
                  });
                });
                break;
              }

              // ---------------------------------------------------------------
              // bounce_notification (§12.4.7)
              // ---------------------------------------------------------------
              case 'bounce_notification': {
                if (!swapId) return;
                const swap = this.swaps.get(swapId);
                if (!swap) return;

                // Verify escrow sender
                if (!this.isFromExpectedEscrow(dm.senderPubkey, swap)) return;

                const deps = this.deps!;

                // Log warning with bounce reason
                logger.warn(LOG_TAG, `Swap ${swapId}: deposit bounced by escrow — reason: ${msg.reason}`);

                if (msg.reason === 'WRONG_CURRENCY') {
                  logger.error(LOG_TAG, `Swap ${swapId}: deposit sent with wrong currency — this indicates a bug in the deposit logic`);
                }

                // All bounce handling inside the gate so that swap:bounce_received fires
                // after any state transition — listeners see a consistent swap.progress.
                await this.withSwapGate(swapId, async () => {
                  // TOCTOU guard — if swap became terminal while waiting for gate
                  // (relay replay, concurrent cancel/fail), suppress all events.
                  if (isTerminalProgress(swap.progress)) return;

                  if (msg.reason === 'SWAP_NOT_FOUND' || msg.reason === 'SWAP_CLOSED') {
                    await this.transitionProgress(swap, 'failed', {
                      error: `Escrow bounce: ${msg.reason}`,
                    });
                    deps.emitEvent('swap:failed', {
                      swapId,
                      error: `Escrow does not recognize swap: ${msg.reason}`,
                    });
                  }
                  // Emit bounce_received inside gate — swap.progress is in its final state
                  deps.emitEvent('swap:bounce_received', {
                    swapId,
                    reason: msg.reason,
                    returnedAmount: msg.returned_amount,
                    returnedCurrency: msg.returned_currency,
                  });
                });
                break;
              }

              // ---------------------------------------------------------------
              // error (§12.4.8)
              // ---------------------------------------------------------------
              case 'error': {
                const errorSwapId = msg.swap_id;

                if (!errorSwapId) {
                  // Generic escrow error (no swap_id) — only log if the DM is recent (last 60s)
                  // to suppress stale error DMs replayed from the relay on every startup
                  if (dm.timestamp && (Date.now() - dm.timestamp) < 60_000) {
                    logger.error(LOG_TAG, `Escrow error: ${msg.error}`);
                  }
                  return;
                }

                const swap = this.swaps.get(errorSwapId);
                if (!swap) return;
                if (!this.isFromExpectedEscrow(dm.senderPubkey, swap)) return;

                // Skip stale error DMs from before the current swap instance
                if (dm.timestamp && dm.timestamp < swap.createdAt) return;

                logger.error(LOG_TAG, `Escrow error for swap ${errorSwapId.slice(0, 12)}: ${msg.error}`);

                const deps = this.deps!;

                // If swap is in 'accepted' state (error in response to announce), transition to 'failed'
                if (swap.progress === 'accepted') {
                  await this.withSwapGate(errorSwapId, async () => {
                    // TOCTOU guard — swap may have advanced (e.g., to announced) or been
                    // cancelled/failed by a concurrent handler while we waited for the gate.
                    if (swap.progress !== 'accepted') return;
                    await this.transitionProgress(swap, 'failed', {
                      error: `Escrow error: ${msg.error}`,
                    });
                    deps.emitEvent('swap:failed', {
                      swapId: errorSwapId,
                      error: msg.error,
                    });
                  });
                }
                // For other states: log only, do not change state
                break;
              }

              default:
                break;
            }
            break;
          }

          default:
            break;
        }
      } catch (err) {
        // NEVER propagate errors from DM handler
        logger.error(LOG_TAG, 'Error handling incoming swap DM:', err);
      }
    })();
  }

  /**
   * Check if a DM sender matches the expected escrow for a swap.
   * Compares the sender's transport pubkey (dm.senderPubkey) against the
   * escrowPubkey (transport pubkey) stored on the SwapRef during escrow resolution.
   *
   * @returns `true` if the sender matches the stored escrow pubkey,
   *          `false` if no escrowPubkey is stored (unknown escrow) or mismatch.
   */
  private isFromExpectedEscrow(senderPubkey: string, swap: SwapRef): boolean {
    if (!swap.escrowPubkey) return false; // unknown escrow = reject
    return senderPubkey === swap.escrowPubkey;
  }

  // T2.5: IMPLEMENTATION END

  // =========================================================================
  // T2.6: IMPLEMENTATION START — Invoice event subscriptions
  // =========================================================================

  /**
   * Subscribe to AccountingModule invoice events relevant to active swaps.
   * Maintains the invoiceId -> swapId reverse index and emits swap events
   * in response to deposit/payout invoice state changes.
   */
  private setupInvoiceEventSubscriptions(): void {
    const deps = this.deps!;

    // 1. invoice:payment — track individual deposit confirmations (§13.1)
    const unsubPayment = deps.accounting.on('invoice:payment', (data) => {
      try {
        const swapId = this.invoiceToSwapIndex.get(data.invoiceId);
        if (!swapId) return;

        const swap = this.swaps.get(swapId);
        if (!swap) return;
        if (isTerminalProgress(swap.progress)) return;

        // Only handle deposit invoice payments (not payout)
        if (data.invoiceId !== swap.depositInvoiceId) return;

        const transfer = data.transfer;

        // Determine which party deposited by matching coinId against manifest
        let party: 'A' | 'B';
        let requiredAmount: string;
        if (transfer.coinId === swap.manifest.party_a_currency_to_change) {
          party = 'A';
          requiredAmount = swap.manifest.party_a_value_to_change;
        } else if (transfer.coinId === swap.manifest.party_b_currency_to_change) {
          party = 'B';
          requiredAmount = swap.manifest.party_b_value_to_change;
        } else {
          // Unknown coinId — not attributable to either party
          return;
        }

        // Only emit swap:deposit_confirmed when the payment meets the required amount.
        // A dust payment in the correct coinId should not trigger a confirmation event —
        // the escrow validates actual amounts via invoice:covered, but consumers relying
        // on this event for UI confirmation should see accurate data.
        if (BigInt(transfer.amount) < BigInt(requiredAmount)) {
          return;
        }

        // Emit deposit confirmed event
        deps.emitEvent('swap:deposit_confirmed', {
          swapId,
          party,
          amount: transfer.amount,
          coinId: transfer.coinId,
        });

        // Determine local party's currency based on address match.
        // Use getActiveAddresses() rather than deps.identity.directAddress so that
        // multi-address wallets (where the swap address may not be the current active
        // address) are handled correctly.
        const activeDirectAddresses = new Set(
          deps.getActiveAddresses().map((a) => a.directAddress),
        );
        let localCurrency: string | undefined;
        if (activeDirectAddresses.has(swap.manifest.party_a_address)) {
          localCurrency = swap.manifest.party_a_currency_to_change;
        } else if (activeDirectAddresses.has(swap.manifest.party_b_address)) {
          localCurrency = swap.manifest.party_b_currency_to_change;
        }

        // If this is the local party's deposit and we are in 'depositing', advance
        if (localCurrency && transfer.coinId === localCurrency && swap.progress === 'depositing') {
          this.withSwapGate(swapId, async () => {
            // Re-check after acquiring gate (state may have changed)
            if (swap.progress === 'depositing') {
              await this.transitionProgress(swap, 'awaiting_counter');
            }
          }).catch((err) => {
            logger.warn(LOG_TAG, `Failed to transition swap ${swapId} to awaiting_counter:`, err);
          });
        }
      } catch (err) {
        logger.warn(LOG_TAG, 'Error handling invoice:payment for swap:', err);
      }
    });

    // 2. invoice:covered — both deposits confirmed (§13.2)
    const unsubCovered = deps.accounting.on('invoice:covered', (data) => {
      try {
        const swapId = this.invoiceToSwapIndex.get(data.invoiceId);
        if (!swapId) return;

        const swap = this.swaps.get(swapId);
        if (!swap) return;

        // Only handle deposit invoice
        if (data.invoiceId !== swap.depositInvoiceId) return;

        // Clear local timeout — escrow will now execute payouts
        this.clearLocalTimer(swapId);

        // Emit deposits covered event
        deps.emitEvent('swap:deposits_covered', { swapId });

        // Transition to concluding if not already terminal or concluding
        if (!isTerminalProgress(swap.progress) && swap.progress !== 'concluding' && swap.progress !== 'completed') {
          this.withSwapGate(swapId, async () => {
            if (!isTerminalProgress(swap.progress) && swap.progress !== 'concluding' && swap.progress !== 'completed') {
              await this.transitionProgress(swap, 'concluding');
            }
          }).catch((err) => {
            logger.warn(LOG_TAG, `Failed to transition swap ${swapId} to concluding:`, err);
          });
        }
      } catch (err) {
        logger.warn(LOG_TAG, 'Error handling invoice:covered for swap:', err);
      }
    });

    // 3. invoice:return_received — deposits returned after cancellation/timeout (§13.4)
    const unsubReturn = deps.accounting.on('invoice:return_received', (data) => {
      try {
        const swapId = this.invoiceToSwapIndex.get(data.invoiceId);
        if (!swapId) return;

        const swap = this.swaps.get(swapId);
        if (!swap) return;

        // Transition to cancelled (if needed) and emit events — all inside the gate
        // to ensure consumers observe consistent state (progress=cancelled before event fires).
        this.withSwapGate(swapId, async () => {
          if (!isTerminalProgress(swap.progress)) {
            await this.transitionProgress(swap, 'cancelled', {
              error: 'Deposits returned',
            });
            deps.emitEvent('swap:cancelled', {
              swapId,
              reason: 'timeout',
              depositsReturned: true,
            });
          }
          // Only emit deposit_returned for cancelled swaps (inside gate, after transition).
          // Stale or replayed invoice:return_received for a completed or failed swap is silently
          // ignored — emitting deposit_returned on a non-cancelled swap would confuse consumers.
          if (swap.progress === 'cancelled') {
            deps.emitEvent('swap:deposit_returned', {
              swapId,
              transfer: data.transfer,
              returnReason: data.returnReason,
            });
          }
        }).catch((err) => {
          logger.warn(LOG_TAG, `Failed to transition swap ${swapId} to cancelled:`, err);
        });
      } catch (err) {
        logger.warn(LOG_TAG, 'Error handling invoice:return_received for swap:', err);
      }
    });

    // Store all unsubscribe functions for cleanup in destroy()
    this.invoiceEventUnsubs = [unsubPayment, unsubCovered, unsubReturn];
  }

  // T2.6: IMPLEMENTATION END

  // =========================================================================
  // T2.7: IMPLEMENTATION START — Local timeout management
  // =========================================================================

  /**
   * Start a local timeout timer for a swap.
   * Uses announcedAt as the timeout base (per Unicity finding #2).
   * Adds a 30-second grace period over the escrow's timeout.
   */
  private startLocalTimer(swap: SwapRef): void {
    // §16.1: If announcedAt is undefined, skip — proposal timeout handles pre-announced swaps
    if (!swap.announcedAt) return;

    // Clear any existing timer for this swapId
    this.clearLocalTimer(swap.swapId);

    // Compute total timeout: escrow timeout (seconds -> ms) + 30s grace
    const totalTimeoutMs = swap.deal.timeout * 1000 + LOCAL_TIMEOUT_GRACE_MS;
    const elapsed = Date.now() - swap.announcedAt;
    const remaining = totalTimeoutMs - elapsed;

    if (remaining <= 0) {
      // Already expired — transition immediately (fire-and-forget)
      void this.withSwapGate(swap.swapId, async () => {
        const s = this.swaps.get(swap.swapId);
        if (!s || isTerminalProgress(s.progress)) return;
        await this.transitionProgress(s, 'cancelled', {
          error: 'Swap timed out during offline period',
        });
        this.deps!.emitEvent('swap:cancelled', {
          swapId: s.swapId,
          reason: 'timeout',
          depositsReturned: false,
        });
      }).catch((err) => {
        logger.warn(LOG_TAG, `Failed to cancel expired swap ${swap.swapId}:`, err);
      });
      return;
    }

    // Start timer for remaining duration
    const timer = setTimeout(() => {
      if (this.destroyed) return;
      void this.withSwapGate(swap.swapId, async () => {
        const s = this.swaps.get(swap.swapId);
        if (!s || isTerminalProgress(s.progress)) return;
        await this.transitionProgress(s, 'cancelled', {
          error: 'Local timeout — escrow did not respond within the expected window',
        });
        this.deps!.emitEvent('swap:cancelled', {
          swapId: s.swapId,
          reason: 'timeout',
          depositsReturned: false,
        });
      }).catch((err) => {
        logger.warn(LOG_TAG, `Failed to cancel timed-out swap ${swap.swapId}:`, err);
      });
    }, remaining);

    this.localTimers.set(swap.swapId, timer);
  }

  /**
   * Clear the local timeout timer for a swap.
   */
  private clearLocalTimer(swapId: string): void {
    const timer = this.localTimers.get(swapId);
    if (timer) {
      clearTimeout(timer);
      this.localTimers.delete(swapId);
    }
  }

  /**
   * Resume local timers for all active swaps during load().
   * Computes remaining time from announcedAt and starts timers.
   * Immediately cancels swaps whose timeouts have already elapsed.
   */
  private resumeTimers(): void {
    for (const swap of this.swaps.values()) {
      // Skip terminal swaps
      if (isTerminalProgress(swap.progress)) continue;

      // §16.2: For announced/depositing/awaiting_counter swaps with announcedAt, start local timer
      if (
        swap.announcedAt !== undefined &&
        (swap.progress === 'announced' ||
         swap.progress === 'depositing' ||
         swap.progress === 'awaiting_counter')
      ) {
        this.startLocalTimer(swap);
      }

      // §16.2: For proposed swaps where we are the proposer, start proposal timer
      if (swap.progress === 'proposed' && swap.role === 'proposer') {
        this.startProposalTimer(swap.swapId);
      }

      // NOTE: announce timer for accepted v2 acceptor swaps is started in crash recovery
      // (Step 8) AFTER the announce/status-query DM is sent — not here. Starting it here
      // would race with the DM send: sendAnnounce_v2 retries for up to ~82s, so a 30s
      // timer started before that send would fire and fail the swap prematurely.
    }
  }

  /**
   * Start a proposal timeout timer for outgoing proposals.
   * Expires the proposal after proposalTimeoutMs if no acceptance arrives.
   */
  private startProposalTimer(swapId: string): void {
    // Clear any existing timer for this swapId
    this.clearLocalTimer(swapId);

    // Compute remaining time, accounting for elapsed time since creation
    // (important for proposals loaded from storage on restart)
    const swap = this.swaps.get(swapId);
    const elapsed = swap ? Date.now() - swap.createdAt : 0;
    const remaining = this.config.proposalTimeoutMs - elapsed;

    if (remaining <= 0) {
      // Already expired — transition immediately
      void this.withSwapGate(swapId, async () => {
        const s = this.swaps.get(swapId);
        if (!s || s.progress !== 'proposed') return;
        await this.transitionProgress(s, 'failed', {
          error: 'Proposal timed out',
        });
      }).catch((err) => {
        logger.warn(LOG_TAG, `Failed to expire proposal ${swapId}:`, err);
      });
      return;
    }

    const timer = setTimeout(() => {
      if (this.destroyed) return;
      void this.withSwapGate(swapId, async () => {
        const s = this.swaps.get(swapId);
        if (!s || s.progress !== 'proposed') return;
        await this.transitionProgress(s, 'failed', {
          error: 'Proposal timed out',
        });
        if (this.config.debug) {
          logger.debug(LOG_TAG, `Proposal ${swapId} timed out`);
        }
      }).catch((err) => {
        logger.warn(LOG_TAG, `Failed to expire proposal ${swapId}:`, err);
      });
    }, remaining);

    this.localTimers.set(swapId, timer);
  }

  /**
   * Start an announce-response timeout timer for v2 acceptor swaps.
   * After sendAnnounce_v2 succeeds, if the escrow's announce_result + invoice_delivery
   * DMs are not received within announceTimeoutMs, the swap is transitioned to 'failed'.
   *
   * Cleared automatically when:
   * - invoice_delivery transitions the swap to 'announced' (via startLocalTimer →
   *   clearLocalTimer)
   * - transitionProgress transitions to any terminal state (calls clearLocalTimer)
   */
  private startAnnounceTimer(swapId: string): void {
    this.clearLocalTimer(swapId);

    const timer = setTimeout(() => {
      if (this.destroyed) return;
      void this.withSwapGate(swapId, async () => {
        const s = this.swaps.get(swapId);
        if (!s || s.progress !== 'accepted') return;
        await this.transitionProgress(s, 'failed', {
          error: 'Announce timed out: escrow did not deliver deposit invoice',
        });
        this.deps!.emitEvent('swap:failed', {
          swapId,
          error: 'Announce timed out: escrow did not deliver deposit invoice',
        });
        if (this.config.debug) {
          logger.debug(LOG_TAG, `Announce timer expired for swap ${swapId}`);
        }
      }).catch((err) => {
        logger.warn(LOG_TAG, `Failed to expire announce timer for ${swapId}:`, err);
      });
    }, this.config.announceTimeoutMs);

    this.localTimers.set(swapId, timer);
  }

  // T2.7: IMPLEMENTATION END
}

// =========================================================================
// Factory function
// =========================================================================

/**
 * Create a SwapModule instance.
 * Follows the same factory pattern as createAccountingModule().
 *
 * @param config - Optional module configuration.
 * @returns A new SwapModule instance.
 */
export function createSwapModule(config?: SwapModuleConfig): SwapModule {
  return new SwapModule(config);
}
