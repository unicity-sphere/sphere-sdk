# Accounting Module Specification Addendum: NFT Asset Support

> **Status:** Draft specification -- no code yet
> **Parent document:** [ACCOUNTING-SPEC.md](./ACCOUNTING-SPEC.md)
> **Dependencies:** [NFT-SPEC.md](./NFT-SPEC.md), [NFT-ARCHITECTURE.md](./NFT-ARCHITECTURE.md)

This addendum specifies the runtime behavior for NFT asset lines in invoices. It replaces all "v1 placeholder" / "stub" language in the parent spec with concrete algorithms. Section numbering uses the `N` prefix to avoid collision with the parent spec.

---

## Table of Contents

- [N1. Overview and Design Principles](#n1-overview-and-design-principles)
- [N2. NFT Payment Flow (payInvoice for NFTs)](#n2-nft-payment-flow-payinvoice-for-nfts)
- [N3. NFT Transfer Attribution](#n3-nft-transfer-attribution)
- [N4. Coverage Computation Updates](#n4-coverage-computation-updates)
- [N5. Auto-Return for NFTs](#n5-auto-return-for-nfts)
- [N6. Transfer Classification Updates](#n6-transfer-classification-updates)
- [N7. Frozen NFT Balances](#n7-frozen-nft-balances)
- [N8. Events](#n8-events)
- [N9. Error Codes](#n9-error-codes)
- [N10. Test Cases](#n10-test-cases)

---

## N1. Overview and Design Principles

NFTs are non-fungible tokens identified by a unique `tokenId` (64-char hex). Within the accounting module, an invoice target may request specific NFTs alongside or instead of fungible coin assets. The fundamental difference between coin and NFT invoice assets:

| Property | Coin Asset | NFT Asset |
|----------|-----------|-----------|
| Identity | `coinId` (symbol) | `tokenId` (unique 64-char hex) |
| Matching | Any tokens with matching `coinId`, amounts are summed | Exact token ID match required |
| Quantity | Arbitrary amount (BigInt arithmetic) | Binary: received or not |
| Splitting | Tokens can be split to match exact amounts | Atomic -- cannot be split |
| Return | Fungible amount returned via `PaymentsModule.send()` | Exact token returned via `_nftTransfer` + `_tokenIds` |
| On-chain format | `genesis.data.coinData = [["UCT", "1000000"]]` | `genesis.data.tokenType = NFT_TOKEN_TYPE_HEX`, `genesis.data.coinData = []` |

**Key invariant:** An NFT asset line is either fully satisfied (the exact `tokenId` was received) or not satisfied at all. There is no partial coverage for NFTs.

**Relationship to NFTModule:** The accounting module does NOT depend on `NFTModule` directly. It uses `PaymentsModule.send()` with `_nftTransfer` and `_tokenIds` flags for outbound NFT transfers (payments and returns), and inspects `genesis.data.tokenType` and token metadata from `PaymentsModule.getTokens()` for inbound attribution. NFTModule is an optional higher-level module; accounting NFT support works with or without it.

---

## N2. NFT Payment Flow (`payInvoice()` for NFTs)

### N2.1 Asset Selection

When `payInvoice(invoiceId, params)` is called, the `params.assetIndex` identifies the asset line within the target. If the asset at that index has `nft` set (and `coin` is undefined), the payment follows the NFT path.

### N2.2 Algorithm

```
function payInvoiceNFT(invoiceId, terms, params, deps):
  1. Resolve asset:
     asset = terms.targets[params.targetIndex].assets[params.assetIndex]
     assert asset.nft !== undefined
     requestedTokenId = asset.nft.tokenId
     requestedTokenType = asset.nft.tokenType  // may be undefined

  2. Validate params:
     - params.amount MUST be undefined or "1" (NFTs are atomic, amount is always 1).
       If amount is set to anything other than "1" → throw INVOICE_INVALID_AMOUNT
       ("NFT payments do not accept a custom amount")
     - params.freeText, params.refundAddress, params.contact: same validation as coin path

  3. Acquire per-invoice gate (withInvoiceGate):

  4. Terminal state check (inside gate):
     - if invoiceId in closedSet or cancelledSet → throw INVOICE_TERMINATED

  5. Already-sent check (inside gate):
     - Scan invoiceLedger entries for this invoiceId:
       for each entry where:
         entry.direction === 'outbound' AND
         entry.paymentDirection === 'forward' AND
         entry.coinId === requestedTokenId
       → throw INVOICE_NFT_ALREADY_SENT

  6. Locate the NFT in local wallet:
     allTokens = deps.payments.getTokens()
     nftToken = allTokens.find(t =>
       t.id === requestedTokenId &&
       t.genesis?.data?.tokenType === NFT_TOKEN_TYPE_HEX
     )
     if (!nftToken) → throw INVOICE_NFT_NOT_FOUND

  7. Optional tokenType check:
     if requestedTokenType is defined:
       actualTokenType = nftToken.genesis?.data?.tokenType
       if actualTokenType !== requestedTokenType → throw INVOICE_NFT_MISMATCH

  8. Build memo (same format as coin path):
     memo = buildInvoiceMemo(invoiceId, 'F', params.freeText)
     // Result: "INV:<invoiceId>:F [freeText]"
     // NOTE: buildInvoiceMemo() accepts wire codes ('F', 'B', 'RC', 'RX'),
     // not semantic names ('forward', 'back', etc.).

  9. Build on-chain TransferMessagePayload (same as coin path):
     payload = {
       inv: {
         id: invoiceId,
         dir: 'F',
         ra: params.refundAddress,       // optional
         ct: effectiveContact,           // auto-populated from identity if not provided
       },
       txt: params.freeText,
     }

  10. Send via PaymentsModule:
      result = await deps.payments.send({
        recipient: terms.targets[params.targetIndex].address,
        amount: '1',
        coinId: requestedTokenId,        // fallback identifier
        memo: memo,
        _nftTransfer: true,              // skip token splitting
        _tokenIds: [requestedTokenId],   // select exact token
        _message: payload,               // on-chain structured payload
      })

  11. Return result (TransferResult from PaymentsModule)
```

> **Implementation note — `coinId` semantics:** The `coinId` field in the send request is a fallback label only. Token selection is performed exclusively by `_tokenIds`. The PaymentsModule MUST use `_tokenIds` for token lookup when present, ignoring `coinId` for selection purposes. See NFT-SPEC Prerequisites item 2.

> **Implementation note — `payInvoice()` guard:** The existing `payInvoice()` at `AccountingModule.ts:2329-2334` hard-throws `INVOICE_INVALID_ASSET_INDEX` when `asset.coin` is undefined. This guard must be refactored to a conditional branch: `if (asset.coin) { ... coin path ... } else if (asset.nft) { ... NFT path (this algorithm) ... } else { throw INVOICE_INVALID_ASSET }`.

> **Security note — UI confirmation:** Wallet implementations MUST display the NFT metadata (name, collection, image) to the user before executing `payInvoice()` for NFT assets. The `tokenId` is an opaque 64-char hex string — the user cannot identify the NFT without metadata resolution via `NFTModule.getNFT(tokenId)` or equivalent. The `payInvoice()` API itself does not enforce UI confirmation — this is the caller's responsibility.

> **Dependency note:** The `_nftTransfer` and `_tokenIds` flags on `PaymentsModule.send()` are defined in NFT-SPEC.md Prerequisites and must be implemented before this addendum can be implemented.

### N2.3 Memo Format

The memo format is identical to coin payments: `INV:<invoiceId>:F [freeText]`. No NFT-specific memo prefix is needed. The invoice reference links the transfer to the invoice; the token's identity (`tokenId`) is carried by the token itself, not the memo.

### N2.4 On-Chain Payload

The `TransferMessagePayload.inv` object is identical to the coin payment path (same `id`, `dir`, `ra`, `ct` fields). No additional NFT-specific fields are added to the on-chain payload. The NFT identity is inherent in the token being transferred.

---

## N3. NFT Transfer Attribution

### N3.1 Matching Algorithm

When the accounting module processes an inbound or outbound transfer (via `_processTransferEntry()`), it must determine whether the transferred token satisfies an NFT asset line in any known invoice.

```
function attributeNFTTransfer(token, transferRef, invoiceTerms):
  1. Determine if the token is an NFT:
     isNFT = token.genesis?.data?.tokenType === NFT_TOKEN_TYPE_HEX
             AND (token.genesis?.data?.coinData is empty or undefined)
     if (!isNFT) → use existing coin attribution path

  2. Extract the token's unique ID (prefer genesis-derived ID):
     nftTokenId = token.genesis?.data?.tokenId ?? token.id
     // Matches the existing getTokenId() pattern in txf-serializer.ts.
     // The genesis-derived ID is canonical; token.id is a storage key fallback.

  3. For the referenced invoice (from memo INV:<invoiceId>:F):
     For each target in invoiceTerms.targets:
       For each asset in target.assets where asset.nft is defined:
         if asset.nft.tokenId === nftTokenId:
           // MATCH FOUND
           → attribute this transfer to (target, asset)
           → classification: 'invoice:nft_payment'
           → set received = true for this NFT asset status
           → return

  4. If no NFT asset line matches:
     // The token carries an invoice memo but its tokenId doesn't match
     // any NFT target. This is analogous to receiving a coin with an
     // unrecognized coinId.
     → classify as invoice:irrelevant with reason 'nft_mismatch'
     → emit 'invoice:irrelevant' event
```

### N3.2 Double-Check: Memo + Token ID

For NFT payments, attribution uses a two-factor match:

1. **Memo reference** (`INV:<invoiceId>:F`) -- links the transfer to a specific invoice
2. **Token ID match** (`token.id === asset.nft.tokenId`) -- confirms the correct NFT was sent

Both must be satisfied. A transfer with the correct memo but wrong `tokenId` is classified as irrelevant. A transfer with the correct `tokenId` but no invoice memo is not attributed to any invoice (standard behavior -- only memo-referenced transfers count).

### N3.3 NFT Mismatch Handling

When an NFT token is received with an invoice memo (`INV:<id>:F`) but its `tokenId` does not match any NFT target in that invoice:

- The transfer is classified as `invoice:irrelevant` with reason `'nft_mismatch'`
- The `invoice:irrelevant` event fires with the full `InvoiceTransferRef`
- The NFT token is still received and stored in the wallet (the accounting module never rejects tokens)
- Auto-return does NOT automatically return mismatched NFTs (they are irrelevant, not overpayments)
- The invoice creator may manually return the mismatched NFT via `returnInvoicePayment()` with NFT-specific parameters

### N3.4 Cross-Target Duplicate Prevention

The existing validation rules (parent spec section 8) prevent the same `tokenId` from appearing in multiple targets within a single invoice:

```
// From AccountingModule.createInvoice() validation:
if (seenNftIds.has(tokenId)) {
  throw new SphereError('Duplicate NFT tokenId in target', 'INVOICE_DUPLICATE_NFT');
}
```

This is enforced per-target. Cross-target duplicate prevention is also enforced: `seenNftIds` is scoped to the entire invoice, not per-target. A given `tokenId` can appear in at most one asset line across all targets of an invoice.

**Rationale:** An NFT is a unique object. Requesting the same NFT in two different targets is nonsensical -- the payer cannot send the same token to two addresses. This is validated at creation time and at import time, so the attribution algorithm can safely assume a 1:1 mapping from `tokenId` to `(target, asset)`.

### N3.5 InvoiceTransferRef for NFTs

When an NFT transfer is attributed to an invoice, the `InvoiceTransferRef` is populated as follows:

| Field | NFT Value | Notes |
|-------|-----------|-------|
| `transferId` | Standard transfer ID | Same as coin path |
| `direction` | `'inbound'` or `'outbound'` | Same as coin path |
| `paymentDirection` | `'forward'` / `'back'` / etc. | From memo direction code |
| `coinId` | `nftTokenId` | The NFT's unique token ID is used as the `coinId` field |
| `amount` | `'1'` | Always 1 for NFTs (atomic) |
| `destinationAddress` | Target address | Same as coin path |
| `timestamp` | Transfer timestamp | Same as coin path |
| `confirmed` | Token confirmation status | Same as coin path |
| `senderAddress` | Sender DIRECT:// address | Same as coin path |
| `refundAddress` | From `inv.ra` | Same as coin path |
| `contact` | From `inv.ct` | Same as coin path |

**Key design decision:** The `coinId` field carries the NFT `tokenId` for NFT transfers. This reuses the existing `InvoiceTransferRef` structure without adding NFT-specific fields. The `amount` is always `'1'`. The per-invoice ledger entry key remains `${transferId}::${coinId}` (which becomes `${transferId}::${nftTokenId}`).

---

## N4. Coverage Computation Updates

### N4.1 Updated `isCovered` Logic

The parent spec's section 5.1 step 6 currently reads:

```
isCovered = coinAssets.length > 0 && coinAssets.every(ca => ca.isCovered)
```

This is replaced with:

```
function computeTargetCoverage(coinAssets, nftAssets):
  hasCoinAssets = coinAssets.length > 0
  hasNftAssets = nftAssets.length > 0

  // A target with no assets at all is not covered (nothing requested)
  if (!hasCoinAssets && !hasNftAssets):
    return false

  // All present coin assets must be covered
  coinsCovered = !hasCoinAssets || coinAssets.every(ca => ca.isCovered)

  // All present NFT assets must be received
  nftsCovered = !hasNftAssets || nftAssets.every(na => na.received)

  return coinsCovered && nftsCovered
```

**Changes from v1 stub:**

1. A target with only NFT assets (no coin assets) can now be covered. Previously, `coinAssets.length > 0` blocked this.
2. NFT coverage is included in the `isCovered` check. Previously, NFTs were excluded.
3. Targets with mixed coin + NFT assets require both to be covered.

### N4.2 `InvoiceNFTAssetStatus` State Transitions

```
received:  false → true   when a matching NFT token is attributed to this invoice target
                           (forward payment with token.id === asset.nft.tokenId)

confirmed: false → true   when the NFT transfer's inclusion proof is verified
                           (token.confirmed === true in PaymentsModule)
```

**Reverse transitions (returns):**

```
received:  true → false   when the NFT is returned (back/return_closed/return_cancelled payment
                           with matching tokenId). The NFT is no longer considered received.

confirmed: true → false   not applicable — once confirmed, a return creates a new transfer entry;
                           the original confirmation is not reverted. The NFT asset status tracks
                           the NET state: if received=false (returned), confirmed is set to false.
```

### N4.3 NFT "Net Received" Computation

Unlike coins which track amounts via BigInt arithmetic, NFT coverage is binary. However, returns can reverse a received NFT. The net state is computed as:

```
function computeNFTAssetStatus(nftEntry, ledgerEntries):
  forwardCount = count entries where:
    entry.coinId === nftEntry.tokenId AND
    entry.paymentDirection === 'forward'

  returnCount = count entries where:
    entry.coinId === nftEntry.tokenId AND
    entry.paymentDirection in ('back', 'return_closed', 'return_cancelled')

  netReceived = forwardCount > returnCount
  // In practice, forwardCount is 0 or 1 and returnCount is 0 or 1.
  // Multiple forwards of the same tokenId are impossible (the sender
  // no longer holds the token after the first transfer). Multiple
  // returns are also impossible (the target no longer holds it after
  // the first return). The > comparison handles edge cases defensively.

  // Confirmed: check the most recent forward transfer (if net received)
  confirmed = false
  if netReceived:
    latestForward = most recent forward entry for this tokenId
    confirmed = latestForward.confirmed

  return {
    nft: nftEntry,
    received: netReceived,
    confirmed: confirmed,
  }
```

### N4.4 Impact on Invoice State Machine

The state machine transitions (parent spec section 5.1 step 7) are unchanged in structure. The updated `isCovered` computation (N4.1) naturally flows into the existing state determination:

- **OPEN:** No coin or NFT assets have any coverage
- **PARTIAL:** At least one coin asset has `netCoveredAmount > 0` OR at least one NFT asset has `received === true`, but not all targets are covered
- **COVERED:** All targets have `isCovered === true` (both coins and NFTs)
- **CLOSED:** All targets covered AND all confirmed (implicit), or explicit `closeInvoice()`
- **CANCELLED:** Explicit `cancelInvoice()`
- **EXPIRED:** Due date passed and not all targets covered

**PARTIAL state update:** The condition for PARTIAL (parent spec section 5.1 step 7f) must also check NFT assets:

```
// Updated step 7f (replaces coin-only anyPayment check at balance-computer.ts:546-548):
const anyPayment = targets.some(t =>
  t.coinAssets.some(ca => parseBigInt(ca.netCoveredAmount) > 0n) ||
  t.nftAssets.some(na => na.received)
);
if (anyPayment && !allCovered) → PARTIAL
```

> **Backward compatibility note:** For coin-only invoices (no NFT assets), the updated `isCovered` formula produces identical results to the v1 formula. The `nftAssets.every(...)` term evaluates to `true` for an empty array, so the NFT condition is a no-op when no NFT assets exist.

### N4.5 `totalForward` and `totalBack` for NFTs

The `InvoiceStatus.totalForward` and `totalBack` maps are keyed by `coinId`. For NFT transfers, the key is the NFT's `tokenId` and the value is `'1'` (or `'0'` if returned). These entries appear alongside coin entries in the same maps.

```
// Example totalForward for a mixed invoice:
{
  "UCT": "1000000",           // 1M UCT forwarded
  "a1b2c3d4...": "1",         // NFT with tokenId a1b2c3d4... forwarded
}
```

---

## N5. Auto-Return for NFTs

### N5.1 CANCELLED Invoices

When an invoice is CANCELLED and auto-return is enabled for that invoice, the module processes NFT assets as follows:

```
function autoReturnNFTs(invoiceId, terms, nftAssetStatuses, deps):
  for each target in terms.targets:
    // Only targets owned by this wallet can auto-return
    if target.address not in walletAddresses → skip

    for each nftAsset in target's nftAssetStatuses:
      if !nftAsset.received → skip  // nothing to return

      tokenId = nftAsset.nft.tokenId

      // Dedup check
      dedupKey = `${invoiceId}:nft:${tokenId}`
      if ledger.entries[dedupKey] exists AND status !== 'failed' → skip

      // Resolve return destination:
      // senderAddress is the on-chain identity of the payer — always trusted.
      // refundAddress comes from the payer's on-chain TransferMessagePayload and
      // SHOULD be validated against known addresses when possible.
      // Priority: senderAddress → refundAddress → fail
      // NOTE: refundAddress is payer-controlled. For coin returns, sending to
      // an attacker-controlled refundAddress wastes fungible tokens (inconvenient
      // but recoverable). For NFTs, sending a unique asset to the wrong address
      // is IRREVERSIBLE. Therefore, NFT auto-return PREFERS senderAddress over
      // refundAddress, inverting the coin priority order.
      senderEntry = find the forward transfer entry for this tokenId
      recipient = senderEntry.senderAddress ?? senderEntry.refundAddress
      if (!recipient) → record failed entry, emit invoice:auto_return_failed, continue

      // Write intent to dedup ledger BEFORE sending
      ledger.entries[dedupKey] = {
        intentAt: Date.now(),
        status: 'pending',
        recipient: recipient,
        amount: '1',
        coinId: tokenId,
        memo: buildInvoiceMemo(invoiceId, 'RX'),
      }
      await persistLedger()

      // Send the NFT back
      try:
        result = await deps.payments.send({
          recipient: recipient,
          amount: '1',
          coinId: tokenId,
          memo: buildInvoiceMemo(invoiceId, 'RX'),
          _nftTransfer: true,
          _tokenIds: [tokenId],
          _message: {
            inv: { id: invoiceId, dir: 'RX' },
          },
        })
        ledger.entries[dedupKey].status = 'completed'
        ledger.entries[dedupKey].returnTransferId = result.id
        ledger.entries[dedupKey].completedAt = Date.now()
        await persistLedger()
        emit 'invoice:nft_returned' { invoiceId, tokenId, recipient, transferResult: result }
      catch (error):
        ledger.entries[dedupKey].status = 'failed'
        ledger.entries[dedupKey].retryCount = 1
        await persistLedger()
        emit 'invoice:auto_return_failed' { invoiceId, transferId: tokenId, reason: error.message }
```

### N5.2 CLOSED Invoices

When an invoice is CLOSED (explicit or implicit), received NFTs are **retained**. Auto-return does NOT fire for NFT assets on CLOSED invoices. This is consistent with the coin behavior: for CLOSED invoices, pre-closure payments are accepted as final.

**Exception -- surplus returns on CLOSED:** For coin assets, surplus amounts are returned to the latest sender on close. NFTs have no concept of surplus (you either received the requested NFT or you did not). If the correct NFT was received, there is no surplus. If a mismatched NFT was received, it is classified as irrelevant (not as a surplus) and is not auto-returned.

### N5.3 Dedup Ledger Key Format

| Asset Type | Dedup Key Format | Example |
|------------|-----------------|---------|
| Coin (existing) | `${invoiceId}:${originalTransferId}` | `a1b2...c3d4:e5f6...7890` |
| NFT (new) | `${invoiceId}:nft:${tokenId}` | `a1b2...c3d4:nft:f1e2...d3c4` |

The `nft:` infix distinguishes NFT dedup entries from coin entries. This is necessary because:

1. Coin returns are keyed by `originalTransferId` (one entry per incoming payment transfer). Multiple coin transfers for the same `coinId` produce separate dedup entries.
2. NFT returns are keyed by `tokenId` because each NFT can only be received once. Using `tokenId` provides natural deduplication -- even if crash recovery replays the cancellation logic, the same `tokenId` produces the same key.

### N5.4 Crash Recovery

On `load()`, the auto-return crash recovery (parent spec section 7.6 step 5) processes NFT dedup entries identically to coin entries:

- **`pending` entries:** Retry the send using the persisted `recipient`, `amount` (`'1'`), `coinId` (tokenId), and `memo`. Use `_nftTransfer: true` and `_tokenIds: [coinId]` flags.
- **`completed` entries:** No action needed.
- **`failed` entries:** Retry if `retryCount < maxRetries`.

The existing `AutoReturnLedgerEntry` type is sufficient -- no new fields are needed. The `coinId` field carries the NFT `tokenId`, and `amount` is always `'1'`.

---

## N6. Transfer Classification Updates

### N6.1 Current Behavior (Stub)

Currently, tokens with `tokenType === NFT_TOKEN_TYPE_HEX` and empty `coinData` are classified as `invoice:irrelevant` with reason `'no_coin_data'`. This is because the coin-only processing path finds no coin entries to process.

### N6.2 Updated Classification

> **CRITICAL insertion point:** The NFT type check below MUST be inserted BEFORE the existing `coinData.length === 0` guard in `_processTransferEntry()` (currently at `AccountingModule.ts:4296-4303`). When an NFT token is detected (`tokenType === NFT_TOKEN_TYPE_HEX`), the function branches to the NFT attribution path and does NOT fall through to the coinData extraction. If implemented in the wrong order, NFT transfers will silently be classified as `'no_coin_data'` and never attributed.

The transfer classification logic in `_processTransferEntry()` is updated:

```
function classifyTransferToken(token, invoiceMemoRef):
  // 1. Check if this is an NFT token
  isNFT = token.genesis?.data?.tokenType === NFT_TOKEN_TYPE_HEX
          AND (token.genesis?.data?.coinData?.length === 0
               OR token.genesis?.data?.coinData === undefined
               OR token.genesis?.data?.coinData === null)

  if (!isNFT):
    // Existing coin classification path (unchanged)
    if token.genesis?.data?.coinData is empty → 'no_coin_data' (irrelevant)
    else → process each coin entry per existing algorithm
    return

  // 2. NFT-specific classification
  nftTokenId = token.genesis?.data?.tokenId ?? token.id  // genesis-derived ID is canonical
  invoiceId = invoiceMemoRef.invoiceId

  // 3. Look up invoice terms
  terms = getInvoiceTerms(invoiceId)
  if (!terms) → 'invoice:unknown_reference' (existing path)

  // 4. Search for matching NFT asset line across all targets
  for (let ti = 0; ti < terms.targets.length; ti++):
    target = terms.targets[ti]
    for (let ai = 0; ai < target.assets.length; ai++):
      asset = target.assets[ai]
      if asset.nft && asset.nft.tokenId === nftTokenId:
        // MATCH — classify as NFT payment
        return {
          classification: 'invoice:nft_payment',
          invoiceId: invoiceId,
          targetIndex: ti,
          assetIndex: ai,
        }

  // 5. No match — NFT received with invoice memo but tokenId doesn't match
  return {
    classification: 'invoice:irrelevant',
    reason: 'nft_mismatch',
  }
```

### N6.3 Classification Categories

| Classification | Meaning | When |
|---------------|---------|------|
| `invoice:nft_payment` (NEW) | NFT token matches an NFT asset line in the invoice | `token.id === asset.nft.tokenId` for some target/asset |
| `invoice:irrelevant` with reason `'nft_mismatch'` (NEW) | NFT token has invoice memo but doesn't match any NFT target | Token is NFT type, has `INV:` memo, but `tokenId` not in any target |
| `invoice:irrelevant` with reason `'no_coin_data'` (UPDATED) | Non-NFT token with empty coinData | Token is NOT NFT type but has empty coinData (malformed token) |

**Key change:** The `'no_coin_data'` reason is now only applied to non-NFT tokens. NFT tokens (identified by `tokenType === NFT_TOKEN_TYPE_HEX`) follow the NFT classification path regardless of their `coinData` contents.

### N6.4 IrrelevantTransfer Reason Update

The `IrrelevantTransfer.reason` union type is extended:

```typescript
readonly reason:
  | 'unknown_address'
  | 'unknown_asset'
  | 'unknown_address_and_asset'
  | 'self_payment'
  | 'no_coin_data'
  | 'unauthorized_return'
  | 'nft_mismatch';            // NEW
```

---

## N7. Frozen NFT Balances

### N7.1 Freezing on Termination

When an invoice transitions to CLOSED or CANCELLED, the `FrozenTargetBalances.nftAssets` array is populated with the actual computed `InvoiceNFTAssetStatus` for each NFT asset line:

```
function freezeNFTAssets(target, computedNftAssets):
  return computedNftAssets.map(nftStatus => ({
    nft: nftStatus.nft,
    received: nftStatus.received,    // actual state at freeze time
    confirmed: nftStatus.confirmed,  // actual state at freeze time
  }))
```

### N7.2 Reconstruction from Frozen State

After freezing, `computeInvoiceStatus()` returns the frozen NFT asset statuses directly from `FrozenTargetBalances.nftAssets`. No live recomputation occurs.

```
function reconstructNFTFromFrozen(frozenTarget):
  return frozenTarget.nftAssets.map(frozen => ({
    nft: frozen.nft,
    received: frozen.received,
    confirmed: frozen.confirmed,
  }))
```

**Exception -- `allConfirmed` remains dynamic:** As with coin assets, the `InvoiceStatus.allConfirmed` field is computed dynamically from `PaymentsModule` even for terminal invoices. For NFT assets in terminal invoices, the `confirmed` field in the frozen snapshot is used as the baseline; if the NFT transfer was unconfirmed at freeze time but confirmed later, `allConfirmed` will reflect the updated state.

### N7.3 Post-Termination NFT Tracking

After an invoice is terminated:

- **CANCELLED:** Post-cancellation NFT forward payments are tracked in the ledger. If auto-return is enabled, they are returned immediately (using the dedup ledger). If not, they remain in the wallet and the `nftAssets[].received` in the frozen snapshot is NOT updated (frozen state is immutable).
- **CLOSED:** Post-closure NFT forward payments are tracked in the ledger. No auto-return fires (CLOSED invoices retain payments). The frozen snapshot is NOT updated.

In both cases, post-termination NFT transfers appear in the `InvoiceTransferRef` list and affect the per-sender balance tracking (using `coinId = tokenId`, `amount = '1'`), but the frozen `nftAssets` status is not modified.

---

## N8. Events

### N8.1 New Events

```typescript
// New SphereEventType additions:
| 'invoice:nft_received'
| 'invoice:nft_returned'

// New SphereEventMap entries:

'invoice:nft_received': {
  /** Invoice token ID */
  invoiceId: string;
  /** The NFT token ID that was received */
  tokenId: string;
  /** Target address where the NFT was received */
  address: string;
  /** Index of the target in invoice terms */
  targetIndex: number;
  /** Index of the asset within the target */
  assetIndex: number;
  /** Whether the NFT transfer is confirmed (inclusion proof verified) */
  confirmed: boolean;
  /** Sender's chain pubkey (if known) */
  senderPubkey?: string;
  /** Sender's nametag (if known) */
  senderNametag?: string;
};

'invoice:nft_returned': {
  /** Invoice token ID */
  invoiceId: string;
  /** The NFT token ID that was returned */
  tokenId: string;
  /** Recipient of the return (original sender's refundAddress or senderAddress) */
  recipient: string;
  /** Transfer result from PaymentsModule.send() */
  transferResult: TransferResult;
};
```

### N8.2 Event Emission Rules

| Event | Fires when | Notes |
|-------|-----------|-------|
| `invoice:nft_received` | An inbound NFT transfer is attributed to an NFT asset line in an invoice | Fires regardless of invoice state (including terminated). For terminated invoices, auto-return may fire immediately after. |
| `invoice:nft_returned` | An NFT is successfully auto-returned after invoice cancellation | Only fires for auto-returns. Manual returns via `returnInvoicePayment()` fire the existing `invoice:payment` event with `paymentDirection: 'return_cancelled'` or `'back'`. |

### N8.3 Interaction with Existing Events

NFT transfers also trigger existing events:

- `invoice:payment` -- fires for every NFT transfer attributed to an invoice (same as coins). The `InvoiceTransferRef` has `coinId = tokenId`, `amount = '1'`.
- `invoice:target_covered` -- fires when a target becomes covered due to an NFT receipt (if the NFT was the last missing asset).
- `invoice:covered` -- fires when all targets become covered.
- `invoice:irrelevant` -- fires for NFT transfers with `reason: 'nft_mismatch'`.
- `invoice:auto_return_failed` -- fires when NFT auto-return fails.

**Event ordering for NFT receipt:**
1. `invoice:payment` (generic payment event)
2. `invoice:nft_received` (NFT-specific event)
3. `invoice:target_covered` (if applicable)
4. `invoice:covered` (if applicable)

---

## N9. Error Codes

All errors use `SphereError`. New codes to add to the `SphereErrorCode` union type in `core/errors.ts`:

| Code | Message | When |
|------|---------|------|
| `INVOICE_NFT_NOT_FOUND` | Requested NFT token not found in wallet: {tokenId} | `payInvoice()` for an NFT asset, but the payer's wallet does not contain a token with the requested `tokenId` and `tokenType === NFT_TOKEN_TYPE_HEX` |
| `INVOICE_NFT_ALREADY_SENT` | NFT already sent for this invoice target: {tokenId} | `payInvoice()` for an NFT asset, but a forward transfer for this `tokenId` already exists in the invoice ledger (outbound direction) |
| `INVOICE_NFT_MISMATCH` | Received NFT tokenId does not match any invoice target | Inbound NFT transfer with invoice memo, but `token.id` does not match any `NFTEntry.tokenId` in the referenced invoice. Used as classification reason, not thrown as an exception (inbound processing never throws). |

**Existing codes that apply to NFT paths:**

| Code | NFT-Specific Context |
|------|---------------------|
| `INVOICE_TERMINATED` | `payInvoice()` for NFT on a closed/cancelled invoice |
| `INVOICE_INVALID_TARGET` | Invalid `targetIndex` in `payInvoice()` for NFT |
| `INVOICE_INVALID_ASSET_INDEX` | Invalid `assetIndex` pointing to NFT asset |
| `INVOICE_INVALID_AMOUNT` | `amount` is set to something other than `'1'` or `undefined` for an NFT payment |

---

## N10. Test Cases

### N10.1 NFT Payment Flow (`payInvoice()`)

| ID | Description | Preconditions | Expected Behavior |
|----|-------------|--------------|-------------------|
| NFT-PAY-01 | Pay invoice with NFT -- happy path | Invoice has one target with one NFT asset `{ tokenId: T1 }`. Payer holds token T1 with `tokenType === NFT_TOKEN_TYPE_HEX`. | `payInvoice()` succeeds. `PaymentsModule.send()` called with `_nftTransfer: true`, `_tokenIds: [T1]`, `amount: '1'`. Memo is `INV:<id>:F`. TransferResult returned. |
| NFT-PAY-02 | Pay invoice -- NFT not in wallet | Invoice requests NFT T1. Payer does not hold token T1. | `payInvoice()` throws `INVOICE_NFT_NOT_FOUND`. |
| NFT-PAY-03 | Pay invoice -- NFT already sent | Invoice requests NFT T1. Ledger already has an outbound forward entry for T1 on this invoice. | `payInvoice()` throws `INVOICE_NFT_ALREADY_SENT`. |
| NFT-PAY-04 | Pay invoice -- terminated invoice | Invoice is CANCELLED. Payer holds NFT T1. | `payInvoice()` throws `INVOICE_TERMINATED`. |
| NFT-PAY-05 | Pay invoice -- custom amount rejected | Invoice requests NFT T1. Payer calls `payInvoice(id, { targetIndex: 0, assetIndex: 0, amount: '5' })`. | `payInvoice()` throws `INVOICE_INVALID_AMOUNT` ("NFT payments do not accept a custom amount"). |

### N10.2 NFT Transfer Attribution

| ID | Description | Preconditions | Expected Behavior |
|----|-------------|--------------|-------------------|
| NFT-ATTR-01 | Inbound NFT matches invoice target | Invoice has target at address A requesting NFT T1. Inbound transfer of token T1 to address A with memo `INV:<id>:F`. | Transfer attributed to the invoice. `InvoiceNFTAssetStatus.received = true`. `invoice:nft_received` event fires. |
| NFT-ATTR-02 | Inbound NFT -- tokenId mismatch | Invoice requests NFT T1. Inbound transfer of NFT T2 (different tokenId) with memo `INV:<id>:F`. | Transfer classified as `invoice:irrelevant` with reason `'nft_mismatch'`. `InvoiceNFTAssetStatus.received` stays `false`. |
| NFT-ATTR-03 | Inbound NFT -- no invoice memo | Invoice requests NFT T1. Inbound transfer of token T1 with no `INV:` memo. | Transfer is not attributed to any invoice. Standard token receipt -- no invoice events fire. |
| NFT-ATTR-04 | NFT confirmed after receipt | NFT T1 received with `confirmed = false`. Later, inclusion proof arrives. | `InvoiceNFTAssetStatus.confirmed` transitions to `true`. `invoice:payment` event fires with `confirmed: true`. |
| NFT-ATTR-05 | Same tokenId cannot appear in two targets | `createInvoice()` with two targets both requesting NFT T1. | `createInvoice()` throws `INVOICE_DUPLICATE_NFT` during validation. |

### N10.3 Coverage Computation

| ID | Description | Preconditions | Expected Behavior |
|----|-------------|--------------|-------------------|
| NFT-COV-01 | Target with only NFT assets -- covered | Target has one NFT asset. NFT received (`received = true`). No coin assets. | `InvoiceTargetStatus.isCovered = true`. |
| NFT-COV-02 | Mixed target -- coin covered, NFT not | Target has one coin asset (covered) and one NFT asset (`received = false`). | `InvoiceTargetStatus.isCovered = false`. |
| NFT-COV-03 | Mixed target -- both covered | Target has one coin asset (covered) and one NFT asset (`received = true`). | `InvoiceTargetStatus.isCovered = true`. |
| NFT-COV-04 | Invoice state transitions to PARTIAL on NFT receipt | Invoice has two NFT assets. First NFT received. | `InvoiceState = 'PARTIAL'`. |
| NFT-COV-05 | Invoice state transitions to COVERED when all NFTs received | Invoice has two NFT assets. Both received, both confirmed. | Invoice transitions through COVERED to CLOSED (implicit close). |

### N10.4 Auto-Return for NFTs

| ID | Description | Preconditions | Expected Behavior |
|----|-------------|--------------|-------------------|
| NFT-RET-01 | Auto-return NFT on cancellation | Invoice with NFT T1. T1 received. Auto-return enabled. Invoice cancelled. | NFT T1 returned to sender. `payments.send()` called with `_nftTransfer: true`, `_tokenIds: [T1]`, memo `INV:<id>:RX`. `invoice:nft_returned` event fires. |
| NFT-RET-02 | No auto-return on close | Invoice with NFT T1. T1 received. Auto-return enabled. Invoice closed. | NFT T1 is retained. No return transfer. No `invoice:nft_returned` event. |
| NFT-RET-03 | Dedup prevents double return | Invoice cancelled. Auto-return runs. Crashes after dedup intent written. Restart and crash recovery. | Dedup ledger has `pending` entry for `${invoiceId}:nft:${T1}`. Recovery retries the send. On success, entry transitions to `completed`. No duplicate send. |
| NFT-RET-04 | Auto-return with refund address | Invoice cancelled. NFT T1 was sent with `refundAddress = R1`. Auto-return enabled. | Return sent to R1 (not sender's DIRECT address). |
| NFT-RET-05 | Auto-return fails -- NFT not in wallet | Invoice cancelled. NFT T1 was received, then manually sent elsewhere before cancellation. Auto-return enabled. | `payments.send()` throws (token not found). Dedup entry set to `failed`. `invoice:auto_return_failed` event fires. |

### N10.5 Transfer Classification

| ID | Description | Preconditions | Expected Behavior |
|----|-------------|--------------|-------------------|
| NFT-CLS-01 | NFT token classified as nft_payment | Token with `tokenType = NFT_TOKEN_TYPE_HEX`, `coinData = []`, `token.id = T1`. Invoice requests T1. Memo `INV:<id>:F`. | Classification: `invoice:nft_payment` with correct `invoiceId`, `targetIndex`, `assetIndex`. |
| NFT-CLS-02 | NFT token classified as nft_mismatch | Token with `tokenType = NFT_TOKEN_TYPE_HEX`, `token.id = T2`. Invoice has no target requesting T2. Memo `INV:<id>:F`. | Classification: `invoice:irrelevant` with reason `'nft_mismatch'`. |
| NFT-CLS-03 | Non-NFT token with empty coinData | Token with `tokenType = SOME_OTHER_TYPE`, `coinData = []`. Memo `INV:<id>:F`. | Classification: `invoice:irrelevant` with reason `'no_coin_data'` (existing behavior, unchanged). |
| NFT-CLS-04 | NFT token without invoice memo | Token with `tokenType = NFT_TOKEN_TYPE_HEX`, `coinData = []`. No `INV:` memo. | No invoice classification. Token stored normally. |

### N10.6 Frozen NFT Balances

| ID | Description | Preconditions | Expected Behavior |
|----|-------------|--------------|-------------------|
| NFT-FRZ-01 | NFT status frozen on close | Invoice with NFT T1. T1 received and confirmed. Invoice closed (explicit). | `FrozenTargetBalances.nftAssets[0] = { nft: { tokenId: T1 }, received: true, confirmed: true }`. |
| NFT-FRZ-02 | NFT status frozen on cancel | Invoice with NFT T1. T1 received but not confirmed. Invoice cancelled. | `FrozenTargetBalances.nftAssets[0] = { nft: { tokenId: T1 }, received: true, confirmed: false }`. |
| NFT-FRZ-03 | Unreceived NFT frozen state | Invoice with NFT T1. T1 never received. Invoice cancelled. | `FrozenTargetBalances.nftAssets[0] = { nft: { tokenId: T1 }, received: false, confirmed: false }`. |
| NFT-FRZ-04 | Post-termination NFT does not update frozen snapshot | Invoice closed. Later, NFT T1 arrives with `INV:<id>:F` memo. | Frozen `nftAssets` unchanged. Transfer appears in ledger entries. `invoice:payment` event fires. |

### N10.7 Events

| ID | Description | Preconditions | Expected Behavior |
|----|-------------|--------------|-------------------|
| NFT-EVT-01 | nft_received event on attribution | Inbound NFT T1 attributed to invoice. | `invoice:nft_received` fires with `{ invoiceId, tokenId: T1, address, targetIndex, assetIndex, confirmed }`. |
| NFT-EVT-02 | nft_returned event on auto-return | Invoice cancelled. NFT T1 auto-returned. | `invoice:nft_returned` fires with `{ invoiceId, tokenId: T1, recipient, transferResult }`. |
| NFT-EVT-03 | Event ordering on NFT receipt that covers target | NFT T1 is the only asset in the target. T1 received. | Events fire in order: `invoice:payment`, `invoice:nft_received`, `invoice:target_covered`, `invoice:covered`. |
| NFT-EVT-04 | nft_received fires even for terminated invoices | Invoice closed. NFT T1 arrives with `INV:<id>:F`. | `invoice:nft_received` fires. `invoice:payment` fires. No coverage events (already terminal). |

---

## Appendix: Summary of Changes to Parent Spec

This section lists the specific locations in ACCOUNTING-SPEC.md that require modification when this addendum is implemented.

| Parent Spec Location | Change Required |
|----------------------|-----------------|
| Section 1.3 -- `InvoiceNFTAssetStatus` | Remove "placeholder" / "always false in v1" language. Reference this addendum. |
| Section 1.3 -- `InvoiceTargetStatus.isCovered` | Update comment to reference N4.1 algorithm (includes NFT coverage). |
| Section 1.3 -- `IrrelevantTransfer.reason` | Add `'nft_mismatch'` to the union type. |
| Section 2.1 -- `payInvoice()` | Remove "throws on NFT assets" note. Reference N2 for NFT payment path. |
| Section 5.1 step 6 | Replace `coinAssets.length > 0 && coinAssets.every(...)` with N4.1 algorithm. |
| Section 5.1 step 7f | Add NFT received check to PARTIAL state condition. |
| Section 5.3 -- empty coinData handling | Update to distinguish NFT tokens (`NFT_TOKEN_TYPE_HEX`) from malformed tokens. Reference N6.2. |
| Section 6.1 -- event list | Add `invoice:nft_received` and `invoice:nft_returned`. |
| Section 7.3 -- `FrozenTargetBalances.nftAssets` | Remove "placeholder" note. Document actual freeze semantics per N7. |
| Section 10 -- error codes | Add `INVOICE_NFT_NOT_FOUND`, `INVOICE_NFT_ALREADY_SENT`, `INVOICE_NFT_MISMATCH` to `SphereErrorCode` union in `core/errors.ts`. |
| `types/index.ts` -- `SphereEventType` | Add `'invoice:nft_received'` and `'invoice:nft_returned'` to the union. Add event payload types to `SphereEventMap`. |
| `types/index.ts` -- `TransferRequest` | Add optional `_nftTransfer?: boolean` and `_tokenIds?: string[]` fields (NFT-SPEC prerequisite). |

---

## Security Considerations

### S1. NFT Auto-Return Address Priority

NFT auto-return uses **senderAddress first, refundAddress second** — the inverse of the coin priority. This is because `refundAddress` is payer-controlled (set in `TransferMessagePayload.inv.ra`) and a malicious payer could set it to an arbitrary address. For fungible coin returns, this is inconvenient but recoverable. For unique NFTs, sending to an attacker-controlled address is **irreversible**. See N5.1 for details.

### S2. Connect Protocol Flag Stripping

The `_nftTransfer` and `_tokenIds` flags are internal PaymentsModule flags that MUST NOT be accepted from external sources. The `ConnectHost` implementation MUST strip these fields from Connect Protocol intent parameters if present. A malicious dApp could otherwise set `_nftTransfer: true` and `_tokenIds: [victimNftId]` to exfiltrate an NFT the user did not intend to send.

### S3. Front-Running Risk

An attacker who knows the `invoiceId` and requested `tokenId` could front-run the legitimate payer by sending the NFT first (with the correct `INV:` memo). The legitimate payer's subsequent payment would then fail with `INVOICE_NFT_ALREADY_COVERED`. Mitigations:
- Invoice IDs are token-derived (SHA-256) and are shared only with intended parties
- NFT tokenIds are unique, so the attacker must own the exact requested token
- The combination of needing both the invoiceId AND the specific NFT makes front-running impractical in most scenarios

### S4. Aggregator Verification for NFT Attribution

NFT attribution MUST verify the token against the aggregator (inclusion proof) before marking `confirmed = true`. The `received = true, confirmed = false` state should be treated as **unverified** by high-value consumers. A token with a forged `tokenType = NFT_TOKEN_TYPE_HEX` could appear as an NFT, but without a valid inclusion proof from the aggregator, `confirmed` stays `false`. Full verification requires the predicate, state hash, and SMT path checks from the aggregator's trust base.

### S5. No coinId/tokenId Collision

Fungible coinIds are validated as alphanumeric-only, max 20 chars (`/^[A-Za-z0-9]+$/`). NFT tokenIds are 64-char hex strings. The namespaces are disjoint by format, preventing collision in `InvoiceTransferRef.coinId`, `totalForward`, and `totalBack` maps.
