/**
 * Accounting Module
 *
 * Manages invoice lifecycle, balance tracking, and payment attribution for the
 * Sphere SDK. Persists invoice tokens, terminal-state sets, frozen balances, and
 * auto-return settings. Builds and maintains an incremental invoice-transfer index
 * (§5.4) for efficient per-invoice balance computation without full history rescans.
 *
 * @see docs/ACCOUNTING-SPEC.md
 */

import { logger } from '../../core/logger.js';
import { SphereError } from '../../core/errors.js';
import { AsyncGateMap } from '../../core/async-gate.js';
import { STORAGE_KEYS_ADDRESS, INVOICE_TOKEN_TYPE_HEX, getAddressStorageKey, getAddressId } from '../../constants.js';
import type {
  IncomingTransfer,
  TransferRequest,
  TransferResult,
  SphereEventMap,
} from '../../types/index.js';
import type { TxfToken } from '../../types/txf.js';
import type { DirectMessage } from '../../types/index.js';
import type {
  AccountingModuleConfig,
  AccountingModuleDependencies,
  InvoiceTerms,
  InvoiceRef,
  InvoiceStatus,
  CreateInvoiceRequest,
  CreateInvoiceResult,
  GetInvoicesOptions,
  AutoReturnSettings,
  PayInvoiceParams,
  ReturnPaymentParams,
  SendInvoiceReceiptsOptions,
  SendReceiptsResult,
  SendCancellationNoticesOptions,
  SendNoticesResult,
  FrozenInvoiceBalances,
  InvoiceTransferRef,
  IrrelevantTransfer,
  InvoiceBalanceSnapshot,
  AutoReturnLedger,
  TransferMessagePayload,
  IncomingInvoiceReceipt,
  IncomingCancellationNotice,
  InvoiceReceiptPayload,
  InvoiceCancellationPayload,
  InvoiceReceiptContribution,
  InvoiceReceiptAsset,
  SentReceiptInfo,
  FailedReceiptInfo,
  SentNoticeInfo,
  FailedNoticeInfo,
} from './types.js';
import { parseInvoiceMemo, buildInvoiceMemo, decodeTransferMessage } from './memo.js';
import { AutoReturnManager } from './auto-return.js';
import { canonicalSerialize } from './serialization.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { computeInvoiceStatus, freezeBalances } from './balance-computer.js';
import { TokenRegistry } from '../../registry/index.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { Token as SdkToken } from '@unicitylabs/state-transition-sdk/lib/token/Token.js';
import { txfToToken } from '../../serialization/txf-serializer.js';

// =============================================================================
// Internal storage-schema types
// =============================================================================

/** Storage format for auto-return settings. */
interface AutoReturnStorage {
  global: boolean;
  perInvoice: Record<string, boolean>;
}

/** Storage format for frozen balances — keyed by invoiceId. */
type FrozenBalancesStorage = Record<string, FrozenInvoiceBalances>;

/** Storage format for invoice ledger index metadata. */
type InvLedgerIndex = Record<string, { terminated: boolean; frozenAt?: number }>;

/**
 * Reason codes for invoice:irrelevant events — mirrors the union in SphereEventMap.
 * Declared locally to avoid importing from types/index.ts.
 */
type IrrelevantReason =
  | 'unknown_address'
  | 'unknown_asset'
  | 'unknown_address_and_asset'
  | 'self_payment'
  | 'no_coin_data'
  | 'unauthorized_return';

// =============================================================================
// Constants
// =============================================================================

const LOG_TAG = 'Accounting';

/** Prefix for per-invoice transfer ledger storage keys. */
const INV_LEDGER_PREFIX = 'inv_ledger:';

// =============================================================================
// AccountingModule
// =============================================================================

/**
 * AccountingModule manages invoice creation, import, status tracking, and
 * payment attribution. It maintains a persistent invoice-transfer index (§5.4)
 * and integrates with PaymentsModule and CommunicationsModule for real-time
 * event handling.
 *
 * Lifecycle:
 * 1. `new AccountingModule(config)` — construct with optional config
 * 2. `initialize(deps)` — inject dependencies (synchronous)
 * 3. `await load()` — load persisted state, populate index, subscribe to events
 * 4. Use public API methods
 * 5. `destroy()` — cleanup subscriptions and in-memory state
 *
 * @see docs/ACCOUNTING-SPEC.md §2.1
 */
export class AccountingModule {
  // ---------------------------------------------------------------------------
  // Configuration (immutable after construction)
  // ---------------------------------------------------------------------------

  private config: Required<Pick<AccountingModuleConfig, 'debug' | 'autoTerminateOnReturn' | 'maxCoinDataEntries'>>;

  // ---------------------------------------------------------------------------
  // Dependencies (set in initialize())
  // ---------------------------------------------------------------------------

  private deps: AccountingModuleDependencies | null = null;

  // ---------------------------------------------------------------------------
  // Lifecycle flags
  // ---------------------------------------------------------------------------

  private destroyed = false;
  private loadPromise: Promise<void> | null = null;
  private _loading = false;
  private _loadingDeferred: { promise: Promise<void>; resolve: () => void } | null = null;

  // ---------------------------------------------------------------------------
  // Invoice token cache: invoiceId → parsed InvoiceTerms
  // ---------------------------------------------------------------------------

  private invoiceTermsCache: Map<string, InvoiceTerms> = new Map();

  // ---------------------------------------------------------------------------
  // Terminal state tracking (in-memory, persisted via storage)
  // ---------------------------------------------------------------------------

  private cancelledInvoices: Set<string> = new Set();
  private closedInvoices: Set<string> = new Set();
  private frozenBalances: Map<string, FrozenInvoiceBalances> = new Map();

  // ---------------------------------------------------------------------------
  // Auto-return settings (in-memory, persisted via storage)
  // ---------------------------------------------------------------------------

  private autoReturnGlobal = false;
  private autoReturnPerInvoice: Map<string, boolean> = new Map();
  /** Timestamp of last `setAutoReturn('*')` call — for 5-second rate-limit. */
  private autoReturnLastGlobalSet = 0;

  /** Auto-return deduplication ledger manager (§7.5). */
  private autoReturnManager: AutoReturnManager = new AutoReturnManager();

  // ---------------------------------------------------------------------------
  // Invoice-transfer index (§5.4)
  // ---------------------------------------------------------------------------

  /**
   * Primary index: per-invoice transfer ledger.
   * entryKey = `${transferId}::${coinId}` (composite dedup key).
   * Outer: invoiceId → Inner: entryKey → InvoiceTransferRef
   */
  private invoiceLedger: Map<string, Map<string, InvoiceTransferRef>> = new Map();

  /**
   * Token scan watermark — tracks processed tx count per token.
   * tokenId → number of TxfToken.transactions[] entries processed.
   */
  private tokenScanState: Map<string, number> = new Map();

  /**
   * Secondary: token → invoice mapping (rebuilt on load, not persisted).
   * Answers "which invoices does this token affect?" for efficient event handling.
   */
  private tokenInvoiceMap: Map<string, Set<string>> = new Map();

  /**
   * Balance cache — computed lazily, invalidated on index mutation.
   * Not persisted. Outer key: invoiceId.
   */
  private balanceCache: Map<string, InvoiceBalanceSnapshot> = new Map();

  /** Dirty invoiceIds whose ledger entries need to be flushed to storage. */
  private dirtyLedgerEntries: Set<string> = new Set();

  /** Count of unknown (not in invoiceTermsCache) invoice IDs in the ledger. */
  private unknownLedgerCount = 0;

  /** W17: Tracks whether tokenScanState has been mutated since last flush. */
  private tokenScanDirty = false;

  /** W2 fix: Serialization guard for _flushDirtyLedgerEntries. */
  private _flushPromise: Promise<void> | null = null;

  // ---------------------------------------------------------------------------
  // Per-invoice concurrency gate (promise chain)
  // ---------------------------------------------------------------------------

  /**
   * Per-invoice async mutex. Maps invoiceId → tail of current promise chain.
   * New operations append to the chain; cleanup removes the key when the chain
   * is idle (no pending operations for this invoice).
   */
  private _gateMap = new AsyncGateMap();

  // ---------------------------------------------------------------------------
  // Event subscription cleanup handles
  // ---------------------------------------------------------------------------

  private unsubscribePayments: (() => void)[] = [];
  private unsubscribeDMs: (() => void) | null = null;

  // ===========================================================================
  // Construction
  // ===========================================================================

  /**
   * Construct the AccountingModule with optional configuration.
   *
   * @param config - Optional module configuration. All fields have sensible defaults.
   */
  constructor(config?: AccountingModuleConfig) {
    this.config = {
      debug: config?.debug ?? false,
      autoTerminateOnReturn: config?.autoTerminateOnReturn ?? false,
      maxCoinDataEntries: config?.maxCoinDataEntries ?? 50,
    };
  }

  // ===========================================================================
  // Lifecycle — initialize
  // ===========================================================================

  /**
   * Inject dependencies into the module. Must be called before `load()`.
   * Calling `initialize()` again replaces the deps without resetting in-memory state —
   * always call `load()` after re-initializing.
   *
   * @param deps - Module dependencies provided by Sphere.
   */
  initialize(deps: AccountingModuleDependencies): void {
    // W23-R2 fix: Reset destroyed flag so load() can proceed after destroy() + re-init
    // (e.g., switchToAddress() calls destroy() then initialize() then load()).
    this.destroyed = false;
    this.deps = deps;
    if (this.config.debug) {
      logger.debug(LOG_TAG, 'Initialized with dependencies');
    }
  }

  // ===========================================================================
  // Lifecycle — load
  // ===========================================================================

  /**
   * Load persisted state from storage and subscribe to event streams.
   *
   * Steps (per §7.6 load() specification):
   * 1.  Clear all in-memory state.
   * 2.  Load invoice tokens from TokenStorage (filter by INVOICE_TOKEN_TYPE_HEX).
   * 3.  Parse InvoiceTerms from each token's genesis.data.tokenData.
   * 4.  Load terminal sets (CANCELLED_INVOICES, CLOSED_INVOICES).
   * 4b. Storage reconciliation (forward): frozen balances without terminal-set entry.
   * 4c. Storage reconciliation (inverse): terminal-set entries without frozen balances.
   * 5.  Load frozen balances (FROZEN_BALANCES).
   * 6.  Load auto-return settings (AUTO_RETURN).
   * 7.  Load auto-return dedup ledger (AUTO_RETURN_LEDGER) — crash recovery (stub).
   * 8.  Populate invoice-transfer index (§5.4.4).
   * 9.  Subscribe to PaymentsModule events.
   * 10. Subscribe to CommunicationsModule DM events if available.
   *
   * @throws {SphereError} `NOT_INITIALIZED` if `initialize()` has not been called.
   * @throws {SphereError} `MODULE_DESTROYED` if the module has been destroyed.
   */
  async load(): Promise<void> {
    this.ensureInitialized();
    this.ensureNotDestroyed();

    // Re-entry guard: if load() is already in progress, return the same promise.
    // C11 fix: use _loading flag to prevent triple-call race where loadPromise
    // is cleared in finally before a third caller can see it.
    if (this.loadPromise) {
      return this.loadPromise;
    }
    // C2 fix: If _loading is true but loadPromise is null (brief window in finally block),
    // wait for the deferred signal that the completing load resolves.
    if (this._loading) {
      if (!this._loadingDeferred) {
        this._loadingDeferred = this._createDeferred();
      }
      await Promise.race([
        this._loadingDeferred.promise,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new SphereError('load() timed out waiting for prior load', 'NOT_INITIALIZED')), 10_000),
        ),
      ]);
      // After the previous load completed, verify module is still alive.
      if (this.destroyed) {
        throw new SphereError('AccountingModule has been destroyed.', 'MODULE_DESTROYED');
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
      // Signal any waiters from the C2 deferred pattern
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

  private async _doLoad(): Promise<void> {
    const deps = this.deps!;
    const deferredEvents: Array<{ event: string; payload: unknown }> = [];

    // ------------------------------------------------------------------
    // Step 1: Clear all in-memory state
    // ------------------------------------------------------------------
    this._clearInMemoryState();

    if (this.config.debug) {
      logger.debug(LOG_TAG, 'load() starting');
    }

    // ------------------------------------------------------------------
    // Step 2–3: Load invoice tokens from PaymentsModule, parse InvoiceTerms
    //
    // PaymentsModule.getTokens() returns all in-memory tokens (already loaded
    // from TokenStorageProvider by PaymentsModule.load()). We filter by
    // INVOICE_TOKEN_TYPE_HEX, which is stored in genesis.data.tokenType.
    // ------------------------------------------------------------------
    try {
      const allTokens = deps.payments.getTokens();
      for (const token of allTokens) {
        if (!token.sdkData) continue;
        try {
          const txf = JSON.parse(token.sdkData) as TxfToken;
          // Filter by invoice token type
          const tokenType = txf.genesis?.data?.tokenType;
          if (tokenType !== INVOICE_TOKEN_TYPE_HEX) continue;

          const tokenData = txf.genesis?.data?.tokenData;
          if (!tokenData) continue;

          const rawTerms = this._parseInvoiceTerms(tokenData);
          if (rawTerms) {
            this.invoiceTermsCache.set(token.id, this._normalizeInvoiceTerms(rawTerms));
          }
        } catch (err) {
          logger.warn(LOG_TAG, `Failed to parse invoice token ${token.id}:`, err);
        }
      }

      // Also scan archived tokens (spec §5.4 Phase 2 step 5)
      const archivedTokens = deps.payments.getArchivedTokens();
      for (const [archivedId, txf] of archivedTokens) {
        try {
          const tokenType = txf.genesis?.data?.tokenType;
          if (tokenType !== INVOICE_TOKEN_TYPE_HEX) continue;

          const tokenData = txf.genesis?.data?.tokenData;
          if (!tokenData) continue;

          const rawTerms = this._parseInvoiceTerms(tokenData);
          if (rawTerms) {
            this.invoiceTermsCache.set(archivedId, this._normalizeInvoiceTerms(rawTerms));
          }
        } catch (err) {
          logger.warn(LOG_TAG, `Failed to parse archived invoice token ${archivedId}:`, err);
        }
      }

      if (this.config.debug) {
        logger.debug(LOG_TAG, `Loaded ${this.invoiceTermsCache.size} invoice token(s)`);
      }
    } catch (err) {
      logger.warn(LOG_TAG, 'Failed to enumerate tokens via PaymentsModule:', err);
    }

    // W16: destroyed check between major steps — prevents partial state population
    // if destroy() was called while _doLoad() is in progress.
    if (this.destroyed) return;

    // ------------------------------------------------------------------
    // Step 4: Load terminal sets
    // ------------------------------------------------------------------
    const cancelledRaw = await this.loadJsonFromStorage<string[]>(
      STORAGE_KEYS_ADDRESS.CANCELLED_INVOICES,
      [],
    );
    for (const id of cancelledRaw) this.cancelledInvoices.add(id);

    const closedRaw = await this.loadJsonFromStorage<string[]>(
      STORAGE_KEYS_ADDRESS.CLOSED_INVOICES,
      [],
    );
    for (const id of closedRaw) this.closedInvoices.add(id);

    if (this.destroyed) return;

    // ------------------------------------------------------------------
    // Step 5: Load frozen balances
    // ------------------------------------------------------------------
    const frozenRaw = await this.loadJsonFromStorage<FrozenBalancesStorage>(
      STORAGE_KEYS_ADDRESS.FROZEN_BALANCES,
      {},
    );
    for (const [invoiceId, frozen] of Object.entries(frozenRaw)) {
      this.frozenBalances.set(invoiceId, frozen);
    }

    // ------------------------------------------------------------------
    // Step 4b: Storage reconciliation (forward)
    // Frozen balances exist but not in terminal set → add to terminal set.
    // ------------------------------------------------------------------
    let terminalSetDirty = false;
    for (const [invoiceId, frozen] of this.frozenBalances.entries()) {
      if (frozen.state === 'CANCELLED' && !this.cancelledInvoices.has(invoiceId)) {
        logger.warn(LOG_TAG, `Reconcile (forward): adding ${invoiceId} to CANCELLED set`);
        this.cancelledInvoices.add(invoiceId);
        terminalSetDirty = true;
        deferredEvents.push({ event: 'invoice:cancelled', payload: { invoiceId } });
      } else if (frozen.state === 'CLOSED' && !this.closedInvoices.has(invoiceId)) {
        logger.warn(LOG_TAG, `Reconcile (forward): adding ${invoiceId} to CLOSED set`);
        this.closedInvoices.add(invoiceId);
        terminalSetDirty = true;
        deferredEvents.push({ event: 'invoice:closed', payload: { invoiceId, explicit: frozen.explicitClose ?? false } });
      }
    }
    if (terminalSetDirty) {
      await this._persistTerminalSets();
    }

    if (this.destroyed) return;

    // ------------------------------------------------------------------
    // Step 6: Load auto-return settings
    // ------------------------------------------------------------------
    const autoReturn = await this.loadJsonFromStorage<AutoReturnStorage>(
      STORAGE_KEYS_ADDRESS.AUTO_RETURN,
      { global: false, perInvoice: {} },
    );
    this.autoReturnGlobal = autoReturn.global;
    this.autoReturnPerInvoice.clear();
    for (const [id, enabled] of Object.entries(autoReturn.perInvoice)) {
      this.autoReturnPerInvoice.set(id, enabled);
    }

    // ------------------------------------------------------------------
    // Step 7: Load auto-return dedup ledger — prune and crash recovery
    // (Full implementation deferred; we load the ledger here for completeness.)
    // ------------------------------------------------------------------
    await this._loadAndRecoverAutoReturnLedger();

    if (this.destroyed) return;

    // ------------------------------------------------------------------
    // Step 8: Populate invoice-transfer index (§5.4.4)
    // ------------------------------------------------------------------
    await this._loadInvoiceTransferIndex();

    // ------------------------------------------------------------------
    // Step 4c: Storage reconciliation (inverse) — deferred until after ledger loaded
    // Terminal set entry exists but no frozen balances → reconstruct from ledger.
    // (Full recomputation from history is deferred to later tasks.)
    // ------------------------------------------------------------------
    // Build wallet address set for computeInvoiceStatus
    const activeAddresses = deps.getActiveAddresses();
    const walletAddresses = new Set(activeAddresses.map((a) => a.directAddress));

    let anyReconstructed = false;
    // C1 fix: 4th param of freezeBalances is `explicit` (whether the user explicitly closed),
    // NOT `resetReturns`. After a crash, the original close type is unknown — default to false.
    const reconstructFrozen = (invoiceId: string, terminalState: 'CLOSED' | 'CANCELLED', explicit: boolean) => {
      const terms = this.invoiceTermsCache.get(invoiceId);
      if (terms) {
        logger.warn(
          LOG_TAG,
          `Reconcile (inverse): ${invoiceId} in ${terminalState} set but no frozen balances — reconstructing from ledger`,
        );
        const ledgerMap = this.invoiceLedger.get(invoiceId) ?? new Map();
        const entries = Array.from(ledgerMap.values());
        const status = computeInvoiceStatus(invoiceId, terms, entries, null, walletAddresses);
        const frozen = freezeBalances(terms, status, terminalState, explicit);
        this.frozenBalances.set(invoiceId, frozen);
        anyReconstructed = true;
      } else {
        logger.warn(
          LOG_TAG,
          `Reconcile (inverse): ${invoiceId} in ${terminalState} set but no terms — cannot reconstruct frozen balances`,
        );
      }
    };

    for (const invoiceId of this.cancelledInvoices) {
      if (!this.frozenBalances.has(invoiceId)) {
        reconstructFrozen(invoiceId, 'CANCELLED', false);
      }
    }
    for (const invoiceId of this.closedInvoices) {
      if (!this.frozenBalances.has(invoiceId)) {
        reconstructFrozen(invoiceId, 'CLOSED', false);
      }
    }
    // C5 fix: Await the save — fire-and-forget risks losing reconstructed
    // frozen balances on crash, leaving recovery in a loop.
    if (anyReconstructed) {
      await this.saveJsonToStorage(
        STORAGE_KEYS_ADDRESS.FROZEN_BALANCES,
        Object.fromEntries(this.frozenBalances),
      );
    }

    // ------------------------------------------------------------------
    // Step 9: Subscribe to PaymentsModule events (MUST come after index build)
    // Guard: if destroy() was called during async steps above, bail out
    // ------------------------------------------------------------------
    if (this.destroyed) return;
    this._subscribeToPaymentsEvents();

    // ------------------------------------------------------------------
    // Step 10: Subscribe to CommunicationsModule DM events if available
    // ------------------------------------------------------------------
    if (deps.communications) {
      this.unsubscribeDMs = deps.communications.onDirectMessage((message: DirectMessage) => {
        this._handleIncomingDM(message).catch((err) => {
          logger.warn(LOG_TAG, 'Error handling incoming DM:', err);
        });
      });
    }

    // ------------------------------------------------------------------
    // Post-subscribe gap-fill re-scan (§7.6 step 7b)
    // Catches tokens that arrived between the initial scan and subscription.
    // ------------------------------------------------------------------
    await this._gapFillTokenScan();

    // Emit deferred reconciliation events now that the module is fully initialized
    for (const { event, payload } of deferredEvents) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps.emitEvent(event as keyof SphereEventMap, payload as any);
    }

    if (this.config.debug) {
      logger.debug(LOG_TAG, 'load() complete');
    }
  }

  // ===========================================================================
  // Lifecycle — destroy
  // ===========================================================================

  /**
   * Cleanup subscriptions and clear all in-memory state.
   * After calling destroy(), all public methods will throw `MODULE_DESTROYED`.
   */
  async destroy(): Promise<void> {
    // Set destroyed flag FIRST to prevent concurrent operations from seeing
    // partially cleared state during cleanup
    this.destroyed = true;

    // Unsubscribe from PaymentsModule events
    for (const unsub of this.unsubscribePayments) {
      try { unsub(); } catch { /* ignore */ }
    }
    this.unsubscribePayments = [];

    // Unsubscribe from CommunicationsModule DM events
    try { this.unsubscribeDMs?.(); } catch { /* ignore */ }
    this.unsubscribeDMs = null;

    // C3-R20 fix: Loop until _flushPromise is fully drained. A concurrent
    // _handleTokenChange can replace the reference between our await and the null
    // assignment, causing the replacement chain to escape the drain.
    await this._drainFlushPromise();

    // C2-R20 fix: Drain all in-flight gated operations. The loop inside drainAll()
    // terminates because: (1) destroyed=true prevents new public API calls,
    // (2) event handlers are unsubscribed above, (3) in-flight callbacks eventually
    // complete and the gate map cleans up idle entries.
    await this._gateMap.drainAll();

    // C1-R21 fix: Gated operations completing during the gate drain above may have
    // scheduled new _flushPromise chains (e.g., _flushDirtyLedgerEntries from event
    // pipeline code). Drain again to catch any flushes triggered by gated ops.
    await this._drainFlushPromise();

    // Safety flush: if dirty entries exist but no flush was ever scheduled
    // (e.g., payInvoice() wrote provisional entries but the token removal path
    // does NOT call notifyTokenChange → _handleTokenChange, so the flush is
    // never scheduled). This ensures provisional entries reach disk on process exit.
    if ((this.dirtyLedgerEntries.size > 0 || this.tokenScanDirty) && this.deps) {
      await this._flushDirtyLedgerEntries().catch((err) => {
        logger.warn(LOG_TAG, 'Error in safety flush during destroy:', err);
      });
    }

    // C10 fix: Do NOT call _clearInMemoryState() here. After destroyed=true +
    // unsubscribe + gate drain, the module is inert — all public API methods check
    // ensureNotDestroyed(). Clearing state while in-flight ops may still hold
    // references causes them to write into emptied maps, corrupting state.

    if (this.config.debug) {
      logger.debug(LOG_TAG, 'Module destroyed');
    }
  }

  // ===========================================================================
  // Guard helpers
  // ===========================================================================

  /**
   * Ensure dependencies have been injected via `initialize()`.
   * @throws {SphereError} `NOT_INITIALIZED`
   */
  private ensureInitialized(): void {
    if (!this.deps) {
      throw new SphereError(
        'AccountingModule has not been initialized. Call initialize(deps) first.',
        'NOT_INITIALIZED',
      );
    }
  }

  /**
   * Ensure the module has not been destroyed.
   * @throws {SphereError} `MODULE_DESTROYED`
   */
  private ensureNotDestroyed(): void {
    if (this.destroyed) {
      throw new SphereError(
        'AccountingModule has been destroyed.',
        'MODULE_DESTROYED',
      );
    }
  }

  // ===========================================================================
  // Safe BigInt parse helper
  // ===========================================================================

  /**
   * Parse a string as BigInt with validation. Returns 0n for invalid input
   * (consistent with balance-computer.ts parseBigInt).
   */
  private static _safeBigInt(amount: string): bigint {
    if (!amount || amount.length > 78) return 0n;
    if (!/^(0|[1-9]\d*)$/.test(amount)) return 0n;
    return BigInt(amount);
  }

  /**
   * Safely defer an event emission via queueMicrotask. Wraps the callback in
   * try/catch so a throwing event handler doesn't become an uncaught exception
   * that crashes the process.
   */
  private _deferEvent(fn: () => void): void {
    queueMicrotask(() => {
      try {
        fn();
      } catch (err) {
        logger.warn(LOG_TAG, 'Deferred event handler threw:', err);
      }
    });
  }

  // ===========================================================================
  // Per-invoice async mutex (§5.9)
  // ===========================================================================

  /**
   * Acquire the per-invoice serialization gate, execute `fn` exclusively, then
   * release. Prevents concurrent modification of the same invoice's state.
   *
   * The gate is implemented as a promise chain: each new operation appends to
   * the tail of the chain for the given invoiceId. When the chain becomes idle
   * (this operation's next-promise is still the gate tail), the key is deleted
   * to prevent unbounded memory growth.
   *
   * @param invoiceId - The invoice to gate on.
   * @param fn        - The async operation to run exclusively.
   * @returns The result of `fn`.
   */
  private async withInvoiceGate<T>(invoiceId: string, fn: () => Promise<T>): Promise<T> {
    return this._gateMap.withGate(invoiceId, fn, () => this.destroyed, 'MODULE_DESTROYED');
  }

  // ===========================================================================
  // Target membership check
  // ===========================================================================

  /**
   * Check whether any of the wallet's tracked addresses is listed as a target
   * in the given invoice. Compares `TrackedAddress.directAddress` against
   * `InvoiceTarget.address` (both are DIRECT:// strings — case-sensitive exact match).
   *
   * @param invoiceId - The invoice token ID.
   * @returns `true` if the local wallet is a target party for this invoice.
   */
  private isTarget(invoiceId: string): boolean {
    const terms = this.invoiceTermsCache.get(invoiceId);
    if (!terms) return false;

    const targetAddresses = new Set(terms.targets.map((t) => t.address));

    // Primary check: active (tracked) addresses
    const activeAddresses = this.deps!.getActiveAddresses();
    for (const addr of activeAddresses) {
      if (targetAddresses.has(addr.directAddress)) return true;
    }

    // Fallback: identity's own direct address (covers cases where tracked
    // addresses haven't loaded yet, e.g. right after startup or in instant-mode
    // flows where events fire before address tracking is fully initialized).
    const ownDirectAddress = this.deps!.identity?.directAddress;
    if (ownDirectAddress && targetAddresses.has(ownDirectAddress)) return true;

    return false;
  }

  // ===========================================================================
  // Public API — invoice stubs (to be implemented in later tasks)
  // ===========================================================================

  /**
   * Create and mint a new invoice on-chain.
   *
   * Flow (§2.1):
   * 1. Validate request (§8.1).
   * 2. Build InvoiceTerms with creator pubkey and createdAt timestamp.
   * 3. Serialize InvoiceTerms canonically into tokenData.
   * 4. Mint token via aggregator (same flow as NametagMinter).
   * 5. Store token via TokenStorageProvider.
   * 6. Scan full transaction history for pre-existing payments referencing this invoice.
   * 7. Fire 'invoice:created' event + any retroactive payment/coverage events.
   *
   * @param request - Invoice creation parameters.
   * @returns CreateInvoiceResult with token and parsed terms.
   *
   * @throws {SphereError} `INVOICE_NO_TARGETS` — targets array is empty.
   * @throws {SphereError} `INVOICE_NO_ASSETS` — a target has no assets.
   * @throws {SphereError} `INVOICE_INVALID_AMOUNT` — asset amount is not a positive integer.
   * @throws {SphereError} `INVOICE_INVALID_ADDRESS` — a target address is not a valid DIRECT:// address.
   * @throws {SphereError} `INVOICE_ORACLE_REQUIRED` — oracle provider is not available.
   * @throws {SphereError} `INVOICE_MINT_FAILED` — aggregator submission failed after retries.
   * @throws {SphereError} `NOT_INITIALIZED` — module not initialized.
   * @throws {SphereError} `MODULE_DESTROYED` — module has been destroyed.
   */
  async createInvoice(request: CreateInvoiceRequest): Promise<CreateInvoiceResult> {
    this.ensureInitialized();
    this.ensureNotDestroyed();

    const deps = this.deps!;

    // ------------------------------------------------------------------
    // Step 1: Validate CreateInvoiceRequest (§8.1)
    // ------------------------------------------------------------------

    // targets non-empty
    if (!request.targets || request.targets.length === 0) {
      throw new SphereError('Invoice must have at least one target', 'INVOICE_NO_TARGETS');
    }

    // ≤100 targets
    if (request.targets.length > 100) {
      throw new SphereError('Invoice exceeds maximum of 100 targets', 'INVOICE_TOO_MANY_TARGETS');
    }

    // memo ≤4096 chars
    if (request.memo !== undefined && request.memo.length > 4096) {
      throw new SphereError('Memo exceeds maximum of 4096 characters', 'INVOICE_MEMO_TOO_LONG');
    }

    // dueDate > Date.now() (if provided)
    if (request.dueDate !== undefined && request.dueDate <= Date.now()) {
      throw new SphereError('Due date must be in the future', 'INVOICE_PAST_DUE_DATE');
    }

    // deliveryMethods validation (if provided)
    if (request.deliveryMethods !== undefined) {
      if (request.deliveryMethods.length > 10) {
        throw new SphereError(
          'Delivery method must use https:// or wss:// scheme, max 2048 chars, max 10 entries',
          'INVOICE_INVALID_DELIVERY_METHOD',
        );
      }
      for (const method of request.deliveryMethods) {
        if (
          (!method.startsWith('https://') && !method.startsWith('wss://')) ||
          method.length > 2048
        ) {
          throw new SphereError(
            'Delivery method must use https:// or wss:// scheme, max 2048 chars, max 10 entries',
            'INVOICE_INVALID_DELIVERY_METHOD',
          );
        }
      }
    }

    // No duplicate target addresses and per-target validation
    const seenAddresses = new Set<string>();
    for (const target of request.targets) {
      // Each target address starts with 'DIRECT://'
      if (!target.address.startsWith('DIRECT://')) {
        throw new SphereError(
          'Invalid target address: must be DIRECT:// format',
          'INVOICE_INVALID_ADDRESS',
        );
      }

      if (seenAddresses.has(target.address)) {
        throw new SphereError('Duplicate target address in invoice', 'INVOICE_DUPLICATE_ADDRESS');
      }
      seenAddresses.add(target.address);

      // Each target has ≥1 asset
      if (!target.assets || target.assets.length === 0) {
        throw new SphereError('Target must have at least one asset', 'INVOICE_NO_ASSETS');
      }

      // ≤50 assets per target
      if (target.assets.length > 50) {
        throw new SphereError('Target exceeds maximum of 50 assets', 'INVOICE_TOO_MANY_ASSETS');
      }

      // Per-asset validation
      const seenCoinIds = new Set<string>();
      const seenNftIds = new Set<string>();

      for (const asset of target.assets) {
        // Each asset has exactly one of coin/nft
        const hasCoin = asset.coin !== undefined;
        const hasNft = asset.nft !== undefined;
        if (hasCoin === hasNft) {
          throw new SphereError(
            'Asset must have exactly one of coin or nft',
            'INVOICE_INVALID_ASSET',
          );
        }

        if (hasCoin) {
          const [coinId, amount] = asset.coin!;
          // CoinId: /^[A-Za-z0-9]+$/, ≤20 chars (per spec §createInvoice validation), non-empty
          if (!coinId || !/^[A-Za-z0-9]+$/.test(coinId) || coinId.length > 20) {
            throw new SphereError(
              'Coin ID must be non-empty, alphanumeric only, max 20 characters',
              'INVOICE_INVALID_COIN',
            );
          }
          // Coin amount matches /^[1-9][0-9]*$/ and ≤78 digits
          if (!amount || !/^[1-9][0-9]*$/.test(amount) || amount.length > 78) {
            throw new SphereError(
              'Coin amount must be a positive integer string',
              'INVOICE_INVALID_AMOUNT',
            );
          }
          // No duplicate coinIds per target
          if (seenCoinIds.has(coinId)) {
            throw new SphereError('Duplicate coin ID in target', 'INVOICE_DUPLICATE_COIN');
          }
          seenCoinIds.add(coinId);
        }

        if (hasNft) {
          const { tokenId } = asset.nft!;
          // NFT tokenId: /^[0-9a-f]{64}$/, non-empty
          if (!tokenId || !/^[0-9a-f]{64}$/.test(tokenId)) {
            throw new SphereError(
              'NFT tokenId must be a 64-char hex string',
              'INVOICE_INVALID_NFT',
            );
          }
          // No duplicate NFT tokenIds per target
          if (seenNftIds.has(tokenId)) {
            throw new SphereError('Duplicate NFT tokenId in target', 'INVOICE_DUPLICATE_NFT');
          }
          seenNftIds.add(tokenId);
        }
      }
    }

    // Oracle available — must have getStateTransitionClient.
    // NOTE (C3): The OracleProvider interface does not expose getStateTransitionClient(),
    // but the concrete UnicityAggregatorProvider implementation does. The `as any` cast
    // is a design compromise — changing the interface requires a cross-SDK breaking change.
    // The optional chain ensures a graceful error if the method is absent.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stClient = (deps.oracle as any).getStateTransitionClient?.();
    if (!stClient) {
      throw new SphereError(
        'Oracle provider required for invoice minting',
        'INVOICE_ORACLE_REQUIRED',
      );
    }

    const trustBase = deps.trustBase;

    // ------------------------------------------------------------------
    // Step 2: Build InvoiceTerms
    // ------------------------------------------------------------------
    const terms: InvoiceTerms = {
      creator: request.anonymous ? undefined : deps.identity.chainPubkey,
      createdAt: Date.now(),
      dueDate: request.dueDate,
      memo: request.memo,
      deliveryMethods: request.deliveryMethods,
      targets: request.targets,
    };

    // ------------------------------------------------------------------
    // Step 3: Canonical Serialize
    // ------------------------------------------------------------------
    const invoiceBytes = canonicalSerialize(terms);

    // Check serialized size ≤ 64 KB
    const invoiceBytesEncoded = new TextEncoder().encode(invoiceBytes);
    if (invoiceBytesEncoded.length > 64 * 1024) {
      throw new SphereError(
        'Serialized invoice terms exceed 64 KB limit',
        'INVOICE_TERMS_TOO_LARGE',
      );
    }

    // ------------------------------------------------------------------
    // Step 4: Generate deterministic salt — SHA-256(signingKey || invoiceBytes)
    // ------------------------------------------------------------------
    const privateKeyHex = deps.identity.privateKey;
    if (!privateKeyHex) {
      throw new SphereError('Private key required for invoice creation', 'NOT_INITIALIZED');
    }
    const hexMatches = privateKeyHex.match(/.{1,2}/g);
    if (!hexMatches) {
      throw new SphereError('Invalid private key format', 'NOT_INITIALIZED');
    }
    const signingKeyBytes = new Uint8Array(
      hexMatches.map((byte) => parseInt(byte, 16)),
    );
    const saltInput = new Uint8Array(signingKeyBytes.length + invoiceBytesEncoded.length);
    saltInput.set(signingKeyBytes, 0);
    saltInput.set(invoiceBytesEncoded, signingKeyBytes.length);
    const saltBuffer = await crypto.subtle.digest('SHA-256', saltInput);
    const salt = new Uint8Array(saltBuffer);

    // NOTE: signingKeyBytes is still needed for SigningService.createFromSecret() below.
    // Zero saltInput now (no longer needed after digest), but defer signingKeyBytes
    // zeroing to the finally block after all signing operations are complete.
    saltInput.fill(0);

    // CR-R20 fix: Guard trustBase before minting (matches importInvoice guard)
    if (!trustBase || (trustBase instanceof Uint8Array && trustBase.length === 0)) {
      throw new SphereError(
        'Trust base unavailable — cannot mint invoice token. Ensure oracle supports getTrustBase().',
        'INVOICE_ORACLE_REQUIRED',
      );
    }

    // ------------------------------------------------------------------
    // Steps 5–13: Mint token and store (mirrors NametagMinter pattern)
    // ------------------------------------------------------------------
    try {
      const { TokenId } = await import(
        '@unicitylabs/state-transition-sdk/lib/token/TokenId.js'
      );
      const { TokenType } = await import(
        '@unicitylabs/state-transition-sdk/lib/token/TokenType.js'
      );
      const { MintTransactionData } = await import(
        '@unicitylabs/state-transition-sdk/lib/transaction/MintTransactionData.js'
      );
      const { MintCommitment } = await import(
        '@unicitylabs/state-transition-sdk/lib/transaction/MintCommitment.js'
      );
      const { SigningService } = await import(
        '@unicitylabs/state-transition-sdk/lib/sign/SigningService.js'
      );
      const { HashAlgorithm } = await import(
        '@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm.js'
      );
      const { DataHasher } = await import(
        '@unicitylabs/state-transition-sdk/lib/hash/DataHasher.js'
      );
      const { UnmaskedPredicate } = await import(
        '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate.js'
      );
      const { UnmaskedPredicateReference } = await import(
        '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicateReference.js'
      );
      const { TokenState } = await import(
        '@unicitylabs/state-transition-sdk/lib/token/TokenState.js'
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { Token: SdkToken } = await import(
        '@unicitylabs/state-transition-sdk/lib/token/Token.js'
      );
      const { waitInclusionProof } = await import(
        '@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils.js'
      );

      // §3.1: Derive TokenId from SHA-256(invoiceBytes) using DataHasher
      const hash = await new DataHasher(HashAlgorithm.SHA256)
        .update(invoiceBytesEncoded)
        .digest();
      const invoiceTokenId = new TokenId(hash.imprint);
      const invoiceId = invoiceTokenId.toJSON(); // 64-char lowercase hex

      // CR-M5 fix: Check for duplicate before submitting to aggregator (matches importInvoice).
      // Same terms → same SHA-256 → same tokenId. Prevents double-mint attempts.
      if (this.invoiceTermsCache.has(invoiceId)) {
        throw new SphereError(
          `Invoice already exists locally: ${invoiceId}`,
          'INVOICE_ALREADY_EXISTS',
        );
      }

      // Step 5: Create MintTransactionData
      const invoiceTokenType = new TokenType(
        Buffer.from(INVOICE_TOKEN_TYPE_HEX, 'hex'),
      );

      // Create signing service from identity private key
      const signingService = await SigningService.createFromSecret(signingKeyBytes);

      // Build owner address using UnmaskedPredicateReference
      const addressRef = await UnmaskedPredicateReference.create(
        invoiceTokenType,
        signingService.algorithm,
        signingService.publicKey,
        HashAlgorithm.SHA256,
      );
      const ownerAddress = await addressRef.toAddress();

      const mintData = await MintTransactionData.create(
        invoiceTokenId,
        invoiceTokenType,
        invoiceBytesEncoded,     // tokenData: serialized InvoiceTerms (UTF-8 JSON)
        null,                    // coinData: null (non-fungible invoice token)
        ownerAddress,
        salt,
        null,                    // recipientDataHash: null
        null,                    // reason: null
      );

      if (this.config.debug) {
        logger.debug(LOG_TAG, `Created MintTransactionData for invoice ${invoiceId}`);
      }

      // Step 6: Create MintCommitment
      const commitment = await MintCommitment.create(mintData);

      if (this.config.debug) {
        logger.debug(LOG_TAG, 'Created MintCommitment for invoice');
      }

      // Step 7: Submit to aggregator with 3 retries
      // REQUEST_ID_EXISTS is treated as success (idempotent re-mint by same wallet)
      const MAX_RETRIES = 3;
      let submitSuccess = false;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          if (this.config.debug) {
            logger.debug(
              LOG_TAG,
              `Submitting invoice commitment (attempt ${attempt}/${MAX_RETRIES})...`,
            );
          }
          const response = await stClient.submitMintCommitment(commitment);

          if (response.status === 'SUCCESS' || response.status === 'REQUEST_ID_EXISTS') {
            if (this.config.debug) {
              logger.debug(
                LOG_TAG,
                response.status === 'REQUEST_ID_EXISTS'
                  ? 'Invoice commitment already exists (idempotent re-mint)'
                  : 'Invoice commitment submitted successfully',
              );
            }
            submitSuccess = true;
            break;
          } else {
            logger.warn(LOG_TAG, `Invoice commitment submission failed: ${response.status}`);
            if (attempt === MAX_RETRIES) {
              throw new SphereError(
                `Failed to mint invoice token: commitment rejected after ${MAX_RETRIES} attempts: ${response.status}`,
                'INVOICE_MINT_FAILED',
              );
            }
            await new Promise((r) => setTimeout(r, 1000 * attempt));
          }
        } catch (retryErr) {
          if (retryErr instanceof SphereError && (
            retryErr.code === 'INVOICE_ORACLE_REQUIRED' ||
            retryErr.code === 'INVOICE_INVALID_PROOF' ||
            retryErr.code === 'INVOICE_MINT_FAILED' ||
            retryErr.code === 'NOT_INITIALIZED' ||
            retryErr.code === 'MODULE_DESTROYED'
          )) throw retryErr;
          logger.warn(LOG_TAG, `Invoice commitment attempt ${attempt} error:`, retryErr);
          if (attempt === MAX_RETRIES) {
            throw new SphereError(
              `Failed to mint invoice token: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
              'INVOICE_MINT_FAILED',
              retryErr,
            );
          }
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }

      if (!submitSuccess) {
        throw new SphereError(
          'Failed to mint invoice token: commitment submission failed after retries',
          'INVOICE_MINT_FAILED',
        );
      }

      // Step 8: Wait for inclusion proof
      if (this.config.debug) {
        logger.debug(LOG_TAG, 'Waiting for invoice inclusion proof...');
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inclusionProof = await waitInclusionProof(trustBase as any, stClient, commitment);
      if (this.config.debug) {
        logger.debug(LOG_TAG, 'Invoice inclusion proof received');
      }

      // Step 9: Create genesis transaction
      const genesisTransaction = commitment.toTransaction(inclusionProof);

      // Step 10: Create UnmaskedPredicate + TokenState
      const invoicePredicate = await UnmaskedPredicate.create(
        invoiceTokenId,
        invoiceTokenType,
        signingService,
        HashAlgorithm.SHA256,
        salt,
      );
      const tokenState = new TokenState(invoicePredicate, null);

      // Step 11: Create Token
      // Always verify against trust base — never skip proof verification
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sdkToken: any = await SdkToken.mint(trustBase as any, tokenState, genesisTransaction);

      if (this.config.debug) {
        logger.debug(LOG_TAG, 'Invoice token minted successfully');
      }

      // ------------------------------------------------------------------
      // Step 12: Store token via PaymentsModule.addToken()
      // The sdkToken.toJSON() produces a TxfToken-compatible object which is
      // stored as sdkData (JSON string) on the UI Token.
      // ------------------------------------------------------------------
      const sdkTokenJson = sdkToken.toJSON();
      const uiToken: import('../../types/index.js').Token = {
        id: invoiceId,
        coinId: INVOICE_TOKEN_TYPE_HEX,
        symbol: 'INVOICE',
        name: 'Invoice',
        decimals: 0,
        amount: '0',
        status: 'confirmed',
        createdAt: terms.createdAt,
        updatedAt: terms.createdAt,
        sdkData: JSON.stringify(sdkTokenJson),
      };

      await deps.payments.addToken(uiToken);

      // Update in-memory invoice terms cache.
      // Normalize symbolic coinIds (e.g. "BTC", "ETH") to hash coinIds so that
      // _handleIncomingTransfer's matchesAsset check can match real token coinIds.
      // The token was minted with the original `terms` (canonical hash), so this
      // normalization only affects the in-memory matching cache.
      this.invoiceTermsCache.set(invoiceId, this._normalizeInvoiceTerms(terms));

      // Initialize ledger entry for this invoice in the outer map
      if (!this.invoiceLedger.has(invoiceId)) {
        this.invoiceLedger.set(invoiceId, new Map());
      }

      // ------------------------------------------------------------------
      // Step 13: Scan all current tokens for pre-existing payments referencing
      //          this invoice (retroactive indexing per §3.2 step 13 / §5.4.4)
      // ------------------------------------------------------------------
      const allTokens = deps.payments.getTokens();
      let anyScanDirty = false;

      for (const token of allTokens) {
        if (!token.sdkData) continue;
        let txf: TxfToken;
        try {
          txf = JSON.parse(token.sdkData) as TxfToken;
        } catch {
          continue;
        }
        // Only scan tokens that have transactions (payment/transfer tokens)
        const txCount = txf.transactions?.length ?? 0;
        if (txCount === 0) continue;
        // Full scan from index 0 for retroactive discovery
        this._processTokenTransactions(token.id, txf, 0);
        anyScanDirty = true;
      }

      // Also scan archived tokens (spec §5.4 Phase 2 step 5)
      const archivedTokensForScan = deps.payments.getArchivedTokens();
      for (const [archivedId, txf] of archivedTokensForScan) {
        const txCount = txf.transactions?.length ?? 0;
        if (txCount === 0) continue;
        this._processTokenTransactions(archivedId, txf, 0);
        anyScanDirty = true;
      }

      if (anyScanDirty) {
        await this._flushDirtyLedgerEntries();
      }

      // ------------------------------------------------------------------
      // Step 14: Fire 'invoice:created' event
      // ------------------------------------------------------------------
      deps.emitEvent('invoice:created', { invoiceId, confirmed: true });

      if (this.config.debug) {
        logger.debug(LOG_TAG, `Invoice created and stored: ${invoiceId}`);
      }

      // ------------------------------------------------------------------
      // Step 15: Return result
      // ------------------------------------------------------------------
      const txfToken: TxfToken = sdkTokenJson as unknown as TxfToken;

      return {
        success: true,
        invoiceId,
        token: txfToken,
        terms,
      };
    } catch (err) {
      // Re-throw SphereErrors (validation, oracle, mint failures) as-is
      if (err instanceof SphereError) throw err;

      const message = err instanceof Error ? err.message : String(err);
      throw new SphereError(
        `Failed to mint invoice token: ${message}`,
        'INVOICE_MINT_FAILED',
        err,
      );
    } finally {
      // Zero private key material on all paths (success, error, or re-throw)
      signingKeyBytes.fill(0);
    }
  }

  /**
   * Import an invoice token received from another party.
   * The token is validated (proof chain, token type, parseable tokenData).
   * Stored via TokenStorageProvider alongside other tokens.
   *
   * After import, scans full transaction history for any pre-existing payments
   * referencing this invoice and fires retroactive events.
   *
   * @param token - Invoice token in TXF format.
   * @returns Parsed InvoiceTerms.
   *
   * @throws {SphereError} `INVOICE_INVALID_PROOF` — inclusion proof is invalid.
   * @throws {SphereError} `INVOICE_WRONG_TOKEN_TYPE` — token type is not INVOICE_TOKEN_TYPE_HEX.
   * @throws {SphereError} `INVOICE_INVALID_DATA` — tokenData cannot be parsed as InvoiceTerms.
   * @throws {SphereError} `INVOICE_ALREADY_EXISTS` — invoice token already exists locally.
   * @throws {SphereError} `NOT_INITIALIZED` — module not initialized.
   * @throws {SphereError} `MODULE_DESTROYED` — module has been destroyed.
   */
  async importInvoice(token: TxfToken): Promise<InvoiceTerms> {
    this.ensureNotDestroyed();
    this.ensureInitialized();

    const deps = this.deps!;

    // ------------------------------------------------------------------
    // Step 1: Validate token type
    // ------------------------------------------------------------------
    const tokenType = token.genesis?.data?.tokenType;
    if (tokenType !== INVOICE_TOKEN_TYPE_HEX) {
      throw new SphereError(
        `Invoice import failed: token type "${tokenType}" is not the expected invoice type.`,
        'INVOICE_WRONG_TOKEN_TYPE',
      );
    }

    // ------------------------------------------------------------------
    // Step 2: Parse and validate InvoiceTerms from tokenData
    // ------------------------------------------------------------------
    const tokenData = token.genesis?.data?.tokenData;
    if (!tokenData || typeof tokenData !== 'string') {
      throw new SphereError(
        'Invoice import failed: missing or invalid tokenData field.',
        'INVOICE_INVALID_DATA',
      );
    }

    // tokenData may be plain JSON or hex-encoded UTF-8 JSON
    // (state-transition-sdk stores it as hex via HexConverter.encode).
    let jsonString = tokenData;
    if (!/^\s*[\[{"]/.test(tokenData)) {
      // Doesn't look like JSON — attempt hex decode
      try {
        const bytes = hexToBytes(tokenData);
        jsonString = new TextDecoder().decode(bytes);
      } catch {
        // not valid hex — fall through to JSON.parse which will produce the proper error
      }
    }
    let terms: InvoiceTerms;
    try {
      terms = JSON.parse(jsonString) as InvoiceTerms;
    } catch {
      throw new SphereError(
        'Invoice import failed: tokenData is not valid JSON.',
        'INVOICE_INVALID_DATA',
      );
    }

    // ------------------------------------------------------------------
    // Step 3: Business validation of InvoiceTerms (§8.2)
    // ------------------------------------------------------------------
    if (!terms || typeof terms !== 'object') {
      throw new SphereError(
        'Invoice import failed: tokenData did not parse as an object.',
        'INVOICE_INVALID_DATA',
      );
    }

    // createdAt: positive integer, ≤ now + 1-day clock skew
    if (
      typeof terms.createdAt !== 'number' ||
      !Number.isInteger(terms.createdAt) ||
      terms.createdAt <= 0 ||
      terms.createdAt > Date.now() + 86400000
    ) {
      throw new SphereError(
        'Invoice import failed: createdAt is missing, invalid, or exceeds allowed clock skew.',
        'INVOICE_INVALID_DATA',
      );
    }

    // dueDate: if present (and not null), must be a positive integer (may be in the past for imports).
    // canonicalSerialize normalizes undefined → null, so null means "no dueDate".
    if (terms.dueDate != null) {
      if (
        typeof terms.dueDate !== 'number' ||
        !Number.isInteger(terms.dueDate) ||
        terms.dueDate <= 0
      ) {
        throw new SphereError(
          'Invoice import failed: dueDate is present but not a positive integer.',
          'INVOICE_INVALID_DATA',
        );
      }
    }

    // targets: non-empty array
    if (!Array.isArray(terms.targets) || terms.targets.length === 0) {
      throw new SphereError(
        'Invoice import failed: targets must be a non-empty array.',
        'INVOICE_INVALID_DATA',
      );
    }

    // Validate each target
    const seenAddresses = new Set<string>();
    for (const target of terms.targets) {
      if (
        typeof target.address !== 'string' ||
        !target.address.startsWith('DIRECT://') ||
        target.address.length <= 'DIRECT://'.length
      ) {
        throw new SphereError(
          `Invoice import failed: target address "${target.address}" is not a valid DIRECT:// address.`,
          'INVOICE_INVALID_DATA',
        );
      }
      if (seenAddresses.has(target.address)) {
        throw new SphereError(
          `Invoice import failed: duplicate target address "${target.address}".`,
          'INVOICE_INVALID_DATA',
        );
      }
      seenAddresses.add(target.address);

      if (!Array.isArray(target.assets) || target.assets.length === 0) {
        throw new SphereError(
          `Invoice import failed: target "${target.address}" has no assets.`,
          'INVOICE_INVALID_DATA',
        );
      }

      const seenCoins = new Set<string>();
      for (const asset of target.assets) {
        if (asset.coin === undefined && asset.nft === undefined) {
          throw new SphereError(
            'Invoice import failed: asset must have exactly one of coin or nft.',
            'INVOICE_INVALID_DATA',
          );
        }
        if (asset.coin !== undefined && asset.nft !== undefined) {
          throw new SphereError(
            'Invoice import failed: asset must have exactly one of coin or nft, not both.',
            'INVOICE_INVALID_DATA',
          );
        }

        if (asset.coin !== undefined) {
          const [coinId, amount] = asset.coin;
          if (
            typeof coinId !== 'string' ||
            coinId.length === 0 ||
            coinId.length > 20 ||
            !/^[A-Za-z0-9]+$/.test(coinId)
          ) {
            throw new SphereError(
              `Invoice import failed: invalid coinId "${coinId}".`,
              'INVOICE_INVALID_DATA',
            );
          }
          if (seenCoins.has(coinId)) {
            throw new SphereError(
              `Invoice import failed: duplicate coinId "${coinId}" in target "${target.address}".`,
              'INVOICE_INVALID_DATA',
            );
          }
          seenCoins.add(coinId);
          if (
            typeof amount !== 'string' ||
            !/^[1-9][0-9]*$/.test(amount) ||
            amount.length > 78
          ) {
            throw new SphereError(
              `Invoice import failed: invalid amount "${amount}" for coin "${coinId}".`,
              'INVOICE_INVALID_DATA',
            );
          }
        }
      }
    }

    // ------------------------------------------------------------------
    // Step 4: Check for duplicate (token already imported)
    // ------------------------------------------------------------------
    const tokenId = token.genesis?.data?.tokenId;
    if (!tokenId || typeof tokenId !== 'string') {
      throw new SphereError(
        'Invoice import failed: missing tokenId in genesis data.',
        'INVOICE_INVALID_DATA',
      );
    }

    if (this.invoiceTermsCache.has(tokenId)) {
      throw new SphereError(
        `Invoice already exists locally: ${tokenId}`,
        'INVOICE_ALREADY_EXISTS',
      );
    }

    // CR-M1 fix: Verify that canonical re-serialization of parsed terms produces
    // a hash matching the on-chain tokenId. This cryptographically binds the
    // human-readable terms to the on-chain commitment, preventing an attacker from
    // submitting terms with extra fields or alternate key ordering.
    //
    // IMPORTANT: Must use the same DataHasher + TokenId path as createInvoice().
    // DataHasher.SHA256.digest().imprint is [2-byte algorithm tag (0x0000)] +
    // [32-byte SHA-256] = 34 bytes → TokenId.toJSON() = 68-char hex.
    // crypto.subtle.digest produces only the 32-byte SHA-256 (64-char hex) which
    // does NOT match the 68-char tokenId stored on-chain.
    {
      const { DataHasher } = await import(
        '@unicitylabs/state-transition-sdk/lib/hash/DataHasher.js'
      );
      const { HashAlgorithm } = await import(
        '@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm.js'
      );
      const { TokenId } = await import(
        '@unicitylabs/state-transition-sdk/lib/token/TokenId.js'
      );
      const reSerializedBytes = new TextEncoder().encode(canonicalSerialize(terms));
      const hash = await new DataHasher(HashAlgorithm.SHA256)
        .update(reSerializedBytes)
        .digest();
      const reTokenId = new TokenId(hash.imprint).toJSON();
      if (reTokenId !== tokenId) {
        throw new SphereError(
          'Invoice import failed: parsed terms do not match on-chain token ID (canonical hash mismatch).',
          'INVOICE_INVALID_DATA',
        );
      }
    }

    // ------------------------------------------------------------------
    // Step 5: Verify inclusion proof (SECURITY CRITICAL)
    // We reconstruct the SDK token from JSON and call token.verify() against
    // the trust base. Token.fromJSON() reconstructs without verification;
    // verify() performs the cryptographic proof check.
    // ------------------------------------------------------------------

    // C2/C6 fix: Reject imports when trustBase is empty — without a valid trust
    // base, verify() may silently accept forged proofs depending on SDK behavior.
    if (!deps.trustBase || (deps.trustBase instanceof Uint8Array && deps.trustBase.length === 0)) {
      throw new SphereError(
        'Trust base unavailable — cannot verify invoice proof. Ensure oracle supports getTrustBase().',
        'INVOICE_INVALID_PROOF',
      );
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sdkToken = await SdkToken.fromJSON(token as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const verifyResult = await sdkToken.verify(deps.trustBase as any);
      // CR-M2 fix: Token.verify() always returns a VerificationResult object.
      // Check .isSuccessful === true for strict validation (no boolean fallback).
      const verifyOk = (verifyResult as { isSuccessful?: boolean }).isSuccessful === true;
      if (!verifyOk) {
        throw new SphereError(
          'Invoice import failed: inclusion proof is invalid.',
          'INVOICE_INVALID_PROOF',
        );
      }

      // C7 fix: Verify that the JSON-supplied tokenId matches the cryptographically
      // computed token identity. Without this check, an attacker can submit a valid
      // proof for token X while claiming it is token Y, poisoning the ledger cache.
      // CRITICAL: Require a match, not just check for mismatch — if canonicalTokenId
      // is undefined/null, reject rather than silently accepting.
      const canonicalTokenId = sdkToken.id?.toJSON?.() ?? null;
      if (!canonicalTokenId || canonicalTokenId !== tokenId) {
        throw new SphereError(
          `Invoice import failed: tokenId mismatch or unverifiable — JSON claims ${tokenId}, cryptographic identity is ${canonicalTokenId ?? 'unknown'}`,
          'INVOICE_INVALID_DATA',
        );
      }
    } catch (err) {
      if (err instanceof SphereError) throw err;
      throw new SphereError(
        `Invoice import failed: proof verification error — ${err instanceof Error ? err.message : String(err)}`,
        'INVOICE_INVALID_PROOF',
      );
    }

    // ------------------------------------------------------------------
    // Step 6: Store the token via PaymentsModule.addToken()
    // Invoice tokens have null coinData — build the uiToken directly like
    // createInvoice() does, rather than using txfToToken() which would crash
    // calling .reduce() on null.
    // ------------------------------------------------------------------
    try {
      const uiToken: import('../../types/index.js').Token = {
        id: tokenId,
        coinId: INVOICE_TOKEN_TYPE_HEX,
        symbol: 'INVOICE',
        name: 'Invoice',
        decimals: 0,
        amount: '0',
        status: 'confirmed',
        createdAt: terms.createdAt,
        updatedAt: terms.createdAt,
        sdkData: JSON.stringify(token),
      };
      await deps.payments.addToken(uiToken);
    } catch (err) {
      throw new SphereError(
        `importInvoice: failed to persist token ${tokenId} — ${err instanceof Error ? err.message : String(err)}`,
        'INVOICE_STORAGE_FAILED',
        err instanceof Error ? err : undefined,
      );
    }

    // ------------------------------------------------------------------
    // Step 6b: Normalize coinIds in terms — resolve short symbols to hashes.
    //
    // Invoices created by external parties (e.g. escrow) may use symbolic
    // currency names ("BTC", "ETH") instead of the 64/68-char hex coinId
    // hashes that token storage uses. The balance computer matches transfer
    // coinIds against invoice target coinIds by exact string comparison, so
    // a symbol/hash mismatch causes all payments to be classified as
    // 'unknown_asset'. Resolve any symbol-looking coinIds to their registry
    // hashes before storing so computeInvoiceStatus works correctly.
    // ------------------------------------------------------------------
    {
      const registry = TokenRegistry.getInstance();
      const normalizedTargets = terms.targets.map(target => ({
        ...target,
        assets: target.assets.map(asset => {
          if (!asset.coin) return asset;
          const [coinId, amount] = asset.coin;
          // Resolve only if it looks like a short symbol (≤20 alphanumeric chars)
          if (coinId.length <= 20 && /^[A-Za-z0-9]+$/.test(coinId)) {
            const def = registry.getDefinitionBySymbol(coinId);
            if (def?.id && def.id !== coinId) {
              return { ...asset, coin: [def.id, amount] as [string, string] };
            }
          }
          return asset;
        }),
      }));
      terms = { ...terms, targets: normalizedTargets };
    }

    // ------------------------------------------------------------------
    // Step 7: Register in invoiceTermsCache
    // ------------------------------------------------------------------
    // W11: Decrement unknown count if this invoice was previously indexed as unknown
    if (this.invoiceLedger.has(tokenId) && !this.invoiceTermsCache.has(tokenId)) {
      this.unknownLedgerCount = Math.max(0, this.unknownLedgerCount - 1);
    }
    this.invoiceTermsCache.set(tokenId, terms);

    if (!this.invoiceLedger.has(tokenId)) {
      this.invoiceLedger.set(tokenId, new Map());
    }

    // ------------------------------------------------------------------
    // Step 8: Proactive indexing check.
    //
    // With proactive indexing, _processTokenTransactions() indexes ALL
    // invoice-referencing transactions regardless of whether the invoice
    // is known — so entries for this invoice may already be in the ledger
    // from prior token scans.
    //
    // We still scan for any remaining gaps (tokens added since last scan)
    // to handle the edge case where a token arrived between scans.
    // ------------------------------------------------------------------
    const allTokens = deps.payments.getTokens();
    let anyDirty = false;
    for (const existingToken of allTokens) {
      if (!existingToken.sdkData) continue;
      let txf: TxfToken;
      try {
        txf = JSON.parse(existingToken.sdkData) as TxfToken;
      } catch {
        continue;
      }
      const transactions = txf.transactions ?? [];
      const startIndex = this.tokenScanState.get(existingToken.id) ?? 0;
      if (transactions.length > startIndex) {
        this._processTokenTransactions(existingToken.id, txf, startIndex);
        anyDirty = true;
      }
    }

    // Also scan archived tokens (spec §5.4 Phase 2 step 5)
    const archivedTokensForGap = deps.payments.getArchivedTokens();
    for (const [archivedId, txf] of archivedTokensForGap) {
      const transactions = txf.transactions ?? [];
      const startIndex = this.tokenScanState.get(archivedId) ?? 0;
      if (transactions.length > startIndex) {
        this._processTokenTransactions(archivedId, txf, startIndex);
        anyDirty = true;
      }
    }

    if (anyDirty) {
      await this._flushDirtyLedgerEntries();
    }

    // ------------------------------------------------------------------
    // Step 9: Fire 'invoice:created' event
    // ------------------------------------------------------------------
    deps.emitEvent('invoice:created', { invoiceId: tokenId, confirmed: false });

    if (this.config.debug) {
      logger.debug(LOG_TAG, `importInvoice: imported invoice ${tokenId}`);
    }

    return terms;
  }

  /**
   * Compute the current status of an invoice from local data (§5.1).
   *
   * For non-terminal invoices: reads from the persistent invoice-transfer index.
   * For terminal invoices (CLOSED, CANCELLED): returns persisted frozen balances.
   *
   * SIDE EFFECT: When the computed status reaches implicit close (all targets covered
   * and all tokens confirmed), this call acquires the per-invoice gate, re-verifies,
   * freezes balances, persists them, and may trigger surplus auto-return.
   *
   * @param invoiceId - The invoice token ID.
   * @returns Computed InvoiceStatus.
   *
   * @throws {SphereError} `INVOICE_NOT_FOUND` — invoice token not found locally.
   * @throws {SphereError} `NOT_INITIALIZED` — module not initialized.
   * @throws {SphereError} `MODULE_DESTROYED` — module has been destroyed.
   */
  async getInvoiceStatus(invoiceId: string): Promise<InvoiceStatus> {
    this.ensureNotDestroyed();
    this.ensureInitialized();

    // Step 1: Verify invoice exists
    if (!this.invoiceTermsCache.has(invoiceId)) {
      throw new SphereError(
        `Invoice not found: ${invoiceId}`,
        'INVOICE_NOT_FOUND',
      );
    }

    const terms = this.invoiceTermsCache.get(invoiceId)!;

    // Step 2: Check if terminal — reconstruct from frozen balances
    if (this.frozenBalances.has(invoiceId)) {
      const frozen = this.frozenBalances.get(invoiceId)!;
      // Reconstruct from frozen (allConfirmed = true placeholder from computeInvoiceStatus)
      const status = computeInvoiceStatus(invoiceId, terms, [], frozen, new Set());

      // Dynamically compute allConfirmed from the frozen transfers
      const allTransfers: InvoiceTransferRef[] = [];
      for (const target of frozen.targets) {
        for (const coinAsset of target.coinAssets) {
          allTransfers.push(...coinAsset.transfers);
        }
      }
      const allConfirmed =
        allTransfers.length > 0 && allTransfers.every((t) => t.confirmed);

      return { ...status, allConfirmed };
    }

    // Step 3: Non-terminal — compute dynamically from index
    const entries = this.invoiceLedger.get(invoiceId)
      ? Array.from(this.invoiceLedger.get(invoiceId)!.values())
      : [];

    // Build wallet addresses set for self-payment detection
    const activeAddresses = this.deps!.getActiveAddresses();
    const walletAddresses = new Set(activeAddresses.map((a) => a.directAddress));
    if (this.deps!.identity?.directAddress) walletAddresses.add(this.deps!.identity.directAddress);

    const status = computeInvoiceStatus(invoiceId, terms, entries, null, walletAddresses);

    // Step 4: Check for implicit close — COVERED + allConfirmed triggers auto-close
    if (status.state === 'COVERED' && status.allConfirmed) {
      // Use withInvoiceGate to serialize access
      return await this.withInvoiceGate(invoiceId, async () => {
        this.ensureNotDestroyed();

        // Already terminal? Return frozen status
        if (this.frozenBalances.has(invoiceId)) {
          const frozen = this.frozenBalances.get(invoiceId)!;
          const frozenStatus = computeInvoiceStatus(invoiceId, terms, [], frozen, new Set());
          const frozenTransfers: InvoiceTransferRef[] = [];
          for (const target of frozen.targets) {
            for (const coinAsset of target.coinAssets) {
              frozenTransfers.push(...coinAsset.transfers);
            }
          }
          const frozenAllConfirmed =
            frozenTransfers.length > 0 && frozenTransfers.every((t) => t.confirmed);
          return { ...frozenStatus, allConfirmed: frozenAllConfirmed };
        }

        // Re-verify inside the gate: recompute to confirm still COVERED + allConfirmed
        // Recompute walletAddresses inside the gate to avoid stale data (W15 fix)
        const gateActiveAddresses = this.deps!.getActiveAddresses();
        const gateWalletAddresses = new Set(gateActiveAddresses.map((a) => a.directAddress));
        const reEntries = this.invoiceLedger.get(invoiceId)
          ? Array.from(this.invoiceLedger.get(invoiceId)!.values())
          : [];
        const reStatus = computeInvoiceStatus(
          invoiceId,
          terms,
          reEntries,
          null,
          gateWalletAddresses,
        );

        if (reStatus.state === 'COVERED' && reStatus.allConfirmed) {
          // Determine latest sender per target:coinId (same logic as closeInvoice)
          const latestSenderMap = new Map<string, Map<string, string>>();
          const targetAddressSet = new Set(terms.targets.map((t) => t.address));

          for (const entry of reEntries) {
            if (
              entry.paymentDirection === 'forward' &&
              targetAddressSet.has(entry.destinationAddress)
            ) {
              const effectiveSender = entry.refundAddress ?? entry.senderAddress;
              if (effectiveSender === null || effectiveSender === undefined) continue;

              let coinMap = latestSenderMap.get(entry.destinationAddress);
              if (!coinMap) {
                coinMap = new Map();
                latestSenderMap.set(entry.destinationAddress, coinMap);
              }
              // Overwrite — last entry in iteration order wins (processing order)
              coinMap.set(entry.coinId, effectiveSender);
            }
          }

          // Perform implicit close
          const frozen = freezeBalances(terms, reStatus, 'CLOSED', false, latestSenderMap);
          this.frozenBalances.set(invoiceId, frozen);
          this.closedInvoices.add(invoiceId);

          // C5 fix: Persist in crash-safe order: frozen balances FIRST, then terminal set.
          // The terminal set write is the commit point — crash between writes = not terminal.
          await this._persistFrozenBalances();
          await this._persistTerminalSets();

          // Invalidate balance cache
          this.balanceCache.delete(invoiceId);

          // BUG-002 Fix 4: Defer event emission until after the gate is released.
          // Handlers that call back into AccountingModule would queue behind the gate,
          // seeing inconsistent state (e.g., closed but _executeTerminationReturns not yet run).
          const depsRef = this.deps!;
          this._deferEvent(() => depsRef.emitEvent('invoice:closed', { invoiceId, explicit: false }));

          // Return the now-frozen status with dynamic allConfirmed
          const closedTransfers: InvoiceTransferRef[] = [];
          for (const target of frozen.targets) {
            for (const coinAsset of target.coinAssets) {
              closedTransfers.push(...coinAsset.transfers);
            }
          }
          const closedAllConfirmed =
            closedTransfers.length > 0 && closedTransfers.every((t) => t.confirmed);

          return {
            ...computeInvoiceStatus(invoiceId, terms, [], frozen, new Set()),
            allConfirmed: closedAllConfirmed,
          };
        }

        // Conditions changed — return the re-verified status as-is
        return reStatus;
      });
    }

    // Step 5: EXPIRED overlay — if not COVERED and dueDate has passed
    // Note: computeInvoiceStatus already handles the EXPIRED state in the non-terminal path
    // (state = 'EXPIRED' when dueDate < Date.now() and not covered). We just return as-is.
    return status;
  }

  /**
   * List invoice tokens with optional filtering and pagination (§2.1).
   *
   * Returns lightweight InvoiceRef objects (token ID + parsed terms).
   * Status is NOT computed unless a `state` filter is provided.
   *
   * @param options - Filter/sort/pagination options.
   * @returns Array of InvoiceRef objects.
   *
   * @throws {SphereError} `NOT_INITIALIZED` — module not initialized.
   * @throws {SphereError} `MODULE_DESTROYED` — module has been destroyed.
   */
  async getInvoices(options?: GetInvoicesOptions): Promise<InvoiceRef[]> {
    this.ensureNotDestroyed();
    this.ensureInitialized();

    const identity = this.deps!.identity;
    const activeAddresses = this.deps!.getActiveAddresses();
    const walletDirectAddresses = new Set(activeAddresses.map((a) => a.directAddress));

    // Build the full list of InvoiceRef objects from the terms cache
    let results: InvoiceRef[] = [];
    for (const [tokenId, terms] of this.invoiceTermsCache) {
      results.push({
        invoiceId: tokenId,
        terms,
        isCreator: terms.creator !== undefined && terms.creator === identity.chainPubkey,
        cancelled: this.cancelledInvoices.has(tokenId),
        closed: this.closedInvoices.has(tokenId),
      });
    }

    // Apply createdByMe filter
    if (options?.createdByMe !== undefined) {
      const wantCreatedByMe = options.createdByMe;
      results = results.filter((ref) => ref.isCreator === wantCreatedByMe);
    }

    // Apply targetingMe filter
    if (options?.targetingMe !== undefined) {
      const wantTargetingMe = options.targetingMe;
      results = results.filter((ref) => {
        const isTargeted = ref.terms.targets.some((t) =>
          walletDirectAddresses.has(t.address),
        );
        return isTargeted === wantTargetingMe;
      });
    }

    // Apply state filter — requires computing status for each candidate (expensive)
    if (options?.state !== undefined) {
      const wantedStates = Array.isArray(options.state)
        ? new Set(options.state)
        : new Set([options.state]);

      const filtered: InvoiceRef[] = [];
      for (const ref of results) {
        let status: InvoiceStatus;
        try {
          status = await this.getInvoiceStatus(ref.invoiceId);
        } catch {
          // Skip invoices whose status cannot be computed
          continue;
        }
        if (wantedStates.has(status.state)) {
          filtered.push(ref);
        }
      }
      results = filtered;
    }

    // Apply sorting
    const sortBy = options?.sortBy ?? 'createdAt';
    const sortOrder = options?.sortOrder ?? 'desc';
    const direction = sortOrder === 'asc' ? 1 : -1;

    results.sort((a, b) => {
      if (sortBy === 'dueDate') {
        const da = a.terms.dueDate;
        const db = b.terms.dueDate;
        // null-last: invoices without dueDate sort after those with one
        if (da === undefined && db === undefined) return 0;
        if (da === undefined) return 1;   // a has no due date → a after b
        if (db === undefined) return -1;  // b has no due date → b after a
        return direction * (da - db);
      } else {
        // createdAt (default)
        return direction * (a.terms.createdAt - b.terms.createdAt);
      }
    });

    // Apply pagination
    const offset = options?.offset ?? 0;
    const limit = options?.limit;

    if (offset > 0) {
      results = results.slice(offset);
    }
    if (limit !== undefined && limit >= 0) {
      results = results.slice(0, limit);
    }

    return results;
  }

  /**
   * Get a single invoice by token ID. Synchronous — cancelled/closed sets
   * are kept in memory after load(), so no async storage reads are needed.
   *
   * @param invoiceId - The invoice token ID.
   * @returns InvoiceRef or null if not found.
   *
   * @throws {SphereError} `NOT_INITIALIZED` — module not initialized.
   */
  getInvoice(invoiceId: string): InvoiceRef | null {
    // W1: getInvoice() is intentionally exempt from ensureNotDestroyed() per spec §10 —
    // it is synchronous, read-only, in-memory. Same exemption as getAutoReturnSettings().
    this.ensureInitialized();

    const terms = this.invoiceTermsCache.get(invoiceId);
    if (!terms) return null;

    return {
      invoiceId,
      terms,
      isCreator: terms.creator === this.deps!.identity.chainPubkey,
      cancelled: this.cancelledInvoices.has(invoiceId),
      closed: this.closedInvoices.has(invoiceId),
    };
  }

  /**
   * Explicitly close an invoice. Only target parties may close (§8.3).
   *
   * On close:
   * 1. Current balances are computed one final time and frozen.
   * 2. Invoice ID is added to the closed set in storage.
   * 3. Fires 'invoice:closed' with { explicit: true }.
   * 4. If autoReturn is true, auto-return is enabled and surplus is returned immediately.
   *
   * @param invoiceId - The invoice token ID.
   * @param options   - Optional: { autoReturn?: boolean }.
   *
   * @throws {SphereError} `INVOICE_NOT_FOUND` — invoice token not found locally.
   * @throws {SphereError} `INVOICE_NOT_TARGET` — caller is not a target party.
   * @throws {SphereError} `INVOICE_ALREADY_CLOSED` — invoice is already closed.
   * @throws {SphereError} `INVOICE_ALREADY_CANCELLED` — invoice is already cancelled.
   * @throws {SphereError} `NOT_INITIALIZED` — module not initialized.
   * @throws {SphereError} `MODULE_DESTROYED` — module has been destroyed.
   */
  async closeInvoice(invoiceId: string, options?: { autoReturn?: boolean }): Promise<void> {
    this.ensureNotDestroyed();
    this.ensureInitialized();

    // Pre-gate validations (fast-path, no storage)
    if (!this.invoiceTermsCache.has(invoiceId)) {
      throw new SphereError(`Invoice not found: ${invoiceId}`, 'INVOICE_NOT_FOUND');
    }
    if (!this.isTarget(invoiceId)) {
      throw new SphereError(`Caller is not a target of invoice: ${invoiceId}`, 'INVOICE_NOT_TARGET');
    }
    if (this.closedInvoices.has(invoiceId)) {
      throw new SphereError(`Invoice is already closed: ${invoiceId}`, 'INVOICE_ALREADY_CLOSED');
    }
    if (this.cancelledInvoices.has(invoiceId)) {
      throw new SphereError(`Invoice is already cancelled: ${invoiceId}`, 'INVOICE_ALREADY_CANCELLED');
    }

    await this.withInvoiceGate(invoiceId, async () => {
      // Re-check terminal state inside gate (race protection)
      if (this.closedInvoices.has(invoiceId)) {
        throw new SphereError(`Invoice is already closed: ${invoiceId}`, 'INVOICE_ALREADY_CLOSED');
      }
      if (this.cancelledInvoices.has(invoiceId)) {
        throw new SphereError(`Invoice is already cancelled: ${invoiceId}`, 'INVOICE_ALREADY_CANCELLED');
      }

      const terms = this.invoiceTermsCache.get(invoiceId)!;
      const deps = this.deps!;

      // Gather all ledger entries for this invoice
      const innerMap = this.invoiceLedger.get(invoiceId);
      const entries: InvoiceTransferRef[] = innerMap ? Array.from(innerMap.values()) : [];

      // Compute current status (non-frozen path since we're not yet terminal)
      const walletAddresses = new Set(
        deps.getActiveAddresses().map((a) => a.directAddress),
      );
      // Fallback: include identity's own direct address (may not be in tracked addresses yet)
      const ownDirect = deps.identity?.directAddress;
      if (ownDirect) walletAddresses.add(ownDirect);
      const status = computeInvoiceStatus(invoiceId, terms, entries, null, walletAddresses);

      // Determine latest sender per target:coinId
      // "Latest" = last forward entry (by position in list) for that target:coinId
      // Forward entries are those where destination == target.address
      const latestSenderMap = new Map<string, Map<string, string>>();
      const targetAddressSet = new Set(terms.targets.map((t) => t.address));

      for (const entry of entries) {
        if (
          entry.paymentDirection === 'forward' &&
          targetAddressSet.has(entry.destinationAddress)
        ) {
          const effectiveSender = entry.refundAddress ?? entry.senderAddress;
          if (effectiveSender === null || effectiveSender === undefined) continue;

          let coinMap = latestSenderMap.get(entry.destinationAddress);
          if (!coinMap) {
            coinMap = new Map();
            latestSenderMap.set(entry.destinationAddress, coinMap);
          }
          // Overwrite — last entry in iteration order wins (processing order)
          coinMap.set(entry.coinId, effectiveSender);
        }
      }

      // Freeze balances for CLOSED state
      const frozen = freezeBalances(terms, status, 'CLOSED', true, latestSenderMap);

      // Persist in crash-safe order: frozen balances FIRST, then terminal set.
      // The terminal set write is the commit point — if we crash between writes,
      // the invoice is NOT terminal on recovery (safe to re-close).
      this.frozenBalances.set(invoiceId, frozen);
      await this.saveJsonToStorage(
        STORAGE_KEYS_ADDRESS.FROZEN_BALANCES,
        Object.fromEntries(this.frozenBalances),
      );
      this.closedInvoices.add(invoiceId);
      await this.saveJsonToStorage(
        STORAGE_KEYS_ADDRESS.CLOSED_INVOICES,
        Array.from(this.closedInvoices),
      );

      if (this.config.debug) {
        logger.debug(LOG_TAG, `closeInvoice(${invoiceId}) complete`);
      }

      // Auto-return surplus if requested
      if (options?.autoReturn) {
        this.autoReturnPerInvoice.set(invoiceId, true);
        await this._persistAutoReturnSettings();

        // Trigger immediate surplus return for CLOSED (:RC direction)
        // For CLOSED: only the surplus amounts are returnable (latest sender gets surplus)
        await this._executeTerminationReturns(invoiceId, frozen, 'RC', deps);
      }

      // BUG-002 Fix 4: Defer event emission until after the gate is released.
      // Placed AFTER _executeTerminationReturns so handlers see completed return state.
      this._deferEvent(() => deps.emitEvent('invoice:closed', { invoiceId, explicit: true }));
    });
  }

  /**
   * Cancel an invoice. Only target parties can cancel (§8.4).
   *
   * On cancel:
   * 1. Current balances are computed one final time and frozen.
   * 2. Invoice ID is added to the cancelled set in storage.
   * 3. Fires 'invoice:cancelled' event.
   * 4. If autoReturn is true, everything is returned immediately.
   *
   * @param invoiceId - The invoice token ID.
   * @param options   - Optional: { autoReturn?: boolean }.
   *
   * @throws {SphereError} `INVOICE_NOT_FOUND` — invoice token not found locally.
   * @throws {SphereError} `INVOICE_NOT_TARGET` — caller is not a target party.
   * @throws {SphereError} `INVOICE_ALREADY_CLOSED` — invoice is already closed.
   * @throws {SphereError} `INVOICE_ALREADY_CANCELLED` — invoice is already cancelled.
   * @throws {SphereError} `NOT_INITIALIZED` — module not initialized.
   * @throws {SphereError} `MODULE_DESTROYED` — module has been destroyed.
   */
  async cancelInvoice(invoiceId: string, options?: { autoReturn?: boolean }): Promise<void> {
    this.ensureNotDestroyed();
    this.ensureInitialized();

    // Pre-gate validations (fast-path, no storage)
    if (!this.invoiceTermsCache.has(invoiceId)) {
      throw new SphereError(`Invoice not found: ${invoiceId}`, 'INVOICE_NOT_FOUND');
    }
    if (!this.isTarget(invoiceId)) {
      throw new SphereError(`Caller is not a target of invoice: ${invoiceId}`, 'INVOICE_NOT_TARGET');
    }
    if (this.closedInvoices.has(invoiceId)) {
      throw new SphereError(`Invoice is already closed: ${invoiceId}`, 'INVOICE_ALREADY_CLOSED');
    }
    if (this.cancelledInvoices.has(invoiceId)) {
      throw new SphereError(`Invoice is already cancelled: ${invoiceId}`, 'INVOICE_ALREADY_CANCELLED');
    }

    await this.withInvoiceGate(invoiceId, async () => {
      // Re-check terminal state inside gate (race protection)
      if (this.closedInvoices.has(invoiceId)) {
        throw new SphereError(`Invoice is already closed: ${invoiceId}`, 'INVOICE_ALREADY_CLOSED');
      }
      if (this.cancelledInvoices.has(invoiceId)) {
        throw new SphereError(`Invoice is already cancelled: ${invoiceId}`, 'INVOICE_ALREADY_CANCELLED');
      }

      const terms = this.invoiceTermsCache.get(invoiceId)!;
      const deps = this.deps!;

      // Gather all ledger entries for this invoice
      const innerMap = this.invoiceLedger.get(invoiceId);
      const entries: InvoiceTransferRef[] = innerMap ? Array.from(innerMap.values()) : [];

      // Compute current status (non-frozen path)
      const walletAddresses = new Set(
        deps.getActiveAddresses().map((a) => a.directAddress),
      );
      // Fallback: include identity's own direct address (may not be in tracked addresses yet)
      const ownDirect = deps.identity?.directAddress;
      if (ownDirect) walletAddresses.add(ownDirect);
      const status = computeInvoiceStatus(invoiceId, terms, entries, null, walletAddresses);

      // Freeze balances for CANCELLED state — per-sender balances preserved
      // latestSenderMap is not used for CANCELLED (all balances preserved as-is)
      const frozen = freezeBalances(terms, status, 'CANCELLED', false);

      // Persist in crash-safe order: frozen balances FIRST, then terminal set.
      // The terminal set write is the commit point — if we crash between writes,
      // the invoice is NOT terminal on recovery (safe to re-cancel).
      this.frozenBalances.set(invoiceId, frozen);
      await this.saveJsonToStorage(
        STORAGE_KEYS_ADDRESS.FROZEN_BALANCES,
        Object.fromEntries(this.frozenBalances),
      );
      this.cancelledInvoices.add(invoiceId);
      await this.saveJsonToStorage(
        STORAGE_KEYS_ADDRESS.CANCELLED_INVOICES,
        Array.from(this.cancelledInvoices),
      );

      if (this.config.debug) {
        logger.debug(LOG_TAG, `cancelInvoice(${invoiceId}) complete`);
      }

      // Auto-return everything if requested
      if (options?.autoReturn) {
        this.autoReturnPerInvoice.set(invoiceId, true);
        await this._persistAutoReturnSettings();

        // Trigger immediate full return for CANCELLED (:RX direction)
        // For CANCELLED: every sender with netBalance > 0 gets their entire balance returned
        await this._executeTerminationReturns(invoiceId, frozen, 'RX', deps);
      }

      // BUG-002 Fix 4: Defer event emission until after the gate is released.
      // Placed AFTER _executeTerminationReturns so handlers see completed return state.
      this._deferEvent(() => deps.emitEvent('invoice:cancelled', { invoiceId }));
    });
  }

  /**
   * Pay an invoice — send tokens referencing the given invoice (§2.1, §8.5).
   *
   * This is a convenience wrapper around PaymentsModule.send() that:
   * 1. Validates the invoice is not terminated locally (throws INVOICE_TERMINATED if it is).
   * 2. Constructs the appropriate INV:<id>:F memo.
   * 3. Auto-populates contact info from identity.directAddress if not provided.
   * 4. Calls PaymentsModule.send().
   *
   * @param invoiceId - The invoice token ID.
   * @param params    - Pay parameters: targetIndex, assetIndex?, amount?, freeText?,
   *                    refundAddress?, contact?.
   * @returns TransferResult from PaymentsModule.send().
   *
   * @throws {SphereError} `INVOICE_NOT_FOUND` — invoice token not found locally.
   * @throws {SphereError} `INVOICE_TERMINATED` — invoice is CLOSED or CANCELLED.
   * @throws {SphereError} `INVOICE_INVALID_TARGET` — targetIndex is out of range.
   * @throws {SphereError} `INVOICE_INVALID_ASSET_INDEX` — assetIndex is out of range.
   * @throws {SphereError} `INVOICE_INVALID_REFUND_ADDRESS` — refundAddress is malformed.
   * @throws {SphereError} `INVOICE_INVALID_CONTACT` — contact is malformed.
   * @throws {SphereError} `NOT_INITIALIZED` — module not initialized.
   * @throws {SphereError} `MODULE_DESTROYED` — module has been destroyed.
   */
  async payInvoice(invoiceId: string, params: PayInvoiceParams): Promise<TransferResult> {
    this.ensureNotDestroyed();
    this.ensureInitialized();

    const deps = this.deps!;

    // §8.5 step 1: Invoice must exist locally
    if (!this.invoiceTermsCache.has(invoiceId)) {
      throw new SphereError(`Invoice not found: ${invoiceId}`, 'INVOICE_NOT_FOUND');
    }

    // Validate parameters that don't need the gate (pure input validation)
    const terms = this.invoiceTermsCache.get(invoiceId)!;

    // §8.5 step 3: targetIndex must be in range [0, targets.length)
    if (
      typeof params.targetIndex !== 'number' ||
      params.targetIndex < 0 ||
      params.targetIndex >= terms.targets.length
    ) {
      throw new SphereError(
        `Invalid targetIndex ${params.targetIndex}: invoice has ${terms.targets.length} target(s)`,
        'INVOICE_INVALID_TARGET',
      );
    }

    const target = terms.targets[params.targetIndex]!;

    // §8.5 step 4: assetIndex must be in range [0, assets.length) — defaults to 0
    const assetIndex = params.assetIndex ?? 0;
    if (assetIndex < 0 || assetIndex >= target.assets.length) {
      throw new SphereError(
        `Invalid assetIndex ${assetIndex}: target has ${target.assets.length} asset(s)`,
        'INVOICE_INVALID_ASSET_INDEX',
      );
    }

    const asset = target.assets[assetIndex]!;

    // §8.5 step 5: refundAddress must be a valid DIRECT:// address when provided
    if (params.refundAddress !== undefined) {
      if (
        !params.refundAddress.startsWith('DIRECT://') ||
        params.refundAddress.length <= 'DIRECT://'.length
      ) {
        throw new SphereError(
          'refundAddress must be a valid DIRECT:// address',
          'INVOICE_INVALID_REFUND_ADDRESS',
        );
      }
    }

    // §8.5 step 6: contact fields must be valid when provided
    if (params.contact !== undefined) {
      const { address, url } = params.contact;
      if (
        typeof address !== 'string' ||
        !address.startsWith('DIRECT://') ||
        address.length <= 'DIRECT://'.length
      ) {
        throw new SphereError(
          'contact.address must be a valid DIRECT:// address',
          'INVOICE_INVALID_CONTACT',
        );
      }
      if (url !== undefined) {
        if (
          typeof url !== 'string' ||
          (!url.startsWith('https://') && !url.startsWith('wss://')) ||
          url.length > 2048
        ) {
          throw new SphereError(
            'contact.url must start with https:// or wss:// and be at most 2048 characters',
            'INVOICE_INVALID_CONTACT',
          );
        }
      }
    }

    // Asset must have a coin entry to determine coinId
    if (!asset.coin) {
      throw new SphereError(
        `Asset at index ${assetIndex} has no coin entry`,
        'INVOICE_INVALID_ASSET_INDEX',
      );
    }
    const [coinId, requestedAmountStr] = asset.coin;

    // §4.7: Auto-populate contact from identity.directAddress when not explicitly provided.
    if (!deps.identity.directAddress) {
      throw new SphereError('directAddress required for invoice payments', 'NOT_INITIALIZED');
    }
    const effectiveContact: { address: string; url?: string } = params.contact ?? {
      address: deps.identity.directAddress,
    };

    // §8.5 step 2 + BUG-002 Fix 2: Hold the gate across terminal check, balance
    // computation, send(), AND provisional ledger write. This prevents concurrent
    // payInvoice() calls from both computing remaining=R and both sending R (double-payment).
    // Mirrors the returnInvoicePayment() provisional reservation pattern (§5.9).
    return this.withInvoiceGate(invoiceId, async () => {
      this.ensureNotDestroyed();

      // Terminal state check inside gate
      if (this.closedInvoices.has(invoiceId) || this.cancelledInvoices.has(invoiceId)) {
        throw new SphereError(
          `Invoice is already terminated (closed or cancelled): ${invoiceId}`,
          'INVOICE_TERMINATED',
        );
      }

      // §2.1: Compute send amount inside gate — sees provisional entries from concurrent calls
      let sendAmount: string;
      if (params.amount !== undefined) {
        sendAmount = params.amount;
      } else {
        const requested = AccountingModule._safeBigInt(requestedAmountStr);
        const ledgerEntries = this.invoiceLedger.get(invoiceId)
          ? Array.from(this.invoiceLedger.get(invoiceId)!.values())
          : [];
        const walletAddresses = new Set(deps.getActiveAddresses().map((a) => a.directAddress));
        const ownDirect = deps.identity?.directAddress;
        if (ownDirect) walletAddresses.add(ownDirect);
        const liveStatus = computeInvoiceStatus(invoiceId, terms, ledgerEntries, null, walletAddresses);
        const targetStatus = liveStatus.targets.find((t) => t.address === target.address);
        const coinAssetStatus = targetStatus?.coinAssets.find((ca) => ca.coin[0] === coinId);
        const netCovered = coinAssetStatus ? AccountingModule._safeBigInt(coinAssetStatus.netCoveredAmount) : 0n;
        const remaining = requested > netCovered ? requested - netCovered : 0n;
        sendAmount = remaining.toString();
      }

      // Guard: zero-amount sends are nonsensical
      if (sendAmount === '0') {
        throw new SphereError(
          `Invoice ${invoiceId} target ${target.address} asset ${coinId} is already fully covered`,
          'INVOICE_INVALID_AMOUNT',
        );
      }

      // §4.4: Build transport memo
      const memo = buildInvoiceMemo(invoiceId, 'F', params.freeText);

      if (this.config.debug) {
        logger.debug(
          LOG_TAG,
          `payInvoice(${invoiceId}) → target=${target.address} coinId=${coinId} amount=${sendAmount}`,
        );
      }

      // §5.9: Apply 60-second timeout to send() within the gate (matches returnInvoicePayment)
      const sendPromise = deps.payments.send({
        recipient: target.address,
        amount: sendAmount,
        coinId,
        memo,
        invoiceRefundAddress: params.refundAddress,
        invoiceContact: effectiveContact,
      });

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SphereError('payInvoice send() timed out after 60s', 'TIMEOUT')),
          60_000,
        );
      });

      try {
        const result = await Promise.race([sendPromise, timeoutPromise]);

        // BUG-002 Fix 2: Write provisional forward entry inside the gate so concurrent
        // payInvoice() calls see an updated netCoveredAmount. The provisional entry is
        // superseded by the real on-chain entry when _processTokenTransactions runs.
        if (result.id) {
          const forwardRef: InvoiceTransferRef = {
            transferId: `provisional:${result.id}`,
            direction: 'outbound',
            paymentDirection: 'forward',
            coinId,
            amount: sendAmount,
            destinationAddress: target.address,
            timestamp: Date.now(),
            confirmed: false,
            senderAddress: deps.identity?.directAddress ?? null,
          };
          const entryKey = `provisional:${result.id}::${coinId}`;
          let ledger = this.invoiceLedger.get(invoiceId);
          if (!ledger) {
            ledger = new Map();
            this.invoiceLedger.set(invoiceId, ledger);
          }
          ledger.set(entryKey, forwardRef);
          this.dirtyLedgerEntries.add(invoiceId);
          // Invalidate balance cache for this invoice
          this.balanceCache.delete(invoiceId);
        }

        return result;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    });
  }

  /**
   * Return tokens for an invoice — send tokens back to the original sender (§2.1, §8.6).
   *
   * Only callable when the local wallet's address matches one of the invoice targets.
   * Return amount is capped at the per-sender net balance for (target, sender, coinId).
   *
   * @param invoiceId - The invoice token ID.
   * @param params    - Return parameters: recipient, amount, coinId, freeText?.
   * @returns TransferResult from PaymentsModule.send().
   *
   * @throws {SphereError} `INVOICE_NOT_FOUND` — invoice token not found locally.
   * @throws {SphereError} `INVOICE_NOT_TARGET` — wallet is not an invoice target.
   * @throws {SphereError} `INVOICE_RETURN_EXCEEDS_BALANCE` — amount exceeds per-sender net balance.
   * @throws {SphereError} `NOT_INITIALIZED` — module not initialized.
   * @throws {SphereError} `MODULE_DESTROYED` — module has been destroyed.
   */
  async returnInvoicePayment(
    invoiceId: string,
    params: ReturnPaymentParams,
  ): Promise<TransferResult> {
    this.ensureNotDestroyed();
    this.ensureInitialized();

    const deps = this.deps!;

    // §8.6 step 1: Invoice must exist locally
    if (!this.invoiceTermsCache.has(invoiceId)) {
      throw new SphereError(`Invoice not found: ${invoiceId}`, 'INVOICE_NOT_FOUND');
    }

    // §8.6 step 2: Caller must be a target party
    if (!this.isTarget(invoiceId)) {
      throw new SphereError(
        `Caller is not a target of invoice: ${invoiceId}`,
        'INVOICE_NOT_TARGET',
      );
    }

    // W4 fix: Validate amount: positive integer string, capped at 78 digits to prevent BigInt DoS
    if (!params.amount || !/^[1-9]\d*$/.test(params.amount) || params.amount.length > 78) {
      throw new SphereError('Invalid amount: must be a positive integer string (max 78 digits)', 'INVOICE_INVALID_AMOUNT');
    }

    // §8.6 step 3: Balance check and send — serialized inside the per-invoice gate.
    // The gate prevents concurrent returns from both passing the balance check before
    // either's send completes (§5.9). A 60-second timeout is applied to send() per spec.
    return this.withInvoiceGate(invoiceId, async () => {
      this.ensureNotDestroyed();

      const terms = this.invoiceTermsCache.get(invoiceId)!;
      const activeAddresses = deps.getActiveAddresses();

      // Determine which of our tracked addresses is the target for this invoice
      const targetAddressSet = new Set(terms.targets.map((t) => t.address));
      let myTargetAddress = activeAddresses.find((a) => targetAddressSet.has(a.directAddress))
        ?.directAddress;

      // Fallback: use identity's own direct address (same as isTarget() fallback)
      if (!myTargetAddress) {
        const ownDirect = deps.identity?.directAddress;
        if (ownDirect && targetAddressSet.has(ownDirect)) {
          myTargetAddress = ownDirect;
        }
      }

      if (!myTargetAddress) {
        // Guard: isTarget() passed but no matching address found — defensive
        throw new SphereError(
          `Caller is not a target of invoice: ${invoiceId}`,
          'INVOICE_NOT_TARGET',
        );
      }

      // Compute per-sender net balance for (target=myTargetAddress, sender=params.recipient, coinId)
      const senderAddress = params.recipient;
      const coinId = params.coinId;

      let senderNetBalance: bigint;

      if (this.frozenBalances.has(invoiceId)) {
        // Terminal invoice: frozen baseline + post-freeze delta (set difference by entryKey)
        const frozen = this.frozenBalances.get(invoiceId)!;

        // Build set of entryKeys present in the frozen snapshot for this target:coinId
        const frozenEntryKeys = new Set<string>();
        for (const ft of frozen.targets) {
          if (ft.address !== myTargetAddress) continue;
          for (const fca of ft.coinAssets) {
            if (fca.coin[0] !== coinId) continue;
            for (const t of fca.transfers) {
              frozenEntryKeys.add(`${t.transferId}::${coinId}`);
            }
          }
        }

        // Find frozen baseline for this sender
        let frozenBaseline = 0n;
        for (const ft of frozen.targets) {
          if (ft.address !== myTargetAddress) continue;
          for (const fca of ft.coinAssets) {
            if (fca.coin[0] !== coinId) continue;
            const fsb = fca.frozenSenderBalances.find((s) => s.senderAddress === senderAddress);
            if (fsb) {
              frozenBaseline = AccountingModule._safeBigInt(fsb.netBalance);
            }
            break;
          }
          break;
        }

        // Compute post-freeze delta from live ledger: entries NOT in frozen snapshot
        const liveEntries = this.invoiceLedger.get(invoiceId)
          ? Array.from(this.invoiceLedger.get(invoiceId)!.values())
          : [];

        let postFreezeForward = 0n;
        let postFreezeReturned = 0n;

        for (const entry of liveEntries) {
          const entryKey = `${entry.transferId}::${coinId}`;
          if (frozenEntryKeys.has(entryKey)) continue; // already in frozen baseline
          if (entry.coinId !== coinId) continue;

          // Forward payments from this sender to this target
          if (
            entry.paymentDirection === 'forward' &&
            entry.destinationAddress === myTargetAddress
          ) {
            const effectiveSender = entry.refundAddress ?? entry.senderAddress;
            if (effectiveSender === senderAddress) {
              postFreezeForward += AccountingModule._safeBigInt(entry.amount);
            }
          }

          // Return payments from this target back to this sender
          if (
            (entry.paymentDirection === 'back' ||
              entry.paymentDirection === 'return_closed' ||
              entry.paymentDirection === 'return_cancelled') &&
            entry.senderAddress === myTargetAddress
          ) {
            const effectiveRecipient = entry.destinationAddress;
            if (effectiveRecipient === senderAddress) {
              postFreezeReturned += AccountingModule._safeBigInt(entry.amount);
            }
          }
        }

        const effectiveReturnable = frozenBaseline + postFreezeForward - postFreezeReturned;
        senderNetBalance = effectiveReturnable > 0n ? effectiveReturnable : 0n;
      } else {
        // Non-terminal invoice: use live computed balance from index
        const liveEntries = this.invoiceLedger.get(invoiceId)
          ? Array.from(this.invoiceLedger.get(invoiceId)!.values())
          : [];
        const walletAddresses = new Set(activeAddresses.map((a) => a.directAddress));
        if (myTargetAddress) walletAddresses.add(myTargetAddress);
        const liveStatus = computeInvoiceStatus(invoiceId, terms, liveEntries, null, walletAddresses);

        const targetStatus = liveStatus.targets.find((t) => t.address === myTargetAddress);
        const coinAssetStatus = targetStatus?.coinAssets.find((ca) => ca.coin[0] === coinId);
        const senderBalance = coinAssetStatus?.senderBalances.find(
          (sb) => sb.senderAddress === senderAddress,
        );
        senderNetBalance = senderBalance ? AccountingModule._safeBigInt(senderBalance.netBalance) : 0n;
      }

      // §8.6 balance cap validation
      // C3-R17 fix: Use _safeBigInt — params.amount is user input, raw BigInt() throws
      // uncaught SyntaxError for non-numeric strings instead of controlled SphereError.
      const returnAmount = AccountingModule._safeBigInt(params.amount);
      if (returnAmount > senderNetBalance) {
        throw new SphereError(
          `Return amount ${params.amount} exceeds sender net balance ${senderNetBalance.toString()} ` +
            `for (target=${myTargetAddress}, sender=${senderAddress}, coinId=${coinId})`,
          'INVOICE_RETURN_EXCEEDS_BALANCE',
        );
      }

      // §4.4: Build transport memo: INV:<id>:B[ freeText]
      const memo = buildInvoiceMemo(invoiceId, 'B', params.freeText);

      if (this.config.debug) {
        logger.debug(
          LOG_TAG,
          `returnInvoicePayment(${invoiceId}) → recipient=${senderAddress} ` +
            `coinId=${coinId} amount=${params.amount}`,
        );
      }

      // §5.9: Apply 60-second timeout to send() within the gate
      const sendPromise = deps.payments.send({
        recipient: senderAddress,
        amount: params.amount,
        coinId,
        memo,
      });

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SphereError('returnInvoicePayment send() timed out after 60s', 'TIMEOUT')),
          60_000,
        );
      });

      try {
        const result = await Promise.race([sendPromise, timeoutPromise]);

        // §5.9: Synchronously update the in-memory index inside the gate
        // before releasing, so concurrent operations see the new balance.
        // Use a provisional prefix so _processTokenTransactions can supersede
        // this entry when the on-chain tokenId:txIndex entry arrives (C1 fix).
        if (result.id) {
          const returnRef: InvoiceTransferRef = {
            transferId: `provisional:${result.id}`,
            direction: 'outbound',
            paymentDirection: 'back',
            coinId,
            amount: params.amount,
            destinationAddress: senderAddress,
            timestamp: Date.now(),
            confirmed: false,
            senderAddress: myTargetAddress,
          };
          const entryKey = `provisional:${result.id}::${coinId}`;
          const ledger = this.invoiceLedger.get(invoiceId);
          if (ledger) {
            ledger.set(entryKey, returnRef);
            this.dirtyLedgerEntries.add(invoiceId);
          }
          // Invalidate balance cache for this invoice
          this.balanceCache.delete(invoiceId);
        }

        return result;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    });
  }

  /**
   * Enable or disable auto-return for terminated invoices (§2.1, §8.7).
   *
   * When auto-return is enabled for a terminated invoice, future incoming forward
   * payments referencing the invoice are automatically returned. When enabled
   * for `'*'`, applies to all terminated invoices globally.
   *
   * @param invoiceId - Invoice token ID, or `'*'` for the global setting.
   * @param enabled   - Whether auto-return is enabled.
   *
   * @throws {SphereError} `INVOICE_NOT_FOUND` — invoiceId is not `'*'` and invoice does not exist.
   * @throws {SphereError} `RATE_LIMITED` — invoiceId is `'*'` and called within 5-second cooldown.
   * @throws {SphereError} `NOT_INITIALIZED` — module not initialized.
   * @throws {SphereError} `MODULE_DESTROYED` — module has been destroyed.
   */
  async setAutoReturn(invoiceId: string | '*', enabled: boolean): Promise<void> {
    this.ensureInitialized();
    this.ensureNotDestroyed();

    const deps = this.deps!;

    if (invoiceId === '*') {
      // ------------------------------------------------------------------
      // Global setting — rate-limited to 5-second cooldown (§2.1)
      // ------------------------------------------------------------------
      const now = Date.now();
      if (now - this.autoReturnLastGlobalSet < 5000) {
        throw new SphereError(
          'setAutoReturn("*") called within 5-second cooldown — please wait before calling again.',
          'RATE_LIMITED',
        );
      }
      this.autoReturnLastGlobalSet = now;

      // Update in-memory global flag
      this.autoReturnGlobal = enabled;

      // Persist settings
      await this._persistAutoReturnSettings();

      if (!enabled) return;

      // If enabling: trigger immediate auto-return for ALL terminated invoices (max 100)
      // Sequentially acquire per-invoice gates (§5.9 — no deadlocks, allows interleaving)
      const terminatedIds: string[] = [];
      for (const invoiceId of this.closedInvoices) {
        terminatedIds.push(invoiceId);
        if (terminatedIds.length >= 100) break;
      }
      if (terminatedIds.length < 100) {
        for (const invoiceId of this.cancelledInvoices) {
          if (!this.closedInvoices.has(invoiceId)) {
            terminatedIds.push(invoiceId);
            if (terminatedIds.length >= 100) break;
          }
        }
      }

      // Reset 'failed' ledger entries to 'pending' for all affected invoices
      for (const id of terminatedIds) {
        for (const transferId of this.autoReturnManager.getFailedTransferIds(id)) {
          await this.autoReturnManager.resetToPending(id, transferId);
        }
      }

      for (const id of terminatedIds) {
        // Only trigger if this wallet is a target party
        if (!this.isTarget(id)) continue;

        const frozen = this.frozenBalances.get(id);
        if (!frozen) continue;

        const direction: 'RC' | 'RX' = frozen.state === 'CLOSED' ? 'RC' : 'RX';

        await this.withInvoiceGate(id, async () => {
          this.ensureNotDestroyed();
          await this._executeAutoReturnFromFrozen(id, frozen, direction, deps);
        });
      }
    } else {
      // ------------------------------------------------------------------
      // Per-invoice setting
      // ------------------------------------------------------------------
      if (!this.invoiceTermsCache.has(invoiceId)) {
        throw new SphereError(`Invoice not found: ${invoiceId}`, 'INVOICE_NOT_FOUND');
      }

      // Update in-memory per-invoice flag
      this.autoReturnPerInvoice.set(invoiceId, enabled);

      // Persist settings
      await this._persistAutoReturnSettings();

      if (!enabled) return;

      // Reset 'failed' ledger entries for this invoice
      for (const transferId of this.autoReturnManager.getFailedTransferIds(invoiceId)) {
        await this.autoReturnManager.resetToPending(invoiceId, transferId);
      }

      // If enabling and the invoice is already terminated, trigger immediate auto-return
      const frozen = this.frozenBalances.get(invoiceId);
      if (!frozen) return;

      // Only trigger if this wallet is a target party
      if (!this.isTarget(invoiceId)) return;

      const direction: 'RC' | 'RX' = frozen.state === 'CLOSED' ? 'RC' : 'RX';

      await this.withInvoiceGate(invoiceId, async () => {
        this.ensureNotDestroyed();
        await this._executeAutoReturnFromFrozen(invoiceId, frozen, direction, deps);
      });
    }
  }

  /**
   * Get current auto-return settings.
   *
   * @returns AutoReturnSettings with global flag and per-invoice overrides.
   *
   * @throws {SphereError} `NOT_INITIALIZED` — module not initialized.
   */
  getAutoReturnSettings(): AutoReturnSettings {
    this.ensureInitialized();

    const perInvoice: Record<string, boolean> = {};
    for (const [id, enabled] of this.autoReturnPerInvoice.entries()) {
      perInvoice[id] = enabled;
    }

    return {
      global: this.autoReturnGlobal,
      perInvoice,
    };
  }

  /**
   * Send receipt DMs to each payer of a terminated invoice (§2.1, §8.9).
   *
   * For each target address controlled by this wallet, iterates over the frozen
   * per-sender balances and sends a structured receipt DM via CommunicationsModule.
   *
   * PREREQUISITES:
   * - Invoice must be in a terminal state (CLOSED or CANCELLED).
   * - Caller must be a target party.
   * - CommunicationsModule must be available.
   *
   * @param invoiceId - The invoice token ID.
   * @param options   - Optional: { memo?, includeZeroBalance? }.
   * @returns SendReceiptsResult with counts and details.
   *
   * @throws {SphereError} `INVOICE_NOT_FOUND` — invoice token not found locally.
   * @throws {SphereError} `INVOICE_NOT_TERMINATED` — invoice is not in a terminal state.
   * @throws {SphereError} `INVOICE_NOT_TARGET` — caller is not a target party.
   * @throws {SphereError} `COMMUNICATIONS_UNAVAILABLE` — CommunicationsModule is not available.
   * @throws {SphereError} `INVOICE_MEMO_TOO_LONG` — memo exceeds 4096 characters.
   * @throws {SphereError} `NOT_INITIALIZED` — module not initialized.
   * @throws {SphereError} `MODULE_DESTROYED` — module has been destroyed.
   */
  async sendInvoiceReceipts(
    invoiceId: string,
    options?: SendInvoiceReceiptsOptions,
  ): Promise<SendReceiptsResult> {
    this.ensureNotDestroyed();
    this.ensureInitialized();

    const deps = this.deps!;

    // ------------------------------------------------------------------
    // Step 1: Invoice must exist
    // ------------------------------------------------------------------
    if (!this.invoiceTermsCache.has(invoiceId)) {
      throw new SphereError(`Invoice not found: ${invoiceId}`, 'INVOICE_NOT_FOUND');
    }

    // ------------------------------------------------------------------
    // Step 2: Invoice must be in a terminal state (CLOSED or CANCELLED)
    // ------------------------------------------------------------------
    const isTerminal =
      this.closedInvoices.has(invoiceId) || this.cancelledInvoices.has(invoiceId);
    if (!isTerminal) {
      throw new SphereError(
        `Invoice ${invoiceId} is not in a terminal state (CLOSED or CANCELLED).`,
        'INVOICE_NOT_TERMINATED',
      );
    }

    // ------------------------------------------------------------------
    // Step 3: Caller must be a target
    // ------------------------------------------------------------------
    if (!this.isTarget(invoiceId)) {
      throw new SphereError(
        `Wallet is not a target of invoice ${invoiceId}.`,
        'INVOICE_NOT_TARGET',
      );
    }

    // ------------------------------------------------------------------
    // Step 4: CommunicationsModule must be available
    // ------------------------------------------------------------------
    if (!deps.communications) {
      throw new SphereError(
        'CommunicationsModule is required to send receipt DMs.',
        'COMMUNICATIONS_UNAVAILABLE',
      );
    }

    // ------------------------------------------------------------------
    // Step 5: Validate memo length
    // ------------------------------------------------------------------
    if (options?.memo !== undefined && options.memo.length > 4096) {
      throw new SphereError(
        'Receipt memo exceeds 4096 characters.',
        'INVOICE_MEMO_TOO_LONG',
      );
    }

    // ------------------------------------------------------------------
    // Step 6: Get frozen balances
    // ------------------------------------------------------------------
    const frozen = this.frozenBalances.get(invoiceId);
    if (!frozen) {
      // Frozen balances may be missing after inverse reconciliation (§4c).
      // In that case we have no per-sender data to send receipts for.
      logger.warn(LOG_TAG, `sendInvoiceReceipts: no frozen balances for terminal invoice ${invoiceId}`);
      return { sent: 0, failed: 0, sentReceipts: [], failedReceipts: [] };
    }

    const includeZeroBalance = options?.includeZeroBalance ?? false;
    const activeAddresses = deps.getActiveAddresses();
    const activeAddressSet = new Set(activeAddresses.map((a) => a.directAddress));

    const sentReceipts: SentReceiptInfo[] = [];
    const failedReceipts: FailedReceiptInfo[] = [];

    // ------------------------------------------------------------------
    // Step 7: For each target that this wallet controls, iterate senders
    // ------------------------------------------------------------------
    for (const frozenTarget of frozen.targets) {
      // Only process targets that belong to our wallet
      if (!activeAddressSet.has(frozenTarget.address)) continue;

      const ourTargetAddress = frozenTarget.address;

      // Resolve targetNametag from active addresses (NOT identity.nametag directly)
      const matchingAddr = activeAddresses.find(
        (a) => a.directAddress === ourTargetAddress,
      );
      const targetNametag = matchingAddr?.nametag;

      // Aggregate per-sender balances across all coinAssets for this target
      // Key: senderAddress (effective sender = refundAddress ?? senderAddress)
      const senderMap = new Map<
        string,
        {
          senderAddress: string;
          isRefundAddress?: boolean;
          assets: Map<string, { coinId: string; forwardedAmount: bigint; returnedAmount: bigint; requestedAmount: bigint }>;
          contacts: ReadonlyArray<{ address: string; url?: string }>;
        }
      >();

      const terms = this.invoiceTermsCache.get(invoiceId)!;

      for (const coinAsset of frozenTarget.coinAssets) {
        const [coinId, requestedAmountStr] = coinAsset.coin;
        const requestedAmount = AccountingModule._safeBigInt(requestedAmountStr);

        for (const frozenSender of coinAsset.frozenSenderBalances) {
          const key = frozenSender.senderAddress;
          if (!senderMap.has(key)) {
            senderMap.set(key, {
              senderAddress: frozenSender.senderAddress,
              isRefundAddress: frozenSender.isRefundAddress,
              assets: new Map(),
              contacts: frozenSender.contacts,
            });
          }
          const senderEntry = senderMap.get(key)!;

          if (!senderEntry.assets.has(coinId)) {
            senderEntry.assets.set(coinId, {
              coinId,
              forwardedAmount: 0n,
              returnedAmount: 0n,
              requestedAmount,
            });
          }

          const assetEntry = senderEntry.assets.get(coinId)!;
          // netBalance is the returnable amount for this sender for this coin
          // We reconstitute forwarded/returned from the balance data
          // ForwardedAmount = netBalance + returnedAmount is not available directly in FrozenSenderBalance,
          // so we use what we have: netBalance is the net returnable.
          // The InvoiceReceiptAsset needs forwardedAmount, returnedAmount, netAmount.
          // We can compute them from the aggregate coinAsset data, attributing per-sender proportionally
          // — but the spec only persists netBalance in FrozenSenderBalance, not individual forwarded/returned.
          // Per the InvoiceReceiptAsset type, we use netBalance as netAmount.
          // For forwardedAmount and returnedAmount in the receipt, we use what we know:
          // netBalance = max(0, forwarded - returned) — we only have this.
          // The spec receipt shows these fields, so we report netBalance as forwardedAmount
          // and '0' as returnedAmount for simplicity when only netBalance is available.
          // This is correct for the minimal case; a full implementation would track
          // forwarded/returned separately in FrozenSenderBalance (future enhancement).
          // C3-R17 fix: Use _safeBigInt — frozenSender.netBalance is from persisted storage
          assetEntry.forwardedAmount += AccountingModule._safeBigInt(frozenSender.netBalance);
        }
      }

      // ------------------------------------------------------------------
      // Iterate over unique senders and send receipts
      // ------------------------------------------------------------------
      for (const [, senderEntry] of senderMap) {
        const assetArray: InvoiceReceiptAsset[] = [];
        for (const [, a] of senderEntry.assets) {
          assetArray.push({
            coinId: a.coinId,
            forwardedAmount: a.forwardedAmount.toString(),
            returnedAmount: a.returnedAmount.toString(),
            netAmount: a.forwardedAmount.toString(), // net = forwarded - returned
            requestedAmount: a.requestedAmount.toString(),
          });
        }

        // Check zero-balance filter: skip if ALL per-coinId net amounts are '0'
        // and includeZeroBalance is false.
        const allZero = assetArray.every((a) => a.netAmount === '0');
        if (allZero && !includeZeroBalance) continue;

        const contribution: InvoiceReceiptContribution = {
          senderAddress: senderEntry.senderAddress,
          isRefundAddress: senderEntry.isRefundAddress,
          assets: assetArray,
        };

        // ------------------------------------------------------------------
        // Recipient resolution:
        // 1. contacts[0].address (payer-provided — may differ from senderAddress
        //    if payer explicitly set a contact address; this is by design to
        //    support delegated/custodial payment flows)
        // 2. senderAddress (if isRefundAddress is falsy)
        // 3. unresolvable → record as failed
        //
        // NOTE: contacts[0].address is payer-controlled and validated during
        // memo decoding (must be DIRECT:// format, ≤256 chars). The receipt
        // contains balance info for this specific sender only, not wallet-wide.
        // ------------------------------------------------------------------
        let recipientAddress: string | null = null;

        if (senderEntry.contacts.length > 0) {
          recipientAddress = senderEntry.contacts[0].address;
        } else if (!senderEntry.isRefundAddress) {
          recipientAddress = senderEntry.senderAddress;
        }

        if (!recipientAddress) {
          failedReceipts.push({
            targetAddress: ourTargetAddress,
            senderAddress: senderEntry.senderAddress,
            reason: 'unresolvable',
          });
          continue;
        }

        // ------------------------------------------------------------------
        // Build payload and send DM
        // ------------------------------------------------------------------
        const payload: InvoiceReceiptPayload = {
          type: 'invoice_receipt',
          version: 1,
          invoiceId,
          targetAddress: ourTargetAddress,
          targetNametag: targetNametag ?? undefined,
          terminalState: frozen.state,
          senderContribution: contribution,
          memo: options?.memo,
          issuedAt: Date.now(),
        };

        const dmContent = 'invoice_receipt:' + JSON.stringify(payload);

        try {
          const dm = await deps.communications.sendDM(recipientAddress, dmContent);
          sentReceipts.push({
            targetAddress: ourTargetAddress,
            senderAddress: senderEntry.senderAddress,
            recipientAddress,
            dmId: dm.id,
          });
        } catch (err) {
          failedReceipts.push({
            targetAddress: ourTargetAddress,
            senderAddress: senderEntry.senderAddress,
            reason: 'dm_failed',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // ------------------------------------------------------------------
    // Step 8: Fire 'invoice:receipt_sent' event
    // ------------------------------------------------------------------
    deps.emitEvent('invoice:receipt_sent', { invoiceId, sent: sentReceipts.length, failed: failedReceipts.length });

    return {
      sent: sentReceipts.length,
      failed: failedReceipts.length,
      sentReceipts,
      failedReceipts,
    };
  }

  /**
   * Send cancellation notice DMs to each payer of a cancelled invoice (§2.1, §8.10).
   *
   * PREREQUISITES:
   * - Invoice must be in CANCELLED state (not CLOSED).
   * - Caller must be a target party.
   * - CommunicationsModule must be available.
   *
   * @param invoiceId - The invoice token ID.
   * @param options   - Optional: { reason?, dealDescription?, includeZeroBalance? }.
   * @returns SendNoticesResult with counts and details.
   *
   * @throws {SphereError} `INVOICE_NOT_FOUND` — invoice token not found locally.
   * @throws {SphereError} `INVOICE_NOT_CANCELLED` — invoice is not in CANCELLED state.
   * @throws {SphereError} `INVOICE_NOT_TARGET` — caller is not a target party.
   * @throws {SphereError} `COMMUNICATIONS_UNAVAILABLE` — CommunicationsModule is not available.
   * @throws {SphereError} `INVOICE_MEMO_TOO_LONG` — reason or dealDescription exceeds 4096 chars.
   * @throws {SphereError} `NOT_INITIALIZED` — module not initialized.
   * @throws {SphereError} `MODULE_DESTROYED` — module has been destroyed.
   */
  async sendCancellationNotices(
    invoiceId: string,
    options?: SendCancellationNoticesOptions,
  ): Promise<SendNoticesResult> {
    this.ensureNotDestroyed();
    this.ensureInitialized();

    const deps = this.deps!;

    // ------------------------------------------------------------------
    // Step 1: Invoice must exist
    // ------------------------------------------------------------------
    if (!this.invoiceTermsCache.has(invoiceId)) {
      throw new SphereError(`Invoice not found: ${invoiceId}`, 'INVOICE_NOT_FOUND');
    }

    // ------------------------------------------------------------------
    // Step 2: Invoice must be in CANCELLED state (not CLOSED)
    // ------------------------------------------------------------------
    if (!this.cancelledInvoices.has(invoiceId)) {
      throw new SphereError(
        `Invoice ${invoiceId} is not in CANCELLED state.`,
        'INVOICE_NOT_CANCELLED',
      );
    }

    // ------------------------------------------------------------------
    // Step 3: Caller must be a target
    // ------------------------------------------------------------------
    if (!this.isTarget(invoiceId)) {
      throw new SphereError(
        `Wallet is not a target of invoice ${invoiceId}.`,
        'INVOICE_NOT_TARGET',
      );
    }

    // ------------------------------------------------------------------
    // Step 4: CommunicationsModule must be available
    // ------------------------------------------------------------------
    if (!deps.communications) {
      throw new SphereError(
        'CommunicationsModule is required to send cancellation notice DMs.',
        'COMMUNICATIONS_UNAVAILABLE',
      );
    }

    // ------------------------------------------------------------------
    // Step 5: Validate reason and dealDescription length
    // ------------------------------------------------------------------
    if (options?.reason !== undefined && options.reason.length > 4096) {
      throw new SphereError(
        'Cancellation reason exceeds 4096 characters.',
        'INVOICE_MEMO_TOO_LONG',
      );
    }
    if (options?.dealDescription !== undefined && options.dealDescription.length > 4096) {
      throw new SphereError(
        'Cancellation dealDescription exceeds 4096 characters.',
        'INVOICE_MEMO_TOO_LONG',
      );
    }

    // ------------------------------------------------------------------
    // Step 6: Get frozen balances
    // ------------------------------------------------------------------
    const frozen = this.frozenBalances.get(invoiceId);
    if (!frozen) {
      logger.warn(LOG_TAG, `sendCancellationNotices: no frozen balances for cancelled invoice ${invoiceId}`);
      return { sent: 0, failed: 0, sentNotices: [], failedNotices: [] };
    }

    const includeZeroBalance = options?.includeZeroBalance ?? false;
    const activeAddresses = deps.getActiveAddresses();
    const activeAddressSet = new Set(activeAddresses.map((a) => a.directAddress));

    const sentNotices: SentNoticeInfo[] = [];
    const failedNotices: FailedNoticeInfo[] = [];

    // ------------------------------------------------------------------
    // Step 7: For each target that this wallet controls, iterate senders
    // ------------------------------------------------------------------
    for (const frozenTarget of frozen.targets) {
      if (!activeAddressSet.has(frozenTarget.address)) continue;

      const ourTargetAddress = frozenTarget.address;

      const matchingAddr = activeAddresses.find(
        (a) => a.directAddress === ourTargetAddress,
      );
      const targetNametag = matchingAddr?.nametag;

      // Aggregate per-sender across all coinAssets (same as sendInvoiceReceipts)
      const senderMap = new Map<
        string,
        {
          senderAddress: string;
          isRefundAddress?: boolean;
          assets: Map<string, { coinId: string; forwardedAmount: bigint; returnedAmount: bigint; requestedAmount: bigint }>;
          contacts: ReadonlyArray<{ address: string; url?: string }>;
        }
      >();

      for (const coinAsset of frozenTarget.coinAssets) {
        const [coinId, requestedAmountStr] = coinAsset.coin;
        const requestedAmount = AccountingModule._safeBigInt(requestedAmountStr);

        for (const frozenSender of coinAsset.frozenSenderBalances) {
          const key = frozenSender.senderAddress;
          if (!senderMap.has(key)) {
            senderMap.set(key, {
              senderAddress: frozenSender.senderAddress,
              isRefundAddress: frozenSender.isRefundAddress,
              assets: new Map(),
              contacts: frozenSender.contacts,
            });
          }
          const senderEntry = senderMap.get(key)!;

          if (!senderEntry.assets.has(coinId)) {
            senderEntry.assets.set(coinId, {
              coinId,
              forwardedAmount: 0n,
              returnedAmount: 0n,
              requestedAmount,
            });
          }
          const assetEntry = senderEntry.assets.get(coinId)!;
          // C3-R17 fix: Use _safeBigInt — frozenSender.netBalance is from persisted storage
          assetEntry.forwardedAmount += AccountingModule._safeBigInt(frozenSender.netBalance);
        }
      }

      for (const [, senderEntry] of senderMap) {
        const assetArray: InvoiceReceiptAsset[] = [];
        for (const [, a] of senderEntry.assets) {
          assetArray.push({
            coinId: a.coinId,
            forwardedAmount: a.forwardedAmount.toString(),
            returnedAmount: a.returnedAmount.toString(),
            netAmount: a.forwardedAmount.toString(),
            requestedAmount: a.requestedAmount.toString(),
          });
        }

        const allZero = assetArray.every((a) => a.netAmount === '0');
        if (allZero && !includeZeroBalance) continue;

        const contribution: InvoiceReceiptContribution = {
          senderAddress: senderEntry.senderAddress,
          isRefundAddress: senderEntry.isRefundAddress,
          assets: assetArray,
        };

        // Recipient resolution (same as sendInvoiceReceipts)
        let recipientAddress: string | null = null;
        if (senderEntry.contacts.length > 0) {
          recipientAddress = senderEntry.contacts[0].address;
        } else if (!senderEntry.isRefundAddress) {
          recipientAddress = senderEntry.senderAddress;
        }

        if (!recipientAddress) {
          failedNotices.push({
            targetAddress: ourTargetAddress,
            senderAddress: senderEntry.senderAddress,
            reason: 'unresolvable',
          });
          continue;
        }

        const payload: InvoiceCancellationPayload = {
          type: 'invoice_cancellation',
          version: 1,
          invoiceId,
          targetAddress: ourTargetAddress,
          targetNametag: targetNametag ?? undefined,
          senderContribution: contribution,
          reason: options?.reason,
          dealDescription: options?.dealDescription,
          issuedAt: Date.now(),
        };

        const dmContent = 'invoice_cancellation:' + JSON.stringify(payload);

        try {
          const dm = await deps.communications.sendDM(recipientAddress, dmContent);
          sentNotices.push({
            targetAddress: ourTargetAddress,
            senderAddress: senderEntry.senderAddress,
            recipientAddress,
            dmId: dm.id,
          });
        } catch (err) {
          failedNotices.push({
            targetAddress: ourTargetAddress,
            senderAddress: senderEntry.senderAddress,
            reason: 'dm_failed',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // ------------------------------------------------------------------
    // Step 8: Fire 'invoice:cancellation_sent' event
    // ------------------------------------------------------------------
    deps.emitEvent('invoice:cancellation_sent', { invoiceId, sent: sentNotices.length, failed: failedNotices.length });

    return {
      sent: sentNotices.length,
      failed: failedNotices.length,
      sentNotices,
      failedNotices,
    };
  }

  /**
   * Get all transfers that reference the given invoice.
   * Returns complete transfer history from the invoice-transfer index,
   * including irrelevant transfers (see §5.4 for classification).
   *
   * @param invoiceId - The invoice token ID.
   * @returns Array of InvoiceTransferRef entries from the index.
   *
   * @throws {SphereError} `INVOICE_NOT_FOUND` — invoice not found (throws rather than empty array).
   * @throws {SphereError} `NOT_INITIALIZED` — module not initialized.
   * @throws {SphereError} `MODULE_DESTROYED` — module has been destroyed.
   */
  getRelatedTransfers(invoiceId: string): (InvoiceTransferRef | IrrelevantTransfer)[] {
    this.ensureNotDestroyed();
    this.ensureInitialized();

    // §8.8: Invoice must exist locally
    if (!this.invoiceTermsCache.has(invoiceId)) {
      throw new SphereError(`Invoice not found: ${invoiceId}`, 'INVOICE_NOT_FOUND');
    }

    // Return all indexed entries for this invoice, sorted by timestamp (ascending)
    const innerMap = this.invoiceLedger.get(invoiceId);
    if (!innerMap) {
      return [];
    }

    const entries = Array.from(innerMap.values()) as (InvoiceTransferRef | IrrelevantTransfer)[];
    return entries.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Parse a transport-layer invoice memo string.
   * Delegates to the memo.ts utility — pure, no side effects.
   *
   * @param memo - The raw memo string from TransferRequest.memo / HistoryRecord.memo.
   * @returns Parsed InvoiceMemoRef or null if the string does not match the INV: format.
   */
  // §10 exemption: Pure function with no side effects — exempt from ensureNotDestroyed().
  parseInvoiceMemo(memo: string) {
    return parseInvoiceMemo(memo);
  }

  // ===========================================================================
  // Internal: Terminate invoice (must be called from within a held gate)
  // ===========================================================================

  /**
   * Freeze and persist a terminal state for the given invoice.
   * MUST only be called from code paths that already hold the per-invoice gate.
   * MUST NOT acquire the gate internally (would deadlock).
   *
   * @param invoiceId - The invoice to terminate.
   * @param state     - Terminal state: 'CLOSED' or 'CANCELLED'.
   *
   * @internal
   */
  private async _terminateInvoice(invoiceId: string, state: 'CLOSED' | 'CANCELLED'): Promise<void> {
    // Must be called from within a held gate — does NOT acquire the gate itself.

    // If already terminated, return immediately (idempotent)
    if (this.closedInvoices.has(invoiceId) || this.cancelledInvoices.has(invoiceId)) {
      return;
    }

    const terms = this.invoiceTermsCache.get(invoiceId);
    if (!terms) {
      logger.warn(LOG_TAG, `_terminateInvoice: invoice ${invoiceId} not found in cache`);
      return;
    }

    const deps = this.deps!;

    // Gather ledger entries
    const innerMap = this.invoiceLedger.get(invoiceId);
    const entries: InvoiceTransferRef[] = innerMap ? Array.from(innerMap.values()) : [];

    // Compute status
    const walletAddresses = new Set(
      deps.getActiveAddresses().map((a) => a.directAddress),
    );
    const status = computeInvoiceStatus(invoiceId, terms, entries, null, walletAddresses);

    let frozen: FrozenInvoiceBalances;

    if (state === 'CLOSED') {
      // Determine latest sender per target:coinId (same logic as closeInvoice)
      const latestSenderMap = new Map<string, Map<string, string>>();
      const targetAddressSet = new Set(terms.targets.map((t) => t.address));

      for (const entry of entries) {
        if (
          entry.paymentDirection === 'forward' &&
          targetAddressSet.has(entry.destinationAddress)
        ) {
          const effectiveSender = entry.refundAddress ?? entry.senderAddress;
          if (effectiveSender === null || effectiveSender === undefined) continue;

          let coinMap = latestSenderMap.get(entry.destinationAddress);
          if (!coinMap) {
            coinMap = new Map();
            latestSenderMap.set(entry.destinationAddress, coinMap);
          }
          coinMap.set(entry.coinId, effectiveSender);
        }
      }

      // Implicit close (called by auto-terminate path — explicit=false)
      frozen = freezeBalances(terms, status, 'CLOSED', false, latestSenderMap);
      this.closedInvoices.add(invoiceId);
    } else {
      // CANCELLED — preserve all per-sender balances
      frozen = freezeBalances(terms, status, 'CANCELLED', false);
      this.cancelledInvoices.add(invoiceId);
    }

    // C5 fix: Persist in crash-safe order matching closeInvoice/cancelInvoice:
    // frozen balances FIRST, then terminal set. The terminal set write is the
    // commit point — crash between writes = not terminal on recovery.
    this.frozenBalances.set(invoiceId, frozen);
    await this.saveJsonToStorage(
      STORAGE_KEYS_ADDRESS.FROZEN_BALANCES,
      Object.fromEntries(this.frozenBalances),
    );
    if (state === 'CLOSED') {
      await this.saveJsonToStorage(
        STORAGE_KEYS_ADDRESS.CLOSED_INVOICES,
        Array.from(this.closedInvoices),
      );
    } else {
      await this.saveJsonToStorage(
        STORAGE_KEYS_ADDRESS.CANCELLED_INVOICES,
        Array.from(this.cancelledInvoices),
      );
    }

    // BUG-002 Fix 4: Defer event emission until after the gate is released.
    if (state === 'CLOSED') {
      this._deferEvent(() => deps.emitEvent('invoice:closed', { invoiceId, explicit: false }));
    } else {
      this._deferEvent(() => deps.emitEvent('invoice:cancelled', { invoiceId }));
    }

    if (this.config.debug) {
      logger.debug(LOG_TAG, `_terminateInvoice(${invoiceId}, ${state}) complete`);
    }
  }

  // ===========================================================================
  // Internal: Auto-return from frozen balances (dedup-ledger aware)
  // ===========================================================================

  /**
   * Execute auto-return sends for all senders with a positive net balance in
   * the given frozen snapshot, using the dedup ledger to avoid duplicate sends.
   *
   * Used by `setAutoReturn()` when enabling auto-return on an already-terminated
   * invoice, and by crash recovery.
   *
   * Semantics (§5.9, §7.5):
   * - CLOSED (direction :RC): latest sender per target:coinId with surplus > 0
   * - CANCELLED (direction :RX): every sender with netBalance > 0
   *
   * Dedup key: `{invoiceId}:FROZEN:{targetAddress}:{senderAddress}:{coinId}`
   * This is distinct from the per-transfer key used during ongoing auto-return,
   * because the frozen-balance return is per (target, sender, coin), not per
   * individual inbound transfer.
   *
   * Best-effort: send failures are logged and marked in the ledger but do not
   * throw. Each return is attempted independently.
   *
   * MUST be called inside the per-invoice gate (ensured by callers).
   *
   * @param invoiceId  - Invoice being processed.
   * @param frozen     - Frozen balance snapshot.
   * @param direction  - 'RC' for CLOSED surplus returns; 'RX' for CANCELLED full.
   * @param deps       - Module dependencies.
   */
  private async _executeAutoReturnFromFrozen(
    invoiceId: string,
    frozen: FrozenInvoiceBalances,
    direction: 'RC' | 'RX',
    deps: AccountingModuleDependencies,
  ): Promise<void> {
    // W23 fix: Hoist getHistory() before the loop and build a memo→entry Map
    // for O(1) lookup instead of O(n*m) linear scans.
    const history = deps.payments.getHistory();
    const historyByMemo = new Map<string, (typeof history)[number]>();
    for (const h of history) {
      if (h.type === 'SENT' && h.memo && h.transferId) {
        historyByMemo.set(h.memo, h);
      }
    }

    for (const ft of frozen.targets) {
      for (const fca of ft.coinAssets) {
        const coinId = fca.coin[0];

        for (const fsb of fca.frozenSenderBalances) {
          const netBalance = AccountingModule._safeBigInt(fsb.netBalance);
          if (netBalance <= 0n) continue;

          const recipient = fsb.senderAddress;
          if (!recipient) continue;

          const amount = fsb.netBalance;
          // Dedup key for frozen-balance returns — distinct from per-transfer key
          const dedupTransferId = `FROZEN:${ft.address}:${recipient}:${coinId}`;

          // Check dedup ledger — skip if already completed
          if (this.autoReturnManager.isDone(invoiceId, dedupTransferId)) continue;

          // Secondary dedup: check transaction history for an existing return
          // W13: Require type === 'SENT' AND on-chain confirmation (transferId or txHash)
          const memo = buildInvoiceMemo(invoiceId, direction, dedupTransferId);
          const alreadyReturned = historyByMemo.get(memo);

          if (alreadyReturned) {
            await this.autoReturnManager.markCompleted(
              invoiceId,
              dedupTransferId,
              alreadyReturned.transferId ?? alreadyReturned.id,
            );
            continue;
          }

          // Write intent (write-first pattern — §7.5 step 3a)
          await this.autoReturnManager.recordIntent(invoiceId, dedupTransferId, {
            recipient,
            amount,
            coinId,
            memo,
          });

          try {
            // Steelman fix: Wrap send() with 60s timeout, matching Fix 3 pattern in
            // _executeTerminationReturns. Without this, a hung send holds the gate indefinitely.
            const arSendPromise = deps.payments.send({ recipient, amount, coinId, memo });
            let arSendTimer: ReturnType<typeof setTimeout> | undefined;
            const arSendTimeout = new Promise<never>((_, reject) => {
              arSendTimer = setTimeout(
                () => reject(new SphereError(
                  `Auto-return send() timed out after 60s: ${invoiceId} → ${recipient}`,
                  'TIMEOUT',
                )),
                60_000,
              );
            });

            let result: Awaited<typeof arSendPromise>;
            try {
              result = await Promise.race([arSendPromise, arSendTimeout]);
            } finally {
              if (arSendTimer !== undefined) clearTimeout(arSendTimer);
            }

            const returnTransferId = result.id;
            await this.autoReturnManager.markCompleted(invoiceId, dedupTransferId, returnTransferId);

            const now = Date.now();
            const originalRef: import('./types.js').InvoiceTransferRef = {
              transferId: dedupTransferId,
              direction: 'inbound',
              paymentDirection: 'forward',
              coinId,
              amount,
              destinationAddress: ft.address,
              senderAddress: recipient,
              timestamp: now,
              confirmed: false,
            };
            const returnRef: import('./types.js').InvoiceTransferRef = {
              transferId: returnTransferId,
              direction: 'outbound',
              paymentDirection: direction === 'RC' ? 'return_closed' : 'return_cancelled',
              coinId,
              amount,
              destinationAddress: recipient,
              senderAddress: deps.identity.directAddress ?? '',
              timestamp: now,
              confirmed: false,
            };

            deps.emitEvent('invoice:auto_returned', {
              invoiceId,
              originalTransfer: originalRef,
              returnTransfer: returnRef,
            });

            if (this.config.debug) {
              logger.debug(
                LOG_TAG,
                `Auto-return (${direction}) sent: ${invoiceId} → ${recipient} ${amount} ${coinId}`,
              );
            }
          } catch (err) {
            logger.warn(
              LOG_TAG,
              `Auto-return (${direction}) failed for ${invoiceId} → ${recipient} ${amount} ${coinId}:`,
              err,
            );

            // CR-M3 fix: Always increment retry count first, then check if max exceeded.
            // This ensures the persisted retryCount reflects actual attempts, matching
            // the crash recovery path and _executeEventAutoReturn pattern.
            try {
              const retryCount = await this.autoReturnManager.incrementRetry(invoiceId, dedupTransferId);
              if (retryCount >= AutoReturnManager.MAX_RETRY_COUNT) {
                await this.autoReturnManager.markFailed(invoiceId, dedupTransferId);
                deps.emitEvent('invoice:auto_return_failed', {
                  invoiceId,
                  transferId: dedupTransferId,
                  reason: 'send_failed',
                  refundAddress: fsb.refundAddress,
                });
              }
              // else: leave as 'pending' — crash recovery will retry
            } catch {
              // Storage failure — entry stays 'pending' in memory
            }
          }
        }
      }
    }
  }

  // ===========================================================================
  // Internal: Execute at-termination auto-returns
  // ===========================================================================

  /**
   * Execute immediate auto-return sends for all senders with a positive net balance
   * in the given frozen snapshot. Used by closeInvoice (direction :RC) and
   * cancelInvoice (direction :RX).
   *
   * Best-effort: send failures are logged but do not throw. Each send is
   * attempted independently so a failure for one sender does not block others.
   *
   * @param invoiceId  - Invoice being terminated.
   * @param frozen     - Frozen balance snapshot (already persisted before this call).
   * @param direction  - 'RC' for CLOSED surplus returns; 'RX' for CANCELLED full returns.
   * @param deps       - Module dependencies.
   */
  private async _executeTerminationReturns(
    invoiceId: string,
    frozen: FrozenInvoiceBalances,
    direction: 'RC' | 'RX',
    deps: AccountingModuleDependencies,
  ): Promise<void> {
    let failedCount = 0;

    // W23 fix: Hoist getHistory() before the loop and build a memo→entry Map
    // for O(1) lookup instead of O(n*m) linear scans.
    const history = deps.payments.getHistory();
    const historyByMemo = new Map<string, (typeof history)[number]>();
    for (const h of history) {
      if (h.type === 'SENT' && h.memo && h.transferId) {
        historyByMemo.set(h.memo, h);
      }
    }

    for (const ft of frozen.targets) {
      for (const fca of ft.coinAssets) {
        for (const fsb of fca.frozenSenderBalances) {
          const netBalance = AccountingModule._safeBigInt(fsb.netBalance);
          if (netBalance <= 0n) continue;

          const recipient = fsb.senderAddress;
          const coinId = fca.coin[0];
          const amount = fsb.netBalance;
          // Use a dedup key that identifies this frozen-balance return uniquely
          const dedupTransferId = `FROZEN:${ft.address}:${recipient}:${coinId}`;
          const memo = buildInvoiceMemo(invoiceId, direction, dedupTransferId);

          // Skip if already done
          if (this.autoReturnManager.isDone(invoiceId, dedupTransferId)) continue;
          const existing = this.autoReturnManager.getEntry(invoiceId, dedupTransferId);
          if (existing?.status === 'failed') continue;

          // Secondary dedup: check transaction history for an existing return
          // W13: Require type === 'SENT' AND on-chain confirmation (transferId or txHash)
          const alreadyReturned = historyByMemo.get(memo);

          if (alreadyReturned) {
            await this.autoReturnManager.markCompleted(
              invoiceId,
              dedupTransferId,
              alreadyReturned.transferId ?? alreadyReturned.id,
            );
            continue;
          }

          // Write-first intent
          await this.autoReturnManager.recordIntent(invoiceId, dedupTransferId, {
            recipient, amount, coinId, memo,
          });

          try {
            // BUG-002 Fix 3: Wrap send() in Promise.race with 60s timeout, matching
            // returnInvoicePayment() pattern. Without this, a hung send blocks all
            // subsequent returns and holds the invoice gate indefinitely.
            const sendPromise = deps.payments.send({ recipient, amount, coinId, memo });
            let sendTimer: ReturnType<typeof setTimeout> | undefined;
            const sendTimeoutPromise = new Promise<never>((_, reject) => {
              sendTimer = setTimeout(
                () => reject(new SphereError(
                  `Termination auto-return send() timed out after 60s: ${invoiceId} → ${recipient}`,
                  'TIMEOUT',
                )),
                60_000,
              );
            });

            let result: Awaited<typeof sendPromise>;
            try {
              result = await Promise.race([sendPromise, sendTimeoutPromise]);
            } finally {
              if (sendTimer !== undefined) clearTimeout(sendTimer);
            }

            await this.autoReturnManager.markCompleted(invoiceId, dedupTransferId, result.id);
            if (this.config.debug) {
              logger.debug(
                LOG_TAG,
                `Termination auto-return (${direction}) sent: ${invoiceId} → ${recipient} ${amount} ${coinId}`,
              );
            }
          } catch (err) {
            failedCount++;
            logger.warn(
              LOG_TAG,
              `Termination auto-return (${direction}) failed for ${invoiceId} → ${recipient} ${amount} ${coinId}:`,
              err,
            );
            await this.autoReturnManager.markFailed(invoiceId, dedupTransferId);
            deps.emitEvent('invoice:auto_return_failed', {
              invoiceId,
              transferId: dedupTransferId,
              reason: 'send_failed',
            });
          }
        }
      }
    }

    // W14: Log summary if any returns failed
    if (failedCount > 0) {
      logger.warn(LOG_TAG, `${failedCount} auto-return(s) failed for invoice ${invoiceId} — retry via setAutoReturn()`);
    }
  }

  // ===========================================================================
  // Internal: Clear in-memory state
  // ===========================================================================

  /**
   * Reset all in-memory state to empty. Called at the start of `load()` and
   * in `destroy()`.
   */
  private _clearInMemoryState(): void {
    // Unsubscribe any existing event handlers to prevent accumulation on retry
    for (const unsub of this.unsubscribePayments) {
      try { unsub(); } catch { /* ignore */ }
    }
    this.unsubscribePayments = [];
    try { this.unsubscribeDMs?.(); } catch { /* ignore */ }
    this.unsubscribeDMs = null;

    this.invoiceTermsCache.clear();
    this.cancelledInvoices.clear();
    this.closedInvoices.clear();
    this.frozenBalances.clear();
    this.autoReturnGlobal = false;
    this.autoReturnPerInvoice.clear();
    this.autoReturnLastGlobalSet = 0;
    this.autoReturnManager.clear();
    this.invoiceLedger.clear();
    this.unknownLedgerCount = 0;
    this.tokenScanState.clear();
    this.tokenScanDirty = false;
    this.tokenInvoiceMap.clear();
    this.balanceCache.clear();
    this.dirtyLedgerEntries.clear();
    this._gateMap = new AsyncGateMap();
  }

  // ===========================================================================
  // Internal: Terminal set persistence helpers
  // ===========================================================================

  /** Persist frozen balances map to storage. */
  private async _persistFrozenBalances(): Promise<void> {
    const frozenObj: FrozenBalancesStorage = {};
    for (const [invoiceId, frozen] of this.frozenBalances) {
      frozenObj[invoiceId] = frozen;
    }
    await this.saveJsonToStorage(STORAGE_KEYS_ADDRESS.FROZEN_BALANCES, frozenObj);
  }

  /** Persist both terminal sets (CANCELLED and CLOSED) to storage. */
  private async _persistTerminalSets(): Promise<void> {
    await Promise.all([
      this.saveJsonToStorage(
        STORAGE_KEYS_ADDRESS.CANCELLED_INVOICES,
        Array.from(this.cancelledInvoices),
      ),
      this.saveJsonToStorage(
        STORAGE_KEYS_ADDRESS.CLOSED_INVOICES,
        Array.from(this.closedInvoices),
      ),
    ]);
  }

  /** Persist auto-return settings (global flag + per-invoice map) to storage. */
  private async _persistAutoReturnSettings(): Promise<void> {
    const perInvoice: Record<string, boolean> = {};
    for (const [id, enabled] of this.autoReturnPerInvoice.entries()) {
      perInvoice[id] = enabled;
    }
    await this.saveJsonToStorage(STORAGE_KEYS_ADDRESS.AUTO_RETURN, {
      global: this.autoReturnGlobal,
      perInvoice,
    });
  }

  // ===========================================================================
  // Internal: Load auto-return dedup ledger and crash recovery
  // ===========================================================================

  /**
   * Load the auto-return dedup ledger, prune stale completed entries, and
   * attempt crash recovery for pending entries.
   *
   * Crash recovery (§7.5):
   * - For each 'pending' entry: check getHistory() for an existing outbound return
   *   transfer whose memo contains the originalTransferId (secondary dedup).
   * - If found → mark completed.
   * - If not found and retryCount < MAX_RETRY_COUNT → retry send.
   * - If not found and retryCount >= MAX_RETRY_COUNT → mark failed, fire event.
   */
  private async _loadAndRecoverAutoReturnLedger(): Promise<void> {
    const deps = this.deps!;

    // Configure the manager with the address-scoped storage key
    this.autoReturnManager.configure(
      deps.storage,
      this.getStorageKey(STORAGE_KEYS_ADDRESS.AUTO_RETURN_LEDGER),
    );

    // Load and prune (handles pruning internally)
    await this.autoReturnManager.load();

    // Crash recovery for 'pending' entries
    const pendingEntries = this.autoReturnManager.getPendingEntries();
    if (pendingEntries.length === 0) return;

    logger.warn(LOG_TAG, `${pendingEntries.length} pending auto-return ledger entries found — attempting crash recovery`);

    const history = deps.payments.getHistory();

    for (const { key, entry } of pendingEntries) {
      // Parse invoiceId and transferId from key: "{invoiceId}:{transferId}"
      // W7: Use fixed-width split since invoiceId is always 64 hex chars.
      // This avoids fragility with colons in transferId values.
      if (key.length < 66 || key[64] !== ':') continue;
      const invoiceId = key.slice(0, 64);
      const transferId = key.slice(65);

      // Secondary dedup: check if return already landed in history (§7.5)
      // Use exact memo match to prevent crafted-memo false positives.
      // Guard: entry.memo may be undefined in old storage data (W5 fix).
      const expectedMemo = entry.memo;
      const alreadyReturned = expectedMemo
        ? history.find(
            (h) =>
              h.type === 'SENT' &&
              h.memo !== undefined &&
              h.memo === expectedMemo,
          )
        : undefined;

      if (alreadyReturned) {
        // Return already landed — mark completed with the found transfer ID
        await this.autoReturnManager.markCompleted(
          invoiceId,
          transferId,
          alreadyReturned.transferId ?? alreadyReturned.id,
        );
        if (this.config.debug) {
          logger.debug(LOG_TAG, `Crash recovery: marked ${key} as completed (history match)`);
        }
        continue;
      }

      // Check retry count — abandon if exceeded
      const retryCount = entry.retryCount ?? 0;
      if (retryCount >= AutoReturnManager.MAX_RETRY_COUNT) {
        await this.autoReturnManager.markFailed(invoiceId, transferId);
        deps.emitEvent('invoice:auto_return_failed', {
          invoiceId,
          transferId,
          reason: 'max_retries_exceeded',
        });
        logger.warn(LOG_TAG, `Crash recovery: ${key} exceeded max retries — marked failed`);
        continue;
      }

      // Increment retry counter before attempting send
      // W4-R21 fix: Wrap in try/catch so storage failure doesn't abort remaining entries
      try {
        await this.autoReturnManager.incrementRetry(invoiceId, transferId);
      } catch {
        logger.warn(LOG_TAG, `Crash recovery: failed to persist retry count for ${key} — continuing`);
      }

      if (this.config.debug) {
        logger.debug(
          LOG_TAG,
          `Crash recovery: retrying ${key} (attempt ${retryCount + 1}/${AutoReturnManager.MAX_RETRY_COUNT})`,
        );
      }

      // Retry the send using persisted recipient/amount/coinId/memo.
      // Guard: if required fields are missing (old storage format), skip this entry.
      if (!entry.recipient || !entry.amount || !entry.coinId || !entry.memo) {
        await this.autoReturnManager.markFailed(invoiceId, transferId);
        logger.warn(LOG_TAG, `Crash recovery: ${key} missing required fields — marked failed`);
        continue;
      }

      try {
        const result = await deps.payments.send({
          recipient: entry.recipient,
          amount: entry.amount,
          coinId: entry.coinId,
          memo: entry.memo,
        });

        const returnTransferId = result.id;
        await this.autoReturnManager.markCompleted(invoiceId, transferId, returnTransferId);

        // Build minimal InvoiceTransferRef shapes for the event payload
        const now = Date.now();
        const originalRef: import('./types.js').InvoiceTransferRef = {
          transferId,
          direction: 'inbound',
          paymentDirection: 'forward',
          coinId: entry.coinId,
          amount: entry.amount,
          destinationAddress: deps.identity.directAddress ?? '',
          senderAddress: entry.recipient,
          timestamp: now,
          confirmed: false,
        };
        const returnRef: import('./types.js').InvoiceTransferRef = {
          transferId: returnTransferId,
          direction: 'outbound',
          paymentDirection: invoiceId && this.closedInvoices.has(invoiceId)
            ? 'return_closed'
            : 'return_cancelled',
          coinId: entry.coinId,
          amount: entry.amount,
          destinationAddress: entry.recipient,
          senderAddress: deps.identity.directAddress ?? '',
          timestamp: now,
          confirmed: false,
        };

        deps.emitEvent('invoice:auto_returned', {
          invoiceId,
          originalTransfer: originalRef,
          returnTransfer: returnRef,
        });

        if (this.config.debug) {
          logger.debug(LOG_TAG, `Crash recovery: ${key} retried successfully`);
        }
      } catch (err) {
        logger.warn(LOG_TAG, `Crash recovery: retry failed for ${key}:`, err);
        // Leave as 'pending' — next load() will retry again (up to MAX_RETRY_COUNT)
      }
    }
  }

  // ===========================================================================
  // Internal: Invoice-transfer index load (§5.4.4 Phase 1)
  // ===========================================================================

  /**
   * Load the persisted invoice-transfer index from storage and perform an
   * initial gap-fill scan for any new token transactions since last session.
   *
   * Phase 1: Load persisted index state (INV_LEDGER_INDEX, per-invoice keys, TOKEN_SCAN_STATE).
   * Phase 2: Gap-fill by scanning token transaction tails.
   */
  private async _loadInvoiceTransferIndex(): Promise<void> {
    // ------------------------------------------------------------------
    // Phase 1a: Load INV_LEDGER_INDEX (outer map keys)
    // ------------------------------------------------------------------
    let indexMeta: InvLedgerIndex = {};
    try {
      const rawIndex = await this.deps!.storage.get(
        this.getStorageKey(STORAGE_KEYS_ADDRESS.INV_LEDGER_INDEX),
      );
      if (rawIndex) {
        indexMeta = JSON.parse(rawIndex) as InvLedgerIndex;
      }
    } catch (err) {
      logger.warn(LOG_TAG, 'INV_LEDGER_INDEX corrupt — resetting index:', err);
      indexMeta = {};
      // Reset scan state to force full rescan
      this.tokenScanState.clear();
    }

    // Initialize outer map for all known invoiceIds
    for (const invoiceId of Object.keys(indexMeta)) {
      if (!this.invoiceLedger.has(invoiceId)) {
        this.invoiceLedger.set(invoiceId, new Map());
      }
    }

    // ------------------------------------------------------------------
    // Phase 1b: Load per-invoice ledger entries
    // ------------------------------------------------------------------
    let scanStateReset = false; // Set true by corruption handler to prevent Phase 1c stale reload
    for (const invoiceId of this.invoiceLedger.keys()) {
      const key = this.getStorageKey(`${INV_LEDGER_PREFIX}${invoiceId}`);
      try {
        const raw = await this.deps!.storage.get(key);
        if (!raw) continue;
        const entries = JSON.parse(raw) as Record<string, InvoiceTransferRef>;
        const innerMap = this.invoiceLedger.get(invoiceId)!;
        const now = Date.now();
        const PROVISIONAL_TTL_MS = 10 * 60 * 1000; // 10 minutes
        for (const [entryKey, ref] of Object.entries(entries)) {
          // W1 fix: Drop stale provisional entries on load. If a provisional is
          // older than 10 minutes, the on-chain scan should have replaced it by now.
          // Keeping stale provisionals corrupts balance computation indefinitely.
          if (
            entryKey.startsWith('provisional:') &&
            ref.timestamp &&
            (now - ref.timestamp) > PROVISIONAL_TTL_MS
          ) {
            logger.warn(
              LOG_TAG,
              `Dropping stale provisional entry ${entryKey} for invoice ${invoiceId} (age: ${Math.round((now - ref.timestamp) / 1000)}s)`,
            );
            this.dirtyLedgerEntries.add(invoiceId);
            continue; // skip loading this entry
          }
          innerMap.set(entryKey, ref);
          // Rebuild tokenInvoiceMap — only for positional entries (tokenId:txIndex format).
          // Provisional entries (provisional:uuid) don't map to real tokens.
          if (!ref.transferId.startsWith('provisional:') && ref.transferId.includes(':')) {
            const tokenIdFromRef = ref.transferId.slice(0, ref.transferId.indexOf(':'));
            this._addToTokenInvoiceMap(tokenIdFromRef, invoiceId);
          }
        }
      } catch (err) {
        logger.warn(LOG_TAG, `inv_ledger:${invoiceId} corrupt — resetting entry:`, err);
        this.invoiceLedger.set(invoiceId, new Map());
        // Reset scan watermarks for tokens that had entries in this invoice
        // (force rescan to repopulate). This is a conservative reset.
        // For correctness, we'd need to know which tokens were in this invoice,
        // but without the entries we can't. Reset all watermarks as fallback.
        this.tokenScanState.clear();
        scanStateReset = true; // Prevent Phase 1c from reloading stale TOKEN_SCAN_STATE
      }
    }

    // ------------------------------------------------------------------
    // Phase 1c: Load TOKEN_SCAN_STATE (unless corruption handler reset it)
    // ------------------------------------------------------------------
    if (this.tokenScanState.size === 0 && !scanStateReset) {
      try {
        const rawScanState = await this.deps!.storage.get(
          this.getStorageKey(STORAGE_KEYS_ADDRESS.TOKEN_SCAN_STATE),
        );
        if (rawScanState) {
          const scanStateObj = JSON.parse(rawScanState) as Record<string, number>;
          for (const [tokenId, count] of Object.entries(scanStateObj)) {
            this.tokenScanState.set(tokenId, count);
          }
        }
      } catch (err) {
        logger.warn(LOG_TAG, 'TOKEN_SCAN_STATE corrupt — will rescan all tokens:', err);
        this.tokenScanState.clear();
      }
    }

    // ------------------------------------------------------------------
    // Phase 2: Gap-fill scan
    // ------------------------------------------------------------------
    await this._gapFillTokenScan();
  }

  // ===========================================================================
  // Internal: Gap-fill token scan
  // ===========================================================================

  /**
   * Scan the tail of each token's transaction array for new invoice references.
   * Uses `tokenScanState` as a watermark to process only new transactions.
   *
   * After scanning, flushes dirty ledger entries and updates tokenScanState.
   * This is idempotent due to the composite dedup key in processTokenTransactions.
   */
  private async _gapFillTokenScan(): Promise<void> {
    const deps = this.deps!;
    const allTokens = deps.payments.getTokens();
    let anyDirty = false;

    for (const token of allTokens) {
      if (!token.sdkData) continue;
      let txf: TxfToken;
      try {
        txf = JSON.parse(token.sdkData) as TxfToken;
      } catch {
        continue;
      }

      const transactions = txf.transactions ?? [];
      const startIndex = this.tokenScanState.get(token.id) ?? 0;
      if (transactions.length > startIndex) {
        this._processTokenTransactions(token.id, txf, startIndex);
        anyDirty = true;
      }
    }

    // Also scan archived tokens (spec §5.4 Phase 2 step 5)
    const archivedTokens = deps.payments.getArchivedTokens();
    for (const [archivedId, txf] of archivedTokens) {
      const transactions = txf.transactions ?? [];
      const startIndex = this.tokenScanState.get(archivedId) ?? 0;
      if (transactions.length > startIndex) {
        this._processTokenTransactions(archivedId, txf, startIndex);
        anyDirty = true;
      }
    }

    if (anyDirty) {
      await this._flushDirtyLedgerEntries();
    }
  }

  /**
   * Update confirmed=true on all ledger entries whose transferId starts with
   * the given tokenId prefix. Called when transfer:confirmed fires to ensure
   * allConfirmed can become true for implicit close.
   */
  private _markTokenEntriesConfirmed(tokenId: string): void {
    for (const [invoiceId, ledger] of this.invoiceLedger) {
      let changed = false;
      for (const [key, entry] of ledger) {
        if (entry.transferId.startsWith(`${tokenId}:`) && !entry.confirmed) {
          ledger.set(key, { ...entry, confirmed: true });
          changed = true;
        }
      }
      if (changed) {
        this.dirtyLedgerEntries.add(invoiceId);
        this.balanceCache.delete(invoiceId);
      }
    }
  }

  // ===========================================================================
  // Internal: Process token transactions (§5.4.3)
  // ===========================================================================

  /**
   * Scan a token's transaction array from `startIndex` and index any invoice
   * references found in the on-chain message bytes or (fallback) transport memo.
   *
   * For each transaction with an invoice reference, produces one
   * InvoiceTransferRef per coin entry in the token's coinData and inserts it
   * into the invoiceLedger under the composite key `${transferId}::${coinId}`.
   *
   * Updates `tokenScanState` watermark and invalidates `balanceCache` for
   * affected invoices.
   *
   * @param tokenId    - The token's genesis ID.
   * @param txf        - Parsed TxfToken.
   * @param startIndex - First unprocessed transaction index.
   */
  private _processTokenTransactions(
    tokenId: string,
    txf: TxfToken,
    startIndex: number,
  ): void {
    const transactions = txf.transactions ?? [];
    let lastSuccessIdx = startIndex;

    for (let i = startIndex; i < transactions.length; i++) {
      // W23-R2 fix: Advance watermark unconditionally so non-invoice transactions
      // don't cause perpetual re-scanning on every event.
      lastSuccessIdx = i + 1;

      const tx = transactions[i];
      if (!tx?.data?.['message']) continue;

      // Decode hex-encoded UTF-8 JSON message to TransferMessagePayload
      let payload: TransferMessagePayload | null = null;
      try {
        const hexStr = tx.data['message'] as string;
        if (!hexStr || hexStr.length > 8192) continue;
        // W10 fix: validate hex chars before parseInt to avoid NaN bytes
        if (!/^[0-9a-fA-F]*$/.test(hexStr)) continue;
        const matches = hexStr.match(/.{1,2}/g);
        if (!matches) continue;
        const bytes = new Uint8Array(matches.map((b) => parseInt(b, 16)));
        payload = decodeTransferMessage(bytes);
      } catch {
        continue;
      }

      if (!payload?.inv?.id) continue;

      const invoiceId = payload.inv.id.toLowerCase();
      // Proactive indexing: index invoice-referencing transactions so that
      // when an invoice is later imported via importInvoice(), its transfer
      // entries are already in the ledger — no need to rescan all tokens.
      // The tokenScanState watermark is advanced regardless, so skipping would
      // cause a permanent gap: the watermark passes these transactions and
      // importInvoice()'s retroactive scan finds nothing new.
      //
      // W5 fix: Cap the number of unknown invoice IDs to prevent unbounded
      // storage growth from attacker-crafted transfers with fake invoice IDs.
      // Known invoices (in invoiceTermsCache) are always indexed. Unknown ones
      // are indexed only up to the cap.
      const MAX_UNKNOWN_INVOICE_IDS = 500;
      if (!this.invoiceTermsCache.has(invoiceId) && !this.invoiceLedger.has(invoiceId)) {
        // W11: O(1) check using cached counter instead of full ledger scan
        if (this.unknownLedgerCount >= MAX_UNKNOWN_INVOICE_IDS) {
          // Skip indexing this unknown invoice — cap reached.
          // importInvoice() will do a full rescan for this invoice if needed.
          continue;
        }
      }

      // Map direction code to paymentDirection
      const dirMap: Record<string, InvoiceTransferRef['paymentDirection']> = {
        F: 'forward',
        B: 'back',
        RC: 'return_closed',
        RX: 'return_cancelled',
      };
      const paymentDirection = dirMap[payload.inv.dir] ?? 'forward';

      // Extract coin data from genesis — skip tokens without valid coinData
      const coinData = txf.genesis?.data?.coinData as [string, string][] | undefined;
      if (!coinData || coinData.length === 0) {
        // Invoice tokens intentionally have null coinData; non-invoice tokens should not.
        if (txf.genesis?.data?.tokenType !== INVOICE_TOKEN_TYPE_HEX) {
          logger.warn(LOG_TAG, `Token ${tokenId} tx[${i}] has no coinData — skipping`);
        }
        continue;
      }
      const entries = coinData.slice(0, this.config.maxCoinDataEntries);

      // Use positional transferId (avoids expensive async hash computation)
      const transferId = `${tokenId}:${i}`;

      // Determine sender from genesis recipient (index 0) or prior transaction predicate.
      // We use a simple heuristic: senderAddress from genesis recipient at index 0,
      // null for subsequent transactions (no async SDK calls available in sync context).
      // For return directions (back/return_closed/return_cancelled), the genesis recipient
      // is the original destination (the invoice target), NOT the return sender. Setting
      // senderAddress from genesis recipient would cause the §6.2 step 3a check to
      // incorrectly classify unauthorized returns as authorized. Use null instead.
      const isReturnDirection =
        paymentDirection === 'back' ||
        paymentDirection === 'return_closed' ||
        paymentDirection === 'return_cancelled';
      const senderAddress: string | null =
        isReturnDirection ? null : (i === 0 ? (txf.genesis?.data?.recipient ?? null) : null);

      // Create one ref per coin
      for (const [coinId, amount] of entries) {
        // W6-R18 fix: validate coinId — on-chain coinData is untrusted. Reject empty,
        // non-alphanumeric, or excessively long coinIds to prevent storage amplification
        // and dedup-key collision (coinId containing '::' could corrupt composite keys).
        if (!coinId || !/^[A-Za-z0-9]+$/.test(coinId) || coinId.length > 68) {
          logger.warn(LOG_TAG, `Token ${tokenId} tx[${i}] has invalid coinId '${coinId}' — skipping`);
          continue;
        }
        // W12 fix: validate amount — must be a positive integer without leading zeros.
        // On-chain amounts of "0" are nonsensical for accounting; leading zeros indicate corruption.
        if (!amount || !/^[1-9][0-9]*$/.test(amount)) {
          logger.warn(LOG_TAG, `Token ${tokenId} tx[${i}] coin ${coinId} has invalid amount '${amount}' — skipping`);
          continue;
        }

        const dedupKey = `${transferId}::${coinId}`;

        if (!this.invoiceLedger.has(invoiceId)) {
          this.invoiceLedger.set(invoiceId, new Map());
          // W11: Increment unknown count if this invoice is not known
          if (!this.invoiceTermsCache.has(invoiceId)) {
            this.unknownLedgerCount++;
          }
        }
        const ledger = this.invoiceLedger.get(invoiceId)!;
        if (ledger.has(dedupKey)) continue; // dedup

        const ref: InvoiceTransferRef = {
          transferId,
          direction: 'inbound', // default; callers post-correct if wallet is sender
          paymentDirection,
          coinId,
          amount,
          // W5 fix: validate tx.data.recipient is a string before use (untrusted on-chain data)
          destinationAddress: (() => {
            const txRecipient = (tx.data as Record<string, unknown>)?.['recipient'];
            if (typeof txRecipient === 'string' && txRecipient) return txRecipient;
            if (i === 0) return (txf.genesis?.data?.recipient ?? '');
            return '';
          })(),
          // W7 fix: use 0 sentinel — Date.now()
          // would produce incorrect timestamps on crash-recovery rescans.
          timestamp: 0,
          confirmed: tx.inclusionProof !== null,
          senderAddress,
          ...(payload.inv.ra !== undefined ? { refundAddress: payload.inv.ra } : {}),
        };

        // W8 fix: Remove ONE provisional entry per on-chain entry (one-for-one match).
        // Provisional entries (from returnInvoicePayment sync update) have keys
        // like "provisional:{uuid}::{coinId}". When the real tokenId:txIndex entry
        // arrives, we remove one matching provisional to prevent double-counting.
        // Match on coinId + paymentDirection only (not amount) because token splits
        // may produce different on-chain amounts than the requested return amount.
        const keysToDelete: string[] = [];
        for (const [existingKey, existingRef] of ledger) {
          if (
            existingKey.startsWith('provisional:') &&
            existingRef.coinId === coinId &&
            existingRef.paymentDirection === paymentDirection
          ) {
            keysToDelete.push(existingKey);
            break; // W8: one-for-one — remove only one provisional per on-chain entry
          }
        }
        // W23 fix: Also remove matching synthetic entries (from v5split instant-mode
        // tokens that arrived before TXF data). Synthetic keys use
        // "synthetic:{transportTransferId}::{coinId}" — match by coinId + direction.
        for (const [existingKey, existingRef] of ledger) {
          if (
            existingKey.startsWith('synthetic:') &&
            existingRef.coinId === coinId &&
            existingRef.paymentDirection === paymentDirection
          ) {
            keysToDelete.push(existingKey);
            break; // one-for-one — remove only one synthetic per on-chain entry
          }
        }
        for (const pKey of keysToDelete) {
          ledger.delete(pKey);
        }

        ledger.set(dedupKey, ref);
        this.dirtyLedgerEntries.add(invoiceId);
        this.balanceCache.delete(invoiceId);

        // Update tokenInvoiceMap
        if (!this.tokenInvoiceMap.has(tokenId)) {
          this.tokenInvoiceMap.set(tokenId, new Set());
        }
        this.tokenInvoiceMap.get(tokenId)!.add(invoiceId);
      }

      // (watermark advancement moved to top of loop body — W23-R2 fix)
    }

    // Update watermark to last successfully processed index
    this.tokenScanState.set(tokenId, lastSuccessIdx);
    this.tokenScanDirty = true;
  }

  // ===========================================================================
  // Internal: Subscribe to PaymentsModule events
  // ===========================================================================

  /**
   * Register listeners on the Sphere event bus for PaymentsModule-emitted events:
   * - `transfer:incoming` — new inbound transfer (IncomingTransfer payload)
   * - `transfer:confirmed` — outbound transfer confirmed (TransferResult payload)
   * - `history:updated` — history entry added/updated (TransactionHistoryEntry payload)
   *
   * All handlers are wrapped in try/catch to prevent event handler errors from
   * propagating back to the event emitter.
   *
   * Subscription must be set up AFTER the initial index build (§7.6 step 7) to
   * prevent races between recovery retries and incoming event processing.
   */
  private _subscribeToPaymentsEvents(): void {
    const deps = this.deps!;

    const unsubIncoming = deps.on('transfer:incoming', (transfer: IncomingTransfer) => {
      this._handleIncomingTransfer(transfer).catch((err) => {
        logger.warn(LOG_TAG, 'Error handling transfer:incoming event:', err);
      });
    });

    const unsubConfirmed = deps.on('transfer:confirmed', (result: TransferResult) => {
      this._handleTransferConfirmed(result).catch((err) => {
        logger.warn(LOG_TAG, 'Error handling transfer:confirmed event:', err);
      });
    });

    const unsubHistory = deps.on(
      'history:updated',
      (entry: SphereEventMap['history:updated']) => {
        this._handleHistoryUpdated(entry).catch((err) => {
          logger.warn(LOG_TAG, 'Error handling history:updated event:', err);
        });
      },
    );

    // Register token change observer for inline indexing.
    // When PaymentsModule adds/updates a token (addToken, updateToken, sync),
    // this callback indexes the token's transactions immediately — no separate
    // gap-fill scan needed for runtime changes.
    const unsubTokenChange = deps.payments.onTokenChange((tokenId: string, sdkData: string) => {
      try {
        this._handleTokenChange(tokenId, sdkData);
      } catch (err) {
        logger.warn(LOG_TAG, 'Error in token change observer:', err);
      }
    });

    this.unsubscribePayments = [unsubIncoming, unsubConfirmed, unsubHistory, unsubTokenChange];
  }

  // ===========================================================================
  // Internal: Token change observer (inline indexing)
  // ===========================================================================

  /**
   * Handle a token change notification from PaymentsModule.
   *
   * Called synchronously by the `onTokenChange` observer when a token is
   * added or updated in PaymentsModule (addToken, updateToken). Parses the
   * token's TXF data and indexes any invoice-referencing transactions.
   *
   * This is the "index at validation time" path — transactions are indexed
   * the moment they enter the wallet, eliminating the need for separate
   * gap-fill scans for runtime changes.
   *
   * Synchronous: only updates in-memory ledger and marks dirty entries.
   * Persistence is deferred to the next `_flushDirtyLedgerEntries()` call
   * (triggered by event handlers or explicit flush).
   *
   * @param tokenId - The genesis tokenId (64-hex) of the changed token.
   * @param sdkData - The raw TXF JSON string from the token's sdkData field.
   */
  private _handleTokenChange(tokenId: string, sdkData: string): void {
    if (this.destroyed || !this.deps) return;

    let txf: TxfToken;
    try {
      txf = JSON.parse(sdkData) as TxfToken;
    } catch {
      return;
    }

    const transactions = txf.transactions ?? [];
    const startIndex = this.tokenScanState.get(tokenId) ?? 0;
    if (transactions.length <= startIndex) return; // no new transactions

    this._processTokenTransactions(tokenId, txf, startIndex);

    // Flush is deferred — the event handlers (_handleIncomingTransfer,
    // _handleTransferConfirmed) will call _flushDirtyLedgerEntries() as
    // part of their normal flow. For token changes that DON'T trigger
    // an event (e.g., sync), we schedule an async flush.
    // W2 fix: Serialize flushes via promise chaining to prevent concurrent interleaved writes.
    // C1-R17 fix: Use chain pattern instead of .finally() nulling — the old pattern clobbered
    // a newer flush's promise reference when an older flush's .finally() ran, allowing a third
    // flush to skip the await and run concurrently with the second.
    if (this.dirtyLedgerEntries.size > 0 || this.tokenScanDirty) {
      // W2-R18 fix: Capture reference to null it after completion if unchanged,
      // preventing unbounded promise chain growth in long-running sessions.
      const p = (this._flushPromise ?? Promise.resolve())
        .then(() => this._flushDirtyLedgerEntries())
        .catch((err) => {
          logger.warn(LOG_TAG, 'Error flushing ledger after token change:', err);
        })
        .finally(() => {
          // Only null if no newer flush has replaced this reference
          if (this._flushPromise === p) this._flushPromise = null;
        });
      this._flushPromise = p;
    }
  }

  /**
   * Drain the `_flushPromise` chain until it's fully resolved.
   * A concurrent `_handleTokenChange` can replace the reference between our
   * await and the null assignment, so we loop until the field is null.
   */
  private async _drainFlushPromise(): Promise<void> {
    while (this._flushPromise) {
      await this._flushPromise.catch(() => { /* swallow — flush errors are non-fatal */ });
    }
  }

  // ===========================================================================
  // Internal: Event handlers
  // ===========================================================================

  /**
   * Handle an incoming transfer event from PaymentsModule (§6.2).
   *
   * Advances token scan watermarks, then parses the transport memo for an invoice
   * reference. If found, executes the full §6.2 event firing pipeline: unknown-
   * reference check, return handling with gate serialization, payment event firing,
   * status recomputation, and coverage/overpayment cascade.
   *
   * Non-blocking: errors are caught by the caller's .catch() wrapper in
   * _subscribeToPaymentsEvents().
   *
   * @param transfer - IncomingTransfer payload from 'transfer:incoming' event.
   */
  private async _handleIncomingTransfer(transfer: IncomingTransfer): Promise<void> {
    if (this.destroyed) return;

    // Advance token scan watermarks (stub advances counter only — full indexing deferred)
    for (const token of transfer.tokens) {
      if (!token.sdkData) continue;
      let txf: TxfToken;
      try {
        txf = JSON.parse(token.sdkData) as TxfToken;
      } catch {
        continue;
      }
      const startIndex = this.tokenScanState.get(token.id) ?? 0;
      if ((txf.transactions?.length ?? 0) > startIndex) {
        this._processTokenTransactions(token.id, txf, startIndex);
      }
    }

    // W5-R20 fix: Check destroyed before flush — event handler may still be mid-execution
    // after destroy() unsubscribes (fire-and-forget promise from before unsubscribe).
    if (this.destroyed) return;
    await this._flushDirtyLedgerEntries();

    // §6.2 step 1: Parse transport memo for invoice reference
    const memo = transfer.memo;
    if (!memo) return;

    const memoRef = parseInvoiceMemo(memo);
    if (!memoRef) return;

    const { invoiceId, paymentDirection: memoParsedDirection } = memoRef;
    let paymentDirection = memoParsedDirection;
    const confirmed = false; // transfer:incoming = unconfirmed
    const deps = this.deps!;

    // W3 fix: Prefer on-chain direction over transport memo direction.
    // The ledger entries from _processTokenTransactions (run above) have the
    // authoritative direction from the on-chain message bytes. If the transport
    // memo direction disagrees (e.g., compromised relay), use the on-chain one.
    const ledger = this.invoiceLedger.get(invoiceId);
    if (ledger) {
      for (const token of transfer.tokens) {
        if (!token.id) continue;
        for (const [, ref] of ledger) {
          if (ref.transferId.startsWith(`${token.id}:`)) {
            if (ref.paymentDirection !== paymentDirection) {
              logger.warn(
                LOG_TAG,
                `Direction mismatch: transport memo says ${paymentDirection}, ` +
                  `on-chain says ${ref.paymentDirection} for invoice ${invoiceId} — using on-chain`,
              );
              paymentDirection = ref.paymentDirection;
            }
            break;
          }
        }
      }
    }

    // §6.2 step 2: Invoice not in local store → fire unknown_reference and return
    if (!this.invoiceTermsCache.has(invoiceId)) {
      const syntheticRef = this._buildSyntheticTransferRef(
        transfer,
        invoiceId,
        paymentDirection,
        confirmed,
      );
      deps.emitEvent('invoice:unknown_reference', { invoiceId, transfer: syntheticRef });
      return;
    }

    await this._processInvoiceTransferEvent(transfer, invoiceId, paymentDirection, confirmed);
  }

  /**
   * Handle a transfer:confirmed event from PaymentsModule (§6.2 confirmed path).
   *
   * Advances watermarks, invalidates balance caches, then re-fires all applicable
   * invoice events with confirmed=true for any related invoices. If all targets are
   * covered and confirmed, triggers implicit close via the per-invoice gate.
   *
   * @param result - TransferResult payload from 'transfer:confirmed' event.
   */
  private async _handleTransferConfirmed(result: TransferResult): Promise<void> {
    if (this.destroyed) return;

    // Advance watermarks and invalidate balance caches for all related tokens
    for (const token of result.tokens) {
      if (!token.sdkData) continue;
      let txf: TxfToken;
      try {
        txf = JSON.parse(token.sdkData) as TxfToken;
      } catch {
        continue;
      }
      const startIndex = this.tokenScanState.get(token.id) ?? 0;
      if ((txf.transactions?.length ?? 0) > startIndex) {
        this._processTokenTransactions(token.id, txf, startIndex);
      }
      const relatedInvoices = this.tokenInvoiceMap.get(token.id);
      if (relatedInvoices) {
        for (const invoiceId of relatedInvoices) {
          this.balanceCache.delete(invoiceId);
        }
      }
    }

    // W5-R20 fix: Check destroyed before flush
    if (this.destroyed) return;
    await this._flushDirtyLedgerEntries();

    // Mark ledger entries as confirmed for all tokens in this result
    for (const token of result.tokens) {
      this._markTokenEntriesConfirmed(token.id);
    }
    // Flush the confirmed-status updates
    // C2-R21 fix: No destroyed check here — confirmed=true updates have no recovery path
    // because transfer:confirmed events don't re-fire. Must persist even during shutdown.
    await this._flushDirtyLedgerEntries();

    // §6.2 transfer:confirmed step 1–4: re-fire events with confirmed=true
    const deps = this.deps!;

    // Collect all invoices that may be affected by this confirmation, using the
    // tokenInvoiceMap (secondary reverse index populated by _processTokenTransactions).
    const affectedInvoices = new Set<string>();
    for (const token of result.tokens) {
      const related = this.tokenInvoiceMap.get(token.id);
      if (related) {
        for (const invoiceId of related) {
          affectedInvoices.add(invoiceId);
        }
      }
    }

    for (const invoiceId of affectedInvoices) {
      if (this.destroyed) return;

      // §6.2 transfer:confirmed step 2: skip terminal invoices
      if (this.cancelledInvoices.has(invoiceId) || this.closedInvoices.has(invoiceId)) {
        continue;
      }

      const terms = this.invoiceTermsCache.get(invoiceId);
      if (!terms) continue;

      const innerMap = this.invoiceLedger.get(invoiceId);
      if (!innerMap) continue;

      const entries = Array.from(innerMap.values());
      const walletAddresses = new Set(deps.getActiveAddresses().map((a) => a.directAddress));
      if (deps.identity?.directAddress) walletAddresses.add(deps.identity.directAddress);
      const status = computeInvoiceStatus(invoiceId, terms, entries, null, walletAddresses);

      // W2 fix: Re-check terminal state before firing coverage events — a concurrent
      // closeInvoice/cancelInvoice may have completed between our terminal check above
      // and here. Firing coverage events on a terminal invoice confuses consumers.
      if (this.cancelledInvoices.has(invoiceId) || this.closedInvoices.has(invoiceId)) {
        continue;
      }

      // §6.2 transfer:confirmed step 3: re-fire coverage events with confirmed=true
      this._fireCoverageEvents(invoiceId, terms, status, entries, true, deps);

      // §6.2 transfer:confirmed step 4: implicit close check
      if (status.state === 'COVERED' && status.allConfirmed) {
        await this.withInvoiceGate(invoiceId, async () => {
          if (this.destroyed) return;
          if (this.cancelledInvoices.has(invoiceId) || this.closedInvoices.has(invoiceId)) return;

          const reEntries = this.invoiceLedger.get(invoiceId)
            ? Array.from(this.invoiceLedger.get(invoiceId)!.values())
            : [];
          // W7-R20 fix: Re-read walletAddresses inside gate (matches W15 fix in getInvoiceStatus)
          const freshWalletAddresses = new Set(deps.getActiveAddresses().map((a) => a.directAddress));
          const reStatus = computeInvoiceStatus(invoiceId, terms, reEntries, null, freshWalletAddresses);
          if (reStatus.state === 'COVERED' && reStatus.allConfirmed) {
            await this._terminateInvoice(invoiceId, 'CLOSED');
          }
        });
      }
    }
  }

  /**
   * Handle a history:updated event from PaymentsModule (§6.2 history fallback).
   *
   * Used as a fallback trigger for pre-change transfers or when on-chain message
   * decoding is not yet available. Advances watermark, then parses transport memo
   * and fires events exactly as _handleIncomingTransfer does.
   *
   * @param entry - HistoryRecord payload from 'history:updated' event.
   */
  private async _handleHistoryUpdated(
    entry: SphereEventMap['history:updated'],
  ): Promise<void> {
    if (this.destroyed) return;

    const tokenId = entry.tokenId;
    if (!tokenId) return;

    // Look up the token to access its transaction data
    const tokens = this.deps!.payments.getTokens();
    const token = tokens.find((t) => t.id === tokenId);
    if (!token?.sdkData) return;

    let txf: TxfToken;
    try {
      txf = JSON.parse(token.sdkData) as TxfToken;
    } catch {
      return;
    }

    const startIndex = this.tokenScanState.get(tokenId) ?? 0;
    if ((txf.transactions?.length ?? 0) > startIndex) {
      this._processTokenTransactions(tokenId, txf, startIndex);
      if (this.destroyed) return;
      await this._flushDirtyLedgerEntries();
    }

    // §6.2 step 1: Parse transport memo for invoice reference
    const memo = entry.memo;
    if (!memo) return;

    const memoRef = parseInvoiceMemo(memo);
    if (!memoRef) return;

    const { invoiceId, paymentDirection } = memoRef;
    // History entries may be unconfirmed at time of 'history:updated' fire;
    // confirmation arrives separately via 'transfer:confirmed'.
    const confirmed = false;
    const deps = this.deps!;

    // §6.2 step 2: Invoice not in local store → fire unknown_reference and return
    if (!this.invoiceTermsCache.has(invoiceId)) {
      const syntheticRef = this._buildSyntheticTransferRefFromHistory(
        entry,
        invoiceId,
        paymentDirection,
        confirmed,
      );
      deps.emitEvent('invoice:unknown_reference', { invoiceId, transfer: syntheticRef });
      return;
    }

    await this._processInvoiceHistoryEvent(entry, invoiceId, paymentDirection, confirmed);
  }

  /**
   * Handle an incoming DM event from CommunicationsModule.
   * Detects `invoice_receipt:` and `invoice_cancellation:` prefixes (§5.11, §5.12).
   * Ordered: receipt prefix checked first, then cancellation, then treated as regular DM.
   *
   * @param message - DirectMessage from 'message:dm' event.
   */
  private async _handleIncomingDM(message: DirectMessage): Promise<void> {
    if (this.destroyed) return;

    const content = message.content;
    if (!content || typeof content !== 'string') return;

    if (content.startsWith('invoice_receipt:')) {
      this._processReceiptDM(message);
    } else if (content.startsWith('invoice_cancellation:')) {
      this._processCancellationDM(message);
    }
    // Neither prefix → regular DM, no action
  }

  /**
   * Parse and fire an `invoice:receipt_received` event from a receipt DM (§5.11).
   *
   * Applies 64 KB size guard before JSON.parse, performs full payload validation
   * per §5.11 step 5, enforces invoice existence check (step 5b), and applies
   * nametag fallback: `dm.senderNametag ?? payload.targetNametag` (step 6).
   *
   * @param message - The DM containing the receipt payload.
   */
  private _processReceiptDM(message: DirectMessage): void {
    const PREFIX = 'invoice_receipt:';
    const jsonSubstring = message.content.slice(PREFIX.length);

    // §5.11 content size guard: 64 KB limit prevents memory pressure from oversized payloads
    if (jsonSubstring.length > 65536) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonSubstring);
    } catch {
      return; // malformed JSON — treat as regular DM, silent
    }

    if (typeof parsed !== 'object' || parsed === null) return;
    const raw = parsed as Record<string, unknown>;

    // §5.11 step 5a: type discriminator
    if (raw['type'] !== 'invoice_receipt') return;

    // §5.11 step 5b: version — must be a non-NaN integer >= 1
    const version = raw['version'];
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return;
    if (version > 1) return; // forward compat: silently ignore future versions

    // §5.11 step 5c: invoiceId must be 64- or 68-char lowercase hex (DataHash.imprint format)
    const invoiceId = raw['invoiceId'];
    if (typeof invoiceId !== 'string' || !/^[0-9a-f]{64,68}$/.test(invoiceId)) return;

    // §5.11 step 5d: terminalState
    const terminalState = raw['terminalState'];
    if (terminalState !== 'CLOSED' && terminalState !== 'CANCELLED') return;

    // §5.11 step 5e: senderContribution — object with non-empty senderAddress and bounded assets array
    const senderContribution = raw['senderContribution'];
    if (
      typeof senderContribution !== 'object' ||
      senderContribution === null ||
      typeof (senderContribution as Record<string, unknown>)['senderAddress'] !== 'string' ||
      !(senderContribution as Record<string, unknown>)['senderAddress'] ||
      !Array.isArray((senderContribution as Record<string, unknown>)['assets'])
    ) {
      return;
    }
    const assets = (senderContribution as Record<string, unknown>)['assets'] as unknown[];
    if (assets.length > 100) return; // storage amplification defense

    // W3 fix: validate each asset element is a non-null object with coinId string
    for (const asset of assets) {
      if (typeof asset !== 'object' || asset === null ||
          typeof (asset as Record<string, unknown>)['coinId'] !== 'string') {
        return; // malformed asset element
      }
    }

    // §5.11 step 5f: targetAddress must be present as string
    if (typeof raw['targetAddress'] !== 'string') return;

    // §5.11 step 5g: memo must be string if present
    if (raw['memo'] !== undefined && typeof raw['memo'] !== 'string') return;

    // §5.11 step 5b (invoice existence check): drop if invoice not known locally
    if (!this.invoiceTermsCache.has(invoiceId)) return;

    // W2 fix: terminalState is already validated above (line 5d). The redundant
    // status/terminalState check here was dead code — remove to avoid confusion.

    // W6-R20 fix: Truncate unbounded string fields before cast to prevent memory
    // pressure from malicious DMs with oversized payloads in event consumers.
    if (typeof raw['targetNametag'] === 'string' && raw['targetNametag'].length > 64) {
      raw['targetNametag'] = raw['targetNametag'].slice(0, 64);
    }
    if (typeof raw['memo'] === 'string' && raw['memo'].length > 4096) {
      raw['memo'] = raw['memo'].slice(0, 4096);
    }
    const receipt: InvoiceReceiptPayload = raw as unknown as InvoiceReceiptPayload;

    // §5.11 step 6: nametag fallback — DM sender nametag takes priority over payload field
    const incoming: IncomingInvoiceReceipt = {
      dmId: message.id,
      senderPubkey: message.senderPubkey,
      senderNametag: message.senderNametag ?? receipt.targetNametag,
      receipt,
      receivedAt: message.timestamp ?? Date.now(),
    };

    this.deps!.emitEvent('invoice:receipt_received', { invoiceId, receipt: incoming });
  }

  /**
   * Parse and fire an `invoice:cancellation_received` event from a cancellation DM (§5.12).
   *
   * Applies 64 KB size guard, performs full payload validation per §5.12 step 5,
   * enforces invoice existence check (step 5b), and applies nametag fallback:
   * `dm.senderNametag ?? payload.targetNametag` (step 6).
   *
   * @param message - The DM containing the cancellation notice payload.
   */
  private _processCancellationDM(message: DirectMessage): void {
    const PREFIX = 'invoice_cancellation:';
    const jsonSubstring = message.content.slice(PREFIX.length);

    // §5.12 content size guard: 64 KB limit
    if (jsonSubstring.length > 65536) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonSubstring);
    } catch {
      return; // malformed JSON — treat as regular DM, silent
    }

    if (typeof parsed !== 'object' || parsed === null) return;
    const raw = parsed as Record<string, unknown>;

    // §5.12 step 5a: type discriminator
    if (raw['type'] !== 'invoice_cancellation') return;

    // §5.12 step 5b: version — must be a non-NaN integer >= 1
    const version = raw['version'];
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return;
    if (version > 1) return; // forward compat

    // §5.12 step 5c: invoiceId must be 64- or 68-char lowercase hex (DataHash.imprint format)
    const invoiceId = raw['invoiceId'];
    if (typeof invoiceId !== 'string' || !/^[0-9a-f]{64,68}$/.test(invoiceId)) return;

    // §5.12 step 5d: senderContribution — object with non-empty senderAddress and bounded assets array
    const senderContribution = raw['senderContribution'];
    if (
      typeof senderContribution !== 'object' ||
      senderContribution === null ||
      typeof (senderContribution as Record<string, unknown>)['senderAddress'] !== 'string' ||
      !(senderContribution as Record<string, unknown>)['senderAddress'] ||
      !Array.isArray((senderContribution as Record<string, unknown>)['assets'])
    ) {
      return;
    }
    const assetsArr = (senderContribution as Record<string, unknown>)['assets'] as unknown[];
    if (assetsArr.length > 100) return; // storage amplification defense

    // W4 fix: validate each asset element is a non-null object with coinId string
    for (const asset of assetsArr) {
      if (typeof asset !== 'object' || asset === null ||
          typeof (asset as Record<string, unknown>)['coinId'] !== 'string') {
        return; // malformed asset element
      }
    }

    // §5.12 step 5e: targetAddress must be present as string
    if (typeof raw['targetAddress'] !== 'string') return;

    // §5.12 step 5f: reason must be string if present
    if (raw['reason'] !== undefined && typeof raw['reason'] !== 'string') return;

    // §5.12 step 5g: dealDescription must be string if present
    if (raw['dealDescription'] !== undefined && typeof raw['dealDescription'] !== 'string') return;

    // §5.12 step 5b (invoice existence check): drop if invoice not known locally
    if (!this.invoiceTermsCache.has(invoiceId)) return;

    // W6-R20 fix: Truncate unbounded string fields before cast
    if (typeof raw['targetNametag'] === 'string' && raw['targetNametag'].length > 64) {
      raw['targetNametag'] = raw['targetNametag'].slice(0, 64);
    }
    if (typeof raw['reason'] === 'string' && raw['reason'].length > 4096) {
      raw['reason'] = raw['reason'].slice(0, 4096);
    }
    if (typeof raw['dealDescription'] === 'string' && raw['dealDescription'].length > 4096) {
      raw['dealDescription'] = raw['dealDescription'].slice(0, 4096);
    }
    const notice: InvoiceCancellationPayload = raw as unknown as InvoiceCancellationPayload;

    // §5.12 step 6: nametag fallback — DM sender nametag takes priority over payload field
    const incoming: IncomingCancellationNotice = {
      dmId: message.id,
      senderPubkey: message.senderPubkey,
      senderNametag: message.senderNametag ?? notice.targetNametag,
      notice,
      receivedAt: message.timestamp ?? Date.now(),
    };

    this.deps!.emitEvent('invoice:cancellation_received', { invoiceId, notice: incoming });
  }

  // ===========================================================================
  // Internal: §6.2 event pipeline helpers
  // ===========================================================================

  /**
   * Core §6.2 event pipeline for an incoming transfer that references a known invoice.
   *
   * Handles both the return path (§6.2 step 3) and the forward path (§6.2 steps 4–7).
   * Called from _handleIncomingTransfer after invoice existence is confirmed.
   *
   * @param transfer         - IncomingTransfer source data (tokens, sender info).
   * @param invoiceId        - Validated invoice token ID from parsed memo.
   * @param paymentDirection - Parsed direction from memo.
   * @param confirmed        - Whether the transfer is already confirmed.
   */
  private async _processInvoiceTransferEvent(
    transfer: IncomingTransfer,
    invoiceId: string,
    paymentDirection: 'forward' | 'back' | 'return_closed' | 'return_cancelled',
    confirmed: boolean,
  ): Promise<void> {
    const deps = this.deps!;
    const terms = this.invoiceTermsCache.get(invoiceId)!;

    let syntheticRef = this._buildSyntheticTransferRef(
      transfer,
      invoiceId,
      paymentDirection,
      confirmed,
    );

    // Enrich synthetic ref with senderAddress/refundAddress/contact from ledger entries.
    // _processTokenTransactions (called before us) extracts senderAddress from genesis
    // recipient, and inv.ra/inv.ct from on-chain data into ledger entries. The synthetic
    // ref built above only uses transport-level data (which has senderAddress=null for
    // inbound transfers because transport pubkey ≠ chain address).
    const ledger = this.invoiceLedger.get(invoiceId);
    if (ledger) {
      for (const token of transfer.tokens) {
        if (!token.id) continue;
        for (const [key, ref] of ledger) {
          if (key.startsWith(`${token.id}:`)) {
            syntheticRef = {
              ...syntheticRef,
              // Copy senderAddress from ledger when synthetic ref has null
              ...(syntheticRef.senderAddress === null && ref.senderAddress !== null
                ? { senderAddress: ref.senderAddress } : {}),
              ...(ref.refundAddress !== undefined ? { refundAddress: ref.refundAddress } : {}),
              ...(ref.contact !== undefined ? { contact: ref.contact } : {}),
            };
            break;
          }
        }
        if (syntheticRef.senderAddress !== null) break; // found enrichment, stop searching
      }
    }

    const isReturn =
      paymentDirection === 'back' ||
      paymentDirection === 'return_closed' ||
      paymentDirection === 'return_cancelled';

    // §6.2 step 3: Return payment — validate sender then fire return events
    if (isReturn) {
      // Pre-gate: index has already been updated by _processTokenTransactions above.
      // Now acquire gate to serialize return processing for this invoice.
      await this.withInvoiceGate(invoiceId, async () => {
        if (this.destroyed) return;

        // §6.2 step 3a: Sender must be an invoice target; null (masked) is rejected
        const targetAddressSet = new Set(terms.targets.map((t) => t.address));
        const senderAddr = syntheticRef.senderAddress;
        const senderIsTarget = senderAddr !== null && targetAddressSet.has(senderAddr);

        if (!senderIsTarget) {
          // Reclassify: fire as irrelevant with reason 'unauthorized_return'
          // (The index mutation is best-effort — errors are logged but do not fail the transfer.)
          deps.emitEvent('invoice:irrelevant', {
            invoiceId,
            transfer: { ...syntheticRef, paymentDirection: 'forward' as const },
            reason: 'unauthorized_return',
            confirmed,
          });
          return;
        }

        // §6.2 step 3b: Fire invoice:return_received
        const returnReason: 'manual' | 'closed' | 'cancelled' =
          paymentDirection === 'return_closed'
            ? 'closed'
            : paymentDirection === 'return_cancelled'
              ? 'cancelled'
              : 'manual';

        deps.emitEvent('invoice:return_received', {
          invoiceId,
          transfer: syntheticRef,
          returnReason,
        });

        // §6.2 step 3c: Over-refund warning (informational — transfer is NOT blocked)
        if (senderAddr !== null) {
          const coinId = syntheticRef.coinId;
          const innerMap = this.invoiceLedger.get(invoiceId);
          if (innerMap) {
            let totalForwarded = 0n;
            let totalReturned = 0n;

            for (const ref of innerMap.values()) {
              if (ref.coinId !== coinId) continue;
              const effectiveSender = ref.refundAddress ?? ref.senderAddress;
              if (effectiveSender !== senderAddr) continue;

              if (ref.paymentDirection === 'forward') {
                totalForwarded += AccountingModule._safeBigInt(ref.amount);
              } else {
                totalReturned += AccountingModule._safeBigInt(ref.amount);
              }
            }
            // W3 fix: Only add synthetic ref amount if it wasn't already indexed in the ledger.
            // _processTokenTransactions runs before this handler and may have already
            // created a ledger entry for the same transfer.
            // C2-R17 fix: Ledger keys use "{tokenId}:{txIdx}::{coinId}" format but
            // syntheticRef.transferId is a transport UUID — formats never match for key lookup.
            // Instead, check if any token from this transfer already has a matching ledger entry
            // by scanning for tokenId-prefixed keys with matching coinId.
            let alreadyIndexed = false;
            if (transfer.tokens) {
              for (const tok of transfer.tokens) {
                if (!tok.id) continue;
                for (const ledgerKey of innerMap.keys()) {
                  if (ledgerKey.startsWith(`${tok.id}:`) && ledgerKey.endsWith(`::${coinId}`)) {
                    alreadyIndexed = true;
                    break;
                  }
                }
                if (alreadyIndexed) break;
              }
            }
            if (!alreadyIndexed) {
              totalReturned += AccountingModule._safeBigInt(syntheticRef.amount);
            }

            if (totalReturned > totalForwarded) {
              deps.emitEvent('invoice:over_refund_warning', {
                invoiceId,
                senderAddress: senderAddr,
                coinId,
                forwardedAmount: totalForwarded.toString(),
                returnedAmount: totalReturned.toString(),
              });
            }
          }
        }

        // §6.2 step 3d: Auto-terminate on return if config flag is set
        if (this.config.autoTerminateOnReturn) {
          if (paymentDirection === 'return_closed') {
            // :RC → auto-close (MUST call _terminateInvoice, NOT closeInvoice() — gate already held)
            await this._terminateInvoice(invoiceId, 'CLOSED');
          } else if (paymentDirection === 'return_cancelled') {
            // :RX → auto-cancel
            await this._terminateInvoice(invoiceId, 'CANCELLED');
          }
        }
      });

      return;
    }

    // §6.2 step 4: Forward payment — index already updated by _processTokenTransactions above.

    // §6.2 step 5: Terminal invoice — fire payment event but skip balance events
    if (this.cancelledInvoices.has(invoiceId) || this.closedInvoices.has(invoiceId)) {
      deps.emitEvent('invoice:payment', {
        invoiceId,
        transfer: syntheticRef,
        paymentDirection,
        confirmed,
      });

      // §6.2 step 5 (auto-return): if enabled and wallet is a target, return the payment
      const autoReturnEnabled =
        this.autoReturnPerInvoice.get(invoiceId) ?? this.autoReturnGlobal;

      if (autoReturnEnabled && this.isTarget(invoiceId)) {
        await this._executeEventAutoReturn(invoiceId, syntheticRef, deps);
      }

      return;
    }

    // §6.2 step 6: Non-terminal — match transfer against invoice targets and assets
    const walletAddresses = new Set(deps.getActiveAddresses().map((a) => a.directAddress));
    if (deps.identity?.directAddress) walletAddresses.add(deps.identity.directAddress);
    const targetAddressSet = new Set(terms.targets.map((t) => t.address));

    const matchesTarget = targetAddressSet.has(syntheticRef.destinationAddress);
    const targetTerms = terms.targets.find((t) => t.address === syntheticRef.destinationAddress);
    const targetCoinIds = new Set(
      (targetTerms?.assets ?? []).filter((a) => a.coin).map((a) => a.coin![0]),
    );
    const matchesAsset = matchesTarget && targetCoinIds.has(syntheticRef.coinId);

    if (matchesTarget && matchesAsset) {
      // §6.2 step 6a-fix: Ensure ledger entry exists for instant-mode (v5split) tokens.
      // In instant mode, split tokens arrive without TXF transactions/genesis, so
      // _processTokenTransactions creates no ledger entries. Create a synthetic entry
      // from the syntheticRef so that computeInvoiceStatus can track coverage.
      if (!this.invoiceLedger.has(invoiceId)) {
        this.invoiceLedger.set(invoiceId, new Map());
      }
      const existingLedger = this.invoiceLedger.get(invoiceId)!;
      // W23-R3 fix: Use token ID (not transfer ID) as the synthetic key so that
      // both transfer:incoming and history:updated produce the same key for the
      // same payment. This prevents double-counting while allowing multiple
      // legitimate payments with the same coinId.
      const firstTokenId = transfer.tokens.find((t) => t.id)?.id;
      const syntheticKey = firstTokenId
        ? `synthetic:${firstTokenId}::${syntheticRef.coinId}`
        : `synthetic:${syntheticRef.transferId}::${syntheticRef.coinId}`;
      if (!existingLedger.has(syntheticKey)) {
        // Check no real entry exists for this transfer's tokens (by tokenId prefix match).
        let hasRealEntry = false;
        for (const tok of transfer.tokens) {
          if (!tok.id) continue;
          for (const [key] of existingLedger) {
            if (key.startsWith(`${tok.id}:`) && key.endsWith(`::${syntheticRef.coinId}`)) {
              hasRealEntry = true;
              break;
            }
          }
          if (hasRealEntry) break;
        }
        if (!hasRealEntry) {
          existingLedger.set(syntheticKey, { ...syntheticRef });
        }
      }

      // §6.2 step 6a: Matches target + asset
      deps.emitEvent('invoice:payment', {
        invoiceId,
        transfer: syntheticRef,
        paymentDirection,
        confirmed,
      });
    } else {
      // §6.2 step 6b: Does not match any target/asset
      const reason: IrrelevantReason =
        !matchesTarget && !matchesAsset
          ? 'unknown_address_and_asset'
          : !matchesTarget
            ? 'unknown_address'
            : 'unknown_asset';

      deps.emitEvent('invoice:irrelevant', {
        invoiceId,
        transfer: syntheticRef,
        reason,
        confirmed,
      });
      return;
    }

    // §6.2 step 7: Recompute status and fire coverage/overpayment/expiry events
    const innerMap = this.invoiceLedger.get(invoiceId);
    const entries = innerMap ? Array.from(innerMap.values()) : [];
    const status = computeInvoiceStatus(invoiceId, terms, entries, null, walletAddresses);

    this._fireCoverageEvents(invoiceId, terms, status, entries, confirmed, deps);

    // §6.2 step 7c: Implicit close when all covered and all confirmed
    if (status.state === 'COVERED' && status.allConfirmed) {
      await this.withInvoiceGate(invoiceId, async () => {
        if (this.destroyed) return;
        if (this.cancelledInvoices.has(invoiceId) || this.closedInvoices.has(invoiceId)) return;

        const reEntries = this.invoiceLedger.get(invoiceId)
          ? Array.from(this.invoiceLedger.get(invoiceId)!.values())
          : [];
        // W23 fix: Re-read walletAddresses inside gate (matches W7-R20 pattern in _handleTransferConfirmed)
        const freshWalletAddresses = new Set(deps.getActiveAddresses().map((a) => a.directAddress));
        if (deps.identity?.directAddress) freshWalletAddresses.add(deps.identity.directAddress);
        const reStatus = computeInvoiceStatus(invoiceId, terms, reEntries, null, freshWalletAddresses);
        if (reStatus.state === 'COVERED' && reStatus.allConfirmed) {
          await this._terminateInvoice(invoiceId, 'CLOSED');
        }
      });
    }

    // §6.2 step 7e: Expiry check — fire informational expired event if dueDate passed
    if (
      terms.dueDate !== undefined &&
      Date.now() > terms.dueDate &&
      status.state !== 'COVERED' &&
      status.state !== 'CLOSED' &&
      status.state !== 'CANCELLED'
    ) {
      deps.emitEvent('invoice:expired', { invoiceId });
    }
  }

  /**
   * Core §6.2 event pipeline for a history:updated entry that references a known invoice.
   * Mirrors _processInvoiceTransferEvent but operates on a HistoryRecord.
   *
   * @param entry            - HistoryRecord from 'history:updated' event.
   * @param invoiceId        - Validated invoice token ID.
   * @param paymentDirection - Parsed direction from memo.
   * @param confirmed        - Whether the transfer is confirmed.
   */
  private async _processInvoiceHistoryEvent(
    entry: SphereEventMap['history:updated'],
    invoiceId: string,
    paymentDirection: 'forward' | 'back' | 'return_closed' | 'return_cancelled',
    confirmed: boolean,
  ): Promise<void> {
    const deps = this.deps!;
    const terms = this.invoiceTermsCache.get(invoiceId)!;

    const syntheticRef = this._buildSyntheticTransferRefFromHistory(
      entry,
      invoiceId,
      paymentDirection,
      confirmed,
    );

    const isReturn =
      paymentDirection === 'back' ||
      paymentDirection === 'return_closed' ||
      paymentDirection === 'return_cancelled';

    if (isReturn) {
      await this.withInvoiceGate(invoiceId, async () => {
        if (this.destroyed) return;

        const targetAddressSet = new Set(terms.targets.map((t) => t.address));
        const senderAddr = syntheticRef.senderAddress;
        const senderIsTarget = senderAddr !== null && targetAddressSet.has(senderAddr);

        if (!senderIsTarget) {
          deps.emitEvent('invoice:irrelevant', {
            invoiceId,
            transfer: { ...syntheticRef, paymentDirection: 'forward' as const },
            reason: 'unauthorized_return',
            confirmed,
          });
          return;
        }

        const returnReason: 'manual' | 'closed' | 'cancelled' =
          paymentDirection === 'return_closed'
            ? 'closed'
            : paymentDirection === 'return_cancelled'
              ? 'cancelled'
              : 'manual';

        deps.emitEvent('invoice:return_received', {
          invoiceId,
          transfer: syntheticRef,
          returnReason,
        });

        // CR-R20 fix: Over-refund warning (matches _processInvoiceTransferEvent §6.2 step 3c)
        if (senderAddr !== null) {
          const coinId = syntheticRef.coinId;
          const innerMap = this.invoiceLedger.get(invoiceId);
          if (innerMap) {
            let totalForwarded = 0n;
            let totalReturned = 0n;
            for (const ref of innerMap.values()) {
              if (ref.coinId !== coinId) continue;
              const effectiveSender = ref.refundAddress ?? ref.senderAddress;
              if (effectiveSender !== senderAddr) continue;
              if (ref.paymentDirection === 'forward') {
                totalForwarded += AccountingModule._safeBigInt(ref.amount);
              } else {
                totalReturned += AccountingModule._safeBigInt(ref.amount);
              }
            }
            // W4-R20 fix: Check if this return was already indexed by _processTokenTransactions
            // (same alreadyIndexed pattern as _processInvoiceTransferEvent §6.2 step 3c)
            let alreadyIndexed = false;
            if (entry.tokenId) {
              for (const ledgerKey of innerMap.keys()) {
                if (ledgerKey.startsWith(`${entry.tokenId}:`) && ledgerKey.endsWith(`::${coinId}`)) {
                  alreadyIndexed = true;
                  break;
                }
              }
            }
            if (!alreadyIndexed) {
              totalReturned += AccountingModule._safeBigInt(syntheticRef.amount);
            }
            if (totalReturned > totalForwarded) {
              deps.emitEvent('invoice:over_refund_warning', {
                invoiceId,
                senderAddress: senderAddr,
                coinId,
                forwardedAmount: totalForwarded.toString(),
                returnedAmount: totalReturned.toString(),
              });
            }
          }
        }

        if (this.config.autoTerminateOnReturn) {
          if (paymentDirection === 'return_closed') {
            await this._terminateInvoice(invoiceId, 'CLOSED');
          } else if (paymentDirection === 'return_cancelled') {
            await this._terminateInvoice(invoiceId, 'CANCELLED');
          }
        }
      });
      return;
    }

    if (this.cancelledInvoices.has(invoiceId) || this.closedInvoices.has(invoiceId)) {
      deps.emitEvent('invoice:payment', {
        invoiceId,
        transfer: syntheticRef,
        paymentDirection,
        confirmed,
      });
      return;
    }

    const walletAddresses = new Set(deps.getActiveAddresses().map((a) => a.directAddress));
    if (deps.identity?.directAddress) walletAddresses.add(deps.identity.directAddress);
    const targetAddressSet = new Set(terms.targets.map((t) => t.address));
    const matchesTarget = targetAddressSet.has(syntheticRef.destinationAddress);
    const targetTerms = terms.targets.find((t) => t.address === syntheticRef.destinationAddress);
    const targetCoinIds = new Set(
      (targetTerms?.assets ?? []).filter((a) => a.coin).map((a) => a.coin![0]),
    );
    const matchesAsset = matchesTarget && targetCoinIds.has(syntheticRef.coinId);

    if (matchesTarget && matchesAsset) {
      // Ensure ledger entry exists (same v5split fix as _processInvoiceTransferEvent)
      if (!this.invoiceLedger.has(invoiceId)) {
        this.invoiceLedger.set(invoiceId, new Map());
      }
      const hLedger = this.invoiceLedger.get(invoiceId)!;
      // W23-R3 fix: Use token ID (not transfer ID) as the synthetic key — same
      // approach as _processInvoiceTransferEvent. entry.tokenId comes from the
      // history record and matches the token ID used in the transfer event.
      const hKey = entry.tokenId
        ? `synthetic:${entry.tokenId}::${syntheticRef.coinId}`
        : `synthetic:${syntheticRef.transferId}::${syntheticRef.coinId}`;
      if (!hLedger.has(hKey)) {
        // Check for real entries for this specific token (scoped by tokenId, not broad coinId)
        let hasRealEntry = false;
        if (entry.tokenId) {
          for (const [k] of hLedger) {
            if (k.startsWith(`${entry.tokenId}:`) && k.endsWith(`::${syntheticRef.coinId}`)) {
              hasRealEntry = true;
              break;
            }
          }
        }
        if (!hasRealEntry) {
          hLedger.set(hKey, { ...syntheticRef });
        }
      }

      deps.emitEvent('invoice:payment', {
        invoiceId,
        transfer: syntheticRef,
        paymentDirection,
        confirmed,
      });
    } else {
      const reason: IrrelevantReason =
        !matchesTarget && !matchesAsset
          ? 'unknown_address_and_asset'
          : !matchesTarget
            ? 'unknown_address'
            : 'unknown_asset';

      deps.emitEvent('invoice:irrelevant', {
        invoiceId,
        transfer: syntheticRef,
        reason,
        confirmed,
      });
      return;
    }

    const innerMap = this.invoiceLedger.get(invoiceId);
    const ledgerEntries = innerMap ? Array.from(innerMap.values()) : [];
    const status = computeInvoiceStatus(invoiceId, terms, ledgerEntries, null, walletAddresses);

    this._fireCoverageEvents(invoiceId, terms, status, ledgerEntries, confirmed, deps);

    if (status.state === 'COVERED' && status.allConfirmed) {
      await this.withInvoiceGate(invoiceId, async () => {
        if (this.destroyed) return;
        if (this.cancelledInvoices.has(invoiceId) || this.closedInvoices.has(invoiceId)) return;
        const reEntries = this.invoiceLedger.get(invoiceId)
          ? Array.from(this.invoiceLedger.get(invoiceId)!.values())
          : [];
        // W23 fix: Re-read walletAddresses inside gate (matches W7-R20 pattern in _handleTransferConfirmed)
        const freshWalletAddresses = new Set(deps.getActiveAddresses().map((a) => a.directAddress));
        if (deps.identity?.directAddress) freshWalletAddresses.add(deps.identity.directAddress);
        const reStatus = computeInvoiceStatus(invoiceId, terms, reEntries, null, freshWalletAddresses);
        if (reStatus.state === 'COVERED' && reStatus.allConfirmed) {
          await this._terminateInvoice(invoiceId, 'CLOSED');
        }
      });
    }

    if (
      terms.dueDate !== undefined &&
      Date.now() > terms.dueDate &&
      status.state !== 'COVERED' &&
      status.state !== 'CLOSED' &&
      status.state !== 'CANCELLED'
    ) {
      deps.emitEvent('invoice:expired', { invoiceId });
    }
  }

  /**
   * Execute an auto-return for a forward payment to a terminal invoice (§6.2 step 5).
   *
   * Uses the dedup ledger pattern to prevent double-returns. Runs inside the
   * per-invoice gate to serialize concurrent auto-returns for the same invoice.
   * Best-effort: send failures are recorded in the dedup ledger and fire
   * `invoice:auto_return_failed` but do not throw.
   *
   * @param invoiceId    - The terminal invoice ID.
   * @param originalRef  - The InvoiceTransferRef for the incoming forward payment.
   * @param deps         - Module dependencies.
   */
  private async _executeEventAutoReturn(
    invoiceId: string,
    originalRef: InvoiceTransferRef,
    deps: AccountingModuleDependencies,
  ): Promise<void> {
    // Phase 1: Inside gate — check dedup, resolve destination, record intent
    const sendParams = await this.withInvoiceGate(invoiceId, async () => {
      if (this.destroyed) return null;

      const transferId = originalRef.transferId;

      // W12: Skip if already completed OR already in flight (pending).
      // isDone() only checks 'completed'; we also check 'pending' to prevent
      // concurrent sends from both passing before either completes.
      const existing = this.autoReturnManager.getEntry(invoiceId, transferId);
      if (existing && (existing.status === 'completed' || existing.status === 'pending')) {
        return null;
      }
      if (existing?.status === 'failed') return null;

      // §6.2: Resolve auto-return destination: refundAddress ?? senderAddress
      const returnTo = originalRef.refundAddress ?? originalRef.senderAddress;
      if (!returnTo) {
        deps.emitEvent('invoice:auto_return_failed', {
          invoiceId,
          transferId,
          reason: 'sender_unresolvable',
        });
        return null;
      }

      // Direction code: :RC for CLOSED, :RX for CANCELLED (§6.2 step 5)
      const dirCode = this.closedInvoices.has(invoiceId) ? 'RC' : 'RX';
      const returnMemo = buildInvoiceMemo(invoiceId, dirCode, transferId);

      // Write-first intent log (crash recovery)
      await this.autoReturnManager.recordIntent(invoiceId, transferId, {
        recipient: returnTo,
        amount: originalRef.amount,
        coinId: originalRef.coinId,
        memo: returnMemo,
      });

      return { transferId, returnTo, amount: originalRef.amount, coinId: originalRef.coinId, memo: returnMemo };
    });

    if (!sendParams) return;

    // Phase 2+3: Outside gate — send tokens then mark completed/failed directly.
    // C1-R20 fix: markCompleted/markFailed only touch the dedup ledger (not invoice
    // state), so gate exclusion is not needed. Removing the Phase 3 gate entry
    // eliminates the destroy() gap where send succeeds but markCompleted never runs
    // (causing duplicate payment on crash recovery).
    try {
      // Steelman fix: Wrap send() with 60s timeout for consistency with all other send paths.
      const evtSendPromise = deps.payments.send({
        recipient: sendParams.returnTo,
        amount: sendParams.amount,
        coinId: sendParams.coinId,
        memo: sendParams.memo,
      });
      let evtSendTimer: ReturnType<typeof setTimeout> | undefined;
      const evtSendTimeout = new Promise<never>((_, reject) => {
        evtSendTimer = setTimeout(
          () => reject(new SphereError(
            `Event auto-return send() timed out after 60s: ${invoiceId} → ${sendParams.returnTo}`,
            'TIMEOUT',
          )),
          60_000,
        );
      });

      let result: Awaited<typeof evtSendPromise>;
      try {
        result = await Promise.race([evtSendPromise, evtSendTimeout]);
      } finally {
        if (evtSendTimer !== undefined) clearTimeout(evtSendTimer);
      }

      // Mark completed immediately after send (no gate — dedup ledger only)
      await this.autoReturnManager.markCompleted(invoiceId, sendParams.transferId, result.id);

      const returnRef: import('./types.js').InvoiceTransferRef = {
        transferId: result.id,
        direction: 'outbound',
        // CR-R20 fix: Use terminal set membership (not original direction) to determine return type
        paymentDirection: this.closedInvoices.has(invoiceId) ? 'return_closed' : 'return_cancelled',
        coinId: sendParams.coinId,
        amount: sendParams.amount,
        destinationAddress: sendParams.returnTo,
        senderAddress: deps.identity.directAddress ?? '',
        timestamp: Date.now(),
        confirmed: false,
      };
      deps.emitEvent('invoice:auto_returned', {
        invoiceId,
        originalTransfer: originalRef,
        returnTransfer: returnRef,
      });
    } catch (err) {
      logger.warn(LOG_TAG, `Auto-return send failed for ${invoiceId} → ${sendParams.returnTo}:`, err);

      // CR-H1 fix: Match _executeAutoReturnFromFrozen retry pattern — only markFailed
      // when retryCount >= MAX_RETRY_COUNT, otherwise leave as 'pending' for crash
      // recovery to retry. Calling incrementRetry+markFailed unconditionally made
      // event auto-returns single-attempt regardless of MAX_RETRY_COUNT.
      try {
        const retryCount = await this.autoReturnManager.incrementRetry(invoiceId, sendParams.transferId);
        if (retryCount >= AutoReturnManager.MAX_RETRY_COUNT) {
          await this.autoReturnManager.markFailed(invoiceId, sendParams.transferId);
          deps.emitEvent('invoice:auto_return_failed', {
            invoiceId,
            transferId: sendParams.transferId,
            reason: 'send_failed',
          });
        }
        // else: leave as 'pending' — crash recovery will retry up to MAX_RETRY_COUNT
      } catch {
        // Storage failure — entry stays 'pending' in memory, crash recovery will retry
        deps.emitEvent('invoice:auto_return_failed', {
          invoiceId,
          transferId: sendParams.transferId,
          reason: 'send_failed',
        });
      }
    }
  }

  /**
   * Fire cascade coverage events (§6.2 steps 7a–7d) from a recomputed invoice status.
   *
   * Fires per §6.3 idempotency contract: may fire multiple times. Consumers MUST
   * handle them idempotently. Events fired:
   * - `invoice:asset_covered` for each covered coin asset
   * - `invoice:target_covered` for each covered target
   * - `invoice:covered` when all targets are covered
   * - `invoice:overpayment` when surplus > 0 for any coin asset
   *
   * @param invoiceId - Invoice token ID.
   * @param terms     - Invoice terms (unused directly; kept for future per-asset checks).
   * @param status    - Recomputed invoice status from computeInvoiceStatus().
   * @param _entries  - Ledger entries (reserved for future use).
   * @param confirmed - Whether the triggering transfer is confirmed.
   * @param deps      - Module dependencies.
   */
  private _fireCoverageEvents(
    invoiceId: string,
    _terms: InvoiceTerms,
    status: ReturnType<typeof computeInvoiceStatus>,
    _entries: InvoiceTransferRef[],
    confirmed: boolean,
    deps: AccountingModuleDependencies,
  ): void {
    for (const targetStatus of status.targets) {
      // §6.2 step 7a: fire asset_covered for each covered coin asset
      for (const coinAsset of targetStatus.coinAssets) {
        if (coinAsset.isCovered) {
          deps.emitEvent('invoice:asset_covered', {
            invoiceId,
            address: targetStatus.address,
            coinId: coinAsset.coin[0],
            confirmed: confirmed && coinAsset.confirmed,
          });
        }

        // §6.2 step 7d: fire overpayment when surplus > 0
        if (AccountingModule._safeBigInt(coinAsset.surplusAmount) > 0n) {
          deps.emitEvent('invoice:overpayment', {
            invoiceId,
            address: targetStatus.address,
            coinId: coinAsset.coin[0],
            surplus: coinAsset.surplusAmount,
            confirmed: confirmed && coinAsset.confirmed,
          });
        }
      }

      // §6.2 step 7b: fire target_covered when all coin assets for this target are covered
      if (targetStatus.isCovered) {
        deps.emitEvent('invoice:target_covered', {
          invoiceId,
          address: targetStatus.address,
          confirmed: confirmed && targetStatus.confirmed,
        });
      }
    }

    // §6.2 step 7c (partial): fire invoice:covered when all targets are covered
    const allTargetsCovered = status.targets.every((t) => t.isCovered);
    if (allTargetsCovered && status.targets.length > 0) {
      deps.emitEvent('invoice:covered', {
        invoiceId,
        confirmed: status.allConfirmed,
      });
    }
  }

  /**
   * Build a synthetic InvoiceTransferRef from an IncomingTransfer event payload.
   *
   * Used during the event pipeline when the on-chain index (_processTokenTransactions)
   * has not yet populated the ledger with a real ref. Derives coinId/amount from the
   * first token's genesis coinData. Falls back to empty strings for unknown fields.
   *
   * Direction is determined by comparing the wallet's addresses against
   * destinationAddress: inbound if destination matches a wallet address, outbound if
   * the wallet is the sender.
   *
   * @param transfer         - IncomingTransfer payload.
   * @param invoiceId        - Parsed invoice ID from memo (used for destination lookup).
   * @param paymentDirection - Parsed direction from memo.
   * @param confirmed        - Whether the transfer is confirmed.
   * @returns Synthetic InvoiceTransferRef for event payloads.
   */
  private _buildSyntheticTransferRef(
    transfer: IncomingTransfer,
    invoiceId: string,
    paymentDirection: 'forward' | 'back' | 'return_closed' | 'return_cancelled',
    confirmed: boolean,
  ): InvoiceTransferRef {
    const deps = this.deps!;
    const identity = deps.identity;
    const activeAddresses = deps.getActiveAddresses();
    const walletAddresses = new Set(activeAddresses.map((a) => a.directAddress));

    // Extract coinId/amount from the first token's genesis coinData (if available)
    let coinId = '';
    let amount = '0';
    const firstToken = transfer.tokens[0];
    if (firstToken?.sdkData) {
      try {
        const txf = JSON.parse(firstToken.sdkData) as TxfToken;
        const coinData = txf.genesis?.data?.coinData as [string, string][] | undefined;
        if (coinData && coinData.length > 0) {
          coinId = coinData[0]![0] ?? '';
          amount = coinData[0]![1] ?? '0';
        }
      } catch {
        // ignore — use empty defaults
      }
    }

    // Determine sender/destination based on whether we are the sender
    const isSelfSender = transfer.senderPubkey === identity.chainPubkey;

    let destinationAddress: string;
    let senderAddress: string | null;

    if (isSelfSender) {
      // Outbound transfer: we are the sender; try to extract actual destination
      // from token genesis data before falling back to terms.targets[0].
      senderAddress = identity.directAddress ?? null;
      let actualDest = '';
      if (firstToken?.sdkData) {
        try {
          const txfData = JSON.parse(firstToken.sdkData) as TxfToken;
          actualDest = txfData.genesis?.data?.recipient ?? '';
        } catch { /* ignore */ }
      }
      if (!actualDest) {
        const terms = this.invoiceTermsCache.get(invoiceId);
        actualDest = terms?.targets[0]?.address ?? '';
      }
      destinationAddress = actualDest;
    } else {
      // Inbound transfer: we are the recipient; use our first active address as destination
      senderAddress = null; // transport pubkey ≠ chain address; not resolvable here
      destinationAddress = activeAddresses[0]?.directAddress ?? (identity.directAddress ?? '');
    }

    const direction: 'inbound' | 'outbound' = walletAddresses.has(destinationAddress)
      ? 'inbound'
      : 'outbound';

    return {
      transferId: transfer.id,
      direction,
      paymentDirection,
      coinId,
      amount,
      destinationAddress,
      timestamp: transfer.receivedAt,
      confirmed,
      senderAddress,
      senderPubkey: transfer.senderPubkey,
      senderNametag: transfer.senderNametag,
    };
  }

  /**
   * Build a synthetic InvoiceTransferRef from a HistoryRecord event payload.
   *
   * Used during the history:updated event pipeline when the on-chain index is not
   * yet populated. Direction is derived from HistoryRecord.type ('SENT' → outbound,
   * otherwise inbound).
   *
   * @param entry            - HistoryRecord from 'history:updated'.
   * @param invoiceId        - Parsed invoice ID (unused; reserved for future use).
   * @param paymentDirection - Parsed direction from memo.
   * @param confirmed        - Whether the transfer is confirmed.
   * @returns Synthetic InvoiceTransferRef for event payloads.
   */
  private _buildSyntheticTransferRefFromHistory(
    entry: SphereEventMap['history:updated'],
    _invoiceId: string,
    paymentDirection: 'forward' | 'back' | 'return_closed' | 'return_cancelled',
    confirmed: boolean,
  ): InvoiceTransferRef {
    const deps = this.deps!;
    const identity = deps.identity;
    const activeAddresses = deps.getActiveAddresses();
    const walletAddresses = new Set(activeAddresses.map((a) => a.directAddress));

    const isOutbound = entry.type === 'SENT';

    let destinationAddress: string;
    let senderAddress: string | null;

    if (isOutbound) {
      destinationAddress = entry.recipientAddress ?? '';
      senderAddress = identity.directAddress ?? null;
    } else {
      destinationAddress = activeAddresses[0]?.directAddress ?? (identity.directAddress ?? '');
      senderAddress = entry.senderAddress ?? null;
    }

    // Consistency: if destination is a wallet address, treat as inbound
    const direction: 'inbound' | 'outbound' = walletAddresses.has(destinationAddress)
      ? 'inbound'
      : isOutbound
        ? 'outbound'
        : 'inbound';

    return {
      transferId: entry.transferId ?? entry.id,
      direction,
      paymentDirection,
      coinId: entry.coinId,
      amount: entry.amount,
      destinationAddress,
      timestamp: entry.timestamp,
      confirmed,
      senderAddress,
      senderPubkey: entry.senderPubkey,
      senderNametag: entry.senderNametag,
      recipientPubkey: entry.recipientPubkey,
      recipientNametag: entry.recipientNametag,
    };
  }

  // ===========================================================================
  // Internal: Flush dirty ledger entries to storage
  // ===========================================================================

  /**
   * Persist all dirty invoice ledger entries to storage, update token scan state,
   * and update the INV_LEDGER_INDEX.
   *
   * Write order (§7.3 crash recovery):
   * 1. Write inv_ledger:{invoiceId} for each dirty invoice.
   * 2. Write token_scan_state.
   * 3. Write inv_ledger_index.
   */
  private async _flushDirtyLedgerEntries(): Promise<void> {
    // W17: Use tokenScanDirty flag instead of tokenScanState.size (which is
    // always > 0 after first scan, causing unnecessary writes on every event).
    if (this.dirtyLedgerEntries.size === 0 && !this.tokenScanDirty) return;

    // C3 fix: Step 1 uses direct storage.set() — failures abort steps 2-3 to prevent
    // watermark advancement past un-persisted ledger entries.
    const written = new Set<string>();
    let step1Failed = false;
    for (const invoiceId of this.dirtyLedgerEntries) {
      const innerMap = this.invoiceLedger.get(invoiceId);
      if (!innerMap) continue;
      const entries: Record<string, InvoiceTransferRef> = {};
      for (const [k, v] of innerMap.entries()) {
        entries[k] = v;
      }
      try {
        await this.deps!.storage.set(
          this.getStorageKey(`${INV_LEDGER_PREFIX}${invoiceId}`),
          JSON.stringify(entries),
        );
        written.add(invoiceId);
      } catch (err) {
        logger.warn(LOG_TAG, `Failed to persist ledger for invoice ${invoiceId} — aborting flush`, err);
        step1Failed = true;
        break;
      }
    }
    for (const id of written) {
      this.dirtyLedgerEntries.delete(id);
    }

    // C3: If any step-1 write failed, skip steps 2-3 to prevent watermark advancing
    // past un-persisted entries. Next flush will retry.
    if (step1Failed) return;

    // Step 2: Write token_scan_state
    const scanStateObj: Record<string, number> = {};
    for (const [tokenId, count] of this.tokenScanState.entries()) {
      scanStateObj[tokenId] = count;
    }
    await this.saveJsonToStorage(STORAGE_KEYS_ADDRESS.TOKEN_SCAN_STATE, scanStateObj);

    // Step 3: Write INV_LEDGER_INDEX
    const indexMeta: InvLedgerIndex = {};
    for (const invoiceId of this.invoiceLedger.keys()) {
      indexMeta[invoiceId] = {
        terminated: this.cancelledInvoices.has(invoiceId) || this.closedInvoices.has(invoiceId),
        frozenAt: this.frozenBalances.get(invoiceId)?.frozenAt,
      };
    }
    await this.saveJsonToStorage(STORAGE_KEYS_ADDRESS.INV_LEDGER_INDEX, indexMeta);

    // W9 fix: clear tokenScanDirty AFTER all 3 steps complete, not between steps 2 and 3.
    // If step 3 fails, the dirty flag remains set so the next flush retries.
    this.tokenScanDirty = false;
  }

  // ===========================================================================
  // Internal: tokenInvoiceMap helpers
  // ===========================================================================

  /**
   * Register that a token affects a given invoice in the secondary reverse index.
   */
  private _addToTokenInvoiceMap(tokenId: string, invoiceId: string): void {
    let set = this.tokenInvoiceMap.get(tokenId);
    if (!set) {
      set = new Set();
      this.tokenInvoiceMap.set(tokenId, set);
    }
    set.add(invoiceId);
  }

  // ===========================================================================
  // Internal: InvoiceTerms parsing
  // ===========================================================================

  /**
   * Parse InvoiceTerms from a tokenData string (JSON).
   * Returns null on parse failure (corruption-resilient).
   *
   * @param tokenData - JSON string from genesis.data.tokenData.
   */
  /**
   * Normalize symbol coinIds (e.g. "BTC", "ETH") to hash coinIds in invoice terms.
   * Called after parsing to ensure computeInvoiceStatus matches against hash coinIds
   * from ledger entries (which come from token coinData, always hash format).
   */
  private _normalizeInvoiceTerms(terms: InvoiceTerms): InvoiceTerms {
    const registry = TokenRegistry.getInstance();
    const normalizedTargets = terms.targets.map(target => ({
      ...target,
      assets: target.assets.map(asset => {
        if (!asset.coin) return asset;
        const [coinId, amount] = asset.coin;
        if (coinId.length <= 20 && /^[A-Za-z0-9]+$/.test(coinId)) {
          const def = registry.getDefinitionBySymbol(coinId);
          if (def?.id && def.id !== coinId) {
            return { ...asset, coin: [def.id, amount] as [string, string] };
          }
        }
        return asset;
      }),
    }));
    const hasChanges = normalizedTargets.some((t, i) =>
      t.assets.some((a, j) => a.coin?.[0] !== terms.targets[i]?.assets[j]?.coin?.[0])
    );
    return hasChanges ? { ...terms, targets: normalizedTargets } : terms;
  }

  private _parseInvoiceTerms(tokenData: string): InvoiceTerms | null {
    // tokenData may be either a plain JSON string or hex-encoded UTF-8 JSON
    // (state-transition-sdk serialises tokenData as hex via HexConverter.encode).
    const candidates: string[] = [tokenData];
    try {
      const bytes = hexToBytes(tokenData);
      candidates.push(new TextDecoder().decode(bytes));
    } catch {
      // not valid hex — only try the raw string
    }
    for (const candidate of candidates) {
      try {
        const terms = JSON.parse(candidate) as InvoiceTerms;
        if (!terms || typeof terms !== 'object') continue;
        if (!Array.isArray(terms.targets) || terms.targets.length === 0) continue;
        if (typeof terms.createdAt !== 'number') continue;
        return terms;
      } catch {
        // try next candidate
      }
    }
    return null;
  }

  // ===========================================================================
  // Internal: Storage helpers
  // ===========================================================================

  /**
   * Build a per-address-scoped storage key.
   * Uses the current identity's addressId prefix for per-address isolation.
   *
   * @param key - The STORAGE_KEYS_ADDRESS key (or arbitrary string).
   */
  private getStorageKey(key: string): string {
    const identity = this.deps!.identity;
    // Use condensed addressId format (DIRECT_abc123_xyz789) for consistency with other modules
    const addressId = getAddressId(identity.directAddress ?? identity.chainPubkey);
    return getAddressStorageKey(addressId, key);
  }

  /**
   * Load and JSON-parse a value from storage, returning `defaultValue` on
   * missing keys or JSON parse failures (corruption-resilient).
   *
   * @param key          - Storage key (will be scoped via getStorageKey).
   * @param defaultValue - Value to return when the key is missing or corrupt.
   */
  private async loadJsonFromStorage<T>(key: string, defaultValue: T): Promise<T> {
    try {
      const raw = await this.deps!.storage.get(this.getStorageKey(key));
      if (!raw) return defaultValue;
      return JSON.parse(raw) as T;
    } catch (err) {
      logger.warn(LOG_TAG, `Failed to load/parse storage key "${key}":`, err);
      return defaultValue;
    }
  }

  /**
   * JSON-serialize and save a value to storage.
   *
   * @param key   - Storage key (will be scoped via getStorageKey).
   * @param value - Value to serialize and store.
   */
  private async saveJsonToStorage(key: string, value: unknown): Promise<void> {
    try {
      await this.deps!.storage.set(this.getStorageKey(key), JSON.stringify(value));
    } catch (err) {
      logger.warn(LOG_TAG, `Failed to save storage key "${key}":`, err);
    }
  }
}

// =============================================================================
// Factory function
// =============================================================================

/**
 * Factory function that constructs an AccountingModule with the given config.
 *
 * @param config - Optional module configuration.
 * @returns A new AccountingModule instance.
 *
 * @example
 * ```ts
 * const accounting = createAccountingModule({ debug: true });
 * accounting.initialize(deps);
 * await accounting.load();
 * ```
 */
export function createAccountingModule(config?: AccountingModuleConfig): AccountingModule {
  return new AccountingModule(config);
}
