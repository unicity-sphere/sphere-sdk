/**
 * Balance Computation Engine for AccountingModule
 *
 * Pure computation functions for deriving invoice status from indexed transfer
 * entries. All functions are stateless: no side effects, no storage access,
 * no module references.
 *
 * Key invariants:
 * - All arithmetic uses BigInt (amounts are integer strings)
 * - max(0n, ...) defensive floor is applied to all net amounts
 * - Self-payments (sender == destination == wallet address) are excluded
 * - DIRECT:// address comparisons are case-sensitive exact string matches
 * - Terminal state (frozen) takes full priority over dynamic computation
 *
 * @see docs/ACCOUNTING-SPEC.md §5.1, §5.2, §7.3
 */

import type {
  InvoiceTerms,
  InvoiceTransferRef,
  InvoiceBalanceSnapshot,
  InvoiceSenderBalance,
  InvoiceCoinAssetStatus,
  InvoiceNFTAssetStatus,
  InvoiceTargetStatus,
  InvoiceStatus,
  InvoiceState,
  IrrelevantTransfer,
  FrozenInvoiceBalances,
  FrozenTargetBalances,
  FrozenCoinAssetBalances,
  FrozenSenderBalance,
} from './types.js';

// =============================================================================
// Internal working types (not exported — implementation detail)
// =============================================================================

/** Mutable accumulator for a single sender's balances within one target:coinId. */
interface SenderAccumulator {
  forwarded: bigint;
  returned: bigint;
  isRefundAddress?: boolean;
  senderPubkey?: string | null;
  senderNametag?: string;
  /** Dedup set for contacts: key = `${address}\0${url ?? ''}` */
  contactDedupKeys: Set<string>;
  contacts: Array<{ address: string; url?: string }>;
}

/** Mutable accumulator for a single coin asset within one target. */
interface CoinAssetAccumulator {
  /** Aggregate forward payments (not per-sender) */
  coveredAmount: bigint;
  /** Aggregate return payments (not per-sender) */
  returnedAmount: bigint;
  /** All transfer entries contributing to this coin asset */
  transfers: InvoiceTransferRef[];
  /** Per-sender accumulators: key = effectiveSender (DIRECT:// address) */
  senders: Map<string, SenderAccumulator>;
}

/** Mutable accumulator for one invoice target. */
interface TargetAccumulator {
  /** coin asset accumulators: key = coinId */
  coins: Map<string, CoinAssetAccumulator>;
}

// =============================================================================
// Validation helpers
// =============================================================================

/**
 * Validates an amount string is a non-negative integer with no leading zeros,
 * no decimal point, no whitespace, and length <= 78 digits.
 *
 * Accepts "0" (zero value). Rejects empty strings, negative values, and
 * strings exceeding 78 chars (defense against CPU exhaustion via BigInt).
 *
 * @see docs/ACCOUNTING-SPEC.md §5.2
 */
function isValidAmount(amount: string): boolean {
  if (amount.length === 0 || amount.length > 78) return false;
  // "0" is valid; positive integers must not have a leading zero
  return /^(0|[1-9][0-9]*)$/.test(amount);
}

/**
 * Safely parse a validated amount string to BigInt.
 * Returns 0n if the amount fails validation — callers rely on this for
 * defensive fallback rather than throwing (entries with bad amounts were
 * already filtered at indexing time, but defensive parsing is cheap here).
 */
function parseBigInt(amount: string): bigint {
  if (!isValidAmount(amount)) return 0n;
  return BigInt(amount);
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Determine if an invoice transfer direction is a "return" direction
 * (back, return_closed, return_cancelled) rather than a forward payment.
 */
function isReturnDirection(dir: InvoiceTransferRef['paymentDirection']): boolean {
  return dir === 'back' || dir === 'return_closed' || dir === 'return_cancelled';
}

/**
 * Merge contact info into a sender accumulator.
 * Deduplication key: `${address}\0${url ?? ''}`.
 * Maximum 10 contacts per sender (storage amplification defense).
 */
function mergeContact(
  acc: SenderAccumulator,
  contact: { address: string; url?: string } | undefined,
): void {
  if (!contact) return;
  if (acc.contacts.length >= 10) return;
  const dedupKey = `${contact.address}\0${contact.url ?? ''}`;
  if (acc.contactDedupKeys.has(dedupKey)) return;
  acc.contactDedupKeys.add(dedupKey);
  acc.contacts.push({ address: contact.address, ...(contact.url !== undefined ? { url: contact.url } : {}) });
}

/**
 * Build or retrieve the sender accumulator for an effectiveSender key
 * within a coin asset accumulator.
 */
function getOrCreateSenderAcc(
  coinAcc: CoinAssetAccumulator,
  effectiveSender: string,
  entry: InvoiceTransferRef,
): SenderAccumulator {
  let senderAcc = coinAcc.senders.get(effectiveSender);
  if (!senderAcc) {
    senderAcc = {
      forwarded: 0n,
      returned: 0n,
      isRefundAddress: entry.refundAddress !== undefined ? true : undefined,
      senderPubkey: entry.senderPubkey ?? undefined,
      senderNametag: entry.senderNametag,
      contactDedupKeys: new Set(),
      contacts: [],
    };
    coinAcc.senders.set(effectiveSender, senderAcc);
  }
  // Preserve senderPubkey if it becomes known on a later entry
  if (!senderAcc.senderPubkey && entry.senderPubkey) {
    senderAcc.senderPubkey = entry.senderPubkey;
  }
  // Preserve nametag if it becomes known
  if (!senderAcc.senderNametag && entry.senderNametag) {
    senderAcc.senderNametag = entry.senderNametag;
  }
  return senderAcc;
}

/**
 * Build an InvoiceSenderBalance from a fully populated SenderAccumulator.
 * Applies the max(0, ...) defensive floor to netBalance.
 */
function buildSenderBalance(senderAddress: string, acc: SenderAccumulator): InvoiceSenderBalance {
  const netBalance = acc.forwarded > acc.returned ? acc.forwarded - acc.returned : 0n;
  return {
    senderAddress,
    contacts: acc.contacts,
    forwardedAmount: acc.forwarded.toString(),
    returnedAmount: acc.returned.toString(),
    netBalance: netBalance.toString(),
    // Only include optional fields when they carry information
    ...(acc.isRefundAddress === true ? { isRefundAddress: true as const } : {}),
    ...(acc.senderPubkey != null ? { senderPubkey: acc.senderPubkey } : {}),
    ...(acc.senderNametag !== undefined ? { senderNametag: acc.senderNametag } : {}),
  };
}

/**
 * Build an InvoiceCoinAssetStatus from a fully populated CoinAssetAccumulator.
 * The `requestedAmount` comes from the invoice target's CoinEntry.
 */
function buildCoinAssetStatus(
  coinId: string,
  requestedAmount: string,
  acc: CoinAssetAccumulator,
): InvoiceCoinAssetStatus {
  const netCoveredAmount =
    acc.coveredAmount > acc.returnedAmount ? acc.coveredAmount - acc.returnedAmount : 0n;
  const requested = parseBigInt(requestedAmount);
  const isCovered = netCoveredAmount >= requested;
  const surplusAmount = netCoveredAmount > requested ? netCoveredAmount - requested : 0n;

  // Per-spec: confirmed = ALL related transfers are confirmed
  const confirmed =
    acc.transfers.length > 0 && acc.transfers.every((t) => t.confirmed);

  // Build sender balances
  const senderBalances: InvoiceSenderBalance[] = [];
  for (const [senderAddress, senderAcc] of acc.senders) {
    senderBalances.push(buildSenderBalance(senderAddress, senderAcc));
  }

  return {
    coin: [coinId, requestedAmount],
    coveredAmount: acc.coveredAmount.toString(),
    returnedAmount: acc.returnedAmount.toString(),
    netCoveredAmount: netCoveredAmount.toString(),
    isCovered,
    surplusAmount: surplusAmount.toString(),
    confirmed,
    transfers: acc.transfers.slice(), // defensive copy
    senderBalances,
  };
}

/**
 * Build an InvoiceTargetStatus from a completed TargetAccumulator for
 * one invoice target. NFT assets always have placeholder statuses in v1.
 *
 * @param targetAddress - The invoice target's DIRECT:// address
 * @param targetAcc     - Populated accumulator for this target
 * @param terms         - Invoice terms (to read requested assets)
 * @param targetIndex   - Index into terms.targets for this target
 */
function buildTargetStatus(
  targetAddress: string,
  targetAcc: TargetAccumulator,
  terms: InvoiceTerms,
  targetIndex: number,
): InvoiceTargetStatus {
  const termTarget = terms.targets[targetIndex];

  const coinAssets: InvoiceCoinAssetStatus[] = [];
  const nftAssets: InvoiceNFTAssetStatus[] = [];

  if (termTarget) {
    for (const asset of termTarget.assets) {
      if (asset.coin) {
        const [coinId, requestedAmount] = asset.coin;
        const acc = targetAcc.coins.get(coinId);
        if (acc) {
          coinAssets.push(buildCoinAssetStatus(coinId, requestedAmount, acc));
        } else {
          // No payments received for this coin — zero-value status
          coinAssets.push({
            coin: [coinId, requestedAmount],
            coveredAmount: '0',
            returnedAmount: '0',
            netCoveredAmount: '0',
            isCovered: false,
            surplusAmount: '0',
            confirmed: false,
            transfers: [],
            senderBalances: [],
          });
        }
      } else if (asset.nft) {
        // v1 placeholder: NFT assets always show not received
        nftAssets.push({
          nft: asset.nft,
          received: false,
          confirmed: false,
        });
      }
    }
  }

  // Per spec §5.1 step 6: target isCovered = all coin assets covered (NFTs excluded v1)
  // A target with no coin assets is considered not covered (nothing requested)
  const isCovered =
    coinAssets.length > 0 && coinAssets.every((ca) => ca.isCovered);

  // confirmed = all coin assets confirmed (targets with zero transfers are not confirmed)
  const confirmed =
    coinAssets.length > 0 && coinAssets.every((ca) => ca.confirmed);

  return {
    address: targetAddress,
    coinAssets,
    nftAssets,
    isCovered,
    confirmed,
  };
}

// =============================================================================
// Main exported functions
// =============================================================================

/**
 * Compute the complete invoice status from a list of indexed transfer entries.
 *
 * If `frozenBalances` is non-null, the invoice is terminal (CLOSED or CANCELLED)
 * and the status is reconstructed from the frozen snapshot. `allConfirmed` is
 * set to `true` as a placeholder — the caller is responsible for updating it
 * by checking actual token confirmation status via PaymentsModule.
 *
 * If `frozenBalances` is null, the status is computed dynamically from `entries`.
 *
 * Pure function — no side effects.
 *
 * @param invoiceId      - Invoice token ID (64-char hex, lowercase)
 * @param terms          - Parsed invoice terms
 * @param entries        - All InvoiceTransferRef entries for this invoice
 * @param frozenBalances - Frozen snapshot if terminal; null if non-terminal
 * @param walletAddresses - All wallet DIRECT:// addresses (for self-payment detection)
 *
 * @see docs/ACCOUNTING-SPEC.md §5.1
 */
export function computeInvoiceStatus(
  invoiceId: string,
  terms: InvoiceTerms,
  entries: InvoiceTransferRef[],
  frozenBalances: FrozenInvoiceBalances | null,
  walletAddresses: Set<string>,
): InvoiceStatus {
  // ---------------------------------------------------------------------------
  // Terminal path: reconstruct from frozen balances
  // ---------------------------------------------------------------------------
  if (frozenBalances !== null) {
    return reconstructFromFrozen(invoiceId, frozenBalances);
  }

  // ---------------------------------------------------------------------------
  // Non-terminal path: compute dynamically from entries
  // ---------------------------------------------------------------------------

  // Build a lookup map: targetAddress -> index in terms.targets
  const targetIndexMap = new Map<string, number>();
  for (let i = 0; i < terms.targets.length; i++) {
    targetIndexMap.set(terms.targets[i]!.address, i);
  }

  // Build a lookup set: target address -> Set<coinId> (from invoice terms)
  const targetCoinIds = new Map<string, Set<string>>();
  for (const target of terms.targets) {
    const coinSet = new Set<string>();
    for (const asset of target.assets) {
      if (asset.coin) coinSet.add(asset.coin[0]);
    }
    targetCoinIds.set(target.address, coinSet);
  }

  // Target accumulators: key = targetAddress
  const targetAccumulators = new Map<string, TargetAccumulator>();
  for (const target of terms.targets) {
    targetAccumulators.set(target.address, { coins: new Map() });
  }

  const irrelevantTransfers: IrrelevantTransfer[] = [];

  // Totals across all targets
  const totalForwardMap = new Map<string, bigint>();
  const totalBackMap = new Map<string, bigint>();

  let lastActivityAt = 0;
  let allConfirmed = true; // will be set to false on first unconfirmed

  // ---------------------------------------------------------------------------
  // Process each entry
  // ---------------------------------------------------------------------------
  for (const entry of entries) {
    // Track last activity timestamp
    if (entry.timestamp > lastActivityAt) {
      lastActivityAt = entry.timestamp;
    }
    // Track allConfirmed (dynamically derived from entries)
    if (!entry.confirmed) {
      allConfirmed = false;
    }

    const amount = parseBigInt(entry.amount);
    const isReturn = isReturnDirection(entry.paymentDirection);

    // -------------------------------------------------------------------
    // Self-payment detection
    // Per spec §5.2: if sender == destination == wallet address → irrelevant
    // DIRECT:// comparisons are case-sensitive exact string matches.
    // -------------------------------------------------------------------
    if (
      entry.senderAddress !== null &&
      entry.senderAddress === entry.destinationAddress &&
      walletAddresses.has(entry.destinationAddress)
    ) {
      irrelevantTransfers.push({ ...entry, reason: 'self_payment' });
      continue;
    }

    // -------------------------------------------------------------------
    // Route the entry to its target
    //
    // For FORWARD payments: match target where destinationAddress == target.address
    // For RETURN payments (B, RC, RX): match target where senderAddress == target.address
    //   (returns flow FROM target TO payer)
    // -------------------------------------------------------------------
    let matchedTargetAddress: string | null = null;

    if (!isReturn) {
      // Forward: destination is the target
      if (targetIndexMap.has(entry.destinationAddress)) {
        matchedTargetAddress = entry.destinationAddress;
      }
    } else {
      // Return: sender is the target (return flows from target)
      if (entry.senderAddress !== null && targetIndexMap.has(entry.senderAddress)) {
        matchedTargetAddress = entry.senderAddress;
      }
    }

    // -------------------------------------------------------------------
    // Determine asset match (by coinId within the matched target)
    // -------------------------------------------------------------------
    const hasTargetMatch = matchedTargetAddress !== null;
    const targetCoins = matchedTargetAddress !== null
      ? targetCoinIds.get(matchedTargetAddress)
      : undefined;
    const hasCoinMatch = targetCoins !== undefined && targetCoins.has(entry.coinId);

    if (!hasTargetMatch && !hasCoinMatch) {
      // Neither address nor coin matches any target
      irrelevantTransfers.push({ ...entry, reason: 'unknown_address_and_asset' });
      continue;
    }

    if (!hasTargetMatch) {
      // Address doesn't match any target (coinId might match a different target but address is wrong)
      irrelevantTransfers.push({ ...entry, reason: 'unknown_address' });
      continue;
    }

    if (!hasCoinMatch) {
      // Target address matches but coinId not in that target's requested assets
      irrelevantTransfers.push({ ...entry, reason: 'unknown_asset' });
      continue;
    }

    // -------------------------------------------------------------------
    // Both target and coin match — accumulate into balance
    // -------------------------------------------------------------------
    const targetAcc = targetAccumulators.get(matchedTargetAddress!)!;

    let coinAcc = targetAcc.coins.get(entry.coinId);
    if (!coinAcc) {
      coinAcc = {
        coveredAmount: 0n,
        returnedAmount: 0n,
        transfers: [],
        senders: new Map(),
      };
      targetAcc.coins.set(entry.coinId, coinAcc);
    }

    // Add to transfers list
    coinAcc.transfers.push(entry);

    if (!isReturn) {
      // Forward payment
      coinAcc.coveredAmount += amount;

      // Update totals
      totalForwardMap.set(
        entry.coinId,
        (totalForwardMap.get(entry.coinId) ?? 0n) + amount,
      );

      // Per-sender tracking for forward payments
      // effectiveSender = refundAddress ?? senderAddress
      const effectiveSender = entry.refundAddress ?? entry.senderAddress;
      if (effectiveSender !== null && effectiveSender !== undefined) {
        const senderAcc = getOrCreateSenderAcc(coinAcc, effectiveSender, entry);
        senderAcc.forwarded += amount;
        mergeContact(senderAcc, entry.contact);
      }
      // If effectiveSender == null (both refundAddress and senderAddress are null/undefined),
      // the entry is excluded from per-sender tracking per spec §5.2, but counted in aggregate.
    } else {
      // Return payment (back, return_closed, return_cancelled)
      coinAcc.returnedAmount += amount;

      // Update totals
      totalBackMap.set(
        entry.coinId,
        (totalBackMap.get(entry.coinId) ?? 0n) + amount,
      );

      // Per-sender tracking for return payments
      // For returns: senderAddress is the target (matched above); destinationAddress is the payer
      // senderReturned for (effectiveSender = destinationAddress) where sender == target.address
      //
      // Per spec §5.2 senderReturned formula:
      //   ref.senderAddress == target.address  (already verified above for return entries)
      //   ref.destinationAddress == effectiveSender  (return goes TO original sender or refund addr)
      const returnRecipient = entry.destinationAddress;
      if (returnRecipient !== null && returnRecipient !== undefined) {
        // Find existing sender accumulator keyed by returnRecipient
        // (the return recipient is the original effectiveSender)
        const senderAcc = coinAcc.senders.get(returnRecipient);
        if (senderAcc) {
          senderAcc.returned += amount;
          // Do NOT merge contact on returns — contact is only on forward payments
        }
        // If no senderAcc exists for this returnRecipient, no per-sender tracking
        // (this can happen with out-of-band returns that bypass returnInvoicePayment())
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Build InvoiceTargetStatus array
  // ---------------------------------------------------------------------------
  const targets: InvoiceTargetStatus[] = [];
  for (let i = 0; i < terms.targets.length; i++) {
    const termTarget = terms.targets[i]!;
    const targetAcc = targetAccumulators.get(termTarget.address);
    if (!targetAcc) {
      // Should never happen since we pre-populated targetAccumulators,
      // but defensively produce a zero-value status
      targets.push(buildTargetStatus(termTarget.address, { coins: new Map() }, terms, i));
    } else {
      targets.push(buildTargetStatus(termTarget.address, targetAcc, terms, i));
    }
  }

  // ---------------------------------------------------------------------------
  // Determine invoice state (§5.1 step 7)
  // Priority: CLOSED > CANCELLED > COVERED > EXPIRED > PARTIAL > OPEN
  // (CLOSED/CANCELLED already handled above via frozenBalances path)
  // ---------------------------------------------------------------------------
  const allTargetsCovered = targets.length > 0 && targets.every((t) => t.isCovered);
  const anyPayment = targets.some((t) =>
    t.coinAssets.some((ca) => parseBigInt(ca.netCoveredAmount) > 0n),
  );

  let state: InvoiceState;

  if (allTargetsCovered) {
    // All targets covered — COVERED
    // (implicit close to CLOSED is the caller's responsibility with the gate)
    state = 'COVERED';
  } else if (terms.dueDate !== undefined && terms.dueDate < Date.now()) {
    // Past due date AND not fully covered — EXPIRED
    state = 'EXPIRED';
  } else if (anyPayment) {
    state = 'PARTIAL';
  } else {
    state = 'OPEN';
  }

  // ---------------------------------------------------------------------------
  // Build totalForward / totalBack Records
  // ---------------------------------------------------------------------------
  const totalForward: Record<string, string> = {};
  for (const [coinId, amount] of totalForwardMap) {
    totalForward[coinId] = amount.toString();
  }

  const totalBack: Record<string, string> = {};
  for (const [coinId, amount] of totalBackMap) {
    totalBack[coinId] = amount.toString();
  }

  // allConfirmed is false if there are no entries (nothing to confirm), or
  // any entry is unconfirmed. An empty invoice is not "all confirmed".
  if (entries.length === 0) {
    allConfirmed = false;
  }

  return {
    invoiceId,
    state,
    targets,
    irrelevantTransfers,
    totalForward,
    totalBack,
    allConfirmed,
    lastActivityAt,
  };
}

// =============================================================================
// Frozen balance reconstruction
// =============================================================================

/**
 * Reconstruct InvoiceStatus from a FrozenInvoiceBalances snapshot.
 *
 * Per spec: allConfirmed is NOT stored in FrozenInvoiceBalances — it is always
 * derived dynamically. This function sets it to `true` as a placeholder;
 * the caller (AccountingModule) must update it by checking token confirmation
 * status via PaymentsModule.
 *
 * @see docs/ACCOUNTING-SPEC.md §7.3
 */
function reconstructFromFrozen(
  invoiceId: string,
  frozen: FrozenInvoiceBalances,
): InvoiceStatus {
  const targets: InvoiceTargetStatus[] = frozen.targets.map((ft) =>
    reconstructTargetFromFrozen(ft),
  );

  return {
    invoiceId,
    state: frozen.state,
    targets,
    irrelevantTransfers: frozen.irrelevantTransfers.slice(),
    totalForward: { ...frozen.totalForward },
    totalBack: { ...frozen.totalBack },
    // allConfirmed is always dynamically derived — placeholder true here;
    // caller must replace by querying PaymentsModule token confirmation status.
    allConfirmed: true,
    lastActivityAt: frozen.lastActivityAt,
    ...(frozen.explicitClose !== undefined ? { explicitClose: frozen.explicitClose } : {}),
  };
}

/**
 * Reconstruct InvoiceTargetStatus from a FrozenTargetBalances entry.
 */
function reconstructTargetFromFrozen(ft: FrozenTargetBalances): InvoiceTargetStatus {
  const coinAssets: InvoiceCoinAssetStatus[] = ft.coinAssets.map((fca) =>
    reconstructCoinAssetFromFrozen(fca),
  );

  // NFT placeholders are already stored in frozen (always false/false in v1)
  const nftAssets: InvoiceNFTAssetStatus[] = ft.nftAssets.map((nft) => ({ ...nft }));

  return {
    address: ft.address,
    coinAssets,
    nftAssets,
    isCovered: ft.isCovered,
    confirmed: ft.confirmed,
  };
}

/**
 * Reconstruct InvoiceCoinAssetStatus from a FrozenCoinAssetBalances entry.
 * Converts FrozenSenderBalance entries to InvoiceSenderBalance.
 */
function reconstructCoinAssetFromFrozen(fca: FrozenCoinAssetBalances): InvoiceCoinAssetStatus {
  const senderBalances: InvoiceSenderBalance[] = fca.frozenSenderBalances.map((fsb) =>
    reconstructSenderBalanceFromFrozen(fsb),
  );

  return {
    coin: fca.coin,
    coveredAmount: fca.coveredAmount,
    returnedAmount: fca.returnedAmount,
    netCoveredAmount: fca.netCoveredAmount,
    isCovered: fca.isCovered,
    surplusAmount: fca.surplusAmount,
    confirmed: fca.confirmed,
    transfers: fca.transfers.slice(),
    senderBalances,
  };
}

/**
 * Reconstruct InvoiceSenderBalance from a FrozenSenderBalance entry.
 * The `netBalance` from the frozen entry is the returnable baseline at freeze time.
 *
 * Post-termination forward/return tracking is layered on top of the frozen baseline
 * by the AccountingModule — this function only reconstructs the frozen snapshot.
 * forwardedAmount and returnedAmount are NOT stored in FrozenSenderBalance (only
 * netBalance is stored), so they are reconstructed as netBalance/0 respectively.
 */
function reconstructSenderBalanceFromFrozen(fsb: FrozenSenderBalance): InvoiceSenderBalance {
  // The frozen snapshot only stores netBalance (the returnable amount at freeze time).
  // We represent this as forwardedAmount == netBalance, returnedAmount == '0',
  // which is the minimal reconstruction preserving the return cap semantics.
  return {
    senderAddress: fsb.senderAddress,
    contacts: fsb.contacts.slice(),
    forwardedAmount: fsb.netBalance,
    returnedAmount: '0',
    netBalance: fsb.netBalance,
    ...(fsb.isRefundAddress === true ? { isRefundAddress: true as const } : {}),
    ...(fsb.senderPubkey !== undefined ? { senderPubkey: fsb.senderPubkey } : {}),
  };
}

// =============================================================================
// computeBalanceSnapshot
// =============================================================================

/**
 * Compute a lightweight balance snapshot for caching.
 *
 * Returns aggregate and per-sender BigInt maps suitable for coverage
 * computation and return-cap enforcement without constructing the full
 * InvoiceStatus object hierarchy.
 *
 * The returned snapshot conforms to `InvoiceBalanceSnapshot` from types.ts
 * (only `aggregate` and `perSender` maps). The caller may use the additional
 * properties (`allCovered`, `anyPayment`, `lastActivityAt`) via the extended
 * return type for internal use; they are not stored on `InvoiceBalanceSnapshot`.
 *
 * Self-payment detection uses the same rules as computeInvoiceStatus.
 *
 * Pure function — no side effects.
 *
 * @param terms           - Parsed invoice terms
 * @param entries         - All InvoiceTransferRef entries for this invoice
 * @param walletAddresses - All wallet DIRECT:// addresses (for self-payment detection)
 *
 * @see docs/ACCOUNTING-SPEC.md §5.4.2
 */
export function computeBalanceSnapshot(
  terms: InvoiceTerms,
  entries: InvoiceTransferRef[],
  walletAddresses: Set<string>,
): InvoiceBalanceSnapshot & { allCovered: boolean; anyPayment: boolean; lastActivityAt: number } {
  const aggregate = new Map<string, { covered: bigint; returned: bigint }>();
  const perSender = new Map<string, { forwarded: bigint; returned: bigint }>();

  // Build target lookup structures
  const targetAddressSet = new Set<string>(terms.targets.map((t) => t.address));
  const targetCoinIds = new Map<string, Set<string>>();
  for (const target of terms.targets) {
    const coinSet = new Set<string>();
    for (const asset of target.assets) {
      if (asset.coin) coinSet.add(asset.coin[0]);
    }
    targetCoinIds.set(target.address, coinSet);
  }

  for (const entry of entries) {
    // Self-payment exclusion
    if (
      entry.senderAddress !== null &&
      entry.senderAddress === entry.destinationAddress &&
      walletAddresses.has(entry.destinationAddress)
    ) {
      continue;
    }

    const amount = parseBigInt(entry.amount);
    const isReturn = isReturnDirection(entry.paymentDirection);

    let matchedTargetAddress: string | null = null;
    if (!isReturn) {
      if (targetAddressSet.has(entry.destinationAddress)) {
        matchedTargetAddress = entry.destinationAddress;
      }
    } else {
      if (entry.senderAddress !== null && targetAddressSet.has(entry.senderAddress)) {
        matchedTargetAddress = entry.senderAddress;
      }
    }

    if (matchedTargetAddress === null) continue;

    const targetCoins = targetCoinIds.get(matchedTargetAddress);
    if (!targetCoins || !targetCoins.has(entry.coinId)) continue;

    const aggKey = `${matchedTargetAddress}::${entry.coinId}`;
    let aggEntry = aggregate.get(aggKey);
    if (!aggEntry) {
      aggEntry = { covered: 0n, returned: 0n };
      aggregate.set(aggKey, aggEntry);
    }

    if (!isReturn) {
      aggEntry.covered += amount;

      const effectiveSender = entry.refundAddress ?? entry.senderAddress;
      if (effectiveSender !== null && effectiveSender !== undefined) {
        const senderKey = `${matchedTargetAddress}::${effectiveSender}::${entry.coinId}`;
        let senderEntry = perSender.get(senderKey);
        if (!senderEntry) {
          senderEntry = { forwarded: 0n, returned: 0n };
          perSender.set(senderKey, senderEntry);
        }
        senderEntry.forwarded += amount;
      }
    } else {
      aggEntry.returned += amount;

      const returnRecipient = entry.destinationAddress;
      const senderKey = `${matchedTargetAddress}::${returnRecipient}::${entry.coinId}`;
      const senderEntry = perSender.get(senderKey);
      if (senderEntry) {
        senderEntry.returned += amount;
      }
    }
  }

  // Determine allCovered and anyPayment
  let allCovered = terms.targets.length > 0;
  let anyPayment = false;

  for (const target of terms.targets) {
    for (const asset of target.assets) {
      if (!asset.coin) continue;
      const [coinId, requestedAmount] = asset.coin;
      const aggKey = `${target.address}::${coinId}`;
      const aggEntry = aggregate.get(aggKey);
      const covered = aggEntry ? (aggEntry.covered > aggEntry.returned ? aggEntry.covered - aggEntry.returned : 0n) : 0n;
      const requested = parseBigInt(requestedAmount);

      if (covered > 0n) anyPayment = true;
      if (covered < requested) allCovered = false;
    }
  }

  // lastActivityAt
  let lastActivityAt = 0;
  for (const entry of entries) {
    if (entry.timestamp > lastActivityAt) {
      lastActivityAt = entry.timestamp;
    }
  }

  return {
    aggregate,
    perSender,
    allCovered,
    anyPayment,
    lastActivityAt,
  };
}

// =============================================================================
// freezeBalances
// =============================================================================

/**
 * Create a FrozenInvoiceBalances snapshot for persistence at invoice termination.
 *
 * For CLOSED:
 * - Per-sender balances are RESET to zero (pre-closure payments accepted as final).
 * - If `latestSenderMap` is provided, the latest sender for each target:coinId
 *   receives the surplus amount as their frozen net balance.
 *
 * For CANCELLED:
 * - Per-sender balances are PRESERVED as-is (everything is returnable).
 *
 * Pure function — no side effects.
 *
 * @param terms             - Parsed invoice terms
 * @param status            - Current computed InvoiceStatus to freeze
 * @param state             - Terminal state to record ('CLOSED' or 'CANCELLED')
 * @param explicit          - Whether this is an explicit (true) or implicit (false) close
 * @param latestSenderMap   - Optional: target address -> coinId -> senderAddress
 *                            Used for CLOSED to assign surplus to the latest sender.
 *                            Ignored for CANCELLED.
 *
 * @see docs/ACCOUNTING-SPEC.md §7.3, §5.2
 */
export function freezeBalances(
  terms: InvoiceTerms,
  status: InvoiceStatus,
  state: 'CLOSED' | 'CANCELLED',
  explicit: boolean,
  latestSenderMap?: Map<string, Map<string, string>>,
): FrozenInvoiceBalances {
  const frozenTargets: FrozenTargetBalances[] = status.targets.map((targetStatus) =>
    freezeTarget(targetStatus, state, latestSenderMap?.get(targetStatus.address)),
  );

  return {
    state,
    ...(state === 'CLOSED' ? { explicitClose: explicit } : {}),
    frozenAt: Date.now(),
    targets: frozenTargets,
    irrelevantTransfers: status.irrelevantTransfers.slice(),
    totalForward: { ...status.totalForward },
    totalBack: { ...status.totalBack },
    lastActivityAt: status.lastActivityAt,
    // NOTE: allConfirmed is NOT stored per spec §7.3 comment in FrozenInvoiceBalances
  };
}

/**
 * Freeze a single InvoiceTargetStatus.
 *
 * @param targetStatus  - Computed status for this target
 * @param state         - Terminal state ('CLOSED' or 'CANCELLED')
 * @param coinSenderMap - coinId -> senderAddress for latest-sender tracking (CLOSED only)
 */
function freezeTarget(
  targetStatus: InvoiceTargetStatus,
  state: 'CLOSED' | 'CANCELLED',
  coinSenderMap?: Map<string, string>,
): FrozenTargetBalances {
  const frozenCoinAssets: FrozenCoinAssetBalances[] = targetStatus.coinAssets.map((ca) =>
    freezeCoinAsset(ca, state, coinSenderMap?.get(ca.coin[0])),
  );

  return {
    address: targetStatus.address,
    coinAssets: frozenCoinAssets,
    nftAssets: targetStatus.nftAssets.map((nft) => ({ ...nft })),
    isCovered: targetStatus.isCovered,
    confirmed: targetStatus.confirmed,
  };
}

/**
 * Freeze a single InvoiceCoinAssetStatus.
 *
 * For CLOSED: all per-sender balances are reset to zero.
 * Surplus is distributed to senders in reverse chronological order (latest
 * sender first), capped at each sender's actual net contribution. This
 * prevents the exploit where a 1-unit last payment captures the entire surplus.
 *
 * For CANCELLED: per-sender balances are preserved exactly as computed.
 *
 * @param coinAsset     - Computed coin asset status
 * @param state         - Terminal state
 * @param latestSender  - Optional latest sender address for surplus assignment (CLOSED only)
 */
function freezeCoinAsset(
  coinAsset: InvoiceCoinAssetStatus,
  state: 'CLOSED' | 'CANCELLED',
  latestSender?: string,
): FrozenCoinAssetBalances {
  let frozenSenderBalances: FrozenSenderBalance[];

  if (state === 'CANCELLED') {
    // CANCELLED: preserve all per-sender balances as-is
    frozenSenderBalances = coinAsset.senderBalances.map((sb) => ({
      senderAddress: sb.senderAddress,
      ...(sb.isRefundAddress === true ? { isRefundAddress: true as const } : {}),
      ...(sb.senderPubkey !== undefined ? { senderPubkey: sb.senderPubkey } : {}),
      contacts: sb.contacts.slice(),
      netBalance: sb.netBalance,
    }));
  } else {
    // CLOSED: reset all per-sender balances to zero, then distribute surplus.
    //
    // Surplus distribution algorithm:
    // 1. Latest sender gets min(surplus, their_net_contribution)
    // 2. Remaining surplus distributed to other senders in iteration order,
    //    each capped at their net contribution.
    // This ensures no sender receives more surplus than they actually paid.
    const totalSurplus = parseBigInt(coinAsset.surplusAmount);
    let remainingSurplus = totalSurplus;

    // Build a map of sender -> their returnable surplus (capped at net contribution)
    const senderSurplusMap = new Map<string, bigint>();

    // First pass: allocate to latest sender (priority)
    if (latestSender !== undefined && remainingSurplus > 0n) {
      const latestSb = coinAsset.senderBalances.find(
        (sb) => sb.senderAddress === latestSender,
      );
      if (latestSb) {
        const latestNet = parseBigInt(latestSb.netBalance);
        const allocated = latestNet < remainingSurplus ? latestNet : remainingSurplus;
        if (allocated > 0n) {
          senderSurplusMap.set(latestSender, allocated);
          remainingSurplus -= allocated;
        }
      }
    }

    // Second pass: distribute remaining surplus to other senders (reverse order)
    // Reverse iteration gives priority to more recent senders
    if (remainingSurplus > 0n) {
      for (let i = coinAsset.senderBalances.length - 1; i >= 0; i--) {
        const sb = coinAsset.senderBalances[i]!;
        if (sb.senderAddress === latestSender) continue; // already allocated
        if (remainingSurplus <= 0n) break;

        const senderNet = parseBigInt(sb.netBalance);
        const allocated = senderNet < remainingSurplus ? senderNet : remainingSurplus;
        if (allocated > 0n) {
          senderSurplusMap.set(
            sb.senderAddress,
            (senderSurplusMap.get(sb.senderAddress) ?? 0n) + allocated,
          );
          remainingSurplus -= allocated;
        }
      }
    }

    // Assign any undistributed remainder to latest sender (or first sender as fallback)
    // This ensures sum(frozenNetBalances) == totalSurplus for CLOSED invoices.
    if (remainingSurplus > 0n && coinAsset.senderBalances.length > 0) {
      const fallbackSender = latestSender ?? coinAsset.senderBalances[0]!.senderAddress;
      senderSurplusMap.set(
        fallbackSender,
        (senderSurplusMap.get(fallbackSender) ?? 0n) + remainingSurplus,
      );
    }

    frozenSenderBalances = coinAsset.senderBalances.map((sb) => {
      const allocatedSurplus = senderSurplusMap.get(sb.senderAddress) ?? 0n;
      const isLatest =
        latestSender !== undefined && sb.senderAddress === latestSender;
      return {
        senderAddress: sb.senderAddress,
        ...(sb.isRefundAddress === true ? { isRefundAddress: true as const } : {}),
        ...(sb.senderPubkey !== undefined ? { senderPubkey: sb.senderPubkey } : {}),
        contacts: sb.contacts.slice(),
        // Frozen netBalance = their allocated share of surplus (capped at their contribution)
        netBalance: allocatedSurplus.toString(),
        ...(isLatest && latestSender !== undefined ? { latestSenderAddress: latestSender } : {}),
      };
    });
  }

  return {
    coin: coinAsset.coin,
    coveredAmount: coinAsset.coveredAmount,
    returnedAmount: coinAsset.returnedAmount,
    netCoveredAmount: coinAsset.netCoveredAmount,
    isCovered: coinAsset.isCovered,
    surplusAmount: coinAsset.surplusAmount,
    confirmed: coinAsset.confirmed,
    transfers: coinAsset.transfers.slice(),
    frozenSenderBalances,
    ...(state === 'CLOSED' && latestSender !== undefined
      ? { latestSenderAddress: latestSender }
      : {}),
  };
}
