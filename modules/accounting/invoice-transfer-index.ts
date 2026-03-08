/**
 * Invoice-Transfer Index
 *
 * Persistent ledger for non-terminal invoice balance computation.
 * This is the primary data source for all non-terminal invoice status
 * computation in the AccountingModule — NOT PaymentsModule.getHistory().
 *
 * Architecture:
 * - Level 1: Per-invoice transfer ledger (Map<invoiceId, Map<entryKey, InvoiceTransferRef>>)
 * - Level 2: Token scan watermark (Map<tokenId, number>)
 * - Secondary: token → invoice mapping (rebuilt on load, not persisted)
 * - Balance cache: per-invoice snapshot (invalidated on mutation, not persisted)
 *
 * @see docs/ACCOUNTING-SPEC.md §5.4
 */

import type { StorageProvider } from '../../storage/storage-provider.js';
import type { TxfToken, TxfTransaction } from '../../types/txf.js';
import type { InvoiceTransferRef, InvoiceBalanceSnapshot } from './types.js';
import { decodeTransferMessage } from './memo.js';
import { getAddressStorageKey, STORAGE_KEYS_ADDRESS } from '../../constants.js';
import { hexToBytes, bytesToHex } from '../../core/crypto.js';
import { logger } from '../../core/logger.js';

// =============================================================================
// Constants
// =============================================================================

/** Storage key prefix for per-invoice ledger entries */
const INV_LEDGER_KEY_PREFIX = 'inv_ledger:';

/** Default maximum coin data entries to process per transaction */
const DEFAULT_MAX_COIN_DATA_ENTRIES = 50;

/**
 * Validates that an amount string is a positive integer in smallest units.
 * Rejects "0", negatives, decimals, leading zeros, non-numeric, and
 * strings longer than 78 digits (defense against adversarial input).
 *
 * @see ACCOUNTING-SPEC.md §5.4.3 step 6a
 */
function isValidAmount(amount: string): boolean {
  // LENGTH CHECK FIRST (short-circuit)
  if (amount.length > 78) return false;
  return /^[1-9][0-9]*$/.test(amount);
}

// =============================================================================
// InvoiceTransferIndex
// =============================================================================

/**
 * Persistent invoice-transfer index — the authoritative ledger for non-terminal
 * invoice balance computation.
 *
 * Lifecycle:
 * 1. Construct: `new InvoiceTransferIndex()`
 * 2. Configure storage: `configure(storage, addressId)`
 * 3. Load persisted state: `await loadFromStorage()`
 * 4. Process tokens: `await processTokenTransactions(token, invoiceExists, ...)`
 * 5. Flush mutations: `await flushToStorage()`
 *
 * Thread safety: all mutation methods are synchronous (except storage I/O).
 * The AccountingModule provides per-invoice serialization gates for concurrent
 * operations — this class does not implement its own locking.
 *
 * @see docs/ACCOUNTING-SPEC.md §5.4.2
 */
export class InvoiceTransferIndex {
  /**
   * Per-invoice ledger: invoiceId → Map<entryKey, InvoiceTransferRef>
   * entryKey = `${transferId}::${coinId}` (composite dedup key)
   */
  private invoiceLedger: Map<string, Map<string, InvoiceTransferRef>> = new Map();

  /**
   * Token scan watermark: tokenId → last processed transaction count.
   * Used for incremental updates — only the tail of each token's transaction
   * array is scanned. A token is fully processed when
   * `tokenScanState.get(tokenId) >= token.transactions.length`.
   */
  private tokenScanState: Map<string, number> = new Map();

  /**
   * Secondary index: tokenId → Set<invoiceId>
   * Rebuilt from invoiceLedger on load. Not persisted.
   * Answers "which invoices does this token affect?" for efficient
   * transfer:confirmed updates and cache invalidation.
   */
  private tokenInvoiceMap: Map<string, Set<string>> = new Map();

  /**
   * Balance computation cache — invalidated on mutation, not persisted.
   * Outer key: invoiceId
   */
  private balanceCache: Map<string, InvoiceBalanceSnapshot> = new Map();

  /** Set of invoice IDs that have un-flushed mutations */
  private dirtyInvoices: Set<string> = new Set();

  /** Storage provider (set via configure()) */
  private storage: StorageProvider | null = null;

  /** Address identifier for storage key scoping */
  private addressId: string = '';

  // ---------------------------------------------------------------------------
  // Constructor & Configuration
  // ---------------------------------------------------------------------------

  constructor() {}

  /**
   * Configure storage for persistence.
   * Must be called before `loadFromStorage()` or `flushToStorage()`.
   *
   * @param storage - The key-value storage provider
   * @param addressId - Address identifier used to scope storage keys
   */
  configure(storage: StorageProvider, addressId: string): void {
    this.storage = storage;
    this.addressId = addressId;
  }

  // ---------------------------------------------------------------------------
  // Storage Keys
  // ---------------------------------------------------------------------------

  private getIndexKey(): string {
    return getAddressStorageKey(this.addressId, STORAGE_KEYS_ADDRESS.INV_LEDGER_INDEX);
  }

  private getTokenScanStateKey(): string {
    return getAddressStorageKey(this.addressId, STORAGE_KEYS_ADDRESS.TOKEN_SCAN_STATE);
  }

  private getInvoiceLedgerKey(invoiceId: string): string {
    return getAddressStorageKey(this.addressId, `${INV_LEDGER_KEY_PREFIX}${invoiceId}`);
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  /**
   * Load the index from storage.
   *
   * Loading order per spec §7 crash recovery:
   * 1. Load INV_LEDGER_INDEX → outer map keys
   * 2. Load inv_ledger:{invoiceId} for each invoice → transfer Maps
   * 3. Load TOKEN_SCAN_STATE → watermarks
   * 4. Rebuild tokenInvoiceMap from loaded entries
   *
   * Handles corrupted storage gracefully: logs a warning, treats as empty.
   * On corruption of INV_LEDGER_INDEX or TOKEN_SCAN_STATE, resets to empty
   * (full rescan will recover via dedup). On corruption of a per-invoice
   * ledger key, deletes that key and resets token watermarks for affected tokens.
   *
   * @see docs/ACCOUNTING-SPEC.md §5.4.4 (cold start phase 1)
   */
  async loadFromStorage(): Promise<void> {
    if (!this.storage) return;

    // --- Step 1: Load INV_LEDGER_INDEX ---
    let indexedInvoiceIds: string[] = [];
    try {
      const raw = await this.storage.get(this.getIndexKey());
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, { terminated: boolean; frozenAt?: number }>;
        indexedInvoiceIds = Object.keys(parsed);
      }
    } catch (err) {
      logger.warn('InvoiceTransferIndex', 'Corrupted INV_LEDGER_INDEX — resetting to empty', err);
      indexedInvoiceIds = [];
    }

    // Populate invoiceLedger outer map (keys only, will fill entries below)
    for (const invoiceId of indexedInvoiceIds) {
      if (!this.invoiceLedger.has(invoiceId)) {
        this.invoiceLedger.set(invoiceId, new Map());
      }
    }

    // --- Step 2: Load per-invoice ledger entries ---
    const corruptedInvoiceIds: string[] = [];
    for (const invoiceId of indexedInvoiceIds) {
      try {
        const raw = await this.storage.get(this.getInvoiceLedgerKey(invoiceId));
        if (!raw) continue;
        const entries = JSON.parse(raw) as InvoiceTransferRef[];
        const entryMap = new Map<string, InvoiceTransferRef>();
        for (const entry of entries) {
          const entryKey = `${entry.transferId}::${entry.coinId}`;
          entryMap.set(entryKey, entry);
        }
        this.invoiceLedger.set(invoiceId, entryMap);
      } catch (err) {
        logger.warn(
          'InvoiceTransferIndex',
          `Corrupted inv_ledger:${invoiceId} — will rescan from index 0`,
          err,
        );
        corruptedInvoiceIds.push(invoiceId);
        this.invoiceLedger.set(invoiceId, new Map());
        // Delete the corrupted key so next flush writes a clean copy
        try {
          await this.storage.remove(this.getInvoiceLedgerKey(invoiceId));
        } catch {
          // Best-effort cleanup
        }
      }
    }

    // --- Step 3: Load TOKEN_SCAN_STATE ---
    try {
      const raw = await this.storage.get(this.getTokenScanStateKey());
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, number>;
        for (const [tokenId, count] of Object.entries(parsed)) {
          this.tokenScanState.set(tokenId, count);
        }
      }
    } catch (err) {
      logger.warn('InvoiceTransferIndex', 'Corrupted TOKEN_SCAN_STATE — resetting to empty (full rescan)', err);
      this.tokenScanState.clear();
    }

    // For corrupted invoice ledger keys: reset token watermarks so affected
    // tokens are rescanned from index 0. We identify affected tokens by
    // scanning the tokenInvoiceMap (built below) and clearing watermarks for
    // any token that maps to a corrupted invoice.
    // We do this AFTER rebuilding tokenInvoiceMap (step 4).

    // --- Step 4: Rebuild tokenInvoiceMap ---
    this.tokenInvoiceMap.clear();
    for (const [invoiceId, entryMap] of this.invoiceLedger) {
      for (const entry of entryMap.values()) {
        // Derive tokenId from transferId is not directly possible here;
        // we use the tokenInvoiceMap to be rebuilt incrementally when
        // processTokenTransactions() runs.
        // However, we can populate it from what we have:
        // The entryKey is `${transferId}::${coinId}`. We don't store tokenId
        // in InvoiceTransferRef, so tokenInvoiceMap must be rebuilt during
        // processTokenTransactions(). We skip this step here and let
        // processTokenTransactions() populate it on the gap-fill pass.
        void entry; // suppress unused warning
      }
      void invoiceId;
    }

    // Reset watermarks for tokens pointing to corrupted invoices.
    // Since we can't determine which tokens referenced corrupted invoices
    // (InvoiceTransferRef doesn't store tokenId), we take the conservative
    // approach: if any invoice was corrupted, reset ALL watermarks.
    // On a clean load this is a no-op. On corruption it triggers full rescan
    // (safe via dedup in processTokenTransactions).
    if (corruptedInvoiceIds.length > 0) {
      logger.warn(
        'InvoiceTransferIndex',
        `${corruptedInvoiceIds.length} invoice ledger(s) corrupted — resetting all token watermarks for safe rescan`,
      );
      this.tokenScanState.clear();
    }
  }

  /**
   * Flush dirty invoices to storage.
   *
   * Write order per spec §7 crash recovery:
   * 1. Write inv_ledger:{invoiceId} for each dirty invoice
   * 2. Write token_scan_state
   * 3. Write inv_ledger_index
   *
   * If the process crashes after step 1 but before step 2, the next cold start
   * will reprocess some token transactions from the tail. The dedup check on
   * `${transferId}::${coinId}` inside processTokenTransactions() catches
   * duplicates — the ledger is the source of truth.
   *
   * @see docs/ACCOUNTING-SPEC.md §7 (crash recovery)
   */
  async flushToStorage(): Promise<void> {
    if (!this.storage || this.dirtyInvoices.size === 0) return;

    const dirtySnapshot = new Set(this.dirtyInvoices);
    this.dirtyInvoices.clear();

    // Step 1: Write per-invoice ledger entries
    let anyLedgerWriteFailed = false;
    for (const invoiceId of dirtySnapshot) {
      const entryMap = this.invoiceLedger.get(invoiceId);
      if (!entryMap) continue;
      const entries = Array.from(entryMap.values());
      try {
        await this.storage.set(this.getInvoiceLedgerKey(invoiceId), JSON.stringify(entries));
      } catch (err) {
        logger.warn('InvoiceTransferIndex', `Failed to flush inv_ledger:${invoiceId}`, err);
        // Re-mark as dirty so next flush retries
        this.dirtyInvoices.add(invoiceId);
        anyLedgerWriteFailed = true;
      }
    }

    // If any ledger write failed, do NOT advance scanState/index — preserves crash-recovery invariant
    if (anyLedgerWriteFailed) return;

    // Step 2: Write token scan state
    try {
      const scanStateObj: Record<string, number> = {};
      for (const [tokenId, count] of this.tokenScanState) {
        scanStateObj[tokenId] = count;
      }
      await this.storage.set(this.getTokenScanStateKey(), JSON.stringify(scanStateObj));
    } catch (err) {
      logger.warn('InvoiceTransferIndex', 'Failed to flush TOKEN_SCAN_STATE', err);
    }

    // Step 3: Write inv_ledger_index
    try {
      const indexObj: Record<string, { terminated: boolean; frozenAt?: number }> = {};
      for (const invoiceId of this.invoiceLedger.keys()) {
        indexObj[invoiceId] = { terminated: false };
      }
      await this.storage.set(this.getIndexKey(), JSON.stringify(indexObj));
    } catch (err) {
      logger.warn('InvoiceTransferIndex', 'Failed to flush INV_LEDGER_INDEX', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Core Processing
  // ---------------------------------------------------------------------------

  /**
   * Process token transactions for invoice references.
   *
   * Scans from the current watermark position, extracts invoice references
   * from on-chain messages (with legacy transport-memo fallback), and updates
   * the invoice ledger. Returns all newly created InvoiceTransferRef entries.
   *
   * Key behaviors:
   * - Idempotent: composite dedup key `${transferId}::${coinId}` prevents
   *   duplicate entries on re-processing.
   * - Incremental: only processes transactions from watermark to end.
   * - Error-resilient: per-transaction try/catch ensures malformed transactions
   *   do not block the watermark from advancing.
   * - Multi-asset: one InvoiceTransferRef per coin entry in genesis.coinData.
   *
   * @param token - TxfToken to scan
   * @param invoiceExists - Callback to check if an invoice is known locally
   * @param legacyMemoLookup - Optional: look up transport memo for a transfer
   *   (legacy fallback for transfers made before on-chain message was added)
   * @param maxCoinDataEntries - Cap on coin entries per transaction (default 50)
   * @returns Newly created InvoiceTransferRef entries
   *
   * @see docs/ACCOUNTING-SPEC.md §5.4.3
   */
  async processTokenTransactions(
    token: TxfToken,
    invoiceExists: (invoiceId: string) => boolean,
    legacyMemoLookup?: (transferId: string) => string | undefined,
    maxCoinDataEntries: number = DEFAULT_MAX_COIN_DATA_ENTRIES,
  ): Promise<InvoiceTransferRef[]> {
    const tokenId = token.genesis.data.tokenId;
    const transactions: TxfTransaction[] = token.transactions ?? [];
    const coinData = token.genesis.data.coinData ?? [];

    // Fast-path: if no coin data, this token cannot contribute to invoice balances
    if (coinData.length === 0) {
      // Update watermark (mark as fully scanned even if no coin data)
      this.tokenScanState.set(tokenId, transactions.length);
      return [];
    }

    const startIndex = this.tokenScanState.get(tokenId) ?? 0;

    // Fast-path: already fully scanned
    if (transactions.length <= startIndex) {
      return [];
    }

    const newEntries: InvoiceTransferRef[] = [];

    // Lazy-import SDK classes for address derivation and hash computation
    // These are deferred to avoid loading them when not needed
    let UnmaskedPredicate: typeof import('@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate.js').UnmaskedPredicate | undefined;
    let UnmaskedPredicateReference: typeof import('@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicateReference.js').UnmaskedPredicateReference | undefined;
    let TokenType: typeof import('@unicitylabs/state-transition-sdk/lib/token/TokenType.js').TokenType | undefined;
    let HashAlgorithm: typeof import('@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm.js').HashAlgorithm | undefined;
    let TransferTransactionData: typeof import('@unicitylabs/state-transition-sdk/lib/transaction/TransferTransactionData.js').TransferTransactionData | undefined;

    const ensureSdkImports = async (): Promise<void> => {
      if (UnmaskedPredicate) return; // already imported
      const [upMod, uprMod, ttMod, haMod, ttdMod] = await Promise.all([
        import('@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate.js'),
        import('@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicateReference.js'),
        import('@unicitylabs/state-transition-sdk/lib/token/TokenType.js'),
        import('@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm.js'),
        import('@unicitylabs/state-transition-sdk/lib/transaction/TransferTransactionData.js'),
      ]);
      UnmaskedPredicate = upMod.UnmaskedPredicate;
      UnmaskedPredicateReference = uprMod.UnmaskedPredicateReference;
      TokenType = ttMod.TokenType;
      HashAlgorithm = haMod.HashAlgorithm;
      TransferTransactionData = ttdMod.TransferTransactionData;
    };

    /**
     * Derive DIRECT:// address string from a hex-encoded public key.
     * Mirrors PaymentsModule.createDirectAddressFromPubkey() — inlined here
     * to avoid coupling to PaymentsModule internals.
     *
     * @see docs/ACCOUNTING-SPEC.md §5.4.3 step 5 (ADDRESS DERIVATION note)
     */
    const deriveDirectAddress = async (pubkeyHex: string): Promise<string> => {
      await ensureSdkImports();
      // Use the standard fungible token type for address derivation (same constant as PaymentsModule/NametagMinter)
      const UNICITY_TOKEN_TYPE_HEX = 'f8aa13834268d29355ff12183066f0cb902003629bbc5eb9ef0efbe397867509';
      const tokenType = new TokenType!(Buffer.from(UNICITY_TOKEN_TYPE_HEX, 'hex'));
      const pubkeyBytes = hexToBytes(pubkeyHex);
      const addressRef = await UnmaskedPredicateReference!.create(
        tokenType,
        'secp256k1',
        pubkeyBytes,
        HashAlgorithm!.SHA256,
      );
      return (await addressRef.toAddress()).address;
    };

    for (let absIdx = startIndex; absIdx < transactions.length; absIdx++) {
      const tx = transactions[absIdx]!;

      try {
        // -------------------------------------------------------------------
        // Step 1: Decode invoice reference from on-chain message (§4.1)
        // The message field in TxfTransaction.data is hex-encoded JSON form.
        // Decode cheaply using hexToBytes before the expensive fromJSON call.
        // -------------------------------------------------------------------
        let invoiceRef: { invoiceId: string; paymentDirection: InvoiceTransferRef['paymentDirection'] } | null = null;
        let refundAddress: string | undefined;
        let contact: { a: string; u?: string } | undefined;

        const rawMessageHex = (tx.data as Record<string, unknown> | undefined)?.['message'];
        let messageBytes: Uint8Array | null = null;
        if (typeof rawMessageHex === 'string' && rawMessageHex.length > 0) {
          try {
            messageBytes = hexToBytes(rawMessageHex);
          } catch {
            messageBytes = null;
          }
        }

        const payload = decodeTransferMessage(messageBytes);
        if (payload?.inv) {
          const dir = payload.inv.dir;
          let paymentDirection: InvoiceTransferRef['paymentDirection'];
          switch (dir) {
            case 'B':  paymentDirection = 'back'; break;
            case 'RC': paymentDirection = 'return_closed'; break;
            case 'RX': paymentDirection = 'return_cancelled'; break;
            default:   paymentDirection = 'forward'; break; // 'F' or omitted
          }
          invoiceRef = { invoiceId: payload.inv.id, paymentDirection };
          refundAddress = payload.inv.ra;
          contact = payload.inv.ct;
        } else {
          // -------------------------------------------------------------------
          // Fallback: legacy transport memo (§4.8)
          // Used for transfers made before the on-chain message change.
          // -------------------------------------------------------------------
          if (legacyMemoLookup) {
            // We need a transferId to look up the memo. Compute a provisional
            // key from tokenId + absIdx for the lookup (the real transferId
            // from hash computation happens in step 4b below, but memo lookup
            // uses tokenId+index as a correlator).
            const provisionalKey = `${tokenId}:${absIdx}`;
            const memo = legacyMemoLookup(provisionalKey);
            if (memo) {
              const { parseInvoiceMemo } = await import('./memo.js');
              const memoRef = parseInvoiceMemo(memo);
              if (memoRef) {
                invoiceRef = {
                  invoiceId: memoRef.invoiceId,
                  paymentDirection: memoRef.paymentDirection,
                };
              }
            }
          }
        }

        // -------------------------------------------------------------------
        // Step 2: If no invoice reference found → skip
        // -------------------------------------------------------------------
        if (!invoiceRef) continue;

        // -------------------------------------------------------------------
        // Step 3: Check if invoice exists locally
        // -------------------------------------------------------------------
        if (!invoiceExists(invoiceRef.invoiceId)) continue;

        // -------------------------------------------------------------------
        // Step 4a: Validate destinationAddress (cheap — before hash)
        // -------------------------------------------------------------------
        const txData = tx.data as Record<string, unknown> | undefined;
        const destinationAddress = txData?.['recipient'];
        if (typeof destinationAddress !== 'string' || !destinationAddress.startsWith('DIRECT://')) {
          continue; // skip transaction with invalid recipient
        }

        // -------------------------------------------------------------------
        // Step 4b: Derive transferId (expensive — async hash computation)
        // Edge case: tx.data is optional. Skip if missing.
        // -------------------------------------------------------------------
        if (!txData) continue;

        await ensureSdkImports();
        const txDataObj = await TransferTransactionData!.fromJSON(txData);
        const dataHash = await txDataObj.calculateHash();
        const transferId = bytesToHex(dataHash.data);

        // -------------------------------------------------------------------
        // Step 5: Resolve sender address
        //
        // Primary: extract from sourceState.predicate in the current tx's data.
        //   TransferTransactionData stores the PREVIOUS state (sender's predicate)
        //   in sourceState. This is always present for valid transfers and works
        //   for ALL transaction indices (no absIdx === 0 special case needed).
        //
        // Fallback 1: previous transaction predicate (tx[N-1].predicate is the
        //   new owner after tx N-1 = sender of tx N).
        //
        // Fallback 2: genesis.data.recipient for absIdx === 0 (the initial token
        //   owner who is making the first transfer).
        // -------------------------------------------------------------------
        let senderAddress: string | null = null;

        // Primary: sourceState.predicate from current transaction data
        const sourceStatePredicate = (txData as Record<string, unknown> | undefined)?.['sourceState'];
        if (sourceStatePredicate && typeof sourceStatePredicate === 'object') {
          const predicateHex = (sourceStatePredicate as Record<string, unknown>)['predicate'];
          if (typeof predicateHex === 'string' && predicateHex.length > 0) {
            try {
              await ensureSdkImports();
              const predicate = UnmaskedPredicate!.fromCBOR(hexToBytes(predicateHex));
              const pubkeyHex = bytesToHex(predicate.publicKey);
              senderAddress = await deriveDirectAddress(pubkeyHex);
            } catch {
              // Masked predicate — try fallbacks
            }
          }
        }

        // Fallback 1: previous transaction predicate
        if (senderAddress === null && absIdx > 0) {
          try {
            await ensureSdkImports();
            const prevPredicate = transactions[absIdx - 1]!.predicate;
            if (prevPredicate && prevPredicate.length > 0) {
              const predicate = UnmaskedPredicate!.fromCBOR(hexToBytes(prevPredicate));
              const pubkeyHex = bytesToHex(predicate.publicKey);
              senderAddress = await deriveDirectAddress(pubkeyHex);
            }
          } catch {
            // Masked predicate or empty — try fallback 2
          }
        }

        // Fallback 2: genesis.data.recipient (initial token owner for first transfer)
        if (senderAddress === null && absIdx === 0) {
          senderAddress = token.genesis.data.recipient;
        }

        // -------------------------------------------------------------------
        // Step 6: For each [coinId, amount] in coinData
        // (capped at maxCoinDataEntries)
        // -------------------------------------------------------------------
        const coinDataLimit = Math.min(coinData.length, maxCoinDataEntries);
        for (let coinIdx = 0; coinIdx < coinDataLimit; coinIdx++) {
          const coinEntry = coinData[coinIdx]!;
          const [coinId, amount] = coinEntry;

          // Step 6a: Skip invalid amounts
          if (!isValidAmount(amount)) continue;

          // Step 6b: Build composite dedup key
          const entryKey = `${transferId}::${coinId}`;

          // Step 6c: Lazy creation of invoice map
          let invoiceMap = this.invoiceLedger.get(invoiceRef.invoiceId);
          if (!invoiceMap) {
            invoiceMap = new Map();
            this.invoiceLedger.set(invoiceRef.invoiceId, invoiceMap);
          }

          // Step 6d: Dedup check
          if (invoiceMap.has(entryKey)) continue;

          // Step 6e: Determine direction (inbound vs outbound)
          // This is set to 'inbound' by default; the AccountingModule caller
          // provides wallet addresses for self-identification. At the index
          // layer we default to 'inbound' and let the module override if needed.
          // Per spec: if senderAddress matches a wallet address → 'outbound'.
          // Since InvoiceTransferIndex does not hold wallet identity, we emit
          // 'inbound' here. The caller (AccountingModule) must post-correct
          // direction for outbound transfers using wallet identity.
          //
          // NOTE: The AccountingModule owns wallet address knowledge. The index
          // captures the raw data; direction computation is a caller concern.
          // We provide senderAddress and destinationAddress so the caller can
          // determine direction externally and update entries if needed.
          // For now, we emit 'inbound' as the default; the module corrects it.
          const direction: 'inbound' | 'outbound' = 'inbound';

          // Build InvoiceTransferRef
          const ref: InvoiceTransferRef = {
            transferId,
            direction,
            paymentDirection: invoiceRef.paymentDirection,
            coinId,
            amount,
            destinationAddress,
            timestamp: Date.now(),
            confirmed: tx.inclusionProof !== null,
            senderAddress,
            ...(refundAddress !== undefined ? { refundAddress } : {}),
            ...(contact !== undefined
              ? { contact: { address: contact.a, ...(contact.u !== undefined ? { url: contact.u } : {}) } }
              : {}),
          };

          // Step 6f: Insert into ledger
          invoiceMap.set(entryKey, ref);

          // Step 6g: Add to newEntries
          newEntries.push(ref);

          // Step 6h: Update tokenInvoiceMap
          let invoiceSet = this.tokenInvoiceMap.get(tokenId);
          if (!invoiceSet) {
            invoiceSet = new Set();
            this.tokenInvoiceMap.set(tokenId, invoiceSet);
          }
          invoiceSet.add(invoiceRef.invoiceId);

          // Step 6i: Invalidate balance cache
          this.balanceCache.delete(invoiceRef.invoiceId);

          // Step 6j: Mark dirty
          this.dirtyInvoices.add(invoiceRef.invoiceId);
        }
      } catch (err) {
        // Per spec §5.4.3 ERROR HANDLING: log and continue to the next
        // transaction. This prevents a single malformed transaction from
        // creating an infinite retry loop — the watermark advances past
        // the failing index unconditionally below.
        logger.warn(
          'InvoiceTransferIndex',
          `Error processing tx at absIdx=${absIdx} for tokenId=${tokenId}`,
          err,
        );
      }
    }

    // Update watermark regardless of per-transaction errors
    this.tokenScanState.set(tokenId, transactions.length);

    return newEntries;
  }

  // ---------------------------------------------------------------------------
  // Query Methods
  // ---------------------------------------------------------------------------

  /**
   * Get all InvoiceTransferRef entries for an invoice.
   *
   * @param invoiceId - Invoice token ID (64-char hex, lowercase)
   * @returns All indexed entries for this invoice (empty array if none)
   */
  getEntries(invoiceId: string): InvoiceTransferRef[] {
    const entryMap = this.invoiceLedger.get(invoiceId);
    if (!entryMap) return [];
    return Array.from(entryMap.values());
  }

  /**
   * Get a cached balance snapshot for an invoice, or null if not cached.
   *
   * @param invoiceId - Invoice token ID
   */
  getCachedBalance(invoiceId: string): InvoiceBalanceSnapshot | null {
    return this.balanceCache.get(invoiceId) ?? null;
  }

  /**
   * Set the cached balance snapshot for an invoice.
   * Called by AccountingModule after computing balances.
   *
   * @param invoiceId - Invoice token ID
   * @param snapshot - Computed balance snapshot
   */
  setCachedBalance(invoiceId: string, snapshot: InvoiceBalanceSnapshot): void {
    this.balanceCache.set(invoiceId, snapshot);
  }

  /**
   * Invalidate the balance cache for an invoice.
   * Must be called after any mutation to the invoice's entries.
   *
   * @param invoiceId - Invoice token ID
   */
  invalidateBalance(invoiceId: string): void {
    this.balanceCache.delete(invoiceId);
  }

  /**
   * Get all invoice IDs currently in the index.
   */
  getIndexedInvoiceIds(): string[] {
    return Array.from(this.invoiceLedger.keys());
  }

  /**
   * Get the current token scan watermark for a given token.
   *
   * @param tokenId - 64-char hex token ID
   * @returns Number of transactions processed (0 if never scanned)
   */
  getTokenWatermark(tokenId: string): number {
    return this.tokenScanState.get(tokenId) ?? 0;
  }

  /**
   * Get all invoice IDs that reference a given token.
   * Populated during processTokenTransactions().
   *
   * @param tokenId - 64-char hex token ID
   * @returns Set of invoice IDs affected by this token
   */
  getInvoicesForToken(tokenId: string): ReadonlySet<string> {
    return this.tokenInvoiceMap.get(tokenId) ?? new Set();
  }

  // ---------------------------------------------------------------------------
  // Mutation Methods (for reclassification and external adds)
  // ---------------------------------------------------------------------------

  /**
   * Remove specific entries from an invoice's ledger.
   * Used by the AccountingModule for unauthorized return reclassification
   * (§5.4.3 step 6e NOTE: entries with null senderAddress indexed as-is,
   * then §6.2 step 3a post-validation reclassifies them).
   *
   * Invalidates the balance cache for the invoice.
   *
   * @param invoiceId - Invoice token ID
   * @param entryKeys - Entry keys to remove (`${transferId}::${coinId}`)
   */
  removeEntries(invoiceId: string, entryKeys: string[]): void {
    const entryMap = this.invoiceLedger.get(invoiceId);
    if (!entryMap) return;
    let changed = false;
    for (const key of entryKeys) {
      if (entryMap.delete(key)) changed = true;
    }
    if (changed) {
      this.balanceCache.delete(invoiceId);
      this.dirtyInvoices.add(invoiceId);
    }
  }

  /**
   * Add an entry to an invoice's ledger with a specific entry key.
   * Used by the AccountingModule for reclassification (e.g., changing
   * direction on an entry after post-validation).
   *
   * Invalidates the balance cache for the invoice.
   *
   * @param invoiceId - Invoice token ID
   * @param entryKey - Entry key (`${transferId}::${coinId}`)
   * @param ref - The InvoiceTransferRef to add
   */
  addEntry(invoiceId: string, entryKey: string, ref: InvoiceTransferRef): void {
    let entryMap = this.invoiceLedger.get(invoiceId);
    if (!entryMap) {
      entryMap = new Map();
      this.invoiceLedger.set(invoiceId, entryMap);
    }
    entryMap.set(entryKey, ref);
    this.balanceCache.delete(invoiceId);
    this.dirtyInvoices.add(invoiceId);
  }

  /**
   * Update the direction field of an existing entry (e.g., inbound → outbound).
   * No-op if the entry does not exist.
   *
   * @param invoiceId - Invoice token ID
   * @param entryKey - Entry key (`${transferId}::${coinId}`)
   * @param direction - New direction value
   */
  updateEntryDirection(invoiceId: string, entryKey: string, direction: 'inbound' | 'outbound'): void {
    const entryMap = this.invoiceLedger.get(invoiceId);
    if (!entryMap) return;
    const existing = entryMap.get(entryKey);
    if (!existing) return;
    // InvoiceTransferRef is readonly — create a new object with updated direction
    const updated: InvoiceTransferRef = { ...existing, direction };
    entryMap.set(entryKey, updated);
    this.balanceCache.delete(invoiceId);
    this.dirtyInvoices.add(invoiceId);
  }

  /**
   * Update the confirmed field of an existing entry.
   * Called when a token receives its inclusion proof (transfer:confirmed event).
   *
   * @param invoiceId - Invoice token ID
   * @param entryKey - Entry key (`${transferId}::${coinId}`)
   * @param confirmed - New confirmation status
   */
  updateEntryConfirmed(invoiceId: string, entryKey: string, confirmed: boolean): void {
    const entryMap = this.invoiceLedger.get(invoiceId);
    if (!entryMap) return;
    const existing = entryMap.get(entryKey);
    if (!existing || existing.confirmed === confirmed) return;
    const updated: InvoiceTransferRef = { ...existing, confirmed };
    entryMap.set(entryKey, updated);
    this.balanceCache.delete(invoiceId);
    this.dirtyInvoices.add(invoiceId);
  }

  /**
   * Ensure an invoice ID is tracked in the ledger (creates empty map if absent).
   * Called when a new invoice is created or imported.
   *
   * @param invoiceId - Invoice token ID
   */
  ensureInvoice(invoiceId: string): void {
    if (!this.invoiceLedger.has(invoiceId)) {
      this.invoiceLedger.set(invoiceId, new Map());
      this.dirtyInvoices.add(invoiceId);
    }
  }

  /**
   * Remove an invoice from the index entirely.
   * Used when an invoice token is deleted from local storage.
   * Does NOT persist — caller must call flushToStorage().
   *
   * @param invoiceId - Invoice token ID
   */
  removeInvoice(invoiceId: string): void {
    if (this.invoiceLedger.delete(invoiceId)) {
      this.balanceCache.delete(invoiceId);
      this.dirtyInvoices.add(invoiceId);
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Clear all in-memory state.
   * Storage is NOT cleared — call flushToStorage() after modifying storage
   * keys directly if needed.
   */
  clear(): void {
    this.invoiceLedger.clear();
    this.tokenScanState.clear();
    this.tokenInvoiceMap.clear();
    this.balanceCache.clear();
    this.dirtyInvoices.clear();
  }
}
