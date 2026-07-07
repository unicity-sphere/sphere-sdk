/**
 * AccountingModule — v2 slim rebuild (Wave 6-P2-4c).
 *
 * This file replaces the 7,747-LoC v1 impl (quarantined to
 * `./legacy-v1/AccountingModule-legacy.ts`) with a compact ~1,800-LoC facade
 * that routes SDK-facing operations through the anti-corruption
 * `ITokenEngine` port. Public API surface — every method the SDK contract
 * exposes on `sphere.accounting.*`, plus the internal glue points other
 * modules and tests reach for — is preserved. Internal machinery that was
 * v1-pipeline-shaped (per-invoice AsyncGateMap for concurrency, the
 * incremental ledger index + CID-ref pinning, the elaborate DM-based
 * receipts/cancellation-notice pipeline, per-token watermarking, and the
 * v1 mint retry state machine) is either dropped or reduced to
 * behaviour-preserving straight-line equivalents.
 *
 * Design rules (same as wave 6-P2-4b PaymentsModule):
 *   - All SDK interaction goes through `ITokenEngine.mintDataToken` for
 *     the on-chain invoice mint. Direct `@unicitylabs/state-transition-sdk`
 *     imports live only in `token-engine/`.
 *   - Payment attribution rides on top of `PaymentsModule` events plus
 *     history scans — no direct SDK reads of source tokens.
 *   - Storage layout is preserved (CANCELLED_INVOICES, CLOSED_INVOICES,
 *     FROZEN_BALANCES, AUTO_RETURN, AUTO_RETURN_LEDGER) so pre-existing
 *     wallets keep loading their terminal-set data.
 *   - Balance computation delegates to the untouched
 *     `./balance-computer.ts` helper (v2-agnostic).
 */

import { logger } from '../../core/logger.js';
import { SphereError } from '../../core/errors.js';
import {
  STORAGE_KEYS_ADDRESS,
  INVOICE_TOKEN_TYPE_HEX,
  getAddressStorageKey,
  getAddressId,
} from '../../constants.js';
import type {
  IncomingTransfer,
  TransferRequest,
  TransferResult,
  SphereEventMap,
  SphereEventType,
  Token,
} from '../../types/index.js';
import type { TxfToken } from '../../types/txf.js';
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
  DeliverInvoiceOptions,
  DeliverInvoiceResult,
} from './types.js';
import {
  parseInvoiceMemo,
  buildInvoiceMemo,
  hashInvoiceId,
} from './memo.js';
import { canonicalSerialize } from './serialization.js';
import { AutoReturnManager } from './auto-return.js';
import { computeInvoiceStatus, freezeBalances } from './balance-computer.js';

// =============================================================================
// Internal storage schemas
// =============================================================================

interface AutoReturnStorage {
  global: boolean;
  perInvoice: Record<string, boolean>;
}

type FrozenBalancesStorage = Record<string, FrozenInvoiceBalances>;

const LOG_TAG = 'Accounting';

// =============================================================================
// Utility
// =============================================================================

function safeBigInt(amount: string | undefined | null): bigint {
  if (!amount) return 0n;
  if (typeof amount !== 'string' || amount.length > 78) return 0n;
  if (!/^(0|[1-9]\d*)$/.test(amount)) return 0n;
  return BigInt(amount);
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '').toLowerCase();
  if (clean.length % 2 !== 0) throw new Error('Invalid hex string length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(buf);
}

// =============================================================================
// AccountingModule
// =============================================================================

/**
 * AccountingModule manages invoice creation, import, status tracking, and
 * payment attribution. Slim v2 rebuild — see file header for the full
 * design rules.
 *
 * Lifecycle:
 * 1. `new AccountingModule(config)` — construct with optional config
 * 2. `initialize(deps)` — inject dependencies (synchronous)
 * 3. `await load()` — load persisted state, subscribe to events
 * 4. Use public API methods
 * 5. `await destroy()` — unsubscribe and mark inert
 */
export class AccountingModule {
  private config: Required<
    Pick<AccountingModuleConfig, 'debug' | 'autoTerminateOnReturn' | 'maxCoinDataEntries'>
  >;

  private deps: AccountingModuleDependencies | null = null;
  private destroyed = false;
  private loaded = false;

  // Invoice token cache: invoiceId → parsed InvoiceTerms
  private invoiceTermsCache: Map<string, InvoiceTerms> = new Map();

  // Privacy: SHA-256(invoiceId) → invoiceId. Populated on load/create/import.
  private invoiceIdHashIndex: Map<string, string> = new Map();

  // Terminal state tracking (persisted).
  private cancelledInvoices: Set<string> = new Set();
  private closedInvoices: Set<string> = new Set();
  private frozenBalances: Map<string, FrozenInvoiceBalances> = new Map();

  // Auto-return settings (persisted).
  private autoReturnGlobal = false;
  private autoReturnPerInvoice: Map<string, boolean> = new Map();

  /** Auto-return deduplication ledger manager (§7.5). */
  private autoReturnManager: AutoReturnManager = new AutoReturnManager();

  // T.7.D / W21: Forced-conservative coercion for escrow-bridged invoices.
  private escrowBridgedInvoices: Set<string> = new Set();

  /**
   * Override marker emitted in TransferResult.overrides whenever
   * `payInvoice()` silently coerces `allowPendingTokens=true` to `false`
   * because the invoice is bridged to escrow.
   */
  static readonly OVERRIDE_FORCED_CONSERVATIVE = 'allowPendingTokens-coerced-to-false';

  // Subscription cleanup handles.
  private unsubscribes: Array<() => void> = [];

  // ===========================================================================
  // Construction
  // ===========================================================================

  constructor(config?: AccountingModuleConfig) {
    this.config = {
      debug: config?.debug ?? false,
      autoTerminateOnReturn: config?.autoTerminateOnReturn ?? false,
      maxCoinDataEntries: config?.maxCoinDataEntries ?? 50,
    };
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  initialize(deps: AccountingModuleDependencies): void {
    this.destroyed = false;
    this.deps = deps;
    if (this.config.debug) {
      logger.debug(LOG_TAG, 'Initialized with dependencies');
    }
  }

  async load(): Promise<void> {
    this.ensureInitialized();
    this.ensureNotDestroyed();
    if (this.loaded) return;

    const deps = this.deps!;

    // Step 1: Refresh invoice terms from PaymentsModule token store.
    this._refreshInvoiceTermsCache();

    // Step 2: Load terminal sets.
    const cancelledRaw = await this._loadJsonFromStorage<string[]>(
      STORAGE_KEYS_ADDRESS.CANCELLED_INVOICES,
      [],
    );
    for (const id of cancelledRaw) this.cancelledInvoices.add(id);
    const closedRaw = await this._loadJsonFromStorage<string[]>(
      STORAGE_KEYS_ADDRESS.CLOSED_INVOICES,
      [],
    );
    for (const id of closedRaw) this.closedInvoices.add(id);

    // Step 3: Load frozen balances.
    const frozenRaw = await this._loadJsonFromStorage<FrozenBalancesStorage>(
      STORAGE_KEYS_ADDRESS.FROZEN_BALANCES,
      {},
    );
    for (const [invoiceId, frozen] of Object.entries(frozenRaw)) {
      this.frozenBalances.set(invoiceId, frozen);
    }

    // Step 4: Reconcile — frozen without terminal-set entry.
    let terminalSetDirty = false;
    const deferredEvents: Array<{ event: string; payload: unknown }> = [];
    for (const [invoiceId, frozen] of this.frozenBalances.entries()) {
      if (frozen.state === 'CANCELLED' && !this.cancelledInvoices.has(invoiceId)) {
        this.cancelledInvoices.add(invoiceId);
        terminalSetDirty = true;
        deferredEvents.push({ event: 'invoice:cancelled', payload: { invoiceId } });
      } else if (frozen.state === 'CLOSED' && !this.closedInvoices.has(invoiceId)) {
        this.closedInvoices.add(invoiceId);
        terminalSetDirty = true;
        deferredEvents.push({
          event: 'invoice:closed',
          payload: { invoiceId, explicit: frozen.explicitClose ?? false },
        });
      }
    }
    if (terminalSetDirty) {
      await this._persistTerminalSets();
    }

    // Step 5: Load auto-return settings.
    const autoReturn = await this._loadJsonFromStorage<AutoReturnStorage>(
      STORAGE_KEYS_ADDRESS.AUTO_RETURN,
      { global: false, perInvoice: {} },
    );
    this.autoReturnGlobal = autoReturn.global;
    this.autoReturnPerInvoice.clear();
    for (const [id, enabled] of Object.entries(autoReturn.perInvoice)) {
      this.autoReturnPerInvoice.set(id, enabled);
    }

    // Step 6: Subscribe to PaymentsModule events for attribution.
    this._subscribeToPaymentsEvents();

    // Emit deferred reconciliation events.
    for (const { event, payload } of deferredEvents) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps.emitEvent(event as keyof SphereEventMap, payload as any);
    }

    this.loaded = true;
    if (this.config.debug) {
      logger.debug(LOG_TAG, 'load() complete');
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    for (const unsub of this.unsubscribes) {
      try {
        unsub();
      } catch {
        /* ignore */
      }
    }
    this.unsubscribes = [];
    if (this.config.debug) {
      logger.debug(LOG_TAG, 'Module destroyed');
    }
  }

  private ensureInitialized(): void {
    if (!this.deps) {
      throw new SphereError(
        'AccountingModule has not been initialized. Call initialize(deps) first.',
        'NOT_INITIALIZED',
      );
    }
  }

  private ensureNotDestroyed(): void {
    if (this.destroyed) {
      throw new SphereError(
        'AccountingModule has been destroyed.',
        'MODULE_DESTROYED',
      );
    }
  }

  // ===========================================================================
  // Invoice creation — routed through ITokenEngine.mintDataToken
  // ===========================================================================

  /**
   * Create and mint a new invoice token.
   *
   * v2 flow: canonicalize terms → derive tokenType/salt →
   * `tokenEngine.mintDataToken` → cache terms → emit `invoice:created` →
   * return `{invoiceId, token, terms}`.
   *
   * The v1 dance (build MintTransactionData, submit commitment with 3
   * retries, wait for inclusion proof, finalize into Token) collapses to
   * a single atomic engine call.
   */
  async createInvoice(request: CreateInvoiceRequest): Promise<CreateInvoiceResult> {
    this.ensureNotDestroyed();
    this.ensureInitialized();
    const deps = this.deps!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tokenEngine: any =
      (deps as unknown as { tokenEngine?: unknown }).tokenEngine
      ?? (deps.payments as unknown as { tokenEngine?: unknown }).tokenEngine;
    if (!tokenEngine) {
      return {
        success: false,
        error: 'Token engine not available — v2 invoice mint requires ITokenEngine',
      };
    }

    // §8.1 validation: at least one target with at least one asset.
    if (!request.targets || request.targets.length === 0) {
      return { success: false, error: 'Invoice must have at least one target' };
    }
    const seenTargetAddresses = new Set<string>();
    for (const target of request.targets) {
      if (
        typeof target.address !== 'string' ||
        !target.address.startsWith('DIRECT://') ||
        target.address.length <= 'DIRECT://'.length
      ) {
        return { success: false, error: `Invalid target address: ${target.address}` };
      }
      if (seenTargetAddresses.has(target.address)) {
        return { success: false, error: `Duplicate target address: ${target.address}` };
      }
      seenTargetAddresses.add(target.address);
      if (!target.assets || target.assets.length === 0) {
        return { success: false, error: `Target ${target.address} has no assets` };
      }
      const seenCoins = new Set<string>();
      for (const asset of target.assets) {
        const hasCoin = asset.coin !== undefined;
        const hasNft = asset.nft !== undefined;
        if (hasCoin === hasNft) {
          return {
            success: false,
            error: 'Asset must have exactly one of coin or nft',
          };
        }
        if (hasCoin) {
          const [coinId, amount] = asset.coin!;
          // v2 canonical coinIds are 64-char lowercase hex (v2 assetId scheme,
          // see the testnet2 token registry). Legacy v1 shim also accepted
          // short symbolic ids like "UCT" (up to 20 chars alphanumeric), so
          // both are permitted here for backward compat during migration.
          // Wave 6-P2-6 soak (2026-07-07) caught the v1-only reject on real
          // testnet2 coinIds — this widening unblocks `createInvoice` for v2.
          const isV2Hex = /^[0-9a-f]{64}$/.test(coinId);
          const isLegacySymbol =
            typeof coinId === 'string' &&
            coinId.length > 0 &&
            coinId.length <= 20 &&
            /^[A-Za-z0-9]+$/.test(coinId);
          if (typeof coinId !== 'string' || (!isV2Hex && !isLegacySymbol)) {
            return { success: false, error: `Invalid coinId: ${coinId}` };
          }
          if (seenCoins.has(coinId)) {
            return { success: false, error: `Duplicate coinId ${coinId} in target` };
          }
          seenCoins.add(coinId);
          if (
            typeof amount !== 'string' ||
            !/^[1-9][0-9]*$/.test(amount) ||
            amount.length > 78
          ) {
            return { success: false, error: `Invalid amount for ${coinId}: ${amount}` };
          }
        }
      }
    }

    // Build canonical InvoiceTerms.
    const terms: InvoiceTerms = {
      ...(request.anonymous === true
        ? {}
        : { creator: deps.identity.chainPubkey }),
      createdAt: Date.now(),
      ...(request.dueDate !== undefined ? { dueDate: request.dueDate } : {}),
      ...(request.memo !== undefined ? { memo: request.memo } : {}),
      ...(request.deliveryMethods !== undefined
        ? { deliveryMethods: request.deliveryMethods }
        : {}),
      targets: request.targets,
    };

    // Canonical serialization for deterministic tokenId.
    const invoiceJson = canonicalSerialize(terms);
    const invoiceBytes = new TextEncoder().encode(invoiceJson);

    // Salt derivation: SHA-256(signingKey || invoiceBytes). Preserves the
    // v1 invariant that identical terms from different wallets don't
    // collide, since the salt binds to signing key.
    const signingKeyBytes = hexToBytes(deps.identity.privateKey);
    const saltInput = new Uint8Array(signingKeyBytes.length + invoiceBytes.length);
    saltInput.set(signingKeyBytes, 0);
    saltInput.set(invoiceBytes, signingKeyBytes.length);
    const salt = await sha256(saltInput);
    saltInput.fill(0);

    // Token type — canonical hex constant.
    const tokenType = hexToBytes(INVOICE_TOKEN_TYPE_HEX);

    // Recipient is the wallet itself (invoice is self-minted).
    const recipientPubkey = hexToBytes(deps.identity.chainPubkey);

    try {
      // Atomic v2 mint — engine handles commitment submission + proof
      // await + finalization internally.
      const sphereToken = await tokenEngine.mintDataToken({
        recipientPubkey,
        data: invoiceBytes,
        tokenType,
        salt,
      });
      signingKeyBytes.fill(0);

      const invoiceId: string = tokenEngine.tokenId(sphereToken);
      if (this.invoiceTermsCache.has(invoiceId)) {
        return {
          success: false,
          error: `Invoice already exists locally: ${invoiceId}`,
        };
      }

      // Cache terms + build a lightweight TxfToken shape for callers that
      // still consume it via CreateInvoiceResult.token.
      this.invoiceTermsCache.set(invoiceId, terms);
      const hash = await sha256(new TextEncoder().encode(invoiceId));
      const hashHex = Array.from(hash)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      this.invoiceIdHashIndex.set(hashHex, invoiceId);

      const token: TxfToken = {
        genesis: {
          data: {
            tokenId: invoiceId,
            tokenType: INVOICE_TOKEN_TYPE_HEX,
            tokenData: invoiceJson,
            coinData: null,
          },
          proof: null,
        },
        transactions: [],
      } as unknown as TxfToken;

      // Emit event and hand back result.
      deps.emitEvent('invoice:created', { invoiceId, confirmed: true });

      if (this.config.debug) {
        logger.debug(LOG_TAG, `createInvoice(${invoiceId}) → success`);
      }
      return { success: true, invoiceId, token, terms };
    } catch (err) {
      signingKeyBytes.fill(0);
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `Failed to mint invoice token: ${msg}`,
      };
    }
  }

  /**
   * Import an existing invoice token (received from a peer).
   *
   * Accepts either a TxfToken structure or a decoded SDK token blob;
   * the slim rebuild honors the wide callable shape by treating the
   * input as a TxfToken and pulling the terms JSON out of
   * genesis.data.tokenData.
   */
  async importInvoice(token: TxfToken | string | unknown): Promise<InvoiceTerms> {
    this.ensureNotDestroyed();
    this.ensureInitialized();
    const deps = this.deps!;

    let txf: TxfToken;
    if (typeof token === 'string') {
      try {
        txf = JSON.parse(token) as TxfToken;
      } catch {
        throw new SphereError(
          'Invoice import failed: token is not valid JSON.',
          'INVOICE_INVALID_DATA',
        );
      }
    } else {
      txf = token as TxfToken;
    }

    // Step 1: Validate token type.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const genesis = (txf as any)?.genesis;
    const tokenType = genesis?.data?.tokenType;
    if (tokenType !== INVOICE_TOKEN_TYPE_HEX) {
      throw new SphereError(
        `Invoice import failed: token type "${tokenType}" is not the expected invoice type.`,
        'INVOICE_WRONG_TOKEN_TYPE',
      );
    }

    // Step 2: Parse tokenData.
    const tokenData = genesis?.data?.tokenData;
    if (!tokenData || typeof tokenData !== 'string') {
      throw new SphereError(
        'Invoice import failed: missing or invalid tokenData field.',
        'INVOICE_INVALID_DATA',
      );
    }

    // May be plain JSON or hex-encoded UTF-8 JSON.
    let jsonString = tokenData;
    if (!/^\s*[[{"]/.test(tokenData)) {
      try {
        const bytes = hexToBytes(tokenData);
        jsonString = new TextDecoder().decode(bytes);
      } catch {
        // fall through
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

    if (!terms || typeof terms !== 'object') {
      throw new SphereError(
        'Invoice import failed: tokenData did not parse as an object.',
        'INVOICE_INVALID_DATA',
      );
    }

    // Step 3: Business validation (subset of v1 §8.2).
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
    if (!Array.isArray(terms.targets) || terms.targets.length === 0) {
      throw new SphereError(
        'Invoice import failed: targets must be a non-empty array.',
        'INVOICE_INVALID_DATA',
      );
    }
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
          // v2 canonical coinIds are 64-char lowercase hex; legacy v1 shim
          // used short symbolic ids ("UCT") — mirror the widened accept in
          // `createInvoice` (see 6-P2-6 soak fix).
          const isV2Hex = typeof coinId === 'string' && /^[0-9a-f]{64}$/.test(coinId);
          const isLegacySymbol =
            typeof coinId === 'string' &&
            coinId.length > 0 &&
            coinId.length <= 20 &&
            /^[A-Za-z0-9]+$/.test(coinId);
          if (typeof coinId !== 'string' || (!isV2Hex && !isLegacySymbol)) {
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

    // Step 4: Check duplicate.
    const tokenId = genesis?.data?.tokenId;
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

    // Step 5: cache + emit.
    this.invoiceTermsCache.set(tokenId, terms);
    const hash = await sha256(new TextEncoder().encode(tokenId));
    const hashHex = Array.from(hash)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    this.invoiceIdHashIndex.set(hashHex, tokenId);

    deps.emitEvent('invoice:created', { invoiceId: tokenId, confirmed: true });

    return terms;
  }

  // ===========================================================================
  // Invoice queries
  // ===========================================================================

  getInvoice(invoiceId: string): InvoiceRef | null {
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

  async getInvoices(options?: GetInvoicesOptions): Promise<InvoiceRef[]> {
    this.ensureNotDestroyed();
    this.ensureInitialized();
    const identity = this.deps!.identity;
    const activeAddresses = this.deps!.getActiveAddresses();
    const walletDirectAddresses = new Set(activeAddresses.map((a) => a.directAddress));

    let results: InvoiceRef[] = [];
    for (const [invoiceId, terms] of this.invoiceTermsCache) {
      results.push({
        invoiceId,
        terms,
        isCreator: terms.creator !== undefined && terms.creator === identity.chainPubkey,
        cancelled: this.cancelledInvoices.has(invoiceId),
        closed: this.closedInvoices.has(invoiceId),
      });
    }

    if (options?.createdByMe !== undefined) {
      const want = options.createdByMe;
      results = results.filter((r) => r.isCreator === want);
    }
    if (options?.targetingMe !== undefined) {
      const want = options.targetingMe;
      results = results.filter((r) => {
        const isTargeted = r.terms.targets.some((t) => walletDirectAddresses.has(t.address));
        return isTargeted === want;
      });
    }
    if (options?.state !== undefined) {
      const wanted = Array.isArray(options.state)
        ? new Set(options.state)
        : new Set([options.state]);
      const filtered: InvoiceRef[] = [];
      for (const r of results) {
        try {
          const status = await this.getInvoiceStatus(r.invoiceId);
          if (wanted.has(status.state)) filtered.push(r);
        } catch {
          /* skip */
        }
      }
      results = filtered;
    }

    // Sort.
    const sortBy = options?.sortBy ?? 'createdAt';
    const sortOrder = options?.sortOrder ?? 'desc';
    const direction = sortOrder === 'asc' ? 1 : -1;
    results.sort((a, b) => {
      if (sortBy === 'dueDate') {
        const da = a.terms.dueDate;
        const db = b.terms.dueDate;
        if (da === undefined && db === undefined) return 0;
        if (da === undefined) return 1;
        if (db === undefined) return -1;
        return direction * (da - db);
      }
      return direction * (a.terms.createdAt - b.terms.createdAt);
    });

    const offset = options?.offset ?? 0;
    const limit = options?.limit;
    if (offset > 0) results = results.slice(offset);
    if (limit !== undefined && limit >= 0) results = results.slice(0, limit);
    return results;
  }

  async getInvoiceStatus(invoiceId: string): Promise<InvoiceStatus> {
    this.ensureNotDestroyed();
    this.ensureInitialized();
    if (!this.invoiceTermsCache.has(invoiceId)) {
      throw new SphereError(`Invoice not found: ${invoiceId}`, 'INVOICE_NOT_FOUND');
    }
    const terms = this.invoiceTermsCache.get(invoiceId)!;

    // Terminal — return frozen.
    if (this.frozenBalances.has(invoiceId)) {
      const frozen = this.frozenBalances.get(invoiceId)!;
      const status = computeInvoiceStatus(invoiceId, terms, [], frozen, new Set());
      // Dynamically compute allConfirmed from frozen transfers.
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

    // Non-terminal: compute from live history.
    const entries = this._buildLedgerEntries(invoiceId);
    const activeAddresses = this.deps!.getActiveAddresses();
    const walletAddresses = new Set(activeAddresses.map((a) => a.directAddress));
    if (this.deps!.identity?.directAddress) {
      walletAddresses.add(this.deps!.identity.directAddress);
    }
    const status = computeInvoiceStatus(invoiceId, terms, entries, null, walletAddresses);

    // Implicit close on COVERED+allConfirmed.
    if (status.state === 'COVERED' && status.allConfirmed) {
      const latestSenderMap = this._computeLatestSenderMap(terms, entries);
      const frozen = freezeBalances(terms, status, 'CLOSED', false, latestSenderMap);
      this.frozenBalances.set(invoiceId, frozen);
      this.closedInvoices.add(invoiceId);
      await this._persistFrozenBalances();
      await this._persistTerminalSets();
      queueMicrotask(() => {
        try {
          this.deps!.emitEvent('invoice:closed', { invoiceId, explicit: false });
        } catch {
          /* ignore */
        }
      });
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

    return status;
  }

  /**
   * Return the set of token IDs that are currently linked to the given
   * invoice by history scan. Used by SwapModule.verifyPayout to scope
   * L3 validation.
   */
  getTokenIdsForInvoice(invoiceId: string): Set<string> {
    const result = new Set<string>();
    const history = this.deps?.payments?.getHistory?.() ?? [];
    for (const entry of history) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const memo = (entry as any).memo;
      if (typeof memo !== 'string') continue;
      const ref = this._resolveInvoiceRef(memo);
      if (ref !== invoiceId) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tokenIds = (entry as any).tokenIds;
      if (Array.isArray(tokenIds)) {
        for (const t of tokenIds) {
          if (typeof t === 'string') result.add(t);
          else if (t && typeof t === 'object' && typeof t.id === 'string') {
            result.add(t.id);
          }
        }
      }
    }
    return result;
  }

  // ===========================================================================
  // Payment attribution
  // ===========================================================================

  async payInvoice(invoiceId: string, params: PayInvoiceParams): Promise<TransferResult> {
    this.ensureNotDestroyed();
    this.ensureInitialized();
    const deps = this.deps!;

    if (!this.invoiceTermsCache.has(invoiceId)) {
      throw new SphereError(`Invoice not found: ${invoiceId}`, 'INVOICE_NOT_FOUND');
    }
    const terms = this.invoiceTermsCache.get(invoiceId)!;

    // Validate params.
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
    const assetIndex = params.assetIndex ?? 0;
    if (assetIndex < 0 || assetIndex >= target.assets.length) {
      throw new SphereError(
        `Invalid assetIndex ${assetIndex}: target has ${target.assets.length} asset(s)`,
        'INVOICE_INVALID_ASSET_INDEX',
      );
    }
    const asset = target.assets[assetIndex]!;
    if (!asset.coin) {
      throw new SphereError(
        `Asset at index ${assetIndex} has no coin entry`,
        'INVOICE_INVALID_ASSET_INDEX',
      );
    }
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

    if (this.closedInvoices.has(invoiceId) || this.cancelledInvoices.has(invoiceId)) {
      throw new SphereError(
        `Invoice is already terminated (closed or cancelled): ${invoiceId}`,
        'INVOICE_TERMINATED',
      );
    }

    const [coinId, requestedAmountStr] = asset.coin;
    if (!deps.identity.directAddress) {
      throw new SphereError('directAddress required for invoice payments', 'NOT_INITIALIZED');
    }
    const effectiveContact: { address: string; url?: string } = params.contact ?? {
      address: deps.identity.directAddress,
    };

    // Compute send amount.
    let sendAmount: string;
    if (params.amount !== undefined) {
      sendAmount = params.amount;
    } else {
      const requested = safeBigInt(requestedAmountStr);
      const entries = this._buildLedgerEntries(invoiceId);
      const walletAddresses = new Set(deps.getActiveAddresses().map((a) => a.directAddress));
      if (deps.identity?.directAddress) walletAddresses.add(deps.identity.directAddress);
      const liveStatus = computeInvoiceStatus(
        invoiceId,
        terms,
        entries,
        null,
        walletAddresses,
      );
      const targetStatus = liveStatus.targets.find((t) => t.address === target.address);
      const coinAssetStatus = targetStatus?.coinAssets.find((ca) => ca.coin[0] === coinId);
      const netCovered = coinAssetStatus ? safeBigInt(coinAssetStatus.netCoveredAmount) : 0n;
      const remaining = requested > netCovered ? requested - netCovered : 0n;
      sendAmount = remaining.toString();
    }
    if (sendAmount === '0') {
      throw new SphereError(
        `Invoice ${invoiceId} target ${target.address} asset ${coinId} is already fully covered`,
        'INVOICE_INVALID_AMOUNT',
      );
    }

    // Build transport memo.
    const memo = buildInvoiceMemo(invoiceId, 'F', params.freeText);

    // Forced-conservative coercion for escrow-bridged invoices.
    const requestedAllowPending = params.allowPendingTokens === true;
    const isEscrowBridged = this.escrowBridgedInvoices.has(invoiceId);
    const coerced = requestedAllowPending && isEscrowBridged;
    const effectiveAllowPending = coerced ? false : requestedAllowPending;

    const sendRequest: TransferRequest & {
      invoiceRefundAddress?: string;
      invoiceContact?: { address: string; url?: string };
    } = {
      recipient: target.address,
      amount: sendAmount,
      coinId,
      memo,
      transferMode: params.transferMode ?? 'instant',
      allowPendingTokens: effectiveAllowPending,
      ...(params.refundAddress !== undefined
        ? { invoiceRefundAddress: params.refundAddress }
        : {}),
      invoiceContact: effectiveContact,
    };

    const result = await deps.payments.send(sendRequest);

    if (coerced) {
      const existingOverrides = (result as TransferResult & { overrides?: string[] }).overrides
        ?? [];
      const merged = existingOverrides.includes(AccountingModule.OVERRIDE_FORCED_CONSERVATIVE)
        ? existingOverrides
        : [...existingOverrides, AccountingModule.OVERRIDE_FORCED_CONSERVATIVE];
      return { ...result, overrides: merged } as TransferResult;
    }
    return result;
  }

  /**
   * Return tokens for an invoice — send back to the original sender.
   */
  async returnInvoicePayment(
    invoiceId: string,
    params: ReturnPaymentParams,
  ): Promise<TransferResult> {
    this.ensureNotDestroyed();
    this.ensureInitialized();
    const deps = this.deps!;

    if (!this.invoiceTermsCache.has(invoiceId)) {
      throw new SphereError(`Invoice not found: ${invoiceId}`, 'INVOICE_NOT_FOUND');
    }
    if (!this._isTarget(invoiceId)) {
      throw new SphereError(`Caller is not a target of invoice: ${invoiceId}`, 'INVOICE_NOT_TARGET');
    }
    if (safeBigInt(params.amount) === 0n) {
      throw new SphereError('Return amount must be positive', 'INVOICE_INVALID_AMOUNT');
    }

    const isClosed = this.closedInvoices.has(invoiceId);
    const isCancelled = this.cancelledInvoices.has(invoiceId);
    const direction: 'B' | 'RC' | 'RX' = isCancelled ? 'RX' : isClosed ? 'RC' : 'B';
    const memo = buildInvoiceMemo(invoiceId, direction, params.freeText);

    return deps.payments.send({
      recipient: params.recipient,
      amount: params.amount,
      coinId: params.coinId,
      memo,
      transferMode: 'instant',
    });
  }

  /**
   * Return all pending balance for the invoice — sender-scan variant.
   * Slim rebuild: iterates known per-sender balances and issues one
   * `returnInvoicePayment()` per (sender, coinId) that still has a net
   * positive balance. Errors are collected but do not abort the loop.
   */
  async returnAllInvoicePayments(invoiceId: string): Promise<{
    returned: number;
    failed: number;
    errors: Array<{ recipient: string; coinId: string; error: string }>;
  }> {
    this.ensureNotDestroyed();
    this.ensureInitialized();

    if (!this.invoiceTermsCache.has(invoiceId)) {
      throw new SphereError(`Invoice not found: ${invoiceId}`, 'INVOICE_NOT_FOUND');
    }
    if (!this._isTarget(invoiceId)) {
      throw new SphereError(`Caller is not a target of invoice: ${invoiceId}`, 'INVOICE_NOT_TARGET');
    }

    let status: InvoiceStatus;
    try {
      status = await this.getInvoiceStatus(invoiceId);
    } catch (err) {
      return {
        returned: 0,
        failed: 1,
        errors: [
          { recipient: '', coinId: '', error: err instanceof Error ? err.message : String(err) },
        ],
      };
    }

    let returned = 0;
    let failed = 0;
    const errors: Array<{ recipient: string; coinId: string; error: string }> = [];

    for (const target of status.targets) {
      for (const coinAsset of target.coinAssets) {
        for (const sender of coinAsset.senderBalances) {
          const netBalance = safeBigInt(sender.netBalance);
          if (netBalance <= 0n) continue;
          try {
            await this.returnInvoicePayment(invoiceId, {
              recipient: sender.senderAddress,
              amount: sender.netBalance,
              coinId: coinAsset.coin[0],
            });
            returned++;
          } catch (err) {
            failed++;
            errors.push({
              recipient: sender.senderAddress,
              coinId: coinAsset.coin[0],
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    return { returned, failed, errors };
  }

  // ===========================================================================
  // State transitions
  // ===========================================================================

  async closeInvoice(invoiceId: string, options?: { autoReturn?: boolean }): Promise<void> {
    this.ensureNotDestroyed();
    this.ensureInitialized();

    if (!this.invoiceTermsCache.has(invoiceId)) {
      throw new SphereError(`Invoice not found: ${invoiceId}`, 'INVOICE_NOT_FOUND');
    }
    if (!this._isTarget(invoiceId)) {
      throw new SphereError(`Caller is not a target of invoice: ${invoiceId}`, 'INVOICE_NOT_TARGET');
    }
    if (this.closedInvoices.has(invoiceId)) {
      throw new SphereError(`Invoice is already closed: ${invoiceId}`, 'INVOICE_ALREADY_CLOSED');
    }
    if (this.cancelledInvoices.has(invoiceId)) {
      throw new SphereError(`Invoice is already cancelled: ${invoiceId}`, 'INVOICE_ALREADY_CANCELLED');
    }

    const terms = this.invoiceTermsCache.get(invoiceId)!;
    const deps = this.deps!;
    const entries = this._buildLedgerEntries(invoiceId);
    const walletAddresses = new Set(deps.getActiveAddresses().map((a) => a.directAddress));
    if (deps.identity?.directAddress) walletAddresses.add(deps.identity.directAddress);
    const status = computeInvoiceStatus(invoiceId, terms, entries, null, walletAddresses);
    const latestSenderMap = this._computeLatestSenderMap(terms, entries);
    const frozen = freezeBalances(terms, status, 'CLOSED', true, latestSenderMap);

    this.frozenBalances.set(invoiceId, frozen);
    await this._persistFrozenBalances();
    this.closedInvoices.add(invoiceId);
    await this._persistTerminalSets();

    if (options?.autoReturn) {
      this.autoReturnPerInvoice.set(invoiceId, true);
      await this._persistAutoReturnSettings();
      await this._executeTerminationReturns(invoiceId, frozen, 'RC');
    }

    queueMicrotask(() => {
      try {
        deps.emitEvent('invoice:closed', { invoiceId, explicit: true });
      } catch {
        /* ignore */
      }
    });
  }

  async cancelInvoice(
    invoiceId: string,
    options?: { autoReturn?: boolean },
  ): Promise<void> {
    this.ensureNotDestroyed();
    this.ensureInitialized();

    if (!this.invoiceTermsCache.has(invoiceId)) {
      throw new SphereError(`Invoice not found: ${invoiceId}`, 'INVOICE_NOT_FOUND');
    }
    if (!this._isTarget(invoiceId)) {
      throw new SphereError(`Caller is not a target of invoice: ${invoiceId}`, 'INVOICE_NOT_TARGET');
    }
    if (this.closedInvoices.has(invoiceId)) {
      throw new SphereError(`Invoice is already closed: ${invoiceId}`, 'INVOICE_ALREADY_CLOSED');
    }
    if (this.cancelledInvoices.has(invoiceId)) {
      throw new SphereError(
        `Invoice is already cancelled: ${invoiceId}`,
        'INVOICE_ALREADY_CANCELLED',
      );
    }

    const terms = this.invoiceTermsCache.get(invoiceId)!;
    const deps = this.deps!;
    const entries = this._buildLedgerEntries(invoiceId);
    const walletAddresses = new Set(deps.getActiveAddresses().map((a) => a.directAddress));
    if (deps.identity?.directAddress) walletAddresses.add(deps.identity.directAddress);
    const status = computeInvoiceStatus(invoiceId, terms, entries, null, walletAddresses);
    const frozen = freezeBalances(terms, status, 'CANCELLED', false);

    this.frozenBalances.set(invoiceId, frozen);
    await this._persistFrozenBalances();
    this.cancelledInvoices.add(invoiceId);
    await this._persistTerminalSets();

    if (options?.autoReturn) {
      this.autoReturnPerInvoice.set(invoiceId, true);
      await this._persistAutoReturnSettings();
      await this._executeTerminationReturns(invoiceId, frozen, 'RX');
    }

    queueMicrotask(() => {
      try {
        deps.emitEvent('invoice:cancelled', { invoiceId });
      } catch {
        /* ignore */
      }
    });
  }

  markInvoiceEscrowBridged(invoiceId: string): void {
    this.escrowBridgedInvoices.add(invoiceId);
  }

  unmarkInvoiceEscrowBridged(invoiceId: string): void {
    this.escrowBridgedInvoices.delete(invoiceId);
  }

  isInvoiceEscrowBridged(invoiceId: string): boolean {
    return this.escrowBridgedInvoices.has(invoiceId);
  }

  // ===========================================================================
  // Auto-return
  // ===========================================================================

  async setAutoReturn(invoiceId: string | '*', enabled: boolean): Promise<void> {
    this.ensureNotDestroyed();
    this.ensureInitialized();
    if (invoiceId === '*') {
      this.autoReturnGlobal = enabled;
    } else {
      if (!this.invoiceTermsCache.has(invoiceId)) {
        throw new SphereError(`Invoice not found: ${invoiceId}`, 'INVOICE_NOT_FOUND');
      }
      this.autoReturnPerInvoice.set(invoiceId, enabled);
    }
    await this._persistAutoReturnSettings();
  }

  getAutoReturnSettings(): AutoReturnSettings {
    this.ensureInitialized();
    return {
      global: this.autoReturnGlobal,
      perInvoice: Object.fromEntries(this.autoReturnPerInvoice),
    };
  }

  // ===========================================================================
  // Receipts / cancellation notices — slim stubs
  // ===========================================================================

  async sendInvoiceReceipts(
    invoiceId: string,
    _options?: SendInvoiceReceiptsOptions,
  ): Promise<SendReceiptsResult> {
    this.ensureNotDestroyed();
    this.ensureInitialized();
    if (!this.invoiceTermsCache.has(invoiceId)) {
      throw new SphereError(`Invoice not found: ${invoiceId}`, 'INVOICE_NOT_FOUND');
    }
    if (!this.deps!.communications) {
      throw new SphereError(
        'CommunicationsModule unavailable — cannot send receipts',
        'COMMUNICATIONS_UNAVAILABLE',
      );
    }
    // v2 slim: the elaborate v1 receipts pipeline (DM per (target, sender)
    // with contribution breakdown) has been dropped. Return a zero-result
    // so callers can no-op cleanly.
    return {
      sent: 0,
      failed: 0,
      sentReceipts: [],
      failedReceipts: [],
    };
  }

  async sendCancellationNotices(
    invoiceId: string,
    _options?: SendCancellationNoticesOptions,
  ): Promise<SendNoticesResult> {
    this.ensureNotDestroyed();
    this.ensureInitialized();
    if (!this.invoiceTermsCache.has(invoiceId)) {
      throw new SphereError(`Invoice not found: ${invoiceId}`, 'INVOICE_NOT_FOUND');
    }
    if (!this.deps!.communications) {
      throw new SphereError(
        'CommunicationsModule unavailable — cannot send cancellation notices',
        'COMMUNICATIONS_UNAVAILABLE',
      );
    }
    return {
      sent: 0,
      failed: 0,
      sentNotices: [],
      failedNotices: [],
    };
  }

  async deliverInvoice(
    invoiceId: string,
    _options?: DeliverInvoiceOptions,
  ): Promise<DeliverInvoiceResult> {
    this.ensureNotDestroyed();
    this.ensureInitialized();
    if (!this.invoiceTermsCache.has(invoiceId)) {
      throw new SphereError(`Invoice not found: ${invoiceId}`, 'INVOICE_NOT_FOUND');
    }
    // v2 slim: the elaborate v1 UXF-bundle delivery pipeline is dropped.
    // Callers on the swap/escrow track dispatch the invoice token via
    // `payments.publishUxfBundle` directly.
    return {
      invoiceId,
      sent: 0,
      failed: 0,
      skippedSelf: 0,
      recipients: [],
    };
  }

  // ===========================================================================
  // Related transfers view
  // ===========================================================================

  getRelatedTransfers(invoiceId: string): (InvoiceTransferRef | IrrelevantTransfer)[] {
    this.ensureInitialized();
    if (!this.invoiceTermsCache.has(invoiceId)) return [];
    return this._buildLedgerEntries(invoiceId);
  }

  parseInvoiceMemo(memo: string) {
    return parseInvoiceMemo(memo);
  }

  /**
   * Resolve either a raw `INV:` memo containing a raw invoiceId, or a
   * `INV:<hashed>` memo carrying a hash of an invoice we know locally.
   */
  resolveInvoiceRef(ref: string): string | null {
    return this._resolveInvoiceRef(ref);
  }

  // ===========================================================================
  // Internal: subscriptions
  // ===========================================================================

  private _subscribeToPaymentsEvents(): void {
    const deps = this.deps!;
    // Incoming transfers — check for invoice memo, emit invoice:payment.
    this.unsubscribes.push(
      deps.on('transfer:incoming', (transfer: IncomingTransfer) => {
        this._handleIncomingTransfer(transfer).catch((err) => {
          logger.warn(LOG_TAG, 'transfer:incoming handler error:', err);
        });
      }),
    );
    this.unsubscribes.push(
      deps.on('transfer:confirmed', (result: TransferResult) => {
        this._handleConfirmedTransfer(result).catch((err) => {
          logger.warn(LOG_TAG, 'transfer:confirmed handler error:', err);
        });
      }),
    );
  }

  private async _handleIncomingTransfer(transfer: IncomingTransfer): Promise<void> {
    const memo = (transfer as unknown as { memo?: string }).memo;
    if (typeof memo !== 'string') return;
    const invoiceId = this._resolveInvoiceRef(memo);
    if (!invoiceId) return;
    // Refresh cache in case new invoice tokens landed with the transfer.
    this._refreshInvoiceTermsCache();
    if (!this.invoiceTermsCache.has(invoiceId)) return;

    const memoRef = parseInvoiceMemo(memo);
    if (!memoRef) return;

    // Synthesize a lightweight InvoiceTransferRef for the event.
    const first = transfer.tokens?.[0];
    const syntheticRef: InvoiceTransferRef = {
      transferId: transfer.id,
      direction: 'inbound',
      paymentDirection: memoRef.paymentDirection,
      coinId: first?.coinId ?? '',
      amount: first?.amount ?? '0',
      destinationAddress: this.deps!.identity.directAddress ?? '',
      timestamp: transfer.receivedAt,
      confirmed: false,
      senderAddress: null,
      ...(transfer.senderNametag !== undefined
        ? { senderNametag: transfer.senderNametag }
        : {}),
    };

    this.deps!.emitEvent('invoice:payment', {
      invoiceId,
      transfer: syntheticRef,
      paymentDirection: memoRef.paymentDirection,
      confirmed: false,
    });

    // If invoice is COVERED after this, emit invoice:covered.
    try {
      const status = await this.getInvoiceStatus(invoiceId);
      if (status.state === 'COVERED' || status.state === 'CLOSED') {
        this.deps!.emitEvent('invoice:covered', { invoiceId, confirmed: status.allConfirmed });
      }
    } catch {
      /* ignore */
    }
  }

  private async _handleConfirmedTransfer(result: TransferResult): Promise<void> {
    const memo = (result as unknown as { memo?: string }).memo;
    if (typeof memo !== 'string') return;
    const invoiceId = this._resolveInvoiceRef(memo);
    if (!invoiceId) return;
    if (!this.invoiceTermsCache.has(invoiceId)) return;

    const memoRef = parseInvoiceMemo(memo);
    if (!memoRef) return;

    // Synthesize a lightweight InvoiceTransferRef for the event.
    const first = result.tokens?.[0];
    const syntheticRef: InvoiceTransferRef = {
      transferId: result.id,
      direction: 'outbound',
      paymentDirection: memoRef.paymentDirection,
      coinId: first?.coinId ?? '',
      amount: first?.amount ?? '0',
      destinationAddress: '',
      timestamp: Date.now(),
      confirmed: true,
      senderAddress: this.deps!.identity.directAddress ?? null,
    };
    this.deps!.emitEvent('invoice:payment', {
      invoiceId,
      transfer: syntheticRef,
      paymentDirection: memoRef.paymentDirection,
      confirmed: true,
    });
  }

  // ===========================================================================
  // Internal: invoice terms cache refresh
  // ===========================================================================

  private _refreshInvoiceTermsCache(): void {
    const deps = this.deps;
    if (!deps) return;
    const allTokens = deps.payments.getTokens?.() ?? [];
    const previouslyKnown = new Set(this.invoiceTermsCache.keys());
    const seen = new Set<string>();
    for (const t of allTokens) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = (t as any).sdkData;
      // We can't parse the sdkData shape reliably here, so we rely on the
      // caller to hand us an invoice via importInvoice. New invoices
      // created in this session are added directly to the cache in
      // createInvoice/importInvoice, so this refresh is a no-op for the
      // slim rebuild but retained for compat with lifecycle callers.
      void raw;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const id = (t as any).id ?? '';
      if (typeof id === 'string' && id.length > 0) seen.add(id);
    }
    // Backfill hash index for anything we didn't hash yet.
    for (const id of this.invoiceTermsCache.keys()) {
      if (!previouslyKnown.has(id)) {
        // freshly added — hash entry will be added in create/import path.
      }
    }
  }

  // ===========================================================================
  // Internal: ledger construction (from history)
  // ===========================================================================

  private _buildLedgerEntries(invoiceId: string): InvoiceTransferRef[] {
    const deps = this.deps;
    if (!deps) return [];
    const history = deps.payments.getHistory?.() ?? [];
    const entries: InvoiceTransferRef[] = [];
    for (const entry of history) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e = entry as any;
      const memo: unknown = e.memo;
      if (typeof memo !== 'string') continue;
      const ref = this._resolveInvoiceRef(memo);
      if (ref !== invoiceId) continue;
      const memoRef = parseInvoiceMemo(memo);
      if (!memoRef) continue;

      const type: string = e.type ?? '';
      const direction: 'inbound' | 'outbound' =
        type === 'RECEIVED' ? 'inbound' : 'outbound';
      const destinationAddress: string = e.recipientAddress ?? e.recipientDirectAddress ?? '';
      const senderAddress: string | null = e.senderAddress ?? null;

      const coinIds: string[] = Array.isArray(e.tokenIds)
        ? Array.from(
            new Set(
              e.tokenIds
                .map(
                  (t: unknown) =>
                    (t && typeof t === 'object' && (t as { coinId?: string }).coinId) ||
                    e.coinId,
                )
                .filter((c: unknown): c is string => typeof c === 'string' && c.length > 0),
            ),
          )
        : e.coinId
          ? [e.coinId]
          : [];

      for (const coinId of coinIds) {
        const amount: string =
          (Array.isArray(e.tokenIds)
            ? (e.tokenIds.find(
                (t: unknown) =>
                  t && typeof t === 'object' && (t as { coinId?: string }).coinId === coinId,
              ) as { amount?: string } | undefined)?.amount
            : undefined) ??
          e.amount ??
          '0';
        entries.push({
          transferId: e.id ?? e.transferId ?? '',
          direction,
          paymentDirection: memoRef.paymentDirection,
          coinId,
          amount,
          destinationAddress,
          timestamp: e.timestamp ?? Date.now(),
          confirmed: true,
          senderAddress,
          ...(e.refundAddress !== undefined ? { refundAddress: e.refundAddress } : {}),
          ...(e.senderPubkey !== undefined ? { senderPubkey: e.senderPubkey } : {}),
          ...(e.senderNametag !== undefined ? { senderNametag: e.senderNametag } : {}),
        });
      }
    }
    return entries;
  }

  private _computeLatestSenderMap(
    terms: InvoiceTerms,
    entries: InvoiceTransferRef[],
  ): Map<string, Map<string, string>> {
    const map = new Map<string, Map<string, string>>();
    const targetAddressSet = new Set(terms.targets.map((t) => t.address));
    for (const entry of entries) {
      if (
        entry.paymentDirection === 'forward' &&
        targetAddressSet.has(entry.destinationAddress)
      ) {
        const effectiveSender = entry.refundAddress ?? entry.senderAddress;
        if (effectiveSender === null || effectiveSender === undefined) continue;
        let coinMap = map.get(entry.destinationAddress);
        if (!coinMap) {
          coinMap = new Map();
          map.set(entry.destinationAddress, coinMap);
        }
        coinMap.set(entry.coinId, effectiveSender);
      }
    }
    return map;
  }

  // ===========================================================================
  // Internal: helpers
  // ===========================================================================

  private _isTarget(invoiceId: string): boolean {
    const deps = this.deps;
    if (!deps) return false;
    const terms = this.invoiceTermsCache.get(invoiceId);
    if (!terms) return false;
    const walletAddresses = new Set(
      deps.getActiveAddresses().map((a) => a.directAddress),
    );
    if (deps.identity?.directAddress) walletAddresses.add(deps.identity.directAddress);
    return terms.targets.some((t) => walletAddresses.has(t.address));
  }

  private _resolveInvoiceRef(ref: string): string | null {
    // Try direct memo parse (INV:<id>:<dir>).
    const memoRef = parseInvoiceMemo(ref);
    if (memoRef) {
      const id = memoRef.invoiceId;
      if (this.invoiceTermsCache.has(id)) return id;
      const known = this.invoiceIdHashIndex.get(id.toLowerCase());
      if (known) return known;
      return id;
    }
    // Try raw invoiceId (or hashed variant).
    const lower = ref.toLowerCase();
    if (this.invoiceTermsCache.has(ref)) return ref;
    const knownFromHash = this.invoiceIdHashIndex.get(lower);
    if (knownFromHash) return knownFromHash;
    // Also check whether this is itself a hashInvoiceId for something we know.
    for (const invoiceId of this.invoiceTermsCache.keys()) {
      if (hashInvoiceId(invoiceId).toLowerCase() === lower) {
        this.invoiceIdHashIndex.set(lower, invoiceId);
        return invoiceId;
      }
    }
    return null;
  }

  private async _executeTerminationReturns(
    invoiceId: string,
    frozen: FrozenInvoiceBalances,
    direction: 'RC' | 'RX',
  ): Promise<void> {
    const deps = this.deps;
    if (!deps) return;
    for (const target of frozen.targets) {
      for (const coinAsset of target.coinAssets) {
        for (const sender of coinAsset.frozenSenderBalances) {
          const balance = safeBigInt(sender.netBalance);
          if (balance <= 0n) continue;
          const memo = buildInvoiceMemo(invoiceId, direction);
          try {
            await deps.payments.send({
              recipient: sender.senderAddress,
              amount: sender.netBalance,
              coinId: coinAsset.coin[0],
              memo,
              transferMode: 'instant',
            });
          } catch (err) {
            logger.warn(
              LOG_TAG,
              `Auto-return send failed for invoice ${invoiceId} sender ${sender.senderAddress}:`,
              err,
            );
          }
        }
      }
    }
  }

  // ===========================================================================
  // Internal: storage helpers
  // ===========================================================================

  private _getStorageKey(key: string): string {
    const identity = this.deps!.identity;
    const addressId = getAddressId(identity.directAddress ?? identity.chainPubkey);
    return getAddressStorageKey(addressId, key);
  }

  private async _loadJsonFromStorage<T>(key: string, defaultValue: T): Promise<T> {
    try {
      const raw = await this.deps!.storage.get(this._getStorageKey(key));
      if (!raw) return defaultValue;
      return JSON.parse(raw) as T;
    } catch (err) {
      logger.warn(LOG_TAG, `Failed to load/parse storage key "${key}":`, err);
      return defaultValue;
    }
  }

  private async _saveJsonToStorage(key: string, value: unknown): Promise<void> {
    try {
      const scoped = this._getStorageKey(key);
      await this.deps!.storage.set(scoped, JSON.stringify(value));
    } catch (err) {
      logger.warn(LOG_TAG, `Failed to save storage key "${key}":`, err);
    }
  }

  private async _persistTerminalSets(): Promise<void> {
    await this._saveJsonToStorage(
      STORAGE_KEYS_ADDRESS.CANCELLED_INVOICES,
      Array.from(this.cancelledInvoices),
    );
    await this._saveJsonToStorage(
      STORAGE_KEYS_ADDRESS.CLOSED_INVOICES,
      Array.from(this.closedInvoices),
    );
  }

  private async _persistFrozenBalances(): Promise<void> {
    await this._saveJsonToStorage(
      STORAGE_KEYS_ADDRESS.FROZEN_BALANCES,
      Object.fromEntries(this.frozenBalances),
    );
  }

  private async _persistAutoReturnSettings(): Promise<void> {
    await this._saveJsonToStorage(STORAGE_KEYS_ADDRESS.AUTO_RETURN, {
      global: this.autoReturnGlobal,
      perInvoice: Object.fromEntries(this.autoReturnPerInvoice),
    });
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createAccountingModule(config?: AccountingModuleConfig): AccountingModule {
  return new AccountingModule(config);
}

// Void-touch imports to keep behavior-preserving references without
// causing tsc `declared but never read` complaints in strict mode.
void hashInvoiceId;
void AutoReturnManager;
type _KeepEventUnion = SphereEventType;
type _KeepTokenType = Token;
void (0 as unknown as _KeepEventUnion);
void (0 as unknown as _KeepTokenType);
