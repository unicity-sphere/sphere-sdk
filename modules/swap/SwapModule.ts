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
  buildAcceptanceDM,
  buildRejectionDM,
  buildAnnounceDM,
  buildStatusQueryDM,
} from './dm-protocol.js';
import {
  computeSwapId,
  buildManifest,
  validateManifest,
  verifyManifestIntegrity,
} from './manifest.js';
import {
  resolveEscrowAddress,
  sendAnnounce,
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
  SwapProposalResult,
  ProposeSwapOptions,
  GetSwapStatusOptions,
  GetSwapsFilter,
  SwapStorageData,
  SwapIndexEntry,
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
  private _gateMap = new AsyncGateMap();
  private localTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
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
    this.invoiceToSwapIndex.clear();
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

    // Step 8: Crash recovery — per-state recovery actions
    for (const swap of this.swaps.values()) {
      try {
        switch (swap.progress) {
          case 'accepted':
            // Re-send announce DM to escrow (idempotent)
            if (this.config.debug) {
              logger.debug(LOG_TAG, `Crash recovery: re-announcing swap ${swap.swapId}`);
            }
            break;
          case 'announced':
          case 'depositing':
            // Send status DM to escrow, request deposit invoice if missing
            if (this.config.debug) {
              logger.debug(LOG_TAG, `Crash recovery: status check for swap ${swap.swapId}`);
            }
            break;
          case 'awaiting_counter':
            // Send status DM to escrow
            if (this.config.debug) {
              logger.debug(LOG_TAG, `Crash recovery: status check for swap ${swap.swapId}`);
            }
            break;
          case 'concluding':
            // Send status DM, request payout invoice if missing
            if (this.config.debug) {
              logger.debug(LOG_TAG, `Crash recovery: concluding check for swap ${swap.swapId}`);
            }
            break;
          default:
            break;
        }
      } catch (err) {
        logger.warn(LOG_TAG, `Crash recovery failed for swap ${swap.swapId}:`, err);
      }
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

    const entries: SwapIndexEntry[] = [];
    for (const swap of this.swaps.values()) {
      entries.push({
        swapId: swap.swapId,
        progress: swap.progress,
        role: swap.role,
        createdAt: swap.createdAt,
      });
    }

    await deps.storage.set(indexKey, JSON.stringify(entries));
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
        const age = now - entry.createdAt;
        if (age > this.config.terminalPurgeTtlMs) {
          purgedIds.push(entry.swapId);
          indexDirty = true;
          continue;
        }
        // Terminal but not yet expired — skip loading into memory but keep in index
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

    // Clear local timer on terminal states
    if (isTerminalProgress(to)) {
      this.clearLocalTimer(swap.swapId);
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
    const counterpartyPubkey = matchesPartyA ? peerB.chainPubkey : peerA.chainPubkey;

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

    // Step 7: Build SwapManifest
    const manifest = buildManifest(resolvedPartyA, resolvedPartyB, deal, deal.timeout);
    const swapId = manifest.swap_id;

    // Step 8: Check for duplicate (idempotent)
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
      escrowPubkey: escrowPeer.chainPubkey,
      escrowDirectAddress: escrowPeer.directAddress,
      payoutVerified: false,
      createdAt: now,
      updatedAt: now,
    };

    // Step 10: Persist (persist-before-act)
    this.swaps.set(swapId, swap);
    await this.persistSwap(swap);

    // Step 11: Send proposal DM to the counterparty
    try {
      const dmContent = buildProposalDM(manifest, escrowAddress, options?.message);
      await deps.communications.sendDM(counterpartyPubkey, dmContent);
    } catch (err) {
      swap.progress = 'failed';
      swap.error = `Proposal DM send failed: ${err instanceof Error ? err.message : String(err)}`;
      swap.updatedAt = Date.now();
      await this.persistSwap(swap);
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

    // Step 3: Enter per-swap gate
    await this.withSwapGate(swapId, async () => {
      // Step 4: Transition to 'accepted' (persist-before-act)
      await this.transitionProgress(swap, 'accepted');

      // Step 5: Send acceptance DM to the proposer
      const dmContent = buildAcceptanceDM(swapId);
      await deps.communications.sendDM(swap.counterpartyPubkey!, dmContent);

      // Step 6: Emit swap:accepted
      deps.emitEvent('swap:accepted', { swapId, role: swap.role });

      // Step 7: Resolve escrow and announce (awaited — escrowPubkey must be set
      // before the gate releases, otherwise incoming escrow DMs will be rejected
      // by isFromExpectedEscrow). If resolution fails, the swap transitions to failed.
      if (!swap.escrowPubkey) {
        const { escrowPubkey, escrowDirectAddress } = await resolveEscrowAddress(
          swap.deal, this.config, deps.resolve,
        );
        swap.escrowPubkey = escrowPubkey;
        swap.escrowDirectAddress = escrowDirectAddress;
        await this.persistSwap(swap);
      }

      // Send announce DM to escrow (with retry via escrow-client)
      try {
        await sendAnnounce(deps.communications, swap.escrowPubkey!, swap.manifest);
      } catch (err) {
        // Announce failure — transition to failed per spec §5.1 step 8
        await this.transitionProgress(swap, 'failed', {
          error: 'Failed to send announce to escrow',
        });
        deps.emitEvent('swap:failed', { swapId, error: 'Failed to send announce to escrow' });
        logger.warn(LOG_TAG, `Failed to announce swap ${swapId} to escrow:`, err);
      }
    });
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
    if (swap.progress !== 'proposed') {
      throw new SphereError(
        `Cannot reject: swap is in ${swap.progress} state`,
        'SWAP_WRONG_STATE',
      );
    }
    if (swap.role !== 'acceptor') {
      throw new SphereError(
        'Cannot reject: you are the proposer, not the acceptor',
        'SWAP_WRONG_STATE',
      );
    }

    // Step 3: Enter per-swap gate
    await this.withSwapGate(swapId, async () => {
      // Step 4: Send rejection DM (best-effort, catch errors)
      try {
        const dmContent = buildRejectionDM(swapId, reason);
        await deps.communications.sendDM(swap.counterpartyPubkey!, dmContent);
      } catch (err) {
        logger.warn(LOG_TAG, `Failed to send rejection DM for swap ${swapId}:`, err);
      }

      // Step 5: Transition to 'cancelled' with error
      await this.transitionProgress(swap, 'cancelled', { error: 'Rejected by user' });

      // Step 6: Emit swap:rejected
      deps.emitEvent('swap:rejected', { swapId, reason });

      // Step 7: Emit swap:cancelled with reason='rejected'
      deps.emitEvent('swap:cancelled', { swapId, reason: 'explicit', depositsReturned: false });

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
      try {
        const transferResult = await deps.accounting.payInvoice(swap.depositInvoiceId!, {
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

    // Look up swap
    const swap = this.swaps.get(swapId);
    if (!swap) {
      throw new SphereError(`Swap ${swapId} not found`, 'SWAP_NOT_FOUND');
    }

    // Verify payout invoice is available
    if (!swap.payoutInvoiceId) {
      throw new SphereError('Payout invoice not yet received', 'SWAP_WRONG_STATE');
    }

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

    // Verify invoice terms match expectations
    const targetTerms = invoiceRef.terms.targets[0];
    if (!targetTerms || !targetTerms.assets[0]?.coin) {
      swap.payoutVerified = false;
      await this.persistSwap(swap);
      deps.emitEvent('swap:failed', {
        swapId,
        error: 'Payout invoice has no valid target or asset',
      });
      return false;
    }

    if (targetTerms.assets[0].coin[0] !== expectedCoinId) {
      swap.payoutVerified = false;
      await this.persistSwap(swap);
      deps.emitEvent('swap:failed', {
        swapId,
        error: `Payout invoice currency mismatch: expected ${expectedCoinId}, got ${targetTerms.assets[0].coin[0]}`,
      });
      return false;
    }

    if (targetTerms.assets[0].coin[1] !== expectedAmount) {
      swap.payoutVerified = false;
      await this.persistSwap(swap);
      deps.emitEvent('swap:failed', {
        swapId,
        error: `Payout invoice amount mismatch: expected ${expectedAmount}, got ${targetTerms.assets[0].coin[1]}`,
      });
      return false;
    }

    // Verify payout invoice targets OUR address (not someone else's)
    if (!myDirectAddresses.has(targetTerms.address)) {
      swap.payoutVerified = false;
      await this.persistSwap(swap);
      deps.emitEvent('swap:failed', {
        swapId,
        error: 'Payout invoice targets wrong address',
      });
      return false;
    }

    // Verify creator is defined (escrow invoices are non-anonymous)
    if (!invoiceRef.terms.creator) {
      swap.payoutVerified = false;
      await this.persistSwap(swap);
      deps.emitEvent('swap:failed', {
        swapId,
        error: 'Payout invoice has no creator (anonymous invoice)',
      });
      return false;
    }

    // Verify coverage from invoice status
    const targetStatus = status.targets[0];
    if (!targetStatus || !targetStatus.coinAssets[0]) {
      return false;
    }

    const coveredState = status.state;
    if (coveredState !== 'COVERED' && coveredState !== 'CLOSED') {
      return false;
    }

    if (!targetStatus.coinAssets[0].isCovered) {
      return false;
    }

    if (BigInt(targetStatus.coinAssets[0].netCoveredAmount) < BigInt(expectedAmount)) {
      return false;
    }

    // Verify escrow creator identity
    const escrowAddr = swap.deal.escrowAddress ?? this.config.defaultEscrowAddress;
    if (escrowAddr) {
      const escrowPeer = await deps.resolve(escrowAddr);
      if (escrowPeer && invoiceRef.terms.creator !== escrowPeer.chainPubkey) {
        swap.payoutVerified = false;
        await this.persistSwap(swap);
        deps.emitEvent('swap:failed', {
          swapId,
          error: 'Payout invoice creator does not match escrow pubkey',
        });
        return false;
      }
    }

    // Validate L3 inclusion proofs
    const validationResult = await deps.payments.validate();
    if (validationResult.invalid.length > 0) {
      swap.payoutVerified = false;
      await this.persistSwap(swap);
      deps.emitEvent('swap:failed', {
        swapId,
        error: 'L3 proof validation found invalid tokens',
      });
      return false;
    }

    // All checks passed -- transition to completed
    await this.transitionProgress(swap, 'completed', {
      payoutVerified: true,
    });

    deps.emitEvent('swap:completed', { swapId, payoutVerified: true });

    return true;
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
              return deps.communications.sendDM(peer.chainPubkey, statusDM).then(() => undefined);
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

    // Terminal state checks
    if (swap.progress === 'completed') {
      throw new SphereError('Swap is already completed', 'SWAP_ALREADY_COMPLETED');
    }
    if (swap.progress === 'cancelled' || swap.progress === 'failed') {
      throw new SphereError('Swap is already cancelled', 'SWAP_ALREADY_CANCELLED');
    }

    const deps = this.deps!;

    await this.withSwapGate(swapId, async () => {
      // Clear local timer
      this.clearLocalTimer(swapId);

      // Log warning for post-announcement cancellations
      if (swap.progress === 'announced' || swap.progress === 'depositing' ||
          swap.progress === 'awaiting_counter' || swap.progress === 'concluding') {
        logger.warn(LOG_TAG, `Swap ${swapId} cancelled locally but escrow may still be active. Deposits will be returned on escrow timeout.`);
      }

      // Transition to cancelled
      await this.transitionProgress(swap, 'cancelled', { error: 'Cancelled by user' });

      // Emit swap:cancelled event
      deps.emitEvent('swap:cancelled', {
        swapId,
        reason: 'explicit',
        depositsReturned: false,
      });
    });
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

            // Validate version (forward compatibility)
            if (proposalMsg.version > 1 || proposalMsg.version < 1) return;

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

            // Check for duplicate swap_id
            if (this.swaps.has(manifest.swap_id)) {
              if (this.config.debug) {
                logger.debug(LOG_TAG, `Proposal ignored: duplicate swap_id ${manifest.swap_id}`);
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
              escrowPubkey,
              escrowDirectAddress: escrowDirectAddr,
              payoutVerified: false,
              createdAt: Date.now(),
              updatedAt: Date.now(),
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

            // Start proposal timer
            this.startProposalTimer(manifest.swap_id);

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

            // Look up swap — must exist, progress='proposed', role='proposer'
            const swap = this.swaps.get(swapId);
            if (!swap) return;
            if (swap.progress !== 'proposed' || swap.role !== 'proposer') return;

            // Verify sender is the counterparty
            if (dm.senderPubkey !== swap.counterpartyPubkey) return;

            const deps = this.deps!;

            await this.withSwapGate(swapId, async () => {
              // Clear proposal timer
              this.clearLocalTimer(swapId);

              // Transition to 'accepted'
              await this.transitionProgress(swap, 'accepted');

              // Emit swap:accepted
              deps.emitEvent('swap:accepted', {
                swapId,
                role: swap.role,
              });

              // Announce to escrow — failure transitions to 'failed' (matches acceptor-side pattern)
              resolveEscrowAddress(swap.deal, this.config, deps.resolve)
                .then(({ escrowPubkey }) => {
                  return sendAnnounce(deps.communications, escrowPubkey, swap.manifest);
                })
                .catch(async (err) => {
                  logger.warn(LOG_TAG, `Failed to announce swap ${swapId} to escrow:`, err);
                  await this.transitionProgress(swap, 'failed', { error: 'Failed to announce to escrow' });
                  deps.emitEvent('swap:failed', { swapId, error: 'Failed to announce to escrow' });
                });
            });
            break;
          }

          // =================================================================
          // P2P: swap_rejection (§12.3)
          // =================================================================
          case 'rejection': {
            const rejectMsg = parsed.payload;
            const swapId = rejectMsg.swap_id;

            // Look up swap — must exist, not terminal
            const swap = this.swaps.get(swapId);
            if (!swap) return;
            if (isTerminalProgress(swap.progress)) return;

            // Verify sender is counterparty
            if (dm.senderPubkey !== swap.counterpartyPubkey) return;

            const deps = this.deps!;

            await this.withSwapGate(swapId, async () => {
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

                // Must be in 'accepted' (we just announced). If already further, log and ignore.
                if (swap.progress !== 'accepted') {
                  if (this.config.debug) {
                    logger.debug(LOG_TAG, `announce_result for ${swapId} ignored: progress is ${swap.progress}`);
                  }
                  return;
                }

                await this.withSwapGate(swapId, async () => {
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

                    // DM ORDERING: if swap is still in 'accepted', transition directly to 'announced'
                    // (announce_result may not have arrived yet)
                    if (swap.progress === 'accepted') {
                      await this.transitionProgress(swap, 'announced');
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
                  await this.withSwapGate(swapId, async () => {
                    try {
                      await deps.accounting.importInvoice(msg.invoice_token);
                    } catch (err) {
                      logger.error(LOG_TAG, `Failed to import payout invoice for swap ${swapId}:`, err);
                      return;
                    }

                    // Store payoutInvoiceId
                    if (msg.invoice_id) {
                      swap.payoutInvoiceId = msg.invoice_id;
                    }
                    swap.updatedAt = Date.now();
                    await this.persistSwap(swap);

                    // Emit swap:payout_received
                    deps.emitEvent('swap:payout_received', {
                      swapId,
                      payoutInvoiceId: swap.payoutInvoiceId ?? '',
                    });

                    // Attempt auto-verification (fire-and-forget)
                    this.verifyPayout(swapId).catch((err) => {
                      if (this.config.debug) {
                        logger.debug(LOG_TAG, `Auto-verification for swap ${swapId} deferred:`, err);
                      }
                    });
                  });
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
                  // Update escrowState
                  swap.escrowState = msg.state;
                  swap.updatedAt = Date.now();
                  await this.persistSwap(swap);

                  // Map escrow state to client progress and advance if necessary
                  const mappedProgress = mapEscrowStateToProgress(msg.state);
                  if (mappedProgress && isTerminalProgress(mappedProgress) && !isTerminalProgress(swap.progress)) {
                    if (mappedProgress === 'completed') {
                      await this.transitionProgress(swap, 'completed', { payoutVerified: false });
                      deps.emitEvent('swap:completed', { swapId, payoutVerified: false });
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

                if (isTerminalProgress(swap.progress)) return;

                const deps = this.deps!;

                await this.withSwapGate(swapId, async () => {
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

                // Emit swap:bounce_received
                deps.emitEvent('swap:bounce_received', {
                  swapId,
                  reason: msg.reason,
                  returnedAmount: msg.returned_amount,
                  returnedCurrency: msg.returned_currency,
                });

                // If swap not found or closed on escrow side, transition to failed
                if (msg.reason === 'SWAP_NOT_FOUND' || msg.reason === 'SWAP_CLOSED') {
                  await this.withSwapGate(swapId, async () => {
                    if (!isTerminalProgress(swap.progress)) {
                      await this.transitionProgress(swap, 'failed', {
                        error: `Escrow bounce: ${msg.reason}`,
                      });
                      deps.emitEvent('swap:failed', {
                        swapId,
                        error: `Escrow does not recognize swap: ${msg.reason}`,
                      });
                    }
                  });
                }
                break;
              }

              // ---------------------------------------------------------------
              // error (§12.4.8)
              // ---------------------------------------------------------------
              case 'error': {
                const errorSwapId = msg.swap_id;

                logger.error(LOG_TAG, `Escrow error${errorSwapId ? ` for swap ${errorSwapId}` : ''}: ${msg.error}`);

                if (!errorSwapId) return;
                const swap = this.swaps.get(errorSwapId);
                if (!swap) return;

                const deps = this.deps!;

                // If swap is in 'accepted' state (error in response to announce), transition to 'failed'
                if (swap.progress === 'accepted') {
                  await this.withSwapGate(errorSwapId, async () => {
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
   * Compares the sender's chain pubkey against the escrowPubkey
   * stored on the SwapRef during escrow resolution.
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
        if (transfer.coinId === swap.manifest.party_a_currency_to_change) {
          party = 'A';
        } else if (transfer.coinId === swap.manifest.party_b_currency_to_change) {
          party = 'B';
        } else {
          // Unknown coinId — not attributable to either party
          return;
        }

        // Emit deposit confirmed event
        deps.emitEvent('swap:deposit_confirmed', {
          swapId,
          party,
          amount: transfer.amount,
          coinId: transfer.coinId,
        });

        // Determine local party's currency based on address match
        const localAddress = deps.identity.directAddress;
        let localCurrency: string | undefined;
        if (localAddress === swap.manifest.party_a_address) {
          localCurrency = swap.manifest.party_a_currency_to_change;
        } else if (localAddress === swap.manifest.party_b_address) {
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

        // Emit deposit returned event
        deps.emitEvent('swap:deposit_returned', {
          swapId,
          transfer: data.transfer,
          returnReason: data.returnReason,
        });

        // Transition to cancelled if not already terminal
        if (!isTerminalProgress(swap.progress)) {
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
          }).catch((err) => {
            logger.warn(LOG_TAG, `Failed to transition swap ${swapId} to cancelled:`, err);
          });
        }
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
    }
  }

  /**
   * Start a proposal timeout timer for outgoing proposals.
   * Expires the proposal after proposalTimeoutMs if no acceptance arrives.
   */
  private startProposalTimer(swapId: string): void {
    // Clear any existing timer for this swapId
    this.clearLocalTimer(swapId);

    const timer = setTimeout(() => {
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
    }, this.config.proposalTimeoutMs);

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
